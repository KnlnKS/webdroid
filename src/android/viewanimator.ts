import { type JView, uiState, invalidate } from "./view";
import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { onMain } from "./mainloop";
import { vcall } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";
import { guestNow } from "../guest-clock";
import { accelDecel } from "./interpolator";

// ViewPropertyAnimator: the view's transform/alpha properties animated together from the frame
// loop. As on AOSP the animation starts on the next frame unless start() is called, runs
// duration+delay with the (default accelerate/decelerate) interpolator, and reports through the
// AnimatorListener / AnimatorUpdateListener / withStart|EndAction hooks.
export function mkVPA(v: JView): any {
  const info = rt.link("android/view/ViewPropertyAnimator");
  const o = new info.ctor();
  o.view = v;
  return o;
}
type VpaProp = "alphaV" | "translationX" | "translationY" | "translationZ" | "scaleXv" | "scaleYv" | "rotationV";
const VPA_PROPS: Record<string, VpaProp> = {
  alpha: "alphaV", translationX: "translationX", translationY: "translationY", translationZ: "translationZ",
  scaleX: "scaleXv", scaleY: "scaleYv", rotation: "rotationV",
};
class JVPA extends JObj {
  view: JView | null = null;
  pending = new Map<VpaProp, { to: number; by: boolean }>();
  from = new Map<VpaProp, number>();
  to = new Map<VpaProp, number>();
  durationMs = 300; delayMs = 0;
  interp: unknown = null;
  listener: unknown = null; updateL: unknown = null;
  startAction: unknown = null; endAction: unknown = null;
  running = false; startT = 0; scheduled = false;
  /** the animation object handed to listeners: a ValueAnimator whose fraction tracks ours */
  anim: unknown = null;
}
function vpaSet(this: JVPA, prop: VpaProp, v: number, by = false) {
  this.pending.set(prop, { to: v, by });
  if (!this.scheduled && !this.running) {
    // AOSP: starts on the next frame unless start() is called first
    this.scheduled = true;
    void onMain(async () => { if (this.scheduled) await vpaStart.call(this); });
  }
  return this;
}
async function vpaStart(this: JVPA) {
  this.scheduled = false;
  const v = this.view;
  if (!v || !this.pending.size) return;
  if (this.running) await vpaEnd.call(this, true);
  this.from.clear(); this.to.clear();
  for (const [p, { to, by }] of this.pending) { this.from.set(p, v[p]); this.to.set(p, by ? v[p] + to : to); }
  this.pending.clear();
  this.running = true;
  this.startT = guestNow();
  if (this.startAction) { const r = this.startAction; this.startAction = null; try { await vcall(r, "run", "()V"); } catch (e) { reportUncaught(e); } }
  if (this.listener) try { await vcall(this.listener, "onAnimationStart", "(Landroid/animation/Animator;Z)V", vpaAnim(this), 0); } catch (e) { reportUncaught(e); }
  const self = this;
  // the tick is a main-looper job of its own: two animations ending in one frame must not
  // interleave their end callbacks (RecyclerView's item animator re-enters on that)
  let inflight = false;
  uiState.animHooks.add(function hook() {
    if (!self.running) return false;
    if (!inflight) { inflight = true; void onMain(() => vpaTick.call(self)).finally(() => { inflight = false; }); }
    return self.running;
  });
  invalidate();
}
async function vpaTick(this: JVPA) {
  const v = this.view!;
  const el = guestNow() - this.startT - this.delayMs;
  const t = el <= 0 ? 0 : this.durationMs <= 0 ? 1 : Math.min(1, el / this.durationMs);
  const it = this.interp ? Math.fround(await vcall(this.interp, "getInterpolation", "(F)F", Math.fround(t))) : accelDecel(t);
  for (const [p, to] of this.to) v[p] = this.from.get(p)! + (to - this.from.get(p)!) * it;
  if (this.updateL) try { await vcall(this.updateL, "onAnimationUpdate", "(Landroid/animation/ValueAnimator;)V", vpaAnim(this)); } catch (e) { reportUncaught(e); }
  invalidate();
  if (t >= 1) await vpaEnd.call(this, false);
}
async function vpaEnd(this: JVPA, cancelled: boolean) {
  if (!this.running) return;
  this.running = false;
  const v = this.view!;
  if (!cancelled) for (const [p, to] of this.to) v[p] = to;
  invalidate();
  if (this.listener) {
    try {
      if (cancelled) await vcall(this.listener, "onAnimationCancel", "(Landroid/animation/Animator;)V", vpaAnim(this));
      await vcall(this.listener, "onAnimationEnd", "(Landroid/animation/Animator;Z)V", vpaAnim(this), 0);
    } catch (e) { reportUncaught(e); }
  }
  if (this.endAction && !cancelled) { const r = this.endAction; this.endAction = null; try { await vcall(r, "run", "()V"); } catch (e) { reportUncaught(e); } }
  else if (cancelled) this.endAction = null;
}
function vpaAnim(a: JVPA): unknown {
  if (!a.anim) {
    const o = rt.make("android/animation/ValueAnimator");
    o.durationMs = a.durationMs; o.delayMs = a.delayMs;
    a.anim = o;
  }
  return a.anim;
}
const VPA = "Landroid/view/ViewPropertyAnimator;";
const vpaMethods: NonNullable<NativeSpec["methods"]> = {
  [`setDuration(J)${VPA}`]: function (this: JVPA, d: bigint) { this.durationMs = Number(d); return this; },
  "getDuration()J": function (this: JVPA) { return BigInt(this.durationMs); },
  [`setStartDelay(J)${VPA}`]: function (this: JVPA, d: bigint) { this.delayMs = Number(d); return this; },
  "getStartDelay()J": function (this: JVPA) { return BigInt(this.delayMs); },
  [`setInterpolator(Landroid/animation/TimeInterpolator;)${VPA}`]: function (this: JVPA, i: unknown) { this.interp = i; return this; },
  "getInterpolator()Landroid/animation/TimeInterpolator;": function (this: JVPA) { return this.interp; },
  [`setListener(Landroid/animation/Animator$AnimatorListener;)${VPA}`]: function (this: JVPA, l: unknown) { this.listener = l; return this; },
  [`setUpdateListener(Landroid/animation/ValueAnimator$AnimatorUpdateListener;)${VPA}`]: function (this: JVPA, l: unknown) { this.updateL = l; return this; },
  [`withStartAction(Ljava/lang/Runnable;)${VPA}`]: function (this: JVPA, r: unknown) { this.startAction = r; return this; },
  [`withEndAction(Ljava/lang/Runnable;)${VPA}`]: function (this: JVPA, r: unknown) { this.endAction = r; return this; },
  [`withLayer()${VPA}`]: function (this: JVPA) { return this; },
  "start()V": function (this: JVPA) { return vpaStart.call(this); },
  "cancel()V": function (this: JVPA) { this.pending.clear(); this.scheduled = false; return vpaEnd.call(this, true); },
  // x/y are absolute: the translation that puts the view's left/top there
  [`x(F)${VPA}`]: function (this: JVPA, x: number) { return vpaSet.call(this, "translationX", x - (this.view?.left ?? 0)); },
  [`y(F)${VPA}`]: function (this: JVPA, y: number) { return vpaSet.call(this, "translationY", y - (this.view?.top ?? 0)); },
  [`xBy(F)${VPA}`]: function (this: JVPA, x: number) { return vpaSet.call(this, "translationX", x, true); },
  [`yBy(F)${VPA}`]: function (this: JVPA, y: number) { return vpaSet.call(this, "translationY", y, true); },
};
for (const [name, prop] of Object.entries(VPA_PROPS)) {
  vpaMethods[`${name}(F)${VPA}`] = function (this: JVPA, v: number) { return vpaSet.call(this, prop, v); };
  vpaMethods[`${name}By(F)${VPA}`] = function (this: JVPA, v: number) { return vpaSet.call(this, prop, v, true); };
}
vpaMethods[`rotationX(F)${VPA}`] = vpaMethods[`rotationY(F)${VPA}`] = function (this: JVPA) { return this; };
vpaMethods[`rotationXBy(F)${VPA}`] = vpaMethods[`rotationYBy(F)${VPA}`] = function (this: JVPA) { return this; };
rt.register({ name: "android/view/ViewPropertyAnimator", ctor: JVPA, methods: vpaMethods });
