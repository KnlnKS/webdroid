import { rt, JObj } from "../jvm/runtime";
import { type JSimpleEnum } from "../jvm/natives/jlang";

type Effect = { kind: "offset"; x: number; y: number } | { kind: "blur"; x: number; y: number; tile: number };
export class JRenderEffect extends JObj {
  effect: Effect = { kind: "offset", x: 0, y: 0 };
  private surface: OffscreenCanvas | null = null;
  private filtered: OffscreenCanvas | null = null;
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
    const surface = this.surface ??= new OffscreenCanvas(width, height);
    if (surface.width !== width) surface.width = width;
    if (surface.height !== height) surface.height = height;
    const target = surface.getContext("2d")!;
    target.reset();
    target.drawImage(source, pad, pad, w, h);
    if (e.tile === 0) {
      const xs = [[0, 1, 0, pad], [0, source.width, pad, w], [source.width - 1, 1, pad + w, pad]];
      const ys = [[0, 1, 0, pad], [0, source.height, pad, h], [source.height - 1, 1, pad + h, pad]];
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        if (x === 1 && y === 1) continue;
        const [a, b, c, d] = xs[x], [i, j, k, l] = ys[y];
        target.drawImage(source, a, i, b, j, c, k, d, l);
      }
    } else if (e.tile !== 3) {
      for (let y = -Math.ceil(pad / h); y <= Math.ceil(pad / h); y++) for (let x = -Math.ceil(pad / w); x <= Math.ceil(pad / w); x++) {
        if (!x && !y) continue;
        const flipX = e.tile === 2 && x % 2 !== 0, flipY = e.tile === 2 && y % 2 !== 0;
        target.save(); target.translate(pad + x * w + (flipX ? w : 0), pad + y * h + (flipY ? h : 0));
        target.scale(flipX ? -1 : 1, flipY ? -1 : 1); target.drawImage(source, 0, 0, w, h); target.restore();
      }
    }
    if (e.x && e.y) {
      const filtered = this.filtered ??= new OffscreenCanvas(width, height);
      if (filtered.width !== width) filtered.width = width;
      if (filtered.height !== height) filtered.height = height;
      const blur = filtered.getContext("2d")!; blur.reset();
      blur.filter = `blur(${radius}px)`; blur.drawImage(surface, 0, 0);
      ctx.drawImage(filtered, -pad / sx, -pad / sy, width / sx, height / sy);
    } else {
      const pixels = target.getImageData(0, 0, width, height), data = pixels.data;
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
  "static createOffsetEffect(FF)Landroid/graphics/RenderEffect;": (x: number, y: number) => effect({ kind: "offset", x, y }),
  "static createBlurEffect(FFLandroid/graphics/Shader$TileMode;)Landroid/graphics/RenderEffect;": (x: number, y: number, tile: JSimpleEnum) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid blur radius");
    return effect({ kind: "blur", x, y, tile: tile.ord });
  },
} });
