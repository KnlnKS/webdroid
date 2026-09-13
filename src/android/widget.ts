import { AID } from "./res";
import { JView, initViewFromCtx, invalidate, resolveSizeAndState, uiState, JViewGroup } from "./view";
import { type JDrawable, type JColorStateList, ST, loadDrawableRV, loadDrawable, drawChild } from "./drawable";
import { rt, type NativeSpec, stubs, noops, callSelf, fieldGetters, flagGetters, fieldSetters, flagSetters } from "../jvm/runtime";
import { type JAttrSet, rvColor, obtainStyled, rvInt } from "./res";
import { TV } from "./axml";
import { type JCanvas, cssColor } from "./graphics";
import { JTextView, textViewMethods, JButton, applyTvStyle } from "./textview";
import { G } from "./gravity";
import { device } from "../shell/config";
import { vcall } from "../jvm/natives/jlang";
import { JLinearLayout, linearMethods } from "./layouts";

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
/**
 * AbsSeekBar/SeekBar/RatingBar over ProgressBar's state. A rating is a progress in steps, which
 * is how AOSP stores it; the stars themselves come from a progressDrawable this does not build,
 * so the widget holds and reports its rating without painting one.
 */
class JRatingBar extends JProgressBar { stars = 5; step = 0.5; ratingL: unknown = null; }
const seekBarMethods: NativeSpec["methods"] = {
  "setKeyProgressIncrement(I)V": () => {},
  "setThumb(Landroid/graphics/drawable/Drawable;)V": () => {},
  "setOnSeekBarChangeListener(Landroid/widget/SeekBar$OnSeekBarChangeListener;)V": function (this: JRatingBar, l: unknown) { this.ratingL = l; },
};
for (const [name, sup] of [["android/widget/AbsSeekBar", "android/widget/ProgressBar"],
  ["android/widget/SeekBar", "android/widget/AbsSeekBar"]] as const) {
  rt.register({ name, ctor: class extends JRatingBar {}, sup, methods: seekBarMethods });
}
rt.markers("android/widget/SeekBar$OnSeekBarChangeListener", "android/widget/RatingBar$OnRatingBarChangeListener");
rt.register({
  name: "android/widget/RatingBar", ctor: JRatingBar, sup: "android/widget/AbsSeekBar",
  methods: {
    ...seekBarMethods,
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
    this.minH = device.dp(48);
    this.minW = 0;
    this.padL = 0; this.padR = 0;
  }
  /** the android:button drawable, and the width the indicator reserves (0 = no indicator) */
  buttonD: JDrawable | null = null;
  buttonW = 0;
  buttonTint: JColorStateList | null = null;
  hasButtonTint = false;
  async applyButtonTint() {
    if (this.buttonD && this.hasButtonTint) await vcall(this.buttonD, "setTintList", "(Landroid/content/res/ColorStateList;)V", this.buttonTint);
    invalidate(this);
  }
  async setCheckedInternal(c: boolean) {
    if (this.checked === c) return;
    this.checked = c;
    await this.refreshDrawableState();
    await this.applyButtonTint();
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
      this.buttonW = kind === "switch" ? device.dp(52) : device.dp(32);
    }
  };
  return {
  ...textViewMethods,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": init,
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": init,
  "setChecked(Z)V": function (this: JCompoundButton, c: number) { return this.setCheckedInternal(!!c); },
  "toggle()V": function (this: JCompoundButton) { return this.setCheckedInternal(!this.checked); },
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
  ...flagGetters({ "isChecked()Z": "checked" }),
  ...fieldSetters({ "setOnCheckedChangeListener(Landroid/widget/CompoundButton$OnCheckedChangeListener;)V": "checkL" }),
  ...fieldGetters({ "getButtonDrawable()Landroid/graphics/drawable/Drawable;": "buttonD" }),
  "setButtonTintList(Landroid/content/res/ColorStateList;)V": function (this: JCompoundButton, tint: JColorStateList | null) {
    this.buttonTint = tint; this.hasButtonTint = true; return this.applyButtonTint();
  },
  "getButtonTintList()Landroid/content/res/ColorStateList;": function (this: JCompoundButton) { return this.buttonTint; },
  "setButtonDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JCompoundButton, d: JDrawable | null) {
    this.buttonD = d;
    this.buttonW = d ? (kind === "switch" ? device.dp(52) : device.dp(32)) : 0;
    return this.applyButtonTint();
  },
  "setButtonDrawable(I)V": async function (this: JCompoundButton, id: number) {
    this.buttonD = id ? await loadDrawable(this.jres!, id, this.theme) : null;
    this.buttonW = id ? (kind === "switch" ? device.dp(52) : device.dp(32)) : 0;
    await this.applyButtonTint();
  },
  "onMeasure(II)V": async function (this: JCompoundButton, wSpec: number, hSpec: number) {
    await callSelf(textViewMethods, "onMeasure(II)V", this, wSpec, hSpec);
    this.measuredW = resolveSizeAndState(this.measuredW + this.buttonW, wSpec);
    this.measuredH = Math.max(this.measuredH, device.dp(48));
  },
  "onDraw(Landroid/graphics/Canvas;)V": function (this: JCompoundButton, cv: JCanvas) {
    if (!this.buttonW) return (textViewMethods["onDraw(Landroid/graphics/Canvas;)V"] as (cv: JCanvas) => void).call(this, cv);
    const ctx = cv.ctx;
    const accent = themeAccent(this);
    const cy = this.height() / 2;
    const indX = kind === "switch" ? this.width() - this.padR - device.dp(44) : this.padL + device.dp(4);
    if (this.buttonD && this.buttonD.intrinsicW() > 0) {
      const w = this.buttonD.intrinsicW(), h = this.buttonD.intrinsicH();
      const b = this.buttonD.bounds;
      b.left = indX; b.top = cy - h / 2; b.right = indX + w; b.bottom = cy + h / 2;
      this.buttonD.stateSet = this.drawableState();
      this.buttonD.paint(cv);
      drawTextInset(this, cv, kind !== "switch" ? indX + this.buttonW - device.dp(4) : this.padL);
      return;
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
    drawTextInset(this, cv, kind !== "switch" ? indX + this.buttonW - device.dp(4) : this.padL);
  },
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

async function initSpace(this: JView, context: unknown, attrs: JAttrSet | null = null, defStyle = 0) {
  await initViewFromCtx(this, context, attrs, defStyle);
  if (this.visibility === 0) this.visibility = 4;
}
rt.register({
  name: "android/widget/Space", ctor: class extends JView {}, sup: "android/view/View",
  methods: {
    "<init>(Landroid/content/Context;)V": initSpace,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": initSpace,
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": initSpace,
    "onMeasure(II)V": async function (this: JView, wSpec: number, hSpec: number) {
      this.measuredW = resolveSizeAndState(await vcall(this, "getSuggestedMinimumWidth", "()I"), wSpec) & 0xffffff;
      this.measuredH = resolveSizeAndState(await vcall(this, "getSuggestedMinimumHeight", "()I"), hSpec) & 0xffffff;
    },
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
    "onMeasure(II)V": async function (this: JCheckedTextView, wSpec: number, hSpec: number) {
      await callSelf(textViewMethods, "onMeasure(II)V", this, wSpec, hSpec);
      this.measuredH = Math.max(this.measuredH, device.dp(48));
    },
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
