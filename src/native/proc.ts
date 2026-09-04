// The process-facing rest of Bionic: sysinfo and scheduling, users, signals, syslog, the abort
// message and asserts, fortified wrappers, qsort/bsearch (which call the guest's comparator),
// and the calls a sandboxed app process cannot make (fork, exec, ptrace), which fail as they
// would on a device.

import { mem } from "./mem";
import { hostLib, hostData, type HostFn, PTR, stp, vaList } from "./host";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { fail, utf8, logLine } from "./libc";
import { format } from "./printf";
import { device } from "../shell/config";

let abortMessage = "";
export function abortMessageOr(what: string): string { return abortMessage ? `${what}: ${abortMessage}` : what; }

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
    sched_setaffinity: () => 0,
    __sched_cpucount: (_c, a) => { const n = a.u(), set = a.p(); let k = 0; for (let i = 0; i < n; i++) { let b = u8[set + i]; while (b) { k += b & 1; b >>= 1; } } return k; },
    sched_get_priority_max: () => 99, sched_get_priority_min: () => 1,
    sched_getscheduler: () => 0, sched_setscheduler: () => 0, sched_getparam: (_c, a) => { a.i(); mem.st32(a.p(), 0); return 0; },
    getpwuid: () => pw,
    getpwuid_r: (_c, a) => { a.i(); const out = a.p(); a.p(); a.p(); const res = a.p(); mem.memcpy(out, pw, 8 * PTR); stp(res, out); return 0; },
    getpwnam: () => pw,
    setuid: () => 0, setgid: () => 0, seteuid: () => 0, setegid: () => 0, setgroups: () => 0, initgroups: () => 0, setsid: () => 4242,
    fork: (cpu) => fail(cpu, E.NOSYS), vfork: (cpu) => fail(cpu, E.NOSYS),
    execl: (cpu) => fail(cpu, E.NOSYS), execlp: (cpu) => fail(cpu, E.NOSYS), execv: (cpu) => fail(cpu, E.NOSYS), execve: (cpu) => fail(cpu, E.NOSYS), execvp: (cpu) => fail(cpu, E.NOSYS),
    waitpid: (cpu) => fail(cpu, E.NOSYS), wait: (cpu) => fail(cpu, E.NOSYS),
    ptrace: (cpu) => fail(cpu, E.PERM),
    // signals: a set is a 64-bit mask; no signal is ever delivered, so waiting for one parks the thread
    sigfillset: (_c, a) => { const s = a.p(); mem.st32(s, -1); mem.st32(s + 4, -1); return 0; },
    sigdelset: (_c, a) => { const s = a.p(), n = a.i() - 1; if (n >= 0 && n < 64) u8[s + (n >> 3)] &= ~(1 << (n & 7)); return 0; },
    sigismember: (_c, a) => { const s = a.p(), n = a.i() - 1; return n >= 0 && n < 64 && (u8[s + (n >> 3)] >> (n & 7)) & 1 ? 1 : 0; },
    sigsuspend: () => new Promise<never>(() => {}),
    sigwait: () => new Promise<never>(() => {}),
    sigaltstack: () => 0, sigpending: (_c, a) => { const s = a.p(); mem.st32(s, 0); mem.st32(s + 4, 0); return 0; },
    pthread_sigqueue: () => 0, tgkill: () => 0, killpg: () => 0,
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
    __gnu_strerror_r: (_c, a) => { const e = a.i(), b = a.p(), n = a.u(); mem.putCstr(b, `error ${e}`, n); return b; },
    __cmsg_nxthdr: () => 0,
    getnameinfo: () => -4,   // EAI_FAIL
    recvmsg: (cpu) => fail(cpu, E.NETUNREACH), sendmsg: (cpu) => fail(cpu, E.NETUNREACH),
    if_nametoindex: () => 0, if_indextoname: () => 0,
    // sorting and searching call back into the guest for every comparison
    qsort: async (cpu, a) => {
      const base = a.p(), n = a.u(), size = a.u(), cmp = a.p();
      if (n < 2) return;
      const idx = [...Array(n).keys()];
      const key = (i: number) => base + i * size;
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
      const copy = mem.u8.slice(base, base + n * size);
      for (let i = 0; i < n; i++) mem.u8.set(copy.subarray(idx[i] * size, (idx[i] + 1) * size), base + i * size);
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
    strlcpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const l = mem.strlen(s); if (n) { const k = Math.min(l, n - 1); mem.memmove(d, s, k); u8[d + k] = 0; } return l; },
    strlcat: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const dl = Math.min(mem.strlen(d), n), l = mem.strlen(s); if (dl < n) { const k = Math.min(l, n - dl - 1); mem.memmove(d + dl, s, k); u8[d + dl + k] = 0; } return dl + l; },
    basename: (_c, a) => { const p = a.p(); const s = mem.cstr(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return mem.hostStr(s === "" ? "/" : s.slice(i + 1)); },
    dirname: (_c, a) => { const s = mem.cstr(a.p()).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return mem.hostStr(i < 0 ? "." : i === 0 ? "/" : s.slice(0, i)); },
    fnmatch: (_c, a) => {
      const pat = a.str(), str = a.str();
      const re = "^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
      return new RegExp(re).test(str) ? 0 : 1;
    },
    asctime_r: (_c, a) => { const tm = a.p(), buf = a.p(); mem.putCstr(buf, asctime(tm), 26); return buf; },
    asctime: (_c, a) => mem.hostStr(asctime(a.p())),
    ctime_r: (_c, a) => { const t = mem.ld32(a.p()), buf = a.p(); mem.putCstr(buf, new Date(t * 1000).toString().slice(0, 24) + "\n", 26); return buf; },
    // fortified wrappers: the object size is checked, then the plain function's work is done
    __memcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memcpy(d, s, n); return d; },
    __memmove_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); mem.memmove(d, s, n); return d; },
    __memset_chk: (cpu, a) => { const d = a.p(), v = a.i(), n = a.u(); chk(n, a.u(), cpu); mem.memset(d, v, n); return d; },
    __strcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s) + 1; chk(n, a.u(), cpu); mem.memmove(d, s, n); return d; },
    __stpcpy_chk: (cpu, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s) + 1; chk(n, a.u(), cpu); mem.memmove(d, s, n); return d + n - 1; },
    __strncpy_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); strncpy(d, s, n); return d; },
    __strncpy_chk2: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); chk(n, a.u(), cpu); a.u(); strncpy(d, s, n); return d; },
    __strcat_chk: (cpu, a) => { const d = a.p(), s = a.p(); const dl = mem.strlen(d), n = mem.strlen(s) + 1; chk(dl + n, a.u(), cpu); mem.memmove(d + dl, s, n); return d; },
    __strncat_chk: (cpu, a) => { const d = a.p(), s = a.p(), n = a.u(); const dl = mem.strlen(d); let i = 0; for (; i < n && u8[s + i]; i++) u8[d + dl + i] = u8[s + i]; u8[d + dl + i] = 0; chk(dl + i + 1, a.u(), cpu); return d; },
    __strlen_chk: (cpu, a) => { const s = a.p(); const n = mem.strlen(s); chk(n + 1, a.u(), cpu); return n; },
    __strchr_chk: (_c, a) => { const p = a.p(), c = a.i() & 255; for (let i = p; ; i++) { if (u8[i] === c) return i; if (!u8[i]) return 0; } },
    __strrchr_chk: (_c, a) => { const p = a.p(), c = a.i() & 255; let r = 0; for (let i = p; ; i++) { if (u8[i] === c) r = i; if (!u8[i]) return r; } },
    __vsnprintf_chk: (cpu, a) => { const d = a.p(), n = a.u(); a.i(); chk(n, a.u(), cpu); const f = a.str(); return snprintfInto(d, n, format(f, vaList(a.p()))); },
    __snprintf_chk: (cpu, a) => { const d = a.p(), n = a.u(); a.i(); chk(n, a.u(), cpu); const f = a.str(); return snprintfInto(d, n, format(f, a)); },
    __vsprintf_chk: (_c, a) => { const d = a.p(); a.i(); a.u(); const f = a.str(); return mem.putCstr(d, format(f, vaList(a.p()))); },
    __sprintf_chk: (_c, a) => { const d = a.p(); a.i(); a.u(); const f = a.str(); return mem.putCstr(d, format(f, a)); },
    __umask_chk: () => 0o22,
    __FD_SET_chk: (_c, a) => { const fd = a.i(), set = a.p(); u8[set + (fd >> 3)] |= 1 << (fd & 7); },
    __FD_CLR_chk: (_c, a) => { const fd = a.i(), set = a.p(); u8[set + (fd >> 3)] &= ~(1 << (fd & 7)); },
    __FD_ISSET_chk: (_c, a) => { const fd = a.i(), set = a.p(); return (u8[set + (fd >> 3)] >> (fd & 7)) & 1; },
  };
  hostLib("libc.so", M);
}
function strncpy(d: number, s: number, n: number): void {
  let i = 0;
  for (; i < n && mem.u8[s + i]; i++) mem.u8[d + i] = mem.u8[s + i];
  for (; i < n; i++) mem.u8[d + i] = 0;
}
function snprintfInto(d: number, n: number, s: string): number {
  const b = utf8(s);
  if (n > 0) { const k = Math.min(b.length, n - 1); mem.u8.set(b.subarray(0, k), d); mem.u8[d + k] = 0; }
  return b.length;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function asctime(tm: number): string {
  const f: number[] = []; for (let i = 0; i < 9; i++) f.push(mem.ld32(tm + i * 4));
  const [sec, min, hour, mday, mon, year, wday] = f;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[wday] ?? "???"} ${MONTHS[mon] ?? "???"} ${String(mday).padStart(2, " ")} ${p2(hour)}:${p2(min)}:${p2(sec)} ${year + 1900}\n`;
}
