// java.nio's buffers and charset coders are libcore's. This is their native boundary: NativeConverter
// and CharsetUtils over charset.ts's converters, MappedByteBuffer's natives, and how TS reads a
// buffer's memory, as NIOAccess does: a direct buffer's `address` (guest memory, or an external
// read-only mapping, jmemory.ts), else a heap buffer's array from its offset.

import { rt, JObj, declaredField } from "../runtime";
import { after, vcallOn, curThread, scall } from "./jlang";
import { mem } from "../../native/mem";
import { syncShared } from "../../native/mappings";
import { jarray } from "../abi";
import { handle, deref, release } from "../../android/handles";
import { CHARSETS, Converter, charsetNamed, covers, encodeString, U_BUFFER_OVERFLOW_ERROR, U_TRUNCATED_CHAR_FOUND, U_INVALID_CHAR_FOUND, U_ILLEGAL_CHAR_FOUND } from "../charset";
import { isExternal, pagesIn, externalBytes, guestAddress, setBufferAddress, isResident, mapExternal, unmapExternal } from "./jmemory";
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
const physical = (address: bigint) => mem.txVa(BigInt.asUintN(64, address));
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

/** `new cls(args)` from TS, synchronous unless class initialization or the constructor suspends */
function construct(cls: string, desc: string, ...args: unknown[]): JObj | Promise<JObj> {
  const thread = curThread, info = rt.link(cls), init = rt.initClass(info);
  const make = () => {
    const o = new info.ctor() as JObj;
    return after(vcallOn(thread, o, "<init>", desc, ...args), () => o);
  };
  return init ? init.then(make) : make();
}
/** ByteBuffer.allocateDirect(n): guest memory, owned by the buffer */
export const allocateDirect = (n: number): JBuffer | Promise<JBuffer> => scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", n);
/** ByteBuffer.wrap: a heap buffer over the bytes themselves */
export const wrapBytes = (bytes: Int8Array): JBuffer | Promise<JBuffer> => scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", bytes);
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
  construct("java/nio/DirectByteBuffer", "(JI)V", BigInt(address), cap);
/** a direct buffer over [offset, offset + length) of guest bytes from `nonMovableBytes`, which it keeps alive */
export function directView(bytes: Int8Array, offset: number, length: number, readOnly: boolean): JBuffer | Promise<JBuffer> {
  return after(newDirectBuffer(mem.va(bytes.byteOffset + offset), length), (b) => {
    Object.defineProperty((b as Fields)[declaredField("java/nio/DirectByteBuffer", "memoryRef")], "$bytes", { value: bytes });
    return readOnly ? vcallOn(curThread, b, "asReadOnlyBuffer", "()Ljava/nio/ByteBuffer;") as JBuffer | Promise<JBuffer> : b;
  });
}
const unmappers = new FinalizationRegistry<() => void>((unmap) => unmap());
/** a MappedByteBuffer over a mapping at `address`, which `unmap` releases once no buffer shares it */
export function mappedBuffer(address: number | bigint, size: number, fd: JObj | null, readOnly: boolean, unmap: () => void): JBuffer | Promise<JBuffer> {
  return after(construct("java/nio/DirectByteBuffer", "(IJLjava/io/FileDescriptor;Ljava/lang/Runnable;Z)V", size, BigInt(address), fd, null, +readOnly), (b) => {
    unmappers.register((b as Fields)[declaredField("java/nio/DirectByteBuffer", "memoryRef")], unmap);
    return b;
  });
}

/** a read-only MappedByteBuffer over an immutable source, paged in as it is read */
export function readOnlyMapping(source: FileSource, offset: number, size: number, fd: JObj | null = null): JBuffer | Promise<JBuffer> {
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
    return cs && construct("com/android/icu/charset/CharsetICU", "(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)V", cs.name, cs.name, jarray(cs.aliases, "Ljava/lang/String;"));
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
