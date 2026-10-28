// zlib (built by scripts/generated.ts) in a Wasm module of its own, for java.util.zip's natives, the ARM32 libz,
// archive entries and checksums. A call copies its input into the module's memory and its output back, a window at a time.
import wasm from "./zlib.wasm.ts";

// scripts/generated.ts builds the module to export the functions this names
interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(n: number): number;
  free(p: number): void;
  zlibVersion(): number;
  zError(code: number): number;
  crc32(crc: number, p: number, n: number): number;
  adler32(adler: number, p: number, n: number): number;
  inflateInit2_(s: number, windowBits: number, version: number, size: number): number;
  inflate(s: number, flush: number): number;
  inflateEnd(s: number): number;
  inflateReset(s: number): number;
  inflateSetDictionary(s: number, d: number, n: number): number;
  deflateInit2_(s: number, level: number, method: number, windowBits: number, memLevel: number, strategy: number, version: number, size: number): number;
  deflate(s: number, flush: number): number;
  deflateEnd(s: number): number;
  deflateReset(s: number): number;
  deflateSetDictionary(s: number, d: number, n: number): number;
  deflateParams(s: number, level: number, strategy: number): number;
}
const z = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.fromBase64(wasm)), {}).exports as unknown as Exports;
z._initialize();

export const Z_OK = 0, Z_STREAM_END = 1, Z_NEED_DICT = 2, Z_STREAM_ERROR = -2, Z_DATA_ERROR = -3, Z_MEM_ERROR = -4, Z_BUF_ERROR = -5;
export const Z_NO_FLUSH = 0, Z_FINISH = 4, Z_BLOCK = 5;
/** z_stream's fields, laid out alike in wasm32 and ARM32 */
export const Z = { IN: 0, AVIN: 4, TIN: 8, OUT: 12, AVOUT: 16, TOUT: 20, MSG: 24, STATE: 28, DATA_TYPE: 44, ADLER: 48 };
/** what one zlib call returned, the bytes it consumed and those it produced */
export type Step = [code: number, read: number, written: number];
const STREAM_SIZE = 56, WINDOW = 1 << 17;
// input and output windows, allocated once
const inP = z.malloc(2 * WINDOW), outP = inP + WINDOW;
// views made per use, since any zlib call may grow the memory
const u8 = () => new Uint8Array(z.memory.buffer);
const u32 = () => new Uint32Array(z.memory.buffer);
const cstr = (p: number): string | null => {
  if (!p) return null;
  const m = u8();
  let s = "";
  for (; m[p]; p++) s += String.fromCharCode(m[p]);
  return s;
};
export const zlibVersion = (): string => cstr(z.zlibVersion())!;
export const zError = (code: number): string => cstr(z.zError(code)) ?? "";

/** `sum` updated over `b`, as Java's signed int */
function checksum(f: (sum: number, p: number, n: number) => number, sum: number, b: Uint8Array): number {
  for (let at = 0; at < b.length; at += 2 * WINDOW) {
    const part = b.subarray(at, at + 2 * WINDOW);
    u8().set(part, inP);
    sum = f(sum, inP, part.length);
  }
  return sum | 0;
}
export const crc32 = (crc: number, b: Uint8Array): number => checksum(z.crc32, crc, b);
export const adler32 = (adler: number, b: Uint8Array): number => checksum(z.adler32, adler, b);

/** what differs between inflating and deflating */
interface Direction {
  step(s: number, flush: number): number;
  setDictionary(s: number, d: number, n: number): number;
  reset(s: number): number;
  end(s: number): number;
  /** the most input a window holds for `output` bytes of room */
  inputCap(output: number): number;
  /** whether an unfinished Z_FINISH answers Z_BUF_ERROR */
  finishIsBufError: boolean;
}
// a caller often hands an inflater far more input than one call uses
const INFLATE: Direction = { step: z.inflate, setDictionary: z.inflateSetDictionary, reset: z.inflateReset, end: z.inflateEnd,
  inputCap: (output) => Math.min(WINDOW, Math.max(4096, output)), finishIsBufError: true };
const DEFLATE: Direction = { step: z.deflate, setDictionary: z.deflateSetDictionary, reset: z.deflateReset, end: z.deflateEnd,
  inputCap: () => WINDOW, finishIsBufError: false };

/** a z_stream and its state in the module's memory, until end() */
export class ZStream {
  private readonly dir: Direction;
  private p: number;
  private constructor(dir: Direction, p: number) { this.dir = dir; this.p = p; }
  /** inflateInit2's stream, or its error code */
  static inflater(windowBits: number): ZStream | number {
    return ZStream.open(INFLATE, (p) => z.inflateInit2_(p, windowBits, z.zlibVersion(), STREAM_SIZE));
  }
  /** deflateInit2's stream, or its error code */
  static deflater(level: number, method: number, windowBits: number, memLevel: number, strategy: number): ZStream | number {
    return ZStream.open(DEFLATE, (p) => z.deflateInit2_(p, level, method, windowBits, memLevel, strategy, z.zlibVersion(), STREAM_SIZE));
  }
  private static open(dir: Direction, init: (p: number) => number): ZStream | number {
    const p = z.malloc(STREAM_SIZE);
    u8().fill(0, p, p + STREAM_SIZE);
    const code = init(p);
    if (code === Z_OK) return new ZStream(dir, p);
    z.free(p);
    return code;
  }
  get deflating(): boolean { return this.dir === DEFLATE; }
  get msg(): string | null { return cstr(this.get(Z.MSG)); }
  get adler(): number { return this.get(Z.ADLER) | 0; }
  get(field: number): number { return u32()[(this.p + field) >>> 2]; }
  set(field: number, value: number): void { u32()[(this.p + field) >>> 2] = value; }

  /** inflate or deflate with `flush` from `input` into `output`, as one zlib call over them. It runs a window of each at a
   *  time, the input before the last window's without a flush, and stops where that one call would. */
  run(input: Uint8Array, output: Uint8Array, flush: number): Step {
    const cap = this.dir.inputCap(output.length);
    let read = 0, written = 0, code: number;
    for (;;) {
      const n = Math.min(cap, input.length - read), m = Math.min(WINDOW, output.length - written), last = read + n === input.length;
      const [c, r, w] = this.call((p) => this.dir.step(p, last ? flush : Z_NO_FLUSH), input.subarray(read, read + n), output.subarray(written, written + m));
      code = c; read += r; written += w;
      // Z_BLOCK and Z_TREES stop at a block boundary, which one call reaches
      if (code !== Z_OK && code !== Z_BUF_ERROR || !(r || w) || flush >= Z_BLOCK || written === output.length || w < m && read === input.length) break;
    }
    // only a call that made no progress at all answers Z_BUF_ERROR, and inflate also an unfinished Z_FINISH
    if (code === Z_BUF_ERROR && (read || written)) code = Z_OK;
    return [code === Z_OK && flush === Z_FINISH && this.dir.finishIsBufError ? Z_BUF_ERROR : code, read, written];
  }
  /** deflateParams over at most a window of each, once: a change of strategy or compression function first deflates the
   *  input with Z_BLOCK */
  params(level: number, strategy: number, input: Uint8Array, output: Uint8Array): Step {
    return this.call((p) => z.deflateParams(p, level, strategy), input.subarray(0, WINDOW), output.subarray(0, WINDOW));
  }
  private call(op: (p: number) => number, input: Uint8Array, output: Uint8Array): Step {
    const s = this.p >>> 2;
    let m = u32();
    new Uint8Array(m.buffer).set(input, inP);
    m[s + (Z.IN >> 2)] = inP; m[s + (Z.AVIN >> 2)] = input.length; m[s + (Z.OUT >> 2)] = outP; m[s + (Z.AVOUT >> 2)] = output.length;
    const code = op(this.p);
    m = u32();
    const read = input.length - m[s + (Z.AVIN >> 2)], written = output.length - m[s + (Z.AVOUT >> 2)];
    output.set(new Uint8Array(m.buffer, outP, written));
    return [code, read, written];
  }
  setDictionary(d: Uint8Array): number {
    const p = d.length > 2 * WINDOW ? z.malloc(d.length) : inP;
    u8().set(d, p);
    const code = this.dir.setDictionary(this.p, p, d.length);
    if (p !== inP) z.free(p);
    return code;
  }
  reset(): number { return this.dir.reset(this.p); }
  end(): number {
    const code = this.dir.end(this.p);
    z.free(this.p);
    this.p = 0;
    return code;
  }
}

/** a whole zlib (`windowBits` 15) or raw deflate (-15) stream of `size` bytes inflated */
export function inflate(data: Uint8Array, size: number, windowBits: number): Uint8Array {
  const s = ZStream.inflater(windowBits);
  if (typeof s === "number") throw new Error(`inflate: ${zError(s)}`);
  const out = new Uint8Array(size), [code, , written] = s.run(data, out, Z_FINISH), msg = s.msg;
  s.end();
  if (code !== Z_STREAM_END) throw new Error(`inflate: ${msg ?? zError(code)}`);
  return written === size ? out : out.subarray(0, written);
}
