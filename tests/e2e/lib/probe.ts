// The page-side half of the webdroid driver. `probeScript` is installed as an init script before
// any page script runs; `installProbe` is serialised into it, so it must stay self-contained and
// reach the runtime only through `globalThis.wd`.
import { stableFrame } from "./settle.ts";
import { ERROR_LINE } from "./processes.ts";
import { environmentScript, performAction } from "./actions.ts";
import type { Screen, StateCondition, UiNode, WaitPolicy } from "../types.ts";

type ProbeConfig = {
  /** the instant Date is pinned to; null runs on the wall clock */
  fixedMs: number | null;
  /** localStorage entries written before the page boots, when absent */
  storage: [string, string][];
  /** keep every distinct presented frame per step (--shots) */
  shots: boolean;
};

export type Act =
  | { type: "boot"; apk: string }
  | { type: "tap"; x: number; y: number; repeat?: number; everyMs?: number; whileText?: string; appearMs?: number; quietMs?: number; unlessResource?: string }
  | { type: "tapText"; text: string; required?: boolean }
  | { type: "type"; text: string; x?: number; y?: number }
  | { type: "back"; whileText?: string; appearMs?: number }
  | { type: "enter" }
  | { type: "background"; ms: number }
  | { type: "swipe"; from: [number, number]; to: [number, number]; ms: number; untilText?: string; maxSwipes?: number; whileText?: string; appearMs?: number }
  | { type: "none" };

export type Quiescence = {
  stableMs: number;
  intervalMs: number;
  stableFrames: number;
};

export type StepSpec = {
  act: Act;
  screen: Screen;
  wait: WaitPolicy;
  quiescence: Quiescence;
  aliveMs: number;
  capture: boolean;
  timing: "controlled" | "real";
};

/** `native`: the guest threads not parked; `stalledMs`: how long a wedged main loop took to answer (null: not within 30 s) */
export type Hang = { phase: string; afterMs: number; looper: unknown; threads: unknown; native?: unknown; stalledMs?: number | null };
/** how the wait ended, how long it took, and how many polls each reason kept it waiting */
export type Settled = { how: "idle" | "pixels" | "timeout" | "snapshot" | "state"; ms: number; busy: Record<string, number> };

export type StepResult = {
  png: string | null;
  frameHash: string | null;
  presentation: number;
  settled: Settled;
  semanticHit?: boolean;
  wedged: boolean;
  error?: string;
  /** a phase that outran its bound: where the main looper and each thread were parked then */
  hang?: Hang;
  ms: number;
  perf: Record<string, number>;
  newMissing: string[];
  newPlaceholders: string[];
  nativeRequired: string[];
  newErrors: string[];
  web: { url: string | null; title: string; loaded: boolean }[];
  uiTree: UiNode[];
  frames: string[];
  phases: {
    actionMs: number;
    settleMs: number;
    livenessMs: number;
    captureMs: number;
    telemetryMs: number;
  };
};

export const DEFAULT_QUIESCENCE: Quiescence = { stableMs: 150, intervalMs: 250, stableFrames: 4 };
export const PHASE_BOUND_MS = 30_000;

/** Includes real live dwell even when the virtual clock is controlled. */
export function waitBudget(wait: WaitPolicy): { actionMs: number; settleMs: number } {
  const actionMs = wait.kind === "live" || wait.kind === "live-sample" ? wait.timeoutMs : wait.maxRealMs;
  const horizonMs = wait.kind === "live" ? wait.horizonMs : wait.kind === "live-sample" ? wait.atRealMs : 0;
  return { actionMs, settleMs: horizonMs + actionMs + PHASE_BOUND_MS };
}

/** A host envelope for the existing page phases; it does not change their budgets. */
export function stepDeadlineMs(spec: StepSpec): number {
  const { actionMs, settleMs } = waitBudget(spec.wait), a = spec.act;
  let calls = 1, dwell = 0;
  if (a.type === "tap") {
    if (a.whileText) {
      calls = 2;
      dwell = (a.appearMs ?? 0) + Math.max(1500, (a.repeat ?? 1) * (a.everyMs ?? 500) + 400 + (a.quietMs ?? 400));
    }
    else { calls = a.repeat ?? 1; dwell = Math.max(0, calls - 1) * (a.everyMs ?? 500); }
    if (a.unlessResource) calls++;
  } else if (a.type === "back" && a.whileText) { calls = 2; dwell = (a.appearMs ?? 0) + 1500; }
  else if (a.type === "swipe" && a.whileText) { calls = 2; dwell = (a.appearMs ?? 0) + Math.max(1500, (a.maxSwipes ?? 1) * (a.ms + 500) + 800); }
  else if (a.type === "swipe") {
    calls = (a.maxSwipes ?? 1) * (a.untilText ? 2 : 1);
    dwell = (a.maxSwipes ?? 1) * (a.ms + (a.untilText ? 500 : 0));
  }
  else if (a.type === "tapText") calls = 2;
  else if (a.type === "background") dwell = a.ms;
  else if (a.type === "type") { calls = a.x === undefined ? 1 : 3; dwell = 250; }
  // Worker reads, capture, UI dump, wedged liveness and bounded hang diagnostics.
  return calls * actionMs + dwell + settleMs + spec.aliveMs + 6 * PHASE_BOUND_MS;
}

declare global {
  var wd: any;
  var __wd: {
    step(spec: StepSpec): Promise<StepResult>;
    /** the shown display as a base64 PNG: every shown canvas, from its latest mirrored frame */
    screen(): Promise<string>;
  };
}

function installProbe(cfg: ProbeConfig): void {
  if (self !== top) return;
  const g = globalThis as any;

  const rawSetTimeout = g.setTimeout.bind(g), rawClearTimeout = g.clearTimeout.bind(g);
  const timers = new Map<number, number>();
  g.setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...a: unknown[]) => {
    const id: number = rawSetTimeout(() => { timers.delete(id); fn(...a); }, ms);
    timers.set(id, performance.now() + ms);
    return id;
  };
  g.clearTimeout = (id: number) => { timers.delete(id); rawClearTimeout(id); };
  const sleep = (ms: number) => new Promise<void>((r) => rawSetTimeout(r, ms));

  let inflight = 0;
  const track = <T>(p: Promise<T>): Promise<T> => { inflight++; return p.finally(() => inflight--); };
  const rawFetch = g.fetch.bind(g);
  g.fetch = (...a: unknown[]) => track(rawFetch(...a));
  const rawCib = g.createImageBitmap.bind(g);
  g.createImageBitmap = (...a: unknown[]) => track(rawCib(...a));
  if (g.ImageDecoder) {
    const rawDecode = g.ImageDecoder.prototype.decode;
    g.ImageDecoder.prototype.decode = function (...a: unknown[]) { return track(rawDecode.apply(this, a)); };
  }
  // a relay socket is awaiting while it has sent more recently than it received: a reply is
  // pending work with no due time, and every Java or native socket rides the relay
  const sockets = new Set<WebSocket & { sent: number; recv: number }>();
  const RawWS = g.WebSocket;
  g.WebSocket = class extends RawWS {
    sent = 0; recv = 0;
    constructor(...a: unknown[]) {
      super(...a);
      sockets.add(this as any);
      this.addEventListener("message", () => { this.recv = performance.now(); });
      this.addEventListener("close", () => sockets.delete(this as any));
      this.addEventListener("error", () => sockets.delete(this as any));
    }
    send(d: unknown) { this.sent = performance.now(); super.send(d); }
  };
  const awaitingSockets = () => { let n = 0; for (const s of sockets) if (s.readyState === 0 || s.sent > s.recv) n++; return n; };

  const mirrored = new Map<HTMLCanvasElement, ImageBitmap>();
  const displayCanvases = (): HTMLCanvasElement[] => g.wd?.displayCanvases?.() ?? [document.getElementById("screen") as HTMLCanvasElement];
  let scratch: OffscreenCanvas | null = null, scratchCtx: OffscreenCanvasRenderingContext2D | null = null;
  const readDisplay = (canvases: HTMLCanvasElement[]): ImageData => {
    const { width, height } = canvases.at(-1)!;
    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch = new OffscreenCanvas(width, height);
      scratchCtx = scratch.getContext("2d", { willReadFrequently: true })!;
    }
    scratchCtx!.clearRect(0, 0, width, height);
    for (const canvas of canvases) scratchCtx!.drawImage(mirrored.get(canvas) ?? canvas, 0, 0, width, height);
    return scratchCtx!.getImageData(0, 0, width, height);
  };
  const hashOf = (img: ImageData): number => {
    const d = new Uint32Array(img.data.buffer);
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
    return h >>> 0;
  };
  const encode = async (img: ImageData): Promise<string> => {
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d", { willReadFrequently: true })!.putImageData(img, 0, 0);
    const buf = await (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
    let s = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
    return btoa(s);
  };

  let lastPresent = 0, presentation = 0, wantSample = false, lastHash = -1, readbackMs = 0;
  const sampled = new Map<number, ImageData>();
  const shots: ImageData[] = [];
  let shotHash = -1, shooting = false;
  const presentWaiters: (() => void)[] = [];
  // a process Worker presents into its canvas off the page, and mirrors each frame here (src/shell/frame-port.ts)
  globalThis.__wdPresented = (canvas: HTMLCanvasElement, copy: ImageBitmap | null, at: number) => {
    if (copy) { mirrored.get(canvas)?.close(); mirrored.set(canvas, copy); }
    for (const [shown, image] of mirrored) if (!shown.isConnected) { image.close(); mirrored.delete(shown); }
    const canvases = displayCanvases();
    if (!canvases.includes(canvas)) return;
    lastPresent = at;
    presentation++;
    if (wantSample || shooting) {
      const start = performance.now(), img = readDisplay(canvases);
      const h = hashOf(img);
      readbackMs = performance.now() - start;
      if (wantSample) {
        wantSample = false;
        lastHash = h;
        sampled.set(h, img);
        if (sampled.size > 4) sampled.delete(sampled.keys().next().value!);
      }
      if (shooting && h !== shotHash && shots.length < 240) { shotHash = h; shots.push(img); }
    }
    for (const w of presentWaiters.splice(0)) w();
  };
  const nextPresent = (ms: number) => new Promise<boolean>((r) => {
    const id = rawSetTimeout(() => { const i = presentWaiters.indexOf(ok); if (i >= 0) presentWaiters.splice(i, 1); r(false); }, ms);
    const ok = () => { rawClearTimeout(id); r(true); };
    presentWaiters.push(ok);
  });
  const screenPng = () => encode(readDisplay(displayCanvases()));

  const foreground = () => g.wd.foregroundWorkerSnapshot?.() ?? Promise.resolve(null);
  type Foreground = Awaited<ReturnType<typeof foreground>>;
  /** the step's counters: a foreground Worker's, less what it had counted when the step began */
  let stepStart: Foreground = null;
  const stepPerf = (worker: Foreground): Record<string, number> => {
    const snapshot = worker?.snapshot;
    if (!snapshot) return { ...g.wd.perf };
    const previous = stepStart?.pid === worker.pid ? stepStart?.snapshot?.perf : undefined;
    return { ...Object.fromEntries(Object.entries(snapshot.perf).map(([name, value]) => [name, (value as number) - (previous?.[name] ?? 0)])),
      bootMs: g.wd.perf.bootMs };
  };
  const usesPerf = (condition: StateCondition): boolean =>
    condition.kind === "perf" || (condition.kind === "all" || condition.kind === "any") && condition.conditions.some(usesPerf);
  const busy = async (dueBefore: number, stableMs: number): Promise<string[]> => {
    const now = performance.now();
    const wd = g.wd, d = wd.mainDbg;
    const r: string[] = [];
    if (d.depth > 0) r.push("job:" + d.phase);
    if (d.queued > 0) r.push("queued");
    if (wd.vsyncScheduled?.()) r.push("vsync");
    if (wd.pendingTransitions?.()) r.push("transition");
    if (wd.processStarting?.()) r.push("starting");
    if (wd.yields.pending()) r.push("yields");
    const worker = await foreground();
    if (worker) {
      const snapshot = worker.snapshot;
      if (worker.error || !snapshot) r.push("queued");
      else {
        if (snapshot.main.depth > 0) r.push("job:" + snapshot.main.phase);
        if (snapshot.main.queued > 0) r.push("queued");
        if (snapshot.vsyncScheduled) r.push("vsync");
        if (snapshot.pendingTransitions) r.push("transition");
        if (snapshot.yields.pending) r.push("yields");
      }
    }
    if (inflight) r.push("inflight");
    if (awaitingSockets()) r.push("sockets");
    const due = Math.max(dueBefore, now + stableMs);
    for (const [id, at] of timers) if (at <= due && !wd.timedParks.has(id)) { r.push("timers"); break; }
    if (now - lastPresent < stableMs) r.push("presented");
    return r;
  };

  let captured: ImageData | null = null;
  const inScreen = (node: UiNode, screen: Screen) =>
    node.bounds[2] > 0 && node.bounds[3] > 0 && node.bounds[0] < screen.width && node.bounds[1] < screen.height;
  const stateMatches = (condition: StateCondition, screen: Screen, nodes: UiNode[], perf: Record<string, number>): boolean => {
    if (condition.kind === "all" || condition.kind === "any") {
      const matches = condition.conditions.map((item) => stateMatches(item, screen, nodes, perf));
      return condition.kind === "all" ? matches.every(Boolean) : matches.some(Boolean);
    }
    if (condition.kind === "perf") return (perf[condition.counter] ?? 0) >= condition.atLeast;
    if (condition.kind === "resource" || condition.kind === "resource-absent") {
      const found = nodes.some((node) => node.resId === condition.resId && inScreen(node, screen));
      return condition.kind === "resource" ? found : !found;
    }
    const want = condition.text.replace(/\s+/g, " ").trim().toLowerCase();
    const found = nodes.some((node) =>
      (!condition.resId || node.resId === condition.resId) && (!condition.visible || inScreen(node, screen)) &&
      [node.text, node.desc].some((text) => text.replace(/\s+/g, " ").trim().toLowerCase().includes(want)));
    return condition.kind === "text" ? found : !found;
  };
  const WORKING = new Set(["queued", "transition", "starting"]);
  const settle = async (policy: WaitPolicy, controlled: boolean, q: Quiescence, capture: boolean, screen: Screen): Promise<Settled> => {
    const t0 = performance.now();
    captured = null;
    const done = (how: Settled["how"], busy: Record<string, number> = {}): Settled => {
      wantSample = false;
      return { how, ms: performance.now() - t0, busy };
    };
    const samplePresentation = async (): Promise<boolean> => {
      const before = presentation;
      wantSample = true;
      g.wd.redraw();
      if (controlled) await g.wd.testFrame();
      else if (!await nextPresent(500)) { wantSample = false; return false; }
      captured = sampled.get(lastHash) ?? null;
      wantSample = false;
      return presentation > before;
    };
    if (policy.kind === "state" || policy.kind === "live" && policy.condition) {
      const condition = policy.condition!;
      const maxRealMs = policy.kind === "state" ? policy.maxRealMs : policy.horizonMs + policy.timeoutMs;
      const maxVirtualMs = policy.kind === "state" ? policy.maxVirtualMs : 0;
      const stableMs = policy.kind === "state" ? policy.stableMs : 0;
      const virtualEnd = (g.wd.guestClock?.now() ?? 0) + maxVirtualMs;
      let matchedAt = 0;
      for (;;) {
        const now = performance.now();
        const perf = usesPerf(condition) ? stepPerf(await foreground()) : g.wd.perf;
        const matches = stateMatches(condition, screen, await g.wd.uiTree(), perf);
        if (matches) {
          matchedAt ||= now;
          if (now - matchedAt >= stableMs) break;
        } else matchedAt = 0;
        if (performance.now() - t0 >= maxRealMs) return done("timeout", { state: 1 });
        const next = controlled ? g.wd.guestClock.nextDeadline() : null;
        if (controlled && g.wd.guestClock.now() < virtualEnd) {
          await g.wd.guestClock.advanceTo(Math.min(virtualEnd, next ?? g.wd.guestClock.now() + 16));
          await g.wd.testFrame();
        } else await sleep(10);
      }
      const alive = controlled
        ? await g.wd.guestClock.drive(g.wd.alive(maxRealMs), maxVirtualMs)
        : await g.wd.alive(maxRealMs);
      if (!alive) return done("timeout", { queued: 1 });
      if (!capture) return done("state");
      return await samplePresentation() ? done("state") : done("timeout", { presentation: 1 });
    }
    if (policy.kind === "sample" || policy.kind === "live-sample") {
      if (policy.kind === "sample" && controlled) {
        await g.wd.guestClock.advanceBy(policy.atVirtualMs);
        if (policy.minRealMs) await sleep(policy.minRealMs);
      } else await sleep(policy.kind === "sample" ? policy.atVirtualMs : policy.atRealMs);
      if (!capture) return done("snapshot");
      wantSample = true;
      if (controlled) {
        await g.wd.testFrame();
        captured = sampled.get(lastHash) ?? null;
      } else {
        if (await nextPresent(500)) captured = sampled.get(lastHash) ?? null;
      }
      return done("snapshot");
    }
    const horizonMs = policy.kind === "quiescent" ? policy.maxVirtualMs : policy.horizonMs;
    const timeoutMs = policy.kind === "quiescent" ? policy.maxRealMs : policy.timeoutMs;
    // the pixel rule needs stableFrames + 1 samples past the horizon before it can settle, so
    // anything scheduled inside that window was always waited for: a toast timing out, a
    // snackbar dismissing, a list's click after its pressed state. The fast path keeps that
    // contract, and a controlled clock runs through the window as a real one would.
    const windowMs = (q.stableFrames + 1) * q.intervalMs;
    if (controlled) await g.wd.guestClock.advanceBy(horizonMs + windowMs);
    // a ripple or transition runs well inside two seconds; a spinner stops at the bound
    const animationEnd = controlled ? g.wd.guestClock.now() + 2000 : 0;
    const horizonAt = t0 + (controlled ? 0 : horizonMs);
    const dueBefore = horizonAt + windowMs;
    // the pixel rule samples only past the horizon, as the recorder does past its dwell
    const hashes: number[] = [];
    let activeSince = 0;
    const seen: Record<string, number> = {};
    let lastSample = horizonAt - q.intervalMs, interval = q.intervalMs;
    lastHash = -1;
    for (;;) {
      const now = performance.now();
      if (now - lastSample >= interval) {
        lastSample = now;
        if (now > horizonAt) hashes.push(lastHash);
        if (hashes.length > q.stableFrames * 2) hashes.shift();
        wantSample = true;
        if (lastHash < 0) g.wd.redraw();
        // each sample is a synchronous GPU readback. Under SwiftShader one waits seconds for an animating
        // app's backlog of frames, on the page's thread, where the broker answers the app's IPC: what a
        // readback takes beyond a few frames is kept to a fifth of the thread. A screen whose every
        // sample differs (a spinner) is sampled less often until a frame repeats
        interval = Math.max(4 * (readbackMs - 150), hashes.length === q.stableFrames * 2 && new Set(hashes).size === hashes.length ? Math.min(interval * 2, 1000) : q.intervalMs);
      }
      const b = await busy(dueBefore, q.stableMs);
      if (!b.length) return done("idle", seen);
      for (const k of b) seen[k] = (seen[k] ?? 0) + 1;
      // an animation the app started after the clock ran through the window (a slow tap's ripple)
      // would stay at its first frame and ask for frames forever: time passes while frames are asked
      // for, four display frames a sample, since only where the animation ends is captured. A
      // frame's request for the next waits for time, so past the bound this steps the frame, which
      // also draws what came in meanwhile
      if (controlled && b.includes("vsync")) {
        if (g.wd.guestClock.now() < animationEnd) await g.wd.guestClock.advanceTo(Math.min(animationEnd, g.wd.guestClock.now() + 64));
        await g.wd.testFrame();
      }
      // a still screen settles past timers and network, not past work under way: a main-thread job
      // or its queue (its result is not drawn yet), an activity start or finish or a process start,
      // nor on a real clock during the first 1.5 s of frames scheduled or threads running (a fling's
      // overscroll stretch changes no pixels; a background thread's result is not shown yet). A
      // controlled clock has already run through the window, and a loop that keeps going without
      // changing the screen (a paused game) is still.
      activeSince = b.includes("vsync") || b.includes("yields") ? activeSince || now : 0;
      const working = b.some((k) => k.startsWith("job:") || WORKING.has(k)) ||
        (!controlled && activeSince > 0 && now - activeSince < 1500);
      const h = working ? undefined : stableFrame(hashes, q.stableFrames);
      if (h !== undefined && h >= 0) { captured = sampled.get(h) ?? null; return done("pixels", seen); }
      if (now - t0 >= timeoutMs + (controlled ? 0 : horizonMs)) return done("timeout", seen);
      await sleep(25);
    }
  };
  const capture = () => captured ? encode(captured) : screenPng();

  const act = (a: Act, screen: Screen, deadlineMs: number, controlled = false) => performAction({ a, screen, deadlineMs, controlled });
  const seen = { missing: new Set<string>(), placeholders: new Set<string>(), native: new Set<string>(), errors: new Set<string>() };
  const fresh = (key: keyof typeof seen, all: string[]): string[] => {
    const unique = new Set(all);
    const out = [...unique].filter((x) => !seen[key].has(x));
    seen[key] = unique;
    return out;
  };
  // a phase that can wait on the main looper (settle's test frames, the UI dump) past this bound
  // records the looper and the threads, then the step goes on without it
  const bounded = async <T>(phase: string, work: Promise<T>, ms: number, fallback: T, hangs: Hang[]): Promise<T> => {
    let id = 0;
    const late = new Promise<"late">((r) => { id = rawSetTimeout(() => r("late"), ms); });
    const out = await Promise.race([work, late]).finally(() => rawClearTimeout(id));
    if (out !== "late") return out as T;
    hangs.push(await hangOf(phase, ms));
    return fallback;
  };
  const hangOf = async (phase: string, afterMs: number): Promise<Hang> => {
    const within = <U>(p: Promise<U>) => Promise.race([p, new Promise<string>((r) => rawSetTimeout(() => r("no answer in 3 s"), 3000))]);
    const native = g.wd.native?.regs?.().filter((c: { state: string }) => c.state && c.state !== "park").map((c: { name: string; pc: string }) => `${c.name} ${c.pc}`);
    const worker = await within(Promise.resolve().then(foreground)).catch(String);
    const looper = await within(Promise.resolve().then(() => g.wd.looperDump())).catch(String);
    return { phase, afterMs, looper: worker ? { root: looper, worker } : looper, threads: g.wd.threads?.(), native };
  };
  const step = async (spec: StepSpec): Promise<StepResult> => {
    const wd = g.wd, hangs: Hang[] = [];
    wd.mirrorFrames(true);
    stepStart = await foreground();
    wd.perfReset();
    shots.length = 0; shotHash = -1; shooting = cfg.shots;
    const t0 = performance.now();
    let semanticHit: boolean | undefined, error: string | undefined;
    const actionAt = performance.now();
    try {
      const { actionMs: maxActionMs } = waitBudget(spec.wait);
      semanticHit = await act(spec.act, spec.screen, maxActionMs, spec.timing === "controlled");
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    const actionMs = performance.now() - actionAt;
    const controlled = spec.timing === "controlled";
    const { settleMs: settleBound } = waitBudget(spec.wait);
    const settled = await bounded("settle", settle(spec.wait, controlled, spec.quiescence, spec.capture, spec.screen), settleBound,
      { how: "timeout", ms: settleBound, busy: { hang: 1 } } as Settled, hangs);
    const aliveAt = performance.now();
    const alive = wd.alive(spec.aliveMs);
    const wedged = !(controlled ? await wd.guestClock.drive(alive, spec.aliveMs) : await alive);
    const livenessMs = performance.now() - aliveAt;
    // a wedged main loop: where its threads are, then how long until it answers
    if (wedged && !controlled) {
      const hang = await hangOf("alive", spec.aliveMs), from = performance.now();
      hang.stalledMs = await wd.alive(30_000) ? Math.round(performance.now() - from + spec.aliveMs) : null;
      hangs.unshift(hang);
    }
    shooting = false;
    const captureAt = performance.now();
    const png = spec.capture ? await bounded("capture", capture(), PHASE_BOUND_MS, null, hangs) : null;
    const frames: string[] = [];
    for (const f of shots) frames.push(await encode(f));
    const captureMs = performance.now() - captureAt;
    const telemetryAt = performance.now();
    const uiTree: UiNode[] = await bounded("uiTree", wd.uiTree(), PHASE_BOUND_MS, [], hangs);
    const worker = await foreground(), snapshot = worker?.snapshot, counters = stepPerf(worker);
    const workerErrors = worker?.error ? ["error: Worker diagnostics: " + worker.error] : snapshot?.logs ?? [];
    const result = {
      png, frameHash: lastHash < 0 ? null : lastHash.toString(16).padStart(8, "0"), presentation,
      settled, semanticHit, wedged, error, hang: hangs[0],
      perf: counters,
      newMissing: fresh("missing", [...wd.rt.missing, ...snapshot?.missing ?? []]),
      newPlaceholders: fresh("placeholders", [...wd.rt.placeholders, ...snapshot?.placeholders ?? []]),
      nativeRequired: fresh("native", [...wd.nativeRequirements(), ...snapshot?.nativeRequired ?? []]),
      newErrors: fresh("errors", [...wd.logs as string[], ...workerErrors].filter((l) => ERROR_LINE.test(l))),
      web: [...wd.web() as StepResult["web"], ...snapshot?.web ?? []].map(({ url, title, loaded }) => ({ url, title, loaded })),
      uiTree,
      frames,
    };
    const telemetryMs = performance.now() - telemetryAt;
    return { ...result, ms: performance.now() - t0,
      phases: { actionMs, settleMs: settled.ms, livenessMs, captureMs, telemetryMs } };
  };
  g.__wd = { step, screen: screenPng };
}

/** The init script: the stability rule and the probe, installed with the flow's configuration. */
export const probeScript = (cfg: ProbeConfig): string =>
  `${environmentScript(cfg)}; (() => { ${stableFrame.toString()}; ${performAction.toString()}; const PHASE_BOUND_MS=${PHASE_BOUND_MS}; const ERROR_LINE=${ERROR_LINE}; ${waitBudget.toString()}; (${installProbe.toString()})(${JSON.stringify(cfg)}); })();`;
