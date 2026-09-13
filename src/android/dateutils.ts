import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { defaultLocale, localeTag } from "../jvm/natives/jvalues";
import { localTz } from "../jvm/natives/jtime";

const F = {
  SHOW_TIME: 1, SHOW_WEEKDAY: 2, SHOW_YEAR: 4, NO_YEAR: 8, SHOW_DATE: 16, NO_MONTH_DAY: 32,
  "12HOUR": 64, "24HOUR": 128, CAP_AMPM: 256, NO_NOON: 512, CAP_NOON: 1024,
  NO_MIDNIGHT: 2048, CAP_MIDNIGHT: 4096, UTC: 8192, ABBREV_TIME: 16384,
  ABBREV_WEEKDAY: 32768, ABBREV_MONTH: 65536, NUMERIC_DATE: 131072, ABBREV_ALL: 524288,
};
const formats = new Map<string, Intl.DateTimeFormat>();
function cachedFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(options);
  let format = formats.get(key);
  if (!format) {
    try { format = new Intl.DateTimeFormat(locale, options); }
    catch { format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }); }
    const oldest = formats.keys().next();
    if (formats.size === 8 && !oldest.done) formats.delete(oldest.value);
    formats.set(key, format);
  }
  return format;
}
function wallDate(ms: number, zone: string): Date {
  const fields = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  const format = cachedFormat("en-US-u-ca-gregory-nu-latn", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  for (const p of format.formatToParts(ms)) if (p.type in fields) Reflect.set(fields, p.type, Number(p.value));
  const date = new Date(0);
  date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  date.setUTCHours(fields.hour, fields.minute, fields.second, ((ms % 1000) + 1000) % 1000);
  return date;
}
function dateRange(start: bigint, end: bigint, flags: number, zone: string | null = null): string {
  zone = flags & F.UTC ? "UTC" : zone ?? localTz.id;
  zone = zone.replace(/^GMT([+-]\d{2}:\d{2})$/, "$1");
  const a = wallDate(Number(start), zone), b = wallDate(Number(end), zone);
  const day = (d: Date) => Math.floor(d.getTime() / 86400000);
  const midnight = (d: Date) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  if (midnight(b) && b.getUTCSeconds() === 0 && b.getUTCMilliseconds() === 0 &&
    ((!(flags & F.SHOW_TIME) && start !== end) || (day(b) - day(a) === 1 && !midnight(a)))) b.setUTCDate(b.getUTCDate() - 1);
  if (flags & F.ABBREV_ALL) flags |= F.ABBREV_MONTH | F.ABBREV_TIME | F.ABBREV_WEEKDAY;
  if (day(a) !== day(b)) flags |= F.SHOW_DATE;
  if (a.getUTCMonth() === b.getUTCMonth() && flags & F.NO_MONTH_DAY) flags &= ~(F.SHOW_WEEKDAY | F.SHOW_TIME);
  if (!(flags & (F.SHOW_DATE | F.SHOW_TIME | F.SHOW_WEEKDAY))) flags |= F.SHOW_DATE;
  if (flags & F.SHOW_DATE && !(flags & (F.SHOW_YEAR | F.NO_YEAR)) &&
    (a.getUTCFullYear() !== b.getUTCFullYear() || a.getUTCFullYear() !== wallDate(Date.now(), zone).getUTCFullYear())) flags |= F.SHOW_YEAR;
  const options: Intl.DateTimeFormatOptions = { timeZone: "UTC" };
  if (flags & (F.SHOW_DATE | F.NO_MONTH_DAY)) {
    options.month = flags & F.NUMERIC_DATE ? "numeric" : flags & F.ABBREV_MONTH ? "short" : "long";
    if (!(flags & F.NO_MONTH_DAY)) options.day = "numeric";
    if (flags & F.SHOW_YEAR) options.year = "numeric";
  }
  if (flags & F.SHOW_WEEKDAY) options.weekday = flags & F.ABBREV_WEEKDAY ? "short" : "long";
  if (flags & F.SHOW_TIME) {
    options.hour = "numeric";
    options.hourCycle = flags & F["24HOUR"] ? "h23" : "h12";
    if (!(flags & F.ABBREV_TIME) || flags & F["24HOUR"] || a.getUTCMinutes() || b.getUTCMinutes() || a.getUTCSeconds() || b.getUTCSeconds()) options.minute = "2-digit";
  }
  const format = cachedFormat(localeTag(defaultLocale), options);
  return a.getTime() === b.getTime() ? format.format(a) : a < b ? format.formatRange(a, b) : `${format.format(a)} – ${format.format(b)}`;
}
function appendRange(_context: unknown, formatter: unknown, start: bigint, end: bigint, flags: number, zone: string | null = null) {
  return vcall(formatter, "format", "(Ljava/lang/String;[Ljava/lang/Object;)Ljava/util/Formatter;", "%s", [dateRange(start, end, flags, zone)]);
}
const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
rt.register({
  name: "android/text/format/DateUtils", ctor: class extends JObj {},
  statics: { ...Object.fromEntries(Object.entries(F).map(([key, value]) => ["FORMAT_" + key, value])), SECOND_IN_MILLIS: 1000n, MINUTE_IN_MILLIS: 60000n, HOUR_IN_MILLIS: 3600000n, DAY_IN_MILLIS: 86400000n, WEEK_IN_MILLIS: 604800000n, YEAR_IN_MILLIS: 31449600000n },
  methods: {
    "static formatDateRange(Landroid/content/Context;Ljava/util/Formatter;JJILjava/lang/String;)Ljava/util/Formatter;": appendRange,
    "static formatDateRange(Landroid/content/Context;Ljava/util/Formatter;JJI)Ljava/util/Formatter;": appendRange,
    "static formatDateRange(Landroid/content/Context;JJI)Ljava/lang/String;": (_c: unknown, start: bigint, end: bigint, flags: number) => dateRange(start, end, flags),
    "static formatDateTime(Landroid/content/Context;JI)Ljava/lang/String;": (_c: unknown, time: bigint, flags: number) => dateRange(time, time, flags),
    "static isToday(J)Z": (t: bigint) => sameLocalDay(new Date(Number(t)), new Date()) ? 1 : 0,
    "static formatElapsedTime(J)Ljava/lang/String;": (s: bigint) => formatElapsed(Number(s)),
    "static formatElapsedTime(Ljava/lang/StringBuilder;J)Ljava/lang/String;": (_sb: unknown, s: bigint) => formatElapsed(Number(s)),
  },
});
/** h:mm:ss above an hour, m:ss below, as DateUtils.formatElapsedTime */
function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
