import { JObj, rt, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JGestureDetector, JSimpleGestureListener, minimumScalingSpan } from "./compat";
import { type JMotionEvent } from "./motionevent";
import { device } from "../shell/config";
import { inMainJob, onMain } from "./mainloop";

class JScaleGestureDetector extends JObj {
  listener: unknown = null;
  quick = false; stylus = false; inProgress = false;
  detector: JGestureDetector | null = null;
  spanSlop = 0; minSpan = 0; initialSpan = 0;
  span = 0; spanX = 0; spanY = 0;
  prevSpan = 0; prevSpanX = 0; prevSpanY = 0;
  time = 0; prevTime = 0;
  focusX = 0; focusY = 0;
  anchor = 0; anchorX = 0; anchorY = 0; above = false;
  init(context: unknown, listener: unknown): unknown { return rt.drive(this.init$(context, listener)); }
  *init$(context: unknown, listener: unknown): Gen {
    if (!context || !listener) return rt.npe();
    this.listener = listener;
    this.spanSlop = device.touchSlop * 2; this.minSpan = minimumScalingSpan();
    const info = (yield vcall(context, "getApplicationInfo", "()Landroid/content/pm/ApplicationInfo;"));
    this.setQuick(info.targetSdkVersion > 18); this.stylus = info.targetSdkVersion > 22;
  }
  setQuick(enabled: boolean) {
    this.quick = enabled;
    if (enabled && !this.detector) {
      const listener = rt.make("webdroid/ScaleDoubleTapListener") as JScaleDoubleTapListener;
      listener.scale = this;
      this.detector = new JGestureDetector(); this.detector.init(listener);
    }
  }
  previous() {
    this.prevSpan = this.span; this.prevSpanX = this.spanX; this.prevSpanY = this.spanY; this.prevTime = this.time;
  }
  touch(event: JMotionEvent): number | Promise<number> { return rt.drive(this.touch$(event)); }
  *touch$(event: JMotionEvent): Gen<number> {
    this.time = event.eventTime;
    const action = event.action & 255;
    if (this.quick) yield this.detector!.touch(event);
    const count: number = (yield vcall(event, "getPointerCount", "()I"));
    const button = ((yield vcall(event, "getButtonState", "()I")) & 32) !== 0;
    const cancelled = this.anchor === 2 && !button, complete = action === 1 || action === 3 || cancelled;
    if (action === 0 || complete) {
      if (this.inProgress) {
        yield vcall(this.listener, "onScaleEnd", "(Landroid/view/ScaleGestureDetector;)V", this);
        this.inProgress = false; this.initialSpan = 0; this.anchor = 0;
      } else if (this.anchor && complete) { this.initialSpan = 0; this.anchor = 0; }
      if (complete) return 1;
    }
    if (!this.inProgress && this.stylus && !this.anchor && button) {
      this.anchorX = event.x; this.anchorY = event.y; this.anchor = 2; this.initialSpan = 0;
    }
    const changed = action === 0 || action === 5 || action === 6 || cancelled;
    const skip = action === 6 ? (event.action >> 8) & 255 : -1, div = count - +(skip >= 0);
    let x = 0, y = 0, dx = 0, dy = 0;
    if (this.anchor) { x = this.anchorX; y = this.anchorY; this.above = event.y < y; }
    else {
      for (let i = 0; i < count; i++) if (i !== skip) {
        x += (yield vcall(event, "getX", "(I)F", i)); y += (yield vcall(event, "getY", "(I)F", i));
      }
      x /= div; y /= div;
    }
    for (let i = 0; i < count; i++) if (i !== skip) {
      dx += Math.abs((yield vcall(event, "getX", "(I)F", i)) - x);
      dy += Math.abs((yield vcall(event, "getY", "(I)F", i)) - y);
    }
    const spanX = dx * 2 / div, spanY = dy * 2 / div, span = this.anchor ? spanY : Math.hypot(spanX, spanY);
    const wasInProgress = this.inProgress;
    this.focusX = x; this.focusY = y;
    if (!this.anchor && this.inProgress && (span < this.minSpan || changed)) {
      yield vcall(this.listener, "onScaleEnd", "(Landroid/view/ScaleGestureDetector;)V", this);
      this.inProgress = false; this.initialSpan = span;
    }
    if (changed) {
      this.prevSpanX = this.spanX = spanX; this.prevSpanY = this.spanY = spanY;
      this.initialSpan = this.prevSpan = this.span = span;
    }
    if (!this.inProgress && span >= (this.anchor ? this.spanSlop : this.minSpan)
      && (wasInProgress || Math.abs(span - this.initialSpan) > this.spanSlop)) {
      this.spanX = spanX; this.spanY = spanY; this.span = span; this.previous();
      this.inProgress = !!(yield vcall(this.listener, "onScaleBegin", "(Landroid/view/ScaleGestureDetector;)Z", this));
    }
    if (action === 2) {
      this.spanX = spanX; this.spanY = spanY; this.span = span;
      if (!this.inProgress || (yield vcall(this.listener, "onScale", "(Landroid/view/ScaleGestureDetector;)Z", this))) this.previous();
    }
    return 1;
  }
  factor(): number {
    if (!this.anchor) return this.prevSpan > 0 ? this.span / this.prevSpan : 1;
    if (this.prevSpan <= this.spanSlop) return 1;
    const up = this.above ? this.span < this.prevSpan : this.span > this.prevSpan;
    return 1 + (up ? 1 : -1) * Math.abs(1 - this.span / this.prevSpan) * 0.5;
  }
}
class JScaleDoubleTapListener extends JSimpleGestureListener { scale!: JScaleGestureDetector; }
rt.register({ name: "webdroid/ScaleDoubleTapListener", ctor: JScaleDoubleTapListener,
  sup: "android/view/GestureDetector$SimpleOnGestureListener", methods: {
    "onDoubleTap(Landroid/view/MotionEvent;)Z": function (this: JScaleDoubleTapListener, event: JMotionEvent) {
      this.scale.anchorX = event.x; this.scale.anchorY = event.y; this.scale.anchor = 1; return 1;
    },
  },
});
rt.markers("android/view/ScaleGestureDetector$OnScaleGestureListener");
rt.register({ name: "android/view/ScaleGestureDetector$SimpleOnScaleGestureListener", ctor: class extends JObj {},
  ifaces: ["android/view/ScaleGestureDetector$OnScaleGestureListener"], methods: {
    "<init>()V": function () {}, "onScale(Landroid/view/ScaleGestureDetector;)Z": () => 0,
    "onScaleBegin(Landroid/view/ScaleGestureDetector;)Z": () => 1, "onScaleEnd(Landroid/view/ScaleGestureDetector;)V": function () {},
  },
});
rt.register({ name: "android/view/ScaleGestureDetector", ctor: JScaleGestureDetector, methods: {
  "<init>(Landroid/content/Context;Landroid/view/ScaleGestureDetector$OnScaleGestureListener;)V": function (this: JScaleGestureDetector, c: unknown, l: unknown) { return this.init(c, l); },
  "<init>(Landroid/content/Context;Landroid/view/ScaleGestureDetector$OnScaleGestureListener;Landroid/os/Handler;)V": function (this: JScaleGestureDetector, c: unknown, l: unknown) { return this.init(c, l); },
  "onTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JScaleGestureDetector, event: JMotionEvent) { return inMainJob() ? this.touch(event) : onMain(() => this.touch(event)); },
  "isInProgress()Z": function (this: JScaleGestureDetector) { return +this.inProgress; },
  "setQuickScaleEnabled(Z)V": function (this: JScaleGestureDetector, enabled: number) { this.setQuick(!!enabled); },
  "isQuickScaleEnabled()Z": function (this: JScaleGestureDetector) { return +this.quick; },
  "setStylusScaleEnabled(Z)V": function (this: JScaleGestureDetector, enabled: number) { this.stylus = !!enabled; },
  "isStylusScaleEnabled()Z": function (this: JScaleGestureDetector) { return +this.stylus; },
  "getFocusX()F": function (this: JScaleGestureDetector) { return this.focusX; },
  "getFocusY()F": function (this: JScaleGestureDetector) { return this.focusY; },
  "getCurrentSpan()F": function (this: JScaleGestureDetector) { return this.span; },
  "getCurrentSpanX()F": function (this: JScaleGestureDetector) { return this.spanX; },
  "getCurrentSpanY()F": function (this: JScaleGestureDetector) { return this.spanY; },
  "getPreviousSpan()F": function (this: JScaleGestureDetector) { return this.prevSpan; },
  "getPreviousSpanX()F": function (this: JScaleGestureDetector) { return this.prevSpanX; },
  "getPreviousSpanY()F": function (this: JScaleGestureDetector) { return this.prevSpanY; },
  "getScaleFactor()F": function (this: JScaleGestureDetector) { return this.factor(); },
  "getTimeDelta()J": function (this: JScaleGestureDetector) { return BigInt(Math.round(this.time - this.prevTime)); },
  "getEventTime()J": function (this: JScaleGestureDetector) { return BigInt(Math.round(this.time)); },
} });
