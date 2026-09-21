import { JDrawable, JColorStateList } from "./drawable";
import { type JParcel, writeInt, readInt, writeString8, readString8, parcelCreator } from "./parcel";
// android.text.* — TextPaint, TextUtils, Spannable/Editable (spans stored, minimally styled).

import { rt, JObj, type NativeSpec, stubs, noops } from "../jvm/runtime";
import { vcall, vcallMaybe, vcallOn, callOn, curThread, mkEnumSet, newObj } from "../jvm/natives/jlang";
import { type JDate, type JCalendar } from "../jvm/natives/jtime";
import { JPaint, JCanvas, measureText, copyPaint, fontAscent, fontDescent, fontTop, fontBottom, fillFontMetrics, runAdvances, type JRect, type JBitmap, JTypeface, typefaceFor } from "./graphics";
import { AID, JTypedArray } from "./res";
import { TV } from "./axml";
import { fontResource } from "./fonts";
import { device } from "../shell/config";
import { formatDate } from "../jvm/natives/jtext";
import { toJsArray } from "../jvm/natives/jutil";
import { localeDirection } from "../jvm/natives/jvalues";
import { JPersistableBundle, bundleBox } from "./os";
import { JLocaleList, readLocaleList } from "./resnative";
import type { JLocale } from "../jvm/natives/jvalues";
import { csText as javaCsText } from "../jvm/natives/jchars";

class JAnnotation extends JObj { key: string | null = null; value: string | null = null; }
async function writeAnnotation(this: JAnnotation, parcel: JObj) {
  const thread = rt.th();
  await vcall(parcel, "writeString", "(Ljava/lang/String;)V", this.key); rt.st(thread);
  await vcall(parcel, "writeString", "(Ljava/lang/String;)V", this.value);
}
rt.register({
  name: "android/text/Annotation", ctor: JAnnotation, ifaces: ["android/text/ParcelableSpan"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JAnnotation, key: string | null, value: string | null) { this.key = key; this.value = value; },
    "<init>(Landroid/os/Parcel;)V": async function (this: JAnnotation, parcel: JObj) {
      const thread = rt.th();
      this.key = await vcall(parcel, "readString", "()Ljava/lang/String;"); rt.st(thread);
      this.value = await vcall(parcel, "readString", "()Ljava/lang/String;");
    },
    "getKey()Ljava/lang/String;": function (this: JAnnotation) { return this.key; },
    "getValue()Ljava/lang/String;": function (this: JAnnotation) { return this.value; },
    "getSpanTypeId()I": () => 18,
    "getSpanTypeIdInternal()I": () => 18,
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": writeAnnotation,
    "writeToParcelInternal(Landroid/os/Parcel;I)V": writeAnnotation,
  },
});

class JTtsSpan extends JObj { type: string | null = null; args: JPersistableBundle | null = null; }
async function writeTtsSpan(this: JTtsSpan, parcel: JParcel) {
  await vcall(parcel, "writeString", "(Ljava/lang/String;)V", this.type);
  await vcall(parcel, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", this.args);
}
rt.register({ name: "android/text/style/TtsSpan", ctor: JTtsSpan, ifaces: ["android/text/ParcelableSpan"], methods: {
  "<init>(Ljava/lang/String;Landroid/os/PersistableBundle;)V": function (this: JTtsSpan, type: string, args: JPersistableBundle) { this.type = type; this.args = args; },
  "<init>(Landroid/os/Parcel;)V": async function (this: JTtsSpan, parcel: JParcel) {
    this.type = await vcall(parcel, "readString", "()Ljava/lang/String;");
    this.args = await vcall(parcel, "readPersistableBundle", "()Landroid/os/PersistableBundle;");
  },
  "getType()Ljava/lang/String;": function (this: JTtsSpan) { return this.type; },
  "getArgs()Landroid/os/PersistableBundle;": function (this: JTtsSpan) { return this.args; },
  "getSpanTypeId()I": () => 24, "getSpanTypeIdInternal()I": () => 24, "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": writeTtsSpan,
  "writeToParcelInternal(Landroid/os/Parcel;I)V": writeTtsSpan,
} });
class JTtsBuilder extends JObj { type = ""; args = new JPersistableBundle(); }
rt.register({ name: "android/text/style/TtsSpan$Builder", ctor: JTtsBuilder, methods: {
  "<init>(Ljava/lang/String;)V": function (this: JTtsBuilder, type: string) { this.type = type; },
  "build()Landroid/text/style/TtsSpan;": function (this: JTtsBuilder) { const span = new JTtsSpan(); span.type = this.type; span.args = this.args; return span; },
  ...Object.fromEntries([["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"]].map(([type, desc]) => [
    `set${type}Argument(Ljava/lang/String;${desc})Landroid/text/style/TtsSpan$Builder;`,
    function (this: JTtsBuilder, key: string, value: unknown) { this.args.map.set(key, desc === "Ljava/lang/String;" ? value : bundleBox(value, desc)); return this; },
  ])),
} });
class JTtsSemioticBuilder extends JTtsBuilder {}
rt.register({ name: "android/text/style/TtsSpan$SemioticClassBuilder", ctor: JTtsSemioticBuilder, sup: "android/text/style/TtsSpan$Builder", methods: {
  "<init>(Ljava/lang/String;)V": function (this: JTtsBuilder, type: string) { this.type = type; },
  ...Object.fromEntries(["Gender", "Animacy", "Multiplicity", "Case"].map(name => [
    `set${name}(Ljava/lang/String;)Landroid/text/style/TtsSpan$SemioticClassBuilder;`,
    function (this: JTtsBuilder, value: string) { this.args.map.set("android.arg." + name.toLowerCase(), value); return this; },
  ])),
} });
for (const name of ["Text", "Verbatim"]) {
  const kind = name.toLowerCase();
  rt.register({ name: `android/text/style/TtsSpan$${name}Builder`, ctor: class extends JTtsSemioticBuilder {}, sup: "android/text/style/TtsSpan$SemioticClassBuilder", methods: {
    "<init>()V": function (this: JTtsBuilder) { this.type = "android.type." + kind; },
    "<init>(Ljava/lang/String;)V": function (this: JTtsBuilder, value: string) { this.type = "android.type." + kind; this.args.map.set("android.arg." + kind, value); },
    [`set${name}(Ljava/lang/String;)Landroid/text/style/TtsSpan$${name}Builder;`]: function (this: JTtsBuilder, value: string) { this.args.map.set("android.arg." + kind, value); return this; },
  } });
}

export class JTextPaint extends JPaint {
  linkColor = -16776961;
  /** AOSP's StaticLayout reads these off the paint directly, so they are real fields rather
   *  than accessors: a BackgroundColorSpan writes bgColor and the layout draws from it */
  bgColor = 0;
  baselineShift = 0;
  drawableState: Int32Array | null = null;
  underlineColor = 0;
  underlineThickness = 0;
  /** dp/sp-based span math (updateDrawState/updateMeasureState) reads this to scale —
   *  shares the one device-density constant, not a magic literal. */
  density = device.density;
}
function copyTextPaint(src: JTextPaint, dst: JTextPaint): void {
  copyPaint(src, dst);
  dst.linkColor = src.linkColor;
  dst.bgColor = src.bgColor;
  dst.baselineShift = src.baselineShift;
  dst.drawableState = src.drawableState;
  dst.density = src.density;
  dst.underlineColor = src.underlineColor;
  dst.underlineThickness = src.underlineThickness;
}
rt.register({
  name: "android/text/TextPaint", ctor: JTextPaint, sup: "android/graphics/Paint",
  fields: ["linkColor", "bgColor", "baselineShift", "drawableState", "density", "underlineColor", "underlineThickness"],
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "<init>(Landroid/graphics/Paint;)V": function (this: JTextPaint, p: JPaint) {
      if (p) copyPaint(p, this);
    },
    "set(Landroid/text/TextPaint;)V": function (this: JTextPaint, p: JTextPaint) {
      if (p) copyTextPaint(p, this);
    },
    // the CharSequence half of Paint.getRunCharacterAdvance: same body, but flattening a
    // Spanned belongs here. AOSP's StaticLayout reads per-character advances through it.
    "getRunCharacterAdvance(Ljava/lang/CharSequence;IIIIZI[FILandroid/graphics/RectF;Landroid/graphics/Paint$RunInfo;)F":
      function (this: JTextPaint, cs: unknown, start: number, end: number, _cs2: number, _ce: number, _rtl: number, offset: number, adv: Float32Array | null, advIdx: number) {
        return runAdvances(this, spannedString(cs), start, end, offset, adv, advIdx);
      },
  },
});

// ── Spans (data-only carriers; TextView applies a small subset visually)
interface SpanRec { span: unknown; start: number; end: number; flags: number; }
export class JSpanned extends JObj {
  text = "";
  spans: SpanRec[] = [];
  // JObj has no JS toString, so String(spanned) anywhere in the framework read "[object Object]"
  toString() { return this.text; }
}
export class JSpannable extends JSpanned {}
export function spannedString(s: unknown): string {
  if (s === null || s === undefined) return "";
  if (typeof s === "string") return s;
  if (s instanceof JSpanned) return s.text;
  return String(s);
}
function sliceSpanned(cs: unknown, start: number, end: number): unknown {
  if (!(cs instanceof JSpanned)) return spannedString(cs).slice(start, end);
  const out = new (cs.constructor as new () => JSpannable)(); out.text = cs.text.slice(start, end);
  for (const r of cs.spans) if (r.end > start && r.start < end) out.spans.push({ ...r, start: Math.max(0, r.start - start), end: Math.min(end, r.end) - start });
  return out;
}
const spanMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/CharSequence;)V": function (this: JSpanned, cs: unknown) {
    if (cs == null) return rt.npe();
    if (typeof cs === "string") { this.text = cs; return; }
    if (cs instanceof JSpanned) {
      this.text = cs.text; this.spans = cs.spans.map((span) => ({ ...span })); return;
    }
    return (async () => {
      this.text = await csText(cs);
      if (!rt.iof(cs, "android/text/Spanned")) return;
      const spans = await vcall(cs, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, this.text.length, rt.classFor("java/lang/Object"));
      for (const span of spans) this.spans.push({ span,
        start: await vcall(cs, "getSpanStart", "(Ljava/lang/Object;)I", span),
        end: await vcall(cs, "getSpanEnd", "(Ljava/lang/Object;)I", span),
        flags: await vcall(cs, "getSpanFlags", "(Ljava/lang/Object;)I", span),
      });
    })();
  },
  "length()I": function (this: JSpannable) { return this.text.length; },
  "charAt(I)C": function (this: JSpannable, i: number) { return this.text.charCodeAt(i); },
  "toString()Ljava/lang/String;": function (this: JSpannable) { return this.text; },
  // AOSP returns a Spanned (SpannableStringBuilder), not a String: app code trims a Spanned and
  // casts the result straight back, so handing out a bare String is a ClassCastException later.
  "subSequence(II)Ljava/lang/CharSequence;": function (this: JSpannable, a: number, b: number) { return sliceSpanned(this, a, b); },
  "setSpan(Ljava/lang/Object;III)V": function (this: JSpannable, span: unknown, start: number, end: number, flags: number) {
    const existing = this.spans.find((r) => r.span === span);
    if (existing) Object.assign(existing, { start, end, flags });
    else this.spans.push({ span, start, end, flags });
  },
  "removeSpan(Ljava/lang/Object;)V": function (this: JSpannable, span: unknown) {
    this.spans = this.spans.filter((s) => s.span !== span);
  },
  "getSpans(IILjava/lang/Class;)[Ljava/lang/Object;": function (this: JSpannable, start: number, end: number, cls: any) {
    const name = cls?.ci?.name;
    const out = this.spans.filter((s) => s.start < end && s.end > start && (!name || rt.iof(s.span, name))).map((s) => s.span);
    // AOSP returns a T[] built from the requested Class, and callers assign it to one: the
    // array's own type tag has to be the queried class, not Object.
    (out as any).$t = name ? "L" + name + ";" : "Ljava/lang/Object;";
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
  methods: {
    ...spanMethods,
    "static valueOf(Ljava/lang/CharSequence;)Landroid/text/SpannableString;": (cs: unknown) =>
      rt.iof(cs, "android/text/SpannableString") ? cs : newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", cs),
  },
});
class JSpannedString extends JSpanned {}
const immutableSpanMethods = Object.fromEntries(Object.entries(spanMethods!).filter(([name]) => !name.startsWith("setSpan(") && !name.startsWith("removeSpan(") && name !== "<init>()V"));
rt.register({
  name: "android/text/SpannedString", ctor: JSpannedString,
  ifaces: ["java/lang/CharSequence", "android/text/Spanned"],
  methods: {
    ...immutableSpanMethods,
    "static valueOf(Ljava/lang/CharSequence;)Landroid/text/SpannedString;": (cs: unknown) =>
      cs instanceof JSpannedString ? cs : newObj("android/text/SpannedString", "(Ljava/lang/CharSequence;)V", cs),
  },
});
/** CharSequence → text. May be a JS string, a Spannable, or an app class (Compose
 *  AnnotatedString wrappers), so anything unrecognised answers through toString(). */
export async function csText(cs: unknown): Promise<string> {
  if (cs instanceof JSpanned) return cs.text;
  return javaCsText(cs);
}
function concatText(parts: unknown[]): unknown {
  if (parts.length === 1) return parts[0];
  if (parts.every(p => p === null || typeof p === "string")) return parts.map(p => p ?? "null").join("");
  return (async () => {
    const out = new JSpannedString(), seen = new Set<unknown>();
    let spanned = false;
    for (let part of parts) {
      if (part === null) part = "null";
      if (!(part instanceof JSpanned) && rt.iof(part, "android/text/Spanned")) {
        part = await newObj("android/text/SpannedString", "(Ljava/lang/CharSequence;)V", part);
      }
      const start = out.text.length;
      const text = typeof part === "string" ? part : part instanceof JSpanned ? part.text : await csText(part);
      for (const r of out.spans) {
        const a = r.flags >> 4 & 0xf, b = r.flags & 0xf;
        if (r.start === start && (a === 2 || a === 3)) r.start += text.length;
        if (r.end === start && (b === 2 || b === 3)) r.end += text.length;
      }
      out.text += text;
      if (!(part instanceof JSpanned)) continue;
      spanned = true;
      for (const r of part.spans) {
        if (seen.has(r.span) || rt.iof(r.span, "android/text/NoCopySpan")) continue;
        const a = start + r.start, b = start + r.end;
        if ((r.flags & 0x33) === 0x33 && (a && out.text[a - 1] !== "\n" || b !== out.text.length && b && out.text[b - 1] !== "\n")) continue;
        seen.add(r.span);
        out.spans.push({ ...r, start: a, end: b });
      }
    }
    return spanned ? out : out.text;
  })();
}
const selectionStart = new JObj(), selectionEnd = new JObj();
export async function textSelection(text: unknown): Promise<[number, number]> {
  if (!text || typeof text === "string") return [-1, -1];
  return [await vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", selectionStart), await vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", selectionEnd)];
}
export async function setTextSelection(text: unknown, start: number, end: number) {
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", selectionStart, start, start, 0x222);
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", selectionEnd, end, end, 0x22);
}
rt.register({ name: "android/text/Selection", ctor: class extends JObj {},
  statics: { SELECTION_START: selectionStart, SELECTION_END: selectionEnd },
  methods: {
    "static getSelectionStart(Ljava/lang/CharSequence;)I": async (text: unknown) => (await textSelection(text))[0],
    "static getSelectionEnd(Ljava/lang/CharSequence;)I": async (text: unknown) => (await textSelection(text))[1],
    "static setSelection(Landroid/text/Spannable;II)V": setTextSelection,
    "static setSelection(Landroid/text/Spannable;I)V": async (text: unknown, index: number) => setTextSelection(text, index, index),
    "static selectAll(Landroid/text/Spannable;)V": async (text: unknown) => setTextSelection(text, 0, (await csText(text)).length),
    "static removeSelection(Landroid/text/Spannable;)V": async (text: unknown) => {
      await vcall(text, "removeSpan", "(Ljava/lang/Object;)V", selectionStart);
      await vcall(text, "removeSpan", "(Ljava/lang/Object;)V", selectionEnd);
    },
  },
});

/** replace/insert/delete for the editable text classes. A method mangles with its RETURN type,
 *  so SpannableStringBuilder declares these both as returning itself and as returning Editable,
 *  or an interface-typed call misses. */
function editMutators(ret: string): NonNullable<NativeSpec["methods"]> {
  return {
    [`replace(IILjava/lang/CharSequence;)L${ret};`]: async function (this: JSpannable, a: number, b: number, cs: unknown) {
      const text = await csText(cs);
      return vcall(this, "replace", "(IILjava/lang/CharSequence;II)L" + ret + ";", a, b, cs, 0, text.length);
    },
    [`replace(IILjava/lang/CharSequence;II)L${ret};`]: async function (this: JSpannable, a: number, b: number, cs: unknown, start: number, end: number) {
      if (!(cs instanceof JSpanned) && rt.iof(cs, "android/text/Spanned"))
        cs = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", cs);
      const incoming = cs instanceof JSpanned ? cs.spans.filter((r) => r.start < end && r.end > start).map((r) => ({
        ...r, start: a + Math.max(start, r.start) - start, end: a + Math.min(end, r.end) - start,
      })) : [];
      const text = (await csText(cs)).slice(start, end), delta = text.length - (b - a);
      this.text = this.text.slice(0, a) + text + this.text.slice(b);
      const moved = (position: number, mode: number) => position < a ? position : position > b ? position + delta :
        position === b && b > a || mode === 2 ? a + text.length : a;
      for (const span of this.spans) {
        span.start = moved(span.start, span.flags >> 4 & 0xf);
        span.end = moved(span.end, span.flags & 0xf);
      }
      for (const span of incoming) if (!this.spans.some((r) => r.span === span.span)) this.spans.push(span);
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
async function appendSpanned(this: JSpannable, cs: unknown) {
  const length = this.text.length;
  return vcall(this, "replace", "(IILjava/lang/CharSequence;II)Landroid/text/Editable;", length, length, cs, 0, (await csText(cs)).length);
}
rt.register({
  name: "android/text/SpannableStringBuilder", ctor: class extends JSpannable {},
  ifaces: ["java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned", "android/text/Editable", "java/lang/Appendable"],
  methods: {
    ...spanMethods,
    "append(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;": appendSpanned,
    "append(C)Landroid/text/SpannableStringBuilder;": function (this: JSpannable, c: number) {
      this.text += String.fromCharCode(c);
      return this;
    },
    ...editMutators("android/text/SpannableStringBuilder"),
    ...editMutators("android/text/Editable"),
    "clear()V": function (this: JSpannable) { this.text = ""; this.spans = []; },
    "clearSpans()V": function (this: JSpannable) {
      if (!this.spans.some(s => rt.iof(s.span, "android/text/SpanWatcher"))) { this.spans.length = 0; return; }
      return (async () => {
        while (this.spans.length) {
          const removed = this.spans.pop()!;
          const watchers = this.spans.filter(s => rt.iof(s.span, "android/text/SpanWatcher") && s.start <= removed.end && s.end >= removed.start &&
            (s.start === s.end || removed.start === removed.end || s.start !== removed.end && s.end !== removed.start))
            .sort((a, b) => (b.flags & 0xff0000) - (a.flags & 0xff0000));
          for (const s of watchers) await vcall(s.span, "onSpanRemoved", "(Landroid/text/Spannable;Ljava/lang/Object;II)V", this, removed.span, removed.start, removed.end);
        }
      })();
    },
  },
});
for (const i of ["android/text/Spannable", "android/text/Spanned", "android/text/Editable",
  "android/text/TextWatcher", "android/text/SpanWatcher", "android/text/InputFilter", "android/text/ParcelableSpan", "android/text/NoCopySpan"]) {
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
// span need a TextPaint rebuild") actually match. update*State/chooseHeight/getSize/draw
// are abstract here exactly as in real Android — concrete leaf spans (below, or any
// app-defined subclass) provide the bodies.
class JCharacterStyle extends JObj {}
rt.register({
  name: "android/text/style/CharacterStyle", ctor: JCharacterStyle,
  methods: {
    "static wrap(Landroid/text/style/CharacterStyle;)Landroid/text/style/CharacterStyle;": (style: unknown) => {
      const kind = rt.iof(style, "android/text/style/MetricAffectingSpan") ? "MetricAffectingSpan" : "CharacterStyle";
      const wrapper = rt.make(`android/text/style/${kind}$Passthrough`) as JStylePassthrough;
      wrapper.style = style;
      return wrapper;
    },
    "<init>()V": function () {},
    "getUnderlying()Landroid/text/style/CharacterStyle;": function (this: JCharacterStyle) { return this; },
  },
});
// Pure marker interface: "recreate the TextPaint, don't just measure."
rt.markers("android/text/style/UpdateAppearance");
class JMetricAffectingSpan extends JCharacterStyle {}
rt.register({
  name: "android/text/style/MetricAffectingSpan", ctor: JMetricAffectingSpan,
  sup: "android/text/style/CharacterStyle", ifaces: ["android/text/style/UpdateAppearance"],
  methods: {
    "<init>()V": function () {},
    "getUnderlying()Landroid/text/style/MetricAffectingSpan;": function (this: JMetricAffectingSpan) { return this; },
  },
});
// Interface only (no ParagraphStyle registered yet to extend): the type real span classes
// implement for the chooseHeight line-height adjustment applyLineHeightSpans applies.
rt.markers("android/text/style/LineHeightSpan", "android/text/style/LineHeightSpan$WithDensity");
class JStylePassthrough extends JCharacterStyle { style: unknown = null; }
const passthroughMethods: NativeSpec["methods"] = {
  "updateDrawState(Landroid/text/TextPaint;)V": function (this: JStylePassthrough, paint: JTextPaint) { return vcall(this.style, "updateDrawState", "(Landroid/text/TextPaint;)V", paint); },
  "getUnderlying()Landroid/text/style/CharacterStyle;": function (this: JStylePassthrough) { return vcall(this.style, "getUnderlying", "()Landroid/text/style/CharacterStyle;"); },
};
rt.register({ name: "android/text/style/CharacterStyle$Passthrough", ctor: JStylePassthrough, sup: "android/text/style/CharacterStyle", methods: passthroughMethods });
rt.register({
  name: "android/text/style/MetricAffectingSpan$Passthrough", ctor: class extends JStylePassthrough {}, sup: "android/text/style/MetricAffectingSpan",
  methods: {
    ...passthroughMethods,
    "updateMeasureState(Landroid/text/TextPaint;)V": function (this: JStylePassthrough, paint: JTextPaint) { return vcall(this.style, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint); },
    "getUnderlying()Landroid/text/style/MetricAffectingSpan;": function (this: JStylePassthrough) { return vcall(this.style, "getUnderlying", "()Landroid/text/style/MetricAffectingSpan;"); },
  },
});
class JReplacementSpan extends JMetricAffectingSpan {}
class JTextAppearanceSpan extends JMetricAffectingSpan {
  family: string | null = null; style = 0; size = -1; color: JColorStateList | null = null; linkColor: JColorStateList | null = null;
  typeface: JTypeface | null = null; weight = -1; locales: JLocaleList | null = null;
  shadowRadius = 0; shadowDx = 0; shadowDy = 0; shadowColor = 0;
  elegant: number | null = null; spacing: number | null = null; features: string | null = null; variations: string | null = null;
}
const appearanceAttrs = ["textColor", "textColorLink", "textSize", "textStyle", "fontFamily", "typeface", "textFontWeight", "textLocale",
  "shadowRadius", "shadowDx", "shadowDy", "shadowColor", "elegantTextHeight", "letterSpacing", "fontFeatureSettings", "fontVariationSettings"];
async function appearanceInit(this: JTextAppearanceSpan, context: JObj, style: number) {
  const thread = curThread, a = await vcallOn(thread, context, "obtainStyledAttributes", "(I[I)Landroid/content/res/TypedArray;", style, new Int32Array(appearanceAttrs.map(AID)));
  if (!(a instanceof JTypedArray)) throw new Error("Invalid appearance attributes");
  const get = (method: string, desc: string, ...args: unknown[]) => vcallOn(thread, a, method, desc, ...args);
  const string = async (index: number) => { const value = await get("getString", "(I)Ljava/lang/String;", index); return typeof value === "string" ? value : null; };
  const color = async (index: number) => { const value = await get("getColorStateList", "(I)Landroid/content/res/ColorStateList;", index); return value instanceof JColorStateList ? value : null; };
  try {
    this.color = await color(0);
    this.linkColor = await color(1);
    this.size = Number(await get("getDimensionPixelSize", "(II)I", 2, -1));
    this.style = Number(await get("getInt", "(II)I", 3, 0));
    const font = a.vals[4];
    if (font?.t === TV.REFERENCE && !await vcallOn(thread, context, "isRestricted", "()Z")) this.typeface = await fontResource(a.res, font.d);
    if (!this.typeface) this.family = await string(4) ?? [null, "sans", "serif", "monospace"][Number(await get("getInt", "(II)I", 5, 0))] ?? null;
    this.weight = Number(await get("getInt", "(II)I", 6, -1));
    const locale = await string(7);
    if (locale) {
      const locales = await vcallOn(thread, rt.link("android/os/LocaleList").ctor, "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", locale);
      if (locales instanceof JLocaleList && locales.values.length) this.locales = locales;
    }
    this.shadowRadius = Number(await get("getFloat", "(IF)F", 8, 0));
    this.shadowDx = Number(await get("getFloat", "(IF)F", 9, 0));
    this.shadowDy = Number(await get("getFloat", "(IF)F", 10, 0));
    this.shadowColor = Number(await get("getColor", "(II)I", 11, 0));
    if (await get("hasValue", "(I)Z", 12)) this.elegant = Number(await get("getBoolean", "(IZ)Z", 12, 0));
    if (await get("hasValue", "(I)Z", 13)) this.spacing = Number(await get("getFloat", "(IF)F", 13, 0));
    this.features = await string(14);
    this.variations = await string(15);
  } finally { await get("recycle", "()V"); }
}
async function appearanceMeasure(this: JTextAppearanceSpan, paint: JTextPaint) {
  const thread = curThread, call = (method: string, desc: string, ...args: unknown[]) => vcallOn(thread, paint, method, desc, ...args);
  const fonts = rt.link("android/graphics/Typeface").ctor;
  const create = async (desc: string, ...args: unknown[]) => {
    const value = await vcallOn(thread, fonts, "create", desc, ...args);
    if (!(value instanceof JTypeface)) throw new Error("Invalid appearance typeface");
    return value;
  };
  let tf = this.typeface, style = this.style;
  if (tf || this.family !== null || style) {
    if (!tf) style |= paint.tf.style();
    tf = this.family !== null && !tf
      ? await create("(Ljava/lang/String;I)Landroid/graphics/Typeface;", this.family, style)
      : await create("(Landroid/graphics/Typeface;I)Landroid/graphics/Typeface;", tf ?? paint.tf, style);
    if (this.weight >= 0) tf = await create("(Landroid/graphics/Typeface;IZ)Landroid/graphics/Typeface;", tf, Math.min(1000, this.weight), (style & 2) !== 0 ? 1 : 0);
    if (tf) {
      const fake = style & ~tf.style();
      if (fake & 1) await call("setFakeBoldText", "(Z)V", 1);
      if (fake & 2) await call("setTextSkewX", "(F)V", -0.25);
      await call("setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", tf);
    }
  }
  if (this.size > 0) await call("setTextSize", "(F)V", this.size);
  if (this.locales) await call("setTextLocales", "(Landroid/os/LocaleList;)V", this.locales);
  if (this.elegant !== null) await call("setElegantTextHeight", "(Z)V", this.elegant);
  if (this.spacing !== null) await call("setLetterSpacing", "(F)V", this.spacing);
  if (this.features !== null) await call("setFontFeatureSettings", "(Ljava/lang/String;)V", this.features);
  if (this.variations !== null) await call("setFontVariationSettings", "(Ljava/lang/String;)Z", this.variations);
}
rt.register({ name: "android/text/style/TextAppearanceSpan", ctor: JTextAppearanceSpan, sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"], methods: {
  "<init>(Landroid/content/Context;I)V": appearanceInit,
  "<init>(Ljava/lang/String;IILandroid/content/res/ColorStateList;Landroid/content/res/ColorStateList;)V": function (this: JTextAppearanceSpan, family: string | null, style: number, size: number, color: JColorStateList | null, link: JColorStateList | null) {
    this.family = family; this.style = style; this.size = size; this.color = color; this.linkColor = link;
  },
  "getFamily()Ljava/lang/String;": function (this: JTextAppearanceSpan) { return this.family; },
  "getTextSize()I": function (this: JTextAppearanceSpan) { return this.size; },
  "getTextStyle()I": function (this: JTextAppearanceSpan) { return this.style; },
  "getTextColor()Landroid/content/res/ColorStateList;": function (this: JTextAppearanceSpan) { return this.color; },
  "getLinkTextColor()Landroid/content/res/ColorStateList;": function (this: JTextAppearanceSpan) { return this.linkColor; },
  "getTypeface()Landroid/graphics/Typeface;": function (this: JTextAppearanceSpan) { return this.typeface; },
  "getTextFontWeight()I": function (this: JTextAppearanceSpan) { return this.weight; },
  "getTextLocales()Landroid/os/LocaleList;": function (this: JTextAppearanceSpan) { return this.locales; },
  "getShadowColor()I": function (this: JTextAppearanceSpan) { return this.shadowColor; },
  "getShadowRadius()F": function (this: JTextAppearanceSpan) { return this.shadowRadius; },
  "getShadowDx()F": function (this: JTextAppearanceSpan) { return this.shadowDx; },
  "getShadowDy()F": function (this: JTextAppearanceSpan) { return this.shadowDy; },
  "getLetterSpacing()F": function (this: JTextAppearanceSpan) { return this.spacing ?? 0; },
  "isElegantTextHeight()Z": function (this: JTextAppearanceSpan) { return this.elegant ?? 0; },
  "getFontFeatureSettings()Ljava/lang/String;": function (this: JTextAppearanceSpan) { return this.features; },
  "getFontVariationSettings()Ljava/lang/String;": function (this: JTextAppearanceSpan) { return this.variations; },
  "getSpanTypeId()I": () => 17, "getSpanTypeIdInternal()I": () => 17, "describeContents()I": () => 0,
  "updateMeasureState(Landroid/text/TextPaint;)V": appearanceMeasure,
  "updateDrawState(Landroid/text/TextPaint;)V": async function (this: JTextAppearanceSpan, paint: JTextPaint) {
    const thread = curThread;
    await vcallOn(thread, this, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
    if (this.color) await vcallOn(thread, paint, "setColor", "(I)V", await vcallOn(thread, this.color, "getColorForState", "([II)I", paint.drawableState, 0));
    if (this.linkColor) paint.linkColor = Number(await vcallOn(thread, this.linkColor, "getColorForState", "([II)I", paint.drawableState, 0));
    if (this.shadowColor) await vcallOn(thread, paint, "setShadowLayer", "(FFFI)V", this.shadowRadius, this.shadowDx, this.shadowDy, this.shadowColor);
  },
} });
class JLocaleSpan extends JMetricAffectingSpan { locales!: JLocaleList; }
function localeState(this: JLocaleSpan, paint: JTextPaint) { return vcall(paint, "setTextLocales", "(Landroid/os/LocaleList;)V", this.locales); }
function writeLocaleSpan(this: JLocaleSpan, parcel: JParcel, flags: number) { return vcall(this.locales, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags); }
rt.register({ name: "android/text/style/LocaleSpan", ctor: JLocaleSpan, sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"], methods: {
  "<init>(Ljava/util/Locale;)V": async function (this: JLocaleSpan, locale: JLocale | null) { this.locales = await newObj("android/os/LocaleList", "([Ljava/util/Locale;)V", locale ? [locale] : []); },
  "<init>(Landroid/os/LocaleList;)V": function (this: JLocaleSpan, locales: JLocaleList) { if (!locales) return rt.npe(); this.locales = locales; },
  "<init>(Landroid/os/Parcel;)V": async function (this: JLocaleSpan, parcel: JParcel) { this.locales = await readLocaleList(parcel); },
  "getLocale()Ljava/util/Locale;": function (this: JLocaleSpan) { return this.locales.values[0] ?? null; },
  "getLocales()Landroid/os/LocaleList;": function (this: JLocaleSpan) { return this.locales; },
  "getSpanTypeId()I": () => 23, "getSpanTypeIdInternal()I": () => 23, "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": writeLocaleSpan, "writeToParcelInternal(Landroid/os/Parcel;I)V": writeLocaleSpan,
  "updateDrawState(Landroid/text/TextPaint;)V": localeState, "updateMeasureState(Landroid/text/TextPaint;)V": localeState,
} });
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

class JDynamicDrawableSpan extends JReplacementSpan {
  alignment = 0;
  cachedDrawable: WeakRef<JDrawable> | null = null;
}
async function spanDrawable(span: JDynamicDrawableSpan): Promise<JDrawable> {
  let drawable = span.cachedDrawable?.deref();
  if (!drawable) {
    drawable = await vcall(span, "getDrawable", "()Landroid/graphics/drawable/Drawable;");
    if (!drawable) return rt.npe();
    span.cachedDrawable = new WeakRef(drawable);
  }
  return drawable;
}
rt.register({ name: "android/text/style/DynamicDrawableSpan", ctor: JDynamicDrawableSpan, sup: "android/text/style/ReplacementSpan",
  statics: { ALIGN_BOTTOM: 0, ALIGN_BASELINE: 1, ALIGN_CENTER: 2 }, fields: { mVerticalAlignment: "alignment" }, methods: {
    "<init>()V": function (this: JDynamicDrawableSpan) { this.alignment = 0; },
    "<init>(I)V": function (this: JDynamicDrawableSpan, alignment: number) { this.alignment = alignment; },
    "getVerticalAlignment()I": function (this: JDynamicDrawableSpan) { return this.alignment; },
    "getSize(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I": async function (this: JDynamicDrawableSpan, _paint: JPaint, _text: unknown, _start: number, _end: number, fm: { ascent: number; descent: number; top: number; bottom: number } | null) {
      const bounds: JRect = await vcall(await spanDrawable(this), "getBounds", "()Landroid/graphics/Rect;");
      if (fm) { fm.ascent = fm.top = -bounds.bottom; fm.descent = fm.bottom = 0; }
      return bounds.right;
    },
    "draw(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V": async function (this: JDynamicDrawableSpan, canvas: JCanvas, _text: unknown, _start: number, _end: number, x: number, top: number, _y: number, bottom: number, paint: JPaint) {
      const drawable = await spanDrawable(this), bounds: JRect = await vcall(drawable, "getBounds", "()Landroid/graphics/Rect;");
      let y = bottom - bounds.bottom;
      if (this.alignment === 1) y -= (await vcall(paint, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;")).descent;
      else if (this.alignment === 2) y = top + Math.trunc((bottom - top) / 2) - Math.trunc((bounds.bottom - bounds.top) / 2);
      canvas.ctx.save(); canvas.ctx.translate(x, y);
      try { await vcall(drawable, "draw", "(Landroid/graphics/Canvas;)V", canvas); } finally { canvas.ctx.restore(); }
    },
  },
});
type SpanImage = { kind: "drawable"; value: JDrawable } | { kind: "resource"; context: unknown; id: number } | { kind: "uri"; context: unknown; uri: unknown };
class JImageSpan extends JDynamicDrawableSpan { image: SpanImage | null = null; source: string | null = null; }
function imageDrawable(this: JImageSpan, drawable: JDrawable, alignment = 0) { this.image = { kind: "drawable", value: drawable }; this.alignment = alignment; }
function imageResource(this: JImageSpan, context: unknown, id: number, alignment = 0) { this.image = { kind: "resource", context, id }; this.alignment = alignment; }
async function imageUri(this: JImageSpan, context: unknown, uri: unknown, alignment = 0) {
  this.image = { kind: "uri", context, uri }; this.alignment = alignment;
  this.source = await vcall(uri, "toString", "()Ljava/lang/String;");
}
async function imageBitmap(this: JImageSpan, context: unknown, bitmap: JBitmap, alignment = 0) {
  const resources = context ? await vcall(context, "getResources", "()Landroid/content/res/Resources;") : null;
  const drawable: JDrawable = await newObj("android/graphics/drawable/BitmapDrawable", "(Landroid/content/res/Resources;Landroid/graphics/Bitmap;)V", resources, bitmap);
  await vcall(drawable, "setBounds", "(IIII)V", 0, 0, Math.max(0, await vcall(drawable, "getIntrinsicWidth", "()I")), Math.max(0, await vcall(drawable, "getIntrinsicHeight", "()I")));
  imageDrawable.call(this, drawable, alignment);
}
rt.register({ name: "android/text/style/ImageSpan", ctor: JImageSpan, sup: "android/text/style/DynamicDrawableSpan", methods: {
  "<init>(Landroid/graphics/drawable/Drawable;)V": imageDrawable,
  "<init>(Landroid/graphics/drawable/Drawable;I)V": imageDrawable,
  "<init>(Landroid/graphics/drawable/Drawable;Ljava/lang/String;)V": function (this: JImageSpan, drawable: JDrawable, source: string) { imageDrawable.call(this, drawable); this.source = source; },
  "<init>(Landroid/graphics/drawable/Drawable;Ljava/lang/String;I)V": function (this: JImageSpan, drawable: JDrawable, source: string, alignment: number) { imageDrawable.call(this, drawable, alignment); this.source = source; },
  "<init>(Landroid/content/Context;I)V": imageResource,
  "<init>(Landroid/content/Context;II)V": imageResource,
  "<init>(Landroid/content/Context;Landroid/net/Uri;)V": imageUri,
  "<init>(Landroid/content/Context;Landroid/net/Uri;I)V": imageUri,
  "<init>(Landroid/content/Context;Landroid/graphics/Bitmap;)V": imageBitmap,
  "<init>(Landroid/content/Context;Landroid/graphics/Bitmap;I)V": imageBitmap,
  "<init>(Landroid/graphics/Bitmap;)V": function (this: JImageSpan, bitmap: JBitmap) { return imageBitmap.call(this, null, bitmap); },
  "<init>(Landroid/graphics/Bitmap;I)V": function (this: JImageSpan, bitmap: JBitmap, alignment: number) { return imageBitmap.call(this, null, bitmap, alignment); },
  "getSource()Ljava/lang/String;": function (this: JImageSpan) { return this.source; },
  "getDrawable()Landroid/graphics/drawable/Drawable;": async function (this: JImageSpan) {
    const image = this.image;
    if (!image) return null;
    if (image.kind === "drawable") return image.value;
    const resources = await vcall(image.context, "getResources", "()Landroid/content/res/Resources;");
    let drawable: JDrawable;
    if (image.kind === "resource") drawable = await vcall(image.context, "getDrawable", "(I)Landroid/graphics/drawable/Drawable;", image.id);
    else {
      const resolver = await vcall(image.context, "getContentResolver", "()Landroid/content/ContentResolver;");
      const stream = await vcall(resolver, "openInputStream", "(Landroid/net/Uri;)Ljava/io/InputStream;", image.uri);
      let bitmap: JBitmap;
      try { bitmap = await vcall(rt.link("android/graphics/BitmapFactory").ctor, "decodeStream", "(Ljava/io/InputStream;)Landroid/graphics/Bitmap;", stream); }
      finally { await vcall(stream, "close", "()V"); }
      drawable = await newObj("android/graphics/drawable/BitmapDrawable", "(Landroid/content/res/Resources;Landroid/graphics/Bitmap;)V", resources, bitmap);
    }
    await vcall(drawable, "setBounds", "(IIII)V", 0, 0, await vcall(drawable, "getIntrinsicWidth", "()I"), await vcall(drawable, "getIntrinsicHeight", "()I"));
    return drawable;
  },
} });

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
  "android/text/style/ClickableSpan": { sup: "android/text/style/CharacterStyle", ifaces: ["android/text/style/UpdateAppearance"] },
  "android/text/style/URLSpan": { sup: "android/text/style/ClickableSpan" },
};
for (const [name] of [
  ["android/text/style/BackgroundColorSpan", { color: 0 }],
  ["android/text/style/UnderlineSpan", {}],
  ["android/text/style/StrikethroughSpan", {}],
] as const) {
  const Base = spanHierarchy[name].sup === "android/text/style/MetricAffectingSpan" ? JMetricAffectingSpan : JCharacterStyle;
  const c = class extends Base { color = 0; style = 0; size = 1; url = ""; };
  rt.register({
    name, ctor: c,
    ...spanHierarchy[name],
    methods: {
      "<init>(I)V": function (this: any, v: number) { this.color = v; this.style = v; this.size = v; },
      "<init>(F)V": function (this: any, v: number) { this.size = v; },
      "<init>(Ljava/lang/String;)V": function (this: any, v: string) { this.url = v; },
      ...noops("<init>()V"),
      "getURL()Ljava/lang/String;": function (this: any) { return this.url; },
      "getForegroundColor()I": function (this: any) { return this.color; },
      ...(name === "android/text/style/BackgroundColorSpan" ? {
        "updateDrawState(Landroid/text/TextPaint;)V": function (this: { color: number }, paint: JTextPaint) { paint.bgColor = this.color; },
      } : {}),
      "getStyle()I": function (this: any) { return this.style; },
    },
  });
}

class JClickableSpan extends JCharacterStyle {}
rt.register({
  name: "android/text/style/ClickableSpan", ctor: JClickableSpan,
  ...spanHierarchy["android/text/style/ClickableSpan"],
  methods: {
    "<init>()V": function () {},
    "updateDrawState(Landroid/text/TextPaint;)V": async (paint: JTextPaint) => {
      await vcall(paint, "setColor", "(I)V", paint.linkColor);
      await vcall(paint, "setUnderlineText", "(Z)V", 1);
    },
  },
});
class JURLSpan extends JClickableSpan { url = ""; }
rt.register({
  name: "android/text/style/URLSpan", ctor: JURLSpan,
  ...spanHierarchy["android/text/style/URLSpan"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JURLSpan, url: string) { this.url = url; },
    "getURL()Ljava/lang/String;": function (this: JURLSpan) { return this.url; },
  },
});

class JTypefaceSpan extends JMetricAffectingSpan {
  family: string | null = null;
  typeface: JTypeface | null = null;
}
function applyTypefaceSpan(this: JTypefaceSpan, paint: JTextPaint): void {
  paint.tf = this.typeface ?? typefaceFor(this.family, paint.tf.style());
}
rt.register({
  name: "android/text/style/TypefaceSpan", ctor: JTypefaceSpan,
  ...spanHierarchy["android/text/style/TypefaceSpan"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JTypefaceSpan, family: string | null) { this.family = family; },
    "<init>(Landroid/graphics/Typeface;)V": function (this: JTypefaceSpan, typeface: JTypeface) { this.typeface = typeface; },
    "getFamily()Ljava/lang/String;": function (this: JTypefaceSpan) { return this.family; },
    "getTypeface()Landroid/graphics/Typeface;": function (this: JTypefaceSpan) { return this.typeface; },
    "updateDrawState(Landroid/text/TextPaint;)V": applyTypefaceSpan,
    "updateMeasureState(Landroid/text/TextPaint;)V": applyTypefaceSpan,
  },
});

class JForegroundColorSpan extends JObj { color = 0; }
rt.register({ name: "android/text/style/ForegroundColorSpan", ctor: JForegroundColorSpan,
  ...spanHierarchy["android/text/style/ForegroundColorSpan"], methods: {
    "<init>(I)V": function (this: JForegroundColorSpan, color: number) { this.color = color; },
    "getForegroundColor()I": function (this: JForegroundColorSpan) { return this.color; },
    "updateDrawState(Landroid/text/TextPaint;)V": function (this: JForegroundColorSpan, paint: JTextPaint) { paint.color = this.color; },
  },
});

class JStyleSpan extends JObj { style = 0; adjustment = 0x7fffffff; }
async function applyStyle(this: JStyleSpan, paint: JTextPaint) {
  const old = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
  const want = (old ? await vcall(old, "getStyle", "()I") : 0) | this.style;
  const typeface = rt.link("android/graphics/Typeface").ctor;
  let face = old ? await vcall(typeface, "create", "(Landroid/graphics/Typeface;I)Landroid/graphics/Typeface;", old, want)
    : await vcall(typeface, "defaultFromStyle", "(I)Landroid/graphics/Typeface;", want);
  if ((this.style & 1) && this.adjustment && this.adjustment !== 0x7fffffff) {
    const weight = Math.max(1, Math.min(1000, await vcall(face, "getWeight", "()I") + this.adjustment));
    face = await vcall(typeface, "create", "(Landroid/graphics/Typeface;IZ)Landroid/graphics/Typeface;", face, weight, (want & 2) ? 1 : 0);
  }
  const fake = want & ~await vcall(face, "getStyle", "()I");
  if (fake & 1) await vcall(paint, "setFakeBoldText", "(Z)V", 1);
  if (fake & 2) await vcall(paint, "setTextSkewX", "(F)V", -0.25);
  await vcall(paint, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", face);
}
rt.register({ name: "android/text/style/StyleSpan", ctor: JStyleSpan, ...spanHierarchy["android/text/style/StyleSpan"], methods: {
  "<init>(I)V": function (this: JStyleSpan, style: number) { this.style = style; },
  "<init>(II)V": function (this: JStyleSpan, style: number, adjustment: number) { this.style = style; this.adjustment = adjustment; },
  "getStyle()I": function (this: JStyleSpan) { return this.style; },
  "getFontWeightAdjustment()I": function (this: JStyleSpan) { return this.adjustment; },
  "updateDrawState(Landroid/text/TextPaint;)V": applyStyle,
  "updateMeasureState(Landroid/text/TextPaint;)V": applyStyle,
} });
class JRelativeSizeSpan extends JObj { size = 1; }
async function applyRelativeSize(this: JRelativeSizeSpan, paint: JTextPaint) {
  return vcall(paint, "setTextSize", "(F)V", await vcall(paint, "getTextSize", "()F") * this.size);
}
rt.register({ name: "android/text/style/RelativeSizeSpan", ctor: JRelativeSizeSpan, ...spanHierarchy["android/text/style/RelativeSizeSpan"], methods: {
  "<init>(F)V": function (this: JRelativeSizeSpan, size: number) { this.size = size; },
  "getSizeChange()F": function (this: JRelativeSizeSpan) { return this.size; },
  "updateDrawState(Landroid/text/TextPaint;)V": applyRelativeSize,
  "updateMeasureState(Landroid/text/TextPaint;)V": applyRelativeSize,
} });

export function drawStyledText(src: unknown, text: string, start: number, canvas: JCanvas, paint: JTextPaint, x: number, y: number, color = paint.color): Promise<void> | undefined {
  if (!(src instanceof JSpanned)) return;
  const end = start + text.length;
  const spans = src.spans.filter((r) => r.start < end && r.end > start && rt.iof(r.span, "android/text/style/CharacterStyle")
    && !rt.iof(r.span, "android/text/style/ReplacementSpan"));
  if (!spans.length) return;
  spans.sort((a, b) => (b.flags & 0xff0000) - (a.flags & 0xff0000));
  const edges = [...new Set([start, end, ...spans.flatMap((r) => [Math.max(start, r.start), Math.min(end, r.end)])])].sort((a, b) => a - b);
  return (async () => {
    const p = new JTextPaint();
    canvas.ctx.save();
    try {
      for (let i = 0; i < edges.length - 1; i++) {
        copyTextPaint(paint, p); p.color = color; p.textAlignN = 0;
        for (const r of spans) if (r.start <= edges[i] && r.end > edges[i]) {
          const pending = vcallMaybe(r.span, "updateDrawState", "(Landroid/text/TextPaint;)V", p);
          if (pending instanceof Promise) await pending;
        }
        const run = text.slice(edges[i] - start, edges[i + 1] - start);
        const pending = vcallMaybe(canvas, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", run, x, y, p);
        if (pending instanceof Promise) await pending;
        x += measureText(p, run);
      }
    } finally { canvas.ctx.restore(); }
  })();
}

async function superscriptState(this: unknown, paint: JTextPaint) {
  paint.baselineShift += Math.trunc(Number(await vcall(paint, "ascent", "()F")) / 2);
}
rt.register({ name: "android/text/style/SuperscriptSpan", ctor: class extends JMetricAffectingSpan {},
  sup: "android/text/style/MetricAffectingSpan", ifaces: ["android/text/ParcelableSpan"], methods: {
    "<init>()V": () => {}, "<init>(Landroid/os/Parcel;)V": () => {},
    "getSpanTypeId()I": () => 14, "getSpanTypeIdInternal()I": () => 14, "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": () => {}, "writeToParcelInternal(Landroid/os/Parcel;I)V": () => {},
    "updateDrawState(Landroid/text/TextPaint;)V": superscriptState,
    "updateMeasureState(Landroid/text/TextPaint;)V": superscriptState,
  },
});

class JAbsoluteSizeSpan extends JMetricAffectingSpan { size = 0; dip = 0; }
function absoluteSize(this: JAbsoluteSizeSpan, paint: JTextPaint) {
  return vcall(paint, "setTextSize", "(F)V", this.size * (this.dip ? paint.density : 1));
}
rt.register({ name: "android/text/style/AbsoluteSizeSpan", ctor: JAbsoluteSizeSpan,
  ...spanHierarchy["android/text/style/AbsoluteSizeSpan"],
  methods: {
    "<init>(I)V": function (this: JAbsoluteSizeSpan, size: number) { this.size = size; },
    "<init>(IZ)V": function (this: JAbsoluteSizeSpan, size: number, dip: number) { this.size = size; this.dip = dip; },
    "getSize()I": function (this: JAbsoluteSizeSpan) { return this.size; },
    "getDip()Z": function (this: JAbsoluteSizeSpan) { return this.dip; },
    "updateMeasureState(Landroid/text/TextPaint;)V": absoluteSize,
    "updateDrawState(Landroid/text/TextPaint;)V": absoluteSize,
  },
});

// Paragraph-level spans: interfaces the layout would consult per paragraph (nothing in JLayout
// walks them yet), plus the concrete Standard leading-margin span Compose uses for textIndent.
rt.markers("android/text/style/ParagraphStyle");
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
rt.markers("android/text/style/LineBackgroundSpan");
class JQuoteSpan extends JObj { color = 0xff0000ff | 0; stripe = 2; gap = 2; }
rt.register({
  name: "android/text/style/QuoteSpan", ctor: JQuoteSpan,
  ifaces: ["android/text/style/LeadingMarginSpan", "android/text/ParcelableSpan"],
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JQuoteSpan, c: number) { this.color = c; },
    "<init>(III)V": function (this: JQuoteSpan, c: number, w: number, g: number) { this.color = c; this.stripe = w; this.gap = g; },
    "getColor()I": function (this: JQuoteSpan) { return this.color; },
    "getStripeWidth()I": function (this: JQuoteSpan) { return this.stripe; },
    "getGapWidth()I": function (this: JQuoteSpan) { return this.gap; },
    "getLeadingMargin(Z)I": function (this: JQuoteSpan) { return this.stripe + this.gap; },
    "drawLeadingMargin(Landroid/graphics/Canvas;Landroid/graphics/Paint;IIIIIILjava/lang/CharSequence;IIZLandroid/text/Layout;)V": () => {},
  },
});
class JBulletSpan extends JObj { gap = 8; color = 0; radius = 4; }
rt.register({
  name: "android/text/style/BulletSpan", ctor: JBulletSpan,
  ifaces: ["android/text/style/LeadingMarginSpan", "android/text/ParcelableSpan"],
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JBulletSpan, gap: number) { this.gap = gap; },
    "<init>(II)V": function (this: JBulletSpan, gap: number, c: number) { this.gap = gap; this.color = c; },
    "<init>(III)V": function (this: JBulletSpan, gap: number, c: number, r: number) { this.gap = gap; this.color = c; this.radius = r; },
    "getLeadingMargin(Z)I": function (this: JBulletSpan) { return 2 * this.radius + this.gap; },
    "getBulletRadius()I": function (this: JBulletSpan) { return this.radius; },
    "getGapWidth()I": function (this: JBulletSpan) { return this.gap; },
    "getColor()I": function (this: JBulletSpan) { return this.color; },
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

export class JEditable extends JSpannable {}
rt.register({
  name: "webdroid/Editable", ctor: JEditable,
  ifaces: ["android/text/Editable", "java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned"],
  methods: {
    ...spanMethods,
    "append(Ljava/lang/CharSequence;)Landroid/text/Editable;": appendSpanned,
    "clear()V": function (this: JEditable) { this.text = ""; this.spans = []; },
    ...editMutators("android/text/Editable"),
  },
});

async function adjacentTextOffset(cs: unknown, offset: number, after: boolean): Promise<number> {
  if (!after && (offset === 0 || offset === 1)) return 0;
  if (cs == null) return rt.npe();
  const thread = rt.th(), text = await csText(cs); rt.st(thread);
  if (offset < 0 || offset > text.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(offset));
  if (after && offset >= text.length - 1) return text.length;
  const a = text.charCodeAt(after ? offset : offset - 2), b = text.charCodeAt(after ? offset + 1 : offset - 1);
  offset += (after ? 1 : -1) * (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff ? 2 : 1);
  if (cs instanceof JSpanned) {
    const spans = cs.spans.filter(s => s.start < offset && s.end > offset && rt.iof(s.span, "android/text/style/ReplacementSpan"));
    for (const span of spans) if (span.start < offset && span.end > offset) offset = after ? span.end : span.start;
  } else if (rt.iof(cs, "android/text/Spanned")) {
    const spans = await vcall(cs, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", offset, offset, rt.classFor("android/text/style/ReplacementSpan")); rt.st(thread);
    for (const span of spans) {
      const start = await vcall(cs, "getSpanStart", "(Ljava/lang/Object;)I", span); rt.st(thread);
      const end = await vcall(cs, "getSpanEnd", "(Ljava/lang/Object;)I", span); rt.st(thread);
      if (start < offset && end > offset) offset = after ? end : start;
    }
  }
  return offset;
}

async function textIndexOf(cs: unknown, needle: unknown, start = 0, end?: number): Promise<number> {
  const thread = rt.th(), text = await csText(cs); rt.st(thread);
  const part = await csText(needle); rt.st(thread);
  if (!part.length) return start;
  const found = text.indexOf(part, start);
  return found > (end ?? text.length) - part.length ? -1 : found;
}

export async function writeText(text: unknown, parcel: JParcel): Promise<void> {
  if (text !== null && rt.iof(text, "android/text/Spanned")) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Spanned text parcel");
  writeInt(parcel, 1); writeString8(parcel, text === null ? null : await csText(text));
}
export async function readText(parcel: JParcel): Promise<string | null> {
  const kind = readInt(parcel), text = readString8(parcel);
  if (text !== null && kind !== 1 && readInt(parcel) !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Spanned text parcel");
  return text;
}
class JTextUtils extends JObj {}
// AndroidCharacter: the bidi mirror pairs of the characters apps ask about (Unicode BidiMirroring's
// paired brackets and quotes); everything else mirrors to itself
const MIRROR = new Map<number, number>();
for (const [a, b] of ["()", "[]", "{}", "<>", "«»", "‹›", "⁅⁆", "⁽⁾", "₍₎", "〈〉", "《》", "「」", "『』", "【】", "〔〕", "〖〗", "〘〙", "〚〛", "（）", "［］", "｛｝", "｟｠", "｢｣", "≤≥", "∈∋", "∼∽"]) { MIRROR.set(a.charCodeAt(0), b.charCodeAt(0)); MIRROR.set(b.charCodeAt(0), a.charCodeAt(0)); }
rt.register({
  name: "android/text/AndroidCharacter", ctor: class extends JObj {},
  statics: { EAST_ASIAN_WIDTH_NEUTRAL: 0, EAST_ASIAN_WIDTH_AMBIGUOUS: 1, EAST_ASIAN_WIDTH_HALF_WIDTH: 2, EAST_ASIAN_WIDTH_FULL_WIDTH: 3, EAST_ASIAN_WIDTH_NARROW: 4, EAST_ASIAN_WIDTH_WIDE: 5 },
  methods: {
    "static getMirror(C)C": (c: number) => MIRROR.get(c) ?? c,
    "static mirror([CII)Z": (chars: Uint16Array, start: number, count: number) => {
      let changed = 0;
      for (let i = start; i < start + count; i++) { const m = MIRROR.get(chars[i]); if (m !== undefined) { chars[i] = m; changed = 1; } }
      return changed;
    },
    "static getDirectionality(C)B": (c: number) => (c >= 0x590 && c <= 0x8ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff) ? 1 : c < 0x20 || (c >= 0x2000 && c <= 0x200f) ? 12 : 0,
    "static getDirectionalities([C[BI)V": (chars: Uint16Array, out: Int8Array, count: number) => { for (let i = 0; i < count; i++) out[i] = chars[i] >= 0x590 && chars[i] <= 0x8ff ? 1 : 0; },
    "static getEastAsianWidth(CZ)I": (c: number) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 5 : (c >= 0xff61 && c <= 0xffdc) ? 2 : (c >= 0xffe0 && c <= 0xffe6) ? 3 : 0,
  },
});
rt.register({
  name: "android/text/TextUtils", ctor: JTextUtils,
  statics: { get CHAR_SEQUENCE_CREATOR() { return parcelCreator("java/lang/CharSequence", readText); } },
  methods: {
    "static writeToParcel(Ljava/lang/CharSequence;Landroid/os/Parcel;I)V": writeText,
    "static getOffsetBefore(Ljava/lang/CharSequence;I)I": async (cs: unknown, offset: number) => adjacentTextOffset(cs, offset, false),
    "static getOffsetAfter(Ljava/lang/CharSequence;I)I": async (cs: unknown, offset: number) => adjacentTextOffset(cs, offset, true),
    "static getLayoutDirectionFromLocale(Ljava/util/Locale;)I": localeDirection,
    "static getCapsMode(Ljava/lang/CharSequence;II)I": async (cs: unknown, off: number, requested: number) => {
      if (off < 0) return 0;
      const mode = requested & 0x1000;
      if (!(requested & 0x6000)) return mode;
      const text = await csText(cs);
      if (off > text.length) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", String(off));
      let i = off;
      while (i > 0 && /["'\p{Ps}]/u.test(text[i - 1])) i--;
      let j = i;
      while (j > 0 && (text[j - 1] === " " || text[j - 1] === "\t")) j--;
      if (j === 0 || text[j - 1] === "\n") return mode | 0x2000;
      if (!(requested & 0x4000)) return mode | (i !== j ? 0x2000 : 0);
      if (i === j) return mode;
      while (j > 0 && /["'\p{Pe}]/u.test(text[j - 1])) j--;
      const end = text[j - 1];
      if (end !== "." && end !== "?" && end !== "!") return mode;
      if (end === ".") {
        for (let k = j - 2; k >= 0; k--) {
          if (text[k] === ".") return mode;
          if (!/\p{L}/u.test(text[k])) break;
        }
      }
      return mode | 0x4000;
    },
    "static isEmpty(Ljava/lang/CharSequence;)Z": (s: unknown) => (s === null || spannedString(s).length === 0 ? 1 : 0),
    // True when a run is left-to-right throughout, which lets StaticLayout skip the bidi
    // reordering entirely. It is a real scan, not an assumption: the RTL blocks are Hebrew,
    // Arabic, Syriac, Thaana, N'Ko, Samaritan and the Arabic presentation forms, plus the
    // explicit direction-formatting characters.
    "static doesNotNeedBidi([CII)Z": (text: Uint16Array, start: number, len: number) => {
      for (let i = start; i < start + len; i++) {
        const c = text[i];
        if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfefc) ||
            (c >= 0x200e && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return 0;
      }
      return 1;
    },
    // AOSP's StaticLayout copies each paragraph out through this rather than toString(), so a
    // Spanned is never flattened on the way in
    "static getChars(Ljava/lang/CharSequence;II[CI)V": (src: unknown, start: number, end: number, dst: Uint16Array, off: number) => {
      const t = spannedString(src);
      for (let i = start; i < end; i++) dst[off + i - start] = t.charCodeAt(i);
    },
    // how AOSP's own StaticLayout finds paragraph boundaries, and how app code scans a Spanned
    // without flattening it
    "static indexOf(Ljava/lang/CharSequence;C)I": (s: unknown, ch: number) => spannedString(s).indexOf(String.fromCharCode(ch)),
    "static lastIndexOf(Ljava/lang/CharSequence;C)I": (s: unknown, ch: number) => spannedString(s).lastIndexOf(String.fromCharCode(ch)),
    // AOSP: the last occurrence at or after `start` and at or before `last`
    "static lastIndexOf(Ljava/lang/CharSequence;CII)I": (s: unknown, ch: number, start: number, last: number) => {
      const i = spannedString(s).lastIndexOf(String.fromCharCode(ch), last);
      return i >= start ? i : -1;
    },
    "static indexOf(Ljava/lang/CharSequence;CI)I": (s: unknown, ch: number, from: number) => spannedString(s).indexOf(String.fromCharCode(ch), from),
    "static indexOf(Ljava/lang/CharSequence;CII)I": (s: unknown, ch: number, from: number, to: number) => {
      const i = spannedString(s).slice(0, to).indexOf(String.fromCharCode(ch), from);
      return i;
    },
    "static lastIndexOf(Ljava/lang/CharSequence;CI)I": async (s: unknown, ch: number, last: number) =>
      last < 0 ? -1 : (await csText(s)).lastIndexOf(String.fromCharCode(ch), last),
    "static indexOf(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)I": textIndexOf,
    "static indexOf(Ljava/lang/CharSequence;Ljava/lang/CharSequence;I)I": textIndexOf,
    "static indexOf(Ljava/lang/CharSequence;Ljava/lang/CharSequence;II)I": textIndexOf,
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
    "static concat([Ljava/lang/CharSequence;)Ljava/lang/CharSequence;": concatText,
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

class JHtml extends JObj {}
rt.register({
  name: "android/text/Html", ctor: JHtml,
  methods: {
    "static fromHtml(Ljava/lang/String;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static fromHtml(Ljava/lang/String;I)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    // the image getter and tag handler are the app's hooks for <img> and unknown tags; the
    // stripping converter below has neither, so they are accepted and ignored
    "static fromHtml(Ljava/lang/String;Landroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static fromHtml(Ljava/lang/String;ILandroid/text/Html$ImageGetter;Landroid/text/Html$TagHandler;)Landroid/text/Spanned;": (s: string) => htmlToSpan(s),
    "static toHtml(Landroid/text/Spanned;)Ljava/lang/String;": (sp: unknown) => spannedString(sp),
    "static toHtml(Landroid/text/Spanned;I)Ljava/lang/String;": (sp: unknown) => spannedString(sp),
    // AOSP withinStyle: the five markup characters and every non-ASCII code point as entities
    "static escapeHtml(Ljava/lang/CharSequence;)Ljava/lang/String;": (cs: unknown) =>
      String(cs).replace(/[<>&'"]|[^\x00-\x7f]/gu, (c) => c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&#39;" : c === "\"" ? "&quot;" : "&#" + c.codePointAt(0) + ";"),
  },
});
for (const n of ["android/text/Html$ImageGetter", "android/text/Html$TagHandler",
  "org/xml/sax/ContentHandler", "org/xml/sax/DTDHandler", "org/xml/sax/EntityResolver", "org/xml/sax/ErrorHandler"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}
type SaxAttr = { uri: string; local: string; qname: string; value: string };
class JSaxAttributes extends JObj { values: SaxAttr[] = []; }
const saxAttributeMethods = {
  "getLength()I": function (this: JSaxAttributes) { return this.values.length; },
  "getURI(I)Ljava/lang/String;": function (this: JSaxAttributes, i: number) { return this.values[i]?.uri ?? null; },
  "getLocalName(I)Ljava/lang/String;": function (this: JSaxAttributes, i: number) { return this.values[i]?.local ?? null; },
  "getQName(I)Ljava/lang/String;": function (this: JSaxAttributes, i: number) { return this.values[i]?.qname ?? null; },
  "getType(I)Ljava/lang/String;": function (this: JSaxAttributes, i: number) { return this.values[i] ? "CDATA" : null; },
  "getValue(I)Ljava/lang/String;": function (this: JSaxAttributes, i: number) { return this.values[i]?.value ?? null; },
  "getValue(Ljava/lang/String;)Ljava/lang/String;": function (this: JSaxAttributes, qname: string) { return this.values.find((a) => a.qname === qname)?.value ?? null; },
  "getValue(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": function (this: JSaxAttributes, uri: string, local: string) {
    return this.values.find((a) => a.uri === uri && a.local === local)?.value ?? null;
  },
};
rt.register({
  name: "org/xml/sax/Attributes", ctor: JSaxAttributes,
  methods: saxAttributeMethods,
});
rt.register({
  name: "org/xml/sax/helpers/AttributesImpl", ctor: class extends JSaxAttributes {},
  ifaces: ["org/xml/sax/Attributes"],
  methods: {
    ...saxAttributeMethods,
    "<init>()V": function () {},
    "<init>(Lorg/xml/sax/Attributes;)V": async function (this: JSaxAttributes, source: unknown) {
      const length = await vcall(source, "getLength", "()I") as number;
      for (let i = 0; i < length; i++) this.values.push({
        uri: await vcall(source, "getURI", "(I)Ljava/lang/String;", i) as string,
        local: await vcall(source, "getLocalName", "(I)Ljava/lang/String;", i) as string,
        qname: await vcall(source, "getQName", "(I)Ljava/lang/String;", i) as string,
        value: await vcall(source, "getValue", "(I)Ljava/lang/String;", i) as string,
      });
    },
  },
});
/** AOSP parses the markup and emits spans; the browser already has the parser, so use it —
 *  a stripper loses the bold/italic/link/quote structure AND every named entity. */
const HTML_BLOCK = /^(P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|TABLE|TR)$/;
function htmlToSpan(s: string): JSpannable {
  const sp = new JSpannable();
  if (typeof DOMParser === "undefined") { sp.text = s.replace(/<[^>]+>/g, ""); return sp; }
  const mk = (n: string) => new (rt.link(n).ctor as new () => Record<string, unknown>)();
  const walk = (node: Node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { sp.text += c.nodeValue ?? ""; continue; }
      if (c.nodeType !== 1) continue;
      const el = c as Element, tag = el.tagName;
      if (tag === "BR") { sp.text += "\n"; continue; }
      const block = HTML_BLOCK.test(tag);
      if (block && sp.text && !sp.text.endsWith("\n\n")) sp.text += "\n\n";
      const start = sp.text.length;
      walk(el);
      const add = (span: unknown) => sp.spans.push({ span, start, end: sp.text.length, flags: 33 });
      if (tag === "B" || tag === "STRONG") { const o = mk("android/text/style/StyleSpan"); o.style = 1; add(o); }
      else if (tag === "I" || tag === "EM" || tag === "CITE") { const o = mk("android/text/style/StyleSpan"); o.style = 2; add(o); }
      else if (tag === "U") add(mk("android/text/style/UnderlineSpan"));
      else if (tag === "CODE" || tag === "PRE") add(mk("android/text/style/TypefaceSpan"));
      else if (tag === "BLOCKQUOTE") add(mk("android/text/style/QuoteSpan"));
      else if (tag === "A") { const o = mk("android/text/style/URLSpan"); o.url = el.getAttribute("href") ?? ""; add(o); }
      if (block) sp.text += "\n\n";
    }
  };
  walk(new DOMParser().parseFromString(s, "text/html").body);
  sp.text = sp.text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return sp;
}

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
type SpanMetrics = { top: number; ascent: number; descent: number; bottom: number; leading: number };
type Replacement = SpanRec & { width: number; metrics: SpanMetrics; paint: JTextPaint };
function replacementSpans(cs: unknown): SpanRec[] {
  return cs instanceof JSpanned ? cs.spans.filter((s) => s.end > s.start && rt.iof(s.span, "android/text/style/ReplacementSpan")).sort((a, b) => a.start - b.start) : [];
}
export async function measureReplacements(cs: unknown, paint: JTextPaint, spans = replacementSpans(cs)): Promise<Replacement[]> {
  const result: Replacement[] = [], thread = curThread;
  for (const span of spans) {
    const p = new JTextPaint(); copyPaint(paint, p); p.density = paint.density;
    if (cs instanceof JSpanned) for (const style of cs.spans) {
      if (style.end <= span.start || style.start >= span.end || rt.iof(style.span, "android/text/style/ReplacementSpan")) continue;
      if (rt.iof(style.span, "android/text/style/MetricAffectingSpan")) await vcallOn(thread, style.span, "updateMeasureState", "(Landroid/text/TextPaint;)V", p);
    }
    const metrics: SpanMetrics = await newObj("android/graphics/Paint$FontMetricsInt"); fillFontMetrics(p, metrics, true);
    const width = await vcallOn(thread, span.span, "getSize", "(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I", p, cs, span.start, span.end, metrics);
    result.push({ ...span, width: Number(width), metrics, paint: p });
  }
  return result;
}
function replacementWidth(text: string, paint: JTextPaint, replacements: Replacement[], start: number, end: number): number {
  let x = 0, position = start;
  for (const span of replacements) {
    if (span.end <= position || span.start >= end) continue;
    if (span.start > position) x += measureText(paint, text.slice(position, span.start));
    x += span.width; position = span.end;
  }
  return x + (position < end ? measureText(paint, text.slice(position, end)) : 0);
}
export interface TLine { start: number; end: number; text: string; width: number; ellipsis?: { start: number; count: number }; }

/**
 * Greedy line breaking over `measureText`: the break point is the largest space index that
 * still fits, else the largest character index. Widths grow monotonically with prefix length,
 * so the character limit is a binary search rather than a step back per word (that was O(n)
 * measures per line and O(n^2) per paragraph).
 *
 * `first` is the width of the first `firstCount` lines and `rest` of the ones after, which is
 * AOSP's ParagraphConstraints. Exported so its own LineBreaker bytecode reaches this body
 * through the delegate rather than a second copy of it.
 */
export function greedyBreaks(text: string, p: JTextPaint, first: number, firstCount: number, rest: number, maxLines = Number.MAX_SAFE_INTEGER, rangeWidth?: (start: number, end: number) => number, breakAt?: (start: number, end: number) => number): TLine[] {
  const out: TLine[] = [];
  const paras = text.split("\n");
  let pos = 0;
  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi];
    if (out.length >= maxLines) break;
    const before = out.length;
    if (para === "") { out.push({ start: pos, end: pos, text: "", width: 0 }); }
    else {
      let left = para, off = 0;
      while (left.length && out.length < maxLines) {
        const width = out.length < firstCount ? first : rest;
        let n = left.length;
        if ((rangeWidth ? rangeWidth(pos + off, pos + para.length) : measureText(p, left)) > width) {
          let lo = 1, hi = left.length;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((rangeWidth ? rangeWidth(pos + off, pos + off + mid) : measureText(p, left.slice(0, mid))) <= width) lo = mid; else hi = mid - 1;
          }
          const sp = left.lastIndexOf(" ", Math.min(lo, left.length - 2));
          n = sp > 0 ? sp : lo;
        }
        if (breakAt) n = breakAt(pos + off, pos + off + n) - pos - off;
        const chunk = left.slice(0, n);
        out.push({ start: pos + off, end: pos + off + n, text: chunk, width: rangeWidth ? rangeWidth(pos + off, pos + off + n) : measureText(p, chunk) });
        off += n;
        if (left[n] === " ") { n++; off++; }
        left = left.slice(n);
      }
    }
    // A line that ends a paragraph OWNS its newline: AOSP's invariant is
    // getLineEnd(i) == getLineStart(i + 1), and an app slicing text by line loses the
    // separators without it. `text` still excludes it, which is what getLineVisibleEnd reports.
    if (pi < paras.length - 1 && out.length > before) out[out.length - 1].end++;
    pos += para.length + 1;
  }
  if (!out.length) out.push({ start: 0, end: 0, text: "", width: 0 });
  return out;
}
export class JLayout extends JObj {
  text = "";
  /** the CharSequence the layout was built from, kept for its spans (LineHeightSpan) */
  src: unknown = null;
  paint!: JTextPaint;
  width = 0;
  lines: TLine[] = [];
  replacements: Replacement[] = [];
  spacingMult = 1; spacingAdd = 0;
  includePad = true;
  asc = 0; desc = 0; padTop = 0; padBottom = 0;
  /** per-line box tops/baselines, set only when a LineHeightSpan makes the lines non-uniform */
  tops: number[] | null = null; bases: number[] | null = null;
  updateMetrics() {
    const p = this.paint;
    this.asc = Math.round(fontAscent(p)); this.desc = Math.round(fontDescent(p));
    // includePad (AOSP's default): the first line's box reaches up to the font's `top` and the
    // last one's down to its `bottom`; the space between lines stays ascent..descent.
    this.padTop = this.includePad ? this.asc - Math.floor(fontTop(p)) : 0;
    this.padBottom = this.includePad ? Math.ceil(fontBottom(p)) - this.desc : 0;
  }
  layoutLines(maxLines = Number.MAX_SAFE_INTEGER) {
    this.updateMetrics();
    const p = this.paint;
    this.lines = this.replacements.length ? greedyBreaks(this.text, p, this.width, 0, this.width, maxLines,
      (start, end) => this.rangeWidth(start, end), (start, end) => {
        const span = this.replacements.find((s) => s.start < end && s.end > end);
        return span ? span.start > start ? span.start : span.end : end;
      }) : greedyBreaks(this.text, p, this.width, 0, this.width, maxLines);
  }
  rangeWidth(start: number, end: number): number {
    return this.replacements.length ? replacementWidth(this.text, this.paint, this.replacements, start, end) : measureText(this.paint, this.text.slice(start, end));
  }
  /**
   * AOSP StaticLayout hands every line's font metrics to the LineHeightSpans covering it and
   * lays the line out with what they wrote back. That is how a Compose Paragraph (and any
   * app-set line height) gets its spacing, so a layout without it is a font-metrics line short.
   */
  async applyLineHeightSpans() {
    this.tops = this.bases = null;
    const src = this.src;
    if (!(src instanceof JSpanned)) return;
    const spans = src.spans.filter((s) => rt.iof(s.span, "android/text/style/LineHeightSpan"));
    if (!spans.length && !this.replacements.length) return;
    const fm = new (rt.link("android/graphics/Paint$FontMetricsInt").ctor as new () => { top: number; ascent: number; descent: number; bottom: number; leading: number })();
    const tops: number[] = [], bases: number[] = [];
    let v = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      fillFontMetrics(this.paint, fm, true);
      for (const span of this.replacements) if (span.start < l.end && span.end > l.start) {
        fm.ascent = Math.min(fm.ascent, span.metrics.ascent); fm.descent = Math.max(fm.descent, span.metrics.descent);
        fm.top = Math.min(fm.top, span.metrics.top); fm.bottom = Math.max(fm.bottom, span.metrics.bottom);
      }
      if (i === 0) fm.ascent -= this.padTop;
      if (i === this.lines.length - 1) fm.descent += this.padBottom;
      for (const s of spans) {
        if (s.start > l.end || s.end < l.start) continue;
        await vcall(s.span, "chooseHeight", "(Ljava/lang/CharSequence;IIIILandroid/graphics/Paint$FontMetricsInt;)V",
          src, l.start, l.end, s.start, v, fm);
      }
      tops.push(v);
      bases.push(v - fm.ascent);
      v += Math.round((fm.descent - fm.ascent) * this.spacingMult + this.spacingAdd);
    }
    tops.push(v);
    this.tops = tops; this.bases = bases;
  }
  lineHeight(): number { return Math.round((this.desc - this.asc) * this.spacingMult + this.spacingAdd); }
  lineTop(i: number): number { return this.tops ? this.tops[Math.min(i, this.tops.length - 1)] : i * this.lineHeight() + (i > 0 ? this.padTop : 0); }
  baseline(i: number): number {
    if (this.bases) return this.bases[Math.min(i, this.bases.length - 1)];
    return Math.round(this.lineTop(i) - this.asc) + (i === 0 ? this.padTop : 0);
  }
}
/** AOSP Layout.getDesiredWidth: widest paragraph, unwrapped. */
function desiredWidth(cs: unknown, p: JTextPaint): number | Promise<number> {
  const text = spannedString(cs), spans = replacementSpans(cs);
  const width = (replacements: Replacement[]) => {
    let max = 0, start = 0;
    for (const para of text.split("\n")) {
      max = Math.max(max, replacements.length ? replacementWidth(text, p, replacements, start, start + para.length) : measureText(p, para));
      start += para.length + 1;
    }
    return max;
  };
  return spans.length ? measureReplacements(cs, p, spans).then(width) : width([]);
}
function primaryHorizontal(this: JLayout, off: number) {
    for (const l of this.lines) {
      if (off >= l.start && (off < l.end || off === this.text.length)) return this.rangeWidth(l.start, this.replacements.find((s) => s.start < off && s.end > off)?.start ?? off);
    }
    return 0;
}
export async function drawLayout(this: JLayout, c: JCanvas, gravity = 0) {
    const thread = curThread;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i], end = line.start + (line.ellipsis?.start ?? line.text.length), baseline = this.baseline(i);
      let position = line.start, x = gravity === 1 ? (this.width - line.width) / 2 : gravity === 5 ? this.width - line.width : 0;
      for (const span of this.replacements) {
        if (span.end <= position || span.start >= end) continue;
        if (span.start > position) {
          const text = line.text.slice(position - line.start, span.start - line.start);
          await (callOn(thread, () => drawStyledText(this.src, text, position, c, this.paint, x, baseline))
            ?? vcallOn(thread, c, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", text, x, baseline, this.paint));
          x += measureText(this.paint, text);
        }
        await vcallOn(thread, span.span, "draw", "(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V", c, this.src, span.start, span.end, x, this.lineTop(i), baseline, this.lineTop(i + 1), span.paint);
        x += span.width; position = span.end;
      }
      if (position < end || line.ellipsis) {
        const text = line.text.slice(position - line.start);
        await (callOn(thread, () => drawStyledText(this.src, text, position, c, this.paint, x, baseline))
          ?? vcallOn(thread, c, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", text, x, baseline, this.paint));
      }
    }
}
const layoutMethods: NonNullable<NativeSpec["methods"]> = {
  "static getDesiredWidth(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F": (cs: unknown, p: JTextPaint) => desiredWidth(cs, p),
  "static getDesiredWidth(Ljava/lang/CharSequence;IILandroid/text/TextPaint;)F": (cs: unknown, s: number, e: number, p: JTextPaint) => desiredWidth(sliceSpanned(cs, s, e), p),
  "getLineCount()I": function (this: JLayout) { return this.lines.length; },
  "getSpacingMultiplier()F": function (this: JLayout) { return this.spacingMult; },
  "getSpacingAdd()F": function (this: JLayout) { return this.spacingAdd; },
  "getLineTop(I)I": function (this: JLayout, i: number) { return this.lineTop(Math.min(i, this.lines.length)); },
  "getLineBottom(I)I": function (this: JLayout, i: number) { return this.lineTop(Math.min(i, this.lines.length - 1) + 1); },
  "getLineBottom(IZ)I": function (this: JLayout, i: number) { return this.lineTop(Math.min(i, this.lines.length - 1) + 1); },
  "getLineBaseline(I)I": function (this: JLayout, i: number) { return this.baseline(i); },
  "getLineAscent(I)I": function (this: JLayout, i: number) { return this.tops ? this.lineTop(i) - this.baseline(i) : Math.round(this.asc); },
  "getLineDescent(I)I": function (this: JLayout, i: number) { return this.tops ? this.lineTop(i + 1) - this.baseline(i) : Math.round(this.desc); },
  "getLineStart(I)I": function (this: JLayout, i: number) { return this.lines[Math.min(i, this.lines.length - 1)]?.start ?? 0; },
  "getLineEnd(I)I": function (this: JLayout, i: number) { return this.lines[Math.min(i, this.lines.length - 1)]?.end ?? 0; },
  // the end WITHOUT the trailing newline the line owns, which is what AOSP reports
  "getLineVisibleEnd(I)I": function (this: JLayout, i: number) {
    const l = this.lines[Math.min(i, this.lines.length - 1)];
    return l ? l.start + l.text.length : 0;
  },
  "getLineRight(I)F": function (this: JLayout, i: number) { return this.lines[i]?.width ?? 0; },
  "getLineWidth(I)F": function (this: JLayout, i: number) { return this.lines[i]?.width ?? 0; },
  "getLineMax(I)F": function (this: JLayout, i: number) { return this.lines[i]?.width ?? 0; },
  "getHeight()I": function (this: JLayout) { return this.tops ? this.tops[this.tops.length - 1] : this.lines.length * this.lineHeight() + this.padTop + this.padBottom; },
  "getWidth()I": function (this: JLayout) { return this.width; },
  "getText()Ljava/lang/CharSequence;": function (this: JLayout) { return this.src ?? this.text; },
  "getPaint()Landroid/text/TextPaint;": function (this: JLayout) { return this.paint; },
  "getEllipsizedWidth()I": function (this: JLayout) { return this.width; },
  "getTopPadding()I": function (this: JLayout) { return -this.padTop; },
  "getBottomPadding()I": function (this: JLayout) { return this.padBottom; },
  ...stubs(0, "isFallbackLineSpacingEnabled()Z", "getUseFallbackLineSpacing()Z", "getLineLeft(I)F",
    "isRtlCharAt(I)Z"),
  "getEllipsisStart(I)I": function (this: JLayout, i: number) { return this.lines[i]?.ellipsis?.start ?? 0; },
  "getEllipsisCount(I)I": function (this: JLayout, i: number) { return this.lines[i]?.ellipsis?.count ?? 0; },
  ...stubs(null, "getAlignment()Landroid/text/Layout$Alignment;"),
  ...stubs(1, "getParagraphDirection(I)I"),
  "getLineForVertical(I)I": function (this: JLayout, y: number) {
    if (this.tops) { let i = 0; while (i + 1 < this.lines.length && this.tops[i + 1] <= y) i++; return i; }
    return Math.max(0, Math.min(this.lines.length - 1, Math.floor((y - this.padTop) / this.lineHeight())));
  },
  "getLineForOffset(I)I": function (this: JLayout, off: number) {
    for (let i = 0; i < this.lines.length; i++) if (off < this.lines[i].end || i === this.lines.length - 1) return i;
    return this.lines.length - 1;
  },
  "getPrimaryHorizontal(I)F": primaryHorizontal,
  "getSecondaryHorizontal(I)F": primaryHorizontal,
  "getOffsetForHorizontal(IF)I": function (this: JLayout, line: number, x: number) {
    const l = this.lines[Math.min(line, this.lines.length - 1)];
    if (!l) return 0;
    let acc = 0;
    for (let i = 0; i < l.text.length; i++) {
      const replacement = this.replacements.find((s) => s.start <= l.start + i && s.end > l.start + i);
      const w = replacement?.width ?? measureText(this.paint, l.text[i]);
      if (acc + w / 2 > x) return l.start + i;
      acc += w;
      if (replacement) i = replacement.end - l.start - 1;
    }
    return l.end;
  },
  "getLineBounds(ILandroid/graphics/Rect;)I": function (this: JLayout, i: number, r: { left: number; top: number; right: number; bottom: number }) {
    r.left = 0; r.right = this.lines[i]?.width ?? 0; r.top = this.lineTop(i); r.bottom = this.lineTop(i + 1);
    return this.baseline(i);
  },
  "draw(Landroid/graphics/Canvas;)V": drawLayout,
  "draw(Landroid/graphics/Canvas;Landroid/graphics/Path;Landroid/graphics/Paint;I)V": function (this: JLayout, c: JCanvas) { return drawLayout.call(this, c); },
};
rt.register({ name: "android/text/Layout", ctor: JLayout, methods: layoutMethods });

class JDynamicLayout extends JLayout {
  refresh() {
    const text = spannedString(this.src);
    if (this.lines.length && text === this.text) return;
    this.text = text; this.replacements = [];
    const finish = () => { this.layoutLines(); return this.applyLineHeightSpans(); };
    return replacementSpans(this.src).length ? measureReplacements(this.src, this.paint).then((spans) => { this.replacements = spans; return finish(); }) : finish();
  }
}
const dynamicMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFZ)V": async function (this: JDynamicLayout, source: unknown, paint: JTextPaint, width: number, _alignment: unknown, mult: number, add: number, pad: number) {
    this.src = source; this.paint = paint; this.width = width; this.spacingMult = mult; this.spacingAdd = add; this.includePad = !!pad;
    await this.refresh();
  },
};
for (const [signature, method] of Object.entries(layoutMethods)) {
  if (signature.startsWith("static ") || typeof method !== "function") continue;
  dynamicMethods[signature] = function (this: JDynamicLayout, ...args: never[]) {
    const pending = this.refresh();
    return pending ? pending.then(() => method.apply(this, args)) : method.apply(this, args);
  };
}
dynamicMethods["getText()Ljava/lang/CharSequence;"] = function (this: JDynamicLayout) { return this.src; };
rt.register({ name: "android/text/DynamicLayout", ctor: JDynamicLayout, sup: "android/text/Layout", methods: dynamicMethods });

class JBoringMetrics extends JObj {
  // Paint.FontMetricsInt fields + width (accessed as plain JS props via fieldTable)
  top = 0; ascent = 0; descent = 0; bottom = 0; leading = 0; width = 0;
}
rt.register({
  name: "android/text/BoringLayout$Metrics", ctor: JBoringMetrics, sup: "android/graphics/Paint$FontMetricsInt",
  fields: ["top", "ascent", "descent", "bottom", "leading", "width"],
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
  async setup(cs: unknown, p: JTextPaint, w: number, smult: number, sadd: number, incl = this.includePad): Promise<this> {
    this.text = spannedString(cs); this.src = cs; this.paint = p; this.width = w;
    this.spacingMult = smult; this.spacingAdd = sadd; this.includePad = incl;
    const spans = replacementSpans(cs);
    this.replacements = spans.length ? await measureReplacements(cs, p, spans) : [];
    this.layoutLines(1);
    await this.applyLineHeightSpans();
    return this;
  }
}
const boringInit = function (this: JBoringLayout, cs: unknown, p: JTextPaint, w: number, _al: unknown, smult: number, sadd: number) {
  return this.setup(cs, p, w, smult, sadd);
};
const boringMake = (cs: unknown, p: JTextPaint, w: number, _al: unknown, smult: number, sadd: number, _m: unknown, incl: number) =>
  new JBoringLayout().setup(cs, p, w, smult, sadd, !!incl);
const isBoring = (cs: unknown, p: JTextPaint) => replacementSpans(cs).length ? null : boringMetrics(spannedString(cs), p);
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

export class JStaticLayout extends JLayout {}
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
        b.cs = start === 0 && end === spannedString(cs).length ? cs : sliceSpanned(cs, start, end);
        b.p = p; b.w = w;
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
    "setUseBoundsForWidth(Z)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setUseLineSpacingFromFallbacks(Z)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setLineBreakConfig(Landroid/graphics/text/LineBreakConfig;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "build()Landroid/text/StaticLayout;": function (this: JSLBuilder) {
      return mkSpannedLayout(this.cs, this.p, this.w, this.smult, this.sadd, this.maxLines, this.incl);
    },
  },
});
rt.register({ name: "android/text/StaticLayout", ctor: JStaticLayout, sup: "android/text/Layout", methods: {} });
export async function mkSpannedLayout(cs: unknown, p: JTextPaint, w: number, mult: number, add: number, maxLines: number, includePad: boolean): Promise<JLayout> {
  const l = new JStaticLayout();
  l.text = spannedString(cs); l.src = cs; l.paint = p; l.width = Math.max(0, w);
  l.spacingMult = mult; l.spacingAdd = add; l.includePad = includePad;
  const spans = replacementSpans(cs);
  if (spans.length) l.replacements = await measureReplacements(cs, p, spans);
  l.layoutLines(maxLines);
  await l.applyLineHeightSpans();
  return l;
}

// Layout$Alignment enum + TextDirectionHeuristics
mkEnumSet("android/text/Layout$Alignment", ["ALIGN_NORMAL", "ALIGN_OPPOSITE", "ALIGN_CENTER"]);
rt.markers("android/graphics/text/LineBreakConfig");
rt.register({
  name: "android/graphics/text/LineBreakConfig$Builder", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "setLineBreakStyle(I)Landroid/graphics/text/LineBreakConfig$Builder;": function (this: JObj) { return this; },
    "setLineBreakWordStyle(I)Landroid/graphics/text/LineBreakConfig$Builder;": function (this: JObj) { return this; },
    "build()Landroid/graphics/text/LineBreakConfig;": () => rt.make("android/graphics/text/LineBreakConfig"),
  },
});

rt.register({
  name: "android/text/format/DateFormat", ctor: class extends JObj {},
  methods: {
    "static is24HourFormat(Landroid/content/Context;)Z": () => 0,
    "static getDateFormat(Landroid/content/Context;)Ljava/text/DateFormat;": () => newObj("java/text/SimpleDateFormat", "(Ljava/lang/String;)V", "M/d/yy"),
    "static getTimeFormat(Landroid/content/Context;)Ljava/text/DateFormat;": () => newObj("java/text/SimpleDateFormat", "(Ljava/lang/String;)V", "h:mm a"),
    "static format(Ljava/lang/CharSequence;J)Ljava/lang/CharSequence;": (fmt: unknown, t: bigint) => formatDate(spannedString(fmt), Number(t)),
    "static format(Ljava/lang/CharSequence;Ljava/util/Date;)Ljava/lang/CharSequence;": (fmt: unknown, d: JDate | null) => formatDate(spannedString(fmt), d?.t ?? Date.now()),
    "static format(Ljava/lang/CharSequence;Ljava/util/Calendar;)Ljava/lang/CharSequence;": (fmt: unknown, c: JCalendar) => formatDate(spannedString(fmt), c.d.getTime()),
  },
});

// ── android.text.format.Formatter: SI units and the 900 roll-over, as API 26+ formats them
const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];
const fmtBytes = (n: bigint, short: boolean) => {
  const units = BYTE_UNITS;
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
  fields: ["year", "month", "monthDay", "hour", "minute", "second", "weekDay", "yearDay", "isDst", "gmtoff",
    "timezone", "allDay"],
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

// ── android.text.method: the interfaces app classes implement (AllCaps/Password transformations,
// custom movement methods) and the framework movement singletons. Our TextView lays text out
// itself and does not yet map a touch to a character offset, so the link-following part of
// LinkMovementMethod.onTouchEvent honestly reports "not handled".
rt.markers("android/text/method/TransformationMethod", "android/text/method/MovementMethod");
class JBaseMovementMethod extends JObj {}
const movementMethods: NonNullable<NativeSpec["methods"]> = {
  ...noops("<init>()V", "initialize(Landroid/widget/TextView;Landroid/text/Spannable;)V",
    "onTakeFocus(Landroid/widget/TextView;Landroid/text/Spannable;I)V"),
  ...stubs(0, "onKeyDown(Landroid/widget/TextView;Landroid/text/Spannable;ILandroid/view/KeyEvent;)Z",
    "onKeyUp(Landroid/widget/TextView;Landroid/text/Spannable;ILandroid/view/KeyEvent;)Z",
    "onKeyOther(Landroid/widget/TextView;Landroid/text/Spannable;Landroid/view/KeyEvent;)Z",
    "onTrackballEvent(Landroid/widget/TextView;Landroid/text/Spannable;Landroid/view/MotionEvent;)Z",
    "onTouchEvent(Landroid/widget/TextView;Landroid/text/Spannable;Landroid/view/MotionEvent;)Z",
    "onGenericMotionEvent(Landroid/widget/TextView;Landroid/text/Spannable;Landroid/view/MotionEvent;)Z",
    "canSelectArbitrarily()Z"),
};
rt.register({ name: "android/text/method/BaseMovementMethod", ctor: JBaseMovementMethod, ifaces: ["android/text/method/MovementMethod"], methods: movementMethods });
class JScrollingMovementMethod extends JBaseMovementMethod {}
const scrollingMM = new JScrollingMovementMethod();
rt.register({
  name: "android/text/method/ScrollingMovementMethod", ctor: JScrollingMovementMethod, sup: "android/text/method/BaseMovementMethod",
  methods: { "<init>()V": function () {}, "static getInstance()Landroid/text/method/MovementMethod;": () => scrollingMM },
});
class JLinkMovementMethod extends JScrollingMovementMethod {}
const linkMM = new JLinkMovementMethod();
rt.register({
  name: "android/text/method/LinkMovementMethod", ctor: JLinkMovementMethod, sup: "android/text/method/ScrollingMovementMethod",
  methods: { "<init>()V": function () {}, "static getInstance()Landroid/text/method/MovementMethod;": () => linkMM, "canSelectArbitrarily()Z": () => 1 },
});
class JPasswordTransformation extends JObj {}
const passwordTM = new JPasswordTransformation();
rt.register({
  name: "android/text/method/PasswordTransformationMethod", ctor: JPasswordTransformation, ifaces: ["android/text/method/TransformationMethod"],
  methods: {
    "<init>()V": function () {},
    "static getInstance()Landroid/text/method/PasswordTransformationMethod;": () => passwordTM,
    "getTransformation(Ljava/lang/CharSequence;Landroid/view/View;)Ljava/lang/CharSequence;": async (s: unknown) => "\u2022".repeat((await csText(s)).length),
    "onFocusChanged(Landroid/view/View;Ljava/lang/CharSequence;ZILandroid/graphics/Rect;)V": () => {},
  },
});
