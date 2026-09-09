// Guest address map and the few constants every native module shares. One place, so a layout
// change is one edit; the values are the ones the rest of src/native assumes.

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
/** the first 64 KiB is never mapped: a null-ish pointer faults instead of reading zeros */
export const LOW = 0x1_0000;

// Every fixed region sits at the bottom, each starting where the last ended, so the memory can
// grow for the process without moving anything: a 32-bit process keeps 256 MiB, a 64-bit one
// gets the whole 32-bit space a wasm memory can back, grown in place by the first image loaded
// (mem.init from setA64). Above the fixed regions the malloc arena and the ELF images share one
// region and grow toward each other (malloc bumps up, mem.reserve bumps down), which is what a
// process does anyway. The range test flags.ts inlines into every generated load and store is
// derived from the live size, never spelled.
const STACK_SPAN = 0x0400_0000;                // thread stacks, 1 MiB + a 64 KiB guard gap each: 60 of them
const HOST_SPAN = 0x0008_0000;                 // host-owned guest data: __sF, _ctype_, JNI tables, static strings, program headers
const TRAMP_SPAN = 0x0007_0000;                // host-call trampolines, 8 bytes per slot
const KERN_SPAN = 0x00b0_0000;                 // the core's page tables (mem.zig, cpu.zig)

export const STACK_BASE = 0x0010_0000;
export const STACK_END = STACK_BASE + STACK_SPAN;
export const HOST_DATA = STACK_END;
export const HOST_DATA_END = HOST_DATA + HOST_SPAN;
export const TRAMP_BASE = HOST_DATA_END;
export const TRAMP_END = TRAMP_BASE + TRAMP_SPAN;
/** lr planted by Cpu.call; reaching it as pc ends the call. The last trampoline slot, never defined. */
export const RET_SENTINEL = TRAMP_END - 8;
export const KERN_BASE = TRAMP_END;
export const KERN_END = KERN_BASE + KERN_SPAN;
/** the shared region: malloc bumps up from ARENA_BASE, ELF images bump down from the end of memory */
export const ARENA_BASE = KERN_END;
export const MEM_SIZE_A32 = 0x1000_0000;
export const MEM_SIZE_A64 = 0xffff_0000; // 4 GiB less a page: the whole 32-bit space a WebAssembly memory can back
/** above this the buffer backs the address planes' chunks rather than plane 0 itself (mem.ts) */
export const POOL_BASE = 0xa000_0000;
/** the live size, set by mem.init */
export let MEM_SIZE = MEM_SIZE_A32;
export function setMemSize(n: number): void { MEM_SIZE = n; }
export const STACK_SIZE = 0x10_0000;
export const STACK_GUARD = 0x1_0000;

export const trampAddr = (slot: number) => TRAMP_BASE + slot * 8;
export const trampSlot = (pc: number) => (pc - TRAMP_BASE) >> 3;

// errno values (bionic/Linux ARM)
export const E = {
  PERM: 1, NOENT: 2, SRCH: 3, INTR: 4, IO: 5, BADF: 9, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, BUSY: 16, EXIST: 17,
  NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOSPC: 28, SPIPE: 29, RANGE: 34, DEADLK: 35, NOSYS: 38,
  NOTEMPTY: 39, NOTSOCK: 88, PROTONOSUPPORT: 93, SOCKTNOSUPPORT: 94, AFNOSUPPORT: 97, NETUNREACH: 101,
  ISCONN: 106, NOTCONN: 107, TIMEDOUT: 110, CONNREFUSED: 111, HOSTUNREACH: 113, ALREADY: 114, INPROGRESS: 115,
} as const;
