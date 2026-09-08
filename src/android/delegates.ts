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
import { handle, deref, replace, release } from "./handles";
import {
  JPaint, JTypeface, tfDefault, mkTypeface, measureText,
  fontAscent, fontDescent, fillFontMetrics, copyPaint, argbOfColorLong,
  JCanvas, JBitmap, JRect, canvasMethods, bitmapMethods, colorLongOfArgb,
} from "./graphics";
import { newObj } from "../jvm/natives/jlang";
import { charsToString, floatToIntBits } from "../jvm/abi";
import { JPath, pathBounds, pathOffset, pathTransform } from "./path";
import { greedyBreaks, type JTextPaint, type TLine } from "./text";
import {
  Resources, JTheme, JAttrSet, JTypedArray, obtainStyled, resolveStyleValue, rvString,
  currentResources, T_STR, T_PX, type RV,
} from "./res";
import { TV, XE, parseAXMLDoc, StringPool, type XmlDoc, type XmlEvent } from "./axml";
import { jarray } from "../jvm/abi";
import { device } from "../shell/config";
import { BytesFile, type FileSource } from "../shell/lazyfile";

// ── handles ────────────────────────────────────────────────────────────────────────────
// The table itself is src/android/handles.ts: AOSP bytecode asks our own objects for their
// native pointer too, and graphics.ts cannot import this file.
export { handle, deref } from "./handles";

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
  const set = (h: bigint, ...a: number[]) => { replace(h, at(a)); };
  const pre = (h: bigint, ...a: number[]) => { replace(h, mul(deref<Mat>(h), at(a))); };
  const post = (h: bigint, ...a: number[]) => { replace(h, mul(at(a), deref<Mat>(h))); };
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
  "nReset(J)V": (h: bigint) => { replace(h, identity()); },
  "nSet(JJ)V": (h: bigint, s: bigint) => { replace(h, s ? Float64Array.from(deref<Mat>(s)) : identity()); },
  "nSetConcat(JJJ)V": (h: bigint, a: bigint, b: bigint) => { replace(h, mul(deref<Mat>(a), deref<Mat>(b))); },
  "nPreConcat(JJ)V": (h: bigint, o: bigint) => { replace(h, mul(deref<Mat>(h), deref<Mat>(o))); },
  "nPostConcat(JJ)V": (h: bigint, o: bigint) => { replace(h, mul(deref<Mat>(o), deref<Mat>(h))); },
  "nIsIdentity(J)Z": (h: bigint) => (isIdentity(deref<Mat>(h)) ? 1 : 0),
  "nIsAffine(J)Z": (h: bigint) => { const m = deref<Mat>(h); return m[6] === 0 && m[7] === 0 && m[8] === 1 ? 1 : 0; },
  "nRectStaysRect(J)Z": (h: bigint) => {
    const m = deref<Mat>(h);
    return (m[1] === 0 && m[3] === 0) || (m[0] === 0 && m[4] === 0) ? 1 : 0;
  },
  "nEquals(JJ)Z": (a: bigint, b: bigint) => (deref<Mat>(a).every((v, i) => v === deref<Mat>(b)[i]) ? 1 : 0),
  "nGetValues(J[F)V": (h: bigint, out: Float32Array) => out.set(deref<Mat>(h)),
  "nSetValues(J[F)V": (h: bigint, v: Float32Array) => { replace(h, Float64Array.from(v)); },
  "nInvert(JJ)Z": (h: bigint, into: bigint) => {
    const inv = invert(deref<Mat>(h));
    if (!inv) return 0;
    replace(into, inv);
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
    replace(h, Float64Array.of(sx, 0, tx, 0, sy, ty, 0, 0, 1));
    return 1;
  },
  // 1 point is a translation, 2 a similarity, 3 a full affine. 4 is a perspective solve we
  // do not do: reporting failure is what a caller checks for, and is not a wrong transform.
  "nSetPolyToPoly(J[FI[FII)Z": (h: bigint, src: Float32Array, si: number, dst: Float32Array, di: number, n: number) => {
    const sp = (i: number) => [src[si + i * 2], src[si + i * 2 + 1]] as const;
    const dp = (i: number) => [dst[di + i * 2], dst[di + i * 2 + 1]] as const;
    if (n === 0) { replace(h, identity()); return 1; }
    if (n === 1) { replace(h, translateM(dp(0)[0] - sp(0)[0], dp(0)[1] - sp(0)[1])); return 1; }
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
      replace(h, m);
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
      replace(h, Float64Array.of(a, c, d0[0] - a * s0[0] - c * s0[1], b, d, d0[1] - b * s0[0] - d * s0[1], 0, 0, 1));
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
  "nativeCreateFromTypefaceWithExactStyle(JIZ)J": (h: bigint, weight: number, italic: number) => {
    const src = deref<JTypeface>(h) ?? tfDefault;
    return handle(mkTypeface(src.family, weight >= 600, !!italic, weight));
  },
  // a family built from font handles: we have the browser's faces, not font files, so the
  // family it resolves to is whatever the first face named
  "nativeCreateFromArray([JJII)J": (_fonts: BigInt64Array, fallback: bigint) => handle(deref<JTypeface>(fallback) ?? tfDefault),
  "nativeGetSupportedAxes(J)[I": () => null,
  "nativeSetDefault(J)V": () => {},
  "nativeRegisterGenericFamily(Ljava/lang/String;J)V": () => {},
  "nativeRegisterLocaleList(Ljava/lang/String;)V": () => {},
  "nativeAddFontCollections(J)V": () => {},
  "nativeWarmUpCache(Ljava/lang/String;)V": () => {},
  // the serialised typeface cache a process shares with the system; there is no other process
  "nativeReadTypefaces(Ljava/nio/ByteBuffer;I)[J": () => null,
  "nativeWriteTypefaces(Ljava/nio/ByteBuffer;I[J)I": () => 0,
  // Typeface.DEFAULT and friends are set through this from the static initialiser
  "nativeForceSetStaticFinalField(Ljava/lang/String;Landroid/graphics/Typeface;)V": () => {},
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
  "nReset(J)V": (h: bigint) => { replace(h, new JPaint()); },
  "nSet(JJ)V": (h: bigint, src: bigint) => copyPaint(paint(src), paint(h)),

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

// ── android.graphics.Canvas / BaseCanvas ───────────────────────────────────────────────
// Every one of these routes into canvasMethods, which is the table our own Canvas native
// already uses: one copy of each draw body, reached under two sets of names.
const canvas = (h: bigint) => deref<JCanvas>(h);
type CanvasFn = (this: JCanvas, ...a: never[]) => unknown;
/** call one of Canvas's own method bodies by its Java descriptor */
function cm(desc: string): CanvasFn {
  const fn = canvasMethods?.[desc];
  if (typeof fn !== "function") throw new Error(`delegates: no canvasMethods[${desc}]`);
  return fn as CanvasFn;
}
const on = (desc: string) => {
  const fn = cm(desc);
  return (h: bigint, ...a: unknown[]) => (fn as (...x: unknown[]) => unknown).apply(canvas(h), a);
};
/** the trailing paint handle every nDraw* carries has to become the paint itself */
const withPaint = (desc: string, arity: number) => {
  const fn = cm(desc);
  return (h: bigint, ...a: unknown[]) => (fn as (...x: unknown[]) => unknown).apply(canvas(h), [...a.slice(0, arity), paint(a[arity] as bigint)]);
};

delegate("android/graphics/Canvas", {
  "nInitRaster(JJ)J": (b: bigint) => handle(bitmapCanvas(deref<JBitmap>(b))),
  "nInitRaster(J)J": (b: bigint) => handle(bitmapCanvas(deref<JBitmap>(b))),
  "nGetNativeFinalizer()J": () => FINALIZER,
  "nSetBitmap(JJ)V": (h: bigint, b: bigint) => { replace(h, bitmapCanvas(deref<JBitmap>(b))); },
  "nGetWidth(J)I": (h: bigint) => canvas(h).w,
  "nGetHeight(J)I": (h: bigint) => canvas(h).h,
  "nIsOpaque(J)Z": () => 0,
  "nIsHighContrastText(J)Z": () => 0,
  "nSetCompatibilityVersion(I)V": () => {},
  "nFreeCaches()V": () => {}, "nFreeTextLayoutCaches()V": () => {},
  "nSetDrawFilter(JJ)V": () => {},

  "nSave(JI)I": on("save()I"),
  "nRestore(J)Z": (h: bigint) => { const c = canvas(h); if (c.saveCount <= 1) return 0; on("restore()V")(h); return 1; },
  "nRestoreToCount(JI)V": on("restoreToCount(I)V"),
  "nGetSaveCount(J)I": on("getSaveCount()I"),
  "nSaveLayer(JFFFFJ)I": (h: bigint, l: number, t: number, r: number, b: number) => on("saveLayerAlpha(FFFFI)I")(h, l, t, r, b, 255),
  "nSaveLayerAlpha(JFFFFI)I": on("saveLayerAlpha(FFFFI)I"),
  // an unclipped layer is a plain save here: there is no clip to lift
  "nSaveUnclippedLayer(JIIII)I": on("save()I"),
  "nRestoreUnclippedLayer(JIJ)V": (h: bigint, count: number) => on("restoreToCount(I)V")(h, count),

  "nTranslate(JFF)V": on("translate(FF)V"),
  "nScale(JFF)V": on("scale(FF)V"),
  "nRotate(JF)V": on("rotate(F)V"),
  "nSkew(JFF)V": on("skew(FF)V"),
  "nConcat(JJ)V": (h: bigint, m: bigint) => applyMatrix(canvas(h), deref<Mat>(m), false),
  "nConcat(J[F)V": (h: bigint, v: Float32Array) => applyMatrix(canvas(h), Float64Array.from(v), false),
  "nSetMatrix(JJ)V": (h: bigint, m: bigint) => applyMatrix(canvas(h), m ? deref<Mat>(m) : identity(), true),
  "nGetMatrix(JJ)V": (h: bigint, into: bigint) => {
    const t = canvas(h).ctx.getTransform();
    replace(into, Float64Array.of(t.a, t.c, t.e, t.b, t.d, t.f, 0, 0, 1));
  },

  "nClipRect(JFFFFI)Z": (h: bigint, l: number, t: number, r: number, b: number) => on("clipRect(FFFF)Z")(h, l, t, r, b),
  "nClipPath(JJI)Z": (h: bigint, p: bigint) => {
    const c = canvas(h), pp = deref<JPath>(p);
    c.ctx.clip(pp.path(), pp.fillRule);
    return 1;
  },
  "nClipShader(JJI)V": () => {},
  "nGetClipBounds(JLandroid/graphics/Rect;)Z": (h: bigint, r: Rect) => {
    const c = canvas(h);
    r.left = 0; r.top = 0; r.right = c.w; r.bottom = c.h;
    return 1;
  },
  "nQuickReject(JFFFF)Z": () => 0,
  "nQuickReject(JJ)Z": () => 0,
});

delegate("android/graphics/BaseCanvas", {
  "nDrawColor(JII)V": (h: bigint, c: number) => on("drawColor(I)V")(h, c),
  "nDrawColor(JJJI)V": (h: bigint, _cs: bigint, c: bigint) => on("drawColor(I)V")(h, argbOfColorLong(c)),
  "nDrawPaint(JJ)V": (h: bigint, p: bigint) => on("drawColor(I)V")(h, paint(p).color),
  "nDrawRect(JFFFFJ)V": withPaint("drawRect(FFFFLandroid/graphics/Paint;)V", 4),
  "nDrawRoundRect(JFFFFFFJ)V": withPaint("drawRoundRect(FFFFFFLandroid/graphics/Paint;)V", 6),
  "nDrawCircle(JFFFJ)V": withPaint("drawCircle(FFFLandroid/graphics/Paint;)V", 3),
  "nDrawOval(JFFFFJ)V": withPaint("drawOval(FFFFLandroid/graphics/Paint;)V", 4),
  "nDrawArc(JFFFFFFZJ)V": withPaint("drawArc(FFFFFFZLandroid/graphics/Paint;)V", 7),
  "nDrawLine(JFFFFJ)V": withPaint("drawLine(FFFFLandroid/graphics/Paint;)V", 4),
  "nDrawPoint(JFFJ)V": withPaint("drawPoint(FFLandroid/graphics/Paint;)V", 2),
  "nDrawPath(JJJ)V": (h: bigint, p: bigint, pt: bigint) => cm("drawPath(Landroid/graphics/Path;Landroid/graphics/Paint;)V").call(canvas(h), deref<JPath>(p) as never, paint(pt) as never),
  "nDrawLines(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, count: number, pt: bigint) =>
    cm("drawLines([FLandroid/graphics/Paint;)V").call(canvas(h), pts.subarray(off, off + count) as never, paint(pt) as never),
  "nDrawPoints(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, count: number, pt: bigint) => {
    const c = canvas(h), p = paint(pt);
    for (let i = 0; i + 1 < count; i += 2) cm("drawPoint(FFLandroid/graphics/Paint;)V").call(c, pts[off + i] as never, pts[off + i + 1] as never, p as never);
  },
  "nDrawText(JLjava/lang/String;IIFFIJ)V": (h: bigint, s: string, start: number, end: number, x: number, y: number, _flags: number, pt: bigint) =>
    cm("drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V").call(canvas(h), s.slice(start, end) as never, x as never, y as never, paint(pt) as never),
  "nDrawText(J[CIIFFIJ)V": (h: bigint, c: Uint16Array, i: number, n: number, x: number, y: number, _flags: number, pt: bigint) =>
    cm("drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V").call(canvas(h), charsToString(c, i, n) as never, x as never, y as never, paint(pt) as never),
  "nDrawTextRun(JLjava/lang/String;IIIIFFZJ)V": (h: bigint, s: string, start: number, end: number, _cs: number, _ce: number, x: number, y: number, _rtl: number, pt: bigint) =>
    cm("drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V").call(canvas(h), s.slice(start, end) as never, x as never, y as never, paint(pt) as never),
  "nDrawTextRun(J[CIIIIFFZJJ)V": (h: bigint, c: Uint16Array, i: number, n: number, _cs: number, _cc: number, x: number, y: number, _rtl: number, pt: bigint) =>
    cm("drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V").call(canvas(h), charsToString(c, i, n) as never, x as never, y as never, paint(pt) as never),
  "nDrawBitmap(JJFFJIII)V": (h: bigint, b: bigint, x: number, y: number, pt: bigint) =>
    cm("drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V").call(canvas(h), deref<JBitmap>(b) as never, x as never, y as never, (pt ? paint(pt) : null) as never),
  "nDrawBitmap(JJFFFFFFFFJII)V": (h: bigint, b: bigint, sl: number, st: number, sr: number, sb: number, dl: number, dt: number, dr: number, db: number, pt: bigint) =>
    cm("drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/RectF;Landroid/graphics/Paint;)V")
      .call(canvas(h), deref<JBitmap>(b) as never, rect(sl, st, sr, sb) as never, rect(dl, dt, dr, db) as never, (pt ? paint(pt) : null) as never),
  "nDrawBitmapMatrix(JJJJ)V": (h: bigint, b: bigint, m: bigint, pt: bigint) => {
    const c = canvas(h);
    c.ctx.save();
    applyMatrix(c, deref<Mat>(m), false);
    cm("drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V")
      .call(c, deref<JBitmap>(b) as never, 0 as never, 0 as never, (pt ? paint(pt) : null) as never);
    c.ctx.restore();
  },
  // a colour array rather than a Bitmap: put the pixels in one and draw that
  "nDrawBitmap(J[IIIFFIIZJ)V": (h: bigint, colors: Int32Array, offset: number, stride: number, x: number, y: number, w: number, ih: number, _alpha: number, pt: bigint) => {
    const b = JBitmap.create(w, ih);
    const img = b.ctx.createImageData(w, ih);
    for (let row = 0; row < ih; row++) {
      for (let col = 0; col < w; col++) {
        const c = colors[offset + row * stride + col], o = (row * w + col) * 4;
        img.data[o] = (c >> 16) & 0xff; img.data[o + 1] = (c >> 8) & 0xff;
        img.data[o + 2] = c & 0xff; img.data[o + 3] = (c >>> 24) & 0xff;
      }
    }
    b.ctx.putImageData(img, 0, 0);
    cm("drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V").call(canvas(h), b as never, x as never, y as never, (pt ? paint(pt) : null) as never);
  },
  // the ring between two round rects, which is how a ripple's bounded edge is drawn: the
  // outer filled with the inner taken out of it
  "nDrawDoubleRoundRect(JFFFFFFFFFFFFJ)V": (h: bigint, ol: number, ot: number, or: number, ob: number, orx: number, ory: number, il: number, it: number, ir: number, ib: number, irx: number, iry: number, pt: bigint) =>
    doubleRoundRect(canvas(h), [ol, ot, or, ob], [orx, ory], [il, it, ir, ib], [irx, iry], paint(pt)),
  "nDrawDoubleRoundRect(JFFFF[FFFFF[FJ)V": (h: bigint, ol: number, ot: number, or: number, ob: number, orad: Float32Array, il: number, it: number, ir: number, ib: number, irad: Float32Array, pt: bigint) =>
    doubleRoundRect(canvas(h), [ol, ot, or, ob], [orad[0], orad[1]], [il, it, ir, ib], [irad[0], irad[1]], paint(pt)),
  // a nine-patch's stretch regions live in its chunk, which the drawable layer already
  // resolves; from here it is the bitmap scaled into the destination
  "nDrawNinePatch(JJJFFFFJII)V": (h: bigint, b: bigint, _chunk: bigint, l: number, t: number, r: number, bo: number, pt: bigint) =>
    cm("drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/RectF;Landroid/graphics/Paint;)V")
      .call(canvas(h), deref<JBitmap>(b) as never, null as never, rect(l, t, r, bo) as never, (pt ? paint(pt) : null) as never),
  // positioned glyph ids, which only a shaping engine produces: there is none behind
  // Canvas2D, and the text entry points above are what the framework actually uses
  "nDrawGlyphs(J[I[FIIIJJ)V": () => {},
  // text on a path, meshes, vertices and regions have no Canvas2D form; a hole punched in a
  // surface is a compositor operation there is no surface for
  "nDrawTextOnPath(J[CIIJFFIJ)V": () => {}, "nDrawTextOnPath(JLjava/lang/String;JFFIJ)V": () => {},
  "nDrawBitmapMesh(JJII[FI[IIJ)V": () => {}, "nDrawMesh(JJIJ)V": () => {},
  "nDrawVertices(JII[FI[FI[II[SIIJ)V": () => {}, "nDrawRegion(JJJ)V": () => {},
  "nPunchHole(JFFFFFFF)V": () => {},
});

/** a Canvas over a bitmap's backing context, as Canvas(Bitmap) makes one */
function bitmapCanvas(b: JBitmap | undefined): JCanvas {
  const c = new JCanvas();
  if (b) { c.ctx = b.ctx; c.w = b.w; c.h = b.h; c.bmp = b; }
  return c;
}
function doubleRoundRect(c: JCanvas, o: number[], orad: number[], i: number[], irad: number[], p: JPaint) {
  const ring = new Path2D();
  ring.roundRect(o[0], o[1], o[2] - o[0], o[3] - o[1], Math.min(orad[0], (o[2] - o[0]) / 2, (o[3] - o[1]) / 2));
  ring.roundRect(i[0], i[1], i[2] - i[0], i[3] - i[1], Math.min(irad[0], (i[2] - i[0]) / 2, (i[3] - i[1]) / 2));
  c.drawShape(p, (x) => x.fill(ring, "evenodd"), (x) => x.stroke(ring));
}
function rect(l: number, t: number, r: number, b: number): JRect {
  const o = new JRect();
  o.left = l; o.top = t; o.right = r; o.bottom = b;
  return o;
}
/** AOSP's 3x3 onto the 2D context's transform; a perspective row cannot be carried */
function applyMatrix(c: JCanvas, m: Mat, replace: boolean) {
  if (replace) c.ctx.setTransform(m[0], m[3], m[1], m[4], m[2], m[5]);
  else c.ctx.transform(m[0], m[3], m[1], m[4], m[2], m[5]);
}

// ── android.graphics.text: MeasuredText and LineBreaker ────────────────────────────────
// StaticLayout and Layout declare ZERO natives, so real AOSP line breaking is what these two
// buy: everything above them is pure Java that already runs. The parameter meanings are not
// guessable from the descriptors — nAddStyleRun is (builder, paint, lineBreakStyle,
// lineBreakWordStyle, hyphenation, start, end, isRtl) — so they came out of appendStyleRun's
// and computeLineBreaks' own bytecode, off the register moves into each range invoke.
//
// The breaking itself is text.ts's greedyBreaks, the body JLayout uses, so AOSP's Layout and
// ours agree by construction rather than by two implementations happening to match. AOSP's
// balanced and optimal strategies are a later, separate change; this is the greedy one.
interface Run { start: number; end: number; paint: JTextPaint }
interface Meas { text: string; runs: Run[] }
interface Breaks { lines: TLine[]; asc: number; desc: number }

const meas = (h: bigint) => deref<Meas>(h);
/** the paint covering `at`, or the paragraph's first — one paint per paragraph is the common
 *  case, and a run-aware breaker is what AOSP's own is, not what greedyBreaks is */
const runPaint = (m: Meas, at = 0) => (m.runs.find((r) => at >= r.start && at < r.end) ?? m.runs[0])?.paint;
const measWidth = (m: Meas, start: number, end: number) => {
  const p = runPaint(m, start);
  return p ? measureText(p, m.text.slice(start, end)) : 0;
};

delegate("android/graphics/text/MeasuredText$Builder", {
  "nInitBuilder()J": () => handle({ text: "", runs: [] } as Meas),
  "nFreeBuilder(J)V": release,
  "nAddStyleRun(JJIIZIIZ)V": (h: bigint, pt: bigint, _lbStyle: number, _lbWordStyle: number, _hyphen: number, start: number, end: number) => {
    meas(h).runs.push({ start, end, paint: paint(pt) as JTextPaint });
  },
  // a replacement span (an inline image) occupies its width and no text: nothing to measure
  "nAddReplacementRun(JJIIF)V": () => {},
  "nBuildMeasuredText(JJ[CZZZZ)J": (h: bigint, _hint: bigint, chars: Uint16Array) => {
    const m = meas(h);
    return handle({ text: charsToString(chars, 0, chars.length), runs: m.runs } as Meas);
  },
});

delegate("android/graphics/text/MeasuredText", {
  "nGetReleaseFunc()J": () => FINALIZER,
  "nGetMemoryUsage(J)I": (h: bigint) => meas(h).text.length * 2,
  "nGetWidth(JII)F": (h: bigint, start: number, end: number) => measWidth(meas(h), start, end),
  "nGetCharWidthAt(JI)F": (h: bigint, i: number) => measWidth(meas(h), i, i + 1),
  "nGetBounds(J[CIILandroid/graphics/Rect;)V": (h: bigint, _c: Uint16Array, start: number, end: number, r: JRect) => {
    const m = meas(h), p = runPaint(m, start);
    r.left = 0; r.right = Math.ceil(measWidth(m, start, end));
    r.top = p ? Math.floor(fontAscent(p)) : 0;
    r.bottom = p ? Math.ceil(fontDescent(p)) : 0;
  },
});

delegate("android/graphics/text/LineBreaker", {
  "nInit(IIZ[IZ)J": () => handle({ lines: [], asc: 0, desc: 0 } as Breaks),
  "nGetReleaseFunc()J": () => FINALIZER,
  "nGetReleaseResultFunc()J": () => FINALIZER,
  "nComputeLineBreaks(J[CJIFIF[FFI)J": (_h: bigint, chars: Uint16Array, mt: bigint, len: number, firstWidth: number, firstCount: number, restWidth: number) => {
    const m = meas(mt);
    const p = runPaint(m);
    // AOSP has already split the text into paragraphs and hands us ONE, with its terminating
    // newline included. greedyBreaks splits on "\n" itself (JLayout gives it whole text), so
    // the newline has to come off first or every paragraph gains an empty line after it — and
    // the last break offset still has to cover it, because that is where the next paragraph
    // starts and minikin reports the same.
    const full = charsToString(chars, 0, len);
    const body = full.endsWith("\n") ? full.slice(0, -1) : full;
    const lines = p ? greedyBreaks(body, p, firstWidth, firstCount, restWidth) : [];
    if (lines.length && body.length !== full.length) lines[lines.length - 1].end = full.length;
    return handle({ lines, asc: p ? fontAscent(p) : 0, desc: p ? fontDescent(p) : 0 } as Breaks);
  },
  "nGetLineCount(J)I": (h: bigint) => deref<Breaks>(h).lines.length,
  "nGetLineBreakOffset(JI)I": (h: bigint, i: number) => deref<Breaks>(h).lines[i]?.end ?? 0,
  "nGetLineWidth(JI)F": (h: bigint, i: number) => deref<Breaks>(h).lines[i]?.width ?? 0,
  "nGetLineAscent(JI)F": (h: bigint) => deref<Breaks>(h).asc,
  "nGetLineDescent(JI)F": (h: bigint) => deref<Breaks>(h).desc,
  // no hyphenation and no tabs, which is what the flags carry
  "nGetLineFlag(JI)I": () => 0,
});

// ── android.os.SystemProperties ────────────────────────────────────────────────────────
// Reached the moment any framework class runs: Typeface, Paint and the view stack all read
// debug and persist properties from their <clinit>. Every property is ABSENT here, so every
// read gets the caller's own default — which is what a device that has not set one reports,
// and is the difference between "this device does not do that" and a made-up answer a library
// will branch on. A property that turns out to need a real value belongs in the one device
// profile (src/shell/config.ts), not in a table here.
delegate("android/os/SystemProperties", {
  "native_get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (_k: string, def: string | null) => def ?? "",
  "native_get_boolean(Ljava/lang/String;Z)Z": (_k: string, def: number) => def,
  "native_get_int(Ljava/lang/String;I)I": (_k: string, def: number) => def,
  "native_get_long(Ljava/lang/String;J)J": (_k: string, def: bigint) => def,
  "native_set(Ljava/lang/String;Ljava/lang/String;)V": () => {},
  "native_report_sysprop_change()V": () => {},
});

// ── android.graphics.Bitmap ────────────────────────────────────────────────────────────
// The handle is a JBitmap. Several of these build the Java object rather than returning a
// handle, so they construct AOSP's own Bitmap through its (nativePtr, w, h, density, mutable,
// ninePatchChunk, insets) constructor — which makes them async, and an async delegate on a cut
// class is safe because the suspension analysis has no spec to consult and assumes suspension.
//
// Everything here is ARGB_8888: that is what a Canvas2D raster is, and reporting anything else
// would have callers allocate for a depth we do not have. AOSP's NATIVE config numbering is
// not Bitmap.Config's ordinal (ALPHA_8=1 … ARGB_8888=5), and JBitmap.config carries the native
// one because that is what nativeConfig hands back.
const bmp = (h: bigint) => deref<JBitmap>(h);
type BitmapFn = (this: JBitmap, ...a: never[]) => unknown;
function bmf(desc: string): BitmapFn {
  const fn = bitmapMethods?.[desc];
  if (typeof fn !== "function") throw new Error(`delegates: no bitmapMethods[${desc}]`);
  return fn as BitmapFn;
}
/** the Java Bitmap around one of ours */
const wrap = (b: JBitmap) =>
  newObj("android/graphics/Bitmap", "(JIIIZ[BLandroid/graphics/NinePatch$InsetStruct;)V",
    handle(b), b.w, b.h, b.density, b.immutable ? 0 : 1, null, null);
const copyOf = (src: JBitmap) => {
  const b = JBitmap.create(src.w, src.h);
  b.density = src.density; b.hasAlpha = src.hasAlpha; b.premultiplied = src.premultiplied;
  b.pixels().set(src.pixels());
  return b;
};

delegate("android/graphics/Bitmap", {
  "nativeCreate([IIIIIIZJ)Landroid/graphics/Bitmap;": (colors: Int32Array | null, off: number, stride: number, w: number, h: number, _cfg: number, mutable: number) => {
    const b = JBitmap.create(w, h);
    b.immutable = !mutable;
    if (colors) bmf("setPixels([IIIIIII)V").call(b, colors as never, off as never, stride as never, 0 as never, 0 as never, w as never, h as never);
    return wrap(b);
  },
  "nativeCopy(JIZ)Landroid/graphics/Bitmap;": (h: bigint, _cfg: number, mutable: number) => {
    const b = copyOf(bmp(h));
    b.immutable = !mutable;
    return wrap(b);
  },
  "nativeCopyPreserveInternalConfig(J)Landroid/graphics/Bitmap;": (h: bigint) => wrap(copyOf(bmp(h))),
  // ashmem is a device allocator, not a pixel format: a copy is what the caller asked for
  "nativeCopyAshmem(J)Landroid/graphics/Bitmap;": (h: bigint) => wrap(copyOf(bmp(h))),
  "nativeCopyAshmemConfig(JI)Landroid/graphics/Bitmap;": (h: bigint) => wrap(copyOf(bmp(h))),
  // the shadow mask: AOSP returns an ALPHA_8 bitmap, and the nearest thing a Canvas2D raster
  // has is black with the source alpha, which composites identically
  "nativeExtractAlpha(JJ[I)Landroid/graphics/Bitmap;": (h: bigint, _paint: bigint, offsetXY: Int32Array | null) => {
    const src = bmp(h), b = JBitmap.create(src.w, src.h);
    const s = src.pixels(), d = b.pixels();
    for (let i = 0; i < d.length; i += 4) d[i + 3] = s[i + 3];
    if (offsetXY) { offsetXY[0] = 0; offsetXY[1] = 0; }
    return wrap(b);
  },

  "nativeRecycle(J)V": (h: bigint) => { bmp(h).recycled = true; },
  "nativeGetNativeFinalizer()J": () => FINALIZER,
  "nativePrepareToDraw(J)V": () => {},
  "nativeGenerationId(J)I": (h: bigint) => bmp(h).genId,
  "nativeConfig(J)I": (h: bigint) => bmp(h).config,
  "nativeRowBytes(J)I": (h: bigint) => bmp(h).w * 4,
  "nativeGetAllocationByteCount(J)I": (h: bigint) => bmp(h).w * bmp(h).h * 4,
  "nativeReconfigure(JIIIZ)V": (h: bigint, w: number, ht: number, _cfg: number, premul: number) => {
    const b = bmp(h);
    b.w = Math.max(1, w | 0); b.h = Math.max(1, ht | 0); b.premultiplied = !!premul;
  },

  "nativeGetPixel(JII)I": (h: bigint, x: number, y: number) => bmf("getPixel(II)I").call(bmp(h), x as never, y as never),
  "nativeSetPixel(JIII)V": (h: bigint, x: number, y: number, c: number) => bmf("setPixel(III)V").call(bmp(h), x as never, y as never, c as never),
  "nativeGetPixels(J[IIIIIII)V": (h: bigint, ...a: unknown[]) => bmf("getPixels([IIIIIII)V").apply(bmp(h), a as never[]),
  "nativeSetPixels(J[IIIIIII)V": (h: bigint, ...a: unknown[]) => bmf("setPixels([IIIIIII)V").apply(bmp(h), a as never[]),
  "nativeGetColor(JII)J": (h: bigint, x: number, y: number) => colorLongOfArgb(bmf("getPixel(II)I").call(bmp(h), x as never, y as never) as number),
  "nativeErase(JI)V": (h: bigint, c: number) => bmf("eraseColor(I)V").call(bmp(h), c as never),
  "nativeErase(JJJ)V": (h: bigint, _cs: bigint, color: bigint) => bmf("eraseColor(I)V").call(bmp(h), argbOfColorLong(color) as never),
  "nativeSameAs(JJ)Z": (a: bigint, b: bigint) => {
    const x = bmp(a), y = bmp(b);
    if (x.w !== y.w || x.h !== y.h) return 0;
    const p = x.pixels(), q = y.pixels();
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return 0;
    return 1;
  },
  "nativeCompress(JIILjava/io/OutputStream;[B)Z": (h: bigint, _fmt: number, q: number, out: unknown) =>
    bmf("compress(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z").call(bmp(h), null as never, q as never, out as never),

  "nativeHasAlpha(J)Z": (h: bigint) => (bmp(h).hasAlpha ? 1 : 0),
  "nativeSetHasAlpha(JZZ)V": (h: bigint, v: number) => { bmp(h).hasAlpha = !!v; },
  "nativeIsPremultiplied(J)Z": (h: bigint) => (bmp(h).premultiplied ? 1 : 0),
  "nativeSetPremultiplied(JZ)V": (h: bigint, v: number) => { bmp(h).premultiplied = !!v; },
  "nativeIsImmutable(J)Z": (h: bigint) => (bmp(h).immutable ? 1 : 0),
  "nativeSetImmutable(J)V": (h: bigint) => { bmp(h).immutable = true; },
  "nativeHasMipMap(J)Z": (h: bigint) => (bmp(h).mipmap ? 1 : 0),
  "nativeSetHasMipMap(JZ)V": (h: bigint, v: number) => { bmp(h).mipmap = !!v; },

  // one colour space, and it is sRGB: there is no colour management behind a 2D context
  "nativeIsSRGB(J)Z": () => 1,
  "nativeIsSRGBLinear(J)Z": () => 0,
  "nativeSetColorSpace(JJ)V": () => {},
  "nativeComputeColorSpace(J)Landroid/graphics/ColorSpace;": () => null,
  // a device's shared-memory and HDR allocators, and the gainmap that rides on one: absent
  // here, and a caller discovers that the way it would on a device without them
  "nativeGetAshmemFD(J)I": () => -1,
  "nativeIsBackedByAshmem(J)Z": () => 0,
  "nativeHasGainmap(J)Z": () => 0,
  "nativeExtractGainmap(J)Landroid/graphics/Gainmap;": () => null,
  "nativeSetGainmap(JJ)V": () => {},
  "nativeGetHardwareBuffer(J)Landroid/hardware/HardwareBuffer;": () => null,
  "nativeWrapHardwareBufferBitmap(Landroid/hardware/HardwareBuffer;J)Landroid/graphics/Bitmap;": () => null,
});

// ── android.content.res.StringBlock / XmlBlock ─────────────────────────────────────────
// The layout-inflation path. AOSP's XmlBlock is a pull parser over the binary XML bytes whose
// accessors return STRING-POOL INDICES, not strings: the Java half resolves each one through
// the block's own StringBlock. So the pool has to be the real one out of these bytes — an
// interned copy would hand out indices into a pool the caller does not read.
//
// What the framework reads back out of an index is fixed by XmlBlock$Parser's own bytecode:
// -1 is null for a name or a text, "" for a namespace, and getStyleAttribute is a resource
// id rather than an index. A malformed document is ERROR_BAD_DOCUMENT (-EINVAL); we throw
// while parsing instead, so nothing here ever returns it.

interface Block { doc: XmlDoc; res: Resources | null; strings: bigint }

/** the parse cursor. It IS an AttributeSet — AOSP passes XmlBlock.Parser.mParseState straight
 *  to applyStyle/retrieveAttributes, and res.ts's obtainStyled reads the element off `node`. */
class ParseState extends JAttrSet {
  pos = 0;
  constructor(readonly blk: Block, readonly sourceResId: number) {
    super();
    this.res = blk.res as Resources;
    this.node = null;
  }
  get ev(): XmlEvent { return this.blk.doc.events[this.pos]; }
}

const block = (h: bigint) => deref<Block>(h);
const state = (h: bigint) => deref<ParseState>(h);
const mkBlock = (bytes: Uint8Array, res: Resources | null): Block =>
  ({ doc: parseAXMLDoc(bytes, true), res, strings: 0n });
/** the attribute the element named as its id/class/style, or -1 when it declared none */
const namedAttr = (st: ParseState, which: "idIdx" | "classIdx" | "styleIdx") => st.ev[which];

delegate("android/content/res/StringBlock", {
  "nativeCreate([BII)J": (b: Int8Array, off: number, len: number) =>
    handle(new StringPool(new DataView(b.buffer, b.byteOffset + off, len), 0)),
  "nativeDestroy(J)V": release,
  "nativeGetSize(J)I": (h: bigint) => deref<StringPool>(h).strings.length,
  "nativeGetString(JI)Ljava/lang/String;": (h: bigint, i: number) => deref<StringPool>(h).strings[i] ?? null,
  "nativeGetStyle(JI)[I": (h: bigint, i: number) => deref<StringPool>(h).styleOf(i),
});

delegate("android/content/res/XmlBlock", {
  "nativeCreate([BII)J": (b: Int8Array, off: number, len: number) =>
    handle(mkBlock(new Uint8Array(b.buffer, b.byteOffset + off, len), currentResources())),
  "nativeDestroy(J)V": release,
  "nativeGetStringBlock(J)J": (h: bigint) => {
    const b = block(h);
    return b.strings || (b.strings = handle(b.doc.pool));
  },
  "nativeCreateParseState(JI)J": (h: bigint, sourceResId: number) => handle(new ParseState(block(h), sourceResId)),
  "nativeDestroyParseState(J)V": release,
  "nativeGetSourceResId(J)I": (h: bigint) => state(h).sourceResId,

  // the cursor starts on START_DOCUMENT, which XmlBlock$Parser reports itself before it ever
  // calls in; every next() from there returns the following event
  "nativeNext(J)I": (h: bigint) => {
    const st = state(h);
    if (st.pos < st.blk.doc.events.length - 1) st.pos++;
    st.node = st.ev.node;
    return st.ev.type;
  },
  "nativeGetName(J)I": (h: bigint) => (state(h).ev.type === XE.START_TAG || state(h).ev.type === XE.END_TAG ? state(h).ev.nameIdx : -1),
  "nativeGetNamespace(J)I": (h: bigint) => state(h).ev.nsIdx,
  "nativeGetText(J)I": (h: bigint) => (state(h).ev.type === XE.TEXT ? state(h).ev.nameIdx : -1),
  "nativeGetLineNumber(J)I": (h: bigint) => state(h).ev.line,

  "nativeGetAttributeCount(J)I": (h: bigint) => (state(h).ev.raw?.length ?? 0) / 3,
  "nativeGetAttributeNamespace(JI)I": (h: bigint, i: number) => state(h).ev.raw?.[i * 3] ?? -1,
  "nativeGetAttributeName(JI)I": (h: bigint, i: number) => state(h).ev.raw?.[i * 3 + 1] ?? -1,
  "nativeGetAttributeStringValue(JI)I": (h: bigint, i: number) => state(h).ev.raw?.[i * 3 + 2] ?? -1,
  "nativeGetAttributeResource(JI)I": (h: bigint, i: number) => state(h).ev.node?.attrs[i]?.resId ?? 0,
  "nativeGetAttributeDataType(JI)I": (h: bigint, i: number) => state(h).ev.node?.attrs[i]?.type ?? TV.NULL,
  "nativeGetAttributeData(JI)I": (h: bigint, i: number) => state(h).ev.node?.attrs[i]?.data ?? 0,
  "nativeGetAttributeIndex(JLjava/lang/String;Ljava/lang/String;)I": (h: bigint, ns: string | null, name: string) => {
    const attrs = state(h).ev.node?.attrs;
    if (attrs) for (let i = 0; i < attrs.length; i++) if (attrs[i].name === name && (ns == null || attrs[i].ns === ns)) return i;
    return -1;
  },
  // id and class are the raw string value of the attribute the element pointed at; style is
  // its resource id, and 0 unless it is one
  "nativeGetIdAttribute(J)I": (h: bigint) => { const i = namedAttr(state(h), "idIdx"); return i < 0 ? -1 : state(h).ev.raw![i * 3 + 2]; },
  "nativeGetClassAttribute(J)I": (h: bigint) => { const i = namedAttr(state(h), "classIdx"); return i < 0 ? -1 : state(h).ev.raw![i * 3 + 2]; },
  "nativeGetStyleAttribute(J)I": (h: bigint) => {
    const st = state(h);
    const a = st.ev.node?.attrs[namedAttr(st, "styleIdx")];
    return a && (a.type === TV.REFERENCE || a.type === TV.ATTRIBUTE) ? a.data : 0;
  },
});

// ── android.content.res.AssetManager ───────────────────────────────────────────────────
// B3. The handle is a Resources — the same object our own resource stack reads through, so
// AOSP's Resources/TypedArray/Theme bytecode and ours answer off one arsc.ts.
//
// AOSP's TypedArray is a flat int[]: STYLE_NUM_ENTRIES ints per attribute, in the order
// (type, data, assetCookie, resourceId, changingConfigurations, density, sourceResourceId).
// applyStyle fills it, and every getX() on the Java side reads back out of it, so getting
// the stride or the order wrong is not a visible error — it is silently the wrong attribute.
const STYLE_NUM_ENTRIES = 7;
const assets = (h: bigint) => deref<Resources>(h);

/** one attribute's slot in AOSP's TypedArray layout */
function writeSlot(out: Int32Array, i: number, v: RV | null, srcId: number) {
  const at = i * STYLE_NUM_ENTRIES;
  out.fill(0, at, at + STYLE_NUM_ENTRIES);
  if (!v || v.t === TV.NULL) return;
  out[at] = v.t === T_STR ? TV.STRING : v.t === T_PX ? TV.DIMENSION : v.t;
  // FLOAT is carried decoded here and as bits on the Java side
  out[at + 1] = v.t === TV.FLOAT ? floatToIntBits(v.d) : v.d | 0;
  out[at + 3] = srcId;
  out[at + 5] = device.densityDpi;
}

delegate("android/content/res/AssetManager", {
  "nativeCreate()J": () => handle(currentResources() ?? new Resources(null, {})),
  "nativeDestroy(J)V": () => {},
  "nativeSetApkAssets(J[Landroid/content/res/ApkAssets;ZZ)V": () => {},
  "nativeSetConfiguration(JIILjava/lang/String;[Ljava/lang/String;IIIIIIIIIIIIIIIIZ)V": () => {},
  "nativeSetResourceResolutionLoggingEnabled(JZ)V": () => {},
  "nativeGetLastResourceResolution(J)Ljava/lang/String;": () => "",
  "nativeContainsAllocatedTable(J)Z": () => 0,
  "getGlobalAssetCount()I": () => 0,
  "getGlobalAssetManagerCount()I": () => 1,
  "getAssetAllocations()Ljava/lang/String;": () => "",

  // resource reads: every one of these is a lookup arsc.ts already answers
  "nativeGetResourceValue(JISLandroid/util/TypedValue;Z)I": (h: bigint, id: number, _dens: number, tv: TypedValueLike, resolve: number) => {
    const res = assets(h);
    const v = resolve ? res.ref(id) : res.value(id);
    return fillTypedValue(res, tv, v, id);
  },
  "nativeGetResourceIdentifier(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I": (h: bigint, name: string, type: string, pkg: string) =>
    assets(h).idFor(type ?? "", name ?? "", pkg ?? ""),
  "nativeGetResourceName(JI)Ljava/lang/String;": (h: bigint, id: number) => {
    const r = assets(h);
    const t = r.idType(id), n = r.idName(id);
    return t && n ? `${pkgOf(r, id)}:${t}/${n}` : null;
  },
  "nativeGetResourceEntryName(JI)Ljava/lang/String;": (h: bigint, id: number) => assets(h).idName(id) || null,
  "nativeGetResourceTypeName(JI)Ljava/lang/String;": (h: bigint, id: number) => assets(h).idType(id) || null,
  "nativeGetResourcePackageName(JI)Ljava/lang/String;": (h: bigint, id: number) => pkgOf(assets(h), id),
  "nativeGetResourceArraySize(JI)I": (h: bigint, id: number) => assets(h).bag(id)?.map.size ?? -1,
  "nativeGetResourceArray(JI[I)I": (h: bigint, id: number, out: Int32Array) => {
    const res = assets(h);
    const bag = res.bag(id);
    if (!bag) return -1;
    [...bag.map].forEach(([key, v], i) => writeSlot(out, i, res.resolveRefs(v), key));
    return bag.map.size;
  },
  "nativeGetResourceIntArray(JI)[I": (h: bigint, id: number) => {
    const res = assets(h);
    const bag = res.bag(id);
    return bag ? Int32Array.from(bag.map.values(), (v) => res.resolveRefs(v).d | 0) : null;
  },
  "nativeGetResourceStringArray(JI)[Ljava/lang/String;": (h: bigint, id: number) => {
    const res = assets(h);
    const bag = res.bag(id);
    if (!bag) return null;
    return jarray([...bag.map.values()].map((v) => rvString(res, res.resolveRefs(v))), "Ljava/lang/String;");
  },
  "nativeGetResourceStringArrayInfo(JI)[I": (h: bigint, id: number) => {
    const bag = assets(h).bag(id);
    // (cookie, index) per entry; nothing here reads a string pool by index
    return bag ? new Int32Array(bag.map.size * 2).fill(-1) : null;
  },
  "nativeGetResourceBagValue(JIILandroid/util/TypedValue;)I": (h: bigint, id: number, attrId: number, tv: TypedValueLike) => {
    const res = assets(h);
    const v = res.styleLookup(id, attrId);
    return fillTypedValue(res, tv, v && res.resolveRefs(v), id);
  },
  "nativeGetStyleAttributes(JI)[I": (h: bigint, id: number) => {
    const bag = assets(h).bag(id);
    return bag ? Int32Array.from(bag.map.keys()) : null;
  },

  // themes: a JTheme is the stack of styles applied to it, which is what AOSP's is too
  "nativeThemeCreate(J)J": (h: bigint) => {
    const t = new JTheme();
    t.res = assets(h);
    return handle(t);
  },
  "nativeGetThemeFreeFunction()J": () => FINALIZER,
  "nativeThemeApplyStyle(JJIZ)V": (_h: bigint, th: bigint, styleId: number) => deref<JTheme>(th).apply(styleId),
  "nativeThemeCopy(JJJJ)V": (_a: bigint, dst: bigint, _b: bigint, src: bigint) => {
    const d = deref<JTheme>(dst), s = deref<JTheme>(src);
    d.res = s.res; d.styles = s.styles.slice(); d.cache.clear();
  },
  "nativeThemeRebase(JJ[I[ZI)V": (h: bigint, th: bigint, styleIds: Int32Array, _force: Uint8Array, n: number) => {
    const t = deref<JTheme>(th);
    t.res = assets(h); t.styles = []; t.cache.clear();
    for (let i = 0; i < n; i++) t.apply(styleIds[i]);
  },
  "nativeThemeGetAttributeValue(JJILandroid/util/TypedValue;Z)I": (h: bigint, th: bigint, attrId: number, tv: TypedValueLike, resolve: number) => {
    const res = assets(h);
    const t = deref<JTheme>(th);
    const v = t.lookup(attrId);
    return fillTypedValue(res, tv, resolve ? resolveStyleValue(res, t, v) : v, attrId);
  },
  "nativeThemeGetChangingConfigurations(J)I": () => 0,
  "nativeThemeDump(JJILjava/lang/String;Ljava/lang/String;)V": () => {},
  "nativeGetParentThemeIdentifier(JI)I": (h: bigint, id: number) => assets(h).bag(id)?.parent ?? 0,

  // obtainStyledAttributes, which is what every widget constructor is really doing
  "nativeApplyStyle(JJIIJ[IJJ)V": (h: bigint, th: bigint, defStyleAttr: number, defStyleRes: number, xml: bigint, attrIds: Int32Array, outValues: bigint, outIndices: bigint) => {
    const res = assets(h);
    const ta = obtainStyled(res, th ? deref<JTheme>(th) : null, xml ? deref<JAttrSet>(xml) : null, attrIds, defStyleAttr, defStyleRes);
    fillStyleArrays(res, ta, attrIds, deref<Int32Array>(outValues), deref<Int32Array>(outIndices));
  },
  "nativeResolveAttrs(JJII[I[I[I[I)Z": (h: bigint, th: bigint, defStyleAttr: number, defStyleRes: number, _values: Int32Array, attrIds: Int32Array, outValues: Int32Array, outIndices: Int32Array) => {
    const res = assets(h);
    const ta = obtainStyled(res, th ? deref<JTheme>(th) : null, null, attrIds, defStyleAttr, defStyleRes);
    fillStyleArrays(res, ta, attrIds, outValues, outIndices);
    return 1;
  },
  "nativeRetrieveAttributes(JJ[I[I[I)Z": (h: bigint, xml: bigint, attrIds: Int32Array, outValues: Int32Array, outIndices: Int32Array) => {
    const res = assets(h);
    const ta = obtainStyled(res, null, xml ? deref<JAttrSet>(xml) : null, attrIds, 0, 0);
    fillStyleArrays(res, ta, attrIds, outValues, outIndices);
    return 1;
  },
  "nativeAttributeResolutionStack(JJIII)[I": () => new Int32Array(0),

  // asset streams: an apk's assets/ and its res/ files are entries in the zip we already hold
  "nativeOpenAsset(JLjava/lang/String;I)J": (h: bigint, path: string) => openAsset(assets(h), "assets/" + path),
  "nativeOpenNonAsset(JILjava/lang/String;I)J": (h: bigint, cookie: number, path: string) => openAsset(assets(h), path, cookie),

  // the layout-inflation entry point: Resources.getLayout ends here, and the block it returns
  // is what LayoutInflater pulls tags out of
  "nativeOpenXmlAsset(JILjava/lang/String;)J": (h: bigint, cookie: number, path: string) => {
    const res = assets(h);
    const bytes = readEntry(res, cookie, path);
    if (!bytes) throw rt.mkThrowable("java/io/FileNotFoundException", path);
    return handle(mkBlock(bytes, res));
  },
  // there are no file descriptors here: an asset is a zip entry, and the path form above is
  // the one the framework takes for everything it opens by name
  "nativeOpenXmlAssetFd(JILjava/io/FileDescriptor;)J": () => { throw rt.mkThrowable("java/io/FileNotFoundException", "no file descriptors"); },
  "nativeAssetDestroy(J)V": release,
  "nativeAssetGetLength(J)J": (a: bigint) => BigInt(deref<Cursor>(a).source.size),
  "nativeAssetGetRemainingLength(J)J": (a: bigint) => { const c = deref<Cursor>(a); return BigInt(c.source.size - c.pos); },
  "nativeAssetReadChar(J)I": async (a: bigint) => {
    const c = deref<Cursor>(a);
    const bytes = await c.source.read(c.pos, 1);
    if (!bytes.length) return -1;
    c.pos++;
    return bytes[0];
  },
  "nativeAssetRead(J[BII)I": async (a: bigint, out: Int8Array, off: number, len: number) => {
    const c = deref<Cursor>(a);
    if (!len) return 0;
    const bytes = await c.source.read(c.pos, len);
    if (!bytes.length) return -1;
    out.set(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length), off);
    c.pos += bytes.length;
    return bytes.length;
  },
  "nativeAssetSeek(JJI)J": (a: bigint, off: bigint, whence: number) => {
    const c = deref<Cursor>(a);
    const base = whence === 0 ? 0 : whence === 1 ? c.pos : c.source.size;
    c.pos = Math.max(0, Math.min(c.source.size, base + Number(off)));
    return BigInt(c.pos);
  },
  "nativeList(JLjava/lang/String;)[Ljava/lang/String;": (h: bigint, path: string) => {
    const dir = "assets/" + (path ? path + "/" : "");
    const names = new Set<string>();
    for (const k of Object.keys(assets(h).zip)) {
      if (k.startsWith(dir) && k.length > dir.length) names.add(k.slice(dir.length).split("/")[0]);
    }
    for (const k of assets(h).lazyEntries.keys()) {
      if (k.startsWith(dir) && k.length > dir.length) names.add(k.slice(dir.length).split("/")[0]);
    }
    return jarray([...names].sort(), "Ljava/lang/String;");
  },
  // a file descriptor is a host concept there is nothing behind here; callers fall back to
  // the stream forms above when these return null
  "nativeOpenAssetFd(JLjava/lang/String;[J)Landroid/os/ParcelFileDescriptor;": () => null,
  "nativeOpenNonAssetFd(JILjava/lang/String;[J)Landroid/os/ParcelFileDescriptor;": () => null,

  // the overlay/locale queries: no apk here is an overlay, and one device profile means one
  // locale and one configuration
  "nativeGetLocales(JZ)[Ljava/lang/String;": () => jarray([device.lang], "Ljava/lang/String;"),
  "nativeGetSizeConfigurations(J)[Landroid/content/res/Configuration;": () => null,
  "nativeGetSizeAndUiModeConfigurations(J)[Landroid/content/res/Configuration;": () => null,
  "nativeGetOverlayableMap(JLjava/lang/String;)Ljava/util/Map;": () => null,
  "nativeGetOverlayablesToString(JLjava/lang/String;)Ljava/lang/String;": () => null,
  "nativeGetAssignedPackageIdentifiers(JZZ)Landroid/util/SparseArray;": () => null,
});

interface Cursor { source: FileSource; pos: number }

// A cookie is a 1-based index into the AssetManager's ordered ApkAssets. A device loads the
// framework package first and the app last, and a path alone cannot say which apk it came
// from — res/layout/alert_dialog.xml exists in both. Cookie 0 is AOSP's "any".
const COOKIE_FW = 1, COOKIE_APP = 2;
const cookieOf = (resId: number) => (resId >>> 24 === 0x01 ? COOKIE_FW : COOKIE_APP);

/** an archive entry, out of the apk the cookie names */
function readEntry(res: Resources, cookie: number, path: string): Uint8Array | null {
  const fw = () => res.tbl(0x01000000)?.files(path) ?? null;
  const app = () => res.zip[path] ?? res.arsc?.files(path) ?? null;
  return cookie === COOKIE_FW ? fw() : cookie === COOKIE_APP ? app() : app() ?? fw();
}

/** an asset stream over a zip entry; 0 is what AOSP returns for "no such asset" */
function openAsset(res: Resources, path: string, cookie = 0): bigint {
  const bytes = readEntry(res, cookie, path);
  const source = bytes ? new BytesFile(bytes) : cookie === COOKIE_FW ? null : res.lazyEntries.get(path);
  return source ? handle({ source, pos: 0 } as Cursor) : 0n;
}

interface TypedValueLike { type: number; data: number; resourceId: number; density: number; string: unknown; assetCookie: number; changingConfigurations: number }

/** an RV into the TypedValue the caller passed, returning the block index AOSP returns */
function fillTypedValue(res: Resources, tv: TypedValueLike, v: RV | null, srcId: number): number {
  if (!v || v.t === TV.NULL) { tv.type = TV.NULL; tv.data = 0; return -1; }
  // On a device a file-backed resource IS a TYPE_STRING: aapt writes the archive path into
  // the package's value pool, and getLayout/loadDrawable read value.string. resolveRefs keeps
  // those as references because our own stack loads them by id, so the translation belongs
  // here, at the boundary — without it Resources.getLayout throws NotFoundException.
  if (v.t === TV.REFERENCE && v.d) {
    const f = res.pathOf(v.d);
    if (f) {
      tv.type = TV.STRING; tv.data = 0; tv.string = f.path;
      tv.resourceId = f.id; tv.density = device.densityDpi;
      tv.assetCookie = cookieOf(f.id); tv.changingConfigurations = 0;
      return 0;
    }
  }
  tv.type = v.t === T_STR ? TV.STRING : v.t === T_PX ? TV.DIMENSION : v.t;
  tv.data = v.t === TV.FLOAT ? floatToIntBits(v.d) : v.d | 0;
  tv.resourceId = srcId;
  tv.density = device.densityDpi;
  tv.assetCookie = cookieOf(srcId);
  tv.changingConfigurations = 0;
  tv.string = v.t === TV.STRING || v.t === T_STR ? rvString(res, v) : null;
  return 0;
}

/** the package a resource id belongs to: 0x01 is always the framework */
const pkgOf = (r: Resources, id: number) => (id >>> 24 === 0x01 ? "android" : r.arsc?.pkgName ?? "");

function fillStyleArrays(res: Resources, ta: JTypedArray, attrIds: ArrayLike<number>, outValues: Int32Array, outIndices: Int32Array | undefined) {
  let found = 0;
  for (let i = 0; i < attrIds.length; i++) {
    const v = resolveStyleValue(res, ta.theme, ta.vals[i] ?? null);
    writeSlot(outValues, i, v, attrIds[i]);
    // outIndices[0] is the count and the rest are the 1-based positions that were set
    if (v && v.t !== TV.NULL && outIndices) outIndices[++found] = i;
  }
  if (outIndices) outIndices[0] = found;
}
