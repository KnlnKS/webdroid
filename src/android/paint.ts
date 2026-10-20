// hwui's Paint (an SkPaint, its SkFont and minikin's text state) behind android.graphics.Paint's
// mNativePaint, with its natives and the text metrics TS reads off it. Paint and TextPaint run from
// AOSP bytecode; TS reaches a Java paint's native state through paintOf.

import { rt, declaredField, type JObj } from "../jvm/runtime.ts";
import { charsToString } from "../jvm/abi.ts";
import { after, newObj, vcall } from "../jvm/natives/jentry.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { device } from "../shell/config.ts";
import { type NativeTypeface, type FakedFont, resolveDefault } from "./fonts.ts";
import type { FaceMetrics } from "./sfnt.ts";
import { type NativeColorFilter, type NativeShader, COMPOSITE, BLEND_MODES, cssColor, matrixColor, setEdges, emptyBox } from "./graphics.ts";
import { colorLongAt } from "./bitmap.ts";
import { NativePath, skCommands, setSkCommands, pathAt } from "./path.ts";
import { type NativeMaskFilter, maskFilterAt } from "./maskfilter.ts";
import { type NativePathEffect, DashEffect, effectAt, strokeRec } from "./patheffect.ts";
import { shapeTextRun, layoutOutlines, layoutBounds, hasGlyph } from "./shaping.ts";
import { strokeCommands } from "./skia.ts";
import { deviceScale } from "./matrix.ts";
import { isRecording, recordOrRun, transformOf, type Ctx2D } from "./recording.ts";

const PAINT = "android/graphics/Paint";
/** Paint's flag bits hwui keeps (getJavaFlags): LCD_RENDER_TEXT and VERTICAL_TEXT are not */
const FLAG_MASK = 0x6dff;
const AA = 1, UNDERLINE = 8, STRIKE_THRU = 0x10, FAKE_BOLD_TEXT = 0x20, LINEAR = 0x40, SUBPIXEL = 0x80;
/** what `new Paint()` sets: ANTI_ALIAS_FLAG and HIDDEN_DEFAULT_PAINT_FLAGS */
const DEFAULT_FLAGS = 0x503;
/** nSetElegantTextHeight's value for elegant metrics: Paint passes 0 for true, 1 for false and -1
 *  (unset, the default under the compat change) for neither */
const ELEGANT = 0;
export const CAPS: readonly CanvasLineCap[] = ["butt", "round", "square"];
export const JOINS: readonly CanvasLineJoin[] = ["miter", "round", "bevel"];

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

  // the primary font is a pure function of the typeface; text ops and metrics ask for it often
  private pTf: NativeTypeface | null | undefined = undefined;
  private pFont: FakedFont | null = null;
  /** minikin's primary font: the typeface's first family as it matches the typeface's style */
  primary(): FakedFont {
    if (this.pTf !== this.tf) {
      const t = resolveDefault(this.tf);
      this.pFont = t.collection.families[0].match(t.weight, t.italic);
      this.pTf = this.tf;
    }
    return this.pFont!;
  }
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

/** A Java Paint's native state, as a draw sees it: Paint.getNativeInstance first hands the native
 *  paint its shader's and colour filter's current native instances */
export const paintOf = (p: object): NativePaint | Promise<NativePaint> => after(vcall(p, "getNativeInstance", "()J"), (h: bigint) => deref<NativePaint>(h));
const TEXT_PAINT = "android/text/TextPaint";
/** `new Paint(ANTI_ALIAS_FLAG)` or `new TextPaint(ANTI_ALIAS_FLAG)` from host code, which waits when a call it makes links code */
export const newPaint = async (cls: typeof PAINT | typeof TEXT_PAINT = PAINT): Promise<JObj> => await newObj(cls, "(I)V", AA) as JObj;
/** ZygoteInit.preloadClasses' share: Paint, TextPaint and what their constructors reach */
export const preloadPaint = (): unknown => newObj(TEXT_PAINT, "(I)V", AA);

// ── text metrics
/** Paint's metrics are its primary font's (hhea ascent/descent, head bounds), fractional */
const metricsOf = (p: NativePaint): FaceMetrics => p.primary().font.faceMetrics!;
/** getMetricsInternal's elegant-height metrics, in 2048ths of the size: top, ascent, descent, bottom */
const ELEGANT_METRICS = [2500, 1900, 500, 1000];
const elegant = (p: NativePaint, i: number) => (i < 2 ? -p.textSize : p.textSize) * ELEGANT_METRICS[i] / 2048;
const fontAscent = (p: NativePaint): number => p.elegant === ELEGANT ? elegant(p, 1) : -p.textSize * metricsOf(p).ascent;
const fontDescent = (p: NativePaint): number => p.elegant === ELEGANT ? elegant(p, 2) : p.textSize * metricsOf(p).descent;
export const fontTop = (p: NativePaint): number => p.elegant === ELEGANT ? elegant(p, 0) : Math.fround(-p.textSize * metricsOf(p).top);
export const fontBottom = (p: NativePaint): number => p.elegant === ELEGANT ? elegant(p, 3) : Math.fround(p.textSize * metricsOf(p).bottom);
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
export const underlinePosition = (p: NativePaint) => f32(p.textSize * (metricsOf(p).underline ?? STD_UNDERLINE_TOP));
export const underlineThickness = (p: NativePaint) => f32(p.textSize * (metricsOf(p).underlineThickness ?? STD_THICKNESS));
export const strikeThruPosition = (p: NativePaint) => f32(p.textSize * STD_STRIKE_THRU_TOP);
export const strikeThruThickness = (p: NativePaint) => f32(p.textSize * STD_THICKNESS);

/** Paint::getTextBounds: the laid-out glyphs' bounds, rounded out */
function textBounds(p: NativePaint, bidi: number, s: string, r: object) {
  return after(layoutBounds(s, isRtl(bidi, s), p), (b) => {
    setEdges(r, b ? { left: Math.floor(b[0]), top: Math.floor(b[1]), right: Math.ceil(b[2]), bottom: Math.ceil(b[3]) } : emptyBox);
  });
}

// ── strokes
/** SkDrawTreatAsHairline: under one device pixel a stroke is a hairline, as wide as that pixel; an
 *  anti-aliased stroke narrower still keeps its width, which the 2D context draws as Skia does, at reduced coverage */
const strokeWidthOn = (ctx: Ctx2D, width: number, antiAlias: boolean): number => {
  const pixel = 1 / (deviceScale(transformOf(ctx)) || 1);
  return width >= pixel || antiAlias && width > 0 ? width : pixel;
};
/** a stroke's width, cap, join and miter limit on `ctx`; a recording takes the device pixel of the transform it is drawn under */
export function applyStroke(ctx: Ctx2D, width: number, antiAlias: boolean, cap: CanvasLineCap, join: CanvasLineJoin, miter: number): void {
  if (antiAlias && width > 0) ctx.lineWidth = width;
  else if (isRecording(ctx)) recordOrRun(ctx, (c) => { c.lineWidth = strokeWidthOn(c, width, antiAlias); });
  else ctx.lineWidth = strokeWidthOn(ctx, width, antiAlias);
  ctx.lineCap = cap; ctx.lineJoin = join;
  if (join === "miter") ctx.miterLimit = miter;
}

// ── shadows
export function beginPaintShadow(ctx: Ctx2D, p: NativePaint): boolean {
  if (!(p.shadowRadius > 0) || !(p.shadowColor >>> 24)) return false;
  const m = ctx.getTransform();
  ctx.save();
  ctx.shadowColor = cssColor(p.shadowColor);
  ctx.shadowBlur = p.shadowRadius * deviceScale(m);
  ctx.shadowOffsetX = m.a * p.shadowDx + m.c * p.shadowDy;
  ctx.shadowOffsetY = m.b * p.shadowDx + m.d * p.shadowDy;
  return true;
}

/** skpathutils::FillPathWithPaint: the path effect, then SkStroke (stroke-and-fill adds the source
 *  to the outline, as SkStroke's fill does); false for a hairline */
function fillPath(p: NativePaint, src: NativePath, dst: NativePath): boolean | Promise<boolean> {
  const rec = strokeRec(p), tmp = new NativePath();
  const path = p.pathEffect?.filter(tmp, src, rec) ? tmp : src;
  if (rec.fill || rec.width === 0) { dst.set(path); return rec.fill; }
  return after(strokeCommands(skCommands(path), rec.width, p.strokeMiter, CAPS.indexOf(p.strokeCapN), JOINS.indexOf(p.strokeJoinN)), (out) => {
    if (out) setSkCommands(dst, out); else dst.reset();
    if (rec.strokeAndFill) dst.append(path);
    return true;
  });
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
rt.registerJnis(PAINT, {
  "nInit()J": () => handle(new NativePaint()),
  "nInitWithPaint(J)J": (h: bigint) => { const p = new NativePaint(); copyPaint(paintAt(h), p); return handle(p); },
  "nGetNativeFinalizer()J": () => FINALIZER,
  // Paint::reset: the SkPaint and SkFont state and the shadow; the text layout state stays
  "nReset(J)V": (h: bigint) => { const p = paintAt(h), fresh = new NativePaint(); copyTextState(p, fresh); copyPaint(fresh, p); },
  "nSet(JJ)V": (h: bigint, src: bigint) => copyPaint(paintAt(src), paintAt(h)),

  "nSetColor(JI)V": (h: bigint, c: number) => { paintAt(h).color = c; },
  "nSetColor(JJJ)V": (h: bigint, cs: bigint, c: bigint) => { paintAt(h).color = colorLongAt(c, cs); },
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
  "nSetMaskFilter(JJ)J": (h: bigint, f: bigint) => { paintAt(h).maskFilter = maskFilterAt(f); return f; },
  "nSetPathEffect(JJ)J": (h: bigint, e: bigint) => { paintAt(h).setPathEffect(effectAt(e)); return e; },
  // Xfermode.porterDuffMode is an SkBlendMode; SRC_OVER is plain drawing
  "nSetXfermode(JI)V": (h: bigint, mode: number) => paintAt(h).setBlendName(mode === 3 ? null : BLEND_MODES[mode] ?? null),
  // a BlurDrawLooper: any positive radius, whatever the colour
  "nSetShadowLayer(JFFFJJ)V": (h: bigint, radius: number, dx: number, dy: number, cs: bigint, color: bigint) => {
    const p = paintAt(h);
    if (radius > 0) { p.shadowRadius = radius; p.shadowDx = dx; p.shadowDy = dy; p.shadowColor = colorLongAt(color, cs); }
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
  "nGetCharArrayBounds(J[CIIILandroid/graphics/Rect;)V": (h: bigint, c: Uint16Array, i: number, n: number, bidi: number, r: object) =>
    textBounds(paintAt(h), bidi, charsToString(c, i, n), r),
  "nGetStringBounds(JLjava/lang/String;IIILandroid/graphics/Rect;)V": (h: bigint, s: string, a: number, b: number, bidi: number, r: object) =>
    textBounds(paintAt(h), bidi, s.slice(a, b), r),
  // MinikinPaint equality: size, scale, skew, spacing, font flags, features, locales and typeface
  "nEqualsForTextMeasurement(JJ)Z": (a: bigint, b: bigint) => {
    const x = paintAt(a), y = paintAt(b);
    return +(x === y || x.textSize === y.textSize && x.textScaleX === y.textScaleX && x.textSkewX === y.textSkewX
      && x.letterSpacingEm === y.letterSpacingEm && x.wordSpacing === y.wordSpacing && x.hinting === y.hinting
      && (x.flags & FONT_FLAGS) === (y.flags & FONT_FLAGS) && x.fontFeatureSettings === y.fontFeatureSettings
      && x.localeListId === y.localeListId && resolveDefault(x.tf) === resolveDefault(y.tf));
  },
  "nHasGlyph(JILjava/lang/String;)Z": (h: bigint, bidi: number, s: string) => after(hasGlyph(s, isRtl(bidi, s), paintAt(h)), (has) => +has),
  "nGetTextPath(JI[CIIFFJ)V": (h: bigint, bidi: number, c: Uint16Array, index: number, count: number, x: number, y: number, path: bigint) =>
    textPath(paintAt(h), bidi, charsToString(c, index, count), x, y, path),
  "nGetTextPath(JILjava/lang/String;IIFFJ)V": (h: bigint, bidi: number, s: string, start: number, end: number, x: number, y: number, path: bigint) =>
    textPath(paintAt(h), bidi, s.slice(start, end), x, y, path),
  "nGetFillPath(JJJ)Z": (h: bigint, src: bigint, dst: bigint) => after(fillPath(paintAt(h), pathAt(src), pathAt(dst)), (b) => +b),
});
