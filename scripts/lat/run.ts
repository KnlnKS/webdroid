// A gated tap's latency is pointerup to the first presented frame that visibly answers it: the first
// frame whose response region departs from the frame before pointerup in the tiles that the settled
// response also changed, outside the pressed view's feedback. Nothing runs Java on the app between
// pointerdown and the settled frame: the app's Worker sends downscaled crops of the response
// regions with each frame it presents, read only once the window closes, and the scenario's UI state
// is checked once afterwards.
//
//   bun run lat [scenario ...] [--engine chrome|webkit] [--gpu] [--warm] [--ecores] [--timeline] [--json <file>] [--query <params>] [--cpuprofile <file>] (one file per Worker too) [--heapsample] (with --cpuprofile: live-heap allocation samples, .heapprofile) [--trace <file>] [--demand] (each tap's on-demand compiled methods in --json)
//
// Drives headless Chrome over raw CDP with only Page/Target enabled: Playwright's Runtime.enable
// makes V8 capture a detailed stack for every Java exception, about 5x their cost. The scenario
// runs inside the page, signals through document.title and exports copied diagnostics without enabling Runtime. `--warm` launches each scenario twice
// in one browser profile and gates the second: it starts from fresh app data (wd.reset) but with
// the compiled code the first launch persisted. `--ecores` (macOS) runs Chrome under a background QoS clamp, so every thread, the app Workers included,
// runs on the efficiency cores: a slower device (a busy loop ran about 6x slower on an M4 Pro). CDP CPU throttling slows only pages, never Workers.
// A scenario is scripts/lat/scenarios/<name>.json:
//   { "apk": "FitNotes.apk", "steps": [{"tap":[x,y]} | {"text":"Save"} | {"m":"name","tap":[x,y] | "text":…} | {"wait":ms}
//     | {"swipe":[x1,y1,x2,y2,ms]} | {"fps":[x1,y1,x2,y2],"ms":8000,"name":"…"} | {"pick":"photo.jpg"} | {"privateStorage":true}] }   (pick offers a synthetic photo;
//     fps scrolls back and forth for ms and reports presentation intervals and page long tasks)
// "gate": false makes a scenario a report, run only when named (heavy apps: YouTube, Reddit, ChatGPT, TikTok).
// Coordinates are in the fixed 1080x2160@480 screen. Only "m" taps are gated; each launch also
// reports root frame proxies and actual app presentation separately. --cpuprofile writes
// the gated launch's V8 profile; each gated pointerup then runs __wdMarkUp (1 ms) so
// scripts/lat/profsum.ts can window the profile to one tap. --trace writes the gated launch's browser-wide trace (every
// thread: page, Workers, GPU, V8 collections), for chrome://tracing or Perfetto; WEBDROID_TRACE_CATEGORIES (comma-separated) replaces
// its categories, e.g. disabled-by-default-v8.gc,v8 for a small GC-only trace; each gated pointerup is a `lat:<name>` user-timing mark in it. WEBDROID_JS_FLAGS and WEBDROID_CHROME_ARGS (space-separated)
// pass V8 flags and Chrome arguments for A/B runs. With --timeline, --json taps carry the Worker's and the page's timelines and the page's long tasks.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, webkit, type BrowserContext } from "playwright";
import { installLatencyObserver } from "./observe";
import { matchesState, compileDeltas, type Expectation } from "./expect";
import { consume } from "../args";

const LIMIT_MS = 150;
const SCREEN = "1080x2160@480";
const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const SCENARIOS = join(import.meta.dir, "scenarios");

const args = process.argv.slice(2);
const { flag, option } = consume(args);
const heapSample = flag("--heapsample");
const gpu = flag("--gpu"), warm = flag("--warm"), demand = flag("--demand"), timeline = flag("--timeline"), jsonOut = option("--json"), query = option("--query"), cpuProfile = option("--cpuprofile"), traceOut = option("--trace"), engine = option("--engine") ?? "chrome";
const ecores = flag("--ecores");
if (!["chrome", "webkit"].includes(engine)) throw new Error("lat engine must be chrome or webkit");
if (ecores && (engine !== "chrome" || process.platform !== "darwin")) throw new Error("lat --ecores runs Chrome under macOS's taskpolicy");
const launchQuery = new URLSearchParams(query);
if (!launchQuery.has("perfProbe")) launchQuery.set("perfProbe", "1");
// a cold launch is a first launch of any app: the platform build's bundled app builds stay out unless asked for
if (!launchQuery.has("bundles")) launchQuery.set("bundles", "0");
/** a scenario with "gate": false (a heavy app whose launch waits on live content) is a report: run only when named, and its taps and failures do not fail the gate */
const gates = (name: string): boolean => JSON.parse(readFileSync(join(SCENARIOS, name + ".json"), "utf8")).gate !== false;
const names = args.length ? args : readdirSync(SCENARIOS).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).filter(gates);

/** the wd.perf counters a tap's breakdown reports, as deltas from pointerup to the response */
const COUNTERS = ["inputMs", "resParseMs", "drawMs", "frameMs", "presentations", "presentLagMs",
  "wasmMethods", "wasmClassBuildMs", "wasmCompileMs", "wasmModules", "wasmModuleMs", "wasmBytes", "wasmAotLoaded", "wasmAotMissed", "wasmAotMs", "wasmClasses", "wasmSuspensions", "wasmCrossings", "wasmEntries", "wasmAhead", "wasmRetired", "wasmCollected"];

/** the first-response clock: pointerup to the first answering frame and to the frame the response settled in,
 *  with the presentation intervals between them */
type First = { first: number | null; settled: number | null; frames: number; changedTiles: number; maskedTiles: number; pid: string | null;
  intervals: { p50: number | null; p95: number | null; max: number | null; missed: number }; error?: string };
type Tap = { intended: number | null; response?: First; timeline?: unknown; page?: unknown; semantic: unknown; compileBefore: any[]; compileAfter: any[]; compileWindow: { origin: number; up: number; end: number | null }; compile?: ReturnType<typeof compileDeltas>; m: string; frames: number; perf: Record<string, number>; processesBefore: unknown; processesAfter: unknown; demandMark?: number[]; demand?: [string, boolean, boolean, boolean][] | null };
/** Root draw proxy and realm presentation marks; compile counters below still belong to the root. */
type Launch = { demand?: [string, boolean, boolean, boolean][] | null; firstApp: unknown; renderedApp: unknown; compileCounters: any[]; compileCounterAt: number; firstFrame: number;
  idle: number; perf: Record<string, number>; marks: string[] };
type Fps = { m: string; ms: number; presents: number; fps: number; p50: number | null; p95: number | null; p99: number | null; over25: number; longTasks: number; longTaskMs: number; frames?: any };
type Capture = { launch?: Launch; taps: Tap[]; fps?: Fps[]; processesBefore?: unknown; processesAfter?: unknown;
  presentation?: { firstApp: unknown; renderedApp?: unknown };
  codeReadiness?: { phase: "saved" | "attached"; realms: unknown[] }; error?: string };

const inPage = (steps: unknown, counters: string[], save: boolean, replay: boolean, expectedLaunch: Expectation) => `(${async function run(steps: any[], counters: string[], save: boolean, replay: boolean, expectedLaunch: Expectation) {
  const w = globalThis as any;
  const result: Capture = w.__wdLat = { taps: [] };
  // a process Worker's state reaches the page over its control port
  const foreground = async () => (await w.wd.foregroundWorkerSnapshot())?.snapshot ?? null;
  const readRealm = (win: Window) => {
    const wd = (win as any).wd, wasm = win.__wdWasm;
    if (!wd) return { url: win.location.href, status: "unavailable" };
    return { url: win.location.href, status: "ok", pkg: wd.app()?.pkg ?? null, ticks: wd.ticks,
      pid: new URLSearchParams(win.location.search).get("pid"), process: new URLSearchParams(win.location.search).get("process"),
      missing: [...wd.rt.missing], missingAt: Object.fromEntries([...wd.rt.missingAt ?? []].map(([name, frames]) => [name, frames.slice()])), placeholders: [...wd.rt.placeholders],
      placeholderAt: Object.fromEntries([...wd.rt.placeholderAt].map(([name, frames]) => [name, frames.slice()])), native: wd.nativeRequirements(), logs: wd.logs?.slice() ?? null,
      perf: { ...wd.perf }, queue: { ...wd.mainDbg }, wasm: wasm ? { appSaved: wasm.appSaved ?? null, appAttached: wasm.appAttached ?? null, appSource: wasm.appSource ?? null,
        aotKey: wasm.aotKey ?? null, appBuilds: wasm.appBuilds?.map(b => ({ ...b })) ?? [], worker: wasm.worker ? { ...wasm.worker } : null } : null };
  };
  const diagnostics = w.__wdLatRead = async () => {
    let workers;
    try { workers = w.wd?.workerProcesses ? await w.wd.workerProcesses() : []; }
    catch (error) { workers = [{ error: String(error) }]; }
    return { at: performance.now(), frames: [readRealm(window)], workers };
  };
  const workerReadiness = async (save: boolean) => {
    const code = await w.wd.foregroundCodeReadiness(save);
    if (!code) throw new Error("foreground Worker code readiness unavailable");
    if (save ? !code.kept && !code.persisted : !code.saved || code.source !== "persist" || !code.attached)
      throw new Error("Wasm Worker app code is not " + (save ? "saved" : "attached from persisted code") + ": " + JSON.stringify(code));
    return code;
  };
  type Pixels = ReturnType<typeof regionInfo>;
  type Frame = { t: number; image: ImageBitmap; receipt: any };
  let latest: Frame | null = null, frameCount = 0, generation = 0, frameError: string | null = null;
  const observer = w.__wdLatObserver;
  if (!observer) throw new Error("All-realm presentation observer unavailable");
  const regionCanvas = new OffscreenCanvas(64, 64), regionContext = regionCanvas.getContext("2d", { willReadFrequently: true })!;
  const crop = (source: ImageBitmapSource, region: number[]) => {
    const [left, top, right, bottom] = region;
    return createImageBitmap(source, left, top, right - left, bottom - top, { resizeWidth: 64, resizeHeight: 64 });
  };
  const regionInfo = (image: ImageBitmap) => {
    regionContext.drawImage(image, 0, 0);
    image.close();
    const data = regionContext.getImageData(0, 0, 64, 64).data, rgb = [0, 0, 0];
    let hash = 0, variation = 0;
    for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) {
      hash = (Math.imul(hash, 31) + (data[i + k] >> 3)) | 0;
      rgb[k] += data[i + k]; variation = Math.max(variation, Math.abs(data[i + k] - data[k]));
    }
    return { hash, nonUniform: variation > 8, rgb: rgb.map(v => v / 4096) };
  };
  const stop = () => {
    observer.onFrame = null; w.wd?.mirrorFrames(false);
    generation++;
    latest?.image.close(); latest = null;
  };
  const collect = () => {
    stop(); frameCount = 0;
    const epoch = generation;
    w.wd.mirrorFrames(true);
    observer.onFrame = (receipt: any, bitmap: ImageBitmap) => {
      let image: ImageBitmap | undefined = bitmap;
      try {
        if (epoch !== generation || !receipt.visible) return;
        frameCount++;
        if (latest && latest.t > receipt.at) return;
        latest?.image.close();
        latest = { t: receipt.at, image, receipt };
        image = undefined;
      } catch (e) { if (epoch === generation) frameError = String(e); }
      finally { image?.close(); }
    };
  };
  const probes: { start: number; end: number }[] = [];
  /** the UI state, or null while the app's main looper is too busy to answer within a second */
  const state = async () => {
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([w.wd.uiTree(), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1000); })]); }
    finally { clearTimeout(timer); probes.push({ start, end: performance.now() }); }
  };
  const pixelsMatch = (expectation: Expectation, pixels: Pixels[], baseline: Pixels[]) => expectation.pixels.every((p, i) => {
    const pixel = pixels[i];
    return !!pixel && (!p.changed || baseline[i]?.hash !== pixel.hash) && (!p.nonUniform || pixel.nonUniform) &&
      (!p.rgb || p.rgb.some(rgb => rgb.every((v, k) => Math.abs(pixel.rgb[k] - v) <= 1)));
  });
  /** the `p` quantile of ascending `sorted`, to 0.1 ms */
  const quantile = (sorted: number[], p: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10 : null;
  // The first-response clock. Each frame an app Worker presents arrives as crops of the response regions,
  // CROP px on the long side, compared in TILE px tiles; the pixels are read only after the window closes.
  const CROP = 128, TILE = 8, FEEDBACK_PX = 72;
  type Shot = { t: number; pid: string | null; still: boolean; crops: ImageBitmap[] };
  type Tiles = { sums: Uint32Array[]; pixels: Pixels[] };
  let shots: Shot[] | null = null;
  const watch = (expectation: Expectation) => {
    stop(); shots = [];
    const into = shots;
    observer.onCrops = (receipt: any, crops: ImageBitmap[]) => {
      if (shots !== into || !receipt.visible) { crops.forEach(c => c.close()); return; }
      into.push({ t: receipt.at, pid: receipt.pid, still: receipt.still, crops });
    };
    w.wd.mirrorFrames({ regions: expectation.pixels.map(p => p.region), max: CROP });
  };
  const unwatch = () => { observer.onCrops = null; w.wd.mirrorFrames(false); const got = shots ?? []; shots = null; return got; };
  const tileCanvas = new OffscreenCanvas(CROP, CROP), tileContext = tileCanvas.getContext("2d", { willReadFrequently: true })!;
  /** per region, a checksum of each tile, and the region's summary as regionInfo gives it */
  const tilesOf = (shot: Shot): Tiles => {
    const sums: Uint32Array[] = [], pixels: Pixels[] = [];
    for (const image of shot.crops) {
      const { width, height } = image, across = Math.ceil(width / TILE), down = Math.ceil(height / TILE);
      tileContext.clearRect(0, 0, CROP, CROP); tileContext.drawImage(image, 0, 0);
      const data = tileContext.getImageData(0, 0, width, height).data, tile = new Uint32Array(across * down), rgb = [0, 0, 0];
      let variation = 0, hash = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, k = ((y / TILE) | 0) * across + ((x / TILE) | 0);
        const v = data[i] | data[i + 1] << 8 | data[i + 2] << 16;
        tile[k] = (Math.imul(tile[k] ^ v, 0x01000193) + x) >>> 0;
        hash = (Math.imul(hash, 31) + v) | 0;
        for (let c = 0; c < 3; c++) { rgb[c] += data[i + c]; variation = Math.max(variation, Math.abs(data[i + c] - data[c])); }
      }
      sums.push(tile); pixels.push({ hash, nonUniform: variation > 8, rgb: rgb.map(v => v / (width * height)) });
    }
    return { sums, pixels };
  };
  /** which tiles of each region lie within `box` (screen px) */
  const tilesIn = (expectation: Expectation, shot: Shot, box: number[]) => expectation.pixels.map((p, r) => {
    const [l, t, right] = p.region, image = shot.crops[r], scale = image.width / (right - l);
    const across = Math.ceil(image.width / TILE), down = Math.ceil(image.height / TILE), inside = new Uint8Array(across * down);
    for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) {
      const x0 = l + i * TILE / scale, y0 = t + j * TILE / scale, x1 = x0 + TILE / scale, y1 = y0 + TILE / scale;
      inside[j * across + i] = +(x1 > box[0] && x0 < box[2] && y1 > box[1] && y0 < box[3]);
    }
    return inside;
  });
  const differs = (a: Tiles, b: Tiles, region: number, k: number) => a.sums[region]?.[k] !== b.sums[region]?.[k];
  /**
   * The response clock over one window's shots. The baseline is the last frame before pointerup (else what
   * was shown when the window opened); the response is the set of tiles the settled frame changed from it,
   * less the pressed view's bounds widened by FEEDBACK_PX and any tile that already moved while pressed.
   */
  const firstResponse = (expectation: Expectation, all: Shot[], up: number, pressed: number[], pid: string | null): First & { last?: Tiles; still?: Tiles } => {
    const mine = all.filter(s => s.pid === pid).sort((a, b) => a.t - b.t), stills = mine.filter(s => s.still), frames = mine.filter(s => !s.still);
    const after = frames.filter(s => s.t >= up), before = frames.filter(s => s.t < up);
    const none = { first: null, settled: null, frames: after.length, changedTiles: 0, maskedTiles: 0, pid, intervals: { p50: null, p95: null, max: null, missed: 0 } };
    if (!after.length) return { ...none, error: "no app frame after pointerup" };
    const still = stills[0] ? tilesOf(stills[0]) : null, base = before.length ? tilesOf(before.at(-1)!) : still;
    const tiles = after.map(tilesOf), last = tiles.at(-1)!;
    // a process with no frame before pointerup answers with its first frame
    if (!base) return { ...none, first: after[0].t - up, settled: after.at(-1)!.t - up, last, error: undefined };
    const mask = tilesIn(expectation, after[0], [pressed[0] - FEEDBACK_PX, pressed[1] - FEEDBACK_PX, pressed[2] + FEEDBACK_PX, pressed[3] + FEEDBACK_PX]);
    const pressing = before.map(tilesOf);
    const response: [number, number][] = [];
    let masked = 0;
    for (let r = 0; r < mask.length; r++) for (let k = 0; k < mask[r].length; k++) {
      if (!differs(last, base, r, k)) continue;
      if (mask[r][k] || still && pressing.some(p => differs(p, still, r, k))) { masked++; continue; }
      response.push([r, k]);
    }
    if (!response.length) return { ...none, maskedTiles: masked, still: still ?? undefined, last, error: "the response regions did not change outside the pressed view" };
    const firstAt = tiles.findIndex(f => response.some(([r, k]) => differs(f, base, r, k)));
    let settledAt = tiles.length - 1;
    while (settledAt > 0 && response.every(([r, k]) => !differs(tiles[settledAt - 1], last, r, k))) settledAt--;
    const times = after.slice(firstAt, settledAt + 1).map(s => s.t), gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    const q = (p: number) => quantile(gaps, p);
    return { first: after[firstAt].t - up, settled: after[settledAt].t - up, frames: after.length, changedTiles: response.length, maskedTiles: masked, pid,
      intervals: { p50: q(0.5), p95: q(0.95), max: q(1), missed: gaps.reduce((n, g) => n + Math.max(0, Math.round(g / (1000 / 60)) - 1), 0) }, still: still ?? undefined, last };
  };
  const intended = async (expectation: Expectation, start: number, baseline: Pixels[]) => {
    const end = performance.now() + (expectation.ms ?? 8000), probeStart = probes.length;
    let stateAt: number | null = null, nodes: unknown, error: string | null = null, seen: Frame | null = null;
    // reading a frame back waits for its raster, which under software GL stalls the app: candidates are cropped
    // as they present and read once the app is quiet
    const candidates: { frame: Frame; stateAt: number; nodes: unknown; crops: Promise<ImageBitmap[]> }[] = [];
    const settle = async () => {
      let found;
      for (const c of candidates.splice(0)) {
        const crops = await c.crops;
        if (found) { crops.forEach(i => i.close()); continue; }
        const pixels = crops.map(regionInfo);
        if (pixelsMatch(expectation, pixels, baseline)) found = { at: Math.max(c.frame.t, c.stateAt), frameAt: c.frame.t, stateAt: c.stateAt, nodes: c.nodes, pixels, receipt: c.frame.receipt, error,
          probes: probes.slice(probeStart), compileAfter: observer.snapshot(), compileAt: performance.now() };
      }
      return found;
    };
    while (performance.now() < end) {
      if (frameError) { error = frameError; break; }
      try {
        const frame = latest;
        if (stateAt !== null && frame && frame !== seen && frame.t >= start && frame.t === observer.lastApp?.at && frame.receipt.url === observer.lastApp.url) {
          seen = frame;
          candidates.push({ frame, stateAt, nodes, crops: Promise.all(expectation.pixels.map(p => crop(frame.image, p.region))) });
        }
        if (candidates.length && (!expectation.pixels.length || candidates.length >= 32 || performance.now() - latest!.t >= 100)) {
          const found = await settle();
          if (found) return found;
        }
        if (w.wd && !candidates.length) {
          nodes = await state();
          if (nodes && w.__wdLatMatches(nodes, expectation)) stateAt ??= performance.now(); else stateAt = null;
        }
      } catch (e) { error = String(e); break; }
      // the next probe follows the next app frame: probing runs Java on the app's main looper
      for (const seen = frameCount, until = performance.now() + 100; frameCount === seen && performance.now() < until;) await sleep(4);
    }
    return await settle() ?? { at: null, stateAt, nodes, receipt: null, error: error ?? "intended rendered response unavailable", probes: probes.slice(probeStart), compileAfter: observer.snapshot(), compileAt: performance.now() };
  };
  /**
   * Where a window's frames went, from the foreground Worker's timeline (src/timeline.ts), read after the window:
   * per presented frame its vsync-to-present time, doFrame, replay and composite durations, and each vsync that
   * presented nothing while the app was drawing, by whether the main looper was busy at it.
   */
  const frameReport = async (from: number, to: number) => {
    const events: [number, number, number][] = (await w.wd.foregroundTimeline(performance.timeOrigin + from)).map(([t, e, a]: number[]) => [t - performance.timeOrigin, e, a]);
    const E = { Raf: 1, InputIn: 2, InputDispatch: 4, InputDone: 5, FrameBegin: 6, FrameEnd: 7, DrawBegin: 8, DrawEnd: 9, CompositeBegin: 11, CompositeEnd: 12, Present: 13, LoopIdle: 14, LoopWake: 15 };
    const spans = { doFrame: [] as number[], draw: [] as number[], composite: [] as number[], vsyncToPresent: [] as number[], inputToDispatch: [] as number[], busyAtVsync: [] as number[] };
    let raf = -1, frame = -1, draw = -1, comp = -1, idle = true, wake = from, input = -1, presentedSince = true, drawing = false, missedBusy = 0, missedIdle = 0, vsyncs = 0;
    for (const [t, e, a] of events) {
      if (t > to) break;
      switch (e) {
        case E.Raf:
          if (!a) break;
          vsyncs++;
          // a vsync passed without a presentation while frames were being made
          if (!presentedSince && drawing) { if (idle) missedIdle++; else { missedBusy++; spans.busyAtVsync.push(t - wake); } }
          raf = t; presentedSince = false; break;
        case E.InputIn: input = t; break;
        case E.InputDispatch: if (input >= 0) { spans.inputToDispatch.push(t - input); input = -1; } break;
        case E.FrameBegin: frame = t; drawing = true; break;
        case E.FrameEnd: if (frame >= 0) spans.doFrame.push(t - frame); frame = -1; break;
        case E.DrawBegin: draw = t; drawing = true; break;
        case E.DrawEnd: if (draw >= 0) spans.draw.push(t - draw); draw = -1; break;
        case E.CompositeBegin: comp = t; break;
        case E.CompositeEnd: if (comp >= 0) spans.composite.push(t - comp); comp = -1; break;
        case E.Present: if (raf >= 0) spans.vsyncToPresent.push(t - raf); presentedSince = true; break;
        case E.LoopIdle: idle = true; drawing = frame >= 0; break;
        case E.LoopWake: idle = false; wake = t; break;
      }
    }
    const stat = (xs: number[]) => {
      if (!xs.length) return null;
      const s = xs.slice().sort((a, b) => a - b), q = (p: number) => quantile(s, p);
      return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) };
    };
    return { vsyncs, missedBusy, missedIdle, events: events.length, ...Object.fromEntries(Object.entries(spans).map(([k, v]) => [k, stat(v)])),
      raw: events.filter(([t]) => t <= to).map(([t, e, a]) => [Math.round(t * 100) / 100, e, a]) };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!w.wd) await sleep(5);
  collect();
  /** the topmost app's canvas: a process Worker's lies under the page's system layer */
  const appCanvas = (): HTMLCanvasElement => w.wd.displayCanvases().findLast((c: HTMLCanvasElement) => c.dataset.pkg);
  /** the foreground Worker's counters and main queue */
  const app = async () => {
    const s = w.wd && await foreground();
    return s && { perf: s.perf, queued: s.main.queued };
  };
  const snapshot = async () => { const perf = (await app())?.perf; return Object.fromEntries(counters.map((k) => [k, perf?.[k] ?? 0])); };
  /** the exception of a process of the launched app (the first one started) that crashed: the launch ends with it rather than with the scenario's timeout */
  const launchCrash = async (): Promise<string | undefined> => {
    const procs: { pid: number; pkg: string; terminal?: { record?: { crash?: { exceptionClassName: string; exceptionMessage: string } } } }[] = await w.wd.workerProcesses?.() ?? [];
    const first = procs.reduce<typeof procs[number] | undefined>((a, b) => a && a.pid < b.pid ? a : b, undefined);
    const crash = procs.find((p) => p.pkg === first?.pkg && p.terminal?.record?.crash)?.terminal!.record!.crash;
    return crash && `${crash.exceptionClassName}: ${crash.exceptionMessage}`;
  };
  for (let n = 1; !((await app())?.perf.draws > 0); n++) {
    const crash = n % 100 ? undefined : await launchCrash();
    if (crash) throw new Error("the app process died while launching: " + crash);
    await sleep(5);
  }
  const firstFrame = Math.round(performance.now()), launchPerf = Object.fromEntries(Object.entries(await snapshot()).filter(([, v]) => v));
  const idle = async (maxMs = 8000) => {
    const until = performance.now() + maxMs;
    let quiet = 0, draws = (await app())!.perf.draws;
    while (performance.now() < until) {
      const now = performance.now(), state = (await app())!, cur = state.perf.draws;
      quiet = state.queued === 0 && cur === draws ? quiet || now : 0;
      if (quiet && now - quiet >= 600) return;
      draws = cur;
      await sleep(100);
    }
  };
  const presented = async () => (await app())!.perf.presentations > 0;
  for (const until = performance.now() + 60_000; !await presented();) {
    if (performance.now() > until) throw new Error("First app presentation unavailable");
    await sleep(50);
  }
  result.presentation = { firstApp: observer.firstApp };
  const renderedApp = await intended(expectedLaunch, 0, []);
  result.presentation.renderedApp = renderedApp;
  stop();
  if (renderedApp.at === null) throw new Error("Rendered app launch unavailable: " + renderedApp.error);
  await idle();
  // the launch timeline: the page's and the app Worker's marks (src/perf.ts), in ms since this navigation
  const marks = performance.getEntriesByType("mark").filter((e) => e.name.startsWith("wd:")).map((e) => `page:${e.name.slice(3)}:${Math.round(e.startTime)}`)
    .concat(((await foreground())?.marks ?? []).map(([name, at]: [string, number]) => `app:${name}:${Math.round(at - performance.timeOrigin)}`));
  result.launch = { firstFrame, firstApp: observer.firstApp, renderedApp, compileCounters: renderedApp.compileAfter, compileCounterAt: renderedApp.compileAt,
    idle: Math.round(performance.now()), perf: launchPerf, marks, demand: w.__wdDemand ? await w.wd.foregroundDemandSince([0, 0]) : undefined };
  result.processesBefore = await diagnostics();
  if (replay) result.codeReadiness = { phase: "attached", realms: [await workerReadiness(false)] };
  const screen = () => document.getElementById("screen") as HTMLCanvasElement;
  // a gesture goes to the element under its press, as the browser's hit test sends it
  let target: Element | null = null;
  const ev = (type: string, x: number, y: number) => {
    const r = screen().getBoundingClientRect(), clientX = r.left + x * r.width / 1080, clientY = r.top + y * r.height / 2160;
    if (type === "pointerdown") target = document.elementFromPoint(clientX, clientY) ?? screen();
    target!.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, isPrimary: true, bubbles: true, pointerType: "touch" }));
  };
  const out = result.taps;
  for (const s of steps) {
    if (s.wait) { await sleep(s.wait); await idle(); continue; }
    // as the e2e driver's privateStorage: without the host's pickers, a document or folder request takes the private storage
    if (s.privateStorage) { for (const name of ["showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker"]) Object.defineProperty(window, name, { value: undefined, configurable: true }); continue; }
    if (s.pick) {
      // a synthetic photo, so the picker has an image to hand the app
      const img = new OffscreenCanvas(1600, 1200), g = img.getContext("2d")!, grad = g.createLinearGradient(0, 0, 1600, 1200);
      grad.addColorStop(0, "#3a6ea5"); grad.addColorStop(1, "#f2c14e");
      g.fillStyle = grad; g.fillRect(0, 0, 1600, 1200);
      const bytes = new Uint8Array(await (await img.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("lat-picked", { create: true });
      const h = await d.getFileHandle(s.pick, { create: true }), wr = await h.createWritable();
      await wr.write(bytes); await wr.close();
      w.showOpenFilePicker = async () => [h];
      continue;
    }
    if (s.swipe) {
      const [x1, y1, x2, y2, ms] = s.swipe, n = Math.max(2, Math.round(ms / 8));
      ev("pointerdown", x1, y1);
      for (let i = 1; i <= n; i++) { await sleep(ms / n); ev("pointermove", x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n); }
      ev("pointerup", x2, y2);
      await sleep(300); await idle();
      continue;
    }
    if (s.fps) {
      // continuous scrolling for s.ms: app presentation intervals and page long tasks, no readback in the window
      const [x1, y1, x2, y2] = s.fps, long: number[] = [];
      const lt = new PerformanceObserver(list => { for (const e of list.getEntries()) long.push(e.duration); });
      try { lt.observe({ type: "longtask" }); } catch { /* not every engine reports long tasks */ }
      // only intervals within a drag count: between drags the app has nothing to draw
      const times: number[] = observer.times = [], drags: [number, number][] = [], end = performance.now() + (s.ms ?? 8000);
      for (let flip = false; performance.now() < end; flip = !flip) {
        const [ax, ay, bx, by] = flip ? [x2, y2, x1, y1] : [x1, y1, x2, y2], n = 30, from = performance.now();
        ev("pointerdown", ax, ay);
        for (let i = 1; i <= n; i++) { await sleep(8); ev("pointermove", ax + (bx - ax) * i / n, ay + (by - ay) * i / n); }
        ev("pointerup", bx, by);
        drags.push([from, performance.now()]);
        await sleep(150);
      }
      observer.times = null; lt.disconnect();
      const inDrag = (t: number) => drags.findIndex(([a, b]) => t >= a && t <= b);
      const gaps = times.slice(1).flatMap((t, i) => inDrag(t) >= 0 && inDrag(t) === inDrag(times[i]) ? [t - times[i]] : []).sort((a, b) => a - b);
      const q = (p: number) => quantile(gaps, p);
      const dragMs = drags.reduce((a, [from, to]) => a + to - from, 0), presents = times.filter(t => inDrag(t) >= 0).length;
      (result.fps ??= []).push({ m: s.name ?? "scroll", ms: s.ms ?? 8000, presents, fps: Math.round(presents / (dragMs / 1000) * 10) / 10,
        p50: q(0.5), p95: q(0.95), p99: q(0.99), over25: gaps.filter(g => g > 25).length, longTasks: long.length, longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)),
        frames: await frameReport(drags[0][0], drags.at(-1)![1]).catch(e => ({ error: String(e) })) });
      await idle();
      continue;
    }
    let [x, y] = s.tap ?? [], pressed: number[] | undefined;
    if (s.text) {
      let at = null;
      for (let tries = 0; !at && tries < 30; tries++) { at = await w.wd.locateText(s.text); if (!at) await sleep(100); }
      if (!at) throw new Error(`no text "${s.text}" on screen`);
      ({ x, y } = at); pressed = at.bounds;
    }
    const processesBefore = s.m ? await diagnostics() : undefined;
    if (s.m) {
      // nothing reaches the app between pointerdown and the window's close but the pointer itself
      const pid = appCanvas().dataset.pid ?? null, before = await snapshot(), mark = w.__wdDemand ? await w.wd.foregroundDemandMark() : null;
      watch(s.expect);
      await sleep(50);
      const longTasks: [number, number][] = [], lto = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push([e.startTime, e.duration]); });
      try { lto.observe({ type: "longtask" }); } catch { /* not every engine reports long tasks */ }
      const t0 = performance.now();
      ev("pointerdown", x, y);
      await sleep(s.hold ?? 60);
      if (w.__wdProfiling) (function __wdMarkUp() { const t = performance.now(); while (performance.now() - t < 1); })();
      const compileBefore = observer.snapshot(), tu = performance.now();
      // a trace (blink.user_timing) places the tap by this mark
      performance.mark("lat:" + s.m);
      ev("pointerup", x, y);
      // the window closes once the app has presented nothing for 800 ms
      for (let last = tu; performance.now() - last < 800 && performance.now() - t0 < 8000;) {
        await sleep(20);
        last = Math.max(last, (shots as Shot[] | null)?.at(-1)?.t ?? 0);
      }
      const compileAfter = observer.snapshot(), compileAt = performance.now(), window = unwatch();
      const topPid = appCanvas().dataset.pid ?? pid;
      const response = firstResponse(s.expect, window, tu, pressed ?? [x - 48, y - 48, x + 48, y + 48], topPid);
      window.forEach(shot => shot.crops.forEach(c => c.close()));
      const after = await snapshot(), timeline = await frameReport(t0, compileAt).catch(e => ({ error: String(e) }));
      lto.disconnect();
      const page = timeline && "raw" in timeline ? { raw: (w.wd.pageTimeline(performance.timeOrigin + t0) as number[][]).map(([t, e, a]) => [Math.round((t - performance.timeOrigin) * 100) / 100, e, a]).filter(([t]) => t <= compileAt), longTasks } : undefined;
      await idle();
      const processesAfter = await diagnostics(), nodes = await state(), demanded = mark ? await w.wd.foregroundDemandSince(mark) : undefined;
      const { last, still, ...first } = response;
      let error = first.error ?? frameError ?? null;
      if (!error && (!nodes || !w.__wdLatMatches(nodes, s.expect))) error = "the settled UI state does not match the scenario";
      if (!error && last && !pixelsMatch(s.expect, last.pixels, still?.pixels ?? [])) error = "the settled response pixels do not match the scenario";
      out.push({ intended: error ? null : first.first, response: { ...first, ...(error ? { error } : {}) }, timeline, page, semantic: { nodes, at: performance.now() },
        compileBefore, compileAfter, compileWindow: { origin: performance.timeOrigin, up: tu, end: compileAt }, m: s.m, frames: first.frames, demandMark: mark ?? undefined, demand: demanded,
        perf: Object.fromEntries(counters.map((k) => [k, Math.round((after[k] - before[k]) * 10) / 10]).filter(([, v]) => v)) as Record<string, number>, processesBefore, processesAfter });
      continue;
    }
    ev("pointerdown", x, y);
    await sleep(s.hold ?? 60);
    ev("pointerup", x, y);
    await sleep(300); await idle();
  }
  result.processesAfter = await diagnostics();
  if (save) result.codeReadiness = { phase: "saved", realms: [await workerReadiness(true)] };
  document.title = "DONE";
}})(${JSON.stringify(steps)}, ${JSON.stringify(counters)}, ${save}, ${replay}, ${JSON.stringify(expectedLaunch)}).catch(async e => {
  const result = globalThis.__wdLat; result.error = String(e);
  try { result.processesAfter = await globalThis.__wdLatRead(); } catch (error) { result.diagnosticError = String(error); }
  document.title = "DONE";
});`;

/** one headless Chrome over raw CDP, with its own profile directory */
type BrowserDriver = { context?: BrowserContext; send?: (method: string, params?: object, sessionId?: string) => Promise<any>; events?: Set<(m: any) => void>; version: string; close(): void | Promise<void> };
async function openBrowser(profile: string): Promise<BrowserDriver> {
  if (engine === "webkit") {
    const context = await webkit.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1500 }, colorScheme: "light" });
    return { context, version: context.browser()!.version(), close: () => context.close() };
  }
  const chromeLog = process.env.WEBDROID_CHROME_LOG;
  const proc = Bun.spawn([...ecores ? ["taskpolicy", "-c", "background"] : [], chromium.executablePath(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--site-per-process", "--force-device-scale-factor=1", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required",
    "--window-size=1400,1500", "--no-first-run", "--no-default-browser-check",
    ...(gpu ? ["--enable-gpu", "--use-angle=metal"] : ["--use-gl=angle", "--use-angle=swiftshader"]),
    ...(process.env.WEBDROID_JS_FLAGS ? [`--js-flags=${process.env.WEBDROID_JS_FLAGS}`] : []), ...(process.env.WEBDROID_CHROME_ARGS?.split(" ").filter(Boolean) ?? []), "about:blank"],
    // Chrome's own output (with WEBDROID_JS_FLAGS=--trace-gc, each V8 collection)
    { stdout: chromeLog ? Bun.file(chromeLog) : "ignore", stderr: chromeLog ? Bun.file(chromeLog + ".err") : "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await Bun.sleep(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { /* not yet */ }
  }
  if (!port) { proc.kill(); throw new Error("Chrome did not open a debugging port"); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 1;
  const pending = new Map<number, (m: any) => void>(), events = new Set<(m: any) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id === undefined) for (const on of events) on(m);
    else { pending.get(m.id)?.(m); pending.delete(m.id); }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, events, version: (await send("Browser.getVersion")).product, close: () => { ws.close(); proc.kill(); } };
}

async function launch(browser: BrowserDriver, apk: string, steps: unknown, expectedLaunch: Expectation, profile?: string, save = false, replay = false, trace?: string): Promise<Capture> {
  const injection = `(${installLatencyObserver.toString()})(${JSON.stringify(COUNTERS)});globalThis.__wdLatMatches=(${matchesState.toString()});${profile ? "globalThis.__wdProfiling=1;" : ""}${demand && !save ? "globalThis.__wdDemand=1;" : ""}if (location.pathname === "/") addEventListener("DOMContentLoaded", () => { ${inPage(steps, COUNTERS, save, replay, expectedLaunch)} });`;
  const url = new URL("/", BASE);
  url.search = new URLSearchParams({ ...Object.fromEntries(launchQuery), apk, screen: SCREEN }).toString();
  if (browser.context) {
    const page = await browser.context.newPage();
    try {
      await page.addInitScript(injection); await page.goto(url.href, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.title === "DONE", null, { timeout: 600_000 });
      return await page.evaluate(() => Reflect.get(globalThis, "__wdLat"));
    } catch (e) { return { ...await page.evaluate(() => Reflect.get(globalThis, "__wdLat") ?? { taps: [] }), error: String(e) }; }
    finally { await page.close(); }
  }
  const send = browser.send!;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  // as the WebKit context: a light host, whatever the machine's appearance, so a scenario's theme taps change something
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: injection }, sessionId);
  // the page and every Worker it starts, each paused until its profiler runs
  const profiled = new Map<string, string>(), instrumented = new Set<string>();
  const instrument = async (session: string, label: string) => {
    instrumented.add(session);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
    profiled.set(session, label);
    await send("Profiler.enable", {}, session); await send("Profiler.setSamplingInterval", { interval: 200 }, session); await send("Profiler.start", {}, session);
    if (heapSample) { await send("HeapProfiler.enable", {}, session); await send("HeapProfiler.startSampling", { samplingInterval: 16384 }, session); }
  };
  const attached = (m: any) => {
    if (m.method !== "Target.attachedToTarget" || !instrumented.has(m.sessionId)) return;
    const { sessionId: worker, targetInfo } = m.params, pid = new URL(targetInfo.url).searchParams.get("pid");
    void instrument(worker, pid ?? `${targetInfo.type}-${worker.slice(0, 6)}`).catch(() => {})
      .finally(() => send("Runtime.runIfWaitingForDebugger", {}, worker).catch(() => {}));
  };
  if (profile) { browser.events!.add(attached); await instrument(sessionId, ""); }
  if (trace) await send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: [...new Set([...process.env.WEBDROID_TRACE_CATEGORIES?.split(",") ?? ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "v8.execute", "gpu", "viz", "cc", "v8", "v8.wasm", "disabled-by-default-v8.gc"], "blink.user_timing"])] } });
  // a crashed page answers nothing, so the wait ends with what the page reported last
  let crashed = false;
  const crash = (m: any) => { if (m.method === "Inspector.targetCrashed" && m.sessionId === sessionId) crashed = true; };
  browser.events!.add(crash);
  await send("Inspector.enable", {}, sessionId);
  await send("Page.navigate", { url: url.href }, sessionId);
  try {
    for (const deadline = Date.now() + 600_000; Date.now() < deadline && !crashed;) {
      await Bun.sleep(500);
      const { targetInfo } = await send("Target.getTargetInfo", { targetId });
      if (targetInfo.title !== "DONE") continue;
      for (const [session, label] of profiled) {
        // a Worker that has ended may never answer
        const stopped = await Promise.race([send("Profiler.stop", {}, session).catch(() => undefined), Bun.sleep(10_000).then(() => undefined)]);
        if (stopped) await Bun.write(label ? profile!.replace(/\.cpuprofile$/, `-${label}.cpuprofile`) : profile!, JSON.stringify(stopped.profile));
        // the sampled allocations still live at the end, by allocating stack
        const heap = heapSample && await Promise.race([send("HeapProfiler.getSamplingProfile", {}, session).catch(() => undefined), Bun.sleep(10_000).then(() => undefined)]);
        if (heap) await Bun.write(profile!.replace(/\.cpuprofile$/, `${label ? "-" + label : ""}.heapprofile`), JSON.stringify(heap.profile));
      }
      if (trace) await writeTrace(browser, trace);
      const read = await send("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__wdLat)", returnByValue: true }, sessionId);
      return JSON.parse(read.result.value);
    }
    const partial = crashed ? undefined : await Promise.race([send("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__wdLat ?? {taps:[]})", returnByValue: true }, sessionId).catch(() => undefined), Bun.sleep(10_000)]);
    return { ...JSON.parse(partial?.result.value ?? '{"taps":[]}'), error: crashed ? "the page crashed" : "scenario timed out" };
  } finally { browser.events?.delete(attached); browser.events?.delete(crash); await Promise.race([send("Target.closeTarget", { targetId }).catch(() => {}), Bun.sleep(10_000)]); }
}

async function writeTrace(browser: BrowserDriver, file: string): Promise<void> {
  const done = new Promise<string>((resolve) => browser.events!.add(function on(m) {
    if (m.method === "Tracing.tracingComplete") { browser.events!.delete(on); resolve(m.params.stream); }
  }));
  await browser.send!("Tracing.end");
  // Bun's file writer does not truncate: an earlier, longer trace would leave its tail behind
  rmSync(file, { force: true });
  const handle = await done, out = Bun.file(file).writer();
  for (let eof = false; !eof;) {
    const chunk = await browser.send!("IO.read", { handle, size: 1 << 22 });
    out.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
    eof = chunk.eof;
  }
  await out.end(); await browser.send!("IO.close", { handle });
}

/** wipe app data (installs, preferences, databases, files) and keep everything else */
async function resetData(browser: BrowserDriver): Promise<void> {
  if (browser.context) {
    const page = await browser.context.newPage();
    try { await page.goto(`${BASE}/?screen=${encodeURIComponent(SCREEN)}`); await page.waitForFunction(() => !!globalThis.wd); await page.evaluate(() => globalThis.wd.reset()); }
    finally { await page.close(); }
    return;
  }
  const send = browser.send!;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  // as the WebKit context: a light host, whatever the machine's appearance, so a scenario's theme taps change something
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("DOMContentLoaded", async () => {
    while (!globalThis.wd) await new Promise((r) => setTimeout(r, 50));
    await globalThis.wd.reset(); document.title = "RESET"; });` }, sessionId);
  await send("Page.navigate", { url: `${BASE}/?screen=${encodeURIComponent(SCREEN)}` }, sessionId);
  try {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(200))
      if ((await send("Target.getTargetInfo", { targetId })).targetInfo.title === "RESET") return;
    throw new Error("reset timed out");
  } finally { await send("Target.closeTarget", { targetId }); }
}

type Report = Capture & { engine: string; browser?: string; scenario: string; apk?: string; warm: boolean; ecores: boolean; query: string; expectedTaps?: string[]; preparation?: Capture;
  accepted: false; intendedObservation: string; instrumentation: string; launchProxy: string };
const report: Report[] = [];
let failed = false;
for (const name of names) {
  const row: Report = { scenario: name, engine, warm, ecores, query: launchQuery.toString(), taps: [],
    accepted: false, intendedObservation: "first response: pointerup to the first presented app frame whose response regions depart from the pre-pointerup frame in tiles the settled frame also changed, outside the pressed view's bounds + 72 px; no guest probes between pointerdown and the settled frame; settled UI state and pixels confirmed afterwards",
    instrumentation: (engine === "chrome" ? "raw CDP Page/Target; Runtime read after capture" : "Playwright WebKit instrumentation") + "; response-region crops of every presented frame read after the window; compile counters end when the window closes",
    launchProxy: "firstFrame/perf remain root draw proxies; firstApp is visible app-owned transfer, renderedApp is scenario content after semantic receipt; compileCounters cover copied main realms and separate partial Worker receipts" };
  report.push(row);
  let profile: string | undefined, browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  const gated = gates(name);
  try {
    const { apk, steps: scenarioSteps, launch: expectedLaunch, responses } = JSON.parse(readFileSync(join(SCENARIOS, name + ".json"), "utf8"));
    const steps = scenarioSteps.map((step: any) => step.m ? { ...step, expect: responses?.[step.expect ?? step.m] } : step);
    const validExpectation = (e: Expectation | undefined) => !!e?.nodes?.length && !!e.pixels?.length;
    if (!validExpectation(expectedLaunch) || steps.some((step: any) => step.m && !validExpectation(step.expect))) throw new Error("scenario intended-state expectations missing");
    if (engine === "webkit" && (cpuProfile || traceOut)) throw new Error("WebKit profiling and tracing require a separate protocol");
    row.apk = apk; row.expectedTaps = steps.flatMap((step: { m?: string }) => step.m ? [step.m] : []);
    profile = mkdtempSync(join(tmpdir(), "wdlat-"));
    browser = await openBrowser(profile); row.browser = browser.version;
    if (warm) {
      row.preparation = await launch(browser, apk, steps, expectedLaunch, undefined, true);
      if (row.preparation.error) throw new Error("warm preparation: " + row.preparation.error);
      await resetData(browser);
    }
    Object.assign(row, await launch(browser, apk, steps, expectedLaunch, cpuProfile && `${cpuProfile.replace(/\.cpuprofile$/, "")}-${name}.cpuprofile`, false, warm,
      traceOut && `${traceOut.replace(/\.json$/, "")}-${name}.json`));
    if (row.error) throw new Error(row.error);
    const { launch: started, taps } = row;
    if (!started || taps.length !== row.expectedTaps!.length || taps.some((tap, i) => tap.m !== row.expectedTaps![i])) throw new Error("incomplete scenario capture");
    const counters = Object.entries(started.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ");
    console.log(`     ${name.padEnd(12)} ${"launch".padEnd(14)} ${String(started.firstFrame).padStart(5)} ms  idle=${started.idle} ${counters}`);
    if (timeline) for (const [realm, name, ms] of started.marks.map((m) => m.split(":")).sort((a, b) => +a[2] - +b[2])) console.log(`       ${ms.padStart(6)} ms  ${realm.padEnd(7)} ${name}`);
    for (const t of taps) {
      t.compile = compileDeltas(t.compileBefore, t.compileAfter, t.compileWindow);
      const over = t.intended === null || t.intended > LIMIT_MS || !t.compile.mainRealmCoverage;
      failed ||= over && gated;
      const detail = Object.entries(t.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
      const r = t.response, settled = r ? ` settled=${r.settled === null ? "none" : Math.round(r.settled)} frames=${r.frames} p95=${r.intervals.p95} missed=${r.intervals.missed}${r.error ? ` (${r.error})` : ""}` : "";
      console.log(`${!over ? "ok  " : gated ? "FAIL" : "over"} ${name.padEnd(12)} ${t.m.padEnd(14)} ${String(t.intended === null ? "none" : Math.round(t.intended)).padStart(5)} ms ${settled} ${detail}`);
    }
    const span = (x: any) => x ? `${x.p50}/${x.p95}/${x.max}` : "-";
    for (const f of row.fps ?? []) {
      console.log(`     ${name.padEnd(12)} ${f.m.padEnd(14)} ${String(f.fps).padStart(5)} fps p50=${f.p50} p95=${f.p95} p99=${f.p99} >25ms=${f.over25} longTasks=${f.longTasks}/${f.longTaskMs}ms`);
      const fr = f.frames;
      if (fr && !fr.error) console.log(`       frames: vsyncs=${fr.vsyncs} missed busy=${fr.missedBusy} idle=${fr.missedIdle}; p50/p95/max ms: doFrame ${span(fr.doFrame)} draw ${span(fr.draw)} composite ${span(fr.composite)} vsync→present ${span(fr.vsyncToPresent)} input→dispatch ${span(fr.inputToDispatch)} busy-at-vsync ${span(fr.busyAtVsync)}`);
    }
  } catch (e) {
    failed ||= gated;
    row.error = e instanceof Error ? e.message : String(e);
    console.log(`${gated ? "FAIL" : "fail (report)"} ${name}: ${row.error}`);
  } finally {
    await browser?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
}
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(report, null, 1));
console.log(failed ? `latency gate FAILED: a scenario failed, or a gated tap exceeded ${LIMIT_MS} ms or never responded` : `intended-response observations passed: every gated tap within ${LIMIT_MS} ms`);
process.exit(failed ? 1 : 0);
