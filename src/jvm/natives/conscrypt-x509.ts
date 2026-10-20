// NativeCrypto's certificate natives: X509 handles, their fields, signature checks, the BIO
// streams conscrypt's CertificateFactory reads PEM and DER through, and PKCS#7/PkiPath bundles.

import { rt, driven, waits, type Gen, type JObj } from "../runtime.ts";
import { ownedHandle, handle, weakHandle, deref, release } from "../../android/handles.ts";
import { concat, i8, jarray, u8 } from "../abi.ts";
import { vcall } from "./jentry.ts";
import { boxInt } from "./jbox.ts";
import { nc, region, sslError, keyOf, newKey, parsing, type Key } from "./conscrypt.ts";
import { parseX509, X509, bitBooleans, basicConstraints, exFlags, generalNames, extKeyUsage, tbsWithout, nameRfc2253,
  KEY_USAGE, EXT_KEY_USAGE, SUBJECT_ALT_NAME, ISSUER_ALT_NAME, type Time } from "./x509.ts";
import { parsePublicKey, rsaPublic, rsaBytes, pkcs1SignPad, pssVerify, ecdsaVerify, digestNamed, bitLength, encodePoint, equal, EVP_PKEY_RSA, EVP_PKEY_EC } from "./pkey.ts";
import { children, parseOne, readTlv, oidToString, seq, oid, integer, tlv, bytesToBig, bigToBytes, DerError, orDer, SEQUENCE, INTEGER, type Tlv } from "./der.ts";
import { hashOf, sha1 } from "./digest.ts";

const X = "Lcom/android/org/conscrypt/OpenSSLX509Certificate;";
const x509Of = (h: bigint): X509 => {
  const x = deref<X509>(h);
  if (!(x instanceof X509)) throw rt.mkThrowable("java/lang/NullPointerException", "x509 == null");
  return x;
};
const ASN1 = 12;
const decodeError = () => sslError("java/lang/RuntimeException", ASN1, 109, "DECODE_ERROR");
const parse = (der: Uint8Array): X509 => orDer(() => parseX509(der), decodeError);
nc("d2i_X509([B)J", (b: Int8Array) => {
  return orDer(() => ownedHandle(parseX509(u8(b ?? rt.npe()))), () => parsing("Error reading X.509 data"));
});
nc(`X509_free(J${X})V`, (h: bigint) => release(h));
nc(`i2d_X509(J${X})[B`, (h: bigint) => i8(x509Of(h).der.slice()));
nc(`X509_get_version(J${X})J`, (h: bigint) => BigInt(x509Of(h).version));
nc(`X509_get_serialNumber(J${X})[B`, (h: bigint) => i8(x509Of(h).serial.slice()));
nc(`X509_get_issuer_name(J${X})[B`, (h: bigint) => i8(x509Of(h).issuer.slice()));
nc(`X509_get_subject_name(J${X})[B`, (h: bigint) => i8(x509Of(h).subject.slice()));
// the times are the certificate's own, alive while it is
nc(`X509_get_notBefore(J${X})J`, (h: bigint) => weakHandle(x509Of(h).notBefore));
nc(`X509_get_notAfter(J${X})J`, (h: bigint) => weakHandle(x509Of(h).notAfter));
nc("ASN1_TIME_to_Calendar(JLjava/util/Calendar;)V", (h: bigint, cal: JObj) => {
  const o = deref<WeakRef<Time> | Time>(h), t = o instanceof WeakRef ? o.deref() : o;
  if (!t?.fields) throw rt.mkThrowable("java/lang/NullPointerException", "asn1Time == null");
  const [y, mo, d, hh, mm, ss] = t.fields;
  return vcall(cal ?? rt.npe(), "set", "(IIIIII)V", y, mo - 1, d, hh, mm, ss);
});
nc(`get_X509_sig_alg_oid(J${X})Ljava/lang/String;`, (h: bigint) => x509Of(h).sigOid);
nc(`get_X509_sig_alg_parameter(J${X})[B`, (h: bigint) => { const p = x509Of(h).sigParams; return p ? i8(p.slice()) : null; });
nc(`get_X509_signature(J${X})[B`, (h: bigint) => i8(x509Of(h).signature.slice()));
nc(`get_X509_tbs_cert(J${X})[B`, (h: bigint) => i8(x509Of(h).tbs.slice()));
nc(`get_X509_tbs_cert_without_ext(J${X}Ljava/lang/String;)[B`, (h: bigint, _c: JObj, o: string) => i8(tbsWithout(x509Of(h), o)));
nc(`i2d_X509_PUBKEY(J${X})[B`, (h: bigint) => i8(x509Of(h).spki.slice()));
nc(`get_X509_pubkey_oid(J${X})Ljava/lang/String;`, (h: bigint) => oidToString(children(children(parseOne(x509Of(h).spki).body)[0].body)[0].body));
nc(`X509_get_pubkey(J${X})J`, (h: bigint) => {
  return orDer(() => newKey(parsePublicKey(x509Of(h).spki)), (e) => /unsupported|unknown curve/.test(e.message)
    ? rt.mkThrowable("java/security/NoSuchAlgorithmException", "X509_get_pubkey") : sslError("java/security/InvalidKeyException", ASN1, 109, "DECODE_ERROR"));
});
nc(`get_X509_issuerUID(J${X})[Z`, (h: bigint) => { const u = x509Of(h).issuerUid; return u ? Uint8Array.from(bitBooleans(u), Number) : null; });
nc(`get_X509_subjectUID(J${X})[Z`, (h: bigint) => { const u = x509Of(h).subjectUid; return u ? Uint8Array.from(bitBooleans(u), Number) : null; });
nc(`get_X509_ext_oids(J${X}I)[Ljava/lang/String;`, (h: bigint, _c: JObj, critical: number) =>
  jarray(x509Of(h).exts.filter((e) => e.critical === (critical === 1)).map((e) => e.oid), "Ljava/lang/String;"));
nc(`X509_get_ext_oid(J${X}Ljava/lang/String;)[B`, (h: bigint, _c: JObj, o: string) => {
  const e = x509Of(h).ext(o);
  return e ? i8(tlv(4, e.value)) : null;
});
const decoded = <T>(f: () => T): T => orDer(f, decodeError);
nc(`get_X509_ex_kusage(J${X})[Z`, (h: bigint) => {
  const e = x509Of(h).ext(KEY_USAGE);
  return e ? decoded(() => Uint8Array.from(bitBooleans(parseOne(e.value, 3).body), Number)) : null;
});
nc(`get_X509_ex_xkusage(J${X})[Ljava/lang/String;`, (h: bigint) => {
  const e = x509Of(h).ext(EXT_KEY_USAGE);
  return e ? jarray(decoded(() => extKeyUsage(e.value)), "Ljava/lang/String;") : null;
});
nc(`get_X509_ex_pathlen(J${X})I`, (h: bigint) => decoded(() => basicConstraints(x509Of(h)))?.pathLen ?? -1);
nc(`get_X509_ex_flags(J${X})I`, (h: bigint) => {
  const x = x509Of(h);
  return exFlags(x, () => { try { return verify(x, parsePublicKey(x.spki)) === null; } catch { return false; } });
});
// Object[][]: (Integer type, value) per name, as get_X509_GENERAL_NAME_stack answers
nc(`get_X509_GENERAL_NAME_stack(J${X}I)[[Ljava/lang/Object;`, (h: bigint, _c: JObj, type: number) => {
  const e = x509Of(h).ext(type === 1 ? SUBJECT_ALT_NAME : ISSUER_ALT_NAME);
  if (!e) return null;
  const names = decoded(() => generalNames(e.value));
  if (!names.length) return null;
  return jarray(names.map(([t, v]) => jarray([boxInt(t), typeof v === "string" ? v : i8(v)], "Ljava/lang/Object;")), "[Ljava/lang/Object;");
});
// X509_cmp: SHA-1 of the encodings first, then the encodings
nc(`X509_cmp(J${X}J${X})I`, (a: bigint, _x: JObj, b: bigint) => {
  const da = x509Of(a).der, db = x509Of(b).der;
  const cmp = (p: Uint8Array, q: Uint8Array) => { for (let i = 0; i < Math.min(p.length, q.length); i++) if (p[i] !== q[i]) return p[i] - q[i]; return p.length - q.length; };
  return cmp(sha1(da), sha1(db)) || cmp(da, db);
});

// signature algorithms a certificate names
const SIG_ALGS: Record<string, { md: string; kind: "rsa" | "ec" | "pss" }> = {
  "1.2.840.113549.1.1.4": { md: "md5", kind: "rsa" }, "1.2.840.113549.1.1.5": { md: "sha1", kind: "rsa" }, "1.2.840.113549.1.1.14": { md: "sha224", kind: "rsa" },
  "1.2.840.113549.1.1.11": { md: "sha256", kind: "rsa" }, "1.2.840.113549.1.1.12": { md: "sha384", kind: "rsa" }, "1.2.840.113549.1.1.13": { md: "sha512", kind: "rsa" },
  "1.2.840.10045.4.1": { md: "sha1", kind: "ec" }, "1.2.840.10045.4.3.1": { md: "sha224", kind: "ec" }, "1.2.840.10045.4.3.2": { md: "sha256", kind: "ec" },
  "1.2.840.10045.4.3.3": { md: "sha384", kind: "ec" }, "1.2.840.10045.4.3.4": { md: "sha512", kind: "ec" }, "1.2.840.113549.1.1.10": { md: "", kind: "pss" },
};
const HASH_OIDS: Record<string, string> = { "1.3.14.3.2.26": "sha1", "2.16.840.1.101.3.4.2.4": "sha224", "2.16.840.1.101.3.4.2.1": "sha256", "2.16.840.1.101.3.4.2.2": "sha384", "2.16.840.1.101.3.4.2.3": "sha512" };
/** RSASSA-PSS-params: the hash, MGF1 hash and salt length (defaults SHA-1, SHA-1, 20) */
function pssParams(p: Uint8Array | null): { md: string; mgf: string; salt: number } {
  const out = { md: "sha1", mgf: "sha1", salt: 20 };
  if (!p) return out;
  for (const t of children(parseOne(p, SEQUENCE).body)) {
    const inner = readTlv(t.body);
    if (t.tag === 0xa0) out.md = HASH_OIDS[oidToString(children(inner.body)[0].body)] ?? "";
    else if (t.tag === 0xa1) out.mgf = HASH_OIDS[oidToString(children(children(inner.body)[1].body)[0].body)] ?? "";
    else if (t.tag === 0xa2) out.salt = Number(bytesToBig(inner.body));
  }
  if (!out.md || !out.mgf) throw new DerError("unsupported PSS hash");
  return out;
}
/** null when `issuerKey` signed `x`, else the exception conscrypt would raise */
function verify(x: X509, key: Key): JObj | null {
  const alg = SIG_ALGS[x.sigOid];
  if (!alg) return sslError("java/security/cert/CertificateException", ASN1, 150, "UNKNOWN_SIGNATURE_ALGORITHM");
  const wrong = () => sslError("java/security/InvalidKeyException", ASN1, 189, "WRONG_PUBLIC_KEY_TYPE");
  if ("wrapper" in key) return wrong();
  if (alg.kind === "ec") {
    if (key.type !== EVP_PKEY_EC) return wrong();
    return ecdsaVerify(key.ec.curve, key.ec.pub, hashOf(alg.md, x.tbs), x.signature) ? null : sslError("java/security/SignatureException", 26, 100, "BAD_SIGNATURE");
  }
  if (key.type !== EVP_PKEY_RSA) return wrong();
  const r = key.rsa, n = rsaBytes(r), s = x.signature;
  if (s.length !== n || bytesToBig(s) >= r.n) return sslError("javax/crypto/BadPaddingException", 4, 145, "WRONG_SIGNATURE_LENGTH");
  const em = bigToBytes(rsaPublic(r, bytesToBig(s)), n);
  if (alg.kind === "pss") {
    const p = pssParams(x.sigParams);
    return pssVerify(hashOf(p.md, x.tbs), em, bitLength(r.n) - 1, digestNamed(p.md), digestNamed(p.mgf), p.salt) ? null : sslError("javax/crypto/BadPaddingException", 4, 138, "SLEN_CHECK_FAILED");
  }
  const want = pkcs1SignPad(n, alg.md, hashOf(alg.md, x.tbs));
  if (want && equal(want, em)) return null;
  return em[0] === 0 && em[1] === 1 ? sslError("javax/crypto/BadPaddingException", 4, 105, "BAD_SIGNATURE") : sslError("javax/crypto/BadPaddingException", 4, 107, "BLOCK_TYPE_IS_NOT_01");
}
nc(`X509_verify(J${X}Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)V`, (h: bigint, _c: JObj, ref: JObj) => {
  const e = decoded(() => verify(x509Of(h), keyOf(ref)));
  if (e) throw e;
});
nc(`X509_check_issued(J${X}J${X})I`, (issuerH: bigint, _a: JObj, subjectH: bigint) => {
  const issuer = x509Of(issuerH), subject = x509Of(subjectH);
  if (!equal(issuer.subject, subject.issuer)) return 29; // X509_V_ERR_SUBJECT_ISSUER_MISMATCH
  const ku = issuer.ext(KEY_USAGE);
  if (ku && !bitBooleans(parseOne(ku.value, 3).body)[5]) return 32; // X509_V_ERR_KEYUSAGE_NO_CERTSIGN
  return 0;
});

// ── BIOs over Java streams
/** a BIO over a Java stream, which the native reading it reads on its own thread */
type Bio = { in?: JObj; out?: JObj; eof?: boolean };
const bioOf = (h: bigint): Bio => { const b = deref<Bio>(h); if (!b) throw rt.mkThrowable("java/lang/NullPointerException", "bio == null"); return b; };
nc("create_BIO_InputStream(Lcom/android/org/conscrypt/OpenSSLBIOInputStream;Z)J", (s: JObj) => handle({ in: s ?? rt.npe() } satisfies Bio));
nc("create_BIO_OutputStream(Ljava/io/OutputStream;)J", (s: JObj) => handle({ out: s ?? rt.npe() } satisfies Bio));
nc("BIO_free_all(J)V", (h: bigint) => release(h));
/** exactly `n` bytes, or fewer at the end of the stream */
function* readExact(b: Bio, n: number): Gen<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const buf = new Int8Array(n - got), r: number = yield vcall(b.in, "read", "([B)I", buf);
    if (r <= 0) break;
    out.set(u8(buf).subarray(0, r), got); got += r;
  }
  return out.subarray(0, got);
}
/** one DER element, read no further than its end */
function* readDer(b: Bio): Gen<Uint8Array> {
  const head = yield* readExact(b, 2);
  if (head.length < 2) throw decodeError();
  let lenBytes = new Uint8Array(0), len = head[1];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw decodeError();
    lenBytes = yield* readExact(b, n);
    if (lenBytes.length < n) throw decodeError();
    len = Number(bytesToBig(lenBytes));
  }
  const body = yield* readExact(b, len);
  if (body.length < len) throw decodeError();
  return concat([head, lenBytes, body]);
}
/** the next non-empty line; OpenSSLBIOInputStream.gets drops the newline and fills the buffer at most */
function* readLine(b: Bio): Gen<string | null> {
  let line = "";
  for (;;) {
    const buf = new Int8Array(1024), r: number = yield vcall(b.in, "gets", "([B)I", buf);
    if (r <= 0) return line || null;
    line += String.fromCharCode(...u8(buf).subarray(0, r));
    if (r < buf.length) return line;
  }
}
/** the body of the next PEM block with one of `labels`, skipping other text and blocks */
function* readPem(b: Bio, labels: string[]): Gen<Uint8Array> {
  let label: string | null = null, body = "";
  for (;;) {
    const line = yield* readLine(b);
    if (line === null) throw sslError("java/lang/RuntimeException", 9, 110, "NO_START_LINE");
    const t = line.trim();
    if (label === null) { const m = /^-----BEGIN (.+)-----$/.exec(t); if (m && labels.includes(m[1])) label = m[1]; continue; }
    if (t === `-----END ${label}-----`) break;
    if (!t.includes(":")) body += t;
  }
  try { return Uint8Array.fromBase64(body); } catch { throw sslError("java/lang/RuntimeException", 9, 100, "BAD_BASE64_DECODE"); }
}
const CERT_LABELS = ["CERTIFICATE", "X509 CERTIFICATE"];
nc("d2i_X509_bio(J)J", driven(function* (h: bigint): Gen { return ownedHandle(parse(yield* readDer(bioOf(h)))); }));
nc("PEM_read_bio_X509(J)J", driven(function* (h: bigint): Gen { return ownedHandle(parse(yield* readPem(bioOf(h), CERT_LABELS))); }));
nc("PEM_read_bio_PUBKEY(J)J", driven(function* (h: bigint): Gen {
  const der = yield* readPem(bioOf(h), ["PUBLIC KEY"]);
  return decoded(() => newKey(parsePublicKey(der)));
}));
nc("BIO_read(J[B)I", driven(function* (h: bigint, buf: Int8Array): Gen { const r = yield* readExact(bioOf(h), buf.length); region(buf, 0, r.length).set(r); return r.length; }));
nc("BIO_write(J[BII)V", waits((h: bigint, buf: Int8Array, off: number, len: number) => vcall(bioOf(h).out, "write", "([BII)V", buf, off, len)));

// ── certificate bundles: PkiPath (SEQUENCE OF Certificate) and PKCS#7 SignedData's certificates
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2", OID_DATA = "1.2.840.113549.1.7.1";
const handles = (xs: X509[]) => BigInt64Array.from(xs, (x) => ownedHandle(x));
nc("ASN1_seq_pack_X509([J)[B", (hs: BigInt64Array) => i8(seq(...Array.from(hs, (h) => x509Of(h).der))));
nc("ASN1_seq_unpack_X509_bio(J)[J", driven(function* (h: bigint): Gen {
  const der = yield* readDer(bioOf(h));
  return handles(decoded(() => children(parseOne(der, SEQUENCE).body).map((t) => parse(t.raw.slice()))));
}));
nc("i2d_PKCS7([J)[B", (hs: BigInt64Array) => {
  const certs = Array.from(hs, (h) => x509Of(h).der);
  const signed = seq(integer(1n), tlv(0x31, new Uint8Array(0)), seq(oid(OID_DATA)), tlv(0xa0, concat(certs)), tlv(0x31, new Uint8Array(0)));
  return i8(seq(oid(OID_SIGNED_DATA), tlv(0xa0, signed)));
});
const PKCS7_CERTS = 1;
function pkcs7Certs(der: Uint8Array, which: number): BigInt64Array {
  if (which !== PKCS7_CERTS) throw rt.mkThrowable("java/lang/RuntimeException", "CRLs in PKCS#7 are unsupported");
  return handles(decoded(() => {
    const [type, content] = children(parseOne(der, SEQUENCE).body);
    if (oidToString(type.body) !== OID_SIGNED_DATA || content?.tag !== 0xa0) throw new DerError("not SignedData");
    const certs = children(readTlv(content.body).body).find((t: Tlv) => t.tag === 0xa0);
    return certs ? children(certs.body).map((t) => parse(t.raw.slice())) : [];
  }));
}
nc("d2i_PKCS7_bio(JI)[J", driven(function* (h: bigint, which: number): Gen { return pkcs7Certs(yield* readDer(bioOf(h)), which); }));
nc("PEM_read_bio_PKCS7(JI)[J", driven(function* (h: bigint, which: number): Gen {
  return pkcs7Certs(yield* readPem(bioOf(h), ["PKCS7", "PKCS #7 SIGNED DATA", "CERTIFICATE"]), which);
}));

// ── the CBS/CBB reader and writer conscrypt's AlgorithmParameters encode through
const asn1Io = () => rt.mkThrowable("java/io/IOException", "Error reading ASN.1 encoding");
type Cbs = { b: Uint8Array; at: number };
const cbsOf = (h: bigint): Cbs => { const c = deref<Cbs>(h); if (!c?.b) throw rt.mkThrowable("java/lang/NullPointerException", "cbs == null"); return c; };
function next(h: bigint, tag: number): Uint8Array {
  const c = cbsOf(h);
  const t = orDer(() => readTlv(c.b, c.at), asn1Io);
  if (t.tag !== tag) throw asn1Io();
  c.at = t.end;
  return t.body;
}
nc("asn1_read_init([B)J", (b: Int8Array) => handle({ b: u8(b ?? rt.npe()).slice(), at: 0 } satisfies Cbs));
nc("asn1_read_free(J)V", (h: bigint) => release(h));
nc("asn1_read_sequence(J)J", (h: bigint) => handle({ b: next(h, SEQUENCE), at: 0 } satisfies Cbs));
// the tagged forms are context-specific and constructed: [n] EXPLICIT
nc("asn1_read_tagged(J)J", (h: bigint) => { const c = cbsOf(h); return handle({ b: next(h, (c.b[c.at] & 0xe0) === 0xa0 ? c.b[c.at] : -1), at: 0 } satisfies Cbs); });
nc("asn1_read_next_tag_is(JI)Z", (h: bigint, tag: number) => { const c = cbsOf(h); return +(c.at < c.b.length && c.b[c.at] === (0xa0 | tag)); });
nc("asn1_read_octetstring(J)[B", (h: bigint) => i8(next(h, 4).slice()));
nc("asn1_read_null(J)V", (h: bigint) => { if (next(h, 5).length) throw asn1Io(); });
nc("asn1_read_oid(J)Ljava/lang/String;", (h: bigint) => oidToString(next(h, 6)));
nc("asn1_read_uint64(J)J", (h: bigint) => {
  const b = next(h, INTEGER);
  if (!b.length || b[0] & 0x80 || b.length > 9 || (b.length === 9 && b[0] !== 0)) throw asn1Io();
  return BigInt.asIntN(64, bytesToBig(b));
});
nc("asn1_read_is_empty(J)Z", (h: bigint) => { const c = cbsOf(h); return +(c.at >= c.b.length); });
type Cbb = { tag: number | null; parts: (Uint8Array | Cbb)[] };
const cbbOf = (h: bigint): Cbb => { const c = deref<Cbb>(h); if (!c?.parts) throw rt.mkThrowable("java/lang/NullPointerException", "cbb == null"); return c; };
const encode = (c: Cbb): Uint8Array => { const body = concat(c.parts.map((p) => p instanceof Uint8Array ? p : encode(p))); return c.tag === null ? body : tlv(c.tag, body); };
const child = (h: bigint, tag: number) => { const c: Cbb = { tag, parts: [] }; cbbOf(h).parts.push(c); return handle(c); };
nc("asn1_write_init()J", () => handle({ tag: null, parts: [] } satisfies Cbb));
nc("asn1_write_sequence(J)J", (h: bigint) => child(h, SEQUENCE));
nc("asn1_write_tag(JI)J", (h: bigint, tag: number) => child(h, 0xa0 | tag));
nc("asn1_write_octetstring(J[B)V", (h: bigint, b: Int8Array) => { cbbOf(h).parts.push(tlv(4, u8(b ?? rt.npe()))); });
nc("asn1_write_uint64(JJ)V", (h: bigint, v: bigint) => { cbbOf(h).parts.push(integer(BigInt.asUintN(64, v))); });
nc("asn1_write_null(J)V", (h: bigint) => { cbbOf(h).parts.push(Uint8Array.of(5, 0)); });
nc("asn1_write_oid(JLjava/lang/String;)V", (h: bigint, o: string) => { cbbOf(h).parts.push(oid(o ?? rt.npe())); });
nc("asn1_write_flush(J)V", (h: bigint) => { cbbOf(h); });
nc("asn1_write_finish(J)[B", (h: bigint) => i8(encode(cbbOf(h))));
nc("asn1_write_cleanup(J)V", (h: bigint) => { cbbOf(h).parts.length = 0; });
nc("asn1_write_free(J)V", (h: bigint) => release(h));

// ── the text form of keys and certificates (EVP_PKEY_print_*, X509_print_ex), as OpenSSL lays it out
const colonHex = (b: Uint8Array, indent: number, perLine = 15) => {
  const parts = b.toHex().match(/../g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += perLine) lines.push(" ".repeat(indent) + parts.slice(i, i + perLine).join(":") + (i + perLine < parts.length ? ":" : ""));
  return lines.join("\n");
};
const CURVE_NIST: Record<string, string> = { prime256v1: "P-256", secp384r1: "P-384", secp521r1: "P-521", secp224r1: "P-224" };
function printPublic(k: Key, indent: number): string {
  const pad = " ".repeat(indent);
  if ("wrapper" in k) return pad + "<opaque key>\n";
  if (k.type === EVP_PKEY_EC) {
    const c = k.ec.curve;
    return `${pad}Public-Key: (${CURVE_NIST[c.name] ?? bitLength(c.p) + " bit"})\n${pad}pub:\n${colonHex(encodePoint(c, k.ec.pub), indent + 4)}\n`;
  }
  if (k.type === EVP_PKEY_RSA) {
    const r = k.rsa, n = bigToBytes(r.n), mod = n[0] & 0x80 ? concat([Uint8Array.of(0), n]) : n;
    return `${pad}Public-Key: (${bitLength(r.n)} bit)\n${pad}Modulus:\n${colonHex(mod, indent + 4)}\n${pad}Exponent: ${r.e} (0x${r.e.toString(16)})\n`;
  }
  return `${pad}X25519 Public-Key:\n${pad}pub:\n${colonHex(k.pub, indent + 4)}\n`;
}
nc("EVP_PKEY_print_public(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)Ljava/lang/String;", (ref: JObj) => printPublic(keyOf(ref), 0));
nc("EVP_PKEY_print_params(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)Ljava/lang/String;", (ref: JObj) => {
  const k = keyOf(ref);
  return k.type === EVP_PKEY_EC ? `ECDSA-Parameters: (${bitLength((("wrapper" in k) ? k.curve! : k.ec.curve).p)} bit)\n` : "";
});
const SIG_NAMES: Record<string, string> = {
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption", "1.2.840.113549.1.1.5": "sha1WithRSAEncryption", "1.2.840.113549.1.1.14": "sha224WithRSAEncryption",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption", "1.2.840.113549.1.1.12": "sha384WithRSAEncryption", "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.113549.1.1.10": "rsassaPss", "1.2.840.10045.4.1": "ecdsa-with-SHA1", "1.2.840.10045.4.3.1": "ecdsa-with-SHA224",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256", "1.2.840.10045.4.3.3": "ecdsa-with-SHA384", "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
};
const KEY_NAMES: Record<string, string> = { "1.2.840.113549.1.1.1": "rsaEncryption", "1.2.840.10045.2.1": "id-ecPublicKey", "1.3.101.110": "X25519" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const timeText = ({ fields: [y, mo, d, h, mi, s] }: Time) =>
  `${MONTHS[mo - 1]} ${String(d).padStart(2)} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")} ${y} GMT`;
/** a name as XN_FLAG_ONELINE-style "C=.., O=.., CN=..": first RDN first, ", " between attributes */
const oneLine = (name: Uint8Array) => nameRfc2253(name).split(/(?<!\\)[,+]/).reverse().map((a) => a.replace(/\\(.)/g, "$1")).join(", ");
const EKU_NAMES: Record<string, string> = { "1.3.6.1.5.5.7.3.1": "TLS Web Server Authentication", "1.3.6.1.5.5.7.3.2": "TLS Web Client Authentication",
  "1.3.6.1.5.5.7.3.3": "Code Signing", "1.3.6.1.5.5.7.3.4": "E-mail Protection", "1.3.6.1.5.5.7.3.8": "Time Stamping", "1.3.6.1.5.5.7.3.9": "OCSP Signing" };
const KU_NAMES = ["Digital Signature", "Non Repudiation", "Key Encipherment", "Data Encipherment", "Key Agreement", "Certificate Sign", "CRL Sign", "Encipher Only", "Decipher Only"];
const upperHex = (b: Uint8Array) => (b.toHex().toUpperCase().match(/../g) ?? []).join(":");
const GN_PREFIX: Record<number, string> = { 1: "email", 2: "DNS", 6: "URI", 7: "IP Address", 4: "DirName", 8: "Registered ID" };
function extensionText(oidText: string, value: Uint8Array): [string, string] | null {
  switch (oidText) {
    case SUBJECT_ALT_NAME: case ISSUER_ALT_NAME:
      return [oidText === SUBJECT_ALT_NAME ? "X509v3 Subject Alternative Name" : "X509v3 Issuer Alternative Name",
        generalNames(value).map(([t, v]) => typeof v === "string" ? `${GN_PREFIX[t]}:${v}` : "othername:<unsupported>").join(", ")];
    case EXT_KEY_USAGE: return ["X509v3 Extended Key Usage", extKeyUsage(value).map((o) => EKU_NAMES[o] ?? o).join(", ")];
    case KEY_USAGE: return ["X509v3 Key Usage", bitBooleans(parseOne(value, 3).body).flatMap((b, i) => b && KU_NAMES[i] ? [KU_NAMES[i]] : []).join(", ")];
    case "2.5.29.19": {
      const parts = children(parseOne(value, SEQUENCE).body);
      const ca = parts.some((p) => p.tag === 1 && p.body[0] !== 0), len = parts.find((p) => p.tag === INTEGER);
      return ["X509v3 Basic Constraints", `CA:${ca ? "TRUE" : "FALSE"}${len ? `, pathlen:${bytesToBig(len.body)}` : ""}`];
    }
    case "2.5.29.14": return ["X509v3 Subject Key Identifier", upperHex(parseOne(value, 4).body)];
    case "2.5.29.35": {
      const id = children(parseOne(value, SEQUENCE).body).find((t) => t.tag === 0x80);
      return ["X509v3 Authority Key Identifier", id ? `keyid:${upperHex(id.body)}` : ""];
    }
  }
  return null;
}
nc(`X509_print_ex(JJ${X}JJ)V`, (bio: bigint, h: bigint) => {
  const x = x509Of(h), b = bioOf(bio);
  const serial = bytesToBig(x.serial), keyAlg = oidToString(children(children(parseOne(x.spki).body)[0].body)[0].body);
  let key: string;
  try { key = printPublic(parsePublicKey(x.spki), 16); } catch { key = "                Unable to load Public Key\n"; }
  const exts = x.exts.map((e) => {
    let t: [string, string] | null = null;
    try { t = extensionText(e.oid, e.value); } catch { t = null; }
    const [name, text] = t ?? [e.oid, colonHex(e.value, 0, 18).replace(/\n/g, "\n                ")];
    return `            ${name}: ${e.critical ? "critical" : ""}\n                ${text}\n`;
  }).join("");
  const sigName = SIG_NAMES[x.sigOid] ?? x.sigOid;
  const text = "Certificate:\n    Data:\n"
    + `        Version: ${x.version + 1} (0x${x.version.toString(16)})\n`
    + (x.serial.length <= 8 && !(x.serial[0] & 0x80) ? `        Serial Number: ${serial} (0x${serial.toString(16)})\n`
      : `        Serial Number:\n${colonHex(x.serial[0] === 0 && x.serial.length > 1 ? x.serial.subarray(1) : x.serial, 12, 20)}\n`)
    + `    Signature Algorithm: ${sigName}\n`
    + `        Issuer: ${oneLine(x.issuer)}\n        Validity\n            Not Before: ${timeText(x.notBefore)}\n            Not After : ${timeText(x.notAfter)}\n`
    + `        Subject: ${oneLine(x.subject)}\n        Subject Public Key Info:\n            Public Key Algorithm: ${KEY_NAMES[keyAlg] ?? keyAlg}\n${key}`
    + (x.exts.length ? `        X509v3 extensions:\n${exts}\n` : "")
    + `    Signature Algorithm: ${sigName}\n${colonHex(x.signature, 9, 18)}\n`;
  const bytes = new TextEncoder().encode(text);
  return vcall(b.out, "write", "([BII)V", i8(bytes), 0, bytes.length);
});
