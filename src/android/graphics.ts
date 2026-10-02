// android.graphics.* → HTML Canvas 2D. Colors are Java ARGB ints (signed).

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import type { NativeBitmap } from "./bitmap";
import type { Ctx2D } from "./recording";
import { parcelCreator } from "./parcelable";
import type { Affine } from "./matrix";
import type { JParcel } from "./parcel";

const cssCache = new Map<number, string>();
export function cssColor(argb: number): string {
  let s = cssCache.get(argb);
  if (s === undefined) {
    if (cssCache.size >= 4096) cssCache.clear();
    cssCache.set(argb, s = `rgba(${(argb >> 16) & 0xff},${(argb >> 8) & 0xff},${argb & 0xff},${((argb >>> 24) / 255).toFixed(3)})`);
  }
  return s;
}

export class JRect extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
/** CREATOR for Rect, RectF, Point and PointF, whose platform <clinit> does not run under a spec:
 *  it reads the coordinates as ints or floats, in field order, as their readFromParcel does */
function geometryCreator(name: string, fields: string[], float: boolean) {
  const type = float ? "Float" : "Int", desc = float ? "F" : "I";
  const read = driven(function* readGeometry(o: Record<string, unknown>, p: JParcel): Gen {
    for (const f of fields) o[f] = yield vcall(p, `read${type}`, `()${desc}`);
    return o;
  });
  return { get CREATOR() { return parcelCreator(name, (p) => read(rt.make(name) as JObj & Record<string, unknown>, p)); } };
}
const RECT_FIELDS = ["left", "top", "right", "bottom"], POINT_FIELDS = ["x", "y"], PARCELABLE = ["android/os/Parcelable"];
// The geometry values keep only their layout, which our stack reads; every method is AOSP's.
rt.register({ name: "android/graphics/Rect", ctor: JRect, ifaces: PARCELABLE, fields: RECT_FIELDS, statics: geometryCreator("android/graphics/Rect", RECT_FIELDS, false) });
/** a RectF: its own class, since fallthrough would otherwise give it Rect's same-descriptor bodies */
export class JRectF extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
rt.register({ name: "android/graphics/RectF", ctor: JRectF, ifaces: PARCELABLE, fields: RECT_FIELDS, statics: geometryCreator("android/graphics/RectF", RECT_FIELDS, true) });
export class JPoint extends JObj { x = 0; y = 0; }
rt.register({ name: "android/graphics/Point", ctor: JPoint, ifaces: PARCELABLE, fields: POINT_FIELDS, statics: geometryCreator("android/graphics/Point", POINT_FIELDS, false) });
rt.register({ name: "android/graphics/PointF", ctor: class extends JObj { x = 0; y = 0; }, ifaces: PARCELABLE, fields: POINT_FIELDS, statics: geometryCreator("android/graphics/PointF", POINT_FIELDS, true) });

// android.graphics.Insets — immutable 4-sided inset value (WindowInsets.getInsets() etc).
export class JInsets extends JObj { left = 0; top = 0; right = 0; bottom = 0; }
const INSETS_NONE = new JInsets();
/** Mirrors Insets.of(): the all-zero case returns the cached NONE singleton, like AOSP. */
export function insetsOf(l: number, t: number, r: number, b: number): JInsets {
  if (l === 0 && t === 0 && r === 0 && b === 0) return INSETS_NONE;
  const i = new JInsets(); i.left = l; i.top = t; i.right = r; i.bottom = b; return i;
}
rt.register({ name: "android/graphics/Insets", ctor: JInsets, fields: ["left", "top", "right", "bottom"], statics: { NONE: INSETS_NONE } });

/**
 * A blend mode, by BlendMode's name, → the Canvas2D composite operation with the same meaning;
 * modes Canvas2D cannot express are absent and fall back to plain source-over.
 * CLEAR maps to destination-out, which clears only where the source is opaque: prep() fills a
 * CLEAR shape opaquely, since Skia's CLEAR ignores the paint's colour (Compose punches holes with a
 * transparent one).
 */
export const COMPOSITE: Record<string, GlobalCompositeOperation> = {
  CLEAR: "destination-out", SRC: "copy", SRC_OVER: "source-over", DST_OVER: "destination-over",
  SRC_IN: "source-in", DST_IN: "destination-in", SRC_OUT: "source-out", DST_OUT: "destination-out",
  SRC_ATOP: "source-atop", DST_ATOP: "destination-atop", XOR: "xor", PLUS: "lighter",
  MODULATE: "multiply", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay",
  DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference",
  EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};
/** SkBlendMode by value, in BlendMode's names: PorterDuff.Mode.nativeInt, Xfermode.porterDuffMode
 *  and the ColorFilter and ComposeShader natives all number modes this way */
export const BLEND_MODES = ["CLEAR", "SRC", "DST", "SRC_OVER", "DST_OVER", "SRC_IN", "DST_IN", "SRC_OUT", "DST_OUT",
  "SRC_ATOP", "DST_ATOP", "XOR", "PLUS", "MODULATE", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN",
  "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT", "SOFT_LIGHT", "DIFFERENCE", "EXCLUSION", "MULTIPLY",
  "HUE", "SATURATION", "COLOR", "LUMINOSITY"];
/**
 * A ColorFilter's native instance, as hwui builds its SkColorFilter: AOSP's row-major 4x5 colour
 * `matrix` with its offsets in 0..255 (SkColorFilters::Matrix and Lighting), or, when that is null,
 * `color` blended into what is drawn by the mode named `mode` (SkColorFilters::Blend).
 * The Lighting and ColorMatrix setters update `matrix` in place, and a paint holding it sees them.
 */
export class NativeColorFilter {
  constructor(readonly matrix: Float32Array | null, readonly color = 0, readonly mode = "DST") {}
}
/**
 * A Shader's native instance: what it paints, under the local matrix it was created with (null
 * for identity). It never changes; Shader discards it and makes another when the Java side does.
 */
export abstract class NativeShader {
  constructor(readonly local: Affine | null) {}
  abstract pattern(ctx: Ctx2D): CanvasGradient | CanvasPattern | null;
  /** the pattern is made for the target a draw lands on, so a display list makes it at replay */
  get atReplay(): boolean { return false; }
}
export const shaderIdentity: Affine = [1, 0, 0, 1, 0, 0];
const bitmapShaderTiles = new WeakMap<NativeBitmap, { generation: number; tiles: Map<string, CanvasPattern> }>();
/** tileX/tileY: Shader.TileMode's nativeInt (CLAMP, REPEAT, MIRROR, DECAL) */
export class NativeBitmapShader extends NativeShader {
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  constructor(local: Affine | null, readonly bitmap: NativeBitmap, readonly tileX: number, readonly tileY: number) { super(local); }
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
  private cached: CanvasPattern | null = null;
  private cacheKey = "";
  /** `op` is null for DST, which keeps the destination shader alone */
  constructor(local: Affine | null, readonly dst: NativeShader, readonly src: NativeShader, readonly op: GlobalCompositeOperation | null) { super(local); }
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
  new NativeComposeShader(local, dst, src, mode === 2 ? null : COMPOSITE[BLEND_MODES[mode]] ?? "source-over");
export class NativeGradient extends NativeShader {
  constructor(local: Affine | null, readonly grad: CanvasGradient) { super(local); }
  override pattern(): CanvasGradient { return this.grad; }
}
/** a gradient's native instance: its ColorLongs at `positions` (evenly spaced when null), which
 *  SkGradientShader pins to [0, 1] and to no less than the position before */
export function gradient(local: Affine | null, g: CanvasGradient, colors: BigInt64Array, positions: Float32Array | null): NativeGradient {
  for (let i = 0, prev = 0; i < colors.length; i++) {
    const at = positions ? prev = Math.min(Math.max(positions[i], prev), 1) : i / (colors.length - 1);
    g.addColorStop(at, cssColor(argbOfColorLong(colors[i])));
  }
  return new NativeGradient(local, g);
}
/**
 * A ColorLong is Color.pack()'s encoding: the sRGB case (colour-space id 0, the only one this
 * canvas has) is the ARGB int in the top 32 bits, which is what getColorLong writes.
 */
export const argbOfColorLong = (v: bigint) => Number(BigInt.asUintN(32, v >> 32n)) | 0;


export function canvasLocalBounds(ctx: Ctx2D): [number, number, number, number] | null {
  const inverse = ctx.getTransform().inverse();
  const points = [[0, 0], [ctx.canvas.width, 0], [0, ctx.canvas.height], [ctx.canvas.width, ctx.canvas.height]]
    .map(([x, y]) => inverse.transformPoint({ x, y }));
  if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  return [Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)),
    Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y))];
}
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
