import { guestNow } from "../guest-clock";
import { JView, initViewFromCtx, invalidate, requestLayout, resolveSize, copyEvent, JLinearLP, lpAttrs, lpFromAttrs, marginCopy, MATCH_PARENT, WRAP_CONTENT, findById, generateViewId, type JLayoutParams } from "./view";
import { type JDrawable, type JColorStateList, ST, loadDrawableRV, drawChild, drawableSize, JLayerDrawable, rvCsl, cslColor, cslBoundary } from "./drawable";
import { rt, type NativeSpec, callSelf, fieldGetters, flagGetters, fieldSetters, driven, type Gen } from "../jvm/runtime";
import { AID, type JAttrSet, type Resources, rvColor, obtainStyled, rvInt, rvDimen, rvString, resolveStyleValue } from "./res";
import { TV } from "./axml";
import { type JCanvas, type JInsets, JRect, insetsOf, measureText, fontAscent, fontDescent } from "./graphics";
import { JTextView, textViewMethods, textViewCtors, JButton, compoundPadL, compoundPadR, syncCompoundPads } from "./textview";
import { JTextPaint } from "./text";
import { csText } from "../jvm/natives/jchars";
import { G, absGravity } from "./gravity";
import { vcall, vcallOn, curThread, after, type JSimpleEnum } from "../jvm/natives/jlang";
import { type JMotionEvent } from "./motionevent";
import { JLinearLayout, linearMethods } from "./layouts";
import { accelDecel, loadInterpolator } from "./interpolator";
import { mangleMethod } from "../jvm/abi";
import { device } from "../shell/config";

const relayoutSetters = (t: Record<string, string>): NativeSpec["methods"] => Object.fromEntries(Object.entries(t).map(([sig, f]) =>
  [sig, function (this: Record<string, unknown> & JView, v: unknown) { if (this[f] !== v) { this[f] = v; requestLayout(this); } }]));
/** CharSequence setters kept as the text they read */
const textSetters = (t: Record<string, string>): NativeSpec["methods"] => Object.fromEntries(Object.entries(t).map(([sig, f]) =>
  [sig, function (this: Record<string, unknown> & JView, v: unknown) { return after(csText(v), (s) => { if (this[f] !== s) { this[f] = s; requestLayout(this); } }); }]));
const PROGRESS_ID = 0x0102000d, SECONDARY_ID = 0x0102000f;
/** AOSP ProgressBar: determinate progress is its progressDrawable at the progress level; an
 *  indeterminate drawable animates itself when Animatable, else its level cycles. */
class JProgressBar extends JView {
  indeterminate = false;
  interpolator: unknown = null;
  /** indeterminateDuration and indeterminateBehavior (1 repeat, 2 cycle) of the level cycle */
  duration = 4000; behavior = 1;
  /** indeterminateOnly: a spinner style's promise that the bar never shows progress */
  onlyIndeterminate = false;
  progress = 0; secondary = 0;
  max = 100; min = 0;
  minWidth = 24; maxWidth = 48; minHeight = 24; maxHeight = 48;
  progressD: JDrawable | null = null; indetD: JDrawable | null = null;
  tintCsl: JColorStateList | null = null; indetTint: JColorStateList | null = null;
  fraction(v: number) { return this.max === this.min ? 0 : (v - this.min) / (this.max - this.min); }
  clamp(v: number) { return Math.max(this.min, Math.min(this.max, v)); }
  current() { return this.indeterminate ? this.indetD : this.progressD; }
  setIndeterminateDrawable(d: JDrawable | null) {
    if (this.indetD) this.indetD.callback = null;
    this.indetD = d;
    if (d) d.callback = this;
    requestLayout(this); invalidate(this);
  }
}
/** ProgressBar.updateDrawableBounds and drawTrack for the indeterminate drawable: a spinner keeps
 *  its aspect ratio, centred; an Animatable starts on its first draw, anything else is drawn at
 *  the level of a linear AlphaAnimation over the duration */
const drawIndeterminate = driven(function* drawIndeterminate(pb: JProgressBar, cv: JCanvas, d: JDrawable): Gen {
  const thread = curThread, w = pb.width() - pb.padL - pb.padR, h = pb.height() - pb.padT - pb.padB;
  let left = 0, top = 0, right = w, bottom = h;
  if (pb.onlyIndeterminate && !rt.iof(d, "android/graphics/drawable/AnimationDrawable")) {
    const aspect = (yield drawableSize(d, false, thread)) / (yield drawableSize(d, true, thread));
    if (aspect > 0 && aspect !== w / h) {
      if (w / h > aspect) { const width = Math.trunc(h * aspect); left = Math.trunc((w - width) / 2); right = left + width; }
      else { const height = Math.trunc(w / aspect); top = Math.trunc((h - height) / 2); bottom = top + height; }
    }
  }
  yield vcallOn(thread, d, "setBounds", "(IIII)V", left, top, right, bottom);
  if (rt.iof(d, "android/graphics/drawable/Animatable")) {
    if (!(yield vcallOn(thread, d, "isRunning", "()Z"))) yield vcallOn(thread, d, "start", "()V");
  } else {
    const cycles = guestNow() / pb.duration, phase = cycles % 1;
    yield vcallOn(thread, d, "setLevel", "(I)Z", Math.trunc((pb.behavior === 2 && Math.floor(cycles) % 2 ? 1 - phase : phase) * 10000));
    invalidate(pb);
  }
  cv.ctx.save(); cv.ctx.translate(pb.padL, pb.padT);
  try { yield drawChild(d, cv, thread); } finally { cv.ctx.restore(); }
});
/** applyPrimaryProgressTint: the progress layer, or the whole drawable when it has none */
const applyProgressTint = driven(function* applyProgressTint(pb: JProgressBar): Gen {
  const d = pb.progressD;
  if (!d || !pb.tintCsl) return;
  const target = d instanceof JLayerDrawable ? (yield vcall(d, "findDrawableByLayerId", "(I)Landroid/graphics/drawable/Drawable;", PROGRESS_ID)) ?? d : d;
  yield vcall(target, "setTintList", "(Landroid/content/res/ColorStateList;)V", pb.tintCsl);
});
/** ProgressBar.onDraw's drawTrack: the progress and secondary layers at their levels, inside the padding */
const drawTrack = driven(function* drawTrack(pb: JProgressBar, cv: JCanvas, d: JDrawable): Gen {
  const thread = curThread;
  yield vcallOn(thread, d, "setBounds", "(IIII)V", 0, 0, pb.width() - pb.padL - pb.padR, pb.height() - pb.padT - pb.padB);
  for (let primary = 0; primary < 2; primary++) {
    const id = primary ? PROGRESS_ID : SECONDARY_ID, v = primary ? pb.progress : pb.secondary;
    const layer = d instanceof JLayerDrawable ? yield vcallOn(thread, d, "findDrawableByLayerId", "(I)Landroid/graphics/drawable/Drawable;", id) : null;
    yield vcallOn(thread, layer ?? d, "setLevel", "(I)Z", Math.trunc(pb.fraction(v) * 10000));
  }
  cv.ctx.save(); cv.ctx.translate(pb.padL, pb.padT);
  try { yield drawChild(d, cv, thread); } finally { cv.ctx.restore(); }
});
const initProgressBar = driven(function* initProgressBar(this: JProgressBar, c: unknown, set: JAttrSet | null = null, style: number = AID("progressBarStyle"), def: number = 0): Gen {
  yield initViewFromCtx(this, c, set, style, def);
  const res = this.jres;
  if (!res) return;
  const a = obtainStyled(res, this.theme, set, ["progressDrawable", "indeterminateDrawable", "indeterminate", "indeterminateOnly", "min", "max", "progress",
    "secondaryProgress", "minWidth", "maxWidth", "minHeight", "maxHeight", "progressTint", "indeterminateTint", "indeterminateDuration", "indeterminateBehavior"].map(AID), style, def);
  const g = (i: number) => a.vals[i], px = (i: number, v: number) => g(i) ? Math.trunc(rvDimen(res, g(i), v)) : v;
  if (g(0)) this.progressD = yield loadDrawableRV(res, g(0)!, this.theme);
  if (g(1)) this.setIndeterminateDrawable(yield loadDrawableRV(res, g(1)!, this.theme));
  this.duration = rvInt(res, g(14), this.duration) || this.duration;
  this.behavior = rvInt(res, g(15), this.behavior);
  this.minWidth = px(8, this.minWidth); this.maxWidth = px(9, this.maxWidth); this.minHeight = px(10, this.minHeight); this.maxHeight = px(11, this.maxHeight);
  this.min = rvInt(res, g(4), 0); this.max = Math.max(this.min, rvInt(res, g(5), 100));
  this.progress = this.clamp(rvInt(res, g(6), 0)); this.secondary = this.clamp(rvInt(res, g(7), 0));
  this.onlyIndeterminate = !!rvInt(res, g(3), 0);
  this.indeterminate = this.onlyIndeterminate || !!rvInt(res, g(2), 0);
  if (g(12)) this.tintCsl = yield rvCsl(res, g(12)!, this.theme);
  if (g(13)) this.indetTint = yield rvCsl(res, g(13)!, this.theme);
  yield applyProgressTint(this);
  if (this.indetD && this.indetTint) yield vcall(this.indetD, "setTintList", "(Landroid/content/res/ColorStateList;)V", this.indetTint);
});
function setProgressValue(this: JProgressBar, p: number) {
  if (this.indeterminate || this.clamp(p) === this.progress) return;
  this.progress = this.clamp(p); invalidate(this);
}
rt.register({
  name: "android/widget/ProgressBar", ctor: JProgressBar, sup: "android/view/View",
  methods: cslBoundary({
    "<init>(Landroid/content/Context;)V": initProgressBar,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initProgressBar,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": initProgressBar,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": initProgressBar,
    "setProgress(I)V": setProgressValue,
    "setProgress(IZ)V": setProgressValue,
    "getProgress()I": function (this: JProgressBar) { return this.indeterminate ? 0 : this.progress; },
    "setSecondaryProgress(I)V": function (this: JProgressBar, p: number) { if (!this.indeterminate) { this.secondary = this.clamp(p); invalidate(this); } },
    "getSecondaryProgress()I": function (this: JProgressBar) { return this.indeterminate ? 0 : this.secondary; },
    "setMax(I)V": function (this: JProgressBar, m: number) { this.max = Math.max(this.min, m); this.progress = this.clamp(this.progress); invalidate(this); },
    "setMin(I)V": function (this: JProgressBar, m: number) { this.min = Math.min(this.max, m); this.progress = this.clamp(this.progress); invalidate(this); },
    "incrementProgressBy(I)V": function (this: JProgressBar, d: number) { return vcall(this, "setProgress", "(I)V", this.progress + d); },
    "setIndeterminate(Z)V": function (this: JProgressBar, on: number) {
      if ((!this.onlyIndeterminate || !this.indeterminate) && !!on !== this.indeterminate) { this.indeterminate = !!on; invalidate(this); }
    },
    "setProgressDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JProgressBar, d: JDrawable | null) {
      this.progressD = d; requestLayout(this); invalidate(this);
      return applyProgressTint(this);
    },
    "setIndeterminateDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JProgressBar, d: JDrawable | null) { this.setIndeterminateDrawable(d); },
    "setProgressTintList(Landroid/content/res/ColorStateList;)V": function (this: JProgressBar, c: JColorStateList | null) { this.tintCsl = c; invalidate(this); return applyProgressTint(this); },
    "setIndeterminateTintList(Landroid/content/res/ColorStateList;)V": function (this: JProgressBar, c: JColorStateList | null) {
      this.indetTint = c; invalidate(this);
      if (this.indetD) return vcall(this.indetD, "setTintList", "(Landroid/content/res/ColorStateList;)V", c);
    },
    ...flagGetters({ "isIndeterminate()Z": "indeterminate" }),
    ...fieldGetters({ "getMax()I": "max", "getMin()I": "min",
      "getProgressDrawable()Landroid/graphics/drawable/Drawable;": "progressD",
      "getIndeterminateDrawable()Landroid/graphics/drawable/Drawable;": "indetD",
      "getProgressTintList()Landroid/content/res/ColorStateList;": "tintCsl",
      "getIndeterminateTintList()Landroid/content/res/ColorStateList;": "indetTint",
      "getMinWidth()I": "minWidth", "getMaxWidth()I": "maxWidth", "getMinHeight()I": "minHeight", "getMaxHeight()I": "maxHeight" }),
    ...relayoutSetters({ "setMinWidth(I)V": "minWidth", "setMaxWidth(I)V": "maxWidth", "setMinHeight(I)V": "minHeight", "setMaxHeight(I)V": "maxHeight" }),
    "setInterpolator(Landroid/view/animation/Interpolator;)V": function (this: JProgressBar, i: unknown) { this.interpolator = i; },
    "getInterpolator()Landroid/view/animation/Interpolator;": function (this: JProgressBar) { return this.interpolator; },
    "setInterpolator(Landroid/content/Context;I)V": function (this: JProgressBar, c: { $host: { res: Resources } }, id: number) {
      return vcall(this, "setInterpolator", "(Landroid/view/animation/Interpolator;)V", loadInterpolator(c.$host.res, id));
    },
    "onMeasure(II)V": driven(function* (this: JProgressBar, wSpec: number, hSpec: number): Gen {
      const d = this.current();
      let dw = 0, dh = 0;
      if (d) {
        dw = Math.max(this.minWidth, Math.min(this.maxWidth, yield drawableSize(d, false)));
        dh = Math.max(this.minHeight, Math.min(this.maxHeight, yield drawableSize(d, true)));
      }
      this.measuredW = resolveSize(dw + this.padL + this.padR, wSpec);
      this.measuredH = resolveSize(dh + this.padT + this.padB, hSpec);
    }),
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JProgressBar, cv: JCanvas) {
      const d = this.current();
      return !d ? undefined : this.indeterminate ? drawIndeterminate(this, cv, d) : drawTrack(this, cv, d);
    },
  }),
});
class JAbsSeekBar extends JProgressBar { keyProgressIncrement = 5; }
const seekBarMethods: NativeSpec["methods"] = {
  "setKeyProgressIncrement(I)V": function (this: JAbsSeekBar, increment: number) { this.keyProgressIncrement = increment < 0 ? (-increment | 0) : increment; },
  "getKeyProgressIncrement()I": function (this: JAbsSeekBar) { return this.keyProgressIncrement; },
  "setThumb(Landroid/graphics/drawable/Drawable;)V": () => {},
};
rt.register({ name: "android/widget/AbsSeekBar", ctor: JAbsSeekBar, sup: "android/widget/ProgressBar", methods: seekBarMethods });
/** RatingBar reports progress in steps; its star drawable is not implemented. */
class JRatingBar extends JAbsSeekBar { stars = 5; step = 0.5; ratingL: unknown = null; }
class JSeekBar extends JAbsSeekBar {
  thumb: JDrawable | null = null;
  thumbW = 0; thumbH = 0; thumbOffset = 0;
  changeListener: unknown = null;
  setTrack(d: JDrawable | null, thread = curThread): unknown { return rt.drive(this.setTrack$(d, thread)); }
  *setTrack$(d: JDrawable | null, thread = curThread): Gen {
    if (this.progressD) this.progressD.callback = null;
    this.progressD = d;
    if (d) { d.callback = this; yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(this.drawableState())); }
    requestLayout(this); invalidate(this);
  }
  setThumb(d: JDrawable | null, thread = curThread): unknown { return rt.drive(this.setThumb$(d, thread)); }
  *setThumb$(d: JDrawable | null, thread = curThread): Gen {
    if (this.thumb) this.thumb.callback = null;
    this.thumb = d;
    this.thumbW = d ? Math.max(0, Number(yield drawableSize(d, false, thread))) : 0;
    this.thumbH = d ? Math.max(0, Number(yield drawableSize(d, true, thread))) : 0;
    this.thumbOffset = Math.trunc(this.thumbW / 2);
    if (d) { d.callback = this; yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(this.drawableState())); }
    requestLayout(this); invalidate(this);
  }
  updateProgress(value: number, fromUser = false, thread = curThread): unknown { return rt.drive(this.updateProgress$(value, fromUser, thread)); }
  *updateProgress$(value: number, fromUser = false, thread = curThread): Gen {
    const progress = this.clamp(Math.round(value));
    if (this.progress === progress) return;
    this.progress = progress; invalidate(this);
    if (this.changeListener) yield vcallOn(thread, this.changeListener, "onProgressChanged", "(Landroid/widget/SeekBar;IZ)V", this, progress, +fromUser);
  }
}
const initSeekBar = driven(function* initSeekBar(this: JSeekBar, c: unknown, attrs: JAttrSet | null = null, style: number = AID("seekBarStyle"), def: number = 0): Gen {
  const thread = curThread;
  yield initViewFromCtx(this, c, attrs, style);
  if (!this.jres) return;
  const a = obtainStyled(this.jres, this.theme, attrs, ["progressDrawable", "thumb", "thumbOffset", "min", "max", "progress", "secondaryProgress"].map(AID), style, def);
  this.min = rvInt(this.jres, a.vals[3], 0); this.max = Math.max(this.min, rvInt(this.jres, a.vals[4], 100));
  this.progress = this.clamp(rvInt(this.jres, a.vals[5], 0));
  this.secondary = rvInt(this.jres, a.vals[6], 0);
  if (a.vals[0]) yield this.setTrack(yield loadDrawableRV(this.jres, a.vals[0], this.theme), thread);
  if (a.vals[1]) yield this.setThumb(yield loadDrawableRV(this.jres, a.vals[1], this.theme), thread);
  if (a.vals[2]) this.thumbOffset = Math.trunc(rvDimen(this.jres, a.vals[2], this.thumbOffset));
});
const seekProgress = function (this: JSeekBar, value: number) { return this.updateProgress(value); };
rt.register({ name: "android/widget/SeekBar", ctor: JSeekBar, sup: "android/widget/AbsSeekBar", methods: {
  "<init>(Landroid/content/Context;)V": initSeekBar,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initSeekBar,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": initSeekBar,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": initSeekBar,
  "setThumb(Landroid/graphics/drawable/Drawable;)V": function (this: JSeekBar, d: JDrawable | null) { return this.setThumb(d); },
  "setProgressDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JSeekBar, d: JDrawable | null) { return this.setTrack(d); },
  "getThumb()Landroid/graphics/drawable/Drawable;": function (this: JSeekBar) { return this.thumb; },
  "getThumbOffset()I": function (this: JSeekBar) { return this.thumbOffset; },
  "setThumbOffset(I)V": function (this: JSeekBar, offset: number) { this.thumbOffset = offset; invalidate(this); },
  "setOnSeekBarChangeListener(Landroid/widget/SeekBar$OnSeekBarChangeListener;)V": function (this: JSeekBar, listener: unknown) { this.changeListener = listener; },
  "setProgress(I)V": seekProgress,
  "setProgress(IZ)V": seekProgress,
  "drawableStateChanged()V": driven(function* (this: JSeekBar): Gen {
    const thread = curThread, state = Int32Array.from(this.drawableState());
    for (const d of [this.progressD, this.thumb]) if (d) yield vcallOn(thread, d, "setState", "([I)Z", state);
  }),
  "onMeasure(II)V": driven(function* (this: JSeekBar, ws: number, hs: number): Gen {
    const thread = curThread, d = this.progressD;
    const w = d ? Math.max(0, Number(yield drawableSize(d, false, thread))) : 0;
    const h = d ? Math.max(0, Number(yield drawableSize(d, true, thread))) : 0;
    this.measuredW = resolveSize(Math.max(this.minW, w + this.padL + this.padR), ws);
    this.measuredH = resolveSize(Math.max(this.minH, Math.max(h, this.thumbH) + this.padT + this.padB), hs);
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JSeekBar, canvas: JCanvas): Gen {
    const thread = curThread, ctx = canvas.ctx;
    if (this.progressD) yield drawTrack(this, canvas, this.progressD);
    if (!this.thumb) return;
    const w = this.width() - this.padL - this.padR, h = this.height() - this.padT - this.padB;
    const x = Math.round(this.fraction(this.progress) * (w - this.thumbW + this.thumbOffset * 2)) - this.thumbOffset;
    const y = Math.trunc((h - this.thumbH) / 2);
    yield vcallOn(thread, this.thumb, "setBounds", "(IIII)V", x, y, x + this.thumbW, y + this.thumbH);
    ctx.save(); ctx.translate(this.padL, this.padT);
    try { yield drawChild(this.thumb, canvas, thread); } finally { ctx.restore(); }
  }),
  "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JSeekBar, event: JMotionEvent): Gen {
    if (!this.enabled) return 0;
    const thread = curThread, action = event.action & 255;
    if (action === 0) {
      yield vcallOn(thread, this, "setPressed", "(Z)V", 1);
      if (this.parent) yield vcallOn(thread, this.parent, "requestDisallowInterceptTouchEvent", "(Z)V", 1);
      if (this.changeListener) yield vcallOn(thread, this.changeListener, "onStartTrackingTouch", "(Landroid/widget/SeekBar;)V", this);
    }
    if (action === 0 || action === 1 || action === 2) {
      const width = this.width() - this.padL - this.padR;
      yield this.updateProgress(this.min + (this.max - this.min) * Math.max(0, Math.min(1, width > 0 ? (event.x - this.padL) / width : 0)), true, thread);
    }
    if (action === 1 || action === 3) {
      yield vcallOn(thread, this, "setPressed", "(Z)V", 0);
      if (this.changeListener) yield vcallOn(thread, this.changeListener, "onStopTrackingTouch", "(Landroid/widget/SeekBar;)V", this);
    }
    return 1;
  }),
} });
rt.markers("android/widget/SeekBar$OnSeekBarChangeListener", "android/widget/RatingBar$OnRatingBarChangeListener");
rt.register({
  name: "android/widget/RatingBar", ctor: JRatingBar, sup: "android/widget/AbsSeekBar",
  methods: cslBoundary({
    "setNumStars(I)V": function (this: JRatingBar, n: number) { this.stars = n; this.max = Math.round(n / this.step); },
    "setStepSize(F)V": function (this: JRatingBar, s: number) { this.step = s || 1; this.max = Math.round(this.stars / this.step); },
    "setRating(F)V": function (this: JRatingBar, r: number) { this.progress = Math.round(r / this.step); invalidate(); },
    "getRating()F": function (this: JRatingBar) { return Math.fround(this.progress * this.step); },
    "setIsIndicator(Z)V": () => {},
    "isIndicator()Z": () => 1,
    ...fieldGetters({ "getNumStars()I": "stars", "getStepSize()F": "step",
      "getOnRatingBarChangeListener()Landroid/widget/RatingBar$OnRatingBarChangeListener;": "ratingL" }),
    ...fieldSetters({ "setOnRatingBarChangeListener(Landroid/widget/RatingBar$OnRatingBarChangeListener;)V": "ratingL" }),
  }),
});

export function themeAccent(v: JView): number {
  const rv = v.theme?.lookup(AID("colorAccent")) ?? v.theme?.lookup(AID("colorPrimary"));
  return rv && v.jres ? rvColor(v.jres, rv, -10011977) : -10011977;
}

/** a drawable a view owns: callback wired, handed the view's current state */
const adopt = driven(function* adopt(v: JView, old: JDrawable | null, d: JDrawable | null): Gen {
  if (old && old !== d) old.callback = null;
  if (!d) return;
  d.callback = v;
  const thread = curThread;
  if (yield vcallOn(thread, d, "isStateful", "()Z")) yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(v.drawableState()));
});
const drawableRes = (v: JView, id: number) => id ? vcall(v.ctx, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;", id) : null;
/** AOSP applies an explicit tint list to a mutated copy and re-states it */
const applyTint = driven(function* applyTint(v: JView, d: JDrawable | null, tint: JColorStateList | null, hasTint: boolean, mode: JSimpleEnum | null): Gen {
  if (!d || (!hasTint && !mode)) return;
  const thread = curThread;
  if (hasTint) yield vcallOn(thread, d, "setTintList", "(Landroid/content/res/ColorStateList;)V", tint);
  if (mode) yield vcallOn(thread, d, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", mode);
  if (yield vcallOn(thread, d, "isStateful", "()Z")) yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(v.drawableState()));
  invalidate(v);
});
/** CompoundButton and CheckedTextView place their indicator by the text's vertical gravity */
const indicatorTop = (v: JTextView, h: number) => {
  const g = v.gravityT & 0x70;
  return g === G.BOTTOM ? v.height() - h : g === G.CENTER_V ? Math.trunc((v.height() - h) / 2) : 0;
};

// ── CompoundButton / CheckBox / RadioButton / Switch / ToggleButton
class JCompoundButton extends JButton {
  checked = false;
  checkL: unknown = null;
  broadcasting = false;
  buttonD: JDrawable | null = null;
  /** the button's intrinsic width: the text starts after it */
  buttonW = 0;
  buttonTint: JColorStateList | null = null;
  buttonTintMode: JSimpleEnum | null = null;
  hasButtonTint = false;
  setButton(d: JDrawable | null): unknown { return rt.drive(this.setButton$(d)); }
  *setButton$(d: JDrawable | null): Gen {
    if (d === this.buttonD) return;
    const thread = curThread;
    yield adopt(this, this.buttonD, d);
    this.buttonD = d;
    this.buttonW = d ? Math.max(0, yield drawableSize(d, false, thread)) : 0;
    // AOSP sizes the view to its button: setMinHeight(getIntrinsicHeight())
    if (d) yield vcallOn(thread, this, "setMinHeight", "(I)V", yield drawableSize(d, true, thread));
    yield this.applyButtonTint();
    requestLayout(this);
  }
  applyButtonTint(): unknown { return applyTint(this, this.buttonD, this.buttonTint, this.hasButtonTint, this.buttonTintMode); }
  setChecked(c: boolean): unknown { return rt.drive(this.setChecked$(c)); }
  *setChecked$(c: boolean): Gen {
    if (this.checked === c) return;
    this.checked = c;
    yield this.refreshDrawableState();
    if (this.broadcasting) return;
    this.broadcasting = true;
    try {
      if (this.checkL) yield vcall(this.checkL, "onCheckedChanged", "(Landroid/widget/CompoundButton;Z)V", this, +c);
      // RadioGroup's widget listener, which it installs on its RadioButton children
      if (this.parent instanceof JRadioGroup && rt.iof(this, "android/widget/RadioButton")) yield this.parent.childChecked(this);
    } finally { this.broadcasting = false; }
  }
  baseState(): number[] {
    const st = super.baseState();
    if (this.checked) st.push(ST.checked);
    return st;
  }
}
/** CompoundButton's constructor over TextView's: the widget's own style names the button, its
 *  tint and the initial check. `then` reads what a subclass adds under the same style. */
function compoundCtors<T extends JCompoundButton>(styleAttr: string, then?: (v: T, set: JAttrSet | null, dsa: number, dsr: number) => unknown): NativeSpec["methods"] {
  return textViewCtors<T>(styleAttr, driven(function* initCompound(v: T, set: JAttrSet | null, dsa: number, dsr: number): Gen {
    const res = v.jres;
    if (!res) return;
    const a = obtainStyled(res, v.theme, set, [AID("button"), AID("buttonTint"), AID("checked")], dsa, dsr);
    if (a.vals[0]) yield v.setButton(yield loadDrawableRV(res, a.vals[0], v.theme));
    if (a.vals[1]) { v.buttonTint = yield rvCsl(res, a.vals[1], v.theme); v.hasButtonTint = true; }
    if (a.vals[2]) yield vcall(v, "setChecked", "(Z)V", rvInt(res, a.vals[2], 0));
    yield v.applyButtonTint();
    yield then?.(v, set, dsa, dsr);
  }));
}
function compoundPadLeft(this: JCompoundButton) { return compoundPadL.call(this) + this.buttonW; }
syncCompoundPads.add(compoundPadLeft);
const compoundOnDraw = driven(function* compoundOnDraw(this: JCompoundButton, cv: JCanvas): Gen {
  const d = this.buttonD, thread = curThread;
  if (d) {
    const h = yield drawableSize(d, true, thread), top = indicatorTop(this, h);
    yield vcallOn(thread, d, "setBounds", "(IIII)V", 0, top, this.buttonW, top + h);
  }
  yield callSelf(textViewMethods, "onDraw(Landroid/graphics/Canvas;)V", this, cv);
  if (!d) return;
  // drawn at the view's origin however far its content scrolled
  const sx = this.scrollX, sy = this.scrollY;
  if (sx || sy) cv.ctx.translate(sx, sy);
  try { yield drawChild(d, cv, thread); } finally { if (sx || sy) cv.ctx.translate(-sx, -sy); }
});
const compoundMethods: NativeSpec["methods"] = cslBoundary({
  ...textViewMethods,
  ...compoundCtors(""),
  "setChecked(Z)V": function (this: JCompoundButton, c: number) { return this.setChecked(!!c); },
  "toggle()V": function (this: JCompoundButton) { return vcall(this, "setChecked", "(Z)V", +!this.checked); },
  "performClick()Z": driven(function* (this: JCompoundButton): Gen {
    yield vcall(this, "toggle", "()V");
    if (!this.clickL) return 0;
    yield vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
    return 1;
  }),
  ...flagGetters({ "isChecked()Z": "checked" }),
  ...fieldSetters({ "setOnCheckedChangeListener(Landroid/widget/CompoundButton$OnCheckedChangeListener;)V": "checkL" }),
  ...fieldGetters({ "getButtonDrawable()Landroid/graphics/drawable/Drawable;": "buttonD",
    "getButtonTintList()Landroid/content/res/ColorStateList;": "buttonTint",
    "getButtonTintMode()Landroid/graphics/PorterDuff$Mode;": "buttonTintMode" }),
  "setButtonTintList(Landroid/content/res/ColorStateList;)V": function (this: JCompoundButton, tint: JColorStateList | null) {
    this.buttonTint = tint; this.hasButtonTint = true; return this.applyButtonTint();
  },
  "setButtonTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JCompoundButton, mode: JSimpleEnum | null) {
    this.buttonTintMode = mode; return this.applyButtonTint();
  },
  "setButtonDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JCompoundButton, d: JDrawable | null) { return this.setButton(d); },
  "setButtonDrawable(I)V": function (this: JCompoundButton, id: number) {
    return after(drawableRes(this, id), (d) => vcall(this, "setButtonDrawable", "(Landroid/graphics/drawable/Drawable;)V", d));
  },
  "drawableStateChanged()V": driven(function* (this: JCompoundButton): Gen {
    yield callSelf(textViewMethods, "drawableStateChanged()V", this);
    const d = this.buttonD, thread = curThread;
    if (d && (yield vcallOn(thread, d, "isStateful", "()Z")) && (yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(this.drawableState())))) invalidate(this);
  }),
  "getCompoundPaddingLeft()I": compoundPadLeft,
  "onDraw(Landroid/graphics/Canvas;)V": compoundOnDraw,
});
rt.register({ name: "android/widget/CompoundButton", ctor: JCompoundButton, sup: "android/widget/Button", ifaces: ["android/widget/Checkable"], methods: compoundMethods });
rt.markers("android/widget/CompoundButton$OnCheckedChangeListener");
rt.register({ name: "android/widget/CheckBox", ctor: class extends JCompoundButton {}, sup: "android/widget/CompoundButton", methods: {
  ...compoundMethods, ...compoundCtors("checkboxStyle"),
} });
rt.register({ name: "android/widget/RadioButton", ctor: class extends JCompoundButton {}, sup: "android/widget/CompoundButton", methods: {
  ...compoundMethods, ...compoundCtors("radioButtonStyle"),
  // a radio button is unchecked only by its group
  "toggle()V": function (this: JCompoundButton) { if (!this.checked) return callSelf(compoundMethods, "toggle()V", this); },
} });

class JToggleButton extends JCompoundButton { textOn: unknown = null; textOff: unknown = null; }
/** ToggleButton.syncTextState: the label follows the checked state when one is given */
const syncToggleText = (v: JToggleButton) => {
  const text = v.checked ? v.textOn : v.textOff;
  return text != null ? vcall(v, "setText", "(Ljava/lang/CharSequence;)V", text) : undefined;
};
rt.register({ name: "android/widget/ToggleButton", ctor: JToggleButton, sup: "android/widget/CompoundButton", methods: {
  ...compoundMethods,
  ...compoundCtors<JToggleButton>("buttonStyleToggle", (v, set, dsa, dsr) => {
    const a = obtainStyled(v.jres!, v.theme, set, [AID("textOn"), AID("textOff")], dsa, dsr);
    if (a.vals[0]) v.textOn = rvString(v.jres!, v.jres!.resolveRefs(a.vals[0]));
    if (a.vals[1]) v.textOff = rvString(v.jres!, v.jres!.resolveRefs(a.vals[1]));
    return syncToggleText(v);
  }),
  "setChecked(Z)V": function (this: JToggleButton, c: number) { return after(this.setChecked(!!c), () => syncToggleText(this)); },
  ...fieldGetters({ "getTextOn()Ljava/lang/CharSequence;": "textOn", "getTextOff()Ljava/lang/CharSequence;": "textOff" }),
  ...fieldSetters({ "setTextOn(Ljava/lang/CharSequence;)V": "textOn", "setTextOff(Ljava/lang/CharSequence;)V": "textOff" }),
} });

// ── Switch: a thumb sliding along a track at the end of the text
class JSwitch extends JCompoundButton {
  thumb: JDrawable | null = null; track: JDrawable | null = null;
  thumbTint: JColorStateList | null = null; trackTint: JColorStateList | null = null;
  thumbTintMode: JSimpleEnum | null = null; trackTintMode: JSimpleEnum | null = null;
  hasThumbTint = false; hasTrackTint = false;
  textOn = ""; textOff = "";
  showText = true; splitTrack = false;
  thumbTextPadding = 0; switchMinWidth = 0; switchPadding = 0;
  switchPaint: JTextPaint | null = null;
  /** 0 off .. 1 on; while `animStart` is set it runs from `animFrom` to the checked edge */
  thumbPos = 0;
  animFrom = 0; animStart = -1;
  /** onTouchEvent's mode (0 idle, 1 down on the thumb, 2 dragging), and the drag's last x */
  touchMode = 0; touchX = 0; touchY = 0;
  /** the x velocity of the last move, px/s */
  velocity = 0; lastX = 0; lastT = 0;
  switchW = 0; switchH = 0; thumbW = 0;
  switchL = 0; switchT = 0; switchR = 0; switchB = 0;
  readonly pad = new JRect();
  thumbOffset(range: number) { return Math.trunc(this.thumbPos * range + 0.5); }
  /** Switch.getThumbScrollRange */
  thumbRange(insets: JInsets) { return this.track ? this.switchW - this.thumbW - this.pad.left - this.pad.right - insets.left - insets.right : 0; }
  /** setChecked's ObjectAnimator on THUMB_POS: 250 ms, AccelerateDecelerate */
  animateThumb(): boolean {
    if (this.animStart < 0) return false;
    const t = Math.min(1, (guestNow() - this.animStart) / 250), to = this.checked ? 1 : 0;
    this.thumbPos = this.animFrom + (to - this.animFrom) * accelDecel(t);
    if (t >= 1) this.animStart = -1;
    return true;
  }
  /** the track's padding into `pad`, and the thumb's optical insets */
  *insets$(thread = curThread): Gen<JInsets> {
    if (this.track) yield vcallOn(thread, this.track, "getPadding", "(Landroid/graphics/Rect;)Z", this.pad);
    else this.pad.left = this.pad.top = this.pad.right = this.pad.bottom = 0;
    return this.thumb ? yield vcallOn(thread, this.thumb, "getOpticalInsets", "()Landroid/graphics/Insets;") : NO_INSETS;
  }
  switchText(on: boolean): string { return on ? this.textOn : this.textOff; }
}
const NO_INSETS = insetsOf(0, 0, 0, 0);
const M_onTouchEvent = mangleMethod("onTouchEvent", "(Landroid/view/MotionEvent;)Z");
/** View.onTouchEvent, which a widget's own override defers to */
const viewTouch = (v: JView, ev: JMotionEvent) => (rt.link("android/view/View").ctor.prototype[M_onTouchEvent] as (e: JMotionEvent) => unknown).call(v, ev);
function switchPadRight(this: JSwitch) { return compoundPadR.call(this) + this.switchW + (this.text ? this.switchPadding : 0); }
syncCompoundPads.add(switchPadRight);
const setSwitchDrawable = (which: "thumb" | "track") => driven(function* (this: JSwitch, d: JDrawable | null): Gen {
  yield adopt(this, this[which], d);
  this[which] = d;
  yield applySwitchTints(this);
  requestLayout(this);
});
const applySwitchTints = driven(function* applySwitchTints(v: JSwitch): Gen {
  yield applyTint(v, v.thumb, v.thumbTint, v.hasThumbTint, v.thumbTintMode);
  yield applyTint(v, v.track, v.trackTint, v.hasTrackTint, v.trackTintMode);
});
const setSwitchTextAppearance = driven(function* setSwitchTextAppearance(v: JSwitch, id: number): Gen {
  const res = v.jres;
  if (!res || !id) return;
  const p = v.switchPaint ??= new JTextPaint();
  p.textSize = v.paintT.textSize; p.tf = v.paintT.tf;
  const size = res.styleLookup(id, AID("textSize")), color = res.styleLookup(id, AID("textColor"));
  if (size) p.textSize = rvDimen(res, size, p.textSize);
  if (color) p.setColorValue(cslColor(yield rvCsl(res, resolveStyleValue(res, v.theme, color)!, v.theme), v.drawableState()));
  requestLayout(v);
});
rt.register({ name: "android/widget/Switch", ctor: JSwitch, sup: "android/widget/CompoundButton", methods: cslBoundary({
  ...compoundMethods,
  ...compoundCtors<JSwitch>("switchStyle", driven(function* (v: JSwitch, set: JAttrSet | null, dsa: number, dsr: number): Gen {
    const res = v.jres!;
    const a = obtainStyled(res, v.theme, set, ["thumb", "track", "textOn", "textOff", "thumbTextPadding", "switchMinWidth",
      "switchPadding", "splitTrack", "showText", "thumbTint", "trackTint", "switchTextAppearance"].map(AID), dsa, dsr);
    const g = (i: number) => a.vals[i];
    if (g(0)) v.thumb = yield loadDrawableRV(res, g(0)!, v.theme);
    if (g(1)) v.track = yield loadDrawableRV(res, g(1)!, v.theme);
    yield adopt(v, null, v.thumb); yield adopt(v, null, v.track);
    if (g(2)) v.textOn = rvString(res, res.resolveRefs(g(2)!)) ?? "";
    if (g(3)) v.textOff = rvString(res, res.resolveRefs(g(3)!)) ?? "";
    v.thumbTextPadding = Math.trunc(rvDimen(res, g(4), 0));
    v.switchMinWidth = Math.trunc(rvDimen(res, g(5), 0));
    v.switchPadding = Math.trunc(rvDimen(res, g(6), 0));
    v.splitTrack = !!rvInt(res, g(7), 0);
    v.showText = !!rvInt(res, g(8), 1);
    if (g(9)) { v.thumbTint = yield rvCsl(res, g(9)!, v.theme); v.hasThumbTint = true; }
    if (g(10)) { v.trackTint = yield rvCsl(res, g(10)!, v.theme); v.hasTrackTint = true; }
    yield applySwitchTints(v);
    if (g(11)?.t === TV.REFERENCE) yield setSwitchTextAppearance(v, g(11)!.d);
    v.thumbPos = v.checked ? 1 : 0;
  })),
  "setChecked(Z)V": function (this: JSwitch, c: number) {
    const from = this.thumbPos;
    return after(this.setChecked(!!c), () => {
      // a laid-out switch slides its thumb, as AOSP's does while attached
      if (this.width() > 0 && from !== (this.checked ? 1 : 0)) { this.animFrom = from; this.animStart = guestNow(); }
      else { this.thumbPos = this.checked ? 1 : 0; this.animStart = -1; }
      invalidate(this);
    });
  },
  // AOSP Switch.onTouchEvent: a press on the thumb that moves past the slop drags it; letting go
  // flings by velocity or settles on the nearer side, and the base view sees a cancel instead
  "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JSwitch, ev: JMotionEvent): Gen {
    const thread = curThread, action = ev.action & 255, slop = device.touchSlop;
    if (action === 0 || action === 2) {
      if (action === 2 && ev.eventTime > this.lastT) this.velocity = (ev.x - this.lastX) * 1000 / (ev.eventTime - this.lastT);
      this.lastX = ev.x; this.lastT = ev.eventTime;
    }
    if (action === 0) {
      const insets: JInsets = yield* this.insets$(thread);
      const left = this.switchL + this.thumbOffset(this.thumbRange(insets)) - slop, right = left + this.thumbW + this.pad.left + this.pad.right + slop;
      if (this.enabled && this.thumb && ev.x > left && ev.x < right && ev.y > this.switchT - slop && ev.y < this.switchB + slop) {
        this.touchMode = 1; this.touchX = ev.x; this.touchY = ev.y; this.velocity = 0;
      }
    } else if (action === 2 && this.touchMode === 1) {
      if (Math.abs(ev.x - this.touchX) > slop || Math.abs(ev.y - this.touchY) > slop) {
        this.touchMode = 2; this.animStart = -1;
        if (this.parent) yield vcallOn(thread, this.parent, "requestDisallowInterceptTouchEvent", "(Z)V", 1);
        this.touchX = ev.x; this.touchY = ev.y;
        return 1;
      }
    } else if (action === 2 && this.touchMode === 2) {
      const range = this.thumbRange(yield* this.insets$(thread)), d = range ? (ev.x - this.touchX) / range : ev.x > this.touchX ? 1 : -1;
      const pos = Math.max(0, Math.min(1, this.thumbPos + d));
      if (pos !== this.thumbPos) { this.touchX = ev.x; this.thumbPos = pos; invalidate(this); }
      return 1;
    } else if (action === 1 || action === 3) {
      if (this.touchMode === 2) {
        this.touchMode = 0;
        const on = action === 1 && this.enabled ? (Math.abs(this.velocity) > device.dp(50) ? this.velocity > 0 : this.thumbPos > 0.5) : this.checked;
        yield vcallOn(thread, this, "setChecked", "(Z)V", +on);
        const cancel = copyEvent(ev); cancel.action = 3;
        yield viewTouch(this, cancel);
        return 1;
      }
      this.touchMode = 0;
    }
    return viewTouch(this, ev);
  }),
  "getCompoundPaddingRight()I": switchPadRight,
  ...fieldGetters({ "getTextOn()Ljava/lang/CharSequence;": "textOn", "getTextOff()Ljava/lang/CharSequence;": "textOff",
    "getThumbDrawable()Landroid/graphics/drawable/Drawable;": "thumb", "getTrackDrawable()Landroid/graphics/drawable/Drawable;": "track",
    "getThumbTintList()Landroid/content/res/ColorStateList;": "thumbTint", "getTrackTintList()Landroid/content/res/ColorStateList;": "trackTint",
    "getThumbTintMode()Landroid/graphics/PorterDuff$Mode;": "thumbTintMode", "getTrackTintMode()Landroid/graphics/PorterDuff$Mode;": "trackTintMode",
    "getThumbTextPadding()I": "thumbTextPadding", "getSwitchMinWidth()I": "switchMinWidth", "getSwitchPadding()I": "switchPadding" }),
  ...flagGetters({ "getShowText()Z": "showText", "getSplitTrack()Z": "splitTrack" }),
  ...textSetters({ "setTextOn(Ljava/lang/CharSequence;)V": "textOn", "setTextOff(Ljava/lang/CharSequence;)V": "textOff" }),
  ...relayoutSetters({
    "setThumbTextPadding(I)V": "thumbTextPadding", "setSwitchMinWidth(I)V": "switchMinWidth", "setSwitchPadding(I)V": "switchPadding" }),
  "setShowText(Z)V": function (this: JSwitch, on: number) { if (this.showText !== !!on) { this.showText = !!on; requestLayout(this); } },
  "setSplitTrack(Z)V": function (this: JSwitch, on: number) { this.splitTrack = !!on; invalidate(this); },
  "setThumbDrawable(Landroid/graphics/drawable/Drawable;)V": setSwitchDrawable("thumb"),
  "setTrackDrawable(Landroid/graphics/drawable/Drawable;)V": setSwitchDrawable("track"),
  "setThumbResource(I)V": function (this: JSwitch, id: number) { return after(drawableRes(this, id), (d) => vcall(this, "setThumbDrawable", "(Landroid/graphics/drawable/Drawable;)V", d)); },
  "setTrackResource(I)V": function (this: JSwitch, id: number) { return after(drawableRes(this, id), (d) => vcall(this, "setTrackDrawable", "(Landroid/graphics/drawable/Drawable;)V", d)); },
  "setThumbTintList(Landroid/content/res/ColorStateList;)V": function (this: JSwitch, t: JColorStateList | null) { this.thumbTint = t; this.hasThumbTint = true; return applySwitchTints(this); },
  "setTrackTintList(Landroid/content/res/ColorStateList;)V": function (this: JSwitch, t: JColorStateList | null) { this.trackTint = t; this.hasTrackTint = true; return applySwitchTints(this); },
  "setThumbTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JSwitch, m: JSimpleEnum | null) { this.thumbTintMode = m; return applySwitchTints(this); },
  "setTrackTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JSwitch, m: JSimpleEnum | null) { this.trackTintMode = m; return applySwitchTints(this); },
  "setSwitchTextAppearance(Landroid/content/Context;I)V": function (this: JSwitch, _c: unknown, id: number) { return setSwitchTextAppearance(this, id); },
  "setSwitchTypeface(Landroid/graphics/Typeface;)V": function (this: JSwitch, tf: object | null) {
    (this.switchPaint ??= Object.assign(new JTextPaint(), { textSize: this.paintT.textSize })).tf = tf; requestLayout(this);
  },
  "setSwitchTypeface(Landroid/graphics/Typeface;I)V": function (this: JSwitch, tf: object | null) {
    return vcall(this, "setSwitchTypeface", "(Landroid/graphics/Typeface;)V", tf);
  },
  "drawableStateChanged()V": driven(function* (this: JSwitch): Gen {
    yield callSelf(compoundMethods, "drawableStateChanged()V", this);
    const thread = curThread, state = Int32Array.from(this.drawableState());
    for (const d of [this.thumb, this.track]) if (d) yield vcallOn(thread, d, "setState", "([I)Z", state);
    invalidate(this);
  }),
  "onMeasure(II)V": driven(function* (this: JSwitch, wSpec: number, hSpec: number): Gen {
    const thread = curThread, pad = this.pad, thumb = this.thumb;
    let thumbW = 0, thumbH = 0;
    if (thumb) {
      yield vcallOn(thread, thumb, "getPadding", "(Landroid/graphics/Rect;)Z", pad);
      thumbW = (yield drawableSize(thumb, false, thread)) - pad.left - pad.right;
      thumbH = yield drawableSize(thumb, true, thread);
    }
    const paint = this.switchPaint ?? this.paintT;
    const textW = this.showText ? Math.ceil(Math.max(measureText(paint, this.switchText(true)), measureText(paint, this.switchText(false)))) + this.thumbTextPadding * 2 : 0;
    this.thumbW = Math.max(textW, thumbW);
    const insets: JInsets = yield* this.insets$(thread);
    const trackH = this.track ? yield drawableSize(this.track, true, thread) : 0;
    this.switchW = Math.max(this.switchMinWidth, 2 * this.thumbW + Math.max(pad.left, insets.left) + Math.max(pad.right, insets.right));
    this.switchH = Math.max(trackH, thumbH);
    yield callSelf(textViewMethods, "onMeasure(II)V", this, wSpec, hSpec);
    if (this.measuredH < this.switchH) this.measuredH = this.switchH;
  }),
  "onLayout(ZIIII)V": driven(function* (this: JSwitch): Gen {
    const insets: JInsets = yield* this.insets$();
    const inL = Math.max(0, insets.left - this.pad.left), inR = Math.max(0, insets.right - this.pad.right);
    this.switchR = this.width() - this.padR - inR;
    this.switchL = this.switchR - this.switchW + inL + inR;
    const g = this.gravityT & 0x70;
    this.switchT = g === G.CENTER_V ? Math.trunc((this.padT + this.height() - this.padB) / 2) - Math.trunc(this.switchH / 2)
      : g === G.BOTTOM ? this.height() - this.padB - this.switchH : this.padT;
    this.switchB = this.switchT + this.switchH;
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JSwitch, cv: JCanvas): Gen {
    const thread = curThread, pad = this.pad, { thumb, track } = this;
    if (this.animateThumb()) invalidate(this);
    // AOSP Switch.draw: the track spans the switch, the thumb sits along the scroll range
    const insets: JInsets = yield* this.insets$(thread);
    let thumbLeft = this.switchL + this.thumbOffset(this.thumbRange(insets));
    if (track) {
      thumbLeft += pad.left;
      yield vcallOn(thread, track, "setBounds", "(IIII)V",
        this.switchL + Math.max(0, insets.left - pad.left), this.switchT + Math.max(0, insets.top - pad.top),
        this.switchR - Math.max(0, insets.right - pad.right), this.switchB - Math.max(0, insets.bottom - pad.bottom));
    }
    if (thumb) {
      yield vcallOn(thread, thumb, "getPadding", "(Landroid/graphics/Rect;)Z", pad);
      yield vcallOn(thread, thumb, "setBounds", "(IIII)V", thumbLeft - pad.left, this.switchT, thumbLeft + this.thumbW + pad.right, this.switchB);
    }
    yield compoundOnDraw.call(this, cv);
    if (track) yield drawChild(track, cv, thread);
    if (thumb) yield drawChild(thumb, cv, thread);
    const text = this.showText ? this.switchText(this.checked) : "";
    if (!text) return;
    const paint = this.switchPaint ?? this.paintT, b = thumb?.bounds;
    const cx = b ? (b.left + b.right) / 2 : this.width() / 2;
    const cy = (this.switchT + (track ? pad.top : 0) + this.switchB - (track ? pad.bottom : 0)) / 2;
    yield vcallOn(thread, cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", text,
      cx - measureText(paint, text) / 2, cy - (fontAscent(paint) + fontDescent(paint)) / 2, paint);
  }),
}) });
class JRadioGroup extends JLinearLayout {
  checkL: unknown = null;
  checkedId = -1;
  /** mProtectFromCheckedChange: the group's own check changes do not re-enter its listener */
  protect = false;
  constructor() { super(); this.orientation = 1; }
  /** setCheckedStateForView: the id is found anywhere below the group */
  *setViewChecked$(id: number, c: boolean): Gen {
    const v = findById(this, id);
    if (!(v instanceof JCompoundButton) || !rt.iof(v, "android/widget/RadioButton")) return;
    this.protect = true;
    try { yield vcall(v, "setChecked", "(Z)V", +c); } finally { this.protect = false; }
  }
  *setCheckedId$(id: number): Gen {
    this.checkedId = id;
    if (this.checkL) yield vcall(this.checkL, "onCheckedChanged", "(Landroid/widget/RadioGroup;I)V", this, id);
  }
  check(id: number): unknown { return rt.drive(this.check$(id)); }
  *check$(id: number): Gen {
    if (id !== -1 && id === this.checkedId) return;
    if (this.checkedId !== -1) yield* this.setViewChecked$(this.checkedId, false);
    if (id !== -1) yield* this.setViewChecked$(id, true);
    yield* this.setCheckedId$(id);
  }
  /** the CheckedStateTracker every RadioButton child reports to */
  childChecked(child: JView): unknown { return rt.drive(this.childChecked$(child)); }
  *childChecked$(child: JView): Gen {
    if (this.protect) return;
    if (this.checkedId !== -1) yield* this.setViewChecked$(this.checkedId, false);
    yield* this.setCheckedId$(child.idNum);
  }
}
class JRadioLP extends JLinearLP {}
rt.register({
  name: "android/widget/RadioGroup", ctor: JRadioGroup, sup: "android/widget/LinearLayout",
  methods: {
    ...linearMethods,
    "generateDefaultLayoutParams()Landroid/view/ViewGroup$LayoutParams;": () => Object.assign(new JRadioLP(), { width: MATCH_PARENT, height: WRAP_CONTENT }),
    "generateLayoutParams(Landroid/util/AttributeSet;)Landroid/view/ViewGroup$LayoutParams;": function (this: JRadioGroup, attrs: JAttrSet) { return lpFromAttrs(new JRadioLP(), this.jres!, attrs); },
    "generateLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Landroid/view/ViewGroup$LayoutParams;": (source: JLayoutParams) => { const lp = new JRadioLP(); marginCopy.call(lp, source); return lp; },
    "checkLayoutParams(Landroid/view/ViewGroup$LayoutParams;)Z": (lp: unknown) => +(lp instanceof JRadioLP),
    // AOSP addView and PassThroughHierarchyChangeListener: a RadioButton child gets an id, and
    // one arriving checked becomes the group's selection
    "onViewAdded(Landroid/view/View;)V": driven(function* (this: JRadioGroup, child: JView): Gen {
      if (!(child instanceof JCompoundButton) || !rt.iof(child, "android/widget/RadioButton")) return;
      if (child.idNum === -1) child.idNum = generateViewId();
      if (!child.checked) return;
      if (this.checkedId !== -1) yield* this.setViewChecked$(this.checkedId, false);
      yield* this.setCheckedId$(child.idNum);
    }),
    ...fieldSetters({ "setOnCheckedChangeListener(Landroid/widget/RadioGroup$OnCheckedChangeListener;)V": "checkL" }),
    ...fieldGetters({ "getCheckedRadioButtonId()I": "checkedId" }),
    "check(I)V": function (this: JRadioGroup, id: number) { return this.check(id); },
    "clearCheck()V": function (this: JRadioGroup) { return this.check(-1); },
  },
});
rt.register({
  name: "android/widget/RadioGroup$LayoutParams", ctor: JRadioLP, sup: "android/widget/LinearLayout$LayoutParams",
  methods: {
    "<init>(II)V": function (this: JLinearLP, width: number, height: number) { this.width = width; this.height = height; },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": lpAttrs,
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": marginCopy,
    "<init>(Landroid/view/ViewGroup$MarginLayoutParams;)V": marginCopy,
  },
});
rt.markers("android/widget/RadioGroup$OnCheckedChangeListener");

const initSpace = driven(function* initSpace(this: JView, context: unknown, attrs: JAttrSet | null = null, defStyle: number = 0): Gen {
  yield initViewFromCtx(this, context, attrs, defStyle);
  if (this.visibility === 0) this.visibility = 4;
});
rt.register({
  name: "android/widget/Space", ctor: class extends JView {}, sup: "android/view/View",
  methods: {
    "<init>(Landroid/content/Context;)V": initSpace,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initSpace,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": initSpace,
    "onMeasure(II)V": driven(function* (this: JView, wSpec: number, hSpec: number): Gen {
      this.measuredW = resolveSize(yield vcall(this, "getSuggestedMinimumWidth", "()I"), wSpec) & 0xffffff;
      this.measuredH = resolveSize(yield vcall(this, "getSuggestedMinimumHeight", "()I"), hSpec) & 0xffffff;
    }),
    "draw(Landroid/graphics/Canvas;)V": () => {},
  },
});

// ── CheckedTextView: a TextView with a check mark on one side, inside that side's padding
class JCheckedTextView extends JTextView {
  checked = false;
  checkMark: JDrawable | null = null;
  checkMarkW = 0;
  /** mBasePadding: the padding on the check mark's side before the mark's width is added */
  basePad = 0;
  checkMarkGravity = G.END;
  checkMarkTint: JColorStateList | null = null;
  checkMarkTintMode: JSimpleEnum | null = null;
  hasCheckMarkTint = false;
  baseState(): number[] {
    const st = super.baseState();
    if (this.checked) st.push(ST.checked);
    return st;
  }
  atStart(): boolean { return (absGravity(this.checkMarkGravity, 0) & 7) === G.LEFT; }
  updatePadding() {
    const p = this.basePad + (this.checkMark ? this.checkMarkW : 0);
    if (this.atStart() ? this.padL === p : this.padR === p) return;
    if (this.atStart()) this.padL = p; else this.padR = p;
    requestLayout(this);
  }
  applyTint(): unknown { return applyTint(this, this.checkMark, this.checkMarkTint, this.hasCheckMarkTint, this.checkMarkTintMode); }
  setCheckMark(d: JDrawable | null): unknown { return rt.drive(this.setCheckMark$(d)); }
  *setCheckMark$(d: JDrawable | null): Gen {
    const thread = curThread;
    if (this.checkMark && this.checkMark !== d) this.checkMark.callback = null;
    this.checkMark = d;
    this.checkMarkW = 0;
    if (d) {
      d.callback = this;
      // AOSP records the mark's size in its checked state
      yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.of(ST.checked));
      yield vcallOn(thread, this, "setMinHeight", "(I)V", yield drawableSize(d, true, thread));
      this.checkMarkW = Math.max(0, yield drawableSize(d, false, thread));
      yield vcallOn(thread, d, "setState", "([I)Z", Int32Array.from(this.drawableState()));
    }
    yield this.applyTint();
    this.updatePadding();
  }
}
const initCheckedText = driven(function* initCheckedText(v: JCheckedTextView, set: JAttrSet | null, dsa: number, dsr: number): Gen {
  const res = v.jres;
  if (!res) return;
  const a = obtainStyled(res, v.theme, set, ["checked", "checkMark", "checkMarkTint", "checkMarkGravity"].map(AID), dsa, dsr);
  if (a.vals[3]) v.checkMarkGravity = rvInt(res, a.vals[3], v.checkMarkGravity);
  v.basePad = v.atStart() ? v.padL : v.padR;
  if (a.vals[2]) { v.checkMarkTint = yield rvCsl(res, a.vals[2], v.theme); v.hasCheckMarkTint = true; }
  if (a.vals[1]) yield v.setCheckMark(yield loadDrawableRV(res, a.vals[1], v.theme));
  if (a.vals[0]) yield vcall(v, "setChecked", "(Z)V", rvInt(res, a.vals[0], 0));
});
/** View.setPadding on a CheckedTextView: the mark's side keeps the mark's width on top */
function setCheckedTextPadding(this: JCheckedTextView, l: number, t: number, r: number, b: number) {
  this.padT = t; this.padB = b;
  if (this.atStart()) { this.basePad = l; this.padR = r; } else { this.basePad = r; this.padL = l; }
  requestLayout(this);
  this.updatePadding();
}
rt.register({
  name: "android/widget/CheckedTextView", ctor: JCheckedTextView, sup: "android/widget/TextView",
  ifaces: ["android/widget/Checkable"],
  methods: cslBoundary({
    ...textViewMethods,
    ...textViewCtors<JCheckedTextView>("checkedTextViewStyle", initCheckedText),
    "setChecked(Z)V": function (this: JCheckedTextView, v: number) {
      if (this.checked === !!v) return;
      this.checked = !!v;
      return this.refreshDrawableState();
    },
    ...flagGetters({ "isChecked()Z": "checked" }),
    "toggle()V": function (this: JCheckedTextView) { return vcall(this, "setChecked", "(Z)V", +!this.checked); },
    "setCheckMarkDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JCheckedTextView, d: JDrawable | null) { return this.setCheckMark(d); },
    "setCheckMarkDrawable(I)V": function (this: JCheckedTextView, id: number) {
      return after(drawableRes(this, id), (d) => vcall(this, "setCheckMarkDrawable", "(Landroid/graphics/drawable/Drawable;)V", d));
    },
    ...fieldGetters({ "getCheckMarkDrawable()Landroid/graphics/drawable/Drawable;": "checkMark",
      "getCheckMarkTintList()Landroid/content/res/ColorStateList;": "checkMarkTint",
      "getCheckMarkTintMode()Landroid/graphics/PorterDuff$Mode;": "checkMarkTintMode" }),
    "setCheckMarkTintList(Landroid/content/res/ColorStateList;)V": function (this: JCheckedTextView, t: JColorStateList | null) {
      this.checkMarkTint = t; this.hasCheckMarkTint = true; return this.applyTint();
    },
    "setCheckMarkTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JCheckedTextView, m: JSimpleEnum | null) { this.checkMarkTintMode = m; return this.applyTint(); },
    "setPadding(IIII)V": setCheckedTextPadding,
    "setPaddingRelative(IIII)V": setCheckedTextPadding,
    "drawableStateChanged()V": driven(function* (this: JCheckedTextView): Gen {
      yield callSelf(textViewMethods, "drawableStateChanged()V", this);
      if (this.checkMark && (yield vcall(this.checkMark, "setState", "([I)Z", Int32Array.from(this.drawableState())))) invalidate(this);
    }),
    "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JCheckedTextView, cv: JCanvas): Gen {
      yield callSelf(textViewMethods, "onDraw(Landroid/graphics/Canvas;)V", this, cv);
      const d = this.checkMark, thread = curThread;
      if (!d) return;
      const h = yield drawableSize(d, true, thread), top = indicatorTop(this, h);
      const left = this.atStart() ? this.basePad : this.width() - this.basePad - this.checkMarkW;
      yield vcallOn(thread, d, "setBounds", "(IIII)V", this.scrollX + left, top, this.scrollX + left + this.checkMarkW, top + h);
      yield drawChild(d, cv, thread);
    }),
  }),
});
