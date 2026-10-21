// The process-facing rest of Bionic: sysinfo and scheduling, users, syslog, the abort message and
// asserts, fortified wrappers, qsort/bsearch (which call the guest's comparator),
// and the calls a sandboxed app process cannot make (fork, exec, ptrace), which fail as they
// would on a device at its process limit or under its sandbox.

import { wrote, mem } from "./mem.ts";
import { hostLib, hostData, type HostFn, PTR, ldWord, stp, stLong, vaList, ARG0, ptr, guestSort } from "./host.ts";
import { E, PAGE_SIZE } from "./abi.ts";
import { type Cpu, cpuByOsTid, nameThread } from "./cpu.ts";
import { exitGroup, setAbortMessage } from "./crash.ts";
import { SIGNAL_LIBC } from "./signals.ts";
import { fail, fillRandom, logLine, wrapped } from "./kernel.ts";
import { format, snprintfInto } from "./printf.ts";
import { device } from "../shell/config.ts";
import { PROP_VALUE_MAX, propertyHandle, propertyKey, propertyValue } from "../shell/properties.ts";
import { appUserName, procIdentity, uname } from "../shell/procfs.ts";
import { guestNow } from "../guest-clock.ts";

const CAP_VERSION_1 = 0x19980330, CAP_VERSION_2 = 0x20071026, CAP_VERSION_3 = 0x20080522;
const capWords = (version: number) => version === CAP_VERSION_1 ? 1 : version === CAP_VERSION_2 || version === CAP_VERSION_3 ? 2 : 0;
const writeProperty = (out: number, text: string) => mem.putCstr(out, text, PROP_VALUE_MAX);
const resourceLimits = new Map<number, { soft: bigint; hard: bigint }>();
/** RLIMIT_STACK is Android's 8 MiB, the main thread's stack; the rest keep 1 MiB */
const limit = (resource: number) => resourceLimits.get(resource) ?? (resource === 3 ? { soft: 0x800000n, hard: 0x800000n } : { soft: 0x100000n, hard: 0x100000n });
const writeLimit = (p: number, value: bigint) => {
  if (PTR === 8) mem.st64(p, value);
  else mem.st32(p, Number(value > 0xffffffffn ? 0xffffffffn : value));
};
const readLimit = (p: number) => PTR === 8 ? BigInt.asUintN(64, mem.ld64(p)) : BigInt(mem.ld32(p) >>> 0);
const setLimit = (resource: number, soft: bigint, hard: bigint) => {
  if (soft > hard) return -E.INVAL;
  if (hard > limit(resource).hard) return -E.PERM;
  resourceLimits.set(resource, { soft, hard });
  return 0;
};

let atRandom = 0;
/** The auxiliary vector a process starts with: AT_PAGESZ, AT_HWCAP/AT_HWCAP2, AT_SECURE and
 *  AT_RANDOM's 16 bytes (the stack guard and setjmp cookie seed). An A64 process's AT_HWCAP has
 *  HWCAP_CRC32 alone, which the reference build's libc is compiled to assume; the other optional
 *  features stay unadvertised, steering libraries away from paths the emitter lacks. */
export function auxv(): [number, number][] {
  if (!atRandom) { atRandom = mem.hostAlloc(16); fillRandom(atRandom, 16); }
  return [[6, 4096], [16, PTR === 8 ? 1 << 7 : 0], [26, 0], [23, 0], [25, atRandom]];
}
/** struct sysinfo: uptime, loads[3], totalram, freeram, sharedram, bufferram, totalswap, freeswap
 *  at the long stride, then procs (u16), totalhigh, freehigh, mem_unit (u32); a 32-bit build
 *  scales by mem_unit where the byte counts would not fit */
function fillSysinfo(p: number): void {
  const L = PTR, unit = L === 8 ? 1 : 4096;
  const totalRam = device.cpu.memKb * 1024;
  mem.memset(p, 0, L === 8 ? 112 : 64);
  const put = (off: number, v: number) => stLong(p + off, v);
  put(0, Math.floor(guestNow() / 1000));
  put(L * 4, totalRam / unit); put(L * 5, totalRam / (2 * unit));
  mem.st16(p + L * 10, 1);
  mem.st32(p + (L === 8 ? 104 : 52), unit);
}
export function strncpy(d: number, s: number, n: number): void {
  let i = 0;
  for (; i < n && mem.u8[s + i]; i++) mem.u8[d + i] = mem.u8[s + i];
  for (; i < n; i++) mem.u8[d + i] = 0;
  wrote(d, n);
}
/** at most n bytes of s after d's string, then a NUL; the size of d's string with its NUL */
export function strncat(d: number, s: number, n: number): number {
  const dl = mem.strlen(d);
  let i = 0;
  for (; i < n && mem.u8[s + i]; i++) mem.u8[d + dl + i] = mem.u8[s + i];
  mem.u8[d + dl + i] = 0;
  wrote(d + dl, i + 1);
  return dl + i + 1;
}
/** each thread's nice value, which setpriority(PRIO_PROCESS) sets (init allows every app any, RLIMIT_NICE 40) */
const niceness = new Map<number, number>();
export const niceOf = (cpu: Cpu, who: number): number => niceness.get(who || cpu.osTid) ?? 0;
export function setNice(cpu: Cpu, who: number, nice: number): number { nice = Math.min(19, Math.max(-20, nice)); niceness.set(who || cpu.osTid, nice); return nice; }
/** each of struct utsname's fields */
const UTSNAME_FIELD = 65;

/** Linux capget for the one unprivileged Android app process represented by this runtime. */
function capget(cpu: Cpu, header: number, data: number): number {
  if (!header) return -E.FAULT;
  const words = capWords(mem.ld32(header));
  if (!words) {
    mem.st32(header, CAP_VERSION_3);
    return data ? -E.INVAL : 0;
  }
  if (!data) return 0; // Linux permits a header-only capability-version probe.
  const pid = mem.ld32(header + 4);
  if (pid < 0) return -E.INVAL;
  if (pid !== 0 && pid !== cpu.pid && cpuByOsTid(pid)?.pid !== cpu.pid) return -E.SRCH;
  mem.memset(data, 0, words * 12);
  return 0;
}

const chk = (n: number, len: number, cpu: Cpu) => { if (n > len) cpu.fault(`fortify: ${n} bytes into a ${len}-byte object`); };
/** what the core leaves to the host of a __memcpy_chk it serves: a failed check */
export const memcpyChk: HostFn = (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; };

/** a scheduling policy's change: the normal policies; a real-time one needs CAP_SYS_NICE */
const schedPolicy = (policy: number): number => policy === 0 || policy === 3 || policy === 5 ? 0 : -(policy === 1 || policy === 2 || policy === 6 ? E.PERM : E.INVAL);
const SCHED_RESET_ON_FORK = 0x40000000;
/** struct sched_attr's first and current sizes */
const SCHED_ATTR_SIZE_VER0 = 48, SCHED_ATTR_SIZE = 56;
/** sched_getaffinity(2): every core, answering the kernel mask's size */
function getAffinity(pid: number, n: number, set: number): number {
  if (n < PTR || pid < 0) return -E.INVAL;
  mem.memset(set, 0, n); mem.st32(set, (1 << device.cpu.cores) - 1);
  return PTR;
}
/** process_vm_readv(2) of this process: a crash reporter's safe read */
function processVmReadv(cpu: Cpu, pid: number, local: number, nLocal: number, remote: number, nRemote: number): number {
  if (pid !== cpu.pid) return -E.SRCH;
  const iov = (at: number, n: number) => Array.from({ length: n }, (_, i) => ({ va: ldWord(at + i * 2 * PTR), len: Number(ldWord(at + i * 2 * PTR + PTR)) }));
  const chunks: Uint8Array[] = [];
  for (const { va, len } of iov(remote, nRemote)) {
    try { if (len) chunks.push(mem.bytes(mem.txVa(va & 0x00ffffffffffffffn), len).slice()); } catch { if (!chunks.length) return -E.FAULT; break; }
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
}

export const PROC_SYSCALLS: Record<string, HostFn> = {
  getpid: (cpu) => cpu.pid, gettid: (cpu) => cpu.osTid,
  getcpu: (_c, a) => { const at = a.p(), node = a.p(); if (at) mem.st32(at, 0); if (node) mem.st32(node, 0); return 0; },
  exit_group: (cpu, a) => exitGroup(cpu, a.i(), "exit_group"),
  // no second process (see cloneThread), so no child to wait for
  wait4: () => -E.CHILD,
  process_vm_readv: (cpu, a) => processVmReadv(cpu, a.i(), a.p(), a.u(), a.p(), a.u()),
  getrandom: (_c, a) => { const buf = a.p(), n = a.u(); if (n) fillRandom(buf, n); return n; },
  getuid: () => procIdentity.uid, geteuid: () => procIdentity.uid, getgid: () => procIdentity.uid, getegid: () => procIdentity.uid,
  getppid: () => 1,
  // the process leads its own group, as /proc/self/stat says; no other process is visible
  getpgid: (cpu, a) => { const pid = a.i(); return pid === 0 || pid === cpu.pid ? cpu.pid : -E.SRCH; },
  // PRIO_PROCESS names a thread; a process group's or user's nice stays 0
  setpriority: (cpu, a) => { const which = a.i(), who = a.i(), nice = a.i(); if (which < 0 || which > 2) return -E.INVAL; if (!which) setNice(cpu, who, nice); return 0; },
  // the kernel's answer is 20 - nice, which bionic's wrapper turns back into the nice value
  getpriority: (cpu, a) => { const which = a.i(), who = a.i(); return which < 0 || which > 2 ? -E.INVAL : 20 - (which ? 0 : niceOf(cpu, who)); },
  uname: (_c, a) => {
    const p = a.p();
    const u = uname(PTR === 8), f = [u.sysname, u.nodename, u.release, u.version, u.machine, u.domainname];
    for (let i = 0; i < f.length; i++) mem.putCstr(p + i * UTSNAME_FIELD, f[i], UTSNAME_FIELD);
    return 0;
  },
  // PR_SET_NAME names the calling thread: what wd.native.regs shows and what a trace prefixes
  prctl: (cpu, a) => { const op = a.i(); if (op === 15) { const s = mem.cstr(a.p(), 16); if (s) nameThread(cpu.jthread, s); } return 0; },
  sysinfo: (_c, a) => { fillSysinfo(a.p()); return 0; },
  sched_getparam: (_c, a) => { a.i(); mem.st32(a.p(), 0); return 0; },
  // one core, nothing to pin
  sched_setaffinity: () => 0,
  sched_getaffinity: (_c, a) => getAffinity(a.i(), a.u(), a.p()),
  sched_setscheduler: (_c, a) => { a.i(); return schedPolicy(a.i() & ~SCHED_RESET_ON_FORK); },
  sched_setattr: (_c, a) => {
    const pid = a.i(), attr = a.p(), flags = a.u(), size = attr ? mem.ld32(attr) || SCHED_ATTR_SIZE_VER0 : 0;
    if (pid < 0 || !attr || flags) return -E.INVAL;
    if (size < SCHED_ATTR_SIZE_VER0 || size > PAGE_SIZE) { mem.st32(attr, SCHED_ATTR_SIZE); return -E.TOOBIG; }
    return schedPolicy(mem.ld32(attr + 4));
  },
  // SCHED_OTHER at nice 0: the kernel's struct, its size the smaller of the caller's and its own, the rest zero
  sched_getattr: (_c, a) => {
    const pid = a.i(), attr = a.p(), size = a.u(), flags = a.u();
    if (pid < 0 || flags || size < SCHED_ATTR_SIZE_VER0 || size > PAGE_SIZE) return -E.INVAL;
    mem.memset(attr, 0, size); mem.st32(attr, Math.min(size, SCHED_ATTR_SIZE));
    return 0;
  },
  getrlimit: (_cpu, a) => {
    const current = limit(a.i()), out = a.p();
    writeLimit(out, current.soft); writeLimit(out + PTR, current.hard);
    return 0;
  },
  setrlimit: (_c, a) => {
    const resource = a.i(), next = a.p();
    return setLimit(resource, readLimit(next), readLimit(next + PTR));
  },
  prlimit64: (cpu, a) => {
    const pid = a.i(), resource = a.i(), next = a.p(), old = a.p();
    if (pid !== 0 && pid !== cpu.pid) return -E.SRCH;
    const previous = limit(resource);
    if (old) { mem.st64(old, previous.soft); mem.st64(old + 8, previous.hard); }
    return next ? setLimit(resource, BigInt.asUintN(64, mem.ld64(next)), BigInt.asUintN(64, mem.ld64(next + 8))) : 0;
  },
  sched_getscheduler: () => 0,
  capget: (cpu, a) => capget(cpu, a.p(), a.p()),
};

const PATH_MAX = 4096;
export function procInit(): void {
  const guard = mem.hostAlloc(8);
  const baseBuf = mem.hostAlloc(PATH_MAX), dirBuf = mem.hostAlloc(PATH_MAX);
  mem.st32(guard, (Math.random() * 0x7fffffff) | 0x100); mem.st32(guard + 4, (Math.random() * 0x7fffffff) | 0);
  hostData("libc.so", "__stack_chk_guard", guard);
  const progname = mem.hostAlloc(PTR); stp(progname, mem.hostStr("app_process"));
  hostData("libc.so", "__progname", progname);
  // struct passwd: name, passwd, uid, gid, gecos, dir, shell — pointers at the pointer stride
  const pw = mem.hostAlloc(8 * PTR);
  const uid = procIdentity.uid;
  stp(pw, mem.hostStr(appUserName(uid))); stp(pw + PTR, mem.hostStr("")); mem.st32(pw + 2 * PTR, uid); mem.st32(pw + 2 * PTR + 4, uid);
  stp(pw + 2 * PTR + 8, mem.hostStr("")); stp(pw + 3 * PTR + 8, mem.hostStr("/data")); stp(pw + 4 * PTR + 8, mem.hostStr("/system/bin/sh"));
  const M: Record<string, HostFn> = {
    ...SIGNAL_LIBC,
    // libc answers 0 where the kernel answers the mask's size
    sched_getaffinity: (cpu, a) => { const r = getAffinity(a.i(), a.u(), a.p()); return r < 0 ? fail(cpu, -r) : 0; },
    sched_getcpu: () => 0,
    __sched_cpucount: (_c, a) => { const n = a.u(), set = a.p(); let k = 0; for (let i = 0; i < n; i++) { let b = mem.ld8u(set + i); while (b) { k += b & 1; b >>= 1; } } return k; },
    sched_get_priority_max: () => 99, sched_get_priority_min: () => 1,
    getpwuid: () => pw,
    getpwuid_r: (_c, a) => { a.i(); const out = a.p(); a.p(); a.p(); const res = a.p(); mem.memmove(out, pw, 8 * PTR); stp(res, out); return 0; },
    getpwnam: () => pw,
    setuid: () => 0, setgid: () => 0, seteuid: () => 0, setegid: () => 0, setgroups: () => 0, initgroups: () => 0, setsid: (cpu) => cpu.pid,
    ptrace: (cpu) => fail(cpu, E.PERM),
    openlog: () => {}, closelog: () => {},
    syslog: (_c, a) => { const prio = a.i(), f = a.str(); logLine(prio <= 3 ? 6 : prio <= 5 ? 5 : 4, "syslog", format(f, a)); },
    vsyslog: (_c, a) => { const prio = a.i(), f = a.str(); logLine(prio <= 3 ? 6 : prio <= 5 ? 5 : 4, "syslog", format(f, vaList(a.p()))); },
    // an unset property reads as an empty value of length 0, as bionic's do
    __system_property_get: (_c, a) => { const key = a.str(); return writeProperty(a.p(), propertyValue(key) ?? ""); },
    __system_property_find: (_c, a) => propertyHandle(a.str(), (key) => mem.hostStr(key)),
    __system_property_read: (_c, a) => {
      const key = propertyKey(a.p()) ?? "", name = a.p(), value = a.p();
      if (name) writeProperty(name, key);
      return value ? writeProperty(value, propertyValue(key) ?? "") : 0;
    },
    // only init's property service sets properties, and it refuses an app
    __system_property_set: () => -1,
    android_set_abort_message: (_c, a) => { setAbortMessage(a.str()); },
    __assert2: (cpu, a) => { const file = a.str(), line = a.i(), fn = a.str(), msg = a.str(); cpu.fault(`assertion "${msg}" failed: ${file}:${line} ${fn}`); },
    __assert: (cpu, a) => { const file = a.str(), line = a.i(), msg = a.str(); cpu.fault(`assertion "${msg}" failed: ${file}:${line}`); },
    __register_atfork: () => 0,
    __cxa_thread_atexit_impl: () => 0,
    __gnu_strerror_r: (_c, a) => { const e = a.i(), b = a.p(), n = a.u(); mem.putCstr(b, `error ${e}`, n); return ptr(b); },
    __cmsg_nxthdr: () => 0,
    if_nametoindex: () => 0, if_indextoname: () => 0,
    // sorting and searching call back into the guest for every comparison
    qsort: async (cpu, a) => {
      const base = a.p(), n = a.u(), size = a.u(), cmp = a.p();
      if (n < 2) return;
      const idx = [...Array(n).keys()];
      await guestSort(idx, (i, j) => cpu.call(cmp, [base + i * size, base + j * size]));
      const copy = mem.u8.slice(base, base + n * size);
      for (let i = 0; i < n; i++) mem.u8.set(copy.subarray(idx[i] * size, (idx[i] + 1) * size), base + i * size);
      wrote(base, n * size);
    },
    bsearch: async (cpu, a) => {
      const keyp = a.p(), base = a.p(), n = a.u(), size = a.u(), cmp = a.p();
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1, p = base + mid * size;
        const r = (await cpu.call(cmp, [keyp, p])) | 0;
        if (r === 0) return p;
        if (r < 0) hi = mid; else lo = mid + 1;
      }
      return 0;
    },
    strlcpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const l = mem.strlen(s); if (n) { const k = Math.min(l, n - 1); mem.memmove(d, s, k); mem.st8(d + k, 0); } return l; },
    strlcat: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const dl = Math.min(mem.strlen(d), n), l = mem.strlen(s); if (dl < n) { const k = Math.min(l, n - dl - 1); mem.memmove(d + dl, s, k); mem.st8(d + dl + k, 0); } return dl + l; },
    basename: (_c, a) => { const s = mem.cstr(a.p()).replace(/\/+$/, ""); mem.putCstr(baseBuf, s === "" ? "/" : s.slice(s.lastIndexOf("/") + 1), PATH_MAX); return baseBuf; },
    dirname: (_c, a) => { const s = mem.cstr(a.p()).replace(/\/+$/, ""), i = s.lastIndexOf("/"); mem.putCstr(dirBuf, i < 0 ? "." : i === 0 ? "/" : s.slice(0, i), PATH_MAX); return dirBuf; },
    fnmatch: (_c, a) => {
      const pat = a.str(), str = a.str();
      const re = "^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
      return new RegExp(re).test(str) ? 0 : 1;
    },
    // fortified wrappers: the object size is checked, then the plain function's work is done
    __memcpy_chk: memcpyChk,
    __memmove_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; },
    __memset_chk: (cpu, a) => { const d = a.p(), v = a.i(), n = a.u(); chk(n, a.u(), cpu); mem.memset(d, v, n); return ARG0; },
    __strcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s) + 1; chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; },
    __stpcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s) + 1; chk(n, a.u(), cpu); mem.memmove(d, s, n); return ptr(d + n - 1); },
    __strncpy_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); strncpy(d, s, n); return ARG0; },
    __strncpy_chk2: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); a.u(); strncpy(d, s, n); return ARG0; },
    __strcat_chk: (cpu, a) => { const d = a.p(), s = a.p(); const dl = mem.strlen(d), n = mem.strlen(s) + 1; chk(dl + n, a.u(), cpu); mem.memmove(d + dl, s, n); return ARG0; },
    __strncat_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(strncat(d, s, n), a.u(), cpu); return ARG0; },
    __strlen_chk: (cpu, a) => { const s = a.p(); const n = mem.strlen(s); chk(n + 1, a.u(), cpu); return n; },
    __vsnprintf_chk: (cpu, a) => { const d = a.p(), n = a.u(); a.i(); chk(n, a.u(), cpu); const f = a.str(); return snprintfInto(d, n, format(f, vaList(a.p()))); },
    __snprintf_chk: (cpu, a) => { const d = a.p(), n = a.u(); a.i(); chk(n, a.u(), cpu); const f = a.str(); return snprintfInto(d, n, format(f, a)); },
    __vsprintf_chk: (_c, a) => { const d = a.p(); a.i(); a.u(); const f = a.str(); return mem.putCstr(d, format(f, vaList(a.p()))); },
    __sprintf_chk: (_c, a) => { const d = a.p(); a.i(); a.u(); const f = a.str(); return mem.putCstr(d, format(f, a)); },
    __umask_chk: () => 0o22,
    __FD_SET_chk: (_c, a) => { const fd = a.i(), set = a.p(); mem.st8(set + (fd >> 3), mem.ld8u(set + (fd >> 3)) | (1 << (fd & 7))); },
    __FD_CLR_chk: (_c, a) => { const fd = a.i(), set = a.p(); mem.st8(set + (fd >> 3), mem.ld8u(set + (fd >> 3)) & ~(1 << (fd & 7))); },
    __FD_ISSET_chk: (_c, a) => { const fd = a.i(), set = a.p(); return (mem.ld8u(set + (fd >> 3)) >> (fd & 7)) & 1; },
  };
  for (const n of ["fork", "vfork"]) M[n] = (cpu) => fail(cpu, E.AGAIN);
  for (const n of ["waitpid", "wait"]) M[n] = wrapped(PROC_SYSCALLS.wait4);
  for (const n of ["execl", "execlp", "execv", "execve", "execvp"]) M[n] = (cpu) => fail(cpu, E.NOSYS);
  hostLib("libc.so", M);
}
