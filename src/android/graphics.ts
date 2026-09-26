// android.graphics.* → HTML Canvas 2D. Colors are Java ARGB ints (signed).

import { isRecording, recordOrRun, recordingContext, replayCanvas, replayWithSemantics, type Ctx2D } from "./recording";
import { tryBitmapLine, tryBitmapOval, tryBitmapPath, tryBitmapRect, tryBitmapRoundRect, tryBitmapShape, tryPartialSourceIn } from "./bitmap-raster";
import { drawSkiaText } from "./skia-text";
import { rt, JObj, type NativeSpec, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { mangleMethod, charsToString, intBitsToFloat, u8 } from "../jvm/abi";
import { device } from "../shell/config";
import { handle } from "./handles";
import { vcall, newObj, mkEnumSet, JSimpleEnum, linkInit, stringHash } from "../jvm/natives/jlang";
import { type JLocale, localeTag, usLocale } from "../jvm/natives/jvalues";
import type { JLocaleList } from "./resnative";
import { readStreamFully, vfs, type JFileDescriptor } from "../jvm/natives/jio";
import { javaFdBytes } from "../native/stdio";
import { jclsNameOf } from "./apphost";
import { JBuffer } from "../jvm/natives/jnio";
import { JPath, inversePath } from "./path";
import { perf } from "../perf";
import { type JRenderEffect } from "./rendereffect";
import { JTypedValue, type JDisplayMetrics } from "./util";
import { parcelCreator } from "./parcelable";
import type { JParcel } from "./parcel";
import { decodeHeif, isHeif } from "./heif";

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
  [`setIntersect(${F ? "Landroid/graphics/RectF;Landroid/graphics/RectF;" : "Landroid/graphics/Rect;Landroid/graphics/Rect;"})Z`]: function (this: JRect, a: JRect, b: JRect) {
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
      this.left = Math.max(a.left, b.left); this.top = Math.max(a.top, b.top);
      this.right = Math.min(a.right, b.right); this.bottom = Math.min(a.bottom, b.bottom);
      return 1;
    }
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
  fields: ["left", "top", "right", "bottom"],
  methods: rectMethods(false),
});
export class JRectF extends JRect {}
rt.register({
  name: "android/graphics/RectF", ctor: JRectF, ifaces: ["android/os/Parcelable"],
  fields: ["left", "top", "right", "bottom"],
  methods: rectMethods(true),
});
export class JPoint extends JObj { x = 0; y = 0; }
rt.register({
  name: "android/graphics/Point", ctor: JPoint,
  fields: ["x", "y"],
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
  fields: ["x", "y"],
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
  fields: ["left", "top", "right", "bottom"],
  statics: { NONE: INSETS_NONE },
  methods: {
    "static of(IIII)Landroid/graphics/Insets;": (l: number, t: number, r: number, b: number) => insetsOf(l, t, r, b),
    "static of(Landroid/graphics/Rect;)Landroid/graphics/Insets;": (r: JRect) => insetsOf(r.left, r.top, r.right, r.bottom),
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
      const hex = /^#([\da-f]{6}|[\da-f]{8})$/i.exec(s)?.[1];
      if (hex) return parseInt(hex.length === 6 ? `ff${hex}` : hex, 16) | 0;
      const named: Record<string, number> = {
        black: -16777216, darkgray: -12303292, gray: -7829368, lightgray: -3355444, white: -1,
        red: -65536, green: -16711936, blue: -16776961, yellow: -256, cyan: -16711681,
        magenta: -65281, aqua: -16711681, fuchsia: -65281, darkgrey: -12303292,
        grey: -7829368, lightgrey: -3355444, lime: -16711936, maroon: -8388608,
        navy: -16777088, olive: -8355840, purple: -8388480, silver: -4144960, teal: -16744320,
      };
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
    "static HSVToColor([F)I": (hsv: Float32Array) => hsvToColor(255, hsv),
    "static HSVToColor(I[F)I": (alpha: number, hsv: Float32Array) => hsvToColor(alpha, hsv),
  },
});

function hsvToColor(alpha: number, hsv: Float32Array): number {
  const [h, s, v] = [hsv[0], hsv[1], hsv[2]];
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return ((alpha << 24) | (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)) | 0;
}

const ROBOTO = "Roboto, sans-serif";
export const SYSTEM_FONTS = [
  ["Roboto", "Roboto-Regular.ttf", 400, "normal"], ["Roboto Medium", "Roboto-Medium.ttf", 500, "normal"],
  ["Roboto", "Roboto-Bold.ttf", 700, "normal"], ["Roboto", "Roboto-Italic.ttf", 400, "italic"],
] as const;
export const SYSTEM_EMOJI_FONTS = [["Noto Emoji", "NotoColorEmoji.ttf"], ["Noto Emoji Flags", "NotoColorEmojiFlags.ttf"]] as const;
const EMOJI_FALLBACK = SYSTEM_EMOJI_FONTS.map(([family]) => family).join(", ");
export class JTypeface extends JObj {
  family = ROBOTO;
  bold = false; italic = false;
  weight = 400;
  style(): number { return (this.bold ? 1 : 0) | (this.italic ? 2 : 0); }
}
export function mkTypeface(family: string, bold: boolean, italic: boolean, weight = bold ? 700 : 400): JTypeface {
  const t = new JTypeface();
  t.family = family; t.bold = bold; t.italic = italic; t.weight = weight;
  return t;
}
export const tfDefault = mkTypeface(ROBOTO, false, false);
const tfBold = mkTypeface(ROBOTO, true, false);
/** Typeface.create(family, style): the framework family names land on the faces we ship (Roboto,
 *  Roboto Medium, and the browser's serif/monospace); light/thin/condensed fall back to Roboto */
export function typefaceFor(fam: string | null, style = 0): JTypeface {
  const family = fam === "sans-serif-medium" ? "Roboto Medium, " + ROBOTO
    : fam === "monospace" || fam === "serif" ? fam : ROBOTO;
  const t = mkTypeface(family, (style & 1) !== 0, (style & 2) !== 0);
  if (fam === "sans-serif-medium") t.weight = 500;
  else if (fam === "sans-serif-light") t.weight = 300;
  return t;
}
/** the medium face framework chrome uses (dialog buttons, picker values, the action bar title) */
export const tfMedium = typefaceFor("sans-serif-medium");
// fonts.ts owns font parsing and imports this module, so the loader arrives from there
let loadTypeface: (bytes: Uint8Array | null) => Promise<JTypeface | null> = async () => null;
export const setTypefaceLoader = (f: typeof loadTypeface) => { loadTypeface = f; };
const assetFont = (am: { host: { zip: Record<string, Uint8Array> } } | null, path: string) => {
  const bytes = am?.host.zip["assets/" + path];
  if (!bytes) throw rt.mkThrowable("java/lang/RuntimeException", "Font asset not found " + path);
  return loadTypeface(bytes);
};
rt.register({
  name: "android/graphics/Typeface", ctor: JTypeface,
  statics: {
    DEFAULT: tfDefault, DEFAULT_BOLD: tfBold, SANS_SERIF: tfDefault,
    SERIF: mkTypeface("serif", false, false), MONOSPACE: mkTypeface("monospace", false, false),
    NORMAL: 0, BOLD: 1, ITALIC: 2, BOLD_ITALIC: 3,
  },
  methods: {
    "static create(Ljava/lang/String;I)Landroid/graphics/Typeface;": typefaceFor,
    "static createFromAsset(Landroid/content/res/AssetManager;Ljava/lang/String;)Landroid/graphics/Typeface;": assetFont,
    "static createFromFile(Ljava/lang/String;)Landroid/graphics/Typeface;": (p: string) => loadTypeface(vfs.read(p)),
    "static createFromFile(Ljava/io/File;)Landroid/graphics/Typeface;": (f: { path: string } | null) => loadTypeface(f ? vfs.read(f.path) : null),
    "static create(Landroid/graphics/Typeface;IZ)Landroid/graphics/Typeface;": (base: JTypeface | null, weight: number, italic: number) => {
      const t = mkTypeface(base?.family ?? ROBOTO, weight >= 600, !!italic);
      t.weight = weight;
      return t;
    },
    "static create(Landroid/graphics/Typeface;I)Landroid/graphics/Typeface;": (base: JTypeface | null, style: number) =>
      mkTypeface(base?.family ?? ROBOTO, (style & 1) !== 0, (style & 2) !== 0),
    "static defaultFromStyle(I)Landroid/graphics/Typeface;": (style: number) =>
      mkTypeface(ROBOTO, (style & 1) !== 0, (style & 2) !== 0),
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
  tf: JTypeface = tfDefault;
  antiAlias = true;
  textAlignN = 0; // 0 left, 1 center, 2 right
  shader: CanvasGradient | CanvasPattern | null = null;
  shaderObj: JShader | null = null;
  maskFilter: JBlurMaskFilter | null = null;
  strokeCapN: CanvasLineCap = "butt";
  strokeJoinN: CanvasLineJoin = "miter";
  dash: number[] | null = null;
  filterColor: number | null = null; // PorterDuff SRC_IN tint
  filterMatrix: Float32Array | null = null; // ColorMatrixColorFilter
  filterObj: JObj | null = null;     // kept only so getColorFilter() round-trips
  /** Canvas2D form of the paint's Xfermode/BlendMode; null = plain source-over. */
  blend: GlobalCompositeOperation | null = null;
  xfermode: JObj | null = null;      // kept only so getXfermode() round-trips
  blendMode: JSimpleEnum | null = null;
  compositeOp(): GlobalCompositeOperation | null {
    if (this.blend === "source-in" && !this.shader && !this.shaderObj &&
      this.filterColor === null && !this.filterMatrix && (this.renderAlpha ?? this.color >>> 24) === 255)
      return "source-atop";
    return this.blend;
  }
  transparentSourceIn(): boolean {
    return this.blend === "source-in" && (this.renderAlpha ?? this.color >>> 24) === 0 &&
      !this.shader && !this.shaderObj && this.filterColor === null && !this.filterMatrix;
  }
  letterSpacingEm = 0;
  textScaleX = 1;
  textSkewX = 0;
  fontFeatureSettings: string | null = null;
  fontVariationSettings: string | null = null;
  locales: JLocaleList | null = null;
  language = localeTag(usLocale);
  underline = false; strikeThru = false; fakeBold = false;

  // font() is called per text op and per measure; the result is a pure function of
  // (typeface identity, textSize, fakeBold), so cache it and rebuild only when one changes.
  private fCache = "";
  private fTf: JTypeface | null = null;
  private fSize = -1;
  private fBold = false;
  font(): string {
    if (this.fTf === this.tf && this.fSize === this.textSize && this.fBold === this.fakeBold) return this.fCache;
    let w = this.fakeBold ? Math.max(700, this.tf.weight) : this.tf.weight;
    if (!(w >= 100 && w <= 1000)) w = 400; // bogus weights (untyped-register artifacts) → regular
    let family = this.tf.family;
    if (family === ROBOTO) {
      // Minikin keeps the first face on an equal weight/slant score; CSS prefers heavier weights.
      const score = (face: typeof SYSTEM_FONTS[number]) => Math.abs(Math.floor(w / 100) - face[2] / 100) + (this.tf.italic !== (face[3] === "italic") ? 2 : 0);
      let face: typeof SYSTEM_FONTS[number] = SYSTEM_FONTS[0];
      for (const candidate of SYSTEM_FONTS) if (score(candidate) < score(face)) face = candidate;
      family = face[0] + ", sans-serif";
      w = w >= 600 && w - face[2] >= 200 ? 700 : face[2];
    }
    const it = this.tf.italic ? "italic " : "";
    this.fTf = this.tf; this.fSize = this.textSize; this.fBold = this.fakeBold;
    return (this.fCache = `${it}${w} ${this.textSize}px ${family.replace(/, sans-serif$/, "")}, ${EMOJI_FALLBACK}, sans-serif`);
  }
  fillStyle(ctx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): string | CanvasGradient | CanvasPattern {
    const pattern = ctx && this.shaderObj?.pattern(ctx);
    if (pattern) return pattern;
    if (this.shader) return this.shader;
    const f = this.filterColor;
    const color = this.renderAlpha === null ? this.color : (this.renderAlpha << 24) | (this.color & 0xffffff);
    if (this.filterMatrix) return cssColor(matrixColor(this.filterMatrix, color));
    // PorterDuff/BlendMode SRC_IN — how Material tints every shape it draws: the filter's
    // colour replaces the paint's, keeping the alpha the two agree on
    if (f === null) return cssColor(color);
    return cssColor(((f & 0xffffff) | ((((f >>> 24) * (color >>> 24) / 255) | 0) << 24)) | 0);
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
  "<init>(Landroid/graphics/Paint;)V": function (this: JPaint, o: JPaint) { if (o) copyPaint(o, this); },
  "reset()V": function (this: JPaint) { resetPaint(this); },
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
  "setColor(J)V": function (this: JPaint, c: bigint) { this.setColorValue(Number(BigInt.asIntN(32, c >> 32n))); },
  "getColorLong()J": function (this: JPaint) { return BigInt(this.color >>> 0) << 32n; },
  "getTextLocale()Ljava/util/Locale;": function (this: JPaint) { return this.locales?.values[0] ?? usLocale; },
  "getTextLocales()Landroid/os/LocaleList;": driven(function* (this: JPaint): Gen { return this.locales ??= (yield vcall(((yield linkInit("android/os/LocaleList"))).ctor, "getDefault", "()Landroid/os/LocaleList;")); }),
  "setTextLocale(Ljava/util/Locale;)V": function (this: JPaint, locale: JLocale) {
    if (!locale) throw rt.mkThrowable("java/lang/IllegalArgumentException", "locale cannot be null");
    this.locales = Object.assign(rt.make("android/os/LocaleList"), { values: [locale] }); this.language = localeTag(locale);
  },
  "setTextLocales(Landroid/os/LocaleList;)V": function (this: JPaint, locales: JLocaleList) {
    if (!locales?.values.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "locales cannot be null or empty");
    this.locales = locales; this.language = localeTag(locales.values[0]);
  },
  "getShader()Landroid/graphics/Shader;": function (this: JPaint) { return this.shaderObj; },
  "getStrokeMiter()F": () => 4,
  "getXfermode()Landroid/graphics/Xfermode;": function (this: JPaint) { return this.xfermode; },
  "setBlendMode(Landroid/graphics/BlendMode;)V": function (this: JPaint, m: JSimpleEnum | null) {
    this.blendMode = m;
    this.blend = m ? COMPOSITE[m.ename] ?? null : null;
  },
  "getBlendMode()Landroid/graphics/BlendMode;": function (this: JPaint) { return this.blendMode; },
  "getMaskFilter()Landroid/graphics/MaskFilter;": function (this: JPaint) { return this.maskFilter; },
  "setMaskFilter(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;": function (this: JPaint, f: JBlurMaskFilter | null) { return this.maskFilter = f; },
  "getColor()I": function (this: JPaint) { return this.color; },
  "setAlpha(I)V": function (this: JPaint, a: number) { this.setAlphaValue(a); },
  "setARGB(IIII)V": function (this: JPaint, a: number, r: number, g: number, b: number) { this.setColorValue(((a & 255) << 24 | (r & 255) << 16 | (g & 255) << 8 | (b & 255)) | 0); },
  "getAlpha()I": function (this: JPaint) { return this.color >>> 24; },
  "setStyle(Landroid/graphics/Paint$Style;)V": function (this: JPaint, s: { ord: number }) { this.style = s?.ord ?? 0; },
  "getStyle()Landroid/graphics/Paint$Style;": function (this: JPaint) { return paintStyleEnum[this.style]; },
  "setStrokeWidth(F)V": function (this: JPaint, w: number) { this.strokeWidth = w; },
  "getStrokeWidth()F": function (this: JPaint) { return this.strokeWidth; },
  "setTextSize(F)V": function (this: JPaint, s: number) { if (s >= 0) this.textSize = s; },
  "getTextSize()F": function (this: JPaint) { return this.textSize; },
  "setAntiAlias(Z)V": function (this: JPaint, v: number) { this.antiAlias = !!v; },
  "isAntiAlias()Z": function (this: JPaint) { return this.antiAlias ? 1 : 0; },
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
  "getStrokeCap()Landroid/graphics/Paint$Cap;": function (this: JPaint) { return paintCapEnum[CAPS.indexOf(this.strokeCapN)]; },
  "getStrokeJoin()Landroid/graphics/Paint$Join;": function (this: JPaint) { return paintJoinEnum[JOINS.indexOf(this.strokeJoinN)]; },
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
    this.filterMatrix = f?.matrix ?? null;
    this.filterObj = f ?? null;
    return f;
  },
  "getColorFilter()Landroid/graphics/ColorFilter;": function (this: JPaint) { return this.filterObj; },
  "setXfermode(Landroid/graphics/Xfermode;)Landroid/graphics/Xfermode;": function (this: JPaint, x: JXfermode | null) {
    this.xfermode = x;
    this.blend = x ? COMPOSITE[x.ename] ?? null : null;
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

  ...noops("<init>()V", "<init>(I)V", "setHinting(I)V", "setSubpixelText(Z)V", "setLinearText(Z)V",
    "setElegantTextHeight(Z)V", "setStartHyphenEdit(I)V",
    "setEndHyphenEdit(I)V", "setWordSpacing(F)V", "setDither(Z)V", "setFilterBitmap(Z)V", "setStrokeMiter(F)V",
    "setFlags(I)V"),
  ...stubs(1, "isFilterBitmap()Z", "getHinting()I",
    "getFlags()I"),
  ...stubs(0, "getWordSpacing()F", "getLetterSpacing()F", "isDither()Z"),
  ...stubs(null, "getPathEffect()Landroid/graphics/PathEffect;"),
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
  "getTextBounds(Ljava/lang/CharSequence;IILandroid/graphics/Rect;)V": function (this: JPaint, cs: unknown, a: number, b: number, r: JRect) {
    const str = typeof cs === "string" ? cs : ((cs as { text?: string })?.text ?? String(cs ?? ""));
    return vcall(this, "getTextBounds", "(Ljava/lang/String;IILandroid/graphics/Rect;)V", str, a, b, r);
  },
  "getTextBounds([CIILandroid/graphics/Rect;)V": function (this: JPaint, chars: Uint16Array, offset: number, count: number, rect: JRect) {
    return vcall(this, "getTextBounds", "(Ljava/lang/String;IILandroid/graphics/Rect;)V", charsToString(chars, offset, count), 0, count, rect);
  },
  "getTextBounds(Ljava/lang/String;IILandroid/graphics/Rect;)V": function (this: JPaint, s: string, a: number, b: number, r: JRect) {
    const ctx = measureCtx(this.font(), this.language);
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
  "getFontSpacing()F": function (this: JPaint) { return fontDescent(this) - fontAscent(this); },
  "ascent()F": function (this: JPaint) { return fontAscent(this); },
  "descent()F": function (this: JPaint) { return fontDescent(this); },
  "getTextWidths(Ljava/lang/String;[F)I": function (this: JPaint, s: string, w: Float32Array) {
    const ctx = measureCtx(this.font(), this.language);
    for (let i = 0; i < s.length; i++) w[i] = ctx.measureText(s[i]).width;
    return s.length;
  },
  "breakText(Ljava/lang/String;ZF[F)I": function (this: JPaint, s: string, fwd: number, max: number, out: Float32Array | null) {
    const ctx = measureCtx(this.font(), this.language);
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
function resetPaint(paint: JPaint): void {
  paint.color = -16777216; paint.renderAlpha = null; paint.style = 0; paint.strokeWidth = 0;
  paint.textSize = 12; paint.tf = tfDefault; paint.antiAlias = true;
  paint.textAlignN = 0; paint.shader = null; paint.shaderObj = null; paint.maskFilter = null;
  paint.strokeCapN = "butt"; paint.strokeJoinN = "miter"; paint.dash = null;
  paint.filterColor = null; paint.filterMatrix = null; paint.filterObj = null;
  paint.blend = null; paint.xfermode = null; paint.blendMode = null;
  paint.letterSpacingEm = 0; paint.textScaleX = 1; paint.textSkewX = 0;
  paint.fontFeatureSettings = null;
  paint.fontVariationSettings = null;
  paint.underline = false; paint.strikeThru = false; paint.fakeBold = false;
  paint.shadowRadius = paint.shadowDx = paint.shadowDy = paint.shadowColor = 0;
  paint.locales = null; paint.language = localeTag(usLocale);
}
export function beginPaintShadow(ctx: JCanvas["ctx"], p: JPaint): boolean {
  if (!(p.shadowRadius > 0) || !(p.shadowColor >>> 24)) return false;
  const m = ctx.getTransform();
  ctx.save();
  ctx.shadowColor = cssColor(p.shadowColor);
  ctx.shadowBlur = p.shadowRadius * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  ctx.shadowOffsetX = m.a * p.shadowDx + m.c * p.shadowDy;
  ctx.shadowOffsetY = m.b * p.shadowDx + m.d * p.shadowDy;
  return true;
}
export function copyPaint(src: JPaint, dst: JPaint) {
  dst.color = src.color; dst.renderAlpha = src.renderAlpha; dst.style = src.style; dst.strokeWidth = src.strokeWidth;
  dst.textSize = src.textSize; dst.tf = src.tf; dst.antiAlias = src.antiAlias;
  dst.textAlignN = src.textAlignN; dst.shader = src.shader; dst.shaderObj = src.shaderObj; dst.dash = src.dash;
  dst.maskFilter = src.maskFilter; dst.strokeCapN = src.strokeCapN; dst.strokeJoinN = src.strokeJoinN;
  dst.filterColor = src.filterColor; dst.filterMatrix = src.filterMatrix; dst.filterObj = src.filterObj;
  dst.underline = src.underline; dst.strikeThru = src.strikeThru; dst.fakeBold = src.fakeBold;
  dst.letterSpacingEm = src.letterSpacingEm; dst.textScaleX = src.textScaleX; dst.textSkewX = src.textSkewX;
  dst.fontFeatureSettings = src.fontFeatureSettings;
  dst.fontVariationSettings = src.fontVariationSettings;
  dst.locales = src.locales; dst.language = src.language;
  dst.blend = src.blend; dst.xfermode = src.xfermode; dst.blendMode = src.blendMode;
  dst.shadowRadius = src.shadowRadius; dst.shadowDx = src.shadowDx; dst.shadowDy = src.shadowDy; dst.shadowColor = src.shadowColor;
}
class JFontMetrics extends JObj { top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; }
class JFontMetricsInt extends JObj { top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; }
rt.register({
  name: "android/graphics/Paint$FontMetrics", ctor: JFontMetrics,
  fields: ["top", "ascent", "descent", "bottom", "leading"],
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/graphics/Paint$FontMetricsInt", ctor: JFontMetricsInt,
  fields: ["top", "ascent", "descent", "bottom", "leading"],
  methods: { "<init>()V": function () {} },
});
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
function rawWidth(f: string, s: string, language: string): number {
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
  return Math.fround(rawWidth(p.font(), s, p.language) + p.letterSpacingEm * p.textSize * s.length);
}
/** Android Paint retains fractional hhea ascent/descent and uses head.yMax/yMin for bounds.
 * Browser bounding-box metrics round to pixels even with FontFace metric overrides. */
export const SYSTEM_FONT = { ascent: 1900 / 2048, descent: 500 / 2048, top: 2163 / 2048, bottom: 555 / 2048 };
type FontMetrics = typeof SYSTEM_FONT;
/** Per CSS family, the metrics AOSP would report for it; anything unregistered is the device
 *  font's. fonts.ts fills this in as it registers a face out of an app's own resources. */
const familyMetrics = new Map<string, FontMetrics>(SYSTEM_FONTS.map(([family]): [string, FontMetrics] => [family, SYSTEM_FONT]));
export function setFamilyMetrics(family: string, m: FontMetrics) { familyMetrics.set(family, m); }
/** the metrics of the first family in a paint's CSS stack — the one the browser will pick */
function metricsOf(p: JPaint): FontMetrics | undefined {
  const fam = p.tf.family;
  const i = fam.indexOf(",");
  return familyMetrics.get(i < 0 ? fam : fam.slice(0, i));
}
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
  const a = fontAscent(p), d = fontDescent(p);
  const ascent = int ? Math.round(a) : a, descent = int ? Math.round(d) : d;
  if (fm) {
    const top = fontTop(p), bottom = fontBottom(p);
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
rt.markers("android/graphics/PorterDuff");
rt.register({
  name: "android/graphics/PorterDuffColorFilter", ctor: class extends JObj { tint = 0; },
  sup: "android/graphics/ColorFilter",
  methods: {
    "<init>(ILandroid/graphics/PorterDuff$Mode;)V": function (this: any, c: number) { this.tint = c; },
  },
});
rt.markers("android/graphics/ColorFilter");
// ── ColorMatrix: AOSP's row-major 4x5, and the filter that carries a copy of one
class JColorMatrix extends JObj { a = identityMatrix(); }
function identityMatrix(): Float32Array { const m = new Float32Array(20); m[0] = m[6] = m[12] = m[18] = 1; return m; }
function setMatrix(dst: Float32Array, src: Float32Array): void {
  if (src.length < 20) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", String(src.length));
  dst.set(src.subarray(0, 20));
}
function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(20);
  for (let j = 0; j < 20; j += 5) {
    for (let i = 0; i < 4; i++) out[j + i] = a[j] * b[i] + a[j + 1] * b[5 + i] + a[j + 2] * b[10 + i] + a[j + 3] * b[15 + i];
    out[j + 4] = a[j] * b[4] + a[j + 1] * b[9] + a[j + 2] * b[14] + a[j + 3] * b[19] + a[j + 4];
  }
  return out;
}
rt.register({
  name: "android/graphics/ColorMatrix", ctor: JColorMatrix,
  methods: {
    "<init>()V": function () {},
    "<init>([F)V": function (this: JColorMatrix, src: Float32Array) { setMatrix(this.a, src); },
    "<init>(Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrix, src: JColorMatrix) { this.a.set(src.a); },
    "getArray()[F": function (this: JColorMatrix) { return this.a; },
    "reset()V": function (this: JColorMatrix) { this.a.fill(0); this.a[0] = this.a[6] = this.a[12] = this.a[18] = 1; },
    "set(Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrix, src: JColorMatrix) { this.a.set(src.a); },
    "set([F)V": function (this: JColorMatrix, src: Float32Array) { setMatrix(this.a, src); },
    "setScale(FFFF)V": function (this: JColorMatrix, r: number, g: number, b: number, a: number) {
      this.a.fill(0); this.a[0] = r; this.a[6] = g; this.a[12] = b; this.a[18] = a;
    },
    "setSaturation(F)V": function (this: JColorMatrix, sat: number) {
      const m = this.a, inv = 1 - sat, R = 0.213 * inv, G = 0.715 * inv, B = 0.072 * inv;
      m.fill(0);
      m[0] = R + sat; m[1] = G; m[2] = B;
      m[5] = R; m[6] = G + sat; m[7] = B;
      m[10] = R; m[11] = G; m[12] = B + sat;
      m[18] = 1;
    },
    "setConcat(Landroid/graphics/ColorMatrix;Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrix, a: JColorMatrix, b: JColorMatrix) { this.a.set(concat(a.a, b.a)); },
    "preConcat(Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrix, pre: JColorMatrix) { this.a.set(concat(this.a, pre.a)); },
    "postConcat(Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrix, post: JColorMatrix) { this.a.set(concat(post.a, this.a)); },
    "equals(Ljava/lang/Object;)Z": function (this: JColorMatrix, o: unknown) { return o instanceof JColorMatrix && o.a.every((v, i) => v === this.a[i]) ? 1 : 0; },
  },
});
class JColorMatrixColorFilter extends JObj { matrix = identityMatrix(); }
class JLightingColorFilter extends JObj {
  mul = 0; add = 0; matrix = identityMatrix();
  update() {
    const m = this.matrix;
    m[0] = ((this.mul >>> 16) & 255) / 255; m[6] = ((this.mul >>> 8) & 255) / 255; m[12] = (this.mul & 255) / 255;
    m[4] = (this.add >>> 16) & 255; m[9] = (this.add >>> 8) & 255; m[14] = this.add & 255;
  }
}
rt.register({
  name: "android/graphics/LightingColorFilter", ctor: JLightingColorFilter, sup: "android/graphics/ColorFilter",
  methods: {
    "<init>(II)V": function (this: JLightingColorFilter, mul: number, add: number) { this.mul = mul; this.add = add; this.update(); },
    "getColorMultiply()I": function (this: JLightingColorFilter) { return this.mul; },
    "getColorAdd()I": function (this: JLightingColorFilter) { return this.add; },
    "setColorMultiply(I)V": function (this: JLightingColorFilter, mul: number) { this.mul = mul; this.update(); },
    "setColorAdd(I)V": function (this: JLightingColorFilter, add: number) { this.add = add; this.update(); },
  },
});
rt.register({
  name: "android/graphics/ColorMatrixColorFilter", ctor: JColorMatrixColorFilter, sup: "android/graphics/ColorFilter",
  methods: {
    "<init>(Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrixColorFilter, m: JColorMatrix) { this.matrix.set(m.a); },
    "<init>([F)V": function (this: JColorMatrixColorFilter, src: Float32Array) { setMatrix(this.matrix, src); },
    "getColorMatrix(Landroid/graphics/ColorMatrix;)V": function (this: JColorMatrixColorFilter, out: JColorMatrix) { out.a.set(this.matrix); },
  },
});
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
    ...stubs(1, "isSrgb()Z"),
    ...stubs(0, "isWideGamut()Z", "getId()I"),
    ...stubs(null, "getModel()Landroid/graphics/ColorSpace$Model;"),
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
rt.markers("android/graphics/PathEffect");
rt.register({ name: "android/graphics/CornerPathEffect", ctor: class extends JObj {}, sup: "android/graphics/PathEffect",
  methods: { "<init>(F)V": function () {} } });
mkEnumSet("android/graphics/BlurMaskFilter$Blur", ["NORMAL", "SOLID", "OUTER", "INNER"]);
class JBlurMaskFilter extends JObj {
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
function blurMask(ctx: Ctx2D, source: CanvasImageSource, filter: JBlurMaskFilter | null, x = 0, y = 0, scale = 1) {
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
      this.style = style.ord;
      this.sigma = radius * 0.57735 + 0.5;
    },
  },
});

export class JShader extends JObj {
  pattern(_ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): CanvasGradient | CanvasPattern | null { return this.grad; }
  deferredPattern(): ((ctx: Ctx2D) => CanvasPattern) | null { return null; }
  grad: CanvasGradient | CanvasPattern | null = null;
  /** setLocalMatrix: maps shader space into the canvas; null = identity */
  local: [number, number, number, number, number, number] | null = null;
}
const isIdentityM = (m: number[]) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
const shaderIdentity: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
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
const bitmapShaderTiles = new WeakMap<JBitmap, { generation: number; tiles: Map<string, CanvasPattern> }>();
class JBitmapShader extends JShader {
  bitmap!: JBitmap;
  tileX = 0; tileY = 0;
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    const bitmap = this.bitmap;
    let cache = bitmapShaderTiles.get(bitmap);
    if (!cache || cache.generation !== bitmap.genId) {
      cache = { generation: bitmap.genId, tiles: new Map() };
      bitmapShaderTiles.set(bitmap, cache);
    }
    const inverse = ctx.getTransform().inverse();
    const corners = [[0, 0], [ctx.canvas.width, 0], [0, ctx.canvas.height], [ctx.canvas.width, ctx.canvas.height]]
      .map(([x, y]) => inverse.transformPoint({ x, y }));
    if (!corners.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return;
    const segments = (mode: number, size: number, lo: number, hi: number): [number, number, number, number][] => {
      if (mode === 1 || mode === 2) return [[lo, hi, 0, size]];
      const result: [number, number, number, number][] = [[Math.max(0, lo), Math.min(size, hi), 0, size]];
      if (mode === 0) result.push([lo, Math.min(0, hi), 0, 1], [Math.max(size, lo), hi, size - 1, 1]);
      return result;
    };
    const xs = segments(this.tileX, bitmap.w, Math.min(...corners.map(p => p.x)), Math.max(...corners.map(p => p.x)));
    const ys = segments(this.tileY, bitmap.h, Math.min(...corners.map(p => p.y)), Math.max(...corners.map(p => p.y)));
    for (const [x0, x1, sx, sw] of xs) for (const [y0, y1, sy, sh] of ys) {
      if (x1 <= x0 || y1 <= y0) continue;
      const nx = this.tileX === 2 ? 2 : 1, ny = this.tileY === 2 ? 2 : 1;
      const key = `${sx},${sy},${sw},${sh},${nx},${ny}`;
      let pattern = cache.tiles.get(key);
      if (!pattern) {
        let tile = bitmap.canvas;
        if (sx !== 0 || sy !== 0 || sw !== bitmap.w || sh !== bitmap.h || nx !== 1 || ny !== 1) {
          tile = new OffscreenCanvas(sw * nx, sh * ny);
          const c = tile.getContext("2d")!;
          for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
            c.setTransform(x ? -1 : 1, 0, 0, y ? -1 : 1, x ? sw * 2 : 0, y ? sh * 2 : 0);
            c.drawImage(bitmap.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
          }
        }
        pattern = ctx.createPattern(tile, "repeat")!;
        cache.tiles.set(key, pattern);
      }
      ctx.fillStyle = pattern;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  pattern(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): CanvasPattern {
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
rt.register({ name: "android/graphics/BitmapShader", ctor: JBitmapShader, sup: "android/graphics/Shader", methods: {
  "<init>(Landroid/graphics/Bitmap;Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V": function (this: JBitmapShader, bitmap: JBitmap, x: JSimpleEnum, y: JSimpleEnum) {
    if (!x || !y) throw rt.mkThrowable("java/lang/NullPointerException", null);
    if (!bitmap) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bitmap must be non-null");
    if (bitmap.recycled) throw rt.mkThrowable("java/lang/IllegalStateException", "Cannot create BitmapShader for recycled bitmap");
    this.bitmap = bitmap; this.tileX = x.ord; this.tileY = y.ord;
  },
} });
/**
 * A ColorLong is Color.pack()'s encoding: the sRGB case (colour-space id 0, the only one this
 * canvas has) is the ARGB int in the top 32 bits, which is what getColorLong writes.
 */
export const argbOfColorLong = (v: bigint) => Number(BigInt.asUintN(32, v >> 32n)) | 0;
export const colorLongOfArgb = (c: number) => BigInt.asIntN(64, BigInt(c >>> 0) << 32n);

function gradientStops(g: CanvasGradient, colors: ArrayLike<number>, stops: ArrayLike<number> | null): CanvasGradient {
  if (colors.length < 2 || (stops && stops.length !== colors.length)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid gradient colors or positions");
  for (let i = 0; i < colors.length; i++) g.addColorStop(stops ? stops[i] : i / (colors.length - 1), cssColor(colors[i]));
  return g;
}
function gradientSpec(name: string, geom: string, tile: string, make: (a: number[]) => CanvasGradient): NativeSpec {
  const n = geom.length, sig = (c: string) => `<init>(${geom}${c}${tile})V`;
  const init = (colors: (a: any[]) => ArrayLike<number>, stops: (a: any[]) => ArrayLike<number> | null) =>
    function (this: JShader, ...a: any[]) { this.grad = gradientStops(make(a), colors(a), stops(a)); };
  return {
    name: "android/graphics/" + name, ctor: class extends JShader {}, sup: "android/graphics/Shader",
    methods: {
      [sig("II")]: init((a) => [a[n], a[n + 1]], () => null),
      [sig("[I[F")]: init((a) => a[n], (a) => a[n + 1]),
      [sig("JJ")]: init((a) => [argbOfColorLong(a[n]), argbOfColorLong(a[n + 1])], () => null),
      [sig("[J[F")]: init((a) => Array.from(a[n] as BigInt64Array, argbOfColorLong), (a) => a[n + 1]),
    },
  };
}
rt.register(gradientSpec("SweepGradient", "FF", "", (a) => measureCtx().createConicGradient(0, a[0], a[1])));
rt.register(gradientSpec("LinearGradient", "FFFF", "Landroid/graphics/Shader$TileMode;", (a) => measureCtx().createLinearGradient(a[0], a[1], a[2], a[3])));
rt.register(gradientSpec("RadialGradient", "FFF", "Landroid/graphics/Shader$TileMode;", (a) => measureCtx().createRadialGradient(a[0], a[1], 0, a[0], a[1], a[2])));

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
const translateA = (x: number, y: number): JMatrix["m"] => [1, 0, 0, 1, x, y];
const scaleA = (sx: number, sy: number, px = 0, py = 0): JMatrix["m"] => [sx, 0, 0, sy, px - sx * px, py - sy * py];
const skewA = (kx: number, ky: number, px = 0, py = 0): JMatrix["m"] => [1, ky, kx, 1, -kx * py, -ky * px];
function affineOps(name: string, make: (a: number, b: number, c?: number, d?: number) => JMatrix["m"], sigs: string[]) {
  const ops: NativeSpec["methods"] = {};
  for (const s of sigs) {
    ops[`set${name}(${s})V`] = function (this: JMatrix, a: number, b?: number, c?: number, d?: number) { this.m = make(a, b as number, c, d); };
    ops[`pre${name}(${s})Z`] = function (this: JMatrix, a: number, b?: number, c?: number, d?: number) { this.m = matMul(this.m, make(a, b as number, c, d)); return 1; };
    ops[`post${name}(${s})Z`] = function (this: JMatrix, a: number, b?: number, c?: number, d?: number) { this.m = matMul(make(a, b as number, c, d), this.m); return 1; };
  }
  return ops;
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
function mapMatrixRect(this: JMatrix, dst: JRectF | null, src: JRectF | null): number {
  if (!dst || !src) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const m = this.m, l = src.left, t = src.top, r = src.right, b = src.bottom;
  const x0 = m[0] * l + m[2] * t + m[4], y0 = m[1] * l + m[3] * t + m[5];
  const x1 = m[0] * r + m[2] * t + m[4], y1 = m[1] * r + m[3] * t + m[5];
  const x2 = m[0] * l + m[2] * b + m[4], y2 = m[1] * l + m[3] * b + m[5];
  const x3 = m[0] * r + m[2] * b + m[4], y3 = m[1] * r + m[3] * b + m[5];
  dst.left = Math.min(x0, x1, x2, x3); dst.right = Math.max(x0, x1, x2, x3);
  dst.top = Math.min(y0, y1, y2, y3); dst.bottom = Math.max(y0, y1, y2, y3);
  return (m[1] === 0 && m[2] === 0) || (m[0] === 0 && m[3] === 0) ? 1 : 0;
}
rt.register({
  name: "android/graphics/Matrix", ctor: JMatrix,
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/graphics/Matrix;)V": function (this: JMatrix, o: JMatrix) { if (o) this.m = [...o.m]; },
    "reset()V": function (this: JMatrix) { this.m = [1, 0, 0, 1, 0, 0]; },
    "set(Landroid/graphics/Matrix;)V": function (this: JMatrix, o: JMatrix | null) { this.m = o ? [...o.m] : [1, 0, 0, 1, 0, 0]; },
    "isIdentity()Z": function (this: JMatrix) { return isIdentityM(this.m) ? 1 : 0; },
    "setPolyToPoly([FI[FII)Z": function (this: JMatrix, src: Float32Array, si: number, dst: Float32Array, di: number, count: number) {
      if (count > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      if (count < 0 || si < 0 || di < 0 || si + count * 2 > src.length || di + count * 2 > dst.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
      const matrix = affineFromPoints(src, si, dst, di, count);
      if (!matrix) return 0;
      this.m = matrix; return 1;
    },
    ...affineOps("Translate", translateA, ["FF"]),
    ...affineOps("Scale", scaleA, ["FF", "FFFF"]),
    ...affineOps("Skew", skewA, ["FF", "FFFF"]),
    ...affineOps("Rotate", rotM, ["F", "FFF"]),
    "postConcat(Landroid/graphics/Matrix;)Z": function (this: JMatrix, o: JMatrix) {
      this.m = matMul(o.m, this.m);
      return 1;
    },
    "preConcat(Landroid/graphics/Matrix;)Z": function (this: JMatrix, o: JMatrix) {
      this.m = matMul(this.m, o.m);
      return 1;
    },
    "setConcat(Landroid/graphics/Matrix;Landroid/graphics/Matrix;)Z": function (this: JMatrix, a: JMatrix, b: JMatrix) {
      this.m = matMul(a.m, b.m);
      return 1;
    },
    // AOSP Matrix.setRectToRect: an empty source resets and fails; FILL scales each axis to
    // the destination, the others scale uniformly and place the result at START/CENTER/END
    "setRectToRect(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z": function (this: JMatrix, src: JRectF, dst: JRectF, fit: JSimpleEnum) {
      if (!src || !dst) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const sw = src.right - src.left, sh = src.bottom - src.top;
      if (!(sw > 0 && sh > 0)) { this.m = [1, 0, 0, 1, 0, 0]; return 0; }
      const dw = dst.right - dst.left, dh = dst.bottom - dst.top;
      let sx = dw / sw, sy = dh / sh, tx = 0, ty = 0;
      if (fit.ord !== 0) {
        const s = Math.min(sx, sy); sx = sy = s;
        const extraX = dw - sw * s, extraY = dh - sh * s, share = fit.ord === 2 ? 0.5 : fit.ord === 3 ? 1 : 0;
        tx = extraX * share; ty = extraY * share;
      }
      this.m = [sx, 0, 0, sy, dst.left - src.left * sx + tx, dst.top - src.top * sy + ty];
      return 1;
    },
    "mapRect(Landroid/graphics/RectF;)Z": function (this: JMatrix, rect: JRectF) { return mapMatrixRect.call(this, rect, rect); },
    "mapRect(Landroid/graphics/RectF;Landroid/graphics/RectF;)Z": mapMatrixRect,
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

// Canvas pixels are straight RGBA; the NDK exposes the bitmap's declared alpha representation.
export function copyBitmapPixels(src: ArrayLike<number>, dst: Uint8Array | Uint8ClampedArray, alpha: number, decode: boolean) {
  if (alpha === 2) { dst.set(src); return; }
  for (let i = 0; i < dst.length; i += 4) {
    const a = alpha === 1 ? 255 : src[i + 3], scale = a === 0 ? 0 : decode ? 255 / a : a / 255;
    dst[i] = Math.round(src[i] * scale);
    dst[i + 1] = Math.round(src[i + 1] * scale);
    dst[i + 2] = Math.round(src[i + 2] * scale);
    dst[i + 3] = a;
  }
}

export class JBitmap extends JObj {
  w = 0; h = 0;
  density = device.densityDpi;
  recycled = false;
  /** AOSP's native config numbering, not Bitmap.Config's ordinal. */
  config = 5;
  hasAlpha = true; premultiplied = true; immutable = false; shared = false; mipmap = false;
  genId = 0;
  get rowBytes() { return this.w * (this.config === 1 ? 1 : 4); }
  private cv: OffscreenCanvas | null = null;
  private cx: OffscreenCanvasRenderingContext2D | null = null;
  private drawingCtx: OffscreenCanvasRenderingContext2D | null = null;
  private px: RGBA | null = null;

  /** The raster, made on demand. A bitmap that is only written and read as pixels never needs
   *  one — and outside a browser there is no OffscreenCanvas to make. Handing it out drops the
   *  pixel memo, because whoever took it may draw. */
  get canvas(): OffscreenCanvas {
    if (!this.cv) {
      this.cv = new OffscreenCanvas(this.w, this.h);
      this.cx = this.cv.getContext("2d", { willReadFrequently: true })!;
      if (this.px) this.cx.putImageData(new ImageData(this.px, this.w, this.h), 0, 0);
    }
    this.px = null;
    return this.cv;
  }
  get ctx(): OffscreenCanvasRenderingContext2D {
    void this.canvas;
    if (!this.drawingCtx) {
      // Canvas retains this context across draws, after pixel readbacks and shader snapshots.
      const methods = new Map<PropertyKey, unknown>();
      this.drawingCtx = new Proxy(this.cx!, {
        get: (ctx, key) => {
          const value = Reflect.get(ctx, key, ctx);
          if (typeof value !== "function") return value;
          if (!methods.has(key)) {
            const writes = /^(?:draw|fill|stroke|clearRect|putImageData|reset$)/.test(String(key));
            methods.set(key, (...args: unknown[]) => {
              if (writes) { this.px = null; this.genId++; }
              return Reflect.apply(value, ctx, args);
            });
          }
          return methods.get(key);
        },
        set: (ctx, key, value) => Reflect.set(ctx, key, value, ctx),
      });
    }
    return this.drawingCtx;
  }
  /** AOSP reconfigure: the same object with new dimensions and undefined contents */
  reconfigure(w: number, h: number) { this.w = w; this.h = h; this.cv = null; this.cx = null; this.drawingCtx = null; this.px = null; this.genId++; }

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
export function extractBitmapAlpha(src: JBitmap, paint: JPaint | null, offsets: Int32Array | null): JBitmap {
  if (src.recycled) throw rt.mkThrowable("java/lang/IllegalStateException", "Can't extractAlpha on a recycled bitmap");
  const filter = paint?.maskFilter ?? null, border = filter && filter.style !== 3 ? filter.border() : 0;
  const b = JBitmap.create(src.w + 2 * border, src.h + 2 * border);
  b.config = 1; b.density = src.density;
  if (filter) {
    const ctx = b.ctx;
    blurMask(ctx, src.canvas, filter, border, border);
    ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, b.w, b.h);
    ctx.globalCompositeOperation = "source-over";
  } else {
    const source = src.pixels(), target = b.pixels();
    for (let i = 3; i < target.length; i += 4) target[i] = source[i];
  }
  if (offsets && offsets.length >= 2) { offsets[0] = -border; offsets[1] = -border; }
  return b;
}
function bitmapBuffer(bitmap: JBitmap, buffer: JBuffer, from: boolean): void {
  if (bitmap.recycled || bitmap.config === 7) throw rt.mkThrowable("java/lang/IllegalStateException", "Bitmap pixels unavailable");
  if (from && bitmap.immutable) throw rt.mkThrowable("java/lang/IllegalStateException", "Bitmap is immutable");
  if (!buffer) rt.npe();
  if (!["ByteBuffer", "ShortBuffer", "IntBuffer"].some((name) => rt.iof(buffer, "java/nio/" + name)))
    throw rt.mkThrowable("java/lang/RuntimeException", "unsupported Buffer subclass");
  const length = bitmap.rowBytes * bitmap.h;
  if ((buffer.lim - buffer.pos) * 2 ** buffer.elemShift < length)
    throw rt.mkThrowable("java/lang/RuntimeException", "Buffer not large enough for pixels");
  const view = buffer.dv, bytes = u8(view, buffer.pos * 2 ** buffer.elemShift, length);
  const pixels = bitmap.pixels(), alpha = !bitmap.hasAlpha ? 1 : bitmap.premultiplied ? 0 : 2;
  if (bitmap.config === 1) {
    for (let i = 0; i < length; i++) {
      if (from) pixels[i * 4 + 3] = bytes[i];
      else bytes[i] = pixels[i * 4 + 3];
    }
  } else if (from) copyBitmapPixels(bytes, pixels, alpha, true);
  else copyBitmapPixels(pixels, bytes, alpha, false);
  if (from) bitmap.commit(0, 0, bitmap.w, bitmap.h);
  buffer.pos += length >> buffer.elemShift;
}

/** Exported for the same reason canvasMethods is: AOSP's own Bitmap bytecode reaches these
 *  bodies through its native* delegates (src/android/delegates.ts), not a second copy. */
export const bitmapMethods: NativeSpec["methods"] = {
    "copyPixelsToBuffer(Ljava/nio/Buffer;)V": function (this: JBitmap, b: JBuffer) { bitmapBuffer(this, b, false); },
    "copyPixelsFromBuffer(Ljava/nio/Buffer;)V": function (this: JBitmap, b: JBuffer) { bitmapBuffer(this, b, true); },
    "reconfigure(IILandroid/graphics/Bitmap$Config;)V": function (this: JBitmap, w: number, h: number) { this.reconfigure(w, h); },
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
    "getColorSpace()Landroid/graphics/ColorSpace;": () => srgbSpace,
    "getDensity()I": function (this: JBitmap) { return this.density; },
    "setDensity(I)V": function (this: JBitmap, d: number) { this.density = d; },
    "getScaledWidth(I)I": function (this: JBitmap, td: number) { return Math.round(this.w * td / this.density); },
    "getScaledHeight(I)I": function (this: JBitmap, td: number) { return Math.round(this.h * td / this.density); },
    "recycle()V": function (this: JBitmap) { this.recycled = true; },
    "isRecycled()Z": function (this: JBitmap) { return this.recycled ? 1 : 0; },
    "sameAs(Landroid/graphics/Bitmap;)Z": function (this: JBitmap, other: JBitmap | null) {
      if (this === other) return 1;
      if (!other || this.w !== other.w || this.h !== other.h || this.config !== other.config) return 0;
      const a = this.pixels(), b = other.pixels();
      const aw = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >>> 2);
      const bw = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >>> 2);
      for (let i = 0; i < aw.length; i++) if (aw[i] !== bw[i]) return 0;
      return 1;
    },
    "getPixel(II)I": function (this: JBitmap, x: number, y: number) {
      return argbAt(this.pixels(), (y * this.w + x) * 4);
    },
    "setPixel(III)V": function (this: JBitmap, x: number, y: number, c: number) {
      if (this.immutable) throw rt.mkThrowable("java/lang/IllegalStateException", "Bitmap is immutable");
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
      if (this.immutable) throw rt.mkThrowable("java/lang/IllegalStateException", "Bitmap is immutable");
      const d = this.pixels();
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) putArgb(d, ((y + row) * this.w + x + col) * 4, src[off + row * stride + col]);
      }
      this.commit(x, y, w, h);
    },
    "eraseColor(I)V": function (this: JBitmap, c: number) {
      if (this.immutable) throw rt.mkThrowable("java/lang/IllegalStateException", "Bitmap is immutable");
      const d = this.pixels();
      for (let i = 0; i < d.length; i += 4) putArgb(d, i, c);
      this.commit(0, 0, this.w, this.h);
    },
    "extractAlpha()Landroid/graphics/Bitmap;": function (this: JBitmap) { return extractBitmapAlpha(this, null, null); },
    "extractAlpha(Landroid/graphics/Paint;[I)Landroid/graphics/Bitmap;": function (this: JBitmap, paint: JPaint | null, offsets: Int32Array | null) { return extractBitmapAlpha(this, paint, offsets); },
    "copy(Landroid/graphics/Bitmap$Config;Z)Landroid/graphics/Bitmap;": function (this: JBitmap) {
      const b = JBitmap.create(this.w, this.h);
      b.ctx.drawImage(this.canvas, 0, 0);
      return b;
    },
    "asShared()Landroid/graphics/Bitmap;": function (this: JBitmap) {
      if (this.recycled) throw rt.mkThrowable("java/lang/IllegalStateException", "Can't copy a recycled bitmap");
      if (this.shared && this.immutable) return this;
      const bitmap = JBitmap.create(this.w, this.h);
      bitmap.pixels().set(this.pixels());
      bitmap.config = this.config; bitmap.density = this.density;
      bitmap.hasAlpha = this.hasAlpha; bitmap.premultiplied = this.premultiplied;
      bitmap.immutable = bitmap.shared = true;
      return bitmap;
    },
    "getConfig()Landroid/graphics/Bitmap$Config;": function (this: JBitmap) { return bitmapConfigs[this.config === 1 ? 0 : 3]; },
    "hasAlpha()Z": function (this: JBitmap) { return this.hasAlpha ? 1 : 0; },
    "setHasAlpha(Z)V": function (this: JBitmap, v: number) { this.hasAlpha = !!v; },
    "setPremultiplied(Z)V": function (this: JBitmap, v: number) { this.premultiplied = !!v; },
    "isMutable()Z": function (this: JBitmap) { return this.immutable ? 0 : 1; },
    "getByteCount()I": function (this: JBitmap) { return this.rowBytes * this.h; },
    "getAllocationByteCount()I": function (this: JBitmap) { return this.rowBytes * this.h; },
    "getRowBytes()I": function (this: JBitmap) { return this.rowBytes; },
    "compress(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z": driven(function* (this: JBitmap, fmt: { ord: number } | null, q: number, out: unknown): Gen {
      if (!fmt) throw rt.npe();
      const type = ["image/jpeg", "image/png", "image/webp"][fmt.ord];
      if (!type) return 0;
      const blob = (yield this.canvas.convertToBlob({ type, quality: Math.max(0, Math.min(1, q / 100)) }));
      if (blob.type !== type) return 0;
      const bytes = new Int8Array((yield blob.arrayBuffer()));
      (yield vcall(out, "write", "([BII)V", bytes, 0, bytes.length));
      return 1;
    }),
    "prepareToDraw()V": () => {},
    "describeContents()I": () => 0,
    // The wire format is Bitmap's own (AOSP writes it natively and only CREATOR reads it), so
    // it carries what the raster needs to come back whole: the flags, geometry and RGBA bytes.
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JBitmap, p: JParcel): Gen {
      if (this.recycled) throw rt.mkThrowable("java/lang/IllegalStateException", "Can't parcel a recycled bitmap");
      for (const v of [this.immutable ? 0 : 1, this.config, this.hasAlpha ? 1 : 0, this.premultiplied ? 1 : 0, this.w, this.h, this.density])
        (yield vcall(p, "writeInt", "(I)V", v));
      (yield vcall(p, "writeByteArray", "([B)V", new Int8Array(this.pixels().buffer, this.pixels().byteOffset, this.w * this.h * 4)));
    }),
};
rt.register({ name: "android/graphics/Bitmap", ctor: JBitmap, ifaces: ["android/os/Parcelable"], methods: bitmapMethods,
  statics: { get CREATOR() { return parcelCreator("android/graphics/Bitmap", async (p) => {
    const f: number[] = [];
    for (let i = 0; i < 7; i++) f.push(await vcall(p, "readInt", "()I"));
    const b = JBitmap.create(f[4], f[5]);
    b.immutable = !f[0]; b.config = f[1]; b.hasAlpha = !!f[2]; b.premultiplied = !!f[3]; b.density = f[6];
    const bytes: Int8Array | null = await vcall(p, "createByteArray", "()[B");
    if (bytes) b.pixels().set(u8(bytes));
    return b;
  }); } } });
mkEnumSet("android/graphics/Matrix$ScaleToFit", ["FILL", "START", "CENTER", "END"]);
const bitmapConfigs = mkEnumSet("android/graphics/Bitmap$Config", ["ALPHA_8", "RGB_565", "ARGB_4444", "ARGB_8888", "RGBA_F16", "HARDWARE", "RGBA_1010102"], {}, undefined, ["nativeInt"]);
bitmapConfigs.forEach((config, i) => Object.assign(config, { nativeInt: i === 0 ? 1 : i + 2 }));
mkEnumSet("android/graphics/Bitmap$CompressFormat", ["JPEG", "PNG", "WEBP"]);

export class JCanvas extends JObj {
  ctx!: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  w = 0; h = 0;
  saveCount = 1;
  clipDevice: [number, number, number, number] | null = null;
  clipStack: ([number, number, number, number] | null)[] = [];
  clipPolygon: [number, number][] | null = null;
  clipPolygonStack: ([number, number][] | null)[] = [];
  bmp: JBitmap | null = null;
  semanticOwner: { drawnText: string[] | null; drawnTextPoints: Float32Array | null; drawnTextCount: number } | null = null;
  semanticBase: [number, number, number, number, number, number] | null = null;
  semanticTransform(): [number, number, number, number, number, number] {
    const m = this.ctx.getTransform();
    const current = [m.a, m.b, m.c, m.d, m.e, m.f];
    return this.semanticBase ? matMul(this.semanticBase, current) : current as [number, number, number, number, number, number];
  }
  recordText(text: string, x?: number, y?: number, size?: number, align = 0) {
    recordOrRun(this.ctx, ctx => {
      const canvas = replayCanvas(ctx) ?? this;
      const owner = canvas.semanticOwner;
      if (!owner) return;
      (owner.drawnText ??= []).push(text);
      if (x === undefined || y === undefined || size === undefined) return;
      const i = owner.drawnTextCount++;
      if (!owner.drawnTextPoints || owner.drawnTextPoints.length < (i + 1) * 2) {
        const next = new Float32Array(Math.max(8, (i + 1) * 4));
        if (owner.drawnTextPoints) next.set(owner.drawnTextPoints);
        owner.drawnTextPoints = next;
      }
      const cx = x + (align === 0 ? size : align === 2 ? -size : 0), cy = y - size * 0.3;
      const m = ctx.getTransform();
      let sx = m.a * cx + m.c * cy + m.e, sy = m.b * cx + m.d * cy + m.f;
      if (canvas.semanticBase) {
        const b = canvas.semanticBase;
        const px = sx;
        sx = b[0] * px + b[2] * sy + b[4];
        sy = b[1] * px + b[3] * sy + b[5];
      }
      owner.drawnTextPoints[i * 2] = sx;
      owner.drawnTextPoints[i * 2 + 1] = sy;
    });
  }

  static wrap(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number): JCanvas {
    const c = new JCanvas();
    c.ctx = ctx; c.w = w; c.h = h;
    return c;
  }
  prep(p: JPaint, stroke: boolean) {
    const ctx = this.ctx;
    const pattern = p.shaderObj?.deferredPattern();
    if (pattern) recordOrRun(ctx, c => { c[stroke ? "strokeStyle" : "fillStyle"] = pattern(c); });
    if (stroke) {
      if (!pattern) ctx.strokeStyle = p.fillStyle(ctx) as string;
      ctx.lineWidth = Math.max(p.strokeWidth, 1);
      ctx.lineCap = p.strokeCapN;
      ctx.lineJoin = p.strokeJoinN;
      ctx.setLineDash(p.dash ?? []);
    } else {
      if (!pattern) ctx.fillStyle = p.fillStyle(ctx) as string;
    }
    return !!pattern || typeof CanvasPattern !== "undefined" && ctx[stroke ? "strokeStyle" : "fillStyle"] instanceof CanvasPattern;
  }
  private blurLayer: { source: JCanvas; target: OffscreenCanvasRenderingContext2D; paint: JPaint } | null = null;
  drawMask(p: JPaint, fill: (ctx: typeof this.ctx) => void, stroke?: (ctx: typeof this.ctx) => void) {
    const ctx = this.ctx, w = ctx.canvas.width, h = ctx.canvas.height, m = ctx.getTransform();
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    if (!w || !h || !scale) return;
    let layer = this.blurLayer;
    if (!layer || layer.source.w !== w || layer.source.h !== h) {
      const source = new OffscreenCanvas(w, h).getContext("2d")!;
      layer = this.blurLayer = { source: JCanvas.wrap(source, w, h), target: new OffscreenCanvas(w, h).getContext("2d")!, paint: new JPaint() };
    }
    const source = layer.source.ctx, target = layer.target;
    source.resetTransform(); source.clearRect(0, 0, w, h); source.setTransform(m);
    copyPaint(p, layer.paint);
    layer.paint.maskFilter = null; layer.paint.blend = null; layer.paint.shadowRadius = 0;
    layer.paint.color = -1; layer.paint.renderAlpha = null; layer.paint.shader = layer.paint.shaderObj = null; layer.paint.filterColor = null; layer.paint.filterMatrix = null;
    if (stroke) layer.source.drawShape(layer.paint, fill, stroke);
    else fill(source);
    target.clearRect(0, 0, w, h);
    blurMask(target, source.canvas, p.maskFilter, 0, 0, scale);
    target.globalCompositeOperation = "source-in";
    try {
      if (p.shader || p.shaderObj) {
        source.resetTransform(); source.clearRect(0, 0, w, h); source.setTransform(m);
        copyPaint(p, layer.paint);
        layer.paint.maskFilter = null; layer.paint.blend = null; layer.paint.shadowRadius = 0; layer.paint.style = 0;
        const inverse = m.inverse();
        const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => inverse.transformPoint({ x, y }));
        const left = Math.min(...corners.map(p => p.x)), top = Math.min(...corners.map(p => p.y));
        layer.source.drawShape(layer.paint, c => c.fillRect(left, top, Math.max(...corners.map(p => p.x)) - left, Math.max(...corners.map(p => p.y)) - top), () => {});
        target.drawImage(source.canvas, 0, 0);
      } else {
        target.fillStyle = p.fillStyle(target);
        target.fillRect(0, 0, w, h);
      }
    } finally { target.globalCompositeOperation = "source-over"; }
    ctx.save();
    const shadow = beginPaintShadow(ctx, p);
    try {
      if (p.blend) ctx.globalCompositeOperation = p.blend;
      ctx.resetTransform(); ctx.drawImage(target.canvas, 0, 0);
    } finally { if (shadow) ctx.restore(); ctx.restore(); }
  }
  drawShape(p: JPaint, fill: (ctx: typeof this.ctx) => void, stroke: (ctx: typeof this.ctx) => void) {
    if (tryPartialSourceIn(this, p, fill, stroke)) return;
    if (tryBitmapShape(this, p, fill, stroke)) return;
    if (p.maskFilter?.style) return this.drawMask(p, fill, stroke);
    if (p.transparentSourceIn() && !p.maskFilter && !p.shadowRadius) {
      const ctx = this.ctx;
      ctx.save();
      try {
        ctx.globalCompositeOperation = "destination-out";
        if (p.style !== 1) { this.prep(p, false); ctx.fillStyle = "#000"; fill(ctx); }
        if (p.style !== 0 && (p.style !== 2 || p.strokeWidth !== 0)) {
          this.prep(p, true); ctx.strokeStyle = "#000"; stroke(ctx);
        }
      } finally { ctx.restore(); }
      return;
    }
    // A blended paint owns the composite op only for its own ops — restore it straight after,
    // so a CLEAR fill can never leak into the next drawImage/drawText and erase it.
    const shadow = beginPaintShadow(this.ctx, p);
    const blend = p.compositeOp();
    const prev = blend ? this.ctx.globalCompositeOperation : null;
    const filter = p.maskFilter ? this.ctx.filter : null;
    if (p.maskFilter) {
      const m = this.ctx.getTransform();
      this.ctx.filter = `blur(${p.maskFilter.sigma * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))}px)`;
    }
    try {
      if (blend) this.ctx.globalCompositeOperation = blend;
      if (p.style === 0 || p.style === 2) {
        const lm = p.shaderObj?.local;
        if (p.shaderObj instanceof JBitmapShader) fill(this.shaderClipCtx(lm ?? shaderIdentity, p.shaderObj));
        else {
          const pattern = this.prep(p, false);
          // a gradient with a local matrix: Canvas2D gradients have no transform of their own, so
          // clip to the shape and fill the plane under the matrix instead
          fill(lm && !pattern ? this.shaderClipCtx(lm) : this.ctx);
        }
      }
      if (p.style === 1 || (p.style === 2 && p.strokeWidth !== 0)) { this.prep(p, true); stroke(this.ctx); }
    } finally {
      if (prev) this.ctx.globalCompositeOperation = prev;
      if (filter !== null) this.ctx.filter = filter;
      if (shadow) this.ctx.restore();
    }
  }
  private shaderCtx: (typeof this.ctx) | null = null;
  private shaderBaseCtx: (typeof this.ctx) | null = null;
  private shaderCtxLm: number[] | null = null;
  private bitmapShader: JBitmapShader | undefined;
  shaderClipCtx(lm: [number, number, number, number, number, number], bitmap?: JBitmapShader): typeof this.ctx {
    const ctx = this.ctx;
    const under = (clip: (c: typeof ctx) => void) => {
      ctx.save();
      clip(ctx);
      ctx.transform(lm[0], lm[1], lm[2], lm[3], lm[4], lm[5]);
      if (bitmap) bitmap.draw(ctx);
      else ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
      ctx.restore();
    };
    if (!this.shaderCtx || this.shaderBaseCtx !== ctx || this.shaderCtxLm !== lm || this.bitmapShader !== bitmap) {
      this.shaderBaseCtx = ctx;
      this.shaderCtxLm = lm;
      this.bitmapShader = bitmap;
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

type DrawnTextOwner = {
  drawnText: string[] | null;
  drawnTextPoints: Float32Array | null;
  drawnTextCount: number;
};

export function locateDrawnText(owner: DrawnTextOwner, text: string, width: number, height: number): JPoint | null {
  const runs = owner.drawnText;
  const points = owner.drawnTextPoints;
  const count = Math.min(owner.drawnTextCount, runs?.length ?? 0);
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = normalize(text);
  if (!runs || !points || !count || !want) return null;

  let best = 0, bestIndex = -1;
  const score = (candidate: string) => candidate === want ? 3 : candidate.startsWith(want) ? 2 : candidate.includes(want) ? 1 : 0;
  const consider = (candidate: string, index: number) => {
    const s = score(candidate);
    const x = points[index * 2], y = points[index * 2 + 1];
    if (s > best && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < width && y >= 0 && y < height) {
      best = s;
      bestIndex = index;
    }
  };

  for (let i = 0; i < count; i++) consider(normalize(runs[i]), i);
  for (let i = 0; i < count; i++) {
    let phrase = normalize(runs[i]);
    for (let j = i + 1; j < count; j++) {
      phrase += " " + normalize(runs[j]);
      consider(phrase, i);
    }
  }
  return bestIndex < 0 ? null : { x: points[bestIndex * 2], y: points[bestIndex * 2 + 1] };
}
// ── Canvas method bodies shared by several overloads
export function saveCanvas(cv: JCanvas): number {
  cv.ctx.save();
  cv.clipStack.push(cv.clipDevice);
  cv.clipPolygonStack.push(cv.clipPolygon);
  return cv.saveCount++;
}
export function restoreCanvas(cv: JCanvas): void {
  if (cv.saveCount <= 1) throw rt.mkThrowable("java/lang/IllegalStateException", "Underflow in restore - more restores than saves");
  cv.ctx.restore();
  cv.clipDevice = cv.clipStack.pop() ?? null;
  cv.clipPolygon = cv.clipPolygonStack.pop() ?? null;
  cv.saveCount--;
}
export function restoreCanvasToCount(cv: JCanvas, count: number): void {
  if (count < 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Underflow in restoreToCount - more restores than saves");
  while (cv.saveCount > count) {
    cv.ctx.restore(); cv.clipDevice = cv.clipStack.pop() ?? null;
    cv.clipPolygon = cv.clipPolygonStack.pop() ?? null; cv.saveCount--;
  }
}
function canvasSave(this: JCanvas): number {
  return saveCanvas(this);
}
/** run a transform about (px, py) instead of the origin */
function aboutPivot(ctx: JCanvas["ctx"], px: number, py: number, f: () => void) {
  ctx.translate(px, py); f(); ctx.translate(-px, -py);
}
export function clipEmptyCanvas(ctx: JCanvas["ctx"]) {
  const m = ctx.getTransform();
  ctx.resetTransform();
  ctx.beginPath();
  ctx.rect(ctx.canvas.width + 1, ctx.canvas.height + 1, 1, 1);
  ctx.clip();
  ctx.setTransform(m);
}
type ClipPoint = [number, number];
function intersectClip(subject: ClipPoint[], shape: ClipPoint[]): ClipPoint[] {
  let out = subject;
  const orientation = Math.sign(shape.reduce((sum, point, i) => {
    const next = shape[(i + 1) % shape.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0));
  if (!orientation) return [];
  for (let i = 0; i < shape.length && out.length; i++) {
    const a = shape[i]!, b = shape[(i + 1) % shape.length]!;
    const side = (p: ClipPoint) => orientation * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const prev = input[(j + input.length - 1) % input.length]!, cur = input[j]!;
      const before = side(prev), after = side(cur);
      if ((before < 0) !== (after < 0)) {
        const t = before / (before - after);
        out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
      }
      if (after >= 0) out.push(cur);
    }
  }
  return out;
}
function clipRect(this: JCanvas, l: number, t: number, r: number, b: number) {
  const ctx = this.ctx;
  const m = ctx.getTransform();
  if (r === l || b === t || !(m.a * m.d - m.b * m.c)) {
    this.clipDevice = [0, 0, 0, 0];
    this.clipPolygon = [];
    clipEmptyCanvas(ctx);
    return 0;
  }
  ctx.beginPath();
  ctx.rect(l, t, r - l, b - t);
  ctx.clip();
  const x = m.a * l + m.c * t + m.e, y = m.b * l + m.d * t + m.f;
  const wx = m.a * (r - l), wy = m.b * (r - l);
  const hx = m.c * (b - t), hy = m.d * (b - t);
  const old = this.clipDevice;
  const left = Math.max(old?.[0] ?? 0, Math.round(x + Math.min(0, wx) + Math.min(0, hx)));
  const top = Math.max(old?.[1] ?? 0, Math.round(y + Math.min(0, wy) + Math.min(0, hy)));
  const right = Math.min(old?.[2] ?? this.w, Math.round(x + Math.max(0, wx) + Math.max(0, hx)));
  const bottom = Math.min(old?.[3] ?? this.h, Math.round(y + Math.max(0, wy) + Math.max(0, hy)));
  this.clipDevice = right > left && bottom > top ? [left, top, right, bottom] : [0, 0, 0, 0];
  if (this.clipDevice[2] > this.clipDevice[0] && this.clipDevice[3] > this.clipDevice[1]) {
    const shape: ClipPoint[] = [[x, y], [x + wx, y + wy], [x + wx + hx, y + wy + hy], [x + hx, y + hy]];
    this.clipPolygon = intersectClip(this.clipPolygon ?? [[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]], shape);
  } else this.clipPolygon = [];
  return +(right > left && bottom > top);
}
function clipOutRect(this: JCanvas, l: number, t: number, r: number, b: number) {
  if (!(r > l && b > t)) return 1;
  const excluded = new Path2D();
  excluded.rect(l, t, r - l, b - t);
  const apply = (ctx: Ctx2D) => {
    const matrix = ctx.getTransform(), inverse = new Path2D();
    inverse.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    inverse.addPath(excluded, matrix);
    ctx.resetTransform();
    try { ctx.clip(inverse, "evenodd"); }
    finally { ctx.setTransform(matrix); }
  };
  // RenderNode replay supplies the parent transform and the actual destination bounds.
  recordOrRun(this.ctx, apply);
  return 1;
}
function clipPath(this: JCanvas, path: JPath): number {
  if (path.inverseFill) {
    const bounds = canvasLocalBounds(this.ctx);
    if (!bounds) return 0;
    const [inverse, rule] = inversePath(path, ...bounds);
    this.ctx.clip(inverse, rule);
  } else this.ctx.clip(path.path(), path.fillRule);
  return 1;
}
// Canvas2D exposes no clip region; rectangular clips retain a device-space bound.
function viewportClipBounds(cv: JCanvas, out: JRect): number {
  const matrix = cv.ctx.getTransform();
  const a = Math.fround(matrix.a), b = Math.fround(matrix.b);
  const c = Math.fround(matrix.c), d = Math.fround(matrix.d);
  const e = Math.fround(matrix.e), f = Math.fround(matrix.f);
  const det = a * d - b * c;
  const polygon = cv.clipPolygon;
  const clip = cv.clipDevice;
  let left = clip?.[0] ?? 0, top = clip?.[1] ?? 0;
  let right = clip?.[2] ?? cv.w, bottom = clip?.[3] ?? cv.h;
  if (polygon) {
    const minY = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1]))));
    const maxY = Math.min(cv.h, Math.ceil(Math.max(...polygon.map(p => p[1]))));
    left = top = Infinity; right = bottom = -Infinity;
    for (let y = minY; y < maxY; y++) {
      const at = y + 0.5;
      let minX = Infinity, maxX = -Infinity;
      for (let i = 0; i < polygon.length; i++) {
        const [ax, ay] = polygon[i]!, [bx, by] = polygon[(i + 1) % polygon.length]!;
        if ((ay <= at && at < by) || (by <= at && at < ay)) {
          const x = ax + (at - ay) * (bx - ax) / (by - ay);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        }
      }
      if (minX === maxX || !Number.isFinite(minX)) continue;
      const x0 = Math.max(0, Math.floor(minX - 0.5) + 1);
      const x1 = Math.min(cv.w, Math.ceil(maxX - 0.5));
      if (x0 >= x1) continue;
      left = Math.min(left, x0); right = Math.max(right, x1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
    }
  }
  if (!det || !Number.isFinite(det) || !(right > left && bottom > top)) {
    out.left = out.top = out.right = out.bottom = 0;
    return 0;
  }
  const dx = left - e, dy = top - f;
  const ox = (d * dx - c * dy) / det, oy = (a * dy - b * dx) / det;
  const wx = d * (right - left) / det, wy = -b * (right - left) / det;
  const hx = -c * (bottom - top) / det, hy = a * (bottom - top) / det;
  out.left = Math.round(ox + Math.min(0, wx) + Math.min(0, hx));
  out.top = Math.round(oy + Math.min(0, wy) + Math.min(0, hy));
  out.right = Math.round(ox + Math.max(0, wx) + Math.max(0, hx));
  out.bottom = Math.round(oy + Math.max(0, wy) + Math.max(0, hy));
  return 1;
}
function drawRect(this: JCanvas, l: number, t: number, r: number, b: number, p: JPaint) {
  const left = Math.min(l, r), top = Math.min(t, b), width = Math.abs(r - l), height = Math.abs(b - t);
  if ((!width || !height) && p.style !== 1) return;
  if (tryBitmapRect(this, p, left, top, left + width, top + height)) return;
  if (p.blend === "source-in" && p.style === 0) {
    const shape = new Path2D();
    shape.rect(left, top, width, height);
    this.ctx.save();
    try {
      this.ctx.clip(shape);
      this.drawShape(p, (c) => c.fill(shape), (c) => c.stroke(shape));
    } finally { this.ctx.restore(); }
    return;
  }
  this.drawShape(p, (c) => c.fillRect(left, top, width, height), (c) => c.strokeRect(left, top, width, height));
}
function drawColor(this: JCanvas, color: number, clear = false) {
  const fill = cssColor(color);
  const apply = (ctx: Ctx2D) => {
    ctx.save();
    ctx.resetTransform();
    if (clear) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    else { ctx.fillStyle = fill; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
    ctx.restore();
  };
  recordOrRun(this.ctx, apply);
}
/** ellipse arc in the box; a full sweep without the centre is drawOval */
function drawArc(this: JCanvas, l: number, t: number, r: number, b: number, start: number, sweep: number, useCenter: number, p: JPaint) {
  if (!(r > l && b > t) && Math.abs(sweep) < 360) return;
  const left = Math.min(l, r), top = Math.min(t, b), right = Math.max(l, r), bottom = Math.max(t, b);
  if (tryBitmapOval(this, p, left, top, right, bottom, sweep)) return;
  const path = new Path2D();
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  if (useCenter) path.moveTo(cx, cy);
  path.ellipse(cx, cy, (right - left) / 2, (bottom - top) / 2, 0, start * Math.PI / 180, (start + sweep) * Math.PI / 180, sweep < 0);
  if (useCenter) path.closePath();
  this.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
}
function drawOval(this: JCanvas, l: number, t: number, r: number, b: number, p: JPaint) {
  if (l === r || t === b) return;
  drawArc.call(this, Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b), 0, 360, 0, p);
}
function drawRoundRect(this: JCanvas, l: number, t: number, r: number, b: number, rx: number, ry: number, p: JPaint) {
  const left = Math.min(l, r), top = Math.min(t, b), width = Math.abs(r - l), height = Math.abs(b - t);
  if ((!width || !height) && p.style !== 1) return;
  if (tryBitmapRoundRect(this, p, left, top, left + width, top + height, rx, ry)) return;
  const path = new Path2D();
  path.roundRect(left, top, width, height, { x: Math.max(rx, 0), y: Math.max(ry, 0) });
  this.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
}
function drawBitmapRect(this: JCanvas, b: JBitmap, src: JRect | null, dst: JRect | JRectF, p: JPaint | null) {
  const s = src ?? { left: 0, top: 0, right: b.w, bottom: b.h };
  drawBitmap(this, b, p, (ctx, image) => ctx.drawImage(image, s.left, s.top, s.right - s.left, s.bottom - s.top,
    dst.left, dst.top, dst.right - dst.left, dst.bottom - dst.top));
}
const defaultBitmapPaint = new JPaint();
function canvasLocalBounds(ctx: JCanvas["ctx"]): [number, number, number, number] | null {
  const inverse = ctx.getTransform().inverse();
  const points = [[0, 0], [ctx.canvas.width, 0], [0, ctx.canvas.height], [ctx.canvas.width, ctx.canvas.height]]
    .map(([x, y]) => inverse.transformPoint({ x, y }));
  if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  return [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)),
    Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y))];
}
function drawPaint(this: JCanvas, paint: JPaint) {
  const bounds = canvasLocalBounds(this.ctx);
  if (!bounds) return;
  const [l, t, r, b] = bounds;
  const p = new JPaint(); copyPaint(paint, p); p.style = 0; p.maskFilter = null;
  this.drawShape(p, c => c.fillRect(l, t, r - l, b - t), () => {});
}
function drawBitmap(canvas: JCanvas, b: JBitmap, paint: JPaint | null, draw: (ctx: Ctx2D, image: OffscreenCanvas) => void) {
  if (b.config === 1) {
    const mask = (ctx: Ctx2D) => draw(ctx, b.canvas);
    canvas.drawMask(paint ?? defaultBitmapPaint, mask);
  } else draw(canvas.ctx, tintedBmp(b, paint?.filterColor ?? null, paint?.filterMatrix ?? null));
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
  "drawPaint(Landroid/graphics/Paint;)V": drawPaint,
  "<init>()V": function (this: JCanvas) { setCanvasBitmap(this, null); },
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
  "save()I": canvasSave,
  // layers are drawn straight through: a saveLayer is just a save
  "saveLayer(Landroid/graphics/RectF;Landroid/graphics/Paint;)I": canvasSave,
  "saveLayer(FFFFLandroid/graphics/Paint;)I": canvasSave,
  "saveLayer(FFFFLandroid/graphics/Paint;I)I": canvasSave,
  "saveLayer(Landroid/graphics/RectF;Landroid/graphics/Paint;I)I": canvasSave,
  "saveLayerAlpha(FFFFI)I": function (this: JCanvas, l: number, t: number, r: number, b: number, a: number) {
    const count = saveCanvas(this);
    this.ctx.globalAlpha *= a / 255;
    return count;
  },
  "restore()V": function (this: JCanvas) { restoreCanvas(this); },
  "restoreToCount(I)V": function (this: JCanvas, count: number) {
    restoreCanvasToCount(this, count);
  },
  "getSaveCount()I": function (this: JCanvas) { return this.saveCount; },
  "translate(FF)V": function (this: JCanvas, x: number, y: number) {
    const m = this.ctx.getTransform();
    if (m.a * m.d === m.b * m.c) this.ctx.setTransform(m.a, m.b, m.c, m.d, m.e + m.a * x + m.c * y, m.f + m.b * x + m.d * y);
    else this.ctx.translate(x, y);
  },
  "scale(FF)V": function (this: JCanvas, x: number, y: number) { this.ctx.scale(x, y); },
  "scale(FFFF)V": function (this: JCanvas, sx: number, sy: number, px: number, py: number) {
    aboutPivot(this.ctx, px, py, () => this.ctx.scale(sx, sy));
  },
  "rotate(F)V": function (this: JCanvas, d: number) { this.ctx.rotate(Math.fround(d * Math.PI / 180)); },
  "rotate(FFF)V": function (this: JCanvas, d: number, px: number, py: number) {
    aboutPivot(this.ctx, px, py, () => this.ctx.rotate(Math.fround(d * Math.PI / 180)));
  },
  "skew(FF)V": function (this: JCanvas, sx: number, sy: number) { this.ctx.transform(1, sy, sx, 1, 0, 0); },
  "concat(Landroid/graphics/Matrix;)V": function (this: JCanvas, m: JMatrix) {
    if (m) this.ctx.transform(...m.m);
  },
  "setMatrix(Landroid/graphics/Matrix;)V": function (this: JCanvas, m: JMatrix | null) {
    this.ctx.setTransform(...(m?.m ?? [1, 0, 0, 1, 0, 0]));
  },
  "getMatrix()Landroid/graphics/Matrix;": function (this: JCanvas) {
    const t = this.ctx.getTransform();
    const m = rt.make("android/graphics/Matrix") as JMatrix;
    m.m = [t.a, t.b, t.c, t.d, t.e, t.f];
    return m;
  },
  "clipRect(FFFF)Z": clipRect,
  "clipRect(IIII)Z": clipRect,
  "clipRect(FFFFLandroid/graphics/Region$Op;)Z": function (this: JCanvas, l: number, t: number, r: number, b: number, op: { ename?: string } | null) {
    if (op?.ename === "DIFFERENCE") return clipOutRect.call(this, l, t, r, b);
    return op && op.ename && op.ename !== "INTERSECT" ? 1 : clipRect.call(this, l, t, r, b);
  },
  "clipOutRect(FFFF)Z": clipOutRect,
  "clipOutRect(IIII)Z": clipOutRect,
  "clipOutRect(Landroid/graphics/Rect;)Z": function (this: JCanvas, r: JRect) { return clipOutRect.call(this, r.left, r.top, r.right, r.bottom); },
  "clipOutRect(Landroid/graphics/RectF;)Z": function (this: JCanvas, r: JRectF) { return clipOutRect.call(this, r.left, r.top, r.right, r.bottom); },
  "clipRect(Landroid/graphics/Rect;)Z": function (this: JCanvas, r: JRect) { return clipRect.call(this, r.left, r.top, r.right, r.bottom); },
  "clipRect(Landroid/graphics/RectF;)Z": function (this: JCanvas, r: JRectF) { return clipRect.call(this, r.left, r.top, r.right, r.bottom); },
  "clipPath(Landroid/graphics/Path;Landroid/graphics/Region$Op;)Z": function (this: JCanvas, path: JPath, op: { ename?: string } | null) {
    if (op && op.ename && op.ename !== "INTERSECT") return 1;
    return clipPath.call(this, path);
  },
  "clipPath(Landroid/graphics/Path;)Z": clipPath,
  "getClipBounds(Landroid/graphics/Rect;)Z": function (this: JCanvas, r: JRect) {
    return viewportClipBounds(this, r);
  },
  "getClipBounds()Landroid/graphics/Rect;": function (this: JCanvas) {
    const r = new JRect();
    viewportClipBounds(this, r);
    return r;
  },
  "drawColor(I)V": drawColor,
  "drawColor(ILandroid/graphics/PorterDuff$Mode;)V": function (this: JCanvas, c: number, m: { ord: number }) {
    drawColor.call(this, c, m?.ord === 0);
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
  "drawRoundRect(FFFFFFLandroid/graphics/Paint;)V": drawRoundRect,
  "drawRoundRect(Landroid/graphics/RectF;FFLandroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, rx: number, ry: number, p: JPaint) {
    drawRoundRect.call(this, r.left, r.top, r.right, r.bottom, rx, ry, p);
  },
  "drawCircle(FFFLandroid/graphics/Paint;)V": function (this: JCanvas, x: number, y: number, r: number, p: JPaint) {
    if (!(r > 0)) return;
    drawOval.call(this, x - r, y - r, x + r, y + r, p);
  },
  "drawOval(FFFFLandroid/graphics/Paint;)V": drawOval,
  "drawOval(Landroid/graphics/RectF;Landroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, p: JPaint) {
    drawOval.call(this, r.left, r.top, r.right, r.bottom, p);
  },
  "drawArc(FFFFFFZLandroid/graphics/Paint;)V": drawArc,
  "drawArc(Landroid/graphics/RectF;FFZLandroid/graphics/Paint;)V": function (this: JCanvas, r: JRectF, start: number, sweep: number, useCenter: number, p: JPaint) {
    drawArc.call(this, r.left, r.top, r.right, r.bottom, start, sweep, useCenter, p);
  },
  "drawLine(FFFFLandroid/graphics/Paint;)V": function (this: JCanvas, x0: number, y0: number, x1: number, y1: number, p: JPaint) {
    if (tryBitmapLine(this, p, x0, y0, x1, y1)) return;
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
    if (tryBitmapPath(this, p, path)) return;
    if (!path.inverseFill) {
      this.drawShape(p, (c) => c.fill(path.path(), path.fillRule), (c) => c.stroke(path.path()));
      return;
    }
    const bounds = canvasLocalBounds(this.ctx);
    if (!bounds) return;
    const [inverse, rule] = inversePath(path, ...bounds);
    this.drawShape(p, (c) => c.fill(inverse, rule), (c) => c.stroke(path.path()));
  },
  "drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V": function (this: JCanvas, s: string, x: number, y: number, p: JPaint) {
    drawTextImpl(this, s, x, y, p);
  },
  "drawText(Ljava/lang/CharSequence;IIFFLandroid/graphics/Paint;)V": driven(function* (this: JCanvas, s: unknown, a: number, b: number, x: number, y: number, p: JPaint): Gen {
    const text = typeof s === "string" ? s : typeof (s as { text?: unknown })?.text === "string"
      ? (s as { text: string }).text
      : String((yield vcall(s, "toString", "()Ljava/lang/String;")));
    drawTextImpl(this, text.slice(a, b), x, y, p);
  }),
  "drawText(Ljava/lang/String;IIFFLandroid/graphics/Paint;)V": function (this: JCanvas, s: string, a: number, b: number, x: number, y: number, p: JPaint) {
    drawTextImpl(this, s.slice(a, b), x, y, p);
  },
  "drawText([CIIFFLandroid/graphics/Paint;)V": function (this: JCanvas, c: Uint16Array, off: number, n: number, x: number, y: number, p: JPaint) {
    drawTextImpl(this, charsToString(c, off, n), x, y, p);
  },
  "drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V": function (this: JCanvas, b: JBitmap, x: number, y: number, p: JPaint | null) {
    drawBitmap(this, b, p, (ctx, image) => ctx.drawImage(image, x, y));
  },
  "drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/Rect;Landroid/graphics/Paint;)V": drawBitmapRect,
  "drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/RectF;Landroid/graphics/Paint;)V": drawBitmapRect,
  "drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Matrix;Landroid/graphics/Paint;)V":
    function (this: JCanvas, b: JBitmap, m: JMatrix, p: JPaint | null) {
      this.ctx.save();
      if (m) this.ctx.transform(...m.m);
      try { drawBitmap(this, b, p, (ctx, image) => ctx.drawImage(image, 0, 0)); }
      finally { this.ctx.restore(); }
    },
  "drawPicture(Landroid/graphics/Picture;)V": function (this: JCanvas, picture: JPicture) { drawPicture(this, picture); },
  "drawPicture(Landroid/graphics/Picture;Landroid/graphics/RectF;)V": function (this: JCanvas, picture: JPicture, dst: JRect) { drawPicture(this, picture, dst); },
  "drawPicture(Landroid/graphics/Picture;Landroid/graphics/Rect;)V": function (this: JCanvas, picture: JPicture, dst: JRect) { drawPicture(this, picture, dst); },
  ...noops("enableZ()V", "disableZ()V",
    "setDrawFilter(Landroid/graphics/DrawFilter;)V"),
  ...stubs(1, "clipOutPath(Landroid/graphics/Path;)Z", "isHardwareAccelerated()Z"),
  ...stubs(0, "quickReject(FFFFLandroid/graphics/Canvas$EdgeType;)Z"),
  "setBitmap(Landroid/graphics/Bitmap;)V": function (this: JCanvas, b: JBitmap | null) { setCanvasBitmap(this, b); },
};
export function setCanvasBitmap(cv: JCanvas, b: JBitmap | null) {
  cv.clipDevice = cv.clipPolygon = null; cv.clipStack.length = cv.clipPolygonStack.length = 0;
  if (b) { cv.ctx = b.ctx; cv.w = b.w; cv.h = b.h; cv.bmp = b; return; }
  cv.ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
  cv.w = cv.h = 0; cv.bmp = null;
}
const drawColorKey = mangleMethod("drawColor", "(I)V");
export const CAPS = ["butt", "round", "square"] as const;
export const JOINS = ["miter", "round", "bevel"] as const;
export function tryDrawBitmapText(cv: JCanvas, s: string, x: number, y: number, p: JPaint, subpixel = false): boolean {
  return !!(cv.bmp && (p.style === 0 || p.style === 2 && p.strokeWidth === 0 ||
    p.style === 1 && p.strokeWidth === 0 && p.strokeCapN === "butt" && p.strokeJoinN === "miter" && !p.dash) &&
    p.antiAlias && p.textAlignN === 0 && !p.letterSpacingEm &&
    !p.underline && !p.strikeThru && !p.shader && !p.shaderObj && !p.maskFilter && !p.shadowRadius &&
    !p.filterColor && !p.filterMatrix && !p.blend && !isRecording(cv.ctx) &&
    p.tf.family === ROBOTO && !p.tf.bold && !p.tf.italic &&
    drawSkiaText(cv.ctx, s, x, y, p.textSize,
      p.renderAlpha === null ? p.color : (p.renderAlpha << 24) | (p.color & 0xffffff),
      p.style === 1 ? "hairline" : "fill", subpixel));
}
function drawTextImpl(cv: JCanvas, s: string, x: number, y: number, p: JPaint) {
  cv.recordText(s, x, y, p.textSize, p.textAlignN);
  if (tryDrawBitmapText(cv, s, x, y, p)) return;
  const ctx = cv.ctx, shadow = beginPaintShadow(cv.ctx, p);
  try {
    ctx.font = p.font();
    ctx.textRendering = "geometricPrecision";
    if ("lang" in ctx) ctx.lang = p.language;
    cv.prep(p, false);
    ctx.textAlign = p.textAlignN === 1 ? "center" : p.textAlignN === 2 ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    if (p.letterSpacingEm && "letterSpacing" in ctx) ctx.letterSpacing = `${p.letterSpacingEm * p.textSize}px`;
    if (p.style !== 1) ctx.fillText(s, x, y);
    if (p.style === 1 || p.style === 2 && p.strokeWidth !== 0) {
      cv.prep(p, true);
      ctx.strokeText(s, x, y);
    }
    if (p.letterSpacingEm && "letterSpacing" in ctx) ctx.letterSpacing = "0px";
    if (p.underline) {
      const w = measureText(p, s);
      const sx = p.textAlignN === 1 ? x - w / 2 : p.textAlignN === 2 ? x - w : x;
      ctx.fillRect(sx, y + p.textSize * 0.08, w, Math.max(1, p.textSize / 16));
    }
  } finally { if (shadow) ctx.restore(); }
}
const tintCache = new WeakMap<JBitmap, { generation: number; images: Map<number | string, OffscreenCanvas> }>();
/** `b` through a paint's colour filter — recoloured SRC_IN with `tint`, or every pixel through a
 *  4x5 colour `matrix` — cached per (bitmap, filter); the bitmap itself when there is none */
export function tintedBmp(b: JBitmap, tint: number | null, matrix: Float32Array | null = null, mode = "SRC_IN"): OffscreenCanvas {
  if (matrix === null && (tint === null || mode === "DST" || mode === "ADD" && !(tint >>> 24))) return b.canvas;
  let cache = tintCache.get(b);
  if (!cache || cache.generation !== b.genId) tintCache.set(b, cache = { generation: b.genId, images: new Map() });
  const m = cache.images, key = matrix ? matrix.join(",") : `${mode}:${tint}`;
  let t = m.get(key);
  if (!t) {
    t = new OffscreenCanvas(b.w, b.h);
    const c = t.getContext("2d")!;
    c.drawImage(b.canvas, 0, 0);
    if (matrix) {
      const img = c.getImageData(0, 0, b.w, b.h), d = img.data, k = matrix;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], bl = d[i + 2], a = d[i + 3];
        d[i] = k[0] * r + k[1] * g + k[2] * bl + k[3] * a + k[4];
        d[i + 1] = k[5] * r + k[6] * g + k[7] * bl + k[8] * a + k[9];
        d[i + 2] = k[10] * r + k[11] * g + k[12] * bl + k[13] * a + k[14];
        d[i + 3] = k[15] * r + k[16] * g + k[17] * bl + k[18] * a + k[19];
      }
      c.putImageData(img, 0, 0);
    } else if (mode === "CLEAR") c.clearRect(0, 0, b.w, b.h);
    else if (mode === "MULTIPLY") {
      const img = c.getImageData(0, 0, b.w, b.h), d = img.data;
      const r = (tint! >>> 16 & 255) / 255, g = (tint! >>> 8 & 255) / 255, blue = (tint! & 255) / 255, alpha = (tint! >>> 24) / 255;
      for (let i = 0; i < d.length; i += 4) { d[i] *= r; d[i + 1] *= g; d[i + 2] *= blue; d[i + 3] *= alpha; }
      c.putImageData(img, 0, 0);
    } else {
      const composite = COMPOSITE[mode];
      if (!composite) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `bitmap tint mode ${mode}`);
      c.globalCompositeOperation = composite;
      c.fillStyle = cssColor(tint!);
      c.fillRect(0, 0, b.w, b.h);
    }
    m.set(key, t);
  }
  return t;
}
/** an ARGB colour through a 4x5 colour matrix (channels 0..255, offsets as stored) */
export function matrixColor(k: Float32Array, color: number): number {
  const a = color >>> 24, r = (color >>> 16) & 255, g = (color >>> 8) & 255, b = color & 255;
  const clamp = (v: number) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  return ((clamp(k[15] * r + k[16] * g + k[17] * b + k[18] * a + k[19]) << 24) | (clamp(k[0] * r + k[1] * g + k[2] * b + k[3] * a + k[4]) << 16)
    | (clamp(k[5] * r + k[6] * g + k[7] * b + k[8] * a + k[9]) << 8) | clamp(k[10] * r + k[11] * g + k[12] * b + k[13] * a + k[14])) | 0;
}
rt.register({ name: "android/graphics/Canvas", ctor: JCanvas, methods: canvasMethods });
// android.graphics.Outline: the shape a RenderNode clips to (clipToOutline) — Compose's
// Modifier.clip(shape) is exactly this, so a round button's ripple and children stay inside it.
export class JOutline extends JObj {
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
    "canClip()Z": () => 1,
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
class JRenderNode extends JObj {
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
}
/** replay a node's display list into ctx with its transform props applied */
// android.graphics.Picture is the same recording the render node already does, without the
// transform properties: what it recorded is replayed into whatever canvas is drawing it.
class JPicture extends JObj { node = new JRenderNode(); }
rt.register({
  name: "android/graphics/Picture", ctor: JPicture,
  methods: {
    "<init>()V": function () {},
    "beginRecording(II)Landroid/graphics/Canvas;": function (this: JPicture, w: number, h: number) {
      this.node.w = w; this.node.h = h;
      return vcall(this.node, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", w, h);
    },
    "endRecording()V": function (this: JPicture) { return vcall(this.node, "endRecording", "()V"); },
    "getWidth()I": function (this: JPicture) { return this.node.w; },
    "getHeight()I": function (this: JPicture) { return this.node.h; },
    "draw(Landroid/graphics/Canvas;)V": function (this: JPicture, cv: JCanvas) {
      replayWithSemantics(cv, () => { if (this.node.hasDL) for (const op of this.node.ops) op(cv.ctx); });
    },
  },
});
function drawPicture(canvas: JCanvas, picture: JPicture, dst?: JRect) {
  const ctx = canvas.ctx, node = picture.node;
  node.hasDL = true;
  ctx.save();
  try {
    if (dst) {
      ctx.translate(dst.left, dst.top);
      if (node.w > 0 && node.h > 0) ctx.scale((dst.right - dst.left) / node.w, (dst.bottom - dst.top) / node.h);
    }
    replayWithSemantics(canvas, () => { if (node.hasDL) for (const op of node.ops) op(ctx); });
  } finally { ctx.restore(); }
}
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
      const recording = replayCanvas(ctx);
      const canvas = JCanvas.wrap(input, n.w, n.h);
      if (recording) { canvas.semanticOwner = recording.semanticOwner; canvas.semanticBase = recording.semanticTransform(); }
      replayWithSemantics(canvas, () => { for (const op of n.ops) op(input); });
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
      c.ctx = recordingContext(this.octx!, this.ops); c.w = cw; c.h = ch;
      return c;
    },
    "beginRecording()Landroid/graphics/RecordingCanvas;": driven(function* (this: JRenderNode): Gen {
      return vcall(this, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", this.w, this.h);
    }),
    "endRecording()V": function (this: JRenderNode) { this.hasDL = true; perf.rnRecord += this.ops.length; invalidateHook?.(); },
    "hasDisplayList()Z": function (this: JRenderNode) { return this.hasDL ? 1 : 0; },
    "discardDisplayList()V": function (this: JRenderNode) { this.hasDL = false; this.ops = []; },
    "getWidth()I": function (this: JRenderNode) { return this.w; },
    "getHeight()I": function (this: JRenderNode) { return this.h; },
    "getLeft()I": function (this: JRenderNode) { return this.left; },
    "getTop()I": function (this: JRenderNode) { return this.top; },
    "getRight()I": function (this: JRenderNode) { return this.left + this.w; },
    "getBottom()I": function (this: JRenderNode) { return this.top + this.h; },
    "offsetLeftAndRight(I)Z": function (this: JRenderNode, offset: number) {
      if (!offset) return 0;
      this.left += offset;
      return 1;
    },
    "offsetTopAndBottom(I)Z": function (this: JRenderNode, offset: number) {
      if (!offset) return 0;
      this.top += offset;
      return 1;
    },
    "setAlpha(F)Z": function (this: JRenderNode, a: number) {
      const alpha = asF(a), epsilon = Math.fround(0.001);
      this.alpha = alpha <= epsilon ? 0 : alpha >= 1 - epsilon ? 1 : alpha;
      return 1;
    },
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
  replayWithSemantics(this, () => recordOrRun(this.ctx, ctx => drawNodeInto(ctx, n)));
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
      const r = rt.make("android/graphics/Rect") as JRect;
      r.left = this.left; r.top = this.top; r.right = this.right; r.bottom = this.bottom;
      return r;
    },
    "getBounds(Landroid/graphics/Rect;)Z": function (this: JRegion, r: JRect) {
      r.left = this.left; r.top = this.top; r.right = this.right; r.bottom = this.bottom;
      return this.left < this.right ? 1 : 0;
    },
    "setPath(Landroid/graphics/Path;Landroid/graphics/Region;)Z": driven(function* (this: JRegion, p: JPath, clip: JRegion): Gen {
      const b = new JRectF();
      (yield vcall(p, "computeBounds", "(Landroid/graphics/RectF;Z)V", b, 1));
      return setRegion.call(this, Math.max(Math.floor(b.left), clip.left), Math.max(Math.floor(b.top), clip.top),
        Math.min(Math.ceil(b.right), clip.right), Math.min(Math.ceil(b.bottom), clip.bottom));
    }),
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
  fields: ["inJustDecodeBounds", "inSampleSize", "outWidth", "outHeight", "inDensity", "inTargetDensity", "inScaled",
    "inPreferredConfig", "inBitmap", "inMutable", "outMimeType", "inPreferredColorSpace", "inPremultiplied",
    "outConfig", "inTempStorage", "inDither", "outColorSpace", "inPreferQualityOverSpeed", "inInputShareable",
    "inPurgeable", "inScreenDensity", "mCancel"],
  methods: { "<init>()V": function () {} },
});
/** an empty stream is a loader bug upstream of the decoder, so name the stream class rather than the decode failure */
function streamBytes(s: unknown): Uint8Array | Promise<Uint8Array> { return rt.drive(streamBytes$(s)); }
function* streamBytes$(s: unknown): Gen<Uint8Array> {
  const b = (yield readStreamFully(s));
  if (!b.length) console.warn("[decode] empty stream from", jclsNameOf(s));
  return b;
}
export function decodeBytes(bytes: Uint8Array, opts: JBFOptions | null, onHeader?: (width: number, height: number) => Promise<readonly [number, number]>): JBitmap | null | Promise<JBitmap | null> { return rt.drive(decodeBytes$(bytes, opts, onHeader)); }
function* decodeBytes$(bytes: Uint8Array, opts: JBFOptions | null, onHeader?: (width: number, height: number) => Promise<readonly [number, number]>): Gen<JBitmap | null> {
  if (opts) { opts.outWidth = opts.outHeight = -1; opts.outMimeType = null; opts.outConfig = opts.outColorSpace = null; }
  let img: ImageBitmap | undefined;
  try {
    const blob = new Blob([bytes as BlobPart]);
    try { img = (yield createImageBitmap(blob)) as ImageBitmap; }
    catch (error) {
      if (!isHeif(bytes)) throw error;
      img = (yield decodeHeif(bytes)) as ImageBitmap;
      if (opts) opts.outMimeType = "image/heif";
    }
    if (opts) {
      opts.outWidth = img.width;
      opts.outHeight = img.height;
      opts.outConfig = bitmapConfigs[3]; // decoder always rasterizes to ARGB_8888 (see Bitmap.getConfig)
      if (opts.inJustDecodeBounds) return null;
    }
    let w = img.width, h = img.height;
    if (opts && opts.inSampleSize > 1) { w = Math.max(1, w / opts.inSampleSize | 0); h = Math.max(1, h / opts.inSampleSize | 0); }
    if (opts) { opts.outWidth = w; opts.outHeight = h; }
    const scaled = opts && opts.inDensity && opts.inTargetDensity && opts.inScaled
      && opts.inDensity !== opts.inTargetDensity && opts.inDensity !== opts.inScreenDensity;
    if (scaled) {
      w = Math.round(w * opts.inTargetDensity / opts.inDensity);
      h = Math.round(h * opts.inTargetDensity / opts.inDensity);
    }
    if (onHeader) [w, h] = (yield onHeader(w, h));
    const bitmap = JBitmap.fromImage(img, w, h);
    if (opts?.inDensity) bitmap.density = scaled ? opts.inTargetDensity : opts.inDensity;
    bitmap.immutable = !opts?.inMutable;
    return bitmap;
  } catch (e) {
    if (onHeader) throw e;
    console.warn("[decode]", e);
    return null;
  } finally { img?.close(); }
}
function decodeStream(stream: unknown, pad: JRect | null = null, opts: JBFOptions | null = null): unknown { return rt.drive(decodeStream$(stream, pad, opts)); }
function* decodeStream$(stream: unknown, pad: JRect | null = null, opts: JBFOptions | null = null): Gen {
  const bitmap = stream ? (yield decodeBytes((yield streamBytes(stream)), opts)) : null;
  if (bitmap && pad) pad.left = pad.top = pad.right = pad.bottom = -1;
  return bitmap;
}
function decodeFileDescriptor(fd: JFileDescriptor | null, pad: JRect | null = null, opts: JBFOptions | null = null): unknown { return rt.drive(decodeFileDescriptor$(fd, pad, opts)); }
function* decodeFileDescriptor$(fd: JFileDescriptor | null, pad: JRect | null = null, opts: JBFOptions | null = null): Gen {
  if (!fd) throw rt.mkThrowable("java/lang/NullPointerException", "fd");
  const bytes = (yield javaFdBytes(fd.fd));
  const bitmap = (yield decodeBytes(bytes ?? new Uint8Array(0), opts));
  if (!bitmap && opts?.inBitmap) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Problem decoding into existing bitmap");
  if (bitmap && pad) pad.left = pad.top = pad.right = pad.bottom = -1;
  return bitmap;
}
function decodeFile(path: string | null, opts: JBFOptions | null = null): unknown { return rt.drive(decodeFile$(path, opts)); }
function* decodeFile$(path: string | null, opts: JBFOptions | null = null): Gen {
  let stream: unknown = null;
  try {
    stream = (yield newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", path));
    return (yield decodeStream(stream, null, opts));
  } catch (error) {
    if (!rt.iof(error, "java/lang/Exception")) throw error;
    return null;
  } finally {
    if (stream) (yield vcall(stream, "close", "()V"));
  }
}
function decodeResourceStream(res: unknown, value: JTypedValue | null, stream: unknown, pad: JRect | null, opts: JBFOptions | null): unknown { return rt.drive(decodeResourceStream$(res, value, stream, pad, opts)); }
function* decodeResourceStream$(res: unknown, value: JTypedValue | null, stream: unknown, pad: JRect | null, opts: JBFOptions | null): Gen {
  opts ??= new JBFOptions();
  if (!opts.inDensity && value && value.density !== 0xffff) opts.inDensity = value.density || 160;
  if (!opts.inTargetDensity && res) {
    const metrics: JDisplayMetrics = (yield vcall(res, "getDisplayMetrics", "()Landroid/util/DisplayMetrics;"));
    opts.inTargetDensity = metrics.densityDpi;
  }
  return decodeStream(stream, pad, opts);
}
function decodeResource(res: unknown, id: number, opts: JBFOptions | null = null): unknown { return rt.drive(decodeResource$(res, id, opts)); }
function* decodeResource$(res: unknown, id: number, opts: JBFOptions | null = null): Gen {
  let bitmap: JBitmap | null = null, stream: unknown = null;
  try {
    const value = new JTypedValue();
    stream = (yield vcall(res, "openRawResource", "(ILandroid/util/TypedValue;)Ljava/io/InputStream;", id, value));
    bitmap = (yield decodeResourceStream(res, value, stream, null, opts));
  } catch (error) {
    if (!(error instanceof rt.link("java/lang/Exception").ctor)) throw error;
  } finally {
    if (stream) try { (yield vcall(stream, "close", "()V")); }
    catch (error) { if (!(error instanceof rt.link("java/io/IOException").ctor)) throw error; }
  }
  if (!bitmap && opts?.inBitmap) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Problem decoding into existing bitmap");
  return bitmap;
}
rt.register({
  name: "android/graphics/BitmapFactory", ctor: class extends JObj {},
  methods: {
    "static decodeByteArray([BII)Landroid/graphics/Bitmap;": (b: Int8Array, off: number, len: number) =>
      decodeBytes(u8(b, off, len), null),
    "static decodeByteArray([BIILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;":
      (b: Int8Array, off: number, len: number, o: JBFOptions) =>
        decodeBytes(u8(b, off, len), o),
    "static decodeStream(Ljava/io/InputStream;)Landroid/graphics/Bitmap;": decodeStream,
    "static decodeStream(Ljava/io/InputStream;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;": decodeStream,
    "static decodeFile(Ljava/lang/String;)Landroid/graphics/Bitmap;": decodeFile,
    "static decodeFile(Ljava/lang/String;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;": decodeFile,
    "static decodeFileDescriptor(Ljava/io/FileDescriptor;)Landroid/graphics/Bitmap;": decodeFileDescriptor,
    "static decodeFileDescriptor(Ljava/io/FileDescriptor;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;": decodeFileDescriptor,
    "static decodeResource(Landroid/content/res/Resources;I)Landroid/graphics/Bitmap;": decodeResource,
    "static decodeResource(Landroid/content/res/Resources;ILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;": decodeResource,
    "static decodeResourceStream(Landroid/content/res/Resources;Landroid/util/TypedValue;Ljava/io/InputStream;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;": decodeResourceStream,
  },
});

class JBitmapRegionDecoder extends JObj { bitmap: JBitmap | null = null; }
function regionDecoder(bytes: Uint8Array | null): JBitmapRegionDecoder | Promise<JBitmapRegionDecoder> { return rt.drive(regionDecoder$(bytes)); }
function* regionDecoder$(bytes: Uint8Array | null): Gen<JBitmapRegionDecoder> {
  if (!bytes?.length) throw rt.mkThrowable("java/io/IOException", "Unable to decode image");
  const bitmap = (yield decodeBytes(bytes, null));
  if (!bitmap) throw rt.mkThrowable("java/io/IOException", "Unable to decode image");
  const decoder = new JBitmapRegionDecoder();
  decoder.bitmap = bitmap;
  return decoder;
}
rt.register({ name: "android/graphics/BitmapRegionDecoder", ctor: JBitmapRegionDecoder, methods: {
  "static newInstance(Ljava/io/InputStream;Z)Landroid/graphics/BitmapRegionDecoder;":
    driven(function* (stream: unknown): Gen  { return regionDecoder((yield streamBytes(stream))); }),
  "static newInstance(Ljava/io/InputStream;)Landroid/graphics/BitmapRegionDecoder;":
    driven(function* (stream: unknown): Gen  { return regionDecoder((yield streamBytes(stream))); }),
  "static newInstance(Ljava/lang/String;Z)Landroid/graphics/BitmapRegionDecoder;":
    driven(function* (path: string): Gen  { return regionDecoder((yield vfs.readFile(path))); }),
  "static newInstance(Ljava/io/FileDescriptor;Z)Landroid/graphics/BitmapRegionDecoder;":
    driven(function* (fd: JFileDescriptor): Gen  { return regionDecoder((yield javaFdBytes(fd.fd))); }),
  "static newInstance([BIIZ)Landroid/graphics/BitmapRegionDecoder;":
    (bytes: Int8Array, offset: number, length: number) => regionDecoder(u8(bytes, offset, length)),
  "getWidth()I": function (this: JBitmapRegionDecoder) { return this.bitmap?.w ?? 0; },
  "getHeight()I": function (this: JBitmapRegionDecoder) { return this.bitmap?.h ?? 0; },
  "isRecycled()Z": function (this: JBitmapRegionDecoder) { return this.bitmap ? 0 : 1; },
  "recycle()V": function (this: JBitmapRegionDecoder) { this.bitmap = null; },
  "decodeRegion(Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;":
    function (this: JBitmapRegionDecoder, rect: JRect, opts: JBFOptions | null) {
      const source = this.bitmap;
      if (!source) throw rt.mkThrowable("java/lang/IllegalStateException", "BitmapRegionDecoder is recycled");
      if (!rect || rect.left < 0 || rect.top < 0 || rect.right > source.w || rect.bottom > source.h ||
          rect.right <= rect.left || rect.bottom <= rect.top) {
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid image region");
      }
      const sample = Math.max(1, opts?.inSampleSize ?? 1);
      const width = Math.max(1, Math.ceil((rect.right - rect.left) / sample));
      const height = Math.max(1, Math.ceil((rect.bottom - rect.top) / sample));
      if (opts) {
        opts.outWidth = width; opts.outHeight = height;
        opts.outConfig = bitmapConfigs[3]; opts.outColorSpace = srgbSpace;
        if (opts.inJustDecodeBounds) return null;
      }
      const bitmap = JBitmap.create(width, height);
      bitmap.ctx.drawImage(source.canvas, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
        0, 0, width, height);
      bitmap.immutable = !opts?.inMutable;
      return bitmap;
    },
} });

const imageFormats = {
  UNKNOWN: [0, -1], RGB_565: [4, 16], YV12: [0x32315659, 12], Y8: [0x20203859, 8], Y16: [0x20363159, 16],
  YCBCR_P010: [0x36, 24], NV16: [0x10, 16], NV21: [0x11, 12], YUY2: [0x14, 16], JPEG: [0x100, -1],
  DEPTH_JPEG: [0x69656963, -1], JPEG_R: [0x1005, -1], YUV_420_888: [0x23, 12], YUV_422_888: [0x27, 16],
  YUV_444_888: [0x28, 24], FLEX_RGB_888: [0x29, 24], FLEX_RGBA_8888: [0x2a, 32], RAW_SENSOR: [0x20, 16],
  RAW_PRIVATE: [0x24, -1], RAW10: [0x25, 10], RAW12: [0x26, 12], DEPTH16: [0x44363159, 16],
  DEPTH_POINT_CLOUD: [0x101, -1], RAW_DEPTH: [0x1002, 16], RAW_DEPTH10: [0x1003, 10], PRIVATE: [0x22, -1], HEIC: [0x48454946, -1],
} satisfies Record<string, [number, number]>;
const imageBits = new Map(Object.values(imageFormats));
rt.register({
  name: "android/graphics/ImageFormat", ctor: class extends JObj {},
  statics: Object.fromEntries(Object.entries(imageFormats).map(([name, [value]]) => [name, value])),
  methods: { "static getBitsPerPixel(I)I": (format: number) => imageBits.get(format) ?? -1 },
});
