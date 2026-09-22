import { AID } from "./res";
import {
  JMarginLP, type JLayoutParams, JViewGroup, JFrameLP, MATCH_PARENT, lpFromAttrs, lpAttrs, measureChildWithMargins,
  resolveSizeAndState, measuredSize, makeSpec, MS_EXACTLY, childMeasureSpec, measureView, layoutView, initViewFromCtx,
  requestLayout, JLinearLP, WRAP_CONTENT, specMode, JView, MS_UNSPEC, specSize, invalidate, uiState, viewConstructors, marginCopy
} from "./view";
import { JObj, type NativeSpec, rt, callSelf, noops } from "../jvm/runtime";
import { type JAttrSet, type Resources, obtainStyled, rvInt, rvFloat, rvDimen, onFramework } from "./res";
import { type JDrawable, loadDrawableRV, drawChild } from "./drawable";
import type { JCanvas } from "./graphics";
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
  marginCopy.call(n, lp);
  return n;
}

export class JFrameLayout extends JViewGroup { measureAllChildren = false; }
/** Layout subclasses expose the covariant descriptors declared by the Android SDK in addition
 *  to ViewGroup's erased descriptor. */
function covariantLayoutParams(methods: NativeSpec["methods"], lp: string): void {
  const m = methods as Record<string, unknown>;
  m[`generateLayoutParams(Landroid/util/AttributeSet;)L${lp};`] = m["generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;"];
  m[`generateDefaultLayoutParams()L${lp};`] ??= m["generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;"];
}
const frameMethods: NativeSpec["methods"] = {
  ...viewConstructors,
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
  "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z": (lp: unknown) => +(lp instanceof JFrameLP),
  "onMeasure(II)V": async function (this: JFrameLayout, wSpec: number, hSpec: number) {
    let mw = 0, mh = 0, matchCount = 0, state = 0;
    for (const c of this.children) {
      if (c.visibility === 8 && !this.measureAllChildren) continue;
      await measureChildWithMargins(this, c, wSpec, 0, hSpec, 0);
      const lp = c.lp instanceof JMarginLP ? c.lp : null;
      mw = Math.max(mw, c.measuredW + (lp ? lp.marginL + lp.marginR : 0));
      mh = Math.max(mh, c.measuredH + (lp ? lp.marginT + lp.marginB : 0));
      state |= c.measuredState;
      if (c.lp?.width === MATCH_PARENT || c.lp?.height === MATCH_PARENT) matchCount++;
    }
    this.setMeasuredDimension(measuredSize(Math.max(mw + this.padL + this.padR, this.minW), wSpec, state),
      measuredSize(Math.max(mh + this.padT + this.padB, this.minH), hSpec, state << 16));
    if (matchCount <= 1 || (specMode(wSpec) === MS_EXACTLY && specMode(hSpec) === MS_EXACTLY)) return;
    for (const c of this.children) {
      if (c.visibility === 8 && !this.measureAllChildren) continue;
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
  "setMeasureAllChildren(Z)V": function (this: JFrameLayout, all: number) { this.measureAllChildren = !!all; },
  "getMeasureAllChildren()Z": function (this: JFrameLayout) { return +this.measureAllChildren; },
};
covariantLayoutParams(frameMethods, "android/widget/FrameLayout$LayoutParams");
rt.register({
  name: "android/widget/FrameLayout", ctor: JFrameLayout, sup: "android/view/ViewGroup",
  clinit: () => { rt.link("android/widget/FrameLayout$LayoutParams"); },
  methods: frameMethods,
});
rt.register({
  name: "android/widget/FrameLayout$LayoutParams", ctor: JFrameLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  fields: ["gravity"],
  methods: {
    "<init>(II)V": function (this: JFrameLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(III)V": function (this: JFrameLP, w: number, h: number, g: number) { this.width = w; this.height = h; this.gravity = g; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JFrameLP, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
      if (o instanceof JMarginLP) { this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB; }
      if (o instanceof JFrameLP) this.gravity = o.gravity;
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": lpAttrs,
  },
});

export class JLinearLayout extends JViewGroup {
  orientation = 0; // 0 horizontal, 1 vertical
  gravity = 48 | G.START;
  weightSum = 0;
  baselineAlignedChildIndex = -1;
  showDividers = 0; dividerPadding = 0;
  divider: JDrawable | null = null;
  dividerW = 0; dividerH = 0;
  dividerBefore(index: number): boolean { return !!(this.showDividers & (index === 0 ? 1 : 2)); }
  dividerSpace(count: number): number {
    return count ? ((this.showDividers & 1 ? 1 : 0) + (this.showDividers & 2 ? count - 1 : 0) + (this.showDividers & 4 ? 1 : 0)) * (this.orientation === 1 ? this.dividerH : this.dividerW) : 0;
  }
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
      const ta = obtainStyled(this.jres, this.theme, set, [AID("orientation"), AID("gravity"), AID("weightSum"), AID("showDividers"), AID("dividerPadding"), AID("divider")], 0, 0);
      if (ta.vals[0]) this.orientation = rvInt(this.jres, ta.vals[0], 0);
      if (ta.vals[1]) this.gravity = rvInt(this.jres, ta.vals[1], this.gravity);
      if (ta.vals[2]) this.weightSum = rvFloat(this.jres, ta.vals[2], 0);
      if (ta.vals[3]) this.showDividers = rvInt(this.jres, ta.vals[3], 0);
      if (ta.vals[4]) this.dividerPadding = Math.round(rvDimen(this.jres, ta.vals[4]));
      if (ta.vals[5]) await callSelf(linearMethods, "setDividerDrawable(Landroid/graphics/drawable/Drawable;)V", this, await loadDrawableRV(this.jres, ta.vals[5], this.theme));
    }
  },
  "setOrientation(I)V": function (this: JLinearLayout, o: number) { this.orientation = o; requestLayout(this); },
  "getOrientation()I": function (this: JLinearLayout) { return this.orientation; },
  "setGravity(I)V": function (this: JLinearLayout, g: number) { this.gravity = g; requestLayout(this); },
  "setWeightSum(F)V": function (this: JLinearLayout, w: number) { this.weightSum = w; },
  "setBaselineAlignedChildIndex(I)V": function (this: JLinearLayout, index: number) {
    if (index < 0 || index >= this.children.length)
      throw rt.mkThrowable("java/lang/IllegalArgumentException", `base aligned child index out of range (0, ${this.children.length})`);
    this.baselineAlignedChildIndex = index;
  },
  "getBaselineAlignedChildIndex()I": function (this: JLinearLayout) { return this.baselineAlignedChildIndex; },
  "setShowDividers(I)V": function (this: JLinearLayout, flags: number) { if (this.showDividers !== flags) { this.showDividers = flags; requestLayout(this); } },
  "getShowDividers()I": function (this: JLinearLayout) { return this.showDividers; },
  "setDividerPadding(I)V": function (this: JLinearLayout, padding: number) { this.dividerPadding = padding; invalidate(this); },
  "getDividerPadding()I": function (this: JLinearLayout) { return this.dividerPadding; },
  "getDividerDrawable()Landroid/graphics/drawable/Drawable;": function (this: JLinearLayout) { return this.divider; },
  "getDividerWidth()I": function (this: JLinearLayout) { return this.dividerW; },
  "setDividerDrawable(Landroid/graphics/drawable/Drawable;)V": async function (this: JLinearLayout, divider: JDrawable | null) {
    if (this.divider === divider) return;
    this.divider = divider;
    this.dividerW = divider ? await vcall(divider, "getIntrinsicWidth", "()I") : 0;
    this.dividerH = divider ? await vcall(divider, "getIntrinsicHeight", "()I") : 0;
    requestLayout(this);
  },
  "hasDividerBeforeChildAt(I)Z": function (this: JLinearLayout, index: number) {
    if (index === this.children.length) return +(!!(this.showDividers & 4));
    return +this.dividerBefore(this.children.slice(0, index).filter(c => c.visibility !== 8).length);
  },
  ...noops("setBaselineAligned(Z)V"),
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
  "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z": (lp: unknown) => +(lp instanceof JLinearLP),
  "onMeasure(II)V": async function (this: JLinearLayout, wSpec: number, hSpec: number) {
    const vertical = this.orientation === 1;
    const mainSpec = vertical ? hSpec : wSpec;
    const exact = specMode(mainSpec) === MS_EXACTLY;
    const mainPad = vertical ? this.padT + this.padB : this.padL + this.padR;
    const crossPad = vertical ? this.padL + this.padR : this.padT + this.padB;
    const kids = this.children.filter((c) => c.visibility !== 8);
    const wrapCross = specMode(vertical ? wSpec : hSpec) !== MS_EXACTLY
      && kids.some(c => (vertical ? c.lp?.width : c.lp?.height) !== MATCH_PARENT);
    const dividerSize = vertical ? this.dividerH : this.dividerW;
    let totalMain = 0, maxCross = 0, totalWeight = 0, consumed = 0, skipped = false;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (this.dividerBefore(i)) totalMain += dividerSize;
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
      const matchCross = wrapCross && (vertical ? c.lp?.width : c.lp?.height) === MATCH_PARENT;
      maxCross = Math.max(maxCross, (matchCross ? 0 : vertical ? c.measuredW : c.measuredH) + mCross);
    }
    if (kids.length && this.showDividers & 4) totalMain += dividerSize;
    const size = resolveSizeAndState(totalMain + mainPad, mainSpec);
    let excess = size - totalMain - mainPad + consumed;
    if (skipped || (excess !== 0 && totalWeight > 0)) {
      let wsum = this.weightSum > 0 ? this.weightSum : totalWeight;
      totalMain = this.dividerSpace(kids.length);
      maxCross = 0;
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
        const matchCross = wrapCross && (vertical ? c.lp?.width : c.lp?.height) === MATCH_PARENT;
        maxCross = Math.max(maxCross, (matchCross ? 0 : vertical ? c.measuredW : c.measuredH) + mCross);
      }
    }
    const finalCross = resolveSizeAndState(Math.max(maxCross + crossPad, vertical ? this.minW : this.minH), vertical ? wSpec : hSpec);
    this.measuredW = vertical ? finalCross : size;
    this.measuredH = vertical ? size : finalCross;
    for (const c of kids) {
      const crossDim = vertical ? c.lp?.width ?? WRAP_CONTENT : c.lp?.height ?? WRAP_CONTENT;
      if (crossDim === MATCH_PARENT && specMode(vertical ? wSpec : hSpec) !== MS_EXACTLY) {
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
    let used = this.dividerSpace(kids.length);
    for (const c of kids) used += (vertical ? c.measuredH : c.measuredW) + mainMargin(c, vertical);
    const gm = this.gravity;
    let pos = vertical
      ? (gravityV(gm) === 16 ? this.padT + ((this.height() - this.padT - this.padB - used) >> 1)
        : gravityV(gm) === 80 ? this.height() - this.padB - used : this.padT)
      : (gravityH(gm) === 1 ? this.padL + ((this.width() - this.padL - this.padR - used) >> 1)
        : gravityH(gm) === 5 ? this.width() - this.padR - used : this.padL);
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (this.dividerBefore(i)) pos += vertical ? this.dividerH : this.dividerW;
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
  "onDraw(Landroid/graphics/Canvas;)V": async function (this: JLinearLayout, canvas: JCanvas) {
    if (!this.divider || !this.showDividers) return;
    const vertical = this.orientation === 1, kids = this.children.filter(c => c.visibility !== 8);
    const size = vertical ? this.dividerH : this.dividerW, d = this.divider;
    const draw = async (position: number) => {
      await vcall(d, "setBounds", "(IIII)V", vertical ? this.padL + this.dividerPadding : position,
        vertical ? position : this.padT + this.dividerPadding,
        vertical ? this.width() - this.padR - this.dividerPadding : position + size,
        vertical ? position + size : this.height() - this.padB - this.dividerPadding);
      await drawChild(d, canvas);
    };
    for (let i = 0; i < kids.length; i++) if (this.dividerBefore(i)) {
      const c = kids[i], lp = c.lp instanceof JMarginLP ? c.lp : null;
      await draw(vertical ? c.top - (lp?.marginT ?? 0) - size : c.left - (lp?.marginL ?? 0) - size);
    }
    if (this.showDividers & 4) {
      const c = kids.at(-1), lp = c?.lp instanceof JMarginLP ? c.lp : null;
      await draw(c ? vertical ? c.bottom + (lp?.marginB ?? 0) : c.right + (lp?.marginR ?? 0)
        : vertical ? this.height() - this.padB - size : this.width() - this.padR - size);
    }
  },
};
covariantLayoutParams(linearMethods, "android/widget/LinearLayout$LayoutParams");
rt.register({
  name: "android/widget/LinearLayout", ctor: JLinearLayout, sup: "android/view/ViewGroup",
  clinit: () => { rt.link("android/widget/LinearLayout$LayoutParams"); },
  statics: { HORIZONTAL: 0, VERTICAL: 1, SHOW_DIVIDER_NONE: 0, SHOW_DIVIDER_BEGINNING: 1, SHOW_DIVIDER_MIDDLE: 2, SHOW_DIVIDER_END: 4 },
  methods: linearMethods,
});
rt.register({
  name: "android/widget/LinearLayout$LayoutParams", ctor: JLinearLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  fields: ["gravity", "weight"],
  methods: {
    "<init>(II)V": function (this: JLinearLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(IIF)V": function (this: JLinearLP, w: number, h: number, wt: number) { this.width = w; this.height = h; this.weight = wt; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JLinearLP, o: JLayoutParams) {
      if (o) { this.width = o.width; this.height = o.height; }
      if (o instanceof JMarginLP) { this.marginL = o.marginL; this.marginT = o.marginT; this.marginR = o.marginR; this.marginB = o.marginB; }
      if (o instanceof JLinearLP) { this.weight = o.weight; this.gravity = o.gravity; }
    },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": lpAttrs,
  },
});

// ── GridLayout: row/column specs, cell sizing, alignment, and weighted expansion.
const GRID_UNDEFINED = -2147483648;
class JGridAlignment extends JObj {
  constructor(readonly kind: "leading" | "trailing" | "center" | "fill" | "baseline") { super(); }
}
const GRID_LEADING = new JGridAlignment("leading");
const GRID_TRAILING = new JGridAlignment("trailing");
const GRID_CENTER = new JGridAlignment("center");
const GRID_FILL = new JGridAlignment("fill");
const GRID_BASELINE = new JGridAlignment("baseline");
class JGridSpec extends JObj {
  start = GRID_UNDEFINED;
  size = 1;
  alignment = GRID_LEADING;
  weight = 0;
}
function gridSpec(start: number, size = 1, alignment = GRID_LEADING, weight = 0): JGridSpec {
  if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "span must be positive");
  return Object.assign(new JGridSpec(), { start, size, alignment, weight });
}
const GRID_DEFAULT_SPEC = gridSpec(GRID_UNDEFINED);
class JGridLP extends JMarginLP {
  rowSpec = GRID_DEFAULT_SPEC;
  columnSpec = GRID_DEFAULT_SPEC;
}
type GridCell = { row: number; col: number; rowSpan: number; colSpan: number };
class JGridLayout extends JViewGroup {
  orientation = 0;
  rowCount = GRID_UNDEFINED;
  columnCount = GRID_UNDEFINED;
  alignmentMode = 1;
  useDefaultMargins = false;
  rowOrderPreserved = true;
  columnOrderPreserved = true;
  cells = new Map<JView, GridCell>();
  colWidths: number[] = [];
  rowHeights: number[] = [];
}
function copyGridLp(o: JLayoutParams | null): JGridLP {
  const lp = adoptLp(JGridLP, o);
  if (o instanceof JGridLP) { lp.rowSpec = o.rowSpec; lp.columnSpec = o.columnSpec; }
  return lp;
}
function assignGrid(g: JGridLayout, kids: JView[]): void {
  const cells = g.cells;
  cells.clear();
  const fixedCols = g.columnCount > 0 ? g.columnCount : 1;
  const fixedRows = g.rowCount > 0 ? g.rowCount : 1;
  let cursor = 0;
  for (const child of kids) {
    const lp = child.lp instanceof JGridLP ? child.lp : null;
    const rs = Math.max(1, lp?.rowSpec.size ?? 1), cs = Math.max(1, lp?.columnSpec.size ?? 1);
    let row = lp?.rowSpec.start ?? GRID_UNDEFINED, col = lp?.columnSpec.start ?? GRID_UNDEFINED;
    if (row === GRID_UNDEFINED && col === GRID_UNDEFINED) {
      if (g.orientation === 0) { row = Math.floor(cursor / fixedCols); col = cursor % fixedCols; cursor += cs; }
      else { col = Math.floor(cursor / fixedRows); row = cursor % fixedRows; cursor += rs; }
    } else if (row === GRID_UNDEFINED) row = g.orientation === 1 ? cursor++ % fixedRows : 0;
    else if (col === GRID_UNDEFINED) col = g.orientation === 0 ? cursor++ % fixedCols : 0;
    cells.set(child, { row, col, rowSpan: rs, colSpan: cs });
  }
}
function growTracks(tracks: number[], start: number, span: number, need: number): void {
  let have = 0;
  for (let i = 0; i < span; i++) have += tracks[start + i] ?? 0;
  let extra = Math.max(0, need - have);
  for (let i = 0; i < span && extra; i++) {
    const add = Math.ceil(extra / (span - i));
    tracks[start + i] = (tracks[start + i] ?? 0) + add;
    extra -= add;
  }
}
function trackOffset(tracks: number[], end: number): number {
  let out = 0;
  for (let i = 0; i < end; i++) out += tracks[i] ?? 0;
  return out;
}
function trackSpan(tracks: number[], start: number, span: number): number {
  let out = 0;
  for (let i = 0; i < span; i++) out += tracks[start + i] ?? 0;
  return out;
}
function expandWeightedTracks(g: JGridLayout, kids: JView[], tracks: number[], horizontal: boolean, available: number): void {
  let extra = available - trackOffset(tracks, tracks.length);
  if (extra <= 0) return;
  const weights = Array(tracks.length).fill(0) as number[];
  for (const child of kids) {
    if (!(child.lp instanceof JGridLP)) continue;
    const cell = g.cells.get(child);
    if (!cell) continue;
    const spec = horizontal ? child.lp.columnSpec : child.lp.rowSpec;
    const start = horizontal ? cell.col : cell.row, span = horizontal ? cell.colSpan : cell.rowSpan;
    for (let i = 0; i < span; i++) weights[start + i] += spec.weight / span;
  }
  let remaining = weights.reduce((a, b) => a + b, 0);
  if (remaining <= 0) return;
  for (let i = 0; i < tracks.length; i++) {
    if (weights[i] <= 0) continue;
    const add = Math.round(extra * weights[i] / remaining);
    tracks[i] += add; extra -= add; remaining -= weights[i];
  }
}
function alignInCell(kind: JGridAlignment["kind"], start: number, extent: number, child: number): number {
  return kind === "trailing" ? start + extent - child : kind === "center" ? start + ((extent - child) >> 1) : start;
}
const gridAttrs = ["layout_row", "layout_column", "layout_rowSpan", "layout_columnSpan", "layout_rowWeight", "layout_columnWeight"] as const;
function gridLpFromAttrs(res: Resources, set: JAttrSet, lp = new JGridLP()): JGridLP {
  lpFromAttrs(lp, res, set);
  const vals = obtainStyled(res, set.theme, set, gridAttrs.map(AID), 0, 0).vals;
  const integer = (i: number, d: number) => vals[i] ? rvInt(res, vals[i], d) : d;
  const weight = (i: number) => vals[i] ? rvFloat(res, vals[i], 0) : 0;
  lp.rowSpec = gridSpec(integer(0, GRID_UNDEFINED), integer(2, 1), GRID_LEADING, weight(4));
  lp.columnSpec = gridSpec(integer(1, GRID_UNDEFINED), integer(3, 1), GRID_LEADING, weight(5));
  return lp;
}
const gridMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Landroid/content/Context;)V": async function (this: JGridLayout, c: unknown) { await initViewFromCtx(this, c, null); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JGridLayout, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (!set || !this.jres) return;
    const ta = obtainStyled(this.jres, this.theme, set, [AID("orientation"), AID("rowCount"), AID("columnCount"), AID("useDefaultMargins"), AID("alignmentMode")], 0, 0);
    if (ta.vals[0]) this.orientation = rvInt(this.jres, ta.vals[0], 0);
    if (ta.vals[1]) this.rowCount = rvInt(this.jres, ta.vals[1], GRID_UNDEFINED);
    if (ta.vals[2]) this.columnCount = rvInt(this.jres, ta.vals[2], GRID_UNDEFINED);
    if (ta.vals[3]) this.useDefaultMargins = !!rvInt(this.jres, ta.vals[3], 0);
    if (ta.vals[4]) this.alignmentMode = rvInt(this.jres, ta.vals[4], 1);
  },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": async function (this: JGridLayout, c: unknown, set: JAttrSet | null) {
    await callSelf(gridMethods, "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V", this, c, set);
  },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": async function (this: JGridLayout, c: unknown, set: JAttrSet | null) {
    await callSelf(gridMethods, "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V", this, c, set);
  },
  "setOrientation(I)V": function (this: JGridLayout, v: number) { this.orientation = v; requestLayout(this); },
  "getOrientation()I": function (this: JGridLayout) { return this.orientation; },
  "setRowCount(I)V": function (this: JGridLayout, v: number) { if (v < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "rowCount must be non-negative"); this.rowCount = v; requestLayout(this); },
  "getRowCount()I": function (this: JGridLayout) { return this.rowCount === GRID_UNDEFINED ? 0 : this.rowCount; },
  "setColumnCount(I)V": function (this: JGridLayout, v: number) { if (v < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "columnCount must be non-negative"); this.columnCount = v; requestLayout(this); },
  "getColumnCount()I": function (this: JGridLayout) { return this.columnCount === GRID_UNDEFINED ? 0 : this.columnCount; },
  "setUseDefaultMargins(Z)V": function (this: JGridLayout, v: number) { this.useDefaultMargins = !!v; requestLayout(this); },
  "getUseDefaultMargins()Z": function (this: JGridLayout) { return this.useDefaultMargins ? 1 : 0; },
  "setAlignmentMode(I)V": function (this: JGridLayout, v: number) { this.alignmentMode = v; requestLayout(this); },
  "getAlignmentMode()I": function (this: JGridLayout) { return this.alignmentMode; },
  "setRowOrderPreserved(Z)V": function (this: JGridLayout, v: number) { this.rowOrderPreserved = !!v; },
  "isRowOrderPreserved()Z": function (this: JGridLayout) { return this.rowOrderPreserved ? 1 : 0; },
  "setColumnOrderPreserved(Z)V": function (this: JGridLayout, v: number) { this.columnOrderPreserved = !!v; },
  "isColumnOrderPreserved()Z": function (this: JGridLayout) { return this.columnOrderPreserved ? 1 : 0; },
  "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": () => new JGridLP(),
  "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": copyGridLp,
  "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z": (lp: unknown) => +(lp instanceof JGridLP),
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JGridLayout, set: JAttrSet) {
    return this.jres ? gridLpFromAttrs(this.jres, set) : new JGridLP();
  },
  "onMeasure(II)V": async function (this: JGridLayout, wSpec: number, hSpec: number) {
    const kids = this.children.filter((c) => c.visibility !== 8);
    assignGrid(this, kids);
    let cols = this.columnCount > 0 ? this.columnCount : 0, rows = this.rowCount > 0 ? this.rowCount : 0;
    for (const c of kids) {
      const cell = this.cells.get(c);
      if (!cell) continue;
      cols = Math.max(cols, cell.col + cell.colSpan); rows = Math.max(rows, cell.row + cell.rowSpan);
      await measureChildWithMargins(this, c, wSpec, 0, hSpec, 0);
    }
    const cw = this.colWidths = Array(cols).fill(0), rh = this.rowHeights = Array(rows).fill(0);
    for (const c of kids) {
      const cell = this.cells.get(c); if (!cell) continue;
      const m = c.lp instanceof JMarginLP ? c.lp : NO_MARGIN;
      growTracks(cw, cell.col, cell.colSpan, c.measuredW + m.marginL + m.marginR);
      growTracks(rh, cell.row, cell.rowSpan, c.measuredH + m.marginT + m.marginB);
    }
    expandWeightedTracks(this, kids, cw, true, specSize(wSpec) - this.padL - this.padR);
    expandWeightedTracks(this, kids, rh, false, specSize(hSpec) - this.padT - this.padB);
    this.measuredW = resolveSizeAndState(trackOffset(cw, cw.length) + this.padL + this.padR, wSpec);
    this.measuredH = resolveSizeAndState(trackOffset(rh, rh.length) + this.padT + this.padB, hSpec);
  },
  "onLayout(ZIIII)V": async function (this: JGridLayout) {
    for (const c of this.children) {
      if (c.visibility === 8) continue;
      const cell = this.cells.get(c); if (!cell) continue;
      const lp = c.lp instanceof JGridLP ? c.lp : null, m = c.lp instanceof JMarginLP ? c.lp : NO_MARGIN;
      const left = this.padL + trackOffset(this.colWidths, cell.col) + m.marginL;
      const top = this.padT + trackOffset(this.rowHeights, cell.row) + m.marginT;
      const width = trackSpan(this.colWidths, cell.col, cell.colSpan) - m.marginL - m.marginR;
      const height = trackSpan(this.rowHeights, cell.row, cell.rowSpan) - m.marginT - m.marginB;
      const ha = lp?.columnSpec.alignment ?? GRID_LEADING, va = lp?.rowSpec.alignment ?? GRID_LEADING;
      if ((ha.kind === "fill" && c.measuredW !== width) || (va.kind === "fill" && c.measuredH !== height)) {
        await measureView(c, makeSpec(ha.kind === "fill" ? Math.max(0, width) : c.measuredW, MS_EXACTLY),
          makeSpec(va.kind === "fill" ? Math.max(0, height) : c.measuredH, MS_EXACTLY));
      }
      const x = alignInCell(ha.kind, left, width, c.measuredW), y = alignInCell(va.kind, top, height, c.measuredH);
      await layoutView(c, x, y, x + c.measuredW, y + c.measuredH);
    }
  },
};
rt.register({
  name: "android/widget/GridLayout", ctor: JGridLayout, sup: "android/view/ViewGroup",
  clinit: () => { rt.link("android/widget/GridLayout$LayoutParams"); rt.link("android/widget/GridLayout$Spec"); },
  statics: {
    HORIZONTAL: 0, VERTICAL: 1, UNDEFINED: GRID_UNDEFINED, ALIGN_BOUNDS: 0, ALIGN_MARGINS: 1,
    LEADING: GRID_LEADING, TRAILING: GRID_TRAILING, LEFT: GRID_LEADING, TOP: GRID_LEADING,
    RIGHT: GRID_TRAILING, BOTTOM: GRID_TRAILING, CENTER: GRID_CENTER, BASELINE: GRID_BASELINE, FILL: GRID_FILL,
  },
  methods: {
    ...gridMethods,
    "static spec(I)Landroid/widget/GridLayout$Spec;": (start: number) => gridSpec(start),
    "static spec(II)Landroid/widget/GridLayout$Spec;": (start: number, size: number) => gridSpec(start, size),
    "static spec(ILandroid/widget/GridLayout$Alignment;)Landroid/widget/GridLayout$Spec;": (start: number, a: JGridAlignment) => gridSpec(start, 1, a),
    "static spec(IILandroid/widget/GridLayout$Alignment;)Landroid/widget/GridLayout$Spec;": (start: number, size: number, a: JGridAlignment) => gridSpec(start, size, a),
    "static spec(IF)Landroid/widget/GridLayout$Spec;": (start: number, weight: number) => gridSpec(start, 1, GRID_LEADING, weight),
    "static spec(IIF)Landroid/widget/GridLayout$Spec;": (start: number, size: number, weight: number) => gridSpec(start, size, GRID_LEADING, weight),
    "static spec(ILandroid/widget/GridLayout$Alignment;F)Landroid/widget/GridLayout$Spec;": (start: number, a: JGridAlignment, weight: number) => gridSpec(start, 1, a, weight),
    "static spec(IILandroid/widget/GridLayout$Alignment;F)Landroid/widget/GridLayout$Spec;": (start: number, size: number, a: JGridAlignment, weight: number) => gridSpec(start, size, a, weight),
  },
});
rt.register({ name: "android/widget/GridLayout$Alignment", ctor: JGridAlignment });
rt.register({ name: "android/widget/GridLayout$Spec", ctor: JGridSpec });
rt.register({
  name: "android/widget/GridLayout$LayoutParams", ctor: JGridLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  fields: ["rowSpec", "columnSpec"],
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V": function (this: JGridLP, row: JGridSpec, col: JGridSpec) { this.rowSpec = row; this.columnSpec = col; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JGridLP, o: JLayoutParams) { Object.assign(this, copyGridLp(o)); },
    "<init>(Landroid/view/ViewGroup$MarginLayoutParams;)V": function (this: JGridLP, o: JMarginLP) { Object.assign(this, copyGridLp(o)); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JGridLP, _c: unknown, set: JAttrSet) { gridLpFromAttrs(set.res, set, this); },
  },
});

// ── TableLayout / TableRow: vertical/horizontal LinearLayouts with column alignment.
// TableLayout pre-computes per-column widths (natural max across rows, stretch columns
// absorb leftover) and hands them to each row; rows then measure cells to exact columns.
class JTableLayout extends JLinearLayout {
  stretchCols = new Set<number>();
  shrinkCols = new Set<number>();
  stretchAll = false;
  shrinkAll = false;
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
      for (const [attr, cols, all] of [["stretchColumns", "stretchCols", "stretchAll"], ["shrinkColumns", "shrinkCols", "shrinkAll"]] as const) {
        const value = set?.node?.attrs.find(a => a.resId === AID(attr));
        const text = value?.str ?? (value ? String(value.data) : "");
        this[all] = text.startsWith("*");
        for (const part of text.split(",")) if (/^\s*\d+\s*$/.test(part)) this[cols].add(Number(part));
      }
    },
    "setStretchAllColumns(Z)V": function (this: JTableLayout, v: number) { this.stretchAll = !!v; },
    "setShrinkAllColumns(Z)V": function (this: JTableLayout, v: number) { this.shrinkAll = !!v; },
    "isStretchAllColumns()Z": function (this: JTableLayout) { return +this.stretchAll; },
    "isShrinkAllColumns()Z": function (this: JTableLayout) { return +this.shrinkAll; },
    "isColumnStretchable(I)Z": function (this: JTableLayout, i: number) { return +(this.stretchAll || this.stretchCols.has(i)); },
    "isColumnShrinkable(I)Z": function (this: JTableLayout, i: number) { return +(this.shrinkAll || this.shrinkCols.has(i)); },
    "setColumnStretchable(IZ)V": function (this: JTableLayout, i: number, v: number) {
      if (v) this.stretchCols.add(i); else this.stretchCols.delete(i);
      for (const row of this.children) requestLayout(row);
    },
    "setColumnShrinkable(IZ)V": function (this: JTableLayout, i: number, v: number) {
      if (v) this.shrinkCols.add(i); else this.shrinkCols.delete(i);
      for (const row of this.children) requestLayout(row);
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
      if (avail !== total && colW.length && specMode(wSpec) !== MS_UNSPEC) {
        const all = avail > total ? this.stretchAll : this.shrinkAll;
        const cols = avail > total ? this.stretchCols : this.shrinkCols;
        const indices = all ? colW.map((_, i) => i) : [...cols].filter(i => i >= 0 && i < colW.length);
        if (indices.length) {
          const delta = Math.trunc((avail - total) / indices.length);
          for (const i of indices) colW[i] = Math.max(0, colW[i] + delta);
        }
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
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": lpAttrs,
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
  rules = new Int32Array(22);
  initialRules = new Int32Array(22);
  rulesChanged = true;
  ruleDirection = -1;
  alignWithParent = false;           // layout_alignWithParentIfMissing, a public field on AOSP
  addRule(verb: number, anchor: number): void {
    this.rules[verb] = this.initialRules[verb] = anchor;
    this.rulesChanged = true;
  }
  resolveRules(direction: number): Int32Array {
    if (!this.rulesChanged && this.ruleDirection === direction) return this.rules;
    const r = this.rules;
    r.set(this.initialRules);
    for (const [start, end, left, right] of relativeRulePairs) {
      if (r[start] || r[end]) {
        r[left] = direction === 1 ? r[end] : r[start];
        r[right] = direction === 1 ? r[start] : r[end];
        r[start] = r[end] = 0;
      }
    }
    this.ruleDirection = direction;
    this.rulesChanged = false;
    return r;
  }
}
const RL = {
  LEFT_OF: 0, RIGHT_OF: 1, ABOVE: 2, BELOW: 3, ALIGN_BASELINE: 4, ALIGN_LEFT: 5, ALIGN_TOP: 6,
  ALIGN_RIGHT: 7, ALIGN_BOTTOM: 8, ALIGN_PARENT_LEFT: 9, ALIGN_PARENT_TOP: 10,
  ALIGN_PARENT_RIGHT: 11, ALIGN_PARENT_BOTTOM: 12, CENTER_IN_PARENT: 13, CENTER_HORIZONTAL: 14,
  CENTER_VERTICAL: 15, START_OF: 16, END_OF: 17, ALIGN_START: 18, ALIGN_END: 19,
  ALIGN_PARENT_START: 20, ALIGN_PARENT_END: 21,
};
const relativeRulePairs = [
  [RL.START_OF, RL.END_OF, RL.LEFT_OF, RL.RIGHT_OF],
  [RL.ALIGN_START, RL.ALIGN_END, RL.ALIGN_LEFT, RL.ALIGN_RIGHT],
  [RL.ALIGN_PARENT_START, RL.ALIGN_PARENT_END, RL.ALIGN_PARENT_LEFT, RL.ALIGN_PARENT_RIGHT],
] as const;
const rlAttrByName: [string, number][] = [
  ["layout_toLeftOf", RL.LEFT_OF], ["layout_toRightOf", RL.RIGHT_OF], ["layout_above", RL.ABOVE],
  ["layout_below", RL.BELOW], ["layout_alignBaseline", RL.ALIGN_BASELINE], ["layout_alignLeft", RL.ALIGN_LEFT],
  ["layout_alignTop", RL.ALIGN_TOP], ["layout_alignRight", RL.ALIGN_RIGHT], ["layout_alignBottom", RL.ALIGN_BOTTOM],
  ["layout_alignParentLeft", RL.ALIGN_PARENT_LEFT], ["layout_alignParentTop", RL.ALIGN_PARENT_TOP],
  ["layout_alignParentRight", RL.ALIGN_PARENT_RIGHT], ["layout_alignParentBottom", RL.ALIGN_PARENT_BOTTOM],
  ["layout_centerInParent", RL.CENTER_IN_PARENT], ["layout_centerHorizontal", RL.CENTER_HORIZONTAL],
  ["layout_centerVertical", RL.CENTER_VERTICAL], ["layout_toStartOf", RL.START_OF], ["layout_toEndOf", RL.END_OF],
  ["layout_alignStart", RL.ALIGN_START], ["layout_alignEnd", RL.ALIGN_END],
  ["layout_alignParentStart", RL.ALIGN_PARENT_START], ["layout_alignParentEnd", RL.ALIGN_PARENT_END],
];
const rlAttrIds: (readonly [number, number])[] = [];
onFramework(() => { for (const [n, verb] of rlAttrByName) rlAttrIds.push([AID(n), verb] as const); });
class JRelativeLayout extends JViewGroup {
  /** positions resolved by the last onMeasure, consumed by onLayout */
  rlPos = new Map<JView, { l: number; t: number; fixedW: boolean; fixedH: boolean }>();
  gravityR = G.START | G.TOP;
  ignoreGravity = 0;
}
const NO_MARGIN = { marginL: 0, marginT: 0, marginR: 0, marginB: 0 };
const relativeMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JRelativeLayout, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("gravity")], 0, 0);
      if (ta.vals[0]) this.gravityR = rvInt(this.jres, ta.vals[0], this.gravityR);
    }
  },
  "getGravity()I": function (this: JRelativeLayout) { return this.gravityR; },
  "getIgnoreGravity()I": function (this: JRelativeLayout) { return this.ignoreGravity; },
  "setIgnoreGravity(I)V": function (this: JRelativeLayout, id: number) { this.ignoreGravity = id; },
  "setGravity(I)V": function (this: JRelativeLayout, g: number) {
    if (this.gravityR === g) return;
    if (!(g & G.H_MASK)) g |= G.START;
    if (!(g & G.V_MASK)) g |= G.TOP;
    this.gravityR = g;
    requestLayout(this);
  },
  "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JRelativeLayout, set: JAttrSet) {
    const lp = lpFromAttrs(new JRelativeLP(), this.jres!, set);
    if (set.node) {
      for (const a of set.node.attrs) {
        for (const [aid, verb] of rlAttrIds) {
          if (aid && a.resId === aid) {
            lp.addRule(verb, a.type === TV.BOOLEAN || a.type >= TV.INT_DEC ? (a.data ? (a.data > 1 ? a.data : -1) : 0) : a.data);
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
  "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z": (lp: unknown) => +(lp instanceof JRelativeLP),
  "onMeasure(II)V": async function (this: JRelativeLayout, wSpec: number, hSpec: number) {
    const availW = specSize(wSpec), availH = specSize(hSpec);
    const wrapW = specMode(wSpec) !== MS_EXACTLY, wrapH = specMode(hSpec) !== MS_EXACTLY;
    const direction = await vcall(this, "getLayoutDirection", "()I");
    for (const c of this.children) if (c.lp instanceof JRelativeLP) c.lp.resolveRules(direction);
    const kids = this.children.filter((c) => c.visibility !== 8);
    for (const c of kids) {
      const w = c.lp?.width === MATCH_PARENT && specMode(wSpec) !== MS_UNSPEC ? makeSpec(availW, MS_EXACTLY) : wSpec;
      const h = c.lp?.height === MATCH_PARENT && specMode(hSpec) !== MS_UNSPEC ? makeSpec(availH, MS_EXACTLY) : hSpec;
      await measureChildWithMargins(this, c, w, 0, h, 0);
    }
    const pos = this.rlPos;
    pos.clear();
    const byId = new Map<number, JView>();
    for (const c of this.children) if (c.idNum > 0) byId.set(c.idNum, c);
    // a rule naming a later sibling reads where that sibling sat last pass until this pass places it
    let forward = false;
    const anchorPos = (v: JView) => {
      const p = pos.get(v);
      if (p) return p;
      forward = true;
      return { l: v.left, t: v.top };
    };
    let maxR = 0, maxB = 0;
    // AOSP sorts the children by their anchor graph. Walking them in order instead, a forward
    // reference resolves on a later walk: repeat until nothing moves, which a chain of n
    // children needs at most n times.
    for (let walk = 0, moved = true; moved && walk <= kids.length; walk++) {
      moved = false; maxR = 0; maxB = 0;
      for (const c of kids) {
        const lp = c.lp instanceof JRelativeLP ? c.lp : null;
        const m = c.lp instanceof JMarginLP ? c.lp : NO_MARGIN;
        let l = this.padL + m.marginL;
        let t = this.padT + m.marginT;
        let fixedW = false, fixedH = false;
        if (lp) {
          const anchor = (verb: number): JView | null => {
            let view = byId.get(lp.rules[verb]);
            for (let hops = 0; view && hops < byId.size; hops++) {
              if (view.visibility !== 8) return view;
              view = view.lp instanceof JRelativeLP ? byId.get(view.lp.rules[verb]) : undefined;
            }
            return null;
          };
          if (lp.rules[RL.ALIGN_PARENT_RIGHT]) l = availW - this.padR - c.measuredW - m.marginR;
          if (!wrapW && (lp.rules[RL.CENTER_HORIZONTAL] || lp.rules[RL.CENTER_IN_PARENT])) l = (availW - c.measuredW) >> 1;
          if (lp.rules[RL.ALIGN_PARENT_BOTTOM]) t = availH - this.padB - c.measuredH - m.marginB;
          if (!wrapH && (lp.rules[RL.CENTER_VERTICAL] || lp.rules[RL.CENTER_IN_PARENT])) t = (availH - c.measuredH) >> 1;
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
          // AOSP getChildMeasureSpec: rules that fix both edges measure the child EXACTLY to the
          // span between them, whatever its layout_width/height (a later rule overrides an
          // earlier one, as in applyHorizontalSizeRules)
          const lE = lp.rules[RL.ALIGN_PARENT_LEFT] ? this.padL + m.marginL : aL ? anchorPos(aL).l : rOf ? anchorPos(rOf).l + rOf.measuredW + m.marginL : NaN;
          const rE = lp.rules[RL.ALIGN_PARENT_RIGHT] ? availW - this.padR - m.marginR : aR ? anchorPos(aR).l + aR.measuredW : lOf ? anchorPos(lOf).l - m.marginR : NaN;
          const tE = lp.rules[RL.ALIGN_PARENT_TOP] ? this.padT + m.marginT : aT ? anchorPos(aT).t : below ? anchorPos(below).t + below.measuredH + m.marginT : NaN;
          const bE = lp.rules[RL.ALIGN_PARENT_BOTTOM] ? availH - this.padB - m.marginB : aB ? anchorPos(aB).t + aB.measuredH : above ? anchorPos(above).t - m.marginB : NaN;
          const spanW = rE - lE, spanH = bE - tE;
          fixedW = spanW === spanW; fixedH = spanH === spanH;
          if (spanW === spanW || spanH === spanH) {
            if (spanW === spanW) l = lE;
            if (spanH === spanH) t = tE;
            const w = spanW === spanW ? Math.max(0, spanW) : c.measuredW, h = spanH === spanH ? Math.max(0, spanH) : c.measuredH;
            if (w !== c.measuredW || h !== c.measuredH) await measureView(c,
              spanW === spanW ? makeSpec(w, MS_EXACTLY) : childMeasureSpec(wSpec, this.padL + this.padR + m.marginL + m.marginR, lp.width),
              spanH === spanH ? makeSpec(h, MS_EXACTLY) : childMeasureSpec(hSpec, this.padT + this.padB + m.marginT + m.marginB, lp.height));
          }
        }
        const p = pos.get(c);
        if (!p) pos.set(c, { l, t, fixedW, fixedH });
        else {
          if (p.l !== l || p.t !== t) { p.l = l; p.t = t; moved = true; }
          p.fixedW = fixedW; p.fixedH = fixedH;
        }
        maxR = Math.max(maxR, l + c.measuredW + m.marginR);
        maxB = Math.max(maxB, t + c.measuredH + m.marginB);
      }
      // the first walk places everything; only a forward reference makes a second one worth it
      if (walk === 0) moved = forward;
    }
    this.measuredW = resolveSizeAndState(Math.max(this.minW, maxR + this.padR), wSpec);
    this.measuredH = resolveSizeAndState(Math.max(this.minH, maxB + this.padB), hSpec);
    for (const c of kids) {
      const lp = c.lp, p = pos.get(c);
      if (c.lp?.width === MATCH_PARENT || c.lp?.height === MATCH_PARENT) {
        const m = c.lp instanceof JMarginLP ? c.lp : NO_MARGIN;
        const w = c.lp.width === MATCH_PARENT && !p?.fixedW ? this.measuredW - this.padL - this.padR - m.marginL - m.marginR : c.measuredW;
        const h = c.lp.height === MATCH_PARENT && !p?.fixedH ? this.measuredH - this.padT - this.padB - m.marginT - m.marginB : c.measuredH;
        await measureView(c, makeSpec(Math.max(0, w), MS_EXACTLY), makeSpec(Math.max(0, h), MS_EXACTLY));
      }
      if (lp instanceof JRelativeLP && p) {
        if (wrapW && !p.fixedW && (lp.rules[RL.CENTER_HORIZONTAL] || lp.rules[RL.CENTER_IN_PARENT])) p.l = (this.measuredW - c.measuredW) >> 1;
        if (wrapH && !p.fixedH && (lp.rules[RL.CENTER_VERTICAL] || lp.rules[RL.CENTER_IN_PARENT])) p.t = (this.measuredH - c.measuredH) >> 1;
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
covariantLayoutParams(relativeMethods, "android/widget/RelativeLayout$LayoutParams");
rt.register({ name: "android/widget/RelativeLayout", ctor: JRelativeLayout, sup: "android/view/ViewGroup",
  clinit: () => { rt.link("android/widget/RelativeLayout$LayoutParams"); },
  statics: { TRUE: -1 },
  methods: relativeMethods });
rt.register({
  name: "android/widget/RelativeLayout$LayoutParams", ctor: JRelativeLP, sup: "android/view/ViewGroup$MarginLayoutParams",
  fields: ["alignWithParent"],
  methods: {
    "<init>(II)V": function (this: JRelativeLP, w: number, h: number) { this.width = w; this.height = h; },
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JRelativeLP, o: JLayoutParams) {
      this.width = o.width; this.height = o.height;
    },
    "<init>(Landroid/view/ViewGroup$MarginLayoutParams;)V": marginCopy,
    "<init>(Landroid/widget/RelativeLayout$LayoutParams;)V": function (this: JRelativeLP, o: JRelativeLP) {
      marginCopy.call(this, o);
      this.rules.set(o.rules);
      this.initialRules.set(o.initialRules);
      this.rulesChanged = o.rulesChanged;
      this.ruleDirection = o.ruleDirection;
      this.alignWithParent = o.alignWithParent;
    },
    "getRules()[I": function (this: JRelativeLP) { return this.rules; },
    "getRules(I)[I": function (this: JRelativeLP, direction: number) { return this.resolveRules(direction); },
    "resolveLayoutDirection(I)V": function (this: JRelativeLP, direction: number) { this.resolveRules(direction); },
    "getRule(I)I": function (this: JRelativeLP, verb: number) { return this.rules[verb]; },
    "addRule(I)V": function (this: JRelativeLP, verb: number) { this.addRule(verb, -1); },
    "addRule(II)V": function (this: JRelativeLP, verb: number, anchor: number) { this.addRule(verb, anchor); },
    "removeRule(I)V": function (this: JRelativeLP, verb: number) { this.addRule(verb, 0); },
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
rt.markers("android/view/ViewStub$OnInflateListener");
