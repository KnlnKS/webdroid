import { AID, resString } from "./res";
import { guestNow } from "../guest-clock";
import { JView, requestLayout, initViewFromCtx, guardCall, invalidate, specMode, specSize, MS_EXACTLY, MS_AT_MOST, resolveSize, setFocusHook, removeFrom } from "./view";
import {
  type JColorStateList, type Colors, colorFor, colorList, rvColors, type JDrawable, loadDrawableRV, loadDrawable,
  drawChild, drawableSize,
} from "./drawable";
import { type NativePaint, newPaint, paintOf, paintTypeface, setPaintTypeface, fontDescent, fontAscent, fontTop, fontBottom } from "./paint";
import { csText, csLength } from "../jvm/natives/jchars";
import { G, gravityV, gravityH } from "./gravity";
import { firstStrongRtl } from "../jvm/bidi";
import { device } from "../shell/config";
import { JRect } from "./graphics";
import { canvasOf, type JavaCanvas } from "./canvas";
import { vcall, vcallOn, curThread, after, mkEnumSet, newObj, scall, enumOrdinal } from "../jvm/natives/jlang";
import {
  attrTable, type Resources, resolveStyleValue, rvDimen, rvColor, rvInt, rvFloat, type RV, rvString, type JAttrSet,
  obtainStyled
} from "./res";
import { TV } from "./axml";
import { tfMedium, typefaceOf } from "./fonts";
import { type NativeSpec, rt, JObj, stubs, noops, driven, declaredField, type Gen } from "../jvm/runtime";
import { jarray, mangleMethod } from "../jvm/abi";
import { TextViewLayouts, Align, type TextViewLayout, relayout } from "./textview-layout";
import { compoundDrawableMethods, compoundPads, compoundWidth, compoundHeight, setIntrinsicDrawables, syncCompoundStates } from "./textview-compound";
import { focusedEdit, inputEl, focusEditText, selectionStart, selectionEnd, setSelection, selectAll } from "./textview-input";

const M_onTouchEvent = mangleMethod("onTouchEvent", "(Landroid/view/MotionEvent;)Z");

/** TextPaint's public fields, by their keys */
let linkColorKey = "", densityKey = "";
const textPaintField = (p: object) => p as Record<string, number>;
const linkColor = (p: object) => textPaintField(p)[linkColorKey ||= declaredField("android/text/TextPaint", "linkColor")];
export class JTextView extends JView {
  fallbackLineSpacing = true;
  lineBreakStyle = 0; lineBreakWordStyle = 0;
  transformation: unknown = null;
  /** AOSP mTransformed: what the TransformationMethod made of the text, laid out in its place */
  transformed: unknown = null;
  keyListener: unknown = null; movementMethod: unknown = null; selActionMode: unknown = null; editorActionL: unknown = null;
  insertionActionMode: unknown = null;
  drawableTint: JColorStateList | null = null;
  imeOptions = 0; privateImeOptions: string | null = null; breakStrategy = 1; hyphenation = 0; autoSizeType = 0;
  showSoftInputOnFocus = true;
  linksClickable = true; fontVariation: string | null = null;
  maxW = Infinity;
  maxH = Infinity;
  /** mText's characters, refreshed on every change */
  text = "";
  /** AOSP mText: a String, SpannedString, Spannable or (for an editable buffer) Editable */
  rawText: unknown = "";
  hint = "";
  /** mTextPaint, a Java TextPaint */
  paintT = newPaint("android/text/TextPaint");
  shadowRadius = 0; shadowDx = 0; shadowDy = 0; shadowColor = 0;
  colors: Colors = -16777216;
  hintColors: Colors | null = 1627389952;
  linkColors: Colors | null = null;
  gravityT = 48 | G.START;
  maxLinesV = Infinity;
  minLinesV = 1;
  singleLine = false;
  ellipsizeEnd = false;
  filters: unknown[] = [];
  lineSpacingExtra = 0;
  lineSpacingMult = 1;
  allCaps = false;
  /** set once a style or the app has spoken about textAllCaps, so a widget default cannot
   *  overrule it afterwards */
  capsSet = false;
  drawableL: JDrawable | null = null;
  drawableT: JDrawable | null = null;
  drawableR: JDrawable | null = null;
  drawableB: JDrawable | null = null;
  drawablePad = 0;
  override drawables(): (JDrawable | null)[] { return [...super.drawables(), this.drawableL, this.drawableT, this.drawableR, this.drawableB]; }
  /** AOSP mListeners */
  watchers: unknown[] = [];
  /** an EditText: its text is always an Editable */
  editable = false;
  changeWatcher: JObj | null = null;
  editableFactory: unknown = null; spannableFactory: unknown = null;
  cursorVisible = true;
  cursorDrawable: JDrawable | null = null;
  cursorDrawableRes = 0;
  /** when the caret last restarted its blink: focus and every edit, as AOSP's Editor.Blink does */
  blinkStart = 0;
  layout: TextViewLayout | null = null;
  /** the alignment the view last drew with, which layouts for measuring are built with too */
  align = Align.LEFT;
  textLayouts: TextViewLayouts | null = null; hintLayouts: TextViewLayouts | null = null;
  layoutWidthFor = -1;
  inputTypeV = 1;
  styleBits = 0;
  includePad = true;
  highlightColor = 0x6633b5e5; horizontallyScrolling = false; textSelectable = false;

  constructor() {
    super();
    this.tp.textSize = device.dp(14); // AOSP TextView default, 14sp
    textPaintField(this.paintT)[densityKey ||= declaredField("android/text/TextPaint", "density")] = device.density;
  }
  /** the text paint's native state, which layout and measurement read */
  get tp(): NativePaint { return paintOf(this.paintT); }
  updateLinkColor(): unknown {
    if (this.linkColors === null) return;
    return after(colorFor(this.linkColors, this.drawableState()), (color) => {
      if (linkColor(this.paintT) !== color) { textPaintField(this.paintT)[linkColorKey] = color; invalidate(this); }
    });
  }
  horizontalGravity(text: string, alignment: number, layoutDirection: number): number {
    if (alignment === 4) return 1;
    if (alignment === 5 || alignment === 6) return (alignment === 5) !== !!layoutDirection ? 3 : 5;
    const gravity = this.gravityT & 0x800007;
    if (alignment === 1 && gravity !== G.START && gravity !== G.END) return gravityH(gravity);
    const rtl = firstStrongRtl(text);
    return (alignment === 3 || alignment === 1 && gravity === G.END) !== rtl ? 5 : 3;
  }
  retransform(): unknown { return rt.drive(this.retransform$()); }
  *retransform$(): Gen {
    const method = this.transformation;
    if (!method) { this.transformed = null; return; }
    const out = yield vcall(method, "getTransformation", "(Ljava/lang/CharSequence;Landroid/view/View;)Ljava/lang/CharSequence;", this.rawText, this);
    this.transformed = out === this.rawText ? null : out;
  }
  lineHeight(): number {
    const height = Math.round(fontDescent(this.tp)) - Math.round(fontAscent(this.tp));
    return Math.round(height * this.lineSpacingMult + this.lineSpacingExtra);
  }
  /** includeFontPadding (AOSP's default): the first line's box starts at the font's `top` and the
   *  last one's ends at its `bottom`, so a line box is taller than ascent..descent at both ends. */
  topPad(): number { return this.includePad ? Math.round(fontAscent(this.tp)) - Math.floor(fontTop(this.tp)) : 0; }
  bottomPad(): number { return this.includePad ? Math.ceil(fontBottom(this.tp)) - Math.round(fontDescent(this.tp)) : 0; }
  textHeight(lines: number): number { return lines * this.lineHeight() + this.topPad() + this.bottomPad(); }
  ascent(): number { return Math.round(-fontAscent(this.tp)) + this.topPad(); }
  /** mText changed, by setText or an edit its ChangeWatcher reports: relayout and mirror a focused
   *  field into the page's input */
  *textChanged$(text?: string): Gen {
    this.text = text ?? (yield csText(this.rawText));
    this.layoutWidthFor = -1;
    if (typeof this.rawText !== "string") this.textLayouts = null;
    this.blinkStart = guestNow();
    if (this === focusedEdit && inputEl && inputEl.value !== this.text) inputEl.value = this.text;
    if (this.transformation) yield this.retransform();
    requestLayout(this);
  }
  /** sendBeforeTextChanged and sendOnTextChanged: each listener in turn */
  *sendTextEvent$(event: "beforeTextChanged" | "onTextChanged", text: unknown, start: number, before: number, after: number): Gen {
    const listeners = this.watchers, count = listeners.length;
    for (let i = 0; i < count; i++) yield vcall(listeners[i], event, "(Ljava/lang/CharSequence;III)V", text, start, before, after);
  }
  *sendAfterTextChanged$(text: unknown): Gen {
    const listeners = this.watchers, count = listeners.length;
    for (let i = 0; i < count; i++) yield vcall(listeners[i], "afterTextChanged", "(Landroid/text/Editable;)V", text);
  }
  /** mText as an Editable, made one as setText(mText, EDITABLE) makes it if it is not yet */
  getEditable(): unknown {
    return isEditable(this.rawText) ? this.rawText
      : after(vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", this.rawText, bufferTypes[2]), () => this.rawText);
  }
  shownText(): unknown { return this.transformed ?? this.rawText; }
  measuredLines(avail: number, align = this.align): TextViewLayout | Promise<TextViewLayout> {
    return (this.textLayouts ??= new TextViewLayouts()).get(this, this.shownText(), avail, align);
  }
}
const isEditable = (cs: unknown) => cs != null && typeof cs !== "string" && rt.iof(cs, "android/text/Editable");
const isSpannable = (cs: unknown) => cs != null && typeof cs !== "string" && rt.iof(cs, "android/text/Spannable");

/** TextView.ChangeWatcher: a span over the whole of a Spannable mText through which its edits
 *  reach the view and its listeners */
const CHANGE_WATCHER = "webdroid/TextViewChangeWatcher";
class JChangeWatcher extends JObj { tv!: JTextView; }
const spanChange = function (this: JChangeWatcher, _text: unknown, what: unknown) {
  const tv = this.tv;
  if (rt.iof(what, "android/text/style/CharacterStyle") || rt.iof(what, "android/text/style/ParagraphStyle") || rt.iof(what, "android/text/style/UpdateAppearance")) {
    tv.textLayouts = null; tv.layoutWidthFor = -1;
    requestLayout(tv);
  }
  invalidate(tv);
};
rt.register({
  name: CHANGE_WATCHER, ctor: JChangeWatcher, ifaces: ["android/text/TextWatcher", "android/text/SpanWatcher"],
  methods: {
    "beforeTextChanged(Ljava/lang/CharSequence;III)V": function (this: JChangeWatcher, text: unknown, start: number, before: number, after: number) {
      return rt.drive(this.tv.sendTextEvent$("beforeTextChanged", text, start, before, after));
    },
    "onTextChanged(Ljava/lang/CharSequence;III)V": driven(function* (this: JChangeWatcher, text: unknown, start: number, before: number, after: number): Gen {
      yield* this.tv.textChanged$();
      yield* this.tv.sendTextEvent$("onTextChanged", text, start, before, after);
    }),
    "afterTextChanged(Landroid/text/Editable;)V": function (this: JChangeWatcher, text: unknown) { return rt.drive(this.tv.sendAfterTextChanged$(text)); },
    "onSpanAdded(Landroid/text/Spannable;Ljava/lang/Object;II)V": spanChange,
    "onSpanRemoved(Landroid/text/Spannable;Ljava/lang/Object;II)V": spanChange,
    "onSpanChanged(Landroid/text/Spannable;Ljava/lang/Object;IIII)V": spanChange,
  },
});
/** setText's last step for Spannable text: its ChangeWatcher, replacing those other views left in it */
const watchText = driven(function* watchText(tv: JTextView, text: unknown, length: number): Gen {
  for (const old of yield vcall(text, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, length, rt.classFor(CHANGE_WATCHER)))
    yield vcall(text, "removeSpan", "(Ljava/lang/Object;)V", old);
  tv.changeWatcher ??= Object.assign(rt.make(CHANGE_WATCHER), { tv });
  // SPAN_INCLUSIVE_INCLUSIVE at CHANGE_WATCHER_PRIORITY
  yield vcall(text, "setSpan", "(Ljava/lang/Object;III)V", tv.changeWatcher, 0, length, 0x12 | 100 << 16);
});
const tvAttr = attrTable(
  "text", "textSize", "textColor", "textStyle", "textAppearance", "hint", "gravity", "maxLines",
  "minLines", "lines", "singleLine", "ellipsize", "lineSpacingExtra", "lineSpacingMultiplier",
  "drawableLeft", "drawableTop", "drawableRight", "drawableBottom", "drawablePadding", "drawableStart",
  "drawableEnd", "fontFamily", "textAllCaps", "textColorHint", "inputType",
  "imeOptions", "includeFontPadding", "ems", "minEms", "minWidth", "shadowColor", "shadowDx", "shadowDy", "shadowRadius", "textColorLink", "textCursorDrawable", "password", "maxLength");

const applyTextAppearance = driven(function* applyTextAppearance(tv: JTextView, res: Resources, styleId: number): Gen {
  if (!styleId) return;
  const look = (name: string) => resolveStyleValue(res, tv.theme, res.styleLookup(styleId, AID(name)));
  const ts = look("textSize");
  if (ts) tv.tp.textSize = rvDimen(res, ts, tv.tp.textSize);
  const tc = look("textColor");
  if (tc) tv.colors = yield rvColors(res, tc, tv.theme, -16777216);
  const link = look("textColorLink");
  if (link) {
    tv.linkColors = yield rvColors(res, link, tv.theme, linkColor(tv.paintT));
    yield tv.updateLinkColor();
  }
  const st = look("textStyle");
  if (st) tv.styleBits = rvInt(res, st, 0);
  yield applyFontFamily(tv, res, look("fontFamily"));
  const caps = look("textAllCaps");
  if (caps) { tv.allCaps = !!rvInt(res, caps, 0); tv.capsSet = true; }
});
/** `android:fontFamily` is either a system family name or a reference to a @font/ resource —
 *  a bare .ttf or a <font-family> XML. Apps ship their own fonts and name them this way. */
const applyFontFamily = driven(function* applyFontFamily(tv: JTextView, res: Resources, v: RV | null): Gen {
  if (!v) return;
  if (v.t === TV.REFERENCE && v.d) {
    const tf = yield vcall(res.jobj, "getFont", "(I)Landroid/graphics/Typeface;", v.d);
    if (tf) yield setPaintTypeface(tv.paintT, tf);
    return;
  }
  const fam = rvString(res, v);
  if (fam) yield setPaintTypeface(tv.paintT, yield scall(TYPEFACE, "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", fam, 0));
});
const TYPEFACE = "android/graphics/Typeface";
/** AOSP setTypeface(Typeface, int): the typeface in the style asked for, faking what it lacks */
const setStyledTypeface = driven(function* setStyledTypeface(tv: JTextView, tf: object | null, style: number): Gen {
  if (style > 0) tf = yield tf ? scall(TYPEFACE, "create", "(Landroid/graphics/Typeface;I)Landroid/graphics/Typeface;", tf, style)
    : scall(TYPEFACE, "defaultFromStyle", "(I)Landroid/graphics/Typeface;", style);
  yield vcall(tv, "setTypeface", "(Landroid/graphics/Typeface;)V", tf);
  const need = style > 0 ? style & ~typefaceOf(tf).apiStyle : 0;
  const fakeBold = (need & 1) !== 0, skew = need & 2 ? -0.25 : 0;
  // fake bold changes the measured width
  const tp = tv.tp;
  if (tp.fakeBold === fakeBold && tp.textSkewX === skew) return;
  yield vcall(tv.paintT, "setFakeBoldText", "(Z)V", +fakeBold);
  yield vcall(tv.paintT, "setTextSkewX", "(F)V", skew);
  if (hasLayout(tv)) yield relayout(tv);
});
const applyTvStyle = driven(function* applyTvStyle(tv: JTextView, set: JAttrSet | null, defStyleAttr: number, defStyleRes: number = 0): Gen {
  const res = tv.jres;
  if (!res) return;
  const ids = [
    tvAttr.text, tvAttr.textSize, tvAttr.textColor, tvAttr.textStyle, tvAttr.textAppearance,
    tvAttr.hint, tvAttr.gravity, tvAttr.maxLines, tvAttr.singleLine, tvAttr.ellipsize,
    tvAttr.drawableLeft, tvAttr.drawableTop, tvAttr.drawableRight, tvAttr.drawableBottom,
    tvAttr.drawablePadding, tvAttr.fontFamily, tvAttr.textAllCaps, tvAttr.textColorHint,
    tvAttr.inputType, tvAttr.lineSpacingExtra, tvAttr.lineSpacingMultiplier, tvAttr.lines,
    tvAttr.drawableStart, tvAttr.drawableEnd, tvAttr.minLines,
    tvAttr.ems, tvAttr.minEms, tvAttr.minWidth, tvAttr.includeFontPadding, tvAttr.imeOptions,
    tvAttr.shadowColor, tvAttr.shadowDx, tvAttr.shadowDy, tvAttr.shadowRadius, tvAttr.textColorLink, tvAttr.textCursorDrawable, tvAttr.password, tvAttr.maxLength,
  ];
  const ta = obtainStyled(res, tv.theme, set, ids, defStyleAttr, defStyleRes);
  const g = (i: number) => ta.vals[i];
  const taRef = g(4);
  if (taRef && taRef.t === TV.REFERENCE) yield applyTextAppearance(tv, res, taRef.d);
  if (g(1)) tv.tp.textSize = rvDimen(res, g(1), tv.tp.textSize);
  if (g(2)) tv.colors = yield rvColors(res, g(2)!, tv.theme, -16777216);
  if (g(3)) tv.styleBits = rvInt(res, g(3), tv.styleBits);
  const maxLength = g(37) ? rvInt(res, g(37), -1) : -1;
  if (maxLength >= 0) tv.filters = [yield newObj("android/text/InputFilter$LengthFilter", "(I)V", maxLength)];
  if (g(0)) {
    const v = g(0)!;
    const text = v.t === TV.REFERENCE ? rvString(res, res.resolveRefs(v)) ?? "" : rvString(res, v) ?? "";
    tv.text = tv.rawText = maxLength >= 0 ? yield csText(yield filterText(tv, text)) : text;
  }
  if (g(5)) {
    const v = g(5)!;
    tv.hint = (v.t === TV.REFERENCE ? rvString(res, res.resolveRefs(v)) : rvString(res, v)) ?? "";
  }
  if (g(6)) tv.gravityT = rvInt(res, g(6), tv.gravityT);
  if (g(7)) tv.maxLinesV = rvInt(res, g(7), 0) || Infinity;
  if (g(21)) { const n = rvInt(res, g(21), 0); if (n > 0) { tv.maxLinesV = n; tv.minLinesV = n; } }
  if (g(24)) tv.minLinesV = rvInt(res, g(24), 1);
  if (g(25) || g(26)) tv.minW = Math.max(tv.minW, Math.round(rvInt(res, (g(25) ?? g(26))!, 0) * tv.tp.textSize));
  if (g(27)) tv.minW = Math.max(tv.minW, Math.round(rvDimen(res, g(27), 0)));
  if (g(8)) tv.singleLine = !!rvInt(res, g(8), 0);
  if (g(9)) tv.ellipsizeEnd = rvInt(res, g(9), 0) === 3;
  const dl = g(10) ?? g(22), dt = g(11), dr = g(12) ?? g(23), db = g(13);
  if (dl) tv.drawableL = yield loadDrawableRV(res, dl, tv.theme);
  if (dt) tv.drawableT = yield loadDrawableRV(res, dt, tv.theme);
  if (dr) tv.drawableR = yield loadDrawableRV(res, dr, tv.theme);
  if (db) tv.drawableB = yield loadDrawableRV(res, db, tv.theme);
  if (dl || dt || dr || db) yield setIntrinsicDrawables.call(tv, tv.drawableL, tv.drawableT, tv.drawableR, tv.drawableB);
  if (g(14)) tv.drawablePad = Math.round(rvDimen(res, g(14), 0));
  yield applyFontFamily(tv, res, g(15));
  if (g(16)) { tv.allCaps = !!rvInt(res, g(16), 0); tv.capsSet = true; }
  if (g(17)) tv.hintColors = yield rvColors(res, g(17)!, tv.theme, 1627389952);
  if (g(18)) tv.inputTypeV = rvInt(res, g(18), 1);
  if (isPasswordType(tv.inputTypeV) || rvInt(res, g(36), 0)) yield setTransformation(tv, yield passwordMethod());
  if (g(19)) tv.lineSpacingExtra = rvDimen(res, g(19), 0);
  if (g(20)) tv.lineSpacingMult = g(20)!.t === TV.FLOAT ? g(20)!.d : 1;
  if (g(28)) tv.includePad = !!rvInt(res, g(28), 1);
  // the action the IME key performs: a search field declares it here and nowhere else
  if (g(29)) tv.imeOptions = rvInt(res, g(29), 0);
  if (g(30) || g(31) || g(32) || g(33)) yield setTextShadow.call(tv, rvFloat(res, g(33), tv.shadowRadius), rvFloat(res, g(31), tv.shadowDx), rvFloat(res, g(32), tv.shadowDy), rvColor(res, g(30), tv.shadowColor));
  const link = g(34);
  if (link) {
    tv.linkColors = yield rvColors(res, link, tv.theme, linkColor(tv.paintT));
    yield tv.updateLinkColor();
  }
  const cursor = g(35);
  if (cursor?.t === TV.REFERENCE) tv.cursorDrawableRes = cursor.d;
  yield setStyledTypeface(tv, paintTypeface(tv.paintT), tv.styleBits);
});
const textCursorDrawable = driven(function* textCursorDrawable(tv: JTextView): Gen<JDrawable | null> {
  if (tv.cursorDrawableRes && tv.jres) {
    tv.cursorDrawable = yield loadDrawable(tv.jres, tv.cursorDrawableRes, tv.theme);
    tv.cursorDrawableRes = 0;
  }
  return tv.cursorDrawable;
});
function redraw(tv: JTextView): unknown { return vcall(tv, "invalidate", "()V"); }
/** AOSP's mLayout != null: measured since the text last changed */
const hasLayout = (tv: JTextView) => tv.layoutWidthFor >= 0;
const setTextShadow = driven(function* setTextShadow(this: JTextView, radius: number, dx: number, dy: number, color: number): Gen {
  this.shadowRadius = radius; this.shadowDx = dx; this.shadowDy = dy; this.shadowColor = color;
  yield vcall(this.paintT, "setShadowLayer", "(FFFI)V", radius, dx, dy, color);
  yield redraw(this);
});
function setTextAppearance(this: JTextView, id: number) {
  return this.jres ? applyTextAppearance(this, this.jres, id) : undefined;
}
/** a TextView subclass's constructors: attach to the context, apply the widget's default style (or
 *  the caller's), then `then` reads what the subclass adds under the same style */
export function textViewCtors<T extends JTextView>(styleAttr: string, then?: (v: T, set: JAttrSet | null, dsa: number, dsr: number) => unknown): NativeSpec["methods"] {
  const init = async (v: T, c: unknown, set: JAttrSet | null, dsa = 0, dsr = 0) => {
    const style = dsa || (dsr || !styleAttr ? 0 : AID(styleAttr));
    await initViewFromCtx(v, c, set, style, dsr);
    await applyTvStyle(v, set, style, dsr);
    // AOSP's constructor ends with setText(text, bufferType): an editor's text becomes its Editable
    if (v.editable) await vcall(v, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", v.rawText, bufferTypes[2]);
    await then?.(v, set, style, dsr);
  };
  return {
    "<init>(Landroid/content/Context;)V": function (this: T, c: unknown) { return init(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: T, c: unknown, set: JAttrSet | null) { return init(this, c, set); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: T, c: unknown, set: JAttrSet | null, dsa: number) { return init(this, c, set, dsa); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;II)V": function (this: T, c: unknown, set: JAttrSet | null, dsa: number, dsr: number) { return init(this, c, set, dsa, dsr); },
  };
}
const passwordMethod = () => scall("android/text/method/PasswordTransformationMethod", "getInstance", "()Landroid/text/method/PasswordTransformationMethod;");
/** TextView.isPasswordInputType: text password, web password or number password */
const isPasswordType = (t: number) => { const v = t & 0xfff; return v === 0x81 || v === 0xe1 || v === 0x12; };
/** AOSP setTransformationMethod: a new method re-lays the text out through it */
const setTransformation = driven(function* setTransformation(tv: JTextView, m: unknown): Gen {
  if (tv.transformation === m) return;
  tv.transformation = m;
  yield tv.retransform();
  tv.layoutWidthFor = -1;
  requestLayout(tv); invalidate(tv);
});
/** AOSP setRawTextSize: only a size that differs asks for layout */
function setRawTextSize(tv: JTextView, px: number) {
  if (tv.tp.textSize === px) return;
  tv.tp.textSize = px;
  requestLayout(tv);
}
/** a drawable drawn with its bounds' origin at (x, y) */
function* drawAt$(cv: JavaCanvas, d: JDrawable, x: number, y: number): Gen {
  const ctx = canvasOf(cv).ctx;
  ctx.save(); ctx.translate(Math.trunc(x), Math.trunc(y));
  try { yield drawChild(d, cv); }
  finally { ctx.restore(); }
}
export const textViewMethods: NonNullable<NativeSpec["methods"]> = {
  ...textViewCtors("textViewStyle"),
  ...compoundDrawableMethods,
  // AOSP routes every setText through the two-arg form, and that is the one apps override:
  // Material's Chip hands the text to its ChipDrawable there and nowhere else, and without it
  // the drawable measures itself with no text at all.
  "setText(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) {
    return vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", cs, bufferTypes[0]);
  },
  "setTextKeepState(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) {
    return vcall(this, "setTextKeepState", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", cs, bufferTypes[0]);
  },
  "setTextKeepState(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V": driven(function* (this: JTextView, cs: unknown, type: unknown): Gen {
    const start: number = yield selectionStart(this.rawText), end: number = yield selectionEnd(this.rawText), length: number = yield csLength(cs ?? "");
    yield vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", cs, type);
    if ((start >= 0 || end >= 0) && isSpannable(this.rawText))
      yield setSelection(this.rawText, Math.max(0, Math.min(start, length)), Math.max(0, Math.min(end, length)));
  }),
  "setText(I)V": driven(function* (this: JTextView, id: number): Gen {
    const s = this.jres ? resString(this.jres, id) : "";
    yield guardCall(this, mangleMethod("setText", "(Ljava/lang/CharSequence;)V"), s);
  }),
  // AOSP: the filters, then the buffer the type asks for (an Editable for an editor, a key listener
  // or listeners to tell, a Spannable for SPANNABLE or a movement method, else a String or
  // SpannedString copy), a ChangeWatcher on Spannable text, and the listeners told around it
  "setText(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V": driven(function* (this: JTextView, cs: unknown, type: unknown): Gen {
    if (cs == null) cs = "";
    if (this.filters.length) cs = yield filterText(this, cs);
    const notify = this.watchers.length > 0, oldLength = this.text.length;
    if (notify) yield* this.sendTextEvent$("beforeTextChanged", this.rawText, 0, oldLength, yield csLength(cs));
    if (type === bufferTypes[2] || this.editable || this.keyListener || notify) {
      cs = yield this.editableFactory ? vcall(this.editableFactory, "newEditable", "(Ljava/lang/CharSequence;)Landroid/text/Editable;", cs)
        : newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", cs);
      if (this.filters.length) yield vcall(cs, "setFilters", "([Landroid/text/InputFilter;)V", jarray([...this.filters], "Landroid/text/InputFilter;"));
    } else if (type === bufferTypes[1] || this.movementMethod) {
      cs = yield this.spannableFactory ? vcall(this.spannableFactory, "newSpannable", "(Ljava/lang/CharSequence;)Landroid/text/Spannable;", cs)
        : newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", cs);
    } else if (typeof cs !== "string") cs = yield scall("android/text/TextUtils", "stringOrSpannedString", "(Ljava/lang/CharSequence;)Ljava/lang/CharSequence;", cs);
    const spanned = typeof cs !== "string" || typeof this.rawText !== "string";
    this.rawText = cs;
    const text: string = yield csText(cs);
    if (isSpannable(cs)) yield watchText(this, cs, text.length);
    invalidate(this);
    if (text !== this.text || spanned) yield* this.textChanged$(text);
    if (notify) {
      yield* this.sendTextEvent$("onTextChanged", cs, 0, oldLength, text.length);
      yield* this.sendAfterTextChanged$(cs);
    }
  }),
  "append(Ljava/lang/CharSequence;)V": driven(function* (this: JTextView, cs: unknown): Gen {
    yield vcall(this, "append", "(Ljava/lang/CharSequence;II)V", cs, 0, yield csLength(cs));
  }),
  // AOSP turns the text into an Editable and appends to it in place
  "append(Ljava/lang/CharSequence;II)V": driven(function* (this: JTextView, cs: unknown, start: number, end: number): Gen {
    if (!isEditable(this.rawText)) yield vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", this.rawText, bufferTypes[2]);
    yield vcall(this.rawText, "append", "(Ljava/lang/CharSequence;II)Landroid/text/Editable;", cs, start, end);
  }),
  "getText()Ljava/lang/CharSequence;": function (this: JTextView) {
    return this.editable ? this.getEditable() : this.rawText;
  },
  "length()I": function (this: JTextView) { return this.text.length; },
  // AOSP's checkForRelayout: an empty view measures its hint, so a new one can change the size
  "setHint(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) {
    return after(csText(cs), (hint) => { this.hint = hint; requestLayout(this); });
  },
  "setHint(I)V": function (this: JTextView, id: number) {
    this.hint = this.jres ? resString(this.jres, id) : "";
    requestLayout(this);
  },
  "getHint()Ljava/lang/CharSequence;": function (this: JTextView) { return this.hint; },
  "setTextSize(F)V": function (this: JTextView, sp: number) { return vcall(this, "setTextSize", "(IF)V", 2, sp); },
  "setTextSize(IF)V": function (this: JTextView, unit: number, v: number) {
    setRawTextSize(this, unit === 1 || unit === 2 ? v * device.density : v); // COMPLEX_UNIT_DIP / SP
  },
  "getTextSize()F": function (this: JTextView) { return this.tp.textSize; },
  "setTextColor(I)V": function (this: JTextView, c: number) { this.colors = c; invalidate(); },
  "setTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, c: JColorStateList) {
    if (c) this.colors = c;
    invalidate();
  },
  "setLinkTextColor(I)V": function (this: JTextView, color: number) { this.linkColors = color; return this.updateLinkColor(); },
  "setLinkTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, colors: JColorStateList | null) { this.linkColors = colors; return this.updateLinkColor(); },
  "getLinkTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return colorList(this.linkColors); },
  "drawableStateChanged()V": function (this: JTextView) { return after(this.updateLinkColor(), () => syncCompoundStates(this, true)); },
  "getTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return colorList(this.colors); },
  "getCurrentTextColor()I": function (this: JTextView) { return colorFor(this.colors, this.drawableState()); },
  "setHintTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, c: JColorStateList | null) { this.hintColors = c; invalidate(this); },
  "setHintTextColor(I)V": function (this: JTextView, c: number) { this.hintColors = c; invalidate(this); },
  "setGravity(I)V": function (this: JTextView, g: number) {
    if (this.gravityT === g) return;
    this.gravityT = g;
    return redraw(this);
  },
  "getGravity()I": function (this: JTextView) { return this.gravityT; },
  "setTypeface(Landroid/graphics/Typeface;)V": function (this: JTextView, t: object | null) {
    if (paintTypeface(this.paintT) === t) return;
    return after(setPaintTypeface(this.paintT, t), () => hasLayout(this) ? relayout(this) : undefined);
  },
  "setTypeface(Landroid/graphics/Typeface;I)V": function (this: JTextView, t: object | null, style: number) { return setStyledTypeface(this, t, style); },
  "getTypeface()Landroid/graphics/Typeface;": function (this: JTextView) { return paintTypeface(this.paintT); },
  "getPaint()Landroid/text/TextPaint;": function (this: JTextView) { return this.paintT; },

  "setSingleLine()V": function (this: JTextView) { return vcall(this, "setSingleLine", "(Z)V", 1); },
  "setSingleLine(Z)V": function (this: JTextView, v: number) { this.singleLine = !!v; requestLayout(this); },
  "setMaxLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n; this.maxH = Infinity; return relayout(this); },
  "getMaxLines()I": function (this: JTextView) { return Number.isFinite(this.maxLinesV) ? this.maxLinesV : 0x7fffffff; },
  "setMinLines(I)V": function (this: JTextView, n: number) { this.minLinesV = n; this.minH = 0; return relayout(this); },
  "setLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n; this.maxH = Infinity; this.minLinesV = n; this.minH = 0; return relayout(this); },
  "setEllipsize(Landroid/text/TextUtils$TruncateAt;)V": function (this: JTextView, e: { ord: number } | null) {
    const end = e !== null && enumOrdinal(e) === 2;
    if (this.ellipsizeEnd !== end) { this.ellipsizeEnd = end; return relayout(this); }
  },
  "setAllCaps(Z)V": function (this: JTextView, v: number) { this.allCaps = !!v; this.capsSet = true; requestLayout(this); },
  "setLineSpacing(FF)V": function (this: JTextView, extra: number, mult: number) {
    this.lineSpacingExtra = extra; this.lineSpacingMult = mult;
    return relayout(this);
  },
  "setLetterSpacing(F)V": function (this: JTextView, v: number) {
    if (this.tp.letterSpacingEm !== v) { this.tp.letterSpacingEm = v; return relayout(this); }
  },
  "setIncludeFontPadding(Z)V": function (this: JTextView, on: number) { this.includePad = !!on; return relayout(this); },
  // fallback-font line spacing only changes metrics where a glyph comes from a fallback font, which one system font never does here
  "setFallbackLineSpacing(Z)V": function (this: JTextView, on: number) {
    if (this.fallbackLineSpacing === !!on) return;
    this.fallbackLineSpacing = !!on;
    if (hasLayout(this)) return relayout(this);
  },
  // API 33 line-break tuning: the ICU break iterator here has one style, so the values are only kept
  "setLineBreakStyle(I)V": function (this: JTextView, v: number) {
    if (this.lineBreakStyle === v) return;
    this.lineBreakStyle = v;
    if (hasLayout(this)) return relayout(this);
  },
  "getLineBreakStyle()I": function (this: JTextView) { return this.lineBreakStyle; },
  "setLineBreakWordStyle(I)V": function (this: JTextView, v: number) {
    if (this.lineBreakWordStyle === v) return;
    this.lineBreakWordStyle = v;
    if (hasLayout(this)) return relayout(this);
  },
  "getLineBreakWordStyle()I": function (this: JTextView) { return this.lineBreakWordStyle; },
  "isFallbackLineSpacing()Z": function (this: JTextView) { return this.fallbackLineSpacing ? 1 : 0; },
  "setTextAppearance(Landroid/content/Context;I)V": function (this: JTextView, c: unknown, id: number) { return setTextAppearance.call(this, id); },
  "setTextAppearance(I)V": function (this: JTextView, id: number) {
    return vcall(this, "setTextAppearance", "(Landroid/content/Context;I)V", this.ctx, id);
  },
  // AOSP: the text is set again through the new factory
  "setEditableFactory(Landroid/text/Editable$Factory;)V": function (this: JTextView, factory: unknown) {
    this.editableFactory = factory;
    return vcall(this, "setText", "(Ljava/lang/CharSequence;)V", this.rawText);
  },
  "setSpannableFactory(Landroid/text/Spannable$Factory;)V": function (this: JTextView, factory: unknown) {
    this.spannableFactory = factory;
    return vcall(this, "setText", "(Ljava/lang/CharSequence;)V", this.rawText);
  },
  "addTextChangedListener(Landroid/text/TextWatcher;)V": function (this: JTextView, w: unknown) { this.watchers.push(w); },
  "removeTextChangedListener(Landroid/text/TextWatcher;)V": function (this: JTextView, w: unknown) {
    removeFrom(this.watchers, w);
  },
  // AOSP: a password type masks through PasswordTransformationMethod, leaving one unmasks
  "setInputType(I)V": driven(function* (this: JTextView, t: number): Gen {
    this.inputTypeV = t;
    if (isPasswordType(t)) return setTransformation(this, yield passwordMethod());
    if (this.transformation && rt.iof(this.transformation, "android/text/method/PasswordTransformationMethod")) return setTransformation(this, null);
  }),
  "getInputType()I": function (this: JTextView) { return this.inputTypeV; },
  "setImeOptions(I)V": function (this: JTextView, o: number) { this.imeOptions = o; },
  "setShowSoftInputOnFocus(Z)V": function (this: JTextView, enabled: number) {
    this.showSoftInputOnFocus = !!enabled;
    if (this === focusedEdit && inputEl) {
      if (enabled) inputEl.focus(); else inputEl.blur();
    }
  },
  "getShowSoftInputOnFocus()Z": function (this: JTextView) { return this.showSoftInputOnFocus ? 1 : 0; },
  "getImeOptions()I": function (this: JTextView) { return this.imeOptions; },
  "setPrivateImeOptions(Ljava/lang/String;)V": function (this: JTextView, options: string | null) { this.privateImeOptions = options; },
  "getPrivateImeOptions()Ljava/lang/String;": function (this: JTextView) { return this.privateImeOptions; },
  "setKeyListener(Landroid/text/method/KeyListener;)V": function (this: JTextView, l: unknown) { this.keyListener = l; },
  "getKeyListener()Landroid/text/method/KeyListener;": function (this: JTextView) { return this.keyListener; },
  // AOSP: the text becomes Spannable for the method, and the view focusable and clickable
  // (fixFocusableAndClickableSettings)
  "setMovementMethod(Landroid/text/method/MovementMethod;)V": driven(function* (this: JTextView, m: unknown): Gen {
    if (this.movementMethod === m) return;
    this.movementMethod = m;
    if (!m) return;
    if (!this.editable && this.rawText != null && !rt.iof(this.rawText, "android/text/Spannable"))
      yield vcall(this, "setText", "(Ljava/lang/CharSequence;)V", this.rawText);
    yield vcall(this, "setFocusable", "(Z)V", 1);
    yield vcall(this, "setClickable", "(Z)V", 1);
    yield vcall(this, "setLongClickable", "(Z)V", 1);
  }),
  // LinkMovementMethod hides the selection toolbar; this TextView shows none
  "hideFloatingToolbar(I)V": () => {},
  // AOSP: the view's own handling first, then the movement method's over the Spannable text
  "onTouchEvent(Landroid/view/MotionEvent;)Z": driven(function* (this: JTextView, ev: unknown): Gen {
    const handled = yield (JView.prototype as unknown as Record<string, (e: unknown) => unknown>)[M_onTouchEvent].call(this, ev);
    const text = this.rawText;
    if (this.movementMethod && this.enabled && this.layout && isSpannable(text)
      && (yield vcall(this.movementMethod, "onTouchEvent", "(Landroid/widget/TextView;Landroid/text/Spannable;Landroid/view/MotionEvent;)Z", this, text, ev))) return 1;
    return handled;
  }),
  "getMovementMethod()Landroid/text/method/MovementMethod;": function (this: JTextView) { return this.movementMethod; },
  "getDefaultMovementMethod()Landroid/text/method/MovementMethod;": () => null,
  "getHintTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return colorList(this.hintColors); },
  "getLineSpacingExtra()F": function (this: JTextView) { return this.lineSpacingExtra; },
  "getLineSpacingMultiplier()F": function (this: JTextView) { return this.lineSpacingMult; },
  "getMinLines()I": function (this: JTextView) { return this.minLinesV; },
  "getMinWidth()I": function (this: JTextView) { return this.minW; },
  "getMinHeight()I": function (this: JTextView) { return this.minH; },
  "getLetterSpacing()F": function (this: JTextView) { return this.tp.letterSpacingEm; },
  "setBreakStrategy(I)V": function (this: JTextView, b: number) { this.breakStrategy = b; if (hasLayout(this)) return relayout(this); },
  "getBreakStrategy()I": function (this: JTextView) { return this.breakStrategy; },
  "setHyphenationFrequency(I)V": function (this: JTextView, h: number) { this.hyphenation = h; if (hasLayout(this)) return relayout(this); },
  "getHyphenationFrequency()I": function (this: JTextView) { return this.hyphenation; },
  "setHeight(I)V": function (this: JTextView, h: number) {
    this.minH = this.maxH = h; this.minLinesV = 0; this.maxLinesV = Infinity; return relayout(this);
  },
  "setMaxHeight(I)V": function (this: JTextView, h: number) { this.maxH = h; this.maxLinesV = Infinity; return relayout(this); },
  "getMaxHeight()I": function (this: JTextView) { return Number.isFinite(this.maxH) ? this.maxH : -1; },
  "setWidth(I)V": function (this: JTextView, w: number) { this.minW = w; this.maxW = w; return relayout(this); },
  "setMinEms(I)V": function (this: JTextView, ems: number) { this.minW = Math.round(ems * this.tp.textSize); return relayout(this); },
  "setMaxEms(I)V": function (this: JTextView) { return relayout(this); },
  "setRawInputType(I)V": function (this: JTextView, t: number) { this.inputTypeV = t; },
  "setLinksClickable(Z)V": function (this: JTextView, v: number) { this.linksClickable = !!v; },
  "getLinksClickable()Z": function (this: JTextView) { return this.linksClickable ? 1 : 0; },
  "getTextLocale()Ljava/util/Locale;": function (this: JTextView) { return vcall(this.paintT, "getTextLocale", "()Ljava/util/Locale;"); },
  "setFontVariationSettings(Ljava/lang/String;)Z": function (this: JTextView, s: string | null) {
    const changed = this.fontVariation !== s;
    this.fontVariation = s;
    return changed && hasLayout(this) ? after(relayout(this), () => 1) : 1;
  },
  "getFontVariationSettings()Ljava/lang/String;": function (this: JTextView) { return this.fontVariation; },
  "setCustomSelectionActionModeCallback(Landroid/view/ActionMode$Callback;)V": function (this: JTextView, cb: unknown) { this.selActionMode = cb; },
  "getCustomSelectionActionModeCallback()Landroid/view/ActionMode$Callback;": function (this: JTextView) { return this.selActionMode; },
  "setCustomInsertionActionModeCallback(Landroid/view/ActionMode$Callback;)V": function (this: JTextView, cb: unknown) { this.insertionActionMode = cb; },
  "getCustomInsertionActionModeCallback()Landroid/view/ActionMode$Callback;": function (this: JTextView) { return this.insertionActionMode; },
  "onCheckIsTextEditor()Z": function (this: JTextView) { return this.editable ? 1 : 0; },
  // AOSP: an explicit line height is applied as extra spacing over the font's own line height
  "setLineHeight(I)V": function (this: JTextView, h: number) { this.lineSpacingMult = 1; this.lineSpacingExtra = h - this.lineHeight() + this.lineSpacingExtra; requestLayout(this); },
  "setLineHeight(IF)V": function (this: JTextView, unit: number, h: number) {
    const px = unit === 1 || unit === 2 ? h * device.density : h;
    this.lineSpacingMult = 1; this.lineSpacingExtra = px - this.lineHeight() + this.lineSpacingExtra; requestLayout(this);
  },
  "setFirstBaselineToTopHeight(I)V": function (this: JTextView, h: number) {
    return vcall(this, "setPadding", "(IIII)V", this.padL, Math.max(0, h - this.ascent()), this.padR, this.padB);
  },
  "setLastBaselineToBottomHeight(I)V": function (this: JTextView, h: number) {
    return vcall(this, "setPadding", "(IIII)V", this.padL, this.padT, this.padR, Math.max(0, h - Math.round(fontDescent(this.tp))));
  },
  // auto-size is never active: AUTO_SIZE_TEXT_TYPE_NONE and the "unset" -1 sizes, as AOSP reports.
  // A uniform type still invalidates where AOSP's setup would succeed: not in an EditText.
  "setAutoSizeTextTypeWithDefaults(I)V": function (this: JTextView, t: number) { this.autoSizeType = t; if (t === 1 && !this.editable) return redraw(this); },
  "setAutoSizeTextTypeUniformWithConfiguration(IIII)V": function (this: JTextView) { this.autoSizeType = 1; if (!this.editable) return redraw(this); },
  "setAutoSizeTextTypeUniformWithPresetSizes([II)V": function (this: JTextView) { this.autoSizeType = 1; if (!this.editable) return redraw(this); },
  "getAutoSizeTextType()I": function (this: JTextView) { return this.autoSizeType; },
  "getAutoSizeTextAvailableSizes()[I": () => new Int32Array(0),
  "setTransformationMethod(Landroid/text/method/TransformationMethod;)V": function (this: JTextView, m: unknown) { return setTransformation(this, m); },
  "getTransformationMethod()Landroid/text/method/TransformationMethod;": function (this: JTextView) { return this.transformation; },
  "setTextCursorDrawable(I)V": driven(function* (this: JTextView, id: number): Gen {
    const drawable = id ? yield vcall(this.ctx, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;", id) : null;
    yield vcall(this, "setTextCursorDrawable", "(Landroid/graphics/drawable/Drawable;)V", drawable);
  }),
  "setTextCursorDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JTextView, drawable: JDrawable | null) {
    this.cursorDrawableRes = 0; this.cursorDrawable = drawable; invalidate(this);
  },
  "getTextCursorDrawable()Landroid/graphics/drawable/Drawable;": function (this: JTextView) { return textCursorDrawable(this); },
  "setCursorVisible(Z)V": function (this: JTextView, v: number) { this.cursorVisible = !!v; },
  "setOnEditorActionListener(Landroid/widget/TextView$OnEditorActionListener;)V": function (this: JTextView, l: unknown) { this.editorActionL = l; },
  "setFilters([Landroid/text/InputFilter;)V": function (this: JTextView, arr: unknown[] | null) {
    this.filters = arr ?? [];
    if (isEditable(this.rawText)) return vcall(this.rawText, "setFilters", "([Landroid/text/InputFilter;)V", jarray([...this.filters], "Landroid/text/InputFilter;"));
  },
  "getFilters()[Landroid/text/InputFilter;": function (this: JTextView) { return jarray(this.filters ?? [], "Landroid/text/InputFilter;"); },
  "setMaxWidth(I)V": function (this: JTextView, w: number) { this.maxW = w; return relayout(this); },
  // AOSP: an unbounded maximum reads back as Integer.MAX_VALUE, and callers Math.min() with it
  "getMaxWidth()I": function (this: JTextView) { return Number.isFinite(this.maxW) ? this.maxW : 0x7fffffff; },
  // AOSP: null until the first measure; afterwards the Layout over the measured text width
  "getLayout()Landroid/text/Layout;": function (this: JTextView) {
    return this.layoutWidthFor < 0 ? null : this.layout?.java ?? null;
  },
  "getLineBounds(ILandroid/graphics/Rect;)I": driven(function* (this: JTextView, i: number, r: JRect): Gen {
    const left: number = yield vcall(this, "getCompoundPaddingLeft", "()I");
    if (!this.layout) {
      const lh = this.lineHeight();
      r.left = left; r.right = Math.max(left, this.width() - this.padR); r.top = this.padT + i * lh; r.bottom = r.top + lh;
      return r.top + this.ascent();
    }
    const baseline: number = yield vcall(this.layout.java, "getLineBounds", "(ILandroid/graphics/Rect;)I", i, r);
    r.left += left; r.right += left; r.top += this.padT; r.bottom += this.padT;
    return baseline + this.padT;
  }),
  "setShadowLayer(FFFI)V": setTextShadow,
  "getShadowRadius()F": function (this: JTextView) { return this.shadowRadius; },
  "getShadowDx()F": function (this: JTextView) { return this.shadowDx; },
  "getShadowDy()F": function (this: JTextView) { return this.shadowDy; },
  "getShadowColor()I": function (this: JTextView) { return this.shadowColor; },
  "setMinWidth(I)V": function (this: JTextView, w: number) { this.minW = w; return relayout(this); },
  ...noops("setImeHintLocales(Landroid/os/LocaleList;)V", "beginBatchEdit()V",
    "endBatchEdit()V", "setMarqueeRepeatLimit(I)V",
    "setError(Ljava/lang/CharSequence;)V", "setAutoLinkMask(I)V"),
  "setTextLocales(Landroid/os/LocaleList;)V": function (this: JTextView) { if (hasLayout(this)) return relayout(this); },
  "setHighlightColor(I)V": function (this: JTextView, color: number) {
    if (this.highlightColor === color) return;
    this.highlightColor = color;
    return redraw(this);
  },
  "setHorizontallyScrolling(Z)V": function (this: JTextView, on: number) {
    if (this.horizontallyScrolling === !!on) return;
    this.horizontallyScrolling = !!on;
    if (hasLayout(this)) return relayout(this);
  },
  "isHorizontallyScrollable()Z": function (this: JTextView) { return this.horizontallyScrolling ? 1 : 0; },
  // AOSP makes the text Spannable so the selection can live in it
  "setSelectAllOnFocus(Z)V": function (this: JTextView, on: number) {
    const text = this.rawText;
    if (on && !isSpannable(text))
      return vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", text, bufferTypes[1]);
  },
  // AOSP also makes the focus FOCUSABLE_AUTO and installs ArrowKeyMovementMethod, which have no counterpart here
  "setTextIsSelectable(Z)V": driven(function* (this: JTextView, on: number): Gen {
    if (this.textSelectable === !!on) return;
    this.textSelectable = !!on;
    yield vcall(this, "setFocusableInTouchMode", "(Z)V", on);
    yield vcall(this, "setClickable", "(Z)V", on);
    yield vcall(this, "setLongClickable", "(Z)V", on);
    const text = this.rawText;
    yield vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", text, bufferTypes[on ? 1 : 0]);
  }),
  "isTextSelectable()Z": function (this: JTextView) { return this.textSelectable ? 1 : 0; },
  "getIncludeFontPadding()Z": function (this: JTextView) { return +this.includePad; },
  ...stubs(-1, "getAutoSizeMinTextSize()I", "getAutoSizeMaxTextSize()I", "getAutoSizeStepGranularity()I"),
  "setMinHeight(I)V": function (this: JTextView, h: number) { this.minH = h; return relayout(this); },
  "setEms(I)V": function (this: JTextView, ems: number) { this.minW = Math.round(ems * this.tp.textSize); return relayout(this); },
  "setPaintFlags(I)V": function (this: JTextView, f: number) {
    if (this.tp.flags === f) return;
    return after(vcall(this.paintT, "setFlags", "(I)V", f), () => hasLayout(this) ? relayout(this) : redraw(this));
  },
  "getPaintFlags()I": function (this: JTextView) { return vcall(this.paintT, "getFlags", "()I"); },
  "getLineHeight()I": function (this: JTextView) { return this.lineHeight(); },
  "getLineCount()I": function (this: JTextView) { return this.layout?.lines ?? 0; },
  "getBaseline()I": function (this: JTextView) {
    return this.layout ? after(vcall(this.layout.java, "getLineBaseline", "(I)I", 0), (b: number) => this.padT + b) : this.padT + this.ascent();
  },
  "getEditableText()Landroid/text/Editable;": function (this: JTextView) { return isEditable(this.rawText) ? this.rawText : null; },
  "setEnabled(Z)V": function (this: JTextView, e: number) { this.enabled = !!e; void this.refreshDrawableState(); },
  // TextView.onMeasure: a wrapping width is the text's desired width, the layout is built at the
  // width the view gets, and its height is that layout's, at least minLines tall
  "onMeasure(II)V": driven(function* (this: JTextView, wSpec: number, hSpec: number): Gen {
    const thread = curThread;
    const wMode = specMode(wSpec), wSize = specSize(wSpec);
    const pads = compoundPads(this);
    const [padL, padT, padR, padB] = pads instanceof Promise ? yield pads : pads;
    const hPad = padL + padR, vPad = padT + padB;
    let w: number;
    if (wMode === MS_EXACTLY) w = wSize;
    else {
      const layouts = this.textLayouts ??= new TextViewLayouts();
      let desired: number = yield layouts.desiredWidth(this, this.shownText());
      if (!this.text && this.hint) desired = Math.max(desired, yield (this.hintLayouts ??= new TextViewLayouts()).desiredWidth(this, this.hint));
      w = Math.max(desired, compoundWidth(this.drawableT), compoundWidth(this.drawableB)) + hPad;
      const min = vcallOn(thread, this, "getSuggestedMinimumWidth", "()I");
      w = Math.max(Math.min(Math.max(w, this.minW), this.maxW), Number(min instanceof Promise ? yield min : min));
      if (wMode === MS_AT_MOST) w = Math.min(w, wSize);
    }
    const measured = this.measuredLines(w - hPad);
    this.layout = measured instanceof Promise ? yield measured : measured;
    const layout = this.layout!;
    let h = layout.height + vPad;
    if (layout.lines < this.minLinesV) h += this.lineHeight() * (this.minLinesV - layout.lines);
    h = Math.min(h, this.maxH);
    const sidePad = this.padT + this.padB;
    h = Math.max(h, this.minH, compoundHeight(this.drawableL) + sidePad, compoundHeight(this.drawableR) + sidePad);
    if (specMode(hSpec) !== MS_EXACTLY) {
      const min = vcallOn(thread, this, "getSuggestedMinimumHeight", "()I");
      h = Math.max(h, Number(min instanceof Promise ? yield min : min));
    }
    this.measuredW = w;
    this.measuredH = resolveSize(h, hSpec);
    this.layoutWidthFor = w;
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JTextView, cv: JavaCanvas): Gen {
    if (this.width() <= 0 || this.height() <= 0) return;
    const thread = curThread, ctx = canvasOf(cv).ctx;
    const display = this.text;
    const resolved = vcallOn(thread, this, "getTextAlignment", "()I");
    const alignment = Number(resolved instanceof Promise ? yield resolved : resolved);
    const direction = alignment === 5 || alignment === 6 ? vcallOn(thread, this, "getLayoutDirection", "()I") : 0;
    const layoutDirection = Number(direction instanceof Promise ? yield direction : direction);
    const hg = this.horizontalGravity(display || this.hint, alignment, layoutDirection);
    const showHint = !display && this.hint;
    const pads = compoundPads(this);
    const [contentL, padT, padR, padB] = pads instanceof Promise ? yield pads : pads;
    const avail = this.width() - padR - contentL, contentT = padT, contentB = this.height() - padB;
    this.align = hg as Align;
    if (this.layoutWidthFor !== this.width() || this.layout?.align !== hg) {
      this.layout = yield this.measuredLines(avail);
      this.layoutWidthFor = this.width();
    }
    if (this.drawableL) yield* drawAt$(cv, this.drawableL, this.padL, contentT + (contentB - contentT - compoundHeight(this.drawableL)) / 2);
    if (this.drawableR) yield* drawAt$(cv, this.drawableR, this.width() - this.padR - compoundWidth(this.drawableR), contentT + (contentB - contentT - compoundHeight(this.drawableR)) / 2);
    if (this.drawableT) yield* drawAt$(cv, this.drawableT, contentL + (avail - compoundWidth(this.drawableT)) / 2, this.padT);
    if (this.drawableB) yield* drawAt$(cv, this.drawableB, contentL + (avail - compoundWidth(this.drawableB)) / 2, this.height() - this.padB - compoundHeight(this.drawableB));
    const layout: TextViewLayout | null = showHint ? yield (this.hintLayouts ??= new TextViewLayouts()).get(this, this.hint, avail, hg) : this.layout;
    if (!layout) return;
    // TextView.getVerticalOffset
    const vg = gravityV(this.gravityT);
    const y = vg === 16 ? (contentB - contentT - layout.height) / 2 + contentT : vg === 80 ? contentB - layout.height : contentT;
    yield vcall(this.paintT, "setColor", "(I)V", yield colorFor(showHint ? this.hintColors ?? this.colors : this.colors, this.drawableState()));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.width(), this.height()); ctx.clip();
    ctx.translate(contentL, y);
    try { yield vcallOn(thread, layout.java, "draw", "(Landroid/graphics/Canvas;)V", cv); }
    finally { ctx.restore(); }
    // Editor places the caret by the text's own layout (mLayout), even while the hint shows
    const caret = this.layout;
    if (caret && this.editable && this.focused && this.cursorVisible && Math.floor((guestNow() - this.blinkStart) / 500) % 2 === 0) {
      const end = this.text.length, line: number = yield vcallOn(thread, caret.java, "getLineForOffset", "(I)I", end);
      const cx: number = yield vcallOn(thread, caret.java, "getPrimaryHorizontal", "(I)F", end);
      const top = vg === 16 ? (contentB - contentT - caret.height) / 2 + contentT : vg === 80 ? contentB - caret.height : contentT;
      const cy = top + (yield vcallOn(thread, caret.java, "getLineBaseline", "(I)I", line));
      const cursor = yield textCursorDrawable(this);
      if (!cursor) return;
      const padding = new JRect();
      yield vcallOn(thread, cursor, "getPadding", "(Landroid/graphics/Rect;)Z", padding);
      const width = yield drawableSize(cursor, false, thread);
      const left = Math.min(Math.max(0, Math.trunc(cx - 0.5)) - padding.left, avail - width + padding.right);
      yield vcallOn(thread, cursor, "setBounds", "(IIII)V", 0, 0, width, this.lineHeight() + padding.top + padding.bottom);
      yield* drawAt$(cv, cursor, contentL + left, cy - this.ascent() - padding.top);
    }
  }),
};

rt.register({
  name: "android/widget/TextView", ctor: JTextView, sup: "android/view/View",
  methods: textViewMethods,
});
rt.markers("android/widget/TextView$OnEditorActionListener");
const bufferTypes = mkEnumSet("android/widget/TextView$BufferType", ["NORMAL", "SPANNABLE", "EDITABLE"]);

export class JButton extends JTextView {
  constructor() {
    super();
    this.gravityT = 17;
    this.clickable = true;
  }
}
rt.register({
  name: "android/widget/Button", ctor: JButton, sup: "android/widget/TextView",
  methods: {
    ...textViewMethods,
    ...textViewCtors<JButton>("buttonStyle", applyButtonDefaults),
  },
});
function applyButtonDefaults(b: JButton): void {
  b.clickable = true;
  // AOSP's Widget.Material.Button supplies these; they are DEFAULTS, not overrides. A style
  // that spoke for itself — every Material3 button is sentence-case with its own face — has
  // already run in applyTvStyle, and forcing them here undid it.
  if (!b.capsSet) b.allCaps = true;
  if (!paintTypeface(b.paintT)) setPaintTypeface(b.paintT, tfMedium);
}

export class JEditText extends JTextView {
  constructor() {
    super();
    this.editable = true;
    this.breakStrategy = 0;
    this.clickable = true;
    this.focusable = true;
    this.gravityT = 16 | G.START;
  }
}
rt.register({
  name: "android/widget/EditText", ctor: JEditText, sup: "android/widget/TextView",
  methods: {
    ...textViewMethods,
    ...textViewCtors<JEditText>("editTextStyle"),
    "getText()Landroid/text/Editable;": function (this: JEditText) { return this.getEditable(); },
    "getText()Ljava/lang/CharSequence;": function (this: JEditText) { return vcall(this, "getText", "()Landroid/text/Editable;"); },
    // no selection reads as the end, where this editor's caret is
    "getSelectionStart()I": driven(function* (this: JEditText): Gen { const start: number = yield selectionStart(yield this.getEditable()); return start >= 0 ? start : this.text.length; }),
    "getSelectionEnd()I": driven(function* (this: JEditText): Gen { const end: number = yield selectionEnd(yield this.getEditable()); return end >= 0 ? end : this.text.length; }),
    "setSelection(I)V": function (this: JEditText, index: number) {
      return after(vcall(this, "getText", "()Landroid/text/Editable;"), (text) => setSelection(text, index, index));
    },
    "setSelection(II)V": function (this: JEditText, start: number, end: number) {
      return after(vcall(this, "getText", "()Landroid/text/Editable;"), (text) => setSelection(text, start, end));
    },
    "selectAll()V": function (this: JEditText) {
      return after(vcall(this, "getText", "()Landroid/text/Editable;"), selectAll);
    },
    "performClick()Z": driven(function* (this: JEditText): Gen {
      yield vcall(this, "requestFocus", "()Z");
      if (this.clickL) yield vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
      return 1;
    }),
  },
});
setFocusHook((v, on) => {
  if (v instanceof JEditText) focusEditText(on ? v : null);
  else if (on && focusedEdit) focusEditText(null);
});

/** TextView.setText's filter pass: each filter sees the whole text against EMPTY_SPANNED */
let emptySpanned: unknown = null;
const filterText = driven(function* filterText(tv: JTextView, cs: unknown): Gen {
  emptySpanned ??= yield newObj("android/text/SpannedString", "(Ljava/lang/CharSequence;)V", "");
  for (const filter of tv.filters) {
    const out = yield vcall(filter, "filter", "(Ljava/lang/CharSequence;IILandroid/text/Spanned;II)Ljava/lang/CharSequence;", cs, 0, yield csLength(cs), emptySpanned, 0, 0);
    if (out != null) cs = out;
  }
  return cs;
});

rt.markers("android/widget/Checkable");
