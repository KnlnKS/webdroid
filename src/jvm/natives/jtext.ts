// java.text (Format, DateFormat, Collator, CharacterIterator, AttributedCharacterIterator, BreakIterator,
// Normalizer, Bidi…) plus android.icu ListFormatter and java.util StringTokenizer/ServiceLoader.

import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { vcall, vcallOn, curThread, defineException, fillInStackTrace, type JThrowable, mkEnumSet, type JSimpleEnum, newObj, stringHash, type JSB, after } from "./jlang";
import { csText } from "./jchars";
import { strArray, jarray, utf8, slashName, dotName, charsToString } from "../abi";
import { mkIter, toJsArray } from "./jutil";
import { JDate, type JCalendar } from "./jtime";
import { localTz, type JTimeZone } from "./jtime-iso";
import { formatPattern, parsePattern, checkSdfPattern, displayNames, localizedPattern, tagOf } from "./jtime-pattern";
import { directionality } from "../bidi";
import bidiFactory from "bidi-js";
import { defaultLocale, localeTag, type JLocale } from "./jvalues";

class JListFormatter extends JObj {
  formatter: Intl.ListFormat;
  constructor(locale: JLocale = defaultLocale) {
    super();
    if (!locale) rt.npe();
    this.formatter = new Intl.ListFormat(localeTag(locale));
  }
  async format(items: unknown[] | Promise<unknown[]>) {
    const thread = curThread, strings: string[] = [];
    for (const item of await items) {
      if (item === null || item === undefined) rt.npe();
      strings.push(typeof item === "string" ? item : String(await vcallOn(thread, item, "toString", "()Ljava/lang/String;")));
    }
    return this.formatter.format(strings);
  }
}
rt.register({ name: "android/icu/text/ListFormatter", ctor: JListFormatter, methods: {
  "static getInstance()Landroid/icu/text/ListFormatter;": () => new JListFormatter(),
  "static getInstance(Ljava/util/Locale;)Landroid/icu/text/ListFormatter;": (locale: JLocale) => new JListFormatter(locale),
  "format([Ljava/lang/Object;)Ljava/lang/String;": function (this: JListFormatter, items: unknown[] | null) {
    if (!items) return rt.npe();
    return this.format(items);
  },
  "format(Ljava/util/Collection;)Ljava/lang/String;": function (this: JListFormatter, items: unknown) {
    if (!items) return rt.npe();
    return this.format(toJsArray(items));
  },
} });

const bidiEngine = bidiFactory();
class JBidi extends JObj {
  text = "";
  levels: Uint8Array<ArrayBufferLike> = new Uint8Array();
  baseLevel = 0;
  runs: { start: number; limit: number; level: number }[] = [];
  setLevels(text: string, levels: Uint8Array<ArrayBufferLike>, baseLevel: number) {
    this.text = text;
    this.levels = levels;
    this.baseLevel = baseLevel;
    this.runs = [];
    for (let start = 0; start < text.length;) {
      const level = this.levels[start];
      let limit = start + 1;
      while (limit < text.length && this.levels[limit] === level) limit++;
      this.runs.push({ start, limit, level });
      start = limit;
    }
    if (!this.runs.length) this.runs.push({ start: 0, limit: 0, level: baseLevel });
  }
  init(text: string, flags: number) {
    if (text == null) rt.npe();
    let dir: "ltr" | "rtl" | "auto" = flags === 1 ? "rtl" : flags === 0 ? "ltr" : "auto";
    if (flags === -1 && ![...text].some(c => { const d = directionality(c.codePointAt(0)!); return d === 0 || d === 1 || d === 2; })) dir = "rtl";
    const resolved = bidiEngine.getEmbeddingLevels(text, dir);
    this.setLevels(text, resolved.levels, resolved.paragraphs[0]?.level ?? (dir === "rtl" ? 1 : 0));
  }
}
rt.register({
  name: "java/text/Bidi", ctor: JBidi,
  statics: { DIRECTION_LEFT_TO_RIGHT: 0, DIRECTION_RIGHT_TO_LEFT: 1, DIRECTION_DEFAULT_LEFT_TO_RIGHT: -2, DIRECTION_DEFAULT_RIGHT_TO_LEFT: -1 },
  methods: {
    "<init>(Ljava/lang/String;I)V": function (this: JBidi, text: string, flags: number) { this.init(text, flags); },
    "<init>([CI[BIII)V": function (this: JBidi, chars: Uint16Array, start: number, _embeddings: Int8Array | null, _embStart: number, length: number, flags: number) {
      if (!chars || start < 0 || length < 0 || start > chars.length - length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid text range");
      this.init(charsToString(chars, start, length), flags);
    },
    "getLength()I": function (this: JBidi) { return this.text.length; },
    "getBaseLevel()I": function (this: JBidi) { return this.baseLevel; },
    "baseIsLeftToRight()Z": function (this: JBidi) { return this.baseLevel === 0 ? 1 : 0; },
    "getLevelAt(I)I": function (this: JBidi, i: number) { return this.levels[i] ?? this.baseLevel; },
    "getRunCount()I": function (this: JBidi) { return this.runs.length; },
    "getRunStart(I)I": function (this: JBidi, i: number) { return this.runs[i]?.start ?? -1; },
    "getRunLimit(I)I": function (this: JBidi, i: number) { return this.runs[i]?.limit ?? -1; },
    "getRunLevel(I)I": function (this: JBidi, i: number) { return this.runs[i]?.level ?? -1; },
    "isLeftToRight()Z": function (this: JBidi) { return this.baseLevel === 0 && this.runs.length === 1 && this.runs[0].level === 0 ? 1 : 0; },
    "isRightToLeft()Z": function (this: JBidi) { return this.baseLevel === 1 && this.runs.length === 1 && this.runs[0].level === 1 ? 1 : 0; },
    "isMixed()Z": function (this: JBidi) { return this.runs.length !== 1 || this.runs[0].level !== this.baseLevel ? 1 : 0; },
    "createLineBidi(II)Ljava/text/Bidi;": function (this: JBidi, start: number, limit: number) {
      if (start < 0 || limit < start || limit > this.text.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid line range");
      const line = new JBidi();
      line.setLevels(this.text.slice(start, limit), this.levels.slice(start, limit), this.baseLevel);
      return line;
    },
    "static requiresBidi([CII)Z": (text: Uint16Array | null, start: number, limit: number) => {
      if (!text) throw rt.mkThrowable("java/lang/NullPointerException", "text");
      if (start < 0 || start > limit || limit > text.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid text range");
      for (let i = start; i < limit; i++) {
        let cp = text[i];
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < limit && text[i + 1] >= 0xdc00 && text[i + 1] <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + text[++i] - 0xdc00;
        }
        const dir = directionality(cp);
        if (dir === 1 || dir === 2 || dir === 6 || dir === 16 || dir === 17) return 1;
      }
      return 0;
    },
  },
});

export class JDateFormat extends JObj { pattern = ""; tz: JTimeZone | null = null; locale: JLocale | null = null; century: number | null = null; ampm: string[] | null = null; }
export function withPattern(p: string, locale: JLocale | null = null): JDateFormat {
  checkSdfPattern(p);
  const f = new (rt.link("java/text/SimpleDateFormat").ctor as typeof JDateFormat)();
  f.pattern = p;
  f.locale = locale;
  return f;
}
// DateFormat.FULL, LONG, MEDIUM, SHORT → the locale's CLDR patterns
export const STYLE_NAMES = ["FULL", "LONG", "MEDIUM", "SHORT"];
export const styled = (date: number | null, time: number | null, locale: JLocale | null = null) =>
  withPattern(localizedPattern(date === null ? null : STYLE_NAMES[date] ?? "MEDIUM", time === null ? null : STYLE_NAMES[time] ?? "MEDIUM", tagOf(locale)), locale);
export const formatAt = (f: JDateFormat, t: number) => formatPattern(f.pattern, t, (f.tz ?? localTz).id, f.locale, f.ampm);
function parseAt(f: JDateFormat, s: string, pos: JParsePosition): JDate | null {
  const t = parsePattern(f.pattern, s, pos, (f.tz ?? localTz).id, f.locale, f.century, f.ampm);
  if (t === null) return null;
  const d = new JDate();
  d.t = t;
  return d;
}
function parseAtPosition(this: JDateFormat, s: string, pos: JParsePosition) { return parseAt(this, s, pos); }
function sdfPattern(this: JDateFormat) { return this.pattern; }
function applySdfPattern(this: JDateFormat, p: string) { checkSdfPattern(p); this.pattern = p; }
const dateFormatMethods: NativeSpec["methods"] = {
  "format(Ljava/util/Date;)Ljava/lang/String;": function (this: JDateFormat, d: JDate) { return formatAt(this, d.t); },
  "format(Ljava/lang/Object;)Ljava/lang/String;": function (this: JDateFormat, o: unknown) {
    if (o instanceof JDate) return formatAt(this, o.t);
    if (!rt.iof(o, "java/lang/Number")) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Cannot format given Object as a Date");
    return after(vcall(o, "longValue", "()J"), (t: bigint) => formatAt(this, Number(t)));
  },
  "format(Ljava/util/Date;Ljava/lang/StringBuffer;Ljava/text/FieldPosition;)Ljava/lang/StringBuffer;": function (this: JDateFormat, d: JDate, sb: JSB) {
    sb.s += formatAt(this, d.t);
    return sb;
  },
  "parse(Ljava/lang/String;)Ljava/util/Date;": function (this: JDateFormat, s: string) {
    const pos = new JParsePosition(), d = parseAt(this, s, pos);
    if (!d) throw Object.assign(rt.mkThrowable("java/text/ParseException", `Unparseable date: "${s}"`), { errorOffset: pos.errorIndex });
    return d;
  },
  // the non-throwing form: on failure AOSP returns null and sets errorIndex rather than raising
  "parse(Ljava/lang/String;Ljava/text/ParsePosition;)Ljava/util/Date;": parseAtPosition,
  "parseObject(Ljava/lang/String;Ljava/text/ParsePosition;)Ljava/lang/Object;": parseAtPosition,
  "setTimeZone(Ljava/util/TimeZone;)V": function (this: JDateFormat, tz: JTimeZone) { this.tz = tz; },
  "getTimeZone()Ljava/util/TimeZone;": function (this: JDateFormat) { return this.tz ?? localTz; },
  "setCalendar(Ljava/util/Calendar;)V": function (this: JDateFormat, c: JCalendar) { this.tz = (c ?? rt.npe()).tz; },
  "getCalendar()Ljava/util/Calendar;": function (this: JDateFormat) {
    return vcall(rt.link("java/util/Calendar").ctor, "getInstance", "(Ljava/util/TimeZone;)Ljava/util/Calendar;", this.tz ?? localTz);
  },
  "setLenient(Z)V": () => {},
  "isLenient()Z": () => 1,
  "clone()Ljava/lang/Object;": function (this: JDateFormat) { return Object.assign(new (this.constructor as typeof JDateFormat)(), this); },
  "equals(Ljava/lang/Object;)Z": function (this: JDateFormat, o: unknown) { return +(o instanceof JDateFormat && o.pattern === this.pattern); },
  "hashCode()I": function (this: JDateFormat) { return stringHash(this.pattern); },
};
// the abstract base DateFormat and NumberFormat share, so a cast through Format holds; each
// concrete formatter carries its own format(Object)
rt.register({ name: "java/text/Format", ctor: class extends JObj {}, ifaces: ["java/io/Serializable", "java/lang/Cloneable"], methods: { "<init>()V": function () {} } });

rt.register({
  name: "java/text/DateFormat", ctor: JDateFormat, sup: "java/text/Format", ifaces: ["java/lang/Cloneable"],
  statics: { FULL: 0, LONG: 1, MEDIUM: 2, SHORT: 3, DEFAULT: 2 },
  methods: {
    ...dateFormatMethods,
    "<init>()V": function () {},
    "static getInstance()Ljava/text/DateFormat;": () => styled(3, 3),
    "static getDateInstance()Ljava/text/DateFormat;": () => styled(2, null),
    "static getDateInstance(I)Ljava/text/DateFormat;": (d: number) => styled(d, null),
    "static getDateInstance(ILjava/util/Locale;)Ljava/text/DateFormat;": (d: number, l: JLocale) => styled(d, null, l),
    "static getTimeInstance()Ljava/text/DateFormat;": () => styled(null, 2),
    "static getTimeInstance(I)Ljava/text/DateFormat;": (t: number) => styled(null, t),
    "static getTimeInstance(ILjava/util/Locale;)Ljava/text/DateFormat;": (t: number, l: JLocale) => styled(null, t, l),
    "static getDateTimeInstance()Ljava/text/DateFormat;": () => styled(2, 2),
    "static getDateTimeInstance(II)Ljava/text/DateFormat;": (d: number, t: number) => styled(d, t),
    "static getDateTimeInstance(IILjava/util/Locale;)Ljava/text/DateFormat;": (d: number, t: number, l: JLocale) => styled(d, t, l),
  },
});
rt.register({
  name: "java/text/SimpleDateFormat", ctor: class extends JDateFormat {}, sup: "java/text/DateFormat",
  methods: {
    "<init>()V": function (this: JDateFormat) { this.pattern = localizedPattern("SHORT", "SHORT", tagOf(null)); },
    "<init>(Ljava/lang/String;)V": function (this: JDateFormat, p: string) { checkSdfPattern(p); this.pattern = p; },
    "<init>(Ljava/lang/String;Ljava/util/Locale;)V": function (this: JDateFormat, p: string, l: JLocale) { checkSdfPattern(p); this.pattern = p; this.locale = l; },
    "<init>(Ljava/lang/String;Ljava/text/DateFormatSymbols;)V": function (this: JDateFormat, p: string, symbols: JDateFormatSymbols) {
      checkSdfPattern(p); this.pattern = p; useSymbols(this, symbols);
    },
    "setDateFormatSymbols(Ljava/text/DateFormatSymbols;)V": function (this: JDateFormat, symbols: JDateFormatSymbols) { useSymbols(this, symbols); },
    "getDateFormatSymbols()Ljava/text/DateFormatSymbols;": function (this: JDateFormat) {
      return Object.assign(symbols(this.locale ?? undefined), { amPm: this.ampm && [...this.ampm] });
    },
    "set2DigitYearStart(Ljava/util/Date;)V": function (this: JDateFormat, d: JDate) { this.century = (d ?? rt.npe()).t; },
    "get2DigitYearStart()Ljava/util/Date;": function (this: JDateFormat) {
      const d = new JDate(), start = new Date();
      start.setFullYear(start.getFullYear() - 80);
      d.t = this.century ?? start.getTime();
      return d;
    },
    "toPattern()Ljava/lang/String;": sdfPattern,
    "toLocalizedPattern()Ljava/lang/String;": sdfPattern,
    "applyPattern(Ljava/lang/String;)V": applySdfPattern,
    "applyLocalizedPattern(Ljava/lang/String;)V": applySdfPattern,
  },
});
defineException("java/text/ParseException", "java/lang/Exception", [], {
  "<init>(Ljava/lang/String;I)V": function (this: JThrowable & { errorOffset: number }, msg: string | null, offset: number) {
    this.msg = msg; this.errorOffset = offset; fillInStackTrace(this);
  },
  "getErrorOffset()I": function (this: { errorOffset?: number }) { return this.errorOffset ?? 0; },
});
class JDateFormatSymbols extends JObj { tag = localeTag(defaultLocale); amPm: string[] | null = null; }
/** a formatter keeps a copy of the symbols it was given, as SimpleDateFormat clones them */
function useSymbols(f: JDateFormat, s: JDateFormatSymbols | null) {
  const amPm = (s ?? rt.npe()).amPm;
  f.ampm = amPm && [...amPm];
}
const symbols = (l?: JLocale) => Object.assign(new JDateFormatSymbols(), { tag: localeTag(l ?? defaultLocale) });
/** Calendar-indexed weekday names: an unused slot 0, then Sunday first */
const weekdays = (tag: string, style: "long" | "short") => { const w = displayNames(tag, "weekday", style); return strArray(["", w[6], ...w.slice(0, 6)]); };
rt.register({
  name: "java/text/DateFormatSymbols", ctor: JDateFormatSymbols, ifaces: ["java/io/Serializable", "java/lang/Cloneable"],
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/util/Locale;)V": function (this: JDateFormatSymbols, l: JLocale) { this.tag = localeTag(l); },
    "static getInstance()Ljava/text/DateFormatSymbols;": () => symbols(),
    "static getInstance(Ljava/util/Locale;)Ljava/text/DateFormatSymbols;": symbols,
    "getMonths()[Ljava/lang/String;": function (this: JDateFormatSymbols) { return strArray([...displayNames(this.tag, "month", "long"), ""]); },
    "getShortMonths()[Ljava/lang/String;": function (this: JDateFormatSymbols) { return strArray([...displayNames(this.tag, "month", "short"), ""]); },
    "getWeekdays()[Ljava/lang/String;": function (this: JDateFormatSymbols) { return weekdays(this.tag, "long"); },
    "getShortWeekdays()[Ljava/lang/String;": function (this: JDateFormatSymbols) { return weekdays(this.tag, "short"); },
    "getAmPmStrings()[Ljava/lang/String;": function (this: JDateFormatSymbols) { return strArray(this.amPm ?? displayNames(this.tag, "dayPeriod", "short")); },
    "setAmPmStrings([Ljava/lang/String;)V": function (this: JDateFormatSymbols, v: string[]) { this.amPm = [...v]; },
    "getEras()[Ljava/lang/String;": function (this: JDateFormatSymbols) { return strArray(displayNames(this.tag, "era", "short")); },
    // the per-zone display names a formatter would look up; none is offered, as on a device
    // whose locale data carries no zone strings
    "getZoneStrings()[[Ljava/lang/String;": () => jarray([], "[Ljava/lang/String;"),
  },
});

const collator = () => rt.make("java/text/Collator");
rt.register({
  name: "java/text/Collator", ctor: class extends JObj {}, ifaces: ["java/util/Comparator"],
  methods: {
    "static getInstance()Ljava/text/Collator;": collator,
    "static getInstance(Ljava/util/Locale;)Ljava/text/Collator;": collator,
    "compare(Ljava/lang/String;Ljava/lang/String;)I": (a: string, b: string) => a.localeCompare(b),
    "compare(Ljava/lang/Object;Ljava/lang/Object;)I": (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    "setStrength(I)V": () => {},
  },
});

class JParsePosition extends JObj { index = 0; errorIndex = -1; }
rt.register({
  name: "java/text/ParsePosition", ctor: JParsePosition,
  methods: {
    "<init>(I)V": function (this: JParsePosition, i: number) { this.index = i; },
    "getIndex()I": function (this: JParsePosition) { return this.index; },
    "setIndex(I)V": function (this: JParsePosition, i: number) { this.index = i; },
    "getErrorIndex()I": function (this: JParsePosition) { return this.errorIndex; },
    "setErrorIndex(I)V": function (this: JParsePosition, i: number) { this.errorIndex = i; },
  },
});

// ── java.text.CharacterIterator: interface, implementers walk it via
// first/next/current until DONE. StringCharacterIterator is the JDK's minimal
// concrete implementation over a plain String.
const CHAR_ITER_DONE = 0xffff;
rt.register({
  name: "java/text/CharacterIterator", ctor: class extends JObj {}, ifaces: ["java/lang/Cloneable"],
  statics: { DONE: CHAR_ITER_DONE },
});
class JStringCharIter extends JObj {
  text = ""; begin = 0; end = 0; pos = 0;
  cur(): number { return this.pos >= this.begin && this.pos < this.end ? this.text.charCodeAt(this.pos) : CHAR_ITER_DONE; }
}
/** CharacterIterator navigation over [begin, end), shared by every implementer here */
const charIterMethods: NativeSpec["methods"] = {
  "first()C": function (this: JStringCharIter) { this.pos = this.begin; return this.cur(); },
  "last()C": function (this: JStringCharIter) { this.pos = this.end > this.begin ? this.end - 1 : this.end; return this.cur(); },
  "current()C": function (this: JStringCharIter) { return this.cur(); },
  "next()C": function (this: JStringCharIter) {
    if (this.pos < this.end - 1) { this.pos++; return this.cur(); }
    this.pos = this.end; return CHAR_ITER_DONE;
  },
  "previous()C": function (this: JStringCharIter) {
    if (this.pos > this.begin) { this.pos--; return this.cur(); }
    return CHAR_ITER_DONE;
  },
  "setIndex(I)C": function (this: JStringCharIter, i: number) { this.pos = i; return this.cur(); },
  "getBeginIndex()I": function (this: JStringCharIter) { return this.begin; },
  "getEndIndex()I": function (this: JStringCharIter) { return this.end; },
  "getIndex()I": function (this: JStringCharIter) { return this.pos; },
};
rt.register({
  name: "java/text/StringCharacterIterator", ctor: JStringCharIter, ifaces: ["java/text/CharacterIterator"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JStringCharIter, s: string) {
      this.text = s ?? ""; this.begin = 0; this.end = this.text.length; this.pos = 0;
    },
    "<init>(Ljava/lang/String;I)V": function (this: JStringCharIter, s: string, pos: number) {
      this.text = s ?? ""; this.begin = 0; this.end = this.text.length; this.pos = pos;
    },
    "<init>(Ljava/lang/String;III)V": function (this: JStringCharIter, s: string, begin: number, end: number, pos: number) {
      this.text = s ?? ""; this.begin = begin; this.end = end; this.pos = pos;
    },
    ...charIterMethods,
    "equals(Ljava/lang/Object;)Z": function (this: JStringCharIter, o: JStringCharIter) {
      return o instanceof JStringCharIter && o.text === this.text && o.begin === this.begin && o.end === this.end && o.pos === this.pos ? 1 : 0;
    },
    "clone()Ljava/lang/Object;": function (this: JStringCharIter) {
      const c = new JStringCharIter(); c.text = this.text; c.begin = this.begin; c.end = this.end; c.pos = this.pos; return c;
    },
  },
});

// ── AttributedCharacterIterator over formatted text: one attribute key, a value per segment
export class JAttribute extends JObj { constructor(readonly name = "") { super(); } }
type AttrSegment = { start: number; end: number; value: unknown };
class JAttrIter extends JStringCharIter {
  segments: AttrSegment[] = [];
  key: JAttribute | null = null;
  segment() { return this.segments.find((s) => this.pos >= s.start && this.pos < s.end) ?? null; }
}
/** an iterator over `text` whose segments carry `key` with their value (undefined: unattributed) */
export function attributedIterator(text: string, key: JAttribute, segments: AttrSegment[]): JAttrIter {
  const it = new (rt.link("webdroid/AttributedCharacterIterator").ctor as typeof JAttrIter)();
  it.text = text; it.end = text.length; it.key = key; it.segments = segments;
  return it;
}
function runStart(this: JAttrIter) { return this.segment()?.start ?? this.pos; }
function runLimit(this: JAttrIter) { return this.segment()?.end ?? this.pos; }
const runOf = (it: JAttrIter, attr?: unknown) => {
  const s = it.segment();
  const covers = s && s.value !== undefined && (attr === undefined || attr === it.key);
  return covers ? s : { start: s?.start ?? it.pos, end: s?.end ?? it.pos, value: undefined };
};
async function attributeMap(it: JAttrIter) {
  const map = rt.make("java/util/HashMap"), v = it.segment()?.value;
  if (v !== undefined) await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", it.key, v);
  return map;
}
rt.markers("java/text/AttributedCharacterIterator");
rt.register({
  name: "java/text/AttributedCharacterIterator$Attribute", ctor: JAttribute, ifaces: ["java/io/Serializable"],
  methods: { "toString()Ljava/lang/String;": function (this: JAttribute) { return `${(this.constructor as typeof JObj).$i.name.replaceAll("/", ".")}(${this.name})`; } },
});
rt.register({ name: "java/text/Format$Field", ctor: class extends JAttribute {}, sup: "java/text/AttributedCharacterIterator$Attribute" });
rt.register({
  name: "webdroid/AttributedCharacterIterator", ctor: JAttrIter, ifaces: ["java/text/AttributedCharacterIterator"],
  methods: {
    ...charIterMethods,
    "getRunStart()I": runStart,
    "getRunLimit()I": runLimit,
    "getRunStart(Ljava/text/AttributedCharacterIterator$Attribute;)I": function (this: JAttrIter, a: unknown) { return runOf(this, a).start; },
    "getRunLimit(Ljava/text/AttributedCharacterIterator$Attribute;)I": function (this: JAttrIter, a: unknown) { return runOf(this, a).end; },
    "getRunStart(Ljava/util/Set;)I": runStart,
    "getRunLimit(Ljava/util/Set;)I": runLimit,
    "getAttributes()Ljava/util/Map;": function (this: JAttrIter) { return attributeMap(this); },
    "getAttribute(Ljava/text/AttributedCharacterIterator$Attribute;)Ljava/lang/Object;": function (this: JAttrIter, a: unknown) {
      return a === this.key ? this.segment()?.value ?? null : null;
    },
    "getAllAttributeKeys()Ljava/util/Set;": function (this: JAttrIter) {
      const set = rt.make("java/util/HashSet");
      return this.segments.some((s) => s.value !== undefined) ? after(vcall(set, "add", "(Ljava/lang/Object;)Z", this.key), () => set) : set;
    },
  },
});

// ── java.text.BreakIterator (line/word/sentence/char boundaries; whitespace-based approximation)
class JBreakIter extends JObj {
  text = "";
  pos = 0;
  kind: "line" | "word" | "char" | "sentence" = "line";
  private sorted: number[] | null = null;
  setText(text: string) { this.text = text; this.pos = 0; this.sorted = null; }
  bounds(): number[] { return this.sorted ??= this.compute(); }
  private compute(): number[] {
    const b = new Set<number>([0, this.text.length]);
    if (this.kind === "char") {
      for (let i = 0; i <= this.text.length; i++) b.add(i);
    } else if (this.kind === "sentence") {
      for (let i = 0; i < this.text.length; i++) if (/[.!?]/.test(this.text[i])) b.add(i + 1);
    } else {
      for (let i = 0; i < this.text.length; i++) {
        if (/\s/.test(this.text[i])) { if (this.kind === "word") b.add(i); b.add(i + 1); }
        else if (this.kind === "line" && /[-\u2010]/.test(this.text[i])) b.add(i + 1);
      }
    }
    return [...b].sort((x, y) => x - y);
  }
  /** move to the first boundary past `off` in direction `dir`; DONE (-1) when there is none */
  seek(off: number, dir: 1 | -1): number {
    const bs = this.bounds();
    // first index whose boundary lies past `off` (dir 1) or at/past it (dir -1)
    let lo = 0, hi = bs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dir > 0 ? bs[mid] <= off : bs[mid] < off) lo = mid + 1; else hi = mid; }
    const n = dir > 0 ? bs[lo] : bs[lo - 1];
    if (n === undefined) return -1;
    this.pos = n;
    return n;
  }
}
const biFactory = (kind: JBreakIter["kind"]) => () => { const b = new JBreakIter(); b.kind = kind; return b; };
rt.register({
  name: "java/text/BreakIterator", ctor: JBreakIter,
  statics: { DONE: -1 },
  methods: {
    ...Object.fromEntries(([["Line", "line"], ["Word", "word"], ["Character", "char"], ["Sentence", "sentence"]] as const).flatMap(([n, kind]) =>
      ["", "Ljava/util/Locale;"].map((a) => [`static get${n}Instance(${a})Ljava/text/BreakIterator;`, biFactory(kind)]))),
    "setText(Ljava/lang/String;)V": function (this: JBreakIter, t: string) { this.setText(t ?? ""); },
    "setText(Ljava/text/CharacterIterator;)V": driven(function* (this: JBreakIter, ci: JObj): Gen {
      let s = "";
      if (ci) {
        for (let c = yield vcall(ci, "first", "()C"); c !== CHAR_ITER_DONE; c = yield vcall(ci, "next", "()C")) {
          s += String.fromCharCode(c);
        }
      }
      this.setText(s);
    }),
    "first()I": function (this: JBreakIter) { this.pos = 0; return 0; },
    "last()I": function (this: JBreakIter) { this.pos = this.text.length; return this.pos; },
    "current()I": function (this: JBreakIter) { return this.pos; },
    "next()I": function (this: JBreakIter) { return this.seek(this.pos, 1); },
    "previous()I": function (this: JBreakIter) { return this.seek(this.pos, -1); },
    "following(I)I": function (this: JBreakIter, off: number) { return this.seek(off, 1); },
    "preceding(I)I": function (this: JBreakIter, off: number) { return this.seek(off, -1); },
    "isBoundary(I)Z": function (this: JBreakIter, off: number) { return this.bounds().includes(off) ? 1 : 0; },
  },
});

// java.text.Normalizer over String.prototype.normalize
mkEnumSet("java/text/Normalizer$Form", ["NFC", "NFD", "NFKC", "NFKD"]);
const normalizeWith = <T>(cs: unknown, form: JSimpleEnum | null, f: (text: string, normalized: string) => T) =>
  after(csText(cs ?? rt.npe()), (text: string) => f(text, text.normalize((form ?? rt.npe()).ename as "NFC")));
rt.register({
  name: "java/text/Normalizer", ctor: class extends JObj {},
  methods: {
    "static normalize(Ljava/lang/CharSequence;Ljava/text/Normalizer$Form;)Ljava/lang/String;":
      (cs: unknown, form: JSimpleEnum | null) => normalizeWith(cs, form, (_, normalized) => normalized),
    "static isNormalized(Ljava/lang/CharSequence;Ljava/text/Normalizer$Form;)Z":
      (cs: unknown, form: JSimpleEnum | null) => normalizeWith(cs, form, (text, normalized) => +(text === normalized)),
  },
});

class JStringTokenizer extends JObj { toks: string[] = []; i = 0; }
function tokensLeft(this: JStringTokenizer) { return this.i < this.toks.length ? 1 : 0; }
rt.register({
  name: "java/util/StringTokenizer", ctor: JStringTokenizer,
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JStringTokenizer, s: string) {
      this.toks = s.split(/[ \t\n\r\f]+/).filter(Boolean);
    },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JStringTokenizer, s: string, delims: string) {
      const re = new RegExp("[" + delims.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "]+");
      this.toks = s.split(re).filter(Boolean);
    },
    "hasMoreTokens()Z": tokensLeft,
    "hasMoreElements()Z": tokensLeft,
    "nextToken()Ljava/lang/String;": function (this: JStringTokenizer) {
      if (this.i >= this.toks.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      return this.toks[this.i++];
    },
    "countTokens()I": function (this: JStringTokenizer) { return this.toks.length - this.i; },
  },
});

// ── ServiceLoader: META-INF/services entries from the APK
class JServiceLoader extends JObj { svcName = ""; }
async function serviceInstances(svcName: string): Promise<unknown[]> {
  const bytes = rt.classpath["META-INF/services/" + svcName];
  if (!bytes) return [];
  const out: unknown[] = [];
  for (const line of utf8.dec.decode(bytes).split(/\r?\n/)) {
    const cls = line.split("#")[0].trim();
    if (!cls) continue;
    try {
      const name = slashName(cls);
      if (!rt.link(name).stub) out.push(await newObj(name));
    } catch (e) { console.warn("[ServiceLoader]", cls, e); }
  }
  return out;
}
const serviceLoader = (cls: { ci?: { name: string } } | null) => {
  const l = new JServiceLoader(); l.svcName = dotName(cls?.ci?.name ?? ""); return l;
};
rt.register({
  name: "java/util/ServiceLoader", ctor: JServiceLoader,
  ifaces: ["java/lang/Iterable"],
  methods: {
    "static load(Ljava/lang/Class;)Ljava/util/ServiceLoader;": serviceLoader,
    "static load(Ljava/lang/Class;Ljava/lang/ClassLoader;)Ljava/util/ServiceLoader;": serviceLoader,
    "iterator()Ljava/util/Iterator;": driven(function* (this: JServiceLoader): Gen {
      return mkIter(yield serviceInstances(this.svcName));
    }),
  },
});
