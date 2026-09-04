// Guest address map and the few constants every native module shares. One place, so a layout
// change is one edit; the values are the ones the rest of src/native assumes.

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
export const MEM_SIZE = 0x1000_0000;           // 256 MiB of guest memory in one ArrayBuffer
/** the first 64 KiB is never mapped: a null-ish pointer faults instead of reading zeros */
export const LOW = 0x1_0000;

// Each region starts where the last ended, so resizing one is a single edit and nothing can
// drift out of step with it -- including the range test flags.ts inlines into every generated
// load and store, which used to be a literal that a resize would have left silently wrong.
//
// MEM_SIZE stays 256 MiB. A 64-bit module wants real room -- libil2cpp.so maps 79 MiB by itself
// -- but the buffer is charged to the JS heap in full whether the guest touches it or not:
// measured in Chrome, raising it to 1 GiB took FitNotes from 352 MB of usedJSHeapSize to
// 1,162 MB and wedged the renderer outright on a 1.1 GB apk. So the room comes from sharing
// rather than from growing: ELF images and the malloc arena are one region and grow toward each
// other (mem.reserve bumps down, malloc bumps up), which is what a process does anyway and what
// lets a 79 MiB image load without costing an app that has no .so at all a single byte.
const STACK_SPAN = 0x0100_0000;                // thread stacks, 1 MiB + a 64 KiB guard gap each
const HOST_SPAN = 0x0008_0000;                 // host-owned guest data: __sF, _ctype_, JNI tables, static strings
const TRAMP_SPAN = 0x0007_0000;                // host-call trampolines, 8 bytes per slot

export const STACK_BASE = 0x0010_0000;
export const STACK_END = STACK_BASE + STACK_SPAN;
export const TRAMP_END = MEM_SIZE - 0x1_0000;
export const TRAMP_BASE = TRAMP_END - TRAMP_SPAN;
export const HOST_DATA_END = TRAMP_BASE;
export const HOST_DATA = HOST_DATA_END - HOST_SPAN;
/** the shared region: malloc bumps up from ARENA_BASE, ELF images bump down from ARENA_END */
export const ARENA_BASE = STACK_END;
export const ARENA_END = HOST_DATA;
export const RET_SENTINEL = MEM_SIZE - 0x10;   // lr planted by Cpu.call; reaching it as pc ends the call
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
