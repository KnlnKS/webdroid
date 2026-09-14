import { AID } from "./res";
import { JView, initViewFromCtx, requestLayout, invalidate, resolveSizeAndState, specMode, MS_EXACTLY } from "./view";
import {
  type JDrawable, type JColorStateList, loadDrawableRV, loadDrawable, JBitmapDrawable, cslColor, drawableSize
} from "./drawable";
import { curThread, vcallOn, mkEnumSet, newObj, after } from "../jvm/natives/jlang";
import { type NativeSpec, rt, noops } from "../jvm/runtime";
import { type JAttrSet, obtainStyled, rvInt, rvColor } from "./res";
import { JMatrix, type JBitmap, type JCanvas } from "./graphics";

export class JImageView extends JView {
  private dr: JDrawable | null = null;
  get drawable(): JDrawable | null { return this.dr; }
  setDrawable(d: JDrawable | null) {
    if (this.dr) this.dr.callback = null;
    this.dr = d;
    this.drawableW = d?.intrinsicW() ?? -1; this.drawableH = d?.intrinsicH() ?? -1;
    if (d) d.callback = this;
    invalidate(this);
    return this.applyColorFilter();
  }
  drawableW = -1; drawableH = -1;
  scaleType = 3; // FIT_CENTER
  adjustBounds = false;
  cropToPadding = false;
  imageMatrix = new JMatrix();
  drawMatrix(): JMatrix | null {
    const dw = this.drawableW, dh = this.drawableH, st = this.scaleType;
    if (!this.drawable || !this.width() || !this.height() || dw <= 0 || dh <= 0 || st === 1) return null;
    const m = this.imageMatrix.m;
    if (st === 0) return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 ? null : this.imageMatrix;
    const aw = this.width() - this.padL - this.padR, ah = this.height() - this.padT - this.padB;
    if (aw === dw && ah === dh) return null;
    let scale = st === 5 ? 1 : st === 6 ? Math.max(aw / dw, ah / dh) : Math.min(aw / dw, ah / dh);
    if (st === 7) scale = Math.min(1, scale);
    const fraction = st === 2 ? 0 : st === 4 ? 1 : 0.5;
    let dx = (aw - dw * scale) * fraction, dy = (ah - dh * scale) * fraction;
    if (st >= 5) { dx = Math.round(dx); dy = Math.round(dy); }
    m[0] = m[3] = scale; m[1] = m[2] = 0; m[4] = dx; m[5] = dy;
    return this.imageMatrix;
  }
  tintCsl: JColorStateList | null = null;
  colorFilter: unknown = null;
  hasColorFilter = false;
  applyColorFilter(): unknown {
    const d = this.dr, thread = curThread;
    if (d && this.hasColorFilter) return after(vcallOn(thread, d, "mutate", "()Landroid/graphics/drawable/Drawable;"),
      () => vcallOn(thread, d, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", this.colorFilter));
  }
  /** AOSP only applies these when adjustViewBounds is on */
  maxW = Infinity; maxH = Infinity;
}
const scaleTypes = mkEnumSet("android/widget/ImageView$ScaleType", ["MATRIX", "FIT_XY", "FIT_START", "FIT_CENTER", "FIT_END", "CENTER", "CENTER_CROP", "CENTER_INSIDE"]);
const imageViewMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JImageView, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    if (set && this.jres) {
      const ta = obtainStyled(this.jres, this.theme, set, [AID("src"), AID("scaleType"), AID("adjustViewBounds"), AID("tint"), AID("cropToPadding")], 0, 0);
      if (ta.vals[0]) await this.setDrawable(await loadDrawableRV(this.jres, ta.vals[0], this.theme));
      if (ta.vals[1]) this.scaleType = rvInt(this.jres, ta.vals[1], 3);
      if (ta.vals[2]) this.adjustBounds = !!rvInt(this.jres, ta.vals[2], 0);
      if (ta.vals[4]) this.cropToPadding = !!rvInt(this.jres, ta.vals[4], 0);
      if (ta.vals[3]) {
        const tint = rvColor(this.jres, ta.vals[3], 0);
        if (this.drawable && tint) this.drawable.tint = tint;
      }
    }
  },
  "setImageDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JImageView, d: JDrawable | null) {
    const pending = this.setDrawable(d);
    this.layoutRequested = true;
    requestLayout(this);
    return pending;
  },
  "setImageResource(I)V": async function (this: JImageView, id: number) {
    await this.setDrawable(id && this.jres ? await loadDrawable(this.jres, id, this.theme) : null);
    this.layoutRequested = true;
    requestLayout(this);
  },
  "setImageBitmap(Landroid/graphics/Bitmap;)V": async function (this: JImageView, b: JBitmap | null) {
    if (b) {
      const d = new JBitmapDrawable();
      d.bmp = b;
      await this.setDrawable(d);
    } else await this.setDrawable(null);
    this.layoutRequested = true;
    requestLayout(this);
  },
  "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JImageView) { return this.drawable; },
  "setScaleType(Landroid/widget/ImageView$ScaleType;)V": function (this: JImageView, st: { ord: number } | null) {
    if (!st) return rt.npe();
    if (this.scaleType === st.ord) return;
    this.scaleType = st.ord; requestLayout(this); invalidate(this);
  },
  "setAdjustViewBounds(Z)V": function (this: JImageView, v: number) { this.adjustBounds = !!v; },
  "setMaxWidth(I)V": function (this: JImageView, v: number) { this.maxW = v; requestLayout(this); },
  "setMaxHeight(I)V": function (this: JImageView, v: number) { this.maxH = v; requestLayout(this); },
  "getMaxWidth()I": function (this: JImageView) { return Number.isFinite(this.maxW) ? this.maxW : 0x7fffffff; },
  "getMaxHeight()I": function (this: JImageView) { return Number.isFinite(this.maxH) ? this.maxH : 0x7fffffff; },
  "setColorFilter(I)V": function (this: JImageView, c: number) {
    return vcallOn(curThread, this, "setColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", c, rt.link("android/graphics/PorterDuff$Mode").ctor.s$SRC_ATOP);
  },
  "setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V": async function (this: JImageView, c: number, mode: unknown) {
    const thread = curThread;
    const f = await newObj("android/graphics/PorterDuffColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", c, mode);
    return vcallOn(thread, this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", f);
  },
  "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JImageView, f: unknown) {
    if (this.colorFilter === f) return;
    this.colorFilter = f; this.hasColorFilter = true;
    invalidate(this);
    return this.applyColorFilter();
  },
  "clearColorFilter()V": function (this: JImageView) { return vcallOn(curThread, this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", null); },
  "getColorFilter()Landroid/graphics/ColorFilter;": function (this: JImageView) { return this.colorFilter; },
  "getImageTintList()Landroid/content/res/ColorStateList;": function (this: JImageView) { return this.tintCsl; },
  "setImageTintList(Landroid/content/res/ColorStateList;)V": function (this: JImageView, csl: JColorStateList | null) {
    this.tintCsl = csl;
    if (this.drawable && csl) this.drawable.tint = cslColor(csl, this.drawableState());
    invalidate(this);
  },
  "setImageLevel(I)V": function (this: JImageView, l: number) { if (this.drawable) this.drawable.level = l; },
  "getScaleType()Landroid/widget/ImageView$ScaleType;": function (this: JImageView) { return scaleTypes[this.scaleType]; },
  "getImageMatrix()Landroid/graphics/Matrix;": function (this: JImageView) { return this.drawMatrix() ?? new JMatrix(); },
  "setImageMatrix(Landroid/graphics/Matrix;)V": function (this: JImageView, matrix: JMatrix | null) {
    const src = matrix?.m ?? [1, 0, 0, 1, 0, 0], dst = this.imageMatrix.m;
    let changed = false;
    for (let i = 0; i < 6; i++) if (dst[i] !== src[i]) { dst[i] = src[i]; changed = true; }
    if (changed) { this.drawMatrix(); invalidate(this); }
  },
  "setCropToPadding(Z)V": function (this: JImageView, crop: number) { this.cropToPadding = !!crop; invalidate(this); },
  "getCropToPadding()Z": function (this: JImageView) { return +this.cropToPadding; },
  ...noops("setImageURI(Landroid/net/Uri;)V"),
  "onMeasure(II)V": async function (this: JImageView, wSpec: number, hSpec: number) {
    if (this.drawable) {
      const thread = curThread, w = drawableSize(this.drawable, false, thread);
      this.drawableW = w instanceof Promise ? await w : w;
      const h = drawableSize(this.drawable, true, thread);
      this.drawableH = h instanceof Promise ? await h : h;
    }
    const dw = Math.max(0, this.drawableW), dh = Math.max(0, this.drawableH);
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
  "onDraw(Landroid/graphics/Canvas;)V": async function (this: JImageView, cv: JCanvas) {
    const d = this.drawable;
    if (!d) return;
    const thread = curThread;
    const aw = this.width() - this.padL - this.padR, ah = this.height() - this.padT - this.padB;
    if (aw <= 0 || ah <= 0) return;
    if (this.drawableW === 0 || this.drawableH === 0) return;
    const stretch = this.scaleType === 1 || this.drawableW <= 0 || this.drawableH <= 0;
    const dw = stretch ? aw : this.drawableW, dh = stretch ? ah : this.drawableH;
    const matrix = this.drawMatrix();
    const ctx = cv.ctx;
    ctx.save();
    try {
      if (this.cropToPadding) {
        ctx.beginPath(); ctx.rect(this.padL, this.padT, aw, ah); ctx.clip();
      }
      ctx.translate(this.padL, this.padT);
      if (matrix) ctx.transform(...matrix.m);
      const bounds = vcallOn(thread, d, "setBounds", "(IIII)V", 0, 0, dw, dh);
      if (bounds instanceof Promise) await bounds;
      const draw = vcallOn(thread, d, "draw", "(Landroid/graphics/Canvas;)V", cv);
      if (draw instanceof Promise) await draw;
    } finally { ctx.restore(); }
  },
};
rt.register({ name: "android/widget/ImageView", ctor: JImageView, sup: "android/view/View", methods: imageViewMethods });
rt.register({
  name: "android/widget/ImageButton", ctor: class extends JImageView {
    constructor() { super(); this.clickable = true; this.scaleType = 5; }
  }, sup: "android/widget/ImageView", methods: imageViewMethods,
});
