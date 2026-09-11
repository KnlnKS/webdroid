import { utf8, charsToString } from "./abi";
import { rt } from "./runtime";

function charsetName(value: unknown): string {
  const name = typeof value === "string" ? value : value && typeof value === "object" && "cname" in value ? value.cname : null;
  if (typeof name !== "string") throw rt.mkThrowable("java/lang/NullPointerException", "charset");
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
  if (name === "UTF-8") return new Int8Array(utf8.enc.encode(text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "?")).buffer);
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
  return wide ? text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\ufffd") : text;
}
