// Shader's native half: the SkShaders a paint fills with, as Canvas2D gradients and patterns.

import { rt } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { type NativeBitmap, colorLongAt } from "./bitmap.ts";
import type { Ctx2D } from "./recording.ts";
import { canvasLocalBounds, localMatrix, type Affine } from "./matrix.ts";
import { compositeOf, cssColor } from "./graphics.ts";

/**
 * A Shader's native instance: what it paints, under the local matrix it was created with (null
 * for identity). It never changes; Shader discards it and makes another when the Java side does.
 */
export abstract class NativeShader {
  readonly local: Affine | null;
  constructor(local: Affine | null) { this.local = local; }
  abstract pattern(ctx: Ctx2D): CanvasGradient | CanvasPattern | null;
  /** the pattern is made for the target a draw lands on, so a display list makes it at replay */
  get atReplay(): boolean { return false; }
}
export const shaderIdentity: Affine = [1, 0, 0, 1, 0, 0];
const bitmapShaderTiles = new WeakMap<NativeBitmap, { generation: number; tiles: Map<string, CanvasPattern> }>();
/** tileX/tileY: Shader.TileMode's nativeInt (CLAMP, REPEAT, MIRROR, DECAL) */
export class NativeBitmapShader extends NativeShader {
  readonly bitmap: NativeBitmap; readonly tileX: number; readonly tileY: number;
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  constructor(local: Affine | null, bitmap: NativeBitmap, tileX: number, tileY: number) { super(local); this.bitmap = bitmap; this.tileX = tileX; this.tileY = tileY; }
  // its pattern() covers the target's canvas
  override get atReplay(): boolean { return true; }
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
    const bitmap = this.bitmap;
    let cache = bitmapShaderTiles.get(bitmap);
    if (!cache || cache.generation !== bitmap.genId) {
      cache = { generation: bitmap.genId, tiles: new Map() };
      bitmapShaderTiles.set(bitmap, cache);
    }
    const bounds = canvasLocalBounds(ctx);
    if (!bounds) return;
    const segments = (mode: number, size: number, lo: number, hi: number): [number, number, number, number][] => {
      if (mode === 1 || mode === 2) return [[lo, hi, 0, size]];
      const result: [number, number, number, number][] = [[Math.max(0, lo), Math.min(size, hi), 0, size]];
      if (mode === 0) result.push([lo, Math.min(0, hi), 0, 1], [Math.max(size, lo), hi, size - 1, 1]);
      return result;
    };
    const xs = segments(this.tileX, bitmap.w, bounds[0], bounds[2]);
    const ys = segments(this.tileY, bitmap.h, bounds[1], bounds[3]);
    for (const [x0, x1, sx, sw] of xs) for (const [y0, y1, sy, sh] of ys) {
      if (x1 <= x0 || y1 <= y0) continue;
      const nx = this.tileX === 2 ? 2 : 1, ny = this.tileY === 2 ? 2 : 1;
      const key = `${sx},${sy},${sw},${sh},${nx},${ny}`;
      let pattern = cache.tiles.get(key);
      if (!pattern) {
        let tile = bitmap.image;
        if (sx !== 0 || sy !== 0 || sw !== bitmap.w || sh !== bitmap.h || nx !== 1 || ny !== 1) {
          tile = new OffscreenCanvas(sw * nx, sh * ny);
          const c = tile.getContext("2d")!;
          for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
            c.setTransform(x ? -1 : 1, 0, 0, y ? -1 : 1, x ? sw * 2 : 0, y ? sh * 2 : 0);
            c.drawImage(bitmap.image, sx, sy, sw, sh, 0, 0, sw, sh);
          }
        }
        pattern = ctx.createPattern(tile, "repeat")!;
        cache.tiles.set(key, pattern);
      }
      ctx.fillStyle = pattern;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  override pattern(ctx: Ctx2D): CanvasPattern {
    const matrix = ctx.getTransform(), local = this.local;
    const key = `${this.bitmap.genId}:${ctx.canvas.width},${ctx.canvas.height}:${matrix.toString()}:${local}`;
    if (this.cached && key === this.cacheKey) return this.cached;
    // Strokes and text cannot clip a Canvas2D path to its stroked outline.
    const surface = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height), c = surface.getContext("2d")!;
    c.setTransform(matrix);
    if (local) c.transform(...local);
    this.draw(c);
    const pattern = ctx.createPattern(surface, "no-repeat")!;
    pattern.setTransform(matrix.inverse());
    this.cacheKey = key;
    return this.cached = pattern;
  }
}
/** fills everything `c` can show with `s`; a pattern shader applies its own local matrix */
export function fillWithShader(c: OffscreenCanvasRenderingContext2D, s: NativeShader) {
  const style = s.pattern(c);
  if (!style) return;
  if (s.local && style instanceof CanvasGradient) c.transform(...s.local);
  const bounds = canvasLocalBounds(c);
  if (!bounds) return;
  c.fillStyle = style;
  c.fillRect(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]);
}
/** ComposeShader: `src` blended onto `dst` by the mode, rasterized over the target once per transform */
export class NativeComposeShader extends NativeShader {
  readonly dst: NativeShader; readonly src: NativeShader; readonly op: GlobalCompositeOperation | null;
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  /** `op` is null for DST, which keeps the destination shader alone */
  constructor(local: Affine | null, dst: NativeShader, src: NativeShader, op: GlobalCompositeOperation | null) { super(local); this.dst = dst; this.src = src; this.op = op; }
  override pattern(ctx: Ctx2D): CanvasPattern {
    const matrix = ctx.getTransform(), { width, height } = ctx.canvas;
    const key = `${width},${height}:${matrix.toString()}:${this.local}`;
    if (this.cached && key === this.cacheKey) return this.cached;
    const c = new OffscreenCanvas(width, height).getContext("2d")!;
    const base = this.local ? matrix.multiply(new DOMMatrix(this.local)) : matrix;
    c.setTransform(base);
    fillWithShader(c, this.dst);
    if (this.op) {
      c.setTransform(base);
      c.globalCompositeOperation = this.op;
      fillWithShader(c, this.src);
    }
    const pattern = ctx.createPattern(c.canvas, "no-repeat")!;
    pattern.setTransform(matrix.inverse());
    this.cacheKey = key;
    return this.cached = pattern;
  }
}
/** a ComposeShader's native instance: `src` over `dst` by the SkBlendMode numbered `mode` */
export const composeShader = (local: Affine | null, dst: NativeShader, src: NativeShader, mode: number) =>
  new NativeComposeShader(local, dst, src, compositeOf(mode));
/** a gradient's style: a CanvasGradient, or the pattern of a tiled one, which carries the local matrix */
export class NativeGradient extends NativeShader {
  readonly style: CanvasGradient | CanvasPattern;
  constructor(local: Affine | null, style: CanvasGradient | CanvasPattern) { super(local); this.style = style; }
  override pattern(): CanvasGradient | CanvasPattern { return this.style; }
}
let scratch: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
/** a 2D context that makes gradients for any canvas */
export function scratch2d(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  return scratch ??= (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")).getContext("2d") as OffscreenCanvasRenderingContext2D;
}
/** a gradient's native instance: its sRGB ARGB colours at `positions` (evenly spaced when null),
 *  which SkGradientShader pins to [0, 1] and to no less than the position before */
export function gradient(local: Affine | null, g: CanvasGradient, colors: Int32Array, positions: Float32Array | null): NativeGradient {
  return new NativeGradient(local, withStops(g, colors, positions));
}
function withStops(g: CanvasGradient, colors: Int32Array, positions: Float32Array | null): CanvasGradient {
  for (let i = 0, prev = 0; i < colors.length; i++) {
    const at = positions ? prev = Math.min(Math.max(positions[i], prev), 1) : i / (colors.length - 1);
    g.addColorStop(at, cssColor(colors[i]));
  }
  return g;
}
/** the texels of one period of a tiled gradient */
const STRIP = 1024;
/** a LinearGradient by Shader.TileMode's nativeInt `tile`. A Canvas2D gradient only clamps, so a
 *  REPEAT, MIRROR or DECAL one is a strip of a period (and its reflection, for MIRROR) that a
 *  pattern lays along the gradient's line, repeated (DECAL: transparent past its ends) and
 *  stretched across it. */
function linearGradient(local: Affine | null, x0: number, y0: number, x1: number, y1: number, colors: Int32Array, positions: Float32Array | null, tile: number): NativeGradient {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (tile === 0 || !len) return gradient(local, scratch2d().createLinearGradient(x0, y0, x1, y1), colors, positions);
  // DECAL's strip ends in a texel of each end colour, so filtering fades it out past the ends, not before
  const mirror = tile === 2, pad = tile === 3 ? 1 : 0, w = (mirror ? 2 * STRIP : STRIP) + 2 * pad;
  const c = new OffscreenCanvas(w, 1).getContext("2d")!;
  c.fillStyle = withStops(c.createLinearGradient(pad, 0, pad + STRIP, 0), colors, positions);
  c.fillRect(0, 0, STRIP + 2 * pad, 1);
  if (mirror) { c.setTransform(-1, 0, 0, 1, 2 * STRIP, 0); c.drawImage(c.canvas, 0, 0, STRIP, 1, 0, 0, STRIP, 1); }
  const pattern = scratch2d().createPattern(c.canvas, pad ? "repeat-y" : "repeat")!;
  const ux = dx / STRIP, uy = dy / STRIP, strip = new DOMMatrix([ux, uy, -dy / len, dx / len, x0 - pad * ux, y0 - pad * uy]);
  pattern.setTransform(local ? new DOMMatrix(local).multiply(strip) : strip);
  return new NativeGradient(local, pattern);
}

rt.registerJnis("android/graphics/Shader", { "nativeGetFinalizer()J": () => FINALIZER });
// `m` is the local matrix's handle, 0 for identity
/** a gradient's ColorLongs, which Shader requires to share the space handle `cs` names, as sRGB ARGB */
const stopColors = (colors: BigInt64Array, cs: bigint) => Int32Array.from(colors, (c) => colorLongAt(c, cs));
rt.registerJnis("android/graphics/LinearGradient", {
  "nativeCreate(JFFFF[J[FIJ)J": (m: bigint, x0: number, y0: number, x1: number, y1: number, colors: BigInt64Array, positions: Float32Array | null, tile: number, cs: bigint) =>
    handle(linearGradient(localMatrix(m), x0, y0, x1, y1, stopColors(colors, cs), positions, tile)),
});
rt.registerJnis("android/graphics/RadialGradient", {
  "nativeCreate(JFFFFFF[J[FIJ)J": (m: bigint, fx: number, fy: number, fr: number, x: number, y: number, r: number, colors: BigInt64Array, positions: Float32Array | null, tile: number, cs: bigint) => {
    // a radial gradient's period is a ring, which no pattern repeats: it clamps
    if (tile !== 0) rt.noteMissing(`RadialGradient tile mode ${["REPEAT", "MIRROR", "DECAL"][tile - 1]}`);
    return handle(gradient(localMatrix(m), scratch2d().createRadialGradient(fx, fy, fr, x, y, r), stopColors(colors, cs), positions));
  },
});
rt.registerJnis("android/graphics/SweepGradient", {
  "nativeCreate(JFF[J[FJ)J": (m: bigint, cx: number, cy: number, colors: BigInt64Array, positions: Float32Array | null, cs: bigint) =>
    handle(gradient(localMatrix(m), scratch2d().createConicGradient(0, cx, cy), stopColors(colors, cs), positions)),
});
rt.registerJnis("android/graphics/BitmapShader", {
  "nativeCreate(JJIIIZZJ)J": (m: bigint, b: bigint, tileX: number, tileY: number) =>
    handle(new NativeBitmapShader(localMatrix(m), deref<NativeBitmap>(b), tileX, tileY)),
});
rt.registerJnis("android/graphics/ComposeShader", {
  "nativeCreate(JJJI)J": (m: bigint, dst: bigint, src: bigint, mode: number) =>
    handle(composeShader(localMatrix(m), deref<NativeShader>(dst), deref<NativeShader>(src), mode)),
});
