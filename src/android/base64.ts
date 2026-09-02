// android.util.Base64. Not java.util.Base64: the flag word, the trailing newline and the
// 76-char wrapping are AOSP-specific and apps round-trip against them.
//
// The value model is the whole difficulty here. A Java byte[] is an Int8Array (values
// -128..127) and a Java String is a JS string primitive, so btoa/atob are useless — btoa
// throws on any code unit above 0xff and atob hands back a string whose chars must still be
// re-signed. Everything below works on numbers and masks with 0xff.

import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JOutputStream } from "../jvm/natives/jio";

const DEFAULT = 0, NO_PADDING = 1, NO_WRAP = 2, CRLF = 4, URL_SAFE = 8, NO_CLOSE = 16;

const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const WEB = STD.slice(0, 62) + "-_";

// One decode table for both alphabets: '-'/'_' never appear in standard base64 and '+'/'/'
// never in the web-safe form, so accepting all four can only widen what decodes, never
// change the value of anything that was already legal.
const DEC = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) { DEC[STD.charCodeAt(i)] = i; DEC[WEB.charCodeAt(i)] = i; }

function enc(input: Int8Array, off: number, len: number, flags: number): number[] {
  const tab = flags & URL_SAFE ? WEB : STD;
  const pad = !(flags & NO_PADDING), wrap = !(flags & NO_WRAP), crlf = (flags & CRLF) !== 0;
  const out: number[] = [];
  let col = 0;
  const nl = () => { if (crlf) out.push(13); out.push(10); col = 0; };
  const emit = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      out.push(s.charCodeAt(i));
      // AOSP wraps every 19 three-byte groups, i.e. every 76 output characters.
      if (wrap && ++col === 76) nl();
    }
  };
  let i = off;
  const end = off + len;
  for (; i + 2 < end; i += 3) {
    const w = ((input[i] & 0xff) << 16) | ((input[i + 1] & 0xff) << 8) | (input[i + 2] & 0xff);
    emit(tab[(w >> 18) & 63] + tab[(w >> 12) & 63] + tab[(w >> 6) & 63] + tab[w & 63]);
  }
  const rem = end - i;
  if (rem === 1) {
    const w = (input[i] & 0xff) << 16;
    emit(tab[(w >> 18) & 63] + tab[(w >> 12) & 63] + (pad ? "==" : ""));
  } else if (rem === 2) {
    const w = ((input[i] & 0xff) << 16) | ((input[i + 1] & 0xff) << 8);
    emit(tab[(w >> 18) & 63] + tab[(w >> 12) & 63] + tab[(w >> 6) & 63] + (pad ? "=" : ""));
  }
  // AOSP terminates a wrapped encoding with a line separator even when the last line is short.
  if (wrap && len > 0 && col !== 0) nl();
  return out;
}

function dec(codes: ArrayLike<number>, off: number, len: number): Int8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (let i = off; i < off + len; i++) {
    const c = codes[i] & 0xff;
    if (c === 61) break;                                  // '=' ends the data
    if (c === 10 || c === 13 || c === 32 || c === 9) continue;
    const v = DEC[c];
    if (v < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "bad base-64");
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Int8Array(out);
}

const strCodes = (s: string): number[] => {
  const a = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};
const toStr = (codes: number[]) => {
  let s = "";                                             // spread would overflow the stack on big blobs
  for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode(...codes.slice(i, i + 8192));
  return s;
};
const toBytes = (codes: number[]) => Int8Array.from(codes);

rt.register({
  name: "android/util/Base64",
  ctor: class extends JObj {},
  statics: { DEFAULT, NO_PADDING, NO_WRAP, CRLF, URL_SAFE, NO_CLOSE },
  methods: {
    "static encode([BI)[B": (b: Int8Array, f: number) => toBytes(enc(b, 0, b.length, f)),
    "static encode([BIII)[B": (b: Int8Array, o: number, l: number, f: number) => toBytes(enc(b, o, l, f)),
    "static encodeToString([BI)Ljava/lang/String;": (b: Int8Array, f: number) => toStr(enc(b, 0, b.length, f)),
    "static encodeToString([BIII)Ljava/lang/String;":
      (b: Int8Array, o: number, l: number, f: number) => toStr(enc(b, o, l, f)),
    "static decode(Ljava/lang/String;I)[B": (s: string) => { const c = strCodes(s); return dec(c, 0, c.length); },
    "static decode([BI)[B": (b: Int8Array) => dec(b, 0, b.length),
    "static decode([BIII)[B": (b: Int8Array, o: number, l: number) => dec(b, o, l),
  },
});

// The stream forms buffer and encode on close: base64 of a concatenation is not the
// concatenation of the base64s, so there is nothing to gain from emitting early, and the
// one-shot path keeps line wrapping and the tail padding in a single place.
class JB64OS extends JOutputStream { out: unknown = null; flags = 0; }
rt.register({
  name: "android/util/Base64OutputStream", ctor: JB64OS, sup: "java/io/FilterOutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;I)V": function (this: JB64OS, o: unknown, f: number) { this.out = o; this.flags = f; },
    "write(I)V": function (this: JB64OS, b: number) { this.chunks.push(b & 0xff); },
    "write([BII)V": function (this: JB64OS, b: Int8Array, o: number, l: number) {
      for (let i = 0; i < l; i++) this.chunks.push(b[o + i] & 0xff);
    },
    "flush()V": function (this: JB64OS) { return this.out ? vcall(this.out, "flush", "()V") : undefined; },
    "close()V": async function (this: JB64OS) {
      const body = toBytes(enc(Int8Array.from(this.chunks), 0, this.chunks.length, this.flags));
      this.chunks.length = 0;
      if (!this.out) return;
      await vcall(this.out, "write", "([BII)V", body, 0, body.length);
      await vcall(this.out, "flush", "()V");
      if (!(this.flags & NO_CLOSE)) await vcall(this.out, "close", "()V");
    },
  },
});
