// Guest address map and the few constants every native module shares. One place, so a layout
// change is one edit; the values are the ones the rest of src/native assumes.

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
/** the first 64 KiB is never mapped: a null-ish pointer faults instead of reading zeros */
export const LOW = 0x1_0000;

// Every fixed region sits at the bottom, each starting where the last ended, so the memory can
// grow from 256 MiB to the process address space when its first native image loads:
// 2 GiB for ARM32, or the whole 32-bit space a wasm memory can back for ARM64
// (mem.init from setA64). Above the fixed regions the malloc arena and the ELF images share one
// region and grow toward each other (malloc bumps up, mem.reserve bumps down), which is what a
// process does anyway. The range test mem.ts inlines into every load and store is derived from
// the live size, never spelled.
const STACK_SPAN = 0x0400_0000;                // thread stacks, 1 MiB + a 64 KiB guard gap each: 60 of them, then arena pages
const HOST_SPAN = 0x0008_0000;                 // host-owned guest data: __sF, _ctype_, JNI tables, static strings, program headers
const TRAMP_SPAN = 0x0007_0000;                // host-call trampolines, 8 bytes per slot
const KERN_SPAN = 0x00c0_0000;                 // the core's page tables and JIT buffer (mem.zig, cpu.zig, jit.zig)

export const STACK_BASE = 0x0010_0000;
const STACK_END = STACK_BASE + STACK_SPAN;
const HOST_DATA = STACK_END;
const HOST_DATA_END = HOST_DATA + HOST_SPAN;
export const TRAMP_BASE = HOST_DATA_END;
export const TRAMP_END = TRAMP_BASE + TRAMP_SPAN;
/** lr planted by Cpu.call; reaching it as pc ends the call. The last trampoline slot, never defined. */
export const RET_SENTINEL = TRAMP_END - 8;
const KERN_BASE = TRAMP_END;
const KERN_END = KERN_BASE + KERN_SPAN;
export const JIT_BUF = KERN_END - 0x0010_0000;
export const MEM_SIZE_INITIAL = 0x1000_0000;
export const MEM_SIZE_A32 = 0x8000_0000;
export const MEM_SIZE_A64 = 0xffff_0000; // 4 GiB less a page: the whole 32-bit space a WebAssembly memory can back
/** above this the buffer backs the address planes' chunks rather than plane 0 itself (mem.ts) */
export const POOL_BASE = 0x8000_0000;
/** the live size, set by mem.init */
export let MEM_SIZE = MEM_SIZE_INITIAL;
export function setMemSize(n: number): void { MEM_SIZE = n; }
export const STACK_SIZE = 0x10_0000;
/** the main thread's, Android's 8 MiB RLIMIT_STACK; other threads get pthread's 1 MiB */
export const MAIN_STACK_SIZE = 0x80_0000;

export const trampAddr = (slot: number) => TRAMP_BASE + slot * 8;
export const trampSlot = (pc: number) => (pc - TRAMP_BASE) >> 3;

// errno values (bionic/Linux ARM)
export const E = {
  PERM: 1, NOENT: 2, SRCH: 3, INTR: 4, IO: 5, TOOBIG: 7, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, BUSY: 16, EXIST: 17,
  NODEV: 19, NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOTTY: 25, NOSPC: 28, SPIPE: 29, PIPE: 32, RANGE: 34, DEADLK: 35, NOSYS: 38, NOTSUP: 95,
  NOTEMPTY: 39, NOTSOCK: 88, DESTADDRREQ: 89, MSGSIZE: 90, NOPROTOOPT: 92, PROTONOSUPPORT: 93, SOCKTNOSUPPORT: 94, AFNOSUPPORT: 97,
  ADDRINUSE: 98, ADDRNOTAVAIL: 99, NETUNREACH: 101, CONNRESET: 104,
  ISCONN: 106, NOTCONN: 107, TIMEDOUT: 110, CONNREFUSED: 111, HOSTUNREACH: 113, ALREADY: 114, INPROGRESS: 115,
} as const;

export const ERRSTR: Record<number, string> = {
  1: "Operation not permitted", 2: "No such file or directory", 4: "Interrupted system call", 5: "I/O error", 9: "Bad file descriptor", 10: "No child processes",
  11: "Try again", 12: "Out of memory", 13: "Permission denied", 16: "Device or resource busy", 17: "File exists", 20: "Not a directory",
  21: "Is a directory", 22: "Invalid argument", 24: "Too many open files", 25: "Inappropriate ioctl for device", 28: "No space left on device", 29: "Illegal seek", 34: "Numerical result out of range",
  35: "Resource deadlock would occur", 38: "Function not implemented", 39: "Directory not empty", 101: "Network is unreachable", 110: "Connection timed out",
  14: "Bad address", 19: "No such device", 32: "Broken pipe", 88: "Socket operation on non-socket", 89: "Destination address required",
  90: "Message too long", 92: "Protocol not available", 93: "Protocol not supported", 94: "Socket type not supported",
  95: "Operation not supported on transport endpoint", 97: "Address family not supported by protocol", 98: "Address already in use",
  99: "Cannot assign requested address", 104: "Connection reset by peer", 106: "Transport endpoint is already connected",
  107: "Transport endpoint is not connected", 111: "Connection refused", 113: "No route to host", 114: "Operation already in progress",
  115: "Operation now in progress",
};
