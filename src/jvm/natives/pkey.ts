// BoringSSL's public-key algorithms over bigint: RSA (RFC 8017 paddings), ECDSA/ECDH on the prime
// curves BoringSSL builds in (and arbitrary prime curves), and X25519 (RFC 7748); the SPKI and PKCS#8
// encodings EVP_parse_*/EVP_marshal_* read and write.

import { modInverse, modPow } from "./jmath.ts";
import { DIGESTS, type Hash } from "./digest.ts";
import { concat, hexBytes } from "../abi.ts";
import {
  readTlv, children, parseOne, expect, oidToString, tlv, seq, oid, derNull, octets, bits, integer, uintOf,
  bytesToBig, bigToBytes, DerError, SEQUENCE, BIT_STRING, OCTET_STRING, OID,
} from "./der.ts";

export const EVP_PKEY_RSA = 6, EVP_PKEY_EC = 408, EVP_PKEY_X25519 = 948;
const OID_RSA = "1.2.840.113549.1.1.1", OID_EC = "1.2.840.10045.2.1", OID_X25519 = "1.3.101.110";

// ── curves
export type Curve = { name: string; oid: string; bytes: number; p: bigint; a: bigint; b: bigint; gx: bigint; gy: bigint; n: bigint; h: bigint };
const x = (s: string) => BigInt("0x" + s);
export const CURVES: Curve[] = [
  { name: "secp224r1", oid: "1.3.132.0.33", bytes: 28, p: x("ffffffffffffffffffffffffffffffff000000000000000000000001"), a: x("fffffffffffffffffffffffffffffffefffffffffffffffffffffffe"),
    b: x("b4050a850c04b3abf54132565044b0b7d7bfd8ba270b39432355ffb4"), gx: x("b70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21"),
    gy: x("bd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34"), n: x("ffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3d"), h: 1n },
  { name: "prime256v1", oid: "1.2.840.10045.3.1.7", bytes: 32, p: x("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff"),
    a: x("ffffffff00000001000000000000000000000000fffffffffffffffffffffffc"), b: x("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b"),
    gx: x("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"), gy: x("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
    n: x("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"), h: 1n },
  { name: "secp384r1", oid: "1.3.132.0.34", bytes: 48, p: x("fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff"),
    a: x("fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000fffffffc"),
    b: x("b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef"),
    gx: x("aa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7"),
    gy: x("3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f"),
    n: x("ffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973"), h: 1n },
  { name: "secp521r1", oid: "1.3.132.0.35", bytes: 66, p: (1n << 521n) - 1n, a: (1n << 521n) - 4n,
    b: x("51953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00"),
    gx: x("c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66"),
    gy: x("11839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650"),
    n: x("1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409"), h: 1n },
];
export const curveByName = (name: string) => CURVES.find((c) => c.name === name);
const curveByOid = (o: string) => CURVES.find((c) => c.oid === o);
export const bitLength = (v: bigint) => v === 0n ? 0 : v.toString(2).length;

// Jacobian points [X, Y, Z], each coordinate in [0, p); Z = 0 is the point at infinity. Scalar
// multiplication runs wNAF digits over tables of affine odd multiples, so each addition is a mixed
// one (madd-2007-bl); doubling takes dbl-2001-b's 3M+5S on the curves with a = -3.
type Jac = [bigint, bigint, bigint];
export type Point = [bigint, bigint] | null;
const md = (v: bigint, p: bigint) => { const r = v % p; return r < 0n ? r + p : r; };
const INF: Jac = [1n, 1n, 0n];
/** a curve's field; products reduce by Barrett's method (V8: 75 ns against 105 for `%` at 256 bits) */
type Field = { c: Curve; p: bigint; pp: bigint; mu: bigint; lo: bigint; hi: bigint; minus3: boolean };
const fields = new WeakMap<Curve, Field>();
function fieldOf(c: Curve): Field {
  let f = fields.get(c);
  if (!f) {
    const k = BigInt(bitLength(c.p));
    fields.set(c, f = { c, p: c.p, pp: c.p * c.p, mu: (1n << 2n * k) / c.p, lo: k - 1n, hi: k + 1n, minus3: c.a === c.p - 3n });
  }
  return f;
}
/** v mod p, for 0 ≤ v < 16p² */
const red = (f: Field, v: bigint) => { let r = v - ((v >> f.lo) * f.mu >> f.hi) * f.p; while (r >= f.p) r -= f.p; return r; };
function dbl(f: Field, P: Jac): Jac {
  const p = f.p, X = P[0], Y = P[1], Z = P[2];
  if (Z === 0n || Y === 0n) return INF;
  if (!f.minus3) {
    const XX = X * X % p, YY = Y * Y % p, YYYY = YY * YY % p, ZZ = Z * Z % p;
    const S = md(2n * ((X + YY) ** 2n - XX - YYYY), p);
    const M = md(3n * XX + f.c.a * (ZZ * ZZ % p), p);
    const T = md(M * M - 2n * S, p);
    return [T, md(M * (S - T) - 8n * YYYY, p), md((Y + Z) ** 2n - YY - ZZ, p)];
  }
  const delta = red(f, Z * Z), gamma = red(f, Y * Y), beta = red(f, X * gamma);
  const alpha = red(f, 3n * (X + p - delta) * (X + delta)), X3 = red(f, alpha * alpha + 8n * (p - beta));
  return [X3, red(f, alpha * (4n * beta + p - X3) + 8n * (f.pp - gamma * gamma)), red(f, (Y * Z) << 1n)];
}
/** P + (x, y), the affine point negated when `negate` */
function madd(f: Field, P: Jac, x: bigint, y: bigint, negate: boolean): Jac {
  const p = f.p;
  if (negate && y !== 0n) y = p - y;
  if (P[2] === 0n) return [x, y, 1n];
  const X1 = P[0], Y1 = P[1], Z1 = P[2], Z1Z1 = red(f, Z1 * Z1);
  const H = red(f, x * Z1Z1 + p - X1), s = red(f, y * red(f, Z1 * Z1Z1) + p - Y1);
  if (H === 0n) return s === 0n ? dbl(f, P) : INF;
  const r = s << 1n, I = red(f, H * H) << 2n, J = red(f, H * I), V = red(f, X1 * I), X3 = red(f, r * r + (p - J) + ((p - V) << 1n));
  return [X3, red(f, r * (V + p - X3) + ((f.pp - Y1 * J) << 1n)), red(f, (Z1 * H) << 1n)];
}
function add(f: Field, P: Jac, Q: Jac): Jac {
  if (P[2] === 0n) return Q;
  if (Q[2] === 0n) return P;
  const p = f.p, [X1, Y1, Z1] = P, [X2, Y2, Z2] = Q;
  const Z1Z1 = red(f, Z1 * Z1), Z2Z2 = red(f, Z2 * Z2), U1 = red(f, X1 * Z2Z2), S1 = red(f, Y1 * red(f, Z2 * Z2Z2));
  const H = red(f, X2 * Z1Z1 + p - U1), s = red(f, Y2 * red(f, Z1 * Z1Z1) + p - S1);
  if (H === 0n) return s === 0n ? dbl(f, P) : INF;
  const r = s << 1n, I = red(f, H * H) << 2n, J = red(f, H * I), V = red(f, U1 * I), X3 = red(f, r * r + (p - J) + ((p - V) << 1n));
  return [X3, red(f, r * (V + p - X3) + ((f.pp - S1 * J) << 1n)), red(f, red(f, Z1 * Z2) * H << 1n)];
}
function toAffine(c: Curve, P: Jac): Point {
  if (P[2] === 0n) return null;
  const zi = modInverse(P[2], c.p), zi2 = zi * zi % c.p;
  return [P[0] * zi2 % c.p, P[1] * zi2 % c.p * zi % c.p];
}
/** P, 3P, 5P, … (2^(w-2) of them) in affine form, one inversion for all; null for a multiple at infinity */
function oddMultiples(f: Field, P: [bigint, bigint], w: number): Point[] {
  const p = f.p, base: Jac = [md(P[0], p), md(P[1], p), 1n], twice = dbl(f, base), jac: Jac[] = [base];
  for (let i = 1; i < 1 << (w - 2); i++) jac.push(add(f, jac[i - 1], twice));
  // Montgomery's trick: prefix products of the Zs, one inverse, then back down
  const prefix: bigint[] = [];
  let acc = 1n;
  for (const q of jac) { prefix.push(acc); if (q[2] !== 0n) acc = acc * q[2] % p; }
  let inv = modInverse(acc, p);
  const out: Point[] = new Array(jac.length);
  for (let i = jac.length - 1; i >= 0; i--) {
    const q = jac[i];
    if (q[2] === 0n) { out[i] = null; continue; }
    const zi = inv * prefix[i] % p, zi2 = zi * zi % p;
    inv = inv * q[2] % p;
    out[i] = [q[0] * zi2 % p, q[1] * zi2 % p * zi % p];
  }
  return out;
}
/** width-w NAF digits of k ≥ 0, least significant first: odd digits in (-2^(w-1), 2^(w-1)), each
 *  followed by at least w-1 zeros */
function wnaf(k: bigint, w: number): Int8Array {
  const s = k.toString(2), n = s.length, out = new Int8Array(n + 1), half = 1 << (w - 1);
  const bit = (i: number) => i < n ? s.charCodeAt(n - 1 - i) - 48 : 0;
  for (let i = 0, carry = 0; i <= n; ) {
    if (bit(i) === carry) { i++; continue; }
    let word = carry;
    for (let j = 0; j < w; j++) word += bit(i + j) << j;
    if (word > half) { word -= half << 1; carry = 1; } else carry = 0;
    out[i] = word;
    i += w;
  }
  return out;
}
/** odd-multiple tables by curve for its generator (a wider one) and by point otherwise, so a key's
 *  point pays for its table once */
const pointTables = new WeakMap<object, Point[]>();
const G_WINDOW = 7, P_WINDOW = 5;
/** Σ kᵢ·Pᵢ in Jacobian form, the scalars' NAFs sharing one doubling chain (Shamir's trick) */
function mulAddJac(c: Curve, terms: [bigint, Point][]): Jac {
  const f = fieldOf(c), tables: Point[][] = [], digits: Int8Array[] = [];
  let len = 0;
  for (const [k, P] of terms) {
    const isG = P![0] === c.gx && P![1] === c.gy, key = isG ? c : P!;
    let table = pointTables.get(key);
    if (!table) pointTables.set(key, table = oddMultiples(f, P!, isG ? G_WINDOW : P_WINDOW));
    const d = wnaf(md(k, c.n), isG ? G_WINDOW : P_WINDOW);
    tables.push(table); digits.push(d);
    len = Math.max(len, d.length);
  }
  let R: Jac = INF;
  for (let i = len - 1; i >= 0; i--) {
    R = dbl(f, R);
    for (let j = 0; j < digits.length; j++) {
      const v = digits[j][i];
      if (!v) continue;
      const q = tables[j][(v < 0 ? -v : v) >> 1];
      if (q) R = madd(f, R, q[0], q[1], v < 0);
    }
  }
  return R;
}
const mulAdd = (c: Curve, terms: [bigint, Point][]): Point => toAffine(c, mulAddJac(c, terms));
export const mul = (c: Curve, k: bigint, P: Point): Point => P && k % c.n !== 0n ? mulAdd(c, [[k, P]]) : null;
export const onCurve = (c: Curve, [X, Y]: [bigint, bigint]) =>
  X >= 0n && Y >= 0n && X < c.p && Y < c.p && md(Y * Y - (X * X * X + c.a * X + c.b), c.p) === 0n;
export const G = (c: Curve): Point => [c.gx, c.gy];

/** a scalar uniformly in [1, n) */
export function randomScalar(n: bigint): bigint {
  const len = Math.ceil(bitLength(n) / 8) + 8;
  for (;;) {
    const k = bytesToBig(crypto.getRandomValues(new Uint8Array(len))) % n;
    if (k !== 0n) return k;
  }
}
/** a point in X9.62 form: 04‖X‖Y, or compressed 02/03‖X */
export function decodePoint(c: Curve, b: Uint8Array): [bigint, bigint] {
  if (b[0] === 4 && b.length === 1 + 2 * c.bytes) return [bytesToBig(b.subarray(1, 1 + c.bytes)), bytesToBig(b.subarray(1 + c.bytes))];
  if ((b[0] === 2 || b[0] === 3) && b.length === 1 + c.bytes) {
    const X = bytesToBig(b.subarray(1)), rhs = md(X * X * X + c.a * X + c.b, c.p);
    // every curve here has p ≡ 3 (mod 4) but P-224, whose compressed points BoringSSL also takes
    let Y = sqrtMod(rhs, c.p);
    if (Y === null) throw new DerError("point not on curve");
    if ((Y & 1n) !== BigInt(b[0] & 1)) Y = c.p - Y;
    return [X, Y];
  }
  throw new DerError("bad point encoding");
}
function sqrtMod(v: bigint, p: bigint): bigint | null {
  if (p % 4n === 3n) { const r = modPow(v, (p + 1n) / 4n, p); return r * r % p === v ? r : null; }
  // Tonelli-Shanks
  let q = p - 1n, s = 0n;
  while (!(q & 1n)) { q >>= 1n; s++; }
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n, p) !== p - 1n) z++;
  let m = s, cc = modPow(z, q, p), t = modPow(v, q, p), r = modPow(v, (q + 1n) / 2n, p);
  while (t !== 1n) {
    if (t === 0n) return 0n;
    let i = 0n, t2 = t;
    while (t2 !== 1n) { t2 = t2 * t2 % p; if (++i === m) return null; }
    const b = modPow(cc, 1n << (m - i - 1n), p);
    m = i; cc = b * b % p; t = t * cc % p; r = r * b % p;
  }
  return r;
}
/** an uncompressed point (SEC 1) */
export const encodePoint = (c: Curve, [X, Y]: [bigint, bigint]) => concat([Uint8Array.of(4), bigToBytes(X, c.bytes), bigToBytes(Y, c.bytes)]);

// ── ECDSA (SEC 1 §4.1): signatures are DER SEQUENCE { r, s }
const hashToInt = (c: Curve, digest: Uint8Array) => {
  const e = bytesToBig(digest), excess = digest.length * 8 - bitLength(c.n);
  return excess > 0 ? e >> BigInt(excess) : e;
};
export function ecdsaSign(c: Curve, d: bigint, digest: Uint8Array): Uint8Array {
  const e = hashToInt(c, digest);
  for (;;) {
    const k = randomScalar(c.n), R = mul(c, k, G(c))!;
    const r = R[0] % c.n;
    if (r === 0n) continue;
    const s = modInverse(k, c.n) * (e + r * d) % c.n;
    if (s === 0n) continue;
    return seq(integer(r), integer(s));
  }
}
export function ecdsaVerify(c: Curve, Q: [bigint, bigint], digest: Uint8Array, sig: Uint8Array): boolean {
  let r: bigint, s: bigint;
  try {
    const parts = children(parseOne(sig, SEQUENCE).body);
    if (parts.length !== 2) return false;
    r = uintOf(parts[0]); s = uintOf(parts[1]);
    // BoringSSL re-encodes and compares, so only the minimal encoding verifies
    if (!equal(seq(integer(r), integer(s)), sig)) return false;
  } catch { return false; }
  if (r <= 0n || s <= 0n || r >= c.n || s >= c.n) return false;
  const w = modInverse(s, c.n), e = hashToInt(c, digest);
  const R = mulAddJac(c, [[e * w % c.n, G(c)], [r * w % c.n, Q]]);
  if (R[2] === 0n) return false;
  // the affine x, X/Z² in [0, p), matches when it is r + j·n: compared without inverting Z
  const zz = R[2] * R[2] % c.p;
  for (let t = r; t < c.p; t += c.n) if (t * zz % c.p === R[0]) return true;
  return false;
}
export const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── X25519 (RFC 7748 §5)
const P25519 = (1n << 255n) - 19n, A24 = 121665n;
const le = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
const toLe = (v: bigint) => { const o = new Uint8Array(32); for (let i = 0; i < 32; i++, v >>= 8n) o[i] = Number(v & 255n); return o; };
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const k = scalar.slice(); k[0] &= 248; k[31] &= 127; k[31] |= 64;
  const kk = le(k), p = P25519, x1 = le(u) & ((1n << 255n) - 1n);
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
  for (let t = 254n; t >= 0n; t--) {
    const kt = (kk >> t) & 1n;
    if (swap ^ kt) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    swap = kt;
    const A = (x2 + z2) % p, AA = A * A % p, B = md(x2 - z2, p), BB = B * B % p, E = md(AA - BB, p);
    const C = (x3 + z3) % p, D = md(x3 - z3, p), DA = D * A % p, CB = C * B % p;
    x3 = (DA + CB) ** 2n % p; z3 = x1 * (md(DA - CB, p) ** 2n % p) % p;
    x2 = AA * BB % p; z2 = E * ((AA + A24 * E) % p) % p;
  }
  if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
  return toLe(x2 * modPow(z2, p - 2n, p) % p);
}
export const X25519_BASE = toLe(9n);

// ── RSA
export type Rsa = { n: bigint; e: bigint; d?: bigint; p?: bigint; q?: bigint; dp?: bigint; dq?: bigint; qinv?: bigint };
export const rsaBytes = (k: Rsa) => (bitLength(k.n) + 7) >> 3;
export const rsaPublic = (k: Rsa, m: bigint) => modPow(m, k.e, k.n);
export function rsaPrivate(k: Rsa, c: bigint): bigint {
  if (k.p && k.q && k.dp && k.dq && k.qinv) {
    const m1 = modPow(c % k.p, k.dp, k.p), m2 = modPow(c % k.q, k.dq, k.q);
    const h = md(k.qinv * (m1 - m2), k.p);
    return m2 + h * k.q;
  }
  if (k.d === undefined) throw new DerError("no private exponent");
  return modPow(c, k.d, k.n);
}
const DIGEST_INFO: Record<string, string> = {
  md5: "3020300c06082a864886f70d020505000410", sha1: "3021300906052b0e03021a05000414", sha224: "302d300d06096086480165030402040500041c",
  sha256: "3031300d060960864801650304020105000420", sha384: "3041300d060960864801650304020205000430", sha512: "3051300d060960864801650304020305000440",
};
/** EMSA-PKCS1-v1_5 of an already computed digest (the digest name picks the DigestInfo; null for none) */
export function pkcs1SignPad(k: number, digestName: string | null, digest: Uint8Array): Uint8Array | null {
  const t = digestName ? concat([hexBytes(DIGEST_INFO[digestName]), digest]) : digest;
  if (t.length + 11 > k) return null;
  const em = new Uint8Array(k).fill(0xff);
  em[0] = 0; em[1] = 1; em[k - t.length - 1] = 0; em.set(t, k - t.length);
  return em;
}
function mgf1(make: () => Hash, seed: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len), c = new Uint8Array(4);
  for (let i = 0, at = 0; at < len; i++) {
    new DataView(c.buffer).setUint32(0, i);
    const h = make(); h.update(seed); h.update(c);
    const d = h.digest();
    out.set(d.subarray(0, Math.min(d.length, len - at)), at); at += d.length;
  }
  return out;
}
const hashOf = (make: () => Hash, ...parts: Uint8Array[]) => { const h = make(); for (const p of parts) h.update(p); return h.digest(); };
/** EMSA-PSS-ENCODE (RFC 8017 §9.1.1) */
export function pssEncode(mHash: Uint8Array, emBits: number, hash: () => Hash, mgf: () => Hash, saltLen: number): Uint8Array | null {
  const emLen = (emBits + 7) >> 3, hLen = mHash.length;
  if (emLen < hLen + saltLen + 2) return null;
  const salt = crypto.getRandomValues(new Uint8Array(saltLen));
  const H = hashOf(hash, new Uint8Array(8), mHash, salt);
  const db = new Uint8Array(emLen - hLen - 1);
  db[db.length - saltLen - 1] = 1; db.set(salt, db.length - saltLen);
  const mask = mgf1(mgf, H, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  return concat([db, H, Uint8Array.of(0xbc)]);
}
/** EMSA-PSS-VERIFY; saltLen -1 is the digest length and -2 recovers it */
export function pssVerify(mHash: Uint8Array, em: Uint8Array, emBits: number, hash: () => Hash, mgf: () => Hash, saltLen: number): boolean {
  const emLen = (emBits + 7) >> 3, hLen = mHash.length;
  if (em.length > emLen) { if (em[0] !== 0) return false; em = em.subarray(1); }
  if (emLen < hLen + 2 || em[emLen - 1] !== 0xbc) return false;
  const db = em.slice(0, emLen - hLen - 1), H = em.subarray(emLen - hLen - 1, emLen - 1);
  if (db[0] & ~(0xff >> (8 * emLen - emBits)) & 0xff) return false;
  const mask = mgf1(mgf, H, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  let i = 0;
  while (i < db.length && db[i] === 0) i++;
  if (i === db.length || db[i] !== 1) return false;
  const salt = db.subarray(i + 1);
  if (saltLen === -1 ? salt.length !== hLen : saltLen >= 0 && salt.length !== saltLen) return false;
  return equal(hashOf(hash, new Uint8Array(8), mHash, salt), H);
}
/** RSAES-OAEP encoding (RFC 8017 §7.1.1) */
export function oaepEncode(k: number, m: Uint8Array, hash: () => Hash, mgf: () => Hash, label: Uint8Array): Uint8Array | null {
  const lHash = hashOf(hash, label), hLen = lHash.length;
  if (m.length > k - 2 * hLen - 2) return null;
  const db = new Uint8Array(k - hLen - 1);
  db.set(lHash); db[db.length - m.length - 1] = 1; db.set(m, db.length - m.length);
  const seed = crypto.getRandomValues(new Uint8Array(hLen));
  const dbMask = mgf1(mgf, seed, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= dbMask[i];
  const seedMask = mgf1(mgf, db, hLen);
  for (let i = 0; i < hLen; i++) seed[i] ^= seedMask[i];
  return concat([Uint8Array.of(0), seed, db]);
}
export function oaepDecode(k: number, em: Uint8Array, hash: () => Hash, mgf: () => Hash, label: Uint8Array): Uint8Array | null {
  const lHash = hashOf(hash, label), hLen = lHash.length;
  if (em.length !== k || k < 2 * hLen + 2 || em[0] !== 0) return null;
  const seed = em.slice(1, 1 + hLen), db = em.slice(1 + hLen);
  const seedMask = mgf1(mgf, db, hLen);
  for (let i = 0; i < hLen; i++) seed[i] ^= seedMask[i];
  const dbMask = mgf1(mgf, seed, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= dbMask[i];
  if (!equal(db.subarray(0, hLen), lHash)) return null;
  let i = hLen;
  while (i < db.length && db[i] === 0) i++;
  return i < db.length && db[i] === 1 ? db.slice(i + 1) : null;
}
/** RSAES-PKCS1-v1_5 (type 2) */
export function pkcs1EncryptPad(k: number, m: Uint8Array): Uint8Array | null {
  if (m.length > k - 11) return null;
  const em = new Uint8Array(k);
  em[1] = 2;
  const ps = em.subarray(2, k - m.length - 1);
  crypto.getRandomValues(ps);
  for (let i = 0; i < ps.length; i++) while (ps[i] === 0) ps[i] = crypto.getRandomValues(new Uint8Array(1))[0];
  em.set(m, k - m.length);
  return em;
}
export function pkcs1Unpad(em: Uint8Array, type: 1 | 2): Uint8Array | null {
  if (em[0] !== 0 || em[1] !== type) return null;
  let i = 2;
  if (type === 1) { while (i < em.length && em[i] === 0xff) i++; if (i < 10) return null; }
  else { while (i < em.length && em[i] !== 0) i++; if (i < 10) return null; }
  return i < em.length && em[i] === 0 ? em.slice(i + 1) : null;
}
export const digestNamed = (name: string): (() => Hash) => DIGESTS[name];

// ── keys and their encodings
export type EcKey = { curve: Curve; pub: [bigint, bigint]; priv?: bigint };
export type PKey =
  | { type: typeof EVP_PKEY_RSA; rsa: Rsa }
  | { type: typeof EVP_PKEY_EC; ec: EcKey }
  | { type: typeof EVP_PKEY_X25519; pub: Uint8Array; priv?: Uint8Array };

const algId = (o: string, params?: Uint8Array) => seq(oid(o), ...(params ? [params] : []));
/** the curve an AlgorithmIdentifier's parameters name: a named curve, or explicit parameters that match one */
export function curveOfParams(t: Tlv0): Curve {
  if (t.tag === OID) { const c = curveByOid(oidToString(t.body)); if (c) return c; throw new DerError("unknown curve"); }
  if (t.tag === SEQUENCE) {
    const [, field, curve, base, order] = children(t.body);
    const p = uintOf(children(expect(field, SEQUENCE).body)[1]), [a, b] = children(expect(curve, SEQUENCE).body).map((v) => bytesToBig(v.body));
    const n = uintOf(order), c = CURVES.find((k) => k.p === p && k.a === a && k.b === b && k.n === n);
    if (c && equal(expect(base, OCTET_STRING).body, encodePoint(c, [c.gx, c.gy]))) return c;
  }
  throw new DerError("unsupported curve parameters");
}
type Tlv0 = { tag: number; body: Uint8Array };

export function parsePublicKey(spki: Uint8Array): PKey {
  const [alg, key] = children(parseOne(spki, SEQUENCE).body);
  const [id, params] = children(expect(alg, SEQUENCE).body);
  const o = oidToString(expect(id, OID).body), raw = expect(key, BIT_STRING).body;
  if (raw[0] !== 0) throw new DerError("unused bits");
  const body = raw.subarray(1);
  if (o === OID_RSA) {
    const [n, e, ...rest] = children(parseOne(body, SEQUENCE).body);
    if (rest.length) throw new DerError("RSAPublicKey");
    return { type: EVP_PKEY_RSA, rsa: { n: uintOf(n), e: uintOf(e) } };
  }
  if (o === OID_EC) {
    const curve = curveOfParams(params ?? { tag: 0, body: new Uint8Array(0) });
    const pub = decodePoint(curve, body);
    if (!onCurve(curve, pub)) throw new DerError("point not on curve");
    return { type: EVP_PKEY_EC, ec: { curve, pub } };
  }
  if (o === OID_X25519 && body.length === 32 && !params) return { type: EVP_PKEY_X25519, pub: body.slice() };
  throw new DerError("unsupported algorithm " + o);
}
export function parsePrivateKey(pkcs8: Uint8Array): PKey {
  const [version, alg, key] = children(parseOne(pkcs8, SEQUENCE).body);
  if (uintOf(version) > 1n) throw new DerError("version");
  const [id, params] = children(expect(alg, SEQUENCE).body);
  const o = oidToString(expect(id, OID).body), body = expect(key, OCTET_STRING).body;
  if (o === OID_RSA) {
    const [v, ...f] = children(parseOne(body, SEQUENCE).body).map(uintOf);
    if (v !== 0n || f.length !== 8) throw new DerError("RSAPrivateKey");
    const [n, e, d, p, q, dp, dq, qinv] = f;
    return { type: EVP_PKEY_RSA, rsa: { n, e, d, p, q, dp, dq, qinv } };
  }
  if (o === OID_EC) {
    const parts = children(parseOne(body, SEQUENCE).body);
    if (uintOf(parts[0]) !== 1n) throw new DerError("ECPrivateKey");
    const s = expect(parts[1], OCTET_STRING).body;
    let curve: Curve | null = params ? curveOfParams(params) : null, pub: [bigint, bigint] | null = null;
    for (const t of parts.slice(2)) {
      if (t.tag === 0xa0) { const c = curveOfParams(readTlv(t.body)); if (curve && c !== curve) throw new DerError("curve mismatch"); curve = c; }
      else if (t.tag === 0xa1 && curve) { const b = expect(readTlv(t.body), BIT_STRING).body; pub = decodePoint(curve, b.subarray(1)); }
    }
    if (!curve) throw new DerError("no curve");
    const d = bytesToBig(s);
    if (d <= 0n || d >= curve.n) throw new DerError("scalar");
    pub ??= mul(curve, d, G(curve)) as [bigint, bigint];
    return { type: EVP_PKEY_EC, ec: { curve, pub, priv: d } };
  }
  if (o === OID_X25519 && !params) {
    const raw = expect(parseOne(body), OCTET_STRING).body;
    if (raw.length !== 32) throw new DerError("X25519 key");
    return { type: EVP_PKEY_X25519, priv: raw.slice(), pub: x25519(raw, X25519_BASE) };
  }
  throw new DerError("unsupported algorithm " + o);
}
export function marshalPublicKey(k: PKey): Uint8Array {
  if (k.type === EVP_PKEY_RSA) return seq(algId(OID_RSA, derNull()), bits(seq(integer(k.rsa.n), integer(k.rsa.e))));
  if (k.type === EVP_PKEY_EC) return seq(algId(OID_EC, oid(k.ec.curve.oid)), bits(encodePoint(k.ec.curve, k.ec.pub)));
  return seq(algId(OID_X25519), bits(k.pub));
}
/** null when the key has no complete private half to encode */
export function marshalPrivateKey(k: PKey): Uint8Array | null {
  if (k.type === EVP_PKEY_RSA) {
    const r = k.rsa, f = [r.n, r.e, r.d, r.p, r.q, r.dp, r.dq, r.qinv];
    if (f.some((v) => v === undefined)) return null;
    return seq(integer(0n), algId(OID_RSA, derNull()), octets(seq(integer(0n), ...f.map((v) => integer(v!)))));
  }
  if (k.type === EVP_PKEY_EC) {
    const e = k.ec;
    if (e.priv === undefined) return null;
    const inner = seq(integer(1n), octets(bigToBytes(e.priv, e.curve.bytes)), tlv(0xa1, bits(encodePoint(e.curve, e.pub))));
    return seq(integer(0n), algId(OID_EC, oid(e.curve.oid)), octets(inner));
  }
  return k.priv ? seq(integer(0n), algId(OID_X25519), octets(octets(k.priv))) : null;
}
