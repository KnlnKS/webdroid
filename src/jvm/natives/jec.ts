// java.security's elliptic-curve keys on the NIST prime curves: KeyFactory, ECDH key
// agreement and the EC half of KeyPairGenerator. Keys are plain affine coordinates; the curve
// arithmetic is BigInt, which is what lets a key built from a spec (no WebCrypto import of a
// bare scalar) still agree on a secret, and lets a point be checked before it is trusted.
import { rt, JObj } from "../runtime";
import { JBigInteger, mkBI, modInverse } from "./jmath";
import { valueClass } from "./jsec";
import { JRsaPublicKey, JRsaPrivateKey, array } from "./jrsa";

export type Curve = { names: string[]; web: string; oid: number[]; bytes: number; p: bigint; a: bigint; b: bigint; gx: bigint; gy: bigint; n: bigint };
const h = (s: string) => BigInt("0x" + s);
const CURVES: Curve[] = [
  { names: ["secp256r1", "prime256v1", "P-256", "NIST P-256", "256"], web: "P-256", oid: [1, 2, 840, 10045, 3, 1, 7], bytes: 32,
    p: h("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff"), a: h("ffffffff00000001000000000000000000000000fffffffffffffffffffffffc"),
    b: h("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b"),
    gx: h("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"), gy: h("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
    n: h("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551") },
  { names: ["secp384r1", "P-384", "NIST P-384", "384"], web: "P-384", oid: [1, 3, 132, 0, 34], bytes: 48,
    p: h("fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff"),
    a: h("fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000fffffffc"),
    b: h("b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef"),
    gx: h("aa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7"),
    gy: h("3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f"),
    n: h("ffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973") },
  { names: ["secp521r1", "P-521", "NIST P-521", "521"], web: "P-521", oid: [1, 3, 132, 0, 35], bytes: 66,
    p: (1n << 521n) - 1n, a: (1n << 521n) - 4n,
    b: h("51953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00"),
    gx: h("c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66"),
    gy: h("11839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650"),
    n: h("1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409") },
];
const curveNamed = (name: string) => CURVES.find((c) => c.names.some((n) => n.toLowerCase() === String(name).toLowerCase()));
const curveOf = (p: bigint, n: bigint) => CURVES.find((c) => c.p === p && c.n === n);
const badSpec = (msg: string) => rt.mkThrowable("java/security/spec/InvalidKeySpecException", msg);

// ── affine arithmetic
const mod = (x: bigint, p: bigint) => ((x % p) + p) % p;
type Pt = [bigint, bigint] | null;
function add(c: Curve, P: Pt, Q: Pt): Pt {
  if (!P) return Q;
  if (!Q) return P;
  const [x1, y1] = P, [x2, y2] = Q;
  let l: bigint;
  if (x1 === x2) {
    if (mod(y1 + y2, c.p) === 0n) return null;
    l = mod((3n * x1 * x1 + c.a) * modInverse(2n * y1, c.p), c.p);
  } else l = mod((y2 - y1) * modInverse(x2 - x1, c.p), c.p);
  const x3 = mod(l * l - x1 - x2, c.p);
  return [x3, mod(l * (x1 - x3) - y1, c.p)];
}
function mul(c: Curve, k: bigint, P: Pt): Pt {
  let R: Pt = null;
  for (let Q = P; k > 0n; k >>= 1n, Q = add(c, Q, Q)) if (k & 1n) R = add(c, R, Q);
  return R;
}
const onCurve = (c: Curve, x: bigint, y: bigint) => x >= 0n && y >= 0n && x < c.p && y < c.p && mod(y * y - (x * x * x + c.a * x + c.b), c.p) === 0n;

// ── DER, just the shapes SubjectPublicKeyInfo and PKCS#8 use for a named curve
const ID_EC = [1, 2, 840, 10045, 2, 1], ID_RSA = [1, 2, 840, 113549, 1, 1, 1];
const oidBytes = (o: number[]) => {
  const out = [40 * o[0] + o[1]];
  for (const v of o.slice(2)) { const b = []; let x = v; do { b.unshift(x & 0x7f); x >>= 7; } while (x); for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80; out.push(...b); }
  return out;
};
const tlv = (tag: number, body: number[]) => {
  const n = body.length, len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return [tag, ...len, ...body];
};
const be = (v: bigint, len: number) => { const out = new Array<number>(len).fill(0); for (let i = len - 1; i >= 0 && v > 0n; i--, v >>= 8n) out[i] = Number(v & 0xffn); return out; };
const fromBe = (b: Uint8Array) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const point = (k: JEcPublicKey) => [4, ...be(k.x, k.c.bytes), ...be(k.y, k.c.bytes)];
const algId = (c: Curve) => tlv(0x30, [...tlv(6, oidBytes(ID_EC)), ...tlv(6, oidBytes(c.oid))]);
const spki = (k: JEcPublicKey) => Uint8Array.from(tlv(0x30, [...algId(k.c), ...tlv(3, [0, ...point(k)])]));
const pkcs8 = (k: JEcPrivateKey) => Uint8Array.from(tlv(0x30, [...tlv(2, [0]), ...algId(k.c),
  ...tlv(4, tlv(0x30, [...tlv(2, [1]), ...tlv(4, be(k.s, k.c.bytes)), ...tlv(0xa1, tlv(3, [0, ...point(k.pub)]))]))]));

type Tlv = { tag: number; body: Uint8Array; end: number };
function read(b: Uint8Array, at: number): Tlv {
  const tag = b[at];
  let len = b[at + 1], off = at + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | b[off++]; }
  return { tag, body: b.subarray(off, off + len), end: off + len };
}
function children(b: Uint8Array): Tlv[] { const out = []; for (let at = 0; at < b.length;) { const t = read(b, at); out.push(t); at = t.end; } return out; }
const sameOid = (t: Tlv, oid: number[]) => { const o = oidBytes(oid); return t.tag === 6 && t.body.length === o.length && o.every((x, i) => x === t.body[i]); };
/** the algorithm of an SPKI or PKCS#8 blob: the curve for EC, null for RSA */
function algorithm(alg: Tlv): Curve | null | undefined {
  const [id, param] = children(alg.body);
  if (sameOid(id, ID_RSA)) return null;
  if (sameOid(id, ID_EC) && param) return CURVES.find((c) => sameOid(param, c.oid));
  return undefined;
}
function pointOf(c: Curve, raw: Uint8Array): JEcPublicKey {
  if (raw[0] !== 4 || raw.length !== 1 + 2 * c.bytes) throw badSpec("compressed or malformed EC point");
  return ecPublic(c, fromBe(raw.subarray(1, 1 + c.bytes)), fromBe(raw.subarray(1 + c.bytes)));
}

// ── keys
export class JEcPublicKey extends JObj { c!: Curve; x = 0n; y = 0n; }
export class JEcPrivateKey extends JObj { c!: Curve; s = 0n; pub!: JEcPublicKey; }
function ecPublic(c: Curve, x: bigint, y: bigint): JEcPublicKey {
  if (!onCurve(c, x, y)) throw badSpec("point is not on the curve");
  const k = rt.make("webdroid/EcPublicKey") as JEcPublicKey;
  k.c = c; k.x = x; k.y = y; return k;
}
function ecPrivate(c: Curve, s: bigint): JEcPrivateKey {
  if (s <= 0n || s >= c.n) throw badSpec("scalar out of range");
  const k = rt.make("webdroid/EcPrivateKey") as JEcPrivateKey;
  const [x, y] = mul(c, s, [c.gx, c.gy])!;
  k.c = c; k.s = s; k.pub = ecPublic(c, x, y); return k;
}
const inst = <T extends JObj>(cls: string, fields: Record<string, unknown>): T => Object.assign(rt.make(cls), fields) as T;
const specs = new Map<Curve, JObj>();
function paramSpec(c: Curve): JObj {
  let s = specs.get(c);
  if (!s) {
    const field = inst("java/security/spec/ECFieldFp", { p: mkBI(c.p), size: c.p.toString(2).length });
    const curve = inst("java/security/spec/EllipticCurve", { field, a: mkBI(c.a), b: mkBI(c.b) });
    specs.set(c, (s = inst("java/security/spec/ECParameterSpec", { curve, g: ecPoint(c.gx, c.gy), n: mkBI(c.n), h: 1 })));
  }
  return s;
}
const ecPoint = (x: bigint, y: bigint) => inst("java/security/spec/ECPoint", { x: mkBI(x), y: mkBI(y) });
/** the curve an app-built ECParameterSpec describes */
export function curveOfParams(params: any): Curve {
  const c = params && curveOf((params.curve?.field?.p as JBigInteger)?.v, (params.n as JBigInteger)?.v);
  if (!c) throw badSpec("unsupported curve");
  return c;
}

rt.markers("java/security/interfaces/ECKey", "java/security/interfaces/ECPublicKey", "java/security/interfaces/ECPrivateKey");
rt.register({
  name: "webdroid/EcPublicKey", ctor: JEcPublicKey, ifaces: ["java/security/interfaces/ECPublicKey", "java/security/interfaces/ECKey", "java/security/PublicKey", "java/security/Key"],
  methods: {
    "getAlgorithm()Ljava/lang/String;": () => "EC",
    "getFormat()Ljava/lang/String;": () => "X.509",
    "getEncoded()[B": function (this: JEcPublicKey) { return new Int8Array(spki(this)); },
    "getW()Ljava/security/spec/ECPoint;": function (this: JEcPublicKey) { return ecPoint(this.x, this.y); },
    "getParams()Ljava/security/spec/ECParameterSpec;": function (this: JEcPublicKey) { return paramSpec(this.c); },
    "equals(Ljava/lang/Object;)Z": function (this: JEcPublicKey, o: unknown) { return o instanceof JEcPublicKey && o.c === this.c && o.x === this.x && o.y === this.y ? 1 : 0; },
    "hashCode()I": function (this: JEcPublicKey) { return Number(BigInt.asIntN(32, this.x ^ this.y)); },
  },
});
rt.register({
  name: "webdroid/EcPrivateKey", ctor: JEcPrivateKey, ifaces: ["java/security/interfaces/ECPrivateKey", "java/security/interfaces/ECKey", "java/security/PrivateKey", "java/security/Key"],
  methods: {
    "getAlgorithm()Ljava/lang/String;": () => "EC",
    "getFormat()Ljava/lang/String;": () => "PKCS#8",
    "getEncoded()[B": function (this: JEcPrivateKey) { return new Int8Array(pkcs8(this)); },
    "getS()Ljava/math/BigInteger;": function (this: JEcPrivateKey) { return mkBI(this.s); },
    "getParams()Ljava/security/spec/ECParameterSpec;": function (this: JEcPrivateKey) { return paramSpec(this.c); },
  },
});

class JEncodedKeySpec extends JObj { encoded: Uint8Array<ArrayBuffer> = new Uint8Array(0); }
function initEncodedKeySpec(this: JEncodedKeySpec, b: Int8Array) { this.encoded = new Uint8Array(b); }
for (const [name, format] of [["java/security/spec/X509EncodedKeySpec", "X.509"], ["java/security/spec/PKCS8EncodedKeySpec", "PKCS#8"]]) {
  rt.register({
    name, ctor: class extends JEncodedKeySpec {}, ifaces: ["java/security/spec/KeySpec"],
    methods: {
      "<init>([B)V": initEncodedKeySpec,
      "<init>([BLjava/lang/String;)V": initEncodedKeySpec,
      "getEncoded()[B": function (this: JEncodedKeySpec) { return new Int8Array(this.encoded); },
      "getFormat()Ljava/lang/String;": () => format,
      "getAlgorithm()Ljava/lang/String;": () => null,
    },
  });
}

/** a WebCrypto-generated pair on the named curve */
export async function generateEc(name: string) {
  const c = curveNamed(name);
  if (!c) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "unsupported curve " + name);
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: c.web }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const num = (s: string) => fromBe(array(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  const priv = ecPrivate(c, num(jwk.d!));
  return inst<{ publicKey: JEcPublicKey; privateKey: JEcPrivateKey }>("java/security/KeyPair", { publicKey: priv.pub, privateKey: priv });
}
export const isEcCurve = (name: string) => !!curveNamed(name);

// RSA key specs: the numbers, encoded into the SubjectPublicKeyInfo / PKCS#8 the RSA keys carry
const big = (v: bigint) => { const b = be(v, Math.ceil((v.toString(2).length + 1) / 8) || 1); return tlv(2, b); };
const bigOf = (o: unknown) => (o as JBigInteger)?.v ?? 0n;
const rsaAlg = tlv(0x30, [...tlv(6, oidBytes(ID_RSA)), 5, 0]);
const rsaSpki = (n: bigint, e: bigint) => Uint8Array.from(tlv(0x30, [...rsaAlg, ...tlv(3, [0, ...tlv(0x30, [...big(n), ...big(e)])])]));
const rsaPkcs8 = (parts: bigint[]) => Uint8Array.from(tlv(0x30, [...tlv(2, [0]), ...rsaAlg, ...tlv(4, tlv(0x30, parts.flatMap(big)))]));
const RSA_CRT = ["n", "e", "d", "p", "q", "dp", "dq", "qinv"];
const BI = "Ljava/math/BigInteger;", KEY_SPEC = ["java/security/spec/KeySpec"];
class JRSAKeyGenParameterSpec extends JObj { keysize = 0; publicExponent: JBigInteger | null = null; keyParams: unknown = null; }
rt.register({ name: "java/security/spec/RSAKeyGenParameterSpec", ctor: JRSAKeyGenParameterSpec,
  ifaces: ["java/security/spec/AlgorithmParameterSpec"], statics: { F0: mkBI(3n), F4: mkBI(65537n) },
  methods: {
    "<init>(ILjava/math/BigInteger;)V": function (this: JRSAKeyGenParameterSpec, size: number, exponent: JBigInteger) {
      this.keysize = size; this.publicExponent = exponent;
    },
    "<init>(ILjava/math/BigInteger;Ljava/security/spec/AlgorithmParameterSpec;)V": function (this: JRSAKeyGenParameterSpec, size: number, exponent: JBigInteger, params: unknown) {
      this.keysize = size; this.publicExponent = exponent; this.keyParams = params;
    },
    "getKeysize()I": function (this: JRSAKeyGenParameterSpec) { return this.keysize; },
    "getPublicExponent()Ljava/math/BigInteger;": function (this: JRSAKeyGenParameterSpec) { return this.publicExponent; },
    "getKeyParams()Ljava/security/spec/AlgorithmParameterSpec;": function (this: JRSAKeyGenParameterSpec) { return this.keyParams; },
  },
});
valueClass("java/security/spec/RSAPublicKeySpec", ["n", "e"], `(${BI}${BI})V`, [[`getModulus()${BI}`, "n"], [`getPublicExponent()${BI}`, "e"]], KEY_SPEC);
valueClass("java/security/spec/RSAPrivateKeySpec", ["n", "d"], `(${BI}${BI})V`, [[`getModulus()${BI}`, "n"], [`getPrivateExponent()${BI}`, "d"]], KEY_SPEC);
valueClass("java/security/spec/RSAPrivateCrtKeySpec", RSA_CRT, `(${BI.repeat(8)})V`, [[`getPublicExponent()${BI}`, "e"], [`getPrimeP()${BI}`, "p"],
  [`getPrimeQ()${BI}`, "q"], [`getPrimeExponentP()${BI}`, "dp"], [`getPrimeExponentQ()${BI}`, "dq"], [`getCrtCoefficient()${BI}`, "qinv"]], [], "java/security/spec/RSAPrivateKeySpec");

class JKeyFactory extends JObj { algo = "EC"; }
rt.register({ name: "java/security/KeyFactorySpi", ctor: class extends JObj {}, methods: { "<init>()V": () => {} } });
const keyFactory = (algo: string) => {
  const a = String(algo).toUpperCase();
  if (a !== "EC" && a !== "RSA") throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algo + " KeyFactory not available");
  const f = new JKeyFactory(); f.algo = a; return f;
};
const rsaKey = <T extends JRsaPublicKey | JRsaPrivateKey>(cls: string, encoded: Uint8Array<ArrayBuffer>): T => { const k = rt.make(cls) as T; k.encoded = encoded; return k; };
rt.register({
  name: "java/security/KeyFactory", ctor: JKeyFactory,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/security/KeyFactory;": keyFactory,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljava/security/KeyFactory;": keyFactory,
    "static getInstance(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/KeyFactory;": (algo: string, provider: unknown) => {
      if (!provider) throw rt.mkThrowable("java/lang/IllegalArgumentException", "missing provider");
      return keyFactory(algo);
    },
    "getAlgorithm()Ljava/lang/String;": function (this: JKeyFactory) { return this.algo; },
    "generatePublic(Ljava/security/spec/KeySpec;)Ljava/security/PublicKey;": function (this: JKeyFactory, spec: any) {
      if (rt.iof(spec, "java/security/spec/ECPublicKeySpec")) return ecPublic(curveOfParams(spec.params), spec.w.x.v, spec.w.y.v);
      if (rt.iof(spec, "java/security/spec/RSAPublicKeySpec")) return rsaKey<JRsaPublicKey>("webdroid/RsaPublicKey", rsaSpki(bigOf(spec.n), bigOf(spec.e)));
      if (!(spec instanceof JEncodedKeySpec)) throw badSpec("unsupported key spec");
      const [alg, bits] = children(read(spec.encoded, 0).body);
      const c = alg && algorithm(alg);
      if (c === undefined || bits?.tag !== 3) throw badSpec("not an EC or RSA SubjectPublicKeyInfo");
      if (c === null) return rsaKey<JRsaPublicKey>("webdroid/RsaPublicKey", spec.encoded);
      return pointOf(c, bits.body.subarray(1));
    },
    "generatePrivate(Ljava/security/spec/KeySpec;)Ljava/security/PrivateKey;": function (this: JKeyFactory, spec: any) {
      if (rt.iof(spec, "java/security/spec/ECPrivateKeySpec")) return ecPrivate(curveOfParams(spec.params), spec.s.v);
      if (rt.iof(spec, "java/security/spec/RSAPrivateCrtKeySpec")) return rsaKey<JRsaPrivateKey>("webdroid/RsaPrivateKey", rsaPkcs8([0n, ...RSA_CRT.map((k) => bigOf(spec[k]))]));
      if (!(spec instanceof JEncodedKeySpec)) throw badSpec("unsupported key spec");
      const [, alg, key] = children(read(spec.encoded, 0).body);
      const c = alg && algorithm(alg);
      if (c === undefined || key?.tag !== 4) throw badSpec("not an EC or RSA PrivateKeyInfo");
      if (c === null) return rsaKey<JRsaPrivateKey>("webdroid/RsaPrivateKey", spec.encoded);
      const [, scalar] = children(read(key.body, 0).body);
      return ecPrivate(c, fromBe(scalar.body));
    },
    "getKeySpec(Ljava/security/Key;Ljava/lang/Class;)Ljava/security/spec/KeySpec;": (key: JObj, cls: { ci: { name: string } | null }) => {
      const want = cls.ci?.name ?? "";
      if (key instanceof JEcPublicKey && want.endsWith("ECPublicKeySpec")) return inst("java/security/spec/ECPublicKeySpec", { w: ecPoint(key.x, key.y), params: paramSpec(key.c) });
      if (key instanceof JEcPrivateKey && want.endsWith("ECPrivateKeySpec")) return inst("java/security/spec/ECPrivateKeySpec", { s: mkBI(key.s), params: paramSpec(key.c) });
      if (want.endsWith("EncodedKeySpec")) return inst(want, { encoded: (key as any).encoded ?? (key instanceof JEcPublicKey ? spki(key) : pkcs8(key as JEcPrivateKey)) });
      throw badSpec("unsupported key spec " + want);
    },
  },
});

class JKeyAgreement extends JObj { priv: JEcPrivateKey | null = null; peer: JEcPublicKey | null = null; }
const keyAgreement = (algo: string) => {
  if (String(algo).toUpperCase() !== "ECDH") throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algo + " KeyAgreement not available");
  return new JKeyAgreement();
};
const invalidKey = (msg: string) => rt.mkThrowable("java/security/InvalidKeyException", msg);
function agreementInit(this: JKeyAgreement, k: unknown) { if (!(k instanceof JEcPrivateKey)) throw invalidKey("EC private key required"); this.priv = k; this.peer = null; }
rt.register({
  name: "javax/crypto/KeyAgreement", ctor: JKeyAgreement,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljavax/crypto/KeyAgreement;": keyAgreement,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyAgreement;": keyAgreement,
    "getAlgorithm()Ljava/lang/String;": () => "ECDH",
    "init(Ljava/security/Key;)V": agreementInit,
    "init(Ljava/security/Key;Ljava/security/SecureRandom;)V": agreementInit,
    "doPhase(Ljava/security/Key;Z)Ljava/security/Key;": function (this: JKeyAgreement, k: unknown, last: number) {
      if (!this.priv) throw rt.mkThrowable("java/lang/IllegalStateException", "not initialized");
      if (!(k instanceof JEcPublicKey) || k.c !== this.priv.c) throw invalidKey("EC public key on the same curve required");
      if (!last) throw invalidKey("ECDH has one phase");
      this.peer = k; return null;
    },
    "generateSecret()[B": function (this: JKeyAgreement) {
      if (!this.priv || !this.peer) throw rt.mkThrowable("java/lang/IllegalStateException", "not initialized");
      const s = mul(this.priv.c, this.priv.s, [this.peer.x, this.peer.y]);
      this.peer = null;
      if (!s) throw invalidKey("shared point at infinity");
      return new Int8Array(be(s[0], this.priv.c.bytes));
    },
  },
});
