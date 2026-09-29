import { utf8, charsToString, concat } from "./abi";
import { rt } from "./runtime";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, SURROGATE = /[\uD800-\uDFFF]/;

export function charsetName(value: unknown): string {
  const name = typeof value === "string" ? value : value && typeof value === "object" && "cname" in value ? value.cname : null;
  if (typeof name !== "string") throw rt.mkThrowable("java/lang/NullPointerException", "charset");
  if (name === "UTF-8") return name;
  switch (name.replace(/[-_]/g, "").toUpperCase()) {
    case "UTF8": return "UTF-8";
    case "ISO88591": case "LATIN1": case "L1": return "ISO-8859-1";
    case "USASCII": case "ASCII": return "US-ASCII";
    case "UTF16": return "UTF-16";
    case "UTF16BE": return "UTF-16BE";
    case "UTF16LE": return "UTF-16LE";
    default: throw rt.mkThrowable("java/io/UnsupportedEncodingException", name);
  }
}

export function encodeString(text: string, charset: unknown): Int8Array {
  const name = charsetName(charset);
  if (name === "UTF-8") return new Int8Array(utf8.enc.encode(SURROGATE.test(text) ? text.replace(LONE_SURROGATE, "?") : text).buffer);
  const wide = name.startsWith("UTF-16"), bom = name === "UTF-16" ? 2 : 0;
  const out = new Int8Array(text.length * (wide ? 2 : 1) + bom);
  const view = new DataView(out.buffer);
  if (bom) view.setUint16(0, 0xfeff);
  let pos = bom;
  for (const char of text) {
    if (wide) {
      for (let i = 0; i < char.length; i++, pos += 2) {
        const cp = char.charCodeAt(i);
        view.setUint16(pos, char.length === 1 && cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp, name === "UTF-16LE");
      }
    } else {
      const cp = char.codePointAt(0)!;
      out[pos++] = cp <= (name === "US-ASCII" ? 127 : 255) ? cp : 63;
    }
  }
  return pos === out.length ? out : out.slice(0, pos);
}

export function decodeString(bytes: Int8Array | Uint8Array, charset: unknown): string {
  const name = charsetName(charset);
  if (name === "UTF-8") return utf8.dec.decode(bytes);
  const wide = name.startsWith("UTF-16");
  let start = 0, little = name === "UTF-16LE";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (name === "UTF-16" && bytes.length >= 2) {
    const bom = view.getUint16(0);
    if (bom === 0xfeff || bom === 0xfffe) { start = 2; little = bom === 0xfffe; }
  }
  const chars = new Uint16Array(Math.ceil((bytes.length - start) / (wide ? 2 : 1)));
  for (let i = 0, pos = start; i < chars.length; i++, pos += wide ? 2 : 1) {
    const cp = wide ? pos + 1 < bytes.length ? view.getUint16(pos, little) : 0xfffd : bytes[pos] & 255;
    chars[i] = name === "US-ASCII" && cp > 127 ? 0xfffd : cp;
  }
  const text = charsToString(chars, 0, chars.length);
  return wide ? text.replace(LONE_SURROGATE, "\ufffd") : text;
}

export type StreamDecoder = { decode(bytes?: Uint8Array, options?: { stream: boolean }): string };
/** an incremental decoder for a Java charset; single-byte Latin-1 and ASCII need no state, and
 *  WHATWG's labels for them mean windows-1252 */
export function streamDecoder(charset: unknown): StreamDecoder {
  const name = charsetName(charset);
  if (name === "ISO-8859-1" || name === "US-ASCII") return { decode: (bytes) => bytes ? decodeString(bytes, name) : "" };
  if (name === "UTF-8") return new TextDecoder();
  // UTF-16BE/LE keep a leading U+FEFF as decodeString does
  if (name !== "UTF-16") return new TextDecoder(name.toLowerCase(), { ignoreBOM: true });
  // Java's UTF-16 takes the byte order from either mark, big-endian without one
  let inner: TextDecoder | null = null, head = new Uint8Array(0);
  return { decode(bytes, options) {
    if (inner) return inner.decode(bytes, options);
    if (bytes) head = concat([head, bytes]);
    if (head.length < 2 && options?.stream) return "";
    inner = new TextDecoder(head[0] === 0xff && head[1] === 0xfe ? "utf-16le" : "utf-16be");
    return inner.decode(head, options);
  } };
}

export function encodeModifiedUtf8(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 0 && c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
    else bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  return Uint8Array.from(bytes);
}
