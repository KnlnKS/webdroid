// java.nio's buffers and charset coders are libcore's. This is their native boundary: NativeConverter
// and CharsetUtils over charset.ts's converters, MappedByteBuffer's natives, and how TS reads a
// buffer's memory, as NIOAccess does: a direct buffer's `address` (guest memory, or outside it a
// read-only mapping or an early non-movable array, jmemory.ts), else a heap buffer's array.

import { rt, JObj, declaredField, type Intrinsic } from "../runtime";
import { after, scall, newObj, iof, classNameOf, initClass } from "./jentry";
import { intrinsicCompiler } from "./jbox";
import { mem } from "../../native/mem";
import { syncShared } from "../../native/mappings";
import { jarray, mangleField, mangleMethod } from "../abi";
import { handle, deref, release } from "../../android/handles";
import { CHARSETS, Converter, charsetNamed, covers, encodeString, U_BUFFER_OVERFLOW_ERROR, U_TRUNCATED_CHAR_FOUND, U_INVALID_CHAR_FOUND, U_ILLEGAL_CHAR_FOUND } from "../charset";
import { isExternal, isLive, forceExternal, pagesIn, externalBytes, guestAddress, setBufferAddress, isResident, mapExternal, unmapExternal, physical, hostBytes, memoryAt, writeAt } from "./jmemory";
import { BytesFile, type FileSource } from "../../shell/lazyfile";
export { isExternal };

/** a java.nio.Buffer */
export type JBuffer = JObj;
type Fields = Record<string, any>;
let F: { position: string; limit: string; capacity: string; mark: string; address: string; shift: string } | undefined;
const fields = () => F ??= Object.fromEntries(["position", "limit", "capacity", "mark", "address", "_elementSizeShift"]
  .map((n) => [n === "_elementSizeShift" ? "shift" : n, declaredField("java/nio/Buffer", n)])) as NonNullable<typeof F>;
export const position = (b: JBuffer): number => (b as Fields)[fields().position];
export const limit = (b: JBuffer): number => (b as Fields)[fields().limit];
export const capacity = (b: JBuffer): number => (b as Fields)[fields().capacity];
export const elementShift = (b: JBuffer): number => (b as Fields)[fields().shift];
/** Buffer.position(int), for a position within the limit */
export function setPosition(b: JBuffer, p: number): void {
  const o = b as Fields, f = fields();
  o[f.position] = p;
  if (o[f.mark] > p) o[f.mark] = -1;
}
export const setLimit = (b: JBuffer, l: number): void => { (b as Fields)[fields().limit] = l; };
export const isBuffer = (o: unknown): o is JBuffer => !!o && typeof o === "object" && !!iof(o, "java/nio/Buffer");
/** Buffer.address: a direct buffer's memory, 0 for a heap buffer */
export const addressOf = (b: JBuffer): bigint => (b as Fields)[fields().address];
setBufferAddress(addressOf);

/** where a buffer class keeps its elements: a heap buffer's array and offset, a view's buffer and byte offset */
interface Layout { hb?: string; offset?: string; bb?: string; byteOffset?: string }
const layouts = new WeakMap<object, Layout>();
const TYPED = ["ByteBuffer", "CharBuffer", "ShortBuffer", "IntBuffer", "LongBuffer", "FloatBuffer", "DoubleBuffer"];
function layoutOf(b: JBuffer): Layout {
  let layout = layouts.get(b.constructor);
  if (layout) return layout;
  layout = {};
  const typed = TYPED.find((t) => iof(b, "java/nio/" + t)), own = classNameOf(b) ?? "";
  if (typed) layout = { hb: declaredField("java/nio/" + typed, "hb"), offset: declaredField("java/nio/" + typed, "offset") };
  if (own.startsWith("java/nio/ByteBufferAs")) Object.assign(layout, { bb: declaredField(own, "bb"), byteOffset: declaredField(own, "byteOffset") });
  layouts.set(b.constructor, layout);
  return layout;
}
/** A synchronous byte view: immutable mappings must be resident, live owner mappings cannot provide one. */
export function bufferBytes(b: JBuffer): Uint8Array<ArrayBuffer> {
  const o = b as Fields, shift = elementShift(b), n = capacity(b) << shift, address = addressOf(b);
  if (address) return (isExternal(address) ? externalBytes(address, n) : mem.bytes(physical(address), n)) as Uint8Array<ArrayBuffer>;
  const layout = layoutOf(b), hb = layout.hb && o[layout.hb] as ArrayBufferView<ArrayBuffer> | null;
  if (hb) return new Uint8Array(hb.buffer, hb.byteOffset + (o[layout.offset!] << shift), n);
  if (layout.bb) { const at = o[layout.byteOffset!]; return bufferBytes(o[layout.bb]).subarray(at, at + n); }
  throw rt.mkThrowable("java/lang/UnsupportedOperationException", "a buffer over a CharSequence has no memory");
}
function checkedByteLength(b: JBuffer, at: number, n?: number): number {
  const size = capacity(b) * 2 ** elementShift(b), length = n ?? size - at;
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at > size - length)
    throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "invalid buffer byte range");
  return length;
}
/** A view of a shared owner mapping, whose writes commit asynchronously. */
export function isLiveBuffer(b: JBuffer): boolean {
  const address = addressOf(b);
  if (address) return isLive(address);
  const layout = layoutOf(b), o = b as Fields;
  return !!(layout.bb && !(layout.hb && o[layout.hb]) && isLiveBuffer(o[layout.bb]));
}
/** A host operation reads owner-backed memory once; it does not receive a live byte view. */
export function readBufferBytes(b: JBuffer, at = 0, n?: number): Uint8Array | Promise<Uint8Array> {
  const length = checkedByteLength(b,at,n), address = addressOf(b);
  if (address) return memoryAt(address + BigInt(at),length);
  const layout = layoutOf(b), o = b as Fields;
  if (layout.bb && !(layout.hb && o[layout.hb])) return readBufferBytes(o[layout.bb],o[layout.byteOffset!] + at,length);
  return bufferBytes(b).subarray(at,at + length);
}
export function writeBufferBytes(b: JBuffer, bytes: Uint8Array, at = 0): void | Promise<void> {
  checkedByteLength(b,at,bytes.length);
  const address = addressOf(b);
  if (address) return writeAt(address + BigInt(at),bytes);
  const layout = layoutOf(b), o = b as Fields;
  if (layout.bb && !(layout.hb && o[layout.hb])) return writeBufferBytes(o[layout.bb],bytes,o[layout.byteOffset!] + at);
  bufferBytes(b).set(bytes,at);
}
/** the bytes of [position, limit) */
export function remainingBytes(b: JBuffer): Uint8Array<ArrayBuffer> {
  const shift = elementShift(b);
  return bufferBytes(b).subarray(position(b) << shift, limit(b) << shift);
}
export function readRemainingBytes(b: JBuffer, n?: number): Uint8Array | Promise<Uint8Array> {
  const scale = 2 ** elementShift(b), remaining = (limit(b) - position(b)) * scale;
  return readBufferBytes(b,position(b) * scale,n === undefined ? remaining : Math.min(n,remaining));
}
/** Validate a destination before an operation starts, including its current limit. */
export function checkedRemainingOffset(b: JBuffer, n: number): number {
  const scale = 2 ** elementShift(b), at = position(b) * scale;
  if (n > (limit(b) - position(b)) * scale) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "buffer limit exceeded");
  checkedByteLength(b,at,n);
  return at;
}
export function writeRemainingBytes(b: JBuffer, bytes: Uint8Array): void | Promise<void> {
  return writeBufferBytes(b,bytes,checkedRemainingOffset(b,bytes.length));
}
/** GetDirectBufferAddress: 0 for a heap buffer or a host array; an external mapping moves into guest memory */
export function directAddress(b: JBuffer): number | bigint | Promise<number | bigint> {
  const address = addressOf(b);
  if (isExternal(address)) return guestAddress(address);
  return address <= 0xffffffffn ? Number(address) : address;
}

/** ByteBuffer.allocateDirect(n): guest memory, owned by the buffer */
export const allocateDirect = (n: number): JBuffer | Promise<JBuffer> => scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", n);
/** ByteBuffer.order(nativeOrder()) */
export function nativeOrder(b: JBuffer): JBuffer {
  const o = b as Fields;
  o[declaredField("java/nio/ByteBuffer", "bigEndian")] = 0;
  o[declaredField("java/nio/ByteBuffer", "nativeByteOrder")] = 1;
  return b;
}
/** a direct buffer holding a copy of `bytes` */
export const directCopy = (bytes: Uint8Array): JBuffer | Promise<JBuffer> =>
  after(allocateDirect(bytes.length), (b) => { bufferBytes(b).set(bytes); return b; });
/** initializes what allocateDirectNow needs */
export function directReady(): Promise<void> | null {
  const a = initClass("java/nio/ByteBuffer"), b = initClass("java/nio/DirectByteBuffer");
  return a || b ? Promise.all([a, b]).then(() => {}) : null;
}
/** allocateDirect for a caller that cannot wait, once `directReady` has settled */
export function allocateDirectNow(n: number): JBuffer {
  const b = allocateDirect(n);
  if (b instanceof Promise) throw new Error("allocateDirectNow before directReady");
  return b;
}
/** JNI's NewDirectByteBuffer: a buffer over memory it does not own */
export const newDirectBuffer = (address: number | bigint, cap: number): JBuffer | Promise<JBuffer> =>
  newObj("java/nio/DirectByteBuffer", "(JI)V", BigInt(address), cap);
const unmappers = new FinalizationRegistry<() => void | Promise<void>>((unmap) => { const pending = unmap(); if (pending) void pending.catch(console.error); });
/** a MappedByteBuffer over a mapping at `address`, which `unmap` releases once no buffer shares it */
function mappedBuffer(address: number | bigint, size: number, fd: JObj | null, readOnly: boolean, unmap: () => void | Promise<void>): JBuffer | Promise<JBuffer> {
  return after(newObj("java/nio/DirectByteBuffer", "(IJLjava/io/FileDescriptor;Ljava/lang/Runnable;Z)V", size, BigInt(address), fd, null, +readOnly), (b) => {
    unmappers.register((b as Fields)[declaredField("java/nio/DirectByteBuffer", "memoryRef")], unmap);
    return b;
  });
}

/** a read-only MappedByteBuffer over an immutable source, paged in as it is read */
function readOnlyMapping(source: FileSource, offset: number, size: number, fd: JObj | null = null): JBuffer | Promise<JBuffer> {
  const address = mapExternal(source, offset, size);
  return mappedBuffer(address, size, fd, true, () => unmapExternal(address));
}
export const readOnlyBuffer = (bytes: Uint8Array): JBuffer | Promise<JBuffer> => readOnlyMapping(new BytesFile(bytes), 0, bytes.length);

const guestArrays = new FinalizationRegistry<number>((address) => mem.free(address));
/** VMRuntime.newNonMovableArray's byte[]: guest memory, as ART's non-moving space is the memory
 *  native code sees, so the array and its address are the same bytes. Where the memory is not
 *  shared, committing the native ABI's address space (mem.init) would detach the array, so until
 *  then it is a host array instead. */
export function nonMovableBytes(n: number): Int8Array {
  if (!mem.attached()) return hostBytes(n);
  const address = mem.calloc(1, Math.max(1, n));
  if (!address) throw rt.mkThrowable("java/lang/OutOfMemoryError", `Failed to allocate a ${n} byte allocation in the non-moving space`);
  const array = new Int8Array(mem.buf, address, n);
  guestArrays.register(array, address);
  return array;
}

rt.registerJnis("java/nio/MappedByteBuffer", {
  "isLoaded0(JJJ)Z": function (address: bigint, length: bigint) { return +(!isExternal(address) || isResident(address, Number(length))); },
  "load0(JJ)V": function (address: bigint, length: bigint) { return isExternal(address) ? pagesIn(address, Number(length)) : undefined; },
  // msync: a shared file mapping's stores reach the file
  "force0(Ljava/io/FileDescriptor;JJ)V": function (_fd: unknown, address: bigint, length: bigint) { if (isExternal(address)) return forceExternal(address); syncShared(address, Number(length), false); },
});

// ── charsets: NativeConverter (libcore_bridge's JNI over ICU's ucnv) over charset.ts's converters
const converter = (h: bigint) => deref<Converter>(h);
const CONVERTER_FINALIZER = handle((h: bigint) => release(h));
/** ucnv_toUnicode/ucnv_fromUnicode through `data` ([input offset, output offset, invalid count]):
 *  the input offset comes back as the count consumed, the output one as the count produced when
 *  decoding and as the offset reached when encoding, as each native reports them. A failure other
 *  than those the managed code handles throws, as maybeThrowIcuException does. */
function convert(c: Converter, code: number, sp: number, dp: number, data: Int32Array, flush: number, what: string): number {
  data[0] = c.sp - sp; data[1] = what === "ucnv_toUnicode" ? c.dp - dp : c.dp;
  if (code === U_INVALID_CHAR_FOUND || code === U_ILLEGAL_CHAR_FOUND || code === U_TRUNCATED_CHAR_FOUND) data[2] = c.invalid;
  if (code > 0 && (flush ? code !== U_BUFFER_OVERFLOW_ERROR && code !== U_TRUNCATED_CHAR_FOUND
    : code !== U_BUFFER_OVERFLOW_ERROR && code !== U_INVALID_CHAR_FOUND && code !== U_ILLEGAL_CHAR_FOUND))
    throw rt.mkThrowable("java/lang/RuntimeException", `${what} failed: ${code}`);
  return code;
}
rt.registerJnis("com/android/icu/charset/NativeConverter", {
  "getNativeFinalizer()J": () => CONVERTER_FINALIZER,
  "openConverter(Ljava/lang/String;)J": (name: string) => {
    const cs = charsetNamed(name);
    if (!cs) throw rt.mkThrowable("java/lang/RuntimeException", "ucnv_open failed: U_FILE_ACCESS_ERROR");
    return handle(new Converter(cs));
  },
  "closeConverter(J)V": (h: bigint) => release(h),
  "resetByteToChar(J)V": (h: bigint) => converter(h).resetToUnicode(),
  "resetCharToByte(J)V": (h: bigint) => converter(h).resetFromUnicode(),
  "getMaxBytesPerChar(J)I": (h: bigint) => converter(h).cs.maxBytes,
  "getAveBytesPerChar(J)F": (h: bigint) => Math.fround(converter(h).cs.averageBytes),
  "getAveCharsPerByte(J)F": (h: bigint) => Math.fround(converter(h).cs.averageChars),
  "getSubstitutionBytes(J)[B": (h: bigint) => Int8Array.from(converter(h).cs.replacement),
  "setCallbackDecode(JIILjava/lang/String;)V": (h: bigint, malformed: number, unmappable: number, chars: string) => {
    const c = converter(h);
    c.onMalformed = malformed; c.onUnmappable = unmappable; c.subChars = chars;
  },
  "setCallbackEncode(JII[B)V": (h: bigint, malformed: number, unmappable: number, bytes: Int8Array) => {
    const c = converter(h);
    c.onMalformed = malformed; c.onUnmappable = unmappable; c.subBytes = bytes.slice();
  },
  "decode(J[BI[CI[IZ)I": (h: bigint, src: Int8Array, sEnd: number, dst: Uint16Array, dEnd: number, data: Int32Array, flush: number) => {
    const c = converter(h), sp = data[0], dp = data[1];
    return convert(c, c.decode(src, sp, sEnd, dst, dp, dEnd, !!flush), sp, dp, data, flush, "ucnv_toUnicode");
  },
  "encode(J[CI[BI[IZ)I": (h: bigint, src: Uint16Array, sEnd: number, dst: Int8Array, dEnd: number, data: Int32Array, flush: number) => {
    const c = converter(h), sp = data[0], dp = data[1];
    return convert(c, c.encode(src, sp, sEnd, dst, dp, dEnd, !!flush), sp, dp, data, flush, "ucnv_fromUnicode");
  },
  "getAvailableCharsetNames()[Ljava/lang/String;": () => jarray(CHARSETS.map((cs) => cs.name), "Ljava/lang/String;"),
  // ICU names the converter; the Java name, the one CharsetICU's codecs open, stands for it
  "charsetForName(Ljava/lang/String;)Ljava/nio/charset/Charset;": (name: string) => {
    const cs = charsetNamed(name);
    return cs && newObj("com/android/icu/charset/CharsetICU", "(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)V", cs.name, cs.name, jarray(cs.aliases, "Ljava/lang/String;"));
  },
  "contains(Ljava/lang/String;Ljava/lang/String;)Z": (a: string, b: string) => {
    const x = charsetNamed(a), y = charsetNamed(b);
    return +(!!x && !!y && covers(x, y));
  },
});
// String's fast paths (libcore/util/CharsetUtils): an unencodable char becomes '?', and an ASCII
// decode maps a byte past 0x7f to U+FFFD
const latinBytes = (max: number) => (s: string, offset: number, length: number) => {
  const out = new Int8Array(length);
  for (let i = 0; i < length; i++) { const c = s.charCodeAt(offset + i); out[i] = c > max ? 0x3f : c; }
  return out;
};
rt.registerJnis("libcore/util/CharsetUtils", {
  "toUtf8Bytes(Ljava/lang/String;II)[B": (s: string, offset: number, length: number) => encodeString(s.slice(offset, offset + length), "UTF-8"),
  "toAsciiBytes(Ljava/lang/String;II)[B": latinBytes(0x7f),
  "toIsoLatin1Bytes(Ljava/lang/String;II)[B": latinBytes(0xff),
  "asciiBytesToChars([BII[C)V": (bytes: Int8Array, offset: number, length: number, chars: Uint16Array) => {
    for (let i = 0; i < length; i++) { const b = bytes[offset + i] & 255; chars[i] = b <= 0x7f ? b : 0xfffd; }
  },
});

// §4.7 intrinsics: element access at a position or index of a ByteBuffer and its typed views,
// the loops GL and media code run per vertex and sample. A direct buffer's address is read once
// a call as plane 0's Number offset, not through ix's and Memory.peek*'s BigInt arithmetic; one
// elsewhere over an array (a host array, jmemory.ts) goes through the array as a heap buffer's. An
// inaccessible buffer, a bounds or read-only failure, an external mapping or another plane's
// native memory is the AOSP body's. Each is compiled with its fields' own names (intrinsicCompiler).
const DBB = "java/nio/DirectByteBuffer", HBB = "java/nio/HeapByteBuffer";
const FIELDS: Record<string, string> = {
  position: mangleField("java/nio/Buffer", "position"), limit: mangleField("java/nio/Buffer", "limit"), address: mangleField("java/nio/Buffer", "address"),
  memoryRef: mangleField(DBB, "memoryRef"), isAccessible: mangleField(DBB + "$MemoryRef", "isAccessible"),
  ...Object.fromEntries(["hb", "offset", "isReadOnly", "bigEndian", "nativeByteOrder"].map((n) => [n, mangleField("java/nio/ByteBuffer", n)])),
};
const word = new BigInt64Array(1), words = new Int32Array(word.buffer);
const scratch = new DataView(new ArrayBuffer(8)), scratchBytes = new Int8Array(scratch.buffer);
const env = {
  M: mem, X: scratch, XB: scratchBytes,
  /** plane 0's offset of a direct buffer's address, else -1 */
  low: (address: bigint): number => { word[0] = address; return words[1] === 0 ? words[0] >>> 0 : -1; },
  sw16: (v: number) => (((v & 0xff) << 8) | ((v >>> 8) & 0xff)) << 16 >> 16,
  sw32: (v: number) => ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24),
  sw64: (v: bigint) => { scratch.setBigInt64(0, v, true); return scratch.getBigInt64(0, false); },
  f32: (bits: number) => { scratch.setInt32(0, bits, true); return scratch.getFloat32(0, true); },
  bits32: (v: number) => { scratch.setFloat32(0, v, true); return scratch.getInt32(0, true); },
  f64: (bits: bigint) => { scratch.setBigInt64(0, bits, true); return scratch.getFloat64(0, true); },
  bits64: (v: number) => { scratch.setFloat64(0, v, true); return scratch.getBigInt64(0, true); },
};
const compile = intrinsicCompiler(FIELDS, env);

/** an element type: its size and descriptor, how a direct buffer loads and stores it at native
 *  address A (byte-swapped when s), and the DataView accessor a heap buffer's bytes go through */
interface Kind { name: string; d: string; n: number; load: string; store: string; view: string }
const KINDS: Kind[] = [
  { name: "Short", d: "S", n: 2, load: "s ? sw16(M.ld16u(A)) : M.ld16s(A)", store: "M.st16(A, s ? sw16(v) : v)", view: "Int16" },
  { name: "Char", d: "C", n: 2, load: "s ? sw16(M.ld16u(A)) & 0xffff : M.ld16u(A)", store: "M.st16(A, s ? sw16(v) : v)", view: "Uint16" },
  { name: "Int", d: "I", n: 4, load: "s ? sw32(M.ld32(A)) : M.ld32(A)", store: "M.st32(A, s ? sw32(v) : v)", view: "Int32" },
  { name: "Long", d: "J", n: 8, load: "s ? sw64(M.ld64(A)) : M.ld64(A)", store: "M.st64(A, s ? sw64(v) : v)", view: "BigInt64" },
  { name: "Float", d: "F", n: 4, load: "s ? f32(sw32(M.ld32(A))) : M.ldf32(A)", store: "if (s) M.st32(A, sw32(bits32(v))); else M.stf32(A, v)", view: "Float32" },
  { name: "Double", d: "D", n: 8, load: "s ? f64(sw64(M.ld64(A))) : M.ldf64(A)", store: "if (s) M.st64(A, sw64(bits64(v))); else M.stf64(A, v)", view: "Float64" },
];
const BYTE: Kind = { name: "", d: "B", n: 1, load: "M.ld8s(A)", store: "M.st8(A, v)", view: "Int8" };

// the guards, which leave `at`: the element's byte index from the buffer's start
const GET = (n: number) => `const p = this.$position; if (this.$limit - p < ${n}) return base.call(this); const at = p;`;
const INDEX = (n: number) => `if (i < 0 || this.$limit - i < ${n}) return base.call(this, i); const at = i;`;
const PUT = (n: number) => `if (this.$isReadOnly) return base.call(this, v); const p = this.$position; if (this.$limit - p < ${n}) return base.call(this, v); const at = p;`;
const PUT_INDEX = (n: number) => `if (this.$isReadOnly || i < 0 || this.$limit - i < ${n}) return base.call(this, i, v); const at = i;`;
/** an element access: a load, or a store followed by `tail` */
type Op = { store: boolean; tail: string };
type Access = (k: Kind, params: string, guard: string, op: Op, advance: boolean) => Intrinsic;
const heapLoad = (k: Kind) => k.n === 1 ? "return hb[I];"
  : `${Array.from({ length: k.n }, (_, j) => `XB[${j}] = hb[I + ${j}];`).join(" ")} return X.get${k.view}(0, !this.$bigEndian);`;
const heapStore = (k: Kind) => k.n === 1 ? "hb[I] = v;"
  : `X.set${k.view}(0, v, !this.$bigEndian); ${Array.from({ length: k.n }, (_, j) => `hb[I + ${j}] = XB[${j}];`).join(" ")}`;
const heapAccess = (k: Kind, op: Op) => op.store ? heapStore(k) + op.tail : heapLoad(k);
/** the element at `at` of a buffer's array from its offset */
const arrayAccess = (k: Kind, params: string, op: Op, advance: boolean) => `
  const I = this.$offset + at;
  if (I < 0 || I + ${k.n} > hb.length) return base.call(this${params && ", " + params});
  ${advance ? `this.$position = p + ${k.n};` : ""}
  ${heapAccess(k, op)}`;
/** a direct buffer over a host byte[] (jmemory's hostBytes), given `a` and `hb`: its address is
 *  outside guest memory, and the array holds its bytes */
const HOST_ARRAY = "a < 0 && hb !== null";
/** a direct buffer's element at `at`, after `guard`; `advance` moves the position past it */
const direct: Access = (k, params, guard, op, advance) => compile(params, `
  if (!this.$memoryRef.$isAccessible) return base.call(this${params && ", " + params});
  ${guard}
  const a = low(this.$address);
  if (a < 0 || a + at < 0 || a + at + ${k.n} > 4294967296) {
    const hb = this.$hb;
    if (!(${HOST_ARRAY})) return base.call(this${params && ", " + params});
    ${arrayAccess(k, params, op, advance)}
    return;
  }
  ${advance ? `this.$position = p + ${k.n};` : ""}
  const A = a + at, s = !this.$nativeByteOrder;
  ${op.store ? k.store + ";" + op.tail : `return ${k.load};`}`);
/** a heap buffer's element at `at` of its array from its offset */
const heap: Access = (k, params, guard, op, advance) => compile(params, `
  ${guard}
  const hb = this.$hb;
  ${arrayAccess(k, params, op, advance)}`);

const LOAD: Op = { store: false, tail: "" }, PUT_RET: Op = { store: true, tail: " return this;" }, PUT_VOID: Op = { store: true, tail: "" };
/** `checked`: whether an unchecked store still refuses a read-only buffer (a heap buffer's _put does) */
function accessors(k: Kind, make: Access, checked: boolean): Record<string, Intrinsic> {
  const get = "get" + k.name, put = "put" + k.name, ret = "Ljava/nio/ByteBuffer;";
  const table: Record<string, Intrinsic> = {
    [`${get}()${k.d}`]: make(k, "", GET(k.n), LOAD, true),
    [`${get}(I)${k.d}`]: make(k, "i", INDEX(k.n), LOAD, false),
    [`${put}(${k.d})${ret}`]: make(k, "v", PUT(k.n), PUT_RET, true),
    [`${put}(I${k.d})${ret}`]: make(k, "i, v", PUT_INDEX(k.n), PUT_RET, false),
  };
  if (k !== BYTE) {
    table[`${get}Unchecked(I)${k.d}`] = make(k, "i", "const at = i;", LOAD, false);
    table[`${put}Unchecked(I${k.d})V`] = make(k, "i, v", `${checked ? "if (this.$isReadOnly) return base.call(this, i, v); " : ""}const at = i;`, PUT_VOID, false);
  }
  return table;
}
const directTables = [BYTE, ...KINDS].map((k) => accessors(k, direct, false));
// DirectByteBuffer's getChar and putChar check their bounds by their own steps; theirs stay AOSP's
for (const sig of ["getChar()C", "getChar(I)C", "putChar(C)Ljava/nio/ByteBuffer;", "putChar(IC)Ljava/nio/ByteBuffer;"]) delete directTables[2][sig];
/** a bulk copy between a typed view's `elements` and its direct buffer's bytes: those in guest
 *  memory at a + i, or those of its host array */
type Copy = { guest: string; host: string };
// in the buffer's native order
const bulk = (copy: Copy) => compile("i, array, offset, length", `
  if (!this.$memoryRef.$isAccessible || !this.$nativeByteOrder || array === null || length <= 0 || offset < 0 || offset > array.length - length)
    return base.call(this, i, array, offset, length);
  const a = low(this.$address), size = array.BYTES_PER_ELEMENT, n = length * size, hb = this.$hb;
  const elements = new Uint8Array(array.buffer, array.byteOffset + offset * size, n);
  if (a < 0 || a + i < 0 || a + i + n > 4294967296) {
    const I = this.$offset + i;
    if (!(${HOST_ARRAY}) || I < 0 || I + n > hb.length) return base.call(this, i, array, offset, length);
    const bytes = new Uint8Array(hb.buffer, hb.byteOffset + I, n);
    ${copy.host}
  } else { ${copy.guest} }`);
const PUT_BULK: Copy = { guest: "M.write(a + i, elements);", host: "bytes.set(elements);" };
const GET_BULK: Copy = { guest: "elements.set(M.bytes(a + i, n));", host: "elements.set(bytes);" };
for (const k of KINDS) Object.assign(directTables[0], { [`putUnchecked(I[${k.d}II)V`]: bulk(PUT_BULK), [`getUnchecked(I[${k.d}II)V`]: bulk(GET_BULK) });
rt.intrinsic(DBB, Object.assign({}, ...directTables));
rt.intrinsic(HBB, Object.assign({}, ...[BYTE, ...KINDS].map((k) => accessors(k, heap, true))));

// a typed view's element is its ByteBuffer's, through that buffer's unchecked accessor at the
// element's byte offset; a read from an external mapping waits for its pages
for (const k of KINDS) {
  const view = `java/nio/ByteBufferAs${k.name}Buffer`, ret = `Ljava/nio/${k.name}Buffer;`;
  const viewCompile = intrinsicCompiler({ ...FIELDS, bb: mangleField(view, "bb"), byteOffset: mangleField(view, "byteOffset"), isReadOnly: mangleField(`java/nio/${k.name}Buffer`, "isReadOnly"),
    getU: mangleMethod(`get${k.name}Unchecked`, `(I)${k.d}`), putU: mangleMethod(`put${k.name}Unchecked`, `(I${k.d})V`),
    getA: mangleMethod("getUnchecked", `(I[${k.d}II)V`), putA: mangleMethod("putUnchecked", `(I[${k.d}II)V`) }, env);
  const bulkGuard = "array === null || offset < 0 || length < 0 || offset > array.length - length || length > this.$limit - this.$position";
  const ix = `(at << ${Math.log2(k.n)}) + this.$byteOffset`;
  rt.intrinsic(view, {
    [`get()${k.d}`]: viewCompile("", `const at = this.$position; if (at >= this.$limit) return base.call(this); this.$position = at + 1;
      return this.$bb.$getU(${ix});`),
    [`get(I)${k.d}`]: viewCompile("at", `if (at < 0 || at >= this.$limit) return base.call(this, at); return this.$bb.$getU(${ix});`),
    [`put(${k.d})${ret}`]: viewCompile("v", `if (this.$isReadOnly) return base.call(this, v); const at = this.$position; if (at >= this.$limit) return base.call(this, v);
      this.$position = at + 1; this.$bb.$putU(${ix}, v); return this;`),
    [`put(I${k.d})${ret}`]: viewCompile("at, v", `if (this.$isReadOnly || at < 0 || at >= this.$limit) return base.call(this, at, v); this.$bb.$putU(${ix}, v); return this;`),
    [`get([${k.d}II)${ret}`]: viewCompile("array, offset, length", `if (${bulkGuard}) return base.call(this, array, offset, length);
      const at = this.$position, read = this.$bb.$getA(${ix}, array, offset, length); this.$position += length;
      return read instanceof Promise ? read.then(() => this) : this;`),
    [`put([${k.d}II)${ret}`]: viewCompile("array, offset, length", `if (this.$isReadOnly || ${bulkGuard}) return base.call(this, array, offset, length);
      const at = this.$position; this.$bb.$putA(${ix}, array, offset, length); this.$position += length; return this;`),
  });
}
