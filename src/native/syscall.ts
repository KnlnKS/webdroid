// The kernel's system call boundary: the numbers a raw svc/swi (bionic's own wrappers) and libc's
// syscall(2) reach. Most are served by the body of the same name in an owning module's record,
// which answers the wrapper's way (-1 with errno set); Cpu.syscallReturn turns that into -errno.
// The handlers here are the calls whose kernel shape differs from any wrapper's.

import { mem, anchor } from "./mem";
import { parkTimeout, unparkTimeout } from "../jvm/yield";
import { calledMissing, markKernelEntries, type HostFn, type HostRet, type ArgReader, PTR } from "./host";
import { E, PAGE_SIZE } from "./abi";
import { cpuByOsTid, setRawSyscall, type Cpu } from "./cpu";
import { exitGroup, installDebuggerdHandlers } from "./crash";
import { blocked, signalThread, SIGNAL_SYSCALLS } from "./signals";
import { writeSiginfo } from "./sigframe";
import { LIBC_SYSCALLS, fail, fillRandom, fillSysinfo, readTs } from "./libc";
import { FS_SYSCALLS, fsInit, faccessatPath, fdFallocate, getdents64 } from "./fs";
import { PTHREAD_SYSCALLS, futex, cloneThread } from "./pthread";
import { NET_SYSCALLS } from "./socket/syscalls";
import { POLL_SYSCALLS, nativePoll, nativeSelect } from "./poll";
import { PROC_SYSCALLS } from "./proc";
import { TIMER_SYSCALLS } from "./timers";
import { device } from "../shell/config";

/** the structs the kernel fills, as each ABI lays them out (stat64 and statfs64 on ILP32) */
const KERNEL32 = {
  STAT_SIZE: 104, ST_INO32: 12, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 80, ST_CTIME: 88, ST_INO: 96, TS_SEC: 0, TS_NSEC: 4, TS_SIZE: 8, STATFS_SIZE: 88,
};
const KERNEL64: typeof KERNEL32 = {
  STAT_SIZE: 128, ST_INO32: 8, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 88, ST_CTIME: 104, ST_INO: 8, TS_SEC: 0, TS_NSEC: 8, TS_SIZE: 16, STATFS_SIZE: 120,
};
/** the process ABI's kernel structs, chosen by kernelInit */
export let KLAYOUT = KERNEL32;

/** served by the body of the same arguments (an offset in a register on LP64 makes mmap direct;
 *  ILP32's mmap2 counts pages and _llseek splits the offset, so neither is in its table) */
const SAME64: Record<number, string> = {
  17: "getcwd", 19: "eventfd", 20: "epoll_create1", 21: "epoll_ctl", 22: "epoll_pwait", 23: "dup", 24: "dup3", 25: "fcntl",
  26: "inotify_init1", 27: "inotify_add_watch", 28: "inotify_rm_watch", 29: "ioctl", 32: "flock", 34: "mkdirat", 35: "unlinkat",
  43: "statfs", 44: "fstatfs", 45: "truncate", 46: "ftruncate", 49: "chdir", 52: "fchmod", 53: "fchmodat", 55: "fchown",
  56: "openat", 57: "close", 59: "pipe2", 62: "lseek", 63: "read", 64: "write", 65: "readv", 66: "writev", 67: "pread64",
  68: "pwrite64", 71: "sendfile", 78: "readlinkat", 79: "fstatat", 80: "fstat", 82: "fsync", 83: "fdatasync",
  85: "timerfd_create", 86: "timerfd_settime", 87: "timerfd_gettime", 88: "utimensat", 90: "capget", 101: "nanosleep",
  107: "timer_create", 108: "timer_gettime", 109: "timer_getoverrun", 110: "timer_settime", 111: "timer_delete",
  113: "clock_gettime", 114: "clock_getres", 115: "clock_nanosleep", 120: "sched_getscheduler", 124: "sched_yield",
  129: "kill", 133: "sigsuspend", 131: "tgkill", 132: "sigaltstack", 134: "rt_sigaction", 140: "setpriority", 141: "getpriority", 155: "getpgid",
  160: "uname", 163: "getrlimit", 164: "setrlimit", 166: "umask", 167: "prctl", 169: "gettimeofday", 173: "getppid",
  174: "getuid", 175: "geteuid", 176: "getgid", 177: "getegid", 198: "socket", 199: "socketpair", 200: "bind", 201: "listen",
  202: "accept", 203: "connect", 204: "getsockname", 205: "getpeername", 206: "sendto", 207: "recvfrom", 208: "setsockopt",
  209: "getsockopt", 210: "shutdown", 211: "sendmsg", 212: "recvmsg", 215: "munmap", 216: "mremap", 222: "mmap",
  226: "mprotect", 227: "msync", 228: "mlock", 229: "munlock", 233: "madvise", 242: "accept4", 261: "prlimit64", 267: "syncfs",
  276: "renameat", // renameat2, its flags unread
};
const SAME32: Record<number, string> = {
  316: "inotify_init", 317: "inotify_add_watch", 318: "inotify_rm_watch", 360: "inotify_init1",
  350: "timerfd_create", 353: "timerfd_settime", 354: "timerfd_gettime",
  221: "fcntl", 322: "openat", 6: "close", 3: "read", 4: "write", 145: "readv", 146: "writev", 162: "nanosleep", 263: "clock_gettime", 37: "kill", 268: "tgkill",
  78: "gettimeofday", 91: "munmap", 125: "mprotect", 132: "getpgid", 174: "rt_sigaction", 332: "readlinkat", 359: "pipe2",
};

const millis = (ts: number): number => (ts ? readTs(ts) : -1);
/** struct sched_attr's first and current sizes */
const SCHED_ATTR_SIZE_VER0 = 48, SCHED_ATTR_SIZE = 56;

const A64: Record<number, HostFn> = {
  47: (cpu, a) => {                                                              // fallocate: mode 0 grows the file
    const fd = a.i(), mode = a.i(), off = Number(a.l()), len = Number(a.l());
    const e = mode ? E.NOTSUP : fdFallocate(fd, off, len);
    return e ? fail(cpu, e) : 0;
  },
  48: (cpu, a) => faccessatPath(cpu, a.i(), a.str(), a.i(), 0),                 // faccessat has no flags
  61: (cpu, a) => getdents64(cpu, a.i(), a.p(), a.u()),
  72: (cpu, a) => {                                                              // pselect6: a timespec, and a sigmask left as is
    const n = a.i(), r = a.p(), w = a.p(), x = a.p(), ts = a.p();
    return nativeSelect(cpu, n, r, w, x, millis(ts));
  },
  73: (cpu, a) => { const fds = a.p(), n = a.u(), ts = a.p(); return nativePoll(cpu, fds, n, millis(ts)); }, // ppoll
  93: (cpu) => { cpu.finished = true; return Promise.resolve(0); },               // exit: this thread
  94: (cpu, a) => exitGroup(cpu, a.i(), "exit_group"),
  96: (cpu, a) => { cpu.clearChildTid = a.va(); return cpu.osTid; },               // set_tid_address
  98: (cpu, a) => { const addr = a.p(), op = a.i(), val = a.i(), ts = a.p(); return futex(cpu, addr, op, val, ts); },
  99: () => 0,                                                                   // set_robust_list: no process-shared robust mutexes to recover
  121: (_c, a) => { a.i(); mem.st32(a.p(), 0); return 0; },                     // sched_getparam: SCHED_OTHER's priority
  119: (cpu, a) => { a.i(); const policy = a.i() & ~0x40000000; return policy === 0 || policy === 3 || policy === 5 ? 0 : fail(cpu, E.PERM); }, // sched_setscheduler: the normal policies; real-time needs CAP_SYS_NICE
  122: () => 0,                                                                  // sched_setaffinity: one core, nothing to pin
  123: (cpu, a) => {                                                             // sched_getaffinity
    const pid = a.i(), n = a.u(), set = a.p();
    if (n < PTR || pid < 0) return fail(cpu, E.INVAL);
    mem.memset(set, 0, n); mem.st32(set, (1 << device.cpu.cores) - 1);
    return PTR;
  },
  274: (cpu, a) => {                                                             // sched_setattr: as sched_setscheduler
    const pid = a.i(), attr = a.p(), flags = a.u(), size = attr ? mem.ld32(attr) || SCHED_ATTR_SIZE_VER0 : 0;
    if (pid < 0 || !attr || flags) return fail(cpu, E.INVAL);
    if (size < SCHED_ATTR_SIZE_VER0 || size > PAGE_SIZE) { mem.st32(attr, SCHED_ATTR_SIZE); return fail(cpu, E.TOOBIG); }
    const policy = mem.ld32(attr + 4);
    return policy === 0 || policy === 3 || policy === 5 ? 0 : fail(cpu, policy <= 2 || policy === 6 ? E.PERM : E.INVAL);
  },
  275: (cpu, a) => {                                                             // sched_getattr: SCHED_OTHER at nice 0
    const pid = a.i(), attr = a.p(), size = a.u(), flags = a.u();
    if (pid < 0 || flags || size < SCHED_ATTR_SIZE_VER0 || size > PAGE_SIZE) return fail(cpu, E.INVAL);
    // the kernel's struct, its size the smaller of the caller's and its own, the rest zero
    mem.memset(attr, 0, size); mem.st32(attr, Math.min(size, SCHED_ATTR_SIZE));
    return 0;
  },
  130: (cpu, a) => { const t = cpuByOsTid(a.i()), sig = a.i(); if (!t || t.finished) return fail(cpu, E.SRCH); return signalThread(cpu, t, sig); }, // tkill
  137: (cpu, a) => {                                                             // rt_sigtimedwait
    const set = mem.ld64(a.p()), info = anchor(a.p()), ms = millis(a.p());
    const take = (): number => {
      const i = cpu.signals.findIndex((sig) => blocked(set, sig));
      if (i < 0) return 0;
      const sig = cpu.signals.splice(i, 1)[0];
      const at = info();
      const si = cpu.queuedInfo(sig);
      if (at) writeSiginfo(at, sig, si);
      return sig;
    };
    const now = take();
    if (now || ms === 0) return now || fail(cpu, E.AGAIN);
    return new Promise<number>((resolve) => {
      const done = (r: number) => { cpu.sigQueued = null; unparkTimeout(timer); resolve(r); };
      const timer = ms < 0 ? undefined : parkTimeout(() => done(fail(cpu, E.AGAIN)), ms);
      cpu.sigQueued = () => { const sig = take(); if (sig) done(sig); };
    });
  },
  168: (_c, a) => { const cpuOut = a.p(), node = a.p(); if (cpuOut) mem.st32(cpuOut, 0); if (node) mem.st32(node, 0); return 0; }, // getcpu
  172: (cpu) => cpu.pid,
  178: (cpu) => cpu.osTid,
  179: (_c, a) => { fillSysinfo(a.p()); return 0; },
  220: (cpu, a) => { const flags = a.u(), stack = a.va(), ptid = a.p(), tls = a.va(), ctid = a.p(); return cloneThread(cpu, flags, stack, ptid, tls, ctid); },
  232: (cpu, a) => {                                                             // mincore
    const addr = a.va(), len = Number(a.va()), vec = a.p();
    if (addr & BigInt(PAGE_SIZE - 1) || !Number.isSafeInteger(len) || len <= 0) return fail(cpu, E.INVAL);
    for (let i = 0; i < Math.ceil(len / PAGE_SIZE); i++) {
      const resident = mem.residentVa(addr + BigInt(i * PAGE_SIZE));
      if (resident < 0) return fail(cpu, E.NOMEM);
      mem.st8(vec + i, resident);
    }
    return 0;
  },
  260: (cpu) => fail(cpu, E.CHILD),                                              // wait4: no guest child exists
  240: (cpu, a) => {                                                             // rt_tgsigqueueinfo: the info is not carried
    const pid = a.i(), t = cpuByOsTid(a.i()), sig = a.i();
    if (pid !== cpu.pid || !t || t.finished) return fail(cpu, E.SRCH);
    return signalThread(cpu, t, sig);
  },
  270: (cpu, a) => {                                                             // process_vm_readv, of this process: a crash reporter's safe read
    const pid = a.i(), local = a.p(), nLocal = a.u(), remote = a.p(), nRemote = a.u();
    if (pid !== cpu.pid) return fail(cpu, E.SRCH);
    const iov = (at: number, n: number) => Array.from({ length: n }, (_, i) => ({ va: mem.ld64(at + i * 16), len: Number(mem.ld64(at + i * 16 + 8)) }));
    const chunks: Uint8Array[] = [];
    for (const { va, len } of iov(remote, nRemote)) {
      try { if (len) chunks.push(mem.bytes(mem.txVa(va & 0x00ffffffffffffffn), len).slice()); } catch { if (!chunks.length) return fail(cpu, E.FAULT); break; }
    }
    let moved = 0, at = 0, chunk = 0;
    for (const { va, len } of iov(local, nLocal)) {
      for (let done = 0; done < len && chunk < chunks.length;) {
        const n = Math.min(len - done, chunks[chunk].length - at);
        mem.write(mem.txVa(va + BigInt(done)), chunks[chunk].subarray(at, at + n));
        done += n; at += n; moved += n;
        if (at === chunks[chunk].length) { chunk++; at = 0; }
      }
    }
    return moved;
  },
  278: (_c, a) => { const buf = a.p(), n = a.u(); if (n) fillRandom(buf, n); return n; }, // getrandom
};
const A32: Record<number, HostFn> = {
  240: A64[98], 224: A64[178], 20: A64[172], 384: A64[278], 241: A64[122], 242: A64[123], 116: A64[179],
  // ARM's raw faccessat has three arguments; libc's faccessat wrapper has a fourth flags argument
  334: A64[48],
};

/** bionic's functions that hand their pointers straight to the kernel, so a bad one fails with
 *  EFAULT: its syscall stubs and the functions that only tail-call them (from the reference
 *  libc.so's code), and the few whose C body passes the pointer through untouched (open, creat,
 *  chmod, readlink, statfs, connect). Only those with a host body are listed. */
const WRAPPERS = ("access bind capget chdir chmod chown connect creat epoll_ctl epoll_pwait epoll_wait faccessat fchmodat fchown " +
  "fdatasync flock fstat fstat64 fstatat fstatat64 fstatfs fsync ftruncate ftruncate64 futimens getpeername getrlimit getsockname " +
  "getsockopt inotify_add_watch inotify_rm_watch link listen lstat lstat64 madvise mkdir mkdirat mkfifo mlock mmap mmap64 mprotect " +
  "mremap msync munlock munmap nanosleep open openat prctl pread pread64 prlimit64 pwrite pwrite64 read readlink readlinkat readv " +
  "recv recvfrom rename renameat rmdir sched_getparam sched_setaffinity sched_setscheduler sendfile setgroups setrlimit setsockopt " +
  "stat stat64 statfs symlink sysinfo timerfd_gettime timerfd_settime times truncate uname unlink unlinkat utimensat write writev").split(" ");

let table: (HostFn | undefined)[] = [];

/** The kernel every process has, whichever libc it runs: the process ABI's struct layouts, its
 *  syscall table and its file system's first descriptors. */
export function kernelInit(): void {
  const wide = PTR === 8;
  KLAYOUT = wide ? KERNEL64 : KERNEL32;
  const byName: Record<string, HostFn> = { ...LIBC_SYSCALLS, ...FS_SYSCALLS, ...PTHREAD_SYSCALLS, ...NET_SYSCALLS, ...POLL_SYSCALLS, ...PROC_SYSCALLS, ...SIGNAL_SYSCALLS, ...TIMER_SYSCALLS };
  table = [];
  for (const [nr, name] of Object.entries(wide ? SAME64 : SAME32)) {
    if (!byName[name]) throw new Error(`kernel: no body for ${name}`);
    table[+nr] = byName[name];
  }
  for (const [nr, fn] of Object.entries(wide ? A64 : A32)) table[+nr] = fn;
  markKernelEntries([...Object.keys(byName), ...WRAPPERS, "syscall"]);
  setRawSyscall(rawSyscall);
  installDebuggerdHandlers();
  fsInit();
}

/** syscall(2): what a raw svc/swi and libc's wrapper both reach, the cursor at the first argument */
export function rawSyscall(cpu: Cpu, nr: number, a: ArgReader): HostRet | Promise<HostRet> {
  const fn = table[nr];
  if (fn) return fn(cpu, a);
  calledMissing.add("syscall " + nr);
  return fail(cpu, E.NOSYS);
}
/** libc's syscall(2) */
export const syscallEntry: HostFn = (cpu, a) => rawSyscall(cpu, a.i(), a);
