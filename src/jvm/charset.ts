import { utf8, charsToString } from "./abi";
import { rt } from "./runtime";
import { SINGLE_BYTE_CHARSETS } from "./charset-tables";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, SURROGATE = /[\uD800-\uDFFF]/;

/** A charset served here, as the reference device's ICU converters report it. `unit` is the code
 *  unit width (1 byte covers UTF-8's variable width too); a marked charset (UTF-16, UTF-32) writes
 *  a byte-order mark in `little` order and reads either, defaulting to big-endian. */
export interface CharsetInfo {
  name: string; aliases: string[]; unit: 1 | 2 | 4; little: boolean; marked: boolean;
  /** the highest code point it encodes */
  max: number;
  replacement: number[]; maxBytes: number; averageBytes: number; averageChars: number;
  /** a single-byte charset's decoding, byte by byte (U+FFFD for a byte that maps to nothing) */
  table?: string;
  /** its bytes below 0x80 are ASCII */
  ascii?: boolean;
  encoding?: Map<number, number>;
}
/** the byte a table charset encodes `c` as, or -1 */
export function encodeByte(cs: CharsetInfo, c: number): number {
  if (!cs.table) return c <= cs.max ? c : -1;
  if (!cs.encoding) {
    cs.encoding = new Map();
    for (let b = 255; b >= 0; b--) if (cs.table.charCodeAt(b) !== 0xfffd) cs.encoding.set(cs.table.charCodeAt(b), b);
  }
  return cs.encoding.get(c) ?? -1;
}
const unicode = (name: string, unit: 2 | 4, little: boolean, marked: boolean, aliases: string[]): CharsetInfo => ({
  name, aliases, unit, little, marked, max: 0x10ffff, maxBytes: unit, averageBytes: unit, averageChars: 1 / unit,
  replacement: unit === 2 ? little ? [0xfd, 0xff] : [0xff, 0xfd] : little ? [0xfd, 0xff, 0, 0] : [0, 0, 0xff, 0xfd],
});
export const CHARSETS: readonly CharsetInfo[] = [
  { name: "UTF-8", aliases: ["windows-65001"], unit: 1, little: false, marked: false, max: 0x10ffff, replacement: [0x3f], maxBytes: 3, averageBytes: 2, averageChars: 1 / 3 },
  { name: "US-ASCII", aliases: ["ANSI_X3.4-1968", "csASCII", "cp367", "iso-ir-6", "ASCII", "iso_646.irv:1983", "ANSI_X3.4-1986", "ascii7", "windows-20127", "ISO_646.irv:1991", "ISO646-US", "IBM367", "646", "us"],
    unit: 1, little: false, marked: false, max: 0x7f, replacement: [0x3f], maxBytes: 1, averageBytes: 1, averageChars: 1 },
  { name: "ISO-8859-1", aliases: ["819", "l1", "ISO_8859-1:1987", "8859_1", "cp819", "latin1", "iso-ir-100", "ibm-819", "IBM819", "csISOLatin1"],
    unit: 1, little: false, marked: false, max: 0xff, replacement: [0x3f], maxBytes: 1, averageBytes: 1, averageChars: 1 },
  unicode("UTF-16", 2, false, true, ["ISO-10646-UCS-2"]),
  unicode("UTF-16BE", 2, false, false, ["x-utf-16be", "windows-1201", "UnicodeBigUnmarked"]),
  unicode("UTF-16LE", 2, true, false, ["x-utf-16le", "UnicodeLittleUnmarked", "windows-1200"]),
  unicode("UTF-32", 4, true, true, ["ISO-10646-UCS-4"]),
  unicode("UTF-32BE", 4, false, false, []),
  unicode("UTF-32LE", 4, true, false, []),
];
const served = new Set(CHARSETS.map((cs) => cs.name));
for (const [name, aliases, replacement, table] of SINGLE_BYTE_CHARSETS) if (!served.has(name)) {
  let ascii = true;
  for (let b = 0; b < 0x80 && ascii; b++) ascii = table.charCodeAt(b) === b;
  (CHARSETS as CharsetInfo[]).push({ name, aliases, unit: 1, little: false, marked: false, max: 0xffff, replacement,
    maxBytes: 1, averageBytes: 1, averageChars: 1, table, ascii });
}
// ICU matches names ignoring case, '-' and '_'
const key = (name: string) => name.replace(/[-_]/g, "").toUpperCase();
const byName = new Map(CHARSETS.flatMap((cs) => [cs.name, ...cs.aliases].map((n) => [key(n), cs] as const)));

/** the charset named by a string or a Charset, or UnsupportedEncodingException */
export function charsetInfo(value: unknown): CharsetInfo {
  const name = typeof value === "string" ? value : value && typeof value === "object" && "cname" in value ? value.cname : null;
  if (typeof name !== "string") throw rt.mkThrowable("java/lang/NullPointerException", "charset");
  const cs = byName.get(key(name));
  if (!cs) throw rt.mkThrowable("java/io/UnsupportedEncodingException", name);
  return cs;
}
export const charsetName = (value: unknown): string => charsetInfo(value).name;

export function encodeString(text: string, charset: unknown): Int8Array {
  const cs = charsetInfo(charset);
  if (cs.name === "UTF-8") return new Int8Array(utf8.enc.encode(SURROGATE.test(text) ? text.replace(LONE_SURROGATE, "?") : text).buffer);
  const { unit, little } = cs, bom = cs.marked && text.length ? unit : 0;
  const out = new Int8Array(text.length * unit + bom);
  const view = new DataView(out.buffer);
  if (bom === 2) view.setUint16(0, 0xfeff, little);
  else if (bom === 4) view.setUint32(0, 0xfeff, little);
  let pos = bom;
  for (const char of text) {
    const lone = char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff;
    if (unit === 4) { view.setUint32(pos, lone ? 0xfffd : char.codePointAt(0)!, little); pos += 4; }
    else if (unit === 2) for (let i = 0; i < char.length; i++, pos += 2) view.setUint16(pos, lone ? 0xfffd : char.charCodeAt(i), little);
    else {
      const b = encodeByte(cs, char.codePointAt(0)!);
      if (b >= 0) out[pos++] = b;
      else for (const r of cs.replacement) out[pos++] = r;
    }
  }
  return pos === out.length ? out : out.slice(0, pos);
}

export function decodeString(bytes: Int8Array | Uint8Array, charset: unknown): string {
  const cs = charsetInfo(charset);
  if (cs.name === "UTF-8") return utf8.dec.decode(bytes);
  const { unit } = cs, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0, little = !cs.marked && cs.little;
  if (cs.marked && bytes.length >= unit) {
    const bom = unit === 2 ? view.getUint16(0) : view.getUint32(0);
    if (bom === 0xfeff || bom === (unit === 2 ? 0xfffe : 0xfffe0000)) { start = unit; little = bom !== 0xfeff; }
  }
  if (unit === 4) {
    let text = "";
    for (let pos = start; pos < bytes.length; pos += 4) {
      const cp = pos + 4 <= bytes.length ? view.getUint32(pos, little) : -1;
      text += cp < 0 || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff ? "\ufffd" : String.fromCodePoint(cp);
    }
    return text;
  }
  const chars = new Uint16Array(Math.ceil((bytes.length - start) / unit));
  for (let i = 0, pos = start; i < chars.length; i++, pos += unit) {
    const cp = unit === 2 ? pos + 1 < bytes.length ? view.getUint16(pos, little) : 0xfffd : bytes[pos] & 255;
    chars[i] = cs.table ? cs.table.charCodeAt(cp) : cp > cs.max ? 0xfffd : cp;
  }
  const text = charsToString(chars, 0, chars.length);
  return unit === 2 ? text.replace(LONE_SURROGATE, "\ufffd") : text;
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
