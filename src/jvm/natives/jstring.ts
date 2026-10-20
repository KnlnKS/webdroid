// java.lang.String's natives, and the regex methods whose bytecode builds a Pattern and a Matcher each call (measured tens of times slower):
// these, called with the string as `this`, replace their bytecode. charAt and substring answer their Wasm intrinsics' out-of-range calls.

import { rt } from "../runtime.ts";
import { charsToString } from "../abi.ts";
import { stringMatches, stringReplace } from "./jregex.ts";

/** String's methods implemented here, by `name(desc)` */
export const stringMethods = new Map<string, (this: string, ...a: any[]) => unknown>();
const sm = (sig: string, fn: (this: string, ...a: any[]) => unknown) => { stringMethods.set(sig, fn); };
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
sm("matches(Ljava/lang/String;)Z", function (p: string) { return stringMatches(this as string, p); });
sm("replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, true); });
sm("replaceFirst(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, false); });
