// java.security — MessageDigest (sync MD5/SHA-1/SHA-256: fingerprint checks at boot, cache keys), SecureRandom, AccessController.
import { rt, JObj, driven, type Gen } from "../runtime";
import { vcall, defineException, stringHash } from "./jlang";
import { jarray, concat, u8 } from "../abi";
import { JRandom, randomSeed } from "./jrandom";
import { JProps } from "./jutil";
import { JFilterInputStream, JFilterOutputStream } from "./jio";
import { md5, sha1, sha256 } from "./digest";

class JPermission extends JObj { name = ""; }
rt.register({ name: "java/security/Permission", ctor: JPermission, fields: { name: "name" }, methods: {
  "<init>(Ljava/lang/String;)V": function (this: JPermission, name: string) { this.name = name; },
  "getName()Ljava/lang/String;": function (this: JPermission) { return this.name; },
  "checkGuard(Ljava/lang/Object;)V": () => {},
} });

class JBasicPermission extends JPermission {}
function initBasicPermission(this: JBasicPermission, name: string) {
  if (name == null) throw rt.mkThrowable("java/lang/NullPointerException", "name");
  if (!name) throw rt.mkThrowable("java/lang/IllegalArgumentException", "name");
  this.name = name;
}
rt.register({ name: "java/security/BasicPermission", ctor: JBasicPermission, sup: "java/security/Permission", methods: {
  "<init>(Ljava/lang/String;)V": initBasicPermission,
  "<init>(Ljava/lang/String;Ljava/lang/String;)V": initBasicPermission,
  "getActions()Ljava/lang/String;": () => "",
  "implies(Ljava/security/Permission;)Z": function (this: JBasicPermission, other: JBasicPermission | null) {
    if (!other || this.constructor !== other.constructor) return 0;
    if (this.name === "*") return 1;
    return +(this.name === other.name || (this.name.endsWith(".*") && other.name.startsWith(this.name.slice(0, -1))));
  },
  "equals(Ljava/lang/Object;)Z": function (this: JBasicPermission, other: JBasicPermission | null) {
    return +(!!other && this.constructor === other.constructor && this.name === other.name);
  },
  "hashCode()I": function (this: JBasicPermission) { return stringHash(this.name); },
} });

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

type Digest = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
const webDigest = (algorithm: string): Digest => async data => new Uint8Array(await crypto.subtle.digest(algorithm, data.slice().buffer));
/** Small inputs hash synchronously in JS; large ones (whole APKs) go to the native digest. */
const LARGE_DIGEST = 1 << 20;
const sized = (small: Digest, algorithm: string): Digest => {
  const native = webDigest(algorithm);
  return data => data.length >= LARGE_DIGEST ? native(data) : small(data);
};
const sha1Sized = sized(sha1, "SHA-1"), sha256Sized = sized(sha256, "SHA-256");
// Standard names plus the aliases Android's providers accept (case-insensitive); anything else is
// honestly NoSuchAlgorithmException, which the SDKs that ask for e.g. MD5 catch and fall back from.
const DIGESTS = new Map<string, [Digest, number]>([
  ["SHA-384", [webDigest("SHA-384"), 48]], ["SHA384", [webDigest("SHA-384"), 48]],
  ["SHA-512", [webDigest("SHA-512"), 64]], ["SHA512", [webDigest("SHA-512"), 64]],
  ["MD5", [md5, 16]], ["SHA-1", [sha1Sized, 20]], ["SHA1", [sha1Sized, 20]], ["SHA", [sha1Sized, 20]], ["SHA-256", [sha256Sized, 32]], ["SHA256", [sha256Sized, 32]],
]);
export function digestBytes(algorithm: string, data: Uint8Array): Uint8Array | Promise<Uint8Array> | null {
  return DIGESTS.get(algorithm.toUpperCase())?.[0](data) ?? null;
}
class JMessageDigest extends JObj {
  algo = "";
  fn: Digest = sha256;
  len = 32;
  parts: Uint8Array[] = [];
}
function mdUpdate(md: JMessageDigest, b: Int8Array, off = 0, len = b.length) {
  md.parts.push(u8(b, off, len).slice());
}
function mdDigest(md: JMessageDigest): Int8Array | Promise<Int8Array> {
  const all = concat(md.parts);
  md.parts = [];
  const a = md.fn(all);
  const result = (bytes: Uint8Array) => new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  return a instanceof Promise ? a.then(result) : result(a);
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
    "update(Ljava/nio/ByteBuffer;)V": driven(function* (this: JMessageDigest, input: unknown): Gen {
      if (input === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const remaining: number = yield vcall(input, "remaining", "()I");
      const bytes = new Int8Array(remaining);
      yield vcall(input, "get", "([B)Ljava/nio/ByteBuffer;", bytes);
      mdUpdate(this, bytes);
    }),
    "digest()[B": function (this: JMessageDigest) { return mdDigest(this); },
    "digest([B)[B": function (this: JMessageDigest, b: Int8Array) { mdUpdate(this, b); return mdDigest(this); },
    "reset()V": function (this: JMessageDigest) { this.parts = []; },
    "getAlgorithm()Ljava/lang/String;": function (this: JMessageDigest) { return this.algo; },
    "getDigestLength()I": function (this: JMessageDigest) { return this.len; },
  },
});

class JDigestOutputStream extends JFilterOutputStream {
  digest: JMessageDigest | null = null;
  enabled = true;
}
rt.register({
  name: "java/security/DigestOutputStream", ctor: JDigestOutputStream, sup: "java/io/FilterOutputStream",
  fields: { out: "out", digest: "digest" },
  methods: {
    "<init>(Ljava/io/OutputStream;Ljava/security/MessageDigest;)V": function (this: JDigestOutputStream, out: unknown, digest: JMessageDigest) {
      this.out = out; this.digest = digest;
    },
    "getMessageDigest()Ljava/security/MessageDigest;": function (this: JDigestOutputStream) { return this.digest; },
    "setMessageDigest(Ljava/security/MessageDigest;)V": function (this: JDigestOutputStream, digest: JMessageDigest) { this.digest = digest; },
    "on(Z)V": function (this: JDigestOutputStream, enabled: number) { this.enabled = !!enabled; },
    "write(I)V": driven(function* (this: JDigestOutputStream, b: number): Gen {
      yield vcall(this.out, "write", "(I)V", b);
      if (this.enabled) yield vcall(this.digest, "update", "(B)V", b);
    }),
    "write([BII)V": driven(function* (this: JDigestOutputStream, bytes: Int8Array, off: number, len: number): Gen {
      if (bytes == null || off + len > bytes.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "wrong parameters for write");
      if (off < 0 || len < 0) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "wrong index for write");
      yield vcall(this.out, "write", "([BII)V", bytes, off, len);
      if (this.enabled) yield vcall(this.digest, "update", "([BII)V", bytes, off, len);
    }),
  },
});

class JDigestInputStream extends JFilterInputStream {
  digest: JMessageDigest | null = null;
  enabled = true;
}
rt.register({
  name: "java/security/DigestInputStream", ctor: JDigestInputStream, sup: "java/io/FilterInputStream",
  fields: { digest: "digest" },
  methods: {
    "<init>(Ljava/io/InputStream;Ljava/security/MessageDigest;)V": function (this: JDigestInputStream, input: unknown, digest: JMessageDigest) {
      this.in_ = input; this.digest = digest;
    },
    "getMessageDigest()Ljava/security/MessageDigest;": function (this: JDigestInputStream) { return this.digest; },
    "setMessageDigest(Ljava/security/MessageDigest;)V": function (this: JDigestInputStream, digest: JMessageDigest) { this.digest = digest; },
    "on(Z)V": function (this: JDigestInputStream, enabled: number) { this.enabled = !!enabled; },
    "read()I": driven(function* (this: JDigestInputStream): Gen {
      const value: number = yield vcall(this.in_, "read", "()I");
      if (value >= 0 && this.enabled) yield vcall(this.digest, "update", "(B)V", value);
      return value;
    }),
    "read([BII)I": driven(function* (this: JDigestInputStream, bytes: Int8Array, off: number, len: number): Gen {
      const count: number = yield vcall(this.in_, "read", "([BII)I", bytes, off, len);
      if (count > 0 && this.enabled) yield vcall(this.digest, "update", "([BII)V", bytes, off, count);
      return count;
    }),
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
class JProvider extends JProps { pname = ""; version = 0; info = ""; }
rt.register({
  name: "java/security/Provider", ctor: JProvider, sup: "java/util/Properties",
  methods: {
    "<init>(Ljava/lang/String;DLjava/lang/String;)V": function (this: JProvider, name: string, version: number, info: string) { this.pname = name; this.version = version; this.info = info; },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JProvider, name: string, version: string, info: string) { this.pname = name; this.version = Number(version); this.info = info; },
    "getName()Ljava/lang/String;": function (this: JProvider) { return this.pname; },
    "getVersion()D": function (this: JProvider) { return this.version; },
    "getInfo()Ljava/lang/String;": function (this: JProvider) { return this.info; },
    "toString()Ljava/lang/String;": function (this: JProvider) { return this.pname; },
  },
});
const providers: JProvider[] = ["AndroidNSSP", "AndroidOpenSSL", "CertPathProvider",
  "AndroidKeyStoreBCWorkaround", "BC", "HarmonyJSSE", "AndroidKeyStore"].map((pname) => Object.assign(new JProvider(), { pname }));
const securityProperties = new Map<string, string>();
rt.register({
  name: "java/security/Security", ctor: class extends JObj {},
  methods: {
    "static getProvider(Ljava/lang/String;)Ljava/security/Provider;": (n: string) => providers.find((p) => p.pname === n) ?? null,
    "static getProviders()[Ljava/security/Provider;": () => jarray(providers.slice(), "Ljava/security/Provider;"),
    "static addProvider(Ljava/security/Provider;)I": (p: JProvider) => { providers.push(p); return providers.length; },
    "static insertProviderAt(Ljava/security/Provider;I)I": (p: JProvider, i: number) => { providers.splice(i - 1, 0, p); return i; },
    "static removeProvider(Ljava/lang/String;)V": (n: string) => { const i = providers.findIndex((p) => p.pname === n); if (i >= 0) providers.splice(i, 1); },
    "static getProperty(Ljava/lang/String;)Ljava/lang/String;": (key: string) => securityProperties.get(key) ?? null,
    "static setProperty(Ljava/lang/String;Ljava/lang/String;)V": (key: string, value: string) => {
      if (key == null || value == null) rt.npe();
      securityProperties.set(key, value);
    },
  },
});

// java.util.Random's generator seeded from the CSPRNG; nextBytes itself stays crypto-backed.
class JSecureRandom extends JRandom { algo = "SHA1PRNG"; provider: JProvider | null = null; }
function seedSecureRandom(this: JSecureRandom) { this.setSeed(randomSeed()); }
const secureRandom = (algo: string) => { rt.link("java/security/SecureRandom"); const r = new JSecureRandom(); r.algo = algo; r.setSeed(randomSeed()); return r; };
rt.register({
  name: "java/security/SecureRandom", ctor: JSecureRandom, sup: "java/util/Random",
  methods: {
    "<init>()V": seedSecureRandom,
    "<init>([B)V": seedSecureRandom,
    // every algorithm name draws from the same CSPRNG; the name is kept for getAlgorithm
    "static getInstance(Ljava/lang/String;)Ljava/security/SecureRandom;": (algo: string) => {
      if (algo === null) throw rt.mkThrowable("java/lang/NullPointerException", "algorithm == null");
      return secureRandom(algo);
    },
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljava/security/SecureRandom;": secureRandom,
    "static getInstance(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/SecureRandom;": (algo: string, provider: JProvider | null) => {
      if (algo === null) throw rt.mkThrowable("java/lang/NullPointerException", "algorithm == null");
      if (!provider) throw rt.mkThrowable("java/lang/IllegalArgumentException", "missing provider");
      const random = secureRandom(algo); random.provider = provider; return random;
    },
    "getProvider()Ljava/security/Provider;": function (this: JSecureRandom) { return this.provider ?? providers[0]; },
    "static getInstanceStrong()Ljava/security/SecureRandom;": () => secureRandom("SHA1PRNG"),
    "getAlgorithm()Ljava/lang/String;": function (this: JSecureRandom) { return this.algo; },
    "nextBytes([B)V": (b: Int8Array) => crypto.getRandomValues(u8(b)),
    "generateSeed(I)[B": (n: number) => { const b = new Int8Array(n); crypto.getRandomValues(u8(b)); return b; },
  },
});

for (const n of ["java/security/spec/AlgorithmParameterSpec", "java/security/AlgorithmParameters"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
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
