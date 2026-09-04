// Guest address map and the few constants every native module shares. One place, so a layout
// change is one edit; the values are the ones the rest of src/native assumes.

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
/** the first 64 KiB is never mapped: a null-ish pointer faults instead of reading zeros */
export const LOW = 0x1_0000;

// Every fixed region sits at the bottom, each starting where the last ended, so the buffer can
// be sized for the process without moving anything: a 32-bit process keeps 256 MiB, a 64-bit one
// gets 1.5 GiB (the largest a plain ArrayBuffer allocates in Chrome — 2 GiB throws — and every
// address stays below 2^31). It is charged to the JS heap in full, so it is sized once, lazily,
// by the first image loaded (mem.init from setA64), not at import: an app with no .so pays
// nothing. Above the fixed regions the malloc arena and the ELF images share one region and
// grow toward each other (malloc bumps up, mem.reserve bumps down), which is what a process
// does anyway. The range test flags.ts inlines into every generated load and store is derived
// from the live size, never spelled.
const STACK_SPAN = 0x0400_0000;                // thread stacks, 1 MiB + a 64 KiB guard gap each: 60 of them
const HOST_SPAN = 0x0008_0000;                 // host-owned guest data: __sF, _ctype_, JNI tables, static strings, program headers
const TRAMP_SPAN = 0x0007_0000;                // host-call trampolines, 8 bytes per slot

export const STACK_BASE = 0x0010_0000;
export const STACK_END = STACK_BASE + STACK_SPAN;
export const HOST_DATA = STACK_END;
export const HOST_DATA_END = HOST_DATA + HOST_SPAN;
export const TRAMP_BASE = HOST_DATA_END;
export const TRAMP_END = TRAMP_BASE + TRAMP_SPAN;
/** lr planted by Cpu.call; reaching it as pc ends the call. The last trampoline slot, never defined. */
export const RET_SENTINEL = TRAMP_END - 8;
/** the shared region: malloc bumps up from ARENA_BASE, ELF images bump down from the end of memory */
export const ARENA_BASE = TRAMP_END;
export const MEM_SIZE_A32 = 0x1000_0000;
export const MEM_SIZE_A64 = 0x6000_0000;
/** the live size, set by mem.init */
export let MEM_SIZE = MEM_SIZE_A32;
export function setMemSize(n: number): void { MEM_SIZE = n; }
export const STACK_SIZE = 0x10_0000;
export const STACK_GUARD = 0x1_0000;

export const trampAddr = (slot: number) => TRAMP_BASE + slot * 8;
export const trampSlot = (pc: number) => (pc - TRAMP_BASE) >> 3;

// errno values (bionic/Linux ARM)
export const E = {
  PERM: 1, NOENT: 2, INTR: 4, IO: 5, BADF: 9, AGAIN: 11, NOMEM: 12, ACCES: 13, BUSY: 16, EXIST: 17,
  NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOSPC: 28, SPIPE: 29, RANGE: 34, DEADLK: 35, NOSYS: 38,
  NOTEMPTY: 39, NETUNREACH: 101, TIMEDOUT: 110,
} as const;
