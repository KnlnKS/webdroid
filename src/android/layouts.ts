import { AID } from "./res";
import {
  JMarginLP, type JLayoutParams, JViewGroup, JFrameLP, MATCH_PARENT, lpFromAttrs, measureChildWithMargins,
  resolveSizeAndState, makeSpec, MS_EXACTLY, childMeasureSpec, measureView, layoutView, initViewFromCtx,
  requestLayout, JLinearLP, WRAP_CONTENT, specMode, JView, MS_UNSPEC, specSize, invalidate, uiState
} from "./view";
import { type NativeSpec, rt, callSelf, JObj } from "../jvm/runtime";
import { type JAttrSet, obtainStyled, rvInt, rvFloat, onFramework } from "./res";
import { gravityH, gravityV, G } from "./gravity";
import { type JMotionEvent, trackVelocity, restVelocity, SCROLL_WEIGHT, FLING } from "./motionevent";
import { device } from "../shell/config";
import { TV } from "./axml";
import { inflateLayout } from "./inflate";
import { vcall, vcallMaybe } from "../jvm/natives/jlang";

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
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": function (this: JFrameLayout) {
    return vcallMaybe(this, "generateDefaultLayoutParams", "()Landroid/widget/FrameLayout$LayoutParams;");
  },
  "generateDefaultLayoutParams()Landroid/widget/FrameLayout$LayoutParams;": function () {
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
function mainMargin(c: JView, vertical: boolean): number {
  const m = c.lp instanceof JMarginLP ? c.lp : null;
  return m ? (vertical ? m.marginT + m.marginB : m.marginL + m.marginR) : 0;
}
function crossMargin(c: JView, vertical: boolean): number {
  const m = c.lp instanceof JMarginLP ? c.lp : null;
  return m ? (vertical ? m.marginL + m.marginR : m.marginT + m.marginB) : 0;
}
export const linearMethods: NativeSpec["methods"] = {
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
    let totalMain = 0, maxCross = 0, totalWeight = 0, consumed = 0, skipped = false;
    for (const c of kids) {
      const mMain = mainMargin(c, vertical), mCross = crossMargin(c, vertical);
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
      if (excessOnly) { if (vertical) c.lp!.height = 0; else c.lp!.width = 0; consumed += vertical ? c.measuredH : c.measuredW; }
      totalMain += (vertical ? c.measuredH : c.measuredW) + mMain;
      maxCross = Math.max(maxCross, (vertical ? c.measuredW : c.measuredH) + mCross);
    }
    const size = resolveSizeAndState(totalMain + mainPad, mainSpec);
    let excess = size - totalMain - mainPad + consumed;
    if (skipped || (excess !== 0 && totalWeight > 0)) {
      let wsum = this.weightSum > 0 ? this.weightSum : totalWeight;
      totalMain = 0;
      for (const c of kids) {
        const mMain = mainMargin(c, vertical), mCross = crossMargin(c, vertical);
        const weight = c.lp instanceof JLinearLP ? c.lp.weight : 0;
        if (weight > 0) {
          const share = Math.trunc(weight * excess / wsum);
          excess -= share; wsum -= weight;
          const dim = vertical ? c.lp!.height : c.lp!.width;
          const target = Math.max(0, (dim === 0 ? 0 : vertical ? c.measuredH : c.measuredW) + share);
          const crossSpec = childMeasureSpec(vertical ? wSpec : hSpec, crossPad + mCross, vertical ? c.lp!.width : c.lp!.height);
          await measureView(c, vertical ? crossSpec : makeSpec(target, MS_EXACTLY), vertical ? makeSpec(target, MS_EXACTLY) : crossSpec);
        }
        totalMain += (vertical ? c.measuredH : c.measuredW) + mMain;
        maxCross = Math.max(maxCross, (vertical ? c.measuredW : c.measuredH) + mCross);
      }
    }
    const finalCross = resolveSizeAndState(Math.max(maxCross + crossPad, vertical ? this.minW : this.minH), vertical ? wSpec : hSpec);
    this.measuredW = vertical ? finalCross : size;
    this.measuredH = vertical ? size : finalCross;
    for (const c of kids) {
      const crossDim = vertical ? c.lp?.width ?? WRAP_CONTENT : c.lp?.height ?? WRAP_CONTENT;
      if (crossDim === MATCH_PARENT) {
        const mCross = crossMargin(c, vertical);
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
    for (const c of kids) used += (vertical ? c.measuredH : c.measuredW) + mainMargin(c, vertical);
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
      await callSelf(linearMethods, "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V", this, c, set);
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
      await callSelf(linearMethods, "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V", this, c, set);
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
for (const owner of ["TableRow", "TableLayout"]) rt.register({
  name: `android/widget/${owner}$LayoutParams`, ctor: class extends JLinearLP {}, sup: "android/widget/LinearLayout$LayoutParams",
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
      this.velo = trackVelocity(this.velo, d, dt);
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
      let v = restVelocity(this.velo, SCROLL_WEIGHT, ev.eventTime - this.lastMoveT);
      if (this.dragging && Math.abs(v) > FLING.arm) {
        const anim = () => {
          if (this.flingAnim !== anim) return false;
          if (this.horizontal) this.scrollX += v;
          else this.scrollY += v;
          const before = this.horizontal ? this.scrollX : this.scrollY;
          this.clampScroll();
          const after = this.horizontal ? this.scrollX : this.scrollY;
          v *= FLING.decay;
          invalidate();
          return Math.abs(v) > FLING.stop && before === after;
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
const NO_MARGIN = { marginL: 0, marginT: 0, marginR: 0, marginB: 0 };
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
    const pos = this.rlPos;
    pos.clear();
    const byId = new Map<number, JView>();
    for (const c of kids) if (c.idNum > 0) byId.set(c.idNum, c);
    const anchorPos = (v: JView) => pos.get(v) ?? { l: v.left, t: v.top };
    let maxR = 0, maxB = 0;
    for (const c of kids) {
      const lp = c.lp instanceof JRelativeLP ? c.lp : null;
      const m = c.lp instanceof JMarginLP ? c.lp : NO_MARGIN;
      let l = this.padL + m.marginL;
      let t = this.padT + m.marginT;
      if (lp) {
        const anchor = (verb: number): JView | null => {
          const id = lp.rules.get(verb);
          return id && id > 0 ? byId.get(id) ?? null : null;
        };
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
    for (const c of kids) {
      if (c.lp?.width === MATCH_PARENT || c.lp?.height === MATCH_PARENT) {
        const m = c.lp instanceof JMarginLP ? c.lp : NO_MARGIN;
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
