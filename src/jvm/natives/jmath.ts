// java.math runs from libcore. NativeBN, the BIGNUM boundary its modPow, multiply and divide take for
// large operands, is JS bigint.

import { rt } from "../runtime.ts";
import { handle, deref, release } from "../../android/handles.ts";
import { modPow } from "../../crypto/bigint.ts";

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
