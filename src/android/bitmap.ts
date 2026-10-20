// android.graphics.Bitmap's native half: hwui's Bitmap and android_graphics_Bitmap.cpp.
//
// AOSP's Bitmap bytecode holds mNativePtr, a handle to a NativeBitmap: the geometry, the config in
// AOSP's legacy numbering (GraphicsJNI::LegacyBitmapConfig), the alpha type, immutability, the
// generation id and the pixels. Density and the nine-patch chunk are Java's (mDensity,
// mNinePatchChunk). TS reaches the native state of a Java Bitmap through bitmapOf, and makes a
// Java Bitmap around a native one with javaBitmap, as bitmap::createBitmap does.
//
// The pixels are straight (unpremultiplied) RGBA, as a 2D context's ImageData holds them, and a
// raster (OffscreenCanvas) is made only when something draws. What the pixel API writes goes
// through the bitmap's own storage format first (premultiplied 8888, 565, 4444, F16, ...), so
// reading it back gives what a device's memory would.

import { awaited, rt, type JObj, peerField, driven, waits, type Gen } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { newObj, scall, vcall, after } from "../jvm/natives/jentry.ts";
import { writeThrough } from "../jvm/natives/jio.ts";
import { type JBuffer, readBufferBytes, writeRemainingBytes, position, elementShift } from "../jvm/natives/jnio.ts";
import { u8 } from "../jvm/abi.ts";
import { paintAt } from "./paint.ts";
import { nativeParcel, createByteArray, outOfLine, readInt, writeByteArray, writeInt } from "./parcel.ts";
import { extractBitmapAlpha } from "./maskfilter.ts";

export const ALPHA_8 = 1, RGB_565 = 3, ARGB_4444 = 4, ARGB_8888 = 5, RGBA_F16 = 6, HARDWARE = 7, RGBA_1010102 = 8;
const BPP = [0, 1, 0, 2, 2, 4, 8, 4, 4];
export const bytesPerPixel = (config: number): number => BPP[config] ?? 4;
/** SkAlphaType */
export const OPAQUE = 1, PREMUL = 2, UNPREMUL = 3;
/** the alpha type a config can hold: 565 is always opaque, ALPHA_8 always premultiplied */
const alphaFor = (config: number, alphaType: number) => config === RGB_565 ? OPAQUE : config === ALPHA_8 ? PREMUL : alphaType;

let generation = 0;
/** SkNextID: generation ids are unique across bitmaps, as caches keyed on them assume */
const nextGeneration = () => (generation = (generation + 1) | 0) || (generation = 1);

export type RGBA = Uint8ClampedArray<ArrayBuffer>;
/** a ColorSpace.Rgb's native instance (delegates.ts): skcms' a..g and the D50 matrix, column-major */
interface NativeColorSpace { transfer: number[]; xyz: Float32Array }

export class NativeBitmap {
  w: number; h: number; config: number;
  rowBytes: number;
  /** bytes the pixels were allocated with, which reconfigure and inBitmap reuse may not exceed */
  allocation: number;
  alphaType: number;
  immutable = false; mipmap = false; recycled = false;
  genId = nextGeneration();
  /** the color space the pixels are tagged with; null is sRGB (none for ALPHA_8) */
  space: NativeColorSpace | null = null;
  private cv: OffscreenCanvas | null = null;
  private cx: OffscreenCanvasRenderingContext2D | null = null;
  private px: RGBA | null = null;
  /** a decoded image not yet drawn into a raster: drawing it needs no copy */
  private img: ImageBitmap | null = null;

  constructor(w: number, h: number, config = ARGB_8888, alphaType = PREMUL, rowBytes = w * bytesPerPixel(config)) {
    this.w = w; this.h = h; this.config = config;
    this.rowBytes = rowBytes;
    this.allocation = rowBytes * h;
    this.alphaType = alphaFor(config, alphaType);
  }
  get hasAlpha(): boolean { return this.alphaType !== OPAQUE; }
  /** drawn pixels exist (a raster or a decoded image), so a copy can be a draw rather than a readback */
  get rastered(): boolean { return !!(this.cv || this.img); }
  get premultiplied(): boolean { return this.alphaType === PREMUL; }

  raster(): OffscreenCanvas {
    if (!this.cv) {
      this.cv = new OffscreenCanvas(this.w, this.h);
      this.cx = this.cv.getContext("2d", { willReadFrequently: true })!;
      if (this.img) { this.cx.drawImage(this.img, 0, 0); this.img = null; }
      else if (this.px) this.cx.putImageData(new ImageData(this.px, this.w, this.h), 0, 0);
    }
    return this.cv;
  }
  /** what to draw this bitmap from: the decoded image while nothing has written to it */
  get image(): CanvasImageSource { return this.img ?? this.raster(); }
  /** The raster's context, made on demand: a bitmap that is only written and read as pixels never
   *  needs one, and outside a browser there is no OffscreenCanvas to make. Taking it is for a draw
   *  now, so the bitmap counts as written. */
  get ctx(): OffscreenCanvasRenderingContext2D {
    const cx = this.context();
    this.wrote();
    return cx;
  }
  /** the raster's context for a Canvas that keeps it, which marks each of its draws (wrote) */
  context(): OffscreenCanvasRenderingContext2D {
    this.raster();
    return this.cx!;
  }
  /** a draw changed the pixels: the pixel memo is stale and the generation moves on */
  wrote(): void {
    this.px = null;
    this.genId = nextGeneration();
  }
  /** decoded pixels as the whole contents: an image to draw, or straight RGBA */
  setImage(img: ImageBitmap | RGBA): void {
    this.dropPixels();
    if (ArrayBuffer.isView(img)) this.px = img; else this.img = img;
    this.genId = nextGeneration();
  }
  /** a display list recorded before keeps drawing a decoded image, as hwui's holds its own reference to the pixels: the collector frees it, not close */
  private dropPixels(): void {
    this.cv = this.cx = this.px = this.img = null;
  }
  /** Bitmap::reconfigure: the same allocation with new dimensions and undefined contents */
  reconfigure(w: number, h: number, config: number, alphaType: number): void {
    this.w = w; this.h = h; this.config = config; this.rowBytes = w * bytesPerPixel(config);
    this.alphaType = alphaFor(config, alphaType);
    this.dropPixels();
    this.genId = nextGeneration();
  }
  recycle(): void { this.recycled = true; this.dropPixels(); }

  /** RGBA bytes. Until a raster exists these ARE the bitmap; after that they are a memo of it,
   *  which is what makes a run of getPixel one readback instead of one per pixel. */
  pixels(): RGBA {
    if (this.px) return this.px;
    if (this.img || this.cx) { this.raster(); return this.px = this.cx!.getImageData(0, 0, this.w, this.h).data; }
    return this.px = new Uint8ClampedArray(this.w * this.h * 4) as RGBA;
  }
  /** a written region reaches the raster too, once there is one */
  commit(x: number, y: number, w: number, h: number): void {
    this.genId = nextGeneration();
    const cx = this.cx, px = this.px;
    if (!cx || !px) return;
    let buf = px;
    if (x || y || w !== this.w || h !== this.h) {
      buf = new Uint8ClampedArray(w * h * 4) as RGBA;
      for (let r = 0; r < h; r++) buf.set(px.subarray(((y + r) * this.w + x) * 4, ((y + r) * this.w + x + w) * 4), r * w * 4);
    }
    cx.putImageData(new ImageData(buf, w, h), x, y);
  }
  /** Bitmap::setAlphaType: the memory stays, what it means changes */
  setAlphaType(alphaType: number): void {
    if (this.config === RGB_565 || this.config === ALPHA_8 || alphaType === this.alphaType) return;
    if (this.px || this.rastered) {
      const memory = memoryOf(this);
      this.alphaType = alphaType;
      setMemory(this, memory);
    } else this.alphaType = alphaType;
  }
}

// ── storage formats: how a device holds a pixel, and what reading it back gives
const f = Math.fround, F255 = f(1 / 255);
/** SkOpts' premultiply: c·a/255, rounded */
const premul8 = (c: number, a: number) => { const p = c * a + 128; return (p + (p >> 8)) >> 8; };
/** Skia's float pipeline unpremultiplying a premultiplied byte, as readPixels does */
function unpremul8(c: number, a: number): number {
  if (a === 255) return c;
  if (!a) return 0;
  const v = f(f(c * F255) * f(1 / f(a * F255)));
  return v >= 1 ? 255 : Math.trunc(f(f(v * 255) + 0.5));
}
const quant = (c: number, max: number) => Math.round(c * max / 255);
const expand = (v: number, max: number) => Math.round(v * 255 / max);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** float to IEEE half, rounding to nearest even */
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00 | ((x & 0x7fffffff) > 0x7f800000 ? 0x200 : 0);
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e, half = m >>> shift, rest = m & ((1 << shift) - 1), mid = 1 << (shift - 1);
    return sign | (half + (rest > mid || rest === mid && half & 1 ? 1 : 0));
  }
  const half = sign | (e << 10) | (m >>> 13), rest = m & 0x1fff;
  return half + (rest > 0x1000 || rest === 0x1000 && half & 1 ? 1 : 0);
}
function fromHalf(h: number): number {
  const e = (h >>> 10) & 0x1f, m = h & 0x3ff, s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}

const scratch = new DataView(new ArrayBuffer(8));
/** a straight RGBA pixel into memory as `b` stores it; `premulSource` says the RGB is premultiplied already */
function storePixel(b: NativeBitmap, r: number, g: number, bl: number, a: number, m: DataView, o: number, premulSource = false) {
  const premul = b.alphaType === PREMUL && !premulSource;
  if (b.config === RGBA_F16) {
    // premultiplied in float, as the raster pipeline stores half floats
    const s = premul ? a / 255 : 1;
    [r * s, g * s, bl * s, a].forEach((c, i) => m.setUint16(o + i * 2, toHalf(c / 255), true));
    return;
  }
  if (premul && b.config !== RGB_565) { r = premul8(r, a); g = premul8(g, a); bl = premul8(bl, a); }
  switch (b.config) {
    case ALPHA_8: m.setUint8(o, a); return;
    case RGB_565: m.setUint16(o, quant(r, 31) << 11 | quant(g, 63) << 5 | quant(bl, 31), true); return;
    case ARGB_4444: m.setUint16(o, quant(r, 15) << 12 | quant(g, 15) << 8 | quant(bl, 15) << 4 | quant(a, 15), true); return;
    case RGBA_1010102: m.setUint32(o, (quant(r, 1023) | quant(g, 1023) << 10 | quant(bl, 1023) << 20 | quant(a, 3) << 30) >>> 0, true); return;
    default: m.setUint32(o, (r | g << 8 | bl << 16 | a << 24) >>> 0, true);
  }
}
/** memory at `o` back as straight RGBA into `out` at `i`, as readPixels unpremultiplies */
function loadPixel(b: NativeBitmap, m: DataView, o: number, out: RGBA | Uint8Array, i: number) {
  let r = 0, g = 0, bl = 0, a = 255;
  switch (b.config) {
    case ALPHA_8: a = m.getUint8(o); break;
    // SkPacked16ToR32 and friends replicate the high bits
    case RGB_565: { const v = m.getUint16(o, true), r5 = v >>> 11, g6 = v >>> 5 & 63, b5 = v & 31; r = r5 << 3 | r5 >> 2; g = g6 << 2 | g6 >> 4; bl = b5 << 3 | b5 >> 2; break; }
    case ARGB_4444: { const v = m.getUint16(o, true); r = (v >>> 12) * 17; g = (v >>> 8 & 15) * 17; bl = (v >>> 4 & 15) * 17; a = (v & 15) * 17; break; }
    case RGBA_F16: {
      const c = [0, 2, 4, 6].map((k) => fromHalf(m.getUint16(o + k, true)));
      a = Math.round(Math.min(1, Math.max(0, c[3])) * 255);
      const s = b.alphaType === PREMUL ? (c[3] > 0 ? 1 / c[3] : 0) : 1;
      [r, g, bl] = c.map((v) => Math.round(Math.min(1, Math.max(0, v * s)) * 255));
      out[i] = r; out[i + 1] = g; out[i + 2] = bl; out[i + 3] = a;
      return;
    }
    case RGBA_1010102: { const v = m.getUint32(o, true); r = expand(v & 1023, 1023); g = expand(v >>> 10 & 1023, 1023); bl = expand(v >>> 20 & 1023, 1023); a = (v >>> 30) * 85; break; }
    default: { const v = m.getUint32(o, true); r = v & 255; g = v >>> 8 & 255; bl = v >>> 16 & 255; a = v >>> 24; }
  }
  if (b.alphaType === PREMUL) { r = unpremul8(r, a); g = unpremul8(g, a); bl = unpremul8(bl, a); }
  out[i] = r; out[i + 1] = g; out[i + 2] = bl; out[i + 3] = a;
}
/** a straight ARGB colour as the bitmap would store and read it back */
function quantize(b: NativeBitmap, c: number, out: RGBA, i: number, premulSource = false) {
  storePixel(b, c >>> 16 & 255, c >>> 8 & 255, c & 255, c >>> 24, scratch, 0, premulSource);
  loadPixel(b, scratch, 0, out, i);
}

/** straight RGBA to or from (`decode`) 8888 memory, which holds premultiplied colour when `premul` */
function copyBitmapPixels(src: ArrayLike<number>, dst: Uint8Array | Uint8ClampedArray, premul: boolean, decode: boolean) {
  if (!premul) { dst.set(src); return; }
  // Opaque and fully transparent pixels need no scaling: whole words move at copy speed
  if (ArrayBuffer.isView(src) && src.byteOffset % 4 === 0 && dst.byteOffset % 4 === 0 && dst.length % 4 === 0) {
    const s = new Uint32Array(src.buffer, src.byteOffset, dst.length >> 2), d = new Uint32Array(dst.buffer, dst.byteOffset, dst.length >> 2);
    for (let w = 0; w < d.length; w++) {
      const v = s[w], a = v >>> 24;
      if (a === 255) { d[w] = v; continue; }
      if (a === 0) { d[w] = 0; continue; }
      const i = w << 2;
      if (decode) { dst[i] = unpremul8(src[i], a); dst[i + 1] = unpremul8(src[i + 1], a); dst[i + 2] = unpremul8(src[i + 2], a); }
      else { dst[i] = premul8(src[i], a); dst[i + 1] = premul8(src[i + 1], a); dst[i + 2] = premul8(src[i + 2], a); }
      dst[i + 3] = a;
    }
    return;
  }
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3], conv = decode ? unpremul8 : premul8;
    dst[i] = conv(src[i], a); dst[i + 1] = conv(src[i + 1], a); dst[i + 2] = conv(src[i + 2], a); dst[i + 3] = a;
  }
}
const is8888 = (b: NativeBitmap) => b.config === ARGB_8888 || b.config === HARDWARE;
/** SkImageInfo::computeByteSize: the last row needs only its pixels */
const byteSize = (b: NativeBitmap) => b.rowBytes * (b.h - 1) + b.w * bytesPerPixel(b.config);
/** the bitmap's memory, rowBytes per row */
export function memoryOf(b: NativeBitmap, out: Uint8Array = new Uint8Array(byteSize(b))): Uint8Array {
  const px = b.pixels(), bpp = bytesPerPixel(b.config);
  if (is8888(b) && b.rowBytes === b.w * 4) { copyBitmapPixels(px, out.subarray(0, px.length), b.premultiplied, false); return out; }
  const m = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const i = (y * b.w + x) * 4;
    storePixel(b, px[i], px[i + 1], px[i + 2], px[i + 3], m, y * b.rowBytes + x * bpp);
  }
  return out;
}
/** memory laid out as memoryOf gives it, as the new contents */
export function setMemory(b: NativeBitmap, memory: Uint8Array): void {
  const px = b.pixels(), bpp = bytesPerPixel(b.config);
  if (is8888(b) && b.rowBytes === b.w * 4) copyBitmapPixels(memory.subarray(0, px.length), px, b.premultiplied, true);
  else {
    const m = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) loadPixel(b, m, y * b.rowBytes + x * bpp, px, (y * b.w + x) * 4);
  }
  b.commit(0, 0, b.w, b.h);
}
const argbAt = (d: RGBA, i: number) => ((d[i + 3] << 24) | (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) | 0;
/** GraphicsJNI::SetPixels: straight ARGB colours written as the bitmap stores them */
export function setPixels(b: NativeBitmap, colors: Int32Array, off: number, stride: number, x: number, y: number, w: number, h: number) {
  const px = b.pixels();
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) quantize(b, colors[off + r * stride + c], px, ((y + r) * b.w + x + c) * 4);
  b.commit(x, y, w, h);
}
function erase(b: NativeBitmap, c: number) {
  const px = b.pixels();
  quantize(b, c, px, 0);
  new Uint32Array(px.buffer, px.byteOffset, px.length >> 2).fill(new Uint32Array(px.buffer, px.byteOffset, 1)[0]);
  b.commit(0, 0, b.w, b.h);
}

// ── color spaces: the pixels are drawn as sRGB; a bitmap keeps the space it is tagged with
const SRGB_TF = [1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0, 0, 2.4], LINEAR_TF = [1, 0, 0, 0, 0, 0, 1];
const SRGB_D50 = [0.436065674, 0.222488403, 0.013916016, 0.385147095, 0.716873169, 0.097076416, 0.143066406, 0.060607910, 0.714096069];
const near = (a: ArrayLike<number>, b: ArrayLike<number>) => { for (let i = 0; i < b.length; i++) if (Math.abs(a[i] - b[i]) > 1e-3) return false; return true; };
const isSrgb = (s: NativeColorSpace | null) => !s || near(s.transfer, SRGB_TF) && near(s.xyz, SRGB_D50);
const isLinearSrgb = (s: NativeColorSpace | null) => !!s && near(s.transfer, LINEAR_TF) && near(s.xyz, SRGB_D50);
/** skcms_TransferFunction_eval, sign-preserving */
function transfer([a, b, c, d, e, f, g]: number[], x: number): number {
  const s = Math.sign(x), v = Math.abs(x);
  return s * (v < d ? c * v + f : Math.pow(a * v + b, g) + e);
}
function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
const SRGB_FROM_XYZ = invert3([0, 3, 6, 1, 4, 7, 2, 5, 8].map((k) => SRGB_D50[k]));
/** a colour in `space` as sRGB, clamped: what drawing it into an 8-bit sRGB bitmap stores */
function toSrgb(space: NativeColorSpace, rgb: number[]): number[] {
  if (isSrgb(space)) return rgb.map((v) => Math.min(1, Math.max(0, v)));
  const lin = rgb.map((v) => transfer(space.transfer, v)), m = space.xyz;
  const xyz = [0, 1, 2].map((r) => m[r] * lin[0] + m[3 + r] * lin[1] + m[6 + r] * lin[2]);
  const [ia, ib, ic, id, ie, iff, ig] = SRGB_TF;
  return [0, 1, 2].map((r) => {
    const l = SRGB_FROM_XYZ[r * 3] * xyz[0] + SRGB_FROM_XYZ[r * 3 + 1] * xyz[1] + SRGB_FROM_XYZ[r * 3 + 2] * xyz[2];
    const v = l < ic * id ? (l - iff) / ic : (Math.pow(Math.max(0, l - ie), 1 / ig) - ib) / ia;
    return Math.min(1, Math.max(0, v));
  });
}
/** a ColorLong (android.graphics.Color's packing) as an ARGB int in sRGB: colour-space id 0 (the low
 *  six bits) is the sRGB ARGB int in the top 32 bits; any other id packs half-float R, G, B and a
 *  10-bit alpha, which are converted to sRGB and clamped as Skia stores them in an 8-bit surface */
function colorLongArgb(color: bigint, space: NativeColorSpace | null): number {
  if (!(color & 0x3fn)) return Number(BigInt.asUintN(32, color >> 32n)) | 0;
  const half = (s: bigint) => fromHalf(Number((color >> s) & 0xffffn));
  const [r, g, b] = toSrgb(space ?? { transfer: SRGB_TF, xyz: Float32Array.from(SRGB_D50) }, [half(48n), half(32n), half(16n)]);
  const a = Number((color >> 6n) & 0x3ffn) / 1023;
  const byte = (v: number) => Math.round(v * 255);
  return (byte(a) << 24 | byte(r) << 16 | byte(g) << 8 | byte(b)) | 0;
}
/** a ColorLong in the colour space a ColorSpace.Rgb.Native handle names (0 for sRGB), as sRGB ARGB:
 *  the decoder for every native that receives a ColorLong (Paint, Canvas, gradients, Bitmap) */
export const colorLongAt = (color: bigint, cs: bigint) => colorLongArgb(color, cs ? deref<NativeColorSpace>(cs) : null);
const COLOR_SPACE = "android/graphics/ColorSpace";
export const namedSpace = (index: number) => scall(COLOR_SPACE, "get", "(I)Landroid/graphics/ColorSpace;", index);
/** GraphicsJNI::getColorSpace: a named space where the pixels' space is one, else the match or an "Unknown" Rgb */
function javaColorSpace(b: NativeBitmap): unknown {
  if (b.config === ALPHA_8) return null;
  const s = b.space, f16 = b.config === RGBA_F16;
  if (isSrgb(s)) return namedSpace(f16 ? 2 : 0);
  if (isLinearSrgb(s)) return namedSpace(f16 ? 3 : 1);
  const [a, bb, c, d, e, ff, g] = s!.transfer, xyz = Float32Array.from(s!.xyz);
  return after(newObj(COLOR_SPACE + "$Rgb$TransferParameters", "(DDDDDDD)V", a, bb, c, d, e, ff, g), (params) =>
    after(scall(COLOR_SPACE, "match", "([FLandroid/graphics/ColorSpace$Rgb$TransferParameters;)Landroid/graphics/ColorSpace;", xyz, params), (match) =>
      match ?? newObj(COLOR_SPACE + "$Rgb", "(Ljava/lang/String;[FLandroid/graphics/ColorSpace$Rgb$TransferParameters;)V", "Unknown", xyz, params)));
}
const spaceOf = (h: bigint): NativeColorSpace | null => { const s = h ? deref<NativeColorSpace>(h) : null; return isSrgb(s) ? null : s; };

// ── the Java object
const BITMAP = "android/graphics/Bitmap";
const nativePtr = peerField<bigint>(BITMAP, "mNativePtr");
/** the native state behind a Java Bitmap */
export const bitmapOf = (b: object): NativeBitmap => deref<NativeBitmap>(nativePtr(b));
/** bitmap::createBitmap: the Java Bitmap around `b`; a density below 0 is Bitmap.getDefaultDensity */
export function javaBitmap(b: NativeBitmap, density = -1, chunk: Int8Array | null = null, insets: unknown = null, requestPremultiplied = b.alphaType !== UNPREMUL): object | Promise<object> {
  return newObj(BITMAP, "(JIIIZ[BLandroid/graphics/NinePatch$InsetStruct;Z)V", handle(b), b.w, b.h, density, +requestPremultiplied, chunk, insets, 1);
}
/** Bitmap.reinit: a reused Java Bitmap takes the geometry its native bitmap was reconfigured to */
export const reinitJava = (bitmap: object, b: NativeBitmap, requestPremultiplied: boolean) =>
  vcall(bitmap, "reinit", "(IIZ)V", b.w, b.h, +requestPremultiplied);

export const bitmapAt = (h: bigint) => deref<NativeBitmap>(h);
const noHardwareBuffer = () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", "HardwareBuffer is not supported"); };
/** GraphicsJNI::legacyBitmapConfigToColorType, then what Bitmap_creator does with ARGB_4444 */
const creatable = (config: number) => config === ARGB_4444 ? ARGB_8888 : config;
/** a copy of `src` in `config` (bitmapCopyTo): 565 drops alpha from the premultiplied colour */
function copyBitmap(src: NativeBitmap, config: number): NativeBitmap {
  const dst = new NativeBitmap(src.w, src.h, config, config === RGB_565 ? OPAQUE : src.alphaType);
  dst.space = config === ALPHA_8 ? null : src.space;
  if (config === src.config && dst.alphaType === src.alphaType) {
    if (src.recycled) return dst;
    if (src.rastered) dst.ctx.drawImage(src.image, 0, 0);
    else { dst.pixels().set(src.pixels()); dst.commit(0, 0, dst.w, dst.h); }
    return dst;
  }
  // a premultiplied source converts from its memory, as SkConvertPixels does
  const s = src.pixels(), d = dst.pixels(), premulSource = src.alphaType === PREMUL;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3], c = premulSource ? (a << 24 | premul8(s[i], a) << 16 | premul8(s[i + 1], a) << 8 | premul8(s[i + 2], a)) : argbAt(s, i);
    quantize(dst, c, d, i, premulSource);
  }
  dst.commit(0, 0, dst.w, dst.h);
  return dst;
}
const wrap = (b: NativeBitmap, mutable: number | boolean) => { b.immutable = !mutable; return javaBitmap(b); };

rt.registerJnis(BITMAP, {
  // the Java Bitmap's constructor can wait, and a native that takes an array cannot be parked
  "nativeCreate([IIIIIIZJ)Landroid/graphics/Bitmap;": waits((colors: Int32Array | null, off: number, stride: number, w: number, h: number, config: number, mutable: number, cs: bigint) => {
    if (colors && colors.length < Math.abs(stride) * h) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
    const b = new NativeBitmap(w, h, creatable(config));
    if (config !== ALPHA_8) b.space = spaceOf(cs);
    if (colors) setPixels(b, colors, off, stride, 0, 0, w, h);
    return wrap(b, mutable);
  }),
  // HARDWARE is our raster, as a GPU buffer is on a device: immutable, drawn without a readback
  "nativeCopy(JIZ)Landroid/graphics/Bitmap;": (h: bigint, config: number, mutable: number) => wrap(copyBitmap(bitmapAt(h), config), mutable),
  "nativeCopyPreserveInternalConfig(J)Landroid/graphics/Bitmap;": (h: bigint) => wrap(copyBitmap(bitmapAt(h), ARGB_8888), 0),
  // no ashmem here: a shared copy is an immutable heap copy, and no bitmap reports a descriptor
  "nativeCopyAshmem(J)Landroid/graphics/Bitmap;": (h: bigint) => wrap(copyBitmap(bitmapAt(h), bitmapAt(h).config), 0),
  "nativeCopyAshmemConfig(JI)Landroid/graphics/Bitmap;": (h: bigint, config: number) => wrap(copyBitmap(bitmapAt(h), config), 0),
  "nativeGetAshmemFD(J)I": () => -1,
  "nativeIsBackedByAshmem(J)Z": () => 0,
  "nativeGetNativeFinalizer()J": () => FINALIZER,
  "nativeRecycle(J)V": (h: bigint) => { bitmapAt(h).recycle(); },
  "nativeReconfigure(JIIIZ)V": (h: bigint, w: number, ht: number, config: number, premul: number) => {
    const b = bitmapAt(h), cfg = creatable(config);
    if (w * ht * bytesPerPixel(cfg) > b.allocation) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bitmap not large enough to support new configuration");
    b.reconfigure(w, ht, cfg, b.config !== RGB_565 && b.alphaType === OPAQUE ? OPAQUE : premul ? PREMUL : UNPREMUL);
  },
  "nativeCompress(JIILjava/io/OutputStream;[B)Z": driven(function* (h: bigint, format: number, quality: number, out: unknown, storage: Int8Array): Gen {
    const b = bitmapAt(h);
    // CompressFormat's nativeInt: JPEG, PNG, WEBP (lossless at 100), WEBP_LOSSY, WEBP_LOSSLESS
    const type = ["image/jpeg", "image/png", "image/webp", "image/webp", "image/webp"][format];
    if (!type) return 0;
    const lossless = format === 4 || format === 2 && quality === 100;
    const blob = yield* awaited(b.raster().convertToBlob({ type, quality: lossless ? 1 : quality / 100 }));
    if (blob.type !== type) return 0;
    yield* writeThrough(out, storage, new Uint8Array(yield* awaited(blob.arrayBuffer())));
    return 1;
  }),
  "nativeErase(JI)V": (h: bigint, c: number) => erase(bitmapAt(h), c),
  "nativeErase(JJJ)V": (h: bigint, cs: bigint, color: bigint) => erase(bitmapAt(h), colorLongAt(color, cs)),
  "nativeRowBytes(J)I": (h: bigint) => bitmapAt(h).rowBytes,
  "nativeConfig(J)I": (h: bigint) => bitmapAt(h).config,
  "nativeGetPixel(JII)I": (h: bigint, x: number, y: number) => { const b = bitmapAt(h); return argbAt(b.pixels(), (y * b.w + x) * 4); },
  // unpremultiplied RGBA halves in the bitmap's own space
  "nativeGetColor(JII)J": (h: bigint, x: number, y: number) => {
    const b = bitmapAt(h), px = b.pixels(), i = (y * b.w + x) * 4;
    let v = 0n;
    for (let k = 3; k >= 0; k--) v = v << 16n | BigInt(toHalf(px[i + k] / 255));
    return BigInt.asIntN(64, v);
  },
  "nativeGetPixels(J[IIIIIII)V": (h: bigint, out: Int32Array, off: number, stride: number, x: number, y: number, w: number, ht: number) => {
    const b = bitmapAt(h), px = b.pixels();
    for (let r = 0; r < ht; r++) for (let c = 0; c < w; c++) out[off + r * stride + c] = argbAt(px, ((y + r) * b.w + x + c) * 4);
  },
  "nativeSetPixel(JIII)V": (h: bigint, x: number, y: number, c: number) => {
    const b = bitmapAt(h);
    quantize(b, c, b.pixels(), (y * b.w + x) * 4);
    b.commit(x, y, 1, 1);
  },
  "nativeSetPixels(J[IIIIIII)V": (h: bigint, colors: Int32Array, off: number, stride: number, x: number, y: number, w: number, ht: number) =>
    setPixels(bitmapAt(h), colors, off, stride, x, y, w, ht),
  "nativeCopyPixelsToBuffer(JLjava/nio/Buffer;)V": waits((h: bigint, buffer: JBuffer) => writeRemainingBytes(buffer,memoryOf(bitmapAt(h)))),
  "nativeCopyPixelsFromBuffer(JLjava/nio/Buffer;)V": waits((h: bigint, buffer: JBuffer) => {
    const b = bitmapAt(h);
    return after(readBufferBytes(buffer,position(buffer) << elementShift(buffer),byteSize(b)),bytes => setMemory(b,bytes.slice()));
  }),
  "nativeGenerationId(J)I": (h: bigint) => bitmapAt(h).genId,
  // Bitmap's own wire format, which only its CREATOR reads: the flags, geometry, density and memory
  "nativeWriteToParcel(JILandroid/os/Parcel;)Z": (h: bigint, density: number, parcel: JObj) => {
    const b = bitmapAt(h), p = nativeParcel(parcel);
    for (const v of [b.immutable ? 0 : 1, b.config, b.alphaType, b.w, b.h, b.rowBytes, density]) writeInt(p, v);
    const memory = memoryOf(b), at = p.pos;
    writeByteArray(p, new Int8Array(memory.buffer, memory.byteOffset, memory.length));
    outOfLine(p, at);
    return 1;
  },
  "nativeCreateFromParcel(Landroid/os/Parcel;)Landroid/graphics/Bitmap;": (parcel: JObj) => {
    const p = nativeParcel(parcel), [mutable, config, alphaType, w, h, rowBytes, density] = Array.from({ length: 7 }, () => readInt(p));
    const b = new NativeBitmap(w, h, config, alphaType, rowBytes);
    const memory = createByteArray(p);
    if (memory) setMemory(b, u8(memory));
    b.immutable = !mutable;
    return javaBitmap(b, density);
  },
  "nativeExtractAlpha(JJ[I)Landroid/graphics/Bitmap;": waits((h: bigint, paint: bigint, offsetXY: Int32Array | null) =>
    wrap(extractBitmapAlpha(bitmapAt(h), paint ? paintAt(paint) : null, offsetXY), true)),
  // hwui uploads a texture ahead of drawing; the 2D path has none to prepare
  "nativePrepareToDraw(J)V": () => {},
  "nativeHasAlpha(J)Z": (h: bigint) => +bitmapAt(h).hasAlpha,
  "nativeIsPremultiplied(J)Z": (h: bigint) => +bitmapAt(h).premultiplied,
  "nativeSetHasAlpha(JZZ)V": (h: bigint, hasAlpha: number, premul: number) => bitmapAt(h).setAlphaType(hasAlpha ? premul ? PREMUL : UNPREMUL : OPAQUE),
  "nativeSetPremultiplied(JZ)V": (h: bigint, premul: number) => {
    const b = bitmapAt(h);
    if (premul ? b.alphaType === UNPREMUL : b.alphaType === PREMUL) b.setAlphaType(premul ? PREMUL : UNPREMUL);
  },
  "nativeHasMipMap(J)Z": (h: bigint) => +bitmapAt(h).mipmap,
  "nativeSetHasMipMap(JZ)V": (h: bigint, v: number) => { bitmapAt(h).mipmap = !!v; },
  "nativeSameAs(JJ)Z": (a: bigint, b: bigint) => {
    const x = bitmapAt(a), y = bitmapAt(b);
    if (x.w !== y.w || x.h !== y.h || x.config !== y.config || x.alphaType !== y.alphaType || isSrgb(x.space) !== isSrgb(y.space)) return 0;
    const p = x.pixels(), q = y.pixels();
    const pw = new Uint32Array(p.buffer, p.byteOffset, p.length >> 2), qw = new Uint32Array(q.buffer, q.byteOffset, q.length >> 2);
    for (let i = 0; i < pw.length; i++) if (pw[i] !== qw[i]) return 0;
    return 1;
  },
  "nativeGetAllocationByteCount(J)I": (h: bigint) => bitmapAt(h).allocation,
  "nativeIsImmutable(J)Z": (h: bigint) => +bitmapAt(h).immutable,
  "nativeSetImmutable(J)V": (h: bigint) => { bitmapAt(h).immutable = true; },
  "nativeComputeColorSpace(J)Landroid/graphics/ColorSpace;": (h: bigint) => javaColorSpace(bitmapAt(h)),
  "nativeSetColorSpace(JJ)V": (h: bigint, cs: bigint) => { bitmapAt(h).space = spaceOf(cs); },
  "nativeIsSRGB(J)Z": (h: bigint) => +(bitmapAt(h).config !== ALPHA_8 && isSrgb(bitmapAt(h).space)),
  "nativeIsSRGBLinear(J)Z": (h: bigint) => +isLinearSrgb(bitmapAt(h).space),
  // HardwareBuffer and HDR gainmaps are GPU allocations there is no device for: a HARDWARE
  // bitmap here is a raster, and no gainmap can be made (Gainmap's natives are absent)
  "nativeGetHardwareBuffer(J)Landroid/hardware/HardwareBuffer;": noHardwareBuffer,
  "nativeWrapHardwareBufferBitmap(Landroid/hardware/HardwareBuffer;J)Landroid/graphics/Bitmap;": noHardwareBuffer,
  "nativeHasGainmap(J)Z": () => 0,
  "nativeExtractGainmap(J)Landroid/graphics/Gainmap;": () => null,
  "nativeSetGainmap(JJ)V": (_h: bigint, gainmap: bigint) => {
    if (gainmap) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Gainmaps are not supported");
  },
});
