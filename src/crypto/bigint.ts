// bigint arithmetic and byte conversions for the public-key algorithms, DER and NativeBN.

import { hexBytes } from "../jvm/abi.ts";

/** unsigned big-endian bytes ↔ bigint */
export const bytesToBig = (b: Uint8Array): bigint => b.length ? BigInt("0x" + b.toHex()) : 0n;
/** `v` as `len` big-endian bytes, its high bytes cut or zeros added (minimal when len is omitted) */
export function bigToBytes(v: bigint, len?: number): Uint8Array {
  let hex = v ? v.toString(16) : "";
  if (hex.length & 1) hex = "0" + hex;
  if (len !== undefined) { hex = hex.padStart(2 * len, "0"); hex = hex.slice(hex.length - 2 * len); }
  return hexBytes(hex);
}
/** a⁻¹ mod m */
export function modInverse(a: bigint, m: bigint): bigint {
  let [r0, r1, t0, t1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r0 !== 0n) { const q = r1 / r0; [r0, r1] = [r1 - q * r0, r0]; [t0, t1] = [t1 - q * t0, t0]; }
  if (r1 !== 1n) throw new RangeError("not invertible");
  return ((t1 % m) + m) % m;
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
