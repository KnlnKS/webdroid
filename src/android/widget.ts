import { AID } from "./res";
import { JView, initViewFromCtx, invalidate, requestLayout, resolveSize, uiState, JViewGroup, JLinearLP, lpAttrs, lpFromAttrs, marginCopy, MATCH_PARENT, WRAP_CONTENT, type JLayoutParams } from "./view";
import { type JDrawable, type JColorStateList, ST, loadDrawableRV, loadDrawable, drawChild, drawableSize, JLayerDrawable } from "./drawable";
import { rt, type NativeSpec, stubs, noops, callSelf, fieldGetters, flagGetters, fieldSetters, flagSetters, driven, type Gen } from "../jvm/runtime";
import { type JAttrSet, rvColor, obtainStyled, rvInt, rvDimen } from "./res";
import { TV } from "./axml";
import { type JCanvas, cssColor } from "./graphics";
import { JTextView, textViewMethods, JButton, applyTvStyle } from "./textview";
import { G } from "./gravity";
import { device } from "../shell/config";
import { vcall, vcallOn, curThread, type JSimpleEnum } from "../jvm/natives/jlang";
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

/** TextView.onDraw with the text column starting at `padL` (compound widgets draw their indicator in the gap). */
const drawTextInset = driven(function* drawTextInset(tv: JTextView, cv: JCanvas, padL: number): Gen {
  const saved = tv.padL;
  tv.padL = padL;
  try { yield callSelf(textViewMethods, "onDraw(Landroid/graphics/Canvas;)V", tv, cv); }
  finally { tv.padL = saved; }
});

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
    this.minH = device.dp(48);
    this.minW = 0;
    this.padL = 0; this.padR = 0;
  }
  /** the android:button drawable, and the width the indicator reserves (0 = no indicator) */
  buttonD: JDrawable | null = null;
  buttonW = 0;
  buttonTint: JColorStateList | null = null;
  buttonTintMode: JSimpleEnum | null = null;
  hasButtonTint = false;
  updateButtonState(): unknown { return rt.drive(this.updateButtonState$()); }
  *updateButtonState$(): Gen {
    const thread = curThread, drawable = this.buttonD;
    if (!drawable || !(yield vcallOn(thread, drawable, "isStateful", "()Z"))) return;
    const state = yield vcallOn(thread, this, "getDrawableState", "()[I");
    if (yield vcallOn(thread, drawable, "setState", "([I)Z", state)) invalidate(this);
  }
  applyButtonTint(): unknown { return rt.drive(this.applyButtonTint$()); }
  *applyButtonTint$(): Gen {
    if (this.buttonD && this.hasButtonTint) yield vcall(this.buttonD, "setTintList", "(Landroid/content/res/ColorStateList;)V", this.buttonTint);
    if (this.buttonD && this.buttonTintMode) yield vcall(this.buttonD, "setTintMode", "(Landroid/graphics/PorterDuff$Mode;)V", this.buttonTintMode);
    invalidate(this);
  }
  setCheckedInternal(c: boolean): unknown { return rt.drive(this.setCheckedInternal$(c)); }
  *setCheckedInternal$(c: boolean): Gen {
    if (rt.iof(this, "android/widget/RadioButton") && this.idNum > 0) {
      let parent: JView | null = this.parent;
      while (parent && !(parent instanceof JRadioGroup)) parent = parent.parent;
      if (parent instanceof JRadioGroup && (c ? parent.checkedId !== this.idNum : parent.checkedId === this.idNum)) {
        yield parent.checkId(c ? this.idNum : -1);
        return;
      }
    }
    if (this.checked === c) return;
    this.checked = c;
    yield this.refreshDrawableState();
    yield this.applyButtonTint();
    if (this.broadcasting) return;
    this.broadcasting = true;
    if (this.checkL) {
      yield vcall(this.checkL, "onCheckedChanged", "(Landroid/widget/CompoundButton;Z)V", this, c ? 1 : 0);
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
      this.buttonW = kind === "switch" ? device.dp(52) : device.dp(32);
      await this.updateButtonState();
    }
  };
  return {
  ...textViewMethods,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": init,
  "setChecked(Z)V": function (this: JCompoundButton, c: number) { return this.setCheckedInternal(!!c); },
  "toggle()V": function (this: JCompoundButton) { return this.setCheckedInternal(!this.checked); },
  "performClick()Z": driven(function* (this: JCompoundButton): Gen {
    // inside a RadioGroup: single-select semantics
    let g: JView | null = this.parent;
    while (g && !(g instanceof JRadioGroup)) g = g.parent;
    if (g instanceof JRadioGroup && kind === "radio") {
      yield g.checkId(this.idNum);
    } else {
      yield this.setCheckedInternal(!this.checked);
    }
    if (this.clickL) yield vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
    return 1;
  }),
  ...flagGetters({ "isChecked()Z": "checked" }),
  ...fieldSetters({ "setOnCheckedChangeListener(Landroid/widget/CompoundButton$OnCheckedChangeListener;)V": "checkL" }),
  ...fieldGetters({ "getButtonDrawable()Landroid/graphics/drawable/Drawable;": "buttonD" }),
  "setButtonTintList(Landroid/content/res/ColorStateList;)V": function (this: JCompoundButton, tint: JColorStateList | null) {
    this.buttonTint = tint; this.hasButtonTint = true; return this.applyButtonTint();
  },
  "getButtonTintList()Landroid/content/res/ColorStateList;": function (this: JCompoundButton) { return this.buttonTint; },
  "setButtonTintMode(Landroid/graphics/PorterDuff$Mode;)V": function (this: JCompoundButton, mode: JSimpleEnum | null) {
    this.buttonTintMode = mode; return this.applyButtonTint();
  },
  "getButtonTintMode()Landroid/graphics/PorterDuff$Mode;": function (this: JCompoundButton) { return this.buttonTintMode; },
  "setButtonDrawable(Landroid/graphics/drawable/Drawable;)V": driven(function* (this: JCompoundButton, d: JDrawable | null): Gen {
    this.buttonD = d;
    this.buttonW = d ? (kind === "switch" ? device.dp(52) : device.dp(32)) : 0;
    yield this.updateButtonState();
    return this.applyButtonTint();
  }),
  "setButtonDrawable(I)V": driven(function* (this: JCompoundButton, id: number): Gen {
    this.buttonD = id ? yield loadDrawable(this.jres!, id, this.theme) : null;
    this.buttonW = id ? (kind === "switch" ? device.dp(52) : device.dp(32)) : 0;
    yield this.updateButtonState();
    yield this.applyButtonTint();
  }),
  "drawableStateChanged()V": function (this: JCompoundButton) {
    this.updateLinkColor();
    return this.updateButtonState();
  },
  "onMeasure(II)V": driven(function* (this: JCompoundButton, wSpec: number, hSpec: number): Gen {
    yield callSelf(textViewMethods, "onMeasure(II)V", this, wSpec, hSpec);
    this.measuredW = resolveSize(this.measuredW + this.buttonW, wSpec);
    this.measuredH = resolveSize(Math.max(this.measuredH, device.dp(48)), hSpec);
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JCompoundButton, cv: JCanvas): Gen {
    const thread = curThread;
    if (!this.buttonW) return (textViewMethods["onDraw(Landroid/graphics/Canvas;)V"] as (cv: JCanvas) => void).call(this, cv);
    const ctx = cv.ctx;
    const accent = themeAccent(this);
    const cy = this.height() / 2;
    const indX = kind === "switch" ? this.width() - this.padR - device.dp(44) : this.padL + device.dp(4);
    const w = this.buttonD ? yield drawableSize(this.buttonD, false, thread) : -1;
    if (this.buttonD && w > 0) {
      const h = yield drawableSize(this.buttonD, true, thread);
      const b = this.buttonD.bounds;
      b.left = indX; b.top = cy - h / 2; b.right = indX + w; b.bottom = cy + h / 2;
      this.buttonD.stateSet = this.drawableState();
      yield drawChild(this.buttonD, cv, thread);
      return drawTextInset(this, cv, kind !== "switch" ? indX + this.buttonW - device.dp(4) : this.padL);
    }
    if (kind === "check") {
      const s = device.dp(18);
      const x = indX, y = cy - s / 2;
      ctx.lineWidth = device.dp(2);
      if (this.checked) {
        ctx.fillStyle = cssColor(accent);
        ctx.beginPath();
        ctx.roundRect(x, y, s, s, device.dp(2));
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = device.dp(2.5);
        ctx.beginPath();
        ctx.moveTo(x + device.dp(4), y + device.dp(9.5));
        ctx.lineTo(x + device.dp(7.5), y + device.dp(13));
        ctx.lineTo(x + device.dp(14), y + device.dp(5));
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(0,0,0,0.54)";
        ctx.beginPath();
        ctx.roundRect(x + device.dp(1), y + device.dp(1), s - device.dp(2), s - device.dp(2), device.dp(2));
        ctx.stroke();
      }
    } else if (kind === "radio") {
      const r = device.dp(9);
      ctx.lineWidth = device.dp(2);
      ctx.strokeStyle = this.checked ? cssColor(accent) : "rgba(0,0,0,0.54)";
      ctx.beginPath();
      ctx.arc(indX + r, cy, r - device.dp(1), 0, Math.PI * 2);
      ctx.stroke();
      if (this.checked) {
        ctx.fillStyle = cssColor(accent);
        ctx.beginPath();
        ctx.arc(indX + r, cy, r - device.dp(5), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const tw = device.dp(34), th = device.dp(14);
      ctx.fillStyle = this.checked ? cssColor((accent & 0xffffff) | 0x66000000) : "rgba(0,0,0,0.26)";
      ctx.beginPath();
      ctx.roundRect(indX + device.dp(5), cy - th / 2, tw - device.dp(10), th, th / 2);
      ctx.fill();
      ctx.fillStyle = this.checked ? cssColor(accent) : "#fafafa";
      ctx.strokeStyle = "rgba(0,0,0,0.13)";
      ctx.beginPath();
      ctx.arc(this.checked ? indX + tw - device.dp(10) : indX + device.dp(10), cy, device.dp(10), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    return drawTextInset(this, cv, kind !== "switch" ? indX + this.buttonW - device.dp(4) : this.padL);
  }),
  };
};
rt.register({ name: "android/widget/CompoundButton", ctor: JCompoundButton, sup: "android/widget/Button", ifaces: ["android/widget/Checkable"], methods: compoundMethods("check") });
rt.markers("android/widget/CompoundButton$OnCheckedChangeListener", "android/widget/Checkable");
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
  checkId(id: number, fire = true): unknown { return rt.drive(this.checkId$(id, fire)); }
  *checkId$(id: number, fire = true): Gen {
    this.checkedId = id;
    for (const r of this.radios()) {
      yield r.setCheckedInternal(r.idNum === id);
    }
    if (fire && this.checkL) {
      yield vcall(this.checkL, "onCheckedChanged", "(Landroid/widget/RadioGroup;I)V", this, id);
    }
    invalidate();
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
    "setOnCheckedChangeListener(Landroid/widget/RadioGroup$OnCheckedChangeListener;)V": function (this: JRadioGroup, l: unknown) {
      this.checkL = l;
    },
    "check(I)V": function (this: JRadioGroup, id: number) { return this.checkId(id); },
    "clearCheck()V": function (this: JRadioGroup) { return this.checkId(-1); },
    "getCheckedRadioButtonId()I": function (this: JRadioGroup) {
      if (this.checkedId === -1) this.checkedId = this.radios().find((r) => r.checked && rt.iof(r, "android/widget/RadioButton"))?.idNum ?? -1;
      return this.checkedId;
    },
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
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JCheckedTextView, c: unknown, set: JAttrSet | null): Gen {
      yield initViewFromCtx(this, c, set);
      yield applyTvStyle(this, set, 0);
      this.gravityT = 16 | G.START;
    }),
    "setChecked(Z)V": function (this: JCheckedTextView, v: number) { this.checked = !!v; invalidate(); },
    "isChecked()Z": function (this: JCheckedTextView) { return this.checked ? 1 : 0; },
    "toggle()V": function (this: JCheckedTextView) { this.checked = !this.checked; invalidate(); },
    "setCheckMarkDrawable(I)V": () => {},
    "setCheckMarkDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JCheckedTextView, d: JDrawable | null) {
      this.checkMarkDrawable = d;
    },
    "onMeasure(II)V": driven(function* (this: JCheckedTextView, wSpec: number, hSpec: number): Gen {
      yield callSelf(textViewMethods, "onMeasure(II)V", this, wSpec, hSpec);
      this.measuredH = Math.max(this.measuredH, device.dp(48));
    }),
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JCheckedTextView, cv: JCanvas) {
      const ctx = cv.ctx;
      const cy = this.height() / 2;
      const r = device.dp(9);
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
      ctx.lineWidth = device.dp(2);
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
