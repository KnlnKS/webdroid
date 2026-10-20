// Name mangling and descriptor utilities.
//
// Java values in JS:
//   int/short/byte/char/float/double → number (booleans are 0/1 numbers, NEVER JS true/false)
//   long → BigInt   |   String → JS string primitive   |   null → null
//   prim arrays → TypedArrays (byte=Int8, bool=Uint8, char=Uint16, short=Int16,
//     int=Int32, long=BigInt64, float=Float32, double=Float64)
//   object arrays → JS Array with $t = element descriptor tag
//
// A host object (wasm/host/bridge.ts) exposes an instance field as `f$name$H`, H = hash(declaring class),
// so R8's shadowed fields stay distinct.

function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const nameRe = /[^A-Za-z0-9_]/g;
function safeName(n: string): string {
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (!(c >= 97 && c <= 122 || c >= 65 && c <= 90 || c >= 48 && c <= 57 || c === 95))
      return n.replace(nameRe, (ch) => "$" + ch.charCodeAt(0).toString(16) + "$");
  }
  return n;
}

/** ART's heap limit: Runtime.maxMemory reports it, and an allocation past it throws OutOfMemoryError */
export const HEAP_LIMIT = 512 * 1024 * 1024;
export const oomMessage = (bytes: number | bigint) => `Failed to allocate a ${bytes} byte allocation with ${HEAP_LIMIT} free bytes`;

/** mangle instance field. declCls = "java/lang/Object" form */
export function mangleField(declCls: string, name: string): string {
  return "f$" + safeName(name) + "$" + hash36(declCls);
}

export function mangleStaticField(name: string, desc?: string): string {
  return "s$" + safeName(name) + (desc ? "$" + hash36(desc) : "");
}

/** "(ILjava/lang/String;[J)V" → { params: ["I","Ljava/lang/String;","[J"], ret: "V" } */
const descMemo = new Map<string, { params: string[]; ret: string }>();
export function parseMethodDesc(desc: string): { params: string[]; ret: string } {
  let hit = descMemo.get(desc);
  if (hit) return hit;
  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ")") {
    const start = i;
    while (desc[i] === "[") i++;
    if (desc[i] === "L") { while (desc[i] !== ";") i++; }
    i++;
    params.push(desc.slice(start, i));
  }
  descMemo.set(desc, (hit = { params, ret: desc.slice(i + 1) }));
  return hit;
}

export const dotName = (internal: string) => internal.replace(/\//g, ".");
export const slashName = (binary: string) => binary.replace(/\./g, "/");
export const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };
/** the bytes TextEncoder makes of `s`: a surrogate pair is four, a lone surrogate U+FFFD's three */
export function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if ((c & 0xfc00) === 0xd800 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 2; i++; }
    else n += 2;
  }
  return n;
}

export function isWide(desc: string): boolean { return desc === "J" || desc === "D"; }

/** default value of a field of the given type descriptor */
export function defaultValue(desc: string): 0 | 0n | null {
  return desc[0] === "J" ? 0n : desc[0] === "L" || desc[0] === "[" ? null : 0;
}

/** "Ljava/lang/String;" → "java/lang/String"; passthrough for already-plain names */
export function descToName(desc: string): string {
  return desc[0] === "L" ? desc.slice(1, -1) : desc;
}

/** the TypedArray holding a primitive array's elements */
export type PrimArray = ArrayBufferView & { length: number };
type PrimArrayType = { new (n: number): PrimArray; new (b: ArrayBuffer, o: number, n: number): PrimArray; from(items: ArrayLike<number> | ArrayLike<bigint>): PrimArray };
const prim = (name: string, box: string, size: number, array: PrimArrayType) => ({ name, title: name[0].toUpperCase() + name.slice(1), box: "java/lang/" + box, size, array });
/** the primitive types by descriptor letter, in ART's Primitive::Type order (boolean is 1, double 8; void, without values, is 9): the Java
 *  name, that name as per-type method names carry it (Unsafe.getInt, JNI's NewCharArray), the wrapper class, an array element's bytes and
 *  the TypedArray of an array's elements */
export const PRIMS: Record<string, ReturnType<typeof prim>> = {
  Z: prim("boolean", "Boolean", 1, Uint8Array), B: prim("byte", "Byte", 1, Int8Array), C: prim("char", "Character", 2, Uint16Array),
  S: prim("short", "Short", 2, Int16Array), I: prim("int", "Integer", 4, Int32Array), J: prim("long", "Long", 8, BigInt64Array),
  F: prim("float", "Float", 4, Float32Array), D: prim("double", "Double", 8, Float64Array),
};
/** Java type name → primitive descriptor, void included */
export const PRIM_DESC: Record<string, string> = { ...Object.fromEntries(Object.entries(PRIMS).map(([d, p]) => [p.name, d])), void: "V" };

/** tag a JS array as a Java `elem[]` for compiled code (in place, returns the same array) */
export function jarray<T>(items: T[], elem = "Ljava/lang/Object;"): T[] {
  (items as { $t?: string }).$t = elem;
  return items;
}
export const strArray = (a: readonly string[]) => jarray([...a], "Ljava/lang/String;");

// Typed code-unit reads and fromCharCode cannot re-enter; retain only numeric scratch by length.
const shortStringUnits: number[][] = [];
const utf16 = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });
/** code units → string, chunked to stay under the argument limit */
export function charsToString(chars: Uint16Array | Uint8Array, off: number, len: number): string {
  // TextDecoder is faster for long strings but rejects lone surrogates and shared memory.
  if (len >= 128 && chars instanceof Uint16Array) {
    try { return utf16.decode(chars.subarray(off, off + len)); } catch { /* below */ }
  }
  // fromCharCode reads short plain arrays faster than typed arrays.
  if (len < 128) {
    const units = shortStringUnits[len] ??= new Array<number>(len);
    for (let i = 0; i < len; i++) units[i] = chars[off + i];
    return Reflect.apply(String.fromCharCode, null, units);
  }
  if (off === 0 && len === chars.length && len <= 1024) return Reflect.apply(String.fromCharCode, null, chars);
  let s = "";
  for (let i = 0; i < len; i += 1024) {
    s += Reflect.apply(String.fromCharCode, null, chars.subarray(off + i, off + Math.min(len, i + 1024)));
  }
  return s;
}

export function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** modified UTF-8 from `pos`: NUL is two bytes and a supplementary character is two three-byte
 *  halves, or one four-byte sequence as ART's JNI accepts. Stops at `end` or after `units` UTF-16
 *  units, whichever comes first. */
export function decodeModifiedUtf8(bytes: Uint8Array, pos = 0, end = bytes.length, units = end - pos): string {
  let ascii = pos + units <= end;
  for (let i = 0; ascii && i < units; i++) ascii = bytes[pos + i] < 0x80;
  if (ascii) return charsToString(bytes, pos, units);
  const out = new Uint16Array(units);
  let o = 0, p = pos;
  while (o < units && p < end) {
    const a = bytes[p++];
    if (a < 0x80) out[o++] = a;
    else if ((a & 0xe0) === 0xc0) out[o++] = ((a & 0x1f) << 6) | (bytes[p++] & 0x3f);
    else if ((a & 0xf8) === 0xf0) {
      const v = (((a & 7) << 18) | ((bytes[p] & 0x3f) << 12) | ((bytes[p + 1] & 0x3f) << 6) | (bytes[p + 2] & 0x3f)) - 0x10000;
      p += 3;
      out[o++] = 0xd800 | (v >> 10);
      if (o < units) out[o++] = 0xdc00 | (v & 0x3ff);
    }
    else { const b = bytes[p++], c = bytes[p++]; out[o++] = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f); }
  }
  return charsToString(out, 0, o);
}

/** modified UTF-8 as ART's JNI and String8 write it: NUL is C0 80 and a lone surrogate three bytes,
 *  but a valid surrogate pair is one four-byte sequence */
export function encodeModifiedUtf8(s: string): Uint8Array {
  if (!/[\0\ud800-\udfff]/.test(s)) return utf8.enc.encode(s);
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  return Uint8Array.from(out);
}

export const i8 = <B extends ArrayBufferLike>(b: ArrayBufferView<B>, off = 0, len = b.byteLength - off) => new Int8Array(b.buffer, b.byteOffset + off, len);
export const u8 = <B extends ArrayBufferLike>(b: ArrayBufferView<B>, off = 0, len = b.byteLength - off) => new Uint8Array(b.buffer, b.byteOffset + off, len);
/** bytes as a Web API that refuses shared memory takes them: a view of guest memory, where Java's
 *  non-movable arrays live too, is copied */
export const unshared = (b: Uint8Array): Uint8Array<ArrayBuffer> => (b.buffer instanceof ArrayBuffer ? b as Uint8Array<ArrayBuffer> : b.slice());
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) { out.set(p, n); n += p.length; }
  return out;
}
export const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
export function splitSig(sig: string): [string, string] {
  const p = sig.indexOf("(");
  return [sig.slice(0, p), sig.slice(p)];
}

const bits = new DataView(new ArrayBuffer(8));
export function intBitsToFloat(i: number): number { bits.setInt32(0, i | 0); return bits.getFloat32(0); }
export function longBitsToDouble(l: bigint): number { bits.setBigInt64(0, l); return bits.getFloat64(0); }

/** VarHandle access modes by how many value operands follow the coordinates */
const VARHANDLE_VALUES = new Map<string, number>();
for (const [n, modes] of [
  [0, "get getVolatile getOpaque getAcquire"],
  [1, "set setVolatile setOpaque setRelease getAndSet getAndSetAcquire getAndSetRelease getAndAdd getAndAddAcquire " +
    "getAndAddRelease getAndBitwiseOr getAndBitwiseOrAcquire getAndBitwiseOrRelease getAndBitwiseAnd " +
    "getAndBitwiseAndAcquire getAndBitwiseAndRelease getAndBitwiseXor getAndBitwiseXorAcquire getAndBitwiseXorRelease"],
  [2, "compareAndSet compareAndExchange compareAndExchangeAcquire compareAndExchangeRelease weakCompareAndSet " +
    "weakCompareAndSetPlain weakCompareAndSetAcquire weakCompareAndSetRelease"],
] as const) for (const m of modes.split(" ")) VARHANDLE_VALUES.set(m, n);
/** how many value operands a VarHandle access mode takes; undefined for any other name */
export const varHandleValues = (mode: string): number | undefined => VARHANDLE_VALUES.get(mode);

/** String.hashCode */
export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
