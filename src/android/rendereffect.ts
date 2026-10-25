// RenderEffect's native half: hwui's SkImageFilter graph (jni/RenderEffect.cpp), evaluated over a
// node's rasterised content. An input of 0 is that content.
import { rt } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { compositeOf } from "./graphics.ts";
import type { NativeColorFilter } from "./colorfilter.ts";
import { NativeShader } from "./shader.ts";
import type { NativeBitmap } from "./bitmap.ts";
import { radiusToSigma } from "./maskfilter.ts";
import type { RuntimeShaderBuilder } from "./runtime-shader.ts";
import type { Ctx2D } from "./recording.ts";

/** the rasters a blur reuses from one run to the next */
export type BlurCache = { padded: OffscreenCanvas | null; blurred: OffscreenCanvas | null };
export function sized(c: OffscreenCanvas | null, w: number, h: number): OffscreenCanvas {
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
/** an effect's output: an image placed at (x, y) and drawn at w x h in node coordinates */
type Filtered = { img: OffscreenCanvas; x: number; y: number; w: number; h: number };
const whole = (img: OffscreenCanvas): Filtered => ({ img, x: 0, y: 0, w: img.width, h: img.height });
/** a raster the size of `f`'s placement with `f` drawn into it, for effects that work in pixels */
function flatten(target: OffscreenCanvas | null, f: Filtered): OffscreenCanvas {
  const w = Math.max(1, Math.ceil(f.w)), h = Math.max(1, Math.ceil(f.h)), c = sized(target, w, h), g = c.getContext("2d")!;
  g.reset(); g.drawImage(f.img, 0, 0, f.w, f.h);
  return c;
}

export abstract class NativeRenderEffect {
  protected out: OffscreenCanvas | null = null;
  /** SkImageFilter::filterImage over `source`, the node's content or an outer chain's input */
  abstract filter(source: Filtered): Filtered;
  /** the node's content `source` filtered and drawn into ctx */
  draw(ctx: Ctx2D, source: OffscreenCanvas) {
    const f = this.filter(whole(source));
    ctx.drawImage(f.img, f.x, f.y, f.w, f.h);
  }
}
/** a filter of one input image, which is the source where it has none */
abstract class Unary extends NativeRenderEffect {
  private readonly input: NativeRenderEffect | null;
  constructor(input: NativeRenderEffect | null) { super(); this.input = input; }
  filter(source: Filtered): Filtered { return this.apply(this.input ? this.input.filter(source) : source); }
  protected abstract apply(f: Filtered): Filtered;
}
class Offset extends Unary {
  private readonly dx: number; private readonly dy: number;
  constructor(dx: number, dy: number, input: NativeRenderEffect | null) { super(input); this.dx = dx; this.dy = dy; }
  protected apply(f: Filtered): Filtered { return { ...f, x: f.x + this.dx, y: f.y + this.dy }; }
}
class Blur extends Unary implements BlurCache {
  private readonly tile: number;
  padded: OffscreenCanvas | null = null;
  blurred: OffscreenCanvas | null = null;
  private work = new Float32Array(0);
  private scratch = new Float32Array(0);
  private readonly sx: number; private readonly sy: number;
  constructor(rx: number, ry: number, tile: number, input: NativeRenderEffect | null) {
    super(input);
    this.tile = tile;
    this.sx = radiusToSigma(rx); this.sy = radiusToSigma(ry);
  }
  protected apply(f: Filtered): Filtered {
    if (!this.sx && !this.sy) return f;
    const source = flatten(this.out, f);
    this.out = source;
    // Unequal sigmas: shrink the more blurred axis, blur uniformly, and stretch back.
    const sigma = Math.min(this.sx || this.sy, this.sy || this.sx), kx = this.sx ? sigma / this.sx : 1, ky = this.sy ? sigma / this.sy : 1;
    const w = Math.max(1, Math.ceil(source.width * kx)), h = Math.max(1, Math.ceil(source.height * ky));
    const pad = Math.ceil(sigma * 3), width = w + pad * 2, height = h + pad * 2;
    const surface = padded(this, source, w, h, pad, this.tile);
    const scaleX = f.w / source.width, scaleY = f.h / source.height;
    if (this.sx && this.sy) {
      return { img: gaussian(this, surface, sigma), x: f.x - pad / kx * scaleX, y: f.y - pad / ky * scaleY, w: width / kx * scaleX, h: height / ky * scaleY };
    }
    this.boxBlur(surface, width, height, sigma, !!this.sx);
    return { img: surface, x: f.x - pad * scaleX, y: f.y - pad * scaleY, w: width * scaleX, h: height * scaleY };
  }
  /** three box passes along one axis, which approximate its Gaussian in linear time */
  private boxBlur(surface: OffscreenCanvas, width: number, height: number, sigma: number, horizontal: boolean) {
    const target = surface.getContext("2d")!, pixels = target.getImageData(0, 0, width, height), data = pixels.data;
    if (this.work.length !== data.length) { this.work = new Float32Array(data.length); this.scratch = new Float32Array(data.length); }
    let input = this.work, output = this.scratch;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]; input[i + 3] = alpha;
      for (let c = 0; c < 3; c++) input[i + c] = data[i + c] * alpha / 255;
    }
    const ideal = Math.sqrt(4 * sigma * sigma + 1), lower = Math.floor(ideal) | 1;
    const small = lower > ideal ? lower - 2 : lower;
    const count = Math.round((12 * sigma * sigma - 3 * small * small - 12 * small - 9) / (-4 * small - 4));
    const length = horizontal ? width : height, lines = horizontal ? height : width, stride = horizontal ? 4 : width * 4;
    for (let pass = 0; pass < 3; pass++) {
      const box = pass < count ? small : small + 2, half = (box - 1) / 2;
      for (let line = 0; line < lines; line++) for (let c = 0; c < 4; c++) {
        const start = (horizontal ? line * width : line) * 4 + c;
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
    target.putImageData(pixels, 0, 0);
  }
}
/** SkImageFilters::Image: the bitmap's src rect drawn into dst, whatever the input */
class BitmapEffect extends NativeRenderEffect {
  private readonly bitmap: NativeBitmap; private readonly src: number[]; private readonly dst: number[];
  constructor(bitmap: NativeBitmap, src: number[], dst: number[]) { super(); this.bitmap = bitmap; this.src = src; this.dst = dst; }
  filter(): Filtered {
    const [sl, st, sr, sb] = this.src, [dl, dt, dr, db] = this.dst, w = Math.max(1, Math.ceil(dr - dl)), h = Math.max(1, Math.ceil(db - dt));
    const c = this.out = sized(this.out, w, h), g = c.getContext("2d")!;
    g.reset(); g.drawImage(this.bitmap.image, sl, st, sr - sl, sb - st, 0, 0, dr - dl, db - dt);
    return { img: c, x: dl, y: dt, w: dr - dl, h: db - dt };
  }
}
class ColorFilterEffect extends Unary {
  private readonly cf: NativeColorFilter;
  constructor(cf: NativeColorFilter, input: NativeRenderEffect | null) { super(input); this.cf = cf; }
  protected apply(f: Filtered): Filtered {
    const c = this.out = flatten(this.out, f);
    this.cf.apply(c.getContext("2d")!, c.width, c.height);
    return { img: c, x: f.x, y: f.y, w: f.w, h: f.h };
  }
}
/** SkImageFilters::Blend: src over dst by the mode's op (null for DST, which keeps dst alone), over
 *  the union of their placements */
class BlendEffect extends NativeRenderEffect {
  private readonly dst: NativeRenderEffect | null; private readonly src: NativeRenderEffect | null; private readonly op: GlobalCompositeOperation | null;
  constructor(dst: NativeRenderEffect | null, src: NativeRenderEffect | null, op: GlobalCompositeOperation | null) { super(); this.dst = dst; this.src = src; this.op = op; }
  filter(source: Filtered): Filtered {
    const d = this.dst ? this.dst.filter(source) : source, s = this.src ? this.src.filter(source) : source;
    const x = Math.min(d.x, s.x), y = Math.min(d.y, s.y), w = Math.max(d.x + d.w, s.x + s.w) - x, h = Math.max(d.y + d.h, s.y + s.h) - y;
    const c = this.out = sized(this.out, Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))), g = c.getContext("2d")!;
    g.reset();
    g.drawImage(d.img, d.x - x, d.y - y, d.w, d.h);
    if (this.op) { g.globalCompositeOperation = this.op; g.drawImage(s.img, s.x - x, s.y - y, s.w, s.h); }
    return { img: c, x, y, w, h };
  }
}
class Chain extends NativeRenderEffect {
  private readonly outer: NativeRenderEffect; private readonly inner: NativeRenderEffect;
  constructor(outer: NativeRenderEffect, inner: NativeRenderEffect) { super(); this.outer = outer; this.inner = inner; }
  filter(source: Filtered): Filtered { return this.outer.filter(this.inner.filter(source)); }
}
/** SkImageFilters::Shader: the shader over the content's bounds, whatever the input */
class ShaderEffect extends NativeRenderEffect {
  private readonly shader: NativeShader;
  constructor(shader: NativeShader) { super(); this.shader = shader; }
  filter(source: Filtered): Filtered {
    const c = this.out = sized(this.out, Math.max(1, Math.ceil(source.w)), Math.max(1, Math.ceil(source.h))), g = c.getContext("2d")!;
    g.reset(); g.translate(-source.x, -source.y);
    this.shader.fillClip(g);
    return { img: c, x: source.x, y: source.y, w: source.w, h: source.h };
  }
}
/** the input image as a shader in node coordinates, what a runtime shader's child samples */
class ImageShader extends NativeShader {
  private readonly f: Filtered;
  constructor(f: Filtered) { super(null); this.f = f; }
  override pattern(ctx: Ctx2D): CanvasPattern | null {
    const p = ctx.createPattern(this.f.img, "no-repeat");
    p?.setTransform(new DOMMatrix([this.f.w / this.f.img.width, 0, 0, this.f.h / this.f.img.height, this.f.x, this.f.y]));
    return p;
  }
}
/** SkImageFilters::RuntimeShader: the builder's shader with its child `name` bound to the input. The
 *  uniforms are the builder's at draw time, where hwui copies them when the effect is made. */
class RuntimeShaderEffect extends NativeRenderEffect {
  private readonly builder: RuntimeShaderBuilder; private readonly name: string;
  constructor(builder: RuntimeShaderBuilder, name: string) { super(); this.builder = builder; this.name = name; }
  filter(source: Filtered): Filtered {
    return new ShaderEffect(this.builder.withChild(this.name, new ImageShader(source))).filter(source);
  }
}

const effectAt = (h: bigint) => (h ? deref<NativeRenderEffect>(h) : null);
rt.registerJnis("android/graphics/RenderEffect", {
  "nativeCreateOffsetEffect(FFJ)J": (x: number, y: number, input: bigint) => handle(new Offset(x, y, effectAt(input))),
  "nativeCreateBlurEffect(FFJI)J": (rx: number, ry: number, input: bigint, tile: number) => handle(new Blur(rx, ry, tile, effectAt(input))),
  "nativeCreateBitmapEffect(JFFFFFFFF)J": (b: bigint, sl: number, st: number, sr: number, sb: number, dl: number, dt: number, dr: number, db: number) =>
    handle(new BitmapEffect(deref<NativeBitmap>(b), [sl, st, sr, sb], [dl, dt, dr, db])),
  "nativeCreateColorFilterEffect(JJ)J": (cf: bigint, input: bigint) => handle(new ColorFilterEffect(deref<NativeColorFilter>(cf), effectAt(input))),
  "nativeCreateBlendModeEffect(JJI)J": (dst: bigint, src: bigint, mode: number) =>
    handle(new BlendEffect(effectAt(dst), effectAt(src), compositeOf(mode))),
  "nativeCreateChainEffect(JJ)J": (outer: bigint, inner: bigint) => handle(new Chain(effectAt(outer)!, effectAt(inner)!)),
  "nativeCreateShaderEffect(J)J": (s: bigint) => handle(new ShaderEffect(deref<NativeShader>(s))),
  "nativeCreateRuntimeShaderEffect(JLjava/lang/String;)J": (b: bigint, name: string) => handle(new RuntimeShaderEffect(deref<RuntimeShaderBuilder>(b), name)),
  "nativeGetFinalizer()J": () => FINALIZER,
});
