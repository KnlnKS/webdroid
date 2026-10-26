// The memory pool ARM32 processes share. Each ashmem region of the realm that made the pool (the
// page, whose kernel owns every process's regions) is a run of it, and a MAP_SHARED mapping of one
// is a run of the window (window.ts) of the process that maps it whose pages show the region's, so
// every process's stores, and the atomics that order them, reach the same bytes.
import { PAGE_SIZE, WINDOW_SIZE } from "./abi.ts";
import { Runs, attachPool, attachedPool, poolBytes } from "./window.ts";
import type { VfsFile } from "../shell/vfs.ts";

const WASM_PAGE = 0x10000;
const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;

/** the pool this realm made and allocates regions from */
let made: { memory: WebAssembly.Memory; runs: Runs } | null = null;
/** the pool, made here when no realm handed one over and this one may share memory with its Workers */
export function sharedPool(): WebAssembly.Memory | null {
  const have = attachedPool();
  if (have || globalThis.crossOriginIsolated === false) return have;
  let memory: WebAssembly.Memory;
  try { memory = new WebAssembly.Memory({ initial: 0, maximum: WINDOW_SIZE / WASM_PAGE, shared: true }); }
  catch { return null; }
  made = { memory, runs: new Runs(WINDOW_SIZE, (top) => {
    const grow = Math.ceil(top / WASM_PAGE) - memory.buffer.byteLength / WASM_PAGE;
    try { if (grow > 0) memory.grow(grow); return true; } catch { return false; }
  }) };
  attachPool(memory);
  return memory;
}

/** an ashmem region's protection mask, which only narrows, and its offset in the pool when it is a run of it */
export type Region = { prot: number; pool?: number };
/** an ashmem region of `size` zeroed bytes: a run of the pool where this realm allocates one */
export function ashmemContent(size: number): { content: VfsFile; region: Region } {
  sharedPool();
  const off = size > 0 ? made?.runs.take(pages(size)) ?? null : null;
  return off === null ? { content: { path: null, data: new Uint8Array(size), len: size }, region: { prot: 7 } }
    : { content: { path: null, data: poolBytes(off, size), len: size }, region: { prot: 7, pool: off } };
}
/** a region's last close: its run goes back to the pool zeroed, and a copy mapping that outlives it keeps its own bytes */
export function releaseRegion(content: VfsFile, region: Region): void {
  const off = region.pool;
  if (off === undefined || !made) return;
  content.data = content.sharedMaps ? content.data.slice() : new Uint8Array(0);
  region.pool = undefined;
  poolBytes(off, pages(content.len)).fill(0);
  made.runs.give(off, pages(content.len));
}
