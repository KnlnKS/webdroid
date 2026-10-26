// An ARM32 process's window (abi.WINDOW) onto the memory pool its processes share (shm.ts): the
// pool, its views, the pool offset each window page shows, the mappings there, and the core's
// imports that reach them. The core's page flags hold each window page's protection.
import { MEM_SIZE, MEM_SIZE_A32, PAGE_SHIFT, PAGE_SIZE, WINDOW, WINDOW_SIZE } from "./abi.ts";
import { core } from "./core.ts";
import { BadAddress } from "./faults.ts";

const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;
/** first-fit runs of `limit` bytes: the free runs below `top` by offset, and everything from `top` on */
export class Runs {
  private free: { off: number; n: number }[] = [];
  private top = 0;
  private limit: number;
  private reach: (top: number) => boolean;
  constructor(limit: number, reach: (top: number) => boolean = () => true) { this.limit = limit; this.reach = reach; }
  take(n: number): number | null {
    const i = this.free.findIndex((run) => run.n >= n);
    if (i >= 0) {
      const run = this.free[i], off = run.off;
      run.off += n; run.n -= n;
      if (!run.n) this.free.splice(i, 1);
      return off;
    }
    if (this.top + n > this.limit || !this.reach(this.top + n)) return null;
    this.top += n;
    return this.top - n;
  }
  give(off: number, n: number): void {
    const free = this.free;
    let i = free.findIndex((run) => run.off > off);
    if (i < 0) i = free.length;
    free.splice(i, 0, { off, n });
    if (i + 1 < free.length && off + n === free[i + 1].off) { free[i].n += free[i + 1].n; free.splice(i + 1, 1); }
    if (i > 0 && free[i - 1].off + free[i - 1].n === off) { free[i - 1].n += free[i].n; free.splice(i, 1); }
    const last = free.at(-1);
    if (last && last.off + last.n === this.top) { this.top = last.off; free.pop(); }
  }
}

/** whether this process has a window, which only an ARM32 process has, and whether a is in it */
export const hasWindow = (): boolean => MEM_SIZE === MEM_SIZE_A32;
export const inWindow = (a: number): boolean => hasWindow() && (a >>> 0) >= WINDOW;
/** the pool, once the process has one: it grows in whichever realm allocates from it, so the views follow it to what an access reaches */
let pool: WebAssembly.Memory | null = null;
/** the pool's bytes, as far as an access has reached */
export let pu8 = new Uint8Array(0);
let pu16 = new Uint16Array(0), pi32 = new Int32Array(0), pi64 = new BigInt64Array(0), pdv = new DataView(pu8.buffer);
function poolTo(end: number): void {
  if (end <= pu8.length) return;
  const buf = pool?.buffer;
  if (!buf || end > buf.byteLength) throw new BadAddress(BigInt(end), `[native] pool offset 0x${end.toString(16)} past the pool`);
  pu8 = new Uint8Array(buf); pu16 = new Uint16Array(buf, 0, buf.byteLength >> 1); pi32 = new Int32Array(buf, 0, buf.byteLength >> 2);
  pi64 = new BigInt64Array(buf, 0, buf.byteLength >> 3); pdv = new DataView(buf);
}
/** the pool this realm made, or the page's that a process Worker joins */
export function attachPool(memory: WebAssembly.Memory): void { pool = memory; }
export const attachedPool = (): WebAssembly.Memory | null => pool;
/** the pool's bytes [off, off + n) */
export function poolBytes(off: number, n: number): Uint8Array { poolTo(off + n); return pu8.subarray(off, off + n); }

/** the pool offset each page of this process's window shows, -1 where none */
let windowPages: Int32Array | null = null;
const pageOf = (va: number) => ((va >>> 0) - WINDOW) >>> PAGE_SHIFT;
/** A mapping's run of the window, and a page past it that stays unmapped, so that the pages of any
 *  mapped stretch are one run of the pool. It holds its region until its last page is unmapped. */
type Hold = { va: number; n: number; mapped: number; release(): unknown };
let holds: Hold[] = [];
const windowRuns = new Runs(WINDOW_SIZE);
/** a MAP_SHARED mapping of [off, off + n) of the region at pool offset `region`, which holds the
 *  region until unmapped (`release`); null when there is no room left in the window */
export function mapWindow(region: number, off: number, n: number, prot: number, release: () => unknown): number | null {
  n = pages(n);
  const at = windowRuns.take(n + PAGE_SIZE);
  if (at === null) return null;
  const va = WINDOW + at, table = windowPages ??= new Int32Array(WINDOW_SIZE >>> PAGE_SHIFT).fill(-1);
  core.window_map(va, n, prot);
  for (let i = 0; i < n >>> PAGE_SHIFT; i++) table[(at >>> PAGE_SHIFT) + i] = region + off + i * PAGE_SIZE;
  holds.push({ va, n, mapped: n >>> PAGE_SHIFT, release });
  return va;
}
/** munmap of [va, va + n) of the window */
export function unmapWindow(va: number, n: number): void {
  const end = Math.min(va + n, WINDOW + WINDOW_SIZE), table = windowPages;
  if (!table || end <= va) return;
  for (const hold of holds) {
    for (let a = Math.max(hold.va, va); a < Math.min(hold.va + hold.n, end); a += PAGE_SIZE) if (table[pageOf(a)] >= 0) hold.mapped--;
  }
  table.fill(-1, pageOf(va), pageOf(end - 1) + 1);
  core.window_map(va, end - va, -1);
  holds = holds.filter((hold) => {
    if (hold.mapped) return true;
    windowRuns.give(hold.va - WINDOW, hold.n + PAGE_SIZE);
    void hold.release();
    return false;
  });
}
/** the pool offset of window address a, through n bytes on: a run the core has checked is mapped, all in one mapping */
export function poolOffset(a: number, n: number): number {
  const page = windowPages?.[pageOf(a)] ?? -1;
  if (page < 0) throw new BadAddress(BigInt(a >>> 0), `[native] window address 0x${(a >>> 0).toString(16)} unmapped`);
  const off = page + (a & (PAGE_SIZE - 1));
  poolTo(off + n);
  return off;
}
/** guest address `a` (an i32 from the core) as an offset into what holds it: the pool, or the core's memory */
const at = (a: number, n: number): number => (a >>>= 0) >= WINDOW ? poolOffset(a, n) : a;
/** the core's imports that reach the window's bytes, which a core over `memory` has checked are mapped */
export function windowImports(memory: WebAssembly.Memory) {
  let core8 = new Uint8Array(0);
  const holder = (a: number): Uint8Array => (a >>> 0) >= WINDOW ? pu8 : core8.buffer === memory.buffer ? core8 : core8 = new Uint8Array(memory.buffer);
  return {
    shm_load(a: number, n: number): number {
      const off = poolOffset(a, n);
      return n === 4 ? off & 3 ? pdv.getInt32(off, true) : pi32[off >> 2] : n === 2 ? off & 1 ? pdv.getUint16(off, true) : pu16[off >> 1] : pu8[off];
    },
    shm_store(a: number, n: number, v: number): void {
      const off = poolOffset(a, n);
      if (n === 4) { if (off & 3) pdv.setInt32(off, v, true); else pi32[off >> 2] = v; }
      else if (n === 2) { if (off & 1) pdv.setUint16(off, v, true); else pu16[off >> 1] = v; }
      else pu8[off] = v;
    },
    shm_cas(a: number, n: number, expected: number, v: number): number {
      const off = poolOffset(a, n);
      return n === 4 ? Atomics.compareExchange(pi32, off >> 2, expected, v) : n === 2 ? Atomics.compareExchange(pu16, off >> 1, expected & 0xffff, v & 0xffff)
        : Atomics.compareExchange(pu8, off, expected & 0xff, v & 0xff);
    },
    shm_cas64(a: number, expected: bigint, v: bigint): number { return +(Atomics.compareExchange(pi64, poolOffset(a, 8) >> 3, expected, v) === expected); },
    shm_copy(d: number, s: number, n: number): void {
      const i = at(d, n), j = at(s, n), to = holder(d), from = holder(s);
      if (to === from) to.copyWithin(i, j, j + n); else to.set(from.subarray(j, j + n), i);
    },
    shm_fill(d: number, v: number, n: number): void { const off = poolOffset(d, n); pu8.fill(v, off, off + n); },
  };
}
