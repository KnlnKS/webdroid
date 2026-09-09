// android.graphics.* → HTML Canvas 2D. Colors are Java ARGB ints (signed).

import { rt, JObj, type NativeSpec, maySuspend } from "../jvm/runtime";
import { mangleMethod, charsToString, intBitsToFloat } from "../jvm/abi";
import { device } from "../shell/config";
import { handle } from "./handles";
import { vcall, mkEnumSet, JSimpleEnum, linkInit, stringHash } from "../jvm/natives/jlang";
import { usLocale } from "../jvm/natives/jvalues";
import { readStreamFully } from "../jvm/natives/jio";
import { jclsNameOf } from "./apphost";
import { JPath } from "./path";
import { perf } from "../perf";
import { type JRenderEffect } from "./rendereffect";

export function cssColor(argb: number): string {
  const a = (argb >>> 24) / 255;
  return `rgba(${(argb >> 16) & 0xff},${(argb >> 8) & 0xff},${argb & 0xff},${a.toFixed(3)})`;
}

export class JRect extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
const rectMethods = (F: boolean): NativeSpec["methods"] => ({
  "<init>()V": function () {},
  [`<init>(${F ? "FFFF" : "IIII"})V`]: function (this: JRect, l: number, t: number, r: number, b: number) {
    this.left = l; this.top = t; this.right = r; this.bottom = b;
  },
  [`<init>(L${F ? "android/graphics/RectF" : "android/graphics/Rect"};)V`]: function (this: JRect, o: JRect) {
    if (o) { this.left = o.left; this.top = o.top; this.right = o.right; this.bottom = o.bottom; }
  },
  [`width()${F ? "F" : "I"}`]: function (this: JRect) { return this.right - this.left; },
  [`height()${F ? "F" : "I"}`]: function (this: JRect) { return this.bottom - this.top; },
  [`centerX()${F ? "F" : "I"}`]: function (this: JRect) { return F ? (this.left + this.right) / 2 : (this.left + this.right) >> 1; },
  [`centerY()${F ? "F" : "I"}`]: function (this: JRect) { return F ? (this.top + this.bottom) / 2 : (this.top + this.bottom) >> 1; },
  [`set(${F ? "FFFF" : "IIII"})V`]: function (this: JRect, l: number, t: number, r: number, b: number) {
    this.left = l; this.top = t; this.right = r; this.bottom = b;
  },
  "set(Landroid/graphics/Rect;)V": function (this: JRect, o: JRect) {
    this.left = o.left; this.top = o.top; this.right = o.right; this.bottom = o.bottom;
  },
  ...(F ? {
    "set(Landroid/graphics/RectF;)V": function (this: JRect, o: JRect) {
      this.left = o.left; this.top = o.top; this.right = o.right; this.bottom = o.bottom;
    },
  } : {}),
  "setEmpty()V": function (this: JRect) { this.left = this.top = this.right = this.bottom = 0; },
  "isEmpty()Z": function (this: JRect) { return this.left >= this.right || this.top >= this.bottom ? 1 : 0; },
  [`offset(${F ? "FF" : "II"})V`]: function (this: JRect, dx: number, dy: number) {
    this.left += dx; this.right += dx; this.top += dy; this.bottom += dy;
  },
  [`offsetTo(${F ? "FF" : "II"})V`]: function (this: JRect, x: number, y: number) {
    this.right += x - this.left; this.bottom += y - this.top; this.left = x; this.top = y;
  },
  [`inset(${F ? "FF" : "II"})V`]: function (this: JRect, dx: number, dy: number) {
    this.left += dx; this.right -= dx; this.top += dy; this.bottom -= dy;
  },
  [`contains(${F ? "FF" : "II"})Z`]: function (this: JRect, x: number, y: number) {
    return x >= this.left && x < this.right && y >= this.top && y < this.bottom ? 1 : 0;
  },
  "toString()Ljava/lang/String;": function (this: JRect) {
    return `Rect(${this.left}, ${this.top} - ${this.right}, ${this.bottom})`;
  },
  "equals(Ljava/lang/Object;)Z": function (this: JRect, o: unknown) {
    return o instanceof JRect && o.left === this.left && o.top === this.top && o.right === this.right && o.bottom === this.bottom ? 1 : 0;
  },
  [`intersect(${F ? "Landroid/graphics/RectF;" : "Landroid/graphics/Rect;"})Z`]: function (this: JRect, o: JRect) {
    const l = Math.max(this.left, o.left), t = Math.max(this.top, o.top);
    const r = Math.min(this.right, o.right), b = Math.min(this.bottom, o.bottom);
    if (l < r && t < b) { this.left = l; this.top = t; this.right = r; this.bottom = b; return 1; }
    return 0;
  },
  [`union(${F ? "Landroid/graphics/RectF;" : "Landroid/graphics/Rect;"})V`]: function (this: JRect, o: JRect) {
    this.left = Math.min(this.left, o.left); this.top = Math.min(this.top, o.top);
    this.right = Math.max(this.right, o.right); this.bottom = Math.max(this.bottom, o.bottom);
  },
  [`intersect(${F ? "FFFF" : "IIII"})Z`]: function (this: JRect, l: number, t: number, r: number, b: number) {
    if (this.left < r && l < this.right && this.top < b && t < this.bottom) {
      if (this.left < l) this.left = l; if (this.top < t) this.top = t;
      if (this.right > r) this.right = r; if (this.bottom > b) this.bottom = b;
      return 1;
    }
    return 0;
  },
  [`intersects(${F ? "FFFF" : "IIII"})Z`]: function (this: JRect, l: number, t: number, r: number, b: number) {
    return this.left < r && l < this.right && this.top < b && t < this.bottom ? 1 : 0;
  },
  [`static intersects(${F ? "Landroid/graphics/RectF;Landroid/graphics/RectF;" : "Landroid/graphics/Rect;Landroid/graphics/Rect;"})Z`]: (a: JRect, b: JRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom ? 1 : 0,
  [`contains(${F ? "Landroid/graphics/RectF;" : "Landroid/graphics/Rect;"})Z`]: function (this: JRect, o: JRect) {
    return this.left < this.right && this.top < this.bottom && this.left <= o.left && this.top <= o.top && this.right >= o.right && this.bottom >= o.bottom ? 1 : 0;
  },
  [`contains(${F ? "FFFF" : "IIII"})Z`]: function (this: JRect, l: number, t: number, r: number, b: number) {
    return this.left < this.right && this.top < this.bottom && this.left <= l && this.top <= t && this.right >= r && this.bottom >= b ? 1 : 0;
  },
  "toShortString()Ljava/lang/String;": function (this: JRect) { return `[${this.left},${this.top}][${this.right},${this.bottom}]`; },
  ...(F ? {
    "round(Landroid/graphics/Rect;)V": function (this: JRect, o: JRect) {
      o.left = Math.round(this.left); o.top = Math.round(this.top); o.right = Math.round(this.right); o.bottom = Math.round(this.bottom);
    },
    "roundOut(Landroid/graphics/Rect;)V": function (this: JRect, o: JRect) {
      o.left = Math.floor(this.left); o.top = Math.floor(this.top); o.right = Math.ceil(this.right); o.bottom = Math.ceil(this.bottom);
    },
  } : {
    "exactCenterX()F": function (this: JRect) { return (this.left + this.right) * 0.5; },
    "exactCenterY()F": function (this: JRect) { return (this.top + this.bottom) * 0.5; },
  }),
});
rt.register({
  name: "android/graphics/Rect", ctor: JRect, ifaces: ["android/os/Parcelable"],
  fields: { left: "left", top: "top", right: "right", bottom: "bottom" },
  methods: rectMethods(false),
});
export class JRectF extends JRect {}
rt.register({
  name: "android/graphics/RectF", ctor: JRectF, ifaces: ["android/os/Parcelable"],
  fields: { left: "left", top: "top", right: "right", bottom: "bottom" },
  methods: rectMethods(true),
});
export class JPoint extends JObj { x = 0; y = 0; }
rt.register({
  name: "android/graphics/Point", ctor: JPoint,
  fields: { x: "x", y: "y" },
  methods: {
    "offset(II)V": function (this: JPoint, dx: number, dy: number) { this.x += dx; this.y += dy; },
    "negate()V": function (this: JPoint) { this.x = -this.x; this.y = -this.y; },
    "<init>()V": function () {},
    "<init>(II)V": function (this: JPoint, x: number, y: number) { this.x = x; this.y = y; },
    "set(II)V": function (this: JPoint, x: number, y: number) { this.x = x; this.y = y; },
    "equals(Ljava/lang/Object;)Z": function (this: JPoint, o: unknown) { return o instanceof JPoint && o.x === this.x && o.y === this.y ? 1 : 0; },
  },
});
rt.register({
  name: "android/graphics/PointF", ctor: class extends JPoint {},
  fields: { x: "x", y: "y" },
  methods: {
    "<init>()V": function () {},
    "<init>(FF)V": function (this: JPoint, x: number, y: number) { this.x = x; this.y = y; },
    "<init>(Landroid/graphics/Point;)V": function (this: JPoint, p: JPoint) { this.x = p.x; this.y = p.y; },
    "<init>(Landroid/graphics/PointF;)V": function (this: JPoint, p: JPoint) { this.x = p.x; this.y = p.y; },
    "set(FF)V": function (this: JPoint, x: number, y: number) { this.x = x; this.y = y; },
    "set(Landroid/graphics/PointF;)V": function (this: JPoint, p: JPoint) { this.x = p.x; this.y = p.y; },
    "offset(FF)V": function (this: JPoint, dx: number, dy: number) { this.x += dx; this.y += dy; },
    "negate()V": function (this: JPoint) { this.x = -this.x; this.y = -this.y; },
    "length()F": function (this: JPoint) { return Math.fround(Math.hypot(this.x, this.y)); },
    "static length(FF)F": (x: number, y: number) => Math.fround(Math.hypot(x, y)),
    "equals(FF)Z": function (this: JPoint, x: number, y: number) { return this.x === x && this.y === y ? 1 : 0; },
    "equals(Ljava/lang/Object;)Z": function (this: JPoint, o: unknown) { return o instanceof JPoint && o.x === this.x && o.y === this.y ? 1 : 0; },
    "toString()Ljava/lang/String;": function (this: JPoint) { return `PointF(${this.x}, ${this.y})`; },
  },
});

// android.graphics.Insets — immutable 4-sided inset value (WindowInsets.getInsets() etc).
class JInsets extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
const INSETS_NONE = new JInsets();
/** Mirrors Insets.of(): the all-zero case returns the cached NONE singleton, like AOSP. */
export function insetsOf(l: number, t: number, r: number, b: number): JInsets {
  if (l === 0 && t === 0 && r === 0 && b === 0) return INSETS_NONE;
  const i = new JInsets(); i.left = l; i.top = t; i.right = r; i.bottom = b; return i;
}
rt.register({
  name: "android/graphics/Insets", ctor: JInsets,
  fields: { left: "left", top: "top", right: "right", bottom: "bottom" },
  statics: { NONE: INSETS_NONE },
  methods: {
    "static of(IIII)Landroid/graphics/Insets;": (l: number, t: number, r: number, b: number) => insetsOf(l, t, r, b),
    "toString()Ljava/lang/String;": function (this: JInsets) {
      return `Insets{left=${this.left}, top=${this.top}, right=${this.right}, bottom=${this.bottom}}`;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JInsets, o: unknown) {
      return o instanceof JInsets && o.left === this.left && o.top === this.top && o.right === this.right && o.bottom === this.bottom ? 1 : 0;
    },
  },
});

class JColor extends JObj {}
rt.register({
  name: "android/graphics/Color", ctor: JColor,
  statics: {
    BLACK: -16777216, DKGRAY: -12303292, GRAY: -7829368, LTGRAY: -3355444, WHITE: -1,
    RED: -65536, GREEN: -16711936, BLUE: -16776961, YELLOW: -256, CYAN: -16711681,
    MAGENTA: -65281, TRANSPARENT: 0,
  },
  methods: {
    "static argb(IIII)I": (a: number, r: number, g: number, b: number) => ((a << 24) | (r << 16) | (g << 8) | b) | 0,
    "static rgb(III)I": (r: number, g: number, b: number) => (0xff000000 | (r << 16) | (g << 8) | b) | 0,
    "static alpha(I)I": (c: number) => c >>> 24,
    "static red(I)I": (c: number) => (c >> 16) & 0xff,
    "static green(I)I": (c: number) => (c >> 8) & 0xff,
    "static blue(I)I": (c: number) => c & 0xff,
    "static parseColor(Ljava/lang/String;)I": (s: string) => {
      if (s[0] === "#") {
        let h = s.slice(1);
        if (h.length === 3) h = h.split("").map((c) => c + c).join("");
        if (h.length === 6) h = "ff" + h;
        return parseInt(h, 16) | 0;
      }
      const named: Record<string, number> = { black: -16777216, white: -1, red: -65536, green: -16711936, blue: -16776961, gray: -7829368, transparent: 0 };
      const v = named[s.toLowerCase()];
      if (v === undefined) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown color " + s);
      return v;
    },
    // a @ColorLong is the sRGB argb in the high word; argbOfColorLong reads the same encoding
    "static pack(I)J": (c: number) => colorLongOfArgb(c),
    "static toArgb(J)I": (v: bigint) => argbOfColorLong(v),
    "static alpha(J)F": (v: bigint) => (argbOfColorLong(v) >>> 24) / 255,
    "static red(J)F": (v: bigint) => ((argbOfColorLong(v) >> 16) & 0xff) / 255,
    "static green(J)F": (v: bigint) => ((argbOfColorLong(v) >> 8) & 0xff) / 255,
    "static blue(J)F": (v: bigint) => (argbOfColorLong(v) & 0xff) / 255,
    "static isSrgb(J)Z": () => 1,
    "static colorToHSV(I[F)V": (c: number, hsv: Float32Array) => {
      const r = ((c >> 16) & 0xff) / 255, g = ((c >> 8) & 0xff) / 255, b = (c & 0xff) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0;
      if (d) {
        if (mx === r) h = 60 * (((g - b) / d) % 6);
        else if (mx === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
      }
      hsv[0] = (h + 360) % 360; hsv[1] = mx ? d / mx : 0; hsv[2] = mx;
    },
    "static HSVToColor([F)I": (hsv: Float32Array) => {
      const [h, s, v] = [hsv[0], hsv[1], hsv[2]];
      const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
      let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      return (0xff000000 | (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)) | 0;
    },
  },
});

export class JTypeface extends JObj {
  family = "Roboto, sans-serif";
  bold = false; italic = false;
  weight = 400;
  style(): number { return (this.bold ? 1 : 0) | (this.italic ? 2 : 0); }
}
export function mkTypeface(family: string, bold: boolean, italic: boolean, weight = bold ? 700 : 400): JTypeface {
  const t = new JTypeface();
  t.family = family; t.bold = bold; t.italic = italic; t.weight = weight;
  return t;
}
export const tfDefault = mkTypeface("Roboto, sans-serif", false, false);
const tfBold = mkTypeface("Roboto, sans-serif", true, false);
/** Typeface.create(family, style): the framework family names land on the faces we ship (Roboto,
 *  Roboto Medium, and the browser's serif/monospace); light/thin/condensed fall back to Roboto */
export function typefaceFor(fam: string | null, style = 0): JTypeface {
  const family = fam === "sans-serif-medium" ? "Roboto Medium, Roboto, sans-serif"
    : fam === "monospace" || fam === "serif" ? fam : "Roboto, sans-serif";
  const t = mkTypeface(family, (style & 1) !== 0, (style & 2) !== 0);
  if (fam === "sans-serif-medium") t.weight = 500;
  else if (fam === "sans-serif-light") t.weight = 300;
  return t;
}
/** the medium face framework chrome uses (dialog buttons, picker values, the action bar title) */
export const tfMedium = typefaceFor("sans-serif-medium");
rt.register({
  name: "android/graphics/Typeface", ctor: JTypeface,
  statics: {
    DEFAULT: tfDefault, DEFAULT_BOLD: tfBold, SANS_SERIF: tfDefault,
    SERIF: mkTypeface("serif", false, false), MONOSPACE: mkTypeface("monospace", false, false),
    NORMAL: 0, BOLD: 1, ITALIC: 2, BOLD_ITALIC: 3,
  },
  methods: {
    "static create(Ljava/lang/String;I)Landroid/graphics/Typeface;": typefaceFor,
    "static create(Landroid/graphics/Typeface;IZ)Landroid/graphics/Typeface;": (base: JTypeface | null, weight: number, italic: number) => {
      const t = mkTypeface(base?.family ?? "Roboto, sans-serif", weight >= 600, !!italic);
      t.weight = weight;
      return t;
    },
    "static create(Landroid/graphics/Typeface;I)Landroid/graphics/Typeface;": (base: JTypeface | null, style: number) =>
      mkTypeface(base?.family ?? "Roboto, sans-serif", (style & 1) !== 0, (style & 2) !== 0),
    "static defaultFromStyle(I)Landroid/graphics/Typeface;": (style: number) =>
      mkTypeface("Roboto, sans-serif", (style & 1) !== 0, (style & 2) !== 0),
    "getStyle()I": function (this: JTypeface) { return this.style(); },
    "getWeight()I": function (this: JTypeface) { return this.weight; },
    "isBold()Z": function (this: JTypeface) { return this.bold ? 1 : 0; },
    "isItalic()Z": function (this: JTypeface) { return this.italic ? 1 : 0; },
    // AOSP caches one instance per (base, style), so two creates of a family the system lacks
    // compare equal to the default -- which is how apps probe for a system font family
    "equals(Ljava/lang/Object;)Z": function (this: JTypeface, o: unknown) {
      return o instanceof JTypeface && o.family === this.family && o.bold === this.bold && o.italic === this.italic && o.weight === this.weight ? 1 : 0;
    },
    "hashCode()I": function (this: JTypeface) { return (stringHash(this.family) * 31 + this.style() * 7 + this.weight) | 0; },
  },
});

export class JPaint extends JObj {
  color = -16777216;
  style = 0;
  strokeWidth = 0;
  textSize = device.dp(16); // AOSP defaults to 12px, but every view sets its own
  tf: JTypeface = tfDefault;
  antiAlias = true;
  textAlignN = 0; // 0 left, 1 center, 2 right
  alphaMul = 1;   // via setAlpha on top of color? android: setAlpha replaces color alpha
  shader: CanvasGradient | CanvasPattern | null = null;
  shaderObj: JShader | null = null;
  strokeCapN: CanvasLineCap = "butt";
  strokeJoinN: CanvasLineJoin = "miter";
  dash: number[] | null = null;
  filterColor: number | null = null; // PorterDuff SRC_IN tint
  filterObj: JObj | null = null;     // kept only so getColorFilter() round-trips
  /** Canvas2D form of the paint's Xfermode/BlendMode; null = plain source-over. */
  blend: GlobalCompositeOperation | null = null;
  xfermode: JObj | null = null;      // kept only so getXfermode() round-trips
  blendMode: JSimpleEnum | null = null;
  letterSpacingEm = 0;
  underline = false; strikeThru = false; fakeBold = false;

  // font() is called per text op and per measure; the result is a pure function of
  // (typeface identity, textSize, fakeBold), so cache it and rebuild only when one changes.
  private fCache = "";
  private fTf: JTypeface | null = null;
  private fSize = -1;
  private fBold = false;
  font(): string {
    if (this.fTf === this.tf && this.fSize === this.textSize && this.fBold === this.fakeBold) return this.fCache;
    const it = this.tf.italic ? "italic " : "";
    let w = this.fakeBold || this.tf.bold ? 700 : this.tf.weight;
    if (!(w >= 100 && w <= 1000)) w = 400; // bogus weights (untyped-register artifacts) → regular
    this.fTf = this.tf; this.fSize = this.textSize; this.fBold = this.fakeBold;
    return (this.fCache = `${it}${w} ${this.textSize}px ${this.tf.family}`);
  }
  fillStyle(): string | CanvasGradient | CanvasPattern {
    if (this.shader) return this.shader;
    const f = this.filterColor;
    // PorterDuff/BlendMode SRC_IN — how Material tints every shape it draws: the filter's
    // colour replaces the paint's, keeping the alpha the two agree on
    if (f === null) return cssColor(this.color);
    return cssColor(((f & 0xffffff) | ((((f >>> 24) * (this.color >>> 24) / 255) | 0) << 24)) | 0);
  }
}
const paintMethods: NativeSpec["methods"] = {
  // AOSP's own bytecode hands a paint to its native half as a long — MeasuredText.Builder and
  // every Canvas draw do it — so a paint that is OURS still has to be able to name itself in
  // the handle table. handles.ts is stable per object, so this is not an allocation per call.
  "getNativeInstance()J": function (this: JPaint) { return handle(this); },
  // The hyphen a line break may add or remove at either end. There is no hyphenator here, so
  // there is never an edit; AOSP's MeasuredText reads these back per run whatever the answer.
  "getStartHyphenEdit()I": () => 0, "getEndHyphenEdit()I": () => 0,
  // The advance up to `offset`, filling `advances` with one per character. The per-character
  // widths are PREFIX DIFFERENCES rather than each character measured alone: their sum then
  // equals measureText of the whole run, which is what actually gets drawn, and a set of
  // context-free single-character widths would not (Canvas2D kerns). That costs one measure
  // per character, so it is only worth doing when a caller asked for the array.
  "getRunCharacterAdvance([CIIIIZI[FILandroid/graphics/RectF;Landroid/graphics/Paint$RunInfo;)F":
    function (this: JPaint, chars: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number, advances: Float32Array | null, advIdx: number) {
      return runAdvances(this, charsToString(chars, 0, chars.length), start, end, offset, advances, advIdx);
    },
  "<init>()V": function () {},
  "<init>(I)V": function () {},
  "<init>(Landroid/graphics/Paint;)V": function (this: JPaint, o: JPaint) { if (o) copyPaint(o, this); },
  "set(Landroid/graphics/Paint;)V": function (this: JPaint, o: JPaint) { copyPaint(o, this); },
  "setColor(I)V": function (this: JPaint, c: number) { this.color = c; },
  "setColor(J)V": function (this: JPaint, c: bigint) { this.color = Number(BigInt.asIntN(32, c >> 32n)); },
  "getColorLong()J": function (this: JPaint) { return BigInt(this.color >>> 0) << 32n; },
  "isFilterBitmap()Z": () => 1,
  "setHinting(I)V": () => {},
  "getHinting()I": () => 1,
  "setSubpixelText(Z)V": () => {},
  "setLinearText(Z)V": () => {},
  "setElegantTextHeight(Z)V": () => {},
  "setFontFeatureSettings(Ljava/lang/String;)V": () => {},
  "setFontVariationSettings(Ljava/lang/String;)Z": () => 1,
  "setTextLocale(Ljava/util/Locale;)V": () => {},
  "getTextLocale()Ljava/util/Locale;": () => usLocale,
  "getTextLocales()Landroid/os/LocaleList;": async () => vcall((await linkInit("android/os/LocaleList")).ctor, "getDefault", "()Landroid/os/LocaleList;"),
  "setTextLocales(Landroid/os/LocaleList;)V": () => {},
  "setTextScaleX(F)V": () => {},
  "getTextScaleX()F": () => 1,
  "setTextSkewX(F)V": () => {},
  "setStartHyphenEdit(I)V": () => {},
  "setEndHyphenEdit(I)V": () => {},
  "setWordSpacing(F)V": () => {},
  "getWordSpacing()F": () => 0,
  "getLetterSpacing()F": () => 0,
  "isDither()Z": () => 0,
  "getShader()Landroid/graphics/Shader;": function (this: JPaint) { return this.shaderObj; },
  "getStrokeCap()Landroid/graphics/Paint$Cap;": function (this: JPaint) { return null; },
  "getStrokeJoin()Landroid/graphics/Paint$Join;": function (this: JPaint) { return null; },
  "getStrokeMiter()F": () => 4,
  "getPathEffect()Landroid/graphics/PathEffect;": () => null,
  "getXfermode()Landroid/graphics/Xfermode;": function (this: JPaint) { return this.xfermode; },
  "setBlendMode(Landroid/graphics/BlendMode;)V": function (this: JPaint, m: JSimpleEnum | null) {
    this.blendMode = m;
    this.blend = m ? COMPOSITE[m.ename] ?? null : null;
  },
  "getBlendMode()Landroid/graphics/BlendMode;": function (this: JPaint) { return this.blendMode; },
  "getMaskFilter()Landroid/graphics/MaskFilter;": () => null,
  "setMaskFilter(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;": () => null,
  "getColor()I": function (this: JPaint) { return this.color; },
  "setAlpha(I)V": function (this: JPaint, a: number) { this.color = ((a << 24) | (this.color & 0xffffff)) | 0; },
  "getAlpha()I": function (this: JPaint) { return this.color >>> 24; },
  "setStyle(Landroid/graphics/Paint$Style;)V": function (this: JPaint, s: { ord: number }) { this.style = s?.ord ?? 0; },
  "getStyle()Landroid/graphics/Paint$Style;": function (this: JPaint) { return paintStyleEnum[this.style]; },
  "setStrokeWidth(F)V": function (this: JPaint, w: number) { this.strokeWidth = w; },
  "getStrokeWidth()F": function (this: JPaint) { return this.strokeWidth; },
  "setTextSize(F)V": function (this: JPaint, s: number) { if (s > 0) this.textSize = s; },
  "getTextSize()F": function (this: JPaint) { return this.textSize; },
  "setAntiAlias(Z)V": function (this: JPaint, v: number) { this.antiAlias = !!v; },
  "isAntiAlias()Z": function (this: JPaint) { return this.antiAlias ? 1 : 0; },
  "setDither(Z)V": function () {},
  "setFilterBitmap(Z)V": function () {},
  "setTypeface(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;": function (this: JPaint, t: JTypeface | null) {
    const o = this.tf;
    this.tf = t ?? tfDefault;
    return o;
  },
  "getTypeface()Landroid/graphics/Typeface;": function (this: JPaint) { return this.tf; },
  "setTextAlign(Landroid/graphics/Paint$Align;)V": function (this: JPaint, a: { ord: number }) { this.textAlignN = a?.ord ?? 0; },
  "getTextAlign()Landroid/graphics/Paint$Align;": function (this: JPaint) { return paintAlignEnum[this.textAlignN]; },
  "setStrokeCap(Landroid/graphics/Paint$Cap;)V": function (this: JPaint, c: { ord: number }) { this.strokeCapN = CAPS[c?.ord ?? 0]; },
  "setStrokeJoin(Landroid/graphics/Paint$Join;)V": function (this: JPaint, j: { ord: number }) { this.strokeJoinN = JOINS[j?.ord ?? 0]; },
  "setStrokeMiter(F)V": function () {},
  "setShader(Landroid/graphics/Shader;)Landroid/graphics/Shader;": function (this: JPaint, s: JShader | null) {
    this.shader = s?.grad ?? null;
    this.shaderObj = s ?? null;
    return s;
  },
  "setPathEffect(Landroid/graphics/PathEffect;)Landroid/graphics/PathEffect;": function (this: JPaint, e: any) {
    this.dash = e?.intervals ?? null;
    return e;
  },
  "setColorFilter(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;": function (this: JPaint, f: any) {
    this.filterColor = f?.tint ?? null;
    this.filterObj = f ?? null;
    return f;
  },
  "getColorFilter()Landroid/graphics/ColorFilter;": function (this: JPaint) { return this.filterObj; },
  "setXfermode(Landroid/graphics/Xfermode;)Landroid/graphics/Xfermode;": function (this: JPaint, x: JXfermode | null) {
    this.xfermode = x;
    this.blend = x ? COMPOSITE[x.ename] ?? null : null;
    return x;
  },
  "setFlags(I)V": function () {},
  "getFlags()I": function () { return 1; },
  "setUnderlineText(Z)V": function (this: JPaint, v: number) { this.underline = !!v; },
  "setStrikeThruText(Z)V": function (this: JPaint, v: number) { this.strikeThru = !!v; },
  "setFakeBoldText(Z)V": function (this: JPaint, v: number) { this.fakeBold = !!v; },
  "setLetterSpacing(F)V": function (this: JPaint, v: number) { this.letterSpacingEm = v; },
  "setShadowLayer(FFFI)V": function () {},
  "clearShadowLayer()V": function () {},
  "measureText(Ljava/lang/String;)F": function (this: JPaint, s: string) { return measureText(this, s ?? ""); },
  "measureText(Ljava/lang/CharSequence;II)F": function (this: JPaint, s: unknown, a: number, b: number) {
    return measureText(this, String(s).slice(a, b));
  },
  "measureText(Ljava/lang/String;II)F": function (this: JPaint, s: string, a: number, b: number) {
    return measureText(this, s.slice(a, b));
  },
  "measureText([CII)F": function (this: JPaint, c: Uint16Array, off: number, n: number) {
    return measureText(this, charsToString(c, off, n));
  },
  "getTextBounds(Ljava/lang/CharSequence;IILandroid/graphics/Rect;)V": maySuspend(function (this: JPaint, cs: unknown, a: number, b: number, r: JRect) {
    const str = typeof cs === "string" ? cs : ((cs as { text?: string })?.text ?? String(cs ?? ""));
    return vcall(this, "getTextBounds", "(Ljava/lang/String;IILandroid/graphics/Rect;)V", str, a, b, r);
  }),
  "getTextBounds(Ljava/lang/String;IILandroid/graphics/Rect;)V": function (this: JPaint, s: string, a: number, b: number, r: JRect) {
    const ctx = measureCtx(this.font());
    const m = ctx.measureText(s.slice(a, b));
    r.left = Math.floor(-(m.actualBoundingBoxLeft ?? 0));
    r.right = Math.ceil(m.actualBoundingBoxRight ?? m.width);
    r.top = -Math.ceil(m.actualBoundingBoxAscent ?? this.textSize * 0.75);
    r.bottom = Math.ceil(m.actualBoundingBoxDescent ?? this.textSize * 0.25);
  },
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
  "getFontSpacing()F": function (this: JPaint) { return this.textSize * 1.17; },
  "ascent()F": function (this: JPaint) { return fontAscent(this); },
  "descent()F": function (this: JPaint) { return fontDescent(this); },
  "getTextWidths(Ljava/lang/String;[F)I": function (this: JPaint, s: string, w: Float32Array) {
    const ctx = measureCtx(this.font());
    for (let i = 0; i < s.length; i++) w[i] = ctx.measureText(s[i]).width;
    return s.length;
  },
  "breakText(Ljava/lang/String;ZF[F)I": function (this: JPaint, s: string, fwd: number, max: number, out: Float32Array | null) {
    const ctx = measureCtx(this.font());
    let acc = 0, i = 0;
    for (; i < s.length; i++) {
      const w = ctx.measureText(s[i]).width;
      if (acc + w > max) break;
      acc += w;
    }
    if (out) out[0] = acc;
    return i;
  },
};
export function copyPaint(src: JPaint, dst: JPaint) {
  dst.color = src.color; dst.style = src.style; dst.strokeWidth = src.strokeWidth;
  dst.textSize = src.textSize; dst.tf = src.tf; dst.antiAlias = src.antiAlias;
  dst.textAlignN = src.textAlignN; dst.shader = src.shader; dst.shaderObj = src.shaderObj; dst.dash = src.dash;
  dst.filterColor = src.filterColor; dst.filterObj = src.filterObj; dst.underline = src.underline; dst.fakeBold = src.fakeBold;
  dst.letterSpacingEm = src.letterSpacingEm;
  dst.blend = src.blend; dst.xfermode = src.xfermode; dst.blendMode = src.blendMode;
}
class JFontMetrics extends JObj { top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; }
class JFontMetricsInt extends JObj { top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; }
rt.register({
  name: "android/graphics/Paint$FontMetrics", ctor: JFontMetrics,
  fields: { top: "top", ascent: "ascent", descent: "descent", bottom: "bottom", leading: "leading" },
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/graphics/Paint$FontMetricsInt", ctor: JFontMetricsInt,
  fields: { top: "top", ascent: "ascent", descent: "descent", bottom: "bottom", leading: "leading" },
  methods: { "<init>()V": function () {} },
});
let _measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
/**
 * The shared measurement context. ALWAYS pass the font you are about to measure with:
 * setFont elides a redundant assignment by remembering what it last wrote, so a caller that
 * assigns ctx.font itself leaves that memo naming a font the context no longer has — and the
 * next cache miss then measures with the wrong one.
 */
export function measureCtx(font?: string): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : (document.createElement("canvas"));
    _measureCtx = c.getContext("2d") as CanvasRenderingContext2D;
  }
  if (font !== undefined) setFont(_measureCtx, font);
  return _measureCtx;
}
// Browser text measurement is the hot path of every layout AND every draw (a TextView
// measures, wraps, then re-wraps to draw). Width is a pure function of (font, string) and
// the vertical metrics of (font) alone, so both are memoised. The width cache is capped and
// cleared wholesale rather than evicted per entry — line breaking probes many short-lived
// prefixes, so LRU bookkeeping would cost more than the refill.
const WIDTH_CACHE_MAX = 20000;
let widthCache = new Map<string, number>();
const vmetCache = new Map<string, { a: number; d: number }>();
let lastFont = "";
function setFont(ctx: { font: string }, f: string): void {
  if (f !== lastFont) { ctx.font = f; lastFont = f; }
}
function rawWidth(f: string, s: string): number {
  const k = f + "\u0000" + s;
  const hit = widthCache.get(k);
  if (hit !== undefined) return hit;
  perf.measureTextMiss++;
  const ctx = measureCtx(f);
  const w = ctx.measureText(s).width;
  if (widthCache.size >= WIDTH_CACHE_MAX) widthCache = new Map();
  widthCache.set(k, w);
  return w;
}
/** the advance up to `offset` within [start,end), and per-character advances when asked for.
 *  Exported for the CharSequence overload, which lives on TextPaint because flattening a
 *  Spanned is text.ts's job and text.ts imports this file. */
export function runAdvances(p: JPaint, text: string, start: number, end: number, offset: number, advances: Float32Array | null, advIdx: number): number {
  if (advances) {
    let prev = 0;
    for (let i = start; i < end; i++) {
      const w = measureText(p, text.slice(start, i + 1));
      advances[advIdx + i - start] = w - prev;
      prev = w;
    }
  }
  return measureText(p, text.slice(start, Math.max(start, offset)));
}

export function measureText(p: JPaint, s: string): number {
  perf.measureText++;
  return Math.fround(rawWidth(p.font(), s) + p.letterSpacingEm * p.textSize * s.length);
}
/**
 * The device font's vertical metrics, in em units: AOSP's Roboto build reports hhea
 * ascender/descender 1900/-500 as Paint ascent/descent and the OS/2 win metrics 2146/555 as
 * top/bottom, so a line is 1.172em. The Roboto we ship (the Google Fonts build) carries
 * 2146/-555 in hhea too, so the browser's fontBoundingBox is Android's top/bottom — every line
 * came out 12.5% too tall, and auto-sizing text (measure, overflow, shrink, repeat) converged
 * on the wrong size. main.ts applies these as ascent/descent-override on the loaded faces.
 */
export const SYSTEM_FONT = { ascent: 1900 / 2048, descent: 500 / 2048, top: 2146 / 2048, bottom: 555 / 2048 };
export type FontMetrics = typeof SYSTEM_FONT;
/** Per CSS family, the metrics AOSP would report for it; anything unregistered is the device
 *  font's. fonts.ts fills this in as it registers a face out of an app's own resources. */
const familyMetrics = new Map<string, FontMetrics>();
export function setFamilyMetrics(family: string, m: FontMetrics) { familyMetrics.set(family, m); }
/** the metrics of the first family in a paint's CSS stack — the one the browser will pick */
function metricsOf(p: JPaint): FontMetrics {
  const fam = p.tf.family;
  const i = fam.indexOf(",");
  return familyMetrics.get(i < 0 ? fam : fam.slice(0, i)) ?? SYSTEM_FONT;
}
function vmetrics(p: JPaint): { a: number; d: number } {
  const f = p.font();
  const hit = vmetCache.get(f);
  if (hit) return hit;
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
export function fontTop(p: JPaint): number { const m = metricsOf(p); return vmetrics(p).a * (m.top / m.ascent); }
export function fontBottom(p: JPaint): number { const m = metricsOf(p); return vmetrics(p).d * (m.bottom / m.descent); }
export function fillFontMetrics(p: JPaint, fm: { top: number; ascent: number; descent: number; bottom: number; leading: number } | null, int: boolean) {
  const a = fontAscent(p), d = fontDescent(p);
  const ascent = int ? Math.round(a) : a, descent = int ? Math.round(d) : d;
  if (fm) {
    const top = fontTop(p), bottom = fontBottom(p);
    fm.ascent = ascent; fm.descent = descent;
    fm.top = int ? Math.round(top) : top;
    fm.bottom = int ? Math.round(bottom) : bottom;
    fm.leading = 0;
  }
  return descent - ascent;
}

const paintStyleEnum = mkEnumSet("android/graphics/Paint$Style", ["FILL", "STROKE", "FILL_AND_STROKE"]);
const paintAlignEnum = mkEnumSet("android/graphics/Paint$Align", ["LEFT", "CENTER", "RIGHT"]);
mkEnumSet("android/graphics/Paint$Cap", ["BUTT", "ROUND", "SQUARE"]);
mkEnumSet("android/graphics/Paint$Join", ["MITER", "ROUND", "BEVEL"]);
/**
 * Xfermode/BlendMode → the Canvas2D composite operation with the same meaning. PorterDuff.Mode
 * and BlendMode spell the shared modes identically, so one table by name serves both; modes
 * Canvas2D cannot express are absent and fall back to plain source-over.
 * CLEAR maps to destination-out, which is exactly CLEAR for the opaque fill everyone uses it
 * with (Compose's vector cache clears its layer with an opaque black rect).
 */
const COMPOSITE: Record<string, GlobalCompositeOperation> = {
  CLEAR: "destination-out", SRC: "copy", SRC_OVER: "source-over", DST_OVER: "destination-over",
  SRC_IN: "source-in", DST_IN: "destination-in", SRC_OUT: "source-out", DST_OUT: "destination-out",
  SRC_ATOP: "source-atop", DST_ATOP: "destination-atop", XOR: "xor", ADD: "lighter", PLUS: "lighter",
  MODULATE: "multiply", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay",
  DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference",
  EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};
mkEnumSet("android/graphics/PorterDuff$Mode",
  ["CLEAR", "SRC", "DST", "SRC_OVER", "DST_OVER", "SRC_IN", "DST_IN", "SRC_OUT", "DST_OUT",
    "SRC_ATOP", "DST_ATOP", "XOR", "DARKEN", "LIGHTEN", "MULTIPLY", "SCREEN", "ADD", "OVERLAY"]);
rt.register({ name: "android/graphics/PorterDuff", ctor: class extends JObj {} });
rt.register({
  name: "android/graphics/PorterDuffColorFilter", ctor: class extends JObj { tint = 0; },
  sup: "android/graphics/ColorFilter",
  methods: {
    "<init>(ILandroid/graphics/PorterDuff$Mode;)V": function (this: any, c: number) { this.tint = c; },
  },
});
rt.register({ name: "android/graphics/ColorFilter", ctor: class extends JObj {} });
class JColorSpace extends JObj { cname = "sRGB"; }
const srgbSpace = new JColorSpace();
mkEnumSet("android/graphics/ColorSpace$Named",
  ["SRGB", "LINEAR_SRGB", "EXTENDED_SRGB", "LINEAR_EXTENDED_SRGB", "BT709", "BT2020", "DCI_P3",
    "DISPLAY_P3", "NTSC_1953", "SMPTE_C", "ADOBE_RGB", "PRO_PHOTO_RGB", "ACES", "ACESCG", "CIE_XYZ", "CIE_LAB"]);
rt.register({
  name: "android/graphics/ColorSpace", ctor: JColorSpace,
  methods: {
    "static get(Landroid/graphics/ColorSpace$Named;)Landroid/graphics/ColorSpace;": () => srgbSpace,
    "getName()Ljava/lang/String;": function (this: JColorSpace) { return this.cname; },
    "isSrgb()Z": () => 1,
    "isWideGamut()Z": () => 0,
    "getId()I": () => 0,
    "getModel()Landroid/graphics/ColorSpace$Model;": () => null,
    // AOSP's Bitmap passes this pointer to nativeCreate/nativeErase. There is no native colour
    // space behind a 2D context, and 0 is the null handle — which those delegates ignore.
    "getNativeInstance()J": () => 0n,
    "equals(Ljava/lang/Object;)Z": function (this: JColorSpace, o: unknown) { return o === this ? 1 : 0; },
  },
});
mkEnumSet("android/graphics/BlendMode",
  ["CLEAR", "SRC", "DST", "SRC_OVER", "DST_OVER", "SRC_IN", "DST_IN", "SRC_OUT", "DST_OUT",
    "SRC_ATOP", "DST_ATOP", "XOR", "PLUS", "MODULATE", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN",
    "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT", "SOFT_LIGHT", "DIFFERENCE", "EXCLUSION", "MULTIPLY",
    "HUE", "SATURATION", "COLOR", "LUMINOSITY"]);
rt.register({
  name: "android/graphics/BlendModeColorFilter", ctor: class extends JObj { tint = 0; },
  sup: "android/graphics/ColorFilter",
  methods: {
    "<init>(ILandroid/graphics/BlendMode;)V": function (this: any, c: number) { this.tint = c; },
    "getColor()I": function (this: any) { return this.tint; },
    "getMode()Landroid/graphics/BlendMode;": () => null,
  },
});
class JXfermode extends JObj { ename = "SRC_OVER"; }
rt.register({
  name: "android/graphics/PorterDuffXfermode", ctor: class extends JXfermode {}, sup: "android/graphics/Xfermode",
  methods: {
    "<init>(Landroid/graphics/PorterDuff$Mode;)V": function (this: JXfermode, m: JSimpleEnum | null) {
      this.ename = m?.ename ?? "SRC_OVER";
    },
  },
});
rt.register({ name: "android/graphics/Xfermode", ctor: JXfermode });
rt.register({
  name: "android/graphics/DashPathEffect", ctor: class extends JObj { intervals: number[] = []; }, sup: "android/graphics/PathEffect",
  methods: {
    "<init>([FF)V": function (this: any, iv: Float32Array) { this.intervals = [...iv]; },
  },
});
rt.register({ name: "android/graphics/PathEffect", ctor: class extends JObj {} });
rt.register({ name: "android/graphics/CornerPathEffect", ctor: class extends JObj {}, sup: "android/graphics/PathEffect",
  methods: { "<init>(F)V": function () {} } });

class JShader extends JObj {
  grad: CanvasGradient | CanvasPattern | null = null;
  /** setLocalMatrix: maps shader space into the canvas; null = identity */
  local: [number, number, number, number, number, number] | null = null;
}
const isIdentityM = (m: number[]) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
rt.register({
  name: "android/graphics/Shader", ctor: JShader,
  methods: {
    "<init>()V": function () {},
    "setLocalMatrix(Landroid/graphics/Matrix;)V": function (this: JShader, m: JMatrix | null) {
      this.local = m && !isIdentityM(m.m) ? [...m.m] : null;
      if (this.grad instanceof CanvasPattern) this.grad.setTransform(this.local ? new DOMMatrix(this.local) : new DOMMatrix());
    },
    "getLocalMatrix(Landroid/graphics/Matrix;)Z": function (this: JShader, m: JMatrix) {
      m.m = this.local ? [...this.local] : [1, 0, 0, 1, 0, 0];
      return this.local ? 1 : 0;
    },
  },
});
mkEnumSet("android/graphics/Shader$TileMode", ["CLAMP", "REPEAT", "MIRROR", "DECAL"]);
/**
 * A ColorLong is Color.pack()'s encoding: the sRGB case (colour-space id 0, the only one this
 * canvas has) is the ARGB int in the top 32 bits, which is what getColorLong writes.
 */
export const argbOfColorLong = (v: bigint) => Number(BigInt.asUintN(32, v >> 32n)) | 0;
export const colorLongOfArgb = (c: number) => BigInt.asIntN(64, BigInt(c >>> 0) << 32n);

function gradientStops(g: CanvasGradient, colors: ArrayLike<number>, stops: ArrayLike<number> | null): CanvasGradient {
  for (let i = 0; i < colors.length; i++) g.addColorStop(stops ? stops[i] : i / (colors.length - 1), cssColor(colors[i]));
  return g;
}
rt.register({
  name: "android/graphics/LinearGradient", ctor: class extends JShader {}, sup: "android/graphics/Shader",
  methods: {
    "<init>(FFFFIILandroid/graphics/Shader$TileMode;)V": function (this: JShader, x0: number, y0: number, x1: number, y1: number, c0: number, c1: number) {
      this.grad = gradientStops(measureCtx().createLinearGradient(x0, y0, x1, y1), [c0, c1], null);
    },
    "<init>(FFFF[I[FLandroid/graphics/Shader$TileMode;)V": function (this: JShader, x0: number, y0: number, x1: number, y1: number, colors: Int32Array, stops: Float32Array | null) {
      this.grad = gradientStops(measureCtx().createLinearGradient(x0, y0, x1, y1), colors, stops);
    },
    "<init>(FFFF[J[FLandroid/graphics/Shader$TileMode;)V": function (this: JShader, x0: number, y0: number, x1: number, y1: number, colors: BigInt64Array, stops: Float32Array | null) {
      this.grad = gradientStops(measureCtx().createLinearGradient(x0, y0, x1, y1), Array.from(colors, argbOfColorLong), stops);
    },
    "<init>(FFFFJJLandroid/graphics/Shader$TileMode;)V": function (this: JShader, x0: number, y0: number, x1: number, y1: number, c0: bigint, c1: bigint) {
      this.grad = gradientStops(measureCtx().createLinearGradient(x0, y0, x1, y1), [argbOfColorLong(c0), argbOfColorLong(c1)], null);
    },
  },
});
rt.register({
  name: "android/graphics/RadialGradient", ctor: class extends JShader {}, sup: "android/graphics/Shader",
  methods: {
    "<init>(FFFIILandroid/graphics/Shader$TileMode;)V": function (this: JShader, x: number, y: number, r: number, c0: number, c1: number) {
      this.grad = gradientStops(measureCtx().createRadialGradient(x, y, 0, x, y, r), [c0, c1], null);
    },
    "<init>(FFF[I[FLandroid/graphics/Shader$TileMode;)V": function (this: JShader, x: number, y: number, r: number, colors: Int32Array, stops: Float32Array | null) {
      this.grad = gradientStops(measureCtx().createRadialGradient(x, y, 0, x, y, r), colors, stops);
    },
    "<init>(FFF[J[FLandroid/graphics/Shader$TileMode;)V": function (this: JShader, x: number, y: number, r: number, colors: BigInt64Array, stops: Float32Array | null) {
      this.grad = gradientStops(measureCtx().createRadialGradient(x, y, 0, x, y, r), Array.from(colors, argbOfColorLong), stops);
    },
    "<init>(FFFJJLandroid/graphics/Shader$TileMode;)V": function (this: JShader, x: number, y: number, r: number, c0: bigint, c1: bigint) {
      this.grad = gradientStops(measureCtx().createRadialGradient(x, y, 0, x, y, r), [argbOfColorLong(c0), argbOfColorLong(c1)], null);
    },
  },
});

// ── Matrix (affine 2x3: [a, b, c, d, tx, ty] as in canvas transform(a,b,c,d,e,f))
export class JMatrix extends JObj {
  m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
}
/** rotation by `deg` about (px, py) as an affine [a, b, c, d, tx, ty] */
export function rotM(deg: number, px = 0, py = 0): [number, number, number, number, number, number] {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
}
export function matMul(a: number[], b: number[]): [number, number, number, number, number, number] {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function affineFromPoints(src: Float32Array, si: number, dst: Float32Array, di: number, count: number): JMatrix["m"] | null {
  if (!count) return [1, 0, 0, 1, 0, 0];
  const x = src[si], y = src[si + 1], u = dst[di], v = dst[di + 1];
  if (count === 1) return [1, 0, 0, 1, u - x, v - y];
  const sx = src[si + 2] - x, sy = src[si + 3] - y;
  const dx = dst[di + 2] - u, dy = dst[di + 3] - v;
  let a: number, b: number, c: number, d: number;
  if (count === 2) {
    const det = sx * sx + sy * sy;
    if (!det) return null;
    a = d = (dx * sx + dy * sy) / det; b = (dy * sx - dx * sy) / det; c = -b;
  } else {
    let third = 4, sx2 = src[si + third] - x, sy2 = src[si + third + 1] - y;
    let det = sx * sy2 - sx2 * sy;
    if (!det && count === 4) { third = 6; sx2 = src[si + third] - x; sy2 = src[si + third + 1] - y; det = sx * sy2 - sx2 * sy; }
    if (!det) return null;
    const dx2 = dst[di + third] - u, dy2 = dst[di + third + 1] - v;
    a = (dx * sy2 - dx2 * sy) / det; c = (dx2 * sx - dx * sx2) / det;
    b = (dy * sy2 - dy2 * sy) / det; d = (dy2 * sx - dy * sx2) / det;
  }
  const tx = u - a * x - c * y, ty = v - b * x - d * y;
  const matrix: JMatrix["m"] = [a, b, c, d, tx, ty];
  if (!matrix.every(Number.isFinite)) return null;
  if (count === 4) for (let i = 2; i < 4; i++) {
    const px = src[si + i * 2], py = src[si + i * 2 + 1], qx = dst[di + i * 2], qy = dst[di + i * 2 + 1];
    const tolerance = 1e-6 * Math.max(1, Math.abs(qx), Math.abs(qy), Math.abs(a * px), Math.abs(c * py), Math.abs(b * px), Math.abs(d * py), Math.abs(tx), Math.abs(ty));
    if (Math.abs(a * px + c * py + tx - qx) > tolerance || Math.abs(b * px + d * py + ty - qy) > tolerance) return null;
  }
  return matrix;
}
rt.register({
  name: "android/graphics/Matrix", ctor: JMatrix,
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/graphics/Matrix;)V": function (this: JMatrix, o: JMatrix) { if (o) this.m = [...o.m]; },
    "reset()V": function (this: JMatrix) { this.m = [1, 0, 0, 1, 0, 0]; },
    "set(Landroid/graphics/Matrix;)V": function (this: JMatrix, o: JMatrix) { this.m = [...o.m]; },
    "isIdentity()Z": function (this: JMatrix) {
      const m = this.m;
      return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 ? 1 : 0;
    },
    "setPolyToPoly([FI[FII)Z": function (this: JMatrix, src: Float32Array, si: number, dst: Float32Array, di: number, count: number) {
      if (count > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      if (count < 0 || si < 0 || di < 0 || si + count * 2 > src.length || di + count * 2 > dst.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
      const matrix = affineFromPoints(src, si, dst, di, count);
      if (!matrix) return 0;
      this.m = matrix; return 1;
    },
    "setTranslate(FF)V": function (this: JMatrix, x: number, y: number) { this.m = [1, 0, 0, 1, x, y]; },
    "setScale(FF)V": function (this: JMatrix, sx: number, sy: number) { this.m = [sx, 0, 0, sy, 0, 0]; },
    "setScale(FFFF)V": function (this: JMatrix, sx: number, sy: number, px: number, py: number) {
      this.m = [sx, 0, 0, sy, px - sx * px, py - sy * py];
    },
    "setRotate(F)V": function (this: JMatrix, deg: number) { this.m = rotM(deg); },
    "setRotate(FFF)V": function (this: JMatrix, deg: number, px: number, py: number) { this.m = rotM(deg, px, py); },
    "postTranslate(FF)Z": function (this: JMatrix, x: number, y: number) {
      this.m = matMul([1, 0, 0, 1, x, y], this.m);
      return 1;
    },
    "postScale(FF)Z": function (this: JMatrix, sx: number, sy: number) {
      this.m = matMul([sx, 0, 0, sy, 0, 0], this.m);
      return 1;
    },
    "postScale(FFFF)Z": function (this: JMatrix, sx: number, sy: number, px: number, py: number) {
      this.m = matMul([sx, 0, 0, sy, px - sx * px, py - sy * py], this.m);
      return 1;
    },
    "postRotate(F)Z": function (this: JMatrix, deg: number) { this.m = matMul(rotM(deg), this.m); return 1; },
    "postRotate(FFF)Z": function (this: JMatrix, deg: number, px: number, py: number) { this.m = matMul(rotM(deg, px, py), this.m); return 1; },
    "preTranslate(FF)Z": function (this: JMatrix, x: number, y: number) {
      this.m = matMul(this.m, [1, 0, 0, 1, x, y]);
      return 1;
    },
    "preScale(FF)Z": function (this: JMatrix, sx: number, sy: number) {
      this.m = matMul(this.m, [sx, 0, 0, sy, 0, 0]);
      return 1;
    },
    "preRotate(F)Z": function (this: JMatrix, deg: number) { this.m = matMul(this.m, rotM(deg)); return 1; },
    "postConcat(Landroid/graphics/Matrix;)Z": function (this: JMatrix, o: JMatrix) {
      this.m = matMul(o.m, this.m);
      return 1;
    },
    "mapRect(Landroid/graphics/RectF;)Z": function (this: JMatrix, r: JRectF) {
      const m = this.m, l = r.left, t = r.top, rt_ = r.right, b = r.bottom;
      const x0 = m[0] * l + m[2] * t + m[4], y0 = m[1] * l + m[3] * t + m[5];
      const x1 = m[0] * rt_ + m[2] * t + m[4], y1 = m[1] * rt_ + m[3] * t + m[5];
      const x2 = m[0] * l + m[2] * b + m[4], y2 = m[1] * l + m[3] * b + m[5];
      const x3 = m[0] * rt_ + m[2] * b + m[4], y3 = m[1] * rt_ + m[3] * b + m[5];
      r.left = Math.min(x0, x1, x2, x3); r.right = Math.max(x0, x1, x2, x3);
      r.top = Math.min(y0, y1, y2, y3); r.bottom = Math.max(y0, y1, y2, y3);
      return 1;
    },
    "mapPoints([F)V": function (this: JMatrix, pts: Float32Array) {
      const m = this.m;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        pts[i] = m[0] * x + m[2] * y + m[4];
        pts[i + 1] = m[1] * x + m[3] * y + m[5];
      }
    },
    "invert(Landroid/graphics/Matrix;)Z": function (this: JMatrix, out: JMatrix) {
      const [a, b, c, d, e, f] = this.m;
      const det = a * d - b * c;
      if (!det) return 0;
      out.m = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
      return 1;
    },
    "setValues([F)V": function (this: JMatrix, v: Float32Array) {
      this.m = [v[0], v[3], v[1], v[4], v[2], v[5]];
    },
    "getValues([F)V": function (this: JMatrix, v: Float32Array) {
      const m = this.m;
      v[0] = m[0]; v[1] = m[2]; v[2] = m[4]; v[3] = m[1]; v[4] = m[3]; v[5] = m[5];
      v[6] = 0; v[7] = 0; v[8] = 1;
    },
  },
});

/** unpremultiplied RGBA bytes <-> the ARGB int Bitmap's pixel API speaks */
type RGBA = Uint8ClampedArray<ArrayBuffer>;
const argbAt = (d: RGBA, i: number) => ((d[i + 3] << 24) | (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) | 0;
const putArgb = (d: RGBA, i: number, c: number) => {
  d[i] = (c >> 16) & 0xff; d[i + 1] = (c >> 8) & 0xff; d[i + 2] = c & 0xff; d[i + 3] = c >>> 24;
};

export class JBitmap extends JObj {
  w = 0; h = 0;
  density = device.densityDpi;
  recycled = false;
  /** AOSP's NATIVE config numbering (ALPHA_8=1 … ARGB_8888=5, RGBA_F16=6, HARDWARE=7), which is
   *  not Bitmap.Config's ordinal. Everything we back is 8888. */
  config = 5;
  hasAlpha = true; premultiplied = true; immutable = false; mipmap = false;
  genId = 0;
  private cv: OffscreenCanvas | null = null;
  private cx: OffscreenCanvasRenderingContext2D | null = null;
  private px: RGBA | null = null;

  /** The raster, made on demand. A bitmap that is only written and read as pixels never needs
   *  one — and outside a browser there is no OffscreenCanvas to make. Handing it out drops the
   *  pixel memo, because whoever took it may draw. */
  get canvas(): OffscreenCanvas {
    if (!this.cv) {
      this.cv = new OffscreenCanvas(this.w, this.h);
      this.cx = this.cv.getContext("2d", { willReadFrequently: false })!;
      if (this.px) this.cx.putImageData(new ImageData(this.px, this.w, this.h), 0, 0);
    }
    this.px = null;
    return this.cv;
  }
  get ctx(): OffscreenCanvasRenderingContext2D { void this.canvas; return this.cx!; }

  /** RGBA bytes. Until a raster exists these ARE the bitmap; after that they are a memo of it,
   *  which is what makes a run of getPixel one readback instead of one per pixel. */
  pixels(): RGBA {
    return this.px ??= this.cx ? this.cx.getImageData(0, 0, this.w, this.h).data : new Uint8ClampedArray(this.w * this.h * 4) as RGBA;
  }
  /** a written region reaches the raster too, once there is one */
  commit(x: number, y: number, w: number, h: number): void {
    this.genId++;
    const cx = this.cx, px = this.px;
    if (!cx || !px) return;
    let buf = px;
    if (x || y || w !== this.w || h !== this.h) {
      buf = new Uint8ClampedArray(w * h * 4) as RGBA;
      for (let r = 0; r < h; r++) buf.set(px.subarray(((y + r) * this.w + x) * 4, ((y + r) * this.w + x + w) * 4), r * w * 4);
    }
    cx.putImageData(new ImageData(buf, w, h), x, y);
  }

  static create(w: number, h: number): JBitmap {
    const b = new JBitmap();
    b.w = Math.max(1, w | 0); b.h = Math.max(1, h | 0);
    return b;
  }
  static fromImage(img: ImageBitmap | HTMLImageElement, w = img.width, h = img.height): JBitmap {
    const b = JBitmap.create(w, h);
    b.ctx.drawImage(img, 0, 0, w, h);
    return b;
  }
}
/** Exported for the same reason canvasMethods is: AOSP's own Bitmap bytecode reaches these
 *  bodies through its native* delegates (src/android/delegates.ts), not a second copy. */
export const bitmapMethods: NativeSpec["methods"] = {
    "static createBitmap(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;": JBitmap.create,
    "static createBitmap(Landroid/util/DisplayMetrics;IILandroid/graphics/Bitmap$Config;ZLandroid/graphics/ColorSpace;)Landroid/graphics/Bitmap;":
      (_dm: unknown, w: number, h: number) => JBitmap.create(w, h),
    "static createBitmap(IILandroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;": JBitmap.create,
    "static createBitmap(IILandroid/graphics/Bitmap$Config;ZLandroid/graphics/ColorSpace;)Landroid/graphics/Bitmap;": JBitmap.create,
    "static createBitmap(Landroid/graphics/Bitmap;)Landroid/graphics/Bitmap;": (src: JBitmap) => cropBitmap(src, 0, 0, src.w, src.h),
    "static createBitmap(Landroid/graphics/Bitmap;IIII)Landroid/graphics/Bitmap;": cropBitmap,
    "static createBitmap(Landroid/graphics/Bitmap;IIIILandroid/graphics/Matrix;Z)Landroid/graphics/Bitmap;": cropBitmap,
    "static createScaledBitmap(Landroid/graphics/Bitmap;IIZ)Landroid/graphics/Bitmap;": (src: JBitmap, w: number, h: number) => {
      const b = JBitmap.create(w, h);
      b.ctx.drawImage(src.canvas, 0, 0, src.w, src.h, 0, 0, w, h);
      return b;
    },
    "getWidth()I": function (this: JBitmap) { return this.w; },
    "getHeight()I": function (this: JBitmap) { return this.h; },
    "getDensity()I": function (this: JBitmap) { return this.density; },
    "setDensity(I)V": function (this: JBitmap, d: number) { this.density = d; },
    "getScaledWidth(I)I": function (this: JBitmap, td: number) { return Math.round(this.w * td / this.density); },
    "getScaledHeight(I)I": function (this: JBitmap, td: number) { return Math.round(this.h * td / this.density); },
    "recycle()V": function (this: JBitmap) { this.recycled = true; },
    "isRecycled()Z": function (this: JBitmap) { return this.recycled ? 1 : 0; },
    "getPixel(II)I": function (this: JBitmap, x: number, y: number) {
      return argbAt(this.pixels(), (y * this.w + x) * 4);
    },
    "setPixel(III)V": function (this: JBitmap, x: number, y: number, c: number) {
      putArgb(this.pixels(), (y * this.w + x) * 4, c);
      this.commit(x, y, 1, 1);
    },
    "getPixels([IIIIIII)V": function (this: JBitmap, out: Int32Array, off: number, stride: number, x: number, y: number, w: number, h: number) {
      const d = this.pixels();
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) out[off + row * stride + col] = argbAt(d, ((y + row) * this.w + x + col) * 4);
      }
    },
    "setPixels([IIIIIII)V": function (this: JBitmap, src: Int32Array, off: number, stride: number, x: number, y: number, w: number, h: number) {
      const d = this.pixels();
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) putArgb(d, ((y + row) * this.w + x + col) * 4, src[off + row * stride + col]);
      }
      this.commit(x, y, w, h);
    },
    "eraseColor(I)V": function (this: JBitmap, c: number) {
      const d = this.pixels();
      for (let i = 0; i < d.length; i += 4) putArgb(d, i, c);
      this.commit(0, 0, this.w, this.h);
    },
    "extractAlpha()Landroid/graphics/Bitmap;": function (this: JBitmap) { return this; },
    "copy(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;": function (this: JBitmap) {
      const b = JBitmap.create(this.w, this.h);
      b.ctx.drawImage(this.canvas, 0, 0);
      return b;
    },
    "getConfig()Landroid/graphics/Bitmap$Config;": () => bitmapConfigs[3],
    "hasAlpha()Z": function (this: JBitmap) { return this.hasAlpha ? 1 : 0; },
    "setHasAlpha(Z)V": function (this: JBitmap, v: number) { this.hasAlpha = !!v; },
    "isMutable()Z": function (this: JBitmap) { return this.immutable ? 0 : 1; },
    "getByteCount()I": function (this: JBitmap) { return this.w * this.h * 4; },
    "getAllocationByteCount()I": function (this: JBitmap) { return this.w * this.h * 4; },
    "getRowBytes()I": function (this: JBitmap) { return this.w * 4; },
    "compress(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z": async function (this: JBitmap, fmt: unknown, q: number, out: unknown) {
      const blob = await this.canvas.convertToBlob({ type: "image/png" });
      const bytes = new Int8Array(await blob.arrayBuffer());
      await vcall(out, "write", "([BII)V", bytes, 0, bytes.length);
      return 1;
    },
    "prepareToDraw()V": () => {},
};
rt.register({ name: "android/graphics/Bitmap", ctor: JBitmap, ifaces: ["android/os/Parcelable"], methods: bitmapMethods });
const bitmapConfigs = mkEnumSet("android/graphics/Bitmap$Config", ["ALPHA_8", "RGB_565", "ARGB_4444", "ARGB_8888", "RGBA_F16", "HARDWARE", "RGBA_1010102"]);
mkEnumSet("android/graphics/Bitmap$CompressFormat", ["JPEG", "PNG", "WEBP"]);

export class JCanvas extends JObj {
  ctx!: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  w = 0; h = 0;
  saveCount = 1;
  bmp: JBitmap | null = null;
  static wrap(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number): JCanvas {
    const c = new JCanvas();
    c.ctx = ctx; c.w = w; c.h = h;
    return c;
  }
  prep(p: JPaint, stroke: boolean) {
    const ctx = this.ctx;
    if (stroke) {
      ctx.strokeStyle = p.fillStyle() as string;
      ctx.lineWidth = Math.max(p.strokeWidth, 0.75);
      ctx.lineCap = p.strokeCapN;
      ctx.lineJoin = p.strokeJoinN;
      ctx.setLineDash(p.dash ?? []);
    } else {
      ctx.fillStyle = p.fillStyle() as string;
    }
  }
  drawShape(p: JPaint, fill: (ctx: typeof this.ctx) => void, stroke: (ctx: typeof this.ctx) => void) {
    // A blended paint owns the composite op only for its own ops — restore it straight after,
    // so a CLEAR fill can never leak into the next drawImage/drawText and erase it.
    const prev = p.blend ? this.ctx.globalCompositeOperation : null;
    if (p.blend) this.ctx.globalCompositeOperation = p.blend;
    if (p.style === 0 || p.style === 2) {
      this.prep(p, false);
      const lm = p.shaderObj?.local;
      // a gradient with a local matrix: Canvas2D gradients have no transform of their own, so
      // clip to the shape and fill the plane under the matrix instead
      fill(lm && !(p.shader instanceof CanvasPattern) ? this.shaderClipCtx(lm) : this.ctx);
    }
    if (p.style === 1 || p.style === 2) { this.prep(p, true); stroke(this.ctx); }
    if (prev) this.ctx.globalCompositeOperation = prev;
  }
  private shaderCtx: (typeof this.ctx) | null = null;
  private shaderCtxLm: number[] | null = null;
  shaderClipCtx(lm: [number, number, number, number, number, number]): typeof this.ctx {
    const ctx = this.ctx;
    const under = (clip: (c: typeof ctx) => void) => {
      ctx.save();
      clip(ctx);
      ctx.transform(lm[0], lm[1], lm[2], lm[3], lm[4], lm[5]);
      ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
      ctx.restore();
    };
    if (!this.shaderCtx || this.shaderCtxLm !== lm) {
      this.shaderCtxLm = lm;
      const over: Record<string, unknown> = {
        fill: (a?: Path2D | CanvasFillRule, b?: CanvasFillRule) => under((c) => { if (a instanceof Path2D) c.clip(a, b); else c.clip(a); }),
        fillRect: (x: number, y: number, w: number, h: number) => under((c) => { c.beginPath(); c.rect(x, y, w, h); c.clip(); }),
      };
      // every other member goes to the real context with the real receiver (a 2D context's
      // methods throw on any other `this`)
      this.shaderCtx = new Proxy(ctx, {
        get: (t, k) => {
          if (k in over) return over[k as string];
          const v = (t as unknown as Record<PropertyKey, unknown>)[k];
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
        set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; },
      });
    }
    return this.shaderCtx!;
  }
}
// ── Canvas method bodies shared by several overloads
function canvasSave(this: JCanvas) { this.ctx.save(); return this.saveCount++; }
/** run a transform about (px, py) instead of the origin */
function aboutPivot(ctx: JCanvas["ctx"], px: number, py: number, f: () => void) {
  ctx.translate(px, py); f(); ctx.translate(-px, -py);
}
function clipRect(this: JCanvas, l: number, t: number, r: number, b: number) {
  const ctx = this.ctx;
  ctx.beginPath();
  ctx.rect(l, t, r - l, b - t);
  ctx.clip();
  return 1;
}
function drawRect(this: JCanvas, l: number, t: number, r: number, b: number, p: JPaint) {
  this.drawShape(p, (c) => c.fillRect(l, t, r - l, b - t), (c) => c.strokeRect(l, t, r - l, b - t));
}
/** ellipse arc in the box; a full sweep without the centre is drawOval */
function drawArc(this: JCanvas, l: number, t: number, r: number, b: number, start: number, sweep: number, useCenter: number, p: JPaint) {
  const path = new Path2D();
  const cx = (l + r) / 2, cy = (t + b) / 2;
  if (useCenter) path.moveTo(cx, cy);
  path.ellipse(cx, cy, (r - l) / 2, (b - t) / 2, 0, start * Math.PI / 180, (start + sweep) * Math.PI / 180, sweep < 0);
  if (useCenter) path.closePath();
  this.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
}
function drawBitmapRect(this: JCanvas, b: JBitmap, src: JRect | null, dst: JRect | JRectF, p: JPaint | null) {
  const s = src ?? { left: 0, top: 0, right: b.w, bottom: b.h };
  this.ctx.drawImage(tintedBmp(b, p?.filterColor ?? null), s.left, s.top, s.right - s.left, s.bottom - s.top,
    dst.left, dst.top, dst.right - dst.left, dst.bottom - dst.top);
}
/** the (x, y, w, h) region of `src` as a new bitmap, through `m` when given */
function cropBitmap(src: JBitmap, x: number, y: number, w: number, h: number, m: JMatrix | null = null) {
  const b = JBitmap.create(w, h);
  if (m) b.ctx.setTransform(...m.m);
  b.ctx.drawImage(src.canvas, x, y, w, h, 0, 0, w, h);
  if (m) b.ctx.setTransform(1, 0, 0, 1, 0, 0);
  return b;
}
/** Exported so AOSP's own Canvas bytecode reaches the same bodies through its nDraw*
 *  delegates (src/android/delegates.ts) rather than a second copy of each. */
export const canvasMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Landroid/graphics/Bitmap;)V": function (this: JCanvas, b: JBitmap | null) { setCanvasBitmap(this, b); },
  "getWidth()I": function (this: JCanvas) { return this.w; },
  "getHeight()I": function (this: JCanvas) { return this.h; },
  "getMaximumBitmapWidth()I": () => 32766,
  "getMaximumBitmapHeight()I": () => 32766,
  "getDensity()I": () => device.densityDpi,
  "getMatrix(Landroid/graphics/Matrix;)V": function (this: JCanvas, m: JMatrix) {
    const t = this.ctx.getTransform();
    m.m = [t.a, t.b, t.c, t.d, t.e, t.f];
  },
  "enableZ()V": () => {},
  "disableZ()V": () => {},
  "save()I": canvasSave,
  // layers are drawn straight through: a saveLayer is just a save
  "saveLayer(Landroid/graphics/RectF;Landroid/graphics/Paint;)I": canvasSave,
  "saveLayer(FFFFLandroid/graphics/Paint;)I": canvasSave,
  "saveLayerAlpha(FFFFI)I": function (this: JCanvas, l: number, t: number, r: number, b: number, a: number) {
    this.ctx.save();
    this.ctx.globalAlpha *= a / 255;
    return this.saveCount++;
  },
  "restore()V": function (this: JCanvas) { this.ctx.restore(); this.saveCount--; },
  "restoreToCount(I)V": function (this: JCanvas, c: number) {
    while (this.saveCount > c) { this.ctx.restore(); this.saveCount--; }
  },
  "getSaveCount()I": function (this: JCanvas) { return this.saveCount; },
  "translate(FF)V": function (this: JCanvas, x: number, y: number) { this.ctx.translate(x, y); },
  "scale(FF)V": function (this: JCanvas, x: number, y: number) { this.ctx.scale(x, y); },
  "scale(FFFF)V": function (this: JCanvas, sx: number, sy: number, px: number, py: number) {
    aboutPivot(this.ctx, px, py, () => this.ctx.scale(sx, sy));
  },
  "rotate(F)V": function (this: JCanvas, d: number) { this.ctx.rotate(d * Math.PI / 180); },
  "rotate(FFF)V": function (this: JCanvas, d: number, px: number, py: number) {
    aboutPivot(this.ctx, px, py, () => this.ctx.rotate(d * Math.PI / 180));
  },
  "skew(FF)V": function (this: JCanvas, sx: number, sy: number) { this.ctx.transform(1, sy, sx, 1, 0, 0); },
  "concat(Landroid/graphics/Matrix;)V": function (this: JCanvas, m: JMatrix) {
    if (m) this.ctx.transform(...m.m);
  },
  "setMatrix(Landroid/graphics/Matrix;)V": function (this: JCanvas, m: JMatrix | null) {
    this.ctx.setTransform(...(m?.m ?? [1, 0, 0, 1, 0, 0]));
  },
  "clipRect(FFFF)Z": clipRect,
  "clipRect(IIII)Z": clipRect,
  "clipRect(FFFFLandroid/graphics/Region$Op;)Z": function (this: JCanvas, l: number, t: number, r: number, b: number, op: { ename?: string } | null) {
    // Region.Op other than INTERSECT (esp. DIFFERENCE for scrollbar exclusion) is
    // unsupported on a 2D context; ignore non-intersect ops rather than corrupt the clip
    return op && op.ename && op.ename !== "INTERSECT" ? 1 : clipRect.call(this, l, t, r, b);
  },
  "clipRect(Landroid/graphics/Rect;)Z": function (this: JCanvas, r: JRect) { return clipRect.call(this, r.left, r.top, r.right, r.bottom); },
  "clipRect(Landroid/graphics/RectF;)Z": function (this: JCanvas, r: JRectF) { return clipRect.call(this, r.left, r.top, r.right, r.bottom); },
  "clipOutRect(FFFF)Z": () => 1,
  "clipOutRect(IIII)Z": () => 1,
  "clipOutRect(Landroid/graphics/Rect;)Z": () => 1,
  "clipOutPath(Landroid/graphics/Path;)Z": () => 1,
  "clipPath(Landroid/graphics/Path;Landroid/graphics/Region$Op;)Z": function (this: JCanvas, path: JPath, op: { ename?: string } | null) {
    if (op && op.ename && op.ename !== "INTERSECT") return 1;
    this.ctx.clip(path.path(), path.fillRule);
    return 1;
  },
  "clipPath(Landroid/graphics/Path;)Z": function (this: JCanvas, path: JPath) {
    this.ctx.clip(path.path(), path.fillRule);
    return 1;
  },
  "getClipBounds(Landroid/graphics/Rect;)Z": function (this: JCanvas, r: JRect) {
    r.left = 0; r.top = 0; r.right = this.w; r.bottom = this.h;
    return 1;
  },
  "getClipBounds()Landroid/graphics/Rect;": function (this: JCanvas) {
    const r = new JRect();
    r.right = this.w; r.bottom = this.h;
    return r;
  },
  "quickReject(FFFFLandroid/graphics/Canvas$EdgeType;)Z": () => 0,
  "drawColor(I)V": function (this: JCanvas, c: number) {
    this.ctx.save();
    this.ctx.fillStyle = cssColor(c);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.ctx.restore();
  },
  "drawColor(ILandroid/graphics/PorterDuff$Mode;)V": function (this: JCanvas, c: number, m: { ord: number }) {
    if (m?.ord === 0) { // CLEAR
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.ctx.restore();
    } else {
      (this as any)[drawColorKey](c);
    }
  },
  "drawRGB(III)V": function (this: JCanvas, r: number, g: number, b: number) {
    (this as any)[drawColorKey]((0xff000000 | (r << 16) | (g << 8) | b) | 0);
  },
  "drawARGB(IIII)V": function (this: JCanvas, a: number, r: number, g: number, b: number) {
    (this as any)[drawColorKey](((a << 24) | (r << 16) | (g << 8) | b) | 0);
  },
  "drawRect(FFFFLandroid/graphics/Paint;)V": drawRect,
  "drawRect(Landroid/graphics/Rect;Landroid/graphics/Paint;)V": function (this: JCanvas, r: JRect, p: JPaint) { drawRect.call(this, r.left, r.top, r.right, r.bottom, p); },
  "drawRect(Landroid/graphics/RectF;Landroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, p: JPaint) { drawRect.call(this, r.left, r.top, r.right, r.bottom, p); },
  "drawRoundRect(FFFFFFLandroid/graphics/Paint;)V": function (this: JCanvas, l: number, t: number, r: number, b: number, rx: number, ry: number, p: JPaint) {
    const path = new Path2D();
    path.roundRect(l, t, r - l, b - t, Math.min(rx, (r - l) / 2, (b - t) / 2));
    this.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
  },
  "drawRoundRect(Landroid/graphics/RectF;FFLandroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, rx: number, ry: number, p: JPaint) {
    const path = new Path2D();
    path.roundRect(r.left, r.top, r.right - r.left, r.bottom - r.top, Math.min(rx, (r.right - r.left) / 2, (r.bottom - r.top) / 2));
    this.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
  },
  "drawCircle(FFFLandroid/graphics/Paint;)V": function (this: JCanvas, x: number, y: number, r: number, p: JPaint) {
    const path = new Path2D();
    path.arc(x, y, r, 0, Math.PI * 2);
    this.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
  },
  "drawOval(FFFFLandroid/graphics/Paint;)V": function (this: JCanvas, l: number, t: number, r: number, b: number, p: JPaint) {
    drawArc.call(this, l, t, r, b, 0, 360, 0, p);
  },
  "drawOval(Landroid/graphics/RectF;Landroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, p: JPaint) {
    drawArc.call(this, r.left, r.top, r.right, r.bottom, 0, 360, 0, p);
  },
  "drawArc(FFFFFFZLandroid/graphics/Paint;)V": drawArc,
  "drawArc(Landroid/graphics/RectF;FFZLandroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, start: number, sweep: number, useCenter: number, p: JPaint) {
    drawArc.call(this, r.left, r.top, r.right, r.bottom, start, sweep, useCenter, p);
  },
  "drawLine(FFFFLandroid/graphics/Paint;)V": function (this: JCanvas, x0: number, y0: number, x1: number, y1: number, p: JPaint) {
    this.prep(p, true);
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    this.ctx.lineTo(x1, y1);
    this.ctx.stroke();
  },
  "drawLines([FLandroid/graphics/Paint;)V": function (this: JCanvas, pts: Float32Array, p: JPaint) {
    this.prep(p, true);
    this.ctx.beginPath();
    for (let i = 0; i + 3 < pts.length; i += 4) {
      this.ctx.moveTo(pts[i], pts[i + 1]);
      this.ctx.lineTo(pts[i + 2], pts[i + 3]);
    }
    this.ctx.stroke();
  },
  "drawPoint(FFLandroid/graphics/Paint;)V": function (this: JCanvas, x: number, y: number, p: JPaint) {
    this.prep(p, false);
    this.ctx.fillRect(x - p.strokeWidth / 2, y - p.strokeWidth / 2, Math.max(1, p.strokeWidth), Math.max(1, p.strokeWidth));
  },
  "drawPath(Landroid/graphics/Path;Landroid/graphics/Paint;)V": function (this: JCanvas, path: JPath, p: JPaint) {
    this.drawShape(p, (c) => c.fill(path.path(), path.fillRule), (c) => c.stroke(path.path()));
  },
  "drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V": function (this: JCanvas, s: string, x: number, y: number, p: JPaint) {
    drawTextImpl(this, s, x, y, p);
  },
  "drawText(Ljava/lang/CharSequence;IIFFLandroid/graphics/Paint;)V": function (this: JCanvas, s: unknown, a: number, b: number, x: number, y: number, p: JPaint) {
    drawTextImpl(this, String(s).slice(a, b), x, y, p);
  },
  "drawText(Ljava/lang/String;IIFFLandroid/graphics/Paint;)V": function (this: JCanvas, s: string, a: number, b: number, x: number, y: number, p: JPaint) {
    drawTextImpl(this, s.slice(a, b), x, y, p);
  },
  "drawText([CIIFFLandroid/graphics/Paint;)V": function (this: JCanvas, c: Uint16Array, off: number, n: number, x: number, y: number, p: JPaint) {
    drawTextImpl(this, charsToString(c, off, n), x, y, p);
  },
  "drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V": function (this: JCanvas, b: JBitmap, x: number, y: number, p: JPaint | null) {
    this.ctx.drawImage(tintedBmp(b, p?.filterColor ?? null), x, y);
  },
  "drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/Rect;Landroid/graphics/Paint;)V": drawBitmapRect,
  "drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/RectF;Landroid/graphics/Paint;)V": drawBitmapRect,
  "drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Matrix;Landroid/graphics/Paint;)V":
    function (this: JCanvas, b: JBitmap, m: JMatrix, p: JPaint | null) {
      this.ctx.save();
      if (m) this.ctx.transform(...m.m);
      this.ctx.drawImage(tintedBmp(b, p?.filterColor ?? null), 0, 0);
      this.ctx.restore();
    },
  "drawPicture(Landroid/graphics/Picture;)V": () => {},
  "isHardwareAccelerated()Z": () => 1,
  "setDrawFilter(Landroid/graphics/DrawFilter;)V": () => {},
  "setBitmap(Landroid/graphics/Bitmap;)V": function (this: JCanvas, b: JBitmap | null) { setCanvasBitmap(this, b); },
};
/** AOSP: a canvas without a bitmap accepts and discards draws; one detached 1x1 surface takes them */
let noBitmap: OffscreenCanvasRenderingContext2D | null = null;
function setCanvasBitmap(cv: JCanvas, b: JBitmap | null) {
  if (b) { cv.ctx = b.ctx; cv.w = b.w; cv.h = b.h; cv.bmp = b; return; }
  cv.ctx = noBitmap ??= new OffscreenCanvas(1, 1).getContext("2d")!;
  cv.w = cv.h = 0; cv.bmp = null;
}
const drawColorKey = mangleMethod("drawColor", "(I)V");
export const CAPS = ["butt", "round", "square"] as const;
export const JOINS = ["miter", "round", "bevel"] as const;
function drawTextImpl(cv: JCanvas, s: string, x: number, y: number, p: JPaint) {
  const ctx = cv.ctx;
  ctx.font = p.font();
  ctx.fillStyle = p.fillStyle() as string;
  ctx.textAlign = p.textAlignN === 1 ? "center" : p.textAlignN === 2 ? "right" : "left";
  ctx.textBaseline = "alphabetic";
  if (p.letterSpacingEm && "letterSpacing" in ctx) (ctx as any).letterSpacing = `${p.letterSpacingEm * p.textSize}px`;
  ctx.fillText(s, x, y);
  if (p.letterSpacingEm && "letterSpacing" in ctx) (ctx as any).letterSpacing = "0px";
  if (p.underline) {
    const w = measureText(p, s);
    const sx = p.textAlignN === 1 ? x - w / 2 : p.textAlignN === 2 ? x - w : x;
    ctx.fillRect(sx, y + p.textSize * 0.08, w, Math.max(1, p.textSize / 16));
  }
}
const tintCache = new WeakMap<JBitmap, Map<number, OffscreenCanvas>>();
/** `b` recoloured SRC_IN with `tint`, cached per (bitmap, colour); the bitmap itself when tint is null */
export function tintedBmp(b: JBitmap, tint: number | null): OffscreenCanvas {
  if (tint === null) return b.canvas;
  let m = tintCache.get(b);
  if (!m) tintCache.set(b, (m = new Map()));
  let t = m.get(tint);
  if (!t) {
    t = new OffscreenCanvas(b.w, b.h);
    const c = t.getContext("2d")!;
    c.drawImage(b.canvas, 0, 0);
    c.globalCompositeOperation = "source-in";
    c.fillStyle = cssColor(tint);
    c.fillRect(0, 0, b.w, b.h);
    m.set(tint, t);
  }
  return t;
}
rt.register({ name: "android/graphics/Canvas", ctor: JCanvas, methods: canvasMethods });
// android.graphics.Outline: the shape a RenderNode clips to (clipToOutline) — Compose's
// Modifier.clip(shape) is exactly this, so a round button's ripple and children stay inside it.
class JOutline extends JObj {
  kind: 0 | 1 | 2 | 3 = 0;   // empty | rect/roundRect | oval | path
  l = 0; t = 0; r = 0; b = 0; rad = 0; alpha = 1;
  path: JPath | null = null;
  setRR(l: number, t: number, r: number, b: number, rad: number) { this.kind = 1; this.l = l; this.t = t; this.r = r; this.b = b; this.rad = rad; this.path = null; }
  /** intersect ctx's clip with the outline shape */
  trace(ctx: Ctx2D) {
    ctx.beginPath();
    if (this.kind === 3 && this.path) { ctx.clip(this.path.path()); return; }
    if (this.kind === 2) ctx.ellipse((this.l + this.r) / 2, (this.t + this.b) / 2, (this.r - this.l) / 2, (this.b - this.t) / 2, 0, 0, Math.PI * 2);
    else if (this.rad > 0) ctx.roundRect(this.l, this.t, this.r - this.l, this.b - this.t, this.rad);
    else ctx.rect(this.l, this.t, this.r - this.l, this.b - this.t);
    ctx.clip();
  }
}
rt.register({
  name: "android/graphics/Outline", ctor: JOutline,
  methods: {
    "<init>()V": () => {},
    "setRoundRect(IIIIF)V": function (this: JOutline, l: number, t: number, r: number, b: number, rad: number) { this.setRR(l, t, r, b, asF(rad)); },
    "setRoundRect(Landroid/graphics/Rect;F)V": function (this: JOutline, rc: JRect, rad: number) { this.setRR(rc.left, rc.top, rc.right, rc.bottom, asF(rad)); },
    "setRect(IIII)V": function (this: JOutline, l: number, t: number, r: number, b: number) { this.setRR(l, t, r, b, 0); },
    "setRect(Landroid/graphics/Rect;)V": function (this: JOutline, rc: JRect) { this.setRR(rc.left, rc.top, rc.right, rc.bottom, 0); },
    "setOval(IIII)V": function (this: JOutline, l: number, t: number, r: number, b: number) { this.setRR(l, t, r, b, 0); this.kind = 2; },
    "setOval(Landroid/graphics/Rect;)V": function (this: JOutline, rc: JRect) { this.setRR(rc.left, rc.top, rc.right, rc.bottom, 0); this.kind = 2; },
    "setPath(Landroid/graphics/Path;)V": function (this: JOutline, p: JPath) { this.kind = 3; this.path = p; },
    "setConvexPath(Landroid/graphics/Path;)V": function (this: JOutline, p: JPath) { this.kind = 3; this.path = p; },
    "setEmpty()V": function (this: JOutline) { this.kind = 0; this.path = null; },
    "offset(II)V": function (this: JOutline, dx: number, dy: number) { this.l += dx; this.r += dx; this.t += dy; this.b += dy; },
    "canClip()Z": function (this: JOutline) { return this.kind === 3 ? 0 : 1; },
    "isEmpty()Z": function (this: JOutline) { return this.kind === 0 ? 1 : 0; },
    "getAlpha()F": function (this: JOutline) { return this.alpha; },
    "setAlpha(F)V": function (this: JOutline, a: number) { this.alpha = asF(a); },
    "getRadius()F": function (this: JOutline) { return this.kind === 1 ? this.rad : -1; },
    "getRect(Landroid/graphics/Rect;)Z": function (this: JOutline, rc: JRect) {
      if (this.kind !== 1) return 0;
      rc.left = this.l; rc.top = this.t; rc.right = this.r; rc.bottom = this.b;
      return 1;
    },
  },
});
class JRecordingCanvas extends JCanvas {}
rt.register({ name: "android/graphics/RecordingCanvas", ctor: JRecordingCanvas, sup: "android/graphics/Canvas", methods: canvasMethods });

// RenderNode: Compose GraphicsLayer (API 29+) records layers here. We back each node
// with an OffscreenCanvas; drawRenderNode composites it with the node's transform props.
let invalidateHook: (() => void) | null = null;
export function setInvalidateHook(f: () => void) { invalidateHook = f; }
export class JRenderNode extends JObj {
  w = 0; h = 0; left = 0; top = 0;
  alpha = 1; tx = 0; ty = 0; sx = 1; sy = 1; rot = 0;
  px = Number.NaN; py = Number.NaN;   // pivot (NaN = center)
  clip = true;
  clipOutline = false; outline: JOutline | null = null;
  off: OffscreenCanvas | null = null;
  octx: OffscreenCanvasRenderingContext2D | null = null;
  // deferred display list: replayed against the target ctx each draw so child layers
  // re-recorded AFTER this layer keep showing fresh content (real RenderNode semantics)
  ops: ((c: Ctx2D) => void)[] = [];
  hasDL = false;
  effect: JRenderEffect | null = null;
  effectInput: OffscreenCanvas | null = null;
  static all: JRenderNode[] = [];   // debug registry (capped)
  constructor() { super(); if (JRenderNode.all.length < 400) JRenderNode.all.push(this); }
}
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** recording proxy: applies ops immediately to the mirror octx (so reads like
 *  measureText/getTransform work) while appending replay closures to node.ops */
function mkRecorder(node: JRenderNode): Ctx2D {
  const octx = node.octx!;
  const base = {
    __isRecorder: true,
    __record(fn: (c: Ctx2D) => void) { node.ops.push(fn); },
  };
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return (t as Record<PropertyKey, unknown>)[p];
      const v = (octx as unknown as Record<PropertyKey, unknown>)[p];
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          node.ops.push((c) => { ((c as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>)[p])(...args); });
          return (v as (...a: unknown[]) => unknown).apply(octx, args);
        };
      }
      return v;
    },
    set(t, p, val) {
      node.ops.push((c) => { (c as unknown as Record<PropertyKey, unknown>)[p] = val; });
      (octx as unknown as Record<PropertyKey, unknown>)[p] = val;
      return true;
    },
  }) as unknown as Ctx2D;
}
/** replay a node's display list into ctx with its transform props applied */
function drawNodeInto(ctx: Ctx2D, n: JRenderNode) {
  if (!n.hasDL) return;
  ctx.save();
  ctx.globalAlpha *= n.alpha;
  ctx.translate(n.left + n.tx, n.top + n.ty);
  if (n.sx !== 1 || n.sy !== 1 || n.rot !== 0) {
    const px = Number.isNaN(n.px) ? n.w / 2 : n.px;
    const py = Number.isNaN(n.py) ? n.h / 2 : n.py;
    ctx.translate(px, py);
    if (n.rot) ctx.rotate((n.rot * Math.PI) / 180);
    ctx.scale(n.sx, n.sy);
    ctx.translate(-px, -py);
  }
  if (n.clip) { ctx.beginPath(); ctx.rect(0, 0, n.w, n.h); ctx.clip(); }
  if (n.clipOutline && n.outline && n.outline.kind) n.outline.trace(ctx);
  perf.rnReplay += n.ops.length;
  // The display list stays a deferred command list (recorded ops replayed against the real
  // target). A bad op must not abandon this node's save, or its clip leaks into the frame.
  try {
    if (n.effect && n.w > 0 && n.h > 0) {
      const surface = n.effectInput ??= new OffscreenCanvas(n.w, n.h);
      if (surface.width !== n.w) surface.width = n.w;
      if (surface.height !== n.h) surface.height = n.h;
      const input = surface.getContext("2d")!; input.reset();
      for (const op of n.ops) op(input);
      n.effect.draw(ctx, surface);
    } else for (const op of n.ops) op(ctx);
  }
  catch (e) { perf.drawErrors++; noteNodeError(e); }
  finally { ctx.restore(); }
}
const nodeErrSeen = new Set<string>();
function noteNodeError(e: unknown) {
  const k = String((e as Error)?.message ?? e).slice(0, 120);
  if (nodeErrSeen.has(k)) return;
  nodeErrSeen.add(k);
  console.error("[renderNode]", e);
}
const rn1 = () => 1;
// Dalvik registers are untyped: R8'd code may pass float BITS where our JS sees the raw
// int (e.g. 1065353216 for 1.0f). Layer properties are all small floats, so reinterpret
// anything implausibly large.
function asF(v: number): number {
  if (Math.abs(v) > 1e6 && Number.isInteger(v)) return intBitsToFloat(v);
  return v;
}
rt.register({
  name: "android/graphics/RenderNode", ctor: JRenderNode,
  methods: {
    "<init>(Ljava/lang/String;)V": function () {},
    "setPosition(IIII)Z": function (this: JRenderNode, l: number, t: number, r: number, b: number) {
      const w = r - l, h = b - t;
      if (w !== this.w || h !== this.h) this.hasDL = false;
      this.left = l; this.top = t; this.w = w; this.h = h;
      return 1;
    },
    "beginRecording(II)Landroid/graphics/RecordingCanvas;": function (this: JRenderNode, w: number, h: number) {
      const cw = Math.max(1, w), ch = Math.max(1, h);
      // The mirror context exists only so reads during recording (measureText,
      // getTransform, canvas state) answer correctly — drawNodeInto replays `ops` against
      // the real target and never reads this raster. So keep it 1x1: recording a layer no
      // longer rasterises the whole layer a second time, and a screenful of Compose layers
      // stops costing a screenful of full-size offscreen bitmaps. It stays per-node because
      // Compose records a parent layer while its children record into their own.
      if (!this.off) {
        this.off = new OffscreenCanvas(1, 1);
        this.octx = this.off.getContext("2d")!;
      } else {
        this.octx!.reset();
      }
      this.ops = [];
      const c = new JRecordingCanvas();
      c.ctx = mkRecorder(this); c.w = cw; c.h = ch;
      return c;
    },
    "beginRecording()Landroid/graphics/RecordingCanvas;": async function (this: JRenderNode) {
      return vcall(this, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", this.w, this.h);
    },
    "endRecording()V": function (this: JRenderNode) { this.hasDL = true; perf.rnRecord += this.ops.length; invalidateHook?.(); },
    "hasDisplayList()Z": function (this: JRenderNode) { return this.hasDL ? 1 : 0; },
    "discardDisplayList()V": function (this: JRenderNode) { this.hasDL = false; this.ops = []; },
    "getWidth()I": function (this: JRenderNode) { return this.w; },
    "getHeight()I": function (this: JRenderNode) { return this.h; },
    "setAlpha(F)Z": function (this: JRenderNode, a: number) { this.alpha = asF(a); return 1; },
    "getAlpha()F": function (this: JRenderNode) { return this.alpha; },
    "setTranslationX(F)Z": function (this: JRenderNode, v: number) { this.tx = asF(v); return 1; },
    "setTranslationY(F)Z": function (this: JRenderNode, v: number) { this.ty = asF(v); return 1; },
    "setTranslationZ(F)Z": rn1, "setElevation(F)Z": rn1,
    "getTranslationX()F": function (this: JRenderNode) { return this.tx; },
    "getTranslationY()F": function (this: JRenderNode) { return this.ty; },
    "setScaleX(F)Z": function (this: JRenderNode, v: number) { this.sx = asF(v); return 1; },
    "setScaleY(F)Z": function (this: JRenderNode, v: number) { this.sy = asF(v); return 1; },
    "setPivotX(F)Z": function (this: JRenderNode, v: number) { this.px = asF(v); return 1; },
    "setPivotY(F)Z": function (this: JRenderNode, v: number) { this.py = asF(v); return 1; },
    "resetPivot()Z": function (this: JRenderNode) { this.px = this.py = Number.NaN; return 1; },
    "setRotationZ(F)Z": function (this: JRenderNode, v: number) { this.rot = asF(v); return 1; },
    "setRotationX(F)Z": rn1, "setRotationY(F)Z": rn1,
    "setCameraDistance(F)Z": rn1,
    "setClipToBounds(Z)Z": function (this: JRenderNode, c: number) { this.clip = !!c; return 1; },
    "setClipToOutline(Z)Z": function (this: JRenderNode, c: number) { this.clipOutline = !!c; return 1; },
    "setOutline(Landroid/graphics/Outline;)Z": function (this: JRenderNode, o: JOutline | null) { this.outline = o; return 1; },
    "setAmbientShadowColor(I)Z": rn1, "setSpotShadowColor(I)Z": rn1,
    "setUseCompositingLayer(ZLandroid/graphics/Paint;)Z": rn1,
    "setRenderEffect(Landroid/graphics/RenderEffect;)Z": function (this: JRenderNode, effect: JRenderEffect | null) {
      if (this.effect === effect) return 0;
      this.effect = effect;
      if (!effect) this.effectInput = null;
      invalidateHook?.(); return 1;
    },
    "setHasOverlappingRendering(Z)Z": rn1,
    "isValid()Z": function (this: JRenderNode) { return this.hasDL ? 1 : 0; },
    "getMatrix(Landroid/graphics/Matrix;)V": function (this: JRenderNode, m: JMatrix) {
      const px = Number.isNaN(this.px) ? this.w / 2 : this.px;
      const py = Number.isNaN(this.py) ? this.h / 2 : this.py;
      const r = (this.rot * Math.PI) / 180;
      const cos = Math.cos(r), sin = Math.sin(r);
      const a = cos * this.sx, b = sin * this.sx, c = -sin * this.sy, d = cos * this.sy;
      m.m = [a, b, c, d, this.tx + px - a * px - c * py, this.ty + py - b * px - d * py];
    },
    "getPivotX()F": function (this: JRenderNode) { return Number.isNaN(this.px) ? this.w / 2 : this.px; },
    "getPivotY()F": function (this: JRenderNode) { return Number.isNaN(this.py) ? this.h / 2 : this.py; },
    "getScaleX()F": function (this: JRenderNode) { return this.sx; },
    "getScaleY()F": function (this: JRenderNode) { return this.sy; },
    "getRotationZ()F": function (this: JRenderNode) { return this.rot; },
    "getElevation()F": () => 0,
    "getCameraDistance()F": () => 8000,
    "getClipToBounds()Z": function (this: JRenderNode) { return this.clip ? 1 : 0; },
    "getClipToOutline()Z": function (this: JRenderNode) { return this.clipOutline ? 1 : 0; },
  },
});
canvasMethods["drawRenderNode(Landroid/graphics/RenderNode;)V"] = function (this: JCanvas, n: JRenderNode) {
  if (!n) return;
  const t = this.ctx as unknown as { __isRecorder?: boolean; __record?: (fn: (c: Ctx2D) => void) => void };
  if (t.__isRecorder) {
    // deferred: replay the child's CURRENT display list at draw time, not record time
    t.__record!((c) => drawNodeInto(c, n));
  } else {
    drawNodeInto(this.ctx, n);
  }
};
rt.register({ name: "android/graphics/Paint", ctor: JPaint, methods: paintMethods });
mkEnumSet("android/graphics/Canvas$EdgeType", ["BW", "AA"]);
const regionOps = mkEnumSet("android/graphics/Region$Op", ["DIFFERENCE", "INTERSECT", "REPLACE", "REVERSE_DIFFERENCE", "UNION", "XOR"]);

// Region: modelled by its bounds only. What reads a Region back here — a shape drawable's
// transparent region, a clip op — needs the rectangle; a subtractive op cannot shrink the bounds
// without real geometry, so it leaves them alone.
class JRegion extends JRect {}
function setRegion(this: JRegion, l: number, t: number, r: number, b: number) {
  if (l >= r || t >= b) { l = t = r = b = 0; }
  this.left = l; this.top = t; this.right = r; this.bottom = b;
  return l < r ? 1 : 0;
}
function regionOp(this: JRegion, l: number, t: number, r: number, b: number, op: JSimpleEnum | null) {
  const empty = this.left >= this.right;
  switch (op?.ename) {
    case "REPLACE": return setRegion.call(this, l, t, r, b);
    case "UNION": return empty ? setRegion.call(this, l, t, r, b)
      : setRegion.call(this, Math.min(this.left, l), Math.min(this.top, t), Math.max(this.right, r), Math.max(this.bottom, b));
    case "INTERSECT": return setRegion.call(this, Math.max(this.left, l), Math.max(this.top, t), Math.min(this.right, r), Math.min(this.bottom, b));
    case "REVERSE_DIFFERENCE": return setRegion.call(this, l, t, r, b);
    default: return empty ? 0 : 1;
  }
}
const regionRect = (r: JRect) => [r.left, r.top, r.right, r.bottom] as const;
rt.register({
  name: "android/graphics/Region", ctor: JRegion, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>()V": function () {},
    "<init>(IIII)V": setRegion,
    "<init>(Landroid/graphics/Rect;)V": function (this: JRegion, r: JRect) { setRegion.call(this, ...regionRect(r)); },
    "<init>(Landroid/graphics/Region;)V": function (this: JRegion, r: JRegion) { setRegion.call(this, ...regionRect(r)); },
    "set(IIII)Z": setRegion,
    "set(Landroid/graphics/Rect;)Z": function (this: JRegion, r: JRect) { return setRegion.call(this, ...regionRect(r)); },
    "set(Landroid/graphics/Region;)Z": function (this: JRegion, r: JRegion) { return setRegion.call(this, ...regionRect(r)); },
    "setEmpty()V": function (this: JRegion) { setRegion.call(this, 0, 0, 0, 0); },
    "isEmpty()Z": function (this: JRegion) { return this.left >= this.right ? 1 : 0; },
    "isRect()Z": () => 1,
    "isComplex()Z": () => 0,
    "getBounds()Landroid/graphics/Rect;": function (this: JRegion) {
      const r = new (rt.link("android/graphics/Rect").ctor)() as JRect;
      r.left = this.left; r.top = this.top; r.right = this.right; r.bottom = this.bottom;
      return r;
    },
    "getBounds(Landroid/graphics/Rect;)Z": function (this: JRegion, r: JRect) {
      r.left = this.left; r.top = this.top; r.right = this.right; r.bottom = this.bottom;
      return this.left < this.right ? 1 : 0;
    },
    "setPath(Landroid/graphics/Path;Landroid/graphics/Region;)Z": async function (this: JRegion, p: JPath, clip: JRegion) {
      const b = new JRectF();
      await vcall(p, "computeBounds", "(Landroid/graphics/RectF;Z)V", b, 1);
      return setRegion.call(this, Math.max(Math.floor(b.left), clip.left), Math.max(Math.floor(b.top), clip.top),
        Math.min(Math.ceil(b.right), clip.right), Math.min(Math.ceil(b.bottom), clip.bottom));
    },
    "op(IIIILandroid/graphics/Region$Op;)Z": regionOp,
    "op(Landroid/graphics/Rect;Landroid/graphics/Region$Op;)Z": function (this: JRegion, r: JRect, op: JSimpleEnum) { return regionOp.call(this, ...regionRect(r), op); },
    "op(Landroid/graphics/Region;Landroid/graphics/Region$Op;)Z": function (this: JRegion, r: JRegion, op: JSimpleEnum) { return regionOp.call(this, ...regionRect(r), op); },
    "union(Landroid/graphics/Rect;)Z": function (this: JRegion, r: JRect) { return regionOp.call(this, ...regionRect(r), regionOps[4]); },
    "contains(II)Z": function (this: JRegion, x: number, y: number) { return x >= this.left && x < this.right && y >= this.top && y < this.bottom ? 1 : 0; },
    "quickContains(IIII)Z": function (this: JRegion, l: number, t: number, r: number, b: number) { return l >= this.left && t >= this.top && r <= this.right && b <= this.bottom ? 1 : 0; },
    "quickReject(IIII)Z": function (this: JRegion, l: number, t: number, r: number, b: number) { return r <= this.left || l >= this.right || b <= this.top || t >= this.bottom ? 1 : 0; },
    "quickReject(Landroid/graphics/Rect;)Z": function (this: JRegion, r: JRect) { return r.right <= this.left || r.left >= this.right || r.bottom <= this.top || r.top >= this.bottom ? 1 : 0; },
    "translate(II)V": function (this: JRegion, dx: number, dy: number) { this.left += dx; this.right += dx; this.top += dy; this.bottom += dy; },
    "toString()Ljava/lang/String;": function (this: JRegion) { return `Region(${this.left}, ${this.top} - ${this.right}, ${this.bottom})`; },
  },
});

class JBFOptions extends JObj {
  inJustDecodeBounds = 0; inSampleSize = 1; outWidth = 0; outHeight = 0;
  inDensity = 0; inTargetDensity = 0; inScaled = 1; inPreferredConfig: unknown = null;
  inBitmap: unknown = null; inMutable = 0; outMimeType: string | null = null;
  inPreferredColorSpace: unknown = null; inPremultiplied = 1; outConfig: unknown = null;
  inTempStorage: unknown = null; inDither = 0; outColorSpace: unknown = null; inPreferQualityOverSpeed = 0;
  inInputShareable = 0; inPurgeable = 0; inScreenDensity = 0; mCancel = 0;
}
rt.register({
  name: "android/graphics/BitmapFactory$Options", ctor: JBFOptions,
  fields: {
    inJustDecodeBounds: "inJustDecodeBounds", inSampleSize: "inSampleSize",
    outWidth: "outWidth", outHeight: "outHeight", inDensity: "inDensity",
    inTargetDensity: "inTargetDensity", inScaled: "inScaled", inPreferredConfig: "inPreferredConfig",
    inBitmap: "inBitmap", inMutable: "inMutable", outMimeType: "outMimeType",
    inPreferredColorSpace: "inPreferredColorSpace", inPremultiplied: "inPremultiplied",
    outConfig: "outConfig", inTempStorage: "inTempStorage", inDither: "inDither", outColorSpace: "outColorSpace",
    inPreferQualityOverSpeed: "inPreferQualityOverSpeed", inInputShareable: "inInputShareable", inPurgeable: "inPurgeable",
    inScreenDensity: "inScreenDensity", mCancel: "mCancel",
  },
  methods: { "<init>()V": function () {} },
});
/** an empty stream is a loader bug upstream of the decoder, so name the stream class rather than the decode failure */
async function streamBytes(s: unknown): Promise<Uint8Array> {
  const b = await readStreamFully(s);
  if (!b.length) console.warn("[decode] empty stream from", jclsNameOf(s));
  return b;
}
export async function decodeBytes(bytes: Uint8Array, opts: JBFOptions | null,
  onHeader?: (width: number, height: number) => Promise<readonly [number, number]>): Promise<JBitmap | null> {
  let img: ImageBitmap | undefined;
  try {
    const blob = new Blob([bytes as BlobPart]);
    img = await createImageBitmap(blob);
    if (opts) {
      opts.outWidth = img.width;
      opts.outHeight = img.height;
      opts.outConfig = bitmapConfigs[3]; // decoder always rasterizes to ARGB_8888 (see Bitmap.getConfig)
      if (opts.inJustDecodeBounds) return null;
    }
    let w = img.width, h = img.height;
    if (opts && opts.inSampleSize > 1) { w = Math.max(1, w / opts.inSampleSize | 0); h = Math.max(1, h / opts.inSampleSize | 0); }
    if (opts && opts.inDensity && opts.inTargetDensity && opts.inScaled && opts.inDensity !== opts.inTargetDensity) {
      w = Math.round(w * opts.inTargetDensity / opts.inDensity);
      h = Math.round(h * opts.inTargetDensity / opts.inDensity);
    }
    if (onHeader) [w, h] = await onHeader(w, h);
    return JBitmap.fromImage(img, w, h);
  } catch (e) {
    if (onHeader) throw e;
    console.warn("[decode]", e);
    return null;
  } finally { img?.close(); }
}
rt.register({
  name: "android/graphics/BitmapFactory", ctor: class extends JObj {},
  methods: {
    "static decodeByteArray([BII)Landroid/graphics/Bitmap;": (b: Int8Array, off: number, len: number) =>
      decodeBytes(new Uint8Array(b.buffer, b.byteOffset + off, len), null),
    "static decodeByteArray([BIILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;":
      (b: Int8Array, off: number, len: number, o: JBFOptions) =>
        decodeBytes(new Uint8Array(b.buffer, b.byteOffset + off, len), o),
    "static decodeStream(Ljava/io/InputStream;)Landroid/graphics/Bitmap;": async (s: unknown) => decodeBytes(await streamBytes(s), null),
    "static decodeStream(Ljava/io/InputStream;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;":
      async (s: unknown, r: unknown, o: JBFOptions) => decodeBytes(await streamBytes(s), o),
    // decodeResource/decodeFile wired by res.ts / vfs
  },
});
