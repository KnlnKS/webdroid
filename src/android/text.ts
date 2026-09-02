// android.text.* — TextPaint, TextUtils, Spannable/Editable (spans stored, minimally styled).

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { vcall, mkEnumSet, newObj } from "../jvm/natives/jlang";
import { type JDate } from "../jvm/natives/jtime";
import { JPaint, JCanvas, measureText, copyPaint, fontAscent, fontDescent, fillFontMetrics } from "./graphics";
import { device } from "../shell/config";
import { formatDate } from "../jvm/natives/jtext";
import { toJsArray } from "../jvm/natives/jutil";

export class JTextPaint extends JPaint {
  linkColor = -16776961;
  baselineShift = 0;
  drawableState: Int32Array | null = null;
  /** dp/sp-based span math (updateDrawState/updateMeasureState) reads this to scale —
   *  shares the one device-density constant, not a magic literal. */
  density = device.density;
}
rt.register({
  name: "android/text/TextPaint", ctor: JTextPaint, sup: "android/graphics/Paint",
  fields: { linkColor: "linkColor", baselineShift: "baselineShift", drawableState: "drawableState", density: "density" },
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "<init>(Landroid/graphics/Paint;)V": function (this: JTextPaint, p: JPaint) {
      if (p) copyPaint(p, this);
    },
    "set(Landroid/text/TextPaint;)V": function (this: JTextPaint, p: JTextPaint) { if (p) copyPaint(p, this); },
  },
});

// ── Spans (data-only carriers; TextView applies a small subset visually)
interface SpanRec { span: unknown; start: number; end: number; flags: number; }
export class JSpannable extends JObj {
  text = "";
  spans: SpanRec[] = [];
  // JObj has no JS toString, so String(spanned) anywhere in the framework read "[object Object]"
  toString() { return this.text; }
}
export function spannedString(s: unknown): string {
  if (s === null || s === undefined) return "";
  if (typeof s === "string") return s;
  if (s instanceof JSpannable) return s.text;
  if (s instanceof JEditable) return s.text;
  return String(s);
}
const spanMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/CharSequence;)V": function (this: JSpannable, cs: unknown) {
    this.text = spannedString(cs);
    if (cs instanceof JSpannable) this.spans = cs.spans.slice();
  },
  "length()I": function (this: JSpannable) { return this.text.length; },
  "charAt(I)C": function (this: JSpannable, i: number) { return this.text.charCodeAt(i); },
  "toString()Ljava/lang/String;": function (this: JSpannable) { return this.text; },
  "subSequence(II)Ljava/lang/CharSequence;": function (this: JSpannable, a: number, b: number) { return this.text.slice(a, b); },
  "setSpan(Ljava/lang/Object;III)V": function (this: JSpannable, span: unknown, start: number, end: number, flags: number) {
    this.spans.push({ span, start, end, flags });
  },
  "removeSpan(Ljava/lang/Object;)V": function (this: JSpannable, span: unknown) {
    this.spans = this.spans.filter((s) => s.span !== span);
  },
  "getSpans(IILjava/lang/Class;)[Ljava/lang/Object;": function (this: JSpannable, start: number, end: number, cls: any) {
    const name = cls?.ci?.name;
    const out = this.spans.filter((s) => s.start < end && s.end > start && (!name || rt.iof(s.span, name))).map((s) => s.span);
    (out as any).$t = "Ljava/lang/Object;";
    return out;
  },
  "getSpanStart(Ljava/lang/Object;)I": function (this: JSpannable, span: unknown) {
    return this.spans.find((s) => s.span === span)?.start ?? -1;
  },
  "getSpanEnd(Ljava/lang/Object;)I": function (this: JSpannable, span: unknown) {
    return this.spans.find((s) => s.span === span)?.end ?? -1;
  },
  "getSpanFlags(Ljava/lang/Object;)I": function (this: JSpannable, span: unknown) {
    return this.spans.find((s) => s.span === span)?.flags ?? 0;
  },
  "nextSpanTransition(IILjava/lang/Class;)I": function (this: JSpannable, start: number, limit: number) { return limit; },
};
rt.register({
  name: "android/text/SpannableString", ctor: JSpannable,
  ifaces: ["java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned"],
  methods: spanMethods,
});
/** CharSequence → text. May be a JS string, a Spannable, or an app class (Compose
 *  AnnotatedString wrappers), so anything unrecognised answers through toString(). */
export async function csText(cs: unknown): Promise<string> {
  if (cs === null || cs === undefined) return "";
  if (typeof cs === "string") return cs;
  if (cs instanceof JSpannable) return cs.text;
  return String(await vcall(cs, "toString", "()Ljava/lang/String;"));
}
/** replace/insert/delete for the editable text classes. A method mangles with its RETURN type,
 *  so SpannableStringBuilder declares these both as returning itself and as returning Editable,
 *  or an interface-typed call misses. */
function editMutators(ret: string): NonNullable<NativeSpec["methods"]> {
  return {
    [`replace(IILjava/lang/CharSequence;)L${ret};`]: async function (this: JSpannable, a: number, b: number, cs: unknown) {
      this.text = this.text.slice(0, a) + (await csText(cs)) + this.text.slice(b);
      return this;
    },
    [`insert(ILjava/lang/CharSequence;)L${ret};`]: async function (this: JSpannable, i: number, cs: unknown) {
      this.text = this.text.slice(0, i) + (await csText(cs)) + this.text.slice(i);
      return this;
    },
    [`delete(II)L${ret};`]: function (this: JSpannable, a: number, b: number) {
      this.text = this.text.slice(0, a) + this.text.slice(b);
      return this;
    },
  };
}
rt.register({
  name: "android/text/SpannableStringBuilder", ctor: class extends JSpannable {},
  ifaces: ["java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned", "android/text/Editable", "java/lang/Appendable"],
  methods: {
    ...spanMethods,
    "append(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;": function (this: JSpannable, cs: unknown) {
      this.text += spannedString(cs);
      return this;
    },
    "append(C)Landroid/text/SpannableStringBuilder;": function (this: JSpannable, c: number) {
      this.text += String.fromCharCode(c);
      return this;
    },
    ...editMutators("android/text/SpannableStringBuilder"),
    ...editMutators("android/text/Editable"),
    "clear()V": function (this: JSpannable) { this.text = ""; this.spans = []; },
  },
});
for (const i of ["android/text/Spannable", "android/text/Spanned", "android/text/Editable",
  "android/text/TextWatcher", "android/text/InputFilter", "android/text/ParcelableSpan", "android/text/NoCopySpan"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}
rt.register({
  name: "android/text/Spannable$Factory", ctor: class extends JObj {},
  methods: {
    "static getInstance()Landroid/text/Spannable$Factory;": (() => {
      let inst: JObj | null = null;
      return () => inst ?? (inst = new (class extends JObj {})());
    })(),
  },
});

// ── CharacterStyle hierarchy — the base classes Compose's AnnotatedString→Spannable
// bridge (and any app-level span styling) subclasses; a Kotlin/DEX span class that
// extends one of these needs it to link with the real AOSP superclass/interfaces so
// instanceof checks and getSpans(SomeBase.class) filtering (used to decide "does this
// span need a TextPaint rebuild") actually match. Nothing in our Layout engine walks
// spans yet (see NOTES.md "android.text layout stack"), so update*State/chooseHeight/
// getSize/draw are abstract here exactly as in real Android — concrete leaf spans
// (below, or any app-defined subclass) provide the bodies.
class JCharacterStyle extends JObj {}
rt.register({
  name: "android/text/style/CharacterStyle", ctor: JCharacterStyle,
  methods: {
    "<init>()V": function () {},
    "getUnderlying()Landroid/text/style/CharacterStyle;": function (this: JCharacterStyle) { return this; },
  },
});
// Pure marker interface: "recreate the TextPaint, don't just measure."
rt.register({ name: "android/text/style/UpdateAppearance", ctor: class extends JObj {} });
class JMetricAffectingSpan extends JCharacterStyle {}
rt.register({
  name: "android/text/style/MetricAffectingSpan", ctor: JMetricAffectingSpan,
  sup: "android/text/style/CharacterStyle", ifaces: ["android/text/style/UpdateAppearance"],
  methods: { "<init>()V": function () {} },
});
// Interface only (no ParagraphStyle registered yet to extend) — gives real span
// classes a correct type to implement for chooseHeight-based line-height adjustment,
// even though nothing in JLayout walks it today.
rt.register({ name: "android/text/style/LineHeightSpan", ctor: class extends JObj {} });
class JReplacementSpan extends JMetricAffectingSpan {}
rt.register({
  name: "android/text/style/ReplacementSpan", ctor: JReplacementSpan,
  sup: "android/text/style/MetricAffectingSpan",
  methods: {
    "<init>()V": function () {},
    // Real AOSP: replacement spans size/draw themselves via getSize/draw instead of
    // mutating the paint, so these two overrides are no-ops (matches TextPaint's
    // normal path being skipped for inline-replacement ranges).
    "updateDrawState(Landroid/text/TextPaint;)V": function () {},
    "updateMeasureState(Landroid/text/TextPaint;)V": function () {},
  },
});

// span types (carriers) — wired into the CharacterStyle/MetricAffectingSpan hierarchy
// above so instanceof/getSpans(SomeBase.class) filtering matches real Android.
const spanHierarchy: Record<string, { sup?: string; ifaces?: string[] }> = {
  "android/text/style/ForegroundColorSpan": { sup: "android/text/style/CharacterStyle", ifaces: ["android/text/ParcelableSpan", "android/text/style/UpdateAppearance"] },
  "android/text/style/BackgroundColorSpan": { sup: "android/text/style/CharacterStyle", ifaces: ["android/text/ParcelableSpan", "android/text/style/UpdateAppearance"] },
  "android/text/style/StyleSpan": { sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"] },
  "android/text/style/UnderlineSpan": { sup: "android/text/style/CharacterStyle", ifaces: ["android/text/ParcelableSpan", "android/text/style/UpdateAppearance"] },
  "android/text/style/StrikethroughSpan": { sup: "android/text/style/CharacterStyle", ifaces: ["android/text/ParcelableSpan", "android/text/style/UpdateAppearance"] },
  "android/text/style/RelativeSizeSpan": { sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"] },
  "android/text/style/AbsoluteSizeSpan": { sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"] },
  "android/text/style/TypefaceSpan": { sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"] },
  // Real AOSP interposes DynamicDrawableSpan between ImageSpan and ReplacementSpan;
  // we don't implement drawable-based replacement drawing, so link straight through.
  "android/text/style/ImageSpan": { sup: "android/text/style/ReplacementSpan" },
  "android/text/style/ClickableSpan": { sup: "android/text/style/CharacterStyle", ifaces: ["android/text/style/UpdateAppearance"] },
  "android/text/style/URLSpan": { sup: "android/text/style/ClickableSpan" },
};
for (const [name] of [
  ["android/text/style/ForegroundColorSpan", { color: 0 }],
  ["android/text/style/BackgroundColorSpan", { color: 0 }],
  ["android/text/style/StyleSpan", { style: 0 }],
  ["android/text/style/UnderlineSpan", {}],
  ["android/text/style/StrikethroughSpan", {}],
  ["android/text/style/RelativeSizeSpan", { size: 1 }],
  ["android/text/style/AbsoluteSizeSpan", { size: 14 }],
  ["android/text/style/TypefaceSpan", {}],
  ["android/text/style/ImageSpan", {}],
  ["android/text/style/ClickableSpan", {}],
  ["android/text/style/URLSpan", {}],
] as const) {
  const c = class extends JObj { color = 0; style = 0; size = 1; };
  rt.register({
    name, ctor: c,
    ...spanHierarchy[name],
    methods: {
      "<init>()V": function () {},
      "<init>(I)V": function (this: any, v: number) { this.color = v; this.style = v; this.size = v; },
      "<init>(F)V": function (this: any, v: number) { this.size = v; },
      "getForegroundColor()I": function (this: any) { return this.color; },
      "getStyle()I": function (this: any) { return this.style; },
    },
  });
}

// Paragraph-level spans: interfaces the layout would consult per paragraph (nothing in JLayout
// walks them yet), plus the concrete Standard leading-margin span Compose uses for textIndent.
rt.register({ name: "android/text/style/ParagraphStyle", ctor: class extends JObj {} });
rt.register({ name: "android/text/style/LeadingMarginSpan", ctor: class extends JObj {}, ifaces: ["android/text/style/ParagraphStyle"] });
rt.register({ name: "android/text/style/LeadingMarginSpan$LeadingMarginSpan2", ctor: class extends JObj {}, ifaces: ["android/text/style/LeadingMarginSpan", "android/text/style/WrapTogetherSpan"] });
rt.register({ name: "android/text/style/WrapTogetherSpan", ctor: class extends JObj {}, ifaces: ["android/text/style/ParagraphStyle"] });
rt.register({ name: "android/text/style/AlignmentSpan", ctor: class extends JObj {}, ifaces: ["android/text/style/ParagraphStyle"] });
class JLeadingMarginStd extends JObj { first = 0; rest = 0; }
rt.register({
  name: "android/text/style/LeadingMarginSpan$Standard", ctor: JLeadingMarginStd,
  ifaces: ["android/text/style/LeadingMarginSpan", "android/text/ParcelableSpan"],
  methods: {
    "<init>(II)V": function (this: JLeadingMarginStd, f: number, r: number) { this.first = f; this.rest = r; },
    "<init>(I)V": function (this: JLeadingMarginStd, v: number) { this.first = this.rest = v; },
    "getLeadingMargin(Z)I": function (this: JLeadingMarginStd, first: number) { return first ? this.first : this.rest; },
    "drawLeadingMargin(Landroid/graphics/Canvas;Landroid/graphics/Paint;IIIIIILjava/lang/CharSequence;IIZLandroid/text/Layout;)V": () => {},
  },
});
class JScaleXSpan extends JMetricAffectingSpan { scaleX = 1; }
rt.register({
  name: "android/text/style/ScaleXSpan", ctor: JScaleXSpan, sup: "android/text/style/MetricAffectingSpan",
  ifaces: ["android/text/ParcelableSpan"],
  methods: {
    "<init>(F)V": function (this: JScaleXSpan, v: number) { this.scaleX = v; },
    "getScaleX()F": function (this: JScaleXSpan) { return this.scaleX; },
    // Paint.setTextScaleX is itself a no-op here, so the span only carries its factor
    "updateDrawState(Landroid/text/TextPaint;)V": () => {},
    "updateMeasureState(Landroid/text/TextPaint;)V": () => {},
  },
});

// Editable for EditText
export class JEditable extends JSpannable {}
rt.register({
  name: "webdroid/Editable", ctor: JEditable,
  ifaces: ["android/text/Editable", "java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned"],
  methods: {
    ...spanMethods,
    "append(Ljava/lang/CharSequence;)Landroid/text/Editable;": function (this: JEditable, cs: unknown) {
      this.text += spannedString(cs);
      return this;
    },
    "clear()V": function (this: JEditable) { this.text = ""; this.spans = []; },
    ...editMutators("android/text/Editable"),
  },
});

// ── TextUtils
class JTextUtils extends JObj {}
rt.register({
  name: "android/text/TextUtils", ctor: JTextUtils,
  methods: {
    "static isEmpty(Ljava/lang/CharSequence;)Z": (s: unknown) => (s === null || spannedString(s).length === 0 ? 1 : 0),
    "static equals(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z": (a: unknown, b: unknown) =>
      (spannedString(a) === spannedString(b) && (a === null) === (b === null) ? 1 : 0),
    "static isDigitsOnly(Ljava/lang/CharSequence;)Z": (s: unknown) => (/^\d*$/.test(spannedString(s)) ? 1 : 0),
    "static getTrimmedLength(Ljava/lang/CharSequence;)I": (s: unknown) => spannedString(s).trim().length,
    "static join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String;": async (sep: unknown, it: unknown) => {
      const arr = await toJsArray(it);
      const parts: string[] = [];
      for (const a of arr) parts.push(a === null ? "null" : spannedString(a));
      return parts.join(spannedString(sep));
    },
    "static join(Ljava/lang/CharSequence;[Ljava/lang/Object;)Ljava/lang/String;": (sep: unknown, arr: unknown[]) =>
      arr.map((a) => (a === null ? "null" : spannedString(a))).join(spannedString(sep)),
    "static split(Ljava/lang/String;Ljava/lang/String;)[Ljava/lang/String;": (s: string, p: string) => {
      const out = s.length ? s.split(p) : [];
      (out as any).$t = "Ljava/lang/String;";
      return out;
    },
    "static concat([Ljava/lang/CharSequence;)Ljava/lang/CharSequence;": (arr: unknown[]) =>
      arr.map(spannedString).join(""),
    "static ellipsize(Ljava/lang/CharSequence;Landroid/text/TextPaint;FLandroid/text/TextUtils$TruncateAt;)Ljava/lang/CharSequence;":
      (cs: unknown, p: JTextPaint, avail: number) => {
        const s = spannedString(cs);
        if (measureText(p, s) <= avail) return s;
        let lo = 0, hi = s.length;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (measureText(p, s.slice(0, mid) + "…") <= avail) lo = mid;
          else hi = mid - 1;
        }
        return s.slice(0, lo) + "…";
      },
    "static htmlEncode(Ljava/lang/String;)Ljava/lang/String;": (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    "static copySpansFrom(Landroid/text/Spanned;IILjava/lang/Class;Landroid/text/Spannable;I)V": () => {},
    "static stringOrSpannedString(Ljava/lang/CharSequence;)Ljava/lang/CharSequence;": (s: unknown) => s,
    "static expandTemplate(Ljava/lang/CharSequence;[Ljava/lang/CharSequence;)Ljava/lang/CharSequence;":
      (t: unknown, vals: unknown[]) => spannedString(t).replace(/\^(\d)/g, (_, d) => spannedString(vals[parseInt(d) - 1] ?? "")),
  },
});
mkEnumSet("android/text/TextUtils$TruncateAt", ["START", "MIDDLE", "END", "MARQUEE"]);

// Html.fromHtml minimal
class JHtml extends JObj {}
rt.register({
  name: "android/text/Html", ctor: JHtml,
  methods: {
    "static fromHtml(Ljava/lang/String;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static fromHtml(Ljava/lang/String;I)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
  },
});
function htmlToSpan(s: string): JSpannable {
  const sp = new JSpannable();
  sp.text = s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d)));
  return sp;
}

// InputType constants holder
rt.register({
  name: "android/text/InputType", ctor: class extends JObj {},
  statics: {
    TYPE_CLASS_TEXT: 1, TYPE_CLASS_NUMBER: 2, TYPE_CLASS_PHONE: 3, TYPE_CLASS_DATETIME: 4,
    TYPE_NUMBER_FLAG_DECIMAL: 8192, TYPE_NUMBER_FLAG_SIGNED: 4096,
    TYPE_TEXT_FLAG_CAP_SENTENCES: 16384, TYPE_TEXT_FLAG_MULTI_LINE: 131072,
    TYPE_TEXT_VARIATION_PASSWORD: 128,
  },
});

// ── android.text layout stack (BoringLayout/StaticLayout) — what Compose ui-text draws through.
interface TLine { start: number; end: number; text: string; width: number; }
class JLayout extends JObj {
  text = "";
  paint!: JTextPaint;
  width = 0;
  lines: TLine[] = [];
  spacingMult = 1; spacingAdd = 0;
  includePad = true;
  asc = 0; desc = 0;
  layoutLines(maxLines = Number.MAX_SAFE_INTEGER) {
    const p = this.paint;
    this.asc = fontAscent(p); this.desc = fontDescent(p);
    this.lines = [];
    let pos = 0;
    for (const para of this.text.split("\n")) {
      if (this.lines.length >= maxLines) break;
      if (para === "") {
        this.lines.push({ start: pos, end: pos, text: "", width: 0 });
      } else {
        let rest = para, off = 0;
        while (rest.length && this.lines.length < maxLines) {
          // Break point = the largest space index that still fits, else the largest
          // character index that fits. Widths grow monotonically with prefix length, so
          // find the character limit by binary search instead of stepping back one
          // word/char at a time (that was O(n) measures per line, O(n^2) per paragraph).
          let n = rest.length;
          if (measureText(p, rest) > this.width) {
            let lo = 1, hi = rest.length;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              if (measureText(p, rest.slice(0, mid)) <= this.width) lo = mid; else hi = mid - 1;
            }
            const sp = rest.lastIndexOf(" ", Math.min(lo, rest.length - 2));
            n = sp > 0 ? sp : lo;
          }
          let chunk = rest.slice(0, n);
          this.lines.push({ start: pos + off, end: pos + off + n, text: chunk, width: measureText(p, chunk) });
          off += n;
          if (rest[n] === " ") { n++; off++; }
          rest = rest.slice(n);
        }
      }
      pos += para.length + 1;
    }
    if (!this.lines.length) this.lines.push({ start: 0, end: 0, text: "", width: 0 });
  }
  lineHeight(): number { return Math.round((this.desc - this.asc) * this.spacingMult + this.spacingAdd); }
}
/** AOSP Layout.getDesiredWidth: widest paragraph, unwrapped. */
function desiredWidth(text: string, p: JTextPaint): number {
  let max = 0;
  for (const para of text.split("\n")) max = Math.max(max, measureText(p, para));
  return max;
}
const layoutMethods: NonNullable<NativeSpec["methods"]> = {
  "static getDesiredWidth(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F":
    (cs: unknown, p: JTextPaint) => desiredWidth(spannedString(cs), p),
  "static getDesiredWidth(Ljava/lang/CharSequence;IILandroid/text/TextPaint;)F":
    (cs: unknown, s: number, e: number, p: JTextPaint) => desiredWidth(spannedString(cs).slice(s, e), p),
  "getLineCount()I": function (this: JLayout) { return this.lines.length; },
  "isFallbackLineSpacingEnabled()Z": () => 0,
  "getSpacingMultiplier()F": function (this: JLayout) { return this.spacingMult; },
  "getSpacingAdd()F": function (this: JLayout) { return this.spacingAdd; },
  "getAlignment()Landroid/text/Layout$Alignment;": () => null,
  "getUseFallbackLineSpacing()Z": () => 0,
  "getLineTop(I)I": function (this: JLayout, i: number) { return Math.min(i, this.lines.length) * this.lineHeight(); },
  "getLineBottom(I)I": function (this: JLayout, i: number) { return (Math.min(i, this.lines.length - 1) + 1) * this.lineHeight(); },
  "getLineBottom(IZ)I": function (this: JLayout, i: number) { return (Math.min(i, this.lines.length - 1) + 1) * this.lineHeight(); },
  "getLineBaseline(I)I": function (this: JLayout, i: number) { return Math.round(i * this.lineHeight() - this.asc); },
  "getLineAscent(I)I": function (this: JLayout) { return Math.round(this.asc); },
  "getLineDescent(I)I": function (this: JLayout) { return Math.round(this.desc); },
  "getLineStart(I)I": function (this: JLayout, i: number) { return this.lines[Math.min(i, this.lines.length - 1)]?.start ?? 0; },
  "getLineEnd(I)I": function (this: JLayout, i: number) { return this.lines[Math.min(i, this.lines.length - 1)]?.end ?? 0; },
  "getLineVisibleEnd(I)I": function (this: JLayout, i: number) { return this.lines[Math.min(i, this.lines.length - 1)]?.end ?? 0; },
  "getLineLeft(I)F": function () { return 0; },
  "getLineRight(I)F": function (this: JLayout, i: number) { return this.lines[i]?.width ?? 0; },
  "getLineWidth(I)F": function (this: JLayout, i: number) { return this.lines[i]?.width ?? 0; },
  "getLineMax(I)F": function (this: JLayout, i: number) { return this.lines[i]?.width ?? 0; },
  "getHeight()I": function (this: JLayout) { return this.lines.length * this.lineHeight(); },
  "getWidth()I": function (this: JLayout) { return this.width; },
  "getText()Ljava/lang/CharSequence;": function (this: JLayout) { return this.text; },
  "getPaint()Landroid/text/TextPaint;": function (this: JLayout) { return this.paint; },
  "getEllipsisStart(I)I": () => 0,
  "getEllipsisCount(I)I": () => 0,
  "getEllipsizedWidth()I": function (this: JLayout) { return this.width; },
  "getTopPadding()I": () => 0,
  "getBottomPadding()I": () => 0,
  "getParagraphDirection(I)I": () => 1,
  "isRtlCharAt(I)Z": () => 0,
  "getLineForVertical(I)I": function (this: JLayout, y: number) {
    return Math.max(0, Math.min(this.lines.length - 1, Math.floor(y / this.lineHeight())));
  },
  "getLineForOffset(I)I": function (this: JLayout, off: number) {
    for (let i = 0; i < this.lines.length; i++) if (off <= this.lines[i].end) return i;
    return this.lines.length - 1;
  },
  "getPrimaryHorizontal(I)F": function (this: JLayout, off: number) {
    for (const l of this.lines) {
      if (off >= l.start && off <= l.end) return measureText(this.paint, l.text.slice(0, off - l.start));
    }
    return 0;
  },
  "getSecondaryHorizontal(I)F": function (this: JLayout, off: number) {
    return (layoutMethods["getPrimaryHorizontal(I)F"] as (this: JLayout, o: number) => number).call(this, off);
  },
  "getOffsetForHorizontal(IF)I": function (this: JLayout, line: number, x: number) {
    const l = this.lines[Math.min(line, this.lines.length - 1)];
    if (!l) return 0;
    let acc = 0;
    for (let i = 0; i < l.text.length; i++) {
      const w = measureText(this.paint, l.text[i]);
      if (acc + w / 2 > x) return l.start + i;
      acc += w;
    }
    return l.end;
  },
  "getLineBounds(ILandroid/graphics/Rect;)I": function (this: JLayout, i: number, r: { left: number; top: number; right: number; bottom: number }) {
    const lh = this.lineHeight();
    r.left = 0; r.right = this.lines[i]?.width ?? 0; r.top = i * lh; r.bottom = (i + 1) * lh;
    return Math.round(i * lh - this.asc);
  },
  "draw(Landroid/graphics/Canvas;)V": async function (this: JLayout, c: JCanvas) {
    // c may be a dex Canvas wrapper (Compose TextAndroidCanvas) — dispatch virtually
    const lh = this.lineHeight();
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].text) {
        await vcall(c, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V",
          this.lines[i].text, 0, Math.round(i * lh - this.asc), this.paint);
      }
    }
  },
  "draw(Landroid/graphics/Canvas;Landroid/graphics/Path;Landroid/graphics/Paint;I)V": function (this: JLayout, c: JCanvas) {
    return (layoutMethods["draw(Landroid/graphics/Canvas;)V"] as (this: JLayout, c: JCanvas) => void).call(this, c);
  },
};
rt.register({ name: "android/text/Layout", ctor: JLayout, methods: layoutMethods });

class JBoringMetrics extends JObj {
  // Paint.FontMetricsInt fields + width (accessed as plain JS props via fieldTable)
  top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; width = 0;
}
rt.register({
  name: "android/text/BoringLayout$Metrics", ctor: JBoringMetrics, sup: "android/graphics/Paint$FontMetricsInt",
  fields: { top: "top", ascent: "ascent", descent: "descent", bottom: "bottom", leading: "leading", width: "width" },
  methods: { "<init>()V": function () {} },
});
function boringMetrics(text: string, paint: JTextPaint): JBoringMetrics | null {
  if (text.includes("\n") || /[\u0590-\u08ff\u200f\u202b\u202e\ud800-\udfff]/.test(text)) return null;
  const m = new JBoringMetrics();
  fillFontMetrics(paint, m, true);
  m.width = Math.ceil(measureText(paint, text));
  return m;
}
class JBoringLayout extends JLayout {
  /** the single-line layout every ctor/make overload builds; `incl` is the include-pad flag only make() takes */
  setup(cs: unknown, p: JTextPaint, w: number, smult: number, sadd: number, incl = this.includePad): this {
    this.text = spannedString(cs); this.paint = p; this.width = w;
    this.spacingMult = smult; this.spacingAdd = sadd; this.includePad = incl;
    this.layoutLines(1);
    return this;
  }
}
const boringInit = function (this: JBoringLayout, cs: unknown, p: JTextPaint, w: number, _al: unknown, smult: number, sadd: number) {
  this.setup(cs, p, w, smult, sadd);
};
const boringMake = (cs: unknown, p: JTextPaint, w: number, _al: unknown, smult: number, sadd: number, _m: unknown, incl: number) =>
  new JBoringLayout().setup(cs, p, w, smult, sadd, !!incl);
const isBoring = (cs: unknown, p: JTextPaint) => boringMetrics(spannedString(cs), p);
rt.register({
  name: "android/text/BoringLayout", ctor: JBoringLayout, sup: "android/text/Layout",
  methods: {
    "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;Z)V": boringInit,
    "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;ZLandroid/text/TextUtils$TruncateAt;IZ)V": boringInit,
    "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;ZLandroid/text/TextUtils$TruncateAt;I)V": boringInit,
    "static isBoring(Ljava/lang/CharSequence;Landroid/text/TextPaint;)Landroid/text/BoringLayout$Metrics;": isBoring,
    "static isBoring(Ljava/lang/CharSequence;Landroid/text/TextPaint;Landroid/text/TextDirectionHeuristic;)Landroid/text/BoringLayout$Metrics;": isBoring,
    "static isBoring(Ljava/lang/CharSequence;Landroid/text/TextPaint;Landroid/text/TextDirectionHeuristic;ZLandroid/text/BoringLayout$Metrics;)Landroid/text/BoringLayout$Metrics;": isBoring,
    "static make(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;Z)Landroid/text/BoringLayout;": boringMake,
    "static make(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;ZLandroid/text/TextUtils$TruncateAt;I)Landroid/text/BoringLayout;": boringMake,
  },
});

class JStaticLayout extends JLayout {}
class JSLBuilder extends JObj {
  cs: unknown = null; p!: JTextPaint; w = 0;
  smult = 1; sadd = 0; incl = true; maxLines = Number.MAX_SAFE_INTEGER;
}
const slSetter = (fn?: (b: JSLBuilder, ...a: never[]) => void) =>
  function (this: JSLBuilder, ...a: unknown[]) { fn?.(this, ...(a as never[])); return this; };
rt.register({
  name: "android/text/StaticLayout$Builder", ctor: JSLBuilder,
  methods: {
    "static obtain(Ljava/lang/CharSequence;IILandroid/text/TextPaint;I)Landroid/text/StaticLayout$Builder;":
      (cs: unknown, start: number, end: number, p: JTextPaint, w: number) => {
        const b = new JSLBuilder();
        b.cs = spannedString(cs).slice(start, end); b.p = p; b.w = w;
        return b;
      },
    "setAlignment(Landroid/text/Layout$Alignment;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setTextDirection(Landroid/text/TextDirectionHeuristic;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setLineSpacing(FF)Landroid/text/StaticLayout$Builder;": slSetter((b, add: number, mult: number) => { b.sadd = add; b.smult = mult; }),
    "setIncludePad(Z)Landroid/text/StaticLayout$Builder;": slSetter((b, v: number) => { b.incl = !!v; }),
    "setEllipsize(Landroid/text/TextUtils$TruncateAt;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setEllipsizedWidth(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setMaxLines(I)Landroid/text/StaticLayout$Builder;": slSetter((b, v: number) => { b.maxLines = v > 0 ? v : b.maxLines; }),
    "setBreakStrategy(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setHyphenationFrequency(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setIndents([I[I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setJustificationMode(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setUseLineSpacingFromFallbacks(Z)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setLineBreakConfig(Landroid/graphics/text/LineBreakConfig;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "build()Landroid/text/StaticLayout;": function (this: JSLBuilder) {
      const l = new JStaticLayout();
      l.text = String(this.cs); l.paint = this.p; l.width = this.w;
      l.spacingMult = this.smult; l.spacingAdd = this.sadd; l.includePad = this.incl;
      l.layoutLines(this.maxLines);
      return l;
    },
  },
});
rt.register({ name: "android/text/StaticLayout", ctor: JStaticLayout, sup: "android/text/Layout", methods: {} });

// Layout$Alignment enum + TextDirectionHeuristics markers
mkEnumSet("android/text/Layout$Alignment", ["ALIGN_NORMAL", "ALIGN_OPPOSITE", "ALIGN_CENTER"]);
class JTDH extends JObj {}
rt.register({ name: "android/text/TextDirectionHeuristic", ctor: JTDH });
rt.register({
  name: "android/text/TextDirectionHeuristics", ctor: class extends JObj {},
  statics: {
    LTR: new JTDH(), RTL: new JTDH(), FIRSTSTRONG_LTR: new JTDH(), FIRSTSTRONG_RTL: new JTDH(),
    ANYRTL_LTR: new JTDH(), LOCALE: new JTDH(),
  },
});
rt.register({ name: "android/graphics/text/LineBreakConfig", ctor: class extends JObj {} });
rt.register({
  name: "android/graphics/text/LineBreakConfig$Builder", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "setLineBreakStyle(I)Landroid/graphics/text/LineBreakConfig$Builder;": function (this: JObj) { return this; },
    "setLineBreakWordStyle(I)Landroid/graphics/text/LineBreakConfig$Builder;": function (this: JObj) { return this; },
    "build()Landroid/graphics/text/LineBreakConfig;": () => new (rt.link("android/graphics/text/LineBreakConfig").ctor)(),
  },
});

// ── android.text.format.DateFormat
rt.register({
  name: "android/text/format/DateFormat", ctor: class extends JObj {},
  methods: {
    "static is24HourFormat(Landroid/content/Context;)Z": () => 0,
    "static getDateFormat(Landroid/content/Context;)Ljava/text/DateFormat;": () => newObj("java/text/SimpleDateFormat", "(Ljava/lang/String;)V", "M/d/yy"),
    "static getTimeFormat(Landroid/content/Context;)Ljava/text/DateFormat;": () => newObj("java/text/SimpleDateFormat", "(Ljava/lang/String;)V", "h:mm a"),
    "static format(Ljava/lang/CharSequence;J)Ljava/lang/CharSequence;": (fmt: unknown, t: bigint) => formatDate(String(fmt), Number(t)),
    "static format(Ljava/lang/CharSequence;Ljava/util/Date;)Ljava/lang/CharSequence;": (fmt: unknown, d: JDate | null) => formatDate(String(fmt), d?.t ?? Date.now()),
  },
});

// ── android.text.format.Formatter: SI units and the 900 roll-over, as API 26+ formats them
const fmtBytes = (n: bigint, short: boolean) => {
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let v = Math.abs(Number(n)), i = 0;
  while (v > 900 && i < units.length - 1) { v /= 1000; i++; }
  const dec = i === 0 ? 0 : v < 1 ? 2 : v < 10 ? (short ? 1 : 2) : v < 100 ? (short ? 0 : 2) : 0;
  return (n < 0n ? "-" : "") + v.toFixed(dec) + " " + units[i];
};
rt.register({
  name: "android/text/format/Formatter", ctor: class extends JObj {},
  methods: {
    "static formatFileSize(Landroid/content/Context;J)Ljava/lang/String;": (_c: unknown, n: bigint) => fmtBytes(n, false),
    "static formatShortFileSize(Landroid/content/Context;J)Ljava/lang/String;": (_c: unknown, n: bigint) => fmtBytes(n, true),
  },
});

// ── android.text.format.Time (deprecated since API 22, still what 2013-era crash reporters stamp
// reports with). Fields are the public broken-down ints; the zone is always UTC here.
class JTime extends JObj {
  year = 1970; month = 0; monthDay = 1; hour = 0; minute = 0; second = 0; weekDay = 4; yearDay = 0; isDst = 0;
  gmtoff = 0n; timezone = "UTC"; allDay = 0;
  set(ms: number) {
    const d = new Date(ms);
    this.year = d.getUTCFullYear(); this.month = d.getUTCMonth(); this.monthDay = d.getUTCDate();
    this.hour = d.getUTCHours(); this.minute = d.getUTCMinutes(); this.second = d.getUTCSeconds();
    this.weekDay = d.getUTCDay();
    this.yearDay = Math.floor((ms - Date.UTC(this.year, 0, 1)) / 86400000);
  }
  millis(): number { return Date.UTC(this.year, this.month, this.monthDay, this.hour, this.minute, this.second); }
}
const p2 = (n: number) => String(n).padStart(2, "0");
rt.register({
  name: "android/text/format/Time", ctor: JTime,
  fields: { year: "year", month: "month", monthDay: "monthDay", hour: "hour", minute: "minute", second: "second",
    weekDay: "weekDay", yearDay: "yearDay", isDst: "isDst", gmtoff: "gmtoff", timezone: "timezone", allDay: "allDay" },
  statics: { TIMEZONE_UTC: "UTC", EPOCH_JULIAN_DAY: 2440588, MONDAY_BEFORE_JULIAN_EPOCH: 2440585 },
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: JTime, tz: string) { this.timezone = tz ?? "UTC"; },
    "setToNow()V": function (this: JTime) { this.set(Date.now()); },
    "set(J)V": function (this: JTime, ms: bigint) { this.set(Number(ms)); },
    "set(IIIIII)V": function (this: JTime, s: number, mi: number, h: number, d: number, mo: number, y: number) {
      this.second = s; this.minute = mi; this.hour = h; this.monthDay = d; this.month = mo; this.year = y;
    },
    "toMillis(Z)J": function (this: JTime) { return BigInt(this.millis()); },
    "normalize(Z)J": function (this: JTime) { const ms = this.millis(); this.set(ms); return BigInt(ms); },
    "format3339(Z)Ljava/lang/String;": function (this: JTime, allDay: number) {
      const date = `${this.year}-${p2(this.month + 1)}-${p2(this.monthDay)}`;
      return allDay ? date : `${date}T${p2(this.hour)}:${p2(this.minute)}:${p2(this.second)}.000+00:00`;
    },
    "format2445()Ljava/lang/String;": function (this: JTime) {
      return `${this.year}${p2(this.month + 1)}${p2(this.monthDay)}T${p2(this.hour)}${p2(this.minute)}${p2(this.second)}Z`;
    },
    "format(Ljava/lang/String;)Ljava/lang/String;": function (this: JTime, fmt: string) {
      const m: Record<string, string> = { Y: String(this.year), m: p2(this.month + 1), d: p2(this.monthDay), H: p2(this.hour),
        M: p2(this.minute), S: p2(this.second), y: p2(this.year % 100), e: String(this.monthDay).padStart(2, " "), "%": "%" };
      return fmt.replace(/%(.)/g, (all, c) => m[c] ?? all);
    },
    "toString()Ljava/lang/String;": function (this: JTime) {
      return `${this.year}${p2(this.month + 1)}${p2(this.monthDay)}T${p2(this.hour)}${p2(this.minute)}${p2(this.second)}UTC(0,0,0,0,${this.millis() / 1000 | 0})`;
    },
    "parse(Ljava/lang/String;)Z": function (this: JTime, s: string) {
      const r = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(s ?? "");
      if (!r) throw rt.mkThrowable("android/util/TimeFormatException", "Parse error at " + s);
      this.year = +r[1]; this.month = +r[2] - 1; this.monthDay = +r[3];
      this.hour = +(r[4] ?? 0); this.minute = +(r[5] ?? 0); this.second = +(r[6] ?? 0);
      return r[7] ? 1 : 0;
    },
    "switchTimezone(Ljava/lang/String;)V": () => {},
    "clear(Ljava/lang/String;)V": function (this: JTime) { Object.assign(this, new JTime()); },
    "static isEpoch(Landroid/text/format/Time;)Z": (t: JTime) => (t.millis() === 0 ? 1 : 0),
    "static compare(Landroid/text/format/Time;Landroid/text/format/Time;)I": (a: JTime, b: JTime) => Math.sign(a.millis() - b.millis()),
  },
});
