// java.time.format and WeekFields over jtime-pattern's engine: DateTimeFormatter, its builder
// and parse result, and the locale-derived DecimalStyle and week rules.

import { rt, JObj, driven, type Gen } from "../runtime";
import { mkEnumSet, vcall, type JSimpleEnum, after } from "./jlang";
import { csText } from "./jchars";
import { defaultLocale, type JLocale } from "./jvalues";
import { T, TT, FIELD, ACCESSOR, JParsed, type JZoneId, camel, describe, npe, iae, isField, floorMod, dateText, timeText } from "./jtime-iso";
import {
  type Tok, JDateTimeFormatter, SIGN, OFFSET_ID, ISO_DEFS, TEXT_STYLES, val, compilePattern, fmtOf, fmtToks, dtfFormat, dtfParse, parseError,
  isoFormatter, localizedPattern, weekInfo, tagOf,
} from "./jtime-pattern";
import { accessorMethods, lazyStatics, dows, isoChronology } from "./jtime-temporal";

mkEnumSet(T + "format/TextStyle", ["FULL", "FULL_STANDALONE", "SHORT", "SHORT_STANDALONE", "NARROW", "NARROW_STANDALONE"]);
mkEnumSet(T + "format/SignStyle", ["NORMAL", "ALWAYS", "NEVER", "NOT_NEGATIVE", "EXCEEDS_PAD"]);
mkEnumSet(T + "format/ResolverStyle", ["STRICT", "SMART", "LENIENT"]);
mkEnumSet(T + "format/FormatStyle", ["FULL", "LONG", "MEDIUM", "SHORT"]);

// ASCII digits are all this runtime offers
class JDecimalStyle extends JObj {}
const decimalStyle = new JDecimalStyle();
rt.register({
  name: T + "format/DecimalStyle", ctor: JDecimalStyle,
  statics: { STANDARD: decimalStyle },
  methods: {
    [`static of(Ljava/util/Locale;)L${T}format/DecimalStyle;`]: () => decimalStyle,
    [`static ofDefaultLocale()L${T}format/DecimalStyle;`]: () => decimalStyle,
    "getZeroDigit()C": () => 48, "getPositiveSign()C": () => 43, "getNegativeSign()C": () => 45, "getDecimalSeparator()C": () => 46,
  },
});
class JWeekFields extends JObj { first = 1; minDays = 1; }
const weekFieldsOf = (first: number, minDays: number) => Object.assign(new JWeekFields(), { first, minDays });
rt.register({
  name: TT + "WeekFields", ctor: JWeekFields, ifaces: ["java/io/Serializable"],
  statics: lazyStatics({ ISO: () => weekFieldsOf(1, 4), SUNDAY_START: () => weekFieldsOf(7, 1) }),
  methods: {
    [`static of(Ljava/util/Locale;)L${TT}WeekFields;`]: (l: JLocale) => weekFieldsOf(...weekInfo(tagOf(l ?? npe("locale")))),
    [`static of(L${T}DayOfWeek;I)L${TT}WeekFields;`]: (d: JSimpleEnum, min: number) => weekFieldsOf(d.ord + 1, min),
    [`getFirstDayOfWeek()L${T}DayOfWeek;`]: function (this: JWeekFields) { return dows[this.first - 1]; },
    "getMinimalDaysInFirstWeek()I": function (this: JWeekFields) { return this.minDays; },
    "equals(Ljava/lang/Object;)Z": function (this: JWeekFields, o: unknown) { return +(o instanceof JWeekFields && o.first === this.first && o.minDays === this.minDays); },
    "hashCode()I": function (this: JWeekFields) { return this.first * 7 + this.minDays; },
  },
});

const DTF = `L${T}format/DateTimeFormatter;`;
const fmtCopy = (f: JDateTimeFormatter, patch: Partial<JDateTimeFormatter>) => Object.assign(Object.assign(new JDateTimeFormatter(), f), patch);
const localized = (d: JSimpleEnum | null, t: JSimpleEnum | null) => {
  if (!d && !t) npe("style");
  const f = fmtOf([], `Localized(${d?.ename ?? ""},${t?.ename ?? ""})`);
  f.styles = [d?.ename ?? null, t?.ename ?? null];
  return f;
};
const ofPattern = (p: string, locale: JLocale | null) => Object.assign(fmtOf(compilePattern(p ?? npe("pattern"), false), p), { locale });
rt.register({
  name: T + "format/DateTimeFormatter", ctor: JDateTimeFormatter,
  statics: lazyStatics(Object.fromEntries(Object.keys(ISO_DEFS).filter((n) => !n.startsWith("YEAR")).map((n) => [n, () => isoFormatter(n)]))),
  methods: {
    [`static ofPattern(Ljava/lang/String;)${DTF}`]: (p: string) => ofPattern(p, null),
    [`static ofPattern(Ljava/lang/String;Ljava/util/Locale;)${DTF}`]: ofPattern,
    [`static ofLocalizedDate(L${T}format/FormatStyle;)${DTF}`]: (s: JSimpleEnum) => localized(s ?? npe("dateStyle"), null),
    [`static ofLocalizedTime(L${T}format/FormatStyle;)${DTF}`]: (s: JSimpleEnum) => localized(null, s ?? npe("timeStyle")),
    [`static ofLocalizedDateTime(L${T}format/FormatStyle;)${DTF}`]: (s: JSimpleEnum) => localized(s ?? npe("dateTimeStyle"), s),
    [`static ofLocalizedDateTime(L${T}format/FormatStyle;L${T}format/FormatStyle;)${DTF}`]: (d: JSimpleEnum, t: JSimpleEnum) => localized(d ?? npe("dateStyle"), t ?? npe("timeStyle")),
    [`withZone(L${T}ZoneId;)${DTF}`]: function (this: JDateTimeFormatter, zone: JZoneId | null) { return fmtCopy(this, { zone }); },
    [`withLocale(Ljava/util/Locale;)${DTF}`]: function (this: JDateTimeFormatter, locale: JLocale) { return fmtCopy(this, { locale: locale ?? npe("locale") }); },
    [`withDecimalStyle(L${T}format/DecimalStyle;)${DTF}`]: function (this: JDateTimeFormatter) { return this; },
    [`withChronology(L${T}chrono/Chronology;)${DTF}`]: function (this: JDateTimeFormatter) { return this; },
    [`withResolverStyle(L${T}format/ResolverStyle;)${DTF}`]: function (this: JDateTimeFormatter, resolver: unknown) { return fmtCopy(this, { resolver }); },
    [`getResolverStyle()L${T}format/ResolverStyle;`]: function (this: JDateTimeFormatter) { return this.resolver ?? rt.link(T + "format/ResolverStyle").ctor.s$SMART; },
    [`getZone()L${T}ZoneId;`]: function (this: JDateTimeFormatter) { return this.zone; },
    "getLocale()Ljava/util/Locale;": function (this: JDateTimeFormatter) { return this.locale ?? defaultLocale; },
    [`getDecimalStyle()L${T}format/DecimalStyle;`]: () => decimalStyle,
    [`getChronology()L${T}chrono/Chronology;`]: () => isoChronology,
    [`format(${ACCESSOR})Ljava/lang/String;`]: function (this: JDateTimeFormatter, t: unknown) { return dtfFormat(this, t); },
    [`formatTo(${ACCESSOR}Ljava/lang/Appendable;)V`]: function (this: JDateTimeFormatter, t: unknown, a: unknown) {
      return after(vcall(a, "append", "(Ljava/lang/CharSequence;)Ljava/lang/Appendable;", dtfFormat(this, t)), () => undefined);
    },
    [`parse(Ljava/lang/CharSequence;)${ACCESSOR}`]: function (this: JDateTimeFormatter, s: unknown) { return dtfParse(this, s, (p) => p); },
    [`parse(Ljava/lang/CharSequence;L${TT}TemporalQuery;)Ljava/lang/Object;`]: function (this: JDateTimeFormatter, s: unknown, q: unknown) {
      if (q == null) npe("query");
      return after(dtfParse(this, s, (p) => p), (p) => vcall(q, "queryFrom", `(${ACCESSOR})Ljava/lang/Object;`, p));
    },
    [`parseBest(Ljava/lang/CharSequence;[L${TT}TemporalQuery;)${ACCESSOR}`]: driven(function* (this: JDateTimeFormatter, s: unknown, queries: unknown[]): Gen {
      if (!queries || queries.length < 2) iae("At least two queries must be specified");
      const parsed: JParsed = yield dtfParse(this, s, (p) => p);
      for (const q of queries) {
        try { return yield vcall(q, "queryFrom", `(${ACCESSOR})Ljava/lang/Object;`, parsed); }
        catch (e) { if (!rt.iof(e, "java/lang/RuntimeException")) throw e; }
      }
      throw parseError(`Text '${yield csText(s)}' could not be parsed: Unable to convert parsed text using any of the specified queries`);
    }),
    "toString()Ljava/lang/String;": function (this: JDateTimeFormatter) { return this.text; },
  },
});
rt.register({
  name: T + "format/Parsed", ctor: JParsed, ifaces: [ACCESSOR.slice(1, -1)],
  methods: {
    ...accessorMethods,
    "toString()Ljava/lang/String;": function (this: JParsed) {
      const p = this.p, fields = [...(p.more ?? [])].map(([k, v]) => `${camel(k)}=${v}`).join(", ");
      return `{${fields}},ISO${p.zone ? "," + p.zone.id : ""}${p.date || p.time ? " resolved to " + [p.date && dateText(p.date), p.time && timeText(p.time)].filter(Boolean).join("T") : ""}`;
    },
  },
});

class JDtfBuilder extends JObj { stack: Tok[][] = [[]]; defaults: [string, number][] = []; }
const top = (b: JDtfBuilder) => b.stack[b.stack.length - 1];
const fieldArg = (f: unknown): string => (isField(f) ? f.ename : f == null ? npe("field") : iae(`Unsupported field: ${describe(f)}`));
const OFFSET_TYPES = ["+HH", "+HHmm", "+HH:mm", "+HHMM", "+HH:MM", "+HHMMss", "+HH:MM:ss", "+HHMMSS", "+HH:MM:SS"];
const B = `L${T}format/DateTimeFormatterBuilder;`;
const push = (sig: string, make: (...a: any[]) => Tok | Tok[]) => ({
  [sig + B]: function (this: JDtfBuilder, ...a: unknown[]) { top(this).push(...([] as Tok[]).concat(make(...a))); return this; },
});
const built = (b: JDtfBuilder, locale: JLocale | null) =>
  Object.assign(fmtOf(b.stack[0].slice(), "DateTimeFormatterBuilder"), { defaults: b.defaults.slice() }, locale ? { locale } : {});
rt.register({
  name: T + "format/DateTimeFormatterBuilder", ctor: JDtfBuilder,
  methods: {
    "<init>()V": function () {},
    ...push("appendPattern(Ljava/lang/String;)", (p: string) => compilePattern(p, false)),
    ...push("appendLiteral(C)", (c: number) => ({ k: "lit", s: String.fromCharCode(c) })),
    ...push("appendLiteral(Ljava/lang/String;)", (s: string) => ({ k: "lit", s })),
    ...push(`appendValue(${FIELD})`, (f: unknown) => val(fieldArg(f), 1)),
    ...push(`appendValue(${FIELD}I)`, (f: unknown, w: number) => val(fieldArg(f), w, w, SIGN.NOT_NEGATIVE)),
    ...push(`appendValue(${FIELD}IIL${T}format/SignStyle;)`, (f: unknown, min: number, max: number, s: JSimpleEnum) => val(fieldArg(f), min, max, s.ord)),
    ...push(`appendValueReduced(${FIELD}III)`, (f: unknown, w: number, max: number, base: number) => ({ ...val(fieldArg(f), w, max), base: base - floorMod(base, 100) }) as Tok),
    ...push(`appendFraction(${FIELD}IIZ)`, (f: unknown, min: number, max: number, dot: number) =>
      fieldArg(f) === "NANO_OF_SECOND" ? { k: "frac", min, max, dot: !!dot } : iae("Field must be NanoOfSecond for fraction printing")),
    ...push(`appendText(${FIELD})`, (f: unknown) => ({ k: "text", f: fieldArg(f), style: "long" })),
    ...push(`appendText(${FIELD}L${T}format/TextStyle;)`, (f: unknown, s: JSimpleEnum) => ({ k: "text", f: fieldArg(f), style: TEXT_STYLES[s.ord] })),
    ...push("appendOffset(Ljava/lang/String;Ljava/lang/String;)", (p: string, none: string) => {
      const type = OFFSET_TYPES.indexOf(p);
      return type < 0 ? iae(`Invalid zone offset pattern: ${p}`) : { k: "off", type, none };
    }),
    ...push("appendOffsetId()", () => OFFSET_ID),
    ...push(`appendLocalizedOffset(L${T}format/TextStyle;)`, (s: JSimpleEnum) => ({ k: "loff", full: s.ord < 2 })),
    ...push("appendZoneId()", () => ({ k: "zid", region: false })),
    ...push("appendZoneOrOffsetId()", () => ({ k: "zid", region: false })),
    ...push("appendZoneRegionId()", () => ({ k: "zid", region: true })),
    ...push(`appendZoneText(L${T}format/TextStyle;)`, (s: JSimpleEnum) => ({ k: "zname", full: s.ord < 2 })),
    ...push("appendInstant()", () => ({ k: "inst" })),
    ...push(`append(${DTF})`, (f: JDateTimeFormatter) => fmtToks(f)),
    ...push(`appendOptional(${DTF})`, (f: JDateTimeFormatter) => ({ k: "opt", toks: fmtToks(f) })),
    ...push("parseCaseInsensitive()", () => ({ k: "ci", on: true })),
    ...push("parseCaseSensitive()", () => ({ k: "ci", on: false })),
    ...push("parseLenient()", () => []),
    ...push("parseStrict()", () => []),
    [`optionalStart()${B}`]: function (this: JDtfBuilder) { const t: Tok = { k: "opt", toks: [] }; top(this).push(t); this.stack.push(t.toks); return this; },
    [`optionalEnd()${B}`]: function (this: JDtfBuilder) {
      if (this.stack.length === 1) throw rt.mkThrowable("java/lang/IllegalStateException", "Cannot call optionalEnd() as there was no previous call to optionalStart()");
      this.stack.pop();
      return this;
    },
    [`parseDefaulting(${FIELD}J)${B}`]: function (this: JDtfBuilder, f: unknown, v: bigint) { this.defaults.push([fieldArg(f), Number(v)]); return this; },
    [`toFormatter()${DTF}`]: function (this: JDtfBuilder) { return built(this, null); },
    [`toFormatter(Ljava/util/Locale;)${DTF}`]: function (this: JDtfBuilder, l: JLocale) { return built(this, l); },
    [`static getLocalizedDateTimePattern(L${T}format/FormatStyle;L${T}format/FormatStyle;L${T}chrono/Chronology;Ljava/util/Locale;)Ljava/lang/String;`]:
      (d: JSimpleEnum | null, t: JSimpleEnum | null, _c: unknown, l: JLocale) => {
        if (!d && !t) iae("Either dateStyle or timeStyle must be non-null");
        return localizedPattern(d?.ename ?? null, t?.ename ?? null, tagOf(l ?? npe("locale")));
      },
  },
});
