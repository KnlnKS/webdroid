// BoringSSL's symmetric primitives, synchronous: AES (FIPS 197, T-tables), DES and 3DES (FIPS 46-3),
// RC4, and the AEADs AES-GCM (SP 800-38D) and ChaCha20-Poly1305 (RFC 8439). conscrypt.ts drives them
// through the EVP_CIPHER and EVP_AEAD natives.

export interface BlockCipher {
  readonly blockSize: number;
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

class Aes implements BlockCipher {
  readonly blockSize = 16;
  private ek: Int32Array; private dk: Int32Array; private rounds: number;
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
          : TD[0][SBOX[t >>> 24]] ^ TD[1][SBOX[t >> 16 & 255]] ^ TD[2][SBOX[t >> 8 & 255]] ^ TD[3][SBOX[t & 255]];
      }
    }
    this.ek = ek; this.dk = dk;
  }
  encrypt(b: Uint8Array, off: number) { this.crypt(b, off, this.ek, TE, SBOX, false); }
  decrypt(b: Uint8Array, off: number) { this.crypt(b, off, this.dk, TD, INV, true); }
  private crypt(b: Uint8Array, off: number, k: Int32Array, T: Int32Array[], S: Uint8Array, inv: boolean) {
    const [T0, T1, T2, T3] = T;
    let s0 = (b[off] << 24 | b[off + 1] << 16 | b[off + 2] << 8 | b[off + 3]) ^ k[0];
    let s1 = (b[off + 4] << 24 | b[off + 5] << 16 | b[off + 6] << 8 | b[off + 7]) ^ k[1];
    let s2 = (b[off + 8] << 24 | b[off + 9] << 16 | b[off + 10] << 8 | b[off + 11]) ^ k[2];
    let s3 = (b[off + 12] << 24 | b[off + 13] << 16 | b[off + 14] << 8 | b[off + 15]) ^ k[3];
    let ki = 4;
    for (let r = 1; r < this.rounds; r++, ki += 4) {
      let t0, t1, t2, t3;
      if (!inv) {
        t0 = T0[s0 >>> 24] ^ T1[s1 >> 16 & 255] ^ T2[s2 >> 8 & 255] ^ T3[s3 & 255] ^ k[ki];
        t1 = T0[s1 >>> 24] ^ T1[s2 >> 16 & 255] ^ T2[s3 >> 8 & 255] ^ T3[s0 & 255] ^ k[ki + 1];
        t2 = T0[s2 >>> 24] ^ T1[s3 >> 16 & 255] ^ T2[s0 >> 8 & 255] ^ T3[s1 & 255] ^ k[ki + 2];
        t3 = T0[s3 >>> 24] ^ T1[s0 >> 16 & 255] ^ T2[s1 >> 8 & 255] ^ T3[s2 & 255] ^ k[ki + 3];
      } else {
        t0 = T0[s0 >>> 24] ^ T1[s3 >> 16 & 255] ^ T2[s2 >> 8 & 255] ^ T3[s1 & 255] ^ k[ki];
        t1 = T0[s1 >>> 24] ^ T1[s0 >> 16 & 255] ^ T2[s3 >> 8 & 255] ^ T3[s2 & 255] ^ k[ki + 1];
        t2 = T0[s2 >>> 24] ^ T1[s1 >> 16 & 255] ^ T2[s0 >> 8 & 255] ^ T3[s3 & 255] ^ k[ki + 2];
        t3 = T0[s3 >>> 24] ^ T1[s2 >> 16 & 255] ^ T2[s1 >> 8 & 255] ^ T3[s0 & 255] ^ k[ki + 3];
      }
      s0 = t0; s1 = t1; s2 = t2; s3 = t3;
    }
    const w = (a: number, bb: number, c: number, d: number, kk: number) =>
      (S[a >>> 24] << 24 | S[bb >> 16 & 255] << 16 | S[c >> 8 & 255] << 8 | S[d & 255]) ^ kk;
    const o0 = inv ? w(s0, s3, s2, s1, k[ki]) : w(s0, s1, s2, s3, k[ki]);
    const o1 = inv ? w(s1, s0, s3, s2, k[ki + 1]) : w(s1, s2, s3, s0, k[ki + 1]);
    const o2 = inv ? w(s2, s1, s0, s3, k[ki + 2]) : w(s2, s3, s0, s1, k[ki + 2]);
    const o3 = inv ? w(s3, s2, s1, s0, k[ki + 3]) : w(s3, s0, s1, s2, k[ki + 3]);
    b[off] = o0 >>> 24; b[off + 1] = o0 >> 16; b[off + 2] = o0 >> 8; b[off + 3] = o0;
    b[off + 4] = o1 >>> 24; b[off + 5] = o1 >> 16; b[off + 6] = o1 >> 8; b[off + 7] = o1;
    b[off + 8] = o2 >>> 24; b[off + 9] = o2 >> 16; b[off + 10] = o2 >> 8; b[off + 11] = o2;
    b[off + 12] = o3 >>> 24; b[off + 13] = o3 >> 16; b[off + 14] = o3 >> 8; b[off + 15] = o3;
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
  readonly blockSize = 8;
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
    blockSize: 8,
    encrypt(b, off) { k1.encrypt(b, off); k2.decrypt(b, off); k3.encrypt(b, off); },
    decrypt(b, off) { k3.decrypt(b, off); k2.encrypt(b, off); k1.decrypt(b, off); },
  };
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

// ── AES-GCM: GHASH with Shoup's 4-bit tables over four 32-bit words per element
const LAST4 = [0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0, 0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0];
class Ghash {
  private t = new Int32Array(64); // 16 entries × 4 words: H·i for each nibble i
  private y = new Int32Array(4);
  constructor(h: Uint8Array) {
    const t = this.t, w = (i: number) => (h[i] << 24 | h[i + 1] << 16 | h[i + 2] << 8 | h[i + 3]);
    let a = w(0), b = w(4), c = w(8), d = w(12);
    t.set([a, b, c, d], 32);
    for (let i = 4; i > 0; i >>= 1) {
      const carry = d & 1;
      d = (d >>> 1) | (c << 31); c = (c >>> 1) | (b << 31); b = (b >>> 1) | (a << 31); a = (a >>> 1) ^ (carry ? 0xe1000000 | 0 : 0);
      t.set([a, b, c, d], 4 * i);
    }
    for (let i = 2; i <= 8; i *= 2) for (let j = 1; j < i; j++) for (let k = 0; k < 4; k++) t[4 * (i + j) + k] = t[4 * i + k] ^ t[4 * j + k];
  }
  reset() { this.y.fill(0); }
  /** absorb `data` zero-padded to whole blocks */
  update(data: Uint8Array) {
    const x = new Uint8Array(16);
    for (let off = 0; off < data.length; off += 16) {
      const n = Math.min(16, data.length - off);
      if (n < 16) x.fill(0);
      x.set(data.subarray(off, off + n));
      this.block(x);
    }
  }
  block(x: Uint8Array) {
    const y = this.y, t = this.t;
    for (let i = 0; i < 4; i++) {
      const v = y[i] ^ (x[4 * i] << 24 | x[4 * i + 1] << 16 | x[4 * i + 2] << 8 | x[4 * i + 3]);
      x[4 * i] = v >>> 24; x[4 * i + 1] = v >> 16; x[4 * i + 2] = v >> 8; x[4 * i + 3] = v;
    }
    let lo = x[15] & 15, a = t[4 * lo], b = t[4 * lo + 1], c = t[4 * lo + 2], d = t[4 * lo + 3];
    for (let i = 15; i >= 0; i--) {
      const hi = x[i] >> 4;
      lo = x[i] & 15;
      if (i !== 15) {
        const rem = d & 15;
        d = (d >>> 4) | (c << 28); c = (c >>> 4) | (b << 28); b = (b >>> 4) | (a << 28); a = (a >>> 4) ^ (LAST4[rem] << 16);
        a ^= t[4 * lo]; b ^= t[4 * lo + 1]; c ^= t[4 * lo + 2]; d ^= t[4 * lo + 3];
      }
      const rem = d & 15;
      d = (d >>> 4) | (c << 28); c = (c >>> 4) | (b << 28); b = (b >>> 4) | (a << 28); a = (a >>> 4) ^ (LAST4[rem] << 16);
      a ^= t[4 * hi]; b ^= t[4 * hi + 1]; c ^= t[4 * hi + 2]; d ^= t[4 * hi + 3];
    }
    y[0] = a; y[1] = b; y[2] = c; y[3] = d;
  }
  digest(): Uint8Array {
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) { const v = this.y[i]; out[4 * i] = v >>> 24; out[4 * i + 1] = v >> 16; out[4 * i + 2] = v >> 8; out[4 * i + 3] = v; }
    return out;
  }
}
const lengths = (a: number, c: number) => {
  const b = new Uint8Array(16), dv = new DataView(b.buffer);
  dv.setUint32(0, Math.floor(a / 0x20000000)); dv.setUint32(4, (a * 8) >>> 0);
  dv.setUint32(8, Math.floor(c / 0x20000000)); dv.setUint32(12, (c * 8) >>> 0);
  return b;
};
const inc32 = (ctr: Uint8Array) => { for (let i = 15; i >= 12; i--) if (++ctr[i] !== 256) break; else ctr[i] = 0; };
/** counter mode over a 16-byte counter block, the whole block incremented big-endian (EVP's CTR) */
export function ctr(cipher: BlockCipher, counter: Uint8Array, data: Uint8Array, stream: Uint8Array, used: number, whole = true): number {
  for (let i = 0; i < data.length; i++) {
    if (used === 16) {
      stream.set(counter); cipher.encrypt(stream, 0); used = 0;
      if (whole) { for (let k = 15; k >= 0; k--) if (++counter[k] !== 256) break; else counter[k] = 0; } else inc32(counter);
    }
    data[i] ^= stream[used++];
  }
  return used;
}
export interface Aead {
  readonly overhead: number;
  seal(nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array;
  /** the plaintext, or null when the tag does not verify */
  open(nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array | null;
}
const equalCt = (a: Uint8Array, b: Uint8Array) => { let d = a.length ^ b.length; for (let i = 0; i < a.length && i < b.length; i++) d |= a[i] ^ b[i]; return d === 0; };
export class AesGcm implements Aead {
  readonly overhead = 16;
  private cipher: BlockCipher; private hashKey: Uint8Array;
  constructor(key: Uint8Array) {
    this.cipher = aes(key);
    this.hashKey = new Uint8Array(16); this.cipher.encrypt(this.hashKey, 0);
  }
  private j0(nonce: Uint8Array): Uint8Array {
    if (nonce.length === 12) { const j = new Uint8Array(16); j.set(nonce); j[15] = 1; return j; }
    const g = new Ghash(this.hashKey);
    g.update(nonce); g.block(lengths(0, nonce.length));
    return g.digest();
  }
  private tag(j0: Uint8Array, aad: Uint8Array, ct: Uint8Array, tagLen: number): Uint8Array {
    const g = new Ghash(this.hashKey);
    g.update(aad); g.update(ct); g.block(lengths(aad.length, ct.length));
    const s = g.digest(), e = j0.slice();
    this.cipher.encrypt(e, 0);
    for (let i = 0; i < 16; i++) s[i] ^= e[i];
    return s.subarray(0, tagLen);
  }
  private crypt(j0: Uint8Array, data: Uint8Array) {
    const counter = j0.slice();
    inc32(counter);
    ctr(this.cipher, counter, data, new Uint8Array(16), 16, false);
  }
  seal(nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array {
    const j0 = this.j0(nonce), out = new Uint8Array(plain.length + tagLen);
    out.set(plain);
    const ct = out.subarray(0, plain.length);
    this.crypt(j0, ct);
    out.set(this.tag(j0, aad, ct, tagLen), plain.length);
    return out;
  }
  open(nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLen: number): Uint8Array | null {
    if (sealed.length < tagLen) return null;
    const j0 = this.j0(nonce), ct = sealed.subarray(0, sealed.length - tagLen);
    if (!equalCt(this.tag(j0, aad, ct, tagLen), sealed.subarray(ct.length))) return null;
    const out = ct.slice();
    this.crypt(j0, out);
    return out;
  }
}

// ── ChaCha20 (RFC 8439 §2.3) and Poly1305 (§2.5, over bigint)
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
function chachaBlock(key: Int32Array, counter: number, nonce: Int32Array, out: Uint8Array) {
  const s = new Int32Array(16);
  s.set(SIGMA); s.set(key, 4); s[12] = counter; s.set(nonce, 13);
  const x = s.slice();
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a] + x[b]) | 0; x[d] ^= x[a]; x[d] = (x[d] << 16) | (x[d] >>> 16);
    x[c] = (x[c] + x[d]) | 0; x[b] ^= x[c]; x[b] = (x[b] << 12) | (x[b] >>> 20);
    x[a] = (x[a] + x[b]) | 0; x[d] ^= x[a]; x[d] = (x[d] << 8) | (x[d] >>> 24);
    x[c] = (x[c] + x[d]) | 0; x[b] ^= x[c]; x[b] = (x[b] << 7) | (x[b] >>> 25);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const dv = new DataView(out.buffer, out.byteOffset, 64);
  for (let i = 0; i < 16; i++) dv.setInt32(4 * i, (x[i] + s[i]) | 0, true);
}
const words = (b: Uint8Array) => { const dv = new DataView(b.buffer, b.byteOffset, b.length); return Int32Array.from({ length: b.length >> 2 }, (_, i) => dv.getInt32(4 * i, true)); };
/** ChaCha20 with a 12-byte nonce, XORed over `data` in place from block `counter` */
export function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, data: Uint8Array) {
  const k = words(key), n = words(nonce), ks = new Uint8Array(64);
  for (let off = 0; off < data.length; off += 64, counter++) {
    chachaBlock(k, counter, n, ks);
    for (let i = 0; i < 64 && off + i < data.length; i++) data[off + i] ^= ks[i];
  }
}
const le = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const p = (1n << 130n) - 5n, r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn, s = le(key.subarray(16, 32));
  let acc = 0n;
  for (let off = 0; off < msg.length; off += 16) {
    const block = msg.subarray(off, Math.min(off + 16, msg.length));
    acc = (acc + le(block) + (1n << BigInt(8 * block.length))) * r % p;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++, acc >>= 8n) out[i] = Number(acc & 255n);
  return out;
}
const pad16 = (n: number) => new Uint8Array((16 - (n % 16)) % 16);
export class ChaCha20Poly1305 implements Aead {
  readonly overhead = 16;
  constructor(private key: Uint8Array) {}
  private tag(nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array, tagLen: number) {
    const otk = new Uint8Array(64);
    chachaBlock(words(this.key), 0, words(nonce), otk);
    const len = new Uint8Array(16), dv = new DataView(len.buffer);
    dv.setUint32(0, aad.length, true); dv.setUint32(8, ct.length, true);
    const mac = new Uint8Array([...aad, ...pad16(aad.length), ...ct, ...pad16(ct.length), ...len]);
    return poly1305(otk.subarray(0, 32), mac).subarray(0, tagLen);
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
