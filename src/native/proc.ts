// The process-facing rest of Bionic: sysinfo and scheduling, users, signals, syslog, the abort
// message and asserts, fortified wrappers, qsort/bsearch (which call the guest's comparator),
// and the calls a sandboxed app process cannot make (fork, exec, ptrace), which fail as they
// would on a device.

import { mem } from "./mem";
import { hostLib, hostData, type HostFn, type ArgReader, PTR, stp, ldp, vaList, ARG0, ptr } from "./host";
import { E } from "./abi";
import { type Cpu, cpuByTid, sigHandlers } from "./cpu";
import { tidOf } from "./pthread";
import { fail, logLine, LAYOUT, strncpy, snprintfInto, readTm } from "./libc";
import { MONTHS, DAYS } from "../jvm/natives/jtime";
import { format } from "./printf";
import { device } from "../shell/config";
/** wd.native.killLog: the last pthread_kill calls, who signalled whom and what the target was doing */
export const killLog: string[] = [];

const CAP_VERSION_1 = 0x19980330, CAP_VERSION_2 = 0x20071026, CAP_VERSION_3 = 0x20080522;
const capWords = (version: number) => version === CAP_VERSION_1 ? 1 : version === CAP_VERSION_2 || version === CAP_VERSION_3 ? 2 : 0;

/** Linux capget for the one unprivileged Android app process represented by this runtime. */
function capget(cpu: Cpu, header: number, data: number): number {
  if (!header) return fail(cpu, 14);                                               // EFAULT
  const words = capWords(mem.ld32(header));
  if (!words) {
    mem.st32(header, CAP_VERSION_3);
    return data ? fail(cpu, E.INVAL) : 0;
  }
  if (!data) return 0; // Linux permits a header-only capability-version probe.
  const pid = mem.ld32(header + 4);
  if (pid < 0) return fail(cpu, E.INVAL);
  if (pid !== 0 && pid !== 4242 && !cpuByTid(pid - 4242)) return fail(cpu, E.SRCH);
  mem.memset(data, 0, words * 12);
  return 0;
}

let abortMessage = "";
export function abortMessageOr(what: string): string { return abortMessage ? `${what}: ${abortMessage}` : what; }

function sigaction(a: ArgReader, wide: boolean): number {
  const sig = a.i(), act = a.p(), old = a.p(), prev = sigHandlers.get(sig);
  const ilp32wide = wide && PTR !== 8;
  const size = ilp32wide ? 20 : LAYOUT.SIGACTION_SIZE, flagsAt = ilp32wide ? 12 : LAYOUT.SA_FLAGS, maskAt = PTR === 8 ? 16 : 4;
  const wideMask = wide || PTR === 8;
  if (old) {
    mem.memset(old, 0, size);
    if (prev) {
      stp(old + LAYOUT.SA_HANDLER, prev.fn); mem.st32(old + flagsAt, prev.flags);
      if (wideMask) mem.st64(old + maskAt, prev.mask ?? 0n); else mem.st32(old + maskAt, Number((prev.mask ?? 0n) & 0xffffffffn));
    }
  }
  if (act) {
    const fn = ldp(act + LAYOUT.SA_HANDLER);
    if (fn > 1) sigHandlers.set(sig, { fn, flags: mem.ld32(act + flagsAt), mask: wideMask ? mem.ld64(act + maskAt) : BigInt(mem.ld32(act + maskAt) >>> 0) });
    else sigHandlers.delete(sig);
  }
  return 0;
}
/** the raw rt_sigaction syscall: struct sigaction as the kernel lays it out (handler, flags, restorer,
 *  mask), which is not bionic's, and a mask the size the caller states */
function rtSigaction(a: ArgReader): number {
  const sig = a.i(), act = a.p(), old = a.p(), prev = sigHandlers.get(sig);
  const flagsAt = PTR, maskAt = 3 * PTR, size = maskAt + 8;
  if (old) {
    mem.memset(old, 0, size);
    if (prev) { stp(old, prev.fn); mem.st32(old + flagsAt, prev.flags); mem.st64(old + maskAt, prev.mask ?? 0n); }
  }
  if (act) {
    const fn = ldp(act);
    if (fn > 1) sigHandlers.set(sig, { fn, flags: mem.ld32(act + flagsAt), mask: mem.ld64(act + maskAt) });
    else sigHandlers.delete(sig);
  }
  return 0;
}
export function procInit(): void {
  const guard = mem.hostAlloc(8);
  mem.st32(guard, (Math.random() * 0x7fffffff) | 0x100); mem.st32(guard + 4, (Math.random() * 0x7fffffff) | 0);
  hostData("libc.so", "__stack_chk_guard", guard);
  const progname = mem.hostAlloc(PTR); stp(progname, mem.hostStr("app_process"));
  hostData("libc.so", "__progname", progname);
  const u8 = mem.u8;
  // struct passwd: name, passwd, uid, gid, gecos, dir, shell — pointers at the pointer stride
  const pw = mem.hostAlloc(8 * PTR);
  stp(pw, mem.hostStr("u0_a123")); stp(pw + PTR, mem.hostStr("")); mem.st32(pw + 2 * PTR, 10123); mem.st32(pw + 2 * PTR + 4, 10123);
  stp(pw + 2 * PTR + 8, mem.hostStr("")); stp(pw + 3 * PTR + 8, mem.hostStr("/data")); stp(pw + 4 * PTR + 8, mem.hostStr("/system/bin/sh"));
  const cpuMask = (1 << device.cpu.cores) - 1;
  const chk = (n: number, len: number, cpu: Cpu) => { if (n > len) cpu.fault(`fortify: ${n} bytes into a ${len}-byte object`); };
  const M: Record<string, HostFn> = {
    sysinfo: (_c, a) => {
      const p = a.p(), total = device.cpu.memKb * 1024;
      mem.memset(p, 0, 112);
      stp(p, Math.floor(performance.now() / 1000));                                 // uptime
      const at = (i: number) => p + (PTR === 8 ? 32 + 8 * i : 16 + 4 * i);        // totalram, freeram, sharedram, bufferram, totalswap, freeswap
      stp(at(0), total); stp(at(1), total >> 1);
      mem.st16(PTR === 8 ? p + 80 : p + 40, 64);                                     // procs
      mem.st32(PTR === 8 ? p + 104 : p + 52, 1);                                     // mem_unit
      return 0;
    },
    sched_getaffinity: (_c, a) => { a.i(); const n = a.u(), set = a.p(); mem.memset(set, 0, n); mem.st32(set, cpuMask); return 0; },
    sched_setaffinity: () => 0, sched_getcpu: () => 0,
    __sched_cpucount: (_c, a) => { const n = a.u(), set = a.p(); let k = 0; for (let i = 0; i < n; i++) { let b = u8[set + i]; while (b) { k += b & 1; b >>= 1; } } return k; },
    sched_get_priority_max: () => 99, sched_get_priority_min: () => 1,
    sched_getscheduler: () => 0, sched_setscheduler: () => 0, sched_getparam: (_c, a) => { a.i(); mem.st32(a.p(), 0); return 0; },
    capget: (cpu, a) => capget(cpu, a.p(), a.p()),
    getpwuid: () => pw,
    getpwuid_r: (_c, a) => { a.i(); const out = a.p(); a.p(); a.p(); const res = a.p(); mem.memmove(out, pw, 8 * PTR); stp(res, out); return 0; },
    getpwnam: () => pw,
    setuid: () => 0, setgid: () => 0, seteuid: () => 0, setegid: () => 0, setgroups: () => 0, initgroups: () => 0, setsid: () => 4242,
    ptrace: (cpu) => fail(cpu, E.PERM),
    // signals: a handler runs on the target thread, at once when it is parked in a host call
    // (as a kernel interrupts a syscall) and at its next slice boundary when it is running
    // bionic reserves the first two realtime signals for itself: SIGRTMIN is 34, SIGRTMAX 64
    __libc_current_sigrtmin: () => 34, __libc_current_sigrtmax: () => 64,
    sigaction: (_c, a) => sigaction(a, false),
    rt_sigaction: (_c, a) => rtSigaction(a),
    // bionic's 64-bit-mask variant: the same record on LP64; on ILP32 the mask widens to 8
    // bytes at +4 and pushes sa_flags to +12
    sigaction64: (_c, a) => sigaction(a, true),
    signal: (_c, a) => { const sig = a.i(), fn = a.p(), prev = sigHandlers.get(sig)?.fn ?? 0; if (fn > 1) sigHandlers.set(sig, { fn, flags: 0 }); else sigHandlers.delete(sig); return prev; },
    // a thread that has run to its end is gone: ESRCH, which a stop-the-world collector discounts
    pthread_kill: (c, a) => {
      const tid = tidOf(a.p()), t = cpuByTid(tid), sig = a.i(), r = !t || t.finished ? E.SRCH : 0;
      killLog.push(`${c.name}->${t?.name ?? "tid" + tid}:${sig}=${r}${t ? `/${t.state},${t.loops},${t.parked ? "p" : ""}` : ""}`);
      if (killLog.length > 300) killLog.splice(0, 100);
      if (r === 0) t!.kill(sig);
      return r;
    },
    tgkill: (_c, a) => { a.i(); const t = cpuByTid(a.i() - 4242), sig = a.i(); if (!t) return fail(_c, E.SRCH); t.kill(sig); return 0; },
    raise: (cpu, a) => { const sig = a.i(); if (!sigHandlers.has(sig) && (sig === 6 || sig === 11 || sig === 9)) cpu.fault(`raise(${sig})`); cpu.kill(sig); return 0; },
    kill: (cpu, a) => { a.i(); const sig = a.i(); if (!sigHandlers.has(sig) && (sig === 6 || sig === 11 || sig === 9)) cpu.fault(`kill(${sig})`); cpu.kill(sig); return 0; },
    sigprocmask: (cpu, a) => { const e = cpu.sigmask(a.i(), a.p(), a.p(), PTR); return e ? fail(cpu, e) : 0; },
    sigprocmask64: (cpu, a) => { const e = cpu.sigmask(a.i(), a.p(), a.p(), 8); return e ? fail(cpu, e) : 0; },
    sigsuspend: (cpu, a) => { const mask = cpu.signalMask; cpu.sigmask(2, a.p(), 0, PTR); return new Promise<number>((r) => { cpu.sigWait = () => { cpu.signalMask = mask; cpu.pump(); r(fail(cpu, E.INTR)); }; }); },
    sigwait: () => new Promise<never>(() => {}),
    sigaltstack: () => 0, sigpending: (cpu, a) => { const mask = cpu.signals.reduce((v, sig) => v | 1n << BigInt(sig - 1), 0n); const p = a.p(); if (PTR === 8) mem.st64(p, mask); else mem.st32(p, Number(mask & 0xffffffffn)); return 0; },
    pthread_sigqueue: () => 0, killpg: () => 0,
    openlog: () => {}, closelog: () => {},
    syslog: (_c, a) => { const prio = a.i(), f = a.str(); logLine(prio <= 3 ? 6 : prio <= 5 ? 5 : 4, "syslog", format(f, a)); },
    vsyslog: (_c, a) => { const prio = a.i(), f = a.str(); logLine(prio <= 3 ? 6 : prio <= 5 ? 5 : 4, "syslog", format(f, vaList(a.p()))); },
    __system_property_read: (_c, a) => { a.p(); const name = a.p(), value = a.p(); if (name) mem.st8(name, 0); if (value) mem.st8(value, 0); return 0; },
    __system_property_set: () => 0,
    android_set_abort_message: (_c, a) => { abortMessage = a.str(); },
    __assert2: (cpu, a) => { const file = a.str(), line = a.i(), fn = a.str(), msg = a.str(); cpu.fault(`assertion "${msg}" failed: ${file}:${line} ${fn}`); },
    __assert: (cpu, a) => { const file = a.str(), line = a.i(), msg = a.str(); cpu.fault(`assertion "${msg}" failed: ${file}:${line}`); },
    __register_atfork: () => 0,
    __cxa_thread_atexit_impl: () => 0,
    __gnu_strerror_r: (_c, a) => { const e = a.i(), b = a.p(), n = a.u(); mem.putCstr(b, `error ${e}`, n); return ptr(b); },
    __cmsg_nxthdr: () => 0,
    recvmsg: (cpu) => fail(cpu, E.NETUNREACH), sendmsg: (cpu) => fail(cpu, E.NETUNREACH),
    if_nametoindex: () => 0, if_indextoname: () => 0,
    // sorting and searching call back into the guest for every comparison
    qsort: async (cpu, a) => {
      const vbase = a.va(), n = a.u(), size = a.u(), cmp = a.p();
      if (n < 2) return;
      const idx = [...Array(n).keys()];
      const key = (i: number) => vbase + BigInt(i * size);
      // merge sort: O(n log n) guest calls, stable
      const merge = async (lo: number, hi: number): Promise<void> => {
        if (hi - lo < 2) return;
        const mid = (lo + hi) >> 1;
        await merge(lo, mid); await merge(mid, hi);
        const out: number[] = [];
        let i = lo, j = mid;
        while (i < mid && j < hi) { if (((await cpu.call(cmp, [key(idx[i]), key(idx[j])])) | 0) <= 0) out.push(idx[i++]); else out.push(idx[j++]); }
        while (i < mid) out.push(idx[i++]);
        while (j < hi) out.push(idx[j++]);
        for (let k = 0; k < out.length; k++) idx[lo + k] = out[k];
      };
      await merge(0, n);
      const base = mem.txVa(vbase);
      const copy = mem.u8.slice(base, base + n * size);
      for (let i = 0; i < n; i++) mem.u8.set(copy.subarray(idx[i] * size, (idx[i] + 1) * size), base + i * size);
    },
    bsearch: async (cpu, a) => {
      const keyp = a.va(), base = a.va(), n = a.u(), size = a.u(), cmp = a.p();
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1, p = base + BigInt(mid * size);
        const r = (await cpu.call(cmp, [keyp, p])) | 0;
        if (r === 0) return p;
        if (r < 0) hi = mid; else lo = mid + 1;
      }
      return 0;
    },
    strlcpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const l = mem.strlen(s); if (n) { const k = Math.min(l, n - 1); mem.memmove(d, s, k); u8[d + k] = 0; } return l; },
    strlcat: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const dl = Math.min(mem.strlen(d), n), l = mem.strlen(s); if (dl < n) { const k = Math.min(l, n - dl - 1); mem.memmove(d + dl, s, k); u8[d + dl + k] = 0; } return dl + l; },
    basename: (_c, a) => { const p = a.p(); const s = mem.cstr(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return mem.hostStr(s === "" ? "/" : s.slice(i + 1)); },
    dirname: (_c, a) => { const s = mem.cstr(a.p()).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return mem.hostStr(i < 0 ? "." : i === 0 ? "/" : s.slice(0, i)); },
    fnmatch: (_c, a) => {
      const pat = a.str(), str = a.str();
      const re = "^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
      return new RegExp(re).test(str) ? 0 : 1;
    },
    asctime_r: (_c, a) => { const tm = a.p(), buf = a.p(); mem.putCstr(buf, asctime(tm), 26); return ptr(buf); },
    asctime: (_c, a) => mem.hostStr(asctime(a.p())),
    ctime_r: (_c, a) => { const t = mem.ld32(a.p()), buf = a.p(); mem.putCstr(buf, new Date(t * 1000).toString().slice(0, 24) + "\n", 26); return ptr(buf); },
    // fortified wrappers: the object size is checked, then the plain function's work is done
    __memcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; },
    __memmove_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; },
    __memset_chk: (cpu, a) => { const d = a.p(), v = a.i(), n = a.u(); chk(n, a.u(), cpu); mem.memset(d, v, n); return ARG0; },
    __strcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s) + 1; chk(n, a.u(), cpu); mem.memmove(d, s, n); return ARG0; },
    __stpcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s) + 1; chk(n, a.u(), cpu); mem.memmove(d, s, n); return ptr(d + n - 1); },
    __strncpy_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); strncpy(d, s, n); return ARG0; },
    __strncpy_chk2: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); a.u(); strncpy(d, s, n); return ARG0; },
    __strcat_chk: (cpu, a) => { const d = a.p(), s = a.p(); const dl = mem.strlen(d), n = mem.strlen(s) + 1; chk(dl + n, a.u(), cpu); mem.memmove(d + dl, s, n); return ARG0; },
    __strncat_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); const dl = mem.strlen(d); let i = 0; for (; i < n && u8[s + i]; i++) u8[d + dl + i] = u8[s + i]; u8[d + dl + i] = 0; chk(dl + i + 1, a.u(), cpu); return ARG0; },
    __strlen_chk: (cpu, a) => { const s = a.p(); const n = mem.strlen(s); chk(n + 1, a.u(), cpu); return n; },
    __vsnprintf_chk: (cpu, a) => { const d = a.p(), n = a.u(); a.i(); chk(n, a.u(), cpu); const f = a.str(); return snprintfInto(d, n, format(f, vaList(a.p()))); },
    __snprintf_chk: (cpu, a) => { const d = a.p(), n = a.u(); a.i(); chk(n, a.u(), cpu); const f = a.str(); return snprintfInto(d, n, format(f, a)); },
    __vsprintf_chk: (_c, a) => { const d = a.p(); a.i(); a.u(); const f = a.str(); return mem.putCstr(d, format(f, vaList(a.p()))); },
    __sprintf_chk: (_c, a) => { const d = a.p(); a.i(); a.u(); const f = a.str(); return mem.putCstr(d, format(f, a)); },
    __umask_chk: () => 0o22,
    __FD_SET_chk: (_c, a) => { const fd = a.i(), set = a.p(); u8[set + (fd >> 3)] |= 1 << (fd & 7); },
    __FD_CLR_chk: (_c, a) => { const fd = a.i(), set = a.p(); u8[set + (fd >> 3)] &= ~(1 << (fd & 7)); },
    __FD_ISSET_chk: (_c, a) => { const fd = a.i(), set = a.p(); return (u8[set + (fd >> 3)] >> (fd & 7)) & 1; },
  };
  for (const n of ["fork", "vfork", "execl", "execlp", "execv", "execve", "execvp", "waitpid", "wait"]) M[n] = (cpu) => fail(cpu, E.NOSYS);
  for (const suffix of ["", "64"]) {
    M["sigemptyset" + suffix] = (_c, a) => { mem.memset(a.p(), 0, suffix ? 8 : PTR); return 0; };
    M["sigfillset" + suffix] = (_c, a) => { mem.memset(a.p(), 255, suffix ? 8 : PTR); return 0; };
    for (const op of ["add", "del", "ismember"]) M[(op === "ismember" ? "sigismember" : "sig" + op + "set") + suffix] = (cpu, a) => {
      const p = a.p(), n = a.i() - 1;
      if (n < 0 || n >= (suffix ? 8 : PTR) * 8) return fail(cpu, E.INVAL);
      const at = p + (n >> 3), bit = 1 << (n & 7);
      if (op === "ismember") return mem.u8[at] & bit ? 1 : 0;
      if (op === "add") mem.u8[at] |= bit; else mem.u8[at] &= ~bit;
      return 0;
    };
  }
  hostLib("libc.so", M);
}
function asctime(tm: number): string {
  const [sec, min, hour, mday, mon, year, wday] = readTm(tm);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[wday]?.slice(0, 3) ?? "???"} ${MONTHS[mon]?.slice(0, 3) ?? "???"} ${String(mday).padStart(2, " ")} ${p2(hour)}:${p2(min)}:${p2(sec)} ${year + 1900}\n`;
}
