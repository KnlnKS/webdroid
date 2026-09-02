// Guest memory: one 256 MiB ArrayBuffer with typed views, a malloc arena, module/stack/host-data
// regions, and the code-page flags that let a store into executable pages invalidate the decoder.
// See abi.ts for the address map.

import { MEM_SIZE, PAGE_SHIFT, PAGE_SIZE, MODULE_BASE, STACK_BASE, STACK_END, HEAP_BASE, HEAP_END, HOST_DATA, HOST_DATA_END, STACK_GUARD } from "./abi";

export class NativeFault extends Error {
  pc = 0;
  ring: number[] = [];
}

const buf = new ArrayBuffer(MEM_SIZE);
const u8 = new Uint8Array(buf), i8 = new Int8Array(buf), u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
const u32 = new Uint32Array(buf), i32 = new Int32Array(buf), f32 = new Float32Array(buf), f64 = new Float64Array(buf);
const dv = new DataView(buf);
const codePages = new Uint8Array(MEM_SIZE >> PAGE_SHIFT);
// the first 64 KiB is never mapped: a null-ish pointer faults instead of reading zeros
const LOW = 0x10000, SPAN = MEM_SIZE - LOW;
const enc = new TextEncoder(), dec = new TextDecoder();

export function checkAddr(a: number, n: number): void {
  if (((a >>> 0) - LOW) >>> 0 > SPAN - n) badAddr(a);
}
function badAddr(a: number): never {
  const e = new NativeFault(`[native] bad address 0x${(a >>> 0).toString(16)}`);
  throw e;
}

// ── malloc arena: 16-byte size classes to 1 KiB, then powers of two; header = 8 bytes before the
// block ([p-8] = owning block for aligned allocations or 0, [p-4] = class size). Large blocks
// (> 1 MiB) get their own free list keyed on exact size.
const CLASS_STEP = 16, SMALL_MAX = 1024;
const smallHeads = new Int32Array(SMALL_MAX / CLASS_STEP + 1);
const bigHeads = new Map<number, number>();
let heapTop = HEAP_BASE, heapPeak = 0, blocks = 0, used = 0;
function classSize(n: number): number {
  if (n <= SMALL_MAX) return Math.max(CLASS_STEP, (n + CLASS_STEP - 1) & ~(CLASS_STEP - 1));
  let s = 2048;
  while (s < n) s <<= 1;
  return s;
}

let moduleTop = MODULE_BASE, stackTop = STACK_BASE, hostTop = HOST_DATA;

export const mem = {
  buf, u8, i8, u16, i16, u32, i32, f32, f64, dv, codePages,
  onCodeWrite: (_addr: number): void => {},

  ld32(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); return (a & 3) === 0 ? i32[a >>> 2] : dv.getInt32(a >>> 0, true); },
  ld32u(a: number): number { return mem.ld32(a) >>> 0; },
  ld16u(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 2) badAddr(a); return (a & 1) === 0 ? u16[a >>> 1] : dv.getUint16(a >>> 0, true); },
  ld16s(a: number): number { return (mem.ld16u(a) << 16) >> 16; },
  ld8u(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a); return u8[a >>> 0]; },
  ld8s(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a); return i8[a >>> 0]; },
  st32(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a);
    if ((a & 3) === 0) i32[a >>> 2] = v; else dv.setInt32(a >>> 0, v, true);
    if (codePages[a >>> PAGE_SHIFT]) mem.onCodeWrite(a);
  },
  st16(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 2) badAddr(a);
    if ((a & 1) === 0) u16[a >>> 1] = v; else dv.setUint16(a >>> 0, v, true);
    if (codePages[a >>> PAGE_SHIFT]) mem.onCodeWrite(a);
  },
  st8(a: number, v: number): void {
    if (((a >>> 0) - LOW) >>> 0 > SPAN - 1) badAddr(a);
    u8[a >>> 0] = v;
    if (codePages[a >>> PAGE_SHIFT]) mem.onCodeWrite(a);
  },
  ldf32(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); return (a & 3) === 0 ? f32[a >>> 2] : dv.getFloat32(a >>> 0, true); },
  stf32(a: number, v: number): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 4) badAddr(a); if ((a & 3) === 0) f32[a >>> 2] = v; else dv.setFloat32(a >>> 0, v, true); },
  ldf64(a: number): number { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); return (a & 7) === 0 ? f64[a >>> 3] : dv.getFloat64(a >>> 0, true); },
  stf64(a: number, v: number): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); if ((a & 7) === 0) f64[a >>> 3] = v; else dv.setFloat64(a >>> 0, v, true); },
  ld64(a: number): bigint { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); return dv.getBigInt64(a >>> 0, true); },
  st64(a: number, v: bigint): void { if (((a >>> 0) - LOW) >>> 0 > SPAN - 8) badAddr(a); dv.setBigInt64(a >>> 0, v, true); },

  malloc(n: number): number {
    n = n >>> 0;
    if (n > 0x4000000) return 0;
    const cs = classSize(n);
    let p: number;
    if (cs <= SMALL_MAX) {
      const ci = cs / CLASS_STEP;
      p = smallHeads[ci];
      if (p) smallHeads[ci] = i32[p >>> 2];
    } else {
      p = bigHeads.get(cs) ?? 0;
      if (p) bigHeads.set(cs, i32[p >>> 2]);
    }
    if (!p) {
      p = heapTop + 8;
      heapTop = p + cs;
      if (heapTop > HEAP_END) { heapTop = p - 8; return 0; }
      if (heapTop > heapPeak) heapPeak = heapTop;
    }
    i32[(p - 8) >>> 2] = 0;
    i32[(p - 4) >>> 2] = cs;
    blocks++; used += cs;
    return p;
  },
  free(p: number): void {
    if (!p) return;
    const owner = i32[(p - 8) >>> 2];
    if (owner) p = owner;
    const cs = i32[(p - 4) >>> 2];
    if (cs <= 0 || (cs & 15)) badAddr(p);
    blocks--; used -= cs;
    if (cs <= SMALL_MAX) { i32[p >>> 2] = smallHeads[cs / CLASS_STEP]; smallHeads[cs / CLASS_STEP] = p; }
    else { i32[p >>> 2] = bigHeads.get(cs) ?? 0; bigHeads.set(cs, p); }
  },
  realloc(p: number, n: number): number {
    if (!p) return mem.malloc(n);
    if (n === 0) { mem.free(p); return 0; }
    const cur = mem.usableSize(p);
    if (n <= cur && n >= cur >> 2) return p;
    const q = mem.malloc(n);
    if (!q) return 0;
    u8.copyWithin(q, p, p + Math.min(n, cur));
    mem.free(p);
    return q;
  },
  calloc(n: number, m: number): number {
    const p = mem.malloc(n * m);
    if (p) u8.fill(0, p, p + n * m);
    return p;
  },
  memalign(align: number, n: number): number {
    if (align <= 8) return mem.malloc(n);
    const raw = mem.malloc(n + align + 8);
    if (!raw) return 0;
    const p = (raw + 8 + align - 1) & -align;
    i32[(p - 8) >>> 2] = raw;
    i32[(p - 4) >>> 2] = n;
    return p;
  },
  valloc(n: number): number { return mem.memalign(PAGE_SIZE, n); },
  usableSize(p: number): number {
    if (!p) return 0;
    const owner = i32[(p - 8) >>> 2];
    return owner ? i32[(p - 4) >>> 2] : i32[(p - 4) >>> 2];
  },
  /** address space for a module image: never freed, 64 KiB aligned by default */
  reserve(size: number, align = 0x10000): number {
    const base = (moduleTop + align - 1) & -align;
    moduleTop = base + size;
    if (moduleTop > STACK_BASE) throw new NativeFault("[native] out of module address space");
    return base;
  },
  allocStack(size: number): { base: number; top: number } {
    const base = stackTop + STACK_GUARD;
    const top = base + size;
    stackTop = top;
    if (top > STACK_END) throw new NativeFault("[native] out of stack address space");
    return { base, top };
  },
  /** host-owned guest data (FILE structs, JNI tables, ctype tables, static strings): bump only */
  hostAlloc(n: number, align = 8): number {
    const p = (hostTop + align - 1) & -align;
    hostTop = p + n;
    if (hostTop > HOST_DATA_END) throw new NativeFault("[native] out of host data space");
    return p;
  },

  cstr(a: number, max = 0x100000): string {
    if (!a) return "";
    checkAddr(a, 1);
    let e = a >>> 0;
    const lim = Math.min(e + max, MEM_SIZE);
    while (e < lim && u8[e] !== 0) e++;
    return dec.decode(u8.subarray(a >>> 0, e));
  },
  /** writes s + NUL (truncating to max-1 bytes when max is given); returns bytes written excluding NUL */
  putCstr(a: number, s: string, max = 0x7fffffff): number {
    const b = enc.encode(s);
    const n = Math.min(b.length, max - 1);
    if (n < 0) return 0;
    checkAddr(a, n + 1);
    u8.set(b.subarray(0, n), a >>> 0);
    u8[(a >>> 0) + n] = 0;
    return n;
  },
  strlen(a: number): number {
    checkAddr(a, 1);
    let e = a >>> 0;
    while (u8[e] !== 0) e++;
    return e - (a >>> 0);
  },
  bytes(a: number, n: number): Uint8Array { checkAddr(a, n); return u8.subarray(a >>> 0, (a >>> 0) + n); },
  write(a: number, src: Uint8Array | ArrayLike<number>): void { checkAddr(a, src.length); u8.set(src, a >>> 0); },
  memcpy(d: number, s: number, n: number): void { if (n <= 0) return; checkAddr(d, n); checkAddr(s, n); u8.copyWithin(d >>> 0, s >>> 0, (s >>> 0) + n); },
  memmove(d: number, s: number, n: number): void { mem.memcpy(d, s, n); },
  memset(d: number, v: number, n: number): void { if (n <= 0) return; checkAddr(d, n); u8.fill(v & 0xff, d >>> 0, (d >>> 0) + n); },
  strdup(s: string): number {
    const b = enc.encode(s);
    const p = mem.malloc(b.length + 1);
    u8.set(b, p); u8[p + b.length] = 0;
    return p;
  },
  /** a static string in host data (never freed) */
  hostStr(s: string): number {
    const b = enc.encode(s);
    const p = mem.hostAlloc(b.length + 1, 1);
    u8.set(b, p); u8[p + b.length] = 0;
    return p;
  },
  stats(): { used: number; blocks: number; peak: number } { return { used, blocks, peak: heapPeak - HEAP_BASE }; },
};
