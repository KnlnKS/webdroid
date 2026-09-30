// libcore.io.Memory's natives (libcore_io_Memory.cpp), and the i18n module's copy of the class
// that reads tzdata: raw access to guest memory, which is little-endian as the host is, so a
// `swap` reverses each element's bytes. Addresses from EXTERNAL up are read-only mappings of
// immutable files kept outside guest memory (see Region).
import { mem } from "../../native/mem";
import { rt } from "../runtime";
import { after } from "./jlang";
import { readFully, type FileSource } from "../../shell/lazyfile";

type Elements = Int8Array | Uint16Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;

const PAGE_SHIFT = 16, PAGE = 1 << PAGE_SHIFT, EXTERNAL = 1n << 48n, REGION_SHIFT = 32n;
/** A read-only mapping of an immutable source: 64 KB pages, each loaded on first touch as a
 *  device's mmap faults it in, so a mapping costs only what is read of it (the ICU data file is
 *  27 MB, of which a date format reads about 2). Native code, which reads memory directly, gets a
 *  copy in guest memory (`guestAddress`). */
class Region {
  readonly pages: (Uint8Array | undefined)[];
  private readonly loading = new Map<number, Promise<void>>();
  private readonly copies = new Map<string, Uint8Array>();
  guest = 0n;
  constructor(readonly base: bigint, private readonly source: FileSource, private readonly offset: number, readonly size: number) {
    this.pages = new Array((size + PAGE - 1) >>> PAGE_SHIFT);
  }
  resident(at: number, n: number): boolean {
    for (let p = at >>> PAGE_SHIFT, last = (at + n - 1) >> PAGE_SHIFT; p <= last; p++) if (!this.pages[p]) return false;
    return true;
  }
  /** null when [at, at + n) is resident, else a Promise that settles once it is */
  load(at: number, n: number): Promise<void> | null {
    if (at < 0 || n < 0 || at + n > this.size) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", `mapping range ${at}+${n} of ${this.size}`);
    let waits: Promise<void>[] | null = null;
    for (let p = at >>> PAGE_SHIFT, last = (at + n - 1) >> PAGE_SHIFT; p <= last; p++)
      if (!this.pages[p]) (waits ??= []).push(this.loading.get(p) ?? this.fetch(p));
    return waits && (waits.length === 1 ? waits[0] : Promise.all(waits).then(() => {}));
  }
  private fetch(p: number): Promise<void> {
    const start = p << PAGE_SHIFT, n = Math.min(PAGE, this.size - start);
    const wait = readFully(this.source, this.offset + start, n).then((data) => {
      if (data.length !== n) throw new Error(`short read of a mapped page at ${this.offset + start}`);
      this.pages[p] = data;
    }).finally(() => this.loading.delete(p));
    this.loading.set(p, wait);
    return wait;
  }
  /** resident [at, at + n) into `out` at `to` */
  copy(at: number, n: number, out: Uint8Array, to: number): void {
    for (let end = at + n; at < end;) {
      const page = this.pages[at >>> PAGE_SHIFT]!, from = at & (PAGE - 1), k = Math.min(end - at, page.length - from);
      out.set(page.subarray(from, from + k), to);
      at += k; to += k;
    }
  }
  /** resident [at, at + n) as one run: its page, or a copy of the pages it spans kept for reuse */
  bytes(at: number, n: number): Uint8Array {
    const page = this.pages[at >>> PAGE_SHIFT], from = at & (PAGE - 1);
    if (!n) return new Uint8Array(0);
    if (at >>> PAGE_SHIFT === (at + n - 1) >>> PAGE_SHIFT) return page!.subarray(from, from + n);
    const k = `${at}+${n}`;
    let run = this.copies.get(k);
    if (!run) { run = new Uint8Array(n); this.copy(at, n, run, 0); this.copies.set(k, run); }
    return run;
  }
  /** a read of `width` bytes at `at` */
  read<T>(at: number, width: number, get: (view: DataView, i: number) => T): T | Promise<T> {
    const page = this.pages[at >>> PAGE_SHIFT], from = at & (PAGE - 1);
    if (page && from + width <= page.length) return get(new DataView(page.buffer, page.byteOffset + from, width), 0);
    return after(this.load(at, width), () => get(new DataView(this.bytes(at, width).slice().buffer), 0));
  }
}
const regions = new Map<bigint, Region>();
let nextRegion = 0n;
/** a read-only mapping of [offset, offset + size) of an immutable source, at an address outside guest memory */
export function mapExternal(source: FileSource, offset: number, size: number): bigint {
  const base = EXTERNAL + (nextRegion++ << REGION_SHIFT);
  regions.set(base, new Region(base, source, offset, size));
  return base;
}
export function unmapExternal(address: bigint): void {
  const region = regions.get(address);
  if (region?.guest) mem.unmapVa(region.guest, region.size);
  regions.delete(address);
}
/** the external mapping `address` falls in, and where */
function regionAt(address: bigint): [Region, number] {
  const region = regions.get(EXTERNAL + ((address - EXTERNAL) >> REGION_SHIFT << REGION_SHIFT));
  if (!region) throw rt.mkThrowable("java/lang/InternalError", `unmapped address 0x${address.toString(16)}`);
  return [region, Number(address - region.base)];
}
export const isExternal = (address: bigint): boolean => address >= EXTERNAL;
/** null when [address, address + n) of an external mapping is resident, else a Promise */
export function pagesIn(address: bigint, n: number): Promise<void> | null {
  const [region, at] = regionAt(address);
  return region.load(at, n);
}
export function isResident(address: bigint, n: number): boolean {
  const [region, at] = regionAt(address);
  return region.resident(at, n);
}
/** resident external bytes as one run */
export function externalBytes(address: bigint, n: number): Uint8Array {
  const [region, at] = regionAt(address);
  return region.bytes(at, n);
}
/** where native code reads an external mapping: the whole mapping, loaded into guest memory once */
export function guestAddress(address: bigint): number | bigint | Promise<number | bigint> {
  const [region, at] = regionAt(address);
  return after(region.load(0, region.size), () => {
    if (!region.guest) {
      const va = mem.mapVa(region.size, false);
      if (!va) throw rt.mkThrowable("java/lang/OutOfMemoryError", "mapping a file into native memory");
      const bytes = new Uint8Array(region.size);
      region.copy(0, region.size, bytes, 0);
      mem.write(mem.txVa(BigInt(va)), bytes);
      region.guest = BigInt(va);
    }
    const va = region.guest + BigInt(at);
    return va <= 0xffffffffn ? Number(va) : va;
  });
}

const physical = (address: bigint) => mem.txVa(BigInt.asUintN(64, address));
/** n bytes at a native address, as a zlib or checksum native reads or writes them (an external
 *  mapping's once resident, read only) */
export const memoryAt = (address: bigint, n: number): Uint8Array | Promise<Uint8Array> =>
  isExternal(address) ? after(pagesIn(address, n), () => externalBytes(address, n)) : mem.bytes(physical(address), n);

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
const readOnly = (address: bigint) => rt.mkThrowable("java/lang/InternalError", `store to a read-only mapping at 0x${address.toString(16)}`);
const peekArray = (address: bigint, array: Elements | null, offset: number, count: number, swap = 0) => {
  const target = region(array, offset, count);
  if (!count) return;
  const n = target.length, size = array!.BYTES_PER_ELEMENT;
  if (!isExternal(address)) { const bytes = mem.bytes(physical(address), n); target.set(swap ? swapped(bytes, size) : bytes); return; }
  return after(pagesIn(address, n), () => { const bytes = externalBytes(address, n); target.set(swap ? swapped(bytes, size) : bytes); });
};
const pokeArray = (address: bigint, array: Elements | null, offset: number, count: number, swap = 0) => {
  if (isExternal(address)) throw readOnly(address);
  const source = region(array, offset, count);
  // a set within one buffer copies as memmove does, so a guest-memory array needs no copy first
  if (count) mem.write(physical(address), swap ? swapped(source, array!.BYTES_PER_ELEMENT) : source);
};
let bufferAddress: ((buffer: object) => bigint) | null = null;
export function setBufferAddress(read: (buffer: object) => bigint): void { bufferAddress = read; }
/** a primitive array's bytes, or a direct buffer's from its address, as memmove takes them (ScopedBytes) */
function objectBytes(o: Elements | object | null, at: number, n: number): Uint8Array | Promise<Uint8Array> {
  if (o === null) return rt.npe();
  if (ArrayBuffer.isView(o)) return new Uint8Array(o.buffer, o.byteOffset + at, n);
  return memoryAt(bufferAddress!(o) + BigInt(at), n);
}
const external = <T>(address: bigint, width: number, get: (view: DataView) => T): T | Promise<T> => {
  const [region, at] = regionAt(address);
  return region.read(at, width, get);
};

const natives: Record<string, (...args: never[]) => unknown> = {
  "peekByte(J)B": (address: bigint) => isExternal(address) ? external(address, 1, (v) => v.getInt8(0)) : mem.ld8s(physical(address)),
  "pokeByte(JB)V": (address: bigint, value: number) => { if (isExternal(address)) throw readOnly(address); mem.st8(physical(address), value); },
  "peekShortNative(J)S": (address: bigint) => isExternal(address) ? external(address, 2, (v) => v.getInt16(0, true)) : mem.ld16s(physical(address)),
  "pokeShortNative(JS)V": (address: bigint, value: number) => { if (isExternal(address)) throw readOnly(address); mem.st16(physical(address), value); },
  "peekIntNative(J)I": (address: bigint) => isExternal(address) ? external(address, 4, (v) => v.getInt32(0, true)) : mem.ld32(physical(address)),
  "pokeIntNative(JI)V": (address: bigint, value: number) => { if (isExternal(address)) throw readOnly(address); mem.st32(physical(address), value); },
  "peekLongNative(J)J": (address: bigint) => isExternal(address) ? external(address, 8, (v) => v.getBigInt64(0, true)) : mem.ld64(physical(address)),
  "pokeLongNative(JJ)V": (address: bigint, value: bigint) => { if (isExternal(address)) throw readOnly(address); mem.st64(physical(address), value); },
  "peekByteArray(J[BII)V": peekArray,
  "pokeByteArray(J[BII)V": pokeArray,
};
for (const [t, sig] of [["Char", "C"], ["Short", "S"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Double", "D"]]) {
  natives[`peek${t}Array(J[${sig}IIZ)V`] = peekArray;
  natives[`poke${t}Array(J[${sig}IIZ)V`] = pokeArray;
}
// MappedByteBuffer.load touches each page through Unsafe
rt.registerJni("jdk/internal/misc/Unsafe", "getByte(J)B", natives["peekByte(J)B"]);
for (const [sig, fn] of Object.entries(natives)) {
  rt.registerJni("libcore/io/Memory", sig, fn);
  rt.registerJni("com/android/i18n/timezone/internal/Memory", sig, fn);
}
// between arrays and direct buffers (or within one): byte offsets and counts, as NIO's buffers use them
rt.registerJni("libcore/io/Memory", "memmove(Ljava/lang/Object;ILjava/lang/Object;IJ)V",
  (dst: Elements | object | null, dstOffset: number, src: Elements | object | null, srcOffset: number, count: bigint) => {
    const n = Number(count);
    return after(objectBytes(src, srcOffset, n), (from) => after(objectBytes(dst, dstOffset, n), (to) => {
      if (to.buffer === from.buffer) to.set(from.slice()); else to.set(from);
    }));
  });
// the element array is indexed in elements, the byte array in bytes (libcore_io_Memory.cpp)
rt.registerJni("libcore/io/Memory", "unsafeBulkGet(Ljava/lang/Object;II[BIIZ)V",
  (dst: Elements | null, dstOffset: number, count: number, src: Int8Array | null, srcOffset: number, size: number, swap: number) => {
    const bytes = objectBytes(src, srcOffset, count) as Uint8Array;
    (objectBytes(dst, dstOffset * size, count) as Uint8Array).set(swap ? swapped(bytes, size) : bytes);
  });
rt.registerJni("libcore/io/Memory", "unsafeBulkPut([BIILjava/lang/Object;IIZ)V",
  (dst: Int8Array | null, dstOffset: number, count: number, src: Elements | null, srcOffset: number, size: number, swap: number) => {
    const bytes = objectBytes(src, srcOffset * size, count) as Uint8Array;
    (objectBytes(dst, dstOffset, count) as Uint8Array).set(swap ? swapped(bytes, size) : bytes);
  });
