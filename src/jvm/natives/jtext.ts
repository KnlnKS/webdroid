// java.text: DateFormat/SimpleDateFormat, NumberFormat/DecimalFormat, Collator, ParsePosition,
// CharacterIterator, BreakIterator, Normalizer. Formatting is en-only and pattern-driven.

import { rt, JObj, type NativeSpec } from "../runtime";
import { vcall, vcallMaybe, vcallOn, curThread, defineException, mkEnumSet, type JSimpleEnum, newObj, box, JDouble } from "./jlang";
import { strArray, jarray, utf8, slashName, dotName } from "../abi";
import { mkIter, toJsArray } from "./jutil";
import { JDate, JCalendar, localTz, MONTHS, DAYS, pad } from "./jtime";
import { directionality } from "../bidi";
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

rt.register({
  name: "java/text/Bidi", ctor: class extends JObj {},
  methods: {
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

export function formatDate(pattern: string, t: number): string {
  const d = new Date(t);
  return pattern.replace(/'([^']*)'|([GyYMLdEaHhKkmsSzZX])\2*/g, (m, quoted) => {
    if (quoted !== undefined) return quoted || "'";
    const c = m[0], n = m.length;
    switch (c) {
      case "y": case "Y": return n === 2 ? pad(d.getFullYear() % 100) : String(d.getFullYear());
      case "M": case "L":
        if (n >= 4) return MONTHS[d.getMonth()];
        if (n === 3) return MONTHS[d.getMonth()].slice(0, 3);
        return n === 2 ? pad(d.getMonth() + 1) : String(d.getMonth() + 1);
      case "d": return n === 2 ? pad(d.getDate()) : String(d.getDate());
      case "E": return n >= 4 ? DAYS[d.getDay()] : DAYS[d.getDay()].slice(0, 3);
      case "a": return d.getHours() < 12 ? "AM" : "PM";
      case "H": return n === 2 ? pad(d.getHours()) : String(d.getHours());
      case "h": { const h = d.getHours() % 12 || 12; return n === 2 ? pad(h) : String(h); }
      case "K": return String(d.getHours() % 12);
      case "k": return String(d.getHours() || 24);
      case "m": return n === 2 ? pad(d.getMinutes()) : String(d.getMinutes());
      case "s": return n === 2 ? pad(d.getSeconds()) : String(d.getSeconds());
      case "S": return String(d.getMilliseconds()).padStart(3, "0").slice(0, n);
      case "z": case "Z": case "X": return "";
      case "G": return "AD";
      default: return m;
    }
  });
}
function parseDate(s: string): number | null {
  // pragmatic: try common patterns then Date.parse
  const ymd = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (ymd) {
    const hm = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    return new Date(+ymd[1], +ymd[2] - 1, +ymd[3], +(hm?.[1] ?? 0), +(hm?.[2] ?? 0), +(hm?.[3] ?? 0)).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
class JDateFormat extends JObj { pattern = "MMM d, yyyy"; }
function withPattern(p: string): JDateFormat { const f = new JDateFormat(); f.pattern = p; return f; }
// DateFormat.FULL, LONG, MEDIUM, SHORT
const DATE_STYLES = ["EEEE, MMMM d, yyyy", "MMMM d, yyyy", "MMM d, yyyy", "M/d/yy"];
function dateInstance(style: number): JDateFormat { return withPattern(DATE_STYLES[style] ?? DATE_STYLES[2]); }
const dateFormatMethods: NativeSpec["methods"] = {
  "format(Ljava/util/Date;)Ljava/lang/String;": function (this: JDateFormat, d: JDate) {
    return formatDate(this.pattern, d.t);
  },
  "format(Ljava/lang/Object;)Ljava/lang/String;": function (this: JDateFormat, o: unknown) {
    const t = o instanceof JDate ? o.t : o instanceof JCalendar ? o.d.getTime() : typeof o === "bigint" ? Number(o) : Number((o as any)?.v ?? 0);
    return formatDate(this.pattern, t);
  },
  "parse(Ljava/lang/String;)Ljava/util/Date;": function (this: JDateFormat, s: string) {
    const t = parseDate(s);
    if (t === null) throw rt.mkThrowable("java/text/ParseException", "Unparseable date: " + s);
    const d = new JDate();
    d.t = t;
    return d;
  },
  // the non-throwing form: on failure AOSP returns null and sets errorIndex rather than raising
  "parse(Ljava/lang/String;Ljava/text/ParsePosition;)Ljava/util/Date;": function (this: JDateFormat, s: string, pos: JParsePosition) {
    const t = parseDate(s);
    if (t === null) { pos.errorIndex = pos.index; return null; }
    pos.index = s.length;
    const d = new JDate();
    d.t = t;
    return d;
  },
  "setTimeZone(Ljava/util/TimeZone;)V": () => {},
  "setCalendar(Ljava/util/Calendar;)V": () => {},
  "getTimeZone()Ljava/util/TimeZone;": () => localTz,
  "setLenient(Z)V": () => {},
  "toPattern()Ljava/lang/String;": function (this: JDateFormat) { return this.pattern; },
  "applyPattern(Ljava/lang/String;)V": function (this: JDateFormat, p: string) { this.pattern = p; },
};
// the abstract base DateFormat and NumberFormat share, so a cast through Format holds; each
// concrete formatter carries its own format(Object)
rt.register({ name: "java/text/Format", ctor: class extends JObj {}, ifaces: ["java/io/Serializable", "java/lang/Cloneable"], methods: { "<init>()V": function () {} } });

class JMessageFormat extends JObj { pattern = ""; }
async function messageFormat(pattern: string, args: unknown[]): Promise<string> {
  const text = async (value: unknown): Promise<string> => {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
    return String(await vcall(value, "toString", "()Ljava/lang/String;"));
  };
  let out = "", quoted = false;
  for (let i = 0; i < pattern.length;) {
    if (pattern[i] === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      quoted = !quoted; i++; continue;
    }
    if (!quoted && pattern[i] === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unmatched braces in the pattern.");
      const token = pattern.slice(i + 1, end).split(",", 1)[0].trim();
      if (!/^\d+$/.test(token)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "can't parse argument number: " + token);
      const index = Number(token);
      out += index < args.length ? await text(args[index]) : "{" + token + "}";
      i = end + 1;
      continue;
    }
    out += pattern[i++];
  }
  if (quoted) out += "'";
  return out;
}
rt.register({
  name: "java/text/MessageFormat", ctor: JMessageFormat, sup: "java/text/Format",
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JMessageFormat, pattern: string) { this.pattern = pattern; },
    "<init>(Ljava/lang/String;Ljava/util/Locale;)V": function (this: JMessageFormat, pattern: string) { this.pattern = pattern; },
    "static format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;": messageFormat,
    "format([Ljava/lang/Object;)Ljava/lang/String;": function (this: JMessageFormat, args: unknown[]) { return messageFormat(this.pattern, args); },
    "format(Ljava/lang/Object;)Ljava/lang/String;": function (this: JMessageFormat, args: unknown[]) { return messageFormat(this.pattern, args); },
    "applyPattern(Ljava/lang/String;)V": function (this: JMessageFormat, pattern: string) { this.pattern = pattern; },
    "toPattern()Ljava/lang/String;": function (this: JMessageFormat) { return this.pattern; },
  },
});
rt.register({
  name: "java/text/DateFormat", ctor: JDateFormat, sup: "java/text/Format", ifaces: ["java/lang/Cloneable"],
  statics: { FULL: 0, LONG: 1, MEDIUM: 2, SHORT: 3 },
  methods: {
    ...dateFormatMethods,
    "static getDateInstance()Ljava/text/DateFormat;": () => withPattern("MMM d, yyyy"),
    "static getDateInstance(I)Ljava/text/DateFormat;": dateInstance,
    "static getDateInstance(ILjava/util/Locale;)Ljava/text/DateFormat;": dateInstance,
    ...Object.fromEntries((["", "I", "ILjava/util/Locale;"]).flatMap((a) => [[`static getTimeInstance(${a})Ljava/text/DateFormat;`, () => withPattern("h:mm a")],
      [`static getDateTimeInstance(${a.replace("I", "II")})Ljava/text/DateFormat;`, () => withPattern("MMM d, yyyy h:mm a")]])),
  },
});
rt.register({
  name: "java/text/SimpleDateFormat", ctor: class extends JDateFormat {}, sup: "java/text/DateFormat",
  methods: {
    ...dateFormatMethods,
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: JDateFormat, p: string) { this.pattern = p; },
    "<init>(Ljava/lang/String;Ljava/util/Locale;)V": function (this: JDateFormat, p: string) { this.pattern = p; },
  },
});
defineException("java/text/ParseException", "java/lang/Exception");
class JDateFormatSymbols extends JObj {}
rt.register({
  name: "java/text/DateFormatSymbols", ctor: JDateFormatSymbols,
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/util/Locale;)V": function () {},
    "static getInstance()Ljava/text/DateFormatSymbols;": () => new JDateFormatSymbols(),
    "static getInstance(Ljava/util/Locale;)Ljava/text/DateFormatSymbols;": () => new JDateFormatSymbols(),
    "getMonths()[Ljava/lang/String;": () => strArray([...MONTHS, ""]),
    "getShortMonths()[Ljava/lang/String;": () => strArray([...MONTHS.map((m) => m.slice(0, 3)), ""]),
    "getWeekdays()[Ljava/lang/String;": () => strArray(["", ...DAYS]),
    "getShortWeekdays()[Ljava/lang/String;": () => strArray(["", ...DAYS.map((d) => d.slice(0, 3))]),
    "getAmPmStrings()[Ljava/lang/String;": () => strArray(["AM", "PM"]),
    "getEras()[Ljava/lang/String;": () => strArray(["BC", "AD"]),
    // the per-zone display names a formatter would look up; none is offered, as on a device
    // whose locale data carries no zone strings
    "getZoneStrings()[[Ljava/lang/String;": () => jarray([], "[Ljava/lang/String;"),
  },
});

class JNumberFormat extends JObj {
  maxFrac = 3; minFrac = 0; grouping = true; pattern: string | null = null;
  locale = localeTag(defaultLocale);
  style: "decimal" | "percent" = "decimal";
  private cached: Intl.NumberFormat | null = null;
  private key = "";
  fmt(v: number | bigint): string {
    const key = `${this.locale}/${this.style}/${this.minFrac}/${this.maxFrac}/${this.grouping}`;
    if (!this.cached || key !== this.key) {
      const options = { style: this.style, minimumFractionDigits: this.minFrac, maximumFractionDigits: this.maxFrac, useGrouping: this.grouping, roundingMode: "halfEven" } satisfies Intl.NumberFormatOptions & { roundingMode: "halfEven" };
      this.cached = new Intl.NumberFormat(this.locale, options);
      this.key = key;
    }
    return this.cached.format(v);
  }
}
const nfMethods: NativeSpec["methods"] = {
  "format(D)Ljava/lang/String;": function (this: JNumberFormat, v: number) { return this.fmt(v); },
  "format(J)Ljava/lang/String;": function (this: JNumberFormat, v: bigint) { return this.fmt(v); },
  "format(Ljava/lang/Object;)Ljava/lang/String;": function (this: JNumberFormat, o: unknown) {
    if (typeof o === "number" || typeof o === "bigint") return this.fmt(o);
    if (!rt.iof(o, "java/lang/Number")) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Cannot format given Object as a Number");
    const n = vcallMaybe(o, "doubleValue", "()D");
    return n instanceof Promise ? n.then((v: number) => this.fmt(v)) : this.fmt(n);
  },
  "parse(Ljava/lang/String;)Ljava/lang/Number;": function (this: JNumberFormat, s: string) {
    const v = parseFloat(s.replace(/,/g, ""));
    if (Number.isNaN(v)) throw rt.mkThrowable("java/text/ParseException", "Unparseable number: " + s);
    return box(JDouble, v);
  },
  "setMaximumFractionDigits(I)V": function (this: JNumberFormat, n: number) { this.maxFrac = Math.min(20, Math.max(0, n)); this.minFrac = Math.min(this.minFrac, this.maxFrac); },
  "setMinimumFractionDigits(I)V": function (this: JNumberFormat, n: number) { this.minFrac = Math.min(20, Math.max(0, n)); this.maxFrac = Math.max(this.minFrac, this.maxFrac); },
  "getMinimumFractionDigits()I": function (this: JNumberFormat) { return this.minFrac; },
  "getMaximumFractionDigits()I": function (this: JNumberFormat) { return this.maxFrac; },
  "setGroupingUsed(Z)V": function (this: JNumberFormat, g: number) { this.grouping = !!g; },
  "setRoundingMode(Ljava/math/RoundingMode;)V": () => {},
  "setMinimumIntegerDigits(I)V": () => {},
  "setParseIntegerOnly(Z)V": () => {},
};
class JDecimalFormat extends JNumberFormat {}
const nfInstance = (locale = defaultLocale) => {
  rt.link("java/text/DecimalFormat");
  return Object.assign(new JDecimalFormat(), { locale: localeTag(locale) });
};
const percentInstance = (locale = defaultLocale) => Object.assign(nfInstance(locale), { style: "percent", maxFrac: 0 });
rt.register({
  name: "java/text/NumberFormat", ctor: JNumberFormat, sup: "java/text/Format", ifaces: ["java/lang/Cloneable"],
  methods: {
    ...nfMethods,
    "static getInstance()Ljava/text/NumberFormat;": nfInstance,
    "static getInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": nfInstance,
    "static getNumberInstance()Ljava/text/NumberFormat;": nfInstance,
    "static getNumberInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": nfInstance,
    "static getIntegerInstance()Ljava/text/NumberFormat;": () => { const f = nfInstance(); f.maxFrac = 0; return f; },
    "static getPercentInstance()Ljava/text/NumberFormat;": percentInstance,
    "static getPercentInstance(Ljava/util/Locale;)Ljava/text/NumberFormat;": percentInstance,
    "static getCurrencyInstance()Ljava/text/NumberFormat;": nfInstance,
  },
});
class JIcuNumberFormat extends JNumberFormat {}
const icuPercent = (locale: JLocale = defaultLocale) => Object.assign(new JIcuNumberFormat(), { locale: localeTag(locale), style: "percent", maxFrac: 0 });
rt.register({ name: "android/icu/text/UFormat", ctor: class extends JObj {}, sup: "java/text/Format" });
rt.register({
  name: "android/icu/text/NumberFormat", ctor: JIcuNumberFormat, sup: "android/icu/text/UFormat",
  methods: {
    ...nfMethods,
    "static getPercentInstance()Landroid/icu/text/NumberFormat;": icuPercent,
    "static getPercentInstance(Ljava/util/Locale;)Landroid/icu/text/NumberFormat;": icuPercent,
  },
});
rt.register({
  name: "java/text/DecimalFormat", ctor: JDecimalFormat, sup: "java/text/NumberFormat",
  methods: {
    ...nfMethods,
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: JNumberFormat, p: string) {
      this.pattern = p;
      this.grouping = p.includes(",");
      const frac = /\.([0#]+)/.exec(p);
      this.maxFrac = frac ? frac[1].length : 0;
      this.minFrac = frac ? (frac[1].match(/0/g)?.length ?? 0) : 0;
    },
    "<init>(Ljava/lang/String;Ljava/text/DecimalFormatSymbols;)V": function (this: JNumberFormat, p: string) {
      this.pattern = p;
      const frac = /\.([0#]+)/.exec(p);
      this.maxFrac = frac ? frac[1].length : 0;
    },
    "applyPattern(Ljava/lang/String;)V": function (this: JNumberFormat, p: string) { this.pattern = p; },
    "setDecimalFormatSymbols(Ljava/text/DecimalFormatSymbols;)V": () => {},
  },
});
rt.register({
  name: "java/text/DecimalFormatSymbols", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/util/Locale;)V": function () {},
    "static getInstance()Ljava/text/DecimalFormatSymbols;": () => rt.make("java/text/DecimalFormatSymbols"),
    "static getInstance(Ljava/util/Locale;)Ljava/text/DecimalFormatSymbols;": () => rt.make("java/text/DecimalFormatSymbols"),
    "setDecimalSeparator(C)V": () => {},
    "getDecimalSeparator()C": () => 46,
    "getGroupingSeparator()C": () => 44,
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
    "equals(Ljava/lang/Object;)Z": function (this: JStringCharIter, o: JStringCharIter) {
      return o instanceof JStringCharIter && o.text === this.text && o.begin === this.begin && o.end === this.end && o.pos === this.pos ? 1 : 0;
    },
    "clone()Ljava/lang/Object;": function (this: JStringCharIter) {
      const c = new JStringCharIter(); c.text = this.text; c.begin = this.begin; c.end = this.end; c.pos = this.pos; return c;
    },
  },
});

// ── java.text.BreakIterator (line/word/char boundaries; whitespace-based approximation)
class JBreakIter extends JObj {
  text = "";
  pos = 0;
  kind: "line" | "word" | "char" | "sentence" = "line";
  bounds(): number[] {
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
    const n = dir > 0 ? bs.find((b) => b > off) : bs.reverse().find((b) => b < off);
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
    "setText(Ljava/lang/String;)V": function (this: JBreakIter, t: string) { this.text = t ?? ""; this.pos = 0; },
    "setText(Ljava/text/CharacterIterator;)V": async function (this: JBreakIter, ci: JObj) {
      let s = "";
      if (ci) {
        for (let c = await vcall(ci, "first", "()C"); c !== CHAR_ITER_DONE; c = await vcall(ci, "next", "()C")) {
          s += String.fromCharCode(c);
        }
      }
      this.text = s; this.pos = 0;
    },
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
const normalize = (cs: unknown, form: JSimpleEnum | null) => String(cs ?? "").normalize((form?.ename as "NFC") ?? "NFC");
rt.register({
  name: "java/text/Normalizer", ctor: class extends JObj {},
  methods: {
    "static normalize(Ljava/lang/CharSequence;Ljava/text/Normalizer$Form;)Ljava/lang/String;": normalize,
    "static isNormalized(Ljava/lang/CharSequence;Ljava/text/Normalizer$Form;)Z":
      (cs: unknown, form: JSimpleEnum | null) => (String(cs ?? "") === normalize(cs, form) ? 1 : 0),
  },
});

class JStringTokenizer extends JObj { toks: string[] = []; i = 0; }
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
    "hasMoreTokens()Z": function (this: JStringTokenizer) { return this.i < this.toks.length ? 1 : 0; },
    "hasMoreElements()Z": function (this: JStringTokenizer) { return this.i < this.toks.length ? 1 : 0; },
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
    "iterator()Ljava/util/Iterator;": async function (this: JServiceLoader) {
      return mkIter(await serviceInstances(this.svcName));
    },
  },
});
