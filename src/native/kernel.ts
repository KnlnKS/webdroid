// The kernel's ABI as its modules share it: the process ABI's struct layouts (stat, statfs, dirent,
// siginfo, cmsghdr, stack_t, sysinfo and libc's dl_phdr_info) and timespecs, off_t arguments, clocks, the log, and results. A kernel body answers -errno; the ARM32 libc's wrappers of
// the same names (asWrappers) answer -1 with errno set, as bionic's syscall stubs do.

import { mem, wrote } from "./mem.ts";
import { PTR, ldLong, stLong, type HostFn, type HostRet } from "./host.ts";
import type { Cpu } from "./cpu.ts";
import type { FileStat } from "./fd.ts";
import { guestNow, wallMillis } from "../guest-clock.ts";
import { MONOTONIC_BASE_MS, WALL_CLOCKS } from "./core-abi.gen.ts";

/** the structs the kernel fills, as each ABI lays them out (stat64 and statfs64 on ILP32; a timeval
 *  is a timespec's shape): siginfo's union, cmsghdr's header, stack_t's ss_size, struct sysinfo's
 *  size and mem_unit, and dl_phdr_info's size */
const KERNEL32 = {
  STAT_SIZE: 104, ST_INO32: 12, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 80, ST_CTIME: 88, ST_INO: 96, TS_SEC: 0, TS_NSEC: 4, TS_SIZE: 8, STATFS_SIZE: 88,
  SI_UNION: 12, CMSG_HDR: 12, SS_SIZE: 8, SYSINFO_SIZE: 64, SYSINFO_UNIT: 52, DL_PHDR_INFO: 32,
};
const KERNEL64: typeof KERNEL32 = {
  STAT_SIZE: 128, ST_INO32: 8, ST_MODE: 16, ST_NLINK: 20, ST_UID: 24, ST_GID: 28, ST_SIZE: 48, ST_BLKSIZE: 56, ST_BLOCKS: 64,
  ST_ATIME: 72, ST_MTIME: 88, ST_CTIME: 104, ST_INO: 8, TS_SEC: 0, TS_NSEC: 8, TS_SIZE: 16, STATFS_SIZE: 120,
  SI_UNION: 16, CMSG_HDR: 16, SS_SIZE: 16, SYSINFO_SIZE: 112, SYSINFO_UNIT: 104, DL_PHDR_INFO: 64,
};
/** the process ABI's kernel structs (setA64) */
export let KLAYOUT = KERNEL32;
export function setKernelLayout(wide: boolean): void { KLAYOUT = wide ? KERNEL64 : KERNEL32; }

/** libc's failure: -1 with errno set */
export function fail(cpu: Cpu, e: number): number {
  mem.st32(cpu.errnoAddr, e);
  return -1;
}
/** a kernel result (-errno on failure) as libc returns it: -1 (of the result's width) with errno set */
export function kernelResult(cpu: Cpu, value: number): number;
export function kernelResult(cpu: Cpu, value: number | Promise<number>): number | Promise<number>;
export function kernelResult(cpu: Cpu, value: HostRet | Promise<HostRet>): HostRet | Promise<HostRet>;
export function kernelResult(cpu: Cpu, value: HostRet | Promise<HostRet>): HostRet | Promise<HostRet> {
  if (value instanceof Promise) return value.then((r) => kernelResult(cpu, r));
  return typeof value === "number" ? value < 0 ? fail(cpu, -value) : value : typeof value === "bigint" && value < 0n ? BigInt(fail(cpu, Number(-value))) : value;
}
/** a kernel body as the ARM32 libc's wrapper of the same name */
export const wrapped = (fn: HostFn): HostFn => (cpu, a) => kernelResult(cpu, fn(cpu, a));
export const asWrappers = (calls: Record<string, HostFn>): Record<string, HostFn> =>
  Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrapped(fn)]));

/** the milliseconds clock `id` reads, by core/abi.zig's rule, which the core's clock_gettime shares */
export const clockTime = (id: number): number => id >= 0 && id < 32 && WALL_CLOCKS >>> id & 1 ? wallMillis() : guestNow() + MONOTONIC_BASE_MS;
/** a struct timespec / timeval as milliseconds, and back (the second field is nanoseconds or microseconds) */
export function readTs(p: number, unit = 1e6): number { return ldLong(p + KLAYOUT.TS_SEC) * 1000 + ldLong(p + KLAYOUT.TS_NSEC) / unit; }
/** a relative timeout's timespec in milliseconds, -1 (forever) for none */
export const readTimeout = (p: number): number => (p ? readTs(p) : -1);
export function writeTs(p: number, ms: number, unit = 1e6): void {
  const seconds = Math.floor(ms / 1000);
  stLong(p + KLAYOUT.TS_SEC, seconds);
  stLong(p + KLAYOUT.TS_NSEC, Math.floor((ms - seconds * 1000) * unit));
}
/** an inode per path: a runtime's own share table keys on st_dev/st_ino */
export function inoOf(path: string): number { let h = 0x811c9dc5; for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193); return (h >>> 0) || 1; }
export function fillStat(buf: number, path: string, { mode, size, mtime, uid, gid }: FileStat): void {
  mem.memset(buf, 0, KLAYOUT.STAT_SIZE);
  mem.st32(buf, 1);                                                                  // st_dev
  mem.st32(buf + KLAYOUT.ST_MODE, mode);
  mem.st32(buf + KLAYOUT.ST_NLINK, 1);
  mem.st32(buf + KLAYOUT.ST_UID, uid); mem.st32(buf + KLAYOUT.ST_GID, gid);
  mem.st32(buf + KLAYOUT.ST_SIZE, size); mem.st32(buf + KLAYOUT.ST_SIZE + 4, 0);
  mem.st32(buf + KLAYOUT.ST_BLKSIZE, 4096);
  mem.st32(buf + KLAYOUT.ST_BLOCKS, (size + 511) >> 9);
  const sec = Math.floor(mtime / 1000);
  for (const o of [KLAYOUT.ST_ATIME, KLAYOUT.ST_MTIME, KLAYOUT.ST_CTIME]) stLong(buf + o, sec);
  mem.st32(buf + KLAYOUT.ST_INO32, inoOf(path)); mem.st32(buf + KLAYOUT.ST_INO, inoOf(path));
}
/** statfs of a filesystem of `total` bytes, `free` of them free, in 4K blocks. f_type and f_bsize are longs; the counts
 *  after them are 64-bit on both ABIs (the ILP32 struct is the kernel's statfs64), then fsid, f_namelen and f_frsize */
export function fillStatfs(b: number, { total, free }: { total: number; free: number }): number {
  mem.memset(b, 0, KLAYOUT.STATFS_SIZE);
  const counts = b + 2 * PTR;
  stLong(b + PTR, 4096);
  [total / 4096, free / 4096, free / 4096, 0x10000, 0x8000].forEach((n, i) => mem.st64(counts + i * 8, BigInt(Math.floor(n))));
  stLong(counts + 48, 255); stLong(counts + 48 + PTR, 4096);
  return 0;
}
/** linux_dirent64, which is also bionic's struct dirent */
export const DIRENT64 = { ino: 0, off: 8, reclen: 16, type: 18, name: 19 };
/** a dirent record of `reclen` bytes at `de`: entry `index` (from 1), d_type `type` and its NUL-terminated name */
export function putDirent(de: number, index: number, reclen: number, type: number, name: Uint8Array): void {
  mem.memset(de, 0, reclen);
  mem.st64(de + DIRENT64.ino, BigInt(index)); mem.st64(de + DIRENT64.off, BigInt(index));
  mem.st16(de + DIRENT64.reclen, reclen);
  mem.st8(de + DIRENT64.type, type);
  mem.write(de + DIRENT64.name, name);
}

/** an off_t argument: 64-bit on LP64, 32-bit on ILP32 */
export const offArg = (a: { i(): number; l(): bigint }) => (PTR === 8 ? Number(a.l()) : a.i());

/** getRandomValues fills at most 64 KiB a call, and no shared view (guest memory): such a
 *  target is filled through a copy */
export function randomBytes(target: Uint8Array): void {
  const out = target.buffer instanceof ArrayBuffer ? target as Uint8Array<ArrayBuffer> : new Uint8Array(target.length);
  for (let off = 0; off < out.length; off += 65536) crypto.getRandomValues(out.subarray(off, off + 65536));
  if (out !== target) target.set(out);
}
export function fillRandom(p: number, n: number): void { randomBytes(mem.bytes(p, n)); wrote(p, n); }

const PRIO = ["", "", "V", "D", "I", "W", "E", "F", "S"];
export function logLine(prio: number, tag: string, msg: string): void {
  const line = `${PRIO[prio] ?? prio}/${tag}: ${msg.replace(/\n$/, "")}`;
  if (prio >= 6) console.error("[logcat]", line); else if (prio === 5) console.warn("[logcat]", line); else console.log("[logcat]", line);
}
