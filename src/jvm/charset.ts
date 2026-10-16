// The charsets served here, and their converters as ICU's behave on the reference device: libcore's
// CharsetICU codecs reach them through NativeConverter (jnio.ts), and String's encode and decode
// (a VM built-in) through encodeString/decodeString. The single-byte tables are the device's.
import { utf8, charsToString } from "./abi.ts";
import { rt, declaredField } from "./runtime.ts";
import { SINGLE_BYTE_CHARSETS } from "./charset-tables.ts";

type Kind = "utf8" | "utf16" | "utf32" | "ascii" | "latin1" | "table";
/** A charset's converter model: `little` is its byte order, and a marked charset (UTF-16, UTF-32)
 *  writes a byte-order mark in that order and reads either, defaulting to big-endian. */
interface CharsetInfo {
  name: string;
  /** as aliases() iterates them on the device, the name among them */
  aliases: string[];
  kind: Kind; little: boolean; marked: boolean;
  replacement: number[]; maxBytes: number; averageBytes: number; averageChars: number;
  /** a table charset's decoding, byte by byte (U+FFFD for a byte that maps to nothing) */
  table?: string;
  /** a table charset's bytes whose character does not encode back to them */
  oneWay?: number[];
  encoding?: Map<number, number>;
}
const unicode = (name: string, kind: "utf16" | "utf32", little: boolean, marked: boolean, aliases: string[]): CharsetInfo => {
  const unit = kind === "utf16" ? 2 : 4;
  return { name, aliases, kind, little, marked, maxBytes: unit, averageBytes: unit, averageChars: 1 / unit,
    replacement: unit === 2 ? little ? [0xfd, 0xff] : [0xff, 0xfd] : little ? [0xfd, 0xff, 0, 0] : [0, 0, 0xff, 0xfd] };
};
const byteWide = (name: string, kind: Kind, aliases: string[]): CharsetInfo =>
  ({ name, aliases, kind, little: false, marked: false, replacement: [0x3f], maxBytes: 1, averageBytes: 1, averageChars: 1 });
export const CHARSETS: readonly CharsetInfo[] = [
  { ...byteWide("UTF-8", "utf8", ["windows-65001", "UTF-8"]), maxBytes: 3, averageBytes: 2, averageChars: 1 / 3 },
  byteWide("US-ASCII", "ascii", ["ANSI_X3.4-1968", "csASCII", "cp367", "iso-ir-6", "ASCII", "iso_646.irv:1983", "ANSI_X3.4-1986", "US-ASCII",
    "ascii7", "windows-20127", "ISO_646.irv:1991", "ISO646-US", "IBM367", "646", "us"]),
  byteWide("ISO-8859-1", "latin1", ["819", "ISO-8859-1", "l1", "ISO_8859-1:1987", "8859_1", "cp819", "latin1", "iso-ir-100", "ibm-819", "IBM819", "csISOLatin1"]),
  unicode("UTF-16", "utf16", false, true, ["ISO-10646-UCS-2", "UTF-16"]),
  unicode("UTF-16BE", "utf16", false, false, ["x-utf-16be", "UTF-16BE", "windows-1201", "UnicodeBigUnmarked"]),
  unicode("UTF-16LE", "utf16", true, false, ["x-utf-16le", "UnicodeLittleUnmarked", "windows-1200", "UTF-16LE"]),
  unicode("UTF-32", "utf32", true, true, ["UTF-32", "ISO-10646-UCS-4"]),
  unicode("UTF-32BE", "utf32", false, false, ["UTF-32BE"]),
  unicode("UTF-32LE", "utf32", true, false, ["UTF-32LE"]),
];
const served = new Set(CHARSETS.map((cs) => cs.name));
for (const [name, aliases, replacement, table, oneWay] of SINGLE_BYTE_CHARSETS)
  if (!served.has(name)) (CHARSETS as CharsetInfo[]).push({ ...byteWide(name, "table", aliases), replacement, table, oneWay });
// ICU matches names ignoring case, '-' and '_'
const key = (name: string) => name.replace(/[-_]/g, "").toUpperCase();
const byName = new Map(CHARSETS.flatMap((cs) => [cs.name, ...cs.aliases].map((n) => [key(n), cs] as const)));
// each name as a caller spells it: String and ZipCoder name their charset per call
const spelled = new Map<string, CharsetInfo | null>();
export function charsetNamed(name: string): CharsetInfo | null {
  let cs = spelled.get(name);
  if (cs === undefined) {
    cs = byName.get(key(name)) ?? null;
    if (spelled.size < 1024) spelled.set(name, cs);
  }
  return cs;
}

let charsetName: string | undefined, lastCharset: unknown, lastInfo: CharsetInfo;
/** the charset named by a string or a Charset, or UnsupportedEncodingException */
function charsetInfo(value: unknown): CharsetInfo {
  // the last one answers again without the name's keyed load and lookup
  if (value === lastCharset) return lastInfo;
  const name = typeof value === "string" ? value : value && typeof value === "object"
    ? (value as Record<string, unknown>)[charsetName ??= declaredField("java/nio/charset/Charset", "name")] : null;
  if (typeof name !== "string") throw rt.mkThrowable("java/lang/NullPointerException", "charset");
  const cs = charsetNamed(name);
  if (!cs) throw rt.mkThrowable("java/io/UnsupportedEncodingException", name);
  lastCharset = value;
  return lastInfo = cs;
}

/** the byte a table charset encodes `c` as, or -1 */
function tableByte(cs: CharsetInfo, c: number): number {
  if (!cs.encoding) {
    cs.encoding = new Map();
    for (let b = 0; b < 256; b++) if (cs.table!.charCodeAt(b) !== 0xfffd && !cs.oneWay!.includes(b)) cs.encoding.set(cs.table!.charCodeAt(b), b);
  }
  return cs.encoding.get(c) ?? -1;
}
/** the byte a byte-wide charset encodes `c` as, or -1 */
const byteOf = (cs: CharsetInfo, c: number) => cs.kind === "ascii" ? c < 0x80 ? c : -1 : cs.kind === "latin1" ? c < 0x100 ? c : -1 : tableByte(cs, c);
const isUnicode = (cs: CharsetInfo) => cs.kind === "utf8" || cs.kind === "utf16" || cs.kind === "utf32";
/** ICU's containsAll over the charsets' round-trip sets (Charset.contains) */
export function covers(a: CharsetInfo, b: CharsetInfo): boolean {
  if (isUnicode(a)) return true;
  if (isUnicode(b)) return false;
  for (let c = 0; c < 256; c++) {
    const ch = b.kind === "table" ? tableByte(b, b.table!.charCodeAt(c)) >= 0 ? b.table!.charCodeAt(c) : -1 : byteOf(b, c) >= 0 ? c : -1;
    if (ch >= 0 && byteOf(a, ch) < 0) return false;
  }
  return true;
}

// ICU's UErrorCodes the codecs report
export const U_ZERO_ERROR = 0, U_INVALID_CHAR_FOUND = 10, U_TRUNCATED_CHAR_FOUND = 11, U_ILLEGAL_CHAR_FOUND = 12, U_BUFFER_OVERFLOW_ERROR = 15;
/** CodingErrorAction as NativeConverter numbers them */
const REPORT = 0, IGNORE = 1, REPLACE = 2;
const UTF8_BYTES = new Uint8Array(256);
for (let b = 0xc2; b <= 0xf4; b++) UTF8_BYTES[b] = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
/** the range UTF-8's second byte may take after `lead` (maximal subparts, as ICU and WHATWG) */
const secondOk = (lead: number, b: number) =>
  lead === 0xe0 ? b >= 0xa0 && b <= 0xbf : lead === 0xed ? b >= 0x80 && b <= 0x9f : lead === 0xf0 ? b >= 0x90 && b <= 0xbf
    : lead === 0xf4 ? b >= 0x80 && b <= 0x8f : (b & 0xc0) === 0x80;
const INVALID = -1, NEED_MORE = -2, MARK = -3;

/** One ICU UConverter: its partial input, pending output and callbacks. decode/encode convert
 *  [sp, sEnd) into [dp, dEnd) as ucnv_toUnicode/ucnv_fromUnicode do, and report the positions
 *  they reached and ICU's error code; `invalid` counts the units of the last error. */
export class Converter {
  /** a sequence's bytes read so far (ICU's toUBytes) */
  readonly cs: CharsetInfo;
  private partial: number[] = [];
  private endian: boolean | null = null;
  /** output that did not fit (ICU's error buffers), written first by the next call */
  private chars: number[] = [];
  private bytes: number[] = [];
  private lead = 0;
  private marked = false;
  invalid = 0;
  sp = 0;
  dp = 0;
  onMalformed = REPORT; onUnmappable = REPORT;
  subChars = "\ufffd";
  subBytes: ArrayLike<number>;
  constructor(cs: CharsetInfo) { this.cs = cs; this.subBytes = cs.replacement; }
  resetToUnicode(): void { this.partial.length = 0; this.endian = null; this.chars.length = 0; this.invalid = 0; }
  resetFromUnicode(): void { this.lead = 0; this.marked = false; this.bytes.length = 0; this.invalid = 0; }

  decode(src: ArrayLike<number>, sp: number, sEnd: number, dst: Uint16Array, dp: number, dEnd: number, flush: boolean): number {
    const { kind, table } = this.cs, chars = this.chars, partial = this.partial;
    let code = U_ZERO_ERROR;
    for (;;) {
      while (chars.length) {
        if (dp >= dEnd) { code = U_BUFFER_OVERFLOW_ERROR; break; }
        dst[dp++] = chars.shift()!;
      }
      if (code) break;
      if (!partial.length) {
        // the common case: whole characters straight from the source
        if (kind === "utf8") while (sp < sEnd && dp < dEnd) {
          const b = src[sp] & 255;
          if (b < 0x80) { dst[dp++] = b; sp++; continue; }
          // whole two- and three-byte sequences; the rest take the general path
          if (b >= 0xc2 && b < 0xe0 && sp + 1 < sEnd) {
            const c = src[sp + 1] & 255;
            if ((c & 0xc0) !== 0x80) break;
            dst[dp++] = (b & 0x1f) << 6 | c & 63; sp += 2; continue;
          }
          if (b >= 0xe0 && b < 0xf0 && sp + 2 < sEnd) {
            const c = src[sp + 1] & 255, d = src[sp + 2] & 255;
            if (!secondOk(b, c) || (d & 0xc0) !== 0x80) break;
            dst[dp++] = (b & 15) << 12 | (c & 63) << 6 | d & 63; sp += 3; continue;
          }
          break;
        }
        else if (kind === "ascii") while (sp < sEnd && dp < dEnd) { const b = src[sp] & 255; if (b >= 0x80) break; dst[dp++] = b; sp++; }
        else if (kind === "latin1") while (sp < sEnd && dp < dEnd) dst[dp++] = src[sp++] & 255;
        else if (table) while (sp < sEnd && dp < dEnd) { const c = table.charCodeAt(src[sp] & 255); if (c === 0xfffd) break; dst[dp++] = c; sp++; }
      }
      if (sp >= sEnd) {
        if (!flush || !partial.length) break;
        // a sequence the end of input cut short
        const n = partial.length;
        partial.length = 0;
        if (this.decodeError(true, n)) { code = U_TRUNCATED_CHAR_FOUND; break; }
        dp = this.substitute(dst, dp, dEnd);
        continue;
      }
      if (dp >= dEnd) { code = U_BUFFER_OVERFLOW_ERROR; break; }
      // one character, or one invalid sequence, from the partial bytes and the source
      let cp: number;
      if (partial.length) {
        const np = partial.length, buf = partial.slice();
        for (let k = sp; k < sEnd && k < sp + 4; k++) buf.push(src[k] & 255);
        cp = this.step(buf, 0, buf.length);
        if (cp !== NEED_MORE) { const taken = Math.min(this.len, np); partial.splice(0, taken); sp += this.len - taken; }
      } else {
        cp = this.step(src, sp, sEnd);
        if (cp !== NEED_MORE) sp += this.len;
      }
      if (cp === NEED_MORE) { while (sp < sEnd) partial.push(src[sp++] & 255); continue; }
      if (cp === MARK) continue;
      if (cp === INVALID) {
        if (this.decodeError(this.illegal, this.len)) { code = this.illegal ? U_ILLEGAL_CHAR_FOUND : U_INVALID_CHAR_FOUND; break; }
        dp = this.substitute(dst, dp, dEnd);
      } else if (cp > 0xffff) {
        dst[dp++] = 0xd7c0 + (cp >> 10);
        if (dp < dEnd) dst[dp++] = 0xdc00 | cp & 0x3ff; else chars.push(0xdc00 | cp & 0x3ff);
      } else dst[dp++] = cp;
      if (chars.length) { code = U_BUFFER_OVERFLOW_ERROR; break; }
    }
    this.sp = sp; this.dp = dp;
    return code;
  }
  private len = 0;
  private illegal = false;
  /** the character at buf[i], `len` bytes long; INVALID for an invalid sequence of `len` bytes
   *  (`illegal` unless it is only unmapped), NEED_MORE for a valid prefix buf ends inside, MARK for
   *  a byte-order mark */
  private step(buf: ArrayLike<number>, i: number, end: number): number {
    const cs = this.cs, kind = cs.kind, b0 = buf[i] & 255;
    this.len = 1; this.illegal = true;
    switch (kind) {
      case "utf8": {
        if (b0 < 0x80) return b0;
        const need = UTF8_BYTES[b0];
        if (!need) return INVALID;
        let k = 1;
        for (; k < need && i + k < end; k++) {
          const b = buf[i + k] & 255;
          if (!(k === 1 ? secondOk(b0, b) : (b & 0xc0) === 0x80)) break;
        }
        if (k < need) { if (i + k >= end) return NEED_MORE; this.len = k; return INVALID; }
        let cp = b0 & (0xff >> (need + 1));
        for (k = 1; k < need; k++) cp = cp << 6 | buf[i + k] & 63;
        this.len = need;
        return cp;
      }
      case "utf16": case "utf32": {
        const unit = kind === "utf16" ? 2 : 4;
        if (end - i < unit) return NEED_MORE;
        if (this.endian === null) {
          this.endian = !cs.marked && cs.little;
          if (cs.marked) {
            const be = unit === 2 ? b0 << 8 | buf[i + 1] & 255 : (b0 << 24 | (buf[i + 1] & 255) << 16 | (buf[i + 2] & 255) << 8 | buf[i + 3] & 255) >>> 0;
            if (be === 0xfeff || be === (unit === 2 ? 0xfffe : 0xfffe0000)) { this.endian = be !== 0xfeff; this.len = unit; return MARK; }
          }
        }
        const u = this.unit(buf, i, unit);
        this.len = unit;
        if (unit === 4) return u <= 0x10ffff && (u < 0xd800 || u > 0xdfff) ? u : INVALID;
        if (u < 0xd800 || u > 0xdfff) return u;
        if (u > 0xdbff) return INVALID;
        if (end - i < 4) return NEED_MORE;
        const v = this.unit(buf, i + 2, 2);
        if (v < 0xdc00 || v > 0xdfff) return INVALID;
        this.len = 4;
        return 0x10000 + ((u - 0xd800) << 10) + v - 0xdc00;
      }
      case "ascii": return b0 < 0x80 ? b0 : INVALID;
      case "latin1": return b0;
      default: {
        const c = cs.table!.charCodeAt(b0);
        if (c !== 0xfffd) return c;
        this.illegal = false;
        return INVALID;
      }
    }
  }
  private unit(buf: ArrayLike<number>, i: number, size: number): number {
    let u = 0;
    for (let k = 0; k < size; k++) u = u << 8 | buf[i + (this.endian ? size - 1 - k : k)] & 255;
    return u >>> 0;
  }
  /** an invalid sequence of n bytes: true when it is to be reported */
  private decodeError(illegal: boolean, n: number): boolean {
    const action = illegal ? this.onMalformed : this.onUnmappable;
    this.invalid = n;
    this.skip = action === IGNORE;
    return action === REPORT;
  }
  private skip = false;
  /** the decoder's replacement, unless the error is ignored; what does not fit waits */
  private substitute(dst: Uint16Array, dp: number, dEnd: number): number {
    if (this.skip) return dp;
    for (let i = 0; i < this.subChars.length; i++) { const c = this.subChars.charCodeAt(i); if (dp < dEnd) dst[dp++] = c; else this.chars.push(c); }
    return dp;
  }

  encode(src: ArrayLike<number>, sp: number, sEnd: number, dst: Int8Array | Uint8Array, dp: number, dEnd: number, flush: boolean): number {
    const cs = this.cs, pending = this.bytes, kind = cs.kind;
    const finish = (code: number) => { this.sp = sp; this.dp = dp; return code; };
    while (pending.length) {
      if (dp >= dEnd) return finish(U_BUFFER_OVERFLOW_ERROR);
      dst[dp++] = pending.shift()!;
    }
    const put = (b: number) => { if (dp < dEnd) dst[dp++] = b; else pending.push(b & 255); };
    const unit = (u: number, size: number) => { for (let i = 0; i < size; i++) put(u >>> 8 * (cs.little ? i : size - 1 - i)); };
    const size = kind === "utf16" ? 2 : 4;
    if (cs.marked && !this.marked && (sp < sEnd || this.lead)) {
      this.marked = true;
      unit(0xfeff, size);
      if (pending.length || dp >= dEnd && sp < sEnd) return finish(U_BUFFER_OVERFLOW_ERROR);
    }
    for (;;) {
      if (!this.lead && (kind === "utf8" || kind === "ascii" || kind === "latin1")) while (sp < sEnd && dp < dEnd) { const c = src[sp]; if (c >= 0x80) break; dst[dp++] = c; sp++; }
      if (sp >= sEnd) {
        if (!flush || !this.lead) return finish(U_ZERO_ERROR);
        this.lead = 0;
        // ICU's skip callback does not skip a truncated sequence
        if (this.onMalformed === IGNORE) { this.invalid = 1; return finish(U_TRUNCATED_CHAR_FOUND); }
        const code = this.onEncodeError(true, 1, U_TRUNCATED_CHAR_FOUND, put);
        if (code >= 0) return finish(code);
        return finish(pending.length ? U_BUFFER_OVERFLOW_ERROR : U_ZERO_ERROR);
      }
      if (dp >= dEnd) return finish(U_BUFFER_OVERFLOW_ERROR);
      let cp = src[sp], len = 1, illegal = false, bad = false;
      if (this.lead) {
        // a lead surrogate the previous call ended on
        if (cp >= 0xdc00 && cp <= 0xdfff) { cp = 0x10000 + ((this.lead - 0xd800) << 10) + cp - 0xdc00; sp++; len = 2; }
        else { bad = illegal = true; len = 1; cp = -1; }
        this.lead = 0;
        if (bad) {
          const code = this.onEncodeError(true, 1, U_ILLEGAL_CHAR_FOUND, put);
          if (code >= 0) return finish(code);
          if (pending.length) return finish(U_BUFFER_OVERFLOW_ERROR);
          continue;
        }
      } else if (cp >= 0xd800 && cp <= 0xdbff) {
        if (sp + 1 >= sEnd) { this.lead = cp; sp++; continue; }
        const low = src[sp + 1];
        if (low >= 0xdc00 && low <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00; len = 2; sp += 2; }
        else { bad = illegal = true; sp++; }
      } else if (cp >= 0xdc00 && cp <= 0xdfff) { bad = illegal = true; sp++; }
      else sp++;
      if (!bad) {
        if (kind === "utf8") {
          if (cp < 0x80) put(cp);
          else if (cp < 0x800) { put(0xc0 | cp >> 6); put(0x80 | cp & 63); }
          else if (cp < 0x10000) { put(0xe0 | cp >> 12); put(0x80 | cp >> 6 & 63); put(0x80 | cp & 63); }
          else { put(0xf0 | cp >> 18); put(0x80 | cp >> 12 & 63); put(0x80 | cp >> 6 & 63); put(0x80 | cp & 63); }
        } else if (kind === "utf32") unit(cp, 4);
        else if (kind === "utf16") { if (cp > 0xffff) { unit(0xd7c0 + (cp >> 10), 2); unit(0xdc00 | cp & 0x3ff, 2); } else unit(cp, 2); }
        else { const b = byteOf(cs, cp); if (b >= 0) put(b); else bad = true; }
      }
      if (bad) {
        const code = this.onEncodeError(illegal, illegal ? 1 : len, illegal ? U_ILLEGAL_CHAR_FOUND : U_INVALID_CHAR_FOUND, put);
        if (code >= 0) return finish(code);
      }
      if (pending.length) return finish(U_BUFFER_OVERFLOW_ERROR);
    }
  }
  private onEncodeError(illegal: boolean, n: number, code: number, put: (b: number) => void): number {
    const action = illegal ? this.onMalformed : this.onUnmappable;
    if (action === REPORT) { this.invalid = n; return code; }
    if (action === REPLACE) for (let i = 0; i < this.subBytes.length; i++) put(this.subBytes[i]);
    return -1;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, SURROGATE = /[\uD800-\uDFFF]/;
// a short ASCII string skips TextEncoder and TextDecoder, whose per-call cost is several times its
// own (zip entry names, each encoded and decoded as ZipFile reads its directory)
const SHORT = 64;
function asciiBytes(text: string): Int8Array | null {
  const n = text.length;
  if (n > SHORT) return null;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) { const c = text.charCodeAt(i); if (c >= 0x80) return null; out[i] = c; }
  return out;
}
// fromCharCode over a plain array costs a fraction of what it does over a typed array view
const ASCII_UNITS = Array.from({ length: SHORT + 1 }, (_, n) => new Array<number>(n).fill(0));
function asciiText(bytes: Int8Array | Uint8Array, off: number, n: number): string | null {
  const units = ASCII_UNITS[n];
  for (let i = 0; i < n; i++) { const b = bytes[off + i]; if ((b & 0x80) !== 0) return null; units[i] = b; }
  return Reflect.apply(String.fromCharCode, null, units) as string;
}
/** String.getBytes: CharsetUtils' fast paths replace each unencodable char with '?', the rest
 *  encode as the charset's encoder does with REPLACE */
export function encodeString(text: string, charset: unknown): Int8Array {
  const cs = charsetInfo(charset);
  if (cs.kind === "utf8") return asciiBytes(text) ?? new Int8Array(utf8.enc.encode(SURROGATE.test(text) ? text.replace(LONE_SURROGATE, "?") : text).buffer);
  const n = text.length;
  if (cs.kind === "ascii" || cs.kind === "latin1") {
    const out = new Int8Array(n), max = cs.kind === "ascii" ? 0x7f : 0xff;
    for (let i = 0; i < n; i++) { const c = text.charCodeAt(i); out[i] = c > max ? 0x3f : c; }
    return out;
  }
  const units = new Uint16Array(n);
  for (let i = 0; i < n; i++) units[i] = text.charCodeAt(i);
  // String's own UTF-16BE path copies the units, lone surrogates included
  if (cs.name === "UTF-16BE") { const out = new Int8Array(n * 2); for (let i = 0; i < n; i++) { out[2 * i] = units[i] >> 8; out[2 * i + 1] = units[i]; } return out; }
  const conv = replacing(cs);
  return whole(n, cs.averageBytes, Int8Array, (out, dp, flush, sp) => conv.encode(units, sp, n, out, dp, out.length, flush), conv, () => conv.resetFromUnicode());
}
/** new String(bytes, charset): StringFactory's UTF-8, ISO-8859-1 and US-ASCII fast paths, else
 *  Charset.decode */
export function decodeString(bytes: Int8Array | Uint8Array, charset: unknown, off = 0, n = bytes.length): string {
  const cs = charsetInfo(charset);
  if (cs.kind === "utf8") return (n <= SHORT ? asciiText(bytes, off, n) : null) ?? utf8.dec.decode(bytes.subarray(off, off + n));
  if (cs.kind === "latin1" || cs.kind === "ascii") {
    const chars = new Uint16Array(n);
    for (let i = 0; i < n; i++) { const b = bytes[off + i] & 255; chars[i] = cs.kind === "ascii" && b > 0x7f ? 0xfffd : b; }
    return charsToString(chars, 0, n);
  }
  const conv = replacing(cs), src = bytes.subarray(off, off + n);
  const chars = whole(n, cs.averageChars, Uint16Array, (out, dp, flush, sp) => conv.decode(src, sp, n, out, dp, out.length, flush), conv, () => conv.resetToUnicode());
  return charsToString(chars, 0, chars.length);
}
const replacing = (cs: CharsetInfo) => { const conv = new Converter(cs); conv.onMalformed = conv.onUnmappable = REPLACE; return conv; };
/** Charset.decode/encode as CharsetDecoder.decode(ByteBuffer) and CharsetEncoder.encode(CharBuffer)
 *  run them: output sized from the average, grown to 2n + 1 on overflow, and each flush resetting
 *  the converter (CharsetICU's implFlush), so output a flush could not fit is dropped */
function whole<T extends Int8Array | Uint16Array>(length: number, average: number, Out: new (n: number) => T,
  step: (out: T, dp: number, flush: boolean, sp: number) => number, conv: Converter, reset: () => void): T {
  let n = Math.trunc(length * Math.fround(average)), out = new Out(n), dp = 0, sp = 0;
  if (!n && !length) return out;
  for (;;) {
    let code = U_ZERO_ERROR;
    if (sp < length) { code = step(out, dp, false, sp); sp = conv.sp; dp = conv.dp; }
    if (code === U_ZERO_ERROR) { code = step(out, dp, true, length); dp = conv.dp; reset(); }
    if (code === U_ZERO_ERROR) return out.subarray(0, dp) as T;
    n = 2 * n + 1;
    const grown = new Out(n);
    grown.set(out.subarray(0, dp));
    out = grown;
  }
}

