// javax.crypto — SecretKeySpec, IvParameterSpec, Cipher (AES) and Mac (HMAC) over WebCrypto, which is
// one-shot and async: update() buffers, doFinal() awaits the whole operation.
import { rt, JObj } from "../runtime";
import { defineException } from "./jlang";

for (const n of ["java/security/Key", "javax/crypto/SecretKey", "java/security/spec/KeySpec"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}
defineException("java/security/InvalidAlgorithmParameterException", "java/security/GeneralSecurityException");
for (const n of ["NoSuchPaddingException", "IllegalBlockSizeException", "BadPaddingException", "ShortBufferException"]) {
  defineException("javax/crypto/" + n, "java/security/GeneralSecurityException");
}
defineException("javax/crypto/AEADBadTagException", "javax/crypto/BadPaddingException");

function bytes(b: Int8Array, off = 0, len = b.length - off): Uint8Array<ArrayBuffer> {
  const u = new Uint8Array(len);
  u.set(b.subarray(off, off + len));
  return u;
}
function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
const toJava = (u: Uint8Array) => new Int8Array(u.buffer, u.byteOffset, u.length);

class JSecretKeySpec extends JObj {
  key = new Uint8Array(0);
  algo = "";
  imported = new Map<string, CryptoKey>();
}
function setKey(k: JSecretKeySpec, b: Int8Array, off: number, len: number, algo: string) {
  if (!len || algo == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", len ? "Missing argument" : "Empty key");
  k.key = bytes(b, off, len);
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
  iv: Uint8Array<ArrayBuffer> | null = null;
  tagLength = 128;
  parts: Uint8Array[] = [];
}
function getCipher(t: string): JCipher {
  const [alg, mode = "ECB", padding = "PKCS5Padding"] = t.split("/");
  const c = new JCipher();
  c.transformation = t;
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
  c.key = await cryptoKey(key, c.alg === "AES-ECB" ? "AES-CBC" : c.alg, ["encrypt", "decrypt"]);
  c.opmode = opmode;
  c.parts = [];
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
  const ct = join([data, await cbcRaw(key, ZERO_IV, last.map((b) => b ^ 0x10), true)]);
  return new Uint8Array(await crypto.subtle.decrypt(p, key, ct));
}
async function ecb(key: CryptoKey, data: Uint8Array<ArrayBuffer>, enc: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(data.length);
  for (let o = 0; o < data.length; o += 16) out.set(await cbcRaw(key, ZERO_IV, data.subarray(o, o + 16), enc), o);
  return out;
}
function pad(d: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = 16 - d.length % 16;
  return join([d, new Uint8Array(n).fill(n)]);
}
function unpad(d: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const n = d[d.length - 1];
  if (!(n >= 1 && n <= 16 && n <= d.length) || !d.subarray(d.length - n).every((b) => b === n)) {
    throw rt.mkThrowable("javax/crypto/BadPaddingException", "pad block corrupted");
  }
  return d.slice(0, d.length - n);
}
async function doFinal(c: JCipher, b?: Int8Array, off = 0, len = b?.length): Promise<Int8Array> {
  if (!c.key) throw rt.mkThrowable("java/lang/IllegalStateException", "Cipher not initialized");
  if (b) c.parts.push(bytes(b, off, len));
  let data = join(c.parts);
  c.parts = [];
  const enc = c.opmode === 1 || c.opmode === 3;
  const op = enc ? "encrypt" : "decrypt";
  if (c.alg === "AES-CTR") return new Int8Array(await crypto.subtle[op]({ name: c.alg, counter: c.iv!, length: 128 }, c.key, data));
  if (c.alg === "AES-GCM") {
    try { return new Int8Array(await crypto.subtle[op]({ name: c.alg, iv: c.iv!, tagLength: c.tagLength }, c.key, data)); }
    catch { throw rt.mkThrowable("javax/crypto/AEADBadTagException", "Tag mismatch"); }
  }
  if (c.padded && enc) data = pad(data);
  if (data.length % 16) throw rt.mkThrowable("javax/crypto/IllegalBlockSizeException", "Input length not multiple of 16 bytes");
  const out = c.alg === "AES-ECB" ? await ecb(c.key, data, enc) : await cbcRaw(c.key, c.iv!, data, enc);
  return toJava(c.padded && !enc ? unpad(out) : out);
}
rt.register({
  name: "javax/crypto/Cipher", ctor: JCipher,
  statics: { ENCRYPT_MODE: 1, DECRYPT_MODE: 2, WRAP_MODE: 3, UNWRAP_MODE: 4 },
  methods: {
    "static getInstance(Ljava/lang/String;)Ljavax/crypto/Cipher;": getCipher,
    "static getInstance(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/Cipher;": getCipher,
    "init(ILjava/security/Key;)V": function (this: JCipher, m: number, k: unknown) { return initCipher(this, m, k, null); },
    "init(ILjava/security/Key;Ljava/security/SecureRandom;)V": function (this: JCipher, m: number, k: unknown) { return initCipher(this, m, k, null); },
    "init(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V": function (this: JCipher, m: number, k: unknown, p: unknown) {
      return initCipher(this, m, k, p);
    },
    "init(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;Ljava/security/SecureRandom;)V":
      function (this: JCipher, m: number, k: unknown, p: unknown) { return initCipher(this, m, k, p); },
    "update([B)[B": function (this: JCipher, b: Int8Array) { this.parts.push(bytes(b)); return new Int8Array(0); },
    "update([BII)[B": function (this: JCipher, b: Int8Array, off: number, len: number) { this.parts.push(bytes(b, off, len)); return new Int8Array(0); },
    "update([BII[BI)I": function (this: JCipher, b: Int8Array, off: number, len: number) { this.parts.push(bytes(b, off, len)); return 0; },
    "doFinal()[B": function (this: JCipher) { return doFinal(this); },
    "doFinal([B)[B": function (this: JCipher, b: Int8Array) { return doFinal(this, b); },
    "doFinal([BII)[B": function (this: JCipher, b: Int8Array, off: number, len: number) { return doFinal(this, b, off, len); },
    "doFinal([BI)I": async function (this: JCipher, out: Int8Array, off: number) {
      const r = await doFinal(this);
      if (off + r.length > out.length) throw rt.mkThrowable("javax/crypto/ShortBufferException", "Output buffer too short");
      out.set(r, off);
      return r.length;
    },
    "getBlockSize()I": () => 16,
    "getOutputSize(I)I": function (this: JCipher, n: number) { return this.parts.reduce((s, p) => s + p.length, n) + 16; },
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
  const data = join(m.parts);
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
    "doFinal()[B": function (this: JMac) { return macFinal(this); },
    "doFinal([B)[B": function (this: JMac, b: Int8Array) { return macFinal(this, b); },
    "reset()V": function (this: JMac) { this.parts = []; },
    "getMacLength()I": function (this: JMac) { return this.len; },
    "getAlgorithm()Ljava/lang/String;": function (this: JMac) { return this.algo; },
  },
});
