// android.widget.* — layouts + text/image widgets.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { mangleMethod, jarray } from "../jvm/abi";
import { vcall, mkEnumSet } from "../jvm/natives/jlang";
import { usLocale } from "../jvm/natives/jutil";
import { JCanvas, JTypeface, tfDefault, tfMedium, typefaceFor, cssColor, measureText, fontAscent, fontDescent, fontTop, fontBottom, JBitmap, JRect } from "./graphics";
import { fontResource } from "./fonts";
import { JTextPaint, spannedString, JEditable, mkStaticLayout } from "./text";
import { JDrawable, drawChild, loadDrawableRV, loadDrawable, loadColorStateList, JColorStateList, cslColor, mkCsl, ST, JBitmapDrawable } from "./drawable";
import {
  JView, JViewGroup, JLayoutParams, JMarginLP, JFrameLP, JLinearLP,
  MS_EXACTLY, MS_AT_MOST, MS_UNSPEC, specMode, specSize, makeSpec, MATCH_PARENT, WRAP_CONTENT,
  childMeasureSpec, measureChildWithMargins, measureView, layoutView,
  resolveSizeAndState, defaultSize, invalidate, requestLayout, restVelocity, initViewFromCtx,
  lpFromAttrs, AID, findById, JMotionEvent, uiState, guardCall, setFocusHook,
} from "./view";
import { JAttrSet, attrTable, onFramework, obtainStyled, resolveStyleValue, rvDimen, rvColor, rvInt, rvString, rvFloat, type RV, type Resources } from "./res";
import { TV } from "./axml";
import { device } from "../shell/config";
import { inflateLayout } from "./inflate";

const M = mangleMethod;

// Gravity
export const G = {
  LEFT: 3, RIGHT: 5, TOP: 48, BOTTOM: 80, CENTER_H: 1, CENTER_V: 16, CENTER: 17,
  START: 0x00800003, END: 0x00800005, FILL: 119, H_MASK: 7 | 0x00800000, V_MASK: 112,
};
function gravityH(g: number): number {
  const h = g & 0x800007;
  if (h === G.START || h === 3) return 3;
  if (h === G.END || h === 5) return 5;
  if ((g & 7) === 1) return 1;
  return 3;
}
function gravityV(g: number): number {
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
/** ViewGroup.generateLayoutParams(LayoutParams): keep ours, else copy size (and margins) into a fresh one */
function adoptLp<T extends JMarginLP>(Ctor: new () => T, lp: JLayoutParams | null): T {
  if (lp instanceof Ctor) return lp;
  const n = new Ctor();
  if (lp) { n.width = lp.width; n.height = lp.height; }
  if (lp instanceof JMarginLP) { n.marginL = lp.marginL; n.marginT = lp.marginT; n.marginR = lp.marginR; n.marginB = lp.marginB; }
  return n;
}

export class JFrameLayout extends JViewGroup {}
const frameMethods: NativeSpec["methods"] = {
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function () {
    const lp = new JFrameLP();
    lp.width = MATCH_PARENT; lp.height = MATCH_PARENT;
    return lp;
  },
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JFrameLayout, set: JAttrSet) {
    return lpFromAttrs(new JFrameLP(), this.jres!, set);
  },
  "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": (lp: JLayoutParams) => adoptLp(JFrameLP, lp),
  "onMeasure(II)V": async function (this: JFrameLayout, wSpec: number, hSpec: number) {
    let mw = 0, mh = 0;
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      await measureChildWithMargins(this, c, wSpec, 0, hSpec, 0);
      const lp = c.lp instanceof JMarginLP ? c.lp : null;
      mw = Math.max(mw, c.measuredW + (lp ? lp.marginL + lp.marginR : 0));
      mh = Math.max(mh, c.measuredH + (lp ? lp.marginT + lp.marginB : 0));
    }
    this.measuredW = resolveSizeAndState(Math.max(mw + this.padL + this.padR, this.minW), wSpec);
    this.measuredH = resolveSizeAndState(Math.max(mh + this.padT + this.padB, this.minH), hSpec);
    // match_parent children re-measure at final size
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      const lp = c.lp;
      if (lp && (lp.width === MATCH_PARENT || lp.height === MATCH_PARENT)) {
        const ml = lp instanceof JMarginLP ? lp.marginL + lp.marginR : 0;
        const mt = lp instanceof JMarginLP ? lp.marginT + lp.marginB : 0;
        const cw = lp.width === MATCH_PARENT
          ? makeSpec(Math.max(0, this.measuredW - this.padL - this.padR - ml), MS_EXACTLY)
          : childMeasureSpec(wSpec, this.padL + this.padR + ml, lp.width);
        const ch = lp.height === MATCH_PARENT
          ? makeSpec(Math.max(0, this.measuredH - this.padT - this.padB - mt), MS_EXACTLY)
          : childMeasureSpec(hSpec, this.padT + this.padB + mt, lp.height);
        await measureView(c, cw, ch);
      }
    }
  },
  "onLayout(ZIIII)V": async function (this: JFrameLayout) {
    const pl = this.padL, pt = this.padT;
    const pw = this.width() - this.padR, ph = this.height() - this.padB;
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      const lp = c.lp instanceof JFrameLP ? c.lp : null;
      const mlp = c.lp instanceof JMarginLP ? c.lp : null;
      const g = lp?.gravity != null && lp.gravity !== -1 ? lp.gravity : 48 | 3;
      const hg = gravityH(g), vg = gravityV(g);
      const ml = mlp?.marginL ?? 0, mt = mlp?.marginT ?? 0, mr = mlp?.marginR ?? 0, mb = mlp?.marginB ?? 0;
      let x = hg === 1 ? pl + ((pw - pl - c.measuredW) >> 1) + ml - mr
        : hg === 5 ? pw - c.measuredW - mr : pl + ml;
      let y = vg === 16 ? pt + ((ph - pt - c.measuredH) >> 1) + mt - mb
        : vg === 80 ? ph - c.measuredH - mb : pt + mt;
      await layoutView(c, x, y, x + c.measuredW, y + c.measuredH);
    }
  },
  "setForegroundGravity(I)V": () => {},
  "setMeasureAllChildren(Z)V": () => {},
};
rt.register({
  name: "android/widget/FrameLayout", ctor: JFrameLayout, sup: "android/view/ViewGroup",
  methods: frameMethods,
});
rt.register({
  name: "android/widget/FrameLayout$LayoutParams", ctor: JFrameLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  fields: { gravity: "gravity" },
  methods: {
    "<init>(II)V": function (this: JFrameLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(III)V": function (this: JFrameLP, w: number, h: number, g: number) { this.width = w; this.height = h; this.gravity = g; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JFrameLP, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
      if (o instanceof JMarginLP) { this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB; }
      if (o instanceof JFrameLP) this.gravity = o.gravity;
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JFrameLP, c: unknown, set: JAttrSet) {
      lpFromAttrs(this, set.res, set);
    },
  },
});

export class JLinearLayout extends JViewGroup {
  orientation = 0; // 0 horizontal, 1 vertical
  gravity = 48 | G.START;
  weightSum = 0;
}
const linearMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JLinearLayout, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("orientation"), AID("gravity"), AID("weightSum")], 0, 0);
      if (ta.vals[0]) this.orientation = rvInt(this.jres, ta.vals[0], 0);
      if (ta.vals[1]) this.gravity = rvInt(this.jres, ta.vals[1], this.gravity);
      if (ta.vals[2]) this.weightSum = rvFloat(this.jres, ta.vals[2], 0);
    }
  },
  "setOrientation(I)V": function (this: JLinearLayout, o: number) { this.orientation = o; requestLayout(this); },
  "getOrientation()I": function (this: JLinearLayout) { return this.orientation; },
  "setGravity(I)V": function (this: JLinearLayout, g: number) { this.gravity = g; requestLayout(this); },
  "setWeightSum(F)V": function (this: JLinearLayout, w: number) { this.weightSum = w; },
  "setShowDividers(I)V": () => {},
  "setDividerDrawable(Landroid/graphics/drawable/Drawable;)V": () => {},
  "setBaselineAligned(Z)V": () => {},
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function (this: JLinearLayout) {
    const lp = new JLinearLP();
    if (this.orientation === 1) { lp.width = MATCH_PARENT; lp.height = WRAP_CONTENT; }
    else { lp.width = WRAP_CONTENT; lp.height = WRAP_CONTENT; }
    return lp;
  },
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JLinearLayout, set: JAttrSet) {
    return lpFromAttrs(new JLinearLP(), this.jres!, set);
  },
  "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": (lp: JLayoutParams) => adoptLp(JLinearLP, lp),
  "onMeasure(II)V": async function (this: JLinearLayout, wSpec: number, hSpec: number) {
    const vertical = this.orientation === 1;
    const mainSpec = vertical ? hSpec : wSpec;
    const exact = specMode(mainSpec) === MS_EXACTLY;
    const mainPad = vertical ? this.padT + this.padB : this.padL + this.padR;
    const crossPad = vertical ? this.padL + this.padR : this.padT + this.padB;
    const kids = this.children.filter((c) => c.visibility !== 8);
    const mainOf = (c: JView) => (vertical ? c.measuredH : c.measuredW);
    const crossOf = (c: JView) => (vertical ? c.measuredW : c.measuredH);
    const marginsOf = (c: JView): [number, number] => {
      const m = c.lp instanceof JMarginLP ? c.lp : null;
      if (!m) return [0, 0];
      return vertical ? [m.marginT + m.marginB, m.marginL + m.marginR] : [m.marginL + m.marginR, m.marginT + m.marginB];
    };
    let totalMain = 0, maxCross = 0, totalWeight = 0, consumed = 0, skipped = false;
    for (const c of kids) {
      const [mMain, mCross] = marginsOf(c);
      const weight = c.lp instanceof JLinearLP ? c.lp.weight : 0;
      const excessOnly = weight > 0 && (vertical ? c.lp!.height : c.lp!.width) === 0;
      totalWeight += weight;
      if (excessOnly && exact) { totalMain += mMain; skipped = true; continue; }
      // AOSP: from the first weighted child on, siblings measure against the whole extent and
      // the weight pass below takes back whatever overflows, so a dialog's scrolling body yields
      // to its button row instead of squeezing it to nothing
      const used = totalWeight > 0 ? 0 : totalMain;
      if (excessOnly) { if (vertical) c.lp!.height = WRAP_CONTENT; else c.lp!.width = WRAP_CONTENT; }
      await measureChildWithMargins(this, c, wSpec, vertical ? 0 : used, hSpec, vertical ? used : 0);
      if (excessOnly) { if (vertical) c.lp!.height = 0; else c.lp!.width = 0; consumed += mainOf(c); }
      totalMain += mainOf(c) + mMain;
      maxCross = Math.max(maxCross, crossOf(c) + mCross);
    }
    const size = resolveSizeAndState(totalMain + mainPad, mainSpec);
    let excess = size - totalMain - mainPad + consumed;
    if (skipped || (excess !== 0 && totalWeight > 0)) {
      let wsum = this.weightSum > 0 ? this.weightSum : totalWeight;
      totalMain = 0;
      for (const c of kids) {
        const [mMain, mCross] = marginsOf(c);
        const weight = c.lp instanceof JLinearLP ? c.lp.weight : 0;
        if (weight > 0) {
          const share = Math.trunc(weight * excess / wsum);
          excess -= share; wsum -= weight;
          const dim = vertical ? c.lp!.height : c.lp!.width;
          const target = Math.max(0, (dim === 0 ? 0 : mainOf(c)) + share);
          const crossSpec = childMeasureSpec(vertical ? wSpec : hSpec, crossPad + mCross, vertical ? c.lp!.width : c.lp!.height);
          await measureView(c, vertical ? crossSpec : makeSpec(target, MS_EXACTLY), vertical ? makeSpec(target, MS_EXACTLY) : crossSpec);
        }
        totalMain += mainOf(c) + mMain;
        maxCross = Math.max(maxCross, crossOf(c) + mCross);
      }
    }
    const finalCross = resolveSizeAndState(Math.max(maxCross + crossPad, vertical ? this.minW : this.minH), vertical ? wSpec : hSpec);
    this.measuredW = vertical ? finalCross : size;
    this.measuredH = vertical ? size : finalCross;
    // match_parent cross re-measure
    for (const c of kids) {
      const crossDim = vertical ? c.lp?.width ?? WRAP_CONTENT : c.lp?.height ?? WRAP_CONTENT;
      if (crossDim === MATCH_PARENT) {
        const mlp = c.lp instanceof JMarginLP ? c.lp : null;
        const mCross = mlp ? (vertical ? mlp.marginL + mlp.marginR : mlp.marginT + mlp.marginB) : 0;
        const cw = Math.max(0, (vertical ? this.measuredW : this.measuredH) - crossPad - mCross);
        await measureView(c,
          vertical ? makeSpec(cw, MS_EXACTLY) : makeSpec(Math.max(0, c.measuredW), MS_EXACTLY),
          vertical ? makeSpec(Math.max(0, c.measuredH), MS_EXACTLY) : makeSpec(cw, MS_EXACTLY));
      }
    }
  },
  "onLayout(ZIIII)V": async function (this: JLinearLayout) {
    const vertical = this.orientation === 1;
    const kids = this.children.filter((c) => c.visibility !== 8);
    let used = 0;
    for (const c of kids) {
      const mlp = c.lp instanceof JMarginLP ? c.lp : null;
      used += (vertical ? c.measuredH : c.measuredW) + (mlp ? (vertical ? mlp.marginT + mlp.marginB : mlp.marginL + mlp.marginR) : 0);
    }
    const gm = this.gravity;
    let pos = vertical
      ? (gravityV(gm) === 16 ? this.padT + ((this.height() - this.padT - this.padB - used) >> 1)
        : gravityV(gm) === 80 ? this.height() - this.padB - used : this.padT)
      : (gravityH(gm) === 1 ? this.padL + ((this.width() - this.padL - this.padR - used) >> 1)
        : gravityH(gm) === 5 ? this.width() - this.padR - used : this.padL);
    for (const c of kids) {
      const lp = c.lp instanceof JLinearLP ? c.lp : null;
      const mlp = c.lp instanceof JMarginLP ? c.lp : null;
      const g = lp && lp.gravity !== -1 ? lp.gravity : this.gravity;
      const ml = mlp?.marginL ?? 0, mt = mlp?.marginT ?? 0, mr = mlp?.marginR ?? 0, mb = mlp?.marginB ?? 0;
      if (vertical) {
        const hg = gravityH(g);
        const x = hg === 1 ? this.padL + ((this.width() - this.padL - this.padR - c.measuredW + ml - mr) >> 1)
          : hg === 5 ? this.width() - this.padR - c.measuredW - mr : this.padL + ml;
        pos += mt;
        await layoutView(c, x, pos, x + c.measuredW, pos + c.measuredH);
        pos += c.measuredH + mb;
      } else {
        const vg = gravityV(g);
        const y = vg === 16 ? this.padT + ((this.height() - this.padT - this.padB - c.measuredH + mt - mb) >> 1)
          : vg === 80 ? this.height() - this.padB - c.measuredH - mb : this.padT + mt;
        pos += ml;
        await layoutView(c, pos, y, pos + c.measuredW, y + c.measuredH);
        pos += c.measuredW + mr;
      }
    }
  },
};
rt.register({
  name: "android/widget/LinearLayout", ctor: JLinearLayout, sup: "android/view/ViewGroup",
  statics: { HORIZONTAL: 0, VERTICAL: 1, SHOW_DIVIDER_NONE: 0, SHOW_DIVIDER_MIDDLE: 2 },
  methods: linearMethods,
});
rt.register({
  name: "android/widget/LinearLayout$LayoutParams", ctor: JLinearLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  fields: { gravity: "gravity", weight: "weight" },
  methods: {
    "<init>(II)V": function (this: JLinearLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(IIF)V": function (this: JLinearLP, w: number, h: number, wt: number) { this.width = w; this.height = h; this.weight = wt; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JLinearLP, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
      if (o instanceof JMarginLP) { this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB; }
      if (o instanceof JLinearLP) { this.weight = o.weight; this.gravity = o.gravity; }
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JLinearLP, c: unknown, set: JAttrSet) {
      lpFromAttrs(this, set.res, set);
    },
  },
});

// ── TableLayout / TableRow: vertical/horizontal LinearLayouts with column alignment.
// TableLayout pre-computes per-column widths (natural max across rows, stretch columns
// absorb leftover) and hands them to each row; rows then measure cells to exact columns.
class JTableLayout extends JLinearLayout {
  stretchCols = "";
  constructor() { super(); this.orientation = 1; }
}
class JTableRow extends JLinearLayout {
  colWidths: number[] | null = null;
}
const linearOnMeasure = linearMethods["onMeasure(II)V"] as (this: JLinearLayout, w: number, h: number) => Promise<void>;
rt.register({
  name: "android/widget/TableLayout", ctor: JTableLayout, sup: "android/widget/LinearLayout",
  methods: {
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JTableLayout, c: unknown, set: JAttrSet | null) {
      await (linearMethods["<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V"] as any).call(this, c, set);
      this.orientation = 1;
      const scId = AID("stretchColumns");
      const sc = scId ? set?.node?.attrs.find((a) => a.resId === scId) : undefined;
      if (sc) this.stretchCols = sc.str ?? String(sc.data);
    },
    "setStretchAllColumns(Z)V": function (this: JTableLayout, v: number) { this.stretchCols = v ? "*" : ""; requestLayout(this); },
    "setColumnStretchable(IZ)V": function (this: JTableLayout, i: number, v: number) {
      if (v) this.stretchCols = this.stretchCols ? this.stretchCols + "," + i : String(i);
    },
    "onMeasure(II)V": async function (this: JTableLayout, wSpec: number, hSpec: number) {
      const rows = this.children.filter((c): c is JTableRow => c.visibility !== 8 && c instanceof JTableRow);
      const colW: number[] = [];
      for (const row of rows) {
        const cells = row.children.filter((c) => c.visibility !== 8);
        for (let i = 0; i < cells.length; i++) {
          await measureView(cells[i], makeSpec(0, MS_UNSPEC), makeSpec(0, MS_UNSPEC));
          const mlp = cells[i].lp instanceof JMarginLP ? cells[i].lp as JMarginLP : null;
          colW[i] = Math.max(colW[i] ?? 0, cells[i].measuredW + (mlp ? mlp.marginL + mlp.marginR : 0));
        }
      }
      const avail = specSize(wSpec) - this.padL - this.padR;
      const total = colW.reduce((a, b) => a + b, 0);
      if (this.stretchCols && avail > total && colW.length) {
        const idxs = this.stretchCols === "*" ? colW.map((_, i) => i)
          : this.stretchCols.split(",").map(Number).filter((i) => i >= 0 && i < colW.length);
        if (idxs.length) { const extra = Math.floor((avail - total) / idxs.length); for (const i of idxs) colW[i] += extra; }
      }
      for (const row of rows) row.colWidths = colW;
      await linearOnMeasure.call(this, wSpec, hSpec);
    },
  },
});
rt.register({
  name: "android/widget/TableRow", ctor: JTableRow, sup: "android/widget/LinearLayout",
  methods: {
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JTableRow, c: unknown, set: JAttrSet | null) {
      await (linearMethods["<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V"] as any).call(this, c, set);
      this.orientation = 0;
    },
    "onMeasure(II)V": async function (this: JTableRow, wSpec: number, hSpec: number) {
      if (!this.colWidths) return linearOnMeasure.call(this, wSpec, hSpec);
      const kids = this.children.filter((c) => c.visibility !== 8);
      let x = this.padL + this.padR, maxH = 0;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        const mlp = c.lp instanceof JMarginLP ? c.lp : null;
        const mw = mlp ? mlp.marginL + mlp.marginR : 0, mh = mlp ? mlp.marginT + mlp.marginB : 0;
        const w = Math.max(0, (this.colWidths[i] ?? c.measuredW) - mw);
        const lpH = c.lp?.height ?? WRAP_CONTENT;
        await measureView(c, makeSpec(w, MS_EXACTLY),
          lpH >= 0 ? makeSpec(lpH, MS_EXACTLY) : makeSpec(0, MS_UNSPEC));
        x += w + mw; maxH = Math.max(maxH, c.measuredH + mh);
      }
      this.measuredW = resolveSizeAndState(x, wSpec);
      this.measuredH = resolveSizeAndState(maxH + this.padT + this.padB, hSpec);
    },
  },
});
rt.register({
  name: "android/widget/TableRow$LayoutParams", ctor: class extends JLinearLP {}, sup: "android/widget/LinearLayout$LayoutParams",
  methods: {
    "<init>()V": function (this: JLinearLP) { this.width = MATCH_PARENT; this.height = WRAP_CONTENT; },
    "<init>(II)V": function (this: JLinearLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JLinearLP, c: unknown, set: JAttrSet) {
      lpFromAttrs(this, set.res, set);
    },
  },
});
rt.register({
  name: "android/widget/TableLayout$LayoutParams", ctor: class extends JLinearLP {}, sup: "android/widget/LinearLayout$LayoutParams",
  methods: {
    "<init>()V": function (this: JLinearLP) { this.width = MATCH_PARENT; this.height = WRAP_CONTENT; },
    "<init>(II)V": function (this: JLinearLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JLinearLP, c: unknown, set: JAttrSet) {
      lpFromAttrs(this, set.res, set);
    },
  },
});

class JScrollView extends JViewGroup {
  fillViewport = false;
  horizontal = false;
  dragging = false;
  lastX = 0; lastY = 0;
  downX = 0; downY = 0;
  velo = 0;
  lastMoveT = 0;
  flingAnim: (() => boolean) | null = null;
  maxScroll(): number {
    const c = this.children[0];
    if (!c) return 0;
    return this.horizontal
      ? Math.max(0, c.measuredW + this.padL + this.padR - this.width())
      : Math.max(0, c.measuredH + this.padT + this.padB - this.height());
  }
  clampScroll() {
    if (this.horizontal) this.scrollX = Math.max(0, Math.min(this.maxScroll(), this.scrollX));
    else this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY));
  }
}
const scrollInit = async function (this: JScrollView, c: unknown, set: JAttrSet | null) {
  await initViewFromCtx(this, c, set);
  if (set && this.jres) {
    const ta = obtainStyled(this.jres, this.theme, set, [AID("fillViewport")], 0, 0);
    if (ta.vals[0]) this.fillViewport = !!rvInt(this.jres, ta.vals[0], 0);
  }
};
const scrollMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": scrollInit,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": scrollInit,
  "setFillViewport(Z)V": function (this: JScrollView, f: number) { this.fillViewport = !!f; },
  "onMeasure(II)V": async function (this: JScrollView, wSpec: number, hSpec: number) {
    const c = this.children[0];
    if (c && c.visibility !== 8) {
      const mlp = c.lp instanceof JMarginLP ? c.lp : null;
      const mainSpec = makeSpec(0, MS_UNSPEC);
      if (this.horizontal) {
        await measureView(c, mainSpec, childMeasureSpec(hSpec, this.padT + this.padB + (mlp ? mlp.marginT + mlp.marginB : 0), c.lp?.height ?? MATCH_PARENT));
      } else {
        await measureView(c, childMeasureSpec(wSpec, this.padL + this.padR + (mlp ? mlp.marginL + mlp.marginR : 0), c.lp?.width ?? MATCH_PARENT), mainSpec);
      }
    }
    // FrameLayout.onMeasure: wrap to content on BOTH axes, clamped by the spec
    const contentW = (c?.measuredW ?? 0) + this.padL + this.padR;
    const contentH = (c?.measuredH ?? 0) + this.padT + this.padB;
    this.measuredW = resolveSizeAndState(Math.max(contentW, this.minW), wSpec);
    this.measuredH = resolveSizeAndState(Math.max(contentH, this.minH), hSpec);
    if (c && this.fillViewport) {
      if (!this.horizontal && c.measuredH < this.measuredH - this.padT - this.padB) {
        await measureView(c, makeSpec(c.measuredW, MS_EXACTLY), makeSpec(this.measuredH - this.padT - this.padB, MS_EXACTLY));
      } else if (this.horizontal && c.measuredW < this.measuredW - this.padL - this.padR) {
        await measureView(c, makeSpec(this.measuredW - this.padL - this.padR, MS_EXACTLY), makeSpec(c.measuredH, MS_EXACTLY));
      }
    }
  },
  "onLayout(ZIIII)V": async function (this: JScrollView) {
    const c = this.children[0];
    if (c && c.visibility !== 8) {
      await layoutView(c, this.padL, this.padT, this.padL + c.measuredW, this.padT + c.measuredH);
    }
    this.clampScroll();
  },
  "onInterceptTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JScrollView, ev: JMotionEvent) {
    const a = ev.action & 0xff;
    if (a === 0) {
      this.downX = ev.x; this.downY = ev.y;
      this.lastX = ev.x; this.lastY = ev.y;
      this.dragging = false;
      this.flingAnim = null;
      this.velo = 0;
    } else if (a === 2) {
      const d = this.horizontal ? Math.abs(ev.x - this.downX) : Math.abs(ev.y - this.downY);
      const cross = this.horizontal ? Math.abs(ev.y - this.downY) : Math.abs(ev.x - this.downX);
      if (d > device.touchSlop && d > cross) { this.dragging = true; return 1; }
    }
    return 0;
  },
  "onTouchEvent(Landroid/view/MotionEvent;)Z": function (this: JScrollView, ev: JMotionEvent) {
    const a = ev.action & 0xff;
    if (a === 0) {
      this.lastX = ev.x; this.lastY = ev.y;
      this.lastMoveT = ev.eventTime;
      this.flingAnim = null;
      return 1;
    }
    if (a === 2) {
      const d = this.horizontal ? this.lastX - ev.x : this.lastY - ev.y;
      const dt = Math.max(1, ev.eventTime - this.lastMoveT);
      this.velo = 0.8 * this.velo + 0.2 * (d / dt * 16);
      this.lastMoveT = ev.eventTime;
      if (!this.dragging) {
        const dd = this.horizontal ? Math.abs(ev.x - this.downX) : Math.abs(ev.y - this.downY);
        if (dd > device.touchSlop) this.dragging = true;
      }
      if (this.dragging) {
        if (this.horizontal) this.scrollX += d;
        else this.scrollY += d;
        this.clampScroll();
        invalidate();
      }
      this.lastX = ev.x; this.lastY = ev.y;
      return 1;
    }
    if (a === 1 || a === 3) {
      let v = restVelocity(this.velo, 0.8, ev.eventTime - this.lastMoveT);
      if (this.dragging && Math.abs(v) > 2) {
        const anim = () => {
          if (this.flingAnim !== anim) return false;
          if (this.horizontal) this.scrollX += v;
          else this.scrollY += v;
          const before = this.horizontal ? this.scrollX : this.scrollY;
          this.clampScroll();
          const after = this.horizontal ? this.scrollX : this.scrollY;
          v *= 0.95;
          invalidate();
          return Math.abs(v) > 0.7 && before === after;
        };
        this.flingAnim = anim;
        uiState.animHooks.add(anim);
      }
      this.dragging = false;
      return 1;
    }
    return 0;
  },
  "canScrollVertically(I)Z": function (this: JScrollView, dir: number) {
    if (this.horizontal) return 0;
    return dir > 0 ? (this.scrollY < this.maxScroll() ? 1 : 0) : (this.scrollY > 0 ? 1 : 0);
  },
  "scrollTo(II)V": function (this: JScrollView, x: number, y: number) {
    this.scrollX = x; this.scrollY = y;
    this.clampScroll();
    invalidate();
  },
  "smoothScrollTo(II)V": function (this: JScrollView, x: number, y: number) {
    this.scrollX = this.horizontal ? x : this.scrollX;
    this.scrollY = this.horizontal ? this.scrollY : y;
    this.clampScroll();
    invalidate();
  },
  "fullScroll(I)Z": function (this: JScrollView, dir: number) {
    if (!this.horizontal) this.scrollY = dir === 130 ? this.maxScroll() : 0;
    invalidate();
    return 1;
  },
  "setSmoothScrollingEnabled(Z)V": () => {},
};
rt.register({ name: "android/widget/ScrollView", ctor: JScrollView, sup: "android/widget/FrameLayout",
  methods: { ...frameMethods, ...scrollMethods } });
rt.register({ name: "android/widget/HorizontalScrollView", ctor: class extends JScrollView { horizontal = true; },
  sup: "android/widget/FrameLayout", methods: { ...frameMethods, ...scrollMethods } });

export class JTextView extends JView {
  /** kept for the app to read back; text is drawn untransformed */
  transformation: unknown = null;
  editableFactory: unknown = null; spannableFactory: unknown = null;
  keyListener: unknown = null; movementMethod: unknown = null; selActionMode: unknown = null; editorActionL: unknown = null;
  drawableTint: JColorStateList | null = null;
  imeOptions = 0; breakStrategy = 0; hyphenation = 0; autoSizeType = 0;
  linksClickable = true; fontVariation: string | null = null;
  maxW = Infinity;
  layoutObj: unknown = null; layoutKey = "";
  text = "";
  rawText: unknown = "";       // original CharSequence (may be Spannable)
  hint = "";
  paintT = new JTextPaint();
  colors: JColorStateList = mkCsl(-16777216);
  hintColors: JColorStateList = mkCsl(1627389952);
  gravityT = 48 | G.START;
  maxLinesV = Infinity;
  minLinesV = 1;
  singleLine = false;
  ellipsizeEnd = false;
  filters: unknown[] = [];
  maxLength = Infinity;
  lineSpacingExtra = 0;
  lineSpacingMult = 1;
  allCaps = false;
  /** set once a style or the app has spoken about textAllCaps, so a widget default cannot
   *  overrule it afterwards */
  capsSet: boolean | undefined = undefined;
  drawableL: JDrawable | null = null;
  drawableT: JDrawable | null = null;
  drawableR: JDrawable | null = null;
  drawableB: JDrawable | null = null;
  drawablePad = 0;
  watchers: unknown[] = [];
  editable = false;
  editObj: JEditable | null = null;
  cursorVisible = true;
  lines: string[] = [];
  layoutWidthFor = -1;
  inputTypeV = 1;
  styleBits = 0;
  includePad = true;

  constructor() {
    super();
    this.paintT.textSize = 28; // 14sp default
    this.paintT.color = -16777216;
  }
  private upperOf = ""; private upper = "";
  displayText(): string {
    if (!this.allCaps) return this.text;
    if (this.upperOf !== this.text) { this.upperOf = this.text; this.upper = this.text.toUpperCase(); }
    return this.upper;
  }
  lineHeight(): number {
    return Math.round((fontDescent(this.paintT) - fontAscent(this.paintT)) * this.lineSpacingMult + this.lineSpacingExtra);
  }
  /** includeFontPadding (AOSP's default): the first line's box starts at the font's `top` and the
   *  last one's ends at its `bottom`, so a line box is taller than ascent..descent at both ends. */
  topPad(): number { return this.includePad ? Math.round(fontAscent(this.paintT) - fontTop(this.paintT)) : 0; }
  bottomPad(): number { return this.includePad ? Math.round(fontBottom(this.paintT) - fontDescent(this.paintT)) : 0; }
  textHeight(lines: number): number { return lines * this.lineHeight() + this.topPad() + this.bottomPad(); }
  ascent(): number { return Math.round(-fontAscent(this.paintT)) + this.topPad(); }
  wrap(avail: number): string[] {
    const text = this.displayText();
    if (avail <= 0) return text ? [text] : [];
    // measureText memoises on (font, string) and applies letter spacing; ctx.measureText did
    // neither, so every probe of the break search went to the browser and no line accounted for
    // android:letterSpacing that android.text.* has always honoured.
    const mw = (t: string) => measureText(this.paintT, t);
    const out: string[] = [];
    for (const hard of text.split("\n")) {
      if (this.singleLine || this.maxLinesV === 1) { out.push(hard); break; }
      if (mw(hard) <= avail) { out.push(hard); continue; }
      // a word wider than the line is hard-broken; emit full lines and return what is left over
      const breakWide = (l: string) => {
        while (mw(l) > avail && l.length > 1) {
          let lo = 1, hi = l.length;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (mw(l.slice(0, mid)) <= avail) lo = mid;
            else hi = mid - 1;
          }
          out.push(l.slice(0, lo));
          l = l.slice(lo);
        }
        return l;
      };
      let line = "";
      for (const word of hard.split(/(\s+)/)) {
        if (!word) continue;
        if (mw(line + word) <= avail || !line) line = breakWide(line + word);
        else {
          // the pending line can itself be one over-long word, parked here by an earlier break
          const rest = breakWide(line.trimEnd());
          if (rest) out.push(rest);
          line = word.trimStart();
        }
      }
      if (line) { const rest = breakWide(line.trimEnd()); if (rest) out.push(rest); }
    }
    while (out.length > this.maxLinesV) out.pop();
    if (out.length && this.ellipsizeEnd) {
      const last = out[out.length - 1];
      let shown = out.length - 1;
      for (const l of out) shown += l.length;
      if (shown < text.length && mw(last) > 0) {
        let l = last;
        while (l.length && mw(l + "…") > avail) l = l.slice(0, -1);
        out[out.length - 1] = l + "…";
      }
    }
    return out;
  }
  async notifyWatchers() {
    for (const w of this.watchers) {
      try {
        await vcall(w, "beforeTextChanged", "(Ljava/lang/CharSequence;III)V", this.text, 0, 0, this.text.length);
        await vcall(w, "onTextChanged", "(Ljava/lang/CharSequence;III)V", this.text, 0, 0, this.text.length);
        await vcall(w, "afterTextChanged", "(Landroid/text/Editable;)V", this.getEditable());
      } catch (e) { console.error("[watcher]", e); }
    }
  }
  getEditable(): JEditable {
    if (!this.editObj) this.editObj = new JEditable();
    this.editObj.text = this.text;
    return this.editObj;
  }
  wrapHint(avail: number): string[] {
    const saveText = this.text;
    this.text = this.hint;
    const lines = this.wrap(avail);
    this.text = saveText;
    return lines;
  }
}
const tvAttr = attrTable(
  "text", "textSize", "textColor", "textStyle", "textAppearance", "hint", "gravity", "maxLines",
  "minLines", "lines", "singleLine", "ellipsize", "lineSpacingExtra", "lineSpacingMultiplier",
  "drawableLeft", "drawableTop", "drawableRight", "drawableBottom", "drawablePadding", "drawableStart",
  "drawableEnd", "fontFamily", "textAllCaps", "textColorHint", "inputType", "letterSpacing", "maxLength",
  "imeOptions", "includeFontPadding", "ems", "minEms", "minWidth");async function applyTextAppearance(tv: JTextView, res: Resources, styleId: number) {
  if (!styleId) return;
  const look = (name: string) => resolveStyleValue(res, tv.theme, res.styleLookup(styleId, AID(name)));
  const ts = look("textSize");
  if (ts) tv.paintT.textSize = rvDimen(res, ts, tv.paintT.textSize);
  const tc = look("textColor");
  if (tc) {
    if (tc.t === TV.REFERENCE) tv.colors = await loadColorStateList(res, tc.d, tv.theme);
    else tv.colors = mkCsl(rvColor(res, tc, -16777216));
  }
  const st = look("textStyle");
  if (st) tv.styleBits = rvInt(res, st, 0);
  await applyFontFamily(tv, res, look("fontFamily"));
  const caps = look("textAllCaps");
  if (caps) { tv.allCaps = !!rvInt(res, caps, 0); tv.capsSet = true; }
}
/** `android:fontFamily` is either a system family name or a reference to a @font/ resource —
 *  a bare .ttf or a <font-family> XML. Apps ship their own fonts and name them this way. */
async function applyFontFamily(tv: JTextView, res: Resources, v: RV | null) {
  if (!v) return;
  if (v.t === TV.REFERENCE && v.d) {
    const tf = await fontResource(res, v.d);
    if (tf) tv.paintT.tf = tf;
    return;
  }
  const fam = rvString(res, v);
  if (fam) tv.paintT.tf = typefaceFor(fam);
}
async function applyTvStyle(tv: JTextView, set: JAttrSet | null, defStyleAttr: number) {
  const res = tv.jres;
  if (!res) return;
  const ids = [
    tvAttr.text, tvAttr.textSize, tvAttr.textColor, tvAttr.textStyle, tvAttr.textAppearance,
    tvAttr.hint, tvAttr.gravity, tvAttr.maxLines, tvAttr.singleLine, tvAttr.ellipsize,
    tvAttr.drawableLeft, tvAttr.drawableTop, tvAttr.drawableRight, tvAttr.drawableBottom,
    tvAttr.drawablePadding, tvAttr.fontFamily, tvAttr.textAllCaps, tvAttr.textColorHint,
    tvAttr.inputType, tvAttr.lineSpacingExtra, tvAttr.lineSpacingMultiplier, tvAttr.lines,
    tvAttr.drawableStart, tvAttr.drawableEnd, tvAttr.minLines,
    tvAttr.ems, tvAttr.minEms, tvAttr.minWidth, tvAttr.includeFontPadding, tvAttr.imeOptions,
  ];
  const ta = obtainStyled(res, tv.theme, set, ids, defStyleAttr, 0);
  const g = (i: number) => ta.vals[i];
  const taRef = g(4);
  if (taRef && taRef.t === TV.REFERENCE) await applyTextAppearance(tv, res, taRef.d);
  if (g(1)) tv.paintT.textSize = rvDimen(res, g(1), tv.paintT.textSize);
  if (g(2)) {
    const v = g(2)!;
    if (v.t === TV.REFERENCE) tv.colors = await loadColorStateList(res, v.d, tv.theme);
    else tv.colors = mkCsl(rvColor(res, v, -16777216));
  }
  if (g(3)) tv.styleBits = rvInt(res, g(3), tv.styleBits);
  if (g(0)) {
    const v = g(0)!;
    tv.text = v.t === TV.REFERENCE ? rvString(res, res.resolveRefs(v)) ?? "" : rvString(res, v) ?? "";
    tv.rawText = tv.text;
  }
  if (g(5)) {
    const v = g(5)!;
    tv.hint = (v.t === TV.REFERENCE ? rvString(res, res.resolveRefs(v)) : rvString(res, v)) ?? "";
  }
  if (g(6)) tv.gravityT = rvInt(res, g(6), tv.gravityT);
  if (g(7)) tv.maxLinesV = rvInt(res, g(7), 0) || Infinity;
  if (g(21)) { const n = rvInt(res, g(21), 0); if (n > 0) { tv.maxLinesV = n; tv.minLinesV = n; } }
  if (g(24)) tv.minLinesV = rvInt(res, g(24), 1);
  if (g(25) || g(26)) tv.minW = Math.max(tv.minW, Math.round(rvInt(res, (g(25) ?? g(26))!, 0) * tv.paintT.textSize));
  if (g(27)) tv.minW = Math.max(tv.minW, Math.round(rvDimen(res, g(27), 0)));
  if (g(8)) tv.singleLine = !!rvInt(res, g(8), 0);
  if (g(9)) tv.ellipsizeEnd = rvInt(res, g(9), 0) === 3;
  const dl = g(10) ?? g(22), dt = g(11), dr = g(12) ?? g(23), db = g(13);
  if (dl) tv.drawableL = await loadDrawableRV(res, dl, tv.theme);
  if (dt) tv.drawableT = await loadDrawableRV(res, dt, tv.theme);
  if (dr) tv.drawableR = await loadDrawableRV(res, dr, tv.theme);
  if (db) tv.drawableB = await loadDrawableRV(res, db, tv.theme);
  if (g(14)) tv.drawablePad = Math.round(rvDimen(res, g(14), 0));
  await applyFontFamily(tv, res, g(15));
  if (g(16)) { tv.allCaps = !!rvInt(res, g(16), 0); tv.capsSet = true; }
  if (g(17)) {
    const v = g(17)!;
    tv.hintColors = v.t === TV.REFERENCE ? await loadColorStateList(res, v.d, tv.theme) : mkCsl(rvColor(res, v, 1627389952));
  }
  if (g(18)) tv.inputTypeV = rvInt(res, g(18), 1);
  if (g(19)) tv.lineSpacingExtra = rvDimen(res, g(19), 0);
  if (g(20)) tv.lineSpacingMult = g(20)!.t === TV.FLOAT ? g(20)!.d : 1;
  if (g(28)) tv.includePad = !!rvInt(res, g(28), 1);
  // the action the IME key performs: a search field declares it here and nowhere else
  if (g(29)) tv.imeOptions = rvInt(res, g(29), 0);
  if (tv.styleBits & 1) tv.paintT.fakeBold = true;
  if (tv.styleBits & 2) tv.paintT.tf = (() => { const t = new JTypeface(); t.family = tv.paintT.tf.family; t.italic = true; t.weight = tv.paintT.tf.weight; return t; })();
}
function setTextAppearance(this: JTextView, id: number) {
  return this.jres ? applyTextAppearance(this, this.jres, id) : undefined;
}
function setCompoundDrawables(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null) {
  this.drawableL = l; this.drawableT = t; this.drawableR = r; this.drawableB = b;
  requestLayout(this);
}
/** the (Context) / (Context, AttributeSet) / (Context, AttributeSet, defStyleAttr) constructor trio of a
 *  TextView subclass: attach to the context, apply the widget's default style (or the caller's), then `then` */
function textViewCtors<T extends JTextView>(styleAttr: string, then?: (v: T) => unknown): NativeSpec["methods"] {
  const init = async (v: T, c: unknown, set: JAttrSet | null, dsa = 0) => {
    const style = dsa || AID(styleAttr);
    await initViewFromCtx(v, c, set, style);
    await applyTvStyle(v, set, style);
    await then?.(v);
  };
  return {
    "<init>(Landroid/content/Context;)V": function (this: T, c: unknown) { return init(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: T, c: unknown, set: JAttrSet | null) { return init(this, c, set); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: T, c: unknown, set: JAttrSet | null, dsa: number) { return init(this, c, set, dsa); },
  };
}
const textViewMethods: NonNullable<NativeSpec["methods"]> = {
  ...textViewCtors("textViewStyle"),
  // AOSP routes every setText through the two-arg form, and that is the one apps override:
  // Material's Chip hands the text to its ChipDrawable there and nowhere else, and without it
  // the drawable measures itself with no text at all.
  "setText(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) {
    return vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", cs, bufferTypes[0]);
  },
  "setText(I)V": async function (this: JTextView, id: number) {
    const s = this.jres ? rvString(this.jres, this.jres.resolveRefs({ t: TV.REFERENCE, d: id })) ?? "" : "";
    await guardCall((this as any)[M("setText", "(Ljava/lang/CharSequence;)V")], this, s);
  },
  "setText(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V": async function (this: JTextView, cs: unknown) {
    this.rawText = cs;
    const t = spannedString(cs);
    if (t !== this.text) {
      this.text = t;
      this.layoutWidthFor = -1;
      this.layoutRequested = true;
      requestLayout(this);
      await this.notifyWatchers();
    }
  },
  "getText()Ljava/lang/CharSequence;": function (this: JTextView) {
    return this.editable ? this.getEditable() : (this.rawText ?? this.text);
  },
  "length()I": function (this: JTextView) { return this.text.length; },
  "setHint(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) { this.hint = spannedString(cs); invalidate(); },
  "setHint(I)V": function (this: JTextView, id: number) {
    this.hint = this.jres ? rvString(this.jres, this.jres.resolveRefs({ t: TV.REFERENCE, d: id })) ?? "" : "";
  },
  "getHint()Ljava/lang/CharSequence;": function (this: JTextView) { return this.hint; },
  "setTextSize(F)V": function (this: JTextView, sp: number) {
    this.paintT.textSize = sp * device.density;
    this.layoutRequested = true;
    requestLayout(this);
  },
  "setTextSize(IF)V": function (this: JTextView, unit: number, v: number) {
    this.paintT.textSize = unit === 1 || unit === 2 ? v * device.density : v; // COMPLEX_UNIT_DIP / SP
    this.layoutRequested = true;
    requestLayout(this);
  },
  "getTextSize()F": function (this: JTextView) { return this.paintT.textSize; },
  "setTextColor(I)V": function (this: JTextView, c: number) { this.colors = mkCsl(c); invalidate(); },
  "setTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, c: JColorStateList) {
    if (c) this.colors = c;
    invalidate();
  },
  "getTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.colors; },
  "getCurrentTextColor()I": function (this: JTextView) { return cslColor(this.colors, this.drawableState()); },
  "setHintTextColor(I)V": function (this: JTextView, c: number) { this.hintColors = mkCsl(c); },
  "setGravity(I)V": function (this: JTextView, g: number) { this.gravityT = g; invalidate(); },
  "getGravity()I": function (this: JTextView) { return this.gravityT; },
  "setTypeface(Landroid/graphics/Typeface;)V": function (this: JTextView, t: JTypeface | null) {
    this.paintT.tf = t ?? tfDefault;
    this.layoutRequested = true;
    requestLayout(this);
  },
  "setTypeface(Landroid/graphics/Typeface;I)V": function (this: JTextView, t: JTypeface | null, style: number) {
    this.paintT.tf = t ?? tfDefault;
    this.paintT.fakeBold = (style & 1) !== 0;
    this.layoutRequested = true;
    requestLayout(this);
  },
  "getTypeface()Landroid/graphics/Typeface;": function (this: JTextView) { return this.paintT.tf; },
  "getPaint()Landroid/text/TextPaint;": function (this: JTextView) { return this.paintT; },
  "setSingleLine()V": function (this: JTextView) { this.singleLine = true; requestLayout(this); },
  "setSingleLine(Z)V": function (this: JTextView, v: number) { this.singleLine = !!v; requestLayout(this); },
  "setMaxLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n || Infinity; requestLayout(this); },
  "getMaxLines()I": function (this: JTextView) { return Number.isFinite(this.maxLinesV) ? this.maxLinesV : 0x7fffffff; },
  "setMinLines(I)V": function (this: JTextView, n: number) { this.minLinesV = n; requestLayout(this); },
  "setLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n; this.minLinesV = n; requestLayout(this); },
  "setEllipsize(Landroid/text/TextUtils$TruncateAt;)V": function (this: JTextView, e: { ord: number } | null) {
    this.ellipsizeEnd = e?.ord === 2;
  },
  "setAllCaps(Z)V": function (this: JTextView, v: number) { this.allCaps = !!v; this.capsSet = true; requestLayout(this); },
  "setLineSpacing(FF)V": function (this: JTextView, extra: number, mult: number) {
    this.lineSpacingExtra = extra; this.lineSpacingMult = mult;
    requestLayout(this);
  },
  "setLetterSpacing(F)V": function (this: JTextView, v: number) { this.paintT.letterSpacingEm = v; },
  "setIncludeFontPadding(Z)V": function (this: JTextView, on: number) { this.includePad = !!on; requestLayout(this); },
  "setTextAppearance(Landroid/content/Context;I)V": function (this: JTextView, c: unknown, id: number) { return setTextAppearance.call(this, id); },
  "setTextAppearance(I)V": setTextAppearance,
  "setCompoundDrawablesWithIntrinsicBounds(IIII)V": async function (this: JTextView, l: number, t: number, r: number, b: number) {
    const res = this.jres!;
    const [dl, dt, dr, db] = await Promise.all([l, t, r, b].map((id) => (id ? loadDrawable(res, id, this.theme) : null)));
    setCompoundDrawables.call(this, dl, dt, dr, db);
  },
  "setCompoundDrawablesWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawables(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "getCompoundDrawables()[Landroid/graphics/drawable/Drawable;": function (this: JTextView) {
    return jarray([this.drawableL, this.drawableT, this.drawableR, this.drawableB], "Landroid/graphics/drawable/Drawable;");
  },
  "setCompoundDrawablePadding(I)V": function (this: JTextView, p: number) { this.drawablePad = p; requestLayout(this); },
  "getCompoundDrawablePadding()I": function (this: JTextView) { return this.drawablePad; },
  "getCompoundPaddingLeft()I": function (this: JTextView) { return this.padL + (this.drawableL ? this.drawableL.intrinsicW() + this.drawablePad : 0); },
  "getCompoundPaddingRight()I": function (this: JTextView) { return this.padR + (this.drawableR ? this.drawableR.intrinsicW() + this.drawablePad : 0); },
  "getCompoundPaddingTop()I": function (this: JTextView) { return this.padT + (this.drawableT ? this.drawableT.intrinsicH() + this.drawablePad : 0); },
  "getCompoundPaddingBottom()I": function (this: JTextView) { return this.padB + (this.drawableB ? this.drawableB.intrinsicH() + this.drawablePad : 0); },
  // the factories only matter to a TextView that hands its buffer to the app (emoji2 wraps
  // them to intercept the Editable); kept so getters round-trip
  "setEditableFactory(Landroid/text/Editable$Factory;)V": function (this: JTextView, f: unknown) { this.editableFactory = f; },
  "setSpannableFactory(Landroid/text/Spannable$Factory;)V": function (this: JTextView, f: unknown) { this.spannableFactory = f; },
  "addTextChangedListener(Landroid/text/TextWatcher;)V": function (this: JTextView, w: unknown) { this.watchers.push(w); },
  "removeTextChangedListener(Landroid/text/TextWatcher;)V": function (this: JTextView, w: unknown) {
    const i = this.watchers.indexOf(w);
    if (i >= 0) this.watchers.splice(i, 1);
  },
  "setInputType(I)V": function (this: JTextView, t: number) { this.inputTypeV = t; },
  "getInputType()I": function (this: JTextView) { return this.inputTypeV; },
  "setImeOptions(I)V": function (this: JTextView, o: number) { this.imeOptions = o; },
  "getImeOptions()I": function (this: JTextView) { return this.imeOptions; },
  "setKeyListener(Landroid/text/method/KeyListener;)V": function (this: JTextView, l: unknown) { this.keyListener = l; },
  "getKeyListener()Landroid/text/method/KeyListener;": function (this: JTextView) { return this.keyListener; },
  "setMovementMethod(Landroid/text/method/MovementMethod;)V": function (this: JTextView, m: unknown) { this.movementMethod = m; },
  "getMovementMethod()Landroid/text/method/MovementMethod;": function (this: JTextView) { return this.movementMethod; },
  "getCompoundDrawablesRelative()[Landroid/graphics/drawable/Drawable;": function (this: JTextView) {
    return jarray([this.drawableL, this.drawableT, this.drawableR, this.drawableB], "Landroid/graphics/drawable/Drawable;");
  },
  "setCompoundDrawablesRelative(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawablesRelativeWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawablesRelativeWithIntrinsicBounds(IIII)V": function (this: JTextView, l: number, t: number, r: number, b: number) {
    return (textViewMethods["setCompoundDrawablesWithIntrinsicBounds(IIII)V"] as any).call(this, l, t, r, b);
  },
  "setCompoundDrawableTintList(Landroid/content/res/ColorStateList;)V": function (this: JTextView, csl: JColorStateList | null) {
    this.drawableTint = csl;
    for (const d of [this.drawableL, this.drawableT, this.drawableR, this.drawableB]) if (d) d.tint = csl ? cslColor(csl, d.stateSet) : null;
    invalidate();
  },
  "getCompoundDrawableTintList()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.drawableTint; },
  "setCompoundDrawableTintMode(Landroid/graphics/PorterDuff$Mode;)V": () => {},
  "getHintTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.hintColors; },
  "getLineSpacingExtra()F": function (this: JTextView) { return this.lineSpacingExtra; },
  "getLineSpacingMultiplier()F": function (this: JTextView) { return this.lineSpacingMult; },
  "getMinLines()I": function (this: JTextView) { return this.minLinesV; },
  "getMinWidth()I": function (this: JTextView) { return this.minW; },
  "getMinHeight()I": function (this: JTextView) { return this.minH; },
  "getLetterSpacing()F": function (this: JTextView) { return this.paintT.letterSpacingEm; },
  "getIncludeFontPadding()Z": () => 1,
  "setBreakStrategy(I)V": function (this: JTextView, b: number) { this.breakStrategy = b; },
  "getBreakStrategy()I": function (this: JTextView) { return this.breakStrategy; },
  "setHyphenationFrequency(I)V": function (this: JTextView, h: number) { this.hyphenation = h; },
  "getHyphenationFrequency()I": function (this: JTextView) { return this.hyphenation; },
  "getTotalPaddingLeft()I": function (this: JTextView) { return this.padL + (this.drawableL ? this.drawableL.intrinsicW() + this.drawablePad : 0); },
  "getTotalPaddingRight()I": function (this: JTextView) { return this.padR + (this.drawableR ? this.drawableR.intrinsicW() + this.drawablePad : 0); },
  "getTotalPaddingTop()I": function (this: JTextView) { return this.padT + (this.drawableT ? this.drawableT.intrinsicH() + this.drawablePad : 0); },
  "getTotalPaddingBottom()I": function (this: JTextView) { return this.padB + (this.drawableB ? this.drawableB.intrinsicH() + this.drawablePad : 0); },
  "isHorizontallyScrollable()Z": () => 0,
  "setWidth(I)V": function (this: JTextView, w: number) { this.minW = w; this.maxW = w; requestLayout(this); },
  "setMinEms(I)V": function (this: JTextView, ems: number) { this.minW = Math.round(ems * this.paintT.textSize); },
  "setRawInputType(I)V": function (this: JTextView, t: number) { this.inputTypeV = t; },
  "setLinksClickable(Z)V": function (this: JTextView, v: number) { this.linksClickable = !!v; },
  "getLinksClickable()Z": function (this: JTextView) { return this.linksClickable ? 1 : 0; },
  "setTextLocales(Landroid/os/LocaleList;)V": () => {},
  "setImeHintLocales(Landroid/os/LocaleList;)V": () => {},
  "getTextLocale()Ljava/util/Locale;": () => usLocale,
  "setFontVariationSettings(Ljava/lang/String;)Z": function (this: JTextView, s: string | null) { this.fontVariation = s; return 1; },
  "getFontVariationSettings()Ljava/lang/String;": function (this: JTextView) { return this.fontVariation; },
  "setCustomSelectionActionModeCallback(Landroid/view/ActionMode$Callback;)V": function (this: JTextView, cb: unknown) { this.selActionMode = cb; },
  "getCustomSelectionActionModeCallback()Landroid/view/ActionMode$Callback;": function (this: JTextView) { return this.selActionMode; },
  "beginBatchEdit()V": () => {},
  "endBatchEdit()V": () => {},
  "onCheckIsTextEditor()Z": function (this: JTextView) { return this.editable ? 1 : 0; },
  // AOSP: an explicit line height is applied as extra spacing over the font's own line height
  "setLineHeight(I)V": function (this: JTextView, h: number) { this.lineSpacingMult = 1; this.lineSpacingExtra = h - this.lineHeight() + this.lineSpacingExtra; requestLayout(this); },
  "setLineHeight(IF)V": function (this: JTextView, unit: number, h: number) {
    const px = unit === 1 ? h * device.density : unit === 2 ? h * device.density : h;
    this.lineSpacingMult = 1; this.lineSpacingExtra = px - this.lineHeight() + this.lineSpacingExtra; requestLayout(this);
  },
  "setFirstBaselineToTopHeight(I)V": function (this: JTextView, h: number) {
    this.padT = Math.max(0, h - this.ascent()); requestLayout(this);
  },
  "setLastBaselineToBottomHeight(I)V": function (this: JTextView, h: number) {
    this.padB = Math.max(0, h - Math.round(fontDescent(this.paintT))); requestLayout(this);
  },
  // auto-size is never active: AUTO_SIZE_TEXT_TYPE_NONE and the "unset" -1 sizes, as AOSP reports
  "setAutoSizeTextTypeWithDefaults(I)V": function (this: JTextView, t: number) { this.autoSizeType = t; },
  "setAutoSizeTextTypeUniformWithConfiguration(IIII)V": function (this: JTextView) { this.autoSizeType = 1; },
  "setAutoSizeTextTypeUniformWithPresetSizes([II)V": function (this: JTextView) { this.autoSizeType = 1; },
  "getAutoSizeTextType()I": function (this: JTextView) { return this.autoSizeType; },
  "getAutoSizeMinTextSize()I": () => -1,
  "getAutoSizeMaxTextSize()I": () => -1,
  "getAutoSizeStepGranularity()I": () => -1,
  "getAutoSizeTextAvailableSizes()[I": () => new Int32Array(0),
  "setTransformationMethod(Landroid/text/method/TransformationMethod;)V": function (this: JTextView, m: unknown) { this.transformation = m; },
  "getTransformationMethod()Landroid/text/method/TransformationMethod;": function (this: JTextView) { return this.transformation; },
  "setHighlightColor(I)V": () => {},
  "setHorizontallyScrolling(Z)V": () => {},
  "setMarqueeRepeatLimit(I)V": () => {},
  "setSelectAllOnFocus(Z)V": () => {},
  "setTextIsSelectable(Z)V": () => {},
  "setCursorVisible(Z)V": function (this: JTextView, v: number) { this.cursorVisible = !!v; },
  "setError(Ljava/lang/CharSequence;)V": () => {},
  "setAutoLinkMask(I)V": () => {},
  "setLinkTextColor(I)V": () => {},
  "setMaxEms(I)V": () => {},
  "setOnEditorActionListener(Landroid/widget/TextView$OnEditorActionListener;)V": function (this: JTextView, l: unknown) { this.editorActionL = l; },
  "setShadowLayer(FFFI)V": () => {},
  "setFilters([Landroid/text/InputFilter;)V": function (this: JTextView, arr: unknown[]) {
    this.filters = arr ?? [];
    for (const f of this.filters ?? []) {
      if (f instanceof JLengthFilter) this.maxLength = f.max;
    }
  },
  "getFilters()[Landroid/text/InputFilter;": function (this: JTextView) { const a = this.filters ?? []; (a as any).$t = "Landroid/text/InputFilter;"; return a; },
  "setMaxWidth(I)V": function (this: JTextView, w: number) { this.maxW = w; requestLayout(this); },
  // AOSP: an unbounded maximum reads back as Integer.MAX_VALUE, and callers Math.min() with it
  "getMaxWidth()I": function (this: JTextView) { return Number.isFinite(this.maxW) ? this.maxW : 0x7fffffff; },
  // AOSP: null until the first measure; afterwards the Layout over the measured text width
  "getLayout()Landroid/text/Layout;": function (this: JTextView) {
    if (this.layoutWidthFor < 0) return null;
    const dlW = this.drawableL ? Math.max(0, this.drawableL.intrinsicW()) + this.drawablePad : 0;
    const drW = this.drawableR ? Math.max(0, this.drawableR.intrinsicW()) + this.drawablePad : 0;
    const w = this.layoutWidthFor - this.padL - this.padR - dlW - drW;
    const key = this.displayText() + "\u0000" + w + "\u0000" + this.paintT.font() + "\u0000" + this.maxLinesV;
    if (this.layoutKey !== key) {
      this.layoutKey = key;
      this.layoutObj = mkStaticLayout(this.displayText(), this.paintT, w, this.lineSpacingMult, this.lineSpacingExtra, Number.isFinite(this.maxLinesV) ? this.maxLinesV : undefined);
    }
    return this.layoutObj;
  },
  "getLineBounds(ILandroid/graphics/Rect;)I": function (this: JTextView, i: number, r: JRect) {
    const lh = this.lineHeight(), w = this.layoutWidthFor >= 0 ? this.layoutWidthFor : this.width();
    r.left = this.padL; r.right = Math.max(this.padL, w - this.padR); r.top = this.padT + i * lh; r.bottom = r.top + lh;
    return r.top + this.ascent();
  },
  "setMinWidth(I)V": function (this: JTextView, w: number) { this.minW = w; },
  "setMaxHeight(I)V": () => {},
  "setMinHeight(I)V": function (this: JTextView, h: number) { this.minH = h; },
  "setEms(I)V": function (this: JTextView, ems: number) { this.minW = Math.round(ems * this.paintT.textSize); },
  "setPaintFlags(I)V": function (this: JTextView, f: number) {
    this.paintT.strikeThru = (f & 16) !== 0;
    this.paintT.underline = (f & 8) !== 0;
    invalidate();
  },
  "getPaintFlags()I": function (this: JTextView) {
    return (this.paintT.strikeThru ? 16 : 0) | (this.paintT.underline ? 8 : 0) | 1;
  },
  "getLineHeight()I": function (this: JTextView) { return this.lineHeight(); },
  "getLineCount()I": function (this: JTextView) { return this.lines.length; },
  "getBaseline()I": function (this: JTextView) { return this.padT + this.ascent(); },
  "getEditableText()Landroid/text/Editable;": function (this: JTextView) { return this.getEditable(); },
  "setEnabled(Z)V": function (this: JTextView, e: number) { this.enabled = !!e; void this.refreshDrawableState(); },
  "onMeasure(II)V": function (this: JTextView, wSpec: number, hSpec: number) {
    const wMode = specMode(wSpec), wSize = specSize(wSpec);
    const dlW = (this.drawableL ? Math.max(0, this.drawableL.intrinsicW()) + this.drawablePad : 0)
      + (this.drawableR ? Math.max(0, this.drawableR.intrinsicW()) + this.drawablePad : 0);
    const dtH = (this.drawableT ? Math.max(0, this.drawableT.intrinsicH()) + this.drawablePad : 0)
      + (this.drawableB ? Math.max(0, this.drawableB.intrinsicH()) + this.drawablePad : 0);
    const availText = Math.min(wMode === MS_UNSPEC ? 100000 : wSize, this.maxW) - this.padL - this.padR - dlW;
    let w: number;
    const display = this.displayText() || "";
    if (wMode === MS_EXACTLY) {
      w = wSize;
      this.lines = this.wrap(w - this.padL - this.padR - dlW);
    } else {
      this.lines = this.wrap(availText);
      let tw = 0;
      for (const l of this.lines) tw = Math.max(tw, measureText(this.paintT, l));
      if (!display && this.hint) tw = Math.max(tw, measureText(this.paintT, this.hint));
      w = Math.ceil(tw) + this.padL + this.padR + dlW;
      w = Math.min(Math.max(w, this.minW), this.maxW);
      if (wMode === MS_AT_MOST) w = Math.min(w, wSize);
      // AOSP rebuilds the layout at the width the view actually got. Without this the lines
      // stay wrapped for the desired width, so a clamp leaves both the height (too few lines)
      // and the draw (a line wider than the view, silently clipped) wrong.
      const finalAvail = w - this.padL - this.padR - dlW;
      if (finalAvail < availText) this.lines = this.wrap(finalAvail);
    }
    const lineCount = Math.max(this.lines.length, display || this.hint ? 1 : 0, this.minLinesV);
    const dHeights = [this.drawableL ? this.drawableL.intrinsicH() : 0, this.drawableR ? this.drawableR.intrinsicH() : 0];
    let h = this.textHeight(lineCount) + this.padT + this.padB + dtH;
    h = Math.max(h, this.minH, ...dHeights.map((x) => x + this.padT + this.padB));
    this.measuredW = w;
    this.measuredH = resolveSizeAndState(h, hSpec);
    this.layoutWidthFor = w;
  },
  "onDraw(Landroid/graphics/Canvas;)V": function (this: JTextView, cv: JCanvas) {
    const ctx = cv.ctx;
    const display = this.displayText();
    const showHint = !display && this.hint;
    const dlW = this.drawableL ? Math.max(0, this.drawableL.intrinsicW()) : 0;
    const drW = this.drawableR ? Math.max(0, this.drawableR.intrinsicW()) : 0;
    const contentL = this.padL + (dlW ? dlW + this.drawablePad : 0);
    const contentR = this.width() - this.padR - (drW ? drW + this.drawablePad : 0);
    // compound drawables (vertically centered)
    if (this.drawableL) {
      const dh = Math.max(0, this.drawableL.intrinsicH());
      this.drawableL.bounds.left = this.padL;
      this.drawableL.bounds.top = (this.height() - dh) >> 1;
      this.drawableL.bounds.right = this.padL + dlW;
      this.drawableL.bounds.bottom = ((this.height() - dh) >> 1) + dh;
      drawChild(this.drawableL, cv);
    }
    if (this.drawableR) {
      const dh = Math.max(0, this.drawableR.intrinsicH());
      this.drawableR.bounds.left = this.width() - this.padR - drW;
      this.drawableR.bounds.top = (this.height() - dh) >> 1;
      this.drawableR.bounds.right = this.width() - this.padR;
      this.drawableR.bounds.bottom = ((this.height() - dh) >> 1) + dh;
      drawChild(this.drawableR, cv);
    }
    const avail = contentR - contentL;
    if (this.layoutWidthFor !== this.width()) {
      this.lines = this.wrap(avail);
      this.layoutWidthFor = this.width();
    }
    const lines = showHint ? this.wrapHint(avail) : this.lines;
    if (!lines.length && !this.editable) return;
    const lh = this.lineHeight();
    const totalH = this.textHeight(Math.max(1, lines.length));
    const vg = gravityV(this.gravityT);
    let y = (vg === 16 ? (this.height() - this.padT - this.padB - totalH) / 2 + this.padT
      : vg === 80 ? this.height() - this.padB - totalH : this.padT) + this.ascent();
    ctx.font = this.paintT.font();
    ctx.fillStyle = cssColor(showHint ? cslColor(this.hintColors, this.drawableState()) : cslColor(this.colors, this.drawableState()));
    ctx.textBaseline = "alphabetic";
    const hg = gravityH(this.gravityT);
    ctx.textAlign = hg === 1 ? "center" : hg === 5 ? "right" : "left";
    const x = hg === 1 ? (contentL + contentR) / 2 : hg === 5 ? contentR : contentL;
    for (const line of lines) {
      ctx.fillText(line, x, y);
      if (this.paintT.strikeThru && line) {
        const w = measureText(this.paintT, line);
        const sx = hg === 1 ? x - w / 2 : hg === 5 ? x - w : x;
        ctx.fillRect(sx, y - this.paintT.textSize * 0.3, w, Math.max(1, this.paintT.textSize / 14));
      }
      y += lh;
    }
    // cursor for editable focused
    if (this.editable && this.focused && this.cursorVisible && Math.floor(performance.now() / 530) % 2 === 0) {
      const lastLine = lines[lines.length - 1] ?? "";
      const cw = measureText(this.paintT, lastLine);
      const cx = (hg === 1 ? x + cw / 2 : hg === 5 ? x : x + cw) + 1;
      const cy = y - lh;
      ctx.fillStyle = cssColor(cslColor(this.colors, []));
      ctx.fillRect(cx, cy - this.ascent(), 3, lh);
    }
  },
};

rt.register({
  name: "android/widget/TextView", ctor: JTextView, sup: "android/view/View",
  methods: textViewMethods,
});
rt.register({ name: "android/widget/TextView$OnEditorActionListener", ctor: class extends JObj {} });
const bufferTypes = mkEnumSet("android/widget/TextView$BufferType", ["NORMAL", "SPANNABLE", "EDITABLE"]);

class JButton extends JTextView {
  constructor() {
    super();
    this.gravityT = 17;
    this.clickable = true;
  }
}
rt.register({
  name: "android/widget/Button", ctor: JButton, sup: "android/widget/TextView",
  methods: {
    ...textViewMethods,
    ...textViewCtors<JButton>("buttonStyle", applyButtonDefaults),
  },
});
async function applyButtonDefaults(b: JButton) {
  b.clickable = true;
  // AOSP's Widget.Material.Button supplies these; they are DEFAULTS, not overrides. A style
  // that spoke for itself — every Material3 button is sentence-case with its own face — has
  // already run in applyTvStyle, and forcing them here undid it.
  if (b.capsSet === undefined) b.allCaps = true;
  if (b.paintT.tf === tfDefault) b.paintT.tf = tfMedium;
}

class JImageView extends JView {
  drawable: JDrawable | null = null;
  scaleType = 3; // FIT_CENTER
  adjustBounds = false;
  tintCsl: JColorStateList | null = null;
  /** AOSP only applies these when adjustViewBounds is on */
  maxW = Infinity; maxH = Infinity;
}
mkEnumSet("android/widget/ImageView$ScaleType", ["MATRIX", "FIT_XY", "FIT_START", "FIT_CENTER", "FIT_END", "CENTER", "CENTER_CROP", "CENTER_INSIDE"]);
const imageViewMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JImageView, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("src"), AID("scaleType"), AID("adjustViewBounds"), AID("tint")], 0, 0);
      if (ta.vals[0]) this.drawable = await loadDrawableRV(this.jres, ta.vals[0], this.theme);
      if (ta.vals[1]) this.scaleType = rvInt(this.jres, ta.vals[1], 3);
      if (ta.vals[2]) this.adjustBounds = !!rvInt(this.jres, ta.vals[2], 0);
      if (ta.vals[3]) {
        const tint = rvColor(this.jres, ta.vals[3], 0);
        if (this.drawable && tint) this.drawable.tint = tint;
      }
    }
  },
  "setImageDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JImageView, d: JDrawable | null) {
    this.drawable = d;
    this.layoutRequested = true;
    requestLayout(this);
  },
  "setImageResource(I)V": async function (this: JImageView, id: number) {
    this.drawable = id && this.jres ? await loadDrawable(this.jres, id, this.theme) : null;
    this.layoutRequested = true;
    requestLayout(this);
  },
  "setImageBitmap(Landroid/graphics/Bitmap;)V": async function (this: JImageView, b: JBitmap | null) {
    if (b) {
      const d = new JBitmapDrawable();
      d.bmp = b;
      this.drawable = d;
    } else this.drawable = null;
    this.layoutRequested = true;
    requestLayout(this);
  },
  "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JImageView) { return this.drawable; },
  "setScaleType(Landroid/widget/ImageView$ScaleType;)V": function (this: JImageView, st: { ord: number }) {
    this.scaleType = st?.ord ?? 3;
    invalidate();
  },
  "getScaleType()Landroid/widget/ImageView$ScaleType;": function () { return null; },
  "setAdjustViewBounds(Z)V": function (this: JImageView, v: number) { this.adjustBounds = !!v; },
  "setMaxWidth(I)V": function (this: JImageView, v: number) { this.maxW = v; requestLayout(this); },
  "setMaxHeight(I)V": function (this: JImageView, v: number) { this.maxH = v; requestLayout(this); },
  "getMaxWidth()I": function (this: JImageView) { return Number.isFinite(this.maxW) ? this.maxW : 0x7fffffff; },
  "getMaxHeight()I": function (this: JImageView) { return Number.isFinite(this.maxH) ? this.maxH : 0x7fffffff; },
  "setColorFilter(I)V": function (this: JImageView, c: number) { if (this.drawable) this.drawable.tint = c; invalidate(); },
  "setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V": function (this: JImageView, c: number) {
    if (this.drawable) this.drawable.tint = c;
    invalidate();
  },
  "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JImageView, f: any) {
    if (this.drawable) this.drawable.tint = f?.tint ?? null;
    invalidate();
  },
  "clearColorFilter()V": function (this: JImageView) { if (this.drawable) this.drawable.tint = null; },
  "setImageTintList(Landroid/content/res/ColorStateList;)V": function (this: JImageView, csl: JColorStateList | null) {
    this.tintCsl = csl;
    if (this.drawable && csl) this.drawable.tint = cslColor(csl, this.drawableState());
    invalidate();
  },
  "setImageMatrix(Landroid/graphics/Matrix;)V": () => {},
  "setImageLevel(I)V": function (this: JImageView, l: number) { if (this.drawable) this.drawable.level = l; },
  "setImageURI(Landroid/net/Uri;)V": () => {},
  "onMeasure(II)V": function (this: JImageView, wSpec: number, hSpec: number) {
    const dw = Math.max(0, this.drawable?.intrinsicW() ?? 0);
    const dh = Math.max(0, this.drawable?.intrinsicH() ?? 0);
    let w = dw + this.padL + this.padR;
    let h = dh + this.padT + this.padB;
    w = Math.max(w, this.minW); h = Math.max(h, this.minH);
    this.measuredW = resolveSizeAndState(w, wSpec);
    this.measuredH = resolveSizeAndState(h, hSpec);
    if (this.adjustBounds && dw > 0 && dh > 0) {
      if (specMode(wSpec) === MS_EXACTLY && specMode(hSpec) !== MS_EXACTLY) {
        this.measuredH = resolveSizeAndState(Math.round((this.measuredW - this.padL - this.padR) * dh / dw) + this.padT + this.padB, hSpec);
      } else if (specMode(hSpec) === MS_EXACTLY && specMode(wSpec) !== MS_EXACTLY) {
        this.measuredW = resolveSizeAndState(Math.round((this.measuredH - this.padT - this.padB) * dw / dh) + this.padL + this.padR, wSpec);
      }
    }
  },
  "onDraw(Landroid/graphics/Canvas;)V": function (this: JImageView, cv: JCanvas) {
    const d = this.drawable;
    if (!d) return;
    const dw = Math.max(1, d.intrinsicW()), dh = Math.max(1, d.intrinsicH());
    const aw = this.width() - this.padL - this.padR, ah = this.height() - this.padT - this.padB;
    let l = this.padL, t = this.padT, w = aw, h = ah;
    const st = this.scaleType;
    if (st === 5) { // CENTER
      w = dw; h = dh;
      l = this.padL + ((aw - dw) >> 1); t = this.padT + ((ah - dh) >> 1);
    } else if (st === 3 || st === 7 || st === 2 || st === 4) { // FIT_CENTER-ish / CENTER_INSIDE
      let s = Math.min(aw / dw, ah / dh);
      if (st === 7) s = Math.min(1, s);
      w = Math.round(dw * s); h = Math.round(dh * s);
      l = this.padL + ((aw - w) >> 1);
      t = this.padT + ((ah - h) >> 1);
      if (st === 2) { l = this.padL; t = this.padT; }
    } else if (st === 6) { // CENTER_CROP
      const s = Math.max(aw / dw, ah / dh);
      w = Math.round(dw * s); h = Math.round(dh * s);
      l = this.padL + ((aw - w) >> 1); t = this.padT + ((ah - h) >> 1);
      const ctx = cv.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.padL, this.padT, aw, ah);
      ctx.clip();
      d.bounds.left = l; d.bounds.top = t; d.bounds.right = l + w; d.bounds.bottom = t + h;
      drawChild(d, cv);
      ctx.restore();
      return;
    }
    d.bounds.left = l; d.bounds.top = t; d.bounds.right = l + w; d.bounds.bottom = t + h;
    drawChild(d, cv);
  },
};
rt.register({ name: "android/widget/ImageView", ctor: JImageView, sup: "android/view/View", methods: imageViewMethods });
rt.register({
  name: "android/widget/ImageButton", ctor: class extends JImageView {
    constructor() { super(); this.clickable = true; this.scaleType = 5; }
  }, sup: "android/widget/ImageView", methods: imageViewMethods,
});

export class JEditText extends JTextView {
  constructor() {
    super();
    this.editable = true;
    this.clickable = true;
    this.focusable = true;
    this.gravityT = 16 | G.START;
  }
}
rt.register({
  name: "android/widget/EditText", ctor: JEditText, sup: "android/widget/TextView",
  methods: {
    ...textViewMethods,
    ...textViewCtors<JEditText>("editTextStyle"),
    "getText()Landroid/text/Editable;": function (this: JEditText) { return this.getEditable(); },
    "setSelection(I)V": () => {},
    "setSelection(II)V": () => {},
    "getSelectionStart()I": function (this: JEditText) { return this.text.length; },
    "getSelectionEnd()I": function (this: JEditText) { return this.text.length; },
    "selectAll()V": () => {},
    "performClick()Z": async function (this: JEditText) {
      focusEditText(this);
      if (this.clickL) await vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
      return 1;
    },
  },
});
export let focusedEdit: JEditText | null = null;
/** the shell's hidden <input>: the focused EditText mirrors into it so the soft keyboard shows */
let inputEl: HTMLInputElement | null = null;
export function setInputElement(el: HTMLInputElement) { inputEl = el; }
setFocusHook((v, on) => {
  if (v instanceof JEditText) focusEditText(on ? v : null);
  else if (on && focusedEdit) focusEditText(null);
});
/** the IME action key: AOSP hands the listener the action out of imeOptions and, when nothing
 *  consumes it, moves focus off the field the way closing the keyboard does. */
export async function fireEditorAction(): Promise<boolean> {
  const et = focusedEdit;
  if (!et) return false;
  const action = (et.imeOptions & 0xff) || 0;
  if (et.editorActionL && await vcall(et.editorActionL, "onEditorAction",
    "(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z", et, action, null)) return true;
  focusEditText(null);
  return false;
}
export function focusEditText(et: JEditText | null) {
  if (focusedEdit === et) return;
  if (focusedEdit) focusedEdit.focused = false;
  focusedEdit = et;
  if (et) et.focused = true;
  if (inputEl) {
    if (et) {
      inputEl.value = et.text;
      inputEl.focus();
    } else inputEl.blur();
  }
  invalidate();
}
export async function editInput(text: string) {
  if (!focusedEdit) return;
  focusedEdit.text = text;
  focusedEdit.rawText = text;
  focusedEdit.layoutWidthFor = -1;
  requestLayout(focusedEdit);
  await focusedEdit.notifyWatchers();
}

class JProgressBar extends JView {
  indeterminate = true;
  progress = 0;
  max = 100; min = 0;
  horizontal = false;
  progressD: JDrawable | null = null; indetD: JDrawable | null = null;
  tintCsl: JColorStateList | null = null;
}
rt.register({
  name: "android/widget/ProgressBar", ctor: JProgressBar, sup: "android/view/View",
  methods: {
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JProgressBar, c: unknown, set: JAttrSet | null) {
      await initViewFromCtx(this, c, set);
      // style attr → horizontal?
      if (set?.node) {
        for (const a of set.node.attrs) {
          if (a.name === "style" && a.str?.includes("Horizontal")) this.horizontal = true;
          if (!a.ns && a.name === "style" && a.type === TV.REFERENCE) {
            const nm = this.jres?.idName(a.data) ?? "";
            if (nm.includes("Horizontal")) this.horizontal = true;
          }
        }
      }
      if (this.horizontal) this.indeterminate = false;
    },
    "setIndeterminate(Z)V": function (this: JProgressBar, v: number) { this.indeterminate = !!v; },
    "isIndeterminate()Z": function (this: JProgressBar) { return this.indeterminate ? 1 : 0; },
    "setProgress(I)V": function (this: JProgressBar, p: number) { this.progress = p; invalidate(); },
    "getProgress()I": function (this: JProgressBar) { return this.progress; },
    "setMax(I)V": function (this: JProgressBar, m: number) { this.max = Math.max(1, m); },
    "getMax()I": function (this: JProgressBar) { return this.max; },
    "setSecondaryProgress(I)V": () => {},
    "setProgressDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JProgressBar, d: JDrawable | null) { this.progressD = d; invalidate(); },
    "getProgressDrawable()Landroid/graphics/drawable/Drawable;": function (this: JProgressBar) { return this.progressD; },
    "setIndeterminateDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JProgressBar, d: JDrawable | null) { this.indetD = d; invalidate(); },
    "getIndeterminateDrawable()Landroid/graphics/drawable/Drawable;": function (this: JProgressBar) { return this.indetD; },
    "setProgressTintList(Landroid/content/res/ColorStateList;)V": function (this: JProgressBar, c: JColorStateList | null) { this.tintCsl = c; invalidate(); },
    "getProgressTintList()Landroid/content/res/ColorStateList;": function (this: JProgressBar) { return this.tintCsl; },
    "setIndeterminateTintList(Landroid/content/res/ColorStateList;)V": function (this: JProgressBar, c: JColorStateList | null) { this.tintCsl = c; invalidate(); },
    "getIndeterminateTintList()Landroid/content/res/ColorStateList;": function (this: JProgressBar) { return this.tintCsl; },
    "setProgress(IZ)V": function (this: JProgressBar, p: number) { this.progress = p; invalidate(); },
    "setMin(I)V": function (this: JProgressBar, m: number) { this.min = m; },
    "getMin()I": function (this: JProgressBar) { return this.min; },
    "getSecondaryProgress()I": () => 0,
    "getInterpolator()Landroid/view/animation/Interpolator;": () => null,
    "setInterpolator(Landroid/view/animation/Interpolator;)V": () => {},
    "setInterpolator(Landroid/content/Context;I)V": () => {},
    "onMeasure(II)V": function (this: JProgressBar, wSpec: number, hSpec: number) {
      const dw = this.horizontal ? 48 : 96, dh = this.horizontal ? 16 : 96;
      this.measuredW = resolveSizeAndState(Math.max(dw + this.padL + this.padR, this.minW), wSpec);
      this.measuredH = resolveSizeAndState(Math.max(dh + this.padT + this.padB, this.minH), hSpec);
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JProgressBar, cv: JCanvas) {
      const ctx = cv.ctx;
      const accent = themeAccent(this);
      if (this.horizontal) {
        const y = this.height() / 2;
        ctx.fillStyle = cssColor((accent & 0xffffff) | 0x4d000000);
        ctx.fillRect(this.padL, y - 4, this.width() - this.padL - this.padR, 8);
        ctx.fillStyle = cssColor(accent);
        if (this.indeterminate) {
          const t = (performance.now() % 1200) / 1200;
          const w = (this.width() - this.padL - this.padR);
          ctx.fillRect(this.padL + t * w * 1.5 - w / 2, y - 4, w / 2, 8);
          uiState.needsDraw = true;
        } else {
          ctx.fillRect(this.padL, y - 4, (this.width() - this.padL - this.padR) * this.progress / this.max, 8);
        }
      } else {
        const cx = this.width() / 2, cy = this.height() / 2;
        const r = Math.min(this.width() - this.padL - this.padR, this.height() - this.padT - this.padB) / 2 - 6;
        const t = performance.now() / 900;
        ctx.strokeStyle = cssColor(accent);
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.beginPath();
        const sweep = (Math.sin(t * 2.2) * 0.35 + 0.5) * Math.PI * 1.5 + 0.3;
        ctx.arc(cx, cy, Math.max(8, r), t * 5, t * 5 + sweep);
        ctx.stroke();
        uiState.needsDraw = true; // keep animating
      }
    },
  },
});
export function themeAccent(v: JView): number {
  const rv = v.theme?.lookup(AID("colorAccent")) ?? v.theme?.lookup(AID("colorPrimary"));
  return rv && v.jres ? rvColor(v.jres, rv, -10011977) : -10011977;
}

/** TextView.onDraw with the text column starting at `padL` (compound widgets draw their indicator in the gap). */
function drawTextInset(tv: JTextView, cv: JCanvas, padL: number) {
  const saved = tv.padL;
  tv.padL = padL;
  try { (textViewMethods!["onDraw(Landroid/graphics/Canvas;)V"] as (cv: JCanvas) => void).call(tv, cv); }
  finally { tv.padL = saved; }
}

// ── CompoundButton / CheckBox / RadioButton / Switch
class JCompoundButton extends JButton {
  checked = false;
  checkL: unknown = null;
  broadcasting = false;
  constructor() {
    super();
    this.allCaps = false;
    this.gravityT = 16 | G.START;
    this.background = null;
    this.minH = 96;
    this.minW = 0;
    this.padL = 0; this.padR = 0;
  }
  /** the android:button drawable, and the width the indicator reserves (0 = no indicator) */
  buttonD: JDrawable | null = null;
  buttonW = 0;
  async setCheckedInternal(c: boolean) {
    if (this.checked === c) return;
    this.checked = c;
    await this.refreshDrawableState();
    if (this.broadcasting) return;
    this.broadcasting = true;
    if (this.checkL) {
      await vcall(this.checkL, "onCheckedChanged", "(Landroid/widget/CompoundButton;Z)V", this, c ? 1 : 0);
    }
    this.broadcasting = false;
    invalidate();
  }
  baseState(): number[] {
    const st = super.baseState();
    if (this.checked) st.push(ST.checked);
    return st;
  }
}
const CB_STYLE = { check: "checkboxStyle", radio: "radioButtonStyle", switch: "switchStyle" } as const;
const compoundMethods = (kind: "check" | "radio" | "switch"): NativeSpec["methods"] => {
  const init = async function (this: JCompoundButton, c: unknown, set: JAttrSet | null, defStyleAttr?: number, defStyleRes?: number) {
    await initViewFromCtx(this, c, set);
    await applyTvStyle(this, set, 0);
    this.background = null;
    this.clickable = true;
    if (!this.jres) return;
    // AOSP's two-arg constructors pass the widget's own default style attribute; the indicator
    // is the android:button that cascade resolves, and a CompoundButton subclass styled as
    // something else (a Material Chip) has none and reserves no room for one.
    const ta = obtainStyled(this.jres, this.theme, set, [AID("checked"), AID("button")],
      defStyleAttr || AID(CB_STYLE[kind]), defStyleRes ?? 0);
    if (ta.vals[0]) this.checked = !!rvInt(this.jres, ta.vals[0], 0);
    if (ta.vals[1]) {
      this.buttonD = await loadDrawableRV(this.jres, ta.vals[1], this.theme);
      this.buttonW = kind === "switch" ? 104 : 64;
    }
  };
  return {
  ...textViewMethods,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": init,
  "setChecked(Z)V": function (this: JCompoundButton, c: number) { return this.setCheckedInternal(!!c); },
  "isChecked()Z": function (this: JCompoundButton) { return this.checked ? 1 : 0; },
  "toggle()V": function (this: JCompoundButton) { return this.setCheckedInternal(!this.checked); },
  "setOnCheckedChangeListener(Landroid/widget/CompoundButton$OnCheckedChangeListener;)V":
    function (this: JCompoundButton, l: unknown) { this.checkL = l; },
  "performClick()Z": async function (this: JCompoundButton) {
    // inside a RadioGroup: single-select semantics
    let g: JView | null = this.parent;
    while (g && !(g instanceof JRadioGroup)) g = g.parent;
    if (g instanceof JRadioGroup && kind === "radio") {
      await g.checkId(this.idNum);
    } else {
      await this.setCheckedInternal(!this.checked);
    }
    if (this.clickL) await vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
    return 1;
  },
  "setButtonDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JCompoundButton, d: JDrawable | null) {
    this.buttonD = d;
    this.buttonW = d ? (kind === "switch" ? 104 : 64) : 0;
    invalidate();
  },
  "setButtonDrawable(I)V": async function (this: JCompoundButton, id: number) {
    this.buttonD = id ? await loadDrawable(this.jres!, id, this.theme) : null;
    this.buttonW = id ? (kind === "switch" ? 104 : 64) : 0;
    invalidate();
  },
  "onMeasure(II)V": function (this: JCompoundButton, wSpec: number, hSpec: number) {
    (textViewMethods["onMeasure(II)V"] as (a: number, b: number) => void).call(this, wSpec, hSpec);
    this.measuredW = resolveSizeAndState(this.measuredW + this.buttonW, wSpec);
    this.measuredH = Math.max(this.measuredH, 96);
  },
  "onDraw(Landroid/graphics/Canvas;)V": function (this: JCompoundButton, cv: JCanvas) {
    if (!this.buttonW) return (textViewMethods["onDraw(Landroid/graphics/Canvas;)V"] as (cv: JCanvas) => void).call(this, cv);
    const ctx = cv.ctx;
    const accent = themeAccent(this);
    const cy = this.height() / 2;
    const indX = kind === "switch" ? this.width() - this.padR - 88 : this.padL + 8;
    if (this.buttonD && this.buttonD.intrinsicW() > 0) {
      const w = this.buttonD.intrinsicW(), h = this.buttonD.intrinsicH();
      const b = this.buttonD.bounds;
      b.left = indX; b.top = cy - h / 2; b.right = indX + w; b.bottom = cy + h / 2;
      this.buttonD.stateSet = this.drawableState();
      this.buttonD.paint(cv);
      drawTextInset(this, cv, kind !== "switch" ? indX + this.buttonW - 8 : this.padL);
      return;
    }
    if (kind === "check") {
      const s = 36;
      const x = indX, y = cy - s / 2;
      ctx.lineWidth = 4;
      if (this.checked) {
        ctx.fillStyle = cssColor(accent);
        ctx.beginPath();
        ctx.roundRect(x, y, s, s, 4);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 19);
        ctx.lineTo(x + 15, y + 26);
        ctx.lineTo(x + 28, y + 10);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(0,0,0,0.54)";
        ctx.beginPath();
        ctx.roundRect(x + 2, y + 2, s - 4, s - 4, 4);
        ctx.stroke();
      }
    } else if (kind === "radio") {
      const r = 18;
      ctx.lineWidth = 4;
      ctx.strokeStyle = this.checked ? cssColor(accent) : "rgba(0,0,0,0.54)";
      ctx.beginPath();
      ctx.arc(indX + r, cy, r - 2, 0, Math.PI * 2);
      ctx.stroke();
      if (this.checked) {
        ctx.fillStyle = cssColor(accent);
        ctx.beginPath();
        ctx.arc(indX + r, cy, r - 10, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // switch: track + thumb on right
      const tw = 68, th = 28;
      ctx.fillStyle = this.checked ? cssColor((accent & 0xffffff) | 0x66000000) : "rgba(0,0,0,0.26)";
      ctx.beginPath();
      ctx.roundRect(indX + 10, cy - th / 2, tw - 20, th, th / 2);
      ctx.fill();
      ctx.fillStyle = this.checked ? cssColor(accent) : "#fafafa";
      ctx.strokeStyle = "rgba(0,0,0,0.13)";
      ctx.beginPath();
      ctx.arc(this.checked ? indX + tw - 20 : indX + 20, cy, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // text after indicator
    drawTextInset(this, cv, kind !== "switch" ? indX + this.buttonW - 8 : this.padL);
  },
  };
};
rt.register({ name: "android/widget/CompoundButton", ctor: JCompoundButton, sup: "android/widget/Button", methods: compoundMethods("check") });
rt.register({ name: "android/widget/CompoundButton$OnCheckedChangeListener", ctor: class extends JObj {} });
rt.register({ name: "android/widget/CheckBox", ctor: class extends JCompoundButton {}, sup: "android/widget/CompoundButton", methods: compoundMethods("check") });
rt.register({ name: "android/widget/RadioButton", ctor: class extends JCompoundButton {}, sup: "android/widget/CompoundButton", methods: compoundMethods("radio") });
rt.register({ name: "android/widget/Switch", ctor: class extends JCompoundButton {}, sup: "android/widget/CompoundButton", methods: compoundMethods("switch") });
rt.register({ name: "android/widget/ToggleButton", ctor: class extends JCompoundButton {}, sup: "android/widget/CompoundButton", methods: compoundMethods("switch") });
class JRadioGroup extends JLinearLayout {
  checkL: unknown = null;
  checkedId = -1;
  constructor() { super(); this.orientation = 1; }
  radios(out: JCompoundButton[] = [], v: JView = this): JCompoundButton[] {
    if (v instanceof JCompoundButton) out.push(v);
    if (v instanceof JViewGroup && !(v instanceof JCompoundButton)) for (const c of v.children) this.radios(out, c);
    return out;
  }
  async checkId(id: number, fire = true) {
    this.checkedId = id;
    for (const r of this.radios()) {
      await r.setCheckedInternal(r.idNum === id);
    }
    if (fire && this.checkL) {
      await vcall(this.checkL, "onCheckedChanged", "(Landroid/widget/RadioGroup;I)V", this, id);
    }
    invalidate();
  }
}
rt.register({
  name: "android/widget/RadioGroup", ctor: JRadioGroup, sup: "android/widget/LinearLayout",
  methods: {
    ...linearMethods,
    "setOnCheckedChangeListener(Landroid/widget/RadioGroup$OnCheckedChangeListener;)V": function (this: JRadioGroup, l: unknown) {
      this.checkL = l;
    },
    "check(I)V": function (this: JRadioGroup, id: number) { return this.checkId(id); },
    "clearCheck()V": function (this: JRadioGroup) { return this.checkId(-1); },
    "getCheckedRadioButtonId()I": function (this: JRadioGroup) { return this.checkedId; },
  },
});

// Space
rt.register({
  name: "android/widget/Space", ctor: class extends JView {}, sup: "android/view/View",
  methods: {
    "onMeasure(II)V": function (this: JView, wSpec: number, hSpec: number) {
      this.measuredW = defaultSize(0, wSpec);
      this.measuredH = defaultSize(0, hSpec);
    },
    "onDraw(Landroid/graphics/Canvas;)V": () => {},
  },
});

// ── RelativeLayout (common-rule subset)
class JRelativeLP extends JMarginLP {
  rules = new Map<number, number>(); // verb → anchor id or boolean(-1 true)
}
const RL = {
  LEFT_OF: 0, RIGHT_OF: 1, ABOVE: 2, BELOW: 3, ALIGN_BASELINE: 4, ALIGN_LEFT: 5, ALIGN_TOP: 6,
  ALIGN_RIGHT: 7, ALIGN_BOTTOM: 8, ALIGN_PARENT_LEFT: 9, ALIGN_PARENT_TOP: 10,
  ALIGN_PARENT_RIGHT: 11, ALIGN_PARENT_BOTTOM: 12, CENTER_IN_PARENT: 13, CENTER_HORIZONTAL: 14,
  CENTER_VERTICAL: 15, START_OF: 16, END_OF: 17, ALIGN_START: 18, ALIGN_END: 19,
  ALIGN_PARENT_START: 20, ALIGN_PARENT_END: 21,
};
const rlAttrByName: [string, number][] = [
  ["layout_toLeftOf", RL.LEFT_OF], ["layout_toRightOf", RL.RIGHT_OF], ["layout_above", RL.ABOVE],
  ["layout_below", RL.BELOW], ["layout_alignBaseline", RL.ALIGN_BASELINE], ["layout_alignLeft", RL.ALIGN_LEFT],
  ["layout_alignTop", RL.ALIGN_TOP], ["layout_alignRight", RL.ALIGN_RIGHT], ["layout_alignBottom", RL.ALIGN_BOTTOM],
  ["layout_alignParentLeft", RL.ALIGN_PARENT_LEFT], ["layout_alignParentTop", RL.ALIGN_PARENT_TOP],
  ["layout_alignParentRight", RL.ALIGN_PARENT_RIGHT], ["layout_alignParentBottom", RL.ALIGN_PARENT_BOTTOM],
  ["layout_centerInParent", RL.CENTER_IN_PARENT], ["layout_centerHorizontal", RL.CENTER_HORIZONTAL],
  ["layout_centerVertical", RL.CENTER_VERTICAL], ["layout_toStartOf", RL.LEFT_OF], ["layout_toEndOf", RL.RIGHT_OF],
  ["layout_alignStart", RL.ALIGN_LEFT], ["layout_alignEnd", RL.ALIGN_RIGHT],
  ["layout_alignParentStart", RL.ALIGN_PARENT_LEFT], ["layout_alignParentEnd", RL.ALIGN_PARENT_RIGHT],
];
const rlAttrIds: (readonly [number, number])[] = [];
onFramework(() => { for (const [n, verb] of rlAttrByName) rlAttrIds.push([AID(n), verb] as const); });
class JRelativeLayout extends JViewGroup {
  /** positions resolved by the last onMeasure, consumed by onLayout */
  rlPos = new Map<JView, { l: number; t: number }>();
  gravityR = 0;
}
const relativeMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JRelativeLayout, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("gravity")], 0, 0);
      if (ta.vals[0]) this.gravityR = rvInt(this.jres, ta.vals[0], 0);
    }
  },
  "setGravity(I)V": function (this: JRelativeLayout, g: number) { this.gravityR = g; },
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JRelativeLayout, set: JAttrSet) {
    const lp = lpFromAttrs(new JRelativeLP(), this.jres!, set);
    if (set.node) {
      for (const a of set.node.attrs) {
        for (const [aid, verb] of rlAttrIds) {
          if (aid && a.resId === aid) {
            lp.rules.set(verb, a.type === TV.BOOLEAN || a.type >= TV.INT_DEC ? (a.data ? (a.type === TV.REFERENCE ? a.data : (a.data > 1 ? a.data : -1)) : 0) : a.data);
            if (a.type === TV.REFERENCE) lp.rules.set(verb, a.data);
          }
        }
      }
    }
    return lp;
  },
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function () {
    return new JRelativeLP();
  },
  "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": (lp: JLayoutParams) => adoptLp(JRelativeLP, lp),
  "onMeasure(II)V": async function (this: JRelativeLayout, wSpec: number, hSpec: number) {
    const availW = specSize(wSpec), availH = specSize(hSpec);
    const kids = this.children.filter((c) => c.visibility !== 8);
    // measure all children first (simple pass)
    for (const c of kids) await measureChildWithMargins(this, c, wSpec, 0, hSpec, 0);
    // position via rules
    const pos = this.rlPos;
    pos.clear();
    const byId = new Map<number, JView>();
    for (const c of kids) if (c.idNum > 0) byId.set(c.idNum, c);
    let maxR = 0, maxB = 0;
    for (const c of kids) {
      const lp = c.lp instanceof JRelativeLP ? c.lp : null;
      const m = c.lp instanceof JMarginLP ? c.lp : new JMarginLP();
      let l = this.padL + m.marginL;
      let t = this.padT + m.marginT;
      if (lp) {
        const anchor = (verb: number): JView | null => {
          const id = lp.rules.get(verb);
          return id && id > 0 ? byId.get(id) ?? null : null;
        };
        const anchorPos = (v: JView) => pos.get(v) ?? { l: v.left, t: v.top };
        if (lp.rules.get(RL.ALIGN_PARENT_RIGHT)) l = availW - this.padR - c.measuredW - m.marginR;
        if (lp.rules.get(RL.CENTER_HORIZONTAL) || lp.rules.get(RL.CENTER_IN_PARENT)) l = (availW - c.measuredW) >> 1;
        if (lp.rules.get(RL.ALIGN_PARENT_BOTTOM)) t = availH - this.padB - c.measuredH - m.marginB;
        if (lp.rules.get(RL.CENTER_VERTICAL) || lp.rules.get(RL.CENTER_IN_PARENT)) t = (availH - c.measuredH) >> 1;
        const rOf = anchor(RL.RIGHT_OF);
        if (rOf) l = anchorPos(rOf).l + rOf.measuredW + m.marginL;
        const lOf = anchor(RL.LEFT_OF);
        if (lOf) l = anchorPos(lOf).l - c.measuredW - m.marginR;
        const below = anchor(RL.BELOW);
        if (below) t = anchorPos(below).t + below.measuredH + m.marginT;
        const above = anchor(RL.ABOVE);
        if (above) t = anchorPos(above).t - c.measuredH - m.marginB;
        const aL = anchor(RL.ALIGN_LEFT);
        if (aL) l = anchorPos(aL).l;
        const aT = anchor(RL.ALIGN_TOP);
        if (aT) t = anchorPos(aT).t;
        const aR = anchor(RL.ALIGN_RIGHT);
        if (aR) l = anchorPos(aR).l + aR.measuredW - c.measuredW;
        const aB = anchor(RL.ALIGN_BOTTOM);
        if (aB) t = anchorPos(aB).t + aB.measuredH - c.measuredH;
        const aBase = anchor(RL.ALIGN_BASELINE);
        if (aBase) t = anchorPos(aBase).t;
      }
      pos.set(c, { l, t });
      maxR = Math.max(maxR, l + c.measuredW + m.marginR);
      maxB = Math.max(maxB, t + c.measuredH + m.marginB);
    }
    this.measuredW = resolveSizeAndState(maxR + this.padR, wSpec);
    this.measuredH = resolveSizeAndState(maxB + this.padB, hSpec);
    // stretch match_parent children
    for (const c of kids) {
      if (c.lp?.width === MATCH_PARENT || c.lp?.height === MATCH_PARENT) {
        const m = c.lp instanceof JMarginLP ? c.lp : new JMarginLP();
        const w = c.lp.width === MATCH_PARENT ? this.measuredW - this.padL - this.padR - m.marginL - m.marginR : c.measuredW;
        const h = c.lp.height === MATCH_PARENT ? this.measuredH - this.padT - this.padB - m.marginT - m.marginB : c.measuredH;
        await measureView(c, makeSpec(Math.max(0, w), MS_EXACTLY), makeSpec(Math.max(0, h), MS_EXACTLY));
      }
    }
  },
  "onLayout(ZIIII)V": async function (this: JRelativeLayout) {
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      const p = this.rlPos.get(c) ?? { l: this.padL, t: this.padT };
      await layoutView(c, p.l, p.t, p.l + c.measuredW, p.t + c.measuredH);
    }
  },
};
rt.register({ name: "android/widget/RelativeLayout", ctor: JRelativeLayout, sup: "android/view/ViewGroup",
  statics: { TRUE: -1 },
  methods: relativeMethods });
rt.register({
  name: "android/widget/RelativeLayout$LayoutParams", ctor: JRelativeLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  methods: {
    "<init>(II)V": function (this: JRelativeLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JRelativeLP, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
    },
    "addRule(I)V": function (this: JRelativeLP, verb: number) { this.rules.set(verb, -1); },
    "addRule(II)V": function (this: JRelativeLP, verb: number, anchor: number) { this.rules.set(verb, anchor); },
    "removeRule(I)V": function (this: JRelativeLP, verb: number) { this.rules.delete(verb); },
  },
});

class JViewStub extends JView {
  layoutRes = 0;
  inflatedId = -1;
  inflateL: unknown = null;
  inflatedRef: WeakRef<JView> | null = null;
  constructor() { super(); this.visibility = 8; }
}
const viewStubMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JViewStub, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("layout"), AID("inflatedId")], 0, 0);
      if (ta.vals[0]) this.layoutRes = ta.vals[0]!.d;
      if (ta.vals[1]) this.inflatedId = ta.vals[1]!.d;
    }
    this.visibility = 8;
  },
  "setLayoutResource(I)V": function (this: JViewStub, id: number) { this.layoutRes = id; },
  "getLayoutResource()I": function (this: JViewStub) { return this.layoutRes; },
  "setInflatedId(I)V": function (this: JViewStub, id: number) { this.inflatedId = id; },
  "getInflatedId()I": function (this: JViewStub) { return this.inflatedId; },
  "setOnInflateListener(Landroid/view/ViewStub$OnInflateListener;)V": function (this: JViewStub, l: unknown) { this.inflateL = l; },
  "onMeasure(II)V": function (this: JViewStub) { this.measuredW = 0; this.measuredH = 0; },
  "draw(Landroid/graphics/Canvas;)V": () => {},
  "inflate()Landroid/view/View;": async function (this: JViewStub) {
    const parent = this.parent;
    if (!(parent instanceof JViewGroup) || !this.layoutRes) {
      throw rt.mkThrowable("java/lang/IllegalStateException",
        "ViewStub must have a non-null ViewGroup viewParent and a valid layoutResource");
    }
    const v = await inflateLayout(this.ctx, this.layoutRes, parent, false);
    if (!v) return null;
    if (this.inflatedId !== -1) v.idNum = this.inflatedId;
    const idx = parent.children.indexOf(this);
    const lp = this.lp;
    await vcall(parent, "removeViewInLayout", "(Landroid/view/View;)V", this);
    if (lp) await vcall(parent, "addView", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)V", v, idx, lp);
    else await vcall(parent, "addView", "(Landroid/view/View;I)V", v, idx);
    this.inflatedRef = new WeakRef(v);
    if (this.inflateL) await vcall(this.inflateL, "onInflate", "(Landroid/view/ViewStub;Landroid/view/View;)V", this, v);
    return v;
  },
  "setVisibility(I)V": async function (this: JViewStub, vis: number) {
    const inflated = this.inflatedRef?.deref();
    if (inflated) return vcall(inflated, "setVisibility", "(I)V", vis);
    this.visibility = vis;
    requestLayout(this);
    if (vis === 0 || vis === 4) await vcall(this, "inflate", "()Landroid/view/View;");
  },
};
rt.register({ name: "android/view/ViewStub", ctor: JViewStub, sup: "android/view/View", methods: viewStubMethods });
rt.register({ name: "android/view/ViewStub$OnInflateListener", ctor: class extends JObj {} });

// ── CheckedTextView (single-choice dialog rows)
class JCheckedTextView extends JTextView {
  checked = false;
  checkMarkDrawable: JDrawable | null = null;
  baseState(): number[] {
    const st = super.baseState();
    if (this.checked) st.push(ST.checked);
    return st;
  }
}
rt.register({
  name: "android/widget/CheckedTextView", ctor: JCheckedTextView, sup: "android/widget/TextView",
  ifaces: ["android/widget/Checkable"],
  methods: {
    ...textViewMethods,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JCheckedTextView, c: unknown, set: JAttrSet | null) {
      await initViewFromCtx(this, c, set);
      await applyTvStyle(this, set, 0);
      this.gravityT = 16 | G.START;
    },
    "setChecked(Z)V": function (this: JCheckedTextView, v: number) { this.checked = !!v; invalidate(); },
    "isChecked()Z": function (this: JCheckedTextView) { return this.checked ? 1 : 0; },
    "toggle()V": function (this: JCheckedTextView) { this.checked = !this.checked; invalidate(); },
    "setCheckMarkDrawable(I)V": () => {},
    "setCheckMarkDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JCheckedTextView, d: JDrawable | null) {
      this.checkMarkDrawable = d;
    },
    "onMeasure(II)V": function (this: JCheckedTextView, wSpec: number, hSpec: number) {
      (textViewMethods["onMeasure(II)V"] as (a: number, b: number) => void).call(this, wSpec, hSpec);
      this.measuredH = Math.max(this.measuredH, 96);
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JCheckedTextView, cv: JCanvas) {
      const ctx = cv.ctx;
      const cy = this.height() / 2;
      const r = 18;
      const indX = this.padL;
      // A supplied check mark wins; the drawn indicator is only the fallback for the
      // synthesized single-choice row, which has no framework asset behind it.
      if (this.checkMarkDrawable) {
        const d = this.checkMarkDrawable;
        d.stateSet = this.drawableState();
        d.onStateChange();
        d.bounds.left = indX; d.bounds.top = cy - r;
        d.bounds.right = indX + 2 * r; d.bounds.bottom = cy + r;
        drawChild(d, cv);
        drawTextInset(this, cv, indX + 2 * r + 34);
        return;
      }
      const accent = themeAccent(this);
      ctx.lineWidth = 4;
      ctx.strokeStyle = this.checked ? cssColor(accent) : "rgba(0,0,0,0.54)";
      ctx.beginPath();
      ctx.arc(indX + r + 2, cy, r - 2, 0, Math.PI * 2);
      ctx.stroke();
      if (this.checked) {
        ctx.fillStyle = cssColor(accent);
        ctx.beginPath();
        ctx.arc(indX + r + 2, cy, r - 10, 0, Math.PI * 2);
        ctx.fill();
      }
      drawTextInset(this, cv, indX + 2 * r + 34);
    },
  },
});

// ── SearchView. AOSP inflates layout/search_view.xml and toggles the parts of it that a
// collapsed or expanded search shows, so this does too rather than describing the row again.
class JSearchView extends JLinearLayout {
  queryText = "";
  queryL: unknown = null;
  hintStr = "";
  iconified = true;
  edit: JEditText | null = null;
  closeBtn: JView | null = null;
}
// AOSP reads all of this out of ?attr/searchViewStyle -- the layout to inflate and every icon
// and background in it -- so none of it is described here. Which parts of that layout a
// collapsed or an expanded search shows is the only decision left.
const SEARCH_ICONS: [string, string][] = [
  ["search_button", "searchIcon"], ["search_mag_icon", "searchIcon"],
  ["search_close_btn", "closeIcon"], ["search_go_btn", "goIcon"], ["search_voice_btn", "voiceIcon"],
];
const SEARCH_BACKGROUNDS: [string, string][] = [
  ["search_plate", "queryBackground"], ["submit_area", "submitBackground"],
];
/** shown when expanded; the submit half of the row waits for a query, as it does on a device */
const SEARCH_EXPANDED = ["search_edit_frame", "search_plate", "search_mag_icon", "search_src_text"];
const SEARCH_ON_QUERY = ["search_badge", "search_close_btn", "submit_area", "search_go_btn", "search_voice_btn"];

async function buildSearchView(sv: JSearchView, set: JAttrSet | null) {
  const res = sv.jres;
  if (!res) return;
  const names = ["layout", "iconifiedByDefault", "queryHint", "searchIcon", "closeIcon", "goIcon",
    "voiceIcon", "queryBackground", "submitBackground"];
  const ta = obtainStyled(res, sv.theme, set, names.map(AID), AID("searchViewStyle"), 0);
  const val = (n: string) => ta.vals[names.indexOf(n)];
  if (val("iconifiedByDefault")) sv.iconified = !!rvInt(res, val("iconifiedByDefault"), 1);
  if (val("queryHint")) sv.hintStr = rvString(res, val("queryHint")) || sv.hintStr;

  const layout = val("layout");
  if (!layout?.d) return;
  await inflateLayout(sv.ctx, layout.d, sv, true);
  const byName = (n: string) => { const id = res.idFor("id", n, "android"); return id ? findById(sv, id) : null; };

  for (const [part, attr] of SEARCH_ICONS) {
    const v = byName(part), d = val(attr);
    if (v instanceof JImageView && d) v.drawable = await loadDrawableRV(res, d, sv.theme);
  }
  for (const [part, attr] of SEARCH_BACKGROUNDS) {
    const v = byName(part), d = val(attr);
    if (v && d) v.background = await loadDrawableRV(res, d, sv.theme);
  }
  for (const part of [...SEARCH_EXPANDED, "search_button"]) {
    const v = byName(part);
    if (v) v.visibility = (part === "search_button") === sv.iconified ? 0 : 8;
  }
  for (const part of SEARCH_ON_QUERY) { const v = byName(part); if (v) v.visibility = 8; }
  sv.closeBtn = byName("search_close_btn");
  const src = byName("search_src_text");
  if (src instanceof JEditText) { sv.edit = src; if (sv.hintStr) src.hint = sv.hintStr; }
}
rt.register({
  name: "android/widget/SearchView", ctor: JSearchView, sup: "android/widget/LinearLayout",
  ifaces: ["android/widget/FilterQueryProvider"],
  methods: {
    ...linearMethods,
    "<init>(Landroid/content/Context;)V": async function (this: JSearchView, c: unknown) {
      await initViewFromCtx(this, c, null);
      this.orientation = 0;
      await buildSearchView(this, null);
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JSearchView, c: unknown, set: JAttrSet | null) {
      await initViewFromCtx(this, c, set);
      this.orientation = 0;
      await buildSearchView(this, set);
    },
    "setOnQueryTextListener(Landroid/widget/SearchView$OnQueryTextListener;)V": function (this: JSearchView, l: unknown) { this.queryL = l; },
    "setQueryHint(Ljava/lang/CharSequence;)V": function (this: JSearchView, h: unknown) {
      this.hintStr = String(h ?? "");
      if (this.edit) this.edit.hint = this.hintStr;
    },
    "setIconifiedByDefault(Z)V": function (this: JSearchView, v: number) { this.iconified = !!v; },
    "setIconified(Z)V": function (this: JSearchView, v: number) { this.iconified = !!v; },
    "isIconified()Z": function (this: JSearchView) { return this.iconified ? 1 : 0; },
    "setQuery(Ljava/lang/CharSequence;Z)V": async function (this: JSearchView, q: unknown, submit: number) {
      this.queryText = String(q ?? "");
      if (this.edit) this.edit.text = this.queryText;
      if (this.closeBtn) { this.closeBtn.visibility = this.queryText ? 0 : 8; requestLayout(this.closeBtn); }
      if (this.queryL) {
        await vcall(this.queryL, "onQueryTextChange", "(Ljava/lang/String;)Z", this.queryText);
        if (submit) await vcall(this.queryL, "onQueryTextSubmit", "(Ljava/lang/String;)Z", this.queryText);
      }
    },
    "getQuery()Ljava/lang/CharSequence;": function (this: JSearchView) { return this.queryText; },
    "setMaxWidth(I)V": () => {},
    "setSubmitButtonEnabled(Z)V": () => {},
    "clearFocus()V": () => {},
    "onActionViewExpanded()V": () => {},
    "onActionViewCollapsed()V": () => {},
    "setOnCloseListener(Landroid/widget/SearchView$OnCloseListener;)V": () => {},
    "setSearchableInfo(Landroid/app/SearchableInfo;)V": () => {},
  },
});
for (const name of ["android/widget/AutoCompleteTextView", "android/widget/MultiAutoCompleteTextView",
  "android/widget/SearchView$SearchAutoComplete"]) {
  rt.register({
    name, ctor: class extends JEditText {}, sup: "android/widget/EditText",
    methods: {
      ...textViewMethods,
      ...textViewCtors<JEditText>("autoCompleteTextViewStyle"),
      "setThreshold(I)V": () => {},
      "setAdapter(Landroid/widget/ListAdapter;)V": () => {},
      "dismissDropDown()V": () => {},
      "setDropDownAnchor(I)V": () => {},
      "setImeVisibility(Z)V": () => {},
    },
  });
}
rt.register({ name: "android/widget/SearchView$OnQueryTextListener", ctor: class extends JObj {} });
rt.register({ name: "android/widget/FilterQueryProvider", ctor: class extends JObj {} });
rt.register({ name: "android/widget/Filterable", ctor: class extends JObj {} });
rt.register({ name: "android/widget/Filter", ctor: class extends JObj {},
  methods: { "<init>()V": function () {}, "filter(Ljava/lang/CharSequence;)V": () => {},
    "filter(Ljava/lang/CharSequence;Landroid/widget/Filter$FilterListener;)V": () => {} } });

// ── InputFilter + common implementations (maxLength, allCaps). Needed for EditText inflation.
rt.register({ name: "android/text/InputFilter", ctor: class extends JObj {} });
class JLengthFilter extends JObj { max = 0; }
rt.register({
  name: "android/text/InputFilter$LengthFilter", ctor: JLengthFilter,
  ifaces: ["android/text/InputFilter"],
  methods: {
    "<init>(I)V": function (this: JLengthFilter, m: number) { this.max = m; },
    "getMax()I": function (this: JLengthFilter) { return this.max; },
    "filter(Ljava/lang/CharSequence;IILandroid/text/Spanned;II)Ljava/lang/CharSequence;":
      function (this: JLengthFilter, src: unknown) { return null; }, // null = accept as-is (length enforced at input time)
  },
});
rt.register({
  name: "android/text/InputFilter$AllCaps", ctor: class extends JObj {},
  ifaces: ["android/text/InputFilter"],
  methods: {
    "<init>()V": function () {},
    "filter(Ljava/lang/CharSequence;IILandroid/text/Spanned;II)Ljava/lang/CharSequence;":
      function (this: JObj, src: unknown) { return src == null ? null : String(src).toUpperCase(); },
  },
});

rt.register({ name: "android/widget/Checkable", ctor: class extends JObj {} });
