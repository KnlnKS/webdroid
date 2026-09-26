// javax.crypto — SecretKeySpec, IvParameterSpec, Cipher (AES) and Mac (HMAC) over WebCrypto, which is
// one-shot and async: update() buffers, doFinal() awaits the whole operation.
import { rt, JObj, driven, type Gen } from "../runtime";
import { vcall } from "./jlang";
import { defineException } from "./jlang";
import { mkIter } from "./jutil";
import { charsToString, concat, i8, u8, utf8 } from "../abi";
import { JKeyGenSpec } from "../../android/security";
import { JRsaPublicKey, JRsaPrivateKey, JOAEP, generateRsa, restoreRsa, rsaChain, rsaCrypt, binary } from "./jrsa";
import { generateEc, isEcCurve, curveOfParams } from "./jec";
import { caStoreMethods, parseX509 } from "./jx509";
import { type JBuffer, bufferView } from "./jnio";
import { JFilterInputStream, JFilterOutputStream, readStreamFully } from "./jio";

rt.markers("java/security/Key", "javax/crypto/SecretKey", "java/security/spec/KeySpec");
defineException("java/security/InvalidAlgorithmParameterException", "java/security/GeneralSecurityException");
for (const n of ["NoSuchPaddingException", "IllegalBlockSizeException", "BadPaddingException", "ShortBufferException"]) {
  defineException("javax/crypto/" + n, "java/security/GeneralSecurityException");
}
defineException("javax/crypto/AEADBadTagException", "javax/crypto/BadPaddingException");

const bytes = (b: Int8Array, off = 0, len = b.length - off): Uint8Array<ArrayBuffer> => u8(b, off, len).slice();

class JSecretKeySpec extends JObj {
  key = new Int8Array(0);
  algo = "";
  imported = new Map<string, CryptoKey>();
}
function mkSecretKey(key: Uint8Array, algo: string): JSecretKeySpec {
  const k = new JSecretKeySpec(); k.key = new Int8Array(key); k.algo = algo; return k;
}
function setKey(k: JSecretKeySpec, b: Int8Array, off: number, len: number, algo: string) {
  if (!len || algo == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", len ? "Missing argument" : "Empty key");
  k.key = i8(bytes(b, off, len));
  k.algo = algo;
}
async function cryptoKey(key: unknown, alg: string, usages: KeyUsage[], hash?: string): Promise<CryptoKey> {
  if (!(key instanceof JSecretKeySpec)) throw rt.mkThrowable("java/security/InvalidKeyException", key == null ? "No key" : "Unsupported key type");
  const id = alg + (hash ?? "");
  let k = key.imported.get(id);
  if (!k) {
    try { k = await crypto.subtle.importKey("raw", key.key, hash ? { name: alg, hash } : { name: alg }, false, usages); }
    catch (e) { throw rt.mkThrowable("java/security/InvalidKeyException", String(e)); }
    key.imported.set(id, k);
  }
  return k;
}
rt.register({
  name: "javax/crypto/spec/SecretKeySpec", ctor: JSecretKeySpec,
  ifaces: ["javax/crypto/SecretKey", "java/security/Key", "java/security/spec/KeySpec", "java/io/Serializable"],
  serialization: { uid: 6577238317307289933n, fields: [
    { name: "algorithm", desc: "Ljava/lang/String;", prop: "algo" },
    { name: "key", desc: "[B", prop: "key" },
  ] },
  methods: {
    "<init>([BLjava/lang/String;)V": function (this: JSecretKeySpec, b: Int8Array, algo: string) { setKey(this, b, 0, b.length, algo); },
    "<init>([BIILjava/lang/String;)V": function (this: JSecretKeySpec, b: Int8Array, off: number, len: number, algo: string) {
      setKey(this, b, off, len, algo);
    },
    "getAlgorithm()Ljava/lang/String;": function (this: JSecretKeySpec) { return this.algo; },
    "getEncoded()[B": function (this: JSecretKeySpec) { return new Int8Array(this.key); },
    "getFormat()Ljava/lang/String;": () => "RAW",
  },
});

class JPBEKeySpec extends JObj {
  password = new Uint16Array(0);
  salt = new Uint8Array(0);
  iterations = 0;
  bits = 0;
}
rt.register({
  name: "javax/crypto/spec/PBEKeySpec", ctor: JPBEKeySpec, ifaces: ["java/security/spec/KeySpec"],
  methods: {
    "<init>([C)V": function (this: JPBEKeySpec, password: Uint16Array) { this.password = password.slice(); },
    "<init>([C[BII)V": function (this: JPBEKeySpec, password: Uint16Array, salt: Int8Array, iterations: number, bits: number) {
      if (!salt.length || iterations <= 0 || bits <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid PBE parameters");
      this.password = password.slice(); this.salt = bytes(salt); this.iterations = iterations; this.bits = bits;
    },
    "clearPassword()V": function (this: JPBEKeySpec) { this.password.fill(0); },
    "getPassword()[C": function (this: JPBEKeySpec) { return this.password.slice(); },
    "getSalt()[B": function (this: JPBEKeySpec) { return new Int8Array(this.salt); },
    "getIterationCount()I": function (this: JPBEKeySpec) { return this.iterations; },
    "getKeyLength()I": function (this: JPBEKeySpec) { return this.bits; },
  },
});

class JSecretKeyFactory extends JObj { algorithm = ""; }
function secretKeyFactory(algorithm: string): JSecretKeyFactory {
  if (algorithm.toUpperCase() !== "PBKDF2WITHHMACSHA1") throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algorithm);
  const factory = new JSecretKeyFactory(); factory.algorithm = algorithm; return factory;
}
rt.register({
  name: "javax/crypto/SecretKeyFactory", ctor: JSecretKeyFactory,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljavax/crypto/SecretKeyFactory;": secretKeyFactory,
    "getAlgorithm()Ljava/lang/String;": function (this: JSecretKeyFactory) { return this.algorithm; },
    "generateSecret(Ljava/security/spec/KeySpec;)Ljavax/crypto/SecretKey;": driven(function* (this: JSecretKeyFactory, spec: JPBEKeySpec): Gen {
      if (!(spec instanceof JPBEKeySpec) || !spec.salt.length || spec.iterations <= 0 || spec.bits <= 0) {
        throw rt.mkThrowable("java/security/spec/InvalidKeySpecException", "PBEKeySpec required");
      }
      const material = (yield crypto.subtle.importKey("raw", utf8.enc.encode(charsToString(spec.password, 0, spec.password.length)), "PBKDF2", false, ["deriveBits"]));
      const derived = (yield crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: spec.salt, iterations: spec.iterations }, material, spec.bits));
      return mkSecretKey(new Uint8Array(derived), this.algorithm);
    }),
  },
});

class JIvSpec extends JObj { iv = new Uint8Array(0); }
class JIvParameterSpec extends JIvSpec {}
class JGCMParameterSpec extends JIvSpec { tLen = 128; }
rt.register({
  name: "javax/crypto/spec/IvParameterSpec", ctor: JIvParameterSpec, ifaces: ["java/security/spec/AlgorithmParameterSpec"],
  methods: {
    "<init>([B)V": function (this: JIvParameterSpec, b: Int8Array) { this.iv = bytes(b); },
    "<init>([BII)V": function (this: JIvParameterSpec, b: Int8Array, off: number, len: number) { this.iv = bytes(b, off, len); },
    "getIV()[B": function (this: JIvParameterSpec) { return new Int8Array(this.iv); },
  },
});
rt.register({
  name: "javax/crypto/spec/GCMParameterSpec", ctor: JGCMParameterSpec, ifaces: ["java/security/spec/AlgorithmParameterSpec"],
  methods: {
    "<init>(I[B)V": function (this: JGCMParameterSpec, t: number, b: Int8Array) { this.tLen = t; this.iv = bytes(b); },
    "<init>(I[BII)V": function (this: JGCMParameterSpec, t: number, b: Int8Array, off: number, len: number) {
      this.tLen = t; this.iv = bytes(b, off, len);
    },
    "getTLen()I": function (this: JGCMParameterSpec) { return this.tLen; },
    "getIV()[B": function (this: JGCMParameterSpec) { return new Int8Array(this.iv); },
  },
});

const MODES: Record<string, string> = { ECB: "AES-ECB", CBC: "AES-CBC", GCM: "AES-GCM", CTR: "AES-CTR" };
const ZERO_IV = new Uint8Array(16);
class JCipher extends JObj {
  transformation = "";
  alg = "AES-CBC";
  padded = true;
  opmode = 0;
  key: CryptoKey | null = null;
  rsa: JRsaPublicKey | JRsaPrivateKey | null = null;
  oaep = new JOAEP();
  iv: Uint8Array<ArrayBuffer> | null = null;
  tagLength = 128;
  parts: Uint8Array[] = [];
  aad: Uint8Array[] = [];
}
rt.register({ name: "javax/crypto/CipherSpi", ctor: class extends JObj {}, methods: { "<init>()V": () => {} } });
class JCipherOutputStream extends JFilterOutputStream { cipher: JCipher | null = null; closed = false; }
rt.register({
  name: "javax/crypto/CipherOutputStream", ctor: JCipherOutputStream, sup: "java/io/FilterOutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;Ljavax/crypto/Cipher;)V": function (this: JCipherOutputStream, out: unknown, cipher: JCipher) {
      this.out = out; this.cipher = cipher;
    },
    "write(I)V": driven(function* (this: JCipherOutputStream, b: number): Gen {
      const result: Int8Array = (yield vcall(this.cipher, "update", "([B)[B", Int8Array.of(b)));
      if (result?.length) (yield vcall(this.out, "write", "([B)V", result));
    }),
    "write([BII)V": driven(function* (this: JCipherOutputStream, bytes: Int8Array, off: number, len: number): Gen {
      if (!len) return;
      const result: Int8Array = (yield vcall(this.cipher, "update", "([BII)[B", bytes, off, len));
      if (result?.length) (yield vcall(this.out, "write", "([B)V", result));
    }),
    "close()V": driven(function* (this: JCipherOutputStream): Gen {
      if (this.closed) return;
      this.closed = true;
      try {
        const result: Int8Array = (yield vcall(this.cipher, "doFinal", "()[B"));
        if (result?.length) (yield vcall(this.out, "write", "([B)V", result));
        (yield vcall(this.out, "flush", "()V"));
      } finally {
        (yield vcall(this.out, "close", "()V"));
      }
    }),
  },
});
class JCipherInputStream extends JFilterInputStream {
  cipher: JCipher | null = null;
  plain: Int8Array | null = null;
  loading: Promise<void> | null = null;
  closed = false;
  async load() {
    if (this.plain) return;
    if (!this.loading) this.loading = (async () => {
      const encrypted = await readStreamFully(this.in_);
      this.plain = await vcall(this.cipher, "doFinal", "([B)[B", new Int8Array(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength));
    })();
    await this.loading;
  }
}
rt.register({
  name: "javax/crypto/CipherInputStream", ctor: JCipherInputStream, sup: "java/io/FilterInputStream",
  methods: {
    "<init>(Ljava/io/InputStream;Ljavax/crypto/Cipher;)V": function (this: JCipherInputStream, input: unknown, cipher: JCipher) {
      this.in_ = input; this.cipher = cipher;
    },
    "read()I": driven(function* (this: JCipherInputStream): Gen {
      if (this.closed) throw rt.mkThrowable("java/io/IOException", "Stream closed");
      (yield this.load());
      return this.pos < this.plain!.length ? this.plain![this.pos++]! & 0xff : -1;
    }),
    "read([BII)I": driven(function* (this: JCipherInputStream, bytes: Int8Array, off: number, len: number): Gen {
      if (!bytes) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (off < 0 || len < 0 || off > bytes.length - len) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      if (this.closed) throw rt.mkThrowable("java/io/IOException", "Stream closed");
      if (!len) return 0;
      (yield this.load());
      const count = Math.min(len, this.plain!.length - this.pos);
      if (!count) return -1;
      bytes.set(this.plain!.subarray(this.pos, this.pos + count), off);
      this.pos += count;
      return count;
    }),
    "available()I": function (this: JCipherInputStream) { return this.plain ? this.plain.length - this.pos : 0; },
    "skip(J)J": driven(function* (this: JCipherInputStream, count: bigint): Gen {
      if (this.closed) throw rt.mkThrowable("java/io/IOException", "Stream closed");
      if (count <= 0n) return 0n;
      (yield this.load());
      const skipped = Number(count < BigInt(this.plain!.length - this.pos) ? count : BigInt(this.plain!.length - this.pos));
      this.pos += skipped;
      return BigInt(skipped);
    }),
    "close()V": driven(function* (this: JCipherInputStream): Gen {
      if (this.closed) return;
      this.closed = true;
      this.plain = null;
      (yield vcall(this.in_, "close", "()V"));
    }),
    "markSupported()Z": () => 0,
  },
});
function getCipher(t: string, provider?: unknown): JCipher {
  const [alg, mode = "ECB", padding = "PKCS5Padding"] = t.split("/");
  const c = new JCipher();
  c.transformation = t;
  if (alg.toUpperCase() === "RSA" && /^(ECB|NONE)$/i.test(mode)) {
    if (typeof provider === "string" && !["AndroidKeyStoreBCWorkaround", "AndroidOpenSSL", "BC"].includes(provider)) throw rt.mkThrowable("java/security/NoSuchProviderException", provider);
    if (!/^OAEPPadding$/i.test(padding)) throw rt.mkThrowable("javax/crypto/NoSuchPaddingException", padding);
    c.alg = "RSA-OAEP";
    return c;
  }
  if (alg.toUpperCase() !== "AES" || !(c.alg = MODES[mode.toUpperCase()])) {
    throw rt.mkThrowable("java/security/NoSuchAlgorithmException", "No provider found for " + t);
  }
  c.padded = /^PKCS[57]PADDING$/i.test(padding);
  if (c.padded ? c.alg === "AES-GCM" || c.alg === "AES-CTR" : !/^NOPADDING$/i.test(padding)) {
    throw rt.mkThrowable("javax/crypto/NoSuchPaddingException", padding + " unsupported for " + mode);
  }
  return c;
}
async function initCipher(c: JCipher, opmode: number, key: unknown, params: unknown) {
  if (opmode < 1 || opmode > 4) throw rt.mkThrowable("java/security/InvalidParameterException", "Invalid operation mode");
  if (c.alg === "RSA-OAEP") {
    const encrypt = opmode === 1 || opmode === 3;
    if (encrypt ? !(key instanceof JRsaPublicKey) : !(key instanceof JRsaPrivateKey)) throw rt.mkThrowable("java/security/InvalidKeyException", "RSA key does not match operation");
    if (params != null && !(params instanceof JOAEP)) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "OAEP parameters required");
    c.rsa = key as JRsaPublicKey | JRsaPrivateKey; c.oaep = params ?? new JOAEP(); c.opmode = opmode; c.parts = []; c.iv = null;
    return;
  }
  c.key = await cryptoKey(key, c.alg === "AES-ECB" ? "AES-CBC" : c.alg, ["encrypt", "decrypt"]);
  c.opmode = opmode;
  c.parts = []; c.aad = [];
  c.iv = null;
  const gcm = c.alg === "AES-GCM";
  if (c.alg === "AES-ECB") {
    if (params != null) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "ECB mode cannot use IV");
  } else if (params instanceof JIvSpec) {
    if (gcm ? !params.iv.length : params.iv.length !== 16) {
      throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Wrong IV length: " + params.iv.length);
    }
    c.iv = params.iv;
    if (params instanceof JGCMParameterSpec) c.tagLength = params.tLen;
  } else if (params != null) {
    throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Unsupported parameter spec");
  } else if (opmode === 1 || opmode === 3) {
    c.iv = crypto.getRandomValues(new Uint8Array(gcm ? 12 : 16));
  } else {
    throw rt.mkThrowable("java/security/InvalidKeyException", "Parameters missing");
  }
}
// WebCrypto's AES-CBC always applies PKCS#7, so unpadded encryption drops the padding block it appends and
// unpadded decryption first appends E(pad ^ lastBlock) — a block that unpads to nothing and leaves the real
// last block intact. One block under a zero IV is a raw AES block, which is all ECB needs.
async function cbcRaw(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, enc: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const p = { name: "AES-CBC", iv };
  if (enc) return new Uint8Array(await crypto.subtle.encrypt(p, key, data), 0, data.length);
  const last = data.length ? data.subarray(data.length - 16) : iv;
  const ct = concat([data, await cbcRaw(key, ZERO_IV, last.map((b) => b ^ 0x10), true)]);
  return new Uint8Array(await crypto.subtle.decrypt(p, key, ct));
}
async function ecb(key: CryptoKey, data: Uint8Array<ArrayBuffer>, enc: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(data.length);
  for (let o = 0; o < data.length; o += 16) out.set(await cbcRaw(key, ZERO_IV, data.subarray(o, o + 16), enc), o);
  return out;
}
function pad(d: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = 16 - d.length % 16;
  return concat([d, new Uint8Array(n).fill(n)]);
}
function unpad(d: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const n = d[d.length - 1];
  if (!(n >= 1 && n <= 16 && n <= d.length) || !d.subarray(d.length - n).every((b) => b === n)) {
    throw rt.mkThrowable("javax/crypto/BadPaddingException", "pad block corrupted");
  }
  return d.slice(0, d.length - n);
}
async function doFinal(c: JCipher, b?: Int8Array, off = 0, len = b?.length): Promise<Int8Array> {
  if (!c.key && !c.rsa) throw rt.mkThrowable("java/lang/IllegalStateException", "Cipher not initialized");
  if (b) c.parts.push(bytes(b, off, len));
  let data = concat(c.parts);
  c.parts = [];
  if (c.rsa) return rsaCrypt(c.rsa, data, c.oaep);
  const key = c.key!, enc = c.opmode === 1 || c.opmode === 3;
  const op = enc ? "encrypt" : "decrypt";
  if (c.alg === "AES-CTR") return new Int8Array(await crypto.subtle[op]({ name: c.alg, counter: c.iv!, length: 128 }, key, data));
  if (c.alg === "AES-GCM") {
    const p: AesGcmParams = { name: c.alg, iv: c.iv!, tagLength: c.tagLength };
    if (c.aad.length) { p.additionalData = concat(c.aad); c.aad = []; }
    try { return new Int8Array(await crypto.subtle[op](p, key, data)); }
    catch { throw rt.mkThrowable("javax/crypto/AEADBadTagException", "Tag mismatch"); }
  }
  if (c.padded && enc) data = pad(data);
  if (data.length % 16) throw rt.mkThrowable("javax/crypto/IllegalBlockSizeException", "Input length not multiple of 16 bytes");
  const out = c.alg === "AES-ECB" ? await ecb(key, data, enc) : await cbcRaw(key, c.iv!, data, enc);
  return i8(c.padded && !enc ? unpad(out) : out);
}
function into(r: Int8Array, out: Int8Array, off: number): number {
  if (off + r.length > out.length) throw rt.mkThrowable("javax/crypto/ShortBufferException", "Output buffer too short");
  out.set(r, off);
  return r.length;
}
rt.register({
  name: "javax/crypto/Cipher", ctor: JCipher,
  statics: { ENCRYPT_MODE: 1, DECRYPT_MODE: 2, WRAP_MODE: 3, UNWRAP_MODE: 4 },
  methods: {
    "static getInstance(Ljava/lang/String;)Ljavax/crypto/Cipher;": getCipher,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/Cipher;": getCipher,
    "init(ILjava/security/Key;)V": driven(function* (this: JCipher, m: number, k: unknown): Gen { return initCipher(this, m, k, null); }),
    "init(ILjava/security/Key;Ljava/security/SecureRandom;)V": driven(function* (this: JCipher, m: number, k: unknown): Gen { return initCipher(this, m, k, null); }),
    "init(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V": driven(function* (this: JCipher, m: number, k: unknown, p: unknown): Gen {
      return initCipher(this, m, k, p);
    }),
    "init(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;Ljava/security/SecureRandom;)V":
      driven(function* (this: JCipher, m: number, k: unknown, p: unknown): Gen { return initCipher(this, m, k, p); }),
    "update([B)[B": function (this: JCipher, b: Int8Array) { this.parts.push(bytes(b)); return new Int8Array(0); },
    "update([BII)[B": function (this: JCipher, b: Int8Array, off: number, len: number) { this.parts.push(bytes(b, off, len)); return new Int8Array(0); },
    "update([BII[BI)I": function (this: JCipher, b: Int8Array, off: number, len: number) { this.parts.push(bytes(b, off, len)); return 0; },
    "updateAAD([B)V": function (this: JCipher, b: Int8Array) { if (this.alg !== "AES-GCM") throw rt.mkThrowable("java/lang/IllegalStateException", "No AAD accepted"); this.aad.push(bytes(b)); },
    "updateAAD([BII)V": function (this: JCipher, b: Int8Array, off: number, len: number) { if (this.alg !== "AES-GCM") throw rt.mkThrowable("java/lang/IllegalStateException", "No AAD accepted"); this.aad.push(bytes(b, off, len)); },
    "updateAAD(Ljava/nio/ByteBuffer;)V": function (this: JCipher, bb: JBuffer) {
      const v = bufferView(bb);
      const u = new Uint8Array(v.ab, v.byteFromPos, bb.lim - bb.pos);
      this.aad.push(new Uint8Array(u)); bb.pos = bb.lim;
    },
    "doFinal()[B": driven(function* (this: JCipher): Gen { return doFinal(this); }),
    "doFinal([B)[B": driven(function* (this: JCipher, b: Int8Array): Gen { return doFinal(this, b); }),
    "doFinal([BII)[B": driven(function* (this: JCipher, b: Int8Array, off: number, len: number): Gen { return doFinal(this, b, off, len); }),
    "doFinal([BI)I": driven(function* (this: JCipher, out: Int8Array, off: number): Gen { return into((yield doFinal(this)), out, off); }),
    "doFinal([BII[BI)I": driven(function* (this: JCipher, b: Int8Array, off: number, len: number, out: Int8Array, outOff: number): Gen {
      return into((yield doFinal(this, b, off, len)), out, outOff);
    }),
    "doFinal([BII[B)I": driven(function* (this: JCipher, b: Int8Array, off: number, len: number, out: Int8Array): Gen { return into((yield doFinal(this, b, off, len)), out, 0); }),
    "static getInstance(Ljava/lang/String;Ljava/security/Provider;)Ljavax/crypto/Cipher;": getCipher,
    "wrap(Ljava/security/Key;)[B": driven(function* (this: JCipher, key: JSecretKeySpec): Gen {
      if (this.opmode !== 3) throw rt.mkThrowable("java/lang/IllegalStateException", "Cipher not initialized for wrapping");
      if (!(key instanceof JSecretKeySpec)) throw rt.mkThrowable("java/security/InvalidKeyException", "Unsupported wrapped key");
      return doFinal(this, new Int8Array(key.key));
    }),
    "unwrap([BLjava/lang/String;I)Ljava/security/Key;": driven(function* (this: JCipher, wrapped: Int8Array, algorithm: string, type: number): Gen {
      if (this.opmode !== 4) throw rt.mkThrowable("java/lang/IllegalStateException", "Cipher not initialized for unwrapping");
      if (type !== 3) throw rt.mkThrowable("java/security/InvalidKeyException", "Unsupported wrapped key type");
      return mkSecretKey(new Uint8Array((yield doFinal(this, wrapped))), algorithm);
    }),
    "getParameters()Ljava/security/AlgorithmParameters;": () => null,
    "getBlockSize()I": function (this: JCipher) { return this.alg === "RSA-OAEP" ? 0 : 16; },
    "getOutputSize(I)I": function (this: JCipher, n: number) {
      if (this.rsa) return this.rsa.key().then((key) => Math.ceil(key.n.bitLength() / 8));
      return this.parts.reduce((s, p) => s + p.length, n) + 16;
    },
    "getIV()[B": function (this: JCipher) { return this.iv && new Int8Array(this.iv); },
    "getAlgorithm()Ljava/lang/String;": function (this: JCipher) { return this.transformation; },
  },
});

// Standard names plus the "HMAC-SHA256" / "HMAC/SHA256" aliases Android's providers accept.
const HMACS: Record<string, [string, number]> = {
  HMACSHA1: ["SHA-1", 20], HMACSHA256: ["SHA-256", 32], HMACSHA384: ["SHA-384", 48], HMACSHA512: ["SHA-512", 64],
};
class JMac extends JObj {
  algo = "";
  hash = "";
  len = 0;
  key: CryptoKey | null = null;
  parts: Uint8Array[] = [];
}
async function macFinal(m: JMac, b?: Int8Array): Promise<Int8Array> {
  if (!m.key) throw rt.mkThrowable("java/lang/IllegalStateException", "MAC not initialized");
  if (b) m.parts.push(bytes(b));
  const data = concat(m.parts);
  m.parts = [];
  return new Int8Array(await crypto.subtle.sign("HMAC", m.key, data));
}
async function initMac(m: JMac, key: unknown) {
  m.key = await cryptoKey(key, "HMAC", ["sign"], m.hash);
  m.parts = [];
}
rt.register({
  name: "javax/crypto/Mac", ctor: JMac,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljavax/crypto/Mac;": (algo: string) => {
      const h = HMACS[algo.toUpperCase().replace(/[-/]/g, "")];
      if (!h) throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algo + " Mac not available");
      const m = new JMac();
      m.algo = algo;
      [m.hash, m.len] = h;
      return m;
    },
    "init(Ljava/security/Key;)V": function (this: JMac, k: unknown) { return initMac(this, k); },
    "init(Ljava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V": function (this: JMac, k: unknown) { return initMac(this, k); },
    "update(B)V": function (this: JMac, b: number) { this.parts.push(new Uint8Array([b & 0xff])); },
    "update([B)V": function (this: JMac, b: Int8Array) { this.parts.push(bytes(b)); },
    "update([BII)V": function (this: JMac, b: Int8Array, off: number, len: number) { this.parts.push(bytes(b, off, len)); },
    "doFinal()[B": driven(function* (this: JMac): Gen { return macFinal(this); }),
    "doFinal([B)[B": driven(function* (this: JMac, b: Int8Array): Gen { return macFinal(this, b); }),
    "reset()V": function (this: JMac) { this.parts = []; },
    "getMacLength()I": function (this: JMac) { return this.len; },
    "getAlgorithm()Ljava/lang/String;": function (this: JMac) { return this.algo; },
  },
});

// ── KeyStore + KeyGenerator. The "AndroidKeyStore" type is a software store here: keys are
// generated with WebCrypto randomness and kept per alias (persisted like the app's other state,
// since a device keystore outlives the process). Other store types start empty, as a JCA
// KeyStore does before load(); there is no file to load from.
const KS_KEY = "wd:keystore:";
type StoredCert = { der?: Uint8Array; encoded?: Uint8Array };
class JKeyStore extends JObj {
  type = "";
  loaded = false;
  entries = new Map<string, JSecretKeySpec | JRsaPrivateKey>();
  /** trusted-certificate entries (setCertificateEntry); a persisted one is parsed on first use */
  certs = new Map<string, JObj>();
  pendingCerts = new Map<string, string>();
  async certOf(alias: string): Promise<JObj | null> {
    const have = this.certs.get(alias);
    if (have) return have;
    const der = this.pendingCerts.get(alias);
    if (der === undefined) return null;
    const cert = await parseX509(Uint8Array.from(atob(der), (c) => c.charCodeAt(0)));
    this.pendingCerts.delete(alias);
    this.certs.set(alias, cert);
    return cert;
  }
  hasCert(alias: string): boolean { return this.certs.has(alias) || this.pendingCerts.has(alias); }
  persist() {
    if (this.type !== "AndroidKeyStore") return;
    const o: Record<string, [string, string] | { kind: "rsa"; private: string; public: string; certificate: string } | { kind: "cert"; certificate: string }> = {};
    const encode = (b: Uint8Array) => btoa(binary(b));
    for (const [a, k] of this.entries) {
      if (k instanceof JRsaPrivateKey) o[a] = { kind: "rsa", private: encode(k.encoded), public: encode(k.publicKey.encoded), certificate: encode(k.certificate!.encoded) };
      else o[a] = [k.algo, encode(u8(k.key))];
    }
    for (const [a, c] of this.certs) { const der = (c as StoredCert).der ?? (c as StoredCert).encoded; if (der) o[a] = { kind: "cert", certificate: encode(der) }; }
    for (const [a, der] of this.pendingCerts) o[a] = { kind: "cert", certificate: der };
    try { globalThis.localStorage?.setItem(KS_KEY + this.type, JSON.stringify(o)); } catch { /* quota */ }
  }
  load() {
    if (this.type !== "AndroidKeyStore") return;
    try {
      const raw = globalThis.localStorage?.getItem(KS_KEY + this.type);
      if (!raw) return;
      const entries: unknown = JSON.parse(raw);
      if (entries == null || typeof entries !== "object") return;
      for (const [a, entry] of Object.entries(entries)) {
        if (Array.isArray(entry) && entry.length === 2 && entry.every((v) => typeof v === "string")) {
          this.entries.set(a, mkSecretKey(Uint8Array.from(atob(entry[1]), (c) => c.charCodeAt(0)), entry[0]));
        } else if (entry && entry.kind === "rsa" && typeof entry.private === "string" && typeof entry.public === "string" && typeof entry.certificate === "string") {
          this.entries.set(a, restoreRsa(entry.private, entry.public, entry.certificate));
        } else if (entry && entry.kind === "cert" && typeof entry.certificate === "string") {
          this.pendingCerts.set(a, entry.certificate);
        }
      }
    } catch { /* corrupt */ }
  }
}
/** one store object per type, so a key generated through KeyGenerator("AndroidKeyStore") is
 *  visible to every KeyStore.getInstance("AndroidKeyStore") — as the system keystore is */
const stores = new Map<string, JKeyStore>();
function storeFor(type: string): JKeyStore {
  let s = stores.get(type);
  if (!s) { s = new (type === "AndroidCAStore" ? rt.link("webdroid/CAStore").ctor as typeof JKeyStore : JKeyStore)(); s.type = type; s.load(); stores.set(type, s); }
  return s;
}
rt.register({ name: "webdroid/CAStore", ctor: class extends JKeyStore {}, sup: "java/security/KeyStore", methods: caStoreMethods });
class JSecretKeyEntry extends JObj { key: JSecretKeySpec | null = null; }
rt.markers("java/security/KeyStore$Entry", "java/security/KeyStore$LoadStoreParameter",
  "java/security/KeyStore$ProtectionParameter");
rt.register({
  name: "java/security/KeyStore$SecretKeyEntry", ctor: JSecretKeyEntry, ifaces: ["java/security/KeyStore$Entry"],
  methods: {
    "<init>(Ljavax/crypto/SecretKey;)V": function (this: JSecretKeyEntry, k: JSecretKeySpec) { this.key = k; },
    "getSecretKey()Ljavax/crypto/SecretKey;": function (this: JSecretKeyEntry) { return this.key; },
  },
});
const ready = (s: JKeyStore) => { if (!s.loaded) throw rt.mkThrowable("java/security/KeyStoreException", "Uninitialized keystore"); return s; };
rt.register({
  name: "java/security/KeyStore", ctor: JKeyStore,
  methods: {
    "static getDefaultType()Ljava/lang/String;": () => "AndroidKeyStore",
    "static getInstance(Ljava/lang/String;)Ljava/security/KeyStore;": (type: string) => {
      if (type == null) throw rt.mkThrowable("java/lang/NullPointerException", "type");
      return storeFor(type);
    },
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljava/security/KeyStore;": (type: string) => storeFor(type),
    "getType()Ljava/lang/String;": function (this: JKeyStore) { return this.type; },
    "load(Ljava/io/InputStream;[C)V": function (this: JKeyStore) { this.loaded = true; },
    "load(Ljava/security/KeyStore$LoadStoreParameter;)V": function (this: JKeyStore) { this.loaded = true; },
    "aliases()Ljava/util/Enumeration;": function (this: JKeyStore) { return mkIter([...this.entries.keys(), ...this.certs.keys(), ...this.pendingCerts.keys()]); },
    "size()I": function (this: JKeyStore) { return ready(this).entries.size + this.certs.size + this.pendingCerts.size; },
    "containsAlias(Ljava/lang/String;)Z": function (this: JKeyStore, a: string) { return ready(this).entries.has(a) || this.hasCert(a) ? 1 : 0; },
    "isKeyEntry(Ljava/lang/String;)Z": function (this: JKeyStore, a: string) { return this.entries.has(a) ? 1 : 0; },
    "isCertificateEntry(Ljava/lang/String;)Z": function (this: JKeyStore, a: string) { return this.hasCert(a) ? 1 : 0; },
    "setCertificateEntry(Ljava/lang/String;Ljava/security/cert/Certificate;)V": function (this: JKeyStore, a: string, cert: JObj) {
      if (a === null || cert === null) throw rt.mkThrowable("java/lang/NullPointerException", a === null ? "alias == null" : "cert == null");
      if (ready(this).entries.has(a)) throw rt.mkThrowable("java/security/KeyStoreException", "Cannot overwrite own certificate");
      this.certs.set(a, cert); this.pendingCerts.delete(a); this.persist();
    },
    "getKey(Ljava/lang/String;[C)Ljava/security/Key;": function (this: JKeyStore, a: string) { return ready(this).entries.get(a) ?? null; },
    "getEntry(Ljava/lang/String;Ljava/security/KeyStore$ProtectionParameter;)Ljava/security/KeyStore$Entry;": function (this: JKeyStore, a: string) {
      const k = ready(this).entries.get(a);
      if (!k) return null;
      if (k instanceof JRsaPrivateKey) { const e = new JPrivateKeyEntry(); e.key = k; return e; }
      const e = new JSecretKeyEntry(); e.key = k; return e;
    },
    "setEntry(Ljava/lang/String;Ljava/security/KeyStore$Entry;Ljava/security/KeyStore$ProtectionParameter;)V": function (this: JKeyStore, a: string, e: JSecretKeyEntry) {
      if (!(e instanceof JSecretKeyEntry) || !e.key) throw rt.mkThrowable("java/security/KeyStoreException", "Unsupported entry type");
      this.entries.set(a, e.key); this.persist();
    },
    "setKeyEntry(Ljava/lang/String;Ljava/security/Key;[C[Ljava/security/cert/Certificate;)V": function (this: JKeyStore, a: string, k: JSecretKeySpec) {
      if (!(k instanceof JSecretKeySpec)) throw rt.mkThrowable("java/security/KeyStoreException", "Unsupported key type");
      this.entries.set(a, k); this.persist();
    },
    "deleteEntry(Ljava/lang/String;)V": function (this: JKeyStore, a: string) { this.entries.delete(a); this.certs.delete(a); this.pendingCerts.delete(a); this.persist(); },
    "getCertificate(Ljava/lang/String;)Ljava/security/cert/Certificate;": function (this: JKeyStore, alias: string) {
      const key = ready(this).entries.get(alias); return key instanceof JRsaPrivateKey ? key.certificate : this.certOf(alias);
    },
    "getCertificateChain(Ljava/lang/String;)[Ljava/security/cert/Certificate;": function (this: JKeyStore, alias: string) {
      const key = ready(this).entries.get(alias); return key instanceof JRsaPrivateKey ? rsaChain(key) : null;
    },
    "getProvider()Ljava/security/Provider;": () => null,
  },
});
defineException("java/security/KeyStoreException", "java/security/GeneralSecurityException");
defineException("java/security/UnrecoverableKeyException", "java/security/GeneralSecurityException");

// KeyGenerator material from getRandomValues. Under the "AndroidKeyStore"
// provider the AlgorithmParameterSpec names the alias (KeyGenParameterSpec.getKeystoreAlias),
// and the generated key is stored there.
class JKeyGenerator extends JObj { algo = ""; provider: string | null = null; bits = 0; alias: string | null = null; }
const knownProvider = (p: string | null) => p == null || p === "AndroidKeyStore" || p === "AndroidOpenSSL" || p === "BC";
const KEYGEN_DEFAULT_BITS: Record<string, number> = { AES: 128, BLOWFISH: 128, HMACSHA1: 160, HMACSHA256: 256, HMACSHA384: 384, HMACSHA512: 512, DESEDE: 168, CHACHA20: 256 };
function keyGen(algo: string, provider: string | null): JKeyGenerator {
  const bits = KEYGEN_DEFAULT_BITS[algo?.toUpperCase()];
  if (!bits) throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algo + " KeyGenerator not available");
  if (!knownProvider(provider)) throw rt.mkThrowable("java/security/NoSuchProviderException", "no such provider: " + provider);
  const g = new JKeyGenerator(); g.algo = algo; g.provider = provider; g.bits = bits;
  return g;
}
function keyGenInit(this: JKeyGenerator, spec: any) {
  if (this.provider !== "AndroidKeyStore") throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Unsupported parameter spec");
  if (!spec || typeof spec.alias !== "string") throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Cannot initialize without a KeyGenParameterSpec parameter");
  this.alias = spec.alias;
  if (spec.keySize > 0) this.bits = spec.keySize;
}
rt.register({
  name: "javax/crypto/KeyGenerator", ctor: JKeyGenerator,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljavax/crypto/KeyGenerator;": (a: string) => keyGen(a, null),
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;": (a: string, p: string) => keyGen(a, p),
    "getAlgorithm()Ljava/lang/String;": function (this: JKeyGenerator) { return this.algo; },
    "init(I)V": function (this: JKeyGenerator, bits: number) { this.bits = bits; },
    "init(ILjava/security/SecureRandom;)V": function (this: JKeyGenerator, bits: number) { this.bits = bits; },
    "init(Ljava/security/SecureRandom;)V": () => {},
    "init(Ljava/security/spec/AlgorithmParameterSpec;)V": keyGenInit,
    "init(Ljava/security/spec/AlgorithmParameterSpec;Ljava/security/SecureRandom;)V": keyGenInit,
    "generateKey()Ljavax/crypto/SecretKey;": function (this: JKeyGenerator) {
      if (this.provider === "AndroidKeyStore" && !this.alias) throw rt.mkThrowable("java/lang/IllegalStateException", "Not initialized");
      const key = mkSecretKey(crypto.getRandomValues(new Uint8Array(this.bits >> 3)), this.algo);
      if (this.alias) { const s = storeFor("AndroidKeyStore"); s.entries.set(this.alias, key); s.persist(); }
      return key;
    },
  },
});

class JPrivateKeyEntry extends JObj { key: JRsaPrivateKey | null = null; }
rt.register({
  name: "java/security/KeyStore$PrivateKeyEntry", ctor: JPrivateKeyEntry, ifaces: ["java/security/KeyStore$Entry"],
  methods: {
    "getPrivateKey()Ljava/security/PrivateKey;": function (this: JPrivateKeyEntry) { return this.key; },
    "getCertificate()Ljava/security/cert/Certificate;": function (this: JPrivateKeyEntry) { return this.key?.certificate ?? null; },
    "getCertificateChain()[Ljava/security/cert/Certificate;": function (this: JPrivateKeyEntry) { return this.key && rsaChain(this.key); },
  },
});
class JKeyPairGenerator extends JObj { bits = 2048; store = false; spec: JKeyGenSpec | null = null; curve: string | null = null; }
function keyPairGenerator(algorithm: string, provider: string | null = null) {
  const algo = algorithm?.toUpperCase();
  if (algo !== "RSA" && algo !== "EC") throw rt.mkThrowable("java/security/NoSuchAlgorithmException", algorithm);
  if (!knownProvider(provider)) throw rt.mkThrowable("java/security/NoSuchProviderException", provider);
  const generator = new JKeyPairGenerator(); generator.store = provider === "AndroidKeyStore";
  if (algo === "EC") generator.curve = "P-256";
  return generator;
}
function initializeKeyPair(generator: JKeyPairGenerator, spec: JKeyGenSpec) {
  if (generator.curve && !generator.store) {
    if (rt.iof(spec, "java/security/spec/ECGenParameterSpec")) generator.curve = (spec as unknown as { name: string }).name;
    else if (rt.iof(spec, "java/security/spec/ECParameterSpec")) generator.curve = curveOfParams(spec).names[0];
    else throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "EC parameters required");
    if (!isEcCurve(generator.curve)) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "unsupported curve " + generator.curve);
    return;
  }
  if (!(spec instanceof JKeyGenSpec) || !generator.store) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Keystore parameters required");
  if (spec.strongBox || spec.userAuth || spec.attestation != null || spec.unlockedDeviceRequired) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Hardware-backed keys and user authentication are unavailable");
  if (spec.keySize !== -1 && (spec.keySize < 512 || spec.keySize > 8192 || spec.keySize % 8)) throw rt.mkThrowable("java/security/InvalidAlgorithmParameterException", "Invalid RSA key size");
  generator.spec = spec; generator.bits = spec.keySize === -1 ? 2048 : spec.keySize;
}
async function generateKeyPair(this: JKeyPairGenerator) {
  if (this.curve && !this.store) return generateEc(this.curve);
  if (this.store && !this.spec) throw rt.mkThrowable("java/lang/IllegalStateException", "Not initialized");
  const pair = await generateRsa(this.bits, this.spec);
  if (this.spec) { const store = storeFor("AndroidKeyStore"); store.entries.set(this.spec.alias, pair.privateKey); store.persist(); }
  return pair;
}
rt.register({
  name: "java/security/KeyPairGenerator", ctor: JKeyPairGenerator,
  methods: {
    "static getInstance(Ljava/lang/String;)Ljava/security/KeyPairGenerator;": keyPairGenerator,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljava/security/KeyPairGenerator;": keyPairGenerator,
    "getAlgorithm()Ljava/lang/String;": function (this: JKeyPairGenerator) { return this.curve ? "EC" : "RSA"; },
    "initialize(I)V": function (this: JKeyPairGenerator, bits: number) {
      if (this.curve) { if (!isEcCurve(String(bits))) throw rt.mkThrowable("java/security/InvalidParameterException", "Invalid EC key size"); this.curve = String(bits); return; }
      if (this.store || bits < 512 || bits > 8192 || bits % 8) throw rt.mkThrowable("java/security/InvalidParameterException", "Invalid RSA key size");
      this.bits = bits;
    },
    "initialize(Ljava/security/spec/AlgorithmParameterSpec;)V": function (this: JKeyPairGenerator, spec: JKeyGenSpec) { initializeKeyPair(this, spec); },
    "initialize(Ljava/security/spec/AlgorithmParameterSpec;Ljava/security/SecureRandom;)V": function (this: JKeyPairGenerator, spec: JKeyGenSpec) { initializeKeyPair(this, spec); },
    "generateKeyPair()Ljava/security/KeyPair;": generateKeyPair,
    "genKeyPair()Ljava/security/KeyPair;": generateKeyPair,
  },
});
