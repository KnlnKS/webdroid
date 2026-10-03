// The page-side half of the webdroid driver. `probeScript` is installed as an init script before
// any page script runs; `installProbe` is serialised into it, so it must stay self-contained and
// reach the runtime only through `globalThis.wd`.
import { stableFrame } from "./settle";
import { environmentScript, performAction } from "./actions";
import type { Screen, StateCondition, UiNode, WaitPolicy } from "../types";

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
  | { type: "tap"; x: number; y: number; repeat?: number; everyMs?: number; whileText?: string; appearMs?: number; unlessResource?: string }
  | { type: "tapText"; text: string; fallback?: { x: number; y: number } }
  | { type: "type"; text: string; x?: number; y?: number }
  | { type: "back" }
  | { type: "enter" }
  | { type: "background"; ms: number }
  | { type: "swipe"; from: [number, number]; to: [number, number]; ms: number; untilText?: string; maxSwipes?: number }
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

export type Hang = { phase: string; afterMs: number; looper: unknown; threads: unknown };
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
export const DEFAULT_ACTION_TIMEOUT_MS = 20_000;

declare global {
  var wd: any;
  var __wd: {
    step(spec: StepSpec): Promise<StepResult>;
    act(a: Act, screen: Screen, deadlineMs: number): Promise<boolean | undefined>;
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

  const screen = () => document.getElementById("screen") as HTMLCanvasElement;
  let scratch: OffscreenCanvas | null = null, scratchCtx: OffscreenCanvasRenderingContext2D | null = null;
  const readBitmap = (bmp: ImageBitmap): ImageData => {
    if (!scratch || scratch.width !== bmp.width || scratch.height !== bmp.height) {
      scratch = new OffscreenCanvas(bmp.width, bmp.height);
      scratchCtx = scratch.getContext("2d", { willReadFrequently: true })!;
    }
    scratchCtx!.drawImage(bmp, 0, 0);
    return scratchCtx!.getImageData(0, 0, bmp.width, bmp.height);
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

  let lastPresent = 0, presentation = 0, wantSample = false, lastHash = -1;
  const sampled = new Map<number, ImageData>();
  const shots: ImageData[] = [];
  let shotHash = -1, shooting = false;
  const presentWaiters: (() => void)[] = [];
  const rawTransfer = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bmp: ImageBitmap | null) {
    lastPresent = performance.now();
    presentation++;
    if (bmp && this.canvas === screen() && (wantSample || shooting)) {
      const img = readBitmap(bmp);
      const h = hashOf(img);
      if (wantSample) {
        wantSample = false;
        lastHash = h;
        sampled.set(h, img);
        if (sampled.size > 4) sampled.delete(sampled.keys().next().value!);
      }
      if (shooting && h !== shotHash && shots.length < 240) { shotHash = h; shots.push(img); }
    }
    for (const w of presentWaiters.splice(0)) w();
    return rawTransfer.call(this, bmp);
  };
  const nextPresent = (ms: number) => new Promise<boolean>((r) => {
    const id = rawSetTimeout(() => { const i = presentWaiters.indexOf(ok); if (i >= 0) presentWaiters.splice(i, 1); r(false); }, ms);
    const ok = () => { rawClearTimeout(id); r(true); };
    presentWaiters.push(ok);
  });
  const screenPng = () => new Promise<string>((resolve) => screen().toBlob((b) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.readAsDataURL(b!);
  }, "image/png"));

  const busy = (dueBefore: number, stableMs: number): string[] => {
    const now = performance.now();
    const wd = g.wd, d = wd.mainDbg;
    const r: string[] = [];
    if (d.depth > 0) r.push("job:" + d.phase);
    if (d.queued > 0) r.push("queued");
    if (wd.vsyncScheduled?.()) r.push("vsync");
    if (wd.pendingTransitions?.()) r.push("transition");
    if (wd.yields.pending()) r.push("yields");
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
  const stateMatches = (condition: StateCondition, screen: Screen, nodes: UiNode[]): boolean => {
    if (condition.kind === "all" || condition.kind === "any") {
      const matches = condition.conditions.map((item) => stateMatches(item, screen, nodes));
      return condition.kind === "all" ? matches.every(Boolean) : matches.some(Boolean);
    }
    if (condition.kind === "perf") return (g.wd.perf[condition.counter] ?? 0) >= condition.atLeast;
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
    if (policy.kind === "state") {
      const virtualEnd = (g.wd.guestClock?.now() ?? 0) + policy.maxVirtualMs;
      let matchedAt = 0;
      for (;;) {
        const now = performance.now();
        const matches = stateMatches(policy.condition, screen, await g.wd.uiTree());
        if (matches) {
          matchedAt ||= now;
          if (now - matchedAt >= policy.stableMs) break;
        } else matchedAt = 0;
        if (performance.now() - t0 >= policy.maxRealMs) return done("timeout", { state: 1 });
        const next = controlled ? g.wd.guestClock.nextDeadline() : null;
        if (controlled && g.wd.guestClock.now() < virtualEnd) {
          await g.wd.guestClock.advanceTo(Math.min(virtualEnd, next ?? g.wd.guestClock.now() + 16));
          await g.wd.testFrame();
        } else await sleep(10);
      }
      const alive = controlled
        ? await g.wd.guestClock.drive(g.wd.alive(policy.maxRealMs), policy.maxVirtualMs)
        : await g.wd.alive(policy.maxRealMs);
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
        // each sample is a synchronous GPU readback, which under SwiftShader can take most of a
        // busy app's main thread: a screen whose every sample differs (a spinner) is sampled less
        // often until a frame repeats
        interval = hashes.length === q.stableFrames * 2 && new Set(hashes).size === hashes.length ? Math.min(interval * 2, 1000) : q.intervalMs;
      }
      const b = busy(dueBefore, q.stableMs);
      if (!b.length) return done("idle", seen);
      for (const k of b) seen[k] = (seen[k] ?? 0) + 1;
      // a still screen settles past timers and network, not past work under way: a main-thread job
      // or its queue (its result is not drawn yet) or an activity start or finish, nor on a real
      // clock during the first 1.5 s of frames scheduled or threads running (a fling's overscroll
      // stretch changes no pixels; a background thread's result is not shown yet). A controlled
      // clock has already run through the window, and a loop that keeps going without changing
      // the screen (a paused game) is still.
      activeSince = b.includes("vsync") || b.includes("yields") ? activeSince || now : 0;
      const working = b.some((k) => k.startsWith("job:") || k === "queued" || k === "transition") ||
        (!controlled && activeSince > 0 && now - activeSince < 1500);
      const h = working ? undefined : stableFrame(hashes, q.stableFrames);
      if (h !== undefined) { captured = sampled.get(h) ?? null; return done("pixels", seen); }
      if (now - t0 >= timeoutMs + (controlled ? 0 : horizonMs)) return done("timeout", seen);
      await sleep(25);
    }
  };
  const capture = () => captured ? encode(captured) : screenPng();

  const act = (a: Act, screen: Screen, deadlineMs: number, controlled = false) => performAction({ a, screen, deadlineMs, controlled });
  const seen = { missing: new Set<string>(), placeholders: new Set<string>(), native: new Set<string>(), errors: new Set<string>() };
  const fresh = (key: keyof typeof seen, all: string[]): string[] => {
    const out = all.filter((x) => !seen[key].has(x));
    seen[key] = new Set(all);
    return out;
  };
  // a phase that can wait on the main looper (settle's test frames, the UI dump) past this bound
  // records the looper and the threads, then the step goes on without it
  const PHASE_BOUND_MS = 30_000;
  const bounded = async <T>(phase: string, work: Promise<T>, ms: number, fallback: T, hangs: Hang[]): Promise<T> => {
    let id = 0;
    const late = new Promise<"late">((r) => { id = rawSetTimeout(() => r("late"), ms); });
    const out = await Promise.race([work, late]).finally(() => rawClearTimeout(id));
    if (out !== "late") return out as T;
    const within = <U>(p: Promise<U>) => Promise.race([p, new Promise<string>((r) => rawSetTimeout(() => r("no answer in 3 s"), 3000))]);
    hangs.push({ phase, afterMs: ms, looper: await within(Promise.resolve().then(() => g.wd.looperDump())).catch(String), threads: g.wd.threads?.() });
    return fallback;
  };
  const step = async (spec: StepSpec): Promise<StepResult> => {
    const wd = g.wd, hangs: Hang[] = [];
    wd.perfReset();
    shots.length = 0; shotHash = -1; shooting = cfg.shots;
    const t0 = performance.now();
    let semanticHit: boolean | undefined, error: string | undefined;
    const actionAt = performance.now();
    try {
      const maxActionMs = spec.wait.kind === "live" || spec.wait.kind === "live-sample"
        ? spec.wait.timeoutMs
        : spec.wait.maxRealMs;
      semanticHit = await act(spec.act, spec.screen, maxActionMs, spec.timing === "controlled");
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    const actionMs = performance.now() - actionAt;
    const controlled = spec.timing === "controlled";
    const settleBound = (spec.wait.kind === "live" || spec.wait.kind === "live-sample" ? spec.wait.timeoutMs : spec.wait.maxRealMs) + PHASE_BOUND_MS;
    const settled = await bounded("settle", settle(spec.wait, controlled, spec.quiescence, spec.capture, spec.screen), settleBound,
      { how: "timeout", ms: settleBound, busy: { hang: 1 } } as Settled, hangs);
    const aliveAt = performance.now();
    const alive = wd.alive(spec.aliveMs);
    const wedged = !(controlled ? await wd.guestClock.drive(alive, spec.aliveMs) : await alive);
    const livenessMs = performance.now() - aliveAt;
    shooting = false;
    const captureAt = performance.now();
    const png = spec.capture ? await bounded("capture", capture(), PHASE_BOUND_MS, null, hangs) : null;
    const frames: string[] = [];
    for (const f of shots) frames.push(await encode(f));
    const captureMs = performance.now() - captureAt;
    const telemetryAt = performance.now();
    const uiTree: UiNode[] = await bounded("uiTree", wd.uiTree(), PHASE_BOUND_MS, [], hangs);
    const counters = { ...wd.perf };
    const result = {
      png, frameHash: lastHash < 0 ? null : lastHash.toString(16).padStart(8, "0"), presentation,
      settled, semanticHit, wedged, error, hang: hangs[0],
      perf: counters,
      newMissing: fresh("missing", [...wd.rt.missing]),
      newPlaceholders: fresh("placeholders", [...wd.rt.placeholders]),
      nativeRequired: fresh("native", wd.nativeRequirements()),
      newErrors: fresh("errors", (wd.logs as string[]).filter((l) => l.startsWith("error:"))),
      web: (wd.web() as StepResult["web"]).map(({ url, title, loaded }) => ({ url, title, loaded })),
      uiTree,
      frames,
    };
    const telemetryMs = performance.now() - telemetryAt;
    return { ...result, ms: performance.now() - t0,
      phases: { actionMs, settleMs: settled.ms, livenessMs, captureMs, telemetryMs } };
  };
  g.__wd = { step, act };
}

/** The init script: the stability rule and the probe, installed with the flow's configuration. */
export const probeScript = (cfg: ProbeConfig): string =>
  `${environmentScript(cfg)}; (() => { ${stableFrame.toString()}; ${performAction.toString()}; (${installProbe.toString()})(${JSON.stringify(cfg)}); })();`;
