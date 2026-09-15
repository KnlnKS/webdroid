// The page-side half of the webdroid driver. `probeScript` is installed as an init script before
// any page script runs; `installProbe` is serialised into it, so it must stay self-contained and
// reach the runtime only through `globalThis.wd`.
import { stableFrame } from "./settle";
import { environmentScript, performAction } from "./actions";
import type { Screen, StateCondition, UiNode } from "../types";

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
  | { type: "tap"; x: number; y: number; repeat?: number; everyMs?: number }
  | { type: "tapText"; text: string; fallback?: { x: number; y: number } }
  | { type: "type"; text: string; x?: number; y?: number }
  | { type: "back" }
  | { type: "enter" }
  | { type: "background"; ms: number }
  | { type: "swipe"; from: [number, number]; to: [number, number]; ms: number; untilText?: string; maxSwipes?: number }
  | { type: "none" };

export type SettleOpts = {
  /** scheduled work due within this many ms of the action is waited for, and pixel stability is
   *  not trusted before it; the normalized wait policy horizon */
  horizonMs: number;
  /** capture once after the horizon instead of settling: a screen that never settles */
  sample: boolean;
  stableMs: number;
  intervalMs: number;
  stableFrames: number;
  timeoutMs: number;
  minRealMs: number;
  condition?: StateCondition;
};

export type StepSpec = { act: Act; screen: Screen; settle: SettleOpts; aliveMs: number; capture: boolean; controlled: boolean };

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
  ms: number;
  perf: Record<string, number>;
  newMissing: string[];
  nativeRequired: string[];
  unreadAttrs: string[];
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

export const DEFAULT_SETTLE: Omit<SettleOpts, "horizonMs" | "sample"> = { stableMs: 150, intervalMs: 250, stableFrames: 4, timeoutMs: 20_000, minRealMs: 0 };

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
    const wd = g.wd, u = wd.uiState, d = wd.mainDbg;
    const r: string[] = [];
    if (d.depth > 0) r.push("job:" + d.phase);
    if (d.queued > 0) r.push("queued");
    if (wd.app()?.stack.length) {
      if (u.needsDraw) r.push("draw");
      if (u.needsLayout) r.push("layout");
      if (u.needsInsets) r.push("insets");
    }
    if (u.frameCallbacks.length) r.push("frameCallbacks");
    if (u.animHooks.size) r.push("animators");
    if (wd.yields.pending()) r.push("yields");
    if (inflight) r.push("inflight");
    if (awaitingSockets()) r.push("sockets");
    const due = Math.max(dueBefore, now + stableMs);
    for (const [id, at] of timers) if (at <= due && !wd.timedParks.has(id)) { r.push("timers"); break; }
    if (now - lastPresent < stableMs) r.push("presented");
    return r;
  };

  let captured: ImageData | null = null;
  const driveGuest = async (horizonMs: number): Promise<void> => {
    const clock = g.wd.guestClock;
    if (!clock?.controlled) return;
    const end = clock.now() + horizonMs;
    for (;;) {
      const next = clock.nextDeadline();
      if (next === null || next > end) break;
      await clock.advanceTo(next);
    }
    await clock.advanceTo(end);
  };
  const stateMatches = (condition: StateCondition): boolean => {
    if (condition.kind === "perf") return (g.wd.perf[condition.counter] ?? 0) >= condition.atLeast;
    if (condition.kind === "activity") {
      const activity = g.wd.app()?.stack.at(-1);
      return activity?.component === condition.component || activity?.constructor?.$i?.name === condition.component;
    }
    const want = condition.text.replace(/\s+/g, " ").trim().toLowerCase();
    const found = (g.wd.uiTree() as UiNode[]).some((node) =>
      [node.text, node.desc].some((text) => text.replace(/\s+/g, " ").trim().toLowerCase().includes(want)));
    return condition.kind === "text" ? found : !found;
  };
  const settle = async (o: SettleOpts, controlled: boolean): Promise<Settled> => {
    const t0 = performance.now();
    captured = null;
    if (o.condition) {
      const virtualEnd = (g.wd.guestClock?.now() ?? 0) + o.horizonMs;
      while (!stateMatches(o.condition)) {
        if (performance.now() - t0 >= o.timeoutMs) return { how: "timeout", ms: performance.now() - t0, busy: { state: 1 } };
        const next = controlled ? g.wd.guestClock.nextDeadline() : null;
        if (controlled && g.wd.guestClock.now() < virtualEnd) {
          await g.wd.guestClock.advanceTo(Math.min(virtualEnd, next ?? g.wd.guestClock.now() + 16));
          await g.wd.testFrame();
        } else await sleep(10);
      }
      await g.wd.alive(o.timeoutMs);
      wantSample = true;
      if (controlled) await g.wd.testFrame(); else await nextPresent(500);
      captured = sampled.get(lastHash) ?? null;
      wantSample = false;
      return { how: "state", ms: performance.now() - t0, busy: {} };
    }
    if (controlled) await driveGuest(o.horizonMs);
    if (o.sample) {
      if (controlled && o.minRealMs) await sleep(o.minRealMs);
      wantSample = true;
      if (controlled) {
        await g.wd.testFrame();
        captured = sampled.get(lastHash) ?? null;
      } else {
        await sleep(o.horizonMs);
        if (await nextPresent(500)) captured = sampled.get(lastHash) ?? null;
      }
      wantSample = false;
      return { how: "snapshot", ms: performance.now() - t0, busy: {} };
    }
    const horizonAt = t0 + (controlled ? 0 : o.horizonMs);
    // the pixel rule needs stableFrames + 1 samples past the horizon before it can settle, so
    // anything scheduled inside that window was always waited for: a toast timing out, a
    // snackbar dismissing. The fast path keeps that contract.
    const dueBefore = horizonAt + (o.stableFrames + 1) * o.intervalMs;
    // the pixel rule samples only past the horizon, as the recorder does past its dwell
    const hashes: number[] = [];
    const seen: Record<string, number> = {};
    let lastSample = horizonAt - o.intervalMs;
    lastHash = -1;
    const done = (how: Settled["how"]): Settled => { wantSample = false; return { how, ms: performance.now() - t0, busy: seen }; };
    for (;;) {
      const now = performance.now();
      if (now - lastSample >= o.intervalMs) {
        lastSample = now;
        if (now > horizonAt) hashes.push(lastHash);
        if (hashes.length > o.stableFrames * 2) hashes.shift();
        wantSample = true;
      }
      const b = busy(dueBefore, o.stableMs);
      if (!b.length) return done("idle");
      for (const k of b) seen[k] = (seen[k] ?? 0) + 1;
      const h = stableFrame(hashes, o.stableFrames);
      if (h !== undefined) { captured = sampled.get(h) ?? null; return done("pixels"); }
      if (now - t0 >= o.timeoutMs + (controlled ? 0 : o.horizonMs)) return done("timeout");
      await sleep(25);
    }
  };
  const capture = () => captured ? encode(captured) : screenPng();

  const act = (a: Act, screen: Screen, deadlineMs: number, controlled = false) => performAction({ a, screen, deadlineMs, controlled });
  const driveControlled = async <T>(operation: Promise<T>, controlled: boolean): Promise<T> => {
    const clock = g.wd.guestClock;
    if (!controlled || !clock?.controlled) return operation;
    let finished = false;
    void operation.finally(() => { finished = true; }).catch(() => {});
    while (!finished) {
      const next = clock.nextDeadline();
      if (next === null) await sleep(0);
      else await clock.advanceTo(next);
    }
    return operation;
  };

  const seen = { missing: new Set<string>(), native: new Set<string>(), attrs: new Set<string>(), errors: new Set<string>() };
  const fresh = (key: keyof typeof seen, all: string[]): string[] => {
    const out = all.filter((x) => !seen[key].has(x));
    seen[key] = new Set(all);
    return out;
  };
  const step = async (spec: StepSpec): Promise<StepResult> => {
    const wd = g.wd;
    wd.perfReset();
    shots.length = 0; shotHash = -1; shooting = cfg.shots;
    const t0 = performance.now();
    let semanticHit: boolean | undefined, error: string | undefined;
    const actionAt = performance.now();
    try {
      const maxActionMs = spec.settle.timeoutMs + spec.settle.horizonMs;
      semanticHit = await act(spec.act, spec.screen, maxActionMs, spec.controlled);
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    const actionMs = performance.now() - actionAt;
    const settled = await settle(spec.settle, spec.controlled);
    const aliveAt = performance.now();
    const wedged = !(await driveControlled(wd.alive(spec.aliveMs), spec.controlled));
    const livenessMs = performance.now() - aliveAt;
    shooting = false;
    const captureAt = performance.now();
    const png = spec.capture ? await capture() : null;
    const frames: string[] = [];
    for (const f of shots) frames.push(await encode(f));
    const captureMs = performance.now() - captureAt;
    const telemetryAt = performance.now();
    const counters = { ...wd.perf };
    const result = {
      png, frameHash: lastHash < 0 ? null : lastHash.toString(16).padStart(8, "0"), presentation,
      settled, semanticHit, wedged, error,
      perf: counters,
      newMissing: fresh("missing", [...wd.rt.missing]),
      nativeRequired: fresh("native", [...wd.rt.nativeRequired].map(([l, a]: [string, string]) => l + " (" + a + ")")),
      unreadAttrs: fresh("attrs", wd.unreadAttrs()),
      newErrors: fresh("errors", (wd.logs as string[]).filter((l) => l.startsWith("error:"))),
      web: (wd.web() as StepResult["web"]).map(({ url, title, loaded }) => ({ url, title, loaded })),
      uiTree: wd.uiTree(),
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
