// android.graphics.drawable.* — Drawable hierarchy, XML inflation, 9-patch, vectors.

import { rt, JObj, type NativeSpec, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { vcall, vcallOn, curThread, callOn, after, newObj, defineException, mkEnumSet, type JSimpleEnum } from "../jvm/natives/jlang";
import { mangleMethod, jmethod, jarray, parseMethodDesc } from "../jvm/abi";
import { JCanvas, JRect, JRectF, JBitmap, JPaint, cssColor, decodeBytes, tintedBmp, matrixColor, colorFilterOf, modeConstant, insetsOf, isNinePatchChunk, validNinePatchChunk, ninePatchOf, drawNinePatch, decodeResourceStream, JBFOptions, type NinePatchChunk } from "./graphics";
import { device } from "../shell/config";
import { onMain } from "./mainloop";
import { uptimeMillis } from "./os";
import { Resources, type RV, type JTheme, attrTable, T_STR, rvColor, rvDimen, rvFloat, rvString, nodeAttrRV, xmlAttrRV, resolveStyleValue, attrSet, nativeTheme, javaField, nativeRes } from "./res";
import { parserRoot, reopenParser } from "./assetmanager";
import { absGravity, gravityApply } from "./gravity";
import { complexToFraction, type JTypedValue } from "./util";
import { TV, parseAXML, type XmlNode } from "./axml";
import { guestNow, setGuestTimeout } from "../guest-clock";
import { parsePathData } from "./pathdata";
import { applyTimeline, cloneTree, drawVectorGroup, tinted, loadTimeline, namedTargets, timelineLength, type Timeline, type VGroup, type VPath, type VRoot } from "./vector";

export const ST = {
  pressed: 0x010100a7, enabled: 0x0101009e, selected: 0x010100a1, checked: 0x010100a0,
  focused: 0x0101009c, activated: 0x010102fe, window_focused: 0x0101009d, checkable: 0x0101009f,
  hovered: 0x01010367, last: 0x010100a6, expanded: 0x010100a8, empty: 0x010100a9,
};

export class JDrawable extends JObj {
  bounds = new JRect();
  level = 0;
  alpha = 255;
  stateSet: number[] = [];
  callback: unknown = null; // Drawable.Callback (usually a View)
  tint: number | null = null;
  tintCsl: JColorStateList | null = null;
  tintMode: string | null = "SRC_IN";
  tintMatrix: Float32Array | null = null;
  autoMirrored = false;
  layoutDir = 0;
  visible = true;
  // AOSP's mSetTintModeInvoked/mSetBlendModeInvoked: each tint-mode setter forwards to the other once
  settingTintMode = false;
  settingBlendMode = false;

  /** TS-side paint. Subclasses override. */
  paint(cv: JCanvas): unknown { return undefined; }
  size(vertical: boolean): number | Promise<number> { return -1; }
  onStateChange(): boolean { return false; }
}

export function drawableSize(d: JDrawable, vertical: boolean, thread = curThread): number | Promise<number> {
  return after(vcallOn(thread, d, vertical ? "getIntrinsicHeight" : "getIntrinsicWidth", "()I"), Number);
}
const M_onBoundsChange = mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V");
const M_setBounds = mangleMethod("setBounds", "(IIII)V");
const M_onStateChange = mangleMethod("onStateChange", "([I)Z");
const M_onLevelChange = mangleMethod("onLevelChange", "(I)Z");
const M_invalidateSelf = mangleMethod("invalidateSelf", "()V");
const M_getCallback = mangleMethod("getCallback", "()Landroid/graphics/drawable/Drawable$Callback;");
const M_drawD = mangleMethod("draw", "(Landroid/graphics/Canvas;)V");
/**
 * Draw a drawable this one does not own. A container must go through the child's virtual
 * `draw(Canvas)`, never its TS `paint()`: an app-dex Drawable subclass (Material's
 * MaterialShapeDrawable, every library's shape/insets wrapper) has no `paint`, so it inherits
 * the base class's empty one and the child silently draws nothing. Returns whatever the child
 * returns, so a compiled override that suspends is awaitable by a caller that can.
 */
export function drawChild(d: JDrawable, cv: JCanvas, thread = curThread): unknown {
  const f = (d as unknown as Record<string, (cv: JCanvas) => unknown>)[M_drawD];
  return callOn(thread, () => f ? f.call(d, cv) : d.paint(cv));
}
/** AOSP setBounds: only a real change invalidates the old area and reaches onBoundsChange, both
 *  dispatched virtually so an app subclass's override (shape caches, wrapped children) sees it.
 *  Views here set bounds on every draw rather than on a size change, so the platform's own
 *  invalidateSelf is skipped: a drawable shared by two views of different sizes would otherwise
 *  invalidate every frame. */
function setBounds(this: JDrawable, l: number, t: number, r: number, b: number) {
  const bd = this.bounds;
  if (bd.left === l && bd.top === t && bd.right === r && bd.bottom === b) return;
  const inv = jmethod(this, M_invalidateSelf);
  if (inv && inv !== invalidateSelf && bd.left < bd.right && bd.top < bd.bottom) {
    const res = inv.call(this);
    if (res instanceof Promise) return res.then(() => applyBounds(this, l, t, r, b));
  }
  return applyBounds(this, l, t, r, b);
}
function applyBounds(d: JDrawable, l: number, t: number, r: number, b: number) {
  const bd = d.bounds;
  bd.left = l; bd.top = t; bd.right = r; bd.bottom = b;
  const f = jmethod(d, M_onBoundsChange);
  const res = f ? f.call(d, bd) : onBoundsChangeAll(d);
  if (res instanceof Promise) return res;
}
/** AOSP reaches the callback through getCallback(), which a subclass may override */
function withCallback(d: JDrawable, use: (callback: unknown) => void) {
  const f = jmethod(d, M_getCallback);
  const callback = f ? f.call(d) : d.callback;
  if (callback instanceof Promise) void callback.then((c) => { if (c) use(c); });
  else if (callback) use(callback);
}
function scheduleSelf(this: JDrawable, r: unknown, when: bigint) {
  withCallback(this, (c) => void vcall(c, "scheduleDrawable", "(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;J)V", this, r, when));
}
function unscheduleSelf(this: JDrawable, r: unknown) {
  withCallback(this, (c) => void vcall(c, "unscheduleDrawable", "(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;)V", this, r));
}
function invalidateSelf(this: JDrawable) {
  withCallback(this, (c) => void vcall(c, "invalidateDrawable", "(Landroid/graphics/drawable/Drawable;)V", this));
}
const drawableMethods: NativeSpec["methods"] = cslBoundary({
  "draw(Landroid/graphics/Canvas;)V": function (this: JDrawable, cv: JCanvas) { return this.paint(cv); },
  "setBounds(IIII)V": setBounds,
  // AOSP forwards through the virtual setBounds(IIII), which a subclass may override
  "setBounds(Landroid/graphics/Rect;)V": function (this: JDrawable, r: JRect) {
    return jmethod(this, M_setBounds)!.call(this, r.left, r.top, r.right, r.bottom);
  },
  "getBounds()Landroid/graphics/Rect;": function (this: JDrawable) { return this.bounds; },
  "copyBounds(Landroid/graphics/Rect;)V": function (this: JDrawable, r: JRect) {
    r.left = this.bounds.left; r.top = this.bounds.top; r.right = this.bounds.right; r.bottom = this.bounds.bottom;
  },
  "static createFromStream(Ljava/io/InputStream;Ljava/lang/String;)Landroid/graphics/drawable/Drawable;":
    (is: unknown) => createFromResourceStream(null, null, is, null),
  "static createFromResourceStream(Landroid/content/res/Resources;Landroid/util/TypedValue;Ljava/io/InputStream;Ljava/lang/String;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, value: JTypedValue | null, is: unknown) => createFromResourceStream(res, value, is, null),
  "static createFromResourceStream(Landroid/content/res/Resources;Landroid/util/TypedValue;Ljava/io/InputStream;Ljava/lang/String;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, value: JTypedValue | null, is: unknown, _name: string | null, opts: JBFOptions | null) => createFromResourceStream(res, value, is, opts),
  // what AOSP's ResourcesImpl.loadXmlDrawable and an app's XML parsing call: the document or the
  // element the parser stands on, inflated by our own drawable stack
  "static createFromXml(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, parser: unknown) => xmlDrawable(res, parser, null, false),
  "static createFromXml(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, parser: unknown, theme: unknown) => xmlDrawable(res, parser, theme, false),
  "static createFromXmlForDensity(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;ILandroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, parser: unknown, _density: number, theme: unknown) => xmlDrawable(res, parser, theme, false),
  "static createFromXmlInner(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, parser: unknown) => xmlDrawable(res, parser, null, true),
  "static createFromXmlInner(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;":
    (res: unknown, parser: unknown, _attrs: unknown, theme: unknown) => xmlDrawable(res, parser, theme, true),
  "getIntrinsicWidth()I": function (this: JDrawable) { return this.size(false); },
  "getIntrinsicHeight()I": function (this: JDrawable) { return this.size(true); },
  "getMinimumWidth()I": function (this: JDrawable) { return after(drawableSize(this, false), n => Math.max(0, n)); },
  "getMinimumHeight()I": function (this: JDrawable) { return after(drawableSize(this, true), n => Math.max(0, n)); },
  "setAlpha(I)V": function (this: JDrawable, a: number) { this.alpha = a; },
  "getAlpha()I": function (this: JDrawable) { return this.alpha; },
  "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JDrawable, f: object | null) {
    return after(colorFilterOf(f), (filter) => {
      this.tint = filter && !filter.matrix ? filter.color : null;
      this.tintMatrix = filter?.matrix ?? null;
    });
  },
  // both go through setColorFilter(ColorFilter), which an app's own Drawable implements
  "setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V": function (this: JDrawable, color: number, mode: unknown) {
    return after(newObj("android/graphics/PorterDuffColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", color, mode),
      (filter) => vcall(this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", filter));
  },
  "clearColorFilter()V": function (this: JDrawable) { return vcall(this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", null); },
  "setTint(I)V": function (this: JDrawable, c: number) { return vcall(this, "setTintList", "(Landroid/content/res/ColorStateList;)V", mkCsl(c)); },
  "setTintList(Landroid/content/res/ColorStateList;)V": function (this: JDrawable, csl: JColorStateList | null) {
    this.tintCsl = csl; this.tint = csl ? cslColor(csl, this.stateSet) : null;
  },
  "setTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JDrawable, mode: JSimpleEnum | null) {
    const name = mode?.ename ?? null;
    if (this.tintMode !== name) { this.tintMode = name; invalidateSelf.call(this); }
    return forwardOnce(this, "settingTintMode", () => after(modeConstant("android/graphics/BlendMode", blendOfTint(name)),
      (blend) => vcall(this, "setTintBlendMode", "(Landroid/graphics/BlendMode;)V", blend)));
  },
  "setTintBlendMode(Landroid/graphics/BlendMode;)V": function (this: JDrawable, blend: JSimpleEnum | null) {
    const name = blend?.ename ?? "";
    const mode = TINT_OF_BLEND[name] ?? (TINT_MODE_NAMES.has(name) ? name : "SRC_IN");
    return forwardOnce(this, "settingBlendMode", () => after(modeConstant("android/graphics/PorterDuff$Mode", mode),
      (porterDuff) => vcall(this, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", porterDuff)));
  },
  "setState([I)Z": driven(function* (this: JDrawable, st: Int32Array): Gen {
    const cur = this.stateSet;
    if (cur.length === st.length && cur.every((v, i) => v === st[i])) return 0;
    this.stateSet = [...st];
    // AOSP: every onStateChange that reports a visual change invalidates (StateListDrawable's
    // selectDrawable, RippleDrawable's setRippleActive); the callback is how a Compose ripple
    // host learns to re-record its layer, so a silent state change leaves a pressed ripple stuck.
    const tint = this.tintCsl ? cslColor(this.tintCsl, this.stateSet) : this.tint;
    const tintChanged = tint !== this.tint; this.tint = tint;
    if (!(yield jmethod(this, M_onStateChange)!.call(this, st)) && !tintChanged) return 0;
    invalidateSelf.call(this);
    return 1;
  }),
  "onStateChange([I)Z": function (this: JDrawable) { return this.onStateChange() ? 1 : 0; },
  "onBoundsChange(Landroid/graphics/Rect;)V": function (this: JDrawable) { return onBoundsChangeAll(this); },
  "onLevelChange(I)Z": () => 0,
  "getState()[I": function (this: JDrawable) { return Int32Array.from(this.stateSet); },
  "setLevel(I)Z": function (this: JDrawable, l: number) {
    if (this.level === l) return 0;
    this.level = l;
    return jmethod(this, M_onLevelChange)!.call(this, l);
  },
  "getLevel()I": function (this: JDrawable) { return this.level; },
  "setCallback(Landroid/graphics/drawable/Drawable$Callback;)V": function (this: JDrawable, cb: unknown) { this.callback = cb; },
  "getCallback()Landroid/graphics/drawable/Drawable$Callback;": function (this: JDrawable) { return this.callback; },
  // Drawable.Callback: every AOSP wrapping drawable (LayerDrawable, DrawableContainer,
  // AnimatedVectorDrawable...) is its child's callback and forwards up to its own.
  "scheduleSelf(Ljava/lang/Runnable;J)V": scheduleSelf,
  "unscheduleSelf(Ljava/lang/Runnable;)V": unscheduleSelf,
  "invalidateSelf()V": invalidateSelf,
  "scheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;J)V": function (this: JDrawable, _d: unknown, r: unknown, when: bigint) { scheduleSelf.call(this, r, when); },
  "unscheduleDrawable(Landroid/graphics/drawable/Drawable;Ljava/lang/Runnable;)V": function (this: JDrawable, _d: unknown, r: unknown) { unscheduleSelf.call(this, r); },
  "invalidateDrawable(Landroid/graphics/drawable/Drawable;)V": invalidateSelf,
  "mutate()Landroid/graphics/drawable/Drawable;": function (this: JDrawable) { return this; },
  "isStateful()Z": function (this: JDrawable) { return this instanceof JStateListDrawable || (this.tintCsl?.items.length ?? 0) > 1 || this instanceof JGradientDrawable && (this.solidCsl || this.strokeCsl) ? 1 : 0; },
  "getPadding(Landroid/graphics/Rect;)Z": function (this: JDrawable, r: JRect) {
    const p = (this as any).padding as JRect | undefined;
    if (p) { r.left = p.left; r.top = p.top; r.right = p.right; r.bottom = p.bottom; return 1; }
    r.left = r.top = r.right = r.bottom = 0;
    return 0;
  },
  "getOpacity()I": () => -3,
  "static resolveOpacity(II)I": (a: number, b: number) => a === b ? a : a === 0 || b === 0 ? 0 : a === -3 || b === -3 ? -3 : a === -2 || b === -2 ? -2 : -1,
  "setVisible(ZZ)Z": function (this: JDrawable, v: number) {
    if (this.visible === !!v) return 0;
    this.visible = !!v;
    return after(jmethod(this, M_invalidateSelf)!.call(this), () => 1);
  },
  "isVisible()Z": function (this: JDrawable) { return this.visible ? 1 : 0; },
  "getOutline(Landroid/graphics/Outline;)V": function (this: JDrawable, o: unknown) {
    const b = this.bounds;
    return vcall(o, "setRect", "(IIII)V", b.left, b.top, b.right, b.bottom);
  },
  "getOpticalInsets()Landroid/graphics/Insets;": () => insetsOf(0, 0, 0, 0),
  "setAutoMirrored(Z)V": function (this: JDrawable, m: number) { this.autoMirrored = !!m; },
  "isAutoMirrored()Z": function (this: JDrawable) { return this.autoMirrored ? 1 : 0; },
  "setLayoutDirection(I)Z": function (this: JDrawable, d: number) {
    if (this.layoutDir === d) return 0;
    this.layoutDir = d;
    return vcall(this, "onLayoutDirectionChanged", "(I)Z", d);
  },
  "getLayoutDirection()I": function (this: JDrawable) { return this.layoutDir; },
  "jumpToCurrentState()V": () => {},
  "getCurrent()Landroid/graphics/drawable/Drawable;": function (this: JDrawable) {
    return this instanceof JStateListDrawable ? this.current() : this;
  },
  "getDirtyBounds()Landroid/graphics/Rect;": function (this: JDrawable) { return this.bounds; },
  "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;)V": function (this: JDrawable, res: unknown, parser: unknown, attrs: unknown) {
    return vcall(this, "inflate", "(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V", res, parser, attrs, null);
  },
  ...noops("<init>()V", "applyTheme(Landroid/content/res/Resources$Theme;)V",
    "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V",
    "setChangingConfigurations(I)V", "setHotspot(FF)V", "clearMutated()V"),
  ...stubs(null, "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;"),
  ...stubs(0, "getChangingConfigurations()I", "isProjected()Z", "canApplyTheme()Z"),
});
/** Drawable.createFromXml*: `inner` inflates the element the parser stands on, else the document's
 *  root, as the AOSP methods do, throwing what they throw for a document with no element */
function xmlDrawable(res: unknown, parser: unknown, theme: unknown, inner: boolean) {
  const set = attrSet(parser), root = parserRoot(parser);
  const node = inner ? set?.node : root;
  if (!node) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "No start tag found");
  if (root) noteCustomTags(root, () => reopenParser(parser));
  return inflateDrawableNode(nativeRes(res), node, nativeTheme(theme));
}
/** A drawable document's elements that name an app class, each with how to open the document
 *  as AOSP's XmlBlock parser and its start tag's place in it: DrawableInflater hands the class
 *  the parser standing on its element. */
const customTags = new WeakMap<XmlNode, { open: () => unknown; index: number }>();
function noteCustomTags(root: XmlNode, open: () => unknown) {
  let index = 0;
  const walk = (node: XmlNode) => {
    if (node.name.includes(".")) customTags.set(node, { open, index });
    index++;
    for (const child of node.children) walk(child);
  };
  walk(root);
}
// BlendMode.fromValue and blendModeToPorterDuffMode where the names differ; a blend mode with no
// Porter-Duff form becomes the default SRC_IN
const BLEND_OF_TINT: Record<string, string> = { ADD: "PLUS", MULTIPLY: "MODULATE" };
/** a PorterDuff.Mode name as BlendMode names it */
const blendOfTint = (mode: string | null) => mode ? BLEND_OF_TINT[mode] ?? mode : "SRC_IN";
const TINT_OF_BLEND: Record<string, string> = { PLUS: "ADD", MODULATE: "MULTIPLY", MULTIPLY: "SRC_IN" };
const TINT_MODE_NAMES = new Set(["CLEAR", "SRC", "DST", "SRC_OVER", "DST_OVER", "SRC_IN", "DST_IN", "SRC_OUT", "DST_OUT",
  "SRC_ATOP", "DST_ATOP", "XOR", "DARKEN", "LIGHTEN", "SCREEN", "OVERLAY"]);
function forwardOnce(d: JDrawable, flag: "settingTintMode" | "settingBlendMode", call: () => unknown): unknown {
  if (d[flag]) return;
  d[flag] = true;
  let res: unknown;
  try { res = call(); } catch (e) { d[flag] = false; throw e; }
  if (res instanceof Promise) return res.finally(() => { d[flag] = false; });
  d[flag] = false;
}
function onBoundsChangeAll(d: JDrawable) {
  if (d instanceof JLayerDrawable) return d.layout();
  if (d instanceof JStateListDrawable) { const c = d.current(); if (c) copyBounds(d, c); }
}
function copyBounds(from: JDrawable, to: JDrawable) {
  to.bounds.left = from.bounds.left; to.bounds.top = from.bounds.top;
  to.bounds.right = from.bounds.right; to.bounds.bottom = from.bounds.bottom;
  onBoundsChangeAll(to);
}
/** the child a container draws, with the container's bounds and paint state pushed onto it */
function adoptChild(parent: JDrawable, child: JDrawable | null): JDrawable | null {
  if (!child) return null;
  copyBounds(parent, child);
  child.alpha = parent.alpha;
  child.tint = child.tint ?? parent.tint;
  return child;
}
rt.register({ name: "android/graphics/drawable/Drawable", ctor: JDrawable, methods: drawableMethods });
rt.markers("android/graphics/drawable/Drawable$Callback");
defineException("android/view/InflateException", "java/lang/RuntimeException");
class JConstantState extends JObj {}
class JDrawableState extends JConstantState {
  create!: () => JDrawable | Promise<JDrawable>;
}
rt.register({ name: "android/graphics/drawable/Drawable$ConstantState", ctor: JConstantState, methods: {
  "newDrawable(Landroid/content/res/Resources;)Landroid/graphics/drawable/Drawable;": function () { return vcall(this, "newDrawable", "()Landroid/graphics/drawable/Drawable;"); },
  "newDrawable(Landroid/content/res/Resources;Landroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;": function (res: unknown) { return vcall(this, "newDrawable", "(Landroid/content/res/Resources;)Landroid/graphics/drawable/Drawable;", res); },
  "getChangingConfigurations()I": () => 0,
  "canApplyTheme()Z": () => 0,
} });
for (const name of ["VectorDrawable$VectorDrawableState", "ColorDrawable$ColorState", "RippleDrawable$RippleState", "InsetDrawable$InsetState"]) {
  rt.register({ name: `android/graphics/drawable/${name}`, ctor: JDrawableState, sup: "android/graphics/drawable/Drawable$ConstantState", methods: {
    "newDrawable()Landroid/graphics/drawable/Drawable;": function (this: JDrawableState) { return this.create(); },
  } });
}
// callers `instanceof` a drawable against Animatable to see whether it animates itself
rt.markers("android/graphics/drawable/Animatable");

export class JColorDrawable extends JDrawable {
  color = 0;
  paint(cv: JCanvas) {
    if (!(this.color >>> 24) || this.alpha === 0) return;
    const ctx = cv.ctx;
    ctx.save();
    const color = this.tintMatrix ? matrixColor(this.tintMatrix, this.color) : this.tint ?? this.color;
    const alpha = ((color >>> 24) * (this.alpha + (this.alpha >>> 7))) >>> 8;
    ctx.fillStyle = cssColor((alpha << 24) | (color & 0xffffff));
    ctx.fillRect(this.bounds.left, this.bounds.top, this.bounds.right - this.bounds.left, this.bounds.bottom - this.bounds.top);
    ctx.restore();
  }
}
rt.register({
  name: "android/graphics/drawable/ColorDrawable", ctor: JColorDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JColorDrawable, c: number) { this.color = c; },
    "getColor()I": function (this: JColorDrawable) { return this.color; },
    "setColor(I)V": function (this: JColorDrawable, c: number) { this.color = c; },
    "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;": function (this: JColorDrawable) {
      const { color, tint, alpha, autoMirrored } = this;
      const state = rt.make("android/graphics/drawable/ColorDrawable$ColorState") as JDrawableState;
      state.create = () => Object.assign(new JColorDrawable(), { color, tint, alpha, autoMirrored });
      return state;
    },
  },
});

export class JBitmapDrawable extends JDrawable {
  bmp: JBitmap | null = null;
  /** the density the bitmap is scaled to for its intrinsic size (Bitmap.getScaledWidth) */
  targetDensity = device.densityDpi;
  /** the Paint getPaint() hands out: flags an app sets on it (filter, dither) have no effect on the 2D path */
  bpaint: JPaint | null = null;
  paint(cv: JCanvas) {
    if (!this.bmp) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    const src = tintedBmp(this.bmp, this.tintMode ? this.tint : null, this.tintMatrix, blendOfTint(this.tintMode));
    ctx.drawImage(src, this.bounds.left, this.bounds.top,
      Math.max(1, this.bounds.right - this.bounds.left), Math.max(1, this.bounds.bottom - this.bounds.top));
    ctx.restore();
  }
  size(vertical: boolean): number { return this.bmp ? Math.round((vertical ? this.bmp.h : this.bmp.w) * this.targetDensity / this.bmp.density) : -1; }
}
function setTargetDensity(this: JBitmapDrawable, density: number) {
  const next = density || 160;   // DisplayMetrics.DENSITY_DEFAULT stands in for "no density"
  if (next !== this.targetDensity) { this.targetDensity = next; void vcall(this, "invalidateSelf", "()V"); }
}
rt.register({
  name: "android/graphics/drawable/BitmapDrawable", ctor: JBitmapDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>(Landroid/content/res/Resources;Landroid/graphics/Bitmap;)V": function (this: JBitmapDrawable, r: unknown, b: JBitmap) { this.bmp = b; },
    "<init>(Landroid/graphics/Bitmap;)V": function (this: JBitmapDrawable, b: JBitmap) { this.bmp = b; },
    "getBitmap()Landroid/graphics/Bitmap;": function (this: JBitmapDrawable) { return this.bmp; },
    "getPaint()Landroid/graphics/Paint;": function (this: JBitmapDrawable) { return this.bpaint ??= new JPaint(); },
    "setTargetDensity(I)V": setTargetDensity,
    "setTargetDensity(Landroid/util/DisplayMetrics;)V": function (this: JBitmapDrawable, m: { densityDpi: number }) { setTargetDensity.call(this, m.densityDpi); },
    "setTargetDensity(Landroid/graphics/Canvas;)V": function (this: JBitmapDrawable) { setTargetDensity.call(this, device.densityDpi); },
    ...noops("<init>()V", "setAntiAlias(Z)V", "setMipMap(Z)V", "setTileModeX(Landroid/graphics/Shader$TileMode;)V", "setTileModeY(Landroid/graphics/Shader$TileMode;)V",
      "setTileModeXY(Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V", "setGravity(I)V"),
  },
});

/** Bitmap.scaleFromDensity */
const scaleFromDensity = (size: number, from: number, to: number) => from === to || !from || !to ? size : Math.floor((size * to + (from >> 1)) / from);
class JNinePatchDrawable extends JDrawable {
  bmp: JBitmap | null = null; chunk: NinePatchChunk | null = null;
  padding?: JRect;
  targetDensity = 160;
  set(padding: JRect | null, targetDensity: number) {
    const from = this.bmp!.density;
    this.targetDensity = targetDensity;
    if (!padding) return;
    const p = this.padding = new JRect();
    p.left = scaleFromDensity(padding.left, from, targetDensity); p.top = scaleFromDensity(padding.top, from, targetDensity);
    p.right = scaleFromDensity(padding.right, from, targetDensity); p.bottom = scaleFromDensity(padding.bottom, from, targetDensity);
  }
  paint(cv: JCanvas) {
    const { bmp, chunk } = this, { left, top } = this.bounds;
    if (!bmp || !chunk) return;
    // AOSP draws a patch of another density in its own pixels under a canvas scale
    const s = bmp.density && bmp.density !== this.targetDensity ? this.targetDensity / bmp.density : 1;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    ctx.translate(left, top);
    if (s !== 1) ctx.scale(s, s);
    drawNinePatch(ctx, tintedBmp(bmp, this.tintMode ? this.tint : null, this.tintMatrix, blendOfTint(this.tintMode)), bmp.w, bmp.h, chunk,
      0, 0, Math.round((this.bounds.right - left) / s), Math.round((this.bounds.bottom - top) / s));
    ctx.restore();
  }
  size(vertical: boolean): number {
    const bmp = this.bmp;
    return bmp ? scaleFromDensity(vertical ? bmp.h : bmp.w, bmp.density, this.targetDensity) : -1;
  }
}
/** Drawable.resolveDensity: the Resources' density, else NinePatchState's DENSITY_DEFAULT */
const resDensity = (res: unknown): number => res ? device.densityDpi : 160;
rt.register({
  name: "android/graphics/drawable/NinePatchDrawable", ctor: JNinePatchDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>(Landroid/content/res/Resources;Landroid/graphics/NinePatch;)V": function (this: JNinePatchDrawable, res: unknown, patch: object) {
      ninePatchOf(patch, this).set(null, resDensity(res));
    },
    "<init>(Landroid/content/res/Resources;Landroid/graphics/Bitmap;[BLandroid/graphics/Rect;Ljava/lang/String;)V":
      function (this: JNinePatchDrawable, res: unknown, bmp: JBitmap, chunk: Int8Array | null, padding: JRect | null) {
        this.bmp = bmp; this.chunk = validNinePatchChunk(chunk);
        this.set(padding, resDensity(res));
      },
    "<init>(Landroid/graphics/Bitmap;[BLandroid/graphics/Rect;Ljava/lang/String;)V":
      function (this: JNinePatchDrawable, bmp: JBitmap, chunk: Int8Array | null, padding: JRect | null) {
        this.bmp = bmp; this.chunk = validNinePatchChunk(chunk);
        this.set(padding, 160);
      },
  },
});
/** AOSP Drawable.drawableFromBitmap: a decoded 9-patch chunk, not the file name, makes a
 *  NinePatchDrawable, padded as the chunk says */
export function drawableFromBitmap(bmp: JBitmap, targetDensity: number): JDrawable {
  if (isNinePatchChunk(bmp.ninePatchChunk)) {
    const d = new JNinePatchDrawable(), pad = new JRect();
    d.bmp = bmp; d.chunk = validNinePatchChunk(bmp.ninePatchChunk);
    [pad.left, pad.top, pad.right, pad.bottom] = d.chunk.padding;
    d.set(pad, targetDensity);
    return d;
  }
  const d = new JBitmapDrawable();
  d.bmp = bmp;
  return d;
}
const createFromResourceStream = driven(function* createFromResourceStream(res: unknown, value: JTypedValue | null, is: unknown, opts: JBFOptions | null): Gen {
  if (!is) return null;
  opts ??= new JBFOptions();
  opts.inScreenDensity = resDensity(res);
  const bmp: JBitmap | null = yield decodeResourceStream(res, value, is, null, opts);
  return bmp && drawableFromBitmap(bmp, resDensity(res));
});
// ── GradientDrawable (shape)
class JGradientDrawable extends JDrawable {
  shape = 0; // 0 rect, 1 oval, 2 line, 3 ring
  solid: number | null = null;
  radii: number[] = [0, 0, 0, 0]; // tl tr br bl
  private clampedRadii = [0, 0, 0, 0];
  strokeW = 0; strokeColor = 0; dashW = 0; dashGap = 0;
  gradColors: number[] | null = null;
  /** setColors' offsets; null spaces the colors evenly */
  gradOffsets: number[] | null = null;
  /** degrees, a multiple of 45: a GradientDrawable made in code starts TOP_BOTTOM */
  gradAngle = 270;
  gradType = 0; // linear/radial/sweep
  gradRadius = 0;
  sizeW = -1; sizeH = -1;
  padding = new JRect();
  solidCsl: JColorStateList | null = null;
  strokeCsl: JColorStateList | null = null;
  onStateChange(): boolean {
    const solid = this.solidCsl ? cslColor(this.solidCsl, this.stateSet) : this.solid;
    const stroke = this.strokeCsl ? cslColor(this.strokeCsl, this.stateSet) : this.strokeColor;
    if (solid === this.solid && stroke === this.strokeColor) return false;
    this.solid = solid; this.strokeColor = stroke;
    return true;
  }
  setStroke(width: number, color: number | JColorStateList | null, dashWidth = 0, dashGap = 0) {
    this.strokeCsl = typeof color === "number" ? null : color;
    this.strokeW = width;
    this.strokeColor = typeof color === "number" ? color : color ? cslColor(color, this.stateSet) : 0;
    this.dashW = dashWidth; this.dashGap = dashGap;
  }
  paint(cv: JCanvas) {
    const { left, top, right, bottom } = this.bounds;
    const w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255;
    const path = this.shapePath(left, top, right, bottom);
    if (this.shape !== 2) {
      let fill: string | CanvasGradient | null = null;
      if (this.tint !== null) fill = cssColor(this.solid === null ? this.tint : tinted(this.solid, this.tint));
      else if (this.gradColors && this.gradColors.length > 1) {
        const [x0, y0, x1, y1] = GRADIENT_ENDS[this.gradAngle / 45];
        const g = this.gradType === 1
          ? ctx.createRadialGradient(left + w / 2, top + h / 2, 0, left + w / 2, top + h / 2, this.gradRadius || Math.max(w, h) / 2)
          : ctx.createLinearGradient(left + x0 * w, top + y0 * h, left + x1 * w, top + y1 * h);
        const last = this.gradColors.length - 1;
        this.gradColors.forEach((c, i) => g.addColorStop(this.gradOffsets?.[i] ?? i / last, cssColor(c)));
        fill = g;
      } else if (this.solid !== null) fill = cssColor(this.solid);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(path);
      }
    }
    if (this.strokeW > 0) {
      ctx.strokeStyle = cssColor(this.strokeColor);
      ctx.lineWidth = this.strokeW;
      if (this.dashW) ctx.setLineDash([this.dashW, this.dashGap]);
      ctx.stroke(path);
    }
    ctx.restore();
  }
  private shapePath(left: number, top: number, right: number, bottom: number): Path2D {
    const w = right - left, h = bottom - top, path = new Path2D();
    if (this.shape === 1) path.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (this.shape === 2) { path.moveTo(left, top + h / 2); path.lineTo(right, top + h / 2); }
    else {
      const lim = Math.min(w / 2, h / 2), rr = this.clampedRadii;
      for (let i = 0; i < 4; i++) rr[i] = Math.min(this.radii[i], lim);
      path.roundRect(left, top, w, h, rr);
    }
    return path;
  }
  size(vertical: boolean): number { return vertical ? this.sizeH : this.sizeW; }
}
rt.register({
  name: "android/graphics/drawable/GradientDrawable", ctor: JGradientDrawable, sup: "android/graphics/drawable/Drawable",
  methods: cslBoundary({
    "<init>()V": function () {},
    "setColor(I)V": function (this: JGradientDrawable, c: number) { this.solid = c; },
    "setColors([I)V": function (this: JGradientDrawable, cs: Int32Array | null) { this.gradColors = cs && [...cs]; this.gradOffsets = null; },
    "setColors([I[F)V": function (this: JGradientDrawable, cs: Int32Array | null, offsets: Float32Array | null) {
      this.gradColors = cs && [...cs]; this.gradOffsets = offsets && [...offsets];
    },
    "setCornerRadius(F)V": function (this: JGradientDrawable, r: number) { this.radii = [r, r, r, r]; },
    "setCornerRadii([F)V": function (this: JGradientDrawable, r: Float32Array) {
      this.radii = [r[0] ?? 0, r[2] ?? 0, r[4] ?? 0, r[6] ?? 0];
    },
    "setStroke(II)V": function (this: JGradientDrawable, w: number, c: number) { this.setStroke(w, c); },
    "setStroke(IIFF)V": function (this: JGradientDrawable, w: number, c: number, dw: number, dg: number) { this.setStroke(w, c, dw, dg); },
    "setStroke(ILandroid/content/res/ColorStateList;)V": function (this: JGradientDrawable, w: number, c: JColorStateList | null) { this.setStroke(w, c); },
    "setStroke(ILandroid/content/res/ColorStateList;FF)V": function (this: JGradientDrawable, w: number, c: JColorStateList | null, dw: number, dg: number) {
      this.setStroke(w, c, dw, dg);
    },
    "setShape(I)V": function (this: JGradientDrawable, s: number) { this.shape = s; },
    "setSize(II)V": function (this: JGradientDrawable, w: number, h: number) { this.sizeW = w; this.sizeH = h; },
    "setGradientType(I)V": function (this: JGradientDrawable, t: number) { this.gradType = t; },
    "setGradientRadius(F)V": function (this: JGradientDrawable, r: number) { this.gradRadius = r; },
    "<init>(Landroid/graphics/drawable/GradientDrawable$Orientation;[I)V": function (this: JGradientDrawable, o: { ord?: number } | null, cs: Int32Array | null) {
      this.gradColors = cs ? [...cs] : null;
      this.gradAngle = ORIENT_ANGLE[o?.ord ?? 0] ?? 0;
    },
    "setOrientation(Landroid/graphics/drawable/GradientDrawable$Orientation;)V": function (this: JGradientDrawable, o: { ord?: number } | null) { this.gradAngle = ORIENT_ANGLE[o?.ord ?? 0] ?? 0; },
    "getCornerRadius()F": function (this: JGradientDrawable) { return this.radii[0]; },
    "getCornerRadii()[F": function (this: JGradientDrawable) {
      const r = this.radii;
      return Float32Array.from([r[0], r[0], r[1], r[1], r[2], r[2], r[3], r[3]]);
    },
    "setColor(Landroid/content/res/ColorStateList;)V": function (this: JGradientDrawable, csl: JColorStateList | null) {
      this.solidCsl = csl;
      this.solid = csl ? cslColor(csl, this.stateSet) : null;
    },
    "getColor()Landroid/content/res/ColorStateList;": function (this: JGradientDrawable) { return this.solidCsl ?? (this.solid !== null ? mkCsl(this.solid) : null); },
  }),
});
// GradientDrawable.Orientation ordinals (TOP_BOTTOM first) as the angle each one means
const ORIENT_ANGLE = [270, 225, 180, 135, 90, 45, 0, 315];
/** each orientation's start and end corner, by angle / 45, as fractions of the bounds */
const GRADIENT_ENDS = [[0, 0, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [1, 1, 0, 0], [1, 0, 0, 0], [1, 0, 0, 1], [0, 0, 0, 1], [0, 0, 1, 1]];
/** android:angle is a float; AOSP keeps TOP_BOTTOM for one that is not a multiple of 45 */
function gradientAngle(deg: number): number {
  const a = ((Math.trunc(deg) % 360) + 360) % 360;
  return a % 45 ? 270 : a;
}
mkEnumSet("android/graphics/drawable/GradientDrawable$Orientation", ["TOP_BOTTOM", "TR_BL", "RIGHT_LEFT", "BR_TL", "BOTTOM_TOP", "BL_TR", "LEFT_RIGHT", "TL_BR"]);

/** a state spec (negative entries are negated states) as its required and negated states */
function splitStates(spec: Iterable<number>): { states: number[]; negStates: number[] } {
  const states: number[] = [], negStates: number[] = [];
  for (const s of spec) (s >= 0 ? states : negStates).push(Math.abs(s));
  return { states, negStates };
}
function hasState(states: ArrayLike<number>, s: number): boolean {
  for (let i = 0; i < states.length; i++) if (states[i] === s) return true;
  return false;
}
/** a selector/color-state item matches when every required state is set and no negated one is.
 *  Plain loops: state lists and text colours resolve on every draw. */
function matchesState(it: { states: number[]; negStates: number[] }, states: ArrayLike<number>): boolean {
  for (let i = 0; i < it.states.length; i++) if (!hasState(states, it.states[i])) return false;
  for (let i = 0; i < it.negStates.length; i++) if (hasState(states, it.negStates[i])) return false;
  return true;
}

class JDrawableContainer extends JDrawable {
  enterFadeDuration = 0;
  exitFadeDuration = 0;
}
function containerSize(children: { d: JDrawable }[], vertical: boolean): number | Promise<number> {
  const thread = curThread;
  let size = -1;
  const step = (i: number): number | Promise<number> => {
    for (; i < children.length; i++) {
      const value = drawableSize(children[i].d, vertical, thread);
      if (value instanceof Promise) return value.then(n => { size = Math.max(size, n); return step(i + 1); });
      size = Math.max(size, value);
    }
    return size;
  };
  return step(0);
}

class JStateListDrawable extends JDrawableContainer {
  items: { states: number[]; negStates: number[]; d: JDrawable }[] = [];
  current(): JDrawable | null {
    const items = this.items;
    for (let i = 0; i < items.length; i++) if (matchesState(items[i], this.stateSet)) return items[i].d ?? null;
    return items[items.length - 1]?.d ?? null;
  }
  paint(cv: JCanvas) { const child = adoptChild(this, this.current()); return child ? drawChild(child, cv) : undefined; }
  size(vertical: boolean) { return containerSize(this.items, vertical); }
}
/** AOSP LevelListDrawable: the first item whose range holds the level, else none */
class JLevelListDrawable extends JDrawableContainer {
  items: { min: number; max: number; d: JDrawable }[] = [];
  shown: JDrawable | null = null;
  current(): JDrawable | null {
    for (const it of this.items) if (this.level >= it.min && this.level <= it.max) return it.d;
    return null;
  }
  paint(cv: JCanvas) { const child = adoptChild(this, this.current()); return child ? drawChild(child, cv) : undefined; }
  size(vertical: boolean) { return containerSize(this.items, vertical); }
}
class JAnimationDrawable extends JDrawableContainer {
  frames: { d: JDrawable; ms: number }[] = [];
  cur = 0; oneShot = false; running = false; run = 0;
  paint(cv: JCanvas) { const child = adoptChild(this, this.frames[this.cur]?.d ?? null); return child ? drawChild(child, cv) : undefined; }
  size(vertical: boolean) { return containerSize(this.frames, vertical); }
  /** AOSP schedules each frame on the looper for its duration; the run token cancels a stale timer */
  start() {
    if (this.running || !this.frames.length) return;
    this.running = true;
    this.cur = 0;
    const run = ++this.run;
    const step = () => setGuestTimeout(() => {
      if (!this.running || run !== this.run) return;
      if (this.cur + 1 >= this.frames.length) {
        if (this.oneShot) { this.running = false; return; }
        this.cur = 0;
      } else this.cur++;
      invalidateSelf.call(this);
      step();
    }, this.frames[this.cur].ms);
    step();
    invalidateSelf.call(this);
  }
}
class JAnimationScaleListDrawable extends JDrawableContainer {
  children: { d: JDrawable }[] = [];
  animated = -1;
  current(): JDrawable | null { return this.children[this.animated]?.d ?? null; }
  paint(cv: JCanvas) { const child = adoptChild(this, this.current()); return child ? drawChild(child, cv) : undefined; }
  size(vertical: boolean) { return containerSize(this.children, vertical); }
}
rt.register({ name: "com/android/internal/graphics/drawable/AnimationScaleListDrawable", ctor: JAnimationScaleListDrawable,
  sup: "android/graphics/drawable/DrawableContainer", ifaces: ["android/graphics/drawable/Animatable"], methods: {
    "<init>()V": function () {},
    "getCurrent()Landroid/graphics/drawable/Drawable;": function (this: JAnimationScaleListDrawable) { return this.current(); },
    "start()V": function (this: JAnimationScaleListDrawable) { const d = this.current(); if (d) return vcall(d, "start", "()V"); },
    "stop()V": function (this: JAnimationScaleListDrawable) { const d = this.current(); if (d) return vcall(d, "stop", "()V"); },
    "isRunning()Z": function (this: JAnimationScaleListDrawable) { const d = this.current(); return d ? vcall(d, "isRunning", "()Z") : 0; },
    "onStateChange([I)Z": driven(function* (this: JAnimationScaleListDrawable, state: Int32Array): Gen {
      for (const { d } of this.children) yield vcall(d, "setState", "([I)Z", state);
      return 1;
    }),
  } });
rt.register({
  name: "android/graphics/drawable/DrawableContainer", ctor: JDrawableContainer, sup: "android/graphics/drawable/Drawable",
  methods: {
    "setEnterFadeDuration(I)V": function (this: JDrawableContainer, duration: number) { this.enterFadeDuration = Math.max(0, duration); },
    "setExitFadeDuration(I)V": function (this: JDrawableContainer, duration: number) { this.exitFadeDuration = Math.max(0, duration); },
  },
});
rt.register({
  name: "android/graphics/drawable/LevelListDrawable", ctor: JLevelListDrawable, sup: "android/graphics/drawable/DrawableContainer",
  methods: {
    "<init>()V": function () {},
    "addLevel(IILandroid/graphics/drawable/Drawable;)V": function (this: JLevelListDrawable, min: number, max: number, d: JDrawable | null) {
      if (d) { d.callback = this; this.items.push({ min, max, d }); }
    },
    "getCurrent()Landroid/graphics/drawable/Drawable;": function (this: JLevelListDrawable) { return this.current(); },
    // selectDrawable, then DrawableContainer's: the shown child takes the level too
    "onLevelChange(I)Z": driven(function* (this: JLevelListDrawable, level: number): Gen {
      const d = this.current(), changed = d !== this.shown;
      this.shown = d;
      if (changed) invalidateSelf.call(this);
      return (d ? yield vcall(d, "setLevel", "(I)Z", level) : 0) || changed ? 1 : 0;
    }),
    "onStateChange([I)Z": driven(function* (this: JLevelListDrawable, state: Int32Array): Gen {
      for (const { d } of this.items) yield vcall(d, "setState", "([I)Z", state);
      return 1;
    }),
  },
});
rt.register({
  name: "android/graphics/drawable/AnimationDrawable", ctor: JAnimationDrawable, sup: "android/graphics/drawable/DrawableContainer",
  ifaces: ["android/graphics/drawable/Animatable", "java/lang/Runnable"],
  methods: {
    "<init>()V": function () {},
    "addFrame(Landroid/graphics/drawable/Drawable;I)V": function (this: JAnimationDrawable, d: JDrawable, ms: number) { this.frames.push({ d, ms }); },
    "getNumberOfFrames()I": function (this: JAnimationDrawable) { return this.frames.length; },
    "getFrame(I)Landroid/graphics/drawable/Drawable;": function (this: JAnimationDrawable, i: number) { return this.frames[i]?.d ?? null; },
    "getDuration(I)I": function (this: JAnimationDrawable, i: number) { return this.frames[i]?.ms ?? 0; },
    "getCurrent()Landroid/graphics/drawable/Drawable;": function (this: JAnimationDrawable) { return this.frames[this.cur]?.d ?? null; },
    "setOneShot(Z)V": function (this: JAnimationDrawable, b: number) { this.oneShot = !!b; },
    "isOneShot()Z": function (this: JAnimationDrawable) { return this.oneShot ? 1 : 0; },
    "isRunning()Z": function (this: JAnimationDrawable) { return this.running ? 1 : 0; },
    "start()V": function (this: JAnimationDrawable) { this.start(); },
    "stop()V": function (this: JAnimationDrawable) { this.running = false; },
    "run()V": function (this: JAnimationDrawable) { this.start(); },
  },
});
rt.register({
  name: "android/graphics/drawable/StateListDrawable", ctor: JStateListDrawable, sup: "android/graphics/drawable/DrawableContainer",
  methods: {
    "onStateChange([I)Z": driven(function* (this: JStateListDrawable, state: Int32Array): Gen {
      const thread = curThread;
      for (const item of this.items) yield vcallOn(thread, item.d, "setState", "([I)Z", state);
      return 1;
    }),
    "<init>()V": function () {},
    "addState([ILandroid/graphics/drawable/Drawable;)V": function (this: JStateListDrawable, st: Int32Array, d: JDrawable) {
      this.items.push({ ...splitStates(st), d });
      if (d) return vcall(this, "onStateChange", "([I)Z", Int32Array.from(this.stateSet));
    },
  },
});

interface Layer { d: JDrawable | null; insets: [number, number, number, number]; w?: number; h?: number; gravity?: number }
export class JLayerDrawable extends JDrawable {
  layers: Layer[] = [];
  ids: (number | null)[] = [];
  private layerContainer = new JRect();
  private layerBounds = new JRect();
  /** AOSP LayerDrawable.addLayer: a layer's invalidations and scheduling reach this drawable,
   *  and through its own callback the view it is drawn into */
  pushLayer(d: JDrawable | null, place: Omit<Layer, "d"> = { insets: [0, 0, 0, 0] }) { if (d) d.callback = this; this.layers.push({ d, ...place }); }
  /** AOSP updateLayerBounds: insets, then an explicit layer size placed by its gravity */
  layout(): unknown {
    const thread = curThread;
    const step = (i: number): unknown => {
      for (; i < this.layers.length; i++) {
        const l = this.layers[i];
        if (!l.d) continue;
        const d = l.d;
        const place = (w: number, h: number) => {
          const L = this.bounds.left + l.insets[0], T = this.bounds.top + l.insets[1];
          const R = this.bounds.right - l.insets[2], B = this.bounds.bottom - l.insets[3];
          const gravity = l.gravity || (w >= 0 && h >= 0 ? 0x33 : w >= 0 ? 0x73 : h >= 0 ? 0x37 : 0x77);
          const container = this.layerContainer, bounds = this.layerBounds;
          container.left = L; container.top = T; container.right = R; container.bottom = B;
          gravityApply(gravity, w < 0 ? R - L : w, h < 0 ? B - T : h, container, 0, 0, bounds);
          return vcallOn(thread, d, "setBounds", "(IIII)V", bounds.left, bounds.top, bounds.right, bounds.bottom);
        };
        const w = l.w !== undefined && l.w >= 0 ? l.w : l.gravity && (l.gravity & 7) !== 7 ? drawableSize(d, false, thread) : -1;
        const height = () => l.h !== undefined && l.h >= 0 ? l.h : l.gravity && (l.gravity & 112) !== 112 ? drawableSize(d, true, thread) : -1;
        const result = after(w, width => after(height(), h => place(width, h)));
        if (result instanceof Promise) return result.then(() => step(i + 1));
      }
    };
    return step(0);
  }
  /** Every layer through its virtual draw. Stays synchronous — no promise allocated — unless a
   *  compiled child actually suspends, in which case the rest follow it in order. */
  paint(cv: JCanvas): unknown {
    const thread = curThread;
    const step = (i: number): unknown => {
      for (; i < this.layers.length; i++) {
        const d = this.layers[i].d;
        if (!d) continue;
        const r = vcallOn(thread, d, "draw", "(Landroid/graphics/Canvas;)V", cv);
        if (r instanceof Promise) return r.then(() => step(i + 1));
      }
    };
    return after(this.layout(), () => step(0));
  }
  size(vertical: boolean): number | Promise<number> {
    const thread = curThread, edge = vertical ? 1 : 0;
    let size = -1;
    const step = (i: number): number | Promise<number> => {
      for (; i < this.layers.length; i++) {
        const l = this.layers[i], explicit = vertical ? l.h : l.w;
        if (!l.d) continue;
        const n = explicit !== undefined && explicit >= 0 ? explicit : drawableSize(l.d, vertical, thread);
        const inset = l.insets[edge] + l.insets[edge + 2];
        if (n instanceof Promise) return n.then(value => {
          if (value >= 0) size = Math.max(size, value + inset);
          return step(i + 1);
        });
        if (n >= 0) size = Math.max(size, n + inset);
      }
      return size;
    };
    return step(0);
  }
}
rt.register({
  name: "android/graphics/drawable/LayerDrawable", ctor: JLayerDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "getOutline(Landroid/graphics/Outline;)V": driven(function* (this: JLayerDrawable, outline: object): Gen {
      const thread = curThread;
      for (const { d } of this.layers) {
        if (!d) continue;
        yield vcallOn(thread, d, "getOutline", "(Landroid/graphics/Outline;)V", outline);
        if (!(yield vcall(outline, "isEmpty", "()Z"))) return;
      }
    }),
    // AOSP: each layer's inset plus that layer's own padding, the widest of each edge. This is
    // what an InsetDrawable used as a window background reports, and what tells the window how
    // far inside itself the content has to sit.
    "getPadding(Landroid/graphics/Rect;)Z": driven(function* (this: JLayerDrawable, r: JRect): Gen {
      r.left = r.top = r.right = r.bottom = 0;
      const p = new JRect();
      for (const l of this.layers) {
        if (!l.d) continue;
        p.left = p.top = p.right = p.bottom = 0;
        yield vcall(l.d, "getPadding", "(Landroid/graphics/Rect;)Z", p);
        r.left = Math.max(r.left, l.insets[0] + p.left);
        r.top = Math.max(r.top, l.insets[1] + p.top);
        r.right = Math.max(r.right, l.insets[2] + p.right);
        r.bottom = Math.max(r.bottom, l.insets[3] + p.bottom);
      }
      return r.left || r.top || r.right || r.bottom ? 1 : 0;
    }),
    "<init>([Landroid/graphics/drawable/Drawable;)V": function (this: JLayerDrawable, ds: (JDrawable | null)[] | null) {
      if (!ds) throw rt.mkThrowable("java/lang/IllegalArgumentException", "layers must be non-null");
      for (const d of ds) this.pushLayer(d);
    },
    // AOSP hands the state to every layer: a Material button's fill is a MaterialShapeDrawable
    // inside an InsetDrawable inside the ripple, and it is the one that reads state_checked
    "onStateChange([I)Z": driven(function* (this: JLayerDrawable, st: Int32Array): Gen {
      let changed = this.onStateChange();
      for (const l of this.layers) if (l.d && (yield vcall(l.d, "setState", "([I)Z", st))) changed = true;
      return changed ? 1 : 0;
    }),
    "isStateful()Z": () => 1,
    "getNumberOfLayers()I": function (this: JLayerDrawable) { return this.layers.length; },
    "getDrawable(I)Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable, i: number) { return this.layers[i]?.d ?? null; },
    "findDrawableByLayerId(I)Landroid/graphics/drawable/Drawable;": function (this: JLayerDrawable, id: number) {
      const i = this.ids.indexOf(id);
      return i >= 0 ? this.layers[i]?.d ?? null : null;
    },
    "setLayerInset(IIIII)V": function (this: JLayerDrawable, i: number, l: number, t: number, r: number, b: number) {
      if (this.layers[i]) this.layers[i].insets = [l, t, r, b];
    },
    ...Object.fromEntries(([["Left", 0], ["Top", 1], ["Right", 2], ["Bottom", 3], ["Start", 0], ["End", 2]] as const).flatMap(([n, k]) => [
      [`setLayerInset${n}(II)V`, function (this: JLayerDrawable, i: number, v: number) { if (this.layers[i]) this.layers[i].insets[k] = v; }],
      [`getLayerInset${n}(I)I`, function (this: JLayerDrawable, i: number) { return this.layers[i]?.insets[k] ?? 0; }],
    ])),
    "setLayerSize(III)V": function (this: JLayerDrawable, i: number, w: number, h: number) { if (this.layers[i]) { this.layers[i].w = w; this.layers[i].h = h; } },
    "setLayerWidth(II)V": function (this: JLayerDrawable, i: number, w: number) { if (this.layers[i]) this.layers[i].w = w; },
    "setLayerHeight(II)V": function (this: JLayerDrawable, i: number, h: number) { if (this.layers[i]) this.layers[i].h = h; },
    "getLayerWidth(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.w ?? -1; },
    "getLayerHeight(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.h ?? -1; },
    "setLayerGravity(II)V": function (this: JLayerDrawable, i: number, g: number) { if (this.layers[i]) this.layers[i].gravity = g; },
    "getLayerGravity(I)I": function (this: JLayerDrawable, i: number) { return this.layers[i]?.gravity ?? 0; },
    "setId(II)V": function (this: JLayerDrawable, i: number, id: number) { this.ids[i] = id; },
    "getId(I)I": function (this: JLayerDrawable, i: number) { return this.ids[i] ?? -1; },
    "addLayer(Landroid/graphics/drawable/Drawable;)I": function (this: JLayerDrawable, d: JDrawable | null) {
      this.pushLayer(d);
      return this.layers.length - 1;
    },
    "setDrawableByLayerId(ILandroid/graphics/drawable/Drawable;)Z": function (this: JLayerDrawable, id: number, d: JDrawable | null) {
      const i = this.ids.indexOf(id);
      if (i < 0 || !this.layers[i]) return 0;
      this.layers[i].d = d; if (d) d.callback = this;
      return 1;
    },
    "setDrawable(ILandroid/graphics/drawable/Drawable;)V": function (this: JLayerDrawable, i: number, d: JDrawable | null) { if (this.layers[i]) { this.layers[i].d = d; if (d) d.callback = this; } },
  },
});
/** RippleDrawable.RADIUS_AUTO: compute the radius from bounds instead of using an explicit one. */
const RADIUS_AUTO = -1;
// AOSP RippleForeground timings: the ripple grows from the hotspot to cover the bounds while
// fading in, and on release finishes growing while fading out.
const RIPPLE_ENTER_MS = 225, RIPPLE_ENTER_ALPHA_MS = 75, RIPPLE_EXIT_MS = 150;
const decel = (t: number) => 1 - (1 - t) * (1 - t);
class JTransitionDrawable extends JLayerDrawable {
  transition = 0;
  crossFade = false;
  reverse = false;
  startTime = 0;
  duration = 0;
  originalDuration = 0;
  from = 0;
  to = 0;
  mix = 0;
  paint(cv: JCanvas): unknown {
    const thread = curThread;
    let done = true;
    if (this.transition === 1) {
      this.startTime = uptimeMillis(); this.transition = 2; done = false;
    } else if (this.transition === 2) {
      const fraction = Math.min((uptimeMillis() - this.startTime) / this.duration, 1);
      done = fraction >= 1;
      this.mix = (this.from + (this.to - this.from) * fraction) | 0;
    }
    return after(this.layout(), () => {
      const first = this.layers[0].d, second = this.layers[1].d, alpha = this.mix;
      if (!first || !second) return super.paint(cv);
      if (done) {
        const result = !this.crossFade || alpha === 0 ? drawChild(first, cv, thread) : undefined;
        const next = () => alpha === 255 ? drawChild(second, cv, thread) : undefined;
        return result instanceof Promise ? result.then(next) : next();
      }
      return (async () => {
        if (this.crossFade) await vcallOn(thread, first, "setAlpha", "(I)V", 255 - alpha);
        await drawChild(first, cv, thread);
        if (this.crossFade) await vcallOn(thread, first, "setAlpha", "(I)V", 255);
        if (alpha > 0) {
          await vcallOn(thread, second, "setAlpha", "(I)V", alpha);
          await drawChild(second, cv, thread);
          await vcallOn(thread, second, "setAlpha", "(I)V", 255);
        }
        invalidateSelf.call(this);
      })();
    });
  }
}
rt.register({ name: "android/graphics/drawable/TransitionDrawable", ctor: JTransitionDrawable, sup: "android/graphics/drawable/LayerDrawable", methods: {
  "<init>([Landroid/graphics/drawable/Drawable;)V": function (this: JTransitionDrawable, ds: JDrawable[]) {
    for (const d of ds) this.pushLayer(d);
  },
  "startTransition(I)V": function (this: JTransitionDrawable, duration: number) {
    this.from = this.mix = 0; this.to = 255; this.reverse = false;
    this.duration = this.originalDuration = duration; this.transition = 1;
    invalidateSelf.call(this);
  },
  "resetTransition()V": function (this: JTransitionDrawable) { this.mix = this.transition = 0; invalidateSelf.call(this); },
  "reverseTransition(I)V": function (this: JTransitionDrawable, duration: number) {
    const elapsed = uptimeMillis() - this.startTime;
    if (elapsed > this.duration) {
      this.reverse = this.to !== 0; this.from = this.mix = this.reverse ? 255 : 0; this.to = 255 - this.from;
      this.duration = this.originalDuration = duration;
      this.transition = 1; invalidateSelf.call(this);
    } else {
      this.reverse = !this.reverse; this.from = this.mix; this.to = this.reverse ? 0 : 255;
      this.duration = Math.trunc(this.reverse ? elapsed : this.originalDuration - elapsed); this.transition = 1;
    }
  },
  "setCrossFadeEnabled(Z)V": function (this: JTransitionDrawable, enabled: number) { this.crossFade = !!enabled; },
  "isCrossFadeEnabled()Z": function (this: JTransitionDrawable) { return +this.crossFade; },
} });

/** Two 108dp layers behind a 72dp viewport, clipped to the device mask. */
class JAdaptiveIconDrawable extends JLayerDrawable {
  /** AOSP getFullBounds: each layer is the viewport grown by 25% on every side */
  layout(): unknown { return rt.drive(this.layout$()); }
  *layout$(): Gen {
    const thread = curThread;
    const { left, top, right, bottom } = this.bounds;
    const dx = (right - left) / 4, dy = (bottom - top) / 4;
    for (const l of this.layers) if (l.d) yield vcallOn(thread, l.d, "setBounds", "(IIII)V", left - dx, top - dy, right + dx, bottom + dy);
  }
  clip(cv: JCanvas) {
    const { left, top, right, bottom } = this.bounds;
    cv.ctx.beginPath();
    cv.ctx.roundRect(left, top, right - left, bottom - top, Math.min(right - left, bottom - top) * 0.28);
    cv.ctx.clip();
  }
  paint(cv: JCanvas) {
    cv.ctx.save();
    this.clip(cv);
    try {
      const result = super.paint(cv);
      if (result instanceof Promise) return result.finally(() => cv.ctx.restore());
    } catch (error) { cv.ctx.restore(); throw error; }
    cv.ctx.restore();
  }
  size(vertical: boolean): number | Promise<number> {
    return after(super.size(vertical), n => n < 0 ? n : Math.round(n * 2 / 3));
  }
}
rt.register({
  name: "android/graphics/drawable/AdaptiveIconDrawable", ctor: JAdaptiveIconDrawable,
  sup: "android/graphics/drawable/LayerDrawable",
  methods: {
    "<init>(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V":
      function (this: JAdaptiveIconDrawable, bg: JDrawable | null, fg: JDrawable | null) {
        for (const d of [bg, fg]) if (d) this.pushLayer(d);
      },
    "getBackground()Landroid/graphics/drawable/Drawable;": function (this: JAdaptiveIconDrawable) { return this.layers[0]?.d ?? null; },
    "getForeground()Landroid/graphics/drawable/Drawable;": function (this: JAdaptiveIconDrawable) { return this.layers[1]?.d ?? null; },
  },
});

/** @android:id/mask, read off the framework table once rather than written down */
let maskIdCache = -1;
function maskId(res: Resources): number {
  if (maskIdCache === -1) maskIdCache = res.idFor("id", "mask", "android");
  return maskIdCache;
}

class JRippleDrawable extends JLayerDrawable {
  rippleColor = 0x33000000;
  /** the mask layer: it bounds the ripple, and is not part of what the drawable paints */
  mask: JDrawable | null = null;
  /** explicit override from setRadius(), or RADIUS_AUTO to derive it from bounds each draw. */
  explicitRadius = RADIUS_AUTO;
  active = false; enterAt = 0; exitAt = 0;
  hx = Number.NaN; hy = Number.NaN;
  /**
   * RippleDrawable.computeRadius(): half the bounds' diagonal — the distance from the hotspot
   * bounds' center to a corner — so a fully-grown ripple just covers the drawable. (Not half of
   * the larger dimension: a wide, short button would then leave its corners uncovered.)
   */
  computedRadius(): number {
    const halfW = (this.bounds.right - this.bounds.left) / 2;
    const halfH = (this.bounds.bottom - this.bounds.top) / 2;
    return Math.sqrt(halfW * halfW + halfH * halfH);
  }
  radius(): number { return this.explicitRadius >= 0 ? this.explicitRadius : this.computedRadius(); }
  setColor(csl: JColorStateList | null) {
    // AOSP getRipplePaint caps the ripple at 50% opacity whatever the state list says
    const c = csl ? cslColor(csl, this.stateSet) : 0x33000000;
    this.rippleColor = (c >>> 24) > 0x80 ? ((c & 0xffffff) | 0x80000000) | 0 : c;
  }
  paint(cv: JCanvas) {
    return after(super.paint(cv), () => this.ripple(cv));
  }
  ripple(cv: JCanvas) {
    const now = guestNow();
    let grow: number, fade: number, animating: boolean;
    if (this.active) {
      const t = (now - this.enterAt) / RIPPLE_ENTER_MS;
      grow = decel(Math.min(1, t));
      fade = Math.min(1, (now - this.enterAt) / RIPPLE_ENTER_ALPHA_MS);
      animating = t < 1;
    } else if (this.exitAt) {
      const t = (now - this.exitAt) / RIPPLE_EXIT_MS;
      if (t >= 1) { this.exitAt = 0; return; }
      grow = 1;
      fade = 1 - t;
      animating = true;
    } else return;
    const { left, top, right, bottom } = this.bounds;
    const cx0 = (left + right) / 2, cy0 = (top + bottom) / 2;
    const cx = Number.isNaN(this.hx) ? cx0 : this.hx + (cx0 - this.hx) * grow;
    const cy = Number.isNaN(this.hy) ? cy0 : this.hy + (cy0 - this.hy) * grow;
    const ctx = cv.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    ctx.globalAlpha *= fade * (this.alpha / 255);
    ctx.fillStyle = cssColor(this.rippleColor);
    ctx.beginPath();
    ctx.arc(cx, cy, this.radius() * grow, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // AOSP drives the ripple from animators, so its invalidates arrive from the Choreographer,
    // never from inside draw(). Compose clears a layer's dirty flag after recording it, so an
    // invalidate raised mid-record is lost and the frozen display list replays until something
    // else re-records the layer. Queue it behind the frame job instead.
    if (animating) void onMain(() => invalidateSelf.call(this));
  }
  onStateChange(): boolean {
    const active = this.stateSet.includes(ST.pressed) && this.stateSet.includes(ST.enabled);
    if (active === this.active) return false;
    this.active = active;
    const now = guestNow();
    if (active) { this.enterAt = now; this.exitAt = 0; } else this.exitAt = now;
    return true;
  }
}
function cloneDrawable(d: JDrawable): JDrawable {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(d)), d) as JDrawable;
  copy.bounds = Object.assign(new JRect(), d.bounds);
  copy.stateSet = [...d.stateSet];
  copy.callback = null;
  if (d instanceof JStateListDrawable) {
    (copy as JStateListDrawable).items = d.items.map((item) => ({ ...item, states: [...item.states], negStates: [...item.negStates], d: cloneDrawable(item.d) }));
  }
  if (d instanceof JAnimationDrawable) {
    (copy as JAnimationDrawable).frames = d.frames.map((frame) => ({ ...frame, d: cloneDrawable(frame.d) }));
  }
  if (d instanceof JLayerDrawable) {
    const layered = copy as JLayerDrawable;
    layered.layers = d.layers.map((layer) => ({ ...layer, insets: [...layer.insets], d: layer.d ? cloneDrawable(layer.d) : null }));
    layered.ids = [...d.ids];
    for (const layer of layered.layers) if (layer.d) layer.d.callback = layered;
  }
  if (d instanceof JRippleDrawable) (copy as JRippleDrawable).mask = d.mask ? cloneDrawable(d.mask) : null;
  if (d instanceof JAnimatedVectorDrawable) Object.assign(copy, { root: cloneTree(d.base), startT: -1, callbacks: [] });
  return copy;
}
rt.register({
  name: "android/graphics/drawable/RippleDrawable", ctor: JRippleDrawable, sup: "android/graphics/drawable/LayerDrawable",
  methods: cslBoundary({
    "<init>(Landroid/content/res/ColorStateList;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V":
      function (this: JRippleDrawable, csl: JColorStateList | null, content: JDrawable | null) {
        if (content) this.pushLayer(content);
        this.setColor(csl);
      },
    "setColor(Landroid/content/res/ColorStateList;)V": function (this: JRippleDrawable, csl: JColorStateList) {
      this.setColor(csl);
      invalidateSelf.call(this);
    },
    "setHotspot(FF)V": function (this: JRippleDrawable, x: number, y: number) { this.hx = x; this.hy = y; },
    "isProjected()Z": () => 0,
    "isStateful()Z": () => 1,
    "hasFocusStateSpecified()Z": () => 1,
    "setRadius(I)V": function (this: JRippleDrawable, r: number) { this.explicitRadius = r; },
    "getRadius()I": function (this: JRippleDrawable) { return this.explicitRadius; },
    "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;": function (this: JRippleDrawable) {
      const source = this;
      const state = rt.make("android/graphics/drawable/RippleDrawable$RippleState") as JDrawableState;
      state.create = () => cloneDrawable(source);
      return state;
    },
  }),
});
class JVectorDrawable extends JDrawable {
  vw = 24; vh = 24; // dp size
  vpW = 24; vpH = 24;
  root: VRoot = { name: "", rotation: 0, pivotX: 0, pivotY: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, children: [], alpha: 1 };
  paint(cv: JCanvas) {
    const { left, top, right, bottom } = this.bounds;
    const w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0) return;
    const ctx = cv.ctx;
    ctx.save();
    ctx.globalAlpha *= this.alpha / 255 * this.root.alpha;
    ctx.translate(left, top);
    ctx.scale(w / this.vpW, h / this.vpH);
    drawVectorGroup(ctx, this.root, this.tint, ctx.globalAlpha);
    ctx.restore();
  }
  size(vertical: boolean): number { return (vertical ? this.vh : this.vw) * device.density; }
}
/** AnimatedVectorDrawable: its vector's tree, re-evaluated from the inflated one at every draw
 *  while its targets' timelines run, and left at their end values when they finish. */
class JAnimatedVectorDrawable extends JVectorDrawable {
  base: VRoot = this.root;
  targets: { name: string; timeline: Timeline }[] = [];
  startT = -1;
  callbacks: unknown[] = [];
  length() { return Math.max(0, ...this.targets.map((t) => timelineLength(t.timeline))); }
  paint(cv: JCanvas) {
    if (this.startT >= 0) {
      const ms = guestNow() - this.startT;
      this.evaluate(ms);
      if (ms >= this.length()) this.finish(); else invalidateSelf.call(this);
    }
    super.paint(cv);
  }
  /** the targets at `ms` after start; Infinity is AnimatorSet.end()'s end values */
  evaluate(ms: number) {
    this.root = cloneTree(this.base);
    const now = namedTargets(this.root), from = namedTargets(this.base);
    for (const { name, timeline } of this.targets) {
      const target = now.get(name);
      if (target) applyTimeline(timeline, ms, target, from.get(name)!);
    }
  }
  start() {
    if (this.startT >= 0) return;
    this.startT = guestNow();
    for (const cb of this.callbacks) void vcall(cb, "onAnimationStart", "(Landroid/graphics/drawable/Drawable;)V", this);
    invalidateSelf.call(this);
  }
  finish() {
    this.startT = -1;
    for (const cb of this.callbacks) void vcall(cb, "onAnimationEnd", "(Landroid/graphics/drawable/Drawable;)V", this);
  }
}
rt.register({ name: "android/graphics/drawable/Animatable2", ctor: class extends JObj {} });
rt.register({ name: "android/graphics/drawable/Animatable2$AnimationCallback", ctor: class extends JObj {}, methods: {
  ...noops("<init>()V"),
} });
// ── DrawableWrapper: one child, everything forwarded (AOSP's base for Clip/Scale/Inset and any
// app drawable that decorates another). Bounds, state and level reach the child through its
// own virtual hooks; draw() dispatches virtually so a compiled child subclass paints itself.
class JDrawableWrapper extends JDrawable {
  dr: JDrawable | null = null;
  paint(cv: JCanvas): unknown { if (this.dr) return drawChild(this.dr, cv); }
  size(vertical: boolean) { return this.dr ? drawableSize(this.dr, vertical) : -1; }
  onStateChange(): boolean { return this.dr ? this.dr.onStateChange() : false; }
}
const wrapSet = driven(function* wrapSet(this: JDrawableWrapper, d: JDrawable | null): Gen {
  const thread = curThread;
  if (this.dr) this.dr.callback = null;
  this.dr = d;
  if (d) {
    d.callback = this;
    yield vcallOn(thread, d, "setVisible", "(ZZ)Z", +this.visible, 1);
    yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(this.stateSet));
    yield vcallOn(thread, d, "setLevel", "(I)Z", this.level);
    yield vcallOn(thread, d, "setBounds", "(IIII)V", this.bounds.left, this.bounds.top, this.bounds.right, this.bounds.bottom);
    yield vcallOn(thread, d, "setLayoutDirection", "(I)Z", this.layoutDir);
  }
  invalidateSelf.call(this);
});
rt.register({
  name: "android/graphics/drawable/DrawableWrapper", ctor: JDrawableWrapper, sup: "android/graphics/drawable/Drawable",
  ifaces: ["android/graphics/drawable/Drawable$Callback"],
  methods: cslBoundary({
    "<init>(Landroid/graphics/drawable/Drawable;)V": wrapSet,
    "setDrawable(Landroid/graphics/drawable/Drawable;)V": wrapSet,
    "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JDrawableWrapper) { return this.dr; },
    "onBoundsChange(Landroid/graphics/Rect;)V": function (this: JDrawableWrapper, r: JRect) { if (this.dr) return setBounds.call(this.dr, r.left, r.top, r.right, r.bottom); },
    // a child whose state changed may have changed its padding: AOSP re-runs onBoundsChange
    "onStateChange([I)Z": function (this: JDrawableWrapper, st: Int32Array) {
      if (!this.dr) return 0;
      return after(vcall(this.dr, "setState", "([I)Z", st), (changed: number) =>
        changed ? after(vcall(this, "onBoundsChange", "(Landroid/graphics/Rect;)V", this.bounds), () => changed) : changed);
    },
    "onLevelChange(I)Z": function (this: JDrawableWrapper, l: number) { return this.dr ? vcall(this.dr, "setLevel", "(I)Z", l) : 0; },
    "isStateful()Z": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "isStateful", "()Z") : 0; },
    "hasFocusStateSpecified()Z": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "hasFocusStateSpecified", "()Z") : 0; },
    "getPadding(Landroid/graphics/Rect;)Z": function (this: JDrawableWrapper, r: JRect) {
      if (this.dr) return vcall(this.dr, "getPadding", "(Landroid/graphics/Rect;)Z", r);
      r.left = r.top = r.right = r.bottom = 0; return 0;
    },
    "getOpacity()I": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "getOpacity", "()I") : -2; },
    "setAlpha(I)V": function (this: JDrawableWrapper, a: number) { this.alpha = a; if (this.dr) return vcall(this.dr, "setAlpha", "(I)V", a); },
    "getAlpha()I": function (this: JDrawableWrapper) { return this.dr ? vcall(this.dr, "getAlpha", "()I") : 255; },
    "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JDrawableWrapper, f: unknown) { if (this.dr) return vcall(this.dr, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", f); },
    "setTintList(Landroid/content/res/ColorStateList;)V": function (this: JDrawableWrapper, c: unknown) { if (this.dr) return vcall(this.dr, "setTintList", "(Landroid/content/res/ColorStateList;)V", c); },
    "setTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JDrawableWrapper, m: unknown) { if (this.dr) return vcall(this.dr, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", m); },
    "setVisible(ZZ)Z": function (this: JDrawableWrapper, v: number, r: number) { return this.dr ? vcall(this.dr, "setVisible", "(ZZ)Z", v, r) : 0; },
    "jumpToCurrentState()V": function (this: JDrawableWrapper) { if (this.dr) return vcall(this.dr, "jumpToCurrentState", "()V"); },
    "mutate()Landroid/graphics/drawable/Drawable;": function (this: JDrawableWrapper) { if (this.dr) void vcall(this.dr, "mutate", "()Landroid/graphics/drawable/Drawable;"); return this; },
    "getOutline(Landroid/graphics/Outline;)V": function (this: JDrawableWrapper, o: unknown) { if (this.dr) return vcall(this.dr, "getOutline", "(Landroid/graphics/Outline;)V", o); },
    ...noops("applyTheme(Landroid/content/res/Resources$Theme;)V",
      "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V"),
    ...stubs(0, "canApplyTheme()Z", "getChangingConfigurations()I"),
    ...stubs(null, "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;"),
  }),
});
class JClipDrawable extends JDrawableWrapper {
  gravity = 3;
  orientation = 1;
  paint(cv: JCanvas): unknown { return rt.drive(this.paint$(cv)); }
  *paint$(cv: JCanvas): Gen {
    if (!this.dr || this.level <= 0) return;
    const b = this.bounds, f = Math.min(1, this.level / 10000);
    const w = b.right - b.left, h = b.bottom - b.top;
    const width = this.orientation & 1 ? Math.round(w * f) : w;
    const height = this.orientation & 2 ? Math.round(h * f) : h;
    const gravity = absGravity(this.gravity, this.layoutDir);
    const left = (gravity & 7) === 5 ? b.right - width : (gravity & 7) === 1 ? b.left + Math.round((w - width) / 2) : b.left;
    const top = (gravity & 112) === 80 ? b.bottom - height : (gravity & 112) === 16 ? b.top + Math.round((h - height) / 2) : b.top;
    cv.ctx.save();
    cv.ctx.beginPath(); cv.ctx.rect(left, top, width, height); cv.ctx.clip();
    try { yield drawChild(this.dr, cv); } finally { cv.ctx.restore(); }
  }
}
rt.register({ name: "android/graphics/drawable/ClipDrawable", ctor: JClipDrawable,
  sup: "android/graphics/drawable/DrawableWrapper", statics: { HORIZONTAL: 1, VERTICAL: 2 }, methods: {
    "<init>(Landroid/graphics/drawable/Drawable;II)V": function (this: JClipDrawable, drawable: JDrawable | null, gravity: number, orientation: number) {
      this.gravity = gravity; this.orientation = orientation;
      return wrapSet.call(this, drawable);
    },
    "onLevelChange(I)Z": () => 1,
  } });
class JInsetDrawable extends JDrawableWrapper {
  insets: [number, number, number, number] = [0, 0, 0, 0];
  fractions: [number, number, number, number] = [0, 0, 0, 0];
  inset(edge: number): number {
    const b = this.bounds, length = edge % 2 ? b.bottom - b.top : b.right - b.left;
    return this.insets[edge] + Math.trunc(this.fractions[edge] * length);
  }
  size(vertical: boolean) {
    const edge = vertical ? 1 : 0, fraction = this.fractions[edge] + this.fractions[edge + 2];
    return after(super.size(vertical), n => n < 0 || fraction >= 1 ? -1 : Math.trunc(n / (1 - fraction)) + this.insets[edge] + this.insets[edge + 2]);
  }
}
const insetInit = (fraction: boolean) => function (this: JInsetDrawable, d: JDrawable | null, l: number, t = l, r = l, b = l) {
  if (fraction) this.fractions = [l, t, r, b]; else this.insets = [l, t, r, b];
  return wrapSet.call(this, d);
};
rt.register({ name: "android/graphics/drawable/InsetDrawable", ctor: JInsetDrawable, sup: "android/graphics/drawable/DrawableWrapper", methods: {
  "<init>(Landroid/graphics/drawable/Drawable;I)V": insetInit(false),
  "<init>(Landroid/graphics/drawable/Drawable;IIII)V": insetInit(false),
  "<init>(Landroid/graphics/drawable/Drawable;F)V": insetInit(true),
  "<init>(Landroid/graphics/drawable/Drawable;FFFF)V": insetInit(true),
  "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;": driven(function* (this: JInsetDrawable): Gen {
    const childState = this.dr && (yield vcall(this.dr, "getConstantState", "()Landroid/graphics/drawable/Drawable$ConstantState;"));
    if (!childState) return null;
    const { insets, fractions, tint, tintCsl, alpha, autoMirrored } = this;
    const state = rt.make("android/graphics/drawable/InsetDrawable$InsetState") as JDrawableState;
    state.create = async () => {
      const drawable = rt.make("android/graphics/drawable/InsetDrawable") as JInsetDrawable;
      drawable.insets = [...insets]; drawable.fractions = [...fractions];
      drawable.tint = tint; drawable.tintCsl = tintCsl; drawable.alpha = alpha; drawable.autoMirrored = autoMirrored;
      await wrapSet.call(drawable, await vcall(childState, "newDrawable", "()Landroid/graphics/drawable/Drawable;"));
      return drawable;
    };
    return state;
  }),
  "onBoundsChange(Landroid/graphics/Rect;)V": function (this: JInsetDrawable, b: JRect) {
    if (this.dr) return vcallOn(curThread, this.dr, "setBounds", "(IIII)V", b.left + this.inset(0), b.top + this.inset(1), b.right - this.inset(2), b.bottom - this.inset(3));
  },
  "getOpacity()I": function (this: JInsetDrawable) {
    return after(this.dr ? vcallOn(curThread, this.dr, "getOpacity", "()I") : -2, opacity =>
      opacity === -1 && [0, 1, 2, 3].some(edge => this.inset(edge) > 0) ? -3 : opacity);
  },
  "getPadding(Landroid/graphics/Rect;)Z": function (this: JInsetDrawable, r: JRect) {
    r.left = r.top = r.right = r.bottom = 0;
    return after(this.dr ? vcallOn(curThread, this.dr, "getPadding", "(Landroid/graphics/Rect;)Z", r) : 0, pad => {
      const l = this.inset(0), t = this.inset(1), right = this.inset(2), b = this.inset(3);
      r.left += l; r.top += t; r.right += right; r.bottom += b;
      return +(!!pad || !!(l | t | right | b));
    });
  },
} });

class JRotateDrawable extends JDrawableWrapper {
  fromDegrees = 0; toDegrees = 360; currentDegrees = 0;
  pivotX = 0.5; pivotY = 0.5; pivotXRelative = true; pivotYRelative = true;
  paint(canvas: JCanvas): unknown {
    if (!this.dr) return;
    const b = this.dr.bounds, ctx = canvas.ctx;
    const x = b.left + this.pivotX * (this.pivotXRelative ? b.right - b.left : 1);
    const y = b.top + this.pivotY * (this.pivotYRelative ? b.bottom - b.top : 1);
    ctx.save(); ctx.translate(x, y);
    ctx.rotate(this.currentDegrees * Math.PI / 180);
    ctx.translate(-x, -y);
    try {
      const result = drawChild(this.dr, canvas);
      if (result instanceof Promise) return result.finally(() => ctx.restore());
    } catch (e) { ctx.restore(); throw e; }
    ctx.restore();
  }
}
rt.register({ name: "android/graphics/drawable/RotateDrawable", ctor: JRotateDrawable, sup: "android/graphics/drawable/DrawableWrapper", methods: {
  "onLevelChange(I)Z": function (this: JRotateDrawable, level: number) {
    return after(this.dr ? vcall(this.dr, "setLevel", "(I)Z", level) : undefined, () => {
      this.currentDegrees = this.fromDegrees + (this.toDegrees - this.fromDegrees) * level / 10000;
      invalidateSelf.call(this); return 1;
    });
  },
  ...Object.fromEntries((["fromDegrees", "toDegrees", "pivotX", "pivotY", "pivotXRelative", "pivotYRelative"] as const).flatMap(key => {
    const boolean = key.endsWith("Relative"), cap = key[0].toUpperCase() + key.slice(1), type = boolean ? "Z" : "F";
    return [
      [`${boolean ? "is" : "get"}${cap}()${type}`, function (this: JRotateDrawable) { return boolean ? +this[key] : this[key]; }],
      [`set${cap}(${type})V`, function (this: JRotateDrawable, value: number) {
        if (key === "pivotXRelative" || key === "pivotYRelative") this[key] = !!value; else this[key] = value;
        invalidateSelf.call(this);
      }],
    ];
  })),
} });
class JScaleDrawable extends JDrawableWrapper {
  scaleWidth = -1; scaleHeight = -1; gravity = 3; useIntrinsicMinimum = false;
  scaled = new JRect();
  paint(canvas: JCanvas) { if (this.dr && this.dr.level !== 0) return drawChild(this.dr, canvas); }
  layout(thread = curThread): unknown { return rt.drive(this.layout$(thread)); }
  *layout$(thread = curThread): Gen {
    const child = this.dr;
    if (!child) return;
    const b = this.bounds;
    let w = b.right - b.left, h = b.bottom - b.top;
    if (this.scaleWidth > 0) {
      const min = this.useIntrinsicMinimum ? Number(yield drawableSize(child, false, thread)) : 0;
      w -= Math.trunc((w - min) * (10000 - this.level) * this.scaleWidth / 10000);
    }
    if (this.scaleHeight > 0) {
      const min = this.useIntrinsicMinimum ? Number(yield drawableSize(child, true, thread)) : 0;
      h -= Math.trunc((h - min) * (10000 - this.level) * this.scaleHeight / 10000);
    }
    gravityApply(absGravity(this.gravity, this.layoutDir), w, h, b, 0, 0, this.scaled);
    if (w > 0 && h > 0) yield vcallOn(thread, child, "setBounds", "(IIII)V", this.scaled.left, this.scaled.top, this.scaled.right, this.scaled.bottom);
  }
}
rt.register({ name: "android/graphics/drawable/ScaleDrawable", ctor: JScaleDrawable, sup: "android/graphics/drawable/DrawableWrapper", methods: {
  "<init>(Landroid/graphics/drawable/Drawable;IFF)V": driven(function* (this: JScaleDrawable, d: JDrawable | null, gravity: number, w: number, h: number): Gen {
    const thread = curThread;
    this.gravity = gravity; this.scaleWidth = w; this.scaleHeight = h; yield wrapSet.call(this, d);
    return this.layout(thread);
  }),
  "onBoundsChange(Landroid/graphics/Rect;)V": function (this: JScaleDrawable) { return this.layout(); },
  "onLevelChange(I)Z": driven(function* (this: JScaleDrawable, level: number): Gen {
    const thread = curThread;
    if (this.dr) yield vcallOn(thread, this.dr, "setLevel", "(I)Z", level);
    yield this.layout(thread); invalidateSelf.call(this); return 1;
  }),
} });
// ── android.graphics.drawable.shapes + ShapeDrawable: a Shape is resized to the drawable's
// bounds and painted with the drawable's own Paint (translated to the bounds origin, as AOSP).
class JShape extends JObj {
  w = 0; h = 0;
  path(): Path2D { const p = new Path2D(); p.rect(0, 0, this.w, this.h); return p; }
}
class JOvalShape extends JShape {
  path(): Path2D { const p = new Path2D(); p.ellipse(this.w / 2, this.h / 2, this.w / 2, this.h / 2, 0, 0, Math.PI * 2); return p; }
}
const rr = (p: Path2D, x: number, y: number, w: number, h: number, radii: Float32Array | null) => {
  if (!radii) { p.rect(x, y, w, h); return; }
  // AOSP radii are [tl-x, tl-y, tr-x, tr-y, br-x, br-y, bl-x, bl-y]
  p.roundRect(x, y, w, h, [
    { x: radii[0], y: radii[1] }, { x: radii[2], y: radii[3] }, { x: radii[4], y: radii[5] }, { x: radii[6], y: radii[7] },
  ]);
};
class JRoundRectShape extends JShape {
  outer: Float32Array | null = null; inset: JRectF | null = null; inner: Float32Array | null = null;
  path(): Path2D {
    const p = new Path2D();
    rr(p, 0, 0, this.w, this.h, this.outer);
    if (this.inset) {
      const i = this.inset;
      // the inner ring is cut out (even-odd fill in ShapeDrawable's draw)
      const q = new Path2D();
      rr(q, i.left, i.top, this.w - i.left - i.right, this.h - i.top - i.bottom, this.inner);
      p.addPath(q);
    }
    return p;
  }
}
const M_shapeDraw = mangleMethod("draw", "(Landroid/graphics/Canvas;Landroid/graphics/Paint;)V");
const M_onResize = mangleMethod("onResize", "(FF)V");
const shapeMethods: NonNullable<NativeSpec["methods"]> = {
  "getWidth()F": function (this: JShape) { return this.w; },
  "getHeight()F": function (this: JShape) { return this.h; },
  "resize(FF)V": function (this: JShape, w: number, h: number) {
    w = Math.max(0, w); h = Math.max(0, h);
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    return jmethod(this, M_onResize)!.call(this, w, h);
  },
  ...noops("<init>()V", "getOutline(Landroid/graphics/Outline;)V"),
  ...stubs(1, "hasAlpha()Z"),
  "draw(Landroid/graphics/Canvas;Landroid/graphics/Paint;)V": function (this: JShape, cv: JCanvas, p: JPaint) {
    const path = this.path();
    const evenOdd = this instanceof JRoundRectShape && !!this.inset;
    cv.drawShape(p, (c) => c.fill(path, evenOdd ? "evenodd" : "nonzero"), (c) => c.stroke(path));
  },
  "clone()Landroid/graphics/drawable/shapes/Shape;": function (this: JShape) { return Object.assign(new (this.constructor as any)(), this); },
};
rt.register({ name: "android/graphics/drawable/shapes/Shape", ctor: JShape, ifaces: ["java/lang/Cloneable"], methods: shapeMethods });
rt.register({ name: "android/graphics/drawable/shapes/RectShape", ctor: class extends JShape {}, sup: "android/graphics/drawable/shapes/Shape", methods: { "<init>()V": function () {} } });
rt.register({ name: "android/graphics/drawable/shapes/OvalShape", ctor: JOvalShape, sup: "android/graphics/drawable/shapes/RectShape", methods: { "<init>()V": function () {} } });
rt.register({
  name: "android/graphics/drawable/shapes/RoundRectShape", ctor: JRoundRectShape, sup: "android/graphics/drawable/shapes/RectShape",
  methods: {
    "<init>([FLandroid/graphics/RectF;[F)V": function (this: JRoundRectShape, outer: Float32Array | null, inset: JRectF | null, inner: Float32Array | null) {
      if (outer && outer.length < 8) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", "outer radii must have >= 8 values");
      if (inner && inner.length < 8) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", "inner radii must have >= 8 values");
      this.outer = outer; this.inset = inset; this.inner = inner;
    },
  },
});

class JShapeDrawable extends JDrawable {
  shape: JShape | null = null;
  p = new JPaint();
  iw = 0; ih = 0;
  padding: JRect | null = null;
  shaderFactory: unknown = null;
  effPaint(): JPaint { return this.tint === null ? this.p : Object.assign(new JPaint(), this.p, { color: this.tint }); }
  size(vertical: boolean): number { return vertical ? this.ih : this.iw; }
}
class JPaintDrawable extends JShapeDrawable {
  setCornerRadii(radii: Float32Array | null) {
    if (radii) {
      const shape = new JRoundRectShape();
      shape.outer = radii;
      this.shape = shape;
    } else {
      this.shape = new JShape();
    }
    invalidateSelf.call(this);
  }
}
// PictureDrawable replays a recorded Picture.
class JPictureDrawable extends JDrawable { picture: unknown = null; }
rt.register({
  name: "android/graphics/drawable/PictureDrawable", ctor: JPictureDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>(Landroid/graphics/Picture;)V": function (this: JPictureDrawable, p: unknown) { this.picture = p; },
    "setPicture(Landroid/graphics/Picture;)V": function (this: JPictureDrawable, p: unknown) { this.picture = p; invalidateSelf.call(this); },
    "getPicture()Landroid/graphics/Picture;": function (this: JPictureDrawable) { return this.picture; },
    "draw(Landroid/graphics/Canvas;)V": function (this: JPictureDrawable, cv: unknown) {
      return this.picture ? vcall(this.picture, "draw", "(Landroid/graphics/Canvas;)V", cv) : undefined;
    },
    "getIntrinsicWidth()I": function (this: JPictureDrawable) {
      return this.picture ? vcall(this.picture, "getWidth", "()I") : -1;
    },
    "getIntrinsicHeight()I": function (this: JPictureDrawable) {
      return this.picture ? vcall(this.picture, "getHeight", "()I") : -1;
    },
  },
});
rt.register({
  name: "android/graphics/drawable/ShapeDrawable", ctor: JShapeDrawable, sup: "android/graphics/drawable/Drawable",
  methods: {
    "<init>()V": function (this: JShapeDrawable) { this.p.antiAlias = true; },
    "<init>(Landroid/graphics/drawable/shapes/Shape;)V": function (this: JShapeDrawable, sh: JShape | null) { this.shape = sh; this.p.antiAlias = true; },
    "getPaint()Landroid/graphics/Paint;": function (this: JShapeDrawable) { return this.p; },
    "getShape()Landroid/graphics/drawable/shapes/Shape;": function (this: JShapeDrawable) { return this.shape; },
    "setShape(Landroid/graphics/drawable/shapes/Shape;)V": function (this: JShapeDrawable, sh: JShape | null) { this.shape = sh; invalidateSelf.call(this); },
    "setIntrinsicWidth(I)V": function (this: JShapeDrawable, w: number) { this.iw = w; },
    "setIntrinsicHeight(I)V": function (this: JShapeDrawable, h: number) { this.ih = h; },
    "setPadding(IIII)V": function (this: JShapeDrawable, l: number, t: number, r: number, b: number) {
      if (!l && !t && !r && !b) { this.padding = null; return; }
      const p = this.padding ?? (this.padding = new JRect());
      p.left = l; p.top = t; p.right = r; p.bottom = b;
    },
    "setPadding(Landroid/graphics/Rect;)V": function (this: JShapeDrawable, r: JRect | null) {
      if (!r) { this.padding = null; return; }
      const p = this.padding ?? (this.padding = new JRect());
      p.left = r.left; p.top = r.top; p.right = r.right; p.bottom = r.bottom;
    },
    "setAlpha(I)V": function (this: JShapeDrawable, a: number) { this.alpha = a; this.p.setColorValue(((a << 24) | (this.p.color & 0xffffff)) | 0); invalidateSelf.call(this); },
    "getAlpha()I": function (this: JShapeDrawable) { return this.p.color >>> 24; },
    "getOpacity()I": function (this: JShapeDrawable) { const a = this.p.color >>> 24; return a === 255 ? -1 : a === 0 ? -2 : -3; },
    "getOutline(Landroid/graphics/Outline;)V": () => {},
    "setShaderFactory(Landroid/graphics/drawable/ShapeDrawable$ShaderFactory;)V": function (this: JShapeDrawable, factory: unknown) { this.shaderFactory = factory; },
    "getShaderFactory()Landroid/graphics/drawable/ShapeDrawable$ShaderFactory;": function (this: JShapeDrawable) { return this.shaderFactory; },
    "onBoundsChange(Landroid/graphics/Rect;)V": driven(function* (this: JShapeDrawable, bounds: JRect): Gen {
      onBoundsChangeAll(this);
      const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
      if (!this.shape) return;
      yield vcall(this.shape, "resize", "(FF)V", width, height);
      if (this.shaderFactory) {
        const shader = yield vcall(this.shaderFactory, "resize", "(II)Landroid/graphics/Shader;", width, height);
        yield vcall(this.p, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", shader);
      }
    }),
    // the virtual route: an app Shape subclass's onResize/draw, and an app ShapeDrawable's onDraw
    "draw(Landroid/graphics/Canvas;)V": driven(function* (this: JShapeDrawable, cv: JCanvas): Gen {
      const sh = this.shape;
      if (!sh) return;
      const b = this.bounds, ctx = cv.ctx;
      yield vcall(sh, "resize", "(FF)V", b.right - b.left, b.bottom - b.top);
      ctx.save();
      ctx.translate(b.left, b.top);
      try { yield vcall(this, "onDraw", "(Landroid/graphics/drawable/shapes/Shape;Landroid/graphics/Canvas;Landroid/graphics/Paint;)V", sh, cv, this.effPaint()); }
      finally { ctx.restore(); }
    }),
    "onDraw(Landroid/graphics/drawable/shapes/Shape;Landroid/graphics/Canvas;Landroid/graphics/Paint;)V": function (this: JShapeDrawable, sh: JShape, cv: JCanvas, p: JPaint) {
      return jmethod(sh, M_shapeDraw)!.call(sh, cv, p);
    },
  },
});
rt.register({ name: "android/graphics/drawable/ShapeDrawable$ShaderFactory", ctor: class extends JObj {}, methods: { ...noops("<init>()V") } });
rt.register({
  name: "android/graphics/drawable/PaintDrawable", ctor: JPaintDrawable, sup: "android/graphics/drawable/ShapeDrawable",
  methods: {
    "<init>()V": function (this: JPaintDrawable) { this.p.antiAlias = true; this.shape = new JShape(); },
    "<init>(I)V": function (this: JPaintDrawable, color: number) { this.p.antiAlias = true; this.p.setColorValue(color); this.shape = new JShape(); },
    "setCornerRadius(F)V": function (this: JPaintDrawable, radius: number) {
      this.setCornerRadii(radius > 0 ? new Float32Array(8).fill(radius) : null);
    },
    "setCornerRadii([F)V": function (this: JPaintDrawable, radii: Float32Array | null) { this.setCornerRadii(radii); },
  },
});
rt.register({ name: "android/graphics/drawable/VectorDrawable", ctor: JVectorDrawable, sup: "android/graphics/drawable/Drawable", methods: {
  "getConstantState()Landroid/graphics/drawable/Drawable$ConstantState;": function (this: JVectorDrawable) {
    const { vw, vh, vpW, vpH, root, tint, tintCsl, tintMode, alpha, autoMirrored } = this;
    const state = rt.make("android/graphics/drawable/VectorDrawable$VectorDrawableState") as JDrawableState;
    state.create = () => Object.assign(new JVectorDrawable(), { vw, vh, vpW, vpH, root, tint, tintCsl, tintMode, alpha, autoMirrored });
    return state;
  },
} });
rt.register({
  name: "android/graphics/drawable/AnimatedVectorDrawable", ctor: JAnimatedVectorDrawable,
  sup: "android/graphics/drawable/VectorDrawable", ifaces: ["android/graphics/drawable/Animatable2"], methods: {
    "start()V": function (this: JAnimatedVectorDrawable) { this.start(); },
    // AnimatorSet.end(): the targets take their end values
    "stop()V": function (this: JAnimatedVectorDrawable) {
      if (this.startT < 0) return;
      this.evaluate(Infinity);
      this.finish();
      invalidateSelf.call(this);
    },
    "reset()V": function (this: JAnimatedVectorDrawable) { this.startT = -1; this.root = cloneTree(this.base); invalidateSelf.call(this); },
    "isRunning()Z": function (this: JAnimatedVectorDrawable) { return +(this.startT >= 0); },
    "registerAnimationCallback(Landroid/graphics/drawable/Animatable2$AnimationCallback;)V": function (this: JAnimatedVectorDrawable, cb: unknown) {
      if (cb && !this.callbacks.includes(cb)) this.callbacks.push(cb);
    },
    "unregisterAnimationCallback(Landroid/graphics/drawable/Animatable2$AnimationCallback;)Z": function (this: JAnimatedVectorDrawable, cb: unknown) {
      const i = this.callbacks.indexOf(cb);
      if (i >= 0) this.callbacks.splice(i, 1);
      return +(i >= 0);
    },
    "clearAnimationCallbacks()V": function (this: JAnimatedVectorDrawable) { this.callbacks = []; },
  },
});

export class JColorStateList extends JObj {
  items: { states: number[]; negStates: number[]; color: number }[] = [];
  defColor = -16777216;
}
export function cslColor(csl: JColorStateList, states: ArrayLike<number>): number {
  const { items, defColor } = tsCsl(csl)!;
  for (let i = 0; i < items.length; i++) if (matchesState(items[i], states)) return items[i].color ?? defColor;
  return defColor;
}
// Our own stack keeps its colour lists as JColorStateList while Java holds AOSP's ColorStateList,
// so a list crosses at the spec methods that take or return one: read out of its states and
// colours coming in, built through its constructor going out.
const fromJava = new WeakMap<object, JColorStateList>(), toJava = new WeakMap<JColorStateList, unknown>();
/** our own list for a ColorStateList, which may be AOSP's */
function tsCsl(c: unknown): JColorStateList | null {
  if (!c || c instanceof JColorStateList) return (c as JColorStateList | null) ?? null;
  let t = fromJava.get(c as object);
  if (!t) {
    t = new JColorStateList();
    const cls = "android/content/res/ColorStateList";
    const specs = javaField<Int32Array[]>(c, cls, "mStateSpecs"), colors = javaField<Int32Array>(c, cls, "mColors");
    for (let i = 0; i < specs.length; i++) t.items.push({ ...splitStates(specs[i]), color: colors[i] });
    t.defColor = javaField<number>(c, cls, "mDefaultColor");
    fromJava.set(c as object, t);
    toJava.set(t, c);
  }
  return t;
}
/** the ColorStateList Java code sees for one of ours */
function javaCsl(c: JColorStateList | null): unknown {
  if (!c || !(c instanceof JColorStateList)) return c;
  const known = toJava.get(c);
  if (known) return known;
  const specs = jarray(c.items.map((i) => Int32Array.from([...i.states, ...i.negStates.map((s) => -s)])), "[I");
  return after(newObj("android/content/res/ColorStateList", "([[I[I)V", specs, Int32Array.from(c.items, (i) => i.color)), (j: object) => {
    toJava.set(c, j); fromJava.set(j, c);
    return j;
  });
}
/** the colour-list parameters and results of a spec's methods, crossing as tsCsl/javaCsl say */
export function cslBoundary(methods: NonNullable<NativeSpec["methods"]>): NonNullable<NativeSpec["methods"]> {
  // evaluated while the modules that declare specs load, so it reads nothing this module has yet to define
  const CSL = "Landroid/content/res/ColorStateList;";
  const out = { ...methods };
  for (const [key, fn] of Object.entries(methods)) {
    if (typeof fn !== "function" || !key.includes(CSL)) continue;
    const { params, ret } = parseMethodDesc(key.slice(key.indexOf("(")));
    const at = params.flatMap((p, i) => (p === CSL ? [i] : []));
    out[key] = function (this: unknown, ...args: unknown[]) {
      for (const i of at) args[i] = tsCsl(args[i]);
      const r = (fn as (...a: unknown[]) => unknown).apply(this, args);
      return ret === CSL ? after(r as JColorStateList | null, (c) => javaCsl(c)) : r;
    };
  }
  return out;
}
export function mkCsl(color: number): JColorStateList {
  const c = new JColorStateList();
  c.defColor = color;
  c.items.push({ states: [], negStates: [], color });
  return c;
}
// ─────────────────────────── drawable/CSL loading from resources

const AT = attrTable(
  "color", "drawable", "shape", "radius", "topLeftRadius", "topRightRadius", "bottomLeftRadius",
  "bottomRightRadius", "width", "height", "left", "top", "right", "bottom", "startColor", "centerColor",
  "endColor", "angle", "type", "gradientRadius", "src", "alpha", "tint", "tintMode", "viewportWidth",
  "viewportHeight", "pathData", "fillColor", "strokeColor", "strokeWidth", "fillAlpha", "fillType",
  "insetLeft", "insetTop", "insetRight", "insetBottom", "inset", "dashWidth", "dashGap", "id",
  "scaleGravity", "gravity", "orientation", "oneshot", "duration", "scaleWidth", "scaleHeight", "useIntrinsicSizeAsMinimum", "level",
  "pivotX", "pivotY", "translateX", "translateY", "scaleX", "scaleY", "rotation", "fromDegrees", "toDegrees", "name",
  "trimPathStart", "trimPathEnd", "trimPathOffset", "strokeAlpha", "strokeLineCap", "strokeLineJoin", "strokeMiterLimit", "animation",
  "minLevel", "maxLevel");
const LINE_CAPS: CanvasLineCap[] = ["butt", "round", "square"], LINE_JOINS: CanvasLineJoin[] = ["miter", "round", "bevel"];
/** Drawable.parseTintMode: android:tintMode's enum values */
const TINT_MODES: Record<number, string> = { 3: "SRC_OVER", 5: "SRC_IN", 9: "SRC_ATOP", 14: "MULTIPLY", 15: "SCREEN", 16: "ADD" };
/** an <item>/<inset>'s drawable: its android:drawable, else its first inline child */
const itemDrawable = driven(function* itemDrawable(res: Resources, node: XmlNode, theme: JTheme | null): Gen<JDrawable | null> {
  const da = nodeAttrRV(node, AT.drawable);
  if (da) return yield loadDrawableRV(res, da, theme);
  return node.children.length ? yield inflateDrawableNode(res, node.children[0], theme) : null;
});
const inflateDrawableNode = driven(function* inflateDrawableNode$(res: Resources, node: XmlNode, theme: JTheme | null): Gen<JDrawable> {
  const get = (id: number, from = node) => resolveStyleValue(res, theme, nodeAttrRV(from, id));
  const dimen = (v: RV | null, fallback = 0) => rvDimen(res, resolveStyleValue(res, theme, v), fallback);
  const colorOf = (v: RV | null, d = 0) => {
    if (v && v.t === TV.ATTRIBUTE) v = theme?.lookup(v.d) ?? null;
    if (v && v.t === TV.REFERENCE) {
      const rr = res.resolveRefs(v);
      if (rr.t === TV.REFERENCE && rr.s) return 0; // selector file; simplify
      v = rr;
    }
    return rvColor(res, v, d);
  };
  /** android:tint and android:tintMode: a colour or a state list, as setTintList would apply it */
  const xmlTint = driven(function* xmlTint(d: JDrawable): Gen {
    const tint = get(AT.tint), mode = get(AT.tintMode);
    if (tint?.t === TV.REFERENCE) {
      d.tintCsl = (yield loadColorStateList(res, tint.d, theme)) as JColorStateList;
      d.tint = cslColor(d.tintCsl, d.stateSet);
    } else if (tint) d.tint = rvColor(res, tint);
    if (mode) d.tintMode = TINT_MODES[mode.d] ?? d.tintMode;
  });
  switch (node.name) {
    case "shape": {
      const d = new JGradientDrawable();
      d.shape = rvColor(res, get(AT.shape), 0) & 3;
      yield xmlTint(d);
      for (const c of node.children) {
        const cg = (id: number) => get(id, c);
        if (c.name === "solid") {
          const value = resolveStyleValue(res, theme, cg(AT.color));
          if (value?.t === TV.REFERENCE) {
            d.solidCsl = (yield loadColorStateList(res, value.d, theme)) as JColorStateList;
            d.solid = cslColor(d.solidCsl, d.stateSet);
          } else d.solid = rvColor(res, value, 0);
        }
        else if (c.name === "corners") {
          const r = dimen(cg(AT.radius), -1);
          if (r >= 0) d.radii = [r, r, r, r];
          d.radii = [
            dimen(cg(AT.topLeftRadius), d.radii[0]),
            dimen(cg(AT.topRightRadius), d.radii[1]),
            dimen(cg(AT.bottomRightRadius), d.radii[2]),
            dimen(cg(AT.bottomLeftRadius), d.radii[3]),
          ];
        } else if (c.name === "stroke") {
          const value = resolveStyleValue(res, theme, cg(AT.color));
          const color = value?.t === TV.REFERENCE ? (yield loadColorStateList(res, value.d, theme)) as JColorStateList : rvColor(res, value, 0);
          d.setStroke(dimen(cg(AT.width), 1), color, dimen(cg(AT.dashWidth), 0), dimen(cg(AT.dashGap), 0));
        } else if (c.name === "gradient") {
          const cols = [colorOf(cg(AT.startColor), 0)];
          const cc = cg(AT.centerColor);
          if (cc) cols.push(colorOf(cc, 0));
          cols.push(colorOf(cg(AT.endColor), 0));
          d.gradColors = cols;
          d.gradAngle = gradientAngle(rvFloat(res, cg(AT.angle), 0));
          d.gradType = xmlInt(res, cg(AT.type), 0);
          d.gradRadius = dimen(cg(AT.gradientRadius), 0);
        } else if (c.name === "size") {
          d.sizeW = dimen(cg(AT.width), -1);
          d.sizeH = dimen(cg(AT.height), -1);
        } else if (c.name === "padding") {
          d.padding.left = dimen(cg(AT.left), 0);
          d.padding.top = dimen(cg(AT.top), 0);
          d.padding.right = dimen(cg(AT.right), 0);
          d.padding.bottom = dimen(cg(AT.bottom), 0);
        }
      }
      return d;
    }
    case "rotate": {
      const d = new JRotateDrawable();
      d.fromDegrees = rvFloat(res, resolveStyleValue(res, theme, get(AT.fromDegrees)), 0);
      d.toDegrees = rvFloat(res, resolveStyleValue(res, theme, get(AT.toDegrees)), 360);
      d.currentDegrees = d.fromDegrees;
      for (const axis of ["X", "Y"] as const) {
        const value = resolveStyleValue(res, theme, get(axis === "X" ? AT.pivotX : AT.pivotY));
        if (!value) continue;
        const relative = value.t === TV.FRACTION;
        d[`pivot${axis}Relative`] = relative;
        d[`pivot${axis}`] = relative ? complexToFraction(value.d, 1, 1) : rvFloat(res, value);
      }
      yield wrapSet.call(d, yield itemDrawable(res, node, theme));
      return d;
    }
    case "clip": {
      const d = new JClipDrawable();
      d.gravity = xmlInt(res, get(AT.gravity), 3);
      d.orientation = xmlInt(res, get(AT.orientation), 1);
      yield wrapSet.call(d, yield itemDrawable(res, node, theme));
      return d;
    }
    case "scale": {
      const d = new JScaleDrawable();
      const fraction = (v: RV | null) => v?.t === TV.FRACTION ? complexToFraction(v.d, 1, 1)
        : v?.s?.endsWith("%") ? Number.parseFloat(v.s) / 100 : -1;
      d.scaleWidth = fraction(get(AT.scaleWidth)); d.scaleHeight = fraction(get(AT.scaleHeight));
      d.gravity = xmlInt(res, get(AT.scaleGravity), 3);
      d.useIntrinsicMinimum = !!xmlInt(res, get(AT.useIntrinsicSizeAsMinimum), 0);
      d.level = xmlInt(res, get(AT.level), 0);
      yield wrapSet.call(d, yield itemDrawable(res, node, theme));
      return d;
    }
    case "animated-selector":
    case "selector": {
      const d = new JStateListDrawable();
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const states: number[] = [], neg: number[] = [];
        let child: JDrawable | null = null;
        // StateListDrawable.extractStateSet: every attribute but drawable and id is a state,
        // an app's own (Material's state_indeterminate) as much as the framework's
        for (const a of c.attrs) {
          if (a.resId === AT.drawable) child = yield loadDrawableRV(res, xmlAttrRV(a), theme);
          else if (a.resId && a.resId !== AT.id) (a.data ? states : neg).push(a.resId);
        }
        if (!child && c.children.length) child = yield inflateDrawableNode(res, c.children[0], theme);
        if (child) d.items.push({ states, negStates: neg, d: child });
      }
      return d;
    }
    case "layer-list": case "transition": {
      const d = node.name === "transition" ? new JTransitionDrawable() : new JLayerDrawable();
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const child = yield itemDrawable(res, c, theme);
        if (child) {
          // AOSP LayerDrawable: an item may carry its own size and a gravity to place it by,
          // and layout() already implements that. Without them a 24dp arrow inflated into a
          // spinner's background is stretched across the whole widget.
          d.pushLayer(child, {
            insets: [
              rvDimen(res, get(AT.left, c), 0),
              rvDimen(res, get(AT.top, c), 0),
              rvDimen(res, get(AT.right, c), 0),
              rvDimen(res, get(AT.bottom, c), 0),
            ],
            w: rvDimen(res, get(AT.width, c), -1),
            h: rvDimen(res, get(AT.height, c), -1),
            gravity: nodeAttrRV(c, AT.gravity)?.d,
          });
          const idv = nodeAttrRV(c, AT.id);
          d.ids.push(idv ? idv.d : null);
        }
      }
      return d;
    }
    case "adaptive-icon": {
      const d = new JAdaptiveIconDrawable();
      for (const n of ["background", "foreground"]) {
        const c = node.children.find((k) => k.name === n);
        const child = c ? yield itemDrawable(res, c, theme) : null;
        if (child) d.pushLayer(child);
      }
      return d;
    }
    case "ripple": {
      const d = new JRippleDrawable();
      const cv = nodeAttrRV(node, AT.color);
      if (cv) d.rippleColor = (colorOf(cv, 0x33000000) & 0xffffff) | 0x40000000;
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const idv = nodeAttrRV(c, AT.id);
        // AOSP RippleDrawable: the layer identified as @android:id/mask is the shape the
        // ripple is clipped to, and is NEVER drawn. selectableItemBackground's mask is
        // @android:color/white, so drawing it fills the view with opaque white — which is
        // invisible on a light theme and the entire surface on a dark one.
        if (idv && idv.d === maskId(res)) { d.mask = yield itemDrawable(res, c, theme); continue; }
        const child = yield itemDrawable(res, c, theme);
        if (child) { d.pushLayer(child); d.ids.push(idv ? idv.d : null); }
      }
      return d;
    }
    case "inset": {
      const d = new JInsetDrawable(), all = get(AT.inset);
      for (const [i, attr] of [AT.insetLeft, AT.insetTop, AT.insetRight, AT.insetBottom].entries()) {
        const value = get(attr) ?? all;
        if (value?.t === TV.FRACTION) d.fractions[i] = complexToFraction(value.d, 1, 1);
        else d.insets[i] = dimen(value, 0);
      }
      yield wrapSet.call(d, yield itemDrawable(res, node, theme));
      return d;
    }
    // Both wrap a bitmap named by android:src; the .9.png's own npTc chunk is what makes it
    // stretch, so the tag only has to reach the file.
    case "bitmap":
    case "nine-patch": {
      const da = nodeAttrRV(node, AT.src);
      if (!da) return new JColorDrawable();
      const d: JDrawable = yield loadDrawableRV(res, da, theme);
      yield xmlTint(d);
      return d;
    }
    case "vector": {
      const d = new JVectorDrawable();
      d.vw = dimen(get(AT.width), 48) / res.dm.density;
      d.vh = dimen(get(AT.height), 48) / res.dm.density;
      d.vpW = rvFloat(res, get(AT.viewportWidth), 24);
      d.vpH = rvFloat(res, get(AT.viewportHeight), 24);
      yield xmlTint(d);
      const optColor = (c: XmlNode, id: number) => { const f = nodeAttrRV(c, id); return f ? colorOf(f, 0) : null; };
      const num = (c: XmlNode, id: number, fallback: number) => rvFloat(res, get(id, c), fallback);
      const group = (c: XmlNode): VGroup => ({
        name: nodeAttrRV(c, AT.name)?.s ?? "", rotation: num(c, AT.rotation, 0), pivotX: num(c, AT.pivotX, 0), pivotY: num(c, AT.pivotY, 0),
        scaleX: num(c, AT.scaleX, 1), scaleY: num(c, AT.scaleY, 1), translateX: num(c, AT.translateX, 0), translateY: num(c, AT.translateY, 0), children: [],
      });
      const walk = (n: XmlNode, g: VGroup) => {
        for (const c of n.children) {
          if (c.name === "group") walk(c, g.children[g.children.push(group(c)) - 1] as VGroup);
          else if (c.name === "path" || c.name === "clip-path") {
            // Material spells its switch paths as @string references
            const data = rvString(res, nodeAttrRV(c, AT.pathData));
            if (data) g.children.push({
              name: nodeAttrRV(c, AT.name)?.s ?? "", clip: c.name === "clip-path", nodes: parsePathData(data), path: null,
              fillColor: optColor(c, AT.fillColor), strokeColor: optColor(c, AT.strokeColor),
              strokeWidth: num(c, AT.strokeWidth, 0), strokeAlpha: num(c, AT.strokeAlpha, 1), fillAlpha: num(c, AT.fillAlpha, 1),
              trimPathStart: num(c, AT.trimPathStart, 0), trimPathEnd: num(c, AT.trimPathEnd, 1), trimPathOffset: num(c, AT.trimPathOffset, 0),
              cap: LINE_CAPS[xmlInt(res, get(AT.strokeLineCap, c), 0)] ?? "butt", join: LINE_JOINS[xmlInt(res, get(AT.strokeLineJoin, c), 0)] ?? "miter",
              miter: num(c, AT.strokeMiterLimit, 4), evenOdd: xmlInt(res, nodeAttrRV(c, AT.fillType), 0) === 1,
            } satisfies VPath);
          }
        }
      };
      d.root = { ...group(node), alpha: num(node, AT.alpha, 1) };
      walk(node, d.root);
      return d;
    }
    case "animated-vector": {
      const d = new JAnimatedVectorDrawable();
      const source = get(AT.drawable);
      const vector = source ? yield loadDrawableRV(res, source, theme) : null;
      if (vector instanceof JVectorDrawable) Object.assign(d, vector, { base: vector.root, root: cloneTree(vector.root) });
      for (const c of node.children) {
        const name = nodeAttrRV(c, AT.name)?.s, animation = nodeAttrRV(c, AT.animation);
        const timeline = c.name === "target" && name && animation?.t === TV.REFERENCE ? loadTimeline(res, animation.d) : null;
        if (timeline) d.targets.push({ name: name!, timeline });
      }
      return d;
    }
    case "color": {
      const d = new JColorDrawable();
      d.color = colorOf(get(AT.color), 0);
      return d;
    }
    case "animation-list": {
      const d = new JAnimationDrawable();
      d.oneShot = !!nodeAttrRV(node, AT.oneshot)?.d;
      for (const c of node.children) {
        if (c.name !== "item") continue;
        const child = yield itemDrawable(res, c, theme);
        if (child) d.frames.push({ d: child, ms: nodeAttrRV(c, AT.duration)?.d ?? 0 });
      }
      return d;
    }
    case "com.android.internal.graphics.drawable.AnimationScaleListDrawable": {
      const d = new JAnimationScaleListDrawable();
      for (const item of node.children) {
        if (item.name !== "item") continue;
        const child = yield itemDrawable(res, item, theme);
        if (!child) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "<item> requires a drawable");
        child.callback = d;
        d.children.push({ d: child });
        if (child instanceof JAnimationDrawable || child instanceof JAnimatedVectorDrawable) d.animated = d.children.length - 1;
      }
      return d;
    }
    case "level-list": {
      const d = new JLevelListDrawable();
      for (const c of node.children) {
        const child = c.name === "item" ? yield itemDrawable(res, c, theme) : null;
        if (!child) continue;
        child.callback = d;
        d.items.push({ min: xmlInt(res, get(AT.minLevel, c), 0), max: xmlInt(res, get(AT.maxLevel, c), 0), d: child });
      }
      return d;
    }
    default:
      if (!node.name.includes(".")) {
        rt.noteMissing("drawable tag <" + node.name + ">");
        return new JColorDrawable();
      }
      let drawable: unknown;
      try {
        drawable = yield newObj(node.name.replace(/\./g, "/"));
      } catch {
        throw rt.mkThrowable("android/view/InflateException", "Error inflating class " + node.name);
      }
      if (!(drawable instanceof JDrawable)) {
        throw rt.mkThrowable("android/view/InflateException", "Class is not a Drawable " + node.name);
      }
      const at = customTags.get(node);
      if (!at) throw rt.mkThrowable("android/view/InflateException", "Error inflating class " + node.name);
      const parser = yield at.open();
      try {
        for (let starts = -1; starts < at.index;) {
          const type = yield vcall(parser, "next", "()I");
          if (type === 2) starts++;
          else if (type === 1) throw rt.mkThrowable("org/xmlpull/v1/XmlPullParserException", "No start tag found");
        }
        yield vcall(drawable, "inflate", "(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V",
          res.jobj, parser, parser, theme?.jobj ?? null);
      } finally { yield vcall(parser, "close", "()V"); }
      return drawable;
  }
});
/** rvInt for drawable XML attrs, which arrive unresolved: follows @references (via rvColor). */
function xmlInt(res: Resources, v: RV | null, d: number): number {
  if (!v) return d;
  if (v.t === T_STR && v.s) return parseInt(v.s) || d;
  return rvColor(res, v, d);
}
const DPI_RE = /-(l|m|h|xh|xxh|xxxh)dpi/;
const DPI: Record<string, number> = { l: 120, m: 160, h: 240, xh: 320, xxh: 480, xxxh: 640 };
/** dpi a res/ path's qualifier declares, for a path with no table entry; an unqualified one is
 *  taken at the device's own density */
function densityOfPath(path: string): number { return DPI[DPI_RE.exec(path)?.[1] ?? ""] ?? device.densityDpi; }
/** a table configuration's density as BitmapFactory.decodeResourceStream reads it: none is
 *  DENSITY_DEFAULT (mdpi), nodpi is never scaled */
const bitmapDensity = (config: number) => config === 0 ? 160 : config === 0xffff ? device.densityDpi : config;

export const loadDrawableRV = driven(function* loadDrawableRV$(res: Resources, v: RV | null, theme: JTheme | null): Gen<JDrawable> {
  if (!v || v.t === TV.NULL) return new JColorDrawable();
  if (v.t === TV.ATTRIBUTE) return yield loadDrawableRV(res, theme?.lookup(v.d) ?? null, theme);
  if (v.t === TV.REFERENCE) return yield loadDrawable(res, v.d, theme);
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) {
    const d = new JColorDrawable();
    d.color = v.d;
    return d;
  }
  if (v.s) { // a path straight off an attribute, always the app's own
    const bytes = res.arsc?.files(v.s);
    if (bytes) return yield loadDrawableFile(res, v.s, bytes, theme);
  }
  return new JColorDrawable();
});

export const loadDrawable = driven(function* loadDrawable$(res: Resources, resId: number, theme: JTheme | null): Gen<JDrawable> {
  if (!resId) return new JColorDrawable();
  const e = res.tbl(resId)?.entry(resId);
  if (!e) { rt.noteMissing("drawable 0x" + resId.toString(16)); return new JColorDrawable(); }
  if (e.value) {
    if (e.value.type === TV.STRING) {
      const f = res.fileOf(resId);
      if (!f) { rt.noteMissing("drawable file for 0x" + resId.toString(16)); return new JColorDrawable(); }
      return yield loadDrawableFile(res, f.path, f.bytes, theme, bitmapDensity(f.density));
    }
    if (e.value.type === TV.REFERENCE) return yield loadDrawable(res, e.value.data, theme);
    return yield loadDrawableRV(res, { t: e.value.type, d: e.value.data }, theme);
  }
  return new JColorDrawable();
});

/** `density` overrides the bitmap density its path's qualifier gives */
const loadDrawableFile = driven(function* loadDrawableFile(res: Resources, path: string, bytes: Uint8Array, theme: JTheme | null, density?: number): Gen<JDrawable> {
  if (path.endsWith(".xml")) {
    const root = parseAXML(bytes);
    noteCustomTags(root, () => after(newObj("android/content/res/XmlBlock", "([B)V", new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)),
      (block) => vcall(block, "newParser", "()Landroid/content/res/XmlResourceParser;")));
    return yield inflateDrawableNode(res, root, theme);
  }
  const bmp: JBitmap | null = yield decodeBytes(bytes, null);
  if (!bmp) return new JBitmapDrawable();
  bmp.density = density ?? densityOfPath(path);
  return drawableFromBitmap(bmp, device.densityDpi);
});

// ── ColorStateList loading (color/*.xml selectors)
// Keyed by theme as well as id: a Material colour selector is a list of `?attr/` items, so
// the same resource is a different list under every ThemeOverlay that reads it.
/** a colour attribute's value as a list: a reference loads its selector, a literal is one colour */
export function rvCsl(res: Resources, v: RV, theme: JTheme | null, dflt = 0): JColorStateList | Promise<JColorStateList> {
  return v.t === TV.REFERENCE ? loadColorStateList(res, v.d, theme) : mkCsl(rvColor(res, v, dflt));
}
const NO_THEME = {};
const cslCache = new WeakMap<object, Map<number, JColorStateList>>();
const loadColorStateList = driven(function* loadColorStateList$(res: Resources, resId: number, theme: JTheme | null): Gen<JColorStateList> {
  if (!resId) return mkCsl(0);
  const key = theme ?? NO_THEME;
  let byId = cslCache.get(key);
  if (!byId) cslCache.set(key, byId = new Map());
  const cached = byId.get(resId);
  if (cached) return cached;
  let out: JColorStateList;
  const e = res.tbl(resId)?.entry(resId);
  if (e?.value?.type === TV.STRING) {
    const f = res.fileOf(resId);
    out = f ? parseCslXml(res, f.bytes, theme) : mkCsl(-16777216);
  } else if (e?.value) {
    const v = res.resolveRefs({ t: e.value.type, d: e.value.data });
    if (v.t === TV.REFERENCE && v.d !== resId) return yield loadColorStateList(res, v.d, theme);
    out = mkCsl(rvColor(res, v, -16777216));
  } else out = mkCsl(-16777216);
  byId.set(resId, out);
  return out;
});
function parseCslXml(res: Resources, bytes: Uint8Array, theme: JTheme | null, depth = 0): JColorStateList {
  const root = parseAXML(bytes);
  const csl = new JColorStateList();
  for (const c of root.children) {
    if (c.name !== "item") continue;
    const states: number[] = [], neg: number[] = [];
    let color = -16777216, alphaMul = 1;
    // ColorStateList.inflate: color, alpha and lStar are the item's values, anything else a state
    for (const a of c.attrs) {
      if (a.name === "lStar" || !a.resId) continue;
      if (a.resId === AT.color) {
        let v: RV | null = xmlAttrRV(a);
        if (v.t === TV.ATTRIBUTE) v = theme?.lookup(v.d) ?? null;
        if (v && v.t === TV.REFERENCE) v = res.resolveRefs(v);
        // TypedArray.getColor on a nested selector answers with its default colour
        const nested = v?.t === TV.REFERENCE && v.s?.endsWith(".xml") && depth < 8 ? res.fileOf(v.d) : null;
        color = nested ? parseCslXml(res, nested.bytes, theme, depth + 1).defColor : rvColor(res, v, -16777216);
      } else if (a.resId === AT.alpha || a.name === "alpha") {
        alphaMul = Math.max(0, Math.min(1, rvFloat(res, resolveStyleValue(res, theme, xmlAttrRV(a)), 1)));
      } else (a.data ? states : neg).push(a.resId);
    }
    if (alphaMul < 1) color = (Math.round((color >>> 24) * alphaMul) << 24 | (color & 0xffffff)) | 0;
    csl.items.push({ states, negStates: neg, color });
  }
  csl.defColor = csl.items.find((i) => !i.states.length && !i.negStates.length)?.color ?? csl.items[0]?.color ?? -16777216;
  return csl;
}
