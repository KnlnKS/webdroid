// What a lat launch runs in its page. run.ts bundles this as one script and injects it before every document of the launch, after
// globalThis.__wdLatConfig (and __wdProfiling, __wdDemand): it installs the presentation observer, and once the app page has loaded drives the
// scenario, leaves the capture in globalThis.__wdLat and sets document.title to DONE.
import { installLatencyObserver } from "./observe.ts";
import { compileDeltas, matchesState, type Expectation } from "./expect.ts";
import type { Ev } from "../../src/timeline.ts";
import { ERROR_LINE, pageDiagnostics } from "../../tests/e2e/lib/processes.ts";

/** what run.ts hands a launch's page: `steps` are the scenario's (scripts/lat/scenarios); `E` is the timeline's events, passed rather than
 *  imported so the bundle leaves out the timeline's ring */
export type LatConfig = { steps: any[]; counters: string[]; save: boolean; replay: boolean; expectedLaunch: Expectation; E: typeof Ev };
type UiNodes = Parameters<typeof matchesState>[0];

/** the first-response clock: pointerup to the first answering frame and to the frame the response settled in,
 *  with the presentation intervals between them */
export type First = { first: number | null; settled: number | null; frames: number; changedTiles: number; maskedTiles: number; pid: string | null;
  intervals: { p50: number | null; p95: number | null; max: number | null; missed: number }; error?: string };
export type Tap = { intended: number | null; response?: First; timeline?: { answer?: { busy: number; frame: number }; error?: string }; page?: unknown; semantic: unknown; compileBefore: any[]; compileAfter: any[]; compileWindow: { origin: number; up: number; end: number | null }; compile?: ReturnType<typeof compileDeltas>; m: string; frames: number; perf: Record<string, number>; processesBefore: unknown; processesAfter: unknown; demandMark?: number[]; demand?: [string, boolean, boolean, boolean][] | null };
/** Root draw proxy and realm presentation marks; compile counters below still belong to the root. */
export type Launch = { demand?: [string, boolean, boolean, boolean][] | null; firstApp: unknown; renderedApp: unknown; compileCounters: any[]; compileCounterAt: number; firstFrame: number;
  idle: number; perf: Record<string, number>; marks: string[]; timeline: number[][] };
export type Fps = { m: string; ms: number; presents: number; fps: number; p50: number | null; p95: number | null; p99: number | null; over25: number; longTasks: number; longTaskMs: number; frames?: any };
/** what the page read of its own realm and of every process Worker */
export type Diagnostics = { at: number; frames: ({ url: string } & ReturnType<typeof pageDiagnostics>)[]; workers: { snapshot?: { logs: string[] }; error?: string }[] };
export type Capture = { launch?: Launch; taps: Tap[]; fps?: Fps[]; processesBefore?: Diagnostics; processesAfter?: Diagnostics;
  presentation?: { firstApp: unknown; renderedApp?: unknown };
  codeReadiness?: { phase: "saved" | "attached"; realms: unknown[] }; error?: string };

const w = globalThis as any;
const { steps, counters, save, replay, expectedLaunch, E }: LatConfig = w.__wdLatConfig;
installLatencyObserver(counters);

async function run() {
  const result: Capture = w.__wdLat = { taps: [] };
  // a process Worker's state reaches the page over its control port
  const foreground = async () => (await w.wd.foregroundWorkerSnapshot())?.snapshot ?? null;
  const diagnostics = w.__wdLatRead = async () => {
    let workers;
    try { workers = w.wd?.workerProcesses ? await w.wd.workerProcesses() : []; }
    catch (error) { workers = [{ error: String(error) }]; }
    return { at: performance.now(), frames: [{ url: location.href, aotKey: globalThis.__wdWasm?.aotKey ?? null, ...pageDiagnostics(ERROR_LINE.source) }], workers };
  };
  const workerReadiness = async (save: boolean) => {
    const code = await w.wd.foreground()?.codeReadiness(save);
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
          if (nodes && matchesState(nodes as UiNodes, expectation)) stateAt ??= performance.now(); else stateAt = null;
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
   * presented nothing while the app was drawing, by whether the main looper was busy at it. Between a tap's pointerup and its answering frame
   * (`answer`), how long the looper was busy and its longest doFrame: the development metric, the Java and rendering work of the frame the tap waited
   * for, on the Worker's clock without the presentation's jitter.
   */
  const frameReport = async (from: number, to: number, answer?: [number, number]) => {
    const events: [number, number, number][] = ((await w.wd.foreground()?.timeline(performance.timeOrigin + from)) ?? []).map(([t, e, a]: number[]) => [t - performance.timeOrigin, e, a]);
    const spans = { doFrame: [] as number[], draw: [] as number[], composite: [] as number[], vsyncToPresent: [] as number[], inputToDispatch: [] as number[], busyAtVsync: [] as number[] };
    // doFrames by their frame number: the next one can begin before the last one's end is noted
    const frames = new Map<number, number>();
    let raf = -1, draw = -1, comp = -1, idle = true, wake = from, input = -1, presentedSince = true, drawing = false, missedBusy = 0, missedIdle = 0, vsyncs = 0;
    let busy = 0, longest = 0;
    const answering = (a: number, b: number) => answer ? Math.max(0, Math.min(b, answer[1]) - Math.max(a, answer[0])) : 0;
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
        case E.FrameBegin: frames.set(a, t); drawing = true; break;
        case E.FrameEnd: {
          const begun = frames.get(a);
          if (begun === undefined) break;
          spans.doFrame.push(t - begun);
          if (answer && begun >= answer[0] && t <= answer[1]) longest = Math.max(longest, t - begun);
          frames.delete(a); break;
        }
        case E.DrawBegin: draw = t; drawing = true; break;
        case E.DrawEnd: if (draw >= 0) spans.draw.push(t - draw); draw = -1; break;
        case E.CompositeBegin: comp = t; break;
        case E.CompositeEnd: if (comp >= 0) spans.composite.push(t - comp); comp = -1; break;
        case E.Present: if (raf >= 0) spans.vsyncToPresent.push(t - raf); presentedSince = true; break;
        case E.LoopIdle: if (!idle) busy += answering(wake, t); idle = true; drawing = frames.size > 0; break;
        case E.LoopWake: idle = false; wake = t; break;
      }
    }
    if (!idle) busy += answering(wake, to);
    const stat = (xs: number[]) => {
      if (!xs.length) return null;
      const s = xs.slice().sort((a, b) => a - b), q = (p: number) => quantile(s, p);
      return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) };
    };
    return { vsyncs, missedBusy, missedIdle, events: events.length, ...Object.fromEntries(Object.entries(spans).map(([k, v]) => [k, stat(v)])),
      ...(answer ? { answer: { busy: Math.round(busy * 10) / 10, frame: Math.round(longest * 10) / 10 } } : {}),
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
  // the Worker's timeline up to the first frame, as far back as its ring holds
  const launchTimeline = ((await w.wd.foreground()?.timeline(performance.timeOrigin) ?? []) as number[][]).map(([t, e, a]) => [Math.round((t - performance.timeOrigin) * 100) / 100, e, a]);
  /** waits for 600 ms with nothing drawn or queued, no thread but the main one running Java, and no main-looper message due within a second: an app's
   *  background work and its own clock (an animation scheduled after a dialog closes) can still change the screen under a tap */
  const idle = async (maxMs = 8000) => {
    const until = performance.now() + maxMs;
    let quiet = 0, draws = (await app())!.perf.draws, seen = performance.now(), due = Infinity;
    while (performance.now() < until) {
      const now = performance.now(), state = (await app())!, cur = state.perf.draws;
      let background = false;
      for (const [t, e, a] of (await w.wd.foreground()?.timeline(performance.timeOrigin + seen) ?? []) as number[][]) {
        if (e === E.Thread && a >= 2) background = true;
        else if (e === E.LoopIdle) due = a > 0 ? t - performance.timeOrigin + a : Infinity;
        else if (e === E.LoopWake) due = Infinity;
      }
      seen = now;
      quiet = state.queued === 0 && cur === draws && !background && due - now > 1000 ? quiet || now : 0;
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
    idle: Math.round(performance.now()), perf: launchPerf, marks, demand: w.__wdDemand ? (await w.wd.foreground()?.demandSince([0, 0])) ?? null : undefined, timeline: launchTimeline };
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
    if (s.back) { await w.wd.back(); await sleep(300); await idle(); continue; }
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
      const pid = appCanvas().dataset.pid ?? null, before = await snapshot(), mark = w.__wdDemand ? (await w.wd.foreground()?.demandMark()) ?? null : null;
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
      const after = await snapshot(), timeline = await frameReport(t0, compileAt, response.first === null ? undefined : [tu, tu + response.first]).catch(e => ({ error: String(e) }));
      lto.disconnect();
      const page = timeline && "raw" in timeline ? { raw: (await w.wd.page.timeline(performance.timeOrigin + t0) as number[][]).map(([t, e, a]) => [Math.round((t - performance.timeOrigin) * 100) / 100, e, a]).filter(([t]) => t <= compileAt), longTasks } : undefined;
      await idle();
      const processesAfter = await diagnostics(), nodes = await state(), demanded = mark ? (await w.wd.foreground()?.demandSince(mark)) ?? null : undefined;
      const { last, still, ...first } = response;
      let error = first.error ?? frameError ?? null;
      if (!error && (!nodes || !matchesState(nodes as UiNodes, s.expect))) error = "the settled UI state does not match the scenario";
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
}
if (location.pathname === "/") addEventListener("DOMContentLoaded", () => run().catch(async e => {
  const result = w.__wdLat; result.error = String(e);
  try { result.processesAfter = await w.__wdLatRead(); } catch (error) { result.diagnosticError = String(error); }
  document.title = "DONE";
}));
