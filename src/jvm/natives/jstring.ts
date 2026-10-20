// java.lang.String over JS string primitives: the methods implemented here, called with the string as `this`, replace their bytecode.

import { rt } from "../runtime.ts";
import { charsToString, utf8 } from "../abi.ts";
import { decodeString, encodeString } from "../charset.ts";
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
sm("contains(Ljava/lang/CharSequence;)Z", function (s: unknown) { return after(csText(s ?? rt.npe()), (t: string) => this.includes(t) ? 1 : 0); });
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

// ---------- String's constructors, by "<init>" key: what a compiled String factory falls back to (compiler/strings.ts), and JNI's NewObject
/** String's checkBoundsOffCount over a byte array: the offset */
function byteRange(bytes: Int8Array, off: number, count: number): number {
  if (off < 0 || count < 0 || off > bytes.length - count)
    throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `offset ${off}, count ${count}, length ${bytes.length}`);
  return off;
}
/** new String(char[], int, int), the constructor readers and parsers call per token */
function charRange(chars: Uint16Array | null, off: number, len: number): string {
  if (!chars) return rt.npe();
  if (off < 0 || len < 0 || off > chars.length - len) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `offset ${off}, count ${len}, length ${chars.length}`);
  return charsToString(chars, off, len);
}
/** the deprecated String(byte[] ascii, int hibyte, ...): each char is hibyte over a byte */
function hibyteRange(bytes: Int8Array | null, high: number, off: number, n: number): string {
  if (!bytes) throw rt.mkThrowable("java/lang/NullPointerException", "ascii");
  byteRange(bytes, off, n);
  const chars = new Uint16Array(n), hi = high << 8;
  for (let i = 0; i < n; i++) chars[i] = hi | (bytes[off + i] & 255);
  return charsToString(chars, 0, n);
}
const utf8Range = (bytes: Int8Array, off: number, n: number) => decodeString(bytes, "UTF-8", byteRange(bytes, off, n), n);
/** a builder's text: StringBuilder and StringBuffer run from bytecode */
const builderText = (sb: unknown) => csText(sb ?? rt.npe());
const constructors: Record<string, (...a: any[]) => unknown> = {
  "()V": () => "",
  "(Ljava/lang/String;)V": (s: string) => s,
  "(Ljava/lang/StringBuilder;)V": builderText,
  "(Ljava/lang/StringBuffer;)V": builderText,
  "([C)V": (chars: Uint16Array) => charsToString(chars, 0, chars.length),
  "([CII)V": charRange,
  // String(byte[] value, byte coder): the compact form StringLatin1 and StringUTF16 build
  "([BB)V": (bytes: Int8Array, coder: number) => {
    const n = coder ? bytes.length >> 1 : bytes.length, chars = new Uint16Array(n);
    if (coder) for (let i = 0; i < n; i++) chars[i] = (bytes[2 * i] & 255) | ((bytes[2 * i + 1] & 255) << 8);
    else for (let i = 0; i < n; i++) chars[i] = bytes[i] & 255;
    return charsToString(chars, 0, n);
  },
  "([BI)V": (bytes: Int8Array, high: number) => hibyteRange(bytes, high, 0, bytes?.length),
  "([BIII)V": hibyteRange,
  "([B)V": (bytes: Int8Array) => decodeString(bytes, "UTF-8"),
  "([BII)V": utf8Range,
  "([BLjava/lang/String;)V": (bytes: Int8Array, cs: string) => decodeString(bytes, cs),
  "([BLjava/nio/charset/Charset;)V": (bytes: Int8Array, cs: object) => decodeString(bytes, cs),
  "([BIILjava/lang/String;)V": (bytes: Int8Array, off: number, n: number, cs: string) => decodeString(bytes, cs, byteRange(bytes, off, n), n),
  "([BIILjava/nio/charset/Charset;)V": (bytes: Int8Array, off: number, n: number, cs: object) => decodeString(bytes, cs, byteRange(bytes, off, n), n),
  // code points, not chars: each element is a whole Unicode scalar
  "([III)V": (cp: Int32Array, off: number, n: number) => {
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCodePoint(cp[off + i]);
    return out;
  },
};
for (const desc in constructors) sm("<init>" + desc, constructors[desc]);
// ART's string allocations, which String's constructors become
rt.registerJnis("java/lang/StringFactory", {
  "newStringFromBytes([BIII)Ljava/lang/String;": hibyteRange,
  "newStringFromChars(II[C)Ljava/lang/String;": (off: number, n: number, chars: Uint16Array) => charRange(chars, off, n),
  "newStringFromString(Ljava/lang/String;)Ljava/lang/String;": (s: string | null) => s ?? rt.npe(),
  "newStringFromUtf8Bytes([BII)Ljava/lang/String;": utf8Range,
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
sm("contentEquals(Ljava/lang/CharSequence;)Z", function (o: unknown) { return after(csText(o ?? rt.npe()), (t: string) => this === t ? 1 : 0); });
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

