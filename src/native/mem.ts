// Guest memory: one ArrayBuffer with typed views, a malloc arena, a page allocator for mmap,
// module/stack/host-data regions, and the code-page flags that let a store into executable pages
// invalidate the decoder. See abi.ts for the address map and why the buffer is sized lazily.

import { MEM_SIZE, MEM_SIZE_A32, setMemSize, LOW, PAGE_SHIFT, PAGE_SIZE, STACK_BASE, STACK_END, ARENA_BASE, HOST_DATA, HOST_DATA_END, STACK_GUARD, POOL_BASE } from "./abi";

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
const smallHeads = new Uint32Array(SMALL_MAX / CLASS_STEP + 1);
const bigHeads = new Map<number, number>();
const bigBlocks = new Map<number, number>();
let heapTop = ARENA_BASE, heapPeak = 0, blocks = 0, used = 0;
function classSize(n: number): number {
  if (n <= SMALL_MAX) return Math.max(CLASS_STEP, (n + CLASS_STEP - 1) & ~(CLASS_STEP - 1));
  const k = 31 - Math.clz32(n - 1);                       // 2^k < n <= 2^(k+1)
  const q = 1 << (k - 2);                                 // a quarter of that doubling
  return (Math.ceil(n / q) * q) | 0;
}
/** Page states inside the arena. A reservation (an anonymous PROT_NONE mmap) holds address space,
 *  not pages: reservations may overlap one another, as overcommit lets a process reserve far more
 *  than it has, and a commit (mprotect to readable/writable) is what claims the pages. */
const FREE = 0, RESERVED = 1, USED = 2;
let pages: Uint8Array;
const pageOf = (a: number) => a >>> PAGE_SHIFT;
/** First run of n pages starting at a multiple of `align` pages whose every page is at most
 *  `allow`. A reservation (`phantom`) may run past the arena's end, over the images and beyond
 *  memory: those pages can never be committed, and a reserve-then-trim caller unmaps them at once. */
function findRun(n: number, allow: number, align: number, phantom: boolean): number {
  const end = pageOf(poolBase || moduleBot), top = 0x100000000 / PAGE_SIZE;   // the 32-bit space: past it the guest's pointer arithmetic wraps
  phantom &&= !poolBase;                                          // the pool's chunks are not address space to run over
  for (let s = (pageOf(ARENA_BASE) + align - 1) & -align; s < end && s + n <= top; s = (s + align) & -align) {
    let j = s;
    for (; j < s + n && j < end && pages[j] <= allow; j++);
    if (j === s + n || (j === end && phantom)) return s * PAGE_SIZE;
    if (j < end) s = j;                                    // skip past the page that broke the run
  }
  return 0;
}
/** grow the heap by n bytes through free pages, stepping over a mapping in its way */
function bump(n: number): number {
  for (let p = heapTop; ; ) {
    const a = pageOf(p), b = pageOf(p + n + PAGE_SIZE - 1);
    if (b > pageOf(poolBase || moduleBot)) return 0;
    let j = a + (p & (PAGE_SIZE - 1) ? 1 : 0);              // a partial first page is the heap's own
    while (j < b && pages[j] === FREE) j++;
    if (j === b) {
      heapTop = p + n;
      if (heapTop > heapPeak) heapPeak = heapTop;
      pages.fill(USED, a, b);
      return p;
    }
    p = (j + 1) * PAGE_SIZE;
  }
}


// ── Address planes. A pointer whose high half is h ≠ 0 lives in plane h: one mapping per plane,
// normally starting at PLANE_LO; large reservations span consecutive planes from offset zero.
// A 64-bit runtime reserves address space per allocator far past
// what a 32-bit buffer holds while committing little of it. A plane's committed prefix is one
// contiguous run of the pool at the top of the arena, so a range in the plane is a range in the
// buffer for host and guest alike; a commit past the run grows it in place or moves it (the
// guest keeps its addresses; the move costs a copy of what is committed).
const UNIT = 1 << 25, PLANES = 256, PLANE_LO = 0x10000000;
let poolBase = 0;
let owner = new Int16Array(0);                                   // pool unit → plane, -1 free (sized at alloc)
const P = new Float64Array(PLANES);                              // plane → buffer offset of its run
let moves = 0;
const R = new Float64Array(PLANES), S = new Uint32Array(PLANES), L = new Uint32Array(PLANES);  // reservation, committed prefix, and low base (R = 0: plane free)
const unitsOf = (bytes: number) => Math.ceil(bytes / UNIT);
const poolUnits = () => Math.min(owner.length, Math.floor((moduleBot - poolBase) / UNIT));
function freeRun(units: number, from = 0): number {
  const top = poolUnits();
  for (let i = from, run = 0; i < top; i++) { run = owner[i] < 0 ? run + 1 : 0; if (run === units) return i + 1 - units; }
  return -1;
}
/** the start of the largest free gap that holds `units`: room to grow in place behind a new run */
function widestRun(units: number): number {
  const top = poolUnits();
  let best = -1, bestLen = 0;
  for (let i = 0; i < top; i++) {
    if (owner[i] >= 0) continue;
    let j = i; while (j < top && owner[j] < 0) j++;
    if (j - i >= units && j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  return best;
}
/** the plane's run moves to the free run at `dst` (its `need` units), the guest none the wiser */
function moveRun(h: number, dst: number, need: number): void {
  const at = (P[h] - poolBase) / UNIT, have = unitsOf(S[h]);
  if (dst !== at) { u8.copyWithin(poolBase + dst * UNIT, P[h], P[h] + S[h]); owner.fill(-1, at, at + have); moves++; }
  owner.fill(h, dst, dst + need);
  P[h] = poolBase + dst * UNIT;
}
/** commit the plane's prefix up to `bytes`: extend the run in place, or move it to a free run */
function grow(h: number, bytes: number): boolean {
  const have = unitsOf(S[h]), need = unitsOf(bytes);
  if (need > have) {
    const at = have ? (P[h] - poolBase) / UNIT : -1;
    const dst = at < 0 ? widestRun(need) : freeRun(need - have, at + have) === at + have ? at : freeRun(need);
    if (dst < 0) return false;
    if (at < 0) { owner.fill(h, dst, dst + need); P[h] = poolBase + dst * UNIT; } else moveRun(h, dst, need);
  }
  u8.fill(0, P[h] + S[h], P[h] + bytes);
  S[h] = bytes;
  return true;
}
function release(h: number): void { const at = (P[h] - poolBase) / UNIT; owner.fill(-1, at, at + unitsOf(S[h])); R[h] = S[h] = 0; }
/** host state keyed by a guest object's address: the address the guest knows, which a move keeps */
export class AddrMap<V> {
  private m = new Map<number | bigint, V>();
  get(a: number): V | undefined { return this.m.get(mem.va(a)); }
  set(a: number, v: V): this { this.m.set(mem.va(a), v); return this; }
  delete(a: number): boolean { return this.m.delete(mem.va(a)); }
}
const split = (va: bigint): [number, number] => [Number(va >> 32n) & 0xffffffff, Number(va & 0xffffffffn) >>> 0];

// modules bump DOWN from the top of the shared arena, malloc bumps up from the bottom
let moduleBot = MEM_SIZE, stackTop = STACK_BASE, hostTop = HOST_DATA;
const freeStacks = new Map<number, number[]>();

function alloc(size: number): void {
  // Chromium refuses a plain ArrayBuffer past ~2 GiB but backs a 4 GiB WebAssembly memory, and
  // indexing its buffer costs the same; pages are committed by the OS as they are first touched
  buf = size > 0x7fe0_0000 ? new WebAssembly.Memory({ initial: size / 65536, maximum: size / 65536 }).buffer : new ArrayBuffer(size);
  u8 = new Uint8Array(buf); i8 = new Int8Array(buf); u16 = new Uint16Array(buf); i16 = new Int16Array(buf);
  u32 = new Uint32Array(buf); i32 = new Int32Array(buf); f32 = new Float32Array(buf); f64 = new Float64Array(buf);
  dv = new DataView(buf);
  codePages = new Uint8Array(size >>> PAGE_SHIFT);
  pages = new Uint8Array(size >>> PAGE_SHIFT);
  poolBase = size > POOL_BASE ? POOL_BASE : 0;
  owner = new Int16Array(poolBase ? Math.floor((size - poolBase) / UNIT) : 0).fill(-1);
  R.fill(0); S.fill(0); L.fill(PLANE_LO);
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
    pages.fill(USED, 0, pageOf(heapTop + PAGE_SIZE - 1));
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
      if (p) smallHeads[ci] = u32[p >>> 2];
    } else {
      p = bigHeads.get(cs) ?? 0;
      if (p) bigHeads.set(cs, u32[p >>> 2]);
    }
    if (!p) {
      p = bump(cs + HDR);
      if (!p) return 0;
      p += HDR;
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
    const owner = u32[(p - 8) >>> 2];
    if (owner) p = owner;
    const cs = i32[(p - 4) >>> 2];
    if (cs <= 0 || (cs & 15)) badAddr(p);
    blocks--; used -= cs;
    if (cs <= SMALL_MAX) { i32[p >>> 2] = smallHeads[cs / CLASS_STEP]; smallHeads[cs / CLASS_STEP] = p; }
    else { i32[p >>> 2] = bigHeads.get(cs) ?? 0; bigHeads.set(cs, p); }
  },
  /** whole zeroed pages for mmap and large blocks: first fit over the free runs, else the arena's top */
  /** n bytes of pages: a hole, then fresh heap, and for a reservation the uncommitted part of
   *  other reservations. Pages of a mapping come zeroed; a reservation's are zeroed at commit. */
  mapPages(n: number, reserve = false, alignment = PAGE_SIZE): number {
    n = (n + PAGE_SIZE - 1) & -PAGE_SIZE;
    if (!n) return 0;
    const np = n >>> PAGE_SHIFT;
    // a reservation of 2A is the reserve-then-trim idiom for an A-aligned block: placing it on an
    // A boundary packs the kept blocks back to back instead of leaving an A-sized hole between them
    const align = Math.max(alignment / PAGE_SIZE, reserve && np >= 256 ? 1 << (31 - Math.clz32((np + 1) >> 1)) : 1);
    const p = findRun(np, FREE, align, reserve);
    if (!p) return 0;
    const a = pageOf(p), b = Math.min(a + np, pageOf(moduleBot));
    pages.fill(reserve ? RESERVED : USED, a, b);
    if (!reserve) u8.fill(0, p, p + n);
    return p;
  },
  /** return a page-aligned run (any sub-range of a mapping); false when misaligned */
  unmapPages(addr: number, n: number): boolean {
    n = (n + PAGE_SIZE - 1) & -PAGE_SIZE;
    if (addr & (PAGE_SIZE - 1) || !n || addr < ARENA_BASE) return false;   // the loader's regions are not the process's to unmap
    pages.fill(FREE, pageOf(addr), Math.min(pageOf(addr) + (n >>> PAGE_SHIFT), pageOf(moduleBot)));
    return true;
  },
  /** plane h ≠ 0 address → buffer offset; past the committed prefix is a fault, as the page would be */
  tx(h: number, lo: number): number {
    const off = (lo - L[h]) >>> 0;
    if (h >>> 0 >= PLANES || off >= S[h]) throw new NativeFault(`[native] bad address 0x${(h >>> 0).toString(16)}_${(lo >>> 0).toString(16).padStart(8, "0")} (plane ${h >>> 0}, ${R[h & 255] ? "not committed" : "unmapped"})`);
    return P[h] + off;
  },
  txVa(va: bigint): number { const [h, lo] = split(va); return h ? mem.tx(h, lo) : lo; },
  /** a buffer offset taken before a suspension, found again after it: a plane may have moved */
  rephys(phys: number): number { const v = mem.va(phys); return typeof v === "bigint" ? mem.txVa(v) : phys; },
  /** buffer offset → the address the guest knows it by: itself in plane 0, else the plane's */
  va(phys: number): number | bigint {
    if (!poolBase || phys < poolBase) return phys;
    const h = owner[(phys - poolBase) / UNIT | 0];
    return h === undefined || h < 0 ? phys : (BigInt(h) << 32n) | BigInt(L[h] + (phys - P[h]));
  },
  /** mmap: plane 0 while it has room, else a plane of its own (a reservation commits nothing yet;
   *  a writable mapping is committed whole); 0 when neither has room */
  mapVa(n: number, reserve: boolean): number | bigint {
    if (!Number.isSafeInteger(n) || n <= 0) return 0;
    if (n > 0x100000000 - PLANE_LO) {
      if (!reserve || !poolBase) return 0;
      const count = Math.ceil(n / 0x100000000);
      for (let h = 1; h + count <= PLANES; h++) {
        if (R.subarray(h, h + count).some((r) => r !== 0)) continue;
        for (let i = 0; i < count; i++) { L[h + i] = 0; R[h + i] = Math.min(0x100000000, n - i * 0x100000000); }
        return BigInt(h) << 32n;
      }
      return 0;
    }
    const p = mem.mapPages(n, reserve);
    if (p || !poolBase) return p;
    const h = R.findIndex((r, i) => i > 0 && r === 0);
    if (h < 0 || (!reserve && !grow(h, n))) return 0;
    L[h] = PLANE_LO; R[h] = n;
    return (BigInt(h) << 32n) | BigInt(L[h]);
  },
  /** unmapping the tail shortens the plane; the whole of it frees the plane; a hole is a decommit */
  unmapVa(va: bigint, n: number): boolean {
    if (va & BigInt(PAGE_SIZE - 1) || !Number.isSafeInteger(n) || n <= 0) return false;
    while (n > 0) {
      const [h, lo] = split(va), size = Math.min(n, 0x100000000 - lo);
      if (!h) { if (!mem.unmapPages(lo, size)) return false; }
      else if (h < PLANES && R[h]) {
        const off = lo - L[h];
        if (off <= 0 && size >= R[h]) release(h);
        else if (off + size >= R[h]) { R[h] = off; mem.decommitVa(va, size); }
      }
      n -= size; va += BigInt(size);
    }
    return true;
  },
  reserveVa(va: bigint, n: number): boolean {
    const ranges: [bigint, number][] = [];
    while (n > 0) {
      const [h, lo] = split(va), size = Math.min(n, 0x100000000 - lo);
      if (!h) {
        if (lo < ARENA_BASE || lo + size > (poolBase || moduleBot)) return false;
        for (let p = pageOf(lo); p < pageOf(lo + size + PAGE_SIZE - 1); p++) if (pages[p] === FREE) return false;
      } else if (h >= PLANES || lo < L[h] || lo - L[h] + size > R[h]) return false;
      ranges.push([va, size]); n -= size; va += BigInt(size);
    }
    for (const [addr, size] of ranges) {
      const [h, lo] = split(addr), off = lo - L[h];
      const start = h ? P[h] + off : lo, end = h ? start + Math.max(0, Math.min(size, S[h] - off)) : lo + size;
      for (let p = pageOf(start); p < pageOf(end + PAGE_SIZE - 1); p++) if (codePages[p]) mem.onCodeWrite(p * PAGE_SIZE);
      if (h) mem.dropVa(addr, size);
      mem.decommitVa(addr, size);
    }
    return true;
  },
  commitVa(va: bigint, n: number): boolean {
    const [h, lo] = split(va);
    if (!h) return mem.commitPages(lo, n);
    const end = lo - L[h] + n;
    return h < PLANES && lo >= L[h] && end <= R[h] && (end <= S[h] || grow(h, end));
  },
  /** the prefix only shrinks from its end; a hole stays committed (its pages are the plane's) */
  /** MADV_DONTNEED on a private anonymous mapping: what is committed of it reads back as zero */
  dropVa(va: bigint, n: number): void {
    const [h, lo] = split(va);
    if (!h) {
      // only a mapping of the process's own is a private anonymous page to drop; the images and the loader's data are not
      if (lo < ARENA_BASE || lo + n > (poolBase || moduleBot)) { console.warn(`[mem-native] madvise(DONTNEED) outside the arena ignored: 0x${lo.toString(16)}+0x${n.toString(16)}`); return; }
      u8.fill(0, lo, lo + n); return;
    }
    const off = lo - L[h];
    if (off < S[h]) u8.fill(0, P[h] + off, P[h] + Math.min(S[h], off + n));
  },
  decommitVa(va: bigint, n: number): void {
    const [h, lo] = split(va);
    if (!h) { mem.decommitPages(lo, n); return; }
    const off = lo - L[h];
    if (off < S[h] && off + n >= S[h]) { owner.fill(-1, (P[h] - poolBase) / UNIT + unitsOf(off), (P[h] - poolBase) / UNIT + unitsOf(S[h])); S[h] = off; }
  },
  /** mprotect to accessible: a reserved page becomes a zeroed page of its own; false (ENOMEM) on
   *  an unmapped or phantom one. Pages below the arena are the images' and the loader's own. */
  commitPages(addr: number, n: number): boolean {
    if (addr < ARENA_BASE) return false;
    const a = pageOf(addr), b = pageOf(addr + n + PAGE_SIZE - 1);
    if (b > pageOf(moduleBot)) return false;
    for (let i = a; i < b; i++) if (pages[i] === FREE) return false;
    for (let i = a; i < b; i++) if (pages[i] === RESERVED) { pages[i] = USED; u8.fill(0, i * PAGE_SIZE, (i + 1) * PAGE_SIZE); }
    return true;
  },
  /** mprotect to PROT_NONE: the pages go back to being address space */
  decommitPages(addr: number, n: number): void {
    const a = Math.max(pageOf(addr), pageOf(ARENA_BASE)), b = Math.min(pageOf(addr + n + PAGE_SIZE - 1), pageOf(moduleBot));
    for (let i = a; i < b; i++) if (pages[i] === USED) pages[i] = RESERVED;
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
    if (align >= PAGE_SIZE && (align & (align - 1)) === 0) { const p = mem.mapPages(n, false, align); if (p) { bigBlocks.set(p, n); blocks++; used += n; } return p; }
    const raw = mem.malloc(n + align + HDR);
    if (!raw || bigBlocks.has(raw)) return raw;
    const p = ((raw + HDR + align - 1) & -align) >>> 0;
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
    const base = ((moduleBot - size) & -align) >>> 0;   // int32 masking; the image region sits above 2 GiB
    // the pool's top units become the image's: a plane run up there moves down first
    if (poolBase) {
      const keep = Math.floor((base - poolBase) / UNIT);
      for (let h = 1; h < PLANES; h++) {
        if (!R[h] || !S[h]) continue;
        const at = (P[h] - poolBase) / UNIT, need = unitsOf(S[h]);
        if (at + need <= keep) continue;
        owner.fill(-1, at, at + need);                                          // its own units count as free for the search
        const dst = (() => { for (let i = 0, run = 0; i < keep; i++) { run = owner[i] < 0 ? run + 1 : 0; if (run === need) return i + 1 - need; } return -1; })();
        owner.fill(h, at, at + need);
        if (dst < 0) throw new NativeFault(`[native] out of module address space (${(size / 1048576).toFixed(1)} MiB wanted, the pool holds plane ${h})`);
        moveRun(h, dst, need);
      }
    }
    for (let i = pageOf(base); i < pageOf(moduleBot); i++) if (pages[i] === USED) throw new NativeFault(`[native] out of module address space (${(size / 1048576).toFixed(1)} MiB wanted, the pool reaches the images)`);
    if (base < heapTop) throw new NativeFault(`[native] out of module address space (${(size / 1048576).toFixed(1)} MiB wanted, ${((moduleBot - heapTop) / 1048576).toFixed(1)} free)`);
    moduleBot = base;
    return base;
  },
  allocStack(size: number): { base: number; top: number } {
    const base = freeStacks.get(size)?.pop() ?? stackTop + STACK_GUARD;
    const top = base + size;
    if (top > STACK_END) throw new NativeFault("[native] out of stack address space");
    if (top > stackTop) stackTop = top;
    return { base, top };
  },
  /** a finished thread's stack goes back for the next thread of that size */
  freeStack(base: number, top: number): void { let l = freeStacks.get(top - base); if (!l) freeStacks.set(top - base, (l = [])); l.push(base); },
  /** host-owned guest data (FILE structs, JNI tables, ctype tables, static strings): bump only */
  hostAlloc(n: number, align = 8): number {
    const p = (hostTop + align - 1) & -align;
    if (p + n > HOST_DATA_END) throw new NativeFault("[native] out of host data space");
    hostTop = p + n;
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
  stats(): { used: number; blocks: number; peak: number; size: number; free: number; planes: number; chunks: number; moves: number } {
    return { used, blocks, peak: heapPeak - ARENA_BASE, size: MEM_SIZE, free: moduleBot - heapTop, planes: R.filter((r) => r > 0).length, chunks: owner.filter((o) => o >= 0).length, moves };
  },
};
alloc(MEM_SIZE_A32);
