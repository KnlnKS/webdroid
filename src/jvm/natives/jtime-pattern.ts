// The date-time pattern engine: DateTimeFormatter and java.text.SimpleDateFormat compile their
// patterns to one token list over the java.time field model, and print and parse through it.
// Localized names, week rules and FormatStyle patterns come from Intl.

import { rt, JObj } from "../runtime";
import { csText } from "./jchars";
import { after } from "./jlang";
import { defaultLocale, localeTag, usLocale, type JLocale } from "./jvalues";
import {
  type Parts, JParsed, JZoneId, JZoneOffset, type JLocalDate, type JLocalTime, FIELD_ORD, camel, check, dtErr, unsupported, npe, iae, U,
  floorDiv, floorMod, pad, fieldOf, instOf, instantMs, instantText, dayOfWeek, dayOfYear, datePlus, dateClamped, dateFromEpochDay, mkDate,
  ofYearDay, timeOfNod, timeOfSod, mkTime, timeOf, carried, offsetOf, zoneOf, zoneForId, zdtOfEpoch, zdtLocal, instantOfMs, mkLdt,
  localEpoch, epochSec, localTz, parts,
} from "./jtime-iso";

export type Style = "long" | "short" | "narrow";
/** TextStyle ordinals (FULL, FULL_STANDALONE, SHORT, ...) as Intl styles */
export const TEXT_STYLES = ["long", "long", "short", "short", "narrow", "narrow"] as const;
export const tagOf = (l: JLocale | null | undefined) => localeTag(l ?? defaultLocale);

/** the locale's first day of week (1 = Monday) and minimal days in the first week, from Intl */
const weekMemo = new Map<string, [number, number]>();
export function weekInfo(tag: string): [number, number] {
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
const nameMemo = new Map<string, string[]>();
/** localized month/weekday (Monday first)/era/AM-PM names, from Intl */
export function displayNames(tag: string, kind: "month" | "weekday" | "era" | "dayPeriod", style: Style): string[] {
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
/** the zone's display name at an instant; Intl answers "GMT+1" where it has no abbreviation */
export function zoneName(id: string, full: boolean, ms: number, tag = "en-US"): string {
  try {
    const parts = new Intl.DateTimeFormat(tag, { timeZone: id, timeZoneName: full ? "long" : "short" }).formatToParts(ms);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? id;
  } catch { return id; }
}
const localizedPatternMemo = new Map<string, string>();
/** the CLDR pattern for FormatStyle date/time styles, read back from what Intl formats */
export function localizedPattern(dateStyle: string | null, timeStyle: string | null, tag: string): string {
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
      case "month": return /\d/.test(value) ? (value.length === 2 ? "MM" : "M") : value === displayNames(tag, "month", "long")[0] ? "MMMM" : "MMM";
      case "day": return value.length === 2 ? "dd" : "d";
      case "weekday": return value === displayNames(tag, "weekday", "long")[3] ? "EEEE" : "EEE";
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

// ── compiling
export type Tok =
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
export const SIGN = { NORMAL: 0, ALWAYS: 1, NEVER: 2, NOT_NEGATIVE: 3, EXCEEDS_PAD: 4 } as const;
/** SimpleDateFormat's two-digit years fall within 80 years before and 20 after now */
const SDF_CENTURY = -1;
export const val = (f: string, min: number, max = 19, sign: number = SIGN.NORMAL, pmin = min): Tok => ({ k: "val", f, min, max, sign, pmin });
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
export function compilePattern(p: string, sdf: boolean): Tok[] {
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

// ── printing
const QUARTERS = ["1st quarter", "2nd quarter", "3rd quarter", "4th quarter"];
function textOf(f: string, v: number, style: Style, tag: string): string {
  switch (f) {
    case "MONTH_OF_YEAR": return displayNames(tag, "month", style)[v - 1];
    case "DAY_OF_WEEK": return displayNames(tag, "weekday", style)[v - 1];
    case "AMPM_OF_DAY": return displayNames(tag, "dayPeriod", "short")[v];
    case "ERA": return displayNames(tag, "era", style)[v];
    default: return style === "long" ? QUARTERS[v - 1] : style === "short" ? "Q" + v : String(v);
  }
}
const textCandidates = (f: string, tag: string): string[][] =>
  f === "AMPM_OF_DAY" ? [displayNames(tag, "dayPeriod", "short")]
  : f === "QUARTER" ? [QUARTERS, ["Q1", "Q2", "Q3", "Q4"]]
  : (["long", "short"] as Style[]).map((s) => displayNames(tag, f === "MONTH_OF_YEAR" ? "month" : f === "DAY_OF_WEEK" ? "weekday" : "era", s));
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

// ── parsing
/** century: SimpleDateFormat's two-digit-year window start (epoch ms); null is 80 years before now */
interface ParseState { s: string; i: number; f: Map<string, number>; off?: number; zone?: JZoneId; ci: boolean; tag: string; sdf: boolean; century?: number | null }
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
            const start = st.century != null ? new Date(st.century).getFullYear() : new Date().getFullYear() - 80;
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
      case "inst": if (!parseToks(isoFormatter("ISO_OFFSET_DATE_TIME").toks, st)) return false; break;
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
    if (sdfDefaults) carried(h * 3600 + mi * 60 + s, ns, 0, U.SECONDS, (secs, nanos) => {
      time = timeOfSod(floorMod(secs, 86400), nanos);
      if (date) date = datePlus(date, floorDiv(secs, 86400), U.DAYS);
    });
    else if (h === 24 && !mi && !s && !ns) { time = mkTime(0, 0); if (date) date = datePlus(date, 1, U.DAYS); }
    else time = timeOf(h, mi, s, ns);
  }
  const off = st.off !== undefined ? offsetOf(st.off) : undefined;
  return { date, time, off, zone: st.zone ?? off ?? override ?? undefined, more: f };
}

// ── DateTimeFormatter's engine side
export class JDateTimeFormatter extends JObj {
  toks: Tok[] = [];
  text = "";
  locale: JLocale | null = null;
  zone: JZoneId | null = null;
  styles: [string | null, string | null] | null = null;
  defaults: [string, number][] = [];
  resolver: unknown = null;
}
export function fmtOf(toks: Tok[], text: string): JDateTimeFormatter { const f = new JDateTimeFormatter(); f.toks = toks; f.text = text; return f; }
const localizedMemo = new Map<string, Tok[]>();
export function fmtToks(f: JDateTimeFormatter): Tok[] {
  if (!f.styles) return f.toks;
  const tag = tagOf(f.locale), key = `${tag}|${f.styles}`;
  let toks = localizedMemo.get(key);
  if (!toks) localizedMemo.set(key, toks = compilePattern(localizedPattern(f.styles[0], f.styles[1], tag), false));
  return toks;
}
export function dtfFormat(f: JDateTimeFormatter, t: unknown): string {
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
export const parseError = (msg: string) => rt.mkThrowable("java/time/format/DateTimeParseException", msg);
function dtfParsed(f: JDateTimeFormatter, text: string): JParsed {
  const st: ParseState = { s: text, i: 0, f: new Map(), ci: false, tag: tagOf(f.locale), sdf: false };
  if (!parseToks(fmtToks(f), st)) throw parseError(`Text '${text}' could not be parsed at index ${st.i}`);
  if (st.i < text.length) throw parseError(`Text '${text}' could not be parsed, unparsed text found at index ${st.i}`);
  try { return Object.assign(new JParsed(), { p: resolveFields(st, f.defaults, f.zone, false) }); }
  catch (e) { throw rt.iof(e, "java/time/DateTimeException") ? parseError(`Text '${text}' could not be parsed: ${(e as { msg?: string }).msg}`) : e; }
}
/** parse, then convert with `from`, reporting a failed conversion as the parse error Java raises */
export function dtfParse<R>(f: JDateTimeFormatter, s: unknown, from: (t: JParsed) => R): R | Promise<R> {
  if (s == null) npe("text");
  return after(csText(s), (text) => {
    const parsed = dtfParsed(f, text);
    try { return from(parsed); } catch (e) {
      throw rt.iof(e, "java/time/DateTimeException") && !rt.iof(e, "java/time/format/DateTimeParseException")
        ? parseError(`Text '${text}' could not be parsed: ${(e as { msg?: string }).msg}`) : e;
    }
  });
}

const DATE_TOKS = (): Tok[] => [val("YEAR", 4, 10, SIGN.EXCEEDS_PAD), { k: "lit", s: "-" }, val("MONTH_OF_YEAR", 2, 2), { k: "lit", s: "-" }, val("DAY_OF_MONTH", 2, 2)];
const TIME_TOKS = (): Tok[] => [val("HOUR_OF_DAY", 2, 2), { k: "lit", s: ":" }, val("MINUTE_OF_HOUR", 2, 2),
  { k: "opt", toks: [{ k: "lit", s: ":" }, val("SECOND_OF_MINUTE", 2, 2), { k: "opt", toks: [{ k: "frac", min: 0, max: 9, dot: true }] }] }];
export const OFFSET_ID: Tok = { k: "off", type: 6, none: "Z" };
const ZONE_BRACKET: Tok = { k: "opt", toks: [{ k: "lit", s: "[" }, { k: "ci", on: false }, { k: "zid", region: true }, { k: "lit", s: "]" }] };
export const ISO_DEFS: Record<string, () => Tok[]> = {
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
/** the predefined formatter DateTimeFormatter names `name` (and parse(CharSequence) uses) */
export function isoFormatter(name: string): JDateTimeFormatter {
  let f = isoMemo.get(name);
  if (!f) { isoMemo.set(name, f = fmtOf(ISO_DEFS[name](), name)); if (name === "RFC_1123_DATE_TIME") f.locale = usLocale; }
  return f;
}

// ── SimpleDateFormat's engine side
const sdfMemo = new Map<string, Tok[]>();
const sdfToks = (pattern: string) => {
  let toks = sdfMemo.get(pattern);
  if (!toks) { if (sdfMemo.size > 256) sdfMemo.clear(); sdfMemo.set(pattern, toks = compilePattern(pattern, true)); }
  return toks;
};
export function checkSdfPattern(pattern: string): void { sdfToks(pattern); }
export function formatPattern(pattern: string, ms: number, zoneId = localTz.id, locale: JLocale | null = null): string {
  const zone = zoneForId(zoneId), i = instantOfMs(ms), z = zdtOfEpoch(i.s, i.ns, zone);
  return formatParts(sdfToks(pattern), { date: z.ldt.date, time: z.ldt.time, off: z.off, zone, inst: i }, tagOf(locale));
}
/** SimpleDateFormat.parse(text, pos): epoch millis, or null with the error index in `pos` */
export function parsePattern(pattern: string, text: string, pos: { index: number; errorIndex: number }, zoneId = localTz.id, locale: JLocale | null = null,
  century: number | null = null): number | null {
  const st: ParseState = { s: text, i: pos.index, f: new Map(), ci: true, tag: tagOf(locale), sdf: true, century };
  if (!parseToks(sdfToks(pattern), st)) { pos.errorIndex = st.i; return null; }
  let p: Parts;
  try { p = resolveFields(st, [], null, true); } catch { pos.errorIndex = st.i; return null; }
  if (!p.date || !p.time) { pos.errorIndex = st.i; return null; }
  pos.index = st.i;
  const ldt = mkLdt(p.date, p.time);
  const s = p.off ? localEpoch(ldt) - p.off.totalSeconds : epochSec(zdtLocal(ldt, p.zone ?? zoneForId(zoneId)));
  return s * 1000 + floorDiv(p.time.ns, 1e6);
}
