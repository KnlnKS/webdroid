import type { pki } from "node-forge";
import { JObj, rt, driven, type Gen } from "../runtime";
import { jarray } from "../abi";
import { vcall } from "./jlang";
import { mkBI } from "./jmath";
import { JKeyGenSpec } from "../../android/security";

export const forge = () => import("../../forge").then((m) => m.default);
export const binary = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
export const array = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export class JRsaPublicKey extends JObj {
  encoded = new Uint8Array(0);
  parsed: pki.rsa.PublicKey | null = null;
  async key() {
    const f = await forge();
    return this.parsed ??= f.pki.publicKeyFromAsn1(f.asn1.fromDer(binary(this.encoded)));
  }
}
export class JRsaPrivateKey extends JObj {
  encoded = new Uint8Array(0);
  publicKey = new JRsaPublicKey();
  certificate: JRsaCertificate | null = null;
  stored = false;
  parsed: pki.rsa.PrivateKey | null = null;
  async key() {
    const f = await forge();
    return this.parsed ??= f.pki.privateKeyFromAsn1(f.asn1.fromDer(binary(this.encoded)));
  }
}
class JRsaCertificate extends JObj {
  encoded = new Uint8Array(0);
  publicKey = new JRsaPublicKey();
}
class JRsaKeyPair extends JObj {
  publicKey = new JRsaPublicKey();
  privateKey = new JRsaPrivateKey();
}
for (const name of ["java/security/PublicKey", "java/security/PrivateKey"]) {
  rt.register({ name, ctor: class extends JObj {}, ifaces: ["java/security/Key"] });
}
rt.markers("java/security/interfaces/RSAKey", "java/security/interfaces/RSAPublicKey", "java/security/interfaces/RSAPrivateKey");
const bigInt = (v: { toString(radix: number): string }) => mkBI(BigInt("0x" + v.toString(16)));
rt.register({
  name: "webdroid/RsaPublicKey", ctor: JRsaPublicKey, ifaces: ["java/security/interfaces/RSAPublicKey", "java/security/interfaces/RSAKey", "java/security/PublicKey", "java/security/Key"],
  methods: {
    "getAlgorithm()Ljava/lang/String;": () => "RSA",
    "getFormat()Ljava/lang/String;": () => "X.509",
    "getEncoded()[B": function (this: JRsaPublicKey) { return new Int8Array(this.encoded); },
    "getModulus()Ljava/math/BigInteger;": driven(function* (this: JRsaPublicKey): Gen { return bigInt((yield this.key()).n); }),
    "getPublicExponent()Ljava/math/BigInteger;": driven(function* (this: JRsaPublicKey): Gen { return bigInt((yield this.key()).e); }),
    "equals(Ljava/lang/Object;)Z": function (this: JRsaPublicKey, o: unknown) { return o instanceof JRsaPublicKey && o.encoded.length === this.encoded.length && o.encoded.every((b, i) => b === this.encoded[i]) ? 1 : 0; },
    "hashCode()I": function (this: JRsaPublicKey) { let h = 0; for (const b of this.encoded) h = (Math.imul(h, 31) + b) | 0; return h; },
  },
});
rt.register({
  name: "webdroid/RsaPrivateKey", ctor: JRsaPrivateKey, ifaces: ["java/security/interfaces/RSAPrivateKey", "java/security/interfaces/RSAKey", "java/security/PrivateKey", "java/security/Key"],
  methods: {
    "getModulus()Ljava/math/BigInteger;": driven(function* (this: JRsaPrivateKey): Gen { return bigInt((yield this.key()).n); }),
    "getPrivateExponent()Ljava/math/BigInteger;": driven(function* (this: JRsaPrivateKey): Gen { return bigInt((yield this.key()).d); }),
    "getAlgorithm()Ljava/lang/String;": () => "RSA",
    "getFormat()Ljava/lang/String;": function (this: JRsaPrivateKey) { return this.stored ? null : "PKCS#8"; },
    "getEncoded()[B": function (this: JRsaPrivateKey) { return this.stored ? null : new Int8Array(this.encoded); },
  },
});
rt.register({
  name: "java/security/KeyPair", ctor: JRsaKeyPair,
  methods: {
    "<init>(Ljava/security/PublicKey;Ljava/security/PrivateKey;)V": function (this: JRsaKeyPair, pub: JRsaPublicKey, priv: JRsaPrivateKey) { this.publicKey = pub; this.privateKey = priv; },
    "getPublic()Ljava/security/PublicKey;": function (this: JRsaKeyPair) { return this.publicKey; },
    "getPrivate()Ljava/security/PrivateKey;": function (this: JRsaKeyPair) { return this.privateKey; },
  },
});
rt.register({
  name: "webdroid/RsaCertificate", ctor: JRsaCertificate, sup: "java/security/cert/Certificate",
  methods: {
    "getType()Ljava/lang/String;": () => "X.509",
    "getEncoded()[B": function (this: JRsaCertificate) { return new Int8Array(this.encoded); },
    "getPublicKey()Ljava/security/PublicKey;": function (this: JRsaCertificate) { return this.publicKey; },
  },
});

export async function generateRsa(bits: number, spec: JKeyGenSpec | null): Promise<JRsaKeyPair> {
  const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  for (const name of ["webdroid/RsaPublicKey", "webdroid/RsaPrivateKey", "webdroid/RsaCertificate", "java/security/KeyPair"]) rt.link(name);
  const pair = new JRsaKeyPair();
  pair.publicKey.encoded = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  pair.privateKey.encoded = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  pair.privateKey.publicKey = pair.publicKey;
  if (spec) {
    const f = await forge(), cert = f.pki.createCertificate();
    cert.publicKey = await pair.publicKey.key();
    const subject = spec.certificateSubject == null ? "CN=fake" : await vcall(spec.certificateSubject, "getName", "()Ljava/lang/String;");
    const attrs = String(subject).split(/(?<!\\),/).map((part) => {
      const at = part.indexOf("=");
      if (at < 1) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Invalid certificate subject");
      return { shortName: part.slice(0, at).trim(), value: part.slice(at + 1).trim().replace(/\\(.)/g, "$1") };
    });
    cert.setSubject(attrs); cert.setIssuer(attrs);
    let serial = spec.certificateSerial == null ? "1" : String(await vcall(spec.certificateSerial, "toString", "(I)Ljava/lang/String;", 16));
    if (serial.length % 2) serial = "0" + serial;
    cert.serialNumber = serial;
    cert.validity.notBefore = new Date(spec.certificateNotBefore == null ? 0 : Number(await vcall(spec.certificateNotBefore, "getTime", "()J")));
    cert.validity.notAfter = new Date(spec.certificateNotAfter == null ? 2461449600000 : Number(await vcall(spec.certificateNotAfter, "getTime", "()J")));
    cert.sign(await pair.privateKey.key(), f.md.sha256.create());
    const certificate = new JRsaCertificate(); certificate.publicKey = pair.publicKey;
    certificate.encoded = array(f.asn1.toDer(f.pki.certificateToAsn1(cert)).getBytes());
    pair.privateKey.certificate = certificate;
    pair.privateKey.stored = true;
  }
  return pair;
}
export function restoreRsa(priv: string, pub: string, cert: string): JRsaPrivateKey {
  for (const name of ["webdroid/RsaPublicKey", "webdroid/RsaPrivateKey", "webdroid/RsaCertificate"]) rt.link(name);
  const key = new JRsaPrivateKey(); key.encoded = array(atob(priv)); key.publicKey.encoded = array(atob(pub)); key.stored = true;
  key.certificate = new JRsaCertificate(); key.certificate.publicKey = key.publicKey; key.certificate.encoded = array(atob(cert));
  return key;
}
export const rsaChain = (key: JRsaPrivateKey) => key.certificate && jarray([key.certificate], "Ljava/security/cert/Certificate;");

class JMGFSpec extends JObj { digest = "SHA-1"; }
class JPSource extends JObj { value = new Uint8Array(0); }
class JPSpecified extends JPSource {}
export class JOAEP extends JObj { digest = "SHA-1"; mgf = new JMGFSpec(); source = new JPSpecified(); }
rt.register({
  name: "java/security/spec/MGF1ParameterSpec", ctor: JMGFSpec, ifaces: ["java/security/spec/AlgorithmParameterSpec"],
  statics: Object.fromEntries(["SHA-1", "SHA-224", "SHA-256", "SHA-384", "SHA-512"].map((digest) => [digest.replace("-", ""), Object.assign(new JMGFSpec(), { digest })])),
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JMGFSpec, digest: string) { this.digest = digest; },
    "getDigestAlgorithm()Ljava/lang/String;": function (this: JMGFSpec) { return this.digest; },
  },
});
rt.register({ name: "javax/crypto/spec/PSource", ctor: JPSource, methods: { "getAlgorithm()Ljava/lang/String;": () => "PSpecified" } });
rt.register({
  name: "javax/crypto/spec/PSource$PSpecified", ctor: JPSpecified, sup: "javax/crypto/spec/PSource",
  statics: { DEFAULT: new JPSpecified() },
  methods: {
    "<init>([B)V": function (this: JPSource, value: Int8Array) { this.value = new Uint8Array(value); },
    "getValue()[B": function (this: JPSource) { return new Int8Array(this.value); },
  },
});
rt.register({
  name: "javax/crypto/spec/OAEPParameterSpec", ctor: JOAEP, ifaces: ["java/security/spec/AlgorithmParameterSpec"], statics: { DEFAULT: new JOAEP() },
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/security/spec/AlgorithmParameterSpec;Ljavax/crypto/spec/PSource;)V": function (this: JOAEP, digest: string, mgf: string, params: JMGFSpec, source: JPSource) {
      if (digest == null || mgf == null || source == null) throw rt.mkThrowable("java/lang/NullPointerException", "OAEP parameters");
      if (mgf.toUpperCase() !== "MGF1" || !(params instanceof JMGFSpec) || !(source instanceof JPSource)) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Unsupported OAEP parameters");
      this.digest = digest; this.mgf = params; this.source = source;
    },
    "getDigestAlgorithm()Ljava/lang/String;": function (this: JOAEP) { return this.digest; },
    "getMGFAlgorithm()Ljava/lang/String;": () => "MGF1",
    "getMGFParameters()Ljava/security/spec/AlgorithmParameterSpec;": function (this: JOAEP) { return this.mgf; },
    "getPSource()Ljavax/crypto/spec/PSource;": function (this: JOAEP) { return this.source; },
  },
});
/** forge's names for the RSA/ECB paddings: OAEPPadding, PKCS1Padding, NoPadding */
export type RsaScheme = "RSA-OAEP" | "RSAES-PKCS1-V1_5" | "RAW";
export async function rsaCrypt(key: JRsaPublicKey | JRsaPrivateKey, input: Uint8Array, scheme: RsaScheme, spec: JOAEP): Promise<Int8Array> {
  const f = await forge();
  const digest = (name: string) => {
    const algorithm = name.toLowerCase().replace(/-/g, "");
    if (algorithm === "sha1") return f.md.sha1.create();
    if (algorithm === "sha256") return f.md.sha256.create();
    if (algorithm === "sha384") return f.md.sha384.create();
    if (algorithm === "sha512") return f.md.sha512.create();
    throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Unsupported OAEP digest: " + name);
  };
  const options = scheme === "RSA-OAEP" ? { md: digest(spec.digest), mgf1: { md: digest(spec.mgf.digest) }, label: binary(spec.source.value) } : undefined;
  try {
    const result = key instanceof JRsaPublicKey ? (await key.key()).encrypt(binary(input), scheme, options) : (await key.key()).decrypt(binary(input), scheme, options);
    return new Int8Array(array(result));
  } catch {
    throw rt.mkThrowable(key instanceof JRsaPublicKey ? "javax/crypto/IllegalBlockSizeException" : "javax/crypto/BadPaddingException", "RSA " + scheme + " operation failed");
  }
}

export class JPSSSpec extends JObj { digest = "SHA-1"; mgf = "MGF1"; mgfSpec: JMGFSpec | null = null; salt = 20; trailer = 1; }
rt.register({
  name: "java/security/spec/PSSParameterSpec", ctor: JPSSSpec, ifaces: ["java/security/spec/AlgorithmParameterSpec"],
  statics: { DEFAULT: new JPSSSpec(), TRAILER_FIELD_BC: 1 },
  methods: {
    "<init>(I)V": function (this: JPSSSpec, salt: number) {
      if (salt < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative saltLen value");
      this.salt = salt;
    },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/security/spec/AlgorithmParameterSpec;II)V": function (this: JPSSSpec, digest: string, mgf: string, spec: JMGFSpec | null, salt: number, trailer: number) {
      if (digest == null || mgf == null) throw rt.mkThrowable("java/lang/NullPointerException", "digest algorithm and mask generation function cannot be null");
      if (salt < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative saltLen value");
      if (trailer < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative trailerField");
      this.digest = digest; this.mgf = mgf; this.mgfSpec = spec; this.salt = salt; this.trailer = trailer;
    },
    "getDigestAlgorithm()Ljava/lang/String;": function (this: JPSSSpec) { return this.digest; },
    "getMGFAlgorithm()Ljava/lang/String;": function (this: JPSSSpec) { return this.mgf; },
    "getMGFParameters()Ljava/security/spec/AlgorithmParameterSpec;": function (this: JPSSSpec) { return this.mgfSpec; },
    "getSaltLength()I": function (this: JPSSSpec) { return this.salt; },
    "getTrailerField()I": function (this: JPSSSpec) { return this.trailer; },
  },
});
