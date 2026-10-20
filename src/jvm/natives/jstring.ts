// java.lang.String over JS string primitives: the methods implemented here, called with the string as `this`, replace their bytecode.

import { rt } from "../runtime.ts";
import { mangleMethod, charsToString, utf8 } from "../abi.ts";
import { encodeString } from "../charset.ts";
import { once } from "../suspend.ts";
import { csText } from "./jchars.ts";
import { stringMatches, stringReplace, stringSplit } from "./jregex.ts";
import { after, linkInit, scall, vcall } from "./jentry.ts";

/** String's methods implemented here, by `name(desc)` */
export const stringMethods = new Map<string, (this: string, ...a: any[]) => unknown>();
const sm = (sig: string, fn: (this: string, ...a: any[]) => unknown) => {
  if (stringMethods.has(sig)) throw new Error(`String.${sig} is registered twice`);
  stringMethods.set(sig, fn);
};
function sioobe(i: number): never {
  throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", "index " + i);
}
export const isLead = (c: number) => c >= 0xd800 && c <= 0xdbff, isTrail = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** code point access shared by String, StringBuilder and Character, with Java's bounds */
function cpAt(s: string, i: number, limit = s.length): number {
  if (i < 0 || i >= limit) sioobe(i);
  const c = s.charCodeAt(i);
  return isLead(c) && i + 1 < limit && isTrail(s.charCodeAt(i + 1)) ? s.codePointAt(i)! : c;
}
function cpBefore(s: string, i: number, start = 0): number {
  if (i <= start || i > s.length) sioobe(i);
  const c = s.charCodeAt(i - 1);
  return isTrail(c) && i - 1 > start && isLead(s.charCodeAt(i - 2)) ? s.codePointAt(i - 2)! : c;
}
function cpCount(s: string, a: number, b: number): number {
  if (a < 0 || b < a || b > s.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
  let n = b - a;
  for (let i = a; i < b - 1; i++) if (isLead(s.charCodeAt(i)) && isTrail(s.charCodeAt(i + 1))) { n--; i++; }
  return n;
}
sm("charAt(I)C", function (i: number) {
  if (i >>> 0 >= this.length) sioobe(i);
  return this.charCodeAt(i);
});
sm("codePointAt(I)I", function (i: number) { return cpAt(this, i); });
sm("codePointBefore(I)I", function (i: number) { return cpBefore(this, i); });
// Case-insensitive comparison is libcore's (Character.toUpperCase, then toLowerCase, per char); ASCII
// chars, whose cases are ASCII letters, compare here
sm("equalsIgnoreCase(Ljava/lang/String;)Z", function (o: string | null) {
  if (o === null || o.length !== this.length) return 0;
  for (let i = 0; i < o.length; i++) {
    const a = this.charCodeAt(i), b = o.charCodeAt(i), lower = a | 0x20;
    if (a === b) continue;
    if ((a | b) >= 0x80) return vcall(this, "regionMatches", "(ZILjava/lang/String;II)Z", 1, 0, o, 0, this.length);
    if (lower !== (b | 0x20) || lower < 0x61 || lower > 0x7a) return 0;
  }
  return 1;
});
/** String.indexOf(int): a char, a surrogate pair for a supplementary code point, never an invalid one.
 *  Short strings (URI and parser delimiter sets) are scanned without allocating the needle. */
function charIndex(s: string, c: number, from: number): number {
  if (c >>> 0 < 0x10000 && s.length - from < 32) {
    for (let i = from < 0 ? 0 : from; i < s.length; i++) if (s.charCodeAt(i) === c) return i;
    return -1;
  }
  return c >>> 0 > 0x10ffff ? -1 : s.indexOf(String.fromCodePoint(c), from);
}
function charLastIndex(s: string, c: number, from: number): number {
  return from < 0 || c >>> 0 > 0x10ffff ? -1 : s.lastIndexOf(String.fromCodePoint(c), from);
}
sm("indexOf(I)I", function (c: number) { return charIndex(this, c, 0); });
sm("indexOf(II)I", function (c: number, from: number) { return charIndex(this, c, from); });
sm("indexOf(Ljava/lang/String;)I", function (s: string) { return this.indexOf(s); });
sm("indexOf(Ljava/lang/String;I)I", function (s: string, from: number) { return this.indexOf(s, from); });
sm("lastIndexOf(I)I", function (c: number) { return charLastIndex(this, c, this.length); });
sm("lastIndexOf(Ljava/lang/String;)I", function (s: string) { return this.lastIndexOf(s); });
sm("lastIndexOf(II)I", function (c: number, from: number) { return charLastIndex(this, c, from); });
sm("lastIndexOf(Ljava/lang/String;I)I", function (v: string, from: number) { return this.lastIndexOf(v, from); });
sm("substring(I)Ljava/lang/String;", function (i: number) {
  if (i < 0 || i > this.length) sioobe(i);
  return this.slice(i);
});
const substring = function (this: string, a: number, b: number) {
  if (a < 0 || b > this.length || a > b) sioobe(a);
  return this.slice(a, b);
};
sm("substring(II)Ljava/lang/String;", substring);
sm("subSequence(II)Ljava/lang/CharSequence;", substring);
sm("startsWith(Ljava/lang/String;)Z", function (s: string) { return this.startsWith(s) ? 1 : 0; });
sm("startsWith(Ljava/lang/String;I)Z", function (s: string, i: number) { return this.startsWith(s, i) ? 1 : 0; });
sm("endsWith(Ljava/lang/String;)Z", function (s: string) { return this.endsWith(s) ? 1 : 0; });
sm("contains(Ljava/lang/CharSequence;)Z", function (s: unknown) { return this.includes(jToString(s)) ? 1 : 0; });
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
const JAVA_WHITESPACE = /^[\t-\r\x1c-\x1f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+|[\t-\r\x1c-\x1f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/g;
sm("trim()Ljava/lang/String;", function () { return javaTrim(this); });
sm("strip()Ljava/lang/String;", function () { return this.replace(JAVA_WHITESPACE, ""); });
sm("doRepeat(I)Ljava/lang/String;", function (n: number) { return this.repeat(n); });
// CaseMapper: only Turkish, Azeri and Lithuanian case differently, and only these letters; the
// no-argument forms case for Locale.getDefault()
const LOCALE_CASED = /[IiJj\u00cc\u00cd\u0128\u012e\u0130\u0131\u0307]/, CASE_LOCALES = new Set(["tr", "az", "lt"]);
/** `s` cased as `lang` cases it; languages CaseMapper does not treat apart case as the root locale */
const caseAs = (s: string, upper: boolean, lang: string): string => !CASE_LOCALES.has(lang)
  ? upper ? s.toUpperCase() : s.toLowerCase() : upper ? s.toLocaleUpperCase(lang) : s.toLocaleLowerCase(lang);
/** a Locale's language, which never changes */
const languages = new WeakMap<object, string>();
const language = (locale: object): string | Promise<string> => languages.get(locale) ??
  after(vcall(locale, "getLanguage", "()Ljava/lang/String;"), (lang: string) => { languages.set(locale, lang); return lang; });
function caseIn(s: string, locale: object | null, upper: boolean): unknown {
  if (locale === null) return rt.npe();
  return LOCALE_CASED.test(s) ? after(language(locale), (lang) => caseAs(s, upper, lang)) : caseAs(s, upper, "");
}
const localeClass = once(() => linkInit("java/util/Locale"));
const caseInDefault = (s: string, upper: boolean): unknown => !LOCALE_CASED.test(s) ? caseAs(s, upper, "")
  : after(localeClass(), (locales) => after(locales.call("getDefault", "()Ljava/util/Locale;")() as object, (locale) => caseIn(s, locale, upper)));
sm("toLowerCase()Ljava/lang/String;", function () { return caseInDefault(this, false); });
sm("toUpperCase()Ljava/lang/String;", function () { return caseInDefault(this, true); });
sm("toLowerCase(Ljava/util/Locale;)Ljava/lang/String;", function (locale: object | null) { return caseIn(this, locale, false); });
sm("toUpperCase(Ljava/util/Locale;)Ljava/lang/String;", function (locale: object | null) { return caseIn(this, locale, true); });
sm("getChars(II[CI)V", function (srcBegin: number, srcEnd: number, dst: Uint16Array, dstBegin: number) {
  if (srcBegin < 0 || srcBegin > srcEnd || srcEnd > this.length) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `begin ${srcBegin}, end ${srcEnd}, length ${this.length}`);
  if (!dst) rt.npe();
  if (dstBegin < 0 || dstBegin > dst.length - (srcEnd - srcBegin)) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `offset ${dstBegin}, count ${srcEnd - srcBegin}, length ${dst.length}`);
  for (let i = srcBegin; i < srcEnd; i++) dst[dstBegin + i - srcBegin] = this.charCodeAt(i);
});
const utf8Bytes = function (this: string) { return new Int8Array(utf8.enc.encode(this).buffer); };
sm("getBytes()[B", utf8Bytes);
const encodedBytes = function (this: string, charset: unknown) { return encodeString(this, charset); };
sm("getBytes(Ljava/lang/String;)[B", encodedBytes);
sm("getBytes(Ljava/nio/charset/Charset;)[B", encodedBytes);
sm("getBytes(II[BI)V", function (begin: number, end: number, dst: Int8Array, offset: number) {
  if (begin < 0 || end > this.length || begin > end) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", null);
  if (dst == null) rt.npe();
  if (offset < 0 || offset + end - begin > dst.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
  for (let i = begin; i < end; i++) dst[offset + i - begin] = this.charCodeAt(i);
});
// ART's string allocations, which String's constructors become
rt.registerJnis("java/lang/StringFactory", {
  "newStringFromBytes([BIII)Ljava/lang/String;": (b: Int8Array, high: number, off: number, n: number) => rt.newStr["([BIII)V"](b, high, off, n),
  "newStringFromChars(II[C)Ljava/lang/String;": (off: number, n: number, chars: Uint16Array) => rt.strChars(chars, off, n),
  "newStringFromString(Ljava/lang/String;)Ljava/lang/String;": (s: string | null) => s ?? rt.npe(),
  "newStringFromUtf8Bytes([BII)Ljava/lang/String;": (b: Int8Array, off: number, n: number) => rt.newStr["([BII)V"](b, off, n),
  "newStringFromUtf16Bytes([BII)Ljava/lang/String;": (b: Int8Array, off: number, n: number) => {
    const chars = new Uint16Array(n);
    for (let i = 0; i < n; i++) chars[i] = (b[off + 2 * i] & 255) | ((b[off + 2 * i + 1] & 255) << 8);
    return charsToString(chars, 0, n);
  },
});
sm("replace(CC)Ljava/lang/String;", function (a: number, b: number) {
  return this.split(String.fromCharCode(a)).join(String.fromCharCode(b));
});
sm("replace(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/lang/String;", function (a: unknown, b: unknown) {
  return after(csText(a ?? rt.npe()), (target: string) => after(csText(b ?? rt.npe()), (replacement: string) => this.replaceAll(target, () => replacement)));
});
sm("regionMatches(ILjava/lang/String;II)Z", function (toff: number, o: string, ooff: number, len: number) {
  if (toff < 0 || ooff < 0 || toff + len > this.length || ooff + len > o.length) return 0;
  return this.substr(toff, len) === o.substr(ooff, len) ? 1 : 0;
});
sm("contentEquals(Ljava/lang/CharSequence;)Z", function (o: unknown) { return (this as string) === jToString(o) ? 1 : 0; });
sm("codePointCount(II)I", function (a: number, b: number) { return cpCount(this, a, b); });
sm("offsetByCodePoints(II)I", function (i: number, n: number) { return offsetCodePoints(String(this), i, n); });
const intStream = (values: Int32Array) => scall("java/util/Arrays", "stream", "([I)Ljava/util/stream/IntStream;", values);
const charStream = (s: string) => intStream(Int32Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)));
const codePointStream = (s: string) => intStream(Int32Array.from(s, (ch) => ch.codePointAt(0)!));
sm("chars()Ljava/util/stream/IntStream;", function () { return charStream(this); });
sm("codePoints()Ljava/util/stream/IntStream;", function () { return codePointStream(this); });
sm("matches(Ljava/lang/String;)Z", function (p: string) { return stringMatches(this as string, p); });
sm("replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, true); });
sm("replaceFirst(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, false); });
sm("split(Ljava/lang/String;)[Ljava/lang/String;", function (p: string) { return stringSplit(this as string, p, 0); });
sm("split(Ljava/lang/String;I)[Ljava/lang/String;", function (p: string, l: number) { return stringSplit(this as string, p, l); });

const M_TO_STRING = mangleMethod("toString", "()Ljava/lang/String;");
/** A value's OWN toString — %s prints that, and so does every CharSequence a synchronous
 *  native is handed. A body that suspends cannot be awaited here and falls back to JS. */
function jToString(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return String(v);
  const r = (v as Record<string, (() => unknown) | undefined>)[M_TO_STRING]?.call(v);
  return typeof r === "string" ? r : String(v);
}
function offsetCodePoints(text: string, index: number, offset: number): number {
  if (index < 0 || index > text.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(index));
  while (offset > 0 && index < text.length) {
    const c = text.charCodeAt(index++);
    if (isLead(c) && index < text.length && isTrail(text.charCodeAt(index))) index++;
    offset--;
  }
  while (offset < 0 && index > 0) {
    const c = text.charCodeAt(--index);
    if (isTrail(c) && index > 0 && isLead(text.charCodeAt(index - 1))) index--;
    offset++;
  }
  if (offset !== 0) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(offset));
  return index;
}

