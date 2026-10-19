// libcore.io.Memory's natives (libcore_io_Memory.cpp), and the i18n module's copy of the class
// that reads tzdata: raw access to guest memory, which is little-endian as the host is, so a
// `swap` reverses each element's bytes. Addresses from EXTERNAL up are outside guest memory: the
// pages of immutable files (Region).
import { mem } from "../../native/mem.ts";
import { E } from "../../native/abi.ts";
import { rt } from "../runtime.ts";
import { after } from "./jentry.ts";
import { readFully, type FileSource } from "../../shell/lazyfile.ts";
import { mapLease } from "../../native/mappings.ts";
import type { RemoteDescriptor } from "../../native/process-fd.ts";

type Elements = Int8Array | Uint16Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;

const PAGE_SHIFT = 16, PAGE = 1 << PAGE_SHIFT, EXTERNAL = 1n << 48n, REGION_SHIFT = 32n;
/** a mapped range's pages and those being read, shared by every mapping of it: a source the page
 *  shares (the platform data) is read once for all its realms, as a device's page cache holds a file */
interface Paged { pages: (Uint8Array | undefined)[]; loading: Map<number, Promise<void>> }
const mappedPages = new WeakMap<FileSource, Map<string, Paged>>();
/** A read-only mapping of an immutable source: 64 KB pages, each loaded on first touch as a
 *  device's mmap faults it in, so a mapping costs only what is read of it (the ICU data file is
 *  27 MB, of which a date format reads about 2). Native code, which reads memory directly, gets a
 *  copy in guest memory (`guestAddress`). */
class Region {
  private readonly source: FileSource; private readonly offset: number; readonly size: number; readonly release?: () => Promise<void>;
  readonly pages: (Uint8Array | undefined)[];
  private readonly loading: Map<number, Promise<void>>;
  private readonly copies = new Map<string, Uint8Array>();
  guest = 0n;
  constructor(source: FileSource, offset: number, size: number, release?: () => Promise<void>) {
    this.source = source; this.offset = offset; this.size = size; this.release = release;
    const key = `${offset}+${size}`;
    let ranges = mappedPages.get(source), paged = ranges?.get(key);
    if (!ranges) mappedPages.set(source, ranges = new Map());
    if (!paged) ranges.set(key, paged = { pages: new Array((size + PAGE - 1) >>> PAGE_SHIFT), loading: new Map() });
    this.pages = paged.pages; this.loading = paged.loading;
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
  read<T>(at: number, width: number, get: Get<T>): T | Promise<T> {
    const page = this.pages[at >>> PAGE_SHIFT], from = at & (PAGE - 1);
    if (page && from + width <= page.length) return get(new DataView(page.buffer, page.byteOffset + from, width), 0);
    return after(this.load(at, width), () => get(new DataView(this.bytes(at, width).slice().buffer), 0));
  }
}
type Get<T> = (view: DataView, at: number) => T;
/** by region number: address EXTERNAL + (number << 32) + offset */
const regions: (Region | undefined)[] = [];
/** a new region's number and base address */
function addRegion(region: Region): [number, bigint] {
  const n = regions.length;
  regions.push(region);
  return [n, EXTERNAL + (BigInt(n) << REGION_SHIFT)];
}
const REGION = 2 ** Number(REGION_SHIFT), FIRST = Number(EXTERNAL);
// as a double, which holds these addresses exactly: BigInt arithmetic allocates
const regionNumber = (address: bigint): number => Math.floor((Number(address) - FIRST) / REGION);
/** a read-only mapping of [offset, offset + size) of an immutable source, at an address outside guest memory */
export function mapExternal(source: FileSource, offset: number, size: number): bigint {
  return addRegion(new Region(source, offset, size))[1];
}
/** a shared mapping of [offset, offset + size) of another process's file, as a local one is: an immutable file's
 *  pages outside guest memory, any other file's bytes in guest memory, coherent with it as mappings.ts says; the
 *  address, or -errno */
export async function mapRemote(remote: RemoteDescriptor, offset: number, size: number, prot: number): Promise<bigint | number> {
  const lease = await remote.map(offset, size, prot);
  if (typeof lease === "number") return lease;
  if (lease.immutable) return addRegion(new Region({ size, read: (at, n) => lease.read(at, n) }, 0, size, () => lease.close()))[1];
  const va = mem.mapVa(size, prot === 0);
  if (!va) { await lease.close(); return -E.NOMEM; }
  await mapLease(BigInt(va), lease, offset, prot);
  return BigInt(va);
}
export function unmapExternal(address: bigint): void | Promise<void> {
  const n = regionNumber(address), region = regions[n];
  if (region?.guest) mem.unmapVa(region.guest, region.size);
  regions[n] = undefined;
  return region?.release?.();
}
/** the external mapping `address` falls in */
function regionAt(address: bigint): Region {
  const region = regions[regionNumber(address)];
  if (!region) throw rt.mkThrowable("java/lang/InternalError", `unmapped address 0x${address.toString(16)}`);
  return region;
}
/** where `address` is in its external mapping */
const offsetIn = (address: bigint): number => (Number(address) - FIRST) % REGION;
export const isExternal = (address: bigint): boolean => address >= EXTERNAL;
/** null when [address, address + n) of an external mapping is resident, else a Promise */
export const pagesIn = (address: bigint, n: number): Promise<void> | null => regionAt(address).load(offsetIn(address), n);
export const isResident = (address: bigint, n: number): boolean => regionAt(address).resident(offsetIn(address), n);
/** resident external bytes as one run */
export const externalBytes = (address: bigint, n: number): Uint8Array => regionAt(address).bytes(offsetIn(address), n);
/** where native code reads an external mapping: the whole mapping, loaded into guest memory once */
export function guestAddress(address: bigint): number | bigint | Promise<number | bigint> {
  const region = regionAt(address), offset = offsetIn(address);
  return after(region.load(0, region.size), () => {
    if (!region.guest) {
      const va = mem.mapVa(region.size, false);
      if (!va) throw rt.mkThrowable("java/lang/OutOfMemoryError", "mapping a file into native memory");
      const bytes = new Uint8Array(region.size);
      region.copy(0, region.size, bytes, 0);
      mem.write(mem.txVa(BigInt(va)), bytes);
      region.guest = BigInt(va);
    }
    const va = region.guest + BigInt(offset);
    return va <= 0xffffffffn ? Number(va) : va;
  });
}

/** where a native address (a Java long) is in guest memory */
export function physical(address: bigint): number {
  if (isExternal(address)) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "external mapping has no native address");
  return mem.txVa(BigInt.asUintN(64, address));
}
/** n bytes at a native address, as a zlib or checksum native reads or writes them (an external
 *  mapping's once resident, read only) */
export function memoryAt(address: bigint, n: number): Uint8Array | Promise<Uint8Array> {
  if (!isExternal(address)) return mem.bytes(physical(address),n);
  const region = regionAt(address), at = offsetIn(address);
  return after(region.load(at,n),() => region.bytes(at,n));
}
/** n bytes at a native address in guest memory, as a native reads a structure it allocated there */
export function memorySync(address: bigint, n: number): Uint8Array {
  if (isExternal(address)) throw rt.mkThrowable("java/lang/InternalError", `not native memory at 0x${address.toString(16)}`);
  return mem.bytes(physical(address), n);
}

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
/** a store at an external address, which maps an immutable file read only: the fault a device's store would take */
function readOnly(address: bigint): never {
  regionAt(address);
  throw rt.mkThrowable("java/lang/InternalError", `store to a read-only mapping at 0x${address.toString(16)}`);
}
/** a store of `bytes` at a native address (code pages see the write) */
export function writeAt(address: bigint, bytes: Uint8Array): void {
  if (isExternal(address)) readOnly(address);
  mem.write(physical(address), bytes);
}
const peekArray = (address: bigint, array: Elements | null, offset: number, count: number, swap = 0) => {
  const target = region(array, offset, count);
  if (!count) return;
  const n = target.length, size = array!.BYTES_PER_ELEMENT;
  if (!isExternal(address)) { const bytes = mem.bytes(physical(address), n); target.set(swap ? swapped(bytes, size) : bytes); return; }
  return after(memoryAt(address,n),bytes => { target.set(swap ? swapped(bytes,size) : bytes); });
};
const pokeArray = (address: bigint, array: Elements | null, offset: number, count: number, swap = 0) => {
  const source = region(array, offset, count);
  // a set within one buffer copies as memmove does, so a guest-memory array needs no copy first
  if (count) return writeAt(address, swap ? swapped(source, array!.BYTES_PER_ELEMENT) : source);
};
let bufferAddress: ((buffer: object) => bigint) | null = null;
export function setBufferAddress(read: (buffer: object) => bigint): void { bufferAddress = read; }
/** n bytes of a primitive array from byte `at` */
function arrayBytes(o: ArrayBufferView | null, at: number, n: number): Uint8Array {
  if (o === null) return rt.npe();
  return new Uint8Array(o.buffer, o.byteOffset + at, n);
}
/** a primitive array's bytes, or a direct buffer's from its address, as memmove takes them (ScopedBytes) */
const objectBytes = (o: Elements | object | null, at: number, n: number): Uint8Array | Promise<Uint8Array> =>
  o === null || ArrayBuffer.isView(o) ? arrayBytes(o, at, n) : memoryAt(bufferAddress!(o) + BigInt(at), n);
export const externalRead = <T>(address: bigint, width: number, get: Get<T>): T | Promise<T> => regionAt(address).read(offsetIn(address), width, get);
/** junsafe's store at an external address */
export const externalWrite = <T>(address: bigint, _width: number, _value: T, _put: (view: DataView, at: number, value: T) => void): never => readOnly(address);
const I8: Get<number> = (v, i) => v.getInt8(i), I16: Get<number> = (v, i) => v.getInt16(i, true);
const I32: Get<number> = (v, i) => v.getInt32(i, true), I64: Get<bigint> = (v, i) => v.getBigInt64(i, true);

const natives: Record<string, (...args: never[]) => unknown> = {
  "peekByte(J)B": (address: bigint) => isExternal(address) ? externalRead(address, 1, I8) : mem.ld8s(physical(address)),
  "pokeByte(JB)V": (address: bigint, value: number) => isExternal(address) ? readOnly(address) : mem.st8(physical(address), value),
  "peekShortNative(J)S": (address: bigint) => isExternal(address) ? externalRead(address, 2, I16) : mem.ld16s(physical(address)),
  "pokeShortNative(JS)V": (address: bigint, value: number) => isExternal(address) ? readOnly(address) : mem.st16(physical(address), value),
  "peekIntNative(J)I": (address: bigint) => isExternal(address) ? externalRead(address, 4, I32) : mem.ld32(physical(address)),
  "pokeIntNative(JI)V": (address: bigint, value: number) => isExternal(address) ? readOnly(address) : mem.st32(physical(address), value),
  "peekLongNative(J)J": (address: bigint) => isExternal(address) ? externalRead(address, 8, I64) : mem.ld64(physical(address)),
  "pokeLongNative(JJ)V": (address: bigint, value: bigint) => isExternal(address) ? readOnly(address) : mem.st64(physical(address), value),
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
    return after(objectBytes(src,srcOffset,n),from => {
      if (dst !== null && !ArrayBuffer.isView(dst)) return writeAt(bufferAddress!(dst) + BigInt(dstOffset),from);
      const to = arrayBytes(dst as Elements | null,dstOffset,n);
      to.set(from);
    });
  });
// the element array is indexed in elements, the byte array in bytes (libcore_io_Memory.cpp)
rt.registerJni("libcore/io/Memory", "unsafeBulkGet(Ljava/lang/Object;II[BIIZ)V",
  (dst: Elements | null, dstOffset: number, count: number, src: Int8Array | null, srcOffset: number, size: number, swap: number) => {
    const bytes = arrayBytes(src, srcOffset, count);
    arrayBytes(dst, dstOffset * size, count).set(swap ? swapped(bytes, size) : bytes);
  });
rt.registerJni("libcore/io/Memory", "unsafeBulkPut([BIILjava/lang/Object;IIZ)V",
  (dst: Int8Array | null, dstOffset: number, count: number, src: Elements | null, srcOffset: number, size: number, swap: number) => {
    const bytes = arrayBytes(src, srcOffset * size, count);
    arrayBytes(dst, dstOffset, count).set(swap ? swapped(bytes, size) : bytes);
  });
