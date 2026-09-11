// java.security — MessageDigest (sync MD5/SHA-1/SHA-256: fingerprint checks at boot, cache keys), SecureRandom, AccessController.
import { rt, JObj } from "../runtime";
import { vcall, defineException } from "./jlang";
import { jarray, concat, u8 } from "../abi";
import { JRandom, randomSeed } from "./jrandom";

const SHA256_K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const SHA256_H0 = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
/** the message padded to whole 64-byte blocks, its bit length in the last eight bytes */
function mdPad(data: Uint8Array, le: boolean): DataView {
  const len = data.length, padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - (le ? 8 : 4), (len * 8) >>> 0, le);
  dv.setUint32(padded.length - (le ? 4 : 8), Math.floor(len / 0x20000000), le);
  return dv;
}
function sha256(data: Uint8Array): Uint8Array {
  const H = new Uint32Array(SHA256_H0);
  const dv = mdPad(data, false);
  const w = new Uint32Array(64);
  const rot = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

function sha1(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]);
  const dv = mdPad(data, false);
  const w = new Uint32Array(80);
  const rot = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rot(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      const t = (rot(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rot(b, 30); b = a; a = t;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

const MD5_K = new Uint32Array([0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391]);
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
// RFC 1321; little-endian words, unlike the SHAs above.
function md5(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const dv = mdPad(data, true);
  const w = new Uint32Array(16);
  const rot = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, true);
    let [a, b, c, d] = H;
    for (let i = 0; i < 64; i++) {
      const f = i < 16 ? (b & c) | (~b & d) : i < 32 ? (d & b) | (~d & c) : i < 48 ? b ^ c ^ d : c ^ (b | ~d);
      const g = i < 16 ? i : i < 32 ? (5 * i + 1) & 15 : i < 48 ? (3 * i + 5) & 15 : (7 * i) & 15;
      const t = (b + rot((a + f + MD5_K[i] + w[g]) | 0, MD5_S[i])) | 0;
      a = d; d = c; c = b; b = t;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) odv.setUint32(i * 4, H[i], true);
  return out;
}

defineException("java/security/GeneralSecurityException", "java/lang/Exception");
defineException("java/security/NoSuchAlgorithmException", "java/security/GeneralSecurityException");
defineException("java/security/NoSuchProviderException", "java/security/GeneralSecurityException");
defineException("java/security/KeyException", "java/security/GeneralSecurityException");
defineException("java/security/InvalidKeyException", "java/security/KeyException");
// java.security.cert's exceptions are CATCH types before they are anything else: an app that
// wraps a certificate operation in `catch (CertificateException)` cannot match a class that
// does not exist, so the failure it meant to handle escapes instead.
defineException("java/security/cert/CertificateException", "java/security/GeneralSecurityException");
defineException("java/security/cert/CertificateEncodingException", "java/security/cert/CertificateException");
defineException("java/security/cert/CertificateParsingException", "java/security/cert/CertificateException");
defineException("java/security/cert/CertificateExpiredException", "java/security/cert/CertificateException");
defineException("java/security/cert/CertificateNotYetValidException", "java/security/cert/CertificateException");
defineException("java/security/cert/CRLException", "java/security/GeneralSecurityException");
defineException("java/security/cert/CertPathValidatorException", "java/security/GeneralSecurityException");
defineException("java/security/cert/CertPathBuilderException", "java/security/GeneralSecurityException");
rt.markers("java/security/cert/CertPath");
rt.register({
  name: "java/security/cert/CertPathValidator", ctor: class extends JObj {},
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/security/cert/CertPathValidator;": () =>
      rt.make("java/security/cert/CertPathValidator"),
    "validate(Ljava/security/cert/CertPath;Ljava/security/cert/CertPathParameters;)Ljava/security/cert/CertPathValidatorResult;": () => {
      throw rt.mkThrowable("java/security/cert/CertPathValidatorException", "no trust anchors");
    },
  },
});

type Digest = (data: Uint8Array) => Uint8Array;
// Standard names plus the aliases Android's providers accept (case-insensitive); anything else is
// honestly NoSuchAlgorithmException, which the SDKs that ask for e.g. MD5 catch and fall back from.
const DIGESTS = new Map<string, [Digest, number]>([
  ["MD5", [md5, 16]], ["SHA-1", [sha1, 20]], ["SHA1", [sha1, 20]], ["SHA", [sha1, 20]], ["SHA-256", [sha256, 32]], ["SHA256", [sha256, 32]],
]);
class JMessageDigest extends JObj {
  algo = "";
  fn: Digest = sha256;
  len = 32;
  parts: Uint8Array[] = [];
}
function mdUpdate(md: JMessageDigest, b: Int8Array, off = 0, len = b.length) {
  md.parts.push(u8(b, off, len).slice());
}
function mdDigest(md: JMessageDigest): Int8Array {
  const all = concat(md.parts);
  md.parts = [];
  const a = md.fn(all);
  return new Int8Array(a.buffer, 0, a.length);
}
rt.register({
  name: "java/security/MessageDigest", ctor: JMessageDigest,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/security/MessageDigest;": (algo: string) => {
      const d = DIGESTS.get(algo.toUpperCase());
      if (!d) throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algo + " MessageDigest not available");
      const m = new JMessageDigest(); m.algo = algo; m.fn = d[0]; m.len = d[1]; return m;
    },
    "static isEqual([B[B)Z": (a: Int8Array | null, b: Int8Array | null) =>
      a === b || (a != null && b != null && a.length === b.length && a.every((v, i) => v === b[i])) ? 1 : 0,
    "update(B)V": function (this: JMessageDigest, b: number) { this.parts.push(new Uint8Array([b & 0xff])); },
    "update([B)V": function (this: JMessageDigest, b: Int8Array) { mdUpdate(this, b); },
    "update([BII)V": function (this: JMessageDigest, b: Int8Array, off: number, len: number) { mdUpdate(this, b, off, len); },
    "digest()[B": function (this: JMessageDigest) { return mdDigest(this); },
    "digest([B)[B": function (this: JMessageDigest, b: Int8Array) { mdUpdate(this, b); return mdDigest(this); },
    "reset()V": function (this: JMessageDigest) { this.parts = []; },
    "getAlgorithm()Ljava/lang/String;": function (this: JMessageDigest) { return this.algo; },
    "getDigestLength()I": function (this: JMessageDigest) { return this.len; },
  },
});

const doPrivileged = async (a: unknown) => vcall(a, "run", "()Ljava/lang/Object;");
rt.markers("java/security/PrivilegedAction", "java/security/PrivilegedExceptionAction");
rt.register({
  name: "java/security/AccessController", ctor: class extends JObj {},
  methods: {
    "static doPrivileged(Ljava/security/PrivilegedAction;)Ljava/lang/Object;": doPrivileged,
    "static doPrivileged(Ljava/security/PrivilegedExceptionAction;)Ljava/lang/Object;": doPrivileged,
  },
});

// java.security.Security's provider list. The crypto surface is the platform's own (jcrypto),
// reached through Cipher.getInstance with no provider, so a Provider here carries no service
// of its own. The list is still the platform's, in the platform's order: an empty one is not a
// state any device is in, and callers index it (`getProviders()[0].getName()`) unguarded.
class JProvider extends JObj { pname = ""; }
rt.register({
  name: "java/security/Provider", ctor: JProvider,
  methods: {
    "getName()Ljava/lang/String;": function (this: JProvider) { return this.pname; },
    "toString()Ljava/lang/String;": function (this: JProvider) { return this.pname; },
  },
});
const providers: JProvider[] = ["AndroidNSSP", "AndroidOpenSSL", "CertPathProvider",
  "AndroidKeyStoreBCWorkaround", "BC", "HarmonyJSSE", "AndroidKeyStore"].map((pname) => Object.assign(new JProvider(), { pname }));
rt.register({
  name: "java/security/Security", ctor: class extends JObj {},
  methods: {
    "static getProvider(Ljava/lang/String;)Ljava/security/Provider;": (n: string) => providers.find((p) => p.pname === n) ?? null,
    "static getProviders()[Ljava/security/Provider;": () => jarray(providers.slice(), "Ljava/security/Provider;"),
    "static addProvider(Ljava/security/Provider;)I": (p: JProvider) => { providers.push(p); return providers.length; },
    "static insertProviderAt(Ljava/security/Provider;I)I": (p: JProvider, i: number) => { providers.splice(i - 1, 0, p); return i; },
    "static removeProvider(Ljava/lang/String;)V": (n: string) => { const i = providers.findIndex((p) => p.pname === n); if (i >= 0) providers.splice(i, 1); },
    "static getProperty(Ljava/lang/String;)Ljava/lang/String;": () => null,
  },
});

// java.util.Random's generator seeded from the CSPRNG; nextBytes itself stays crypto-backed.
class JSecureRandom extends JRandom {}
rt.register({
  name: "java/security/SecureRandom", ctor: JSecureRandom, sup: "java/util/Random",
  methods: {
    "<init>()V": function (this: JSecureRandom) { this.setSeed(randomSeed()); },
    "nextBytes([B)V": (b: Int8Array) => crypto.getRandomValues(u8(b)),
  },
});

for (const n of ["java/security/spec/ECParameterSpec", "java/security/spec/ECGenParameterSpec",
  "java/security/spec/AlgorithmParameterSpec", "java/security/AlgorithmParameters"]) {
  rt.register({ name: n, ctor: class extends JObj {}, methods: { "<init>(Ljava/lang/String;)V": () => {}, "<init>()V": () => {} } });
}

// java.security.spec's value classes: plain data an app's own key math hands around
export const valueClass = (name: string, fields: string[], ctorDesc: string, getters: [string, string][], ifaces: string[] = [], sup?: string) => rt.register({
  name, ctor: class extends JObj {}, ifaces, sup,
  methods: {
    [`<init>${ctorDesc}`]: function (this: Record<string, unknown>, ...a: unknown[]) { fields.forEach((f, i) => { this[f] = a[i]; }); },
    ...Object.fromEntries(getters.map(([m, f]) => [m, function (this: Record<string, unknown>) { return this[f] ?? null; }])),
  },
});
rt.markers("java/security/spec/ECField");
const SPEC = ["java/security/spec/AlgorithmParameterSpec", "java/security/spec/KeySpec"];
valueClass("java/security/spec/ECFieldFp", ["p"], "(Ljava/math/BigInteger;)V", [["getP()Ljava/math/BigInteger;", "p"], ["getFieldSize()I", "size"]], ["java/security/spec/ECField"]);
valueClass("java/security/spec/ECPoint", ["x", "y"], "(Ljava/math/BigInteger;Ljava/math/BigInteger;)V", [["getAffineX()Ljava/math/BigInteger;", "x"], ["getAffineY()Ljava/math/BigInteger;", "y"]]);
valueClass("java/security/spec/EllipticCurve", ["field", "a", "b"], "(Ljava/security/spec/ECField;Ljava/math/BigInteger;Ljava/math/BigInteger;)V",
  [["getField()Ljava/security/spec/ECField;", "field"], ["getA()Ljava/math/BigInteger;", "a"], ["getB()Ljava/math/BigInteger;", "b"]]);
valueClass("java/security/spec/ECParameterSpec", ["curve", "g", "n", "h"], "(Ljava/security/spec/EllipticCurve;Ljava/security/spec/ECPoint;Ljava/math/BigInteger;I)V",
  [["getCurve()Ljava/security/spec/EllipticCurve;", "curve"], ["getGenerator()Ljava/security/spec/ECPoint;", "g"], ["getOrder()Ljava/math/BigInteger;", "n"], ["getCofactor()I", "h"]], SPEC);
valueClass("java/security/spec/ECPublicKeySpec", ["w", "params"], "(Ljava/security/spec/ECPoint;Ljava/security/spec/ECParameterSpec;)V", [["getW()Ljava/security/spec/ECPoint;", "w"], ["getParams()Ljava/security/spec/ECParameterSpec;", "params"]], SPEC);
valueClass("java/security/spec/ECPrivateKeySpec", ["s", "params"], "(Ljava/math/BigInteger;Ljava/security/spec/ECParameterSpec;)V", [["getS()Ljava/math/BigInteger;", "s"], ["getParams()Ljava/security/spec/ECParameterSpec;", "params"]], SPEC);
valueClass("java/security/spec/ECGenParameterSpec", ["name"], "(Ljava/lang/String;)V", [["getName()Ljava/lang/String;", "name"]], SPEC);
