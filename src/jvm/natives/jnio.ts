// java.nio's buffers and charset coders are libcore's. This is their native boundary: NativeConverter
// and CharsetUtils over charset.ts's converters, MappedByteBuffer's natives, and how TS reads a
// buffer's memory, as NIOAccess does: a direct buffer's `address` (guest memory, or an external
// read-only mapping, jmemory.ts), else a heap buffer's array from its offset.

import { rt, JObj, declaredField, type Intrinsic } from "../runtime";
import { after, scall, newObj } from "./jlang";
import { intrinsicCompiler } from "./jbox";
import { mem } from "../../native/mem";
import { syncShared } from "../../native/mappings";
import { jarray, mangleField, mangleMethod } from "../abi";
import { handle, deref, release } from "../../android/handles";
import { CHARSETS, Converter, charsetNamed, covers, encodeString, U_BUFFER_OVERFLOW_ERROR, U_TRUNCATED_CHAR_FOUND, U_INVALID_CHAR_FOUND, U_ILLEGAL_CHAR_FOUND } from "../charset";
import { isExternal, pagesIn, externalBytes, guestAddress, setBufferAddress, isResident, mapExternal, unmapExternal, physical } from "./jmemory";
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
export const isBuffer = (o: unknown): o is JBuffer => !!o && typeof o === "object" && !!rt.iof(o, "java/nio/Buffer");
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
  const typed = TYPED.find((t) => rt.iof(b, "java/nio/" + t)), own = (b.constructor as { $i?: { name: string } }).$i?.name ?? "";
  if (typed) layout = { hb: declaredField("java/nio/" + typed, "hb"), offset: declaredField("java/nio/" + typed, "offset") };
  if (own.startsWith("java/nio/ByteBufferAs")) Object.assign(layout, { bb: declaredField(own, "bb"), byteOffset: declaredField(own, "byteOffset") });
  layouts.set(b.constructor, layout);
  return layout;
}
/** the bytes of a buffer's elements [0, capacity) where its memory holds them; an external
 *  mapping's must be `resident` first */
export function bufferBytes(b: JBuffer): Uint8Array<ArrayBuffer> {
  const o = b as Fields, shift = elementShift(b), n = capacity(b) << shift, address = addressOf(b);
  if (address) return (isExternal(address) ? externalBytes(address, n) : mem.bytes(physical(address), n)) as Uint8Array<ArrayBuffer>;
  const layout = layoutOf(b), hb = layout.hb && o[layout.hb] as ArrayBufferView<ArrayBuffer> | null;
  if (hb) return new Uint8Array(hb.buffer, hb.byteOffset + (o[layout.offset!] << shift), n);
  if (layout.bb) { const at = o[layout.byteOffset!]; return bufferBytes(o[layout.bb]).subarray(at, at + n); }
  throw rt.mkThrowable("java/lang/UnsupportedOperationException", "a buffer over a CharSequence has no memory");
}
/** the bytes of [position, limit) */
export function remainingBytes(b: JBuffer): Uint8Array<ArrayBuffer> {
  const shift = elementShift(b);
  return bufferBytes(b).subarray(position(b) << shift, limit(b) << shift);
}
/** null when TS code can read a buffer's bytes, else a Promise that settles once it can: an
 *  external mapping loads the pages the buffer spans */
export function resident(b: JBuffer): Promise<void> | null {
  const address = addressOf(b);
  return address && isExternal(address) ? pagesIn(address, capacity(b) << elementShift(b)) : null;
}
/** GetDirectBufferAddress: 0 for a heap buffer; an external mapping moves into guest memory */
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
  const a = rt.initClass(rt.link("java/nio/ByteBuffer")), b = rt.initClass(rt.link("java/nio/DirectByteBuffer"));
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
const unmappers = new FinalizationRegistry<() => void>((unmap) => unmap());
/** a MappedByteBuffer over a mapping at `address`, which `unmap` releases once no buffer shares it */
function mappedBuffer(address: number | bigint, size: number, fd: JObj | null, readOnly: boolean, unmap: () => void): JBuffer | Promise<JBuffer> {
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

/** sizes guest memory for the app's native ABI before its first library loads; false when it
 *  ships none (the native tier sets it) */
let sizeNativeMemory = (): boolean => false;
export function setNativeMemorySizer(sizer: () => boolean): void { sizeNativeMemory = sizer; }
const guestArrays = new FinalizationRegistry<number>((address) => mem.free(address));
/** VMRuntime.newNonMovableArray's byte[]: guest memory, as ART's non-moving space is the memory
 *  native code sees, so the array and its address are the same bytes. Memory is sized for the
 *  app's native ABI first, since growing it later would detach the array. */
export function nonMovableBytes(n: number): Int8Array {
  if (!mem.sized()) sizeNativeMemory();
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
  "force0(Ljava/io/FileDescriptor;JJ)V": function (_fd: unknown, address: bigint, length: bigint) { if (!isExternal(address)) syncShared(address, Number(length), false); },
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
// a call as plane 0's Number offset, not through ix's and Memory.peek*'s BigInt arithmetic. An
// inaccessible buffer, a bounds or read-only failure, an external mapping or another plane's
// address is the AOSP body's. Each is compiled with its fields' own names (intrinsicCompiler).
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
type Access = (k: Kind, params: string, guard: string, access: string, advance: boolean) => Intrinsic;
/** a direct buffer's element at `at`, after `guard`; `advance` moves the position past it */
const direct: Access = (k, params, guard, access, advance) => compile(params, `
  if (!this.$memoryRef.$isAccessible) return base.call(this${params && ", " + params});
  ${guard}
  const a = low(this.$address);
  if (a < 0 || a + at < 0 || a + at + ${k.n} > 4294967296) return base.call(this${params && ", " + params});
  ${advance ? `this.$position = p + ${k.n};` : ""}
  const A = a + at, s = !this.$nativeByteOrder;
  ${access}`);
/** a heap buffer's element at `at` of its array from its offset */
const heap: Access = (k, params, guard, access, advance) => compile(params, `
  ${guard}
  const hb = this.$hb, I = this.$offset + at;
  if (I < 0 || I + ${k.n} > hb.length) return base.call(this${params && ", " + params});
  ${advance ? `this.$position = p + ${k.n};` : ""}
  ${access}`);
const heapLoad = (k: Kind) => k.n === 1 ? "return hb[I];"
  : `${Array.from({ length: k.n }, (_, j) => `XB[${j}] = hb[I + ${j}];`).join(" ")} return X.get${k.view}(0, !this.$bigEndian);`;
const heapStore = (k: Kind) => k.n === 1 ? "hb[I] = v;"
  : `X.set${k.view}(0, v, !this.$bigEndian); ${Array.from({ length: k.n }, (_, j) => `hb[I + ${j}] = XB[${j}];`).join(" ")}`;

/** `checked`: whether an unchecked store still refuses a read-only buffer (a heap buffer's _put does) */
function accessors(k: Kind, make: Access, load: string, store: string, checked: boolean): Record<string, Intrinsic> {
  const get = "get" + k.name, put = "put" + k.name, ret = "Ljava/nio/ByteBuffer;";
  const table: Record<string, Intrinsic> = {
    [`${get}()${k.d}`]: make(k, "", GET(k.n), load, true),
    [`${get}(I)${k.d}`]: make(k, "i", INDEX(k.n), load, false),
    [`${put}(${k.d})${ret}`]: make(k, "v", PUT(k.n), store + "; return this;", true),
    [`${put}(I${k.d})${ret}`]: make(k, "i, v", PUT_INDEX(k.n), store + "; return this;", false),
  };
  if (k !== BYTE) {
    table[`${get}Unchecked(I)${k.d}`] = make(k, "i", "const at = i;", load, false);
    table[`${put}Unchecked(I${k.d})V`] = make(k, "i, v", `${checked ? "if (this.$isReadOnly) return base.call(this, i, v); " : ""}const at = i;`, store + ";", false);
  }
  return table;
}
const directTables = [BYTE, ...KINDS].map((k) => accessors(k, direct, `return ${k.load};`, k.store, false));
// DirectByteBuffer's getChar and putChar check their bounds by their own steps; theirs stay AOSP's
for (const sig of ["getChar()C", "getChar(I)C", "putChar(C)Ljava/nio/ByteBuffer;", "putChar(IC)Ljava/nio/ByteBuffer;"]) delete directTables[2][sig];
// bulk copies between a typed view's array and its direct buffer, in the buffer's native order
const bulk = (copy: string) => compile("i, array, offset, length", `
  if (!this.$memoryRef.$isAccessible || !this.$nativeByteOrder || array === null || length <= 0 || offset < 0 || offset > array.length - length)
    return base.call(this, i, array, offset, length);
  const a = low(this.$address), size = array.BYTES_PER_ELEMENT, n = length * size;
  if (a < 0 || a + i < 0 || a + i + n > 4294967296) return base.call(this, i, array, offset, length);
  const elements = new Uint8Array(array.buffer, array.byteOffset + offset * size, n);
  ${copy}`);
for (const k of KINDS) Object.assign(directTables[0], {
  [`putUnchecked(I[${k.d}II)V`]: bulk("M.write(a + i, elements);"),
  [`getUnchecked(I[${k.d}II)V`]: bulk("elements.set(M.bytes(a + i, n));"),
});
rt.intrinsic(DBB, Object.assign({}, ...directTables));
rt.intrinsic(HBB, Object.assign({}, ...[BYTE, ...KINDS].map((k) => accessors(k, heap, heapLoad(k), heapStore(k), true))));

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
