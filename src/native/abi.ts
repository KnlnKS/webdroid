// Guest address map and the few constants every native module shares. One place, so a layout
// change is one edit; the values are the ones the rest of src/native assumes.

// The address map is the core's (src/native/core/abi.zig), which scripts/generated.ts generates core-abi.gen.ts from.
export { PAGE_SHIFT, PAGE_SIZE, LOW, STACK_BASE, TRAMP_BASE, TRAMP_END, RET_SENTINEL, JIT_BUF, MEM_SIZE_INITIAL, MEM_SIZE_A32, MEM_SIZE_A64, STACK_SIZE } from "./core-abi.gen.ts";
import { MEM_SIZE_INITIAL, TRAMP_BASE } from "./core-abi.gen.ts";
/** the live size, set by mem.init */
export let MEM_SIZE = MEM_SIZE_INITIAL;
export function setMemSize(n: number): void { MEM_SIZE = n; }
/** the main thread's, Android's 8 MiB RLIMIT_STACK; other threads get pthread's 1 MiB */
export const MAIN_STACK_SIZE = 0x80_0000;

export const trampAddr = (slot: number) => TRAMP_BASE + slot * 8;
export const trampSlot = (pc: number) => (pc - TRAMP_BASE) >> 3;

// errno values (bionic/Linux ARM)
export const E = {
  PERM: 1, NOENT: 2, SRCH: 3, INTR: 4, IO: 5, NXIO: 6, TOOBIG: 7, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, BUSY: 16, EXIST: 17,
  NODEV: 19, NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOTTY: 25, NOSPC: 28, SPIPE: 29, PIPE: 32, DOM: 33, RANGE: 34, DEADLK: 35, NOSYS: 38, NOTSUP: 95,
  NOTEMPTY: 39, NOTSOCK: 88, DESTADDRREQ: 89, MSGSIZE: 90, PROTOTYPE: 91, NOPROTOOPT: 92, PROTONOSUPPORT: 93, SOCKTNOSUPPORT: 94, AFNOSUPPORT: 97,
  ADDRINUSE: 98, ADDRNOTAVAIL: 99, NETUNREACH: 101, CONNRESET: 104,
  ISCONN: 106, NOTCONN: 107, TIMEDOUT: 110, CONNREFUSED: 111, HOSTUNREACH: 113, ALREADY: 114, INPROGRESS: 115,
} as const;

export const ERRSTR: Record<number, string> = {
  1: "Operation not permitted", 2: "No such file or directory", 4: "Interrupted system call", 5: "I/O error", 6: "No such device or address", 9: "Bad file descriptor", 10: "No child processes",
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
/** strerror(3): bionic's text for errno `e` */
export const strerror = (e: number): string => ERRSTR[e] ?? `Unknown error ${e}`;
