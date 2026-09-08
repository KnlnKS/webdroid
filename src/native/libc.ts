// bionic libc surface: strings, memory, time, ctype, math, process stubs, sockets that fail
// honestly. Struct layouts live in LAYOUT, chosen by the process ABI. stdio is in stdio.ts,
// printf/scanf in printf.ts.

import { mem, NativeFault } from "./mem";
import { hostLib, hostData, NORET, ARG0, ptr, vaList, type HostFn, retF, retD, PTR, stp, ldp, calledMissing } from "./host";
import { E } from "./abi";
import { invalidateRange, markProcessExited, type Cpu } from "./cpu";
import { backtrace } from "./dl";
import { format, scan } from "./printf";
import { stdioInit, readInto } from "./stdio";
import { pthreadInit, futex } from "./pthread";
import { zlibInit } from "./zlib";
import { libmInit } from "./libm";
import { localeInit } from "./locale";
import { procInit, abortMessageOr } from "./proc";
import { netInit } from "./net";
import { MONTHS, DAYS } from "../jvm/natives/jtime";
import { device } from "../shell/config";

/** bionic struct offsets/sizes, one block per ABI; LAYOUT is the process's, chosen in libcInit. */
const LAYOUT32 = {
  FILE_SIZE: 84, F_P: 0, F_R: 4, F_W: 8, F_FLAGS: 12, F_FILE: 14, F_BF_BASE: 16, F_BF_SIZE: 20, F_LBFSIZE: 24, F_COOKIE: 28,
  STAT_SIZE: 104, ST_INO32: 12, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 80, ST_CTIME: 88, ST_INO: 96,
  DIRENT_SIZE: 276, D_INO: 0, D_OFF: 8, D_RECLEN: 16, D_TYPE: 18, D_NAME: 19,
  TM_SIZE: 44, TM_GMTOFF: 36, TM_ZONE: 40, TS_SEC: 0, TS_NSEC: 4, TS_SIZE: 8, UTSNAME_FIELD: 65, JMPBUF_SIZE: 256,
  SIGACTION_SIZE: 16, SA_HANDLER: 0, SA_FLAGS: 8, STATFS_SIZE: 88,
};
const LAYOUT64: typeof LAYOUT32 = {
  FILE_SIZE: 152, F_P: 0, F_R: 8, F_W: 12, F_FLAGS: 16, F_FILE: 18, F_BF_BASE: 24, F_BF_SIZE: 32, F_LBFSIZE: 40, F_COOKIE: 48,
  STAT_SIZE: 128, ST_INO32: 8, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 88, ST_CTIME: 104, ST_INO: 8,
  DIRENT_SIZE: 280, D_INO: 0, D_OFF: 8, D_RECLEN: 16, D_TYPE: 18, D_NAME: 19,
  TM_SIZE: 56, TM_GMTOFF: 40, TM_ZONE: 48, TS_SEC: 0, TS_NSEC: 8, TS_SIZE: 16, UTSNAME_FIELD: 65, JMPBUF_SIZE: 256,
  SIGACTION_SIZE: 32, SA_HANDLER: 8, SA_FLAGS: 0, STATFS_SIZE: 120,
};
export let LAYOUT = LAYOUT32;
export const clockTime = (id: number): number => id === 0 ? Date.now() : performance.now() + 1000;
/** a struct timespec / timeval as milliseconds, and back (the second field is nanoseconds or microseconds) */
export function readTs(p: number, unit = 1e6): number { return mem.ld32(p + LAYOUT.TS_SEC) * 1000 + mem.ld32(p + LAYOUT.TS_NSEC) / unit; }
export function writeTs(p: number, ms: number, unit = 1e6): void {
  stp(p + LAYOUT.TS_SEC, Math.floor(ms / 1000));
  stp(p + LAYOUT.TS_NSEC, Math.floor((ms % 1000) * unit));
}
/** an off_t argument: 64-bit on LP64, 32-bit on ILP32 */
export const offArg = (a: { i(): number; l(): bigint }) => (PTR === 8 ? Number(a.l()) : a.i());

function setErrno(cpu: Cpu, e: number): void { mem.st32(cpu.errnoAddr, e); }
/** the common "-1 and errno" return */
export function fail(cpu: Cpu, e: number): number { setErrno(cpu, e); return -1; }

const enc = new TextEncoder();
export const utf8 = (s: string) => enc.encode(s);

// ── ctype: BSD _ctype_ table (index c+1), the bit values bionic's <ctype.h> macros test
const _U = 0x01, _L = 0x02, _N = 0x04, _S = 0x08, _P = 0x10, _C = 0x20, _X = 0x40, _B = 0x80;
function ctypeBits(c: number): number {
  let b = 0;
  if (c >= 65 && c <= 90) b |= _U; if (c >= 97 && c <= 122) b |= _L; if (c >= 48 && c <= 57) b |= _N;
  if (c === 32) b |= _S | _B; if (c >= 9 && c <= 13) b |= _S;
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) b |= _P;
  if (c < 32 || c === 127) b |= _C;
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) b |= _X;
  return b;
}
const isspace = (c: number) => c === 32 || (c >= 9 && c <= 13);
const isdigit = (c: number) => c >= 48 && c <= 57;

// ── strtol family over guest memory
function strtoNum(cpu: Cpu, s: number, endp: number, base: number, bits: 32 | 64, unsigned: boolean): bigint {
  let p = s;
  while (isspace(mem.u8[p])) p++;
  let neg = false;
  if (mem.u8[p] === 43 || mem.u8[p] === 45) { neg = mem.u8[p] === 45; p++; }
  if ((base === 0 || base === 16) && mem.u8[p] === 48 && (mem.u8[p + 1] | 32) === 120) { base = 16; p += 2; }
  else if (base === 0) base = mem.u8[p] === 48 ? 8 : 10;
  let v = 0n, any = false;
  for (;;) {
    const c = mem.u8[p];
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48; else if ((c | 32) >= 97 && (c | 32) <= 122) d = (c | 32) - 87; else break;
    if (d >= base) break;
    v = v * BigInt(base) + BigInt(d); any = true; p++;
  }
  if (!any) p = s;
  if (endp) stp(endp, any ? p : s);
  if (neg) v = -v;
  const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n, min = unsigned ? 0n : -(1n << BigInt(bits - 1));
  if (v > max) { setErrno(cpu, E.RANGE); return max; }
  if (v < min) { setErrno(cpu, E.RANGE); return min; }
  return v;
}
function strtodAt(s: number, endp: number): number {
  const str = mem.cstr(s, 512);
  const m = /^\s*([+-]?(?:inf(?:inity)?|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F.]+(?:[pP][+-]?\d+)?))/i.exec(str);
  if (!m) { if (endp) stp(endp, s); return 0; }
  if (endp) stp(endp, s + utf8(m[0]).length);
  const t = m[1].toLowerCase();
  if (t.includes("inf")) return t[0] === "-" ? -Infinity : Infinity;
  if (t.includes("nan")) return NaN;
  return parseFloat(m[1]);
}

const tzOffsetMin = () => -new Date().getTimezoneOffset();
function fillTm(tm: number, d: Date, utc: boolean): void {
  const g = utc ? { s: d.getUTCSeconds(), mi: d.getUTCMinutes(), h: d.getUTCHours(), md: d.getUTCDate(), mo: d.getUTCMonth(), y: d.getUTCFullYear(), wd: d.getUTCDay() }
    : { s: d.getSeconds(), mi: d.getMinutes(), h: d.getHours(), md: d.getDate(), mo: d.getMonth(), y: d.getFullYear(), wd: d.getDay() };
  const jan1 = utc ? Date.UTC(g.y, 0, 1) : new Date(g.y, 0, 1).getTime();
  const yday = Math.floor(((utc ? Date.UTC(g.y, g.mo, g.md) : new Date(g.y, g.mo, g.md).getTime()) - jan1) / 86400000);
  const f = [g.s, g.mi, g.h, g.md, g.mo, g.y - 1900, g.wd, yday, 0];
  for (let i = 0; i < f.length; i++) mem.st32(tm + i * 4, f[i]);
  stp(tm + LAYOUT.TM_GMTOFF, utc ? 0 : tzOffsetMin() * 60);
  stp(tm + LAYOUT.TM_ZONE, tznames[utc ? 0 : 1]);
}
function readTm(tm: number): number[] { const f: number[] = []; for (let i = 0; i < 9; i++) f.push(mem.ld32(tm + i * 4)); return f; }
function strftime(fmt: string, tm: number): string {
  const [sec, min, hour, mday, mon, year, wday, yday] = readTm(tm);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const y = year + 1900;
  return fmt.replace(/%([a-zA-Z%])/g, (_, c: string) => {
    switch (c) {
      case "a": return DAYS[wday]?.slice(0, 3) ?? "?"; case "A": return DAYS[wday] ?? "?";
      case "b": case "h": return MONTHS[mon]?.slice(0, 3) ?? "?"; case "B": return MONTHS[mon] ?? "?";
      case "c": return `${DAYS[wday]?.slice(0, 3)} ${MONTHS[mon]?.slice(0, 3)} ${String(mday).padStart(2, " ")} ${p2(hour)}:${p2(min)}:${p2(sec)} ${y}`;
      case "C": return p2(Math.floor(y / 100)); case "d": return p2(mday); case "D": return `${p2(mon + 1)}/${p2(mday)}/${p2(y % 100)}`;
      case "e": return String(mday).padStart(2, " "); case "F": return `${y}-${p2(mon + 1)}-${p2(mday)}`;
      case "H": return p2(hour); case "I": return p2(hour % 12 || 12); case "j": return String(yday + 1).padStart(3, "0");
      case "m": return p2(mon + 1); case "M": return p2(min); case "n": return "\n"; case "p": return hour < 12 ? "AM" : "PM";
      case "r": return `${p2(hour % 12 || 12)}:${p2(min)}:${p2(sec)} ${hour < 12 ? "AM" : "PM"}`; case "R": return `${p2(hour)}:${p2(min)}`;
      case "S": return p2(sec); case "t": return "\t"; case "T": return `${p2(hour)}:${p2(min)}:${p2(sec)}`;
      case "u": return String(wday || 7); case "w": return String(wday); case "x": return `${p2(mon + 1)}/${p2(mday)}/${p2(y % 100)}`;
      case "X": return `${p2(hour)}:${p2(min)}:${p2(sec)}`; case "y": return p2(y % 100); case "Y": return String(y);
      case "z": { const o = tzOffsetMin(); return (o < 0 ? "-" : "+") + p2(Math.floor(Math.abs(o) / 60)) + p2(Math.abs(o) % 60); }
      case "Z": return "UTC"; case "s": return String(Math.floor(mktime(tm) / 1000)); case "%": return "%";
      default: return "%" + c;
    }
  });
}
function mktime(tm: number): number {
  const [sec, min, hour, mday, mon, year] = readTm(tm);
  return new Date(year + 1900, mon, mday, hour, min, sec).getTime();
}
let tznames: number[] = [0, 0];

// ── setjmp/longjmp: the callee-saved registers live in the guest jmp_buf itself — r4–r14 on
// ARM, x19–x30 + sp + d8–d15 on A64 (168 of the buffer's 256 bytes)
function setjmp(cpu: Cpu, buf: number): number {
  if (!cpu.a64) { for (let i = 4; i <= 14; i++) mem.st32(buf + (i - 4) * 4, cpu.r[i]); return 0; }
  for (let i = 19; i <= 31; i++) { mem.st32(buf + (i - 19) * 8, cpu.r[i]); mem.st32(buf + (i - 19) * 8 + 4, cpu.h[i]); }
  for (let k = 8; k <= 15; k++) { mem.st32(buf + 104 + (k - 8) * 8, cpu.si[4 * k]); mem.st32(buf + 108 + (k - 8) * 8, cpu.si[4 * k + 1]); }
  return 0;
}
function longjmp(cpu: Cpu, buf: number, val: number): typeof NORET {
  if (!cpu.a64) {
    for (let i = 4; i <= 14; i++) cpu.r[i] = mem.ld32(buf + (i - 4) * 4);
    cpu.r[0] = val || 1;
    cpu.setPc(cpu.r[14]);
    return NORET;
  }
  for (let i = 19; i <= 31; i++) { cpu.r[i] = mem.ld32(buf + (i - 19) * 8); cpu.h[i] = mem.ld32(buf + (i - 19) * 8 + 4); }
  for (let k = 8; k <= 15; k++) { cpu.si[4 * k] = mem.ld32(buf + 104 + (k - 8) * 8); cpu.si[4 * k + 1] = mem.ld32(buf + 108 + (k - 8) * 8); }
  cpu.r[0] = val || 1; cpu.h[0] = 0;
  cpu.setPc(cpu.r[30]);
  return NORET;
}

// ── random (lrand48 family: 48-bit LCG as in the C library)
let r48 = 0x1234abcd330en;
const A48 = 0x5deece66dn, C48 = 0xbn, M48 = (1n << 48n) - 1n;
const next48 = () => { r48 = (A48 * r48 + C48) & M48; return Number(r48 >> 17n); };

export function libcInit(): void {
  LAYOUT = PTR === 8 ? LAYOUT64 : LAYOUT32;
  // _ctype_ (257 bytes, index c+1), tzname
  const ct = mem.hostAlloc(384);
  for (let c = 0; c < 256; c++) mem.u8[ct + 1 + c] = c < 128 ? ctypeBits(c) : 0;
  hostData("libc.so", "_ctype_", ct);
  tznames = [mem.hostStr("UTC"), mem.hostStr("UTC")];
  const tzn = mem.hostAlloc(2 * PTR);
  stp(tzn, tznames[0]); stp(tzn + PTR, tznames[1]);
  hostData("libc.so", "tzname", tzn);
  hostData("libc.so", "timezone", mem.hostAlloc(8));
  hostData("libc.so", "daylight", mem.hostAlloc(4));
  const environ = mem.hostAlloc(PTR);
  hostData("libc.so", "environ", environ);
  const optErr = mem.hostAlloc(4); hostData("libc.so", "opterr", optErr);
  const upperTab = mem.hostAlloc(384), lowerTab = mem.hostAlloc(384);
  for (let c = -128; c < 256; c++) { mem.u8[upperTab + 128 + c] = c >= 97 && c <= 122 ? c - 32 : c & 255; mem.u8[lowerTab + 128 + c] = c >= 65 && c <= 90 ? c + 32 : c & 255; }
  hostData("libc.so", "_toupper_tab_", upperTab + 128); hostData("libc.so", "_tolower_tab_", lowerTab + 128);

  const strerrorBuf = mem.hostAlloc(64);
  // an Android app process's environment (init.environ.rc + the values zygote inherits)
  const ENV: Record<string, string> = {
    PATH: "/sbin:/vendor/bin:/system/sbin:/system/bin:/system/xbin", LD_LIBRARY_PATH: "/vendor/lib:/system/lib", HOME: "/data",
    ANDROID_BOOTLOGO: "1", ANDROID_ROOT: "/system", ANDROID_ASSETS: "/system/app", ANDROID_DATA: "/data", ANDROID_STORAGE: "/storage",
    EXTERNAL_STORAGE: "/sdcard", ASEC_MOUNTPOINT: "/mnt/asec", LOOP_MOUNTPOINT: "/mnt/obb", TMPDIR: "/data/local/tmp",
  };

  let envArray = 0;
  const envStrings = new Set<number>();
  const envEntries = (): number[] => {
    const entries: number[] = [];
    for (let p = ldp(environ), entry; p && (entry = ldp(p)); p += PTR) entries.push(entry);
    return entries;
  };
  const writeEnv = (entries: number[]) => {
    const p = mem.malloc((entries.length + 1) * PTR);
    entries.forEach((entry, i) => stp(p + i * PTR, entry)); stp(p + entries.length * PTR, 0);
    stp(environ, p); if (envArray) mem.free(envArray); envArray = p;
  };
  const envString = (s: string) => {
    const bytes = utf8(s), p = mem.malloc(bytes.length + 1);
    mem.u8.set(bytes, p); mem.st8(p + bytes.length, 0); envStrings.add(p); return p;
  };
  const envKey = (p: number) => mem.cstr(p).split("=", 1)[0];
  writeEnv(Object.entries(ENV).map(([k, v]) => envString(k + "=" + v)));

  const M: Record<string, HostFn> = {
    __errno: (cpu) => cpu.errnoAddr,
    __set_errno: (cpu, a) => { setErrno(cpu, a.i()); return -1; },
    abort: (cpu) => { cpu.fault(abortMessageOr("abort() called")); },
    exit: (cpu, a) => { console.warn("[native] exit(" + a.i() + ")"); markProcessExited(); cpu.finished = true; return new Promise<never>(() => {}); },
    _exit: (cpu, a) => { console.warn(`[native] _exit(${a.i()}) from ${cpu.name} lr=${(cpu.r[cpu.lrx] >>> 0).toString(16)}`); markProcessExited(); cpu.finished = true; return new Promise<never>(() => {}); },
    atexit: () => 0,
    __cxa_atexit: () => 0,
    __cxa_finalize: () => 0,
    __cxa_pure_virtual: (cpu) => cpu.fault("pure virtual call"),
    __stack_chk_fail: (cpu) => cpu.fault("stack smashing detected"),
    getpid: () => 4242,
    gettid: (cpu) => 4242 + cpu.tid,
    getuid: () => 10123, geteuid: () => 10123, getgid: () => 10123, getegid: () => 10123,
    getppid: () => 1,
    bsd_signal: () => 0,
    nice: () => 0, setpriority: () => 0, getpriority: () => 0,
    sched_yield: () => 0,
    // Bionic's numbering: _SC_PAGESIZE/_SC_PAGE_SIZE 0x27/0x28, _SC_NPROCESSORS_CONF/ONLN 0x60/0x61, _SC_PHYS_PAGES 0x62
    sysconf: (_c, a) => { const n = a.i(); return n === 0x27 || n === 0x28 ? 4096 : n === 0x60 || n === 0x61 ? device.cpu.cores : n === 0x62 ? 65536 : -1; },
    getpagesize: () => 4096,
    // AT_HWCAP and friends: this CPU advertises no optional feature bits, which is true and is
    // also what steers a library away from the paths the emitter has not written.
    getauxval: (_c, a) => { const t = a.i(); return t === 6 ? 4096 : 0; },   // AT_PAGESZ, else none
    // an unset system property: zero length written, zero returned, as bionic does
    __system_property_get: (_c, a) => { a.p(); mem.st8(a.p(), 0); return 0; },
    __system_property_find: () => 0,
    uname: (_c, a) => {
      const p = a.p();
      const f = ["Linux", "localhost", "3.10.0", "#1 SMP PREEMPT", PTR === 8 ? "aarch64" : "armv7l", "localdomain"];
      for (let i = 0; i < f.length; i++) mem.putCstr(p + i * LAYOUT.UTSNAME_FIELD, f[i], LAYOUT.UTSNAME_FIELD);
      return 0;
    },
    getenv: (_c, a) => { const k = a.str(), p = envEntries().find((p) => envKey(p) === k); return p ? p + utf8(k).length + 1 : 0; },
    setenv: (cpu, a) => {
      const k = a.str(), v = a.str(), overwrite = a.i();
      if (!k || k.includes("=")) return fail(cpu, E.INVAL);
      const entries = envEntries(), i = entries.findIndex((p) => envKey(p) === k);
      if (i >= 0 && !overwrite) return 0;
      const p = envString(k + "=" + v);
      if (i < 0) entries.push(p); else { if (envStrings.delete(entries[i])) mem.free(entries[i]); entries[i] = p; }
      writeEnv(entries); return 0;
    },
    unsetenv: (cpu, a) => {
      const k = a.str(); if (!k || k.includes("=")) return fail(cpu, E.INVAL);
      writeEnv(envEntries().filter((p) => { if (envKey(p) !== k) return true; if (envStrings.delete(p)) mem.free(p); return false; }));
      return 0;
    },
    setlocale: (_c, a) => { a.i(); const l = a.p(); return l && mem.cstr(l) !== "" && mem.cstr(l) !== "C" && mem.cstr(l) !== "POSIX" ? 0 : cLocale; },
    localeconv: () => localeConv,
    // a protection change moves no byte: a block stays valid until a write or a cache flush says otherwise
    mprotect: (cpu, a) => {
      const va = a.va(), n = Number(a.va()), prot = a.i();
      if (prot & 3) return mem.commitVa(va, n) ? 0 : fail(cpu, E.NOMEM);
      mem.decommitVa(va, n);
      return 0;
    },
    // File mappings are private copies; shared writable mappings cannot persist guest stores.
    mmap: (cpu, a) => {
      const hint = a.va(), n = Number(a.va()), prot = a.i(), flags = a.i(), fd = a.i(), off = offArg(a);
      const failed = (e: number) => { fail(cpu, e); return PTR === 8 ? -1n : -1; };
      if (!Number.isSafeInteger(n) || n <= 0 || (flags & 0x10 && (hint & 4095n))) return failed(E.INVAL);
      if (fd !== -1 && !(flags & 0x20) && (flags & 0x1) && (prot & 2)) return failed(E.NOSYS);
      const reserve = (flags & 0x20) !== 0 && prot === 0;
      const p = flags & 0x10 ? hint : mem.mapVa(n, reserve);
      if (!p || (flags & 0x10 && !(reserve ? mem.reserveVa(hint, n) : mem.commitVa(hint, n)))) return failed(E.NOMEM);
      if (flags & 0x10 && !reserve) { invalidateRange(mem.txVa(hint), n); mem.dropVa(hint, n); }
      if (fd !== -1 && !(flags & 0x20)) { const r = readInto(cpu, fd, off, typeof p === "bigint" ? mem.txVa(p) : p, n); return r instanceof Promise ? r.then(() => p) : p; }
      return p;
    },
    mmap64: (cpu, a) => M.mmap(cpu, a),
    munmap: (cpu, a) => (mem.unmapVa(a.va(), Number(a.va())) ? 0 : fail(cpu, E.INVAL)),
    mremap: (cpu) => { fail(cpu, E.NOSYS); return PTR === 8 ? -1n : -1; },
    madvise: (_c, a) => { const va = a.va(), n = Number(a.va()); if (a.i() === 4) mem.dropVa(va, n); return 0; },   // MADV_DONTNEED
    msync: () => 0, mlock: () => 0, munlock: () => 0,
    getrlimit: (_c, a) => { a.i(); const r = a.p(); stp(r, 0x100000); stp(r + PTR, 0x100000); return 0; },
    setrlimit: () => 0,
    // the raw syscalls a runtime issues past libc: futex is the one that must block
    syscall: (cpu, a) => {
      const nr = a.i();
      if (nr === (PTR === 8 ? 98 : 240)) { const addr = a.p(), op = a.i(), val = a.i(), ts = a.p(); a.p(); return futex(cpu, addr, op, val, ts, a.i()); }
      if (nr === (PTR === 8 ? 135 : 175)) { const how = a.i(), set = a.p(), old = a.p(), size = a.u(); const e = size === 8 ? cpu.sigmask(how, set, old, 8) : E.INVAL; return e ? fail(cpu, e) : 0; }
      if (nr === (PTR === 8 ? 178 : 224)) return 4242 + cpu.tid;              // gettid
      if (nr === (PTR === 8 ? 278 : 384)) { const buf = a.p(), n = a.u(); crypto.getRandomValues(mem.bytes(buf, n)); return n; } // getrandom
      if (nr === (PTR === 8 ? 122 : 241)) return 0;                             // sched_setaffinity: one core, nothing to pin
      calledMissing.add("syscall " + nr);
      return fail(cpu, E.NOSYS);
    },
    // PR_SET_NAME names the calling thread: what wd.native.regs shows and what a trace prefixes
    prctl: (cpu, a) => { const op = a.i(); if (op === 15) { const s = mem.cstr(a.p(), 16); if (s) { cpu.name = s; cpu.jthread.jname = s; } } return 0; },
    cacheflush: (_c, a) => { const s = a.p(), e = a.p(); invalidateRange(s, e - s, "cacheflush"); return 0; },
    __aeabi_read_tp: (cpu) => cpu.tlsBase,

    malloc: (_c, a) => mem.malloc(a.u()),
    free: (_c, a) => { mem.free(a.p()); },
    calloc: (_c, a) => mem.calloc(a.u(), a.u()),
    realloc: (_c, a) => mem.realloc(a.p(), a.u()),
    valloc: (_c, a) => mem.valloc(a.u()),
    memalign: (_c, a) => mem.memalign(a.u(), a.u()),
    posix_memalign: (_c, a) => { const out = a.p(), al = a.u(), n = a.u(); stp(out, mem.memalign(al, n)); return 0; },
    malloc_usable_size: (_c, a) => mem.usableSize(a.p()),
    memcpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); mem.memcpy(d, s, n); return ARG0; },
    memmove: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); mem.memmove(d, s, n); return ARG0; },
    memset: (_c, a) => { const d = a.p(), v = a.i(), n = a.u(); mem.memset(d, v, n); return ARG0; },
    memcmp: (_c, a) => {
      const x = a.p(), y = a.p(), n = a.u();
      for (let i = 0; i < n; i++) { const d = mem.u8[x + i] - mem.u8[y + i]; if (d) return d; }
      return 0;
    },
    memchr: (_c, a) => { const p = a.p(), c = a.i() & 255, n = a.u(); const i = mem.u8.subarray(p, p + n).indexOf(c); return i >= 0 ? ptr(p + i) : 0; },
    memrchr: (_c, a) => { const p = a.p(), c = a.i() & 255, n = a.u(); for (let i = p + n - 1; i >= p; i--) if (mem.u8[i] === c) return ptr(i); return 0; },
    bcopy: (_c, a) => { const s = a.p(), d = a.p(), n = a.u(); mem.memmove(d, s, n); },
    bzero: (_c, a) => { const d = a.p(), n = a.u(); mem.memset(d, 0, n); },

    strlen: (_c, a) => mem.strlen(a.p()),
    strnlen: (_c, a) => { const p = a.p(), n = a.u(); let i = 0; while (i < n && mem.u8[p + i]) i++; return i; },
    strcpy: (_c, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s); mem.memmove(d, s, n + 1); return ARG0; },
    strncpy: (_c, a) => {
      const d = a.p(), s = a.p(), n = a.u();
      let i = 0;
      for (; i < n && mem.u8[s + i]; i++) mem.u8[d + i] = mem.u8[s + i];
      for (; i < n; i++) mem.u8[d + i] = 0;
      return ARG0;
    },
    stpcpy: (_c, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s); mem.memmove(d, s, n + 1); return ptr(d + n); },
    strcat: (_c, a) => { const d = a.p(), s = a.p(); const dl = mem.strlen(d), n = mem.strlen(s); mem.memmove(d + dl, s, n + 1); return ARG0; },
    strncat: (_c, a) => {
      const d = a.p(), s = a.p(), n = a.u();
      const dl = mem.strlen(d);
      let i = 0;
      for (; i < n && mem.u8[s + i]; i++) mem.u8[d + dl + i] = mem.u8[s + i];
      mem.u8[d + dl + i] = 0;
      return ARG0;
    },
    strcmp: (_c, a) => strcmpAt(a.p(), a.p(), 0x7fffffff, false),
    strncmp: (_c, a) => strcmpAt(a.p(), a.p(), a.u(), false),
    strcasecmp: (_c, a) => strcmpAt(a.p(), a.p(), 0x7fffffff, true),
    strncasecmp: (_c, a) => strcmpAt(a.p(), a.p(), a.u(), true),
    strcoll: (_c, a) => strcmpAt(a.p(), a.p(), 0x7fffffff, false),
    strxfrm: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const l = mem.strlen(s); if (n) { const k = Math.min(l, n - 1); mem.memmove(d, s, k); mem.u8[d + k] = 0; } return l; },
    strchr: (_c, a) => { const p = a.p(), c = a.i() & 255; for (let i = p; ; i++) { if (mem.u8[i] === c) return ptr(i); if (!mem.u8[i]) return 0; } },
    strrchr: (_c, a) => { const p = a.p(), c = a.i() & 255; let r = 0; for (let i = p; ; i++) { if (mem.u8[i] === c) r = i; if (!mem.u8[i]) return ptr(r); } },
    strstr: (_c, a) => {
      const h = a.p(), n = a.p();
      const hs = mem.cstr(h), ns = mem.cstr(n);
      const i = hs.indexOf(ns);
      return i < 0 ? 0 : ptr(h + utf8(hs.slice(0, i)).length);
    },
    strcasestr: (_c, a) => { const h = a.p(), n = a.p(); const hs = mem.cstr(h).toLowerCase(), ns = mem.cstr(n).toLowerCase(); const i = hs.indexOf(ns); return i < 0 ? 0 : ptr(h + utf8(hs.slice(0, i)).length); },
    strpbrk: (_c, a) => { const p = a.p(), set = mem.cstr(a.p()); for (let i = p; mem.u8[i]; i++) if (set.includes(String.fromCharCode(mem.u8[i]))) return ptr(i); return 0; },
    strspn: (_c, a) => { const p = a.p(), set = mem.cstr(a.p()); let i = 0; while (mem.u8[p + i] && set.includes(String.fromCharCode(mem.u8[p + i]))) i++; return i; },
    strcspn: (_c, a) => { const p = a.p(), set = mem.cstr(a.p()); let i = 0; while (mem.u8[p + i] && !set.includes(String.fromCharCode(mem.u8[p + i]))) i++; return i; },
    strdup: (_c, a) => { const s = a.p(); const n = mem.strlen(s); const d = mem.malloc(n + 1); mem.memcpy(d, s, n + 1); return d; },
    strndup: (_c, a) => { const s = a.p(), n = a.u(); let l = 0; while (l < n && mem.u8[s + l]) l++; const d = mem.malloc(l + 1); mem.memcpy(d, s, l); mem.u8[d + l] = 0; return d; },
    strtok: (cpu, a) => ptr(strtok(cpu, a.p(), a.p(), 0)),
    strtok_r: (_c, a) => { const s = a.p(), d = a.p(), save = a.p(); return ptr(strtokR(s, d, save)); },
    strerror: (_c, a) => { mem.putCstr(strerrorBuf, ERRSTR[a.i()] ?? `Unknown error ${a.i()}`, 64); return strerrorBuf; },
    strerror_r: (_c, a) => { const e = a.i(), b = a.p(), n = a.u(); mem.putCstr(b, ERRSTR[e] ?? `Unknown error ${e}`, n); return 0; },
    // long is 64-bit on LP64
    strtol: (cpu, a) => (PTR === 8 ? strtoNum(cpu, a.p(), a.p(), a.i(), 64, false) : Number(strtoNum(cpu, a.p(), a.p(), a.i(), 32, false))),
    strtoul: (cpu, a) => (PTR === 8 ? strtoNum(cpu, a.p(), a.p(), a.i(), 64, true) : Number(strtoNum(cpu, a.p(), a.p(), a.i(), 32, true)) | 0),
    strtoll: (cpu, a) => strtoNum(cpu, a.p(), a.p(), a.i(), 64, false),
    strtoull: (cpu, a) => strtoNum(cpu, a.p(), a.p(), a.i(), 64, true),
    atoi: (cpu, a) => Number(strtoNum(cpu, a.p(), 0, 10, 32, false)),
    atol: (cpu, a) => (PTR === 8 ? strtoNum(cpu, a.p(), 0, 10, 64, false) : Number(strtoNum(cpu, a.p(), 0, 10, 32, false))),
    atoll: (cpu, a) => strtoNum(cpu, a.p(), 0, 10, 64, false),
    strtod: (c, a) => retD(c, strtodAt(a.p(), a.p())),
    strtof: (c, a) => retF(c, Math.fround(strtodAt(a.p(), a.p()))),
    atof: (c, a) => retD(c, strtodAt(a.p(), 0)),
    tolower: (_c, a) => { const c = a.i(); return c >= 65 && c <= 90 ? c + 32 : c; },
    toupper: (_c, a) => { const c = a.i(); return c >= 97 && c <= 122 ? c - 32 : c; },
    isupper: (_c, a) => { const c = a.i(); return c >= 65 && c <= 90 ? 1 : 0; },
    islower: (_c, a) => { const c = a.i(); return c >= 97 && c <= 122 ? 1 : 0; },
    isalpha: (_c, a) => (ctypeBits(a.i() & 255) & (_U | _L)) ? 1 : 0,
    isdigit: (_c, a) => (isdigit(a.i()) ? 1 : 0),
    isxdigit: (_c, a) => (ctypeBits(a.i() & 255) & _X) ? 1 : 0,
    isspace: (_c, a) => (isspace(a.i()) ? 1 : 0),
    isalnum: (_c, a) => (ctypeBits(a.i() & 255) & (_U | _L | _N)) ? 1 : 0,
    ispunct: (_c, a) => (ctypeBits(a.i() & 255) & _P) ? 1 : 0,
    isprint: (_c, a) => { const c = a.i(); return c >= 32 && c < 127 ? 1 : 0; },
    iscntrl: (_c, a) => (ctypeBits(a.i() & 255) & _C) ? 1 : 0,

    // ── wide chars (wchar_t is 32-bit)
    wcslen: (_c, a) => { const p = a.p(); let n = 0; while (mem.ld32(p + n * 4)) n++; return n; },
    wmemchr: (_c, a) => { const p = a.p(), c = a.i(), n = a.u(); for (let i = 0; i < n; i++) if (mem.ld32(p + i * 4) === c) return ptr(p + i * 4); return 0; },
    wmemcmp: (_c, a) => { const x = a.p(), y = a.p(), n = a.u(); for (let i = 0; i < n; i++) { const d = mem.ld32(x + i * 4) - mem.ld32(y + i * 4); if (d) return d < 0 ? -1 : 1; } return 0; },
    wmemcpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); mem.memcpy(d, s, n * 4); return ARG0; },
    wmemmove: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); mem.memmove(d, s, n * 4); return ARG0; },
    wmemset: (_c, a) => { const d = a.p(), c = a.i(), n = a.u(); for (let i = 0; i < n; i++) mem.st32(d + i * 4, c); return ARG0; },
    wcscoll: (_c, a) => { const x = wstr(a.p()), y = wstr(a.p()); return x < y ? -1 : x > y ? 1 : 0; },
    wcscmp: (_c, a) => { const x = wstr(a.p()), y = wstr(a.p()); return x < y ? -1 : x > y ? 1 : 0; },
    wcsxfrm: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const l = wlen(s); if (n) { const k = Math.min(l, n - 1); mem.memmove(d, s, k * 4); mem.st32(d + k * 4, 0); } return l; },
    wcsftime: (_c, a) => { const d = a.p(), n = a.u(), f = wstr(a.p()), tm = a.p(); const s = strftime(f, tm); if (s.length >= n) return 0; for (let i = 0; i < s.length; i++) mem.st32(d + i * 4, s.codePointAt(i)!); mem.st32(d + s.length * 4, 0); return s.length; },
    towlower: (_c, a) => { const c = a.i(); return c < 0x10000 ? String.fromCharCode(c).toLowerCase().charCodeAt(0) : c; },
    towupper: (_c, a) => { const c = a.i(); return c < 0x10000 ? String.fromCharCode(c).toUpperCase().charCodeAt(0) : c; },
    wctype: (_c, a) => WCTYPES.indexOf(a.str()) + 1,
    iswctype: (_c, a) => { const c = a.i(), t = WCTYPES[a.i() - 1]; if (!t || c > 0xffff) return 0; const s = String.fromCharCode(c); return WCTEST[t]?.test(s) ? 1 : 0; },
    iswspace: (_c, a) => (isspace(a.i()) ? 1 : 0), iswdigit: (_c, a) => (isdigit(a.i()) ? 1 : 0),
    iswalpha: (_c, a) => { const c = a.i(); return c < 0x10000 && /\p{L}/u.test(String.fromCharCode(c)) ? 1 : 0; },
    iswupper: (_c, a) => { const c = a.i(); return c < 0x10000 && /\p{Lu}/u.test(String.fromCharCode(c)) ? 1 : 0; },
    iswlower: (_c, a) => { const c = a.i(); return c < 0x10000 && /\p{Ll}/u.test(String.fromCharCode(c)) ? 1 : 0; },
    btowc: (_c, a) => { const c = a.i(); return c === -1 ? -1 : c & 255; },
    wctob: (_c, a) => { const c = a.i(); return c < 128 ? c : -1; },
    mbrtowc: (_c, a) => {
      const pwc = a.p(), s = a.p(), n = a.u();
      if (!s) return 0;
      if (n === 0) return -2;
      const b0 = mem.u8[s];
      const len = b0 < 0x80 ? 1 : b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc0 ? 2 : 1;
      if (n < len) return -2;
      const cp = new TextDecoder().decode(mem.u8.subarray(s, s + len)).codePointAt(0) ?? 0;
      if (pwc) mem.st32(pwc, cp);
      return b0 === 0 ? 0 : len;
    },
    wcrtomb: (_c, a) => { const d = a.p(), wc = a.i(); const b = utf8(String.fromCodePoint(wc >>> 0 > 0x10ffff ? 0xfffd : wc >>> 0)); if (d) mem.u8.set(b, d); return b.length; },
    mbstowcs: (_c, a) => { const d = a.p(), s = mem.cstr(a.p()), n = a.u(); const cps = [...s].map((c) => c.codePointAt(0)!); if (!d) return cps.length; const k = Math.min(cps.length, n); for (let i = 0; i < k; i++) mem.st32(d + i * 4, cps[i]); if (k < n) mem.st32(d + k * 4, 0); return k; },
    wcstombs: (_c, a) => { const d = a.p(), s = wstr(a.p()), n = a.u(); const b = utf8(s); if (!d) return b.length; const k = Math.min(b.length, n); mem.u8.set(b.subarray(0, k), d); if (k < n) mem.u8[d + k] = 0; return k; },
    mblen: (_c, a) => { const s = a.p(); if (!s) return 0; const b0 = mem.u8[s]; return b0 === 0 ? 0 : b0 < 0x80 ? 1 : b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : 2; },
    __ctype_get_mb_cur_max: () => 4,

    // ── formatting (printf family that lands in memory; the FILE ones live in stdio.ts)
    sprintf: (_c, a) => { const d = a.p(), f = a.str(); return mem.putCstr(d, format(f, a)); },
    snprintf: (_c, a) => { const d = a.p(), n = a.u(), f = a.str(); const s = format(f, a); const b = utf8(s); if (n > 0) { const k = Math.min(b.length, n - 1); mem.u8.set(b.subarray(0, k), d); mem.u8[d + k] = 0; } return b.length; },
    vsprintf: (_c, a) => { const d = a.p(), f = a.str(); return mem.putCstr(d, format(f, vaList(a.p()))); },
    vsnprintf: (_c, a) => { const d = a.p(), n = a.u(), f = a.str(); const s = format(f, vaList(a.p())); const b = utf8(s); if (n > 0) { const k = Math.min(b.length, n - 1); mem.u8.set(b.subarray(0, k), d); mem.u8[d + k] = 0; } return b.length; },
    vasprintf: (_c, a) => { const out = a.p(), f = a.str(); const s = format(f, vaList(a.p())); stp(out, mem.strdup(s)); return utf8(s).length; },
    asprintf: (_c, a) => { const out = a.p(), f = a.str(); const s = format(f, a); stp(out, mem.strdup(s)); return utf8(s).length; },
    sscanf: (_c, a) => { const s = a.str(), f = a.str(); return scanInto(s, f, a); },
    vsscanf: (_c, a) => { const s = a.str(), f = a.str(); return scanInto(s, f, vaList(a.p())); },

    time: (_c, a) => { const p = a.p(); const t = Math.floor(Date.now() / 1000); if (p) stp(p, t); return t; },
    gettimeofday: (_c, a) => { const tv = a.p(); if (tv) writeTs(tv, Date.now(), 1e3); return 0; },
    clock_gettime: (_c, a) => {
      const id = a.i(), ts = a.p();
      writeTs(ts, clockTime(id)); // MONOTONIC/BOOTTIME: never 0
      return 0;
    },
    clock_getres: (_c, a) => { a.i(); const ts = a.p(); if (ts) { stp(ts + LAYOUT.TS_SEC, 0); stp(ts + LAYOUT.TS_NSEC, 1000); } return 0; },
    clock: () => Math.floor(performance.now() * 1000),
    times: () => Math.floor(performance.now() / 10),
    localtime_r: (_c, a) => { const t = mem.ld32(a.p()), tm = a.p(); fillTm(tm, new Date(t * 1000), false); return ptr(tm); },
    gmtime_r: (_c, a) => { const t = mem.ld32(a.p()), tm = a.p(); fillTm(tm, new Date(t * 1000), true); return ptr(tm); },
    localtime: (_c, a) => { const t = mem.ld32(a.p()); fillTm(tmBuf, new Date(t * 1000), false); return tmBuf; },
    gmtime: (_c, a) => { const t = mem.ld32(a.p()); fillTm(tmBuf, new Date(t * 1000), true); return tmBuf; },
    mktime: (_c, a) => Math.floor(mktime(a.p()) / 1000),
    timegm: (_c, a) => { const [sec, min, hour, mday, mon, year] = readTm(a.p()); return Math.floor(Date.UTC(year + 1900, mon, mday, hour, min, sec) / 1000); },
    strftime: (_c, a) => { const d = a.p(), n = a.u(), f = a.str(), tm = a.p(); const s = utf8(strftime(f, tm)); if (s.length >= n) return 0; mem.u8.set(s, d); mem.u8[d + s.length] = 0; return s.length; },
    tzset: () => {},
    difftime: (c, a) => retD(c, a.i() - a.i()),

    // ── setjmp / longjmp (the buffer holds r4–r14; sigsetjmp aliases)
    setjmp: (cpu, a) => setjmp(cpu, a.p()),
    _setjmp: (cpu, a) => setjmp(cpu, a.p()),
    sigsetjmp: (cpu, a) => setjmp(cpu, a.p()),
    longjmp: (cpu, a) => longjmp(cpu, a.p(), a.i()),
    _longjmp: (cpu, a) => longjmp(cpu, a.p(), a.i()),
    siglongjmp: (cpu, a) => longjmp(cpu, a.p(), a.i()),

    lrand48: () => next48() & 0x7fffffff,
    mrand48: () => next48() | 0,
    drand48: (c) => retD(c, (next48() >>> 0) / 4294967296),
    srand48: (_c, a) => { r48 = (BigInt(a.u()) << 16n) | 0x330en; },
    rand: () => next48() & 0x7fffffff,
    random: () => next48() & 0x7fffffff,
    srand: (_c, a) => { r48 = (BigInt(a.u()) << 16n) | 0x330en; },
    srandom: (_c, a) => { r48 = (BigInt(a.u()) << 16n) | 0x330en; },
    arc4random: () => (Math.random() * 4294967296) | 0,
    arc4random_uniform: (_c, a) => Math.floor(Math.random() * a.u()) | 0,

    // Native TCP and resolver functions are registered by netInit below. These unsupported
    // server-side operations stay explicit rather than pretending that a listener exists.
    bind: (cpu) => fail(cpu, E.ACCES),
    listen: (cpu) => fail(cpu, E.NETUNREACH),
    accept: (cpu) => fail(cpu, E.NETUNREACH),
    gethostbyname: () => 0,
    gethostbyaddr: () => 0,
    gethostname: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "localhost", n); return 0; },
    inet_aton: (_c, a) => { const s = a.str(), out = a.p(); const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); if (!m) return 0; for (let i = 0; i < 4; i++) mem.u8[out + i] = +m[i + 1]; return 1; },
    inet_addr: (_c, a) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.str()); if (!m) return -1; return (+m[1]) | (+m[2] << 8) | (+m[3] << 16) | (+m[4] << 24); },
    inet_ntoa: (_c, a) => { const v = a.u(); mem.putCstr(inetBuf, `${v & 255}.${(v >>> 8) & 255}.${(v >>> 16) & 255}.${v >>> 24}`, 20); return inetBuf; },
    htons: (_c, a) => { const v = a.i() & 0xffff; return ((v & 255) << 8) | (v >>> 8); }, ntohs: (_c, a) => { const v = a.i() & 0xffff; return ((v & 255) << 8) | (v >>> 8); },
    htonl: (_c, a) => { const v = a.i(); return ((v & 255) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24); },
    ntohl: (_c, a) => { const v = a.i(); return ((v & 255) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24); },
    __android_log_write: (c, a) => { const prio = a.i(), tag = a.str(), msg = a.str(); logLine(prio, tag, msg, c); return 1; },
    __android_log_print: (c, a) => { const prio = a.i(), tag = a.str(), f = a.str(); logLine(prio, tag, format(f, a), c); return 1; },
    __android_log_vprint: (c, a) => { const prio = a.i(), tag = a.str(), f = a.str(); logLine(prio, tag, format(f, vaList(a.p())), c); return 1; },
    __android_log_assert: (cpu, a) => { a.p(); const tag = a.str(); const f = a.p(); cpu.fault(`assert ${tag}: ${f ? format(mem.cstr(f), a) : ""}`); },
  };
  // the *_l variants: the base function, with the trailing locale_t never read
  for (const n of ["strtol", "strtoul", "strtoll", "strtoull", "strtod", "strtof", "strtold", "strcoll", "strxfrm", "strftime", "wcscoll", "wcsxfrm", "wcsftime",
    "isalpha", "isdigit", "isxdigit", "isspace", "isupper", "islower", "isalnum", "ispunct", "isprint", "iscntrl", "tolower", "toupper",
    "iswspace", "iswdigit", "iswalpha", "iswupper", "iswlower", "towlower", "towupper", "mbrtowc", "wcrtomb", "localeconv", "strerror",
    "sprintf", "snprintf", "vsprintf", "vsnprintf", "asprintf", "vasprintf", "sscanf", "vsscanf", "btowc", "wctob", "wctype", "iswctype"]) if (M[n]) M[n + "_l"] = M[n];
  M.strtold = M.strtod; M.strtold_l = M.strtod;
  hostLib("libc.so", M);
  hostLib("liblog.so", { __android_log_write: M.__android_log_write, __android_log_print: M.__android_log_print, __android_log_vprint: M.__android_log_vprint, __android_log_assert: M.__android_log_assert });
  const tmBuf = mem.hostAlloc(LAYOUT.TM_SIZE);
  const inetBuf = mem.hostAlloc(20);
  const cLocale = mem.hostStr("C");
  const localeConv = mem.hostAlloc(16 * PTR);
  stp(localeConv, mem.hostStr(".")); stp(localeConv + PTR, mem.hostStr("")); stp(localeConv + 2 * PTR, mem.hostStr(""));
  stdioInit();
  pthreadInit();
  zlibInit();
  libmInit();
  localeInit();
  procInit();
  netInit();
}

const PRIO = ["", "", "V", "D", "I", "W", "E", "F", "S"];
const logTrap = (globalThis as { __wdLogTrap?: string }).__wdLogTrap ? new RegExp((globalThis as { __wdLogTrap?: string }).__wdLogTrap!) : null;
export function logLine(prio: number, tag: string, msg: string, cpu?: Cpu): void {
  const line = `${PRIO[prio] ?? prio}/${tag}: ${msg.replace(/\n$/, "")}`;
  if (prio >= 6) console.error("[logcat]", line); else if (prio === 5) console.warn("[logcat]", line); else console.log("[logcat]", line);
  // a debugging trap: which thread, under which entry, with which callers, logged a matching line
  if (logTrap && cpu && logTrap.test(msg)) console.warn(`[trap-native] ${cpu.name} ic=${cpu.ic} frames=${cpu.frames.join(">")} bt=${backtrace(cpu, 10).join(" < ")}`);
}

function strcmpAt(x: number, y: number, n: number, ci: boolean): number {
  for (let i = 0; i < n; i++) {
    let a = mem.u8[x + i], b = mem.u8[y + i];
    if (ci) { if (a >= 65 && a <= 90) a += 32; if (b >= 65 && b <= 90) b += 32; }
    if (a !== b) return a - b;
    if (a === 0) return 0;
  }
  return 0;
}
function wlen(p: number): number { let n = 0; while (mem.ld32(p + n * 4)) n++; return n; }
function wstr(p: number): string { let s = ""; for (let i = 0; ; i++) { const c = mem.ld32(p + i * 4); if (!c) return s; s += String.fromCodePoint(c >>> 0 > 0x10ffff ? 0xfffd : c >>> 0); } }
const WCTYPES = ["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"];
const WCTEST: Record<string, RegExp> = {
  alnum: /[\p{L}\p{N}]/u, alpha: /\p{L}/u, blank: /[ \t]/, cntrl: /\p{Cc}/u, digit: /\d/, graph: /[^\s\p{Cc}]/u, lower: /\p{Ll}/u,
  print: /[^\p{Cc}]/u, punct: /\p{P}/u, space: /\s/, upper: /\p{Lu}/u, xdigit: /[0-9a-fA-F]/,
};
const tokSave = new Map<number, number>();
function strtok(cpu: Cpu, s: number, delim: number, _z: number): number {
  const save = tokSave.get(cpu.tid) ?? 0;
  if (!s) s = save;
  const r = strtokAt(s, mem.cstr(delim));
  tokSave.set(cpu.tid, r.next);
  return r.tok;
}
function strtokR(s: number, delim: number, save: number): number {
  if (!s) s = ldp(save);
  const r = strtokAt(s, mem.cstr(delim));
  stp(save, r.next);
  return r.tok;
}
function strtokAt(s: number, delim: string): { tok: number; next: number } {
  if (!s) return { tok: 0, next: 0 };
  let p = s;
  while (mem.u8[p] && delim.includes(String.fromCharCode(mem.u8[p]))) p++;
  if (!mem.u8[p]) return { tok: 0, next: p };
  const tok = p;
  while (mem.u8[p] && !delim.includes(String.fromCharCode(mem.u8[p]))) p++;
  if (mem.u8[p]) { mem.u8[p] = 0; p++; }
  return { tok, next: p };
}
function scanInto(s: string, f: string, a: { p(): number }): number {
  return scan(s, f, (kind, v) => {
    const dst = a.p();
    if (!dst) return 0;
    if (kind === "i" || kind === "n") mem.st32(dst, v as number);
    else if (kind === "h") mem.st16(dst, v as number);
    else if (kind === "b") mem.st8(dst, v as number);
    else if (kind === "l") mem.st64(dst, v as bigint);
    else if (kind === "f") mem.stf32(dst, v as number);
    else if (kind === "d") mem.stf64(dst, v as number);
    else if (kind === "s") mem.putCstr(dst, v as string);
    return 0;
  });
}
const ERRSTR: Record<number, string> = {
  1: "Operation not permitted", 2: "No such file or directory", 4: "Interrupted system call", 5: "I/O error", 9: "Bad file descriptor",
  11: "Try again", 12: "Out of memory", 13: "Permission denied", 16: "Device or resource busy", 17: "File exists", 20: "Not a directory",
  21: "Is a directory", 22: "Invalid argument", 24: "Too many open files", 28: "No space left on device", 29: "Illegal seek", 34: "Numerical result out of range",
  35: "Resource deadlock would occur", 38: "Function not implemented", 39: "Directory not empty", 101: "Network is unreachable", 110: "Connection timed out",
};
export { NativeFault };
