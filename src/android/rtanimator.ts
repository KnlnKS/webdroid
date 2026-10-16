// The render thread's animators, stepped by the frame loop (animateRenderThread): hwui's
// interpolators (NativeInterpolatorFactory), RenderNodeAnimator over a node's properties, its
// reveal clip or a CanvasProperty, and AnimatedVectorDrawable's VectorDrawableAnimatorRT, a
// PropertyValuesAnimatorSet whose property holders write a VectorDrawable tree. Each follows
// BaseRenderNodeAnimator: requests staged from Java resolve on the next frame, which animates at
// the frame's time and reports a finish to the Java listener.

import { rt } from "../jvm/runtime.ts";
import { scall } from "../jvm/natives/jentry.ts";
import { deref, handle, ownedHandle, take } from "./handles.ts";
import type { NativePaint } from "./paint.ts";
import { type NativeRenderNode, prop as canvasProperty } from "./rendernode.ts";
import { interpolatePaths, PathData } from "./pathparser.ts";
import { type Tree, type Group, type FullPath, type VPath, node } from "./vectordrawable.ts";
import { detached } from "../jvm/natives/jthrowable.ts";

// ── Interpolator.cpp
export type Interpolator = (t: number) => number;
const f32 = Math.fround;
const bounce = (t: number) => t * t * 8;
const INTERPOLATORS = {
  "createAccelerateDecelerateInterpolator()J": (): Interpolator => (t) => f32(Math.cos((t + 1) * Math.PI) / 2 + 0.5),
  "createAccelerateInterpolator(F)J": (factor: number): Interpolator => (t) => f32(factor === 1 ? t * t : Math.pow(t, factor * 2)),
  "createAnticipateInterpolator(F)J": (tension: number): Interpolator => (t) => f32(t * t * ((tension + 1) * t - tension)),
  "createAnticipateOvershootInterpolator(F)J": (tension: number): Interpolator => (t) => {
    const a = (x: number) => x * x * ((tension + 1) * x - tension), o = (x: number) => x * x * ((tension + 1) * x + tension);
    return f32(t < 0.5 ? 0.5 * a(t * 2) : 0.5 * (o(t * 2 - 2) + 2));
  },
  "createBounceInterpolator()J": (): Interpolator => (t) => {
    t = f32(t * 1.1226);
    return f32(t < 0.3535 ? bounce(t) : t < 0.7408 ? bounce(t - 0.54719) + 0.7 : t < 0.9644 ? bounce(t - 0.8526) + 0.9 : bounce(t - 1.0435) + 0.95);
  },
  "createCycleInterpolator(F)J": (cycles: number): Interpolator => (t) => f32(Math.sin(2 * cycles * Math.PI * t)),
  "createDecelerateInterpolator(F)J": (factor: number): Interpolator => (t) => f32(factor === 1 ? 1 - (1 - t) * (1 - t) : 1 - Math.pow(1 - t, 2 * factor)),
  "createLinearInterpolator()J": (): Interpolator => (t) => t,
  "createOvershootInterpolator(F)J": (tension: number): Interpolator => (t) => { t -= 1; return f32(t * t * ((tension + 1) * t + tension) + 1); },
  "createPathInterpolator([F[F)J": (xs: Float32Array, ys: Float32Array): Interpolator => {
    const x = Float32Array.from(xs), y = Float32Array.from(ys);
    return (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      let lo = 0, hi = x.length - 1;
      while (hi > lo + 1) { const mid = (lo + hi) >> 1; if (t < x[mid]) hi = mid; else lo = mid; }
      const range = x[hi] - x[lo];
      return range === 0 ? y[lo] : f32(y[lo] + f32((t - x[lo]) / range) * (y[hi] - y[lo]));
    };
  },
  "createLutInterpolator([F)J": (values: Float32Array): Interpolator => {
    const v = Float32Array.from(values), n = v.length;
    return (t) => {
      const pos = f32(t * (n - 1));
      if (pos >= n - 1) return v[n - 1];
      const i = Math.trunc(pos);
      return f32(v[i] + (v[Math.min(i + 1, n - 1)] - v[i]) * (pos - i));
    };
  },
};
rt.registerJnis("android/graphics/animation/NativeInterpolatorFactory", Object.fromEntries(
  Object.entries(INTERPOLATORS).map(([sig, make]) => [sig, (...a: never[]) => handle((make as (...a: never[]) => Interpolator)(...a))])));

// ── BaseRenderNodeAnimator: play states, requests staged from Java, and a value animated from the
// start value (the target's own unless one was set) to the final one
const NOT_STARTED = 0, RUNNING = 1, REVERSING = 2, FINISHED = 3;
const START = 0, REVERSE = 1, RESET = 2, END = 4;
const NONE = 0, ACTION_RESET = 1, ACTION_END = 2;

abstract class RenderAnimator {
  final: number;
  state = NOT_STARTED;
  stagingState = NOT_STARTED;
  readonly requests: number[] = [];
  playTime = 0;
  startTime = 0;
  startDelay = 0;
  duration = 300;
  pendingAction = NONE;
  interpolator: Interpolator = (t) => t;
  from = 0; delta = 0; hasStart = false;
  constructor(final: number) { this.final = final; }
  protected abstract getValue(): number;
  protected abstract setValue(v: number): void;
  protected onPlayTimeChanged(_playTime: number): void {}
  protected abstract onFinished(): void;
  setStart(v: number): void { this.from = v; this.delta = this.final - v; this.hasStart = true; }

  request(r: number, staging: number): void { this.stagingState = staging; this.requests.push(r); active.add(this); }
  private resolve(r: number): void {
    const running = this.state === RUNNING || this.state === REVERSING;
    switch (r) {
      case START: this.playTime = running ? this.playTime : 0; this.state = RUNNING; this.pendingAction = NONE; break;
      case REVERSE: this.playTime = running ? this.playTime : this.duration; this.state = REVERSING; this.pendingAction = NONE; break;
      case RESET: this.playTime = 0; this.state = FINISHED; this.pendingAction = ACTION_RESET; break;
      case END: this.playTime = this.state === REVERSING ? 0 : this.duration; this.state = FINISHED; this.pendingAction = ACTION_END; break;
    }
  }
  pushStaging(now: number): void {
    if (!this.hasStart) this.setStart(this.getValue());
    if (!this.requests.length) return;
    const playTime = this.playTime, prev = this.state;
    for (const r of this.requests) this.resolve(r);
    this.requests.length = 0;
    if (this.stagingState === FINISHED) {
      this.updatePlayTime(this.playTime);
      this.onFinished();
    } else if (prev !== this.stagingState || playTime !== this.playTime) {
      // seek so that the frame time less the start is the requested play time
      this.startTime = this.state === REVERSING ? now - (this.duration - this.playTime)
        : this.playTime === 0 ? now + this.startDelay : now - this.playTime;
    }
  }
  /** one frame; true once there is nothing left to animate */
  animate(now: number): boolean {
    if (this.state < RUNNING) return false;
    if (this.state === FINISHED) {
      if (this.pendingAction === ACTION_RESET) this.updatePlayTime(0);
      else if (this.pendingAction === ACTION_END) this.updatePlayTime(this.duration);
      this.pendingAction = NONE;
      return true;
    }
    const done = this.updatePlayTime(now - this.startTime);
    if (done) { this.state = FINISHED; this.onFinished(); }
    return done;
  }
  private updatePlayTime(playTime: number): boolean {
    this.playTime = this.state === REVERSING ? this.duration - playTime : playTime;
    this.onPlayTimeChanged(this.playTime);
    if (playTime < 0) { this.setValue(this.from); return false; }
    const f = (this.state === RUNNING || this.state === REVERSING) && this.duration > 0 ? Math.min(1, Math.max(0, f32(this.playTime / this.duration))) : 1;
    this.setValue(f32(this.from + this.delta * this.interpolator(f)));
    return playTime >= this.duration;
  }
}

// The animators with staged requests or running, stepped once per frame
const active = new Set<RenderAnimator>();
/** the render thread's part of the frame at `now` (ms): true while anything animates, which the
 *  frame must then draw */
export function animateRenderThread(now: number): boolean {
  if (!active.size) return false;
  for (const a of [...active]) {
    a.pushStaging(now);
    if (a.animate(now) && !a.requests.length) active.delete(a);
  }
  return true;
}

// ── RenderNodeAnimator: RenderPropertyAnimator, RevealAnimator and the CanvasProperty animators
/** RenderPropertyAnimator::RenderProperty, read and written through the node's properties */
const NODE_PROPERTIES: [get: (n: NativeRenderNode) => number, set: (n: NativeRenderNode, v: number) => void][] = [
  [(n) => n.tx, (n, v) => n.setTransform("tx", v)],
  [(n) => n.ty, (n, v) => n.setTransform("ty", v)],
  [(n) => n.tz, (n, v) => { n.tz = v; }],
  [(n) => n.scaleX, (n, v) => n.setTransform("scaleX", v)],
  [(n) => n.scaleY, (n, v) => n.setTransform("scaleY", v)],
  [(n) => n.rotation, (n, v) => n.setTransform("rotation", v)],
  [(n) => n.rotationX, (n, v) => n.setTransform("rotationX", v)],
  [(n) => n.rotationY, (n, v) => n.setTransform("rotationY", v)],
  [(n) => n.left + n.tx, (n, v) => n.setTransform("tx", f32(v - n.left))],
  [(n) => n.top + n.ty, (n, v) => n.setTransform("ty", f32(v - n.top))],
  [(n) => n.elevation + n.tz, (n, v) => { n.tz = f32(v - n.elevation); }],
  [(n) => n.alpha, (n, v) => { n.alpha = Math.min(1, Math.max(0, v)); }],
];
class NodeAnimator extends RenderAnimator {
  readonly read: (n: NativeRenderNode | null) => number; readonly write: (n: NativeRenderNode | null, v: number) => void;
  target: NativeRenderNode | null = null;
  /** the Java RenderNodeAnimator a finish is reported to, once */
  listener: object | null = null;
  constructor(final: number, read: (n: NativeRenderNode | null) => number, write: (n: NativeRenderNode | null, v: number) => void) { super(final); this.read = read; this.write = write; }
  protected getValue(): number { return this.read(this.target); }
  protected setValue(v: number): void { this.write(this.target, v); }
  protected onFinished(): void {
    const l = this.listener;
    this.listener = null;
    if (l) detached(() => scall("android/graphics/animation/RenderNodeAnimator", "callOnFinished", "(Landroid/graphics/animation/RenderNodeAnimator;)V", l));
  }
}
const nodeAnimator = (h: bigint) => deref<NodeAnimator>(h);
/** each node's animators, which ending all of them (a detach) ends */
const nodeAnimators = new WeakMap<NativeRenderNode, Set<NodeAnimator>>();
/** RenderNode.nAddAnimator: the animator runs on the node */
export function addAnimator(n: NativeRenderNode, h: bigint): void {
  const a = nodeAnimator(h);
  a.target = n;
  let set = nodeAnimators.get(n);
  if (!set) nodeAnimators.set(n, set = new Set());
  set.add(a);
}
/** AnimatorManager::endAllActiveAnimators: every animator still running on the node ends */
export function endAnimators(n: NativeRenderNode): void {
  const set = nodeAnimators.get(n);
  if (!set) return;
  for (const a of set) if (a.state !== FINISHED || a.requests.length) a.request(END, FINISHED);
  set.clear();
}
rt.registerJnis("android/graphics/animation/RenderNodeAnimator", {
  "nCreateAnimator(IF)J": (property: number, final: number) => {
    const [get, set] = NODE_PROPERTIES[property];
    return ownedHandle(new NodeAnimator(final, (n) => n ? get(n) : 0, (n, v) => { if (n) set(n, v); }));
  },
  "nCreateRevealAnimator(IIFF)J": (x: number, y: number, start: number, end: number) => {
    const a = new NodeAnimator(end, (n) => n?.revealRadius ?? 0, (n, v) => { if (n) { n.revealClip = true; n.revealX = x; n.revealY = y; n.revealRadius = v; } });
    a.setStart(start);
    return ownedHandle(a);
  },
  "nCreateCanvasPropertyFloatAnimator(JF)J": (p: bigint, final: number) => {
    const prop = canvasProperty<number>(p);
    return ownedHandle(new NodeAnimator(final, () => prop.value, (_n, v) => { prop.value = v; }));
  },
  // CanvasPropertyPaintAnimator::PaintField: STROKE_WIDTH, ALPHA (set as a uint8)
  "nCreateCanvasPropertyPaintAnimator(JIF)J": (p: bigint, field: number, final: number) => {
    const paint = canvasProperty<NativePaint>(p).value;
    return ownedHandle(field === 0
      ? new NodeAnimator(final, () => paint.strokeWidth, (_n, v) => { paint.strokeWidth = v; })
      : new NodeAnimator(final, () => paint.color >>> 24, (_n, v) => paint.setAlpha(Math.trunc(v) & 255)));
  },
  "nSetStartValue(JF)V": (h: bigint, v: number) => nodeAnimator(h).setStart(v),
  "nSetDuration(JJ)V": (h: bigint, d: bigint) => {
    if (d < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Duration must be positive; was " + d);
    nodeAnimator(h).duration = Number(d);
  },
  "nGetDuration(J)J": (h: bigint) => BigInt(nodeAnimator(h).duration),
  "nSetStartDelay(JJ)V": (h: bigint, d: bigint) => { nodeAnimator(h).startDelay = Number(d); },
  // hwui's animators own their interpolators
  "nSetInterpolator(JJ)V": (h: bigint, i: bigint) => { nodeAnimator(h).interpolator = take<Interpolator>(i); },
  // there is one thread either way
  "nSetAllowRunningAsync(JZ)V": () => {},
  "nSetListener(JLandroid/graphics/animation/RenderNodeAnimator;)V": (h: bigint, l: object) => { nodeAnimator(h).listener = l; },
  "nStart(J)V": (h: bigint) => nodeAnimator(h).request(START, RUNNING),
  "nEnd(J)V": (h: bigint) => nodeAnimator(h).request(END, FINISHED),
});

// ── PropertyValuesHolder.cpp
type Evaluator = (from: number, to: number, f: number) => number;
const lerp: Evaluator = (from, to, f) => f32(from * (1 - f) + to * f);
const eocf = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const oecf = (c: number) => c <= 0.0031308 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055;
/** interpolateColor: alpha linearly, the colour channels in linear light */
const colorLerp: Evaluator = (from, to, f) => {
  const ch = (shift: number, linear: boolean) => {
    const a = (from >>> shift & 255) / 255, b = (to >>> shift & 255) / 255;
    return Math.round((linear ? oecf(lerp(eocf(a), eocf(b), f)) : lerp(a, b, f)) * 255) & 255;
  };
  return (ch(24, false) << 24 | ch(16, true) << 16 | ch(8, true) << 8 | ch(0, true)) | 0;
};
abstract class Holder {
  data: number[] | null = null;
  abstract set(fraction: number): void;
  /** getValueFromData: linear between the sampled frames */
  protected value(from: number, to: number, f: number, evaluate: Evaluator): number {
    const d = this.data;
    if (!d?.length) return evaluate(from, to, f);
    f = Math.min(1, Math.max(0, f));
    const n = d.length - 1, pos = f32(f * n), i = Math.floor(pos);
    return i >= n ? d[n] : evaluate(d[i], d[i + 1], pos - i);
  }
}
class GroupHolder extends Holder {
  readonly group: Group; readonly id: number; readonly from: number; readonly to: number;
  constructor(group: Group, id: number, from: number, to: number) { super(); this.group = group; this.id = id; this.from = from; this.to = to; }
  set(f: number): void { this.group.set(this.id, this.value(this.from, this.to, f, lerp)); }
}
class PathHolder extends Holder {
  readonly path: FullPath; readonly id: number; readonly from: number; readonly to: number; readonly color: boolean;
  constructor(path: FullPath, id: number, from: number, to: number, color: boolean) { super(); this.path = path; this.id = id; this.from = from; this.to = to; this.color = color; }
  set(f: number): void { this.path.animate(this.id, this.value(this.from, this.to, f, this.color ? colorLerp : lerp), this.color); }
}
class PathDataHolder extends Holder {
  readonly path: VPath; readonly from: PathData; readonly to: PathData;
  private readonly out = new PathData();
  constructor(path: VPath, from: PathData, to: PathData) { super(); this.path = path; this.from = from; this.to = to; }
  set(f: number): void { interpolatePaths(this.out, this.from, this.to, f); this.path.setData(this.out); }
}
class RootAlphaHolder extends Holder {
  readonly tree: Tree; readonly from: number; readonly to: number;
  constructor(tree: Tree, from: number, to: number) { super(); this.tree = tree; this.from = from; this.to = to; }
  set(f: number): void { this.tree.alpha = this.value(this.from, this.to, f, lerp); }
}

// ── PropertyValuesAnimatorSet.cpp
const REPEAT_REVERSE = 2, UINT32_MAX = 0xffffffff;
class PropertyAnimator {
  readonly holder: Holder; readonly interpolator: Interpolator; readonly delay: number; readonly duration: number; readonly mode: number;
  readonly repeat: number;
  readonly total: number;
  private latest = -1;
  constructor(holder: Holder, interpolator: Interpolator, delay: number, duration: number, repeat: number, mode: number) {
    this.holder = holder; this.interpolator = interpolator; this.delay = delay; this.duration = duration; this.mode = mode;
    this.repeat = repeat < 0 ? UINT32_MAX : repeat;
    this.total = (this.repeat + 1) * duration + delay;
  }
  setPlayTime(t: number): void {
    if (t < this.delay) return;
    if (t >= this.total) this.setFraction(1, this.repeat);
    else {
      const local = t - this.delay, iteration = Math.trunc(local / this.duration);
      this.setFraction(f32((local % this.duration) / this.duration), iteration);
    }
  }
  /** a total fraction is applied once, so of two animators on one property the later-ending wins */
  setFraction(f: number, iteration: number): void {
    const total = f + iteration;
    if (total === this.latest) return;
    this.latest = total;
    if (this.mode === REPEAT_REVERSE && iteration % 2 === 1) f = 1 - f;
    this.holder.set(this.interpolator(f));
  }
}
class AnimatorSet extends RenderAnimator {
  readonly animators: PropertyAnimator[] = [];
  private initialized = false;
  tree: Tree | null = null;
  /** the VectorDrawableAnimatorRT and request id the next finish reports to */
  private listener: { java: object; id: number } | null = null;
  private fraction = 0;
  constructor() { super(1); this.setStart(0); }
  protected getValue(): number { return this.fraction; }
  protected setValue(v: number): void { this.fraction = v; }
  protected override onPlayTimeChanged(t: number): void {
    if (t === 0 && this.duration > 0) for (let i = this.animators.length - 1; i >= 0; i--) this.animators[i].setFraction(0, 0);
    else for (const a of this.animators) a.setPlayTime(t);
  }
  protected onFinished(): void {
    const l = this.listener;
    if (!l) return;
    this.listener = null;
    detached(() => scall("android/graphics/drawable/AnimatedVectorDrawable$VectorDrawableAnimatorRT", "callOnFinished",
      "(Landroid/graphics/drawable/AnimatedVectorDrawable$VectorDrawableAnimatorRT;I)V", l.java, l.id));
  }
  /** sorted by total duration, so the one that ends last applies last */
  private init(): void {
    if (this.initialized) return;
    this.animators.sort((a, b) => a.total - b.total);
    this.duration = this.animators.at(-1)?.total ?? 0;
    this.initialized = true;
  }
  play(java: object, id: number, reverse: boolean): void {
    this.init();
    this.listener = { java, id };
    this.request(reverse ? REVERSE : START, reverse ? REVERSING : RUNNING);
  }
}

const animatorSet = (h: bigint) => deref<AnimatorSet>(h);
const RT = "Landroid/graphics/drawable/AnimatedVectorDrawable$VectorDrawableAnimatorRT;";
rt.registerJnis("android/graphics/drawable/AnimatedVectorDrawable", {
  "nCreateAnimatorSet()J": () => ownedHandle(new AnimatorSet()),
  "nSetVectorDrawableTarget(JJ)V": (s: bigint, tree: bigint) => { animatorSet(s).tree = deref<Tree>(tree); },
  // the set takes over the holder and the interpolator
  "nAddAnimator(JJJJJII)V": (s: bigint, h: bigint, interp: bigint, delay: bigint, duration: bigint, repeat: number, mode: number) =>
    void animatorSet(s).animators.push(new PropertyAnimator(take<Holder>(h), take<Interpolator>(interp), Number(delay), Number(duration), repeat, mode)),
  "nSetPropertyHolderData(J[FI)V": (h: bigint, data: Float32Array, n: number) => { deref<Holder>(h).data = Array.from(data.subarray(0, n)); },
  "nSetPropertyHolderData(J[II)V": (h: bigint, data: Int32Array, n: number) => { deref<Holder>(h).data = Array.from(data.subarray(0, n)); },
  "nCreateGroupPropertyHolder(JIFF)J": (g: bigint, id: number, from: number, to: number) => handle(new GroupHolder(node<Group>(g), id, from, to)),
  "nCreatePathDataPropertyHolder(JJJ)J": (p: bigint, from: bigint, to: bigint) => {
    const a = new PathData(), b = new PathData();
    a.copy(deref<PathData>(from)); b.copy(deref<PathData>(to));
    return handle(new PathDataHolder(node<VPath>(p), a, b));
  },
  "nCreatePathColorPropertyHolder(JIII)J": (p: bigint, id: number, from: number, to: number) => handle(new PathHolder(node<FullPath>(p), id, from, to, true)),
  "nCreatePathPropertyHolder(JIFF)J": (p: bigint, id: number, from: number, to: number) => handle(new PathHolder(node<FullPath>(p), id, from, to, false)),
  "nCreateRootAlphaPropertyHolder(JFF)J": (t: bigint, from: number, to: number) => handle(new RootAlphaHolder(deref<Tree>(t), from, to)),
  [`nStart(J${RT}I)V`]: (s: bigint, java: object, id: number) => animatorSet(s).play(java, id, false),
  [`nReverse(J${RT}I)V`]: (s: bigint, java: object, id: number) => animatorSet(s).play(java, id, true),
  "nEnd(J)V": (s: bigint) => animatorSet(s).request(END, FINISHED),
  "nReset(J)V": (s: bigint) => animatorSet(s).request(RESET, FINISHED),
});
