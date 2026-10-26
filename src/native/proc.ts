// The process's kernel calls: identity, sysinfo and scheduling, resource limits, capabilities and
// process_vm_readv; the auxiliary vector a process starts with; and the fortify check both libcs'
// __memcpy_chk falls back on.

import { mem } from "./mem.ts";
import { type HostFn, PTR, ldWord, stWord, stLong, ARG0 } from "./host.ts";
import { E, PAGE_SIZE, MAIN_STACK_SIZE } from "./abi.ts";
import { type Cpu, cpuByOsTid, isA64, nameThread } from "./cpu.ts";
import { exitGroup } from "./crash.ts";
import { clockTime, fillRandom, writeTs, KLAYOUT } from "./kernel.ts";
import { device } from "../shell/config.ts";
import { procIdentity, uname } from "../shell/procfs.ts";
import { uptimeMillis } from "../guest-clock.ts";

const CAP_VERSION_1 = 0x19980330, CAP_VERSION_2 = 0x20071026, CAP_VERSION_3 = 0x20080522;
const capWords = (version: number) => version === CAP_VERSION_1 ? 1 : version === CAP_VERSION_2 || version === CAP_VERSION_3 ? 2 : 0;
const resourceLimits = new Map<number, { soft: bigint; hard: bigint }>();
const RLIM_INFINITY = (1n << 64n) - 1n, RLIM_NLIMITS = 16;
/** an app process's limits on the reference device, by resource: stack (3) the main thread's 8 MiB, core (4), nproc (6),
 *  nofile (7), memlock (8), sigpending (11), msgqueue (12), nice (13) and rtprio (14); the rest unlimited */
const DEFAULT_LIMITS: Record<number, [bigint, bigint]> = {
  3: [BigInt(MAIN_STACK_SIZE), RLIM_INFINITY], 4: [0n, RLIM_INFINITY], 6: [9802n, 9802n], 7: [32768n, 32768n], 8: [65536n, 65536n],
  11: [9802n, 9802n], 12: [819200n, 819200n], 13: [40n, 40n], 14: [0n, 0n],
};
const limit = (resource: number) => {
  const [soft, hard] = DEFAULT_LIMITS[resource] ?? [RLIM_INFINITY, RLIM_INFINITY];
  return resourceLimits.get(resource) ?? { soft, hard };
};
/** a limit as an rlim_t word, whose all ones is RLIM_INFINITY like any value past its range, and back */
const wordInfinity = () => (1n << BigInt(8 * PTR)) - 1n;
const limitWord = (value: bigint) => value > wordInfinity() ? wordInfinity() : value;
const wordLimit = (word: bigint) => word === wordInfinity() ? RLIM_INFINITY : word;
const setLimit = (resource: number, soft: bigint, hard: bigint) => {
  if (resource < 0 || resource >= RLIM_NLIMITS || soft > hard) return -E.INVAL;
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
  return [[6, 4096], [16, isA64() ? 1 << 7 : 0], [26, 0], [23, 0], [25, atRandom]];
}
/** struct sysinfo: uptime, loads[3], totalram, freeram, sharedram, bufferram, totalswap, freeswap
 *  at the long stride, then procs (u16), totalhigh, freehigh, mem_unit (u32); a 32-bit build
 *  scales by mem_unit where the byte counts would not fit */
function fillSysinfo(p: number): void {
  const L = PTR, unit = isA64() ? 1 : 4096;
  const totalRam = device.cpu.memKb * 1024;
  mem.memset(p, 0, KLAYOUT.SYSINFO_SIZE);
  const put = (off: number, v: number) => stLong(p + off, v);
  put(0, Math.floor(uptimeMillis() / 1000));
  put(L * 4, totalRam / unit); put(L * 5, totalRam / (2 * unit));
  mem.st16(p + L * 10, 1);
  mem.st32(p + KLAYOUT.SYSINFO_UNIT, unit);
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

export const chk = (n: number, len: number, cpu: Cpu) => { if (n > len) cpu.fault(`fortify: ${n} bytes into a ${len}-byte object`); };
/** what the core leaves to the host of a __memcpy_chk it serves: a failed check */
export const memcpyChk: HostFn = (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; };

/** a scheduling policy's change: the normal policies; a real-time one needs CAP_SYS_NICE */
const schedPolicy = (policy: number): number => policy === 0 || policy === 3 || policy === 5 ? 0 : -(policy === 1 || policy === 2 || policy === 6 ? E.PERM : E.INVAL);
const SCHED_RESET_ON_FORK = 0x40000000;
/** struct sched_attr's first and current sizes */
const SCHED_ATTR_SIZE_VER0 = 48, SCHED_ATTR_SIZE = 56;
/** sched_getaffinity(2): every core, answering the kernel mask's size */
export function getAffinity(pid: number, n: number, set: number): number {
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

const RUSAGE_CHILDREN = -1, RUSAGE_THREAD = 1, CLOCK_PROCESS_CPUTIME_ID = 2, CLOCK_THREAD_CPUTIME_ID = 3;
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
    const u = uname(isA64()), f = [u.sysname, u.nodename, u.release, u.version, u.machine, u.domainname];
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
    const resource = a.i(), out = a.p();
    if (resource < 0 || resource >= RLIM_NLIMITS) return -E.INVAL;
    const current = limit(resource);
    stWord(out, limitWord(current.soft)); stWord(out + PTR, limitWord(current.hard));
    return 0;
  },
  setrlimit: (_c, a) => {
    const resource = a.i(), next = a.p();
    return setLimit(resource, wordLimit(ldWord(next)), wordLimit(ldWord(next + PTR)));
  },
  // struct rusage: ru_utime and ru_stime (timevals), then 14 longs. A process's or thread's CPU-time clock,
  // all of it user time; no child has run
  getrusage: (_c, a) => {
    const who = a.i(), usage = a.p();
    if (who < RUSAGE_CHILDREN || who > RUSAGE_THREAD) return -E.INVAL;
    mem.memset(usage, 0, 2 * KLAYOUT.TS_SIZE + 14 * PTR);
    if (who !== RUSAGE_CHILDREN) writeTs(usage, clockTime(who === RUSAGE_THREAD ? CLOCK_THREAD_CPUTIME_ID : CLOCK_PROCESS_CPUTIME_ID), 1e3);
    return 0;
  },
  prlimit64: (cpu, a) => {
    const pid = a.i(), resource = a.i(), next = a.p(), old = a.p();
    if (pid !== 0 && pid !== cpu.pid) return -E.SRCH;
    if (resource < 0 || resource >= RLIM_NLIMITS) return -E.INVAL;
    const previous = limit(resource);
    if (old) { mem.st64(old, previous.soft); mem.st64(old + 8, previous.hard); }
    return next ? setLimit(resource, BigInt.asUintN(64, mem.ld64(next)), BigInt.asUintN(64, mem.ld64(next + 8))) : 0;
  },
  sched_getscheduler: () => 0,
  capget: (cpu, a) => capget(cpu, a.p(), a.p()),
};
