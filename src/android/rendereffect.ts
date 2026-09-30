import { rt, JObj } from "../jvm/runtime";
import { weakHandle } from "./handles";
import { type JSimpleEnum, enumOrdinal } from "../jvm/natives/jlang";

type Effect = { kind: "offset"; x: number; y: number } | { kind: "blur"; x: number; y: number; tile: number };
/** the rasters a blur reuses from one run to the next */
export type BlurCache = { padded: OffscreenCanvas | null; blurred: OffscreenCanvas | null };
function sized(c: OffscreenCanvas | null, w: number, h: number): OffscreenCanvas {
  if (!c) return new OffscreenCanvas(w, h);
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}
/** `src` drawn at w x h inside a `pad` border tiled by Shader.TileMode `tile`: CLAMP repeats the
 *  outermost pixels, REPEAT and MIRROR the image, DECAL leaves it transparent */
function padded(cache: BlurCache, src: OffscreenCanvas, w: number, h: number, pad: number, tile: number): OffscreenCanvas {
  const padded = cache.padded = sized(cache.padded, w + 2 * pad, h + 2 * pad), p = padded.getContext("2d")!;
  const sw = src.width, sh = src.height;
  p.reset();
  p.drawImage(src, pad, pad, w, h);
  if (tile === 0) {
    p.imageSmoothingEnabled = false;
    p.drawImage(src, 0, 0, sw, 1, pad, 0, w, pad); p.drawImage(src, 0, sh - 1, sw, 1, pad, pad + h, w, pad);
    p.drawImage(src, 0, 0, 1, sh, 0, pad, pad, h); p.drawImage(src, sw - 1, 0, 1, sh, pad + w, pad, pad, h);
    p.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad); p.drawImage(src, sw - 1, 0, 1, 1, pad + w, 0, pad, pad);
    p.drawImage(src, 0, sh - 1, 1, 1, 0, pad + h, pad, pad); p.drawImage(src, sw - 1, sh - 1, 1, 1, pad + w, pad + h, pad, pad);
  } else if (tile !== 3) {
    for (let y = -Math.ceil(pad / h); y <= Math.ceil(pad / h); y++) for (let x = -Math.ceil(pad / w); x <= Math.ceil(pad / w); x++) {
      if (!x && !y) continue;
      const flipX = tile === 2 && x % 2 !== 0, flipY = tile === 2 && y % 2 !== 0;
      p.save(); p.translate(pad + x * w + (flipX ? w : 0), pad + y * h + (flipY ? h : 0));
      p.scale(flipX ? -1 : 1, flipY ? -1 : 1); p.drawImage(src, 0, 0, w, h); p.restore();
    }
  }
  return padded;
}
function gaussian(cache: BlurCache, padded: OffscreenCanvas, sigma: number): OffscreenCanvas {
  const blurred = cache.blurred = sized(cache.blurred, padded.width, padded.height), b = blurred.getContext("2d")!;
  b.reset();
  b.filter = `blur(${sigma}px)`; b.drawImage(padded, 0, 0);
  return blurred;
}
/** a Gaussian of `sigma` over `src` with clamped edges; the result has a ceil(3 sigma) border on
 *  every side */
export function clampedBlur(src: OffscreenCanvas, sigma: number, cache: BlurCache): OffscreenCanvas {
  return gaussian(cache, padded(cache, src, src.width, src.height, Math.ceil(3 * sigma), 0), sigma);
}
export class JRenderEffect extends JObj implements BlurCache {
  effect: Effect = { kind: "offset", x: 0, y: 0 };
  padded: OffscreenCanvas | null = null;
  blurred: OffscreenCanvas | null = null;
  private work = new Float32Array(0);
  private scratch = new Float32Array(0);
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, source: OffscreenCanvas) {
    const e = this.effect;
    if (e.kind === "offset") { ctx.drawImage(source, e.x, e.y); return; }
    if (!e.x && !e.y) { ctx.drawImage(source, 0, 0); return; }
    // Normalize unequal radii by shrinking the more blurred axis before the filter.
    const radius = Math.min(e.x || e.y, e.y || e.x), sx = e.x ? radius / e.x : 1, sy = e.y ? radius / e.y : 1;
    const w = Math.max(1, Math.ceil(source.width * sx)), h = Math.max(1, Math.ceil(source.height * sy));
    const pad = Math.ceil(radius * 3), width = w + pad * 2, height = h + pad * 2;
    const surface = padded(this, source, w, h, pad, e.tile);
    if (e.x && e.y) {
      ctx.drawImage(gaussian(this, surface, radius), -pad / sx, -pad / sy, width / sx, height / sy);
    } else {
      const target = surface.getContext("2d")!, pixels = target.getImageData(0, 0, width, height), data = pixels.data;
      if (this.work.length !== data.length) { this.work = new Float32Array(data.length); this.scratch = new Float32Array(data.length); }
      let input = this.work, output = this.scratch;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3]; input[i + 3] = alpha;
        for (let c = 0; c < 3; c++) input[i + c] = data[i + c] * alpha / 255;
      }
      // Three box passes approximate the Gaussian in linear time for a single blurred axis.
      const ideal = Math.sqrt(4 * radius * radius + 1), lower = Math.floor(ideal) | 1;
      const small = lower > ideal ? lower - 2 : lower;
      const count = Math.round((12 * radius * radius - 3 * small * small - 12 * small - 9) / (-4 * small - 4));
      const length = e.x ? width : height, lines = e.x ? height : width, stride = e.x ? 4 : width * 4;
      for (let pass = 0; pass < 3; pass++) {
        const box = pass < count ? small : small + 2, half = (box - 1) / 2;
        for (let line = 0; line < lines; line++) for (let c = 0; c < 4; c++) {
          const start = (e.x ? line * width : line) * 4 + c;
          let sum = 0;
          for (let i = 0; i <= Math.min(half, length - 1); i++) sum += input[start + i * stride];
          for (let i = 0; i < length; i++) {
            output[start + i * stride] = sum / box;
            if (i >= half) sum -= input[start + (i - half) * stride];
            if (i + half + 1 < length) sum += input[start + (i + half + 1) * stride];
          }
        }
        [input, output] = [output, input];
      }
      for (let i = 0; i < data.length; i += 4) {
        const alpha = input[i + 3]; data[i + 3] = alpha;
        for (let c = 0; c < 3; c++) data[i + c] = alpha ? input[i + c] * 255 / alpha : 0;
      }
      target.putImageData(pixels, 0, 0); ctx.drawImage(surface, -pad, -pad);
    }
  }
}
function effect(value: Effect) { const e = new JRenderEffect(); e.effect = value; return e; }
rt.register({ name: "android/graphics/RenderEffect", ctor: JRenderEffect, methods: {
  // what RenderNode.setRenderEffect hands its native half
  "getNativeInstance()J": function (this: JRenderEffect) { return weakHandle(this); },
  "static createOffsetEffect(FF)Landroid/graphics/RenderEffect;": (x: number, y: number) => effect({ kind: "offset", x, y }),
  "static createBlurEffect(FFLandroid/graphics/Shader$TileMode;)Landroid/graphics/RenderEffect;": (x: number, y: number, tile: JSimpleEnum) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid blur radius");
    return effect({ kind: "blur", x, y, tile: enumOrdinal(tile) });
  },
} });
