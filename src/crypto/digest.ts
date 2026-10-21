// BoringSSL's message digests, incremental and synchronous: conscrypt's EVP_MD and HMAC natives and
// the TS callers that hash without the runtime (name-based UUIDs, package signatures).

export interface Hash {
  readonly size: number;
  readonly block: number;
  update(b: Uint8Array, off?: number, len?: number): void;
  /** the digest; the state is then spent until reset() */
  digest(): Uint8Array;
  reset(): void;
  clone(): Hash;
}

/** Merkle-Damgård over 64- or 128-byte blocks, the length appended in `lenBytes` bytes */
abstract class MD implements Hash {
  readonly block: number; private readonly lenBytes: number; private readonly littleEndian: boolean;
  abstract readonly size: number;
  private buf: Uint8Array;
  private used = 0;
  private total = 0;
  protected constructor(block: number, lenBytes: number, littleEndian: boolean) {
    this.block = block; this.lenBytes = lenBytes; this.littleEndian = littleEndian;
    this.buf = new Uint8Array(block);
  }
  protected abstract compress(b: Uint8Array, off: number): void;
  protected abstract init(): void;
  protected abstract out(dst: DataView): void;
  protected abstract copyState(to: this): void;
  update(b: Uint8Array, off = 0, len = b.length - off): void {
    this.total += len;
    const block = this.block, buf = this.buf;
    if (this.used) {
      const n = Math.min(len, block - this.used);
      buf.set(b.subarray(off, off + n), this.used);
      this.used += n; off += n; len -= n;
      if (this.used < block) return;
      this.compress(buf, 0);
      this.used = 0;
    }
    for (; len >= block; off += block, len -= block) this.compress(b, off);
    if (len) { buf.set(b.subarray(off, off + len)); this.used = len; }
  }
  digest(): Uint8Array {
    const buf = this.buf, block = this.block, bits = this.total * 8;
    buf[this.used++] = 0x80;
    if (this.used > block - this.lenBytes) { buf.fill(0, this.used); this.compress(buf, 0); this.used = 0; }
    buf.fill(0, this.used);
    const dv = new DataView(buf.buffer, buf.byteOffset, block), hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    if (this.littleEndian) { dv.setUint32(block - 8, lo, true); dv.setUint32(block - 4, hi, true); }
    else { dv.setUint32(block - 8, hi); dv.setUint32(block - 4, lo); }
    this.compress(buf, 0);
    const out = new Uint8Array(this.size);
    this.out(new DataView(out.buffer));
    this.used = 0; this.total = 0;
    return out;
  }
  reset(): void { this.used = 0; this.total = 0; this.init(); }
  clone(): Hash {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this);
    c.buf = this.buf.slice();
    this.copyState(c);
    return c;
  }
}

export const be32 = (b: Uint8Array, i: number) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) | 0;
export const le32 = (b: Uint8Array, i: number) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) | 0;

const MD5_K = Int32Array.from([0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391]);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
class MD5 extends MD {
  readonly size = 16;
  private h = new Int32Array(4);
  private w = new Int32Array(16);
  constructor() { super(64, 8, true); this.init(); }
  protected init() { this.h.set([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]); }
  protected copyState(to: this) { to.h = this.h.slice(); to.w = new Int32Array(16); }
  protected compress(b: Uint8Array, off: number) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = le32(b, off + 4 * i);
    let a = h[0], bb = h[1], c = h[2], d = h[3];
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = r === 0 ? (bb & c) | (~bb & d) : r === 1 ? (d & bb) | (~d & c) : r === 2 ? bb ^ c ^ d : c ^ (bb | ~d);
      const g = r === 0 ? i : r === 1 ? (5 * i + 1) & 15 : r === 2 ? (3 * i + 5) & 15 : (7 * i) & 15;
      const s = MD5_S[(r << 2) | (i & 3)], x = (a + f + MD5_K[i] + w[g]) | 0;
      a = d; d = c; c = bb; bb = (bb + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  }
  protected out(dst: DataView) { for (let i = 0; i < 4; i++) dst.setInt32(4 * i, this.h[i], true); }
}

class SHA1 extends MD {
  readonly size = 20;
  private h = new Int32Array(5);
  private w = new Int32Array(80);
  constructor() { super(64, 8, false); this.init(); }
  protected init() { this.h.set([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]); }
  protected copyState(to: this) { to.h = this.h.slice(); to.w = new Int32Array(80); }
  protected compress(b: Uint8Array, off: number) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = be32(b, off + 4 * i);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    // a loop per round function: choosing it per step doubled the time
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], i = 0;
    for (; i < 20; i++) { const t = (((a << 5) | (a >>> 27)) + (d ^ (bb & (c ^ d))) + 0x5a827999 + e + w[i]) | 0; e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t; }
    for (; i < 40; i++) { const t = (((a << 5) | (a >>> 27)) + (bb ^ c ^ d) + 0x6ed9eba1 + e + w[i]) | 0; e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t; }
    for (; i < 60; i++) { const t = (((a << 5) | (a >>> 27)) + ((bb & c) | (d & (bb | c))) + 0x8f1bbcdc + e + w[i]) | 0; e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t; }
    for (; i < 80; i++) { const t = (((a << 5) | (a >>> 27)) + (bb ^ c ^ d) + 0xca62c1d6 + e + w[i]) | 0; e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t; }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }
  protected out(dst: DataView) { for (let i = 0; i < 5; i++) dst.setInt32(4 * i, this.h[i]); }
}

const SHA256_K = Int32Array.from([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
class SHA256 extends MD {
  readonly size: 28 | 32;
  private h = new Int32Array(8);
  private w = new Int32Array(64);
  constructor(size: 28 | 32) { super(64, 8, false); this.size = size; this.init(); }
  protected init() {
    this.h.set(this.size === 32 ? [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
      : [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]);
  }
  protected copyState(to: this) { to.h = this.h.slice(); to.w = new Int32Array(64); }
  protected compress(b: Uint8Array, off: number) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = be32(b, off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  protected out(dst: DataView) { for (let i = 0; i < this.size / 4; i++) dst.setInt32(4 * i, this.h[i]); }
}

// SHA-512's 64-bit words as (hi, lo) pairs of int32
const K512 = Int32Array.from([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538,
  0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
  0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
  0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab,
  0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
  0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
  0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
  0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
  0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c,
  0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
  0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817]);
const H384 = [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4];
const H512 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
class SHA512 extends MD {
  readonly size: 48 | 64;
  private h = new Int32Array(16);
  private w = new Int32Array(160);
  constructor(size: 48 | 64) { super(128, 16, false); this.size = size; this.init(); }
  protected init() { this.h.set(this.size === 64 ? H512 : H384); }
  protected copyState(to: this) { to.h = this.h.slice(); to.w = new Int32Array(160); }
  protected compress(b: Uint8Array, off: number) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 32; i++) w[i] = be32(b, off + 4 * i);
    for (let i = 32; i < 160; i += 2) {
      // σ0 of w[i-30], σ1 of w[i-4] (word indices ×2)
      let xh = w[i - 30], xl = w[i - 29];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = w[i - 4]; xl = w[i - 3];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      let l = (s0l >>> 0) + (s1l >>> 0) + (w[i - 13] >>> 0) + (w[i - 31] >>> 0);
      w[i] = (s0h + s1h + w[i - 14] + w[i - 32] + ((l / 0x100000000) | 0)) | 0;
      w[i + 1] = l | 0;
    }
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let i = 0; i < 160; i += 2) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      let l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[i + 1] >>> 0) + (w[i + 1] >>> 0);
      const t1h = (hh + S1h + chh + K512[i] + w[i] + ((l / 0x100000000) | 0)) | 0, t1l = l | 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mh = (ah & bh) ^ (ah & ch) ^ (bh & ch), ml = (al & bl) ^ (al & cl) ^ (bl & cl);
      l = (S0l >>> 0) + (ml >>> 0);
      const t2h = (S0h + mh + ((l / 0x100000000) | 0)) | 0, t2l = l | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      l = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + ((l / 0x100000000) | 0)) | 0; el = l | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      l = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + ((l / 0x100000000) | 0)) | 0; al = l | 0;
    }
    const add = (i: number, xh: number, xl: number) => {
      const l = (h[i + 1] >>> 0) + (xl >>> 0);
      h[i] = (h[i] + xh + ((l / 0x100000000) | 0)) | 0; h[i + 1] = l | 0;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  protected out(dst: DataView) { for (let i = 0; i < this.size / 4; i++) dst.setInt32(4 * i, this.h[i]); }
}

/** BoringSSL's digest names (EVP_get_digestbyname): a factory per algorithm, its OID, and its name in
 *  WebCrypto where the browser has it */
export const DIGESTS: Record<string, { make: () => Hash; oid: string; web?: string }> = {
  md5: { make: () => new MD5(), oid: "1.2.840.113549.2.5" },
  sha1: { make: () => new SHA1(), oid: "1.3.14.3.2.26", web: "SHA-1" },
  sha224: { make: () => new SHA256(28), oid: "2.16.840.1.101.3.4.2.4" },
  sha256: { make: () => new SHA256(32), oid: "2.16.840.1.101.3.4.2.1", web: "SHA-256" },
  sha384: { make: () => new SHA512(48), oid: "2.16.840.1.101.3.4.2.2", web: "SHA-384" },
  sha512: { make: () => new SHA512(64), oid: "2.16.840.1.101.3.4.2.3", web: "SHA-512" },
};
export const digestOfOid = (oid: string) => Object.keys(DIGESTS).find((n) => DIGESTS[n].oid === oid);
/** the digest of `parts` concatenated */
export const hashOf = (make: () => Hash, ...parts: Uint8Array[]): Uint8Array => { const h = make(); for (const p of parts) h.update(p); return h.digest(); };
export const md5 = (data: Uint8Array) => hashOf(DIGESTS.md5.make, data);
export const sha1 = (data: Uint8Array) => hashOf(DIGESTS.sha1.make, data);
export const sha256 = (data: Uint8Array) => hashOf(DIGESTS.sha256.make, data);

/** HMAC (RFC 2104) over one of the digests */
export class Hmac {
  private inner: Hash; private outer: Hash; private readonly init: [Hash, Hash];
  constructor(make: () => Hash, key: Uint8Array) {
    const probe = make();
    if (key.length > probe.block) { probe.update(key); key = probe.digest(); }
    const pad = new Uint8Array(probe.block);
    pad.set(key);
    const inner = make(), outer = make();
    for (let i = 0; i < pad.length; i++) pad[i] ^= 0x36;
    inner.update(pad);
    for (let i = 0; i < pad.length; i++) pad[i] ^= 0x36 ^ 0x5c;
    outer.update(pad);
    this.init = [inner, outer];
    this.inner = inner.clone(); this.outer = outer.clone();
  }
  get size() { return this.inner.size; }
  update(b: Uint8Array, off?: number, len?: number) { this.inner.update(b, off, len); }
  digest(): Uint8Array {
    this.outer.update(this.inner.digest());
    const out = this.outer.digest();
    this.reset();
    return out;
  }
  reset() { this.inner = this.init[0].clone(); this.outer = this.init[1].clone(); }
}

const WEB_MIN = 1 << 16, WEB_MAX = 1 << 26;
/** A digest that holds its message back while none of it is hashed (up to 64 MB), so that a final over
 *  64 KB or more runs in the browser's digest, which uses the CPU's SHA instructions (V8: SHA-256 of 1 MB
 *  in 0.34 ms against 3.1 ms in JS, where the compression function is at its ceiling). */
export class Deferred implements Hash {
  private readonly inner: Hash; private readonly web?: string;
  private held: Uint8Array<ArrayBuffer> | null;
  private n = 0;
  constructor(inner: Hash, web?: string) { this.inner = inner; this.web = web; this.held = web ? new Uint8Array(0) : null; }
  get size() { return this.inner.size; }
  get block() { return this.inner.block; }
  update(b: Uint8Array, off = 0, len = b.length - off): void {
    let held = this.held;
    if (held) {
      const n = this.n + len;
      if (n <= WEB_MAX) {
        if (n > held.length) { const grown = new Uint8Array(Math.max(n, held.length * 2)); grown.set(held.subarray(0, this.n)); this.held = held = grown; }
        held.set(b.subarray(off, off + len), this.n);
        this.n = n;
        return;
      }
      this.flush();
    }
    this.inner.update(b, off, len);
  }
  private flush() {
    if (this.held) this.inner.update(this.held, 0, this.n);
    this.held = null;
  }
  digest(): Uint8Array { this.flush(); return this.inner.digest(); }
  /** digest(), from the browser when the held message is large enough */
  final(): Uint8Array | Promise<Uint8Array> {
    if (!this.held || this.n < WEB_MIN || !globalThis.crypto?.subtle) return this.digest();
    const d = crypto.subtle.digest(this.web!, this.held.subarray(0, this.n));
    this.held = null;
    return d.then((r) => new Uint8Array(r));
  }
  reset(): void { this.inner.reset(); this.held = this.web ? new Uint8Array(0) : null; this.n = 0; }
  clone(): Deferred {
    const c = new Deferred(this.inner.clone(), this.web);
    c.held = this.held?.slice(0, this.n) ?? null; c.n = this.n;
    return c;
  }
}
export const deferred = (name: string) => new Deferred(DIGESTS[name].make(), DIGESTS[name].web);

/** A whole file's digest under a MessageDigest name (MD5, SHA-1, SHA-256, ...); null for an algorithm
 *  the platform lacks. */
export function digestBytes(algorithm: string, data: Uint8Array): Uint8Array | Promise<Uint8Array> | null {
  const name = algorithm.toLowerCase().replace("-", "");
  if (!(name in DIGESTS)) return null;
  const h = deferred(name);
  h.update(data);
  return h.final();
}
