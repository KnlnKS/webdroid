// android.graphics.* → HTML Canvas 2D: colours (Java ARGB ints, signed), Rect edges, blend modes
// and Color's natives. Colour filters are colorfilter.ts, shaders shader.ts.

import { rt, declaredField } from "../jvm/runtime.ts";
import { classNameOf } from "../jvm/natives/jentry.ts";

const cssCache = new Map<number, string>();
export function cssColor(argb: number): string {
  let s = cssCache.get(argb);
  if (s === undefined) {
    if (cssCache.size >= 4096) cssCache.clear();
    cssCache.set(argb, s = `rgba(${(argb >> 16) & 0xff},${(argb >> 8) & 0xff},${argb & 0xff},${((argb >>> 24) / 255).toFixed(3)})`);
  }
  return s;
}

/** a box with Rect's edges; Java Rects and RectFs keep theirs in AOSP's fields (edges, setEdges) */
export type Box = { left: number; top: number; right: number; bottom: number };
const edgeProps = new Map<string, string[]>();
function edgesOf(r: object): string[] {
  const cls = classNameOf(r)!;
  let props = edgeProps.get(cls);
  if (!props) edgeProps.set(cls, props = ["left", "top", "right", "bottom"].map((e) => declaredField(cls, e)));
  return props;
}
/** a Java Rect's or RectF's edges */
export function edges(r: object): Box {
  const [l, t, rgt, b] = edgesOf(r), o = r as Record<string, number>;
  return { left: o[l], top: o[t], right: o[rgt], bottom: o[b] };
}
export function setEdges(r: object, box: Box): void {
  const [l, t, rgt, b] = edgesOf(r), o = r as Record<string, number>;
  o[l] = box.left; o[t] = box.top; o[rgt] = box.right; o[b] = box.bottom;
}
export const emptyBox: Readonly<Box> = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * A blend mode, by BlendMode's name, → the Canvas2D composite operation with the same meaning;
 * modes Canvas2D cannot express are absent and fall back to plain source-over.
 * CLEAR maps to destination-out, which clears only where the source is opaque: NativePaint.fillStyle
 * fills a CLEAR shape opaquely, since Skia's CLEAR ignores the paint's colour (Compose punches holes
 * with a transparent one). DST is absent too: a draw by it changes nothing.
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
// Skia's SkRGBToHSV and SkHSVToColor, in float as Skia computes them
const f = Math.fround, round = (x: number) => Math.floor(x + 0.5);
rt.registerJnis("android/graphics/Color", {
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
