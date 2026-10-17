// java.math runs from libcore. NativeBN, the BIGNUM boundary its modPow, multiply and divide take for
// large operands, is JS bigint.

import { rt } from "../runtime.ts";
import { handle, deref, release } from "../../android/handles.ts";

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
