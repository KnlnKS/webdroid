// minikin's glyph-level layout over HarfBuzz and the page's font files: TextRunShaper and
// PositionedGlyphs, and Font's glyph bounds. It follows minikin at android-15.0.0_r1 as the
// reference device shows it (values recorded in fwtest):
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
import { type NativeFont, type NativeFamily, typefaceOf, fakery, FAKE_BOLD, FAKE_ITALIC, wrapFont } from "./fonts";
import { pieceEnd, JOINING } from "./minikin";
import { type HarfBuzz, type Font, harfBuzz, HB_DIRECTION_LTR, HB_DIRECTION_RTL } from "./harfbuzz";

const f32 = Math.fround;

/** what shaping and glyph drawing read of a paint */
export interface ShapePaint {
  tf: object | null; textSize: number; textScaleX: number; textSkewX: number; letterSpacingEm: number;
  linearText: boolean; language: string; fontFeatureSettings: string | null;
}

const tag = (s: string) => (s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0;
const WGHT = tag("wght"), ITAL = tag("ital");

/** minikin's FakedFont: a font, its fakery bits, and the wght/ital values a variable font is set
 *  to in place of faking (-1 where the font has no such axis) */
class FakedFont {
  constructor(readonly font: NativeFont, readonly fakery: number, readonly weight: number, readonly italic: number) {}
}
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
/** FontFamily::getClosestMatch */
function closest(family: NativeFamily, weight: number, italic: boolean): FakedFont {
  const font = family.closest(weight, italic), axes = font.supportedAxes;
  return new FakedFont(font, fakery(font, weight, italic), axes.includes(WGHT) ? weight : -1, axes.includes(ITAL) ? +italic : -1);
}

/** whether Skia hints the glyphs, so their advances are whole pixels: an outline font, without
 *  linear metrics and not skewed (a fake italic is a skew) */
const hints = (p: ShapePaint, font: NativeFont, faked = 0) => !p.linearText && p.textSkewX === 0 && !(faked & FAKE_ITALIC) && font.scalable;

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
/** Layout for text[start, start + count) in one direction, context around it (TextShaper's
 *  shapeTextRun) */
export function shapeTextRun(text: string, start: number, count: number, ctxStart: number, ctxCount: number, rtl: boolean, p: ShapePaint): Layout | Promise<Layout> {
  return after(harfBuzz(), (hb) => layout(hb, text, start, start + count, ctxStart, ctxStart + ctxCount, rtl, p));
}
function layout(hb: HarfBuzz, text: string, start: number, end: number, ctxStart: number, ctxEnd: number, rtl: boolean, p: ShapePaint): Layout {
  const t = typefaceOf(p.tf), families = t.collection.families, size = p.textSize, scaleX = p.textScaleX;
  const ids: number[] = [], xs: number[] = [], ys: number[] = [], fonts: FakedFont[] = [];
  // optional ligatures are off under letter spacing, as CSS asks
  const features = Math.abs(p.letterSpacingEm) > 0.03 ? "liga=0,clig=0" + (p.fontFeatureSettings ? "," + p.fontFeatureSettings : "") : p.fontFeatureSettings;
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
      const faked = closest(runs[at + 1] as NativeFamily, t.weight, t.italic), font = hbFont(hb, faked.font, faked.weight, faked.italic);
      const s = size / font.face.upem, sx = s * scaleX;
      const hinted = hints(p, faked.font, faked.fakery);
      const ls = p.letterSpacingEm && !JOINING.test(text.slice(a, b)) ? f32(f32(p.letterSpacingEm * size) * scaleX) : 0;
      const n = hb.shape(font, a - ctxStart, b - a, rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR, p.language, features);
      const w = hb.words(), info = hb.infos(), pos = hb.positions();
      for (let i = 0; i < n; i++) {
        const glyph = w[info + i * 5], cluster = w[info + i * 5 + 2], o = pos + i * 5;
        if (ls && (i === 0 || w[info + (i - 1) * 5 + 2] !== cluster)) x = f32(x + ls / 2);
        ids.push(glyph); fonts.push(faked);
        xs.push(x + w[o + 2] * sx); ys.push(-w[o + 3] * s);
        const nominal = hb.advance(font, glyph);
        x = f32(x + f32((hinted ? Math.round(nominal * sx) : nominal * sx) + (w[o] - nominal) * sx));
        if (ls && (i === n - 1 || w[info + (i + 1) * 5 + 2] !== cluster)) x = f32(x + ls / 2);
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
// ── Font's glyph queries
/** Font_getGlyphBounds: SkFont::getWidths of one glyph at the paint's size, scale and skew. The
 *  bounds are the transformed outline's control box rounded out to pixels, as FreeType's are for an
 *  unhinted glyph (the device's hinted outlines can differ by a pixel at small sizes); a glyph
 *  without an outline (a color or bitmap glyph) has its font's extents. */
export function glyphBounds(font: NativeFont, glyph: number, p: ShapePaint, rect: { left: number; top: number; right: number; bottom: number } | null): number | Promise<number> {
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

// ── natives
const layoutOf = (h: bigint) => deref<Layout>(h);
const paintOf = (h: bigint) => deref<ShapePaint>(h);
/** TextShaper.cpp's shapeTextRun: FORCE_RTL or FORCE_LTR over the paint's typeface */
const shapeNative = (text: string, start: number, count: number, ctxStart: number, ctxCount: number, rtl: number, paint: bigint) =>
  after(shapeTextRun(text, start, count, ctxStart, ctxCount, !!rtl, paintOf(paint)), handle);
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
