// java.math: BigDecimal/BigInteger as number/bigint-backed approximations.

import { rt, JObj } from "../runtime";
import { mkEnumSet } from "./jlang";

// ── BigDecimal / BigInteger (number-backed approximations, scale-aware formatting)
class JBigDecimal extends JObj { v = 0; scale = 0; }
function mkBD(v: number, scale = decScaleOf(v)): JBigDecimal {
  const b = new JBigDecimal();
  b.v = v;
  b.scale = scale;
  return b;
}
function decScaleOf(v: number): number {
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(10, s.length - i - 1);
}
mkEnumSet("java/math/RoundingMode", ["UP", "DOWN", "CEILING", "FLOOR", "HALF_UP", "HALF_DOWN", "HALF_EVEN", "UNNECESSARY"]);
rt.register({
  name: "java/math/BigDecimal", ctor: JBigDecimal, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable"],
  statics: { ZERO: mkBD(0), ONE: mkBD(1), TEN: mkBD(10), ROUND_HALF_UP: 4, ROUND_DOWN: 1, ROUND_HALF_EVEN: 6 },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JBigDecimal, s: string) {
      const v = parseFloat(s);
      if (Number.isNaN(v)) throw rt.mkThrowable("java/lang/NumberFormatException", s);
      this.v = v;
      this.scale = decScaleOf(v);
    },
    "<init>(D)V": function (this: JBigDecimal, v: number) { this.v = v; this.scale = decScaleOf(v); },
    "<init>(I)V": function (this: JBigDecimal, v: number) { this.v = v; },
    "<init>(J)V": function (this: JBigDecimal, v: bigint) { this.v = Number(v); },
    "static valueOf(D)Ljava/math/BigDecimal;": (v: number) => mkBD(v),
    "static valueOf(J)Ljava/math/BigDecimal;": (v: bigint) => mkBD(Number(v)),
    "static valueOf(JI)Ljava/math/BigDecimal;": (v: bigint, s: number) => mkBD(Number(v) / 10 ** s, s),
    "add(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      return mkBD(this.v + o.v, Math.max(this.scale, o.scale));
    },
    "subtract(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      return mkBD(this.v - o.v, Math.max(this.scale, o.scale));
    },
    "multiply(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      return mkBD(this.v * o.v, this.scale + o.scale);
    },
    "divide(Ljava/math/BigDecimal;II)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, scale: number) {
      return mkBD(Number((this.v / o.v).toFixed(scale)), scale);
    },
    "divide(Ljava/math/BigDecimal;ILjava/math/RoundingMode;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal, scale: number) {
      return mkBD(Number((this.v / o.v).toFixed(scale)), scale);
    },
    "divide(Ljava/math/BigDecimal;)Ljava/math/BigDecimal;": function (this: JBigDecimal, o: JBigDecimal) {
      return mkBD(this.v / o.v);
    },
    "setScale(II)Ljava/math/BigDecimal;": function (this: JBigDecimal, scale: number) {
      return mkBD(Number(this.v.toFixed(Math.max(0, scale))), scale);
    },
    "setScale(ILjava/math/RoundingMode;)Ljava/math/BigDecimal;": function (this: JBigDecimal, scale: number, mode: any) {
      const m = mode?.ename;
      if (m === "DOWN" || m === "FLOOR") {
        const f = 10 ** scale;
        return mkBD(Math.floor(this.v * f) / f, scale);
      }
      if (m === "UP" || m === "CEILING") {
        const f = 10 ** scale;
        return mkBD(Math.ceil(this.v * f) / f, scale);
      }
      return mkBD(Number(this.v.toFixed(Math.max(0, scale))), scale);
    },
    "stripTrailingZeros()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return mkBD(this.v); },
    "negate()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return mkBD(-this.v, this.scale); },
    "abs()Ljava/math/BigDecimal;": function (this: JBigDecimal) { return mkBD(Math.abs(this.v), this.scale); },
    "doubleValue()D": function (this: JBigDecimal) { return this.v; },
    "floatValue()F": function (this: JBigDecimal) { return Math.fround(this.v); },
    "intValue()I": function (this: JBigDecimal) { return Math.trunc(this.v) | 0; },
    "longValue()J": function (this: JBigDecimal) { return BigInt(Math.trunc(this.v)); },
    "compareTo(Ljava/math/BigDecimal;)I": function (this: JBigDecimal, o: JBigDecimal) {
      return this.v < o.v ? -1 : this.v > o.v ? 1 : 0;
    },
    "compareTo(Ljava/lang/Object;)I": function (this: JBigDecimal, o: JBigDecimal) {
      return this.v < o.v ? -1 : this.v > o.v ? 1 : 0;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JBigDecimal, o: unknown) {
      return o instanceof JBigDecimal && o.v === this.v && o.scale === this.scale ? 1 : 0;
    },
    "hashCode()I": function (this: JBigDecimal) { return (this.v * 31) | 0; },
    "signum()I": function (this: JBigDecimal) { return Math.sign(this.v); },
    "scale()I": function (this: JBigDecimal) { return this.scale; },
    "toString()Ljava/lang/String;": function (this: JBigDecimal) {
      return this.scale > 0 ? this.v.toFixed(this.scale) : String(this.v);
    },
    "toPlainString()Ljava/lang/String;": function (this: JBigDecimal) {
      return this.scale > 0 ? this.v.toFixed(this.scale) : String(this.v);
    },
  },
});
class JBigInteger extends JObj { v = 0n; }
function mkBI(v: bigint): JBigInteger { const b = new JBigInteger(); b.v = v; return b; }
function nfe(msg: string): never { throw rt.mkThrowable("java/lang/NumberFormatException", msg); }
function bytesToBig(b: Int8Array): bigint { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x & 0xff); return v; }
// Java's bitLength: bits of the minimal two's-complement form, sign bit excluded.
function bitLength(v: bigint): number { const m = v < 0n ? ~v : v; return m === 0n ? 0 : m.toString(2).length; }
rt.register({
  name: "java/math/BigInteger", ctor: JBigInteger, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable"],
  statics: { ZERO: mkBI(0n), ONE: mkBI(1n) },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JBigInteger, s: string) { this.v = BigInt(s); },
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
    "static valueOf(J)Ljava/math/BigInteger;": (v: bigint) => mkBI(v),
    "toByteArray()[B": function (this: JBigInteger) {
      const out = new Int8Array((bitLength(this.v) >> 3) + 1);
      for (let i = out.length - 1, v = this.v; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
      return out;
    },
    "add(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v + o.v); },
    "subtract(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v - o.v); },
    "multiply(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, o: JBigInteger) { return mkBI(this.v * o.v); },
    "mod(Ljava/math/BigInteger;)Ljava/math/BigInteger;": function (this: JBigInteger, m: JBigInteger) { return mkBI(((this.v % m.v) + m.v) % m.v); },
    "negate()Ljava/math/BigInteger;": function (this: JBigInteger) { return mkBI(-this.v); },
    "abs()Ljava/math/BigInteger;": function (this: JBigInteger) { return mkBI(this.v < 0n ? -this.v : this.v); },
    "shiftLeft(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(this.v << BigInt(n)); },
    "shiftRight(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(this.v >> BigInt(n)); },
    "setBit(I)Ljava/math/BigInteger;": function (this: JBigInteger, n: number) { return mkBI(this.v | (1n << BigInt(n))); },
    "bitLength()I": function (this: JBigInteger) { return bitLength(this.v); },
    "signum()I": function (this: JBigInteger) { return this.v < 0n ? -1 : this.v > 0n ? 1 : 0; },
    "longValue()J": function (this: JBigInteger) { return BigInt.asIntN(64, this.v); },
    "intValue()I": function (this: JBigInteger) { return Number(BigInt.asIntN(32, this.v)); },
    "doubleValue()D": function (this: JBigInteger) { return Number(this.v); },
    "toString()Ljava/lang/String;": function (this: JBigInteger) { return this.v.toString(); },
    "toString(I)Ljava/lang/String;": function (this: JBigInteger, r: number) { return this.v.toString(r >= 2 && r <= 36 ? r : 10); },
    "compareTo(Ljava/math/BigInteger;)I": function (this: JBigInteger, o: JBigInteger) {
      return this.v < o.v ? -1 : this.v > o.v ? 1 : 0;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JBigInteger, o: unknown) { return o instanceof JBigInteger && o.v === this.v ? 1 : 0; },
    "hashCode()I": function (this: JBigInteger) { return Number(BigInt.asIntN(32, this.v ^ (this.v >> 32n))); },
  },
});
