// Conscrypt's native boundary (com.android.org.conscrypt.NativeCrypto, libjavacrypto over
// BoringSSL): the JCA classes, conscrypt's providers and bouncycastle run from the boot jars and
// reach BoringSSL's primitives here. Pointers are handles (android/handles.ts); a context a NativeRef
// holds is owned by it and freed when the NativeRef is collected. TLS stays at the relay (jnet.ts),
// so the SSL natives are not implemented.

import { rt, peerField, waits, ranged, type JObj } from "../runtime.ts";
import { handle, ownedHandle, weakHandle, deref, release } from "../../android/handles.ts";
import { DIGESTS, Hmac, deferred, type Deferred, type Hash } from "../../crypto/digest.ts";
import { aes, des, ctr, cbc, ecb, pkcs7Pad, pkcs7Unpad, Rc4, AesGcm, ChaCha20Poly1305, chacha20, type BlockCipher, type Aead } from "../../crypto/ciphers.ts";
import { type JBuffer, readRemainingBytes, writeRemainingBytes, addressOf, limit, position, directAddress } from "./jnio.ts";
import { memoryAt, region } from "./jmemory.ts";
import { randomBytes } from "../../native/kernel.ts";
import { after, scall } from "./jentry.ts";
import { concat, i8, jarray, u8, sameBytes } from "../abi.ts";
import {
  CURVES, curveByName, curveOfParams, G, mul, onCurve, generateEc, bitLength, ecdsaSign, ecdsaVerify, x25519, X25519_BASE,
  rsaBytes, rsaApply, generateRsa, emsaEncode, rsaVerify, emeEncode, emeDecode, pkcs1Unpad,
  parsePublicKey, parsePrivateKey, marshalPublicKey, marshalPrivateKey, EVP_PKEY_RSA, EVP_PKEY_EC, EVP_PKEY_X25519,
  type Curve, type Point, type Rsa, type RsaPad, type PKey,
} from "../../crypto/pkey.ts";
import { bigToBytes, fromSigned, parseOne, DerError, orDer, oid as oidDer } from "../../crypto/der.ts";

const NC = "com/android/org/conscrypt/NativeCrypto";
export const nc = (sig: string, fn: (...a: never[]) => unknown) => rt.registerJni(NC, sig, fn);
rt.claimNativeLib("javacrypto");

const address = peerField<bigint>("com/android/org/conscrypt/NativeRef", "address");
/** the native pointer a NativeRef holds */
export function ptr<T>(ref: JObj | null): T {
  if (!ref) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const o = deref<T>(address(ref));
  if (!o) throw rt.mkThrowable("java/lang/NullPointerException", "address == 0");
  return o;
}
const runtimeError = (msg: string) => rt.mkThrowable("java/lang/RuntimeException", msg);

// ── static configuration
nc("clinit()V", () => {});
nc("usesBoringSsl_FIPS_mode()Z", () => 0);
// the page's AES is software
nc("EVP_has_aes_hardware()I", () => 0);
// BoringSSL's cipher suites for "ALL:3DES", as (standard name, OpenSSL name) pairs
const CIPHER_NAMES = [
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "ECDHE-ECDSA-AES128-GCM-SHA256", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "ECDHE-RSA-AES128-GCM-SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384", "ECDHE-ECDSA-AES256-GCM-SHA384", "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", "ECDHE-RSA-AES256-GCM-SHA384",
  "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-ECDSA-CHACHA20-POLY1305", "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-RSA-CHACHA20-POLY1305",
  "TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-PSK-CHACHA20-POLY1305", "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA", "ECDHE-ECDSA-AES128-SHA",
  "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA", "ECDHE-RSA-AES128-SHA", "TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA", "ECDHE-PSK-AES128-CBC-SHA",
  "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA", "ECDHE-ECDSA-AES256-SHA", "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA", "ECDHE-RSA-AES256-SHA",
  "TLS_ECDHE_PSK_WITH_AES_256_CBC_SHA", "ECDHE-PSK-AES256-CBC-SHA", "TLS_RSA_WITH_AES_128_GCM_SHA256", "AES128-GCM-SHA256",
  "TLS_RSA_WITH_AES_256_GCM_SHA384", "AES256-GCM-SHA384", "TLS_RSA_WITH_AES_128_CBC_SHA", "AES128-SHA", "TLS_PSK_WITH_AES_128_CBC_SHA", "PSK-AES128-CBC-SHA",
  "TLS_RSA_WITH_AES_256_CBC_SHA", "AES256-SHA", "TLS_PSK_WITH_AES_256_CBC_SHA", "PSK-AES256-CBC-SHA", "TLS_RSA_WITH_3DES_EDE_CBC_SHA", "DES-CBC3-SHA",
];
nc("get_cipher_names(Ljava/lang/String;)[Ljava/lang/String;", (selector: string) => {
  if (selector !== "ALL:3DES") throw runtimeError("Unable to set SSL cipher list");
  return Object.assign(CIPHER_NAMES.slice(), { $t: "Ljava/lang/String;" });
});
nc("getDirectBufferAddress(Ljava/nio/Buffer;)J", waits((b: JBuffer) => after(directAddress(b ?? rt.npe()), BigInt)));
nc("RAND_bytes([B)V", (b: Int8Array | null) => {
  if (!b) throw rt.mkThrowable("java/lang/NullPointerException", null);
  randomBytes(u8(b));
});

// ── message digests (EVP_MD, EVP_MD_CTX)
type MdDesc = { name: string; make: () => Hash; size: number; block: number };
const mdByName = new Map<string, MdDesc>();
for (const [name, { make }] of Object.entries(DIGESTS)) { const h = make(); mdByName.set(name, { name, make, size: h.size, block: h.block }); }
const mdOf = (h: bigint): MdDesc => {
  const md = deref<MdDesc>(h);
  if (!md?.make) throw rt.mkThrowable("java/lang/NullPointerException", "md == null");
  return md;
};
nc("EVP_get_digestbyname(Ljava/lang/String;)J", (name: string) => {
  if (name == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const md = mdByName.get(name.toLowerCase());
  if (!md) throw runtimeError("Hash algorithm not found");
  return handle(md);
});
nc("EVP_MD_size(J)I", (h: bigint) => mdOf(h).size);
type MdCtx = { md: MdDesc | null; hash: Deferred | null };
nc("EVP_MD_CTX_create()J", () => ownedHandle({ md: null, hash: null } satisfies MdCtx));
nc("EVP_MD_CTX_destroy(J)V", (h: bigint) => release(h));
nc("EVP_MD_CTX_cleanup(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;)V", (ref: JObj) => { const c = ptr<MdCtx>(ref); c.md = null; c.hash = null; });
nc("EVP_DigestInit_ex(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;J)I", (ref: JObj, md: bigint) => {
  const c = ptr<MdCtx>(ref), d = mdOf(md);
  c.md = d; c.hash = deferred(d.name);
  return 1;
});
const liveHash = (ref: JObj): Deferred => {
  const c = ptr<MdCtx>(ref);
  if (!c.hash) throw runtimeError("EVP_MD_CTX not initialized");
  return c.hash;
};
const digestUpdate = ranged((ref: JObj, b: Int8Array, off: number, len: number) => { liveHash(ref).update(region(b, off, len)); }, [1, 2, 3]);
for (const n of ["EVP_DigestUpdate", "EVP_DigestSignUpdate", "EVP_DigestVerifyUpdate"])
  nc(`${n}(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;[BII)V`, digestUpdate);
nc("EVP_DigestFinal_ex(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;[BI)I", waits((ref: JObj, out: Int8Array, off: number) => {
  const c = ptr<MdCtx>(ref), h = liveHash(ref), dst = region(out, off, h.size);
  c.hash = null; c.md = null;
  return after(h.final(), (d) => { dst.set(d); return d.length; });
}));
nc("EVP_MD_CTX_copy_ex(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;)I", (dst: JObj, src: JObj) => {
  const d = ptr<MdCtx>(dst), s = ptr<MdCtx>(src);
  d.md = s.md; d.hash = s.hash?.clone() ?? null;
  return 1;
});

// ── HMAC
type HmacCtx = { mac: Hmac | null };
nc("HMAC_CTX_new()J", () => ownedHandle({ mac: null } satisfies HmacCtx));
nc("HMAC_CTX_free(J)V", (h: bigint) => release(h));
nc("HMAC_Init_ex(Lcom/android/org/conscrypt/NativeRef$HMAC_CTX;[BJ)V", (ref: JObj, key: Int8Array | null, md: bigint) => {
  const c = ptr<HmacCtx>(ref);
  // a null key with the same digest restarts the keyed state, as HMAC_Init_ex(ctx, NULL, 0, md) does
  if (key === null) { if (!c.mac) throw runtimeError("HMAC_Init_ex"); c.mac.reset(); return; }
  const d = mdOf(md);
  c.mac = new Hmac(d.make, u8(key));
});
const liveMac = (ref: JObj): Hmac => {
  const c = ptr<HmacCtx>(ref);
  if (!c.mac) throw runtimeError("HMAC_CTX not initialized");
  return c.mac;
};
nc("HMAC_Update(Lcom/android/org/conscrypt/NativeRef$HMAC_CTX;[BII)V", ranged((ref: JObj, b: Int8Array, off: number, len: number) => {
  liveMac(ref).update(region(b, off, len));
}, [1, 2, 3]));
nc("HMAC_Final(Lcom/android/org/conscrypt/NativeRef$HMAC_CTX;)[B", (ref: JObj) => i8(liveMac(ref).digest()));
nc("HMAC_Reset(Lcom/android/org/conscrypt/NativeRef$HMAC_CTX;)V", (ref: JObj) => liveMac(ref).reset());

// ── BoringSSL's error strings, and the exception conscrypt's throwExceptionFromBoringSSLError picks
const LIBS: Record<number, string> = { 4: "RSA routines", 6: "public key routines", 12: "ASN.1 encoding routines", 15: "elliptic curve routines", 26: "ECDSA routines", 30: "Cipher functions", 11: "X.509 certificate routines" };
export const sslError = (cls: string, lib: number, reason: number, name: string) =>
  rt.mkThrowable(cls, `error:${((lib << 24) | reason).toString(16).padStart(8, "0")}:${LIBS[lib]}:OPENSSL_internal:${name}`);
const CIPHER = 30;
const badDecrypt = (cls = "javax/crypto/BadPaddingException") => sslError(cls, CIPHER, 101, "BAD_DECRYPT");

// ── EVP_CIPHER: AES (ECB, CBC, CTR), DES/3DES (CBC) and RC4, with EVP's buffering and PKCS#7 padding
type CipherDesc = { name: string; keyLen: number; ivLen: number; block: number; mode: "ecb" | "cbc" | "ctr" | "stream"; make: (key: Uint8Array) => BlockCipher };
const cipherByName = new Map<string, CipherDesc>();
for (const bits of [128, 192, 256]) for (const mode of ["ecb", "cbc", "ctr"] as const) {
  cipherByName.set(`aes-${bits}-${mode}`, { name: `aes-${bits}-${mode}`, keyLen: bits / 8, ivLen: mode === "ecb" ? 0 : 16, block: mode === "ctr" ? 1 : 16, mode, make: aes });
}
for (const [name, keyLen] of [["des-cbc", 8], ["des-ede-cbc", 16], ["des-ede3-cbc", 24]] as const) cipherByName.set(name, { name, keyLen, ivLen: 8, block: 8, mode: "cbc", make: des });
cipherByName.set("rc4", { name: "rc4", keyLen: 16, ivLen: 0, block: 1, mode: "stream", make: () => { throw new Error("rc4 has no block cipher"); } });
const cipherOf = (h: bigint): CipherDesc => {
  const c = deref<CipherDesc>(h);
  if (!c?.mode) throw rt.mkThrowable("java/lang/NullPointerException", "cipher == null");
  return c;
};
nc("EVP_get_cipherbyname(Ljava/lang/String;)J", (name: string) => {
  if (name == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const c = cipherByName.get(name.toLowerCase());
  return c ? handle(c) : 0n;
});
nc("EVP_CIPHER_iv_length(J)I", (h: bigint) => cipherOf(h).ivLen);
class CipherCtx {
  desc: CipherDesc | null = null;
  encrypting = true;
  padding = true;
  keyLen = 0;
  bc: BlockCipher | null = null;
  rc4: Rc4 | null = null;
  oiv = new Uint8Array(0);
  iv = new Uint8Array(0);
  buf = new Uint8Array(16); bufLen = 0;
  last = new Uint8Array(16); finalUsed = false;
  stream = new Uint8Array(16); used = 16;
}
nc("EVP_CIPHER_CTX_new()J", () => ownedHandle(new CipherCtx()));
nc("EVP_CIPHER_CTX_free(J)V", (h: bigint) => release(h));
nc("EVP_CipherInit_ex(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;J[B[BZ)V", (ref: JObj, cipher: bigint, key: Int8Array | null, iv: Int8Array | null, encrypting: number) => {
  const c = ptr<CipherCtx>(ref);
  if (cipher) { const d = cipherOf(cipher); c.desc = d; c.keyLen = d.keyLen; c.padding = true; c.bc = null; c.rc4 = null; }
  const d = c.desc;
  if (!d) throw runtimeError("EVP_CipherInit_ex: no cipher");
  c.encrypting = !!encrypting;
  if (key) {
    if (key.length !== c.keyLen) throw sslError("java/security/InvalidKeyException", CIPHER, 111, "INVALID_KEY_LENGTH");
    if (d.mode === "stream") c.rc4 = new Rc4(u8(key).slice());
    else c.bc = d.make(u8(key).slice());
  }
  if (iv) c.oiv = u8(iv).slice(0, d.ivLen);
  c.iv = c.oiv.slice();
  c.bufLen = 0; c.finalUsed = false; c.used = 16;
});
nc("EVP_CIPHER_CTX_set_key_length(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;I)V", (ref: JObj, len: number) => {
  const c = ptr<CipherCtx>(ref);
  if (len !== c.keyLen && c.desc?.mode !== "stream") throw sslError("java/lang/RuntimeException", CIPHER, 111, "INVALID_KEY_LENGTH");
  c.keyLen = len;
});
nc("EVP_CIPHER_CTX_set_padding(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;Z)V", (ref: JObj, on: number) => { ptr<CipherCtx>(ref).padding = !!on; });
nc("EVP_CIPHER_CTX_block_size(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;)I", (ref: JObj) => ptr<CipherCtx>(ref).desc?.block ?? 0);
nc("get_EVP_CIPHER_CTX_buf_len(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;)I", (ref: JObj) => ptr<CipherCtx>(ref).bufLen);
nc("get_EVP_CIPHER_CTX_final_used(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;)Z", (ref: JObj) => +ptr<CipherCtx>(ref).finalUsed);
/** whole blocks (or any length for a stream mode) through the keyed primitive, in place */
function transform(c: CipherCtx, data: Uint8Array) {
  const d = c.desc!;
  if (d.mode === "stream") c.rc4!.apply(data);
  else if (d.mode === "ctr") c.used = ctr(c.bc!, c.iv, data, c.stream, c.used);
  else if (d.mode === "cbc") cbc(c.bc!, data, c.iv, c.encrypting);
  else ecb(c.bc!, data, c.encrypting);
}
/** EVP_EncryptUpdate's buffering: whole blocks out, a partial block held */
function blockUpdate(c: CipherCtx, input: Uint8Array): Uint8Array {
  const n = c.desc!.block;
  if (n === 1) { const out = input.slice(); transform(c, out); return out; }
  const total = c.bufLen + input.length, whole = total - (total % n), out = new Uint8Array(whole);
  if (whole) {
    out.set(c.buf.subarray(0, c.bufLen));
    out.set(input.subarray(0, whole - c.bufLen), c.bufLen);
    transform(c, out);
    c.buf.set(input.subarray(whole - c.bufLen));
  } else c.buf.set(input, c.bufLen);
  c.bufLen = total - whole;
  return out;
}
function cipherUpdate(c: CipherCtx, input: Uint8Array): Uint8Array {
  const n = c.desc!.block;
  if (c.encrypting || !c.padding || n === 1) return blockUpdate(c, input);
  // EVP_DecryptUpdate holds the last whole block back, since it may be the padding
  const out = blockUpdate(c, input), held = c.finalUsed ? c.last.slice(0, n) : null;
  let result = held ? Uint8Array.from([...held, ...out]) : out;
  if (c.bufLen === 0 && result.length) { c.last.set(result.subarray(result.length - n)); c.finalUsed = true; result = result.subarray(0, result.length - n); }
  else c.finalUsed = false;
  return result;
}
nc("EVP_CipherUpdate(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;[BI[BII)I", ranged((ref: JObj, out: Int8Array, outOff: number, input: Int8Array, inOff: number, inLen: number) => {
  const c = ptr<CipherCtx>(ref);
  if (!c.desc || (!c.bc && !c.rc4)) throw runtimeError("EVP_CipherUpdate: not initialized");
  const r = cipherUpdate(c, region(input, inOff, inLen).slice());
  region(out, outOff, r.length).set(r);
  return r.length;
}, [3, 4, 5]));
nc("EVP_CipherFinal_ex(Lcom/android/org/conscrypt/NativeRef$EVP_CIPHER_CTX;[BI)I", (ref: JObj, out: Int8Array, outOff: number) => {
  const c = ptr<CipherCtx>(ref), n = c.desc?.block ?? 1;
  let r: Uint8Array | null = new Uint8Array(0);
  if (n > 1 && !c.padding && c.bufLen) throw sslError("javax/crypto/IllegalBlockSizeException", CIPHER, 106, "DATA_NOT_MULTIPLE_OF_BLOCK_LENGTH");
  if (n > 1 && c.padding) {
    if (c.encrypting) transform(c, r = pkcs7Pad(c.buf.subarray(0, c.bufLen), n));
    else {
      if (c.bufLen || !c.finalUsed) throw sslError("javax/crypto/IllegalBlockSizeException", CIPHER, 124, "WRONG_FINAL_BLOCK_LENGTH");
      if (!(r = pkcs7Unpad(c.last.subarray(0, n), n))) throw badDecrypt();
      c.finalUsed = false;
    }
  }
  region(out, outOff, r.length).set(r);
  c.bufLen = 0;
  return r.length;
});

// ── EVP_AEAD: AES-GCM and ChaCha20-Poly1305, one-shot
type AeadDesc = { name: string; keyLens: number[]; nonce: number; fixedNonce?: boolean; make: (key: Uint8Array) => Aead };
const AEADS: Record<string, AeadDesc> = {
  aes_128_gcm: { name: "aes-128-gcm", keyLens: [16], nonce: 12, make: (k) => new AesGcm(k) },
  aes_256_gcm: { name: "aes-256-gcm", keyLens: [32], nonce: 12, make: (k) => new AesGcm(k) },
  chacha20_poly1305: { name: "chacha20-poly1305", keyLens: [32], nonce: 12, fixedNonce: true, make: (k) => new ChaCha20Poly1305(k) },
};
for (const [n, d] of Object.entries(AEADS)) nc(`EVP_aead_${n}()J`, () => handle(d));
const aeadOf = (h: bigint): AeadDesc => {
  const a = deref<AeadDesc>(h);
  if (!a?.keyLens) throw rt.mkThrowable("java/lang/NullPointerException", "aead == null");
  return a;
};
nc("EVP_AEAD_max_overhead(J)I", (h: bigint) => (aeadOf(h), 16));
nc("EVP_AEAD_nonce_length(J)I", (h: bigint) => aeadOf(h).nonce);
function aeadFor(h: bigint, key: Int8Array | null, tagLen: number, nonce: Int8Array | null): Aead {
  const d = aeadOf(h);
  if (!nonce?.length) throw sslError("java/security/InvalidAlgorithmParameterException", CIPHER, 112, "INVALID_NONCE_SIZE");
  if (d.fixedNonce && nonce.length !== d.nonce) throw sslError("java/security/InvalidAlgorithmParameterException", CIPHER, 122, "UNSUPPORTED_NONCE_SIZE");
  if (!key) throw rt.mkThrowable("java/lang/NullPointerException", "key == null");
  if (!d.keyLens.includes(key.length)) throw sslError("java/security/InvalidKeyException", CIPHER, 102, "BAD_KEY_LENGTH");
  if (tagLen > 16) throw sslError("java/security/InvalidAlgorithmParameterException", CIPHER, 117, "TAG_TOO_LARGE");
  return d.make(u8(key).slice());
}
const tagOr16 = (n: number) => n === 0 ? 16 : n;
/** `data` sealed or opened into at most `room` bytes */
function aead(seal: boolean, h: bigint, key: Int8Array, tagLen: number, nonce: Int8Array, data: Uint8Array, aad: Int8Array | null, room: number): Uint8Array {
  const a = aeadFor(h, key, tagLen = tagOr16(tagLen), nonce), extra = aad ? u8(aad) : new Uint8Array(0);
  const r = seal ? a.seal(u8(nonce), data, extra, tagLen) : a.open(u8(nonce), data, extra, tagLen);
  if (!r) throw badDecrypt("javax/crypto/AEADBadTagException");
  if (r.length > room) throw sslError("javax/crypto/ShortBufferException", CIPHER, 103, "BUFFER_TOO_SMALL");
  return r;
}
const aeadArray = (seal: boolean) => (h: bigint, key: Int8Array, tagLen: number, out: Int8Array, outOff: number, nonce: Int8Array, input: Int8Array, inOff: number, inLen: number, aad: Int8Array | null) => {
  const r = aead(seal, h, key, tagLen, nonce, region(input, inOff, inLen), aad, out.length - outOff);
  region(out, outOff, r.length).set(r);
  return r.length;
};
nc("EVP_AEAD_CTX_seal(J[BI[BI[B[BII[B)I", aeadArray(true));
nc("EVP_AEAD_CTX_open(J[BI[BI[B[BII[B)I", aeadArray(false));
// the direct-buffer forms: input from position to limit, output written at position; the caller moves both
function aeadBuf(seal: boolean, h: bigint, key: Int8Array, tagLen: number, out: JBuffer | null, nonce: Int8Array, input: JBuffer | null, aad: Int8Array | null) {
  if (!out || !input) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (!addressOf(out) || !addressOf(input)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Non-direct ByteBuffer");
  return after(readRemainingBytes(input), bytes => {
    const r = aead(seal, h, key, tagLen, nonce, bytes.slice(), aad, limit(out) - position(out));
    return after(writeRemainingBytes(out,r), () => r.length);
  });
}
nc("EVP_AEAD_CTX_seal_buf(J[BILjava/nio/ByteBuffer;[BLjava/nio/ByteBuffer;[B)I", waits((h: bigint, key: Int8Array, tagLen: number, out: JBuffer, nonce: Int8Array, input: JBuffer, aad: Int8Array | null) =>
  aeadBuf(true, h, key, tagLen, out, nonce, input, aad)));
nc("EVP_AEAD_CTX_open_buf(J[BILjava/nio/ByteBuffer;[BLjava/nio/ByteBuffer;[B)I", waits((h: bigint, key: Int8Array, tagLen: number, out: JBuffer, nonce: Int8Array, input: JBuffer, aad: Int8Array | null) =>
  aeadBuf(false, h, key, tagLen, out, nonce, input, aad)));
nc("chacha20_encrypt_decrypt([BI[BII[B[BI)V", (input: Int8Array, inOff: number, out: Int8Array, outOff: number, len: number, key: Int8Array, nonce: Int8Array, counter: number) => {
  const data = region(input, inOff, len).slice();
  chacha20(u8(key), u8(nonce), counter, data);
  region(out, outOff, len).set(data);
});

// ── EVP_PKEY: RSA, EC and X25519 keys; a key an opaque Java PrivateKey backs signs and decrypts
// through conscrypt's CryptoUpcalls, as BoringSSL's custom key methods do
type Wrapped = { type: typeof EVP_PKEY_RSA; wrapper: JObj; rsa: Rsa } | { type: typeof EVP_PKEY_EC; wrapper: JObj; curve: Curve };
export type Key = PKey | Wrapped;
const RSA = 4, EC = 15, EVP = 6;
export const keyOf = (ref: JObj) => ptr<Key>(ref);
export const newKey = (k: Key) => ownedHandle(k);
const javaBytes = (v: bigint) => i8(concat([Uint8Array.of(0), bigToBytes(v)]));
const bnArg = (b: Int8Array | null) => b === null ? undefined : fromSigned(u8(b));
export const parsing = (msg: string) => rt.mkThrowable("com/android/org/conscrypt/OpenSSLX509CertificateFactory$ParsingException", msg);
nc("EVP_parse_public_key([B)J", (b: Int8Array) => {
  return orDer(() => newKey(parsePublicKey(u8(b ?? rt.npe()))), () => parsing("Error parsing public key"));
});
nc("EVP_parse_private_key([B)J", (b: Int8Array) => {
  return orDer(() => newKey(parsePrivateKey(u8(b ?? rt.npe()))), () => parsing("Error parsing private key"));
});
nc("EVP_marshal_public_key(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)[B", (ref: JObj) => {
  const k = keyOf(ref);
  return i8(marshalPublicKey(publicOf(k)));
});
nc("EVP_marshal_private_key(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)[B", (ref: JObj) => {
  const k = keyOf(ref), der = "wrapper" in k ? null : marshalPrivateKey(k);
  if (!der) throw sslError("java/lang/RuntimeException", EVP, 124, "INTERNAL_ERROR");
  return i8(der);
});
/** the key a public key marshals from: a wrapped RSA key's modulus and exponent */
function publicOf(k: Key): PKey {
  if (!("wrapper" in k)) return k;
  if (k.type === EVP_PKEY_RSA) return { type: EVP_PKEY_RSA, rsa: k.rsa };
  throw sslError("java/lang/RuntimeException", EVP, 124, "INTERNAL_ERROR");
}
nc("EVP_PKEY_type(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", (ref: JObj) => keyOf(ref).type);
nc("EVP_PKEY_free(J)V", (h: bigint) => release(h));
nc("EVP_PKEY_cmp(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", (a: JObj, b: JObj) => {
  const x = keyOf(a), y = keyOf(b);
  if (x.type !== y.type) return -1;
  return +sameBytes(marshalPublicKey(publicOf(x)), marshalPublicKey(publicOf(y)));
});
/** an RSA key's numbers; a wrapped key has only the public ones */
const rsaKey = (k: Key): Rsa => {
  if (k.type !== EVP_PKEY_RSA) throw sslError("java/security/InvalidKeyException", EVP, 124, "EXPECTING_AN_RSA_KEY");
  return k.rsa;
};
const rsaOf = (ref: JObj) => rsaKey(keyOf(ref));
nc("EVP_PKEY_new_RSA([B[B[B[B[B[B[B[B)J", (...f: (Int8Array | null)[]) => {
  const [n, e, d, p, q, dp, dq, qinv] = f.map(bnArg);
  if (n === undefined) throw rt.mkThrowable("java/lang/NullPointerException", "n == null");
  return newKey({ type: EVP_PKEY_RSA, rsa: { n, e: e ?? 0n, d, p, q, dp, dq, qinv } });
});
nc("get_RSA_public_params(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)[[B", (ref: JObj) => {
  const r = rsaOf(ref);
  return jarray([javaBytes(r.n), javaBytes(r.e)], "[B");
});
nc("get_RSA_private_params(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)[[B", (ref: JObj) => {
  const r = rsaOf(ref);
  return jarray([r.n, r.e, r.d, r.p, r.q, r.dp, r.dq, r.qinv].map((v) => v === undefined || (v === 0n && r.e === 0n) ? null : javaBytes(v)), "[B");
});
nc("RSA_size(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", (ref: JObj) => rsaBytes(rsaOf(ref)));
nc("RSA_generate_key_ex(I[B)J", async (bits: number, e: Int8Array) => newKey({ type: EVP_PKEY_RSA, rsa: await generateRsa(bits, fromSigned(u8(e))) }));
const RSA_PKCS1_PADDING = 1, RSA_NO_PADDING = 3, RSA_PKCS1_OAEP_PADDING = 4, RSA_PKCS1_PSS_PADDING = 6;
const rsaErr = (cls: string, reason: number, name: string) => sslError(cls, RSA, reason, name);
// EVP_PKEY_CTX: the padding parameters of an RSA encryption or signature
type RsaParams = { key: Key; padding: number; oaepMd: string; mgf1Md: string | null; label: Uint8Array; saltLen: number };
const pkeyCtx = (key: Key, padding = RSA_PKCS1_PADDING): RsaParams => ({ key, padding, oaepMd: "sha1", mgf1Md: null, label: new Uint8Array(0), saltLen: -2 });
/** the padding the parameters name, for a signature over `md` or (without one) an encryption */
function padOf(p: RsaParams, md: string | null = null): RsaPad {
  if (p.padding === RSA_PKCS1_PADDING) return { kind: "pkcs1", md };
  if (p.padding === RSA_NO_PADDING) return { kind: "none" };
  if (p.padding === RSA_PKCS1_OAEP_PADDING && !md) return { kind: "oaep", md: p.oaepMd, mgf: p.mgf1Md ?? p.oaepMd, label: p.label };
  if (p.padding === RSA_PKCS1_PSS_PADDING && md) return { kind: "pss", md, mgf: p.mgf1Md ?? md, salt: p.saltLen };
  throw rsaErr("java/lang/RuntimeException", 143, "UNKNOWN_PADDING_TYPE");
}
/** the key applied to a modulus-length input below the modulus */
function rsaRun(k: Rsa, m: Uint8Array, priv: boolean): Uint8Array {
  if (m.length !== rsaBytes(k)) throw rsaErr("javax/crypto/BadPaddingException", 112, "DATA_LEN_NOT_EQUAL_TO_MOD_LEN");
  const r = rsaApply(k, m, priv);
  if (!r) throw rsaErr("javax/crypto/BadPaddingException", 115, "DATA_TOO_LARGE_FOR_MODULUS");
  return r;
}
function rsaEncrypt(k: Rsa, m: Uint8Array, pad: RsaPad): Uint8Array {
  const em = emeEncode(k, pad, m);
  if (!em) throw rsaErr("javax/crypto/IllegalBlockSizeException", 114, "DATA_TOO_LARGE_FOR_KEY_SIZE");
  return rsaRun(k, em, false);
}
function unpadded(k: Rsa, pad: RsaPad, em: Uint8Array): Uint8Array {
  const m = emeDecode(k, pad, em);
  if (!m) throw pad.kind === "oaep" ? rsaErr("javax/crypto/BadPaddingException", 133, "OAEP_DECODING_ERROR") : rsaErr("javax/crypto/BadPaddingException", 137, "PKCS_DECODING_ERROR");
  return m;
}
/** the four raw RSA natives: (flen, from, to, key, padding) → bytes written */
function rsaRaw(op: "pubenc" | "privdec" | "privenc" | "pubdec") {
  return waits((flen: number, from: Int8Array, to: Int8Array, ref: JObj, padding: number): number | Promise<number> => {
    const k = keyOf(ref), input = region(from, 0, flen).slice();
    const finish = (r: Uint8Array) => { region(to, 0, r.length).set(r); return r.length; };
    if ("wrapper" in k && (op === "privdec" || op === "privenc")) {
      const call = op === "privdec" ? scall(UPCALLS, "rsaDecryptWithPrivateKey", "(Ljava/security/PrivateKey;I[B)[B", k.wrapper, padding, i8(input))
        : scall(UPCALLS, "rsaSignDigestWithPrivateKey", "(Ljava/security/PrivateKey;I[B)[B", k.wrapper, padding, i8(input));
      return after(call, (r: Int8Array | null) => { if (!r) throw rsaErr("java/security/SignatureException", 124, "INTERNAL_ERROR"); return finish(u8(r)); });
    }
    const r = rsaKey(k), pad = padOf(pkeyCtx(k, padding));
    if (op === "pubenc") return finish(rsaEncrypt(r, input, pad));
    if (op === "privdec") return finish(unpadded(r, pad, rsaRun(r, input, true)));
    if (op === "privenc") {
      const em = emsaEncode(r, pad, input);
      if (!em) throw rsaErr("java/security/SignatureException", 114, "DATA_TOO_LARGE_FOR_KEY_SIZE");
      return finish(rsaRun(r, em, true));
    }
    const em = rsaRun(r, input, false);
    if (pad.kind === "none") return finish(em);
    const m = pkcs1Unpad(em, 1);
    if (!m) throw rsaErr("java/security/SignatureException", 107, "BLOCK_TYPE_IS_NOT_01");
    return finish(m);
  });
}
nc("RSA_public_encrypt(I[B[BLcom/android/org/conscrypt/NativeRef$EVP_PKEY;I)I", rsaRaw("pubenc"));
nc("RSA_private_decrypt(I[B[BLcom/android/org/conscrypt/NativeRef$EVP_PKEY;I)I", rsaRaw("privdec"));
nc("RSA_private_encrypt(I[B[BLcom/android/org/conscrypt/NativeRef$EVP_PKEY;I)I", rsaRaw("privenc"));
nc("RSA_public_decrypt(I[B[BLcom/android/org/conscrypt/NativeRef$EVP_PKEY;I)I", rsaRaw("pubdec"));

const params = (h: bigint): RsaParams => {
  const p = deref<RsaParams>(h);
  if (!p?.key) throw rt.mkThrowable("java/lang/NullPointerException", "ctx == null");
  return p;
};
nc("EVP_PKEY_encrypt_init(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)J", (ref: JObj) => ownedHandle(pkeyCtx(keyOf(ref))));
nc("EVP_PKEY_decrypt_init(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)J", (ref: JObj) => ownedHandle(pkeyCtx(keyOf(ref))));
nc("EVP_PKEY_CTX_free(J)V", (h: bigint) => release(h));
nc("EVP_PKEY_CTX_set_rsa_padding(JI)V", (h: bigint, pad: number) => { params(h).padding = pad; });
nc("EVP_PKEY_CTX_set_rsa_pss_saltlen(JI)V", (h: bigint, len: number) => { params(h).saltLen = len; });
nc("EVP_PKEY_CTX_set_rsa_mgf1_md(JJ)V", (h: bigint, md: bigint) => { params(h).mgf1Md = mdOf(md).name; });
nc("EVP_PKEY_CTX_set_rsa_oaep_md(JJ)V", (h: bigint, md: bigint) => { params(h).oaepMd = mdOf(md).name; });
nc("EVP_PKEY_CTX_set_rsa_oaep_label(J[B)V", (h: bigint, label: Int8Array | null) => { params(h).label = label ? u8(label).slice() : new Uint8Array(0); });
const pkeyCrypt = (encrypt: boolean) => waits((ref: JObj, out: Int8Array, outOff: number, input: Int8Array, inOff: number, inLen: number) => {
  const p = ptr<RsaParams>(ref), k = p.key, r = rsaKey(k), pad = padOf(p), data = region(input, inOff, inLen).slice();
  const finish = (m: Uint8Array) => { region(out, outOff, m.length).set(m); return m.length; };
  // a wrapped key's upcall decrypts without padding; the padding is removed here
  if (!encrypt && "wrapper" in k)
    return after(scall(UPCALLS, "rsaDecryptWithPrivateKey", "(Ljava/security/PrivateKey;I[B)[B", k.wrapper, RSA_NO_PADDING, i8(data)), (em: Int8Array) => finish(unpadded(r, pad, u8(em))));
  return finish(encrypt ? rsaEncrypt(r, data, pad) : unpadded(r, pad, rsaRun(r, data, true)));
});
nc("EVP_PKEY_encrypt(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY_CTX;[BI[BII)I", pkeyCrypt(true));
nc("EVP_PKEY_decrypt(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY_CTX;[BI[BII)I", pkeyCrypt(false));

// EVP_DigestSign/Verify: the message digested as it streams, the key applied at the end
type SignCtx = MdCtx & { sign?: { key: Key; params: RsaParams; signing: boolean; pctx: bigint } };
function digestSignInit(signing: boolean) {
  return (ref: JObj, md: bigint, keyRef: JObj) => {
    const c = ptr<SignCtx>(ref), d = mdOf(md), key = keyOf(keyRef);
    if (key.type === EVP_PKEY_X25519) throw sslError("java/security/InvalidKeyException", EVP, 125, "OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    c.md = d; c.hash = deferred(d.name);
    const p = pkeyCtx(key);
    c.sign = { key, params: p, signing, pctx: weakHandle(p) };
    return c.sign.pctx;
  };
}
nc("EVP_DigestSignInit(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;JLcom/android/org/conscrypt/NativeRef$EVP_PKEY;)J", digestSignInit(true));
nc("EVP_DigestVerifyInit(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;JLcom/android/org/conscrypt/NativeRef$EVP_PKEY;)J", digestSignInit(false));
const directUpdate = waits((ref: JObj, address: bigint, len: number) => after(memoryAt(address, len), (b) => { liveHash(ref).update(b); }));
for (const n of ["EVP_DigestUpdateDirect", "EVP_DigestSignUpdateDirect", "EVP_DigestVerifyUpdateDirect"]) nc(`${n}(Lcom/android/org/conscrypt/NativeRef\$EVP_MD_CTX;JI)V`, directUpdate);
nc("HMAC_UpdateDirect(Lcom/android/org/conscrypt/NativeRef$HMAC_CTX;JI)V", waits((ref: JObj, address: bigint, len: number) => after(memoryAt(address, len), (b) => { liveMac(ref).update(b); })));
nc("EVP_DigestSignFinal(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;)[B", waits((ref: JObj) => {
  const c = ptr<SignCtx>(ref), s = c.sign;
  if (!s?.signing) throw runtimeError("EVP_DigestSignFinal: not initialized for signing");
  const digest = liveHash(ref).digest(), key = s.key, p = s.params;
  c.hash = deferred(c.md!.name);
  if (key.type === EVP_PKEY_EC) {
    if ("wrapper" in key) return scall(UPCALLS, "ecSignDigestWithPrivateKey", "(Ljava/security/PrivateKey;[B)[B", key.wrapper, i8(digest));
    const ec = key.ec;
    if (ec.priv === undefined) throw sslError("java/security/InvalidKeyException", EC, 123, "MISSING_PRIVATE_KEY");
    return i8(ecdsaSign(ec.curve, ec.priv, digest));
  }
  const r = rsaKey(key), em = emsaEncode(r, padOf(p, c.md!.name), digest);
  if (!em) throw rsaErr("java/security/SignatureException", 118, "DIGEST_TOO_BIG_FOR_RSA_KEY");
  if ("wrapper" in key) return scall(UPCALLS, "rsaSignDigestWithPrivateKey", "(Ljava/security/PrivateKey;I[B)[B", key.wrapper, RSA_NO_PADDING, i8(em));
  return i8(rsaRun(r, em, true));
}));
nc("EVP_DigestVerifyFinal(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;[BII)Z", ranged((ref: JObj, sig: Int8Array, off: number, len: number) => {
  const c = ptr<SignCtx>(ref), s = c.sign;
  if (!s || s.signing) throw runtimeError("EVP_DigestVerifyFinal: not initialized for verifying");
  const digest = liveHash(ref).digest(), key = s.key, p = s.params, sg = region(sig, off, len);
  c.hash = deferred(c.md!.name);
  if (key.type === EVP_PKEY_EC) return +(!("wrapper" in key) && ecdsaVerify(key.ec.curve, key.ec.pub, digest, sg));
  return +rsaVerify(rsaKey(key), padOf(p, c.md!.name), digest, sg);
}, [1, 2, 3]));

// ── EC groups, points and keys
type Group = { curve: Curve };
type EcPoint = { curve: Curve; pt: Point };
const groupOf = (ref: JObj) => ptr<Group>(ref).curve;
nc("EC_GROUP_new_by_curve_name(Ljava/lang/String;)J", (name: string) => {
  const c = curveByName(name ?? rt.npe());
  return c ? ownedHandle({ curve: c } satisfies Group) : 0n;
});
nc("EC_GROUP_new_arbitrary([B[B[B[B[B[BI)J", (p: Int8Array, a: Int8Array, b: Int8Array, gx: Int8Array, gy: Int8Array, n: Int8Array, h: number) => {
  const f = [p, a, b, gx, gy, n].map((v) => fromSigned(u8(v ?? rt.npe())));
  const named = CURVES.find((c) => c.p === f[0] && c.a === f[1] && c.b === f[2] && c.gx === f[3] && c.gy === f[4] && c.n === f[5]);
  const curve: Curve = named ?? { name: "", oid: "", bytes: (bitLength(f[0]) + 7) >> 3, p: f[0], a: f[1], b: f[2], gx: f[3], gy: f[4], n: f[5], h: BigInt(h) };
  if (!onCurve(curve, [curve.gx, curve.gy])) throw sslError("java/lang/RuntimeException", EC, 113, "POINT_IS_NOT_ON_CURVE");
  return ownedHandle({ curve } satisfies Group);
});
nc("EC_GROUP_clear_free(J)V", (h: bigint) => release(h));
nc("EC_GROUP_get_curve_name(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)Ljava/lang/String;", (ref: JObj) => groupOf(ref).name || null);
nc("EC_GROUP_get_curve(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)[[B", (ref: JObj) => { const c = groupOf(ref); return jarray([javaBytes(c.p), javaBytes(c.a), javaBytes(c.b)], "[B"); });
nc("EC_GROUP_get_order(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)[B", (ref: JObj) => javaBytes(groupOf(ref).n));
nc("EC_GROUP_get_cofactor(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)[B", (ref: JObj) => javaBytes(groupOf(ref).h));
nc("EC_GROUP_get_degree(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)I", (ref: JObj) => bitLength(groupOf(ref).p));
nc("EC_GROUP_get_generator(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)J", (ref: JObj) => { const c = groupOf(ref); return ownedHandle({ curve: c, pt: G(c) } satisfies EcPoint); });
nc("EC_POINT_new(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)J", (ref: JObj) => ownedHandle({ curve: groupOf(ref), pt: null } satisfies EcPoint));
nc("EC_POINT_clear_free(J)V", (h: bigint) => release(h));
nc("EC_POINT_set_affine_coordinates(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;Lcom/android/org/conscrypt/NativeRef$EC_POINT;[B[B)V", (g: JObj, ref: JObj, xb: Int8Array, yb: Int8Array) => {
  const c = groupOf(g), pt: [bigint, bigint] = [fromSigned(u8(xb)), fromSigned(u8(yb))];
  if (!onCurve(c, pt)) throw sslError("java/lang/RuntimeException", EC, 113, "POINT_IS_NOT_ON_CURVE");
  const p = ptr<EcPoint>(ref); p.curve = c; p.pt = pt;
});
nc("EC_POINT_get_affine_coordinates(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;Lcom/android/org/conscrypt/NativeRef$EC_POINT;)[[B", (_g: JObj, ref: JObj) => {
  const p = ptr<EcPoint>(ref).pt;
  if (!p) throw sslError("java/lang/RuntimeException", EC, 106, "POINT_AT_INFINITY");
  return jarray([javaBytes(p[0]), javaBytes(p[1])], "[B");
});
/** an EC key's curve and points; a wrapped key has only its curve */
const ecOf = (ref: JObj): { curve: Curve; pub?: [bigint, bigint]; priv?: bigint } => {
  const k = keyOf(ref);
  if (k.type !== EVP_PKEY_EC) throw sslError("java/security/InvalidKeyException", EVP, 124, "EXPECTING_AN_EC_KEY_KEY");
  return "wrapper" in k ? { curve: k.curve } : k.ec;
};
nc("EC_KEY_generate_key(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)J", (g: JObj) => newKey({ type: EVP_PKEY_EC, ec: generateEc(groupOf(g)) }));
nc("EVP_PKEY_new_EC_KEY(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;Lcom/android/org/conscrypt/NativeRef$EC_POINT;[B)J", (g: JObj, pubRef: JObj | null, priv: Int8Array | null) => {
  const curve = groupOf(g), d = priv ? fromSigned(u8(priv)) : undefined;
  if (d !== undefined && (d <= 0n || d >= curve.n)) throw sslError("java/security/InvalidKeyException", EC, 115, "WRONG_ORDER");
  const pub = pubRef ? ptr<EcPoint>(pubRef).pt : d !== undefined ? mul(curve, d, G(curve)) : null;
  if (!pub) throw sslError("java/security/InvalidKeyException", EC, 106, "POINT_AT_INFINITY");
  if (d !== undefined && pubRef) { const q = mul(curve, d, G(curve))!; if (q[0] !== pub[0] || q[1] !== pub[1]) throw sslError("java/security/InvalidKeyException", EC, 100, "INVALID_PRIVATE_KEY"); }
  return newKey({ type: EVP_PKEY_EC, ec: { curve, pub, priv: d } });
});
nc("EC_KEY_get1_group(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)J", (ref: JObj) => ownedHandle({ curve: ecOf(ref).curve } satisfies Group));
nc("EC_KEY_get_public_key(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)J", (ref: JObj) => {
  const e = ecOf(ref);
  if (!e.pub) throw runtimeError("EC_POINT_dup");
  return ownedHandle({ curve: e.curve, pt: e.pub } satisfies EcPoint);
});
nc("EC_KEY_get_private_key(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)[B", (ref: JObj) => { const d = ecOf(ref).priv; return d === undefined ? null : javaBytes(d); });
nc("EC_KEY_marshal_curve_name(Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)[B", (ref: JObj) => {
  const c = groupOf(ref);
  if (!c.oid) throw sslError("java/io/IOException", EC, 123, "UNKNOWN_GROUP");
  return i8(oidDer(c.oid));
});
nc("EC_KEY_parse_curve_name([B)J", (b: Int8Array) => {
  return orDer(() => ownedHandle({ curve: curveOfParams(parseOne(u8(b ?? rt.npe()))) } satisfies Group), () => rt.mkThrowable("java/io/IOException", "Error reading ASN.1 encoding"));
});
// ECDSA_size: the longest DER SEQUENCE of two INTEGERs the order's length allows
nc("ECDSA_size(Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", (ref: JObj) => {
  const l = (bitLength(ecOf(ref).curve.n) + 7) >> 3, lenLen = (n: number) => n < 128 ? 1 : n < 256 ? 2 : 3;
  const int = 1 + lenLen(l + 1) + l + 1;
  return 1 + lenLen(2 * int) + 2 * int;
});
nc("ECDSA_sign([B[BLcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", waits((digest: Int8Array, sig: Int8Array, ref: JObj) => {
  const k = keyOf(ref);
  const finish = (s: Uint8Array) => { region(sig, 0, s.length).set(s); return s.length; };
  if ("wrapper" in k) return after(scall(UPCALLS, "ecSignDigestWithPrivateKey", "(Ljava/security/PrivateKey;[B)[B", k.wrapper, digest), (s: Int8Array) => finish(u8(s)));
  const e = ecOf(ref);
  if (e.priv === undefined) throw sslError("java/security/InvalidKeyException", EC, 123, "MISSING_PRIVATE_KEY");
  return finish(ecdsaSign(e.curve, e.priv, u8(digest)));
}));
nc("ECDSA_verify([B[BLcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", (digest: Int8Array, sig: Int8Array, ref: JObj) => {
  const e = ecOf(ref);
  return +(!!e.pub && ecdsaVerify(e.curve, e.pub, u8(digest), u8(sig)));
});
nc("ECDH_compute_key([BILcom/android/org/conscrypt/NativeRef$EVP_PKEY;Lcom/android/org/conscrypt/NativeRef$EVP_PKEY;)I", (out: Int8Array, off: number, pubRef: JObj, privRef: JObj) => {
  const pub = ecOf(pubRef), priv = ecOf(privRef);
  if (pub.curve.p !== priv.curve.p || pub.curve.n !== priv.curve.n) throw sslError("java/security/InvalidKeyException", EC, 106, "INCOMPATIBLE_OBJECTS");
  if (priv.priv === undefined) throw sslError("java/security/InvalidKeyException", EC, 123, "MISSING_PRIVATE_KEY");
  const s = pub.pub ? mul(priv.curve, priv.priv, pub.pub) : null;
  if (!s) throw sslError("java/lang/IllegalStateException", EC, 106, "POINT_AT_INFINITY");
  const secret = bigToBytes(s[0], priv.curve.bytes);
  region(out, off, secret.length).set(secret);
  return secret.length;
});
nc("X25519_keypair([B[B)V", (pub: Int8Array, priv: Int8Array) => {
  const d = crypto.getRandomValues(new Uint8Array(32));
  region(priv, 0, 32).set(d);
  region(pub, 0, 32).set(x25519(d, X25519_BASE));
});
nc("X25519([B[B[B)Z", (out: Int8Array, priv: Int8Array, pub: Int8Array) => {
  const s = x25519(u8(priv), u8(pub));
  if (s.every((v) => v === 0)) return 0;
  region(out, 0, 32).set(s);
  return 1;
});
nc("EVP_raw_X25519_private_key([B)[B", (b: Int8Array) => {
  return orDer(() => {
    const k = parsePrivateKey(u8(b ?? rt.npe()));
    if (k.type !== EVP_PKEY_X25519 || !k.priv) throw new DerError("not X25519");
    return i8(k.priv);
  }, () => rt.mkThrowable("java/security/InvalidKeyException", "Invalid X25519 private key"));
});
// opaque keys (no encoding, e.g. AndroidKeyStore's): the public half comes along, the private operations go up to Java
const UPCALLS = "com/android/org/conscrypt/CryptoUpcalls";
nc("getRSAPrivateKeyWrapper(Ljava/security/PrivateKey;[B)J", (key: JObj, modulus: Int8Array) =>
  newKey({ type: EVP_PKEY_RSA, wrapper: key, rsa: { n: fromSigned(u8(modulus)), e: 0n } }));
nc("getECPrivateKeyWrapper(Ljava/security/PrivateKey;Lcom/android/org/conscrypt/NativeRef$EC_GROUP;)J", (key: JObj, g: JObj) => {
  const curve = groupOf(g);
  return newKey({ type: EVP_PKEY_EC, wrapper: key, curve });
});
