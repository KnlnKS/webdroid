// Android time and date pickers use the shared AlertDialog chrome.

import { rt, type NativeSpec, driven, type Gen } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall, boxInt, vcallUncaught } from "../jvm/natives/jlang";
import { reportUncaught } from "./os";
import { JAlertDialog, initDialog } from "./dialog";
import { JView, JLinearLP, attachView, addUnattachedView, detachView, requestLayout, invalidate, initViewFromCtx, inheritContext } from "./view";
import { tfMedium } from "./graphics";
import { JAttrSet, themeOf } from "./res";
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
    void vcallUncaught(tp.changeL, "onTimeChanged", "(Landroid/widget/TimePicker;II)V", tp, tp.hourVal, tp.minuteVal);
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

function mkArrow(tp: JView, glyph: string, fn: () => void): JTextView {
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

function mkValueText(tp: JView): JTextView {
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

function mkColumn(tp: JView, up: () => void, down: () => void): { col: JLinearLayout; text: JTextView } {
  const col = new JLinearLayout();
  col.orientation = 1;
  col.gravity = G.CENTER;
  inheritContext(col, tp);
  col.lp = stepperLP();
  const text = mkValueText(tp);
  addUnattachedView(col, mkArrow(tp, "▲", up));
  addUnattachedView(col, text);
  addUnattachedView(col, mkArrow(tp, "▼", down));
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
    addUnattachedView(col, tp.amText);
    addUnattachedView(col, tp.pmText);
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
  "<init>(Landroid/content/Context;)V": driven(function* (this: JTimePicker, c: unknown): Gen {
    yield initViewFromCtx(this, c, null);
    return buildPicker(this);
  }),
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JTimePicker, c: unknown, set: JAttrSet | null): Gen {
    yield initViewFromCtx(this, c, set);
    return buildPicker(this);
  }),
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
async function initTimePickerDialog(d: JTimePickerDialog, c: unknown, listener: unknown, hourOfDay: number, minute: number, is24HourView: number, themeId = 0) {
  await initDialog.call(d, c, themeId);
  const tp = new JTimePicker();
  tp.ctx = d.jctx;
  const host = (d.jctx as JContext | null)?.$host;
  tp.jres = host?.res ?? null;
  tp.theme = themeOf(d.jctx);
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
    [mangleMethod("onClick", "(Landroid/content/DialogInterface;I)V")]: driven(function* (): Gen  {
      if (d.timeSetL) yield vcall(d.timeSetL, "onTimeSet", "(Landroid/widget/TimePicker;II)V", tp, tp.hourVal, tp.minuteVal);
    }),
  };
}
const timePickerDialogMethods: NativeSpec["methods"] = {
  "<init>(Landroid/content/Context;Landroid/app/TimePickerDialog$OnTimeSetListener;IIZ)V":
    function (this: JTimePickerDialog, c: unknown, l: unknown, h: number, m: number, is24: number) {
      return initTimePickerDialog(this, c, l, h, m, is24);
    },
  "<init>(Landroid/content/Context;ILandroid/app/TimePickerDialog$OnTimeSetListener;IIZ)V":
    function (this: JTimePickerDialog, c: unknown, themeId: number, l: unknown, h: number, m: number, is24: number) {
      return initTimePickerDialog(this, c, l, h, m, is24, themeId);
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

class JDatePicker extends JLinearLayout {
  yearVal = 1970;
  monthVal = 0;
  dayVal = 1;
  firstDay = 1;
  changeL: unknown = null;
  built = false;
  valueTexts: JTextView[] = [];
}

function normalizeDate(p: JDatePicker, year: number, month: number, day: number) {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  p.yearVal = date.getFullYear();
  p.monthVal = date.getMonth();
  p.dayVal = date.getDate();
}

function refreshDate(p: JDatePicker) {
  const [month, day, year] = p.valueTexts;
  if (month) setValueText(month, String(p.monthVal + 1).padStart(2, "0"));
  if (day) setValueText(day, String(p.dayVal).padStart(2, "0"));
  if (year) setValueText(year, String(p.yearVal));
}

async function setDate(p: JDatePicker, year: number, month: number, day: number, notify: boolean) {
  if (p.yearVal === year && p.monthVal === month && p.dayVal === day) return;
  normalizeDate(p, year, month, day);
  refreshDate(p);
  if (notify && p.changeL) await vcall(p.changeL, "onDateChanged", "(Landroid/widget/DatePicker;III)V",
    p, p.yearVal, p.monthVal, p.dayVal);
}

async function buildDatePicker(p: JDatePicker) {
  if (p.built) return;
  p.built = true;
  p.orientation = 0;
  p.gravity = G.CENTER;
  p.padT = 24; p.padB = 24;
  const steps: [number, number, number][] = [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
  for (const [year, month, day] of steps) {
    const step = (direction: number) => {
      const nextYear = p.yearVal + year * direction;
      const nextMonth = p.monthVal + month * direction;
      const nextDay = year || month ? Math.min(p.dayVal, new Date(nextYear, nextMonth + 1, 0).getDate())
        : p.dayVal + day * direction;
      void setDate(p, nextYear, nextMonth, nextDay, true).catch(reportUncaught);
    };
    const { col, text } = mkColumn(p, () => step(1), () => step(-1));
    await attachView(p, col);
    p.valueTexts.push(text);
  }
  refreshDate(p);
}

rt.register({ name: "android/widget/DatePicker", ctor: JDatePicker, sup: "android/widget/LinearLayout", methods: {
  "<init>(Landroid/content/Context;)V": driven(function* (this: JDatePicker, c: unknown): Gen {
    yield initViewFromCtx(this, c, null);
    return buildDatePicker(this);
  }),
  "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": driven(function* (this: JDatePicker, c: unknown, set: JAttrSet | null): Gen {
    yield initViewFromCtx(this, c, set);
    return buildDatePicker(this);
  }),
  "init(IIILandroid/widget/DatePicker$OnDateChangedListener;)V": function (this: JDatePicker, year: number, month: number, day: number, listener: unknown) {
    normalizeDate(this, year, month, day);
    this.changeL = listener;
    refreshDate(this);
  },
  "updateDate(III)V": function (this: JDatePicker, year: number, month: number, day: number) {
    return setDate(this, year, month, day, true);
  },
  "getYear()I": function (this: JDatePicker) { return this.yearVal; },
  "getMonth()I": function (this: JDatePicker) { return this.monthVal; },
  "getDayOfMonth()I": function (this: JDatePicker) { return this.dayVal; },
  "setFirstDayOfWeek(I)V": function (this: JDatePicker, day: number) {
    if (day < 1 || day > 7) throw rt.mkThrowable("java/lang/IllegalArgumentException", "firstDayOfWeek must be between 1 and 7");
    this.firstDay = day;
  },
  "getFirstDayOfWeek()I": function (this: JDatePicker) { return this.firstDay; },
} });
rt.markers("android/widget/DatePicker$OnDateChangedListener");

class JDatePickerDialog extends JAlertDialog { picker: JDatePicker | null = null; dateSetL: unknown = null; }
async function initDatePickerDialog(d: JDatePickerDialog, c: unknown, themeId: number, listener: unknown,
  year: number, month: number, day: number) {
  await initDialog.call(d, c, themeId);
  const p = new JDatePicker();
  p.ctx = d.jctx;
  p.jres = (d.jctx as JContext | null)?.$host?.res ?? null;
  p.theme = themeOf(d.jctx);
  normalizeDate(p, year, month, day);
  await buildDatePicker(p);
  d.picker = p;
  d.customView = p;
  d.dateSetL = listener;
  d.posText = "OK";
  d.negText = "Cancel";
  d.posL = {
    [mangleMethod("onClick", "(Landroid/content/DialogInterface;I)V")]: driven(function* (): Gen  {
      if (d.dateSetL) (yield vcall(d.dateSetL, "onDateSet", "(Landroid/widget/DatePicker;III)V",
        p, p.yearVal, p.monthVal, p.dayVal));
    }),
  };
}
rt.register({ name: "android/app/DatePickerDialog", ctor: JDatePickerDialog, sup: "android/app/AlertDialog", methods: {
  "<init>(Landroid/content/Context;ILandroid/app/DatePickerDialog$OnDateSetListener;III)V":
    function (this: JDatePickerDialog, c: unknown, themeId: number, listener: unknown, year: number, month: number, day: number) {
      return initDatePickerDialog(this, c, themeId, listener, year, month, day);
    },
  "<init>(Landroid/content/Context;Landroid/app/DatePickerDialog$OnDateSetListener;III)V":
    function (this: JDatePickerDialog, c: unknown, listener: unknown, year: number, month: number, day: number) {
      return initDatePickerDialog(this, c, 0, listener, year, month, day);
    },
  "getDatePicker()Landroid/widget/DatePicker;": function (this: JDatePickerDialog) { return this.picker; },
  "updateDate(III)V": function (this: JDatePickerDialog, year: number, month: number, day: number) {
    return this.picker ? setDate(this.picker, year, month, day, true) : undefined;
  },
} });
rt.markers("android/app/DatePickerDialog$OnDateSetListener");
