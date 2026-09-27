// java.time's value model: ISO fields and units over proleptic Gregorian arithmetic, zone rules
// from Intl (the system zone from the host Date), and the Parts view every temporal reduces to.
// jtime-temporal, jtime-amount and jtime-format register the classes; jtime-pattern prints and
// parses them; jtime holds java.util's Date, Calendar and TimeZone.

import { rt, JObj, type NativeSpec } from "../runtime";
import { defineException, vcall, JSimpleEnum, after } from "./jlang";
import { dotName } from "../abi";

// ── calendar vocabulary (en); libc and procfs print these
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const NANOS_PER_DAY = 86400e9;
export const floorDiv = (a: number, b: number) => Math.floor(a / b);
export const floorMod = (a: number, b: number) => a - Math.floor(a / b) * b;
defineException("java/time/DateTimeException", "java/lang/RuntimeException");
defineException("java/time/format/DateTimeParseException", "java/time/DateTimeException");
defineException("java/time/temporal/UnsupportedTemporalTypeException", "java/time/DateTimeException");
defineException("java/time/zone/ZoneRulesException", "java/time/DateTimeException");
export const dtErr = (msg: string): never => { throw rt.mkThrowable("java/time/DateTimeException", msg); };
export const unsupported = (msg: string): never => { throw rt.mkThrowable("java/time/temporal/UnsupportedTemporalTypeException", msg); };
export const npe = (what: string): never => { throw rt.mkThrowable("java/lang/NullPointerException", what); };
export const iae = (msg: string): never => { throw rt.mkThrowable("java/lang/IllegalArgumentException", msg); };
export type Methods = NonNullable<NativeSpec["methods"]>;
export const T = "java/time/", TT = "java/time/temporal/";
export const TEMPORAL = `L${TT}Temporal;`, UNIT = `L${TT}TemporalUnit;`, FIELD = `L${TT}TemporalField;`;
export const AMOUNT = `L${TT}TemporalAmount;`, ADJUSTER = `L${TT}TemporalAdjuster;`, ACCESSOR = `L${TT}TemporalAccessor;`;

// ── fields and units. ChronoField in ordinal order: time fields first (< 15), then date fields (< 28)
export const FIELD_RANGE: Record<string, [number, number]> = {
  NANO_OF_SECOND: [0, 999999999], NANO_OF_DAY: [0, NANOS_PER_DAY - 1], MICRO_OF_SECOND: [0, 999999], MICRO_OF_DAY: [0, 86400e6 - 1],
  MILLI_OF_SECOND: [0, 999], MILLI_OF_DAY: [0, 86400e3 - 1], SECOND_OF_MINUTE: [0, 59], SECOND_OF_DAY: [0, 86399],
  MINUTE_OF_HOUR: [0, 59], MINUTE_OF_DAY: [0, 1439], HOUR_OF_AMPM: [0, 11], CLOCK_HOUR_OF_AMPM: [1, 12], HOUR_OF_DAY: [0, 23],
  CLOCK_HOUR_OF_DAY: [1, 24], AMPM_OF_DAY: [0, 1], DAY_OF_WEEK: [1, 7], ALIGNED_DAY_OF_WEEK_IN_MONTH: [1, 7],
  ALIGNED_DAY_OF_WEEK_IN_YEAR: [1, 7], DAY_OF_MONTH: [1, 31], DAY_OF_YEAR: [1, 366], EPOCH_DAY: [-365243219162, 365241780471],
  ALIGNED_WEEK_OF_MONTH: [1, 5], ALIGNED_WEEK_OF_YEAR: [1, 53], MONTH_OF_YEAR: [1, 12], PROLEPTIC_MONTH: [-11999999988, 11999999999],
  YEAR_OF_ERA: [1, 1e9], YEAR: [-999999999, 999999999], ERA: [0, 1],
  INSTANT_SECONDS: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], OFFSET_SECONDS: [-64800, 64800],
};
export const FIELD_NAMES = Object.keys(FIELD_RANGE);
export const FIELD_ORD: Record<string, number> = Object.fromEntries(FIELD_NAMES.map((f, i) => [f, i]));
export const isTimeField = (f: string) => FIELD_ORD[f] < 15;
export const isDateField = (f: string) => FIELD_ORD[f] >= 15 && FIELD_ORD[f] < 28;
/** Java's display name: HOUR_OF_AMPM → HourOfAmPm */
export const camel = (n: string) => n.split("_").map((w) => (w === "AMPM" ? "AmPm" : w[0] + w.slice(1).toLowerCase())).join("");
export function check(f: string, v: number): number {
  const [lo, hi] = FIELD_RANGE[f];
  if (!(v >= lo && v <= hi) || !Number.isInteger(v)) dtErr(`Invalid value for ${camel(f)} (valid values ${lo} - ${hi}): ${v}`);
  return v;
}
export const noField = (f: string): never => unsupported(`Unsupported field: ${camel(f)}`);
// fields whose values do not fit get()'s int
export const LONG_FIELDS = new Set(["NANO_OF_DAY", "MICRO_OF_DAY", "EPOCH_DAY", "PROLEPTIC_MONTH", "INSTANT_SECONDS"]);

export const U = { NANOS: 0, MICROS: 1, MILLIS: 2, SECONDS: 3, MINUTES: 4, HOURS: 5, HALF_DAYS: 6, DAYS: 7, WEEKS: 8, MONTHS: 9, YEARS: 10,
  DECADES: 11, CENTURIES: 12, MILLENNIA: 13, ERAS: 14, FOREVER: 15 } as const;
export const UNIT_NANOS = [1, 1e3, 1e6, 1e9, 60e9, 3600e9, 43200e9, NANOS_PER_DAY];
// Java's estimated durations of the date-based units, in seconds
export const UNIT_SECONDS = [0, 0, 0, 1, 60, 3600, 43200, 86400, 604800, 2629746, 31556952, 315569520, 3155695200, 31556952000, 31556952e9, Number.MAX_SAFE_INTEGER];
export const noUnit = (u: JSimpleEnum): never => unsupported(`Unsupported unit: ${camel(u.ename)}`);
export const isChrono = (e: unknown, cls: string): e is JSimpleEnum => e instanceof JSimpleEnum && (e.constructor as any).$i?.name === cls;
export const isField = (f: unknown): f is JSimpleEnum => isChrono(f, TT + "ChronoField");
export const isUnit = (u: unknown): u is JSimpleEnum => isChrono(u, TT + "ChronoUnit");

// ── plain values
export class JLocalDate extends JObj { y = 1970; mo = 1; d = 1; }
export class JLocalTime extends JObj { h = 0; mi = 0; s = 0; ns = 0; }
export class JLocalDateTime extends JObj { declare date: JLocalDate; declare time: JLocalTime; }
export class JInstant extends JObj { s = 0; ns = 0; }
/** fixed: the offset of a zone whose rules never change (a ZoneOffset, UTC, GMT+01:00) */
export class JZoneId extends JObj { id = "Z"; fixed: number | null = 0; }
export class JZoneOffset extends JZoneId { totalSeconds = 0; }
export class JOffsetBased extends JObj { declare ldt: JLocalDateTime; declare off: JZoneOffset; }
export class JOffsetDateTime extends JOffsetBased {}
export class JZonedDateTime extends JOffsetBased { declare zone: JZoneId; }
export class JOffsetTime extends JObj { declare time: JLocalTime; declare off: JZoneOffset; }
export class JYearMonth extends JObj { y = 0; mo = 1; }
export class JYear extends JObj { y = 0; }
export class JMonthDay extends JObj { mo = 1; d = 1; }
export class JDuration extends JObj { s = 0; ns = 0; }
export class JPeriod extends JObj { y = 0; m = 0; d = 0; }

// ── dates
export const isLeap = (y: number) => (y & 3) === 0 && (y % 100 !== 0 || y % 400 === 0);
export const monthLen = (y: number, mo: number) => (mo === 2 ? (isLeap(y) ? 29 : 28) : mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31);
export const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
export const dayOfYear = (d: JLocalDate) => CUM_DAYS[d.mo - 1] + d.d + (d.mo > 2 && isLeap(d.y) ? 1 : 0);
export function mkDate(y: number, mo: number, d: number): JLocalDate { const l = new JLocalDate(); l.y = y; l.mo = mo; l.d = d; return l; }
export function dateOf(y: number, mo: number, d: number): JLocalDate {
  check("YEAR", y); check("MONTH_OF_YEAR", mo); check("DAY_OF_MONTH", d);
  if (d > monthLen(y, mo)) dtErr(d === 29 ? `Invalid date 'February 29' as '${y}' is not a leap year` : `Invalid date '${MONTHS[mo - 1].toUpperCase()} ${d}'`);
  return mkDate(y, mo, d);
}
/** the day clamped to the month's length, as plusMonths/withYear do */
export const dateClamped = (y: number, mo: number, d: number) => mkDate(check("YEAR", y), mo, Math.min(d, monthLen(y, mo)));
export function ofYearDay(y: number, doy: number): JLocalDate {
  check("DAY_OF_YEAR", doy);
  if (doy === 366 && !isLeap(y)) dtErr(`Invalid date 'DayOfYear 366' as '${y}' is not a leap year`);
  return datePlus(mkDate(check("YEAR", y), 1, 1), doy - 1, U.DAYS);
}
export function epochDay(date: JLocalDate): number {
  const y = date.y - (date.mo <= 2 ? 1 : 0), era = Math.floor(y / 400), year = y - era * 400;
  const month = date.mo + (date.mo > 2 ? -3 : 9);
  return era * 146097 + year * 365 + Math.floor(year / 4) - Math.floor(year / 100)
    + Math.floor((153 * month + 2) / 5) + date.d - 1 - 719468;
}
export function dateFromEpochDay(day: number): JLocalDate {
  const z = day + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const year = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * year + Math.floor(year / 4) - Math.floor(year / 100));
  const mp = Math.floor((5 * doy + 2) / 153), month = mp + (mp < 10 ? 3 : -9);
  return mkDate(year + era * 400 + (month <= 2 ? 1 : 0), month, doy - Math.floor((153 * mp + 2) / 5) + 1);
}
export const dayOfWeek = (d: JLocalDate) => floorMod(epochDay(d) + 3, 7) + 1;
export function dateGet(d: JLocalDate, f: string): number | undefined {
  switch (f) {
    case "DAY_OF_WEEK": return dayOfWeek(d);
    case "ALIGNED_DAY_OF_WEEK_IN_MONTH": return (d.d - 1) % 7 + 1;
    case "ALIGNED_DAY_OF_WEEK_IN_YEAR": return (dayOfYear(d) - 1) % 7 + 1;
    case "DAY_OF_MONTH": return d.d;
    case "DAY_OF_YEAR": return dayOfYear(d);
    case "EPOCH_DAY": return epochDay(d);
    case "ALIGNED_WEEK_OF_MONTH": return floorDiv(d.d - 1, 7) + 1;
    case "ALIGNED_WEEK_OF_YEAR": return floorDiv(dayOfYear(d) - 1, 7) + 1;
    case "MONTH_OF_YEAR": return d.mo;
    case "PROLEPTIC_MONTH": return d.y * 12 + d.mo - 1;
    case "YEAR_OF_ERA": return d.y >= 1 ? d.y : 1 - d.y;
    case "YEAR": return d.y;
    case "ERA": return d.y >= 1 ? 1 : 0;
  }
  return undefined;
}
export function datePlus(d: JLocalDate, n: number, u: number): JLocalDate {
  switch (u) {
    case U.DAYS: return n ? dateFromEpochDay(epochDay(d) + n) : d;
    case U.WEEKS: return datePlus(d, n * 7, U.DAYS);
    case U.MONTHS: { const pm = d.y * 12 + d.mo - 1 + n; return dateClamped(floorDiv(pm, 12), floorMod(pm, 12) + 1, d.d); }
    case U.YEARS: return dateClamped(d.y + n, d.mo, d.d);
    case U.DECADES: return datePlus(d, n * 10, U.YEARS);
    case U.CENTURIES: return datePlus(d, n * 100, U.YEARS);
    case U.MILLENNIA: return datePlus(d, n * 1000, U.YEARS);
    default: return dateWith(d, "ERA", (d.y >= 1 ? 1 : 0) + n);
  }
}
export function dateWith(d: JLocalDate, f: string, v: number): JLocalDate {
  if (!isDateField(f)) noField(f);
  check(f, v);
  switch (f) {
    case "DAY_OF_WEEK": case "ALIGNED_DAY_OF_WEEK_IN_MONTH": case "ALIGNED_DAY_OF_WEEK_IN_YEAR": return datePlus(d, v - dateGet(d, f)!, U.DAYS);
    case "ALIGNED_WEEK_OF_MONTH": case "ALIGNED_WEEK_OF_YEAR": return datePlus(d, v - dateGet(d, f)!, U.WEEKS);
    case "DAY_OF_MONTH": return dateOf(d.y, d.mo, v);
    case "DAY_OF_YEAR": return ofYearDay(d.y, v);
    case "EPOCH_DAY": return dateFromEpochDay(v);
    case "MONTH_OF_YEAR": return dateClamped(d.y, v, d.d);
    case "PROLEPTIC_MONTH": return datePlus(d, v - (d.y * 12 + d.mo - 1), U.MONTHS);
    case "YEAR_OF_ERA": return dateClamped(d.y >= 1 ? v : 1 - v, d.mo, d.d);
    case "YEAR": return dateClamped(v, d.mo, d.d);
    default: return (d.y >= 1 ? 1 : 0) === v ? d : dateClamped(1 - d.y, d.mo, d.d);
  }
}
export const dateCmp = (a: JLocalDate, b: JLocalDate) => a.y - b.y || a.mo - b.mo || a.d - b.d;
export function dateUntil(start: JLocalDate, end: JLocalDate, u: number): bigint {
  if (u === U.DAYS) return BigInt(epochDay(end) - epochDay(start));
  if (u === U.WEEKS) return BigInt(Math.trunc((epochDay(end) - epochDay(start)) / 7));
  const months = Math.trunc(((end.y * 12 + end.mo) * 32 + end.d - ((start.y * 12 + start.mo) * 32 + start.d)) / 32);
  const per = [1, 12, 120, 1200, 12000][u - U.MONTHS];
  if (per) return BigInt(Math.trunc(months / per));
  return BigInt((end.y >= 1 ? 1 : 0) - (start.y >= 1 ? 1 : 0));
}

// ── times
export function mkTime(h: number, mi: number, s = 0, ns = 0): JLocalTime { const t = new JLocalTime(); t.h = h; t.mi = mi; t.s = s; t.ns = ns; return t; }
export const timeOf = (h: number, mi: number, s = 0, ns = 0) =>
  mkTime(check("HOUR_OF_DAY", h), check("MINUTE_OF_HOUR", mi), check("SECOND_OF_MINUTE", s), check("NANO_OF_SECOND", ns));
export const secOfDay = (t: JLocalTime) => t.h * 3600 + t.mi * 60 + t.s;
export const nanoOfDay = (t: JLocalTime) => secOfDay(t) * 1e9 + t.ns;
export const timeOfSod = (sod: number, ns: number) => mkTime(floorDiv(sod, 3600), floorDiv(sod, 60) % 60, sod % 60, ns);
export const timeOfNod = (n: number) => { const sod = floorDiv(check("NANO_OF_DAY", n), 1e9); return timeOfSod(sod, n - sod * 1e9); };
export function timeGet(t: JLocalTime, f: string): number | undefined {
  switch (f) {
    case "NANO_OF_SECOND": return t.ns;
    case "NANO_OF_DAY": return nanoOfDay(t);
    case "MICRO_OF_SECOND": return floorDiv(t.ns, 1e3);
    case "MICRO_OF_DAY": return floorDiv(nanoOfDay(t), 1e3);
    case "MILLI_OF_SECOND": return floorDiv(t.ns, 1e6);
    case "MILLI_OF_DAY": return floorDiv(nanoOfDay(t), 1e6);
    case "SECOND_OF_MINUTE": return t.s;
    case "SECOND_OF_DAY": return secOfDay(t);
    case "MINUTE_OF_HOUR": return t.mi;
    case "MINUTE_OF_DAY": return t.h * 60 + t.mi;
    case "HOUR_OF_AMPM": return t.h % 12;
    case "CLOCK_HOUR_OF_AMPM": return t.h % 12 || 12;
    case "HOUR_OF_DAY": return t.h;
    case "CLOCK_HOUR_OF_DAY": return t.h || 24;
    case "AMPM_OF_DAY": return t.h >= 12 ? 1 : 0;
  }
  return undefined;
}
export function timeWith(t: JLocalTime, f: string, v: number): JLocalTime {
  if (!isTimeField(f)) noField(f);
  check(f, v);
  switch (f) {
    case "NANO_OF_SECOND": return mkTime(t.h, t.mi, t.s, v);
    case "NANO_OF_DAY": return timeOfNod(v);
    case "MICRO_OF_SECOND": return mkTime(t.h, t.mi, t.s, v * 1e3);
    case "MICRO_OF_DAY": return timeOfNod(v * 1e3);
    case "MILLI_OF_SECOND": return mkTime(t.h, t.mi, t.s, v * 1e6);
    case "MILLI_OF_DAY": return timeOfNod(v * 1e6);
    case "SECOND_OF_MINUTE": return mkTime(t.h, t.mi, v, t.ns);
    case "SECOND_OF_DAY": return timeOfSod(v, t.ns);
    case "MINUTE_OF_HOUR": return mkTime(t.h, v, t.s, t.ns);
    case "MINUTE_OF_DAY": return mkTime(floorDiv(v, 60), v % 60, t.s, t.ns);
    case "HOUR_OF_AMPM": return mkTime(t.h - t.h % 12 + v, t.mi, t.s, t.ns);
    case "CLOCK_HOUR_OF_AMPM": return mkTime(t.h - t.h % 12 + v % 12, t.mi, t.s, t.ns);
    case "HOUR_OF_DAY": return mkTime(v, t.mi, t.s, t.ns);
    case "CLOCK_HOUR_OF_DAY": return mkTime(v % 24, t.mi, t.s, t.ns);
    default: return mkTime(t.h % 12 + v * 12, t.mi, t.s, t.ns);
  }
}
// s + n units, with n split so that no intermediate product loses precision; results in outS/outNs
let outS = 0, outNs = 0;
function addUnits(s: number, ns: number, n: number, u: number): void {
  const un = UNIT_NANOS[u];
  if (un < 1e9) { const per = 1e9 / un, q = floorDiv(n, per); ns += (n - q * per) * un; n = q; } else n *= un / 1e9;
  const carry = floorDiv(ns, 1e9);
  outNs = ns - carry * 1e9;
  outS = s + n + carry;
}
/** seconds + nanos + n time units, normalized, handed to `make` as (seconds, nano-of-second) */
export function carried<R>(s: number, ns: number, n: number, u: number, make: (s: number, ns: number) => R): R {
  addUnits(s, ns, n, u);
  return make(outS, outNs);
}
/** the time n units later; the days that wrapped past midnight are left in outS */
export function timePlus(t: JLocalTime, n: number, u: number): JLocalTime {
  addUnits(secOfDay(t), t.ns, n, u);
  const days = floorDiv(outS, 86400), time = timeOfSod(outS - days * 86400, outNs);
  outS = days;
  return time;
}
export function truncNod(n: number, u: number): number {
  if (u > U.DAYS) unsupported("Unit is too large to be used for truncation");
  const un = UNIT_NANOS[u];
  if (NANOS_PER_DAY % un) unsupported("Unit must divide into a standard day without remainder");
  return floorDiv(n, un) * un;
}
export const untilNanos = (ds: number, dn: number, u: number) => (BigInt(ds) * 1000000000n + BigInt(dn)) / BigInt(UNIT_NANOS[u]);

// ── date-times and instants
export function mkLdt(date: JLocalDate, time: JLocalTime): JLocalDateTime { const l = new JLocalDateTime(); l.date = date; l.time = time; return l; }
export const localEpoch = (l: JLocalDateTime) => epochDay(l.date) * 86400 + secOfDay(l.time);
export function ldtOfEpoch(local: number, ns: number): JLocalDateTime {
  const days = floorDiv(local, 86400);
  return mkLdt(dateFromEpochDay(days), timeOfSod(local - days * 86400, ns));
}
export function ldtPlus(l: JLocalDateTime, n: number, u: number): JLocalDateTime {
  if (u >= U.DAYS) return mkLdt(datePlus(l.date, n, u), l.time);
  const time = timePlus(l.time, n, u);
  return mkLdt(outS ? datePlus(l.date, outS, U.DAYS) : l.date, time);
}
export const ldtCmp = (a: JLocalDateTime, b: JLocalDateTime) => dateCmp(a.date, b.date) || nanoOfDay(a.time) - nanoOfDay(b.time);
export function mkInstant(s: number, ns = 0): JInstant {
  const i = new JInstant(), c = floorDiv(ns, 1e9);
  i.s = s + c; i.ns = ns - c * 1e9;
  return i;
}
export const instantOfMs = (ms: number) => mkInstant(floorDiv(ms, 1000), floorMod(ms, 1000) * 1e6);
export const instantMs = (i: JInstant) => i.s * 1000 + floorDiv(i.ns, 1e6);

// ── zones. java.util.TimeZone's default is the device zone java.time's system zone follows.
export class JTimeZone extends JObj { id = "GMT"; }
export const localTz = new JTimeZone();
try { localTz.id = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "GMT"; } catch { /* */ }
/** the host's own zone: the one the JS Date getters already answer for */
export const hostZone = localTz.id;
const offsets = new Map<number, JZoneOffset>();
export function offsetOf(secs: number): JZoneOffset {
  let o = offsets.get(secs);
  if (o) return o;
  if (!(secs >= -64800 && secs <= 64800)) dtErr("Zone offset not in valid range: -18:00 to +18:00");
  o = new JZoneOffset();
  o.totalSeconds = o.fixed = secs;
  const abs = Math.abs(secs);
  o.id = secs === 0 ? "Z" : `${secs < 0 ? "-" : "+"}${pad(floorDiv(abs, 3600))}:${pad(floorDiv(abs, 60) % 60)}${abs % 60 ? ":" + pad(abs % 60) : ""}`;
  offsets.set(secs, o);
  return o;
}
export function offsetHMS(h: number, m: number, s: number): JZoneOffset {
  if (h < -18 || h > 18) dtErr(`Zone offset hours not in valid range: value ${h} is not in the range -18 to 18`);
  if (h > 0 ? m < 0 || s < 0 : h < 0 ? m > 0 || s > 0 : m * s < 0) dtErr("Zone offset minutes and seconds must have the same sign as the hours");
  if (m < -59 || m > 59) dtErr(`Zone offset minutes not in valid range: value ${m} is not in the range -59 to 59`);
  if (s < -59 || s > 59) dtErr(`Zone offset seconds not in valid range: value ${s} is not in the range -59 to 59`);
  if (Math.abs(h) === 18 && (m || s)) dtErr("Zone offset not in valid range: -18:00 to +18:00");
  return offsetOf(h * 3600 + m * 60 + s);
}
/** ZoneOffset.of: Z, ±h, ±hh, ±hh:mm, ±hhmm, ±hh:mm:ss, ±hhmmss */
export function parseOffsetId(id: string): JZoneOffset {
  if (id === "Z") return offsetOf(0);
  const m = /^([+-])(\d\d?)(?:(:?)(\d\d)(?:\3(\d\d))?)?$/.exec(id);
  if (!m || (m[2].length === 1 && m[4])) dtErr(`Invalid ID for ZoneOffset, invalid format: ${id}`);
  const sign = m![1] === "-" ? -1 : 1;
  return offsetHMS(sign * +m![2], sign * +(m![4] ?? 0), sign * +(m![5] ?? 0));
}
const zones = new Map<string, JZoneId>();
/** ZoneId.of: offsets, UTC/GMT/UT with an optional offset, and region ids Intl knows */
export function zoneOf(id: string): JZoneId {
  if (id == null) npe("zoneId");
  if (id === "Z" || id[0] === "+" || id[0] === "-") return parseOffsetId(id);
  let z = zones.get(id);
  if (z) return z;
  z = new JZoneId();
  const prefixed = /^(UTC|GMT|UT)([+-].*)?$/.exec(id);
  if (prefixed) {
    const o = prefixed[2] ? parseOffsetId(prefixed[2]) : offsetOf(0);
    z.id = o.totalSeconds || prefixed[2] ? prefixed[1] + o.id : prefixed[1];
    z.fixed = o.totalSeconds;
  } else {
    if (!/^[A-Za-z][A-Za-z0-9~/._+-]+$/.test(id)) dtErr(`Invalid ID for region-based ZoneId, invalid format: ${id}`);
    try { new Intl.DateTimeFormat("en-US", { timeZone: id }); } catch { throw rt.mkThrowable("java/time/zone/ZoneRulesException", `Unknown time-zone ID: ${id}`); }
    z.id = id;
    z.fixed = null;
  }
  zones.set(id, z);
  return z;
}
/** java.util.TimeZone ids name java.time zones; an unknown id reads as GMT, as TimeZone.getTimeZone does */
export function zoneForId(id: string): JZoneId {
  try { return zoneOf(id); } catch { return offsetOf(0); }
}
export const sysZone = () => zoneOf(localTz.id);
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** the zone's offset in seconds at an epoch second */
export function offsetAt(z: JZoneId, s: number): number {
  if (z.fixed !== null) return z.fixed;
  if (z.id === hostZone) return -new Date(s * 1000).getTimezoneOffset() * 60;
  let f = offsetFormats.get(z.id);
  if (!f) offsetFormats.set(z.id, f = new Intl.DateTimeFormat("en-US", { timeZone: z.id, timeZoneName: "longOffset" }));
  const name = f.formatToParts(s * 1000).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /([+-])(\d\d):?(\d\d)?:?(\d\d)?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 3600 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0)) : 0;
}
/** the zone's standard offset: the smaller of the year's two extremes */
export const standardOffset = (z: JZoneId, s: number) => {
  const y = dateFromEpochDay(floorDiv(s, 86400)).y;
  return Math.min(offsetAt(z, epochDay(mkDate(y, 1, 1)) * 86400), offsetAt(z, epochDay(mkDate(y, 7, 1)) * 86400));
};

export function mkOdt(ldt: JLocalDateTime, off: JZoneOffset): JOffsetDateTime { const o = new JOffsetDateTime(); o.ldt = ldt; o.off = off; return o; }
export function mkZdt(ldt: JLocalDateTime, off: JZoneOffset, zone: JZoneId): JZonedDateTime {
  const z = new JZonedDateTime(); z.ldt = ldt; z.off = off; z.zone = zone; return z;
}
export const epochSec = (o: JOffsetBased) => localEpoch(o.ldt) - o.off.totalSeconds;
export const odtOfEpoch = (s: number, ns: number, off: JZoneOffset) => mkOdt(ldtOfEpoch(s + off.totalSeconds, ns), off);
export function zdtOfEpoch(s: number, ns: number, zone: JZoneId): JZonedDateTime {
  const off = offsetOf(offsetAt(zone, s));
  return mkZdt(ldtOfEpoch(s + off.totalSeconds, ns), off, zone);
}
/** ZonedDateTime.ofLocal: an overlap keeps the preferred offset (else the earlier one); a gap
 *  moves the time forward by the gap's length */
export function zdtLocal(ldt: JLocalDateTime, zone: JZoneId, preferred?: JZoneOffset): JZonedDateTime {
  if (zone.fixed !== null) return mkZdt(ldt, offsetOf(zone.fixed), zone);
  const local = localEpoch(ldt), before = offsetAt(zone, local - 86400), after = offsetAt(zone, local + 86400);
  const vb = offsetAt(zone, local - before) === before, va = before === after ? vb : offsetAt(zone, local - after) === after;
  if (vb && (!va || preferred?.totalSeconds !== after)) return mkZdt(ldt, offsetOf(before), zone);
  if (va) return mkZdt(ldt, offsetOf(after), zone);
  return zdtOfEpoch(local - before, ldt.time.ns, zone);
}
export function mkOffsetTime(time: JLocalTime, off: JZoneOffset): JOffsetTime { const o = new JOffsetTime(); o.time = time; o.off = off; return o; }
export const ymOf = (y: number, mo: number) => { const m = new JYearMonth(); m.y = check("YEAR", y); m.mo = check("MONTH_OF_YEAR", mo); return m; };
export const yearOf = (y: number) => { const v = new JYear(); v.y = check("YEAR", y); return v; };
export function monthDayOf(mo: number, d: number): JMonthDay {
  check("MONTH_OF_YEAR", mo); check("DAY_OF_MONTH", d);
  if (d > (mo === 2 ? 29 : monthLen(2001, mo))) dtErr(`Illegal value for DayOfMonth field, value ${d} is not valid for month ${MONTHS[mo - 1].toUpperCase()}`);
  const m = new JMonthDay(); m.mo = mo; m.d = d; return m;
}

// ── clocks
export class JClock extends JObj { zone = sysZone(); fixed: JInstant | null = null; offsetMs = 0; unavailable: string | null = null; }
export const clockIn = (zone: JZoneId, fixed: JInstant | null = null, offsetMs = 0) => Object.assign(new JClock(), { zone, fixed, offsetMs });
export const unavailableClock = (message: string) => Object.assign(clockIn(offsetOf(0)), { unavailable: message });
export function clockInstant(c: JClock): JInstant {
  if (c.unavailable) dtErr(c.unavailable);
  return c.fixed ? (c.offsetMs ? instantOfMs(instantMs(c.fixed) + c.offsetMs) : c.fixed) : instantOfMs(Date.now() + c.offsetMs);
}
/** now(Clock): an app-defined Clock answers through its own instant() and getZone() */
export function withClock<R>(clock: unknown, f: (i: JInstant, z: JZoneId) => R): R | Promise<R> {
  if (!clock) npe("clock");
  if (clock instanceof JClock) return f(clockInstant(clock), clock.zone);
  return after(vcall(clock, "instant", "()Ljava/time/Instant;"), (i: JInstant) =>
    after(vcall(clock, "getZone", "()Ljava/time/ZoneId;"), (z: JZoneId) => f(i, z)));
}
export const nowIn = (zone: JZoneId | null) => { if (!zone) npe("zone"); const i = instantOfMs(Date.now()); return zdtOfEpoch(i.s, i.ns, zone!); };

// ── amounts
export function mkDuration(s: number, ns: number): JDuration {
  const d = new JDuration(), c = floorDiv(ns, 1e9);
  d.s = s + c; d.ns = ns - c * 1e9;
  return d;
}
export const periodOf = (y: number, m: number, d: number) => { const p = new JPeriod(); p.y = y; p.m = m; p.d = d; return p; };
export function periodBetween(a: JLocalDate, b: JLocalDate): JPeriod {
  let months = (b.y * 12 + b.mo) - (a.y * 12 + a.mo), days = b.d - a.d;
  if (months > 0 && days < 0) { months--; days = epochDay(b) - epochDay(datePlus(a, months, U.MONTHS)); }
  else if (months < 0 && days > 0) { months++; days -= monthLen(b.y, b.mo); }
  return periodOf(Math.trunc(months / 12), months % 12, days);
}

// ── accessors: every temporal reduces to the parts it carries
export interface Parts { date?: JLocalDate; time?: JLocalTime; off?: JZoneOffset; zone?: JZoneId; inst?: JInstant; more?: Map<string, number> }
/** DateTimeFormatter's parse result */
export class JParsed extends JObj { declare p: Parts; }
export function parts(t: unknown): Parts {
  if (t instanceof JOffsetBased) return { date: t.ldt.date, time: t.ldt.time, off: t.off, zone: t instanceof JZonedDateTime ? t.zone : t.off };
  if (t instanceof JLocalDate) return { date: t };
  if (t instanceof JLocalDateTime) return { date: t.date, time: t.time };
  if (t instanceof JInstant) return { inst: t };
  if (t instanceof JLocalTime) return { time: t };
  if (t instanceof JParsed) return t.p;
  if (t instanceof JOffsetTime) return { time: t.time, off: t.off };
  if (t instanceof JZoneOffset) return { off: t };
  const date = t instanceof JYearMonth ? mkDate(t.y, t.mo, 1) : t instanceof JYear ? mkDate(t.y, 1, 1) : null;
  if (date) {
    const keep = t instanceof JYear ? ["YEAR", "YEAR_OF_ERA", "ERA"] : ["YEAR", "YEAR_OF_ERA", "ERA", "MONTH_OF_YEAR", "PROLEPTIC_MONTH"];
    return { more: new Map(keep.map((f) => [f, dateGet(date, f)!])) };
  }
  if (t instanceof JMonthDay) return { more: new Map([["MONTH_OF_YEAR", t.mo], ["DAY_OF_MONTH", t.d]]) };
  if (isChrono(t, T + "DayOfWeek")) return { more: new Map([["DAY_OF_WEEK", t.ord + 1]]) };
  if (isChrono(t, T + "Month")) return { more: new Map([["MONTH_OF_YEAR", t.ord + 1]]) };
  return {};
}
export function fieldOf(p: Parts, f: string): number | undefined {
  const ord = FIELD_ORD[f];
  if (ord < 15) {
    if (p.time) return timeGet(p.time, f);
    if (p.inst) return f === "NANO_OF_SECOND" ? p.inst.ns : f === "MICRO_OF_SECOND" ? floorDiv(p.inst.ns, 1e3) : f === "MILLI_OF_SECOND" ? floorDiv(p.inst.ns, 1e6) : undefined;
  } else if (ord < 28) {
    if (p.date) return dateGet(p.date, f);
  } else if (f === "OFFSET_SECONDS") {
    if (p.off) return p.off.totalSeconds;
  } else {
    const i = instOf(p);
    if (i) return i.s;
  }
  return p.more?.get(f);
}
export function instOf(p: Parts): JInstant | undefined {
  if (p.inst) return p.inst;
  if (!p.date || !p.time) return undefined;
  const ldt = mkLdt(p.date, p.time);
  if (p.off) return mkInstant(localEpoch(ldt) - p.off.totalSeconds, p.time.ns);
  if (p.zone) { const z = zdtLocal(ldt, p.zone); return mkInstant(epochSec(z), p.time.ns); }
  return undefined;
}
export const describe = (t: unknown) => (t instanceof JObj ? dotName((t.constructor as typeof JObj).$i.name) : String(t));
export const cannot = (what: string, t: unknown): never => dtErr(`Unable to obtain ${what} from TemporalAccessor: ${describe(t)}`);
export function toLocalDate(t: unknown): JLocalDate { if (t == null) npe("temporal"); return parts(t).date ?? cannot("LocalDate", t); }
export function toLocalTime(t: unknown): JLocalTime { if (t == null) npe("temporal"); return parts(t).time ?? cannot("LocalTime", t); }
export function toLdt(t: unknown): JLocalDateTime {
  if (t instanceof JLocalDateTime) return t;
  const p = parts(t);
  return p.date && p.time ? mkLdt(p.date, p.time) : cannot("LocalDateTime", t);
}
export function toInstant(t: unknown): JInstant {
  if (t instanceof JInstant) return t;
  const p = parts(t), s = fieldOf(p, "INSTANT_SECONDS");
  return s === undefined ? cannot("Instant", t) : mkInstant(s, fieldOf(p, "NANO_OF_SECOND") ?? 0);
}
export function toOffset(t: unknown): JZoneOffset { if (t == null) npe("temporal"); return parts(t).off ?? cannot("ZoneOffset", t); }
export function toZone(t: unknown): JZoneId { if (t == null) npe("temporal"); const p = parts(t); return p.zone ?? p.off ?? cannot("ZoneId", t); }
export function toZdt(t: unknown): JZonedDateTime {
  if (t instanceof JZonedDateTime) return t;
  const zone = toZone(t), p = parts(t), i = instOf(p);
  if (i) return zdtOfEpoch(i.s, i.ns, zone);
  return p.date && p.time ? zdtLocal(mkLdt(p.date, p.time), zone) : cannot("ZonedDateTime", t);
}
export function toOdt(t: unknown): JOffsetDateTime {
  if (t instanceof JOffsetDateTime) return t;
  const off = toOffset(t), p = parts(t);
  if (p.date && p.time) return mkOdt(mkLdt(p.date, p.time), off);
  const i = instOf(p);
  return i ? odtOfEpoch(i.s, i.ns, off) : cannot("OffsetDateTime", t);
}
export function toOffsetTime(t: unknown): JOffsetTime {
  if (t instanceof JOffsetTime) return t;
  const p = parts(t);
  return p.time && p.off ? mkOffsetTime(p.time, p.off) : cannot("OffsetTime", t);
}
export function toYearMonth(t: unknown): JYearMonth {
  if (t instanceof JYearMonth) return t;
  const p = parts(t), y = fieldOf(p, "YEAR"), mo = fieldOf(p, "MONTH_OF_YEAR");
  return y !== undefined && mo !== undefined ? ymOf(y, mo) : cannot("YearMonth", t);
}

// ── ISO text and Java's hash codes
export function longHash(n: number): number {
  const b = BigInt.asUintN(64, BigInt(Math.trunc(n)));
  return Number(BigInt.asIntN(32, b ^ (b >> 32n)));
}
export const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
const yearText = (y: number) => (Math.abs(y) < 1000 ? (y < 0 ? "-" : "") + pad(Math.abs(y), 4) : y > 9999 ? "+" + y : String(y));
const fracText = (ns: number) => (ns === 0 ? "" : ns % 1e6 === 0 ? "." + pad(ns / 1e6, 3) : ns % 1e3 === 0 ? "." + pad(ns / 1e3, 6) : "." + pad(ns, 9));
export const dateText = (d: JLocalDate) => `${yearText(d.y)}-${pad(d.mo)}-${pad(d.d)}`;
export const timeText = (t: JLocalTime) => `${pad(t.h)}:${pad(t.mi)}${t.s || t.ns ? ":" + pad(t.s) + fracText(t.ns) : ""}`;
export const ldtText = (l: JLocalDateTime) => dateText(l.date) + "T" + timeText(l.time);
export const instantText = (i: JInstant) => {
  const l = ldtOfEpoch(i.s, 0), t = l.time;
  return `${dateText(l.date)}T${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}${fracText(i.ns)}Z`;
};
export const dateHash = (d: JLocalDate) => (d.y & 0xfffff800) ^ ((d.y << 11) + (d.mo << 6) + d.d);
export const ldtHash = (l: JLocalDateTime) => dateHash(l.date) ^ longHash(nanoOfDay(l.time));
