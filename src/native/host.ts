// Host-call plumbing: trampoline slots dispatched by PC, the AAPCS argument cursor, return
// writers, virtual host libraries, and the logging stubs unresolved imports bind to.

import type { Cpu } from "./cpu";
import { mem } from "./mem";
import { NativeFault, BadAddress } from "./core";
import { trampAddr, TRAMP_BASE, TRAMP_END, RET_SENTINEL, E } from "./abi";
import { perf } from "../perf";
import { core, CORE_LIBC } from "./core";

export const NORET: unique symbol = Symbol("noret");
/** the result is the first argument, still in x0 (memcpy and its kin): nothing to translate back */
export const ARG0: unique symbol = Symbol("arg0");
/** a name the core serves (CORE_LIBC): the host has no body, the tracer goes through libc_call */
export const SERVED: HostFn = (cpu) => cpu.fault("a core-served call reached the host");
/** the result is already in its return registers (see retF/retD); only the return itself is left to do */
const VRET: unique symbol = Symbol("vret");
export type HostRet = number | bigint | void | typeof NORET | typeof VRET | typeof ARG0;
export type HostFn = (cpu: Cpu, a: ArgReader) => HostRet | Promise<HostRet>;

export interface ArgReader {
  i(): number; u(): number; p(): number; l(): bigint; ul(): bigint; f(): number; d(): number; str(): string;
  /** the pointer as the guest holds it (plane and all), for what is handed back or keyed rather than dereferenced */
  va(): bigint;
  strAt(p: number): string;
}

const scratch = new DataView(new ArrayBuffer(8));
export function fbits(x: number): number { scratch.setFloat32(0, x, true); return scratch.getInt32(0, true); }
export function bitsf(i: number): number { scratch.setInt32(0, i, true); return scratch.getFloat32(0, true); }
export function dbits(x: number): bigint { scratch.setFloat64(0, x, true); return scratch.getBigInt64(0, true); }
export function bitsd(l: bigint): number { scratch.setBigInt64(0, l, true); return scratch.getFloat64(0, true); }
/** the double whose bits are the words `lo`, `hi` */
export function wordsd(lo: number, hi: number): number { scratch.setInt32(0, lo, true); scratch.setInt32(4, hi, true); return scratch.getFloat64(0, true); }
export function retPair(lo: number, hi: number): bigint { return (BigInt(hi | 0) << 32n) | BigInt(lo >>> 0); }
/** return a float / double from a host function: s0/d0 on AAPCS64, the bits in r0(/r1) on softfp */
export function retF(cpu: Cpu, x: number): HostRet { if (cpu.a64) { cpu.s[0] = x; return VRET; } return fbits(x); }
export function retD(cpu: Cpu, x: number): HostRet {
  if (cpu.a64) cpu.d[0] = x;
  else { scratch.setFloat64(0, x, true); cpu.w[0] = scratch.getInt32(0, true); cpu.w[2] = scratch.getInt32(4, true); }
  return VRET;
}

/** the readers every cursor derives from its own i() and l(): the ILP32 ones as they stand, the
 *  LP64 ones with their pointer and floating-point reads overridden */
abstract class Cursor implements ArgReader {
  abstract i(): number;
  abstract l(): bigint;
  u(): number { return this.i() >>> 0; }
  p(): number { return this.i() >>> 0; }
  va(): bigint { return BigInt(this.p()); }
  ul(): bigint { return BigInt.asUintN(64, this.l()); }
  f(): number { return bitsf(this.i()); }
  d(): number { return bitsd(this.l()); }
  str(): string { return mem.cstr(this.p()); }
  strAt(p: number): string { return mem.cstr(p); }
}

/** AAPCS argument cursor: r0–r3, then the caller's stack; 64-bit values on even registers / 8-byte stack slots */
export class Args extends Cursor {
  private cpu!: Cpu;
  private n = 0;      // next core register
  private sp = 0;     // next stack slot
  constructor(cpu: Cpu) { super(); this.reset(cpu); }
  reset(cpu: Cpu): void { this.cpu = cpu; this.n = 0; this.sp = cpu.w[26]; }
  i(): number {
    if (this.n < 4) return this.cpu.w[2 * this.n++];
    const v = mem.ld32(this.sp); this.sp += 4; return v;
  }
  l(): bigint {
    if (this.n & 1) this.n++;
    if (this.n < 4) { const lo = this.cpu.w[2 * this.n], hi = this.cpu.w[2 * this.n + 2]; this.n += 2; return retPair(lo, hi); }
    this.n = 4;
    this.sp = (this.sp + 7) & ~7;
    const v = mem.ld64(this.sp); this.sp += 8; return v;
  }
  d(): number {
    if (this.n & 1) this.n++;
    if (this.n < 4) { const v = wordsd(this.cpu.w[2 * this.n], this.cpu.w[2 * this.n + 2]); this.n += 2; return v; }
    this.n = 4;
    this.sp = (this.sp + 7) & ~7;
    const v = mem.ldf64(this.sp); this.sp += 8; return v;
  }
}

/** the ILP32 va_list: a flat cursor over the caller's stack */
class VaList extends Cursor {
  constructor(private a: number) { super(); }
  i(): number { const v = mem.ld32(this.a); this.a += 4; return v; }
  l(): bigint { this.a = (this.a + 7) & ~7; const v = mem.ld64(this.a); this.a += 8; return v; }
  d(): number { this.a = (this.a + 7) & ~7; const v = mem.ldf64(this.a); this.a += 8; return v; }
}

/** AAPCS64's va_list is a struct: {__stack, __gr_top, __vr_top, __gr_offs, __vr_offs}. A general
 *  argument comes from the register save area at gr_top + gr_offs while gr_offs is negative, then
 *  from 8-byte stack slots; an FP one likewise from 16-byte slots at vr_top + vr_offs. The offsets
 *  are kept here, not written back: no caller reuses the list after a v*printf or Call*MethodV. */
class VaList64 extends Cursor {
  private stack = -1; private grTop = -1; private vrTop = -1; private grOffs = 0; private vrOffs = 0;
  private loaded = false;
  constructor(private readonly at: number) { super(); }
  // libc reads the list only when a conversion needs an argument: a caller with none may pass
  // junk, and one whose arguments all sit in one area leaves the other area's top pointer
  // uninitialized (clang builds the struct from whatever the slots held) — the guest never
  // dereferences it, so each pointer is translated only once an argument comes from its area
  private load(): void {
    this.grOffs = mem.ld32(this.at + 24); this.vrOffs = mem.ld32(this.at + 28);
    this.loaded = true;
  }
  private slot(): number {
    if (this.stack < 0) this.stack = ldp(this.at);
    const p = ((this.stack + 7) & ~7) >>> 0; this.stack = p + 8; return p;
  }
  private gp(): number {
    if (!this.loaded) this.load();
    if (this.grOffs >= 0) return this.slot();
    if (this.grTop < 0) this.grTop = ldp(this.at + 8);
    const p = this.grTop + this.grOffs;
    this.grOffs += 8;
    return this.grOffs > 0 ? this.slot() : p;
  }
  private fp(): number {
    if (!this.loaded) this.load();
    if (this.vrOffs >= 0) return this.slot();
    if (this.vrTop < 0) this.vrTop = ldp(this.at + 16);
    const p = this.vrTop + this.vrOffs;
    this.vrOffs += 16;
    return this.vrOffs > 0 ? this.slot() : p;
  }
  i(): number { return mem.ld32(this.gp()); }
  p(): number { return ldp(this.gp()); }
  va(): bigint { return mem.ld64(this.gp()); }
  l(): bigint { return mem.ld64(this.gp()); }
  f(): number { return this.d(); }   // a float vararg is promoted to double
  d(): number { return mem.ldf64(this.fp()); }
}
/** the va_list the process ABI defines, over the guest pointer `a` */
export function vaList(a: number): ArgReader { return PTR === 8 ? new VaList64(a) : new VaList(a); }

/** The guest's pointer width: 8 for LP64 (arm64), 4 for ILP32 (arm). Set with the process ABI
 *  by Cpu.setAbi, and read by everything that lays out a struct or a function table for the
 *  guest — a JNIEnv vtable, a JNINativeMethod record, an out-parameter holding a pointer. */
export let PTR = 4;
export function setPtrWidth(n: number): void { PTR = n; }
/** store a guest pointer; the high half of an LP64 slot is always zero in this address space */
export function stp(a: number, v: number): void { const g = mem.va(v); if (typeof g === "bigint") { mem.st64(a, g); return; } mem.st32(a, v); if (PTR === 8) mem.st32(a + 4, 0); }
/** a pointer read from guest memory, translated; a pointer stored is written as the guest knows it */
export function ldp(a: number): number { const lo = mem.ld32(a), hi = PTR === 8 ? mem.ld32(a + 4) : 0; return hi ? mem.tx(hi, lo) : lo >>> 0; }
/** a C long, pointer-sized: signed on load */
/** an unsigned pointer-sized word (an address or size_t) as a bigint */
export const ldWord = (a: number): bigint => PTR === 8 ? mem.ld64(a) : BigInt(mem.ld32(a) >>> 0);
export function stWord(a: number, v: bigint): void { if (PTR === 8) mem.st64(a, v); else mem.st32(a, Number(v)); }
export const ldLong = (a: number): number => PTR === 8 ? Number(mem.ld64(a)) : mem.ld32(a) | 0;
export function stLong(a: number, v: number): void { if (PTR === 8) mem.st64(a, BigInt(v)); else mem.st32(a, v); }
/** sort `xs` in place, stably, with O(n log n) calls to `cmp` (each one a guest call for qsort and its kin) */
export async function guestSort<T>(xs: T[], cmp: (x: T, y: T) => Promise<number>): Promise<void> {
  let src = xs.slice(), dst = new Array<T>(xs.length);
  for (let w = 1; w < xs.length; w *= 2) {
    for (let lo = 0; lo < xs.length; lo += 2 * w) {
      const mid = Math.min(lo + w, xs.length), hi = Math.min(lo + 2 * w, xs.length);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) dst[k++] = ((await cmp(src[i], src[j])) | 0) <= 0 ? src[i++] : src[j++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    [src, dst] = [dst, src];
  }
  for (let i = 0; i < xs.length; i++) xs[i] = src[i];
}
export function stpVa(a: number, v: number | bigint): void { if (typeof v === "bigint") mem.st64(a, v); else stp(a, v); }
/** a pointer a host function derived from one it was given: the guest's address for it */
export const ptr = (p: number): number | bigint => mem.va(p);

const fns: HostFn[] = [];
const names: string[] = [];
const bound: number[] = [];
/** per slot: a system call's entry (the kernel's body, or a libc wrapper whose pointers reach only
 *  the kernel), which a bad pointer fails with EFAULT where any other faults as libc's code would */
const kernelSlots = new Uint8Array((TRAMP_END - TRAMP_BASE) >>> 3);
const kernelNames = new Set<string>();
export const kernelEntry = (slot: number): boolean => kernelSlots[slot] === 1;
/** the system call entries by name (syscall.ts), marked on their slots now and as they are defined */
export function markKernelEntries(list: Iterable<string>): void {
  for (const name of list) kernelNames.add(name);
  names.forEach((name, slot) => { if (kernelNames.has(name)) kernelSlots[slot] = 1; });
}
export function defineHost(name: string, fn: HostFn): number {
  const slot = fns.length;
  if (trampAddr(slot) >= RET_SENTINEL) throw new Error("out of trampoline slots");
  fns.push(fn); names.push(name);
  if (kernelNames.has(name)) kernelSlots[slot] = 1;
  if (CORE_LIBC[name]) core.host_bind(slot, (bound[slot] = CORE_LIBC[name]));
  // `bx lr` at the slot so a guest that reads its own code (or a disassembler) sees something sane
  mem.u32[trampAddr(slot) >>> 2] = 0xe12fff1e;
  return trampAddr(slot);
}
export function slotName(slot: number): string { return names[slot] ?? `slot${slot}`; }
/** calls per trampoline slot (wd.native.hostCalls) */
export const hostCounts = new Uint32Array((TRAMP_END - TRAMP_BASE) >>> 3);
export const hostTrace = { on: false, ring: [] as string[], max: 256, filter: null as RegExp | null };

/** dispatch a host call at trampoline `slot`; a returned promise parks the Cpu (see Cpu.runSlice) */
export function hostDispatch(cpu: Cpu, slot: number): void {
  const fn = fns[slot];
  if (!fn) cpu.fault(`call to undefined trampoline slot ${slot}`);
  perf.nativeHostCalls++;
  hostCounts[slot]++;
  const a = cpu.args;
  a.reset(cpu);
  let traced = false;
  if (hostTrace.on) {
    const nm = names[slot];
    if (!hostTrace.filter || hostTrace.filter.test(nm)) {
      traced = true;
      const w = cpu.w;
      const args = Array.from({ length: cpu.a64 ? 8 : 4 }, (_, i) => {
        const lo = (w[2 * i] >>> 0).toString(16);
        return cpu.a64 && w[2 * i + 1] ? (w[2 * i + 1] >>> 0).toString(16) + "_" + lo.padStart(8, "0") : lo;
      }).join(",");
      const entry = `${cpu.name}:${nm}(${args}) lr=${(cpu.lr >>> 0).toString(16)}`;
      // a spin loop's repeats add nothing: keep the first pass through a short cycle
      if (hostTrace.ring.slice(-4).some((e) => e.startsWith(entry))) traced = false;
      else hostTrace.ring.push(entry);
      if (hostTrace.ring.length > hostTrace.max) hostTrace.ring.splice(0, hostTrace.ring.length - hostTrace.max);
    }
  }
  const t0 = slowMs ? performance.now() : 0;
  const served = hostTrace.on && bound[slot] ? core.libc_call(cpu.base, bound[slot]) : 2;
  if (served === 1) cpu.fault("bad address in a core-served call");
  let ret: HostRet | Promise<HostRet>;
  try { ret = served === 0 ? ARG0 : fn(cpu, a); }
  catch (e) {
    if (e instanceof BadAddress) ret = onBadAddress(cpu, e, kernelSlots[slot] === 1);
    // any other JS Error (not a Java throwable or a fault already placed) is a fault of the
    // guest call: name the block and caller as one
    else if (e instanceof Error && !("msg" in e) && !(e instanceof NativeFault && e.pc)) cpu.fault(`${e.message.replace(/^\[native\] /, "")} in ${names[slot]}`);
    else throw e;
  }
  const dt = slowMs ? performance.now() - t0 : 0;
  if (slowMs && dt > slowMs) console.warn(`[slow-native] ${cpu.name}:${names[slot]}(${(cpu.w[0] >>> 0).toString(16)},${(cpu.w[2] >>> 0).toString(16)},${(cpu.w[4] >>> 0).toString(16)}) ${dt.toFixed(0)}ms`);
  if (ret instanceof Promise) { cpu.pending = ret; return; }
  if (traced) hostTrace.ring[hostTrace.ring.length - 1] += `=${typeof ret === "number" ? (ret >>> 0).toString(16) : String(ret)}`;
  hostReturn(cpu, ret);
}

/** a host body or system call that met a bad guest pointer, synchronously or once its call
 *  resumed: a system call fails with EFAULT (-1 and errno, which a raw one answers as -EFAULT);
 *  anything else faults as bionic's own code would */
export function onBadAddress(cpu: Cpu, e: BadAddress, kernel: boolean): HostRet {
  if (kernel) { mem.st32(cpu.errnoAddr, E.FAULT); return -1; }
  cpu.raiseBadAddress(e);
  return NORET;
}

/** host calls and slices slower than this many ms are logged (debug: set __wdSlowMs before load) */
export const slowMs = Number((globalThis as { __wdSlowMs?: number }).__wdSlowMs ?? 0);
export function hostReturn(cpu: Cpu, ret: HostRet): void {
  if (ret === NORET) return;
  // AAPCS64 returns a 64-bit value in x0 alone; AAPCS32 splits it across r0/r1
  if (ret === VRET || ret === ARG0) { /* already in v0 / x0 */ }
  // a negative number is an error or count the caller may read as a 64-bit ssize_t/long: sign-extend it;
  // a pointer is a positive number, and an int result's upper half is unspecified either way
  else if (typeof ret === "number") { cpu.w[0] = ret | 0; cpu.w[1] = ret < 0 ? -1 : 0; }
  else if (typeof ret === "bigint") {
    cpu.w[0] = Number(ret & 0xffffffffn) | 0;
    const hi = Number((ret >> 32n) & 0xffffffffn) | 0;
    if (cpu.a64) cpu.w[1] = hi; else cpu.w[2] = hi;
  }
  cpu.setPc(cpu.lr);
}

/** AAPCS64 argument cursor: x0–x7 then the caller's stack in 8-byte slots. A 64-bit value is one
 *  register, not an even pair, and floating-point arguments arrive in v0–v7 — hard float, unlike
 *  the armeabi-v7a softfp ABI Args reads. */
export class Args64 extends Cursor {
  private cpu!: Cpu;
  private n = 0;      // next core register
  private nv = 0;     // next SIMD/FP register
  private sp = -1;    // next stack slot's buffer offset, translated from sp at the first stack argument
  constructor(cpu: Cpu) { super(); this.reset(cpu); }
  reset(cpu: Cpu): void { this.cpu = cpu; this.n = 0; this.nv = 0; this.sp = -1; }
  /** a thread stack can sit above plane 0 (bionic's pthread_create maps one anywhere) */
  private slot(): number {
    if (this.sp < 0) { const w = this.cpu.w; this.sp = w[63] ? mem.tx(w[63], w[62]) : w[62] >>> 0; }
    const at = this.sp; this.sp += 8; return at;
  }
  i(): number { return this.n < 8 ? this.cpu.w[2 * this.n++] : mem.ld32(this.slot()); }
  p(): number {
    let lo: number, hi: number;
    if (this.n < 8) { lo = this.cpu.w[2 * this.n]; hi = this.cpu.w[2 * this.n + 1]; this.n++; }
    else { const at = this.slot(); lo = mem.ld32(at); hi = mem.ld32(at + 4); }
    return hi ? mem.tx(hi, lo) : lo >>> 0;
  }
  va(): bigint { return this.ul(); }
  l(): bigint {
    if (this.n < 8) { const lo = this.cpu.w[2 * this.n], hi = this.cpu.w[2 * this.n + 1]; this.n++; return retPair(lo, hi); }
    return mem.ld64(this.slot());
  }
  f(): number { return this.nv < 8 ? this.cpu.s[this.nv++ * 4] : bitsf(mem.ld32(this.slot())); }
  d(): number { return this.nv < 8 ? this.cpu.d[this.nv++ * 2] : bitsd(mem.ld64(this.slot())); }
}

const strAddrs = new Map<string, number>();
/** an interned host-data C string: what a guest gets back from glGetString/eglQueryString */
export function cstr(s: string): number { let p = strAddrs.get(s); if (p === undefined) strAddrs.set(s, (p = mem.hostStr(s))); return p; }

// ── virtual host libraries: name → (symbol → trampoline/data address), defined lazily
const libs = new Map<string, Map<string, HostFn | number>>();
const addrs = new Map<string, number>();  // "lib!sym" → address
const closedLibs = new Set<string>();
/** names an image asked a closed library for and did not get ("lib!sym") */
export const probed = new Set<string>();
function libOf(lib: string): Map<string, HostFn | number> { let m = libs.get(lib); if (!m) libs.set(lib, (m = new Map())); return m; }
export function hostLib(lib: string, fnsIn: Record<string, HostFn>, opts?: { closed?: boolean }): void {
  const m = libOf(lib);
  for (const [k, v] of Object.entries(fnsIn)) m.set(k, v);
  if (opts?.closed) closedLibs.add(lib);
}
/** dlsym on a host library. A closed library answers NULL for a name it lacks, which is how an
 *  image feature-gates on a device; an open one (libc) mints a stub that reports itself when called. */
export function probeHost(sym: string, lib: string): number {
  const v = lookupHost(sym, lib);
  if (v !== undefined) return v;
  if (closedLibs.has(lib)) { probed.add(lib + "!" + sym); return 0; }
  return missingStub(lib + "!" + sym);
}
export function hostData(lib: string, sym: string, addr: number): void { libOf(lib).set(sym, addr); }
export function hostFn(lib: string, sym: string): HostFn | undefined { const v = libs.get(lib)?.get(sym); return typeof v === "function" ? v : undefined; }
export function hostLibNames(): string[] { return [...libs.keys()]; }
export function lookupHost(sym: string, lib?: string): number | undefined {
  for (const [ln, m] of libs) {
    if (lib !== undefined && ln !== lib) continue;
    const v = m.get(sym);
    if (v === undefined) continue;
    if (typeof v === "number") return v;
    const key = ln + "!" + sym;
    let a = addrs.get(key);
    if (a === undefined) addrs.set(key, (a = defineHost(sym, v)));
    return a;
  }
  return undefined;
}

// ── stubs for imports nothing provides: bound at link time (unresolved), reported when CALLED
export const unresolved = new Set<string>();
export const calledMissing = new Set<string>();
const stubs = new Map<string, number>();
export function missingStub(sym: string): number {
  let a = stubs.get(sym);
  if (a !== undefined) return a;
  unresolved.add(sym);
  a = defineHost("missing:" + sym, () => {
    if (!calledMissing.has(sym)) { calledMissing.add(sym); console.warn("[native missing]", sym); }
    return 0;
  });
  stubs.set(sym, a);
  return a;
}

export const isTrampPc = (pc: number) => pc >= TRAMP_BASE && pc < TRAMP_END;
