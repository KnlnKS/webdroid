import { rt, JObj } from "../jvm/runtime";
import type { JRect } from "./graphics";

export const G = {
  LEFT: 3, RIGHT: 5, TOP: 48, BOTTOM: 80, CENTER_H: 1, CENTER_V: 16, CENTER: 17,
  START: 0x00800003, END: 0x00800005, FILL: 119, H_MASK: 7 | 0x00800000, V_MASK: 112,
};
export function gravityH(g: number): number {
  const h = g & 0x800007;
  if (h === G.START || h === 3) return 3;
  if (h === G.END || h === 5) return 5;
  if ((g & 7) === 1) return 1;
  return 3;
}
export function gravityV(g: number): number {
  const v = g & 112;
  return v === 80 ? 80 : v === 16 ? 16 : 48;
}
rt.register({
  name: "android/view/Gravity", ctor: class extends JObj {},
  statics: {
    LEFT: 3, RIGHT: 5, TOP: 48, BOTTOM: 80, CENTER_HORIZONTAL: 1, CENTER_VERTICAL: 16,
    CENTER: 17, START: G.START, END: G.END, FILL: 119, NO_GRAVITY: 0,
    FILL_HORIZONTAL: 7, FILL_VERTICAL: 112,
  },
  methods: {
    "static getAbsoluteGravity(II)I": absGravity,
    "static apply(IIILandroid/graphics/Rect;Landroid/graphics/Rect;)V": (g: number, w: number, h: number, c: JRect, out: JRect) => gravityApply(g, w, h, c, 0, 0, out),
    "static apply(IIILandroid/graphics/Rect;Landroid/graphics/Rect;I)V": (g: number, w: number, h: number, c: JRect, out: JRect, ld: number) => gravityApply(absGravity(g, ld), w, h, c, 0, 0, out),
    "static apply(IIILandroid/graphics/Rect;IILandroid/graphics/Rect;)V": (g: number, w: number, h: number, c: JRect, x: number, y: number, out: JRect) => gravityApply(g, w, h, c, x, y, out),
    "static apply(IIILandroid/graphics/Rect;IILandroid/graphics/Rect;I)V": (g: number, w: number, h: number, c: JRect, x: number, y: number, out: JRect, ld: number) => gravityApply(absGravity(g, ld), w, h, c, x, y, out),
    "static applyDisplay(ILandroid/graphics/Rect;Landroid/graphics/Rect;)V": (g: number, disp: JRect, inout: JRect) => {
      // AOSP: DISPLAY_CLIP_* clip to the display, otherwise push the rect back inside it
      if (inout.left < disp.left) { inout.right += disp.left - inout.left; inout.left = disp.left; }
      if (inout.right > disp.right) { inout.left -= inout.right - disp.right; inout.right = disp.right; }
      if (inout.top < disp.top) { inout.bottom += disp.top - inout.top; inout.top = disp.top; }
      if (inout.bottom > disp.bottom) { inout.top -= inout.bottom - disp.bottom; inout.bottom = disp.bottom; }
    },
    "static isHorizontal(I)Z": (g: number) => (g & 0x800007) ? 1 : 0,
    "static isVertical(I)Z": (g: number) => (g & 112) ? 1 : 0,
  },
});
/** AOSP Gravity.getAbsoluteGravity: START/END resolve by layout direction, the relative bit drops */
function absGravity(g: number, ld = 0): number {
  if (g & 0x00800000) {
    const rtl = ld === 1;
    if ((g & G.START) === G.START) g = (g & ~G.START) | (rtl ? 5 : 3);
    else if ((g & G.END) === G.END) g = (g & ~G.END) | (rtl ? 3 : 5);
    g &= ~0x00800000;
  }
  return g;
}
/** AOSP Gravity.apply: per axis AXIS_PULL_BEFORE(2)/AXIS_PULL_AFTER(4) select the edge, both
 *  mean FILL, neither means centre; AXIS_CLIP(8) clips the result to the container */
function gravityApply(g: number, w: number, h: number, c: JRect, xAdj: number, yAdj: number, out: JRect) {
  const axis = (bits: number, dim: number, lo: number, hi: number, adj: number): [number, number] => {
    const pull = bits & 6, clip = bits & 8;
    if (pull === 6) return [lo + adj, hi + adj];
    let a = pull === 2 ? lo + adj : pull === 4 ? hi + adj - dim : lo + (((hi - lo) - dim) >> 1) + adj;
    let b = a + dim;
    if (clip) { if (a < lo) a = lo; if (b > hi) b = hi; }
    return [a, b];
  };
  [out.left, out.right] = axis(g & 0xf, w, c.left, c.right, xAdj);
  [out.top, out.bottom] = axis((g >> 4) & 0xf, h, c.top, c.bottom, yAdj);
}
