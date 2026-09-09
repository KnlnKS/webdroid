// The wasm core (src/native/core/*.zig) owns the guest memory: a guest address is an offset
// into the memory it imports. One instance per process; the memory starts at the 32-bit size
// and grows on the switch to a 64-bit process (mem.init), so nothing is ever copied or rebuilt.

import { MEM_SIZE_A32, MEM_SIZE_A64, STACK_BASE } from "./abi";

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
}

export const memory = new WebAssembly.Memory({ initial: MEM_SIZE_A32 / 65536, maximum: MEM_SIZE_A64 / 65536 });

async function load(): Promise<WebAssembly.Module> {
  // the tests run the safety-checked build: undefined behaviour panics instead of miscomputing
  const b64 = typeof process !== "undefined" && process.env.NODE_ENV === "test" ? (await import("./core.safe.wasm")).default : (await import("./core.wasm")).default;
  return WebAssembly.compile(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
const instance = await WebAssembly.instantiate(await load(), {
  env: {
    memory,
    js_panic(ptr: number, len: number): never {
      throw new NativeFault("[native] core: " + new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
    },
  },
});
export const core = instance.exports as unknown as Core;
if (core.__heap_base.value > STACK_BASE) throw new Error("[native] the core's data overruns the stack region");
