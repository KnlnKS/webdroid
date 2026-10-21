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
import type { Ctx2D } from "./recording.ts";
import { END_REPLACE_WITH_HYPHEN, startHyphenString, endHyphenString } from "./hyphenator.ts";
import type { NativePath } from "./path.ts";
import { emptyBox, setEdges, type Box } from "./graphics.ts";
import { variedAdvances } from "./sfnt.ts";

export const f32 = Math.fround;
export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** the directional formatting characters, which have no advance of their own */
export const isBidiControl = (c: number) => c === 0x200e || c === 0x200f || c >= 0x202a && c <= 0x202e || c >= 0x2066 && c <= 0x2069;
/** `f` over the tab's HarfBuzz, again once any font it reached has loaded */
const shaped = <T>(f: (hb: HarfBuzz) => T): T | Promise<T> => after(harfBuzz(), (hb) => withFonts(() => f(hb)));

const breakAfter = (c: number) => c === 0x20 || c >= 0x2000 && c <= 0x200a || c === 0x3000 || isBidiControl(c);
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
  return shaped((hb) => layout(hb, text, start, start + count, ctxStart, ctxStart + ctxCount, rtl, p));
}
function layout(hb: HarfBuzz, text: string, start: number, end: number, ctxStart: number, ctxEnd: number, rtl: boolean, p: NativePaint): Layout {
  // the paint's hyphen edits at the run's ends (MinikinUtils::doLayout), each hyphen in the cluster
  // of the character it stands by
  let first = -1, last = Infinity;
  if (p.startHyphenEdit || p.endHyphenEdit) {
    const [pre, body, post] = hyphenParts(text.slice(start, end), p);
    text = pre + body + post; start = ctxStart = 0; end = ctxEnd = text.length;
    if (body) { first = pre.length; last = pre.length + body.length - 1; }
  }
  const clusterAt = (w: Int32Array, info: number, i: number) => Math.min(last, Math.max(first, w[info + i * 5 + 2]));
  const style = shapeStyle(p), families = style.tf.collection.families, extent = { ascent: 0, descent: 0 };
  const ids: number[] = [], xs: number[] = [], ys: number[] = [], fonts: FakedFont[] = [];
  const pieces: number[] = [];
  for (let i = start; i < end;) { const e = Math.min(pieceEnd(text, i, end), end); pieces.push(i, e); i = e; }
  hb.setText(text, ctxStart, ctxEnd);
  // each piece laid out from 0 and appended at the advance so far (Layout::appendLayout)
  let origin = 0, x = 0;
  for (let k = 0; k < pieces.length; k += 2, origin = f32(origin + x), x = 0) {
    const piece = rtl ? pieces.length - 2 - k : k;
    const runs = itemize(hb, families, text, pieces[piece], pieces[piece + 1], style.lang);
    const nRuns = (runs.length - 1) / 2;
    for (let r = 0; r < nRuns; r++) {
      const at = (rtl ? nRuns - 1 - r : r) * 2, a = runs[at] as number, b = runs[at + 2] as number;
      const run = shapeRun(hb, runs[at + 1] as NativeFamily, style, a - ctxStart, b - a, rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR, extent);
      const { font, n, s, sx } = run;
      const ls = p.letterSpacingEm && !JOINING.test(text.slice(a, b)) ? f32(f32(p.letterSpacingEm * style.size) * style.scaleX) : 0;
      const w = hb.words(), info = hb.infos(), pos = hb.positions();
      const texts = font.face.color ? colorText.get(font) ?? colorText.set(font, new Map()).get(font)! : null;
      for (let i = 0; i < n; i++) {
        const glyph = w[info + i * 5], cluster = clusterAt(w, info, i), o = pos + i * 5;
        if (ls && (i === 0 || clusterAt(w, info, i - 1) !== cluster)) x = f32(x + ls / 2);
        ids.push(glyph); fonts.push(run.faked);
        xs.push(f32(origin + f32(x + grid(w[o + 2] * sx)))); ys.push(-grid(w[o + 3] * s));
        x = f32(x + advanceOf(hb, run, glyph, w[o]));
        if (ls && (i === n - 1 || clusterAt(w, info, i + 1) !== cluster)) x = f32(x + ls / 2);
        if (texts && !texts.has(glyph)) texts.set(glyph, clusterText(text, ctxStart, w, info, i, n, b));
      }
    }
  }
  return new Layout(Uint32Array.from(ids), Float32Array.from(xs), Float32Array.from(ys), fonts, origin, extent.ascent, extent.descent);
}
// minikin runs HarfBuzz at 256 units per pixel over Skia's advances: Skia's advance (whole pixels
// while hinting) is truncated to that grid, and HarfBuzz rounds its own adjustments (kerning, mark
// offsets) onto it.
const grid = (px: number) => Math.floor(px * 256 + 0.5) / 256;
/** what text is shaped under: a paint's typeface, size, scale, hinting, features and language */
export interface ShapeStyle { tf: NativeTypeface; size: number; scaleX: number; hinted: boolean; features: string | null; lang: string }
export const shapeStyle = (p: NativePaint): ShapeStyle =>
  ({ tf: resolveDefault(p.tf), size: layoutSize(p), scaleX: p.textScaleX, hinted: paintHinted(p), features: featuresOf(p), lang: p.language });
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
/** one LayoutSplitter piece as minikin measures it: each glyph's advance on its cluster's first
 *  code unit (Layout::doLayoutRun, before letter spacing), and the extent of the fonts it used */
export interface Piece { advances: Float32Array; ascent: number; descent: number }
/** a piece laid out in the direction HarfBuzz guesses from its script, with hyphen edits at its
 *  start and end (addToHbBuffer): the hyphens are shaped in the edge font runs, their advances on
 *  the first character and on the last one's cluster, a replaced last character dropped */
export function measurePiece(piece: string, style: ShapeStyle, startEdit = 0, endEdit = 0): Piece {
  const hb = loadedHarfBuzz(), advances = new Float32Array(piece.length), extent = { ascent: 0, descent: 0 };
  const body = endEdit === END_REPLACE_WITH_HYPHEN ? piece.slice(0, -1) : piece, families = style.tf.collection.families;
  const runs = body ? itemize(hb, families, body, 0, body.length, style.lang) : [0, familyFor(hb, families, 0x2010, 0, style.lang), 0];
  const pre = hyphenIn(runs[1] as NativeFamily, startHyphenString(startEdit), style), post = hyphenIn(runs[runs.length - 2] as NativeFamily, endHyphenString(endEdit), style);
  const text = pre + body + post, last = runs.length - 3;
  hb.setText(text, 0, text.length);
  for (let r = 0; r <= last; r += 2) {
    const a = r ? (runs[r] as number) + pre.length : 0, b = r === last ? text.length : (runs[r + 2] as number) + pre.length;
    const run = shapeRun(hb, runs[r + 1] as NativeFamily, style, a, b - a, HB_DIRECTION_INVALID, extent);
    const w = hb.words(), info = hb.infos(), pos = hb.positions();
    let lastCluster = 0;
    for (let i = 0; i < run.n; i++) { const c = w[info + i * 5 + 2] - pre.length; if (c < body.length) lastCluster = Math.max(lastCluster, c); }
    for (let i = 0; i < run.n; i++) {
      const c = w[info + i * 5 + 2] - pre.length;
      advances[c < 0 ? 0 : c < body.length || c >= piece.length ? Math.min(c, lastCluster) : c] += advanceOf(hb, run, w[info + i * 5], w[pos + i * 5]);
    }
  }
  return { advances, ...extent };
}
/** determineHyphenChar for each of `chars` in the font `family` matches the style to: a hyphen it
 *  lacks falls back to U+2010, and U+2010 to U+002D */
function hyphenIn(family: NativeFamily, chars: string, style: ShapeStyle): string {
  if (!chars) return chars;
  const font = family.match(style.tf.weight, style.tf.italic).font;
  return chars.replace(/[֊־᐀‐]/g, (h) => font.covers(h.charCodeAt(0)) ? h : font.covers(0x2010) ? "‐" : "-");
}
/** text as a run drawn with the paint's hyphen edits shows it */
export const hyphenEdited = (text: string, p: NativePaint): string => hyphenParts(text, p).join("");
/** the hyphen before, the text kept and the hyphen after */
function hyphenParts(text: string, p: NativePaint): [string, string, string] {
  const style = shapeStyle(p), families = style.tf.collection.families, hb = loadedHarfBuzz();
  const body = p.endHyphenEdit === END_REPLACE_WITH_HYPHEN ? text.slice(0, -1) : text;
  const edge = (at: number) => at >= 0 ? familyFor(hb, families, body.codePointAt(at)!, 0, style.lang) : families[0];
  const last = body.length - (isTrail(body.charCodeAt(body.length - 1)) && body.length > 1 ? 2 : 1);
  return [hyphenIn(edge(body ? 0 : -1), startHyphenString(p.startHyphenEdit), style), body, hyphenIn(edge(last), endHyphenString(p.endHyphenEdit), style)];
}
/** the text of glyph i's cluster: from its cluster to the next cluster in logical order */
function clusterText(text: string, ctxStart: number, w: Int32Array, info: number, i: number, n: number, runEnd: number): string {
  const c = w[info + i * 5 + 2];
  let e = runEnd - ctxStart;
  for (let j = 0; j < n; j++) { const d = w[info + j * 5 + 2]; if (d > c && d < e) e = d; }
  return text.slice(ctxStart + c, ctxStart + e);
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
    const l = layout(hb, text, 0, text.length, 0, text.length, rtl, p);
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
    const ids = layout(hb, text, 0, text.length, 0, text.length, rtl, p).ids;
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
 *  paint's size, scale and skew. `draw` fills or strokes with the paint as the canvas draws any
 *  shape; outlines become one Path2D, and color glyphs (which have none) draw the text they were
 *  shaped from in the font. The glyphs are copied first: the arrays are the native's, which a wait
 *  for the font must not hold. */
export function drawGlyphs(draw: (fill: (c: Ctx2D) => void, stroke: (c: Ctx2D) => void) => void, ids: Int32Array, idOffset: number,
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
    const css = color && `${p.textSize}px "${cssFace(new FakedFont(font, 0, -1, -1))}"`;
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
