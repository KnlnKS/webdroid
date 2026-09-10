// The wasm core (src/native/core/*.zig) owns the guest memory: a guest address is an offset
// into the memory it imports. One instance per process; the memory starts at the 32-bit size
// and grows on the switch to a 64-bit process (mem.init), so nothing is ever copied or rebuilt.

import { JIT_BUF, MEM_SIZE_A32, MEM_SIZE_A64, STACK_BASE } from "./abi";
import { perf } from "../perf";

export class NativeFault extends Error {
  pc = 0;
}

export interface Core {
  __heap_base: WebAssembly.Global;
  abi_const(i: number): number;
  mem_init(size: number): void;
  flags_ptr(): number;
  stat(i: number): number;
  err(): number;
  malloc(n: number): number;
  free(p: number): number;
  usable_size(p: number): number;
  realloc(p: number, n: number): number;
  calloc(n: number, m: number): number;
  memalign(align: number, n: number): number;
  map_pages(n: number, reserve: number, align: number): number;
  unmap_pages(addr: number, n: number): number;
  commit_pages(addr: number, n: number): number;
  decommit_pages(addr: number, n: number): void;
  tx(h: number, lo: number): number;
  plane_reserved(h: number): number;
  va(phys: number): bigint;
  map_va(n: bigint, reserve: number): bigint;
  unmap_va(va: bigint, n: bigint): number;
  check_reserve(h: number, lo: number, size: number): number;
  commit_va(va: bigint, n: bigint): number;
  drop_va(va: bigint, n: bigint): number;
  decommit_va(va: bigint, n: bigint): void;
  reserve(size: number, align: number): number;
  alloc_stack(size: number): number;
  free_stack(base: number, size: number): void;
  host_alloc(n: number, align: number): number;
  layout(i: number): number;
  cpu_alloc(tid: number, a64: number): number;
  cpu_free(p: number): void;
  run_slice(cpu: number, budget: number): number;
  code_write(addr: number): number;
  invalidate_range(addr: number, size: number): void;
  invalidate_all(): void;
  cpu_stat(i: number): number;
  interp_ic(): number;
  set_max_block(n: number): void;
  host_bind(slot: number, id: number): void;
  host_bypass(on: number): void;
  exec_word(cpu: number, word: number, pc: number): number;
  tx_addr(cpu: number, addr: bigint): number;
  on_store(cpu: number, addr: number): number;
  jit_pending(): number;
  jit_emit(out: number, cap: number): number;
  jit_count(): number;
  jit_entry(i: number): number;
  jit_fallback(lo: number, hi: number): void;
  jit_install(i: number, slot: number): void;
  jit_done(): void;
  jit_kill(slot: number): void;
  jit_evict(): void;
  jit_stat(i: number): number;
  exec_word32(cpu: number, pc: number): number;
  fb_count(i: number): number;
  jit_config(chain: number): void;
  jit_fmax32(a: number, b: number): number;
  jit_fmin32(a: number, b: number): number;
  jit_fmaxnm32(a: number, b: number): number;
  jit_fminnm32(a: number, b: number): number;
  jit_fmax64(a: number, b: number): number;
  jit_fmin64(a: number, b: number): number;
  jit_fmaxnm64(a: number, b: number): number;
  jit_fminnm64(a: number, b: number): number;
  jit_fma64(a: number, b: number, c: number): number;
}
/** the libc calls the core serves itself, by the id libc.zig gives them */
export const CORE_LIBC: Record<string, number> = { memcpy: 1, memmove: 2, memset: 3, memcmp: 4, memchr: 5, strlen: 6, strnlen: 7, strcmp: 8, strncmp: 9, malloc: 10, free: 11, calloc: 12, realloc: 13, memalign: 14, posix_memalign: 15, malloc_usable_size: 16 };

export const memory = new WebAssembly.Memory({ initial: MEM_SIZE_A32 / 65536, maximum: MEM_SIZE_A64 / 65536 });
/** the core's function table, which JIT regions are linked into above the core's own entries */
const TABLE_SIZE = 65536, JIT_SLOT0 = 8192;
export const table = new WebAssembly.Table({ initial: TABLE_SIZE, element: "anyfunc" });

async function load(): Promise<WebAssembly.Module> {
  // the tests run the safety-checked build: undefined behaviour panics instead of miscomputing
  const b64 = typeof process !== "undefined" && process.env.NODE_ENV === "test" ? (await import("./core.safe.wasm")).default : (await import("./core.wasm")).default;
  return WebAssembly.compile(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
const instance = await WebAssembly.instantiate(await load(), {
  env: {
    memory,
    __indirect_function_table: table,
    now_ms: () => performance.now(),
    js_panic(ptr: number, len: number): never {
      throw new NativeFault("[native] core: " + new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
    },
  },
});
export const core = instance.exports as unknown as Core;
if (core.__heap_base.value > STACK_BASE) throw new Error("[native] the core's data overruns the stack region");

// ── the JIT: the core emits a module per batch of hot regions; each region function is linked
// into the table and the core's slot maps route the dispatcher to it
const JIT_CAP = 1 << 20; // the last MiB of the KERN region (abi.ts)
const jitImports = { env: { memory, __indirect_function_table: table, exec: core.exec_word, exec32: core.exec_word32, tx: core.tx_addr, store: core.on_store, fmax32: core.jit_fmax32, fmin32: core.jit_fmin32, fmaxnm32: core.jit_fmaxnm32, fminnm32: core.jit_fminnm32, fmax64: core.jit_fmax64, fmin64: core.jit_fmin64, fmaxnm64: core.jit_fmaxnm64, fminnm64: core.jit_fminnm64, fma64: core.jit_fma64 } };
/** whether the engine has wasm tail calls: a region then hands off to the next region without returning to the dispatcher */
const TAIL = WebAssembly.validate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0, 10, 6, 1, 4, 0, 0x12, 0, 0x0b]));
core.jit_config(TAIL ? 1 : 0);
let nextSlot = JIT_SLOT0;
const freeSlots: number[] = [];
/** whether this engine compiles synchronously (bun does; Chrome's main thread refuses past 4 KB) */
let syncCompile: boolean | null = null;
/** the linked batches, oldest first, each with the table slots it holds */
const instances: { inst: WebAssembly.Instance; slots: number[] }[] = [];
/** entries of a block before the JIT takes it (jit.zig) */
export const JIT_HEAT = 48;
/** a64.zig's Kind, in order, for the fallback histogram */
const KINDS = "raw fault nop adr addsub logic movw bfm extr b bcond cbz tbz br svc clrex mrs msr ldrlit ldp excl atomic ldst adc ccmp csel one two three simd vldrlit vmem".split(" ");
export const jitStats = {
  get regions(): number { return core.jit_stat(0); }, get batches(): number { return core.jit_stat(1); }, get skipped(): number { return core.jit_stat(2); }, get bytes(): number { return core.jit_stat(3); }, get modules(): number { return instances.length; }, evictions: 0, async: 0, on: true, chain: TAIL,
  /** what regions handed to the interpreter, most often first: an op kind, or `simd:<top byte>` of the word */
  fallbacks(n = 20): string[] {
    const rows: [string, number][] = [];
    for (let i = 0; i < 512; i++) { const k = core.fb_count(i); if (k) rows.push([i === 255 ? "arm32" : i < 256 ? KINDS[i] ?? `kind${i}` : `simd:${(i - 256).toString(16).padStart(2, "0")}`, k]); }
    return rows.sort((a, b) => b[1] - a[1]).slice(0, n).map(([nm, k]) => `${k} ${nm}`);
  },
};
/** the table is full: the oldest half of the batches go, and a region still hot re-heats and comes back */
export function jitEvict(): void {
  for (const { slots } of instances.splice(0, Math.ceil(instances.length / 2))) for (const s of slots) { table.set(s, null); core.jit_kill(s); freeSlots.push(s); }
  core.jit_evict();
  jitStats.evictions++;
}
/** debug: only regions whose entry lies in one of the [lo, hi) ranges are installed (set __wdJit before load: bisects a miscompile) */
function jitLink(inst: WebAssembly.Instance, n: number, t0: number): void {
  if (nextSlot + n > TABLE_SIZE && freeSlots.length < n) jitEvict();
  const jitRanges = (globalThis as { __wdJit?: [number, number][] }).__wdJit;
  const slots: number[] = [];
  for (let i = 0; i < n; i++) {
    const pc = core.jit_entry(i) >>> 0;
    if (jitRanges && !jitRanges.some(([lo, hi]) => pc >= lo && pc < hi)) continue;
    const slot = freeSlots.pop() ?? nextSlot++;
    table.set(slot, inst.exports["r" + i] as (...a: unknown[]) => unknown); core.jit_install(i, slot); slots.push(slot);
  }
  instances.push({ inst, slots });
  core.jit_done();
  perf.jitRegions += n; perf.jitMs += performance.now() - t0;
}
/** compile and link what turned hot since the last drain; called at every exit from the core */
export function jitDrain(): void {
  if (!jitStats.on || !core.jit_pending()) return;
  const t0 = performance.now();
  const len = core.jit_emit(JIT_BUF, JIT_CAP);
  if (!len) return;
  const bytes = new Uint8Array(memory.buffer, JIT_BUF, len).slice(), n = core.jit_count();
  if (syncCompile !== false) {
    try { jitLink(new WebAssembly.Instance(new WebAssembly.Module(bytes), jitImports), n, t0); syncCompile = true; return; }
    catch (e) {
      if (!(e instanceof RangeError)) { core.jit_done(); throw e; }
      syncCompile = false;
    }
  }
  jitStats.async++;
  WebAssembly.instantiate(bytes, jitImports).then(({ instance }) => jitLink(instance, n, t0), (e) => { console.warn("[jit] compile failed:", e); core.jit_done(); });
}
