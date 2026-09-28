import { JObj, type NativeSpec, rt, stubs } from "../jvm/runtime";
import { insetsOf } from "./graphics";
import { device } from "../shell/config";
import type { JView } from "./view";
import { vcall } from "../jvm/natives/jlang";

// ── WindowInsets. AOSP keeps one Insets value per Type bit and dispatches the window's insets
// down the tree on every traversal; androidx's WindowInsetsCompat is a thin wrapper over it, and
// a Material app reads its bar heights (and often its own "the view is ready" signal) from there.
type Ins = { left: number; top: number; right: number; bottom: number };
/** android.view.WindowInsets.Type bit positions */
const IT_STATUS = 0, IT_NAV = 1, IT_CAPTION = 2, IT_IME = 3, IT_GESTURES = 4,
  IT_MANDATORY = 5, IT_TAPPABLE = 6, IT_CUTOUT = 7, IT_OVERLAYS = 8, IT_TYPES = 9;
const TYPE_BARS = (1 << IT_STATUS) | (1 << IT_NAV) | (1 << IT_CAPTION);

export class JWindowInsets extends JObj {
  ins: (Ins | null)[] = new Array(IT_TYPES).fill(null);
  /** per-type visibility, as AOSP's mVisible bitmask */
  vis = ~0;
  consumedV = false;
  copy(): JWindowInsets {
    const w = new JWindowInsets();
    w.ins = this.ins.slice(); w.vis = this.vis; w.consumedV = this.consumedV;
    return w;
  }
}
/** AOSP unions the requested types side by side (max), skipping invisible ones */
function insUnion(w: JWindowInsets, mask: number, ignoreVis: boolean) {
  let l = 0, t = 0, r = 0, b = 0;
  for (let i = 0; i < IT_TYPES; i++) {
    if (!(mask & (1 << i))) continue;
    if (!ignoreVis && !(w.vis & (1 << i))) continue;
    const s = w.ins[i];
    if (!s) continue;
    if (s.left > l) l = s.left; if (s.top > t) t = s.top;
    if (s.right > r) r = s.right; if (s.bottom > b) b = s.bottom;
  }
  return insetsOf(l, t, r, b);
}
const insShrink = (s: Ins | null, l: number, t: number, r: number, b: number): Ins | null =>
  !s ? null : { left: Math.max(0, s.left - l), top: Math.max(0, s.top - t), right: Math.max(0, s.right - r), bottom: Math.max(0, s.bottom - b) };
/** the bars as one rect, the shape the deprecated system-window API and fitSystemWindows use */
export const sysIns = (w: JWindowInsets) => insUnion(w, TYPE_BARS, false);

const rootInsets = new WeakMap<JView, { top: number; bottom: number; vis: number; value: JWindowInsets }>();
export function rootWindowInsets(view?: JView): JWindowInsets {
  let root = view;
  while (root?.parent) root = root.parent;
  const win = root?.windowOwner, flags = win?.flags ?? 0, sysUi = root?.systemUiVisibility ?? 0;
  const hidden = (win?.hiddenInsets ?? 0) | (flags & 1024 || sysUi & 4 ? 1 : 0) | (sysUi & 2 ? 2 : 0);
  const top = Math.max(0, device.statusBar - (root?.top ?? 0));
  // an activity window's frame is the screen; insets dispatch before layout, so after a rotation
  // its root would still report the old frame
  const frameBottom = win?.activity && !win.dialog ? device.height : root?.bottom || device.height;
  const bottom = Math.max(0, frameBottom - (device.height - device.navBar));
  const vis = ~((1 << IT_IME) | (1 << IT_CUTOUT) | (1 << IT_CAPTION) | (device.statusBar ? 0 : 1 << IT_STATUS) | hidden);
  const cached = root && rootInsets.get(root);
  if (cached && cached.top === top && cached.bottom === bottom && cached.vis === vis) return cached.value;
  const w = new JWindowInsets();
  w.ins[IT_STATUS] = { left: 0, top, right: 0, bottom: 0 };
  const bar = { left: 0, top: 0, right: 0, bottom };
  w.ins[IT_NAV] = w.ins[IT_GESTURES] = w.ins[IT_MANDATORY] = bar;
  // no soft keyboard, no cutout, no freeform caption: those types exist but are never shown
  w.vis = vis;
  if (root) rootInsets.set(root, { top, bottom, vis, value: w });
  return w;
}
/** AOSP's ViewRootImpl traversal: hand the window's insets to the decor, which walks them down */
export async function dispatchWindowInsets(root: JView) {
  await vcall(root, "dispatchApplyWindowInsets",
    "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", rootWindowInsets(root));
}

// the stable and system-window forms both report the bars' insets
const sysInsets = function (this: JWindowInsets) { return sysIns(this); };
const sysInsetLeft = function (this: JWindowInsets) { return sysIns(this).left; };
const sysInsetTop = function (this: JWindowInsets) { return sysIns(this).top; };
const sysInsetRight = function (this: JWindowInsets) { return sysIns(this).right; };
const sysInsetBottom = function (this: JWindowInsets) { return sysIns(this).bottom; };
const hasSysInsets = function (this: JWindowInsets) { const s = sysIns(this); return s.left || s.top || s.right || s.bottom ? 1 : 0; };
const self = function (this: JWindowInsets) { return this; };
const wiMethods: NativeSpec["methods"] = {
  "<init>(Landroid/view/WindowInsets;)V": function (this: JWindowInsets, o: JWindowInsets | null) {
    if (o) { this.ins = o.ins.slice(); this.vis = o.vis; this.consumedV = o.consumedV; }
  },
  "getInsets(I)Landroid/graphics/Insets;": function (this: JWindowInsets, m: number) { return insUnion(this, m, false); },
  "getInsetsIgnoringVisibility(I)Landroid/graphics/Insets;": function (this: JWindowInsets, m: number) { return insUnion(this, m, true); },
  "isVisible(I)Z": function (this: JWindowInsets, m: number) { return (this.vis & m) === m ? 1 : 0; },
  "getSystemWindowInsets()Landroid/graphics/Insets;": sysInsets,
  "getStableInsets()Landroid/graphics/Insets;": sysInsets,
  "getSystemGestureInsets()Landroid/graphics/Insets;": function (this: JWindowInsets) { return insUnion(this, 1 << IT_GESTURES, true); },
  "getMandatorySystemGestureInsets()Landroid/graphics/Insets;": function (this: JWindowInsets) { return insUnion(this, 1 << IT_MANDATORY, true); },
  "getTappableElementInsets()Landroid/graphics/Insets;": function (this: JWindowInsets) { return insUnion(this, 1 << IT_TAPPABLE, true); },
  "getSystemWindowInsetLeft()I": sysInsetLeft,
  "getSystemWindowInsetTop()I": sysInsetTop,
  "getSystemWindowInsetRight()I": sysInsetRight,
  "getSystemWindowInsetBottom()I": sysInsetBottom,
  "getStableInsetLeft()I": sysInsetLeft,
  "getStableInsetTop()I": sysInsetTop,
  "getStableInsetRight()I": sysInsetRight,
  "getStableInsetBottom()I": sysInsetBottom,
  "hasSystemWindowInsets()Z": hasSysInsets,
  "hasStableInsets()Z": hasSysInsets,
  "hasInsets()Z": function (this: JWindowInsets) { return this.ins.some((i) => i) ? 1 : 0; },
  "isConsumed()Z": function (this: JWindowInsets) { return this.consumedV ? 1 : 0; },
  ...stubs(0, "isRound()Z"),
  ...stubs(null, "getDisplayCutout()Landroid/view/DisplayCutout;", "getRoundedCorner(I)Landroid/view/RoundedCorner;",
    "getPrivacyIndicatorBounds()Landroid/graphics/Rect;"),
  "consumeDisplayCutout()Landroid/view/WindowInsets;": self,
  "consumeStableInsets()Landroid/view/WindowInsets;": self,
  // Consuming the bars is how a parent tells the rest of the tree "I have handled these": AOSP's
  // ViewGroup stops walking down as soon as the returned insets report themselves consumed.
  "consumeSystemWindowInsets()Landroid/view/WindowInsets;": function (this: JWindowInsets) {
    const w = this.copy();
    for (let i = 0; i < IT_TYPES; i++) if (TYPE_BARS & (1 << i)) w.ins[i] = null;
    w.consumedV = true;
    return w;
  },
  "replaceSystemWindowInsets(IIII)Landroid/view/WindowInsets;": function (this: JWindowInsets, l: number, t: number, r: number, b: number) {
    const w = this.copy();
    w.ins[IT_STATUS] = { left: l, top: t, right: r, bottom: 0 };
    w.ins[IT_NAV] = { left: 0, top: 0, right: 0, bottom: b };
    return w;
  },
  "inset(IIII)Landroid/view/WindowInsets;": function (this: JWindowInsets, l: number, t: number, r: number, b: number) {
    const w = this.copy();
    w.ins = w.ins.map((s) => insShrink(s, l, t, r, b));
    return w;
  },
  "equals(Ljava/lang/Object;)Z": function (this: JWindowInsets, o: unknown) {
    if (!(o instanceof JWindowInsets) || o.vis !== this.vis || o.consumedV !== this.consumedV) return 0;
    return this.ins.every((s, i) => {
      const t = o.ins[i];
      return !s || !t ? s === t : s.left === t.left && s.top === t.top && s.right === t.right && s.bottom === t.bottom;
    }) ? 1 : 0;
  },
  "hashCode()I": function (this: JWindowInsets) { const s = sysIns(this); return (s.left * 31 + s.top) * 31 + s.bottom; },
  "toString()Ljava/lang/String;": function (this: JWindowInsets) { return `WindowInsets{${sysIns(this)}}`; },
};
const CONSUMED_INSETS = new JWindowInsets();
CONSUMED_INSETS.consumedV = true;
rt.register({
  name: "android/view/WindowInsets", ctor: JWindowInsets,
  statics: { CONSUMED: CONSUMED_INSETS },
  methods: wiMethods,
});
rt.register({
  name: "android/view/WindowInsets$Type", ctor: class extends JObj {},
  methods: {
    "static statusBars()I": () => 1 << IT_STATUS,
    "static navigationBars()I": () => 1 << IT_NAV,
    "static captionBar()I": () => 1 << IT_CAPTION,
    "static ime()I": () => 1 << IT_IME,
    "static systemGestures()I": () => 1 << IT_GESTURES,
    "static mandatorySystemGestures()I": () => 1 << IT_MANDATORY,
    "static tappableElement()I": () => 1 << IT_TAPPABLE,
    "static displayCutout()I": () => 1 << IT_CUTOUT,
    "static systemBars()I": () => TYPE_BARS,
    "static systemOverlays()I": () => 1 << IT_OVERLAYS,
    "static all()I": () => -1,
  },
});
class JWIBuilder extends JObj { w = new JWindowInsets(); }
/** one Type bit at a time, as AOSP's Builder does (a mask with several bits is a hidden error) */
const wibSet = function (this: JWIBuilder, mask: number, i: Ins | null) {
  for (let b = 0; b < IT_TYPES; b++) if (mask & (1 << b)) this.w.ins[b] = i;
  return this;
};
rt.register({
  name: "android/view/WindowInsets$Builder", ctor: JWIBuilder,
  methods: {
    "<init>()V": function (this: JWIBuilder) { this.w = new JWindowInsets(); },
    "<init>(Landroid/view/WindowInsets;)V": function (this: JWIBuilder, o: JWindowInsets | null) { this.w = o ? o.copy() : new JWindowInsets(); },
    "setInsets(ILandroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": wibSet,
    "setInsetsIgnoringVisibility(ILandroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": wibSet,
    "setVisible(IZ)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder, mask: number, on: number) {
      this.w.vis = on ? this.w.vis | mask : this.w.vis & ~mask;
      return this;
    },
    // the deprecated whole-window setters: split the rect back into the bars it describes
    "setSystemWindowInsets(Landroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder, i: Ins) {
      this.w.ins[IT_STATUS] = { left: i.left, top: i.top, right: i.right, bottom: 0 };
      this.w.ins[IT_NAV] = { left: 0, top: 0, right: 0, bottom: i.bottom };
      return this;
    },
    "setStableInsets(Landroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder) { return this; },
    "setSystemGestureInsets(Landroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder, i: Ins) { this.w.ins[IT_GESTURES] = i; return this; },
    "setMandatorySystemGestureInsets(Landroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder, i: Ins) { this.w.ins[IT_MANDATORY] = i; return this; },
    "setTappableElementInsets(Landroid/graphics/Insets;)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder, i: Ins) { this.w.ins[IT_TAPPABLE] = i; return this; },
    "setDisplayCutout(Landroid/view/DisplayCutout;)Landroid/view/WindowInsets$Builder;": function (this: JWIBuilder) { return this; },
    "build()Landroid/view/WindowInsets;": function (this: JWIBuilder) { return this.w; },
  },
});
