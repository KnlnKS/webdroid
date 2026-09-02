// Guest address map and the few constants every native module shares. One place, so a layout
// change is one edit; the values are the ones the rest of src/native assumes.

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
export const MEM_SIZE = 0x1000_0000;           // 256 MiB of guest memory in one ArrayBuffer
export const MODULE_BASE = 0x0010_0000;        // ELF images, bump-allocated upward, 64 KiB aligned
export const STACK_BASE = 0x0100_0000;         // thread stacks (1 MiB + 64 KiB guard gap each)
export const STACK_END = 0x0200_0000;
export const HEAP_BASE = 0x0200_0000;          // malloc arena
export const HEAP_END = 0x0FF0_0000;
export const HOST_DATA = 0x0FF0_0000;          // host-owned guest data: __sF, _ctype_, JNI tables, static strings
export const HOST_DATA_END = 0x0FF8_0000;
export const TRAMP_BASE = 0x0FF8_0000;         // host-call trampolines, 8 bytes per slot
export const TRAMP_END = 0x0FFF_0000;
export const RET_SENTINEL = 0x0FFF_FFF0;       // lr planted by Cpu.call; reaching it as pc ends the call
export const STACK_SIZE = 0x10_0000;
export const STACK_GUARD = 0x1_0000;

export const trampAddr = (slot: number) => TRAMP_BASE + slot * 8;
export const trampSlot = (pc: number) => (pc - TRAMP_BASE) >> 3;
export const isTramp = (pc: number) => pc >= TRAMP_BASE && pc < TRAMP_END;

// errno values (bionic/Linux ARM)
export const E = {
  PERM: 1, NOENT: 2, INTR: 4, IO: 5, BADF: 9, AGAIN: 11, NOMEM: 12, ACCES: 13, BUSY: 16, EXIST: 17,
  NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOSPC: 28, SPIPE: 29, RANGE: 34, DEADLK: 35, NOSYS: 38,
  NOTEMPTY: 39, NETUNREACH: 101, TIMEDOUT: 110,
} as const;
