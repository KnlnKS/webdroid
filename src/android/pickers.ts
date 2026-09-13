// android.widget.TimePicker + android.app.TimePickerDialog.
// A minimal, generic (non-app-specific) hour/minute stepper, and a dialog that wraps it in
// the same AlertDialog chrome (title/customView/OK-Cancel buttons) other dialogs use — see
// JAlertDialog in dialog.ts, whose show()/buildAlertContent flow this dialog inherits by
// extending JAlertDialog directly, exactly as AOSP's own TimePickerDialog does.

import { rt, type NativeSpec } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, boxInt } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";
import { JAlertDialog } from "./dialog";
import { JLinearLP, attachView, detachView, requestLayout, invalidate, initViewFromCtx, inheritContext } from "./view";
import { tfMedium } from "./graphics";
import { JAttrSet } from "./res";
import { JLinearLayout } from "./layouts";
import { JTextView } from "./textview";
import { themeAccent } from "./widget";
import { G } from "./gravity";
import type { JContext } from "./context";

// ── TimePicker: hour/minute steppers with an optional AM/PM column.
class JTimePicker extends JLinearLayout {
  hourVal = 0;   // always stored 0-23
  minuteVal = 0; // 0-59
  is24 = false;
  changeL: unknown = null;
  built = false;
  hourText: JTextView | null = null;
  minuteText: JTextView | null = null;
  amText: JTextView | null = null;
  pmText: JTextView | null = null;
}

function displayHour(tp: JTimePicker): number {
  if (tp.is24) return tp.hourVal;
  const h = tp.hourVal % 12;
  return h === 0 ? 12 : h;
}

/** Text.onDraw only re-wraps when layoutWidthFor !== width() (see widget.ts), so a plain
 *  `.text =` assignment would leave the old glyphs cached on screen — reset it here too. */
function setValueText(t: JTextView, s: string) {
  if (t.text === s) return;
  t.text = s;
  t.layoutWidthFor = -1;
  requestLayout(t);
}
function refreshPicker(tp: JTimePicker) {
  if (tp.hourText) setValueText(tp.hourText, String(displayHour(tp)).padStart(2, "0"));
  if (tp.minuteText) setValueText(tp.minuteText, String(tp.minuteVal).padStart(2, "0"));
  if (tp.amText && tp.pmText) {
    const pm = tp.hourVal >= 12;
    const accent = themeAccent(tp);
    tp.amText.colors.defColor = pm ? -6710887 : accent;
    tp.pmText.colors.defColor = pm ? accent : -6710887;
  }
  invalidate();
}

function onChanged(tp: JTimePicker) {
  refreshPicker(tp);
  if (tp.changeL) {
    void vcall(tp.changeL, "onTimeChanged", "(Landroid/widget/TimePicker;II)V", tp, tp.hourVal, tp.minuteVal).catch(reportUncaught);
  }
}

const onClickDesc = "(Landroid/view/View;)V";
function onTap(v: { clickable: boolean; clickL: unknown }, fn: () => void) {
  v.clickable = true;
  v.clickL = { [mangleMethod("onClick", onClickDesc)]: () => fn() };
}

function stepperLP(): JLinearLP {
  const lp = new JLinearLP();
  lp.width = -2; lp.height = -2;
  return lp;
}

function mkArrow(tp: JTimePicker, glyph: string, fn: () => void): JTextView {
  const t = new JTextView();
  inheritContext(t, tp);
  t.text = glyph;
  t.paintT.textSize = 32;
  t.colors.defColor = themeAccent(tp);
  t.padL = 24; t.padR = 24; t.padT = 12; t.padB = 12;
  t.gravityT = G.CENTER;
  t.lp = stepperLP();
  onTap(t, fn);
  return t;
}

function mkValueText(tp: JTimePicker): JTextView {
  const t = new JTextView();
  inheritContext(t, tp);
  t.paintT.textSize = 64;
  t.paintT.tf = tfMedium;
  t.colors.defColor = -13421773;
  t.gravityT = G.CENTER;
  t.padT = 8; t.padB = 8; t.padL = 16; t.padR = 16;
  t.lp = stepperLP();
  return t;
}

function mkColumn(tp: JTimePicker, up: () => void, down: () => void): { col: JLinearLayout; text: JTextView } {
  const col = new JLinearLayout();
  col.orientation = 1;
  col.gravity = G.CENTER;
  inheritContext(col, tp);
  col.lp = stepperLP();
  const text = mkValueText(tp);
  void attachView(col, mkArrow(tp, "▲", up));
  void attachView(col, text);
  void attachView(col, mkArrow(tp, "▼", down));
  return { col, text };
}

function mkSep(tp: JTimePicker): JTextView {
  const t = new JTextView();
  inheritContext(t, tp);
  t.text = ":";
  t.paintT.textSize = 56;
  t.colors.defColor = -13421773;
  t.gravityT = G.CENTER;
  t.padL = 8; t.padR = 8;
  t.lp = stepperLP();
  return t;
}

function mkAmPmText(tp: JTimePicker, label: string, fn: () => void): JTextView {
  const t = new JTextView();
  inheritContext(t, tp);
  t.text = label;
  t.paintT.textSize = 26;
  t.paintT.tf = tfMedium;
  t.padT = 10; t.padB = 10; t.padL = 16; t.padR = 16;
  t.gravityT = G.CENTER;
  t.lp = stepperLP();
  onTap(t, fn);
  return t;
}

/** Builds the picker's child views once (idempotent). Called lazily so a picker constructed
 *  purely in TS — e.g. by TimePickerDialog — doesn't need a Java-side <init> call. */
async function buildPicker(tp: JTimePicker) {
  if (tp.built) return;
  tp.built = true;
  tp.orientation = 0;
  tp.gravity = G.CENTER;
  tp.padT = 24; tp.padB = 24;
  const hourCol = mkColumn(tp, () => { tp.hourVal = (tp.hourVal + 1) % 24; onChanged(tp); }, () => { tp.hourVal = (tp.hourVal + 23) % 24; onChanged(tp); });
  const minCol = mkColumn(tp, () => { tp.minuteVal = (tp.minuteVal + 1) % 60; onChanged(tp); }, () => { tp.minuteVal = (tp.minuteVal + 59) % 60; onChanged(tp); });
  await attachView(tp, hourCol.col);
  await attachView(tp, mkSep(tp));
  await attachView(tp, minCol.col);
  tp.hourText = hourCol.text;
  tp.minuteText = minCol.text;
  if (!tp.is24) {
    const col = new JLinearLayout();
    col.orientation = 1;
    col.gravity = G.CENTER;
    inheritContext(col, tp);
    col.padL = 24;
    col.lp = stepperLP();
    tp.amText = mkAmPmText(tp, "AM", () => { tp.hourVal = tp.hourVal % 12; onChanged(tp); });
    tp.pmText = mkAmPmText(tp, "PM", () => { tp.hourVal = (tp.hourVal % 12) + 12; onChanged(tp); });
    await attachView(col, tp.amText);
    await attachView(col, tp.pmText);
    await attachView(tp, col);
  } else {
    tp.amText = null;
    tp.pmText = null;
  }
  refreshPicker(tp);
}

/** Structural rebuild: only the 12h/24h AM-PM column count changes shape, so tear down and rebuild. */
async function rebuildPicker(tp: JTimePicker) {
  for (const child of [...tp.children]) await detachView(tp, child);
  tp.hourText = null; tp.minuteText = null; tp.amText = null; tp.pmText = null;
  tp.built = false;
  await buildPicker(tp);
  requestLayout(tp);
}

const timePickerMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;)V": async function (this: JTimePicker, c: unknown) {
    await initViewFromCtx(this, c, null);
    return buildPicker(this);
  },
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": async function (this: JTimePicker, c: unknown, set: JAttrSet | null) {
    await initViewFromCtx(this, c, set);
    return buildPicker(this);
  },
  "getHour()I": function (this: JTimePicker) { return this.hourVal; },
  "setHour(I)V": function (this: JTimePicker, h: number) { this.hourVal = h | 0; onChanged(this); },
  "getMinute()I": function (this: JTimePicker) { return this.minuteVal; },
  "setMinute(I)V": function (this: JTimePicker, m: number) { this.minuteVal = m | 0; onChanged(this); },
  // legacy Integer-wrapper API (pre API 23)
  "getCurrentHour()Ljava/lang/Integer;": function (this: JTimePicker) { return boxInt(this.hourVal); },
  "setCurrentHour(Ljava/lang/Integer;)V": function (this: JTimePicker, v: { v: number } | null) { this.hourVal = v ? v.v | 0 : 0; onChanged(this); },
  "getCurrentMinute()Ljava/lang/Integer;": function (this: JTimePicker) { return boxInt(this.minuteVal); },
  "setCurrentMinute(Ljava/lang/Integer;)V": function (this: JTimePicker, v: { v: number } | null) { this.minuteVal = v ? v.v | 0 : 0; onChanged(this); },
  "is24HourView()Z": function (this: JTimePicker) { return this.is24 ? 1 : 0; },
  "setIs24HourView(Ljava/lang/Boolean;)V": function (this: JTimePicker, v: { v: number } | null) {
    const next = !!v?.v;
    if (next === this.is24) return;
    this.is24 = next;
    return rebuildPicker(this);
  },
  "setOnTimeChangedListener(Landroid/widget/TimePicker$OnTimeChangedListener;)V": function (this: JTimePicker, l: unknown) { this.changeL = l; },
};
rt.register({ name: "android/widget/TimePicker", ctor: JTimePicker, sup: "android/widget/LinearLayout", methods: timePickerMethods });
rt.markers("android/widget/TimePicker$OnTimeChangedListener");

// ── TimePickerDialog: AlertDialog with a TimePicker as its customView + OK/Cancel buttons.
// AOSP's own TimePickerDialog extends AlertDialog too, so this mirrors the real hierarchy —
// buildAlertContent (in dialog.ts) does the title/customView/button chrome for us.
class JTimePickerDialog extends JAlertDialog {
  picker: JTimePicker | null = null;
  timeSetL: unknown = null;
}
async function initTimePickerDialog(d: JTimePickerDialog, c: unknown, listener: unknown, hourOfDay: number, minute: number, is24HourView: number) {
  d.jctx = c;
  const tp = new JTimePicker();
  tp.ctx = c;
  const host = (c as JContext | null)?.$host;
  tp.jres = host?.res ?? null;
  tp.theme = host?.theme ?? null;
  tp.hourVal = hourOfDay | 0;
  tp.minuteVal = minute | 0;
  tp.is24 = !!is24HourView;
  await buildPicker(tp);
  d.picker = tp;
  d.customView = tp;
  d.timeSetL = listener;
  d.posText = "OK";
  d.negText = "Cancel";
  d.posL = {
    [mangleMethod("onClick", "(Landroid/content/DialogInterface;I)V")]: async () => {
      if (d.timeSetL) await vcall(d.timeSetL, "onTimeSet", "(Landroid/widget/TimePicker;II)V", tp, tp.hourVal, tp.minuteVal);
    },
  };
}
const timePickerDialogMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/app/TimePickerDialog$OnTimeSetListener;IIZ)V":
    function (this: JTimePickerDialog, c: unknown, l: unknown, h: number, m: number, is24: number) {
      return initTimePickerDialog(this, c, l, h, m, is24);
    },
  "<init>(Landroid/content/Context;ILandroid/app/TimePickerDialog$OnTimeSetListener;IIZ)V":
    function (this: JTimePickerDialog, c: unknown, themeId: number, l: unknown, h: number, m: number, is24: number) {
      this.themeId = themeId | 0;
      return initTimePickerDialog(this, c, l, h, m, is24);
    },
  "getTimePicker()Landroid/widget/TimePicker;": function (this: JTimePickerDialog) { return this.picker; },
  "updateTime(II)V": function (this: JTimePickerDialog, h: number, m: number) {
    if (!this.picker) return;
    this.picker.hourVal = h | 0;
    this.picker.minuteVal = m | 0;
    refreshPicker(this.picker);
  },
};
rt.register({ name: "android/app/TimePickerDialog", ctor: JTimePickerDialog, sup: "android/app/AlertDialog", methods: timePickerDialogMethods });
rt.markers("android/app/TimePickerDialog$OnTimeSetListener");
