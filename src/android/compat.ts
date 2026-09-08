// Scrolling physics, view configuration, legacy animation classes, misc widgets' helpers.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jlang";
import { invalidate, uiState, JView, JViewGroup, initViewFromCtx, guardCall, setViewAnimHook, copyEvent } from "./view";
import { restVelocity, type JMotionEvent } from "./motionevent";
import { JMatrix } from "./graphics";
import { mangleMethod } from "../jvm/abi";
import { onMain, inMainJob } from "./mainloop";
import { newArrayList } from "../jvm/natives/jutil";
import { device } from "../shell/config";
import { reportUncaught } from "./os";

// ── Scroller/OverScroller: time-based interpolated scroll values
class JScroller extends JObj {
  startX = 0; startY = 0; finalX = 0; finalY = 0;
  startT = 0; duration = 250;
  curX = 0; curY = 0;
  finished = true;
  compute(): boolean {
    if (this.finished) return false;
    const t = Math.min(1, (performance.now() - this.startT) / this.duration);
    const e = 1 - Math.pow(1 - t, 3); // decelerate
    this.curX = Math.round(this.startX + (this.finalX - this.startX) * e);
    this.curY = Math.round(this.startY + (this.finalY - this.startY) * e);
    if (t >= 1) { this.finished = true; this.curX = this.finalX; this.curY = this.finalY; }
    invalidate();
    return !this.finished || this.curX !== this.finalX || this.curY !== this.finalY || t < 1;
  }
}
const scrollerMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;)V": function () {},
  "<init>(Landroid/content/Context;Landroid/view/animation/Interpolator;)V": function () {},
  "<init>(Landroid/content/Context;Landroid/view/animation/Interpolator;Z)V": function () {},
  "startScroll(IIII)V": function (this: JScroller, sx: number, sy: number, dx: number, dy: number) {
    this.startX = sx; this.startY = sy; this.finalX = sx + dx; this.finalY = sy + dy;
    this.startT = performance.now(); this.duration = 250;
    this.curX = sx; this.curY = sy;
    this.finished = dx === 0 && dy === 0;
    invalidate();
  },
  "startScroll(IIIII)V": function (this: JScroller, sx: number, sy: number, dx: number, dy: number, dur: number) {
    this.startX = sx; this.startY = sy; this.finalX = sx + dx; this.finalY = sy + dy;
    this.startT = performance.now(); this.duration = Math.max(1, dur);
    this.curX = sx; this.curY = sy;
    this.finished = dx === 0 && dy === 0;
    invalidate();
  },
  "fling(IIIIIIII)V": function (this: JScroller, sx: number, sy: number, vx: number, vy: number, minX: number, maxX: number, minY: number, maxY: number) {
    this.startX = sx; this.startY = sy;
    this.finalX = Math.max(minX, Math.min(maxX, sx + Math.round(vx * 0.35)));
    this.finalY = Math.max(minY, Math.min(maxY, sy + Math.round(vy * 0.35)));
    this.startT = performance.now();
    this.duration = Math.min(1200, 300 + Math.hypot(vx, vy) / device.dp(4));
    this.finished = false;
    invalidate();
  },
  "computeScrollOffset()Z": function (this: JScroller) { return this.compute() ? 1 : 0; },
  "getCurrX()I": function (this: JScroller) { return this.curX; },
  "getCurrY()I": function (this: JScroller) { return this.curY; },
  "getFinalX()I": function (this: JScroller) { return this.finalX; },
  "getFinalY()I": function (this: JScroller) { return this.finalY; },
  "getStartX()I": function (this: JScroller) { return this.startX; },
  "getStartY()I": function (this: JScroller) { return this.startY; },
  "isFinished()Z": function (this: JScroller) { return this.finished ? 1 : 0; },
  "abortAnimation()V": function (this: JScroller) {
    this.finished = true;
    this.curX = this.finalX; this.curY = this.finalY;
  },
  "forceFinished(Z)V": function (this: JScroller, f: number) { this.finished = !!f; },
  "getCurrVelocity()F": function (this: JScroller) { return this.finished ? 0 : 800; },
  "setFriction(F)V": () => {},
  "getDuration()I": function (this: JScroller) { return this.duration; },
  "springBack(IIIIII)Z": function (this: JScroller, sx: number, sy: number, minX: number, maxX: number, minY: number, maxY: number) {
    const fx = Math.max(minX, Math.min(maxX, sx));
    const fy = Math.max(minY, Math.min(maxY, sy));
    if (fx === sx && fy === sy) { this.finished = true; return 0; }
    this.startX = sx; this.startY = sy; this.finalX = fx; this.finalY = fy;
    this.startT = performance.now(); this.duration = 200; this.finished = false;
    return 1;
  },
  "isOverScrolled()Z": () => 0,
  "setFinalX(I)V": function (this: JScroller, x: number) { this.finalX = x; },
  "setFinalY(I)V": function (this: JScroller, y: number) { this.finalY = y; },
  "extendDuration(I)V": () => {},
  "timePassed()I": function (this: JScroller) { return Math.round(performance.now() - this.startT); },
  "notifyHorizontalEdgeReached(III)V": () => {},
  "notifyVerticalEdgeReached(III)V": () => {},
};
rt.register({ name: "android/widget/Scroller", ctor: JScroller, methods: scrollerMethods });
rt.register({ name: "android/widget/OverScroller", ctor: class extends JScroller {}, methods: scrollerMethods });

/** AOSP VelocityTracker: movements older than this before the newest one are not in the estimate */
const VELOCITY_HORIZON_MS = 100;

class JVelocityTracker extends JObj {
  samples: { x: number; y: number; t: number }[] = [];
  vx = 0; vy = 0;
  compute(units: number, max = Infinity) {
    const n = this.samples.length;
    if (n < 2) { this.vx = 0; this.vy = 0; return; }
    const b = this.samples[n - 1];
    // A pointer that rested before it lifted has no velocity, however fast it was moving before
    // that: walking back only within the horizon says so by leaving the estimate a single sample.
    let i = n - 1;
    while (i > 0 && i > n - 6 && b.t - this.samples[i - 1].t <= VELOCITY_HORIZON_MS) i--;
    if (i === n - 1) { this.vx = 0; this.vy = 0; return; }
    const a = this.samples[i];
    const dt = Math.max(1, b.t - a.t);
    this.vx = Math.max(-max, Math.min(max, (b.x - a.x) / dt * units));
    this.vy = Math.max(-max, Math.min(max, (b.y - a.y) / dt * units));
  }
}
rt.register({
  name: "android/view/VelocityTracker", ctor: JVelocityTracker,
  methods: {
    "static obtain()Landroid/view/VelocityTracker;": () => new JVelocityTracker(),
    "addMovement(Landroid/view/MotionEvent;)V": function (this: JVelocityTracker, ev: any) {
      this.samples.push({ x: ev.x, y: ev.y, t: performance.now() });
      if (this.samples.length > 12) this.samples.shift();
    },
    "computeCurrentVelocity(I)V": function (this: JVelocityTracker, units: number) { this.compute(units); },
    "computeCurrentVelocity(IF)V": function (this: JVelocityTracker, units: number, max: number) { this.compute(units, max); },
    "getXVelocity()F": function (this: JVelocityTracker) { return this.vx; },
    "getYVelocity()F": function (this: JVelocityTracker) { return this.vy; },
    "getXVelocity(I)F": function (this: JVelocityTracker) { return this.vx; },
    "getYVelocity(I)F": function (this: JVelocityTracker) { return this.vy; },
    "clear()V": function (this: JVelocityTracker) { this.samples.length = 0; },
    "recycle()V": function (this: JVelocityTracker) { this.samples.length = 0; },
  },
});

class JViewConfiguration extends JObj {}
const vc = new JViewConfiguration();
rt.register({
  name: "android/view/ViewConfiguration", ctor: JViewConfiguration,
  methods: {
    "static get(Landroid/content/Context;)Landroid/view/ViewConfiguration;": () => vc,
    "getScaledTouchSlop()I": () => device.touchSlop,
    "getScaledPagingTouchSlop()I": () => device.touchSlop * 2,
    "getScaledMinimumFlingVelocity()I": () => Math.round(device.dp(50)),
    "getScaledMaximumFlingVelocity()I": () => Math.round(device.dp(8000)),
    "getScaledMinimumFlingVelocity(III)I": () => Math.round(device.dp(50)),
    "getScaledMaximumFlingVelocity(III)I": () => Math.round(device.dp(8000)),
    "getScaledHorizontalScrollFactor()F": () => device.scrollUnit,
    "getScaledVerticalScrollFactor()F": () => device.scrollUnit,
    "getScaledHoverSlop()I": () => Math.round(device.dp(4)),
    "getScaledFadingEdgeLength()I": () => Math.round(device.dp(12)),
    "getScaledMinScalingSpan()I": () => Math.round(device.dp(27)),
    "shouldShowMenuShortcutsWhenKeyboardPresent()Z": () => 0,
    "static getAmbiguousGestureMultiplier()F": () => 2,
    "static getMinimumFlingVelocity()I": () => 50,
    "static getMaximumFlingVelocity()I": () => 8000,
    "getScaledOverscrollDistance()I": () => 0,
    "getScaledOverflingDistance()I": () => Math.round(device.dp(6)),
    "getScaledEdgeSlop()I": () => Math.round(device.dp(12)),
    "getScaledWindowTouchSlop()I": () => device.touchSlop * 2,
    "getScaledDoubleTapSlop()I": () => Math.round(device.dp(100)),
    "getScaledScrollBarSize()I": () => Math.round(device.dp(4)),
    "hasPermanentMenuKey()Z": () => 0,
    "static getScrollBarSize()I": () => 8,
    "static getDoubleTapTimeout()I": () => DOUBLE_TAP_TIMEOUT,
    "static getTapTimeout()I": () => 100,
    "static getLongPressTimeout()I": () => LONG_PRESS_TIMEOUT,
    "static getPressedStateDuration()I": () => 64,
    "static getScrollFriction()F": () => 0.015,
    // AOSP defaults: how long a scrollbar lingers before it starts fading, and for how long
    "static getScrollDefaultDelay()I": () => 300,
    "static getScrollBarFadeDuration()I": () => 250,
    "static getKeyRepeatDelay()I": () => 50,
    "static getTouchSlop()I": () => 16,
  },
});

// EdgeEffect (visual stub)
rt.register({
  name: "android/widget/EdgeEffect", ctor: class extends JObj { color = 0x666666; dist = 0; },
  statics: { DEFAULT_BLEND_MODE: null },
  methods: {
    "<init>(Landroid/content/Context;)V": function () {},
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function () {},
    "setSize(II)V": () => {},
    "isFinished()Z": () => 1,
    "onPull(F)V": () => {},
    "onPull(FF)V": () => {},
    // stretch overscroll (API 31): the pulled distance is what the caller reads back
    "onPullDistance(FF)F": function (this: any, d: number) { const before = this.dist; this.dist = Math.max(0, Math.min(1, this.dist + d)); return this.dist - before; },
    "getDistance()F": function (this: any) { return this.dist; },
    "onRelease()V": function (this: any) { this.dist = 0; },
    "onAbsorb(I)V": () => {},
    "draw(Landroid/graphics/Canvas;)Z": () => 0,
    "finish()V": function (this: any) { this.dist = 0; },
    "setColor(I)V": function (this: any, c: number) { this.color = c; },
    "getColor()I": function (this: any) { return this.color; },
    "setBlendMode(Landroid/graphics/BlendMode;)V": () => {},
    "getBlendMode()Landroid/graphics/BlendMode;": () => null,
    "getMaxHeight()I": () => 0,
  },
});

// ── android.view.animation: real Animations, driven from uiState.animHooks.
// An app subclass overrides applyTransformation(t, Transformation) and moves things itself
// (SwipeRefreshLayout's whole circle choreography is five of them), so the machinery that has
// to exist is the timeline: normalized time, interpolation, repeat, and the listener edges.
class JInterpolator extends JObj {
  a = 0; b = 0;
  f: (t: number) => number = (t) => t;
}
const INTERP: Record<string, (t: number, a: number, b: number) => number> = {
  LinearInterpolator: (t) => t,
  AccelerateDecelerateInterpolator: (t) => Math.cos((t + 1) * Math.PI) / 2 + 0.5,
  AccelerateInterpolator: (t, a) => a === 1 ? t * t : Math.pow(t, 2 * a),
  DecelerateInterpolator: (t, a) => a === 1 ? 1 - (1 - t) * (1 - t) : 1 - Math.pow(1 - t, 2 * a),
  OvershootInterpolator: (t, a) => (t -= 1, t * t * ((a + 1) * t + a) + 1),
  AnticipateInterpolator: (t, a) => t * t * ((a + 1) * t - a),
  AnticipateOvershootInterpolator: (t, a) => t < 0.5
    ? 0.5 * (t * 2) * (t * 2) * ((a * 1.5 + 1) * (t * 2) - a * 1.5)
    : 0.5 * ((t * 2 - 2) * (t * 2 - 2) * ((a * 1.5 + 1) * (t * 2 - 2) + a * 1.5) + 2),
  BounceInterpolator: (t) => {
    const b = (x: number) => x * x * 8;
    t *= 1.1226;
    return t < 0.3535 ? b(t) : t < 0.7408 ? b(t - 0.54719) + 0.7 : t < 0.9644 ? b(t - 0.8526) + 0.9 : b(t - 1.0435) + 0.95;
  },
  CycleInterpolator: (t, a) => Math.sin(2 * Math.PI * a * t),
  PathInterpolator: (t) => t,
  FastOutSlowInInterpolator: (t) => Math.cos((t + 1) * Math.PI) / 2 + 0.5,
};
// default tension/factor per class: 2.0 for the overshoot family, 1.0 for the power ones
const INTERP_DEF: Record<string, number> = { OvershootInterpolator: 2, AnticipateInterpolator: 2, AnticipateOvershootInterpolator: 2 };
for (const n of ["android/view/animation/Interpolator", "android/animation/TimeInterpolator"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}
for (const n of Object.keys(INTERP)) {
  const fn = INTERP[n], def = INTERP_DEF[n] ?? 1;
  const init = function (this: JInterpolator, a?: number) { this.a = a ?? def; this.f = (t) => fn(t, this.a, this.b); };
  rt.register({
    name: "android/view/animation/" + n, ctor: class extends JInterpolator {},
    ifaces: ["android/view/animation/Interpolator", "android/animation/TimeInterpolator"],
    methods: {
      "<init>()V": init,
      "<init>(F)V": init,
      "<init>(FF)V": function (this: JInterpolator, a: number, b: number) { init.call(this, a); this.b = b; },
      "<init>(FFFF)V": init,
      "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": init,
      "<init>(Landroid/graphics/Path;)V": init,
      "getInterpolation(F)F": function (this: JInterpolator, t: number) { return Math.fround(this.f(t)); },
    },
  });
}
/** the interpolation an Animation with no interpolator of its own uses */
const accelDecel = INTERP.AccelerateDecelerateInterpolator;

class JTransformation extends JObj {
  alpha = 1;
  matrix = new JMatrix();
}
rt.register({
  name: "android/view/animation/Transformation", ctor: JTransformation,
  methods: {
    "<init>()V": function () {},
    "clear()V": function (this: JTransformation) { this.alpha = 1; this.matrix.m = [1, 0, 0, 1, 0, 0]; },
    "getAlpha()F": function (this: JTransformation) { return this.alpha; },
    "setAlpha(F)V": function (this: JTransformation, a: number) { this.alpha = a; },
    "getMatrix()Landroid/graphics/Matrix;": function (this: JTransformation) { return this.matrix; },
    "getTransformationType()I": () => 3,
    "setTransformationType(I)V": () => {},
    "set(Landroid/view/animation/Transformation;)V": function (this: JTransformation, o: JTransformation) { this.alpha = o.alpha; this.matrix.m = [...o.matrix.m]; },
  },
});

const ABSOLUTE = 0, REL_SELF = 1;
class JAnimation extends JObj {
  listener: unknown = null;
  duration = 0;
  startOffset = 0;
  repeatCount = 0;
  repeatMode = 1;             // RESTART; 2 = REVERSE
  fillBefore = true; fillAfter = false; fillEnabled = false;
  interp: unknown = null;
  startTime = -1;             // START_ON_FIRST_FRAME
  started = false; ended = false; flipped = false; initialized = false;
  repeated = 0;
  /** built-in subclasses: [from, to] pairs plus the pivot, each with its Description type */
  p: number[] = [];
  pt: number[] = [];
  kids: JAnimation[] = [];    // AnimationSet
}
/** resolve one Animation.Description against the view and its parent */
const resolveDim = (type: number, v: number, size: number, parent: number) =>
  type === ABSOLUTE ? v : v * (type === REL_SELF ? size : parent);

async function fire(a: JAnimation, v: JView | null, what: string) {
  if (v) await guardCall(v, mangleMethod("onAnimation" + what, "()V"));
  if (a.listener) await vcall(a.listener, "onAnimation" + what, "(Landroid/view/animation/Animation;)V", a);
}

/** AOSP Animation.getTransformation: the one place normalized time, repeat and the edges live */
async function getTransformation(a: JAnimation, now: number, out: JTransformation, v: JView | null): Promise<boolean> {
  if (a.startTime === -1) a.startTime = now;
  let norm = a.duration !== 0 ? (now - (a.startTime + a.startOffset)) / a.duration : (now < a.startTime ? 0 : 1);
  const expired = norm >= 1 || a.ended;
  let more = !expired;
  if (!a.fillEnabled) norm = norm < 0 ? 0 : norm > 1 ? 1 : norm;
  if ((norm >= 0 || a.fillBefore) && (norm <= 1 || a.fillAfter)) {
    if (!a.started) { a.started = true; await fire(a, v, "Start"); }
    if (a.fillEnabled) norm = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    if (a.flipped) norm = 1 - norm;
    const it = a.interp ? Math.fround(await vcall(a.interp, "getInterpolation", "(F)F", Math.fround(norm))) : accelDecel(norm, 0, 0);
    await vcall(a, "applyTransformation", "(FLandroid/view/animation/Transformation;)V", it, out);
  }
  if (expired) {
    if (a.repeatCount === a.repeated) {
      if (!a.ended) { a.ended = true; await fire(a, v, "End"); }
    } else {
      if (a.repeatCount > 0) a.repeated++;
      if (a.repeatMode === 2) a.flipped = !a.flipped;
      a.startTime = -1;
      more = true;
      if (a.listener) await vcall(a.listener, "onAnimationRepeat", "(Landroid/view/animation/Animation;)V", a);
    }
  }
  return more;
}

async function stepViewAnim(v: JView): Promise<boolean> {
  const a = v.jAnim as JAnimation | null;
  if (!a) { v.animTf = null; return false; }
  if (!a.initialized) {
    a.initialized = true;
    const p = v.parent;
    await vcall(a, "initialize", "(IIII)V", v.width(), v.height(), p ? p.width() : v.width(), p ? p.height() : v.height());
  }
  const tf = (v.animTf ??= new JTransformation()) as JTransformation;
  tf.alpha = 1; tf.matrix.m = [1, 0, 0, 1, 0, 0];
  const more = await getTransformation(a, performance.now(), tf, v);
  invalidate();
  if (!more && v.jAnim === a) { v.jAnim = null; if (!a.fillAfter) v.animTf = null; }
  return more;
}

setViewAnimHook((v, anim) => {
  const a = anim as JAnimation;
  a.startTime = -1; a.started = false; a.ended = false; a.flipped = false; a.repeated = 0;
  v.jAnim = a;
  let inflight = false;
  uiState.animHooks.add(function hook() {
    if (v.jAnim !== a) return false;
    if (!inflight) { inflight = true; void onMain(() => stepViewAnim(v)).finally(() => { inflight = false; }); }
    return true;
  });
  invalidate();
});

const animMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function () {},
  "setDuration(J)V": function (this: JAnimation, d: bigint) { this.duration = Number(d); },
  "getDuration()J": function (this: JAnimation) { return BigInt(this.duration); },
  "setStartOffset(J)V": function (this: JAnimation, d: bigint) { this.startOffset = Number(d); },
  "getStartOffset()J": function (this: JAnimation) { return BigInt(this.startOffset); },
  "setStartTime(J)V": function (this: JAnimation, t: bigint) { this.startTime = Number(t); this.started = this.ended = false; },
  "getStartTime()J": function (this: JAnimation) { return BigInt(this.startTime); },
  "setInterpolator(Landroid/view/animation/Interpolator;)V": function (this: JAnimation, i: unknown) { this.interp = i; },
  "getInterpolator()Landroid/view/animation/Interpolator;": function (this: JAnimation) { return this.interp; },
  "setFillAfter(Z)V": function (this: JAnimation, b: number) { this.fillAfter = !!b; },
  "setFillBefore(Z)V": function (this: JAnimation, b: number) { this.fillBefore = !!b; },
  "setFillEnabled(Z)V": function (this: JAnimation, b: number) { this.fillEnabled = !!b; },
  "getFillAfter()Z": function (this: JAnimation) { return this.fillAfter ? 1 : 0; },
  "setRepeatCount(I)V": function (this: JAnimation, n: number) { this.repeatCount = n; },
  "getRepeatCount()I": function (this: JAnimation) { return this.repeatCount; },
  "setRepeatMode(I)V": function (this: JAnimation, m: number) { this.repeatMode = m; },
  "setZAdjustment(I)V": () => {},
  "setDetachWallpaper(Z)V": () => {},
  "setBackgroundColor(I)V": () => {},
  "willChangeBounds()Z": () => 1,
  "willChangeTransformationMatrix()Z": () => 1,
  "setAnimationListener(Landroid/view/animation/Animation$AnimationListener;)V": function (this: JAnimation, l: unknown) { this.listener = l; },
  "start()V": function (this: JAnimation) { this.startTime = -1; },
  "startNow()V": function (this: JAnimation) { this.startTime = performance.now(); },
  "cancel()V": async function (this: JAnimation) {
    if (this.started && !this.ended) { this.ended = true; await fire(this, null, "End"); }
    this.startTime = Number.MIN_SAFE_INTEGER;
  },
  "reset()V": function (this: JAnimation) { this.started = this.ended = this.flipped = this.initialized = false; this.repeated = 0; },
  "hasEnded()Z": function (this: JAnimation) { return this.ended ? 1 : 0; },
  "hasStarted()Z": function (this: JAnimation) { return this.started ? 1 : 0; },
  "initialize(IIII)V": function (this: JAnimation) { this.initialized = true; },
  "isInitialized()Z": function (this: JAnimation) { return this.initialized ? 1 : 0; },
  "applyTransformation(FLandroid/view/animation/Transformation;)V": () => {},
  "getTransformation(JLandroid/view/animation/Transformation;)Z": async function (this: JAnimation, now: bigint, t: JTransformation) {
    return await getTransformation(this, Number(now), t, null) ? 1 : 0;
  },
};
rt.register({ name: "android/view/animation/Animation", ctor: JAnimation, methods: animMethods });

/** `p` holds from/to (and pivots) as Description pairs; `pt` their types */
function setDesc(a: JAnimation, vals: number[], types?: number[]) {
  a.p = vals;
  a.pt = types ?? vals.map(() => ABSOLUTE);
}
const SUBCLASS: Record<string, {
  ctors: Record<string, (a: JAnimation, ...args: number[]) => void>;
  apply: (a: JAnimation, t: number, out: JTransformation) => void;
  init?: (a: JAnimation, w: number, h: number, pw: number, ph: number) => void;
}> = {
  AlphaAnimation: {
    ctors: { "(FF)V": (a, f, t) => setDesc(a, [f, t]) },
    apply: (a, t, out) => { out.alpha = a.p[0] + (a.p[1] - a.p[0]) * t; },
  },
  ScaleAnimation: {
    ctors: {
      "(FFFF)V": (a, fx, tx, fy, ty) => setDesc(a, [fx, tx, fy, ty, 0, 0]),
      "(FFFFFF)V": (a, fx, tx, fy, ty, px, py) => setDesc(a, [fx, tx, fy, ty, px, py]),
      "(FFFFIFIF)V": (a, fx, tx, fy, ty, pxt, px, pyt, py) => setDesc(a, [fx, tx, fy, ty, px, py], [0, 0, 0, 0, pxt, pyt]),
    },
    apply: (a, t, out) => {
      const sx = a.p[0] + (a.p[1] - a.p[0]) * t, sy = a.p[2] + (a.p[3] - a.p[2]) * t;
      const px = a.p[4], py = a.p[5];
      out.matrix.m = [sx, 0, 0, sy, px - sx * px, py - sy * py];
    },
    init: (a, w, h, pw, ph) => { a.p[4] = resolveDim(a.pt[4], a.p[4], w, pw); a.p[5] = resolveDim(a.pt[5], a.p[5], h, ph); },
  },
  TranslateAnimation: {
    ctors: {
      "(FFFF)V": (a, fx, tx, fy, ty) => setDesc(a, [fx, tx, fy, ty]),
      "(IFIFIFIF)V": (a, fxt, fx, txt, tx, fyt, fy, tyt, ty) => setDesc(a, [fx, tx, fy, ty], [fxt, txt, fyt, tyt]),
    },
    apply: (a, t, out) => {
      out.matrix.m = [1, 0, 0, 1, a.p[0] + (a.p[1] - a.p[0]) * t, a.p[2] + (a.p[3] - a.p[2]) * t];
    },
    init: (a, w, h, pw, ph) => {
      a.p[0] = resolveDim(a.pt[0], a.p[0], w, pw); a.p[1] = resolveDim(a.pt[1], a.p[1], w, pw);
      a.p[2] = resolveDim(a.pt[2], a.p[2], h, ph); a.p[3] = resolveDim(a.pt[3], a.p[3], h, ph);
    },
  },
  RotateAnimation: {
    ctors: {
      "(FF)V": (a, f, t) => setDesc(a, [f, t, 0, 0]),
      "(FFFF)V": (a, f, t, px, py) => setDesc(a, [f, t, px, py]),
      "(FFIFIF)V": (a, f, t, pxt, px, pyt, py) => setDesc(a, [f, t, px, py], [0, 0, pxt, pyt]),
    },
    apply: (a, t, out) => {
      const deg = a.p[0] + (a.p[1] - a.p[0]) * t, px = a.p[2], py = a.p[3];
      const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
      out.matrix.m = [c, sn, -sn, c, px - c * px + sn * py, py - sn * px - c * py];
    },
    init: (a, w, h, pw, ph) => { a.p[2] = resolveDim(a.pt[2], a.p[2], w, pw); a.p[3] = resolveDim(a.pt[3], a.p[3], h, ph); },
  },
};
for (const n of Object.keys(SUBCLASS)) {
  const spec = SUBCLASS[n];
  const methods: NativeSpec["methods"] = { ...animMethods, ...spec.ctors,
    "applyTransformation(FLandroid/view/animation/Transformation;)V": function (this: JAnimation, t: number, out: JTransformation) { spec.apply(this, t, out); },
  };
  if (spec.init) {
    methods["initialize(IIII)V"] = function (this: JAnimation, w: number, h: number, pw: number, ph: number) {
      if (!this.initialized) spec.init!(this, w, h, pw, ph);
      this.initialized = true;
    };
  }
  rt.register({ name: "android/view/animation/" + n, ctor: class extends JAnimation {}, sup: "android/view/animation/Animation", methods });
}
// An AnimationSet runs its children over the same timeline; each contributes to the same
// Transformation, which is what composing alpha + matrix already does.
rt.register({
  name: "android/view/animation/AnimationSet", ctor: class extends JAnimation {}, sup: "android/view/animation/Animation",
  methods: {
    ...animMethods,
    "<init>(Z)V": function () {},
    "addAnimation(Landroid/view/animation/Animation;)V": function (this: JAnimation, c: JAnimation) {
      this.kids.push(c);
      if (c.duration + c.startOffset > this.duration) this.duration = c.duration + c.startOffset;
    },
    "getAnimations()Ljava/util/List;": function (this: JAnimation) { return newArrayList(this.kids); },
    "initialize(IIII)V": async function (this: JAnimation, w: number, h: number, pw: number, ph: number) {
      this.initialized = true;
      for (const c of this.kids) await vcall(c, "initialize", "(IIII)V", w, h, pw, ph);
    },
    "applyTransformation(FLandroid/view/animation/Transformation;)V": async function (this: JAnimation, t: number, out: JTransformation) {
      for (const c of this.kids) await vcall(c, "applyTransformation", "(FLandroid/view/animation/Transformation;)V", t, out);
    },
  },
});
rt.register({
  name: "android/view/animation/AnimationUtils", ctor: class extends JObj {},
  methods: {
    "static loadAnimation(Landroid/content/Context;I)Landroid/view/animation/Animation;": () => new JAnimation(),
    "static loadInterpolator(Landroid/content/Context;I)Landroid/view/animation/Interpolator;": () =>
      new (rt.link("android/view/animation/LinearInterpolator").ctor)(),
    "static currentAnimationTimeMillis()J": () => BigInt(Math.floor(performance.now())),
  },
});
rt.register({ name: "android/view/animation/Animation$AnimationListener", ctor: class extends JObj {} });

const DOUBLE_TAP_TIMEOUT = 300, DOUBLE_TAP_MIN_TIME = 40, LONG_PRESS_TIMEOUT = 450;
type PendingTap = { down: JMotionEvent; up: JMotionEvent | null; deferred: boolean; cancelled: boolean; timer: ReturnType<typeof setTimeout> };
class JGestureDetector extends JObj {
  l: unknown = null;
  doubleListener: unknown = null;
  down: JMotionEvent | null = null;
  pending: PendingTap | null = null;
  longTimer: ReturnType<typeof setTimeout> | null = null;
  longEnabled = true;
  longPressed = false;
  double = false;
  moved = false;
  lastX = 0; lastY = 0; lastT = 0;
  vx = 0; vy = 0;
  init(listener: unknown) {
    this.l = listener;
    if (rt.iof(listener, "android/view/GestureDetector$OnDoubleTapListener")) this.doubleListener = listener;
  }
  cancelTap() {
    if (this.pending) { this.pending.cancelled = true; clearTimeout(this.pending.timer); this.pending = null; }
  }
  cancelLong() { if (this.longTimer !== null) clearTimeout(this.longTimer); this.longTimer = null; }
  confirm(tap: PendingTap, event: JMotionEvent) {
    if (tap.cancelled || !this.doubleListener) return 0;
    tap.cancelled = true;
    if (this.pending === tap) this.pending = null;
    return vcall(this.doubleListener, "onSingleTapConfirmed", "(Landroid/view/MotionEvent;)Z", event);
  }
  async touch(ev: JMotionEvent): Promise<number> {
    const action = ev.action & 0xff, now = ev.eventTime;
    if (action === 0) {
      const previous = this.pending;
      const delay = previous?.up ? now - previous.up.eventTime : -1;
      this.double = !!(this.doubleListener && previous?.up && delay >= DOUBLE_TAP_MIN_TIME && delay <= DOUBLE_TAP_TIMEOUT
        && Math.hypot(ev.x - previous.down.x, ev.y - previous.down.y) < device.dp(100));
      if (this.double) this.cancelTap();
      this.down = copyEvent(ev); this.lastX = ev.x; this.lastY = ev.y; this.lastT = now;
      this.moved = this.longPressed = false; this.vx = this.vy = 0; this.cancelLong();
      let handled = 0;
      if (this.double) {
        handled |= await vcall(this.doubleListener, "onDoubleTap", "(Landroid/view/MotionEvent;)Z", previous!.down);
        handled |= await vcall(this.doubleListener, "onDoubleTapEvent", "(Landroid/view/MotionEvent;)Z", ev);
      } else if (this.doubleListener) {
        const tap: PendingTap = { down: this.down, up: null, deferred: false, cancelled: false, timer: setTimeout(() => {
          void onMain(async () => {
            if (tap.cancelled) return;
            if (!tap.up) tap.deferred = true; else await this.confirm(tap, tap.down);
          }).catch(reportUncaught);
        }, DOUBLE_TAP_TIMEOUT) };
        this.pending = tap;
      }
      const down = this.down;
      if (this.longEnabled && !this.double) this.longTimer = setTimeout(() => {
        void onMain(async () => {
          if (this.down !== down || this.moved) return;
          this.longPressed = true; this.cancelTap();
          await vcall(this.l, "onLongPress", "(Landroid/view/MotionEvent;)V", this.down);
        }).catch(reportUncaught);
      }, LONG_PRESS_TIMEOUT);
      return handled | await vcall(this.l, "onDown", "(Landroid/view/MotionEvent;)Z", ev);
    }
    if (action === 3 || action === 5) {
      this.cancelTap(); this.cancelLong(); this.down = null; this.double = false; return 0;
    }
    if (!this.down) return 0;
    if (action === 2) {
      if (this.longPressed) return 0;
      if (this.double) return vcall(this.doubleListener, "onDoubleTapEvent", "(Landroid/view/MotionEvent;)Z", ev);
      const dt = Math.max(1, now - this.lastT), dx = this.lastX - ev.x, dy = this.lastY - ev.y;
      this.vx = 0.7 * this.vx + 0.3 * (-dx / dt * 1000); this.vy = 0.7 * this.vy + 0.3 * (-dy / dt * 1000);
      if (!this.moved && Math.hypot(ev.x - this.down.x, ev.y - this.down.y) > device.touchSlop) {
        this.moved = true; this.cancelTap(); this.cancelLong();
      }
      this.lastX = ev.x; this.lastY = ev.y; this.lastT = now;
      return this.moved ? vcall(this.l, "onScroll", "(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z", this.down, ev, dx, dy) : 0;
    }
    if (action === 1) {
      this.cancelLong();
      const down = this.down; this.down = null;
      if (this.double) return vcall(this.doubleListener, "onDoubleTapEvent", "(Landroid/view/MotionEvent;)Z", ev);
      if (this.longPressed) return 0;
      if (!this.moved) {
        const handled = await vcall(this.l, "onSingleTapUp", "(Landroid/view/MotionEvent;)Z", ev);
        if (this.pending) { this.pending.up = copyEvent(ev); if (this.pending.deferred) await this.confirm(this.pending, ev); }
        return handled;
      }
      const idle = now - this.lastT, vx = restVelocity(this.vx, 0.7, idle), vy = restVelocity(this.vy, 0.7, idle);
      return Math.hypot(vx, vy) > 400 ? vcall(this.l, "onFling", "(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z", down, ev, vx, vy) : 0;
    }
    return 0;
  }
}
rt.register({
  name: "android/view/GestureDetector", ctor: JGestureDetector,
  methods: {
    "<init>(Landroid/content/Context;Landroid/view/GestureDetector$OnGestureListener;)V": function (this: JGestureDetector, _c: unknown, l: unknown) { this.init(l); },
    "<init>(Landroid/view/GestureDetector$OnGestureListener;)V": function (this: JGestureDetector, l: unknown) { this.init(l); },
    "<init>(Landroid/content/Context;Landroid/view/GestureDetector$OnGestureListener;Landroid/os/Handler;)V": function (this: JGestureDetector, _c: unknown, l: unknown) { this.init(l); },
    "setIsLongpressEnabled(Z)V": function (this: JGestureDetector, enabled: number) { this.longEnabled = !!enabled; if (!enabled) this.cancelLong(); },
    "setOnDoubleTapListener(Landroid/view/GestureDetector$OnDoubleTapListener;)V": function (this: JGestureDetector, listener: unknown) { this.doubleListener = listener; if (!listener) this.cancelTap(); },
    "onTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JGestureDetector, event: JMotionEvent) { return inMainJob() ? this.touch(event) : onMain(() => this.touch(event)); },
  },
});
rt.register({
  name: "android/view/GestureDetector$SimpleOnGestureListener", ctor: class extends JObj {},
  ifaces: ["android/view/GestureDetector$OnGestureListener", "android/view/GestureDetector$OnDoubleTapListener"],
  methods: {
    "<init>()V": function () {},
    "onDown(Landroid/view/MotionEvent;)Z": () => 0,
    "onSingleTapUp(Landroid/view/MotionEvent;)Z": () => 0,
    "onScroll(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z": () => 0,
    "onFling(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z": () => 0,
    "onLongPress(Landroid/view/MotionEvent;)V": () => {},
    "onShowPress(Landroid/view/MotionEvent;)V": () => {},
    "onSingleTapConfirmed(Landroid/view/MotionEvent;)Z": () => 0,
    "onDoubleTap(Landroid/view/MotionEvent;)Z": () => 0,
    "onDoubleTapEvent(Landroid/view/MotionEvent;)Z": () => 0,
  },
});
rt.register({ name: "android/view/GestureDetector$OnGestureListener", ctor: class extends JObj {} });
rt.register({ name: "android/view/GestureDetector$OnDoubleTapListener", ctor: class extends JObj {} });

// ── GestureStore/GestureLibrary — stubbed (legacy, sometimes touched by old ad SDKs)
rt.register({
  name: "android/gesture/GestureStore", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "load(Ljava/io/InputStream;)V": () => {},
    "load(Ljava/io/InputStream;Z)V": () => {},
    "save(Ljava/io/OutputStream;)V": () => {},
    "getGestureEntries()Ljava/util/Set;": () => newObj("java/util/HashSet", null),
    "recognize(Landroid/gesture/Gesture;)Ljava/util/ArrayList;": () => newArrayList(),
    "addGesture(Ljava/lang/String;Landroid/gesture/Gesture;)V": () => {},
  },
});
for (const n of ["android/gesture/Gesture", "android/gesture/GestureLibrary", "android/gesture/Prediction",
  "android/gesture/GestureLibraries", "android/gesture/GestureOverlayView$OnGesturePerformedListener",
  "android/gesture/GestureOverlayView$OnGestureListener", "android/gesture/GestureOverlayView$OnGesturingListener"]) {
  rt.register({ name: n, ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
}
rt.register({
  name: "android/gesture/GestureOverlayView", ctor: class extends JViewGroup {}, sup: "android/widget/FrameLayout",
  methods: {
    "<init>(Landroid/content/Context;)V": async function (this: any, c: unknown) { await initViewFromCtx(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: any, c: unknown, set: any) { await initViewFromCtx(this, c, set); },
    "addOnGesturePerformedListener(Landroid/gesture/GestureOverlayView$OnGesturePerformedListener;)V": () => {},
    "addOnGestureListener(Landroid/gesture/GestureOverlayView$OnGestureListener;)V": () => {},
    "setGestureVisible(Z)V": () => {},
    "setGestureStrokeType(I)V": () => {},
    "setGestureColor(I)V": () => {},
    "setGestureStrokeWidth(F)V": () => {},
    "setEventsInterceptionEnabled(Z)V": () => {},
    "setFadeOffset(J)V": () => {},
    "cancelGesture()V": () => {}, "clear(Z)V": () => {},
  },
});
