// The cold tier. Most of the code an app runs at load runs once; compiling each block of it to
// a JS function costs more than running it and fills V8's bounded code space for the whole run.
// So a block is interpreted until it has run coldTier.heat times: control flow and pc-relative
// instructions are decoded here, every other word runs through the emitter's own code for it,
// with operand literals supplied by a descriptor so instruction words from one family share a
// compiled handler. Semantics are the emitter's; only the dispatch differs.

import { emitA64Word } from "./a64";
import type { Cpu } from "./cpu";
import type { mem as Mem } from "./mem";

type Operand = number | bigint;
type WordFn = (c: Cpu, r: Int32Array, M: typeof Mem, H: Int32Array, operands: Operand[]) => void;
interface Word { kind: number; fn: WordFn | null; operands: Operand[] }
const words = new Map<number, Word>(), handlers = new Map<string, WordFn>();
export const coldStats = { words: 0, handlers: 0, instr: 0 };
const K_B = 1, K_BCOND = 2, K_CBZ = 3, K_TBZ = 4, K_ADR = 5, K_LDRLIT = 6, K_BR = 7, K_SVC = 8;
const NO_OPERANDS: Operand[] = [];
function classify(w: number): number {
  if (is(w, 0x7c000000, 0x14000000)) return K_B;
  if (is(w, 0xff000010, 0x54000000)) return K_BCOND;
  if (is(w, 0x7e000000, 0x34000000)) return K_CBZ;
  if (is(w, 0x7e000000, 0x36000000)) return K_TBZ;
  if (is(w, 0x1f000000, 0x10000000)) return K_ADR;
  if (is(w, 0x3b000000, 0x18000000)) return K_LDRLIT;
  if (is(w, 0xff9ffc1f, 0xd61f0000)) return K_BR;
  if (is(w, 0xffe0001f, 0xd4000001)) return K_SVC;
  return 0;
}
function wordFn(w: number): Word {
  let record = words.get(w);
  if (record) return record;
  const kind = classify(w);
  if (kind) record = { kind, fn: null, operands: NO_OPERANDS };
  else {
    const { src, operands } = emitA64Word(w);
    let fn = handlers.get(src);
    if (!fn) {
      fn = new Function("c", "r", "M", "H", "o", src) as WordFn;
      handlers.set(src, fn);
      coldStats.handlers++;
    }
    record = { kind: 0, fn, operands };
  }
  words.set(w, record);
  coldStats.words++;
  return record;
}
const sx = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);
const is = (word: number, mask: number, value: number) => ((word & mask) >>> 0) === value;
function holds(c: Cpu, cc: number): boolean {
  let r: boolean;
  switch (cc >> 1) {
    case 0: r = c.z === 1; break; case 1: r = c.c === 1; break; case 2: r = c.n === 1; break; case 3: r = c.v === 1; break;
    case 4: r = c.c === 1 && c.z === 0; break; case 5: r = c.n === c.v; break; case 6: r = c.z === 0 && c.n === c.v; break;
    default: return true;                                                       // AL and NV
  }
  return (cc & 1) ? !r : r;
}

/** run from r[32] to the first control transfer (or 256 instructions) and return the next pc */
export function coldRun(c: Cpu, r: Int32Array, M: typeof Mem, H: Int32Array): number {
  // Keep high addresses signed while walking; memory and look() normalize at their boundaries.
  let pc = r[32] | 0;
  for (let n = 0; n < 256; n++) {
    const w = M.ld32(pc);
    c.ic++; coldStats.instr++;
    const record = wordFn(w);
    switch (record.kind) {
      case 0:
        c.bpc = pc;                                                            // a fault names where
        record.fn!(c, r, M, H, record.operands);
        pc = (pc + 4) | 0;
        continue;
      case K_B:                                                                // B / BL
        if (w < 0) { r[30] = (pc + 4) | 0; H[30] = 0; }
        return (pc + sx(w & 0x3ffffff, 26) * 4) | 0;
      case K_BCOND:                                                            // B.cond
        if (holds(c, w & 15)) return (pc + sx((w >>> 5) & 0x7ffff, 19) * 4) | 0;
        pc = (pc + 4) | 0; continue;
      case K_CBZ: {                                                            // CBZ / CBNZ
        const rt = w & 31, zero = rt === 31 ? true : w < 0 ? (r[rt] | H[rt]) === 0 : r[rt] === 0;
        if (zero !== !!((w >>> 24) & 1)) return (pc + sx((w >>> 5) & 0x7ffff, 19) * 4) | 0;
        pc = (pc + 4) | 0; continue;
      }
      case K_TBZ: {                                                            // TBZ / TBNZ
        const rt = w & 31, bit = ((w >>> 31) << 5) | ((w >>> 19) & 31);
        const set = rt === 31 ? 0 : bit < 32 ? (r[rt] >>> bit) & 1 : (H[rt] >>> (bit - 32)) & 1;
        if (set === ((w >>> 24) & 1)) return (pc + sx((w >>> 5) & 0x3fff, 14) * 4) | 0;
        pc = (pc + 4) | 0; continue;
      }
      case K_ADR: {                                                            // ADR / ADRP
        const rd = w & 31, imm = (sx((w >>> 5) & 0x7ffff, 19) << 2) | ((w >>> 29) & 3);
        if (rd !== 31) {
          const v = w < 0 ? ((pc & ~0xfff) + imm * 4096) | 0 : (pc + imm) | 0;
          r[rd] = v; H[rd] = 0;
        }
        pc = (pc + 4) | 0; continue;
      }
      case K_LDRLIT: {                                                         // LDR (literal), PRFM (literal)
        const rt = w & 31, opc = w >>> 30, a = (pc + sx((w >>> 5) & 0x7ffff, 19) * 4) | 0, I = c.si;
        if (w & 0x04000000) {                                                  // S / D / Q
          I[rt * 4] = M.ld32(a); I[rt * 4 + 1] = opc ? M.ld32(a + 4) : 0;
          I[rt * 4 + 2] = opc === 2 ? M.ld32(a + 8) : 0; I[rt * 4 + 3] = opc === 2 ? M.ld32(a + 12) : 0;
        } else if (opc !== 3 && rt !== 31) { r[rt] = M.ld32(a); H[rt] = opc === 1 ? M.ld32(a + 4) : opc === 2 ? r[rt] >> 31 : 0; }
        pc = (pc + 4) | 0; continue;
      }
      case K_BR: {                                                             // BR / BLR / RET
        const rn = (w >>> 5) & 31, kind = (w >>> 21) & 3, target = rn === 31 ? 0 : r[rn] | 0;
        if (kind === 1) { r[30] = (pc + 4) | 0; H[30] = 0; }
        return target;
      }
      default:                                                                 // SVC
        r[32] = (pc + 4) | 0; c.svc(); return r[32] | 0;
    }
  }
  return pc;
}
