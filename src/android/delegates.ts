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

import { rt, JObj, stubs, noops, declaredField } from "../jvm/runtime";
import { handle, weakHandle, ownedHandle, deref, replace, release, FINALIZER } from "./handles";
import {
  JPaint,
  fontAscent, fontDescent, fillFontMetrics, copyPaint, argbOfColorLong,
  type JRectF, CAPS, JOINS,
  type Mat, Camera3D, IDENTITY, identity, mul, translateM, scaleM, skewM, sinCosM, rotateM, about, invert, mapPoint, isIdentity, applyMatrix,
  NativeColorFilter, BLEND_MODES, type NativeShader, NativeBitmapShader, localMatrix, gradient, composeShader, measureCtx,
  type NinePatchChunk, isNinePatchChunk, validNinePatchChunk, transparentPatches,
} from "./graphics";
import { RuntimeShaderBuilder } from "./runtime-shader";
import { NativeCanvas } from "./canvas";
import { glyphBounds } from "./shaping";
import { NativeBitmap } from "./bitmap";
import { newObj, vcall, scall, after } from "../jvm/natives/jlang";
import { asZygote } from "./os";
import { lambda } from "../jvm/natives/jlambda";
import { charsToString } from "../jvm/abi";
import { NativePath, PathMeasure, VerbIterator, approximate, pathIsConvex, pathOp } from "./path";
import { NativeRegion, nativeRegionOf } from "./region";
import { recordingContext, replay, replayWithSemantics, retarget, type DisplayList } from "./recording";
import { device } from "../shell/config";
import { type JBuffer, resident, readOnlyBuffer, addressOf, isExternal, bufferBytes } from "../jvm/natives/jnio";
import {
  type Axis, NativeFont, NativeFamily, NativeTypeface, mkFamily, systemFonts, sfntTables, T_CMAP,
  fontRevision, postScriptName, isPostScriptType1, typefaceOf, setDefaultTypeface, loadSystemFontMap,
  createRelative, createAbsolute, createWithBaseWeight, createWithVariation, createFromFamilies, fontOf, wrapFont,
} from "./fonts";

const delegate = rt.registerJnis.bind(rt);


// ── the libcore plumbing framework bytecode stands on ──────────────────────────────────
// Not native methods but classes, and only reachable when AOSP bytecode runs: every graphics
// class hands its finalizer to NativeAllocationRegistry from a <clinit>, so without it the
// class fails to initialize before any of the work below is reached.
class JFreeRunnable extends JObj { free = () => {}; }
rt.register({
  name: "webdroid/FreeRunnable", ctor: JFreeRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: JFreeRunnable) { this.free(); } },
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
rt.markers("android/compat/Compatibility$BehaviorChangeDelegate");

/** a class's free function, which runs on each native allocation once its Java owner is
 *  collected, or at once when the returned Runnable runs, as libcore's Cleaner does */
class JNativeAllocationRegistry extends JObj { free = 0n; }
const freeNative = (fn: bigint, ptr: bigint) => { deref<(p: bigint) => void>(fn)?.(ptr); };
const collected = new FinalizationRegistry<{ fn: bigint; ptr: bigint }>(({ fn, ptr }) => freeNative(fn, ptr));
const mkRegistry = (_loader: unknown, free: bigint) => Object.assign(new JNativeAllocationRegistry(), { free });
rt.register({
  name: "libcore/util/NativeAllocationRegistry", ctor: JNativeAllocationRegistry,
  methods: {
    "<init>(Ljava/lang/ClassLoader;JJ)V": function (this: JNativeAllocationRegistry, _loader: unknown, free: bigint) { this.free = free; },
    "static createMalloced(Ljava/lang/ClassLoader;J)Llibcore/util/NativeAllocationRegistry;": mkRegistry,
    "static createMalloced(Ljava/lang/ClassLoader;JJ)Llibcore/util/NativeAllocationRegistry;": mkRegistry,
    "static createNonmalloced(Ljava/lang/ClassLoader;JJ)Llibcore/util/NativeAllocationRegistry;": mkRegistry,
    "registerNativeAllocation(Ljava/lang/Object;J)Ljava/lang/Runnable;": function (this: JNativeAllocationRegistry, referent: object | null, ptr: bigint) {
      if (!referent) rt.npe();
      const fn = this.free, token = {};
      collected.register(referent!, { fn, ptr }, token);
      const run = rt.make("webdroid/FreeRunnable") as JFreeRunnable;
      run.free = () => { if (collected.unregister(token)) freeNative(fn, ptr); };
      return run;
    },
    "static applyFreeFunction(JJ)V": freeNative,
  },
});

interface Rect { left: number; top: number; right: number; bottom: number }

// Skia's SkRGBToHSV and SkHSVToColor, in float as Skia computes them
const f = Math.fround, round = (x: number) => Math.floor(x + 0.5);
delegate("android/graphics/Color", {
  "nativeRGBToHSV(III[F)V": (r: number, g: number, b: number, hsv: Float32Array) => {
    const max = Math.max(r, g, b), delta = max - Math.min(r, g, b);
    let h = 0, s = 0;
    if (delta) {
      s = f(delta / max);
      h = f(r === max ? (g - b) / delta : g === max ? 2 + f((b - r) / delta) : 4 + f((r - g) / delta));
      h = f(h * 60);
      if (h < 0) h = f(h + 360);
    }
    hsv[0] = h; hsv[1] = s; hsv[2] = f(max / 255);
  },
  "nativeHSVToColor(I[F)I": (a: number, hsv: Float32Array) => {
    const s = Math.min(Math.max(hsv[1], 0), 1), v = Math.min(Math.max(hsv[2], 0), 1), vb = round(f(v * 255));
    if (Math.abs(s) <= 1 / 4096) return (a << 24 | vb << 16 | vb << 8 | vb) | 0;
    const hx = hsv[0] < 0 || hsv[0] >= 360 ? 0 : f(hsv[0] / 60), w = Math.floor(hx), fr = f(hx - w);
    const p = round(f(f(f(1 - s) * v) * 255)), q = round(f(f(f(1 - f(s * fr)) * v) * 255)), t = round(f(f(f(1 - f(s * f(1 - fr))) * v) * 255));
    const [r, g, b] = [[vb, t, p], [q, vb, p], [p, vb, t], [p, q, vb], [t, p, vb]][w] ?? [vb, p, q];
    return (a << 24 | r << 16 | g << 8 | b) | 0;
  },
});

// skcms' transfer function (g, a, b, c, d, e, f) and a D50 XYZ matrix; the 2D context draws in sRGB
delegate("android/graphics/ColorSpace$Rgb$Native", {
  "nativeCreate(FFFFFFF[F)J": (...args: [...number[], Float32Array]) => handle({ transfer: args.slice(0, 7), xyz: Float32Array.from(args[7] as Float32Array) }),
  "nativeGetNativeFinalizer()J": () => FINALIZER,
});

// ── android.graphics.Matrix ────────────────────────────────────────────────────────────
// The 3x3 and its math live in graphics.ts, beside the bridge TS reaches it through. Every write
// lands in the handle's own array, because TS state (an ImageView's matrix, a Transformation's)
// can be the array behind a Java Matrix.
const matrix = (h: bigint) => deref<Mat>(h);
const put = (h: bigint, m: ArrayLike<number>) => { matrix(h).set(m); };

/** pre/post/set are the same three compositions for every transform AOSP names; Translate has
 *  no pivoted form and SinCos only the set ones */
function matrixOps(name: string, make: (...a: number[]) => Mat, arity: number, pivot = true, compose = true): Record<string, unknown> {
  const plain = `(J${"F".repeat(arity)})V`;
  const pivoted = `(J${"F".repeat(arity + 2)})V`;
  const at = (a: number[]) => (a.length > arity ? about(make(...a.slice(0, arity)), a[arity], a[arity + 1]) : make(...a));
  const set = (h: bigint, ...a: number[]) => put(h, at(a));
  const pre = (h: bigint, ...a: number[]) => put(h, mul(matrix(h), at(a)));
  const post = (h: bigint, ...a: number[]) => put(h, mul(at(a), matrix(h)));
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

delegate("android/graphics/Matrix$ExtraNatives", {
  "nCreate(J)J": (src: bigint) => handle(src ? Float64Array.from(matrix(src)) : identity()),
  "nGetNativeFinalizer()J": () => FINALIZER,
});
delegate("android/graphics/Matrix", {
  ...matrixOps("Translate", translateM, 2, false),
  ...matrixOps("Scale", scaleM, 2),
  ...matrixOps("Skew", skewM, 2),
  ...matrixOps("Rotate", rotateM, 1),
  ...matrixOps("SinCos", sinCosM, 2, true, false),
  "nReset(J)V": (h: bigint) => put(h, IDENTITY),
  "nSet(JJ)V": (h: bigint, s: bigint) => put(h, s ? matrix(s) : IDENTITY),
  "nSetConcat(JJJ)V": (h: bigint, a: bigint, b: bigint) => put(h, mul(matrix(a), matrix(b))),
  "nPreConcat(JJ)V": (h: bigint, o: bigint) => put(h, mul(matrix(h), matrix(o))),
  "nPostConcat(JJ)V": (h: bigint, o: bigint) => put(h, mul(matrix(o), matrix(h))),
  "nIsIdentity(J)Z": (h: bigint) => +isIdentity(matrix(h)),
  "nIsAffine(J)Z": (h: bigint) => +!hasPerspective(matrix(h)),
  "nRectStaysRect(J)Z": (h: bigint) => +rectStaysRect(matrix(h)),
  "nEquals(JJ)Z": (a: bigint, b: bigint) => { const m = matrix(a), o = matrix(b); return +m.every((v, i) => v === o[i]); },
  "nGetValues(J[F)V": (h: bigint, out: Float32Array) => out.set(matrix(h)),
  "nSetValues(J[F)V": (h: bigint, v: Float32Array) => put(h, v.subarray(0, 9)),
  "nInvert(JJ)Z": (h: bigint, into: bigint) => {
    const inv = invert(matrix(h));
    if (inv) put(into, inv);
    return +!!inv;
  },
  "nMapPoints(J[FI[FIIZ)V": (h: bigint, dst: Float32Array, di: number, src: Float32Array, si: number, n: number, isPts: number) => {
    const m = matrix(h), map = isPts ? mapPoint : mapVector;
    if (src === dst && si !== di) src = src.slice(si, si + n * 2), si = 0;
    for (let i = 0; i < n * 2; i += 2) {
      const [x, y] = map(m, src[si + i], src[si + i + 1]);
      dst[di + i] = x; dst[di + i + 1] = y;
    }
  },
  "nMapRect(JLandroid/graphics/RectF;Landroid/graphics/RectF;)Z": (h: bigint, dst: Rect, src: Rect) => {
    const m = matrix(h);
    const [x0, y0] = mapPoint(m, src.left, src.top), [x1, y1] = mapPoint(m, src.right, src.top);
    const [x2, y2] = mapPoint(m, src.right, src.bottom), [x3, y3] = mapPoint(m, src.left, src.bottom);
    dst.left = Math.min(x0, x1, x2, x3); dst.right = Math.max(x0, x1, x2, x3);
    dst.top = Math.min(y0, y1, y2, y3); dst.bottom = Math.max(y0, y1, y2, y3);
    return +rectStaysRect(m);
  },
  // SkMatrix::setRectToRect: an empty source resets and fails, an empty destination scales to 0
  "nSetRectToRect(JLandroid/graphics/RectF;Landroid/graphics/RectF;I)Z": (h: bigint, src: Rect, dst: Rect, stf: number) => {
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
    const m = matrix(h), [ax, ay] = mapVector(m, r, 0), [bx, by] = mapVector(m, 0, r);
    return Math.fround(Math.sqrt(Math.hypot(ax, ay) * Math.hypot(bx, by)));
  },
});

// ── ColorFilter and Shader: the native instances the TS Paint draws with ──────────────────────
// Lighting and ColorMatrix filters change theirs in place; a shader's is fixed, and Shader makes
// a new one when its Java side changes. `m` is the local matrix's handle, 0 for identity.
const colorFilter = (h: bigint) => deref<NativeColorFilter>(h);
const blendFilter = (color: number, mode: number) => handle(new NativeColorFilter(null, color, BLEND_MODES[mode]));
/** SkColorFilters::Lighting: each RGB channel scaled by `mul`'s and offset by `add`'s */
const setMul = (k: Float32Array, mul: number) => { k[0] = (mul >>> 16 & 255) / 255; k[6] = (mul >>> 8 & 255) / 255; k[12] = (mul & 255) / 255; };
const setAdd = (k: Float32Array, add: number) => { k[4] = add >>> 16 & 255; k[9] = add >>> 8 & 255; k[14] = add & 255; };
delegate("android/graphics/ColorFilter", { "nativeGetFinalizer()J": () => FINALIZER });
delegate("android/graphics/PorterDuffColorFilter", { "native_CreateBlendModeFilter(II)J": blendFilter });
delegate("android/graphics/BlendModeColorFilter", { "native_CreateBlendModeFilter(II)J": blendFilter });
delegate("android/graphics/LightingColorFilter", {
  "native_CreateLightingFilter(II)J": (mul: number, add: number) => {
    const k = new Float32Array(20);
    k[18] = 1; setMul(k, mul); setAdd(k, add);
    return handle(new NativeColorFilter(k));
  },
  "native_SetLightingFilterMul(JI)V": (h: bigint, mul: number) => setMul(colorFilter(h).matrix!, mul),
  "native_SetLightingFilterAdd(JI)V": (h: bigint, add: number) => setAdd(colorFilter(h).matrix!, add),
});
delegate("android/graphics/ColorMatrixColorFilter", {
  "nativeColorMatrixFilter([F)J": (k: Float32Array) => handle(new NativeColorFilter(k.slice(0, 20))),
  "nativeSetColorMatrix(J[F)V": (h: bigint, k: Float32Array) => colorFilter(h).matrix!.set(k.subarray(0, 20)),
});

// Gradients clamp: Canvas2D has no REPEAT, MIRROR or DECAL gradient, so the tile mode is not used.
delegate("android/graphics/Shader", { "nativeGetFinalizer()J": () => FINALIZER });
delegate("android/graphics/LinearGradient", {
  "nativeCreate(JFFFF[J[FIJ)J": (m: bigint, x0: number, y0: number, x1: number, y1: number, colors: BigInt64Array, positions: Float32Array | null) =>
    handle(gradient(localMatrix(m), measureCtx().createLinearGradient(x0, y0, x1, y1), colors, positions)),
});
delegate("android/graphics/RadialGradient", {
  "nativeCreate(JFFFFFF[J[FIJ)J": (m: bigint, fx: number, fy: number, fr: number, x: number, y: number, r: number, colors: BigInt64Array, positions: Float32Array | null) =>
    handle(gradient(localMatrix(m), measureCtx().createRadialGradient(fx, fy, fr, x, y, r), colors, positions)),
});
delegate("android/graphics/SweepGradient", {
  "nativeCreate(JFF[J[FJ)J": (m: bigint, cx: number, cy: number, colors: BigInt64Array, positions: Float32Array | null) =>
    handle(gradient(localMatrix(m), measureCtx().createConicGradient(0, cx, cy), colors, positions)),
});
delegate("android/graphics/BitmapShader", {
  "nativeCreate(JJIIIZZJ)J": (m: bigint, b: bigint, tileX: number, tileY: number) =>
    handle(new NativeBitmapShader(localMatrix(m), deref<NativeBitmap>(b), tileX, tileY)),
});
delegate("android/graphics/ComposeShader", {
  "nativeCreate(JJJI)J": (m: bigint, dst: bigint, src: bigint, mode: number) =>
    handle(composeShader(localMatrix(m), deref<NativeShader>(dst), deref<NativeShader>(src), mode)),
});
const shaderBuilder = (h: bigint) => deref<RuntimeShaderBuilder>(h);
delegate("android/graphics/RuntimeShader", {
  "nativeGetFinalizer()J": () => FINALIZER,
  "nativeCreateBuilder(Ljava/lang/String;)J": (source: string) => handle(new RuntimeShaderBuilder(source)),
  "nativeCreateShader(JJ)J": (b: bigint, m: bigint) => handle(shaderBuilder(b).shader(localMatrix(m))),
  "nativeUpdateUniforms(JLjava/lang/String;FFFFI)V": (b: bigint, name: string, x: number, y: number, z: number, w: number, n: number) =>
    shaderBuilder(b).set(name, [x, y, z, w].slice(0, n)),
  "nativeUpdateUniforms(JLjava/lang/String;IIIII)V": (b: bigint, name: string, x: number, y: number, z: number, w: number, n: number) =>
    shaderBuilder(b).set(name, [x, y, z, w].slice(0, n), false, true),
  "nativeUpdateUniforms(JLjava/lang/String;[FZ)V": (b: bigint, name: string, values: Float32Array, isColor: number) =>
    shaderBuilder(b).set(name, values, !!isColor),
  "nativeUpdateUniforms(JLjava/lang/String;[I)V": (b: bigint, name: string, values: Int32Array) =>
    shaderBuilder(b).set(name, values, false, true),
});

// ── android.graphics.Typeface ──────────────────────────────────────────────────────────
// hwui's Typeface over fonts.ts' collections; a null handle is the default, as resolveDefault has it
const typefaceAt = (h: bigint) => h ? deref<NativeTypeface>(h) : typefaceOf(null);
delegate("android/graphics/Typeface", {
  "nativeGetReleaseFunc()J": () => FINALIZER,
  "nativeCreateFromTypeface(JI)J": (h: bigint, style: number) => handle(createRelative(typefaceAt(h), style)),
  "nativeCreateFromTypefaceWithExactStyle(JIZ)J": (h: bigint, weight: number, italic: number) => handle(createAbsolute(typefaceAt(h), weight, !!italic)),
  "nativeCreateFromTypefaceWithVariation(JLjava/util/List;)J": (h: bigint, axes: object) => after(createWithVariation(typefaceAt(h), axes), handle),
  "nativeCreateWeightAlias(JI)J": (h: bigint, weight: number) => handle(createWithBaseWeight(typefaceAt(h), weight)),
  "nativeCreateFromArray([JJII)J": (families: BigInt64Array, fallback: bigint, weight: number, italic: number) =>
    handle(createFromFamilies(Array.from(families, (h) => deref<NativeFamily>(h)), weight, italic, fallback ? deref<NativeTypeface>(fallback) : null)),
  "nativeGetStyle(J)I": (h: bigint) => deref<NativeTypeface>(h).apiStyle,
  "nativeGetWeight(J)I": (h: bigint) => deref<NativeTypeface>(h).weight,
  "nativeGetSupportedAxes(J)[I": (h: bigint) => {
    const axes = deref<NativeTypeface>(h).collection.supportedAxes;
    return axes.length ? Int32Array.from(axes) : null;
  },
  "nativeSetDefault(J)V": (h: bigint) => { setDefaultTypeface(deref<NativeTypeface>(h)); },
  // DEFAULT and the other constants are static finals setSystemFontMap assigns
  "nativeForceSetStaticFinalField(Ljava/lang/String;Landroid/graphics/Typeface;)V": (name: string, t: object) => {
    const info = rt.link("android/graphics/Typeface");
    info.ctor[info.staticFieldTable.get(name + ":Landroid/graphics/Typeface;")!] = t;
  },
  // Minikin's registries of generic families and locales serve native font lookups, which the
  // browser's font matching does here; warming a font's cache has nothing to warm.
  ...noops("nativeRegisterGenericFamily(Ljava/lang/String;J)V", "nativeRegisterLocaleList(Ljava/lang/String;)V", "nativeWarmUpCache(Ljava/lang/String;)V"),
  // the font map a process shares with the system server; there is no other process
  "nativeReadTypefaces(Ljava/nio/ByteBuffer;I)[J": () => null,
  ...noops("nativeAddFontCollections(J)V"),
  ...stubs(0, "nativeWriteTypefaces(Ljava/nio/ByteBuffer;I[J)I"),
});

// ── android.graphics.fonts ─────────────────────────────────────────────────────────────
// minikin's Font and FontFamily are fonts.ts' NativeFont and NativeFamily.
/** a builder's state, which building consumes, as the JNI's unique_ptr does */
function take<T>(h: bigint): T { const b = deref<T>(h); release(h); return b; }
/** a direct buffer's bytes, as GetDirectBufferAddress and GetDirectBufferCapacity see them;
 *  guest memory can move, so bytes there are copied */
function directBytes<T>(b: JBuffer | null, then: (bytes: Uint8Array) => T): T | Promise<T> {
  if (!b) rt.npe();
  const address = addressOf(b!);
  if (!address) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a direct buffer");
  return after(resident(b!), () => then(isExternal(address) ? bufferBytes(b!) : bufferBytes(b!).slice()));
}
const PACKED_ITALIC = 1 << 16;
delegate("android/graphics/fonts/Font$Builder", {
  "nInitBuilder()J": () => handle({ axes: [] as Axis[] }),
  "nAddAxis(JIF)V": (b: bigint, tag: number, value: number) => { deref<{ axes: Axis[] }>(b).axes.push({ tag, value }); },
  "nBuild(JLjava/nio/ByteBuffer;Ljava/lang/String;Ljava/lang/String;IZI)J": (b: bigint, buffer: JBuffer | null, path: string, locales: string, weight: number, italic: number, ttcIndex: number) => {
    const { axes } = take<{ axes: Axis[] }>(b);
    return directBytes(buffer, (bytes) => {
      const font = new NativeFont(bytes, ttcIndex, weight, !!italic, axes, path, locales);
      // what FreeType cannot open as a face (no head or hhea) Skia makes no typeface of
      if (!font.faceMetrics) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Failed to create internal object. maybe invalid font data.");
      return wrapFont(font);
    });
  },
  // Skia's makeClone over the same data: new axes, style and collection index
  "nClone(JJIZI)J": (font: bigint, b: bigint, weight: number, italic: number, ttcIndex: number) => {
    const { axes } = take<{ axes: Axis[] }>(b), f = fontOf(font);
    return wrapFont(new NativeFont(f.bytes, ttcIndex, weight, !!italic, axes, f.path, f.locales, f.sourceId));
  },
});
delegate("android/graphics/fonts/Font", {
  "nGetReleaseNativeFont()J": () => FINALIZER,
  "nCloneFont(J)J": (h: bigint) => wrapFont(fontOf(h)),
  "nNewByteBuffer(J)Ljava/nio/ByteBuffer;": (h: bigint) => readOnlyBuffer(fontOf(h).bytes),
  // identity only: Font.equals compares these
  "nGetMinikinFontPtr(J)J": (h: bigint) => weakHandle(fontOf(h)),
  "nGetSourceId(J)I": (h: bigint) => fontOf(h).sourceId,
  "nGetFontPath(J)Ljava/lang/String;": (h: bigint) => fontOf(h).path,
  "nGetLocaleList(J)Ljava/lang/String;": (h: bigint) => fontOf(h).locales,
  "nGetPackedStyle(J)I": (h: bigint) => { const f = fontOf(h); return f.weight | (f.italic ? PACKED_ITALIC : 0); },
  "nGetIndex(J)I": (h: bigint) => fontOf(h).ttcIndex,
  "nGetAxisCount(J)I": (h: bigint) => fontOf(h).axes.length,
  "nGetAxisInfo(JI)J": (h: bigint, i: number) => {
    const a = fontOf(h).axes[i];
    return BigInt(a.tag >>> 0) << 32n | BigInt(new Uint32Array(Float32Array.of(a.value).buffer)[0]);
  },
  // SkFont::getMetrics over this face at the paint's size
  "nGetFontMetrics(JJLandroid/graphics/Paint$FontMetrics;)F": (h: bigint, p: bigint, fm: { top: number; ascent: number; descent: number; bottom: number; leading: number } | null) => {
    const m = fontOf(h).faceMetrics!;
    const size = paint(p).textSize, f = Math.fround;
    const ascent = f(-m.ascent * size), descent = f(m.descent * size), leading = f(m.leading * size);
    if (fm) { fm.top = f(-m.top * size); fm.ascent = ascent; fm.descent = descent; fm.bottom = f(m.bottom * size); fm.leading = leading; }
    return f(descent - ascent + leading);
  },
  "nGetGlyphBounds(JIJLandroid/graphics/RectF;)F": (h: bigint, glyph: number, p: bigint, rect: JRectF | null) => glyphBounds(fontOf(h), glyph, paint(p), rect),
  "nGetAvailableFontSet()[J": () => systemFonts().then((fonts) => BigInt64Array.from(fonts, wrapFont)),
});
delegate("android/graphics/fonts/FontFamily$Builder", {
  "nInitBuilder()J": () => handle({ fonts: [] as NativeFont[] }),
  "nAddFont(JJ)V": (b: bigint, font: bigint) => { deref<{ fonts: NativeFont[] }>(b).fonts.push(fontOf(font)); },
  // minikin rejects a family whose default face has no cmap (no coverage)
  "nBuild(JLjava/lang/String;IZZI)J": (b: bigint, langTags: string | null, variant: number) => {
    const { fonts } = take<{ fonts: NativeFont[] }>(b);
    const regular = new NativeFamily(fonts, "").closest(400, false);
    if (!sfntTables(regular.bytes, regular.ttcIndex)?.at.has(T_CMAP)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Failed to create internal object. maybe invalid font data");
    return mkFamily(fonts, langTags ?? "", variant).then(handle);
  },
  "nGetReleaseNativeFamily()J": () => FINALIZER,
});
delegate("android/graphics/fonts/FontFamily", {
  "nGetFont(JI)J": (h: bigint, i: number) => wrapFont(deref<NativeFamily>(h).fonts[i]),
  "nGetFontSize(J)I": (h: bigint) => deref<NativeFamily>(h).fonts.length,
  "nGetLangTags(J)Ljava/lang/String;": (h: bigint) => deref<NativeFamily>(h).langTags,
  "nGetVariant(J)I": (h: bigint) => deref<NativeFamily>(h).variant,
});
delegate("android/graphics/fonts/FontFileUtil", {
  "nGetFontRevision(Ljava/nio/ByteBuffer;I)J": (b: JBuffer | null, index: number) => directBytes(b, (bytes) => fontRevision(bytes, index)),
  "nGetFontPostScriptName(Ljava/nio/ByteBuffer;I)Ljava/lang/String;": (b: JBuffer | null, index: number) => directBytes(b, (bytes) => postScriptName(bytes, index)),
  "nIsPostScriptType1Font(Ljava/nio/ByteBuffer;I)I": (b: JBuffer | null, index: number) => directBytes(b, (bytes) => isPostScriptType1(bytes, index)),
});

// ── android.graphics.Paint ─────────────────────────────────────────────────────────────
// JPaint is the object: it already carries the tuned font-string memo, the fill-style
// resolution and the letter spacing, and this is the same state under AOSP's names.
const paint = (h: bigint) => deref<JPaint>(h);

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

  "nSetColor(JI)V": (h: bigint, c: number) => { paint(h).setColorValue(c); },
  "nSetColor(JJJ)V": (h: bigint, _cs: bigint, c: bigint) => { paint(h).setColorValue(argbOfColorLong(c)); },
  "nSetAlpha(JI)V": (h: bigint, a: number) => { paint(h).setAlphaValue(a); },
  "nSetStyle(JI)V": (h: bigint, v: number) => { paint(h).style = v; },
  "nGetStyle(J)I": (h: bigint) => paint(h).style,
  "nSetStrokeWidth(JF)V": (h: bigint, w: number) => { paint(h).strokeWidth = w; },
  "nGetStrokeWidth(J)F": (h: bigint) => paint(h).strokeWidth,
  "nSetStrokeCap(JI)V": (h: bigint, v: number) => { paint(h).strokeCapN = CAPS[v] ?? "butt"; },
  "nGetStrokeCap(J)I": (h: bigint) => Math.max(0, CAPS.indexOf(paint(h).strokeCapN as never)),
  "nSetStrokeJoin(JI)V": (h: bigint, v: number) => { paint(h).strokeJoinN = JOINS[v] ?? "miter"; },
  "nGetStrokeJoin(J)I": (h: bigint) => Math.max(0, JOINS.indexOf(paint(h).strokeJoinN as never)),
  ...noops("nSetStrokeMiter(JF)V"), ...stubs(4, "nGetStrokeMiter(J)F"),

  // flags: nSetFlags sets the lot, and AOSP also spells one entry point per flag
  "nSetFlags(JI)V": (h: bigint, f: number) => { paint(h).flags = f; },
  "nGetFlags(J)I": (h: bigint) => paint(h).flags,
  "nSetAntiAlias(JZ)V": flag((p, v) => { p.antiAlias = v; }),
  "nSetUnderlineText(JZ)V": flag((p, v) => { p.underline = v; }),
  "nSetStrikeThruText(JZ)V": flag((p, v) => { p.strikeThru = v; }),
  "nSetFakeBoldText(JZ)V": flag((p, v) => { p.fakeBold = v; }),
  "nSetLinearText(JZ)V": flag((p, v) => { p.linearText = v; }),
  "nSetSubpixelText(JZ)V": flag((p, v) => { p.subpixelText = v; }),
  // Canvas2D has no dither, no bitmap filter toggle and no hinting
  ...noops("nSetDither(JZ)V", "nSetFilterBitmap(JZ)V", "nSetHinting(JI)V"),
  ...stubs(1, "nGetHinting(J)I"),

  // effects: each returns the native handle it was given, which is what Paint stores back
  "nSetShader(JJ)J": (h: bigint, sh: bigint) => { paint(h).shader = deref<NativeShader | undefined>(sh) ?? null; return sh; },
  "nSetColorFilter(JJ)J": (h: bigint, f: bigint) => { paint(h).colorFilter = deref<NativeColorFilter | undefined>(f) ?? null; return f; },
  "nSetMaskFilter(JJ)J": (_h: bigint, f: bigint) => f,
  "nSetPathEffect(JJ)J": (_h: bigint, f: bigint) => f,

  "nSetTypeface(JJ)V": (h: bigint, t: bigint) => { paint(h).tf = t ? deref<NativeTypeface>(t) : null; },
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
  "nGetFontMetrics(JLandroid/graphics/Paint$FontMetrics;Z)F": (h: bigint, fm: Metrics) => fillFontMetrics(paint(h), fm, false),
  "nGetFontMetricsInt(JLandroid/graphics/Paint$FontMetricsInt;Z)I": (h: bigint, fm: Metrics) => fillFontMetrics(paint(h), fm, true),
  // the per-run forms answer for one text run; with one font for everything, the run does
  // not change the answer, so they are the whole-paint metrics
  "nGetFontMetricsIntForText(J[CIIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _c: Uint16Array, _a: number, _b: number, _d: number, _e: number, _f: number, fm: Metrics) => fillFontMetrics(paint(h), fm, true),
  "nGetFontMetricsIntForText(JLjava/lang/String;IIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _s: string, _a: number, _b: number, _d: number, _e: number, _f: number, fm: Metrics) => fillFontMetrics(paint(h), fm, true),

  "nGetCharArrayBounds(J[CIIILandroid/graphics/Rect;)V": (h: bigint, c: Uint16Array, i: number, n: number, _bidi: number, r: Rect) =>
    textBounds(paint(h), charsToString(c, i, n), r),
  "nGetStringBounds(JLjava/lang/String;IIILandroid/graphics/Rect;)V": (h: bigint, s: string, a: number, b: number, _bidi: number, r: Rect) =>
    textBounds(paint(h), s.slice(a, b), r),
  "nEqualsForTextMeasurement(JJ)Z": (a: bigint, b: bigint) => {
    const x = paint(a), y = paint(b);
    return x.textSize === y.textSize && x.tf === y.tf && x.letterSpacingEm === y.letterSpacingEm ? 1 : 0;
  },
  // an outline the Canvas2D backend cannot produce: leave the path empty rather than wrong
  "nGetTextPath(JI[CIIFFJ)V": () => {},
  "nGetFillPath(JJJ)Z": (_h: bigint, src: bigint, dst: bigint) => { path(dst).set(path(src)); return 1; },

  // what glyph shaping reads (shaping.ts)
  "nSetTextScaleX(JF)V": (h: bigint, v: number) => { paint(h).textScaleX = v; },
  "nGetTextScaleX(J)F": (h: bigint) => paint(h).textScaleX,
  "nSetTextSkewX(JF)V": (h: bigint, v: number) => { paint(h).textSkewX = v; },
  "nGetTextSkewX(J)F": (h: bigint) => paint(h).textSkewX,
  "nSetFontFeatureSettings(JLjava/lang/String;)V": (h: bigint, v: string | null) => { paint(h).fontFeatureSettings = v; },

  // state we accept and do not act on: one font, one locale, no hyphenation
  ...noops("nSetElegantTextHeight(JI)V", "nSetStartHyphenEdit(JI)V", "nSetEndHyphenEdit(JI)V", "nSetWordSpacing(JF)V",
    "nSetXfermode(JI)V", "nSetShadowLayer(JFFFJJ)V", "nGetTextPath(JILjava/lang/String;IIFFJ)V",
    "nSetTextLocalesByMinikinLocaleListId(JI)V"),
  ...stubs(0, "nGetElegantTextHeight(J)I", "nGetStartHyphenEdit(J)I", "nGetEndHyphenEdit(J)I",
    "nGetWordSpacing(J)F", "nHasShadowLayer(J)Z", "nSetTextLocales(JLjava/lang/String;)I"),
  ...stubs(1, "nHasGlyph(JILjava/lang/String;)Z"),
});

interface Metrics { top: number; ascent: number; descent: number; bottom: number; leading: number }
/** the glyph bounds the browser reports, rounded out */
function textBounds(p: JPaint, s: string, r: Rect) {
  const m = measureCtx(p.font(), p.language).measureText(s);
  r.left = Math.floor(-m.actualBoundingBoxLeft); r.right = Math.ceil(m.actualBoundingBoxRight);
  r.top = -Math.ceil(m.actualBoundingBoxAscent); r.bottom = Math.ceil(m.actualBoundingBoxDescent);
}

// ── android.graphics.Path, PathMeasure and PathIterator ────────────────────────────────
// The geometry and Skia's rules for it live in path.ts, beside the bridge TS reaches it through.
const path = (h: bigint) => deref<NativePath>(h);

delegate("android/graphics/Path", {
  "nInit()J": () => handle(new NativePath()),
  // a null source is an empty path
  "nInit(J)J": (h: bigint) => { const p = new NativePath(); if (h) p.set(path(h)); return handle(p); },
  "nGetFinalizer()J": () => FINALIZER,
  "nReset(J)V": (h: bigint) => path(h).reset(),
  "nRewind(J)V": (h: bigint) => path(h).reset(),
  "nSet(JJ)V": (h: bigint, s: bigint) => path(h).set(path(s)),
  "nIsEmpty(J)Z": (h: bigint) => (path(h).ops.length ? 0 : 1),
  "nGetGenerationID(J)I": (h: bigint) => path(h).generation(),
  "nGetFillType(J)I": (h: bigint) => path(h).fillType(),
  "nSetFillType(JI)V": (h: bigint, ft: number) => path(h).setFillType(ft),

  "nMoveTo(JFF)V": (h: bigint, x: number, y: number) => path(h).moveTo(x, y),
  "nLineTo(JFF)V": (h: bigint, x: number, y: number) => path(h).lineTo(x, y),
  "nQuadTo(JFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number) => path(h).quadTo(x1, y1, x2, y2),
  "nCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => path(h).cubicTo(a, b, c, d, e, f),
  "nConicTo(JFFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number, w: number) => path(h).conicTo(x1, y1, x2, y2, w),
  // relative to the last point, which a close returns to the contour's start
  "nRMoveTo(JFF)V": (h: bigint, dx: number, dy: number) => { const p = path(h); p.moveTo(p.pen.x + dx, p.pen.y + dy); },
  "nRLineTo(JFF)V": (h: bigint, dx: number, dy: number) => { const p = path(h); p.lineTo(p.pen.x + dx, p.pen.y + dy); },
  "nRQuadTo(JFFFF)V": (h: bigint, a: number, b: number, c: number, d: number) => {
    const p = path(h), { x, y } = p.pen;
    p.quadTo(x + a, y + b, x + c, y + d);
  },
  "nRCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => {
    const p = path(h), { x, y } = p.pen;
    p.cubicTo(x + a, y + b, x + c, y + d, x + e, y + f);
  },
  "nRConicTo(JFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, w: number) => {
    const p = path(h), { x, y } = p.pen;
    p.conicTo(x + a, y + b, x + c, y + d, w);
  },
  "nClose(J)V": (h: bigint) => path(h).close(),
  "nSetLastPoint(JFF)V": (h: bigint, x: number, y: number) => path(h).setLastPoint(x, y),

  "nAddRect(JFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, d: number) => path(h).addRect(l, t, r, b, d),
  "nAddOval(JFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, d: number) => path(h).addOval(l, t, r, b, d),
  "nAddCircle(JFFFI)V": (h: bigint, x: number, y: number, r: number, d: number) => path(h).addCircle(x, y, r, d),
  "nAddArc(JFFFFFF)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number) => path(h).addArc(l, t, r, b, start, sweep),
  "nArcTo(JFFFFFFZ)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number, force: number) =>
    path(h).arcTo(l, t, r, b, start, sweep, !!force),
  // SkPath::addRoundRect ignores a negative radius
  "nAddRoundRect(JFFFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number, d: number) => {
    if (rx >= 0 && ry >= 0) path(h).addRoundRect(l, t, r, b, [rx, ry, rx, ry, rx, ry, rx, ry], d);
  },
  "nAddRoundRect(JFFFF[FI)V": (h: bigint, l: number, t: number, r: number, b: number, radii: Float32Array, d: number) => path(h).addRoundRect(l, t, r, b, radii, d),
  "nAddPath(JJ)V": (h: bigint, o: bigint) => path(h).append(path(o)),
  "nAddPath(JJFF)V": (h: bigint, o: bigint, dx: number, dy: number) => path(h).append(path(o), undefined, dx, dy),
  "nAddPath(JJJ)V": (h: bigint, o: bigint, mat: bigint) => path(h).append(path(o), matrix(mat)),

  "nOffset(JFF)V": (h: bigint, dx: number, dy: number) => path(h).offset(dx, dy),
  "nTransform(JJ)V": (h: bigint, mat: bigint) => path(h).transform(matrix(mat)),
  // a null destination transforms in place
  "nTransform(JJJ)V": (h: bigint, mat: bigint, dst: bigint) => {
    const d = dst ? path(dst) : path(h);
    d.set(path(h));
    d.transform(matrix(mat));
  },
  "nComputeBounds(JLandroid/graphics/RectF;)V": (h: bigint, r: Rect) => path(h).bounds(r),
  "nIsRect(JLandroid/graphics/RectF;)Z": (h: bigint, r: Rect) => (path(h).isRect(r) ? 1 : 0),
  "nIsConvex(J)Z": (h: bigint) => (pathIsConvex(path(h)) ? 1 : 0),
  "nOp(JJIJ)Z": (a: bigint, b: bigint, op: number, dst: bigint) => (pathOp(path(dst), path(a), path(b), op) ? 1 : 0),
  "nIsInterpolatable(JJ)Z": (a: bigint, b: bigint) => (path(a).isInterpolatable(path(b)) ? 1 : 0),
  "nInterpolate(JJFJ)Z": (a: bigint, b: bigint, t: number, out: bigint) => (path(a).interpolate(path(b), t, path(out)) ? 1 : 0),
  "nApproximate(JF)[F": (h: bigint, error: number) => approximate(path(h), error),
  ...noops("nIncReserve(JI)V"),
});

// PathMeasure frees its native state from finalize(), which never runs here
const measure = (h: bigint) => deref<PathMeasure>(h);
delegate("android/graphics/PathMeasure", {
  "native_create(JZ)J": (p: bigint, forceClosed: number) => {
    const m = new PathMeasure();
    m.setPath(p ? path(p) : undefined, !!forceClosed);
    return ownedHandle(m);
  },
  "native_setPath(JJZ)V": (h: bigint, p: bigint, forceClosed: number) => measure(h).setPath(p ? path(p) : undefined, !!forceClosed),
  "native_getLength(J)F": (h: bigint) => measure(h).length(),
  "native_getPosTan(JF[F[F)Z": (h: bigint, d: number, pos: Float32Array | null, tan: Float32Array | null) => (measure(h).getPosTan(d, pos, tan) ? 1 : 0),
  "native_getMatrix(JFJI)Z": (h: bigint, d: number, m: bigint, flags: number) => (measure(h).getMatrix(d, matrix(m), flags) ? 1 : 0),
  "native_getSegment(JFFJZ)Z": (h: bigint, start: number, stop: number, dst: bigint, moveTo: number) =>
    (measure(h).getSegment(start, stop, path(dst), !!moveTo) ? 1 : 0),
  "native_isClosed(J)Z": (h: bigint) => (measure(h).isClosed() ? 1 : 0),
  "native_nextContour(J)Z": (h: bigint) => (measure(h).nextContour() ? 1 : 0),
  "native_destroy(J)V": release,
});

// nNext writes into the non-movable float[8] whose address is its handle (VMRuntime.addressOf)
const iterator = (h: bigint) => deref<VerbIterator>(h);
delegate("android/graphics/PathIterator", {
  "nCreate(J)J": (p: bigint) => handle(new VerbIterator(path(p))),
  "nGetFinalizer()J": () => FINALIZER,
  "nPeek(J)I": (h: bigint) => iterator(h).peek(),
  "nNext(JJ)I": (h: bigint, pts: bigint) => iterator(h).next(deref<Float32Array>(pts), 0),
});

// ── android.graphics.Region and RegionIterator ─────────────────────────────────────────
// Both free their native state from finalize(), which never runs here.
const region = (h: bigint) => deref<NativeRegion>(h);
const scratch = new NativeRegion();
delegate("android/graphics/Region", {
  "nativeConstructor()J": () => ownedHandle(new NativeRegion()),
  "nativeDestructor(J)V": release,
  "nativeSetRegion(JJ)V": (h: bigint, src: bigint) => { region(h).set(region(src)); },
  "nativeSetRect(JIIII)Z": (h: bigint, l: number, t: number, r: number, b: number) => +region(h).setRect(l, t, r, b),
  "nativeSetPath(JJJ)Z": (h: bigint, p: bigint, clip: bigint) => +region(h).setPath(path(p), region(clip)),
  "nativeGetBounds(JLandroid/graphics/Rect;)Z": (h: bigint, r: Rect) => +region(h).bounds(r),
  "nativeGetBoundaryPath(JJ)Z": (h: bigint, p: bigint) => +region(h).boundaryPath(path(p)),
  "nativeOp(JIIIII)Z": (h: bigint, l: number, t: number, r: number, b: number, op: number) => {
    scratch.setRect(l, t, r, b);
    return +region(h).op(region(h), scratch, op);
  },
  "nativeOp(JLandroid/graphics/Rect;JI)Z": (h: bigint, r: Rect, other: bigint, op: number) => {
    scratch.setRect(r.left, r.top, r.right, r.bottom);
    return +region(h).op(scratch, region(other), op);
  },
  "nativeOp(JJJI)Z": (h: bigint, a: bigint, b: bigint, op: number) => +region(h).op(region(a), region(b), op),
  // the rects as one int vector, which is Parcel's int-array form
  "nativeWriteToParcel(JLandroid/os/Parcel;)Z": (h: bigint, parcel: object | null) =>
    parcel ? after(vcall(parcel, "writeIntArray", "([I)V", Int32Array.from(region(h).rects())), () => 1) : 0,
  "nativeCreateFromParcel(Landroid/os/Parcel;)J": (parcel: object | null) => parcel ? after(vcall(parcel, "createIntArray", "()[I"), (rects: Int32Array | null) => {
    if (rects && rects.length % 4) return 0n;
    const r = new NativeRegion();
    if (rects) r.setRects(rects);
    return ownedHandle(r);
  }) : 0n,
  "nativeEquals(JJ)Z": (a: bigint, b: bigint) => +region(a).equals(region(b)),
  "nativeToString(J)Ljava/lang/String;": (h: bigint) => region(h).toString(),
  "isEmpty()Z": function (this: object) { return +nativeRegionOf(this).isEmpty(); },
  "isRect()Z": function (this: object) { return +nativeRegionOf(this).isRect(); },
  "isComplex()Z": function (this: object) { return +nativeRegionOf(this).isComplex(); },
  "contains(II)Z": function (this: object, x: number, y: number) { return +nativeRegionOf(this).contains(x, y); },
  "quickContains(IIII)Z": function (this: object, l: number, t: number, r: number, b: number) { return +nativeRegionOf(this).quickContains(l, t, r, b); },
  "quickReject(IIII)Z": function (this: object, l: number, t: number, r: number, b: number) { return +nativeRegionOf(this).quickReject(l, t, r, b); },
  "quickReject(Landroid/graphics/Region;)Z": function (this: object, o: object) {
    const b = { left: 0, top: 0, right: 0, bottom: 0 };
    return +(!nativeRegionOf(o).bounds(b) || nativeRegionOf(this).quickReject(b.left, b.top, b.right, b.bottom));
  },
  "translate(IILandroid/graphics/Region;)V": function (this: object, dx: number, dy: number, dst: object | null) {
    const r = nativeRegionOf(this);
    r.translate(dx, dy, dst ? nativeRegionOf(dst) : r);
  },
  // hwui's scale_rgn: each rect's edges scaled and rounded half away from zero, then unioned
  "scale(FLandroid/graphics/Region;)V": function (this: object, s: number, dst: object | null) {
    const r = nativeRegionOf(this), round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
    (dst ? nativeRegionOf(dst) : r).setRects(r.rects().map((v) => round(Math.fround(v * s))));
  },
});
// the iterator walks its own copy of the region, as hwui's RgnIterPair does
delegate("android/graphics/RegionIterator", {
  "nativeConstructor(J)J": (h: bigint) => ownedHandle({ rects: region(h).rects(), at: 0 }),
  "nativeDestructor(J)V": release,
  "nativeNext(JLandroid/graphics/Rect;)Z": (h: bigint, r: Rect) => {
    const it = deref<{ rects: number[]; at: number }>(h);
    if (it.at >= it.rects.length) return 0;
    [r.left, r.top, r.right, r.bottom] = it.rects.slice(it.at, it.at += 4);
    return 1;
  },
});


// ── android.graphics.Camera: Sk3DView ──────────────────────────────────────────────────
let nativeInstance = "";
/** where a Java Camera keeps its Sk3DView, which its natives set and read themselves */
const cameraSlot = (c: object) => c as Record<string, bigint>;
const instanceField = () => nativeInstance ||= declaredField("android/graphics/Camera", "native_instance");
const camera = (c: object) => deref<Camera3D>(cameraSlot(c)[instanceField()]);
delegate("android/graphics/Camera", {
  "nativeConstructor()V": function (this: object) { cameraSlot(this)[instanceField()] = ownedHandle(new Camera3D()); },
  "nativeDestructor()V": function (this: object) { release(cameraSlot(this)[instanceField()]); },
  "save()V": function (this: object) { const c = camera(this); c.stack.push(c.top.slice()); },
  "restore()V": function (this: object) { const c = camera(this); if (c.stack.length > 1) c.stack.pop(); },
  // SkM44::preTranslate
  "translate(FFF)V": function (this: object, x: number, y: number, z: number) { camera(this).preConcat([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]); },
  "rotateX(F)V": function (this: object, deg: number) { camera(this).rotate(1, 0, 0, deg); },
  "rotateY(F)V": function (this: object, deg: number) { camera(this).rotate(0, -1, 0, deg); },
  "rotateZ(F)V": function (this: object, deg: number) { camera(this).rotate(0, 0, 1, deg); },
  "rotate(FFF)V": function (this: object, x: number, y: number, z: number) {
    const c = camera(this);
    c.rotate(1, 0, 0, x); c.rotate(0, -1, 0, y); c.rotate(0, 0, 1, z);
  },
  "setLocation(FFF)V": function (this: object, x: number, y: number, z: number) { camera(this).location = [x, y, z].map((v) => Math.fround(v * 72)); },
  "getLocationX()F": function (this: object) { return Math.fround(camera(this).location[0] / 72); },
  "getLocationY()F": function (this: object) { return Math.fround(camera(this).location[1] / 72); },
  "getLocationZ()F": function (this: object) { return Math.fround(camera(this).location[2] / 72); },
  "nativeGetMatrix(J)V": function (this: object, m: bigint) { camera(this).matrix(matrix(m)); },
  "nativeApplyToCanvas(J)V": function (this: object, h: bigint) {
    const m = identity();
    camera(this).matrix(m);
    applyMatrix(deref<NativeCanvas>(h).ctx, m);
  },
  // SkPatch3D::dotWith, whose y term Skia computes as u.z*v.x - u.x*v.y
  "dotWithNormal(FFF)F": function (this: object, x: number, y: number, z: number) {
    const { u, v } = camera(this).patch();
    return Math.fround((u[1] * v[2] - u[2] * v[1]) * x + (u[2] * v[0] - u[0] * v[1]) * y + (u[0] * v[1] - u[1] * v[0]) * z);
  },
});

// ── android.graphics.Interpolator: hwui's SkiaInterpolator ─────────────────────────────
// Key frames at unsigned millisecond times, each with the cubic that eases toward the next;
// timeToValues answers SkiaInterpolatorBase::Result (0 normal, 1 freeze start, 2 freeze end).
const IDENTITY_BLEND = [0.33333333, 0.33333333, 0.66666667, 0.66666667].map(Math.fround);
class KeyFrames {
  times!: Uint32Array; blends!: Float32Array; values!: Float32Array;
  elems = 0; repeat = 1; mirror = false;
  constructor(elems: number, frames: number) { this.reset(elems, frames); }
  reset(elems: number, frames: number) {
    this.elems = elems & 0xff; this.repeat = 1; this.mirror = false;
    this.times = new Uint32Array(frames); this.blends = new Float32Array(frames * 4); this.values = new Float32Array(frames * this.elems);
  }
  /** SkiaInterpolator's binarySearch over the first `count` times: the index of a time the
   *  bisection lands on, else ~ where `time` would go, after an equal time it did not land on
   *  (so the last frame's own time is past the end: the device freezes there) */
  search(time: number, count = this.times.length): number {
    if (count <= 0) return ~0;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, t = this.times[mid];
      if (t === time) return mid;
      if (t < time) lo = mid + 1; else hi = mid;
    }
    return time < this.times[lo] ? ~lo : ~(lo + 1);
  }
  timeToValues(time: number, out: Float32Array | null): number {
    const times = this.times, n = times.length, f = Math.fround;
    let result = 0;
    time >>>= 0;
    if (this.repeat !== 1) {
      const start = times[0], total = (times[n - 1] - start) >>> 0, end = Math.floor(f(this.repeat * total)) >>> 0;
      let offset = (time - start) >>> 0;
      if (offset >= end) {
        const fraction = f(this.repeat - Math.trunc(this.repeat));
        offset = fraction === 0 && this.repeat > 0 ? total : Math.floor(f(fraction * total)) >>> 0;
        result = 2;
      } else {
        offset %= this.mirror ? total * 2 : total;
        if (offset > total) offset = total * 2 - offset;
      }
      time = (offset + start) >>> 0;
    }
    let index = this.search(time), exact = true;
    if (index < 0) {
      index = ~index;
      if (index === 0) result = 1;
      else if (index === n) { index--; result = 2; }
      else exact = false;
    }
    if (out) {
      const e = this.elems, next = index * e;
      if (exact) out.set(this.values.subarray(next, next + e));
      else {
        const b = (index - 1) * 4, t = unitCubicInterp(f((time - times[index - 1]) / (times[index] - times[index - 1])),
          this.blends[b], this.blends[b + 1], this.blends[b + 2], this.blends[b + 3]);
        for (let i = 0; i < e; i++) { const p = this.values[next - e + i]; out[i] = f(p + f(f(this.values[next + i] - p) * t)); }
      }
    }
    return result;
  }
}
/** SkiaInterpolatorBase::UnitCubicInterp: y on the unit cubic (0,0) (bx,by) (cx,cy) (1,1) at x,
 *  found by bisection in 2.14 fixed point */
function unitCubicInterp(value: number, bx: number, by: number, cx: number, cy: number): number {
  const ONE = 1 << 14, dot14 = (v: number) => (v <= 0 ? 0 : v >= 1 ? ONE : Math.floor(v * 65536) >> 2);
  const mul = (a: number, b: number) => (a * b + (1 << 13)) >> 14;
  const evalCubic = (t: number, a: number, b: number, c: number) => mul(mul(mul(c, t) + b, t) + a, t);
  const x = dot14(value);
  if (x === 0) return 0;
  if (x === ONE) return 1;
  let b = dot14(bx), c = dot14(cx), A = 3 * b, B = 3 * (c - 2 * b), C = 3 * (b - c) + ONE;
  let t = ONE >> 1, dt = ONE >> 1;
  for (let i = 0; i < 13; i++) {
    dt >>= 1;
    if (x < evalCubic(t, A, B, C)) t -= dt;
    else t += dt;
  }
  b = dot14(by); c = dot14(cy); A = 3 * b; B = 3 * (c - 2 * b); C = 3 * (b - c) + ONE;
  return Math.fround(evalCubic(t, A, B, C) / ONE);
}
// Interpolator frees its native state from finalize(), which never runs here
const keyFrames = (h: bigint) => deref<KeyFrames>(h);
delegate("android/graphics/Interpolator", {
  "nativeConstructor(II)J": (elems: number, frames: number) => ownedHandle(new KeyFrames(elems, frames)),
  "nativeDestructor(J)V": release,
  "nativeReset(JII)V": (h: bigint, elems: number, frames: number) => keyFrames(h).reset(elems, frames),
  // a key frame must come after the ones before it, or SkiaInterpolator leaves it unset
  "nativeSetKeyFrame(JII[F[F)V": (h: bigint, index: number, msec: number, values: Float32Array, blend: Float32Array | null) => {
    const k = keyFrames(h), time = msec >>> 0;
    if (k.search(time, index) !== ~index) return;
    k.times[index] = time;
    k.blends.set(blend ? blend.subarray(0, 4) : IDENTITY_BLEND, index * 4);
    k.values.set(values.subarray(0, k.elems), index * k.elems);
  },
  "nativeSetRepeatMirror(JFZ)V": (h: bigint, repeat: number, mirror: number) => {
    const k = keyFrames(h);
    k.repeat = Math.min(repeat, 32000); k.mirror = !!mirror;
  },
  "nativeTimeToValues(JI[F)I": (h: bigint, msec: number, values: Float32Array | null) => keyFrames(h).timeToValues(msec, values),
});

// ── android.graphics.NinePatch: its chunk deserialized ─────────────────────────────────
// NinePatch frees its chunk from finalize(), which never runs here
delegate("android/graphics/NinePatch", {
  "isNinePatchChunk([B)Z": (chunk: Int8Array | null) => +isNinePatchChunk(chunk),
  "validateNinePatchChunk([B)J": (chunk: Int8Array | null) => ownedHandle(validNinePatchChunk(chunk)),
  "nativeFinalize(J)V": release,
  "nativeGetTransparentRegion(JJLandroid/graphics/Rect;)J": (b: bigint, chunk: bigint, dst: Rect) => {
    const bmp = deref<NativeBitmap>(b), rects = transparentPatches(deref<NinePatchChunk>(chunk), bmp.w, bmp.h, dst.left, dst.top, dst.right, dst.bottom);
    if (!rects.length) return 0n;
    const r = new NativeRegion();
    r.setRects(rects);
    return ownedHandle(r);
  },
});

// ── android.graphics.Picture: a recorded display list ──────────────────────────────────
// The recording canvas records as a RenderNode's does, and drawing the picture replays it into
// the target canvas inside a save/restore, as SkRecordDraw does. SkPicture's serialized form
// (createFromStream, writeToStream) is not implemented.
class NativePicture {
  w = 0; h = 0;
  ops: DisplayList | null = null;
  /** while recording: the canvas recording into `recording` (PictureCanvas owns its handle) */
  canvas: NativeCanvas | null = null; recording: DisplayList | null = null;
  /** SkPictureRecorder::finishRecordingAsPicture: the list is the picture's, and the canvas records no more of it */
  endRecording() {
    if (!this.recording) return;
    this.ops = this.recording; this.recording = null;
    retarget(this.canvas!.recording!.ctx, []);
    this.canvas = null;
  }
}
const picture = (h: bigint) => deref<NativePicture>(h);
delegate("android/graphics/Picture", {
  // a copy of a picture still recording holds what was recorded so far
  "nativeConstructor(J)J": (src: bigint) => {
    const p = new NativePicture();
    if (src) { const s = picture(src); p.w = s.w; p.h = s.h; p.ops = s.recording ? s.recording.slice() : s.ops; }
    return ownedHandle(p);
  },
  "nativeDestructor(J)V": (h: bigint) => { picture(h).endRecording(); release(h); },
  "nativeBeginRecording(JII)J": (h: bigint, w: number, ht: number) => {
    const p = picture(h);
    p.endRecording();
    p.w = w; p.h = ht; p.ops = null;
    const ops: DisplayList = p.recording = [], ctx = recordingContext(new OffscreenCanvas(1, 1).getContext("2d")!, ops);
    const c = p.canvas = NativeCanvas.over(ctx, w, ht);
    c.recording = { ctx, ops };
    return handle(c);
  },
  "nativeEndRecording(J)V": (h: bigint) => picture(h).endRecording(),
  "nativeGetWidth(J)I": (h: bigint) => picture(h).w,
  "nativeGetHeight(J)I": (h: bigint) => picture(h).h,
  "nativeDraw(JJ)V": (c: bigint, h: bigint) => {
    const p = picture(h), cv = deref<NativeCanvas>(c);
    p.endRecording();
    const ops = p.ops;
    if (!ops) return;
    replayWithSemantics(cv, () => {
      cv.ctx.save();
      try { replay(cv.ctx, ops); } finally { cv.ctx.restore(); }
    });
  },
});

// ── android.os.SystemProperties ────────────────────────────────────────────────────────
// A property is ABSENT unless the device profile (src/shell/config.ts) answers it, so other reads
// get the caller's own default — which is what a device that has not set one reports, and is the
// difference between "this device does not do that" and a made-up answer a library will branch
// on. An app process may not set properties, and a change report runs the registered callbacks,
// as the property service's own notification does.
const deviceProperties: Record<string, () => string> = {
  "persist.sys.timezone": () => device.timezone,
  // the reference AVD's heap limits, which ActivityManager reports as the memory classes
  "dalvik.vm.heapgrowthlimit": () => "192m", "dalvik.vm.heapsize": () => "576m",
};
/** android_os_SystemProperties.cpp's readers: an absent or unparsable value is the default */
const propValue = (key: string) => deviceProperties[key]?.() ?? null;
const propInt = (v: string | null, def: number) => v !== null && /^-?\d+$/.test(v.trim()) ? Number(BigInt.asIntN(32, BigInt(v.trim()))) : def;
const propLong = (v: string | null, def: bigint) => v !== null && /^-?\d+$/.test(v.trim()) ? BigInt.asIntN(64, BigInt(v.trim())) : def;
const propBool = (v: string | null, def: number) => v === null ? def : /^(1|y|yes|on|true)$/.test(v) ? 1 : /^(0|n|no|off|false)$/.test(v) ? 0 : def;
/** a property handle (SystemProperties.find) names a property the device has */
const propAt = (h: bigint) => propValue(deref<{ key: string }>(h).key);
delegate("android/os/SystemProperties", {
  "native_get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (key: string, def: string | null) => propValue(key) ?? def ?? "",
  "native_get_boolean(Ljava/lang/String;Z)Z": (key: string, def: number) => propBool(propValue(key), def),
  "native_get_int(Ljava/lang/String;I)I": (key: string, def: number) => propInt(propValue(key), def),
  "native_get_long(Ljava/lang/String;J)J": (key: string, def: bigint) => propLong(propValue(key), def),
  "native_find(Ljava/lang/String;)J": (key: string) => key in deviceProperties ? handle({ key }) : 0n,
  "native_get(J)Ljava/lang/String;": (h: bigint) => propAt(h) ?? "",
  "native_get_boolean(JZ)Z": (h: bigint, def: number) => propBool(propAt(h), def),
  "native_get_int(JI)I": (h: bigint, def: number) => propInt(propAt(h), def),
  "native_get_long(JJ)J": (h: bigint, def: bigint) => propLong(propAt(h), def),
  "native_set(Ljava/lang/String;Ljava/lang/String;)V": () => {
    throw rt.mkThrowable("java/lang/RuntimeException", "failed to set system property (check logcat for reason)");
  },
  "native_add_change_callback()V": () => {},
  // reached only from SystemProperties itself, which is therefore initialized
  "native_report_sysprop_change()V": () => vcall(rt.link("android/os/SystemProperties").ctor, "callChangeCallbacks", "()V"),
});

/** What the zygote sets up in a forked process before app code runs: System.out and System.err
 *  reach logcat, the default time zone follows persist.sys.timezone, java.util.logging reaches
 *  logcat with the default HTTP user agent set, the JCA providers are installed and warmed, and the
 *  system font map is loaded. */
export async function zygoteInit(): Promise<void> {
  // System.<clinit> reads user.name from the passwd entry of the zygote, which runs as root
  await asZygote(async () => { await rt.initClass(rt.link("java/lang/System")); });
  await scall("com/android/internal/os/RuntimeInit", "redirectLogStreams", "()V");
  const hooks = rt.link("dalvik/system/RuntimeHooks");
  await rt.initClass(hooks);
  await vcall(hooks.ctor, "setTimeZoneIdSupplier", "(Ljava/util/function/Supplier;)V", lambda("java/util/function/Supplier", "get()Ljava/lang/Object;", deviceProperties["persist.sys.timezone"]));
  await vcall(await scall("java/util/logging/LogManager", "getLogManager", "()Ljava/util/logging/LogManager;"), "reset", "()V");
  await newObj("com/android/internal/logging/AndroidConfig", "()V");
  await scall("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "http.agent",
    await scall("com/android/internal/os/RuntimeInit", "getDefaultUserAgent", "()Ljava/lang/String;"));
  // ZygoteInit.preload: AndroidKeyStoreProvider installed, every provider's services resolved
  await scall("com/android/internal/os/ZygoteInit", "warmUpJcaProviders", "()V");
  await loadSystemFontMap();
}
