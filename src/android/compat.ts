// Scrolling physics, view configuration, legacy animation classes, misc widgets' helpers.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jlang";
import { invalidate, JViewGroup, initViewFromCtx } from "./view";
import { newArrayList } from "../jvm/natives/jutil";
import { device } from "../shell/config";

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
    this.duration = Math.min(1200, 300 + Math.hypot(vx, vy) / 8);
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

// VelocityTracker
class JVelocityTracker extends JObj {
  samples: { x: number; y: number; t: number }[] = [];
  vx = 0; vy = 0;
  compute(units: number, max = Infinity) {
    const n = this.samples.length;
    if (n < 2) { this.vx = 0; this.vy = 0; return; }
    const a = this.samples[Math.max(0, n - 6)], b = this.samples[n - 1];
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

// ViewConfiguration
class JViewConfiguration extends JObj {}
const vc = new JViewConfiguration();
rt.register({
  name: "android/view/ViewConfiguration", ctor: JViewConfiguration,
  methods: {
    "static get(Landroid/content/Context;)Landroid/view/ViewConfiguration;": () => vc,
    "getScaledTouchSlop()I": () => 16,
    "getScaledPagingTouchSlop()I": () => 32,
    "getScaledMinimumFlingVelocity()I": () => 100,
    "getScaledMaximumFlingVelocity()I": () => 16000,
    "getScaledMinimumFlingVelocity(III)I": () => 100,
    "getScaledMaximumFlingVelocity(III)I": () => 16000,
    // AOSP: 64dp per wheel/keyboard scroll unit
    "getScaledHorizontalScrollFactor()F": () => 64 * device.density,
    "getScaledVerticalScrollFactor()F": () => 64 * device.density,
    "getScaledHoverSlop()I": () => 8,
    "getScaledFadingEdgeLength()I": () => Math.round(12 * device.density),
    "getScaledMinScalingSpan()I": () => Math.round(27 * device.density),
    "shouldShowMenuShortcutsWhenKeyboardPresent()Z": () => 0,
    "static getAmbiguousGestureMultiplier()F": () => 2,
    "static getMinimumFlingVelocity()I": () => 50,
    "static getMaximumFlingVelocity()I": () => 8000,
    "getScaledOverscrollDistance()I": () => 0,
    "getScaledOverflingDistance()I": () => 12,
    "getScaledEdgeSlop()I": () => 24,
    "getScaledWindowTouchSlop()I": () => 32,
    "getScaledDoubleTapSlop()I": () => 200,
    "getScaledScrollBarSize()I": () => 8,
    "hasPermanentMenuKey()Z": () => 0,
    "static getScrollBarSize()I": () => 8,
    "static getDoubleTapTimeout()I": () => 300,
    "static getTapTimeout()I": () => 100,
    "static getLongPressTimeout()I": () => 450,
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

// legacy animation Interpolators + Animation classes (instant-complete)
for (const n of ["android/view/animation/Interpolator", "android/animation/TimeInterpolator"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}
for (const n of ["AccelerateDecelerateInterpolator", "AccelerateInterpolator", "DecelerateInterpolator",
  "LinearInterpolator", "OvershootInterpolator", "AnticipateInterpolator", "BounceInterpolator",
  "AnticipateOvershootInterpolator", "PathInterpolator"]) {
  rt.register({
    name: "android/view/animation/" + n, ctor: class extends JObj {},
    ifaces: ["android/view/animation/Interpolator", "android/animation/TimeInterpolator"],
    methods: {
      "<init>()V": function () {},
      "<init>(F)V": function () {},
      "<init>(FF)V": function () {},
      "<init>(FFFF)V": function () {},
      "<init>(Landroid/graphics/Path;)V": function () {},
      "getInterpolation(F)F": (t: number) => t,
    },
  });
}
class JAnimation extends JObj {
  listener: unknown = null;
  durationMs = 200n;
}
const animMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function () {},
  "<init>(FFFF)V": function () {},
  "<init>(IFIFIFIF)V": function () {},
  "<init>(FFFFIFIF)V": function () {},
  "<init>(FFIFIF)V": function () {},
  "<init>(FF)V": function () {},
  "setDuration(J)V": function (this: JAnimation, d: bigint) { this.durationMs = d; },
  "getDuration()J": function (this: JAnimation) { return this.durationMs; },
  "setStartOffset(J)V": () => {},
  "setInterpolator(Landroid/view/animation/Interpolator;)V": () => {},
  "setFillAfter(Z)V": () => {},
  "setFillBefore(Z)V": () => {},
  "setRepeatCount(I)V": () => {},
  "setRepeatMode(I)V": () => {},
  "setAnimationListener(Landroid/view/animation/Animation$AnimationListener;)V": function (this: JAnimation, l: unknown) {
    this.listener = l;
    // instant completion: fire start+end on next frames
    if (l) {
      setTimeout(() => {
        void (async () => {
          try {
            await vcall(l, "onAnimationStart", "(Landroid/view/animation/Animation;)V", this);
            await vcall(l, "onAnimationEnd", "(Landroid/view/animation/Animation;)V", this);
          } catch (e) { console.warn("[anim]", e); }
        })();
      }, 30);
    }
  },
  "start()V": () => {},
  "startNow()V": () => {},
  "cancel()V": () => {},
  "reset()V": () => {},
  "hasEnded()Z": () => 1,
  "hasStarted()Z": () => 1,
};
rt.register({ name: "android/view/animation/Animation", ctor: JAnimation, methods: animMethods });
for (const n of ["AlphaAnimation", "TranslateAnimation", "ScaleAnimation", "RotateAnimation", "AnimationSet"]) {
  rt.register({
    name: "android/view/animation/" + n, ctor: class extends JAnimation {}, sup: "android/view/animation/Animation",
    methods: {
      ...animMethods,
      "<init>(Z)V": function () {},
      "addAnimation(Landroid/view/animation/Animation;)V": () => {},
    },
  });
}
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

// GestureDetector: tap/longpress/fling recognition over raw events
class JGestureDetector extends JObj {
  l: unknown = null;
  downX = 0; downY = 0; downT = 0;
  moved = false;
  lastX = 0; lastY = 0; lastT = 0;
  vx = 0; vy = 0;
}
rt.register({
  name: "android/view/GestureDetector", ctor: JGestureDetector,
  methods: {
    "<init>(Landroid/content/Context;Landroid/view/GestureDetector$OnGestureListener;)V":
      function (this: JGestureDetector, c: unknown, l: unknown) { this.l = l; },
    "<init>(Landroid/view/GestureDetector$OnGestureListener;)V": function (this: JGestureDetector, l: unknown) { this.l = l; },
    "<init>(Landroid/content/Context;Landroid/view/GestureDetector$OnGestureListener;Landroid/os/Handler;)V":
      function (this: JGestureDetector, c: unknown, l: unknown) { this.l = l; },
    "setIsLongpressEnabled(Z)V": () => {},
    "setOnDoubleTapListener(Landroid/view/GestureDetector$OnDoubleTapListener;)V": () => {},
    "onTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: JGestureDetector, ev: any) {
      const a = ev.action & 0xff;
      const now = performance.now();
      if (a === 0) {
        this.downX = this.lastX = ev.x; this.downY = this.lastY = ev.y;
        this.downT = this.lastT = now;
        this.moved = false;
        this.vx = this.vy = 0;
        await vcall(this.l, "onDown", "(Landroid/view/MotionEvent;)Z", ev);
        return 1;
      }
      if (a === 2) {
        const dt = Math.max(1, now - this.lastT);
        this.vx = 0.7 * this.vx + 0.3 * ((ev.x - this.lastX) / dt * 1000);
        this.vy = 0.7 * this.vy + 0.3 * ((ev.y - this.lastY) / dt * 1000);
        const dx = this.lastX - ev.x, dy = this.lastY - ev.y;
        if (!this.moved && Math.hypot(ev.x - this.downX, ev.y - this.downY) > 16) this.moved = true;
        if (this.moved) {
          await vcall(this.l, "onScroll", "(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z", ev, ev, dx, dy);
        }
        this.lastX = ev.x; this.lastY = ev.y; this.lastT = now;
        return 1;
      }
      if (a === 1) {
        if (!this.moved && now - this.downT < 300) {
          await vcall(this.l, "onSingleTapUp", "(Landroid/view/MotionEvent;)Z", ev);
        } else if (this.moved && Math.hypot(this.vx, this.vy) > 400) {
          await vcall(this.l, "onFling", "(Landroid/view/MotionEvent;Landroid/view/MotionEvent;FF)Z", ev, ev, this.vx, this.vy);
        }
        return 1;
      }
      return 0;
    },
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
