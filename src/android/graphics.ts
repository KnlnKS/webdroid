// android.graphics.* → HTML Canvas 2D. Colors are Java ARGB ints (signed).

import { type FaceMetrics, type NativeFont, SYSTEM_FONT, typefaceOf, fakery, FAKE_BOLD } from "./fonts";
import { rt, JObj, type NativeSpec, stubs, noops, driven, declaredField, type Gen } from "../jvm/runtime";
import { mangleMethod, jarray } from "../jvm/abi";
import { device } from "../shell/config";
import { deref, replace, weakHandle } from "./handles";
import { vcall, newObj, mkEnumSet, JSimpleEnum, linkInit, after, enumName, enumOrdinal } from "../jvm/natives/jlang";
import type { JLocale } from "../jvm/natives/jvalues";
import type { JLocaleList } from "./resnative";
import { NativeBitmap, ALPHA_8, PREMUL } from "./bitmap";
import type { Ctx2D } from "./recording";
import { perf } from "../perf";
import { parcelCreator } from "./parcelable";
import type { JParcel } from "./parcel";

const cssCache = new Map<number, string>();
export function cssColor(argb: number): string {
  let s = cssCache.get(argb);
  if (s === undefined) {
    if (cssCache.size >= 4096) cssCache.clear();
    cssCache.set(argb, s = `rgba(${(argb >> 16) & 0xff},${(argb >> 8) & 0xff},${argb & 0xff},${((argb >>> 24) / 255).toFixed(3)})`);
  }
  return s;
}

export class JRect extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
/** CREATOR for Rect, RectF, Point and PointF, whose platform <clinit> does not run under a spec:
 *  it reads the coordinates as ints or floats, in field order, as their readFromParcel does */
function geometryCreator(name: string, fields: string[], float: boolean) {
  const type = float ? "Float" : "Int", desc = float ? "F" : "I";
  const read = driven(function* readGeometry(o: Record<string, unknown>, p: JParcel): Gen {
    for (const f of fields) o[f] = yield vcall(p, `read${type}`, `()${desc}`);
    return o;
  });
  return { get CREATOR() { return parcelCreator(name, (p) => read(rt.make(name) as JObj & Record<string, unknown>, p)); } };
}
const RECT_FIELDS = ["left", "top", "right", "bottom"], POINT_FIELDS = ["x", "y"], PARCELABLE = ["android/os/Parcelable"];
// The geometry values keep only their layout, which our stack reads; every method is AOSP's.
rt.register({ name: "android/graphics/Rect", ctor: JRect, ifaces: PARCELABLE, fields: RECT_FIELDS, statics: geometryCreator("android/graphics/Rect", RECT_FIELDS, false) });
/** a RectF: its own class, since fallthrough would otherwise give it Rect's same-descriptor bodies */
export class JRectF extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
rt.register({ name: "android/graphics/RectF", ctor: JRectF, ifaces: PARCELABLE, fields: RECT_FIELDS, statics: geometryCreator("android/graphics/RectF", RECT_FIELDS, true) });
export class JPoint extends JObj { x = 0; y = 0; }
rt.register({ name: "android/graphics/Point", ctor: JPoint, ifaces: PARCELABLE, fields: POINT_FIELDS, statics: geometryCreator("android/graphics/Point", POINT_FIELDS, false) });
rt.register({ name: "android/graphics/PointF", ctor: class extends JObj { x = 0; y = 0; }, ifaces: PARCELABLE, fields: POINT_FIELDS, statics: geometryCreator("android/graphics/PointF", POINT_FIELDS, true) });

// android.graphics.Insets — immutable 4-sided inset value (WindowInsets.getInsets() etc).
export class JInsets extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
const INSETS_NONE = new JInsets();
/** Mirrors Insets.of(): the all-zero case returns the cached NONE singleton, like AOSP. */
export function insetsOf(l: number, t: number, r: number, b: number): JInsets {
  if (l === 0 && t === 0 && r === 0 && b === 0) return INSETS_NONE;
  const i = new JInsets(); i.left = l; i.top = t; i.right = r; i.bottom = b; return i;
}
rt.register({ name: "android/graphics/Insets", ctor: JInsets, fields: ["left", "top", "right", "bottom"], statics: { NONE: INSETS_NONE } });

/** Shader.getNativeInstance(boolean filterFromPaint), which a draw calls per shaded paint */
const SHADER_INSTANCE = mangleMethod("getNativeInstance", "(Z)J");
export class JPaint extends JObj {
  color = -16777216;
  renderAlpha: number | null = null;
  setColorValue(color: number) { this.color = color; this.renderAlpha = null; }
  setAlphaValue(alpha: number) {
    // API 33 exposes a narrowed alpha in getColor but draws out-of-range values opaque.
    this.color = ((((alpha < 0 ? alpha + 1 : alpha) & 255) << 24) | (this.color & 0xffffff)) | 0;
    this.renderAlpha = alpha < 0 || alpha > 255 ? 255 : null;
  }
  style = 0;
  strokeWidth = 0;
  shadowRadius = 0; shadowDx = 0; shadowDy = 0; shadowColor = 0;
  textSize = 12;
  /** the Java Typeface, null for the default (a bytecode Paint hands its native typeface) */
  tf: object | null = null;
  antiAlias = true;
  textAlignN = 0; // 0 left, 1 center, 2 right
  /** the Java Shader the paint spec was given, whose native instance `shader` is */
  shaderObj: object | null = null;
  shader: NativeShader | null = null;
  maskFilter: JBlurMaskFilter | null = null;
  strokeCapN: CanvasLineCap = "butt";
  strokeJoinN: CanvasLineJoin = "miter";
  dash: number[] | null = null;
  colorFilter: NativeColorFilter | null = null;
  filterObj: object | null = null;     // kept only so getColorFilter() round-trips
  /** the paint's Xfermode/BlendMode by BlendMode's name, and its Canvas2D form; null = plain source-over */
  blendName: string | null = null;
  blend: GlobalCompositeOperation | null = null;
  xfermode: object | null = null;      // kept only so getXfermode() round-trips
  blendMode: JSimpleEnum | null = null;
  setBlendName(name: string | null) { this.blendName = name; this.blend = name ? COMPOSITE[name] ?? null : null; }
  /** the shader to draw with. As AOSP's Paint.getNativeInstance does per draw, this asks the Java
   *  Shader for its current native instance: setLocalMatrix and the like replace it. If that call
   *  suspends (it would only on a contended monitor), the draw keeps the instance it had. */
  drawShader(): NativeShader | null {
    const s = this.shaderObj as Record<string, (filter: number) => bigint | Promise<bigint>> | null;
    if (s) {
      const h = s[SHADER_INSTANCE](1);
      if (typeof h === "bigint") this.shader = deref<NativeShader | undefined>(h) ?? null;
    }
    return this.shader;
  }
  compositeOp(): GlobalCompositeOperation | null {
    if (this.blend === "source-in" && !this.shader && !this.colorFilter && (this.renderAlpha ?? this.color >>> 24) === 255)
      return "source-atop";
    return this.blend;
  }
  transparentSourceIn(): boolean {
    return this.blend === "source-in" && (this.renderAlpha ?? this.color >>> 24) === 0 && !this.shader && !this.colorFilter;
  }
  pathEffect: unknown = null;
  letterSpacingEm = 0;
  textScaleX = 1;
  textSkewX = 0;
  fontFeatureSettings: string | null = null;
  fontVariationSettings: string | null = null;
  locales: JLocaleList | null = null;
  language = device.locale;
  underline = false; strikeThru = false; fakeBold = false; linearText = false; subpixelText = false;
  /** flag bits nothing here acts on, kept so getFlags() round-trips */
  otherFlags = 0;
  get flags(): number {
    return +this.antiAlias | (this.underline ? 8 : 0) | (this.strikeThru ? 0x10 : 0) | (this.fakeBold ? 0x20 : 0)
      | (this.linearText ? 0x40 : 0) | (this.subpixelText ? 0x80 : 0) | this.otherFlags;
  }
  set flags(f: number) {
    this.antiAlias = !!(f & 1); this.underline = !!(f & 8); this.strikeThru = !!(f & 0x10); this.fakeBold = !!(f & 0x20);
    this.linearText = !!(f & 0x40); this.subpixelText = !!(f & 0x80); this.otherFlags = f & ~0xf9;
  }
  bidiFlags = 2; hasCompatScaling = 0; compatScaling = 1; invCompatScaling = 1;
  get nativePaint(): bigint { return weakHandle(this); }

  // font() is called per text op and per measure; the result is a pure function of
  // (typeface identity, textSize, fakeBold), so cache it and rebuild only when one changes.
  private fCache = "";
  private fTf: object | null | undefined = undefined;
  private fSize = -1;
  private fBold = false;
  private fFace: NativeFont | null = null;
  private fFaked = false;
  font(): string {
    if (this.fTf === this.tf && this.fSize === this.textSize && this.fBold === this.fakeBold) return this.fCache;
    const t = typefaceOf(this.tf), w = this.fakeBold ? Math.max(700, t.weight) : t.weight;
    // minikin draws from the primary family's closest face, faking bold two grades short of the
    // wanted weight and italic on an upright face; the face's own weight makes CSS pick that face
    const face = t.collection.families[0]?.closest(w, t.italic) ?? null;
    const faked = face ? fakery(face, w, t.italic) : 0;
    this.fTf = this.tf; this.fSize = this.textSize; this.fBold = this.fakeBold;
    this.fFace = face; this.fFaked = faked !== 0;
    const weight = !face ? w : faked & FAKE_BOLD ? 700 : face.weight;
    return (this.fCache = `${t.italic ? "italic " : ""}${weight} ${this.textSize}px ${t.collection.css}, sans-serif`);
  }
  /** the face font() draws from, and whether it draws it with fake bold or italic */
  face(): NativeFont | null { this.font(); return this.fFace; }
  faked(): boolean { this.font(); return this.fFaked; }
  fillStyle(ctx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): string | CanvasGradient | CanvasPattern {
    const pattern = this.drawShader()?.pattern(ctx);
    if (pattern) return pattern;
    return cssColor(this.filteredColor());
  }
  /** the paint's colour through its colour filter */
  filteredColor(): number {
    const filter = this.colorFilter;
    const color = this.renderAlpha === null ? this.color : (this.renderAlpha << 24) | (this.color & 0xffffff);
    if (!filter) return color;
    if (filter.matrix) return matrixColor(filter.matrix, color);
    // PorterDuff/BlendMode SRC_IN — how Material tints every shape it draws: the filter's
    // colour replaces the paint's, keeping the alpha the two agree on
    const f = filter.color;
    return ((f & 0xffffff) | ((((f >>> 24) * (color >>> 24) / 255) | 0) << 24)) | 0;
  }
}
const paintMethods: NativeSpec["methods"] = {
  // AOSP's own bytecode hands a paint to its native half as a long — MeasuredText.Builder and
  // every Canvas draw do it — so a paint that is OURS still has to be able to name itself in
  // the handle table. handles.ts is stable per object, so this is not an allocation per call,
  // and weak, since no finalizer would release a paint drawn with once.
  "getNativeInstance()J": function (this: JPaint) { return weakHandle(this); },
  // The hyphen a line break may add or remove at either end. There is no hyphenator here, so
  // there is never an edit; AOSP's MeasuredText reads these back per run whatever the answer.
  "getStartHyphenEdit()I": () => 0, "getEndHyphenEdit()I": () => 0,
  "<init>(Landroid/graphics/Paint;)V": function (this: JPaint, o: JPaint) { if (o) copyPaint(o, this); },
  "reset()V": function (this: JPaint) { copyPaint(defaultPaint, this); },
  "setShadowLayer(FFFI)V": function (this: JPaint, radius: number, dx: number, dy: number, color: number) {
    this.shadowRadius = radius; this.shadowDx = dx; this.shadowDy = dy; this.shadowColor = color;
  },
  "clearShadowLayer()V": function (this: JPaint) { this.shadowRadius = this.shadowDx = this.shadowDy = this.shadowColor = 0; },
  "hasShadowLayer()Z": function (this: JPaint) { return +(this.shadowRadius > 0 && !!(this.shadowColor >>> 24)); },
  "getShadowLayerRadius()F": function (this: JPaint) { return this.shadowRadius; },
  "getShadowLayerDx()F": function (this: JPaint) { return this.shadowDx; },
  "getShadowLayerDy()F": function (this: JPaint) { return this.shadowDy; },
  "getShadowLayerColor()I": function (this: JPaint) { return this.shadowColor; },
  "set(Landroid/graphics/Paint;)V": function (this: JPaint, o: JPaint) { copyPaint(o, this); },
  "setColor(I)V": function (this: JPaint, c: number) { this.setColorValue(c); },
  "setColor(J)V": function (this: JPaint, c: bigint) { this.setColorValue(argbOfColorLong(c)); },
  "getColorLong()J": function (this: JPaint) { return colorLongOfArgb(this.color); },
  "getTextLocale()Ljava/util/Locale;": function (this: JPaint) {
    return after(vcall(this, "getTextLocales", "()Landroid/os/LocaleList;"), (locales: JLocaleList) => locales.values[0] ?? null);
  },
  "getTextLocales()Landroid/os/LocaleList;": driven(function* (this: JPaint): Gen { return this.locales ??= yield vcall((yield linkInit("android/os/LocaleList")).ctor, "getDefault", "()Landroid/os/LocaleList;"); }),
  "setTextLocale(Ljava/util/Locale;)V": function (this: JPaint, locale: JLocale) {
    if (!locale) throw rt.mkThrowable("java/lang/IllegalArgumentException", "locale cannot be null");
    return after(newObj("android/os/LocaleList", "([Ljava/util/Locale;)V", jarray([locale], "Ljava/util/Locale;")),
      (locales: JLocaleList) => { this.locales = locales; this.language = locales.tags[0]; });
  },
  "setTextLocales(Landroid/os/LocaleList;)V": function (this: JPaint, locales: JLocaleList) {
    if (!locales?.values.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "locales cannot be null or empty");
    this.locales = locales; this.language = locales.tags[0];
  },
  "getShader()Landroid/graphics/Shader;": function (this: JPaint) { return this.shaderObj; },
  "getStrokeMiter()F": () => 4,
  "getXfermode()Landroid/graphics/Xfermode;": function (this: JPaint) { return this.xfermode; },
  "setBlendMode(Landroid/graphics/BlendMode;)V": function (this: JPaint, m: JSimpleEnum | null) {
    this.blendMode = m;
    this.setBlendName(m && enumName(m));
  },
  "getBlendMode()Landroid/graphics/BlendMode;": function (this: JPaint) { return this.blendMode; },
  "getMaskFilter()Landroid/graphics/MaskFilter;": function (this: JPaint) { return this.maskFilter; },
  "setMaskFilter(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;": function (this: JPaint, f: JBlurMaskFilter | null) { return this.maskFilter = f; },
  "getColor()I": function (this: JPaint) { return this.color; },
  "setAlpha(I)V": function (this: JPaint, a: number) { this.setAlphaValue(a); },
  "setARGB(IIII)V": function (this: JPaint, a: number, r: number, g: number, b: number) { this.setColorValue(((a & 255) << 24 | (r & 255) << 16 | (g & 255) << 8 | (b & 255)) | 0); },
  "getAlpha()I": function (this: JPaint) { return this.color >>> 24; },
  "setStyle(Landroid/graphics/Paint$Style;)V": function (this: JPaint, s: JSimpleEnum | null) { this.style = s ? enumOrdinal(s) : 0; },
  "getStyle()Landroid/graphics/Paint$Style;": function (this: JPaint) { return paintStyleEnum[this.style]; },
  "setStrokeWidth(F)V": function (this: JPaint, w: number) { this.strokeWidth = w; },
  "getStrokeWidth()F": function (this: JPaint) { return this.strokeWidth; },
  "setTextSize(F)V": function (this: JPaint, s: number) { if (s >= 0) this.textSize = s; },
  "getTextSize()F": function (this: JPaint) { return this.textSize; },
  "setAntiAlias(Z)V": function (this: JPaint, v: number) { this.antiAlias = !!v; },
  "isAntiAlias()Z": function (this: JPaint) { return this.antiAlias ? 1 : 0; },
  "setTypeface(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;": function (this: JPaint, t: object | null) { return this.tf = t; },
  "getTypeface()Landroid/graphics/Typeface;": function (this: JPaint) { return this.tf; },
  "setTextAlign(Landroid/graphics/Paint$Align;)V": function (this: JPaint, a: JSimpleEnum | null) { this.textAlignN = a ? enumOrdinal(a) : 0; },
  "getTextAlign()Landroid/graphics/Paint$Align;": function (this: JPaint) { return paintAlignEnum[this.textAlignN]; },
  "setStrokeCap(Landroid/graphics/Paint$Cap;)V": function (this: JPaint, c: JSimpleEnum | null) { this.strokeCapN = CAPS[c ? enumOrdinal(c) : 0]; },
  "setStrokeJoin(Landroid/graphics/Paint$Join;)V": function (this: JPaint, j: JSimpleEnum | null) { this.strokeJoinN = JOINS[j ? enumOrdinal(j) : 0]; },
  "getStrokeCap()Landroid/graphics/Paint$Cap;": function (this: JPaint) { return paintCapEnum[CAPS.indexOf(this.strokeCapN)]; },
  "getStrokeJoin()Landroid/graphics/Paint$Join;": function (this: JPaint) { return paintJoinEnum[JOINS.indexOf(this.strokeJoinN)]; },
  "setShader(Landroid/graphics/Shader;)Landroid/graphics/Shader;": function (this: JPaint, s: object | null) {
    this.shaderObj = s ?? null;
    if (!s) { this.shader = null; return s; }
    return after(vcall(s, "getNativeInstance", "(Z)J", 1), (h: bigint) => { this.shader = deref<NativeShader | undefined>(h) ?? null; return s; });
  },
  "setPathEffect(Landroid/graphics/PathEffect;)Landroid/graphics/PathEffect;": function (this: JPaint, e: any) {
    this.pathEffect = e ?? null;
    this.dash = e?.intervals ?? null;
    return e;
  },
  "getPathEffect()Landroid/graphics/PathEffect;": function (this: JPaint) { return this.pathEffect; },
  "getLetterSpacing()F": function (this: JPaint) { return this.letterSpacingEm; },
  "setColorFilter(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;": function (this: JPaint, f: object | null) {
    this.filterObj = f ?? null;
    return after(colorFilterOf(f), (filter) => { this.colorFilter = filter; return f; });
  },
  "getColorFilter()Landroid/graphics/ColorFilter;": function (this: JPaint) { return this.filterObj; },
  "setXfermode(Landroid/graphics/Xfermode;)Landroid/graphics/Xfermode;": function (this: JPaint, x: object | null) {
    this.xfermode = x;
    this.setBlendName(x && xfermodeName(x));
    return x;
  },
  "setUnderlineText(Z)V": function (this: JPaint, v: number) { this.underline = !!v; },
  "setStrikeThruText(Z)V": function (this: JPaint, v: number) { this.strikeThru = !!v; },
  "setFakeBoldText(Z)V": function (this: JPaint, v: number) { this.fakeBold = !!v; },
  "setLetterSpacing(F)V": function (this: JPaint, v: number) { this.letterSpacingEm = v; },
  "setFontFeatureSettings(Ljava/lang/String;)V": function (this: JPaint, v: string | null) { this.fontFeatureSettings = v; },
  "getFontFeatureSettings()Ljava/lang/String;": function (this: JPaint) { return this.fontFeatureSettings; },
  "setFontVariationSettings(Ljava/lang/String;)Z": function (this: JPaint, v: string | null) {
    this.fontVariationSettings = v || null;
    return 1;
  },
  "getFontVariationSettings()Ljava/lang/String;": function (this: JPaint) { return this.fontVariationSettings; },
  "setTextScaleX(F)V": function (this: JPaint, v: number) { this.textScaleX = v; },
  "getTextScaleX()F": function (this: JPaint) { return this.textScaleX; },
  "setTextSkewX(F)V": function (this: JPaint, v: number) { this.textSkewX = v; },
  "getTextSkewX()F": function (this: JPaint) { return this.textSkewX; },

  "<init>(I)V": function (this: JPaint, f: number) { this.flags = f; },
  "setFlags(I)V": function (this: JPaint, f: number) { this.flags = f; },
  "getFlags()I": function (this: JPaint) { return this.flags; },
  "setSubpixelText(Z)V": function (this: JPaint, v: number) { this.subpixelText = !!v; },
  "isSubpixelText()Z": function (this: JPaint) { return +this.subpixelText; },
  "setLinearText(Z)V": function (this: JPaint, v: number) { this.linearText = !!v; },
  "isLinearText()Z": function (this: JPaint) { return +this.linearText; },
  ...noops("<init>()V", "setHinting(I)V",
    "setElegantTextHeight(Z)V", "setStartHyphenEdit(I)V",
    "setEndHyphenEdit(I)V", "setWordSpacing(F)V", "setDither(Z)V", "setFilterBitmap(Z)V", "setStrokeMiter(F)V"),
  ...stubs(1, "isFilterBitmap()Z", "getHinting()I"),
  ...stubs(0, "getWordSpacing()F", "isDither()Z"),
  "getFontMetrics()Landroid/graphics/Paint$FontMetrics;": function (this: JPaint) {
    const fm = new JFontMetrics();
    fillFontMetrics(this, fm, false);
    return fm;
  },
  "getFontMetrics(Landroid/graphics/Paint$FontMetrics;)F": function (this: JPaint, fm: JFontMetrics | null) {
    return fillFontMetrics(this, fm, false);
  },
  "getFontMetricsInt()Landroid/graphics/Paint$FontMetricsInt;": function (this: JPaint) {
    const fm = new JFontMetricsInt();
    fillFontMetrics(this, fm, true);
    return fm;
  },
  "getFontMetricsInt(Landroid/graphics/Paint$FontMetricsInt;)I": function (this: JPaint, fm: JFontMetricsInt | null) {
    return fillFontMetrics(this, fm, true);
  },
  "getFontSpacing()F": function (this: JPaint) { return fontDescent(this) - fontAscent(this); },
  "ascent()F": function (this: JPaint) { return fontAscent(this); },
  "descent()F": function (this: JPaint) { return fontDescent(this); },
};
/** a Paint as constructed; read-only, the source for reset() and the null bitmap paint */
export const defaultPaint = new JPaint();
export function beginPaintShadow(ctx: Ctx2D, p: JPaint): boolean {
  if (!(p.shadowRadius > 0) || !(p.shadowColor >>> 24)) return false;
  const m = ctx.getTransform();
  ctx.save();
  ctx.shadowColor = cssColor(p.shadowColor);
  ctx.shadowBlur = p.shadowRadius * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  ctx.shadowOffsetX = m.a * p.shadowDx + m.c * p.shadowDy;
  ctx.shadowOffsetY = m.b * p.shadowDx + m.d * p.shadowDy;
  return true;
}
/** The shadow a shape casts, without the shape: it is filled far to the side and its shadow
 *  offset back, since a canvas shadow takes its opacity from the fill's. `dy` is in user space. */
export function castShadow(ctx: Ctx2D, trace: () => void, color: string, blur: number, dy: number) {
  const m = ctx.getTransform(), far = 1 << 16;
  ctx.save();
  ctx.translate(-far, 0);
  ctx.shadowColor = color; ctx.shadowBlur = blur;
  ctx.shadowOffsetX = m.a * far; ctx.shadowOffsetY = m.b * far + m.d * dy;
  ctx.fillStyle = "#000";
  ctx.beginPath(); trace(); ctx.fill();
  ctx.restore();
}
export function copyPaint(src: JPaint, dst: JPaint) {
  dst.color = src.color; dst.renderAlpha = src.renderAlpha; dst.style = src.style; dst.strokeWidth = src.strokeWidth;
  dst.textSize = src.textSize; dst.tf = src.tf;
  dst.textAlignN = src.textAlignN; dst.shaderObj = src.shaderObj; dst.shader = src.shader; dst.dash = src.dash;
  dst.maskFilter = src.maskFilter; dst.strokeCapN = src.strokeCapN; dst.strokeJoinN = src.strokeJoinN;
  dst.colorFilter = src.colorFilter; dst.filterObj = src.filterObj;
  dst.flags = src.flags;
  dst.letterSpacingEm = src.letterSpacingEm; dst.textScaleX = src.textScaleX; dst.textSkewX = src.textSkewX;
  dst.fontFeatureSettings = src.fontFeatureSettings;
  dst.fontVariationSettings = src.fontVariationSettings;
  dst.locales = src.locales; dst.language = src.language;
  dst.blendName = src.blendName; dst.blend = src.blend; dst.xfermode = src.xfermode; dst.blendMode = src.blendMode;
  dst.shadowRadius = src.shadowRadius; dst.shadowDx = src.shadowDx; dst.shadowDy = src.shadowDy; dst.shadowColor = src.shadowColor;
}
class JFontMetrics extends JObj { top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; }
class JFontMetricsInt extends JObj { top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; }
for (const [name, ctor] of [["FontMetrics", JFontMetrics], ["FontMetricsInt", JFontMetricsInt]] as const) {
  rt.register({ name: `android/graphics/Paint$${name}`, ctor, fields: ["top", "ascent", "descent", "bottom", "leading"], methods: { "<init>()V": function () {} } });
}
let _measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
/**
 * The shared measurement context. ALWAYS pass the font you are about to measure with:
 * setFont elides a redundant assignment by remembering what it last wrote, so a caller that
 * assigns ctx.font itself leaves that memo naming a font the context no longer has — and the
 * next cache miss then measures with the wrong one.
 */
export function measureCtx(font?: string, language = "en-US"): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : (document.createElement("canvas"));
    _measureCtx = c.getContext("2d") as CanvasRenderingContext2D;
  }
  if (font !== undefined) setFont(_measureCtx, font);
  if ("lang" in _measureCtx && _measureCtx.lang !== language) _measureCtx.lang = language;
  return _measureCtx;
}
// Browser text measurement is the hot path of every layout AND every draw (a TextView
// measures, wraps, then re-wraps to draw). Width is a pure function of (font, string) and
// the vertical metrics of (font) alone, so both are memoised. The width cache is capped and
// cleared wholesale rather than evicted per entry — line breaking probes many short-lived
// prefixes, so LRU bookkeeping would cost more than the refill.
const WIDTH_CACHE_MAX = 20000;
let widthCache = new Map<string, Map<string, number>>(), widthCount = 0;
const vmetCache = new Map<string, { a: number; d: number }>();
let lastFont = "";
function setFont(ctx: { font: string }, f: string): void {
  if (f !== lastFont) { ctx.font = f; lastFont = f; }
}
/** the advance of `s` in CSS font `f`, before letter spacing */
export function rawWidth(f: string, s: string, language: string): number {
  const key = language === "en-US" ? f : f + "\0" + language;
  let byFont = widthCache.get(key);
  if (byFont === undefined) widthCache.set(key, byFont = new Map());
  const hit = byFont.get(s);
  if (hit !== undefined) return hit;
  perf.measureTextMiss++;
  const w = measureCtx(f, language).measureText(s).width;
  if (++widthCount > WIDTH_CACHE_MAX) { widthCache = new Map([[key, byFont = new Map()]]); widthCount = 1; }
  byFont.set(s, w);
  return w;
}
export function measureText(p: JPaint, s: string): number {
  perf.measureText++;
  return Math.fround(rawWidth(p.font(), s, p.language) + p.letterSpacingEm * p.textSize * s.length);
}
/** Android Paint retains fractional hhea ascent/descent and uses head.yMax/yMin for bounds; the
 *  metrics are the drawn face's. Browser bounding-box metrics round to pixels even with FontFace
 *  metric overrides. */
const metricsOf = (p: JPaint): FaceMetrics | null => p.face()?.faceMetrics ?? null;
function vmetrics(p: JPaint): { a: number; d: number } {
  const f = p.font();
  const hit = vmetCache.get(f);
  if (hit) return hit;
  const face = metricsOf(p);
  if (face) {
    const v = { a: -p.textSize * face.ascent, d: p.textSize * face.descent };
    vmetCache.set(f, v);
    return v;
  }
  const ctx = measureCtx(f);
  const m = ctx.measureText("Ag");
  const v = {
    a: -(m.fontBoundingBoxAscent ?? p.textSize * SYSTEM_FONT.ascent),
    d: m.fontBoundingBoxDescent ?? p.textSize * SYSTEM_FONT.descent,
  };
  vmetCache.set(f, v);
  return v;
}
export function fontAscent(p: JPaint): number { return vmetrics(p).a; }
export function fontDescent(p: JPaint): number { return vmetrics(p).d; }
export function fontTop(p: JPaint): number { const m = metricsOf(p) ?? SYSTEM_FONT; return Math.fround(vmetrics(p).a * (m.top / m.ascent)); }
export function fontBottom(p: JPaint): number { const m = metricsOf(p) ?? SYSTEM_FONT; return Math.fround(vmetrics(p).d * (m.bottom / m.descent)); }
export function fillFontMetrics(p: JPaint, fm: { top: number; ascent: number; descent: number; bottom: number; leading: number } | null, int: boolean) {
  const { a, d } = vmetrics(p);
  const ascent = int ? Math.round(a) : a, descent = int ? Math.round(d) : d;
  if (fm) {
    // fontTop/fontBottom, without resolving the paint's metrics twice more
    const m = metricsOf(p) ?? SYSTEM_FONT;
    const top = Math.fround(a * (m.top / m.ascent)), bottom = Math.fround(d * (m.bottom / m.descent));
    fm.ascent = ascent; fm.descent = descent;
    fm.top = int ? Math.floor(top) : top;
    fm.bottom = int ? Math.ceil(bottom) : bottom;
    fm.leading = 0;
  }
  return descent - ascent;
}

const paintStyleEnum = mkEnumSet("android/graphics/Paint$Style", ["FILL", "STROKE", "FILL_AND_STROKE"]);
const paintAlignEnum = mkEnumSet("android/graphics/Paint$Align", ["LEFT", "CENTER", "RIGHT"]);
const paintCapEnum = mkEnumSet("android/graphics/Paint$Cap", ["BUTT", "ROUND", "SQUARE"]);
const paintJoinEnum = mkEnumSet("android/graphics/Paint$Join", ["MITER", "ROUND", "BEVEL"]);
/**
 * A blend mode, by BlendMode's name, → the Canvas2D composite operation with the same meaning;
 * modes Canvas2D cannot express are absent and fall back to plain source-over.
 * CLEAR maps to destination-out, which clears only where the source is opaque: prep() fills a
 * CLEAR shape opaquely, since Skia's CLEAR ignores the paint's colour (Compose punches holes with a
 * transparent one).
 */
export const COMPOSITE: Record<string, GlobalCompositeOperation> = {
  CLEAR: "destination-out", SRC: "copy", SRC_OVER: "source-over", DST_OVER: "destination-over",
  SRC_IN: "source-in", DST_IN: "destination-in", SRC_OUT: "source-out", DST_OUT: "destination-out",
  SRC_ATOP: "source-atop", DST_ATOP: "destination-atop", XOR: "xor", PLUS: "lighter",
  MODULATE: "multiply", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay",
  DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference",
  EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};
/** SkBlendMode by value, in BlendMode's names: PorterDuff.Mode.nativeInt, Xfermode.porterDuffMode
 *  and the ColorFilter and ComposeShader natives all number modes this way */
export const BLEND_MODES = ["CLEAR", "SRC", "DST", "SRC_OVER", "DST_OVER", "SRC_IN", "DST_IN", "SRC_OUT", "DST_OUT",
  "SRC_ATOP", "DST_ATOP", "XOR", "PLUS", "MODULATE", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN",
  "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT", "SOFT_LIGHT", "DIFFERENCE", "EXCLUSION", "MULTIPLY",
  "HUE", "SATURATION", "COLOR", "LUMINOSITY"];
/** PorterDuff.Mode's, BlendMode's or Region.Op's constant `name`, once the (bytecode) enum has initialized */
export function modeConstant(cls: "android/graphics/PorterDuff$Mode" | "android/graphics/BlendMode" | "android/graphics/Region$Op", name: string): unknown {
  const info = rt.link(cls);
  return after(rt.initClass(info), () => (info.ctor as unknown as Record<string, unknown>)["s$" + name]);
}
let porterDuffMode = "";
/** the mode a Java Xfermode names */
const xfermodeName = (x: object) =>
  BLEND_MODES[(x as Record<string, number>)[porterDuffMode ||= declaredField("android/graphics/Xfermode", "porterDuffMode")]];
/**
 * A ColorFilter's native instance, as hwui builds its SkColorFilter: AOSP's row-major 4x5 colour
 * `matrix` with its offsets in 0..255 (SkColorFilters::Matrix and Lighting), or, when that is null,
 * `color` blended into what is drawn by the mode named `mode` (SkColorFilters::Blend).
 * The Lighting and ColorMatrix setters update `matrix` in place, and a paint holding it sees them.
 */
export class NativeColorFilter {
  constructor(readonly matrix: Float32Array | null, readonly color = 0, readonly mode = "DST") {}
}
/** the native instance behind a Java ColorFilter: null for none, and for a base ColorFilter */
export const colorFilterOf = (f: object | null): NativeColorFilter | null | Promise<NativeColorFilter | null> =>
  f && after(vcall(f, "getNativeInstance", "()J"), (h: bigint) => deref<NativeColorFilter | undefined>(h) ?? null);
rt.register({
  name: "android/graphics/DashPathEffect", ctor: class extends JObj { intervals: number[] = []; }, sup: "android/graphics/PathEffect",
  methods: {
    "<init>([FF)V": function (this: any, iv: Float32Array) { this.intervals = [...iv]; },
  },
});
rt.markers("android/graphics/PathEffect");
rt.register({ name: "android/graphics/CornerPathEffect", ctor: class extends JObj {}, sup: "android/graphics/PathEffect",
  methods: { "<init>(F)V": function () {} } });
mkEnumSet("android/graphics/BlurMaskFilter$Blur", ["NORMAL", "SOLID", "OUTER", "INNER"]);
export class JBlurMaskFilter extends JObj {
  sigma = 0; style = 0;
  border() {
    const sigma = Math.min(this.sigma, 135);
    if (sigma >= 2) {
      const window = Math.max(1, Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5));
      return window % 2 ? 3 * (window - 1) / 2 : 3 * window / 2 - 1;
    }
    const variance = sigma * sigma, q = variance * variance / 4;
    const bessel = (n: number) => {
      let term = n ? variance / 2 : 1, sum = term;
      for (let k = 1; term > 1e-6; k++) { term *= q / (k * (k + n)); sum += term; }
      return sum;
    };
    let previous = bessel(0), current = bessel(1), n = 1;
    while (current / Math.exp(variance) > 0.01) {
      const next = previous - 2 * n / variance * current;
      previous = current; current = next; n++;
    }
    return n - 1;
  }
}
export function blurMask(ctx: Ctx2D, source: CanvasImageSource, filter: JBlurMaskFilter | null, x = 0, y = 0, scale = 1) {
  if (filter) ctx.filter = `blur(${Math.min(filter.sigma * scale, 135)}px)`;
  ctx.drawImage(source, x, y); ctx.filter = "none";
  if (filter?.style) {
    ctx.globalCompositeOperation = filter.style === 2 ? "destination-out" : filter.style === 3 ? "destination-in" : "source-over";
    ctx.drawImage(source, x, y);
    ctx.globalCompositeOperation = "source-over";
  }
}
rt.markers("android/graphics/MaskFilter");
rt.register({
  name: "android/graphics/BlurMaskFilter", ctor: JBlurMaskFilter, sup: "android/graphics/MaskFilter",
  methods: {
    "<init>(FLandroid/graphics/BlurMaskFilter$Blur;)V": function (this: JBlurMaskFilter, radius: number, style: JSimpleEnum) {
      if (!(radius > 0)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "radius must be > 0");
      this.style = enumOrdinal(style);
      this.sigma = radius * 0.57735 + 0.5;
    },
  },
});

export type Affine = [number, number, number, number, number, number];
/** a native shader's local matrix: the 3x3 behind the handle Shader passes, null for identity */
export function localMatrix(h: bigint): Affine | null {
  const m = deref<Mat | undefined>(h);
  return m && !isIdentity(m) ? affineOf(m) : null;
}
/**
 * A Shader's native instance: what it paints, under the local matrix it was created with (null
 * for identity). It never changes; Shader discards it and makes another when the Java side does.
 */
export class NativeShader {
  constructor(readonly local: Affine | null) {}
  pattern(_ctx?: Ctx2D): CanvasGradient | CanvasPattern | null { return null; }
  deferredPattern(): ((ctx: Ctx2D) => CanvasPattern) | null { return null; }
}
export const shaderIdentity: Affine = [1, 0, 0, 1, 0, 0];
const bitmapShaderTiles = new WeakMap<NativeBitmap, { generation: number; tiles: Map<string, CanvasPattern> }>();
/** tileX/tileY: Shader.TileMode's nativeInt (CLAMP, REPEAT, MIRROR, DECAL) */
export class NativeBitmapShader extends NativeShader {
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  constructor(local: Affine | null, readonly bitmap: NativeBitmap, readonly tileX: number, readonly tileY: number) { super(local); }
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    const bitmap = this.bitmap;
    let cache = bitmapShaderTiles.get(bitmap);
    if (!cache || cache.generation !== bitmap.genId) {
      cache = { generation: bitmap.genId, tiles: new Map() };
      bitmapShaderTiles.set(bitmap, cache);
    }
    const bounds = canvasLocalBounds(ctx);
    if (!bounds) return;
    const segments = (mode: number, size: number, lo: number, hi: number): [number, number, number, number][] => {
      if (mode === 1 || mode === 2) return [[lo, hi, 0, size]];
      const result: [number, number, number, number][] = [[Math.max(0, lo), Math.min(size, hi), 0, size]];
      if (mode === 0) result.push([lo, Math.min(0, hi), 0, 1], [Math.max(size, lo), hi, size - 1, 1]);
      return result;
    };
    const xs = segments(this.tileX, bitmap.w, bounds[0], bounds[2]);
    const ys = segments(this.tileY, bitmap.h, bounds[1], bounds[3]);
    for (const [x0, x1, sx, sw] of xs) for (const [y0, y1, sy, sh] of ys) {
      if (x1 <= x0 || y1 <= y0) continue;
      const nx = this.tileX === 2 ? 2 : 1, ny = this.tileY === 2 ? 2 : 1;
      const key = `${sx},${sy},${sw},${sh},${nx},${ny}`;
      let pattern = cache.tiles.get(key);
      if (!pattern) {
        let tile = bitmap.image;
        if (sx !== 0 || sy !== 0 || sw !== bitmap.w || sh !== bitmap.h || nx !== 1 || ny !== 1) {
          tile = new OffscreenCanvas(sw * nx, sh * ny);
          const c = tile.getContext("2d")!;
          for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
            c.setTransform(x ? -1 : 1, 0, 0, y ? -1 : 1, x ? sw * 2 : 0, y ? sh * 2 : 0);
            c.drawImage(bitmap.image, sx, sy, sw, sh, 0, 0, sw, sh);
          }
        }
        pattern = ctx.createPattern(tile, "repeat")!;
        cache.tiles.set(key, pattern);
      }
      ctx.fillStyle = pattern;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  override pattern(ctx?: Ctx2D): CanvasPattern | null {
    if (!ctx) return null;
    const matrix = ctx.getTransform(), local = this.local;
    const key = `${this.bitmap.genId}:${ctx.canvas.width},${ctx.canvas.height}:${matrix.toString()}:${local}`;
    if (this.cached && key === this.cacheKey) return this.cached;
    // Strokes and text cannot clip a Canvas2D path to its stroked outline.
    const surface = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height), c = surface.getContext("2d")!;
    c.setTransform(matrix);
    if (local) c.transform(...local);
    this.draw(c);
    const pattern = ctx.createPattern(surface, "no-repeat")!;
    pattern.setTransform(matrix.inverse());
    this.cacheKey = key;
    return this.cached = pattern;
  }
}
/** fills everything `c` can show with `s`; a pattern shader applies its own local matrix */
function fillWithShader(c: OffscreenCanvasRenderingContext2D, s: NativeShader) {
  const style = s.pattern(c);
  if (!style) return;
  if (s.local && style instanceof CanvasGradient) c.transform(...s.local);
  const bounds = canvasLocalBounds(c);
  if (!bounds) return;
  c.fillStyle = style;
  c.fillRect(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]);
}
/** ComposeShader: `src` blended onto `dst` by the mode, rasterized over the target once per transform */
export class NativeComposeShader extends NativeShader {
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  /** `op` is null for DST, which keeps the destination shader alone */
  constructor(local: Affine | null, readonly dst: NativeShader, readonly src: NativeShader, readonly op: GlobalCompositeOperation | null) { super(local); }
  override pattern(ctx?: Ctx2D): CanvasPattern | null {
    if (!ctx) return null;
    const matrix = ctx.getTransform(), { width, height } = ctx.canvas;
    const key = `${width},${height}:${matrix.toString()}:${this.local}`;
    if (this.cached && key === this.cacheKey) return this.cached;
    const c = new OffscreenCanvas(width, height).getContext("2d")!;
    const base = this.local ? matrix.multiply(new DOMMatrix(this.local)) : matrix;
    c.setTransform(base);
    fillWithShader(c, this.dst);
    if (this.op) {
      c.setTransform(base);
      c.globalCompositeOperation = this.op;
      fillWithShader(c, this.src);
    }
    const pattern = ctx.createPattern(c.canvas, "no-repeat")!;
    pattern.setTransform(matrix.inverse());
    this.cacheKey = key;
    return this.cached = pattern;
  }
}
/** a ComposeShader's native instance: `src` over `dst` by the SkBlendMode numbered `mode` */
export const composeShader = (local: Affine | null, dst: NativeShader, src: NativeShader, mode: number) =>
  new NativeComposeShader(local, dst, src, mode === 2 ? null : COMPOSITE[BLEND_MODES[mode]] ?? "source-over");
export class NativeGradient extends NativeShader {
  constructor(local: Affine | null, readonly grad: CanvasGradient) { super(local); }
  override pattern(): CanvasGradient { return this.grad; }
}
/** a gradient's native instance: its ColorLongs at `positions` (evenly spaced when null), which
 *  SkGradientShader pins to [0, 1] and to no less than the position before */
export function gradient(local: Affine | null, g: CanvasGradient, colors: BigInt64Array, positions: Float32Array | null): NativeGradient {
  for (let i = 0, prev = 0; i < colors.length; i++) {
    const at = positions ? prev = Math.min(Math.max(positions[i], prev), 1) : i / (colors.length - 1);
    g.addColorStop(at, cssColor(argbOfColorLong(colors[i])));
  }
  return new NativeGradient(local, g);
}
/**
 * A ColorLong is Color.pack()'s encoding: the sRGB case (colour-space id 0, the only one this
 * canvas has) is the ARGB int in the top 32 bits, which is what getColorLong writes.
 */
export const argbOfColorLong = (v: bigint) => Number(BigInt.asUintN(32, v >> 32n)) | 0;
export const colorLongOfArgb = (c: number) => BigInt.asIntN(64, BigInt(c >>> 0) << 32n);

// ── Matrix: AOSP's bytecode over the natives in delegates.ts. native_instance is a handle to a
// row-major 3x3 (MSCALE_X, MSKEW_X, MTRANS_X, MSKEW_Y, MSCALE_Y, MTRANS_Y, MPERSP_0..2) that the
// natives update in place, so TS state can share one with a Java Matrix. A 2D context holds only
// the affine part: [a, b, c, d, e, f] = [M0, M3, M1, M4, M2, M5].
export type Mat = Float64Array;
export const identity = (): Mat => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
/** read-only: a source to copy from */
export const IDENTITY = identity();
export function mul(a: Mat, b: Mat): Mat {
  const o = new Float64Array(9);
  for (let r = 0; r < 9; r += 3) {
    for (let c = 0; c < 3; c++) o[r + c] = a[r] * b[c] + a[r + 1] * b[3 + c] + a[r + 2] * b[6 + c];
  }
  return o;
}
export const translateM = (dx: number, dy: number): Mat => Float64Array.of(1, 0, dx, 0, 1, dy, 0, 0, 1);
export const scaleM = (sx: number, sy: number): Mat => Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, 1);
export const skewM = (kx: number, ky: number): Mat => Float64Array.of(1, kx, 0, ky, 1, 0, 0, 0, 1);
export const sinCosM = (s: number, c: number): Mat => Float64Array.of(c, -s, 0, s, c, 0, 0, 0, 1);
/** SkMatrix::setRotate snaps a sine or cosine within SK_ScalarNearlyZero to 0, so quarter turns stay exact */
const snap = (v: number) => (Math.abs(v) <= 1 / 4096 ? 0 : v);
export const rotateM = (deg: number): Mat => { const r = deg * Math.PI / 180; return sinCosM(snap(Math.sin(r)), snap(Math.cos(r))); };
/** the same transform taken about (px, py) rather than the origin */
export const about = (m: Mat, px: number, py: number): Mat => mul(translateM(px, py), mul(m, translateM(-px, -py)));
export function invert(m: Mat): Mat | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  // SkMatrix::invert: a determinant within SK_ScalarNearlyZero cubed is singular
  if (!(Math.abs(det) > 1 / 4096 ** 3)) return null;
  return Float64Array.of(
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  );
}
/** SkMatrix's point mapping: a point at w = 0 maps to the origin */
export function mapPoint(m: Mat, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  const k = w === 1 ? 1 : w ? 1 / w : 0;
  return [(m[0] * x + m[1] * y + m[2]) * k, (m[3] * x + m[4] * y + m[5]) * k];
}
export const isIdentity = (m: Mat) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1;

let nativeInstance = "";
const instanceOf = (m: object) => (m as Record<string, bigint>)[nativeInstance ||= declaredField("android/graphics/Matrix", "native_instance")];
/** the 3x3 behind a Java Matrix */
export const matrixOf = (m: object): Mat => deref<Mat>(instanceOf(m));
/** a new Java Matrix over `mat` itself: writes on either side are seen by the other */
export const javaMatrix = (mat: Mat): unknown => after(newObj("android/graphics/Matrix", "()V"), (m: object) => { replace(instanceOf(m), mat); return m; });
// A stack of 4x4 transforms (SkM44, row-major, float) viewed by SkCamera3D, whose location is
// in inches (72 points each) and whose observer sits on the view axis at the location's depth.
export class Camera3D {
  stack = [Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)];
  location = [0, 0, -576];
  get top() { return this.stack[this.stack.length - 1]; }
  /** top = top * m (SkM44::preConcat) */
  preConcat(m: ArrayLike<number>) {
    const a = this.top.slice(), out = this.top;
    for (let r = 0; r < 16; r += 4) for (let c = 0; c < 4; c++) out[r + c] = a[r] * m[c] + a[r + 1] * m[4 + c] + a[r + 2] * m[8 + c] + a[r + 3] * m[12 + c];
  }
  /** SkM44::Rotate about a unit axis */
  rotate(x: number, y: number, z: number, deg: number) {
    const rad = Math.fround(Math.fround(deg * Math.fround(Math.PI)) / 180), s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
    this.preConcat([t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1]);
  }
  /** SkPatch3D (u = (1,0,0), v = (0,-1,0) at the origin) through the top transform */
  patch() {
    const m = this.top;
    return { u: [m[0], m[4], m[8]], v: [-m[1], -m[5], -m[9]], origin: [m[3], m[7], m[11]] };
  }
  /** SkCamera3D::patchToMatrix, with the orientation its doUpdate derives for the fixed axis
   *  (0,0,1) and zenith (0,-1,0) and an observer at (0, 0, location z) */
  matrix(out: Mat) {
    const { u, v, origin } = this.patch(), z = this.location[2];
    const rows = [[-z, 0, 0], [0, z, 0], [0, 0, 1]];
    const diff = [origin[0] - this.location[0], origin[1] - this.location[1], origin[2] - z];
    const dot = diff[2], at = (p: number[], row: number) => (p[0] * rows[row][0] + p[1] * rows[row][1] + p[2] * rows[row][2]) / dot;
    out.set([at(u, 0), at(v, 0), at(diff, 0), at(u, 1), at(v, 1), at(diff, 1), at(u, 2), at(v, 2), 1].map(Math.fround));
  }
}
/** a 2D context's affine [a, b, c, d, e, f] as the 3x3 */
export function setAffine(m: Mat, a: number, b: number, c: number, d: number, e: number, f: number): void {
  m[0] = a; m[1] = c; m[2] = e; m[3] = b; m[4] = d; m[5] = f; m[6] = 0; m[7] = 0; m[8] = 1;
}
export const affineOf = (m: Mat): [number, number, number, number, number, number] => [m[0], m[3], m[1], m[4], m[2], m[5]];
/** concatenate (or with `set`, replace) a 2D context's transform; a perspective row cannot be carried */
export function applyMatrix(ctx: Ctx2D, m: ArrayLike<number>, set = false): void {
  if (set) ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
  else ctx.transform(m[0], m[3], m[1], m[4], m[2], m[5]);
}

/** SkBitmap::extractAlpha: an ALPHA_8 copy of the coverage, through the paint's mask filter, its
 *  rows 4-byte aligned as SkMask lays them out */
export function extractBitmapAlpha(src: NativeBitmap, paint: JPaint | null, offsets: Int32Array | null): NativeBitmap {
  const filter = paint?.maskFilter ?? null, border = filter && filter.style !== 3 ? filter.border() : 0;
  const w = src.w + 2 * border, h = src.h + 2 * border, b = new NativeBitmap(w, h, ALPHA_8, PREMUL, (w + 3) & ~3);
  if (filter) {
    const ctx = b.ctx;
    blurMask(ctx, src.image, filter, border, border);
    ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, b.w, b.h);
    ctx.globalCompositeOperation = "source-over";
  } else {
    const source = src.pixels(), target = b.pixels();
    for (let i = 3; i < target.length; i += 4) target[i] = source[i];
  }
  if (offsets && offsets.length >= 2) { offsets[0] = -border; offsets[1] = -border; }
  return b;
}
export function canvasLocalBounds(ctx: Ctx2D): [number, number, number, number] | null {
  const inverse = ctx.getTransform().inverse();
  const points = [[0, 0], [ctx.canvas.width, 0], [0, ctx.canvas.height], [ctx.canvas.width, ctx.canvas.height]]
    .map(([x, y]) => inverse.transformPoint({ x, y }));
  if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  return [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)),
    Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y))];
}
export const CAPS = ["butt", "round", "square"] as const;
export const JOINS = ["miter", "round", "bevel"] as const;
const tintCache = new WeakMap<NativeBitmap, { generation: number; images: Map<number | string, OffscreenCanvas> }>();
/** `b` through a colour filter — `tint` blended by the BlendMode named `mode`, or every pixel through
 *  a 4x5 colour `matrix` — cached per (bitmap, filter); the bitmap itself when there is none */
export function tintedBmp(b: NativeBitmap, tint: number | null, matrix: Float32Array | null = null, mode = "SRC_IN"): CanvasImageSource {
  if (matrix === null && (tint === null || mode === "DST" || mode === "PLUS" && !(tint >>> 24))) return b.image;
  let cache = tintCache.get(b);
  if (!cache || cache.generation !== b.genId) tintCache.set(b, cache = { generation: b.genId, images: new Map() });
  const m = cache.images, key = matrix ? matrix.join(",") : `${mode}:${tint}`;
  let t = m.get(key);
  if (!t) {
    t = new OffscreenCanvas(b.w, b.h);
    const c = t.getContext("2d")!;
    c.drawImage(b.image, 0, 0);
    recolor(c, b.w, b.h, tint, matrix, mode);
    m.set(key, t);
  }
  return t;
}
/** a colour filter applied in place to the w x h pixels `c` holds at (x, y) */
export function recolor(c: OffscreenCanvasRenderingContext2D, w: number, h: number, tint: number | null, matrix: Float32Array | null, mode = "SRC_IN", x = 0, y = 0) {
  if (matrix) {
    const img = c.getImageData(x, y, w, h), d = img.data, k = matrix;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2], a = d[i + 3];
      d[i] = k[0] * r + k[1] * g + k[2] * bl + k[3] * a + k[4];
      d[i + 1] = k[5] * r + k[6] * g + k[7] * bl + k[8] * a + k[9];
      d[i + 2] = k[10] * r + k[11] * g + k[12] * bl + k[13] * a + k[14];
      d[i + 3] = k[15] * r + k[16] * g + k[17] * bl + k[18] * a + k[19];
    }
    c.putImageData(img, x, y);
  } else if (tint === null || mode === "DST") return;
  else if (mode === "CLEAR") c.clearRect(x, y, w, h);
  else if (mode === "MODULATE") {
    const img = c.getImageData(x, y, w, h), d = img.data;
    const r = (tint >>> 16 & 255) / 255, g = (tint >>> 8 & 255) / 255, blue = (tint & 255) / 255, alpha = (tint >>> 24) / 255;
    for (let i = 0; i < d.length; i += 4) { d[i] *= r; d[i + 1] *= g; d[i + 2] *= blue; d[i + 3] *= alpha; }
    c.putImageData(img, x, y);
  } else {
    const composite = COMPOSITE[mode];
    if (!composite) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `bitmap tint mode ${mode}`);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = composite;
    c.fillStyle = cssColor(tint);
    c.fillRect(x, y, w, h);
    c.restore();
  }
}
/** an ARGB colour through a 4x5 colour matrix (channels 0..255, offsets as stored) */
export function matrixColor(k: Float32Array, color: number): number {
  const a = color >>> 24, r = (color >>> 16) & 255, g = (color >>> 8) & 255, b = color & 255;
  const clamp = (v: number) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  return ((clamp(k[15] * r + k[16] * g + k[17] * b + k[18] * a + k[19]) << 24) | (clamp(k[0] * r + k[1] * g + k[2] * b + k[3] * a + k[4]) << 16)
    | (clamp(k[5] * r + k[6] * g + k[7] * b + k[8] * a + k[9]) << 8) | clamp(k[10] * r + k[11] * g + k[12] * b + k[13] * a + k[14])) | 0;
}
// AOSP's text measuring bodies run on this object: they read these fields and call minikin.ts' natives
rt.register({
  name: "android/graphics/Paint", ctor: JPaint, methods: paintMethods,
  fields: { mNativePaint: "nativePaint", mBidiFlags: "bidiFlags", mHasCompatScaling: "hasCompatScaling", mCompatScaling: "compatScaling", mInvCompatScaling: "invCompatScaling" },
});
/** Res_png_9patch deserialized, as NinePatch's native chunk holds it; colors are per patch (0 transparent) */
export interface NinePatchChunk { xDivs: number[]; yDivs: number[]; padding: [left: number, top: number, right: number, bottom: number]; colors: number[] }
/** Res_png_9patch: flags and counts, int32 offsets and padding (left, right, top, bottom), then xDivs, yDivs and colors */
export function readNinePatchChunk(chunk: Int8Array): NinePatchChunk | null {
  if (chunk.length < 32) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const nx = chunk[1] & 0xff, ny = chunk[2] & 0xff, nc = chunk[3] & 0xff;
  if (32 + (nx + ny + nc) * 4 > chunk.length) return null;
  const at = (i: number) => view.getInt32(i, true);
  const ints = (from: number, n: number) => Array.from({ length: n }, (_, i) => at(from + i * 4));
  return { xDivs: ints(32, nx), yDivs: ints(32 + nx * 4, ny), padding: [at(12), at(20), at(16), at(24)], colors: ints(32 + (nx + ny) * 4, nc) };
}
/** NinePatch.isNinePatchChunk: long enough, and its first byte (wasDeserialized) is not -1 */
export const isNinePatchChunk = (chunk: Int8Array | null): chunk is Int8Array => !!chunk && chunk.length >= 32 && chunk[0] !== -1;
/** NinePatch.validateNinePatchChunk's deserialized copy */
export function validNinePatchChunk(chunk: Int8Array | null): NinePatchChunk {
  if (!chunk) throw rt.npe();
  const parsed = readNinePatchChunk(chunk);
  if (!parsed) throw rt.mkThrowable("java/lang/RuntimeException", "Array too small for chunk.");
  return parsed;
}
let ninePatchProps: { bitmap: string; chunk: string } | null = null;
/** a Java NinePatch's (Java) bitmap and native chunk, written into `out` */
export function ninePatchOf<T extends { bmp: object | null; chunk: NinePatchChunk | null }>(patch: object, out: T): T {
  const p = ninePatchProps ??= { bitmap: declaredField("android/graphics/NinePatch", "mBitmap"), chunk: declaredField("android/graphics/NinePatch", "mNativeChunk") };
  const o = patch as Record<string, unknown>;
  out.bmp = o[p.bitmap] as object; out.chunk = deref<NinePatchChunk>(o[p.chunk] as bigint);
  return out;
}

// ── nine-patch geometry: SkCanvas::drawImageLattice over NinePatchUtils::SetLatticeDivs
/** one axis of SkLatticeIter: the source boundaries, whether the first patch stretches, and the stretching total */
interface LatticeAxis { src: number[]; scalableFirst: boolean; scalable: number }
interface Lattice { w: number; h: number; x: LatticeAxis; y: LatticeAxis }
function latticeAxis(divs: number[], size: number): LatticeAxis | null {
  // a last div at the edge says nothing, and Skia refuses it
  const n = divs.length && divs[divs.length - 1] === size ? divs.length - 1 : divs.length;
  for (let i = 0, prev = -1; i < n; prev = divs[i++]) if (prev >= divs[i] || divs[i] >= size) return null;
  const scalableFirst = n > 0 && divs[0] === 0, src = [0];
  for (let i = scalableFirst ? 1 : 0; i < n; i++) src.push(divs[i]);
  src.push(size);
  let scalable = 0;
  for (let i = 1, s = scalableFirst; i < src.length; i++, s = !s) if (s) scalable += src[i] - src[i - 1];
  return { src, scalableFirst, scalable };
}
const lattices = new WeakMap<NinePatchChunk, Lattice | null>();
/** the chunk's lattice over a w x h image, or null where SkLatticeIter::Valid refuses it (no divs on either axis) */
function latticeOf(chunk: NinePatchChunk, w: number, h: number): Lattice | null {
  let l = lattices.get(chunk);
  if (l === undefined || l && (l.w !== w || l.h !== h)) {
    const x = latticeAxis(chunk.xDivs, w), y = latticeAxis(chunk.yDivs, h);
    lattices.set(chunk, l = x && y && (x.src.length > 2 || y.src.length > 2) ? { w, h, x, y } : null);
  }
  return l;
}
/** SkLatticeIter's set_points: each source boundary's place between start and end; fixed patches keep
 *  their size and the stretching ones share the rest, or, when the fixed ones do not fit, they shrink */
function placeAxis(a: LatticeAxis, start: number, end: number, out: number[]) {
  const f = Math.fround, src = a.src, len = f(end - start), fixed = src[src.length - 1] - a.scalable, fits = fixed <= len;
  const scale = fits ? f(f(len - fixed) / a.scalable) : f(len / fixed);
  out[0] = start;
  for (let i = 1, s = a.scalableFirst; i < src.length - 1; i++, s = !s) {
    const d = src[i] - src[i - 1];
    out[i] = f(out[i - 1] + (fits ? (s ? f(scale * d) : d) : (s ? 0 : f(scale * d))));
  }
  out[src.length - 1] = end;
}
const patchXs: number[] = [], patchYs: number[] = [];
/** a nine-patch image (sw x sh) stretched into the destination rectangle */
export function drawNinePatch(ctx: Ctx2D, img: CanvasImageSource, sw: number, sh: number, chunk: NinePatchChunk, dx: number, dy: number, dw: number, dh: number) {
  if (!(dw > 0 && dh > 0)) return;
  const lattice = latticeOf(chunk, sw, sh);
  if (!lattice) { ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh); return; }
  const sx = lattice.x.src, sy = lattice.y.src;
  placeAxis(lattice.x, dx, dx + dw, patchXs);
  placeAxis(lattice.y, dy, dy + dh, patchYs);
  for (let j = 0; j + 1 < sy.length; j++) {
    const top = patchYs[j], h = patchYs[j + 1] - top;
    if (!(h > 0)) continue;
    for (let i = 0; i + 1 < sx.length; i++) {
      const left = patchXs[i], w = patchXs[i + 1] - left;
      if (w > 0) ctx.drawImage(img, sx[i], sy[j], sx[i + 1] - sx[i], sy[j + 1] - sy[j], left, top, w, h);
    }
  }
}
/** hwui's NinePatch getTransparentRegion: the destination patches whose chunk color is transparent,
 *  each rounded, as (l, t, r, b) quadruples; none unless the chunk has a color for every patch */
export function transparentPatches(chunk: NinePatchChunk, sw: number, sh: number, l: number, t: number, r: number, b: number): number[] {
  const lattice = latticeOf(chunk, sw, sh), out: number[] = [];
  if (!lattice) return out;
  const nx = lattice.x.src.length - 1, ny = lattice.y.src.length - 1, xs: number[] = [], ys: number[] = [];
  if (nx * ny !== chunk.colors.length) return out;
  placeAxis(lattice.x, l, r, xs);
  placeAxis(lattice.y, t, b, ys);
  const round = (v: number) => Math.floor(v + 0.5);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (chunk.colors[j * nx + i] === 0 && xs[i] < xs[i + 1] && ys[j] < ys[j + 1]) out.push(round(xs[i]), round(ys[j]), round(xs[i + 1]), round(ys[j + 1]));
  }
  return out;
}
