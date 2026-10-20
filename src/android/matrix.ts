// android.graphics.Matrix's native half and the 3x3 math TS shares with it. native_instance is a
// handle to a row-major 3x3 (MSCALE_X, MSKEW_X, MTRANS_X, MSKEW_Y, MSCALE_Y, MTRANS_Y,
// MPERSP_0..2) the natives update in place, so TS state (an ImageView's matrix, a
// Transformation's) can be the array behind a Java Matrix. A 2D context holds only the affine
// part: [a, b, c, d, e, f] = [M0, M3, M1, M4, M2, M5].

import { rt, peerField } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import type { Ctx2D, Mat2D } from "./recording.ts";
import { edges, setEdges } from "./graphics.ts";

export type Mat = Float64Array;
export const identity = (): Mat => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
/** read-only: a source to copy from */
export const IDENTITY = identity();
export function mul(a: Mat, b: Mat): Mat {
  const o = new Float64Array(9);
  for (let r = 0; r < 9; r += 3) {
    for (let c = 0; c < 3; c++) o[r + c] = a[r] * b[c] + a[r + 1] * b[3 + c] + a[r + 2] * b[6 + c];
  }
  return o;
}
export const translateM = (dx: number, dy: number): Mat => Float64Array.of(1, 0, dx, 0, 1, dy, 0, 0, 1);
export const scaleM = (sx: number, sy: number): Mat => Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, 1);
const skewM = (kx: number, ky: number): Mat => Float64Array.of(1, kx, 0, ky, 1, 0, 0, 0, 1);
const sinCosM = (s: number, c: number): Mat => Float64Array.of(c, -s, 0, s, c, 0, 0, 0, 1);
/** SkScalarSinSnapToZero / CosSnapToZero: a sine or cosine within SK_ScalarNearlyZero is 0, so
 *  quarter turns stay exact */
export const snap = (v: number) => (Math.abs(v) <= 1 / 4096 ? 0 : v);
export const rotateM = (deg: number): Mat => { const r = deg * Math.PI / 180; return sinCosM(snap(Math.sin(r)), snap(Math.cos(r))); };
/** the same transform taken about (px, py) rather than the origin */
export const about = (m: Mat, px: number, py: number): Mat => mul(translateM(px, py), mul(m, translateM(-px, -py)));
/** T * pivot(R) * pivot(S), retaining the general composition's arithmetic order. */
export function setPivotedTransform(out: Mat, tx: number, ty: number, rotation: number, sx: number, sy: number, px: number, py: number): void {
  if (!Number.isFinite(px + py + tx + ty + rotation + sx + sy)) {
    out.set(mul(mul(translateM(tx, ty), about(rotateM(rotation), px, py)), about(scaleM(sx, sy), px, py)));
    return;
  }
  const rad = rotation * Math.PI / 180, s = snap(Math.sin(rad)), c = snap(Math.cos(rad));
  const x = sx * -px + px, y = sy * -py + py;
  out[0] = c * sx + 0; out[1] = -s * sy + 0;
  out[2] = c * x + -s * y + (c * -px + -s * -py + px + tx);
  out[3] = s * sx + 0; out[4] = c * sy + 0;
  out[5] = s * x + c * y + (s * -px + c * -py + py + ty);
  out[6] = 0; out[7] = 0; out[8] = 1;
}
export function invert(m: Mat): Mat | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  // SkMatrix::invert: a determinant within SK_ScalarNearlyZero cubed is singular
  if (!(Math.abs(det) > 1 / 4096 ** 3)) return null;
  return Float64Array.of(
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  );
}
/** SkMatrix's point mapping: a point at w = 0 maps to the origin */
export function mapPoint(m: Mat, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  const k = w === 1 ? 1 : w ? 1 / w : 0;
  return [(m[0] * x + m[1] * y + m[2]) * k, (m[3] * x + m[4] * y + m[5]) * k];
}
export const isIdentity = (m: Mat) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1;

const instanceOf = peerField<bigint>("android/graphics/Matrix", "native_instance");
/** the 3x3 behind a Java Matrix */
export const matrixOf = (m: object): Mat => deref<Mat>(instanceOf(m));
// A stack of 4x4 transforms (SkM44, row-major, float) viewed by SkCamera3D, whose location is
// in inches (72 points each) and whose observer sits on the view axis at the location's depth.
export class Camera3D {
  stack = [Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)];
  location = [0, 0, -576];
  get top() { return this.stack[this.stack.length - 1]; }
  /** top = top * m (SkM44::preConcat) */
  preConcat(m: ArrayLike<number>) {
    const a = this.top.slice(), out = this.top;
    for (let r = 0; r < 16; r += 4) for (let c = 0; c < 4; c++) out[r + c] = a[r] * m[c] + a[r + 1] * m[4 + c] + a[r + 2] * m[8 + c] + a[r + 3] * m[12 + c];
  }
  /** SkM44::Rotate about a unit axis */
  rotate(x: number, y: number, z: number, deg: number) {
    const rad = Math.fround(Math.fround(deg * Math.fround(Math.PI)) / 180), s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
    this.preConcat([t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1]);
  }
  /** SkPatch3D (u = (1,0,0), v = (0,-1,0) at the origin) through the top transform */
  patch() {
    const m = this.top;
    return { u: [m[0], m[4], m[8]], v: [-m[1], -m[5], -m[9]], origin: [m[3], m[7], m[11]] };
  }
  /** SkCamera3D::patchToMatrix, with the orientation its doUpdate derives for the fixed axis
   *  (0,0,1) and zenith (0,-1,0) and an observer at (0, 0, location z) */
  matrix(out: Mat) {
    const { u, v, origin } = this.patch(), z = this.location[2];
    const rows = [[-z, 0, 0], [0, z, 0], [0, 0, 1]];
    const diff = [origin[0] - this.location[0], origin[1] - this.location[1], origin[2] - z];
    const dot = diff[2], at = (p: number[], row: number) => (p[0] * rows[row][0] + p[1] * rows[row][1] + p[2] * rows[row][2]) / dot;
    out.set([at(u, 0), at(v, 0), at(diff, 0), at(u, 1), at(v, 1), at(diff, 1), at(u, 2), at(v, 2), 1].map(Math.fround));
  }
}
/** a 2D context's affine [a, b, c, d, e, f] as the 3x3 */
export function setAffine(m: Mat, a: number, b: number, c: number, d: number, e: number, f: number): void {
  m[0] = a; m[1] = c; m[2] = e; m[3] = b; m[4] = d; m[5] = f; m[6] = 0; m[7] = 0; m[8] = 1;
}
const affineOf = (m: Mat): [number, number, number, number, number, number] => [m[0], m[3], m[1], m[4], m[2], m[5]];
/** how a 2D context's transform scales lengths: the square root of its area scale */
export const deviceScale = (m: Mat2D): number => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
const box = new Float64Array(4);
/** the bounding box [x0, y0, x1, y1] of (l, t, r, b) under `m`, in a buffer the next call overwrites */
export function deviceBounds(m: Mat2D, l: number, t: number, r: number, b: number): Float64Array {
  const x = m.a * l + m.c * t + m.e, y = m.b * l + m.d * t + m.f;
  const wx = m.a * (r - l), wy = m.b * (r - l), hx = m.c * (b - t), hy = m.d * (b - t);
  box[0] = x + Math.min(0, wx) + Math.min(0, hx); box[1] = y + Math.min(0, wy) + Math.min(0, hy);
  box[2] = x + Math.max(0, wx) + Math.max(0, hx); box[3] = y + Math.max(0, wy) + Math.max(0, hy);
  return box;
}
const inverse = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
/** a w x h target in the local coordinates of `m` (deviceBounds of the inverse), null when `m` is singular */
export function localBounds(m: Mat2D, w: number, h: number, x = 0, y = 0): Float64Array | null {
  const det = m.a * m.d - m.b * m.c;
  if (!det || !Number.isFinite(det)) return null;
  inverse.a = m.d / det; inverse.b = -m.b / det; inverse.c = -m.c / det; inverse.d = m.a / det;
  inverse.e = (m.c * m.f - m.d * m.e) / det; inverse.f = (m.b * m.e - m.a * m.f) / det;
  const out = deviceBounds(inverse, x, y, x + w, y + h);
  return out.every(Number.isFinite) ? out : null;
}
/** concatenate (or with `set`, replace) a 2D context's transform; a perspective row cannot be carried */
export function applyMatrix(ctx: Ctx2D, m: ArrayLike<number>, set = false): void {
  if (set) ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
  else ctx.transform(m[0], m[3], m[1], m[4], m[2], m[5]);
}
export type Affine = [number, number, number, number, number, number];
/** a native shader's local matrix: the 3x3 behind the handle Shader passes, null for identity */
export function localMatrix(h: bigint): Affine | null {
  const m = deref<Mat | undefined>(h);
  return m && !isIdentity(m) ? affineOf(m) : null;
}

// ── the natives
/** the 3x3 behind a Matrix handle */
export const matrixAt = (h: bigint) => deref<Mat>(h);
const put = (h: bigint, m: ArrayLike<number>) => { matrixAt(h).set(m); };

/** pre/post/set are the same three compositions for every transform AOSP names; Translate has
 *  no pivoted form and SinCos only the set ones */
function matrixOps(name: string, make: (...a: number[]) => Mat, arity: number, pivot = true, compose = true): Record<string, unknown> {
  const plain = `(J${"F".repeat(arity)})V`;
  const pivoted = `(J${"F".repeat(arity + 2)})V`;
  const at = (a: number[]) => (a.length > arity ? about(make(...a.slice(0, arity)), a[arity], a[arity + 1]) : make(...a));
  const set = (h: bigint, ...a: number[]) => put(h, at(a));
  const pre = (h: bigint, ...a: number[]) => put(h, mul(matrixAt(h), at(a)));
  const post = (h: bigint, ...a: number[]) => put(h, mul(at(a), matrixAt(h)));
  const forms = pivot ? [plain, pivoted] : [plain];
  return Object.fromEntries(forms.flatMap((desc) => [[`nSet${name}${desc}`, set],
    ...compose ? [[`nPre${name}${desc}`, pre], [`nPost${name}${desc}`, post]] : []]));
}
const hasPerspective = (m: Mat) => m[6] !== 0 || m[7] !== 0 || m[8] !== 1;
/** SkMatrix::rectStaysRect */
function rectStaysRect(m: Mat): boolean {
  if (hasPerspective(m)) return false;
  return m[1] === 0 && m[3] === 0 ? m[0] !== 0 && m[4] !== 0 : m[0] === 0 && m[4] === 0 && m[1] !== 0 && m[3] !== 0;
}
/** SkMatrix::mapVectors: without the translation, or under perspective, less where the origin maps */
function mapVector(m: Mat, x: number, y: number): [number, number] {
  if (!hasPerspective(m)) return [m[0] * x + m[1] * y, m[3] * x + m[4] * y];
  const [px, py] = mapPoint(m, x, y), [ox, oy] = mapPoint(m, 0, 0);
  return [px - ox, py - oy];
}
// SkMatrix::setPolyToPoly: each point set becomes the image of the unit square (or its first two
// or three corners), and the result is dst's map after the inverse of src's
const nearlyZero = (x: number) => Math.fround(x * x) === 0;
function polyMap(p: Float32Array, i: number, n: number): Mat | null {
  const x = (k: number) => p[i + k * 2], y = (k: number) => p[i + k * 2 + 1];
  if (n === 2) return Float64Array.of(y(1) - y(0), x(1) - x(0), x(0), x(0) - x(1), y(1) - y(0), y(0), 0, 0, 1);
  if (n === 3) return Float64Array.of(x(2) - x(0), x(1) - x(0), x(0), y(2) - y(0), y(1) - y(0), y(0), 0, 0, 1);
  const x0 = x(2) - x(0), y0 = y(2) - y(0), x1 = x(2) - x(1), y1 = y(2) - y(1), x2 = x(2) - x(3), y2 = y(2) - y(3);
  let a1: number, a2: number, denom: number;
  if (x2 > 0 ? y2 > 0 ? x2 > y2 : x2 > -y2 : y2 > 0 ? -x2 > y2 : x2 < y2) {
    if (nearlyZero(denom = x1 * y2 / x2 - y1)) return null;
    a1 = ((x0 - x1) * y2 / x2 - y0 + y1) / denom;
  } else {
    if (nearlyZero(denom = x1 - y1 * x2 / y2)) return null;
    a1 = (x0 - x1 - (y0 - y1) * x2 / y2) / denom;
  }
  if (x1 > 0 ? y1 > 0 ? x1 > y1 : x1 > -y1 : y1 > 0 ? -x1 > y1 : x1 < y1) {
    if (nearlyZero(denom = y2 - x2 * y1 / x1)) return null;
    a2 = (y0 - y2 - (x0 - x2) * y1 / x1) / denom;
  } else {
    if (nearlyZero(denom = y2 * x1 / y1 - x2)) return null;
    a2 = ((y0 - y2) * x1 / y1 - x0 + x2) / denom;
  }
  return Float64Array.of(a2 * x(3) + x(3) - x(0), a1 * x(1) + x(1) - x(0), x(0),
    a2 * y(3) + y(3) - y(0), a1 * y(1) + y(1) - y(0), y(0), a2, a1, 1);
}

rt.registerJnis("android/graphics/Matrix$ExtraNatives", {
  "nCreate(J)J": (src: bigint) => handle(src ? Float64Array.from(matrixAt(src)) : identity()),
  "nGetNativeFinalizer()J": () => FINALIZER,
});
rt.registerJnis("android/graphics/Matrix", {
  ...matrixOps("Translate", translateM, 2, false),
  ...matrixOps("Scale", scaleM, 2),
  ...matrixOps("Skew", skewM, 2),
  ...matrixOps("Rotate", rotateM, 1),
  ...matrixOps("SinCos", sinCosM, 2, true, false),
  "nReset(J)V": (h: bigint) => put(h, IDENTITY),
  "nSet(JJ)V": (h: bigint, s: bigint) => put(h, s ? matrixAt(s) : IDENTITY),
  "nSetConcat(JJJ)V": (h: bigint, a: bigint, b: bigint) => put(h, mul(matrixAt(a), matrixAt(b))),
  "nPreConcat(JJ)V": (h: bigint, o: bigint) => put(h, mul(matrixAt(h), matrixAt(o))),
  "nPostConcat(JJ)V": (h: bigint, o: bigint) => put(h, mul(matrixAt(o), matrixAt(h))),
  "nIsIdentity(J)Z": (h: bigint) => +isIdentity(matrixAt(h)),
  "nIsAffine(J)Z": (h: bigint) => +!hasPerspective(matrixAt(h)),
  "nRectStaysRect(J)Z": (h: bigint) => +rectStaysRect(matrixAt(h)),
  "nEquals(JJ)Z": (a: bigint, b: bigint) => { const m = matrixAt(a), o = matrixAt(b); return +m.every((v, i) => v === o[i]); },
  "nGetValues(J[F)V": (h: bigint, out: Float32Array) => out.set(matrixAt(h)),
  "nSetValues(J[F)V": (h: bigint, v: Float32Array) => put(h, v.subarray(0, 9)),
  "nInvert(JJ)Z": (h: bigint, into: bigint) => {
    const inv = invert(matrixAt(h));
    if (inv) put(into, inv);
    return +!!inv;
  },
  "nMapPoints(J[FI[FIIZ)V": (h: bigint, dst: Float32Array, di: number, src: Float32Array, si: number, n: number, isPts: number) => {
    const m = matrixAt(h), map = isPts ? mapPoint : mapVector;
    if (src === dst && si !== di) src = src.slice(si, si + n * 2), si = 0;
    for (let i = 0; i < n * 2; i += 2) {
      const [x, y] = map(m, src[si + i], src[si + i + 1]);
      dst[di + i] = x; dst[di + i + 1] = y;
    }
  },
  "nMapRect(JLandroid/graphics/RectF;Landroid/graphics/RectF;)Z": (h: bigint, dstRect: object, srcRect: object) => {
    const m = matrixAt(h), src = edges(srcRect);
    const [x0, y0] = mapPoint(m, src.left, src.top), [x1, y1] = mapPoint(m, src.right, src.top);
    const [x2, y2] = mapPoint(m, src.right, src.bottom), [x3, y3] = mapPoint(m, src.left, src.bottom);
    setEdges(dstRect, { left: Math.min(x0, x1, x2, x3), top: Math.min(y0, y1, y2, y3),
      right: Math.max(x0, x1, x2, x3), bottom: Math.max(y0, y1, y2, y3) });
    return +rectStaysRect(m);
  },
  // SkMatrix::setRectToRect: an empty source resets and fails, an empty destination scales to 0
  "nSetRectToRect(JLandroid/graphics/RectF;Landroid/graphics/RectF;I)Z": (h: bigint, srcRect: object, dstRect: object, stf: number) => {
    const src = edges(srcRect), dst = edges(dstRect);
    const sw = src.right - src.left, sh = src.bottom - src.top;
    const dw = dst.right - dst.left, dh = dst.bottom - dst.top;
    if (!(sw > 0 && sh > 0)) { put(h, IDENTITY); return 0; }
    if (!(dw > 0 && dh > 0)) { put(h, [0, 0, 0, 0, 0, 0, 0, 0, 1]); return 1; }
    // FILL stretches each axis; START/CENTER/END keep the aspect and align the slack
    let sx = dw / sw, sy = dh / sh;
    if (stf !== 0) sx = sy = Math.min(sx, sy);
    const k = stf === 2 ? 0.5 : stf === 3 ? 1 : 0;
    put(h, [sx, 0, dst.left - src.left * sx + (dw - sw * sx) * k, 0, sy, dst.top - src.top * sy + (dh - sh * sy) * k, 0, 0, 1]);
    return 1;
  },
  "nSetPolyToPoly(J[FI[FII)Z": (h: bigint, src: Float32Array, si: number, dst: Float32Array, di: number, n: number) => {
    if (n === 0) { put(h, IDENTITY); return 1; }
    if (n === 1) { put(h, translateM(dst[di] - src[si], dst[di + 1] - src[si + 1])); return 1; }
    const from = polyMap(src, si, n), inverse = from && invert(from), to = inverse && polyMap(dst, di, n);
    if (!to) return 0;
    put(h, mul(to, inverse!));
    return 1;
  },
  "nMapRadius(JF)F": (h: bigint, r: number) => {
    const m = matrixAt(h), [ax, ay] = mapVector(m, r, 0), [bx, by] = mapVector(m, 0, r);
    return Math.fround(Math.sqrt(Math.hypot(ax, ay) * Math.hypot(bx, by)));
  },
});
