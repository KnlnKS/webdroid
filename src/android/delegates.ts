// AOSP's own native methods, implemented over what we already have.
//
// This is the other side of provenance (src/jvm/provenance.ts). A class served by AOSP
// bytecode keeps its Java half and loses its native half, and these are the native halves:
// `Paint.nSetColor(J I)V`, `Matrix.nPreScale(J F F)V` — the exact descriptors the framework's
// own bytecode calls, registered through rt.registerJni.
//
// The `long` a framework class holds in mNativePtr is an index into `objs` here, which is
// layoutlib's DelegateManager: framework Java owns a handle, we own the object. Handle 0 is
// null, so a field that was never initialised dereferences to nothing rather than to slot 0.
//
// Nothing in this file is written from a list. `bun run fwtest` runs the real bytecode with
// our specs withheld and reports what it reached and could not find; every delegate below is
// there because that said so.

import { rt, JObj } from "../jvm/runtime";
import {
  JPaint, JTypeface, tfDefault, mkTypeface, measureText,
  fontAscent, fontDescent, fillFontMetrics, copyPaint, argbOfColorLong,
} from "./graphics";
import { charsToString } from "../jvm/abi";
import { JPath, pathBounds, pathOffset, pathTransform } from "./path";

// ── handles ────────────────────────────────────────────────────────────────────────────
const objs: (object | undefined)[] = [undefined];

/** hand framework Java a long for this object */
export function handle(o: object): bigint {
  objs.push(o);
  return BigInt(objs.length - 1);
}
/** the object behind a long, or undefined for the null handle */
export function deref<T>(h: bigint): T {
  return objs[Number(h)] as T;
}
function release(h: bigint) { objs[Number(h)] = undefined; }

type Fn = (...a: never[]) => unknown;
/** register the native halves of one class, by their exact AOSP descriptors */
function delegate(cls: string, table: Record<string, unknown>) {
  for (const [sig, fn] of Object.entries(table)) rt.registerJni(cls, sig, fn as Fn);
}

/** A finalizer is a function pointer the class hands to NativeAllocationRegistry, which only
 *  ever passes it back to us. One shared handle to the release function is enough. */
const FINALIZER = handle((h: bigint) => release(h));

// ── the libcore plumbing framework bytecode stands on ──────────────────────────────────
// Not native methods but classes, and only reachable when AOSP bytecode runs: every graphics
// class hands its finalizer to NativeAllocationRegistry from a <clinit>, so without it the
// class fails to initialize before any of the work below is reached. JS collects our objects,
// so registering an allocation is bookkeeping we do not need to keep.
class JFreeRunnable extends JObj {}
rt.register({
  name: "webdroid/FreeRunnable", ctor: JFreeRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": () => {} },
});
// Framework behaviour gated on the app's targetSdk goes through Compatibility. Every change
// is "enabled": that is what a platform reports to an app targeting the SDK it was built
// from, which is the only device profile there is (src/shell/config.ts).
rt.register({
  name: "android/compat/Compatibility", ctor: class extends JObj {},
  methods: {
    "static isChangeEnabled(J)Z": () => 1,
    "static setBehaviorChangeDelegate(Landroid/compat/Compatibility$BehaviorChangeDelegate;)V": () => {},
    "static reportUnconditionalChange(J)V": () => {},
  },
});
rt.register({ name: "android/compat/Compatibility$BehaviorChangeDelegate", ctor: class extends JObj {} });

class JNativeAllocationRegistry extends JObj {}
const mkRegistry = () => new JNativeAllocationRegistry();
rt.register({
  name: "libcore/util/NativeAllocationRegistry", ctor: JNativeAllocationRegistry,
  methods: {
    "<init>(Ljava/lang/ClassLoader;JJ)V": function () {},
    "static createMalloced(Ljava/lang/ClassLoader;J)Llibcore/util/NativeAllocationRegistry;": mkRegistry,
    "static createMalloced(Ljava/lang/ClassLoader;JJ)Llibcore/util/NativeAllocationRegistry;": mkRegistry,
    "static createNonmalloced(Ljava/lang/ClassLoader;JJ)Llibcore/util/NativeAllocationRegistry;": mkRegistry,
    "registerNativeAllocation(Ljava/lang/Object;J)Ljava/lang/Runnable;": () => new (rt.link("webdroid/FreeRunnable").ctor)(),
    // the one case that is not bookkeeping: an explicit free has to reach the delegate
    "static applyFreeFunction(JJ)V": (fn: bigint, ptr: bigint) => { deref<(p: bigint) => void>(fn)?.(ptr); },
  },
});

// ── android.graphics.Matrix ────────────────────────────────────────────────────────────
// AOSP's is a full 3x3 in row-major order (MSCALE_X, MSKEW_X, MTRANS_X, MSKEW_Y, MSCALE_Y,
// MTRANS_Y, MPERSP_0, MPERSP_1, MPERSP_2), not the 6-element affine JMatrix carries: it has
// to be, or setPolyToPoly and every perspective mapping quietly flattens.
type Mat = Float64Array;
const identity = (): Mat => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
function mul(a: Mat, b: Mat): Mat {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}
const translateM = (dx: number, dy: number): Mat => Float64Array.of(1, 0, dx, 0, 1, dy, 0, 0, 1);
const scaleM = (sx: number, sy: number): Mat => Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, 1);
const skewM = (kx: number, ky: number): Mat => Float64Array.of(1, kx, 0, ky, 1, 0, 0, 0, 1);
const sinCosM = (s: number, c: number): Mat => Float64Array.of(c, -s, 0, s, c, 0, 0, 0, 1);
const rotateM = (deg: number): Mat => sinCosM(Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180));
/** the same transform taken about (px, py) rather than the origin */
const about = (m: Mat, px: number, py: number): Mat => mul(translateM(px, py), mul(m, translateM(-px, -py)));

/** pre/post/set are the same three compositions for every transform AOSP names */
function matrixOps(name: string, make: (...a: number[]) => Mat, arity: number): Record<string, unknown> {
  const plain = `(J${"F".repeat(arity)})V`;
  const pivoted = `(J${"F".repeat(arity + 2)})V`;
  const at = (a: number[]) => (a.length > arity ? about(make(...a.slice(0, arity)), a[arity], a[arity + 1]) : make(...a));
  const set = (h: bigint, ...a: number[]) => { objs[Number(h)] = at(a); };
  const pre = (h: bigint, ...a: number[]) => { objs[Number(h)] = mul(deref<Mat>(h), at(a)); };
  const post = (h: bigint, ...a: number[]) => { objs[Number(h)] = mul(at(a), deref<Mat>(h)); };
  return {
    [`nSet${name}${plain}`]: set, [`nSet${name}${pivoted}`]: set,
    [`nPre${name}${plain}`]: pre, [`nPre${name}${pivoted}`]: pre,
    [`nPost${name}${plain}`]: post, [`nPost${name}${pivoted}`]: post,
  };
}

function invert(m: Mat): Mat | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!det) return null;
  return Float64Array.of(
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  );
}
function mapPoint(m: Mat, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  const k = w === 1 || w === 0 ? 1 : 1 / w;
  return [(m[0] * x + m[1] * y + m[2]) * k, (m[3] * x + m[4] * y + m[5]) * k];
}
const isIdentity = (m: Mat) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1;

interface Rect { left: number; top: number; right: number; bottom: number }

delegate("android/graphics/Matrix$ExtraNatives", {
  "nCreate(J)J": (src: bigint) => handle(src ? Float64Array.from(deref<Mat>(src)) : identity()),
  "nGetNativeFinalizer()J": () => FINALIZER,
});
delegate("android/graphics/Matrix", {
  ...matrixOps("Translate", translateM, 2),
  ...matrixOps("Scale", scaleM, 2),
  ...matrixOps("Skew", skewM, 2),
  ...matrixOps("Rotate", rotateM, 1),
  ...matrixOps("SinCos", sinCosM, 2),
  "nReset(J)V": (h: bigint) => { objs[Number(h)] = identity(); },
  "nSet(JJ)V": (h: bigint, s: bigint) => { objs[Number(h)] = s ? Float64Array.from(deref<Mat>(s)) : identity(); },
  "nSetConcat(JJJ)V": (h: bigint, a: bigint, b: bigint) => { objs[Number(h)] = mul(deref<Mat>(a), deref<Mat>(b)); },
  "nPreConcat(JJ)V": (h: bigint, o: bigint) => { objs[Number(h)] = mul(deref<Mat>(h), deref<Mat>(o)); },
  "nPostConcat(JJ)V": (h: bigint, o: bigint) => { objs[Number(h)] = mul(deref<Mat>(o), deref<Mat>(h)); },
  "nIsIdentity(J)Z": (h: bigint) => (isIdentity(deref<Mat>(h)) ? 1 : 0),
  "nIsAffine(J)Z": (h: bigint) => { const m = deref<Mat>(h); return m[6] === 0 && m[7] === 0 && m[8] === 1 ? 1 : 0; },
  "nRectStaysRect(J)Z": (h: bigint) => {
    const m = deref<Mat>(h);
    return (m[1] === 0 && m[3] === 0) || (m[0] === 0 && m[4] === 0) ? 1 : 0;
  },
  "nEquals(JJ)Z": (a: bigint, b: bigint) => (deref<Mat>(a).every((v, i) => v === deref<Mat>(b)[i]) ? 1 : 0),
  "nGetValues(J[F)V": (h: bigint, out: Float32Array) => out.set(deref<Mat>(h)),
  "nSetValues(J[F)V": (h: bigint, v: Float32Array) => { objs[Number(h)] = Float64Array.from(v); },
  "nInvert(JJ)Z": (h: bigint, into: bigint) => {
    const inv = invert(deref<Mat>(h));
    if (!inv) return 0;
    objs[Number(into)] = inv;
    return 1;
  },
  "nMapPoints(J[FI[FIIZ)V": (h: bigint, dst: Float32Array, dstI: number, src: Float32Array, srcI: number, n: number, isPts: number) => {
    const m = deref<Mat>(h);
    // a vector ignores translation, which is the whole difference between mapPoints and
    // mapVectors — AOSP passes it as the trailing boolean rather than as a second entry point
    const t = isPts ? m : Float64Array.of(m[0], m[1], 0, m[3], m[4], 0, m[6], m[7], m[8]);
    for (let i = 0; i < n; i++) {
      const [x, y] = mapPoint(t, src[srcI + i * 2], src[srcI + i * 2 + 1]);
      dst[dstI + i * 2] = x; dst[dstI + i * 2 + 1] = y;
    }
  },
  "nMapRect(JLandroid/graphics/RectF;Landroid/graphics/RectF;)Z": (h: bigint, dst: Rect, src: Rect) => {
    const m = deref<Mat>(h);
    const pts = [[src.left, src.top], [src.right, src.top], [src.right, src.bottom], [src.left, src.bottom]]
      .map(([x, y]) => mapPoint(m, x, y));
    dst.left = Math.min(...pts.map((p) => p[0])); dst.right = Math.max(...pts.map((p) => p[0]));
    dst.top = Math.min(...pts.map((p) => p[1])); dst.bottom = Math.max(...pts.map((p) => p[1]));
    return isIdentity(m) || (m[1] === 0 && m[3] === 0) ? 1 : 0;
  },
  "nSetRectToRect(JLandroid/graphics/RectF;Landroid/graphics/RectF;I)Z": (h: bigint, src: Rect, dst: Rect, stf: number) => {
    const sw = src.right - src.left, sh = src.bottom - src.top;
    const dw = dst.right - dst.left, dh = dst.bottom - dst.top;
    if (sw <= 0 || sh <= 0) return 0;
    // FILL stretches each axis; START/CENTER/END keep the aspect and align the slack
    let sx = dw / sw, sy = dh / sh;
    if (stf !== 0) sx = sy = Math.min(sx, sy);
    const slackX = dw - sw * sx, slackY = dh - sh * sy;
    const k = stf === 2 ? 0.5 : stf === 3 ? 1 : 0;
    const tx = dst.left - src.left * sx + (stf === 0 ? 0 : slackX * k);
    const ty = dst.top - src.top * sy + (stf === 0 ? 0 : slackY * k);
    objs[Number(h)] = Float64Array.of(sx, 0, tx, 0, sy, ty, 0, 0, 1);
    return 1;
  },
  // 1 point is a translation, 2 a similarity, 3 a full affine. 4 is a perspective solve we
  // do not do: reporting failure is what a caller checks for, and is not a wrong transform.
  "nSetPolyToPoly(J[FI[FII)Z": (h: bigint, src: Float32Array, si: number, dst: Float32Array, di: number, n: number) => {
    const sp = (i: number) => [src[si + i * 2], src[si + i * 2 + 1]] as const;
    const dp = (i: number) => [dst[di + i * 2], dst[di + i * 2 + 1]] as const;
    if (n === 0) { objs[Number(h)] = identity(); return 1; }
    if (n === 1) { objs[Number(h)] = translateM(dp(0)[0] - sp(0)[0], dp(0)[1] - sp(0)[1]); return 1; }
    if (n === 2) {
      const [s0, s1] = [sp(0), sp(1)], [d0, d1] = [dp(0), dp(1)];
      const sdx = s1[0] - s0[0], sdy = s1[1] - s0[1];
      const ddx = d1[0] - d0[0], ddy = d1[1] - d0[1];
      const den = sdx * sdx + sdy * sdy;
      if (!den) return 0;
      const a = (ddx * sdx + ddy * sdy) / den, b = (ddy * sdx - ddx * sdy) / den;
      const m = Float64Array.of(a, -b, 0, b, a, 0, 0, 0, 1);
      const [mx, my] = mapPoint(m, s0[0], s0[1]);
      m[2] = d0[0] - mx; m[5] = d0[1] - my;
      objs[Number(h)] = m;
      return 1;
    }
    if (n === 3) {
      const [s0, s1, s2] = [sp(0), sp(1), sp(2)], [d0, d1, d2] = [dp(0), dp(1), dp(2)];
      const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
      if (!det) return 0;
      const solve = (v0: number, v1: number, v2: number) => [
        ((v1 - v0) * (s2[1] - s0[1]) - (v2 - v0) * (s1[1] - s0[1])) / det,
        ((v2 - v0) * (s1[0] - s0[0]) - (v1 - v0) * (s2[0] - s0[0])) / det,
      ];
      const [a, c] = solve(d0[0], d1[0], d2[0]);
      const [b, d] = solve(d0[1], d1[1], d2[1]);
      objs[Number(h)] = Float64Array.of(a, c, d0[0] - a * s0[0] - c * s0[1], b, d, d0[1] - b * s0[0] - d * s0[1], 0, 0, 1);
      return 1;
    }
    return 0;
  },
  "nMapRadius(JF)F": (h: bigint, r: number) => {
    const m = deref<Mat>(h);
    // Skia's: the geometric mean of the two axis lengths, which is what a circle maps to on average
    return Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) * r;
  },
});

// ── android.graphics.Typeface ──────────────────────────────────────────────────────────
delegate("android/graphics/Typeface", {
  "nativeCreateFromTypeface(JI)J": (h: bigint, style: number) => {
    const src = deref<JTypeface>(h) ?? tfDefault;
    return handle(mkTypeface(src.family, (style & 1) !== 0, (style & 2) !== 0));
  },
  "nativeCreateFromTypefaceWithVariation(JLjava/util/List;)J": (h: bigint) => handle(deref<JTypeface>(h) ?? tfDefault),
  "nativeCreateWeightAlias(JI)J": (h: bigint, weight: number) => {
    const src = deref<JTypeface>(h) ?? tfDefault;
    const t = mkTypeface(src.family, src.bold, src.italic, weight);
    return handle(t);
  },
  "nativeGetStyle(J)I": (h: bigint) => (deref<JTypeface>(h) ?? tfDefault).style(),
  "nativeGetWeight(J)I": (h: bigint) => (deref<JTypeface>(h) ?? tfDefault).weight,
  "nativeGetReleaseFunc()J": () => FINALIZER,
  "nativeGetFamilySize(J)I": () => 1,
  "nativeCreateFromArray([JJII)J": () => handle(tfDefault),
  "nativeSetDefault(J)V": () => {},
  "nativeRegisterGenericFamily(Ljava/lang/String;J)V": () => {},
});

// ── android.graphics.Paint ─────────────────────────────────────────────────────────────
// JPaint is the object: it already carries the tuned font-string memo, the fill-style
// resolution and the letter spacing, and this is the same state under AOSP's names.
const paint = (h: bigint) => deref<JPaint>(h);

const CAPS = ["butt", "round", "square"] as const;
const JOINS = ["miter", "round", "bevel"] as const;
/** the boolean flag setters AOSP spells one per flag beside nSetFlags */
function flag(set: (p: JPaint, v: boolean) => void) {
  return (h: bigint, v: number) => set(paint(h), !!v);
}

delegate("android/graphics/Paint", {
  "nInit()J": () => handle(new JPaint()),
  "nInitWithPaint(J)J": (h: bigint) => {
    const p = new JPaint();
    copyPaint(paint(h), p);
    return handle(p);
  },
  "nGetNativeFinalizer()J": () => FINALIZER,
  "nReset(J)V": (h: bigint) => { objs[Number(h)] = new JPaint(); },
  "nSet(JJ)V": (h: bigint, src: bigint) => copyPaint(paint(src), paint(h)),

  // colour and geometry
  "nSetColor(JI)V": (h: bigint, c: number) => { paint(h).color = c; },
  "nSetColor(JJJ)V": (h: bigint, _cs: bigint, c: bigint) => { paint(h).color = argbOfColorLong(c); },
  "nSetAlpha(JI)V": (h: bigint, a: number) => { const p = paint(h); p.color = (p.color & 0xffffff) | ((a & 0xff) << 24); },
  "nSetStyle(JI)V": (h: bigint, v: number) => { paint(h).style = v; },
  "nGetStyle(J)I": (h: bigint) => paint(h).style,
  "nSetStrokeWidth(JF)V": (h: bigint, w: number) => { paint(h).strokeWidth = w; },
  "nGetStrokeWidth(J)F": (h: bigint) => paint(h).strokeWidth,
  "nSetStrokeCap(JI)V": (h: bigint, v: number) => { paint(h).strokeCapN = CAPS[v] ?? "butt"; },
  "nGetStrokeCap(J)I": (h: bigint) => Math.max(0, CAPS.indexOf(paint(h).strokeCapN as never)),
  "nSetStrokeJoin(JI)V": (h: bigint, v: number) => { paint(h).strokeJoinN = JOINS[v] ?? "miter"; },
  "nGetStrokeJoin(J)I": (h: bigint) => Math.max(0, JOINS.indexOf(paint(h).strokeJoinN as never)),
  "nSetStrokeMiter(JF)V": () => {}, "nGetStrokeMiter(J)F": () => 4,

  // flags: nSetFlags sets the lot, and AOSP also spells one entry point per flag
  "nSetFlags(JI)V": (h: bigint, f: number) => {
    const p = paint(h);
    p.antiAlias = (f & 1) !== 0; p.underline = (f & 8) !== 0;
    p.strikeThru = (f & 0x10) !== 0; p.fakeBold = (f & 0x20) !== 0;
  },
  "nGetFlags(J)I": (h: bigint) => {
    const p = paint(h);
    return (p.antiAlias ? 1 : 0) | (p.underline ? 8 : 0) | (p.strikeThru ? 0x10 : 0) | (p.fakeBold ? 0x20 : 0);
  },
  "nSetAntiAlias(JZ)V": flag((p, v) => { p.antiAlias = v; }),
  "nSetUnderlineText(JZ)V": flag((p, v) => { p.underline = v; }),
  "nSetStrikeThruText(JZ)V": flag((p, v) => { p.strikeThru = v; }),
  "nSetFakeBoldText(JZ)V": flag((p, v) => { p.fakeBold = v; }),
  // Canvas2D has no dither, no bitmap filter toggle, no hinting and no linear/subpixel text
  "nSetDither(JZ)V": () => {}, "nSetFilterBitmap(JZ)V": () => {},
  "nSetLinearText(JZ)V": () => {}, "nSetSubpixelText(JZ)V": () => {},
  "nSetHinting(JI)V": () => {}, "nGetHinting(J)I": () => 1,

  // effects: each returns the native handle it was given, which is what Paint stores back
  "nSetShader(JJ)J": (h: bigint, sh: bigint) => { paint(h).shaderObj = deref(sh) ?? null; return sh; },
  "nSetColorFilter(JJ)J": (h: bigint, f: bigint) => f,
  "nSetMaskFilter(JJ)J": (_h: bigint, f: bigint) => f,
  "nSetPathEffect(JJ)J": (_h: bigint, f: bigint) => f,
  "nSetXfermode(JI)V": () => {},
  "nSetShadowLayer(JFFFJJ)V": () => {},
  "nHasShadowLayer(J)Z": () => 0,

  // text
  "nSetTypeface(JJ)V": (h: bigint, t: bigint) => { paint(h).tf = deref<JTypeface>(t) ?? tfDefault; },
  "nSetTextSize(JF)V": (h: bigint, v: number) => { paint(h).textSize = v; },
  "nGetTextSize(J)F": (h: bigint) => paint(h).textSize,
  "nSetTextAlign(JI)V": (h: bigint, v: number) => { paint(h).textAlignN = v; },
  "nGetTextAlign(J)I": (h: bigint) => paint(h).textAlignN,
  "nSetLetterSpacing(JF)V": (h: bigint, v: number) => { paint(h).letterSpacingEm = v; },
  "nGetLetterSpacing(J)F": (h: bigint) => paint(h).letterSpacingEm,
  "nAscent(J)F": (h: bigint) => fontAscent(paint(h)),
  "nDescent(J)F": (h: bigint) => fontDescent(paint(h)),
  "nGetUnderlinePosition(J)F": (h: bigint) => paint(h).textSize * 0.1,
  "nGetUnderlineThickness(J)F": (h: bigint) => paint(h).textSize * 0.06,
  "nGetStrikeThruPosition(J)F": (h: bigint) => -paint(h).textSize * 0.28,
  "nGetStrikeThruThickness(J)F": (h: bigint) => paint(h).textSize * 0.06,
  "nGetFontMetrics(JLandroid/graphics/Paint$FontMetrics;Z)F": (h: bigint, fm: Metrics) => {
    const p = paint(h);
    fillFontMetrics(p, fm, false);
    return fontDescent(p) - fontAscent(p);
  },
  "nGetFontMetricsInt(JLandroid/graphics/Paint$FontMetricsInt;Z)I": (h: bigint, fm: Metrics) => {
    const p = paint(h);
    fillFontMetrics(p, fm, true);
    return Math.round(fontDescent(p) - fontAscent(p));
  },
  // the per-run forms answer for one text run; with one font for everything, the run does
  // not change the answer, so they are the whole-paint metrics
  "nGetFontMetricsIntForText(J[CIIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _c: Uint16Array, _a: number, _b: number, _d: number, _e: number, _f: number, fm: Metrics) => fillFontMetrics(paint(h), fm, true),
  "nGetFontMetricsIntForText(JLjava/lang/String;IIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _s: string, _a: number, _b: number, _d: number, _e: number, _f: number, fm: Metrics) => fillFontMetrics(paint(h), fm, true),

  "nGetTextAdvances(J[CIIIII[FI)F": (h: bigint, c: Uint16Array, i: number, n: number, _ci: number, _cc: number, _f: number, adv: Float32Array | null, ai: number) =>
    advanceRun(paint(h), chars(c, i, n), adv, ai),
  "nGetTextAdvances(JLjava/lang/String;IIIII[FI)F": (h: bigint, s: string, a: number, b: number, _ci: number, _cc: number, _f: number, adv: Float32Array | null, ai: number) =>
    advanceRun(paint(h), s.slice(a, b), adv, ai),
  "nGetRunAdvance(J[CIIIIZI)F": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number) =>
    measureText(paint(h), chars(c, start, Math.max(0, Math.min(offset, end) - start))),
  "nGetRunCharacterAdvance(J[CIIIIZI[FILandroid/graphics/RectF;)F": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number, adv: Float32Array | null, ai: number) =>
    runCharacterAdvance(paint(h), c, start, end, offset, adv, ai),
  "nGetRunCharacterAdvance(J[CIIIIZI[FILandroid/graphics/RectF;Landroid/graphics/Paint$RunInfo;)F": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number, adv: Float32Array | null, ai: number) =>
    runCharacterAdvance(paint(h), c, start, end, offset, adv, ai),
  "nGetOffsetForAdvance(J[CIIIIZF)I": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, advance: number) => {
    const p = paint(h);
    let w = 0;
    for (let i = start; i < end; i++) {
      const cw = measureText(p, chars(c, i, 1));
      if (w + cw / 2 > advance) return i;
      w += cw;
    }
    return end;
  },
  // cursor movement is by character: there is no grapheme clustering in the Canvas2D backend
  "nGetTextRunCursor(J[CIIIII)I": (_h: bigint, _c: Uint16Array, _ci: number, _cc: number, _d: number, offset: number, opt: number) => cursor(offset, opt),
  "nGetTextRunCursor(JLjava/lang/String;IIIII)I": (_h: bigint, _s: string, _ci: number, _cc: number, _d: number, offset: number, opt: number) => cursor(offset, opt),
  "nBreakText(JLjava/lang/String;ZFI[F)I": (h: bigint, s: string, forwards: number, maxWidth: number, _bidi: number, measured: Float32Array | null) =>
    breakText(paint(h), s, !!forwards, maxWidth, measured),
  "nBreakText(J[CIIFI[F)I": (h: bigint, c: Uint16Array, i: number, n: number, maxWidth: number, _bidi: number, measured: Float32Array | null) =>
    breakText(paint(h), chars(c, i, Math.abs(n)), n >= 0, maxWidth, measured),
  "nGetCharArrayBounds(J[CIIILandroid/graphics/Rect;)V": (h: bigint, c: Uint16Array, i: number, n: number, _bidi: number, r: Rect) =>
    textBounds(paint(h), chars(c, i, n), r),
  "nGetStringBounds(JLjava/lang/String;IIILandroid/graphics/Rect;)V": (h: bigint, s: string, a: number, b: number, _bidi: number, r: Rect) =>
    textBounds(paint(h), s.slice(a, b), r),
  "nEqualsForTextMeasurement(JJ)Z": (a: bigint, b: bigint) => {
    const x = paint(a), y = paint(b);
    return x.textSize === y.textSize && x.tf === y.tf && x.letterSpacingEm === y.letterSpacingEm ? 1 : 0;
  },
  "nHasGlyph(JILjava/lang/String;)Z": () => 1,
  // an outline the Canvas2D backend cannot produce: leave the path empty rather than wrong
  "nGetTextPath(JI[CIIFFJ)V": () => {},
  "nGetTextPath(JILjava/lang/String;IIFFJ)V": () => {},
  "nGetFillPath(JJJ)Z": (_h: bigint, src: bigint, dst: bigint) => {
    const d = deref<JPath>(dst);
    d.ops = deref<JPath>(src).ops.slice();
    d.dirty = true;
    return 1;
  },

  // state we accept and do not act on: one font, one locale, no hyphenation
  "nSetElegantTextHeight(JI)V": () => {}, "nGetElegantTextHeight(J)I": () => 0,
  "nSetStartHyphenEdit(JI)V": () => {}, "nGetStartHyphenEdit(J)I": () => 0,
  "nSetEndHyphenEdit(JI)V": () => {}, "nGetEndHyphenEdit(J)I": () => 0,
  "nSetWordSpacing(JF)V": () => {}, "nGetWordSpacing(J)F": () => 0,
  "nSetTextScaleX(JF)V": () => {}, "nGetTextScaleX(J)F": () => 1,
  "nSetTextSkewX(JF)V": () => {}, "nGetTextSkewX(J)F": () => 0,
  "nSetTextLocales(JLjava/lang/String;)I": () => 0,
  "nSetTextLocalesByMinikinLocaleListId(JI)V": () => {},
  "nSetFontFeatureSettings(JLjava/lang/String;)V": () => {},
});

interface Metrics { top: number; ascent: number; descent: number; bottom: number; leading: number }
const chars = (c: Uint16Array, off: number, n: number) => charsToString(c, off, n);
const cursor = (offset: number, opt: number) =>
  opt === 0 || opt === 2 ? Math.max(0, offset - 1) : opt === 1 || opt === 3 ? offset + 1 : offset;

function runCharacterAdvance(p: JPaint, c: Uint16Array, start: number, end: number, offset: number, adv: Float32Array | null, ai: number): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    const w = measureText(p, chars(c, i, 1));
    if (adv) adv[ai + i - start] = w;
    if (i < offset) total += w;
  }
  return total;
}

function advanceRun(p: JPaint, run: string, advances: Float32Array | null, at: number): number {
  let total = 0;
  for (let i = 0; i < run.length; i++) {
    const w = measureText(p, run[i]);
    if (advances) advances[at + i] = w;
    total += w;
  }
  return total;
}
/** AOSP returns how many characters fit and, through `measured`, how wide they were */
function breakText(p: JPaint, s: string, forwards: boolean, maxWidth: number, measured: Float32Array | null): number {
  let w = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = forwards ? s[i] : s[s.length - 1 - i];
    const cw = measureText(p, c);
    if (w + cw > maxWidth) break;
    w += cw; n++;
  }
  if (measured) measured[0] = w;
  return n;
}
function textBounds(p: JPaint, s: string, r: Rect) {
  r.left = 0;
  r.top = Math.round(fontAscent(p));
  r.right = Math.round(measureText(p, s));
  r.bottom = Math.round(fontDescent(p));
}

// ── android.graphics.Path ──────────────────────────────────────────────────────────────
const path = (h: bigint) => deref<JPath>(h);

/** AOSP's Path$Direction is CW=0/CCW=1; ours carries the same ordinal through the op list */
delegate("android/graphics/Path", {
  "nInit()J": () => handle(new JPath()),
  "nInit(J)J": (h: bigint) => {
    const p = new JPath();
    p.ops = path(h).ops.slice();
    return handle(p);
  },
  "nGetFinalizer()J": () => FINALIZER,
  "nReset(J)V": (h: bigint) => { const p = path(h); p.ops = []; p.dirty = true; },
  "nRewind(J)V": (h: bigint) => { const p = path(h); p.ops = []; p.dirty = true; },
  "nSet(JJ)V": (h: bigint, s: bigint) => { const p = path(h); p.ops = path(s).ops.slice(); p.dirty = true; },
  "nIsEmpty(J)Z": (h: bigint) => (path(h).ops.length ? 0 : 1),
  "nIncReserve(JI)V": () => {},
  "nGetGenerationID(J)I": (h: bigint) => path(h).ops.length,

  "nMoveTo(JFF)V": (h: bigint, x: number, y: number) => { const p = path(h); p.add(["m", x, y]); p.curX = x; p.curY = y; },
  "nLineTo(JFF)V": (h: bigint, x: number, y: number) => { const p = path(h); p.add(["l", x, y]); p.curX = x; p.curY = y; },
  "nQuadTo(JFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number) => {
    const p = path(h); p.add(["q", x1, y1, x2, y2]); p.curX = x2; p.curY = y2;
  },
  "nCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => {
    const p = path(h); p.add(["c", a, b, c, d, e, f]); p.curX = e; p.curY = f;
  },
  // a conic is a rational quadratic; at the weights Skia uses for round joins the plain
  // quadratic through the same control points is within a fraction of a pixel
  "nConicTo(JFFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number) => {
    const p = path(h); p.add(["q", x1, y1, x2, y2]); p.curX = x2; p.curY = y2;
  },
  // the relative forms are the same ops taken from the current point
  "nRMoveTo(JFF)V": (h: bigint, dx: number, dy: number) => { const p = path(h); p.add(["m", p.curX += dx, p.curY += dy]); },
  "nRLineTo(JFF)V": (h: bigint, dx: number, dy: number) => { const p = path(h); p.add(["l", p.curX += dx, p.curY += dy]); },
  "nRQuadTo(JFFFF)V": (h: bigint, dx1: number, dy1: number, dx2: number, dy2: number) => {
    const p = path(h);
    p.add(["q", p.curX + dx1, p.curY + dy1, p.curX + dx2, p.curY + dy2]);
    p.curX += dx2; p.curY += dy2;
  },
  "nRCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => {
    const p = path(h);
    p.add(["c", p.curX + a, p.curY + b, p.curX + c, p.curY + d, p.curX + e, p.curY + f]);
    p.curX += e; p.curY += f;
  },
  "nRConicTo(JFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number) => {
    const p = path(h);
    p.add(["q", p.curX + a, p.curY + b, p.curX + c, p.curY + d]);
    p.curX += c; p.curY += d;
  },
  "nClose(J)V": (h: bigint) => { path(h).add(["z"]); },
  "nSetLastPoint(JFF)V": (h: bigint, x: number, y: number) => { const p = path(h); p.curX = x; p.curY = y; },

  "nAddRect(JFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, d: number) => { path(h).add(["rect", l, t, r, b, d]); },
  "nAddOval(JFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, d: number) => { path(h).add(["oval", l, t, r, b, d]); },
  "nAddCircle(JFFFI)V": (h: bigint, x: number, y: number, r: number, d: number) => { path(h).add(["circle", x, y, r, d]); },
  "nAddArc(JFFFFFF)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number) => { path(h).add(["arc", l, t, r, b, start, sweep, 0]); },
  "nArcTo(JFFFFFFZ)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number, force: number) => { path(h).add(["arc", l, t, r, b, start, sweep, force]); },
  "nAddRoundRect(JFFFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number) => {
    path(h).add(["rrect", l, t, r, b, rx, ry, rx, ry, rx, ry, rx, ry]);
  },
  // float[8] = one (x,y) radius per corner, clockwise from top-left; collapsing it to one
  // radius turns every asymmetric shape into a uniform one
  "nAddRoundRect(JFFFF[FI)V": (h: bigint, l: number, t: number, r: number, b: number, radii: Float32Array) => {
    path(h).add(["rrect", l, t, r, b, ...Array.from({ length: 8 }, (_, i) => radii[i] ?? 0)]);
  },
  "nAddPath(JJ)V": (h: bigint, o: bigint) => { const p = path(h); p.ops.push(...path(o).ops); p.dirty = true; },
  "nAddPath(JJFF)V": (h: bigint, o: bigint, dx: number, dy: number) => {
    const add = new JPath();
    add.ops = path(o).ops.map((op) => [...op] as typeof op);
    pathOffset(add, dx, dy);
    const p = path(h);
    p.ops.push(...add.ops);
    p.dirty = true;
  },
  "nAddPath(JJJ)V": (h: bigint, o: bigint, mat: bigint) => {
    const add = new JPath();
    add.ops = path(o).ops.map((op) => [...op] as typeof op);
    pathTransform(add, affine(deref<Mat>(mat)));
    const p = path(h);
    p.ops.push(...add.ops);
    p.dirty = true;
  },

  "nOffset(JFF)V": (h: bigint, dx: number, dy: number) => pathOffset(path(h), dx, dy),
  "nTransform(JJ)V": (h: bigint, mat: bigint) => pathTransform(path(h), affine(deref<Mat>(mat))),
  "nTransform(JJJ)V": (h: bigint, mat: bigint, dst: bigint) => {
    const d = path(dst);
    d.ops = path(h).ops.map((op) => [...op] as typeof op);
    pathTransform(d, affine(deref<Mat>(mat)));
  },
  "nComputeBounds(JLandroid/graphics/RectF;)V": (h: bigint, r: Rect) => pathBounds(path(h), r),
  "nSetFillType(JI)V": (h: bigint, ft: number) => { path(h).fillRule = ft === 1 || ft === 3 ? "evenodd" : "nonzero"; },
  "nGetFillType(J)I": (h: bigint) => (path(h).fillRule === "evenodd" ? 1 : 0),

  // Skia answers these off geometry we do not keep; none of them changes what is drawn
  "nIsRect(JLandroid/graphics/RectF;)Z": (h: bigint, r: Rect) => {
    const p = path(h);
    if (p.ops.length !== 1 || p.ops[0][0] !== "rect") return 0;
    pathBounds(p, r);
    return 1;
  },
  "nIsConvex(J)Z": () => 1,
  "nIsInterpolatable(JJ)Z": () => 0,
  "nInterpolate(JJFJ)Z": () => 0,
  "nOp(JJIJ)Z": () => 0,
  "nApproximate(JF)[F": () => new Float32Array(0),
});

/** the 6-element affine pathTransform takes, from AOSP's 3x3 */
const affine = (m: Mat): number[] => [m[0], m[3], m[1], m[4], m[2], m[5]];
