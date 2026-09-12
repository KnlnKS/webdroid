import { AID, resString } from "./res";
import { JView, requestLayout, initViewFromCtx, guardCall, invalidate, specMode, specSize, MS_UNSPEC, MS_EXACTLY, MS_AT_MOST, resolveSizeAndState, setFocusHook, removeFrom } from "./view";
import {
  type JColorStateList, mkCsl, type JDrawable, loadColorStateList, loadDrawableRV, cslColor, loadDrawable,
  drawChild
} from "./drawable";
import { JTextPaint, JEditable, spannedString, mkStaticLayout } from "./text";
import { G, gravityV, gravityH } from "./gravity";
import { device } from "../shell/config";
import {
  fontDescent, fontAscent, fontTop, fontBottom, measureText, typefaceFor, JTypeface, tfDefault, type JRect,
  type JCanvas, cssColor, tfMedium
} from "./graphics";
import { vcall, mkEnumSet, newObj } from "../jvm/natives/jlang";
import {
  attrTable, type Resources, resolveStyleValue, rvDimen, rvColor, rvInt, type RV, rvString, type JAttrSet,
  obtainStyled
} from "./res";
import { TV } from "./axml";
import { fontResource } from "./fonts";
import { type NativeSpec, callSelf, rt, JObj, stubs, noops } from "../jvm/runtime";
import { jarray, mangleMethod } from "../jvm/abi";
import { usLocale } from "../jvm/natives/jvalues";
import { perf } from "../perf";

/** one wrap result: the lines, each line's width, and the widest */
export type Wrapped = { lines: string[]; widths: number[]; maxW: number };
const NO_LINES: Wrapped = { lines: [], widths: [], maxW: 0 };
/**
 * Line breaking memo. Every input the breaker reads is part of the key, so any change that alters
 * the lines misses and nothing has to invalidate it; letter spacing is keyed on its own because
 * font() leaves it out. Two widths are kept because onMeasure wraps at the space it is offered
 * and then at the width it settles on.
 */
class WrapMemo {
  text = ""; font = ""; ls = NaN; max = NaN; single = false; ell = false;
  a0 = NaN; w0 = NO_LINES; a1 = NaN; w1 = NO_LINES;
  get(tv: JTextView, text: string, avail: number): Wrapped {
    const p = tv.paintT, font = p.font();
    if (text === this.text && font === this.font && p.letterSpacingEm === this.ls && tv.maxLinesV === this.max &&
        tv.singleLine === this.single && tv.ellipsizeEnd === this.ell) {
      if (avail === this.a0) { perf.wrapHits++; return this.w0; }
      if (avail === this.a1) { perf.wrapHits++; return this.w1; }
    } else {
      this.text = text; this.font = font; this.ls = p.letterSpacingEm; this.max = tv.maxLinesV;
      this.single = tv.singleLine; this.ell = tv.ellipsizeEnd;
      this.a0 = this.a1 = NaN;
    }
    const lines = tv.breakLines(text, avail), widths = new Array<number>(lines.length);
    let maxW = 0;
    for (let i = 0; i < lines.length; i++) { const w = measureText(p, lines[i]); widths[i] = w; if (w > maxW) maxW = w; }
    this.a1 = this.a0; this.w1 = this.w0;
    this.a0 = avail;
    return (this.w0 = { lines, widths, maxW });
  }
}

export class JTextView extends JView {
  /** kept for the app to read back; text is drawn untransformed */
  transformation: unknown = null;
  editableFactory: unknown = null; spannableFactory: unknown = null;
  keyListener: unknown = null; movementMethod: unknown = null; selActionMode: unknown = null; editorActionL: unknown = null;
  drawableTint: JColorStateList | null = null;
  imeOptions = 0; breakStrategy = 0; hyphenation = 0; autoSizeType = 0;
  linksClickable = true; fontVariation: string | null = null;
  maxW = Infinity;
  /** getLayout's StaticLayout and the inputs it was built from */
  layoutObj: unknown = null;
  layoutText = ""; layoutW = NaN; layoutFont = ""; layoutMax = NaN; layoutLS = NaN; layoutMult = NaN; layoutExtra = NaN;
  text = "";
  rawText: unknown = "";       // original CharSequence (may be Spannable)
  hint = "";
  paintT = new JTextPaint();
  colors: JColorStateList = mkCsl(-16777216);
  hintColors: JColorStateList = mkCsl(1627389952);
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
  /** when the caret last restarted its blink: focus and every edit, as AOSP's Editor.Blink does */
  blinkStart = 0;
  /** the lines this view laid out and draws, with each line's width */
  lines: string[] = [];
  lineWidths: number[] = [];
  wrapMemo: WrapMemo | null = null; hintMemo: WrapMemo | null = null;
  layoutWidthFor = -1;
  inputTypeV = 1;
  styleBits = 0;
  includePad = true;

  constructor() {
    super();
    this.paintT.textSize = device.dp(14); // AOSP TextView default, 14sp
    this.paintT.color = -16777216;
  }
  private upperOf = ""; private upper = "";
  displayText(): string {
    if (!this.allCaps) return this.text;
    if (this.upperOf !== this.text) { this.upperOf = this.text; this.upper = this.text.toUpperCase(); }
    return this.upper;
  }
  lineHeight(): number {
    return Math.round((fontDescent(this.paintT) - fontAscent(this.paintT)) * this.lineSpacingMult + this.lineSpacingExtra);
  }
  /** includeFontPadding (AOSP's default): the first line's box starts at the font's `top` and the
   *  last one's ends at its `bottom`, so a line box is taller than ascent..descent at both ends. */
  topPad(): number { return this.includePad ? Math.round(fontAscent(this.paintT) - fontTop(this.paintT)) : 0; }
  bottomPad(): number { return this.includePad ? Math.round(fontBottom(this.paintT) - fontDescent(this.paintT)) : 0; }
  textHeight(lines: number): number { return lines * this.lineHeight() + this.topPad() + this.bottomPad(); }
  ascent(): number { return Math.round(-fontAscent(this.paintT)) + this.topPad(); }
  /** line breaking of `text` at `avail`: a pure function of its arguments, the paint and the
   *  flags WrapMemo keys on. Callers go through linesFor/hintFor. */
  breakLines(text: string, avail: number): string[] {
    perf.wraps++;
    if (avail <= 0) return text ? [text] : [];
    // measureText memoises on (font, string) and applies letter spacing; ctx.measureText did
    // neither, so every probe of the break search went to the browser and no line accounted for
    // android:letterSpacing that android.text.* has always honoured.
    const mw = (t: string) => measureText(this.paintT, t);
    const out: string[] = [];
    for (const hard of text.split("\n")) {
      if (this.singleLine || this.maxLinesV === 1) { out.push(hard); break; }
      if (mw(hard) <= avail) { out.push(hard); continue; }
      // a word wider than the line is hard-broken; emit full lines and return what is left over
      const breakWide = (l: string) => {
        while (mw(l) > avail && l.length > 1) {
          let lo = 1, hi = l.length;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (mw(l.slice(0, mid)) <= avail) lo = mid;
            else hi = mid - 1;
          }
          out.push(l.slice(0, lo));
          l = l.slice(lo);
        }
        return l;
      };
      let line = "";
      for (const word of hard.split(/(\s+)/)) {
        if (!word) continue;
        if (mw(line + word) <= avail || !line) line = breakWide(line + word);
        else {
          // the pending line can itself be one over-long word, parked here by an earlier break
          const rest = breakWide(line.trimEnd());
          if (rest) out.push(rest);
          line = word.trimStart();
        }
      }
      if (line) { const rest = breakWide(line.trimEnd()); if (rest) out.push(rest); }
    }
    while (out.length > this.maxLinesV) out.pop();
    if (out.length && this.ellipsizeEnd) {
      const last = out[out.length - 1];
      let shown = out.length - 1;
      for (const l of out) shown += l.length;
      if (shown < text.length && mw(last) > 0) {
        let l = last;
        while (l.length && mw(l + "…") > avail) l = l.slice(0, -1);
        out[out.length - 1] = l + "…";
      }
    }
    return out;
  }
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
  /** the text's lines at `avail` */
  linesFor(avail: number): Wrapped { return (this.wrapMemo ??= new WrapMemo()).get(this, this.displayText(), avail); }
  /** an empty field draws its hint every frame, so the hint keeps a memo of its own */
  private hintUpperOf = ""; private hintUpper = "";
  hintFor(avail: number): Wrapped {
    let hint = this.hint;
    if (this.allCaps) {
      if (this.hintUpperOf !== hint) { this.hintUpperOf = hint; this.hintUpper = hint.toUpperCase(); }
      hint = this.hintUpper;
    }
    return (this.hintMemo ??= new WrapMemo()).get(this, hint, avail);
  }
  useLines(w: Wrapped) { this.lines = w.lines; this.lineWidths = w.widths; }
}
const tvAttr = attrTable(
  "text", "textSize", "textColor", "textStyle", "textAppearance", "hint", "gravity", "maxLines",
  "minLines", "lines", "singleLine", "ellipsize", "lineSpacingExtra", "lineSpacingMultiplier",
  "drawableLeft", "drawableTop", "drawableRight", "drawableBottom", "drawablePadding", "drawableStart",
  "drawableEnd", "fontFamily", "textAllCaps", "textColorHint", "inputType", "letterSpacing", "maxLength",
  "imeOptions", "includeFontPadding", "ems", "minEms", "minWidth");

async function applyTextAppearance(tv: JTextView, res: Resources, styleId: number) {
  if (!styleId) return;
  const look = (name: string) => resolveStyleValue(res, tv.theme, res.styleLookup(styleId, AID(name)));
  const ts = look("textSize");
  if (ts) tv.paintT.textSize = rvDimen(res, ts, tv.paintT.textSize);
  const tc = look("textColor");
  if (tc) {
    if (tc.t === TV.REFERENCE) tv.colors = await loadColorStateList(res, tc.d, tv.theme);
    else tv.colors = mkCsl(rvColor(res, tc, -16777216));
  }
  const st = look("textStyle");
  if (st) tv.styleBits = rvInt(res, st, 0);
  await applyFontFamily(tv, res, look("fontFamily"));
  const caps = look("textAllCaps");
  if (caps) { tv.allCaps = !!rvInt(res, caps, 0); tv.capsSet = true; }
}
/** `android:fontFamily` is either a system family name or a reference to a @font/ resource —
 *  a bare .ttf or a <font-family> XML. Apps ship their own fonts and name them this way. */
async function applyFontFamily(tv: JTextView, res: Resources, v: RV | null) {
  if (!v) return;
  if (v.t === TV.REFERENCE && v.d) {
    const tf = await fontResource(res, v.d);
    if (tf) tv.paintT.tf = tf;
    return;
  }
  const fam = rvString(res, v);
  if (fam) tv.paintT.tf = typefaceFor(fam);
}
export async function applyTvStyle(tv: JTextView, set: JAttrSet | null, defStyleAttr: number) {
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
  ];
  const ta = obtainStyled(res, tv.theme, set, ids, defStyleAttr, 0);
  const g = (i: number) => ta.vals[i];
  const taRef = g(4);
  if (taRef && taRef.t === TV.REFERENCE) await applyTextAppearance(tv, res, taRef.d);
  if (g(1)) tv.paintT.textSize = rvDimen(res, g(1), tv.paintT.textSize);
  if (g(2)) {
    const v = g(2)!;
    if (v.t === TV.REFERENCE) tv.colors = await loadColorStateList(res, v.d, tv.theme);
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
  if (dl) tv.drawableL = await loadDrawableRV(res, dl, tv.theme);
  if (dt) tv.drawableT = await loadDrawableRV(res, dt, tv.theme);
  if (dr) tv.drawableR = await loadDrawableRV(res, dr, tv.theme);
  if (db) tv.drawableB = await loadDrawableRV(res, db, tv.theme);
  if (g(14)) tv.drawablePad = Math.round(rvDimen(res, g(14), 0));
  await applyFontFamily(tv, res, g(15));
  if (g(16)) { tv.allCaps = !!rvInt(res, g(16), 0); tv.capsSet = true; }
  if (g(17)) {
    const v = g(17)!;
    tv.hintColors = v.t === TV.REFERENCE ? await loadColorStateList(res, v.d, tv.theme) : mkCsl(rvColor(res, v, 1627389952));
  }
  if (g(18)) tv.inputTypeV = rvInt(res, g(18), 1);
  if (g(19)) tv.lineSpacingExtra = rvDimen(res, g(19), 0);
  if (g(20)) tv.lineSpacingMult = g(20)!.t === TV.FLOAT ? g(20)!.d : 1;
  if (g(28)) tv.includePad = !!rvInt(res, g(28), 1);
  // the action the IME key performs: a search field declares it here and nowhere else
  if (g(29)) tv.imeOptions = rvInt(res, g(29), 0);
  if (tv.styleBits & 1) tv.paintT.fakeBold = true;
  if (tv.styleBits & 2) tv.paintT.tf = (() => { const t = new JTypeface(); t.family = tv.paintT.tf.family; t.italic = true; t.weight = tv.paintT.tf.weight; return t; })();
}
function setTextAppearance(this: JTextView, id: number) {
  return this.jres ? applyTextAppearance(this, this.jres, id) : undefined;
}
function setCompoundDrawables(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null) {
  this.drawableL = l; this.drawableT = t; this.drawableR = r; this.drawableB = b;
  requestLayout(this);
}
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
function compoundPadL(this: JTextView) { return this.padL + (this.drawableL ? this.drawableL.intrinsicW() + this.drawablePad : 0); }
function compoundPadR(this: JTextView) { return this.padR + (this.drawableR ? this.drawableR.intrinsicW() + this.drawablePad : 0); }
function compoundPadT(this: JTextView) { return this.padT + (this.drawableT ? this.drawableT.intrinsicH() + this.drawablePad : 0); }
function compoundPadB(this: JTextView) { return this.padB + (this.drawableB ? this.drawableB.intrinsicH() + this.drawablePad : 0); }
export const textViewMethods: NonNullable<NativeSpec["methods"]> = {
  ...textViewCtors("textViewStyle"),
  // AOSP routes every setText through the two-arg form, and that is the one apps override:
  // Material's Chip hands the text to its ChipDrawable there and nowhere else, and without it
  // the drawable measures itself with no text at all.
  "setText(Ljava/lang/CharSequence;)V": function (this: JTextView, cs: unknown) {
    return vcall(this, "setText", "(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V", cs, bufferTypes[0]);
  },
  "setText(I)V": async function (this: JTextView, id: number) {
    const s = this.jres ? resString(this.jres, id) : "";
    await guardCall(this, mangleMethod("setText", "(Ljava/lang/CharSequence;)V"), s);
  },
  "setText(Ljava/lang/CharSequence;Landroid/widget/TextView$BufferType;)V": async function (this: JTextView, cs: unknown) {
    this.rawText = cs;
    const t = spannedString(cs);
    if (t !== this.text) {
      this.text = t;
      this.layoutWidthFor = -1;
      requestLayout(this);
      await this.notifyWatchers();
    }
  },
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
  "getTextColors()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.colors; },
  "getCurrentTextColor()I": function (this: JTextView) { return cslColor(this.colors, this.drawableState()); },
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
  "setMaxLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n || Infinity; requestLayout(this); },
  "getMaxLines()I": function (this: JTextView) { return Number.isFinite(this.maxLinesV) ? this.maxLinesV : 0x7fffffff; },
  "setMinLines(I)V": function (this: JTextView, n: number) { this.minLinesV = n; requestLayout(this); },
  "setLines(I)V": function (this: JTextView, n: number) { this.maxLinesV = n; this.minLinesV = n; requestLayout(this); },
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
  "setTextAppearance(Landroid/content/Context;I)V": function (this: JTextView, c: unknown, id: number) { return setTextAppearance.call(this, id); },
  "setTextAppearance(I)V": setTextAppearance,
  "setCompoundDrawablesWithIntrinsicBounds(IIII)V": async function (this: JTextView, l: number, t: number, r: number, b: number) {
    const res = this.jres!;
    const [dl, dt, dr, db] = await Promise.all([l, t, r, b].map((id) => (id ? loadDrawable(res, id, this.theme) : null)));
    setCompoundDrawables.call(this, dl, dt, dr, db);
  },
  "setCompoundDrawablesWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawables(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "getCompoundDrawables()[Landroid/graphics/drawable/Drawable;": compoundDrawables,
  "setCompoundDrawablePadding(I)V": function (this: JTextView, p: number) { this.drawablePad = p; requestLayout(this); },
  "getCompoundDrawablePadding()I": function (this: JTextView) { return this.drawablePad; },
  "getCompoundPaddingLeft()I": compoundPadL,
  "getCompoundPaddingRight()I": compoundPadR,
  "getCompoundPaddingTop()I": compoundPadT,
  "getCompoundPaddingBottom()I": compoundPadB,
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
  "getImeOptions()I": function (this: JTextView) { return this.imeOptions; },
  "setKeyListener(Landroid/text/method/KeyListener;)V": function (this: JTextView, l: unknown) { this.keyListener = l; },
  "getKeyListener()Landroid/text/method/KeyListener;": function (this: JTextView) { return this.keyListener; },
  "setMovementMethod(Landroid/text/method/MovementMethod;)V": function (this: JTextView, m: unknown) { this.movementMethod = m; },
  "getMovementMethod()Landroid/text/method/MovementMethod;": function (this: JTextView) { return this.movementMethod; },
  "getCompoundDrawablesRelative()[Landroid/graphics/drawable/Drawable;": compoundDrawables,
  "setCompoundDrawablesRelative(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawablesRelativeWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
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
    if (this.layoutWidthFor < 0) return null;
    const dlW = this.drawableL ? Math.max(0, this.drawableL.intrinsicW()) + this.drawablePad : 0;
    const drW = this.drawableR ? Math.max(0, this.drawableR.intrinsicW()) + this.drawablePad : 0;
    const w = this.layoutWidthFor - this.padL - this.padR - dlW - drW;
    const p = this.paintT, text = this.displayText(), font = p.font();
    if (text !== this.layoutText || w !== this.layoutW || font !== this.layoutFont || this.maxLinesV !== this.layoutMax ||
        p.letterSpacingEm !== this.layoutLS || this.lineSpacingMult !== this.layoutMult || this.lineSpacingExtra !== this.layoutExtra) {
      this.layoutText = text; this.layoutW = w; this.layoutFont = font; this.layoutMax = this.maxLinesV;
      this.layoutLS = p.letterSpacingEm; this.layoutMult = this.lineSpacingMult; this.layoutExtra = this.lineSpacingExtra;
      this.layoutObj = mkStaticLayout(text, p, w, this.lineSpacingMult, this.lineSpacingExtra, Number.isFinite(this.maxLinesV) ? this.maxLinesV : undefined);
    }
    return this.layoutObj;
  },
  "getLineBounds(ILandroid/graphics/Rect;)I": function (this: JTextView, i: number, r: JRect) {
    const lh = this.lineHeight(), w = this.layoutWidthFor >= 0 ? this.layoutWidthFor : this.width();
    r.left = this.padL; r.right = Math.max(this.padL, w - this.padR); r.top = this.padT + i * lh; r.bottom = r.top + lh;
    return r.top + this.ascent();
  },
  "setMinWidth(I)V": function (this: JTextView, w: number) { this.minW = w; requestLayout(this); },
  ...noops("setCompoundDrawableTintMode(Landroid/graphics/PorterDuff$Mode;)V",
    "setTextLocales(Landroid/os/LocaleList;)V", "setImeHintLocales(Landroid/os/LocaleList;)V", "beginBatchEdit()V",
    "endBatchEdit()V", "setHighlightColor(I)V", "setHorizontallyScrolling(Z)V", "setMarqueeRepeatLimit(I)V",
    "setSelectAllOnFocus(Z)V", "setTextIsSelectable(Z)V", "setError(Ljava/lang/CharSequence;)V", "setAutoLinkMask(I)V",
    "setLinkTextColor(I)V", "setMaxEms(I)V", "setShadowLayer(FFFI)V", "setMaxHeight(I)V"),
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
  "getLineCount()I": function (this: JTextView) { return this.lines.length; },
  "getBaseline()I": function (this: JTextView) { return this.padT + this.ascent(); },
  "getEditableText()Landroid/text/Editable;": function (this: JTextView) { return this.getEditable(); },
  "setEnabled(Z)V": function (this: JTextView, e: number) { this.enabled = !!e; void this.refreshDrawableState(); },
  "onMeasure(II)V": function (this: JTextView, wSpec: number, hSpec: number) {
    const wMode = specMode(wSpec), wSize = specSize(wSpec);
    const dlW = (this.drawableL ? Math.max(0, this.drawableL.intrinsicW()) + this.drawablePad : 0)
      + (this.drawableR ? Math.max(0, this.drawableR.intrinsicW()) + this.drawablePad : 0);
    const dtH = (this.drawableT ? Math.max(0, this.drawableT.intrinsicH()) + this.drawablePad : 0)
      + (this.drawableB ? Math.max(0, this.drawableB.intrinsicH()) + this.drawablePad : 0);
    const availText = Math.min(wMode === MS_UNSPEC ? 100000 : wSize, this.maxW) - this.padL - this.padR - dlW;
    let w: number;
    const display = this.displayText() || "";
    if (wMode === MS_EXACTLY) {
      w = wSize;
      this.useLines(this.linesFor(w - this.padL - this.padR - dlW));
    } else {
      let lay = this.linesFor(availText);
      let tw = lay.maxW;
      if (!display && this.hint) tw = Math.max(tw, measureText(this.paintT, this.hint));
      w = Math.ceil(tw) + this.padL + this.padR + dlW;
      w = Math.min(Math.max(w, this.minW), this.maxW);
      if (wMode === MS_AT_MOST) w = Math.min(w, wSize);
      // AOSP rebuilds the layout at the width the view actually got. Without this the lines
      // stay wrapped for the desired width, so a clamp leaves both the height (too few lines)
      // and the draw (a line wider than the view, silently clipped) wrong.
      const finalAvail = w - this.padL - this.padR - dlW;
      if (finalAvail < availText) lay = this.linesFor(finalAvail);
      this.useLines(lay);
    }
    const lineCount = Math.max(this.lines.length, display || this.hint ? 1 : 0, this.minLinesV);
    const vPad = this.padT + this.padB;
    let h = this.textHeight(lineCount) + vPad + dtH;
    h = Math.max(h, this.minH, (this.drawableL ? this.drawableL.intrinsicH() : 0) + vPad, (this.drawableR ? this.drawableR.intrinsicH() : 0) + vPad);
    this.measuredW = w;
    this.measuredH = resolveSizeAndState(h, hSpec);
    this.layoutWidthFor = w;
  },
  "onDraw(Landroid/graphics/Canvas;)V": function (this: JTextView, cv: JCanvas) {
    const ctx = cv.ctx;
    const display = this.displayText();
    const showHint = !display && this.hint;
    const dlW = this.drawableL ? Math.max(0, this.drawableL.intrinsicW()) : 0;
    const drW = this.drawableR ? Math.max(0, this.drawableR.intrinsicW()) : 0;
    const contentL = this.padL + (dlW ? dlW + this.drawablePad : 0);
    const contentR = this.width() - this.padR - (drW ? drW + this.drawablePad : 0);
    if (this.drawableL) {
      const dh = Math.max(0, this.drawableL.intrinsicH());
      this.drawableL.bounds.left = this.padL;
      this.drawableL.bounds.top = (this.height() - dh) >> 1;
      this.drawableL.bounds.right = this.padL + dlW;
      this.drawableL.bounds.bottom = ((this.height() - dh) >> 1) + dh;
      drawChild(this.drawableL, cv);
    }
    if (this.drawableR) {
      const dh = Math.max(0, this.drawableR.intrinsicH());
      this.drawableR.bounds.left = this.width() - this.padR - drW;
      this.drawableR.bounds.top = (this.height() - dh) >> 1;
      this.drawableR.bounds.right = this.width() - this.padR;
      this.drawableR.bounds.bottom = ((this.height() - dh) >> 1) + dh;
      drawChild(this.drawableR, cv);
    }
    const avail = contentR - contentL;
    if (this.layoutWidthFor !== this.width()) {
      this.useLines(this.linesFor(avail));
      this.layoutWidthFor = this.width();
    }
    const hintLay = showHint ? this.hintFor(avail) : null;
    const lines = hintLay ? hintLay.lines : this.lines, widths = hintLay ? hintLay.widths : this.lineWidths;
    if (!lines.length && !this.editable) return;
    const lh = this.lineHeight();
    const totalH = this.textHeight(Math.max(1, lines.length));
    const vg = gravityV(this.gravityT);
    let y = (vg === 16 ? (this.height() - this.padT - this.padB - totalH) / 2 + this.padT
      : vg === 80 ? this.height() - this.padB - totalH : this.padT) + this.ascent();
    ctx.font = this.paintT.font();
    ctx.fillStyle = cssColor(showHint ? cslColor(this.hintColors, this.drawableState()) : cslColor(this.colors, this.drawableState()));
    ctx.textBaseline = "alphabetic";
    const hg = gravityH(this.gravityT);
    ctx.textAlign = hg === 1 ? "center" : hg === 5 ? "right" : "left";
    const x = hg === 1 ? (contentL + contentR) / 2 : hg === 5 ? contentR : contentL;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      ctx.fillText(line, x, y);
      if (this.paintT.strikeThru && line) {
        const w = widths[i];
        const sx = hg === 1 ? x - w / 2 : hg === 5 ? x - w : x;
        ctx.fillRect(sx, y - this.paintT.textSize * 0.3, w, Math.max(1, this.paintT.textSize / 14));
      }
      y += lh;
    }
    if (this.editable && this.focused && this.cursorVisible && Math.floor((performance.now() - this.blinkStart) / 500) % 2 === 0) {
      const cw = widths[lines.length - 1] ?? 0;
      const cx = (hg === 1 ? x + cw / 2 : hg === 5 ? x : x + cw) + 1;
      const cy = y - lh;
      ctx.fillStyle = cssColor(cslColor(this.colors, []));
      ctx.fillRect(cx, cy - this.ascent(), 3, lh);
    }
  },
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
async function applyButtonDefaults(b: JButton) {
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
    "getSelectionStart()I": function (this: JEditText) { return this.text.length; },
    "getSelectionEnd()I": function (this: JEditText) { return this.text.length; },
    ...noops("setSelection(I)V", "setSelection(II)V", "selectAll()V"),
    "performClick()Z": async function (this: JEditText) {
      focusEditText(this);
      if (this.clickL) await vcall(this.clickL, "onClick", "(Landroid/view/View;)V", this);
      return 1;
    },
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
export async function editorAction(tv: JTextView, action: number): Promise<boolean> {
  if (tv.editorActionL && await vcall(tv.editorActionL, "onEditorAction",
    "(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z", tv, action, null)) return true;
  if (action === 5 || action === 6 || action === 7) { if (tv === focusedEdit) focusEditText(null); return false; }
  rt.link("android/view/KeyEvent");
  for (const act of [0, 1]) await vcall(tv, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", await newObj("android/view/KeyEvent", "(II)V", act, 66));
  return true;
}
/** the IME action key on the focused field */
export function fireEditorAction(): Promise<boolean> {
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
      inputEl.focus();
    } else inputEl.blur();
  }
  invalidate();
}
export async function editInput(text: string) {
  if (!focusedEdit) return;
  focusedEdit.text = text;
  focusedEdit.rawText = text;
  focusedEdit.layoutWidthFor = -1;
  focusedEdit.blinkStart = performance.now();
  requestLayout(focusedEdit);
  await focusedEdit.notifyWatchers();
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
