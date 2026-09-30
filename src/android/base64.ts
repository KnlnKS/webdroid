// android.util.Base64. Not java.util.Base64: the flag word, the trailing newline and the
// 76-char wrapping are AOSP-specific and apps round-trip against them.

import { rt, JObj } from "../jvm/runtime";

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

/** AOSP's decoder: characters outside the alphabet are skipped, and padding is optional but
 *  must be well placed. `strict` is java.util.Base64's basic decoder, which rejects them instead. */
function dec(codes: ArrayLike<number>, off: number, len: number, strict = false): Int8Array {
  const out: number[] = [];
  let acc = 0, q = 0, padding = 0;                        // padding: '=' still expected (1) or done (2)
  const bad = () => rt.mkThrowable("java/lang/IllegalArgumentException", "bad base-64");
  for (let i = off; i < off + len; i++) {
    const c = codes[i] & 0xff, v = DEC[c];
    if (c === 61) {
      if (padding === 1) { padding = 2; continue; }
      if (padding || q < 2) throw bad();
      if (q === 2) { out.push((acc >> 4) & 0xff); padding = 1; }
      else { out.push((acc >> 10) & 0xff, (acc >> 2) & 0xff); padding = 2; }
      q = 0;
      continue;
    }
    if (v < 0) { if (strict) throw bad(); continue; }
    if (padding) throw bad();
    acc = (acc << 6) | v;
    if (++q === 4) { out.push((acc >> 16) & 0xff, (acc >> 8) & 0xff, acc & 0xff); acc = 0; q = 0; }
  }
  if (q === 1 || padding === 1) throw bad();
  if (q === 2) out.push((acc >> 4) & 0xff);
  else if (q === 3) out.push((acc >> 10) & 0xff, (acc >> 2) & 0xff);
  return new Int8Array(out);
}

/** a base64 String decodes from its char codes, as the byte[] forms decode from their bytes */
const decodeString = (s: string, strict = false): Int8Array => {
  const a = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return dec(a, 0, a.length, strict);
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
    "static decode(Ljava/lang/String;I)[B": (s: string) => decodeString(s),
    "static decode([BI)[B": (b: Int8Array) => dec(b, 0, b.length),
    "static decode([BIII)[B": (b: Int8Array, o: number, l: number) => dec(b, o, l),
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
    "decode(Ljava/lang/String;)[B": function (this: JB64Codec, s: string) { return decodeString(s, !(this.flags & CRLF)); },
    "decode([B)[B": function (this: JB64Codec, b: Int8Array) { return dec(b, 0, b.length, !(this.flags & CRLF)); },
  },
});
