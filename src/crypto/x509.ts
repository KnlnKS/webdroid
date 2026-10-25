// X.509 certificates (RFC 5280) as BoringSSL parses them for conscrypt's natives: the raw fields,
// the extensions it caches (key usage, basic constraints, ...), and names printed per RFC 2253; and
// the certificates KeyMint and the relay CA issue.

import { concat, sameBytes, utf8 } from "../jvm/abi.ts";
import {
  children, parseOne, readTlv, expect, oidToString, tlv, seq, oid, integer, bits, octets, derNull, DerError,
  SEQUENCE, INTEGER, BIT_STRING, OCTET_STRING, OID, BOOLEAN, type Tlv,
} from "./der.ts";
import { bytesToBig } from "./bigint.ts";
import { ecdsaSign, emsaEncode, rsaApply, marshalPublicKey, EVP_PKEY_EC, EVP_PKEY_RSA, type PKey } from "./pkey.ts";
import { sha256 } from "./digest.ts";

export type Extension = { oid: string; critical: boolean; value: Uint8Array; raw: Uint8Array };
export type Time = { ms: number; fields: [number, number, number, number, number, number] };
type Fields = {
  der: Uint8Array; tbs: Uint8Array; version: number; serial: Uint8Array; sigOid: string; sigParams: Uint8Array | null; signature: Uint8Array;
  issuer: Uint8Array; subject: Uint8Array; notBefore: Time; notAfter: Time; spki: Uint8Array; keyOid: string;
  issuerUid: Uint8Array | null; subjectUid: Uint8Array | null; exts: Extension[];
};
export interface X509 extends Readonly<Fields> {}
export class X509 {
  constructor(f: Fields) { Object.assign(this, f); }
  ext(oid: string) { return this.exts.find((e) => e.oid === oid); }
}
/** the signature algorithms a certificate may name: OpenSSL's name, the digest, and the key */
export const SIG_ALGS: Record<string, { name: string; md: string; kind: "rsa" | "ec" | "pss" }> = {
  "1.2.840.113549.1.1.4": { name: "md5WithRSAEncryption", md: "md5", kind: "rsa" }, "1.2.840.113549.1.1.5": { name: "sha1WithRSAEncryption", md: "sha1", kind: "rsa" },
  "1.2.840.113549.1.1.14": { name: "sha224WithRSAEncryption", md: "sha224", kind: "rsa" }, "1.2.840.113549.1.1.11": { name: "sha256WithRSAEncryption", md: "sha256", kind: "rsa" },
  "1.2.840.113549.1.1.12": { name: "sha384WithRSAEncryption", md: "sha384", kind: "rsa" }, "1.2.840.113549.1.1.13": { name: "sha512WithRSAEncryption", md: "sha512", kind: "rsa" },
  "1.2.840.113549.1.1.10": { name: "rsassaPss", md: "", kind: "pss" }, "1.2.840.10045.4.1": { name: "ecdsa-with-SHA1", md: "sha1", kind: "ec" },
  "1.2.840.10045.4.3.1": { name: "ecdsa-with-SHA224", md: "sha224", kind: "ec" }, "1.2.840.10045.4.3.2": { name: "ecdsa-with-SHA256", md: "sha256", kind: "ec" },
  "1.2.840.10045.4.3.3": { name: "ecdsa-with-SHA384", md: "sha384", kind: "ec" }, "1.2.840.10045.4.3.4": { name: "ecdsa-with-SHA512", md: "sha512", kind: "ec" },
};

function time(t: Tlv): Time {
  const s = new TextDecoder().decode(t.body);
  const m = t.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : t.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s) : null;
  if (!m) throw new DerError("bad time");
  let year = +m[1];
  if (t.tag === 0x17) year += year < 50 ? 2000 : 1900;
  const f: Time["fields"] = [year, +m[2], +m[3], +m[4], +m[5], +m[6]];
  return { ms: Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]), fields: f };
}
const algorithm = (t: Tlv) => {
  const [id, params] = children(expect(t, SEQUENCE).body);
  return { oid: oidToString(expect(id, OID).body), params: params?.raw ?? null };
};

export function parseX509(der: Uint8Array): X509 {
  const [tbsT, sigAlgT, sigT, ...rest] = children(parseOne(der, SEQUENCE).body);
  if (rest.length) throw new DerError("trailing data");
  const f = children(expect(tbsT, SEQUENCE).body);
  let i = 0, version = 0;
  if (f[0]?.tag === 0xa0) { version = Number(bytesToBig(expect(parseOne(f[0].body), INTEGER).body)); i = 1; }
  const serial = expect(f[i], INTEGER).body;
  const inner = algorithm(f[i + 1]), outer = algorithm(sigAlgT);
  if (inner.oid !== outer.oid) throw new DerError("signature algorithm mismatch");
  const [nb, na] = children(expect(f[i + 3], SEQUENCE).body);
  const sig = expect(sigT, BIT_STRING).body, spki = expect(f[i + 5], SEQUENCE);
  let issuerUid: Uint8Array | null = null, subjectUid: Uint8Array | null = null;
  const exts: Extension[] = [];
  for (const t of f.slice(i + 6)) {
    if (t.tag === 0x81) issuerUid = t.body;
    else if (t.tag === 0x82) subjectUid = t.body;
    else if (t.tag === 0xa3) {
      for (const e of children(expect(parseOne(t.body), SEQUENCE).body)) {
        const parts = children(expect(e, SEQUENCE).body);
        const critical = parts.length === 3 && expect(parts[1], BOOLEAN).body[0] !== 0;
        exts.push({ oid: oidToString(expect(parts[0], OID).body), critical, value: expect(parts[parts.length - 1], OCTET_STRING).body, raw: e.raw });
      }
    } else throw new DerError("unexpected field");
  }
  return new X509({
    der: der.slice(), tbs: tbsT.raw.slice(), version, serial: serial.slice(), sigOid: outer.oid, sigParams: outer.params, signature: sig.subarray(1).slice(),
    issuer: expect(f[i + 2], SEQUENCE).raw.slice(), subject: expect(f[i + 4], SEQUENCE).raw.slice(), notBefore: time(nb), notAfter: time(na),
    spki: spki.raw.slice(), keyOid: algorithm(children(spki.body)[0]).oid, issuerUid, subjectUid, exts,
  });
}
/** the certificates a PKCS #7 SignedData ContentInfo carries */
export function signedDataCertificates(der: Uint8Array): Uint8Array[] {
  const [type, content] = children(parseOne(der, SEQUENCE).body);
  if (oidToString(expect(type, OID).body) !== "1.2.840.113549.1.7.2" || content?.tag !== 0xa0) throw new DerError("not SignedData");
  const certs = children(readTlv(content.body).body).find((t) => t.tag === 0xa0);
  return certs ? children(certs.body).map((t) => t.raw) : [];
}

/** a BIT STRING's bits as booleans, its unused trailing bits left out (ASN1BitStringToBooleanArray) */
export function bitBooleans(bs: Uint8Array): boolean[] {
  const n = (bs.length - 1) * 8 - (bs.length > 1 ? bs[0] & 7 : 0), out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(((bs[1 + (i >> 3)] >> (7 - (i & 7))) & 1) === 1);
  return out;
}
export const KEY_USAGE = "2.5.29.15", EXT_KEY_USAGE = "2.5.29.37", BASIC_CONSTRAINTS = "2.5.29.19", SUBJECT_ALT_NAME = "2.5.29.17", ISSUER_ALT_NAME = "2.5.29.18";
export function basicConstraints(value: Uint8Array): { ca: boolean; pathLen: number } {
  let ca = false, pathLen = -1;
  for (const p of children(parseOne(value, SEQUENCE).body)) {
    if (p.tag === BOOLEAN) ca = p.body[0] !== 0;
    else if (p.tag === INTEGER) pathLen = Number(bytesToBig(p.body));
  }
  return { ca, pathLen };
}
export const keyUsageBits = (value: Uint8Array) => bitBooleans(parseOne(value, BIT_STRING).body);
// the extensions BoringSSL understands; any other critical one sets EXFLAG_CRITICAL
const SUPPORTED = new Set(["2.16.840.1.113730.1.1", KEY_USAGE, SUBJECT_ALT_NAME, BASIC_CONSTRAINTS, "2.5.29.30", "2.5.29.32", EXT_KEY_USAGE, "2.5.29.36",
  "2.5.29.54", "1.3.6.1.5.5.7.1.1", "1.3.6.1.5.5.7.1.14", "1.3.6.1.5.5.7.1.3", "1.3.6.1.5.5.7.1.7", "2.5.29.33"]);
const EXFLAG_BCONS = 0x1, EXFLAG_KUSAGE = 0x2, EXFLAG_XKUSAGE = 0x4, EXFLAG_CA = 0x10, EXFLAG_SI = 0x20, EXFLAG_V1 = 0x40, EXFLAG_CRITICAL = 0x200, EXFLAG_SS = 0x2000;
export function exFlags(x: X509, selfSigned: () => boolean): number {
  let flags = 0;
  const bce = x.ext(BASIC_CONSTRAINTS), bc = bce && basicConstraints(bce.value);
  if (x.version === 0) flags |= EXFLAG_V1;
  if (bc) { flags |= EXFLAG_BCONS; if (bc.ca) flags |= EXFLAG_CA; }
  if (x.ext(KEY_USAGE)) flags |= EXFLAG_KUSAGE;
  if (x.ext(EXT_KEY_USAGE)) flags |= EXFLAG_XKUSAGE;
  if (x.exts.some((e) => e.critical && !SUPPORTED.has(e.oid))) flags |= EXFLAG_CRITICAL;
  if (sameBytes(x.issuer, x.subject)) {
    flags |= EXFLAG_SI;
    if (selfSigned()) flags |= EXFLAG_SS;
    if (flags & EXFLAG_V1) flags |= EXFLAG_CA;
  }
  return flags;
}

// ── names
const SHORT: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.9": "street",
  "0.9.2342.19200300.100.1.25": "DC", "0.9.2342.19200300.100.1.1": "UID", "1.2.840.113549.1.9.1": "emailAddress", "2.5.4.5": "serialNumber",
  "2.5.4.4": "SN", "2.5.4.42": "GN", "2.5.4.12": "title", "2.5.4.43": "initials", "2.5.4.44": "generationQualifier", "2.5.4.46": "dnQualifier",
  "2.5.4.65": "pseudonym", "2.5.4.17": "postalCode", "2.5.4.15": "businessCategory", "1.3.6.1.4.1.311.60.2.1.3": "jurisdictionC",
};
const STRING_TAGS = new Set([0x0c, 0x13, 0x16, 0x14, 0x1e, 0x1c, 0x12, 0x1a]);
function stringValue(t: Tlv): string | null {
  if (t.tag === 0x1e) { let s = ""; for (let i = 0; i + 1 < t.body.length; i += 2) s += String.fromCharCode(t.body[i] << 8 | t.body[i + 1]); return s; }
  if (t.tag === 0x1c) { let s = ""; for (let i = 0; i + 3 < t.body.length; i += 4) s += String.fromCodePoint(t.body[i] << 24 | t.body[i + 1] << 16 | t.body[i + 2] << 8 | t.body[i + 3]); return s; }
  if (t.tag === 0x0c) return new TextDecoder().decode(t.body);
  return STRING_TAGS.has(t.tag) ? String.fromCharCode(...t.body) : null;
}
/** X509_NAME_print_ex as conscrypt prints names (XN_FLAG_RFC2253 without ESC_MSB or UTF8_CONVERT),
 *  read back as UTF-8: last RDN first, specials and control characters escaped, other characters
 *  below 256 written as one byte each, wider ones as \UXXXX or \WXXXXXXXX */
export function nameRfc2253(name: Uint8Array): string {
  const rdns = children(parseOne(name, SEQUENCE).body).map((rdn) => children(expect(rdn, 0x31).body).map((atv) => {
    const [type, value] = children(expect(atv, SEQUENCE).body);
    const o = oidToString(expect(type, OID).body), short = SHORT[o];
    const s = short ? stringValue(value) : null;
    if (s === null) return `${short ?? o}=#${value.raw.toHex()}`;
    const chars = [...s], bytes: number[] = [], ascii = (t: string) => { for (const ch of t) bytes.push(ch.charCodeAt(0)); };
    chars.forEach((ch, i) => {
      const c = ch.codePointAt(0)!;
      if (c > 0xffff) ascii("\\W" + c.toString(16).toUpperCase().padStart(8, "0"));
      else if (c > 0xff) ascii("\\U" + c.toString(16).toUpperCase().padStart(4, "0"));
      else if (c < 0x20 || c === 0x7f) ascii("\\" + c.toString(16).toUpperCase().padStart(2, "0"));
      else if (",+\"\\<>;".includes(ch) || (i === 0 && (ch === "#" || ch === " ")) || (i === chars.length - 1 && ch === " ")) ascii("\\" + ch);
      else bytes.push(c);
    });
    return `${short}=${new TextDecoder().decode(Uint8Array.from(bytes))}`;
  }).join("+"));
  return rdns.reverse().join(",");
}

// ── subjectAltName entries as conscrypt's GENERAL_NAME_to_jobject answers them
type GeneralName = [number, string | Uint8Array];
function ipText(b: Uint8Array): string | null {
  if (b.length === 4) return Array.from(b).join(".");
  if (b.length !== 16) return null;
  const g = Array.from({ length: 8 }, (_, i) => b[2 * i] << 8 | b[2 * i + 1]);
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) { let j = i; while (j < 8 && g[j] === 0) j++; if (j - i > bestLen) { best = i; bestLen = j - i; } i = j === i ? i + 1 : j; }
  const h = g.map((v) => v.toString(16));
  return best < 0 ? h.join(":") : h.slice(0, best).join(":") + "::" + h.slice(best + bestLen).join(":");
}
export function generalNames(value: Uint8Array): GeneralName[] {
  const out: GeneralName[] = [];
  for (const g of children(parseOne(value, SEQUENCE).body)) {
    const type = g.tag & 0x1f;
    if (type === 1 || type === 2 || type === 6) out.push([type, String.fromCharCode(...g.body)]);
    else if (type === 4) out.push([type, nameRfc2253(g.body)]);
    else if (type === 7) { const ip = ipText(g.body); if (ip) out.push([type, ip]); }
    else if (type === 8) out.push([type, oidToString(g.body)]);
    else out.push([type, g.raw.slice()]);
  }
  return out;
}
export const extKeyUsage = (value: Uint8Array) => children(parseOne(value, SEQUENCE).body).map((t) => oidToString(expect(t, OID).body));

/** the TBSCertificate without extension `oid` (the precertificate form CT signs) */
export function tbsWithout(x: X509, oid: string): Uint8Array {
  const f = children(parseOne(x.tbs, SEQUENCE).body);
  const parts = f.map((t) => {
    if (t.tag !== 0xa3) return t.raw;
    const kept = x.exts.filter((e) => e.oid !== oid).map((e) => e.raw);
    return kept.length ? tlv(0xa3, tlv(SEQUENCE, concat(kept))) : new Uint8Array(0);
  });
  return tlv(SEQUENCE, concat(parts));
}

// ── issuing
/** UTCTime through 2049 and GeneralizedTime after (RFC 5280 §4.1.2.5) */
export function derTime(ms: number): Uint8Array {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0"), y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y >= 1950 && y < 2050 ? tlv(0x17, utf8.enc.encode(p(y % 100) + rest)) : tlv(0x18, utf8.enc.encode(String(y).padStart(4, "0") + rest));
}
/** a Name of one UTF8String attribute per RDN, first RDN first */
export const x500Name = (attrs: [string, string][]) => seq(...attrs.map(([o, v]) => tlv(0x31, seq(oid(o), tlv(0x0c, utf8.enc.encode(v))))));
export const extension = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [tlv(BOOLEAN, [0xff])] : []), octets(value));
/** the critical keyUsage extension with bits `on` set (0 digitalSignature, 5 keyCertSign, ...) */
export function keyUsage(on: number[]): Uint8Array {
  const last = Math.max(-1, ...on), b = new Uint8Array(1 + ((last + 8) >> 3));
  for (const i of on) b[1 + (i >> 3)] |= 0x80 >> (i & 7);
  b[0] = last < 0 ? 0 : 7 - (last & 7);
  return extension(KEY_USAGE, true, tlv(BIT_STRING, b));
}
/** a v3 certificate for `key`, signed over SHA-256 by `signer`, or with an empty signature without one
 *  (as KeyMint issues for a key that may not sign); a bigint serial is encoded, bytes are its content */
export function buildCertificate(c: { serial: bigint | Uint8Array; issuer: Uint8Array; subject: Uint8Array; notBefore: number; notAfter: number; key: PKey; exts: Uint8Array[]; signer: PKey | null }): Uint8Array {
  const by = c.signer ?? c.key, sigAlg = by.type === EVP_PKEY_EC ? seq(oid("1.2.840.10045.4.3.2")) : seq(oid("1.2.840.113549.1.1.11"), derNull());
  const tbs = seq(tlv(0xa0, integer(2n)), typeof c.serial === "bigint" ? integer(c.serial) : tlv(INTEGER, c.serial), sigAlg, c.issuer,
    seq(derTime(c.notBefore), derTime(c.notAfter)), c.subject, marshalPublicKey(c.key), tlv(0xa3, seq(...c.exts)));
  return seq(tbs, sigAlg, bits(c.signer ? signatureOver(c.signer, tbs) : new Uint8Array(0)));
}
function signatureOver(s: PKey, tbs: Uint8Array): Uint8Array {
  const d = sha256(tbs);
  if (s.type === EVP_PKEY_EC) return ecdsaSign(s.ec.curve, s.ec.priv!, d);
  if (s.type === EVP_PKEY_RSA) return rsaApply(s.rsa, emsaEncode(s.rsa, { kind: "pkcs1", md: "sha256" }, d)!, true)!;
  throw new DerError("unsupported signing key");
}
