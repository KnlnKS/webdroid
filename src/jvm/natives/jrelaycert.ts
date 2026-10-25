// The peer certificates of a TLS session the relay terminates (jnet.ts). The page never sees the
// server's chain: the relay verified it against its own trust store and speaks plaintext to the
// page, as an intercepting proxy does. So, as on a device behind such a proxy, the device trusts the
// relay's CA (installed in the system store, /system/etc/security/cacerts) and a session presents a
// leaf for the host that CA issued. Hostname verification and the platform trust manager accept it;
// a pinned key does not match it.
import { jarray, utf8 } from "../abi.ts";
import { driven, type Gen } from "../runtime.ts";
import { newObj, vcall, scall } from "./jentry.ts";
import { vfs } from "../../shell/vfs.ts";
import { BytesFile } from "../../shell/lazyfile.ts";
import { md5, sha1 } from "../../crypto/digest.ts";
import { seq, oid, tlv, octets } from "../../crypto/der.ts";
import { bytesToBig } from "../../crypto/bigint.ts";
import { CURVES, generateEc, marshalPublicKey, EVP_PKEY_EC, type PKey } from "../../crypto/pkey.ts";
import { buildCertificate, x500Name, extension, keyUsage, BASIC_CONSTRAINTS, SUBJECT_ALT_NAME, EXT_KEY_USAGE } from "../../crypto/x509.ts";

const P256 = CURVES.find((c) => c.name === "prime256v1")!;
const name = (cn: string) => x500Name([["2.5.4.10", "webdroid"], ["2.5.4.3", cn]]);
const DAY = 86_400_000;
const serial = () => bytesToBig(crypto.getRandomValues(new Uint8Array(12)));
const newKey = (): PKey => ({ type: EVP_PKEY_EC, ec: generateEc(P256) });

let relayCa: { key: PKey; keyId: Uint8Array; name: Uint8Array; der: Uint8Array } | null = null;
/** the relay's CA, made once per realm and installed in the system trust store under its subject hash */
function ca() {
  if (relayCa) return relayCa;
  const key = newKey(), keyId = sha1(marshalPublicKey(key).subarray(-65)), subject = name("webdroid relay CA"), now = Date.now();
  const der = buildCertificate({ serial: serial(), issuer: subject, subject, notBefore: now - DAY, notAfter: now + 3650 * DAY, key, signer: key,
    exts: [extension(BASIC_CONSTRAINTS, true, seq(tlv(1, [0xff]))), keyUsage([5, 6]), extension("2.5.29.14", false, octets(keyId))] });
  // TrustedCertificateStore names a file by X509_NAME_hash_old: the subject's MD5, first four bytes little-endian
  const h = md5(subject), hash = ((h[0] | h[1] << 8 | h[2] << 16 | h[3] << 24) >>> 0).toString(16).padStart(8, "0");
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toBase64().replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  vfs.mount(`/system/etc/security/cacerts/${hash}.0`, new BytesFile(utf8.enc.encode(pem)));
  return relayCa = { key, keyId, name: subject, der };
}
const leaves = new Map<string, Uint8Array>();
function leafFor(host: string): Uint8Array {
  let der = leaves.get(host);
  if (der) return der;
  const issuer = ca(), now = Date.now();
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? Uint8Array.from(host.split("."), Number) : null;
  der = buildCertificate({ serial: serial(), issuer: issuer.name, subject: name(host), notBefore: now - DAY, notAfter: now + 365 * DAY, key: newKey(), signer: issuer.key,
    exts: [extension(SUBJECT_ALT_NAME, false, seq(ip ? tlv(0x87, ip) : tlv(0x82, utf8.enc.encode(host)))), keyUsage([0]),
      extension(EXT_KEY_USAGE, false, seq(oid("1.3.6.1.5.5.7.3.1"))), extension("2.5.29.35", false, seq(tlv(0x80, issuer.keyId)))] });
  leaves.set(host, der);
  return der;
}
/** the chain a relay-terminated session to `host` presents: its leaf, then the relay CA */
export const relayChain = driven(function* (host: string): Gen<unknown[]> {
  const factory = yield scall("java/security/cert/CertificateFactory", "getInstance", "(Ljava/lang/String;)Ljava/security/cert/CertificateFactory;", "X.509");
  const chain: unknown[] = [];
  for (const der of [leafFor(host), ca().der])
    chain.push(yield vcall(factory, "generateCertificate", "(Ljava/io/InputStream;)Ljava/security/cert/Certificate;", yield newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(der))));
  return jarray(chain, "Ljava/security/cert/Certificate;");
});
