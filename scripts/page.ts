// The Chrome every harness drives, and webdroid opened in it: one way to open the page, boot an APK, decide that its app is up and read
// what each realm reports (tests/e2e/lib/processes.ts holds the halves that run in the page).
import { chromium, type Page } from "playwright";
import { deadline } from "./util.ts";
import { ERROR_LINE, appUp, pageDiagnostics, workerDiagnostics, workerRows, type ProcessSnapshot } from "../tests/e2e/lib/processes.ts";

export const BASE_URL = process.env.WEBDROID_URL ?? "http://localhost:4080";
/** webdroid's page at `base` with `params` in its query */
export function webdroidUrl(params: Record<string, string> = {}, base = BASE_URL): URL {
  const url = new URL(base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}

// WEBDROID_SITE_ISOLATION=0 keeps Playwright's default, which shares a WebView page's renderer with
// the app as Safari and Chrome on Android do
const ISOLATED = process.env.WEBDROID_SITE_ISOLATION !== "0";
/** what every harness's Chrome runs with, `jsFlags` added to WEBDROID_JS_FLAGS */
function chromeArgs(jsFlags?: string): string[] {
  const js = [process.env.WEBDROID_JS_FLAGS, jsFlags].filter(Boolean).join(" ");
  return [...(ISOLATED ? ["--site-per-process"] : []), "--force-device-scale-factor=1", "--hide-scrollbars", ...(js ? [`--js-flags=${js}`] : [])];
}
export const CONTEXT_OPTS = {
  viewport: { width: 1400, height: 1500 },
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
  geolocation: { latitude: 37.422, longitude: -122.084, accuracy: 20 },
  permissions: ["geolocation"],
};
/** Chrome's GL on the host's GPU (ANGLE's Metal backend), or on the CPU (SwiftShader behind ANGLE), which renders as fast as the host has cores */
export const HOST_GL = ["--enable-gpu", "--use-angle=metal"], SOFTWARE_GL = ["--use-gl=angle", "--use-angle=swiftshader"];
/** the GPU on macOS unless WEBDROID_GL=swiftshader asks for the CPU, as every other host gets */
const GL = process.platform === "darwin" && process.env.WEBDROID_GL !== "swiftshader" ? HOST_GL : SOFTWARE_GL;
/** headless Chrome as the harnesses run it, its GL `gl` */
export const launchOptions = (jsFlags?: string, gl = GL) => ({
  headless: true,
  args: [...chromeArgs(jsFlags), "--font-render-hinting=none", "--disable-lcd-text",
    ...gl, "--disable-partial-raster", "--disable-skia-runtime-opts"],
  ignoreDefaultArgs: ISOLATED ? ["--disable-features=IsolateOrigins,site-per-process"] : [],
});
export const launchBrowser = (jsFlags?: string) => chromium.launch(launchOptions(jsFlags));

/** the page's uncaught errors and console errors from now on, each with where it came from relative to the page's origin; `offline`,
 *  resources off that origin that fail to load are not errors */
export function pageErrors(page: Page, { offline = false } = {}): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const { url } = message.location(), origin = new URL(page.url()).origin, own = url.startsWith(origin);
    if (offline && !own && message.text().startsWith("Failed to load resource")) return;
    errors.push(`${own ? url.slice(origin.length) : url}: ${message.text()}`);
  });
  return errors;
}

/** opens webdroid at `url` in `page`, once its `wd` and fonts are there */
export async function openWebdroid(page: Page, url: URL = webdroidUrl()): Promise<void> {
  const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (!response?.ok()) throw new Error(`dev server not reachable at ${url.origin} — run \`pnpm dev\``);
  await page.waitForFunction(() => !!globalThis.wd, null, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
}

export type UpOptions = { until?: "drawn" | "presented"; ms?: number };
/** waits until the app's process has drawn its first frame (or presented one); throws when it exits first or `ms` pass */
export async function waitForApp(page: Page, { until = "drawn", ms = 60_000 }: UpOptions = {}): Promise<void> {
  const up = await page.evaluate(appUp, { until, ms, pollMs: 100 });
  if (up !== true) throw new Error(up);
}
/** boots `apk` in the opened page and waits until its app is up */
export async function bootApp(page: Page, apk: string, options?: UpOptions): Promise<void> {
  await page.evaluate((file) => { void globalThis.wd.boot(file); }, apk);
  await waitForApp(page, options);
}

/** `read`, or a failure when it throws or takes over 6 s */
function bounded<T>(read: Promise<T>): Promise<T | { status: "failure"; message: string }> {
  const failure = (message: string) => ({ status: "failure" as const, message });
  return deadline(read.catch((error) => failure(String(error))), 6000).catch(() => failure("diagnostic timeout"));
}
/** Diagnostics from the page's realm and every process Worker. */
export async function readProcesses(page: Page): Promise<ProcessSnapshot[]> {
  const origin = new URL(page.url()).origin, frame = page.mainFrame();
  const root = (async () => {
    const read = () => frame.evaluate(pageDiagnostics, ERROR_LINE.source);
    const diagnostics = await bounded((async () => {
      let result = await read();
      if (result.status === "unavailable") {
        await frame.waitForFunction(() => !!globalThis.wd, null, { timeout: 2_000 });
        result = await read();
      }
      return result;
    })());
    return { url: frame.url(), diagnostics };
  })();
  const workers = bounded(page.evaluate(workerRows, 0)).then(result => Array.isArray(result)
    ? result.map(worker => ({ url: `worker:${worker.url ?? origin + "/process-worker.js"}#pid=${worker.pid}`, diagnostics: workerDiagnostics(worker) }))
    : [{ url: "worker:" + origin, diagnostics: result }]);
  const [page_, rows] = await Promise.all([root, workers]);
  return [page_, ...rows];
}
