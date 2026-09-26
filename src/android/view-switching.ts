import { rt, driven, type Gen } from "../jvm/runtime";
import { jmethod, mangleMethod } from "../jvm/abi";
import { vcall, curThread, vcallOn, newObj } from "../jvm/natives/jlang";
import { JFrameLayout } from "./layouts";
import { JView, type JLayoutParams, initViewFromCtx } from "./view";
import { AID, obtainStyled, rvInt, type JAttrSet } from "./res";
import { JFnRunnable, mainHandler } from "./os";

class JViewAnimator extends JFrameLayout {
  displayed = 0;
  first = true;
  animateFirst = true;
  inAnimation: unknown = null;
  outAnimation: unknown = null;
  override measureAllChildren = true;
}
const base = (self: JViewAnimator, name: string, desc: string, ...args: unknown[]) =>
  jmethod(JFrameLayout.prototype, mangleMethod(name, desc))!.apply(self, args);
async function init(this: JViewAnimator, context: unknown, attrs: JAttrSet | null = null) {
  await initViewFromCtx(this, context, attrs);
  if (!this.jres) return;
  const ta = obtainStyled(this.jres, this.theme, attrs,
    [AID("inAnimation"), AID("outAnimation"), AID("animateFirstView"), AID("measureAllChildren")], 0, 0);
  this.animateFirst = !!rvInt(this.jres, ta.vals[2], 1);
  this.measureAllChildren = !!rvInt(this.jres, ta.vals[3], 1);
  for (const [i, name] of ["setInAnimation", "setOutAnimation"].entries()) {
    const id = ta.vals[i]?.d ?? 0;
    if (id) await vcall(this, name, "(Landroid/content/Context;I)V", context, id);
  }
}
async function show(this: JViewAnimator, index: number, animate = !this.first || this.animateFirst) {
  const thread = curThread;
  for (let i = 0; i < this.children.length; i++) {
    const child = this.children[i], selected = i === index;
    const animation = selected ? this.inAnimation : child.visibility === 0 ? this.outAnimation : null;
    if (animate && animation) await vcallOn(thread, child, "startAnimation", "(Landroid/view/animation/Animation;)V", animation);
    else if (!selected && child.jAnim === this.inAnimation) await vcallOn(thread, child, "clearAnimation", "()V");
    await vcallOn(thread, child, "setVisibility", "(I)V", selected ? 0 : 8);
    if (selected) this.first = false;
  }
}
async function display(this: JViewAnimator, index: number) {
  this.displayed = index >= this.children.length ? 0 : index < 0 ? this.children.length - 1 : index;
  const focused = await vcall(this, "getFocusedChild", "()Landroid/view/View;");
  await show.call(this, this.displayed);
  if (focused) await vcall(this, "requestFocus", "(I)Z", 2);
}
async function removeAt(this: JViewAnimator, index: number) {
  await base(this, "removeViewAt", "(I)V", index);
  if (!this.children.length) { this.displayed = 0; this.first = true; }
  else if (this.displayed >= this.children.length || this.displayed === index) await vcall(this, "setDisplayedChild", "(I)V", Math.min(this.displayed, this.children.length - 1));
}
async function remove(this: JViewAnimator, child: JView) {
  const index = this.children.indexOf(child);
  if (index >= 0) await vcall(this, "removeViewAt", "(I)V", index);
}
async function removeRange(this: JViewAnimator, start: number, count: number) {
  await base(this, "removeViews", "(II)V", start, count);
  if (!this.children.length) { this.displayed = 0; this.first = true; }
  else if (this.displayed >= start && this.displayed < start + count) await vcall(this, "setDisplayedChild", "(I)V", this.displayed);
}
rt.register({ name: "android/widget/ViewAnimator", ctor: JViewAnimator, sup: "android/widget/FrameLayout", methods: {
  "<init>(Landroid/content/Context;)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": init,
  "setDisplayedChild(I)V": display,
  "getDisplayedChild()I": function (this: JViewAnimator) { return this.displayed; },
  "getCurrentView()Landroid/view/View;": function (this: JViewAnimator) { return this.children[this.displayed] ?? null; },
  "getBaseline()I": function (this: JViewAnimator) { const child = this.children[this.displayed]; return child ? vcall(child, "getBaseline", "()I") : base(this, "getBaseline", "()I"); },
  "showNext()V": function (this: JViewAnimator) { return vcall(this, "setDisplayedChild", "(I)V", this.displayed + 1); },
  "showPrevious()V": function (this: JViewAnimator) { return vcall(this, "setDisplayedChild", "(I)V", this.displayed - 1); },
  "showOnly(I)V": show,
  "showOnly(IZ)V": function (this: JViewAnimator, index: number, animate: number) { return show.call(this, index, !!animate); },
  "addView(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V": driven(function* (this: JViewAnimator, child: JView, index: number, lp: JLayoutParams): Gen {
    yield base(this, "addView", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V", child, index, lp);
    yield vcall(child, "setVisibility", "(I)V", this.children.length === 1 ? 0 : 8);
    if (index >= 0 && this.displayed >= index) yield vcall(this, "setDisplayedChild", "(I)V", this.displayed + 1);
  }),
  "removeViewAt(I)V": removeAt,
  "removeView(Landroid/view/View;)V": remove,
  "removeViewInLayout(Landroid/view/View;)V": remove,
  "removeViews(II)V": removeRange,
  "removeViewsInLayout(II)V": removeRange,
  "removeAllViews()V": driven(function* (this: JViewAnimator): Gen { yield base(this, "removeAllViews", "()V"); this.displayed = 0; this.first = true; }),
  "setAnimateFirstView(Z)V": function (this: JViewAnimator, animate: number) { this.animateFirst = !!animate; },
  "getAnimateFirstView()Z": function (this: JViewAnimator) { return +this.animateFirst; },
  "setInAnimation(Landroid/view/animation/Animation;)V": function (this: JViewAnimator, animation: unknown) { this.inAnimation = animation; },
  "setOutAnimation(Landroid/view/animation/Animation;)V": function (this: JViewAnimator, animation: unknown) { this.outAnimation = animation; },
  "getInAnimation()Landroid/view/animation/Animation;": function (this: JViewAnimator) { return this.inAnimation; },
  "getOutAnimation()Landroid/view/animation/Animation;": function (this: JViewAnimator) { return this.outAnimation; },
  "setInAnimation(Landroid/content/Context;I)V": driven(function* (this: JViewAnimator, context: unknown, id: number): Gen { this.inAnimation = yield vcall(rt.link("android/view/animation/AnimationUtils").ctor, "loadAnimation", "(Landroid/content/Context;I)Landroid/view/animation/Animation;", context, id); }),
  "setOutAnimation(Landroid/content/Context;I)V": driven(function* (this: JViewAnimator, context: unknown, id: number): Gen { this.outAnimation = yield vcall(rt.link("android/view/animation/AnimationUtils").ctor, "loadAnimation", "(Landroid/content/Context;I)Landroid/view/animation/Animation;", context, id); }),
} });

class JViewFlipper extends JViewAnimator {
  interval = 3000;
  autoStart = false;
  started = false;
  windowVisible = false;
  running = false;
  flip: JFnRunnable | null = null;
  update(animate = true): unknown { return rt.drive(this.update$(animate)); }
  *update$(animate = true): Gen {
    const running = this.windowVisible && this.started;
    if (running === this.running) return;
    this.running = running;
    if (!running) { if (this.flip) mainHandler().cancel(this.flip); return; }
    if (!this.flip) {
      const flip: JFnRunnable = rt.make("webdroid/FnRunnable");
      this.flip = flip;
      flip.fn = async () => {
        if (!this.running) return;
        await vcall(this, "showNext", "()V");
        if (this.running) mainHandler().post(this.flip, this.interval);
      };
    }
    yield vcall(this, "showOnly", "(IZ)V", this.displayed, +animate);
    if (this.running) mainHandler().post(this.flip, this.interval);
  }
}
async function initFlipper(this: JViewFlipper, context: unknown, attrs: JAttrSet | null = null) {
  await init.call(this, context, attrs);
  if (!this.jres) return;
  const ta = obtainStyled(this.jres, this.theme, attrs, [AID("flipInterval"), AID("autoStart")], 0, 0);
  this.interval = rvInt(this.jres, ta.vals[0], 3000);
  this.autoStart = !!rvInt(this.jres, ta.vals[1], 0);
}
rt.register({ name: "android/widget/ViewFlipper", ctor: JViewFlipper, sup: "android/widget/ViewAnimator", methods: {
  "<init>(Landroid/content/Context;)V": initFlipper,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initFlipper,
  "setFlipInterval(I)V": function (this: JViewFlipper, interval: number) { this.interval = interval; },
  "getFlipInterval()I": function (this: JViewFlipper) { return this.interval; },
  "setAutoStart(Z)V": function (this: JViewFlipper, auto: number) { this.autoStart = !!auto; },
  "isAutoStart()Z": function (this: JViewFlipper) { return +this.autoStart; },
  "isFlipping()Z": function (this: JViewFlipper) { return +this.started; },
  "startFlipping()V": function (this: JViewFlipper) { this.started = true; return this.update(); },
  "stopFlipping()V": function (this: JViewFlipper) { this.started = false; return this.update(); },
  "onAttachedToWindow()V": driven(function* (this: JViewFlipper): Gen {
    this.windowVisible = (yield vcall(this, "getWindowVisibility", "()I")) === 0;
    if (this.autoStart) yield vcall(this, "startFlipping", "()V");
    else yield this.update(false);
  }),
  "onDetachedFromWindow()V": function (this: JViewFlipper) { this.windowVisible = false; return this.update(); },
  "onWindowVisibilityChanged(I)V": function (this: JViewFlipper, visibility: number) { this.windowVisible = visibility === 0; return this.update(false); },
} });

rt.markers("android/widget/ViewSwitcher$ViewFactory");
rt.register({ name: "android/widget/ViewSwitcher", ctor: class extends JViewAnimator {}, sup: "android/widget/ViewAnimator", methods: {
  "<init>(Landroid/content/Context;)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": init,
  "addView(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V": function (this: JViewAnimator, child: JView, index: number, lp: JLayoutParams) {
    if (this.children.length >= 2) throw rt.mkThrowable("java/lang/IllegalStateException", "Can't add more than 2 views to a ViewSwitcher");
    return jmethod(JViewAnimator.prototype, mangleMethod("addView", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V"))!.call(this, child, index, lp);
  },
  "getNextView()Landroid/view/View;": function (this: JViewAnimator) { return this.children[this.displayed === 0 ? 1 : 0] ?? null; },
  "setFactory(Landroid/widget/ViewSwitcher$ViewFactory;)V": driven(function* (this: JViewAnimator, factory: unknown): Gen {
    for (let i = 0; i < 2; i++) {
      const child = yield vcall(factory, "makeView", "()Landroid/view/View;");
      const lp = (yield vcall(child, "getLayoutParams", "()Landroid/view/ViewGroup$LayoutParams;")) ?? (yield newObj("android/widget/FrameLayout$LayoutParams", "(II)V", -1, -2));
      yield vcall(this, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", child, lp);
    }
  }),
  "reset()V": driven(function* (this: JViewAnimator): Gen { this.first = true; for (const child of this.children) yield vcall(child, "setVisibility", "(I)V", 8); }),
} });
