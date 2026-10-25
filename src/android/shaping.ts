// minikin's glyph-level layout over HarfBuzz and the page's font files: TextRunShaper and
// PositionedGlyphs, Font's glyph bounds, and the glyph runs Canvas.drawGlyphs draws. It follows
// minikin at android-15.0.0_r1 as the reference device shows it (values recorded in fwtest):
//   - the run is split into LayoutSplitter pieces (a word, or one space), each piece into font
//     runs over the typeface's families, each font run shaped on its own, in visual order;
//   - a glyph's advance is Skia's: whole pixels while hinting applies (no linear metrics, no skew),
//     and HarfBuzz's kerning on top unrounded;
//   - letter spacing adds half before and half after each cluster, except in joining scripts.
// Script runs within a font run are left to HarfBuzz's guess of the run's script.

import { rt } from "../jvm/runtime.ts";
import { charsToString } from "../jvm/abi.ts";
import { after } from "../jvm/natives/jentry.ts";
import { isLead, isTrail } from "../jvm/natives/jstring.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { type NativeFont, type NativeFamily, type NativeTypeface, FakedFont, resolveDefault, FAKE_BOLD, FAKE_ITALIC, WGHT, ITAL, fontOf, wrapFont, withFonts } from "./fonts.ts";
import { cssFace } from "./cssfonts.ts";
import { type NativePaint, paintAt, setFontMetrics } from "./paint.ts";
import { type HarfBuzz, type Font, harfBuzz, loadedHarfBuzz, HB_DIRECTION_INVALID, HB_DIRECTION_LTR, HB_DIRECTION_RTL } from "./harfbuzz.ts";
import type { Outline } from "./canvas.ts";
import { END_REPLACE_WITH_HYPHEN, startHyphenString, endHyphenString } from "./hyphenator.ts";
import type { NativePath } from "./path.ts";
import { emptyBox, setEdges, type Box } from "./graphics.ts";
import { variedAdvances } from "./sfnt.ts";
import { perf } from "../perf.ts";

export const f32 = Math.fround;
export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** the directional formatting characters, which have no advance of their own */
export const isBidiControl = (c: number) => c === 0x200e || c === 0x200f || c >= 0x202a && c <= 0x202e || c >= 0x2066 && c <= 0x2069;
/** `f` over the tab's HarfBuzz, again once any font it reached has loaded */
const shaped = <T>(f: (hb: HarfBuzz) => T): T | Promise<T> => after(harfBuzz(), (hb) => withFonts(() => f(hb)));

const breakAfter = (c: number) => c === 0x20 || c >= 0x2000 && c <= 0x200a || c === 0x3000 || isBidiControl(c);
const breakBefore = (c: number) => breakAfter(c) || c >= 0x3400 && c <= 0x9fff;
/** LayoutUtils' getNextWordBreakForCache: where the layout piece holding text[at] ends, by `end` */
export function pieceEnd(text: string, at: number, end: number): number {
  if (breakAfter(text.charCodeAt(at))) return at + 1;
  for (let i = at + 1; i < end; i++) if (breakBefore(text.charCodeAt(i))) return i;
  return end;
}
/** getPrevWordBreakForCache: where the layout piece holding text[at] starts, from `start` */
function pieceStart(text: string, start: number, at: number): number {
  for (let i = at; i > start; i--) if (breakBefore(text.charCodeAt(i)) || breakAfter(text.charCodeAt(i - 1))) return i;
  return start;
}
/** scripts whose letters join, which minikin does not letter-space */
export const JOINING = /[\p{sc=Arab}\p{sc=Nkoo}\p{sc=Phlp}\p{sc=Mand}\p{sc=Mong}\p{sc=Phag}\p{sc=Deva}\p{sc=Beng}\p{sc=Guru}\p{sc=Modi}\p{sc=Shrd}\p{sc=Sylo}\p{sc=Tirh}\p{sc=Ogam}]/u;
/** the HarfBuzz features a paint shapes with: optional ligatures are off under letter spacing, as
 *  CSS asks */
const featuresOf = (p: NativePaint): string | null => Math.abs(p.letterSpacingEm) > 0.03
  ? "liga=0,clig=0" + (p.fontFeatureSettings ? "," + p.fontFeatureSettings : "") : p.fontFeatureSettings;

const fontCache = new WeakMap<NativeFont, Map<number, Font>>();
/** the HarfBuzz font drawing `f` at a weight and italic (-1 for its own): its own axes, then those */
function hbFont(hb: HarfBuzz, f: NativeFont, weight = -1, italic = -1): Font {
  let byStyle = fontCache.get(f);
  if (!byStyle) fontCache.set(f, byStyle = new Map());
  const key = weight * 4 + italic + 1;
  let font = byStyle.get(key);
  if (!font) {
    const axes: [number, number][] = f.axes.map((a) => [a.tag, a.value]);
    if (weight >= 0) axes.push([WGHT, weight]);
    if (italic >= 0) axes.push([ITAL, italic]);
    byStyle.set(key, font = hb.font(hb.face(f.bytes, f.ttcIndex), axes));
    if (!ftAdvances.has(font)) ftAdvances.set(font, axes.length ? variedAdvances(f.bytes, f.ttcIndex, axes) : null);
  }
  return font;
}
/** Skia's advances of a varied font come from FreeType, which varies them in other arithmetic than
 *  HarfBuzz's (sfnt.ts' variedAdvances): by font, in HarfBuzz's units */
const ftAdvances = new WeakMap<Font, ((glyph: number) => number) | null>();
/** a glyph's advance as Skia has it, in the font's HarfBuzz units: `hbAdvance` unless FreeType varies it */
const skiaAdvance = (font: Font, glyph: number, hbAdvance: number) => {
  const varied = ftAdvances.get(font);
  return varied ? varied(glyph) * (font.units / font.face.upem) : hbAdvance;
};

/** whether Skia hints a paint's glyphs: hinting on, without LINEAR_TEXT, and not skewed
 *  (SUBPIXEL_TEXT does not change advances) */
const paintHinted = (p: NativePaint) => p.hinting !== 0 && !p.linearText && p.textSkewX === 0;
/** FreeType's hinted advance: the scaled advance in 26.6 rounded to whole pixels (the device's
 *  wght-900 l at 20 px, 351.75/64, is 352/64 and then 6) */
const hintedAdvance = (px: number) => Math.floor((Math.round(px * 64) + 32) / 64);
/** whether a hinted paint's glyphs in `font` are hinted, so their advances are whole pixels: an
 *  outline font not faking italic (a skew) */
const hints = (paintHinted: boolean, font: NativeFont, fakery = 0) => paintHinted && !(fakery & FAKE_ITALIC) && font.scalable;

// ── itemization: FontCollection::itemize
const isEmojiFamily = (f: NativeFamily) => /(^|[ ,-])Zsye\b/.test(f.langTags);
const isVS = (c: number) => c >= 0xfe00 && c <= 0xfe0f || c >= 0xe0100 && c <= 0xe01ef;
/** characters shaped with whatever font is current (joiners, selectors, bidi and tag controls) */
const noFontNeeded = (c: number) => c === 0x200c || c === 0x200d || isVS(c) || isBidiControl(c) || c >= 0xe0020 && c <= 0xe007f;
/** characters that stay in the current font when it has them */
const STICKY = new Set([0x21, 0x2c, 0x2d, 0x2e, 0x3a, 0x3b, 0x3f, 0xa0, 0x2010, 0x2011, 0x202f, 0x2640, 0x2642, 0x2695]);
const COMBINING = /\p{M}/u, EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const sticks = (c: number, prev: number) => STICKY.has(c) || c >= 0x1f3fb && c <= 0x1f3ff || c === 0x20e3
  || prev === 0x200d || COMBINING.test(String.fromCodePoint(c));

/** whether the family maps `c`, and the sequence of `c` and `vs` (cmap format 14, which needs the font) */
const covers = (hb: HarfBuzz, family: NativeFamily, c: number, vs = 0): boolean =>
  family.covers(c) && (!vs || hb.glyph(hbFont(hb, family.closest(400, false)), c, vs) !== 0);
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

// ── drawing through the page's text engine
const cssFonts = new WeakMap<NativeTypeface, Map<string, string>>();
/** the CSS font Canvas2D draws `text` in under `p`: the faces minikin itemizes it into, in their
 *  families' order (the browser takes each character from the first face that has it), at the
 *  typeface's style; a fake-bold paint asks for bold */
export function cssFont(text: string, p: NativePaint): string {
  const t = resolveDefault(p.tf), families = t.collection.families, used = new Set<NativeFamily>();
  const runs = itemize(loadedHarfBuzz(), families, text, 0, text.length, p.language);
  for (let i = 1; i < runs.length; i += 2) used.add(runs[i] as NativeFamily);
  const order = [...used].map((f) => families.indexOf(f)).sort((a, b) => a - b);
  const weight = p.fakeBold ? Math.max(700, t.weight) : t.weight, key = `${weight} ${p.textSize} ${order}`;
  let byKey = cssFonts.get(t);
  if (!byKey) cssFonts.set(t, byKey = new Map());
  let css = byKey.get(key);
  if (!css) {
    const faces = order.map((i) => `"${cssFace(families[i].match(t.weight, t.italic))}"`);
    byKey.set(key, css = `${t.italic ? "italic " : ""}${weight} ${p.textSize}px ${faces.join(", ") || "sans-serif"}`);
  }
  return css;
}

// ── layout
/** minikin's Layout as TextShaper's LayoutWrapper holds it: glyphs in visual order */
export class Layout {
  readonly ids: Uint32Array; readonly x: Float32Array; readonly y: Float32Array; readonly fonts: readonly FakedFont[]; readonly advance: number; readonly ascent: number; readonly descent: number;
  constructor(ids: Uint32Array, x: Float32Array, y: Float32Array, fonts: readonly FakedFont[],
    advance: number, ascent: number, descent: number) { this.ids = ids; this.x = x; this.y = y; this.fonts = fonts; this.advance = advance; this.ascent = ascent; this.descent = descent; }
}
/** glyph ids of color fonts, by the text they were shaped from: a color glyph has no outline to
 *  draw, so drawGlyphs draws its text in the font instead */
const colorText = new WeakMap<Font, Map<number, string>>();

/** Layout for text[start, start + count) in one direction, context around it (TextShaper's
 *  shapeTextRun) */
export function shapeTextRun(text: string, start: number, count: number, ctxStart: number, ctxCount: number, rtl: boolean, p: NativePaint): Layout | Promise<Layout> {
  return shaped(() => layout(text, start, start + count, ctxStart, ctxStart + ctxCount, rtl, p));
}
/** Layout::doLayoutRun: each LayoutSplitter piece in its context, the paint's hyphen edits on the
 *  first and last, appended in visual order at the advance so far (appendLayout) */
function layout(text: string, start: number, end: number, ctxStart: number, ctxEnd: number, rtl: boolean, p: NativePaint): Layout {
  const style = shapeStyle(p), direction = rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR, pieces: Piece[] = [];
  for (let i = start; i < end;) {
    const ce = pieceEnd(text, i, ctxEnd), e = Math.min(ce, end);
    pieces.push(pieceOf(style, text, i, e, i === start ? p.startHyphenEdit : 0, e === end ? p.endHyphenEdit : 0, i === start ? pieceStart(text, ctxStart, i) : i, ce, direction));
    i = e;
  }
  if (rtl) pieces.reverse();
  const ids: number[] = [], xs: number[] = [], ys: number[] = [], fonts: FakedFont[] = [];
  let origin = 0, ascent = 0, descent = 0;
  for (const piece of pieces) {
    for (let i = 0; i < piece.ids.length; i++) { ids.push(piece.ids[i]); xs.push(f32(origin + piece.x[i])); ys.push(piece.y[i]); fonts.push(piece.fonts[i]); }
    origin = f32(origin + piece.advance); ascent = Math.min(ascent, piece.ascent); descent = Math.max(descent, piece.descent);
  }
  return new Layout(Uint32Array.from(ids), Float32Array.from(xs), Float32Array.from(ys), fonts, origin, ascent, descent);
}
// minikin runs HarfBuzz at 256 units per pixel over Skia's advances: Skia's advance (whole pixels
// while hinting) is truncated to that grid, and HarfBuzz rounds its own adjustments (kerning, mark
// offsets) onto it.
const grid = (px: number) => Math.floor(px * 256 + 0.5) / 256;
/** what text is laid out under: a paint's typeface, size, scale, hinting, features, language and
 *  spacing (letter spacing in pixels, in float as minikin has it); `key` is what a piece's shape
 *  depends on besides its typeface */
export interface ShapeStyle { tf: NativeTypeface; size: number; scaleX: number; hinted: boolean; features: string | null; lang: string; letterSpacing: number; wordSpacing: number; key: string }
export function shapeStyle(p: NativePaint): ShapeStyle {
  const size = layoutSize(p), scaleX = p.textScaleX, hinted = paintHinted(p), features = featuresOf(p), letterSpacing = f32(f32(p.letterSpacingEm * size) * scaleX);
  return { tf: resolveDefault(p.tf), size, scaleX, hinted, features, lang: p.language, letterSpacing, wordSpacing: p.wordSpacing,
    key: `${size} ${scaleX} ${+hinted} ${p.language} ${features} ${letterSpacing}` };
}
/** the size minikin lays text out at: whole pixels unless the paint asks for linear metrics
 *  (MinikinUtils::prepareMinikinPaint); glyphs still draw at the paint's size */
const layoutSize = (p: NativePaint) => p.linearText ? p.textSize : Math.trunc(p.textSize);
/** a font run as HarfBuzz shaped it: its font as the family matches the style, pixels per unit
 *  (`sx` horizontally), whether its advances are hinted, and the glyph count */
interface ShapedRun { faked: FakedFont; font: Font; s: number; sx: number; hinted: boolean; n: number }
/** the run [offset, offset + count) of the text set by setText, shaped in its family's match for
 *  the style, `extent` widened to its font's when it drew glyphs */
function shapeRun(hb: HarfBuzz, family: NativeFamily, style: ShapeStyle, offset: number, count: number, direction: number, extent: { ascent: number; descent: number }): ShapedRun {
  const faked = family.match(style.tf.weight, style.tf.italic), font = hbFont(hb, faked.font, faked.weight, faked.italic), s = style.size / font.units;
  const n = hb.shape(font, offset, count, direction, style.lang, style.features), m = n && faked.font.faceMetrics;
  if (m) { extent.ascent = Math.min(extent.ascent, f32(-m.ascent * style.size)); extent.descent = Math.max(extent.descent, f32(m.descent * style.size)); }
  return { faked, font, s, sx: s * style.scaleX, hinted: hints(style.hinted, faked.font, faked.fakery), n };
}
/** a shaped glyph's advance in pixels: Skia's advance and HarfBuzz's kerning, as minikin has them;
 *  one HarfBuzz zeroed (a mark, a default ignorable) stays zero */
function advanceOf(hb: HarfBuzz, run: ShapedRun, glyph: number, advance: number): number {
  if (advance === 0) return 0;
  const hbAdvance = hb.advance(run.font, glyph), nominal = skiaAdvance(run.font, glyph, hbAdvance) * run.sx;
  const skia = run.hinted ? hintedAdvance(nominal) : Math.trunc(nominal * 256) / 256;
  return f32(skia + grid((advance - hbAdvance) * run.sx));
}
// Pieces repeat (they are words), so they are cached by typeface and style, capped and cleared
// wholesale rather than evicted per entry.
const PIECES_MAX = 20000;
let pieces = new WeakMap<NativeTypeface, Map<string, Map<string, Piece>>>(), pieceCount = 0;
/** the code units of the blocks of right-to-left scripts: outside them HarfBuzz guesses a run with no direction LTR, so a piece laid out LTR is the
 *  piece measured */
const RTL_BLOCKS = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\ud802\ud803\ud83a\ud83b]/;
/** whether `s` can be drawn a cluster at a time: left to right throughout (no right-to-left script nor bidi control), in no
 *  script whose letters join across clusters */
export const clusterwise = (s: string): boolean => !RTL_BLOCKS.test(s) && !/[\u200f\u202a-\u202e\u2066-\u2069]/.test(s) && !JOINING.test(s);
/** LayoutCache::getOrCreate: the piece text[start, end) with hyphen edits at its ends, in its context
 *  text[ctxStart, ctxEnd), in `direction` (HarfBuzz's guess from its script when invalid) */
export function pieceOf(style: ShapeStyle, text: string, start: number, end: number, startEdit = 0, endEdit = 0, ctxStart = start, ctxEnd = end,
  direction = HB_DIRECTION_INVALID): Piece {
  let byTf = pieces.get(style.tf);
  if (!byTf) pieces.set(style.tf, byTf = new Map());
  let byStyle = byTf.get(style.key);
  if (!byStyle) byTf.set(style.key, byStyle = new Map());
  const s = text.slice(ctxStart, ctxEnd);
  if (direction === HB_DIRECTION_LTR && !RTL_BLOCKS.test(s)) direction = HB_DIRECTION_INVALID;
  const key = direction || startEdit || endEdit || ctxStart < start || ctxEnd > end ? `${direction} ${startEdit} ${endEdit} ${start - ctxStart} ${end - ctxStart}\0${s}` : s;
  let out = byStyle.get(key);
  if (out) return out;
  perf.measureTextMiss++;
  out = shapePiece(style, text, start, end, ctxStart, ctxEnd, direction, startEdit, endEdit);
  if (++pieceCount > PIECES_MAX) { pieces = new WeakMap([[style.tf, byTf = new Map([[style.key, byStyle = new Map()]])]]); pieceCount = 1; }
  byStyle.set(key, out);
  return out;
}
/** minikin's LayoutPiece: a piece's glyphs in visual order from its origin, each cluster's advance
 *  on its first code unit, and the extent of the fonts it used */
export interface Piece {
  readonly ids: Uint32Array; readonly x: Float32Array; readonly y: Float32Array; readonly fonts: readonly FakedFont[];
  readonly advance: number; readonly advances: Float32Array; readonly ascent: number; readonly descent: number;
}
/** control characters other than tab shape to nothing, and a tab is not letter-spaced (as the
 *  device measures them) */
const TAB = 9, shapesToNothing = (c: number) => c <= 8 || c >= 0x0a && c <= 0x1f || c >= 0x7f && c <= 0x9f;
/** the piece shaped in its context or, with hyphen edits, alone with its hyphens in its edge font
 *  runs (addToHbBuffer): a start hyphen in the first character's cluster, an inserted end hyphen
 *  in the last one's, a replacing one in the character it replaces. Letter spacing adds half before
 *  and half after each cluster with an advance, in float as minikin adds it, except in joining
 *  scripts. */
function shapePiece(style: ShapeStyle, text: string, start: number, end: number, ctxStart: number, ctxEnd: number, direction: number, startEdit: number, endEdit: number): Piece {
  const hb = loadedHarfBuzz(), count = end - start, bodyEnd = endEdit === END_REPLACE_WITH_HYPHEN ? end - 1 : end, body = bodyEnd - start;
  const runs = fontRuns(hb, style, text, start, bodyEnd), last = runs.length - 3;
  const pre = hyphenIn(runs[1] as NativeFamily, startHyphenString(startEdit), style), post = hyphenIn(runs[last + 1] as NativeFamily, endHyphenString(endEdit), style);
  // HarfBuzz's text from `from`, and where text[start] is in it
  const edited = !!(pre || post), hbText = edited ? pre + text.slice(start, bodyEnd) + post : text, from = edited ? 0 : ctxStart, base = edited ? pre.length : start - ctxStart;
  hb.setText(hbText, from, edited ? hbText.length : ctxEnd);
  const advances = new Float32Array(count), ids: number[] = [], xs: number[] = [], ys: number[] = [], fonts: FakedFont[] = [], extent = { ascent: 0, descent: 0 };
  let x = 0;
  for (let k = 0; k <= last; k += 2) {
    const r = direction === HB_DIRECTION_RTL ? last - k : k, a = runs[r] as number, b = runs[r + 2] as number;
    const lo = r ? a - start + base : base - pre.length, hi = r === last ? base + body + post.length : b - start + base;
    const run = shapeRun(hb, runs[r + 1] as NativeFamily, style, lo, hi - lo, direction, extent), n = run.n, g0 = ids.length;
    const w = hb.words(), info = hb.infos(), pos = hb.positions(), clusters = new Int32Array(n), widths = new Float64Array(n);
    const texts = run.font.face.color ? colorText.get(run.font) ?? colorText.set(run.font, new Map()).get(run.font)! : null;
    let lastCluster = 0;
    for (let i = 0; i < n; i++) { const c = w[info + i * 5 + 2] - base; if (c < body) lastCluster = Math.max(lastCluster, c); }
    for (let i = 0; i < n; i++) {
      const hc = w[info + i * 5 + 2] - base, c = hc < 0 ? 0 : hc < body || hc >= count ? Math.min(hc, lastCluster) : hc, glyph = w[info + i * 5], o = pos + i * 5;
      const width = shapesToNothing(text.charCodeAt(start + c)) ? 0 : advanceOf(hb, run, glyph, w[o]);
      clusters[i] = c; widths[i] = width; advances[c] += width;
      ids.push(glyph); fonts.push(run.faked); xs.push(grid(w[o + 2] * run.sx)); ys.push(-grid(w[o + 3] * run.s));
      if (texts && !texts.has(glyph)) texts.set(glyph, clusterText(hbText, from, w, info, i, n, hi));
    }
    // the clusters again, in order: each cluster's advance, letter-spaced when it has one
    const half = style.letterSpacing && !JOINING.test(text.slice(a, b)) ? style.letterSpacing / 2 : 0;
    let spaced = false;
    for (let i = 0; i < n; i++) {
      const c = clusters[i];
      if (i === 0 || clusters[i - 1] !== c) {
        spaced = half !== 0 && advances[c] !== 0 && text.charCodeAt(start + c) !== TAB;
        advances[c] = 0;
        if (spaced) { x = f32(x + half); advances[c] = half; }
      }
      xs[g0 + i] = f32(x + xs[g0 + i]);
      x = f32(x + widths[i]); advances[c] += widths[i];
      if (spaced && (i === n - 1 || clusters[i + 1] !== c)) { x = f32(x + half); advances[c] += half; }
    }
  }
  return { ids: Uint32Array.from(ids), x: Float32Array.from(xs), y: Float32Array.from(ys), fonts, advance: x, advances, ...extent };
}
/** text[start, end) as font runs; a piece left empty by its replaced character is a run of the hyphen's family */
function fontRuns(hb: HarfBuzz, style: ShapeStyle, text: string, start: number, end: number): (number | NativeFamily)[] {
  const families = style.tf.collection.families;
  return end > start ? itemize(hb, families, text, start, end, style.lang) : [start, familyFor(hb, families, 0x2010, 0, style.lang), start];
}
/** determineHyphenChar for each of `chars` in the font `family` matches the style to: a hyphen it
 *  lacks falls back to U+2010, and U+2010 to U+002D */
function hyphenIn(family: NativeFamily, chars: string, style: ShapeStyle): string {
  if (!chars) return chars;
  const font = family.match(style.tf.weight, style.tf.italic).font;
  return chars.replace(/[֊־᐀‐]/g, (h) => font.covers(h.charCodeAt(0)) ? h : font.covers(0x2010) ? "‐" : "-");
}
/** text as a run drawn with the paint's hyphen edits shows it, each hyphen its edge piece's */
export function hyphenEdited(text: string, p: NativePaint): string {
  const style = shapeStyle(p), hb = loadedHarfBuzz(), end = p.endHyphenEdit === END_REPLACE_WITH_HYPHEN ? text.length - 1 : text.length;
  const first = fontRuns(hb, style, text, 0, Math.min(pieceEnd(text, 0, text.length), end)), last = fontRuns(hb, style, text, pieceStart(text, 0, text.length - 1), end);
  return hyphenIn(first[1] as NativeFamily, startHyphenString(p.startHyphenEdit), style) + text.slice(0, end)
    + hyphenIn(last[last.length - 2] as NativeFamily, endHyphenString(p.endHyphenEdit), style);
}
/** the text of glyph i's cluster, in the text HarfBuzz shaped from `from`: from its cluster to the
 *  next cluster in logical order, or the run's end */
function clusterText(text: string, from: number, w: Int32Array, info: number, i: number, n: number, end: number): string {
  const c = w[info + i * 5 + 2];
  let e = end;
  for (let j = 0; j < n; j++) { const d = w[info + j * 5 + 2]; if (d > c && d < e) e = d; }
  return text.slice(from + c, from + e);
}

// ── Font's glyph queries
/** a glyph's bounds as SkFont::getBounds has them: its outline's control box at the paint's size,
 *  scale and skew (plus a fake italic's), or for a glyph without one (a color or bitmap glyph) its
 *  extents; null when it has neither */
function glyphBox(hb: HarfBuzz, f: Font, glyph: number, p: NativePaint, size: number, fakery = 0): [number, number, number, number] | null {
  const s = size / f.units, sx = s * p.textScaleX;
  const box = hb.controlBox(f, glyph, sx, -(p.textSkewX - (fakery & FAKE_ITALIC ? 0.25 : 0)) * s, -s);
  if (box) return box;
  const e = hb.extents(f, glyph);
  return e && [e[0] * sx, -e[3] * s, e[2] * sx, -e[1] * s];
}
/** Font_getGlyphBounds: SkFont::getWidths of one glyph at the paint's size, scale and skew. The
 *  bounds are rounded out to pixels, as FreeType's are for an unhinted glyph (the device's hinted
 *  outlines can differ by a pixel at small sizes). */
function glyphBounds(font: NativeFont, glyph: number, p: NativePaint): [advance: number, bounds: Box] | Promise<[number, Box]> {
  return shaped((hb) => {
    const f = hbFont(hb, font), box = glyphBox(hb, f, glyph, p, p.textSize);
    const advance = skiaAdvance(f, glyph, hb.advance(f, glyph)) * (p.textSize / f.units) * p.textScaleX;
    return [f32(hints(paintHinted(p), font) ? hintedAdvance(advance) : advance),
      box ? { left: Math.floor(box[0]), top: Math.floor(box[1]), right: Math.ceil(box[2]), bottom: Math.ceil(box[3]) } : emptyBox];
  });
}
/** Layout::getBounds: the union of the laid-out glyphs' bounds at their positions, null for none */
export function layoutBounds(text: string, rtl: boolean, p: NativePaint): [number, number, number, number] | null | Promise<[number, number, number, number] | null> {
  return shaped((hb) => {
    const l = layout(text, 0, text.length, 0, text.length, rtl, p);
    let out: [number, number, number, number] | null = null;
    for (let i = 0; i < l.ids.length; i++) {
      const faked = l.fonts[i], b = glyphBox(hb, hbFont(hb, faked.font, faked.weight, faked.italic), l.ids[i], p, layoutSize(p), faked.fakery);
      if (!b) continue;
      const x = l.x[i], y = l.y[i];
      if (!out) out = [b[0] + x, b[1] + y, b[2] + x, b[3] + y];
      else { out[0] = Math.min(out[0], b[0] + x); out[1] = Math.min(out[1], b[1] + y); out[2] = Math.max(out[2], b[2] + x); out[3] = Math.max(out[3], b[3] + y); }
    }
    return out;
  });
}

// ── Paint.hasGlyph and Paint.getTextPath
/** android_graphics_Paint's hasGlyph: well-formed UTF-16 whose variation sequences a family supports,
 *  laid out without .notdef and, for more than one character, as one glyph (a ligature) */
export function hasGlyph(text: string, rtl: boolean, p: NativePaint): boolean | Promise<boolean> {
  return shaped((hb) => {
    const families = resolveDefault(p.tf).collection.families;
    let chars = 0, prev = -1;
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (isLead(c) || isTrail(c)) {
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
    const ids = layout(text, 0, text.length, 0, text.length, rtl, p).ids;
    return (ids.length === 1 || chars <= 1) && ids.length > 0 && ids.every((g) => g !== 0);
  });
}
/** an outline sink placing font units under (x, y) -> (a x + c y + e, d y + f) into a path */
class PathSink {
  readonly path: NativePath;
  a = 1; c = 0; d = 1; e = 0; f = 0;
  constructor(path: NativePath) { this.path = path; }
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
  return shaped((hb) => {
    const sink = new PathSink(dst);
    for (let i = 0; i < l.ids.length; i++) {
      const faked = l.fonts[i], f = hbFont(hb, faked.font, faked.weight, faked.italic), s = p.textSize / f.units;
      sink.a = s * p.textScaleX; sink.c = -(p.textSkewX - (faked.fakery & FAKE_ITALIC ? 0.25 : 0)) * s; sink.d = -s;
      sink.e = x + l.x[i]; sink.f = y + l.y[i];
      hb.draw(f, l.ids[i], sink);
    }
  });
}

// ── Canvas.drawGlyphs
let glyphMatrix: DOMMatrix | null = null;
/** Canvas::drawGlyphs: `count` glyphs of the Java Font `fontHandle` at their positions, drawn at the
 *  paint's size, scale and skew. `draw` draws the run with the paint as the canvas draws any shape.
 *  The glyphs are copied first: the arrays are the native's, which a wait for the font must not hold. */
export function drawGlyphs(draw: (run: Outline) => void, ids: Int32Array, idOffset: number,
  positions: Float32Array, positionOffset: number, count: number, fontHandle: bigint, p: NativePaint): void | Promise<void> {
  if (count <= 0) return;
  const font = fontOf(fontHandle), glyphs = ids.slice(idOffset, idOffset + count), at = positions.slice(positionOffset, positionOffset + count * 2);
  return shaped((hb) => {
    const f = hbFont(hb, font), s = p.textSize / f.units, texts = colorText.get(f), path = new Path2D();
    const m = glyphMatrix ??= new DOMMatrix();
    m.a = s * p.textScaleX; m.b = 0; m.c = -p.textSkewX * s; m.d = -s;
    let color: [string, number, number][] | null = null;
    for (let i = 0; i < count; i++) {
      const glyph = glyphs[i], x = at[i * 2], y = at[i * 2 + 1];
      const text = f.face.color ? texts?.get(glyph) : undefined;
      if (text) { (color ??= []).push([text, x, y]); continue; }
      const outline = hb.outline(f, glyph);
      if (!outline) continue;
      m.e = x; m.f = y;
      path.addPath(outline, m);
    }
    // colour glyphs have no outlines: they draw the text they were shaped from in the font
    const css = color && `${p.textSize}px "${cssFace(new FakedFont(font, 0, -1, -1))}"`;
    draw({
      fill(c) {
        c.fill(path);
        if (color) for (const [text, x, y] of color) {
          c.save();
          c.transform(p.textScaleX, 0, p.textSkewX, 1, x, y);
          c.font = css!; c.textAlign = "left"; c.textBaseline = "alphabetic";
          c.fillText(text, 0, 0);
          c.restore();
        }
      },
      stroke: (c) => c.stroke(path),
      clips: !color,
      clip: (c) => c.clip(path),
    });
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
// the Font natives that measure at a paint's size; fonts.ts registers the rest
rt.registerJnis("android/graphics/fonts/Font", {
  // SkFont::getMetrics over this face
  "nGetFontMetrics(JJLandroid/graphics/Paint$FontMetrics;)F": (h: bigint, p: bigint, fm: object | null) => {
    const m = fontOf(h).faceMetrics!, size = paintAt(p).textSize;
    const ascent = f32(-m.ascent * size), descent = f32(m.descent * size), leading = f32(m.leading * size);
    if (fm) setFontMetrics(fm, false, f32(-m.top * size), ascent, descent, f32(m.bottom * size), leading);
    return f32(descent - ascent + leading);
  },
  "nGetGlyphBounds(JIJLandroid/graphics/RectF;)F": (h: bigint, glyph: number, p: bigint, rect: object | null) =>
    after(glyphBounds(fontOf(h), glyph, paintAt(p)), ([advance, box]) => { if (rect) setEdges(rect, box); return advance; }),
});
