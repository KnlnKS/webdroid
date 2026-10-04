// java.lang.String over JS string primitives (String.prototype carries mangled Java methods), and
// StringBuilder and StringBuffer over a JS string.

import { awaited, rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { mangleMethod, jmethod, charsToString, utf8, splitSig, stringHash, parseMethodDesc } from "../abi";
import { encodeString } from "../charset";
import { definePublic, once } from "../suspend";
import { csText } from "./jchars";
import { boxObject } from "./jbox";
import { stringMatches, stringReplace, stringSplit } from "./jregex";
import { after, linkInit, scall, vcall } from "./jentry";

function* joinCharSequences(separator: unknown, parts: unknown[]): Gen<string> {
  if (separator == null || parts == null) rt.npe();
  const text = yield* awaited(csText(separator));
  const values: string[] = [];
  for (const part of parts) values.push(part == null ? "null" : yield* awaited(csText(part)));
  return values.join(text);
}

const joinIterable = driven(function* (separator: unknown, parts: unknown): Gen<string> {
  if (parts == null) rt.npe();
  const values: unknown[] = [];
  const iterator = yield vcall(parts, "iterator", "()Ljava/util/Iterator;");
  while (yield vcall(iterator, "hasNext", "()Z")) values.push(yield vcall(iterator, "next", "()Ljava/lang/Object;"));
  return yield* joinCharSequences(separator, values);
});

// ── String (patch JS String.prototype with mangled methods)
function sm(sig: string, fn: (this: string, ...a: any[]) => unknown) {
  const [name, desc] = splitSig(sig);
  definePublic(String.prototype, mangleMethod(name, desc), fn, parseMethodDesc(desc).params.length);
}
function sioobe(i: number): never {
  throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", "index " + i);
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff, isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** code point access shared by String, StringBuilder and Character, with Java's bounds */
function cpAt(s: string, i: number, limit = s.length): number {
  if (i < 0 || i >= limit) sioobe(i);
  const c = s.charCodeAt(i);
  return isHigh(c) && i + 1 < limit && isLow(s.charCodeAt(i + 1)) ? s.codePointAt(i)! : c;
}
function cpBefore(s: string, i: number, start = 0): number {
  if (i <= start || i > s.length) sioobe(i);
  const c = s.charCodeAt(i - 1);
  return isLow(c) && i - 1 > start && isHigh(s.charCodeAt(i - 2)) ? s.codePointAt(i - 2)! : c;
}
function cpCount(s: string, a: number, b: number): number {
  if (a < 0 || b < a || b > s.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
  let n = b - a;
  for (let i = a; i < b - 1; i++) if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) { n--; i++; }
  return n;
}
sm("length()I", function () { return this.length; });
sm("isEmpty()Z", function () { return this.length === 0 ? 1 : 0; });
sm("charAt(I)C", function (i: number) {
  if (i >>> 0 >= this.length) sioobe(i);
  return this.charCodeAt(i);
});
sm("codePointAt(I)I", function (i: number) { return cpAt(this, i); });
sm("codePointBefore(I)I", function (i: number) { return cpBefore(this, i); });
sm("hashCode()I", function () { return stringHash(this as string); });
sm("equals(Ljava/lang/Object;)Z", function (o: unknown) { return (this as string) === o ? 1 : 0; });
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
function stringCompare(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d) return d;
  }
  return a.length - b.length;
}
const compareStrings = function (this: string, o: string) { return stringCompare(this, o); };
sm("compareTo(Ljava/lang/String;)I", compareStrings);
sm("compareTo(Ljava/lang/Object;)I", compareStrings);
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
const GET_DEFAULT = mangleMethod("getDefault", "()Ljava/util/Locale;"), localeClass = once(() => linkInit("java/util/Locale"));
const caseInDefault = (s: string, upper: boolean): unknown => !LOCALE_CASED.test(s) ? caseAs(s, upper, "")
  : after(localeClass(), (info) => after((info.ctor as Record<string, () => object>)[GET_DEFAULT](), (locale) => caseIn(s, locale, upper)));
sm("toLowerCase()Ljava/lang/String;", function () { return caseInDefault(this, false); });
sm("toUpperCase()Ljava/lang/String;", function () { return caseInDefault(this, true); });
sm("toLowerCase(Ljava/util/Locale;)Ljava/lang/String;", function (locale: object | null) { return caseIn(this, locale, false); });
sm("toUpperCase(Ljava/util/Locale;)Ljava/lang/String;", function (locale: object | null) { return caseIn(this, locale, true); });
sm("toString()Ljava/lang/String;", function () { return this as string; });
sm("toCharArray()[C", function () {
  const a = new Uint16Array(this.length);
  for (let i = 0; i < this.length; i++) a[i] = this.charCodeAt(i);
  return a;
});
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
// ART's compact-string internals, which libcore's builders and StringLatin1/StringUTF16 use: coder
// 0 (LATIN1) holds each char in a byte, coder 1 (UTF16) in two, low byte first; fills start at a byte index
const NOT_LATIN1 = /[^\x00-\xff]/;
sm("coder()B", function () { return NOT_LATIN1.test(this) ? 1 : 0; });
sm("fillBytesLatin1([BI)V", function (dst: Int8Array, at: number) { for (let i = 0; i < this.length; i++) dst[at + i] = this.charCodeAt(i); });
sm("fillBytesUTF16([BI)V", function (dst: Int8Array, at: number) {
  for (let i = 0, j = at; i < this.length; i++, j += 2) { const c = this.charCodeAt(i); dst[j] = c; dst[j + 1] = c >> 8; }
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
sm("concat(Ljava/lang/String;)Ljava/lang/String;", function (s: string) { return (this as string) + s; });
sm("intern()Ljava/lang/String;", function () { return this as string; });
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
sm("getClass()Ljava/lang/Class;", function () { return rt.classFor("java/lang/String"); });
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
  const f = jmethod(v, M_TO_STRING);
  const r = f && f.call(v);
  return typeof r === "string" ? r : String(v);
}
/** String.valueOf(Object): "null", or what the value's virtual toString answers (null included) */
const valueOfObject = (v: unknown): string | null | Promise<string | null> =>
  v === null ? "null" : typeof v === "string" ? v : vcall(boxObject(v), "toString", "()Ljava/lang/String;");
/** the text string concatenation appends for a value */
const stringOf = (v: unknown): string | Promise<string> => after(valueOfObject(v), String);
rt.register({
  name: "java/lang/String",
  ctor: String, // instances are JS primitives
  ifaces: ["java/lang/CharSequence", "java/lang/Comparable", "java/io/Serializable"],
  // strings travel as TC_STRING; their class descriptor (a Class<String> written on its own) has no fields
  serialization: { uid: -6849794470754667710n, fields: [] },
  methods: {
    "static valueOf(I)Ljava/lang/String;": (v: number) => String(v),
    "static valueOf(J)Ljava/lang/String;": (v: bigint) => String(v),
    "static valueOf(Z)Ljava/lang/String;": (v: number) => (v ? "true" : "false"),
    "static valueOf(C)Ljava/lang/String;": (v: number) => String.fromCharCode(v),
    "static valueOf(Ljava/lang/Object;)Ljava/lang/String;": valueOfObject,
    "static valueOf([C)Ljava/lang/String;": (v: Uint16Array) => charsToString(v, 0, v.length),
    "static valueOf([CII)Ljava/lang/String;": (v: Uint16Array, o: number, n: number) => charsToString(v, o, n),
    "static join(Ljava/lang/CharSequence;[Ljava/lang/CharSequence;)Ljava/lang/String;": driven(joinCharSequences),
    "static join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String;": joinIterable,
  },
  // String's <clinit> does not run for the spec: its comparator is made on first read
  statics: { get CASE_INSENSITIVE_ORDER() { return rt.make("java/lang/String$CaseInsensitiveComparator"); } },
});
// §4.7: StringBuilder and StringBuffer over a JS string, which V8 concatenates as a rope: libcore's
// builders fill a byte[] char by char and measured 8x-15x slower on appends. Every method follows
// libcore's AbstractStringBuilder, its capacity policy and messages included (tests/intrinsics.test.ts
// runs both over generated operations); float and double text is libcore's Float/Double.toString.
class JSB extends JObj {
  s = "";
  /** the capacity libcore's builder would have: its value array's length in chars */
  cap = 16;
}
const indexError = (msg: string): never => { throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", msg); };
const checkIndex = (i: number, n: number) => { if (i < 0 || i >= n) indexError(`index ${i},length ${n}`); };
const checkOffset = (i: number, n: number) => { if (i < 0 || i > n) indexError(`offset ${i},length ${n}`); };
const checkRange = (start: number, end: number, n: number, cls = "java/lang/StringIndexOutOfBoundsException") => {
  if (start < 0 || start > end || end > n) throw rt.mkThrowable(cls, `start ${start}, end ${end}, length ${n}`);
};
/** AbstractStringBuilder.ensureCapacityInternal: at least `min`, at least twice plus two */
function grow(sb: JSB, min: number): void { if (min > sb.cap) sb.cap = Math.max(min, sb.cap * 2 + 2); }
/** the append every builder method but insert takes */
function add(sb: JSB, text: string): JSB {
  grow(sb, sb.s.length + text.length);
  sb.s += text;
  return sb;
}
function put(sb: JSB, at: number, text: string): JSB {
  grow(sb, sb.s.length + text.length);
  sb.s = at === sb.s.length ? sb.s + text : sb.s.slice(0, at) + text + sb.s.slice(at);
  return sb;
}
const floatText = (v: number) => scall("java/lang/Float", "toString", "(F)Ljava/lang/String;", v);
const doubleText = (v: number) => scall("java/lang/Double", "toString", "(D)Ljava/lang/String;", v);
const charRange = (v: Uint16Array | null, start: number, n: number) => {
  if (v === null) return rt.npe();
  checkRange(start, start + n, v.length);
  return charsToString(v, start, n);
};
/** chars [a, b) of a CharSequence (b undefined: its length), read as libcore's builders read one:
 *  a String's or a builder's text, any other sequence through length() and charAt() */
const csChars = driven(function* csChars(v: unknown, a: number, b?: number): Gen<string> {
  if (v === null) v = "null";
  const text = typeof v === "string" ? v : v instanceof JSB ? v.s : null;
  const n: number = text?.length ?? (yield vcall(v, "length", "()I"));
  b ??= n;
  checkRange(a, b, n, "java/lang/IndexOutOfBoundsException");
  if (text !== null) return text.slice(a, b);
  const chars = new Uint16Array(b - a);
  for (let i = a; i < b; i++) chars[i - a] = yield vcall(v, "charAt", "(I)C", i);
  return charsToString(chars, 0, chars.length);
});
function sbSpec(name: string): NativeSpec {
  const c = name === "java/lang/StringBuilder" ? class SB extends JSB {} : class SBuf extends JSB {};
  const L = `L${name};`;
  const at = (self: JSB, i: number, text: string | Promise<string>) => after(text, (t: string) => put(self, i, t));
  const appendText = (self: JSB, t: string | Promise<string>) => after(t, (text: string) => add(self, text));
  const appendCs = function (this: JSB, v: unknown) { return appendText(this, csChars(v, 0)); };
  const insertText = (text: (v: any) => string | Promise<string>) => function (this: JSB, i: number, v: unknown) { checkOffset(i, this.s.length); return at(this, i, text(v)); };
  const methods: NativeSpec["methods"] = {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JSB, n: number) { if (n < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", String(n)); this.cap = n; },
    "<init>(Ljava/lang/String;)V": function (this: JSB, s: string | null) { this.cap = (s ?? rt.npe()).length + 16; this.s = s!; },
    "<init>(Ljava/lang/CharSequence;)V": function (this: JSB, v: unknown) {
      return after(csChars(v ?? rt.npe(), 0), (s: string) => { this.cap = s.length + 16; this.s = s; });
    },
    [`append(Ljava/lang/String;)${L}`]: function (this: JSB, v: string | null) { return add(this, v ?? "null"); },
    [`append(Ljava/lang/Object;)${L}`]: function (this: JSB, v: unknown) { return appendText(this, stringOf(v)); },
    [`append(Ljava/lang/CharSequence;)${L}`]: appendCs,
    [`append(Ljava/lang/StringBuffer;)${L}`]: appendCs,
    [`append(Ljava/lang/CharSequence;II)${L}`]: function (this: JSB, v: unknown, a: number, b: number) { return appendText(this, csChars(v, a, b)); },
    [`append([C)${L}`]: function (this: JSB, v: Uint16Array) { return add(this, charRange(v, 0, v?.length ?? 0)); },
    [`append([CII)${L}`]: function (this: JSB, v: Uint16Array, o: number, n: number) { return add(this, charRange(v, o, n)); },
    [`append(Z)${L}`]: function (this: JSB, v: number) { return add(this, v ? "true" : "false"); },
    [`append(C)${L}`]: function (this: JSB, v: number) { return add(this, String.fromCharCode(v)); },
    [`append(I)${L}`]: function (this: JSB, v: number) { return add(this, "" + v); },
    [`append(J)${L}`]: function (this: JSB, v: bigint) { return add(this, "" + v); },
    [`append(F)${L}`]: function (this: JSB, v: number) { return appendText(this, floatText(v)); },
    [`append(D)${L}`]: function (this: JSB, v: number) { return appendText(this, doubleText(v)); },
    [`appendCodePoint(I)${L}`]: function (this: JSB, cp: number) {
      if (cp >>> 0 > 0x10ffff) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a valid Unicode code point: 0x" + (cp >>> 0).toString(16).toUpperCase());
      return add(this, String.fromCodePoint(cp));
    },
    [`insert(ILjava/lang/String;)${L}`]: insertText((v: string | null) => v ?? "null"),
    [`insert(ILjava/lang/Object;)${L}`]: insertText(stringOf),
    [`insert(ILjava/lang/CharSequence;)${L}`]: insertText((v) => csChars(v, 0)),
    [`insert(ILjava/lang/CharSequence;II)${L}`]: function (this: JSB, i: number, v: unknown, a: number, b: number) {
      checkOffset(i, this.s.length);
      return at(this, i, csChars(v, a, b));
    },
    [`insert(IC)${L}`]: insertText((v: number) => String.fromCharCode(v)),
    [`insert(II)${L}`]: insertText((v: number) => "" + v),
    [`insert(IJ)${L}`]: insertText((v: bigint) => "" + v),
    [`insert(IF)${L}`]: insertText(floatText),
    [`insert(ID)${L}`]: insertText(doubleText),
    [`insert(IZ)${L}`]: insertText((v: number) => (v ? "true" : "false")),
    [`insert(I[C)${L}`]: insertText((v: Uint16Array) => charRange(v, 0, v?.length ?? 0)),
    [`insert(I[CII)${L}`]: function (this: JSB, i: number, v: Uint16Array, o: number, n: number) {
      checkOffset(i, this.s.length);
      if (v === null) return rt.npe();
      checkRange(o, o + n, v.length);
      return put(this, i, charsToString(v, o, n));
    },
    "toString()Ljava/lang/String;": function (this: JSB) { return this.s; },
    "length()I": function (this: JSB) { return this.s.length; },
    "capacity()I": function (this: JSB) { return this.cap; },
    "ensureCapacity(I)V": function (this: JSB, n: number) { if (n > 0) grow(this, n); },
    "trimToSize()V": function (this: JSB) { if (this.s.length < this.cap) this.cap = this.s.length; },
    "charAt(I)C": function (this: JSB, i: number) { checkIndex(i, this.s.length); return this.s.charCodeAt(i); },
    "getChars(II[CI)V": function (this: JSB, begin: number, end: number, dst: Uint16Array, at: number) {
      checkRange(begin, end, this.s.length);
      if (dst === null) return rt.npe();
      checkRange(at, at + end - begin, dst.length, "java/lang/IndexOutOfBoundsException");
      for (let i = begin; i < end; i++) dst[at + i - begin] = this.s.charCodeAt(i);
    },
    "codePointAt(I)I": function (this: JSB, i: number) { checkIndex(i, this.s.length); return cpAt(this.s, i); },
    "codePointBefore(I)I": function (this: JSB, i: number) { checkIndex(i - 1, this.s.length); return cpBefore(this.s, i); },
    "codePointCount(II)I": function (this: JSB, a: number, b: number) { return cpCount(this.s, a, b); },
    "offsetByCodePoints(II)I": function (this: JSB, i: number, n: number) { return offsetCodePoints(this.s, i, n); },
    "chars()Ljava/util/stream/IntStream;": function (this: JSB) { return charStream(this.s); },
    "codePoints()Ljava/util/stream/IntStream;": function (this: JSB) { return codePointStream(this.s); },
    [`compareTo(${L})I`]: function (this: JSB, o: JSB) { return stringCompare(this.s, (o ?? rt.npe()).s); },
    [`replace(IILjava/lang/String;)${L}`]: function (this: JSB, a: number, b: number, r: string) {
      const n = this.s.length;
      if (b > n) b = n;
      checkRange(a, b, n);
      grow(this, n + (r ?? rt.npe()).length - (b - a));
      this.s = this.s.slice(0, a) + r + this.s.slice(b);
      return this;
    },
    "setLength(I)V": function (this: JSB, n: number) {
      if (n < 0) indexError("String index out of range: " + n);
      grow(this, n);
      this.s = n <= this.s.length ? this.s.slice(0, n) : this.s.padEnd(n, "\0");
    },
    [`reverse()${L}`]: function (this: JSB) { this.s = [...this.s].reverse().join(""); return this; },
    [`deleteCharAt(I)${L}`]: function (this: JSB, i: number) {
      checkIndex(i, this.s.length);
      this.s = this.s.slice(0, i) + this.s.slice(i + 1);
      return this;
    },
    [`delete(II)${L}`]: function (this: JSB, a: number, b: number) {
      const n = this.s.length;
      if (b > n) b = n;
      checkRange(a, b, n);
      this.s = this.s.slice(0, a) + this.s.slice(b);
      return this;
    },
    "indexOf(Ljava/lang/String;)I": function (this: JSB, v: string) { return this.s.indexOf(v ?? rt.npe()); },
    "indexOf(Ljava/lang/String;I)I": function (this: JSB, v: string, from: number) { return this.s.indexOf(v ?? rt.npe(), from); },
    "lastIndexOf(Ljava/lang/String;)I": function (this: JSB, v: string) { return this.s.lastIndexOf(v ?? rt.npe()); },
    "lastIndexOf(Ljava/lang/String;I)I": function (this: JSB, v: string, from: number) { return from < 0 ? (v ?? rt.npe(), -1) : this.s.lastIndexOf(v ?? rt.npe(), from); },
    "substring(I)Ljava/lang/String;": function (this: JSB, a: number) { checkRange(a, this.s.length, this.s.length); return this.s.slice(a); },
    "substring(II)Ljava/lang/String;": function (this: JSB, a: number, b: number) { checkRange(a, b, this.s.length); return this.s.slice(a, b); },
    "subSequence(II)Ljava/lang/CharSequence;": function (this: JSB, a: number, b: number) { checkRange(a, b, this.s.length); return this.s.slice(a, b); },
    "setCharAt(IC)V": function (this: JSB, i: number, ch: number) {
      checkIndex(i, this.s.length);
      this.s = this.s.slice(0, i) + String.fromCharCode(ch) + this.s.slice(i + 1);
    },
  };
  return { name, ctor: c, ifaces: ["java/lang/CharSequence", "java/lang/Appendable", "java/lang/Comparable"], methods };
}
rt.register(sbSpec("java/lang/StringBuilder"));
rt.register(sbSpec("java/lang/StringBuffer"));
function offsetCodePoints(text: string, index: number, offset: number): number {
  if (index < 0 || index > text.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(index));
  while (offset > 0 && index < text.length) {
    const c = text.charCodeAt(index++);
    if (isHigh(c) && index < text.length && isLow(text.charCodeAt(index))) index++;
    offset--;
  }
  while (offset < 0 && index > 0) {
    const c = text.charCodeAt(--index);
    if (isLow(c) && index > 0 && isHigh(text.charCodeAt(index - 1))) index--;
    offset++;
  }
  if (offset !== 0) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(offset));
  return index;
}

