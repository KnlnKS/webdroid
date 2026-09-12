import { AID } from "./res";
import { JView, initViewFromCtx, requestLayout, invalidate, resolveSizeAndState, specMode, MS_EXACTLY } from "./view";
import {
  type JDrawable, type JColorStateList, loadDrawableRV, loadDrawable, JBitmapDrawable, cslColor, drawChild
} from "./drawable";
import { mkEnumSet } from "../jvm/natives/jlang";
import { type NativeSpec, rt, stubs, noops } from "../jvm/runtime";
import { type JAttrSet, obtainStyled, rvInt, rvColor } from "./res";
import type { JBitmap, JCanvas } from "./graphics";

export class JImageView extends JView {
  private dr: JDrawable | null = null;
  get drawable(): JDrawable | null { return this.dr; }
  set drawable(d: JDrawable | null) {
    if (this.dr) this.dr.callback = null;
    this.dr = d;
    if (d) d.callback = this;
  }
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
    if (this.drawable) { this.drawable.tint = f?.tint ?? null; this.drawable.tintMatrix = f?.matrix ?? null; }
    invalidate();
  },
  "clearColorFilter()V": function (this: JImageView) { if (this.drawable) { this.drawable.tint = null; this.drawable.tintMatrix = null; } },
  "getImageTintList()Landroid/content/res/ColorStateList;": function (this: JImageView) { return this.tintCsl; },
  "setImageTintList(Landroid/content/res/ColorStateList;)V": function (this: JImageView, csl: JColorStateList | null) {
    this.tintCsl = csl;
    if (this.drawable && csl) this.drawable.tint = cslColor(csl, this.drawableState());
    invalidate();
  },
  "setImageLevel(I)V": function (this: JImageView, l: number) { if (this.drawable) this.drawable.level = l; },
  ...stubs(null, "getScaleType()Landroid/widget/ImageView$ScaleType;"),
  ...noops("setImageMatrix(Landroid/graphics/Matrix;)V", "setImageURI(Landroid/net/Uri;)V"),
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
