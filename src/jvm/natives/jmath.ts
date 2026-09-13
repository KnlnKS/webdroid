// java.math: BigDecimal = (unscaled bigint, scale) with JDK rounding/layout semantics; BigInteger over bigint.

import { rt, JObj } from "../runtime";
import { jarray } from "../abi";
import { mkEnumSet, fmtDouble, JSimpleEnum, vcall } from "./jlang";

const arith = (msg: string): never => { throw rt.mkThrowable("java/lang/ArithmeticException", msg); };
const nfe = (msg: string): never => { throw rt.mkThrowable("java/lang/NumberFormatException", msg); };

const P10: bigint[] = [1n];
function pow10(n: number): bigint {
  if (n < P10.length) return P10[n];
  if (n > 64) return 10n ** BigInt(n);
  for (let i = P10.length; i <= n; i++) P10[i] = P10[i - 1] * 10n;
  return P10[n];
}
const babs = (v: bigint) => (v < 0n ? -v : v);
const bsig = (v: bigint) => (v < 0n ? -1 : v > 0n ? 1 : 0);
// decimal digit count of |v| (1 for zero), as BigDecimal.precision defines it
function ndigits(v: bigint): number {
  if (v === 0n) return 1;
  const a = babs(v);
  // hex length bounds the bit length within 4; log2(10) puts that within two decimal digits
  const hex = a.toString(16).length;
  let est = Math.max(1, Math.floor((hex * 4 - 4) * 0.30102999566398) + 1);
  while (a >= pow10(est)) est++;
  return est;
}

// ── RoundingMode (ordinal order matches the legacy BigDecimal.ROUND_* ints)
const RM = mkEnumSet("java/math/RoundingMode",
  ["UP", "DOWN", "CEILING", "FLOOR", "HALF_UP", "HALF_DOWN", "HALF_EVEN", "UNNECESSARY"], {
    "static valueOf(I)Ljava/math/RoundingMode;": (i: number) => {
      if (i < 0 || i > 7) throw rt.mkThrowable("java/lang/IllegalArgumentException", "argument out of range");
      return RM[i];
    },
  });
const rmOrd = (m: JSimpleEnum | null) => (m ? m.ord : 4);

// n/d rounded to an integer by `mode` (ordinal); the one primitive every rounding path uses
function divRound(n: bigint, d: bigint, mode: number): bigint {
  if (d === 0n) arith("Division by zero");
  let q = n / d;
  const r = n - q * d;
  if (r === 0n) return q;
  const neg = (n < 0n) !== (d < 0n);
  const inc = neg ? q - 1n : q + 1n;
  switch (mode) {
    case 0: return inc;
    case 1: return q;
    case 2: return neg ? q : inc;
    case 3: return neg ? inc : q;
    case 7: return arith("Rounding necessary");
  }
  const c = babs(r) * 2n - babs(d);
  if (c > 0n || (c === 0n && (mode === 4 || (mode === 6 && (q & 1n) !== 0n)))) return inc;
  return q;
}

class JMathContext extends JObj { prec = 0; rm: JSimpleEnum = RM[6]; }
function mkMC(prec: number, rm: JSimpleEnum = RM[6]): JMathContext {
  if (prec < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Digits < 0");
  const m = new JMathContext();
  m.prec = prec;
  m.rm = rm;
  return m;
}
rt.register({
  name: "java/math/MathContext", ctor: JMathContext, ifaces: ["java/io/Serializable"],
  statics: { UNLIMITED: mkMC(0, RM[4]), DECIMAL32: mkMC(7), DECIMAL64: mkMC(16), DECIMAL128: mkMC(34) },
  methods: {
    "<init>(I)V": function (this: JMathContext, p: number) { Object.assign(this, mkMC(p)); },
    "<init>(ILjava/math/RoundingMode;)V": function (this: JMathContext, p: number, rm: JSimpleEnum | null) {
      if (!rm) throw rt.mkThrowable("java/lang/NullPointerException", "null RoundingMode");
      Object.assign(this, mkMC(p, rm));
    },
    "<init>(Ljava/lang/String;)V": function (this: JMathContext, s: string) {
      const m = /^precision=(\d+) roundingMode=([A-Z_]+)$/.exec(s);
      const rm = m && RM.find((e) => e.ename === m[2]);
      if (!m || !rm) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bad string format");
      Object.assign(this, mkMC(+m[1], rm));
    },
    "getPrecision()I": function (this: JMathContext) { return this.prec; },
    "getRoundingMode()Ljava/math/RoundingMode;": function (this: JMathContext) { return this.rm; },
    "equals(Ljava/lang/Object;)Z": function (this: JMathContext, o: unknown) {
      return o instanceof JMathContext && o.prec === this.prec && o.rm === this.rm ? 1 : 0;
    },
    "hashCode()I": function (this: JMathContext) { return (this.prec + this.rm.ord * 59) | 0; },
    "toString()Ljava/lang/String;": function (this: JMathContext) { return `precision=${this.prec} roundingMode=${this.rm.ename}`; },
  },
});

class JBigDecimal extends JObj { u = 0n; sc = 0; }
function mkBD(u: bigint, sc = 0): JBigDecimal {
  const b = new JBigDecimal();
  b.u = u;
  b.sc = sc;
  return b;
}
const ZERO = mkBD(0n);
function checkScale(sc: number): number {
  if (sc > 0x7fffffff) arith("Underflow");
  if (sc < -0x80000000) arith("Overflow");
  return sc;
}
function parseBD(s: string): JBigDecimal {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) nfe(`Character array is missing "exponent" mark 'e' or 'E'.`);
  const frac = m![3] ?? "";
  const u = BigInt((m![1] === "-" ? "-" : "") + (m![2] + frac || "0"));
  return mkBD(u, checkScale(frac.length - (m![4] ? +m![4] : 0)));
}
// exact binary expansion, as BigDecimal(double) is specified (0.1 → 0.1000000000000000055511151231257827…)
function fromDouble(d: number): JBigDecimal {
  if (!Number.isFinite(d)) nfe("Infinite or NaN");
  if (d === 0) return ZERO;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, d);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const neg = hi >>> 31, exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074; else { m |= 1n << 52n; e = exp - 1075; }
  while ((m & 1n) === 0n) { m >>= 1n; e++; }
  if (neg) m = -m;
  return e >= 0 ? mkBD(m << BigInt(e)) : mkBD(m * 5n ** BigInt(-e), -e);
}
function roundMC(b: JBigDecimal, mc: JMathContext | null): JBigDecimal {
  if (!mc || mc.prec === 0) return b;
  let { u, sc } = b;
  for (;;) {
    const drop = ndigits(u) - mc.prec;
    if (drop <= 0) return u === b.u ? b : mkBD(u, checkScale(sc));
    u = divRound(u, pow10(drop), mc.rm.ord);
    sc -= drop;
  }
}
function setScale(b: JBigDecimal, sc: number, mode: number): JBigDecimal {
  if (sc === b.sc) return b;
  checkScale(sc);
  return sc > b.sc ? mkBD(b.u * pow10(sc - b.sc), sc) : mkBD(divRound(b.u, pow10(b.sc - sc), mode), sc);
}
function align(a: JBigDecimal, b: JBigDecimal): [bigint, bigint, number] {
  if (a.sc === b.sc) return [a.u, b.u, a.sc];
  return a.sc > b.sc ? [a.u, b.u * pow10(a.sc - b.sc), a.sc] : [a.u * pow10(b.sc - a.sc), b.u, b.sc];
}
function cmp(a: JBigDecimal, b: JBigDecimal): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function stripZeros(b: JBigDecimal, floorScale = -Infinity): JBigDecimal {
  if (b.u === 0n) return floorScale === -Infinity ? ZERO : mkBD(0n, floorScale);
  let { u, sc } = b;
  while (sc > floorScale && u % 10n === 0n) { u /= 10n; sc--; }
  return sc === b.sc ? b : mkBD(u, checkScale(sc));
}
// quotient to `prec` significant digits (prec 0 = exact, or throw), trailing zeros stripped
// down to the preferred scale — BigDecimal.divide(BigDecimal, MathContext)
function divideMC(a: JBigDecimal, b: JBigDecimal, prec: number, mode: number): JBigDecimal {
  if (b.u === 0n) arith(a.u === 0n ? "Division undefined" : "Division by zero");
  const pref = a.sc - b.sc;
  if (a.u === 0n) return mkBD(0n, Math.min(Math.max(pref, -0x80000000), 0x7fffffff));
  const exact = prec === 0;
  if (exact) { prec = ndigits(a.u) + Math.ceil((10 * ndigits(b.u)) / 3); mode = 7; }
  // k extra decimal places so the integer quotient carries `prec` (+1 guard) digits; recompute
  // from the exact operands if the estimate overshoots, never re-round a rounded value
  let k = prec - (ndigits(a.u) - ndigits(b.u) + 1) + 1;
  let q: bigint, sc: number;
  for (;;) {
    try {
      q = k >= 0 ? divRound(a.u * pow10(k), b.u, mode) : divRound(a.u, b.u * pow10(-k), mode);
    } catch (e) {
      if (exact) arith("Non-terminating decimal expansion; no exact representable decimal result.");
      throw e;
    }
    sc = pref + k;
    if (ndigits(q) <= prec) break;
    k--;
  }
  const r = stripZeros(mkBD(q, sc), pref);
  return exact && r.sc < pref ? setScale(r, pref, 7) : r;
}
function toBigInt(b: JBigDecimal, exact: boolean): bigint {
  if (b.sc <= 0) return b.u * pow10(-b.sc);
  const p = pow10(b.sc);
  if (exact && b.u % p !== 0n) arith("Rounding necessary");
  return b.u / p;
}
function layout(b: JBigDecimal, sci: boolean, eng = false): string {
  const neg = b.u < 0n ? "-" : "";
  const coeff = babs(b.u).toString();
  if (b.sc === 0) return neg + coeff;
  let adjusted = -b.sc + (coeff.length - 1);
  if (!sci || (b.sc >= 0 && adjusted >= -6)) {
    if (b.sc < 0) return neg + (b.u === 0n ? "0" : coeff + "0".repeat(-b.sc));
    if (b.sc >= coeff.length) return neg + "0." + "0".repeat(b.sc - coeff.length) + coeff;
    return neg + coeff.slice(0, coeff.length - b.sc) + "." + coeff.slice(coeff.length - b.sc);
  }
  let out: string;
  if (!eng) out = coeff.length > 1 ? coeff[0] + "." + coeff.slice(1) : coeff;
  else {
    let sig = adjusted % 3;
    if (sig < 0) sig += 3;
    adjusted -= sig;
    sig++;
    if (b.u === 0n) {
      out = sig === 1 ? "0" : sig === 2 ? "0.00" : "0.0";
      if (sig !== 1) adjusted += 3;
    } else if (sig >= coeff.length) out = coeff + "0".repeat(sig - coeff.length);
    else out = coeff.slice(0, sig) + "." + coeff.slice(sig);
  }
  if (adjusted !== 0) out += "E" + (adjusted > 0 ? "+" : "") + adjusted;
  return neg + out;
}
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) { while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; }
    x = y;
  }
}
function sqrt(b: JBigDecimal, mc: JMathContext): JBigDecimal {
  if (b.u < 0n) arith("Attempted square root of negative BigDecimal");
  const pref = Math.trunc(b.sc / 2);
  if (b.u === 0n) return mkBD(0n, pref);
  let { u, sc } = b;
  if (sc & 1) { u *= 10n; sc++; }
  const prec = mc.prec;
  const want = prec === 0 ? ndigits(u) + 2 : prec + 2;
  const k = Math.max(0, Math.ceil((2 * want - ndigits(u)) / 2));
  const n = u * pow10(2 * k);
  const s = isqrt(n);
  const exactRoot = s * s === n;
  let r = mkBD(s, sc / 2 + k);
  if (prec === 0) {
    if (!exactRoot) arith("Computed square root not exact.");
    return stripZeros(r, pref);
  }
  if (!exactRoot && mc.rm.ord === 7) arith("Computed square root not exact.");
  // a truncated root plus one sticky digit rounds exactly like the true value would
  if (!exactRoot) r = mkBD(s * 10n + 1n, r.sc + 1);
  r = roundMC(r, mc);
  r = stripZeros(r, pref);
  if (r.sc < pref && ndigits(r.u) + (pref - r.sc) <= prec) r = setScale(r, pref, 7);
  return r;
}
function powMC(b: JBigDecimal, n: number, mc: JMathContext): JBigDecimal {
  if (mc.prec === 0) return pow(b, n);
  if (n < -999999999 || n > 999999999) arith("Invalid operation");
  if (n === 0) return mkBD(1n);
  const mag = Math.abs(n);
  const elength = String(mag).length;
  if (mc.prec > 0 && elength > mc.prec) arith("Invalid operation");
  const work = mkMC(mc.prec + elength + 1, mc.rm);
  let acc = mkBD(1n);
  let seenbit = false;
  for (let i = 1; ; i++) {
    const bit = 1 << (31 - i);
    if ((mag & bit) !== 0) { seenbit = true; acc = roundMC(mkBD(acc.u * b.u, acc.sc + b.sc), work); }
    if (i === 31) break;
    if (seenbit) acc = roundMC(mkBD(acc.u * acc.u, acc.sc * 2), work);
  }
  if (n < 0) acc = divideMC(mkBD(1n), acc, work.prec, work.rm.ord);
  return roundMC(acc, mc);
}
function pow(b: JBigDecimal, n: number): JBigDecimal {
  if (n < 0 || n > 999999999) arith("Invalid operation");
  return mkBD(b.u ** BigInt(n), checkScale(b.sc * n));
}
function intExact(b: JBigDecimal, bits: number): bigint {
  const v = toBigInt(b, true);
  if (v !== BigInt.asIntN(bits, v)) arith("Overflow");
  return v;
}
const bd = (fn: (this: JBigDecimal, ...a: any[]) => JBigDecimal) => fn;
const withMC = (fn: (this: JBigDecimal, o: JBigDecimal) => JBigDecimal) =>
  function (this: JBigDecimal, o: JBigDecimal, mc: JMathContext | null) { return roundMC(fn.call(this, o), mc); };
const add = bd(function (o: JBigDecimal) { const [x, y, s] = align(this, o); return mkBD(x + y, s); });
const sub = bd(function (o: JBigDecimal) { const [x, y, s] = align(this, o); return mkBD(x - y, s); });
const mul = bd(function (o: JBigDecimal) { return mkBD(this.u * o.u, checkScale(this.sc + o.sc)); });
const divInt = bd(function (o: JBigDecimal) {
  if (o.u === 0n) arith(this.u === 0n ? "Division undefined" : "Division by zero");
  const pref = this.sc - o.sc;
  const q = (this.u * pow10(Math.max(0, o.sc))) / (o.u * pow10(Math.max(0, this.sc)));
  const r = mkBD(q, 0);
  return pref > 0 ? setScale(r, pref, 7) : stripZeros(r, pref);
});
rt.register({
  name: "java/math/BigDecimal", ctor: JBigDecimal, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable"],
  statics: {
    ZERO, ONE: mkBD(1n), TWO: mkBD(2n), TEN: mkBD(10n),
    ROUND_UP: 0, ROUND_DOWN: 1, ROUND_CEILING: 2, ROUND_FLOOR: 3, ROUND_HALF_UP: 4, ROUND_HALF_DOWN: 5,
    ROUND_HALF_EVEN: 6, ROUND_UNNECESSARY: 7,
  },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JBigDecimal, s: string) { Object.assign(this, parseBD(s)); },
    "<init>(Ljava/lang/String;Ljava/math/MathContext;)V": function (this: JBigDecimal, s: string, mc: JMathContext) {
      Object.assign(this, roundMC(parseBD(s), mc));
    },
    "<init>([C)V": function (this: JBigDecimal, c: Uint16Array) { Object.assign(this, parseBD(String.fromCharCode(...c))); },
    "<init>([CII)V": function (this: JBigDecimal, c: Uint16Array, off: number, len: number) {
      Object.assign(this, parseBD(String.fromCharCode(...c.subarray(off, off + len))));
    },
    "<init>(D)V": function (this: JBigDecimal, v: number) { Object.assign(this, fromDouble(v)); },
    "<init>(DLjava/math/MathContext;)V": function (this: JBigDecimal, v: number, mc: JMathContext) { Object.assign(this, roundMC(fromDouble(v), mc)); },
    "<init>(I)V": function (this: JBigDecimal, v: number) { this.u = BigInt(v); },
    "<init>(ILjava/math/MathContext;)V": function (this: JBigDecimal, v: number, mc: JMathContext) { Object.assign(this, roundMC(mkBD(BigInt(v)), mc)); },
    "<init>(J)V": function (this: JBigDecimal, v: bigint) { this.u = v; },
    "<init>(JLjava/math/MathContext;)V": function (this: JBigDecimal, v: bigint, mc: JMathContext) { Object.assign(this, roundMC(mkBD(v), mc)); },
    "<init>(Ljava/math/BigInteger;)V": function (this: JBigDecimal, v: JBigInteger) { this.u = v.v; },
    "<init>(Ljava/math/BigInteger;I)V": function (this: JBigDecimal, v: JBigInteger, sc: number) { this.u = v.v; this.sc = sc; },
    "<init>(Ljava/math/BigInteger;Ljava/math/MathContext;)V": function (this: JBigDecimal, v: JBigInteger, mc: JMathContext) {
      Object.assign(this, roundMC(mkBD(v.v), mc));
    },
    "<init>(Ljava/math/BigInteger;ILjava/math/MathContext;)V": function (this: JBigDecimal, v: JBigInteger, sc: number, mc: JMathContext) {
      Object.assign(this, roundMC(mkBD(v.v, sc), mc));
    },
    "static valueOf(D)Ljava/math/BigDecimal;": (v: number) => parseBD(fmtDouble(v)),
    "static valueOf(J)Ljava/math/BigDecimal;": (v: bigint) => mkBD(v),
    "static valueOf(JI)Ljava/math/BigDecimal;": (v: bigint, s: number) => mkBD(v, s),
    "add(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": add,
    "add(Ljava/math/BigDecimal;Ljava/math/MathContext;)Ljava/math/BigDecimal;": withMC(add),
    "subtract(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": sub,
    "subtract(Ljava/math/BigDecimal;Ljava/math/MathContext;)Ljava/math/BigDecimal;": withMC(sub),
    "multiply(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": mul,
    "multiply(Ljava/math/BigDecimal;Ljava/math/MathContext;)Ljava/math/BigDecimal;": withMC(mul),
    "divide(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      return divideMC(this, o, 0, 7);
    },
    "divide(Ljava/math/BigDecimal;Ljava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, mc: JMathContext) {
      return divideMC(this, o, mc.prec, mc.rm.ord);
    },
    "divide(Ljava/math/BigDecimal;II)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, sc: number, mode: number) {
      return divScaled(this, o, sc, mode);
    },
    "divide(Ljava/math/BigDecimal;ILjava/math/RoundingMode;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, sc: number, rm: JSimpleEnum) {
      return divScaled(this, o, sc, rmOrd(rm));
    },
    "divide(Ljava/math/BigDecimal;I)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, mode: number) {
      return divScaled(this, o, this.sc, mode);
    },
    "divide(Ljava/math/BigDecimal;Ljava/math/RoundingMode;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, rm: JSimpleEnum) {
      return divScaled(this, o, this.sc, rmOrd(rm));
    },
    "divideToIntegralValue(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": divInt,
    "divideToIntegralValue(Ljava/math/BigDecimal;Ljava/math/MathContext;)Ljava/math/BigDecimal;": withMC(divInt),
    "remainder(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      return sub.call(this, mul.call(divInt.call(this, o), o));
    },
    "divideAndRemainder(Ljava/math/BigDecimal;)[Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      const q = divInt.call(this, o);
      const arr = [q, sub.call(this, mul.call(q, o))] as unknown[] & { $t?: string };
      arr.$t = "[Ljava/math/BigDecimal;";
      return arr;
    },
    "pow(I)Ljava/math/BigDecimal;": function (this: JBigDecimal, n: number) { return pow(this, n); },
    "pow(ILjava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, n: number, mc: JMathContext) { return powMC(this, n, mc); },
    "sqrt(Ljava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, mc: JMathContext) { return sqrt(this, mc); },
    "round(Ljava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, mc: JMathContext) { return roundMC(this, mc); },
    "plus()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return this; },
    "plus(Ljava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, mc: JMathContext) { return roundMC(this, mc); },
    "setScale(I)Ljava/math/BigDecimal;": function (this: JBigDecimal, sc: number) { return setScale(this, sc, 7); },
    "setScale(II)Ljava/math/BigDecimal;": function (this: JBigDecimal, sc: number, mode: number) { return setScale(this, sc, mode); },
    "setScale(ILjava/math/RoundingMode;)Ljava/math/BigDecimal;": function (this: JBigDecimal, sc: number, rm: JSimpleEnum) {
      return setScale(this, sc, rmOrd(rm));
    },
    "movePointLeft(I)Ljava/math/BigDecimal;": function (this: JBigDecimal, n: number) {
      const r = mkBD(this.u, checkScale(this.sc + n));
      return r.sc < 0 ? setScale(r, 0, 7) : r;
    },
    "movePointRight(I)Ljava/math/BigDecimal;": function (this: JBigDecimal, n: number) {
      const r = mkBD(this.u, checkScale(this.sc - n));
      return r.sc < 0 ? setScale(r, 0, 7) : r;
    },
    "scaleByPowerOfTen(I)Ljava/math/BigDecimal;": function (this: JBigDecimal, n: number) { return mkBD(this.u, checkScale(this.sc - n)); },
    "stripTrailingZeros()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return stripZeros(this); },
    "negate()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return mkBD(-this.u, this.sc); },
    "negate(Ljava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, mc: JMathContext) { return roundMC(mkBD(-this.u, this.sc), mc); },
    "abs()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return this.u < 0n ? mkBD(-this.u, this.sc) : this; },
    "abs(Ljava/math/MathContext;)Ljava/math/BigDecimal;": function (this: JBigDecimal, mc: JMathContext) { return roundMC(mkBD(babs(this.u), this.sc), mc); },
    "max(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) { return cmp(this, o) >= 0 ? this : o; },
    "min(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) { return cmp(this, o) <= 0 ? this : o; },
    "ulp()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return mkBD(1n, this.sc); },
    "signum()I": function (this: JBigDecimal) { return bsig(this.u); },
    "scale()I": function (this: JBigDecimal) { return this.sc; },
    "precision()I": function (this: JBigDecimal) { return ndigits(this.u); },
    "unscaledValue()Ljava/math/BigInteger;": function (this: JBigDecimal) { return mkBI(this.u); },
    "toBigInteger()Ljava/math/BigInteger;": function (this: JBigDecimal) { return mkBI(toBigInt(this, false)); },
    "toBigIntegerExact()Ljava/math/BigInteger;": function (this: JBigDecimal) { return mkBI(toBigInt(this, true)); },
    "doubleValue()D": function (this: JBigDecimal) { return Number(`${this.u}e${-this.sc}`); },
    "floatValue()F": function (this: JBigDecimal) { return Math.fround(Number(`${this.u}e${-this.sc}`)); },
    "intValue()I": function (this: JBigDecimal) { return Number(BigInt.asIntN(32, toBigInt(this, false))); },
    "longValue()J": function (this: JBigDecimal) { return BigInt.asIntN(64, toBigInt(this, false)); },
    "intValueExact()I": function (this: JBigDecimal) { return Number(intExact(this, 32)); },
    "longValueExact()J": function (this: JBigDecimal) { return intExact(this, 64); },
    "shortValueExact()S": function (this: JBigDecimal) { return Number(intExact(this, 16)); },
    "byteValueExact()B": function (this: JBigDecimal) { return Number(intExact(this, 8)); },
    "compareTo(Ljava/math/BigDecimal;)I": function (this: JBigDecimal, o: JBigDecimal) { return cmp(this, o); },
    "compareTo(Ljava/lang/Object;)I": function (this: JBigDecimal, o: JBigDecimal) { return cmp(this, o); },
    "equals(Ljava/lang/Object;)Z": function (this: JBigDecimal, o: unknown) {
      return o instanceof JBigDecimal && o.u === this.u && o.sc === this.sc ? 1 : 0;
    },
    "hashCode()I": function (this: JBigDecimal) { return (31 * biHash(this.u) + this.sc) | 0; },
    "toString()Ljava/lang/String;": function (this: JBigDecimal) { return layout(this, true); },
    "toEngineeringString()Ljava/lang/String;": function (this: JBigDecimal) { return layout(this, true, true); },
    "toPlainString()Ljava/lang/String;": function (this: JBigDecimal) { return layout(this, false); },
  },
});
function divScaled(a: JBigDecimal, b: JBigDecimal, sc: number, mode: number): JBigDecimal {
  if (b.u === 0n) arith(a.u === 0n ? "Division undefined" : "Division by zero");
  checkScale(sc);
  const shift = sc - (a.sc - b.sc);
  return mkBD(shift >= 0 ? divRound(a.u * pow10(shift), b.u, mode) : divRound(a.u, b.u * pow10(-shift), mode), sc);
}

export class JBigInteger extends JObj { v = 0n; }
export function modInverse(a: bigint, m: bigint): bigint {
  let [r0, r1, t0, t1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r0 !== 0n) { const q = r1 / r0; [r0, r1] = [r1 - q * r0, r0]; [t0, t1] = [t1 - q * t0, t0]; }
  if (r1 !== 1n) arith("BigInteger not invertible.");
  return ((t1 % m) + m) % m;
}
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n % m;
  for (b %= m; e > 0n; e >>= 1n, b = b * b % m) if (e & 1n) r = r * b % m;
  return r;
}
// Miller-Rabin on the first primes as witnesses: exact below 3.3e24, and past that the
// error chance is far below any certainty an app asks for
function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n];
  for (const b of bases) if (n === b) return true; else if (n % b === 0n) return false;
  let d = n - 1n, r = 0;
  while (!(d & 1n)) { d >>= 1n; r++; }
  witness: for (const a of bases) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < r; i++) { x = x * x % n; if (x === n - 1n) continue witness; }
    return false;
  }
  return true;
}
export function mkBI(v: bigint): JBigInteger { const b = new JBigInteger(); b.v = v; return b; }
function bytesToBig(b: Int8Array): bigint { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x & 0xff); return v; }
// Java's bitLength: bits of the minimal two's-complement form, sign bit excluded.
function bitLength(v: bigint): number { const m = v < 0n ? ~v : v; return m === 0n ? 0 : m.toString(2).length; }
// JDK hashCode: 31-fold over the big-endian int[] magnitude, times signum
function biHash(v: bigint): number {
  let h = 0;
  const a = babs(v);
  const words = (bitLength(a) + 31) >> 5;
  for (let i = words - 1; i >= 0; i--) h = (31 * h + Number((a >> BigInt(32 * i)) & 0xffffffffn)) | 0;
  return (h * bsig(v)) | 0;
}
function parseBI(s: string, radix = 10): bigint {
  if (radix < 2 || radix > 36) nfe("Radix out of range");
  const m = /^([+-]?)([0-9a-zA-Z]+)$/.exec(s);
  if (!m) nfe(`For input string: "${s}"`);
  let v = 0n;
  const R = BigInt(radix);
  for (const ch of m![2].toLowerCase()) {
    const d = parseInt(ch, 36);
    if (!(d < radix)) nfe(`For input string: "${s}"`);
    v = v * R + BigInt(d);
  }
  return m![1] === "-" ? -v : v;
}
rt.register({
  name: "java/math/BigInteger", ctor: JBigInteger, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable"],
  statics: { ZERO: mkBI(0n), ONE: mkBI(1n), TWO: mkBI(2n), TEN: mkBI(10n) },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JBigInteger, s: string) { this.v = parseBI(s); },
    "<init>(Ljava/lang/String;I)V": function (this: JBigInteger, s: string, r: number) { this.v = parseBI(s, r); },
    "<init>(I[B)V": function (this: JBigInteger, signum: number, mag: Int8Array) {
      if (signum < -1 || signum > 1) nfe("Invalid signum value");
      const m = bytesToBig(mag);
      if (signum === 0 && m !== 0n) nfe("signum-magnitude mismatch");
      this.v = BigInt(signum) * m;
    },
    "<init>([B)V": function (this: JBigInteger, b: Int8Array) {
      if (b.length === 0) nfe("Zero length BigInteger");
      this.v = BigInt.asIntN(8 * b.length, bytesToBig(b));
    },
    "<init>(ILjava/util/Random;)V": async function (this: JBigInteger, bits: number, random: unknown) {
      if (bits < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "numBits must be non-negative");
      if (bits === 0) { this.v = 0n; return; }
      const bytes = new Int8Array((bits + 7) >> 3);
      await vcall(random, "nextBytes", "([B)V", bytes);
      bytes[0] &= (1 << ((bits - 1) & 7) + 1) - 1;
      this.v = bytesToBig(bytes);
    },
    "static valueOf(J)Ljava/math/BigInteger;": (v: bigint) => mkBI(v),
    "toByteArray()[B": function (this: JBigInteger) {
      const out = new Int8Array((bitLength(this.v) >> 3) + 1);
      for (let i = out.length - 1, v = this.v; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
      return out;
    },
    "add(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v + o.v); },
    "subtract(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v - o.v); },
    "multiply(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v * o.v); },
    "divide(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) {
      if (o.v === 0n) arith("BigInteger divide by zero");
      return mkBI(this.v / o.v);
    },
    "remainder(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) {
      if (o.v === 0n) arith("BigInteger divide by zero");
      return mkBI(this.v % o.v);
    },
    "divideAndRemainder(Ljava/math/BigInteger;)[Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) {
      if (o.v === 0n) arith("BigInteger divide by zero");
      return jarray([mkBI(this.v / o.v), mkBI(this.v % o.v)], "Ljava/math/BigInteger;");
    },
    "mod(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, m: JBigInteger) {
      if (m.v <= 0n) arith("BigInteger: modulus not positive");
      return mkBI(((this.v % m.v) + m.v) % m.v);
    },
    "pow(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) {
      if (n < 0) arith("Negative exponent");
      return mkBI(this.v ** BigInt(n));
    },
    "modPow(Ljava/math/BigInteger;Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, e: JBigInteger, m: JBigInteger) {
      if (m.v <= 0n) arith("BigInteger: modulus not positive");
      return mkBI(modPow(e.v < 0n ? modInverse(this.v, m.v) : ((this.v % m.v) + m.v) % m.v, e.v < 0n ? -e.v : e.v, m.v));
    },
    "modInverse(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, m: JBigInteger) {
      if (m.v <= 0n) arith("BigInteger: modulus not positive");
      return mkBI(modInverse(this.v, m.v));
    },
    "isProbablePrime(I)Z": function (this: JBigInteger) { return isProbablePrime(this.v < 0n ? -this.v : this.v) ? 1 : 0; },
    "sqrt()Ljava/math/BigInteger;": function (this: JBigInteger) {
      if (this.v < 0n) arith("negative BigInteger");
      return mkBI(isqrt(this.v));
    },
    "gcd(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) {
      let a = babs(this.v), b = babs(o.v);
      while (b !== 0n) [a, b] = [b, a % b];
      return mkBI(a);
    },
    "negate()Ljava/math/BigInteger;": function (this: JBigInteger) { return mkBI(-this.v); },
    "abs()Ljava/math/BigInteger;": function (this: JBigInteger) { return mkBI(babs(this.v)); },
    "shiftLeft(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(n >= 0 ? this.v << BigInt(n) : this.v >> BigInt(-n)); },
    "shiftRight(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(n >= 0 ? this.v >> BigInt(n) : this.v << BigInt(-n)); },
    "and(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v & o.v); },
    "or(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v | o.v); },
    "xor(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v ^ o.v); },
    "not()Ljava/math/BigInteger;": function (this: JBigInteger) { return mkBI(~this.v); },
    "setBit(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(this.v | (1n << BigInt(n))); },
    "clearBit(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(this.v & ~(1n << BigInt(n))); },
    "testBit(I)Z": function (this: JBigInteger, n: number) { return (this.v >> BigInt(n)) & 1n ? 1 : 0; },
    "bitLength()I": function (this: JBigInteger) { return bitLength(this.v); },
    "bitCount()I": function (this: JBigInteger) {
      let n = 0;
      for (let m = this.v < 0n ? ~this.v : this.v; m !== 0n; m >>= 1n) n += Number(m & 1n);
      return n;
    },
    "signum()I": function (this: JBigInteger) { return bsig(this.v); },
    "min(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return this.v <= o.v ? this : o; },
    "max(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return this.v >= o.v ? this : o; },
    "longValue()J": function (this: JBigInteger) { return BigInt.asIntN(64, this.v); },
    "intValue()I": function (this: JBigInteger) { return Number(BigInt.asIntN(32, this.v)); },
    "longValueExact()J": function (this: JBigInteger) {
      if (this.v !== BigInt.asIntN(64, this.v)) arith("BigInteger out of long range");
      return this.v;
    },
    "intValueExact()I": function (this: JBigInteger) {
      if (this.v !== BigInt.asIntN(32, this.v)) arith("BigInteger out of int range");
      return Number(this.v);
    },
    "doubleValue()D": function (this: JBigInteger) { return Number(this.v); },
    "floatValue()F": function (this: JBigInteger) { return Math.fround(Number(this.v)); },
    "toString()Ljava/lang/String;": function (this: JBigInteger) { return this.v.toString(); },
    "toString(I)Ljava/lang/String;": function (this: JBigInteger, r: number) { return this.v.toString(r >= 2 && r <= 36 ? r : 10); },
    "compareTo(Ljava/math/BigInteger;)I": function (this: JBigInteger, o: JBigInteger) {
      return this.v < o.v ? -1 : this.v > o.v ? 1 : 0;
    },
    "compareTo(Ljava/lang/Object;)I": function (this: JBigInteger, o: JBigInteger) {
      return this.v < o.v ? -1 : this.v > o.v ? 1 : 0;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JBigInteger, o: unknown) { return o instanceof JBigInteger && o.v === this.v ? 1 : 0; },
    "hashCode()I": function (this: JBigInteger) { return biHash(this.v); },
  },
});
