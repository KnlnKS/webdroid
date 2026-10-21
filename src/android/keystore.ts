// keystore2 behind binder (android.system.keystore2.IKeystoreService/default) over a software KeyMint,
// as the reference AVD runs one: the framework's AndroidKeyStore provider, KeyStore2 and
// KeyStoreSecurityLevel run from bytecode and reach this service. Keys never leave it; an entry holds
// the key material, the authorizations KeyMint enforces, and the certificates of asymmetric keys.
// Entries are per app uid and persist with the app's other state. Attestation is not available
// (no provisioned attestation keys), and user-authentication-bound keys cannot be used.
import { once } from "../jvm/suspend.ts";
import { awaited, rt, JObj, getDeclared, setDeclared, driven, waits, type Gen } from "../jvm/runtime.ts";
import { concat, jarray, sameBytes } from "../jvm/abi.ts";
import { after, newObj, scall } from "../jvm/natives/jentry.ts";
import { unbox } from "../jvm/natives/jbox.ts";
import { hostService } from "./binder.ts";
import { PROCESS_UID } from "./os.ts";
import { device } from "../shell/config.ts";
import { DIGESTS, Hmac } from "../crypto/digest.ts";
import { aes, ctr, AesGcm } from "../crypto/ciphers.ts";
import {
  CURVES, G, mul, randomScalar, ecdsaSign, ecdsaVerify, rsaBytes, rsaPrivate, rsaPublic, pkcs1SignPad, pssEncode, pssVerify,
  oaepDecode, oaepEncode, pkcs1EncryptPad, pkcs1Unpad, parsePrivateKey, parsePublicKey, marshalPrivateKey, marshalPublicKey, bitLength,
  EVP_PKEY_RSA, EVP_PKEY_EC, type PKey,
} from "../crypto/pkey.ts";
import { seq, oid, tlv, integer, bits, bigToBytes, bytesToBig, derNull, octets } from "../crypto/der.ts";
import type { PackageState } from "../shell/packagedata.ts";
import { persisted } from "../shell/device-storage.ts";

// KeyMint's constants (android.hardware.security.keymint)
const TAG = {
  PURPOSE: 0x20000001, ALGORITHM: 0x10000002, KEY_SIZE: 0x30000003, BLOCK_MODE: 0x20000004, DIGEST: 0x20000005, PADDING: 0x20000006,
  CALLER_NONCE: 0x70000007, MIN_MAC_LENGTH: 0x30000008, EC_CURVE: 0x1000000a, RSA_PUBLIC_EXPONENT: 0x500000c8, RSA_OAEP_MGF_DIGEST: 0x200000cb,
  USER_SECURE_ID: -1610612234, NO_AUTH_REQUIRED: 0x700001f7, USER_AUTH_TYPE: 0x100001f8, AUTH_TIMEOUT: 0x300001f9, USER_ID: 0x300001f5,
  CREATION_DATETIME: 0x600002bd, ORIGIN: 0x100002be, OS_VERSION: 0x300002c1, OS_PATCHLEVEL: 0x300002c2, VENDOR_PATCHLEVEL: 0x300002ce,
  BOOT_PATCHLEVEL: 0x300002cf, ATTESTATION_CHALLENGE: -1879047484, NONCE: -1879047191, MAC_LENGTH: 0x300003eb, ASSOCIATED_DATA: -1879047192,
  CERTIFICATE_SERIAL: -2147482642, CERTIFICATE_SUBJECT: -1879047185, CERTIFICATE_NOT_BEFORE: 0x600003f0, CERTIFICATE_NOT_AFTER: 0x600003f1,
  APPLICATION_ID: -1879047591, APPLICATION_DATA: -1879047492, INCLUDE_UNIQUE_ID: 0x700000ca, UNLOCKED_DEVICE_REQUIRED: 0x700001fd,
};
const ALG = { RSA: 1, EC: 3, AES: 32, TRIPLE_DES: 33, HMAC: 128 };
const MODE = { ECB: 1, CBC: 2, CTR: 3, GCM: 32 };
const PAD = { NONE: 1, RSA_OAEP: 2, RSA_PSS: 3, RSA_PKCS1_1_5_ENCRYPT: 4, RSA_PKCS1_1_5_SIGN: 5, PKCS7: 64 };
const PURPOSE = { ENCRYPT: 0, DECRYPT: 1, SIGN: 2, VERIFY: 3, AGREE_KEY: 6 };
const DIGEST_NAMES = [null, "md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
const ERR = {
  UNSUPPORTED_PURPOSE: -2, INCOMPATIBLE_PURPOSE: -3, UNSUPPORTED_ALGORITHM: -4, UNSUPPORTED_KEY_SIZE: -6, INCOMPATIBLE_BLOCK_MODE: -8,
  UNSUPPORTED_MAC_LENGTH: -9, INCOMPATIBLE_PADDING_MODE: -11, INCOMPATIBLE_DIGEST: -13, INVALID_INPUT_LENGTH: -21, KEY_USER_NOT_AUTHENTICATED: -26,
  VERIFICATION_FAILED: -30, INVALID_ARGUMENT: -38, INVALID_NONCE: -52, CALLER_NONCE_PROHIBITED: -55, INVALID_MAC_LENGTH: -57,
  MISSING_MIN_MAC_LENGTH: -58, UNSUPPORTED_EC_CURVE: -61, ATTESTATION_KEYS_NOT_PROVISIONED: -74, INVALID_OPERATION: -76, UNKNOWN_ERROR: -1000,
};
const RESPONSE = { KEY_NOT_FOUND: 7, INVALID_ARGUMENT: 20 };
const DOMAIN = { APP: 0, KEY_ID: 4 };
const SOFTWARE = 0, TRUSTED_ENVIRONMENT = 1, KEYSTORE = 100;

const failure = (code: number, msg: string): Promise<never> =>
  after(newObj("android/os/ServiceSpecificException", "(ILjava/lang/String;)V", code, msg), (e) => { throw e; });

// ── key parameters: (tag, KeyParameterValue kind, value)
type Value = number | bigint | boolean | Uint8Array;
type Param = { tag: number; kind: number; v: Value };
const KINDS = ["invalid", "algorithm", "blockMode", "paddingMode", "digest", "ecCurve", "origin", "keyPurpose", "hardwareAuthenticatorType", "securityLevel",
  "boolValue", "integer", "longInteger", "dateTime", "blob"];
const KIND = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<string, number>;
const KP = "android/hardware/security/keymint/KeyParameter", KPV = "android/hardware/security/keymint/KeyParameterValue";
function readParams(arr: unknown[] | null): Param[] {
  return (arr ?? []).map((p) => {
    const value = getDeclared(p, KP, "value"), kind = getDeclared<number>(value, KPV, "_tag"), boxed = getDeclared(value, KPV, "_value");
    const v = boxed instanceof Int8Array ? new Uint8Array(boxed) : kind === KIND.boolValue ? !!unbox(boxed) : unbox(boxed) as Value;
    return { tag: getDeclared<number>(p, KP, "tag"), kind, v };
  });
}
const DESC: Record<number, string> = { [KIND.boolValue]: "Z", [KIND.integer]: "I", [KIND.longInteger]: "J", [KIND.dateTime]: "J", [KIND.blob]: "[B" };
function* javaParam(p: Param): Gen<JObj> {
  const d = DESC[p.kind] ?? "I", v = p.v instanceof Uint8Array ? new Int8Array(p.v) : typeof p.v === "boolean" ? +p.v : p.v;
  const value = yield scall(KPV, KINDS[p.kind], `(${d})L${KPV};`, v);
  return setDeclared(yield newObj(KP), KP, { tag: p.tag, value });
}
function* javaParams(ps: Param[]): Gen<JObj[]> {
  const out: JObj[] = [];
  for (const p of ps) out.push(yield* javaParam(p));
  return out;
}
const all = (ps: Param[], tag: number) => ps.filter((p) => p.tag === tag).map((p) => p.v);
const one = (ps: Param[], tag: number) => ps.find((p) => p.tag === tag)?.v;
const num = (ps: Param[], tag: number) => { const v = one(ps, tag); return v === undefined ? undefined : Number(v); };

// ── entries, per app uid, persisted as JSON
type Entry = { id: string; alias: string; params: [number, number, string][]; material?: string; cert?: string; chain?: string; created: number; modified: number };
const encodeParam = (p: Param): [number, number, string] =>
  [p.tag, p.kind, p.v instanceof Uint8Array ? p.v.toBase64() : typeof p.v === "bigint" ? p.v.toString() : String(p.v)];
const decodeParam = ([tag, kind, s]: [number, number, string]): Param =>
  ({ tag, kind, v: kind === KIND.blob ? Uint8Array.fromBase64(s) : kind === KIND.longInteger || kind === KIND.dateTime ? BigInt(s) : kind === KIND.boolValue ? s === "true" : Number(s) });
const savedEntries = persisted("wd:keystore2:", (saved) => Array.isArray(saved) ? saved as Entry[] : null);
/** AppDataHelper.clearKeystoreData: every key of the app's uid */
export const keystoreData: PackageState = {
  clear(_pkg, uid) { if (uid !== undefined) savedEntries.remove(String(uid)); },
};
/** the entries, kept for this session where storage is unavailable; a corrupt store is empty */
let session: Entry[] = [];
function entries(): Entry[] {
  const saved = savedEntries.get(String(PROCESS_UID));
  return saved === undefined ? session : saved ?? [];
}
function save(list: Entry[]) {
  session = list;
  savedEntries.set(String(PROCESS_UID), list);
}
const newId = () => BigInt.asIntN(64, bytesToBig(crypto.getRandomValues(new Uint8Array(8)))).toString();

const KD = "android/system/keystore2/KeyDescriptor";
function descriptor(d: unknown): { domain: number; nspace: bigint; alias: string | null } {
  if (!d) throw rt.mkThrowable("java/lang/NullPointerException", "key descriptor");
  return { domain: getDeclared(d, KD, "domain"), nspace: getDeclared(d, KD, "nspace"), alias: getDeclared(d, KD, "alias") };
}
function* find(d: unknown): Gen<Entry> {
  const k = descriptor(d);
  const e = k.domain === DOMAIN.KEY_ID ? entries().find((x) => x.id === k.nspace.toString()) : k.domain === DOMAIN.APP ? entries().find((x) => x.alias === k.alias) : undefined;
  return e ?? (yield* awaited(failure(RESPONSE.KEY_NOT_FOUND, "Key not found")));
}

// the characteristics KeyMint enforces, from a generate or import request
const CHARACTERISTIC_TAGS = new Set([TAG.PURPOSE, TAG.ALGORITHM, TAG.KEY_SIZE, TAG.BLOCK_MODE, TAG.DIGEST, TAG.PADDING, TAG.CALLER_NONCE, TAG.MIN_MAC_LENGTH,
  TAG.EC_CURVE, TAG.RSA_PUBLIC_EXPONENT, TAG.RSA_OAEP_MGF_DIGEST, TAG.USER_SECURE_ID, TAG.NO_AUTH_REQUIRED, TAG.USER_AUTH_TYPE, TAG.AUTH_TIMEOUT,
  TAG.UNLOCKED_DEVICE_REQUIRED, 0x60000190, 0x60000191, 0x60000192, 0x30000194, 0x30000195, 0x700001fa, 0x700001fb, 0x700001fc, 0x700001fe]);
// the device's OS version and patch levels, from its Build values
const release = Number(device.release.split(".")[0]) || 0;
const PATCH = 20230101;
function characteristics(req: Param[], origin: number, extra: Param[] = []): Param[] {
  return [...req.filter((p) => CHARACTERISTIC_TAGS.has(p.tag)), ...extra,
    { tag: TAG.ORIGIN, kind: KIND.origin, v: origin }, { tag: TAG.OS_VERSION, kind: KIND.integer, v: release * 10000 },
    { tag: TAG.OS_PATCHLEVEL, kind: KIND.integer, v: Math.floor(PATCH / 100) }, { tag: TAG.VENDOR_PATCHLEVEL, kind: KIND.integer, v: PATCH },
    { tag: TAG.BOOT_PATCHLEVEL, kind: KIND.integer, v: PATCH }];
}

// ── certificates KeyMint issues for asymmetric keys (self-signed by the key when it may sign)
const utcOrGeneralized = (ms: number) => {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, y = d.getUTCFullYear();
  return y >= 1950 && y < 2050 ? tlv(0x17, new TextEncoder().encode(p(y % 100) + body)) : tlv(0x18, new TextEncoder().encode(y + body));
};
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2", OID_RSA_SHA256 = "1.2.840.113549.1.1.11";
function certificate(key: PKey, req: Param[], purposes: number[]): Uint8Array {
  const serial = one(req, TAG.CERTIFICATE_SERIAL) as Uint8Array | undefined, subject = one(req, TAG.CERTIFICATE_SUBJECT) as Uint8Array | undefined;
  const name = subject?.length ? subject : seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode("Android Keystore Key")))));
  const notBefore = Number(one(req, TAG.CERTIFICATE_NOT_BEFORE) ?? 0n), notAfter = Number(one(req, TAG.CERTIFICATE_NOT_AFTER) ?? 2461449600000n);
  const canSign = purposes.includes(PURPOSE.SIGN);
  const ku = [purposes.includes(PURPOSE.SIGN), false, purposes.includes(PURPOSE.ENCRYPT) || purposes.includes(PURPOSE.DECRYPT), false, purposes.includes(PURPOSE.AGREE_KEY)];
  const last = ku.lastIndexOf(true), kuBits = ku.reduce((a, on, i) => a | (on ? 0x80 >> i : 0), 0);
  const keyUsage = seq(oid("2.5.29.15"), tlv(1, [0xff]), octets(tlv(3, last < 0 ? [0] : [7 - last, kuBits])));
  const sigAlg = key.type === EVP_PKEY_EC ? seq(oid(OID_ECDSA_SHA256)) : seq(oid(OID_RSA_SHA256), derNull());
  const tbs = seq(tlv(0xa0, integer(2n)), serial?.length ? tlv(2, serial) : integer(1n), sigAlg, name,
    seq(utcOrGeneralized(notBefore), utcOrGeneralized(notAfter)), name, marshalPublicKey(key), tlv(0xa3, seq(keyUsage)));
  let signature: Uint8Array = new Uint8Array(0);
  if (canSign) {
    const h = DIGESTS.sha256(); h.update(tbs);
    const digest = h.digest();
    if (key.type === EVP_PKEY_EC) signature = ecdsaSign(key.ec.curve, key.ec.priv!, digest);
    else if (key.type === EVP_PKEY_RSA) signature = bigToBytes(rsaPrivate(key.rsa, bytesToBig(pkcs1SignPad(rsaBytes(key.rsa), "sha256", digest)!)), rsaBytes(key.rsa));
  }
  return seq(tbs, sigAlg, bits(signature));
}

// ── KeyMetadata / KeyEntryResponse
const KM = "android/system/keystore2/KeyMetadata", AUTH = "android/system/keystore2/Authorization", KER = "android/system/keystore2/KeyEntryResponse";
function* metadata(e: Entry): Gen<JObj> {
  const auths: JObj[] = [];
  for (const p of [...e.params.map(decodeParam), { tag: TAG.CREATION_DATETIME, kind: KIND.dateTime, v: BigInt(e.created) }, { tag: TAG.USER_ID, kind: KIND.integer, v: Math.floor(PROCESS_UID / 100000) }])
    auths.push(setDeclared(yield newObj(AUTH), AUTH, { securityLevel: p.tag === TAG.CREATION_DATETIME ? KEYSTORE : SOFTWARE, keyParameter: yield* javaParam(p) }));
  return setDeclared(yield newObj(KM), KM, {
    key: setDeclared(yield newObj(KD), KD, { domain: DOMAIN.KEY_ID, nspace: BigInt(e.id), alias: null, blob: null }),
    keySecurityLevel: e.material ? TRUSTED_ENVIRONMENT : SOFTWARE, authorizations: jarray(auths, `L${AUTH};`),
    certificate: e.cert ? new Int8Array(Uint8Array.fromBase64(e.cert)) : null, certificateChain: e.chain ? new Int8Array(Uint8Array.fromBase64(e.chain)) : null, modificationTimeMs: BigInt(e.modified),
  });
}

// ── generation and import
function algorithmOf(ps: Param[]): number {
  const a = num(ps, TAG.ALGORITHM);
  if (a === undefined) throw ERR.UNSUPPORTED_ALGORITHM;
  return a;
}
const CURVE_BY_EC = ["secp224r1", "prime256v1", "secp384r1", "secp521r1"];
const CURVE_BY_SIZE: Record<number, string> = { 224: "secp224r1", 256: "prime256v1", 384: "secp384r1", 521: "secp521r1" };
async function generateMaterial(ps: Param[]): Promise<{ material: Uint8Array; extra: Param[]; key?: PKey }> {
  const alg = algorithmOf(ps), size = num(ps, TAG.KEY_SIZE);
  if (alg === ALG.AES || alg === ALG.HMAC) {
    if (size === undefined || size % 8 || (alg === ALG.AES && ![128, 192, 256].includes(size)) || (alg === ALG.HMAC && (size < 64 || size > 512))) throw ERR.UNSUPPORTED_KEY_SIZE;
    return { material: crypto.getRandomValues(new Uint8Array(size / 8)), extra: [] };
  }
  if (alg === ALG.EC) {
    const byCurve = num(ps, TAG.EC_CURVE), name = byCurve !== undefined ? CURVE_BY_EC[byCurve] : size !== undefined ? CURVE_BY_SIZE[size] : undefined;
    const curve = CURVES.find((c) => c.name === name);
    if (!curve) throw ERR.UNSUPPORTED_EC_CURVE;
    const d = randomScalar(curve.n), key: PKey = { type: EVP_PKEY_EC, ec: { curve, pub: mul(curve, d, G(curve)) as [bigint, bigint], priv: d } };
    const extra: Param[] = [];
    if (size === undefined) extra.push({ tag: TAG.KEY_SIZE, kind: KIND.integer, v: bitLength(curve.p) });
    if (byCurve === undefined) extra.push({ tag: TAG.EC_CURVE, kind: KIND.ecCurve, v: CURVE_BY_EC.indexOf(curve.name) });
    return { material: marshalPrivateKey(key)!, extra, key };
  }
  if (alg === ALG.RSA) {
    const bitsN = size ?? 2048, e = BigInt((one(ps, TAG.RSA_PUBLIC_EXPONENT) as bigint | undefined) ?? 65537n);
    if (bitsN < 512 || bitsN > 8192 || bitsN % 8) throw ERR.UNSUPPORTED_KEY_SIZE;
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: bitsN, publicExponent: new Uint8Array(bigToBytes(e)), hash: "SHA-256" }, true, ["sign"]) as CryptoKeyPair;
    const key = parsePrivateKey(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
    return { material: marshalPrivateKey(key)!, extra: [], key };
  }
  throw ERR.UNSUPPORTED_ALGORITHM;
}
function* store(alias: string, req: Param[], origin: number, made: { material: Uint8Array; extra: Param[]; key?: PKey }): Gen<JObj> {
  const now = Date.now(), purposes = all(req, TAG.PURPOSE).map(Number);
  const e: Entry = { id: newId(), alias, params: characteristics(req, origin, made.extra).map(encodeParam), material: made.material.toBase64(), created: now, modified: now };
  if (made.key) e.cert = certificate(made.key, req, purposes).toBase64();
  save([...entries().filter((x) => x.alias !== alias), e]);
  return yield* metadata(e);
}
/** `body`'s answer, a KeyMint error code it throws as the ServiceSpecificException keystore2 sends */
function* keymint$<T>(body: Gen<T>): Gen<T> {
  try { return yield* body; } catch (e) { if (typeof e !== "number") throw e; return yield* awaited(failure(e, "KeyMint error " + e)); }
}

// ── operations
type Op = { e: Entry; params: Param[]; purpose: number; input: Uint8Array[]; aad: Uint8Array[]; nonce: Uint8Array | null; done: boolean };
function keyOf(e: Entry): PKey { return parsePrivateKey(Uint8Array.fromBase64(e.material!)); }
function blockCipher(op: Op, data: Uint8Array): Uint8Array {
  const ps = op.params, mode = num(ps, TAG.BLOCK_MODE) ?? MODE.ECB, pad = num(ps, TAG.PADDING) ?? PAD.NONE, enc = op.purpose === PURPOSE.ENCRYPT;
  const key = Uint8Array.fromBase64(op.e.material!);
  if (mode === MODE.GCM) {
    const gcm = new AesGcm(key), tagLen = (num(ps, TAG.MAC_LENGTH) ?? 128) / 8, aad = concat(op.aad);
    if (enc) return gcm.seal(op.nonce!, data, aad, tagLen);
    const out = gcm.open(op.nonce!, data, aad, tagLen);
    if (!out) throw ERR.VERIFICATION_FAILED;
    return out;
  }
  const bc = aes(key);
  if (mode === MODE.CTR) { const out = data.slice(); ctr(bc, op.nonce!.slice(), out, new Uint8Array(16), 16); return out; }
  let buf = data;
  if (enc && pad === PAD.PKCS7) { const n = 16 - (data.length % 16); buf = concat([data, new Uint8Array(n).fill(n)]); }
  if (buf.length % 16) throw ERR.INVALID_INPUT_LENGTH;
  const out = buf.slice(), iv = op.nonce?.slice() ?? new Uint8Array(16);
  for (let off = 0; off < out.length; off += 16) {
    if (mode === MODE.ECB) { enc ? bc.encrypt(out, off) : bc.decrypt(out, off); continue; }
    if (enc) { for (let i = 0; i < 16; i++) out[off + i] ^= iv[i]; bc.encrypt(out, off); iv.set(out.subarray(off, off + 16)); }
    else { const next = out.slice(off, off + 16); bc.decrypt(out, off); for (let i = 0; i < 16; i++) out[off + i] ^= iv[i]; iv.set(next); }
  }
  if (!enc && pad === PAD.PKCS7) {
    const n = out[out.length - 1];
    if (!n || n > 16 || n > out.length || !out.subarray(out.length - n).every((b) => b === n)) throw ERR.INVALID_ARGUMENT;
    return out.slice(0, out.length - n);
  }
  return out;
}
function finishOp(op: Op, signature: Uint8Array | null): Uint8Array | null {
  const alg = num(op.e.params.map(decodeParam), TAG.ALGORITHM)!, ps = op.params, data = concat(op.input);
  if (alg === ALG.AES) return blockCipher(op, data);
  const digestName = DIGEST_NAMES[num(ps, TAG.DIGEST) ?? 0] ?? null;
  if (alg === ALG.HMAC) {
    const mac = new Hmac(DIGESTS[digestName ?? "sha256"], Uint8Array.fromBase64(op.e.material!));
    mac.update(data);
    const full = mac.digest();
    if (op.purpose === PURPOSE.SIGN) return full.subarray(0, (num(ps, TAG.MAC_LENGTH) ?? full.length * 8) / 8);
    if (!signature || !sameBytes(full.subarray(0, signature.length), signature)) throw ERR.VERIFICATION_FAILED;
    return null;
  }
  const key = keyOf(op.e);
  const digest = digestName ? (() => { const h = DIGESTS[digestName](); h.update(data); return h.digest(); })() : data;
  if (key.type === EVP_PKEY_EC) {
    const c = key.ec.curve;
    if (op.purpose === PURPOSE.SIGN) return ecdsaSign(c, key.ec.priv!, digest);
    if (op.purpose === PURPOSE.VERIFY) { if (!signature || !ecdsaVerify(c, key.ec.pub, digest, signature)) throw ERR.VERIFICATION_FAILED; return null; }
    if (op.purpose === PURPOSE.AGREE_KEY) {
      const peer = parsePublicKey(data);
      if (peer.type !== EVP_PKEY_EC || peer.ec.curve !== c) throw ERR.INVALID_ARGUMENT;
      return bigToBytes(mul(c, key.ec.priv!, peer.ec.pub)![0], c.bytes);
    }
    throw ERR.INCOMPATIBLE_PURPOSE;
  }
  if (key.type !== EVP_PKEY_RSA) throw ERR.UNSUPPORTED_ALGORITHM;
  const r = key.rsa, k = rsaBytes(r), pad = num(ps, TAG.PADDING) ?? PAD.NONE, hash = () => DIGESTS[digestName ?? "sha1"]();
  const mgfName = DIGEST_NAMES[num(ps, TAG.RSA_OAEP_MGF_DIGEST) ?? 2] ?? "sha1";
  if (op.purpose === PURPOSE.SIGN || op.purpose === PURPOSE.VERIFY) {
    const em = pad === PAD.RSA_PSS && digestName ? pssEncode(digest, bitLength(r.n) - 1, hash, hash, digest.length)
      : pad === PAD.RSA_PKCS1_1_5_SIGN ? pkcs1SignPad(k, digestName, digest) : pad === PAD.NONE ? concat([new Uint8Array(Math.max(0, k - digest.length)), digest]) : null;
    if (op.purpose === PURPOSE.SIGN) {
      if (!em) throw ERR.INCOMPATIBLE_PADDING_MODE;
      const block = em.length < k ? concat([new Uint8Array(k - em.length), em]) : em;
      return bigToBytes(rsaPrivate(r, bytesToBig(block)), k);
    }
    const got = signature && signature.length === k ? bigToBytes(rsaPublic(r, bytesToBig(signature)), k) : null;
    const ok = got && (pad === PAD.RSA_PSS ? pssVerify(digest, got, bitLength(r.n) - 1, hash, hash, -1) : !!em && sameBytes(em, got));
    if (!ok) throw ERR.VERIFICATION_FAILED;
    return null;
  }
  if (op.purpose === PURPOSE.DECRYPT) {
    if (data.length !== k) throw ERR.INVALID_INPUT_LENGTH;
    const em = bigToBytes(rsaPrivate(r, bytesToBig(data)), k);
    const m = pad === PAD.RSA_OAEP ? oaepDecode(k, em, hash, DIGESTS[mgfName], new Uint8Array(0)) : pad === PAD.RSA_PKCS1_1_5_ENCRYPT ? pkcs1Unpad(em, 2) : em;
    if (!m) throw ERR.UNKNOWN_ERROR;
    return m;
  }
  if (op.purpose === PURPOSE.ENCRYPT) {
    const em = pad === PAD.RSA_OAEP ? oaepEncode(k, data, hash, DIGESTS[mgfName], new Uint8Array(0)) : pad === PAD.RSA_PKCS1_1_5_ENCRYPT ? pkcs1EncryptPad(k, data) : data;
    if (!em || em.length !== k) throw ERR.INVALID_INPUT_LENGTH;
    return bigToBytes(rsaPublic(r, bytesToBig(em)), k);
  }
  throw ERR.INCOMPATIBLE_PURPOSE;
}
const out = (b: Uint8Array | null) => b && b.length ? new Int8Array(b) : null;
class JKeystoreOperation extends JObj { op: Op | null = null; }
const live = (self: JKeystoreOperation) => {
  if (!self.op || self.op.done) throw ERR.INVALID_OPERATION;
  return self.op;
};
/** an IKeystoreOperation method, a step of the live operation */
const operation = <A extends unknown[]>(step: (op: Op, ...a: A) => unknown) => waits(function (this: JKeystoreOperation, ...a: A) {
  const self = this;
  return rt.drive(keymint$(function* () { return step(live(self), ...a); }()));
});
rt.register({ name: "webdroid/KeystoreOperation", ctor: JKeystoreOperation, sup: "android/system/keystore2/IKeystoreOperation$Stub", methods: {
  "updateAad([B)V": operation((op, aad: Int8Array) => { op.aad.push(new Uint8Array(aad)); }),
  "update([B)[B": operation((op, input: Int8Array) => { op.input.push(new Uint8Array(input)); return null; }),
  "finish([B[B)[B": operation((op, input: Int8Array | null, signature: Int8Array | null) => {
    if (input) op.input.push(new Uint8Array(input));
    op.done = true;
    return out(finishOp(op, signature ? new Uint8Array(signature) : null));
  }),
  "abort()V": function (this: JKeystoreOperation) { if (this.op) this.op.done = true; },
} });

const CREATE_OP = "android/system/keystore2/CreateOperationResponse", KPS = "android/system/keystore2/KeyParameters";
const createOperation = driven(function* (d: unknown, opParams: unknown[] | null): Gen<JObj> {
  const e = yield* find(d), key = e.params.map(decodeParam), ps = readParams(opParams);
  return yield* keymint$(function* (): Gen<JObj> {
    if (!e.material) throw ERR.INCOMPATIBLE_PURPOSE;
    const purpose = num(ps, TAG.PURPOSE);
    if (purpose === undefined || !all(key, TAG.PURPOSE).map(Number).includes(purpose)) throw ERR.INCOMPATIBLE_PURPOSE;
    if (!key.some((p) => p.tag === TAG.NO_AUTH_REQUIRED)) throw ERR.KEY_USER_NOT_AUTHENTICATED;
    const alg = num(key, TAG.ALGORITHM)!;
    const allowed = (tag: number, code: number) => { const v = num(ps, tag); if (v !== undefined && !all(key, tag).map(Number).includes(v)) throw code; };
    allowed(TAG.BLOCK_MODE, ERR.INCOMPATIBLE_BLOCK_MODE);
    allowed(TAG.PADDING, ERR.INCOMPATIBLE_PADDING_MODE);
    if (alg !== ALG.AES) allowed(TAG.DIGEST, ERR.INCOMPATIBLE_DIGEST);
    let nonce: Uint8Array | null = null;
    const returned: Param[] = [];
    if (alg === ALG.AES) {
      const mode = num(ps, TAG.BLOCK_MODE) ?? MODE.ECB, want = mode === MODE.GCM ? 12 : 16;
      if (mode === MODE.GCM) {
        const mac = num(ps, TAG.MAC_LENGTH), min = num(key, TAG.MIN_MAC_LENGTH) ?? 128;
        if (mac === undefined || mac % 8 || mac > 128 || mac < 96) throw ERR.UNSUPPORTED_MAC_LENGTH;
        if (mac < min) throw ERR.INVALID_MAC_LENGTH;
      }
      if (mode !== MODE.ECB) {
        const given = one(ps, TAG.NONCE) as Uint8Array | undefined;
        if (given) {
          if (purpose === PURPOSE.ENCRYPT && !key.some((p) => p.tag === TAG.CALLER_NONCE)) throw ERR.CALLER_NONCE_PROHIBITED;
          if (given.length !== want) throw ERR.INVALID_NONCE;
          nonce = given;
        } else if (purpose === PURPOSE.ENCRYPT) {
          nonce = crypto.getRandomValues(new Uint8Array(want));
          returned.push({ tag: TAG.NONCE, kind: KIND.blob, v: nonce });
        } else throw ERR.INVALID_NONCE;
      }
    }
    const operation = (yield newObj("webdroid/KeystoreOperation")) as JKeystoreOperation;
    operation.op = { e, params: [...ps, ...key.filter((p) => p.tag === TAG.MIN_MAC_LENGTH)], purpose, input: [], aad: [], nonce, done: false };
    const parameters = returned.length ? setDeclared(yield newObj(KPS), KPS, { keyParameter: jarray(yield* javaParams(returned), `L${KP};`) }) : null;
    return setDeclared(yield newObj(CREATE_OP), CREATE_OP, { iOperation: operation, operationChallenge: null, parameters, upgradedBlob: null });
  }());
});

// ── IKeystoreSecurityLevel (the TEE one) and IKeystoreService
class JSecurityLevel extends JObj {}
rt.register({ name: "webdroid/KeystoreSecurityLevel", ctor: JSecurityLevel, sup: "android/system/keystore2/IKeystoreSecurityLevel$Stub", methods: {
  "generateKey(Landroid/system/keystore2/KeyDescriptor;Landroid/system/keystore2/KeyDescriptor;[Landroid/hardware/security/keymint/KeyParameter;I[B)Landroid/system/keystore2/KeyMetadata;":
    waits((d: unknown, _attest: unknown, params: unknown[]) => rt.drive(keymint$(function* (): Gen<JObj> {
      const ps = readParams(params), alias = descriptor(d).alias;
      if (alias === null) throw ERR.INVALID_ARGUMENT;
      if (ps.some((p) => p.tag === TAG.ATTESTATION_CHALLENGE)) throw ERR.ATTESTATION_KEYS_NOT_PROVISIONED;
      return yield* store(alias, ps, 0, yield* awaited(generateMaterial(ps)));
    }()))),
  "importKey(Landroid/system/keystore2/KeyDescriptor;Landroid/system/keystore2/KeyDescriptor;[Landroid/hardware/security/keymint/KeyParameter;I[B)Landroid/system/keystore2/KeyMetadata;":
    waits((d: unknown, _attest: unknown, params: unknown[], _flags: number, data: Int8Array) => rt.drive(keymint$(function* (): Gen<JObj> {
      const ps = readParams(params), alias = descriptor(d).alias, alg = algorithmOf(ps), bytes = new Uint8Array(data);
      if (alias === null) throw ERR.INVALID_ARGUMENT;
      if (alg === ALG.AES || alg === ALG.HMAC) {
        const extra = num(ps, TAG.KEY_SIZE) === undefined ? [{ tag: TAG.KEY_SIZE, kind: KIND.integer, v: bytes.length * 8 }] : [];
        return yield* store(alias, ps, 2, { material: bytes, extra });
      }
      let key: PKey;
      try { key = parsePrivateKey(bytes); } catch { throw ERR.INVALID_ARGUMENT; }
      if ((alg === ALG.EC) !== (key.type === EVP_PKEY_EC) || (alg === ALG.RSA) !== (key.type === EVP_PKEY_RSA)) throw ERR.INVALID_ARGUMENT;
      const extra: Param[] = [];
      if (num(ps, TAG.KEY_SIZE) === undefined) extra.push({ tag: TAG.KEY_SIZE, kind: KIND.integer, v: key.type === EVP_PKEY_EC ? bitLength(key.ec.curve.p) : bitLength((key as { rsa: { n: bigint } }).rsa.n) });
      if (key.type === EVP_PKEY_EC && num(ps, TAG.EC_CURVE) === undefined) extra.push({ tag: TAG.EC_CURVE, kind: KIND.ecCurve, v: CURVE_BY_EC.indexOf(key.ec.curve.name) });
      return yield* store(alias, ps, 2, { material: marshalPrivateKey(key)!, extra, key });
    }()))),
  "createOperation(Landroid/system/keystore2/KeyDescriptor;[Landroid/hardware/security/keymint/KeyParameter;Z)Landroid/system/keystore2/CreateOperationResponse;":
    (d: unknown, params: unknown[]) => createOperation(d, params),
  "deleteKey(Landroid/system/keystore2/KeyDescriptor;)V": (d: unknown) => deleteKey(d),
} });
const teeLevel = once(() => newObj("webdroid/KeystoreSecurityLevel"));
const deleteKey = driven(function* (d: unknown): Gen<void> {
  const e = yield* find(d);
  save(entries().filter((x) => x !== e));
});
const listed = driven(function* (start: string | null): Gen<unknown[]> {
  const descriptors: JObj[] = [];
  for (const alias of entries().map((e) => e.alias).filter((a) => start === null || a > start).sort())
    descriptors.push(setDeclared(yield newObj(KD), KD, { domain: DOMAIN.APP, nspace: BigInt(PROCESS_UID), alias, blob: null }));
  return jarray(descriptors, `L${KD};`);
});
hostService("android.system.keystore2.IKeystoreService/default", "webdroid/KeystoreService", "android/system/keystore2/IKeystoreService$Stub", {
  "getSecurityLevel(I)Landroid/system/keystore2/IKeystoreSecurityLevel;": (level: number) =>
    level === TRUSTED_ENVIRONMENT ? teeLevel() : failure(-68, "No KeyMint instance for security level " + level),
  "getKeyEntry(Landroid/system/keystore2/KeyDescriptor;)Landroid/system/keystore2/KeyEntryResponse;": driven(function* (d: unknown) {
    const e = yield* find(d);
    return setDeclared(yield newObj(KER), KER, { iSecurityLevel: e.material ? yield teeLevel() : null, metadata: yield* metadata(e) });
  }),
  // a certificate for a key (its leaf and the rest of its chain), or a certificate-only entry
  "updateSubcomponent(Landroid/system/keystore2/KeyDescriptor;[B[B)V": waits((d: unknown, cert: Int8Array | null, chain: Int8Array | null) => {
    const k = descriptor(d), list = entries();
    let e = k.domain === DOMAIN.KEY_ID ? list.find((x) => x.id === k.nspace.toString()) : list.find((x) => x.alias === k.alias);
    if (!e) {
      if (k.domain !== DOMAIN.APP || k.alias === null || cert !== null || chain === null) return failure(RESPONSE.KEY_NOT_FOUND, "Key not found");
      e = { id: newId(), alias: k.alias, params: [], created: Date.now(), modified: Date.now() };
      list.push(e);
    }
    e.cert = cert ? new Uint8Array(cert).toBase64() : undefined;
    e.chain = chain ? new Uint8Array(chain).toBase64() : undefined;
    e.modified = Date.now();
    if (!e.material && !e.cert && !e.chain) list.splice(list.indexOf(e), 1);
    save(list);
  }),
  "listEntries(IJ)[Landroid/system/keystore2/KeyDescriptor;": () => listed(null),
  "listEntriesBatched(IJLjava/lang/String;)[Landroid/system/keystore2/KeyDescriptor;": (_domain: number, _ns: bigint, start: string | null) => listed(start),
  "getNumberOfEntries(IJ)I": () => entries().length,
  "deleteKey(Landroid/system/keystore2/KeyDescriptor;)V": (d: unknown) => deleteKey(d),
});
