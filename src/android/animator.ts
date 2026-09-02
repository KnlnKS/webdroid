// android.animation: ValueAnimator/ObjectAnimator/AnimatorSet, driven from the frame loop via uiState.animHooks.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, boxInt, box, JFloat } from "../jvm/natives/jlang";
import { toJsArray } from "../jvm/natives/jutil";
import { uiState, invalidate, JView, guardCall } from "./view";
import { reportUncaught } from "./os";

// ── ValueAnimator/ObjectAnimator (time-driven via animHooks)
class JValueAnimator extends JObj {
  from = 0; to = 1;
  durationMs = 300;
  startT = 0;
  running = false;
  updateLs: unknown[] = [];
  animLs: unknown[] = [];
  cur: unknown = 0;
  isInt = false;
  target: unknown = null; // ObjectAnimator
  propName = "";
  repeat = 0;
  frac = 0;
}
async function animTick(a: JValueAnimator): Promise<boolean> {
  const t = Math.min(1, (performance.now() - a.startT) / a.durationMs);
  a.frac = t;
  const v = a.from + (a.to - a.from) * (1 - Math.pow(1 - t, 2));
  a.cur = a.isInt ? Math.round(v) : v;
  if (a.target && a.propName) {
    await applyAnimProp(a.target, a.propName, a.cur as number);
  }
  for (const l of a.updateLs) {
    try { await vcall(l, "onAnimationUpdate", "(Landroid/animation/ValueAnimator;)V", a); } catch (e) { reportUncaught(e); }
  }
  invalidate();
  if (t >= 1) {
    a.running = false;
    for (const l of a.animLs) {
      try { await vcall(l, "onAnimationEnd", "(Landroid/animation/Animator;)V", a); } catch (e) { reportUncaught(e); }
    }
    return false;
  }
  return true;
}
// View properties animated straight onto the native fields; anything else goes through setXxx
const VIEW_ANIM_PROPS: Record<string, keyof JView & ("alphaV" | "translationX" | "translationY" | "scaleXv" | "scaleYv" | "rotationV")> = {
  alpha: "alphaV", translationX: "translationX", translationY: "translationY", scaleX: "scaleXv", scaleY: "scaleYv", rotation: "rotationV",
};
async function applyAnimProp(target: unknown, prop: string, v: number) {
  const field = VIEW_ANIM_PROPS[prop];
  if (field && target instanceof JView) { target[field] = v; return; }
  const setter = "set" + prop[0].toUpperCase() + prop.slice(1);
  try { await vcall(target, setter, "(F)V", v); }
  catch {
    try { await vcall(target, setter, "(I)V", Math.round(v)); } catch { /* */ }
  }
}
function setDur(this: JValueAnimator, d: bigint) {
  this.durationMs = Number(d);
  return this;
}
const vaMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "setDuration(J)Landroid/animation/ValueAnimator;": setDur,
  "setDuration(J)Landroid/animation/Animator;": setDur,
  "getDuration()J": function (this: JValueAnimator) { return BigInt(this.durationMs); },
  "setInterpolator(Landroid/animation/TimeInterpolator;)V": () => {},
  "setInterpolator(Landroid/view/animation/Interpolator;)V": () => {},
  "setStartDelay(J)V": () => {},
  "setRepeatCount(I)V": function (this: JValueAnimator, n: number) { this.repeat = n; },
  "setRepeatMode(I)V": () => {},
  "addUpdateListener(Landroid/animation/ValueAnimator$AnimatorUpdateListener;)V": function (this: JValueAnimator, l: unknown) {
    this.updateLs.push(l);
  },
  "addListener(Landroid/animation/Animator$AnimatorListener;)V": function (this: JValueAnimator, l: unknown) {
    this.animLs.push(l);
  },
  "removeAllListeners()V": function (this: JValueAnimator) { this.animLs.length = 0; },
  "removeAllUpdateListeners()V": function (this: JValueAnimator) { this.updateLs.length = 0; },
  "start()V": async function (this: JValueAnimator) {
    this.startT = performance.now();
    this.running = true;
    for (const l of this.animLs) {
      try { await vcall(l, "onAnimationStart", "(Landroid/animation/Animator;)V", this); } catch (e) { reportUncaught(e); }
    }
    const self = this;
    const hook = () => {
      if (!self.running) return false;
      void animTick(self);
      return self.running;
    };
    uiState.animHooks.add(hook);
    invalidate();
  },
  "cancel()V": async function (this: JValueAnimator) {
    this.running = false;
    for (const l of this.animLs) {
      try { await vcall(l, "onAnimationCancel", "(Landroid/animation/Animator;)V", this); } catch (e) { reportUncaught(e); }
    }
  },
  "end()V": function (this: JValueAnimator) { this.running = false; },
  "isRunning()Z": function (this: JValueAnimator) { return this.running ? 1 : 0; },
  "isStarted()Z": function (this: JValueAnimator) { return this.running ? 1 : 0; },
  "getAnimatedValue()Ljava/lang/Object;": function (this: JValueAnimator) {
    return this.isInt ? boxInt(this.cur as number) : box(JFloat, this.cur as number);
  },
  "getAnimatedFraction()F": function (this: JValueAnimator) { return this.frac; },
  "static ofFloat([F)Landroid/animation/ValueAnimator;": (vals: Float32Array) => {
    const a = new JValueAnimator();
    a.from = vals[0] ?? 0;
    a.to = vals[vals.length - 1] ?? 1;
    return a;
  },
  "static ofInt([I)Landroid/animation/ValueAnimator;": (vals: Int32Array) => {
    const a = new JValueAnimator();
    a.from = vals[0] ?? 0;
    a.to = vals[vals.length - 1] ?? 1;
    a.isInt = true;
    return a;
  },
};
rt.register({ name: "android/animation/Animator", ctor: class extends JValueAnimator {}, methods: vaMethods });
rt.register({ name: "android/animation/ValueAnimator", ctor: JValueAnimator, sup: "android/animation/Animator", methods: vaMethods });
rt.register({
  name: "android/animation/ObjectAnimator", ctor: class extends JValueAnimator {}, sup: "android/animation/ValueAnimator",
  methods: {
    ...vaMethods,
    // R8/javac narrow the return type at ObjectAnimator call sites, so the mangled name
    // differs from the ValueAnimator/Animator overloads above and needs its own entry.
    "setDuration(J)Landroid/animation/ObjectAnimator;": setDur,
    "static ofFloat(Ljava/lang/Object;Ljava/lang/String;[F)Landroid/animation/ObjectAnimator;":
      (target: unknown, prop: string, vals: Float32Array) => {
        const a = new (rt.link("android/animation/ObjectAnimator").ctor)();
        a.target = target;
        a.propName = prop;
        a.from = vals.length > 1 ? vals[0] : 0;
        a.to = vals[vals.length - 1] ?? 0;
        return a;
      },
    "static ofInt(Ljava/lang/Object;Ljava/lang/String;[I)Landroid/animation/ObjectAnimator;":
      (target: unknown, prop: string, vals: Int32Array) => {
        const a = new (rt.link("android/animation/ObjectAnimator").ctor)();
        a.target = target;
        a.propName = prop;
        a.isInt = true;
        a.from = vals.length > 1 ? vals[0] : 0;
        a.to = vals[vals.length - 1] ?? 0;
        return a;
      },
    "setPropertyName(Ljava/lang/String;)V": function (this: any, p: string) { this.propName = p; },
  },
});
rt.register({
  name: "android/animation/AnimatorSet", ctor: class extends JValueAnimator { anims: JValueAnimator[] = []; }, sup: "android/animation/Animator",
  methods: {
    ...vaMethods,
    "setDuration(J)Landroid/animation/AnimatorSet;": setDur,
    "playTogether([Landroid/animation/Animator;)V": function (this: any, arr: JValueAnimator[]) { this.anims = [...(arr ?? [])]; },
    "playTogether(Ljava/util/Collection;)V": async function (this: any, c: unknown) { this.anims = [...await toJsArray(c)] as JValueAnimator[]; },
    "playSequentially([Landroid/animation/Animator;)V": function (this: any, arr: JValueAnimator[]) { this.anims = [...(arr ?? [])]; },
    "start()V": async function (this: any) {
      for (const a of this.anims) await guardCall(a[M_start], a);
      for (const l of this.animLs) {
        setTimeout(() => void vcall(l, "onAnimationEnd", "(Landroid/animation/Animator;)V", this).catch(reportUncaught), this.durationMs || 300);
      }
    },
  },
});
const M_start = mangleMethod("start", "()V");
rt.register({ name: "android/animation/Animator$AnimatorListener", ctor: class extends JObj {} });
rt.register({
  name: "android/animation/AnimatorListenerAdapter", ctor: class extends JObj {},
  ifaces: ["android/animation/Animator$AnimatorListener"],
  methods: {
    "<init>()V": function () {},
    "onAnimationStart(Landroid/animation/Animator;)V": () => {},
    "onAnimationEnd(Landroid/animation/Animator;)V": () => {},
    "onAnimationCancel(Landroid/animation/Animator;)V": () => {},
    "onAnimationRepeat(Landroid/animation/Animator;)V": () => {},
  },
});
