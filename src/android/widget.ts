import { AID } from "./res";
import { guestNow } from "../guest-clock";
import { JView, initViewFromCtx, invalidate, requestLayout, resolveSize, uiState, JLinearLP, lpAttrs, lpFromAttrs, marginCopy, MATCH_PARENT, WRAP_CONTENT, findById, generateViewId, type JLayoutParams } from "./view";
import { type JDrawable, type JColorStateList, ST, loadDrawableRV, drawChild, drawableSize, JLayerDrawable, rvCsl, cslColor } from "./drawable";
import { rt, type NativeSpec, stubs, noops, callSelf, fieldGetters, flagGetters, fieldSetters, flagSetters, driven, type Gen } from "../jvm/runtime";
import { type JAttrSet, rvColor, obtainStyled, rvInt, rvDimen, rvString, resolveStyleValue } from "./res";
import { TV } from "./axml";
import { type JCanvas, type JInsets, JRect, JTypeface, cssColor, insetsOf, measureText, fontAscent, fontDescent, tfDefault } from "./graphics";
import { JTextView, textViewMethods, JButton, applyTvStyle, compoundPadL, compoundPadR, syncCompoundPads } from "./textview";
import { JTextPaint, spannedString } from "./text";
import { G, absGravity } from "./gravity";
import { vcall, vcallOn, curThread, after, type JSimpleEnum } from "../jvm/natives/jlang";
import { type JMotionEvent } from "./motionevent";
import { JLinearLayout, linearMethods } from "./layouts";

class JProgressBar extends JView {
  indeterminate = true;
  progress = 0;
  max = 100; min = 0;
  horizontal = false;
  progressD: JDrawable | null = null; indetD: JDrawable | null = null;
  tintCsl: JColorStateList | null = null;
}
const initProgressBar = driven(function* initProgressBar(this: JProgressBar, c: unknown, set: JAttrSet | null = null, style: number = AID("progressBarStyle"), def: number = 0): Gen {
  yield initViewFromCtx(this, c, set, style);
  if (!this.jres) return;
  if (set?.node) for (const attr of set.node.attrs) {
    if (attr.name === "style" && attr.str?.includes("Horizontal")) this.horizontal = true;
    if (!attr.ns && attr.name === "style" && attr.type === TV.REFERENCE && this.jres.idName(attr.data)?.includes("Horizontal")) this.horizontal = true;
  }
  const a = obtainStyled(this.jres, this.theme, set,
    ["progressDrawable", "indeterminateDrawable", "indeterminate", "min", "max", "progress"].map(AID), style, def);
  if (a.vals[0]) this.progressD = yield loadDrawableRV(this.jres, a.vals[0], this.theme);
  if (a.vals[1]) this.indetD = yield loadDrawableRV(this.jres, a.vals[1], this.theme);
  this.indeterminate = !!rvInt(this.jres, a.vals[2], this.horizontal ? 0 : +this.indeterminate);
  this.min = rvInt(this.jres, a.vals[3], this.min);
  this.max = Math.max(this.min, rvInt(this.jres, a.vals[4], this.max));
  this.progress = Math.max(this.min, Math.min(this.max, rvInt(this.jres, a.vals[5], this.progress)));
});
rt.register({
  name: "android/widget/ProgressBar", ctor: JProgressBar, sup: "android/view/View",
  methods: {
    "<init>(Landroid/content/Context;)V": initProgressBar,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initProgressBar,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": initProgressBar,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": initProgressBar,
    "setProgress(I)V": function (this: JProgressBar, p: number) { this.progress = p; invalidate(); },
    "setMax(I)V": function (this: JProgressBar, m: number) { this.max = Math.max(1, m); },
    "setProgressDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JProgressBar, d: JDrawable | null) { this.progressD = d; invalidate(); },
    "setIndeterminateDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JProgressBar, d: JDrawable | null) { this.indetD = d; invalidate(); },
    "setProgressTintList(Landroid/content/res/ColorStateList;)V": function (this: JProgressBar, c: JColorStateList | null) { this.tintCsl = c; invalidate(); },
    "setIndeterminateTintList(Landroid/content/res/ColorStateList;)V": function (this: JProgressBar, c: JColorStateList | null) { this.tintCsl = c; invalidate(); },
    "setProgress(IZ)V": function (this: JProgressBar, p: number) { this.progress = p; invalidate(); },
    ...flagSetters({ "setIndeterminate(Z)V": "indeterminate" }),
    ...flagGetters({ "isIndeterminate()Z": "indeterminate" }),
    ...fieldGetters({ "getProgress()I": "progress", "getMax()I": "max",
      "getProgressDrawable()Landroid/graphics/drawable/Drawable;": "progressD",
      "getIndeterminateDrawable()Landroid/graphics/drawable/Drawable;": "indetD",
      "getProgressTintList()Landroid/content/res/ColorStateList;": "tintCsl",
      "getIndeterminateTintList()Landroid/content/res/ColorStateList;": "tintCsl", "getMin()I": "min" }),
    ...fieldSetters({ "setMin(I)V": "min" }),
    ...noops("setSecondaryProgress(I)V", "setInterpolator(Landroid/view/animation/Interpolator;)V",
      "setInterpolator(Landroid/content/Context;I)V"),
    ...stubs(0, "getSecondaryProgress()I"),
    ...stubs(null, "getInterpolator()Landroid/view/animation/Interpolator;"),
    "onMeasure(II)V": function (this: JProgressBar, wSpec: number, hSpec: number) {
      const dw = this.horizontal ? 48 : 96, dh = this.horizontal ? 16 : 96;
      this.measuredW = resolveSize(Math.max(dw + this.padL + this.padR, this.minW), wSpec);
      this.measuredH = resolveSize(Math.max(dh + this.padT + this.padB, this.minH), hSpec);
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
          const t = (guestNow() % 1200) / 1200;
          const w = (this.width() - this.padL - this.padR);
          ctx.fillRect(this.padL + t * w * 1.5 - w / 2, y - 4, w / 2, 8);
          uiState.needsDraw = true;
        } else {
          ctx.fillRect(this.padL, y - 4, (this.width() - this.padL - this.padR) * this.progress / this.max, 8);
        }
      } else {
        const cx = this.width() / 2, cy = this.height() / 2;
        const r = Math.min(this.width() - this.padL - this.padR, this.height() - this.padT - this.padB) / 2 - 6;
        const t = guestNow() / 900;
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
  secondary = 0;
  changeListener: unknown = null;
  constructor() { super(); this.horizontal = true; this.indeterminate = false; }
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
    const progress = Math.max(this.min, Math.min(this.max, Math.round(value)));
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
  this.progress = Math.max(this.min, Math.min(this.max, rvInt(this.jres, a.vals[5], 0)));
  this.secondary = rvInt(this.jres, a.vals[6], 0);
  if (a.vals[0]) yield this.setTrack(yield loadDrawableRV(this.jres, a.vals[0], this.theme), thread);
  if (a.vals[1]) yield this.setThumb(yield loadDrawableRV(this.jres, a.vals[1], this.theme), thread);
  if (a.vals[2]) this.thumbOffset = Math.trunc(rvDimen(this.jres, a.vals[2], this.thumbOffset));
});
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
  "setProgress(I)V": function (this: JSeekBar, value: number) { return this.updateProgress(value); },
  "setProgress(IZ)V": function (this: JSeekBar, value: number) { return this.updateProgress(value); },
  "setSecondaryProgress(I)V": function (this: JSeekBar, value: number) { this.secondary = Math.max(this.min, Math.min(this.max, value)); invalidate(this); },
  "getSecondaryProgress()I": function (this: JSeekBar) { return this.secondary; },
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
    const thread = curThread, ctx = canvas.ctx, d = this.progressD;
    const w = this.width() - this.padL - this.padR, h = this.height() - this.padT - this.padB;
    const fraction = (v: number) => this.max === this.min ? 0 : (v - this.min) / (this.max - this.min);
    ctx.save(); ctx.translate(this.padL, this.padT);
    try {
      if (d) {
        yield vcallOn(thread, d, "setBounds", "(IIII)V", 0, 0, w, h);
        const level = async (id: number, value: number) => {
          const target = d instanceof JLayerDrawable ? await vcallOn(thread, d, "findDrawableByLayerId", "(I)Landroid/graphics/drawable/Drawable;", id) : d;
          if (target) await vcallOn(thread, target, "setLevel", "(I)Z", Math.trunc(fraction(value) * 10000));
        };
        yield level(0x0102000f, this.secondary); yield level(0x0102000d, this.progress);
        yield drawChild(d, canvas);
      }
      if (this.thumb) {
        const x = Math.round(fraction(this.progress) * (w - this.thumbW + this.thumbOffset * 2)) - this.thumbOffset;
        const y = Math.trunc((h - this.thumbH) / 2);
        yield vcallOn(thread, this.thumb, "setBounds", "(IIII)V", x, y, x + this.thumbW, y + this.thumbH);
        yield drawChild(this.thumb, canvas);
      }
    } finally { ctx.restore(); }
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
  methods: {
    "setNumStars(I)V": function (this: JRatingBar, n: number) { this.stars = n; this.max = Math.round(n / this.step); },
    "setStepSize(F)V": function (this: JRatingBar, s: number) { this.step = s || 1; this.max = Math.round(this.stars / this.step); },
    "setRating(F)V": function (this: JRatingBar, r: number) { this.progress = Math.round(r / this.step); invalidate(); },
    "getRating()F": function (this: JRatingBar) { return Math.fround(this.progress * this.step); },
    "setIsIndicator(Z)V": () => {},
    "isIndicator()Z": () => 1,
    ...fieldGetters({ "getNumStars()I": "stars", "getStepSize()F": "step",
      "getOnRatingBarChangeListener()Landroid/widget/RatingBar$OnRatingBarChangeListener;": "ratingL" }),
    ...fieldSetters({ "setOnRatingBarChangeListener(Landroid/widget/RatingBar$OnRatingBarChangeListener;)V": "ratingL" }),
  },
});

export function themeAccent(v: JView): number {
  const rv = v.theme?.lookup(AID("colorAccent")) ?? v.theme?.lookup(AID("colorPrimary"));
  return rv && v.jres ? rvColor(v.jres, rv, -10011977) : -10011977;
}

const relayoutSetters = (t: Record<string, string>): NativeSpec["methods"] => Object.fromEntries(Object.entries(t).map(([sig, f]) =>
  [sig, function (this: Record<string, unknown> & JView, v: unknown) { if (this[f] !== v) { this[f] = v; requestLayout(this); } }]));
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
  const init = driven(function* initCompound(v: T, c: unknown, set: JAttrSet | null, dsa: number, dsr: number): Gen {
    yield initViewFromCtx(v, c, set, dsa, dsr);
    yield applyTvStyle(v, set, dsa, dsr);
    const res = v.jres;
    if (!res) return;
    const a = obtainStyled(res, v.theme, set, [AID("button"), AID("buttonTint"), AID("checked")], dsa, dsr);
    if (a.vals[0]) yield v.setButton(yield loadDrawableRV(res, a.vals[0], v.theme));
    if (a.vals[1]) { v.buttonTint = yield rvCsl(res, a.vals[1], v.theme); v.hasButtonTint = true; }
    if (a.vals[2]) yield vcall(v, "setChecked", "(Z)V", rvInt(res, a.vals[2], 0));
    yield v.applyButtonTint();
    yield then?.(v, set, dsa, dsr);
  });
  const style = () => styleAttr ? AID(styleAttr) : 0;
  return {
    "<init>(Landroid/content/Context;)V": function (this: T, c: unknown) { return init(this, c, null, style(), 0); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: T, c: unknown, set: JAttrSet | null) { return init(this, c, set, style(), 0); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: T, c: unknown, set: JAttrSet | null, dsa: number) { return init(this, c, set, dsa, 0); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": function (this: T, c: unknown, set: JAttrSet | null, dsa: number, dsr: number) { return init(this, c, set, dsa, dsr); },
  };
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
const compoundMethods: NativeSpec["methods"] = {
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
};
rt.register({ name: "android/widget/CompoundButton", ctor: JCompoundButton, sup: "android/widget/Button", ifaces: ["android/widget/Checkable"], methods: compoundMethods });
rt.markers("android/widget/CompoundButton$OnCheckedChangeListener", "android/widget/Checkable");
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
  textOn: unknown = ""; textOff: unknown = "";
  showText = true; splitTrack = false;
  thumbTextPadding = 0; switchMinWidth = 0; switchPadding = 0;
  switchPaint: JTextPaint | null = null;
  /** 0 off .. 1 on */
  thumbPos = 0;
  switchW = 0; switchH = 0; thumbW = 0;
  switchL = 0; switchT = 0; switchR = 0; switchB = 0;
  readonly pad = new JRect();
  thumbOffset(range: number) { return Math.trunc(this.thumbPos * range + 0.5); }
  /** the track's padding into `pad`, and the thumb's optical insets */
  *insets$(thread = curThread): Gen<JInsets> {
    if (this.track) yield vcallOn(thread, this.track, "getPadding", "(Landroid/graphics/Rect;)Z", this.pad);
    else this.pad.left = this.pad.top = this.pad.right = this.pad.bottom = 0;
    return this.thumb ? yield vcallOn(thread, this.thumb, "getOpticalInsets", "()Landroid/graphics/Insets;") : NO_INSETS;
  }
  switchText(on: boolean): string { return spannedString(on ? this.textOn : this.textOff); }
}
const NO_INSETS = insetsOf(0, 0, 0, 0);
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
rt.register({ name: "android/widget/Switch", ctor: JSwitch, sup: "android/widget/CompoundButton", methods: {
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
    return after(this.setChecked(!!c), () => { this.thumbPos = this.checked ? 1 : 0; invalidate(this); });
  },
  "getCompoundPaddingRight()I": switchPadRight,
  ...fieldGetters({ "getTextOn()Ljava/lang/CharSequence;": "textOn", "getTextOff()Ljava/lang/CharSequence;": "textOff",
    "getThumbDrawable()Landroid/graphics/drawable/Drawable;": "thumb", "getTrackDrawable()Landroid/graphics/drawable/Drawable;": "track",
    "getThumbTintList()Landroid/content/res/ColorStateList;": "thumbTint", "getTrackTintList()Landroid/content/res/ColorStateList;": "trackTint",
    "getThumbTintMode()Landroid/graphics/PorterDuff$Mode;": "thumbTintMode", "getTrackTintMode()Landroid/graphics/PorterDuff$Mode;": "trackTintMode",
    "getThumbTextPadding()I": "thumbTextPadding", "getSwitchMinWidth()I": "switchMinWidth", "getSwitchPadding()I": "switchPadding" }),
  ...flagGetters({ "getShowText()Z": "showText", "getSplitTrack()Z": "splitTrack" }),
  ...relayoutSetters({ "setTextOn(Ljava/lang/CharSequence;)V": "textOn", "setTextOff(Ljava/lang/CharSequence;)V": "textOff",
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
  "setSwitchTypeface(Landroid/graphics/Typeface;)V": function (this: JSwitch, tf: JTypeface | null) {
    (this.switchPaint ??= Object.assign(new JTextPaint(), { textSize: this.paintT.textSize })).tf = tf ?? tfDefault; requestLayout(this);
  },
  "setSwitchTypeface(Landroid/graphics/Typeface;I)V": function (this: JSwitch, tf: JTypeface | null) {
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
    // AOSP Switch.draw: the track spans the switch, the thumb sits along the scroll range
    const insets: JInsets = yield* this.insets$(thread);
    const range = track ? this.switchW - this.thumbW - pad.left - pad.right - insets.left - insets.right : 0;
    let thumbLeft = this.switchL + this.thumbOffset(range);
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
} });
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
    "<init>(Landroid/view/ViewGroup$LayoutParams;)V": function (this: JLinearLP, source: JLayoutParams) { marginCopy.call(this, source); },
    "<init>(Landroid/view/ViewGroup$MarginLayoutParams;)V": function (this: JLinearLP, source: JLayoutParams) { marginCopy.call(this, source); },
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
const initCheckedText = driven(function* initCheckedText(v: JCheckedTextView, c: unknown, set: JAttrSet | null, dsa: number, dsr: number): Gen {
  yield initViewFromCtx(v, c, set, dsa, dsr);
  yield applyTvStyle(v, set, dsa, dsr);
  const res = v.jres;
  if (!res) return;
  const a = obtainStyled(res, v.theme, set, ["checked", "checkMark", "checkMarkTint", "checkMarkGravity"].map(AID), dsa, dsr);
  if (a.vals[3]) v.checkMarkGravity = rvInt(res, a.vals[3], v.checkMarkGravity);
  v.basePad = v.atStart() ? v.padL : v.padR;
  if (a.vals[2]) { v.checkMarkTint = yield rvCsl(res, a.vals[2], v.theme); v.hasCheckMarkTint = true; }
  if (a.vals[1]) yield v.setCheckMark(yield loadDrawableRV(res, a.vals[1], v.theme));
  if (a.vals[0]) yield vcall(v, "setChecked", "(Z)V", rvInt(res, a.vals[0], 0));
});
const checkedTextStyle = () => AID("checkedTextViewStyle");
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
  methods: {
    ...textViewMethods,
    "<init>(Landroid/content/Context;)V": function (this: JCheckedTextView, c: unknown) { return initCheckedText(this, c, null, checkedTextStyle(), 0); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: JCheckedTextView, c: unknown, set: JAttrSet | null) { return initCheckedText(this, c, set, checkedTextStyle(), 0); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: JCheckedTextView, c: unknown, set: JAttrSet | null, dsa: number) { return initCheckedText(this, c, set, dsa, 0); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": function (this: JCheckedTextView, c: unknown, set: JAttrSet | null, dsa: number, dsr: number) { return initCheckedText(this, c, set, dsa, dsr); },
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
  },
});
