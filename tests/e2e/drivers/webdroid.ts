// webdroid driver — Playwright over the dev server, using the in-page `wd` helpers.
// Deliberately free of any Android/adb dependency: `bun run e2e` must run with no SDK present.
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { SCREEN_W, SCREEN_H, PINNED_CLOCK_MS, type UiNode } from "../types";
import { sleep, sha1, BASE_URL } from "../lib/util";


// WEBDROID_BYTECODE=android/graphics/,android/content/res/ scores a provenance cut: the same
// bundle, with those prefixes served by AOSP's own bytecode instead of our native specs. That
// is how a cut becomes a measurement (PLAN.md's B2) rather than an edit and a rebuild.
const CUT = process.env.WEBDROID_BYTECODE;
const PAGE_URL = CUT ? `${BASE_URL}/?bytecode=${encodeURIComponent(CUT)}` : BASE_URL;

declare global {
  // eslint-disable-next-line no-var
  var wd: any;
}

/** Hard stop so a step that repaints forever cannot fill the disk. */
const MAX_FRAMES_PER_STEP = 240;

const LAUNCH_ARGS = [
  "--use-gl=angle", "--use-angle=swiftshader",
  "--font-render-hinting=none", "--disable-lcd-text",
  "--force-device-scale-factor=1", "--hide-scrollbars",
  "--disable-partial-raster", "--disable-skia-runtime-opts",
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

export class WebdroidDriver {
  constructor(private browser: Browser, public page: Page) {}

  // Optional frame recorder (--shots). The diffed capture is one settled frame per step. This records every DISTINCT frame while
  // the step runs, which is what you actually need to see when a step goes wrong: what was
  // drawn on the way, and whether anything was drawn at all.
  private shotsRoot?: string;
  private stepDir?: string;
  private shotSeq = 0;
  private shotLastHash = "";
  private shotRunning = false;
  private shotLoop?: Promise<void>;

  enableShots(dir: string): void { this.shotsRoot = dir; }

  private async snapFrame(): Promise<void> {
    if (!this.stepDir || this.shotSeq >= MAX_FRAMES_PER_STEP) return;
    const png = await this.capture();
    const h = sha1(png);
    if (h === this.shotLastHash) return;
    this.shotLastHash = h;
    await Bun.write(`${this.stepDir}/f${String(this.shotSeq++).padStart(3, "0")}.png`, png);
  }

  async beginStep(flow: string, index: number, id: string, intervalMs = 150): Promise<void> {
    if (!this.shotsRoot) return;
    this.stepDir = `${this.shotsRoot}/${flow}/${String(index).padStart(2, "0")}-${id}`;
    await mkdir(this.stepDir, { recursive: true });
    this.shotSeq = 0;
    this.shotLastHash = "";
    this.shotRunning = true;
    this.shotLoop = (async () => {
      while (this.shotRunning) {
        // The page is busy with the step's own evaluate calls; a dropped sample is fine.
        await this.snapFrame().catch(() => {});
        await sleep(intervalMs);
      }
      await this.snapFrame().catch(() => {});
    })();
  }

  async endStep(): Promise<number> {
    if (!this.shotLoop) return 0;
    this.shotRunning = false;
    await this.shotLoop;
    this.shotLoop = undefined;
    const n = this.shotSeq;
    this.stepDir = undefined;
    return n;
  }

  static async launch(): Promise<WebdroidDriver> {
    const browser = await launchBrowser();
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    // Pin Date without freezing timers — rAF and the 33ms setInterval fallback keep running.
    await page.clock.setFixedTime(new Date(PINNED_CLOCK_MS));

    page.on("pageerror", (e) => console.error("  [page error]", String(e).slice(0, 200)));

    const resp = await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL} — run \`bun run dev\``);
    await page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
    await page.evaluate(() => (document as any).fonts.ready);
    return new WebdroidDriver(browser, page);
  }

  /** Pin Date to `ms` without freezing timers. Per flow: see Flow.liveClock. */
  setClock(ms: number): Promise<void> {
    return this.page.clock.setFixedTime(new Date(ms));
  }

  /** A fresh install — wd.reset() is the one definition of what that wipes. */
  async reset(): Promise<void> {
    await this.page.evaluate(() => (globalThis as any).wd.reset());
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
    await this.page.evaluate(() => (document as any).fonts.ready);
  }

  /**
   * Write a flow's seed prefs into webdroid's own store, so the two passes start on the same
   * screen. The flow carries the Android shared_prefs XML the emulator writes as a file;
   * webdroid keeps prefs as JSON under `wd:prefs:<pkg>:<name>` (see JSharedPrefs.persist),
   * so parse rather than duplicate the data in a second format.
   */
  async seedPrefs(pkg: string, xml: string): Promise<void> {
    const map: Record<string, unknown> = {};
    for (const m of xml.matchAll(/<(string|boolean|int|long|float)\s+name="([^"]+)"(?:\s+value="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
      const [, kind, name, attr, text] = m;
      map[name] = kind === "string" ? (text ?? "")
        : kind === "boolean" ? attr === "true"
        : kind === "long" ? { $l: attr }
        : Number(attr);
    }
    await this.page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, JSON.stringify(value)),
      [`wd:prefs:${pkg}:${pkg}_preferences`, map] as const,
    );
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
  }

  /**
   * Every wd.* driving helper is fired WITHOUT awaiting its in-page promise. Those promises
   * resolve through webdroid's serialized main-looper queue, which can stall arbitrarily long
   * (or forever, when a step wedges the app); awaiting them from Playwright surfaces as
   * "Resulting promise was garbage collected" and aborts the run. Progress is observed through
   * settle() instead, which is what we actually care about.
   */
  private fire(fn: string, ...args: unknown[]): Promise<void> {
    return this.page.evaluate(
      ([f, a]) => { void (globalThis as any).wd[f as string](...(a as unknown[])); },
      [fn, args] as const,
    );
  }

  async boot(apk: string): Promise<void> {
    await this.fire("boot", apk);
  }

  /** Try the semantic path first; report whether it hit so the report can flag fallbacks. */
  async tapText(text: string): Promise<boolean> {
    const hit = await this.page.evaluate(
      (t) => (globalThis as any).wd.locateText(t) as { x: number; y: number } | null, text);
    if (!hit) return false;
    await this.fire("tap", hit.x, hit.y);
    return true;
  }

  async tapNorm(x: number, y: number): Promise<void> {
    await this.fire("tap", x * SCREEN_W, y * SCREEN_H);
  }

  async type(text: string): Promise<void> {
    await this.fire("type", text);
  }

  async back(): Promise<void> {
    await this.fire("back");
  }

  async swipe(from: [number, number], to: [number, number], ms = 400): Promise<void> {
    await this.fire("swipe", from[0] * SCREEN_W, from[1] * SCREEN_H,
                    to[0] * SCREEN_W, to[1] * SCREEN_H, ms);
  }

  /** Exact framebuffer pixels — sidesteps the CSS-scaling trap AGENTS.md "Harness notes" warns about. */
  async capture(): Promise<Buffer> {
    const dataUrl = await this.page.evaluate(() => {
      const c = document.getElementById("screen") as HTMLCanvasElement;
      return c.toDataURL("image/png");
    });
    return Buffer.from(dataUrl.split(",")[1], "base64");
  }

  /**
   * Settle on the same contract as the emulator driver: frame hash stable for N samples.
   * Stable pixels alone prove nothing, so every exit also asks alive() whether the main-looper
   * queue still drains; a hung app is reported as wedged, not as settled.
   */
  async settle({ stableFrames = 4, intervalMs = 250, timeoutMs = 20_000 } = {}):
      Promise<{ png: Buffer; timedOut: boolean; wedged: boolean }> {
    const t0 = Date.now();
    let last = "", stable = 0;
    // A focused EditText blinks its caret on a 530ms cycle, so those screens never produce N
    // identical frames however long we wait. Treat a settled OSCILLATION between a small number
    // of frames as settled too, and return the most frequent one so the capture is deterministic
    // rather than whichever phase we happened to sample.
    const win = stableFrames * 2;
    const recent: { h: string; png: Buffer }[] = [];
    /** the window holds exactly two frames, each seen more than once: a steady blink */
    const oscillation = () => {
      if (recent.length < win) return null;
      const tally = new Map<string, { png: Buffer; n: number }>();
      for (const r of recent) {
        const e = tally.get(r.h);
        if (e) e.n++; else tally.set(r.h, { png: r.png, n: 1 });
      }
      if (tally.size !== 2) return null;
      const [a, b] = [...tally.values()];
      if (a.n < 2 || b.n < 2) return null;
      return (a.n >= b.n ? a : b).png;
    };
    let png = await this.capture();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(intervalMs);
      png = await this.capture();
      const h = sha1(png);
      recent.push({ h, png });
      if (recent.length > win) recent.shift();
      stable = h === last ? stable + 1 : 0;
      last = h;
      const osc = oscillation();
      if (osc) return { png: osc, timedOut: false, wedged: !(await this.alive(1500)) };
      if (stable >= stableFrames) {
        // Stable pixels alone prove nothing: confirm the main queue is still draining, so a
        // hung app is reported as hung instead of silently passing as "settled".
        const ok = await this.alive(1500);
        return { png, timedOut: false, wedged: !ok };
      }
    }
    return { png, timedOut: true, wedged: !(await this.alive(1500)) };
  }

  /** One frame now, plus the liveness check settle() does. For screens that never settle. */
  async snapshot(): Promise<{ png: Buffer; timedOut: boolean; wedged: boolean }> {
    const png = await this.capture();
    return { png, timedOut: false, wedged: !(await this.alive(1500)) };
  }

  /** The page's captured console ring (wd.logs): "error: …" lines are uncaught Java throwables. */
  logs(): Promise<string[]> {
    return this.page.evaluate(() => [...((globalThis as any).wd.logs ?? [])]);
  }

  /**
   * Is webdroid's serialized main-looper queue still draining? A wedged queue stops input,
   * layout AND repaint, so a frozen screen looks exactly like a settled one from the outside.
   * This is the only way to tell the two apart.
   */
  alive(timeoutMs = 2000): Promise<boolean> {
    return this.page.evaluate((ms) => (globalThis as any).wd.alive(ms), timeoutMs);
  }

  /** Zero the in-page perf counters (bootMs is kept — it is a whole-run number). */
  perfReset(): Promise<void> {
    return this.page.evaluate(() => (globalThis as any).wd.perfReset?.());
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

  /** Framework attributes a layout carried that nothing in the framework reads. */
  unreadAttrs(): Promise<string[]> {
    return this.page.evaluate(() => (globalThis as any).wd.unreadAttrs?.() ?? []);
  }

  /** Native libraries the app tried to load that only exist as machine code: "libx.so (abi)". */
  nativeRequired(): Promise<string[]> {
    return this.page.evaluate(() => [...((globalThis as any).wd.rt.nativeRequired ?? [])].map(([l, a]) => l + " (" + a + ")"));
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
