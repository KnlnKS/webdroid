// The memory pool ARM32 processes share. Each ashmem region of the realm that made the pool (the
// page, whose kernel owns every process's regions) is a run of it, and a MAP_SHARED mapping of one
// is a run of the window (abi.WINDOW) of the process that maps it whose pages show the region's, so
// every process's stores, and the atomics that order them, reach the same bytes.
import { MEM_SIZE, MEM_SIZE_A32, PAGE_SIZE, WINDOW, WINDOW_SIZE } from "./abi.ts";
import { core } from "./core.ts";
import { attachPool, poolBytes, showWindow } from "./window.ts";
import type { VfsFile } from "../shell/vfs.ts";

const WASM_PAGE = 0x10000;
const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;

/** first-fit runs of `limit` bytes: the free runs below `top` by offset, and everything from `top` on */
class Runs {
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

let pool: WebAssembly.Memory | null = null, regions: Runs | null = null;
/** the pool, made here when no realm handed one over and this one may share memory with its Workers */
export function sharedPool(): WebAssembly.Memory | null {
  if (pool || globalThis.crossOriginIsolated === false) return pool;
  let made: WebAssembly.Memory;
  try { made = new WebAssembly.Memory({ initial: 0, maximum: WINDOW_SIZE / WASM_PAGE, shared: true }); }
  catch { return null; }
  regions = new Runs(WINDOW_SIZE, (top) => {
    const grow = Math.ceil(top / WASM_PAGE) - made.buffer.byteLength / WASM_PAGE;
    try { if (grow > 0) made.grow(grow); return true; } catch { return false; }
  });
  attachPool(pool = made);
  return pool;
}
/** a process Worker's join of the page's pool */
export function joinPool(memory: WebAssembly.Memory): void { attachPool(pool = memory); }

/** an ashmem region of `size` zeroed bytes: a run of the pool where this realm allocates one */
export function ashmemContent(size: number): VfsFile {
  const off = sharedPool() && regions ? regions.take(pages(size)) : null;
  return off === null ? { path: null, data: new Uint8Array(size), len: size, ashmem: { prot: 7 } }
    : { path: null, data: poolBytes(off, size), len: size, ashmem: { prot: 7, pool: off } };
}
/** a region's last close: its run goes back to the pool zeroed, and a copy mapping that outlives it keeps its own bytes */
export function releaseRegion(content: VfsFile): void {
  const off = content.ashmem?.pool;
  if (off === undefined) return;
  content.data = content.sharedMaps ? content.data.slice() : new Uint8Array(0);
  content.ashmem!.pool = undefined;
  poolBytes(off, pages(content.len)).fill(0);
  regions!.give(off, pages(content.len));
}

/** A mapping's part in this process's window. Its whole run of the window, and the region, stay the
 *  mapping's until its last page goes; a page past each run stays unmapped, so that the pages of any
 *  mapped stretch are one run of the pool. */
type WindowMap = { va: number; n: number; prot: number; hold: { refs: number; va: number; n: number; release(): unknown } };
let windowMaps: WindowMap[] = [];
const windowRuns = new Runs(WINDOW_SIZE);
/** a MAP_SHARED mapping of [off, off + n) of the region at pool offset `region`, which holds the
 *  region until unmapped (`release`); null when the process has no window or no room left in it */
export function mapWindow(region: number, off: number, n: number, prot: number, release: () => unknown): number | null {
  n = pages(n);
  const at = MEM_SIZE === MEM_SIZE_A32 ? windowRuns.take(n + PAGE_SIZE) : null, va = WINDOW + (at ?? 0);
  if (at === null) return null;
  core.window_map(va, n, prot);
  showWindow(va, n, region + off);
  windowMaps.push({ va, n, prot, hold: { refs: 1, va, n: n + PAGE_SIZE, release } });
  return va;
}
/** munmap of [va, va + n) of the window */
export function unmapWindow(va: number, n: number): void {
  windowMaps = windowMaps.flatMap((m) => split(m, va, va + n, (part) => { core.window_map(part.va, part.n, 0); showWindow(part.va, part.n, -1); return false; }));
}
/** mprotect of [va, va + n) of the window, over the pages its mappings cover */
export function protectWindow(va: number, n: number, prot: number): void {
  windowMaps = windowMaps.flatMap((m) => split(m, va, va + n, (part) => { part.prot = prot; core.window_map(part.va, part.n, prot); return true; }));
}
/** m's parts outside [lo, hi), and the part within where `inside` keeps it */
function split(m: WindowMap, lo: number, hi: number, inside: (part: WindowMap) => boolean): WindowMap[] {
  const a = Math.max(m.va, lo), b = Math.min(m.va + m.n, hi);
  if (a >= b) return [m];
  const mid = { ...m, va: a, n: b - a }, parts: WindowMap[] = [];
  if (m.va < a) parts.push({ ...m, n: a - m.va });
  if (inside(mid)) parts.push(mid);
  if (b < m.va + m.n) parts.push({ ...m, va: b, n: m.va + m.n - b });
  const hold = m.hold;
  if (!(hold.refs += parts.length - 1)) { windowRuns.give(hold.va - WINDOW, hold.n); void hold.release(); }
  return parts;
}
