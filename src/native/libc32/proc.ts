// The ARM32 libc's process-facing rest: scheduling and users, syslog and properties, the abort
// message and asserts, fortified wrappers, qsort/bsearch (which call the guest's comparator), and
// the calls a sandboxed app process cannot make (fork, exec, ptrace), which fail as they would on a
// device at its process limit or under its sandbox.

import { wrote, mem } from "../mem.ts";
import { hostData, type HostFn, PTR, ldp, stp, vaList, ARG0, ptr, guestSort } from "../host.ts";
import { E } from "../abi.ts";
import { setAbortMessage } from "../crash.ts";
import { fail, logLine, wrapped } from "../kernel.ts";
import { PROC_SYSCALLS, chk, getAffinity, memcpyChk } from "../proc.ts";
import { format, snprintfInto } from "./printf.ts";
import { PROP_VALUE_MAX, propertyHandle, propertyKey, propertyValue } from "../../shell/properties.ts";
import { appUserName, procIdentity } from "../../shell/procfs.ts";

const writeProperty = (out: number, text: string) => mem.putCstr(out, text, PROP_VALUE_MAX);
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
const PATH_MAX = 4096;
/** the ARM32 libc's process functions, with the data they name */
export function procLibc(): Record<string, HostFn> {
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
    // the handle is the name's string; the value lives for the callback
    __system_property_read_callback: async (cpu, a) => {
      const pi = a.p(), callback = a.p(), cookie = a.p(), value = mem.strdup(propertyValue(propertyKey(pi) ?? "") ?? "");
      try { await cpu.call(callback, [cookie, pi, value, 0]); } finally { mem.free(value); }
    },
    // only init's property service sets properties, and it refuses an app
    __system_property_set: () => -1,
    android_set_abort_message: (_c, a) => { setAbortMessage(a.str()); },
    __assert2: (cpu, a) => { const file = a.str(), line = a.i(), fn = a.str(), msg = a.str(); cpu.fault(`assertion "${msg}" failed: ${file}:${line} ${fn}`); },
    __assert: (cpu, a) => { const file = a.str(), line = a.i(), msg = a.str(); cpu.fault(`assertion "${msg}" failed: ${file}:${line}`); },
    __register_atfork: () => 0,
    __cxa_thread_atexit_impl: () => 0,
    __gnu_strerror_r: (_c, a) => { const e = a.i(), b = a.p(), n = a.u(); mem.putCstr(b, `error ${e}`, n); return ptr(b); },
    // bionic's CMSG_NXTHDR: the header after `cmsg`, or none once a whole header no longer fits msg_control
    __cmsg_nxthdr: (_c, a) => {
      const msg = a.p(), cmsg = a.p(), next = cmsg + ((ldp(cmsg) + PTR - 1) & -PTR);
      return next + PTR + 8 - ldp(msg + 4 * PTR) > ldp(msg + 5 * PTR) ? 0 : ptr(next);
    },
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
  return M;
}
