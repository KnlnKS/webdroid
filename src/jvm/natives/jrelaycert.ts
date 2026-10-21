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
import { md5, sha1, sha256 } from "../../crypto/digest.ts";
import { seq, oid, tlv, integer, bits, octets, bytesToBig } from "../../crypto/der.ts";
import { CURVES, generateEc, ecdsaSign, marshalPublicKey, EVP_PKEY_EC, type EcKey } from "../../crypto/pkey.ts";

const P256 = CURVES.find((c) => c.name === "prime256v1")!;
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.10"), tlv(0x0c, utf8.enc.encode("webdroid")))), tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, utf8.enc.encode(cn)))));
const time = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return tlv(0x17, utf8.enc.encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const ext = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [tlv(1, [0xff])] : []), octets(value));
const DAY = 86_400_000, ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const serial = () => integer(bytesToBig(crypto.getRandomValues(new Uint8Array(12))));

type Keyed = { ec: EcKey; spki: Uint8Array; keyId: Uint8Array };
function newKey(): Keyed {
  const ec = generateEc(P256), spki = marshalPublicKey({ type: EVP_PKEY_EC, ec });
  return { ec, spki, keyId: sha1(spki.subarray(-65)) };
}
function signed(tbs: Uint8Array, by: EcKey): Uint8Array {
  return seq(tbs, ECDSA_SHA256, bits(ecdsaSign(by.curve, by.priv!, sha256(tbs))));
}

let relayCa: (Keyed & { name: Uint8Array; der: Uint8Array }) | null = null;
/** the relay's CA, made once per realm and installed in the system trust store under its subject hash */
function ca() {
  if (relayCa) return relayCa;
  const key = newKey(), subject = name("webdroid relay CA"), now = Date.now();
  const der = signed(seq(tlv(0xa0, integer(2n)), serial(), ECDSA_SHA256, subject, seq(time(now - DAY), time(now + 3650 * DAY)), subject, key.spki,
    tlv(0xa3, seq(ext("2.5.29.19", true, seq(tlv(1, [0xff]))), ext("2.5.29.15", true, tlv(3, [1, 0x06])), ext("2.5.29.14", false, octets(key.keyId))))), key.ec);
  // TrustedCertificateStore names a file by X509_NAME_hash_old: the subject's MD5, first four bytes little-endian
  const h = md5(subject), hash = ((h[0] | h[1] << 8 | h[2] << 16 | h[3] << 24) >>> 0).toString(16).padStart(8, "0");
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toBase64().replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  vfs.mount(`/system/etc/security/cacerts/${hash}.0`, new BytesFile(utf8.enc.encode(pem)));
  return relayCa = { ...key, name: subject, der };
}
const leaves = new Map<string, Uint8Array>();
function leafFor(host: string): Uint8Array {
  let der = leaves.get(host);
  if (der) return der;
  const issuer = ca(), key = newKey(), now = Date.now();
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? Uint8Array.from(host.split("."), Number) : null;
  der = signed(seq(tlv(0xa0, integer(2n)), serial(), ECDSA_SHA256, issuer.name, seq(time(now - DAY), time(now + 365 * DAY)), name(host), key.spki,
    tlv(0xa3, seq(ext("2.5.29.17", false, seq(ip ? tlv(0x87, ip) : tlv(0x82, utf8.enc.encode(host)))), ext("2.5.29.15", true, tlv(3, [7, 0x80])),
      ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), ext("2.5.29.35", false, seq(tlv(0x80, issuer.keyId)))))), issuer.ec);
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
