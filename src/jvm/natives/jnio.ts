// java.nio's buffers and charset coders are libcore's. This is their native boundary: NativeConverter
// and CharsetUtils over charset.ts's converters, MappedByteBuffer's natives, and how TS reads a
// buffer's memory, as NIOAccess does: a direct buffer's `address` (guest memory, or outside it a
// read-only mapping or a live lease, jmemory.ts), else a heap buffer's array.

import { rt, type JObj, declaredField, instanceField, getDeclared, setDeclared, waits } from "../runtime.ts";
import { after, scall, newObj, vcall, iof, classNameOf } from "./jentry.ts";
import { mem } from "../../native/mem.ts";
import { syncShared } from "../../native/mappings.ts";
import { jarray } from "../abi.ts";
import { handle, deref, release } from "../../android/handles.ts";
import { CHARSETS, Converter, charsetNamed, covers, encodeString, U_BUFFER_OVERFLOW_ERROR, U_TRUNCATED_CHAR_FOUND, U_INVALID_CHAR_FOUND, U_ILLEGAL_CHAR_FOUND } from "../charset.ts";
import { isExternal, pagesIn, externalBytes, guestAddress, isResident, mapExternal, unmapExternal, physical, memoryAt, writeAt } from "./jmemory.ts";
import { BytesFile, type FileSource } from "../../shell/lazyfile.ts";
export { isExternal };

/** a java.nio.Buffer */
export type JBuffer = JObj;
type Fields = Record<string, any>;
const BUFFER = "java/nio/Buffer", positionField = instanceField<number>(BUFFER, "position"), limitField = instanceField<number>(BUFFER, "limit");
const markField = instanceField<number>(BUFFER, "mark");
export const position = positionField.get, limit = limitField.get, setLimit = limitField.set;
export const capacity = instanceField<number>(BUFFER, "capacity").get, elementShift = instanceField<number>(BUFFER, "_elementSizeShift").get;
/** Buffer.position(int), for a position within the limit */
export function setPosition(b: JBuffer, p: number): void {
  positionField.set(b, p);
  if (markField.get(b) > p) markField.set(b, -1);
}
export const isBuffer = (o: unknown): o is JBuffer => !!o && typeof o === "object" && !!iof(o, "java/nio/Buffer");
/** Buffer.address: a direct buffer's memory, 0 for a heap buffer */
export const addressOf = instanceField<bigint>(BUFFER, "address").get;

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
/** A host operation reads owner-backed memory once; it does not receive a live byte view. */
export function readBufferBytes(b: JBuffer, at = 0, n?: number): PromiseOrVal<Uint8Array> {
  const length = checkedByteLength(b,at,n), address = addressOf(b);
  if (address) return memoryAt(address + BigInt(at),length);
  const layout = layoutOf(b), o = b as Fields;
  if (layout.bb && !(layout.hb && o[layout.hb])) return readBufferBytes(o[layout.bb],o[layout.byteOffset!] + at,length);
  return bufferBytes(b).subarray(at,at + length);
}
export function writeBufferBytes(b: JBuffer, bytes: Uint8Array, at = 0): PromiseOrVal<void> {
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
export function readRemainingBytes(b: JBuffer, n?: number): PromiseOrVal<Uint8Array> {
  const scale = 2 ** elementShift(b), remaining = (limit(b) - position(b)) * scale;
  return readBufferBytes(b,position(b) * scale,n === undefined ? remaining : Math.min(n,remaining));
}
/** writes `bytes` at the position, checked against the limit before anything is written */
export function writeRemainingBytes(b: JBuffer, bytes: Uint8Array): PromiseOrVal<void> {
  const scale = 2 ** elementShift(b), at = position(b) * scale;
  if (bytes.length > (limit(b) - position(b)) * scale) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "buffer limit exceeded");
  checkedByteLength(b,at,bytes.length);
  return writeBufferBytes(b,bytes,at);
}
/** GetDirectBufferAddress: 0 for a heap buffer or a host array; an external mapping moves into guest memory */
export function directAddress(b: JBuffer): PromiseOrVal<number | bigint> {
  const address = addressOf(b);
  if (isExternal(address)) return guestAddress(address);
  return address <= 0xffffffffn ? Number(address) : address;
}

/** ByteBuffer.allocateDirect(n): guest memory, owned by the buffer */
export const allocateDirect = (n: number): PromiseOrVal<JBuffer> => scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", n);
/** NewDirectByteBuffer over a direct buffer's memory, as a native hands out memory it owns: freeing the view frees
 *  only its own MemoryRef. Read-only as asReadOnlyBuffer() makes it. */
export const directView = (b: JBuffer, readOnly = false): PromiseOrVal<JBuffer> =>
  after(newObj("java/nio/DirectByteBuffer", "(JI)V", addressOf(b), capacity(b)), (v: JBuffer) => readOnly ? vcall(v, "asReadOnlyBuffer", "()Ljava/nio/ByteBuffer;") : v);
/** ByteBuffer.order(nativeOrder()) */
export const nativeOrder = (b: JBuffer): JBuffer => setDeclared(b, "java/nio/ByteBuffer", { bigEndian: 0, nativeByteOrder: 1 });
/** a direct buffer holding a copy of `bytes` */
export const directCopy = (bytes: Uint8Array): PromiseOrVal<JBuffer> =>
  after(allocateDirect(bytes.length), (b) => { bufferBytes(b).set(bytes); return b; });
let directPrepared = false;
/** prepares allocateDirectNow: a first allocation initializes the classes it reaches and compiles its code, either of which may wait */
export function directReady(): Promise<void> | null {
  if (directPrepared) return null;
  const made = after(allocateDirect(0), () => { directPrepared = true; });
  return made instanceof Promise ? made : null;
}
/** allocateDirect for a caller that cannot wait, once `directReady` has settled */
export function allocateDirectNow(n: number): JBuffer {
  const b = allocateDirect(n);
  if (b instanceof Promise) throw new Error("allocateDirectNow before directReady");
  return b;
}
const unmappers = new FinalizationRegistry<() => PromiseOrVal<void>>((unmap) => { const pending = unmap(); if (pending) void pending.catch(console.error); });
/** a MappedByteBuffer over a mapping at `address`, which `unmap` releases once no buffer shares it */
function mappedBuffer(address: number | bigint, size: number, fd: JObj | null, readOnly: boolean, unmap: () => PromiseOrVal<void>): PromiseOrVal<JBuffer> {
  return after(newObj("java/nio/DirectByteBuffer", "(IJLjava/io/FileDescriptor;Ljava/lang/Runnable;Z)V", size, BigInt(address), fd, null, +readOnly), (b) => {
    unmappers.register(getDeclared<object>(b, "java/nio/DirectByteBuffer", "memoryRef"), unmap);
    return b;
  });
}

/** a read-only MappedByteBuffer over an immutable source, paged in as it is read */
function readOnlyMapping(source: FileSource, offset: number, size: number, fd: JObj | null = null): PromiseOrVal<JBuffer> {
  const address = mapExternal(source, offset, size);
  return mappedBuffer(address, size, fd, true, () => unmapExternal(address));
}
export const readOnlyBuffer = (bytes: Uint8Array): PromiseOrVal<JBuffer> => readOnlyMapping(new BytesFile(bytes), 0, bytes.length);

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
  "charsetForName(Ljava/lang/String;)Ljava/nio/charset/Charset;": waits((name: string) => {
    const cs = charsetNamed(name);
    return cs && newObj("com/android/icu/charset/CharsetICU", "(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)V", cs.name, cs.name, jarray(cs.aliases, "Ljava/lang/String;"));
  }),
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

