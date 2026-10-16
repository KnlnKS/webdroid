import { rt } from "../runtime.ts";
// fdlibm 5.3, which StrictMath is specified by and ART's StrictMath natives link, ported bit for
// bit: JS engines' Math functions are not fdlibm's (JavaScriptCore's differ in the last bit, V8's
// hypot is its own). Each function follows the C source it names; HI/LO are C's __HI/__LO.

const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
const HI = (x: number): number => { f64[0] = x; return u32[1] | 0; };
const LO = (x: number): number => { f64[0] = x; return u32[0]; };
const words = (hi: number, lo: number): number => { u32[1] = hi; u32[0] = lo; return f64[0]; };
const withHI = (x: number, hi: number): number => { f64[0] = x; u32[1] = hi; return f64[0]; };
const withLO = (x: number, lo: number): number => { f64[0] = x; u32[0] = lo; return f64[0]; };

const TWO54 = 1.80143985094819840000e+16, TWOM54 = 5.55111512312578270212e-17, HUGE = 1.0e300, TINY = 1.0e-300;

// k_sin.c, k_cos.c, k_tan.c
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
function kernelSin(x: number, y: number, iy: number): number {
  const ix = HI(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return x;
  const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
function kernelCos(x: number, y: number): number {
  const ix = HI(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return 1.0;
  const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3FD33333) return 1.0 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : words(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx, a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}
const T = [3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02, 2.18694882948595424599e-02,
  8.86323982359930005737e-03, 3.59207910759131235356e-03, 1.45620945432529025516e-03, 5.88041240820264096874e-04,
  2.46463134818469906812e-04, 7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05,
  2.59073051863633712884e-05];
const PIO4 = 7.85398163397448278999e-01, PIO4LO = 3.06161699786838301793e-17;
function kernelTan(x: number, y: number, iy: number): number {
  const hx = HI(x), ix = hx & 0x7fffffff;
  if (ix < 0x3e300000 && (x | 0) === 0) {
    if (((ix | LO(x)) | (iy + 1)) === 0) return 1.0 / Math.abs(x);
    if (iy === 1) return x;
    const w0 = x + y, z0 = withLO(w0, 0), v0 = y - (z0 - x), a0 = -1.0 / w0, t0 = withLO(a0, 0), s0 = 1.0 + t0 * z0;
    return t0 + a0 * (s0 + t0 * v0);
  }
  if (ix >= 0x3FE59428) {
    if (hx < 0) { x = -x; y = -y; }
    x = (PIO4 - x) + (PIO4LO - y);
    y = 0.0;
  }
  const z = x * x, w = z * z;
  let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  const s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  const ww = x + r;
  if (ix >= 0x3FE59428) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (ww * ww / (ww + v) - r)));
  }
  if (iy === 1) return ww;
  const z1 = withLO(ww, 0), v1 = r - (z1 - x), a = -1.0 / ww, t = withLO(a, 0), s1 = 1.0 + t * z1;
  return t + a * (s1 + t * v1);
}

// k_rem_pio2.c
const IPIO2 = [0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A,
  0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129, 0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6,
  0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF, 0x27CB09, 0xB74F46,
  0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0,
  0xCFBC20, 0x9AF436, 0x1DA9E3, 0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA, 0x73A8C9,
  0x60E27B, 0xC08C6B];
const PIO2 = [1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
  1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51];
const TWO24 = 1.67772160000000000000e+07, TWON24 = 5.96046447753906250000e-08;
function kernelRemPio2(x: number[], y: number[], e0: number, nx: number): number {
  const jk = 4, jp = jk, iq = new Int32Array(20), f = new Float64Array(20), fq = new Float64Array(20), q = new Float64Array(20);
  const jx = nx - 1;
  let jv = ((e0 - 3) / 24) | 0;
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);
  let j = jv - jx;
  const m = jx + jk;
  for (let i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0.0 : IPIO2[j];
  for (let i = 0; i <= jk; i++) {
    let fw = 0.0;
    for (j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
    q[i] = fw;
  }
  let jz = jk, z = 0, n = 0, ih = 0, fw = 0;
  for (;;) {
    let i = 0;
    for (j = jz, z = q[jz]; j > 0; i++, j--) {
      fw = (TWON24 * z) | 0;
      iq[i] = (z - TWO24 * fw) | 0;
      z = q[j - 1] + fw;
    }
    z = scalbn(z, q0);
    z -= 8.0 * Math.floor(z * 0.125);
    n = z | 0;
    z -= n;
    ih = 0;
    if (q0 > 0) {
      i = iq[jz - 1] >> (24 - q0); n += i;
      iq[jz - 1] -= i << (24 - q0);
      ih = iq[jz - 1] >> (23 - q0);
    } else if (q0 === 0) ih = iq[jz - 1] >> 23;
    else if (z >= 0.5) ih = 2;
    if (ih > 0) {
      n += 1;
      let carry = 0;
      for (i = 0; i < jz; i++) {
        j = iq[i];
        if (carry === 0) {
          if (j !== 0) { carry = 1; iq[i] = 0x1000000 - j; }
        } else iq[i] = 0xffffff - j;
      }
      if (q0 === 1) iq[jz - 1] &= 0x7fffff;
      else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
      if (ih === 2) {
        z = 1.0 - z;
        if (carry !== 0) z -= scalbn(1.0, q0);
      }
    }
    if (z === 0.0) {
      j = 0;
      for (i = jz - 1; i >= jk; i--) j |= iq[i];
      if (j === 0) {
        let k = 1;
        while (iq[jk - k] === 0) k++;
        for (i = jz + 1; i <= jz + k; i++) {
          f[jx + i] = IPIO2[jv + i];
          for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
          q[i] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }
  if (z === 0.0) {
    jz -= 1; q0 -= 24;
    while (iq[jz] === 0) { jz--; q0 -= 24; }
  } else {
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      fw = (TWON24 * z) | 0;
      iq[jz] = (z - TWO24 * fw) | 0;
      jz += 1; q0 += 24;
      iq[jz] = fw;
    } else iq[jz] = z | 0;
  }
  fw = scalbn(1.0, q0);
  for (let i = jz; i >= 0; i--) { q[i] = fw * iq[i]; fw *= TWON24; }
  for (let i = jz; i >= 0; i--) {
    fw = 0.0;
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * q[i + k];
    fq[jz - i] = fw;
  }
  fw = 0.0;
  for (let i = jz; i >= 0; i--) fw += fq[i];
  y[0] = ih === 0 ? fw : -fw;
  fw = fq[0] - fw;
  for (let i = 1; i <= jz; i++) fw += fq[i];
  y[1] = ih === 0 ? fw : -fw;
  return n & 7;
}

// e_rem_pio2.c
const NPIO2_HW = [0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A,
  0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C,
  0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB];
const INVPIO2 = 6.36619772367581382433e-01, PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11,
  PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21,
  PIO2_3T = 8.47842766036889956997e-32;
/** x reduced modulo pi/2 into y[0] + y[1]; returns the quadrant count */
function remPio2(x: number, y: number[]): number {
  const hx = HI(x), ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0; }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) { y[0] = z - PIO2_1T; y[1] = (z - y[0]) - PIO2_1T; }
      else { z -= PIO2_2; y[0] = z - PIO2_2T; y[1] = (z - y[0]) - PIO2_2T; }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) { y[0] = z + PIO2_1T; y[1] = (z - y[0]) + PIO2_1T; }
    else { z += PIO2_2; y[0] = z + PIO2_2T; y[1] = (z - y[0]) + PIO2_2T; }
    return -1;
  }
  if (ix <= 0x413921fb) {
    const t = Math.abs(x), n = (t * INVPIO2 + 0.5) | 0, fn = n;
    let r = t - fn * PIO2_1, w = fn * PIO2_1T;
    if (n < 32 && ix !== NPIO2_HW[n - 1]) y[0] = r - w;
    else {
      const j = ix >> 20;
      y[0] = r - w;
      let i = j - ((HI(y[0]) >> 20) & 0x7ff);
      if (i > 16) {
        let t2 = r;
        w = fn * PIO2_2; r = t2 - w; w = fn * PIO2_2T - ((t2 - r) - w); y[0] = r - w;
        i = j - ((HI(y[0]) >> 20) & 0x7ff);
        if (i > 49) { t2 = r; w = fn * PIO2_3; r = t2 - w; w = fn * PIO2_3T - ((t2 - r) - w); y[0] = r - w; }
      }
    }
    y[1] = (r - y[0]) - w;
    if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n; }
    return n;
  }
  if (ix >= 0x7ff00000) { y[0] = y[1] = x - x; return 0; }
  const e0 = (ix >> 20) - 1046;
  let z = words(ix - (e0 << 20), LO(x));
  const tx = [0, 0, 0];
  for (let i = 0; i < 2; i++) { tx[i] = z | 0; z = (z - tx[i]) * TWO24; }
  tx[2] = z;
  let nx = 3;
  while (tx[nx - 1] === 0.0) nx--;
  const n = kernelRemPio2(tx, y, e0, nx);
  if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n; }
  return n;
}

// s_sin.c, s_cos.c, s_tan.c
const yy = [0, 0];
export function sin(x: number): number {
  const ix = HI(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0.0, 0);
  if (ix >= 0x7ff00000) return x - x;
  switch (remPio2(x, yy) & 3) {
    case 0: return kernelSin(yy[0], yy[1], 1);
    case 1: return kernelCos(yy[0], yy[1]);
    case 2: return -kernelSin(yy[0], yy[1], 1);
    default: return -kernelCos(yy[0], yy[1]);
  }
}
export function cos(x: number): number {
  const ix = HI(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0.0);
  if (ix >= 0x7ff00000) return x - x;
  switch (remPio2(x, yy) & 3) {
    case 0: return kernelCos(yy[0], yy[1]);
    case 1: return -kernelSin(yy[0], yy[1], 1);
    case 2: return -kernelCos(yy[0], yy[1]);
    default: return kernelSin(yy[0], yy[1], 1);
  }
}
export function tan(x: number): number {
  const ix = HI(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelTan(x, 0.0, 1);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x, yy);
  return kernelTan(yy[0], yy[1], 1 - ((n & 1) << 1));
}

// e_asin.c, e_acos.c
const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17, PIO4_HI = 7.85398163397448278999e-01,
  PS0 = 1.66666666666666657415e-01, PS1 = -3.25565818622400915405e-01, PS2 = 2.01212532134862925881e-01,
  PS3 = -4.00555345006794114027e-02, PS4 = 7.91534994289814532176e-04, PS5 = 3.47933107596021167570e-05,
  QS1 = -2.40339491173441421878e+00, QS2 = 2.02094576023350569471e+00, QS3 = -6.88283971605453293030e-01,
  QS4 = 7.70381505559019352791e-02;
const asinP = (t: number) => t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
const asinQ = (t: number) => 1.0 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
export function asin(x: number): number {
  const hx = HI(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | LO(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
    return (x - x) / (x - x);
  }
  if (ix < 0x3fe00000) {
    if (ix < 0x3e400000 && HUGE + x > 1.0) return x;
    const t = x * x;
    return x + x * (asinP(t) / asinQ(t));
  }
  let w = 1.0 - Math.abs(x);
  const t = w * 0.5, p = asinP(t), q = asinQ(t), s = Math.sqrt(t);
  let r: number;
  if (ix >= 0x3FEF3333) {
    w = p / q;
    r = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO);
  } else {
    w = withLO(s, 0);
    const c = (t - w * w) / (s + w), rr = p / q;
    const pp = 2.0 * s * rr - (PIO2_LO - 2.0 * c), qq = PIO4_HI - 2.0 * w;
    r = PIO4_HI - (pp - qq);
  }
  return hx > 0 ? r : -r;
}
const PI = 3.14159265358979311600e+00;
export function acos(x: number): number {
  const hx = HI(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | LO(x)) === 0) return hx > 0 ? 0.0 : PI + 2.0 * PIO2_LO;
    return (x - x) / (x - x);
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO;
    const z = x * x, r = asinP(z) / asinQ(z);
    return PIO2_HI - (x - (PIO2_LO - x * r));
  }
  if (hx < 0) {
    const z = (1.0 + x) * 0.5, s = Math.sqrt(z), r = asinP(z) / asinQ(z), w = r * s - PIO2_LO;
    return PI - 2.0 * (s + w);
  }
  const z = (1.0 - x) * 0.5, s = Math.sqrt(z), df = withLO(s, 0), c = (z - df * df) / (s + df), r = asinP(z) / asinQ(z), w = r * s + c;
  return 2.0 * (df + w);
}

// s_atan.c, e_atan2.c
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
export function atan(x: number): number {
  const hx = HI(x), ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && LO(x) !== 0)) return x + x;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000 && HUGE + x > 1.0) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
      else { id = 1; x = (x - 1.0) / (x + 1.0); }
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); }
    else { id = 3; x = -1.0 / x; }
  }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return hx < 0 ? -r : r;
}
const PI_O_4 = 7.8539816339744827900E-01, PI_O_2 = 1.5707963267948965580E+00, PI_LO = 1.2246467991473531772E-16;
export function atan2(y: number, x: number): number {
  const hx = HI(x), ix = hx & 0x7fffffff, lx = LO(x), hy = HI(y), iy = hy & 0x7fffffff, ly = LO(y);
  if (((ix | ((lx | -lx) >>> 31)) >>> 0) > 0x7ff00000 || ((iy | ((ly | -ly) >>> 31)) >>> 0) > 0x7ff00000) return x + y;
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y);
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if ((iy | ly) === 0) {
    switch (m) {
      case 0: case 1: return y;
      case 2: return PI + TINY;
      default: return -PI - TINY;
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI_O_4 + TINY;
        case 1: return -PI_O_4 - TINY;
        case 2: return 3.0 * PI_O_4 + TINY;
        default: return -3.0 * PI_O_4 - TINY;
      }
    }
    switch (m) {
      case 0: return 0.0;
      case 1: return -0.0;
      case 2: return PI + TINY;
      default: return -PI - TINY;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) z = PI_O_2 + 0.5 * PI_LO;
  else if (hx < 0 && k < -60) z = 0.0;
  else z = atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// e_exp.c
const HALF = [0.5, -0.5], O_THRESHOLD = 7.09782712893383973096e+02, U_THRESHOLD = -7.45133219101941108420e+02,
  LN2HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01], LN2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10],
  INVLN2 = 1.44269504088896338700e+00, P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03,
  P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08, TWOM1000 = 9.33263618503218878990e-302;
export function exp(x: number): number {
  let hx = HI(x);
  const xsb = (hx >> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0, lo = 0, k = 0;
  if (hx >= 0x40862E42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | LO(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0.0;
    }
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3FF0A2B2) { hi = x - LN2HI[xsb]; lo = LN2LO[xsb]; k = 1 - xsb - xsb; }
    else { k = (INVLN2 * x + HALF[xsb]) | 0; hi = x - k * LN2HI[0]; lo = k * LN2LO[0]; }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    if (HUGE + x > 1.0) return 1.0 + x;
  }
  const t = x * x, c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
  const y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
  if (k >= -1021) return withHI(y, HI(y) + (k << 20));
  return withHI(y, HI(y) + ((k + 1000) << 20)) * TWOM1000;
}

// e_log.c, e_log10.c
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, LG1 = 6.666666666666735130e-01,
  LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01, LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01,
  LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;
export function log(x: number): number {
  let hx = HI(x), k = 0;
  const lx = LO(x);
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -TWO54 / 0.0;
    if (hx < 0) return (x - x) / 0.0;
    k -= 54; x *= TWO54; hx = HI(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  x = withHI(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0.0) return k === 0 ? 0.0 : k * LN2_HI + k * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : k * LN2_HI - ((R - k * LN2_LO) - f);
  }
  const s = f / (2.0 + f), dk = k, z = s * s, w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6)), t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7))), R = t2 + t1;
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}
const IVLN10 = 4.34294481903251816668e-01, LOG10_2HI = 3.01029995663611771306e-01, LOG10_2LO = 3.69423907715893078616e-13;
export function log10(x: number): number {
  let hx = HI(x), k = 0;
  const lx = LO(x);
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -TWO54 / 0.0;
    if (hx < 0) return (x - x) / 0.0;
    k -= 54; x *= TWO54; hx = HI(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  const i = k >>> 31;
  hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
  const y = k + i;
  x = withHI(x, hx);
  const z = y * LOG10_2LO + IVLN10 * log(x);
  return z + y * LOG10_2HI;
}

// s_log1p.c (its Lp1..Lp7 are e_log.c's Lg1..Lg7)
export function log1p(x: number): number {
  const hx = HI(x), ax = hx & 0x7fffffff;
  let k = 1, f = 0, hu = 0, c = 0, u = 0;
  if (hx < 0x3FDA827A) {
    if (ax >= 0x3ff00000) {
      if (x === -1.0) return -TWO54 / 0.0;
      return (x - x) / (x - x);
    }
    if (ax < 0x3e200000) {
      if (TWO54 + x > 0.0 && ax < 0x3c900000) return x;
      return x - x * x * 0.5;
    }
    if (hx > 0 || hx <= (0xbfd2bec3 | 0)) { k = 0; f = x; hu = 1; }
  }
  if (hx >= 0x7ff00000) return x + x;
  if (k !== 0) {
    if (hx < 0x43400000) {
      u = 1.0 + x;
      hu = HI(u);
      k = (hu >> 20) - 1023;
      c = k > 0 ? 1.0 - (u - x) : x - (u - 1.0);
      c /= u;
    } else {
      u = x;
      hu = HI(u);
      k = (hu >> 20) - 1023;
      c = 0;
    }
    hu &= 0x000fffff;
    if (hu < 0x6a09e) u = withHI(u, hu | 0x3ff00000);
    else { k += 1; u = withHI(u, hu | 0x3fe00000); hu = (0x00100000 - hu) >> 2; }
    f = u - 1.0;
  }
  const hfsq = 0.5 * f * f;
  if (hu === 0) {
    if (f === 0.0) {
      if (k === 0) return 0.0;
      c += k * LN2_LO;
      return k * LN2_HI + c;
    }
    const R = hfsq * (1.0 - 0.66666666666666666 * f);
    return k === 0 ? f - R : k * LN2_HI - ((R - (k * LN2_LO + c)) - f);
  }
  const s = f / (2.0 + f), z = s * s, R = z * (LG1 + z * (LG2 + z * (LG3 + z * (LG4 + z * (LG5 + z * (LG6 + z * LG7))))));
  return k === 0 ? f - (hfsq - s * (hfsq + R)) : k * LN2_HI - ((hfsq - (s * (hfsq + R) + (k * LN2_LO + c))) - f);
}

// s_expm1.c
const Q1 = -3.33333333333331316428e-02, Q2 = 1.58730158725481460165e-03, Q3 = -7.93650757867487942473e-05,
  Q4 = 4.00821782732936239552e-06, Q5 = -2.01099218183624371326e-07;
export function expm1(x: number): number {
  let hx = HI(x);
  const xsb = hx & 0x80000000;
  hx &= 0x7fffffff;
  if (hx >= 0x4043687A) {
    if (hx >= 0x40862E42) {
      if (hx >= 0x7ff00000) {
        if (((hx & 0xfffff) | LO(x)) !== 0) return x + x;
        return xsb === 0 ? x : -1.0;
      }
      if (x > O_THRESHOLD) return HUGE * HUGE;
    }
    if (xsb !== 0 && x + TINY < 0.0) return TINY - 1.0;
  }
  let hi = 0, lo = 0, k = 0, c = 0;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3FF0A2B2) {
      if (xsb === 0) { hi = x - LN2_HI; lo = LN2_LO; k = 1; }
      else { hi = x + LN2_HI; lo = -LN2_LO; k = -1; }
    } else {
      k = (INVLN2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
    c = (hi - x) - lo;
  } else if (hx < 0x3c900000) {
    const t = HUGE + x;
    return x - (t - (HUGE + x));
  }
  const hfx = 0.5 * x, hxs = x * hfx;
  const r1 = 1.0 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  let t = 3.0 - r1 * hfx, e = hxs * ((r1 - t) / (6.0 - x * t));
  if (k === 0) return x - (x * e - hxs);
  e = x * (e - c) - c;
  e -= hxs;
  if (k === -1) return 0.5 * (x - e) - 0.5;
  if (k === 1) return x < -0.25 ? -2.0 * (e - (x + 0.5)) : 1.0 + 2.0 * (x - e);
  let y: number;
  if (k <= -2 || k > 56) {
    y = 1.0 - (e - x);
    y = withHI(y, HI(y) + (k << 20));
    return y - 1.0;
  }
  if (k < 20) {
    t = words(0x3ff00000 - (0x200000 >> k), 0);
    y = t - (e - x);
  } else {
    t = words((0x3ff - k) << 20, 0);
    y = x - (e + t);
    y += 1.0;
  }
  return withHI(y, HI(y) + (k << 20));
}

// e_sinh.c, e_cosh.c, s_tanh.c
const SHUGE = 1.0e307;
export function sinh(x: number): number {
  const jx = HI(x), ix = jx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x + x;
  const h = jx < 0 ? -0.5 : 0.5;
  if (ix < 0x40360000) {
    if (ix < 0x3e300000 && SHUGE + x > 1.0) return x;
    const t = expm1(Math.abs(x));
    if (ix < 0x3ff00000) return h * (2.0 * t - t * t / (t + 1.0));
    return h * (t + t / (t + 1.0));
  }
  if (ix < 0x40862E42) return h * exp(Math.abs(x));
  if (ix < 0x408633CE || (ix === 0x408633ce && LO(x) <= 0x8fb9f87d)) {
    const w = exp(0.5 * Math.abs(x)), t = h * w;
    return t * w;
  }
  return x * SHUGE;
}
export function cosh(x: number): number {
  const ix = HI(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) return x * x;
  if (ix < 0x3fd62e43) {
    const t = expm1(Math.abs(x)), w = 1.0 + t;
    if (ix < 0x3c800000) return w;
    return 1.0 + (t * t) / (w + w);
  }
  if (ix < 0x40360000) {
    const t = exp(Math.abs(x));
    return 0.5 * t + 0.5 / t;
  }
  if (ix < 0x40862E42) return 0.5 * exp(Math.abs(x));
  if (ix < 0x408633CE || (ix === 0x408633ce && LO(x) <= 0x8fb9f87d)) {
    const w = exp(0.5 * Math.abs(x)), t = 0.5 * w;
    return t * w;
  }
  return HUGE * HUGE;
}
export function tanh(x: number): number {
  const jx = HI(x), ix = jx & 0x7fffffff;
  if (ix >= 0x7ff00000) return jx >= 0 ? 1.0 / x + 1.0 : 1.0 / x - 1.0;
  let z: number;
  if (ix < 0x40360000) {
    if (ix < 0x3c800000) return x * (1.0 + x);
    if (ix >= 0x3ff00000) {
      const t = expm1(2.0 * Math.abs(x));
      z = 1.0 - 2.0 / (t + 2.0);
    } else {
      const t = expm1(-2.0 * Math.abs(x));
      z = -t / (t + 2.0);
    }
  } else z = 1.0 - TINY;
  return jx >= 0 ? z : -z;
}

// s_cbrt.c
const B1 = 715094163, B2 = 696219795, CB_C = 5.42857142857142815906e-01, CB_D = -7.05306122448979611050e-01,
  CB_E = 1.41428571428571436819e+00, CB_F = 1.60714285714285720630e+00, CB_G = 3.57142857142857150787e-01;
export function cbrt(x: number): number {
  let hx = HI(x);
  const sign = hx & 0x80000000;
  hx ^= sign;
  if (hx >= 0x7ff00000) return x + x;
  if ((hx | LO(x)) === 0) return x;
  x = withHI(x, hx);
  let t: number;
  if (hx < 0x00100000) {
    t = words(0x43500000, 0) * x;
    t = withHI(t, ((HI(t) / 3) | 0) + B2);
  } else t = words(((hx / 3) | 0) + B1, 0);
  let r = t * t / x;
  let s = CB_C + r * t;
  t *= CB_G + CB_F / (s + CB_E + CB_D / s);
  t = words(HI(t) + 0x00000001, 0);
  s = t * t;
  r = x / s;
  const w = t + t;
  r = (r - t) / (w + r);
  t = t + t * r;
  return withHI(t, HI(t) | sign);
}

// e_hypot.c
export function hypot(x: number, y: number): number {
  let ha = HI(x) & 0x7fffffff, hb = HI(y) & 0x7fffffff, a: number, b: number;
  if (hb > ha) { a = y; b = x; const j = ha; ha = hb; hb = j; } else { a = x; b = y; }
  a = withHI(a, ha);
  b = withHI(b, hb);
  if (ha - hb > 0x3c00000) return a + b;
  let k = 0;
  if (ha > 0x5f300000) {
    if (ha >= 0x7ff00000) {
      let w = a + b;
      if (((ha & 0xfffff) | LO(a)) === 0) w = a;
      if (((hb ^ 0x7ff00000) | LO(b)) === 0) w = b;
      return w;
    }
    ha -= 0x25800000; hb -= 0x25800000; k += 600;
    a = withHI(a, ha);
    b = withHI(b, hb);
  }
  if (hb < 0x20b00000) {
    if (hb <= 0x000fffff) {
      if ((hb | LO(b)) === 0) return a;
      const t1 = words(0x7fd00000, 0);
      b *= t1; a *= t1; k -= 1022;
    } else {
      ha += 0x25800000; hb += 0x25800000; k -= 600;
      a = withHI(a, ha);
      b = withHI(b, hb);
    }
  }
  let w = a - b;
  if (w > b) {
    const t1 = words(ha, 0), t2 = a - t1;
    w = Math.sqrt(t1 * t1 - (b * (-b) - t2 * (a + t1)));
  } else {
    a = a + a;
    const y1 = words(hb, 0), y2 = b - y1, t1 = words(ha + 0x00100000, 0), t2 = a - t1;
    w = Math.sqrt(t1 * y1 - (w * (-w) - (t1 * y2 + t2 * b)));
  }
  return k !== 0 ? w * words(0x3ff00000 + (k << 20), 0) : w;
}

// e_pow.c
const BP = [1.0, 1.5], DP_H = [0.0, 5.84962487220764160156e-01], DP_L = [0.0, 1.35003920212974897128e-08],
  TWO53 = 9007199254740992.0, L1 = 5.99999999999994648725e-01, L2 = 4.28571428578550184252e-01, L3 = 3.33333329818377432918e-01,
  L4 = 2.72728123808534006489e-01, L5 = 2.30660745775561754067e-01, L6 = 2.06975017800338417784e-01,
  LG2F = 6.93147180559945286227e-01, LG2_H = 6.93147182464599609375e-01, LG2_L = -1.90465429995776804525e-09,
  OVT = 8.0085662595372944372e-17, CP = 9.61796693925975554329e-01, CP_H = 9.61796700954437255859e-01,
  CP_L = -7.02846165095275826516e-09, IVLN2_H = 1.44269502162933349609e+00, IVLN2_L = 1.92596299112661746887e-08;
export function pow(x: number, y: number): number {
  const hx = HI(x), lx = LO(x), hy = HI(y), ly = LO(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  if ((iy | ly) === 0) return 1.0;
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y;
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2;
    else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if (((j << (52 - k)) >>> 0) === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if ((j << (20 - k)) === iy) yisint = 2 - (j & 1);
      }
    }
  }
  if (ly === 0) {
    if (iy === 0x7ff00000) {
      if (((ix - 0x3ff00000) | lx) === 0) return y - y;
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
      return hy < 0 ? -y : 0.0;
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1.0 / x : x;
    if (hy === 0x40000000) return x * x;
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x);
  }
  let ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    let z = ax;
    if (hy < 0) z = 1.0 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) z = (z - z) / (z - z);
      else if (yisint === 1) z = -z;
    }
    return z;
  }
  let n = (hx >> 31) + 1;
  if ((n | yisint) === 0) return (x - x) / (x - x);
  let s = 1.0;
  if ((n | (yisint - 1)) === 0) s = -1.0;
  let t1: number, t2: number;
  if (iy > 0x41e00000) {
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    const t = ax - 1.0;
    const w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    const u = IVLN2_H * t, v = t * IVLN2_L - w * INVLN2;
    t1 = withLO(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00100000) { ax *= TWO53; n -= 53; ix = HI(ax); }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    ix = j | 0x3ff00000;
    let k: number;
    if (j <= 0x3988E) k = 0;
    else if (j < 0xBB67A) k = 1;
    else { k = 0; n += 1; ix -= 0x00100000; }
    ax = withHI(ax, ix);
    const u = ax - BP[k], v = 1.0 / (ax + BP[k]), ss = u * v, sh = withLO(ss, 0);
    const th0 = words(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0), tl0 = ax - (th0 - BP[k]);
    const sl = v * ((u - sh * th0) - sh * tl0);
    const s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sl * (sh + ss);
    const s2h = sh * sh, th = withLO(3.0 + s2h + r, 0), tl = r - ((th - 3.0) - s2h);
    const uu = sh * th, vv = sl * th + tl * ss;
    const ph = withLO(uu + vv, 0), pl = vv - (ph - uu);
    const zh = CP_H * ph, zl = CP_L * ph + pl * CP + DP_L[k];
    const t = n;
    t1 = withLO(((zh + zl) + DP_H[k]) + t, 0);
    t2 = zl - (((t1 - t) - DP_H[k]) - zh);
  }
  const y1 = withLO(y, 0), pl = (y - y1) * t1 + y * t2;
  let ph = y1 * t1, z = pl + ph, j = HI(z);
  const i = LO(z);
  if (j >= 0x40900000) {
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE;
    if (pl + OVT > z - ph) return s * HUGE * HUGE;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    if (((j - (0xc090cc00 | 0)) | i) !== 0) return s * TINY * TINY;
    if (pl <= z - ph) return s * TINY * TINY;
  }
  const ii = j & 0x7fffffff;
  let k = (ii >> 20) - 0x3ff;
  n = 0;
  if (ii > 0x3fe00000) {
    n = j + (0x00100000 >> (k + 1));
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = words(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    ph -= t;
  }
  const t = withLO(pl + ph, 0);
  const u = t * LG2_H, v = (pl - (t - ph)) * LG2F + t * LG2_L;
  z = u + v;
  const w = v - (z - u), tt = z * z;
  const tt1 = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tt1) / (tt1 - 2.0) - (w + z * w);
  z = 1.0 - (r - z);
  j = HI(z) + (n << 20);
  z = (j >> 20) <= 0 ? scalbn(z, n) : withHI(z, j);
  return s * z;
}

// e_remainder.c, over JS %, which is C's exact fmod
export function remainder(x: number, p: number): number {
  let hx = HI(x), hp = HI(p);
  const lx = LO(x), lp = LO(p), sx = hx & 0x80000000;
  hp &= 0x7fffffff;
  hx &= 0x7fffffff;
  if ((hp | lp) === 0) return (x * p) / (x * p);
  if (hx >= 0x7ff00000 || (hp >= 0x7ff00000 && ((hp - 0x7ff00000) | lp) !== 0)) return (x * p) / (x * p);
  if (hp <= 0x7fdfffff) x %= p + p;
  if (((hx - hp) | (lx - lp)) === 0) return 0.0 * x;
  x = Math.abs(x);
  p = Math.abs(p);
  if (hp < 0x00200000) {
    if (x + x > p) { x -= p; if (x + x >= p) x -= p; }
  } else {
    const pHalf = 0.5 * p;
    if (x > pHalf) { x -= p; if (x >= pHalf) x -= p; }
  }
  return withHI(x, HI(x) ^ sx);
}

// s_scalbn.c, s_copysign.c
function scalbn(x: number, n: number): number {
  let hx = HI(x), k = (hx & 0x7ff00000) >> 20;
  if (k === 0) {
    if (((hx & 0x7fffffff) | LO(x)) === 0) return x;
    x *= TWO54;
    hx = HI(x);
    k = ((hx & 0x7ff00000) >> 20) - 54;
    if (n < -50000) return TINY * x;
  }
  if (k === 0x7ff) return x + x;
  k += n;
  if (k > 0x7fe) return HUGE * copysign(HUGE, x);
  if (k > 0) return withHI(x, (hx & 0x800fffff) | (k << 20));
  if (k <= -54) return n > 50000 ? HUGE * copysign(HUGE, x) : TINY * copysign(TINY, x);
  k += 54;
  return withHI(x, (hx & 0x800fffff) | (k << 20)) * TWOM54;
}
const copysign = (x: number, y: number): number => withHI(x, (HI(x) & 0x7fffffff) | (HI(y) & 0x80000000));

const STRICT_1 = { acos, asin, atan, cbrt, cos, cosh, exp, expm1, log, log10, log1p, sin, sinh, tan, tanh };

// Math's other natives may be the platform's (bionic's on a device): they are the host's Math, imported directly
// (src/wasm/link/intrinsics.ts). StrictMath's are fdlibm's, bit for bit.
{
  rt.registerJnis("java/lang/Math", { "IEEEremainder(DD)D": remainder });
  const strict: Record<string, unknown> = { "IEEEremainder(DD)D": remainder };
  for (const [f, fn] of Object.entries(STRICT_1)) strict[f + "(D)D"] = fn;
  strict["atan2(DD)D"] = atan2;
  strict["hypot(DD)D"] = hypot;
  strict["pow(DD)D"] = pow;
  rt.registerJnis("java/lang/StrictMath", strict);
}
