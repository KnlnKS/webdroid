// A TextView's text as AOSP lays it out: StaticLayout over the minikin boundary, built as
// TextView.makeSingleLayout builds it, measured as TextView.onMeasure measures it, drawn by
// Layout.draw. The view keeps up to two layouts, by width and alignment.
import { type JObj, rt, driven, type Gen } from "../jvm/runtime";
import { mangleStaticField } from "../jvm/abi";
import { after, callOn, curThread, linkInit, scall, vcall } from "../jvm/natives/jlang";
import { csLength } from "../jvm/natives/jchars";
import { perf } from "../perf";
import type { JTextView } from "./textview";

/** SingleLineTransformationMethod */
const singleLine = (s: string) => s.replace(/\n/g, " ").replace(/\r/g, "﻿");
/** a CharSequence as AllCapsTransformationMethod and SingleLineTransformationMethod make it, spans kept */
const transformSpanned = driven(function* transformSpanned(tv: JTextView, source: unknown): Gen {
  let text = source;
  if (tv.allCaps) text = yield scall("android/text/TextUtils", "toUpperCase", "(Ljava/util/Locale;Ljava/lang/CharSequence;Z)Ljava/lang/CharSequence;",
    yield vcall(tv.paintT, "getTextLocale", "()Ljava/util/Locale;"), text, +rt.iof(text, "android/text/Spanned"));
  if (tv.singleLine) text = yield vcall(yield scall("android/text/method/SingleLineTransformationMethod", "getInstance", "()Landroid/text/method/SingleLineTransformationMethod;"),
    "getTransformation", "(Ljava/lang/CharSequence;Landroid/view/View;)Ljava/lang/CharSequence;", text, tv);
  return text;
});

const LAYOUT = "android/text/Layout", SL = "Landroid/text/StaticLayout$Builder;";
/** Layout.Alignment's constants, by horizontal gravity: left, center, right */
export const enum Align { LEFT = 3, CENTER = 1, RIGHT = 5 }
const ALIGNMENTS: Record<Align, string> = { [Align.LEFT]: "ALIGN_LEFT", [Align.CENTER]: "ALIGN_CENTER", [Align.RIGHT]: "ALIGN_RIGHT" };
const enumConstant = driven(function* enumConstant(cls: string, name: string): Gen<JObj> {
  return (yield linkInit(cls)).ctor[mangleStaticField(name)];
});

/** AOSP's setters call requestLayout() and invalidate() on the view itself, which a subclass may override */
export function relayout(tv: JTextView): unknown {
  return after(vcall(tv, "requestLayout", "()V"), () => vcall(tv, "invalidate", "()V"));
}

/** what the view reads of its layout */
export interface TextViewLayout { java: JObj; width: number; align: Align; lines: number; height: number }

export class TextViewLayouts {
  private source: unknown = null;
  private display: unknown = "";
  private key = "";
  private layouts: TextViewLayout[] = [];
  /** the text as laid out: after allCaps and single-line transformation */
  private prepare(tv: JTextView, source: unknown): unknown {
    const tp = tv.tp, key = [tp.font(), tp.letterSpacingEm, tp.textScaleX, tp.wordSpacing, tv.allCaps, tv.maxLinesV, tv.singleLine, tv.ellipsizeEnd, tv.lineSpacingMult,
      tv.lineSpacingExtra, tv.includePad, tv.breakStrategy, tv.hyphenation, tv.fallbackLineSpacing].join();
    if (source === this.source && key === this.key) return this.display;
    this.source = source; this.key = key; this.layouts = [];
    if (typeof source === "string") {
      const upper = tv.allCaps ? source.toUpperCase() : source;
      return this.display = tv.singleLine ? singleLine(upper) : upper;
    }
    if (!tv.allCaps && !tv.singleLine) return this.display = source;
    return after(transformSpanned(tv, source), (display) => this.source === source ? this.display = display : display);
  }
  /** Layout.getDesiredWidth: the widest paragraph, unwrapped, rounded up as TextView.desired does */
  desiredWidth(tv: JTextView, source: unknown): number | Promise<number> {
    return after(this.prepare(tv, source), (text) => after(callOn(curThread, () =>
      scall(LAYOUT, "getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F", text, tv.paintT)), Math.ceil));
  }
  get(tv: JTextView, source: unknown, width: number, align: Align): TextViewLayout | Promise<TextViewLayout> {
    width = Math.max(0, width);
    return after(this.prepare(tv, source), (text) => {
      const cached = this.layouts.find(l => l.width === width && l.align === align);
      if (cached) { perf.wrapHits++; return cached; }
      perf.wraps++;
      return after(build(tv, text, width, align), (layout) => {
        this.layouts.unshift(layout); this.layouts.length = Math.min(2, this.layouts.length);
        return layout;
      });
    });
  }
}

/** TextView.makeSingleLayout's StaticLayout */
const build = driven(function* build(tv: JTextView, text: unknown, width: number, align: Align): Gen<TextViewLayout> {
  const length: number = yield csLength(text);
  // a single line without ellipsis is laid out as wide as it needs, as horizontal scrolling does
  const wide = tv.singleLine && !tv.ellipsizeEnd ? Math.max(width, Math.ceil(yield scall(LAYOUT, "getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F", text, tv.paintT))) : width;
  let b = yield scall("android/text/StaticLayout$Builder", "obtain", `(Ljava/lang/CharSequence;IILandroid/text/TextPaint;I)${SL}`, text, 0, length, tv.paintT, wide);
  b = yield vcall(b, "setAlignment", `(Landroid/text/Layout$Alignment;)${SL}`, yield enumConstant("android/text/Layout$Alignment", ALIGNMENTS[align]));
  b = yield vcall(b, "setLineSpacing", `(FF)${SL}`, tv.lineSpacingExtra, tv.lineSpacingMult);
  b = yield vcall(b, "setIncludePad", `(Z)${SL}`, +tv.includePad);
  b = yield vcall(b, "setUseLineSpacingFromFallbacks", `(Z)${SL}`, +tv.fallbackLineSpacing);
  b = yield vcall(b, "setBreakStrategy", `(I)${SL}`, tv.breakStrategy);
  b = yield vcall(b, "setHyphenationFrequency", `(I)${SL}`, tv.hyphenation);
  b = yield vcall(b, "setMaxLines", `(I)${SL}`, tv.singleLine ? 1 : Number.isFinite(tv.maxLinesV) ? tv.maxLinesV : 0x7fffffff);
  if (tv.ellipsizeEnd) {
    b = yield vcall(b, "setEllipsize", `(Landroid/text/TextUtils$TruncateAt;)${SL}`, yield enumConstant("android/text/TextUtils$TruncateAt", "END"));
    b = yield vcall(b, "setEllipsizedWidth", `(I)${SL}`, width);
  }
  const java: JObj = yield vcall(b, "build", "()Landroid/text/StaticLayout;");
  const lines: number = yield vcall(java, "getLineCount", "()I");
  // TextView.getDesiredHeight: lines past maxLines take no height
  const shown = Math.min(lines, tv.singleLine ? 1 : Number.isFinite(tv.maxLinesV) ? tv.maxLinesV : lines);
  return { java, width, align, lines: shown, height: yield vcall(java, "getLineTop", "(I)I", shown) };
});
