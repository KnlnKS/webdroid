// An ARM32 process's window (abi.WINDOW) onto the memory pool its processes share (shm.ts): the
// pool's views, the pool offset each window page shows, and the core's imports that reach them.
import { MEM_SIZE, MEM_SIZE_A32, PAGE_SHIFT, PAGE_SIZE, WINDOW, WINDOW_SIZE } from "./abi.ts";
import { BadAddress } from "./faults.ts";

/** whether a is in this process's window, which only an ARM32 process has */
export const inWindow = (a: number): boolean => MEM_SIZE === MEM_SIZE_A32 && (a >>> 0) >= WINDOW;
/** the pool, once the process has one: it grows in whichever realm allocates from it, so the views follow it to what an access reaches */
let pool: WebAssembly.Memory | null = null;
let pu8 = new Uint8Array(0), pu16 = new Uint16Array(0), pi32 = new Int32Array(0), pi64 = new BigInt64Array(0), pdv = new DataView(pu8.buffer);
function poolTo(end: number): void {
  if (end <= pu8.length) return;
  const buf = pool?.buffer;
  if (!buf || end > buf.byteLength) throw new BadAddress(BigInt(end), `[native] pool offset 0x${end.toString(16)} past the pool`);
  pu8 = new Uint8Array(buf); pu16 = new Uint16Array(buf, 0, buf.byteLength >> 1); pi32 = new Int32Array(buf, 0, buf.byteLength >> 2);
  pi64 = new BigInt64Array(buf, 0, buf.byteLength >> 3); pdv = new DataView(buf);
}
export function attachPool(memory: WebAssembly.Memory): void { pool = memory; }
/** the pool's bytes [off, off + n) */
export function poolBytes(off: number, n: number): Uint8Array { poolTo(off + n); return pu8.subarray(off, off + n); }
/** the pool offset each page of this process's window shows, -1 where none; a mapping is one run of a region's pages */
let windowPages: Int32Array | null = null;
export function showWindow(va: number, n: number, off: number): void {
  const pages = windowPages ??= new Int32Array(WINDOW_SIZE >>> PAGE_SHIFT).fill(-1), first = (va - WINDOW) >>> PAGE_SHIFT;
  for (let i = 0; i < n >>> PAGE_SHIFT; i++) pages[first + i] = off < 0 ? -1 : off + i * PAGE_SIZE;
}
/** the pool offset of window address a, through n bytes on: a run the core has checked is mapped, all in one mapping */
export function poolOffset(a: number, n: number): number {
  const page = windowPages?.[((a >>> 0) - WINDOW) >>> PAGE_SHIFT] ?? -1;
  if (page < 0) throw new BadAddress(BigInt(a >>> 0), `[native] window address 0x${(a >>> 0).toString(16)} unmapped`);
  const off = page + (a & (PAGE_SIZE - 1));
  poolTo(off + n);
  return off;
}
/** guest address `a` (an i32 from the core) as an offset into what holds it: the pool, or the core's memory */
const at = (a: number, n: number): number => (a >>>= 0) >= WINDOW ? poolOffset(a, n) : a;
/** the core's imports that reach the window's bytes, which a core over `memory` has checked are mapped */
export const windowImports = (memory: WebAssembly.Memory) => {
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
};
