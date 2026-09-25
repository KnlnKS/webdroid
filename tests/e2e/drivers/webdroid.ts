// webdroid driver — Playwright over the dev server. Every action, settle and capture happens in
// one page.evaluate against the probe in lib/probe.ts; nothing here polls the page.
// Deliberately free of any Android/adb dependency: `bun run e2e` must run with no SDK present.
import { chromium, type Browser, type Page } from "playwright";
import { PINNED_CLOCK_MS, deviceScreen, screenParam, type CaptureScreen, type WaitPolicy } from "../types";
import { BASE_URL } from "../lib/util";
import { DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_QUIESCENCE, probeScript, type Act, type Quiescence, type StepResult, type StepSpec } from "../lib/probe";
import { decodeMappings, executedSources, type CoverageFunction } from "../lib/source-coverage";

// WEBDROID_BYTECODE=android/graphics/,android/content/res/ scores a provenance cut: the same
// bundle, with those prefixes served by AOSP's own bytecode instead of our native specs. That
// is how a cut becomes a measurement rather than an edit and a rebuild.
const CUT = process.env.WEBDROID_BYTECODE;
const coverageMappings = new Map<string, Promise<ReturnType<typeof decodeMappings>>>();

async function loadCoverageMappings(url: string, source: string): Promise<ReturnType<typeof decodeMappings>> {
  let pending = coverageMappings.get(url);
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`could not load coverage source map ${url}`);
      return decodeMappings(await response.json() as { mappings: string; sources: string[] }, source);
    });
    coverageMappings.set(url, pending);
  }
  return pending;
}

/** `WEBDROID_SCREEN=1080x2424@480` overrides the geometry every flow runs at — which un-scores
 *  the run, because the goldens are pixels at one size. That is the point: it measures cost. */
export const ENV_SCREEN = process.env.WEBDROID_SCREEN;

/** Compose the query rather than concatenating it: `?bytecode=x` + `?screen=y` silently drops
 *  the second parameter, and the run then measures the wrong geometry against the right pixels. */
function pageUrl(screen: CaptureScreen, controlled: boolean): string {
  const u = new URL(BASE_URL);
  if (CUT) u.searchParams.set("bytecode", CUT);
  u.searchParams.set("screen", screenParam(screen));
  u.searchParams.set("statusBarDp", String(screen.statusBarDp));
  if (controlled) u.searchParams.set("testClock", "controlled");
  return u.href;
}

const LAUNCH_ARGS = [
  "--site-per-process",
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
  ignoreDefaultArgs: ["--disable-features=IsolateOrigins,site-per-process", ...(gpu === "hardware" ? ["--enable-unsafe-swiftshader"] : [])],
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
  coverage?: boolean;
};

type StepOptions = {
  wait: WaitPolicy;
  capture?: boolean;
  timing?: StepSpec["timing"];
  quiescence?: Partial<Quiescence>;
};

export class WebdroidDriver {
  readonly errors: string[] = [];
  constructor(private browser: Browser, public page: Page, public screen: CaptureScreen, private coverage = false) {}

  static async launch(opts: LaunchOpts = {}): Promise<WebdroidDriver> {
    const screen = opts.screen ?? deviceScreen();
    const browser = await launchBrowser();
    const ctx = await browser.newContext(CONTEXT_OPTS);
    await ctx.addInitScript({ content: probeScript({ fixedMs: opts.fixedMs === undefined ? PINNED_CLOCK_MS : opts.fixedMs, storage: opts.storage ?? [], shots: !!opts.shots }) });
    if (opts.privateStorage) await ctx.addInitScript({ content: "Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })" });
    const page = await ctx.newPage();
    if (opts.coverage) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const drv = new WebdroidDriver(browser, page, screen, !!opts.coverage);
    page.on("pageerror", (e) => { drv.errors.push(String(e)); console.error("  [page error]", String(e).slice(0, 200)); });
    page.on("console", (message) => { if (message.type() === "error") drv.errors.push(`${message.location().url}: ${message.text()}`); });
    await drv.open(screen, !!opts.controlled);
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

  private async open(screen: CaptureScreen, controlled = false): Promise<void> {
    this.screen = screen;
    const resp = await this.page.goto(pageUrl(screen, controlled), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL} — run \`bun run dev\``);
    await this.page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
    await this.page.evaluate(() => document.fonts.ready);
  }

  /** A fresh install — wd.reset() is the one definition of what that wipes — at `screen`. */
  async reset(screen: CaptureScreen = this.screen): Promise<void> {
    await this.page.evaluate(() => (globalThis as any).wd.reset());
    await this.open(screen);
  }

  /** One flow step, start to finish, in the page: action, settle, liveness, capture, telemetry. */
  step(act: Act, options: StepOptions): Promise<StepResult> {
    const timing = options.timing ?? "real";
    const spec: StepSpec = {
      act,
      screen: this.screen,
      wait: options.wait,
      quiescence: { ...DEFAULT_QUIESCENCE, ...options.quiescence },
      aliveMs: this.coverage ? 5000 : timing === "controlled" ? 3500 : 3000,
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

  async takeSourceCoverage(): Promise<string[]> {
    const entries = await this.page.coverage.stopJSCoverage();
    const files = new Set<string>();
    for (const entry of entries) {
      if (!entry.url) continue;
      const path = entry.url.startsWith("http://") || entry.url.startsWith("https://")
        ? new URL(entry.url).pathname.slice(1)
        : entry.url.replace(/^\//, "");
      if (path.startsWith("src/") || path.startsWith("tests/")) { files.add(path); continue; }
      if (!entry.source || !entry.functions?.length || !entry.url.startsWith("http")) continue;
      const match = entry.source.match(/\/\/# sourceMappingURL=(\S+)/);
      if (!match) continue;
      const points = await loadCoverageMappings(new URL(match[1]!, entry.url).href, entry.source);
      for (const file of executedSources(points, entry.functions as CoverageFunction[]))
        files.add(file);
    }
    return [...files].sort();
  }

  browserVersion(): string {
    return this.page.context().browser()?.version() ?? "unknown";
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
