// android.text.* — TextPaint and Spannable/Editable (spans stored; AOSP's Layout draws them).
import { type JParcel, writeInt, readInt, writeString8, readString8 } from "./parcel";

import { rt, JObj, type NativeSpec, driven, without, type Gen } from "../jvm/runtime";
import { vcall, newObj } from "../jvm/natives/jlang";
import { JPaint, copyPaint } from "./graphics";
import { jarray } from "../jvm/abi";
import { device } from "../shell/config";
import { csText as javaCsText } from "../jvm/natives/jchars";

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
    "<init>(I)V": function (this: JTextPaint, f: number) { this.flags = f; },
    "<init>(Landroid/graphics/Paint;)V": function (this: JTextPaint, p: JPaint) {
      if (p) copyPaint(p, this);
    },
    "set(Landroid/text/TextPaint;)V": function (this: JTextPaint, p: JTextPaint) {
      if (p) copyTextPaint(p, this);
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
export class JSpannable extends JSpanned {
  /** Editable.setFilters: applied by every replace, as SpannableStringBuilder does */
  declare filters?: unknown[];
  /** the owning TextView's refresh after an edit through its Editable */
  declare edited?: () => unknown;
}
/** InputFilter.filter over `filters` in order, each seeing the previous one's output, as
 *  SpannableStringBuilder.replace and TextView.setText run them */
export const applyInputFilters = driven(function* applyInputFilters(filters: unknown[] | undefined, cs: unknown, start: number, end: number, dest: unknown, dstart: number, dend: number): Gen<[unknown, number, number]> {
  if (filters) for (const f of filters) {
    const out = yield vcall(f, "filter", "(Ljava/lang/CharSequence;IILandroid/text/Spanned;II)Ljava/lang/CharSequence;", cs, start, end, dest, dstart, dend);
    if (out != null) { cs = out; start = 0; end = (yield csText(out)).length; }
  }
  return [cs, start, end];
});
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
  "getChars(II[CI)V": function (this: JSpannable, start: number, end: number, destination: Uint16Array | null, offset: number) {
    if (!destination) rt.npe();
    if (start < 0 || end < start || end > this.text.length) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `${start}, ${end}`);
    if (offset < 0 || offset > destination!.length - (end - start)) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", String(offset));
    for (let i = start; i < end; i++) destination![offset + i - start] = this.text.charCodeAt(i);
  },
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
    // AOSP's overlap test: an empty span or query touches its edges; otherwise shared edges don't count
    const hits = this.spans.filter((s) => s.start <= end && s.end >= start && (s.start === s.end || start === end || s.start !== end && s.end !== start)
      && (!name || rt.iof(s.span, name)));
    if (hits.some((s) => s.flags & 0xff0000)) hits.sort((a, b) => (b.flags & 0xff0000) - (a.flags & 0xff0000));
    const out = hits.map((s) => s.span);
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
  "nextSpanTransition(IILjava/lang/Class;)I": function (this: JSpannable, start: number, limit: number, cls: any) {
    const name = cls?.ci?.name;
    for (const s of this.spans) {
      if (name && !rt.iof(s.span, name)) continue;
      if (s.start > start && s.start < limit) limit = s.start;
      if (s.end > start && s.end < limit) limit = s.end;
    }
    return limit;
  },
};
rt.register({
  name: "android/text/SpannableString", ctor: JSpannable,
  ifaces: ["java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned"],
  methods: {
    ...without(spanMethods, ["<init>()V"]),
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
export function csText(cs: unknown): string | Promise<string> {
  return cs instanceof JSpanned ? cs.text : javaCsText(cs);
}
const selectionStart = new JObj(), selectionEnd = new JObj();
export const textSelection = driven(function* textSelection(text: unknown): Gen<[number, number]> {
  if (!text || typeof text === "string") return [-1, -1];
  return [yield vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", selectionStart), yield vcall(text, "getSpanStart", "(Ljava/lang/Object;)I", selectionEnd)];
});
export const setTextSelection = driven(function* setTextSelection(text: unknown, start: number, end: number): Gen {
  yield vcall(text, "setSpan", "(Ljava/lang/Object;III)V", selectionStart, start, start, 0x222);
  yield vcall(text, "setSpan", "(Ljava/lang/Object;III)V", selectionEnd, end, end, 0x22);
});
rt.register({ name: "android/text/Selection", ctor: class extends JObj {},
  statics: { SELECTION_START: selectionStart, SELECTION_END: selectionEnd },
  methods: {
    "static getSelectionStart(Ljava/lang/CharSequence;)I": driven(function* (text: unknown): Gen { return (yield textSelection(text))[0]; }),
    "static getSelectionEnd(Ljava/lang/CharSequence;)I": driven(function* (text: unknown): Gen { return (yield textSelection(text))[1]; }),
    "static setSelection(Landroid/text/Spannable;II)V": setTextSelection,
    "static setSelection(Landroid/text/Spannable;I)V": function (text: unknown, index: number) { return setTextSelection(text, index, index); },
    "static selectAll(Landroid/text/Spannable;)V": driven(function* (text: unknown): Gen { return setTextSelection(text, 0, (yield csText(text)).length); }),
    "static removeSelection(Landroid/text/Spannable;)V": driven(function* (text: unknown): Gen {
      yield vcall(text, "removeSpan", "(Ljava/lang/Object;)V", selectionStart);
      yield vcall(text, "removeSpan", "(Ljava/lang/Object;)V", selectionEnd);
    }),
  },
});

/** replace/insert/delete for the editable text classes. A method mangles with its RETURN type,
 *  so SpannableStringBuilder declares these both as returning itself and as returning Editable,
 *  or an interface-typed call misses. Every edit is a replace, as in AOSP, so filters and span
 *  movement apply to all of them. */
function editMutators(ret: string): NonNullable<NativeSpec["methods"]> {
  const replace = `replace(IILjava/lang/CharSequence;II)L${ret};`, sig = replace.slice(7);
  return {
    [`replace(IILjava/lang/CharSequence;)L${ret};`]: driven(function* (this: JSpannable, a: number, b: number, cs: unknown): Gen {
      return vcall(this, "replace", sig, a, b, cs, 0, (yield csText(cs)).length);
    }),
    [replace]: driven(function* (this: JSpannable, a: number, b: number, cs: unknown, start: number, end: number): Gen {
      if (this.filters?.length) [cs, start, end] = yield applyInputFilters(this.filters, cs, start, end, this, a, b);
      if (!(cs instanceof JSpanned) && rt.iof(cs, "android/text/Spanned"))
        cs = yield newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", cs);
      const incoming = cs instanceof JSpanned ? cs.spans.filter((r) => r.start < end && r.end > start).map((r) => ({
        ...r, start: a + Math.max(start, r.start) - start, end: a + Math.min(end, r.end) - start,
      })) : [];
      const text = (yield csText(cs)).slice(start, end), delta = text.length - (b - a);
      this.text = this.text.slice(0, a) + text + this.text.slice(b);
      const moved = (position: number, mode: number) => position < a ? position : position > b ? position + delta :
        position === b && b > a || mode === 2 ? a + text.length : a;
      // AOSP's removeSpansForChange: an EXCLUSIVE_EXCLUSIVE span inside the replaced range that
      // the change would leave empty is removed
      if (b > a) this.spans = this.spans.filter((r) => (r.flags & 0x33) !== 0x21 || r.start < a || r.end > b || text && r.start === a && r.end === b);
      for (const span of this.spans) {
        span.start = moved(span.start, span.flags >> 4 & 0xf);
        span.end = moved(span.end, span.flags & 0xf);
      }
      for (const span of incoming) if (!this.spans.some((r) => r.span === span.span)) this.spans.push(span);
      if (this.edited) yield this.edited();
      return this;
    }),
    [`insert(ILjava/lang/CharSequence;)L${ret};`]: driven(function* (this: JSpannable, i: number, cs: unknown): Gen {
      return vcall(this, "replace", sig, i, i, cs, 0, (yield csText(cs)).length);
    }),
    [`delete(II)L${ret};`]: function (this: JSpannable, a: number, b: number) {
      return vcall(this, "replace", sig, a, b, "", 0, 0);
    },
    "clear()V": function (this: JSpannable) { return vcall(this, "replace", sig, 0, this.text.length, "", 0, 0); },
    "setFilters([Landroid/text/InputFilter;)V": function (this: JSpannable, filters: unknown[] | null) {
      if (filters == null) return rt.npe();
      this.filters = filters;
    },
    "getFilters()[Landroid/text/InputFilter;": function (this: JSpannable) {
      return jarray([...this.filters ?? []], "Landroid/text/InputFilter;");
    },
  };
}
/** Editable's appends under each return type a caller may have linked against: the class's
 *  own, Editable's, and Appendable's (Kotlin's joinTo takes any Appendable). Each goes through
 *  the class's own replace and append(CharSequence), as AOSP's do. */
function appendMethods(ret: string, own = ret): NonNullable<NativeSpec["methods"]> {
  const replace = `(IILjava/lang/CharSequence;II)L${own};`;
  const appendRange = function (this: JSpannable, cs: unknown, start: number, end: number) {
    return vcall(this, "replace", replace, this.text.length, this.text.length, cs, start, end);
  };
  return {
    [`append(Ljava/lang/CharSequence;)L${ret};`]: driven(function* (this: JSpannable, cs: unknown): Gen {
      return appendRange.call(this, cs, 0, (yield csText(cs)).length);
    }),
    [`append(Ljava/lang/CharSequence;II)L${ret};`]: appendRange,
    [`append(C)L${ret};`]: function (this: JSpannable, c: number) {
      return vcall(this, "append", `(Ljava/lang/CharSequence;)L${own};`, String.fromCharCode(c));
    },
  };
}
const SSB = "Landroid/text/SpannableStringBuilder;";
/** SpannableStringBuilder's interface-typed forms are javac bridges to its own, which is what a
 *  subclass (emoji2's SpannableBuilder) overrides */
function ssbBridges(ret: string, edits: boolean): NonNullable<NativeSpec["methods"]> {
  const appends: NonNullable<NativeSpec["methods"]> = {
    [`append(Ljava/lang/CharSequence;)${ret}`]: function (this: JSpannable, cs: unknown) { return vcall(this, "append", `(Ljava/lang/CharSequence;)${SSB}`, cs); },
    [`append(Ljava/lang/CharSequence;II)${ret}`]: function (this: JSpannable, cs: unknown, start: number, end: number) {
      return vcall(this, "append", `(Ljava/lang/CharSequence;II)${SSB}`, cs, start, end);
    },
    [`append(C)${ret}`]: function (this: JSpannable, c: number) { return vcall(this, "append", `(C)${SSB}`, c); },
  };
  if (!edits) return appends;
  return {
    ...appends,
    [`replace(IILjava/lang/CharSequence;)${ret}`]: function (this: JSpannable, a: number, b: number, cs: unknown) {
      return vcall(this, "replace", `(IILjava/lang/CharSequence;)${SSB}`, a, b, cs);
    },
    [`replace(IILjava/lang/CharSequence;II)${ret}`]: function (this: JSpannable, a: number, b: number, cs: unknown, start: number, end: number) {
      return vcall(this, "replace", `(IILjava/lang/CharSequence;II)${SSB}`, a, b, cs, start, end);
    },
    [`insert(ILjava/lang/CharSequence;)${ret}`]: function (this: JSpannable, i: number, cs: unknown) { return vcall(this, "insert", `(ILjava/lang/CharSequence;)${SSB}`, i, cs); },
    [`delete(II)${ret}`]: function (this: JSpannable, a: number, b: number) { return vcall(this, "delete", `(II)${SSB}`, a, b); },
  };
}
rt.register({
  name: "android/text/SpannableStringBuilder", ctor: class extends JSpannable {},
  ifaces: ["java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned", "android/text/Editable", "java/lang/Appendable"],
  methods: {
    ...spanMethods,
    ...appendMethods("android/text/SpannableStringBuilder"),
    // the hidden overload AOSP's layouts call; spans are kept in insertion order already
    "getSpans(IILjava/lang/Class;Z)[Ljava/lang/Object;": function (this: JSpannable, start: number, end: number, cls: unknown) {
      return vcall(this, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", start, end, cls);
    },
    "append(Ljava/lang/CharSequence;Ljava/lang/Object;I)Landroid/text/SpannableStringBuilder;": driven(function* (this: JSpannable, cs: unknown, what: unknown, flags: number): Gen {
      const start = this.text.length;
      yield vcall(this, "append", `(Ljava/lang/CharSequence;)${SSB}`, cs);
      yield vcall(this, "setSpan", "(Ljava/lang/Object;III)V", what, start, this.text.length, flags);
      return this;
    }),
    ...editMutators("android/text/SpannableStringBuilder"),
    ...ssbBridges("Landroid/text/Editable;", true),
    ...ssbBridges("Ljava/lang/Appendable;", false),
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
  "android/text/TextWatcher", "android/text/SpanWatcher", "android/text/InputFilter"]) {
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

export class JEditable extends JSpannable {}
rt.register({
  name: "webdroid/Editable", ctor: JEditable,
  ifaces: ["android/text/Editable", "java/lang/CharSequence", "android/text/Spannable", "android/text/Spanned"],
  methods: {
    ...spanMethods,
    ...appendMethods("android/text/Editable"),
    ...appendMethods("java/lang/Appendable"),
    ...editMutators("android/text/Editable"),
  },
});

export const writeText = driven(function* writeText(text: unknown, parcel: JParcel): Gen<void> {
  if (text !== null && rt.iof(text, "android/text/Spanned")) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Spanned text parcel");
  writeInt(parcel, 1); writeString8(parcel, text === null ? null : yield csText(text));
});
export function readText(parcel: JParcel) {
  const kind = readInt(parcel), text = readString8(parcel);
  if (text !== null && kind !== 1 && readInt(parcel) !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Spanned text parcel");
  return text;
}
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
    "static getDirectionalities([C[BI)V": (chars: Uint16Array, out: Int8Array, count: number) => { for (let i = 0; i < count; i++) out[i] = chars[i] >= 0x590 && chars[i] <= 0x8ff ? 1 : 0; },
    "static getEastAsianWidth(C)I": (c: number) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 5 : (c >= 0xff61 && c <= 0xffdc) ? 2 : (c >= 0xffe0 && c <= 0xffe6) ? 3 : 0,
  },
});

rt.register({
  name: "android/text/InputType", ctor: class extends JObj {},
  statics: {
    TYPE_CLASS_TEXT: 1, TYPE_CLASS_NUMBER: 2, TYPE_CLASS_PHONE: 3, TYPE_CLASS_DATETIME: 4,
    TYPE_NUMBER_FLAG_DECIMAL: 8192, TYPE_NUMBER_FLAG_SIGNED: 4096,
    TYPE_TEXT_FLAG_CAP_SENTENCES: 16384, TYPE_TEXT_FLAG_MULTI_LINE: 131072,
    TYPE_TEXT_VARIATION_PASSWORD: 128,
  },
});
