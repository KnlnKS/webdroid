// minikin's Hyphenator: Liang's algorithm over the reference build's patterns in
// /system/usr/hyphen-data (the .hyb trie format), its HyphenatorMap, and android_text_Hyphenator's
// registry of languages, as frameworks/minikin and base have them at android-15.0.0_r1. A
// language's patterns are read on its first lookup, where the device maps them all at boot.

import { rt, awaited, type Gen } from "../jvm/runtime.ts";
import { PLATFORM_DATA } from "../jvm/bootclasspath.ts";
import { vfs } from "../shell/vfs.ts";
import { uchar } from "../jvm/natives/jicu.ts";

/** HyphenationType */
export const DONT_BREAK = 0, BREAK_AND_INSERT_HYPHEN = 1, BREAK_AND_INSERT_ARMENIAN_HYPHEN = 2, BREAK_AND_INSERT_UCAS_HYPHEN = 4,
  BREAK_AND_DONT_INSERT_HYPHEN = 5, BREAK_AND_REPLACE_WITH_HYPHEN = 6, BREAK_AND_INSERT_HYPHEN_AT_NEXT_LINE = 7, BREAK_AND_INSERT_HYPHEN_AND_ZWJ = 8;
/** EndHyphenEdit and StartHyphenEdit, as Paint's hyphen edits have them */
export const END_NO_EDIT = 0, END_REPLACE_WITH_HYPHEN = 1, START_NO_EDIT = 0;
/** editForThisLine: the end edit a break of `type` gives its line (DONT_BREAK and
 *  BREAK_AND_DONT_INSERT_HYPHEN none, the rest a hyphen; MAQAF is 3 in both) */
export const editForThisLine = (type: number): number =>
  type === BREAK_AND_REPLACE_WITH_HYPHEN ? 1 : type === BREAK_AND_INSERT_HYPHEN_AND_ZWJ ? 6 : type >= 1 && type <= 4 ? type + 1 : 0;
/** editForNextLine: the start edit a break of `type` gives the next line */
export const editForNextLine = (type: number): number =>
  type === BREAK_AND_INSERT_HYPHEN_AT_NEXT_LINE ? 1 : type === BREAK_AND_INSERT_HYPHEN_AND_ZWJ ? 2 : 0;
/** packHyphenEdit, as LineBreaker's line flags carry it */
export const packHyphenEdit = (start: number, end: number) => start << 3 | end;
const HYPHEN = "‐", ZWJ = "‍";
/** getHyphenString of a start edit */
export const startHyphenString = (edit: number): string => edit === 1 ? HYPHEN : edit === 2 ? ZWJ : "";
/** getHyphenString of an end edit */
export const endHyphenString = (edit: number): string => ["", HYPHEN, HYPHEN, "֊", "־", "᐀", ZWJ + HYPHEN][edit] ?? "";

/** Hyphenator::isLineBreakingHyphen */
export const isLineBreakingHyphen = (c: number) => c === 0x2d || c === 0x58a || c === 0x5be || c === 0x1400 || c === 0x2010
  || c === 0x2013 || c === 0x2027 || c === 0x2e17 || c === 0x2e40;
const SOFT_HYPHEN = 0xad, MIDDLE_DOT = 0xb7, NBSP = 0xa0;
const LATIN = /\p{sc=Latn}/u, ARABIC = /\p{sc=Arab}/u, NO_HYPHEN = /[\p{sc=Knda}\p{sc=Mlym}\p{sc=Taml}\p{sc=Telu}]/u;
const ARMENIAN = /\p{sc=Armn}/u, UCAS = /\p{sc=Cans}/u;
const is = (re: RegExp, c: number) => re.test(String.fromCharCode(c));
/** hyphenationTypeBasedOnScript */
const typeByScript = (c: number) =>
  is(NO_HYPHEN, c) ? BREAK_AND_DONT_INSERT_HYPHEN : is(ARMENIAN, c) ? BREAK_AND_INSERT_ARMENIAN_HYPHEN : is(UCAS, c) ? BREAK_AND_INSERT_UCAS_HYPHEN : BREAK_AND_INSERT_HYPHEN;
// ICU's UProperty.JOINING_TYPE and its values
const JOINING_TYPE = 0x1006, JT_JOIN_CAUSING = 1, JT_DUAL = 2, JT_LEFT = 3, JT_RIGHT = 4, JT_TRANSPARENT = 5;
export const intProperty = uchar("getIntPropertyValue", "(II)I") as (c: number, property: number) => number | Promise<number>;
function* joiningType(c: number): Gen<number> { return yield* awaited(intProperty(c, JOINING_TYPE)); }
/** getHyphTypeForArabic: a ZWJ around the hyphen where the letters on both sides join */
function* arabicType(word: string, at: number): Gen<number> {
  let i = at, type = 0;
  while (i < word.length && (type = yield* joiningType(word.charCodeAt(i))) === JT_TRANSPARENT) i++;
  if (type === JT_DUAL || type === JT_RIGHT || type === JT_JOIN_CAUSING) {
    i = at - 2; type = 0;
    while (i >= 0 && (type = yield* joiningType(word.charCodeAt(i))) === JT_TRANSPARENT) i--;
    if (type === JT_DUAL || type === JT_LEFT || type === JT_JOIN_CAUSING) return BREAK_AND_INSERT_HYPHEN_AND_ZWJ;
  }
  return BREAK_AND_INSERT_HYPHEN;
}

const OTHER = 0, CATALAN = 1, POLISH = 2, SLOVENIAN = 3;
const MAX_HYPHENATED_SIZE = 64;
class Hyphenator {
  private readonly path: string | null; private readonly minPrefix: number; private readonly minSuffix: number;
  private data: Uint8Array | null = null;
  private loading: Promise<void> | null = null;
  private readonly kind: number;
  constructor(path: string | null, minPrefix: number, minSuffix: number, locale: string) {
    this.path = path; this.minPrefix = minPrefix; this.minSuffix = minSuffix;
    this.kind = locale === "pl" ? POLISH : locale === "ca" ? CATALAN : locale === "sl" ? SLOVENIAN : OTHER;
  }
  /** the patterns in memory, null once they are */
  ready(): Promise<void> | null {
    if (!this.path || this.data) return null;
    return this.loading ??= Promise.resolve(vfs.readFile(this.path)).then((b) => { this.data = b; });
  }
  /** HyphenatorCXX::hyphenate: a type for each code unit of `word` into out[at...]; ready() first */
  *hyphenate(word: string, out: Uint8Array, at: number): Gen<void> {
    const len = word.length, padded = len + 2;
    if (this.data && len >= this.minPrefix + this.minSuffix && padded <= MAX_HYPHENATED_SIZE) {
      const codes = new Uint16Array(padded), type = this.alphabetLookup(codes, word);
      if (type !== DONT_BREAK) return this.fromCodes(codes, padded, type, out, at);
    }
    yield* this.withNoPatterns(word, out, at);
  }
  private alphabetLookup(codes: Uint16Array, word: string): number {
    const d = new DataView(this.data!.buffer, this.data!.byteOffset), alphabet = d.getUint32(8, true);
    let result = BREAK_AND_INSERT_HYPHEN;
    const version = d.getUint32(alphabet, true);
    if (version > 1) return DONT_BREAK;
    for (let i = 0; i < word.length; i++) {
      const c = word.charCodeAt(i);
      let code: number;
      if (version === 0) {
        const min = d.getUint32(alphabet + 4, true), max = d.getUint32(alphabet + 8, true);
        if (c < min || c >= max || !(code = this.data![alphabet + 12 + c - min])) return DONT_BREAK;
      } else {
        // the first entry not below c << 11
        const n = d.getUint32(alphabet + 4, true), key = c << 11;
        let lo = 0, hi = n;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (d.getUint32(alphabet + 8 + mid * 4, true) < key) lo = mid + 1; else hi = mid; }
        if (lo === n) return DONT_BREAK;
        const entry = d.getUint32(alphabet + 8 + lo * 4, true);
        if (entry >>> 11 !== c) return DONT_BREAK;
        code = entry & 0x7ff;
      }
      if (result === BREAK_AND_INSERT_HYPHEN) result = typeByScript(c);
      codes[i + 1] = code;
    }
    return result;
  }
  /** hyphenateFromCodes: `len` counts the start and end codes; the odd points of the patterns
   *  matched within [minPrefix, len - minSuffix - 1) break */
  private fromCodes(codes: Uint16Array, len: number, type: number, out: Uint8Array, at: number): void {
    const data = this.data!, d = new DataView(data.buffer, data.byteOffset);
    const trie = d.getUint32(12, true), pattern = d.getUint32(16, true);
    const charMask = d.getUint32(trie + 4, true), linkShift = d.getUint32(trie + 8, true), linkMask = d.getUint32(trie + 12, true);
    const patternShift = d.getUint32(trie + 16, true), trieData = trie + 24;
    const patternOffset = d.getUint32(pattern + 8, true), patternData = pattern + 16;
    const buffer = out.subarray(at, at + len - 2), maxOffset = len - this.minSuffix - 1;
    for (let i = 0; i < len - 1; i++) {
      let node = 0;
      for (let j = i; j < len; j++) {
        const c = codes[j], entry = d.getUint32(trieData + (node + c) * 4, true);
        if (((entry & charMask) >>> 0) !== c) break;
        node = ((entry & linkMask) >>> 0) >>> linkShift;
        const ix = d.getUint32(trieData + node * 4, true) >>> patternShift;
        if (!ix) continue;
        const p = d.getUint32(patternData + ix * 4, true), pLen = p >>> 26, pShift = (p >>> 20) & 0x3f, buf = pattern + patternOffset + (p & 0xfffff);
        const offset = j + 1 - (pLen + pShift), start = Math.max(this.minPrefix - offset, 0), end = Math.min(pLen, maxOffset - offset);
        for (let k = start; k < end; k++) buffer[offset + k] = Math.max(buffer[offset + k], data[buf + k]);
      }
    }
    for (let i = this.minPrefix; i < maxOffset; i++) buffer[i] = buffer[i] & 1 ? type : DONT_BREAK;
  }
  /** hyphenateWithNoPatterns: after hyphens, soft hyphens and Catalan's l·l */
  private *withNoPatterns(word: string, out: Uint8Array, at: number): Gen<void> {
    out[at] = DONT_BREAK;
    for (let i = 1; i < word.length; i++) {
      const prev = word.charCodeAt(i - 1), c = word.charCodeAt(i);
      let type = DONT_BREAK;
      if (i > 1 && isLineBreakingHyphen(prev)) {
        type = (prev === 0x2d || prev === 0x2010) && (this.kind === POLISH || this.kind === SLOVENIAN) && is(LATIN, c)
          ? BREAK_AND_INSERT_HYPHEN_AT_NEXT_LINE : BREAK_AND_DONT_INSERT_HYPHEN;
      } else if (i > 1 && prev === SOFT_HYPHEN) {
        type = is(ARABIC, c) ? yield* arabicType(word, i) : typeByScript(c);
      } else if (prev === MIDDLE_DOT && this.minPrefix < i && i <= word.length - this.minSuffix && this.kind === CATALAN) {
        const before = word[i - 2], after = word[i];
        if (before === "l" && after === "l" || before === "L" && after === "L") type = BREAK_AND_REPLACE_WITH_HYPHEN;
      }
      out[at + i] = type;
    }
  }
}

/** LineBreakerUtil's hyphenate: each run of non-NBSP code units hyphenated as a word, words longer
 *  than LONGEST_HYPHENATED_WORD not at all */
export function* hyphenate(text: string, h: Hyphenator): Gen<Uint8Array> {
  const out = new Uint8Array(text.length);
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === NBSP) {
      if (start >= 0 && i - start <= 45) yield* h.hyphenate(text.slice(start, i), out, start);
      start = -1;
    } else if (start < 0) start = i;
  }
  return out;
}

// ── HyphenatorMap over minikin's Locale identifiers
interface Locale { lang: string; script: string; region: string; variant: string; emoji: string }
/** minikin's Locale parse of a BCP 47 tag: what it does not understand is dropped */
function parseLocale(tag: string): Locale {
  const l: Locale = { lang: "", script: "", region: "", variant: "", emoji: "" }, parts = tag.split("-");
  let k = 0, token = parts[k++];
  if (!/^[a-z]{2,3}$/.test(token)) return l;
  l.lang = token;
  token = parts[k++];
  if (token !== undefined && /^[A-Z][a-z]{3}$/.test(token)) { l.script = token; token = parts[k++]; }
  if (token !== undefined && /^([A-Z]{2}|\d{3})$/.test(token)) { l.region = token; token = parts[k++]; }
  if (l.lang === "de" && (token === "1901" || token === "1996")) l.variant = token;
  const em = /-u-(?:.*-)?em-(emoji|text|default)(?:-|$)/.exec(tag);
  l.emoji = em ? em[1] : l.script === "Zsye" ? "emoji" : l.script === "Zsym" ? "text" : "";
  return l;
}
const idOf = (l: Locale) => `${l.lang}-${l.script}-${l.region}-${l.variant}-${l.emoji}`;
const LANGUAGE = 1, SCRIPT = 2, REGION = 4, VARIANT = 8;
/** getPartialLocale: the subtags `bits` keep, language "und" without one */
const partial = (l: Locale, bits: number): Locale => ({ lang: bits & LANGUAGE ? l.lang : "und", script: bits & SCRIPT ? l.script : "",
  region: bits & REGION ? l.region : "", variant: bits & VARIANT ? l.variant : "", emoji: "" });

const softHyphenOnly = new Hyphenator(null, 2, 2, "");
const hyphenators = new Map<string, Hyphenator>();
/** HyphenatorMap::lookup: the exact locale, then with fewer subtags, then its script alone; else
 *  the hyphenator that only follows soft hyphens */
function lookup(tag: string): Hyphenator {
  const locale = parseLocale(tag), id = idOf(locale);
  let found = hyphenators.get(id);
  if (found) return found;
  for (const bits of [LANGUAGE | REGION | SCRIPT | VARIANT, LANGUAGE | REGION | VARIANT, LANGUAGE | VARIANT, LANGUAGE, SCRIPT]) {
    const sub = idOf(partial(locale, bits));
    if (sub !== id && (found = hyphenators.get(sub))) break;
  }
  found ??= softHyphenOnly;
  hyphenators.set(id, found);
  return found;
}
/** the hyphenator for a paint's first locale, its patterns read */
export function* hyphenatorFor(tag: string): Gen<Hyphenator> {
  const h = lookup(tag), ready = h.ready();
  if (ready) yield* awaited(ready);
  return h;
}
export type { Hyphenator };

/** android_text_Hyphenator's init: each language with a pattern file and its minimum prefix and
 *  suffix, then the aliases */
export function initHyphenators(): void {
  const add = (locale: string, minPrefix: number, minSuffix: number) => {
    const path = `/system/usr/hyphen-data/hyph-${locale.toLowerCase()}.hyb`;
    if (path in PLATFORM_DATA) hyphenators.set(idOf(parseLocale(locale)), new Hyphenator(path, minPrefix, minSuffix, locale));
  };
  const alias = (from: string, to: string) => {
    const h = hyphenators.get(idOf(parseLocale(to)));
    if (h) hyphenators.set(idOf(parseLocale(from)), h);
  };
  const INDIC = 2;
  for (const [l, p, s] of [["af", 1, 1], ["am", 1, 1], ["as", INDIC, INDIC], ["be", 2, 2], ["bg", 2, 2], ["bn", INDIC, INDIC], ["cs", 2, 2],
    ["cu", 1, 2], ["cy", 2, 3], ["da", 2, 2], ["de-1901", 2, 2], ["de-1996", 2, 2], ["de-CH-1901", 2, 2], ["el", 1, 1], ["en-GB", 2, 3],
    ["en-US", 2, 3], ["es", 2, 2], ["et", 2, 3], ["eu", 2, 2], ["fr", 2, 3], ["ga", 2, 3], ["gl", 2, 2], ["gu", INDIC, INDIC], ["hi", INDIC, INDIC],
    ["hr", 2, 2], ["hu", 2, 2], ["hy", 2, 2], ["it", 2, 2], ["ka", 1, 2], ["kn", INDIC, INDIC], ["la", 2, 2], ["lt", 2, 2], ["lv", 2, 2],
    ["ml", INDIC, INDIC], ["mn-Cyrl", 2, 2], ["mr", INDIC, INDIC], ["nb", 2, 2], ["nl", 2, 2], ["nn", 2, 2], ["or", INDIC, INDIC], ["pa", INDIC, INDIC],
    ["pl", 2, 2], ["pt", 2, 3], ["ru", 2, 2], ["sk", 2, 2], ["sl", 2, 2], ["sq", 2, 2], ["sv", 1, 2], ["ta", INDIC, INDIC], ["te", INDIC, INDIC],
    ["tk", 2, 2], ["uk", 2, 2], ["und-Ethi", 1, 1]] as const) add(l, p, s);
  hyphenators.set(idOf(parseLocale("ca")), new Hyphenator(null, 2, 2, "ca"));
  for (const r of ["AS", "GU", "MH", "MP", "PR", "UM", "VI"]) alias(`en-${r}`, "en-US");
  for (const [from, to] of [["en", "en-GB"], ["de", "de-1996"], ["de-LI-1901", "de-CH-1901"], ["no", "nb"], ["mn", "mn-Cyrl"],
    ["am", "und-Ethi"], ["byn", "und-Ethi"], ["gez", "und-Ethi"], ["ti", "und-Ethi"], ["wal", "und-Ethi"], ["und-Beng", "bn"], ["und-Deva", "hi"],
    ["und-Gujr", "gu"], ["und-Guru", "pa"], ["und-Knda", "kn"], ["und-Mlym", "ml"], ["und-Orya", "or"], ["und-Taml", "ta"], ["und-Telu", "te"]]) alias(from, to);
}
rt.registerJnis("android/text/Hyphenator", { "nInit()V": initHyphenators });
