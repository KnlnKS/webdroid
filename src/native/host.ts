// Host-call plumbing: trampoline slots dispatched by PC, the AAPCS argument cursor, return
// writers, virtual host libraries, and the logging stubs unresolved imports bind to.

import type { Cpu } from "./cpu";

export const NORET: unique symbol = Symbol("noret");
export type HostRet = number | bigint | void | typeof NORET;
export type HostFn = (cpu: Cpu, a: Args) => HostRet | Promise<HostRet>;

export interface ArgReader {
  i(): number; u(): number; p(): number; l(): bigint; ul(): bigint; f(): number; d(): number; vd(): number; str(): string;
}

export class Args implements ArgReader {
  constructor(_cpu: Cpu) {}
  reset(_cpu: Cpu): void { throw new Error("TODO Args.reset"); }
  i(): number { throw new Error("TODO Args.i"); }
  u(): number { throw new Error("TODO Args.u"); }
  p(): number { throw new Error("TODO Args.p"); }
  l(): bigint { throw new Error("TODO Args.l"); }
  ul(): bigint { throw new Error("TODO Args.ul"); }
  f(): number { throw new Error("TODO Args.f"); }
  d(): number { throw new Error("TODO Args.d"); }
  vd(): number { throw new Error("TODO Args.vd"); }
  str(): string { throw new Error("TODO Args.str"); }
  vaList(): number { throw new Error("TODO Args.vaList"); }
}

export class VaList implements ArgReader {
  constructor(_addr: number) {}
  i(): number { throw new Error("TODO VaList.i"); }
  u(): number { throw new Error("TODO VaList.u"); }
  p(): number { throw new Error("TODO VaList.p"); }
  l(): bigint { throw new Error("TODO VaList.l"); }
  ul(): bigint { throw new Error("TODO VaList.ul"); }
  f(): number { throw new Error("TODO VaList.f"); }
  d(): number { throw new Error("TODO VaList.d"); }
  vd(): number { throw new Error("TODO VaList.vd"); }
  str(): string { throw new Error("TODO VaList.str"); }
}

export function defineHost(_name: string, _fn: HostFn): number { throw new Error("TODO defineHost"); }
export function hostLib(_lib: string, _fns: Record<string, HostFn>): void { throw new Error("TODO hostLib"); }
export function hostData(_lib: string, _sym: string, _addr: number): void { throw new Error("TODO hostData"); }
export function lookupHost(_sym: string, _lib?: string): number | undefined { throw new Error("TODO lookupHost"); }
export function hostLibNames(): string[] { throw new Error("TODO hostLibNames"); }
export function missingStub(_sym: string): number { throw new Error("TODO missingStub"); }
export const unresolved = new Set<string>();
export const calledMissing = new Set<string>();
export function hostDispatch(_cpu: Cpu, _slot: number): void { throw new Error("TODO hostDispatch"); }
export const hostTrace = { on: false, ring: [] as string[], max: 256, filter: null as RegExp | null };
export function fbits(_x: number): number { throw new Error("TODO fbits"); }
export function bitsf(_i: number): number { throw new Error("TODO bitsf"); }
export function dbits(_x: number): bigint { throw new Error("TODO dbits"); }
export function bitsd(_l: bigint): number { throw new Error("TODO bitsd"); }
export function retPair(_lo: number, _hi: number): bigint { throw new Error("TODO retPair"); }
export function slotName(_slot: number): string { throw new Error("TODO slotName"); }
