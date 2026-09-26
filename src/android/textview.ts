import { AID, resString } from "./res";
import { JView, requestLayout, initViewFromCtx, guardCall, invalidate, specMode, specSize, MS_UNSPEC, MS_EXACTLY, MS_AT_MOST, resolveSize, setFocusHook, removeFrom } from "./view";
import {
  type JColorStateList, mkCsl, type JDrawable, loadColorStateList, loadDrawableRV, cslColor, loadDrawable,
  drawChild, drawableSize
} from "./drawable";
import { JTextPaint, JEditable, JSpanned, JLayout, spannedString, textSelection, setTextSelection } from "./text";
import { G, gravityV, gravityH } from "./gravity";
import { isRtl } from "./bidiformatter";
import { device } from "../shell/config";
import {
  fontDescent, fontAscent, fontTop, fontBottom, measureText, typefaceFor, JTypeface, tfDefault, JRect,
  type JCanvas, tfMedium
} from "./graphics";
import { vcall, vcallOn, callOn, curThread, after, mkEnumSet, newObj } from "../jvm/natives/jlang";
import {
  attrTable, type Resources, resolveStyleValue, rvDimen, rvColor, rvInt, rvFloat, type RV, rvString, type JAttrSet,
  obtainStyled
} from "./res";
import { TV } from "./axml";
import { fontResource } from "./fonts";
import { type NativeSpec, callSelf, rt, JObj, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { jarray, mangleMethod } from "../jvm/abi";
import { usLocale } from "../jvm/natives/jvalues";
import { TextViewLayouts, drawTextViewLayout, layoutHeight } from "./textview-layout";

export class JTextView extends JView {
  fallbackLineSpacing = true;
  lineBreakStyle = 0; lineBreakWordStyle = 0;
  /** kept for the app to read back; text is drawn untransformed */
  transformation: unknown = null;
  editableFactory: unknown = null; spannableFactory: unknown = null;
  keyListener: unknown = null; movementMethod: unknown = null; selActionMode: unknown = null; editorActionL: unknown = null;
  insertionActionMode: unknown = null;
  drawableTint: JColorStateList | null = null;
  imeOptions = 0; privateImeOptions: string | null = null; breakStrategy = 0; hyphenation = 0; autoSizeType = 0;
  showSoftInputOnFocus = true;
  linksClickable = true; fontVariation: string | null = null;
  maxW = Infinity;
  maxH = Infinity;
  text = "";
  rawText: unknown = "";       // original CharSequence (may be Spannable)
  hint = "";
  paintT = new JTextPaint();
  shadowRadius = 0; shadowDx = 0; shadowDy = 0; shadowColor = 0;
  colors: JColorStateList = mkCsl(-16777216);
  hintColors: JColorStateList | null = mkCsl(1627389952);
  linkColors: JColorStateList | null = null;
  gravityT = 48 | G.START;
  maxLinesV = Infinity;
  minLinesV = 1;
  singleLine = false;
  ellipsizeEnd = false;
  filters: unknown[] = [];
  maxLength = Infinity;
  lineSpacingExtra = 0;
  lineSpacingMult = 1;
  allCaps = false;
  /** set once a style or the app has spoken about textAllCaps, so a widget default cannot
   *  overrule it afterwards */
  capsSet: boolean | undefined = undefined;
  drawableL: JDrawable | null = null;
  drawableT: JDrawable | null = null;
  drawableR: JDrawable | null = null;
  drawableB: JDrawable | null = null;
  drawablePad = 0;
  watchers: unknown[] = [];
  editable = false;
  editObj: JEditable | null = null;
  cursorVisible = true;
  cursorDrawable: JDrawable | null = null;
  cursorDrawableRes = 0;
  /** when the caret last restarted its blink: focus and every edit, as AOSP's Editor.Blink does */
  blinkStart = 0;
  layout: JLayout | null = null;
  textLayouts: TextViewLayouts | null = null; hintLayouts: TextViewLayouts | null = null;
  layoutWidthFor = -1;
  inputTypeV = 1;
  styleBits = 0;
  includePad = true;

  constructor() {
    super();
    this.paintT.textSize = device.dp(14); // AOSP TextView default, 14sp
    this.paintT.setColorValue(-16777216);
  }
  updateLinkColor() {
    if (!this.linkColors) return;
    const color = cslColor(this.linkColors, this.drawableState());
    if (this.paintT.linkColor !== color) { this.paintT.linkColor = color; invalidate(this); }
  }
  horizontalGravity(text: string, alignment: number, layoutDirection: number): number {
    if (alignment === 4) return 1;
    if (alignment === 5 || alignment === 6) return (alignment === 5) !== !!layoutDirection ? 3 : 5;
    const gravity = this.gravityT & 0x800007;
    if (alignment === 1 && gravity !== G.START && gravity !== G.END) return gravityH(gravity);
    const rtl = !!isRtl(text, 0, text.length, "firstLtr");
    return (alignment === 3 || alignment === 1 && gravity === G.END) !== rtl ? 5 : 3;
  }
  private upperOf = ""; private upper = "";
  displayText(): string {
    if (!this.allCaps) return this.text;
    if (this.upperOf !== this.text) { this.upperOf = this.text; this.upper = this.text.toUpperCase(); }
    return this.upper;
  }
  lineHeight(): number {
    const height = Math.round(fontDescent(this.paintT)) - Math.round(fontAscent(this.paintT));
    return Math.round(height * this.lineSpacingMult + this.lineSpacingExtra);
  }
  /** includeFontPadding (AOSP's default): the first line's box starts at the font's `top` and the
   *  last one's ends at its `bottom`, so a line box is taller than ascent..descent at both ends. */
  topPad(): number { return this.includePad ? Math.round(fontAscent(this.paintT)) - Math.floor(fontTop(this.paintT)) : 0; }
  bottomPad(): number { return this.includePad ? Math.ceil(fontBottom(this.paintT)) - Math.round(fontDescent(this.paintT)) : 0; }
  textHeight(lines: number): number { return lines * this.lineHeight() + this.topPad() + this.bottomPad(); }
  ascent(): number { return Math.round(-fontAscent(this.paintT)) + this.topPad(); }
  async notifyWatchers() {
    for (const w of this.watchers) {
      try {
        await vcall(w, "beforeTextChanged", "(Ljava/lang/CharSequence;III)V", this.text, 0, 0, this.text.length);
        await vcall(w, "onTextChanged", "(Ljava/lang/CharSequence;III)V", this.text, 0, 0, this.text.length);
        await vcall(w, "afterTextChanged", "(Landroid/text/Editable;)V", this.getEditable());
      } catch (e) { console.error("[watcher]", e); }
    }
  }
  getEditable(): JEditable {
    if (!this.editObj) this.editObj = rt.make("webdroid/Editable") as JEditable;
    this.editObj.text = this.text;
    return this.editObj;
  }
  measuredLines(avail: number): JLayout | Promise<JLayout> {
    return (this.textLayouts ??= new TextViewLayouts()).get(this, this.rawText instanceof JSpanned ? this.rawText : this.text, avail);
  }

}
const tvAttr = attrTable(
  "text", "textSize", "textColor", "textStyle", "textAppearance", "hint", "gravity", "maxLines",
  "minLines", "lines", "singleLine", "ellipsize", "lineSpacingExtra", "lineSpacingMultiplier",
  "drawableLeft", "drawableTop", "drawableRight", "drawableBottom", "drawablePadding", "drawableStart",
  "drawableEnd", "fontFamily", "textAllCaps", "textColorHint", "inputType", "letterSpacing", "maxLength",
  "imeOptions", "includeFontPadding", "ems", "minEms", "minWidth", "shadowColor", "shadowDx", "shadowDy", "shadowRadius", "textColorLink", "textCursorDrawable");

function applyTextAppearance(tv: JTextView, res: Resources, styleId: number): unknown { return rt.drive(applyTextAppearance$(tv, res, styleId)); }
function* applyTextAppearance$(tv: JTextView, res: Resources, styleId: number): Gen {
  if (!styleId) return;
  const look = (name: string) => resolveStyleValue(res, tv.theme, res.styleLookup(styleId, AID(name)));
  const ts = look("textSize");
  if (ts) tv.paintT.textSize = rvDimen(res, ts, tv.paintT.textSize);
  const tc = look("textColor");
  if (tc) {
    if (tc.t === TV.REFERENCE) tv.colors = (yield loadColorStateList(res, tc.d, tv.theme));
    else tv.colors = mkCsl(rvColor(res, tc, -16777216));
  }
  const link = look("textColorLink");
  if (link) {
    tv.linkColors = link.t === TV.REFERENCE ? (yield loadColorStateList(res, link.d, tv.theme)) : mkCsl(rvColor(res, link, tv.paintT.linkColor));
    tv.updateLinkColor();
  }
  const st = look("textStyle");
  if (st) tv.styleBits = rvInt(res, st, 0);
  (yield applyFontFamily(tv, res, look("fontFamily")));
  const caps = look("textAllCaps");
  if (caps) { tv.allCaps = !!rvInt(res, caps, 0); tv.capsSet = true; }
}
/** `android:fontFamily` is either a system family name or a reference to a @font/ resource —
 *  a bare .ttf or a <font-family> XML. Apps ship their own fonts and name them this way. */
function applyFontFamily(tv: JTextView, res: Resources, v: RV | null): unknown { return rt.drive(applyFontFamily$(tv, res, v)); }
function* applyFontFamily$(tv: JTextView, res: Resources, v: RV | null): Gen {
  if (!v) return;
  if (v.t === TV.REFERENCE && v.d) {
    const tf = (yield fontResource(res, v.d));
    if (tf) tv.paintT.tf = tf;
    return;
  }
  const fam = rvString(res, v);
  if (fam) tv.paintT.tf = typefaceFor(fam);
}
export function applyTvStyle(tv: JTextView, set: JAttrSet | null, defStyleAttr: number): unknown { return rt.drive(applyTvStyle$(tv, set, defStyleAttr)); }
function* applyTvStyle$(tv: JTextView, set: JAttrSet | null, defStyleAttr: number): Gen {
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
    tvAttr.shadowColor, tvAttr.shadowDx, tvAttr.shadowDy, tvAttr.shadowRadius, tvAttr.textColorLink, tvAttr.textCursorDrawable,
  ];
  const ta = obtainStyled(res, tv.theme, set, ids, defStyleAttr, 0);
  const g = (i: number) => ta.vals[i];
  const taRef = g(4);
  if (taRef && taRef.t === TV.REFERENCE) (yield applyTextAppearance(tv, res, taRef.d));
  if (g(1)) tv.paintT.textSize = rvDimen(res, g(1), tv.paintT.textSize);
  if (g(2)) {
    const v = g(2)!;
    if (v.t === TV.REFERENCE) tv.colors = (yield loadColorStateList(res, v.d, tv.theme));
    else tv.colors = mkCsl(rvColor(res, v, -16777216));
  }
  if (g(3)) tv.styleBits = rvInt(res, g(3), tv.styleBits);
  if (g(0)) {
    const v = g(0)!;
    tv.text = v.t === TV.REFERENCE ? rvString(res, res.resolveRefs(v)) ?? "" : rvString(res, v) ?? "";
    tv.rawText = tv.text;
  }
  if (g(5)) {
    const v = g(5)!;
    tv.hint = (v.t === TV.REFERENCE ? rvString(res, res.resolveRefs(v)) : rvString(res, v)) ?? "";
  }
  if (g(6)) tv.gravityT = rvInt(res, g(6), tv.gravityT);
  if (g(7)) tv.maxLinesV = rvInt(res, g(7), 0) || Infinity;
  if (g(21)) { const n = rvInt(res, g(21), 0); if (n > 0) { tv.maxLinesV = n; tv.minLinesV = n; } }
  if (g(24)) tv.minLinesV = rvInt(res, g(24), 1);
  if (g(25) || g(26)) tv.minW = Math.max(tv.minW, Math.round(rvInt(res, (g(25) ?? g(26))!, 0) * tv.paintT.textSize));
  if (g(27)) tv.minW = Math.max(tv.minW, Math.round(rvDimen(res, g(27), 0)));
  if (g(8)) tv.singleLine = !!rvInt(res, g(8), 0);
  if (g(9)) tv.ellipsizeEnd = rvInt(res, g(9), 0) === 3;
  const dl = g(10) ?? g(22), dt = g(11), dr = g(12) ?? g(23), db = g(13);
  if (dl) tv.drawableL = (yield loadDrawableRV(res, dl, tv.theme));
  if (dt) tv.drawableT = (yield loadDrawableRV(res, dt, tv.theme));
  if (dr) tv.drawableR = (yield loadDrawableRV(res, dr, tv.theme));
  if (db) tv.drawableB = (yield loadDrawableRV(res, db, tv.theme));
  if (dl || dt || dr || db) (yield setIntrinsicDrawables.call(tv, tv.drawableL, tv.drawableT, tv.drawableR, tv.drawableB));
  if (g(14)) tv.drawablePad = Math.round(rvDimen(res, g(14), 0));
  (yield applyFontFamily(tv, res, g(15)));
  if (g(16)) { tv.allCaps = !!rvInt(res, g(16), 0); tv.capsSet = true; }
  if (g(17)) {
    const v = g(17)!;
    tv.hintColors = v.t === TV.REFERENCE ? (yield loadColorStateList(res, v.d, tv.theme)) : mkCsl(rvColor(res, v, 1627389952));
  }
  if (g(18)) tv.inputTypeV = rvInt(res, g(18), 1);
  if (g(19)) tv.lineSpacingExtra = rvDimen(res, g(19), 0);
  if (g(20)) tv.lineSpacingMult = g(20)!.t === TV.FLOAT ? g(20)!.d : 1;
  if (g(28)) tv.includePad = !!rvInt(res, g(28), 1);
  // the action the IME key performs: a search field declares it here and nowhere else
  if (g(29)) tv.imeOptions = rvInt(res, g(29), 0);
  if (g(30) || g(31) || g(32) || g(33)) (yield setTextShadow.call(tv, rvFloat(res, g(33), tv.shadowRadius), rvFloat(res, g(31), tv.shadowDx), rvFloat(res, g(32), tv.shadowDy), rvColor(res, g(30), tv.shadowColor)));
  const link = g(34);
  if (link) {
    tv.linkColors = link.t === TV.REFERENCE ? (yield loadColorStateList(res, link.d, tv.theme)) : mkCsl(rvColor(res, link, tv.paintT.linkColor));
    tv.updateLinkColor();
  }
  const cursor = g(35);
  if (cursor?.t === TV.REFERENCE) tv.cursorDrawableRes = cursor.d;
  if (tv.styleBits & 1) tv.paintT.fakeBold = true;
  if (tv.styleBits & 2) tv.paintT.tf = (() => { const t = new JTypeface(); t.family = tv.paintT.tf.family; t.italic = true; t.weight = tv.paintT.tf.weight; return t; })();
}
function textCursorDrawable(tv: JTextView): JDrawable | null | Promise<JDrawable | null> { return rt.drive(textCursorDrawable$(tv)); }
function* textCursorDrawable$(tv: JTextView): Gen<JDrawable | null> {
  if (tv.cursorDrawableRes && tv.jres) {
    tv.cursorDrawable = (yield loadDrawable(tv.jres, tv.cursorDrawableRes, tv.theme));
    tv.cursorDrawableRes = 0;
  }
  return tv.cursorDrawable;
}
function setTextShadow(this: JTextView, radius: number, dx: number, dy: number, color: number): unknown { return rt.drive(setTextShadow$.call(this, radius, dx, dy, color)); }
function* setTextShadow$(this: JTextView, radius: number, dx: number, dy: number, color: number): Gen {
  this.shadowRadius = radius; this.shadowDx = dx; this.shadowDy = dy; this.shadowColor = color;
  (yield vcall(this.paintT, "setShadowLayer", "(FFFI)V", radius, dx, dy, color)); invalidate(this);
}
function setTextAppearance(this: JTextView, id: number) {
  return this.jres ? applyTextAppearance(this, this.jres, id) : undefined;
}
function setCompoundDrawables(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null) {
  this.drawableL = l; this.drawableT = t; this.drawableR = r; this.drawableB = b;
  invalidate(this); requestLayout(this);
}
function setIntrinsicDrawables(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null): unknown { return rt.drive(setIntrinsicDrawables$.call(this, l, t, r, b)); }
function* setIntrinsicDrawables$(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null): Gen {
  const thread = curThread;
  for (const d of [l, t, r, b]) if (d) {
    const width = (yield drawableSize(d, false, thread)), height = (yield drawableSize(d, true, thread));
    (yield vcallOn(thread, d, "setBounds", "(IIII)V", 0, 0, width, height));
  }
  setCompoundDrawables.call(this, l, t, r, b);
}
const compoundWidth = (d: JDrawable | null) => d ? Math.max(0, d.bounds.right - d.bounds.left) : 0;
const compoundHeight = (d: JDrawable | null) => d ? Math.max(0, d.bounds.bottom - d.bounds.top) : 0;
/** the (Context) / (Context, AttributeSet) / (Context, AttributeSet, defStyleAttr) constructor trio of a
 *  TextView subclass: attach to the context, apply the widget's default style (or the caller's), then `then` */
export function textViewCtors<T extends JTextView>(styleAttr: string, then?: (v: T) => unknown): NativeSpec["methods"] {
  const init = async (v: T, c: unknown, set: JAttrSet | null, dsa = 0) => {
    const style = dsa || AID(styleAttr);
    await initViewFromCtx(v, c, set, style);
    await applyTvStyle(v, set, style);
    await then?.(v);
  };
  return {
    "<init>(Landroid/content/Context;)V": function (this: T, c: unknown) { return init(this, c, null); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V": function (this: T, c: unknown, set: JAttrSet | null) { return init(this, c, set); },
    "<init>(Landroid/content/Context;Landroid/util/AttributeSet;I)V": function (this: T, c: unknown, set: JAttrSet | null, dsa: number) { return init(this, c, set, dsa); },
  };
}
/** AOSP setRawTextSize: only a size that differs asks for layout */
function setRawTextSize(tv: JTextView, px: number) {
  if (tv.paintT.textSize === px) return;
  tv.paintT.textSize = px;
  requestLayout(tv);
}
/** AOSP setTypeface: the typeface already in use asks for nothing. Fake bold counts as a change
 *  here because it changes the measured width. */
function applyTypeface(tv: JTextView, tf: JTypeface, fakeBold: boolean) {
  if (tv.paintT.tf === tf && tv.paintT.fakeBold === fakeBold) return;
  tv.paintT.tf = tf; tv.paintT.fakeBold = fakeBold;
  requestLayout(tv);
}
function compoundDrawables(this: JTextView) {
  return jarray([this.drawableL, this.drawableT, this.drawableR, this.drawableB], "Landroid/graphics/drawable/Drawable;");
}
function compoundPadL(this: JTextView) { return this.padL + (this.drawableL ? compoundWidth(this.drawableL) + this.drawablePad : 0); }
function compoundPadR(this: JTextView) { return this.padR + (this.drawableR ? compoundWidth(this.drawableR) + this.drawablePad : 0); }
function compoundPadT(this: JTextView) { return this.padT + (this.drawableT ? compoundHeight(this.drawableT) + this.drawablePad : 0); }
function compoundPadB(this: JTextView) { return this.padB + (this.drawableB ? compoundHeight(this.drawableB) + this.drawablePad : 0); }
function compoundPadRelative(view: JTextView, start: boolean) {
  const thread = curThread;
  return after(vcallOn(thread, view, "getLayoutDirection", "()I"), direction =>
    vcallOn(thread, view, start !== (direction === 1) ? "getCompoundPaddingLeft" : "getCompoundPaddingRight", "()I"));
}
export const textViewMethods: NonNullable<NativeSpec["methods"]> = {
  ...textViewCtors("textViewStyle"),
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
    const [start, end] = (yield textSelection(this.editable ? this.getEditable() : this.rawText));
    (yield vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", cs, type));
    if (start >= 0 || end >= 0) {
      const text = this.editable ? this.getEditable() : this.rawText;
      if (text && typeof text !== "string" && rt.iof(text, "android/text/Spannable")) {
        (yield setTextSelection(text, Math.max(0, Math.min(start, this.text.length)), Math.max(0, Math.min(end, this.text.length))));
      }
    }
  }),
  "setText(I)V": driven(function* (this: JTextView, id: number): Gen {
    const s = this.jres ? resString(this.jres, id) : "";
    (yield guardCall(this, mangleMethod("setText", "(Ljava/lang/CharSequence;)V"), s));
  }),
  "setText(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V": driven(function* (this: JTextView, cs: unknown): Gen {
    const changedSpans = cs instanceof JSpanned || this.rawText instanceof JSpanned;
    this.rawText = cs;
    invalidate(this);
    if (changedSpans) this.textLayouts = null;
    const t = spannedString(cs);
    if (t !== this.text || changedSpans) {
      this.text = t;
      this.layoutWidthFor = -1;
      requestLayout(this);
      (yield this.notifyWatchers());
    }
  }),
  "getText()Ljava/lang/CharSequence;": function (this: JTextView) {
    return this.editable ? this.getEditable() : (this.rawText ?? this.text);
  },
  "length()I": function (this: JTextView) { return this.text.length; },
  // AOSP's checkForRelayout: an empty view measures its hint, so a new one can change the size
  "setHint(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) { this.hint = spannedString(cs); requestLayout(this); },
  "setHint(I)V": function (this: JTextView, id: number) {
    this.hint = this.jres ? resString(this.jres, id) : "";
    requestLayout(this);
  },
  "getHint()Ljava/lang/CharSequence;": function (this: JTextView) { return this.hint; },
  "setTextSize(F)V": function (this: JTextView, sp: number) { setRawTextSize(this, sp * device.density); },
  "setTextSize(IF)V": function (this: JTextView, unit: number, v: number) {
    setRawTextSize(this, unit === 1 || unit === 2 ? v * device.density : v); // COMPLEX_UNIT_DIP / SP
  },
  "getTextSize()F": function (this: JTextView) { return this.paintT.textSize; },
  "setTextColor(I)V": function (this: JTextView, c: number) { this.colors = mkCsl(c); invalidate(); },
  "setTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, c: JColorStateList) {
    if (c) this.colors = c;
    invalidate();
  },
  "setLinkTextColor(I)V": function (this: JTextView, color: number) { this.linkColors = mkCsl(color); this.updateLinkColor(); },
  "setLinkTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, colors: JColorStateList | null) { this.linkColors = colors; this.updateLinkColor(); },
  "getLinkTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.linkColors; },
  "drawableStateChanged()V": function (this: JTextView) { this.updateLinkColor(); },
  "getTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.colors; },
  "getCurrentTextColor()I": function (this: JTextView) { return cslColor(this.colors, this.drawableState()); },
  "setHintTextColor(Landroid/content/res/ColorStateList;)V": function (this: JTextView, c: JColorStateList | null) { this.hintColors = c; invalidate(this); },
  "setHintTextColor(I)V": function (this: JTextView, c: number) { this.hintColors = mkCsl(c); invalidate(this); },
  "setGravity(I)V": function (this: JTextView, g: number) { this.gravityT = g; invalidate(); },
  "getGravity()I": function (this: JTextView) { return this.gravityT; },
  "setTypeface(Landroid/graphics/Typeface;)V": function (this: JTextView, t: JTypeface | null) {
    applyTypeface(this, t ?? tfDefault, this.paintT.fakeBold);
  },
  "setTypeface(Landroid/graphics/Typeface;I)V": function (this: JTextView, t: JTypeface | null, style: number) {
    applyTypeface(this, t ?? tfDefault, (style & 1) !== 0);
  },
  "getTypeface()Landroid/graphics/Typeface;": function (this: JTextView) { return this.paintT.tf; },
  "getPaint()Landroid/text/TextPaint;": function (this: JTextView) { return this.paintT; },

  "setSingleLine()V": function (this: JTextView) { this.singleLine = true; requestLayout(this); },
  "setSingleLine(Z)V": function (this: JTextView, v: number) { this.singleLine = !!v; requestLayout(this); },
  "setMaxLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n; this.maxH = Infinity; requestLayout(this); },
  "getMaxLines()I": function (this: JTextView) { return Number.isFinite(this.maxLinesV) ? this.maxLinesV : 0x7fffffff; },
  "setMinLines(I)V": function (this: JTextView, n: number) { this.minLinesV = n; this.minH = 0; requestLayout(this); },
  "setLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n; this.maxH = Infinity; this.minLinesV = n; this.minH = 0; requestLayout(this); },
  "setEllipsize(Landroid/text/TextUtils$TruncateAt;)V": function (this: JTextView, e: { ord: number } | null) {
    const end = e?.ord === 2;
    if (this.ellipsizeEnd !== end) { this.ellipsizeEnd = end; requestLayout(this); }
  },
  "setAllCaps(Z)V": function (this: JTextView, v: number) { this.allCaps = !!v; this.capsSet = true; requestLayout(this); },
  "setLineSpacing(FF)V": function (this: JTextView, extra: number, mult: number) {
    this.lineSpacingExtra = extra; this.lineSpacingMult = mult;
    requestLayout(this);
  },
  "setLetterSpacing(F)V": function (this: JTextView, v: number) {
    if (this.paintT.letterSpacingEm !== v) { this.paintT.letterSpacingEm = v; requestLayout(this); }
  },
  "setIncludeFontPadding(Z)V": function (this: JTextView, on: number) { this.includePad = !!on; requestLayout(this); },
  // fallback-font line spacing only changes metrics where a glyph comes from a fallback font, which one system font never does here
  "setFallbackLineSpacing(Z)V": function (this: JTextView, on: number) { this.fallbackLineSpacing = !!on; },
  // API 33 line-break tuning: the ICU break iterator here has one style, so the values are only kept
  "setLineBreakStyle(I)V": function (this: JTextView, v: number) { this.lineBreakStyle = v; },
  "getLineBreakStyle()I": function (this: JTextView) { return this.lineBreakStyle; },
  "setLineBreakWordStyle(I)V": function (this: JTextView, v: number) { this.lineBreakWordStyle = v; },
  "getLineBreakWordStyle()I": function (this: JTextView) { return this.lineBreakWordStyle; },
  "isFallbackLineSpacing()Z": function (this: JTextView) { return this.fallbackLineSpacing ? 1 : 0; },
  "setTextAppearance(Landroid/content/Context;I)V": function (this: JTextView, c: unknown, id: number) { return setTextAppearance.call(this, id); },
  "setTextAppearance(I)V": setTextAppearance,
  "setCompoundDrawablesWithIntrinsicBounds(IIII)V": driven(function* (this: JTextView, l: number, t: number, r: number, b: number): Gen {
    const res = this.jres!;
    const [dl, dt, dr, db] = (yield Promise.all([l, t, r, b].map((id) => (id ? loadDrawable(res, id, this.theme) : null))));
    return setIntrinsicDrawables.call(this, dl, dt, dr, db);
  }),
  "setCompoundDrawablesWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setIntrinsicDrawables,
  "setCompoundDrawables(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "getCompoundDrawables()[Landroid/graphics/drawable/Drawable;": compoundDrawables,
  "setCompoundDrawablePadding(I)V": function (this: JTextView, p: number) { this.drawablePad = p; requestLayout(this); },
  "getCompoundDrawablePadding()I": function (this: JTextView) { return this.drawablePad; },
  "getCompoundPaddingLeft()I": compoundPadL,
  "getCompoundPaddingRight()I": compoundPadR,
  "getCompoundPaddingTop()I": compoundPadT,
  "getCompoundPaddingBottom()I": compoundPadB,
  "getCompoundPaddingStart()I": function (this: JTextView) { return compoundPadRelative(this, true); },
  "getCompoundPaddingEnd()I": function (this: JTextView) { return compoundPadRelative(this, false); },
  // the factories only matter to a TextView that hands its buffer to the app (emoji2 wraps
  // them to intercept the Editable); kept so getters round-trip
  "setEditableFactory(Landroid/text/Editable$Factory;)V": function (this: JTextView, f: unknown) { this.editableFactory = f; },
  "setSpannableFactory(Landroid/text/Spannable$Factory;)V": function (this: JTextView, f: unknown) { this.spannableFactory = f; },
  "addTextChangedListener(Landroid/text/TextWatcher;)V": function (this: JTextView, w: unknown) { this.watchers.push(w); },
  "removeTextChangedListener(Landroid/text/TextWatcher;)V": function (this: JTextView, w: unknown) {
    removeFrom(this.watchers, w);
  },
  "setInputType(I)V": function (this: JTextView, t: number) { this.inputTypeV = t; },
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
  "setMovementMethod(Landroid/text/method/MovementMethod;)V": function (this: JTextView, m: unknown) { this.movementMethod = m; },
  "getMovementMethod()Landroid/text/method/MovementMethod;": function (this: JTextView) { return this.movementMethod; },
  "getDefaultMovementMethod()Landroid/text/method/MovementMethod;": () => null,
  "getCompoundDrawablesRelative()[Landroid/graphics/drawable/Drawable;": compoundDrawables,
  "setCompoundDrawablesRelative(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawablesRelativeWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setIntrinsicDrawables,
  "setCompoundDrawablesRelativeWithIntrinsicBounds(IIII)V": function (this: JTextView, l: number, t: number, r: number, b: number) {
    return callSelf(textViewMethods, "setCompoundDrawablesWithIntrinsicBounds(IIII)V", this, l, t, r, b);
  },
  "setCompoundDrawableTintList(Landroid/content/res/ColorStateList;)V": function (this: JTextView, csl: JColorStateList | null) {
    this.drawableTint = csl;
    for (const d of [this.drawableL, this.drawableT, this.drawableR, this.drawableB]) if (d) d.tint = csl ? cslColor(csl, d.stateSet) : null;
    invalidate();
  },
  "getCompoundDrawableTintList()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.drawableTint; },
  "getHintTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.hintColors; },
  "getLineSpacingExtra()F": function (this: JTextView) { return this.lineSpacingExtra; },
  "getLineSpacingMultiplier()F": function (this: JTextView) { return this.lineSpacingMult; },
  "getMinLines()I": function (this: JTextView) { return this.minLinesV; },
  "getMinWidth()I": function (this: JTextView) { return this.minW; },
  "getMinHeight()I": function (this: JTextView) { return this.minH; },
  "getLetterSpacing()F": function (this: JTextView) { return this.paintT.letterSpacingEm; },
  "setBreakStrategy(I)V": function (this: JTextView, b: number) { this.breakStrategy = b; },
  "getBreakStrategy()I": function (this: JTextView) { return this.breakStrategy; },
  "setHyphenationFrequency(I)V": function (this: JTextView, h: number) { this.hyphenation = h; },
  "getHyphenationFrequency()I": function (this: JTextView) { return this.hyphenation; },
  "getTotalPaddingLeft()I": compoundPadL,
  "getTotalPaddingRight()I": compoundPadR,
  "getTotalPaddingTop()I": compoundPadT,
  "getTotalPaddingBottom()I": compoundPadB,
  "setHeight(I)V": function (this: JTextView, h: number) {
    this.minH = this.maxH = h; this.minLinesV = 0; this.maxLinesV = Infinity; requestLayout(this);
  },
  "setMaxHeight(I)V": function (this: JTextView, h: number) { this.maxH = h; this.maxLinesV = Infinity; requestLayout(this); },
  "getMaxHeight()I": function (this: JTextView) { return Number.isFinite(this.maxH) ? this.maxH : -1; },
  "setWidth(I)V": function (this: JTextView, w: number) { this.minW = w; this.maxW = w; requestLayout(this); },
  "setMinEms(I)V": function (this: JTextView, ems: number) { this.minW = Math.round(ems * this.paintT.textSize); requestLayout(this); },
  "setRawInputType(I)V": function (this: JTextView, t: number) { this.inputTypeV = t; },
  "setLinksClickable(Z)V": function (this: JTextView, v: number) { this.linksClickable = !!v; },
  "getLinksClickable()Z": function (this: JTextView) { return this.linksClickable ? 1 : 0; },
  "getTextLocale()Ljava/util/Locale;": () => usLocale,
  "setFontVariationSettings(Ljava/lang/String;)Z": function (this: JTextView, s: string | null) { this.fontVariation = s; return 1; },
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
    this.padT = Math.max(0, h - this.ascent()); requestLayout(this);
  },
  "setLastBaselineToBottomHeight(I)V": function (this: JTextView, h: number) {
    this.padB = Math.max(0, h - Math.round(fontDescent(this.paintT))); requestLayout(this);
  },
  // auto-size is never active: AUTO_SIZE_TEXT_TYPE_NONE and the "unset" -1 sizes, as AOSP reports
  "setAutoSizeTextTypeWithDefaults(I)V": function (this: JTextView, t: number) { this.autoSizeType = t; },
  "setAutoSizeTextTypeUniformWithConfiguration(IIII)V": function (this: JTextView) { this.autoSizeType = 1; },
  "setAutoSizeTextTypeUniformWithPresetSizes([II)V": function (this: JTextView) { this.autoSizeType = 1; },
  "getAutoSizeTextType()I": function (this: JTextView) { return this.autoSizeType; },
  "getAutoSizeTextAvailableSizes()[I": () => new Int32Array(0),
  "setTransformationMethod(Landroid/text/method/TransformationMethod;)V": function (this: JTextView, m: unknown) { this.transformation = m; },
  "getTransformationMethod()Landroid/text/method/TransformationMethod;": function (this: JTextView) { return this.transformation; },
  "setTextCursorDrawable(I)V": driven(function* (this: JTextView, id: number): Gen {
    const drawable = id ? (yield vcall(this.ctx, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;", id)) : null;
    (yield vcall(this, "setTextCursorDrawable", "(Landroid/graphics/drawable/Drawable;)V", drawable));
  }),
  "setTextCursorDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JTextView, drawable: JDrawable | null) {
    this.cursorDrawableRes = 0; this.cursorDrawable = drawable; invalidate(this);
  },
  "getTextCursorDrawable()Landroid/graphics/drawable/Drawable;": function (this: JTextView) { return textCursorDrawable(this); },
  "setCursorVisible(Z)V": function (this: JTextView, v: number) { this.cursorVisible = !!v; },
  "setOnEditorActionListener(Landroid/widget/TextView$OnEditorActionListener;)V": function (this: JTextView, l: unknown) { this.editorActionL = l; },
  "setFilters([Landroid/text/InputFilter;)V": function (this: JTextView, arr: unknown[]) {
    this.filters = arr ?? [];
    for (const f of this.filters ?? []) {
      if (f instanceof JLengthFilter) this.maxLength = f.max;
    }
  },
  "getFilters()[Landroid/text/InputFilter;": function (this: JTextView) { const a = this.filters ?? []; (a as any).$t = "Landroid/text/InputFilter;"; return a; },
  "setMaxWidth(I)V": function (this: JTextView, w: number) { this.maxW = w; requestLayout(this); },
  // AOSP: an unbounded maximum reads back as Integer.MAX_VALUE, and callers Math.min() with it
  "getMaxWidth()I": function (this: JTextView) { return Number.isFinite(this.maxW) ? this.maxW : 0x7fffffff; },
  // AOSP: null until the first measure; afterwards the Layout over the measured text width
  "getLayout()Landroid/text/Layout;": function (this: JTextView) {
    return this.layoutWidthFor < 0 ? null : this.layout;
  },
  "getLineBounds(ILandroid/graphics/Rect;)I": function (this: JTextView, i: number, r: JRect) {
    const lh = this.lineHeight(), w = this.layoutWidthFor >= 0 ? this.layoutWidthFor : this.width();
    r.left = this.padL; r.right = Math.max(this.padL, w - this.padR); r.top = this.padT + i * lh; r.bottom = r.top + lh;
    return r.top + this.ascent();
  },
  "setShadowLayer(FFFI)V": setTextShadow,
  "getShadowRadius()F": function (this: JTextView) { return this.shadowRadius; },
  "getShadowDx()F": function (this: JTextView) { return this.shadowDx; },
  "getShadowDy()F": function (this: JTextView) { return this.shadowDy; },
  "getShadowColor()I": function (this: JTextView) { return this.shadowColor; },
  "setMinWidth(I)V": function (this: JTextView, w: number) { this.minW = w; requestLayout(this); },
  ...noops("setCompoundDrawableTintMode(Landroid/graphics/PorterDuff$Mode;)V",
    "setTextLocales(Landroid/os/LocaleList;)V", "setImeHintLocales(Landroid/os/LocaleList;)V", "beginBatchEdit()V",
    "endBatchEdit()V", "setHighlightColor(I)V", "setHorizontallyScrolling(Z)V", "setMarqueeRepeatLimit(I)V",
    "setSelectAllOnFocus(Z)V", "setTextIsSelectable(Z)V", "setError(Ljava/lang/CharSequence;)V", "setAutoLinkMask(I)V",
    "setMaxEms(I)V"),
  ...stubs(1, "getIncludeFontPadding()Z"),
  ...stubs(0, "isHorizontallyScrollable()Z"),
  ...stubs(-1, "getAutoSizeMinTextSize()I", "getAutoSizeMaxTextSize()I", "getAutoSizeStepGranularity()I"),
  "setMinHeight(I)V": function (this: JTextView, h: number) { this.minH = h; requestLayout(this); },
  "setEms(I)V": function (this: JTextView, ems: number) { this.minW = Math.round(ems * this.paintT.textSize); requestLayout(this); },
  "setPaintFlags(I)V": function (this: JTextView, f: number) {
    this.paintT.strikeThru = (f & 16) !== 0;
    this.paintT.underline = (f & 8) !== 0;
    invalidate();
  },
  "getPaintFlags()I": function (this: JTextView) {
    return (this.paintT.strikeThru ? 16 : 0) | (this.paintT.underline ? 8 : 0) | 1;
  },
  "getLineHeight()I": function (this: JTextView) { return this.lineHeight(); },
  "getLineCount()I": function (this: JTextView) { return this.layout?.lines.length ?? 0; },
  "getBaseline()I": function (this: JTextView) { return this.padT + this.ascent(); },
  "getEditableText()Landroid/text/Editable;": function (this: JTextView) { return this.getEditable(); },
  "setEnabled(Z)V": function (this: JTextView, e: number) { this.enabled = !!e; void this.refreshDrawableState(); },
  "onMeasure(II)V": driven(function* (this: JTextView, wSpec: number, hSpec: number): Gen {
    const thread = curThread;
    const wMode = specMode(wSpec), wSize = specSize(wSpec);
    const dlW = (this.drawableL ? compoundWidth(this.drawableL) + this.drawablePad : 0)
      + (this.drawableR ? compoundWidth(this.drawableR) + this.drawablePad : 0);
    const dtH = (this.drawableT ? compoundHeight(this.drawableT) + this.drawablePad : 0)
      + (this.drawableB ? compoundHeight(this.drawableB) + this.drawablePad : 0);
    const availText = Math.min(wMode === MS_UNSPEC ? 100000 : wSize, this.maxW) - this.padL - this.padR - dlW;
    let w: number;
    const display = this.displayText() || "";
    if (wMode === MS_EXACTLY) {
      w = wSize;
      const measured = this.measuredLines(w - this.padL - this.padR - dlW);
      this.layout = measured instanceof Promise ? (yield measured) : measured;
    } else {
      const measured = this.measuredLines(availText);
      let lay = measured instanceof Promise ? (yield measured) : measured;
      let tw = 0;
      for (const line of lay.lines) tw = Math.max(tw, line.width);
      if (!display && this.hint) tw = Math.max(tw, measureText(this.paintT, this.hint));
      w = Math.max(Math.ceil(tw) + dlW, compoundWidth(this.drawableT), compoundWidth(this.drawableB)) + this.padL + this.padR;
      const min = vcallOn(thread, this, "getSuggestedMinimumWidth", "()I");
      w = Math.max(Math.min(Math.max(w, this.minW), this.maxW), Number(min instanceof Promise ? (yield min) : min));
      if (wMode === MS_AT_MOST) w = Math.min(w, wSize);
      // AOSP rebuilds the layout at the width the view actually got. Without this the lines
      // stay wrapped for the desired width, so a clamp leaves both the height (too few lines)
      // and the draw (a line wider than the view, silently clipped) wrong.
      const finalAvail = w - this.padL - this.padR - dlW;
      if (finalAvail !== availText) {
        const measured = this.measuredLines(finalAvail);
        lay = measured instanceof Promise ? (yield measured) : measured;
      }
      this.layout = lay;
    }
    const lineCount = Math.max(this.layout?.lines.length ?? 0, display || this.hint ? 1 : 0, this.minLinesV);
    const vPad = this.padT + this.padB;
    let h = this.textHeight(lineCount) + vPad + dtH;
    if (this.layout) h = Math.max(h, layoutHeight(this.layout) + vPad + dtH);
    h = Math.min(h, this.maxH);
    h = Math.max(h, this.minH, (this.drawableL ? compoundHeight(this.drawableL) : 0) + vPad, (this.drawableR ? compoundHeight(this.drawableR) : 0) + vPad);
    if (specMode(hSpec) !== MS_EXACTLY) {
      const min = vcallOn(thread, this, "getSuggestedMinimumHeight", "()I");
      h = Math.max(h, Number(min instanceof Promise ? (yield min) : min));
    }
    this.measuredW = w;
    this.measuredH = resolveSize(h, hSpec);
    this.layoutWidthFor = w;
  }),
  "onDraw(Landroid/graphics/Canvas;)V": driven(function* (this: JTextView, cv: JCanvas): Gen {
    if (this.width() <= 0 || this.height() <= 0) return;
    const thread = curThread, ctx = cv.ctx;
    const display = this.displayText();
    const resolved = vcallOn(thread, this, "getTextAlignment", "()I");
    const alignment = Number(resolved instanceof Promise ? (yield resolved) : resolved);
    const direction = alignment === 5 || alignment === 6 ? vcallOn(thread, this, "getLayoutDirection", "()I") : 0;
    const layoutDirection = Number(direction instanceof Promise ? (yield direction) : direction);
    const hg = this.horizontalGravity(display || this.hint, alignment, layoutDirection);
    const showHint = !display && this.hint;
    const dlW = this.drawableL ? compoundWidth(this.drawableL) : 0;
    const drW = this.drawableR ? compoundWidth(this.drawableR) : 0;
    const contentL = this.padL + (dlW ? dlW + this.drawablePad : 0);
    const contentR = this.width() - this.padR - (drW ? drW + this.drawablePad : 0);
    const avail = contentR - contentL;
    if (this.layoutWidthFor !== this.width()) {
      const measured = this.measuredLines(avail);
      if (measured instanceof Promise) return measured.then(lay => {
        this.layout = lay; this.layoutWidthFor = this.width();
        return callSelf(textViewMethods, "onDraw(Landroid/graphics/Canvas;)V", this, cv);
      });
      this.layout = measured; this.layoutWidthFor = this.width();
    }
    const contentT = compoundPadT.call(this), contentB = this.height() - compoundPadB.call(this);
    const draw = async (d: JDrawable | null, x: number, y: number) => {
      if (!d) return;
      ctx.save(); ctx.translate(Math.trunc(x), Math.trunc(y));
      try { const result = drawChild(d, cv); if (result instanceof Promise) await result; }
      finally { ctx.restore(); }
    };
    if (this.drawableL) (yield draw(this.drawableL, this.padL, contentT + (contentB - contentT - compoundHeight(this.drawableL)) / 2));
    if (this.drawableR) (yield draw(this.drawableR, this.width() - this.padR - drW, contentT + (contentB - contentT - compoundHeight(this.drawableR)) / 2));
    if (this.drawableT) (yield draw(this.drawableT, contentL + (avail - compoundWidth(this.drawableT)) / 2, this.padT));
    if (this.drawableB) (yield draw(this.drawableB, contentL + (avail - compoundWidth(this.drawableB)) / 2, this.height() - this.padB - compoundHeight(this.drawableB)));
    const pending = showHint ? (this.hintLayouts ??= new TextViewLayouts()).get(this, this.hint, avail) : this.layout;
    const layout = pending instanceof Promise ? (yield pending) : pending;
    if (!layout) return;
    const vg = gravityV(this.gravityT), height = Math.max(layoutHeight(layout), this.textHeight(1));
    const y = vg === 16 ? (contentB - contentT - height) / 2 + contentT : vg === 80 ? contentB - height : contentT;
    this.paintT.setColorValue(cslColor(showHint ? this.hintColors ?? this.colors : this.colors, this.drawableState()));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.width(), this.height()); ctx.clip();
    ctx.translate(contentL, y);
    try {
      const drawn = callOn(thread, () => drawTextViewLayout(layout, cv, hg));
      if (drawn instanceof Promise) (yield drawn);
    } finally { ctx.restore(); }
    if (this.editable && this.focused && this.cursorVisible && Math.floor((performance.now() - this.blinkStart) / 500) % 2 === 0) {
      const caretLayout = this.layout;
      if (!caretLayout) return;
      const caretGravity = this.horizontalGravity(display, alignment, layoutDirection);
      const cw = caretLayout.lines.at(-1)?.width ?? 0;
      const cx = caretGravity === 1 ? (avail + cw) / 2 : caretGravity === 5 ? avail : cw;
      const caretHeight = Math.max(layoutHeight(caretLayout), this.textHeight(1));
      const caretY = vg === 16 ? (contentB - contentT - caretHeight) / 2 + contentT : vg === 80 ? contentB - caretHeight : contentT;
      const cy = caretY + caretLayout.baseline(Math.max(0, caretLayout.lines.length - 1));
      const cursor = (yield textCursorDrawable(this));
      if (!cursor) return;
      const padding = new JRect();
      (yield vcallOn(thread, cursor, "getPadding", "(Landroid/graphics/Rect;)Z", padding));
      const width = (yield drawableSize(cursor, false, thread));
      const left = Math.min(Math.max(0, Math.trunc(cx - 0.5)) - padding.left, avail - width + padding.right);
      (yield vcallOn(thread, cursor, "setBounds", "(IIII)V", 0, 0, width, this.lineHeight() + padding.top + padding.bottom));
      (yield draw(cursor, contentL + left, cy - this.ascent() - padding.top));
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
function applyButtonDefaults(b: JButton): unknown { return rt.drive(applyButtonDefaults$(b)); }
function* applyButtonDefaults$(b: JButton): Gen {
  b.clickable = true;
  // AOSP's Widget.Material.Button supplies these; they are DEFAULTS, not overrides. A style
  // that spoke for itself — every Material3 button is sentence-case with its own face — has
  // already run in applyTvStyle, and forcing them here undid it.
  if (b.capsSet === undefined) b.allCaps = true;
  if (b.paintT.tf === tfDefault) b.paintT.tf = tfMedium;
}

export class JEditText extends JTextView {
  constructor() {
    super();
    this.editable = true;
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
    "getSelectionStart()I": driven(function* (this: JEditText): Gen { const [start] = (yield textSelection(this.getEditable())); return start >= 0 ? start : this.text.length; }),
    "getSelectionEnd()I": driven(function* (this: JEditText): Gen { const [, end] = (yield textSelection(this.getEditable())); return end >= 0 ? end : this.text.length; }),
    "setSelection(I)V": function (this: JEditText, index: number) { return setTextSelection(this.getEditable(), index, index); },
    "setSelection(II)V": function (this: JEditText, start: number, end: number) { return setTextSelection(this.getEditable(), start, end); },
    "selectAll()V": function (this: JEditText) { return setTextSelection(this.getEditable(), 0, this.text.length); },
    "performClick()Z": driven(function* (this: JEditText): Gen {
      (yield vcall(this, "requestFocus", "()Z"));
      if (this.clickL) (yield vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this));
      return 1;
    }),
  },
});
export let focusedEdit: JEditText | null = null;
/** The shell's hidden text control mirrors the focused EditText. */
export let inputEl: HTMLInputElement | HTMLTextAreaElement | null = null;
export function setInputElement(el: HTMLInputElement | HTMLTextAreaElement) { inputEl = el; }
setFocusHook((v, on) => {
  if (v instanceof JEditText) focusEditText(on ? v : null);
  else if (on && focusedEdit) focusEditText(null);
});
/**
 * TextView.onEditorAction: the listener first; then AOSP's defaults — NEXT/PREVIOUS move focus
 * on and DONE closes the keyboard, both of which leave the field here, while any other action
 * (SEARCH, GO, SEND, or none) is delivered as an ENTER key press to the view, which is what a
 * field that listens with an OnKeyListener rather than an editor-action listener receives.
 */
export function editorAction(tv: JTextView, action: number): boolean | Promise<boolean> { return rt.drive(editorAction$(tv, action)); }
function* editorAction$(tv: JTextView, action: number): Gen<boolean> {
  if (tv.editorActionL && (yield vcall(tv.editorActionL, "onEditorAction",
    "(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z", tv, action, null))) return true;
  if (action === 5 || action === 6 || action === 7) { if (tv === focusedEdit) focusEditText(null); return false; }
  rt.link("android/view/KeyEvent");
  for (const act of [0, 1]) (yield vcall(tv, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", (yield newObj("android/view/KeyEvent", "(II)V", act, 66))));
  return true;
}
/** the IME action key on the focused field */
export function fireEditorAction(): boolean | Promise<boolean> {
  const et = focusedEdit;
  return et ? editorAction(et, (et.imeOptions & 0xff) || 0) : Promise.resolve(false);
}
export function focusEditText(et: JEditText | null) {
  if (focusedEdit === et) return;
  if (focusedEdit) focusedEdit.focused = false;
  focusedEdit = et;
  if (et) { et.focused = true; et.blinkStart = performance.now(); }
  if (inputEl) {
    if (et) {
      inputEl.value = et.text;
      if (et.showSoftInputOnFocus) inputEl.focus(); else inputEl.blur();
    } else inputEl.blur();
  }
  invalidate();
}
export function editInput(text: string): unknown { return rt.drive(editInput$(text)); }
function* editInput$(text: string): Gen {
  if (!focusedEdit) return;
  focusedEdit.text = text;
  focusedEdit.rawText = text;
  focusedEdit.layoutWidthFor = -1;
  focusedEdit.blinkStart = performance.now();
  requestLayout(focusedEdit);
  (yield focusedEdit.notifyWatchers());
}

// ── InputFilter + common implementations (maxLength, allCaps). Needed for EditText inflation.
class JLengthFilter extends JObj { max = 0; }
rt.register({
  name: "android/text/InputFilter$LengthFilter", ctor: JLengthFilter,
  ifaces: ["android/text/InputFilter"],
  methods: {
    "<init>(I)V": function (this: JLengthFilter, m: number) { this.max = m; },
    "getMax()I": function (this: JLengthFilter) { return this.max; },
    "filter(Ljava/lang/CharSequence;IILandroid/text/Spanned;II)Ljava/lang/CharSequence;":
      function (this: JLengthFilter, src: unknown) { return null; }, // null = accept as-is (length enforced at input time)
  },
});
rt.register({
  name: "android/text/InputFilter$AllCaps", ctor: class extends JObj {},
  ifaces: ["android/text/InputFilter"],
  methods: {
    "<init>()V": function () {},
    "filter(Ljava/lang/CharSequence;IILandroid/text/Spanned;II)Ljava/lang/CharSequence;":
      function (this: JObj, src: unknown) { return src == null ? null : spannedString(src).toUpperCase(); },
  },
});

rt.markers("android/widget/Checkable");
