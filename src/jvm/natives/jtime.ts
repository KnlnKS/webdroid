// java.util.Calendar/Date/TimeZone and java.time.

import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { mkEnumSet, defineException, vcall, JSimpleEnum, after, stringHash, boxInt } from "./jlang";
import { csText } from "./jchars";
import { newArrayList, newStringSet } from "./jutil";
import { defaultLocale, localeTag, usLocale, type JLocale } from "./jvalues";
import { jarray } from "../abi";

export class JDate extends JObj { t = Date.now(); }
function utilDateCmp(this: JDate, o: JDate) { return this.t < o.t ? -1 : this.t > o.t ? 1 : 0; }
/** the deprecated field constructors and setters read the wall clock in the default zone */
function localDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const w = new Date(0);
  w.setFullYear(y + 1900, mo, d);
  w.setHours(h, mi, s, 0);
  return w.getTime();
}
function parseLegacy(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw rt.mkThrowable("java/lang/IllegalArgumentException", s);
  return t;
}
const DATE_FIELDS: [string, (d: Date) => number, (d: Date, v: number) => void][] = [
  ["Year", (d) => d.getFullYear() - 1900, (d, v) => d.setFullYear(v + 1900)], ["Month", (d) => d.getMonth(), (d, v) => d.setMonth(v)],
  ["Date", (d) => d.getDate(), (d, v) => d.setDate(v)], ["Hours", (d) => d.getHours(), (d, v) => d.setHours(v)],
  ["Minutes", (d) => d.getMinutes(), (d, v) => d.setMinutes(v)], ["Seconds", (d) => d.getSeconds(), (d, v) => d.setSeconds(v)],
];
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
    "getTimezoneOffset()I": function (this: JDate) { return new Date(this.t).getTimezoneOffset(); },
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
    "getDay()I": function (this: JDate) { return new Date(this.t).getDay(); },
    ...Object.fromEntries(DATE_FIELDS.flatMap(([n, get, set]) => [
      [`get${n}()I`, function (this: JDate) { return get(new Date(this.t)); }],
      [`set${n}(I)V`, function (this: JDate, v: number) { const d = new Date(this.t); set(d, v); this.t = d.getTime(); }],
    ])),
    "clone()Ljava/lang/Object;": function (this: JDate) { return mkUtilDate(this.t); },
  },
});

// java.sql's three java.util.Date subclasses. Android ships them, and a library decides whether
// to register its SQL adapters by looking one of them up.
export const pad = (n: number, w = 2) => String(n).padStart(w, "0");
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

// ── TimeZone (device local zone)
export class JTimeZone extends JObj { id = "GMT"; }
const zoneIds = ["GMT", "UTC", ...Intl.supportedValuesOf("timeZone")].sort();
export const localTz = new JTimeZone();
try { localTz.id = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "GMT"; } catch { /* */ }
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
rt.register({
  name: "java/util/TimeZone", ctor: JTimeZone, ifaces: ["java/io/Serializable", "java/lang/Cloneable"],
  statics: { SHORT: 0, LONG: 1 },
  methods: {
    "static getDefault()Ljava/util/TimeZone;": () => localTz,
    "static getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;": timeZoneOf,
    "static getTimeZone(Ljava/time/ZoneId;)Ljava/util/TimeZone;": (z: { id: string }) => timeZoneOf(z.id),
    "toZoneId()Ljava/time/ZoneId;": function (this: JTimeZone) { return zoneForId(this.id); },
    "getID()Ljava/lang/String;": function (this: JTimeZone) { return this.id; },
    "setID(Ljava/lang/String;)V": function (this: JTimeZone, id: string) { this.id = id; },
    "getRawOffset()I": function (this: JTimeZone) { return tzSeasons(this)[0]; },
    "getOffset(J)I": function (this: JTimeZone, t: bigint) { return tzOffset(this, Number(t)); },
    "inDaylightTime(Ljava/util/Date;)Z": function (this: JTimeZone, d: JDate) { return +(tzOffset(this, d.t) !== tzSeasons(this)[0]); },
    "useDaylightTime()Z": function (this: JTimeZone) { const [std, dst] = tzSeasons(this); return +(std !== dst); },
    "observesDaylightTime()Z": function (this: JTimeZone) { const [std, dst] = tzSeasons(this); return +(std !== dst); },
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
  /** the instant, as java.util.Date holds it */
  get d(): Date { return new Date(this.ms); }
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
const calMethods: NativeSpec["methods"] = {
  "<init>()V": function (this: JCalendar) { Object.assign(this, calendarIn(null, null, JCalendar)); },
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
const gregorian = (tz: JTimeZone | null, l: JLocale | null) => function (this: JCalendar) { Object.assign(this, calendarIn(tz, l, JCalendar)); };
rt.register({
  name: "java/util/GregorianCalendar", ctor: class extends JCalendar {}, sup: "java/util/Calendar",
  statics: { BC: 0, AD: 1 },
  methods: {
    "<init>()V": gregorian(null, null),
    "<init>(Ljava/util/TimeZone;)V": function (this: JCalendar, tz: JTimeZone) { gregorian(tz, null).call(this); },
    "<init>(Ljava/util/Locale;)V": function (this: JCalendar, l: JLocale) { gregorian(null, l).call(this); },
    "<init>(Ljava/util/TimeZone;Ljava/util/Locale;)V": function (this: JCalendar, tz: JTimeZone, l: JLocale) { gregorian(tz, l).call(this); },
    "<init>(III)V": function (this: JCalendar, y: number, m: number, d: number) { gregorian(null, null).call(this); setWall(this, y, m, d, 0, 0, 0); this.set(CAL.MILLISECOND, 0); },
    "<init>(IIIII)V": function (this: JCalendar, y: number, m: number, d: number, h: number, mi: number) {
      gregorian(null, null).call(this); setWall(this, y, m, d, h, mi, 0); this.set(CAL.MILLISECOND, 0);
    },
    "<init>(IIIIII)V": function (this: JCalendar, y: number, m: number, d: number, h: number, mi: number, s: number) {
      gregorian(null, null).call(this); setWall(this, y, m, d, h, mi, s); this.set(CAL.MILLISECOND, 0);
    },
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

// ── calendar vocabulary (en); libc and procfs print these
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── java.time. Values keep their ISO fields and use proleptic Gregorian arithmetic; zone rules
// come from Intl (the system zone from the host Date). The formatter below also serves
// java.text.SimpleDateFormat.
const NANOS_PER_DAY = 86400e9;
const floorDiv = (a: number, b: number) => Math.floor(a / b);
const floorMod = (a: number, b: number) => a - Math.floor(a / b) * b;
defineException("java/time/DateTimeException", "java/lang/RuntimeException");
defineException("java/time/format/DateTimeParseException", "java/time/DateTimeException");
defineException("java/time/temporal/UnsupportedTemporalTypeException", "java/time/DateTimeException");
defineException("java/time/zone/ZoneRulesException", "java/time/DateTimeException");
const dtErr = (msg: string): never => { throw rt.mkThrowable("java/time/DateTimeException", msg); };
const unsupported = (msg: string): never => { throw rt.mkThrowable("java/time/temporal/UnsupportedTemporalTypeException", msg); };
const npe = (what: string): never => { throw rt.mkThrowable("java/lang/NullPointerException", what); };
type Methods = NonNullable<NativeSpec["methods"]>;
const T = "java/time/", TT = "java/time/temporal/";
const TEMPORAL = `L${TT}Temporal;`, UNIT = `L${TT}TemporalUnit;`, FIELD = `L${TT}TemporalField;`;
const AMOUNT = `L${TT}TemporalAmount;`, ADJUSTER = `L${TT}TemporalAdjuster;`, ACCESSOR = `L${TT}TemporalAccessor;`;

// ChronoField in ordinal order: time fields first (< 15), then date fields (< 28)
const FIELD_RANGE: Record<string, [number, number]> = {
  NANO_OF_SECOND: [0, 999999999], NANO_OF_DAY: [0, NANOS_PER_DAY - 1], MICRO_OF_SECOND: [0, 999999], MICRO_OF_DAY: [0, 86400e6 - 1],
  MILLI_OF_SECOND: [0, 999], MILLI_OF_DAY: [0, 86400e3 - 1], SECOND_OF_MINUTE: [0, 59], SECOND_OF_DAY: [0, 86399],
  MINUTE_OF_HOUR: [0, 59], MINUTE_OF_DAY: [0, 1439], HOUR_OF_AMPM: [0, 11], CLOCK_HOUR_OF_AMPM: [1, 12], HOUR_OF_DAY: [0, 23],
  CLOCK_HOUR_OF_DAY: [1, 24], AMPM_OF_DAY: [0, 1], DAY_OF_WEEK: [1, 7], ALIGNED_DAY_OF_WEEK_IN_MONTH: [1, 7],
  ALIGNED_DAY_OF_WEEK_IN_YEAR: [1, 7], DAY_OF_MONTH: [1, 31], DAY_OF_YEAR: [1, 366], EPOCH_DAY: [-365243219162, 365241780471],
  ALIGNED_WEEK_OF_MONTH: [1, 5], ALIGNED_WEEK_OF_YEAR: [1, 53], MONTH_OF_YEAR: [1, 12], PROLEPTIC_MONTH: [-11999999988, 11999999999],
  YEAR_OF_ERA: [1, 1e9], YEAR: [-999999999, 999999999], ERA: [0, 1],
  INSTANT_SECONDS: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], OFFSET_SECONDS: [-64800, 64800],
};
const FIELD_NAMES = Object.keys(FIELD_RANGE);
const FIELD_ORD: Record<string, number> = Object.fromEntries(FIELD_NAMES.map((f, i) => [f, i]));
const isTimeField = (f: string) => FIELD_ORD[f] < 15;
const isDateField = (f: string) => FIELD_ORD[f] >= 15 && FIELD_ORD[f] < 28;
/** Java's display name: HOUR_OF_AMPM → HourOfAmPm */
const camel = (n: string) => n.split("_").map((w) => (w === "AMPM" ? "AmPm" : w[0] + w.slice(1).toLowerCase())).join("");
function check(f: string, v: number): number {
  const [lo, hi] = FIELD_RANGE[f];
  if (!(v >= lo && v <= hi) || !Number.isInteger(v)) dtErr(`Invalid value for ${camel(f)} (valid values ${lo} - ${hi}): ${v}`);
  return v;
}
const noField = (f: string): never => unsupported(`Unsupported field: ${camel(f)}`);
// fields whose values do not fit get()'s int
const LONG_FIELDS = new Set(["NANO_OF_DAY", "MICRO_OF_DAY", "EPOCH_DAY", "PROLEPTIC_MONTH", "INSTANT_SECONDS"]);

const U = { NANOS: 0, MICROS: 1, MILLIS: 2, SECONDS: 3, MINUTES: 4, HOURS: 5, HALF_DAYS: 6, DAYS: 7, WEEKS: 8, MONTHS: 9, YEARS: 10,
  DECADES: 11, CENTURIES: 12, MILLENNIA: 13, ERAS: 14, FOREVER: 15 } as const;
const UNIT_NANOS = [1, 1e3, 1e6, 1e9, 60e9, 3600e9, 43200e9, NANOS_PER_DAY];
// Java's estimated durations of the date-based units, in seconds
const UNIT_SECONDS = [0, 0, 0, 1, 60, 3600, 43200, 86400, 604800, 2629746, 31556952, 315569520, 3155695200, 31556952000, 31556952e9, Number.MAX_SAFE_INTEGER];
const noUnit = (u: JSimpleEnum): never => unsupported(`Unsupported unit: ${camel(u.ename)}`);

// ── plain values
class JLocalDate extends JObj { y = 1970; mo = 1; d = 1; }
class JLocalTime extends JObj { h = 0; mi = 0; s = 0; ns = 0; }
class JLocalDateTime extends JObj { declare date: JLocalDate; declare time: JLocalTime; }
class JInstant extends JObj { s = 0; ns = 0; }
/** fixed: the offset of a zone whose rules never change (a ZoneOffset, UTC, GMT+01:00) */
class JZoneId extends JObj { id = "Z"; fixed: number | null = 0; }
class JZoneOffset extends JZoneId { totalSeconds = 0; }
class JOffsetBased extends JObj { declare ldt: JLocalDateTime; declare off: JZoneOffset; }
class JOffsetDateTime extends JOffsetBased {}
class JZonedDateTime extends JOffsetBased { declare zone: JZoneId; }
class JOffsetTime extends JObj { declare time: JLocalTime; declare off: JZoneOffset; }
class JYearMonth extends JObj { y = 0; mo = 1; }
class JYear extends JObj { y = 0; }
class JMonthDay extends JObj { mo = 1; d = 1; }
class JDuration extends JObj { s = 0; ns = 0; }
class JPeriod extends JObj { y = 0; m = 0; d = 0; }

const isLeap = (y: number) => (y & 3) === 0 && (y % 100 !== 0 || y % 400 === 0);
const monthLen = (y: number, mo: number) => (mo === 2 ? (isLeap(y) ? 29 : 28) : mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31);
const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const dayOfYear = (d: JLocalDate) => CUM_DAYS[d.mo - 1] + d.d + (d.mo > 2 && isLeap(d.y) ? 1 : 0);
function mkDate(y: number, mo: number, d: number): JLocalDate { const l = new JLocalDate(); l.y = y; l.mo = mo; l.d = d; return l; }
function dateOf(y: number, mo: number, d: number): JLocalDate {
  check("YEAR", y); check("MONTH_OF_YEAR", mo); check("DAY_OF_MONTH", d);
  if (d > monthLen(y, mo)) dtErr(d === 29 ? `Invalid date 'February 29' as '${y}' is not a leap year` : `Invalid date '${MONTHS[mo - 1].toUpperCase()} ${d}'`);
  return mkDate(y, mo, d);
}
/** the day clamped to the month's length, as plusMonths/withYear do */
const dateClamped = (y: number, mo: number, d: number) => mkDate(check("YEAR", y), mo, Math.min(d, monthLen(y, mo)));
function ofYearDay(y: number, doy: number): JLocalDate {
  check("DAY_OF_YEAR", doy);
  if (doy === 366 && !isLeap(y)) dtErr(`Invalid date 'DayOfYear 366' as '${y}' is not a leap year`);
  return datePlus(mkDate(check("YEAR", y), 1, 1), doy - 1, U.DAYS);
}
function epochDay(date: JLocalDate): number {
  const y = date.y - (date.mo <= 2 ? 1 : 0), era = Math.floor(y / 400), year = y - era * 400;
  const month = date.mo + (date.mo > 2 ? -3 : 9);
  return era * 146097 + year * 365 + Math.floor(year / 4) - Math.floor(year / 100)
    + Math.floor((153 * month + 2) / 5) + date.d - 1 - 719468;
}
function dateFromEpochDay(day: number): JLocalDate {
  const z = day + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const year = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * year + Math.floor(year / 4) - Math.floor(year / 100));
  const mp = Math.floor((5 * doy + 2) / 153), month = mp + (mp < 10 ? 3 : -9);
  return mkDate(year + era * 400 + (month <= 2 ? 1 : 0), month, doy - Math.floor((153 * mp + 2) / 5) + 1);
}
const dayOfWeek = (d: JLocalDate) => floorMod(epochDay(d) + 3, 7) + 1;
function dateGet(d: JLocalDate, f: string): number | undefined {
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
function datePlus(d: JLocalDate, n: number, u: number): JLocalDate {
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
function dateWith(d: JLocalDate, f: string, v: number): JLocalDate {
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
const dateCmp = (a: JLocalDate, b: JLocalDate) => a.y - b.y || a.mo - b.mo || a.d - b.d;
function dateUntil(start: JLocalDate, end: JLocalDate, u: number): bigint {
  if (u === U.DAYS) return BigInt(epochDay(end) - epochDay(start));
  if (u === U.WEEKS) return BigInt(Math.trunc((epochDay(end) - epochDay(start)) / 7));
  const months = Math.trunc(((end.y * 12 + end.mo) * 32 + end.d - ((start.y * 12 + start.mo) * 32 + start.d)) / 32);
  const per = [1, 12, 120, 1200, 12000][u - U.MONTHS];
  if (per) return BigInt(Math.trunc(months / per));
  return BigInt((end.y >= 1 ? 1 : 0) - (start.y >= 1 ? 1 : 0));
}

function mkTime(h: number, mi: number, s = 0, ns = 0): JLocalTime { const t = new JLocalTime(); t.h = h; t.mi = mi; t.s = s; t.ns = ns; return t; }
const timeOf = (h: number, mi: number, s = 0, ns = 0) =>
  mkTime(check("HOUR_OF_DAY", h), check("MINUTE_OF_HOUR", mi), check("SECOND_OF_MINUTE", s), check("NANO_OF_SECOND", ns));
const secOfDay = (t: JLocalTime) => t.h * 3600 + t.mi * 60 + t.s;
const nanoOfDay = (t: JLocalTime) => secOfDay(t) * 1e9 + t.ns;
const timeOfSod = (sod: number, ns: number) => mkTime(floorDiv(sod, 3600), floorDiv(sod, 60) % 60, sod % 60, ns);
const timeOfNod = (n: number) => { const sod = floorDiv(check("NANO_OF_DAY", n), 1e9); return timeOfSod(sod, n - sod * 1e9); };
function timeGet(t: JLocalTime, f: string): number | undefined {
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
function timeWith(t: JLocalTime, f: string, v: number): JLocalTime {
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
/** the time n units later; the days that wrapped past midnight are left in outS */
function timePlus(t: JLocalTime, n: number, u: number): JLocalTime {
  addUnits(secOfDay(t), t.ns, n, u);
  const days = floorDiv(outS, 86400), time = timeOfSod(outS - days * 86400, outNs);
  outS = days;
  return time;
}
function truncNod(n: number, u: number): number {
  if (u > U.DAYS) unsupported("Unit is too large to be used for truncation");
  const un = UNIT_NANOS[u];
  if (NANOS_PER_DAY % un) unsupported("Unit must divide into a standard day without remainder");
  return floorDiv(n, un) * un;
}
const untilNanos = (ds: number, dn: number, u: number) => (BigInt(ds) * 1000000000n + BigInt(dn)) / BigInt(UNIT_NANOS[u]);

function mkLdt(date: JLocalDate, time: JLocalTime): JLocalDateTime { const l = new JLocalDateTime(); l.date = date; l.time = time; return l; }
const localEpoch = (l: JLocalDateTime) => epochDay(l.date) * 86400 + secOfDay(l.time);
function ldtOfEpoch(local: number, ns: number): JLocalDateTime {
  const days = floorDiv(local, 86400);
  return mkLdt(dateFromEpochDay(days), timeOfSod(local - days * 86400, ns));
}
const ldtCmp = (a: JLocalDateTime, b: JLocalDateTime) => dateCmp(a.date, b.date) || nanoOfDay(a.time) - nanoOfDay(b.time);
function mkInstant(s: number, ns = 0): JInstant {
  const i = new JInstant(), c = floorDiv(ns, 1e9);
  i.s = s + c; i.ns = ns - c * 1e9;
  return i;
}
const instantOfMs = (ms: number) => mkInstant(floorDiv(ms, 1000), floorMod(ms, 1000) * 1e6);
const instantMs = (i: JInstant) => i.s * 1000 + floorDiv(i.ns, 1e6);

// ── zones
const offsets = new Map<number, JZoneOffset>();
function offsetOf(secs: number): JZoneOffset {
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
function offsetHMS(h: number, m: number, s: number): JZoneOffset {
  if (h < -18 || h > 18) dtErr(`Zone offset hours not in valid range: value ${h} is not in the range -18 to 18`);
  if (h > 0 ? m < 0 || s < 0 : h < 0 ? m > 0 || s > 0 : m * s < 0) dtErr("Zone offset minutes and seconds must have the same sign as the hours");
  if (m < -59 || m > 59) dtErr(`Zone offset minutes not in valid range: value ${m} is not in the range -59 to 59`);
  if (s < -59 || s > 59) dtErr(`Zone offset seconds not in valid range: value ${s} is not in the range -59 to 59`);
  if (Math.abs(h) === 18 && (m || s)) dtErr("Zone offset not in valid range: -18:00 to +18:00");
  return offsetOf(h * 3600 + m * 60 + s);
}
/** ZoneOffset.of: Z, ±h, ±hh, ±hh:mm, ±hhmm, ±hh:mm:ss, ±hhmmss */
function parseOffsetId(id: string): JZoneOffset {
  if (id === "Z") return offsetOf(0);
  const m = /^([+-])(\d\d?)(?:(:?)(\d\d)(?:\3(\d\d))?)?$/.exec(id);
  if (!m || (m[2].length === 1 && m[4])) dtErr(`Invalid ID for ZoneOffset, invalid format: ${id}`);
  const sign = m![1] === "-" ? -1 : 1;
  return offsetHMS(sign * +m![2], sign * +(m![4] ?? 0), sign * +(m![5] ?? 0));
}
const zones = new Map<string, JZoneId>();
/** ZoneId.of: offsets, UTC/GMT/UT with an optional offset, and region ids Intl knows */
function zoneOf(id: string): JZoneId {
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
const sysZone = () => zoneOf(localTz.id);
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** the zone's offset in seconds at an epoch second */
function offsetAt(z: JZoneId, s: number): number {
  if (z.fixed !== null) return z.fixed;
  if (z.id === localTz.id) return -new Date(s * 1000).getTimezoneOffset() * 60;
  let f = offsetFormats.get(z.id);
  if (!f) offsetFormats.set(z.id, f = new Intl.DateTimeFormat("en-US", { timeZone: z.id, timeZoneName: "longOffset" }));
  const name = f.formatToParts(s * 1000).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /([+-])(\d\d):?(\d\d)?:?(\d\d)?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 3600 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0)) : 0;
}
/** the zone's standard offset: the smaller of the year's two extremes */
const standardOffset = (z: JZoneId, s: number) => {
  const y = dateFromEpochDay(floorDiv(s, 86400)).y;
  return Math.min(offsetAt(z, epochDay(mkDate(y, 1, 1)) * 86400), offsetAt(z, epochDay(mkDate(y, 7, 1)) * 86400));
};

function mkOdt(ldt: JLocalDateTime, off: JZoneOffset): JOffsetDateTime { const o = new JOffsetDateTime(); o.ldt = ldt; o.off = off; return o; }
function mkZdt(ldt: JLocalDateTime, off: JZoneOffset, zone: JZoneId): JZonedDateTime {
  const z = new JZonedDateTime(); z.ldt = ldt; z.off = off; z.zone = zone; return z;
}
const epochSec = (o: JOffsetBased) => localEpoch(o.ldt) - o.off.totalSeconds;
const odtOfEpoch = (s: number, ns: number, off: JZoneOffset) => mkOdt(ldtOfEpoch(s + off.totalSeconds, ns), off);
function zdtOfEpoch(s: number, ns: number, zone: JZoneId): JZonedDateTime {
  const off = offsetOf(offsetAt(zone, s));
  return mkZdt(ldtOfEpoch(s + off.totalSeconds, ns), off, zone);
}
/** ZonedDateTime.ofLocal: an overlap keeps the preferred offset (else the earlier one); a gap
 *  moves the time forward by the gap's length */
function zdtLocal(ldt: JLocalDateTime, zone: JZoneId, preferred?: JZoneOffset): JZonedDateTime {
  if (zone.fixed !== null) return mkZdt(ldt, offsetOf(zone.fixed), zone);
  const local = localEpoch(ldt), before = offsetAt(zone, local - 86400), after = offsetAt(zone, local + 86400);
  const vb = offsetAt(zone, local - before) === before, va = before === after ? vb : offsetAt(zone, local - after) === after;
  if (vb && (!va || preferred?.totalSeconds !== after)) return mkZdt(ldt, offsetOf(before), zone);
  if (va) return mkZdt(ldt, offsetOf(after), zone);
  return zdtOfEpoch(local - before, ldt.time.ns, zone);
}
function mkOffsetTime(time: JLocalTime, off: JZoneOffset): JOffsetTime { const o = new JOffsetTime(); o.time = time; o.off = off; return o; }
const ymOf = (y: number, mo: number) => { const m = new JYearMonth(); m.y = check("YEAR", y); m.mo = check("MONTH_OF_YEAR", mo); return m; };
const yearOf = (y: number) => { const v = new JYear(); v.y = check("YEAR", y); return v; };
function monthDayOf(mo: number, d: number): JMonthDay {
  check("MONTH_OF_YEAR", mo); check("DAY_OF_MONTH", d);
  if (d > (mo === 2 ? 29 : monthLen(2001, mo))) dtErr(`Illegal value for DayOfMonth field, value ${d} is not valid for month ${MONTHS[mo - 1].toUpperCase()}`);
  const m = new JMonthDay(); m.mo = mo; m.d = d; return m;
}

// ── Clock
class JClock extends JObj { zone = sysZone(); fixed: JInstant | null = null; offsetMs = 0; unavailable: string | null = null; }
const clockIn = (zone: JZoneId, fixed: JInstant | null = null, offsetMs = 0) => Object.assign(new JClock(), { zone, fixed, offsetMs });
export const unavailableClock = (message: string) => Object.assign(clockIn(offsetOf(0)), { unavailable: message });
function clockInstant(c: JClock): JInstant {
  if (c.unavailable) dtErr(c.unavailable);
  return c.fixed ? (c.offsetMs ? instantOfMs(instantMs(c.fixed) + c.offsetMs) : c.fixed) : instantOfMs(Date.now() + c.offsetMs);
}
/** now(Clock): an app-defined Clock answers through its own instant() and getZone() */
function withClock<R>(clock: unknown, f: (i: JInstant, z: JZoneId) => R): R | Promise<R> {
  if (!clock) npe("clock");
  if (clock instanceof JClock) return f(clockInstant(clock), clock.zone);
  return after(vcall(clock, "instant", "()Ljava/time/Instant;"), (i: JInstant) =>
    after(vcall(clock, "getZone", "()Ljava/time/ZoneId;"), (z: JZoneId) => f(i, z)));
}
const nowIn = (zone: JZoneId | null) => { if (!zone) npe("zone"); const i = instantOfMs(Date.now()); return zdtOfEpoch(i.s, i.ns, zone!); };

// ── accessors: every temporal reduces to the parts it carries
interface Parts { date?: JLocalDate; time?: JLocalTime; off?: JZoneOffset; zone?: JZoneId; inst?: JInstant; more?: Map<string, number> }
class JParsed extends JObj { declare p: Parts; }
function parts(t: unknown): Parts {
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
function fieldOf(p: Parts, f: string): number | undefined {
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
function instOf(p: Parts): JInstant | undefined {
  if (p.inst) return p.inst;
  if (!p.date || !p.time) return undefined;
  const ldt = mkLdt(p.date, p.time);
  if (p.off) return mkInstant(localEpoch(ldt) - p.off.totalSeconds, p.time.ns);
  if (p.zone) { const z = zdtLocal(ldt, p.zone); return mkInstant(epochSec(z), p.time.ns); }
  return undefined;
}
const describe = (t: unknown) => (t as any)?.constructor?.$i?.name?.replace(/\//g, ".") ?? String(t);
const cannot = (what: string, t: unknown): never => dtErr(`Unable to obtain ${what} from TemporalAccessor: ${describe(t)}`);
function toLocalDate(t: unknown): JLocalDate { if (t == null) npe("temporal"); return parts(t).date ?? cannot("LocalDate", t); }
function toLocalTime(t: unknown): JLocalTime { if (t == null) npe("temporal"); return parts(t).time ?? cannot("LocalTime", t); }
function toLdt(t: unknown): JLocalDateTime {
  if (t instanceof JLocalDateTime) return t;
  const p = parts(t);
  return p.date && p.time ? mkLdt(p.date, p.time) : cannot("LocalDateTime", t);
}
function toInstant(t: unknown): JInstant {
  if (t instanceof JInstant) return t;
  const p = parts(t), s = fieldOf(p, "INSTANT_SECONDS");
  return s === undefined ? cannot("Instant", t) : mkInstant(s, fieldOf(p, "NANO_OF_SECOND") ?? 0);
}
function toOffset(t: unknown): JZoneOffset { if (t == null) npe("temporal"); return parts(t).off ?? cannot("ZoneOffset", t); }
function toZone(t: unknown): JZoneId { if (t == null) npe("temporal"); const p = parts(t); return p.zone ?? p.off ?? cannot("ZoneId", t); }
function toZdt(t: unknown): JZonedDateTime {
  if (t instanceof JZonedDateTime) return t;
  const zone = toZone(t), p = parts(t), i = instOf(p);
  if (i) return zdtOfEpoch(i.s, i.ns, zone);
  return p.date && p.time ? zdtLocal(mkLdt(p.date, p.time), zone) : cannot("ZonedDateTime", t);
}
function toOdt(t: unknown): JOffsetDateTime {
  if (t instanceof JOffsetDateTime) return t;
  const off = toOffset(t), p = parts(t);
  if (p.date && p.time) return mkOdt(mkLdt(p.date, p.time), off);
  const i = instOf(p);
  return i ? odtOfEpoch(i.s, i.ns, off) : cannot("OffsetDateTime", t);
}
function toOffsetTime(t: unknown): JOffsetTime {
  if (t instanceof JOffsetTime) return t;
  const p = parts(t);
  return p.time && p.off ? mkOffsetTime(p.time, p.off) : cannot("OffsetTime", t);
}
function toYearMonth(t: unknown): JYearMonth {
  if (t instanceof JYearMonth) return t;
  const p = parts(t), y = fieldOf(p, "YEAR"), mo = fieldOf(p, "MONTH_OF_YEAR");
  return y !== undefined && mo !== undefined ? ymOf(y, mo) : cannot("YearMonth", t);
}

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
const isChrono = (e: unknown, cls: string): e is JSimpleEnum => e instanceof JSimpleEnum && (e.constructor as any).$i?.name === cls;
const isField = (f: unknown): f is JSimpleEnum => isChrono(f, TT + "ChronoField");
const isUnit = (u: unknown): u is JSimpleEnum => isChrono(u, TT + "ChronoUnit");
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
const accessorMethods: Methods = {
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
  if (a instanceof JDuration) {
    let r = a.s ? plusUnit(k, t, sign * a.s, chronoUnits[U.SECONDS]) as V : t;
    if (a.ns) r = plusUnit(k, r, sign * a.ns, chronoUnits[U.NANOS]) as V;
    return r;
  }
  if (a instanceof JPeriod) {
    let r = t;
    if (a.y && a.m) r = plusUnit(k, r, sign * (a.y * 12 + a.m), chronoUnits[U.MONTHS]) as V;
    else {
      if (a.y) r = plusUnit(k, r, sign * a.y, chronoUnits[U.YEARS]) as V;
      if (a.m) r = plusUnit(k, r, sign * a.m, chronoUnits[U.MONTHS]) as V;
    }
    return a.d ? plusUnit(k, r, sign * a.d, chronoUnits[U.DAYS]) : r;
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
function ordering<V>(desc: string, cmp: (a: V, b: V) => number, isCmp = cmp): Methods { return {
  "compareTo(Ljava/lang/Object;)I": function (this: V, o: V) { if (o == null) npe("other"); return Math.sign(cmp(this, o)); },
  [`compareTo(${desc})I`]: function (this: V, o: V) { if (o == null) npe("other"); return Math.sign(cmp(this, o)); },
  [`isAfter(${desc})Z`]: function (this: V, o: V) { return +(isCmp(this, o) > 0); },
  [`isBefore(${desc})Z`]: function (this: V, o: V) { return +(isCmp(this, o) < 0); },
  [`isEqual(${desc})Z`]: function (this: V, o: V) { return +(isCmp(this, o) === 0); },
}; }
function longHash(n: number): number {
  const b = BigInt.asUintN(64, BigInt(Math.trunc(n)));
  return Number(BigInt.asIntN(32, b ^ (b >> 32n)));
}
const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
const yearText = (y: number) => (Math.abs(y) < 1000 ? (y < 0 ? "-" : "") + pad(Math.abs(y), 4) : y > 9999 ? "+" + y : String(y));
const fracText = (ns: number) => (ns === 0 ? "" : ns % 1e6 === 0 ? "." + pad(ns / 1e6, 3) : ns % 1e3 === 0 ? "." + pad(ns / 1e3, 6) : "." + pad(ns, 9));
const dateText = (d: JLocalDate) => `${yearText(d.y)}-${pad(d.mo)}-${pad(d.d)}`;
const timeText = (t: JLocalTime) => `${pad(t.h)}:${pad(t.mi)}${t.s || t.ns ? ":" + pad(t.s) + fracText(t.ns) : ""}`;
const ldtText = (l: JLocalDateTime) => dateText(l.date) + "T" + timeText(l.time);
const dateHash = (d: JLocalDate) => (d.y & 0xfffff800) ^ ((d.y << 11) + (d.mo << 6) + d.d);
const ldtHash = (l: JLocalDateTime) => dateHash(l.date) ^ longHash(nanoOfDay(l.time));
/** parse(CharSequence[, DateTimeFormatter]) and from(TemporalAccessor) for one kind */
function parsers<V>(cls: string, iso: () => JDateTimeFormatter, from: (t: unknown) => V): Methods {
  const self = `L${cls};`, cs = "Ljava/lang/CharSequence;";
  return {
    [`static parse(${cs})${self}`]: (s: unknown) => dtfParse(iso(), s, from),
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
const lazyStatics = (values: Record<string, () => unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, make] of Object.entries(values)) Object.defineProperty(out, name, { get: make, enumerable: true });
  return out;
};

// ── enums
const dowNames = [...DAYS.slice(1), DAYS[0]].map((d) => d.toUpperCase());
const TEXT_STYLES = ["long", "long", "short", "short", "narrow", "narrow"] as const;
const tagOf = (l: JLocale | null | undefined) => localeTag(l ?? defaultLocale);
const dows: JSimpleEnum[] = mkEnumSet(T + "DayOfWeek", dowNames, {
  "getValue()I": function (this: JSimpleEnum) { return this.ord + 1; },
  [`static of(I)L${T}DayOfWeek;`]: (v: number) => (v >= 1 && v <= 7 ? dows[v - 1] : dtErr(`Invalid value for DayOfWeek: ${v}`)),
  [`static from(${ACCESSOR})L${T}DayOfWeek;`]: (t: unknown) => dows[(fieldOf(parts(t), "DAY_OF_WEEK") ?? cannot("DayOfWeek", t)) - 1],
  [`plus(J)L${T}DayOfWeek;`]: function (this: JSimpleEnum, n: bigint) { return dows[floorMod(this.ord + Number(n % 7n), 7)]; },
  [`minus(J)L${T}DayOfWeek;`]: function (this: JSimpleEnum, n: bigint) { return dows[floorMod(this.ord - Number(n % 7n), 7)]; },
  [`getDisplayName(L${T}format/TextStyle;Ljava/util/Locale;)Ljava/lang/String;`]: function (this: JSimpleEnum, s: JSimpleEnum, l: JLocale) {
    return names(tagOf(l), "weekday", TEXT_STYLES[s.ord])[this.ord];
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
    return names(tagOf(l), "month", TEXT_STYLES[s.ord])[this.ord];
  },
  ...accessorMethods, ...adjustIntoMethod,
}, [ACCESSOR.slice(1, -1), ADJUSTER.slice(1, -1)]);
mkEnumSet(T + "format/TextStyle", ["FULL", "FULL_STANDALONE", "SHORT", "SHORT_STANDALONE", "NARROW", "NARROW_STANDALONE"]);
mkEnumSet(T + "format/SignStyle", ["NORMAL", "ALWAYS", "NEVER", "NOT_NEGATIVE", "EXCEEDS_PAD"]);
mkEnumSet(T + "format/ResolverStyle", ["STRICT", "SMART", "LENIENT"]);
mkEnumSet(T + "format/FormatStyle", ["FULL", "LONG", "MEDIUM", "SHORT"]);
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
const chronoUnits: JSimpleEnum[] = mkEnumSet(TT + "ChronoUnit", Object.keys(U), {
  [`getDuration()L${T}Duration;`]: function (this: JSimpleEnum) {
    return this.ord < U.SECONDS ? mkDuration(0, UNIT_NANOS[this.ord]) : mkDuration(UNIT_SECONDS[this.ord], this.ord === U.FOREVER ? 999999999 : 0);
  },
  "isDurationEstimated()Z": function (this: JSimpleEnum) { return +(this.ord >= U.DAYS); },
  "isDateBased()Z": function (this: JSimpleEnum) { return +(this.ord >= U.DAYS && this.ord < U.FOREVER); },
  "isTimeBased()Z": function (this: JSimpleEnum) { return +(this.ord < U.DAYS); },
  "toString()Ljava/lang/String;": function (this: JSimpleEnum) { return this.ename.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(""); },
  [`between(${TEMPORAL}${TEMPORAL})J`]: function (this: JSimpleEnum, a: unknown, b: unknown) { return vcall(a, "until", `(${TEMPORAL}${UNIT})J`, b, this); },
  [`addTo(${TEMPORAL}J)${TEMPORAL}`]: function (this: JSimpleEnum, t: unknown, n: bigint) { return vcall(t, "plus", `(J${UNIT})${TEMPORAL}`, n, this); },
  [`isSupportedBy(${TEMPORAL})Z`]: function (this: JSimpleEnum, t: unknown) { return vcall(t, "isSupported", `(${UNIT})Z`, this); },
}, [UNIT.slice(1, -1)]);

class JValueRange extends JObj { min = 0; max = 0; }
const valueRange = (min: number, max: number) => Object.assign(new JValueRange(), { min, max });
rt.register({
  name: TT + "ValueRange", ctor: JValueRange, ifaces: ["java/io/Serializable"],
  methods: {
    [`static of(JJ)L${TT}ValueRange;`]: (a: bigint, b: bigint) => (a > b ? rt.mkThrowable("java/lang/IllegalArgumentException", "Minimum value must be less than maximum value") : valueRange(Number(a), Number(b))),
    "getMinimum()J": function (this: JValueRange) { return BigInt(this.min); },
    "getLargestMinimum()J": function (this: JValueRange) { return BigInt(this.min); },
    "getMaximum()J": function (this: JValueRange) { return BigInt(this.max); },
    "getSmallestMaximum()J": function (this: JValueRange) { return BigInt(this.max); },
    "isValidValue(J)Z": function (this: JValueRange, v: bigint) { return +(Number(v) >= this.min && Number(v) <= this.max); },
    "isValidIntValue(J)Z": function (this: JValueRange, v: bigint) { return +(this.min >= -(2 ** 31) && this.max < 2 ** 31 && Number(v) >= this.min && Number(v) <= this.max); },
    "isIntValue()Z": function (this: JValueRange) { return +(this.min >= -(2 ** 31) && this.max < 2 ** 31); },
    "isFixed()Z": () => 1,
    [`checkValidIntValue(J${FIELD})I`]: function (this: JValueRange, v: bigint, f: JSimpleEnum) {
      const n = Number(v);
      return n >= this.min && n <= this.max ? n : dtErr(`Invalid value for ${f ? camel(f.ename) : "value"} (valid values ${this.min} - ${this.max}): ${n}`);
    },
    [`checkValidValue(J${FIELD})J`]: function (this: JValueRange, v: bigint, f: JSimpleEnum) {
      const n = Number(v);
      return n >= this.min && n <= this.max ? v : dtErr(`Invalid value for ${f ? camel(f.ename) : "value"} (valid values ${this.min} - ${this.max}): ${n}`);
    },
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
  plus: (t, n, u) => timePlus(t, n, u), with: timeWith, from: toLocalTime, time: (t) => t,
  until: (t, e, u) => untilNanos(0, nanoOfDay(e) - nanoOfDay(t), u),
  trunc: (t, u) => (u === U.NANOS ? t : timeOfNod(truncNod(nanoOfDay(t), u))),
};
const LDT_KIND: Kind<JLocalDateTime> = {
  cls: T + "LocalDateTime", unitOk: (u) => u < U.FOREVER, from: toLdt, date: (l) => l.date, time: (l) => l.time,
  plus(l, n, u) {
    if (u >= U.DAYS) return mkLdt(datePlus(l.date, n, u), l.time);
    const time = timePlus(l.time, n, u);
    return mkLdt(outS ? datePlus(l.date, outS, U.DAYS) : l.date, time);
  },
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
  plus: (o, n, u) => mkOdt(LDT_KIND.plus(o.ldt, n, u), o.off),
  with: (o, f, v) => (f === "INSTANT_SECONDS" ? odtOfEpoch(v, o.ldt.time.ns, o.off) : f === "OFFSET_SECONDS" ? mkOdt(o.ldt, offsetOf(v)) : mkOdt(LDT_KIND.with(o.ldt, f, v), o.off)),
  until: (o, e, u) => LDT_KIND.until!(o.ldt, sameOffset(e, o.off).ldt, u),
  trunc: (o, u) => mkOdt(LDT_KIND.trunc!(o.ldt, u), o.off),
};
const ZDT_KIND: Kind<JZonedDateTime> = {
  cls: T + "ZonedDateTime", unitOk: (u) => u < U.FOREVER, from: toZdt, date: (z) => z.ldt.date, time: (z) => z.ldt.time,
  plus(z, n, u) {
    const l = LDT_KIND.plus(z.ldt, n, u);
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
  plus: (i, n, u) => { addUnits(i.s, i.ns, n, u); return mkInstant(outS, outNs); },
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

const instantCmp = (a: JOffsetBased, b: JOffsetBased) => epochSec(a) - epochSec(b) || a.ldt.time.ns - b.ldt.time.ns;
rt.register({
  name: T + "LocalDate", ctor: JLocalDate, ifaces: [CHRONO_DATE.slice(1, -1), "java/io/Serializable"],
  statics: lazyStatics({ MIN: () => mkDate(-999999999, 1, 1), MAX: () => mkDate(999999999, 12, 31), EPOCH: () => mkDate(1970, 1, 1) }),
  methods: {
    ...temporalMethods(DATE_KIND, [CHRONO_DATE], dateCmp, CHRONO_DATE),
    ...nowMethods(T + "LocalDate", (z) => z.ldt.date),
    ...parsers(T + "LocalDate", () => iso("ISO_LOCAL_DATE"), toLocalDate),
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
  name: T + "LocalTime", ctor: JLocalTime, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  statics: lazyStatics({ MIN: () => mkTime(0, 0), MIDNIGHT: () => mkTime(0, 0), NOON: () => mkTime(12, 0), MAX: () => mkTime(23, 59, 59, 999999999) }),
  methods: {
    ...temporalMethods(TIME_KIND, [], (a, b) => nanoOfDay(a) - nanoOfDay(b), `L${T}LocalTime;`),
    ...nowMethods(T + "LocalTime", (z) => z.ldt.time),
    ...parsers(T + "LocalTime", () => iso("ISO_LOCAL_TIME"), toLocalTime),
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
    ...parsers(T + "LocalDateTime", () => iso("ISO_LOCAL_DATE_TIME"), toLdt),
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
  name: T + "OffsetDateTime", ctor: JOffsetDateTime, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  methods: {
    ...temporalMethods(ODT_KIND, [], (a, b) => (a.off === b.off ? ldtCmp(a.ldt, b.ldt) : instantCmp(a, b) || ldtCmp(a.ldt, b.ldt)), `L${T}OffsetDateTime;`, instantCmp),
    ...offsetBasedMethods,
    ...nowMethods(T + "OffsetDateTime", (z) => mkOdt(z.ldt, z.off)),
    ...parsers(T + "OffsetDateTime", () => iso("ISO_OFFSET_DATE_TIME"), toOdt),
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
const zdtCmp = (a: JZonedDateTime, b: JZonedDateTime) => instantCmp(a, b) || ldtCmp(a.ldt, b.ldt) || (a.zone.id < b.zone.id ? -1 : a.zone.id > b.zone.id ? 1 : 0);
rt.register({
  name: T + "ZonedDateTime", ctor: JZonedDateTime, ifaces: [CHRONO_ZDT.slice(1, -1), "java/io/Serializable"],
  methods: {
    ...temporalMethods(ZDT_KIND, [CHRONO_ZDT], zdtCmp, CHRONO_ZDT, instantCmp),
    ...offsetBasedMethods,
    [`toLocalDateTime()${CHRONO_LDT}`]: function (this: JZonedDateTime) { return this.ldt; },
    [`toLocalDate()${CHRONO_DATE}`]: function (this: JZonedDateTime) { return this.ldt.date; },
    ...nowMethods(T + "ZonedDateTime", (z) => z),
    ...parsers(T + "ZonedDateTime", () => iso("ISO_ZONED_DATE_TIME"), toZdt),
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
const zoneHash = (z: JZoneId) => (z instanceof JZoneOffset ? z.totalSeconds : stringHash(z.id));
const otCmp = (a: JOffsetTime, b: JOffsetTime) => (nanoOfDay(a.time) - a.off.totalSeconds * 1e9) - (nanoOfDay(b.time) - b.off.totalSeconds * 1e9);
rt.register({
  name: T + "OffsetTime", ctor: JOffsetTime, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  methods: {
    ...temporalMethods(OFFSET_TIME_KIND, [], (a, b) => otCmp(a, b) || nanoOfDay(a.time) - nanoOfDay(b.time), `L${T}OffsetTime;`, otCmp),
    ...nowMethods(T + "OffsetTime", (z) => mkOffsetTime(z.ldt.time, z.off)),
    ...parsers(T + "OffsetTime", () => iso("ISO_OFFSET_TIME"), toOffsetTime),
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
const instantText = (i: JInstant) => {
  const l = ldtOfEpoch(i.s, 0), t = l.time;
  return `${dateText(l.date)}T${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}${fracText(i.ns)}Z`;
};
rt.register({
  name: T + "Instant", ctor: JInstant, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  statics: lazyStatics({ EPOCH: () => mkInstant(0), MIN: () => mkInstant(-31557014167219200), MAX: () => mkInstant(31556889864403199, 999999999) }),
  methods: {
    ...temporalMethods(INSTANT_KIND, [], (a, b) => a.s - b.s || a.ns - b.ns, `L${T}Instant;`),
    [`static now()L${T}Instant;`]: () => instantOfMs(Date.now()),
    [`static now(L${T}Clock;)L${T}Instant;`]: (c: unknown) => (c instanceof JClock ? clockInstant(c) : c == null ? npe("clock") : vcall(c, "instant", `()L${T}Instant;`)),
    ...parsers(T + "Instant", () => iso("ISO_INSTANT"), toInstant),
    [`static ofEpochMilli(J)L${T}Instant;`]: (ms: bigint) => instantOfMs(Number(ms)),
    [`static ofEpochSecond(J)L${T}Instant;`]: (s: bigint) => mkInstant(Number(s)),
    [`static ofEpochSecond(JJ)L${T}Instant;`]: (s: bigint, ns: bigint) => { addUnits(Number(s), 0, Number(ns), U.NANOS); return mkInstant(outS, outNs); },
    "toEpochMilli()J": function (this: JInstant) { return BigInt(this.s) * 1000n + BigInt(floorDiv(this.ns, 1e6)); },
    "getEpochSecond()J": function (this: JInstant) { return BigInt(this.s); },
    [`atOffset(L${T}ZoneOffset;)L${T}OffsetDateTime;`]: function (this: JInstant, o: JZoneOffset) { return odtOfEpoch(this.s, this.ns, o ?? npe("offset")); },
    [`atZone(L${T}ZoneId;)L${T}ZonedDateTime;`]: function (this: JInstant, z: JZoneId) { return zdtOfEpoch(this.s, this.ns, z ?? npe("zone")); },
    ...adjustIntoMethod,
    "equals(Ljava/lang/Object;)Z": function (this: JInstant, o: unknown) { return +(o instanceof JInstant && o.s === this.s && o.ns === this.ns); },
    "hashCode()I": function (this: JInstant) { return (longHash(this.s) + 51 * this.ns) | 0; },
    "toString()Ljava/lang/String;": function (this: JInstant) { return instantText(this); },
  },
});
rt.register({
  name: T + "YearMonth", ctor: JYearMonth, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  methods: {
    ...temporalMethods(YM_KIND, [], (a, b) => a.y - b.y || a.mo - b.mo, `L${T}YearMonth;`),
    ...nowMethods(T + "YearMonth", (z) => ymOf(z.ldt.date.y, z.ldt.date.mo)),
    ...parsers(T + "YearMonth", () => iso("YEAR_MONTH"), toYearMonth),
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
  name: T + "Year", ctor: JYear, ifaces: [TEMPORAL.slice(1, -1), ADJUSTER.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  statics: { MIN_VALUE: -999999999, MAX_VALUE: 999999999 },
  methods: {
    ...accessorMethods, ...adjustIntoMethod,
    ...nowMethods(T + "Year", (z) => yearOf(z.ldt.date.y)),
    [`static of(I)L${T}Year;`]: yearOf,
    [`static from(${ACCESSOR})L${T}Year;`]: (t: unknown) => (t instanceof JYear ? t : yearOf(fieldOf(parts(t), "YEAR") ?? cannot("Year", t))),
    [`static parse(Ljava/lang/CharSequence;)L${T}Year;`]: (s: unknown) => dtfParse(iso("YEAR"), s, (t) => yearOf(fieldOf(parts(t), "YEAR") ?? cannot("Year", t))),
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

// ── zones, rules and clocks
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
      Object.assign(clockIn(c.zone, c.fixed, c.offsetMs + d.s * 1000 + floorDiv(d.ns, 1e6)), { unavailable: c.unavailable }),
    [`instant()L${T}Instant;`]: function (this: JClock) { return clockInstant(this); },
    "millis()J": function (this: JClock) { return BigInt(instantMs(clockInstant(this))); },
    [`getZone()L${T}ZoneId;`]: function (this: JClock) { return this.zone; },
    [`withZone(L${T}ZoneId;)L${T}Clock;`]: function (this: JClock, z: JZoneId) { return Object.assign(clockIn(z, this.fixed, this.offsetMs), { unavailable: this.unavailable }); },
  },
});

// ── amounts
function mkDuration(s: number, ns: number): JDuration {
  const d = new JDuration(), c = floorDiv(ns, 1e9);
  d.s = s + c; d.ns = ns - c * 1e9;
  return d;
}
const durationOfNanos = (n: bigint) => { const s = n / 1000000000n, r = n % 1000000000n; return mkDuration(Number(s), Number(r)); };
const durNanos = (d: JDuration) => BigInt(d.s) * 1000000000n + BigInt(d.ns);
function durationOf(n: number, u: unknown): JDuration {
  if (!isUnit(u)) return u == null ? npe("unit") : dtErr("Unit must not have an estimated duration");
  if (u.ord < U.SECONDS) return durationOfNanos(BigInt(n) * BigInt(UNIT_NANOS[u.ord]));
  if (u.ord > U.DAYS) unsupported("Unit must not have an estimated duration");
  return mkDuration(n * UNIT_SECONDS[u.ord], 0);
}
function durationText(d: JDuration): string {
  if (!d.s && !d.ns) return "PT0S";
  const total = d.s < 0 && d.ns > 0 ? d.s + 1 : d.s;
  const h = Math.trunc(total / 3600), m = Math.trunc((total % 3600) / 60), s = total % 60;
  let out = "PT" + (h ? h + "H" : "") + (m ? m + "M" : "");
  if (s === 0 && d.ns === 0 && out.length > 2) return out;
  out += d.s < 0 && d.ns > 0 && s === 0 ? "-0" : String(s);
  if (d.ns > 0) out += "." + String(d.s < 0 ? 2e9 - d.ns : d.ns + 1e9).slice(1).replace(/0+$/, "");
  return out + "S";
}
function parseDuration(text: string): JDuration {
  const m = /^([-+]?)P(?:([-+]?\d+)D)?(T(?:([-+]?\d+)H)?(?:([-+]?\d+)M)?(?:([-+]?)(\d+)(?:[.,](\d{0,9}))?S)?)?$/i.exec(text);
  if (!m || m[3] === "T" || (!m[2] && !m[3])) throw rt.mkThrowable(T + "format/DateTimeParseException", `Text cannot be parsed to a Duration`);
  const neg = m[1] === "-" ? -1n : 1n, secSign = m[6] === "-" ? -1n : 1n;
  const secs = BigInt(m[2] ?? 0) * 86400n + BigInt(m[4] ?? 0) * 3600n + BigInt(m[5] ?? 0) * 60n + secSign * BigInt(m[7] ?? 0);
  const nanos = secSign * BigInt((m[8] ?? "").padEnd(9, "0") || 0);
  return durationOfNanos(neg * (secs * 1000000000n + nanos));
}
const durationUnitsMethods = (): Methods => {
  const m: Methods = {};
  for (const [name, u] of [["Days", U.DAYS], ["Hours", U.HOURS], ["Minutes", U.MINUTES], ["Seconds", U.SECONDS], ["Millis", U.MILLIS], ["Nanos", U.NANOS]] as const) {
    m[`static of${name}(J)L${T}Duration;`] = (n: bigint) => durationOf(Number(n), chronoUnits[u]);
    m[`plus${name}(J)L${T}Duration;`] = function (this: JDuration, n: bigint) { const d = durationOf(Number(n), chronoUnits[u]); return mkDuration(this.s + d.s, this.ns + d.ns); };
    m[`minus${name}(J)L${T}Duration;`] = function (this: JDuration, n: bigint) { const d = durationOf(Number(n), chronoUnits[u]); return mkDuration(this.s - d.s, this.ns - d.ns); };
  }
  const t = (d: JDuration, unit: number) => Math.trunc(d.s / unit);
  Object.assign(m, {
    "toDays()J": function (this: JDuration) { return BigInt(t(this, 86400)); },
    "toHours()J": function (this: JDuration) { return BigInt(t(this, 3600)); },
    "toMinutes()J": function (this: JDuration) { return BigInt(t(this, 60)); },
    "toSeconds()J": function (this: JDuration) { return BigInt(this.s); },
    "toMillis()J": function (this: JDuration) { return BigInt(this.s) * 1000n + BigInt(floorDiv(this.ns, 1e6)); },
    "toNanos()J": function (this: JDuration) { return durNanos(this); },
    "toDaysPart()J": function (this: JDuration) { return BigInt(t(this, 86400)); },
    "toHoursPart()I": function (this: JDuration) { return t(this, 3600) % 24; },
    "toMinutesPart()I": function (this: JDuration) { return t(this, 60) % 60; },
    "toSecondsPart()I": function (this: JDuration) { return this.s % 60; },
    "toMillisPart()I": function (this: JDuration) { return floorDiv(this.ns, 1e6); },
    "toNanosPart()I": function (this: JDuration) { return this.ns; },
  });
  return m;
};
rt.register({
  name: T + "Duration", ctor: JDuration, ifaces: [AMOUNT.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  statics: lazyStatics({ ZERO: () => mkDuration(0, 0) }),
  methods: {
    ...durationUnitsMethods(),
    [`static ofSeconds(JJ)L${T}Duration;`]: (s: bigint, ns: bigint) => { addUnits(Number(s), 0, Number(ns), U.NANOS); return mkDuration(outS, outNs); },
    [`static of(J${UNIT})L${T}Duration;`]: (n: bigint, u: unknown) => durationOf(Number(n), u),
    [`static from(${AMOUNT})L${T}Duration;`]: (a: unknown) => (a instanceof JDuration ? a : dtErr("Unit must not have an estimated duration")),
    [`static between(${TEMPORAL}${TEMPORAL})L${T}Duration;`]: (a: unknown, b: unknown) =>
      after(vcall(a, "until", `(${TEMPORAL}${UNIT})J`, b, chronoUnits[U.NANOS]), (n: bigint) => durationOfNanos(n)),
    [`static parse(Ljava/lang/CharSequence;)L${T}Duration;`]: (s: unknown) => after(csText(s ?? npe("text")), parseDuration),
    "getSeconds()J": function (this: JDuration) { return BigInt(this.s); },
    "getNano()I": function (this: JDuration) { return this.ns; },
    [`get(${UNIT})J`]: function (this: JDuration, u: JSimpleEnum) { return u?.ord === U.SECONDS ? BigInt(this.s) : u?.ord === U.NANOS ? BigInt(this.ns) : noUnit(u); },
    "getUnits()Ljava/util/List;": () => newArrayList([chronoUnits[U.SECONDS], chronoUnits[U.NANOS]]),
    [`plus(L${T}Duration;)L${T}Duration;`]: function (this: JDuration, d: JDuration) { return mkDuration(this.s + (d ?? npe("duration")).s, this.ns + d.ns); },
    [`minus(L${T}Duration;)L${T}Duration;`]: function (this: JDuration, d: JDuration) { return mkDuration(this.s - (d ?? npe("duration")).s, this.ns - d.ns); },
    [`plus(J${UNIT})L${T}Duration;`]: function (this: JDuration, n: bigint, u: unknown) { const d = durationOf(Number(n), u); return mkDuration(this.s + d.s, this.ns + d.ns); },
    [`minus(J${UNIT})L${T}Duration;`]: function (this: JDuration, n: bigint, u: unknown) { const d = durationOf(Number(n), u); return mkDuration(this.s - d.s, this.ns - d.ns); },
    [`multipliedBy(J)L${T}Duration;`]: function (this: JDuration, n: bigint) { return durationOfNanos(durNanos(this) * n); },
    [`dividedBy(J)L${T}Duration;`]: function (this: JDuration, n: bigint) { if (!n) throw rt.mkThrowable("java/lang/ArithmeticException", "Cannot divide by zero"); return durationOfNanos(durNanos(this) / n); },
    [`dividedBy(L${T}Duration;)J`]: function (this: JDuration, d: JDuration) {
      const n = durNanos(d ?? npe("divisor"));
      if (!n) throw rt.mkThrowable("java/lang/ArithmeticException", "Cannot divide by zero");
      return durNanos(this) / n;
    },
    [`negated()L${T}Duration;`]: function (this: JDuration) { return mkDuration(-this.s, -this.ns); },
    [`abs()L${T}Duration;`]: function (this: JDuration) { return this.s < 0 ? mkDuration(-this.s, -this.ns) : this; },
    [`withSeconds(J)L${T}Duration;`]: function (this: JDuration, s: bigint) { return mkDuration(Number(s), this.ns); },
    [`withNanos(I)L${T}Duration;`]: function (this: JDuration, ns: number) { return mkDuration(this.s, check("NANO_OF_SECOND", ns)); },
    [`truncatedTo(${UNIT})L${T}Duration;`]: function (this: JDuration, u: unknown) {
      if (!isUnit(u) || u.ord > U.DAYS) return unsupported("Unit is too large to be used for truncation");
      const unit = BigInt(UNIT_NANOS[u.ord]);
      return durationOfNanos(durNanos(this) / unit * unit);
    },
    "isNegative()Z": function (this: JDuration) { return +(this.s < 0); },
    "isZero()Z": function (this: JDuration) { return +(this.s === 0 && this.ns === 0); },
    "isPositive()Z": function (this: JDuration) { return +(this.s > 0 || (this.s === 0 && this.ns > 0)); },
    [`addTo(${TEMPORAL})${TEMPORAL}`]: function (this: JDuration, t: unknown) {
      return after(this.s ? vcall(t, "plus", `(J${UNIT})${TEMPORAL}`, BigInt(this.s), chronoUnits[U.SECONDS]) : t, (r) =>
        this.ns ? vcall(r, "plus", `(J${UNIT})${TEMPORAL}`, BigInt(this.ns), chronoUnits[U.NANOS]) : r);
    },
    [`subtractFrom(${TEMPORAL})${TEMPORAL}`]: function (this: JDuration, t: unknown) {
      return after(this.s ? vcall(t, "minus", `(J${UNIT})${TEMPORAL}`, BigInt(this.s), chronoUnits[U.SECONDS]) : t, (r) =>
        this.ns ? vcall(r, "minus", `(J${UNIT})${TEMPORAL}`, BigInt(this.ns), chronoUnits[U.NANOS]) : r);
    },
    ...ordering(`L${T}Duration;`, (a: JDuration, b: JDuration) => a.s - b.s || a.ns - b.ns),
    "equals(Ljava/lang/Object;)Z": function (this: JDuration, o: unknown) { return +(o instanceof JDuration && o.s === this.s && o.ns === this.ns); },
    "hashCode()I": function (this: JDuration) { return (longHash(this.s) + 51 * this.ns) | 0; },
    "toString()Ljava/lang/String;": function (this: JDuration) { return durationText(this); },
  },
});
const periodOf = (y: number, m: number, d: number) => { const p = new JPeriod(); p.y = y; p.m = m; p.d = d; return p; };
function periodBetween(a: JLocalDate, b: JLocalDate): JPeriod {
  let months = (b.y * 12 + b.mo) - (a.y * 12 + a.mo), days = b.d - a.d;
  if (months > 0 && days < 0) { months--; days = epochDay(b) - epochDay(datePlus(a, months, U.MONTHS)); }
  else if (months < 0 && days > 0) { months++; days -= monthLen(b.y, b.mo); }
  return periodOf(Math.trunc(months / 12), months % 12, days);
}
function parsePeriod(text: string): JPeriod {
  const m = /^([-+]?)P(?:([-+]?\d+)Y)?(?:([-+]?\d+)M)?(?:([-+]?\d+)W)?(?:([-+]?\d+)D)?$/i.exec(text);
  if (!m || m.slice(2).every((g) => g === undefined)) throw rt.mkThrowable(T + "format/DateTimeParseException", "Text cannot be parsed to a Period");
  const s = m[1] === "-" ? -1 : 1;
  return periodOf(s * +(m[2] ?? 0), s * +(m[3] ?? 0), s * (+(m[4] ?? 0) * 7 + +(m[5] ?? 0)));
}
const periodText = (p: JPeriod) => (p.y || p.m || p.d ? `P${p.y ? p.y + "Y" : ""}${p.m ? p.m + "M" : ""}${p.d ? p.d + "D" : ""}` : "P0D");
const PERIOD_PARTS: [string, keyof JPeriod & ("y" | "m" | "d")][] = [["Years", "y"], ["Months", "m"], ["Days", "d"]];
rt.register({
  name: T + "Period", ctor: JPeriod, ifaces: [AMOUNT.slice(1, -1), "java/io/Serializable"],
  statics: lazyStatics({ ZERO: () => periodOf(0, 0, 0) }),
  methods: {
    [`static of(III)L${T}Period;`]: periodOf,
    [`static ofWeeks(I)L${T}Period;`]: (w: number) => periodOf(0, 0, w * 7),
    [`static between(L${T}LocalDate;L${T}LocalDate;)L${T}Period;`]: periodBetween,
    [`static parse(Ljava/lang/CharSequence;)L${T}Period;`]: (s: unknown) => after(csText(s ?? npe("text")), parsePeriod),
    [`static from(${AMOUNT})L${T}Period;`]: (a: unknown) => (a instanceof JPeriod ? a : dtErr("Unable to obtain Period from TemporalAmount")),
    ...Object.fromEntries(PERIOD_PARTS.flatMap(([name, k]) => [
      [`static of${name}(I)L${T}Period;`, (n: number) => periodOf(k === "y" ? n : 0, k === "m" ? n : 0, k === "d" ? n : 0)],
      [`get${name}()I`, function (this: JPeriod) { return this[k]; }],
      [`with${name}(I)L${T}Period;`, function (this: JPeriod, n: number) { return Object.assign(periodOf(this.y, this.m, this.d), { [k]: n }); }],
      [`plus${name}(J)L${T}Period;`, function (this: JPeriod, n: bigint) { return Object.assign(periodOf(this.y, this.m, this.d), { [k]: this[k] + Number(n) }); }],
      [`minus${name}(J)L${T}Period;`, function (this: JPeriod, n: bigint) { return Object.assign(periodOf(this.y, this.m, this.d), { [k]: this[k] - Number(n) }); }],
    ])),
    [`plus(${AMOUNT})L${T}Period;`]: function (this: JPeriod, a: JPeriod) { const o = periodFrom(a); return periodOf(this.y + o.y, this.m + o.m, this.d + o.d); },
    [`minus(${AMOUNT})L${T}Period;`]: function (this: JPeriod, a: JPeriod) { const o = periodFrom(a); return periodOf(this.y - o.y, this.m - o.m, this.d - o.d); },
    [`multipliedBy(I)L${T}Period;`]: function (this: JPeriod, n: number) { return periodOf(this.y * n, this.m * n, this.d * n); },
    [`negated()L${T}Period;`]: function (this: JPeriod) { return periodOf(-this.y, -this.m, -this.d); },
    [`normalized()L${T}Period;`]: function (this: JPeriod) { const t = this.y * 12 + this.m; return periodOf(Math.trunc(t / 12), t % 12, this.d); },
    "toTotalMonths()J": function (this: JPeriod) { return BigInt(this.y * 12 + this.m); },
    [`get(${UNIT})J`]: function (this: JPeriod, u: JSimpleEnum) {
      return BigInt(u?.ord === U.YEARS ? this.y : u?.ord === U.MONTHS ? this.m : u?.ord === U.DAYS ? this.d : noUnit(u));
    },
    "getUnits()Ljava/util/List;": () => newArrayList([chronoUnits[U.YEARS], chronoUnits[U.MONTHS], chronoUnits[U.DAYS]]),
    "isZero()Z": function (this: JPeriod) { return +!(this.y || this.m || this.d); },
    "isNegative()Z": function (this: JPeriod) { return +(this.y < 0 || this.m < 0 || this.d < 0); },
    [`addTo(${TEMPORAL})${TEMPORAL}`]: function (this: JPeriod, t: unknown) { return periodApply(this, t, "plus"); },
    [`subtractFrom(${TEMPORAL})${TEMPORAL}`]: function (this: JPeriod, t: unknown) { return periodApply(this, t, "minus"); },
    "equals(Ljava/lang/Object;)Z": function (this: JPeriod, o: unknown) { return +(o instanceof JPeriod && o.y === this.y && o.m === this.m && o.d === this.d); },
    "hashCode()I": function (this: JPeriod) { return (this.y + rotl(this.m, 8) + rotl(this.d, 16)) | 0; },
    "toString()Ljava/lang/String;": function (this: JPeriod) { return periodText(this); },
  },
});
const periodFrom = (a: unknown) => (a instanceof JPeriod ? a : a == null ? npe("amount") : dtErr("Unable to obtain Period from TemporalAmount"));
function periodApply(p: JPeriod, t: unknown, op: "plus" | "minus"): unknown {
  const steps: [number, number][] = p.y && p.m ? [[p.y * 12 + p.m, U.MONTHS]] : [[p.y, U.YEARS], [p.m, U.MONTHS]];
  steps.push([p.d, U.DAYS]);
  let r: unknown = t;
  for (const [n, u] of steps) if (n) r = after(r, (x) => vcall(x, op, `(J${UNIT})${TEMPORAL}`, BigInt(n), chronoUnits[u]));
  return r;
}

// ── chronology and decimal style: the ISO calendar and ASCII digits are all this runtime offers
class JIsoChronology extends JObj {}
const isoChronology = new JIsoChronology();
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
/** the locale's first day of week (1 = Monday) and minimal days in the first week, from Intl */
const weekMemo = new Map<string, [number, number]>();
function weekInfo(tag: string): [number, number] {
  let w = weekMemo.get(tag);
  if (!w) weekMemo.set(tag, w = readWeekInfo(tag));
  return w;
}
function readWeekInfo(tag: string): [number, number] {
  try {
    const l = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay: number; minimalDays: number }; weekInfo?: { firstDay: number; minimalDays: number } };
    const w = l.getWeekInfo?.() ?? l.weekInfo;
    if (w) return [w.firstDay, w.minimalDays];
  } catch { /* unknown tag */ }
  return [1, 4];
}
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

// ── DateTimeFormatter and SimpleDateFormat: one pattern engine over the same field model
type Style = "long" | "short" | "narrow";
type Tok =
  | { k: "lit"; s: string }
  | { k: "val"; f: string; min: number; max: number; sign: number; pmin: number; base?: number }
  | { k: "text"; f: string; style: Style }
  | { k: "frac"; min: number; max: number; dot: boolean }
  | { k: "off"; type: number; none: string }
  | { k: "loff"; full: boolean }
  | { k: "zid"; region: boolean }
  | { k: "zname"; full: boolean }
  | { k: "inst" }
  | { k: "opt"; toks: Tok[] }
  | { k: "ci"; on: boolean };
const SIGN = { NORMAL: 0, ALWAYS: 1, NEVER: 2, NOT_NEGATIVE: 3, EXCEEDS_PAD: 4 } as const;
/** SimpleDateFormat's two-digit years fall within 80 years before and 20 after now */
const SDF_CENTURY = -1;
const OFFSET_TYPES = ["+HH", "+HHmm", "+HH:mm", "+HHMM", "+HH:MM", "+HHMMss", "+HH:MM:ss", "+HHMMSS", "+HH:MM:SS"];
const iae = (msg: string): never => { throw rt.mkThrowable("java/lang/IllegalArgumentException", msg); };
const val = (f: string, min: number, max = 19, sign: number = SIGN.NORMAL, pmin = min): Tok => ({ k: "val", f, min, max, sign, pmin });
const textStyle = (n: number): Style => (n <= 3 ? "short" : n === 4 ? "long" : "narrow");
// pattern letters shared by both engines: [ChronoField, DTF max count]
const NUMERIC: Record<string, string> = {
  d: "DAY_OF_MONTH", h: "CLOCK_HOUR_OF_AMPM", H: "HOUR_OF_DAY", k: "CLOCK_HOUR_OF_DAY", K: "HOUR_OF_AMPM", m: "MINUTE_OF_HOUR", s: "SECOND_OF_MINUTE",
};
/** a DateTimeFormatter pattern letter run (DateTimeFormatterBuilder.appendPattern) */
function dtfLetter(c: string, n: number): Tok {
  const tooMany = (): never => iae(`Too many pattern letters: ${c}`);
  if (NUMERIC[c]) return n === 1 ? val(NUMERIC[c], 1) : n === 2 ? val(NUMERIC[c], 2, 2) : tooMany();
  switch (c) {
    case "G": return n > 5 ? tooMany() : { k: "text", f: "ERA", style: textStyle(n) };
    case "y": case "u": case "Y": {
      const f = c === "u" ? "YEAR" : "YEAR_OF_ERA";
      return n === 2 ? { ...val(f, 2, 2), base: 2000 } as Tok : val(f, n, 19, n < 4 ? SIGN.NORMAL : SIGN.EXCEEDS_PAD);
    }
    case "Q": case "q": return n <= 2 ? val("QUARTER", n, n === 1 ? 19 : 2) : n <= 5 ? { k: "text", f: "QUARTER", style: textStyle(n) } : tooMany();
    case "M": case "L": return n === 1 ? val("MONTH_OF_YEAR", 1) : n === 2 ? val("MONTH_OF_YEAR", 2, 2) : n <= 5 ? { k: "text", f: "MONTH_OF_YEAR", style: textStyle(n) } : tooMany();
    case "D": return n === 1 ? val("DAY_OF_YEAR", 1) : n === 2 ? val("DAY_OF_YEAR", 2, 3, SIGN.NOT_NEGATIVE) : n === 3 ? val("DAY_OF_YEAR", 3, 3) : tooMany();
    case "F": return n === 1 ? val("ALIGNED_DAY_OF_WEEK_IN_MONTH", 1) : tooMany();
    case "E": return n <= 5 ? { k: "text", f: "DAY_OF_WEEK", style: textStyle(n) } : tooMany();
    case "e": case "c": return n <= 2 ? val("LOCAL_DAY_OF_WEEK", n, n) : n <= 5 ? { k: "text", f: "DAY_OF_WEEK", style: textStyle(n) } : tooMany();
    case "w": return n <= 2 ? val("WEEK_OF_YEAR", n, 2) : tooMany();
    case "W": return n === 1 ? val("WEEK_OF_MONTH", 1) : tooMany();
    case "a": return n === 1 ? { k: "text", f: "AMPM_OF_DAY", style: "short" } : tooMany();
    case "S": return { k: "frac", min: n, max: n, dot: false };
    case "A": return val("MILLI_OF_DAY", n);
    case "n": return val("NANO_OF_SECOND", n);
    case "N": return val("NANO_OF_DAY", n);
    case "V": return n === 2 ? { k: "zid", region: false } : iae("Pattern letter count must be 2: V");
    case "z": return n <= 4 ? { k: "zname", full: n === 4 } : tooMany();
    case "v": return n === 1 || n === 4 ? { k: "zname", full: n === 4 } : iae("Wrong number of pattern letters: v");
    case "O": return n === 1 || n === 4 ? { k: "loff", full: n === 4 } : iae("Pattern letter count must be 1 or 4: O");
    case "X": case "x": return n <= 5 ? { k: "off", type: [1, 3, 4, 5, 6][n - 1], none: c === "X" ? "Z" : ["+00", "+0000", "+00:00", "+0000", "+00:00"][n - 1] } : tooMany();
    case "Z": return n <= 3 ? { k: "off", type: 3, none: "+0000" } : n === 4 ? { k: "loff", full: true } : n === 5 ? { k: "off", type: 6, none: "Z" } : tooMany();
  }
  return iae(`Unknown pattern letter: ${c}`);
}
/** a java.text.SimpleDateFormat pattern letter run: counts are minimum widths, parsing is lenient */
function sdfLetter(c: string, n: number): Tok {
  if (NUMERIC[c]) return val(NUMERIC[c], n, 19, SIGN.NORMAL, 1);
  switch (c) {
    case "G": return { k: "text", f: "ERA", style: n >= 4 ? "long" : "short" };
    case "y": case "Y": return n === 2 ? { ...val("YEAR_OF_ERA", 2, 19, SIGN.NORMAL, 1), base: SDF_CENTURY } as Tok : val("YEAR_OF_ERA", n, 19, SIGN.NORMAL, 1);
    case "M": case "L": return n >= 3 ? { k: "text", f: "MONTH_OF_YEAR", style: n >= 4 ? "long" : "short" } : val("MONTH_OF_YEAR", n, 19, SIGN.NORMAL, 1);
    case "w": return val("WEEK_OF_YEAR", n, 19, SIGN.NORMAL, 1);
    case "W": return val("WEEK_OF_MONTH", n, 19, SIGN.NORMAL, 1);
    case "D": return val("DAY_OF_YEAR", n, 19, SIGN.NORMAL, 1);
    case "F": return val("DAY_OF_WEEK_IN_MONTH", n, 19, SIGN.NORMAL, 1);
    case "E": return { k: "text", f: "DAY_OF_WEEK", style: n >= 4 ? "long" : "short" };
    case "u": return val("DAY_OF_WEEK", n, 19, SIGN.NORMAL, 1);
    case "a": return { k: "text", f: "AMPM_OF_DAY", style: "short" };
    case "S": return val("MILLI_OF_SECOND", n, 19, SIGN.NORMAL, 1);
    case "z": return { k: "zname", full: n >= 4 };
    case "Z": return n === 4 ? { k: "loff", full: true } : n === 5 ? { k: "off", type: 4, none: "Z" } : { k: "off", type: 3, none: "+0000" };
    case "X": return n <= 3 ? { k: "off", type: [0, 3, 4][n - 1], none: "Z" } : iae("invalid ISO 8601 format: length=" + n);
  }
  return iae(`Unknown pattern character '${c}'`);
}
function compilePattern(p: string, sdf: boolean): Tok[] {
  const root: Tok[] = [], stack = [root];
  let cur = root;
  for (let i = 0; i < p.length;) {
    const c = p[i];
    if (c === "'") {
      let j = i + 1, s = "";
      for (;;) {
        if (j >= p.length) { if (!sdf) iae(`Pattern ends with an incomplete string literal: ${p}`); break; }
        if (p[j] === "'") { if (p[j + 1] !== "'") { j++; break; } s += "'"; j += 2; continue; }
        s += p[j++];
      }
      cur.push({ k: "lit", s: s || "'" });
      i = j;
    } else if (!sdf && c === "[") {
      const opt: Tok = { k: "opt", toks: [] };
      cur.push(opt);
      stack.push(cur = opt.toks);
      i++;
    } else if (!sdf && c === "]") {
      if (stack.length === 1) iae("Pattern invalid as it contains ] without previous [");
      stack.pop();
      cur = stack[stack.length - 1];
      i++;
    } else if (/[A-Za-z]/.test(c)) {
      let n = 1;
      while (p[i + n] === c) n++;
      cur.push(sdf ? sdfLetter(c, n) : dtfLetter(c, n));
      i += n;
    } else {
      if (!sdf && (c === "{" || c === "}" || c === "#")) iae(`Pattern includes reserved character: '${c}'`);
      cur.push({ k: "lit", s: c });
      i++;
    }
  }
  return root;
}

const nameMemo = new Map<string, string[]>();
/** localized month/weekday (Monday first)/era/AM-PM names, from Intl */
function names(tag: string, kind: "month" | "weekday" | "era" | "dayPeriod", style: Style): string[] {
  const key = `${tag}|${kind}|${style}`;
  let out = nameMemo.get(key);
  if (out) return out;
  const locale = Intl.DateTimeFormat.supportedLocalesOf(tag).length ? tag : "en-US";
  const part = (opts: Intl.DateTimeFormatOptions, ms: number, type: string) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).formatToParts(ms).find((x) => x.type === type)?.value ?? "";
  out = kind === "month" ? Array.from({ length: 12 }, (_, i) => part({ month: style }, Date.UTC(2021, i, 15), "month"))
    : kind === "weekday" ? Array.from({ length: 7 }, (_, i) => part({ weekday: style }, Date.UTC(2021, 1, 1 + i), "weekday"))
    : kind === "era" ? [Date.UTC(-100, 0, 1), Date.UTC(2021, 0, 1)].map((ms) => part({ era: style, year: "numeric" }, ms, "era"))
    : [1, 13].map((h) => part({ hour: "numeric", hour12: true }, Date.UTC(2021, 0, 1, h), "dayPeriod"));
  nameMemo.set(key, out);
  return out;
}
const QUARTERS = ["1st quarter", "2nd quarter", "3rd quarter", "4th quarter"];
function textOf(f: string, v: number, style: Style, tag: string): string {
  switch (f) {
    case "MONTH_OF_YEAR": return names(tag, "month", style)[v - 1];
    case "DAY_OF_WEEK": return names(tag, "weekday", style)[v - 1];
    case "AMPM_OF_DAY": return names(tag, "dayPeriod", "short")[v];
    case "ERA": return names(tag, "era", style)[v];
    default: return style === "long" ? QUARTERS[v - 1] : style === "short" ? "Q" + v : String(v);
  }
}
const textCandidates = (f: string, tag: string): string[][] =>
  f === "AMPM_OF_DAY" ? [names(tag, "dayPeriod", "short")]
  : f === "QUARTER" ? [QUARTERS, ["Q1", "Q2", "Q3", "Q4"]]
  : (["long", "short"] as Style[]).map((s) => names(tag, f === "MONTH_OF_YEAR" ? "month" : f === "DAY_OF_WEEK" ? "weekday" : "era", s));
/** the zone's display name at an instant; Intl answers "GMT+1" where it has no abbreviation */
function zoneName(id: string, full: boolean, ms: number, tag = "en-US"): string {
  try {
    const parts = new Intl.DateTimeFormat(tag, { timeZone: id, timeZoneName: full ? "long" : "short" }).formatToParts(ms);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? id;
  } catch { return id; }
}
function offsetText(secs: number, type: number, none: string): string {
  if (secs === 0) return none;
  const abs = Math.abs(secs), h = floorDiv(abs, 3600) % 100, m = floorDiv(abs, 60) % 60, s = abs % 60, colon = type % 2 === 0 ? ":" : "";
  let out = (secs < 0 ? "-" : "+") + pad(h);
  if (type >= 3 || (type >= 1 && m > 0)) {
    out += colon + pad(m);
    if (type >= 7 || (type >= 5 && s > 0)) out += colon + pad(s);
  }
  return out;
}
function localizedOffset(secs: number, full: boolean): string {
  if (secs === 0) return "GMT";
  const abs = Math.abs(secs), h = floorDiv(abs, 3600), m = floorDiv(abs, 60) % 60, s = abs % 60;
  const tail = full ? `${pad(h)}:${pad(m)}${s ? ":" + pad(s) : ""}` : `${h}${m || s ? ":" + pad(m) : ""}${s ? ":" + pad(s) : ""}`;
  return `GMT${secs < 0 ? "-" : "+"}${tail}`;
}
/** fields a pattern prints that ChronoField lacks */
function derived(p: Parts, f: string, tag: string): number | undefined {
  const d = p.date;
  if (!d) return p.more?.get(f);
  switch (f) {
    case "QUARTER": return floorDiv(d.mo - 1, 3) + 1;
    case "DAY_OF_WEEK_IN_MONTH": return floorDiv(d.d - 1, 7) + 1;
    case "LOCAL_DAY_OF_WEEK": return floorMod(dayOfWeek(d) - weekInfo(tag)[0], 7) + 1;
  }
  // WeekFields.weekOfMonth/weekOfYear: week 0 holds the days before the first week of minDays
  const [first, minDays] = weekInfo(tag), dom = f === "WEEK_OF_MONTH" ? d.d : dayOfYear(d);
  const startDow = floorMod(dayOfWeek(d) - first - (dom - 1), 7);
  const week = floorDiv(dom - 1 + startDow, 7) + (7 - startDow >= minDays ? 1 : 0);
  if (week || f === "WEEK_OF_MONTH") return week;
  const prev = datePlus(d, -dom, U.DAYS);
  return derived({ date: prev }, f, tag);
}
class Missing { constructor(readonly f: string) {} }
function need(p: Parts, f: string, tag: string): number {
  const v = f in FIELD_ORD ? fieldOf(p, f) : derived(p, f, tag);
  if (v === undefined) throw new Missing(f);
  return v;
}
function signed(v: number, t: Extract<Tok, { k: "val" }>): string {
  if (t.base !== undefined) return pad(floorMod(v, 100));
  const digits = String(Math.abs(v));
  if (digits.length > t.max) dtErr(`Field ${camel(t.f)} cannot be printed as the value ${v} exceeds the maximum print width of ${t.max}`);
  const body = digits.padStart(t.min, "0");
  if (v < 0) return t.sign === SIGN.NOT_NEGATIVE ? dtErr(`Field ${camel(t.f)} cannot be printed as the value ${v} cannot be negative according to the SignStyle`) : t.sign === SIGN.NEVER ? body : "-" + body;
  return (t.sign === SIGN.ALWAYS || (t.sign === SIGN.EXCEEDS_PAD && digits.length > t.min) ? "+" : "") + body;
}
function formatToks(toks: Tok[], p: Parts, tag: string): string {
  let out = "";
  for (const t of toks) {
    switch (t.k) {
      case "lit": out += t.s; break;
      case "opt": try { out += formatToks(t.toks, p, tag); } catch (e) { if (!(e instanceof Missing)) throw e; } break;
      case "val": out += signed(need(p, t.f, tag), t); break;
      case "text": out += textOf(t.f, need(p, t.f, tag), t.style, tag); break;
      case "frac": {
        let digits = pad(need(p, "NANO_OF_SECOND", tag), 9).slice(0, t.max);
        while (digits.length > t.min && digits.endsWith("0")) digits = digits.slice(0, -1);
        if (digits) out += (t.dot ? "." : "") + digits;
        break;
      }
      case "off": out += offsetText(need(p, "OFFSET_SECONDS", tag), t.type, t.none); break;
      case "loff": out += localizedOffset(need(p, "OFFSET_SECONDS", tag), t.full); break;
      case "zid": {
        const z = p.zone ?? (t.region ? undefined : p.off);
        if (!z || (t.region && z instanceof JZoneOffset)) throw new Missing("ZoneId");
        out += z.id;
        break;
      }
      case "zname": {
        const z = p.zone ?? p.off;
        if (!z) throw new Missing("ZoneId");
        const i = instOf(p);
        out += z instanceof JZoneOffset ? z.id : zoneName(z.id, t.full, i ? instantMs(i) : Date.now(), tag);
        break;
      }
      case "inst": {
        const i = instOf(p);
        if (!i) throw new Missing("INSTANT_SECONDS");
        out += instantText(i);
        break;
      }
    }
  }
  return out;
}
function formatParts(toks: Tok[], p: Parts, tag: string): string {
  try { return formatToks(toks, p, tag); } catch (e) {
    if (!(e instanceof Missing)) throw e;
    return e.f === "ZoneId" ? dtErr("Unable to extract ZoneId from temporal") : unsupported(`Unsupported field: ${e.f in FIELD_ORD ? camel(e.f) : e.f}`);
  }
}

interface ParseState { s: string; i: number; f: Map<string, number>; off?: number; zone?: JZoneId; ci: boolean; tag: string; sdf: boolean }
const isDigit = (c: number) => c >= 48 && c <= 57;
function parseToks(toks: Tok[], st: ParseState): boolean {
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    switch (t.k) {
      case "lit": {
        const seg = st.s.substr(st.i, t.s.length);
        if (seg !== t.s && !((st.ci || st.sdf) && seg.toLowerCase() === t.s.toLowerCase())) return false;
        st.i += t.s.length;
        break;
      }
      case "opt": {
        const i = st.i, f = new Map(st.f), off = st.off, zone = st.zone;
        if (!parseToks(t.toks, st)) Object.assign(st, { i, f, off, zone });
        break;
      }
      case "val": {
        // adjacent value parsing: leave the minimum widths of the numeric fields that follow
        let reserve = 0;
        for (let j = k + 1; j < toks.length; j++) {
          const n = toks[j];
          if (n.k === "val") reserve += n.pmin; else if (n.k === "frac" && !n.dot) reserve += n.min; else break;
        }
        let i = st.i, neg = false;
        const c = st.s[i];
        if ((c === "+" || c === "-") && (t.sign === SIGN.ALWAYS || t.sign === SIGN.EXCEEDS_PAD || (c === "-" && t.sign === SIGN.NORMAL && !st.sdf))) { neg = c === "-"; i++; }
        let end = i;
        while (end < st.s.length && isDigit(st.s.charCodeAt(end))) end++;
        let len = end - i;
        if (reserve) len = Math.max(t.pmin, len - reserve);
        len = Math.min(len, t.max, end - i);
        if (len < t.pmin || len === 0) { st.i = i; return false; }
        let v = Number(st.s.slice(i, i + len));
        if (t.base !== undefined && len === 2) {
          if (t.base === SDF_CENTURY) {
            const start = new Date().getFullYear() - 80;
            v += start - floorMod(start, 100);
            if (v < start) v += 100;
          } else v += t.base;
        }
        st.f.set(t.f, neg ? -v : v);
        st.i = i + len;
        break;
      }
      case "frac": {
        let i = st.i;
        if (t.dot) { if (st.s[i] !== "." && st.s[i] !== ",") { if (t.min === 0) break; return false; } i++; }
        let end = i;
        while (end < st.s.length && end - i < t.max && isDigit(st.s.charCodeAt(end))) end++;
        if (end - i < Math.max(t.min, t.dot ? 1 : 0)) { st.i = i; return false; }
        st.f.set("NANO_OF_SECOND", Number(st.s.slice(i, end).padEnd(9, "0")));
        st.i = end;
        break;
      }
      case "text": {
        let best = -1, bestLen = 0;
        const rest = st.s.slice(st.i), lower = rest.toLowerCase();
        for (const list of textCandidates(t.f, st.tag)) list.forEach((name, idx) => {
          if (name.length > bestLen && (rest.startsWith(name) || ((st.ci || st.sdf) && lower.startsWith(name.toLowerCase())))) { best = idx; bestLen = name.length; }
        });
        if (best < 0) return false;
        st.f.set(t.f, t.f === "AMPM_OF_DAY" || t.f === "ERA" ? best : best + 1);
        st.i += bestLen;
        break;
      }
      case "off": case "loff": {
        const o = parseOffset(st, t.k === "off" ? t.none : null);
        if (o === null) return false;
        st.off = o;
        break;
      }
      case "zid": case "zname": {
        const z = parseZone(st, t.k === "zname");
        if (!z) return false;
        if (z instanceof JZoneOffset) st.off ??= z.totalSeconds;
        st.zone = z;
        break;
      }
      case "inst": if (!parseToks(iso("ISO_OFFSET_DATE_TIME").toks, st)) return false; break;
      case "ci": st.ci = t.on; break;
    }
  }
  return true;
}
function parseOffset(st: ParseState, none: string | null): number | null {
  const s = st.s;
  let i = st.i;
  if (none && s.startsWith(none, i)) { st.i += none.length; return 0; }
  if (s.startsWith("GMT", i) || s.startsWith("UTC", i)) {
    i += 3;
    if (s[i] !== "+" && s[i] !== "-") { st.i = i; return 0; }
  } else if (s[i] === "Z" && (none === null || st.sdf)) { st.i = i + 1; return 0; }
  const m = /^([+-])(\d\d?)(?::?(\d\d))?(?::?(\d\d))?/.exec(s.slice(i));
  if (!m) return null;
  const secs = +m[2] * 3600 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0);
  if (secs > 64800 || +(m[3] ?? 0) > 59 || +(m[4] ?? 0) > 59) return null;
  st.i = i + m[0].length;
  return m[1] === "-" ? -secs : secs;
}
// the abbreviations java.text resolves without zone strings: UTC and the North American zones
const ZONE_ABBREVIATIONS: Record<string, number> = { UTC: 0, GMT: 0, UT: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };
function parseZone(st: ParseState, abbreviations: boolean): JZoneId | null {
  const c = st.s[st.i];
  if (c === "+" || c === "-") { const o = parseOffset(st, null); return o === null ? null : offsetOf(o); }
  const m = /^[A-Za-z][A-Za-z0-9~/._+:-]*/.exec(st.s.slice(st.i));
  if (!m) return null;
  let id = m[0];
  if (abbreviations && id.toUpperCase() in ZONE_ABBREVIATIONS && !/[+-]/.test(id)) {
    st.i += id.length;
    return offsetOf(ZONE_ABBREVIATIONS[id.toUpperCase()] * 3600);
  }
  // a trailing literal may have been swallowed ("UTC]", "Europe/Paris)"): back off until an id resolves
  for (; id; id = id.slice(0, -1)) {
    try { const z = zoneOf(id); st.i += id.length; return z; } catch { /* shorter */ }
  }
  return null;
}
/** SMART resolution of parsed fields into a date, a time, an offset and a zone */
function resolveFields(st: ParseState, defaults: [string, number][], override: JZoneId | null, sdfDefaults: boolean): Parts {
  const f = st.f, take = (k: string) => { const v = f.get(k); f.delete(k); return v; };
  for (const [k, v] of defaults) if (!f.has(k)) f.set(k, v);
  const yoe = take("YEAR_OF_ERA");
  if (yoe !== undefined && !f.has("YEAR")) f.set("YEAR", f.get("ERA") === 0 ? 1 - yoe : yoe);
  const pm = take("PROLEPTIC_MONTH");
  if (pm !== undefined) { f.set("YEAR", floorDiv(pm, 12)); f.set("MONTH_OF_YEAR", floorMod(pm, 12) + 1); }
  if (sdfDefaults) {
    if (!f.has("YEAR")) f.set("YEAR", 1970);
    if (!f.has("DAY_OF_YEAR")) { if (!f.has("MONTH_OF_YEAR")) f.set("MONTH_OF_YEAR", 1); if (!f.has("DAY_OF_MONTH")) f.set("DAY_OF_MONTH", 1); }
  }
  let date: JLocalDate | undefined;
  const ed = take("EPOCH_DAY"), y = f.get("YEAR");
  if (ed !== undefined) date = dateFromEpochDay(ed);
  else if (y !== undefined && f.has("MONTH_OF_YEAR") && f.has("DAY_OF_MONTH")) {
    const mo = take("MONTH_OF_YEAR")!, d = take("DAY_OF_MONTH")!;
    // SimpleDateFormat is lenient (Feb 30 is Mar 2); java.time clamps days 29-31 to the month
    date = sdfDefaults ? datePlus(datePlus(mkDate(y, 1, 1), mo - 1, U.MONTHS), d - 1, U.DAYS)
      : dateClamped(y, check("MONTH_OF_YEAR", mo), check("DAY_OF_MONTH", d));
  } else if (y !== undefined && f.has("DAY_OF_YEAR")) date = ofYearDay(y, take("DAY_OF_YEAR")!);
  if (date) { f.delete("YEAR"); f.delete("ERA"); f.delete("DAY_OF_WEEK"); }
  const ch = take("CLOCK_HOUR_OF_DAY");
  if (ch !== undefined) f.set("HOUR_OF_DAY", ch === 24 ? 0 : ch);
  const cha = take("CLOCK_HOUR_OF_AMPM");
  if (cha !== undefined) f.set("HOUR_OF_AMPM", cha === 12 ? 0 : cha);
  const ap = f.get("AMPM_OF_DAY"), hap = f.get("HOUR_OF_AMPM");
  if (hap !== undefined && (ap !== undefined || sdfDefaults)) { f.set("HOUR_OF_DAY", (ap ?? 0) * 12 + hap); f.delete("HOUR_OF_AMPM"); f.delete("AMPM_OF_DAY"); }
  const sub = (k: string, scale: number) => { const v = take(k); if (v !== undefined && !f.has("NANO_OF_SECOND")) f.set("NANO_OF_SECOND", v * scale); };
  sub("MILLI_OF_SECOND", 1e6); sub("MICRO_OF_SECOND", 1e3);
  for (const [k, scale] of [["NANO_OF_DAY", 1], ["MICRO_OF_DAY", 1e3], ["MILLI_OF_DAY", 1e6], ["SECOND_OF_DAY", 1e9], ["MINUTE_OF_DAY", 60e9]] as const) {
    const v = take(k);
    if (v !== undefined) { const t = timeOfNod(v * scale); f.set("HOUR_OF_DAY", t.h); f.set("MINUTE_OF_HOUR", t.mi); f.set("SECOND_OF_MINUTE", t.s); f.set("NANO_OF_SECOND", t.ns); }
  }
  if (sdfDefaults && !f.has("HOUR_OF_DAY")) f.set("HOUR_OF_DAY", 0);
  let time: JLocalTime | undefined;
  const h = take("HOUR_OF_DAY");
  if (h !== undefined) {
    const mi = take("MINUTE_OF_HOUR") ?? 0, s = take("SECOND_OF_MINUTE") ?? 0, ns = take("NANO_OF_SECOND") ?? 0;
    if (sdfDefaults) { addUnits(h * 3600 + mi * 60 + s, ns, 0, U.SECONDS); time = timeOfSod(floorMod(outS, 86400), outNs); if (date) date = datePlus(date, floorDiv(outS, 86400), U.DAYS); }
    else if (h === 24 && !mi && !s && !ns) { time = mkTime(0, 0); if (date) date = datePlus(date, 1, U.DAYS); }
    else time = timeOf(h, mi, s, ns);
  }
  const off = st.off !== undefined ? offsetOf(st.off) : undefined;
  return { date, time, off, zone: st.zone ?? off ?? override ?? undefined, more: f };
}

class JDateTimeFormatter extends JObj {
  toks: Tok[] = [];
  text = "";
  locale: JLocale | null = null;
  zone: JZoneId | null = null;
  styles: [string | null, string | null] | null = null;
  defaults: [string, number][] = [];
  resolver: unknown = null;
}
const fmtCopy = (f: JDateTimeFormatter, patch: Partial<JDateTimeFormatter>) => Object.assign(Object.assign(new JDateTimeFormatter(), f), patch);
function fmtOf(toks: Tok[], text: string): JDateTimeFormatter { const f = new JDateTimeFormatter(); f.toks = toks; f.text = text; return f; }
const localizedMemo = new Map<string, Tok[]>();
function fmtToks(f: JDateTimeFormatter): Tok[] {
  if (!f.styles) return f.toks;
  const tag = tagOf(f.locale), key = `${tag}|${f.styles}`;
  let toks = localizedMemo.get(key);
  if (!toks) localizedMemo.set(key, toks = compilePattern(localizedPattern(f.styles[0], f.styles[1], tag), false));
  return toks;
}
function dtfFormat(f: JDateTimeFormatter, t: unknown): string {
  if (!f) npe("formatter");
  if (t == null) npe("temporal");
  let p = parts(t);
  if (f.zone) {
    const i = instOf(p);
    if (i) { const z = zdtOfEpoch(i.s, i.ns, f.zone); p = { date: z.ldt.date, time: z.ldt.time, off: z.off, zone: f.zone, inst: i }; }
    else p = { ...p, zone: f.zone };
  }
  return formatParts(fmtToks(f), p, tagOf(f.locale));
}
const parseError = (msg: string) => rt.mkThrowable(T + "format/DateTimeParseException", msg);
function dtfParsed(f: JDateTimeFormatter, text: string): JParsed {
  const st: ParseState = { s: text, i: 0, f: new Map(), ci: false, tag: tagOf(f.locale), sdf: false };
  if (!parseToks(fmtToks(f), st)) throw parseError(`Text '${text}' could not be parsed at index ${st.i}`);
  if (st.i < text.length) throw parseError(`Text '${text}' could not be parsed, unparsed text found at index ${st.i}`);
  try { return Object.assign(new JParsed(), { p: resolveFields(st, f.defaults, f.zone, false) }); }
  catch (e) { throw rt.iof(e, "java/time/DateTimeException") ? parseError(`Text '${text}' could not be parsed: ${(e as { msg?: string }).msg}`) : e; }
}
/** parse, then convert with `from`, reporting a failed conversion as the parse error Java raises */
function dtfParse<R>(f: JDateTimeFormatter, s: unknown, from: (t: JParsed) => R): R | Promise<R> {
  if (s == null) npe("text");
  return after(csText(s), (text) => {
    const parsed = dtfParsed(f, text);
    try { return from(parsed); } catch (e) {
      throw rt.iof(e, "java/time/DateTimeException") && !rt.iof(e, T + "format/DateTimeParseException")
        ? parseError(`Text '${text}' could not be parsed: ${(e as { msg?: string }).msg}`) : e;
    }
  });
}
const localizedPatternMemo = new Map<string, string>();
/** the CLDR pattern for FormatStyle date/time styles, read back from what Intl formats */
function localizedPattern(dateStyle: string | null, timeStyle: string | null, tag: string): string {
  const key = `${tag}|${dateStyle}|${timeStyle}`;
  let out = localizedPatternMemo.get(key);
  if (out !== undefined) return out;
  const style = (s: string | null) => (s?.toLowerCase() ?? undefined) as Intl.DateTimeFormatOptions["dateStyle"];
  const ms = Date.UTC(2023, 0, 5, 13, 7, 9);
  const fmt = new Intl.DateTimeFormat(tag, { dateStyle: style(dateStyle), timeStyle: style(timeStyle), timeZone: "UTC" });
  out = fmt.formatToParts(ms).map(({ type, value }) => {
    switch (type) {
      case "era": return "G";
      case "year": return value.length === 2 ? "yy" : "y";
      case "month": return /\d/.test(value) ? (value.length === 2 ? "MM" : "M") : value === names(tag, "month", "long")[0] ? "MMMM" : "MMM";
      case "day": return value.length === 2 ? "dd" : "d";
      case "weekday": return value === names(tag, "weekday", "long")[3] ? "EEEE" : "EEE";
      case "dayPeriod": return "a";
      case "hour": return value.startsWith("13") ? (value.length === 2 ? "HH" : "H") : value.length === 2 ? "hh" : "h";
      case "minute": return value.length === 2 ? "mm" : "m";
      case "second": return value.length === 2 ? "ss" : "s";
      case "timeZoneName": return value.length > 5 ? "zzzz" : "z";
      default: return /[A-Za-z']/.test(value) ? `'${value.replace(/'/g, "''")}'` : value;
    }
  }).join("");
  localizedPatternMemo.set(key, out);
  return out;
}

const DATE_TOKS = (): Tok[] => [val("YEAR", 4, 10, SIGN.EXCEEDS_PAD), { k: "lit", s: "-" }, val("MONTH_OF_YEAR", 2, 2), { k: "lit", s: "-" }, val("DAY_OF_MONTH", 2, 2)];
const TIME_TOKS = (): Tok[] => [val("HOUR_OF_DAY", 2, 2), { k: "lit", s: ":" }, val("MINUTE_OF_HOUR", 2, 2),
  { k: "opt", toks: [{ k: "lit", s: ":" }, val("SECOND_OF_MINUTE", 2, 2), { k: "opt", toks: [{ k: "frac", min: 0, max: 9, dot: true }] }] }];
const OFFSET_ID: Tok = { k: "off", type: 6, none: "Z" };
const ZONE_BRACKET: Tok = { k: "opt", toks: [{ k: "lit", s: "[" }, { k: "ci", on: false }, { k: "zid", region: true }, { k: "lit", s: "]" }] };
const ISO_DEFS: Record<string, () => Tok[]> = {
  ISO_LOCAL_DATE: DATE_TOKS,
  ISO_LOCAL_TIME: TIME_TOKS,
  ISO_LOCAL_DATE_TIME: () => [...DATE_TOKS(), { k: "lit", s: "T" }, ...TIME_TOKS()],
  ISO_OFFSET_DATE: () => [...DATE_TOKS(), OFFSET_ID],
  ISO_OFFSET_TIME: () => [...TIME_TOKS(), OFFSET_ID],
  ISO_OFFSET_DATE_TIME: () => [...ISO_DEFS.ISO_LOCAL_DATE_TIME(), OFFSET_ID],
  ISO_ZONED_DATE_TIME: () => [...ISO_DEFS.ISO_OFFSET_DATE_TIME(), ZONE_BRACKET],
  ISO_DATE_TIME: () => [...ISO_DEFS.ISO_LOCAL_DATE_TIME(), { k: "opt", toks: [OFFSET_ID, ZONE_BRACKET] }],
  ISO_DATE: () => [...DATE_TOKS(), { k: "opt", toks: [OFFSET_ID] }],
  ISO_TIME: () => [...TIME_TOKS(), { k: "opt", toks: [OFFSET_ID] }],
  ISO_ORDINAL_DATE: () => [val("YEAR", 4, 10, SIGN.EXCEEDS_PAD), { k: "lit", s: "-" }, val("DAY_OF_YEAR", 3, 3), { k: "opt", toks: [OFFSET_ID] }],
  BASIC_ISO_DATE: () => [val("YEAR", 4, 4), val("MONTH_OF_YEAR", 2, 2), val("DAY_OF_MONTH", 2, 2), { k: "opt", toks: [{ k: "off", type: 5, none: "Z" }] }],
  ISO_INSTANT: () => [{ k: "inst" }],
  RFC_1123_DATE_TIME: () => [{ k: "ci", on: true }, { k: "opt", toks: [{ k: "text", f: "DAY_OF_WEEK", style: "short" }, { k: "lit", s: ", " }] },
    val("DAY_OF_MONTH", 1, 2, SIGN.NOT_NEGATIVE), { k: "lit", s: " " }, { k: "text", f: "MONTH_OF_YEAR", style: "short" }, { k: "lit", s: " " },
    val("YEAR", 4, 4), { k: "lit", s: " " }, val("HOUR_OF_DAY", 2, 2), { k: "lit", s: ":" }, val("MINUTE_OF_HOUR", 2, 2),
    { k: "opt", toks: [{ k: "lit", s: ":" }, val("SECOND_OF_MINUTE", 2, 2)] }, { k: "lit", s: " " }, { k: "off", type: 3, none: "GMT" }],
  YEAR_MONTH: () => [val("YEAR", 4, 10, SIGN.EXCEEDS_PAD), { k: "lit", s: "-" }, val("MONTH_OF_YEAR", 2, 2)],
  YEAR: () => [val("YEAR", 1, 10, SIGN.NORMAL)],
};
const isoMemo = new Map<string, JDateTimeFormatter>();
function iso(name: string): JDateTimeFormatter {
  let f = isoMemo.get(name);
  if (!f) { isoMemo.set(name, f = fmtOf(ISO_DEFS[name](), name)); if (name === "RFC_1123_DATE_TIME") f.locale = usLocale; }
  return f;
}
const DTF = `L${T}format/DateTimeFormatter;`;
const localized = (d: JSimpleEnum | null, t: JSimpleEnum | null) => {
  if (!d && !t) npe("style");
  const f = fmtOf([], `Localized(${d?.ename ?? ""},${t?.ename ?? ""})`);
  f.styles = [d?.ename ?? null, t?.ename ?? null];
  return f;
};
rt.register({
  name: T + "format/DateTimeFormatter", ctor: JDateTimeFormatter,
  statics: lazyStatics(Object.fromEntries(Object.keys(ISO_DEFS).filter((n) => !n.startsWith("YEAR")).map((n) => [n, () => iso(n)]))),
  methods: {
    [`static ofPattern(Ljava/lang/String;)${DTF}`]: (p: string) => fmtOf(compilePattern(p ?? npe("pattern"), false), p),
    [`static ofPattern(Ljava/lang/String;Ljava/util/Locale;)${DTF}`]: (p: string, l: JLocale) => Object.assign(fmtOf(compilePattern(p ?? npe("pattern"), false), p), { locale: l }),
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
const B = `L${T}format/DateTimeFormatterBuilder;`;
const push = (sig: string, make: (...a: any[]) => Tok | Tok[]) => ({
  [sig + B]: function (this: JDtfBuilder, ...a: unknown[]) { top(this).push(...([] as Tok[]).concat(make(...a))); return this; },
});
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
    [`toFormatter()${DTF}`]: function (this: JDtfBuilder) { return Object.assign(fmtOf(this.stack[0].slice(), "DateTimeFormatterBuilder"), { defaults: this.defaults.slice() }); },
    [`toFormatter(Ljava/util/Locale;)${DTF}`]: function (this: JDtfBuilder, l: JLocale) {
      return Object.assign(fmtOf(this.stack[0].slice(), "DateTimeFormatterBuilder"), { defaults: this.defaults.slice(), locale: l });
    },
    [`static getLocalizedDateTimePattern(L${T}format/FormatStyle;L${T}format/FormatStyle;L${T}chrono/Chronology;Ljava/util/Locale;)Ljava/lang/String;`]:
      (d: JSimpleEnum | null, t: JSimpleEnum | null, _c: unknown, l: JLocale) => {
        if (!d && !t) iae("Either dateStyle or timeStyle must be non-null");
        return localizedPattern(d?.ename ?? null, t?.ename ?? null, tagOf(l ?? npe("locale")));
      },
  },
});

/** SimpleDateFormat and android.text.format.DateFormat over the same engine */
const sdfMemo = new Map<string, Tok[]>();
const sdfToks = (pattern: string) => {
  let toks = sdfMemo.get(pattern);
  if (!toks) { if (sdfMemo.size > 256) sdfMemo.clear(); sdfMemo.set(pattern, toks = compilePattern(pattern, true)); }
  return toks;
};
/** java.util.TimeZone ids name java.time zones; an unknown id reads as GMT, as TimeZone.getTimeZone does */
export function zoneForId(id: string): JZoneId {
  try { return zoneOf(id); } catch { return offsetOf(0); }
}
export const zoneOffsetMs = (id: string, ms: number) => offsetAt(zoneForId(id), floorDiv(ms, 1000)) * 1000;
export const zoneStandardOffsetMs = (id: string, ms: number) => standardOffset(zoneForId(id), floorDiv(ms, 1000)) * 1000;
export function checkSdfPattern(pattern: string): void { sdfToks(pattern); }
export function formatPattern(pattern: string, ms: number, zoneId = localTz.id, locale: JLocale | null = null): string {
  const zone = zoneForId(zoneId), i = instantOfMs(ms), z = zdtOfEpoch(i.s, i.ns, zone);
  return formatParts(sdfToks(pattern), { date: z.ldt.date, time: z.ldt.time, off: z.off, zone, inst: i }, tagOf(locale));
}
/** SimpleDateFormat.parse(text, pos): epoch millis, or null with the error index in `pos` */
export function parsePattern(pattern: string, text: string, pos: { index: number; errorIndex: number }, zoneId = localTz.id, locale: JLocale | null = null): number | null {
  const st: ParseState = { s: text, i: pos.index, f: new Map(), ci: true, tag: tagOf(locale), sdf: true };
  if (!parseToks(sdfToks(pattern), st)) { pos.errorIndex = st.i; return null; }
  let p: Parts;
  try { p = resolveFields(st, [], null, true); } catch { pos.errorIndex = st.i; return null; }
  if (!p.date || !p.time) { pos.errorIndex = st.i; return null; }
  pos.index = st.i;
  const ldt = mkLdt(p.date, p.time);
  const s = p.off ? localEpoch(ldt) - p.off.totalSeconds : epochSec(zdtLocal(ldt, p.zone ?? zoneForId(zoneId)));
  return s * 1000 + floorDiv(p.time.ns, 1e6);
}
export const displayNames = (tag: string, kind: "month" | "weekday" | "era" | "dayPeriod", style: Style) => names(tag, kind, style);
export const localizedDatePattern = (date: string | null, time: string | null, locale: JLocale | null) => localizedPattern(date, time, tagOf(locale));
