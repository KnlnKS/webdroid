// java.util.Calendar/Date/TimeZone + java.text formatters + java.util.regex.

import { rt, JObj, type NativeSpec } from "../runtime";
import { javaMatches, javaRegex, jToString, mkEnumSet, defineException, vcall, type JSimpleEnum, type JSB } from "./jlang";
import { jarray } from "../abi";

export class JDate extends JObj { t = Date.now(); }
function dateCmp(this: JDate, o: JDate) { return this.t < o.t ? -1 : this.t > o.t ? 1 : 0; }
rt.register({
  name: "java/util/Date", ctor: JDate,
  ifaces: ["java/lang/Comparable", "java/lang/Cloneable", "java/io/Serializable"],
  methods: {
    "<init>()V": function (this: JDate) { this.t = Date.now(); },
    "<init>(J)V": function (this: JDate, t: bigint) { this.t = Number(t); },
    "getTime()J": function (this: JDate) { return BigInt(Math.trunc(this.t)); },
    "getTimezoneOffset()I": function (this: JDate) { return new Date(this.t).getTimezoneOffset(); },
    "toInstant()Ljava/time/Instant;": function (this: JDate) { return mkInstant(Math.trunc(this.t)); },
    "setTime(J)V": function (this: JDate, t: bigint) { this.t = Number(t); },
    "before(Ljava/util/Date;)Z": function (this: JDate, o: JDate) { return this.t < o.t ? 1 : 0; },
    "after(Ljava/util/Date;)Z": function (this: JDate, o: JDate) { return this.t > o.t ? 1 : 0; },
    "equals(Ljava/lang/Object;)Z": function (this: JDate, o: unknown) { return o instanceof JDate && o.t === this.t ? 1 : 0; },
    "hashCode()I": function (this: JDate) { return (this.t ^ (this.t / 4294967296)) | 0; },
    "compareTo(Ljava/util/Date;)I": dateCmp,
    "compareTo(Ljava/lang/Object;)I": dateCmp,
    "toString()Ljava/lang/String;": function (this: JDate) { return new Date(this.t).toString(); },
    ...Object.fromEntries(([["getYear", (d: Date) => d.getFullYear() - 1900], ["getMonth", (d: Date) => d.getMonth()], ["getDate", (d: Date) => d.getDate()],
      ["getDay", (d: Date) => d.getDay()], ["getHours", (d: Date) => d.getHours()], ["getMinutes", (d: Date) => d.getMinutes()], ["getSeconds", (d: Date) => d.getSeconds()]] as const)
      .map(([n, get]) => [`${n}()I`, function (this: JDate) { return get(new Date(this.t)); }])),
    "clone()Ljava/lang/Object;": function (this: JDate) { const d = new JDate(); d.t = this.t; return d; },
  },
});

// java.sql's three java.util.Date subclasses. Android ships them, and a library decides whether
// to register its SQL adapters by looking one of them up.
export const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const SQL_TEXT: Record<string, (d: Date) => string> = {
  Date: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  Time: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  Timestamp: (d) => `${SQL_TEXT.Date(d)} ${SQL_TEXT.Time(d)}.${pad(d.getMilliseconds(), 3)}000000`,
};
for (const n of ["Date", "Time", "Timestamp"]) {
  rt.register({
    name: `java/sql/${n}`, ctor: class extends JDate {}, sup: "java/util/Date",
    methods: {
      "<init>(J)V": function (this: JDate, t: bigint) { this.t = Number(t); },
      "toString()Ljava/lang/String;": function (this: JDate) { return SQL_TEXT[n](new Date(this.t)); },
      ...(n === "Timestamp" ? {
        "getNanos()I": function (this: JDate) { return (this.t % 1000) * 1e6; },
        "setNanos(I)V": function (this: JDate, ns: number) { this.t = Math.trunc(this.t / 1000) * 1000 + ns / 1e6; },
      } : {}),
    },
  });
}

// ── TimeZone (device local zone)
class JTimeZone extends JObj { id = "GMT"; }
const zoneIds = ["GMT", "UTC", ...Intl.supportedValuesOf("timeZone")].sort();
export const localTz = new JTimeZone();
try { localTz.id = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "GMT"; } catch { /* */ }
/** the zone's name as Intl spells it; an unknown id falls back to the id itself */
function tzName(id: string, style: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: style ? "long" : "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? id;
  } catch { return id; }
}
rt.register({
  name: "java/util/TimeZone", ctor: JTimeZone,
  methods: {
    "static getDefault()Ljava/util/TimeZone;": () => localTz,
    "static getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;": (id: string) => {
      const t = new JTimeZone();
      t.id = id;
      return t;
    },
    "getID()Ljava/lang/String;": function (this: JTimeZone) { return this.id; },
    "getRawOffset()I": () => -new Date().getTimezoneOffset() * 60000,
    "getOffset(J)I": (t: bigint) => -new Date(Number(t)).getTimezoneOffset() * 60000,
    "inDaylightTime(Ljava/util/Date;)Z": () => 0,
    "useDaylightTime()Z": () => 0,
    "getDSTSavings()I": () => 0,
    "hasSameRules(Ljava/util/TimeZone;)Z": function (this: JTimeZone, o: JTimeZone) { return o?.id === this.id ? 1 : 0; },
    // Intl names the zone; SHORT (style 0) is the abbreviation, LONG (1) the full name
    "getDisplayName()Ljava/lang/String;": function (this: JTimeZone) { return tzName(this.id, 1); },
    "getDisplayName(Ljava/util/Locale;)Ljava/lang/String;": function (this: JTimeZone) { return tzName(this.id, 1); },
    "getDisplayName(ZI)Ljava/lang/String;": function (this: JTimeZone, _dst: number, style: number) { return tzName(this.id, style); },
    "getDisplayName(ZILjava/util/Locale;)Ljava/lang/String;": function (this: JTimeZone, _dst: number, style: number) { return tzName(this.id, style); },
    "static getAvailableIDs()[Ljava/lang/String;": () => jarray(zoneIds.slice(), "Ljava/lang/String;"),
    "setID(Ljava/lang/String;)V": function (this: JTimeZone, id: string) { this.id = id; },
  },
});

// ── Calendar (proper field semantics over JS Date, local zone)
const CAL = {
  ERA: 0, YEAR: 1, MONTH: 2, WEEK_OF_YEAR: 3, WEEK_OF_MONTH: 4, DATE: 5, DAY_OF_MONTH: 5,
  DAY_OF_YEAR: 6, DAY_OF_WEEK: 7, DAY_OF_WEEK_IN_MONTH: 8, AM_PM: 9, HOUR: 10, HOUR_OF_DAY: 11,
  MINUTE: 12, SECOND: 13, MILLISECOND: 14, ZONE_OFFSET: 15, DST_OFFSET: 16,
};
const leap = (y: number) => (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 1 : 0);
export class JCalendar extends JObj {
  d = new Date();
  firstDow = 1; // SUNDAY=1 (Java)
  minDays = 1;
  // ICU weekNumber: week 0 means the period's first days belong to the previous period's last week
  weekNumber(dayOfPeriod: number, dow: number): number {
    let start = (dow - this.firstDow - dayOfPeriod + 1) % 7;
    if (start < 0) start += 7;
    let w = Math.floor((dayOfPeriod + start - 1) / 7);
    if (7 - start >= this.minDays) w++;
    return w;
  }
  get(f: number): number {
    const d = this.d;
    switch (f) {
      case CAL.ERA: return 1;
      case CAL.YEAR: return d.getFullYear();
      case CAL.MONTH: return d.getMonth();
      case CAL.DAY_OF_MONTH: return d.getDate();
      case CAL.DAY_OF_WEEK: return d.getDay() + 1;
      case CAL.DAY_OF_YEAR: {
        const start = new Date(d.getFullYear(), 0, 1);
        return Math.floor((d.getTime() - start.getTime()) / 86400000) + 1;
      }
      case CAL.WEEK_OF_YEAR: {
        const y = d.getFullYear(), doy = this.get(CAL.DAY_OF_YEAR), dow = d.getDay() + 1, len = 365 + leap(y);
        let w = this.weekNumber(doy, dow);
        if (w === 0) w = this.weekNumber(doy + 365 + leap(y - 1), dow);
        else if (doy >= len - 5) {
          // ICU computeWeekFields: a week straddling Jan 1 belongs to the year holding ≥ minDays of it
          const relDow = (dow + 7 - this.firstDow) % 7;
          if (6 - (relDow + len - doy) % 7 >= this.minDays && doy + 7 - relDow > len) w = 1;
        }
        return w;
      }
      case CAL.WEEK_OF_MONTH: return this.weekNumber(d.getDate(), d.getDay() + 1);
      case CAL.DAY_OF_WEEK_IN_MONTH: return Math.ceil(d.getDate() / 7);
      case CAL.AM_PM: return d.getHours() < 12 ? 0 : 1;
      case CAL.HOUR: return d.getHours() % 12;
      case CAL.HOUR_OF_DAY: return d.getHours();
      case CAL.MINUTE: return d.getMinutes();
      case CAL.SECOND: return d.getSeconds();
      case CAL.MILLISECOND: return d.getMilliseconds();
      case CAL.ZONE_OFFSET: return -d.getTimezoneOffset() * 60000;
      case CAL.DST_OFFSET: return 0;
      default: return 0;
    }
  }
  set(f: number, v: number) {
    const d = this.d;
    switch (f) {
      case CAL.YEAR: d.setFullYear(v); break;
      case CAL.MONTH: d.setMonth(v); break;
      case CAL.DAY_OF_MONTH: d.setDate(v); break;
      case CAL.DAY_OF_WEEK: d.setDate(d.getDate() + (v - 1 - d.getDay())); break;
      case CAL.HOUR_OF_DAY: d.setHours(v); break;
      case CAL.HOUR: d.setHours((d.getHours() >= 12 ? 12 : 0) + v); break;
      case CAL.MINUTE: d.setMinutes(v); break;
      case CAL.SECOND: d.setSeconds(v); break;
      case CAL.MILLISECOND: d.setMilliseconds(v); break;
      case CAL.AM_PM: {
        const h = d.getHours() % 12;
        d.setHours(v ? h + 12 : h);
        break;
      }
      case CAL.DAY_OF_YEAR: {
        d.setMonth(0, 1);
        d.setDate(v);
        break;
      }
    }
  }
  add(f: number, v: number) {
    const d = this.d;
    switch (f) {
      case CAL.YEAR: d.setFullYear(d.getFullYear() + v); break;
      case CAL.MONTH: d.setMonth(d.getMonth() + v); break;
      case CAL.DAY_OF_MONTH: case CAL.DAY_OF_YEAR: d.setDate(d.getDate() + v); break;
      case CAL.WEEK_OF_YEAR: case CAL.WEEK_OF_MONTH: d.setDate(d.getDate() + v * 7); break;
      case CAL.HOUR_OF_DAY: case CAL.HOUR: d.setHours(d.getHours() + v); break;
      case CAL.MINUTE: d.setMinutes(d.getMinutes() + v); break;
      case CAL.SECOND: d.setSeconds(d.getSeconds() + v); break;
      case CAL.MILLISECOND: d.setMilliseconds(d.getMilliseconds() + v); break;
    }
  }
}
const calendar = () => new JCalendar();
const calMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "static getInstance()Ljava/util/Calendar;": calendar,
  "static getInstance(Ljava/util/Locale;)Ljava/util/Calendar;": calendar,
  "static getInstance(Ljava/util/TimeZone;)Ljava/util/Calendar;": calendar,
  "static getInstance(Ljava/util/TimeZone;Ljava/util/Locale;)Ljava/util/Calendar;": calendar,
  "get(I)I": function (this: JCalendar, f: number) { return this.get(f); },
  "set(II)V": function (this: JCalendar, f: number, v: number) { this.set(f, v); },
  "set(III)V": function (this: JCalendar, y: number, m: number, day: number) {
    this.d.setFullYear(y, m, day);
  },
  "set(IIIII)V": function (this: JCalendar, y: number, m: number, day: number, h: number, min: number) {
    this.d.setFullYear(y, m, day);
    this.d.setHours(h, min);
  },
  "set(IIIIII)V": function (this: JCalendar, y: number, m: number, day: number, h: number, min: number, sec: number) {
    this.d.setFullYear(y, m, day);
    this.d.setHours(h, min, sec);
  },
  "add(II)V": function (this: JCalendar, f: number, v: number) { this.add(f, v); },
  "roll(II)V": function (this: JCalendar, f: number, v: number) { this.add(f, v); },
  "getTime()Ljava/util/Date;": function (this: JCalendar) {
    const d = new JDate();
    d.t = this.d.getTime();
    return d;
  },
  "setTime(Ljava/util/Date;)V": function (this: JCalendar, d: JDate) { this.d = new Date(d.t); },
  "getTimeInMillis()J": function (this: JCalendar) { return BigInt(this.d.getTime()); },
  "setTimeInMillis(J)V": function (this: JCalendar, t: bigint) { this.d = new Date(Number(t)); },
  "clear()V": function (this: JCalendar) { this.d = new Date(0); },
  "clear(I)V": function () {},
  "getFirstDayOfWeek()I": function (this: JCalendar) { return this.firstDow; },
  "setFirstDayOfWeek(I)V": function (this: JCalendar, v: number) { this.firstDow = v; },
  "getMinimalDaysInFirstWeek()I": function (this: JCalendar) { return this.minDays; },
  "setMinimalDaysInFirstWeek(I)V": function (this: JCalendar, v: number) { this.minDays = v; },
  "getActualMaximum(I)I": function (this: JCalendar, f: number) {
    if (f === CAL.DAY_OF_MONTH) return new Date(this.d.getFullYear(), this.d.getMonth() + 1, 0).getDate();
    if (f === CAL.MONTH) return 11;
    if (f === CAL.DAY_OF_YEAR) return 365 + leap(this.d.getFullYear());
    return 59;
  },
  "getActualMinimum(I)I": (f: number) => (f === CAL.DAY_OF_MONTH ? 1 : 0),
  "getMaximum(I)I": function (this: JCalendar, f: number) { return f === CAL.DAY_OF_MONTH ? 31 : f === CAL.MONTH ? 11 : 59; },
  "getMinimum(I)I": (f: number) => (f === CAL.DAY_OF_MONTH ? 1 : 0),
  "before(Ljava/lang/Object;)Z": function (this: JCalendar, o: JCalendar) {
    return o instanceof JCalendar && this.d.getTime() < o.d.getTime() ? 1 : 0;
  },
  "after(Ljava/lang/Object;)Z": function (this: JCalendar, o: JCalendar) {
    return o instanceof JCalendar && this.d.getTime() > o.d.getTime() ? 1 : 0;
  },
  "equals(Ljava/lang/Object;)Z": function (this: JCalendar, o: unknown) {
    return o instanceof JCalendar && o.d.getTime() === this.d.getTime() ? 1 : 0;
  },
  "compareTo(Ljava/util/Calendar;)I": function (this: JCalendar, o: JCalendar) {
    return this.d.getTime() < o.d.getTime() ? -1 : this.d.getTime() > o.d.getTime() ? 1 : 0;
  },
  "clone()Ljava/lang/Object;": function (this: JCalendar) {
    const c = new (this.constructor as new () => JCalendar)();
    c.d = new Date(this.d.getTime());
    c.firstDow = this.firstDow;
    c.minDays = this.minDays;
    return c;
  },
  "getTimeZone()Ljava/util/TimeZone;": () => localTz,
  "setTimeZone(Ljava/util/TimeZone;)V": () => {},
  "setLenient(Z)V": () => {},
};
rt.register({
  name: "java/util/Calendar", ctor: JCalendar,
  ifaces: ["java/lang/Comparable", "java/lang/Cloneable", "java/io/Serializable"],
  statics: {
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5, JULY: 6, AUGUST: 7,
    SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
    SUNDAY: 1, MONDAY: 2, TUESDAY: 3, WEDNESDAY: 4, THURSDAY: 5, FRIDAY: 6, SATURDAY: 7,
    ...CAL, AM: 0, PM: 1,
  },
  methods: calMethods,
});
rt.register({
  name: "java/util/GregorianCalendar", ctor: class extends JCalendar {}, sup: "java/util/Calendar",
  methods: {
    ...calMethods,
    "<init>()V": function () {},
    "<init>(Ljava/util/TimeZone;)V": function () {},
    "<init>(Ljava/util/Locale;)V": function () {},
    "setGregorianChange(Ljava/util/Date;)V": function () {},
    "<init>(Ljava/util/TimeZone;Ljava/util/Locale;)V": function () {},
    "<init>(III)V": function (this: JCalendar, y: number, m: number, d: number) {
      this.d = new Date(y, m, d);
    },
    "<init>(IIIII)V": function (this: JCalendar, y: number, m: number, d: number, h: number, min: number) {
      this.d = new Date(y, m, d, h, min);
    },
  },
});

// ── calendar vocabulary (en); jtext's formatters read the names, java.time the DayOfWeek order
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// java.time.DayOfWeek: values() order is Monday-first; JS getDay() is Sunday-first
const dayOfWeek = mkEnumSet("java/time/DayOfWeek", [...DAYS.slice(1), DAYS[0]].map((d) => d.toUpperCase()),
  { "getValue()I": function (this: JSimpleEnum) { return this.ord + 1; } });
const dowOf = (jsDay: number) => dayOfWeek[(jsDay + 6) % 7];

mkEnumSet("java/time/format/SignStyle", ["NORMAL", "ALWAYS", "NEVER", "NOT_NEGATIVE", "EXCEEDS_PAD"]);
const chronoFields = mkEnumSet("java/time/temporal/ChronoField", ["NANO_OF_SECOND", "NANO_OF_DAY", "MICRO_OF_SECOND", "MICRO_OF_DAY",
  "MILLI_OF_SECOND", "MILLI_OF_DAY", "SECOND_OF_MINUTE", "SECOND_OF_DAY", "MINUTE_OF_HOUR", "MINUTE_OF_DAY",
  "HOUR_OF_AMPM", "CLOCK_HOUR_OF_AMPM", "HOUR_OF_DAY", "CLOCK_HOUR_OF_DAY", "AMPM_OF_DAY", "DAY_OF_WEEK",
  "ALIGNED_DAY_OF_WEEK_IN_MONTH", "ALIGNED_DAY_OF_WEEK_IN_YEAR", "DAY_OF_MONTH", "DAY_OF_YEAR", "EPOCH_DAY",
  "ALIGNED_WEEK_OF_MONTH", "ALIGNED_WEEK_OF_YEAR", "MONTH_OF_YEAR", "PROLEPTIC_MONTH", "YEAR_OF_ERA", "YEAR",
  "ERA", "INSTANT_SECONDS", "OFFSET_SECONDS"]);

// ── java.util.regex over JS RegExp
class JPattern extends JObj { src = ""; flags = 0; }
class JMatcher extends JObj {
  re!: RegExp;
  input = "";
  m: RegExpExecArray | null = null;
  lastEnd = 0;
  appendPos = 0;
  regionS = 0;
  regionE = -1;    // -1 = input.length
  rEnd(): number { return this.regionE < 0 ? this.input.length : this.regionE; }
  sticky(): RegExp { return javaRegex(this.re.source, this.re.flags.replace(/[gy]/g, "") + "y"); }
  /** both ends anchored, so the engine backtracks into another alternative instead of settling
   *  for the first branch that matched a prefix */
  anchored(): RegExp { return javaRegex("(?:" + this.re.source + ")$", this.re.flags.replace(/[gy]/g, "") + "y"); }
}
function appendRepl(m: JMatcher, sb: JSB, r: string): JMatcher {
  if (!m.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
  let out = "";
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === "\\") { out += r[++i] ?? ""; continue; }
    if (c === "$") {
      if (r[i + 1] === "{") {
        const j = r.indexOf("}", i);
        if (j < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "named capturing group is missing trailing '}'");
        out += m.m.groups?.[r.slice(i + 2, j)] ?? ""; i = j; continue;
      }
      let j = i + 1, num = "";
      while (j < r.length && /[0-9]/.test(r[j]) && Number(num + r[j]) < m.m.length) num += r[j++];
      if (!num) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Illegal group reference");
      out += m.m[Number(num)] ?? ""; i = j - 1; continue;
    }
    out += c;
  }
  sb.s += m.input.slice(m.appendPos, m.m.index) + out;
  m.appendPos = m.m.index + m.m[0].length;
  return m;
}
function namedGroup(matcher: JMatcher, name: string): { value: string | undefined; indices: [number, number] | undefined } {
  if (!matcher.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
  if (name == null) rt.npe();
  if (!matcher.m.groups || !(name in matcher.m.groups))
    throw rt.mkThrowable("java/lang/IllegalArgumentException", `No group with name <${name}>`);
  return { value: matcher.m.groups[name], indices: matcher.m.indices?.groups?.[name] };
}
function toJsRegex(p: string, flags: number, global: boolean): RegExp {
  let f = "ud"; // `d`: group indices, which start(n)/end(n) report
  if (flags & 2) f += "i";
  if (flags & 8) f += "m";
  if (flags & 32) f += "s";
  if (global) f += "g";
  try { return javaRegex(p, f); }
  catch { return javaRegex(p.replace(/\(\?</g, "(?:<"), f.replace("u", "")); }
}
const compile = (p: string, flags = 0) => { const pt = new JPattern(); pt.src = p; pt.flags = flags; return pt; };
const quoteRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patternRe = (p: JPattern) => toJsRegex(p.flags & 16 ? quoteRe(p.src) : p.src, p.flags, true);
function splitPattern(pattern: JPattern, sequence: unknown, limit: number): string[] {
  const input = jToString(sequence), re = patternRe(pattern), out: string[] = [];
  re.lastIndex = 0;
  let index = 0;
  for (let match = re.exec(input); match; match = re.exec(input)) {
    const end = match.index + match[0].length;
    if (index === 0 && match.index === 0 && end === 0) {
      re.lastIndex += (input.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      continue;
    }
    if (limit > 0 && out.length === limit - 1) {
      out.push(input.slice(index));
      return jarray(out, "Ljava/lang/String;");
    }
    out.push(input.slice(index, match.index));
    index = end;
    if (end === match.index) re.lastIndex += (input.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
  }
  if (index === 0) return jarray([input], "Ljava/lang/String;");
  out.push(input.slice(index));
  if (limit === 0) while (out.at(-1) === "") out.pop();
  return jarray(out, "Ljava/lang/String;");
}
rt.register({
  name: "java/util/regex/Pattern", ctor: JPattern, ifaces: ["java/io/Serializable"],
  statics: { CASE_INSENSITIVE: 2, MULTILINE: 8, DOTALL: 32, LITERAL: 16, UNICODE_CASE: 64 },
  methods: {
    "static compile(Ljava/lang/String;)Ljava/util/regex/Pattern;": compile,
    "static compile(Ljava/lang/String;I)Ljava/util/regex/Pattern;": compile,
    "static quote(Ljava/lang/String;)Ljava/lang/String;": quoteRe,
    "static matches(Ljava/lang/String;Ljava/lang/CharSequence;)Z": (p: string, s: unknown) => javaMatches(p, jToString(s)),
    "matcher(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;": function (this: JPattern, s: unknown) {
      const m = new JMatcher();
      m.re = patternRe(this);
      m.input = s == null ? "" : jToString(s);
      return m;
    },
    "pattern()Ljava/lang/String;": function (this: JPattern) { return this.src; },
    "toString()Ljava/lang/String;": function (this: JPattern) { return this.src; },
    "split(Ljava/lang/CharSequence;)[Ljava/lang/String;": function (this: JPattern, s: unknown) { return splitPattern(this, s, 0); },
    "split(Ljava/lang/CharSequence;I)[Ljava/lang/String;": function (this: JPattern, s: unknown, limit: number) { return splitPattern(this, s, limit); },
  },
});
rt.markers("java/util/regex/MatchResult");
rt.register({
  name: "java/util/regex/Matcher", ctor: JMatcher, ifaces: ["java/util/regex/MatchResult"],
  methods: {
    "find()Z": function (this: JMatcher) {
      this.re.lastIndex = Math.max(this.lastEnd, this.regionS);
      this.m = this.re.exec(this.input);
      if (this.m && this.m.index + this.m[0].length <= this.rEnd()) {
        this.lastEnd = this.m.index + Math.max(1, this.m[0].length);
        return 1;
      }
      this.m = null;
      return 0;
    },
    "matches()Z": function (this: JMatcher) {
      const re = this.anchored();
      re.lastIndex = this.regionS;
      this.m = re.exec(this.input.slice(0, this.rEnd()));
      return this.m ? 1 : 0;
    },
    "lookingAt()Z": function (this: JMatcher) {
      const re = this.sticky();
      re.lastIndex = this.regionS;
      this.m = re.exec(this.input);
      return this.m ? 1 : 0;
    },
    "group()Ljava/lang/String;": function (this: JMatcher) { return this.m?.[0] ?? null; },
    "group(I)Ljava/lang/String;": function (this: JMatcher, i: number) { return this.m?.[i] ?? null; },
    "groupCount()I": function (this: JMatcher) { return (this.m?.length ?? 1) - 1; },
    "start()I": function (this: JMatcher) { return this.m?.index ?? -1; },
    "end()I": function (this: JMatcher) { return this.m ? this.m.index + this.m[0].length : -1; },
    "start(I)I": function (this: JMatcher, g: number) {
      if (!this.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
      if (g === 0) return this.m.index;
      const ix = (this.m as unknown as { indices?: (number[] | undefined)[] }).indices?.[g];
      return ix ? ix[0] : -1;
    },
    "end(I)I": function (this: JMatcher, g: number) {
      if (!this.m) throw rt.mkThrowable("java/lang/IllegalStateException", "No match available");
      if (g === 0) return this.m.index + this.m[0].length;
      const ix = (this.m as unknown as { indices?: (number[] | undefined)[] }).indices?.[g];
      return ix ? ix[1] : -1;
    },
    "start(Ljava/lang/String;)I": function (this: JMatcher, name: string) { return namedGroup(this, name).indices?.[0] ?? -1; },
    "end(Ljava/lang/String;)I": function (this: JMatcher, name: string) { return namedGroup(this, name).indices?.[1] ?? -1; },
    "group(Ljava/lang/String;)Ljava/lang/String;": function (this: JMatcher, name: string) { return namedGroup(this, name).value ?? null; },
    "toMatchResult()Ljava/util/regex/MatchResult;": function (this: JMatcher) {
      const c = new JMatcher(); c.re = this.re; c.input = this.input; c.m = this.m; c.lastEnd = this.lastEnd; return c;
    },
    // appendReplacement/appendTail: the classic find() loop that rewrites a string piecewise.
    // The replacement's $n / ${name} refer to this match's groups; a backslash escapes.
    "appendReplacement(Ljava/lang/StringBuffer;Ljava/lang/String;)Ljava/util/regex/Matcher;": function (this: JMatcher, sb: JSB, r: string) { return appendRepl(this, sb, r); },
    "appendReplacement(Ljava/lang/StringBuilder;Ljava/lang/String;)Ljava/util/regex/Matcher;": function (this: JMatcher, sb: JSB, r: string) { return appendRepl(this, sb, r); },
    "appendTail(Ljava/lang/StringBuffer;)Ljava/lang/StringBuffer;": function (this: JMatcher, sb: JSB) { sb.s += this.input.slice(this.appendPos); return sb; },
    "appendTail(Ljava/lang/StringBuilder;)Ljava/lang/StringBuilder;": function (this: JMatcher, sb: JSB) { sb.s += this.input.slice(this.appendPos); return sb; },
    "static quoteReplacement(Ljava/lang/String;)Ljava/lang/String;": (s: string) => s.replace(/[\\$]/g, "\\$&"),
    "usePattern(Ljava/util/regex/Pattern;)Ljava/util/regex/Matcher;": function (this: JMatcher, p: JPattern) {
      this.re = patternRe(p);
      this.m = null;
      return this;
    },
    "pattern()Ljava/util/regex/Pattern;": function (this: JMatcher) { const p = new JPattern(); p.src = this.re.source; return p; },
    "replaceAll(Ljava/lang/String;)Ljava/lang/String;": function (this: JMatcher, r: string) {
      return this.input.replace(javaRegex(this.re.source, this.re.flags), r);
    },
    "replaceFirst(Ljava/lang/String;)Ljava/lang/String;": function (this: JMatcher, r: string) {
      return this.input.replace(javaRegex(this.re.source, this.re.flags.replace("g", "")), r);
    },
    "reset()Ljava/util/regex/Matcher;": function (this: JMatcher) {
      this.lastEnd = 0; this.appendPos = 0;
      this.m = null;
      this.regionS = 0; this.regionE = -1;
      return this;
    },
    "reset(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;": function (this: JMatcher, s: unknown) {
      this.input = String(s ?? "");
      this.lastEnd = 0; this.appendPos = 0;
      this.m = null;
      return this;
    },
    "hitEnd()Z": () => 0,
    "useAnchoringBounds(Z)Ljava/util/regex/Matcher;": function (this: JMatcher) { return this; },
    "useTransparentBounds(Z)Ljava/util/regex/Matcher;": function (this: JMatcher) { return this; },
    "region(II)Ljava/util/regex/Matcher;": function (this: JMatcher, s: number, e: number) {
      this.regionS = s; this.regionE = e; this.lastEnd = s; this.m = null;
      return this;
    },
    "regionStart()I": function (this: JMatcher) { return this.regionS; },
    "regionEnd()I": function (this: JMatcher) { return this.rEnd(); },
    "find(I)Z": function (this: JMatcher, from: number) {
      this.re.lastIndex = from;
      this.m = this.re.exec(this.input);
      if (this.m) { this.lastEnd = this.m.index + Math.max(1, this.m[0].length); return 1; }
      return 0;
    },
  },
});

// ── java.time core (compact, JS Date-backed, local timezone as system default)
class JInstant extends JObj { ms = 0; }
class JDuration extends JObj { ms = 0; }
class JZoneId extends JObj { id = "UTC"; }
class JZoneOffset extends JZoneId { totalSeconds = 0; }
class JLocalDate extends JObj { y = 1970; mo = 1; d = 1; }
class JLocalTime extends JObj { h = 0; mi = 0; s = 0; ns = 0; }
function ltOf(h: number, mi: number, s = 0, ns = 0): JLocalTime {
  const t = new JLocalTime(); t.h = h; t.mi = mi; t.s = s; t.ns = ns; return t;
}
const ltOfSeconds = (v: number, ns = 0) => ltOf(Math.floor(v / 3600), Math.floor(v / 60) % 60, v % 60, ns);
class JLocalDateTime extends JObj { date = new JLocalDate(); time = new JLocalTime(); }
class JZonedDateTime extends JObj { ms = 0; zone = new JZoneId(); }
function zdt(ms: number, zone: JZoneId | null = null): JZonedDateTime {
  const z = new JZonedDateTime(); z.ms = ms; if (zone) z.zone = zone; return z;
}
function shiftZonedDays(value: JZonedDateTime, days: bigint): JZonedDateTime {
  const date = new Date(value.ms);
  date.setDate(date.getDate() + Number(days));
  return zdt(date.getTime(), value.zone);
}
const odt = (ms: number, zone: JZoneId | null = null) => Object.assign(new (rt.link("java/time/OffsetDateTime").ctor as typeof JZonedDateTime)(), zdt(ms, zone));
const ldtOf = (date: JLocalDate, time = new JLocalTime()) => { const l = new JLocalDateTime(); l.date = date; l.time = time; return l; };
const sysZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
const localMs = (l: JLocalDateTime) => new Date(l.date.y, l.date.mo - 1, l.date.d, l.time.h, l.time.mi, l.time.s).getTime();
const localNanos = (l: JLocalDateTime) => BigInt(epochDay(l.date)) * 86_400_000_000_000n
  + BigInt(l.time.h * 3600 + l.time.mi * 60 + l.time.s) * 1_000_000_000n + BigInt(l.time.ns);

const mkInstant = (ms: number) => { const i = new JInstant(); i.ms = ms; return i; };
/** java.time.Period: a date-based amount, years/months/days kept apart as the API keeps them */
class JPeriod extends JObj { y = 0; m = 0; d = 0; }
const periodOf = (y: number, m: number, d: number) => { const p = new JPeriod(); p.y = y; p.m = m; p.d = d; return p; };
rt.register({
  name: "java/time/Period", ctor: JPeriod,
  clinit: () => { (rt.link("java/time/Period").ctor as any).s$ZERO = periodOf(0, 0, 0); },
  methods: {
    "static of(III)Ljava/time/Period;": periodOf,
    "static ofDays(I)Ljava/time/Period;": (d: number) => periodOf(0, 0, d),
    "static ofMonths(I)Ljava/time/Period;": (m: number) => periodOf(0, m, 0),
    "static ofYears(I)Ljava/time/Period;": (y: number) => periodOf(y, 0, 0),
    "static ofWeeks(I)Ljava/time/Period;": (w: number) => periodOf(0, 0, w * 7),
    "static between(Ljava/time/LocalDate;Ljava/time/LocalDate;)Ljava/time/Period;": (a: JLocalDate, b: JLocalDate) => {
      // java.time: whole months first, then the day remainder, borrowing a month when the end day is earlier
      let months = (b.y - a.y) * 12 + (b.mo - a.mo), days = b.d - a.d;
      if (months > 0 && days < 0) { months--; days = new Date(b.y, b.mo - 1, 0).getDate() - a.d + b.d; }
      else if (months < 0 && days > 0) { months++; days -= new Date(b.y, b.mo, 0).getDate(); }
      return periodOf(Math.trunc(months / 12), months % 12, days);
    },
    "getYears()I": function (this: JPeriod) { return this.y; },
    "getMonths()I": function (this: JPeriod) { return this.m; },
    "getDays()I": function (this: JPeriod) { return this.d; },
    "toTotalMonths()J": function (this: JPeriod) { return BigInt(this.y * 12 + this.m); },
    "isZero()Z": function (this: JPeriod) { return this.y || this.m || this.d ? 0 : 1; },
    "isNegative()Z": function (this: JPeriod) { return this.y < 0 || this.m < 0 || this.d < 0 ? 1 : 0; },
    "equals(Ljava/lang/Object;)Z": function (this: JPeriod, o: unknown) { return o instanceof JPeriod && o.y === this.y && o.m === this.m && o.d === this.d ? 1 : 0; },
    "hashCode()I": function (this: JPeriod) { return this.y + (this.m << 8) + (this.d << 16); },
    "toString()Ljava/lang/String;": function (this: JPeriod) { return this.y || this.m || this.d ? `P${this.y ? this.y + "Y" : ""}${this.m ? this.m + "M" : ""}${this.d ? this.d + "D" : ""}` : "P0D"; },
  },
});
/** java.time.Clock: the system clock in a zone, or a fixed instant */
class JClock extends JObj { zone: JZoneId | null = null; fixed: number | null = null; unavailable: string | null = null; }
const clockIn = (zone: JZoneId, fixed: number | null = null) => { const c = new JClock(); c.zone = zone; c.fixed = fixed; return c; };
const zoneOf = (id: string) => { const z = new JZoneId(); z.id = id; return z; };
const offsetCache = new Map<number, JZoneOffset>();
function offsetOfSeconds(seconds: number): JZoneOffset {
  if (seconds < -64800 || seconds > 64800) throw rt.mkThrowable("java/time/DateTimeException", "Zone offset not in valid range: -18:00 to +18:00");
  const cached = offsetCache.get(seconds);
  if (cached) return cached;
  rt.link("java/time/ZoneOffset");
  const offset = new JZoneOffset(), abs = Math.abs(seconds);
  offset.totalSeconds = seconds;
  offset.id = seconds === 0 ? "Z" : `${seconds < 0 ? "-" : "+"}${pad(Math.floor(abs / 3600))}:${pad(Math.floor(abs / 60) % 60)}${abs % 60 ? ":" + pad(abs % 60) : ""}`;
  if (seconds % 900 === 0) offsetCache.set(seconds, offset);
  return offset;
}
const zoneOffsetFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneOffsetAt(zone: JZoneId, ms: number): JZoneId {
  if (zone instanceof JZoneOffset) return zone;
  let formatter = zoneOffsetFormatters.get(zone.id);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone.id, timeZoneName: "shortOffset" });
    zoneOffsetFormatters.set(zone.id, formatter);
  }
  const name = formatter.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!match) throw rt.mkThrowable("java/time/DateTimeException", `Unsupported zone offset: ${name}`);
  const seconds = (match[1] === "-" ? -1 : 1) * (Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60);
  return offsetOfSeconds(seconds);
}
export const unavailableClock = (message: string) => { const c = clockIn(zoneOf("UTC")); c.unavailable = message; return c; };
const clockMillis = (clock: JClock) => {
  if (clock.unavailable) throw rt.mkThrowable("java/time/DateTimeException", clock.unavailable);
  return clock.fixed ?? Date.now();
};
rt.register({
  name: "java/time/Clock", ctor: JClock,
  methods: {
    "static systemUTC()Ljava/time/Clock;": () => clockIn(zoneOf("UTC")),
    "static systemDefaultZone()Ljava/time/Clock;": () => clockIn(zoneOf(sysZone())),
    "static system(Ljava/time/ZoneId;)Ljava/time/Clock;": (z: JZoneId) => clockIn(z),
    "static fixed(Ljava/time/Instant;Ljava/time/ZoneId;)Ljava/time/Clock;": (i: JInstant, z: JZoneId) => clockIn(z, i.ms),
    "static offset(Ljava/time/Clock;Ljava/time/Duration;)Ljava/time/Clock;": (c: JClock, d: { ms: number }) => clockIn(c.zone!, c.fixed === null ? null : c.fixed + d.ms),
    "instant()Ljava/time/Instant;": function (this: JClock) { return mkInstant(clockMillis(this)); },
    "millis()J": function (this: JClock) { return BigInt(clockMillis(this)); },
    "getZone()Ljava/time/ZoneId;": function (this: JClock) { return this.zone; },
    "withZone(Ljava/time/ZoneId;)Ljava/time/Clock;": function (this: JClock, z: JZoneId) { return clockIn(z, this.fixed); },
  },
});
/** the epoch millis of an ISO-8601 text; date-only and zone-less forms read as local time */
function parseIso(s: string): number {
  const text = String(s).trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? text + "T00:00:00" : text);
  if (Number.isNaN(ms)) throw rt.mkThrowable("java/time/format/DateTimeParseException", `Text '${text}' could not be parsed`);
  return ms;
}
/** compareTo plus the isAfter/isBefore/isEqual trio every java.time temporal derives from it */
const ordering = (desc: string, cmp: (a: any, b: any) => number): NativeSpec["methods"] => ({
  "compareTo(Ljava/lang/Object;)I": cmp,
  [`isAfter(${desc})Z`]: function (this: JObj, o: unknown) { return cmp(this, o) > 0 ? 1 : 0; },
  [`isBefore(${desc})Z`]: function (this: JObj, o: unknown) { return cmp(this, o) < 0 ? 1 : 0; },
  [`isEqual(${desc})Z`]: function (this: JObj, o: unknown) { return cmp(this, o) === 0 ? 1 : 0; },
});
const formatWith = function (this: JObj, f: unknown) { return vcall(f, "format", "(Ljava/time/temporal/TemporalAccessor;)Ljava/lang/String;", this); };
const temporalMs = (t: any): number => t instanceof JInstant || t instanceof JZonedDateTime ? t.ms
  : t instanceof JLocalDateTime ? localMs(t) : t instanceof JLocalDate ? new Date(t.y, t.mo - 1, t.d).getTime()
  : t instanceof JDate ? t.t : Date.now();
const mkDuration = (ms: number) => { const d = new JDuration(); d.ms = ms; return d; };
const ldOf = (y: number, mo: number, d: number) => { const l = new JLocalDate(); l.y = y; l.mo = mo; l.d = d; return l; };
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
  return ldOf(year + era * 400 + (month <= 2 ? 1 : 0), month, doy - Math.floor((153 * mp + 2) / 5) + 1);
}
function dateUntil(start: JLocalDate, end: JLocalDate, unit: JSimpleEnum): bigint {
  const days = BigInt(epochDay(end) - epochDay(start));
  if (unit.ename === "DAYS") return days;
  if (unit.ename === "WEEKS") return days / 7n;
  if (unit.ename === "ERAS") return BigInt(Number(end.y >= 1) - Number(start.y >= 1));
  const months = BigInt((end.y * 12 + end.mo - start.y * 12 - start.mo) * 32 + end.d - start.d) / 32n;
  switch (unit.ename) {
    case "MONTHS": return months;
    case "YEARS": return months / 12n;
    case "DECADES": return months / 120n;
    case "CENTURIES": return months / 1200n;
    case "MILLENNIA": return months / 12000n;
    default: throw rt.mkThrowable("java/time/temporal/UnsupportedTemporalTypeException", `Unsupported unit: ${unit.ename}`);
  }
}
const ldFromDate = (dt: Date) => ldOf(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
const ldtFromDate = (dt: Date) => ldtOf(ldFromDate(dt), ltOf(dt.getHours(), dt.getMinutes(), dt.getSeconds(), dt.getMilliseconds() * 1e6));

rt.register({
  name: "java/time/Instant", ctor: JInstant, ifaces: ["java/lang/Comparable"],
  clinit: () => {
    const c = rt.link("java/time/Instant").ctor as any;
    c.s$EPOCH = mkInstant(0);
    c.s$MIN = mkInstant(-8.64e15);
    c.s$MAX = mkInstant(8.64e15);
  },
  methods: {
    "static now()Ljava/time/Instant;": () => mkInstant(Date.now()),
    "static now(Ljava/time/Clock;)Ljava/time/Instant;": (clock: JClock) => {
      if (!clock) rt.npe();
      return vcall(clock, "instant", "()Ljava/time/Instant;");
    },
    "static parse(Ljava/lang/CharSequence;)Ljava/time/Instant;": (s: string) => mkInstant(parseIso(s)),
    "static from(Ljava/time/temporal/TemporalAccessor;)Ljava/time/Instant;": (t: unknown) => mkInstant(temporalMs(t)),
    "static ofEpochMilli(J)Ljava/time/Instant;": (ms: bigint) => mkInstant(Number(ms)),
    "static ofEpochSecond(J)Ljava/time/Instant;": (s: bigint) => mkInstant(Number(s) * 1000),
    "static ofEpochSecond(JJ)Ljava/time/Instant;": (s: bigint, nano: bigint) => mkInstant(Number(s) * 1000 + Number(nano) / 1e6),
    "toEpochMilli()J": function (this: JInstant) { return BigInt(Math.trunc(this.ms)); },
    "getEpochSecond()J": function (this: JInstant) { return BigInt(Math.floor(this.ms / 1000)); },
    "getNano()I": function (this: JInstant) { return Math.round((this.ms - Math.floor(this.ms / 1000) * 1000) * 1e6); },
    "plusMillis(J)Ljava/time/Instant;": function (this: JInstant, d: bigint) { return mkInstant(this.ms + Number(d)); },
    "plusSeconds(J)Ljava/time/Instant;": function (this: JInstant, d: bigint) { return mkInstant(this.ms + Number(d) * 1000); },
    "plus(JLjava/time/temporal/TemporalUnit;)Ljava/time/Instant;": function (this: JInstant, amount: bigint, unit: JSimpleEnum) {
      if (!unit) rt.npe();
      if (!rt.iof(unit, "java/time/temporal/ChronoUnit"))
        return vcall(unit, "addTo", "(Ljava/time/temporal/Temporal;J)Ljava/time/temporal/Temporal;", this, amount);
      const millis = {
        NANOS: 1e-6, MICROS: 1e-3, MILLIS: 1, SECONDS: 1000,
        MINUTES: 60_000, HOURS: 3_600_000, HALF_DAYS: 43_200_000, DAYS: 86_400_000,
      }[unit.ename];
      if (millis === undefined)
        throw rt.mkThrowable("java/time/temporal/UnsupportedTemporalTypeException", `Unsupported unit: ${unit.ename}`);
      return mkInstant(this.ms + Number(amount) * millis);
    },
    "until(Ljava/time/temporal/Temporal;Ljava/time/temporal/TemporalUnit;)J": function (this: JInstant, end: JInstant, unit: JSimpleEnum) {
      if (!end || !unit) rt.npe();
      if (!rt.iof(unit, "java/time/temporal/ChronoUnit"))
        return vcall(unit, "between", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)J", this, end);
      const nanos = BigInt(Math.round((end.ms - this.ms) * 1e6));
      const divisor = {
        NANOS: 1n, MICROS: 1_000n, MILLIS: 1_000_000n, SECONDS: 1_000_000_000n,
        MINUTES: 60_000_000_000n, HOURS: 3_600_000_000_000n,
        HALF_DAYS: 43_200_000_000_000n, DAYS: 86_400_000_000_000n,
      }[unit.ename];
      if (divisor === undefined)
        throw rt.mkThrowable("java/time/temporal/UnsupportedTemporalTypeException", `Unsupported unit: ${unit.ename}`);
      return nanos / divisor;
    },
    "minusMillis(J)Ljava/time/Instant;": function (this: JInstant, d: bigint) { return mkInstant(this.ms - Number(d)); },
    "minusSeconds(J)Ljava/time/Instant;": function (this: JInstant, d: bigint) { return mkInstant(this.ms - Number(d) * 1000); },
    ...ordering("Ljava/time/Instant;", (x: JInstant, o: JInstant) => (x.ms < o.ms ? -1 : x.ms > o.ms ? 1 : 0)),
    "equals(Ljava/lang/Object;)Z": function (this: JInstant, o: unknown) { return o instanceof JInstant && o.ms === this.ms ? 1 : 0; },
    "hashCode()I": function (this: JInstant) { return this.ms | 0; },
    "atOffset(Ljava/time/ZoneOffset;)Ljava/time/OffsetDateTime;": function (this: JInstant, z: JZoneId) { return odt(this.ms, z); },
    "atZone(Ljava/time/ZoneId;)Ljava/time/ZonedDateTime;": function (this: JInstant, z: JZoneId) {
      return zdt(this.ms, z);
    },
    "toString()Ljava/lang/String;": function (this: JInstant) { return new Date(this.ms).toISOString(); },
  },
});
rt.register({
  name: "java/time/Duration", ctor: JDuration, ifaces: ["java/lang/Comparable"],
  clinit: () => { (rt.link("java/time/Duration").ctor as any).s$ZERO = mkDuration(0); },
  methods: {
    "static ofMillis(J)Ljava/time/Duration;": (ms: bigint) => mkDuration(Number(ms)),
    "static ofSeconds(J)Ljava/time/Duration;": (s: bigint) => mkDuration(Number(s) * 1000),
    "static ofMinutes(J)Ljava/time/Duration;": (m: bigint) => mkDuration(Number(m) * 60000),
    "static ofHours(J)Ljava/time/Duration;": (h: bigint) => mkDuration(Number(h) * 3600000),
    "static ofDays(J)Ljava/time/Duration;": (d: bigint) => mkDuration(Number(d) * 86400000),
    "static between(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)Ljava/time/Duration;": (a: any, b: any) =>
      mkDuration((b?.ms ?? 0) - (a?.ms ?? 0)),
    "plus(Ljava/time/Duration;)Ljava/time/Duration;": function (this: JDuration, other: JDuration) {
      if (!other) rt.npe();
      return mkDuration(this.ms + other.ms);
    },
    "minus(Ljava/time/Duration;)Ljava/time/Duration;": function (this: JDuration, other: JDuration) {
      if (!other) rt.npe();
      return mkDuration(this.ms - other.ms);
    },
    "toMillis()J": function (this: JDuration) { return BigInt(Math.trunc(this.ms)); },
    "getSeconds()J": function (this: JDuration) { return BigInt(Math.floor(this.ms / 1000)); },
    "toMinutes()J": function (this: JDuration) { return BigInt(Math.trunc(this.ms / 60000)); },
    "toHours()J": function (this: JDuration) { return BigInt(Math.trunc(this.ms / 3600000)); },
    "toDays()J": function (this: JDuration) { return BigInt(Math.trunc(this.ms / 86400000)); },
    "isNegative()Z": function (this: JDuration) { return this.ms < 0 ? 1 : 0; },
    "compareTo(Ljava/lang/Object;)I": function (this: JDuration, o: JDuration) { return this.ms < o.ms ? -1 : this.ms > o.ms ? 1 : 0; },
    "getNano()I": function (this: JDuration) { return Math.round((this.ms - Math.floor(this.ms / 1000) * 1000) * 1e6); },
    "isZero()Z": function (this: JDuration) { return this.ms === 0 ? 1 : 0; },
  },
});
rt.register({
  name: "java/time/ZoneId", ctor: JZoneId,
  methods: {
    "static systemDefault()Ljava/time/ZoneId;": () => zoneOf(sysZone()),
    "static of(Ljava/lang/String;)Ljava/time/ZoneId;": zoneOf,
    "getId()Ljava/lang/String;": function (this: JZoneId) { return this.id; },
    "getRules()Ljava/time/zone/ZoneRules;": () => rt.make("java/time/zone/ZoneRules"),
    "toString()Ljava/lang/String;": function (this: JZoneId) { return this.id; },
  },
});
rt.register({ name: "java/time/ZoneOffset", ctor: JZoneOffset, sup: "java/time/ZoneId",
  clinit: () => {
    const c = rt.link("java/time/ZoneOffset").ctor as any;
    c.s$UTC = offsetOfSeconds(0); c.s$MIN = offsetOfSeconds(-64800); c.s$MAX = offsetOfSeconds(64800);
  },
  methods: {
    "static ofTotalSeconds(I)Ljava/time/ZoneOffset;": offsetOfSeconds,
    "getTotalSeconds()I": function (this: JZoneOffset) { return this.totalSeconds; },
  },
});
rt.register({
  name: "java/time/LocalDate", ctor: JLocalDate, ifaces: ["java/lang/Comparable", "java/time/temporal/Temporal", "java/time/temporal/TemporalAccessor"],
  clinit: () => {
    const c = rt.link("java/time/LocalDate").ctor as any;
    c.s$MIN = ldOf(-271821, 4, 20);
    c.s$MAX = ldOf(275760, 9, 13);
    c.s$EPOCH = ldOf(1970, 1, 1);
  },
  methods: {
    "static now()Ljava/time/LocalDate;": () => ldFromDate(new Date()),
    "format(Ljava/time/format/DateTimeFormatter;)Ljava/lang/String;": formatWith,
    "static parse(Ljava/lang/CharSequence;)Ljava/time/LocalDate;": (s: string) => ldFromDate(new Date(parseIso(s))),
    "static parse(Ljava/lang/CharSequence;Ljava/time/format/DateTimeFormatter;)Ljava/time/LocalDate;": (s: string) => ldFromDate(new Date(parseIso(s))),
    "static from(Ljava/time/temporal/TemporalAccessor;)Ljava/time/LocalDate;": (t: unknown) => ldFromDate(new Date(temporalMs(t))),
    "static of(III)Ljava/time/LocalDate;": (y: number, m: number, d: number) => ldOf(y, m, d),
    "static ofEpochDay(J)Ljava/time/LocalDate;": (ed: bigint) => dateFromEpochDay(Number(ed)),
    "static ofInstant(Ljava/time/Instant;Ljava/time/ZoneId;)Ljava/time/LocalDate;": (i: any) => ldFromDate(new Date(i?.ms ?? Date.now())),
    "getYear()I": function (this: JLocalDate) { return this.y; },
    "getMonthValue()I": function (this: JLocalDate) { return this.mo; },
    "getDayOfMonth()I": function (this: JLocalDate) { return this.d; },
    "toEpochDay()J": function (this: JLocalDate) { return BigInt(epochDay(this)); },
    "until(Ljava/time/temporal/Temporal;Ljava/time/temporal/TemporalUnit;)J": function (this: JLocalDate, end: JObj, unit: JSimpleEnum) {
      if (!end || !unit) throw rt.mkThrowable("java/lang/NullPointerException", "end date and unit required");
      if (!chronoUnits.includes(unit)) return vcall(unit, "between", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)J", this, end);
      if (end instanceof JLocalDate) return dateUntil(this, end, unit);
      if (end instanceof JLocalDateTime) return dateUntil(this, end.date, unit);
      return vcall(end, "getLong", "(Ljava/time/temporal/TemporalField;)J", chronoFields.find(f => f.ename === "EPOCH_DAY"))
        .then(day => dateUntil(this, dateFromEpochDay(Number(day)), unit));
    },
    "plusDays(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) { return ldFromDate(new Date(this.y, this.mo - 1, this.d + Number(n))); },
    "minusDays(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) { return ldFromDate(new Date(this.y, this.mo - 1, this.d - Number(n))); },
    "plusMonths(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) {
      const dt = new Date(this.y, this.mo - 1 + Number(n), Math.min(this.d, 28)); return ldFromDate(dt);
    },
    "minusMonths(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) {
      const dt = new Date(this.y, this.mo - 1 - Number(n), Math.min(this.d, 28)); return ldFromDate(dt);
    },
    "plusYears(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) { return ldOf(this.y + Number(n), this.mo, this.d); },
    "minusYears(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) { return ldOf(this.y - Number(n), this.mo, this.d); },
    "plusWeeks(J)Ljava/time/LocalDate;": function (this: JLocalDate, n: bigint) {
      const dt = new Date(this.y, this.mo - 1, this.d + Number(n) * 7); return ldFromDate(dt);
    },
    "withDayOfMonth(I)Ljava/time/LocalDate;": function (this: JLocalDate, d: number) { return ldOf(this.y, this.mo, d); },
    "lengthOfMonth()I": function (this: JLocalDate) { return new Date(this.y, this.mo, 0).getDate(); },
    "getDayOfWeek()Ljava/time/DayOfWeek;": function (this: JLocalDate) { return dowOf(new Date(this.y, this.mo - 1, this.d).getDay()); },
    "atStartOfDay(Ljava/time/ZoneId;)Ljava/time/ZonedDateTime;": function (this: JLocalDate, z: JZoneId) {
      return zdt(new Date(this.y, this.mo - 1, this.d).getTime(), z);
    },
    "atStartOfDay()Ljava/time/LocalDateTime;": function (this: JLocalDate) { return ldtOf(ldOf(this.y, this.mo, this.d)); },
    ...ordering("Ljava/time/chrono/ChronoLocalDate;", (x: JLocalDate, o: JLocalDate) => {
      const a = x.y * 10000 + x.mo * 100 + x.d, b = o.y * 10000 + o.mo * 100 + o.d;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    "equals(Ljava/lang/Object;)Z": function (this: JLocalDate, o: unknown) {
      return o instanceof JLocalDate && o.y === this.y && o.mo === this.mo && o.d === this.d ? 1 : 0;
    },
    "hashCode()I": function (this: JLocalDate) { return this.y * 10000 + this.mo * 100 + this.d; },
    "toString()Ljava/lang/String;": function (this: JLocalDate) { return `${this.y}-${pad(this.mo)}-${pad(this.d)}`; },
  },
});
rt.register({
  name: "java/time/LocalDateTime", ctor: JLocalDateTime, ifaces: ["java/lang/Comparable", "java/time/temporal/Temporal", "java/time/temporal/TemporalAccessor"],
  clinit: () => {
    const c = rt.link("java/time/LocalDateTime").ctor as any;
    c.s$MIN = ldtOf(ldOf(-271821, 4, 20));
    c.s$MAX = ldtOf(ldOf(275760, 9, 12), ltOf(23, 59, 59));
  },
  methods: {
    "static now()Ljava/time/LocalDateTime;": () => ldtFromDate(new Date()),
    "static parse(Ljava/lang/CharSequence;)Ljava/time/LocalDateTime;": (s: string) => ldtFromDate(new Date(parseIso(s))),
    "static parse(Ljava/lang/CharSequence;Ljava/time/format/DateTimeFormatter;)Ljava/time/LocalDateTime;": (s: string) => ldtFromDate(new Date(parseIso(s))),
    "static from(Ljava/time/temporal/TemporalAccessor;)Ljava/time/LocalDateTime;": (t: unknown) => ldtFromDate(new Date(temporalMs(t))),
    "static of(Ljava/time/LocalDate;Ljava/time/LocalTime;)Ljava/time/LocalDateTime;": (d: JLocalDate, t: JLocalTime) => ldtOf(d ?? new JLocalDate(), t ?? new JLocalTime()),
    "static of(IIIII)Ljava/time/LocalDateTime;": (y: number, mo: number, d: number, h: number, mi: number) => ldtOf(ldOf(y, mo, d), ltOf(h, mi)),
    "static of(IIIIII)Ljava/time/LocalDateTime;": (y: number, mo: number, d: number, h: number, mi: number, sec: number) => ldtOf(ldOf(y, mo, d), ltOf(h, mi, sec)),
    "static ofInstant(Ljava/time/Instant;Ljava/time/ZoneId;)Ljava/time/LocalDateTime;": (i: any) => ldtFromDate(new Date(i?.ms ?? Date.now())),
    "atZone(Ljava/time/ZoneId;)Ljava/time/ZonedDateTime;": function (this: JLocalDateTime, z: JZoneId) { return zdt(localMs(this), z); },
    "toLocalDate()Ljava/time/LocalDate;": function (this: JLocalDateTime) { return this.date; },
    "toLocalTime()Ljava/time/LocalTime;": function (this: JLocalDateTime) { return this.time; },
    "plusDays(J)Ljava/time/LocalDateTime;": function (this: JLocalDateTime, days: bigint) {
      return ldtOf(dateFromEpochDay(epochDay(this.date) + Number(days)), this.time);
    },
    "minusDays(J)Ljava/time/LocalDateTime;": function (this: JLocalDateTime, days: bigint) {
      return ldtOf(dateFromEpochDay(epochDay(this.date) - Number(days)), this.time);
    },
    "until(Ljava/time/temporal/Temporal;Ljava/time/temporal/TemporalUnit;)J": function (this: JLocalDateTime, end: JLocalDateTime | JZonedDateTime, unit: JSimpleEnum) {
      if (!end || !unit) rt.npe();
      if (!chronoUnits.includes(unit)) return vcall(unit, "between", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)J", this, end);
      if (end instanceof JZonedDateTime) end = ldtFromDate(new Date(end.ms));
      if (!(end instanceof JLocalDateTime))
        throw rt.mkThrowable("java/time/DateTimeException", "Unable to obtain LocalDateTime from temporal");
      const divisor = {
        NANOS: 1n, MICROS: 1_000n, MILLIS: 1_000_000n, SECONDS: 1_000_000_000n,
        MINUTES: 60_000_000_000n, HOURS: 3_600_000_000_000n, HALF_DAYS: 43_200_000_000_000n,
      }[unit.ename];
      if (divisor) return (localNanos(end) - localNanos(this)) / divisor;
      const days = epochDay(end.date) - epochDay(this.date);
      const timeDelta = localNanos(end) - localNanos(this) - BigInt(days) * 86_400_000_000_000n;
      const adjusted = days > 0 && timeDelta < 0n ? days - 1 : days < 0 && timeDelta > 0n ? days + 1 : days;
      return dateUntil(this.date, dateFromEpochDay(epochDay(this.date) + adjusted), unit);
    },
    "getSecond()I": function (this: JLocalDateTime) { return this.time.s; },
    "getNano()I": function (this: JLocalDateTime) { return this.time.ns; },
    "getDayOfWeek()Ljava/time/DayOfWeek;": function (this: JLocalDateTime) { return dowOf(new Date(this.date.y, this.date.mo - 1, this.date.d).getDay()); },
    "format(Ljava/time/format/DateTimeFormatter;)Ljava/lang/String;": formatWith,
    "toEpochSecond(Ljava/time/ZoneOffset;)J": function (this: JLocalDateTime) { return BigInt(Math.floor(localMs(this) / 1000)); },
    "getYear()I": function (this: JLocalDateTime) { return this.date.y; },
    "getMonthValue()I": function (this: JLocalDateTime) { return this.date.mo; },
    "getDayOfMonth()I": function (this: JLocalDateTime) { return this.date.d; },
    "getHour()I": function (this: JLocalDateTime) { return this.time.h; },
    ...ordering("Ljava/time/chrono/ChronoLocalDateTime;", (x: JLocalDateTime, o: JLocalDateTime) => {
      const a = localMs(x), b = localMs(o);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    "getMinute()I": function (this: JLocalDateTime) { return this.time.mi; },
  },
});
rt.register({
  name: "java/time/OffsetDateTime", ctor: class extends JZonedDateTime {}, sup: "java/time/ZonedDateTime",
  methods: {
    "static now()Ljava/time/OffsetDateTime;": () => odt(Date.now()),
    "static now(Ljava/time/ZoneId;)Ljava/time/OffsetDateTime;": (zone: JZoneId | null) => {
      if (!zone) rt.npe();
      return odt(Date.now(), zone);
    },
    "static parse(Ljava/lang/CharSequence;)Ljava/time/OffsetDateTime;": (s: string) => odt(parseIso(s)),
    "static from(Ljava/time/temporal/TemporalAccessor;)Ljava/time/OffsetDateTime;": (t: unknown) => odt(temporalMs(t)),
    "static ofInstant(Ljava/time/Instant;Ljava/time/ZoneId;)Ljava/time/OffsetDateTime;": (i: JInstant | null, zone: JZoneId) => odt(i?.ms ?? Date.now(), zone),
    "toZonedDateTime()Ljava/time/ZonedDateTime;": function (this: JZonedDateTime) { return zdt(this.ms, this.zone); },
  },
});
rt.register({
  name: "java/time/ZonedDateTime", ctor: JZonedDateTime, ifaces: ["java/lang/Comparable"],
  methods: {
    "static now()Ljava/time/ZonedDateTime;": () => zdt(Date.now()),
    "format(Ljava/time/format/DateTimeFormatter;)Ljava/lang/String;": formatWith,
    "static parse(Ljava/lang/CharSequence;)Ljava/time/ZonedDateTime;": (s: string) => zdt(parseIso(s)),
    "static from(Ljava/time/temporal/TemporalAccessor;)Ljava/time/ZonedDateTime;": (t: unknown) => zdt(temporalMs(t)),
    "static now(Ljava/time/ZoneId;)Ljava/time/ZonedDateTime;": (zone: JZoneId) => zdt(Date.now(), zone),
    "static ofInstant(Ljava/time/Instant;Ljava/time/ZoneId;)Ljava/time/ZonedDateTime;": (i: JInstant | null, zone: JZoneId) => zdt(i?.ms ?? Date.now(), zone),
    "static ofLocal(Ljava/time/LocalDateTime;Ljava/time/ZoneId;Ljava/time/ZoneOffset;)Ljava/time/ZonedDateTime;": (l: JLocalDateTime | null, zone: JZoneId) =>
      zdt(l ? localMs(l) : Date.now(), zone),
    "toInstant()Ljava/time/Instant;": function (this: JZonedDateTime) { return mkInstant(this.ms); },
    "getZone()Ljava/time/ZoneId;": function (this: JZonedDateTime) { return this.zone; },
    "getOffset()Ljava/time/ZoneOffset;": function (this: JZonedDateTime) { return zoneOffsetAt(this.zone, this.ms); },
    "toEpochSecond()J": function (this: JZonedDateTime) { return BigInt(Math.floor(this.ms / 1000)); },
    "minusMonths(J)Ljava/time/ZonedDateTime;": function (this: JZonedDateTime, months: bigint) {
      const date = new Date(this.ms), day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() - Number(months));
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(day, lastDay));
      return zdt(date.getTime(), this.zone);
    },
    "minusDays(J)Ljava/time/ZonedDateTime;": function (this: JZonedDateTime, days: bigint) { return shiftZonedDays(this, -days); },
    "plusDays(J)Ljava/time/ZonedDateTime;": function (this: JZonedDateTime, days: bigint) { return shiftZonedDays(this, days); },
    "toLocalDate()Ljava/time/LocalDate;": function (this: JZonedDateTime) { return ldFromDate(new Date(this.ms)); },
    "toLocalDateTime()Ljava/time/LocalDateTime;": function (this: JZonedDateTime) { return ldtFromDate(new Date(this.ms)); },
    "getYear()I": function (this: JZonedDateTime) { return new Date(this.ms).getFullYear(); },
    "getMonthValue()I": function (this: JZonedDateTime) { return new Date(this.ms).getMonth() + 1; },
    "getDayOfMonth()I": function (this: JZonedDateTime) { return new Date(this.ms).getDate(); },
    "getHour()I": function (this: JZonedDateTime) { return new Date(this.ms).getHours(); },
    "getMinute()I": function (this: JZonedDateTime) { return new Date(this.ms).getMinutes(); },
    ...ordering("Ljava/time/chrono/ChronoZonedDateTime;", (x: JZonedDateTime, o: JZonedDateTime) => (x.ms < o.ms ? -1 : x.ms > o.ms ? 1 : 0)),
  },
});
rt.markers("java/time/temporal/Temporal", "java/time/temporal/TemporalAccessor", "java/time/temporal/TemporalAmount",
  "java/time/temporal/TemporalUnit");
mkEnumSet("java/time/format/FormatStyle", ["FULL", "LONG", "MEDIUM", "SHORT"]);
defineException("java/time/DateTimeException", "java/lang/RuntimeException");
defineException("java/time/format/DateTimeParseException", "java/time/DateTimeException");
defineException("java/time/temporal/UnsupportedTemporalTypeException", "java/time/DateTimeException");
const chronoUnits = mkEnumSet("java/time/temporal/ChronoUnit", ["NANOS", "MICROS", "MILLIS", "SECONDS", "MINUTES", "HOURS",
  "HALF_DAYS", "DAYS", "WEEKS", "MONTHS", "YEARS", "DECADES", "CENTURIES", "MILLENNIA", "ERAS", "FOREVER"], {
  "between(Ljava/time/temporal/Temporal;Ljava/time/temporal/Temporal;)J": function (this: JSimpleEnum, start: JObj, end: JObj) {
    return vcall(start, "until", "(Ljava/time/temporal/Temporal;Ljava/time/temporal/TemporalUnit;)J", end, this);
  },
}, ["java/time/temporal/TemporalUnit"]);
type LocalizedStyle = "full" | "long" | "medium" | "short";
class JDateTimeFormatter extends JObj { pattern = "yyyy-MM-dd"; zone: unknown = null; dateStyle: LocalizedStyle | null = null; timeStyle: LocalizedStyle | null = null; }
const fmtOf = (pattern: string) => { const f = new JDateTimeFormatter(); f.pattern = pattern; return f; };
function localizedStyle(style: JSimpleEnum | null): LocalizedStyle {
  if (!style) rt.npe();
  const name = style!.ename;
  return name === "FULL" ? "full" : name === "LONG" ? "long" : name === "SHORT" ? "short" : "medium";
}
function localizedFormatter(date: LocalizedStyle | null, time: LocalizedStyle | null): JDateTimeFormatter {
  const f = new JDateTimeFormatter();
  f.dateStyle = date; f.timeStyle = time;
  return f;
}
rt.register({
  name: "java/time/format/DateTimeFormatter", ctor: JDateTimeFormatter,
  statics: { ISO_LOCAL_DATE: fmtOf("yyyy-MM-dd"), ISO_LOCAL_TIME: fmtOf("HH:mm:ss"), ISO_LOCAL_DATE_TIME: fmtOf("yyyy-MM-dd'T'HH:mm:ss"), ISO_INSTANT: fmtOf("ISO_INSTANT") },
  methods: {
    "static ofPattern(Ljava/lang/String;)Ljava/time/format/DateTimeFormatter;": fmtOf,
    "withZone(Ljava/time/ZoneId;)Ljava/time/format/DateTimeFormatter;": function (this: JDateTimeFormatter, z: unknown) { return Object.assign(new JDateTimeFormatter(), this, { zone: z }); },
    "withLocale(Ljava/util/Locale;)Ljava/time/format/DateTimeFormatter;": function (this: JDateTimeFormatter) { return this; },
    "withDecimalStyle(Ljava/time/format/DecimalStyle;)Ljava/time/format/DateTimeFormatter;": function (this: JDateTimeFormatter) { return this; },
    "getZone()Ljava/time/ZoneId;": function (this: JDateTimeFormatter) { return this.zone; },
    "parse(Ljava/lang/CharSequence;)Ljava/time/temporal/TemporalAccessor;": function (this: JDateTimeFormatter, s: string) { return zdt(parseIso(s), this.zone as JZoneId | null); },
    // Locale-aware overload: the pattern still drives the output, and MONTHS below is en-only,
    // so the locale changes nothing here — but omitting the overload throws on the caller.
    "static ofPattern(Ljava/lang/String;Ljava/util/Locale;)Ljava/time/format/DateTimeFormatter;": fmtOf,
    "static ofLocalizedDate(Ljava/time/format/FormatStyle;)Ljava/time/format/DateTimeFormatter;": (style: JSimpleEnum | null) => localizedFormatter(localizedStyle(style), null),
    "static ofLocalizedTime(Ljava/time/format/FormatStyle;)Ljava/time/format/DateTimeFormatter;": (style: JSimpleEnum | null) => localizedFormatter(null, localizedStyle(style)),
    "static ofLocalizedDateTime(Ljava/time/format/FormatStyle;)Ljava/time/format/DateTimeFormatter;": (style: JSimpleEnum | null) => localizedFormatter(localizedStyle(style), localizedStyle(style)),
    "static ofLocalizedDateTime(Ljava/time/format/FormatStyle;Ljava/time/format/FormatStyle;)Ljava/time/format/DateTimeFormatter;": (date: JSimpleEnum | null, time: JSimpleEnum | null) => localizedFormatter(localizedStyle(date), localizedStyle(time)),
    "format(Ljava/time/temporal/TemporalAccessor;)Ljava/lang/String;": function (this: JDateTimeFormatter, t: any) {
      const dt: Date = t instanceof JLocalDate ? new Date(t.y, t.mo - 1, t.d)
        : t instanceof JZonedDateTime || t instanceof JInstant ? new Date(t.ms)
        : t instanceof JLocalDateTime ? new Date(localMs(t))
        : new Date();
      if (this.dateStyle || this.timeStyle) return new Intl.DateTimeFormat(undefined,
        { dateStyle: this.dateStyle ?? undefined, timeStyle: this.timeStyle ?? undefined,
          timeZone: (this.zone as JZoneId | null)?.id }).format(dt);
      if (this.pattern === "ISO_INSTANT") return dt.toISOString().replace(/\.000Z$/, "Z");
      return this.pattern
        .replace(/'T'/g, "T")
        .replace(/yyyy/g, String(dt.getFullYear()))
        .replace(/MMMM/g, MONTHS[dt.getMonth()])
        .replace(/MMM/g, MONTHS[dt.getMonth()].slice(0, 3))
        .replace(/MM/g, pad(dt.getMonth() + 1))
        .replace(/dd/g, pad(dt.getDate()))
        .replace(/HH/g, pad(dt.getHours()))
        .replace(/mm/g, pad(dt.getMinutes()))
        .replace(/ss/g, pad(dt.getSeconds()));
    },
  },
});

class JZoneRules extends JObj {}
rt.register({
  name: "java/time/zone/ZoneRules", ctor: JZoneRules,
  methods: {
    "getOffset(Ljava/time/Instant;)Ljava/time/ZoneOffset;": (inst: any) => {
      const off = -new Date(inst?.ms ?? Date.now()).getTimezoneOffset() * 60;
      const c = rt.link("java/time/ZoneOffset").ctor as any;
      const z = new c(); z.id = "local"; z.totalSeconds = off; return z;
    },
    "isFixedOffset()Z": () => 0,
  },
});

rt.register({
  name: "java/time/LocalTime", ctor: JLocalTime, ifaces: ["java/lang/Comparable"],
  clinit: () => {
    const c = rt.link("java/time/LocalTime").ctor as any;
    c.s$MIN = ltOf(0, 0);
    c.s$MIDNIGHT = ltOf(0, 0);
    c.s$NOON = ltOf(12, 0);
    c.s$MAX = ltOf(23, 59, 59, 999999999);
  },
  methods: {
    "static now()Ljava/time/LocalTime;": () => { const d = new Date(); return ltOf(d.getHours(), d.getMinutes(), d.getSeconds()); },
    "format(Ljava/time/format/DateTimeFormatter;)Ljava/lang/String;": formatWith,
    "static of(II)Ljava/time/LocalTime;": (h: number, mi: number) => ltOf(h, mi),
    "static of(III)Ljava/time/LocalTime;": ltOf,
    "static of(IIII)Ljava/time/LocalTime;": ltOf,
    "static ofSecondOfDay(J)Ljava/time/LocalTime;": (sod: bigint) => ltOfSeconds(Number(sod)),
    "static ofNanoOfDay(J)Ljava/time/LocalTime;": (nod: bigint) => ltOfSeconds(Number(nod / 1000000000n), Number(nod % 1000000000n)),
    "getHour()I": function (this: JLocalTime) { return this.h; },
    "getMinute()I": function (this: JLocalTime) { return this.mi; },
    "getSecond()I": function (this: JLocalTime) { return this.s; },
    "getNano()I": function (this: JLocalTime) { return this.ns; },
    "toSecondOfDay()I": function (this: JLocalTime) { return this.h * 3600 + this.mi * 60 + this.s; },
    "toNanoOfDay()J": function (this: JLocalTime) { return BigInt(this.h * 3600 + this.mi * 60 + this.s) * 1000000000n + BigInt(this.ns); },
    ...ordering("Ljava/time/LocalTime;", (x: JLocalTime, o: JLocalTime) => {
      const a = x.h * 3600 + x.mi * 60 + x.s, b = o.h * 3600 + o.mi * 60 + o.s;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    "toString()Ljava/lang/String;": function (this: JLocalTime) { return `${pad(this.h)}:${pad(this.mi)}:${pad(this.s)}`; },
  },
});
