// X.509 certificates: parsed from DER through forge's ASN.1 reader (its certificate model
// only knows RSA keys, and CDN leaves are EC), signatures checked with WebCrypto, and chains
// built against the system CA store the shell mounts. Cronet asks Java for exactly this.
import type { asn1 } from "node-forge";
import { JObj, rt } from "../runtime";
import { jarray, i8 } from "../abi";
import { boxInt, defineException, newObj, stringHash, vcall } from "./jlang";
import { newArrayList, mkIter } from "./jutil";
import { JRsaPublicKey, forge, binary, array as bytes } from "./jrsa";
import { JDate } from "./jtime";
import { readStreamFully } from "./jio";

type Node = asn1.Asn1;

const SIG: Record<string, { name: "RSASSA-PKCS1-v1_5" | "ECDSA"; hash: string }> = {
  "1.2.840.113549.1.1.5": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, "1.2.840.113549.1.1.11": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, "1.2.840.113549.1.1.13": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
  "1.2.840.10045.4.1": { name: "ECDSA", hash: "SHA-1" }, "1.2.840.10045.4.3.2": { name: "ECDSA", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { name: "ECDSA", hash: "SHA-384" }, "1.2.840.10045.4.3.4": { name: "ECDSA", hash: "SHA-512" },
};
const SIG_NAME: Record<string, string> = { "SHA-1": "SHA1", "SHA-256": "SHA256", "SHA-384": "SHA384", "SHA-512": "SHA512" };
const CURVES: Record<string, { name: string; bytes: number }> = { "1.2.840.10045.3.1.7": { name: "P-256", bytes: 32 }, "1.3.132.0.34": { name: "P-384", bytes: 48 }, "1.3.132.0.35": { name: "P-521", bytes: 66 } };
const RSA_OID = "1.2.840.113549.1.1.1", EC_OID = "1.2.840.10045.2.1";

class JX509Key extends JObj { algorithm = "EC"; encoded = new Uint8Array(0); }
rt.register({
  name: "webdroid/X509Key", ctor: JX509Key, ifaces: ["java/security/PublicKey", "java/security/Key"],
  methods: {
    "getAlgorithm()Ljava/lang/String;": function (this: JX509Key) { return this.algorithm; },
    "getFormat()Ljava/lang/String;": () => "X.509",
    "getEncoded()[B": function (this: JX509Key) { return i8(this.encoded); },
    "equals(Ljava/lang/Object;)Z": function (this: JX509Key, o: unknown) { return o instanceof JX509Key && binary(o.encoded) === binary(this.encoded) ? 1 : 0; },
    "hashCode()I": function (this: JX509Key) { return stringHash(binary(this.encoded)); },
  },
});

/** The certificate an app sees. One parsed from bytes answers from its fields; one a
 *  relay-terminated session fabricates asserts only the host it was asked for. */
export class JX509 extends JObj {
  host = "";
  der = new Uint8Array(0);
  tbs = new Uint8Array(0); sig = new Uint8Array(0); sigOid = "";
  serial = ""; version = 3;
  subject = ""; issuer = ""; subjectDer = ""; issuerDer = "";
  notBefore = 0; notAfter = 0;
  spki = new Uint8Array(0); keyOid = ""; curve = "";
  exts: Record<string, any>[] = [];
  ext(name: string) { return this.exts.find((e) => e.name === name); }
}
const der = (n: Node, f: Awaited<ReturnType<typeof forge>>) => bytes(f.asn1.toDer(n).getBytes());
function dnString(rdn: Node, f: Awaited<ReturnType<typeof forge>>): string {
  const attrs = (f.pki as any).RDNAttributesAsArray(rdn) as { shortName?: string; type: string; value: string }[];
  return attrs.map((a) => `${a.shortName ?? a.type}=${a.value.replace(/([,+"\\<>;])/g, "\\$1")}`).reverse().join(",");
}
/** parse one DER certificate */
export async function parseX509(input: Uint8Array): Promise<JX509> {
  const f = await forge();
  const root = (f.asn1 as any).fromDer(binary(input), { strict: false, decodeBitStrings: false }) as Node;
  const c = rt.make("java/security/cert/X509Certificate") as JX509;
  const [tbs, sigAlg, sigBits] = root.value as Node[];
  c.der = new Uint8Array(input);
  c.tbs = der(tbs, f);
  c.sigOid = f.asn1.derToOid((sigAlg.value as Node[])[0].value as string);
  c.sig = bytes(String(sigBits.value).slice(1));
  const fields = tbs.value as Node[];
  let i = 0;
  if (fields[0].tagClass === f.asn1.Class.CONTEXT_SPECIFIC) { c.version = ((fields[0].value as Node[])[0].value as string).charCodeAt(0) + 1; i = 1; }
  c.serial = f.util.createBuffer(fields[i] .value as string).toHex();
  c.issuerDer = binary(der(fields[i + 2], f)); c.issuer = dnString(fields[i + 2], f);
  const [nb, na] = fields[i + 3].value as Node[];
  c.notBefore = f.asn1.utcTimeToDate(nb.value as string)?.getTime() ?? Date.parse((nb.value as string).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z"));
  c.notAfter = (nb.type === f.asn1.Type.UTCTIME ? f.asn1.utcTimeToDate : f.asn1.generalizedTimeToDate)(na.value as string).getTime();
  if (nb.type === f.asn1.Type.GENERALIZEDTIME) c.notBefore = f.asn1.generalizedTimeToDate(nb.value as string).getTime();
  c.subjectDer = binary(der(fields[i + 4], f)); c.subject = dnString(fields[i + 4], f);
  const spki = fields[i + 5];
  c.spki = der(spki, f);
  const alg = (spki.value as Node[])[0].value as Node[];
  c.keyOid = f.asn1.derToOid(alg[0].value as string);
  if (c.keyOid === EC_OID && alg[1]?.type === f.asn1.Type.OID) c.curve = f.asn1.derToOid(alg[1].value as string);
  for (const x of fields.slice(i + 6)) {
    if (x.tagClass !== f.asn1.Class.CONTEXT_SPECIFIC || x.type !== 3) continue;
    for (const e of ((x.value as Node[])[0].value as Node[])) c.exts.push((f.pki as any).certificateExtensionFromAsn1(e));
  }
  return c;
}
async function fromPem(text: string): Promise<JX509[]> {
  const f = await forge();
  return Promise.all(f.pem.decode(text).filter((m) => m.type === "CERTIFICATE").map((m) => parseX509(bytes(m.body))));
}

/** does `issuer` sign `c`? */
async function signed(c: JX509, issuer: JX509): Promise<boolean> {
  const alg = SIG[c.sigOid];
  if (!alg) throw rt.mkThrowable("java/security/cert/CertificateException", "unsupported signature " + c.sigOid);
  const key = await crypto.subtle.importKey("spki", issuer.spki, alg.name === "ECDSA" ? { name: "ECDSA", namedCurve: CURVES[issuer.curve]?.name ?? "P-256" } : { name: alg.name, hash: alg.hash }, false, ["verify"]);
  let sig = c.sig;
  if (alg.name === "ECDSA") {
    // DER SEQUENCE { r, s } → the fixed-width r || s WebCrypto takes
    const f = await forge(), n = CURVES[issuer.curve]?.bytes ?? 32;
    const [r, s] = (f.asn1.fromDer(binary(c.sig)).value as Node[]).map((v) => bytes(v.value as string));
    sig = new Uint8Array(2 * n);
    sig.set(r.subarray(Math.max(0, r.length - n)), n - Math.min(n, r.length));
    sig.set(s.subarray(Math.max(0, s.length - n)), 2 * n - Math.min(n, s.length));
  }
  return crypto.subtle.verify(alg.name === "ECDSA" ? { name: "ECDSA", hash: alg.hash } : alg.name, key, sig, c.tbs);
}

// ── the system trust store: /vendor/android-cacerts.pem, parsed once, keyed by subject
let anchors: Promise<Map<string, JX509[]>> | null = null;
function systemAnchors(): Promise<Map<string, JX509[]>> {
  return anchors ??= fetch("/vendor/android-cacerts.pem").then((r) => r.text()).then(fromPem).then((certs) => {
    const m = new Map<string, JX509[]>();
    for (const c of certs) { let l = m.get(c.subjectDer); if (!l) m.set(c.subjectDer, (l = [])); l.push(c); }
    return m;
  });
}
/** alias → certificate, the way the AndroidCAStore KeyStore names them */
async function systemCaEntries(): Promise<Map<string, JX509>> {
  const m = new Map<string, JX509>();
  for (const certs of (await systemAnchors()).values()) for (const c of certs) m.set("system:" + stringHash(c.subjectDer).toString(16), c);
  return m;
}
const certErr = (msg: string) => rt.mkThrowable("java/security/cert/CertificateException", msg);
function checkValidity(c: JX509, at = Date.now()) {
  if (at < c.notBefore) throw rt.mkThrowable("java/security/cert/CertificateNotYetValidException", "certificate not valid yet: " + c.subject);
  if (at > c.notAfter) throw rt.mkThrowable("java/security/cert/CertificateExpiredException", "certificate expired: " + c.subject);
}
/** the trusted path leaf → root, or a CertificateException naming what broke */
async function verifyChain(chain: JX509[]): Promise<JX509[]> {
  if (!chain.length || chain.some((c) => !c.der.length)) throw certErr("empty or unparsed certificate chain");
  const store = await systemAnchors();
  const path: JX509[] = [];
  let cur = chain[0];
  for (let depth = 0; depth < 16; depth++) {
    checkValidity(cur);
    path.push(cur);
    const trusted = (store.get(cur.subjectDer) ?? []).some((a) => binary(a.der) === binary(cur.der));
    if (trusted) return path;
    const candidates = [...(store.get(cur.issuerDer) ?? []), ...chain.filter((c) => c.subjectDer === cur.issuerDer && !path.includes(c))];
    let issuer: JX509 | null = null;
    for (const c of candidates) if (await signed(cur, c)) { issuer = c; break; }
    if (!issuer) throw certErr("unable to find valid certification path to requested target: " + cur.subject);
    if (issuer.ext("basicConstraints")?.cA === false) throw certErr("issuer is not a CA: " + issuer.subject);
    if (store.has(issuer.subjectDer) && store.get(issuer.subjectDer)!.includes(issuer)) { checkValidity(issuer); path.push(issuer); return path; }
    cur = issuer;
  }
  throw certErr("certification path too long");
}
const chainOf = (arr: unknown[] | null) => (arr ?? []).filter((c): c is JX509 => c instanceof JX509);

class JPrincipal extends JObj { name = ""; der = ""; }
export function mkPrincipal(name: string, der = ""): JPrincipal { const p = rt.make("javax/security/auth/x500/X500Principal") as JPrincipal; p.name = name; p.der = der; return p; }
rt.markers("java/security/Principal");
rt.register({
  name: "javax/security/auth/x500/X500Principal", ctor: JPrincipal, ifaces: ["java/security/Principal"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JPrincipal, dn: string) { this.name = dn; },
    "getName()Ljava/lang/String;": function (this: JPrincipal) { return this.name; },
    "getName(Ljava/lang/String;)Ljava/lang/String;": function (this: JPrincipal) { return this.name; },
    "getEncoded()[B": function (this: JPrincipal) { return i8(bytes(this.der)); },
    "toString()Ljava/lang/String;": function (this: JPrincipal) { return this.name; },
    "equals(Ljava/lang/Object;)Z": function (this: JPrincipal, o: unknown) { return o instanceof JPrincipal && o.name === this.name ? 1 : 0; },
    "hashCode()I": function (this: JPrincipal) { return stringHash(this.name); },
  },
});

rt.register({
  name: "java/security/cert/Certificate", ctor: class extends JObj {},
  methods: { "getType()Ljava/lang/String;": () => "X.509" },
});
const date = (ms: number) => { const d = rt.make("java/util/Date") as JDate; d.t = ms; return d; };
rt.register({
  name: "java/security/cert/X509Certificate", ctor: JX509, sup: "java/security/cert/Certificate",
  methods: {
    "getSubjectAlternativeNames()Ljava/util/Collection;": function (this: JX509) {
      // Collection<List<?>> whose first element is an INTEGER: Kotlin's Intrinsics.areEqual calls
      // .equals() on it, and a raw JS number has no such method
      const names: { type: number; value: string; ip?: string }[] = this.der.length ? this.ext("subjectAltName")?.altNames ?? [] : [{ type: 2, value: this.host }];
      return newArrayList(names.map((n) => newArrayList([boxInt(n.type), n.ip ?? n.value])));
    },
    "getSubjectDN()Ljava/security/Principal;": function (this: JX509) { return mkPrincipal(this.der.length ? this.subject : "CN=" + this.host); },
    "getIssuerDN()Ljava/security/Principal;": function (this: JX509) { return mkPrincipal(this.der.length ? this.issuer : "CN=webdroid relay"); },
    "getSubjectX500Principal()Ljavax/security/auth/x500/X500Principal;": function (this: JX509) { return mkPrincipal(this.der.length ? this.subject : "CN=" + this.host, this.subjectDer); },
    "getIssuerX500Principal()Ljavax/security/auth/x500/X500Principal;": function (this: JX509) { return mkPrincipal(this.der.length ? this.issuer : "CN=webdroid relay", this.issuerDer); },
    "getEncoded()[B": function (this: JX509) { return i8(this.der); },
    "getPublicKey()Ljava/security/PublicKey;": function (this: JX509) {
      if (!this.der.length) return null;
      const k = this.keyOid === RSA_OID ? new JRsaPublicKey() : new JX509Key();
      k.encoded = this.spki;
      return k;
    },
    "getSerialNumber()Ljava/math/BigInteger;": function (this: JX509) { return this.der.length ? newObj("java/math/BigInteger", "(Ljava/lang/String;I)V", this.serial, 16) : null; },
    "getVersion()I": function (this: JX509) { return this.version; },
    "getNotBefore()Ljava/util/Date;": function (this: JX509) { return date(this.notBefore); },
    "getNotAfter()Ljava/util/Date;": function (this: JX509) { return date(this.notAfter); },
    "checkValidity()V": function (this: JX509) { if (this.der.length) checkValidity(this); },
    "checkValidity(Ljava/util/Date;)V": function (this: JX509, d: JDate) { if (this.der.length) checkValidity(this, d.t); },
    "getSigAlgOID()Ljava/lang/String;": function (this: JX509) { return this.sigOid; },
    "getSigAlgName()Ljava/lang/String;": function (this: JX509) { const a = SIG[this.sigOid]; return a ? `${SIG_NAME[a.hash]}with${a.name === "ECDSA" ? "ECDSA" : "RSA"}` : this.sigOid; },
    "getSignature()[B": function (this: JX509) { return i8(this.sig); },
    "getTBSCertificate()[B": function (this: JX509) { return i8(this.tbs); },
    "getBasicConstraints()I": function (this: JX509) { const b = this.ext("basicConstraints"); return b?.cA ? (b.pathLenConstraint ?? 0x7fffffff) : -1; },
    "getKeyUsage()[Z": function (this: JX509) {
      const k = this.ext("keyUsage");
      return k ? Uint8Array.from(["digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement", "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"], (n) => k[n] ? 1 : 0) : null;
    },
    "getExtendedKeyUsage()Ljava/util/List;": function (this: JX509) {
      const e = this.ext("extKeyUsage");
      if (!e) return null;
      const oids: Record<string, string> = { serverAuth: "1.3.6.1.5.5.7.3.1", clientAuth: "1.3.6.1.5.5.7.3.2", codeSigning: "1.3.6.1.5.5.7.3.3", emailProtection: "1.3.6.1.5.5.7.3.4", timeStamping: "1.3.6.1.5.5.7.3.8" };
      return newArrayList(Object.keys(oids).filter((k) => e[k]).map((k) => oids[k]));
    },
    "getCriticalExtensionOIDs()Ljava/util/Set;": function (this: JX509) { return vcall(rt.link("java/util/HashSet").ctor, "<init>", "()V"); },
    "hasUnsupportedCriticalExtension()Z": () => 0,
    "verify(Ljava/security/PublicKey;)V": async function (this: JX509, key: JRsaPublicKey | JX509Key) {
      const issuer = new JX509(); issuer.spki = key.encoded; issuer.keyOid = key instanceof JRsaPublicKey ? RSA_OID : EC_OID;
      if (issuer.keyOid === EC_OID) { const f = await forge(); const alg = (f.asn1.fromDer(binary(key.encoded)).value as Node[])[0].value as Node[]; issuer.curve = f.asn1.derToOid(alg[1].value as string); }
      if (!(await signed(this, issuer))) throw rt.mkThrowable("java/security/SignatureException", "signature does not verify");
    },
    "equals(Ljava/lang/Object;)Z": function (this: JX509, o: unknown) { return o instanceof JX509 && (this.der.length ? binary(o.der) === binary(this.der) : o === this) ? 1 : 0; },
    "hashCode()I": function (this: JX509) { return stringHash(binary(this.der)); },
    "getType()Ljava/lang/String;": () => "X.509",
    "toString()Ljava/lang/String;": function (this: JX509) { return this.der.length ? `[subject=${this.subject}, issuer=${this.issuer}]` : "CN=" + this.host + " (webdroid relay)"; },
  },
});

const isPem = (b: Uint8Array) => b[0] === 0x2d;
async function certsFrom(stream: unknown): Promise<JX509[]> {
  const b = await readStreamFully(stream);
  if (!b.length) throw certErr("empty input");
  return isPem(b) ? fromPem(new TextDecoder().decode(b)) : [await parseX509(b)];
}
defineException("java/security/SignatureException", "java/security/GeneralSecurityException");
function certFactory(type: string) {
  if (type?.toUpperCase() !== "X.509") throw certErr(type + " not available");
  return rt.make("java/security/cert/CertificateFactory");
}
rt.markers("java/security/cert/CertificateFactorySpi");
rt.register({
  name: "java/security/cert/CertificateFactory", ctor: class extends JObj {},
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/security/cert/CertificateFactory;": certFactory,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljava/security/cert/CertificateFactory;": certFactory,
    "getType()Ljava/lang/String;": () => "X.509",
    "generateCertificate(Ljava/io/InputStream;)Ljava/security/cert/Certificate;": async (s: unknown) => (await certsFrom(s))[0],
    "generateCertificates(Ljava/io/InputStream;)Ljava/util/Collection;": async (s: unknown) => newArrayList(await certsFrom(s)),
  },
});

// ── trust: the default manager verifies against the system anchors
class JTMF extends JObj {}
const acceptedIssuers = async () => jarray([...(await systemAnchors()).values()].flat(), "Ljava/security/cert/X509Certificate;");
rt.register({
  name: "javax/net/ssl/TrustManagerFactory", ctor: JTMF,
  methods: {
    "static getDefaultAlgorithm()Ljava/lang/String;": () => "PKIX",
    "static getInstance(Ljava/lang/String;)Ljavax/net/ssl/TrustManagerFactory;": () => new JTMF(),
    "init(Ljava/security/KeyStore;)V": () => {},
    "getTrustManagers()[Ljavax/net/ssl/TrustManager;": () => jarray([rt.make("webdroid/X509TM")], "Ljavax/net/ssl/TrustManager;"),
  },
});
rt.register({
  name: "webdroid/X509TM", ctor: class extends JObj {}, ifaces: ["javax/net/ssl/X509TrustManager", "javax/net/ssl/TrustManager"],
  methods: {
    "checkClientTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V": () => {},
    "checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V": async (chain: unknown[]) => { await verifyChain(chainOf(chain)); },
    "checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;Ljava/lang/String;)Ljava/util/List;": async (chain: unknown[]) => newArrayList(await verifyChain(chainOf(chain))),
    "getAcceptedIssuers()[Ljava/security/cert/X509Certificate;": acceptedIssuers,
  },
});
rt.register({
  name: "android/net/http/X509TrustManagerExtensions", ctor: class extends JObj { tm: unknown = null; },
  methods: {
    "<init>(Ljavax/net/ssl/X509TrustManager;)V": function (this: { tm: unknown }, tm: unknown) { this.tm = tm; },
    // the platform verifier walks the chain; hostname and pins are the caller's (Cronet checks both natively)
    "checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;Ljava/lang/String;)Ljava/util/List;": async (chain: unknown[]) => newArrayList(await verifyChain(chainOf(chain))),
    "checkServerTrusted([Ljava/security/cert/X509Certificate;[B[BLjava/lang/String;Ljava/lang/String;)Ljava/util/List;": async (chain: unknown[]) => newArrayList(await verifyChain(chainOf(chain))),
    "isUserAddedCertificate(Ljava/security/cert/X509Certificate;)Z": () => 0,
    "isSameTrustConfiguration(Ljava/lang/String;Ljava/lang/String;)Z": () => 1,
  },
});
/** the AndroidCAStore KeyStore's view: every anchor under its system: alias */
export const caStoreMethods = {
  "aliases()Ljava/util/Enumeration;": async () => mkIter([...(await systemCaEntries()).keys()]),
  "size()I": async () => (await systemCaEntries()).size,
  "containsAlias(Ljava/lang/String;)Z": async (a: string) => (await systemCaEntries()).has(a) ? 1 : 0,
  "isCertificateEntry(Ljava/lang/String;)Z": async (a: string) => (await systemCaEntries()).has(a) ? 1 : 0,
  "isKeyEntry(Ljava/lang/String;)Z": () => 0,
  "getCertificate(Ljava/lang/String;)Ljava/security/cert/Certificate;": async (a: string) => (await systemCaEntries()).get(a) ?? null,
  "getCertificateAlias(Ljava/security/cert/Certificate;)Ljava/lang/String;": async (c: JX509) => {
    for (const [alias, cert] of await systemCaEntries()) if (binary(cert.der) === binary(c.der)) return alias;
    return null;
  },
};
