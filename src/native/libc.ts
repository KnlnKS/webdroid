// bionic libc surface: strings, memory, time, ctype, math, process stubs. An ARM32 process's
// libc (libcInit); a 64-bit process runs bionic itself (bionic.ts). LIBC_SYSCALLS are the kernel's
// memory mapping, time and identity calls, which both reach (syscall.ts). stdio is in stdio.ts,
// printf/scanf in printf.ts.

import { mem, guestAt, wrote } from "./mem.ts";
import { hostLib, hostData, NORET, ARG0, SERVED, ptr, vaList, type HostFn, retF, retD, PTR, stp, ldp, ldLong, stLong } from "./host.ts";
import { E, strerror, PAGE_SIZE } from "./abi.ts";
import { utf8 as codec } from "../jvm/abi.ts";
import { invalidateRange, nameThread, type Cpu } from "./cpu.ts";
import { exitGroup } from "./crash.ts";
import { abortThread, SIGNAL_SYSCALLS } from "./signals.ts";
import { format, scan } from "./printf.ts";
import { stdioInit } from "./stdio.ts";
import { FS_SYSCALLS, readInto, fdFile, contentAt } from "./fs.ts";
import { isRemoteFd } from "./process-fd.ts";
import { PTHREAD_SYSCALLS, pthreadInit } from "./pthread.ts";
import { KLAYOUT, syscallEntry } from "./syscall.ts";
import { zlibInit } from "./zlib.ts";
import { libmInit } from "./libm.ts";
import { localeInit } from "./locale.ts";
import { PROC_SYSCALLS, procInit } from "./proc.ts";
import { NET_SYSCALLS, netInit } from "./socket/syscalls.ts";
import { POLL_SYSCALLS } from "./poll.ts";
import { device } from "../shell/config.ts";
import { procIdentity, sysconf, uname } from "../shell/procfs.ts";
import { guestNow, wallMillis } from "../guest-clock.ts";
import { processEnv } from "../shell/environment.ts";
import { timersInit } from "./timers.ts";
import { isShared, syncShared, trackSharedMap, trackPrivateMap, fileMapAt, mapRemoteShared } from "./mappings.ts";
/** the C locale's month and weekday names (strftime, asctime) */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** the ARM32 struct tm past its nine ints */
export const TM = { gmtoff: 36, zone: 40, size: 44 };
/** each of struct utsname's fields */
const UTSNAME_FIELD = 65;
/** REALTIME, REALTIME_COARSE and REALTIME_ALARM are the wall clock (core/libc.zig matches) */
export const clockTime = (id: number): number => id === 0 || id === 5 || id === 8 ? wallMillis() : guestNow() + 1000;
/** a struct timespec / timeval as milliseconds, and back (the second field is nanoseconds or microseconds) */
export function readTs(p: number, unit = 1e6): number { return ldLong(p + KLAYOUT.TS_SEC) * 1000 + ldLong(p + KLAYOUT.TS_NSEC) / unit; }
export function writeTs(p: number, ms: number, unit = 1e6): void {
  const seconds = Math.floor(ms / 1000);
  stLong(p + KLAYOUT.TS_SEC, seconds);
  stLong(p + KLAYOUT.TS_NSEC, Math.floor((ms - seconds * 1000) * unit));
}
/** an off_t argument: 64-bit on LP64, 32-bit on ILP32 */
export const offArg = (a: { i(): number; l(): bigint }) => (PTR === 8 ? Number(a.l()) : a.i());
function setErrno(cpu: Cpu, e: number): void { mem.st32(cpu.errnoAddr, e); }
/** the common "-1 and errno" return; a Java caller (no cpu) gets -errno, as the kernel returns it */
export function fail(cpu: Cpu | null, e: number): number {
  if (!cpu) return -e;
  setErrno(cpu, e);
  return -1;
}
/** a kernel result (-errno on failure) as libc returns it: -1 with errno set */
export function kernelResult(cpu: Cpu | null, value: number): number;
export function kernelResult(cpu: Cpu | null, value: number | Promise<number>): number | Promise<number>;
export function kernelResult(cpu: Cpu | null, value: number | Promise<number>): number | Promise<number> {
  return value instanceof Promise ? value.then((r) => kernelResult(cpu, r)) : value < 0 ? fail(cpu, -value) : value;
}
/** MAP_FAILED, pointer-wide, with errno set */
const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;
function mapFailed(cpu: Cpu, e: number): number | bigint { fail(cpu, e); return PTR === 8 ? -1n : -1; }

const randomWord = new Uint32Array(1);
/** getRandomValues fills at most 64 KiB a call, and no shared view (guest memory): such a
 *  target is filled through a copy */
export function randomBytes(target: Uint8Array): void {
  const out = target.buffer instanceof ArrayBuffer ? target : new Uint8Array(target.length);
  for (let off = 0; off < out.length; off += 65536) crypto.getRandomValues(out.subarray(off, off + 65536));
  if (out !== target) target.set(out);
}
export function fillRandom(p: number, n: number): void { randomBytes(mem.bytes(p, n)); wrote(p, n); }
function random32(): number { crypto.getRandomValues(randomWord); return randomWord[0] >>> 0; }
export const utf8 = (s: string) => codec.enc.encode(s);
export const mbLen = (b0: number) => b0 < 0x80 ? 1 : b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc0 ? 2 : 1;

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
/** strtol and its kin: a 32-bit result as a number, a 64-bit one as a bigint. Digits accumulate exactly in a double until
 *  they pass 2^53; an unsigned conversion of a negative string wraps, as C's does. */
function strtoNum(cpu: Cpu, s: number, endp: number, base: number, bits: 32 | 64, unsigned: boolean): number | bigint {
  let p = s;
  while (isspace(mem.u8[p])) p++;
  let neg = false;
  if (mem.u8[p] === 43 || mem.u8[p] === 45) { neg = mem.u8[p] === 45; p++; }
  if ((base === 0 || base === 16) && mem.u8[p] === 48 && (mem.u8[p + 1] | 32) === 120) { base = 16; p += 2; }
  else if (base === 0) base = mem.u8[p] === 48 ? 8 : 10;
  let n = 0, big: bigint | null = null, any = false;
  for (;;) {
    const c = mem.u8[p];
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48; else if ((c | 32) >= 97 && (c | 32) <= 122) d = (c | 32) - 87; else break;
    if (d >= base) break;
    if (big !== null) big = big * BigInt(base) + BigInt(d);
    else if (n * base + d <= Number.MAX_SAFE_INTEGER) n = n * base + d;
    else big = BigInt(n) * BigInt(base) + BigInt(d);
    any = true; p++;
  }
  if (!any) p = s;
  if (endp) stp(endp, p);
  if (bits === 32 && big === null) {
    const max = unsigned ? 0xffffffff : 0x7fffffff;
    if (n > (neg && !unsigned ? max + 1 : max)) { setErrno(cpu, E.RANGE); return neg && !unsigned ? -max - 1 : max; }
    return !neg ? n : unsigned ? (0x100000000 - n) % 0x100000000 : 0 - n;
  }
  const v = big ?? BigInt(n), max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
  let r: bigint;
  if (v > (neg && !unsigned ? max + 1n : max)) { setErrno(cpu, E.RANGE); r = neg && !unsigned ? -max - 1n : max; }
  else r = !neg ? v : unsigned ? BigInt.asUintN(bits, -v) : -v;
  return bits === 32 ? Number(r) : r;
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
  mem.st32(tm + TM.gmtoff, utc ? 0 : -d.getTimezoneOffset() * 60);
  stp(tm + TM.zone, tznames[utc ? 0 : 1]);
}
function readTm(tm: number): number[] { const f: number[] = []; for (let i = 0; i < 9; i++) f.push(mem.ld32(tm + i * 4) | 0); return f; }
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
function toTm(seconds: number, tm: number, utc: boolean): number { fillTm(tm, new Date(seconds * 1000), utc); return tm; }
const mktime64 = (tm: number): bigint => BigInt(Math.floor(mktime(tm) / 1000));
function mktime(tm: number): number {
  const [sec, min, hour, mday, mon, year] = readTm(tm);
  return new Date(year + 1900, mon, mday, hour, min, sec).getTime();
}
function timegm(tm: number): number {
  const [sec, min, hour, mday, mon, year] = readTm(tm);
  return Math.floor(Date.UTC(year + 1900, mon, mday, hour, min, sec) / 1000);
}
let tznames: number[] = [0, 0];

// ── setjmp/longjmp: the callee-saved registers r4–r14 live in the guest jmp_buf itself
function setjmp(cpu: Cpu, buf: number): number {
  for (let i = 4; i <= 14; i++) mem.st32(buf + (i - 4) * 4, cpu.w[2 * i]);
  return 0;
}
function longjmp(cpu: Cpu, buf: number, val: number): typeof NORET {
  const w = cpu.w;
  const apply = () => {
    for (let i = 4; i <= 14; i++) w[2 * i] = mem.ld32(buf + (i - 4) * 4);
    w[0] = val || 1;
    cpu.setPc(w[28]);
  };
  if (!cpu.leaveHandler(BigInt(mem.ld32(buf + 36) >>> 0), apply)) apply();
  return NORET;
}

// ── random (lrand48 family: 48-bit LCG as in the C library)
// the state in 24-bit halves, so each step is exact in doubles: x = 0x5deece66d * x + 0xb mod 2^48
let r48hi = 0x1234ab, r48lo = 0xcd330e;
const next48 = (): void => {
  const t = 0xece66d * r48lo + 0xb;
  r48hi = (Math.floor(t / 0x1000000) + 0xece66d * r48hi + 0x5de * r48lo) % 0x1000000;
  r48lo = t % 0x1000000;
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
export function fillSysinfo(p: number): void {
  const L = PTR, unit = L === 8 ? 1 : 4096;
  const totalRam = device.cpu.memKb * 1024;
  mem.memset(p, 0, L === 8 ? 112 : 64);
  const put = (off: number, v: number) => stLong(p + off, v);
  put(0, Math.floor(guestNow() / 1000));
  put(L * 4, totalRam / unit); put(L * 5, totalRam / (2 * unit));
  mem.st16(p + L * 10, 1);
  mem.st32(p + (L === 8 ? 104 : 52), unit);
}
// File mappings are copies of the file's bytes: a private one keeps its stores to itself, and a
// MAP_SHARED one is kept coherent with the file and its other mappings (mappings.ts)
/** mmap, whose file offset `offOf` reads: an off_t, or mmap64's off64_t */
const mmapWith = (offOf: (a: Parameters<HostFn>[1]) => number): HostFn => (cpu, a) => {
  const hint = a.va(), n = Number(a.va()), prot = a.i(), flags = a.i(), fd = a.i(), off = offOf(a);
  if (!Number.isSafeInteger(n) || n <= 0 || (flags & 0x10 && (hint & 4095n))) return mapFailed(cpu, E.INVAL);
  const reserve = (flags & 0x20) !== 0 && prot === 0;
  // The core executes only below 4 GiB: code (PROT_EXEC now, or a JIT's code range hinted
  // low and made executable later, as V8's is) must not land in a plane above it.
  const p = flags & 0x10 ? hint : mem.mapVa(n, reserve, (prot & 4) !== 0 || (hint > 0n && hint < 0x1_0000_0000n));
  if (!p || (flags & 0x10 && !(mem.mapFixed(hint, pages(n)) && (reserve ? mem.reserveVa(hint, n) : mem.commitVa(hint, n))))) return mapFailed(cpu, E.NOMEM);
  if (flags & 0x10) syncShared(hint, n, true);
  if (flags & 0x10 && !reserve) { invalidateRange(mem.txVa(hint), n); mem.dropVa(hint, n); }
  if (fd !== -1 && !(flags & 0x20) && flags & 1 && isRemoteFd(fd))
    return mapRemoteShared(BigInt(p), n, off, fd, prot).then(e => { if (!e) return p; mem.unmapVa(BigInt(p), n); return mapFailed(cpu, e); });
  if (fd !== -1 && !(flags & 0x20)) {
    const file = fdFile(fd), track = () => {
      if (file) { if (flags & 1) trackSharedMap(BigInt(p), n, off, file, (prot & 2) !== 0); else trackPrivateMap(BigInt(p), n, off, file); }
      return p;
    };
    const r = readInto(cpu, fd, off, guestAt(p), n); return r instanceof Promise ? r.then(track) : track();
  }
  return p;
};
/** the kernel's memory mapping, time and identity calls */
export const LIBC_SYSCALLS: Record<string, HostFn> = {
  getuid: () => procIdentity.uid, geteuid: () => procIdentity.uid, getgid: () => procIdentity.uid, getegid: () => procIdentity.uid,
  getppid: () => 1,
  // the process leads its own group, as /proc/self/stat says; no other process is visible
  getpgid: (cpu, a) => { const pid = a.i(); return pid === 0 || pid === cpu.pid ? cpu.pid : fail(cpu, E.SRCH); },
  setpriority: () => 0, getpriority: () => 0,
  uname: (_c, a) => {
    const p = a.p();
    const u = uname(PTR === 8), f = [u.sysname, u.nodename, u.release, u.version, u.machine, u.domainname];
    for (let i = 0; i < f.length; i++) mem.putCstr(p + i * UTSNAME_FIELD, f[i], UTSNAME_FIELD);
    return 0;
  },
  // a protection change moves no byte: a block stays valid until a write or a cache flush says otherwise
  mprotect: (cpu, a) => {
    const va = a.va(), n = Number(a.va()), prot = a.i();
    if (prot & 7) return mem.commitVa(va, n) ? 0 : fail(cpu, E.NOMEM);
    mem.decommitVa(va, n);
    return 0;
  },
  mmap: mmapWith(offArg),
  munmap: (cpu, a) => {
    const va = a.va(), n = Math.ceil(Number(a.va()) / PAGE_SIZE) * PAGE_SIZE; // whole pages, as the kernel unmaps
    if (va & BigInt(PAGE_SIZE - 1) || !n) return fail(cpu, E.INVAL);
    syncShared(va, n, true);
    return mem.unmapVa(va, n) ? 0 : fail(cpu, E.INVAL);
  },
  // A mapping shrinks in place, grows in place when the address space after it is free, and with
  // MREMAP_MAYMOVE moves (to new_address with MREMAP_FIXED). A shared file mapping keeps its file
  // range wherever it lands, and its new pages hold the file's bytes.
  mremap: (cpu, a) => {
    const old = a.va(), oldSize = Number(a.va()), size = Number(a.va()), flags = a.i(), fixed = flags & 2 ? a.va() : 0n;
    const mask = BigInt(PAGE_SIZE - 1), result = (va: bigint) => PTR === 8 ? va : Number(va);
    if (old & mask || fixed & mask || !size || flags & ~3 || (flags & 2 && !(flags & 1))) return mapFailed(cpu, E.INVAL);
    if (flags & 2 && fixed < old + BigInt(pages(oldSize)) && old < fixed + BigInt(pages(size))) return mapFailed(cpu, E.INVAL);
    if (!(flags & 2) && pages(size) <= pages(oldSize)) {
      const tail = pages(oldSize) - pages(size);
      if (tail) { syncShared(old + BigInt(pages(size)), tail, true); mem.unmapVa(old + BigInt(pages(size)), tail); }
      return result(old);
    }
    const mapping = fileMapAt(old);
    let to = old;
    if (flags & 2 || !mem.extendVa(old, oldSize, size)) {
      if (!(flags & 1)) return mapFailed(cpu, E.NOMEM);
      if (flags & 2) {
        syncShared(fixed, size, true);
        if (!mem.mapFixed(fixed, pages(size)) || !mem.commitVa(fixed, size)) return mapFailed(cpu, E.NOMEM);
        invalidateRange(mem.txVa(fixed), size); mem.dropVa(fixed, size);
        to = fixed;
      } else {
        const moved = mem.mapVa(size, false, old < 0x1_0000_0000n);
        if (!moved) return mapFailed(cpu, E.NOMEM);
        to = BigInt(moved);
      }
      syncShared(old, oldSize, true);
      mem.write(mem.txVa(to), mem.bytes(mem.txVa(old), Math.min(oldSize, size)));
      mem.unmapVa(old, pages(oldSize));
    } else syncShared(old, oldSize, true);
    if (!mapping) return result(to);
    const track = () => {
      if (mapping.shared) trackSharedMap(to, size, mapping.off, mapping.file, mapping.writable); else trackPrivateMap(to, size, mapping.off, mapping.file);
      return result(to);
    };
    if (size <= oldSize) return track();
    const tail = contentAt(mapping.file, mapping.off + oldSize, size - oldSize);
    const fill = (bytes: Uint8Array) => { mem.write(mem.txVa(to + BigInt(oldSize)), bytes); return track(); };
    return tail instanceof Promise ? tail.then(fill, () => mapFailed(cpu, E.IO)) : fill(tail);
  },
  // MADV_DONTNEED zero-fills anonymous memory; a shared file mapping refaults from the page
  // cache, which already holds its stores, so its contents stay
  madvise: (_c, a) => { const va = a.va(), n = Number(a.va()); if (a.i() === 4 && !isShared(va, n)) mem.dropVa(va, n); return 0; },
  msync: (cpu, a) => { const va = a.va(), n = Number(a.va()); if (va & 4095n) return fail(cpu, E.INVAL); syncShared(va, n, false); return 0; },
  mlock: () => 0, munlock: () => 0,
  // PR_SET_NAME names the calling thread: what wd.native.regs shows and what a trace prefixes
  prctl: (cpu, a) => { const op = a.i(); if (op === 15) { const s = mem.cstr(a.p(), 16); if (s) nameThread(cpu.jthread, s); } return 0; },
  gettimeofday: (_c, a) => { const tv = a.p(); if (tv) writeTs(tv, wallMillis(), 1e3); return 0; },
  clock_gettime: (_c, a) => {
    const id = a.i(), ts = a.p();
    writeTs(ts, clockTime(id)); // MONOTONIC/BOOTTIME: never 0
    return 0;
  },
  clock_getres: (_c, a) => { a.i(); const ts = a.p(); if (ts) { stLong(ts + KLAYOUT.TS_SEC, 0); stLong(ts + KLAYOUT.TS_NSEC, 1000); } return 0; },
};
/** an ARM32 process's libc: libc.so, liblog.so, libm.so and libz.so, which expose the kernel's
 *  calls as well */
export function libcInit(): void {
  // _ctype_ (257 bytes, index c+1), tzname
  const ct = mem.hostAlloc(384);
  for (let c = 0; c < 256; c++) mem.u8[ct + 1 + c] = c < 128 ? ctypeBits(c) : 0;
  const ctype = mem.hostAlloc(PTR);
  stp(ctype, ct);
  hostData("libc.so", "_ctype_", ctype);
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
  const envString = (s: string) => { const p = mem.strdup(s); envStrings.add(p); return p; };
  const envKey = (p: number) => mem.cstr(p).split("=", 1)[0];
  writeEnv(Object.entries(processEnv).map(([k, v]) => envString(k + "=" + v)));

  const M: Record<string, HostFn> = {
    __errno: (cpu) => cpu.errnoAddr,
    __set_errno: (cpu, a) => { setErrno(cpu, a.i()); return -1; },
    abort: (cpu) => abortThread(cpu),
    exit: (cpu, a) => exitGroup(cpu, a.i(), "exit"),
    _exit: (cpu, a) => exitGroup(cpu, a.i(), "_exit"),
    atexit: () => 0,
    __cxa_atexit: () => 0,
    __cxa_finalize: () => 0,
    __cxa_pure_virtual: (cpu) => cpu.fault("pure virtual call"),
    __stack_chk_fail: (cpu) => cpu.fault("stack smashing detected"),
    getpid: (cpu) => cpu.pid,
    gettid: (cpu) => cpu.osTid,
    getpgrp: (cpu) => cpu.pid,
    bsd_signal: () => 0,
    nice: () => 0,
    sysconf: (_c, a) => sysconf(a.i()),
    getpagesize: () => 4096,
    android_get_device_api_level: () => device.sdk,
    // AT_HWCAP and friends: this CPU advertises no optional feature bits, which is true and is
    // also what steers a library away from the paths the emitter has not written.
    getauxval: (cpu, a) => {
      const t = a.ul(), e = auxv().find(([type]) => BigInt(type) === t);
      if (e) return e[1];
      fail(cpu, E.NOENT);
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
      processEnv[k] = v; writeEnv(entries); return 0;
    },
    unsetenv: (cpu, a) => {
      const k = a.str(); if (!k || k.includes("=")) return fail(cpu, E.INVAL);
      writeEnv(envEntries().filter((p) => { if (envKey(p) !== k) return true; if (envStrings.delete(p)) mem.free(p); return false; }));
      delete processEnv[k];
      return 0;
    },
    setlocale: (_c, a) => { a.i(); const l = a.p(); return l && mem.cstr(l) !== "" && mem.cstr(l) !== "C" && mem.cstr(l) !== "POSIX" ? 0 : cLocale; },
    localeconv: () => localeConv,
    mmap64: mmapWith((a) => Number(a.l())),
    // the raw syscalls a runtime issues past libc: futex is the one that must block
    syscall: syscallEntry,
    cacheflush: (_c, a) => { const s = a.p(), e = a.p(); invalidateRange(s, e - s, "cacheflush"); return 0; },
    __aeabi_read_tp: (cpu) => cpu.tlsBase,

    malloc: SERVED, free: SERVED, calloc: SERVED, realloc: SERVED, memalign: SERVED, posix_memalign: SERVED, malloc_usable_size: SERVED,
    valloc: (_c, a) => mem.memalign(PAGE_SIZE, a.u()),
    memcpy: SERVED, memmove: SERVED, memset: SERVED, memcmp: SERVED, memchr: SERVED,
    memmem: (_c, a) => {
      const h = a.p(), length = a.u(), n = a.p(), size = a.u();
      if (!size) return ptr(h);
      const bytes = mem.u8.subarray(h, h + length), needle = mem.u8.subarray(n, n + size), end = length - size;
      for (let p = 0; p <= end; p++) {
        p = bytes.indexOf(needle[0], p);
        if (p < 0 || p > end) break;
        let i = 1;
        while (i < size && bytes[p + i] === needle[i]) i++;
        if (i === size) return ptr(h + p);
      }
      return 0;
    },
    memrchr: (_c, a) => { const p = a.p(), c = a.i() & 255, n = a.u(); for (let i = p + n - 1; i >= p; i--) if (mem.u8[i] === c) return ptr(i); return 0; },
    bcopy: (_c, a) => { const s = a.p(), d = a.p(), n = a.u(); mem.memmove(d, s, n); },
    bzero: (_c, a) => { const d = a.p(), n = a.u(); mem.memset(d, 0, n); },

    strlen: SERVED, strnlen: SERVED,
    strcpy: (_c, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s); mem.memmove(d, s, n + 1); return ARG0; },
    strncpy: (_c, a) => { strncpy(a.p(), a.p(), a.u()); return ARG0; },
    stpcpy: (_c, a) => { const d = a.p(), s = a.p(); const n = mem.strlen(s); mem.memmove(d, s, n + 1); return ptr(d + n); },
    strcat: (_c, a) => { const d = a.p(), s = a.p(); const dl = mem.strlen(d), n = mem.strlen(s); mem.memmove(d + dl, s, n + 1); return ARG0; },
    strncat: (_c, a) => { strncat(a.p(), a.p(), a.u()); return ARG0; },
    strcmp: SERVED, strncmp: SERVED,
    strcasecmp: (_c, a) => strcmpAt(a.p(), a.p(), 0x7fffffff, true),
    strncasecmp: (_c, a) => strcmpAt(a.p(), a.p(), a.u(), true),
    strcoll: (_c, a) => strcmpAt(a.p(), a.p(), 0x7fffffff, false),
    strxfrm: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); const l = mem.strlen(s); if (n) { const k = Math.min(l, n - 1); mem.memmove(d, s, k); mem.st8(d + k, 0); } return l; },
    strchr: (_c, a) => { const p = a.p(), c = a.i() & 255; for (let i = p; ; i++) { if (mem.u8[i] === c) return ptr(i); if (!mem.u8[i]) return 0; } },
    strrchr: (_c, a) => { const p = a.p(), c = a.i() & 255; let r = 0; for (let i = p; ; i++) { if (mem.u8[i] === c) r = i; if (!mem.u8[i]) return ptr(r); } },
    strstr: (_c, a) => { const i = strstrAt(a.p(), a.p(), false); return i ? ptr(i) : 0; },
    strcasestr: (_c, a) => { const i = strstrAt(a.p(), a.p(), true); return i ? ptr(i) : 0; },
    strpbrk: (_c, a) => { const p = a.p(), set = byteSet(a.p()); for (let i = p; mem.u8[i]; i++) if (set[mem.u8[i]]) return ptr(i); return 0; },
    strspn: (_c, a) => { const p = a.p(), set = byteSet(a.p()); let i = 0; while (set[mem.u8[p + i]]) i++; return i; },
    strcspn: (_c, a) => { const p = a.p(), set = byteSet(a.p()); let i = 0; while (mem.u8[p + i] && !set[mem.u8[p + i]]) i++; return i; },
    strdup: (_c, a) => { const s = a.p(); const n = mem.strlen(s); const d = mem.malloc(n + 1); mem.memmove(d, s, n + 1); return d; },
    strndup: (_c, a) => { const s = a.p(), n = a.u(); let l = 0; while (l < n && mem.u8[s + l]) l++; const d = mem.malloc(l + 1); mem.memmove(d, s, l); mem.u8[d + l] = 0; return d; },
    strtok: (cpu, a) => ptr(strtok(cpu, a.p(), a.p())),
    strtok_r: (_c, a) => { const s = a.p(), d = a.p(), save = a.p(); return ptr(strtokR(s, d, save)); },
    strsep: (_c, a) => {
      const sp = a.p(), s = ldp(sp), set = byteSet(a.p());
      if (!s) return 0;
      let p = s;
      while (mem.u8[p] && !set[mem.u8[p]]) p++;
      if (mem.u8[p]) { mem.st8(p, 0); stp(sp, p + 1); } else stp(sp, 0);
      return ptr(s);
    },
    strerror: (_c, a) => { mem.putCstr(strerrorBuf, strerror(a.i()), 64); return strerrorBuf; },
    strerror_r: (_c, a) => { const e = a.i(), b = a.p(), n = a.u(); mem.putCstr(b, strerror(e), n); return 0; },
    strtol: (cpu, a) => strtoNum(cpu, a.p(), a.p(), a.i(), cpu.a64 ? 64 : 32, false),
    strtoul: (cpu, a) => strtoNum(cpu, a.p(), a.p(), a.i(), cpu.a64 ? 64 : 32, true),
    strtoll: (cpu, a) => strtoNum(cpu, a.p(), a.p(), a.i(), 64, false),
    strtoull: (cpu, a) => strtoNum(cpu, a.p(), a.p(), a.i(), 64, true),
    atoi: (cpu, a) => strtoNum(cpu, a.p(), 0, 10, 32, false),
    atol: (cpu, a) => strtoNum(cpu, a.p(), 0, 10, cpu.a64 ? 64 : 32, false),
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
    wcslen: (_c, a) => wlen(a.p()),
    wmemchr: (_c, a) => { const p = a.p(), c = a.i(), n = a.u(); for (let i = 0; i < n; i++) if (mem.ld32(p + i * 4) === c) return ptr(p + i * 4); return 0; },
    wmemcmp: (_c, a) => { const x = a.p(), y = a.p(), n = a.u(); for (let i = 0; i < n; i++) { const d = mem.ld32(x + i * 4) - mem.ld32(y + i * 4); if (d) return d < 0 ? -1 : 1; } return 0; },
    wmemcpy: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); mem.memmove(d, s, n * 4); return ARG0; },
    wmemmove: (_c, a) => { const d = a.p(), s = a.p(), n = a.u(); mem.memmove(d, s, n * 4); return ARG0; },
    wmemset: (_c, a) => { const d = a.p(), c = a.i(), n = a.u(); for (let i = 0; i < n; i++) mem.st32(d + i * 4, c); return ARG0; },
    wcscmp: (_c, a) => { let x = a.p(), y = a.p(); for (;; x += 4, y += 4) { const c = mem.ld32(x) >>> 0, d = mem.ld32(y) >>> 0; if (c !== d) return c < d ? -1 : 1; if (!c) return 0; } },
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
      const len = mbLen(b0);
      if (n < len) return -2;
      const cp = codec.dec.decode(mem.u8.subarray(s, s + len)).codePointAt(0) ?? 0;
      if (pwc) mem.st32(pwc, cp);
      return b0 === 0 ? 0 : len;
    },
    wcrtomb: (_c, a) => { const d = a.p(), wc = a.i(); const b = utf8(String.fromCodePoint(wc >>> 0 > 0x10ffff ? 0xfffd : wc >>> 0)); if (d) mem.write(d, b); return b.length; },
    mbstowcs: (_c, a) => { const d = a.p(), s = mem.cstr(a.p()), n = a.u(); const cps = [...s].map((c) => c.codePointAt(0)!); if (!d) return cps.length; const k = Math.min(cps.length, n); for (let i = 0; i < k; i++) mem.st32(d + i * 4, cps[i]); if (k < n) mem.st32(d + k * 4, 0); return k; },
    wcstombs: (_c, a) => { const d = a.p(), s = wstr(a.p()), n = a.u(); const b = utf8(s); if (!d) return b.length; const k = Math.min(b.length, n); mem.write(d, b.subarray(0, k)); if (k < n) mem.st8(d + k, 0); return k; },
    mblen: (_c, a) => { const s = a.p(); if (!s) return 0; const b0 = mem.u8[s]; return b0 === 0 ? 0 : b0 < 0x80 ? 1 : b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : 2; },
    __ctype_get_mb_cur_max: () => 4,

    // ── formatting (printf family that lands in memory; the FILE ones live in stdio.ts)
    sprintf: (_c, a) => { const d = a.p(), f = a.str(); return mem.putCstr(d, format(f, a)); },
    snprintf: (_c, a) => { const d = a.p(), n = a.u(), f = a.str(); return snprintfInto(d, n, format(f, a)); },
    vsprintf: (_c, a) => { const d = a.p(), f = a.str(); return mem.putCstr(d, format(f, vaList(a.p()))); },
    vsnprintf: (_c, a) => { const d = a.p(), n = a.u(), f = a.str(); return snprintfInto(d, n, format(f, vaList(a.p()))); },
    vasprintf: (_c, a) => { const out = a.p(), f = a.str(); const s = format(f, vaList(a.p())); stp(out, mem.strdup(s)); return utf8(s).length; },
    asprintf: (_c, a) => { const out = a.p(), f = a.str(); const s = format(f, a); stp(out, mem.strdup(s)); return utf8(s).length; },
    sscanf: (_c, a) => { const s = a.str(), f = a.str(); return scan(s, f, scanSink(a)); },
    vsscanf: (_c, a) => { const s = a.str(), f = a.str(); return scan(s, f, scanSink(vaList(a.p()))); },

    time: (_c, a) => { const p = a.p(); const t = Math.floor(wallMillis() / 1000); if (p) mem.st32(p, t); return t; },
    clock: () => Math.floor(performance.now() * 1000),
    times: () => Math.floor(performance.now() / 10),
    localtime_r: (_c, a) => ptr(toTm(mem.ld32(a.p()), a.p(), false)),
    gmtime_r: (_c, a) => ptr(toTm(mem.ld32(a.p()), a.p(), true)),
    localtime: (_c, a) => toTm(mem.ld32(a.p()), tmBuf, false),
    gmtime: (_c, a) => toTm(mem.ld32(a.p()), tmBuf, true),
    asctime_r: (_c, a) => { const tm = a.p(), buf = a.p(); mem.putCstr(buf, strftime("%c\n", tm), 26); return ptr(buf); },
    asctime: (_c, a) => { mem.putCstr(ascBuf, strftime("%c\n", a.p()), 26); return ascBuf; },
    ctime_r: (_c, a) => { const t = mem.ld32(a.p()), buf = a.p(); mem.putCstr(buf, strftime("%c\n", toTm(t, tmBuf, false)), 26); return ptr(buf); },
    ctime: (_c, a) => { mem.putCstr(ascBuf, strftime("%c\n", toTm(mem.ld32(a.p()), tmBuf, false)), 26); return ascBuf; },
    mktime: (_c, a) => Math.floor(mktime(a.p()) / 1000),
    timegm: (_c, a) => timegm(a.p()),
    // bionic's <time64.h>, which 32-bit code uses past 2038: time64_t is 64-bit on every ABI
    localtime64_r: (_c, a) => ptr(toTm(Number(mem.ld64(a.p())), a.p(), false)),
    gmtime64_r: (_c, a) => ptr(toTm(Number(mem.ld64(a.p())), a.p(), true)),
    localtime64: (_c, a) => toTm(Number(mem.ld64(a.p())), tmBuf, false),
    gmtime64: (_c, a) => toTm(Number(mem.ld64(a.p())), tmBuf, true),
    mktime64: (_c, a) => mktime64(a.p()),
    timelocal64: (_c, a) => mktime64(a.p()),
    timegm64: (_c, a) => BigInt(timegm(a.p())),
    strftime: (_c, a) => { const d = a.p(), n = a.u(), f = a.str(), tm = a.p(); const s = utf8(strftime(f, tm)); if (s.length >= n) return 0; mem.write(d, s); mem.st8(d + s.length, 0); return s.length; },
    tzset: () => {},
    difftime: (c, a) => retD(c, a.i() - a.i()),

    // ── setjmp / longjmp (the buffer holds r4–r14; the _ and sig variants alias them below)
    setjmp: (cpu, a) => setjmp(cpu, a.p()),
    longjmp: (cpu, a) => longjmp(cpu, a.p(), a.i()),

    lrand48: () => { next48(); return r48hi * 128 + (r48lo >>> 17); },
    mrand48: () => { next48(); return (r48hi << 8 | r48lo >>> 16) | 0; },
    drand48: (c) => { next48(); return retD(c, (r48hi * 0x1000000 + r48lo) / 2 ** 48); },
    srand48: (_c, a) => { const seed = a.u(); r48hi = seed >>> 8; r48lo = (seed & 0xff) << 16 | 0x330e; },
    arc4random: () => random32() | 0,
    arc4random_buf: (_c, a) => { const p = a.p(), n = a.u(); if (n) fillRandom(p, n); },
    arc4random_uniform: (_c, a) => {
      const bound = a.u();
      if (!bound) return 0;
      const limit = 4294967296 - (4294967296 % bound);
      let value: number;
      do { value = random32(); } while (value >= limit);
      return (value % bound) | 0;
    },

    gethostbyname: () => 0,
    gethostbyaddr: () => 0,
    gethostname: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "localhost", n); return 0; },
    inet_aton: (_c, a) => { const s = a.str(), out = a.p(); const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); if (!m) return 0; for (let i = 0; i < 4; i++) mem.st8(out + i, +m[i + 1]); return 1; },
    inet_addr: (_c, a) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.str()); if (!m) return -1; return (+m[1]) | (+m[2] << 8) | (+m[3] << 16) | (+m[4] << 24); },
    inet_ntoa: (_c, a) => { const v = a.u(); mem.putCstr(inetBuf, `${v & 255}.${(v >>> 8) & 255}.${(v >>> 16) & 255}.${v >>> 24}`, 20); return inetBuf; },
    htons: (_c, a) => { const v = a.i() & 0xffff; return ((v & 255) << 8) | (v >>> 8); },
    htonl: (_c, a) => { const v = a.i(); return ((v & 255) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24); },
    __android_log_write: (_c, a) => { const prio = a.i(), tag = a.str(), msg = a.str(); logLine(prio, tag, msg); return 1; },
    __android_log_print: (_c, a) => { const prio = a.i(), tag = a.str(), f = a.str(); logLine(prio, tag, format(f, a)); return 1; },
    __android_log_vprint: (_c, a) => { const prio = a.i(), tag = a.str(), f = a.str(); logLine(prio, tag, format(f, vaList(a.p()))); return 1; },
    __android_log_assert: (cpu, a) => { a.p(); const tag = a.str(); const f = a.p(); cpu.fault(`assert ${tag}: ${f ? format(mem.cstr(f), a) : ""}`); },
  };
  M.wcscoll = M.wcscmp;
  // the *_l variants: the base function, with the trailing locale_t never read
  for (const n of ["strtol", "strtoul", "strtoll", "strtoull", "strtod", "strtof", "strtold", "strcoll", "strxfrm", "strftime", "wcscoll", "wcsxfrm", "wcsftime",
    "isalpha", "isdigit", "isxdigit", "isspace", "isupper", "islower", "isalnum", "ispunct", "isprint", "iscntrl", "tolower", "toupper",
    "iswspace", "iswdigit", "iswalpha", "iswupper", "iswlower", "towlower", "towupper", "mbrtowc", "wcrtomb", "localeconv", "strerror",
    "sprintf", "snprintf", "vsprintf", "vsnprintf", "asprintf", "vasprintf", "sscanf", "vsscanf", "btowc", "wctob", "wctype", "iswctype"]) if (M[n]) M[n + "_l"] = M[n];
  M.strtold = M.strtod; M.strtold_l = M.strtod; M.__strchr_chk = M.strchr; M.__strrchr_chk = M.strrchr;
  M._setjmp = M.sigsetjmp = M.setjmp; M._longjmp = M.siglongjmp = M.longjmp;
  M.rand = M.random = M.lrand48; M.srand = M.srandom = M.srand48; M.ntohs = M.htons; M.ntohl = M.htonl;
  M.__aeabi_memclr = M.__aeabi_memclr4 = M.__aeabi_memclr8 = M.bzero;
  M.__aeabi_memset = M.__aeabi_memset4 = M.__aeabi_memset8 = (_c, a) => {
    const d = a.p(), n = a.u(), value = a.i();
    mem.memset(d, value, n);
  };
  hostLib("libc.so", { ...LIBC_SYSCALLS, ...FS_SYSCALLS, ...PTHREAD_SYSCALLS, ...NET_SYSCALLS, ...POLL_SYSCALLS, ...PROC_SYSCALLS, ...SIGNAL_SYSCALLS, ...M });
  hostLib("liblog.so", { __android_log_write: M.__android_log_write, __android_log_print: M.__android_log_print, __android_log_vprint: M.__android_log_vprint, __android_log_assert: M.__android_log_assert });
  const tmBuf = mem.hostAlloc(TM.size), ascBuf = mem.hostAlloc(26);
  const inetBuf = mem.hostAlloc(20);
  const cLocale = mem.hostStr("C");
  const localeConv = mem.hostAlloc(16 * PTR);
  stp(localeConv, mem.hostStr(".")); stp(localeConv + PTR, mem.hostStr("")); stp(localeConv + 2 * PTR, mem.hostStr(""));
  stdioInit();
  pthreadInit();
  timersInit();
  zlibInit();
  libmInit();
  localeInit();
  procInit();
  netInit();
}

const PRIO = ["", "", "V", "D", "I", "W", "E", "F", "S"];
export function logLine(prio: number, tag: string, msg: string): void {
  const line = `${PRIO[prio] ?? prio}/${tag}: ${msg.replace(/\n$/, "")}`;
  if (prio >= 6) console.error("[logcat]", line); else if (prio === 5) console.warn("[logcat]", line); else console.log("[logcat]", line);
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
export function snprintfInto(d: number, n: number, s: string): number {
  const b = utf8(s);
  if (n > 0) { const k = Math.min(b.length, n - 1); mem.write(d, b.subarray(0, k)); mem.st8(d + k, 0); }
  return b.length;
}
function strstrAt(h: number, n: number, ci: boolean): number {
  const u8 = mem.u8, nl = mem.strlen(n), low = (c: number) => (ci && c >= 65 && c <= 90 ? c + 32 : c);
  if (!nl) return h;
  for (let i = h; u8[i]; i++) {
    let k = 0;
    while (k < nl && low(u8[i + k]) === low(u8[n + k])) k++;
    if (k === nl) return i;
  }
  return 0;
}
const accept = new Uint8Array(256);
function byteSet(p: number): Uint8Array {
  accept.fill(0);
  for (let i = p; mem.u8[i]; i++) accept[mem.u8[i]] = 1;
  return accept;
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
export function wlen(p: number): number { let n = 0; while (mem.ld32(p + n * 4)) n++; return n; }
export function wstr(p: number, max = 0x7fffffff): string {
  let s = "";
  for (let i = 0; i < max; i++) { const c = mem.ld32(p + i * 4); if (!c) return s; s += String.fromCodePoint(c >>> 0 > 0x10ffff ? 0xfffd : c >>> 0); }
  return s;
}
const WCTYPES = ["alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space", "upper", "xdigit"];
export const WCTEST: Record<string, RegExp> = {
  alnum: /[\p{L}\p{N}]/u, alpha: /\p{L}/u, blank: /[ \t]/, cntrl: /\p{Cc}/u, digit: /\d/, graph: /[^\s\p{Cc}]/u, lower: /\p{Ll}/u,
  print: /[^\p{Cc}]/u, punct: /\p{P}/u, space: /\s/, upper: /\p{Lu}/u, xdigit: /[0-9a-fA-F]/,
};
const tokSave = new Map<number, number>();
function strtok(cpu: Cpu, s: number, delim: number): number {
  const save = tokSave.get(cpu.tid) ?? 0;
  if (!s) s = save;
  const r = strtokAt(s, delim);
  tokSave.set(cpu.tid, r.next);
  return r.tok;
}
function strtokR(s: number, delim: number, save: number): number {
  if (!s) s = ldp(save);
  const r = strtokAt(s, delim);
  stp(save, r.next);
  return r.tok;
}
function strtokAt(s: number, delim: number): { tok: number; next: number } {
  if (!s) return { tok: 0, next: 0 };
  const set = byteSet(delim), u8 = mem.u8;
  let p = s;
  while (set[u8[p]]) p++;
  if (!u8[p]) return { tok: 0, next: p };
  const tok = p;
  while (u8[p] && !set[u8[p]]) p++;
  if (u8[p]) { mem.st8(p, 0); p++; }
  return { tok, next: p };
}
export function scanSink(a: { p(): number }) {
  return (kind: string, v: unknown): number => {
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
  };
}
