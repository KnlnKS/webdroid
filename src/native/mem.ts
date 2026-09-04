// Guest memory: one ArrayBuffer with typed views, a malloc arena, a page allocator for mmap,
// module/stack/host-data regions, and the code-page flags that let a store into executable pages
// invalidate the decoder. See abi.ts for the address map and why the buffer is sized lazily.

import { MEM_SIZE, MEM_SIZE_A32, setMemSize, LOW, PAGE_SHIFT, PAGE_SIZE, STACK_BASE, STACK_END, ARENA_BASE, HOST_DATA, HOST_DATA_END, STACK_GUARD } from "./abi";

export class NativeFault extends Error {
  pc = 0;
}

let buf: ArrayBuffer, u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array, dv: DataView, codePages: Uint8Array;
let SPAN = 0;
const enc = new TextEncoder(), dec = new TextDecoder();

function checkAddr(a: number, n: number): void {
  if (((a >>> 0) - LOW) >>> 0 > SPAN - n) badAddr(a);
}
function badAddr(a: number): never {
  const e = new NativeFault(`[native] bad address 0x${(a >>> 0).toString(16)}`);
  throw e;
}

// ── malloc arena: 16-byte size classes to 1 KiB, four classes per doubling to 256 KiB, whole
// pages above that. The header is 16 bytes before the block, which keeps every block 16-aligned
// as bionic guarantees: [p-8] = owning block for aligned allocations or 0, [p-4] = class size.
// Page-sized blocks carry no header and are looked up in `bigBlocks`.
const CLASS_STEP = 16, SMALL_MAX = 1024, PAGE_MAX = 0x40000, HDR = 16;
const smallHeads = new Int32Array(SMALL_MAX / CLASS_STEP + 1);
const bigHeads = new Map<number, number>();
const bigBlocks = new Map<number, number>();
let heapTop = ARENA_BASE, heapPeak = 0, blocks = 0, used = 0;
function classSize(n: number): number {
  if (n <= SMALL_MAX) return Math.max(CLASS_STEP, (n + CLASS_STEP - 1) & ~(CLASS_STEP - 1));
  const k = 31 - Math.clz32(n - 1);                       // 2^k < n <= 2^(k+1)
  const q = 1 << (k - 2);                                 // a quarter of that doubling
  return (Math.ceil(n / q) * q) | 0;
}
/** free page runs inside the arena, sorted by address and coalesced */
const freePages: { addr: number; size: number }[] = [];

// modules bump DOWN from the top of the shared arena, malloc bumps up from the bottom
let moduleBot = MEM_SIZE, stackTop = STACK_BASE, hostTop = HOST_DATA;

function alloc(size: number): void {
  buf = new ArrayBuffer(size);
  u8 = new Uint8Array(buf); i8 = new Int8Array(buf); u16 = new Uint16Array(buf); i16 = new Int16Array(buf);
  u32 = new Uint32Array(buf); i32 = new Int32Array(buf); f32 = new Float32Array(buf); f64 = new Float64Array(buf);
  dv = new DataView(buf);
  codePages = new Uint8Array(size >> PAGE_SHIFT);
  SPAN = size - LOW;
  setMemSize(size);
  Object.assign(mem, { buf, u8, i8, u16, i16, u32, i32, f32, f64, dv, codePages });
}

export const mem = {
  buf: null as unknown as ArrayBuffer, u8: null as unknown as Uint8Array, i8: null as unknown as Int8Array, u16: null as unknown as Uint16Array, i16: null as unknown as Int16Array,
  u32: null as unknown as Uint32Array, i32: null as unknown as Int32Array, f32: null as unknown as Float32Array, f64: null as unknown as Float64Array,
  dv: null as unknown as DataView, codePages: null as unknown as Uint8Array,
  onCodeWrite: (_addr: number): void => {},
  /** run after the buffer is (re)sized: the block cache's page tables are sized from it */
  initHooks: [] as (() => void)[],
  /** size the process's memory. Everything below heapTop is carried over; the image region is
   *  reset, so this happens before the first image loads (setA64), never after. */
  init(size: number): void {
    if (size === MEM_SIZE) return;
    const old = u8, keep = Math.min(heapTop, size);
    alloc(size);
    u8.set(old.subarray(0, keep));
    moduleBot = size;
    freePages.length = 0;
    for (const h of mem.initHooks) h();
  },

  ld32(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); return (a & 3) === 0 ? i32[a >>> 2] : dv.getInt32(a >>> 0, true); },
  ld16u(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 2) badAddr(a); return (a & 1) === 0 ? u16[a >>> 1] : dv.getUint16(a >>> 0, true); },
  ld16s(a: number): number { return (mem.ld16u(a) << 16) >> 16; },
  ld8u(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a); return u8[a >>> 0]; },
  ld8s(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a); return i8[a >>> 0]; },
  st32(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a);
    if ((a & 3) === 0) i32[a >>> 2] = v; else dv.setInt32(a >>> 0, v, true);
    if (codePages[a >>> PAGE_SHIFT]) mem.onCodeWrite(a);
  },
  st16(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 2) badAddr(a);
    if ((a & 1) === 0) u16[a >>> 1] = v; else dv.setUint16(a >>> 0, v, true);
    if (codePages[a >>> PAGE_SHIFT]) mem.onCodeWrite(a);
  },
  st8(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a);
    u8[a >>> 0] = v;
    if (codePages[a >>> PAGE_SHIFT]) mem.onCodeWrite(a);
  },
  ldf32(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); return (a & 3) === 0 ? f32[a >>> 2] : dv.getFloat32(a >>> 0, true); },
  stf32(a: number, v: number): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); if ((a & 3) === 0) f32[a >>> 2] = v; else dv.setFloat32(a >>> 0, v, true); },
  ldf64(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); return (a & 7) === 0 ? f64[a >>> 3] : dv.getFloat64(a >>> 0, true); },
  stf64(a: number, v: number): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); if ((a & 7) === 0) f64[a >>> 3] = v; else dv.setFloat64(a >>> 0, v, true); },
  ld64(a: number): bigint { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); return dv.getBigInt64(a >>> 0, true); },
  st64(a: number, v: bigint): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); dv.setBigInt64(a >>> 0, v, true); },

  malloc(n: number): number {
    n = n >>> 0;
    if (n > PAGE_MAX) {
      const p = mem.mapPages(n);
      if (p) { bigBlocks.set(p, n); blocks++; used += n; }
      return p;
    }
    const cs = classSize(n);
    let p: number;
    if (cs <= SMALL_MAX) {
      const ci = cs / CLASS_STEP;
      p = smallHeads[ci];
      if (p) smallHeads[ci] = i32[p >>> 2];
    } else {
      p = bigHeads.get(cs) ?? 0;
      if (p) bigHeads.set(cs, i32[p >>> 2]);
    }
    if (!p) {
      p = heapTop + HDR;
      heapTop = p + cs;
      if (heapTop > moduleBot) { heapTop = p - HDR; return 0; }
      if (heapTop > heapPeak) heapPeak = heapTop;
    }
    i32[(p - 8) >>> 2] = 0;
    i32[(p - 4) >>> 2] = cs;
    blocks++; used += cs;
    return p;
  },
  free(p: number): void {
    if (!p) return;
    const big = bigBlocks.get(p);
    if (big !== undefined) { bigBlocks.delete(p); blocks--; used -= big; mem.unmapPages(p, big); return; }
    const owner = i32[(p - 8) >>> 2];
    if (owner) p = owner;
    const cs = i32[(p - 4) >>> 2];
    if (cs <= 0 || (cs & 15)) badAddr(p);
    blocks--; used -= cs;
    if (cs <= SMALL_MAX) { i32[p >>> 2] = smallHeads[cs / CLASS_STEP]; smallHeads[cs / CLASS_STEP] = p; }
    else { i32[p >>> 2] = bigHeads.get(cs) ?? 0; bigHeads.set(cs, p); }
  },
  /** whole zeroed pages for mmap and large blocks: first fit over the free runs, else the arena's top */
  mapPages(n: number): number {
    n = (n + PAGE_SIZE - 1) & -PAGE_SIZE;
    if (!n) return 0;
    for (let i = 0; i < freePages.length; i++) {
      const r = freePages[i];
      if (r.size < n) continue;
      const p = r.addr;
      if (r.size === n) freePages.splice(i, 1); else { r.addr += n; r.size -= n; }
      u8.fill(0, p, p + n);
      return p;
    }
    const p = (heapTop + PAGE_SIZE - 1) & -PAGE_SIZE;
    if (p + n > moduleBot) return 0;
    heapTop = p + n;
    if (heapTop > heapPeak) heapPeak = heapTop;
    return p;
  },
  /** return a page-aligned run (any sub-range of a mapping) to the free runs; false when misaligned */
  unmapPages(addr: number, n: number): boolean {
    n = (n + PAGE_SIZE - 1) & -PAGE_SIZE;
    if (addr & (PAGE_SIZE - 1) || !n) return false;
    let i = 0;
    while (i < freePages.length && freePages[i].addr < addr) i++;
    freePages.splice(i, 0, { addr, size: n });
    if (i + 1 < freePages.length && freePages[i].addr + n === freePages[i + 1].addr) { freePages[i].size += freePages[i + 1].size; freePages.splice(i + 1, 1); }
    if (i > 0 && freePages[i - 1].addr + freePages[i - 1].size === addr) { freePages[i - 1].size += freePages[i].size; freePages.splice(i, 1); }
    return true;
  },
  realloc(p: number, n: number): number {
    if (!p) return mem.malloc(n);
    if (n === 0) { mem.free(p); return 0; }
    const cur = mem.usableSize(p);
    if (n <= cur && n >= cur >> 2 && !bigBlocks.has(p)) return p;
    const q = mem.malloc(n);
    if (!q) return 0;
    u8.copyWithin(q, p, p + Math.min(n, cur));
    mem.free(p);
    return q;
  },
  calloc(n: number, m: number): number {
    const p = mem.malloc(n * m);
    if (p) u8.fill(0, p, p + n * m);
    return p;
  },
  memalign(align: number, n: number): number {
    if (align <= 16) return mem.malloc(n);
    if (align >= PAGE_SIZE && (align & (align - 1)) === 0 && align <= PAGE_SIZE) { const p = mem.mapPages(n); if (p) { bigBlocks.set(p, n); blocks++; used += n; } return p; }
    const raw = mem.malloc(n + align + HDR);
    if (!raw || bigBlocks.has(raw)) { if (raw) { const p = (raw + align - 1) & -align; if (p === raw) return raw; bigBlocks.delete(raw); bigBlocks.set(p, n); return p; } return 0; }
    const p = (raw + HDR + align - 1) & -align;
    i32[(p - 8) >>> 2] = raw;
    i32[(p - 4) >>> 2] = n;
    return p;
  },
  valloc(n: number): number { return mem.memalign(PAGE_SIZE, n); },
  usableSize(p: number): number {
    if (!p) return 0;
    return bigBlocks.get(p) ?? i32[(p - 4) >>> 2];
  },
  /** address space for a module image: never freed, 64 KiB aligned by default */
  reserve(size: number, align = 0x10000): number {
    const base = (moduleBot - size) & -align;
    if (base < heapTop) throw new NativeFault(`[native] out of module address space (${(size / 1048576).toFixed(1)} MiB wanted, ${((moduleBot - heapTop) / 1048576).toFixed(1)} free)`);
    moduleBot = base;
    return base;
  },
  allocStack(size: number): { base: number; top: number } {
    const base = stackTop + STACK_GUARD;
    const top = base + size;
    stackTop = top;
    if (top > STACK_END) throw new NativeFault("[native] out of stack address space");
    return { base, top };
  },
  /** host-owned guest data (FILE structs, JNI tables, ctype tables, static strings): bump only */
  hostAlloc(n: number, align = 8): number {
    const p = (hostTop + align - 1) & -align;
    hostTop = p + n;
    if (hostTop > HOST_DATA_END) throw new NativeFault("[native] out of host data space");
    return p;
  },

  cstr(a: number, max = 0x100000): string {
    if (!a) return "";
    checkAddr(a, 1);
    let e = a >>> 0;
    const lim = Math.min(e + max, MEM_SIZE);
    while (e < lim && u8[e] !== 0) e++;
    return dec.decode(u8.subarray(a >>> 0, e));
  },
  /** writes s + NUL (truncating to max-1 bytes when max is given); returns bytes written excluding NUL */
  putCstr(a: number, s: string, max = 0x7fffffff): number {
    const b = enc.encode(s);
    const n = Math.min(b.length, max - 1);
    if (n < 0) return 0;
    checkAddr(a, n + 1);
    u8.set(b.subarray(0, n), a >>> 0);
    u8[(a >>> 0) + n] = 0;
    return n;
  },
  strlen(a: number): number {
    checkAddr(a, 1);
    let e = a >>> 0;
    while (u8[e] !== 0) e++;
    return e - (a >>> 0);
  },
  bytes(a: number, n: number): Uint8Array { checkAddr(a, n); return u8.subarray(a >>> 0, (a >>> 0) + n); },
  write(a: number, src: Uint8Array | ArrayLike<number>): void { checkAddr(a, src.length); u8.set(src, a >>> 0); },
  memcpy(d: number, s: number, n: number): void { if (n <= 0) return; checkAddr(d, n); checkAddr(s, n); u8.copyWithin(d >>> 0, s >>> 0, (s >>> 0) + n); },
  memmove(d: number, s: number, n: number): void { mem.memcpy(d, s, n); },
  memset(d: number, v: number, n: number): void { if (n <= 0) return; checkAddr(d, n); u8.fill(v & 0xff, d >>> 0, (d >>> 0) + n); },
  strdup(s: string): number {
    const b = enc.encode(s);
    const p = mem.malloc(b.length + 1);
    u8.set(b, p); u8[p + b.length] = 0;
    return p;
  },
  /** a static string in host data (never freed) */
  hostStr(s: string): number {
    const b = enc.encode(s);
    const p = mem.hostAlloc(b.length + 1, 1);
    u8.set(b, p); u8[p + b.length] = 0;
    return p;
  },
  stats(): { used: number; blocks: number; peak: number; size: number; free: number } { return { used, blocks, peak: heapPeak - ARENA_BASE, size: MEM_SIZE, free: moduleBot - heapTop }; },
};
alloc(MEM_SIZE_A32);
