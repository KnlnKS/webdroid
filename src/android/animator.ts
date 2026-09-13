// android.animation: ValueAnimator/ObjectAnimator/AnimatorSet, driven from the frame loop via uiState.animHooks.

import { rt, JObj, type NativeSpec, stubs, noops, fieldGetters, flagGetters, fieldSetters } from "../jvm/runtime";
import { mangleMethod, jarray } from "../jvm/abi";
import { vcall, vcallMaybe, boxInt, box, JFloat } from "../jvm/natives/jlang";
import { toJsArray, newArrayList } from "../jvm/natives/jutil";
import { uiState, invalidate, JView, guardCall } from "./view";
import { reportUncaught } from "./os";
import { stateSetMatches } from "./util";
import { onMain } from "./mainloop";
import { parseAXML, TV, type XmlNode, type XmlAttr } from "./axml";
import { type Resources, type RV, attrTable, T_STR, normRV, rvFloat, rvInt } from "./res";
import type { JContext } from "./context";
import { JRect } from "./graphics";

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
  /** an android.util.Property target (ObjectAnimator.ofFloat(Object, Property, ...)) */
  prop: unknown = null;
  repeat = 0;
  frac = 0;
  delayMs = 0;
  /** a sequential AnimatorSet chains its children through here */
  next: JValueAnimator | null = null;
  /** multi-keyframe numeric values (from/to mirror the first/last); object keyframes go with an evaluator */
  keys: number[] | null = null;
  objKeys: unknown[] | null = null;
  evaluator: unknown = null;
  interp: unknown = null;
  repeatMode = 1; // RESTART
  paused = false; pausedAt = 0;
  reversed = false; startReversed = false;
  /** ofPropertyValuesHolder: every holder is applied to the target each tick */
  holders: JPVH[] = [];
}
/** the value at fraction t of a keyframe list, piecewise linear */
function keyAt(keys: number[], t: number): number {
  const n = keys.length;
  if (n < 2) return keys[0] ?? 0;
  const pos = t * (n - 1), i = Math.min(n - 2, Math.floor(pos)), f = pos - i;
  return keys[i] + (keys[i + 1] - keys[i]) * f;
}
function keyAtFractions(keys: number[], fractions: number[] | null, t: number): number {
  if (!fractions || fractions.length !== keys.length) return keyAt(keys, t);
  let i = 0;
  while (i + 1 < fractions.length && t > fractions[i + 1]) i++;
  if (i + 1 >= keys.length) return keys.at(-1) ?? 0;
  const span = fractions[i + 1] - fractions[i];
  const f = span > 0 ? (t - fractions[i]) / span : 0;
  return keys[i] + (keys[i + 1] - keys[i]) * Math.max(0, Math.min(1, f));
}
async function objAt(a: { objKeys: unknown[] | null; evaluator: unknown }, t: number): Promise<unknown> {
  const keys = a.objKeys!, n = keys.length;
  if (n < 2) return keys[0] ?? null;
  const pos = t * (n - 1), i = Math.min(n - 2, Math.floor(pos)), f = pos - i;
  return a.evaluator ? vcall(a.evaluator, "evaluate", "(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", Math.fround(f), keys[i], keys[i + 1]) : keys[i + 1];
}
/** AOSP's default AccelerateDecelerateInterpolator */
const accelDecel = (t: number) => Math.cos((t + 1) * Math.PI) / 2 + 0.5;
async function animTick(a: JValueAnimator): Promise<boolean> {
  if (a.paused) return true;
  const el = performance.now() - a.startT - a.delayMs;
  let t: number, done = false;
  if (el < 0) t = 0;
  else if (a.durationMs <= 0) { t = 1; done = true; }
  else {
    const cycles = el / a.durationMs;
    let iter = Math.floor(cycles);
    t = cycles - iter;
    // repeat: -1 is INFINITE; otherwise the animation ends after `repeat` extra cycles
    if (a.repeat >= 0 && iter > a.repeat) { iter = a.repeat; t = 1; done = true; }
    if (a.repeatMode === 2 && iter % 2 === 1) t = 1 - t;
  }
  if (a.reversed) t = 1 - t;
  a.frac = t;
  const it = a.interp ? Math.fround(await vcall(a.interp, "getInterpolation", "(F)F", Math.fround(t))) : accelDecel(t);
  if (a.objKeys) a.cur = await objAt(a, it);
  else {
    const v = a.keys ? keyAt(a.keys, it) : a.from + (a.to - a.from) * it;
    a.cur = a.isInt ? Math.round(v) : v;
  }
  if (a.target) {
    if (a.holders.length) for (const h of a.holders) await applyHolder(a.target, h, it);
    else if (a.prop) await vcall(a.prop, "set", "(Ljava/lang/Object;Ljava/lang/Object;)V", a.target, boxedCur(a));
    else if (a.propName) {
      if (a.objKeys) await applyAnimObj(a.target, a.propName, a.cur);
      else await applyAnimProp(a.target, a.propName, a.cur as number);
    }
  }
  for (const l of [...a.updateLs]) {
    try { await vcall(l, "onAnimationUpdate", "(Landroid/animation/ValueAnimator;)V", a); } catch (e) { reportUncaught(e); }
  }
  invalidate();
  if (done) {
    a.running = false;
    for (const l of [...a.animLs]) {
      try { await vcall(l, "onAnimationEnd", "(Landroid/animation/Animator;)V", a); } catch (e) { reportUncaught(e); }
    }
    if (a.next) await guardCall(a.next, M_start);
    return false;
  }
  return true;
}
function boxedCur(a: { cur: unknown; isInt: boolean; objKeys: unknown[] | null }): unknown {
  return a.objKeys ? a.cur : a.isInt ? boxInt(a.cur as number) : box(JFloat, a.cur as number);
}
/** ObjectAnimator.ofObject(target, "name", ...): the setter takes the evaluated object */
async function applyAnimObj(target: unknown, prop: string, v: unknown) {
  const setter = "set" + prop[0].toUpperCase() + prop.slice(1);
  if (v && typeof v === "object" && "v" in (v as object)) {
    const raw = (v as { v: unknown }).v;
    if (typeof raw === "number") return applyAnimProp(target, prop, raw);
  }
  try { await vcall(target, setter, "(Ljava/lang/Object;)V", v); } catch { /* */ }
}
// A holder that names neither a Property nor a property has nothing to set: its value is read
// back through getAnimatedValue, which is what a plain ValueAnimator is for.
async function applyHolder(target: unknown, h: JPVH, t: number) {
  if (h.objKeys) {
    h.cur = await objAt(h, t);
    if (h.prop) return vcall(h.prop, "set", "(Ljava/lang/Object;Ljava/lang/Object;)V", target, h.cur);
    if (h.name) return applyAnimObj(target, h.name, h.cur);
    return;
  }
  const v = keyAtFractions(h.keys ?? [0, 1], h.fractions, t);
  h.cur = h.isInt ? Math.round(v) : v;
  if (h.prop) return vcall(h.prop, "set", "(Ljava/lang/Object;Ljava/lang/Object;)V", target, boxedCur(h));
  if (h.name) return applyAnimProp(target, h.name, h.cur as number);
}
/** the property's value now: what an XML animator with no valueFrom (or no valueTo) starts from */
/** where a one-key animator starts: the Property's own get, or the named getter */
async function currentValue(target: unknown, prop: unknown, name: string): Promise<number> {
  if (!prop) return readAnimProp(target, name);
  const v: unknown = await vcall(prop, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", target);
  return Number(v && typeof v === "object" && "v" in v ? (v as { v: unknown }).v : v ?? 0);
}
async function readAnimProp(target: unknown, prop: string): Promise<number> {
  const field = VIEW_ANIM_PROPS[prop];
  if (field && target instanceof JView) return target[field];
  const getter = "get" + prop[0].toUpperCase() + prop.slice(1);
  try { return await vcall(target, getter, "()F"); } catch { /* */ }
  try { return await vcall(target, getter, "()I"); } catch { return 0; }
}
// View properties animated straight onto the native fields; anything else goes through setXxx
const VIEW_ANIM_PROPS: Record<string, keyof JView & ("alphaV" | "translationX" | "translationY" | "scaleXv" | "scaleYv" | "rotationV")> = {
  alpha: "alphaV", translationX: "translationX", translationY: "translationY", scaleX: "scaleXv", scaleY: "scaleYv", rotation: "rotationV",
};
const setterDescs = new WeakMap<object, Map<string, string>>();
async function applyAnimProp(target: unknown, prop: string, v: number) {
  const field = VIEW_ANIM_PROPS[prop];
  if (field && target instanceof JView) { target[field] = v; return; }
  const setter = "set" + prop[0].toUpperCase() + prop.slice(1);
  const ctor = (target as { constructor?: object } | null)?.constructor;
  let descs = ctor && setterDescs.get(ctor);
  if (ctor && !descs) setterDescs.set(ctor, (descs = new Map()));
  const known = descs?.get(prop);
  if (known) {
    try { await vcall(target, setter, known, known === "(I)V" ? Math.round(v) : v); } catch { /* */ }
    return;
  }
  try { await vcall(target, setter, "(F)V", v); descs?.set(prop, "(F)V"); }
  catch {
    try { await vcall(target, setter, "(I)V", Math.round(v)); descs?.set(prop, "(I)V"); } catch { /* */ }
  }
}
/** one value = animate from the property's current value to it (AOSP: from is read at start) */
function objAnim(target: unknown, fields: Partial<JValueAnimator>, vals?: ArrayLike<number>, isInt = false): JValueAnimator {
  const a: JValueAnimator = Object.assign(rt.make("android/animation/ObjectAnimator"), { target }, fields);
  if (vals) setNumKeys(a, vals, isInt);
  return a;
}
function setNumKeys(a: { keys: number[] | null; from: number; to: number; isInt: boolean; objKeys: unknown[] | null }, v: ArrayLike<number>, isInt: boolean) {
  a.isInt = isInt; a.objKeys = null;
  if (v.length === 1) { a.keys = null; a.from = NaN; a.to = v[0]; return; }
  a.keys = Array.from(v);
  a.from = a.keys[0] ?? 0; a.to = a.keys[a.keys.length - 1] ?? 1;
}
// ── PropertyValuesHolder: one property's keyframes inside a multi-property animator
class JPVH extends JObj {
  name = ""; prop: unknown = null;
  keys: number[] | null = null; from = 0; to = 1; isInt = false;
  objKeys: unknown[] | null = null; evaluator: unknown = null;
  fractions: number[] | null = null;
  cur: unknown = 0;
}
class JKeyframe extends JObj {
  fraction = 0; value: unknown = null; hasValue = false; isInt = false; interp: unknown = null;
}
function keyframe(fraction: number, value: unknown, hasValue: boolean, isInt: boolean): JKeyframe {
  return Object.assign(new JKeyframe(), { fraction, value, hasValue, isInt });
}
rt.register({
  name: "android/animation/Keyframe", ctor: JKeyframe, ifaces: ["java/lang/Cloneable"],
  methods: {
    "static ofFloat(F)Landroid/animation/Keyframe;": (f: number) => keyframe(f, 0, false, false),
    "static ofFloat(FF)Landroid/animation/Keyframe;": (f: number, v: number) => keyframe(f, v, true, false),
    "static ofInt(F)Landroid/animation/Keyframe;": (f: number) => keyframe(f, 0, false, true),
    "static ofInt(FI)Landroid/animation/Keyframe;": (f: number, v: number) => keyframe(f, v, true, true),
    "static ofObject(F)Landroid/animation/Keyframe;": (f: number) => keyframe(f, null, false, false),
    "static ofObject(FLjava/lang/Object;)Landroid/animation/Keyframe;": (f: number, v: unknown) => keyframe(f, v, true, false),
    "getFraction()F": function (this: JKeyframe) { return this.fraction; },
    "setFraction(F)V": function (this: JKeyframe, fraction: number) { this.fraction = fraction; },
    "getValue()Ljava/lang/Object;": function (this: JKeyframe) { return this.value; },
    "setValue(Ljava/lang/Object;)V": function (this: JKeyframe, value: unknown) { this.value = value; this.hasValue = true; },
    "hasValue()Z": function (this: JKeyframe) { return this.hasValue ? 1 : 0; },
    "setInterpolator(Landroid/animation/TimeInterpolator;)V": function (this: JKeyframe, interp: unknown) { this.interp = interp; },
    "getInterpolator()Landroid/animation/TimeInterpolator;": function (this: JKeyframe) { return this.interp; },
    "clone()Landroid/animation/Keyframe;": function (this: JKeyframe) { return Object.assign(new JKeyframe(), this); },
  },
});
function pvhOf(name: string | unknown, v: ArrayLike<number> | null, isInt: boolean, byProp: boolean): JPVH {
  const h = new JPVH();
  if (byProp) { h.prop = name; h.name = (name as { name?: string })?.name ?? ""; } else h.name = name as string;
  if (v) setNumKeys(h, v, isInt);
  return h;
}
rt.register({
  name: "android/animation/PropertyValuesHolder", ctor: JPVH, ifaces: ["java/lang/Cloneable"],
  methods: {
    "static ofFloat(Ljava/lang/String;[F)Landroid/animation/PropertyValuesHolder;": (n: string, v: Float32Array) => pvhOf(n, v, false, false),
    "static ofInt(Ljava/lang/String;[I)Landroid/animation/PropertyValuesHolder;": (n: string, v: Int32Array) => pvhOf(n, v, true, false),
    "static ofFloat(Landroid/util/Property;[F)Landroid/animation/PropertyValuesHolder;": (p: unknown, v: Float32Array) => pvhOf(p, v, false, true),
    "static ofInt(Landroid/util/Property;[I)Landroid/animation/PropertyValuesHolder;": (p: unknown, v: Int32Array) => pvhOf(p, v, true, true),
    "static ofObject(Ljava/lang/String;Landroid/animation/TypeEvaluator;[Ljava/lang/Object;)Landroid/animation/PropertyValuesHolder;": (n: string, e: unknown, v: unknown[]) => {
      const h = pvhOf(n, null, false, false); h.evaluator = e; h.objKeys = [...(v ?? [])]; return h;
    },
    "static ofObject(Landroid/util/Property;Landroid/animation/TypeEvaluator;[Ljava/lang/Object;)Landroid/animation/PropertyValuesHolder;": (p: unknown, e: unknown, v: unknown[]) => {
      const h = pvhOf(p, null, false, true); h.evaluator = e; h.objKeys = [...(v ?? [])]; return h;
    },
    "static ofKeyframe(Ljava/lang/String;[Landroid/animation/Keyframe;)Landroid/animation/PropertyValuesHolder;": (n: string, frames: JKeyframe[]) => {
      const h = pvhOf(n, null, frames[0]?.isInt ?? false, false);
      h.fractions = frames.map((f) => f.fraction);
      h.keys = frames.map((f) => Number(f.value ?? 0));
      h.from = h.keys[0] ?? 0; h.to = h.keys.at(-1) ?? 1;
      return h;
    },
    "getPropertyName()Ljava/lang/String;": function (this: JPVH) { return this.name; },
    "setPropertyName(Ljava/lang/String;)V": function (this: JPVH, n: string) { this.name = n; },
    "setFloatValues([F)V": function (this: JPVH, v: Float32Array) { setNumKeys(this, v, false); },
    "setIntValues([I)V": function (this: JPVH, v: Int32Array) { setNumKeys(this, v, true); },
    "setObjectValues([Ljava/lang/Object;)V": function (this: JPVH, v: unknown[]) { this.objKeys = [...v]; },
    "setEvaluator(Landroid/animation/TypeEvaluator;)V": function (this: JPVH, e: unknown) { this.evaluator = e; },
    "clone()Landroid/animation/PropertyValuesHolder;": function (this: JPVH) { return Object.assign(new JPVH(), this); },
    "toString()Ljava/lang/String;": function (this: JPVH) { return this.name + ": " + (this.keys ?? this.objKeys ?? [this.from, this.to]).join(", "); },
  },
});
rt.markers("android/animation/TypeEvaluator");
class JRectEvaluator extends JObj { rect: JRect | null = null; }
function evaluateRect(this: JRectEvaluator, f: number, a: JRect, b: JRect): JRect {
  const edge = (x: number, y: number) => (x + rt.f2i(Math.fround(Math.fround((y - x) | 0) * f))) | 0;
  const left = edge(a.left, b.left), top = edge(a.top, b.top);
  const right = edge(a.right, b.right), bottom = edge(a.bottom, b.bottom);
  const r = this.rect ?? new JRect();
  r.left = left; r.top = top; r.right = right; r.bottom = bottom;
  return r;
}
rt.register({
  name: "android/animation/RectEvaluator", ctor: JRectEvaluator, ifaces: ["android/animation/TypeEvaluator"],
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/graphics/Rect;)V": function (this: JRectEvaluator, r: JRect | null) { this.rect = r; },
    "evaluate(FLandroid/graphics/Rect;Landroid/graphics/Rect;)Landroid/graphics/Rect;": evaluateRect,
    "evaluate(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JRectEvaluator, f: number, a: JRect, b: JRect) {
      return vcallMaybe(this, "evaluate", "(FLandroid/graphics/Rect;Landroid/graphics/Rect;)Landroid/graphics/Rect;", f, a, b);
    },
  },
});
const lerp = (f: number, a: number, b: number) => a + (b - a) * f;
rt.register({
  name: "android/animation/FloatEvaluator", ctor: class extends JObj {}, ifaces: ["android/animation/TypeEvaluator"],
  methods: {
    "<init>()V": function () {},
    "evaluate(FLjava/lang/Number;Ljava/lang/Number;)Ljava/lang/Float;": (f: number, a: { v: number }, b: { v: number }) => box(JFloat, Math.fround(lerp(f, Number(a.v), Number(b.v)))),
    "evaluate(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": (f: number, a: { v: number }, b: { v: number }) => box(JFloat, Math.fround(lerp(f, Number(a.v), Number(b.v)))),
  },
});
rt.register({
  name: "android/animation/IntEvaluator", ctor: class extends JObj {}, ifaces: ["android/animation/TypeEvaluator"],
  methods: {
    "<init>()V": function () {},
    "evaluate(FLjava/lang/Integer;Ljava/lang/Integer;)Ljava/lang/Integer;": (f: number, a: { v: number }, b: { v: number }) => boxInt(Math.trunc(lerp(f, a.v, b.v))),
    "evaluate(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": (f: number, a: { v: number }, b: { v: number }) => boxInt(Math.trunc(lerp(f, a.v, b.v))),
  },
});
/** AOSP ArgbEvaluator: per-channel interpolation in linear light (gamma 2.2), alpha linear */
function argbLerp(f: number, s: number, e: number): number {
  const ch = (c: number, sh: number) => ((c >>> sh) & 0xff) / 255;
  const lin = (c: number) => Math.pow(c, 2.2), gam = (c: number) => Math.pow(c, 1 / 2.2);
  const a = lerp(f, ch(s, 24), ch(e, 24));
  const r = gam(lerp(f, lin(ch(s, 16)), lin(ch(e, 16))));
  const g = gam(lerp(f, lin(ch(s, 8)), lin(ch(e, 8))));
  const b = gam(lerp(f, lin(ch(s, 0)), lin(ch(e, 0))));
  return ((Math.round(a * 255) << 24) | (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)) | 0;
}
class JArgbEvaluator extends JObj {}
const argbEvaluator = new JArgbEvaluator();
rt.register({
  name: "android/animation/ArgbEvaluator", ctor: JArgbEvaluator, ifaces: ["android/animation/TypeEvaluator"],
  methods: {
    "<init>()V": function () {},
    "evaluate(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": (f: number, a: { v: number }, b: { v: number }) => boxInt(argbLerp(f, a.v, b.v)),
  },
});
function setDur(this: JValueAnimator, d: bigint) {
  this.durationMs = Number(d);
  return this;
}
const vaMethods: NativeSpec["methods"] = {
  "setDuration(J)Landroid/animation/ValueAnimator;": setDur,
  "setDuration(J)Landroid/animation/Animator;": setDur,
  "getDuration()J": function (this: JValueAnimator) { return BigInt(this.durationMs); },
  "getTotalDuration()J": function (this: JValueAnimator) { return this.repeat < 0 ? -1n : BigInt(this.delayMs + this.durationMs * (this.repeat + 1)); },
  "setFloatValues([F)V": function (this: JValueAnimator, v: Float32Array) { setNumKeys(this, v, false); },
  "setIntValues([I)V": function (this: JValueAnimator, v: Int32Array) { setNumKeys(this, v, true); },
  "setObjectValues([Ljava/lang/Object;)V": function (this: JValueAnimator, v: unknown[]) { this.objKeys = [...v]; },
  "removeListener(Landroid/animation/Animator$AnimatorListener;)V": function (this: JValueAnimator, l: unknown) {
    const i = this.animLs.indexOf(l); if (i >= 0) this.animLs.splice(i, 1);
  },
  "removeUpdateListener(Landroid/animation/ValueAnimator$AnimatorUpdateListener;)V": function (this: JValueAnimator, l: unknown) {
    const i = this.updateLs.indexOf(l); if (i >= 0) this.updateLs.splice(i, 1);
  },
  "getListeners()Ljava/util/ArrayList;": function (this: JValueAnimator) { return this.animLs.length ? newArrayList([...this.animLs]) : null; },
  "pause()V": function (this: JValueAnimator) { if (this.running && !this.paused) { this.paused = true; this.pausedAt = performance.now(); } },
  "resume()V": function (this: JValueAnimator) { if (this.paused) { this.paused = false; this.startT += performance.now() - this.pausedAt; } },
  ...fieldSetters({ "setInterpolator(Landroid/animation/TimeInterpolator;)V": "interp",
    "setInterpolator(Landroid/view/animation/Interpolator;)V": "interp",
    "setEvaluator(Landroid/animation/TypeEvaluator;)V": "evaluator" }),
  ...fieldGetters({ "getInterpolator()Landroid/animation/TimeInterpolator;": "interp", "getRepeatCount()I": "repeat",
    "getRepeatMode()I": "repeatMode" }),
  ...flagGetters({ "isPaused()Z": "paused" }),
  "reverse()V": async function (this: JValueAnimator) {
    if (this.running) { this.reversed = !this.reversed; this.startT = performance.now() - (this.durationMs - (performance.now() - this.startT)); return; }
    this.startReversed = true;
    await guardCall(this, M_start);
  },
  "setCurrentPlayTime(J)V": function (this: JValueAnimator, t: bigint) { this.startT = performance.now() - Number(t); },
  "getCurrentPlayTime()J": function (this: JValueAnimator) { return BigInt(Math.max(0, Math.round(performance.now() - this.startT))); },
  "setCurrentFraction(F)V": function (this: JValueAnimator, f: number) { this.startT = performance.now() - f * this.durationMs; },
  "getValues()[Landroid/animation/PropertyValuesHolder;": function (this: JValueAnimator) {
    if (!this.holders.length) { const h = new JPVH(); h.name = this.propName; h.keys = this.keys ?? [this.from, this.to]; h.isInt = this.isInt; h.objKeys = this.objKeys; h.evaluator = this.evaluator; this.holders = [h]; }
    return jarray([...this.holders], "Landroid/animation/PropertyValuesHolder;");
  },
  "getAnimatedValue(Ljava/lang/String;)Ljava/lang/Object;": function (this: JValueAnimator, name: string) {
    const h = this.holders.find((h) => h.name === name);
    return h ? boxedCur(h) : boxedCur(this);
  },
  "static getFrameDelay()J": () => 10n,
  ...noops("<init>()V", "addPauseListener(Landroid/animation/Animator$AnimatorPauseListener;)V",
    "static setDurationScale(F)V", "static setFrameDelay(J)V"),
  ...stubs(1, "static areAnimatorsEnabled()Z", "static getDurationScale()F",
    "static registerDurationScaleChangeListener(Landroid/animation/ValueAnimator$DurationScaleChangeListener;)Z",
    "static unregisterDurationScaleChangeListener(Landroid/animation/ValueAnimator$DurationScaleChangeListener;)Z"),
  "static ofObject(Landroid/animation/TypeEvaluator;[Ljava/lang/Object;)Landroid/animation/ValueAnimator;": (ev: unknown, vals: unknown[]) => {
    const a = new JValueAnimator();
    a.evaluator = ev; a.objKeys = [...(vals ?? [])];
    return a;
  },
  "static ofPropertyValuesHolder([Landroid/animation/PropertyValuesHolder;)Landroid/animation/ValueAnimator;": (hs: JPVH[]) => {
    const a = new JValueAnimator();
    a.holders = [...(hs ?? [])];
    return a;
  },
  "clone()Landroid/animation/ValueAnimator;": function (this: JValueAnimator) {
    const c = new (this.constructor as any)() as JValueAnimator;
    Object.assign(c, this, { running: false, paused: false, updateLs: [...this.updateLs], animLs: [...this.animLs], holders: [...this.holders] });
    return c;
  },
  "setStartDelay(J)V": function (this: JValueAnimator, d: bigint) { this.delayMs = Number(d); },
  "getStartDelay()J": function (this: JValueAnimator) { return BigInt(this.delayMs); },
  "setTarget(Ljava/lang/Object;)V": function (this: JValueAnimator, t: unknown) { setTargetDeep(this, t); },
  "addUpdateListener(Landroid/animation/ValueAnimator$AnimatorUpdateListener;)V": function (this: JValueAnimator, l: unknown) {
    this.updateLs.push(l);
  },
  "addListener(Landroid/animation/Animator$AnimatorListener;)V": function (this: JValueAnimator, l: unknown) {
    this.animLs.push(l);
  },
  "removeAllListeners()V": function (this: JValueAnimator) { this.animLs.length = 0; },
  "removeAllUpdateListeners()V": function (this: JValueAnimator) { this.updateLs.length = 0; },
  "start()V": async function (this: JValueAnimator) {
    if (Number.isNaN(this.from) || Number.isNaN(this.to)) {
      // a single value animates from the property's current value (ValueAnimator: from 0)
      const cur = this.target ? await currentValue(this.target, this.prop, this.propName) : 0;
      if (Number.isNaN(this.from)) this.from = cur;
      if (Number.isNaN(this.to)) this.to = cur;
    }
    this.reversed = this.startReversed;
    this.startReversed = false;
    this.startT = performance.now();
    this.running = true;
    // AOSP's start() animates fraction 0 at once, so getAnimatedValue() read from a start
    // listener or before the first frame is the first key, not whatever was there before.
    if (this.objKeys) this.cur = await objAt(this, 0);
    else { const v = this.keys ? this.keys[0] : this.from; this.cur = this.isInt ? Math.round(v) : v; }
    for (const l of [...this.animLs]) {
      try { await vcall(l, "onAnimationStart", "(Landroid/animation/Animator;)V", this); } catch (e) { reportUncaught(e); }
    }
    const self = this;
    // one serialized main-looper job per tick, never a floating chain (see ViewPropertyAnimator)
    let inflight = false;
    const hook = () => {
      if (!self.running) return false;
      if (!inflight) { inflight = true; void onMain(() => animTick(self)).finally(() => { inflight = false; }); }
      return self.running;
    };
    uiState.animHooks.add(hook);
    invalidate();
  },
  "cancel()V": async function (this: JValueAnimator) {
    this.running = false;
    for (const l of [...this.animLs]) {
      try { await vcall(l, "onAnimationCancel", "(Landroid/animation/Animator;)V", this); } catch (e) { reportUncaught(e); }
    }
  },
  "end()V": function (this: JValueAnimator) { this.running = false; },
  "getAnimatedValue()Ljava/lang/Object;": function (this: JValueAnimator) { return boxedCur(this); },
  ...fieldSetters({ "setRepeatCount(I)V": "repeat", "setRepeatMode(I)V": "repeatMode" }),
  ...flagGetters({ "isRunning()Z": "running", "isStarted()Z": "running" }),
  ...fieldGetters({ "getAnimatedFraction()F": "frac" }),
  "static ofFloat([F)Landroid/animation/ValueAnimator;": (vals: Float32Array) => { const a = new JValueAnimator(); setNumKeys(a, vals, false); return a; },
  "static ofInt([I)Landroid/animation/ValueAnimator;": (vals: Int32Array) => { const a = new JValueAnimator(); setNumKeys(a, vals, true); return a; },
  "static ofArgb([I)Landroid/animation/ValueAnimator;": (vals: Int32Array) => {
    const a = new JValueAnimator();
    a.evaluator = argbEvaluator; a.objKeys = Array.from(vals, boxInt);
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
    "static ofFloat(Ljava/lang/Object;Ljava/lang/String;[F)Landroid/animation/ObjectAnimator;": (t: unknown, p: string, v: Float32Array) => objAnim(t, { propName: p }, v, false),
    "static ofInt(Ljava/lang/Object;Ljava/lang/String;[I)Landroid/animation/ObjectAnimator;": (t: unknown, p: string, v: Int32Array) => objAnim(t, { propName: p }, v, true),
    "static ofFloat(Ljava/lang/Object;Landroid/util/Property;[F)Landroid/animation/ObjectAnimator;": (t: unknown, p: unknown, v: Float32Array) => objAnim(t, { prop: p }, v, false),
    "static ofInt(Ljava/lang/Object;Landroid/util/Property;[I)Landroid/animation/ObjectAnimator;": (t: unknown, p: unknown, v: Int32Array) => objAnim(t, { prop: p }, v, true),
    "setPropertyName(Ljava/lang/String;)V": function (this: any, p: string) { this.propName = p; },
    "getPropertyName()Ljava/lang/String;": function (this: JValueAnimator) { return this.propName || (this.prop as { name?: string })?.name || (this.holders[0]?.name ?? null); },
    "setProperty(Landroid/util/Property;)V": function (this: any, p: unknown) { this.prop = p; },
    "setAutoCancel(Z)V": () => {},
    "getTarget()Ljava/lang/Object;": function (this: JValueAnimator) { return this.target; },
    "static ofArgb(Ljava/lang/Object;Ljava/lang/String;[I)Landroid/animation/ObjectAnimator;": (t: unknown, p: string, v: Int32Array) =>
      objAnim(t, { propName: p, evaluator: argbEvaluator, objKeys: Array.from(v, boxInt) }),
    "static ofObject(Ljava/lang/Object;Ljava/lang/String;Landroid/animation/TypeEvaluator;[Ljava/lang/Object;)Landroid/animation/ObjectAnimator;": (t: unknown, p: string, ev: unknown, v: unknown[]) =>
      objAnim(t, { propName: p, evaluator: ev, objKeys: [...(v ?? [])] }),
    "static ofObject(Ljava/lang/Object;Landroid/util/Property;Landroid/animation/TypeEvaluator;[Ljava/lang/Object;)Landroid/animation/ObjectAnimator;": (t: unknown, p: unknown, ev: unknown, v: unknown[]) =>
      objAnim(t, { prop: p, evaluator: ev, objKeys: [...(v ?? [])] }),
    "static ofPropertyValuesHolder(Ljava/lang/Object;[Landroid/animation/PropertyValuesHolder;)Landroid/animation/ObjectAnimator;": (t: unknown, hs: JPVH[]) =>
      objAnim(t, { holders: [...(hs ?? [])] }),
    "setFloatValues([F)V": function (this: JValueAnimator, v: Float32Array) { setNumKeys(this, v, false); },
    "setIntValues([I)V": function (this: JValueAnimator, v: Int32Array) { setNumKeys(this, v, true); },
  },
});
class JAnimatorSet extends JValueAnimator { anims: JValueAnimator[] = []; sequential = false; }
function setTargetDeep(a: JValueAnimator, t: unknown) {
  a.target = t;
  if (a instanceof JAnimatorSet) for (const c of a.anims) setTargetDeep(c, t);
}
rt.register({
  name: "android/animation/AnimatorSet", ctor: JAnimatorSet, sup: "android/animation/Animator",
  methods: {
    ...vaMethods,
    "setDuration(J)Landroid/animation/AnimatorSet;": setDur,
    "playTogether([Landroid/animation/Animator;)V": function (this: JAnimatorSet, arr: JValueAnimator[]) { this.anims = [...(arr ?? [])]; },
    "playTogether(Ljava/util/Collection;)V": async function (this: JAnimatorSet, c: unknown) { this.anims = [...await toJsArray(c)] as JValueAnimator[]; },
    "playSequentially([Landroid/animation/Animator;)V": function (this: JAnimatorSet, arr: JValueAnimator[]) { this.anims = [...(arr ?? [])]; this.sequential = true; },
    "playSequentially(Ljava/util/List;)V": async function (this: JAnimatorSet, c: unknown) { this.anims = [...await toJsArray(c)] as JValueAnimator[]; this.sequential = true; },
    "getChildAnimations()Ljava/util/ArrayList;": function (this: JAnimatorSet) { return newArrayList([...this.anims]); },
    "start()V": async function (this: JAnimatorSet) {
      this.running = true;
      if (this.sequential) {
        for (let i = 0; i + 1 < this.anims.length; i++) this.anims[i].next = this.anims[i + 1];
        if (this.anims.length) await guardCall(this.anims[0], M_start);
      } else for (const a of this.anims) await guardCall(a, M_start);
      const total = this.sequential ? this.anims.reduce((s, a) => s + a.delayMs + a.durationMs, 0)
        : Math.max(0, ...this.anims.map((a) => a.delayMs + a.durationMs));
      setTimeout(() => {
        this.running = false;
        for (const l of [...this.animLs]) void vcall(l, "onAnimationEnd", "(Landroid/animation/Animator;)V", this).catch(reportUncaught);
        if (this.next) void guardCall(this.next, M_start);
      }, total);
    },
    "cancel()V": async function (this: JAnimatorSet) { this.running = false; for (const a of this.anims) await guardCall(a, M_cancel); },
    "end()V": function (this: JAnimatorSet) { this.running = false; for (const a of this.anims) a.running = false; },
    "play(Landroid/animation/Animator;)Landroid/animation/AnimatorSet$Builder;": function (this: JAnimatorSet, a: JValueAnimator) {
      const b = new JAnimatorSetBuilder(); b.set = this; b.anchor = a;
      if (!this.anims.includes(a)) this.anims.push(a);
      return b;
    },
    "getTotalDuration()J": function (this: JAnimatorSet) {
      const d = this.sequential ? this.anims.reduce((s, a) => s + a.delayMs + a.durationMs, 0) : Math.max(0, ...this.anims.map((a) => a.delayMs + a.durationMs));
      return BigInt(this.delayMs + d);
    },
    "reverse()V": async function (this: JAnimatorSet) { for (const a of [...this.anims].reverse()) await vcall(a, "reverse", "()V"); },
    "setCurrentPlayTime(J)V": function (this: JAnimatorSet, t: bigint) { for (const a of this.anims) a.startT = performance.now() - Number(t); },
    "setInterpolator(Landroid/animation/TimeInterpolator;)V": function (this: JAnimatorSet, i: unknown) { this.interp = i; for (const a of this.anims) a.interp = i; },
    "isRunning()Z": function (this: JAnimatorSet) { return this.running || this.anims.some((a) => a.running) ? 1 : 0; },
  },
});
// AnimatorSet.Builder: with() plays together, before()/after() chain through `next`; a set
// built this way plays its anchor group together and the chained ones in order.
class JAnimatorSetBuilder extends JObj { set: JAnimatorSet | null = null; anchor: JValueAnimator | null = null; }
rt.register({
  name: "android/animation/AnimatorSet$Builder", ctor: JAnimatorSetBuilder,
  methods: {
    "with(Landroid/animation/Animator;)Landroid/animation/AnimatorSet$Builder;": function (this: JAnimatorSetBuilder, a: JValueAnimator) {
      if (!this.set!.anims.includes(a)) this.set!.anims.push(a);
      return this;
    },
    "before(Landroid/animation/Animator;)Landroid/animation/AnimatorSet$Builder;": function (this: JAnimatorSetBuilder, a: JValueAnimator) {
      this.anchor!.next = a;
      const i = this.set!.anims.indexOf(a); if (i >= 0) this.set!.anims.splice(i, 1);
      return this;
    },
    "after(Landroid/animation/Animator;)Landroid/animation/AnimatorSet$Builder;": function (this: JAnimatorSetBuilder, a: JValueAnimator) {
      a.next = this.anchor;
      if (!this.set!.anims.includes(a)) this.set!.anims.push(a);
      const i = this.set!.anims.indexOf(this.anchor!); if (i >= 0) this.set!.anims.splice(i, 1);
      return this;
    },
    "after(J)Landroid/animation/AnimatorSet$Builder;": function (this: JAnimatorSetBuilder, d: bigint) { this.anchor!.delayMs += Number(d); return this; },
  },
});
// ── LayoutTransition: the ViewGroup add/remove/change choreography. Our ViewGroups commit
// layout changes instantly, so this keeps the configuration and reports it back.
class JLayoutTransition extends JObj { enabled = new Set([0, 1, 2, 3]); durations = new Map<number, number>(); listeners: unknown[] = []; }
rt.register({
  name: "android/animation/LayoutTransition", ctor: JLayoutTransition,
  statics: { CHANGE_APPEARING: 0, CHANGE_DISAPPEARING: 1, APPEARING: 2, DISAPPEARING: 3, CHANGING: 4 },
  methods: {
    "enableTransitionType(I)V": function (this: JLayoutTransition, t: number) { this.enabled.add(t); },
    "disableTransitionType(I)V": function (this: JLayoutTransition, t: number) { this.enabled.delete(t); },
    "isTransitionTypeEnabled(I)Z": function (this: JLayoutTransition, t: number) { return this.enabled.has(t) ? 1 : 0; },
    "setDuration(J)V": function (this: JLayoutTransition, d: bigint) { for (let t = 0; t < 5; t++) this.durations.set(t, Number(d)); },
    "setDuration(IJ)V": function (this: JLayoutTransition, t: number, d: bigint) { this.durations.set(t, Number(d)); },
    "getDuration(I)J": function (this: JLayoutTransition, t: number) { return BigInt(this.durations.get(t) ?? 300); },
    "addTransitionListener(Landroid/animation/LayoutTransition$TransitionListener;)V": function (this: JLayoutTransition, l: unknown) { this.listeners.push(l); },
    "removeTransitionListener(Landroid/animation/LayoutTransition$TransitionListener;)V": function (this: JLayoutTransition, l: unknown) { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); },
    ...noops("<init>()V", "setStartDelay(IJ)V", "setStagger(IJ)V",
      "setInterpolator(ILandroid/animation/TimeInterpolator;)V", "setAnimator(ILandroid/animation/Animator;)V",
      "setAnimateParentHierarchy(Z)V"),
    ...stubs(null, "getAnimator(I)Landroid/animation/Animator;"),
    ...stubs(0, "isRunning()Z", "isChangingLayout()Z"),
  },
});
rt.markers("android/animation/LayoutTransition$TransitionListener", "android/animation/Animator$AnimatorPauseListener",
  "android/animation/ValueAnimator$DurationScaleChangeListener");
const M_start = mangleMethod("start", "()V");
const M_cancel = mangleMethod("cancel", "()V");

// ── AnimatorInflater: <objectAnimator>/<set> resources, and <selector> state-list animators
const A = attrTable(
  "propertyName", "duration", "valueFrom", "valueTo", "valueType", "startOffset", "repeatCount",
  "ordering");

function xmlAttr(res: Resources, node: XmlNode, id: number): RV | null {
  const a: XmlAttr | undefined = id ? node.attrs.find((x) => x.resId === id) : undefined;
  if (!a) return null;
  return a.type === TV.STRING ? { t: T_STR, d: 0, s: a.str ?? "" } : res.resolveRefs(normRV({ t: a.type, d: a.data }));
}
function inflateAnimator(res: Resources, node: XmlNode): JValueAnimator {
  if (node.name === "set") {
    const set = rt.make("android/animation/AnimatorSet") as JAnimatorSet;
    set.anims = node.children.map((c) => inflateAnimator(res, c));
    set.sequential = rvInt(res, xmlAttr(res, node, A.ordering)) === 1;
    return set;
  }
  const a = rt.make("android/animation/ObjectAnimator") as JValueAnimator;
  a.propName = xmlAttr(res, node, A.propertyName)?.s ?? "";
  a.durationMs = rvInt(res, xmlAttr(res, node, A.duration), 300);
  a.delayMs = rvInt(res, xmlAttr(res, node, A.startOffset));
  a.repeat = rvInt(res, xmlAttr(res, node, A.repeatCount));
  a.isInt = rvInt(res, xmlAttr(res, node, A.valueType)) === 1;
  // an absent end is the property's value at start (NaN until the target is known)
  const from = xmlAttr(res, node, A.valueFrom), to = xmlAttr(res, node, A.valueTo);
  a.from = from ? rvFloat(res, from) : NaN;
  a.to = to ? rvFloat(res, to) : NaN;
  return a;
}
function animatorXml(ctx: unknown, id: number): [Resources, XmlNode] {
  const res: Resources = (ctx as JContext).$host.res;
  const f = res.fileOf(id);
  if (!f) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Can't load animation resource ID #0x" + id.toString(16));
  return [res, parseAXML(f.bytes)];
}
class JStateListAnimator extends JObj {
  tuples: { spec: Int32Array; anim: JValueAnimator }[] = [];
  cur: JValueAnimator | null = null;
  target: unknown = null;
}
rt.register({
  name: "android/animation/AnimatorInflater", ctor: class extends JObj {},
  methods: {
    "static loadAnimator(Landroid/content/Context;I)Landroid/animation/Animator;": (ctx: unknown, id: number) => {
      const [res, root] = animatorXml(ctx, id);
      return inflateAnimator(res, root);
    },
    "static loadStateListAnimator(Landroid/content/Context;I)Landroid/animation/StateListAnimator;": (ctx: unknown, id: number) => {
      const [res, root] = animatorXml(ctx, id);
      const sla = new JStateListAnimator();
      for (const item of root.children) {
        // every android:state_* attribute is one spec entry: its attr id, negated when false
        const spec = Int32Array.from(item.attrs.filter((x) => x.resId), (x) => x.data ? x.resId : -x.resId);
        if (item.children.length) sla.tuples.push({ spec, anim: inflateAnimator(res, item.children[0]) });
      }
      return sla;
    },
  },
});
rt.register({
  name: "android/animation/StateListAnimator", ctor: JStateListAnimator, ifaces: ["java/lang/Cloneable"],
  methods: {
    "<init>()V": function () {},
    "addState([ILandroid/animation/Animator;)V": function (this: JStateListAnimator, spec: Int32Array, anim: JValueAnimator) {
      this.tuples.push({ spec, anim });
      if (this.target) setTargetDeep(anim, this.target);
    },
    "setTarget(Landroid/view/View;)V": function (this: JStateListAnimator, v: unknown) {
      this.target = v;
      for (const t of this.tuples) setTargetDeep(t.anim, v);
    },
    "getTarget()Landroid/view/View;": function (this: JStateListAnimator) { return this.target; },
    // AOSP's package-private hook View.drawableStateChanged() calls with getDrawableState()
    "setState([I)V": async function (this: JStateListAnimator, state: Int32Array) {
      const hit = this.tuples.find((t) => stateSetMatches(t.spec, state))?.anim ?? null;
      if (hit === this.cur) return;
      if (this.cur) await guardCall(this.cur, M_cancel);
      this.cur = hit;
      if (hit) await guardCall(hit, M_start);
    },
    "jumpToCurrentState()V": function (this: JStateListAnimator) { if (this.cur) this.cur.running = false; },
    "clone()Ljava/lang/Object;": function (this: JStateListAnimator) {
      const c = new JStateListAnimator();
      c.tuples = this.tuples.map((t) => ({ spec: t.spec, anim: t.anim }));
      return c;
    },
  },
});
rt.markers("android/animation/Animator$AnimatorListener", "android/animation/ValueAnimator$AnimatorUpdateListener");
rt.register({
  name: "android/animation/AnimatorListenerAdapter", ctor: class extends JObj {},
  ifaces: ["android/animation/Animator$AnimatorListener"],
  methods: {
    ...noops("<init>()V", "onAnimationStart(Landroid/animation/Animator;)V",
      "onAnimationEnd(Landroid/animation/Animator;)V", "onAnimationCancel(Landroid/animation/Animator;)V",
      "onAnimationRepeat(Landroid/animation/Animator;)V"),
  },
});
