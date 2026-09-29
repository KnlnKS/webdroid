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

import { rt, JObj, stubs, noops } from "../jvm/runtime";
import { handle, deref, replace, release, FINALIZER } from "./handles";
import {
  JPaint, JTypeface, tfDefault, mkTypeface, measureText,
  fontAscent, fontDescent, fillFontMetrics, copyPaint, argbOfColorLong,
  JCanvas, JBitmap, JRect, canvasMethods, bitmapMethods, setCanvasBitmap, extractBitmapAlpha, colorLongOfArgb, CAPS, JOINS,
  type Mat, IDENTITY, identity, mul, translateM, scaleM, skewM, sinCosM, rotateM, about, invert, mapPoint, isIdentity, affineOf, setAffine, applyMatrix,
} from "./graphics";
import { newObj, vcall, scall } from "../jvm/natives/jlang";
import { lambda } from "../jvm/natives/jstream";
import { charsToString } from "../jvm/abi";
import { JPath, appendPath, copyPath, pathBounds, pathIsConvex, pathOffset, pathTransform } from "./path";
import type { JTextPaint, TLine } from "./text";
import { breakLines } from "./linebreak";
import { device } from "../shell/config";

type Fn = (...a: never[]) => unknown;
/** register the native halves of one class, by their exact AOSP descriptors */
function delegate(cls: string, table: Record<string, unknown>) {
  for (const [sig, fn] of Object.entries(table)) rt.registerJni(cls, sig, fn as Fn);
}


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

// ── android.graphics.Typeface ──────────────────────────────────────────────────────────
delegate("android/graphics/Typeface", {
  "nativeCreateFromTypeface(JI)J": (h: bigint, style: number) => {
    const src = deref<JTypeface>(h) ?? tfDefault;
    return handle(mkTypeface(src.family, (style & 1) !== 0, (style & 2) !== 0));
  },
  "nativeCreateFromTypefaceWithVariation(JLjava/util/List;)J": (h: bigint) => handle(deref<JTypeface>(h) ?? tfDefault),
  "nativeCreateWeightAlias(JI)J": (h: bigint, weight: number) => {
    const src = deref<JTypeface>(h) ?? tfDefault;
    return handle(mkTypeface(src.family, src.bold, src.italic, weight));
  },
  "nativeGetStyle(J)I": (h: bigint) => (deref<JTypeface>(h) ?? tfDefault).style(),
  "nativeGetWeight(J)I": (h: bigint) => (deref<JTypeface>(h) ?? tfDefault).weight,
  "nativeGetReleaseFunc()J": () => FINALIZER,
  "nativeCreateFromTypefaceWithExactStyle(JIZ)J": (h: bigint, weight: number, italic: number) => {
    const src = deref<JTypeface>(h) ?? tfDefault;
    return handle(mkTypeface(src.family, weight >= 600, !!italic, weight));
  },
  // a family built from font handles: we have the browser's faces, not font files, so the
  // family it resolves to is whatever the first face named
  "nativeCreateFromArray([JJII)J": (_fonts: BigInt64Array, fallback: bigint) => handle(deref<JTypeface>(fallback) ?? tfDefault),
  // the serialised typeface cache a process shares with the system; there is no other process
  "nativeReadTypefaces(Ljava/nio/ByteBuffer;I)[J": () => null,
  ...stubs(null, "nativeGetSupportedAxes(J)[I"),
  ...noops("nativeSetDefault(J)V", "nativeRegisterGenericFamily(Ljava/lang/String;J)V",
    "nativeRegisterLocaleList(Ljava/lang/String;)V", "nativeAddFontCollections(J)V",
    "nativeWarmUpCache(Ljava/lang/String;)V"),
  ...stubs(0, "nativeWriteTypefaces(Ljava/nio/ByteBuffer;I[J)I"),
  // Typeface.DEFAULT and friends are set through this from the static initialiser
  "nativeForceSetStaticFinalField(Ljava/lang/String;Landroid/graphics/Typeface;)V": () => {},
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
  ...noops("nSetDither(JZ)V", "nSetFilterBitmap(JZ)V", "nSetLinearText(JZ)V", "nSetSubpixelText(JZ)V", "nSetHinting(JI)V"),
  ...stubs(1, "nGetHinting(J)I"),

  // effects: each returns the native handle it was given, which is what Paint stores back
  "nSetShader(JJ)J": (h: bigint, sh: bigint) => { paint(h).shaderObj = deref(sh) ?? null; return sh; },
  "nSetColorFilter(JJ)J": (h: bigint, f: bigint) => f,
  "nSetMaskFilter(JJ)J": (_h: bigint, f: bigint) => f,
  "nSetPathEffect(JJ)J": (_h: bigint, f: bigint) => f,

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
  "nGetFontMetrics(JLandroid/graphics/Paint$FontMetrics;Z)F": (h: bigint, fm: Metrics) => fillFontMetrics(paint(h), fm, false),
  "nGetFontMetricsInt(JLandroid/graphics/Paint$FontMetricsInt;Z)I": (h: bigint, fm: Metrics) => fillFontMetrics(paint(h), fm, true),
  // the per-run forms answer for one text run; with one font for everything, the run does
  // not change the answer, so they are the whole-paint metrics
  "nGetFontMetricsIntForText(J[CIIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _c: Uint16Array, _a: number, _b: number, _d: number, _e: number, _f: number, fm: Metrics) => fillFontMetrics(paint(h), fm, true),
  "nGetFontMetricsIntForText(JLjava/lang/String;IIIIZLandroid/graphics/Paint$FontMetricsInt;)V": (h: bigint, _s: string, _a: number, _b: number, _d: number, _e: number, _f: number, fm: Metrics) => fillFontMetrics(paint(h), fm, true),

  "nGetTextAdvances(J[CIIIII[FI)F": (h: bigint, c: Uint16Array, i: number, n: number, _ci: number, _cc: number, _f: number, adv: Float32Array | null, ai: number) =>
    advanceRun(paint(h), charsToString(c, i, n), adv, ai),
  "nGetTextAdvances(JLjava/lang/String;IIIII[FI)F": (h: bigint, s: string, a: number, b: number, _ci: number, _cc: number, _f: number, adv: Float32Array | null, ai: number) =>
    advanceRun(paint(h), s.slice(a, b), adv, ai),
  "nGetRunAdvance(J[CIIIIZI)F": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number) =>
    measureText(paint(h), charsToString(c, start, Math.max(0, Math.min(offset, end) - start))),
  "nGetRunCharacterAdvance(J[CIIIIZI[FILandroid/graphics/RectF;)F": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number, adv: Float32Array | null, ai: number) =>
    runCharacterAdvance(paint(h), c, start, end, offset, adv, ai),
  "nGetRunCharacterAdvance(J[CIIIIZI[FILandroid/graphics/RectF;Landroid/graphics/Paint$RunInfo;)F": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, offset: number, adv: Float32Array | null, ai: number) =>
    runCharacterAdvance(paint(h), c, start, end, offset, adv, ai),
  "nGetOffsetForAdvance(J[CIIIIZF)I": (h: bigint, c: Uint16Array, start: number, end: number, _cs: number, _ce: number, _rtl: number, advance: number) => {
    const p = paint(h);
    let w = 0;
    for (let i = start; i < end; i++) {
      const cw = measureText(p, charsToString(c, i, 1));
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
    breakText(paint(h), charsToString(c, i, Math.abs(n)), n >= 0, maxWidth, measured),
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
  "nGetFillPath(JJJ)Z": (_h: bigint, src: bigint, dst: bigint) => {
    const d = deref<JPath>(dst);
    d.ops = copyOps(src);
    d.dirty = true;
    return 1;
  },

  // state we accept and do not act on: one font, one locale, no hyphenation
  ...noops("nSetElegantTextHeight(JI)V", "nSetStartHyphenEdit(JI)V", "nSetEndHyphenEdit(JI)V",
    "nSetWordSpacing(JF)V", "nSetTextScaleX(JF)V", "nSetTextSkewX(JF)V",
    "nSetXfermode(JI)V", "nSetShadowLayer(JFFFJJ)V", "nGetTextPath(JILjava/lang/String;IIFFJ)V",
    "nSetTextLocalesByMinikinLocaleListId(JI)V", "nSetFontFeatureSettings(JLjava/lang/String;)V"),
  ...stubs(0, "nGetElegantTextHeight(J)I", "nGetStartHyphenEdit(J)I", "nGetEndHyphenEdit(J)I",
    "nGetWordSpacing(J)F", "nGetTextSkewX(J)F", "nHasShadowLayer(J)Z", "nSetTextLocales(JLjava/lang/String;)I"),
  ...stubs(1, "nGetTextScaleX(J)F", "nHasGlyph(JILjava/lang/String;)Z"),
});

interface Metrics { top: number; ascent: number; descent: number; bottom: number; leading: number }
const cursor = (offset: number, opt: number) =>
  opt === 0 || opt === 2 ? Math.max(0, offset - 1) : opt === 1 || opt === 3 ? offset + 1 : offset;

function runCharacterAdvance(p: JPaint, c: Uint16Array, start: number, end: number, offset: number, adv: Float32Array | null, ai: number): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    const w = measureText(p, charsToString(c, i, 1));
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
const copyOps = (h: bigint) => path(h).ops.map((op) => [...op] as typeof op);
const clearPath = (h: bigint) => { const p = path(h); p.ops = []; p.dirty = true; };

/** AOSP's Path$Direction is CW=0/CCW=1; ours carries the same ordinal through the op list */
delegate("android/graphics/Path", {
  "nInit()J": () => handle(new JPath()),
  "nInit(J)J": (h: bigint) => {
    const p = new JPath();
    copyPath.call(p, path(h));
    return handle(p);
  },
  "nGetFinalizer()J": () => FINALIZER,
  "nReset(J)V": clearPath,
  "nRewind(J)V": clearPath,
  "nSet(JJ)V": (h: bigint, s: bigint) => copyPath.call(path(h), path(s)),
  "nIsEmpty(J)Z": (h: bigint) => (path(h).ops.length ? 0 : 1),
  "nGetGenerationID(J)I": (h: bigint) => path(h).ops.length,

  "nMoveTo(JFF)V": (h: bigint, x: number, y: number) => { const p = path(h); p.add(["m", x, y]); p.curX = x; p.curY = y; },
  "nLineTo(JFF)V": (h: bigint, x: number, y: number) => { const p = path(h); p.add(["l", x, y]); p.curX = x; p.curY = y; },
  "nQuadTo(JFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number) => {
    const p = path(h); p.add(["q", x1, y1, x2, y2]); p.curX = x2; p.curY = y2;
  },
  "nCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => {
    const p = path(h); p.add(["c", a, b, c, d, e, f]); p.curX = e; p.curY = f;
  },
  "nConicTo(JFFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number, w: number) => path(h).conicTo(x1, y1, x2, y2, w),
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
  "nRConicTo(JFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, w: number) => path(h).conicTo(a, b, c, d, w, true),
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
  "nAddPath(JJ)V": (h: bigint, o: bigint) => appendPath(path(h), path(o)),
  "nAddPath(JJFF)V": (h: bigint, o: bigint, dx: number, dy: number) => appendPath(path(h), path(o), [1, 0, 0, 1, dx, dy]),
  "nAddPath(JJJ)V": (h: bigint, o: bigint, mat: bigint) => appendPath(path(h), path(o), affineOf(matrix(mat))),

  "nOffset(JFF)V": (h: bigint, dx: number, dy: number) => pathOffset(path(h), dx, dy),
  "nTransform(JJ)V": (h: bigint, mat: bigint) => pathTransform(path(h), affineOf(matrix(mat))),
  "nTransform(JJJ)V": (h: bigint, mat: bigint, dst: bigint) => {
    const d = path(dst);
    d.ops = copyOps(h);
    pathTransform(d, affineOf(matrix(mat)));
  },
  "nComputeBounds(JLandroid/graphics/RectF;)V": (h: bigint, r: Rect) => pathBounds(path(h), r),
  "nSetFillType(JI)V": (h: bigint, ft: number) => { path(h).fillRule = ft === 1 || ft === 3 ? "evenodd" : "nonzero"; },
  "nGetFillType(J)I": (h: bigint) => (path(h).fillRule === "evenodd" ? 1 : 0),

  "nIsRect(JLandroid/graphics/RectF;)Z": (h: bigint, r: Rect) => {
    const p = path(h);
    if (p.ops.length !== 1 || p.ops[0][0] !== "rect") return 0;
    pathBounds(p, r);
    return 1;
  },
  ...noops("nIncReserve(JI)V"),
  "nIsConvex(J)Z": (h: bigint) => pathIsConvex(path(h)),
  ...stubs(0, "nIsInterpolatable(JJ)Z", "nInterpolate(JJFJ)Z", "nOp(JJIJ)Z"),
  "nApproximate(JF)[F": () => new Float32Array(0),
});


// ── android.graphics.Canvas / BaseCanvas ───────────────────────────────────────────────
// Every one of these routes into canvasMethods, which is the table our own Canvas native
// already uses: one copy of each draw body, reached under two sets of names.
const canvas = (h: bigint) => deref<JCanvas>(h);
/** one of our own native method bodies, by its Java descriptor */
function specFn<T>(table: Record<string, unknown> | undefined, what: string, desc: string) {
  const fn = table?.[desc];
  if (typeof fn !== "function") throw new Error(`delegates: no ${what}[${desc}]`);
  return fn as (this: T, ...a: never[]) => unknown;
}
const cm = (desc: string) => specFn<JCanvas>(canvasMethods, "canvasMethods", desc);
const on = (desc: string) => {
  const fn = cm(desc);
  return (h: bigint, ...a: unknown[]) => (fn as (...x: unknown[]) => unknown).apply(canvas(h), a);
};
const optPaint = (pt: bigint) => (pt ? paint(pt) : null);
/** the trailing paint handle every nDraw* carries has to become the paint itself */
const withPaint = (desc: string, arity: number) => {
  const fn = cm(desc);
  return (h: bigint, ...a: unknown[]) => { a[arity] = paint(a[arity] as bigint); return (fn as (...x: unknown[]) => unknown).apply(canvas(h), a); };
};

delegate("android/graphics/Canvas", {
  "nInitRaster(J)J": (b: bigint) => handle(bitmapCanvas(deref<JBitmap>(b))),
  "nGetNativeFinalizer()J": () => FINALIZER,
  "nSetBitmap(JJ)V": (h: bigint, b: bigint) => { replace(h, bitmapCanvas(deref<JBitmap>(b))); },
  "nGetWidth(J)I": (h: bigint) => canvas(h).w,
  "nGetHeight(J)I": (h: bigint) => canvas(h).h,

  "nSave(JI)I": on("save()I"),
  "nRestore(J)Z": (h: bigint) => { const c = canvas(h); if (c.saveCount <= 1) return 0; on("restore()V")(h); return 1; },
  "nRestoreToCount(JI)V": on("restoreToCount(I)V"),
  "nGetSaveCount(J)I": on("getSaveCount()I"),
  "nSaveLayer(JFFFFJ)I": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => on("saveLayer(FFFFLandroid/graphics/Paint;)I")(h, l, t, r, b, optPaint(p)),
  "nSaveLayerAlpha(JFFFFI)I": on("saveLayerAlpha(FFFFI)I"),
  // an unclipped layer is a plain save here: there is no clip to lift
  "nSaveUnclippedLayer(JIIII)I": on("save()I"),
  "nRestoreUnclippedLayer(JIJ)V": (h: bigint, count: number) => on("restoreToCount(I)V")(h, count),

  "nTranslate(JFF)V": on("translate(FF)V"),
  "nScale(JFF)V": on("scale(FF)V"),
  "nRotate(JF)V": on("rotate(F)V"),
  "nSkew(JFF)V": on("skew(FF)V"),
  "nConcat(JJ)V": (h: bigint, m: bigint) => applyMatrix(canvas(h).ctx, matrix(m)),
  "nConcat(J[F)V": (h: bigint, v: Float32Array) => applyMatrix(canvas(h).ctx, v),
  "nSetMatrix(JJ)V": (h: bigint, m: bigint) => { if (m) applyMatrix(canvas(h).ctx, matrix(m), true); else canvas(h).ctx.setTransform(1, 0, 0, 1, 0, 0); },
  "nGetMatrix(JJ)V": (h: bigint, into: bigint) => {
    const t = canvas(h).ctx.getTransform();
    setAffine(matrix(into), t.a, t.b, t.c, t.d, t.e, t.f);
  },

  "nClipRect(JFFFFI)Z": (h: bigint, l: number, t: number, r: number, b: number, op: number) => on(op === 0 ? "clipOutRect(FFFF)Z" : "clipRect(FFFF)Z")(h, l, t, r, b),
  "nClipPath(JJI)Z": (h: bigint, p: bigint) => {
    const c = canvas(h), pp = deref<JPath>(p);
    c.ctx.clip(pp.path(), pp.fillRule);
    return 1;
  },
  "nGetClipBounds(JLandroid/graphics/Rect;)Z": on("getClipBounds(Landroid/graphics/Rect;)Z"),
  ...stubs(0, "nIsOpaque(J)Z", "nIsHighContrastText(J)Z", "nQuickReject(JFFFF)Z", "nQuickReject(JJ)Z"),
  ...noops("nSetCompatibilityVersion(I)V", "nSetDrawFilter(JJ)V", "nClipShader(JJI)V"),
  // nothing is cached natively, so there is nothing to free
  "nFreeCaches()V": () => {}, "nFreeTextLayoutCaches()V": () => {},
});

const drawText = (h: bigint, s: string, x: number, y: number, pt: bigint) =>
  cm("drawText(Ljava/lang/String;FFLandroid/graphics/Paint;)V").call(canvas(h), s as never, x as never, y as never, paint(pt) as never);
delegate("android/graphics/BaseCanvas", {
  "nDrawColor(JII)V": (h: bigint, c: number) => on("drawColor(I)V")(h, c),
  "nDrawColor(JJJI)V": (h: bigint, _cs: bigint, c: bigint) => on("drawColor(I)V")(h, argbOfColorLong(c)),
  "nDrawPaint(JJ)V": (h: bigint, p: bigint) => on("drawPaint(Landroid/graphics/Paint;)V")(h, paint(p)),
  "nDrawRect(JFFFFJ)V": withPaint("drawRect(FFFFLandroid/graphics/Paint;)V", 4),
  "nDrawRoundRect(JFFFFFFJ)V": withPaint("drawRoundRect(FFFFFFLandroid/graphics/Paint;)V", 6),
  "nDrawCircle(JFFFJ)V": withPaint("drawCircle(FFFLandroid/graphics/Paint;)V", 3),
  "nDrawOval(JFFFFJ)V": withPaint("drawOval(FFFFLandroid/graphics/Paint;)V", 4),
  "nDrawArc(JFFFFFFZJ)V": withPaint("drawArc(FFFFFFZLandroid/graphics/Paint;)V", 7),
  "nDrawLine(JFFFFJ)V": withPaint("drawLine(FFFFLandroid/graphics/Paint;)V", 4),
  "nDrawPoint(JFFJ)V": withPaint("drawPoint(FFLandroid/graphics/Paint;)V", 2),
  "nDrawPath(JJJ)V": (h: bigint, p: bigint, pt: bigint) => cm("drawPath(Landroid/graphics/Path;Landroid/graphics/Paint;)V").call(canvas(h), deref<JPath>(p) as never, paint(pt) as never),
  "nDrawLines(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, count: number, pt: bigint) =>
    cm("drawLines([FIILandroid/graphics/Paint;)V").call(canvas(h), pts as never, off as never, count as never, paint(pt) as never),
  "nDrawPoints(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, count: number, pt: bigint) =>
    cm("drawPoints([FIILandroid/graphics/Paint;)V").call(canvas(h), pts as never, off as never, count as never, paint(pt) as never),
  "nDrawText(JLjava/lang/String;IIFFIJ)V": (h: bigint, s: string, start: number, end: number, x: number, y: number, _f: number, pt: bigint) => drawText(h, s.slice(start, end), x, y, pt),
  "nDrawText(J[CIIFFIJ)V": (h: bigint, c: Uint16Array, i: number, n: number, x: number, y: number, _f: number, pt: bigint) => drawText(h, charsToString(c, i, n), x, y, pt),
  "nDrawTextRun(JLjava/lang/String;IIIIFFZJ)V": (h: bigint, s: string, start: number, end: number, _cs: number, _ce: number, x: number, y: number, _rtl: number, pt: bigint) =>
    drawText(h, s.slice(start, end), x, y, pt),
  "nDrawTextRun(J[CIIIIFFZJJ)V": (h: bigint, c: Uint16Array, i: number, n: number, _cs: number, _cc: number, x: number, y: number, _rtl: number, pt: bigint) =>
    drawText(h, charsToString(c, i, n), x, y, pt),
  "nDrawBitmap(JJFFJIII)V": (h: bigint, b: bigint, x: number, y: number, pt: bigint) =>
    cm("drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V").call(canvas(h), deref<JBitmap>(b) as never, x as never, y as never, optPaint(pt) as never),
  "nDrawBitmap(JJFFFFFFFFJII)V": (h: bigint, b: bigint, sl: number, st: number, sr: number, sb: number, dl: number, dt: number, dr: number, db: number, pt: bigint) =>
    cm("drawBitmap(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/RectF;Landroid/graphics/Paint;)V")
      .call(canvas(h), deref<JBitmap>(b) as never, rect(sl, st, sr, sb) as never, rect(dl, dt, dr, db) as never, optPaint(pt) as never),
  "nDrawBitmapMatrix(JJJJ)V": (h: bigint, b: bigint, m: bigint, pt: bigint) => {
    const c = canvas(h);
    c.ctx.save();
    applyMatrix(c.ctx, matrix(m));
    cm("drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V")
      .call(c, deref<JBitmap>(b) as never, 0 as never, 0 as never, optPaint(pt) as never);
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
    cm("drawBitmap(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V").call(canvas(h), b as never, x as never, y as never, optPaint(pt) as never);
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
      .call(canvas(h), deref<JBitmap>(b) as never, null as never, rect(l, t, r, bo) as never, optPaint(pt) as never),
  // positioned glyph ids, which only a shaping engine produces: there is none behind
  // Canvas2D, and the text entry points above are what the framework actually uses
  "nDrawGlyphs(J[I[FIIIJJ)V": () => {},
  // text on a path, meshes, vertices and regions have no Canvas2D form; a hole punched in a
  // surface is a compositor operation there is no surface for
  ...noops("nDrawTextOnPath(J[CIIJFFIJ)V", "nDrawTextOnPath(JLjava/lang/String;JFFIJ)V",
    "nDrawBitmapMesh(JJII[FI[IIJ)V", "nDrawMesh(JJIJ)V", "nDrawVertices(JII[FI[FI[II[SIIJ)V",
    "nDrawRegion(JJJ)V", "nPunchHole(JFFFFFFF)V"),
});

/** a Canvas over a bitmap's backing context, as Canvas(Bitmap) makes one */
function bitmapCanvas(b: JBitmap | undefined): JCanvas {
  const c = new JCanvas();
  setCanvasBitmap(c, b ?? null);
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

// ── android.graphics.text: MeasuredText and LineBreaker ────────────────────────────────
// StaticLayout and Layout declare ZERO natives, so real AOSP line breaking is what these two
// buy: everything above them is pure Java that already runs. The parameter meanings are not
// guessable from the descriptors — nAddStyleRun is (builder, paint, lineBreakStyle,
// lineBreakWordStyle, hyphenation, start, end, isRtl) — so they came out of appendStyleRun's
// and computeLineBreaks' own bytecode, off the register moves into each range invoke.
//
// The breaking itself is linebreak.ts's breakLines, the body JLayout uses, so AOSP's Layout and
// ours agree by construction rather than by two implementations happening to match. Only the
// greedy strategy exists; AOSP's balanced and optimal ones are not implemented.
interface Run { start: number; end: number; paint: JTextPaint }
interface Meas { text: string; runs: Run[] }
interface Breaks { lines: TLine[]; asc: number; desc: number }

const meas = (h: bigint) => deref<Meas>(h);
/** the paint covering `at`, or the paragraph's first — one paint per paragraph is the common
 *  case, and a run-aware breaker is what AOSP's own is, not what breakLines is */
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
    // newline included. breakLines splits on "\n" itself (JLayout gives it whole text), so
    // the newline has to come off first or every paragraph gains an empty line after it — and
    // the last break offset still has to cover it, because that is where the next paragraph
    // starts and minikin reports the same.
    const full = charsToString(chars, 0, len);
    const body = full.endsWith("\n") ? full.slice(0, -1) : full;
    const lines = p ? breakLines(body, p, { width: restWidth, firstWidth, firstCount }) : [];
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
// A property is ABSENT unless the device profile (src/shell/config.ts) answers it, so other reads
// get the caller's own default — which is what a device that has not set one reports, and is the
// difference between "this device does not do that" and a made-up answer a library will branch
// on. An app process may not set properties, and a change report runs the registered callbacks,
// as the property service's own notification does.
const deviceProperties: Record<string, () => string> = { "persist.sys.timezone": () => device.timezone };
delegate("android/os/SystemProperties", {
  "native_get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (key: string, def: string | null) => deviceProperties[key]?.() ?? def ?? "",
  "native_get_boolean(Ljava/lang/String;Z)Z": (_k: string, def: number) => def,
  "native_get_int(Ljava/lang/String;I)I": (_k: string, def: number) => def,
  "native_get_long(Ljava/lang/String;J)J": (_k: string, def: bigint) => def,
  "native_set(Ljava/lang/String;Ljava/lang/String;)V": () => {
    throw rt.mkThrowable("java/lang/RuntimeException", "failed to set system property (check logcat for reason)");
  },
  "native_add_change_callback()V": () => {},
  // reached only from SystemProperties itself, which is therefore initialized
  "native_report_sysprop_change()V": () => vcall(rt.link("android/os/SystemProperties").ctor, "callChangeCallbacks", "()V"),
});

/** What ZygoteInit.zygoteInit sets up in a forked process before app code runs: System.out and
 *  System.err reach logcat, the default time zone follows persist.sys.timezone, and
 *  java.util.logging reaches logcat. */
export async function zygoteInit(): Promise<void> {
  await scall("com/android/internal/os/RuntimeInit", "redirectLogStreams", "()V");
  const hooks = rt.link("dalvik/system/RuntimeHooks");
  await rt.initClass(hooks);
  await vcall(hooks.ctor, "setTimeZoneIdSupplier", "(Ljava/util/function/Supplier;)V", lambda("Supplier", deviceProperties["persist.sys.timezone"]));
  await vcall(await scall("java/util/logging/LogManager", "getLogManager", "()Ljava/util/logging/LogManager;"), "reset", "()V");
  await newObj("com/android/internal/logging/AndroidConfig", "()V");
}

// ── android.graphics.Bitmap ────────────────────────────────────────────────────────────
// The handle is a JBitmap. Several of these build the Java object rather than returning a
// handle, so they construct AOSP's own Bitmap through its (nativePtr, w, h, density, mutable,
// ninePatchChunk, insets) constructor — which makes them async.
//
// JBitmap.config uses AOSP's native config numbering, not Bitmap.Config's ordinal.
const bmp = (h: bigint) => deref<JBitmap>(h);
const bmf = (desc: string) => specFn<JBitmap>(bitmapMethods, "bitmapMethods", desc);
/** the Java Bitmap around one of ours */
const wrap = (b: JBitmap) =>
  newObj("android/graphics/Bitmap", "(JIIIZ[BLandroid/graphics/NinePatch$InsetStruct;)V",
    handle(b), b.w, b.h, b.density, b.immutable ? 0 : 1, null, null);
const copyOf = (src: JBitmap) => {
  const b = JBitmap.create(src.w, src.h);
  b.density = src.density; b.hasAlpha = src.hasAlpha; b.premultiplied = src.premultiplied; b.config = src.config;
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
  "nativeExtractAlpha(JJ[I)Landroid/graphics/Bitmap;": (h: bigint, paint: bigint, offsetXY: Int32Array | null) =>
    wrap(extractBitmapAlpha(bmp(h), paint ? deref<JPaint>(paint) : null, offsetXY)),

  "nativeRecycle(J)V": (h: bigint) => { bmp(h).recycled = true; },
  "nativeGetNativeFinalizer()J": () => FINALIZER,
  "nativeGenerationId(J)I": (h: bigint) => bmp(h).genId,
  "nativeConfig(J)I": (h: bigint) => bmp(h).config,
  "nativeRowBytes(J)I": (h: bigint) => bmp(h).rowBytes,
  "nativeGetAllocationByteCount(J)I": (h: bigint) => bmp(h).rowBytes * bmp(h).h,
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
  // a device's shared-memory and HDR allocators, and the gainmap that rides on one: absent
  // here, and a caller discovers that the way it would on a device without them
  "nativeGetAshmemFD(J)I": () => -1,
  ...noops("nativePrepareToDraw(J)V", "nativeSetColorSpace(JJ)V", "nativeSetGainmap(JJ)V"),
  ...stubs(0, "nativeIsSRGBLinear(J)Z", "nativeIsBackedByAshmem(J)Z", "nativeHasGainmap(J)Z"),
  ...stubs(null, "nativeComputeColorSpace(J)Landroid/graphics/ColorSpace;",
    "nativeExtractGainmap(J)Landroid/graphics/Gainmap;", "nativeGetHardwareBuffer(J)Landroid/hardware/HardwareBuffer;",
    "nativeWrapHardwareBufferBitmap(Landroid/hardware/HardwareBuffer;J)Landroid/graphics/Bitmap;"),
});
