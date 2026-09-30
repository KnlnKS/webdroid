// android.text.* — TextPaint, TextUtils, Spannable/Editable (spans stored, minimally styled).
import { type JParcel, writeInt, readInt, writeString8, readString8, parcelCreator } from "./parcel";

import { rt, JObj, type NativeSpec, stubs, noops, driven, without, type Gen } from "../jvm/runtime";
import { vcall, vcallOn, callOn, curThread, mkEnumSet, newObj, after, stringOf, type JSimpleEnum } from "../jvm/natives/jlang";
import { JPaint, JCanvas, measureText, copyPaint, fontAscent, fontDescent, fontTop, fontBottom, fillFontMetrics } from "./graphics";
import { jarray } from "../jvm/abi";
import { device } from "../shell/config";
import { toJsArray } from "../jvm/natives/jutil";
import { localeDirection } from "../jvm/natives/jvalues";
import { csText as javaCsText } from "../jvm/natives/jchars";
import { nativePathOf } from "./path";
import { breakLines, type TLine } from "./linebreak";
import { G } from "./gravity";
export type { TLine } from "./linebreak";

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

/** Orders spans by priority, as getSpans returns them, and gives their transitions within [start, end]. */
function transitions(spans: SpanRec[], start: number, end: number): number[] {
  spans.sort((a, b) => (b.flags & 0xff0000) - (a.flags & 0xff0000));
  return [...new Set([start, end, ...spans.flatMap((r) => [Math.max(start, r.start), Math.min(end, r.end)])])].sort((a, b) => a - b);
}
function drawStyledText(src: unknown, text: string, start: number, canvas: JCanvas, paint: JTextPaint, x: number, y: number): Promise<void> | undefined {
  if (!(src instanceof JSpanned)) return;
  const color = paint.color;
  const end = start + text.length;
  const spans = src.spans.filter((r) => r.start < end && r.end > start && rt.iof(r.span, "android/text/style/CharacterStyle")
    && !rt.iof(r.span, "android/text/style/ReplacementSpan"));
  if (!spans.length) return;
  const edges = transitions(spans, start, end);
  return (async () => {
    const p = new JTextPaint();
    canvas.ctx.save();
    try {
      for (let i = 0; i < edges.length - 1; i++) {
        copyTextPaint(paint, p); p.setColorValue(color); p.textAlignN = 0;
        for (const r of spans) if (r.start <= edges[i] && r.end > edges[i]) {
          const pending = vcall(r.span, "updateDrawState", "(Landroid/text/TextPaint;)V", p);
          if (pending instanceof Promise) await pending;
        }
        const run = text.slice(edges[i] - start, edges[i + 1] - start);
        const pending = vcall(canvas, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", run, x, y + p.baselineShift, p);
        if (pending instanceof Promise) await pending;
        x += measureText(p, run);
      }
    } finally { canvas.ctx.restore(); }
  })();
}

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

const adjacentTextOffset = driven(function* adjacentTextOffset(cs: unknown, offset: number, after: boolean): Gen<number> {
  if (!after && (offset === 0 || offset === 1)) return 0;
  if (cs == null) return rt.npe();
  const thread = rt.th(), text = yield csText(cs); rt.st(thread);
  if (offset < 0 || offset > text.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(offset));
  if (after && offset >= text.length - 1) return text.length;
  const a = text.charCodeAt(after ? offset : offset - 2), b = text.charCodeAt(after ? offset + 1 : offset - 1);
  offset += (after ? 1 : -1) * (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff ? 2 : 1);
  if (cs instanceof JSpanned) {
    const spans = cs.spans.filter(s => s.start < offset && s.end > offset && rt.iof(s.span, "android/text/style/ReplacementSpan"));
    for (const span of spans) if (span.start < offset && span.end > offset) offset = after ? span.end : span.start;
  } else if (rt.iof(cs, "android/text/Spanned")) {
    const spans = yield vcall(cs, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", offset, offset, rt.classFor("android/text/style/ReplacementSpan")); rt.st(thread);
    for (const span of spans) {
      const start = yield vcall(cs, "getSpanStart", "(Ljava/lang/Object;)I", span); rt.st(thread);
      const end = yield vcall(cs, "getSpanEnd", "(Ljava/lang/Object;)I", span); rt.st(thread);
      if (start < offset && end > offset) offset = after ? end : start;
    }
  }
  return offset;
});

const textIndexOf = driven(function* textIndexOf(cs: unknown, needle: unknown, start: number = 0, end?: number): Gen<number> {
  const thread = rt.th(), text = yield csText(cs); rt.st(thread);
  const part = yield csText(needle); rt.st(thread);
  if (!part.length) return start;
  const found = text.indexOf(part, start);
  return found > (end ?? text.length) - part.length ? -1 : found;
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
    "static getDirectionalities([C[BI)V": (chars: Uint16Array, out: Int8Array, count: number) => { for (let i = 0; i < count; i++) out[i] = chars[i] >= 0x590 && chars[i] <= 0x8ff ? 1 : 0; },
    "static getEastAsianWidth(C)I": (c: number) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 5 : (c >= 0xff61 && c <= 0xffdc) ? 2 : (c >= 0xffe0 && c <= 0xffe6) ? 3 : 0,
  },
});
/** TextUtils.join: each token spelled as StringBuilder.append(Object) spells it */
async function joinTokens(sep: unknown, tokens: unknown[]): Promise<string> {
  const parts: string[] = [];
  for (const t of tokens) parts.push(await stringOf(t));
  return parts.join(sep === null ? "null" : await csText(sep));
}
rt.register({
  name: "android/text/TextUtils", ctor: JTextUtils,
  statics: { get CHAR_SEQUENCE_CREATOR() { return parcelCreator("java/lang/CharSequence", readText); } },
  methods: {
    "static writeToParcel(Ljava/lang/CharSequence;Landroid/os/Parcel;I)V": writeText,
    "static getOffsetBefore(Ljava/lang/CharSequence;I)I": function (cs: unknown, offset: number) { return adjacentTextOffset(cs, offset, false); },
    "static getOffsetAfter(Ljava/lang/CharSequence;I)I": function (cs: unknown, offset: number) { return adjacentTextOffset(cs, offset, true); },
    "static getLayoutDirectionFromLocale(Ljava/util/Locale;)I": localeDirection,
    "static getCapsMode(Ljava/lang/CharSequence;II)I": driven(function* (cs: unknown, off: number, requested: number): Gen {
      if (off < 0) return 0;
      const mode = requested & 0x1000;
      if (!(requested & 0x6000)) return mode;
      const text = yield csText(cs);
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
    }),
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
    "static lastIndexOf(Ljava/lang/CharSequence;CI)I": driven(function* (s: unknown, ch: number, last: number): Gen 
      { return last < 0 ? -1 : (yield csText(s)).lastIndexOf(String.fromCharCode(ch), last); }),
    "static indexOf(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)I": textIndexOf,
    "static indexOf(Ljava/lang/CharSequence;Ljava/lang/CharSequence;I)I": textIndexOf,
    "static indexOf(Ljava/lang/CharSequence;Ljava/lang/CharSequence;II)I": textIndexOf,
    "static equals(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Z": (a: unknown, b: unknown) =>
      (spannedString(a) === spannedString(b) && (a === null) === (b === null) ? 1 : 0),
    "static isDigitsOnly(Ljava/lang/CharSequence;)Z": (s: unknown) => (/^\d*$/.test(spannedString(s)) ? 1 : 0),
    "static getTrimmedLength(Ljava/lang/CharSequence;)I": (s: unknown) => spannedString(s).trim().length,
    "static join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String;": driven(function* (sep: unknown, it: unknown): Gen {
      return joinTokens(sep, yield toJsArray(it));
    }),
    "static join(Ljava/lang/CharSequence;[Ljava/lang/Object;)Ljava/lang/String;": joinTokens,
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
/** A stretch of spanned text that measures apart from the base paint, as MeasuredParagraph splits
 *  it at MetricAffectingSpan transitions: a style run measured with the paint its spans'
 *  updateMeasureState leave, or (with `width`) a ReplacementSpan sized with that paint. `metrics`
 *  are the font metrics it gives its line. */
type Run = { start: number; end: number; paint: JTextPaint; metrics: SpanMetrics; width?: number };
type Replacement = SpanRec & Run & { width: number };
/** A text's runs, sorted and disjoint, and the replacements among them. */
type PreparedSpans = { replacements: Replacement[]; runs: Run[] };
export const NO_SPANS: PreparedSpans = { replacements: [], runs: [] };
const isReplacement = (s: SpanRec) => rt.iof(s.span, "android/text/style/ReplacementSpan");
export function prepareSpans(cs: unknown, paint: JTextPaint): PreparedSpans | Promise<PreparedSpans> {
  const spans = cs instanceof JSpanned ? cs.spans.filter((s) => s.end > s.start && rt.iof(s.span, "android/text/style/MetricAffectingSpan")) : [];
  return spans.length ? rt.drive(prepareSpans$(cs as JSpanned, paint, spans)) : NO_SPANS;
}
function* prepareSpans$(cs: JSpanned, paint: JTextPaint, spans: SpanRec[]): Gen<PreparedSpans> {
  const edges = transitions(spans, 0, cs.text.length);
  const out: PreparedSpans = { replacements: [], runs: [] }, thread = curThread;
  for (let i = 0, position = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    if (start < position) continue;
    const own = spans.filter((s) => s.start <= start && s.end > start);
    if (!own.length) continue;
    const p = new JTextPaint(); copyTextPaint(paint, p);
    // applyMetricsAffectingSpan: the last ReplacementSpan replaces the stretch
    let replacement: SpanRec | undefined;
    for (const s of own) {
      if (isReplacement(s)) replacement = s;
      else yield vcallOn(thread, s.span, "updateMeasureState", "(Landroid/text/TextPaint;)V", p);
    }
    const metrics: SpanMetrics = yield newObj("android/graphics/Paint$FontMetricsInt"); fillFontMetrics(p, metrics, true);
    if (!replacement) { out.runs.push({ start, end: edges[i + 1], paint: p, metrics }); continue; }
    const width = yield vcallOn(thread, replacement.span, "getSize", "(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I", p, cs, start, replacement.end, metrics);
    const r: Replacement = { ...replacement, start, width: Number(width), metrics, paint: p };
    out.replacements.push(r); out.runs.push(r); position = r.end;
  }
  return out;
}
/** The width of text[start, end): runs with their own paint, a replacement whole, the rest with `paint` */
function runsWidth(text: string, paint: JTextPaint, runs: readonly Run[], start: number, end: number): number {
  let x = 0, position = start;
  for (const run of runs) {
    if (run.start >= end) break;
    if (run.end <= position) continue;
    if (run.start > position) x += measureText(paint, text.slice(position, run.start));
    if (run.width !== undefined) { x += run.width; position = run.end; continue; }
    const stop = Math.min(end, run.end);
    x += measureText(run.paint, text.slice(Math.max(position, run.start), stop));
    position = stop;
  }
  return x + (position < end ? measureText(paint, text.slice(position, end)) : 0);
}
/** A paragraph's LeadingMarginSpans, as StaticLayout.generate reads them: the margin of its first
 *  lines (every span's getLeadingMargin(true), for the most first lines any LeadingMarginSpan2
 *  claims, at least one) and of the rest. */
interface ParagraphMargin { spans: unknown[]; first: number; rest: number; firstLines: number }
export class JLayout extends JObj {
  text = "";
  /** by paragraph start, when the source has LeadingMarginSpans */
  margins: Map<number, ParagraphMargin> | null = null;
  /** the CharSequence the layout was built from, kept for its spans (LineHeightSpan) */
  src: unknown = null;
  paint!: JTextPaint;
  width = 0;
  alignment: JSimpleEnum | null = null;
  breakStrategy = 0;
  /** the alignment as the horizontal gravity a TextView draws the layout with */
  gravity(): number { return this.alignment?.ord === 2 ? G.CENTER_H : this.alignment?.ord === 1 ? G.RIGHT : G.LEFT; }
  lineLeft(line: TLine, gravity = this.gravity()): number {
    const indent = line.indent ?? 0;
    return gravity === G.CENTER_H ? indent + (this.width - indent - line.width) / 2 : gravity === G.RIGHT ? this.width - line.width : indent;
  }
  indent(paragraph: number, line: number): number {
    const m = this.margins?.get(paragraph);
    return m ? (line < m.firstLines ? m.first : m.rest) : 0;
  }
  /** Lays out the lines `wrap` breaks: a spanned source's LeadingMarginSpans indent them and its
   *  LineHeightSpans space them, as StaticLayout.generate consults both. */
  lineUp(wrap: () => TLine[]): unknown {
    this.updateMetrics();
    if (this.src instanceof JSpanned) return rt.drive(this.lineUp$(this.src, wrap));
    this.margins = this.tops = this.bases = null;
    this.lines = wrap();
  }
  private *lineUp$(src: JSpanned, wrap: () => TLine[]): Gen {
    yield* this.loadMargins$(src);
    this.lines = wrap();
    yield* this.applyLineHeightSpans$(src);
  }
  private *loadMargins$(src: JSpanned): Gen {
    this.margins = null;
    const text = this.text, spans = src.spans.filter((s) => rt.iof(s.span, "android/text/style/LeadingMarginSpan"));
    if (!spans.length) return;
    const margins = new Map<number, ParagraphMargin>();
    for (let start = 0; start <= text.length;) {
      const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline + 1;
      const own = spans.filter((s) => s.start < end && s.end > start || s.start === start);
      if (own.length) {
        const m: ParagraphMargin = { spans: own.map((s) => s.span), first: 0, rest: 0, firstLines: 1 };
        for (const span of m.spans) {
          m.first += yield vcall(span, "getLeadingMargin", "(Z)I", 1);
          m.rest += yield vcall(span, "getLeadingMargin", "(Z)I", 0);
          if (rt.iof(span, "android/text/style/LeadingMarginSpan$LeadingMarginSpan2")) m.firstLines = Math.max(m.firstLines, yield vcall(span, "getLeadingMarginLineCount", "()I"));
        }
        margins.set(start, m);
      }
      if (newline < 0) break;
      start = end;
    }
    this.margins = margins;
  }
  lines: TLine[] = [];
  /** the source's metric-affecting spans, measured by the caller before lineUp */
  spans = NO_SPANS;
  spacingMult = 1; spacingAdd = 0;
  includePad = true;
  asc = 0; desc = 0; padTop = 0; padBottom = 0;
  /** per-line box tops/baselines, set only when a LineHeightSpan makes the lines non-uniform */
  tops: number[] | null = null; bases: number[] | null = null;
  height(): number {
    return this.tops ? this.tops[this.tops.length - 1] : this.lines.length * this.lineHeight() + this.padTop + this.padBottom;
  }
  updateMetrics() {
    const p = this.paint;
    this.asc = Math.round(fontAscent(p)); this.desc = Math.round(fontDescent(p));
    // includePad (AOSP's default): the first line's box reaches up to the font's `top` and the
    // last one's down to its `bottom`; the space between lines stays ascent..descent.
    this.padTop = this.includePad ? this.asc - Math.floor(fontTop(p)) : 0;
    this.padBottom = this.includePad ? Math.ceil(fontBottom(p)) - this.desc : 0;
  }
  wrap(maxLines = Number.MAX_SAFE_INTEGER): TLine[] {
    return breakLines(this.text, this.paint, {
      width: this.width, maxLines, balanced: this.breakStrategy === 2,
      measure: (start, end) => this.rangeWidth(start, end),
      atomic: this.spans.replacements,
      margin: this.margins ? (start, line) => this.indent(start, line) : undefined,
    });
  }
  rangeWidth(start: number, end: number): number {
    return runsWidth(this.text, this.paint, this.spans.runs, start, end);
  }
  /**
   * AOSP StaticLayout hands every line's font metrics to the LineHeightSpans covering it and
   * lays the line out with what they wrote back. That is how a Compose Paragraph (and any
   * app-set line height) gets its spacing, so a layout without it is a font-metrics line short.
   */
  private *applyLineHeightSpans$(src: JSpanned): Gen {
    this.tops = this.bases = null;
    const spans = src.spans.filter((s) => rt.iof(s.span, "android/text/style/LineHeightSpan"));
    if (!spans.length && !this.spans.runs.length) return;
    const fm = new (rt.link("android/graphics/Paint$FontMetricsInt").ctor as new () => { top: number; ascent: number; descent: number; bottom: number; leading: number })();
    const tops: number[] = [], bases: number[] = [];
    let v = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      fillFontMetrics(this.paint, fm, true);
      for (const span of this.spans.runs) if (span.start < l.end && span.end > l.start) {
        fm.ascent = Math.min(fm.ascent, span.metrics.ascent); fm.descent = Math.max(fm.descent, span.metrics.descent);
        fm.top = Math.min(fm.top, span.metrics.top); fm.bottom = Math.max(fm.bottom, span.metrics.bottom);
      }
      for (const s of spans) {
        if (s.start > l.end || s.end < l.start) continue;
        if (rt.iof(s.span, "android/text/style/LineHeightSpan$WithDensity")) {
          yield vcall(s.span, "chooseHeight", "(Ljava/lang/CharSequence;IIIILandroid/graphics/Paint$FontMetricsInt;Landroid/text/TextPaint;)V",
            src, l.start, l.end, s.start, v, fm, this.paint);
        } else {
          yield vcall(s.span, "chooseHeight", "(Ljava/lang/CharSequence;IIIILandroid/graphics/Paint$FontMetricsInt;)V",
            src, l.start, l.end, s.start, v, fm);
        }
      }
      if (this.includePad) {
        if (i === 0) { this.padTop = fm.ascent - fm.top; fm.ascent = fm.top; }
        if (i === this.lines.length - 1) { this.padBottom = fm.bottom - fm.descent; fm.descent = fm.bottom; }
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
  const text = spannedString(cs);
  return after(prepareSpans(cs, p), ({ runs }) => {
    let max = 0, start = 0;
    for (const para of text.split("\n")) {
      max = Math.max(max, runsWidth(text, p, runs, start, start + para.length));
      start += para.length + 1;
    }
    return max;
  });
}
function primaryHorizontal(this: JLayout, off: number) {
    for (const l of this.lines) {
      if (off >= l.start && (off < l.end || off === this.text.length)) return this.lineLeft(l) + this.rangeWidth(l.start, this.spans.replacements.find((s) => s.start < off && s.end > off)?.start ?? off);
    }
    return 0;
}
export const drawLayout = driven(function* drawLayout(this: JLayout, c: JCanvas, gravity?: number): Gen {
    const thread = curThread;
    let paragraph = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i], end = line.start + (line.ellipsis?.start ?? line.text.length), baseline = this.baseline(i);
      if (line.start === 0 || this.text[line.start - 1] === "\n") paragraph = i;
      const margin = this.margins?.get(this.lines[paragraph].start);
      // Layout.drawText: each span draws its margin where the previous ones ended
      if (margin) {
        let left = 0;
        for (const span of margin.spans) {
          yield vcallOn(thread, span, "drawLeadingMargin", "(Landroid/graphics/Canvas;Landroid/graphics/Paint;IIIIILjava/lang/CharSequence;IIZLandroid/text/Layout;)V",
            c, this.paint, left, 1, this.lineTop(i), baseline, this.lineTop(i + 1), this.src, line.start, line.end, +(paragraph === i), this);
          left += yield vcallOn(thread, span, "getLeadingMargin", "(Z)I", +(i - paragraph < margin.firstLines));
        }
      }
      let position = line.start, x = this.lineLeft(line, gravity);
      for (const span of this.spans.replacements) {
        if (span.end <= position || span.start >= end) continue;
        if (span.start > position) {
          const text = line.text.slice(position - line.start, span.start - line.start);
          yield (callOn(thread, () => drawStyledText(this.src, text, position, c, this.paint, x, baseline))
            ?? vcallOn(thread, c, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", text, x, baseline, this.paint));
          x += this.rangeWidth(position, span.start);
        }
        yield vcallOn(thread, span.span, "draw", "(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V", c, this.src, span.start, span.end, x, this.lineTop(i), baseline, this.lineTop(i + 1), span.paint);
        x += span.width; position = span.end;
      }
      if (position < end || line.ellipsis) {
        const text = line.text.slice(position - line.start);
        yield (callOn(thread, () => drawStyledText(this.src, text, position, c, this.paint, x, baseline))
          ?? vcallOn(thread, c, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", text, x, baseline, this.paint));
      }
    }
});
const lineBottom = function (this: JLayout, i: number) { return this.lineTop(Math.min(i, this.lines.length - 1) + 1); };
/** Layout.getLineWidth/getLineMax: the extent plus the leading margin */
const lineWidth = function (this: JLayout, i: number) { const line = this.lines[i]; return line ? (line.indent ?? 0) + line.width : 0; };
const layoutWidth = function (this: JLayout) { return this.width; };
const layoutMethods: NonNullable<NativeSpec["methods"]> = {
  "static getDesiredWidth(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F": (cs: unknown, p: JTextPaint) => desiredWidth(cs, p),
  "static getDesiredWidth(Ljava/lang/CharSequence;IILandroid/text/TextPaint;)F": (cs: unknown, s: number, e: number, p: JTextPaint) => desiredWidth(sliceSpanned(cs, s, e), p),
  "getLineCount()I": function (this: JLayout) { return this.lines.length; },
  "getSpacingMultiplier()F": function (this: JLayout) { return this.spacingMult; },
  "getSpacingAdd()F": function (this: JLayout) { return this.spacingAdd; },
  "getLineTop(I)I": function (this: JLayout, i: number) { return this.lineTop(Math.min(i, this.lines.length)); },
  "getLineBottom(I)I": lineBottom,
  "getLineBottom(IZ)I": lineBottom,
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
  "getLineLeft(I)F": function (this: JLayout, i: number) { return this.lines[i] ? this.lineLeft(this.lines[i]) : 0; },
  "getLineRight(I)F": function (this: JLayout, i: number) { const line = this.lines[i]; return line ? this.lineLeft(line) + line.width : 0; },
  "getLineWidth(I)F": lineWidth,
  "getLineMax(I)F": lineWidth,
  "getHeight()I": function (this: JLayout) { return this.height(); },
  "getWidth()I": layoutWidth,
  "getText()Ljava/lang/CharSequence;": function (this: JLayout) { return this.src ?? this.text; },
  "getPaint()Landroid/text/TextPaint;": function (this: JLayout) { return this.paint; },
  "getEllipsizedWidth()I": layoutWidth,
  "getTopPadding()I": function (this: JLayout) { return -this.padTop; },
  "getBottomPadding()I": function (this: JLayout) { return this.padBottom; },
  ...stubs(0, "isFallbackLineSpacingEnabled()Z", "isRtlCharAt(I)Z"),
  "getEllipsisStart(I)I": function (this: JLayout, i: number) { return this.lines[i]?.ellipsis?.start ?? 0; },
  "getEllipsisCount(I)I": function (this: JLayout, i: number) { return this.lines[i]?.ellipsis?.count ?? 0; },
  "getAlignment()Landroid/text/Layout$Alignment;": function (this: JLayout) { return this.alignment ?? rt.link("android/text/Layout$Alignment").ctor.s$ALIGN_NORMAL; },
  ...stubs(1, "getParagraphDirection(I)I"),
  // every paragraph is left-to-right and these lines reserve no leading margin
  "getParagraphLeft(I)I": function (this: JLayout, i: number) { return this.lines[i]?.indent ?? 0; },
  "getParagraphRight(I)I": function (this: JLayout) { return this.width; },
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
  "getSelectionPath(IILandroid/graphics/Path;)V": driven(function* (this: JLayout, start: number, end: number, path: object): Gen {
    const thread = curThread;
    yield vcallOn(thread, path, "reset", "()V");
    if (start === end) return;
    if (start > end) [start, end] = [end, start];
    const first = Number(yield vcallOn(thread, this, "getLineForOffset", "(I)I", start));
    const last = Number(yield vcallOn(thread, this, "getLineForOffset", "(I)I", end));
    const width = Number(yield vcallOn(thread, this, "getWidth", "()I"));
    for (let line = first; line <= last; line++) {
      const rtl = (yield vcallOn(thread, this, "getParagraphDirection", "(I)I", line)) === -1;
      const left = line === first ? Number(yield vcallOn(thread, this, "getPrimaryHorizontal", "(I)F", start)) : rtl ? width : 0;
      const right = line === last ? Number(yield vcallOn(thread, this, "getPrimaryHorizontal", "(I)F", end)) : rtl ? 0 : width;
      const top = Number(yield vcallOn(thread, this, "getLineTop", "(I)I", line));
      const bottom = Number(yield vcallOn(thread, this, "getLineBottom", "(I)I", line));
      if (left !== right) nativePathOf(path).addRect(Math.min(left, right), top, Math.max(left, right), bottom, 0);
    }
  }),
  "getOffsetForHorizontal(IF)I": function (this: JLayout, line: number, x: number) {
    const l = this.lines[Math.min(line, this.lines.length - 1)];
    if (!l) return 0;
    let acc = this.lineLeft(l);
    for (let i = 0; i < l.text.length; i++) {
      const replacement = this.spans.replacements.find((s) => s.start <= l.start + i && s.end > l.start + i);
      const w = replacement?.width ?? this.rangeWidth(l.start + i, l.start + i + 1);
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
    this.text = text;
    return after(prepareSpans(this.src, this.paint), (spans) => { this.spans = spans; return this.lineUp(() => this.wrap()); });
  }
}
const dynamicMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFZ)V": function(this: JDynamicLayout, source: unknown, paint: JTextPaint, width: number, alignment: JSimpleEnum, mult: number, add: number, pad: number) {
    this.alignment = alignment;
    this.src = source; this.paint = paint; this.width = width; this.spacingMult = mult; this.spacingAdd = add; this.includePad = !!pad;
    return this.refresh();
  },
};
for (const [signature, method] of Object.entries(layoutMethods)) {
  if (signature.startsWith("static ") || typeof method !== "function") continue;
  dynamicMethods[signature] = function (this: JDynamicLayout, ...args: never[]) {
    return after(this.refresh(), () => method.apply(this, args));
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
  setup(cs: unknown, p: JTextPaint, w: number, smult: number, sadd: number, incl: boolean): this | Promise<this> { return rt.drive(this.setup$(cs, p, w, smult, sadd, incl)); }
  *setup$(cs: unknown, p: JTextPaint, w: number, smult: number, sadd: number, incl: boolean): Gen<this> {
    this.text = spannedString(cs); this.src = cs; this.paint = p; this.width = w;
    this.spacingMult = smult; this.spacingAdd = sadd; this.includePad = incl;
    this.spans = yield prepareSpans(cs, p);
    yield this.lineUp(() => this.wrap(1));
    return this;
  }
}
const boringInit = function (this: JBoringLayout, cs: unknown, p: JTextPaint, w: number, alignment: JSimpleEnum, smult: number, sadd: number, _m: unknown, incl: number) {
  this.alignment = alignment;
  return this.setup(cs, p, w, smult, sadd, !!incl);
};
const boringMake = (cs: unknown, p: JTextPaint, w: number, alignment: JSimpleEnum, smult: number, sadd: number, _m: unknown, incl: number) =>
  boringInit.call(new JBoringLayout(), cs, p, w, alignment, smult, sadd, _m, incl);
function isBoring(cs: unknown, p: JTextPaint) {
  if (cs instanceof JSpanned && cs.spans.some((s) => rt.iof(s.span, "android/text/style/ParagraphStyle") || s.end > s.start && isReplacement(s))) return null;
  return boringMetrics(spannedString(cs), p);
}
rt.register({
  name: "android/text/BoringLayout", ctor: JBoringLayout, sup: "android/text/Layout",
  methods: {
    "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;Z)V": boringInit,
    "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;ZLandroid/text/TextUtils$TruncateAt;IZ)V": boringInit,
    "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;ZLandroid/text/TextUtils$TruncateAt;I)V": boringInit,
    "static isBoring(Ljava/lang/CharSequence;Landroid/text/TextPaint;)Landroid/text/BoringLayout$Metrics;": isBoring,
    "static isBoring(Ljava/lang/CharSequence;Landroid/text/TextPaint;Landroid/text/TextDirectionHeuristic;ZLandroid/text/BoringLayout$Metrics;)Landroid/text/BoringLayout$Metrics;": isBoring,
    "static make(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;Z)Landroid/text/BoringLayout;": boringMake,
    "static make(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;ZLandroid/text/TextUtils$TruncateAt;I)Landroid/text/BoringLayout;": boringMake,
  },
});

export class JStaticLayout extends JLayout {}
class JSLBuilder extends JObj {
  cs: unknown = null; p!: JTextPaint; w = 0; alignment: JSimpleEnum | null = null;
  breakStrategy = 0;
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
    "setAlignment(Landroid/text/Layout$Alignment;)Landroid/text/StaticLayout$Builder;": slSetter((b, alignment: JSimpleEnum) => { b.alignment = alignment; }),
    "setTextDirection(Landroid/text/TextDirectionHeuristic;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setLineSpacing(FF)Landroid/text/StaticLayout$Builder;": slSetter((b, add: number, mult: number) => { b.sadd = add; b.smult = mult; }),
    "setIncludePad(Z)Landroid/text/StaticLayout$Builder;": slSetter((b, v: number) => { b.incl = !!v; }),
    "setEllipsize(Landroid/text/TextUtils$TruncateAt;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setEllipsizedWidth(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setMaxLines(I)Landroid/text/StaticLayout$Builder;": slSetter((b, v: number) => { b.maxLines = v > 0 ? v : b.maxLines; }),
    "setBreakStrategy(I)Landroid/text/StaticLayout$Builder;": slSetter((b, strategy: number) => { b.breakStrategy = strategy; }),
    "setHyphenationFrequency(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setIndents([I[I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setJustificationMode(I)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setUseBoundsForWidth(Z)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setUseLineSpacingFromFallbacks(Z)Landroid/text/StaticLayout$Builder;": slSetter(),
    "setLineBreakConfig(Landroid/graphics/text/LineBreakConfig;)Landroid/text/StaticLayout$Builder;": slSetter(),
    "build()Landroid/text/StaticLayout;": driven(function* (this: JSLBuilder): Gen {
      const layout = yield setupSpannedLayout(new JStaticLayout(), this.cs, this.p, this.w, this.smult, this.sadd, this.maxLines, this.incl, this.breakStrategy);
      layout.alignment = this.alignment; return layout;
    }),
  },
});
rt.register({ name: "android/text/StaticLayout", ctor: JStaticLayout, sup: "android/text/Layout", methods: {
  "<init>(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFZ)V":
    function(this: JStaticLayout, cs: unknown, p: JTextPaint, w: number, alignment: JSimpleEnum, mult: number, add: number, includePad: number) {
      this.alignment = alignment;
      return setupSpannedLayout(this, cs, p, w, mult, add, Number.MAX_SAFE_INTEGER, !!includePad);

    },
} });
const setupSpannedLayout = driven(function* setupSpannedLayout(l: JStaticLayout, cs: unknown, p: JTextPaint, w: number, mult: number, add: number, maxLines: number, includePad: boolean, breakStrategy: number = 0): Gen<JStaticLayout> {
  l.text = spannedString(cs); l.src = cs; l.paint = p; l.width = Math.max(0, w);
  l.spacingMult = mult; l.spacingAdd = add; l.includePad = includePad; l.breakStrategy = breakStrategy;
  l.spans = yield prepareSpans(cs, p);
  yield l.lineUp(() => l.wrap(maxLines));
  return l;
});

// Layout$Alignment enum + LineBreakConfig
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

// ── android.text.method: the interfaces app classes implement (AllCaps/Password transformations,
// custom movement methods) and the framework movement singletons. Our TextView lays text out
// itself and does not yet map a touch to a character offset, so the link-following part of
// LinkMovementMethod.onTouchEvent honestly reports "not handled".
rt.markers("android/text/method/TransformationMethod", "android/text/method/MovementMethod");
class JReplacementTransformation extends JObj {}
rt.register({ name: "android/text/method/ReplacementTransformationMethod", ctor: JReplacementTransformation,
  ifaces: ["android/text/method/TransformationMethod"], methods: {
    "<init>()V": () => {},
    "getTransformation(Ljava/lang/CharSequence;Landroid/view/View;)Ljava/lang/CharSequence;": driven(function* (this: JReplacementTransformation, source: unknown): Gen {
      if (source == null) return null;
      const original = (yield vcall(this, "getOriginal", "()[C")) as Uint16Array;
      const replacement = (yield vcall(this, "getReplacement", "()[C")) as Uint16Array;
      const text = yield csText(source);
      let changed = false, result = "";
      for (let i = 0; i < text.length; i++) {
        const at = original.indexOf(text.charCodeAt(i));
        changed ||= at >= 0;
        result += at < 0 ? text[i] : String.fromCharCode(replacement[at]);
      }
      return changed ? result : source;
    }),
    "onFocusChanged(Landroid/view/View;Ljava/lang/CharSequence;ZILandroid/graphics/Rect;)V": () => {},
  },
});
class JSingleLineTransformation extends JReplacementTransformation {}
const singleLineTM = new JSingleLineTransformation();
rt.register({ name: "android/text/method/SingleLineTransformationMethod", ctor: JSingleLineTransformation,
  sup: "android/text/method/ReplacementTransformationMethod", methods: {
    "<init>()V": () => {},
    "static getInstance()Landroid/text/method/SingleLineTransformationMethod;": () => singleLineTM,
    "getOriginal()[C": () => Uint16Array.of(10, 13),
    "getReplacement()[C": () => Uint16Array.of(32, 0xfeff),
  },
});
class JBaseMovementMethod extends JObj {}
const movementMethods: NonNullable<NativeSpec["methods"]> = {
  ...noops("<init>()V"),
  ...stubs(0, "onKeyDown(Landroid/widget/TextView;Landroid/text/Spannable;ILandroid/view/KeyEvent;)Z",
    "onKeyOther(Landroid/widget/TextView;Landroid/text/Spannable;Landroid/view/KeyEvent;)Z",
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
export const passwordTransformation = new JPasswordTransformation();
rt.register({
  name: "android/text/method/PasswordTransformationMethod", ctor: JPasswordTransformation, ifaces: ["android/text/method/TransformationMethod"],
  methods: {
    "<init>()V": function () {},
    "static getInstance()Landroid/text/method/PasswordTransformationMethod;": () => passwordTransformation,
    "getTransformation(Ljava/lang/CharSequence;Landroid/view/View;)Ljava/lang/CharSequence;": driven(function* (s: unknown): Gen { return "\u2022".repeat((yield csText(s)).length); }),
    "onFocusChanged(Landroid/view/View;Ljava/lang/CharSequence;ZILandroid/graphics/Rect;)V": () => {},
  },
});
