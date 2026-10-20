// java.lang.String's natives and constructors, and the regex methods whose bytecode builds a Pattern and a Matcher each call (measured tens of times slower):
// these, called with the string as `this`, replace their bytecode. charAt and substring answer their Wasm intrinsics' out-of-range calls.

import { rt } from "../runtime.ts";
import { charsToString } from "../abi.ts";
import { decodeString } from "../charset.ts";
import { csText } from "./jchars.ts";
import { stringMatches, stringReplace } from "./jregex.ts";

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
sm("charAt(I)C", function (i: number) {
  if (i >>> 0 >= this.length) sioobe(i);
  return this.charCodeAt(i);
});
sm("substring(I)Ljava/lang/String;", function (i: number) {
  if (i < 0 || i > this.length) sioobe(i);
  return this.slice(i);
});
sm("substring(II)Ljava/lang/String;", function (a: number, b: number) {
  if (a < 0 || b > this.length || a > b) sioobe(a);
  return this.slice(a, b);
});
sm("doRepeat(I)Ljava/lang/String;", function (n: number) { return this.repeat(n); });
// what replace(char, char) calls once it has found the old char
sm("doReplace(CC)Ljava/lang/String;", function (a: number, b: number) { return this.replaceAll(String.fromCharCode(a), String.fromCharCode(b)); });
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
sm("matches(Ljava/lang/String;)Z", function (p: string) { return stringMatches(this as string, p); });
sm("replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, true); });
sm("replaceFirst(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, false); });
