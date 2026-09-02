// Guest memory: one 256 MiB ArrayBuffer with typed views, a malloc arena, module/stack/host-data
// regions, and the code-page flags that let a store into executable pages invalidate the decoder.
// See abi.ts for the address map.

import { MEM_SIZE, PAGE_SHIFT } from "./abi";

export class NativeFault extends Error {
  pc = 0;
  ring: number[] = [];
}

const buf = new ArrayBuffer(MEM_SIZE);

export const mem = {
  buf,
  u8: new Uint8Array(buf), i8: new Int8Array(buf), u16: new Uint16Array(buf), i16: new Int16Array(buf),
  u32: new Uint32Array(buf), i32: new Int32Array(buf), f32: new Float32Array(buf), f64: new Float64Array(buf),
  dv: new DataView(buf),
  codePages: new Uint8Array(MEM_SIZE >> PAGE_SHIFT),
  onCodeWrite: (_addr: number): void => {},

  ld32(_a: number): number { throw new Error("TODO mem.ld32"); },
  ld32u(_a: number): number { throw new Error("TODO mem.ld32u"); },
  ld16u(_a: number): number { throw new Error("TODO mem.ld16u"); },
  ld16s(_a: number): number { throw new Error("TODO mem.ld16s"); },
  ld8u(_a: number): number { throw new Error("TODO mem.ld8u"); },
  ld8s(_a: number): number { throw new Error("TODO mem.ld8s"); },
  st32(_a: number, _v: number): void { throw new Error("TODO mem.st32"); },
  st16(_a: number, _v: number): void { throw new Error("TODO mem.st16"); },
  st8(_a: number, _v: number): void { throw new Error("TODO mem.st8"); },
  ldf32(_a: number): number { throw new Error("TODO mem.ldf32"); },
  stf32(_a: number, _v: number): void { throw new Error("TODO mem.stf32"); },
  ldf64(_a: number): number { throw new Error("TODO mem.ldf64"); },
  stf64(_a: number, _v: number): void { throw new Error("TODO mem.stf64"); },
  ld64(_a: number): bigint { throw new Error("TODO mem.ld64"); },
  st64(_a: number, _v: bigint): void { throw new Error("TODO mem.st64"); },

  malloc(_n: number): number { throw new Error("TODO mem.malloc"); },
  free(_p: number): void { throw new Error("TODO mem.free"); },
  realloc(_p: number, _n: number): number { throw new Error("TODO mem.realloc"); },
  calloc(_n: number, _m: number): number { throw new Error("TODO mem.calloc"); },
  memalign(_align: number, _n: number): number { throw new Error("TODO mem.memalign"); },
  valloc(_n: number): number { throw new Error("TODO mem.valloc"); },
  usableSize(_p: number): number { throw new Error("TODO mem.usableSize"); },
  reserve(_size: number, _align = 0x10000): number { throw new Error("TODO mem.reserve"); },
  allocStack(_size: number): { base: number; top: number } { throw new Error("TODO mem.allocStack"); },
  hostAlloc(_n: number, _align = 8): number { throw new Error("TODO mem.hostAlloc"); },

  cstr(_a: number, _max?: number): string { throw new Error("TODO mem.cstr"); },
  putCstr(_a: number, _s: string, _max?: number): number { throw new Error("TODO mem.putCstr"); },
  strlen(_a: number): number { throw new Error("TODO mem.strlen"); },
  bytes(_a: number, _n: number): Uint8Array { throw new Error("TODO mem.bytes"); },
  write(_a: number, _src: Uint8Array | ArrayLike<number>): void { throw new Error("TODO mem.write"); },
  memcpy(_d: number, _s: number, _n: number): void { throw new Error("TODO mem.memcpy"); },
  memmove(_d: number, _s: number, _n: number): void { throw new Error("TODO mem.memmove"); },
  memset(_d: number, _v: number, _n: number): void { throw new Error("TODO mem.memset"); },
  strdup(_s: string): number { throw new Error("TODO mem.strdup"); },
  hostStr(_s: string): number { throw new Error("TODO mem.hostStr"); },
  stats(): { used: number; blocks: number; peak: number } { throw new Error("TODO mem.stats"); },
};

export function checkAddr(_a: number, _n: number): void { throw new Error("TODO checkAddr"); }
