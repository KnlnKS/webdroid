// java.time's Temporal surface: the accessor/adjuster/arithmetic methods every value class shares,
// generated per kind from jtime-iso's model, then the value classes, zones and clocks themselves.

import { rt, JObj } from "../runtime";
import { mkEnumSet, vcall, type JSimpleEnum, after, stringHash } from "./jlang";
import { newStringSet } from "./jutil";
import type { JLocale } from "./jvalues";
import {
  type Methods, type Parts, T, TT, TEMPORAL, UNIT, FIELD, AMOUNT, ADJUSTER, ACCESSOR, U, UNIT_NANOS, UNIT_SECONDS, FIELD_RANGE, FIELD_NAMES,
  FIELD_ORD, LONG_FIELDS, MONTHS, DAYS, CUM_DAYS, JLocalDate, JLocalTime, JLocalDateTime, JInstant, JZoneId, JZoneOffset, JOffsetBased,
  JOffsetDateTime, JZonedDateTime, JOffsetTime, JYearMonth, JYear, JMonthDay, JDuration, JPeriod, JClock, isTimeField, isDateField, camel,
  check, noField, noUnit, unsupported, dtErr, npe, iae, isChrono, isField, isUnit, floorDiv, floorMod, pad, isLeap, monthLen, dayOfYear,
  dayOfWeek, mkDate, dateOf, dateClamped, ofYearDay, epochDay, dateFromEpochDay, datePlus, dateWith, dateCmp, dateUntil, mkTime,
  timeOf, nanoOfDay, secOfDay, timeOfSod, timeOfNod, timePlus, timeWith, truncNod, untilNanos, carried, mkLdt, localEpoch, ldtOfEpoch,
  ldtPlus, ldtCmp, mkInstant, instantOfMs, instantMs, offsetOf, offsetHMS, parseOffsetId, zoneOf, sysZone, offsetAt, standardOffset,
  mkOdt, mkZdt, epochSec, odtOfEpoch, zdtOfEpoch, zdtLocal, mkOffsetTime, ymOf, yearOf, monthDayOf, clockIn, clockInstant, withClock,
  nowIn, mkDuration, periodBetween, parts, fieldOf, cannot, toLocalDate, toLocalTime, toLdt, toInstant, toOffset, toZone, toZdt, toOdt,
  toOffsetTime, toYearMonth, longHash, rotl, dateText, timeText, ldtText, instantText, dateHash, ldtHash, durationSteps, periodSteps,
} from "./jtime-iso";
import { type JDateTimeFormatter, dtfFormat, dtfParse, isoFormatter, displayNames, zoneName, tagOf, TEXT_STYLES } from "./jtime-pattern";

// ── the Temporal surface, generated per kind
interface Kind<V> {
  cls: string;
  unitOk(u: number): boolean;
  plus(t: V, n: number, u: number): V;
  with(t: V, f: string, v: number): V;
  from(t: unknown): V;
  until?(t: V, end: V, u: number): bigint;
  trunc?(t: V, u: number): V;
  date?(t: V): JLocalDate;
  time?(t: V): JLocalTime;
}
/** what an adjuster sets: the fields a java.time value replaces when used as a TemporalAdjuster */
function adjusterFields(a: unknown): [string, number][] | null {
  if (a instanceof JLocalDate) return [["EPOCH_DAY", epochDay(a)]];
  if (a instanceof JLocalTime) return [["NANO_OF_DAY", nanoOfDay(a)]];
  if (a instanceof JLocalDateTime) return [["EPOCH_DAY", epochDay(a.date)], ["NANO_OF_DAY", nanoOfDay(a.time)]];
  if (a instanceof JOffsetDateTime) return [["EPOCH_DAY", epochDay(a.ldt.date)], ["NANO_OF_DAY", nanoOfDay(a.ldt.time)], ["OFFSET_SECONDS", a.off.totalSeconds]];
  if (a instanceof JOffsetTime) return [["NANO_OF_DAY", nanoOfDay(a.time)], ["OFFSET_SECONDS", a.off.totalSeconds]];
  if (a instanceof JInstant) return [["INSTANT_SECONDS", a.s], ["NANO_OF_SECOND", a.ns]];
  if (a instanceof JZoneOffset) return [["OFFSET_SECONDS", a.totalSeconds]];
  if (a instanceof JYearMonth) return [["PROLEPTIC_MONTH", a.y * 12 + a.mo - 1]];
  if (a instanceof JYear) return [["YEAR", a.y]];
  if (isChrono(a, T + "DayOfWeek")) return [["DAY_OF_WEEK", a.ord + 1]];
  if (isChrono(a, T + "Month")) return [["MONTH_OF_YEAR", a.ord + 1]];
  return null;
}
/** a java.time adjuster applied to any Temporal, one with(field, value) at a time */
function adjustInto(adjuster: unknown, target: unknown): unknown {
  let r: unknown = target;
  for (const [f, v] of adjusterFields(adjuster)!) {
    r = after(r, (t) => vcall(t, "with", `(${FIELD}J)${TEMPORAL}`, chronoFields[FIELD_ORD[f]], BigInt(v)));
  }
  return r;
}
const adjustIntoMethod = { [`adjustInto(${TEMPORAL})${TEMPORAL}`]: function (this: unknown, t: unknown) { return adjustInto(this, t); } };
function range(p: Parts, f: string): JValueRange {
  if (fieldOf(p, f) === undefined) noField(f);
  const d = p.date;
  if (d && f === "DAY_OF_MONTH") return valueRange(1, monthLen(d.y, d.mo));
  if (d && f === "DAY_OF_YEAR") return valueRange(1, isLeap(d.y) ? 366 : 365);
  if (d && f === "ALIGNED_WEEK_OF_MONTH") return valueRange(1, d.mo === 2 && !isLeap(d.y) ? 4 : 5);
  if (d && f === "YEAR_OF_ERA") return valueRange(1, d.y <= 0 ? 1e9 : 999999999);
  return valueRange(...FIELD_RANGE[f]);
}
/** TemporalAccessor: get/getLong/isSupported/range/query for anything parts() understands */
export const accessorMethods: Methods = {
  [`isSupported(${FIELD})Z`]: function (this: unknown, f: unknown) {
    return isField(f) ? +(fieldOf(parts(this), f.ename) !== undefined) : f == null ? 0 : vcall(f, "isSupportedBy", `(${ACCESSOR})Z`, this);
  },
  [`getLong(${FIELD})J`]: function (this: unknown, f: unknown) {
    if (!isField(f)) return f == null ? npe("field") : vcall(f, "getFrom", `(${ACCESSOR})J`, this);
    return BigInt(fieldOf(parts(this), f.ename) ?? noField(f.ename));
  },
  [`get(${FIELD})I`]: function (this: unknown, f: unknown) {
    if (!isField(f)) return f == null ? npe("field") : after(vcall(f, "getFrom", `(${ACCESSOR})J`, this), Number);
    const v = fieldOf(parts(this), f.ename) ?? noField(f.ename);
    if (LONG_FIELDS.has(f.ename)) unsupported(`Invalid field '${camel(f.ename)}' for get() method, use getLong() instead`);
    return v;
  },
  [`range(${FIELD})L${TT}ValueRange;`]: function (this: unknown, f: unknown) {
    return isField(f) ? range(parts(this), f.ename) : vcall(f, "rangeRefinedBy", `(${ACCESSOR})L${TT}ValueRange;`, this);
  },
  [`query(L${TT}TemporalQuery;)Ljava/lang/Object;`]: function (this: unknown, q: unknown) {
    return q == null ? npe("query") : vcall(q, "queryFrom", `(${ACCESSOR})Ljava/lang/Object;`, this);
  },
};
const DATE_GETTERS: [string, (d: JLocalDate) => unknown][] = [
  ["getYear()I", (d) => d.y], ["getMonthValue()I", (d) => d.mo], ["getDayOfMonth()I", (d) => d.d], ["getDayOfYear()I", dayOfYear],
  [`getMonth()L${T}Month;`, (d) => months[d.mo - 1]], [`getDayOfWeek()L${T}DayOfWeek;`, (d) => dows[dayOfWeek(d) - 1]],
];
const TIME_GETTERS: [string, (t: JLocalTime) => number][] = [["getHour()I", (t) => t.h], ["getMinute()I", (t) => t.mi], ["getSecond()I", (t) => t.s], ["getNano()I", (t) => t.ns]];
const WITHERS: [string, string][] = [["Year", "YEAR"], ["Month", "MONTH_OF_YEAR"], ["DayOfMonth", "DAY_OF_MONTH"], ["DayOfYear", "DAY_OF_YEAR"],
  ["Hour", "HOUR_OF_DAY"], ["Minute", "MINUTE_OF_HOUR"], ["Second", "SECOND_OF_MINUTE"], ["Nano", "NANO_OF_SECOND"]];
const PLUS_UNITS: [string, number][] = [["Years", U.YEARS], ["Months", U.MONTHS], ["Weeks", U.WEEKS], ["Days", U.DAYS],
  ["Hours", U.HOURS], ["Minutes", U.MINUTES], ["Seconds", U.SECONDS], ["Millis", U.MILLIS], ["Nanos", U.NANOS]];
function plusUnit<V>(k: Kind<V>, t: V, n: number, u: unknown): unknown {
  if (!isUnit(u)) return u == null ? npe("unit") : vcall(u, "addTo", `(${TEMPORAL}J)${TEMPORAL}`, t, BigInt(n));
  return k.unitOk(u.ord) ? k.plus(t, n, u.ord) : noUnit(u);
}
function plusAmount<V>(k: Kind<V>, t: V, a: unknown, sign: number): unknown {
  const steps = a instanceof JDuration ? durationSteps(a) : a instanceof JPeriod ? periodSteps(a) : null;
  if (steps) {
    let r = t;
    for (const [n, u] of steps) if (n) r = plusUnit(k, r, sign * n, chronoUnits[u]) as V;
    return r;
  }
  if (a == null) npe("amount");
  return vcall(a, sign > 0 ? "addTo" : "subtractFrom", `(${TEMPORAL})${TEMPORAL}`, t);
}
/** get/with/plus/minus/until/truncatedTo/ordering for one kind; `extraRet` are the covariant
 *  return types Java's bridge methods answer to (Temporal, ChronoLocalDate, ...) */
function temporalMethods<V extends JObj>(k: Kind<V>, extraRet: string[], cmp: (a: V, b: V) => number, cmpDesc: string,
  isCmp: (a: V, b: V) => number = cmp): Methods {
  const self = `L${k.cls};`;
  const m: Methods = {
    ...accessorMethods,
    [`plus(J${UNIT})${self}`]: function (this: V, n: bigint, u: unknown) { return plusUnit(k, this, Number(n), u); },
    [`minus(J${UNIT})${self}`]: function (this: V, n: bigint, u: unknown) { return plusUnit(k, this, -Number(n), u); },
    [`plus(${AMOUNT})${self}`]: function (this: V, a: unknown) { return plusAmount(k, this, a, 1); },
    [`minus(${AMOUNT})${self}`]: function (this: V, a: unknown) { return plusAmount(k, this, a, -1); },
    [`with(${FIELD}J)${self}`]: function (this: V, f: unknown, v: bigint) {
      return isField(f) ? k.with(this, f.ename, Number(v)) : f == null ? npe("field") : vcall(f, "adjustInto", `(${TEMPORAL}J)${TEMPORAL}`, this, v);
    },
    [`with(${ADJUSTER})${self}`]: function (this: V, a: unknown) {
      const fields = adjusterFields(a);
      if (!fields) return a == null ? npe("adjuster") : vcall(a, "adjustInto", `(${TEMPORAL})${TEMPORAL}`, this);
      let r = this;
      for (const [f, v] of fields) r = k.with(r, f, v);
      return r;
    },
    [`isSupported(${UNIT})Z`]: function (this: V, u: unknown) { return isUnit(u) ? +k.unitOk(u.ord) : u == null ? 0 : vcall(u, "isSupportedBy", `(${TEMPORAL})Z`, this); },
    [`format(L${T}format/DateTimeFormatter;)Ljava/lang/String;`]: function (this: V, f: JDateTimeFormatter) { return dtfFormat(f, this); },
    ...ordering(cmpDesc, cmp, isCmp),
    [`compareTo(${self})I`]: function (this: V, o: V) { return Math.sign(cmp(this, o)); },
  };
  if (k.until) m[`until(${TEMPORAL}${UNIT})J`] = function (this: V, end: unknown, u: unknown) {
    const e = k.from(end);
    if (!isUnit(u)) return u == null ? npe("unit") : vcall(u, "between", `(${TEMPORAL}${TEMPORAL})J`, this, e);
    return k.unitOk(u.ord) ? k.until!(this, e, u.ord) : noUnit(u);
  };
  if (k.trunc) m[`truncatedTo(${UNIT})${self}`] = function (this: V, u: unknown) { return isUnit(u) ? k.trunc!(this, u.ord) : noUnit(u as JSimpleEnum); };
  for (const [name, u] of PLUS_UNITS) if (k.unitOk(u)) {
    m[`plus${name}(J)${self}`] = function (this: V, n: bigint) { return k.plus(this, Number(n), u); };
    m[`minus${name}(J)${self}`] = function (this: V, n: bigint) { return k.plus(this, -Number(n), u); };
  }
  const date = k.date, time = k.time;
  for (const [name, f] of WITHERS) if (date && isDateField(f) || time && isTimeField(f)) m[`with${name}(I)${self}`] = function (this: V, v: number) { return k.with(this, f, v); };
  if (date) for (const [sig, get] of DATE_GETTERS) m[sig] = function (this: V) { return get(date(this)); };
  if (time) for (const [sig, get] of TIME_GETTERS) m[sig] = function (this: V) { return get(time(this)); };
  for (const key of Object.keys(m)) if (/^(plus|minus|with)\(/.test(key) && key.endsWith(self)) {
    for (const ret of [TEMPORAL, ...extraRet]) m[key.slice(0, -self.length) + ret] = m[key];
  }
  return m;
}
/** compareTo plus the isAfter/isBefore/isEqual trio; ODT and ZDT order by instant for the trio */
export function ordering<V>(desc: string, cmp: (a: V, b: V) => number, isCmp = cmp): Methods {
  const compareTo = function (this: V, o: V) { if (o == null) npe("other"); return Math.sign(cmp(this, o)); };
  return {
    "compareTo(Ljava/lang/Object;)I": compareTo,
    [`compareTo(${desc})I`]: compareTo,
    [`isAfter(${desc})Z`]: function (this: V, o: V) { return +(isCmp(this, o) > 0); },
    [`isBefore(${desc})Z`]: function (this: V, o: V) { return +(isCmp(this, o) < 0); },
    [`isEqual(${desc})Z`]: function (this: V, o: V) { return +(isCmp(this, o) === 0); },
  };
}
/** parse(CharSequence[, DateTimeFormatter]) and from(TemporalAccessor) for one kind */
function parsers<V>(cls: string, iso: string, from: (t: unknown) => V): Methods {
  const self = `L${cls};`, cs = "Ljava/lang/CharSequence;";
  return {
    [`static parse(${cs})${self}`]: (s: unknown) => dtfParse(isoFormatter(iso), s, from),
    [`static parse(${cs}L${T}format/DateTimeFormatter;)${self}`]: (s: unknown, f: JDateTimeFormatter) => dtfParse(f ?? npe("formatter"), s, from),
    [`static from(${ACCESSOR})${self}`]: from,
  };
}
const nowMethods = <V>(cls: string, of: (z: JZonedDateTime) => V): Methods => ({
  [`static now()L${cls};`]: () => of(nowIn(sysZone())),
  [`static now(L${T}ZoneId;)L${cls};`]: (z: JZoneId) => of(nowIn(z)),
  [`static now(L${T}Clock;)L${cls};`]: (c: unknown) => withClock(c, (i, z) => of(zdtOfEpoch(i.s, i.ns, z))),
});
/** statics built on first read, once their classes are linked */
export const lazyStatics = (values: Record<string, () => unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, make] of Object.entries(values)) Object.defineProperty(out, name, { get: make, enumerable: true });
  return out;
};

// ── enums and interfaces
const dowNames = [...DAYS.slice(1), DAYS[0]].map((d) => d.toUpperCase());
export const dows: JSimpleEnum[] = mkEnumSet(T + "DayOfWeek", dowNames, {
  "getValue()I": function (this: JSimpleEnum) { return this.ord + 1; },
  [`static of(I)L${T}DayOfWeek;`]: (v: number) => (v >= 1 && v <= 7 ? dows[v - 1] : dtErr(`Invalid value for DayOfWeek: ${v}`)),
  [`static from(${ACCESSOR})L${T}DayOfWeek;`]: (t: unknown) => dows[(fieldOf(parts(t), "DAY_OF_WEEK") ?? cannot("DayOfWeek", t)) - 1],
  [`plus(J)L${T}DayOfWeek;`]: function (this: JSimpleEnum, n: bigint) { return dows[floorMod(this.ord + Number(n % 7n), 7)]; },
  [`minus(J)L${T}DayOfWeek;`]: function (this: JSimpleEnum, n: bigint) { return dows[floorMod(this.ord - Number(n % 7n), 7)]; },
  [`getDisplayName(L${T}format/TextStyle;Ljava/util/Locale;)Ljava/lang/String;`]: function (this: JSimpleEnum, s: JSimpleEnum, l: JLocale) {
    return displayNames(tagOf(l), "weekday", TEXT_STYLES[s.ord])[this.ord];
  },
  ...accessorMethods, ...adjustIntoMethod,
}, [ACCESSOR.slice(1, -1), ADJUSTER.slice(1, -1)]);
const months: JSimpleEnum[] = mkEnumSet(T + "Month", MONTHS.map((m) => m.toUpperCase()), {
  "getValue()I": function (this: JSimpleEnum) { return this.ord + 1; },
  [`static of(I)L${T}Month;`]: (v: number) => (v >= 1 && v <= 12 ? months[v - 1] : dtErr(`Invalid value for MonthOfYear: ${v}`)),
  [`static from(${ACCESSOR})L${T}Month;`]: (t: unknown) => months[(fieldOf(parts(t), "MONTH_OF_YEAR") ?? cannot("Month", t)) - 1],
  [`plus(J)L${T}Month;`]: function (this: JSimpleEnum, n: bigint) { return months[floorMod(this.ord + Number(n % 12n), 12)]; },
  [`minus(J)L${T}Month;`]: function (this: JSimpleEnum, n: bigint) { return months[floorMod(this.ord - Number(n % 12n), 12)]; },
  "length(Z)I": function (this: JSimpleEnum, leap: number) { return monthLen(leap ? 2000 : 2001, this.ord + 1); },
  "minLength()I": function (this: JSimpleEnum) { return monthLen(2001, this.ord + 1); },
  "maxLength()I": function (this: JSimpleEnum) { return monthLen(2000, this.ord + 1); },
  "firstDayOfYear(Z)I": function (this: JSimpleEnum, leap: number) { return CUM_DAYS[this.ord] + 1 + (leap && this.ord > 1 ? 1 : 0); },
  [`firstMonthOfQuarter()L${T}Month;`]: function (this: JSimpleEnum) { return months[this.ord - this.ord % 3]; },
  [`getDisplayName(L${T}format/TextStyle;Ljava/util/Locale;)Ljava/lang/String;`]: function (this: JSimpleEnum, s: JSimpleEnum, l: JLocale) {
    return displayNames(tagOf(l), "month", TEXT_STYLES[s.ord])[this.ord];
  },
  ...accessorMethods, ...adjustIntoMethod,
}, [ACCESSOR.slice(1, -1), ADJUSTER.slice(1, -1)]);
// the interface defaults an app's own TemporalAccessor inherits
rt.register({ name: TT + "TemporalAccessor", ctor: class extends JObj {}, methods: {
  [`get(${FIELD})I`]: function (this: unknown, f: unknown) { return after(vcall(this, "getLong", `(${FIELD})J`, f), Number); },
  [`range(${FIELD})L${TT}ValueRange;`]: function (this: unknown, f: unknown) {
    return isField(f) ? valueRange(...FIELD_RANGE[f.ename]) : vcall(f, "rangeRefinedBy", `(${ACCESSOR})L${TT}ValueRange;`, this);
  },
  [`query(L${TT}TemporalQuery;)Ljava/lang/Object;`]: function (this: unknown, q: unknown) { return vcall(q, "queryFrom", `(${ACCESSOR})Ljava/lang/Object;`, this); },
} });
rt.register({ name: TT + "Temporal", ctor: class extends JObj {}, ifaces: [ACCESSOR.slice(1, -1)] });
rt.markers(TT + "TemporalAmount", TT + "TemporalUnit", TT + "TemporalField", TT + "TemporalQuery", TT + "TemporalAdjuster");
const CHRONO_DATE = `L${T}chrono/ChronoLocalDate;`, CHRONO_LDT = `L${T}chrono/ChronoLocalDateTime;`, CHRONO_ZDT = `L${T}chrono/ChronoZonedDateTime;`;
for (const c of [CHRONO_DATE, CHRONO_LDT, CHRONO_ZDT]) {
  rt.register({ name: c.slice(1, -1), ctor: class extends JObj {}, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable"] });
}
/** what the ISO value classes outside the chrono hierarchy implement */
const VALUE_IFACES = [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"];

const chronoFields: JSimpleEnum[] = mkEnumSet(TT + "ChronoField", FIELD_NAMES, {
  "toString()Ljava/lang/String;": function (this: JSimpleEnum) { return camel(this.ename); },
  "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": function (this: JSimpleEnum) { return camel(this.ename); },
  "isDateBased()Z": function (this: JSimpleEnum) { return +isDateField(this.ename); },
  "isTimeBased()Z": function (this: JSimpleEnum) { return +isTimeField(this.ename); },
  [`range()L${TT}ValueRange;`]: function (this: JSimpleEnum) { return valueRange(...FIELD_RANGE[this.ename]); },
  "checkValidValue(J)J": function (this: JSimpleEnum, v: bigint) { check(this.ename, Number(v)); return v; },
  "checkValidIntValue(J)I": function (this: JSimpleEnum, v: bigint) { return check(this.ename, Number(v)); },
  [`getFrom(${ACCESSOR})J`]: function (this: JSimpleEnum, t: unknown) { return vcall(t, "getLong", `(${FIELD})J`, this); },
  [`isSupportedBy(${ACCESSOR})Z`]: function (this: JSimpleEnum, t: unknown) { return vcall(t, "isSupported", `(${FIELD})Z`, this); },
  [`adjustInto(${TEMPORAL}J)${TEMPORAL}`]: function (this: JSimpleEnum, t: unknown, v: bigint) { return vcall(t, "with", `(${FIELD}J)${TEMPORAL}`, this, v); },
}, [FIELD.slice(1, -1)]);
export const chronoUnits: JSimpleEnum[] = mkEnumSet(TT + "ChronoUnit", Object.keys(U), {
  [`getDuration()L${T}Duration;`]: function (this: JSimpleEnum) {
    return this.ord < U.SECONDS ? mkDuration(0, UNIT_NANOS[this.ord]) : mkDuration(UNIT_SECONDS[this.ord], this.ord === U.FOREVER ? 999999999 : 0);
  },
  "isDurationEstimated()Z": function (this: JSimpleEnum) { return +(this.ord >= U.DAYS); },
  "isDateBased()Z": function (this: JSimpleEnum) { return +(this.ord >= U.DAYS && this.ord < U.FOREVER); },
  "isTimeBased()Z": function (this: JSimpleEnum) { return +(this.ord < U.DAYS); },
  "toString()Ljava/lang/String;": function (this: JSimpleEnum) { return camel(this.ename); },
  [`between(${TEMPORAL}${TEMPORAL})J`]: function (this: JSimpleEnum, a: unknown, b: unknown) { return vcall(a, "until", `(${TEMPORAL}${UNIT})J`, b, this); },
  [`addTo(${TEMPORAL}J)${TEMPORAL}`]: function (this: JSimpleEnum, t: unknown, n: bigint) { return vcall(t, "plus", `(J${UNIT})${TEMPORAL}`, n, this); },
  [`isSupportedBy(${TEMPORAL})Z`]: function (this: JSimpleEnum, t: unknown) { return vcall(t, "isSupported", `(${UNIT})Z`, this); },
}, [UNIT.slice(1, -1)]);

class JValueRange extends JObj { min = 0; max = 0; }
const valueRange = (min: number, max: number) => Object.assign(new JValueRange(), { min, max });
const checkedValue = (r: JValueRange, v: bigint, f: JSimpleEnum | null) => {
  const n = Number(v);
  return n >= r.min && n <= r.max ? n : dtErr(`Invalid value for ${f ? camel(f.ename) : "value"} (valid values ${r.min} - ${r.max}): ${n}`);
};
rt.register({
  name: TT + "ValueRange", ctor: JValueRange, ifaces: ["java/io/Serializable"],
  methods: {
    [`static of(JJ)L${TT}ValueRange;`]: (a: bigint, b: bigint) => (a > b ? iae("Minimum value must be less than maximum value") : valueRange(Number(a), Number(b))),
    "getMinimum()J": function (this: JValueRange) { return BigInt(this.min); },
    "getLargestMinimum()J": function (this: JValueRange) { return BigInt(this.min); },
    "getMaximum()J": function (this: JValueRange) { return BigInt(this.max); },
    "getSmallestMaximum()J": function (this: JValueRange) { return BigInt(this.max); },
    "isValidValue(J)Z": function (this: JValueRange, v: bigint) { return +(Number(v) >= this.min && Number(v) <= this.max); },
    "isValidIntValue(J)Z": function (this: JValueRange, v: bigint) { return +(this.min >= -(2 ** 31) && this.max < 2 ** 31 && Number(v) >= this.min && Number(v) <= this.max); },
    "isIntValue()Z": function (this: JValueRange) { return +(this.min >= -(2 ** 31) && this.max < 2 ** 31); },
    "isFixed()Z": () => 1,
    [`checkValidIntValue(J${FIELD})I`]: function (this: JValueRange, v: bigint, f: JSimpleEnum) { return checkedValue(this, v, f); },
    [`checkValidValue(J${FIELD})J`]: function (this: JValueRange, v: bigint, f: JSimpleEnum) { checkedValue(this, v, f); return v; },
    "toString()Ljava/lang/String;": function (this: JValueRange) { return `${this.min} - ${this.max}`; },
  },
});

// ── kinds
const DATE_KIND: Kind<JLocalDate> = {
  cls: T + "LocalDate", unitOk: (u) => u >= U.DAYS && u < U.FOREVER,
  plus: datePlus, with: dateWith, until: dateUntil, from: toLocalDate, date: (d) => d,
};
const TIME_KIND: Kind<JLocalTime> = {
  cls: T + "LocalTime", unitOk: (u) => u < U.DAYS,
  plus: timePlus, with: timeWith, from: toLocalTime, time: (t) => t,
  until: (t, e, u) => untilNanos(0, nanoOfDay(e) - nanoOfDay(t), u),
  trunc: (t, u) => (u === U.NANOS ? t : timeOfNod(truncNod(nanoOfDay(t), u))),
};
const LDT_KIND: Kind<JLocalDateTime> = {
  cls: T + "LocalDateTime", unitOk: (u) => u < U.FOREVER, from: toLdt, date: (l) => l.date, time: (l) => l.time,
  plus: ldtPlus,
  with: (l, f, v) => (isTimeField(f) ? mkLdt(l.date, timeWith(l.time, f, v)) : mkLdt(dateWith(l.date, f, v), l.time)),
  until(l, e, u) {
    if (u < U.DAYS) return untilNanos(localEpoch(e) - localEpoch(l), e.time.ns - l.time.ns, u);
    let end = e.date;
    const dt = nanoOfDay(e.time) - nanoOfDay(l.time), dd = dateCmp(end, l.date);
    if (dd > 0 && dt < 0) end = datePlus(end, -1, U.DAYS);
    else if (dd < 0 && dt > 0) end = datePlus(end, 1, U.DAYS);
    return dateUntil(l.date, end, u);
  },
  trunc: (l, u) => mkLdt(l.date, TIME_KIND.trunc!(l.time, u)),
};
const sameOffset = (o: JOffsetDateTime, off: JZoneOffset) => (o.off === off ? o : odtOfEpoch(epochSec(o), o.ldt.time.ns, off));
const ODT_KIND: Kind<JOffsetDateTime> = {
  cls: T + "OffsetDateTime", unitOk: (u) => u < U.FOREVER, from: toOdt, date: (o) => o.ldt.date, time: (o) => o.ldt.time,
  plus: (o, n, u) => mkOdt(ldtPlus(o.ldt, n, u), o.off),
  with: (o, f, v) => (f === "INSTANT_SECONDS" ? odtOfEpoch(v, o.ldt.time.ns, o.off) : f === "OFFSET_SECONDS" ? mkOdt(o.ldt, offsetOf(v)) : mkOdt(LDT_KIND.with(o.ldt, f, v), o.off)),
  until: (o, e, u) => LDT_KIND.until!(o.ldt, sameOffset(e, o.off).ldt, u),
  trunc: (o, u) => mkOdt(LDT_KIND.trunc!(o.ldt, u), o.off),
};
const ZDT_KIND: Kind<JZonedDateTime> = {
  cls: T + "ZonedDateTime", unitOk: (u) => u < U.FOREVER, from: toZdt, date: (z) => z.ldt.date, time: (z) => z.ldt.time,
  plus(z, n, u) {
    const l = ldtPlus(z.ldt, n, u);
    return u >= U.DAYS ? zdtLocal(l, z.zone, z.off) : zdtOfEpoch(localEpoch(l) - z.off.totalSeconds, l.time.ns, z.zone);
  },
  with(z, f, v) {
    if (f === "INSTANT_SECONDS") return zdtOfEpoch(v, z.ldt.time.ns, z.zone);
    if (f === "OFFSET_SECONDS") return offsetAt(z.zone, localEpoch(z.ldt) - check(f, v)) === v ? mkZdt(z.ldt, offsetOf(v), z.zone) : z;
    return zdtLocal(LDT_KIND.with(z.ldt, f, v), z.zone, z.off);
  },
  until(z, e, u) {
    const end = e.zone === z.zone ? e : zdtOfEpoch(epochSec(e), e.ldt.time.ns, z.zone);
    return u >= U.DAYS ? LDT_KIND.until!(z.ldt, end.ldt, u) : untilNanos(epochSec(end) - epochSec(z), end.ldt.time.ns - z.ldt.time.ns, u);
  },
  trunc: (z, u) => zdtLocal(LDT_KIND.trunc!(z.ldt, u), z.zone, z.off),
};
const INSTANT_KIND: Kind<JInstant> = {
  cls: T + "Instant", unitOk: (u) => u <= U.DAYS, from: toInstant,
  plus: (i, n, u) => carried(i.s, i.ns, n, u, mkInstant),
  with(i, f, v) {
    switch (f) {
      case "NANO_OF_SECOND": return mkInstant(i.s, check(f, v));
      case "MICRO_OF_SECOND": return mkInstant(i.s, check(f, v) * 1e3);
      case "MILLI_OF_SECOND": return mkInstant(i.s, check(f, v) * 1e6);
      case "INSTANT_SECONDS": return mkInstant(v, i.ns);
    }
    return noField(f);
  },
  until: (i, e, u) => untilNanos(e.s - i.s, e.ns - i.ns, u),
  trunc(i, u) {
    if (u === U.NANOS) return i;
    const day = floorDiv(i.s, 86400), n = truncNod((i.s - day * 86400) * 1e9 + i.ns, u);
    return mkInstant(day * 86400 + floorDiv(n, 1e9), n % 1e9);
  },
};
const OFFSET_TIME_KIND: Kind<JOffsetTime> = {
  cls: T + "OffsetTime", unitOk: (u) => u < U.DAYS, from: toOffsetTime, time: (o) => o.time,
  plus: (o, n, u) => mkOffsetTime(timePlus(o.time, n, u), o.off),
  with: (o, f, v) => (f === "OFFSET_SECONDS" ? mkOffsetTime(o.time, offsetOf(check(f, v))) : mkOffsetTime(timeWith(o.time, f, v), o.off)),
  trunc: (o, u) => mkOffsetTime(TIME_KIND.trunc!(o.time, u), o.off),
};
const ymDate = (m: JYearMonth) => mkDate(m.y, m.mo, 1);
const YM_KIND: Kind<JYearMonth> = {
  cls: T + "YearMonth", unitOk: (u) => u >= U.MONTHS && u < U.FOREVER, from: toYearMonth,
  plus: (m, n, u) => { const d = datePlus(ymDate(m), n, u); return ymOf(d.y, d.mo); },
  with: (m, f, v) => {
    if (!["MONTH_OF_YEAR", "PROLEPTIC_MONTH", "YEAR_OF_ERA", "YEAR", "ERA"].includes(f)) noField(f);
    const d = dateWith(ymDate(m), f, v);
    return ymOf(d.y, d.mo);
  },
  until: (m, e, u) => dateUntil(ymDate(m), ymDate(e), u),
};

// ── the value classes
class JIsoChronology extends JObj {}
export const isoChronology = new JIsoChronology();
const instantCmp = (a: JOffsetBased, b: JOffsetBased) => epochSec(a) - epochSec(b) || a.ldt.time.ns - b.ldt.time.ns;
rt.register({
  name: T + "LocalDate", ctor: JLocalDate, ifaces: [CHRONO_DATE.slice(1, -1), "java/io/Serializable"],
  statics: lazyStatics({ MIN: () => mkDate(-999999999, 1, 1), MAX: () => mkDate(999999999, 12, 31), EPOCH: () => mkDate(1970, 1, 1) }),
  methods: {
    ...temporalMethods(DATE_KIND, [CHRONO_DATE], dateCmp, CHRONO_DATE),
    ...nowMethods(T + "LocalDate", (z) => z.ldt.date),
    ...parsers(T + "LocalDate", "ISO_LOCAL_DATE", toLocalDate),
    [`static of(III)L${T}LocalDate;`]: dateOf,
    [`static of(IL${T}Month;I)L${T}LocalDate;`]: (y: number, m: JSimpleEnum, d: number) => dateOf(y, (m ?? npe("month")).ord + 1, d),
    [`static ofYearDay(II)L${T}LocalDate;`]: ofYearDay,
    [`static ofEpochDay(J)L${T}LocalDate;`]: (d: bigint) => dateFromEpochDay(check("EPOCH_DAY", Number(d))),
    [`static ofInstant(L${T}Instant;L${T}ZoneId;)L${T}LocalDate;`]: (i: JInstant, z: JZoneId) => zdtOfEpoch((i ?? npe("instant")).s, 0, z ?? npe("zone")).ldt.date,
    "isLeapYear()Z": function (this: JLocalDate) { return +isLeap(this.y); },
    "lengthOfMonth()I": function (this: JLocalDate) { return monthLen(this.y, this.mo); },
    "lengthOfYear()I": function (this: JLocalDate) { return isLeap(this.y) ? 366 : 365; },
    "toEpochDay()J": function (this: JLocalDate) { return BigInt(epochDay(this)); },
    [`toEpochSecond(L${T}LocalTime;L${T}ZoneOffset;)J`]: function (this: JLocalDate, t: JLocalTime, o: JZoneOffset) {
      return BigInt(localEpoch(mkLdt(this, t)) - o.totalSeconds);
    },
    [`atStartOfDay()L${T}LocalDateTime;`]: function (this: JLocalDate) { return mkLdt(this, mkTime(0, 0)); },
    [`atStartOfDay(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JLocalDate, z: JZoneId) { return zdtLocal(mkLdt(this, mkTime(0, 0)), z ?? npe("zone")); },
    [`atTime(L${T}LocalTime;)L${T}LocalDateTime;`]: function (this: JLocalDate, t: JLocalTime) { return mkLdt(this, t ?? npe("time")); },
    [`atTime(L${T}LocalTime;)${CHRONO_LDT}`]: function (this: JLocalDate, t: JLocalTime) { return mkLdt(this, t ?? npe("time")); },
    [`atTime(II)L${T}LocalDateTime;`]: function (this: JLocalDate, h: number, m: number) { return mkLdt(this, timeOf(h, m)); },
    [`atTime(III)L${T}LocalDateTime;`]: function (this: JLocalDate, h: number, m: number, s: number) { return mkLdt(this, timeOf(h, m, s)); },
    [`atTime(IIII)L${T}LocalDateTime;`]: function (this: JLocalDate, h: number, m: number, s: number, n: number) { return mkLdt(this, timeOf(h, m, s, n)); },
    [`atTime(L${T}OffsetTime;)L${T}OffsetDateTime;`]: function (this: JLocalDate, t: JOffsetTime) { return mkOdt(mkLdt(this, t.time), t.off); },
    [`until(${CHRONO_DATE})L${T}Period;`]: function (this: JLocalDate, e: JLocalDate) { return periodBetween(this, toLocalDate(e)); },
    [`getChronology()L${T}chrono/IsoChronology;`]: () => isoChronology,
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JLocalDate, o: unknown) { return +(o instanceof JLocalDate && dateCmp(this, o) === 0); },
    "hashCode()I": function (this: JLocalDate) { return dateHash(this); },
    "toString()Ljava/lang/String;": function (this: JLocalDate) { return dateText(this); },
  },
});
rt.register({
  name: T + "LocalTime", ctor: JLocalTime, ifaces: VALUE_IFACES,
  statics: lazyStatics({ MIN: () => mkTime(0, 0), MIDNIGHT: () => mkTime(0, 0), NOON: () => mkTime(12, 0), MAX: () => mkTime(23, 59, 59, 999999999) }),
  methods: {
    ...temporalMethods(TIME_KIND, [], (a, b) => nanoOfDay(a) - nanoOfDay(b), `L${T}LocalTime;`),
    ...nowMethods(T + "LocalTime", (z) => z.ldt.time),
    ...parsers(T + "LocalTime", "ISO_LOCAL_TIME", toLocalTime),
    [`static of(II)L${T}LocalTime;`]: (h: number, m: number) => timeOf(h, m),
    [`static of(III)L${T}LocalTime;`]: (h: number, m: number, s: number) => timeOf(h, m, s),
    [`static of(IIII)L${T}LocalTime;`]: timeOf,
    [`static ofSecondOfDay(J)L${T}LocalTime;`]: (s: bigint) => timeOfSod(check("SECOND_OF_DAY", Number(s)), 0),
    [`static ofNanoOfDay(J)L${T}LocalTime;`]: (n: bigint) => timeOfNod(Number(n)),
    [`static ofInstant(L${T}Instant;L${T}ZoneId;)L${T}LocalTime;`]: (i: JInstant, z: JZoneId) => zdtOfEpoch(i.s, i.ns, z).ldt.time,
    "toSecondOfDay()I": function (this: JLocalTime) { return secOfDay(this); },
    "toNanoOfDay()J": function (this: JLocalTime) { return BigInt(secOfDay(this)) * 1000000000n + BigInt(this.ns); },
    [`toEpochSecond(L${T}LocalDate;L${T}ZoneOffset;)J`]: function (this: JLocalTime, d: JLocalDate, o: JZoneOffset) {
      return BigInt(localEpoch(mkLdt(d, this)) - o.totalSeconds);
    },
    [`atDate(L${T}LocalDate;)L${T}LocalDateTime;`]: function (this: JLocalTime, d: JLocalDate) { return mkLdt(d ?? npe("date"), this); },
    [`atOffset(L${T}ZoneOffset;)L${T}OffsetTime;`]: function (this: JLocalTime, o: JZoneOffset) { return mkOffsetTime(this, o ?? npe("offset")); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JLocalTime, o: unknown) { return +(o instanceof JLocalTime && nanoOfDay(o) === nanoOfDay(this)); },
    "hashCode()I": function (this: JLocalTime) { return longHash(nanoOfDay(this)); },
    "toString()Ljava/lang/String;": function (this: JLocalTime) { return timeText(this); },
  },
});
const ldtOf = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ns = 0) => mkLdt(dateOf(y, mo, d), timeOf(h, mi, s, ns));
const monthArg = (m: JSimpleEnum) => (m ?? npe("month")).ord + 1;
rt.register({
  name: T + "LocalDateTime", ctor: JLocalDateTime, ifaces: [CHRONO_LDT.slice(1, -1), "java/io/Serializable"],
  statics: lazyStatics({ MIN: () => mkLdt(mkDate(-999999999, 1, 1), mkTime(0, 0)), MAX: () => mkLdt(mkDate(999999999, 12, 31), mkTime(23, 59, 59, 999999999)) }),
  methods: {
    ...temporalMethods(LDT_KIND, [CHRONO_LDT], ldtCmp, CHRONO_LDT),
    ...nowMethods(T + "LocalDateTime", (z) => z.ldt),
    ...parsers(T + "LocalDateTime", "ISO_LOCAL_DATE_TIME", toLdt),
    [`static of(IIIII)L${T}LocalDateTime;`]: ldtOf,
    [`static of(IIIIII)L${T}LocalDateTime;`]: ldtOf,
    [`static of(IIIIIII)L${T}LocalDateTime;`]: ldtOf,
    [`static of(IL${T}Month;III)L${T}LocalDateTime;`]: (y: number, m: JSimpleEnum, d: number, h: number, mi: number) => ldtOf(y, monthArg(m), d, h, mi),
    [`static of(IL${T}Month;IIII)L${T}LocalDateTime;`]: (y: number, m: JSimpleEnum, d: number, h: number, mi: number, s: number) => ldtOf(y, monthArg(m), d, h, mi, s),
    [`static of(IL${T}Month;IIIII)L${T}LocalDateTime;`]: (y: number, m: JSimpleEnum, d: number, h: number, mi: number, s: number, n: number) => ldtOf(y, monthArg(m), d, h, mi, s, n),
    [`static of(L${T}LocalDate;L${T}LocalTime;)L${T}LocalDateTime;`]: (d: JLocalDate, t: JLocalTime) => mkLdt(d ?? npe("date"), t ?? npe("time")),
    [`static ofInstant(L${T}Instant;L${T}ZoneId;)L${T}LocalDateTime;`]: (i: JInstant, z: JZoneId) => zdtOfEpoch((i ?? npe("instant")).s, i.ns, z ?? npe("zone")).ldt,
    [`static ofEpochSecond(JIL${T}ZoneOffset;)L${T}LocalDateTime;`]: (s: bigint, ns: number, o: JZoneOffset) => ldtOfEpoch(Number(s) + (o ?? npe("offset")).totalSeconds, check("NANO_OF_SECOND", ns)),
    [`toLocalDate()L${T}LocalDate;`]: function (this: JLocalDateTime) { return this.date; },
    [`toLocalDate()${CHRONO_DATE}`]: function (this: JLocalDateTime) { return this.date; },
    [`toLocalTime()L${T}LocalTime;`]: function (this: JLocalDateTime) { return this.time; },
    [`atZone(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JLocalDateTime, z: JZoneId) { return zdtLocal(this, z ?? npe("zone")); },
    [`atZone(L${T}ZoneId;)${CHRONO_ZDT}`]: function (this: JLocalDateTime, z: JZoneId) { return zdtLocal(this, z ?? npe("zone")); },
    [`atOffset(L${T}ZoneOffset;)L${T}OffsetDateTime;`]: function (this: JLocalDateTime, o: JZoneOffset) { return mkOdt(this, o ?? npe("offset")); },
    [`toInstant(L${T}ZoneOffset;)L${T}Instant;`]: function (this: JLocalDateTime, o: JZoneOffset) { return mkInstant(localEpoch(this) - o.totalSeconds, this.time.ns); },
    [`toEpochSecond(L${T}ZoneOffset;)J`]: function (this: JLocalDateTime, o: JZoneOffset) { return BigInt(localEpoch(this) - o.totalSeconds); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JLocalDateTime, o: unknown) { return +(o instanceof JLocalDateTime && ldtCmp(this, o) === 0); },
    "hashCode()I": function (this: JLocalDateTime) { return ldtHash(this); },
    "toString()Ljava/lang/String;": function (this: JLocalDateTime) { return ldtText(this); },
  },
});
const offsetBasedMethods: Methods = {
  [`getOffset()L${T}ZoneOffset;`]: function (this: JOffsetBased) { return this.off; },
  [`toLocalDateTime()L${T}LocalDateTime;`]: function (this: JOffsetBased) { return this.ldt; },
  [`toLocalDate()L${T}LocalDate;`]: function (this: JOffsetBased) { return this.ldt.date; },
  [`toLocalTime()L${T}LocalTime;`]: function (this: JOffsetBased) { return this.ldt.time; },
  [`toInstant()L${T}Instant;`]: function (this: JOffsetBased) { return mkInstant(epochSec(this), this.ldt.time.ns); },
  "toEpochSecond()J": function (this: JOffsetBased) { return BigInt(epochSec(this)); },
};
rt.register({
  name: T + "OffsetDateTime", ctor: JOffsetDateTime, ifaces: VALUE_IFACES,
  methods: {
    ...temporalMethods(ODT_KIND, [], (a, b) => (a.off === b.off ? ldtCmp(a.ldt, b.ldt) : instantCmp(a, b) || ldtCmp(a.ldt, b.ldt)), `L${T}OffsetDateTime;`, instantCmp),
    ...offsetBasedMethods,
    ...nowMethods(T + "OffsetDateTime", (z) => mkOdt(z.ldt, z.off)),
    ...parsers(T + "OffsetDateTime", "ISO_OFFSET_DATE_TIME", toOdt),
    [`static of(L${T}LocalDateTime;L${T}ZoneOffset;)L${T}OffsetDateTime;`]: (l: JLocalDateTime, o: JZoneOffset) => mkOdt(l ?? npe("dateTime"), o ?? npe("offset")),
    [`static of(L${T}LocalDate;L${T}LocalTime;L${T}ZoneOffset;)L${T}OffsetDateTime;`]: (d: JLocalDate, t: JLocalTime, o: JZoneOffset) => mkOdt(mkLdt(d, t), o ?? npe("offset")),
    [`static of(IIIIIIIL${T}ZoneOffset;)L${T}OffsetDateTime;`]: (y: number, mo: number, d: number, h: number, mi: number, s: number, ns: number, o: JZoneOffset) =>
      mkOdt(ldtOf(y, mo, d, h, mi, s, ns), o ?? npe("offset")),
    [`static ofInstant(L${T}Instant;L${T}ZoneId;)L${T}OffsetDateTime;`]: (i: JInstant, z: JZoneId) => {
      const zdt = zdtOfEpoch((i ?? npe("instant")).s, i.ns, z ?? npe("zone"));
      return mkOdt(zdt.ldt, zdt.off);
    },
    [`withOffsetSameInstant(L${T}ZoneOffset;)L${T}OffsetDateTime;`]: function (this: JOffsetDateTime, o: JZoneOffset) { return sameOffset(this, o ?? npe("offset")); },
    [`withOffsetSameLocal(L${T}ZoneOffset;)L${T}OffsetDateTime;`]: function (this: JOffsetDateTime, o: JZoneOffset) { return mkOdt(this.ldt, o ?? npe("offset")); },
    [`toZonedDateTime()L${T}ZonedDateTime;`]: function (this: JOffsetDateTime) { return mkZdt(this.ldt, this.off, this.off); },
    [`atZoneSameInstant(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JOffsetDateTime, z: JZoneId) { return zdtOfEpoch(epochSec(this), this.ldt.time.ns, z); },
    [`atZoneSimilarLocal(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JOffsetDateTime, z: JZoneId) { return zdtLocal(this.ldt, z, this.off); },
    [`toOffsetTime()L${T}OffsetTime;`]: function (this: JOffsetDateTime) { return mkOffsetTime(this.ldt.time, this.off); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JOffsetDateTime, o: unknown) { return +(o instanceof JOffsetDateTime && o.off === this.off && ldtCmp(o.ldt, this.ldt) === 0); },
    "hashCode()I": function (this: JOffsetDateTime) { return ldtHash(this.ldt) ^ this.off.totalSeconds; },
    "toString()Ljava/lang/String;": function (this: JOffsetDateTime) { return ldtText(this.ldt) + this.off.id; },
  },
});
const zoneHash = (z: JZoneId) => (z instanceof JZoneOffset ? z.totalSeconds : stringHash(z.id));
const zdtCmp = (a: JZonedDateTime, b: JZonedDateTime) => instantCmp(a, b) || ldtCmp(a.ldt, b.ldt) || (a.zone.id < b.zone.id ? -1 : a.zone.id > b.zone.id ? 1 : 0);
rt.register({
  name: T + "ZonedDateTime", ctor: JZonedDateTime, ifaces: [CHRONO_ZDT.slice(1, -1), "java/io/Serializable"],
  methods: {
    ...temporalMethods(ZDT_KIND, [CHRONO_ZDT], zdtCmp, CHRONO_ZDT, instantCmp),
    ...offsetBasedMethods,
    [`toLocalDateTime()${CHRONO_LDT}`]: function (this: JZonedDateTime) { return this.ldt; },
    [`toLocalDate()${CHRONO_DATE}`]: function (this: JZonedDateTime) { return this.ldt.date; },
    ...nowMethods(T + "ZonedDateTime", (z) => z),
    ...parsers(T + "ZonedDateTime", "ISO_ZONED_DATE_TIME", toZdt),
    [`static of(L${T}LocalDateTime;L${T}ZoneId;)L${T}ZonedDateTime;`]: (l: JLocalDateTime, z: JZoneId) => zdtLocal(l ?? npe("localDateTime"), z ?? npe("zone")),
    [`static of(L${T}LocalDate;L${T}LocalTime;L${T}ZoneId;)L${T}ZonedDateTime;`]: (d: JLocalDate, t: JLocalTime, z: JZoneId) => zdtLocal(mkLdt(d, t), z ?? npe("zone")),
    [`static of(IIIIIIIL${T}ZoneId;)L${T}ZonedDateTime;`]: (y: number, mo: number, d: number, h: number, mi: number, s: number, ns: number, z: JZoneId) =>
      zdtLocal(ldtOf(y, mo, d, h, mi, s, ns), z ?? npe("zone")),
    [`static ofLocal(L${T}LocalDateTime;L${T}ZoneId;L${T}ZoneOffset;)L${T}ZonedDateTime;`]: (l: JLocalDateTime, z: JZoneId, o: JZoneOffset | null) => zdtLocal(l ?? npe("localDateTime"), z ?? npe("zone"), o ?? undefined),
    [`static ofInstant(L${T}Instant;L${T}ZoneId;)L${T}ZonedDateTime;`]: (i: JInstant, z: JZoneId) => zdtOfEpoch((i ?? npe("instant")).s, i.ns, z ?? npe("zone")),
    [`static ofInstant(L${T}LocalDateTime;L${T}ZoneOffset;L${T}ZoneId;)L${T}ZonedDateTime;`]: (l: JLocalDateTime, o: JZoneOffset, z: JZoneId) =>
      zdtOfEpoch(localEpoch(l) - o.totalSeconds, l.time.ns, z ?? npe("zone")),
    [`getZone()L${T}ZoneId;`]: function (this: JZonedDateTime) { return this.zone; },
    [`withZoneSameInstant(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JZonedDateTime, z: JZoneId) {
      return z === this.zone ? this : zdtOfEpoch(epochSec(this), this.ldt.time.ns, z ?? npe("zone"));
    },
    [`withZoneSameLocal(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JZonedDateTime, z: JZoneId) { return zdtLocal(this.ldt, z ?? npe("zone"), this.off); },
    [`withFixedOffsetZone()L${T}ZonedDateTime;`]: function (this: JZonedDateTime) { return mkZdt(this.ldt, this.off, this.off); },
    [`withEarlierOffsetAtOverlap()L${T}ZonedDateTime;`]: function (this: JZonedDateTime) { return zdtLocal(this.ldt, this.zone); },
    [`toOffsetDateTime()L${T}OffsetDateTime;`]: function (this: JZonedDateTime) { return mkOdt(this.ldt, this.off); },
    "equals(Ljava/lang/Object;)Z": function (this: JZonedDateTime, o: unknown) {
      return +(o instanceof JZonedDateTime && o.off === this.off && o.zone.id === this.zone.id && ldtCmp(o.ldt, this.ldt) === 0);
    },
    "hashCode()I": function (this: JZonedDateTime) { return ldtHash(this.ldt) ^ this.off.totalSeconds ^ rotl(zoneHash(this.zone), 3); },
    "toString()Ljava/lang/String;": function (this: JZonedDateTime) {
      return ldtText(this.ldt) + this.off.id + (this.zone instanceof JZoneOffset ? "" : `[${this.zone.id}]`);
    },
  },
});
const otCmp = (a: JOffsetTime, b: JOffsetTime) => (nanoOfDay(a.time) - a.off.totalSeconds * 1e9) - (nanoOfDay(b.time) - b.off.totalSeconds * 1e9);
rt.register({
  name: T + "OffsetTime", ctor: JOffsetTime, ifaces: VALUE_IFACES,
  methods: {
    ...temporalMethods(OFFSET_TIME_KIND, [], (a, b) => otCmp(a, b) || nanoOfDay(a.time) - nanoOfDay(b.time), `L${T}OffsetTime;`, otCmp),
    ...nowMethods(T + "OffsetTime", (z) => mkOffsetTime(z.ldt.time, z.off)),
    ...parsers(T + "OffsetTime", "ISO_OFFSET_TIME", toOffsetTime),
    [`static of(L${T}LocalTime;L${T}ZoneOffset;)L${T}OffsetTime;`]: (t: JLocalTime, o: JZoneOffset) => mkOffsetTime(t ?? npe("time"), o ?? npe("offset")),
    [`static of(IIIIL${T}ZoneOffset;)L${T}OffsetTime;`]: (h: number, m: number, s: number, n: number, o: JZoneOffset) => mkOffsetTime(timeOf(h, m, s, n), o ?? npe("offset")),
    [`getOffset()L${T}ZoneOffset;`]: function (this: JOffsetTime) { return this.off; },
    [`toLocalTime()L${T}LocalTime;`]: function (this: JOffsetTime) { return this.time; },
    [`atDate(L${T}LocalDate;)L${T}OffsetDateTime;`]: function (this: JOffsetTime, d: JLocalDate) { return mkOdt(mkLdt(d ?? npe("date"), this.time), this.off); },
    [`withOffsetSameLocal(L${T}ZoneOffset;)L${T}OffsetTime;`]: function (this: JOffsetTime, o: JZoneOffset) { return mkOffsetTime(this.time, o ?? npe("offset")); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JOffsetTime, o: unknown) { return +(o instanceof JOffsetTime && o.off === this.off && nanoOfDay(o.time) === nanoOfDay(this.time)); },
    "hashCode()I": function (this: JOffsetTime) { return longHash(nanoOfDay(this.time)) ^ this.off.totalSeconds; },
    "toString()Ljava/lang/String;": function (this: JOffsetTime) { return timeText(this.time) + this.off.id; },
  },
});
rt.register({
  name: T + "Instant", ctor: JInstant, ifaces: VALUE_IFACES,
  statics: lazyStatics({ EPOCH: () => mkInstant(0), MIN: () => mkInstant(-31557014167219200), MAX: () => mkInstant(31556889864403199, 999999999) }),
  methods: {
    ...temporalMethods(INSTANT_KIND, [], (a, b) => a.s - b.s || a.ns - b.ns, `L${T}Instant;`),
    [`static now()L${T}Instant;`]: () => instantOfMs(Date.now()),
    [`static now(L${T}Clock;)L${T}Instant;`]: (c: unknown) => (c instanceof JClock ? clockInstant(c) : c == null ? npe("clock") : vcall(c, "instant", `()L${T}Instant;`)),
    ...parsers(T + "Instant", "ISO_INSTANT", toInstant),
    [`static ofEpochMilli(J)L${T}Instant;`]: (ms: bigint) => instantOfMs(Number(ms)),
    [`static ofEpochSecond(J)L${T}Instant;`]: (s: bigint) => mkInstant(Number(s)),
    [`static ofEpochSecond(JJ)L${T}Instant;`]: (s: bigint, ns: bigint) => carried(Number(s), 0, Number(ns), U.NANOS, mkInstant),
    "toEpochMilli()J": function (this: JInstant) { return BigInt(this.s) * 1000n + BigInt(floorDiv(this.ns, 1e6)); },
    "getEpochSecond()J": function (this: JInstant) { return BigInt(this.s); },
    "getNano()I": function (this: JInstant) { return this.ns; },
    [`atOffset(L${T}ZoneOffset;)L${T}OffsetDateTime;`]: function (this: JInstant, o: JZoneOffset) { return odtOfEpoch(this.s, this.ns, o ?? npe("offset")); },
    [`atZone(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JInstant, z: JZoneId) { return zdtOfEpoch(this.s, this.ns, z ?? npe("zone")); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JInstant, o: unknown) { return +(o instanceof JInstant && o.s === this.s && o.ns === this.ns); },
    "hashCode()I": function (this: JInstant) { return (longHash(this.s) + 51 * this.ns) | 0; },
    "toString()Ljava/lang/String;": function (this: JInstant) { return instantText(this); },
  },
});
rt.register({
  name: T + "YearMonth", ctor: JYearMonth, ifaces: VALUE_IFACES,
  methods: {
    ...temporalMethods(YM_KIND, [], (a, b) => a.y - b.y || a.mo - b.mo, `L${T}YearMonth;`),
    ...nowMethods(T + "YearMonth", (z) => ymOf(z.ldt.date.y, z.ldt.date.mo)),
    ...parsers(T + "YearMonth", "YEAR_MONTH", toYearMonth),
    [`static of(II)L${T}YearMonth;`]: ymOf,
    [`static of(IL${T}Month;)L${T}YearMonth;`]: (y: number, m: JSimpleEnum) => ymOf(y, monthArg(m)),
    "getYear()I": function (this: JYearMonth) { return this.y; },
    "getMonthValue()I": function (this: JYearMonth) { return this.mo; },
    [`getMonth()L${T}Month;`]: function (this: JYearMonth) { return months[this.mo - 1]; },
    "isLeapYear()Z": function (this: JYearMonth) { return +isLeap(this.y); },
    "lengthOfMonth()I": function (this: JYearMonth) { return monthLen(this.y, this.mo); },
    "lengthOfYear()I": function (this: JYearMonth) { return isLeap(this.y) ? 366 : 365; },
    "isValidDay(I)Z": function (this: JYearMonth, d: number) { return +(d >= 1 && d <= monthLen(this.y, this.mo)); },
    [`withYear(I)L${T}YearMonth;`]: function (this: JYearMonth, y: number) { return ymOf(y, this.mo); },
    [`withMonth(I)L${T}YearMonth;`]: function (this: JYearMonth, m: number) { return ymOf(this.y, m); },
    [`atDay(I)L${T}LocalDate;`]: function (this: JYearMonth, d: number) { return dateOf(this.y, this.mo, d); },
    [`atEndOfMonth()L${T}LocalDate;`]: function (this: JYearMonth) { return mkDate(this.y, this.mo, monthLen(this.y, this.mo)); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JYearMonth, o: unknown) { return +(o instanceof JYearMonth && o.y === this.y && o.mo === this.mo); },
    "hashCode()I": function (this: JYearMonth) { return this.y ^ (this.mo << 27); },
    "toString()Ljava/lang/String;": function (this: JYearMonth) { return `${Math.abs(this.y) < 1000 ? (this.y < 0 ? "-" : "") + pad(Math.abs(this.y), 4) : this.y}-${pad(this.mo)}`; },
  },
});
rt.register({
  name: T + "Year", ctor: JYear, ifaces: VALUE_IFACES,
  statics: { MIN_VALUE: -999999999, MAX_VALUE: 999999999 },
  methods: {
    ...accessorMethods, ...adjustIntoMethod,
    ...nowMethods(T + "Year", (z) => yearOf(z.ldt.date.y)),
    [`static of(I)L${T}Year;`]: yearOf,
    [`static from(${ACCESSOR})L${T}Year;`]: (t: unknown) => (t instanceof JYear ? t : yearOf(fieldOf(parts(t), "YEAR") ?? cannot("Year", t))),
    [`static parse(Ljava/lang/CharSequence;)L${T}Year;`]: (s: unknown) => dtfParse(isoFormatter("YEAR"), s, (t) => yearOf(fieldOf(parts(t), "YEAR") ?? cannot("Year", t))),
    "static isLeap(J)Z": (y: bigint) => +isLeap(Number(y)),
    "getValue()I": function (this: JYear) { return this.y; },
    "isLeap()Z": function (this: JYear) { return +isLeap(this.y); },
    "length()I": function (this: JYear) { return isLeap(this.y) ? 366 : 365; },
    [`plusYears(J)L${T}Year;`]: function (this: JYear, n: bigint) { return yearOf(this.y + Number(n)); },
    [`minusYears(J)L${T}Year;`]: function (this: JYear, n: bigint) { return yearOf(this.y - Number(n)); },
    [`atDay(I)L${T}LocalDate;`]: function (this: JYear, d: number) { return ofYearDay(this.y, d); },
    [`atMonth(I)L${T}YearMonth;`]: function (this: JYear, m: number) { return ymOf(this.y, m); },
    [`atMonth(L${T}Month;)L${T}YearMonth;`]: function (this: JYear, m: JSimpleEnum) { return ymOf(this.y, monthArg(m)); },
    ...ordering(`L${T}Year;`, (a: JYear, b: JYear) => a.y - b.y),
    "equals(Ljava/lang/Object;)Z": function (this: JYear, o: unknown) { return +(o instanceof JYear && o.y === this.y); },
    "hashCode()I": function (this: JYear) { return this.y; },
    "toString()Ljava/lang/String;": function (this: JYear) { return String(this.y); },
  },
});
rt.register({
  name: T + "MonthDay", ctor: JMonthDay, ifaces: [ACCESSOR.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  methods: {
    ...accessorMethods,
    ...nowMethods(T + "MonthDay", (z) => monthDayOf(z.ldt.date.mo, z.ldt.date.d)),
    [`static of(II)L${T}MonthDay;`]: monthDayOf,
    [`static of(L${T}Month;I)L${T}MonthDay;`]: (m: JSimpleEnum, d: number) => monthDayOf(monthArg(m), d),
    [`static from(${ACCESSOR})L${T}MonthDay;`]: (t: unknown) => {
      const p = parts(t), mo = fieldOf(p, "MONTH_OF_YEAR"), d = fieldOf(p, "DAY_OF_MONTH");
      return mo !== undefined && d !== undefined ? monthDayOf(mo, d) : cannot("MonthDay", t);
    },
    "getMonthValue()I": function (this: JMonthDay) { return this.mo; },
    "getDayOfMonth()I": function (this: JMonthDay) { return this.d; },
    [`getMonth()L${T}Month;`]: function (this: JMonthDay) { return months[this.mo - 1]; },
    [`atYear(I)L${T}LocalDate;`]: function (this: JMonthDay, y: number) { return dateClamped(y, this.mo, this.d); },
    "isValidYear(I)Z": function (this: JMonthDay, y: number) { return +(this.d <= monthLen(y, this.mo)); },
    [`adjustInto(${TEMPORAL})${TEMPORAL}`]: function (this: JMonthDay, t: unknown) {
      return after(vcall(t, "with", `(${FIELD}J)${TEMPORAL}`, chronoFields[FIELD_ORD.MONTH_OF_YEAR], BigInt(this.mo)), (r) =>
        after(vcall(r, "range", `(${FIELD})L${TT}ValueRange;`, chronoFields[FIELD_ORD.DAY_OF_MONTH]), (rg: JValueRange) =>
          vcall(r, "with", `(${FIELD}J)${TEMPORAL}`, chronoFields[FIELD_ORD.DAY_OF_MONTH], BigInt(Math.min(this.d, rg.max)))));
    },
    ...ordering(`L${T}MonthDay;`, (a: JMonthDay, b: JMonthDay) => a.mo - b.mo || a.d - b.d),
    "equals(Ljava/lang/Object;)Z": function (this: JMonthDay, o: unknown) { return +(o instanceof JMonthDay && o.mo === this.mo && o.d === this.d); },
    "hashCode()I": function (this: JMonthDay) { return (this.mo << 6) + this.d; },
    "toString()Ljava/lang/String;": function (this: JMonthDay) { return `--${pad(this.mo)}-${pad(this.d)}`; },
  },
});

// ── zones, rules, clocks and the ISO chronology
class JZoneRules extends JObj { declare zone: JZoneId; }
const rulesOf = (z: JZoneId) => Object.assign(new JZoneRules(), { zone: z });
const zoneIdMethods: Methods = {
  "getId()Ljava/lang/String;": function (this: JZoneId) { return this.id; },
  "toString()Ljava/lang/String;": function (this: JZoneId) { return this.id; },
  [`getRules()L${T}zone/ZoneRules;`]: function (this: JZoneId) { return rulesOf(this); },
  [`normalized()L${T}ZoneId;`]: function (this: JZoneId) { return this.fixed === null ? this : offsetOf(this.fixed); },
  [`getDisplayName(L${T}format/TextStyle;Ljava/util/Locale;)Ljava/lang/String;`]: function (this: JZoneId, s: JSimpleEnum, l: JLocale) {
    return this instanceof JZoneOffset ? this.id : zoneName(this.id, s.ord < 2, Date.now(), tagOf(l));
  },
  "equals(Ljava/lang/Object;)Z": function (this: JZoneId, o: unknown) {
    return +(o instanceof JZoneId && (this instanceof JZoneOffset ? o instanceof JZoneOffset && o.totalSeconds === this.totalSeconds : !(o instanceof JZoneOffset) && o.id === this.id));
  },
  "hashCode()I": function (this: JZoneId) { return zoneHash(this); },
};
rt.register({
  name: T + "ZoneId", ctor: JZoneId, ifaces: ["java/io/Serializable"],
  statics: { SHORT_IDS: null },
  methods: {
    ...zoneIdMethods,
    [`static systemDefault()L${T}ZoneId;`]: sysZone,
    [`static of(Ljava/lang/String;)L${T}ZoneId;`]: zoneOf,
    [`static of(Ljava/lang/String;Ljava/util/Map;)L${T}ZoneId;`]: (id: string, aliases: unknown) =>
      after(aliases ? vcall(aliases, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", id) : null, (alias: string | null) => zoneOf(alias ?? id)),
    [`static ofOffset(Ljava/lang/String;L${T}ZoneOffset;)L${T}ZoneId;`]: (prefix: string, o: JZoneOffset) => (prefix ? zoneOf(prefix + (o.totalSeconds ? o.id : "")) : o),
    [`static from(${ACCESSOR})L${T}ZoneId;`]: toZone,
    "static getAvailableZoneIds()Ljava/util/Set;": () => newStringSet(Intl.supportedValuesOf("timeZone")),
  },
});
rt.register({
  name: T + "ZoneOffset", ctor: JZoneOffset, sup: T + "ZoneId", ifaces: [ACCESSOR.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable"],
  statics: lazyStatics({ UTC: () => offsetOf(0), MIN: () => offsetOf(-64800), MAX: () => offsetOf(64800) }),
  methods: {
    ...zoneIdMethods, ...accessorMethods, ...adjustIntoMethod,
    [`static of(Ljava/lang/String;)L${T}ZoneOffset;`]: (id: string) => parseOffsetId(id ?? npe("offsetId")),
    [`static ofHours(I)L${T}ZoneOffset;`]: (h: number) => offsetHMS(h, 0, 0),
    [`static ofHoursMinutes(II)L${T}ZoneOffset;`]: (h: number, m: number) => offsetHMS(h, m, 0),
    [`static ofHoursMinutesSeconds(III)L${T}ZoneOffset;`]: offsetHMS,
    [`static ofTotalSeconds(I)L${T}ZoneOffset;`]: offsetOf,
    [`static from(${ACCESSOR})L${T}ZoneOffset;`]: toOffset,
    "getTotalSeconds()I": function (this: JZoneOffset) { return this.totalSeconds; },
    ...ordering(`L${T}ZoneOffset;`, (a: JZoneOffset, b: JZoneOffset) => b.totalSeconds - a.totalSeconds),
  },
});
rt.register({
  name: T + "zone/ZoneRules", ctor: JZoneRules, ifaces: ["java/io/Serializable"],
  methods: {
    [`static of(L${T}ZoneOffset;)L${T}zone/ZoneRules;`]: (o: JZoneOffset) => rulesOf(o),
    "isFixedOffset()Z": function (this: JZoneRules) { return +(this.zone.fixed !== null); },
    [`getOffset(L${T}Instant;)L${T}ZoneOffset;`]: function (this: JZoneRules, i: JInstant) { return offsetOf(offsetAt(this.zone, (i ?? npe("instant")).s)); },
    [`getOffset(L${T}LocalDateTime;)L${T}ZoneOffset;`]: function (this: JZoneRules, l: JLocalDateTime) { return zdtLocal(l, this.zone).off; },
    [`getStandardOffset(L${T}Instant;)L${T}ZoneOffset;`]: function (this: JZoneRules, i: JInstant) { return offsetOf(standardOffset(this.zone, i.s)); },
    [`getDaylightSavings(L${T}Instant;)L${T}Duration;`]: function (this: JZoneRules, i: JInstant) { return mkDuration(offsetAt(this.zone, i.s) - standardOffset(this.zone, i.s), 0); },
    [`isDaylightSavings(L${T}Instant;)Z`]: function (this: JZoneRules, i: JInstant) { return +(offsetAt(this.zone, i.s) !== standardOffset(this.zone, i.s)); },
    [`isValidOffset(L${T}LocalDateTime;L${T}ZoneOffset;)Z`]: function (this: JZoneRules, l: JLocalDateTime, o: JZoneOffset) {
      return +(offsetAt(this.zone, localEpoch(l) - o.totalSeconds) === o.totalSeconds);
    },
    "equals(Ljava/lang/Object;)Z": function (this: JZoneRules, o: unknown) { return +(o instanceof JZoneRules && o.zone.id === this.zone.id); },
    "hashCode()I": function (this: JZoneRules) { return zoneHash(this.zone); },
    "toString()Ljava/lang/String;": function (this: JZoneRules) { return `ZoneRules[currentStandardOffset=${offsetOf(standardOffset(this.zone, floorDiv(Date.now(), 1000))).id}]`; },
  },
});
rt.register({
  name: T + "Clock", ctor: JClock,
  methods: {
    [`static systemUTC()L${T}Clock;`]: () => clockIn(offsetOf(0)),
    [`static systemDefaultZone()L${T}Clock;`]: () => clockIn(sysZone()),
    [`static system(L${T}ZoneId;)L${T}Clock;`]: (z: JZoneId) => clockIn(z ?? npe("zone")),
    [`static fixed(L${T}Instant;L${T}ZoneId;)L${T}Clock;`]: (i: JInstant, z: JZoneId) => clockIn(z ?? npe("zone"), i ?? npe("instant")),
    [`static offset(L${T}Clock;L${T}Duration;)L${T}Clock;`]: (c: JClock, d: JDuration) =>
      clockIn(c.zone, c.fixed, c.offsetMs + d.s * 1000 + floorDiv(d.ns, 1e6), c.unavailable),
    [`instant()L${T}Instant;`]: function (this: JClock) { return clockInstant(this); },
    "millis()J": function (this: JClock) { return BigInt(instantMs(clockInstant(this))); },
    [`getZone()L${T}ZoneId;`]: function (this: JClock) { return this.zone; },
    [`withZone(L${T}ZoneId;)L${T}Clock;`]: function (this: JClock, z: JZoneId) { return clockIn(z, this.fixed, this.offsetMs, this.unavailable); },
  },
});
// the ISO calendar is the only chronology this runtime offers
rt.register({
  name: T + "chrono/Chronology", ctor: class extends JObj {},
  methods: {
    [`static ofLocale(Ljava/util/Locale;)L${T}chrono/Chronology;`]: () => isoChronology,
    [`static of(Ljava/lang/String;)L${T}chrono/Chronology;`]: (id: string) => (id === "ISO" || id === "iso8601" ? isoChronology : dtErr(`Unknown chronology: ${id}`)),
  },
});
rt.register({
  name: T + "chrono/IsoChronology", ctor: JIsoChronology, ifaces: [T + "chrono/Chronology", "java/lang/Comparable", "java/io/Serializable"],
  statics: { INSTANCE: isoChronology },
  methods: {
    "getId()Ljava/lang/String;": () => "ISO",
    "getCalendarType()Ljava/lang/String;": () => "iso8601",
    "isLeapYear(J)Z": (y: bigint) => +isLeap(Number(y)),
    [`date(III)L${T}LocalDate;`]: dateOf,
    [`date(III)${CHRONO_DATE}`]: dateOf,
    [`date(${ACCESSOR})L${T}LocalDate;`]: toLocalDate,
    "toString()Ljava/lang/String;": () => "ISO",
  },
});
