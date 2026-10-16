// The wasm core (src/native/core/*.zig) owns the guest memory: a guest address is an offset
// into the memory it imports. One instance per process; the memory grows as the guest's pages
// come into use (mem.zig's back), within the native ABI's address space (mem.init).

import { JIT_BUF, MEM_SIZE_INITIAL, MEM_SIZE_A64, STACK_BASE } from "./abi.ts";
import { JIT_SLOTS, LIBC_FNS, TLS_KEYS } from "./core-abi.gen.ts";
import { perf } from "../perf.ts";
import { guestNow, wallMillis } from "../guest-clock.ts";

export class NativeFault extends Error {
  pc = 0;
}
/** a host access through a guest pointer to nothing mapped: copy_from_user's EFAULT under a
 *  system call, the guest's own SIGSEGV under a libc function that reads it in user space */
export class BadAddress extends NativeFault {
  readonly addr: bigint;
  constructor(addr: bigint, message: string) { super(message); this.addr = addr; }
}

interface Core {
  __heap_base: WebAssembly.Global;
  mem_init(size: number): void;
  flags_ptr(): number;
  stat(i: number): number;
  malloc(n: number): number;
  free(p: number): number;
  calloc(n: number, m: number): number;
  realloc(p: number, n: number): number;
  memalign(align: number, n: number): number;
  map_pages(n: number, reserve: number, align: number): number;
  unmap_pages(addr: number, n: number): number;
  commit_pages(addr: number, n: number): number;
  decommit_pages(addr: number, n: number): void;
  tx(h: number, lo: number): number;
  commit_phys(p: number, n: number): number;
  plane_reserved(h: number): number;
  va(phys: number): bigint;
  map_va(n: bigint, reserve: number, low: number): bigint;
  unmap_va(va: bigint, n: bigint): number;
  extend_va(va: bigint, oldSize: bigint, size: bigint): number;
  map_fixed(va: bigint, n: bigint): number;
  check_reserve(h: number, lo: number, size: number): number;
  resident_va(va: bigint): number;
  commit_va(va: bigint, n: bigint): number;
  drop_va(va: bigint, n: bigint): number;
  decommit_va(va: bigint, n: bigint): void;
  reserve(size: number, align: number): number;
  release_image(base: number, size: number): void;
  alloc_stack(size: number): number;
  free_stack(base: number, size: number): void;
  host_alloc(n: number, align: number): number;
  layout(i: number): number;
  cpu_alloc(tid: number, osTid: number, pid: number, a64: number): number;
  cpu_free(p: number): void;
  run_slice(cpu: number, budget: number): number;
  code_write(addr: number, size: number): number;
  invalidate_range(addr: number, size: number): void;
  invalidate_all(): void;
  cpu_stat(i: number): number;
  set_max_block(n: number): void;
  host_bind(slot: number, id: number): void;
  host_bypass(on: number): void;
  libc_call(cpu: number, id: number): number;
  exec_word(cpu: number, word: number, pc: number): number;
  on_store(cpu: number, addr: number, size: number): number;
  jit_pending(): number;
  jit_emit(out: number, cap: number): number;
  jit_count(): number;
  jit_entry(i: number): number;
  jit_fallback(lo: number, hi: number): void;
  jit_estimate32(x: number, sqrt: number): number;
  jit_install(i: number, slot: number): void;
  jit_done(): void;
  jit_kill(slot: number): void;
  jit_evict(): void;
  jit_stat(): number;
  exec_word32(cpu: number, pc: number): number;
  exec_it_block32(cpu: number, pc: number, end: number): number;
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
export const CORE_LIBC: Record<string, number> = Object.fromEntries(LIBC_FNS.map((n, i) => [n, i + 1]));
/** pthread keys per thread, the size of the table each Cpu carries */
export { TLS_KEYS };

/** The page's realms share one V8 isolate, which counts each committed wasm memory toward its
 *  global heap limit and past it marks without pause, so the memory is committed as the guest
 *  uses it. That takes a shared memory: growing an unshared one detaches every view of it, Java's
 *  non-movable arrays among them. Chrome makes one without cross-origin isolation; where none can
 *  be made, mem.init commits the address space whole. */
export const memory = ((limits: WebAssembly.MemoryDescriptor) => {
  try { return new WebAssembly.Memory({ ...limits, shared: true }); } catch { return new WebAssembly.Memory(limits); }
})({ initial: MEM_SIZE_INITIAL / 65536, maximum: MEM_SIZE_A64 / 65536 });
export const shared = !(memory.buffer instanceof ArrayBuffer);
if (shared) {
  // The Encoding Standard decodes a shared view (AllowSharedBufferSource); Chrome's TextDecoder
  // still refuses one, and guest memory and the arrays in it are shared.
  const decode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function (input, options) {
    return decode.call(this, ArrayBuffer.isView(input) && !(input.buffer instanceof ArrayBuffer) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice() : input, options);
  };
}
const MEMORY_IMPORT = [3, ..."env", 6, ..."memory", 2, 1].map((c) => typeof c === "string" ? c.charCodeAt(0) : c);
/** the core's import of `memory`, which the build declares unshared, as the memory was made */
function imported(bytes: Uint8Array): Uint8Array {
  if (!shared) return bytes;
  const at = bytes.findIndex((_, i) => MEMORY_IMPORT.every((b, j) => bytes[i + j] === b));
  bytes[at + MEMORY_IMPORT.length - 1] = 0x03; // limits: shared, with a maximum
  return bytes;
}
/** the core's function table, which JIT regions are linked into above the core's own entries */
const JIT_SLOT0 = 8192;
const table = new WebAssembly.Table({ initial: JIT_SLOTS, element: "anyfunc" });
/** the core grew the memory */
let grown = (): void => {};
export function onMemoryGrown(f: () => void): void { grown = f; }

async function load(): Promise<WebAssembly.Module> {
  if (process.env.NODE_ENV === "production") {
    const response = await fetch("/native-core.wasm");
    if (!response.ok) throw new Error(`Native core unavailable: ${response.status}`);
    return WebAssembly.compile(imported(new Uint8Array(await response.arrayBuffer())));
  }
  // the tests run the safety-checked build: undefined behaviour panics instead of miscomputing
  const b64 = typeof process !== "undefined" && process.env.NODE_ENV === "test" ? (await import("./core.safe.wasm.ts")).default : (await import("./core.wasm.ts")).default;
  return WebAssembly.compile(imported(Uint8Array.fromBase64(b64)));
}
const instance = await WebAssembly.instantiate(await load(), {
  env: {
    memory,
    __indirect_function_table: table,
    now_ms: () => performance.now(),
    guest_ms: guestNow,
    wall_ms: wallMillis,
    mem_grown: () => grown(),
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
const jitImports = { env: { memory, __indirect_function_table: table, exec: core.exec_word, exec32: core.exec_word32, store: core.on_store, fmax32: core.jit_fmax32, fmin32: core.jit_fmin32, fmaxnm32: core.jit_fmaxnm32, fminnm32: core.jit_fminnm32, fmax64: core.jit_fmax64, fmin64: core.jit_fmin64, fmaxnm64: core.jit_fmaxnm64, fminnm64: core.jit_fminnm64, fma64: core.jit_fma64, it32: core.exec_it_block32, tx: core.tx, estimate32: core.jit_estimate32 } };
/** whether the engine has wasm tail calls: a region then hands off to the next region without returning to the dispatcher */
const TAIL = WebAssembly.validate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0, 10, 6, 1, 4, 0, 0x12, 0, 0x0b]));
core.jit_config((TAIL ? 1 : 0) | (shared ? 2 : 0));
let nextSlot = JIT_SLOT0;
const freeSlots: number[] = [];
/** whether this engine compiles synchronously (bun does; Chrome's main thread refuses past 4 KB) */
let syncCompile: boolean | null = null;
/** the linked batches, oldest first, each with the table slots it holds */
const instances: { inst: WebAssembly.Instance; slots: number[] }[] = [];
/** entries of a block before the JIT takes it (jit.zig) */
export const JIT_HEAT = 48;
export const jitStats = {
  get regions(): number { return core.jit_stat(); }, get modules(): number { return instances.length; }, evictions: 0, async: 0, on: true, chain: TAIL,
};
/** the table is full: the oldest half of the batches go, and a region still hot re-heats and comes back */
export function jitEvict(): void {
  for (const { slots } of instances.splice(0, Math.ceil(instances.length / 2))) for (const s of slots) { table.set(s, null); core.jit_kill(s); freeSlots.push(s); }
  core.jit_evict();
  jitStats.evictions++;
}
/** debug: only regions whose entry lies in one of the [lo, hi) ranges are installed (set __wdJit before load: bisects a miscompile) */
function jitLink(inst: WebAssembly.Instance, n: number, t0: number): void {
  if (nextSlot + n > JIT_SLOTS && freeSlots.length < n) jitEvict();
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
  // Both Module and asynchronous instantiate snapshot the source bytes before returning.
  const bytes = new Uint8Array(memory.buffer, JIT_BUF, len), n = core.jit_count();
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
