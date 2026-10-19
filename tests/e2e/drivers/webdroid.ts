// webdroid driver — Playwright over the dev server. Every action, settle and capture happens in
// one page.evaluate against the probe in lib/probe.ts; nothing here polls the page.
// Deliberately free of any Android/adb dependency: `pnpm e2e` must run with no SDK present.
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright";
import { PINNED_CLOCK_MS, deviceScreen, screenParam, type CaptureScreen, type WaitPolicy } from "../types.ts";
import { BASE_URL, CONTEXT_OPTS, launchOptions, webdroidUrl } from "../../../scripts/browser.ts";
import { DEFAULT_QUIESCENCE, probeScript, stepDeadlineMs, type Act, type Quiescence, type StepResult, type StepSpec } from "../lib/probe.ts";

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

async function within<T>(work: Promise<T>, ms: number, reason: string | Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(typeof reason === "string" ? new Error(reason) : reason), ms); })]); }
  finally { clearTimeout(timer!); }
}

async function closeOwned(server: BrowserServer): Promise<void> {
  try { await within(server.close(), 3000, "browser graceful close deadline"); }
  catch { await within(server.kill(), 3000, "owned browser kill deadline"); }
  const child = server.process();
  if (child.exitCode === null && child.signalCode === null) throw new Error("owned browser did not exit");
}

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
  /** no network, as a device in airplane mode: every name fails to resolve */
  offline?: boolean;
};

type StepOptions = {
  wait: WaitPolicy;
  capture?: boolean;
  timing?: StepSpec["timing"];
  quiescence?: Partial<Quiescence>;
};

export class WebdroidDriver {
  private browser: Browser; page: Page; readonly screen: CaptureScreen; private server?: BrowserServer;
  readonly errors: string[] = [];
  private closing?: Promise<void>;
  constructor(browser: Browser, page: Page, screen: CaptureScreen, server?: BrowserServer) { this.browser = browser; this.page = page; this.screen = screen; this.server = server; }

  static async launch(opts: LaunchOpts = {}): Promise<WebdroidDriver> {
    const screen = opts.screen ?? deviceScreen();
    const server = await chromium.launchServer(launchOptions());
    try {
      const browser = await chromium.connect(server.wsEndpoint());
      const ctx = await browser.newContext(CONTEXT_OPTS);
      await ctx.addInitScript({ content: probeScript({ fixedMs: opts.fixedMs === undefined ? PINNED_CLOCK_MS : opts.fixedMs, storage: opts.storage ?? [], shots: !!opts.shots }) });
      if (opts.privateStorage) await ctx.addInitScript({ content: `for (const name of ['showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker'])
        Object.defineProperty(window, name, { value: undefined, configurable: true });` });
      if (opts.offline) {
        await ctx.route(/^https?:\/\/[^/]+\/(dns|proxy)\?/, (route) => route.fulfill(
          new URL(route.request().url()).pathname === "/dns" ? { status: 404 } : { status: 502, headers: { "x-wd-error": "host" } }));
        await ctx.routeWebSocket(/^wss?:\/\/[^/]+\/(tcp|udp)(\?|$)/, (ws) => ws.close());
      }
      const page = await ctx.newPage();
      if (process.env.WEBDROID_CPU_THROTTLE) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.WEBDROID_CPU_THROTTLE) });
      const drv = new WebdroidDriver(browser, page, screen, server);
      page.on("pageerror", (e) => { drv.errors.push(String(e)); console.error("  [page error]", String(e).slice(0, 200)); });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const { url } = message.location();
        // offline, what the network serves fails to load, as on a device without one
        if (opts.offline && message.text().startsWith("Failed to load resource") && !url.startsWith(BASE_URL)) return;
        drv.errors.push(`${url}: ${message.text()}`);
      });
      await drv.open(!!opts.controlled);
      if (opts.privateStorage) {
        const files = await Promise.all(opts.privateStorage.files.map(async ({ path, fixture }) => ({
          path, bytes: Array.from(await readFile(new URL(`../fixtures/${fixture}`, import.meta.url))),
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
    } catch (error) {
      try { await closeOwned(server); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Browser startup failed: ${String(error)}; cleanup failed: ${String(cleanup)}`, { cause: error }); }
      throw error;
    }
  }

  private async open(controlled = false): Promise<void> {
    const resp = await this.page.goto(pageUrl(this.screen, controlled), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!resp?.ok()) throw new Error(`dev server not reachable at ${BASE_URL} — run \`pnpm dev\``);
    await this.page.waitForFunction(() => !!(globalThis as any).wd, null, { timeout: 60_000 });
    await this.page.evaluate(() => document.fonts.ready);
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
    const ms = stepDeadlineMs(spec);
    const deadline = new Error(`host step deadline (${ms} ms)`);
    return within(this.page.evaluate((s) => globalThis.__wd.step(s), spec), ms, deadline).catch(error => {
      if (error === deadline) {
        this.errors.push(error.message);
        // Reject now so capture persists the partial flow before cleanup finishes.
        void this.close().catch(cause => { this.errors.push(String(cause)); });
      }
      throw error;
    });
  }

  /**
   * Is webdroid's serialized main-looper queue still draining? A wedged queue stops input,
   * layout AND repaint, so a frozen screen looks exactly like a settled one from the outside.
   */
  alive(timeoutMs = 2000): Promise<boolean> {
    return this.page.evaluate((ms) => (globalThis as any).wd.alive(ms), timeoutMs);
  }

  close(): Promise<void> {
    return this.closing ??= this.server ? closeOwned(this.server) : within(this.browser.close(), 3000, "browser close deadline (no owned process)");
  }
}
