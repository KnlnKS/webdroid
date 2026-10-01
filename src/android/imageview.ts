import { AID } from "./res";
import { JView, initViewFromCtx, requestLayout, invalidate, resolveSize, specMode, MS_EXACTLY, createDrawableState, mergeDrawableStates, isShown } from "./view";
import { type JDrawable, type JColorStateList, loadDrawableRV, loadDrawable, drawableSize, drawAt, adoptDrawable, Adopt, rvCsl } from "./drawable";
import { curThread, vcall, vcallOn, mkEnumSet, construct, after, type JSimpleEnum, enumOrdinal } from "../jvm/natives/jlang";
import { type NativeSpec, rt, noops, driven, type Gen } from "../jvm/runtime";
import { type JAttrSet, obtainStyled, rvInt } from "./res";
import { modeConstant } from "./graphics";
import { identity, isIdentity, javaMatrix, matrixOf, applyMatrix, setAffine, IDENTITY, type Mat } from "./matrix";
import { canvasOf, type JavaCanvas } from "./canvas";

export class JImageView extends JView {
  private dr: JDrawable | null = null;
  get drawable(): JDrawable | null { return this.dr; }
  /** AOSP updateDrawable: the old drawable let go, the new one given the view as its callback, its
   *  state, visibility and level; a caller that goes on to call the view's invalidate() itself
   *  passes `invalidateView` false */
  setDrawable(d: JDrawable | null, invalidateView = true): unknown { return rt.drive(this.setDrawable$(d, invalidateView)); }
  private *setDrawable$(d: JDrawable | null, invalidateView: boolean): Gen {
    const old = this.dr, same = old === d;
    this.dr = d;
    if (invalidateView) invalidate(this);
    yield adoptDrawable(this, old, d, Adopt.ALL);
    if (old && !same && this.attached) yield vcall(old, "setVisible", "(ZZ)Z", 0, 0);
    if (!d) { this.drawableW = this.drawableH = -1; return; }
    if (!same) yield vcall(d, "setVisible", "(ZZ)Z", +(this.attached && isShown(this)), 1);
    yield vcall(d, "setLevel", "(I)Z", this.level);
    this.drawableW = yield drawableSize(d, false);
    this.drawableH = yield drawableSize(d, true);
    yield this.applyTint();
    yield this.applyColorFilter();
    yield this.applyImageAlpha();
  }
  level = 0;
  override drawables(): (JDrawable | null)[] { return [...super.drawables(), this.dr]; }
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
    return after(this.tintCsl ? vcall(d, "setTintList", "(Landroid/content/res/ColorStateList;)V", this.tintCsl) : undefined,
      () => this.tintMode ? vcallOn(thread, d, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", this.tintMode) : undefined);
  }
  colorFilter: unknown = null;
  hasColorFilter = false;
  imageAlpha = 255;
  hasImageAlpha = false;
  applyImageAlpha(): unknown {
    const d = this.dr, thread = curThread;
    if (d && this.hasImageAlpha) return after(vcall(d, "mutate", "()Landroid/graphics/drawable/Drawable;"),
      () => vcallOn(thread, d, "setAlpha", "(I)V", this.imageAlpha));
  }
  applyColorFilter(): unknown {
    const d = this.dr, thread = curThread;
    if (d && this.hasColorFilter) return after(vcall(d, "mutate", "()Landroid/graphics/drawable/Drawable;"),
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
  // android:tint: a tint list over SRC_ATOP, the colour filter it was before Lollipop
  if (ta.vals[3]) {
    view.tintCsl = yield rvCsl(view.jres, ta.vals[3], view.theme);
    view.tintMode = yield modeConstant("android/graphics/PorterDuff$Mode", "SRC_ATOP");
    yield view.applyTint();
  }
});
/** this.invalidate(), which an app's view may override */
const invalidateV = (v: JView): unknown => vcall(v, "invalidate", "()V");
const imageViewMethods: NativeSpec["methods"] = {
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
  "setImageBitmap(Landroid/graphics/Bitmap;)V": function (this: JImageView, b: object | null) {
    const thread = curThread;
    return after(b ? construct("android/graphics/drawable/BitmapDrawable", "(Landroid/content/res/Resources;Landroid/graphics/Bitmap;)V", this.jres?.jobj ?? null, b) : null,
      (d) => vcallOn(thread, this, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d));
  },
  "getDrawable()Landroid/graphics/drawable/Drawable;": function (this: JImageView) { return this.drawable; },
  "getImageAlpha()I": function (this: JImageView) { return this.imageAlpha; },
  "setImageAlpha(I)V": function (this: JImageView, alpha: number) {
    return vcall(this, "setAlpha", "(I)V", alpha);
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
    if (v) return vcall(this, "setScaleType", "(Landroid/widget/ImageView$ScaleType;)V", scaleTypes[3]);
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
    const f = yield construct("android/graphics/PorterDuffColorFilter", "(ILandroid/graphics/PorterDuff$Mode;)V", c, mode);
    return vcall(this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", f);
  }),
  "setColorFilter(Landroid/graphics/ColorFilter;)V": function (this: JImageView, f: unknown) {
    if (this.colorFilter === f) return;
    this.colorFilter = f; this.hasColorFilter = true;
    return after(this.applyColorFilter(), () => invalidateV(this));
  },
  "clearColorFilter()V": function (this: JImageView) { return vcall(this, "setColorFilter", "(Landroid/graphics/ColorFilter;)V", null); },
  "getColorFilter()Landroid/graphics/ColorFilter;": function (this: JImageView) { return this.colorFilter; },
  "getImageTintList()Landroid/content/res/ColorStateList;": function (this: JImageView) { return this.tintCsl; },
  "setImageTintList(Landroid/content/res/ColorStateList;)V": function (this: JImageView, csl: JColorStateList | null) {
    this.tintCsl = csl;
    invalidate(this);
    if (this.drawable) return vcall(this.drawable, "setTintList", "(Landroid/content/res/ColorStateList;)V", csl);
  },
  "getImageTintMode()Landroid/graphics/PorterDuff$Mode;": function (this: JImageView) {
    return this.tintMode ?? modeConstant("android/graphics/PorterDuff$Mode", "SRC_IN");
  },
  "setImageTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JImageView, mode: JSimpleEnum | null) {
    this.tintMode = mode;
    invalidate(this);
    if (this.drawable) return vcall(this.drawable, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", mode);
  },
  "setImageLevel(I)V": function (this: JImageView, l: number) {
    this.level = l;
    if (this.drawable) return vcall(this.drawable, "setLevel", "(I)Z", l);
  },
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
    if (d) return after(vcall(d, "setState", "([I)Z", Int32Array.from(this.drawableState())),
      (changed) => changed ? vcall(this, "invalidateDrawable", "(Landroid/graphics/drawable/Drawable;)V", d) : undefined);
  },
  "getScaleType()Landroid/widget/ImageView$ScaleType;": function (this: JImageView) { return scaleTypes[this.scaleType]; },
  "getImageMatrix()Landroid/graphics/Matrix;": function (this: JImageView) {
    if (!this.drawMatrix()) return construct("android/graphics/Matrix", "()V");
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
      const w = drawableSize(this.drawable, false);
      this.drawableW = w instanceof Promise ? yield w : w;
      const h = drawableSize(this.drawable, true);
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
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JImageView, cv: JavaCanvas): Gen {
    const d = this.drawable;
    if (!d) return;
    const aw = this.width() - this.padL - this.padR, ah = this.height() - this.padT - this.padB;
    if (aw <= 0 || ah <= 0) return;
    if (this.drawableW === 0 || this.drawableH === 0) return;
    const stretch = this.scaleType === 1 || this.drawableW <= 0 || this.drawableH <= 0;
    const dw = stretch ? aw : this.drawableW, dh = stretch ? ah : this.drawableH;
    const matrix = this.drawMatrix();
    const nc = canvasOf(cv), ctx = nc.ctx;
    const saveCount = nc.save();
    try {
      if (this.cropToPadding) nc.clipRect(this.scrollX + this.padL, this.scrollY + this.padT, this.scrollX + this.padL + aw, this.scrollY + this.padT + ah);
      ctx.translate(this.padL, this.padT);
      if (matrix) applyMatrix(ctx, matrix);
      const drawn = drawAt(d, cv, 0, 0, dw, dh);
      if (drawn instanceof Promise) yield drawn;
    } finally { nc.restoreToCount(saveCount); }
  }),
};
rt.register({ name: "android/widget/ImageView", ctor: JImageView, sup: "android/view/View", methods: imageViewMethods });
rt.register({
  name: "android/widget/ImageButton", ctor: class extends JImageView {
    constructor() { super(); this.clickable = true; this.scaleType = 5; }
  }, sup: "android/widget/ImageView", methods: imageViewMethods,
});
