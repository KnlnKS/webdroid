// BoringSSL's symmetric primitives, synchronous: AES (FIPS 197, T-tables), DES and 3DES (FIPS 46-3),
// RC4, and the AEADs AES-GCM (SP 800-38D) and ChaCha20-Poly1305 (RFC 8439). conscrypt.ts drives them
// through the EVP_CIPHER and EVP_AEAD natives.
import { be32, le32 } from "./digest.ts";

export interface BlockCipher {
  readonly block: number;
  /** transform one block in place at `off` */
  encrypt(b: Uint8Array, off: number): void;
  decrypt(b: Uint8Array, off: number): void;
}

// ── AES
const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
const TE = [new Int32Array(256), new Int32Array(256), new Int32Array(256), new Int32Array(256)];
const TD = [new Int32Array(256), new Int32Array(256), new Int32Array(256), new Int32Array(256)];
{
  const xtime = (a: number) => ((a << 1) ^ ((a >> 7) * 0x11b)) & 255;
  const exp = new Uint8Array(255), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x ^= xtime(x); }
  const mul = (a: number, b: number) => a && b ? exp[(log[a] + log[b]) % 255] : 0;
  const rotl8 = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 255;
  for (let x = 0; x < 256; x++) {
    const i = x ? exp[(255 - log[x]) % 255] : 0;
    const s = i ^ rotl8(i, 1) ^ rotl8(i, 2) ^ rotl8(i, 3) ^ rotl8(i, 4) ^ 0x63;
    SBOX[x] = s; INV[s] = x;
  }
  const ror = (v: number, n: number) => (v >>> n) | (v << (32 - n));
  for (let x = 0; x < 256; x++) {
    const s = SBOX[x], v = INV[x];
    const e = mul(s, 2) << 24 | s << 16 | s << 8 | mul(s, 3);
    const d = mul(v, 14) << 24 | mul(v, 9) << 16 | mul(v, 13) << 8 | mul(v, 11);
    for (let r = 0; r < 4; r++) { TE[r][x] = r ? ror(e, 8 * r) : e; TD[r][x] = r ? ror(d, 8 * r) : d; }
  }
}

const [TE0, TE1, TE2, TE3] = TE, [TD0, TD1, TD2, TD3] = TD;
/** four words into 16 bytes at `off`, big-endian */
function putWords(b: Uint8Array, off: number, w: Int32Array) {
  for (let i = 0; i < 4; i++, off += 4) { const v = w[i]; b[off] = v >>> 24; b[off + 1] = v >> 16; b[off + 2] = v >> 8; b[off + 3] = v; }
}

class Aes implements BlockCipher {
  readonly block = 16;
  private ek: Int32Array; private dk: Int32Array; private rounds: number;
  /** the last block's output, as four big-endian words */
  readonly out = new Int32Array(4);
  constructor(key: Uint8Array) {
    const n = key.length >> 2;
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new RangeError("AES key length");
    this.rounds = n + 6;
    const total = 4 * (this.rounds + 1), ek = new Int32Array(total);
    for (let i = 0; i < n; i++) ek[i] = key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3];
    for (let i = n, rcon = 1; i < total; i++) {
      let t = ek[i - 1];
      if (i % n === 0 || (n === 8 && i % n === 4)) {
        t = SBOX[t >>> 24] << 24 | SBOX[t >> 16 & 255] << 16 | SBOX[t >> 8 & 255] << 8 | SBOX[t & 255];
        if (i % n === 0) { t = (t << 8) ^ (t >>> 24) ^ (rcon << 24); rcon = (rcon << 1) ^ ((rcon >> 7) * 0x11b); }
      }
      ek[i] = ek[i - n] ^ t;
    }
    // the equivalent inverse cipher's schedule: rounds reversed, InvMixColumns on the inner ones
    const dk = new Int32Array(total);
    for (let r = 0; r <= this.rounds; r++) {
      for (let c = 0; c < 4; c++) {
        const t = ek[4 * (this.rounds - r) + c];
        dk[4 * r + c] = r === 0 || r === this.rounds ? t
          : TD0[SBOX[t >>> 24]] ^ TD1[SBOX[t >> 16 & 255]] ^ TD2[SBOX[t >> 8 & 255]] ^ TD3[SBOX[t & 255]];
      }
    }
    this.ek = ek; this.dk = dk;
  }
  /** one block given as big-endian words, into `out` */
  encryptWords(s0: number, s1: number, s2: number, s3: number): void {
    const k = this.ek, last = this.rounds * 4;
    s0 ^= k[0]; s1 ^= k[1]; s2 ^= k[2]; s3 ^= k[3];
    for (let i = 4; i < last; i += 4) {
      const t0 = TE0[s0 >>> 24] ^ TE1[s1 >> 16 & 255] ^ TE2[s2 >> 8 & 255] ^ TE3[s3 & 255] ^ k[i];
      const t1 = TE0[s1 >>> 24] ^ TE1[s2 >> 16 & 255] ^ TE2[s3 >> 8 & 255] ^ TE3[s0 & 255] ^ k[i + 1];
      const t2 = TE0[s2 >>> 24] ^ TE1[s3 >> 16 & 255] ^ TE2[s0 >> 8 & 255] ^ TE3[s1 & 255] ^ k[i + 2];
      s3 = TE0[s3 >>> 24] ^ TE1[s0 >> 16 & 255] ^ TE2[s1 >> 8 & 255] ^ TE3[s2 & 255] ^ k[i + 3];
      s0 = t0; s1 = t1; s2 = t2;
    }
    const o = this.out, S = SBOX;
    o[0] = (S[s0 >>> 24] << 24 | S[s1 >> 16 & 255] << 16 | S[s2 >> 8 & 255] << 8 | S[s3 & 255]) ^ k[last];
    o[1] = (S[s1 >>> 24] << 24 | S[s2 >> 16 & 255] << 16 | S[s3 >> 8 & 255] << 8 | S[s0 & 255]) ^ k[last + 1];
    o[2] = (S[s2 >>> 24] << 24 | S[s3 >> 16 & 255] << 16 | S[s0 >> 8 & 255] << 8 | S[s1 & 255]) ^ k[last + 2];
    o[3] = (S[s3 >>> 24] << 24 | S[s0 >> 16 & 255] << 16 | S[s1 >> 8 & 255] << 8 | S[s2 & 255]) ^ k[last + 3];
  }
  decryptWords(s0: number, s1: number, s2: number, s3: number): void {
    const k = this.dk, last = this.rounds * 4;
    s0 ^= k[0]; s1 ^= k[1]; s2 ^= k[2]; s3 ^= k[3];
    for (let i = 4; i < last; i += 4) {
      const t0 = TD0[s0 >>> 24] ^ TD1[s3 >> 16 & 255] ^ TD2[s2 >> 8 & 255] ^ TD3[s1 & 255] ^ k[i];
      const t1 = TD0[s1 >>> 24] ^ TD1[s0 >> 16 & 255] ^ TD2[s3 >> 8 & 255] ^ TD3[s2 & 255] ^ k[i + 1];
      const t2 = TD0[s2 >>> 24] ^ TD1[s1 >> 16 & 255] ^ TD2[s0 >> 8 & 255] ^ TD3[s3 & 255] ^ k[i + 2];
      s3 = TD0[s3 >>> 24] ^ TD1[s2 >> 16 & 255] ^ TD2[s1 >> 8 & 255] ^ TD3[s0 & 255] ^ k[i + 3];
      s0 = t0; s1 = t1; s2 = t2;
    }
    const o = this.out, S = INV;
    o[0] = (S[s0 >>> 24] << 24 | S[s3 >> 16 & 255] << 16 | S[s2 >> 8 & 255] << 8 | S[s1 & 255]) ^ k[last];
    o[1] = (S[s1 >>> 24] << 24 | S[s0 >> 16 & 255] << 16 | S[s3 >> 8 & 255] << 8 | S[s2 & 255]) ^ k[last + 1];
    o[2] = (S[s2 >>> 24] << 24 | S[s1 >> 16 & 255] << 16 | S[s0 >> 8 & 255] << 8 | S[s3 & 255]) ^ k[last + 2];
    o[3] = (S[s3 >>> 24] << 24 | S[s2 >> 16 & 255] << 16 | S[s1 >> 8 & 255] << 8 | S[s0 & 255]) ^ k[last + 3];
  }
  encrypt(b: Uint8Array, off: number) { this.encryptWords(be32(b, off), be32(b, off + 4), be32(b, off + 8), be32(b, off + 12)); putWords(b, off, this.out); }
  decrypt(b: Uint8Array, off: number) { this.decryptWords(be32(b, off), be32(b, off + 4), be32(b, off + 8), be32(b, off + 12)); putWords(b, off, this.out); }
  /** CBC over whole blocks in place, chaining from and updating `iv` */
  cbc(data: Uint8Array, iv: Uint8Array, encrypting: boolean): void {
    let v0 = be32(iv, 0), v1 = be32(iv, 4), v2 = be32(iv, 8), v3 = be32(iv, 12);
    const o = this.out;
    for (let off = 0; off + 16 <= data.length; off += 16) {
      const c0 = be32(data, off), c1 = be32(data, off + 4), c2 = be32(data, off + 8), c3 = be32(data, off + 12);
      if (encrypting) {
        this.encryptWords(c0 ^ v0, c1 ^ v1, c2 ^ v2, c3 ^ v3);
        v0 = o[0]; v1 = o[1]; v2 = o[2]; v3 = o[3];
        putWords(data, off, o);
      } else {
        this.decryptWords(c0, c1, c2, c3);
        o[0] ^= v0; o[1] ^= v1; o[2] ^= v2; o[3] ^= v3;
        putWords(data, off, o);
        v0 = c0; v1 = c1; v2 = c2; v3 = c3;
      }
    }
    const w = [v0, v1, v2, v3];
    for (let i = 0; i < 4; i++) { iv[4 * i] = w[i] >>> 24; iv[4 * i + 1] = w[i] >> 16; iv[4 * i + 2] = w[i] >> 8; iv[4 * i + 3] = w[i]; }
  }
}
export const aes = (key: Uint8Array): BlockCipher => new Aes(key);
// ── DES: bit-level permutations over FIPS 46-3's tables (legacy ciphers, not a hot path)
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
  22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const S = [
  "e4d12fb83a6c5907 0f74e2d1a6cb9538 41e8d62bfc973a50 fc8249175b3ea06d", "f18e6b34972dc05a 3d47f28ec01a69b5 0e7ba4d158c6932f d8a13f42b67c05e9",
  "a09e63f51dc7b428 d709346a285ecbf1 d6498f30b12c5ae7 1ad069874fe3b52c", "7de3069a1285bc4f d8b56f03472c1ae9 a690cb7df13e5284 3f06a1d8945bc72e",
  "2c417ab6853fd0e9 eb2c47d150fa3986 421bad78f9c5630e b8c71e2d6f09a453", "c1af92680d34e75b af427c9561de0b38 9ef528c3704a1db6 432c95fabe17608d",
  "4b2ef08d3c975a61 d0b7491ae35c2f86 14bdc37eaf680592 6bd814a7950fe23c", "d2846fb1a93e50c7 1fd8a374c56b0e92 7b419ce206adf358 21e74a8dfc90356b",
].map((s) => Uint8Array.from(s.replace(/ /g, ""), (c) => parseInt(c, 16)));
const bits = (b: Uint8Array, off: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (b[off + (i >> 3)] >> (7 - (i & 7))) & 1);
const perm = (src: Uint8Array, table: number[]) => Uint8Array.from(table, (i) => src[i - 1]);
class Des implements BlockCipher {
  readonly block = 8;
  private keys: Uint8Array[] = [];
  constructor(key: Uint8Array, off = 0) {
    const k = perm(bits(key, off, 64), PC1);
    let c = k.subarray(0, 28), d = k.subarray(28);
    for (const s of SHIFTS) {
      c = Uint8Array.from([...c.subarray(s), ...c.subarray(0, s)]);
      d = Uint8Array.from([...d.subarray(s), ...d.subarray(0, s)]);
      this.keys.push(perm(Uint8Array.from([...c, ...d]), PC2));
    }
  }
  encrypt(b: Uint8Array, off: number) { this.crypt(b, off, false); }
  decrypt(b: Uint8Array, off: number) { this.crypt(b, off, true); }
  private crypt(b: Uint8Array, off: number, inv: boolean) {
    const x = perm(bits(b, off, 64), IP);
    let l = x.slice(0, 32), r = x.slice(32);
    for (let round = 0; round < 16; round++) {
      const k = this.keys[inv ? 15 - round : round], e = perm(r, E), f = new Uint8Array(32);
      for (let s = 0; s < 8; s++) {
        const o = 6 * s, v = e[o] ^ k[o], row = (v << 1) | (e[o + 5] ^ k[o + 5]);
        const col = ((e[o + 1] ^ k[o + 1]) << 3) | ((e[o + 2] ^ k[o + 2]) << 2) | ((e[o + 3] ^ k[o + 3]) << 1) | (e[o + 4] ^ k[o + 4]);
        const out = S[s][row * 16 + col];
        for (let i = 0; i < 4; i++) f[4 * s + i] = (out >> (3 - i)) & 1;
      }
      const pf = perm(f, P), nr = new Uint8Array(32);
      for (let i = 0; i < 32; i++) nr[i] = l[i] ^ pf[i];
      l = r; r = nr;
    }
    const y = perm(Uint8Array.from([...r, ...l]), FP);
    for (let i = 0; i < 8; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | y[8 * i + j]; b[off + i] = v; }
  }
}
/** DES (8-byte key) or 3DES EDE (16- or 24-byte key) */
export function des(key: Uint8Array): BlockCipher {
  if (key.length === 8) return new Des(key);
  const k1 = new Des(key, 0), k2 = new Des(key, 8), k3 = key.length === 24 ? new Des(key, 16) : k1;
  return {
    block: 8,
    encrypt(b, off) { k1.encrypt(b, off); k2.decrypt(b, off); k3.encrypt(b, off); },
    decrypt(b, off) { k3.decrypt(b, off); k2.encrypt(b, off); k1.decrypt(b, off); },
  };
}

/** ECB over whole blocks in place */
export function ecb(bc: BlockCipher, data: Uint8Array, encrypting: boolean) {
  for (let off = 0; off < data.length; off += bc.block) encrypting ? bc.encrypt(data, off) : bc.decrypt(data, off);
}
/** CBC over whole blocks in place, chaining from and updating `iv` */
export function cbc(bc: BlockCipher, data: Uint8Array, iv: Uint8Array, encrypting: boolean) {
  if (bc instanceof Aes) return bc.cbc(data, iv, encrypting);
  const n = bc.block;
  for (let off = 0; off < data.length; off += n) {
    if (encrypting) {
      for (let i = 0; i < n; i++) data[off + i] ^= iv[i];
      bc.encrypt(data, off);
      iv.set(data.subarray(off, off + n));
    } else {
      const next = data.slice(off, off + n);
      bc.decrypt(data, off);
      for (let i = 0; i < n; i++) data[off + i] ^= iv[i];
      iv.set(next);
    }
  }
}
/** `data` with PKCS#7 padding to whole `n`-byte blocks */
export function pkcs7Pad(data: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(data.length + n - data.length % n);
  out.set(data);
  return out.fill(out.length - data.length, data.length);
}
/** `data` without its PKCS#7 padding, or null where that is malformed */
export function pkcs7Unpad(data: Uint8Array, n: number): Uint8Array | null {
  const pad = data[data.length - 1];
  return pad >= 1 && pad <= n && pad <= data.length && data.subarray(data.length - pad).every((v) => v === pad) ? data.subarray(0, data.length - pad) : null;
}

/** RC4's keystream XORed over `data` in place */
export class Rc4 {
  private s = new Uint8Array(256); private i = 0; private j = 0;
  constructor(key: Uint8Array) {
    const s = this.s;
    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  }
  apply(data: Uint8Array) {
    const s = this.s;
    let { i, j } = this;
    for (let n = 0; n < data.length; n++) {
      i = (i + 1) & 255; j = (j + s[i]) & 255;
      const t = s[i]; s[i] = s[j]; s[j] = t;
      data[n] ^= s[(s[i] + s[j]) & 255];
    }
    this.i = i; this.j = j;
  }
}

// ── AES-GCM: GHASH with Shoup's 8-bit tables over four 32-bit words per element
/** the reduction a byte shifted out of the low end XORs into the high word */
const R8 = new Int32Array(256);
for (let x = 0; x < 256; x++) {
  let a = 0, d = x;
  for (let i = 0; i < 8; i++) { const carry = d & 1; d >>>= 1; a = (a >>> 1) ^ (carry ? 0xe1000000 | 0 : 0); }
  R8[x] = a;
}
class Ghash {
  /** 256 entries × 4 words: the byte b times H, b's high bit the coefficient of x^0 */
  private m = new Int32Array(1024);
  private y0 = 0; private y1 = 0; private y2 = 0; private y3 = 0;
  constructor(h: Uint8Array) {
    const m = this.m;
    let a = be32(h, 0), b = be32(h, 4), c = be32(h, 8), d = be32(h, 12);
    m[512] = a; m[513] = b; m[514] = c; m[515] = d;
    for (let i = 64; i > 0; i >>= 1) {
      const carry = d & 1;
      d = (d >>> 1) | (c << 31); c = (c >>> 1) | (b << 31); b = (b >>> 1) | (a << 31); a = (a >>> 1) ^ (carry ? 0xe1000000 | 0 : 0);
      m[4 * i] = a; m[4 * i + 1] = b; m[4 * i + 2] = c; m[4 * i + 3] = d;
    }
    for (let i = 2; i <= 128; i *= 2) for (let j = 1; j < i; j++) for (let k = 0; k < 4; k++) m[4 * (i + j) + k] = m[4 * i + k] ^ m[4 * j + k];
  }
  reset() { this.y0 = this.y1 = this.y2 = this.y3 = 0; }
  /** Y = (Y ⊕ X)·H for the block X given as big-endian words */
  words(x0: number, x1: number, x2: number, x3: number) {
    const m = this.m;
    x0 ^= this.y0; x1 ^= this.y1; x2 ^= this.y2; x3 ^= this.y3;
    let i = 4 * (x3 & 255), a = m[i], b = m[i + 1], c = m[i + 2], d = m[i + 3];
    // the other fifteen bytes, from the block's last towards its first
    for (let n = 1; n < 16; n++) {
      const w = n < 4 ? x3 : n < 8 ? x2 : n < 12 ? x1 : x0, byte = (w >>> (8 * (n & 3))) & 255;
      const rem = d & 255;
      d = (d >>> 8) | (c << 24); c = (c >>> 8) | (b << 24); b = (b >>> 8) | (a << 24); a = (a >>> 8) ^ R8[rem];
      i = 4 * byte;
      a ^= m[i]; b ^= m[i + 1]; c ^= m[i + 2]; d ^= m[i + 3];
    }
    this.y0 = a; this.y1 = b; this.y2 = c; this.y3 = d;
  }
  /** absorb `data` zero-padded to whole blocks */
  update(data: Uint8Array) {
    const whole = data.length & ~15;
    for (let off = 0; off < whole; off += 16) this.words(be32(data, off), be32(data, off + 4), be32(data, off + 8), be32(data, off + 12));
    if (whole < data.length) {
      const x = new Uint8Array(16);
      x.set(data.subarray(whole));
      this.words(be32(x, 0), be32(x, 4), be32(x, 8), be32(x, 12));
    }
  }
  lengths(a: number, c: number) {
    this.words(Math.floor(a / 0x20000000), (a * 8) | 0, Math.floor(c / 0x20000000), (c * 8) | 0);
  }
  digest(): Uint8Array {
    const out = new Uint8Array(16);
    putWords(out, 0, Int32Array.of(this.y0, this.y1, this.y2, this.y3));
    return out;
  }
}
/** counter mode over a 16-byte counter block, the whole block incremented big-endian (EVP's CTR) */
export function ctr(cipher: BlockCipher, counter: Uint8Array, data: Uint8Array, stream: Uint8Array, used: number): number {
  let i = 0;
  const n = data.length;
  for (; used < 16 && i < n; i++) data[i] ^= stream[used++];
  for (; i < n; ) {
    stream.set(counter); cipher.encrypt(stream, 0); used = 0;
    for (let k = 15; k >= 0; k--) if (++counter[k] !== 256) break; else counter[k] = 0;
    if (n - i >= 16) { for (let k = 0; k < 16; k++) data[i + k] ^= stream[k]; i += 16; used = 16; }
    else for (; i < n; i++) data[i] ^= stream[used++];
  }
  return used;
}
export interface Aead {
  seal(nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array;
  /** the plaintext, or null when the tag does not verify */
  open(nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array | null;
}
const equalCt = (a: Uint8Array, b: Uint8Array) => { let d = a.length ^ b.length; for (let i = 0; i < a.length && i < b.length; i++) d |= a[i] ^ b[i]; return d === 0; };
export class AesGcm implements Aead {
  private cipher: Aes; private ghash: Ghash;
  constructor(key: Uint8Array) {
    this.cipher = new Aes(key);
    this.cipher.encryptWords(0, 0, 0, 0);
    const h = new Uint8Array(16);
    putWords(h, 0, this.cipher.out);
    this.ghash = new Ghash(h);
  }
  private j0(nonce: Uint8Array): Uint8Array {
    if (nonce.length === 12) { const j = new Uint8Array(16); j.set(nonce); j[15] = 1; return j; }
    const g = this.ghash;
    g.reset(); g.update(nonce); g.lengths(0, nonce.length);
    return g.digest();
  }
  /** CTR from inc32(J0) over `src` into `dst` (which may be `src`), GHASH taken over the ciphertext
   *  side, `sealing` naming which side that is; the tag is left in the GHASH state */
  private crypt(j0: Uint8Array, aad: Uint8Array, src: Uint8Array, dst: Uint8Array, sealing: boolean) {
    const g = this.ghash, aes = this.cipher, o = aes.out, n = src.length, whole = n & ~15;
    g.reset(); g.update(aad);
    const c0 = be32(j0, 0), c1 = be32(j0, 4), c2 = be32(j0, 8);
    let c3 = be32(j0, 12);
    for (let off = 0; off < whole; off += 16) {
      c3 = (c3 + 1) | 0;
      aes.encryptWords(c0, c1, c2, c3);
      const s0 = be32(src, off), s1 = be32(src, off + 4), s2 = be32(src, off + 8), s3 = be32(src, off + 12);
      const d0 = s0 ^ o[0], d1 = s1 ^ o[1], d2 = s2 ^ o[2], d3 = s3 ^ o[3];
      if (sealing) g.words(d0, d1, d2, d3); else g.words(s0, s1, s2, s3);
      o[0] = d0; o[1] = d1; o[2] = d2; o[3] = d3;
      putWords(dst, off, o);
    }
    if (whole < n) {
      c3 = (c3 + 1) | 0;
      aes.encryptWords(c0, c1, c2, c3);
      const ks = new Uint8Array(16), block = new Uint8Array(16);
      putWords(ks, 0, o);
      for (let i = whole; i < n; i++) {
        const s = src[i], d = s ^ ks[i - whole];
        block[i - whole] = sealing ? d : s;
        dst[i] = d;
      }
      g.words(be32(block, 0), be32(block, 4), be32(block, 8), be32(block, 12));
    }
    g.lengths(aad.length, n);
  }
  private tag(j0: Uint8Array, tagLen: number): Uint8Array {
    const s = this.ghash.digest(), e = j0.slice();
    this.cipher.encrypt(e, 0);
    for (let i = 0; i < 16; i++) s[i] ^= e[i];
    return s.subarray(0, tagLen);
  }
  seal(nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array {
    const j0 = this.j0(nonce), out = new Uint8Array(plain.length + tagLen);
    this.crypt(j0, aad, plain, out, true);
    out.set(this.tag(j0, tagLen), plain.length);
    return out;
  }
  open(nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array | null {
    if (sealed.length < tagLen) return null;
    const j0 = this.j0(nonce), ct = sealed.subarray(0, sealed.length - tagLen), out = new Uint8Array(ct.length);
    this.crypt(j0, aad, ct, out, false);
    return equalCt(this.tag(j0, tagLen), sealed.subarray(ct.length)) ? out : null;
  }
}

// ── ChaCha20 (RFC 8439 §2.3) and Poly1305 (§2.5, over ten 13-bit limbs)
/** one 64-byte block of keystream words for key words k, the counter and nonce words n */
function chachaBlock(k: Int32Array, counter: number, n: Int32Array, out: Int32Array) {
  const j0 = 0x61707865, j1 = 0x3320646e, j2 = 0x79622d32, j3 = 0x6b206574;
  const j4 = k[0], j5 = k[1], j6 = k[2], j7 = k[3], j8 = k[4], j9 = k[5], j10 = k[6], j11 = k[7], j12 = counter | 0, j13 = n[0], j14 = n[1], j15 = n[2];
  let x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15;
  for (let i = 0; i < 10; i++) {
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 16) | (x12 >>> 16); x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 12) | (x4 >>> 20);
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 8) | (x12 >>> 24); x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 7) | (x4 >>> 25);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 16) | (x13 >>> 16); x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 12) | (x5 >>> 20);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 8) | (x13 >>> 24); x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 7) | (x5 >>> 25);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 16) | (x14 >>> 16); x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 12) | (x6 >>> 20);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 8) | (x14 >>> 24); x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 7) | (x6 >>> 25);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 16) | (x15 >>> 16); x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 12) | (x7 >>> 20);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 8) | (x15 >>> 24); x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 7) | (x7 >>> 25);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 16) | (x15 >>> 16); x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 12) | (x5 >>> 20);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 8) | (x15 >>> 24); x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 7) | (x5 >>> 25);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 16) | (x12 >>> 16); x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 12) | (x6 >>> 20);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 8) | (x12 >>> 24); x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 7) | (x6 >>> 25);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 16) | (x13 >>> 16); x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 12) | (x7 >>> 20);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 8) | (x13 >>> 24); x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 7) | (x7 >>> 25);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 16) | (x14 >>> 16); x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 12) | (x4 >>> 20);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 8) | (x14 >>> 24); x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 7) | (x4 >>> 25);
  }
  out[0] = x0 + j0; out[1] = x1 + j1; out[2] = x2 + j2; out[3] = x3 + j3; out[4] = x4 + j4; out[5] = x5 + j5; out[6] = x6 + j6; out[7] = x7 + j7;
  out[8] = x8 + j8; out[9] = x9 + j9; out[10] = x10 + j10; out[11] = x11 + j11; out[12] = x12 + j12; out[13] = x13 + j13; out[14] = x14 + j14; out[15] = x15 + j15;
}
const words = (b: Uint8Array) => Int32Array.from({ length: b.length >> 2 }, (_, i) => le32(b, 4 * i));
/** ChaCha20 with a 12-byte nonce, XORed over `data` in place from block `counter` */
export function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, data: Uint8Array) {
  const k = words(key), n = words(nonce), ks = new Int32Array(16);
  for (let off = 0; off < data.length; off += 64, counter++) {
    chachaBlock(k, counter, n, ks);
    if (data.length - off >= 64) {
      for (let i = 0; i < 16; i++) {
        const w = ks[i], at = off + 4 * i;
        data[at] ^= w; data[at + 1] ^= w >>> 8; data[at + 2] ^= w >>> 16; data[at + 3] ^= w >>> 24;
      }
    } else for (let i = 0; off + i < data.length; i++) data[off + i] ^= ks[i >> 2] >>> (8 * (i & 3));
  }
}
/** Poly1305 over ten 13-bit limbs (as poly1305-donna's 16-bit variant), so every product sum stays exact */
export class Poly1305 {
  private r = new Uint16Array(10); private h = new Uint16Array(10); private pad = new Uint16Array(8);
  constructor(key: Uint8Array) {
    const r = this.r, t = (i: number) => key[i] | key[i + 1] << 8;
    const t0 = t(0), t1 = t(2), t2 = t(4), t3 = t(6), t4 = t(8), t5 = t(10), t6 = t(12), t7 = t(14);
    r[0] = t0 & 0x1fff; r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff; r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
    r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff; r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff; r[5] = (t4 >>> 1) & 0x1ffe;
    r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff; r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81; r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    r[9] = (t7 >>> 5) & 0x007f;
    for (let i = 0; i < 8; i++) this.pad[i] = t(16 + 2 * i);
  }
  /** one 16-byte block at `off` (a final short block already padded with its 1 byte, `hibit` 0) */
  block(m: Uint8Array, off: number, hibit: number) {
    const r = this.r, h = this.h, t = (i: number) => m[off + i] | m[off + i + 1] << 8;
    const t0 = t(0), t1 = t(2), t2 = t(4), t3 = t(6), t4 = t(8), t5 = t(10), t6 = t(12), t7 = t(14);
    const x = [h[0] + (t0 & 0x1fff), h[1] + (((t0 >>> 13) | (t1 << 3)) & 0x1fff), h[2] + (((t1 >>> 10) | (t2 << 6)) & 0x1fff),
      h[3] + (((t2 >>> 7) | (t3 << 9)) & 0x1fff), h[4] + (((t3 >>> 4) | (t4 << 12)) & 0x1fff), h[5] + ((t4 >>> 1) & 0x1fff),
      h[6] + (((t4 >>> 14) | (t5 << 2)) & 0x1fff), h[7] + (((t5 >>> 11) | (t6 << 5)) & 0x1fff), h[8] + (((t6 >>> 8) | (t7 << 8)) & 0x1fff),
      h[9] + ((t7 >>> 5) | hibit)];
    let c = 0;
    const d = new Array<number>(10);
    for (let i = 0; i < 10; i++) {
      // Σ x_j·r_(i-j), a wrapped term's limb times 5 (2^130 ≡ 5); two sums of five keep each under 2^32
      let s = c;
      for (let j = 0; j < 5; j++) s += x[j] * (j <= i ? r[i - j] : 5 * r[i + 10 - j]);
      c = s >>> 13; s &= 0x1fff;
      for (let j = 5; j < 10; j++) s += x[j] * (j <= i ? r[i - j] : 5 * r[i + 10 - j]);
      c += s >>> 13; d[i] = s & 0x1fff;
    }
    c = ((c << 2) + c) | 0;
    c = (c + d[0]) | 0; d[0] = c & 0x1fff; c >>>= 13;
    d[1] += c;
    for (let i = 0; i < 10; i++) h[i] = d[i];
  }
  /** `m` as the message's next part, which ends it unless whole blocks; `zeroPad` instead fills a short
   *  last block with zeros as a whole one (the AEAD's pad16) */
  update(m: Uint8Array, zeroPad = false) {
    const whole = m.length & ~15;
    for (let off = 0; off < whole; off += 16) this.block(m, off, 1 << 11);
    if (whole < m.length) {
      const last = new Uint8Array(16);
      last.set(m.subarray(whole));
      if (zeroPad) this.block(last, 0, 1 << 11);
      else { last[m.length - whole] = 1; this.block(last, 0, 0); }
    }
  }
  digest(): Uint8Array {
    const h = this.h, g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 0x1fff;
    for (let i = 2; i < 10; i++) { h[i] += c; c = h[i] >>> 13; h[i] &= 0x1fff; }
    h[0] += c * 5; c = h[0] >>> 13; h[0] &= 0x1fff;
    h[1] += c; c = h[1] >>> 13; h[1] &= 0x1fff;
    h[2] += c;
    // h + 5 carries out of 2^130 exactly when h ≥ p, and its low 130 bits are then h - p
    g[0] = h[0] + 5; c = g[0] >>> 13; g[0] &= 0x1fff;
    for (let i = 1; i < 10; i++) { g[i] = h[i] + c; c = g[i] >>> 13; g[i] &= 0x1fff; }
    const mask = -c;
    for (let i = 0; i < 10; i++) h[i] = (h[i] & ~mask) | (g[i] & mask);
    const w = [(h[0] | (h[1] << 13)) & 0xffff, ((h[1] >>> 3) | (h[2] << 10)) & 0xffff, ((h[2] >>> 6) | (h[3] << 7)) & 0xffff,
      ((h[3] >>> 9) | (h[4] << 4)) & 0xffff, ((h[4] >>> 12) | (h[5] << 1) | (h[6] << 14)) & 0xffff, ((h[6] >>> 2) | (h[7] << 11)) & 0xffff,
      ((h[7] >>> 5) | (h[8] << 8)) & 0xffff, ((h[8] >>> 8) | (h[9] << 5)) & 0xffff];
    const out = new Uint8Array(16);
    for (let i = 0, f = 0; i < 8; i++) {
      f = w[i] + this.pad[i] + (f >>> 16);
      out[2 * i] = f; out[2 * i + 1] = f >>> 8;
    }
    return out;
  }
}
export class ChaCha20Poly1305 implements Aead {
  private key: Uint8Array;
  constructor(key: Uint8Array) { this.key = key; }
  private tag(nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array, tagLen: number) {
    const otk = new Int32Array(16), otkBytes = new Uint8Array(32);
    chachaBlock(words(this.key), 0, words(nonce), otk);
    for (let i = 0; i < 32; i++) otkBytes[i] = otk[i >> 2] >>> (8 * (i & 3));
    const len = new Uint8Array(16), dv = new DataView(len.buffer);
    dv.setUint32(0, aad.length, true); dv.setUint32(8, ct.length, true);
    const mac = new Poly1305(otkBytes);
    mac.update(aad, true); mac.update(ct, true); mac.update(len);
    return mac.digest().subarray(0, tagLen);
  }
  seal(nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array {
    const out = new Uint8Array(plain.length + tagLen);
    out.set(plain);
    const ct = out.subarray(0, plain.length);
    chacha20(this.key, nonce, 1, ct);
    out.set(this.tag(nonce, aad, ct, tagLen), plain.length);
    return out;
  }
  open(nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array | null {
    if (sealed.length < tagLen) return null;
    const ct = sealed.subarray(0, sealed.length - tagLen);
    if (!equalCt(this.tag(nonce, aad, ct, tagLen), sealed.subarray(ct.length))) return null;
    const out = ct.slice();
    chacha20(this.key, nonce, 1, out);
    return out;
  }
}
