// ColorFilter's native half: hwui's SkColorFilter, through which a paint's colour or a bitmap's
// pixels are drawn.

import { rt } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import type { NativeBitmap } from "./bitmap.ts";
import { COMPOSITE, BLEND_MODES, cssColor } from "./graphics.ts";

/**
 * A ColorFilter's native instance, as hwui builds its SkColorFilter: AOSP's row-major 4x5 colour
 * `matrix` with its offsets in 0..255 (SkColorFilters::Matrix and Lighting), or, when that is null,
 * `color` blended into what is drawn by the mode named `mode` (SkColorFilters::Blend).
 * The Lighting and ColorMatrix setters update `matrix` in place, and a paint holding it sees them.
 */
export class NativeColorFilter {
  readonly matrix: Float32Array | null; readonly color: number; readonly mode: string;
  /** the last colour a blend filtered and what it made: a paint asks for one colour draw after draw */
  private input = 0; private output: number | null = null;
  constructor(matrix: Float32Array | null, color = 0, mode = "DST") { this.matrix = matrix; this.color = color; this.mode = mode; }
  /** SkColorFilter::filterColor: `argb` through the filter, blended as recolor blends a bitmap */
  filter(argb: number): number {
    if (this.matrix) return matrixColor(this.matrix, argb);
    const tint = this.color, mode = this.mode;
    if (mode === "DST") return argb;
    // how Material tints every shape it draws: the filter's colour, keeping the alpha the two agree on
    if (mode === "SRC_IN") return ((tint & 0xffffff) | ((((tint >>> 24) * (argb >>> 24) / 255) | 0) << 24)) | 0;
    if (this.output === null || this.input !== argb) {
      const c = pixel ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
      c.globalCompositeOperation = "copy";
      c.fillStyle = cssColor(argb);
      c.fillRect(0, 0, 1, 1);
      c.globalCompositeOperation = "source-over";
      recolor(c, 1, 1, tint, null, mode);
      const d = c.getImageData(0, 0, 1, 1).data;
      this.input = argb;
      this.output = (d[3] << 24 | d[0] << 16 | d[1] << 8 | d[2]) | 0;
    }
    return this.output;
  }
}
let pixel: OffscreenCanvasRenderingContext2D | null = null;
const tintCache = new WeakMap<NativeBitmap, { generation: number; images: Map<number | string, OffscreenCanvas> }>();
/** `b` through a colour filter — `tint` blended by the BlendMode named `mode`, or every pixel through
 *  a 4x5 colour `matrix` — cached per (bitmap, filter); the bitmap itself when there is none */
export function tintedBmp(b: NativeBitmap, tint: number | null, matrix: Float32Array | null = null, mode = "SRC_IN"): CanvasImageSource {
  if (matrix === null && (tint === null || mode === "DST" || mode === "PLUS" && !(tint >>> 24))) return b.image;
  let cache = tintCache.get(b);
  if (!cache || cache.generation !== b.genId) tintCache.set(b, cache = { generation: b.genId, images: new Map() });
  const m = cache.images, key = matrix ? matrix.join(",") : `${mode}:${tint}`;
  let t = m.get(key);
  if (!t) {
    t = new OffscreenCanvas(b.w, b.h);
    const c = t.getContext("2d")!;
    c.drawImage(b.image, 0, 0);
    recolor(c, b.w, b.h, tint, matrix, mode);
    m.set(key, t);
  }
  return t;
}
/** a colour filter applied in place to the w x h pixels `c` holds at (x, y) */
export function recolor(c: OffscreenCanvasRenderingContext2D, w: number, h: number, tint: number | null, matrix: Float32Array | null, mode = "SRC_IN", x = 0, y = 0) {
  if (matrix) {
    const img = c.getImageData(x, y, w, h), d = img.data, k = matrix;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2], a = d[i + 3];
      d[i] = k[0] * r + k[1] * g + k[2] * bl + k[3] * a + k[4];
      d[i + 1] = k[5] * r + k[6] * g + k[7] * bl + k[8] * a + k[9];
      d[i + 2] = k[10] * r + k[11] * g + k[12] * bl + k[13] * a + k[14];
      d[i + 3] = k[15] * r + k[16] * g + k[17] * bl + k[18] * a + k[19];
    }
    c.putImageData(img, x, y);
  } else if (tint === null || mode === "DST") return;
  else if (mode === "CLEAR") c.clearRect(x, y, w, h);
  else if (mode === "MODULATE") {
    const img = c.getImageData(x, y, w, h), d = img.data;
    const r = (tint >>> 16 & 255) / 255, g = (tint >>> 8 & 255) / 255, blue = (tint & 255) / 255, alpha = (tint >>> 24) / 255;
    for (let i = 0; i < d.length; i += 4) { d[i] *= r; d[i + 1] *= g; d[i + 2] *= blue; d[i + 3] *= alpha; }
    c.putImageData(img, x, y);
  } else {
    const composite = COMPOSITE[mode];
    if (!composite) throw rt.mkThrowable("java/lang/UnsupportedOperationException", `bitmap tint mode ${mode}`);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = composite;
    c.fillStyle = cssColor(tint);
    c.fillRect(x, y, w, h);
    c.restore();
  }
}
/** an ARGB colour through a 4x5 colour matrix (channels 0..255, offsets as stored) */
export function matrixColor(k: Float32Array, color: number): number {
  const a = color >>> 24, r = (color >>> 16) & 255, g = (color >>> 8) & 255, b = color & 255;
  const clamp = (v: number) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  return ((clamp(k[15] * r + k[16] * g + k[17] * b + k[18] * a + k[19]) << 24) | (clamp(k[0] * r + k[1] * g + k[2] * b + k[3] * a + k[4]) << 16)
    | (clamp(k[5] * r + k[6] * g + k[7] * b + k[8] * a + k[9]) << 8) | clamp(k[10] * r + k[11] * g + k[12] * b + k[13] * a + k[14])) | 0;
}

// Lighting and ColorMatrix filters change their native instance in place.
const colorFilter = (h: bigint) => deref<NativeColorFilter>(h);
const blendFilter = (color: number, mode: number) => handle(new NativeColorFilter(null, color, BLEND_MODES[mode]));
/** SkColorFilters::Lighting: each RGB channel scaled by `mul`'s and offset by `add`'s */
const setMul = (k: Float32Array, mul: number) => { k[0] = (mul >>> 16 & 255) / 255; k[6] = (mul >>> 8 & 255) / 255; k[12] = (mul & 255) / 255; };
const setAdd = (k: Float32Array, add: number) => { k[4] = add >>> 16 & 255; k[9] = add >>> 8 & 255; k[14] = add & 255; };
rt.registerJnis("android/graphics/ColorFilter", { "nativeGetFinalizer()J": () => FINALIZER });
rt.registerJnis("android/graphics/PorterDuffColorFilter", { "native_CreateBlendModeFilter(II)J": blendFilter });
rt.registerJnis("android/graphics/BlendModeColorFilter", { "native_CreateBlendModeFilter(II)J": blendFilter });
rt.registerJnis("android/graphics/LightingColorFilter", {
  "native_CreateLightingFilter(II)J": (mul: number, add: number) => {
    const k = new Float32Array(20);
    k[18] = 1; setMul(k, mul); setAdd(k, add);
    return handle(new NativeColorFilter(k));
  },
  "native_SetLightingFilterMul(JI)V": (h: bigint, mul: number) => setMul(colorFilter(h).matrix!, mul),
  "native_SetLightingFilterAdd(JI)V": (h: bigint, add: number) => setAdd(colorFilter(h).matrix!, add),
});
rt.registerJnis("android/graphics/ColorMatrixColorFilter", {
  "nativeColorMatrixFilter([F)J": (k: Float32Array) => handle(new NativeColorFilter(k.slice(0, 20))),
  "nativeSetColorMatrix(J[F)V": (h: bigint, k: Float32Array) => colorFilter(h).matrix!.set(k.subarray(0, 20)),
});
