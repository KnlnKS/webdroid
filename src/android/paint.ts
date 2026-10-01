// hwui's Paint (an SkPaint, its SkFont and minikin's text state) behind android.graphics.Paint's
// mNativePaint, with its natives, its path effects and mask filters, and the text metrics TS reads
// off it. Paint, TextPaint, the PathEffects and MaskFilters run from AOSP bytecode; TS reaches a
// Java paint's native state through paintOf.

import { rt, declaredField, type JObj } from "../jvm/runtime";
import { charsToString, mangleMethod } from "../jvm/abi";
import { after, construct, newObj, vcall } from "../jvm/natives/jlang";
import { handle, deref, release, FINALIZER } from "./handles";
import { device } from "../shell/config";
import { perf } from "../perf";
import { type FaceMetrics, type NativeTypeface, SYSTEM_FONT, typefaceOf, fakery, FAKE_BOLD } from "./fonts";
import { type NativeColorFilter, type NativeShader, COMPOSITE, BLEND_MODES, cssColor, matrixColor } from "./graphics";
import { NativeBitmap, ALPHA_8, PREMUL, colorLongArgb, type NativeColorSpace } from "./bitmap";
import { NativePath, PathMeasure, VerbIterator, walkPath } from "./path";
import { shapeTextRun, layoutOutlines, hasGlyph } from "./shaping";
import { strokeCommands } from "./skia-text";
import type { Ctx2D } from "./recording";

const PAINT = "android/graphics/Paint";
/** Paint's flag bits hwui keeps (getJavaFlags): LCD_RENDER_TEXT and VERTICAL_TEXT are not */
const FLAG_MASK = 0x6dff;
const AA = 1, UNDERLINE = 8, STRIKE_THRU = 0x10, FAKE_BOLD_TEXT = 0x20, LINEAR = 0x40, SUBPIXEL = 0x80;
/** what `new Paint()` sets: ANTI_ALIAS_FLAG and HIDDEN_DEFAULT_PAINT_FLAGS */
const DEFAULT_FLAGS = 0x503;
/** nSetElegantTextHeight's value for elegant metrics: Paint passes 0 for true, 1 for false and -1
 *  (unset, the default under the compat change) for neither */
const ELEGANT = 0;
const CAPS: readonly CanvasLineCap[] = ["butt", "round", "square"];
const JOINS: readonly CanvasLineJoin[] = ["miter", "round", "bevel"];

/** hwui's Paint. The Java side keeps its own copies of the objects it was given (mShader,
 *  mTypeface, mColor as a ColorLong, the shadow layer); this is what a draw and a measure read. */
export class NativePaint {
  /** the colour drawn, ARGB in sRGB */
  color = -16777216;
  flags = DEFAULT_FLAGS;
  style = 0;
  strokeWidth = 0;
  strokeMiter = 4;
  strokeCapN: CanvasLineCap = "butt";
  strokeJoinN: CanvasLineJoin = "miter";
  shader: NativeShader | null = null;
  colorFilter: NativeColorFilter | null = null;
  maskFilter: NativeMaskFilter | null = null;
  pathEffect: NativePathEffect | null = null;
  /** the path effect when it is a dash alone, which a Canvas2D stroke draws itself */
  dash: number[] | null = null;
  dashPhase = 0;
  /** the blend mode by BlendMode's name, and its Canvas2D form; null = plain source-over */
  blendName: string | null = null;
  blend: GlobalCompositeOperation | null = null;
  shadowRadius = 0; shadowDx = 0; shadowDy = 0; shadowColor = 0;
  /** null for the default typeface */
  tf: NativeTypeface | null = null;
  textSize = 12;
  textScaleX = 1;
  textSkewX = 0;
  /** 0 left, 1 center, 2 right */
  textAlignN = 0;
  letterSpacingEm = 0;
  wordSpacing = 0;
  fontFeatureSettings: string | null = null;
  /** minikin's locale list id, and the first locale's tag */
  localeListId = 0;
  language = device.locale;
  elegant = -1;
  hinting = 1;
  startHyphenEdit = 0;
  endHyphenEdit = 0;

  get antiAlias() { return (this.flags & AA) !== 0; }
  get underline() { return (this.flags & UNDERLINE) !== 0; }
  get strikeThru() { return (this.flags & STRIKE_THRU) !== 0; }
  get fakeBold() { return (this.flags & FAKE_BOLD_TEXT) !== 0; }
  get linearText() { return (this.flags & LINEAR) !== 0; }
  get subpixelText() { return (this.flags & SUBPIXEL) !== 0; }
  setFlag(bit: number, on: boolean) { this.flags = on ? this.flags | bit : this.flags & ~bit; }
  setBlendName(name: string | null) { this.blendName = name; this.blend = name ? COMPOSITE[name] ?? null : null; }
  setPathEffect(e: NativePathEffect | null) {
    this.pathEffect = e;
    this.dash = e instanceof DashEffect ? e.intervals : null;
    this.dashPhase = e instanceof DashEffect ? e.phase : 0;
  }
  /** SkPaint::setAlpha: an out-of-range value is pinned, and a negative one reads as unsigned */
  setAlpha(a: number) { this.color = ((a < 0 || a > 255 ? 255 : a) << 24 | (this.color & 0xffffff)) | 0; }
  compositeOp(): GlobalCompositeOperation | null {
    if (this.blend === "source-in" && !this.shader && !this.colorFilter && this.color >>> 24 === 255) return "source-atop";
    return this.blend;
  }
  transparentSourceIn(): boolean {
    return this.blend === "source-in" && this.color >>> 24 === 0 && !this.shader && !this.colorFilter;
  }

  // font() is called per text op and per measure; the result is a pure function of
  // (typeface, textSize, fakeBold), so cache it and rebuild only when one changes.
  private fCache = "";
  private fTf: NativeTypeface | null | undefined = undefined;
  private fSize = -1;
  private fBold = false;
  private fFace: import("./fonts").NativeFont | null = null;
  private fFaked = false;
  font(): string {
    const bold = this.fakeBold;
    if (this.fTf === this.tf && this.fSize === this.textSize && this.fBold === bold) return this.fCache;
    const t = typefaceOf(this.tf), w = bold ? Math.max(700, t.weight) : t.weight;
    // minikin draws from the primary family's closest face, faking bold two grades short of the
    // wanted weight and italic on an upright face; the face's own weight makes CSS pick that face
    const face = t.collection.families[0]?.closest(w, t.italic) ?? null;
    const faked = face ? fakery(face, w, t.italic) : 0;
    this.fTf = this.tf; this.fSize = this.textSize; this.fBold = bold;
    this.fFace = face; this.fFaked = faked !== 0;
    const weight = !face ? w : faked & FAKE_BOLD ? 700 : face.weight;
    return (this.fCache = `${t.italic ? "italic " : ""}${weight} ${this.textSize}px ${t.collection.css}, sans-serif`);
  }
  /** the face font() draws from, and whether it draws it with fake bold or italic */
  face() { this.font(); return this.fFace; }
  faked(): boolean { this.font(); return this.fFaked; }
  fillStyle(ctx: Ctx2D): string | CanvasGradient | CanvasPattern {
    return this.shader?.pattern(ctx) ?? cssColor(this.filteredColor());
  }
  /** the paint's colour through its colour filter */
  filteredColor(): number {
    const filter = this.colorFilter, color = this.color;
    if (!filter) return color;
    if (filter.matrix) return matrixColor(filter.matrix, color);
    // PorterDuff/BlendMode SRC_IN — how Material tints every shape it draws: the filter's
    // colour replaces the paint's, keeping the alpha the two agree on
    const f = filter.color;
    return ((f & 0xffffff) | ((((f >>> 24) * (color >>> 24) / 255) | 0) << 24)) | 0;
  }
}
/** Paint::operator=, as nSet and nInitWithPaint copy one */
export function copyPaint(src: NativePaint, dst: NativePaint) {
  dst.color = src.color; dst.flags = src.flags; dst.style = src.style; dst.strokeWidth = src.strokeWidth; dst.strokeMiter = src.strokeMiter;
  dst.strokeCapN = src.strokeCapN; dst.strokeJoinN = src.strokeJoinN;
  dst.shader = src.shader; dst.colorFilter = src.colorFilter; dst.maskFilter = src.maskFilter; dst.setPathEffect(src.pathEffect);
  dst.blendName = src.blendName; dst.blend = src.blend;
  dst.shadowRadius = src.shadowRadius; dst.shadowDx = src.shadowDx; dst.shadowDy = src.shadowDy; dst.shadowColor = src.shadowColor;
  copyTextState(src, dst);
  dst.textSize = src.textSize; dst.textScaleX = src.textScaleX; dst.textSkewX = src.textSkewX; dst.hinting = src.hinting;
}
/** what Paint::reset leaves alone (the device keeps them across Paint.reset) */
function copyTextState(src: NativePaint, dst: NativePaint) {
  dst.tf = src.tf; dst.textAlignN = src.textAlignN; dst.letterSpacingEm = src.letterSpacingEm; dst.wordSpacing = src.wordSpacing;
  dst.fontFeatureSettings = src.fontFeatureSettings; dst.localeListId = src.localeListId; dst.language = src.language;
  dst.elegant = src.elegant; dst.startHyphenEdit = src.startHyphenEdit; dst.endHyphenEdit = src.endHyphenEdit;
}
/** a Paint as constructed; read-only, the source for the null bitmap paint */
export const defaultPaint = new NativePaint();

// ── the bridge
const GET_NATIVE_INSTANCE = mangleMethod("getNativeInstance", "()J");
let nativePaintField = "";
/** A Java Paint's native state, as a draw sees it: Paint.getNativeInstance first hands the native
 *  paint its shader's and colour filter's current native instances. That call suspends only on a
 *  contended monitor; the draw then reads the paint as it stands. */
export function paintOf(p: object): NativePaint {
  const h = (p as Record<string, () => bigint | Promise<bigint>>)[GET_NATIVE_INSTANCE]();
  return deref<NativePaint>(typeof h === "bigint" ? h : (p as Record<string, bigint>)[nativePaintField ||= declaredField(PAINT, "mNativePaint")]);
}
const TEXT_PAINT = "android/text/TextPaint";
/** `new Paint(ANTI_ALIAS_FLAG)` or `new TextPaint(ANTI_ALIAS_FLAG)` from TS, synchronously: the
 *  zygote has initialized both (preloadPaint) */
export function newPaint(cls: typeof PAINT | typeof TEXT_PAINT = PAINT): JObj {
  const p = construct(cls, "(I)V", AA);
  if (p instanceof Promise) throw new Error(`${cls} constructed before preloadPaint`);
  return p;
}
/** ZygoteInit.preloadClasses' share: Paint, TextPaint and what their constructors reach */
export const preloadPaint = (): Promise<unknown> => newObj(TEXT_PAINT, "(I)V", AA);
const TF = "Landroid/graphics/Typeface;";
/** Paint.getTypeface and setTypeface: the Java paint keeps the Typeface, its native paint the face */
export const paintTypeface = (p: object) => vcall(p, "getTypeface", `()${TF}`) as object | null;
export const setPaintTypeface = (p: object, tf: object | null): unknown => vcall(p, "setTypeface", `(${TF})${TF}`, tf);

// ── text measurement and metrics
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
export function measureText(p: NativePaint, s: string): number {
  perf.measureText++;
  return Math.fround((rawWidth(p.font(), s, p.language) + p.letterSpacingEm * p.textSize * s.length) * p.textScaleX);
}
/** Android Paint retains fractional hhea ascent/descent and uses head.yMax/yMin for bounds; the
 *  metrics are the drawn face's. Browser bounding-box metrics round to pixels even with FontFace
 *  metric overrides. */
const metricsOf = (p: NativePaint): FaceMetrics => p.face()?.faceMetrics ?? SYSTEM_FONT;
function vmetrics(p: NativePaint): { a: number; d: number } {
  const f = p.font();
  let v = vmetCache.get(f);
  if (!v) {
    const face = p.face()?.faceMetrics;
    if (face) v = { a: -p.textSize * face.ascent, d: p.textSize * face.descent };
    else {
      const m = measureCtx(f).measureText("Ag");
      v = { a: -(m.fontBoundingBoxAscent ?? p.textSize * SYSTEM_FONT.ascent), d: m.fontBoundingBoxDescent ?? p.textSize * SYSTEM_FONT.descent };
    }
    vmetCache.set(f, v);
  }
  return v;
}
/** getMetricsInternal's elegant-height metrics, in 2048ths of the size: top, ascent, descent, bottom */
const ELEGANT_METRICS = [2500, 1900, 500, 1000];
const elegant = (p: NativePaint, i: number) => (i < 2 ? -p.textSize : p.textSize) * ELEGANT_METRICS[i] / 2048;
export function fontAscent(p: NativePaint): number { return p.elegant === ELEGANT ? elegant(p, 1) : vmetrics(p).a; }
export function fontDescent(p: NativePaint): number { return p.elegant === ELEGANT ? elegant(p, 2) : vmetrics(p).d; }
export function fontTop(p: NativePaint): number {
  if (p.elegant === ELEGANT) return elegant(p, 0);
  const m = metricsOf(p); return Math.fround(vmetrics(p).a * (m.top / m.ascent));
}
export function fontBottom(p: NativePaint): number {
  if (p.elegant === ELEGANT) return elegant(p, 3);
  const m = metricsOf(p); return Math.fround(vmetrics(p).d * (m.bottom / m.descent));
}
const metricKeys: Record<string, string[]> = {};
/** a Java Paint.FontMetrics' (or FontMetricsInt's) top, ascent, descent, bottom and leading */
export function setFontMetrics(fm: object, int: boolean, top: number, ascent: number, descent: number, bottom: number, leading: number) {
  const cls = int ? "android/graphics/Paint$FontMetricsInt" : "android/graphics/Paint$FontMetrics";
  const k = metricKeys[cls] ??= ["top", "ascent", "descent", "bottom", "leading"].map((name) => declaredField(cls, name)), o = fm as Record<string, number>;
  o[k[0]] = top; o[k[1]] = ascent; o[k[2]] = descent; o[k[3]] = bottom; o[k[4]] = leading;
}
/** Paint.getFontMetrics(Int): the metrics into `fm`, and the line spacing */
function fillFontMetrics(p: NativePaint, fm: object | null, int: boolean) {
  const a = fontAscent(p), d = fontDescent(p);
  const ascent = int ? Math.round(a) : a, descent = int ? Math.round(d) : d;
  if (fm) {
    const top = fontTop(p), bottom = fontBottom(p);
    setFontMetrics(fm, int, int ? Math.floor(top) : top, ascent, descent, int ? Math.ceil(bottom) : bottom, 0);
  }
  return descent - ascent;
}
// hwui's decoration constants, for a face without underline metrics and for every strike-through
// (the device reports the constants for its system faces)
const f32 = Math.fround, STD_THICKNESS = f32(1 / 18);
const STD_UNDERLINE_TOP = f32(f32(1 / 9) - STD_THICKNESS / 2), STD_STRIKE_THRU_TOP = f32(f32(-6 / 21) - STD_THICKNESS / 2);
/** the distance from the baseline to the top of an underline, and its thickness (SkFontMetrics
 *  from the face's post table) */
export function underlinePosition(p: NativePaint): number {
  const m = metricsOf(p);
  return f32(p.textSize * (m.underline ?? STD_UNDERLINE_TOP));
}
export const underlineThickness = (p: NativePaint) => f32(p.textSize * (metricsOf(p).underlineThickness ?? STD_THICKNESS));
export const strikeThruPosition = (p: NativePaint) => f32(p.textSize * STD_STRIKE_THRU_TOP);
export const strikeThruThickness = (p: NativePaint) => f32(p.textSize * STD_THICKNESS);

/** the glyph bounds the browser reports, rounded out */
type Box = { left: number; top: number; right: number; bottom: number };
function textBounds(p: NativePaint, s: string, r: Box) {
  const m = measureCtx(p.font(), p.language).measureText(s);
  r.left = Math.floor(-m.actualBoundingBoxLeft); r.right = Math.ceil(m.actualBoundingBoxRight);
  r.top = -Math.ceil(m.actualBoundingBoxAscent); r.bottom = Math.ceil(m.actualBoundingBoxDescent);
}

// ── shadows
export function beginPaintShadow(ctx: Ctx2D, p: NativePaint): boolean {
  if (!(p.shadowRadius > 0) || !(p.shadowColor >>> 24)) return false;
  const m = ctx.getTransform();
  ctx.save();
  ctx.shadowColor = cssColor(p.shadowColor);
  ctx.shadowBlur = p.shadowRadius * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  ctx.shadowOffsetX = m.a * p.shadowDx + m.c * p.shadowDy;
  ctx.shadowOffsetY = m.b * p.shadowDx + m.d * p.shadowDy;
  return true;
}

// ── mask filters (SkMaskFilter): what a shape's coverage becomes before it is coloured
/** Blur::convertRadiusToSigma */
const radiusToSigma = (r: number) => (r > 0 ? 0.57735 * r + 0.5 : 0);
export abstract class NativeMaskFilter {
  /** whether apply writes the shape's final colours (a 3D mask), not coverage to be coloured */
  readonly colored: boolean = false;
  /** the pixels the filter may reach beyond the shape (SkMask margin), for extractAlpha */
  border(): number { return 0; }
  /** `source`'s coverage through the filter, drawn into `target` at (x, y); `scale` maps the
   *  filter's lengths to device pixels and `color` is the paint's, for a filter that colours */
  abstract apply(target: Ctx2D, source: CanvasImageSource, x: number, y: number, scale: number, color?: number): void;
}
/** SkBlurMaskFilter: NORMAL, SOLID, OUTER, INNER */
export class BlurMask extends NativeMaskFilter {
  constructor(readonly sigma: number, readonly style: number) { super(); }
  /** SkBlurMask's margin: three box passes, or the Bessel window of a small sigma */
  override border() {
    const sigma = Math.min(this.sigma, 135);
    if (this.style === 3) return 0;
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
  apply(ctx: Ctx2D, source: CanvasImageSource, x: number, y: number, scale: number) {
    ctx.filter = `blur(${Math.min(this.sigma * scale, 135)}px)`;
    ctx.drawImage(source, x, y); ctx.filter = "none";
    if (this.style) {
      ctx.globalCompositeOperation = this.style === 2 ? "destination-out" : this.style === 3 ? "destination-in" : "source-over";
      ctx.drawImage(source, x, y);
      ctx.globalCompositeOperation = "source-over";
    }
  }
}
/** SkTableMaskFilter: each coverage value through a 256-entry table */
class TableMask extends NativeMaskFilter {
  constructor(readonly table: Uint8Array) { super(); }
  apply(ctx: Ctx2D, source: CanvasImageSource, x: number, y: number) {
    ctx.drawImage(source, x, y);
    const { width, height } = ctx.canvas, img = ctx.getImageData(0, 0, width, height), d = img.data, t = this.table;
    for (let i = 3; i < d.length; i += 4) d[i] = t[d[i]];
    ctx.putImageData(img, 0, 0);
  }
}
/** SkEmbossMaskFilter: the shape lit as a height field its inner blur makes, the lighting
 *  modulating (ambient and diffuse) and adding to (specular) the paint's colour */
class EmbossMask extends NativeMaskFilter {
  override readonly colored = true;
  constructor(readonly sigma: number, readonly light: Float64Array, readonly ambient: number, readonly specular: number) { super(); }
  override border() { return Math.ceil(3 * this.sigma); }
  apply(ctx: Ctx2D, source: CanvasImageSource, x: number, y: number, scale: number, color = -16777216) {
    const { width: w, height: h } = ctx.canvas;
    ctx.drawImage(source, x, y);
    const src = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${this.sigma * scale}px)`;
    ctx.drawImage(source, x, y); ctx.filter = "none";
    const blurred = ctx.getImageData(0, 0, w, h), b = blurred.data, s = src.data;
    // the inner blur: the blurred coverage inside the shape (merge_src_with_blur)
    const height = new Uint8Array(w * h);
    for (let i = 0; i < height.length; i++) height[i] = (b[i * 4 + 3] * (s[i * 4 + 3] + 1)) >> 8;
    // SkEmbossMask::Emboss in 16.16 fixed point, the light direction normalized
    const [lx, ly, lz] = Array.from(this.light, (v) => Math.trunc(v * 65536)), lzDot8 = lz >> 8, DELTA = 32;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      const nx = height[i + (xx < w - 1 ? 1 : 0)] - height[i - (xx > 0 ? 1 : 0)];
      const ny = height[i + (yy < h - 1 ? w : 0)] - height[i - (yy > 0 ? w : 0)];
      const numer = lx * nx + ly * ny + lz * DELTA;
      let mul = this.ambient, add = 0;
      if (numer > 0) {
        const dot = Math.trunc(numer / Math.floor(Math.sqrt(nx * nx + ny * ny + DELTA * DELTA))) >> 8;
        mul = Math.min(mul + dot, 255);
        let hilite = ((2 * dot - lzDot8) * lzDot8) >> 8;
        if (hilite > 0) {
          hilite = Math.min(hilite, 255);
          add = hilite;
          for (let k = this.specular >> 4; k > 0; k--) add = Math.floor(add * hilite * 65793 / 16777216);
        }
      }
      // Sk3DShader: each premultiplied channel scaled by mul and raised by add, under the shape's
      // own coverage
      const o = i * 4, alpha = color >>> 24, raise = mulDiv255(add, alpha);
      const shade = (c: number) => alpha && Math.min(((mulDiv255(c, alpha) * (mul + 1)) >> 8) + raise, alpha) * 255 / alpha;
      b[o] = shade(color >>> 16 & 255); b[o + 1] = shade(color >>> 8 & 255); b[o + 2] = shade(color & 255);
      b[o + 3] = mulDiv255(s[o + 3], alpha);
    }
    ctx.putImageData(blurred, 0, 0);
  }
}
/** SkMulDiv255Round */
const mulDiv255 = (a: number, b: number) => { const p = a * b + 128; return (p + (p >> 8)) >> 8; };
const maskFilterOf = (h: bigint) => (h ? deref<NativeMaskFilter>(h) : null);
const iae = () => rt.mkThrowable("java/lang/IllegalArgumentException", null);
rt.registerJnis("android/graphics/MaskFilter", { "nativeDestructor(J)V": release });
rt.registerJnis("android/graphics/BlurMaskFilter", {
  "nativeConstructor(FI)J": (radius: number, style: number) => {
    const sigma = radiusToSigma(radius);
    if (!(sigma > 0) || !Number.isFinite(sigma)) throw iae();
    return handle(new BlurMask(sigma, style));
  },
});
rt.registerJnis("android/graphics/EmbossMaskFilter", {
  // SkBlurMaskFilter::MakeEmboss: ambient as a unit byte, specular as 4.4 fixed point
  "nativeConstructor([FFFF)J": (dir: Float32Array, ambient: number, specular: number, radius: number) => {
    const sigma = radiusToSigma(radius), len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(sigma > 0) || !Number.isFinite(sigma) || !(len > 0) || !Number.isFinite(len)) throw iae();
    const light = Float64Array.of(dir[0] / len, dir[1] / len, dir[2] / len);
    return handle(new EmbossMask(sigma, light, Math.round(Math.min(Math.max(ambient, 0), 1) * 255),
      Math.trunc(Math.min(Math.max(specular, 0), 16) / 16 * 255)));
  },
});
rt.registerJnis("android/graphics/TableMaskFilter", {
  "nativeNewTable([B)J": (table: Int8Array) => handle(new TableMask(new Uint8Array(table.buffer, table.byteOffset, 256).slice())),
  // SkTableMaskFilter::MakeClipTable
  "nativeNewClip(II)J": (min: number, max: number) => {
    const t = new Uint8Array(256);
    min &= 255; max &= 255;
    if (max === 0) max = 1;
    if (min >= max) min = max - 1;
    const scale = Math.trunc(65536 * 255 / (max - min));
    for (let i = min + 1; i < max; i++) t[i] = (scale * (i - min) + 0x8000) >> 16;
    t.fill(255, max);
    return handle(new TableMask(t));
  },
  // SkTableMaskFilter::MakeGammaTable
  "nativeNewGamma(F)J": (gamma: number) => {
    const t = new Uint8Array(256), dx = Math.fround(1 / 255);
    for (let i = 0, x = 0; i < 256; i++, x = Math.fround(x + dx)) t[i] = Math.min(255, Math.max(0, Math.round(Math.pow(x, gamma) * 255)));
    return handle(new TableMask(t));
  },
});

/** SkBitmap::extractAlpha: an ALPHA_8 copy of the coverage, through the paint's mask filter, its
 *  rows 4-byte aligned as SkMask lays them out */
export function extractBitmapAlpha(src: NativeBitmap, paint: NativePaint | null, offsets: Int32Array | null): NativeBitmap {
  const filter = paint?.maskFilter ?? null, border = filter ? filter.border() : 0;
  const w = src.w + 2 * border, h = src.h + 2 * border, b = new NativeBitmap(w, h, ALPHA_8, PREMUL, (w + 3) & ~3);
  if (filter) {
    const ctx = b.ctx;
    filter.apply(ctx, src.image, border, border, 1);
    ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, b.w, b.h);
    ctx.globalCompositeOperation = "source-over";
  } else {
    const source = src.pixels(), target = b.pixels();
    for (let i = 3; i < target.length; i += 4) target[i] = source[i];
  }
  if (offsets && offsets.length >= 2) { offsets[0] = -border; offsets[1] = -border; }
  return b;
}

// ── path effects (SkPathEffect::filterPath over NativePath geometry)
/** SkStrokeRec's part the effects read and change: fill, or a stroke of `width` (0 a hairline) */
export interface StrokeRec { fill: boolean; width: number; strokeAndFill: boolean }
export abstract class NativePathEffect {
  /** the effect of `src` appended to `dst`; false when it leaves the path as it is */
  abstract filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean;
}
const MOVE = 0, LINE = 1, QUAD = 2, CUBIC = 4, CLOSE = 5;
/** SkPath::Iter over the verbs: a close reports the line back to the contour's start first */
function* iterate(p: NativePath): Generator<number[]> {
  const verbs = new VerbIterator(p).verbs;
  let mx = 0, my = 0, x = 0, y = 0;
  for (const v of verbs) {
    if (v[0] === MOVE) { mx = x = v[1]; my = y = v[2]; } else if (v[0] === CLOSE) {
      if (x !== mx || y !== my) yield [LINE, x, y, mx, my];
      x = mx; y = my;
    } else { x = v[v.length - 2]; y = v[v.length - 1]; }
    yield v;
  }
}
/** whether the contour starting at verb `i` is closed */
const closedFrom = (verbs: number[][], i: number) => {
  for (let k = i + 1; k < verbs.length && verbs[k][0] !== MOVE; k++) if (verbs[k][0] === CLOSE) return true;
  return false;
};
/** SkDashPathEffect: intervals, and the phase as an offset into them */
class DashEffect extends NativePathEffect {
  readonly length: number;
  readonly firstLength: number;
  readonly firstIndex: number;
  constructor(readonly intervals: number[], readonly phase: number) {
    super();
    const len = this.length = intervals.reduce((a, b) => a + b, 0);
    // CalcDashParameters: a negative phase flips, and phase lands in [0, len)
    if (phase < 0) { phase = -phase; if (phase > len) phase %= len; phase = len - phase; if (phase === len) phase = 0; }
    else if (phase >= len) phase %= len;
    this.phase = phase;
    let index = 0, first = intervals[0];
    for (let i = 0; i < intervals.length; i++) {
      const gap = intervals[i];
      if (phase > gap || (phase === gap && gap)) phase -= gap;
      else { index = i; first = gap - phase; break; }
    }
    this.firstLength = first; this.firstIndex = index;
  }
  // SkDashPath::InternalFilter, without its line special case (a butt-capped single line becomes rects)
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    if (rec.fill || rec.strokeAndFill) return false;
    const meas = new PathMeasure(), iv = this.intervals, count = iv.length;
    meas.setPath(src, false);
    do {
      const length = meas.length();
      let skipFirst = meas.isClosed(), added = false, index = this.firstIndex, distance = 0, dlen = this.firstLength;
      if (length * (count >> 1) / this.length > 1000000) { dst.reset(); return false; }
      while (distance < length) {
        added = false;
        if (!(index & 1) && !skipFirst) { added = true; meas.getSegment(distance, distance + dlen, dst, true); }
        distance += dlen;
        skipFirst = false;
        if (++index === count) index = 0;
        dlen = iv[index];
      }
      // a closed contour that starts inside a dash ends it there
      if (meas.isClosed() && !(this.firstIndex & 1) && this.firstLength >= 0) meas.getSegment(0, this.firstLength, dst, !added);
    } while (meas.nextContour());
    return true;
  }
}
/** SkCornerPathEffect: each corner between lines rounded by a quadratic through it */
class CornerEffect extends NativePathEffect {
  constructor(readonly radius: number) { super(); }
  filter(dst: NativePath, src: NativePath): boolean {
    const r = this.radius, verbs = [...iterate(src)];
    let prevVerb = -1, prevIsValid = true, mx = 0, my = 0, lx = 0, ly = 0, fx = 0, fy = 0, sx = 0, sy = 0;
    for (let i = 0; i < verbs.length; i++) {
      const v = verbs[i], verb = v[0];
      switch (verb) {
        case MOVE:
          if (prevVerb === LINE) dst.lineTo(lx, ly);
          if (closedFrom(verbs, i)) { mx = v[1]; my = v[2]; prevIsValid = false; } else { dst.moveTo(v[1], v[2]); prevIsValid = true; }
          break;
        case LINE: {
          // ComputeStep: toward the next point by the radius, or half way when the line is short
          const [, x0, y0, x1, y1] = v, dist = Math.hypot(x1 - x0, y1 - y0), whole = dist > r * 2, k = whole ? r / dist : 0.5;
          sx = (x1 - x0) * k; sy = (y1 - y0) * k;
          if (!prevIsValid) { dst.moveTo(mx + sx, my + sy); prevIsValid = true; } else dst.quadTo(x0, y0, x0 + sx, y0 + sy);
          if (whole) dst.lineTo(x1 - sx, y1 - sy);
          lx = x1; ly = y1;
          break;
        }
        case QUAD: case CUBIC:
          if (!prevIsValid) { dst.moveTo(v[1], v[2]); prevIsValid = true; }
          if (verb === QUAD) dst.quadTo(v[3], v[4], v[5], v[6]); else dst.cubicTo(v[3], v[4], v[5], v[6], v[7], v[8]);
          lx = v[v.length - 2]; ly = v[v.length - 1]; fx = fy = 0;
          break;
        case CLOSE:
          if (fx || fy) dst.quadTo(lx, ly, lx + fx, ly + fy);
          dst.close();
          prevIsValid = false;
          break;
      }
      if (prevVerb === MOVE) { fx = sx; fy = sy; }
      prevVerb = verb;
    }
    if (prevIsValid) dst.lineTo(lx, ly);
    return true;
  }
}
/** SkDiscretePathEffect: points every segment length along each contour, pushed off it along the
 *  normal by an LCG's deviation (seeded from the path's length, as Skia seeds it) */
class DiscreteEffect extends NativePathEffect {
  constructor(readonly segLength: number, readonly deviation: number, readonly seedAssist = 0) { super(); }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    const meas = new PathMeasure(), pos = new Float32Array(2), tan = new Float32Array(2);
    meas.setPath(src, rec.fill);
    const s0 = (this.seedAssist ^ Math.round(meas.length())) >>> 0;
    let seed = (s0 ^ ((s0 << 16) | (s0 >>> 16))) >>> 0;
    // LCGRandom::nextSScalar1: a signed 16.16 fraction in [-1, 1)
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed | 0) >> 15) / 65536; };
    const point = (d: number, first: boolean) => {
      if (!meas.getPosTan(d, pos, tan)) return;
      // Perterb: along the tangent turned counter-clockwise, scaled to the deviation
      const scale = random() * this.deviation, len = Math.hypot(tan[0], tan[1]);
      const x = pos[0] + (len ? tan[1] / len * scale : 0), y = pos[1] - (len ? tan[0] / len * scale : 0);
      if (first) dst.moveTo(Math.fround(x), Math.fround(y)); else dst.lineTo(Math.fround(x), Math.fround(y));
    };
    do {
      const length = meas.length();
      if (this.segLength * (2 + +rec.fill) > length) meas.getSegment(0, length, dst, true);
      else {
        let n = Math.min(Math.round(length / this.segLength), 100000), distance = 0;
        const delta = length / n;
        if (meas.isClosed()) { n--; distance += delta / 2; }
        point(distance, true);
        while (--n >= 0) { distance += delta; point(distance, false); }
        if (meas.isClosed()) dst.close();
      }
    } while (meas.nextContour());
    return true;
  }
}
/** SkPath1DPathEffect: a stamp placed every `advance` along each contour, translated, rotated to
 *  the tangent, or bent along the contour; the result is filled */
class Path1DEffect extends NativePathEffect {
  readonly offset: number;
  constructor(readonly stamp: NativePath, readonly advance: number, phase: number, readonly style: number) {
    super();
    // phase inverted into an offset along the path, as PostScript reads it
    if (phase < 0) { phase = -phase; if (phase > advance) phase %= advance; }
    else { if (phase > advance) phase %= advance; phase = advance - phase; }
    this.offset = phase >= advance ? 0 : phase;
  }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    rec.fill = true; rec.strokeAndFill = false;
    const meas = new PathMeasure(), pos = new Float32Array(2), m = new Float64Array(9);
    meas.setPath(src, false);
    do {
      const length = meas.length();
      for (let d = this.offset, governor = 100000; d < length && --governor >= 0; d += this.advance) {
        if (this.style === 0) { if (meas.getPosTan(d, pos, null)) dst.append(this.stamp, undefined, pos[0], pos[1]); }
        else if (this.style === 1) { if (meas.getMatrix(d, m, 3)) dst.append(this.stamp, m); }
        else this.morph(dst, meas, d);
      }
    } while (meas.nextContour());
    return true;
  }
  /** morphpath: every point of the stamp moved along the contour by its x, and off it by its y */
  private morph(dst: NativePath, meas: PathMeasure, dist: number) {
    const pos = new Float32Array(2), tan = new Float32Array(2), out: number[] = [];
    const map = (pts: number[]) => {
      out.length = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const sx = pts[i], sy = pts[i + 1];
        if (!meas.getPosTan(dist + sx, pos, tan)) return false;
        out.push(pos[0] - tan[1] * sy, pos[1] + tan[0] * sy);
      }
      return true;
    };
    for (const v of iterate(this.stamp)) {
      switch (v[0]) {
        case MOVE: if (map([v[1], v[2]])) dst.moveTo(out[0], out[1]); break;
        case LINE: if (map([(v[1] + v[3]) / 2, (v[2] + v[4]) / 2, v[3], v[4]])) dst.quadTo(out[0], out[1], out[2], out[3]); break;
        case QUAD: if (map(v.slice(3))) dst.quadTo(out[0], out[1], out[2], out[3]); break;
        case CUBIC: if (map(v.slice(3))) dst.cubicTo(out[0], out[1], out[2], out[3], out[4], out[5]); break;
        case CLOSE: dst.close(); break;
      }
    }
  }
}
/** SkComposePathEffect: the outer effect over what the inner one made */
class ComposeEffect extends NativePathEffect {
  constructor(readonly outer: NativePathEffect, readonly inner: NativePathEffect) { super(); }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    const tmp = new NativePath();
    return this.outer.filter(dst, this.inner.filter(tmp, src, rec) ? tmp : src, rec);
  }
}
/** SkSumPathEffect: both effects' paths, one after the other */
class SumEffect extends NativePathEffect {
  constructor(readonly first: NativePathEffect, readonly second: NativePathEffect) { super(); }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    return (+this.first.filter(dst, src, rec) | +this.second.filter(dst, src, rec)) !== 0;
  }
}
const effectOf = (h: bigint) => (h ? deref<NativePathEffect>(h) : null);
const finite = (...v: number[]) => v.every(Number.isFinite);
rt.registerJnis("android/graphics/PathEffect", { "nativeDestructor(J)V": release });
rt.registerJnis("android/graphics/DashPathEffect", {
  // SkDashPathEffect::Make over an even count; an invalid pattern is no effect
  "nativeCreate([FF)J": (iv: Float32Array, phase: number) => {
    const intervals = Array.from(iv.subarray(0, iv.length & ~1)), len = intervals.reduce((a, b) => a + b, 0);
    return intervals.length < 2 || intervals.some((v) => v < 0) || !(len > 0) || !finite(len, phase) ? 0n : handle(new DashEffect(intervals, phase));
  },
});
rt.registerJnis("android/graphics/CornerPathEffect", {
  "nativeCreate(F)J": (radius: number) => (radius > 0 && finite(radius) ? handle(new CornerEffect(radius)) : 0n),
});
rt.registerJnis("android/graphics/DiscretePathEffect", {
  "nativeCreate(FF)J": (seg: number, dev: number) => (finite(seg, dev) && seg > 1 / 4096 ? handle(new DiscreteEffect(seg, dev)) : 0n),
});
rt.registerJnis("android/graphics/PathDashPathEffect", {
  "nativeCreate(JFFI)J": (path: bigint, advance: number, phase: number, style: number) => {
    const stamp = deref<NativePath>(path);
    if (!(advance > 0) || !finite(advance, phase) || !stamp.ops.length) return 0n;
    const copy = new NativePath();
    copy.set(stamp);
    return handle(new Path1DEffect(copy, advance, phase, style));
  },
});
rt.registerJnis("android/graphics/ComposePathEffect", {
  "nativeCreate(JJ)J": (outer: bigint, inner: bigint) => {
    const o = effectOf(outer), i = effectOf(inner);
    return o && i ? handle(new ComposeEffect(o, i)) : o ? outer : inner;
  },
});
rt.registerJnis("android/graphics/SumPathEffect", {
  "nativeCreate(JJ)J": (first: bigint, second: bigint) => {
    const a = effectOf(first), b = effectOf(second);
    return a && b ? handle(new SumEffect(a, b)) : a ? first : second;
  },
});
/** SkStrokeRec(paint): FILL_AND_STROKE of width 0 is a fill */
export const strokeRec = (p: NativePaint): StrokeRec => ({
  fill: p.style === 0 || p.style === 2 && p.strokeWidth === 0, width: p.strokeWidth, strokeAndFill: p.style === 2 && p.strokeWidth !== 0,
});
/** skpathutils::FillPathWithPaint: the path effect, then the stroke; false for a hairline */
function fillPath(p: NativePaint, src: NativePath, dst: NativePath): boolean {
  const rec = strokeRec(p), tmp = new NativePath();
  const path = p.pathEffect?.filter(tmp, src, rec) ? tmp : src;
  if (rec.fill || rec.width === 0) { dst.set(path); return rec.fill; }
  // SkStroke is CanvasKit's; stroke-and-fill adds the source to the outline, as SkStroke's fill does
  const cmds: number[] = [];
  walkPath(path, {
    moveTo: (x, y) => cmds.push(0, x, y), lineTo: (x, y) => cmds.push(1, x, y), quadraticCurveTo: (a, b, x, y) => cmds.push(2, a, b, x, y),
    conicTo: (a, b, x, y, w) => cmds.push(3, a, b, x, y, w), bezierCurveTo: (a, b, c, d, x, y) => cmds.push(4, a, b, c, d, x, y), closePath: () => cmds.push(5),
  });
  const out = strokeCommands(cmds, rec.width, p.strokeMiter, CAPS.indexOf(p.strokeCapN), JOINS.indexOf(p.strokeJoinN));
  if (!out) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "stroking a path needs the page's CanvasKit");
  dst.reset();
  for (let i = 0; i < out.length;) {
    const verb = out[i++];
    if (verb === 0) dst.moveTo(out[i++], out[i++]);
    else if (verb === 1) dst.lineTo(out[i++], out[i++]);
    else if (verb === 2) { dst.quadTo(out[i], out[i + 1], out[i + 2], out[i + 3]); i += 4; }
    else if (verb === 3) { dst.conicTo(out[i], out[i + 1], out[i + 2], out[i + 3], out[i + 4]); i += 5; }
    else if (verb === 4) { dst.cubicTo(out[i], out[i + 1], out[i + 2], out[i + 3], out[i + 4], out[i + 5]); i += 6; }
    else dst.close();
  }
  if (rec.strokeAndFill) dst.append(path);
  return true;
}

// ── minikin locale lists: an id per distinct list of tags
const localeLists = new Map<string, number>();
const localeTags: string[] = [];
function localeListId(tags: string): number {
  let id = localeLists.get(tags);
  if (id === undefined) { localeLists.set(tags, id = localeTags.length); localeTags.push(tags); }
  return id;
}
function setLocales(p: NativePaint, id: number) {
  p.localeListId = id;
  p.language = localeTags[id]?.split(",")[0] || device.locale;
}

// ── natives
export const paintAt = (h: bigint) => deref<NativePaint>(h);
const flag = (bit: number) => (h: bigint, v: number) => paintAt(h).setFlag(bit, !!v);
/** the SkFont flags MinikinPaint compares: anti-aliasing, fake bold, linear metrics and subpixel positioning */
const FONT_FLAGS = AA | FAKE_BOLD_TEXT | LINEAR | SUBPIXEL;
const pathAt = (h: bigint) => deref<NativePath>(h);
/** a run's direction under Paint's bidi flags: BIDI_RTL and BIDI_FORCE_RTL, or the default
 *  directions' first strong character (the whole run takes one direction) */
const STRONG = /\p{L}/u;
const RTL_CHAR = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
function isRtl(bidi: number, text: string): boolean {
  if (bidi === 1 || bidi === 5) return true;
  if (bidi === 0 || bidi === 4) return false;
  const strong = STRONG.exec(text);
  return strong ? RTL_CHAR.test(strong[0]) : bidi === 3;
}
/** Paint::getTextPath: the run shaped as minikin lays it out, aligned, its glyph outlines at their
 *  positions (fake bold's outline emboldening is not applied) */
function textPath(p: NativePaint, bidi: number, text: string, x: number, y: number, path: bigint): void | Promise<void> {
  const dst = pathAt(path);
  dst.reset();
  return after(shapeTextRun(text, 0, text.length, 0, text.length, isRtl(bidi, text), p), (layout) =>
    layoutOutlines(layout, p, x - (p.textAlignN === 1 ? layout.advance / 2 : p.textAlignN === 2 ? layout.advance : 0), y, dst));
}
/** SkColor4f through the colour space a ColorLong names, as sRGB ARGB */
const colorOf = (cs: bigint, c: bigint) => colorLongArgb(c, cs ? deref<NativeColorSpace>(cs) : null);
rt.registerJnis(PAINT, {
  "nInit()J": () => handle(new NativePaint()),
  "nInitWithPaint(J)J": (h: bigint) => { const p = new NativePaint(); copyPaint(paintAt(h), p); return handle(p); },
  "nGetNativeFinalizer()J": () => FINALIZER,
  // Paint::reset: the SkPaint and SkFont state and the shadow; the text layout state stays
  "nReset(J)V": (h: bigint) => { const p = paintAt(h), fresh = new NativePaint(); copyTextState(p, fresh); copyPaint(fresh, p); },
  "nSet(JJ)V": (h: bigint, src: bigint) => copyPaint(paintAt(src), paintAt(h)),

  "nSetColor(JI)V": (h: bigint, c: number) => { paintAt(h).color = c; },
  "nSetColor(JJJ)V": (h: bigint, cs: bigint, c: bigint) => { paintAt(h).color = colorOf(cs, c); },
  "nSetAlpha(JI)V": (h: bigint, a: number) => paintAt(h).setAlpha(a),
  "nSetStyle(JI)V": (h: bigint, v: number) => { paintAt(h).style = v; },
  "nGetStyle(J)I": (h: bigint) => paintAt(h).style,
  // SkPaint ignores a negative width or miter
  "nSetStrokeWidth(JF)V": (h: bigint, w: number) => { if (w >= 0) paintAt(h).strokeWidth = w; },
  "nGetStrokeWidth(J)F": (h: bigint) => paintAt(h).strokeWidth,
  "nSetStrokeMiter(JF)V": (h: bigint, m: number) => { if (m >= 0) paintAt(h).strokeMiter = m; },
  "nGetStrokeMiter(J)F": (h: bigint) => paintAt(h).strokeMiter,
  "nSetStrokeCap(JI)V": (h: bigint, v: number) => { paintAt(h).strokeCapN = CAPS[v] ?? "butt"; },
  "nGetStrokeCap(J)I": (h: bigint) => Math.max(0, CAPS.indexOf(paintAt(h).strokeCapN)),
  "nSetStrokeJoin(JI)V": (h: bigint, v: number) => { paintAt(h).strokeJoinN = JOINS[v] ?? "miter"; },
  "nGetStrokeJoin(J)I": (h: bigint) => Math.max(0, JOINS.indexOf(paintAt(h).strokeJoinN)),

  "nSetFlags(JI)V": (h: bigint, f: number) => { paintAt(h).flags = f & FLAG_MASK; },
  "nGetFlags(J)I": (h: bigint) => paintAt(h).flags,
  "nSetAntiAlias(JZ)V": flag(AA),
  "nSetFilterBitmap(JZ)V": flag(2),
  "nSetDither(JZ)V": flag(4),
  "nSetUnderlineText(JZ)V": flag(UNDERLINE),
  "nSetStrikeThruText(JZ)V": flag(STRIKE_THRU),
  "nSetFakeBoldText(JZ)V": flag(FAKE_BOLD_TEXT),
  "nSetLinearText(JZ)V": flag(LINEAR),
  "nSetSubpixelText(JZ)V": flag(SUBPIXEL),
  "nSetHinting(JI)V": (h: bigint, mode: number) => { paintAt(h).hinting = mode ? 1 : 0; },
  "nGetHinting(J)I": (h: bigint) => paintAt(h).hinting,

  // each effect setter answers the handle it was given, which Paint keeps
  "nSetShader(JJ)J": (h: bigint, sh: bigint) => { paintAt(h).shader = sh ? deref<NativeShader>(sh) : null; return sh; },
  "nSetColorFilter(JJ)J": (h: bigint, f: bigint) => { paintAt(h).colorFilter = f ? deref<NativeColorFilter>(f) : null; return f; },
  "nSetMaskFilter(JJ)J": (h: bigint, f: bigint) => { paintAt(h).maskFilter = maskFilterOf(f); return f; },
  "nSetPathEffect(JJ)J": (h: bigint, e: bigint) => { paintAt(h).setPathEffect(effectOf(e)); return e; },
  // Xfermode.porterDuffMode is an SkBlendMode; SRC_OVER is plain drawing
  "nSetXfermode(JI)V": (h: bigint, mode: number) => paintAt(h).setBlendName(mode === 3 ? null : BLEND_MODES[mode] ?? null),
  // a BlurDrawLooper: any positive radius, whatever the colour
  "nSetShadowLayer(JFFFJJ)V": (h: bigint, radius: number, dx: number, dy: number, cs: bigint, color: bigint) => {
    const p = paintAt(h);
    if (radius > 0) { p.shadowRadius = radius; p.shadowDx = dx; p.shadowDy = dy; p.shadowColor = colorOf(cs, color); }
    else p.shadowRadius = p.shadowDx = p.shadowDy = p.shadowColor = 0;
  },
  "nHasShadowLayer(J)Z": (h: bigint) => +(paintAt(h).shadowRadius > 0),

  "nSetTypeface(JJ)V": (h: bigint, t: bigint) => { paintAt(h).tf = t ? deref<NativeTypeface>(t) : null; },
  "nSetTextSize(JF)V": (h: bigint, v: number) => { if (v >= 0) paintAt(h).textSize = v; },
  "nGetTextSize(J)F": (h: bigint) => paintAt(h).textSize,
  "nSetTextScaleX(JF)V": (h: bigint, v: number) => { paintAt(h).textScaleX = v; },
  "nGetTextScaleX(J)F": (h: bigint) => paintAt(h).textScaleX,
  "nSetTextSkewX(JF)V": (h: bigint, v: number) => { paintAt(h).textSkewX = v; },
  "nGetTextSkewX(J)F": (h: bigint) => paintAt(h).textSkewX,
  "nSetTextAlign(JI)V": (h: bigint, v: number) => { paintAt(h).textAlignN = v; },
  "nGetTextAlign(J)I": (h: bigint) => paintAt(h).textAlignN,
  "nSetLetterSpacing(JF)V": (h: bigint, v: number) => { paintAt(h).letterSpacingEm = v; },
  "nGetLetterSpacing(J)F": (h: bigint) => paintAt(h).letterSpacingEm,
  "nSetWordSpacing(JF)V": (h: bigint, v: number) => { paintAt(h).wordSpacing = v; },
  "nGetWordSpacing(J)F": (h: bigint) => paintAt(h).wordSpacing,
  "nSetFontFeatureSettings(JLjava/lang/String;)V": (h: bigint, v: string | null) => { paintAt(h).fontFeatureSettings = v || null; },
  "nSetTextLocales(JLjava/lang/String;)I": (h: bigint, tags: string) => { const id = localeListId(tags); setLocales(paintAt(h), id); return id; },
  "nSetTextLocalesByMinikinLocaleListId(JI)V": (h: bigint, id: number) => setLocales(paintAt(h), id),
  "nSetElegantTextHeight(JI)V": (h: bigint, v: number) => { paintAt(h).elegant = v; },
  "nGetElegantTextHeight(J)I": (h: bigint) => paintAt(h).elegant,
  "nSetStartHyphenEdit(JI)V": (h: bigint, v: number) => { paintAt(h).startHyphenEdit = v; },
  "nGetStartHyphenEdit(J)I": (h: bigint) => paintAt(h).startHyphenEdit,
  "nSetEndHyphenEdit(JI)V": (h: bigint, v: number) => { paintAt(h).endHyphenEdit = v; },
  "nGetEndHyphenEdit(J)I": (h: bigint) => paintAt(h).endHyphenEdit,

  "nAscent(J)F": (h: bigint) => fontAscent(paintAt(h)),
  "nDescent(J)F": (h: bigint) => fontDescent(paintAt(h)),
  "nGetUnderlinePosition(J)F": (h: bigint) => underlinePosition(paintAt(h)),
  "nGetUnderlineThickness(J)F": (h: bigint) => underlineThickness(paintAt(h)),
  "nGetStrikeThruPosition(J)F": (h: bigint) => strikeThruPosition(paintAt(h)),
  "nGetStrikeThruThickness(J)F": (h: bigint) => strikeThruThickness(paintAt(h)),
  "nGetFontMetrics(JLandroid/graphics/Paint$FontMetrics;Z)F": (h: bigint, fm: object | null) => fillFontMetrics(paintAt(h), fm, false),
  "nGetFontMetricsInt(JLandroid/graphics/Paint$FontMetricsInt;Z)I": (h: bigint, fm: object | null) => fillFontMetrics(paintAt(h), fm, true),
  // the per-run forms answer for one text run; with one font for everything, the run does
  // not change the answer, so they are the whole-paint metrics
  "nGetFontMetricsIntForText(J[CIIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _c: Uint16Array, _a: number, _b: number, _d: number, _e: number, _f: number, fm: object) => fillFontMetrics(paintAt(h), fm, true),
  "nGetFontMetricsIntForText(JLjava/lang/String;IIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _s: string, _a: number, _b: number, _d: number, _e: number, _f: number, fm: object) => fillFontMetrics(paintAt(h), fm, true),
  "nGetCharArrayBounds(J[CIIILandroid/graphics/Rect;)V": (h: bigint, c: Uint16Array, i: number, n: number, _bidi: number, r: Box) =>
    textBounds(paintAt(h), charsToString(c, i, n), r),
  "nGetStringBounds(JLjava/lang/String;IIILandroid/graphics/Rect;)V": (h: bigint, s: string, a: number, b: number, _bidi: number, r: Box) =>
    textBounds(paintAt(h), s.slice(a, b), r),
  // MinikinPaint equality: size, scale, skew, spacing, font flags, features, locales and typeface
  "nEqualsForTextMeasurement(JJ)Z": (a: bigint, b: bigint) => {
    const x = paintAt(a), y = paintAt(b);
    return +(x === y || x.textSize === y.textSize && x.textScaleX === y.textScaleX && x.textSkewX === y.textSkewX
      && x.letterSpacingEm === y.letterSpacingEm && x.wordSpacing === y.wordSpacing && x.hinting === y.hinting
      && (x.flags & FONT_FLAGS) === (y.flags & FONT_FLAGS) && x.fontFeatureSettings === y.fontFeatureSettings
      && x.localeListId === y.localeListId && typefaceOf(x.tf) === typefaceOf(y.tf));
  },
  "nHasGlyph(JILjava/lang/String;)Z": (h: bigint, bidi: number, s: string) => after(hasGlyph(s, isRtl(bidi, s), paintAt(h)), (has) => +has),
  "nGetTextPath(JI[CIIFFJ)V": (h: bigint, bidi: number, c: Uint16Array, index: number, count: number, x: number, y: number, path: bigint) =>
    textPath(paintAt(h), bidi, charsToString(c, index, count), x, y, path),
  "nGetTextPath(JILjava/lang/String;IIFFJ)V": (h: bigint, bidi: number, s: string, start: number, end: number, x: number, y: number, path: bigint) =>
    textPath(paintAt(h), bidi, s.slice(start, end), x, y, path),
  "nGetFillPath(JJJ)Z": (h: bigint, src: bigint, dst: bigint) => +fillPath(paintAt(h), pathAt(src), pathAt(dst)),
});
