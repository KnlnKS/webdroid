// libcore.io.Memory's natives (libcore_io_Memory.cpp), and the i18n module's copy of the class
// that reads tzdata: raw access to guest memory, which is little-endian as the host is, so a
// `swap` reverses each element's bytes.
import { mem } from "../../native/mem";
import { rt } from "../runtime";

type Elements = Int8Array | Uint16Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;

const physical = (address: bigint) => mem.txVa(BigInt.asUintN(64, address));

/** the bytes of `count` elements of `array` from `offset`, bounds-checked as JNI's Get/SetArrayRegion */
function region(array: Elements | null, offset: number, count: number): Uint8Array {
  if (array === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (offset < 0 || count < 0 || offset > array.length - count) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
  const size = array.BYTES_PER_ELEMENT;
  return new Uint8Array(array.buffer, array.byteOffset + offset * size, count * size);
}
/** a copy of `bytes` with each `size`-byte element reversed */
function swapped(bytes: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += size) for (let j = 0; j < size; j++) out[i + j] = bytes[i + size - 1 - j];
  return out;
}
const peekArray = (address: bigint, array: Elements | null, offset: number, count: number, swap = 0) => {
  const target = region(array, offset, count);
  if (!count) return;
  const bytes = mem.bytes(physical(address), target.length);
  target.set(swap ? swapped(bytes, array!.BYTES_PER_ELEMENT) : bytes);
};
const pokeArray = (address: bigint, array: Elements | null, offset: number, count: number, swap = 0) => {
  const source = region(array, offset, count);
  if (count) mem.write(physical(address), swap ? swapped(source, array!.BYTES_PER_ELEMENT) : source.slice());
};
/** a primitive array's bytes, addressed in bytes as memmove and the bulk copies take them */
const arrayBytes = (array: Elements | null) => array === null ? rt.npe() : new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

const natives: Record<string, (...args: never[]) => unknown> = {
  "peekByte(J)B": (address: bigint) => mem.ld8s(physical(address)),
  "pokeByte(JB)V": (address: bigint, value: number) => { mem.st8(physical(address), value); },
  "peekShortNative(J)S": (address: bigint) => mem.ld16s(physical(address)),
  "pokeShortNative(JS)V": (address: bigint, value: number) => { mem.st16(physical(address), value); },
  "peekIntNative(J)I": (address: bigint) => mem.ld32(physical(address)),
  "pokeIntNative(JI)V": (address: bigint, value: number) => { mem.st32(physical(address), value); },
  "peekLongNative(J)J": (address: bigint) => mem.ld64(physical(address)),
  "pokeLongNative(JJ)V": (address: bigint, value: bigint) => { mem.st64(physical(address), value); },
  "peekByteArray(J[BII)V": peekArray,
  "pokeByteArray(J[BII)V": pokeArray,
};
for (const [t, sig] of [["Char", "C"], ["Short", "S"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Double", "D"]]) {
  natives[`peek${t}Array(J[${sig}IIZ)V`] = peekArray;
  natives[`poke${t}Array(J[${sig}IIZ)V`] = pokeArray;
}
for (const [sig, fn] of Object.entries(natives)) {
  rt.registerJni("libcore/io/Memory", sig, fn);
  rt.registerJni("com/android/i18n/timezone/internal/Memory", sig, fn);
}
// between arrays (or within one): byte offsets and counts, as NIO's heap buffers use them
rt.registerJni("libcore/io/Memory", "memmove(Ljava/lang/Object;ILjava/lang/Object;IJ)V",
  (dst: Elements | null, dstOffset: number, src: Elements | null, srcOffset: number, count: bigint) => {
    arrayBytes(dst).set(arrayBytes(src).subarray(srcOffset, srcOffset + Number(count)), dstOffset);
  });
rt.registerJni("libcore/io/Memory", "unsafeBulkGet(Ljava/lang/Object;II[BIIZ)V",
  (dst: Elements | null, dstOffset: number, count: number, src: Int8Array | null, srcOffset: number, size: number, swap: number) => {
    const bytes = arrayBytes(src).subarray(srcOffset, srcOffset + count);
    arrayBytes(dst).set(swap ? swapped(bytes, size) : bytes, dstOffset);
  });
rt.registerJni("libcore/io/Memory", "unsafeBulkPut([BIILjava/lang/Object;IIZ)V",
  (dst: Int8Array | null, dstOffset: number, count: number, src: Elements | null, srcOffset: number, size: number, swap: number) => {
    const bytes = arrayBytes(src).subarray(srcOffset, srcOffset + count);
    arrayBytes(dst).set(swap ? swapped(bytes, size) : bytes, dstOffset);
  });
