// minikin, the text layout library under android.graphics.text and Paint's text measurement,
// over shaping.ts' HarfBuzz layout. Each part follows minikin's own code (frameworks/minikin at
// android-15.0.0_r1, with the reference build's text flags: letter_spacing_justification,
// phrase_strict_fallback and word_style_auto on):
//   - advances come per LayoutSplitter piece (a word and its trailing space), each cluster's advance
//     on its first code unit and 0 on the rest, as HarfBuzz reports them;
//   - line break opportunities are ICU's line iterator (ICU4J over the reference ICU data, where
//     the device runs ICU4C over the same data) with WordBreaker's rules on top;
//   - GreedyLineBreaker and OptimalLineBreaker are ported as they are;
//   - hyphenation points are hyphenator.ts' over the reference build's patterns, measured with
//     their hyphens as MeasuredText and the greedy breaker measure them.
// Glyph bounds are not known, so no run overhangs.

import { awaited, rt, driven, waits, type Gen } from "../jvm/runtime.ts";
import { charsToString } from "../jvm/abi.ts";
import { scall, vcall, after } from "../jvm/natives/jentry.ts";
import { isLead, isTrail } from "../jvm/natives/jstring.ts";
import { handle, deref, release, FINALIZER } from "./handles.ts";
import { perf } from "../perf.ts";
import { type NativePaint, paintAt, fontTop, fontBottom, setFontMetrics } from "./paint.ts";
import { withFonts } from "./fonts.ts";
import {
  type Hyphenator, hyphenatorFor, hyphenate, intProperty, isLineBreakingHyphen, editForThisLine, editForNextLine, packHyphenEdit, startHyphenString,
  endHyphenString, DONT_BREAK, BREAK_AND_DONT_INSERT_HYPHEN, START_NO_EDIT, END_NO_EDIT,
} from "./hyphenator.ts";
import { type ShapeStyle, pieceOf, shapeStyle, pieceEnd, JOINING, f32, graphemes, isBidiControl } from "./shaping.ts";
import { setEdges } from "./graphics.ts";

// ── advances ─────────────────────────────────────────────────────────────────────────────
/** MinikinUtils::measureText: the advances of text[start,end) into out[at...], and their sum, each
 *  piece's as shaping.ts lays it out (in the direction HarfBuzz guesses), with word spacing added
 *  to every space (isWordSpace: U+0020 and U+00A0). `extents` takes each character's piece's
 *  ascent and descent, two values a character, from `at`. Hyphen edits apply to the first and last
 *  piece. A style is taken when a run is added: the paint changes after. */
export function advances(style: ShapeStyle, text: string, start: number, end: number, out: Float32Array | null = null, at = 0,
  extents: Float32Array | null = null, startEdit = 0, endEdit = 0): number {
  let total = 0;
  for (let i = start; i < end;) {
    const e = Math.min(pieceEnd(text, i, end), end), p = pieceOf(style, text, i, e, i === start ? startEdit : 0, e === end ? endEdit : 0), w = p.advances;
    if (extents) for (let k = (at + i - start) * 2; k < (at + e - start) * 2; k += 2) { extents[k] = p.ascent; extents[k + 1] = p.descent; }
    for (let j = 0; j < w.length; j++) {
      const c = text.charCodeAt(i + j);
      const a = style.wordSpacing && (c === 0x20 || c === 0xa0) ? f32(w[j] + style.wordSpacing) : w[j];
      if (out) out[at + i - start + j] = a;
      total = f32(total + a);
    }
    i = e;
  }
  return total;
}
/** the advance of `text` under `p`: what Paint.measureText answers and hwui draws the run across */
export function paintAdvance(p: NativePaint, text: string): number {
  perf.measureText++;
  return advances(shapeStyle(p), text, 0, text.length, null, 0, null, p.startHyphenEdit, p.endHyphenEdit);
}

// ── grapheme breaks ───────────────────────────────────────────────────────────────────────
// GraphemeBreak::isGraphemeBreak is UAX #29 with minikin's tailorings; the browser's segmenter
// answers UAX #29, and the tailorings that matter here are applied around it.
/** controls minikin treats as Extend, so no break comes before them */
const extendsCluster = (c: number) => c === 0xad || c === 0x61c || c === 0x180e || c === 0x200b || c === 0x200e || c === 0x200f
  || c >= 0x202a && c <= 0x202e || (c | 0xf) === 0x206f || c === 0xfeff;
function isGraphemeBreak(adv: Float32Array | null, text: string, start: number, count: number, offset: number): boolean {
  if (offset <= start || offset >= start + count) return true;
  const c = text.charCodeAt(offset), prev = text.charCodeAt(offset - 1);
  if (isTrail(c)) return !isLead(prev);
  if (prev === 13 && c === 10) return false;
  if (prev < 0x20 || prev === 0x7f) return true;
  if (adv && adv[offset - start] !== 0) return true;
  if (extendsCluster(c)) return true;
  const from = Math.max(start, offset - 32);
  for (const g of graphemes.segment(text.slice(from, Math.min(start + count, offset + 32)))) {
    if (g.index + from === offset) return true;
    if (g.index + from > offset) break;
  }
  return false;
}

// ── line break opportunities ──────────────────────────────────────────────────────────────
/** ICU's line boundaries of a paragraph (every boundary after 0, ending with its length) for a
 *  locale tag. Iterators are pooled per tag, taken while in use as minikin's pool does, since a
 *  call into ICU4J can suspend. Paragraphs are measured again at other widths, so results are
 *  cached, cleared wholesale when full. */
const idleIterators = new Map<string, unknown[]>();
let boundaryCache = new Map<string, Int32Array>();
const lineBoundaries = driven(function* lineBoundaries(text: string, tag: string): Gen<Int32Array> {
  const key = tag + "\0" + text, hit = boundaryCache.get(key);
  if (hit) return hit;
  let it = idleIterators.get(tag)?.pop();
  if (!it) {
    const locale = yield scall("android/icu/util/ULocale", "forLanguageTag", "(Ljava/lang/String;)Landroid/icu/util/ULocale;", tag);
    it = yield scall("android/icu/text/BreakIterator", "getLineInstance", "(Landroid/icu/util/ULocale;)Landroid/icu/text/BreakIterator;", locale);
  }
  const out: number[] = [];
  try {
    yield vcall(it, "setText", "(Ljava/lang/String;)V", text);
    // vcall, not the facade's method: next() can wait (a dictionary of a script's break engine pages in)
    for (let b: number; (b = yield vcall(it, "next", "()I")) !== -1;) out.push(b);
  } finally {
    let idle = idleIterators.get(tag);
    if (!idle) idleIterators.set(tag, idle = []);
    idle.push(it);
  }
  if (boundaryCache.size > 512) boundaryCache = new Map();
  const bounds = Int32Array.from(out);
  boundaryCache.set(key, bounds);
  return bounds;
});

const LB_NONE = 0, LB_NO_BREAK = 4, LB_AUTO = 5, LW_NONE = 0, LW_PHRASE = 1, LW_AUTO = 2;
/** Locale::getStringWithLineBreakOption, after ICULineBreakerPool resolves an automatic style */
function breakLocaleTag(lang: string, lbStyle: number, lbWordStyle: number): string {
  if (lbStyle === LB_AUTO) lbStyle = /^ja\b/.test(lang) ? 3 : LB_NONE;
  const ext = [];
  if (lbStyle >= 1 && lbStyle <= 3) ext.push("lb-" + ["loose", "normal", "strict"][lbStyle - 1]);
  if (lbWordStyle === LW_PHRASE) ext.push("lw-phrase");
  return ext.length ? `${lang}-u-${ext.join("-")}` : lang;
}
/** resolveWordStyleAuto: [the word style, whether a phrase-based retry may be tried] */
function resolveWordStyle(style: number, lang: string, forcePhrase: boolean): [number, boolean] {
  if (style !== LW_AUTO) return [style, false];
  if (forcePhrase || /^ko\b/.test(lang)) return [LW_PHRASE, false];
  return [LW_NONE, /^ja\b/.test(lang)];
}
/** WordBreakerTransitionTracker: a run whose locale or styles differ from the last one's restarts
 *  the word breaker on its own boundaries. `plain` are the boundaries without a phrase-based word
 *  style, which phrase_strict_fallback breaks at before breaking inside a word. */
class Tracker {
  private readonly text: string; private readonly forcePhrase: boolean;
  private run: Run | null = null;
  retry = false;
  plain: Int32Array | null = null;
  constructor(text: string, forcePhrase: boolean) { this.text = text; this.forcePhrase = forcePhrase; }
  /** the breaker's next boundary after the run's start, or -1 when the run continues the last one's */
  *update(wb: WordBreaker, run: Run): Gen<number> {
    const last = this.run;
    if (last && last.lang === run.lang && last.lbStyle === run.lbStyle && last.lbWordStyle === run.lbWordStyle) return -1;
    this.run = run;
    const [wordStyle, retry] = resolveWordStyle(run.lbWordStyle, run.lang, this.forcePhrase);
    this.retry = retry;
    this.plain = run.lbWordStyle === LW_NONE ? null : yield* this.bounds(run, LW_NONE);
    return wb.followingWithLocale(yield* this.bounds(run, wordStyle), run.start);
  }
  private *bounds(run: Run, wordStyle: number): Gen<Int32Array> {
    if (run.lbStyle === LB_NO_BREAK) return Int32Array.of(this.text.length);
    const b = lineBoundaries(this.text, breakLocaleTag(run.lang, run.lbStyle, wordStyle));
    return b instanceof Promise ? yield* awaited(b) : b;
  }
}

const EMOJI = /\p{Emoji}/u, EMOJI_MODIFIER = /\p{Emoji_Modifier}/u, EMOJI_BASE = /\p{Emoji_Modifier_Base}/u;
const cpBefore = (s: string, i: number) => { const c = s.charCodeAt(i - 1); return isTrail(c) && i > 1 && isLead(s.charCodeAt(i - 2)) ? s.codePointAt(i - 2)! : c; };
const isChar = (re: RegExp, cp: number) => re.test(String.fromCodePoint(cp));

/** WordBreaker: ICU's boundaries, filtered as minikin filters them, and URLs and email addresses
 *  broken by the Chicago Manual of Style's rules */
class WordBreaker {
  private readonly text: string;
  private bounds: Int32Array = new Int32Array(0);
  private last = 0; private current = 0; private scanOffset = 0; private inEmailOrUrl = false;
  constructor(text: string) { this.text = text; }
  /** the first boundary after i, or -1 (ICU's DONE) */
  private following(i: number): number {
    const b = this.bounds;
    let lo = 0, hi = b.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (b[mid] <= i) lo = mid + 1; else hi = mid; }
    return lo < b.length ? b[lo] : -1;
  }
  private isBoundary(i: number): boolean { return i === 0 || this.following(i - 1) === i; }
  followingWithLocale(bounds: Int32Array, from: number): number {
    this.bounds = bounds;
    if (!this.inEmailOrUrl) { this.current = this.last = this.scanOffset = from; this.next(); }
    return this.current;
  }
  private isValidBreak(i: number): boolean {
    const text = this.text;
    if (i === -1 || i === text.length) return true;
    let before = cpBefore(text, i);
    if (isLineBreakingHyphen(before) || before === 0xad || before === 0x1039) return false;
    const after = text.codePointAt(i)!;
    if (before === 0x200d && isChar(EMOJI, after)) return false;
    if (isChar(EMOJI_MODIFIER, after)) {
      const at = i - (before > 0xffff ? 2 : 1);
      if (before === 0xfe0f && at > 0) before = cpBefore(text, at);
      if (isChar(EMOJI_BASE, before)) return false;
    }
    return true;
  }
  private detectEmailOrUrl(): void {
    if (this.last < this.scanOffset) return;
    const text = this.text;
    let state = 0, i = this.last;           // START, SAW_AT, SAW_COLON, SAW_COLON_SLASH, SAW_COLON_SLASH_SLASH
    for (; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (!(c > 0x20 && c <= 0x7e)) break;
      if (state === 0 && c === 0x40) state = 1;
      else if (state === 0 && c === 0x3a) state = 2;
      else if (state === 2 || state === 3) state = c === 0x2f ? state + 1 : 0;
    }
    this.inEmailOrUrl = state === 1 || state === 4;
    if (this.inEmailOrUrl && !this.isBoundary(i)) i = this.following(i);
    this.scanOffset = i;
  }
  private nextInEmailOrUrl(): number {
    const text = this.text;
    let lastChar = text.charCodeAt(this.last), i = this.last + 1;
    for (; i < this.scanOffset; i++) {
      if (lastChar === 0x3a || lastChar === 0x3d || lastChar === 0x26) break;
      if (lastChar === 0x2f && i >= this.last + 2 && text.charCodeAt(i - 2) === 0x2f) break;
      const c = text.charCodeAt(i);
      if (lastChar !== 0x2d) {
        if ("~.,-_?#%=&".includes(text[i])) break;
        if (c === 0x2f && lastChar !== 0x2f && !(i + 1 < this.scanOffset && text.charCodeAt(i + 1) === 0x2f)) break;
      }
      lastChar = c;
    }
    return i;
  }
  next(): number {
    this.last = this.current;
    this.detectEmailOrUrl();
    if (this.inEmailOrUrl) return this.current = this.nextInEmailOrUrl();
    let r = this.following(this.current);
    while (!this.isValidBreak(r)) r = this.following(r);
    return this.current = r;
  }
  breakBadness(): number { return this.inEmailOrUrl && this.current < this.scanOffset ? 1 : 0; }
  /** wordRange: the current word less leading opening punctuation and quotes (line break classes
   *  OP and QU) and trailing spaces, punctuation and controls; empty in an email address or URL */
  *wordRange(): Gen<[number, number]> {
    if (this.inEmailOrUrl) return [this.last, this.last];
    const text = this.text;
    let start = this.last, end = this.current;
    while (start < this.current) {
      const c = text.codePointAt(start)!;
      if (!PUNCT_OR_SYMBOL.test(String.fromCodePoint(c))) break;
      const lb = yield* awaited(intProperty(c, LINE_BREAK));
      if (lb !== LB_OPEN_PUNCTUATION && lb !== LB_QUOTATION) break;
      start += c > 0xffff ? 2 : 1;
    }
    while (end > this.last) {
      const c = cpBefore(text, end);
      if (!WORD_END_STRIPPED.test(String.fromCodePoint(c))) break;
      end -= c > 0xffff ? 2 : 1;
    }
    return start < end ? [start, end] : [end, end];
  }
}
// ICU's UProperty.LINE_BREAK and the classes wordStart strips, which only punctuation and symbols have
const LINE_BREAK = 0x1008, LB_OPEN_PUNCTUATION = 20, LB_QUOTATION = 23;
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u, WORD_END_STRIPPED = /[\p{Zs}\p{P}\p{Cc}]/u;

// ── MeasuredText ──────────────────────────────────────────────────────────────────────────
/** a style run has a style; a replacement run (a ReplacementSpan) has only its width */
export interface Run { start: number; end: number; style: ShapeStyle | null; width: number; lang: string; lbStyle: number; lbWordStyle: number; hyphenate: boolean }
/** HyphenBreak: a hyphenation point, and the widths of the word's pieces before it (with the
 *  hyphen) and after it */
interface HyphenBreak { offset: number; type: number; first: number; second: number }
/** a paragraph's measurement: each character's advance, its piece's ascent and descent, and the
 *  hyphenation points when they were asked for */
interface Measured { text: string; runs: Run[]; widths: Float32Array; extents: Float32Array; hyphenBreaks: HyphenBreak[] }
const measured = (h: bigint) => deref<Measured>(h);

/** MeasuredText::getExtent: the extent of the pieces over [start,end) of ascent, descent pairs */
function extent(extents: Float32Array, start: number, end: number): [number, number] {
  let ascent = 0, descent = 0;
  for (let i = start * 2; i < end * 2; i += 2) { ascent = Math.min(ascent, extents[i]); descent = Math.max(descent, extents[i + 1]); }
  return [ascent, descent];
}
/** advances [start,end) summed in float, as minikin sums them */
function sum(advances: Float32Array, start = 0, end = advances.length): number {
  let w = 0;
  for (let i = start; i < end; i++) w = f32(w + advances[i]);
  return w;
}

rt.registerJnis("android/graphics/text/MeasuredText$Builder", {
  "nInitBuilder()J": () => handle([] as Run[]),
  "nFreeBuilder(J)V": release,
  "nAddStyleRun(JJIIZIIZ)V": (h: bigint, p: bigint, lbStyle: number, lbWordStyle: number, canHyphenate: number, start: number, end: number) => {
    const paint = paintAt(p);
    deref<Run[]>(h).push({ start, end, style: shapeStyle(paint), width: 0, lang: paint.language, lbStyle, lbWordStyle, hyphenate: !!canHyphenate });
  },
  "nAddReplacementRun(JJIIF)V": (h: bigint, p: bigint, start: number, end: number, width: number) => {
    deref<Run[]>(h).push({ start, end, style: null, width, lang: paintAt(p).language, lbStyle: LB_NONE, lbWordStyle: LW_NONE, hyphenate: false });
  },
  "nBuildMeasuredText(JJ[CZZZZ)J": (h: bigint, _hint: bigint, chars: Uint16Array, computeHyphenation: number, _layout: number, _bounds: number, fast: number) =>
    buildMeasured(deref<Run[]>(h), charsToString(chars, 0, chars.length), !!computeHyphenation, !!fast),
});
/** MeasuredText::Builder::build over `text`, measured again once a font it reached has loaded */
function buildMeasured(runs: Run[], text: string, computeHyphenation: boolean, fast: boolean): bigint | Promise<bigint> {
  return after(withFonts((): Measured => {
    const widths = new Float32Array(text.length), extents = new Float32Array(text.length * 2);
    for (const r of runs) {
      if (r.style) advances(r.style, text, r.start, r.end, widths, r.start, extents);
      else if (r.end > r.start) widths[r.start] = r.width;
    }
    return { text, runs, widths, extents, hyphenBreaks: [] };
  }), (m) => computeHyphenation ? after(hyphenBreaks(m, fast), () => handle(m)) : handle(m));
}

/** MeasuredText::measure's hyphenation points: each word of a style run hyphenated in its locale,
 *  each point's pieces measured with their hyphens, or under fast hyphenation summed from the
 *  advances with the hyphens measured alone */
const hyphenBreaks = driven(function* hyphenBreaks(m: Measured, fast: boolean): Gen<void> {
  const text = m.text, wb = new WordBreaker(text), tracker = new Tracker(text, false);
  let nextWord = 0, prevWord = 0, hyphenator: Hyphenator | null = null;
  for (const run of m.runs) {
    const style = run.style;
    if (!style) continue;
    const restarted = yield* tracker.update(wb, run);
    if (restarted !== -1) { nextWord = restarted; hyphenator = yield* hyphenatorFor(run.lang); }
    for (let i = run.start; i < run.end; i++) {
      if (i === nextWord) { prevWord = nextWord; nextWord = wb.next(); }
      if (i + 1 !== nextWord) continue;
      const [ws, we] = yield* wb.wordRange();
      if (run.start > prevWord || nextWord > run.end || ws < prevWord || we > nextWord) continue;
      const types = yield* hyphenate(text.slice(ws, we), hyphenator!);
      for (let k = ws; k < we; k++) {
        const type = types[k - ws];
        if (type === DONT_BREAK) continue;
        const end = editForThisLine(type), start = editForNextLine(type);
        const [first, second] = yield* awaited(withFonts(() => fast ? [
          f32(sum(m.widths, prevWord, k) + (end ? measureAlone(style, endHyphenString(end)) : 0)),
          f32(sum(m.widths, k, nextWord) + (start ? measureAlone(style, startHyphenString(start)) : 0)),
        ] : [hyphenPiece(style, text, prevWord, k, START_NO_EDIT, end), hyphenPiece(style, text, k, nextWord, start, END_NO_EDIT)]));
        m.hyphenBreaks.push({ offset: k, type, first, second });
      }
    }
  }
});
/** StyleRun::measureHyphenPiece: text[start,end) measured on its own with hyphen edits at its ends */
const hyphenPiece = (style: ShapeStyle, text: string, start: number, end: number, startEdit: number, endEdit: number) =>
  advances(style, text.slice(start, end), 0, end - start, null, 0, null, startEdit, endEdit);
/** StyleRun::measureText: a hyphen's advance */
const measureAlone = (style: ShapeStyle, s: string) => advances(style, s, 0, s.length);

rt.registerJnis("android/graphics/text/MeasuredText", {
  "nGetReleaseFunc()J": () => FINALIZER,
  "nGetMemoryUsage(J)I": (h: bigint) => measured(h).text.length * 6,
  "nGetWidth(JII)F": (h: bigint, start: number, end: number) => sum(measured(h).widths, start, end),
  "nGetCharWidthAt(JI)F": (h: bigint, i: number) => measured(h).widths[i],
  // glyph bounds are not known: the advance box over the run extents, rounded out
  "nGetBounds(J[CIILandroid/graphics/Rect;)V": (h: bigint, _c: Uint16Array, start: number, end: number, r: object) => {
    const m = measured(h), [ascent, descent] = extent(m.extents, start, end);
    setEdges(r, { left: 0, top: Math.floor(ascent), right: Math.ceil(sum(m.widths, start, end)), bottom: Math.ceil(descent) });
  },
  "nGetExtent(J[CII)J": (h: bigint, _c: Uint16Array, start: number, end: number) => {
    const [ascent, descent] = extent(measured(h).extents, start, end);
    return BigInt.asIntN(64, (BigInt(Math.round(ascent)) << 32n) | BigInt(Math.round(descent) >>> 0));
  },
});

// ── line breaking ─────────────────────────────────────────────────────────────────────────
/** AndroidLineWidth: the first lines' width, then the rest's, less each line's indent */
export class LineWidth {
  private first: number; private firstCount: number; private rest: number; private indents: Float32Array; private offset: number;
  constructor(first: number, firstCount: number, rest: number,
    indents: Float32Array, offset: number) { this.first = first; this.firstCount = firstCount; this.rest = rest; this.indents = indents; this.offset = offset; }
  getAt(line: number): number {
    const width = line < this.firstCount ? this.first : this.rest, n = this.indents.length;
    return Math.max(0, width - (n ? this.indents[Math.min(line + this.offset, n - 1)] : 0));
  }
  getMin(): number {
    let min = Math.min(this.getAt(0), this.getAt(this.firstCount));
    for (let line = 1; line + this.offset < this.indents.length; line++) min = Math.min(min, this.getAt(line));
    return min;
  }
}
export class TabStops {
  private stops: Float32Array | null; private tabWidth: number;
  constructor(stops: Float32Array | null, tabWidth: number) { this.stops = stops; this.tabWidth = tabWidth; }
  nextTab(widthSoFar: number): number {
    if (this.stops) for (const s of this.stops) if (s > widthSoFar) return s;
    return this.tabWidth ? Math.floor(widthSoFar / this.tabWidth + 1) * this.tabWidth : 0;
  }
}
interface BreakResult { breaks: number[]; widths: number[]; ascents: number[]; descents: number[]; flags: number[] }
const TAB = 9, TAB_BIT = 1 << 29, LBW_AUTO_HEURISTICS_LINE_COUNT = 5;
const isLineEndSpace = (c: number) => c === 10 || c === 32 || c === 0x1680 || c >= 0x2000 && c <= 0x200a && c !== 0x2007 || c === 0x205f || c === 0x3000;
function trimTrailing(text: string, start: number, end: number): number {
  while (end > start && isLineEndSpace(text.charCodeAt(end - 1))) end--;
  return end;
}
const letterSpacingOf = (r: Run) => r.style?.letterSpacing ?? 0;
/** a result, and whether minikin would retry the paragraph with phrase-based word breaks */
type Breaking = Gen<[BreakResult, boolean]>;
const NOWHERE = -1;

/** GreedyLineBreaker */
function* breakGreedy(m: Measured, len: number, lineWidth: LineWidth, tabs: TabStops, b: Breaker, forcePhrase: boolean): Breaking {
  const text = m.text, widths = m.widths, points: { offset: number; width: number; edit: number }[] = [];
  const hyphenation = b.frequency !== HYPHENATION_NONE;
  let lineNum = 0, limit = lineWidth.getAt(0), line = 0, sum = 0, startEdit = START_NO_EDIT;
  let prevWord = NOWHERE, lineAtPrevWord = 0, sumAtPrevWord = 0, prevWordInEmailOrUrl = false;
  let lineStartLS = 0, currentLS = 0, hyphenator: Hyphenator | null = null;
  const prevBreak = () => points.length ? points[points.length - 1].offset : 0;
  const breakAt = (offset: number, width: number, nextLine: number, nextSum: number, endEdit = END_NO_EDIT, nextStartEdit = START_NO_EDIT) => {
    points.push({ offset, width: width - (lineStartLS + currentLS) / 2, edit: packHyphenEdit(startEdit, endEdit) });
    limit = lineWidth.getAt(++lineNum); line = nextLine; sum = nextSum; startEdit = nextStartEdit;
    prevWord = NOWHERE; lineAtPrevWord = sumAtPrevWord = 0; prevWordInEmailOrUrl = false;
    lineStartLS = currentLS;
  };
  /** doLineBreakWithGraphemeBounds: true when not even one cluster fits */
  const breakAtGraphemes = (start: number, end: number): boolean => {
    const ls = (lineStartLS + currentLS) * 0.5;
    let width = widths[start];
    for (let i = start + 1; i < end; i++) {
      const w = widths[i];
      if (w === 0) continue;
      if (width + w - ls > limit) { breakAt(i, width, line - width, sum - width); return false; }
      width += w;
    }
    breakAt(end, line, 0, 0);
    return true;
  };
  /** doLineBreakWithFallback: a phrase-based run breaks at its plain line breaks before inside words */
  const breakAtFallback = (start: number, end: number, plain: Int32Array | null): boolean => {
    if (!plain) return false;
    const wb = new WordBreaker(text);
    let next = wb.followingWithLocale(plain, start);
    if (!(next >= start && next < end)) return false;
    let prev = -1, word = 0, before = 0;
    for (let i = start; i < end; i++) {
      const w = widths[i];
      if (w === 0) continue;
      if (i !== next) { word += w; continue; }
      if (before + word > limit) {
        if (prev === -1) return false;
        breakAt(prev, before, line - before, sum - before);
        return true;
      }
      prev = i; next = wb.next(); before += word; word = w;
    }
    if (prev === -1 || before > limit) return false;
    breakAt(prev, before, line - before, sum - before);
    return true;
  };
  /** tryLineBreakWithHyphenation: the word in [start,end) broken at its last hyphenation point
   *  that fits, again for what is left while that is too wide; false when it cannot be hyphenated */
  function* breakAtHyphens(start: number, end: number): Gen<boolean> {
    if (!hyphenation || !hyphenator) return false;
    let target: Run | null = null;
    for (const r of m.runs) if (r.start <= start && end <= r.end) target = r;
    if (!target) return false;
    const [ws, we] = yield* wb.wordRange();
    if (ws < start || we > end || !target.hyphenate) return false;
    const style = target.style!, types = yield* hyphenate(text.slice(ws, we), hyphenator);
    const piece = (a: number, z: number, se: number, ee: number) => awaited(withFonts(() => hyphenPiece(style, text, a, z, se, ee)));
    let from = start, prevOffset = NOWHERE, prevWidth = 0;
    const breakAtPrev = function* (): Gen<void> {
      if (prevOffset === NOWHERE) { breakAtGraphemes(from, end); return; }
      const type = types[prevOffset - ws], nextStart = editForNextLine(type), rest = yield* piece(prevOffset, end, nextStart, END_NO_EDIT);
      breakAt(prevOffset, prevWidth, rest - (sum - line), rest, editForThisLine(type), nextStart);
    };
    for (let i = ws; i < we; i++) {
      const type = types[i - ws] ?? DONT_BREAK;
      if (type === DONT_BREAK) continue;
      const width = yield* piece(from, i, startEdit, editForThisLine(type));
      if (width <= limit) { prevOffset = i; prevWidth = width; continue; }
      yield* breakAtPrev();
      if (line <= limit) return true;
      i = from = prevBreak();
      prevOffset = NOWHERE;
    }
    yield* breakAtPrev();
    return true;
  }

  const wb = new WordBreaker(text), tracker = new Tracker(text, forcePhrase);
  let nextWord = 0;
  for (let r = 0; r < m.runs.length; r++) {
    const run = m.runs[r];
    currentLS = letterSpacingOf(run);
    if (r === 0) lineStartLS = currentLS;
    const restarted = yield* tracker.update(wb, run);
    if (restarted !== -1) { nextWord = restarted; if (hyphenation) hyphenator = yield* hyphenatorFor(run.lang); }
    const canBreak = !!run.style;
    for (let i = run.start; i < Math.min(run.end, len); i++) {
      const c = text.charCodeAt(i);
      if (c === TAB) line = sum = tabs.nextTab(sum);
      else { sum += widths[i]; if (!isLineEndSpace(c)) line = sum; }
      if (i + 1 !== nextWord) continue;
      if (canBreak || nextWord === run.end) processLineBreak: {
        const offset = i + 1;
        while (line - (lineStartLS + currentLS) * 0.5 > limit) {
          if (prevWord !== NOWHERE) { breakAt(prevWord, lineAtPrevWord, line - sumAtPrevWord, sum - sumAtPrevWord); continue; }
          if (canBreak && (yield* breakAtHyphens(prevBreak(), offset))) continue;
          if (breakAtFallback(prevBreak(), offset, tracker.plain)) continue;
          if (breakAtGraphemes(prevBreak(), offset)) break processLineBreak;
        }
        const inEmailOrUrl = wb.breakBadness() !== 0;
        if (prevWord === NOWHERE || prevWordInEmailOrUrl || !inEmailOrUrl) {
          prevWord = offset; lineAtPrevWord = line; sumAtPrevWord = sum; prevWordInEmailOrUrl = inEmailOrUrl;
        }
      }
      nextWord = wb.next();
    }
  }
  if (prevBreak() !== len && prevWord !== NOWHERE) breakAt(prevWord, line, 0, 0);

  const out = emptyResult();
  let from = 0;
  for (const p of points) {
    pushLine(out, m, from, p.offset, p.width, b.useBounds, (text.slice(from, p.offset).includes("\t") ? TAB_BIT : 0) | p.edit);
    from = p.offset;
  }
  return [out, tracker.retry];
}

const SCORE_INFTY = 3.4028234663852886e38, SCORE_OVERFULL = 1e12, SCORE_DESPERATE = 1e10, SCORE_FALLBACK = 1e6;
const LAST_LINE_PENALTY_MULTIPLIER = 4, LINE_PENALTY_MULTIPLIER = 2, SHRINK_PENALTY_MULTIPLIER = 4, SHRINKABILITY = 1 / 3;
const BREAK_STRATEGY_BALANCED = 2, HYPHENATION_NONE = 0, HYPHENATION_NORMAL = 1;
interface Candidate { offset: number; preBreak: number; postBreak: number; penalty: number; preSpaces: number; postSpaces: number; type: number }

/** OptimalLineBreaker (populateCandidates, then LineBreakOptimizer::computeBreaks), in float
 *  arithmetic as minikin's: near-equal scores tie-break as they do there */
const F = f32;
function* breakOptimal(m: Measured, len: number, lineWidth: LineWidth, b: Breaker, forcePhrase: boolean): Breaking {
  const text = m.text, widths = m.widths, minLineWidth = lineWidth.getMin(), candidates: Candidate[] = [];
  const push = (offset: number, preBreak: number, postBreak: number, penalty: number, preSpaces: number, postSpaces: number, ls: number, type = DONT_BREAK) =>
    candidates.push({ offset, preBreak: F(preBreak + ls * 0.5), postBreak: F(postBreak - ls * 0.5), penalty, preSpaces, postSpaces, type });
  push(0, 0, 0, 0, 0, 0, m.runs.length ? letterSpacingOf(m.runs[0]) : 0);
  // CharProcessor's state
  let rawSpaces = 0, effectiveSpaces = 0, sum = 0, effectiveWidth = 0, sumAtPrevWord = 0, nextWord = 0, prevWord = 0;
  let spaceWidth = 0, maxCharWidth = 0, linePenalty = 0, hy = 0;
  const wb = new WordBreaker(text), tracker = new Tracker(text, forcePhrase);
  for (const run of m.runs) {
    const ls = letterSpacingOf(run), style = run.style;
    let hyphenPenalty = 0;
    if (style) {
      // computePenalties: "a heuristic that seems to perform well"
      hyphenPenalty = F(0.5 * style.size * style.scaleX * lineWidth.getAt(0) * (b.frequency === HYPHENATION_NORMAL ? 4 : 1));
      if (b.justified) hyphenPenalty = F(hyphenPenalty * 0.25);
      else linePenalty = Math.max(linePenalty, F(hyphenPenalty * LINE_PENALTY_MULTIPLIER));
    }
    const restarted = yield* tracker.update(wb, run);
    if (restarted !== -1) nextWord = restarted;
    for (let i = run.start; i < Math.min(run.end, len); i++) {
      const c = text.charCodeAt(i), w = widths[i];
      if (i === nextWord) {
        if (style || i + 1 === run.end) { prevWord = nextWord; sumAtPrevWord = sum; }
        nextWord = wb.next();
      }
      if (c === 32) { rawSpaces++; spaceWidth = w; }
      sum = F(sum + w);
      maxCharWidth = Math.max(maxCharWidth, w);
      if (!isLineEndSpace(c)) { effectiveSpaces = rawSpaces; effectiveWidth = sum; }
      if (i + 1 !== nextWord) continue;
      const beginHy = hy;
      while (hy < m.hyphenBreaks.length && m.hyphenBreaks[hy].offset < nextWord) hy++;
      const endHy = b.frequency !== HYPHENATION_NONE && run.hyphenate ? hy : beginHy;
      const desperate: number[] = [];
      if (F(effectiveWidth - sumAtPrevWord) > minLineWidth) {
        // populateDesperatePoints, with phrase_strict_fallback's plain line breaks scored lower
        const start = prevWord, end = nextWord, fb = new WordBreaker(text);
        let fallback = tracker.plain ? fb.followingWithLocale(tracker.plain, start) : NOWHERE;
        const useFallback = fallback >= start && fallback < end;
        let width = widths[start];
        for (let j = start + 1; j < end; j++) {
          const wj = widths[j];
          if (wj === 0) continue;
          const atFallback = useFallback && j === fallback;
          desperate.push(j, width, atFallback ? SCORE_FALLBACK : SCORE_DESPERATE);
          if (atFallback) { fallback = fb.next(); if (!(fallback >= start && fallback < end)) break; }
          width = F(width + wj);
        }
      }
      // appendWithMerging: a desperate break before a hyphenation point at the same offset
      for (let d = 0, k = beginHy; k < endHy || d < desperate.length;) {
        if (d < desperate.length && (k === endHy || desperate[d] <= m.hyphenBreaks[k].offset)) {
          const at = F(sumAtPrevWord + desperate[d + 1]);
          push(desperate[d], at, at, desperate[d + 2], effectiveSpaces, effectiveSpaces, ls, BREAK_AND_DONT_INSERT_HYPHEN);
          d += 3;
        } else {
          const h = m.hyphenBreaks[k++];
          push(h.offset, F(sum - h.second), F(sumAtPrevWord + h.first), hyphenPenalty, effectiveSpaces, effectiveSpaces, ls, h.type);
        }
      }
      // no break between the zero-width characters of a replacement span
      if (style || i + 1 === run.end || widths[i + 1] > 0)
        push(i + 1, sum, effectiveWidth, F(hyphenPenalty * wb.breakBadness()), rawSpaces, effectiveSpaces, ls);
    }
  }

  const n = candidates.length, maxShrink = b.justified ? F(SHRINKABILITY * spaceWidth) : 0;
  const score = new Float32Array(n), prev = new Int32Array(n), lineNo = new Int32Array(n);
  let active = 0;
  for (let i = 1; i < n; i++) {
    const atEnd = i === n - 1;
    let best = SCORE_INFTY, bestPrev = 0, lineNumberLast = lineNo[active], width = lineWidth.getAt(lineNumberLast);
    let leftEdge = F(candidates[i].postBreak - width), bestHope = 0;
    for (let j = active; j < i; j++) {
      const lineNumber = lineNo[j];
      if (lineNumber !== lineNumberLast) {
        const widthNew = lineWidth.getAt(lineNumber);
        if (widthNew !== width) { leftEdge = F(candidates[i].postBreak - width); bestHope = 0; width = widthNew; }
        lineNumberLast = lineNumber;
      }
      const jScore = score[j];
      if (F(jScore + bestHope) >= best) continue;
      const delta = F(candidates[j].preBreak - leftEdge);
      let widthScore = 0, additional = 0;
      if ((atEnd || !b.justified) && delta < 0) widthScore = SCORE_OVERFULL;
      else if (atEnd && b.strategy !== BREAK_STRATEGY_BALANCED) additional = F(LAST_LINE_PENALTY_MULTIPLIER * candidates[j].penalty);
      else {
        widthScore = F(delta * delta);
        if (delta < 0) widthScore = -delta < F(maxShrink * (candidates[i].postSpaces - candidates[j].preSpaces)) ? F(widthScore * SHRINK_PENALTY_MULTIPLIER) : SCORE_OVERFULL;
      }
      if (delta < 0) active = j + 1; else bestHope = widthScore;
      const s = F(F(jScore + widthScore) + additional);
      if (s <= best) { best = s; bestPrev = j; }
    }
    score[i] = F(F(best + candidates[i].penalty) + linePenalty);
    prev[i] = bestPrev; lineNo[i] = lineNo[bestPrev] + 1;
  }
  const lines: number[] = [];
  for (let i = n - 1; i > 0; i = prev[i]) lines.push(i);
  const out = emptyResult();
  for (let k = lines.length - 1; k >= 0; k--) {
    const c = candidates[lines[k]], p = candidates[prev[lines[k]]];
    pushLine(out, m, p.offset, c.offset, F(c.postBreak - p.preBreak), b.useBounds, packHyphenEdit(editForNextLine(p.type), editForThisLine(c.type)));
  }
  return [out, tracker.retry];
}

const emptyResult = (): BreakResult => ({ breaks: [], widths: [], ascents: [], descents: [], flags: [] });
/** a line's extent: with useBoundsForWidth, over its text less trailing spaces when any is left */
function pushLine(out: BreakResult, m: Measured, start: number, end: number, width: number, useBounds: boolean, flags: number): void {
  const trimmed = useBounds ? trimTrailing(m.text, start, end) : end, [ascent, descent] = extent(m.extents, start, trimmed > start ? trimmed : end);
  out.breaks.push(end); out.widths.push(width); out.ascents.push(ascent); out.descents.push(descent); out.flags.push(flags);
}

interface Breaker { strategy: number; frequency: number; justified: boolean; indents: Float32Array; useBounds: boolean }
/** breakIntoLines, with word_style_auto's phrase-based retry for short paragraphs */
export const computeBreaks = driven(function* computeBreaks(b: Breaker, m: Measured, len: number, lineWidth: LineWidth, tabs: TabStops): Gen<BreakResult> {
  if (!len) return emptyResult();
  const greedy = b.strategy === 0 || m.text.slice(0, len).includes("\t");
  const pass = (forcePhrase: boolean) => greedy ? breakGreedy(m, len, lineWidth, tabs, b, forcePhrase) : breakOptimal(m, len, lineWidth, b, forcePhrase);
  const [result, retry] = yield* pass(false);
  if (!retry || result.breaks.length >= LBW_AUTO_HEURISTICS_LINE_COUNT) return result;
  const [phrase] = yield* pass(true);
  return phrase.breaks.length < LBW_AUTO_HEURISTICS_LINE_COUNT ? phrase : result;
});

const result = (h: bigint) => deref<BreakResult>(h);
rt.registerJnis("android/graphics/text/LineBreaker", {
  "nInit(IIZ[IZ)J": (strategy: number, frequency: number, justified: number, indents: Int32Array | null, useBounds: number) =>
    handle({ strategy, frequency, justified: !!justified, indents: indents ? Float32Array.from(indents) : new Float32Array(0), useBounds: !!useBounds } as Breaker),
  "nGetReleaseFunc()J": () => FINALIZER,
  "nGetReleaseResultFunc()J": () => FINALIZER,
  "nComputeLineBreaks(J[CJIFIF[FFI)J": waits((h: bigint, _chars: Uint16Array, mt: bigint, len: number, firstWidth: number, firstCount: number,
    restWidth: number, tabStops: Float32Array | null, defaultTab: number, indentsOffset: number) => {
    const b = deref<Breaker>(h);
    const breaks = computeBreaks(b, measured(mt), len, new LineWidth(firstWidth, firstCount, restWidth, b.indents, indentsOffset), new TabStops(tabStops, defaultTab));
    return breaks instanceof Promise ? breaks.then(handle) : handle(breaks);
  }),
  "nGetLineCount(J)I": (h: bigint) => result(h).breaks.length,
  "nGetLineBreakOffset(JI)I": (h: bigint, i: number) => result(h).breaks[i],
  "nGetLineWidth(JI)F": (h: bigint, i: number) => result(h).widths[i],
  "nGetLineAscent(JI)F": (h: bigint, i: number) => result(h).ascents[i],
  "nGetLineDescent(JI)F": (h: bigint, i: number) => result(h).descents[i],
  "nGetLineFlag(JI)I": (h: bigint, i: number) => result(h).flags[i],
});

rt.registerJnis("android/graphics/text/GraphemeBreak", {
  // hwui passes `end` where isGraphemeBreak takes a count
  "nIsGraphemeBreak([F[CII[Z)V": (adv: Float32Array, chars: Uint16Array, start: number, end: number, out: Int8Array) => {
    if (start > end || adv.length < end || out.length < end - start) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
    const text = charsToString(chars, 0, chars.length);
    for (let i = 0; i < end - start; i++) out[i] = +isGraphemeBreak(adv, text, start, end, start + i);
  },
});

// ── Paint's text measurement (hwui's Paint.cpp over MinikinUtils::measureText) ─────────────
const isControl = (c: number) => c <= 0x1f || c === 0x61c || isBidiControl(c);
const LEFT_EDGE = 0x2000, RIGHT_EDGE = 0x4000;
/** the advances of text[start, start+count), indexed from start. A run TextLine marks as a line's
 *  edge loses half its letter spacing there (Layout::measureText's adjustAdvanceLetterSpacingEdge). */
function measure(h: bigint, text: string, start: number, count: number): Float32Array {
  const p = paintAt(h), style = shapeStyle(p), out = new Float32Array(count);
  advances(style, text, start, start + count, out, 0, null, p.startHyphenEdit, p.endHyphenEdit);
  const half = f32(style.letterSpacing * 0.5), edge = (i: number) => {
    const cp = text.codePointAt(start + i)!;
    if (out[i] === 0 || cp < 0x20 || cp >= 0x7f && cp <= 0x9f) return false;
    if (!JOINING.test(String.fromCodePoint(cp))) out[i] = f32(out[i] - half);
    return true;
  };
  if (half && p.flags & LEFT_EDGE) for (let i = 0; i < count && !edge(i); i++);
  if (half && p.flags & RIGHT_EDGE) for (let i = count - 1; i >= 0 && !edge(i); i--);
  return out;
}
/** minikin's getRunAdvance: the advance up to `offset`, sharing a ligature's width among its graphemes */
function runAdvance(adv: Float32Array, text: string, start: number, count: number, offset: number, from = start): number {
  let advance = 0, lastCluster = from, clusterWidth = 0;
  for (let i = from; i < offset; i++) {
    const a = adv[i - start];
    if (a !== 0) { advance += a; lastCluster = i; clusterWidth = a; }
  }
  if (offset < from + count && !isControl(text.charCodeAt(offset)) && adv[offset - start] === 0) {
    let next = offset + 1;
    while (next < from + count && adv[next - start] === 0 && !isControl(text.charCodeAt(next))) next++;
    let clusters = 0, after = 0;
    for (let i = lastCluster; i < next; i++) {
      if (!isGraphemeBreak(adv.subarray(from - start), text, from, count, i)) continue;
      clusters++;
      if (i >= offset) after++;
    }
    if (clusters) advance -= clusterWidth * after / clusters;
  }
  return advance;
}
/** distributeAdvances: a ligature's width shared among the graphemes it covers */
function distribute(adv: Float32Array, text: string, start: number, count: number): void {
  for (let clusterStart = start; clusterStart < start + count;) {
    let clusterEnd = clusterStart + 1;
    while (clusterEnd < start + count && adv[clusterEnd - start] === 0 && !isControl(text.charCodeAt(clusterEnd))) clusterEnd++;
    let n = 0;
    for (let i = clusterStart; i < clusterEnd; i++) if (isGraphemeBreak(adv, text, start, count, i)) n++;
    if (n > 1) {
      const share = adv[clusterStart - start] / n;
      for (let i = clusterStart; i < clusterEnd; i++) if (isGraphemeBreak(adv, text, start, count, i)) adv[i - start] = share;
    }
    clusterStart = clusterEnd;
  }
}
function offsetForAdvance(adv: Float32Array, text: string, start: number, count: number, advance: number): number {
  let x = 0, xLastClusterStart = 0, xSearchStart = 0, lastClusterStart = start, searchStart = start;
  const max = start + count;
  for (let i = start; i < max; i++) {
    if (isGraphemeBreak(adv, text, start, count, i)) { searchStart = lastClusterStart; xSearchStart = xLastClusterStart; }
    const w = adv[i - start];
    if (w !== 0) { lastClusterStart = i; xLastClusterStart = x; x += w; if (x > advance) break; }
  }
  let best = searchStart, bestDist = Infinity;
  for (let i = searchStart; i <= max; i++) {
    if (!isGraphemeBreak(adv, text, start, count, i)) continue;
    const delta = runAdvance(adv, text, start, max - searchStart, i, searchStart) + xSearchStart - advance;
    if (Math.abs(delta) < bestDist) { bestDist = Math.abs(delta); best = i; }
    if (delta >= 0) break;
  }
  return best;
}
// Each measures again once a font it reached has loaded. The natives read their char arrays into
// strings first; those that answer advances in an array are declared to wait.
/** GraphemeBreak::getTextRunCursor, Paint.CURSOR_AFTER through CURSOR_AT */
const textRunCursor = (h: bigint, text: string, start: number, count: number, offset: number, opt: number) => withFonts(() => {
  const adv = measure(h, text, start, count), br = (i: number) => isGraphemeBreak(adv, text, start, count, i);
  switch (opt) {
    case 0: if (offset < start + count) offset++; // fall through
    case 1: while (!br(offset)) offset++; return offset;
    case 2: if (offset > start) offset--; // fall through
    case 3: while (!br(offset)) offset--; return offset;
    default: return br(offset) ? offset : -1;
  }
});
/** how many characters fit in maxWidth, scanning forwards or back, and how wide they are */
const breakText = (h: bigint, text: string, forwards: boolean, maxWidth: number, measured: Float32Array | null) => withFonts(() => {
  const adv = measure(h, text, 0, text.length);
  let width = 0, fit = 0;
  for (let i = 0; i < text.length; i++) {
    const w = adv[forwards ? i : text.length - i - 1];
    if (width + w > maxWidth) break;
    if (forwards || w !== 0) fit = i + 1;
    width += w;
  }
  if (measured?.length) measured[0] = width;
  return fit;
});
/** doRunAdvance: the advance to `offset` of text[start, start+count) in its context `text`, with each
 *  character's into out[at...] */
const runAdvanceOf = (h: bigint, text: string, start: number, count: number, offset: number, out: Float32Array | null, at: number) => withFonts(() => {
  const adv = measure(h, text, start, count);
  if (offset === start + count && !out) return sum(adv);
  const result = runAdvance(adv, text, start, count, offset);
  if (out) { distribute(adv, text, start, count); out.set(adv, at); }
  return result;
});
const offsetFor = (h: bigint, text: string, start: number, count: number, advance: number) =>
  withFonts(() => offsetForAdvance(measure(h, text, start, count), text, start, count, advance));
/** getFontMetricsIntForText: the paint's metrics with the ascent and descent of the fonts the text
 *  uses, its top and bottom widened to them */
const metricsForText = (h: bigint, text: string, start: number, count: number, fm: object) => withFonts(() => {
  const p = paintAt(h), extents = new Float32Array(count * 2);
  advances(shapeStyle(p), text, start, start + count, null, 0, extents);
  const [ascent, descent] = extent(extents, 0, count);
  setFontMetrics(fm, true, Math.floor(Math.min(ascent, fontTop(p))), Math.round(ascent), Math.round(descent), Math.ceil(Math.max(descent, fontBottom(p))), 0);
});
const textAdvances = (h: bigint, text: string, start: number, count: number, out: Float32Array | null, at: number) => withFonts(() => {
  if (!count) return 0;
  const adv = measure(h, text, start, count);
  if (out) out.set(adv, at);
  return sum(adv);
});
rt.registerJnis("android/graphics/Paint", {
  "nGetFontMetricsIntForText(J[CIIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, c: Uint16Array, start: number, count: number, _cs: number, _cc: number, _rtl: number, fm: object) =>
    metricsForText(h, charsToString(c, 0, c.length), start, count, fm),
  "nGetFontMetricsIntForText(JLjava/lang/String;IIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, s: string, start: number, count: number, _cs: number, _cc: number, _rtl: number, fm: object) =>
    metricsForText(h, s, start, count, fm),
  "nGetTextAdvances(J[CIIIII[FI)F": waits((h: bigint, c: Uint16Array, index: number, count: number, cs: number, cc: number, _bidi: number, out: Float32Array | null, at: number) =>
    textAdvances(h, charsToString(c, cs, cc), index - cs, count, out, at)),
  "nGetTextAdvances(JLjava/lang/String;IIIII[FI)F": waits((h: bigint, s: string, start: number, end: number, cs: number, ce: number, _bidi: number, out: Float32Array | null, at: number) =>
    textAdvances(h, s.slice(cs, ce), start - cs, end - start, out, at)),
  "nGetRunAdvance(J[CIIIIZI)F": (h: bigint, c: Uint16Array, start: number, end: number, cs: number, ce: number, _rtl: number, offset: number) =>
    runAdvanceOf(h, charsToString(c, cs, ce - cs), start - cs, end - start, offset - cs, null, 0),
  "nGetRunCharacterAdvance(J[CIIIIZI[FILandroid/graphics/RectF;)F": waits((h: bigint, c: Uint16Array, start: number, end: number, cs: number, ce: number, _rtl: number, offset: number, out: Float32Array | null, at: number) =>
    runAdvanceOf(h, charsToString(c, cs, ce - cs), start - cs, end - start, offset - cs, out, at)),
  "nGetRunCharacterAdvance(J[CIIIIZI[FILandroid/graphics/RectF;Landroid/graphics/Paint$RunInfo;)F": waits((h: bigint, c: Uint16Array, start: number, end: number, cs: number, ce: number, _rtl: number, offset: number, out: Float32Array | null, at: number) =>
    runAdvanceOf(h, charsToString(c, cs, ce - cs), start - cs, end - start, offset - cs, out, at)),
  "nGetOffsetForAdvance(J[CIIIIZF)I": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, ce: number, _rtl: number, advance: number) =>
    offsetFor(h, charsToString(c, 0, ce), start, end - start, advance),
  "nGetTextRunCursor(J[CIIIII)I": (h: bigint, c: Uint16Array, cs: number, count: number, _dir: number, offset: number, opt: number) =>
    textRunCursor(h, charsToString(c, 0, cs + count), cs, count, offset, opt),
  "nGetTextRunCursor(JLjava/lang/String;IIIII)I": (h: bigint, s: string, cs: number, ce: number, _dir: number, offset: number, opt: number) =>
    textRunCursor(h, s, cs, ce - cs, offset, opt),
  "nBreakText(JLjava/lang/String;ZFI[F)I": waits((h: bigint, s: string, forwards: number, maxWidth: number, _bidi: number, measured: Float32Array | null) =>
    breakText(h, s, !!forwards, maxWidth, measured)),
  "nBreakText(J[CIIFI[F)I": waits((h: bigint, c: Uint16Array, index: number, count: number, maxWidth: number, _bidi: number, measured: Float32Array | null) =>
    breakText(h, charsToString(c, index, Math.abs(count)), count >= 0, maxWidth, measured)),
});
