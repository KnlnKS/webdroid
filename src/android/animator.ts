// android.animation: ValueAnimator/ObjectAnimator/AnimatorSet, driven from the frame loop via uiState.animHooks.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, boxInt, box, JFloat } from "../jvm/natives/jlang";
import { toJsArray, newArrayList } from "../jvm/natives/jutil";
import { uiState, invalidate, JView, guardCall } from "./view";
import { reportUncaught, stateSetMatches } from "./os";
import { parseAXML, TV, type XmlNode, type XmlAttr } from "./axml";
import { type Resources, type RV, AID, T_STR, normRV, rvFloat, rvInt } from "./res";

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
}
async function animTick(a: JValueAnimator): Promise<boolean> {
  const el = performance.now() - a.startT - a.delayMs;
  const t = el < 0 ? 0 : a.durationMs > 0 ? Math.min(1, el / a.durationMs) : 1;
  a.frac = t;
  const v = a.from + (a.to - a.from) * (1 - Math.pow(1 - t, 2));
  a.cur = a.isInt ? Math.round(v) : v;
  if (a.target && a.prop) {
    await vcall(a.prop, "set", "(Ljava/lang/Object;Ljava/lang/Object;)V", a.target, a.isInt ? boxInt(a.cur as number) : box(JFloat, a.cur as number));
  } else if (a.target && a.propName) {
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
    if (a.next) await guardCall((a.next as any)[M_start], a.next);
    return false;
  }
  return true;
}
/** the property's value now: what an XML animator with no valueFrom (or no valueTo) starts from */
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
  "setStartDelay(J)V": function (this: JValueAnimator, d: bigint) { this.delayMs = Number(d); },
  "getStartDelay()J": function (this: JValueAnimator) { return BigInt(this.delayMs); },
  "setTarget(Ljava/lang/Object;)V": function (this: JValueAnimator, t: unknown) { setTargetDeep(this, t); },
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
    if (this.target && (Number.isNaN(this.from) || Number.isNaN(this.to))) {
      const cur = await readAnimProp(this.target, this.propName);
      if (Number.isNaN(this.from)) this.from = cur;
      if (Number.isNaN(this.to)) this.to = cur;
    }
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
    "static ofFloat(Ljava/lang/Object;Landroid/util/Property;[F)Landroid/animation/ObjectAnimator;":
      (target: unknown, prop: unknown, vals: Float32Array) => {
        const a = new (rt.link("android/animation/ObjectAnimator").ctor)();
        a.target = target;
        a.prop = prop;
        a.from = vals.length > 1 ? vals[0] : 0;
        a.to = vals[vals.length - 1] ?? 0;
        return a;
      },
    "static ofInt(Ljava/lang/Object;Landroid/util/Property;[I)Landroid/animation/ObjectAnimator;":
      (target: unknown, prop: unknown, vals: Int32Array) => {
        const a = new (rt.link("android/animation/ObjectAnimator").ctor)();
        a.target = target;
        a.prop = prop;
        a.isInt = true;
        a.from = vals.length > 1 ? vals[0] : 0;
        a.to = vals[vals.length - 1] ?? 0;
        return a;
      },
    "setPropertyName(Ljava/lang/String;)V": function (this: any, p: string) { this.propName = p; },
    "setProperty(Landroid/util/Property;)V": function (this: any, p: unknown) { this.prop = p; },
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
        if (this.anims.length) await guardCall((this.anims[0] as any)[M_start], this.anims[0]);
      } else for (const a of this.anims) await guardCall((a as any)[M_start], a);
      const total = this.sequential ? this.anims.reduce((s, a) => s + a.delayMs + a.durationMs, 0)
        : Math.max(0, ...this.anims.map((a) => a.delayMs + a.durationMs));
      setTimeout(() => {
        this.running = false;
        for (const l of this.animLs) void vcall(l, "onAnimationEnd", "(Landroid/animation/Animator;)V", this).catch(reportUncaught);
        if (this.next) void guardCall((this.next as any)[M_start], this.next);
      }, total);
    },
    "cancel()V": async function (this: JAnimatorSet) { this.running = false; for (const a of this.anims) await guardCall((a as any)[M_cancel], a); },
    "end()V": function (this: JAnimatorSet) { this.running = false; for (const a of this.anims) a.running = false; },
  },
});
const M_start = mangleMethod("start", "()V");
const M_cancel = mangleMethod("cancel", "()V");

// ── AnimatorInflater: <objectAnimator>/<set> resources, and <selector> state-list animators
const A = {
  propertyName: AID("propertyName"), duration: AID("duration"), valueFrom: AID("valueFrom"), valueTo: AID("valueTo"),
  valueType: AID("valueType"), startOffset: AID("startOffset"), repeatCount: AID("repeatCount"), ordering: AID("ordering"),
};
function xmlAttr(res: Resources, node: XmlNode, id: number): RV | null {
  const a: XmlAttr | undefined = node.attrs.find((x) => x.resId === id);
  if (!a) return null;
  return a.type === TV.STRING ? { t: T_STR, d: 0, s: a.str ?? "" } : res.resolveRefs(normRV({ t: a.type, d: a.data }));
}
function inflateAnimator(res: Resources, node: XmlNode): JValueAnimator {
  if (node.name === "set") {
    const set = new (rt.link("android/animation/AnimatorSet").ctor)() as JAnimatorSet;
    set.anims = node.children.map((c) => inflateAnimator(res, c));
    set.sequential = rvInt(res, xmlAttr(res, node, A.ordering)) === 1;
    return set;
  }
  const a = new (rt.link("android/animation/ObjectAnimator").ctor)() as JValueAnimator;
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
  const res: Resources = (ctx as any).$host.res;
  const v = res.value(id);
  const bytes = v.t === TV.STRING && v.s ? res.zip[v.s] : undefined;
  if (!bytes) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Can't load animation resource ID #0x" + id.toString(16));
  return [res, parseAXML(bytes)];
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
      if (this.cur) await guardCall((this.cur as any)[M_cancel], this.cur);
      this.cur = hit;
      if (hit) await guardCall((hit as any)[M_start], hit);
    },
    "jumpToCurrentState()V": function (this: JStateListAnimator) { if (this.cur) this.cur.running = false; },
    "clone()Ljava/lang/Object;": function (this: JStateListAnimator) {
      const c = new JStateListAnimator();
      c.tuples = this.tuples.map((t) => ({ spec: t.spec, anim: t.anim }));
      return c;
    },
  },
});
rt.register({ name: "android/animation/Animator$AnimatorListener", ctor: class extends JObj {} });
rt.register({ name: "android/animation/ValueAnimator$AnimatorUpdateListener", ctor: class extends JObj {} });
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
