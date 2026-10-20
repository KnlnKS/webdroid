// The kernel's ABI as its modules share it: the process ABI's struct layouts and timespecs, off_t
// arguments, clocks, the log, and results. A kernel body answers -errno; the ARM32 libc's wrappers of
// the same names (asWrappers) answer -1 with errno set, as bionic's syscall stubs do.

import { mem, wrote } from "./mem.ts";
import { PTR, ldLong, stLong, type HostFn, type HostRet } from "./host.ts";
import type { Cpu } from "./cpu.ts";
import { guestNow, wallMillis } from "../guest-clock.ts";

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

/** getRandomValues fills at most 64 KiB a call, and no shared view (guest memory): such a
 *  target is filled through a copy */
export function randomBytes(target: Uint8Array): void {
  const out = target.buffer instanceof ArrayBuffer ? target : new Uint8Array(target.length);
  for (let off = 0; off < out.length; off += 65536) crypto.getRandomValues(out.subarray(off, off + 65536));
  if (out !== target) target.set(out);
}
export function fillRandom(p: number, n: number): void { randomBytes(mem.bytes(p, n)); wrote(p, n); }

const PRIO = ["", "", "V", "D", "I", "W", "E", "F", "S"];
export function logLine(prio: number, tag: string, msg: string): void {
  const line = `${PRIO[prio] ?? prio}/${tag}: ${msg.replace(/\n$/, "")}`;
  if (prio >= 6) console.error("[logcat]", line); else if (prio === 5) console.warn("[logcat]", line); else console.log("[logcat]", line);
}
