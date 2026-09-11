// android.transition: Transition / TransitionSet / TransitionManager. Layout changes commit
// instantly here (as view animations do), so a scene transition is its bookkeeping — targets,
// listeners, duration — and beginDelayedTransition lets the next layout land while still
// telling listeners the transition started and ended, on the main queue.

import { rt, JObj, type NativeSpec, maySuspend, stubs, noops, fieldGetters, fieldSetters } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jutil";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { requestLayout } from "./view";

class JTransition extends JObj {
  durationMs = -1n; delayMs = -1n;
  interp: unknown = null;
  listeners: unknown[] = [];
  targets = newArrayList(); targetIds = newArrayList(); targetNames = newArrayList(); targetTypes = newArrayList();
  name = "";
  epicenterCb: unknown = null; pathMotion: unknown = null; propagation: unknown = null;
}
class JTransitionSet extends JTransition { kids: JTransition[] = []; ordering = 0; }
const T = "Landroid/transition/Transition;";
const listen = (self: JTransition, l: unknown, add: boolean) => {
  const i = self.listeners.indexOf(l);
  if (add) { if (i < 0) self.listeners.push(l); } else if (i >= 0) self.listeners.splice(i, 1);
  return self;
};
async function fire(t: JTransition, which: string) {
  for (const l of [...t.listeners]) {
    try { await vcall(l, which, "(Landroid/transition/Transition;)V", t); } catch (e) { reportUncaught(e); }
  }
  if (t instanceof JTransitionSet) for (const k of t.kids) await fire(k, which);
}
const transitionMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function () {},
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function () {},
  [`setDuration(J)${T}`]: function (this: JTransition, d: bigint) { this.durationMs = d; return this; },
  "getDuration()J": function (this: JTransition) { return this.durationMs; },
  [`setStartDelay(J)${T}`]: function (this: JTransition, d: bigint) { this.delayMs = d; return this; },
  "getStartDelay()J": function (this: JTransition) { return this.delayMs; },
  [`setInterpolator(Landroid/animation/TimeInterpolator;)${T}`]: function (this: JTransition, i: unknown) { this.interp = i; return this; },
  "getInterpolator()Landroid/animation/TimeInterpolator;": function (this: JTransition) { return this.interp; },
  [`addListener(Landroid/transition/Transition$TransitionListener;)${T}`]: function (this: JTransition, l: unknown) { return listen(this, l, true); },
  [`removeListener(Landroid/transition/Transition$TransitionListener;)${T}`]: function (this: JTransition, l: unknown) { return listen(this, l, false); },
  [`addTarget(Landroid/view/View;)${T}`]: function (this: JTransition, v: unknown) { this.targets.a.push(v); return this; },
  [`addTarget(I)${T}`]: function (this: JTransition, id: number) { this.targetIds.a.push(id); return this; },
  [`addTarget(Ljava/lang/String;)${T}`]: function (this: JTransition, n: string) { this.targetNames.a.push(n); return this; },
  [`addTarget(Ljava/lang/Class;)${T}`]: function (this: JTransition, c: unknown) { this.targetTypes.a.push(c); return this; },
  [`removeTarget(Landroid/view/View;)${T}`]: function (this: JTransition, v: unknown) { const i = this.targets.a.indexOf(v); if (i >= 0) this.targets.a.splice(i, 1); return this; },
  [`removeTarget(I)${T}`]: function (this: JTransition, id: number) { const i = this.targetIds.a.indexOf(id); if (i >= 0) this.targetIds.a.splice(i, 1); return this; },
  [`removeTarget(Ljava/lang/String;)${T}`]: function (this: JTransition, n: string) { const i = this.targetNames.a.indexOf(n); if (i >= 0) this.targetNames.a.splice(i, 1); return this; },
  [`removeTarget(Ljava/lang/Class;)${T}`]: function (this: JTransition, c: unknown) { const i = this.targetTypes.a.indexOf(c); if (i >= 0) this.targetTypes.a.splice(i, 1); return this; },
  [`excludeTarget(Landroid/view/View;Z)${T}`]: function (this: JTransition) { return this; },
  [`excludeTarget(IZ)${T}`]: function (this: JTransition) { return this; },
  [`excludeTarget(Ljava/lang/Class;Z)${T}`]: function (this: JTransition) { return this; },
  [`excludeChildren(Landroid/view/View;Z)${T}`]: function (this: JTransition) { return this; },
  [`excludeChildren(IZ)${T}`]: function (this: JTransition) { return this; },
  "getName()Ljava/lang/String;": maySuspend(function (this: JTransition) { return this.name || (this.constructor as any).$i?.name?.replace(/\//g, ".") || "android.transition.Transition"; }),
  "getEpicenter()Landroid/graphics/Rect;": maySuspend(function (this: JTransition) {
    return this.epicenterCb ? vcall(this.epicenterCb, "onGetEpicenter", "(Landroid/transition/Transition;)Landroid/graphics/Rect;", this) : null;
  }),
  ...fieldGetters({ "getTargets()Ljava/util/List;": "targets", "getTargetIds()Ljava/util/List;": "targetIds",
    "getTargetNames()Ljava/util/List;": "targetNames", "getTargetTypes()Ljava/util/List;": "targetTypes",
    "getEpicenterCallback()Landroid/transition/Transition$EpicenterCallback;": "epicenterCb",
    "getPathMotion()Landroid/transition/PathMotion;": "pathMotion",
    "getPropagation()Landroid/transition/TransitionPropagation;": "propagation" }),
  ...fieldSetters({ "setEpicenterCallback(Landroid/transition/Transition$EpicenterCallback;)V": "epicenterCb",
    "setPathMotion(Landroid/transition/PathMotion;)V": "pathMotion",
    "setPropagation(Landroid/transition/TransitionPropagation;)V": "propagation" }),
  ...noops("setMatchOrder([I)V", "captureStartValues(Landroid/transition/TransitionValues;)V",
    "captureEndValues(Landroid/transition/TransitionValues;)V"),
  ...stubs(null, "getTransitionProperties()[Ljava/lang/String;",
    "createAnimator(Landroid/view/ViewGroup;Landroid/transition/TransitionValues;Landroid/transition/TransitionValues;)Landroid/animation/Animator;"),
  ...stubs(0, "canRemoveViews()Z"),
  "clone()Landroid/transition/Transition;": maySuspend(function (this: JTransition) {
    const c = new (this.constructor as any)() as JTransition;
    Object.assign(c, this, { listeners: [], targets: newArrayList([...this.targets.a]), targetIds: newArrayList([...this.targetIds.a]) });
    return c;
  }),
  "toString()Ljava/lang/String;": function (this: JTransition) { return "Transition@" + this.durationMs; },
};
rt.register({ name: "android/transition/Transition", ctor: JTransition, ifaces: ["java/lang/Cloneable"], methods: transitionMethods });
for (const n of ["Transition$TransitionListener", "Transition$EpicenterCallback", "PathMotion", "TransitionPropagation", "TransitionValues"]) {
  rt.register({ name: "android/transition/" + n, ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
}
rt.register({
  name: "android/transition/TransitionListenerAdapter", ctor: class extends JObj {}, ifaces: ["android/transition/Transition$TransitionListener"],
  methods: Object.fromEntries(["onTransitionStart", "onTransitionEnd", "onTransitionCancel", "onTransitionPause", "onTransitionResume"]
    .map((m) => [`${m}(Landroid/transition/Transition;)V`, () => {}]).concat([["<init>()V", function () {}]])),
});
// the concrete transitions: same bookkeeping, distinct classes so instanceof and getName hold
for (const [n, ctors] of [
  ["Visibility", ["()V", "(I)V"]], ["Fade", ["()V", "(I)V"]], ["ChangeBounds", ["()V"]], ["ChangeTransform", ["()V"]],
  ["ChangeClipBounds", ["()V"]], ["ChangeImageTransform", ["()V"]], ["ChangeScroll", ["()V"]], ["Slide", ["()V", "(I)V"]], ["Explode", ["()V"]],
] as const) {
  rt.register({
    name: "android/transition/" + n, ctor: class extends JTransition {}, sup: n === "Fade" || n === "Slide" || n === "Explode" ? "android/transition/Visibility" : "android/transition/Transition",
    statics: n === "Fade" ? { IN: 1, OUT: 2 } : n === "Visibility" ? { MODE_IN: 1, MODE_OUT: 2 } : {},
    methods: {
      ...Object.fromEntries(ctors.map((c) => [`<init>${c}`, function () {}])),
      ...(n === "Visibility" ? { "setMode(I)V": () => {}, "getMode()I": () => 3 } : {}),
      ...(n === "ChangeBounds" ? { "setResizeClip(Z)V": () => {}, "getResizeClip()Z": () => 0 } : {}),
      ...(n === "Slide" ? { "setSlideEdge(I)V": () => {}, "getSlideEdge()I": () => 80 } : {}),
    },
  });
}
const S = "Landroid/transition/TransitionSet;";
const setMethods: NonNullable<NativeSpec["methods"]> = {
  ...transitionMethods,
  "<init>()V": function () {},
  [`addTransition(${T})${S}`]: function (this: JTransitionSet, t: JTransition) { if (t) this.kids.push(t); return this; },
  [`removeTransition(${T})${S}`]: function (this: JTransitionSet, t: JTransition) { const i = this.kids.indexOf(t); if (i >= 0) this.kids.splice(i, 1); return this; },
  "getTransitionAt(I)Landroid/transition/Transition;": function (this: JTransitionSet, i: number) { return this.kids[i] ?? null; },
  "getTransitionCount()I": function (this: JTransitionSet) { return this.kids.length; },
  [`setOrdering(I)${S}`]: function (this: JTransitionSet, o: number) {
    if (o !== 0 && o !== 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid parameter for TransitionSet ordering: " + o);
    this.ordering = o; return this;
  },
  "getOrdering()I": function (this: JTransitionSet) { return this.ordering; },
  [`setDuration(J)${S}`]: function (this: JTransitionSet, d: bigint) { this.durationMs = d; for (const k of this.kids) k.durationMs = d; return this; },
  [`setStartDelay(J)${S}`]: function (this: JTransitionSet, d: bigint) { this.delayMs = d; return this; },
  [`setInterpolator(Landroid/animation/TimeInterpolator;)${S}`]: function (this: JTransitionSet, i: unknown) { this.interp = i; for (const k of this.kids) k.interp = i; return this; },
  [`addListener(Landroid/transition/Transition$TransitionListener;)${S}`]: function (this: JTransitionSet, l: unknown) { return listen(this, l, true); },
  [`removeListener(Landroid/transition/Transition$TransitionListener;)${S}`]: function (this: JTransitionSet, l: unknown) { return listen(this, l, false); },
  [`addTarget(Landroid/view/View;)${S}`]: function (this: JTransitionSet, v: unknown) { this.targets.a.push(v); for (const k of this.kids) k.targets.a.push(v); return this; },
  [`addTarget(I)${S}`]: function (this: JTransitionSet, id: number) { this.targetIds.a.push(id); return this; },
  [`addTarget(Ljava/lang/String;)${S}`]: function (this: JTransitionSet, n: string) { this.targetNames.a.push(n); return this; },
  [`addTarget(Ljava/lang/Class;)${S}`]: function (this: JTransitionSet, c: unknown) { this.targetTypes.a.push(c); return this; },
  [`removeTarget(Landroid/view/View;)${S}`]: function (this: JTransitionSet, v: unknown) { const i = this.targets.a.indexOf(v); if (i >= 0) this.targets.a.splice(i, 1); return this; },
  [`removeTarget(I)${S}`]: function (this: JTransitionSet, id: number) { const i = this.targetIds.a.indexOf(id); if (i >= 0) this.targetIds.a.splice(i, 1); return this; },
  "clone()Landroid/transition/Transition;": function (this: JTransitionSet) {
    const c = new JTransitionSet();
    Object.assign(c, this, { listeners: [], kids: this.kids.map((k) => vcall(k, "clone", "()Landroid/transition/Transition;")) });
    return c;
  },
};
rt.register({ name: "android/transition/TransitionSet", ctor: JTransitionSet, sup: "android/transition/Transition", statics: { ORDERING_TOGETHER: 0, ORDERING_SEQUENTIAL: 1 }, methods: setMethods });
rt.register({
  name: "android/transition/AutoTransition", ctor: class extends JTransitionSet {}, sup: "android/transition/TransitionSet",
  methods: {
    // AOSP: sequential Fade(OUT) → ChangeBounds → Fade(IN)
    "<init>()V": function (this: JTransitionSet) {
      this.ordering = 1;
      for (const n of ["Fade", "ChangeBounds", "Fade"]) this.kids.push(rt.make("android/transition/" + n) as JTransition);
    },
  },
});

/** the scene change is whatever the caller does next; the listeners hear start/end once it lands */
function beginDelayed(t: JTransition | null) {
  requestLayout();
  if (!t) return;
  void onMain(async () => { await fire(t, "onTransitionStart"); await fire(t, "onTransitionEnd"); });
}
rt.register({
  name: "android/transition/TransitionManager", ctor: class extends JObj {},
  methods: {
    "static beginDelayedTransition(Landroid/view/ViewGroup;)V": () => beginDelayed(null),
    "static beginDelayedTransition(Landroid/view/ViewGroup;Landroid/transition/Transition;)V": (_root: unknown, t: JTransition | null) => beginDelayed(t),
    "static go(Landroid/transition/Scene;)V": maySuspend((s: unknown) => vcall(s, "enter", "()V")),
    "static go(Landroid/transition/Scene;Landroid/transition/Transition;)V": maySuspend((s: unknown, t: JTransition | null) => { beginDelayed(t); return vcall(s, "enter", "()V"); }),
    ...noops("<init>()V", "static endTransitions(Landroid/view/ViewGroup;)V",
      "setTransition(Landroid/transition/Scene;Landroid/transition/Transition;)V"),
    "transitionTo(Landroid/transition/Scene;)V": maySuspend((s: unknown) => vcall(s, "enter", "()V")),
  },
});
