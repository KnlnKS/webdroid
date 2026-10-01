// The kernel's system call boundary: the numbers a raw svc/swi (bionic's own wrappers) and libc's
// syscall(2) reach. Most are served by the HLE libc body that takes the same arguments; those
// answer the wrapper's way (-1 with errno set), which Cpu.syscallReturn turns into -errno. The
// handlers here are the calls whose kernel shape differs from any libc function's.

import { mem, guestAt } from "./mem";
import { parkTimeout, unparkTimeout } from "../jvm/yield";
import { hostFn, calledMissing, type HostFn, type HostRet, type ArgReader, PTR } from "./host";
import { E, PAGE_SIZE } from "./abi";
import { cpuByOsTid, markProcessExited, type Cpu } from "./cpu";
import { fail, fillRandom, fillSysinfo, readTs } from "./libc";
import { faccessatPath, fdFallocate, getdents64 } from "./stdio";
import { futex, cloneThread } from "./pthread";
import { nativePoll, nativeSelect } from "./net";
import { device } from "../shell/config";
import { signalThread } from "./proc";

/** served by the libc function of the same arguments (an offset in a register on LP64 makes mmap
 *  direct; ILP32's mmap2 counts pages and _llseek splits the offset, so neither is in its table) */
const SAME64: Record<number, string> = {
  17: "getcwd", 19: "eventfd", 20: "epoll_create1", 21: "epoll_ctl", 22: "epoll_pwait", 23: "dup", 24: "dup3", 25: "fcntl",
  26: "inotify_init1", 27: "inotify_add_watch", 28: "inotify_rm_watch", 29: "ioctl", 32: "flock", 34: "mkdirat", 35: "unlinkat",
  43: "statfs", 44: "fstatfs", 45: "truncate", 46: "ftruncate", 49: "chdir", 52: "fchmod", 53: "fchmodat", 55: "fchown",
  56: "openat", 57: "close", 59: "pipe2", 62: "lseek", 63: "read", 64: "write", 65: "readv", 66: "writev", 67: "pread64",
  68: "pwrite64", 71: "sendfile", 78: "readlinkat", 79: "fstatat", 80: "fstat", 82: "fsync", 83: "fdatasync",
  85: "timerfd_create", 86: "timerfd_settime", 87: "timerfd_gettime", 88: "utimensat", 90: "capget", 101: "nanosleep",
  113: "clock_gettime", 114: "clock_getres", 115: "clock_nanosleep", 120: "sched_getscheduler", 124: "sched_yield",
  129: "kill", 131: "tgkill", 132: "sigaltstack", 134: "rt_sigaction", 140: "setpriority", 141: "getpriority", 155: "getpgid",
  160: "uname", 163: "getrlimit", 164: "setrlimit", 166: "umask", 167: "prctl", 169: "gettimeofday", 173: "getppid",
  174: "getuid", 175: "geteuid", 176: "getgid", 177: "getegid", 198: "socket", 199: "socketpair", 200: "bind", 201: "listen",
  202: "accept", 203: "connect", 204: "getsockname", 205: "getpeername", 206: "sendto", 207: "recvfrom", 208: "setsockopt",
  209: "getsockopt", 210: "shutdown", 211: "sendmsg", 212: "recvmsg", 215: "munmap", 216: "mremap", 222: "mmap",
  226: "mprotect", 227: "msync", 228: "mlock", 229: "munlock", 233: "madvise", 242: "accept4", 261: "prlimit64", 267: "syncfs",
};
const SAME32: Record<number, string> = {
  316: "inotify_init", 317: "inotify_add_watch", 318: "inotify_rm_watch", 360: "inotify_init1",
  350: "timerfd_create", 353: "timerfd_settime", 354: "timerfd_gettime",
  221: "fcntl", 322: "openat", 6: "close", 3: "read", 4: "write", 145: "readv", 146: "writev", 162: "nanosleep", 263: "clock_gettime", 37: "kill", 268: "tgkill",
  78: "gettimeofday", 91: "munmap", 125: "mprotect", 132: "getpgid", 174: "rt_sigaction", 332: "readlinkat", 359: "pipe2",
};

const millis = (ts: number): number => (ts ? readTs(ts) : -1);

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
  94: (cpu, a) => { console.warn(`[native] exit_group(${a.i()}) from ${cpu.name}`); markProcessExited(); cpu.finished = true; return new Promise<never>(() => {}); },
  96: (cpu, a) => { cpu.clearChildTid = a.va(); return cpu.osTid; },               // set_tid_address
  98: (cpu, a) => { const addr = a.p(), op = a.i(), val = a.i(), ts = a.p(); return futex(cpu, addr, op, val, ts); },
  99: () => 0,                                                                   // set_robust_list: no process-shared robust mutexes to recover
  121: (_c, a) => { a.i(); mem.st32(a.p(), 0); return 0; },                     // sched_getparam: SCHED_OTHER's priority
  122: () => 0,                                                                  // sched_setaffinity: one core, nothing to pin
  123: (cpu, a) => {                                                             // sched_getaffinity
    const pid = a.i(), n = a.u(), set = a.p();
    if (n < PTR || pid < 0) return fail(cpu, E.INVAL);
    mem.memset(set, 0, n); mem.st32(set, (1 << device.cpu.cores) - 1);
    return PTR;
  },
  130: (cpu, a) => { const t = cpuByOsTid(a.i()), sig = a.i(); if (!t || t.finished) return fail(cpu, E.SRCH); signalThread(cpu, t, sig); return 0; }, // tkill
  137: (cpu, a) => {                                                             // rt_sigtimedwait
    const set = mem.ld64(a.p()), info = a.p() ? mem.va(a.p()) : 0, ms = millis(a.p());
    const take = (): number => {
      const i = cpu.signals.findIndex((sig) => set & 1n << BigInt(sig - 1));
      if (i < 0) return 0;
      const sig = cpu.signals.splice(i, 1)[0];
      if (info) { const at = guestAt(info); mem.memset(at, 0, 128); mem.st32(at, sig); }
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
    signalThread(cpu, t, sig);
    return 0;
  },
  276: (cpu, a) => hostFn("libc.so", "renameat")!(cpu, a),                       // renameat2, its flags unread
  278: (_c, a) => { const buf = a.p(), n = a.u(); if (n) fillRandom(buf, n); return n; }, // getrandom
};
const A32: Record<number, HostFn> = {
  240: A64[98], 224: A64[178], 20: A64[172], 384: A64[278], 241: A64[122], 242: A64[123], 116: A64[179],
  // ARM's raw faccessat has three arguments; libc's faccessat wrapper has a fourth flags argument
  334: A64[48],
};

/** syscall(2): what a raw svc/swi and libc's wrapper both reach, the cursor at the first argument */
export function rawSyscall(cpu: Cpu, nr: number, a: ArgReader): HostRet | Promise<HostRet> {
  const own = (PTR === 8 ? A64 : A32)[nr];
  if (own) return own(cpu, a);
  const name = (PTR === 8 ? SAME64 : SAME32)[nr];
  if (name) return hostFn("libc.so", name)!(cpu, a);
  calledMissing.add("syscall " + nr);
  return fail(cpu, E.NOSYS);
}
