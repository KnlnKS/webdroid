// A TextView's text as AOSP lays it out: StaticLayout over the minikin boundary, built as
// TextView.makeSingleLayout builds it, measured as TextView.onMeasure measures it, drawn by
// Layout.draw. The view keeps up to two layouts, by width and alignment.
import { JSpanned, JSpannable } from "./text";
import { type JObj, driven, type Gen } from "../jvm/runtime";
import { mangleStaticField } from "../jvm/abi";
import { callOn, curThread, linkInit, scall, vcall } from "../jvm/natives/jlang";
import { perf } from "../perf";
import type { JTextView } from "./textview";

/** a copy of `source` with each character mapped, keeping its spans where they were */
function mapChars(source: string | JSpanned, map: (text: string) => string): string | JSpanned {
  if (typeof source === "string") return map(source);
  const result = new JSpannable(), offsets = new Uint32Array(source.text.length + 1);
  let at = 0;
  for (const char of source.text) {
    offsets[at] = result.text.length;
    if (char.length === 2) offsets[at + 1] = result.text.length + 1;
    result.text += map(char); at += char.length;
  }
  offsets[at] = result.text.length;
  result.spans = source.spans.map(s => ({ ...s, start: offsets[s.start], end: offsets[s.end] }));
  return result;
}
/** SingleLineTransformationMethod */
const singleLine = (s: string) => s.replace(/\n/g, " ").replace(/\r/g, "﻿");

const LAYOUT = "android/text/Layout", SL = "Landroid/text/StaticLayout$Builder;";
/** Layout.Alignment's constants, by horizontal gravity: left, center, right */
export const enum Align { LEFT = 3, CENTER = 1, RIGHT = 5 }
const ALIGNMENTS: Record<Align, string> = { [Align.LEFT]: "ALIGN_LEFT", [Align.CENTER]: "ALIGN_CENTER", [Align.RIGHT]: "ALIGN_RIGHT" };
const enumConstant = driven(function* enumConstant(cls: string, name: string): Gen<JObj> {
  return (yield linkInit(cls)).ctor[mangleStaticField(name)];
});

/** what the view reads of its layout */
export interface TextViewLayout { java: JObj; width: number; align: Align; lines: number; height: number }

export class TextViewLayouts {
  private source: string | JSpanned | null = null;
  private display: string | JSpanned = "";
  private key = "";
  private layouts: TextViewLayout[] = [];
  /** the text as laid out: after allCaps and single-line transformation */
  private prepare(tv: JTextView, source: string | JSpanned): string | JSpanned {
    const key = [tv.paintT.font(), tv.paintT.letterSpacingEm, tv.allCaps, tv.maxLinesV, tv.singleLine, tv.ellipsizeEnd, tv.lineSpacingMult,
      tv.lineSpacingExtra, tv.includePad, tv.breakStrategy, tv.hyphenation, tv.fallbackLineSpacing].join();
    if (source !== this.source || key !== this.key) {
      this.source = source; this.key = key; this.layouts = [];
      let display = tv.allCaps ? mapChars(source, (s) => s.toUpperCase()) : source;
      if (tv.singleLine) display = mapChars(display, singleLine);
      this.display = display;
    }
    return this.display;
  }
  /** Layout.getDesiredWidth: the widest paragraph, unwrapped, rounded up as TextView.desired does */
  desiredWidth(tv: JTextView, source: string | JSpanned): number | Promise<number> {
    const text = this.prepare(tv, source);
    const w = callOn(curThread, () => scall(LAYOUT, "getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F", text, tv.paintT));
    return w instanceof Promise ? w.then(Math.ceil) : Math.ceil(w as number);
  }
  get(tv: JTextView, source: string | JSpanned, width: number, align: Align): TextViewLayout | Promise<TextViewLayout> {
    width = Math.max(0, width);
    const text = this.prepare(tv, source), cached = this.layouts.find(l => l.width === width && l.align === align);
    if (cached) { perf.wrapHits++; return cached; }
    perf.wraps++;
    const built = build(tv, text, width, align);
    const keep = (layout: TextViewLayout) => {
      this.layouts.unshift(layout); this.layouts.length = Math.min(2, this.layouts.length);
      return layout;
    };
    return built instanceof Promise ? built.then(keep) : keep(built);
  }
}

/** TextView.makeSingleLayout's StaticLayout */
const build = driven(function* build(tv: JTextView, text: string | JSpanned, width: number, align: Align): Gen<TextViewLayout> {
  const length = typeof text === "string" ? text.length : text.text.length;
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
