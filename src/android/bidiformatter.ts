import { rt, JObj, type NativeSpec, driven, type Gen } from "../jvm/runtime";
import { directionality } from "../jvm/bidi";
import { vcall, newObj, after } from "../jvm/natives/jlang";
import { localeDirection, type JLocale, defaultLocale } from "../jvm/natives/jvalues";
import { csText, JSpanned } from "./text";

type Heuristic = "ltr" | "rtl" | "firstLtr" | "firstRtl" | "anyRtl" | "locale";
class JHeuristic extends JObj {
  constructor(readonly kind: Heuristic = "firstLtr") { super(); }
}
const defaultDirection = () => after(defaultLocale(), localeDirection);
const checkRange = (length: number, start: number, count: number) => {
  if (start < 0 || count < 0 || start > length - count) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid text range");
};
function heuristicRtl(text: string, start: number, count: number, kind: Heuristic): number | Promise<number> {
  if (kind !== "locale") return isRtl(text, start, count, kind);
  checkRange(text.length, start, count);
  return defaultDirection();
}
export function isRtl(text: string, start: number, count: number, kind: Exclude<Heuristic, "locale">): number {
  checkRange(text.length, start, count);
  if (kind === "ltr" || kind === "rtl") return +(kind === "rtl");
  let isolates = 0;
  for (let i = start, end = start + count; i < end;) {
    const cp = text.codePointAt(i)!; i += cp > 0xffff ? 2 : 1;
    if (cp >= 0x2066 && cp <= 0x2068) { isolates++; continue; }
    if (cp === 0x2069) { isolates = Math.max(0, isolates - 1); continue; }
    if (isolates) continue;
    let dir = directionality(cp);
    if (dir === -1) {
      const rtl = cp >= 0x590 && cp <= 0x8ff || cp >= 0xfb1d && cp <= 0xfdcf || cp >= 0xfdf0 && cp <= 0xfdff || cp >= 0xfe70 && cp <= 0xfeff || cp >= 0x10800 && cp <= 0x10fff || cp >= 0x1e800 && cp <= 0x1efff;
      const neutral = cp >= 0x2065 && cp <= 0x2069 || cp >= 0xfff0 && cp <= 0xfff8 || cp >= 0xe0000 && cp <= 0xe0fff || cp >= 0xfdd0 && cp <= 0xfdef || (cp & 0xfffe) === 0xfffe || cp >= 0x20a0 && cp <= 0x20cf || cp >= 0xd800 && cp <= 0xdfff;
      dir = rtl ? 1 : neutral ? -1 : 0;
    }
    if (dir === 1 || dir === 2) return 1;
    if (dir === 0 && kind !== "anyRtl") return 0;
  }
  return +(kind === "firstRtl");
}
rt.register({ name: "android/text/TextDirectionHeuristic", ctor: JHeuristic, methods: {
  "isRtl(Ljava/lang/CharSequence;II)Z": driven(function* (this: JHeuristic, text: unknown, start: number, count: number): Gen {
    if (text == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Null text");
    return heuristicRtl(yield csText(text), start, count, this.kind);
  }),
  "isRtl([CII)Z": function (this: JHeuristic, chars: Uint16Array | null, start: number, count: number) {
    if (!chars || start < 0 || count < 0 || start > chars.length - count) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid text range");
    let text = "";
    for (let i = start; i < start + count; i++) text += String.fromCharCode(chars[i]);
    return heuristicRtl(text, 0, text.length, this.kind);
  },
} });
const heuristics = { LTR: new JHeuristic("ltr"), RTL: new JHeuristic("rtl"), FIRSTSTRONG_LTR: new JHeuristic("firstLtr"), FIRSTSTRONG_RTL: new JHeuristic("firstRtl"), ANYRTL_LTR: new JHeuristic("anyRtl"), LOCALE: new JHeuristic("locale") };
rt.register({ name: "android/text/TextDirectionHeuristics", ctor: class extends JObj {}, statics: heuristics });

function boundaryDirection(text: string, exit: boolean): number {
  let index = exit ? text.length : 0;
  const next = (backward: boolean) => {
    let cp: number;
    if (backward) {
      cp = text.charCodeAt(--index);
      if (cp >= 0xdc00 && cp <= 0xdfff && index > 0) {
        const high = text.charCodeAt(index - 1);
        if (high >= 0xd800 && high <= 0xdbff) { index--; cp = (high - 0xd800) * 1024 + cp - 0xdc00 + 0x10000; }
      }
    } else { cp = text.codePointAt(index)!; index += cp > 0xffff ? 2 : 1; }
    return directionality(cp);
  };
  if (exit) {
    let level = 0, nonempty = 0;
    while (index > 0) {
      const d = next(true);
      if (d === 0 || d === 1 || d === 2) {
        if (level === 0) return d === 0 ? -1 : 1;
        if (nonempty === 0) nonempty = level;
      } else if (d >= 14 && d <= 17) {
        if (nonempty === level) return d <= 15 ? -1 : 1;
        level--;
      } else if (d === 18) level++;
      else if (d !== 9 && nonempty === 0) nonempty = level;
    }
    return 0;
  }
  let level = 0, embedding = 0, nonempty = 0;
  while (index < text.length && nonempty === 0) {
    const d = next(false);
    if (d >= 14 && d <= 17) { level++; embedding = d <= 15 ? -1 : 1; }
    else if (d === 18) { level--; embedding = 0; }
    else if (d === 0 || d === 1 || d === 2) {
      if (level === 0) return d === 0 ? -1 : 1;
      nonempty = level;
    } else if (d !== 9) nonempty = level;
  }
  if (nonempty === 0) return 0;
  if (embedding !== 0) return embedding;
  while (index > 0) {
    const d = next(true);
    if (d >= 14 && d <= 17) {
      if (nonempty === level) return d <= 15 ? -1 : 1;
      level--;
    } else if (d === 18) level++;
  }
  return 0;
}
class JBidiFormatter extends JObj {
  rtl = false; reset = true; heuristic: unknown = heuristics.FIRSTSTRONG_LTR;
}
const defaults = [new JBidiFormatter(), Object.assign(new JBidiFormatter(), { rtl: true })];
async function unicodeWrap(this: JBidiFormatter, source: unknown, heuristic: unknown = this.heuristic, isolate = 1) {
  if (source == null) return null;
  const text = await csText(source);
  const rtl = !!await vcall(heuristic, "isRtl", "(Ljava/lang/CharSequence;II)Z", source, 0, text.length);
  const mark = this.rtl ? "\u200f" : "\u200e", opposite = this.rtl ? -1 : 1;
  let before = isolate && this.reset && (rtl !== this.rtl || boundaryDirection(text, false) === opposite) ? mark : "";
  let after = isolate && (rtl !== this.rtl || boundaryDirection(text, true) === opposite) ? mark : "";
  if (rtl !== this.rtl) { before += rtl ? "\u202b" : "\u202a"; after = "\u202c" + after; }
  const result = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", source) as JSpanned;
  result.text = before + text + after;
  for (const span of result.spans) { span.start += before.length; span.end += before.length; }
  return result;
}
const methods: NativeSpec["methods"] = {
  "static getInstance()Landroid/text/BidiFormatter;": () => after(defaultDirection(), (dir) => defaults[dir]),
  "static getInstance(Z)Landroid/text/BidiFormatter;": (rtl: number) => defaults[rtl ? 1 : 0],
  "static getInstance(Ljava/util/Locale;)Landroid/text/BidiFormatter;": (locale: JLocale | null) => after(localeDirection(locale), (dir) => defaults[dir]),
  "isRtlContext()Z": function (this: JBidiFormatter) { return +this.rtl; },
  "getStereoReset()Z": function (this: JBidiFormatter) { return +this.reset; },
};
for (const type of ["java/lang/String", "java/lang/CharSequence"]) {
  methods[`isRtl(L${type};)Z`] = async function (this: JBidiFormatter, text: unknown) { return vcall(this.heuristic, "isRtl", "(Ljava/lang/CharSequence;II)Z", text, 0, (await csText(text)).length); };
  for (const suffix of ["", "Z", "Landroid/text/TextDirectionHeuristic;", "Landroid/text/TextDirectionHeuristic;Z"]) {
    methods[`unicodeWrap(L${type};${suffix})L${type};`] = async function (this: JBidiFormatter, text: unknown, heuristic?: unknown, isolate = 1) {
      const result = await unicodeWrap.call(this, text, suffix === "Z" || !suffix ? this.heuristic : heuristic, suffix === "Z" ? Number(heuristic) : isolate);
      return type === "java/lang/String" ? result?.text ?? null : result;
    };
  }
}
rt.register({ name: "android/text/BidiFormatter", ctor: JBidiFormatter, methods });
rt.register({ name: "android/text/BidiFormatter$Builder", ctor: class extends JBidiFormatter {}, methods: {
  "<init>()V": function (this: JBidiFormatter) { return after(defaultDirection(), (dir) => { this.rtl = !!dir; }); },
  "<init>(Z)V": function (this: JBidiFormatter, rtl: number) { this.rtl = !!rtl; },
  "<init>(Ljava/util/Locale;)V": function (this: JBidiFormatter, locale: JLocale | null) { return after(localeDirection(locale), (dir) => { this.rtl = !!dir; }); },
  "stereoReset(Z)Landroid/text/BidiFormatter$Builder;": function (this: JBidiFormatter, reset: number) { this.reset = !!reset; return this; },
  "setTextDirectionHeuristic(Landroid/text/TextDirectionHeuristic;)Landroid/text/BidiFormatter$Builder;": function (this: JBidiFormatter, heuristic: unknown) { this.heuristic = heuristic; return this; },
  "build()Landroid/text/BidiFormatter;": function (this: JBidiFormatter) { return Object.assign(rt.make("android/text/BidiFormatter"), { rtl: this.rtl, reset: this.reset, heuristic: this.heuristic }); },
} });
