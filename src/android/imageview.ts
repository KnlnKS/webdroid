import { AID } from "./res";
import { JView, initViewFromCtx, requestLayout, invalidate, resolveSize, specMode, MS_EXACTLY, createDrawableState, mergeDrawableStates } from "./view";
import {
  type JDrawable, type JColorStateList, loadDrawableRV, loadDrawable, JBitmapDrawable, drawableSize,
  cslBoundary,
} from "./drawable";
import { curThread, callOn, vcallOn, mkEnumSet, newObj, after, type JSimpleEnum, enumOrdinal } from "../jvm/natives/jlang";
import { type NativeSpec, rt, noops, driven, type Gen } from "../jvm/runtime";
import { type JAttrSet, obtainStyled, rvInt, rvColor } from "./res";
import { restoreCanvasToCount, saveCanvas, modeConstant, identity, isIdentity, javaMatrix, matrixOf, applyMatrix, setAffine, IDENTITY, type Mat, type JBitmap, type JCanvas } from "./graphics";

export class JImageView extends JView {
  private dr: JDrawable | null = null;
  get drawable(): JDrawable | null { return this.dr; }
  /** a caller that goes on to call the view's invalidate() itself passes `invalidateView` false */
  setDrawable(d: JDrawable | null, invalidateView = true) {
    const thread = curThread;
    if (this.dr) this.dr.callback = null;
    this.dr = d;
    if (d) d.callback = this;
    if (invalidateView) invalidate(this);
    return after(d ? vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(this.drawableState())) : 0, () =>
      after(d ? drawableSize(d, false, thread) : -1, w => after(d ? drawableSize(d, true, thread) : -1, h => {
      this.drawableW = w; this.drawableH = h;
      return callOn(thread, () => after(this.applyTint(), () => after(this.applyColorFilter(), () => this.applyImageAlpha())));
    })));
  }
  /** setImageState: extra drawable states, replacing the view's own unless merged */
  imageState: Int32Array | null = null; mergeImageState = false;
  drawableW = -1; drawableH = -1;
  scaleType = 3; // FIT_CENTER
  adjustBounds = false;
  cropToPadding = false;
  imageMatrix = identity();
  /** the Java Matrix over imageMatrix, made on first getImageMatrix */
  jImageMatrix: unknown = null;
  drawMatrix(): Mat | null {
    const dw = this.drawableW, dh = this.drawableH, st = this.scaleType;
    if (!this.drawable || !this.width() || !this.height() || dw <= 0 || dh <= 0 || st === 1) return null;
    const m = this.imageMatrix;
    if (st === 0) return isIdentity(m) ? null : m;
    const aw = this.width() - this.padL - this.padR, ah = this.height() - this.padT - this.padB;
    if (aw === dw && ah === dh) return null;
    let scale = st === 5 ? 1 : st === 6 ? Math.max(aw / dw, ah / dh) : Math.min(aw / dw, ah / dh);
    if (st === 7) scale = Math.min(1, scale);
    const fraction = st === 2 ? 0 : st === 4 ? 1 : 0.5;
    let dx = (aw - dw * scale) * fraction, dy = (ah - dh * scale) * fraction;
    if (st >= 5) { dx = Math.round(dx); dy = Math.round(dy); }
    setAffine(m, scale, 0, 0, scale, dx, dy);
    return m;
  }
  tintCsl: JColorStateList | null = null;
  tintMode: JSimpleEnum | null = null;
  applyTint(): unknown {
    const d = this.dr, thread = curThread;
    if (!d) return;
    return after(this.tintCsl ? vcallOn(thread, d, "setTintList", "(Landroid/content/res/ColorStateList;)V", this.tintCsl) : undefined,
      () => this.tintMode ? vcallOn(thread, d, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", this.tintMode) : undefined);
  }
  colorFilter: unknown = null;
  hasColorFilter = false;
  imageAlpha = 255;
  hasImageAlpha = false;
  applyImageAlpha(): unknown {
    const d = this.dr, thread = curThread;
    if (d && this.hasImageAlpha) return after(vcallOn(thread, d, "mutate", "()Landroid/graphics/drawable/Drawable;"),
      () => vcallOn(thread, d, "setAlpha", "(I)V", this.imageAlpha));
  }
  applyColorFilter(): unknown {
    const d = this.dr, thread = curThread;
    if (d && this.hasColorFilter) return after(vcallOn(thread, d, "mutate", "()Landroid/graphics/drawable/Drawable;"),
      () => vcallOn(thread, d, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", this.colorFilter));
  }
  /** stored for the getters; onMeasure does not apply them (AOSP does, with adjustViewBounds) */
  maxW = Infinity; maxH = Infinity;
}
const scaleTypes = mkEnumSet("android/widget/ImageView$ScaleType", ["MATRIX", "FIT_XY", "FIT_START", "FIT_CENTER", "FIT_END", "CENTER", "CENTER_CROP", "CENTER_INSIDE"]);
const initImageView = driven(function* initImageView(view: JImageView, c: unknown, set: JAttrSet | null, style: number, defaultStyle: number = 0): Gen {
  yield initViewFromCtx(view, c, set, style, defaultStyle);
  if (!view.jres || (!set && !style && !defaultStyle)) return;
  const ta = obtainStyled(view.jres, view.theme, set, [AID("src"), AID("scaleType"), AID("adjustViewBounds"), AID("tint"), AID("cropToPadding")], style, defaultStyle);
  if (ta.vals[0]) yield view.setDrawable(yield loadDrawableRV(view.jres, ta.vals[0], view.theme));
  if (ta.vals[1]) view.scaleType = rvInt(view.jres, ta.vals[1], 3);
  if (ta.vals[2]) view.adjustBounds = !!rvInt(view.jres, ta.vals[2], 0);
  if (ta.vals[4]) view.cropToPadding = !!rvInt(view.jres, ta.vals[4], 0);
  if (ta.vals[3]) {
    const tint = rvColor(view.jres, ta.vals[3], 0);
    if (view.drawable && tint) view.drawable.tint = tint;
  }
});
/** this.invalidate(), which an app's view may override */
const invalidateV = (v: JView): unknown => vcallOn(curThread, v, "invalidate", "()V");
const imageViewMethods: NativeSpec["methods"] = cslBoundary({
  "<init>(Landroid/content/Context;)V": function (this: JImageView, c: unknown) { return initImageView(this, c, null, 0); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JImageView, c: unknown, set: JAttrSet | null) { return initImageView(this, c, set, 0); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: JImageView, c: unknown, set: JAttrSet | null, style: number) { return initImageView(this, c, set, style); },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": function (this: JImageView, c: unknown, set: JAttrSet | null, style: number, defaultStyle: number) { return initImageView(this, c, set, style, defaultStyle); },
  "setImageDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JImageView, d: JDrawable | null) {
    const pending = this.setDrawable(d, false);
    requestLayout(this);
    return after(pending, () => invalidateV(this));
  },
  "setImageResource(I)V": driven(function* (this: JImageView, id: number): Gen {
    yield this.setDrawable(id && this.jres ? yield loadDrawable(this.jres, id, this.theme) : null, false);
    requestLayout(this);
    yield invalidateV(this);
  }),
  "setImageBitmap(Landroid/graphics/Bitmap;)V": function (this: JImageView, b: JBitmap | null) {
    const d = b ? Object.assign(new JBitmapDrawable(), { bmp: b }) : null;
    return vcallOn(curThread, this, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
  },
  "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JImageView) { return this.drawable; },
  "getImageAlpha()I": function (this: JImageView) { return this.imageAlpha; },
  "setImageAlpha(I)V": function (this: JImageView, alpha: number) {
    return vcallOn(curThread, this, "setAlpha", "(I)V", alpha);
  },
  "setAlpha(I)V": function (this: JImageView, alpha: number) {
    alpha &= 255;
    if (this.imageAlpha === alpha) return;
    this.imageAlpha = alpha;
    this.hasImageAlpha = true;
    return after(this.applyImageAlpha(), () => invalidateV(this));
  },
  "setScaleType(Landroid/widget/ImageView$ScaleType;)V": function (this: JImageView, st: { ord: number } | null) {
    if (!st) return rt.npe();
    if (this.scaleType === enumOrdinal(st)) return;
    this.scaleType = enumOrdinal(st); requestLayout(this);
    return invalidateV(this);
  },
  "setAdjustViewBounds(Z)V": function (this: JImageView, v: number) {
    this.adjustBounds = !!v;
    if (v) return vcallOn(curThread, this, "setScaleType", "(Landroid/widget/ImageView$ScaleType;)V", scaleTypes[3]);
  },
  "setMaxWidth(I)V": function (this: JImageView, v: number) { this.maxW = v; requestLayout(this); },
  "setMaxHeight(I)V": function (this: JImageView, v: number) { this.maxH = v; requestLayout(this); },
  "getMaxWidth()I": function (this: JImageView) { return Number.isFinite(this.maxW) ? this.maxW : 0x7fffffff; },
  "getMaxHeight()I": function (this: JImageView) { return Number.isFinite(this.maxH) ? this.maxH : 0x7fffffff; },
  "setColorFilter(I)V": function (this: JImageView, c: number) {
    const thread = curThread;
    return after(modeConstant("android/graphics/PorterDuff$Mode", "SRC_ATOP"),
      (mode) => vcallOn(thread, this, "setColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", c, mode));
  },
  "setColorFilter(ILandroid/graphics/PorterDuff$Mode;)V": driven(function* (this: JImageView, c: number, mode: unknown): Gen {
    const thread = curThread;
    const f = yield newObj("android/graphics/PorterDuffColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", c, mode);
    return vcallOn(thread, this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", f);
  }),
  "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JImageView, f: unknown) {
    if (this.colorFilter === f) return;
    this.colorFilter = f; this.hasColorFilter = true;
    return after(this.applyColorFilter(), () => invalidateV(this));
  },
  "clearColorFilter()V": function (this: JImageView) { return vcallOn(curThread, this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", null); },
  "getColorFilter()Landroid/graphics/ColorFilter;": function (this: JImageView) { return this.colorFilter; },
  "getImageTintList()Landroid/content/res/ColorStateList;": function (this: JImageView) { return this.tintCsl; },
  "setImageTintList(Landroid/content/res/ColorStateList;)V": function (this: JImageView, csl: JColorStateList | null) {
    this.tintCsl = csl;
    invalidate(this);
    if (this.drawable) return vcallOn(curThread, this.drawable, "setTintList", "(Landroid/content/res/ColorStateList;)V", csl);
  },
  "getImageTintMode()Landroid/graphics/PorterDuff$Mode;": function (this: JImageView) {
    return this.tintMode ?? modeConstant("android/graphics/PorterDuff$Mode", "SRC_IN");
  },
  "setImageTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JImageView, mode: JSimpleEnum | null) {
    this.tintMode = mode;
    invalidate(this);
    if (this.drawable) return vcallOn(curThread, this.drawable, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", mode);
  },
  "setImageLevel(I)V": function (this: JImageView, l: number) { if (this.drawable) this.drawable.level = l; },
  "setImageState([IZ)V": function (this: JImageView, state: Int32Array | null, merge: number) {
    this.imageState = state; this.mergeImageState = !!merge;
    if (this.drawable) { const pending = this.refreshDrawableState(); requestLayout(this); return pending; }
  },
  "onCreateDrawableState(I)[I": function (this: JImageView, extra: number) {
    const own = this.imageState;
    if (own && !this.mergeImageState) return own;
    return mergeDrawableStates(createDrawableState(this, extra + (own?.length ?? 0)), own);
  },
  "drawableStateChanged()V": function (this: JImageView) {
    const d = this.drawable;
    if (d) return after(vcallOn(curThread, d, "setState", "([I)Z", Int32Array.from(this.drawableState())),
      (changed) => changed ? vcallOn(curThread, this, "invalidateDrawable", "(Landroid/graphics/drawable/Drawable;)V", d) : undefined);
  },
  "getScaleType()Landroid/widget/ImageView$ScaleType;": function (this: JImageView) { return scaleTypes[this.scaleType]; },
  "getImageMatrix()Landroid/graphics/Matrix;": function (this: JImageView) {
    if (!this.drawMatrix()) return newObj("android/graphics/Matrix", "()V");
    return this.jImageMatrix ?? after(javaMatrix(this.imageMatrix), (m) => (this.jImageMatrix = m));
  },
  "setImageMatrix(Landroid/graphics/Matrix;)V": function (this: JImageView, matrix: object | null) {
    const src = matrix ? matrixOf(matrix) : IDENTITY, dst = this.imageMatrix;
    let changed = false;
    for (let i = 0; i < 9; i++) if (dst[i] !== src[i]) { dst[i] = src[i]; changed = true; }
    if (changed) { this.drawMatrix(); return invalidateV(this); }
  },
  "setCropToPadding(Z)V": function (this: JImageView, crop: number) { this.cropToPadding = !!crop; return invalidateV(this); },
  "getCropToPadding()Z": function (this: JImageView) { return +this.cropToPadding; },
  ...noops("setImageURI(Landroid/net/Uri;)V"),
  "onMeasure(II)V": driven(function* (this: JImageView, wSpec: number, hSpec: number): Gen {
    if (this.drawable) {
      const thread = curThread, w = drawableSize(this.drawable, false, thread);
      this.drawableW = w instanceof Promise ? yield w : w;
      const h = drawableSize(this.drawable, true, thread);
      this.drawableH = h instanceof Promise ? yield h : h;
    }
    const dw = Math.max(0, this.drawableW), dh = Math.max(0, this.drawableH);
    let w = dw + this.padL + this.padR;
    let h = dh + this.padT + this.padB;
    w = Math.max(w, this.minW); h = Math.max(h, this.minH);
    this.measuredW = resolveSize(w, wSpec);
    this.measuredH = resolveSize(h, hSpec);
    if (this.adjustBounds && dw > 0 && dh > 0) {
      if (specMode(wSpec) === MS_EXACTLY && specMode(hSpec) !== MS_EXACTLY) {
        this.measuredH = resolveSize(Math.round((this.measuredW - this.padL - this.padR) * dh / dw) + this.padT + this.padB, hSpec);
      } else if (specMode(hSpec) === MS_EXACTLY && specMode(wSpec) !== MS_EXACTLY) {
        this.measuredW = resolveSize(Math.round((this.measuredH - this.padT - this.padB) * dw / dh) + this.padL + this.padR, wSpec);
      }
    }
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JImageView, cv: JCanvas): Gen {
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
    const saveCount = saveCanvas(cv);
    try {
      if (this.imageAlpha !== 255) ctx.globalAlpha *= this.imageAlpha / 255;
      if (this.cropToPadding) {
        ctx.beginPath(); ctx.rect(this.padL, this.padT, aw, ah); ctx.clip();
      }
      ctx.translate(this.padL, this.padT);
      if (matrix) applyMatrix(ctx, matrix);
      const bounds = vcallOn(thread, d, "setBounds", "(IIII)V", 0, 0, dw, dh);
      if (bounds instanceof Promise) yield bounds;
      const draw = vcallOn(thread, d, "draw", "(Landroid/graphics/Canvas;)V", cv);
      if (draw instanceof Promise) yield draw;
    } finally { restoreCanvasToCount(cv, saveCount); }
  }),
});
rt.register({ name: "android/widget/ImageView", ctor: JImageView, sup: "android/view/View", methods: imageViewMethods });
rt.register({
  name: "android/widget/ImageButton", ctor: class extends JImageView {
    constructor() { super(); this.clickable = true; this.scaleType = 5; }
  }, sup: "android/widget/ImageView", methods: imageViewMethods,
});
