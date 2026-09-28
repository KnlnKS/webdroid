// java.security.Signature over WebCrypto: RSASSA-PKCS1-v1_5, RSA-PSS and ECDSA with the SHA-1/2
// digests WebCrypto signs with. Keys are the RSA (SPKI/PKCS#8) and EC (curve point/scalar)
// objects KeyFactory and KeyPairGenerator hand out.
import { JObj, rt, driven, type Gen } from "../runtime";
import { vcall, after } from "./jlang";
import { concat, u8 } from "../abi";
import { JRsaPublicKey, JRsaPrivateKey, JPSSSpec } from "./jrsa";
import { JEcPublicKey, JEcPrivateKey, type Curve, be, tlv, invalidKey } from "./jec";

type Scheme = "RSASSA-PKCS1-v1_5" | "RSA-PSS" | "ECDSA";
const HASHES: Record<string, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA384: "SHA-384", SHA512: "SHA-512" };
const HASH_BYTES: Record<string, number> = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 };
const webHash = (name: string) => HASHES[name.toUpperCase().replace("-", "")];

class JSignature extends JObj {
  algo = ""; scheme: Scheme = "RSASSA-PKCS1-v1_5"; hash: string | null = null; salt: number | null = null;
  key: unknown = null; signing = false; parts: Uint8Array[] = []; state = 0;
  imported: { key: CryptoKey; hash: string } | null = null;
}
function signature(algo: string): JSignature {
  const s = new JSignature(); s.algo = algo;
  const m = /^(.+?)WITH(RSA|ECDSA|RSA\/PSS|RSAANDMGF1|RSASSA-PSS)$/i.exec(algo);
  if (m) {
    s.hash = webHash(m[1]) ?? null;
    s.scheme = /ECDSA/i.test(m[2]) ? "ECDSA" : m[2].toUpperCase() === "RSA" ? "RSASSA-PKCS1-v1_5" : "RSA-PSS";
    if (s.hash) return s;
  } else if (algo.toUpperCase() === "RSASSA-PSS") { s.scheme = "RSA-PSS"; return s; }
  throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algo + " Signature not available");
}
function b64url(v: bigint, len: number): string {
  return btoa(String.fromCharCode(...be(v, len))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importKey(s: JSignature): Promise<{ key: CryptoKey; hash: string }> {
  if (!s.hash) throw rt.mkThrowable("java/security/SignatureException", "parameters must be specified before " + (s.signing ? "signing" : "verifying"));
  if (s.imported?.hash === s.hash) return s.imported;
  const usage: KeyUsage[] = [s.signing ? "sign" : "verify"], k = s.key;
  let key: CryptoKey;
  if (s.scheme === "ECDSA") {
    if (!(k instanceof (s.signing ? JEcPrivateKey : JEcPublicKey))) throw invalidKey("EC key required");
    const pub = k instanceof JEcPrivateKey ? k.pub : k, c = pub.c;
    const jwk: JsonWebKey = { kty: "EC", crv: c.web, x: b64url(pub.x, c.bytes), y: b64url(pub.y, c.bytes) };
    if (k instanceof JEcPrivateKey) jwk.d = b64url(k.s, c.bytes);
    key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: c.web }, false, usage);
  } else {
    if (!(k instanceof (s.signing ? JRsaPrivateKey : JRsaPublicKey))) throw invalidKey("RSA key required");
    key = await crypto.subtle.importKey(s.signing ? "pkcs8" : "spki", k.encoded, { name: s.scheme, hash: s.hash }, false, usage);
  }
  return (s.imported = { key, hash: s.hash });
}
function params(s: JSignature): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (s.scheme === "ECDSA") return { name: "ECDSA", hash: s.hash! };
  if (s.scheme === "RSA-PSS") return { name: "RSA-PSS", saltLength: s.salt ?? HASH_BYTES[s.hash!] };
  return { name: s.scheme };
}
function curveOf(s: JSignature): Curve { const k = s.key; return k instanceof JEcPrivateKey ? k.pub.c : (k as JEcPublicKey).c; }
function message(s: JSignature): Uint8Array<ArrayBuffer> {
  const all = concat(s.parts);
  s.parts = [];
  return all;
}

// ── ECDSA: JCA signatures are DER SEQUENCE { INTEGER r, INTEGER s }; WebCrypto uses raw r‖s
function derInt(b: Uint8Array): number[] {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const body = [...b.subarray(i)];
  if (body[0] & 0x80) body.unshift(0);
  return tlv(2, body);
}
const derFromRaw = (raw: Uint8Array, n: number) => Int8Array.from(tlv(0x30, [...derInt(raw.subarray(0, n)), ...derInt(raw.subarray(n))]));
function rawFromDer(der: Uint8Array, n: number): Uint8Array<ArrayBuffer> | null {
  let at = 0;
  const readLen = () => { let len = der[at++]; if (len === 0x81) len = der[at++]; else if (len & 0x80) return -1; return len; };
  if (der[at++] !== 0x30) return null;
  const seqLen = readLen();
  if (seqLen < 0 || at + seqLen !== der.length) return null;
  const out = new Uint8Array(2 * n);
  for (let i = 0; i < 2; i++) {
    if (der[at++] !== 2) return null;
    const len = readLen();
    if (len <= 0 || at + len > der.length) return null;
    let v = der.subarray(at, at + len); at += len;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > n) return null;
    out.set(v, n * (i + 1) - v.length);
  }
  return at === der.length ? out : null;
}

function init(s: JSignature, key: unknown, signing: boolean) {
  if (key == null) throw invalidKey("key == null");
  s.key = key; s.signing = signing; s.parts = []; s.imported = null;
}
function initSign(this: JSignature, key: unknown) { init(this, key, true); }
const SIGN = 2, VERIFY = 3;
function initEngine(s: JSignature, engine: string, desc: string, state: number, ...args: unknown[]) {
  return after(vcall(s, engine, desc, ...args), () => { s.state = state; });
}
function updating(s: JSignature) {
  if (s.state !== SIGN && s.state !== VERIFY) throw rt.mkThrowable("java/security/SignatureException", "object not initialized for signature or verification");
}
function ready(s: JSignature, signing: boolean) {
  if (!s.key || s.signing !== signing) throw rt.mkThrowable("java/security/SignatureException", "object not initialized for " + (signing ? "signing" : "verification"));
}
rt.register({
  name: "java/security/Signature", ctor: JSignature,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/security/Signature;": signature,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljava/security/Signature;": signature,
    "static getInstance(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/Signature;": (algo: string, provider: unknown) => {
      if (!provider) throw rt.mkThrowable("java/lang/IllegalArgumentException", "missing provider");
      return signature(algo);
    },
    "getAlgorithm()Ljava/lang/String;": function (this: JSignature) { return this.algo; },
    "toString()Ljava/lang/String;": function (this: JSignature) { return "Signature object: " + this.algo + (this.key ? this.signing ? "<initialized for signing>" : "<initialized for verifying>" : "<not initialized>"); },
    "<init>(Ljava/lang/String;)V": function (this: JSignature, algo: string) { this.algo = algo; },
    // the public operations check the state and run the engine methods a provider subclass implements
    "initVerify(Ljava/security/PublicKey;)V": function (this: JSignature, key: unknown) { return initEngine(this, "engineInitVerify", "(Ljava/security/PublicKey;)V", VERIFY, key); },
    "initVerify(Ljava/security/cert/Certificate;)V": driven(function* (this: JSignature, cert: unknown): Gen {
      if (cert == null) throw invalidKey("key == null");
      yield initEngine(this, "engineInitVerify", "(Ljava/security/PublicKey;)V", VERIFY, yield vcall(cert, "getPublicKey", "()Ljava/security/PublicKey;"));
    }),
    "initSign(Ljava/security/PrivateKey;)V": function (this: JSignature, key: unknown) { return initEngine(this, "engineInitSign", "(Ljava/security/PrivateKey;)V", SIGN, key); },
    "initSign(Ljava/security/PrivateKey;Ljava/security/SecureRandom;)V": function (this: JSignature, key: unknown, random: unknown) {
      return initEngine(this, "engineInitSign", "(Ljava/security/PrivateKey;Ljava/security/SecureRandom;)V", SIGN, key, random);
    },
    "setParameter(Ljava/security/spec/AlgorithmParameterSpec;)V": function (this: JSignature, spec: unknown) {
      return vcall(this, "engineSetParameter", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
    },
    "update(B)V": function (this: JSignature, b: number) { updating(this); return vcall(this, "engineUpdate", "(B)V", b); },
    "update([B)V": function (this: JSignature, b: Int8Array) { updating(this); return vcall(this, "engineUpdate", "([BII)V", b, 0, b.length); },
    "update([BII)V": function (this: JSignature, b: Int8Array, off: number, len: number) {
      updating(this);
      if (b == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "data is null");
      if (off < 0 || len < 0 || off + len > b.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bad arguments");
      return vcall(this, "engineUpdate", "([BII)V", b, off, len);
    },
    "sign()[B": function (this: JSignature) {
      if (this.state !== SIGN) throw rt.mkThrowable("java/security/SignatureException", "object not initialized for signing");
      return vcall(this, "engineSign", "()[B");
    },
    "verify([B)Z": function (this: JSignature, sig: Int8Array) {
      if (this.state !== VERIFY) throw rt.mkThrowable("java/security/SignatureException", "object not initialized for verification");
      return vcall(this, "engineVerify", "([B)Z", sig);
    },
    "engineInitVerify(Ljava/security/PublicKey;)V": function (this: JSignature, key: unknown) { init(this, key, false); },
    "engineInitSign(Ljava/security/PrivateKey;)V": initSign,
    "engineInitSign(Ljava/security/PrivateKey;Ljava/security/SecureRandom;)V": initSign,
    "engineSetParameter(Ljava/security/spec/AlgorithmParameterSpec;)V": function (this: JSignature, spec: unknown) {
      const bad = (msg: string) => rt.mkThrowable("java/security/InvalidAlgorithmParameterException", msg);
      if (this.scheme !== "RSA-PSS" || !(spec instanceof JPSSSpec)) throw bad("unsupported parameters for " + this.algo);
      const hash = webHash(spec.digest), mgfHash = spec.mgfSpec ? webHash(spec.mgfSpec.digest) : hash;
      if (!hash || spec.mgf.toUpperCase() !== "MGF1") throw bad("unsupported digest " + spec.digest);
      if (mgfHash !== hash) throw bad("MGF1 digest must match the signature digest");
      if (this.hash && this.hash !== hash) throw bad("digest " + spec.digest + " does not match " + this.algo);
      this.hash = hash; this.salt = spec.salt; this.imported = null;
    },
    "getParameters()Ljava/security/AlgorithmParameters;": () => null,
    "engineUpdate(B)V": function (this: JSignature, b: number) { ready(this, this.signing); this.parts.push(new Uint8Array([b & 0xff])); },
    "engineUpdate([BII)V": function (this: JSignature, b: Int8Array, off: number, len: number) { ready(this, this.signing); this.parts.push(u8(b, off, len).slice()); },
    "engineSign()[B": driven(function* (this: JSignature): Gen {
      ready(this, true);
      const { key } = yield importKey(this);
      const raw = new Uint8Array(yield crypto.subtle.sign(params(this), key, message(this)));
      return this.scheme === "ECDSA" ? derFromRaw(raw, curveOf(this).bytes) : new Int8Array(raw.buffer);
    }),
    "engineVerify([B)Z": driven(function* (this: JSignature, sig: Int8Array): Gen {
      ready(this, false);
      if (sig == null) throw rt.mkThrowable("java/lang/NullPointerException", "signature == null");
      const { key } = yield importKey(this), data = message(this);
      let bytes: Uint8Array<ArrayBuffer> | null = u8(sig).slice();
      if (this.scheme === "ECDSA") bytes = rawFromDer(bytes, curveOf(this).bytes);
      return bytes && (yield crypto.subtle.verify(params(this), key, bytes, data)) ? 1 : 0;
    }),
  },
});
