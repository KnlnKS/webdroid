// java.math runs from libcore. NativeBN, the BIGNUM boundary its modPow, multiply and divide take for
// large operands, is JS bigint.

import { rt, type Intrinsic } from "../runtime";
import { handle, deref, release } from "../../android/handles";
import { jarray, mangleField } from "../abi";

const BIG_INTEGER = "java/math/BigInteger";
const SIG = mangleField(BIG_INTEGER, "signum"), MAG = mangleField(BIG_INTEGER, "mag"), WORDS = MAG + "$w";
type BI = Record<string, any>;

/** big-endian 32-bit words, most significant first → the magnitude */
function wordsToBig(m: Int32Array, len = m.length, littleEndian = false): bigint {
  if (len === 0) return 0n;
  if (len === 1) return BigInt(m[0] >>> 0);
  let hex = "";
  for (let i = 0; i < len; i++) hex += (m[littleEndian ? len - 1 - i : i] >>> 0).toString(16).padStart(8, "0");
  return BigInt("0x" + hex);
}
/** a non-negative value's big-endian 32-bit words, without leading zero words */
function bigToWords(v: bigint): Int32Array {
  if (v === 0n) return new Int32Array(0);
  if (v <= 0xffffffffn) return Int32Array.of(Number(v) | 0);
  const hex = v.toString(16), n = (hex.length + 7) >> 3, out = new Int32Array(n);
  for (let i = n - 1, end = hex.length; i >= 0; i--, end -= 8) out[i] = parseInt(hex.slice(Math.max(0, end - 8), end), 16) | 0;
  return out;
}

/** a⁻¹ mod m, null when a is not invertible */
function inverse(a: bigint, m: bigint): bigint | null {
  let [r0, r1, t0, t1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r0 !== 0n) { const q = r1 / r0; [r0, r1] = [r1 - q * r0, r0]; [t0, t1] = [t1 - q * t0, t0]; }
  return r1 === 1n ? ((t1 % m) + m) % m : null;
}
export function modInverse(a: bigint, m: bigint): bigint {
  const v = inverse(a, m);
  if (v === null) throw rt.mkThrowable("java/lang/ArithmeticException", "BigInteger not invertible.");
  return v;
}
/** b^e mod m for e ≥ 0, m > 0: left to right over windows of up to five exponent bits ending in a
 *  one, each a multiplication by a precomputed odd power (a fifth fewer products than bit by bit) */
export function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n % m;
  b = ((b % m) + m) % m;
  if (e < 64n) {
    for (; e > 0n; e >>= 1n, b = b * b % m) if (e & 1n) r = r * b % m;
    return r;
  }
  const bits = e.toString(2), b2 = b * b % m, odd = [b];
  for (let i = 1; i < 16; i++) odd.push(odd[i - 1] * b2 % m);
  for (let i = 0; i < bits.length; ) {
    if (bits.charCodeAt(i) === 48) { r = r * r % m; i++; continue; }
    let j = Math.min(i + 5, bits.length);
    while (bits.charCodeAt(j - 1) === 48) j--;
    for (let k = i; k < j; k++) r = r * r % m;
    r = r * odd[parseInt(bits.slice(i, j), 2) >> 1] % m;
    i = j;
  }
  return r;
}

// libcore_math_NativeBN.cpp over BoringSSL's BIGNUM: a handle to a signed value
type BN = { v: bigint };
const bn = (h: bigint) => deref<BN>(h);
rt.registerJni("libcore/math/NativeBN", "BN_new()J", () => handle({ v: 0n }));
rt.registerJni("libcore/math/NativeBN", "BN_free(J)V", (h: bigint) => release(h));
rt.registerJni("libcore/math/NativeBN", "litEndInts2bn([IIZJ)V", (ints: Int32Array, len: number, neg: number, h: bigint) => {
  const v = wordsToBig(ints, len, true);
  bn(h).v = neg ? -v : v;
});
// the magnitude's little-endian words, as many as its bytes need
rt.registerJni("libcore/math/NativeBN", "bn2litEndInts(J)[I", (h: bigint) => {
  const v = bn(h).v;
  return bigToWords(v < 0n ? -v : v).reverse();
});
rt.registerJni("libcore/math/NativeBN", "BN_mul(JJJ)V", (r: bigint, a: bigint, b: bigint) => { bn(r).v = bn(a).v * bn(b).v; });
// BN_div: a truncated quotient and a remainder with the dividend's sign
rt.registerJni("libcore/math/NativeBN", "BN_div(JJJJ)V", (dv: bigint, rem: bigint, m: bigint, d: bigint) => {
  const x = bn(m).v, y = bn(d).v;
  if (y === 0n) throw rt.mkThrowable("java/lang/ArithmeticException", "BigInteger division by zero");
  if (dv) bn(dv).v = x / y;
  if (rem) bn(rem).v = x % y;
});
// BN_mod_exp reduces a negative or oversized base first and answers in [0, m)
rt.registerJni("libcore/math/NativeBN", "BN_mod_exp(JJJJ)V", (r: bigint, a: bigint, p: bigint, m: bigint) => {
  const mod = bn(m).v;
  if (mod === 0n) throw rt.mkThrowable("java/lang/ArithmeticException", "BigInteger division by zero");
  bn(r).v = modPow(bn(a).v, bn(p).v, mod < 0n ? -mod : mod);
});

// §4.7 intrinsics: BigInteger's arithmetic over JS bigint, where libcore's bodies do their word
// arithmetic in Java longs (BigInts here). Each keeps AOSP's identity shortcuts (x.add(ZERO) is x)
// and leaves every exceptional case (null arguments, zero divisors, negative exponents,
// non-invertible values, non-ASCII digits) to the AOSP body. The value is cached on the immutable
// object as `$v`, and an intrinsic's result holds only that: its `mag` is an accessor on the
// class, installed before any instance exists, that writes the words out when bytecode reads them.
let klass: (new () => BI) | null = null, zero: BI | null = null, one: BI | null = null;
const cls = () => klass ??= rt.link(BIG_INTEGER).ctor as never; // js-tier
const statik = (name: string) => (cls() as unknown as BI)[rt.link(BIG_INTEGER).staticFieldTable.get(name + ":Ljava/math/BigInteger;")!] as BI; // js-tier
const ZERO = () => zero ??= statik("ZERO"), ONE = () => one ??= statik("ONE");
function lazyMagnitude(C: { prototype: object }) {
  if (Object.hasOwn(C.prototype, MAG)) return;
  Object.defineProperty(C.prototype, MAG, {
    get(this: BI) {
      let m = this[WORDS];
      if (m === undefined) {
        const v: bigint = this.$v, a = v < 0n ? -v : v;
        m = this[WORDS] = a <= 0xffffffffn ? (a === 0n ? new Int32Array(0) : Int32Array.of(Number(a) | 0))
          : a <= 0xffffffffffffffffn ? Int32Array.of(Number(a >> 32n) | 0, Number(a & 0xffffffffn) | 0) : bigToWords(a);
      }
      return m;
    },
    set(this: BI, m: Int32Array | null) { this[WORDS] = m; },
  });
}
function val(b: BI): bigint {
  let v: bigint | undefined = b.$v;
  if (v === undefined) {
    const m = b[MAG] as Int32Array;
    v = m.length === 1 ? BigInt(m[0] >>> 0) : m.length === 2 ? BigInt(m[0] >>> 0) << 32n | BigInt(m[1] >>> 0) : wordsToBig(m);
    if (b[SIG] < 0) v = -v;
    b.$v = v;
  }
  return v;
}
function set(b: BI, v: bigint): BI {
  b[SIG] = v < 0n ? -1 : v > 0n ? 1 : 0;
  b[WORDS] = undefined;
  b.$v = v;
  return b;
}
const make = (v: bigint): BI => v === 0n ? ZERO() : set(new (cls())(), v);
const isBI = (o: unknown): o is BI => o != null && ((o as BI).constructor === klass || o instanceof cls());
type Base = (this: BI, ...a: any[]) => any;
const binary = (op: (x: bigint, y: bigint, self: BI, other: BI) => BI | null) => (base: Base) => function (this: BI, o: BI | null) {
  if (!isBI(o)) return base.call(this, o);
  return op(val(this), val(o), this, o) ?? base.call(this, o);
};
const digitPatterns = new Map<number, RegExp>();
/** an ASCII numeral's value, null for anything the AOSP parser must judge */
function parse(s: unknown, radix: number): bigint | null {
  if (typeof s !== "string" || radix < 2 || radix > 36) return null;
  let re = digitPatterns.get(radix);
  if (!re) {
    const digits = radix <= 10 ? `0-${radix - 1}` : `0-9a-${String.fromCharCode(86 + radix)}A-${String.fromCharCode(54 + radix)}`;
    digitPatterns.set(radix, re = new RegExp(`^[+-]?[${digits}]+$`));
  }
  if (!re.test(s)) return null;
  const neg = s[0] === "-", body = s[0] === "-" || s[0] === "+" ? s.slice(1) : s;
  let v: bigint;
  if (radix === 10) v = BigInt(body);
  else if (radix === 16) v = BigInt("0x" + body);
  else if (radix === 2) v = BigInt("0b" + body);
  else if (radix === 8) v = BigInt("0o" + body);
  else { v = 0n; const R = BigInt(radix); for (const ch of body.toLowerCase()) v = v * R + BigInt(parseInt(ch, 36)); }
  return neg ? -v : v;
}
/** shiftLeft (`dir` 1) and shiftRight (-1); a negative distance shifts the other way */
const shift = (dir: 1 | -1): Intrinsic => (base) => function (this: BI, n: number) {
  const v = val(this);
  if (n === 0) return this;
  if (v === 0n) return ZERO();
  if (n === -2147483648) return base.call(this, n);
  const left = n * dir;
  return make(left > 0 ? v << BigInt(left) : v >> BigInt(-left));
};
const bitLen = (v: bigint) => { const m = v < 0n ? ~v : v; return m === 0n ? 0 : m.toString(2).length; };
const B = "Ljava/math/BigInteger;";
const intrinsics: Record<string, Intrinsic> = {
  "<init>(Ljava/lang/String;)V": (base) => function (this: BI, s: string) { const v = parse(s, 10); if (v === null) return base.call(this, s); set(this, v); },
  "<init>(Ljava/lang/String;I)V": (base) => function (this: BI, s: string, r: number) { const v = parse(s, r); if (v === null) return base.call(this, s, r); set(this, v); },
  "<init>([B)V": (base) => function (this: BI, b: Int8Array | null) {
    if (!b?.length) return base.call(this, b);
    let v = 0n;
    for (let i = 0; i < b.length; i += 6) {
      const n = Math.min(6, b.length - i);
      let w = 0;
      for (let j = 0; j < n; j++) w = w * 256 + (b[i + j] & 255);
      v = (v << BigInt(8 * n)) | BigInt(w);
    }
    set(this, BigInt.asIntN(8 * b.length, v));
  },
  [`static valueOf(J)${B}`]: (base) => (x: bigint) => x >= -16n && x <= 16n ? base(x) : set(new (cls())(), x),
  [`add(${B})${B}`]: binary((x, y, s, o) => y === 0n ? s : x === 0n ? o : make(x + y)),
  [`subtract(${B})${B}`]: binary((x, y, s) => y === 0n ? s : make(x - y)),
  [`multiply(${B})${B}`]: binary((x, y) => x === 0n || y === 0n ? ZERO() : make(x * y)),
  [`divide(${B})${B}`]: binary((x, y) => y === 0n ? null : make(x / y)),
  [`remainder(${B})${B}`]: binary((x, y) => y === 0n ? null : make(x % y)),
  [`mod(${B})${B}`]: binary((x, y) => y <= 0n ? null : make(((x % y) + y) % y)),
  [`divideAndRemainder(${B})[${B}`]: binary((x, y) => y === 0n ? null : jarray([make(x / y), make(x % y)], B) as never),
  [`gcd(${B})${B}`]: binary((x, y) => { let a = x < 0n ? -x : x, b = y < 0n ? -y : y; while (b) [a, b] = [b, a % b]; return make(a); }),
  [`modInverse(${B})${B}`]: binary((x, m) => {
    const v = m > 0n ? inverse(x, m) : null;
    return v === null ? null : make(v);
  }),
  [`modPow(${B}${B})${B}`]: (base) => function (this: BI, e: BI | null, m: BI | null) {
    if (!isBI(e) || !isBI(m)) return base.call(this, e, m);
    const x = val(this), p = val(e), n = val(m);
    return n <= 0n || p < 0n ? base.call(this, e, m) : make(modPow(x, p, n));
  },
  [`pow(I)${B}`]: (base) => function (this: BI, e: number) { return e < 0 ? base.call(this, e) : e === 0 ? ONE() : make(val(this) ** BigInt(e)); },
  [`shiftLeft(I)${B}`]: shift(1),
  [`shiftRight(I)${B}`]: shift(-1),
  [`compareTo(${B})I`]: (base) => function (this: BI, o: BI | null) {
    if (!isBI(o)) return base.call(this, o);
    const x = val(this), y = val(o);
    return x < y ? -1 : x > y ? 1 : 0;
  },
  "equals(Ljava/lang/Object;)Z": () => function (this: BI, o: unknown) { return o === this ? 1 : isBI(o) && val(this) === val(o) ? 1 : 0; },
  "hashCode()I": () => function (this: BI) {
    const m = this[MAG] as Int32Array;
    let h = 0;
    for (let i = 0; i < m.length; i++) h = (Math.imul(31, h) + m[i]) | 0;
    return Math.imul(h, this[SIG]) | 0;
  },
  "toString(I)Ljava/lang/String;": () => function (this: BI, r: number) { return val(this).toString(r < 2 || r > 36 ? 10 : r); },
  "toString()Ljava/lang/String;": () => function (this: BI) { return val(this).toString(); },
  "intValue()I": () => function (this: BI) { return Number(BigInt.asIntN(32, val(this))); },
  "longValue()J": () => function (this: BI) { return BigInt.asIntN(64, val(this)); },
  "bitLength()I": () => function (this: BI) { return bitLen(val(this)); },
  "testBit(I)Z": (base) => function (this: BI, n: number) { return n < 0 ? base.call(this, n) : Number((val(this) >> BigInt(n)) & 1n); },
  "toByteArray()[B": () => function (this: BI) {
    const v = val(this), n = (bitLen(v) >> 3) + 1, out = new Int8Array(n);
    let u = BigInt.asUintN(8 * n, v);
    for (let i = n - 1; i >= 0; i--, u >>= 8n) out[i] = Number(u & 255n);
    return out;
  },
};
// the first body made installs the accessor, with the class still empty
rt.intrinsic(BIG_INTEGER, Object.fromEntries(Object.entries(intrinsics).map(([sig, make]) =>
  [sig, (base, C) => { if (C) lazyMagnitude(C); return make(base, C); }] satisfies [string, Intrinsic])));
