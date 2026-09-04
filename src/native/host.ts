// Host-call plumbing: trampoline slots dispatched by PC, the AAPCS argument cursor, return
// writers, virtual host libraries, and the logging stubs unresolved imports bind to.

import type { Cpu } from "./cpu";
import { mem } from "./mem";
import { trampAddr, TRAMP_BASE, TRAMP_END } from "./abi";
import { perf } from "../perf";

export const NORET: unique symbol = Symbol("noret");
/** the result is already in v0 (see retF/retD); only the return itself is left to do */
export const VRET: unique symbol = Symbol("vret");
export type HostRet = number | bigint | void | typeof NORET | typeof VRET;
export type HostFn = (cpu: Cpu, a: ArgReader) => HostRet | Promise<HostRet>;

export interface ArgReader {
  i(): number; u(): number; p(): number; l(): bigint; ul(): bigint; f(): number; d(): number; vd(): number; str(): string;
  strAt(p: number): string;
}

const scratch = new DataView(new ArrayBuffer(8));
export function fbits(x: number): number { scratch.setFloat32(0, x, true); return scratch.getInt32(0, true); }
export function bitsf(i: number): number { scratch.setInt32(0, i, true); return scratch.getFloat32(0, true); }
export function dbits(x: number): bigint { scratch.setFloat64(0, x, true); return scratch.getBigInt64(0, true); }
export function bitsd(l: bigint): number { scratch.setBigInt64(0, l, true); return scratch.getFloat64(0, true); }
export function retPair(lo: number, hi: number): bigint { return (BigInt(hi | 0) << 32n) | BigInt(lo >>> 0); }
/** return a float / double from a host function: s0/d0 on AAPCS64, the bits in r0(/r1) on softfp */
export function retF(cpu: Cpu, x: number): HostRet { if (cpu.a64) { cpu.s[0] = x; return VRET; } return fbits(x); }
export function retD(cpu: Cpu, x: number): HostRet { if (cpu.a64) { cpu.d[0] = x; return VRET; } return dbits(x); }

/** AAPCS argument cursor: r0–r3, then the caller's stack; 64-bit values on even registers / 8-byte stack slots */
export class Args implements ArgReader {
  private cpu!: Cpu;
  private n = 0;      // next core register
  private sp = 0;     // next stack slot
  constructor(cpu: Cpu) { this.reset(cpu); }
  reset(cpu: Cpu): void { this.cpu = cpu; this.n = 0; this.sp = cpu.r[13]; }
  i(): number {
    if (this.n < 4) return this.cpu.r[this.n++];
    const v = mem.ld32(this.sp); this.sp += 4; return v;
  }
  u(): number { return this.i() >>> 0; }
  p(): number { return this.i() >>> 0; }
  l(): bigint {
    if (this.n & 1) this.n++;
    if (this.n < 4) { const lo = this.cpu.r[this.n], hi = this.cpu.r[this.n + 1]; this.n += 2; return retPair(lo, hi); }
    this.n = 4;
    this.sp = (this.sp + 7) & ~7;
    const v = mem.ld64(this.sp); this.sp += 8; return v;
  }
  ul(): bigint { return BigInt.asUintN(64, this.l()); }
  f(): number { return bitsf(this.i()); }
  d(): number { return bitsd(this.l()); }
  vd(): number { return this.d(); }
  str(): string { return mem.cstr(this.p()); }
  strAt(p: number): string { return mem.cstr(p); }
}

/** the ILP32 va_list: a flat cursor over the caller's stack */
export class VaList implements ArgReader {
  constructor(private a: number) {}
  i(): number { const v = mem.ld32(this.a); this.a += 4; return v; }
  u(): number { return this.i() >>> 0; }
  p(): number { return this.i() >>> 0; }
  l(): bigint { this.a = (this.a + 7) & ~7; const v = mem.ld64(this.a); this.a += 8; return v; }
  ul(): bigint { return BigInt.asUintN(64, this.l()); }
  f(): number { return bitsf(this.i()); }
  d(): number { return bitsd(this.l()); }
  vd(): number { return this.d(); }
  str(): string { return mem.cstr(this.p()); }
  strAt(p: number): string { return mem.cstr(p); }
  get addr(): number { return this.a; }
}

/** AAPCS64's va_list is a struct: {__stack, __gr_top, __vr_top, __gr_offs, __vr_offs}. A general
 *  argument comes from the register save area at gr_top + gr_offs while gr_offs is negative, then
 *  from 8-byte stack slots; an FP one likewise from 16-byte slots at vr_top + vr_offs. The offsets
 *  are kept here, not written back: no caller reuses the list after a v*printf or Call*MethodV. */
export class VaList64 implements ArgReader {
  private stack: number; private grTop: number; private vrTop: number; private grOffs: number; private vrOffs: number;
  constructor(a: number) { this.stack = ldp(a); this.grTop = ldp(a + 8); this.vrTop = ldp(a + 16); this.grOffs = mem.ld32(a + 24); this.vrOffs = mem.ld32(a + 32); }
  private slot(): number { const p = (this.stack + 7) & ~7; this.stack = p + 8; return p; }
  private gp(): number {
    if (this.grOffs >= 0) return this.slot();
    const p = this.grTop + this.grOffs;
    this.grOffs += 8;
    return this.grOffs > 0 ? this.slot() : p;
  }
  private fp(): number {
    if (this.vrOffs >= 0) return this.slot();
    const p = this.vrTop + this.vrOffs;
    this.vrOffs += 16;
    return this.vrOffs > 0 ? this.slot() : p;
  }
  i(): number { return mem.ld32(this.gp()); }
  u(): number { return this.i() >>> 0; }
  p(): number { return ldp(this.gp()); }
  l(): bigint { return mem.ld64(this.gp()); }
  ul(): bigint { return BigInt.asUintN(64, this.l()); }
  f(): number { return this.d(); }   // a float vararg is promoted to double
  d(): number { return mem.ldf64(this.fp()); }
  vd(): number { return this.d(); }
  str(): string { return mem.cstr(this.p()); }
  strAt(p: number): string { return mem.cstr(p); }
}
/** the va_list the process ABI defines, over the guest pointer `a` */
export function vaList(a: number): ArgReader { return PTR === 8 ? new VaList64(a) : new VaList(a); }

/** The guest's pointer width: 8 for LP64 (arm64), 4 for ILP32 (arm). Set with the process ABI
 *  by Cpu.setAbi, and read by everything that lays out a struct or a function table for the
 *  guest — a JNIEnv vtable, a JNINativeMethod record, an out-parameter holding a pointer. */
export let PTR = 4;
export function setPtrWidth(n: number): void { PTR = n; }
/** store a guest pointer; the high half of an LP64 slot is always zero in this address space */
export function stp(a: number, v: number): void { mem.st32(a, v); if (PTR === 8) mem.st32(a + 4, 0); }
/** load a guest pointer */
export function ldp(a: number): number { return mem.ld32(a) >>> 0; }

const fns: HostFn[] = [];
const names: string[] = [];
export function defineHost(name: string, fn: HostFn): number {
  const slot = fns.length;
  if (trampAddr(slot) >= TRAMP_END) throw new Error("out of trampoline slots");
  fns.push(fn); names.push(name);
  // `bx lr` at the slot so a guest that reads its own code (or a disassembler) sees something sane
  mem.u32[trampAddr(slot) >>> 2] = 0xe12fff1e;
  return trampAddr(slot);
}
export function slotName(slot: number): string { return names[slot] ?? `slot${slot}`; }
const STR0 = new Set(["fopen", "open", "access", "stat", "lstat", "mkdir", "opendir", "getenv", "unlink", "rename", "remove", "rmdir", "dlopen", "strlen", "strcmp", "strncmp", "strcpy", "strncpy", "strstr", "strchr", "atoi", "strtol", "strdup", "sprintf", "snprintf", "puts", "printf"]);
export const hostTrace = { on: false, ring: [] as string[], max: 256, filter: null as RegExp | null };

/** dispatch a host call at trampoline `slot`; a returned promise parks the Cpu (see Cpu.runSlice) */
export function hostDispatch(cpu: Cpu, slot: number): void {
  const fn = fns[slot];
  if (!fn) cpu.fault(`call to undefined trampoline slot ${slot}`);
  perf.nativeHostCalls++;
  const a = cpu.args;
  a.reset(cpu);
  if (hostTrace.on) {
    const nm = names[slot];
    if (!hostTrace.filter || hostTrace.filter.test(nm)) {
      const r = cpu.r;
      let s0 = "";
      if (STR0.has(nm) && r[0]) { try { s0 = ` "${mem.cstr(r[0] >>> 0, 120)}"`; } catch { s0 = " <bad ptr>"; } }
      hostTrace.ring.push(`${nm}(${(r[0] >>> 0).toString(16)},${(r[1] >>> 0).toString(16)},${(r[2] >>> 0).toString(16)},${(r[3] >>> 0).toString(16)})${s0} lr=${(r[14] >>> 0).toString(16)}`);
      if (hostTrace.ring.length > hostTrace.max) hostTrace.ring.splice(0, hostTrace.ring.length - hostTrace.max);
    }
  }
  const ret = fn(cpu, a);
  if (ret instanceof Promise) { cpu.pending = ret; return; }
  hostReturn(cpu, ret);
}

export function hostReturn(cpu: Cpu, ret: HostRet): void {
  if (ret === NORET) return;
  // AAPCS64 returns a 64-bit value in x0 alone; AAPCS32 splits it across r0/r1
  if (ret === VRET) { /* already in v0 */ }
  else if (typeof ret === "number") { cpu.r[0] = ret | 0; if (cpu.a64) cpu.h[0] = 0; }
  else if (typeof ret === "bigint") {
    cpu.r[0] = Number(ret & 0xffffffffn) | 0;
    const hi = Number((ret >> 32n) & 0xffffffffn) | 0;
    if (cpu.a64) cpu.h[0] = hi; else cpu.r[1] = hi;
  }
  cpu.setPc(cpu.r[cpu.lrx]);
}

/** AAPCS64 argument cursor: x0–x7 then the caller's stack in 8-byte slots. A 64-bit value is one
 *  register, not an even pair, and floating-point arguments arrive in v0–v7 — hard float, unlike
 *  the armeabi-v7a softfp ABI Args reads. */
export class Args64 implements ArgReader {
  private cpu!: Cpu;
  private n = 0;      // next core register
  private nv = 0;     // next SIMD/FP register
  private sp = 0;     // next stack slot
  constructor(cpu: Cpu) { this.reset(cpu); }
  reset(cpu: Cpu): void { this.cpu = cpu; this.n = 0; this.nv = 0; this.sp = cpu.r[31] >>> 0; }
  i(): number {
    if (this.n < 8) return this.cpu.r[this.n++];
    const v = mem.ld32(this.sp); this.sp += 8; return v;
  }
  u(): number { return this.i() >>> 0; }
  p(): number { return this.i() >>> 0; }
  l(): bigint {
    if (this.n < 8) { const lo = this.cpu.r[this.n], hi = this.cpu.h[this.n]; this.n++; return retPair(lo, hi); }
    const v = mem.ld64(this.sp); this.sp += 8; return v;
  }
  ul(): bigint { return BigInt.asUintN(64, this.l()); }
  f(): number { if (this.nv < 8) return this.cpu.s[this.nv++ * 4]; const v = mem.ld32(this.sp); this.sp += 8; return bitsf(v); }
  d(): number { if (this.nv < 8) return this.cpu.d[this.nv++ * 2]; const v = mem.ld64(this.sp); this.sp += 8; return bitsd(v); }
  vd(): number { return this.d(); }
  str(): string { return mem.cstr(this.p()); }
  strAt(p: number): string { return mem.cstr(p); }
}

// ── virtual host libraries: name → (symbol → trampoline/data address), defined lazily
const libs = new Map<string, Map<string, HostFn | number>>();
const addrs = new Map<string, number>();  // "lib!sym" → address
export function hostLib(lib: string, fnsIn: Record<string, HostFn>): void {
  let m = libs.get(lib);
  if (!m) libs.set(lib, (m = new Map()));
  for (const [k, v] of Object.entries(fnsIn)) m.set(k, v);
}
export function hostData(lib: string, sym: string, addr: number): void {
  let m = libs.get(lib);
  if (!m) libs.set(lib, (m = new Map()));
  m.set(sym, addr);
}
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
