// webdroid driver — Playwright over the dev server. Every action, settle and capture happens in
// one page.evaluate against the probe in lib/probe.ts; nothing here polls the page.
// Deliberately free of any Android/adb dependency: `bun run e2e` must run with no SDK present.
import { chromium, type Browser, type Page } from "playwright";
import { PINNED_CLOCK_MS, deviceScreen, screenParam, type Screen, type UiNode } from "../types";
import { BASE_URL } from "../lib/util";
import { DEFAULT_SETTLE, probeScript, type Act, type SettleOpts, type StepResult, type StepSpec } from "../lib/probe";

// WEBDROID_BYTECODE=android/graphics/,android/content/res/ scores a provenance cut: the same
// bundle, with those prefixes served by AOSP's own bytecode instead of our native specs. That
// is how a cut becomes a measurement (PLAN.md's B2) rather than an edit and a rebuild.
const CUT = process.env.WEBDROID_BYTECODE;

/** `WEBDROID_SCREEN=1080x2424@480` overrides the geometry every flow runs at — which un-scores
 *  the run, because the goldens are pixels at one size. That is the point: it measures cost. */
export const ENV_SCREEN = process.env.WEBDROID_SCREEN;

/** Compose the query rather than concatenating it: `?bytecode=x` + `?screen=y` silently drops
 *  the second parameter, and the run then measures the wrong geometry against the right pixels. */
function pageUrl(screen: Screen): string {
  const u = new URL(BASE_URL);
  if (CUT) u.searchParams.set("bytecode", CUT);
  u.searchParams.set("screen", screenParam(screen));
  return u.href;
}

const LAUNCH_ARGS = [
  "--use-gl=angle", "--use-angle=swiftshader",
  "--font-render-hinting=none", "--disable-lcd-text",
  "--force-device-scale-factor=1", "--hide-scrollbars",
  "--disable-partial-raster", "--disable-skia-runtime-opts",
  ...(process.env.WEBDROID_JS_FLAGS ? [`--js-flags=${process.env.WEBDROID_JS_FLAGS}`] : []),
];
export const CONTEXT_OPTS = {
  viewport: { width: 1400, height: 1500 },
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
};
export const launchBrowser = () => chromium.launch({ headless: true, args: LAUNCH_ARGS });

export type LaunchOpts = {
  screen?: Screen;
  /** Date is pinned here (default PINNED_CLOCK_MS); null keeps the wall clock. Timers, rAF and
   *  performance.now keep running either way. */
  fixedMs?: number | null;
  /** localStorage seeded before the page boots: a flow's shared_prefs, already in wd's format */
  storage?: [string, string][];
  shots?: boolean;
};

const SETTLE_DEFAULTS: SettleOpts = { ...DEFAULT_SETTLE, horizonMs: 0, animated: false };

export class WebdroidDriver {
  constructor(private browser: Browser, public page: Page, public screen: Screen) {}

  static async launch(opts: LaunchOpts = {}): Promise<WebdroidDriver> {
    const screen = opts.screen ?? deviceScreen();
    const browser = await launchBrowser();
    const ctx = await browser.newContext(CONTEXT_OPTS);
    await ctx.addInitScript({ content: probeScript({ fixedMs: opts.fixedMs === undefined ? PINNED_CLOCK_MS : opts.fixedMs, storage: opts.storage ?? [], shots: !!opts.shots }) });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("  [page error]", String(e).slice(0, 200)));
    const drv = new WebdroidDriver(browser, page, screen);
    await drv.open(screen);
    return drv;
  }

  private async open(screen: Screen): Promise<void> {
    this.screen = screen;
    const resp = await this.page.goto(pageUrl(screen), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL} — run \`bun run dev\``);
    await this.page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
    await this.page.evaluate(() => document.fonts.ready);
  }

  /** A fresh install — wd.reset() is the one definition of what that wipes — at `screen`. */
  async reset(screen: Screen = this.screen): Promise<void> {
    await this.page.evaluate(() => (globalThis as any).wd.reset());
    await this.open(screen);
  }

  /** One flow step, start to finish, in the page: action, settle, liveness, capture, telemetry. */
  step(act: Act, settle: Partial<SettleOpts> = {}): Promise<StepResult> {
    const spec: StepSpec = { act, screen: this.screen, settle: { ...SETTLE_DEFAULTS, ...settle }, aliveMs: 1500 };
    return this.page.evaluate((s) => globalThis.__wd.step(s), spec);
  }

  /** An action on its own, awaited to completion under the settle timeout. */
  act(act: Act): Promise<boolean | undefined> {
    return this.page.evaluate(([a, s, ms]) => globalThis.__wd.act(a, s, ms), [act, this.screen, DEFAULT_SETTLE.timeoutMs] as const);
  }

  boot(apk: string): Promise<unknown> { return this.act({ type: "boot", apk }); }
  /** Try the semantic path; report whether it hit so the report can flag fallbacks. */
  tapText(text: string): Promise<boolean> { return this.act({ type: "tapText", text }) as Promise<boolean>; }
  tapNorm(x: number, y: number): Promise<unknown> { return this.act({ type: "tap", x, y }); }
  type(text: string): Promise<unknown> { return this.act({ type: "type", text }); }
  back(): Promise<unknown> { return this.act({ type: "back" }); }
  swipe(from: [number, number], to: [number, number], ms = 400): Promise<unknown> { return this.act({ type: "swipe", from, to, ms }); }

  /** Exact framebuffer pixels, base64 PNG decoded. */
  async capture(): Promise<Buffer> {
    return Buffer.from(await this.page.evaluate(() => globalThis.__wd.capture()), "base64");
  }

  /** Settle on the probe's contract, then confirm the main-looper queue still drains. */
  async settle(opts: Partial<SettleOpts> = {}): Promise<{ png: Buffer; timedOut: boolean; wedged: boolean }> {
    const settled = await this.page.evaluate((o) => globalThis.__wd.settle(o), { ...SETTLE_DEFAULTS, ...opts });
    const wedged = !(await this.alive(1500));
    return { png: await this.capture(), timedOut: settled.how === "timeout", wedged };
  }

  /** One frame now, plus the liveness check settle() does. For screens that never settle. */
  snapshot(): Promise<{ png: Buffer; timedOut: boolean; wedged: boolean }> {
    return this.settle({ animated: true });
  }

  /** The page's captured console ring (wd.logs): "error: …" lines are uncaught Java throwables. */
  logs(): Promise<string[]> {
    return this.page.evaluate(() => [...((globalThis as any).wd.logs ?? [])]);
  }

  /**
   * Is webdroid's serialized main-looper queue still draining? A wedged queue stops input,
   * layout AND repaint, so a frozen screen looks exactly like a settled one from the outside.
   */
  alive(timeoutMs = 2000): Promise<boolean> {
    return this.page.evaluate((ms) => (globalThis as any).wd.alive(ms), timeoutMs);
  }

  /** Zero the in-page perf counters (bootMs is kept — it is a whole-run number). */
  perfReset(): Promise<void> {
    return this.page.evaluate(() => (globalThis as any).wd.perfReset());
  }

  perf(): Promise<Record<string, number>> {
    return this.page.evaluate(() => ({ ...((globalThis as any).wd.perf ?? {}) }));
  }

  /** Every framework API the VM has been asked for and doesn't have, so far this run. */
  missing(): Promise<string[]> {
    return this.page.evaluate(() => [...((globalThis as any).wd.rt.missing ?? [])]);
  }

  /** The WebView frames on screen (url/title/loaded): the framebuffer capture cannot see them. */
  web(): Promise<{ url: string | null; title: string; loaded: boolean; progress: number }[]> {
    return this.page.evaluate(() => (globalThis as any).wd.web?.() ?? []);
  }

  /** The view hierarchy in the shape `uiautomator dump` reports, for the structural diff. */
  uiTree(): Promise<UiNode[]> {
    return this.page.evaluate(() => (globalThis as any).wd.uiTree?.() ?? []);
  }

  /** Native libraries the app tried to load that only exist as machine code: "libx.so (abi)". */
  nativeRequired(): Promise<string[]> {
    return this.page.evaluate(() => [...((globalThis as any).wd.rt.nativeRequired ?? [])].map(([l, a]) => l + " (" + a + ")"));
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
