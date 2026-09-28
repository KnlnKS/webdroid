// java.time's amounts: Duration (seconds and nanos) and Period (years, months and days).

import { rt } from "../runtime";
import { vcall, type JSimpleEnum, after } from "./jlang";
import { csText } from "./jchars";
import { newArrayList } from "./jutil";
import {
  type Methods, T, TEMPORAL, UNIT, AMOUNT, U, UNIT_NANOS, UNIT_SECONDS, JDuration, JPeriod, dtErr, unsupported, npe, noUnit, isUnit, check,
  floorDiv, carried, mkDuration, periodOf, periodBetween, longHash, rotl, durationSteps, periodSteps,
} from "./jtime-iso";
import { chronoUnits, ordering, compareOnly, lazyStatics } from "./jtime-temporal";

const parseError = (what: string) => rt.mkThrowable(T + "format/DateTimeParseException", `Text cannot be parsed to a ${what}`);
const divideByZero = () => rt.mkThrowable("java/lang/ArithmeticException", "Cannot divide by zero");

// ── Duration
const durationOfNanos = (n: bigint) => { const s = n / 1000000000n, r = n % 1000000000n; return mkDuration(Number(s), Number(r)); };
const durNanos = (d: JDuration) => BigInt(d.s) * 1000000000n + BigInt(d.ns);
function durationOf(n: number, u: unknown): JDuration {
  if (!isUnit(u)) return u == null ? npe("unit") : dtErr("Unit must not have an estimated duration");
  if (u.ord < U.SECONDS) return durationOfNanos(BigInt(n) * BigInt(UNIT_NANOS[u.ord]));
  if (u.ord > U.DAYS) unsupported("Unit must not have an estimated duration");
  return mkDuration(n * UNIT_SECONDS[u.ord], 0);
}
const durationPlus = (d: JDuration, n: number, u: unknown) => { const x = durationOf(n, u); return mkDuration(d.s + x.s, d.ns + x.ns); };
const durationMinus = (d: JDuration, n: number, u: unknown) => { const x = durationOf(n, u); return mkDuration(d.s - x.s, d.ns - x.ns); };
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
  if (!m || m[3] === "T" || (!m[2] && !m[3])) throw parseError("Duration");
  const neg = m[1] === "-" ? -1n : 1n, secSign = m[6] === "-" ? -1n : 1n;
  const secs = BigInt(m[2] ?? 0) * 86400n + BigInt(m[4] ?? 0) * 3600n + BigInt(m[5] ?? 0) * 60n + secSign * BigInt(m[7] ?? 0);
  const nanos = secSign * BigInt((m[8] ?? "").padEnd(9, "0") || 0);
  return durationOfNanos(neg * (secs * 1000000000n + nanos));
}
/** addTo/subtractFrom: a Temporal moved by the amount's parts, largest first */
function applyParts(t: unknown, op: "plus" | "minus", steps: [number, number][]): unknown {
  let r = t;
  for (const [n, u] of steps) if (n) r = after(r, (x) => vcall(x, op, `(J${UNIT})${TEMPORAL}`, BigInt(n), chronoUnits[u]));
  return r;
}
const durationUnits: Methods = {};
for (const [name, u] of [["Days", U.DAYS], ["Hours", U.HOURS], ["Minutes", U.MINUTES], ["Seconds", U.SECONDS], ["Millis", U.MILLIS], ["Nanos", U.NANOS]] as const) {
  durationUnits[`static of${name}(J)L${T}Duration;`] = (n: bigint) => durationOf(Number(n), chronoUnits[u]);
  durationUnits[`plus${name}(J)L${T}Duration;`] = function (this: JDuration, n: bigint) { return durationPlus(this, Number(n), chronoUnits[u]); };
  durationUnits[`minus${name}(J)L${T}Duration;`] = function (this: JDuration, n: bigint) { return durationMinus(this, Number(n), chronoUnits[u]); };
}
const wholeUnits = (d: JDuration, unit: number) => Math.trunc(d.s / unit);
function durationSeconds(this: JDuration) { return BigInt(this.s); }
function durationNano(this: JDuration) { return this.ns; }
function durationDays(this: JDuration) { return BigInt(wholeUnits(this, 86400)); }
rt.register({
  name: T + "Duration", ctor: JDuration, ifaces: [AMOUNT.slice(1, -1), "java/lang/Comparable", "java/io/Serializable"],
  statics: lazyStatics({ ZERO: () => mkDuration(0, 0) }),
  methods: {
    ...durationUnits,
    [`static ofSeconds(JJ)L${T}Duration;`]: (s: bigint, ns: bigint) => carried(Number(s), 0, Number(ns), U.NANOS, mkDuration),
    [`static of(J${UNIT})L${T}Duration;`]: (n: bigint, u: unknown) => durationOf(Number(n), u),
    [`static from(${AMOUNT})L${T}Duration;`]: (a: unknown) => (a instanceof JDuration ? a : dtErr("Unit must not have an estimated duration")),
    [`static between(${TEMPORAL}${TEMPORAL})L${T}Duration;`]: (a: unknown, b: unknown) =>
      after(vcall(a, "until", `(${TEMPORAL}${UNIT})J`, b, chronoUnits[U.NANOS]), (n: bigint) => durationOfNanos(n)),
    [`static parse(Ljava/lang/CharSequence;)L${T}Duration;`]: (s: unknown) => after(csText(s ?? npe("text")), parseDuration),
    "getSeconds()J": durationSeconds,
    "getNano()I": durationNano,
    [`get(${UNIT})J`]: function (this: JDuration, u: JSimpleEnum) { return u?.ord === U.SECONDS ? BigInt(this.s) : u?.ord === U.NANOS ? BigInt(this.ns) : noUnit(u); },
    "getUnits()Ljava/util/List;": () => newArrayList([chronoUnits[U.SECONDS], chronoUnits[U.NANOS]]),
    [`plus(L${T}Duration;)L${T}Duration;`]: function (this: JDuration, d: JDuration) { return mkDuration(this.s + (d ?? npe("duration")).s, this.ns + d.ns); },
    [`minus(L${T}Duration;)L${T}Duration;`]: function (this: JDuration, d: JDuration) { return mkDuration(this.s - (d ?? npe("duration")).s, this.ns - d.ns); },
    [`plus(J${UNIT})L${T}Duration;`]: function (this: JDuration, n: bigint, u: unknown) { return durationPlus(this, Number(n), u); },
    [`minus(J${UNIT})L${T}Duration;`]: function (this: JDuration, n: bigint, u: unknown) { return durationMinus(this, Number(n), u); },
    [`multipliedBy(J)L${T}Duration;`]: function (this: JDuration, n: bigint) { return durationOfNanos(durNanos(this) * n); },
    [`dividedBy(J)L${T}Duration;`]: function (this: JDuration, n: bigint) { if (!n) throw divideByZero(); return durationOfNanos(durNanos(this) / n); },
    [`dividedBy(L${T}Duration;)J`]: function (this: JDuration, d: JDuration) {
      const n = durNanos(d ?? npe("divisor"));
      if (!n) throw divideByZero();
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
    "toDays()J": durationDays,
    "toHours()J": function (this: JDuration) { return BigInt(wholeUnits(this, 3600)); },
    "toMinutes()J": function (this: JDuration) { return BigInt(wholeUnits(this, 60)); },
    "toSeconds()J": durationSeconds,
    "toMillis()J": function (this: JDuration) { return BigInt(this.s) * 1000n + BigInt(floorDiv(this.ns, 1e6)); },
    "toNanos()J": function (this: JDuration) { return durNanos(this); },
    "toDaysPart()J": durationDays,
    "toHoursPart()I": function (this: JDuration) { return wholeUnits(this, 3600) % 24; },
    "toMinutesPart()I": function (this: JDuration) { return wholeUnits(this, 60) % 60; },
    "toSecondsPart()I": function (this: JDuration) { return this.s % 60; },
    "toMillisPart()I": function (this: JDuration) { return floorDiv(this.ns, 1e6); },
    "toNanosPart()I": durationNano,
    "isNegative()Z": function (this: JDuration) { return +(this.s < 0); },
    "isZero()Z": function (this: JDuration) { return +(this.s === 0 && this.ns === 0); },
    "isPositive()Z": function (this: JDuration) { return +(this.s > 0 || (this.s === 0 && this.ns > 0)); },
    [`addTo(${TEMPORAL})${TEMPORAL}`]: function (this: JDuration, t: unknown) { return applyParts(t, "plus", durationSteps(this)); },
    [`subtractFrom(${TEMPORAL})${TEMPORAL}`]: function (this: JDuration, t: unknown) { return applyParts(t, "minus", durationSteps(this)); },
    ...compareOnly(ordering(`L${T}Duration;`, (a: JDuration, b: JDuration) => a.s - b.s || a.ns - b.ns)),
    "equals(Ljava/lang/Object;)Z": function (this: JDuration, o: unknown) { return +(o instanceof JDuration && o.s === this.s && o.ns === this.ns); },
    "hashCode()I": function (this: JDuration) { return (longHash(this.s) + 51 * this.ns) | 0; },
    "toString()Ljava/lang/String;": function (this: JDuration) { return durationText(this); },
  },
});

// ── Period
function parsePeriod(text: string): JPeriod {
  const m = /^([-+]?)P(?:([-+]?\d+)Y)?(?:([-+]?\d+)M)?(?:([-+]?\d+)W)?(?:([-+]?\d+)D)?$/i.exec(text);
  if (!m || m.slice(2).every((g) => g === undefined)) throw parseError("Period");
  const s = m[1] === "-" ? -1 : 1;
  return periodOf(s * +(m[2] ?? 0), s * +(m[3] ?? 0), s * (+(m[4] ?? 0) * 7 + +(m[5] ?? 0)));
}
const periodText = (p: JPeriod) => (p.y || p.m || p.d ? `P${p.y ? p.y + "Y" : ""}${p.m ? p.m + "M" : ""}${p.d ? p.d + "D" : ""}` : "P0D");
const periodFrom = (a: unknown) => (a instanceof JPeriod ? a : a == null ? npe("amount") : dtErr("Unable to obtain Period from TemporalAmount"));
const PERIOD_PARTS: [string, "y" | "m" | "d"][] = [["Years", "y"], ["Months", "m"], ["Days", "d"]];
const withPart = (p: JPeriod, k: "y" | "m" | "d", v: number) => Object.assign(periodOf(p.y, p.m, p.d), { [k]: v });
rt.register({
  name: T + "Period", ctor: JPeriod, ifaces: [AMOUNT.slice(1, -1), "java/io/Serializable"],
  statics: lazyStatics({ ZERO: () => periodOf(0, 0, 0) }),
  methods: {
    [`static of(III)L${T}Period;`]: periodOf,
    [`static ofWeeks(I)L${T}Period;`]: (w: number) => periodOf(0, 0, w * 7),
    [`static between(L${T}LocalDate;L${T}LocalDate;)L${T}Period;`]: periodBetween,
    [`static parse(Ljava/lang/CharSequence;)L${T}Period;`]: (s: unknown) => after(csText(s ?? npe("text")), parsePeriod),
    [`static from(${AMOUNT})L${T}Period;`]: periodFrom,
    ...Object.fromEntries(PERIOD_PARTS.flatMap(([name, k]) => [
      [`static of${name}(I)L${T}Period;`, (n: number) => withPart(periodOf(0, 0, 0), k, n)],
      [`get${name}()I`, function (this: JPeriod) { return this[k]; }],
      [`with${name}(I)L${T}Period;`, function (this: JPeriod, n: number) { return withPart(this, k, n); }],
      [`plus${name}(J)L${T}Period;`, function (this: JPeriod, n: bigint) { return withPart(this, k, this[k] + Number(n)); }],
      [`minus${name}(J)L${T}Period;`, function (this: JPeriod, n: bigint) { return withPart(this, k, this[k] - Number(n)); }],
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
    [`addTo(${TEMPORAL})${TEMPORAL}`]: function (this: JPeriod, t: unknown) { return applyParts(t, "plus", periodSteps(this)); },
    [`subtractFrom(${TEMPORAL})${TEMPORAL}`]: function (this: JPeriod, t: unknown) { return applyParts(t, "minus", periodSteps(this)); },
    "equals(Ljava/lang/Object;)Z": function (this: JPeriod, o: unknown) { return +(o instanceof JPeriod && o.y === this.y && o.m === this.m && o.d === this.d); },
    "hashCode()I": function (this: JPeriod) { return (this.y + rotl(this.m, 8) + rotl(this.d, 16)) | 0; },
    "toString()Ljava/lang/String;": function (this: JPeriod) { return periodText(this); },
  },
});
