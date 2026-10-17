// Guest memory: the core's linear memory with typed views and the host-side accessors, and the
// allocator, page, plane and region calls forwarded to the core (mem.zig). See abi.ts for the
// address map. The code-page flags let a store into executable pages invalidate the decoder.

import { core, memory, shared, NativeFault, BadAddress, onMemoryGrown } from "./core.ts";
import { MEM_SIZE, MEM_SIZE_INITIAL, setMemSize, LOW, PAGE_SHIFT, PAGE_SIZE, MEM_SIZE_A32, MEM_SIZE_A64 } from "./abi.ts";
import { utf8 } from "../jvm/abi.ts";

let buf: ArrayBuffer, u8: Uint8Array, i8: Int8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array, dv: DataView, codePages: Uint8Array;
/** the committed bytes past LOW: a host access beyond them is to no page in use */
let SPAN = 0;
/** a 64-bit process: any buffer offset may be a plane's pool unit */
let planes = false;
/** every buffer the memory has had: views made before a grow keep the one they were made over */
const buffers = new WeakSet<ArrayBufferLike>();

/** a host access of n bytes: in range, and backed where it lands in a plane (which may commit
 *  the plane's writable pages under it) */
function checkAddr(a: number, n: number): void {
  if (n === 0) return; // an empty access touches no page (JNI's NewString(NULL, 0), a zero-length write)
  if (((a >>> 0) - LOW) >>> 0 > SPAN - n) badAddr(a);
  if (planes && !core.commit_phys(a >>> 0, n)) throw new BadAddress(BigInt(mem.va(a >>> 0)), `[native] host access past a plane's writable pages at 0x${(a >>> 0).toString(16)}+0x${n.toString(16)}`);
}
function localBytes(a: number, n: number): Uint8Array { checkAddr(a, n); return u8.subarray(a >>> 0, (a >>> 0) + n); }
/** Invalidate executed code before a host write that may partially trap, or after an atomic write. */
export function wrote(a: number, n: number): void {
  if (n <= 0) return;
  const end = Math.min((a >>> 0) + n - 1, 0xffffffff) >>> PAGE_SHIFT;
  for (let pg = a >>> PAGE_SHIFT; pg <= end; pg++) if (codePages[pg] & 1) { core.code_write(a >>> 0, n); return; }
}
function badAddr(a: number): never {
  throw new BadAddress(BigInt(a >>> 0), `[native] bad address 0x${(a >>> 0).toString(16)}`);
}
function views(): void {
  buf = memory.buffer;
  buffers.add(buf);
  SPAN = buf.byteLength - LOW;
  u8 = new Uint8Array(buf); i8 = new Int8Array(buf); u16 = new Uint16Array(buf);
  u32 = new Uint32Array(buf); i32 = new Int32Array(buf); f32 = new Float32Array(buf); f64 = new Float64Array(buf);
  dv = new DataView(buf);
  codePages = new Uint8Array(buf, core.flags_ptr(), MEM_SIZE_A64 >>> PAGE_SHIFT);
  Object.assign(mem, { buf, u8, u16, u32, i32, f32 });
}
/** host state keyed by a guest object's address: the address the guest knows, which a move keeps */
export class AddrMap<V> {
  private m = new Map<number | bigint, V>();
  get(a: number): V | undefined { return this.m.get(mem.va(a)); }
  set(a: number, v: V): this { this.m.set(mem.va(a), v); return this; }
  delete(a: number): boolean { return this.m.delete(mem.va(a)); }
  ensure(a: number, make: () => V): V { const k = mem.va(a); let v = this.m.get(k); if (v === undefined) this.m.set(k, (v = make())); return v; }
}
const split = (va: bigint): [number, number] => [Number(va >> 32n) & 0xffffffff, Number(va & 0xffffffffn) >>> 0];
const num = (v: bigint): number | bigint => (v <= 0xffffffffn ? Number(v) : v);

export const mem = {
  buf: null as unknown as ArrayBuffer, u8: null as unknown as Uint8Array, u16: null as unknown as Uint16Array,
  u32: null as unknown as Uint32Array, i32: null as unknown as Int32Array, f32: null as unknown as Float32Array,
  /** run after an unshared memory is committed whole, which detached every view of it */
  initHooks: [] as (() => void)[],
  /** size the process's address space: everything allocated so far carries over, and the
   *  memory is committed as the guest uses it (or now, when growing it would detach views) */
  init(size: number): void {
    if (size === MEM_SIZE) return;
    if (!shared && size > buf.byteLength) { memory.grow((size - buf.byteLength) / 65536); views(); for (const h of mem.initHooks) h(); }
    core.mem_init(size);
    setMemSize(size);
    planes = size > MEM_SIZE_A32;
  },
  /** a view of guest memory */
  isGuest: (view: ArrayBufferView): boolean => buffers.has(view.buffer),

  ld32(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); return (a & 3) === 0 ? i32[a >>> 2] : dv.getInt32(a >>> 0, true); },
  ld16u(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 2) badAddr(a); return (a & 1) === 0 ? u16[a >>> 1] : dv.getUint16(a >>> 0, true); },
  ld16s(a: number): number { return (mem.ld16u(a) << 16) >> 16; },
  ld8u(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a); return u8[a >>> 0]; },
  ld8s(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a); return i8[a >>> 0]; },
  st32(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a);
    if ((a & 3) === 0) i32[a >>> 2] = v; else dv.setInt32(a >>> 0, v, true);
    wrote(a, 4);
  },
  st16(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 2) badAddr(a);
    if ((a & 1) === 0) u16[a >>> 1] = v; else dv.setUint16(a >>> 0, v, true);
    wrote(a, 2);
  },
  st8(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a);
    u8[a >>> 0] = v;
    wrote(a, 1);
  },
  ldf32(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); return (a & 3) === 0 ? f32[a >>> 2] : dv.getFloat32(a >>> 0, true); },
  stf32(a: number, v: number): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); if ((a & 3) === 0) f32[a >>> 2] = v; else dv.setFloat32(a >>> 0, v, true); wrote(a, 4); },
  ldf64(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); return (a & 7) === 0 ? f64[a >>> 3] : dv.getFloat64(a >>> 0, true); },
  stf64(a: number, v: number): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); if ((a & 7) === 0) f64[a >>> 3] = v; else dv.setFloat64(a >>> 0, v, true); wrote(a, 8); },
  ld64(a: number): bigint { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); return dv.getBigInt64(a >>> 0, true); },
  st64(a: number, v: bigint): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); dv.setBigInt64(a >>> 0, v, true); wrote(a, 8); },

  /** a plane-0 address of a page the memory backs: not below LOW, nor past the pages in use */
  backed: (a: number): boolean => ((a >>> 0) - LOW) >>> 0 < SPAN,
  /** a plane-0 page a guest store faults on: a stack's guard gap, the core's own data */
  writeProtected: (a: number): boolean => !!(codePages[a >>> PAGE_SHIFT] & 2),
  malloc: (n: number): number => core.malloc(n >>> 0) >>> 0,
  free(p: number): void { if (p && !core.free(p >>> 0)) badAddr(p); },
  calloc: (n: number, m: number): number => core.calloc(n >>> 0, m >>> 0) >>> 0,
  realloc: (p: number, n: number): number => core.realloc(p >>> 0, n >>> 0) >>> 0,
  memalign: (align: number, n: number): number => core.memalign(align >>> 0, n >>> 0) >>> 0,
  /** n bytes of pages: a hole, then fresh heap, and for a reservation the uncommitted part of
   *  other reservations. Pages of a mapping come zeroed; a reservation's are zeroed at commit. */
  mapPages: (n: number, reserve = false, alignment = PAGE_SIZE): number => core.map_pages(n >>> 0, reserve ? 1 : 0, alignment) >>> 0,
  /** return a page-aligned run (any sub-range of a mapping); false when misaligned */
  unmapPages: (addr: number, n: number): boolean => core.unmap_pages(addr >>> 0, n >>> 0) !== 0,
  /** mprotect to accessible: reserved pages become zeroed; image pages retain their bytes. */
  commitPages: (addr: number, n: number): boolean => core.commit_pages(addr >>> 0, n >>> 0) !== 0,
  /** mprotect to PROT_NONE: the pages go back to being address space */
  decommitPages: (addr: number, n: number): void => core.decommit_pages(addr >>> 0, n >>> 0),
  /** plane h ≠ 0 address → buffer offset; past the committed prefix is a fault, as the page would be */
  tx(h: number, lo: number): number {
    const p = core.tx(h >>> 0, lo >>> 0) >>> 0;
    if (!p) throw new BadAddress(BigInt(h >>> 0) << 32n | BigInt(lo >>> 0), `[native] bad address 0x${(h >>> 0).toString(16)}_${(lo >>> 0).toString(16).padStart(8, "0")} (plane ${h >>> 0}, ${core.plane_reserved(h) ? "not committed" : "unmapped"})`);
    return p;
  },
  txVa(va: bigint): number { const [h, lo] = split(va); return h ? mem.tx(h, lo) : lo; },
  /** buffer offset → the address the guest knows it by: itself in plane 0, else the plane's */
  va: (phys: number): number | bigint => (planes ? num(core.va(phys >>> 0)) : phys),
  /** mmap: plane 0 while it has room, else a plane of its own; 0 when neither has room */
  mapVa: (n: number, reserve: boolean, low = false): number | bigint => (!Number.isSafeInteger(n) || n <= 0 ? 0 : num(core.map_va(BigInt(n), reserve ? 1 : 0, low ? 1 : 0))),
  unmapVa: (va: bigint, n: number): boolean => Number.isSafeInteger(n) && n > 0 && core.unmap_va(va, BigInt(n)) !== 0,
  /** grow the mapping [va, va + n) to `size` in place: false when the address space after it is taken */
  extendVa: (va: bigint, n: number, size: number): boolean => core.extend_va(va, BigInt(n), BigInt(size)) !== 0,
  /** MAP_FIXED: free address space at [va, va + n) becomes reserved; false where the core keeps it */
  mapFixed: (va: bigint, n: number): boolean => Number.isSafeInteger(n) && n > 0 && core.map_fixed(va, BigInt(n)) !== 0,
  reserveVa(va: bigint, n: number): boolean {
    const ranges: [bigint, number][] = [];
    while (n > 0) {
      const [h, lo] = split(va), size = Math.min(n, 0x100000000 - lo);
      if (!core.check_reserve(h, lo, size)) return false;
      ranges.push([va, size]); n -= size; va += BigInt(size);
    }
    for (const [addr, size] of ranges) {
      const [h, lo] = split(addr);
      const start = (h ? core.tx(h, lo) : lo) >>> 0;
      if (start) core.invalidate_range(start, size);
      if (h) mem.dropVa(addr, size);
      mem.decommitVa(addr, size);
    }
    return true;
  },
  commitVa: (va: bigint, n: number): boolean => core.commit_va(va, BigInt(n)) !== 0,
  residentVa: (va: bigint): number => core.resident_va(va),
  /** MADV_DONTNEED on a private anonymous mapping: what is committed of it reads back as zero */
  dropVa(va: bigint, n: number): void {
    if (!core.drop_va(va, BigInt(n))) console.warn(`[mem-native] madvise(DONTNEED) outside the arena ignored: 0x${Number(va).toString(16)}+0x${n.toString(16)}`);
  },
  decommitVa: (va: bigint, n: number): void => core.decommit_va(va, BigInt(n)),
  /** address space for a module image: never freed, 64 KiB aligned by default */
  reserve(size: number, align = 0x10000): number {
    const base = core.reserve(size >>> 0, align) >>> 0;
    if (base) return base;
    throw new NativeFault(`[native] out of module address space (${(size / 1048576).toFixed(1)} MiB wanted, ${(mem.stats().free / 1048576).toFixed(1)} above the heap)`);
  },
  /** an unloaded image's space, which the next reserve may reuse */
  releaseImage: (base: number, size: number): void => core.release_image(base >>> 0, size >>> 0),
  allocStack(size: number): { base: number; top: number } {
    const base = core.alloc_stack(size >>> 0) >>> 0;
    if (!base) throw new NativeFault("[native] out of stack address space");
    return { base, top: base + size };
  },
  /** a finished thread's stack goes back for the next thread of that size */
  freeStack: (base: number, top: number): void => core.free_stack(base, top - base),
  /** host-owned guest data (FILE structs, JNI tables, ctype tables, static strings): bump only */
  hostAlloc(n: number, align = 8): number {
    const p = core.host_alloc(n >>> 0, align) >>> 0;
    if (!p) throw new NativeFault("[native] out of host data space");
    return p;
  },

  cstr(a: number, max = 0x100000): string {
    if (!a) return "";
    checkAddr(a, 1);
    const bytes = u8.subarray(a >>> 0, (a >>> 0) + max), end = bytes.indexOf(0);
    return utf8.dec.decode(end < 0 ? bytes : bytes.subarray(0, end));
  },
  /** writes s + NUL (truncating to max-1 bytes when max is given); returns bytes written excluding NUL */
  putCstr(a: number, s: string, max = 0x7fffffff): number {
    const b = utf8.enc.encode(s);
    const n = Math.min(b.length, max - 1);
    if (n < 0) return 0;
    checkAddr(a, n + 1);
    u8.set(b.subarray(0, n), a >>> 0);
    u8[(a >>> 0) + n] = 0;
    wrote(a, n + 1);
    return n;
  },
  strlen(a: number): number {
    checkAddr(a, 1);
    const e = u8.indexOf(0, a >>> 0);
    return (e < 0 ? u8.length : e) - (a >>> 0);
  },
  bytes: localBytes,
  write(a: number, src: Uint8Array | ArrayLike<number>): void { checkAddr(a, src.length); u8.set(src, a >>> 0); wrote(a, src.length); },
  memmove(d: number, s: number, n: number): void { if (n <= 0) return; checkAddr(d, n); checkAddr(s, n); u8.copyWithin(d >>> 0, s >>> 0, (s >>> 0) + n); wrote(d, n); },
  memset(d: number, v: number, n: number): void { if (n <= 0) return; checkAddr(d, n); u8.fill(v & 0xff, d >>> 0, (d >>> 0) + n); wrote(d, n); },
  strdup(s: string): number {
    const b = utf8.enc.encode(s);
    const p = mem.malloc(b.length + 1);
    u8.set(b, p); u8[p + b.length] = 0;
    return p;
  },
  /** a static string in host data (never freed) */
  hostStr(s: string): number {
    const b = utf8.enc.encode(s);
    const p = mem.hostAlloc(b.length + 1, 1);
    u8.set(b, p); u8[p + b.length] = 0;
    return p;
  },
  stats(): { used: number; blocks: number; peak: number; size: number; free: number; planes: number; chunks: number; moves: number } {
    return { used: core.stat(0), blocks: core.stat(1), peak: core.stat(2), size: core.stat(3), free: core.stat(4), planes: core.stat(5), chunks: core.stat(6), moves: core.stat(7) };
  },
};
export const guestAt = (base: number | bigint, offset = 0): number => (typeof base === "bigint" ? mem.txVa(base + BigInt(offset)) : base + offset);
/** a buffer offset an await may outlive, since a plane can move under it: called, the offset it
 *  has now (0 stays 0) */
export function anchor(p: number): (offset?: number) => number {
  if (!p) return () => 0;
  const va = mem.va(p);
  return (offset = 0) => guestAt(va, offset);
}
views();
onMemoryGrown(views);
core.mem_init(MEM_SIZE_INITIAL);
