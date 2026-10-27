// The kernel's system call boundary: the numbers a raw svc/swi (bionic's own wrappers) and libc's
// syscall(2) reach, each ABI's numbering over the body of the same name in an owning module's record
// (KERNEL_SYSCALLS). Each answers -errno on failure, as the kernel does.

import { calledMissing, type HostFn, type HostRet, type ArgReader } from "./host.ts";
import { E } from "./abi.ts";
import { setRawSyscall, type Cpu } from "./cpu.ts";
import { installDebuggerdHandlers } from "./crash.ts";
import { SIGNAL_SYSCALLS } from "./signals.ts";
import { VM_SYSCALLS } from "./vm.ts";
import { FS_SYSCALLS, fsInit } from "./fs.ts";
import { EVENTFD_SYSCALLS } from "./eventfd.ts";
import { INOTIFY_SYSCALLS } from "./inotify.ts";
import { THREAD_SYSCALLS } from "./thread.ts";
import { NET_SYSCALLS } from "./socket/syscalls.ts";
import { POLL_SYSCALLS } from "./poll.ts";
import { PROC_SYSCALLS } from "./proc.ts";
import { TIMER_SYSCALLS } from "./timers.ts";

/** the kernel's calls by name, which the ARM32 libc's wrappers of the same names answer too */
export const KERNEL_SYSCALLS: Record<string, HostFn> = { ...VM_SYSCALLS, ...FS_SYSCALLS, ...EVENTFD_SYSCALLS, ...INOTIFY_SYSCALLS, ...THREAD_SYSCALLS, ...NET_SYSCALLS, ...POLL_SYSCALLS, ...PROC_SYSCALLS, ...SIGNAL_SYSCALLS, ...TIMER_SYSCALLS };

/** each ABI's numbers for the body of the same name and arguments (an offset in a register on LP64
 *  makes mmap direct; ILP32's mmap2 counts pages and _llseek splits the offset, so neither is here) */
const NUMBERS64: Record<number, string> = {
  17: "getcwd", 19: "eventfd", 20: "epoll_create1", 21: "epoll_ctl", 22: "epoll_pwait", 23: "dup", 24: "dup3", 25: "fcntl",
  26: "inotify_init1", 27: "inotify_add_watch", 28: "inotify_rm_watch", 29: "ioctl", 32: "flock", 33: "mknodat", 34: "mkdirat", 35: "unlinkat",
  43: "statfs", 44: "fstatfs", 45: "truncate", 46: "ftruncate", 47: "fallocate", 48: "faccessat", 49: "chdir", 52: "fchmod", 53: "fchmodat",
  55: "fchown", 56: "openat", 57: "close", 59: "pipe2", 61: "getdents64", 62: "lseek", 63: "read", 64: "write", 65: "readv", 66: "writev",
  67: "pread64", 68: "pwrite64", 71: "sendfile", 72: "pselect6", 73: "ppoll", 78: "readlinkat", 79: "fstatat", 80: "fstat", 82: "fsync",
  83: "fdatasync", 85: "timerfd_create", 86: "timerfd_settime", 87: "timerfd_gettime", 88: "utimensat", 90: "capget", 93: "exit",
  94: "exit_group", 96: "set_tid_address", 98: "futex", 99: "set_robust_list", 101: "nanosleep", 107: "timer_create", 108: "timer_gettime",
  109: "timer_getoverrun", 110: "timer_settime", 111: "timer_delete", 113: "clock_gettime", 114: "clock_getres", 115: "clock_nanosleep",
  119: "sched_setscheduler", 120: "sched_getscheduler", 121: "sched_getparam", 122: "sched_setaffinity", 123: "sched_getaffinity",
  124: "sched_yield", 129: "kill", 130: "tkill", 131: "tgkill", 132: "sigaltstack", 133: "sigsuspend", 134: "rt_sigaction",
  135: "rt_sigprocmask", 137: "rt_sigtimedwait", 140: "setpriority", 141: "getpriority", 155: "getpgid", 160: "uname", 163: "getrlimit",
  164: "setrlimit", 165: "getrusage", 166: "umask", 167: "prctl", 168: "getcpu", 169: "gettimeofday", 172: "getpid", 173: "getppid", 174: "getuid",
  175: "geteuid", 176: "getgid", 177: "getegid", 178: "gettid", 179: "sysinfo", 198: "socket", 199: "socketpair", 200: "bind",
  201: "listen", 202: "accept", 203: "connect", 204: "getsockname", 205: "getpeername", 206: "sendto", 207: "recvfrom", 208: "setsockopt",
  209: "getsockopt", 210: "shutdown", 211: "sendmsg", 212: "recvmsg", 215: "munmap", 216: "mremap", 220: "clone", 222: "mmap",
  226: "mprotect", 227: "msync", 228: "mlock", 229: "munlock", 232: "mincore", 233: "madvise", 240: "rt_tgsigqueueinfo", 242: "accept4",
  260: "wait4", 261: "prlimit64", 267: "syncfs", 270: "process_vm_readv", 274: "sched_setattr", 275: "sched_getattr",
  276: "renameat", // renameat2, its flags unread
  278: "getrandom",
};
const NUMBERS32: Record<number, string> = {
  3: "read", 4: "write", 6: "close", 20: "getpid", 37: "kill", 77: "getrusage", 78: "gettimeofday", 91: "munmap", 116: "sysinfo", 125: "mprotect",
  132: "getpgid", 145: "readv", 146: "writev", 158: "sched_yield", 162: "nanosleep", 174: "rt_sigaction", 175: "rt_sigprocmask",
  177: "rt_sigtimedwait", 217: "getdents64", 221: "fcntl", 224: "gettid", 238: "tkill", 240: "futex", 241: "sched_setaffinity",
  242: "sched_getaffinity", 263: "clock_gettime", 268: "tgkill", 316: "inotify_init", 317: "inotify_add_watch", 318: "inotify_rm_watch",
  322: "openat", 332: "readlinkat", 334: "faccessat", 335: "pselect6", 336: "ppoll", 350: "timerfd_create", 352: "fallocate",
  353: "timerfd_settime", 354: "timerfd_gettime", 359: "pipe2", 360: "inotify_init1", 363: "rt_tgsigqueueinfo", 384: "getrandom",
};
function table(numbers: Record<number, string>): (HostFn | undefined)[] {
  const t = new Array<HostFn | undefined>(Math.max(...Object.keys(numbers).map(Number)) + 1).fill(undefined);
  for (const [nr, name] of Object.entries(numbers)) {
    if (!KERNEL_SYSCALLS[name]) throw new Error(`kernel: no body for ${name}`);
    t[+nr] = KERNEL_SYSCALLS[name];
  }
  return t;
}
const TABLE64 = table(NUMBERS64), TABLE32 = table(NUMBERS32);

/** The kernel every process has, whichever libc it runs: its raw system calls, the crash
 *  reporter's handlers and its file system's first descriptors. */
export function kernelInit(): void {
  setRawSyscall(rawSyscall);
  installDebuggerdHandlers();
  fsInit();
}

/** syscall(2): what a raw svc/swi and libc's wrapper both reach, the cursor at the first argument */
export function rawSyscall(cpu: Cpu, nr: number, a: ArgReader): PromiseOrVal<HostRet> {
  const fn = (cpu.a64 ? TABLE64 : TABLE32)[nr];
  if (fn) return fn(cpu, a);
  calledMissing.add("syscall " + nr);
  return -E.NOSYS;
}
