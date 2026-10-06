// webdroid driver — Playwright over the dev server. Every action, settle and capture happens in
// one page.evaluate against the probe in lib/probe.ts; nothing here polls the page.
// Deliberately free of any Android/adb dependency: `bun run e2e` must run with no SDK present.
import { chromium, type Browser, type Page } from "playwright";
import { PINNED_CLOCK_MS, deviceScreen, screenParam, type CaptureScreen, type WaitPolicy } from "../types";
import { BASE_URL, webdroidUrl } from "../lib/util";
import { DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_QUIESCENCE, probeScript, type Act, type Quiescence, type StepResult, type StepSpec } from "../lib/probe";

/** `WEBDROID_SCREEN=1080x2424@480` overrides the geometry every flow runs at — which un-scores
 *  the run, because the goldens are pixels at one size. That is the point: it measures cost. */
export const ENV_SCREEN = process.env.WEBDROID_SCREEN;

/** Compose the query rather than concatenating it: `?bytecode=x` + `?screen=y` silently drops
 *  the second parameter, and the run then measures the wrong geometry against the right pixels. */
function pageUrl(screen: CaptureScreen, controlled: boolean): string {
  const u = webdroidUrl();
  u.searchParams.set("screen", screenParam(screen));
  u.searchParams.set("statusBarDp", String(screen.statusBarDp));
  if (controlled) u.searchParams.set("testClock", "controlled");
  return u.href;
}

// WEBDROID_SITE_ISOLATION=0 keeps Playwright's default, which shares a WebView page's renderer with
// the app as Safari and Chrome on Android do
const ISOLATED = process.env.WEBDROID_SITE_ISOLATION !== "0";
const LAUNCH_ARGS = [
  ...(ISOLATED ? ["--site-per-process"] : []),
  "--font-render-hinting=none", "--disable-lcd-text",
  "--force-device-scale-factor=1", "--hide-scrollbars",
  ...(process.env.WEBDROID_JS_FLAGS ? [`--js-flags=${process.env.WEBDROID_JS_FLAGS}`] : []),
];
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
export const launchBrowser = (gpu: "software" | "hardware" = "software") => chromium.launch({
  headless: true,
  channel: gpu === "hardware" ? "chromium" : undefined,
  args: [...LAUNCH_ARGS, ...(gpu === "software" ? ["--use-gl=angle", "--use-angle=swiftshader", "--disable-partial-raster", "--disable-skia-runtime-opts"] : [])],
  ignoreDefaultArgs: [...(ISOLATED ? ["--disable-features=IsolateOrigins,site-per-process"] : []), ...(gpu === "hardware" ? ["--enable-unsafe-swiftshader"] : [])],
});

type LaunchOpts = {
  screen?: CaptureScreen;
  /** Date is pinned here (default PINNED_CLOCK_MS); null keeps the wall clock. Timers, rAF and
   *  performance.now keep running either way. */
  fixedMs?: number | null;
  /** localStorage seeded before the page boots: a flow's shared_prefs, already in wd's format */
  storage?: [string, string][];
  privateStorage?: { files: { path: string; fixture: string }[] };
  shots?: boolean;
  controlled?: boolean;
};

type StepOptions = {
  wait: WaitPolicy;
  capture?: boolean;
  timing?: StepSpec["timing"];
  quiescence?: Partial<Quiescence>;
};

export class WebdroidDriver {
  readonly errors: string[] = [];
  constructor(private browser: Browser, public page: Page, readonly screen: CaptureScreen) {}

  static async launch(opts: LaunchOpts = {}): Promise<WebdroidDriver> {
    const screen = opts.screen ?? deviceScreen();
    const browser = await launchBrowser();
    const ctx = await browser.newContext(CONTEXT_OPTS);
    await ctx.addInitScript({ content: probeScript({ fixedMs: opts.fixedMs === undefined ? PINNED_CLOCK_MS : opts.fixedMs, storage: opts.storage ?? [], shots: !!opts.shots }) });
    if (opts.privateStorage) await ctx.addInitScript({ content: `for (const name of ['showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker'])
      Object.defineProperty(window, name, { value: undefined, configurable: true });` });
    const page = await ctx.newPage();
    if (process.env.WEBDROID_CPU_THROTTLE) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.WEBDROID_CPU_THROTTLE) });
    const drv = new WebdroidDriver(browser, page, screen);
    page.on("pageerror", (e) => { drv.errors.push(String(e)); console.error("  [page error]", String(e).slice(0, 200)); });
    page.on("console", (message) => { if (message.type() === "error") drv.errors.push(`${message.location().url}: ${message.text()}`); });
    await drv.open(!!opts.controlled);
    if (opts.privateStorage) {
      const files = await Promise.all(opts.privateStorage.files.map(async ({ path, fixture }) => ({
        path, bytes: Array.from(new Uint8Array(await Bun.file(new URL(`../fixtures/${fixture}`, import.meta.url)).arrayBuffer())),
      })));
      await page.evaluate(async (items) => {
        const root = await navigator.storage.getDirectory();
        for (const item of items) {
          const parts = item.path.split("/");
          let dir = root;
          for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
          const file = await dir.getFileHandle(parts.at(-1)!, { create: true });
          const writer = await file.createWritable();
          await writer.write(new Uint8Array(item.bytes));
          await writer.close();
        }
      }, files);
    }
    return drv;
  }

  private async open(controlled = false): Promise<void> {
    const resp = await this.page.goto(pageUrl(this.screen, controlled), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL} — run \`bun run dev\``);
    await this.page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
    await this.page.evaluate(() => document.fonts.ready);
  }

  /** A fresh install — wd.reset() is the one definition of what that wipes. */
  async reset(): Promise<void> {
    await this.page.evaluate(() => (globalThis as any).wd.reset());
    await this.open();
  }

  /** One flow step, start to finish, in the page: action, settle, liveness, capture, telemetry. */
  step(act: Act, options: StepOptions): Promise<StepResult> {
    const timing = options.timing ?? "real";
    const spec: StepSpec = {
      act,
      screen: this.screen,
      wait: options.wait,
      quiescence: { ...DEFAULT_QUIESCENCE, ...options.quiescence },
      aliveMs: timing === "controlled" ? 3500 : 3000,
      capture: options.capture ?? true,
      timing,
    };
    return this.page.evaluate((s) => globalThis.__wd.step(s), spec);
  }

  /** An action on its own, awaited to completion under the settle timeout. */
  act(act: Act): Promise<boolean | undefined> {
    return this.page.evaluate(([a, s, ms]) => globalThis.__wd.act(a, s, ms), [act, this.screen, DEFAULT_ACTION_TIMEOUT_MS] as const);
  }

  boot(apk: string): Promise<unknown> { return this.act({ type: "boot", apk }); }

  /**
   * Is webdroid's serialized main-looper queue still draining? A wedged queue stops input,
   * layout AND repaint, so a frozen screen looks exactly like a settled one from the outside.
   */
  alive(timeoutMs = 2000): Promise<boolean> {
    return this.page.evaluate((ms) => (globalThis as any).wd.alive(ms), timeoutMs);
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
