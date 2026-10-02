// minikin's glyph-level layout over HarfBuzz and the page's font files: TextRunShaper and
// PositionedGlyphs, Font's glyph bounds, and the glyph runs Canvas.drawGlyphs draws. It follows
// minikin at android-15.0.0_r1 as the reference device shows it (values recorded in fwtest):
//   - the run is split into LayoutSplitter pieces (a word, or one space), each piece into font
//     runs over the typeface's families, each font run shaped on its own, in visual order;
//   - a glyph's advance is Skia's: whole pixels while hinting applies (no linear metrics, no skew),
//     and HarfBuzz's kerning on top unrounded;
//   - letter spacing adds half before and half after each cluster, except in joining scripts.
// Script runs within a font run are left to HarfBuzz's guess of the run's script.

import { rt } from "../jvm/runtime";
import { charsToString } from "../jvm/abi";
import { after } from "../jvm/natives/jlang";
import { handle, deref, FINALIZER } from "./handles";
import { type NativeFont, type NativeFamily, type NativeTypeface, type FakedFont, resolveDefault, FAKE_BOLD, FAKE_ITALIC, WGHT, ITAL, fontOf, wrapFont, cssFamily } from "./fonts";
import { type NativePaint, paintAt } from "./paint";
import { type HarfBuzz, type Font, harfBuzz, loadedHarfBuzz, HB_DIRECTION_INVALID, HB_DIRECTION_LTR, HB_DIRECTION_RTL } from "./harfbuzz";
import type { Ctx2D } from "./recording";
import type { NativePath } from "./path";

const f32 = Math.fround;

const breakAfter = (c: number) => c === 0x20 || c >= 0x2000 && c <= 0x200a || c === 0x3000
  || c >= 0x2066 && c <= 0x2069 || c >= 0x202a && c <= 0x202e || c === 0x200e || c === 0x200f;
const breakBefore = (c: number) => breakAfter(c) || c >= 0x3400 && c <= 0x9fff;
/** LayoutUtils' getNextWordBreakForCache: where the layout piece starting at `at` ends */
export function pieceEnd(text: string, at: number, end: number): number {
  if (breakAfter(text.charCodeAt(at))) return at + 1;
  for (let i = at + 1; i < end; i++) if (breakBefore(text.charCodeAt(i))) return i;
  return end;
}
/** scripts whose letters join, which minikin does not letter-space */
export const JOINING = /[\p{sc=Arab}\p{sc=Nkoo}\p{sc=Phlp}\p{sc=Mand}\p{sc=Mong}\p{sc=Phag}\p{sc=Deva}\p{sc=Beng}\p{sc=Guru}\p{sc=Modi}\p{sc=Shrd}\p{sc=Sylo}\p{sc=Tirh}\p{sc=Ogam}]/u;
/** the HarfBuzz features a paint shapes with: optional ligatures are off under letter spacing, as
 *  CSS asks */
export const featuresOf = (p: NativePaint): string | null => Math.abs(p.letterSpacingEm) > 0.03
  ? "liga=0,clig=0" + (p.fontFeatureSettings ? "," + p.fontFeatureSettings : "") : p.fontFeatureSettings;

const fontCache = new WeakMap<NativeFont, Font>();
/** the HarfBuzz font drawing `f`: its own axes, then the fakery's */
function hbFont(hb: HarfBuzz, f: NativeFont, weight = -1, italic = -1): Font {
  if (weight < 0 && italic < 0) {
    let font = fontCache.get(f);
    if (!font) fontCache.set(f, font = hb.font(hb.face(f.bytes, f.ttcIndex), f.axes.map((a) => [a.tag, a.value])));
    return font;
  }
  const axes: [number, number][] = f.axes.map((a) => [a.tag, a.value]);
  if (weight >= 0) axes.push([WGHT, weight]);
  if (italic >= 0) axes.push([ITAL, italic]);
  return hb.font(hb.face(f.bytes, f.ttcIndex), axes);
}

/** whether Skia hints the glyphs, so their advances are whole pixels: an outline font, without
 *  linear metrics and not skewed (a fake italic is a skew) */
const hints = (p: NativePaint, font: NativeFont, faked = 0) => !p.linearText && p.textSkewX === 0 && !(faked & FAKE_ITALIC) && font.scalable;

// ── itemization: FontCollection::itemize
const isEmojiFamily = (f: NativeFamily) => /(^|[ ,-])Zsye\b/.test(f.langTags);
const isVS = (c: number) => c >= 0xfe00 && c <= 0xfe0f || c >= 0xe0100 && c <= 0xe01ef;
/** characters shaped with whatever font is current (joiners, selectors, bidi and tag controls) */
const noFontNeeded = (c: number) => c === 0x200c || c === 0x200d || isVS(c) || c >= 0x200e && c <= 0x200f
  || c >= 0x202a && c <= 0x202e || c >= 0x2066 && c <= 0x2069 || c >= 0xe0020 && c <= 0xe007f;
/** characters that stay in the current font when it has them */
const STICKY = new Set([0x21, 0x2c, 0x2d, 0x2e, 0x3a, 0x3b, 0x3f, 0xa0, 0x2010, 0x2011, 0x202f, 0x2640, 0x2642, 0x2695]);
const COMBINING = /\p{M}/u, EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const sticks = (c: number, prev: number) => STICKY.has(c) || c >= 0x1f3fb && c <= 0x1f3ff || c === 0x20e3
  || prev === 0x200d || COMBINING.test(String.fromCodePoint(c));

const coverage = new WeakMap<NativeFamily, Font>();
function covers(hb: HarfBuzz, family: NativeFamily, c: number, vs = 0): boolean {
  let font = coverage.get(family);
  if (!font) coverage.set(family, font = hbFont(hb, family.closest(400, false)));
  return hb.glyph(font, c, vs) !== 0;
}
/** getFamilyForChar: the first family scoring highest, the first family when none has the
 *  character. The first family wins whenever it has it; a variation selector, or else emoji
 *  presentation, prefers the family whose style it asks for; then the paint's language. */
function familyFor(hb: HarfBuzz, families: readonly NativeFamily[], c: number, vs: number, lang: string): NativeFamily {
  let best = families[0], bestScore = 0, emoji: boolean | undefined;
  for (let i = 0; i < families.length; i++) {
    const f = families[i], withVS = vs !== 0 && covers(hb, f, c, vs);
    if (!withVS && !covers(hb, f, c)) continue;
    if (i === 0 && (vs === 0 || withVS)) return f;
    emoji ??= vs === 0xfe0f || vs !== 0xfe0e && EMOJI_PRESENTATION.test(String.fromCodePoint(c));
    let score = withVS ? 6 : (vs === 0xfe0f || vs === 0xfe0e || vs === 0) && isEmojiFamily(f) === emoji ? 4 : 2;
    if (f.langTags && lang && f.langTags.split(/[ ,]/).some((t) => t.split("-")[0] === lang.split("-")[0])) score++;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}
/** [start, end) of `text` as font runs: boundaries and families, in logical order */
function itemize(hb: HarfBuzz, families: readonly NativeFamily[], text: string, start: number, end: number, lang: string): (number | NativeFamily)[] {
  const out: (number | NativeFamily)[] = [];
  let last: NativeFamily | null = null, prev = 0;
  for (let i = start; i < end;) {
    const c = text.codePointAt(i)!, n = c > 0xffff ? 2 : 1, next = i + n < end ? text.codePointAt(i + n)! : 0;
    const keep = last && (noFontNeeded(c) || sticks(c, prev) && covers(hb, last, c));
    if (!keep) {
      const f = familyFor(hb, families, c, isVS(next) ? next : 0, lang);
      if (f !== last) { out.push(i, f); last = f; }
    }
    prev = c; i += n;
  }
  out.push(end);
  return out;
}

// ── layout
/** minikin's Layout as TextShaper's LayoutWrapper holds it: glyphs in visual order */
export class Layout {
  constructor(readonly ids: Uint32Array, readonly x: Float32Array, readonly y: Float32Array, readonly fonts: readonly FakedFont[],
    readonly advance: number, readonly ascent: number, readonly descent: number) {}
}
/** glyph ids of color fonts, by the text they were shaped from: a color glyph has no outline to
 *  draw, so drawGlyphs draws its text in the font instead */
const colorText = new WeakMap<Font, Map<number, string>>();

/** Layout for text[start, start + count) in one direction, context around it (TextShaper's
 *  shapeTextRun) */
export function shapeTextRun(text: string, start: number, count: number, ctxStart: number, ctxCount: number, rtl: boolean, p: NativePaint): Layout | Promise<Layout> {
  return after(harfBuzz(), (hb) => layout(hb, text, start, start + count, ctxStart, ctxStart + ctxCount, rtl, p));
}
function layout(hb: HarfBuzz, text: string, start: number, end: number, ctxStart: number, ctxEnd: number, rtl: boolean, p: NativePaint): Layout {
  const t = resolveDefault(p.tf), families = t.collection.families, size = p.textSize, scaleX = p.textScaleX;
  const ids: number[] = [], xs: number[] = [], ys: number[] = [], fonts: FakedFont[] = [];
  const features = featuresOf(p);
  const pieces: number[] = [];
  for (let i = start; i < end;) { const e = Math.min(pieceEnd(text, i, end), end); pieces.push(i, e); i = e; }
  hb.setText(text, ctxStart, ctxEnd);
  let x = 0, ascent = 0, descent = 0;
  const seen = new Set<NativeFont>();
  for (let k = 0; k < pieces.length; k += 2) {
    const piece = rtl ? pieces.length - 2 - k : k;
    const runs = itemize(hb, families, text, pieces[piece], pieces[piece + 1], p.language);
    const nRuns = (runs.length - 1) / 2;
    for (let r = 0; r < nRuns; r++) {
      const at = (rtl ? nRuns - 1 - r : r) * 2, a = runs[at] as number, b = runs[at + 2] as number;
      const faked = (runs[at + 1] as NativeFamily).match(t.weight, t.italic), font = hbFont(hb, faked.font, faked.weight, faked.italic);
      const s = size / font.face.upem, sx = s * scaleX;
      const hinted = hints(p, faked.font, faked.fakery);
      const ls = p.letterSpacingEm && !JOINING.test(text.slice(a, b)) ? f32(f32(p.letterSpacingEm * size) * scaleX) : 0;
      const n = hb.shape(font, a - ctxStart, b - a, rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR, p.language, features);
      const w = hb.words(), info = hb.infos(), pos = hb.positions();
      const texts = font.face.color ? colorText.get(font) ?? colorText.set(font, new Map()).get(font)! : null;
      for (let i = 0; i < n; i++) {
        const glyph = w[info + i * 5], cluster = w[info + i * 5 + 2], o = pos + i * 5;
        if (ls && (i === 0 || w[info + (i - 1) * 5 + 2] !== cluster)) x = f32(x + ls / 2);
        ids.push(glyph); fonts.push(faked);
        xs.push(x + w[o + 2] * sx); ys.push(-w[o + 3] * s);
        x = f32(x + advanceOf(hb, font, glyph, w[o], sx, hinted));
        if (ls && (i === n - 1 || w[info + (i + 1) * 5 + 2] !== cluster)) x = f32(x + ls / 2);
        if (texts && !texts.has(glyph)) texts.set(glyph, clusterText(text, ctxStart, w, info, i, n, b));
      }
      if (n && !seen.has(faked.font)) {
        seen.add(faked.font);
        const m = faked.font.faceMetrics;
        if (m) { ascent = Math.min(ascent, f32(-m.ascent * size)); descent = Math.max(descent, f32(m.descent * size)); }
      }
    }
  }
  return new Layout(Uint32Array.from(ids), Float32Array.from(xs), Float32Array.from(ys), fonts, f32(x), ascent, descent);
}
/** a shaped glyph's advance in pixels: Skia's whole-pixel advance while hinting, with HarfBuzz's
 *  kerning on top; one HarfBuzz zeroed (a mark, a default ignorable) stays zero */
function advanceOf(hb: HarfBuzz, font: Font, glyph: number, advance: number, sx: number, hinted: boolean): number {
  if (!hinted || advance === 0) return f32(advance * sx);
  const nominal = hb.advance(font, glyph);
  return f32(Math.round(nominal * sx) + (advance - nominal) * sx);
}
/** what a measurement is shaped under: the paint's state when a run is measured */
export interface ShapeStyle { tf: NativeTypeface; size: number; scaleX: number; hinted: boolean; features: string | null; lang: string }
/** Layout::doLayoutRun's advances for one LayoutSplitter piece: each glyph's advance (hinted as
 *  layout's) added to its cluster's first code unit, before letter spacing. The direction is the
 *  one HarfBuzz guesses from the piece's script. */
export function measurePiece(piece: string, s: ShapeStyle): Float32Array {
  const hb = loadedHarfBuzz(), out = new Float32Array(piece.length);
  hb.setText(piece, 0, piece.length);
  const runs = itemize(hb, s.tf.collection.families, piece, 0, piece.length, s.lang);
  for (let r = 0; r + 2 < runs.length; r += 2) {
    const a = runs[r] as number, faked = (runs[r + 1] as NativeFamily).match(s.tf.weight, s.tf.italic);
    const font = hbFont(hb, faked.font, faked.weight, faked.italic), sx = s.size / font.face.upem * s.scaleX;
    const hinted = s.hinted && !(faked.fakery & FAKE_ITALIC) && faked.font.scalable;
    const n = hb.shape(font, a, (runs[r + 2] as number) - a, HB_DIRECTION_INVALID, s.lang, s.features);
    const w = hb.words(), info = hb.infos(), pos = hb.positions();
    for (let i = 0; i < n; i++) {
      out[w[info + i * 5 + 2]] += advanceOf(hb, font, w[info + i * 5], w[pos + i * 5], sx, hinted);
    }
  }
  return out;
}
/** the text of glyph i's cluster: from its cluster to the next cluster in logical order */
function clusterText(text: string, ctxStart: number, w: Int32Array, info: number, i: number, n: number, runEnd: number): string {
  const c = w[info + i * 5 + 2];
  let e = runEnd - ctxStart;
  for (let j = 0; j < n; j++) { const d = w[info + j * 5 + 2]; if (d > c && d < e) e = d; }
  return text.slice(ctxStart + c, ctxStart + e);
}

// ── Font's glyph queries
/** Font_getGlyphBounds: SkFont::getWidths of one glyph at the paint's size, scale and skew. The
 *  bounds are the transformed outline's control box rounded out to pixels, as FreeType's are for an
 *  unhinted glyph (the device's hinted outlines can differ by a pixel at small sizes); a glyph
 *  without an outline (a color or bitmap glyph) has its font's extents. */
export function glyphBounds(font: NativeFont, glyph: number, p: NativePaint, rect: { left: number; top: number; right: number; bottom: number } | null): number | Promise<number> {
  return after(harfBuzz(), (hb) => {
    const f = hbFont(hb, font), s = p.textSize / f.face.upem, sx = s * p.textScaleX;
    if (rect) {
      let box = hb.controlBox(f, glyph, sx, -p.textSkewX * s, -s);
      if (!box) { const e = hb.extents(f, glyph); box = e && [e[0] * sx, -e[3] * s, e[2] * sx, -e[1] * s]; }
      [rect.left, rect.top, rect.right, rect.bottom] = box ? [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])] : [0, 0, 0, 0];
    }
    const advance = hb.advance(f, glyph) * sx;
    return f32(hints(p, font) ? Math.round(advance) : advance);
  });
}

// ── Paint.hasGlyph and Paint.getTextPath
const isSurrogate = (c: number) => c >= 0xd800 && c <= 0xdfff, isTrail = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** android_graphics_Paint's hasGlyph: well-formed UTF-16 whose variation sequences a family supports,
 *  laid out without .notdef and, for more than one character, as one glyph (a ligature) */
export function hasGlyph(text: string, rtl: boolean, p: NativePaint): boolean | Promise<boolean> {
  return after(harfBuzz(), (hb) => {
    const families = resolveDefault(p.tf).collection.families;
    let chars = 0, prev = -1;
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (isSurrogate(c)) {
        if (isTrail(c) || !isTrail(text.charCodeAt(i + 1))) return false;
        c = text.codePointAt(i++)!;
      }
      if (prev >= 0 && isVS(c)) {
        // FontCollection::hasVariationSelector: a family maps the sequence, or, for the text
        // presentation selector, a family other than colour emoji has the base character
        const base = prev;
        if (!families.some((f) => covers(hb, f, base, c)) && !(c === 0xfe0e && families.some((f) => !isEmojiFamily(f) && covers(hb, f, base)))) return false;
        if (chars === 1 && i + 1 === text.length) return true;
      }
      chars++; prev = c;
    }
    const ids = layout(hb, text, 0, text.length, 0, text.length, rtl, p).ids;
    return (ids.length === 1 || chars <= 1) && ids.length > 0 && ids.every((g) => g !== 0);
  });
}
/** an outline sink placing font units under (x, y) -> (a x + c y + e, d y + f) into a path */
class PathSink {
  a = 1; c = 0; d = 1; e = 0; f = 0;
  constructor(readonly path: NativePath) {}
  moveTo(x: number, y: number) { this.path.moveTo(this.a * x + this.c * y + this.e, this.d * y + this.f); }
  lineTo(x: number, y: number) { this.path.lineTo(this.a * x + this.c * y + this.e, this.d * y + this.f); }
  quadraticCurveTo(x1: number, y1: number, x: number, y: number) {
    this.path.quadTo(this.a * x1 + this.c * y1 + this.e, this.d * y1 + this.f, this.a * x + this.c * y + this.e, this.d * y + this.f);
  }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.path.cubicTo(this.a * x1 + this.c * y1 + this.e, this.d * y1 + this.f, this.a * x2 + this.c * y2 + this.e, this.d * y2 + this.f,
      this.a * x + this.c * y + this.e, this.d * y + this.f);
  }
  closePath() { this.path.close(); }
}
/** SkFont::getPaths over a layout's glyphs, each at (x, y) plus its position, appended to `dst`: the
 *  paint's size, scale and skew, a fake italic's skew added (fake bold's emboldening is not) */
export function layoutOutlines(l: Layout, p: NativePaint, x: number, y: number, dst: NativePath): void | Promise<void> {
  return after(harfBuzz(), (hb) => {
    const sink = new PathSink(dst);
    for (let i = 0; i < l.ids.length; i++) {
      const faked = l.fonts[i], f = hbFont(hb, faked.font, faked.weight, faked.italic), s = p.textSize / f.face.upem;
      sink.a = s * p.textScaleX; sink.c = -(p.textSkewX - (faked.fakery & FAKE_ITALIC ? 0.25 : 0)) * s; sink.d = -s;
      sink.e = x + l.x[i]; sink.f = y + l.y[i];
      hb.draw(f, l.ids[i], sink);
    }
  });
}

// ── Canvas.drawGlyphs
let glyphMatrix: DOMMatrix | null = null;
/** Canvas::drawGlyphs: `count` glyphs of the Java Font `fontHandle` at their positions, drawn at the
 *  paint's size, scale and skew. `draw` fills or strokes with the paint as the canvas draws any
 *  shape; outlines become one Path2D, and color glyphs (which have none) draw the text they were
 *  shaped from in the font. */
export function drawGlyphs(draw: (fill: (c: Ctx2D) => void, stroke: (c: Ctx2D) => void) => void, ids: Int32Array, idOffset: number,
  positions: Float32Array, positionOffset: number, count: number, fontHandle: bigint, p: NativePaint): void | Promise<void> {
  if (count <= 0) return;
  const font = fontOf(fontHandle);
  return after(harfBuzz(), (hb) => {
    const f = hbFont(hb, font), s = p.textSize / f.face.upem, texts = colorText.get(f), path = new Path2D();
    const m = glyphMatrix ??= new DOMMatrix();
    m.a = s * p.textScaleX; m.b = 0; m.c = -p.textSkewX * s; m.d = -s;
    let color: [string, number, number][] | null = null;
    for (let i = 0; i < count; i++) {
      const glyph = ids[idOffset + i], x = positions[positionOffset + i * 2], y = positions[positionOffset + i * 2 + 1];
      const text = f.face.color ? texts?.get(glyph) : undefined;
      if (text) { (color ??= []).push([text, x, y]); continue; }
      const outline = hb.outline(f, glyph);
      if (!outline) continue;
      m.e = x; m.f = y;
      path.addPath(outline, m);
    }
    const css = color && `${p.textSize}px "${cssFamily(font) ?? "sans-serif"}"`;
    draw((c) => {
      c.fill(path);
      if (color) for (const [text, x, y] of color) {
        c.save();
        c.transform(p.textScaleX, 0, p.textSkewX, 1, x, y);
        c.font = css!; c.textAlign = "left"; c.textBaseline = "alphabetic";
        c.fillText(text, 0, 0);
        c.restore();
      }
    }, (c) => c.stroke(path));
  });
}

// ── natives
const layoutOf = (h: bigint) => deref<Layout>(h);
/** TextShaper.cpp's shapeTextRun: FORCE_RTL or FORCE_LTR over the paint's typeface */
const shapeNative = (text: string, start: number, count: number, ctxStart: number, ctxCount: number, rtl: number, paint: bigint) =>
  after(shapeTextRun(text, start, count, ctxStart, ctxCount, !!rtl, paintAt(paint)), handle);
rt.registerJnis("android/graphics/text/TextRunShaper", {
  "nativeShapeTextRun(Ljava/lang/String;IIIIZJ)J": shapeNative,
  "nativeShapeTextRun([CIIIIZJ)J": (chars: Uint16Array, start: number, count: number, ctxStart: number, ctxCount: number, rtl: number, paint: bigint) =>
    shapeNative(charsToString(chars, ctxStart, ctxCount), start - ctxStart, count, 0, ctxCount, rtl, paint),
});
rt.registerJnis("android/graphics/text/PositionedGlyphs", {
  "nReleaseFunc()J": () => FINALIZER,
  "nGetGlyphCount(J)I": (h: bigint) => layoutOf(h).ids.length,
  "nGetTotalAdvance(J)F": (h: bigint) => layoutOf(h).advance,
  "nGetAscent(J)F": (h: bigint) => layoutOf(h).ascent,
  "nGetDescent(J)F": (h: bigint) => layoutOf(h).descent,
  "nGetGlyphId(JI)I": (h: bigint, i: number) => layoutOf(h).ids[i],
  "nGetX(JI)F": (h: bigint, i: number) => layoutOf(h).x[i],
  "nGetY(JI)F": (h: bigint, i: number) => layoutOf(h).y[i],
  "nGetFont(JI)J": (h: bigint, i: number) => wrapFont(layoutOf(h).fonts[i].font),
  "nGetFakeBold(JI)Z": (h: bigint, i: number) => +!!(layoutOf(h).fonts[i].fakery & FAKE_BOLD),
  "nGetFakeItalic(JI)Z": (h: bigint, i: number) => +!!(layoutOf(h).fonts[i].fakery & FAKE_ITALIC),
  "nGetWeightOverride(JI)F": (h: bigint, i: number) => layoutOf(h).fonts[i].weight,
  "nGetItalicOverride(JI)F": (h: bigint, i: number) => layoutOf(h).fonts[i].italic,
});
