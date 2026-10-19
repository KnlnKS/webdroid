// AOSP's own native methods, implemented over what we already have.
//
// This is the other side of provenance (src/jvm/provenance.ts). A class served by AOSP
// bytecode keeps its Java half and loses its native half, and these are the native halves:
// `Color.nativeRGBToHSV(III[F)V`, `Path.nAddRect(JFFFFI)V` — the exact descriptors the
// framework's own bytecode calls, registered through rt.registerJnis.
//
// The `long` a framework class holds in mNativePtr is a handle (handles.ts): framework Java owns
// the handle, we own the object.
//
// Nothing in this file is written from a list. `pnpm fwtest` runs the real bytecode with
// our specs withheld and reports what it reached and could not find; every delegate below is
// there because that said so.

import { startMainLooper } from "./mainloop.ts";
import { rt, noops, declaredField, waits, type Gen } from "../jvm/runtime.ts";
import { handle, weakHandle, ownedHandle, deref, release, take, FINALIZER } from "./handles.ts";
import { edges, setEdges, emptyBox, NativeColorFilter, BLEND_MODES, type NativeShader, NativeBitmapShader, gradient, scratch2d, composeShader } from "./graphics.ts";
import { Camera3D, identity, applyMatrix, matrixAt, localMatrix } from "./matrix.ts";
import { RuntimeShaderBuilder } from "./runtime-shader.ts";
import { paintAt, preloadPaint, setFontMetrics } from "./paint.ts";
import { initDeviceLocales } from "./resnative.ts";
import { NativeCanvas, drawingCanvas } from "./canvas.ts";
import { glyphBounds } from "./shaping.ts";
import { type NativeBitmap, colorLongAt } from "./bitmap.ts";
import { vcall, scall, after, callOn, mainThread, initClass, linkClass } from "../jvm/natives/jentry.ts";
import { asZygote } from "./os.ts";
import { hasProperty, propertyValue as propValue } from "../shell/properties.ts";
import { NativePath, PathMeasure, VerbIterator, approximate, pathIsConvex, pathOp, pathAt } from "./path.ts";
import { NativeRegion, nativeRegionOf } from "./region.ts";
import { Recorder, recordOrRun, replay, replayFor, type DisplayList } from "./recording.ts";
import { type JBuffer, readOnlyBuffer, addressOf, isExternal, readBufferBytes, writeBufferBytes } from "../jvm/natives/jnio.ts";
import {
  type Axis, NativeFont, NativeFamily, type NativeTypeface, availableFonts, addFontCollections, warmUpCache, isPlatformFont,
  resolveDefault, setDefaultTypeface, preloadFonts, withFonts, writeTypefaces, readTypefaces,
  createRelative, createAbsolute, createWithBaseWeight, createWithVariation, createFromFamilies, fontOf, wrapFont,
} from "./fonts.ts";
import { sfntTables, T_CMAP, fontRevision, postScriptName, isPostScriptType1 } from "./sfnt.ts";

const delegate = rt.registerJnis.bind(rt);

// libcore's NativeAllocationRegistry runs as its bytecode; the Cleaner it registers for each
// allocation frees it through the class's free function, a handle here (handles.ts)
delegate("libcore/util/NativeAllocationRegistry", { "applyFreeFunction(JJ)V": (fn: bigint, ptr: bigint) => { deref<(p: bigint) => void>(fn)?.(ptr); } });

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

// ── ColorFilter and Shader: the native instances a native paint draws with ───────────────────
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
/** a gradient's ColorLongs, which Shader requires to share the space handle `cs` names, as sRGB ARGB */
const stopColors = (colors: BigInt64Array, cs: bigint) => Int32Array.from(colors, (c) => colorLongAt(c, cs));
delegate("android/graphics/LinearGradient", {
  "nativeCreate(JFFFF[J[FIJ)J": (m: bigint, x0: number, y0: number, x1: number, y1: number, colors: BigInt64Array, positions: Float32Array | null, _tile: number, cs: bigint) =>
    handle(gradient(localMatrix(m), scratch2d().createLinearGradient(x0, y0, x1, y1), stopColors(colors, cs), positions)),
});
delegate("android/graphics/RadialGradient", {
  "nativeCreate(JFFFFFF[J[FIJ)J": (m: bigint, fx: number, fy: number, fr: number, x: number, y: number, r: number, colors: BigInt64Array, positions: Float32Array | null, _tile: number, cs: bigint) =>
    handle(gradient(localMatrix(m), scratch2d().createRadialGradient(fx, fy, fr, x, y, r), stopColors(colors, cs), positions)),
});
delegate("android/graphics/SweepGradient", {
  "nativeCreate(JFF[J[FJ)J": (m: bigint, cx: number, cy: number, colors: BigInt64Array, positions: Float32Array | null, cs: bigint) =>
    handle(gradient(localMatrix(m), scratch2d().createConicGradient(0, cx, cy), stopColors(colors, cs), positions)),
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
  "nativeUpdateShader(JLjava/lang/String;J)V": (b: bigint, name: string, shader: bigint) =>
    shaderBuilder(b).setChild(name, shader ? deref<NativeShader>(shader) : null),
  "nativeUpdateUniforms(JLjava/lang/String;[I)V": (b: bigint, name: string, values: Int32Array) =>
    shaderBuilder(b).set(name, values, false, true),
});

// ── android.graphics.Typeface ──────────────────────────────────────────────────────────
// hwui's Typeface over fonts.ts' collections; a null handle is the default, as resolveDefault has it
const typefaceAt = (h: bigint) => resolveDefault(h ? deref<NativeTypeface>(h) : null);
delegate("android/graphics/Typeface", {
  "nativeGetReleaseFunc()J": () => FINALIZER,
  "nativeCreateFromTypeface(JI)J": (h: bigint, style: number) => handle(createRelative(typefaceAt(h), style)),
  "nativeCreateFromTypefaceWithExactStyle(JIZ)J": (h: bigint, weight: number, italic: number) => handle(createAbsolute(typefaceAt(h), weight, !!italic)),
  "nativeCreateFromTypefaceWithVariation(JLjava/util/List;)J": (h: bigint, axes: object) => after(createWithVariation(typefaceAt(h), axes), handle),
  "nativeCreateWeightAlias(JI)J": (h: bigint, weight: number) => handle(createWithBaseWeight(typefaceAt(h), weight)),
  "nativeCreateFromArray([JJII)J": (families: BigInt64Array, fallback: bigint, weight: number, italic: number) =>
    withFonts(() => handle(createFromFamilies(Array.from(families, (h) => deref<NativeFamily>(h)), weight, italic, fallback ? deref<NativeTypeface>(fallback) : null))),
  "nativeGetStyle(J)I": (h: bigint) => deref<NativeTypeface>(h).apiStyle,
  "nativeGetWeight(J)I": (h: bigint) => deref<NativeTypeface>(h).weight,
  "nativeGetSupportedAxes(J)[I": (h: bigint) => {
    const axes = deref<NativeTypeface>(h).collection.supportedAxes;
    return axes.length ? Int32Array.from(axes) : null;
  },
  "nativeSetDefault(J)V": (h: bigint) => { setDefaultTypeface(deref<NativeTypeface>(h)); },
  // DEFAULT and the other constants are static finals setSystemFontMap assigns
  "nativeForceSetStaticFinalField(Ljava/lang/String;Landroid/graphics/Typeface;)V": (name: string, t: object) => {
    linkClass("android/graphics/Typeface").setStatic(name, t, "Landroid/graphics/Typeface;");
  },
  // the system collections make up the available font set; minikin's registry of locale lists
  // serves its own lookups, which paint.ts keeps
  "nativeRegisterGenericFamily(Ljava/lang/String;J)V": (_name: string, h: bigint) => addFontCollections(typefaceAt(h)),
  "nativeAddFontCollections(J)V": (h: bigint) => addFontCollections(typefaceAt(h)),
  ...noops("nativeRegisterLocaleList(Ljava/lang/String;)V"),
  "nativeWarmUpCache(Ljava/lang/String;)V": waits((path: string) => warmUpCache(path)),
  // the font map the system server serializes for applications (Typeface.serializeFontMap)
  "nativeReadTypefaces(Ljava/nio/ByteBuffer;I)[J": waits((b: JBuffer, at: number) =>
    after(readBufferBytes(b, at), bytes => BigInt64Array.from(readTypefaces(bytes), handle))),
  "nativeWriteTypefaces(Ljava/nio/ByteBuffer;I[J)I": waits((b: JBuffer | null, at: number, typefaces: BigInt64Array) => {
    const bytes = writeTypefaces(Array.from(typefaces, (h) => deref<NativeTypeface>(h)));
    return b ? after(writeBufferBytes(b, bytes, at), () => bytes.length) : bytes.length;
  }),
});

// ── android.graphics.fonts ─────────────────────────────────────────────────────────────
// minikin's Font and FontFamily are fonts.ts' NativeFont and NativeFamily.
/** a direct buffer's bytes, as GetDirectBufferAddress and GetDirectBufferCapacity see them;
 *  guest memory can move, so bytes there are copied */
function directBytes<T>(b: JBuffer | null, then: (bytes: Uint8Array) => T): T | Promise<T> {
  if (!b) rt.npe();
  const address = addressOf(b!);
  if (!address) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a direct buffer");
  return after(readBufferBytes(b!), bytes => then(isExternal(address) ? bytes : bytes.slice()));
}
const PACKED_ITALIC = 1 << 16;
delegate("android/graphics/fonts/Font$Builder", {
  "nInitBuilder()J": () => handle({ axes: [] as Axis[] }),
  "nAddAxis(JIF)V": (b: bigint, tag: number, value: number) => { deref<{ axes: Axis[] }>(b).axes.push({ tag, value }); },
  "nBuild(JLjava/nio/ByteBuffer;Ljava/lang/String;Ljava/lang/String;IZI)J": waits((b: bigint, buffer: JBuffer | null, path: string, locales: string, weight: number, italic: number, ttcIndex: number) => {
    const { axes } = take<{ axes: Axis[] }>(b);
    // a system font is the mapping of its file: its glyphs load when first shaped or drawn
    if (buffer && isExternal(addressOf(buffer)) && isPlatformFont(path)) return wrapFont(NativeFont.platform(path, ttcIndex, weight, !!italic, axes, locales));
    return directBytes(buffer, (bytes) => {
      const font = NativeFont.of(bytes, ttcIndex, weight, !!italic, axes, path, locales);
      // what FreeType cannot open as a face (no head or hhea) Skia makes no typeface of
      if (!font.faceMetrics) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Failed to create internal object. maybe invalid font data.");
      return wrapFont(font);
    });
  }),
  // Skia's makeClone over the same data: new axes, style and collection index
  "nClone(JJIZI)J": (font: bigint, b: bigint, weight: number, italic: number, ttcIndex: number) => {
    const { axes } = take<{ axes: Axis[] }>(b);
    return wrapFont(fontOf(font).clone(ttcIndex, weight, !!italic, axes));
  },
});
delegate("android/graphics/fonts/Font", {
  "nGetReleaseNativeFont()J": () => FINALIZER,
  "nCloneFont(J)J": (h: bigint) => wrapFont(fontOf(h)),
  "nNewByteBuffer(J)Ljava/nio/ByteBuffer;": (h: bigint) => withFonts(() => readOnlyBuffer(fontOf(h).bytes)),
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
  "nGetFontMetrics(JJLandroid/graphics/Paint$FontMetrics;)F": (h: bigint, p: bigint, fm: object | null) => {
    const m = fontOf(h).faceMetrics!;
    const size = paintAt(p).textSize, f = Math.fround;
    const ascent = f(-m.ascent * size), descent = f(m.descent * size), leading = f(m.leading * size);
    if (fm) setFontMetrics(fm, false, f(-m.top * size), ascent, descent, f(m.bottom * size), leading);
    return f(descent - ascent + leading);
  },
  "nGetGlyphBounds(JIJLandroid/graphics/RectF;)F": (h: bigint, glyph: number, p: bigint, rect: object | null) =>
    after(glyphBounds(fontOf(h), glyph, paintAt(p)), ([advance, box]) => { if (rect) setEdges(rect, box); return advance; }),
  "nGetAvailableFontSet()[J": () => BigInt64Array.from(availableFonts(), wrapFont),
});
delegate("android/graphics/fonts/FontFamily$Builder", {
  "nInitBuilder()J": () => handle({ fonts: [] as NativeFont[] }),
  "nAddFont(JJ)V": (b: bigint, font: bigint) => { deref<{ fonts: NativeFont[] }>(b).fonts.push(fontOf(font)); },
  // minikin rejects a family whose default face has no cmap (no coverage); system fonts have theirs
  "nBuild(JLjava/lang/String;IZZI)J": (b: bigint, langTags: string | null, variant: number) => {
    const family = new NativeFamily(take<{ fonts: NativeFont[] }>(b).fonts, langTags ?? "", variant), regular = family.closest(400, false);
    if (!isPlatformFont(regular.path) && !sfntTables(regular.bytes, regular.ttcIndex)?.at.has(T_CMAP)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Failed to create internal object. maybe invalid font data");
    return handle(family);
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
  "nGetFontRevision(Ljava/nio/ByteBuffer;I)J": waits((b: JBuffer | null, index: number) => directBytes(b, (bytes) => fontRevision(bytes, index))),
  "nGetFontPostScriptName(Ljava/nio/ByteBuffer;I)Ljava/lang/String;": waits((b: JBuffer | null, index: number) => directBytes(b, (bytes) => postScriptName(bytes, index))),
  "nIsPostScriptType1Font(Ljava/nio/ByteBuffer;I)I": waits((b: JBuffer | null, index: number) => directBytes(b, (bytes) => isPostScriptType1(bytes, index))),
});

// ── android.graphics.Path, PathMeasure and PathIterator ────────────────────────────────
// The geometry and Skia's rules for it live in path.ts, beside the bridge TS reaches it through.
const path = pathAt;
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
  "nAddPath(JJJ)V": (h: bigint, o: bigint, mat: bigint) => path(h).append(path(o), matrixAt(mat)),

  "nOffset(JFF)V": (h: bigint, dx: number, dy: number) => path(h).offset(dx, dy),
  "nTransform(JJ)V": (h: bigint, mat: bigint) => path(h).transform(matrixAt(mat)),
  // a null destination transforms in place
  "nTransform(JJJ)V": (h: bigint, mat: bigint, dst: bigint) => {
    const d = dst ? path(dst) : path(h);
    d.set(path(h));
    d.transform(matrixAt(mat));
  },
  "nComputeBounds(JLandroid/graphics/RectF;)V": (h: bigint, r: object) => setEdges(r, path(h).bounds()),
  "nIsRect(JLandroid/graphics/RectF;)Z": (h: bigint, r: object) => {
    const b = path(h).isRect();
    if (b) setEdges(r, b);
    return +!!b;
  },
  "nIsConvex(J)Z": (h: bigint) => (pathIsConvex(path(h)) ? 1 : 0),
  "nOp(JJIJ)Z": (a: bigint, b: bigint, op: number, dst: bigint) => after(pathOp(path(dst), path(a), path(b), op), (done) => +done),
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
  "native_getMatrix(JFJI)Z": (h: bigint, d: number, m: bigint, flags: number) => (measure(h).getMatrix(d, matrixAt(m), flags) ? 1 : 0),
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
  "nativeGetBounds(JLandroid/graphics/Rect;)Z": (h: bigint, r: object) => {
    const b = region(h).bounds();
    setEdges(r, b ?? emptyBox);
    return +!!b;
  },
  "nativeGetBoundaryPath(JJ)Z": (h: bigint, p: bigint) => +region(h).boundaryPath(path(p)),
  "nativeOp(JIIIII)Z": (h: bigint, l: number, t: number, r: number, b: number, op: number) => {
    scratch.setRect(l, t, r, b);
    return +region(h).op(region(h), scratch, op);
  },
  "nativeOp(JLandroid/graphics/Rect;JI)Z": (h: bigint, rect: object, other: bigint, op: number) => {
    const r = edges(rect);
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
    const b = nativeRegionOf(o).bounds();
    return +(!b || nativeRegionOf(this).quickReject(b.left, b.top, b.right, b.bottom));
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
  "nativeNext(JLandroid/graphics/Rect;)Z": (h: bigint, r: object) => {
    const it = deref<{ rects: number[]; at: number }>(h), { rects } = it;
    if (it.at >= rects.length) return 0;
    setEdges(r, { left: rects[it.at], top: rects[it.at + 1], right: rects[it.at + 2], bottom: rects[it.at + 3] });
    it.at += 4;
    return 1;
  },
});

// ── android.graphics.Camera: Sk3DView ──────────────────────────────────────────────────
// a Java Camera keeps its Sk3DView in native_instance, which its natives set and read themselves
let nativeInstance = "";
const instanceField = () => nativeInstance ||= declaredField("android/graphics/Camera", "native_instance");
const camera = (c: object) => deref<Camera3D>((c as Record<string, bigint>)[instanceField()]);
delegate("android/graphics/Camera", {
  "nativeConstructor()V": function (this: Record<string, bigint>) { this[instanceField()] = ownedHandle(new Camera3D()); },
  "nativeDestructor()V": function (this: Record<string, bigint>) { release(this[instanceField()]); },
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
  "nativeGetMatrix(J)V": function (this: object, m: bigint) { camera(this).matrix(matrixAt(m)); },
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

// ── android.graphics.Picture: a recorded display list ──────────────────────────────────
// The recording canvas records as a RenderNode's does, and drawing the picture replays it into
// the target canvas inside a save/restore, as SkRecordDraw does. SkPicture's serialized form
// (createFromStream, writeToStream) is not implemented.
class NativePicture {
  w = 0; h = 0;
  ops: DisplayList | null = null;
  /** while recording: what the PictureCanvas (which owns its handle) records into */
  recorder: Recorder | null = null;
  /** SkPictureRecorder::finishRecordingAsPicture: the list is the picture's, and the canvas records no more of it */
  endRecording() {
    if (!this.recorder) return;
    this.ops = this.recorder.take();
    this.recorder = null;
  }
}
const picture = (h: bigint) => deref<NativePicture>(h);
delegate("android/graphics/Picture", {
  // a copy of a picture still recording holds what was recorded so far
  "nativeConstructor(J)J": (src: bigint) => {
    const p = new NativePicture();
    if (src) { const s = picture(src); p.w = s.w; p.h = s.h; p.ops = s.recorder ? s.recorder.ops.slice() : s.ops; }
    return ownedHandle(p);
  },
  "nativeDestructor(J)V": (h: bigint) => { picture(h).endRecording(); release(h); },
  "nativeBeginRecording(JII)J": (h: bigint, w: number, ht: number) => {
    const p = picture(h);
    p.endRecording();
    p.w = w; p.h = ht; p.ops = null;
    p.recorder = new Recorder();
    return handle(NativeCanvas.over(p.recorder.ctx, w, ht));
  },
  "nativeEndRecording(J)V": (h: bigint) => picture(h).endRecording(),
  "nativeGetWidth(J)I": (h: bigint) => picture(h).w,
  "nativeGetHeight(J)I": (h: bigint) => picture(h).h,
  "nativeDraw(JJ)V": (c: bigint, h: bigint) => {
    const p = picture(h), cv = drawingCanvas(c);
    p.endRecording();
    const ops = p.ops;
    if (!ops) return;
    // into a recording canvas the replay is deferred to where that recording is drawn
    replayFor(cv, () => recordOrRun(cv.ctx, (ctx) => {
      ctx.save();
      try { replay(ctx, ops); } finally { ctx.restore(); }
    }));
  },
});

// ── android.os.SystemProperties ────────────────────────────────────────────────────────
// An app process may not set properties, and a change report runs the registered callbacks, as the
// property service's own notification does.
/** android_os_SystemProperties.cpp's readers: an absent or unparsable value is the default */
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
  "native_find(Ljava/lang/String;)J": (key: string) => hasProperty(key) ? handle({ key }) : 0n,
  "native_get(J)Ljava/lang/String;": (h: bigint) => propAt(h) ?? "",
  "native_get_boolean(JZ)Z": (h: bigint, def: number) => propBool(propAt(h), def),
  "native_get_int(JI)I": (h: bigint, def: number) => propInt(propAt(h), def),
  "native_get_long(JJ)J": (h: bigint, def: bigint) => propLong(propAt(h), def),
  "native_set(Ljava/lang/String;Ljava/lang/String;)V": () => {
    throw rt.mkThrowable("java/lang/RuntimeException", "failed to set system property (check logcat for reason)");
  },
  "native_add_change_callback()V": () => {},
  // reached only from SystemProperties itself, which is therefore initialized
  "native_report_sysprop_change()V": () => scall("android/os/SystemProperties", "callChangeCallbacks", "()V"),
});

/** What the zygote sets up in a forked process before app code runs: libcore's MIME table is
 *  framework.jar's, System.out and System.err reach logcat, RuntimeInit.commonInit's uncaught
 *  exception handlers (LoggingHandler, KillApplicationHandler), time zone, logging, HTTP user
 *  agent and socket tagger are set, the JCA providers are installed and warmed, Typeface is
 *  initialized and the hyphenators registered; the device's languages are set and the text paint
 *  classes, whose constructors read them, initialized. The font map is bindApplication's. */
export const zygoteInit = (): Promise<void> => (async () => callOn(mainThread, () => rt.drive(function* (): Gen<void> {
  // System.<clinit> reads user.name from the passwd entry of the zygote, which runs as root
  yield asZygote(() => initClass("java/lang/System"));
  // ZygoteInit.main: DDMS handlers and libcore's MimeMap over framework.jar's mime.types
  yield scall("com/android/internal/os/RuntimeInit", "preForkInit", "()V");
  yield scall("com/android/internal/os/RuntimeInit", "redirectLogStreams", "()V");
  // ZygoteInit.zygoteInit, in the forked process
  yield scall("com/android/internal/os/RuntimeInit", "commonInit", "()V");
  // ZygoteInit.preload: AndroidKeyStoreProvider installed, every provider's services resolved
  yield scall("com/android/internal/os/ZygoteInit", "warmUpJcaProviders", "()V");
  yield* preloadFonts();
  yield scall("com/android/internal/os/ZygoteInit", "preloadTextResources", "()V");
  yield initDeviceLocales();
  yield preloadPaint();
  // ActivityThread.main, once the process is forked
  yield startMainLooper();
}())))();
