// java.util's Date, TimeZone and Calendar (and java.sql's dates) over java.time's model. Importing
// this module registers the java.time family too: jtime-iso holds the model, jtime-pattern the
// formatter engine SimpleDateFormat shares, and jtime-temporal/-amount/-format the classes.

import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { vcall, stringHash, boxInt } from "./jlang";
import { usLocale, type JLocale } from "./jvalues";
import { jarray } from "../abi";
import {
  JTimeZone, localTz, hostZone, type JInstant, type JZonedDateTime, floorDiv, floorMod, isLeap, monthLen, npe, iae, instantOfMs, instantMs,
  zoneOf, zoneForId, offsetAt, standardOffset, zdtOfEpoch, epochSec, longHash, pad,
} from "./jtime-iso";
import { type Style, formatPattern, localizedPattern, displayNames, zoneName, weekInfo, tagOf } from "./jtime-pattern";
import { ordering } from "./jtime-temporal";
import "./jtime-amount";
import "./jtime-format";

export { MONTHS, DAYS, localTz, clockIn, offsetOf, unavailableClock } from "./jtime-iso";

const zoneOffsetMs = (id: string, ms: number) => offsetAt(zoneForId(id), floorDiv(ms, 1000)) * 1000;
const zoneStandardOffsetMs = (id: string, ms: number) => standardOffset(zoneForId(id), floorDiv(ms, 1000)) * 1000;

export class JDate extends JObj { t = Date.now(); }
function utilDateCmp(this: JDate, o: JDate) { return this.t < o.t ? -1 : this.t > o.t ? 1 : 0; }
/** the deprecated field constructors, getters and setters work on the default zone's wall clock */
const defaultCalendar = (t: number) => { const c = calendarIn(null, null, JCalendar); c.setMs(t); return c; };
function localDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const c = defaultCalendar(0);
  setWall(c, y + 1900, mo, d, h, mi, s);
  return c.ms;
}
function parseLegacy(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw rt.mkThrowable("java/lang/IllegalArgumentException", s);
  return t;
}
// [name, Calendar field, offset between the Date value and the Calendar one]
const DATE_FIELDS: [string, number, number][] = [["Year", 1, -1900], ["Month", 2, 0], ["Date", 5, 0], ["Hours", 11, 0], ["Minutes", 12, 0], ["Seconds", 13, 0]];
const mkUtilDate = (t: number) => { const d = new JDate(); d.t = t; return d; };
rt.register({
  name: "java/util/Date", ctor: JDate,
  ifaces: ["java/lang/Comparable", "java/lang/Cloneable", "java/io/Serializable"],
  methods: {
    "<init>()V": function (this: JDate) { this.t = Date.now(); },
    "<init>(J)V": function (this: JDate, t: bigint) { this.t = Number(t); },
    "<init>(III)V": function (this: JDate, y: number, mo: number, d: number) { this.t = localDate(y, mo, d); },
    "<init>(IIIII)V": function (this: JDate, y: number, mo: number, d: number, h: number, mi: number) { this.t = localDate(y, mo, d, h, mi); },
    "<init>(IIIIII)V": function (this: JDate, y: number, mo: number, d: number, h: number, mi: number, s: number) { this.t = localDate(y, mo, d, h, mi, s); },
    "<init>(Ljava/lang/String;)V": function (this: JDate, s: string) { this.t = parseLegacy(s); },
    "static parse(Ljava/lang/String;)J": (s: string) => BigInt(parseLegacy(s)),
    "static UTC(IIIIII)J": (y: number, mo: number, d: number, h: number, mi: number, s: number) => {
      const w = new Date(0);
      w.setUTCFullYear(y + 1900, mo, d);
      w.setUTCHours(h, mi, s, 0);
      return BigInt(w.getTime());
    },
    "static from(Ljava/time/Instant;)Ljava/util/Date;": (i: JInstant) => mkUtilDate(instantMs(i ?? npe("instant"))),
    "getTime()J": function (this: JDate) { return BigInt(Math.trunc(this.t)); },
    "setTime(J)V": function (this: JDate, t: bigint) { this.t = Number(t); },
    "getTimezoneOffset()I": function (this: JDate) { return -zoneOffsetMs(localTz.id, this.t) / 60000; },
    "toInstant()Ljava/time/Instant;": function (this: JDate) { return instantOfMs(Math.trunc(this.t)); },
    "before(Ljava/util/Date;)Z": function (this: JDate, o: JDate) { return this.t < o.t ? 1 : 0; },
    "after(Ljava/util/Date;)Z": function (this: JDate, o: JDate) { return this.t > o.t ? 1 : 0; },
    "equals(Ljava/lang/Object;)Z": function (this: JDate, o: unknown) { return o instanceof JDate && o.t === this.t ? 1 : 0; },
    "hashCode()I": function (this: JDate) { return longHash(this.t); },
    "compareTo(Ljava/util/Date;)I": utilDateCmp,
    "compareTo(Ljava/lang/Object;)I": utilDateCmp,
    "toString()Ljava/lang/String;": function (this: JDate) { return formatPattern("EEE MMM dd HH:mm:ss zzz yyyy", this.t, localTz.id, usLocale); },
    "toGMTString()Ljava/lang/String;": function (this: JDate) { return formatPattern("d MMM yyyy HH:mm:ss 'GMT'", this.t, "GMT", usLocale); },
    "toLocaleString()Ljava/lang/String;": function (this: JDate) { return formatPattern(localizedPattern("MEDIUM", "MEDIUM", tagOf(null)), this.t); },
    "getDay()I": function (this: JDate) { return defaultCalendar(this.t).get(7) - 1; },
    ...Object.fromEntries(DATE_FIELDS.flatMap(([n, field, delta]) => [
      [`get${n}()I`, function (this: JDate) { return defaultCalendar(this.t).get(field) + delta; }],
      [`set${n}(I)V`, function (this: JDate, v: number) { const c = defaultCalendar(this.t); c.set(field, v - delta); this.t = c.ms; }],
    ])),
    "clone()Ljava/lang/Object;": function (this: JDate) { return mkUtilDate(this.t); },
  },
});

// java.sql's three java.util.Date subclasses. Android ships them, and a library decides whether
// to register its SQL adapters by looking one of them up.
const SQL_TEXT: Record<string, (t: number) => string> = {
  Date: (t) => formatPattern("yyyy-MM-dd", t),
  Time: (t) => formatPattern("HH:mm:ss", t),
  Timestamp: (t) => formatPattern("yyyy-MM-dd HH:mm:ss.", t) + (pad(Math.round(floorMod(t, 1000) * 1e6), 9).replace(/0+$/, "") || "0"),
};
for (const n of ["Date", "Time", "Timestamp"]) {
  rt.register({
    name: `java/sql/${n}`, ctor: class extends JDate {}, sup: "java/util/Date",
    methods: {
      "<init>(J)V": function (this: JDate, t: bigint) { this.t = Number(t); },
      "toString()Ljava/lang/String;": function (this: JDate) { return SQL_TEXT[n](this.t); },
      ...(n === "Timestamp" ? {
        "getNanos()I": function (this: JDate) { return Math.round(floorMod(this.t, 1000) * 1e6); },
        "setNanos(I)V": function (this: JDate, ns: number) { this.t = Math.floor(this.t / 1000) * 1000 + ns / 1e6; },
      } : {}),
    },
  });
}

// ── TimeZone: the device zone is jtime-iso's localTz
const zoneIds = ["GMT", "UTC", ...Intl.supportedValuesOf("timeZone")].sort();
/** TimeZone.getTimeZone: tz database ids and GMT±hh:mm; anything else is GMT */
function timeZoneOf(id: string | null): JTimeZone {
  const t = new JTimeZone();
  if (id && id !== "Z" && id[0] !== "+" && id[0] !== "-") try { t.id = zoneOf(id).id; } catch { /* GMT */ }
  return t;
}
const tzOffset = (t: JTimeZone, ms: number) => zoneOffsetMs(t.id, ms);
/** the offsets at the year's two extremes: [standard, daylight] */
function tzSeasons(t: JTimeZone): [number, number] {
  const y = new Date().getUTCFullYear(), jan = tzOffset(t, Date.UTC(y, 0, 1)), jul = tzOffset(t, Date.UTC(y, 6, 1));
  return [Math.min(jan, jul), Math.max(jan, jul)];
}
function tzName(t: JTimeZone, daylight: number, style: number, locale: JLocale | null = null): string {
  const y = new Date().getUTCFullYear(), jan = Date.UTC(y, 0, 1), jul = Date.UTC(y, 6, 1);
  const [std, dst] = tzSeasons(t), dstMs = tzOffset(t, jan) === dst ? jan : jul;
  return zoneName(t.id, style === 1, daylight && std !== dst ? dstMs : dstMs === jan ? jul : jan, tagOf(locale));
}
const observesDaylight = function (this: JTimeZone) { const [std, dst] = tzSeasons(this); return +(std !== dst); };
rt.register({
  name: "java/util/TimeZone", ctor: JTimeZone, ifaces: ["java/io/Serializable", "java/lang/Cloneable"],
  statics: { SHORT: 0, LONG: 1 },
  methods: {
    "static getDefault()Ljava/util/TimeZone;": () => localTz,
    // the default is one shared instance, so every getDefault() caller sees the change
    "static setDefault(Ljava/util/TimeZone;)V": (t: JTimeZone | null) => { localTz.id = t?.id ?? hostZone; },
    "static getAvailableIDs(I)[Ljava/lang/String;": (raw: number) =>
      jarray(zoneIds.filter((id) => tzSeasons(timeZoneOf(id))[0] === raw), "Ljava/lang/String;"),
    "getOffset(IIIIII)I": function (this: JTimeZone, era: number, y: number, mo: number, d: number, _dow: number, ms: number) {
      const c = calendarIn(this, null, JCalendar), w = new Date(0);
      w.setUTCFullYear(era ? y : 1 - y, mo, d);
      w.setUTCMilliseconds(ms);
      c.commit(w);
      return tzOffset(this, c.ms);
    },
    "static getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;": timeZoneOf,
    "static getTimeZone(Ljava/time/ZoneId;)Ljava/util/TimeZone;": (z: { id: string }) => timeZoneOf(z.id),
    "toZoneId()Ljava/time/ZoneId;": function (this: JTimeZone) { return zoneForId(this.id); },
    "getID()Ljava/lang/String;": function (this: JTimeZone) { return this.id; },
    "setID(Ljava/lang/String;)V": function (this: JTimeZone, id: string) { this.id = id; },
    "getRawOffset()I": function (this: JTimeZone) { return tzSeasons(this)[0]; },
    "getOffset(J)I": function (this: JTimeZone, t: bigint) { return tzOffset(this, Number(t)); },
    "inDaylightTime(Ljava/util/Date;)Z": function (this: JTimeZone, d: JDate) { return +(tzOffset(this, d.t) !== tzSeasons(this)[0]); },
    "useDaylightTime()Z": observesDaylight,
    "observesDaylightTime()Z": observesDaylight,
    "getDSTSavings()I": function (this: JTimeZone) { const [std, dst] = tzSeasons(this); return dst - std; },
    "hasSameRules(Ljava/util/TimeZone;)Z": function (this: JTimeZone, o: JTimeZone) { return +(o?.id === this.id); },
    "getDisplayName()Ljava/lang/String;": function (this: JTimeZone) { return tzName(this, 0, 1); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": function (this: JTimeZone, l: JLocale) { return tzName(this, 0, 1, l); },
    "getDisplayName(ZI)Ljava/lang/String;": function (this: JTimeZone, dst: number, style: number) { return tzName(this, dst, style); },
    "getDisplayName(ZILjava/util/Locale;)Ljava/lang/String;": function (this: JTimeZone, dst: number, style: number, l: JLocale) { return tzName(this, dst, style, l); },
    "static getAvailableIDs()[Ljava/lang/String;": () => jarray(zoneIds.slice(), "Ljava/lang/String;"),
    "clone()Ljava/lang/Object;": function (this: JTimeZone) { const t = new JTimeZone(); t.id = this.id; return t; },
  },
});

// ── Calendar: fields are the wall clock of the calendar's zone, kept as a UTC-read Date
const CAL = {
  ERA: 0, YEAR: 1, MONTH: 2, WEEK_OF_YEAR: 3, WEEK_OF_MONTH: 4, DATE: 5, DAY_OF_MONTH: 5,
  DAY_OF_YEAR: 6, DAY_OF_WEEK: 7, DAY_OF_WEEK_IN_MONTH: 8, AM_PM: 9, HOUR: 10, HOUR_OF_DAY: 11,
  MINUTE: 12, SECOND: 13, MILLISECOND: 14, ZONE_OFFSET: 15, DST_OFFSET: 16,
};
// GregorianCalendar's MIN_VALUES, LEAST_MAX_VALUES and MAX_VALUES
const CAL_MIN = [0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, -13 * 3600000, 0];
const CAL_LEAST_MAX = [1, 292269054, 11, 52, 4, 28, 365, 7, 4, 1, 11, 23, 59, 59, 999, 14 * 3600000, 1200000];
const CAL_MAX = [1, 292278994, 11, 53, 6, 31, 366, 7, 6, 1, 11, 23, 59, 59, 999, 14 * 3600000, 7200000];
const TIME_MS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 43200000, 3600000, 3600000, 60000, 1000, 1];
export class JCalendar extends JObj {
  ms = Date.now();
  tz: JTimeZone = localTz;
  firstDow = 1; // SUNDAY=1 (Java)
  minDays = 1;
  lenient = true;
  unset = 0;
  private w: Date | null = null;
  wall(): Date { return this.w ??= new Date(this.ms + zoneOffsetMs(this.tz.id, this.ms)); }
  setMs(ms: number): void { this.ms = ms; this.w = null; }
  /** a changed wall clock back to an instant: an overlap reads as standard time, a gap moves forward */
  commit(w: Date): void {
    const local = w.getTime(), std = zoneStandardOffsetMs(this.tz.id, local);
    const off = zoneOffsetMs(this.tz.id, local - std);
    this.setMs(local - (off === std ? std : off));
  }
  // ICU weekNumber: week 0 means the period's first days belong to the previous period's last week
  weekNumber(dayOfPeriod: number, dow: number): number {
    let start = (dow - this.firstDow - dayOfPeriod + 1) % 7;
    if (start < 0) start += 7;
    let w = Math.floor((dayOfPeriod + start - 1) / 7);
    if (7 - start >= this.minDays) w++;
    return w;
  }
  get(f: number): number {
    const d = this.wall();
    this.unset = 0;
    switch (f) {
      case CAL.ERA: return d.getUTCFullYear() > 0 ? 1 : 0;
      case CAL.YEAR: { const y = d.getUTCFullYear(); return y > 0 ? y : 1 - y; }
      case CAL.MONTH: return d.getUTCMonth();
      case CAL.DAY_OF_MONTH: return d.getUTCDate();
      case CAL.DAY_OF_WEEK: return d.getUTCDay() + 1;
      case CAL.DAY_OF_YEAR: return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
      case CAL.WEEK_OF_YEAR: {
        const y = d.getUTCFullYear(), doy = this.get(CAL.DAY_OF_YEAR), dow = d.getUTCDay() + 1, len = isLeap(y) ? 366 : 365;
        let w = this.weekNumber(doy, dow);
        if (w === 0) w = this.weekNumber(doy + (isLeap(y - 1) ? 366 : 365), dow);
        else if (doy >= len - 5) {
          // ICU computeWeekFields: a week straddling Jan 1 belongs to the year holding ≥ minDays of it
          const relDow = (dow + 7 - this.firstDow) % 7;
          if (6 - (relDow + len - doy) % 7 >= this.minDays && doy + 7 - relDow > len) w = 1;
        }
        return w;
      }
      case CAL.WEEK_OF_MONTH: return this.weekNumber(d.getUTCDate(), d.getUTCDay() + 1);
      case CAL.DAY_OF_WEEK_IN_MONTH: return Math.ceil(d.getUTCDate() / 7);
      case CAL.AM_PM: return d.getUTCHours() < 12 ? 0 : 1;
      case CAL.HOUR: return d.getUTCHours() % 12;
      case CAL.HOUR_OF_DAY: return d.getUTCHours();
      case CAL.MINUTE: return d.getUTCMinutes();
      case CAL.SECOND: return d.getUTCSeconds();
      case CAL.MILLISECOND: return d.getUTCMilliseconds();
      case CAL.ZONE_OFFSET: return zoneStandardOffsetMs(this.tz.id, this.ms);
      case CAL.DST_OFFSET: return zoneOffsetMs(this.tz.id, this.ms) - zoneStandardOffsetMs(this.tz.id, this.ms);
    }
    throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", String(f));
  }
  /** lenient: out-of-range values carry into the larger fields */
  set(f: number, v: number): void {
    const d = new Date(this.wall().getTime());
    switch (f) {
      case CAL.ERA: if ((d.getUTCFullYear() > 0 ? 1 : 0) !== v) d.setUTCFullYear(1 - d.getUTCFullYear()); break;
      case CAL.YEAR: d.setUTCFullYear(d.getUTCFullYear() > 0 ? v : 1 - v); break;
      case CAL.MONTH: d.setUTCMonth(v); break;
      case CAL.DAY_OF_MONTH: d.setUTCDate(v); break;
      case CAL.DAY_OF_YEAR: d.setUTCMonth(0, v); break;
      case CAL.DAY_OF_WEEK: d.setUTCDate(d.getUTCDate() + floorMod(v - this.firstDow, 7) - floorMod(d.getUTCDay() + 1 - this.firstDow, 7)); break;
      case CAL.WEEK_OF_YEAR: case CAL.WEEK_OF_MONTH: case CAL.DAY_OF_WEEK_IN_MONTH: d.setUTCDate(d.getUTCDate() + (v - this.get(f)) * 7); break;
      case CAL.AM_PM: d.setUTCHours(d.getUTCHours() % 12 + v * 12); break;
      case CAL.HOUR: d.setUTCHours((d.getUTCHours() >= 12 ? 12 : 0) + v); break;
      case CAL.HOUR_OF_DAY: d.setUTCHours(v); break;
      case CAL.MINUTE: d.setUTCMinutes(v); break;
      case CAL.SECOND: d.setUTCSeconds(v); break;
      case CAL.MILLISECOND: d.setUTCMilliseconds(v); break;
      default: return;
    }
    this.unset &= ~(1 << f);
    this.commit(d);
  }
  /** add(): time fields move the instant; date fields move the wall clock, pinning the day of month */
  add(f: number, v: number): void {
    if (!v) return;
    if (f >= CAL.AM_PM && f <= CAL.MILLISECOND) return this.setMs(this.ms + v * TIME_MS[f]);
    const d = new Date(this.wall().getTime());
    switch (f) {
      case CAL.ERA: case CAL.YEAR: case CAL.MONTH: {
        const day = d.getUTCDate();
        d.setUTCDate(1);
        if (f === CAL.MONTH) d.setUTCMonth(d.getUTCMonth() + v); else d.setUTCFullYear(d.getUTCFullYear() + (f === CAL.ERA ? 0 : v));
        d.setUTCDate(Math.min(day, monthLen(d.getUTCFullYear(), d.getUTCMonth() + 1)));
        break;
      }
      case CAL.WEEK_OF_YEAR: case CAL.WEEK_OF_MONTH: case CAL.DAY_OF_WEEK_IN_MONTH: d.setUTCDate(d.getUTCDate() + v * 7); break;
      default: d.setUTCDate(d.getUTCDate() + v);
    }
    this.commit(d);
  }
  /** roll(): the field wraps within its range and larger fields stay */
  roll(f: number, v: number): void {
    if (f === CAL.MONTH) {
      const d = new Date(this.wall().getTime()), day = d.getUTCDate(), m = floorMod(d.getUTCMonth() + v, 12);
      d.setUTCDate(1);
      d.setUTCMonth(m);
      d.setUTCDate(Math.min(day, monthLen(d.getUTCFullYear(), m + 1)));
      return this.commit(d);
    }
    const lo = this.actualMin(f), span = this.actualMax(f) - lo + 1;
    this.set(f, lo + floorMod(this.get(f) - lo + v, span));
  }
  actualMin(f: number): number { return f === CAL.WEEK_OF_MONTH ? this.weekNumber(1, (floorMod(this.wall().getUTCDay() - this.wall().getUTCDate() + 1, 7)) + 1) : CAL_MIN[f]; }
  actualMax(f: number): number {
    const d = this.wall(), y = d.getUTCFullYear(), len = monthLen(y, d.getUTCMonth() + 1);
    switch (f) {
      case CAL.DAY_OF_MONTH: return len;
      case CAL.DAY_OF_YEAR: return isLeap(y) ? 366 : 365;
      case CAL.DAY_OF_WEEK_IN_MONTH: return Math.ceil(len / 7);
      case CAL.WEEK_OF_MONTH: return this.weekNumber(len, floorMod(d.getUTCDay() + len - d.getUTCDate(), 7) + 1);
      case CAL.WEEK_OF_YEAR: {
        const c = Object.assign(new JCalendar(), { tz: this.tz, firstDow: this.firstDow, minDays: this.minDays });
        const last = new Date(Date.UTC(0, 11, 31)); last.setUTCFullYear(y);
        c.commit(last);
        const w = c.get(CAL.WEEK_OF_YEAR);
        if (w !== 1) return w;
        c.add(CAL.DAY_OF_MONTH, -7);
        return c.get(CAL.WEEK_OF_YEAR);
      }
    }
    return CAL_MAX[f];
  }
}
const CAL_STYLES: Record<number, Style> = { 1: "short", 2: "long", 4: "narrow" };
const CAL_NAMES: Record<number, ["era" | "month" | "weekday" | "dayPeriod", (v: number) => number]> = {
  [CAL.ERA]: ["era", (v) => v], [CAL.MONTH]: ["month", (v) => v], [CAL.DAY_OF_WEEK]: ["weekday", (v) => (v + 5) % 7], [CAL.AM_PM]: ["dayPeriod", (v) => v],
};
function calStyle(style: number): Style {
  const s = CAL_STYLES[style & 0x7fff];
  return s ?? iae(`Illegal style: ${style}`);
}
/** a Calendar in the zone, with the locale's week definition */
function calendarIn(tz: JTimeZone | null, locale: JLocale | null, Ctor: new () => JCalendar = rt.link("java/util/GregorianCalendar").ctor as new () => JCalendar): JCalendar {
  const c = new Ctor(), [first, minDays] = weekInfo(tagOf(locale));
  c.tz = tz ?? localTz;
  c.firstDow = first % 7 + 1;
  c.minDays = minDays;
  return c;
}
function setWall(c: JCalendar, y: number, mo: number, d: number, h?: number, mi?: number, s?: number): void {
  const w = new Date(c.wall().getTime());
  w.setUTCFullYear(y, mo, d);
  if (h !== undefined) w.setUTCHours(h, mi!, s ?? w.getUTCSeconds());
  c.commit(w);
}
const calCmp = (a: JCalendar, b: JCalendar) => (a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0);
/** a constructed Calendar is the default one for its zone and locale */
function initCalendar(c: JCalendar, tz: JTimeZone | null, l: JLocale | null) { Object.assign(c, calendarIn(tz, l, JCalendar)); }
const calMethods: NativeSpec["methods"] = {
  "<init>()V": function (this: JCalendar) { initCalendar(this, null, null); },
  "static getInstance()Ljava/util/Calendar;": () => calendarIn(null, null),
  "static getInstance(Ljava/util/Locale;)Ljava/util/Calendar;": (l: JLocale) => calendarIn(null, l),
  "static getInstance(Ljava/util/TimeZone;)Ljava/util/Calendar;": (tz: JTimeZone) => calendarIn(tz, null),
  "static getInstance(Ljava/util/TimeZone;Ljava/util/Locale;)Ljava/util/Calendar;": (tz: JTimeZone, l: JLocale) => calendarIn(tz, l),
  "get(I)I": function (this: JCalendar, f: number) { return this.get(f); },
  "set(II)V": function (this: JCalendar, f: number, v: number) { this.set(f, v); },
  "set(III)V": function (this: JCalendar, y: number, m: number, d: number) { setWall(this, y, m, d); },
  "set(IIIII)V": function (this: JCalendar, y: number, m: number, d: number, h: number, mi: number) { setWall(this, y, m, d, h, mi); },
  "set(IIIIII)V": function (this: JCalendar, y: number, m: number, d: number, h: number, mi: number, s: number) { setWall(this, y, m, d, h, mi, s); },
  "add(II)V": function (this: JCalendar, f: number, v: number) { this.add(f, v); },
  "roll(II)V": function (this: JCalendar, f: number, v: number) { this.roll(f, v); },
  "roll(IZ)V": function (this: JCalendar, f: number, up: number) { this.roll(f, up ? 1 : -1); },
  "isSet(I)Z": function (this: JCalendar, f: number) { return +!(this.unset & (1 << f)); },
  "getTime()Ljava/util/Date;": function (this: JCalendar) { return mkUtilDate(this.ms); },
  "setTime(Ljava/util/Date;)V": function (this: JCalendar, d: JDate) { this.setMs((d ?? npe("date")).t); },
  "getTimeInMillis()J": function (this: JCalendar) { return BigInt(this.ms); },
  "setTimeInMillis(J)V": function (this: JCalendar, t: bigint) { this.setMs(Number(t)); },
  "toInstant()Ljava/time/Instant;": function (this: JCalendar) { return instantOfMs(this.ms); },
  "clear()V": function (this: JCalendar) { this.commit(new Date(0)); this.unset = (1 << 17) - 1; },
  "clear(I)V": function (this: JCalendar, f: number) { if (f !== CAL.DAY_OF_WEEK && f < CAL.ZONE_OFFSET) this.set(f, CAL_MIN[f]); this.unset |= 1 << f; },
  "getFirstDayOfWeek()I": function (this: JCalendar) { return this.firstDow; },
  "setFirstDayOfWeek(I)V": function (this: JCalendar, v: number) { this.firstDow = v; },
  "getMinimalDaysInFirstWeek()I": function (this: JCalendar) { return this.minDays; },
  "setMinimalDaysInFirstWeek(I)V": function (this: JCalendar, v: number) { this.minDays = v; },
  "getActualMaximum(I)I": function (this: JCalendar, f: number) { return this.actualMax(f); },
  "getActualMinimum(I)I": function (this: JCalendar, f: number) { return this.actualMin(f); },
  "getMaximum(I)I": (f: number) => CAL_MAX[f],
  "getLeastMaximum(I)I": (f: number) => CAL_LEAST_MAX[f],
  "getMinimum(I)I": (f: number) => CAL_MIN[f],
  "getGreatestMinimum(I)I": (f: number) => CAL_MIN[f],
  "getWeekYear()I": function (this: JCalendar) {
    const y = this.get(CAL.YEAR), w = this.get(CAL.WEEK_OF_YEAR), m = this.get(CAL.MONTH);
    return m === 11 && w === 1 ? y + 1 : m === 0 && w >= 52 ? y - 1 : y;
  },
  "isWeekDateSupported()Z": () => 1,
  "getDisplayName(IILjava/util/Locale;)Ljava/lang/String;": function (this: JCalendar, f: number, style: number, l: JLocale) {
    const kind = CAL_NAMES[f];
    if (!kind) return null;
    const names = displayNames(tagOf(l ?? npe("locale")), kind[0], kind[0] === "dayPeriod" ? "short" : calStyle(style));
    return names[kind[1](this.get(f))];
  },
  "getDisplayNames(IILjava/util/Locale;)Ljava/util/Map;": driven(function* (this: JCalendar, f: number, style: number, l: JLocale): Gen {
    const kind = CAL_NAMES[f];
    if (!kind) return null;
    const tag = tagOf(l ?? npe("locale")), map = rt.make("java/util/HashMap");
    for (const s of style === 0 ? ["short", "long"] as Style[] : [calStyle(style)]) {
      const names = displayNames(tag, kind[0], kind[0] === "dayPeriod" ? "short" : s);
      for (let v = 0; v < names.length; v++) {
        const value = kind[0] === "weekday" ? (v + 1) % 7 + 1 : v;
        yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", names[v], boxInt(value));
      }
    }
    return map;
  }),
  "getCalendarType()Ljava/lang/String;": () => "gregory",
  ...ordering("Ljava/util/Calendar;", calCmp),
  "before(Ljava/lang/Object;)Z": function (this: JCalendar, o: unknown) { return +(o instanceof JCalendar && this.ms < o.ms); },
  "after(Ljava/lang/Object;)Z": function (this: JCalendar, o: unknown) { return +(o instanceof JCalendar && this.ms > o.ms); },
  "equals(Ljava/lang/Object;)Z": function (this: JCalendar, o: unknown) {
    return +(o instanceof JCalendar && o.ms === this.ms && o.tz.id === this.tz.id && o.firstDow === this.firstDow && o.minDays === this.minDays);
  },
  "hashCode()I": function (this: JCalendar) { return (1 | (this.firstDow << 1) | (this.minDays << 4) | (stringHash(this.tz.id) << 7)) ^ longHash(this.ms); },
  "clone()Ljava/lang/Object;": function (this: JCalendar) {
    return Object.assign(new (this.constructor as new () => JCalendar)(), { ms: this.ms, tz: this.tz, firstDow: this.firstDow, minDays: this.minDays, lenient: this.lenient, unset: this.unset });
  },
  "getTimeZone()Ljava/util/TimeZone;": function (this: JCalendar) { return this.tz; },
  "setTimeZone(Ljava/util/TimeZone;)V": function (this: JCalendar, tz: JTimeZone) { this.tz = tz ?? localTz; this.setMs(this.ms); },
  "setLenient(Z)V": function (this: JCalendar, v: number) { this.lenient = !!v; },
  "isLenient()Z": function (this: JCalendar) { return +this.lenient; },
};
rt.register({
  name: "java/util/Calendar", ctor: JCalendar,
  ifaces: ["java/lang/Comparable", "java/lang/Cloneable", "java/io/Serializable"],
  statics: {
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5, JULY: 6, AUGUST: 7,
    SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11, UNDECIMBER: 12,
    SUNDAY: 1, MONDAY: 2, TUESDAY: 3, WEDNESDAY: 4, THURSDAY: 5, FRIDAY: 6, SATURDAY: 7,
    ...CAL, AM: 0, PM: 1, FIELD_COUNT: 17, ALL_STYLES: 0, SHORT: 1, LONG: 2, NARROW_FORMAT: 4,
    SHORT_FORMAT: 1, LONG_FORMAT: 2, SHORT_STANDALONE: 0x8001, LONG_STANDALONE: 0x8002, NARROW_STANDALONE: 0x8004,
  },
  methods: calMethods,
});
/** GregorianCalendar(year, month, day[, hour, minute[, second]]): the default calendar at that wall time */
function gregorianAt(this: JCalendar, y: number, m: number, d: number, h = 0, mi = 0, s = 0) {
  initCalendar(this, null, null);
  setWall(this, y, m, d, h, mi, s);
  this.set(CAL.MILLISECOND, 0);
}
rt.register({
  name: "java/util/GregorianCalendar", ctor: class extends JCalendar {}, sup: "java/util/Calendar",
  statics: { BC: 0, AD: 1 },
  methods: {
    "<init>()V": function (this: JCalendar) { initCalendar(this, null, null); },
    "<init>(Ljava/util/TimeZone;)V": function (this: JCalendar, tz: JTimeZone) { initCalendar(this, tz, null); },
    "<init>(Ljava/util/Locale;)V": function (this: JCalendar, l: JLocale) { initCalendar(this, null, l); },
    "<init>(Ljava/util/TimeZone;Ljava/util/Locale;)V": function (this: JCalendar, tz: JTimeZone, l: JLocale) { initCalendar(this, tz, l); },
    "<init>(III)V": gregorianAt,
    "<init>(IIIII)V": gregorianAt,
    "<init>(IIIIII)V": gregorianAt,
    "isLeapYear(I)Z": (y: number) => +isLeap(y),
    "getGregorianChange()Ljava/util/Date;": () => mkUtilDate(-12219292800000),
    "setGregorianChange(Ljava/util/Date;)V": () => {},
    "toZonedDateTime()Ljava/time/ZonedDateTime;": function (this: JCalendar) { const i = instantOfMs(this.ms); return zdtOfEpoch(i.s, i.ns, zoneForId(this.tz.id)); },
    "static from(Ljava/time/ZonedDateTime;)Ljava/util/GregorianCalendar;": (z: JZonedDateTime) => {
      const c = calendarIn(timeZoneOf(z.zone.id), null);
      c.setMs(epochSec(z) * 1000 + floorDiv(z.ldt.time.ns, 1e6));
      return c;
    },
  },
});
