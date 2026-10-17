// SkMaskFilter behind android.graphics.MaskFilter and its subclasses, whose Java runs from AOSP
// bytecode: what a shape's coverage becomes before it is coloured, and Bitmap.extractAlpha's use of it.

import { rt } from "../jvm/runtime.ts";
import { handle, deref, release } from "./handles.ts";
import { NativeBitmap, ALPHA_8, PREMUL } from "./bitmap.ts";
import type { NativePaint } from "./paint.ts";
import type { Ctx2D } from "./recording.ts";

/** Blur::convertRadiusToSigma */
const radiusToSigma = (r: number) => (r > 0 ? 0.57735 * r + 0.5 : 0);
export abstract class NativeMaskFilter {
  /** whether apply writes the shape's final colours (a 3D mask), not coverage to be coloured */
  readonly colored: boolean = false;
  /** the pixels the filter may reach beyond the shape (SkMask margin), for extractAlpha */
  border(): number { return 0; }
  /** `source`'s coverage through the filter, drawn into `target` at (x, y); `scale` maps the
   *  filter's lengths to device pixels and `color` is the paint's, for a filter that colours */
  abstract apply(target: Ctx2D, source: CanvasImageSource, x: number, y: number, scale: number, color?: number): void;
}
/** SkBlurMaskFilter: NORMAL, SOLID, OUTER, INNER */
export class BlurMask extends NativeMaskFilter {
  readonly sigma: number; readonly style: number;
  constructor(sigma: number, style: number) { super(); this.sigma = sigma; this.style = style; }
  /** SkBlurMask's margin: three box passes, or the Bessel window of a small sigma */
  override border() {
    const sigma = Math.min(this.sigma, 135);
    if (this.style === 3) return 0;
    if (sigma >= 2) {
      const window = Math.max(1, Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5));
      return window % 2 ? 3 * (window - 1) / 2 : 3 * window / 2 - 1;
    }
    const variance = sigma * sigma, q = variance * variance / 4;
    const bessel = (n: number) => {
      let term = n ? variance / 2 : 1, sum = term;
      for (let k = 1; term > 1e-6; k++) { term *= q / (k * (k + n)); sum += term; }
      return sum;
    };
    let previous = bessel(0), current = bessel(1), n = 1;
    while (current / Math.exp(variance) > 0.01) {
      const next = previous - 2 * n / variance * current;
      previous = current; current = next; n++;
    }
    return n - 1;
  }
  apply(ctx: Ctx2D, source: CanvasImageSource, x: number, y: number, scale: number) {
    ctx.filter = `blur(${Math.min(this.sigma * scale, 135)}px)`;
    ctx.drawImage(source, x, y); ctx.filter = "none";
    if (this.style) {
      ctx.globalCompositeOperation = this.style === 2 ? "destination-out" : this.style === 3 ? "destination-in" : "source-over";
      ctx.drawImage(source, x, y);
      ctx.globalCompositeOperation = "source-over";
    }
  }
}
/** SkTableMaskFilter: each coverage value through a 256-entry table */
class TableMask extends NativeMaskFilter {
  readonly table: Uint8Array;
  constructor(table: Uint8Array) { super(); this.table = table; }
  apply(ctx: Ctx2D, source: CanvasImageSource, x: number, y: number) {
    ctx.drawImage(source, x, y);
    const { width, height } = ctx.canvas, img = ctx.getImageData(0, 0, width, height), d = img.data, t = this.table;
    for (let i = 3; i < d.length; i += 4) d[i] = t[d[i]];
    ctx.putImageData(img, 0, 0);
  }
}
/** SkEmbossMaskFilter: the shape lit as a height field its inner blur makes, the lighting
 *  modulating (ambient and diffuse) and adding to (specular) the paint's colour */
class EmbossMask extends NativeMaskFilter {
  readonly sigma: number; readonly light: Float64Array; readonly ambient: number; readonly specular: number;
  override readonly colored = true;
  constructor(sigma: number, light: Float64Array, ambient: number, specular: number) { super(); this.sigma = sigma; this.light = light; this.ambient = ambient; this.specular = specular; }
  override border() { return Math.ceil(3 * this.sigma); }
  apply(ctx: Ctx2D, source: CanvasImageSource, x: number, y: number, scale: number, color = -16777216) {
    const { width: w, height: h } = ctx.canvas;
    ctx.drawImage(source, x, y);
    const src = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${this.sigma * scale}px)`;
    ctx.drawImage(source, x, y); ctx.filter = "none";
    const blurred = ctx.getImageData(0, 0, w, h), b = blurred.data, s = src.data;
    // the inner blur: the blurred coverage inside the shape (merge_src_with_blur)
    const height = new Uint8Array(w * h);
    for (let i = 0; i < height.length; i++) height[i] = (b[i * 4 + 3] * (s[i * 4 + 3] + 1)) >> 8;
    // SkEmbossMask::Emboss in 16.16 fixed point, the light direction normalized
    const [lx, ly, lz] = Array.from(this.light, (v) => Math.trunc(v * 65536)), lzDot8 = lz >> 8, DELTA = 32;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      const nx = height[i + (xx < w - 1 ? 1 : 0)] - height[i - (xx > 0 ? 1 : 0)];
      const ny = height[i + (yy < h - 1 ? w : 0)] - height[i - (yy > 0 ? w : 0)];
      const numer = lx * nx + ly * ny + lz * DELTA;
      let mul = this.ambient, add = 0;
      if (numer > 0) {
        const dot = Math.trunc(numer / Math.floor(Math.sqrt(nx * nx + ny * ny + DELTA * DELTA))) >> 8;
        mul = Math.min(mul + dot, 255);
        let hilite = ((2 * dot - lzDot8) * lzDot8) >> 8;
        if (hilite > 0) {
          hilite = Math.min(hilite, 255);
          add = hilite;
          for (let k = this.specular >> 4; k > 0; k--) add = Math.floor(add * hilite * 65793 / 16777216);
        }
      }
      // Sk3DShader: each premultiplied channel scaled by mul and raised by add, under the shape's
      // own coverage
      const o = i * 4, alpha = color >>> 24, raise = mulDiv255(add, alpha);
      const shade = (c: number) => alpha && Math.min(((mulDiv255(c, alpha) * (mul + 1)) >> 8) + raise, alpha) * 255 / alpha;
      b[o] = shade(color >>> 16 & 255); b[o + 1] = shade(color >>> 8 & 255); b[o + 2] = shade(color & 255);
      b[o + 3] = mulDiv255(s[o + 3], alpha);
    }
    ctx.putImageData(blurred, 0, 0);
  }
}
/** SkMulDiv255Round */
const mulDiv255 = (a: number, b: number) => { const p = a * b + 128; return (p + (p >> 8)) >> 8; };
export const maskFilterAt = (h: bigint) => (h ? deref<NativeMaskFilter>(h) : null);
const iae = () => rt.mkThrowable("java/lang/IllegalArgumentException", null);
rt.registerJnis("android/graphics/MaskFilter", { "nativeDestructor(J)V": release });
rt.registerJnis("android/graphics/BlurMaskFilter", {
  "nativeConstructor(FI)J": (radius: number, style: number) => {
    const sigma = radiusToSigma(radius);
    if (!(sigma > 0) || !Number.isFinite(sigma)) throw iae();
    return handle(new BlurMask(sigma, style));
  },
});
rt.registerJnis("android/graphics/EmbossMaskFilter", {
  // SkBlurMaskFilter::MakeEmboss: ambient as a unit byte, specular as 4.4 fixed point
  "nativeConstructor([FFFF)J": (dir: Float32Array, ambient: number, specular: number, radius: number) => {
    const sigma = radiusToSigma(radius), len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(sigma > 0) || !Number.isFinite(sigma) || !(len > 0) || !Number.isFinite(len)) throw iae();
    const light = Float64Array.of(dir[0] / len, dir[1] / len, dir[2] / len);
    return handle(new EmbossMask(sigma, light, Math.round(Math.min(Math.max(ambient, 0), 1) * 255),
      Math.trunc(Math.min(Math.max(specular, 0), 16) / 16 * 255)));
  },
});
rt.registerJnis("android/graphics/TableMaskFilter", {
  "nativeNewTable([B)J": (table: Int8Array) => handle(new TableMask(new Uint8Array(table.buffer, table.byteOffset, 256).slice())),
  // SkTableMaskFilter::MakeClipTable
  "nativeNewClip(II)J": (min: number, max: number) => {
    const t = new Uint8Array(256);
    min &= 255; max &= 255;
    if (max === 0) max = 1;
    if (min >= max) min = max - 1;
    const scale = Math.trunc(65536 * 255 / (max - min));
    for (let i = min + 1; i < max; i++) t[i] = (scale * (i - min) + 0x8000) >> 16;
    t.fill(255, max);
    return handle(new TableMask(t));
  },
  // SkTableMaskFilter::MakeGammaTable
  "nativeNewGamma(F)J": (gamma: number) => {
    const t = new Uint8Array(256), dx = Math.fround(1 / 255);
    for (let i = 0, x = 0; i < 256; i++, x = Math.fround(x + dx)) t[i] = Math.min(255, Math.max(0, Math.round(Math.pow(x, gamma) * 255)));
    return handle(new TableMask(t));
  },
});

/** SkBitmap::extractAlpha: an ALPHA_8 copy of the coverage, through the paint's mask filter, its
 *  rows 4-byte aligned as SkMask lays them out */
export function extractBitmapAlpha(src: NativeBitmap, paint: NativePaint | null, offsets: Int32Array | null): NativeBitmap {
  const filter = paint?.maskFilter ?? null, border = filter ? filter.border() : 0;
  const w = src.w + 2 * border, h = src.h + 2 * border, b = new NativeBitmap(w, h, ALPHA_8, PREMUL, (w + 3) & ~3);
  if (filter) {
    const ctx = b.ctx;
    filter.apply(ctx, src.image, border, border, 1);
    ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, b.w, b.h);
    ctx.globalCompositeOperation = "source-over";
  } else {
    const source = src.pixels(), target = b.pixels();
    for (let i = 3; i < target.length; i += 4) target[i] = source[i];
  }
  if (offsets && offsets.length >= 2) { offsets[0] = -border; offsets[1] = -border; }
  return b;
}
