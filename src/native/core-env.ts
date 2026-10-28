// What an instance of the core imports, and what a JIT batch (jit.zig's emitModule) imports from the
// instance it runs beside: the process Worker's (core.ts) or a lane's (lane-worker.ts).
import { NativeFault } from "./faults.ts";

/** the guest's clocks in milliseconds: the counter CNTVCT counts, CLOCK_MONOTONIC and CLOCK_REALTIME */
export type CoreClocks = { now(): number; uptime(): number; wall(): number };
export const coreEnv = (memory: WebAssembly.Memory, table: WebAssembly.Table, clocks: CoreClocks, grown: () => void) => ({
  memory, __indirect_function_table: table, now_ms: clocks.now, uptime_ms: clocks.uptime, wall_ms: clocks.wall, mem_grown: grown,
  js_panic(ptr: number, len: number): never {
    throw new NativeFault("[native] core: " + new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len).slice()));
  },
});

type CoreFn = (...args: never[]) => unknown;
/** `pool`: the window's pool an ARM32 module reaches, read as the module is instantiated */
export const jitEnv = (core: Record<string, CoreFn>, memory: WebAssembly.Memory, table: WebAssembly.Table, pool: () => WebAssembly.Memory) => ({
  env: {
    get pool() { return pool(); }, memory, __indirect_function_table: table, exec: core.exec_word, exec32: core.exec_word32,
    fmax32: core.jit_fmax32, fmin32: core.jit_fmin32, fmaxnm32: core.jit_fmaxnm32, fminnm32: core.jit_fminnm32,
    fmax64: core.jit_fmax64, fmin64: core.jit_fmin64, fmaxnm64: core.jit_fmaxnm64, fminnm64: core.jit_fminnm64,
    fma64: core.jit_fma64, it32: core.exec_it_block32, estimate32: core.jit_estimate32,
  },
});
