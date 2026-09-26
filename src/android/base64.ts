// android.util.Base64. Not java.util.Base64: the flag word, the trailing newline and the
// 76-char wrapping are AOSP-specific and apps round-trip against them.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
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

function enc(input: Int8Array, off: number, len: number, flags: number): Int8Array {
  const tab = flags & URL_SAFE ? WEB : STD;
  const pad = !(flags & NO_PADDING), wrap = !(flags & NO_WRAP), crlf = (flags & CRLF) !== 0;
  if (len <= 0) return new Int8Array(0);
  const rem = len % 3;
  const size = Math.ceil(len / 3) * 4 - (!pad && rem ? 3 - rem : 0);
  const out = new Int8Array(size + (wrap ? Math.ceil(len / 57) * (crlf ? 2 : 1) : 0));
  let at = 0, groups = 0, i = off;
  const end = off + len;
  for (; i + 2 < end; i += 3) {
    const w = ((input[i] & 0xff) << 16) | ((input[i + 1] & 0xff) << 8) | (input[i + 2] & 0xff);
    out[at++] = tab.charCodeAt((w >> 18) & 63);
    out[at++] = tab.charCodeAt((w >> 12) & 63);
    out[at++] = tab.charCodeAt((w >> 6) & 63);
    out[at++] = tab.charCodeAt(w & 63);
    // AOSP wraps every 19 three-byte groups, i.e. every 76 output characters.
    if (wrap && ++groups === 19) {
      if (crlf) out[at++] = 13;
      out[at++] = 10; groups = 0;
    }
  }
  if (rem) {
    const w = ((input[i] & 0xff) << 16) | (rem === 2 ? (input[i + 1] & 0xff) << 8 : 0);
    out[at++] = tab.charCodeAt((w >> 18) & 63);
    out[at++] = tab.charCodeAt((w >> 12) & 63);
    if (rem === 2) out[at++] = tab.charCodeAt((w >> 6) & 63);
    else if (pad) out[at++] = 61;
    if (pad) out[at++] = 61;
  }
  // AOSP also terminates a nonempty final line with the selected line separator.
  if (wrap && (groups || rem)) {
    if (crlf) out[at++] = 13;
    out[at] = 10;
  }
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
const ascii = new TextDecoder();

rt.register({
  name: "android/util/Base64",
  ctor: class extends JObj {},
  statics: { DEFAULT, NO_PADDING, NO_WRAP, CRLF, URL_SAFE, NO_CLOSE },
  methods: {
    "static encode([BI)[B": (b: Int8Array, f: number) => enc(b, 0, b.length, f),
    "static encode([BIII)[B": (b: Int8Array, o: number, l: number, f: number) => enc(b, o, l, f),
    "static encodeToString([BI)Ljava/lang/String;": (b: Int8Array, f: number) => ascii.decode(enc(b, 0, b.length, f)),
    "static encodeToString([BIII)Ljava/lang/String;":
      (b: Int8Array, o: number, l: number, f: number) => ascii.decode(enc(b, o, l, f)),
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
    "close()V": driven(function* (this: JB64OS): Gen {
      const body = enc(Int8Array.from(this.chunks), 0, this.chunks.length, this.flags);
      this.chunks.length = 0;
      if (!this.out) return;
      yield vcall(this.out, "write", "([BII)V", body, 0, body.length);
      yield vcall(this.out, "flush", "()V");
      if (!(this.flags & NO_CLOSE)) yield vcall(this.out, "close", "()V");
    }),
  },
});

// java.util.Base64: the same codec behind the fixed-flag Encoder/Decoder pairs it hands out
class JB64Codec extends JObj { flags = NO_WRAP; }
const codec = (flags: number) => { const c = new JB64Codec(); c.flags = flags; return c; };
rt.register({
  name: "java/util/Base64", ctor: class extends JObj {},
  methods: {
    "static getEncoder()Ljava/util/Base64$Encoder;": () => codec(NO_WRAP),
    "static getUrlEncoder()Ljava/util/Base64$Encoder;": () => codec(NO_WRAP | URL_SAFE),
    "static getMimeEncoder()Ljava/util/Base64$Encoder;": () => codec(CRLF),
    "static getDecoder()Ljava/util/Base64$Decoder;": () => codec(NO_WRAP),
    "static getUrlDecoder()Ljava/util/Base64$Decoder;": () => codec(NO_WRAP | URL_SAFE),
    "static getMimeDecoder()Ljava/util/Base64$Decoder;": () => codec(CRLF),
  },
});
rt.register({
  name: "java/util/Base64$Encoder", ctor: JB64Codec,
  methods: {
    "encodeToString([B)Ljava/lang/String;": function (this: JB64Codec, b: Int8Array) { return ascii.decode(enc(b, 0, b.length, this.flags)); },
    "encode([B)[B": function (this: JB64Codec, b: Int8Array) { return enc(b, 0, b.length, this.flags); },
    "withoutPadding()Ljava/util/Base64$Encoder;": function (this: JB64Codec) { return codec(this.flags | NO_PADDING); },
  },
});
rt.register({
  name: "java/util/Base64$Decoder", ctor: JB64Codec,
  methods: {
    "decode(Ljava/lang/String;)[B": (s: string) => { const c = strCodes(s); return dec(c, 0, c.length); },
    "decode([B)[B": (b: Int8Array) => dec(b, 0, b.length),
  },
});
