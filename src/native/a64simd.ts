// The A64 SIMD&FP emitter, on a64.ts's contract: each instruction becomes straight-line JS over
// the V register file's lane views (see a64regs.ts), unrolled per lane, with no helper call on
// the common path and no BigInt anywhere. Moves, loads, stores, inserts and permutes go through
// the integer views so a NaN keeps its payload; arithmetic goes through the float views.
//
// An op that is not element-wise (ext, zip, tbl, a pairwise or narrowing op) reads lanes its
// own destination is about to overwrite when Vd is also a source, so `lanes` targets the scratch
// register V32 and copies back in that case — decided at emit time, free when registers differ.

import { type Fl, hex, ALL, COND, COND_READS } from "./flags";
import { sp, sph, zr, zrh, setX, setW, int32, lane, zeroHi, zeroS, words, SCRATCH, shl64, shr64, sar64, type View } from "./a64regs";
import { vfpImm } from "./vfp";
import { fbits, dbits } from "./host";

export type Push = (code: string, fl?: Fl | null, reads?: number, writes?: number) => void;
type Fault = (what: string) => string;

const is = (w: number, mask: number, val: number) => ((w & mask) >>> 0) === val;
const at = (o: number) => (o ? `a+${o}` : "a");

/** write `count` lanes of Vd through `view`, lane i from f(i); via V32 when an unsafe op aliases */
function lanes(d: number, count: number, view: View, f: (i: number) => string, q: boolean, safe = true, srcs: number[] = []): string {
  const tgt = !safe && srcs.includes(d) ? SCRATCH : d;
  let s = "";
  for (let i = 0; i < count; i++) s += `${lane(view, tgt, i)}=${f(i)};`;
  if (tgt !== d) {
    const n = q ? 4 : 2;
    for (let i = 0; i < n; i++) s += `I[${4 * d + i}]=I[${4 * SCRATCH + i}];`;
  }
  return s + (q ? "" : zeroHi(d));
}

// ── loads and stores of V registers: one register's bytes at `a` (+off); a load zeroes the rest

function vload(d: number, width: number, o: number): string {
  const w = 4 * d;
  switch (width) {
    case 1: return `I[${w}]=M.ld8u(${at(o)});` + zeroS(d);
    case 2: return `I[${w}]=M.ld16u(${at(o)});` + zeroS(d);
    case 4: return `I[${w}]=M.ld32(${at(o)});` + zeroS(d);
    case 8: return `I[${w}]=M.ld32(${at(o)});I[${w + 1}]=M.ld32(${at(o + 4)});` + zeroHi(d);
    default: return `I[${w}]=M.ld32(${at(o)});I[${w + 1}]=M.ld32(${at(o + 4)});I[${w + 2}]=M.ld32(${at(o + 8)});I[${w + 3}]=M.ld32(${at(o + 12)});`;
  }
}
function vstore(d: number, width: number, o: number): string {
  const w = 4 * d;
  switch (width) {
    case 1: return `M.st8(${at(o)},B[${16 * d}]);`;
    case 2: return `M.st16(${at(o)},W[${8 * d}]);`;
    case 4: return `M.st32(${at(o)},I[${w}]);`;
    case 8: return `M.st32(${at(o)},I[${w}]);M.st32(${at(o + 4)},I[${w + 1}]);`;
    default: return `M.st32(${at(o)},I[${w}]);M.st32(${at(o + 4)},I[${w + 1}]);M.st32(${at(o + 8)},I[${w + 2}]);M.st32(${at(o + 12)},I[${w + 3}]);`;
  }
}
/** one element of size `es` (bytes) of Vt lane i, load from / store to a+o */
function elemLoad(t: number, es: number, i: number, o: number): string {
  return es === 1 ? `B[${16 * t + i}]=M.ld8u(${at(o)});` : es === 2 ? `W[${8 * t + i}]=M.ld16u(${at(o)});`
    : es === 4 ? `I[${4 * t + i}]=M.ld32(${at(o)});` : `I[${4 * t + 2 * i}]=M.ld32(${at(o)});I[${4 * t + 2 * i + 1}]=M.ld32(${at(o + 4)});`;
}
function elemStore(t: number, es: number, i: number, o: number): string {
  return es === 1 ? `M.st8(${at(o)},B[${16 * t + i}]);` : es === 2 ? `M.st16(${at(o)},W[${8 * t + i}]);`
    : es === 4 ? `M.st32(${at(o)},I[${4 * t + i}]);` : `M.st32(${at(o)},I[${4 * t + 2 * i}]);M.st32(${at(o + 4)},I[${4 * t + 2 * i + 1}]);`;
}

/** every load/store with the V bit set; returns true when it ends the block (only a fault does) */
export function emitSimdMem(pc: number, w: number, push: Push, fault: Fault): boolean {
  const rt = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31;
  // LDR (literal): S, D, Q
  if (is(w, 0x3b000000, 0x18000000)) {
    const opc = (w >>> 30) & 3;
    if (opc === 3) { push(fault("LDR literal (SIMD)")); return true; }
    const addr = (pc + ((((w >>> 5) & 0x7ffff) << 13) >> 13) * 4) | 0;
    push(`a=${hex(addr)};` + vload(rt, 4 << opc, 0));
    return false;
  }
  // AdvSIMD load/store multiple structures (LD1..LD4 / ST1..ST4), with or without post-index
  if (is(w, 0xbfbf0000, 0x0c000000) || is(w, 0xbfa00000, 0x0c800000)) {
    const q = (w >>> 30) & 1, L = (w >>> 22) & 1, post = (w >>> 23) & 1, opcode = (w >>> 12) & 15, size = (w >>> 10) & 3;
    const regs = opcode === 0 || opcode === 2 ? 4 : opcode === 4 || opcode === 6 ? 3 : opcode === 7 ? 1 : opcode === 8 || opcode === 10 ? 2 : 0;
    const interleaved = opcode === 0 || opcode === 4 || opcode === 8;
    if (!regs || (size === 3 && !q && interleaved)) { push(fault("ld/st multiple structures")); return true; }
    const bytes = q ? 16 : 8, es = 1 << size, count = bytes / es;
    let body = `a=${sp(rn)}|0;`;
    for (let k = 0; k < regs; k++) {
      const t = (rt + k) & 31;
      if (!interleaved) body += L ? vload(t, bytes, k * bytes) : vstore(t, bytes, k * bytes);
      else for (let i = 0; i < count; i++) body += L ? elemLoad(t, es, i, (i * regs + k) * es) : elemStore(t, es, i, (i * regs + k) * es);
      if (L && interleaved && !q) body += zeroHi(t);
    }
    if (post) body += `${sp(rn)}=(${sp(rn)}+${rm === 31 ? regs * bytes : zr(rm)})|0;${sph(rn)}=0;`;
    push(body);
    return false;
  }
  // AdvSIMD load/store single structure, and the replicating loads
  if (is(w, 0xbf9f0000, 0x0d000000) || is(w, 0xbf800000, 0x0d800000)) {
    const q = (w >>> 30) & 1, L = (w >>> 22) & 1, post = (w >>> 23) & 1, R = (w >>> 21) & 1, opcode = (w >>> 13) & 7, S = (w >>> 12) & 1, size = (w >>> 10) & 3;
    const regs = 1 + R + (opcode & 1) * 2;
    let body = `a=${sp(rn)}|0;`;
    if (opcode >= 6) {                                                                   // LD1R..LD4R
      if (!L || S) { push(fault("ld/st single structure")); return true; }
      const es = 1 << size, count = (q ? 16 : 8) / es;
      for (let k = 0; k < regs; k++) {
        const t = (rt + k) & 31;
        body += elemLoad(t, es, 0, k * es);
        const src = es === 8 ? "" : lane(es === 1 ? "B" : es === 2 ? "W" : "I", t, 0);
        for (let i = 1; i < count; i++) body += es === 8 ? `I[${4 * t + 2 * i}]=I[${4 * t}];I[${4 * t + 2 * i + 1}]=I[${4 * t + 1}];` : `${lane(es === 1 ? "B" : es === 2 ? "W" : "I", t, i)}=${src};`;
        if (!q) body += zeroHi(t);
      }
      if (post) body += `${sp(rn)}=(${sp(rn)}+${rm === 31 ? regs * es : zr(rm)})|0;${sph(rn)}=0;`;
      push(body);
      return false;
    }
    const scale = opcode >> 1;
    const es = scale === 0 ? 1 : scale === 1 ? 2 : size & 1 ? 8 : 4;
    const idx = es === 1 ? (q << 3) | (S << 2) | size : es === 2 ? (q << 2) | (S << 1) | (size >> 1) : es === 4 ? (q << 1) | S : q;
    for (let k = 0; k < regs; k++) body += L ? elemLoad((rt + k) & 31, es, idx, k * es) : elemStore((rt + k) & 31, es, idx, k * es);
    if (post) body += `${sp(rn)}=(${sp(rn)}+${rm === 31 ? regs * es : zr(rm)})|0;${sph(rn)}=0;`;
    push(body);
    return false;
  }
  // LDP / STP (and the no-allocate pair): S, D, Q
  if (is(w, 0x3a000000, 0x28000000)) {
    const opc = (w >>> 30) & 3, L = (w >>> 22) & 1, imm7 = (((w >>> 15) & 0x7f) << 25) >> 25, rt2 = (w >>> 10) & 31, kind = (w >>> 23) & 3;
    if (opc === 3) { push(fault("LDP/STP (SIMD)")); return true; }
    const width = 4 << opc, off = imm7 * width, wb = kind === 1 || kind === 3;
    let body = kind === 1 || off === 0 ? `a=${sp(rn)}|0;` : `a=${sp(rn)}+${off}|0;`;
    if (wb) body += `${sp(rn)}=(${sp(rn)}+${off})|0;${sph(rn)}=0;`;
    body += L ? vload(rt, width, 0) + vload(rt2, width, width) : vstore(rt, width, 0) + vstore(rt2, width, width);
    push(body);
    return false;
  }
  // LDR / STR: unsigned offset, register offset, unscaled / pre / post index
  const size = (w >>> 30) & 3, opc = (w >>> 22) & 3, L = opc & 1;
  if ((opc & 2) && size !== 0) { push(fault("load/store (SIMD) width")); return true; }
  const scale = opc & 2 ? 4 : size, width = 1 << scale;
  let addr: string, wb = "";
  if (is(w, 0x3b000000, 0x39000000)) {
    const off = ((w >>> 10) & 0xfff) << scale;
    addr = off === 0 ? `${sp(rn)}|0` : `${sp(rn)}+${off}|0`;
  } else if (is(w, 0x3b200c00, 0x38200800)) {
    const option = (w >>> 13) & 7, S = (w >>> 12) & 1;
    const idx = option === 3 || option === 7 ? zr(rm) : option === 2 ? `(${zr(rm)}>>>0)` : `(${zr(rm)}|0)`;
    addr = `${sp(rn)}+${S && scale ? `(${idx}<<${scale})` : idx}|0`;
  } else {
    const imm9 = (((w >>> 12) & 0x1ff) << 23) >> 23, kind = (w >>> 10) & 3;
    if (kind === 2) { push(fault("load/store (SIMD) form")); return true; }
    addr = kind === 1 || imm9 === 0 ? `${sp(rn)}|0` : `${sp(rn)}+${imm9}|0`;
    if (kind === 1 || kind === 3) wb = `${sp(rn)}=(${sp(rn)}+${imm9})|0;${sph(rn)}=0;`;
  }
  push(`a=${addr};` + wb + (L ? vload(rt, width, 0) : vstore(rt, width, 0)));
  return false;
}

// ── AdvSIMD modified immediate: the 64-bit pattern (lo, hi) a cmode/op/imm8 triple expands to
function expandImm(op: number, cmode: number, o2: number, imm8: number): { lo: number; hi: number; kind: "movi" | "mvni" | "orr" | "bic" | "fmov" } | null {
  const group = cmode >> 1;
  const logical = (cmode & 1) ? (op ? "bic" : "orr") : (op ? "mvni" : "movi");
  if (group <= 3) { const v = imm8 << (8 * group); return { lo: v | 0, hi: v | 0, kind: logical }; }
  if (group <= 5) { const v = imm8 << (8 * (group - 4)); const rep = (v | (v << 16)) | 0; return { lo: rep, hi: rep, kind: logical }; }
  if (cmode === 12) { const v = ((imm8 << 8) | 0xff) | 0; return { lo: v, hi: v, kind: op ? "mvni" : "movi" }; }
  if (cmode === 13) { const v = ((imm8 << 16) | 0xffff) | 0; return { lo: v, hi: v, kind: op ? "mvni" : "movi" }; }
  if (cmode === 14) {
    if (!op) { const v = (imm8 * 0x01010101) | 0; return { lo: v, hi: v, kind: "movi" }; }
    let lo = 0, hi = 0;
    for (let i = 0; i < 4; i++) { if ((imm8 >> i) & 1) lo |= 0xff << (8 * i); if ((imm8 >> (i + 4)) & 1) hi |= 0xff << (8 * i); }
    return { lo: lo | 0, hi: hi | 0, kind: "movi" };
  }
  if (o2) return null;                                                                   // FMOV .h: absent from the corpus
  if (!op) { const v = fbits(vfpImm(imm8, false)); return { lo: v, hi: v, kind: "fmov" }; }
  const d = dbits(vfpImm(imm8, true));
  return { lo: Number(d & 0xffffffffn) | 0, hi: Number((d >> 32n) & 0xffffffffn) | 0, kind: "fmov" };
}

/** the SIMD&FP data-processing space; null when `w` is not in it, else whether it ends the block */
export function emitSimd(_pc: number, w: number, push: Push, fault: Fault): boolean | null {
  if ((w & 0x0e000000) !== 0x0e000000) return null;
  const rd = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31, q = (w >>> 30) & 1;
  const nw = q ? 4 : 2;   // words in the destination

  // ── modified immediate: MOVI / MVNI / ORR / BIC / FMOV (vector immediate)
  if (is(w, 0x9ff80400, 0x0f000400)) {
    const op = (w >>> 29) & 1, cmode = (w >>> 12) & 15, o2 = (w >>> 11) & 1, imm8 = (((w >>> 16) & 7) << 5) | ((w >>> 5) & 31);
    const e = expandImm(op, cmode, o2, imm8);
    if (!e || (e.kind === "fmov" && op && !q)) { push(fault("modified immediate")); return true; }
    const val = (i: number) => (i & 1 ? e.hi : e.lo);
    const W = words(rd);
    let body = "";
    for (let i = 0; i < nw; i++) {
      const k = val(i);
      body += e.kind === "orr" ? `${W[i]}|=${k};` : e.kind === "bic" ? `${W[i]}&=${~k};` : `${W[i]}=${e.kind === "mvni" ? ~k : k};`;
    }
    push(body + (q ? "" : zeroHi(rd)));
    return false;
  }

  // ── copy: DUP / INS / SMOV / UMOV, vector and scalar
  if (is(w, 0x9fe08400, 0x0e000400) || is(w, 0xdfe08400, 0x5e000400)) {
    const scalar = (w & 0x10000000) !== 0, op = (w >>> 29) & 1, imm5 = (w >>> 16) & 31, imm4 = (w >>> 11) & 15;
    const esz = imm5 & 1 ? 0 : imm5 & 2 ? 1 : imm5 & 4 ? 2 : imm5 & 8 ? 3 : -1;
    if (esz < 0) { push(fault("copy")); return true; }
    const idx = imm5 >> (esz + 1), view: View = esz === 0 ? "B" : esz === 1 ? "W" : "I";
    const src = (n: number, i: number) => (esz === 3 ? [`I[${4 * n + 2 * i}]`, `I[${4 * n + 2 * i + 1}]`] : [lane(view, n, i)]);
    if (scalar) {                                                                        // DUP (element) to scalar: mov s0, v1.s[i]
      if (op || imm4 !== 0) { push(fault("scalar copy")); return true; }
      const s = src(rn, idx);
      push(esz === 3 ? `I[${4 * rd}]=${s[0]};I[${4 * rd + 1}]=${s[1]};` + zeroHi(rd) : `I[${4 * rd}]=${s[0]};` + zeroS(rd));
      return false;
    }
    if (op) {                                                                            // INS (element)
      const s = src(rn, imm4 >> esz), d = src(rd, idx);
      push(d.map((x, i) => `${x}=${s[i]};`).join(""));
      return false;
    }
    const count = (q ? 16 : 8) >> esz;
    switch (imm4) {
      case 0: {                                                                          // DUP (element)
        const s = src(rn, idx);
        push(esz === 3 ? lanes(rd, nw, "I", (i) => s[i & 1], !!q) : lanes(rd, count, view, () => s[0], !!q));
        return false;
      }
      case 1:                                                                            // DUP (general)
        push(esz === 3 ? lanes(rd, nw, "I", (i) => (i & 1 ? zrh(rn) : zr(rn)), !!q) : lanes(rd, count, view, () => zr(rn), !!q));
        return false;
      case 3: {                                                                          // INS (general)
        const d = src(rd, idx);
        push(esz === 3 ? `${d[0]}=${zr(rn)};${d[1]}=${zrh(rn)};` : `${d[0]}=${zr(rn)};`);
        return false;
      }
      case 5: {                                                                          // SMOV
        const s = esz === 0 ? `SB[${16 * rn + idx}]` : esz === 1 ? `SW[${8 * rn + idx}]` : `I[${4 * rn + idx}]`;
        if (esz === 3 || (esz === 2 && !q)) { push(fault("smov")); return true; }
        push(q ? setX(rd, s, `(${s}>>31)`) : setW(rd, s));
        return false;
      }
      case 7: {                                                                          // UMOV
        if (esz === 3) { if (!q) { push(fault("umov")); return true; } push(setX(rd, `I[${4 * rn + 2 * idx}]`, `I[${4 * rn + 2 * idx + 1}]`)); return false; }
        if (q) { push(fault("umov")); return true; }
        push(setW(rd, lane(view, rn, idx)));
        return false;
      }
    }
    push(fault("copy"));
    return true;
  }

  // ── EXT: bytes imm4.. of Vn:Vm
  if (is(w, 0xbfe08400, 0x2e000000)) {
    const imm = (w >>> 11) & 15;
    if (!q && imm > 7) { push(fault("ext")); return true; }
    const bytes = q ? 16 : 8;
    const srcByte = (i: number) => (i < bytes ? `B[${16 * rn + i}]` : `B[${16 * rm + i - bytes}]`);
    if (imm % 4 === 0) {                                                                 // word-aligned: word moves
      const srcWord = (i: number) => (i < nw ? `I[${4 * rn + i}]` : `I[${4 * rm + i - nw}]`);
      push(lanes(rd, nw, "I", (i) => srcWord(i + imm / 4), !!q, false, [rn, rm]));
    } else push(lanes(rd, bytes, "B", (i) => srcByte(i + imm), !!q, false, [rn, rm]));
    return false;
  }

  // ── TBL / TBX: bytes of Vd picked out of 1-4 consecutive table registers by the indices in Vm
  if (is(w, 0xbfe08c00, 0x0e000000)) {
    const len = ((w >>> 13) & 3) + 1, tbx = (w >>> 12) & 1, bytes = q ? 16 : 8;
    // Vn..Vn+len-1 are contiguous bytes of the file, so an index is a byte offset from Vn; the
    // table wrapping past V31 is spelled out because the corpus never does it
    if (rn + len > 32) { push(fault("tbl past v31")); return true; }
    const pick = (i: number) => `B[${16 * rm + i}]<${16 * len}?B[${16 * rn}+B[${16 * rm + i}]]:${tbx ? `B[${16 * rd + i}]` : "0"}`;
    push(lanes(rd, bytes, "B", pick, !!q, false, [rn, rm]));
    return false;
  }

  // ── permute: UZP1 / TRN1 / ZIP1 / UZP2 / TRN2 / ZIP2
  if (is(w, 0xbf208c00, 0x0e000800)) {
    const size = (w >>> 22) & 3, opcode = (w >>> 12) & 7;
    if (opcode === 0 || opcode === 4) { push(fault("permute")); return true; }
    if (size === 3 && !q) { push(fault("permute")); return true; }
    const es = 1 << size, count = (q ? 16 : 8) / es, half = count >> 1;
    const view: View = size === 0 ? "B" : size === 1 ? "W" : "I";
    // 64-bit lanes are pairs of words: express everything in word units for size 3
    const unit = size === 3 ? 2 : 1, wc = count * unit;
    const src = (reg: number, e: number, part: number) => (size === 3 ? `I[${4 * reg + 2 * e + part}]` : lane(view, reg, e));
    const pick = (i: number): string => {
      const e = Math.floor(i / unit), part = i % unit;
      switch (opcode) {
        case 1: return e < half ? src(rn, 2 * e, part) : src(rm, 2 * (e - half), part);             // UZP1
        case 5: return e < half ? src(rn, 2 * e + 1, part) : src(rm, 2 * (e - half) + 1, part);     // UZP2
        case 2: return e & 1 ? src(rm, e - 1, part) : src(rn, e, part);                             // TRN1
        case 6: return e & 1 ? src(rm, e, part) : src(rn, e + 1, part);                             // TRN2
        case 3: return e & 1 ? src(rm, e >> 1, part) : src(rn, e >> 1, part);                       // ZIP1
        default: return e & 1 ? src(rm, half + (e >> 1), part) : src(rn, half + (e >> 1), part);    // ZIP2
      }
    };
    push(lanes(rd, wc, size === 3 ? "I" : view, pick, !!q, false, [rn, rm]));
    return false;
  }

  // ── three-same, bitwise (opcode 00011): AND/BIC/ORR/ORN, EOR/BSL/BIT/BIF — word-wise
  if (is(w, 0x9f20fc00, 0x0e201c00)) {
    const U = (w >>> 29) & 1, size = (w >>> 22) & 3;
    const N = words(rn), Mm = words(rm), D = words(rd);
    const f = (i: number): string => {
      if (!U) return size === 0 ? `${N[i]}&${Mm[i]}` : size === 1 ? `${N[i]}&~${Mm[i]}` : size === 2 ? `${N[i]}|${Mm[i]}` : `${N[i]}|~${Mm[i]}`;
      return size === 0 ? `${N[i]}^${Mm[i]}` : size === 1 ? `(${D[i]}&${N[i]})|(~${D[i]}&${Mm[i]})`
        : size === 2 ? `(${D[i]}&~${Mm[i]})|(${N[i]}&${Mm[i]})` : `(${D[i]}&${Mm[i]})|(${N[i]}&~${Mm[i]})`;
    };
    push(lanes(rd, nw, "I", f, !!q));
    return false;
  }

  // ── two-reg misc, NOT (MVN) and the rest of the family later
  if (is(w, 0xbffffc00, 0x2e205800)) {                                                   // NOT
    const N = words(rn);
    push(lanes(rd, nw, "I", (i) => `~${N[i]}`, !!q));
    return false;
  }

  // ── the vector and scalar-SIMD arithmetic families
  const vec = emitVector(w, push, fault);
  if (vec !== null) return vec;

  // ── scalar floating point (bit 28 set): the data-processing groups and the conversions
  if ((w & 0x50000000) === 0x10000000) return emitFp(w, push, fault);

  push(fault("unimplemented"));
  return true;
}

/** the flags FCMP leaves: less 1000, equal 0110, greater 0010, unordered 0011 (`a`, `t` hold the operands) */
const FCMP: Fl = { n: "c.n=a<t?1:0;", z: "c.z=a===t?1:0;", c: "c.c=a<t?0:1;", v: "c.v=(a!==a||t!==t)?1:0;" };
const FCMP_ALL = FCMP.n! + FCMP.z! + FCMP.c! + FCMP.v!;

/** round `x` (a JS expression) the way rmode/opcode of FCVT* and FRINT* ask */
function rounded(x: string, mode: "N" | "P" | "M" | "Z" | "A" | "X"): string {
  switch (mode) {
    case "N": return `c.rne(${x})`;
    case "P": return `Math.ceil(${x})`;
    case "M": return `Math.floor(${x})`;
    case "Z": return `Math.trunc(${x})`;
    case "A": return `c.rna(${x})`;
    default: return `c.rint(${x})`;
  }
}
/** an integer-valued double in `t` into Wd/Xd, saturating; NaN is 0 */
function toInt(rd: number, sf: number, unsigned: boolean): string {
  if (sf) return `c.cvt64(t,${unsigned ? 0 : 1});` + setX(rd, "c.lo", "c.hi");
  return setW(rd, unsigned ? "(t!==t||t<=0?0:t>=4294967295?-1:t|0)" : "(t!==t?0:t>=2147483647?2147483647:t<=-2147483648?-2147483648:t|0)");
}

function emitFp(w: number, push: Push, fault: Fault): boolean {
  const rd = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31, ftype = (w >>> 22) & 3, sf = (w >>> 31) & 1;
  if (w & 0x20000000) { push(fault("fp")); return true; }                               // S=1 is unallocated
  const dp = ftype === 1, half = ftype === 3;
  // the scalar as an arithmetic operand, and the write that zeroes the rest of the register
  const S = (n: number) => (dp ? `D[${2 * n}]` : `S[${4 * n}]`);
  const setF = (d: number, e: string) => (dp ? `D[${2 * d}]=${e};` + zeroHi(d) : `S[${4 * d}]=${e};` + zeroS(d));
  const movF = (d: number, n: number) => (dp ? `I[${4 * d}]=I[${4 * n}];I[${4 * d + 1}]=I[${4 * n + 1}];` + zeroHi(d) : `I[${4 * d}]=I[${4 * n}];` + zeroS(d));

  // FP <-> integer conversion, and the FMOV general forms
  if (is(w, 0x5f20fc00, 0x1e200000)) {
    const rmode = (w >>> 19) & 3, opcode = (w >>> 16) & 7;
    if (opcode >= 6) {                                                                   // FMOV between a V register and a GPR
      if (ftype === 2 && rmode === 1 && sf) {                                            // the top half of a D
        push(opcode === 6 ? setX(rd, `I[${4 * rn + 2}]`, `I[${4 * rn + 3}]`) : `I[${4 * rd + 2}]=${zr(rn)};I[${4 * rd + 3}]=${zrh(rn)};`);
        return false;
      }
      if (rmode !== 0 || half || ftype === 2 || (dp !== !!sf)) { push(fault("fmov")); return true; }
      if (opcode === 6) push(sf ? setX(rd, `I[${4 * rn}]`, `I[${4 * rn + 1}]`) : setW(rd, `I[${4 * rn}]`));
      else push(sf ? `I[${4 * rd}]=${zr(rn)};I[${4 * rd + 1}]=${zrh(rn)};` + zeroHi(rd) : `I[${4 * rd}]=${zr(rn)};` + zeroS(rd));
      return false;
    }
    if (half) { push(fault("fp16")); return true; }
    if (opcode === 2 || opcode === 3) {                                                  // SCVTF / UCVTF from Wn/Xn
      const src = sf ? (opcode === 2 ? `${zrh(rn)}*4294967296+(${zr(rn)}>>>0)` : `(${zrh(rn)}>>>0)*4294967296+(${zr(rn)}>>>0)`)
        : (opcode === 2 ? zr(rn) : `(${zr(rn)}>>>0)`);
      push(setF(rd, src));
      return false;
    }
    if (opcode <= 1 || opcode === 4 || opcode === 5) {                                   // FCVT{N,P,M,Z,A}{S,U}
      const mode = opcode >= 4 ? "A" : rmode === 0 ? "N" : rmode === 1 ? "P" : rmode === 2 ? "M" : "Z";
      push(`t=${rounded(S(rn), mode)};` + toInt(rd, sf, (opcode & 1) === 1));
      return false;
    }
    push(fault("fp<->int"));
    return true;
  }
  // FP <-> fixed point
  if (is(w, 0x5f200000, 0x1e000000)) {
    const rmode = (w >>> 19) & 3, opcode = (w >>> 16) & 7, fbits = 64 - ((w >>> 10) & 0x3f);
    if (half) { push(fault("fp16")); return true; }
    const scale = 2 ** fbits;
    if (rmode === 0 && (opcode === 2 || opcode === 3)) {
      const src = sf ? (opcode === 2 ? `(${zrh(rn)}*4294967296+(${zr(rn)}>>>0))` : `((${zrh(rn)}>>>0)*4294967296+(${zr(rn)}>>>0))`)
        : (opcode === 2 ? zr(rn) : `(${zr(rn)}>>>0)`);
      push(setF(rd, `${src}/${scale}`));
      return false;
    }
    if (rmode === 3 && opcode <= 1) {
      push(`t=Math.trunc(${S(rn)}*${scale});` + toInt(rd, sf, opcode === 1));
      return false;
    }
    push(fault("fp<->fixed"));
    return true;
  }
  if (sf) { push(fault("fp")); return true; }
  // 1-source
  if (is(w, 0x5f207c00, 0x1e204000)) {
    const opcode = (w >>> 15) & 0x3f;
    if (opcode >= 4 && opcode <= 7) {                                                    // FCVT between widths
      const to = opcode & 3;
      if (to === ftype || to === 2) { push(fault("fcvt")); return true; }
      const src = half ? `c.h2f(W[${8 * rn}])` : S(rn);
      const toHalf = half ? `c.f2h(${src})` : dp ? `c.f2hd(I[${4 * rn}],I[${4 * rn + 1}])` : `c.f2hs(I[${4 * rn}])`;
      push(to === 0 ? `S[${4 * rd}]=${src};` + zeroS(rd) : to === 1 ? `D[${2 * rd}]=${src};` + zeroHi(rd) : `I[${4 * rd}]=${toHalf};` + zeroS(rd));
      return false;
    }
    if (half) { push(fault("fp16")); return true; }
    const signBit = dp ? `I[${4 * rn + 1}]` : `I[${4 * rn}]`, signDst = dp ? `I[${4 * rd + 1}]` : `I[${4 * rd}]`;
    switch (opcode) {
      case 0: push(movF(rd, rn)); return false;                                          // FMOV
      case 1: push((dp ? `I[${4 * rd}]=I[${4 * rn}];` : "") + `${signDst}=${signBit}&0x7fffffff;` + (dp ? zeroHi(rd) : zeroS(rd))); return false;   // FABS
      case 2: push((dp ? `I[${4 * rd}]=I[${4 * rn}];` : "") + `${signDst}=${signBit}^-2147483648;` + (dp ? zeroHi(rd) : zeroS(rd))); return false;  // FNEG
      case 3: push(setF(rd, `Math.sqrt(${S(rn)})`)); return false;                       // FSQRT
      case 8: case 9: case 10: case 11: case 12: case 14: case 15: {                      // FRINT N P M Z A X I
        const mode = (["N", "P", "M", "Z", "A", "", "X", "X"] as const)[opcode - 8];
        push(setF(rd, rounded(S(rn), mode as "N")));
        return false;
      }
    }
    push(fault("fp 1-source"));
    return true;
  }
  if (half) { push(fault("fp16")); return true; }
  // compare
  if (is(w, 0x5f203c00, 0x1e202000)) {
    const opcode2 = w & 31;
    if (opcode2 & 7) { push(fault("fcmp")); return true; }
    push(`a=${S(rn)};t=${opcode2 & 8 ? "0" : S(rm)};\0F`, FCMP, 0, ALL);
    return false;
  }
  // immediate
  if (is(w, 0x5f201c00, 0x1e201000)) {
    const imm8 = (w >>> 13) & 0xff;
    if (dp) {
      const d = dbits(vfpImm(imm8, true));
      push(`I[${4 * rd}]=${int32(Number(d & 0xffffffffn))};I[${4 * rd + 1}]=${int32(Number((d >> 32n) & 0xffffffffn))};` + zeroHi(rd));
    } else push(`I[${4 * rd}]=${int32(fbits(vfpImm(imm8, false)))};` + zeroS(rd));
    return false;
  }
  // conditional compare
  if (is(w, 0x5f200c00, 0x1e200400)) {
    const cond = (w >>> 12) & 15, nzcv = w & 15;
    const setNzcv = `c.n=${(nzcv >> 3) & 1};c.z=${(nzcv >> 2) & 1};c.c=${(nzcv >> 1) & 1};c.v=${nzcv & 1};`;
    push(`if(${COND[cond]}){a=${S(rn)};t=${S(rm)};${FCMP_ALL}}else{${setNzcv}}`, null, COND_READS[cond], ALL);
    return false;
  }
  // 2-source
  if (is(w, 0x5f200c00, 0x1e200800)) {
    const opcode = (w >>> 12) & 15, a = S(rn), b = S(rm);
    const e = opcode === 0 ? `${a}*${b}` : opcode === 1 ? `${a}/${b}` : opcode === 2 ? `${a}+${b}` : opcode === 3 ? `${a}-${b}`
      : opcode === 4 ? `Math.max(${a},${b})` : opcode === 5 ? `Math.min(${a},${b})` : opcode === 8 ? `-(${a}*${b})` : null;
    if (e !== null) { push(setF(rd, e)); return false; }
    if (opcode === 6 || opcode === 7) {                                                  // FMAXNM / FMINNM: a quiet NaN loses, a signaling one wins
      push(dp ? `c.fnm64(I[${4 * rn}],I[${4 * rn + 1}],I[${4 * rm}],I[${4 * rm + 1}],${opcode === 6});I[${4 * rd}]=c.lo;I[${4 * rd + 1}]=c.hi;` + zeroHi(rd)
        : `I[${4 * rd}]=c.fnm32(I[${4 * rn}],I[${4 * rm}],${opcode === 6});` + zeroS(rd));
      return false;
    }
    push(fault("fp 2-source"));
    return true;
  }
  // conditional select
  if (is(w, 0x5f200c00, 0x1e200c00)) {
    const cond = (w >>> 12) & 15;
    push(dp ? `if(${COND[cond]}){I[${4 * rd}]=I[${4 * rn}];I[${4 * rd + 1}]=I[${4 * rn + 1}];}else{I[${4 * rd}]=I[${4 * rm}];I[${4 * rd + 1}]=I[${4 * rm + 1}];}` + zeroHi(rd)
      : `I[${4 * rd}]=${COND[cond]}?I[${4 * rn}]:I[${4 * rm}];` + zeroS(rd), null, COND_READS[cond], 0);
    return false;
  }
  // 3-source: FMADD / FMSUB / FNMADD / FNMSUB (one rounding of the product, then of the sum)
  if (is(w, 0x5f000000, 0x1f000000)) {
    const o1 = (w >>> 21) & 1, o0 = (w >>> 15) & 1, ra = (w >>> 10) & 31;
    const acc = S(ra);
    if (dp) push(setF(rd, `c.fma(${!o1 === !o0 ? "" : "-"}${S(rn)},${S(rm)},${o1 ? "-" : ""}${acc})`));   // one rounding, as the hardware fuses
    else { const p = `${S(rn)}*${S(rm)}`; push(setF(rd, !o1 ? (o0 ? `${acc}-${p}` : `${acc}+${p}`) : (o0 ? `${p}-${acc}` : `-${acc}-${p}`))); }
    return false;
  }
  push(fault("fp"));
  return true;
}

// ── integer lanes: the view for an element size (0 b, 1 h, 2 s) and signedness
const iv = (size: number, signed: boolean): View => (size === 0 ? (signed ? "SB" : "B") : size === 1 ? (signed ? "SW" : "W") : signed ? "I" : "U");
const BITS = [8, 16, 32, 64];
/** saturate expression `t` to a lane of `bits`, signed or not, raising QC */
function sat(t: string, bits: number, signed: boolean): string {
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1, min = signed ? -(2 ** (bits - 1)) : 0;
  return `(${t}>${max}?(c.q=1,${max}):${t}<${min}?(c.q=1,${min}):${t})`;
}
/** a 64-bit lane (word pair) of Vn */
const lo64 = (n: number, i: number) => `I[${4 * n + 2 * i}]`, hi64 = (n: number, i: number) => `I[${4 * n + 2 * i + 1}]`;
/** 64-bit compare of lanes i of Vn and Vm: `gt` signed / unsigned, `eq` */
const cmp64 = (n: number, m: number, i: number, kind: "gt" | "ge" | "hi" | "hs" | "eq" | "tst") => {
  const [al, ah, bl, bh] = [lo64(n, i), hi64(n, i), lo64(m, i), hi64(m, i)];
  const gtS = `(${ah}>${bh}||(${ah}===${bh}&&(${al}>>>0)>(${bl}>>>0)))`, gtU = `((${ah}>>>0)>(${bh}>>>0)||(${ah}===${bh}&&(${al}>>>0)>(${bl}>>>0)))`;
  const eq = `(${ah}===${bh}&&${al}===${bl})`;
  return kind === "gt" ? gtS : kind === "hi" ? gtU : kind === "eq" ? eq : kind === "tst" ? `((${al}&${bl})|(${ah}&${bh}))!==0` : kind === "ge" ? `(${gtS}||${eq})` : `(${gtU}||${eq})`;
};
/** write every 64-bit lane i of Vd from (lo, hi) expression pairs */
function lanes64(d: number, count: number, f: (i: number) => [string, string], q: boolean, safe = true, srcs: number[] = []): string {
  const tgt = !safe && srcs.includes(d) ? SCRATCH : d;
  let s = "";
  for (let i = 0; i < count; i++) { const [l, h] = f(i); s += `t=${l};th=${h};${lo64(tgt, i)}=t;${hi64(tgt, i)}=th;`; }
  if (tgt !== d) for (let i = 0; i < 2 * count; i++) s += `I[${4 * d + i}]=I[${4 * SCRATCH + i}];`;
  return s + (q ? "" : zeroHi(d));
}
/** after a scalar B/H store into lane 0: clear the rest of that word */
const narrowClear = (d: number, esz: number) => (esz === 0 ? `I[${4 * d}]&=255;` : esz === 1 ? `I[${4 * d}]&=65535;` : "");
/** an integer-valued double `t` into the (lo, hi) of a 64-bit lane */
const split64 = (t: string): [string, string] => [`${t}`, `Math.floor(${t}/4294967296)`];

function emitVector(w: number, push: Push, fault: Fault): boolean | null {
  const rd = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31, q = (w >>> 30) & 1, U = (w >>> 29) & 1, size = (w >>> 22) & 3;
  const scalar = (w & 0x10000000) !== 0 && (w & 0x40000000) !== 0;   // 01x1: the scalar forms
  const Q = scalar ? 0 : q;
  const bits = BITS[size], count = scalar ? 1 : ((Q ? 128 : 64) / bits);
  // FP element size in these families: size<0> picks single/double, size<1> the variant
  const fdp = (size & 1) === 1, fv = (size >> 1) & 1;
  const FV: View = fdp ? "D" : "S", fcount = scalar ? 1 : (Q ? 128 : 64) / (fdp ? 64 : 32);
  const F = (n: number, i: number) => lane(FV, n, i);
  const fin = (d: number, body: string) => body + (scalar ? (fdp ? zeroHi(d) : zeroS(d)) : Q ? "" : zeroHi(d));
  const done = (body: string) => { push(body); return false; };
  const unimpl = (what: string) => { push(fault(what)); return true; };
  // the scalar S/H/B forms zero above the element — a B or H result also clears the rest of its
  // own word, which a byte or halfword store leaves behind; a 64-bit scalar zeroes the top half
  const finI = (d: number, body: string) => body + (scalar ? (size === 3 ? zeroHi(d) : narrowClear(d, size) + zeroS(d)) : Q ? "" : zeroHi(d));
  /** a narrowing op writes SCRATCH's low half, then the half of Vd the Q bit names (the other half keeps its lanes) */
  const narrowed = (body: string, esz = size) => body + (Q ? `I[${4 * rd + 2}]=I[${4 * SCRATCH}];I[${4 * rd + 3}]=I[${4 * SCRATCH + 1}];` : `I[${4 * rd}]=I[${4 * SCRATCH}];I[${4 * rd + 1}]=I[${4 * SCRATCH + 1}];` + zeroHi(rd)) + (scalar ? narrowClear(rd, esz) + zeroS(rd) : "");

  // ── three-same (vector 0Q U 01110 size 1 Rm opcode 1, scalar 01 U 11110 ...)
  if (is(w, 0x8f200400, 0x0e200400) && (!(w & 0x10000000) || (w & 0x40000000))) {
    const opcode = (w >>> 11) & 31;
    if (opcode >= 24) {                                                                  // floating point
      if (opcode === 25 && U) return unimpl("fmlal");
      const N = (i: number) => F(rn, i), Mm = (i: number) => F(rm, i), Dd = (i: number) => F(rd, i);
      const each = (f: (i: number) => string, safe = true) => fin(rd, lanes(rd, fcount, FV, f, !!Q, safe, [rn, rm]));
      // FMAXNM/FMINNM on the lane bits: a signaling NaN wins, a quiet one loses to a number
      const nmBits = (x: (i: number) => [string, string], y: (i: number) => [string, string], max: boolean, safe: boolean) => fin(rd, fdp
        ? lanes64(rd, fcount, (i) => [`(c.fnm64(${x(i)[0]},${x(i)[1]},${y(i)[0]},${y(i)[1]},${max}),c.lo)`, "c.hi"], !!Q, safe, [rn, rm])
        : lanes(rd, fcount, "I", (i) => `c.fnm32(${x(i)[0]},${y(i)[0]},${max})`, !!Q, safe, [rn, rm]));
      const bitsOf = (n: number, i: number): [string, string] => (fdp ? [lo64(n, i), hi64(n, i)] : [`I[${4 * n + i}]`, ""]);
      const pairBits = (i: number): [[string, string], [string, string]] => (i < fcount / 2 ? [bitsOf(rn, 2 * i), bitsOf(rn, 2 * i + 1)] : [bitsOf(rm, 2 * i - fcount), bitsOf(rm, 2 * i - fcount + 1)]);
      const fcmp = (test: (i: number) => string) => fin(rd, [...Array(fcount)].map((_, i) => fdp ? `t=${test(i)}?-1:0;${lo64(rd, i)}=t;${hi64(rd, i)}=t;` : `I[${4 * rd + i}]=${test(i)}?-1:0;`).join(""));
      const pair = (i: number) => (i < fcount / 2 ? [N(2 * i), N(2 * i + 1)] : [Mm(2 * i - fcount), Mm(2 * i - fcount + 1)]);
      switch (opcode) {
        case 24: if (!U) return done(nmBits((i) => bitsOf(rn, i), (i) => bitsOf(rm, i), !fv, true));                    // FMAXNM / FMINNM
          return done(nmBits((i) => pairBits(i)[0], (i) => pairBits(i)[1], !fv, false));                                 // FMAXNMP / FMINNMP
        case 25: return done(each((i) => (fdp ? `c.fma(${fv ? "-" : ""}${N(i)},${Mm(i)},${Dd(i)})` : fv ? `${Dd(i)}-${N(i)}*${Mm(i)}` : `${Dd(i)}+${N(i)}*${Mm(i)}`)));   // FMLA / FMLS
        case 26: if (!U) return done(each((i) => `${N(i)}${fv ? "-" : "+"}${Mm(i)}`));                                  // FADD / FSUB
          if (fv) return done(each((i) => `Math.abs(${N(i)}-${Mm(i)})`));                                               // FABD
          return done(each((i) => { const [x, y] = pair(i); return `${x}+${y}`; }, false));                             // FADDP
        case 27: return done(each((i) => (U ? `${N(i)}*${Mm(i)}` : `c.fmulx(${N(i)},${Mm(i)})`)));                     // FMUL / FMULX
        case 28: return done(fcmp((i) => (!U ? `${N(i)}===${Mm(i)}` : fv ? `${N(i)}>${Mm(i)}` : `${N(i)}>=${Mm(i)}`)));   // FCMEQ / FCMGE / FCMGT
        case 29: if (!U) return unimpl("fmlal");
          return done(fcmp((i) => (fv ? `Math.abs(${N(i)})>Math.abs(${Mm(i)})` : `Math.abs(${N(i)})>=Math.abs(${Mm(i)})`)));   // FACGE / FACGT
        case 30: if (!U) return done(each((i) => `Math.${fv ? "min" : "max"}(${N(i)},${Mm(i)})`));                      // FMAX / FMIN
          return done(each((i) => { const [x, y] = pair(i); return `Math.${fv ? "min" : "max"}(${x},${y})`; }, false));   // FMAXP / FMINP
        case 31: if (U) return done(each((i) => `${N(i)}/${Mm(i)}`));                                                    // FDIV
          return done(each((i) => (fv ? `(3-${N(i)}*${Mm(i)})/2` : `2-${N(i)}*${Mm(i)}`)));                            // FRECPS / FRSQRTS
      }
    }
    if (opcode === 3) return unimpl("three-same bitwise reached the arithmetic path");
    if (size === 3) {                                                                    // 64-bit integer lanes
      const each64 = (f: (i: number) => [string, string], safe = true) => finI(rd, lanes64(rd, count, f, !!Q, safe, [rn, rm]));
      const mask = (kind: "gt" | "ge" | "hi" | "hs" | "eq" | "tst") => each64((i) => [`${cmp64(rn, rm, i, kind)}?-1:0`, "t"]);
      switch (opcode) {
        case 1: case 5: return done(each64((i) => [`(c.sat64(${lo64(rn, i)},${hi64(rn, i)},${lo64(rm, i)},${hi64(rm, i)},${opcode === 5},${!!U}),c.lo)`, "c.hi"]));   // SQADD/UQADD, SQSUB/UQSUB
        case 6: return done(mask(U ? "hi" : "gt"));
        case 7: return done(mask(U ? "hs" : "ge"));
        case 8: return done(each64((i) => [`(s=SB[${16 * rm + 8 * i}],s>=0?(c.shift64(${lo64(rn, i)},${hi64(rn, i)},s>63?64:s,0),c.lo):(c.shift64(${lo64(rn, i)},${hi64(rn, i)},-s>63?64:-s,${U ? 1 : 2}),c.lo))`, "c.hi"]));   // SSHL / USHL
        case 16: return done(each64((i) => {
          const [al, ah, bl, bh] = [lo64(rn, i), hi64(rn, i), lo64(rm, i), hi64(rm, i)];
          return U ? [`(${al}-${bl})|0`, `(${ah}-${bh}-((${al}>>>0)<(${bl}>>>0)?1:0))|0`] : [`(${al}+${bl})|0`, `(${ah}+${bh}+(((${al}>>>0)+(${bl}>>>0))>4294967295?1:0))|0`];
        }));                                                                              // ADD / SUB
        case 17: return done(mask(U ? "eq" : "tst"));                                     // CMTST / CMEQ
        case 23: if (U) return unimpl("three-same .2d");
          return done(each64((i) => {                                                     // ADDP .2d (and the scalar addp d)
            const [al, ah, bl, bh] = i === 0 ? [lo64(rn, 0), hi64(rn, 0), lo64(rn, 1), hi64(rn, 1)] : [lo64(rm, 0), hi64(rm, 0), lo64(rm, 1), hi64(rm, 1)];
            return [`(${al}+${bl})|0`, `(${ah}+${bh}+(((${al}>>>0)+(${bl}>>>0))>4294967295?1:0))|0`];
          }, false));
      }
      return unimpl("three-same .2d");
    }
    const sv = iv(size, true), uv = iv(size, false), V = iv(size, !U);
    const N = (i: number) => lane(V, rn, i), Mm = (i: number) => lane(V, rm, i), Dd = (i: number) => lane(V, rd, i);
    const each = (f: (i: number) => string, view: View = V, safe = true) => finI(rd, lanes(rd, count, view, f, !!Q, safe, [rn, rm]));
    const wrap = (e: string) => (size === 2 ? `(${e})|0` : e);   // 8/16-bit stores truncate; a 32-bit sum must not leave int32 for a signed lane view
    const pair = (i: number) => (i < count / 2 ? [N(2 * i), N(2 * i + 1)] : [Mm(2 * i - count), Mm(2 * i - count + 1)]);
    switch (opcode) {
      case 0: return done(each((i) => `Math.floor((${N(i)}+${Mm(i)})/2)`));                                             // SHADD / UHADD
      case 1: return done(each((i) => sat(`(${N(i)}+${Mm(i)})`, bits, !U)));                                            // SQADD / UQADD
      case 2: return done(each((i) => `Math.floor((${N(i)}+${Mm(i)}+1)/2)`));                                           // SRHADD / URHADD
      case 4: return done(each((i) => `Math.floor((${N(i)}-${Mm(i)})/2)`));                                             // SHSUB / UHSUB
      case 5: return done(each((i) => sat(`(${N(i)}-${Mm(i)})`, bits, !U)));                                            // SQSUB / UQSUB
      case 6: return done(each((i) => `${N(i)}>${Mm(i)}?-1:0`, sv));                                                    // CMGT / CMHI
      case 7: return done(each((i) => `${N(i)}>=${Mm(i)}?-1:0`, sv));                                                   // CMGE / CMHS
      case 8: case 10: {                                                                                                  // SSHL / USHL, SRSHL / URSHL
        const round = opcode === 10;
        return done(each((i) => {
          const a = N(i), sh = `SB[${16 * rm + (bits / 8) * i}]`;
          // a rounding right shift of the full width can still round up to 1; past it, everything is 0
          const right = round ? `(-s>${bits}?0:Math.floor((${a}+2**(-s-1))/2**-s))` : U ? `(-s>=${bits}?0:${a}>>>-s)` : `(-s>=${bits}?${a}>>${bits - 1}:${a}>>-s)`;
          return `(s=${sh},s>=0?(s>=${bits}?0:${a}<<s):${right})`;
        }));
      }
      case 12: return done(each((i) => `Math.max(${N(i)},${Mm(i)})`));                                                  // SMAX / UMAX
      case 13: return done(each((i) => `Math.min(${N(i)},${Mm(i)})`));                                                  // SMIN / UMIN
      case 14: return done(each((i) => `Math.abs(${N(i)}-${Mm(i)})`));                                                  // SABD / UABD
      case 15: return done(each((i) => `${Dd(i)}+Math.abs(${N(i)}-${Mm(i)})`));                                          // SABA / UABA
      case 16: return done(each((i) => wrap(`${N(i)}${U ? "-" : "+"}${Mm(i)}`)));                                       // ADD / SUB
      case 17: return done(each((i) => (U ? `${N(i)}===${Mm(i)}?-1:0` : `(${N(i)}&${Mm(i)})!==0?-1:0`), sv));           // CMTST / CMEQ
      case 18: return done(each((i) => wrap(`${Dd(i)}${U ? "-" : "+"}${size === 2 ? `Math.imul(${N(i)},${Mm(i)})` : `${N(i)}*${Mm(i)}`}`)));   // MLA / MLS
      case 19: if (U) return done(each((i) => `c.pmul8(${N(i)},${Mm(i)})`, uv));                                         // PMUL
        return done(each((i) => (size === 2 ? `Math.imul(${N(i)},${Mm(i)})` : `${N(i)}*${Mm(i)}`)));                    // MUL
      case 20: return done(each((i) => { const [x, y] = pair(i); return `Math.max(${x},${y})`; }, V, false));            // SMAXP / UMAXP
      case 21: return done(each((i) => { const [x, y] = pair(i); return `Math.min(${x},${y})`; }, V, false));            // SMINP / UMINP
      case 22: {                                                                                                          // SQDMULH / SQRDMULH
        if (size === 0) return unimpl("sqdmulh .b");
        const round = U ? `+${2 ** (bits - 1)}` : "";
        return done(each((i) => sat(`Math.floor((2*${lane(sv, rn, i)}*${lane(sv, rm, i)}${round})/${2 ** bits})`, bits, true), sv));
      }
      case 23: if (U) return unimpl("three-same");
        return done(each((i) => { const [x, y] = pair(i); return wrap(`${x}+${y}`); }, V, false));                       // ADDP
    }
    return unimpl("three-same");
  }

  // ── two-register misc (vector 0Q U 01110 size 10000 opcode 10, scalar 01 U 11110 ...)
  if (is(w, 0x8f3e0c00, 0x0e200800) && (!(w & 0x10000000) || (w & 0x40000000))) {
    const opcode = (w >>> 12) & 31;
    const N = (i: number) => F(rn, i);
    const each = (f: (i: number) => string, view: View = FV, safe = true) => fin(rd, lanes(rd, fcount, view, f, !!Q, safe, [rn]));
    const fcmp0 = (test: (i: number) => string) => fin(rd, [...Array(fcount)].map((_, i) => fdp ? `t=${test(i)}?-1:0;${lo64(rd, i)}=t;${hi64(rd, i)}=t;` : `I[${4 * rd + i}]=${test(i)}?-1:0;`).join(""));
    const toInts = (mode: "N" | "P" | "M" | "Z" | "A", unsigned: boolean) => fin(rd, [...Array(fcount)].map((_, i) => `t=${rounded(N(i), mode)};` + (fdp
      ? `c.cvt64(t,${unsigned ? 0 : 1});${lo64(rd, i)}=c.lo;${hi64(rd, i)}=c.hi;`
      : `I[${4 * rd + i}]=${unsigned ? "(t!==t||t<=0?0:t>=4294967295?-1:t|0)" : "(t!==t?0:t>=2147483647?2147483647:t<=-2147483648?-2147483648:t|0)"};`)).join(""));
    if (opcode >= 22 || (opcode >= 12 && opcode <= 15 && fv)) {                         // floating point, size<1> picks the variant
      switch (opcode) {
        case 22: if (U) return unimpl("fcvtxn");
          if (fv) return unimpl("frint32/64");
          // FCVTN(2): .2s from .2d, or .4h from .4s
          if (fdp) return done(narrowed(`S[${4 * SCRATCH}]=D[${2 * rn}];S[${4 * SCRATCH + 1}]=D[${2 * rn + 1}];`));
          return done(narrowed([...Array(4)].map((_, i) => `W[${8 * SCRATCH + i}]=c.f2hs(I[${4 * rn + i}]);`).join("")));
        case 23: {                                                                       // FCVTL: .4s from .4h, .2d from .2s (upper half when Q)
          const off = Q ? (fdp ? 2 : 4) : 0;
          if (fdp) return done(lanes(rd, 2, "D", (i) => `S[${4 * rn + off + i}]`, true, false, [rn]));
          return done(lanes(rd, 4, "S", (i) => `c.h2f(W[${8 * rn + off + i}])`, true, false, [rn]));
        }
        case 24: return done(each((i) => rounded(N(i), U ? (fv ? "X" : "A") : fv ? "P" : "N")));   // FRINTN/P, FRINTA/X
        case 25: return done(each((i) => rounded(N(i), U ? (fv ? "X" : "X") : fv ? "Z" : "M")));   // FRINTM/Z, FRINTX/I
        case 26: return done(toInts(fv ? "P" : "N", !!U));                              // FCVTNS/PS, FCVTNU/PU
        case 27: return done(toInts(fv ? "Z" : "M", !!U));                              // FCVTMS/ZS, FCVTMU/ZU
        case 28: if (!fv) return done(toInts("A", !!U));                                 // FCVTAS / FCVTAU
          return unimpl("urecpe/ursqrte");
        case 29: if (!fv) return done(each((i) => (fdp ? (U ? `(${hi64(rn, i)}>>>0)*4294967296+(${lo64(rn, i)}>>>0)` : `${hi64(rn, i)}*4294967296+(${lo64(rn, i)}>>>0)`) : U ? `U[${4 * rn + i}]` : `I[${4 * rn + i}]`)));   // SCVTF / UCVTF
          return done(each((i) => `c.${U ? "rsqrte" : "recpe"}(${N(i)},${fdp})`));      // FRECPE / FRSQRTE
        case 31: if (U) return done(each((i) => `Math.sqrt(${N(i)})`));                   // FSQRT
          if (scalar) return done(each((i) => `c.recpx(${N(i)},${fdp})`));                 // FRECPX
          return unimpl("two-misc");
        case 12: return done(fcmp0((i) => (U ? `${N(i)}>=0` : `${N(i)}>0`)));          // FCMGT #0 / FCMGE #0
        case 13: return done(fcmp0((i) => (U ? `${N(i)}<=0` : `${N(i)}===0`)));        // FCMEQ #0 / FCMLE #0
        case 14: return done(fcmp0((i) => `${N(i)}<0`));                                // FCMLT #0
        case 15: return done(fin(rd, [...Array(fcount)].map((_, i) => fdp
          ? `${lo64(rd, i)}=${lo64(rn, i)};${hi64(rd, i)}=${hi64(rn, i)}${U ? "^-2147483648" : "&0x7fffffff"};`
          : `I[${4 * rd + i}]=I[${4 * rn + i}]${U ? "^-2147483648" : "&0x7fffffff"};`).join("")));   // FABS / FNEG
      }
    }
    // integer
    const sv = iv(Math.min(size, 2), true), uv = iv(Math.min(size, 2), false);
    const eachI = (f: (i: number) => string, view: View = sv, safe = true) => finI(rd, lanes(rd, count, view, f, !!Q, safe, [rn]));
    const I64 = (f: (i: number) => [string, string], safe = true) => finI(rd, lanes64(rd, count, f, !!Q, safe, [rn]));
    switch (opcode) {
      case 0: case 1: {                                                                  // REV64 / REV32 (U) / REV16
        const group = opcode === 1 ? 2 : U ? 4 : 8;                                      // bytes reversed within
        if (bits / 8 >= group) return unimpl("rev");
        const per = bits / 8, n = group / per;
        const view = iv(size, false);
        return done(eachI((i) => lane(view, rn, (i - (i % n)) + (n - 1 - (i % n))), view, false));
      }
      case 2: case 6: {                                                                  // SADDLP / UADDLP, SADALP / UADALP
        if (size === 3) return unimpl("addlp .2d");
        const wide = size + 1, wv = iv(Math.min(wide, 2), !U), acc = opcode === 6, srcv = iv(size, !U);
        const wcount = count / 2;
        if (wide === 3) return done(finI(rd, lanes64(rd, wcount, (i) => acc
          ? [`(v=${lane(srcv, rn, 2 * i)}+${lane(srcv, rn, 2 * i + 1)},a=(${lo64(rd, i)}>>>0)+v,a)|0`, `(${hi64(rd, i)}+Math.floor(a/4294967296))|0`]
          : split64(`(${lane(srcv, rn, 2 * i)}+${lane(srcv, rn, 2 * i + 1)})`), !!Q, false, [rn])));
        return done(finI(rd, lanes(rd, wcount, wv, (i) => `${acc ? `${lane(wv, rd, i)}+` : ""}${lane(srcv, rn, 2 * i)}+${lane(srcv, rn, 2 * i + 1)}`, !!Q, false, [rn])));
      }
      case 4: if (size === 3) return unimpl("cls/clz .2d");                              // CLS / CLZ
        return done(eachI((i) => (U ? `Math.clz32(${lane(uv, rn, i)})-${32 - bits}` : `Math.clz32(${lane(sv, rn, i)}^(${lane(sv, rn, i)}>>${bits - 1}))-${32 - bits + 1}`)));
      case 5: if (U && size === 1) return done(finI(rd, lanes(rd, Q ? 16 : 8, "B", (i) => `c.rbit32(B[${16 * rn + i}])>>>24`, !!Q)));   // RBIT
        if (!U && size === 0) return done(eachI((i) => `c.pop8(${lane(uv, rn, i)})`, uv));             // CNT
        return unimpl("two-misc");
      case 7: if (size === 3) return done(I64((i) => [`(c.sat64(0,0,${lo64(rn, i)},${hi64(rn, i)},true,false),${U ? "c.lo" : `${hi64(rn, i)}<0?c.lo:${lo64(rn, i)}`})`, U ? "c.hi" : `(${hi64(rn, i)}<0?c.hi:${hi64(rn, i)})`]));   // SQABS / SQNEG .2d
        return done(eachI((i) => sat(U ? `(-${lane(sv, rn, i)})` : `Math.abs(${lane(sv, rn, i)})`, bits, true)));
      case 8: if (size === 3) return done(I64((i) => [`(${U ? `${hi64(rn, i)}>=0` : `${hi64(rn, i)}>0||(${hi64(rn, i)}===0&&${lo64(rn, i)}!==0)`})?-1:0`, "t"]));   // CMGT #0 / CMGE #0
        return done(eachI((i) => `${lane(sv, rn, i)}${U ? ">=" : ">"}0?-1:0`));
      case 9: if (size === 3) return done(I64((i) => [`(${U ? `${hi64(rn, i)}<0||(${hi64(rn, i)}===0&&${lo64(rn, i)}===0)` : `${hi64(rn, i)}===0&&${lo64(rn, i)}===0`})?-1:0`, "t"]));   // CMEQ #0 / CMLE #0
        return done(eachI((i) => `${lane(sv, rn, i)}${U ? "<=" : "==="}0?-1:0`));
      case 10: if (U) return unimpl("two-misc");
        if (size === 3) return done(I64((i) => [`${hi64(rn, i)}<0?-1:0`, "t"]));         // CMLT #0
        return done(eachI((i) => `${lane(sv, rn, i)}<0?-1:0`));
      case 11: if (size === 3) return done(I64((i) => {                                  // ABS / NEG .2d
        const [l, h] = [lo64(rn, i), hi64(rn, i)];
        const neg: [string, string] = [`(-${l})|0`, `(~${h}+((${l}>>>0)===0?1:0))|0`];
        return U ? neg : [`${h}<0?${neg[0]}:${l}`, `${h}<0?${neg[1]}:${h}`];
      }));
        return done(eachI((i) => (U ? `-${lane(sv, rn, i)}` : `Math.abs(${lane(sv, rn, i)})`)));
      case 18: case 20: {                                                                // XTN(2) / SQXTUN(2) (U, 18); SQXTN(2) / UQXTN(2) (20)
        if (size === 3) return unimpl("xtn .1q");
        const outSigned = opcode === 20 && !U, srcSigned = !(opcode === 20 && U), outv = iv(size, outSigned);
        const src = (i: number) => (size === 2
          ? (srcSigned ? `(${hi64(rn, i)}*4294967296+(${lo64(rn, i)}>>>0))` : `((${hi64(rn, i)}>>>0)*4294967296+(${lo64(rn, i)}>>>0))`)
          : lane(iv(size + 1, srcSigned), rn, i));
        const f = (i: number) => (opcode === 18 && !U ? (size === 2 ? lo64(rn, i) : lane(iv(size + 1, false), rn, i)) : sat(src(i), bits, outSigned));
        let body = "";
        for (let i = 0; i < (scalar ? 1 : 64 / bits); i++) body += `${lane(outv, SCRATCH, i)}=${f(i)};`;
        return done(narrowed(body));
      }
      case 19: {                                                                         // SHLL(2): widen and shift left by the element size
        if (!U || size === 3) return unimpl("shll");
        const half = 64 / bits, off = Q ? half : 0, wv = iv(Math.min(size + 1, 2), false);
        if (size === 2) return done(lanes64(rd, half, (i) => [`0`, lane(uv, rn, off + i)], true, false, [rn]));
        return done(lanes(rd, half, wv, (i) => `${lane(uv, rn, off + i)}<<${bits}`, true, false, [rn]));
      }
    }
    return unimpl("two-misc");
  }

  // ── across lanes (0Q U 01110 size 11000 opcode 10) and the scalar pairwise forms (01 U 11110 size 11000 ...)
  if (is(w, 0x8f3e0c00, 0x0e300800) && (!(w & 0x10000000) || (w & 0x40000000))) {
    const opcode = (w >>> 12) & 31;
    const vcount = (q ? 128 : 64) / bits;
    if (scalar) {                                                                        // pairwise: two lanes of Vn into one scalar
      if (!U && opcode === 27) return done(lanes64(rd, 1, () => [`(${lo64(rn, 0)}+${lo64(rn, 1)})|0`, `(${hi64(rn, 0)}+${hi64(rn, 1)}+(((${lo64(rn, 0)}>>>0)+(${lo64(rn, 1)}>>>0))>4294967295?1:0))|0`], false));   // ADDP d
      if (!U) return unimpl("scalar pairwise");
      const a = F(rn, 0), b = F(rn, 1);
      if (opcode === 12) return done(fin(rd, fdp ? `c.fnm64(${lo64(rn, 0)},${hi64(rn, 0)},${lo64(rn, 1)},${hi64(rn, 1)},${!fv});I[${4 * rd}]=c.lo;I[${4 * rd + 1}]=c.hi;` : `I[${4 * rd}]=c.fnm32(I[${4 * rn}],I[${4 * rn + 1}],${!fv});`));
      const e = opcode === 13 ? `${a}+${b}` : opcode === 15 ? `Math.${fv ? "min" : "max"}(${a},${b})` : null;
      if (e === null) return unimpl("scalar pairwise");
      return done(fin(rd, `${F(rd, 0)}=${e};`));
    }
    if (U && (opcode === 12 || opcode === 15)) {                                          // FMAXNMV/FMINNMV, FMAXV/FMINV (.4s)
      if (fdp || !q) return unimpl("fmaxv");
      const fn = fv ? "min" : "max";
      if (opcode === 15) { let body = `a=S[${4 * rn}];`; for (let i = 1; i < 4; i++) body += `a=Math.${fn}(a,S[${4 * rn + i}]);`; return done(body + `S[${4 * rd}]=a;` + zeroS(rd)); }
      let body = `t=I[${4 * rn}];`;
      for (let i = 1; i < 4; i++) body += `t=c.fnm32(t,I[${4 * rn + i}],${!fv});`;
      return done(body + `I[${4 * rd}]=t;` + zeroS(rd));
    }
    if (size === 3) return unimpl("across .2d");
    const V = iv(size, !U);
    const all = [...Array(vcount)].map((_, i) => lane(V, rn, i));
    // a B or H result is written as its whole word, so nothing of the old word survives
    const scalarOut = (esz: number, e: string) => (esz === 0 ? `I[${4 * rd}]=(${e})&255;` : esz === 1 ? `I[${4 * rd}]=(${e})&65535;` : `I[${4 * rd}]=${e};`) + zeroS(rd);
    switch (opcode) {
      case 3: {                                                                          // SADDLV / UADDLV: the sum, one size wider
        const t = all.join("+");
        if (size === 2) return done(`t=${t};I[${4 * rd}]=t;I[${4 * rd + 1}]=Math.floor(t/4294967296);` + zeroHi(rd));
        return done(scalarOut(size + 1, t));
      }
      case 10: return done(scalarOut(size, `Math.max(${all.join(",")})`));                 // SMAXV / UMAXV
      case 26: return done(scalarOut(size, `Math.min(${all.join(",")})`));                 // SMINV / UMINV
      case 27: return done(scalarOut(size, all.join("+")));                                 // ADDV
    }
    return unimpl("across lanes");
  }

  // ── shift by immediate (0Q U 011110 immh immb opcode 1, scalar 01 U 111110 ...)
  if ((is(w, 0x9f800400, 0x0f000400) || is(w, 0xdf800400, 0x5f000400)) && ((w >>> 19) & 15)) {
    const immh = (w >>> 19) & 15, immb = (w >>> 16) & 7, opcode = (w >>> 11) & 31;
    const esz = immh & 8 ? 3 : immh & 4 ? 2 : immh & 2 ? 1 : 0, ebits = BITS[esz];
    const shr = 2 * ebits - ((immh << 3) | immb), shl = ((immh << 3) | immb) - ebits;
    const ecount = scalar ? 1 : (Q ? 128 : 64) / ebits;
    const finS = (d: number, body: string) => body + (scalar ? (esz === 3 ? zeroHi(d) : narrowClear(d, esz) + zeroS(d)) : Q ? "" : zeroHi(d));
    if (esz === 3) {                                                                     // 64-bit lanes: constant shifts split at emit time
      const each64 = (f: (i: number) => [string, string]) => finS(rd, lanes64(rd, ecount, f, !!Q));
      const src = (i: number): [string, string] => [lo64(rn, i), hi64(rn, i)];
      switch (opcode) {
        case 0: return done(each64((i) => (U ? shr64(...src(i), shr) : sar64(...src(i), shr))));                        // SSHR / USHR
        case 2: return done(each64((i) => { const [l, h] = U ? shr64(...src(i), shr) : sar64(...src(i), shr); return [`(${lo64(rd, i)}+${l})|0`, `(${hi64(rd, i)}+${h}+(((${lo64(rd, i)}>>>0)+(${l}>>>0))>4294967295?1:0))|0`]; }));   // SSRA / USRA
        case 4: return done(each64((i) => [`(c.rshr64(${lo64(rn, i)},${hi64(rn, i)},${shr},${!!U}),c.lo)`, "c.hi"]));   // SRSHR / URSHR
        case 6: return done(each64((i) => [`(c.rshr64(${lo64(rn, i)},${hi64(rn, i)},${shr},${!!U}),a=c.lo,ah=c.hi,(${lo64(rd, i)}+a)|0)`, `(${hi64(rd, i)}+ah+(((${lo64(rd, i)}>>>0)+(a>>>0))>4294967295?1:0))|0`]));   // SRSRA / URSRA
        case 8: {                                                                                                        // SRI: the top n bits of Vd kept
          if (!U) return unimpl("shift .2d");
          const m = (2n ** 64n - 1n) >> BigInt(shr), ml = Number(m & 0xffffffffn) | 0, mh = Number((m >> 32n) & 0xffffffffn) | 0;
          return done(each64((i) => { const [l, h] = shr64(...src(i), shr); return [`(${lo64(rd, i)}&${~ml})|${l}`, `(${hi64(rd, i)}&${~mh})|${h}`]; }));
        }
        case 10: {
          if (!U) return done(each64((i) => shl64(...src(i), shl)));                                                     // SHL
          const m = ((2n ** 64n - 1n) << BigInt(shl)) & (2n ** 64n - 1n), ml = Number(m & 0xffffffffn) | 0, mh = Number((m >> 32n) & 0xffffffffn) | 0;
          return done(each64((i) => { const [l, h] = shl64(...src(i), shl); return [`(${lo64(rd, i)}&${~ml})|${l}`, `(${hi64(rd, i)}&${~mh})|${h}`]; }));   // SLI
        }
        case 12: case 14: return done(each64((i) => [`(c.sqshl64(${lo64(rn, i)},${hi64(rn, i)},${shl},${opcode === 12 || !!U},${opcode === 12 || !U}),c.lo)`, "c.hi"]));   // SQSHLU, SQSHL / UQSHL
        case 28: return done(fin(rd, lanes(rd, ecount, "D", (i) => `(${U ? `(${hi64(rn, i)}>>>0)` : hi64(rn, i)}*4294967296+(${lo64(rn, i)}>>>0))/${2 ** shr}`, !!Q)));   // SCVTF / UCVTF fixed .2d
        case 31: return done(fin(rd, [...Array(ecount)].map((_, i) => `t=Math.trunc(D[${2 * rn + i}]*${2 ** shr});c.cvt64(t,${U ? 0 : 1});${lo64(rd, i)}=c.lo;${hi64(rd, i)}=c.hi;`).join("")));   // FCVTZS / FCVTZU fixed .2d
      }
      return unimpl("shift .2d");
    }
    const sv = iv(esz, true), uv = iv(esz, false), V = iv(esz, !U);
    const N = (i: number) => lane(V, rn, i), Dd = (i: number) => lane(V, rd, i);
    const each = (f: (i: number) => string, view: View = V, safe = true) => finS(rd, lanes(rd, ecount, view, f, !!Q, safe, [rn]));
    const rsh = (a: string, round: boolean) => (round ? `Math.floor((${a}+${2 ** (shr - 1)})/${2 ** shr})`
      : shr >= ebits ? (U ? "0" : `(${a}>>${ebits - 1})`) : U ? `(${a}>>>${shr})` : `(${a}>>${shr})`);
    switch (opcode) {
      case 0: case 4: return done(each((i) => rsh(N(i), opcode === 4)));                                                 // SSHR / USHR / SRSHR / URSHR
      case 2: case 6: return done(each((i) => `${Dd(i)}+${rsh(N(i), opcode === 6)}`));                                   // SSRA / USRA / SRSRA / URSRA
      case 8: if (!U) return unimpl("shift");                                                                            // SRI
        return done(each((i) => `(${Dd(i)}&${(~(2 ** ebits - 1 >>> shr)) & (2 ** ebits - 1)})|(${N(i)}>>>${shr})`, uv));
      case 10: if (!U) return done(each((i) => `${N(i)}<<${shl}`));                                                      // SHL
        return done(each((i) => `(${Dd(i)}&${2 ** shl - 1})|(${N(i)}<<${shl})`, uv));                                    // SLI
      case 12: if (!U) return unimpl("shift");
        return done(each((i) => sat(`(${lane(sv, rn, i)}*${2 ** shl})`, ebits, false), uv));                             // SQSHLU
      case 14: return done(each((i) => sat(`(${N(i)}*${2 ** shl})`, ebits, !U)));                                        // SQSHL / UQSHL
      case 16: case 17: case 18: case 19: {                                                                              // SHRN/RSHRN, SQSHRUN/SQRSHRUN (U), SQSHRN/UQSHRN, SQRSHRN/UQRSHRN
        // narrow from lanes twice as wide; the "2" form writes the upper half and keeps the lower
        const wide = esz + 1, round = (opcode & 1) === 1, wcount = Q ? ecount / 2 : ecount;
        const plain = opcode <= 17 && !U, srcSigned = !(opcode >= 18 && U), outSigned = opcode >= 18 && !U;
        const srcv = (i: number) => lane(iv(wide, plain ? false : srcSigned), rn, i);
        const shifted = (i: number) => (round ? `Math.floor((${srcv(i)}+${2 ** (shr - 1)})/${2 ** shr})` : `Math.floor(${srcv(i)}/${2 ** shr})`);
        // a 64-bit lane shifts exactly through its halves; the saturation reads the high half
        const from64 = (i: number) => {
          const sh = round ? `c.rshr64(${lo64(rn, i)},${hi64(rn, i)},${shr},${!srcSigned})` : `c.shift64(${lo64(rn, i)},${hi64(rn, i)},${shr},${srcSigned ? 2 : 1})`;
          if (plain) return `(${sh},c.lo)`;
          if (outSigned) return `(${sh},c.hi===(c.lo>>31)?c.lo:c.hi<0?-2147483648:2147483647)`;
          return srcSigned ? `(${sh},c.hi<0?0:c.hi===0?c.lo:-1)` : `(${sh},c.hi===0?c.lo:-1)`;
        };
        const f = (i: number) => (wide === 3 ? from64(i) : plain ? shifted(i) : sat(shifted(i), ebits, outSigned));
        let body = "";
        for (let i = 0; i < wcount; i++) body += `${lane(iv(esz, outSigned), SCRATCH, i)}=${f(i)};`;
        return done(narrowed(body, esz));
      }
      case 20: {                                                                         // SSHLL / USHLL (SXTL / UXTL): widen from the low (or high, Q) half
        const wide = esz + 1, off = Q ? ecount / 2 : 0, wcount = Q ? ecount / 2 : ecount;
        if (wide === 3) return done(lanes64(rd, wcount, (i) => shl64(lane(V, rn, off + i), U ? "0" : `(${lane(V, rn, off + i)}>>31)`, shl), true, false, [rn]));
        return done(lanes(rd, wcount, iv(wide, !U), (i) => `${N(off + i)}<<${shl}`, true, false, [rn]));
      }
      case 28: return done(fin(rd, lanes(rd, ecount, "S", (i) => `${N(i)}/${2 ** shr}`, !!Q)));                           // SCVTF / UCVTF fixed (.s)
      case 31: return done(fin(rd, [...Array(ecount)].map((_, i) => `t=Math.trunc(S[${4 * rn + i}]*${2 ** shr});I[${4 * rd + i}]=${U ? "(t!==t||t<=0?0:t>=4294967295?-1:t|0)" : "(t!==t?0:t>=2147483647?2147483647:t<=-2147483648?-2147483648:t|0)"};`).join("")));   // FCVTZS / FCVTZU fixed
    }
    return unimpl("shift");
  }

  // ── by element (0Q U 01111 size L M Rm opcode H 0, scalar 01 U 11111 ...)
  if ((is(w, 0x9f000400, 0x0f000000) || is(w, 0xdf000400, 0x5f000000))) {
    const L = (w >>> 21) & 1, M = (w >>> 20) & 1, H = (w >>> 11) & 1, opcode = (w >>> 12) & 15, rmLow = (w >>> 16) & 15;
    const fp = opcode === 1 || opcode === 5 || opcode === 9;
    if (fp) {
      if (!(size & 2)) return unimpl("fp16 by element");
      const dp = (size & 1) === 1, idx = dp ? H : (H << 1) | L, m = (M << 4) | rmLow;
      if (dp && L) return unimpl("by element");
      const view: View = dp ? "D" : "S", cnt = scalar ? 1 : (Q ? 128 : 64) / (dp ? 64 : 32);
      const pre = `t=${lane(view, m, idx)};`;
      const f = (i: number) => (opcode === 9 ? (U ? `c.fmulx(${lane(view, rn, i)},t)` : `${lane(view, rn, i)}*t`)
        : dp ? `c.fma(${opcode === 5 ? "-" : ""}${lane(view, rn, i)},t,${lane(view, rd, i)})`
          : opcode === 1 ? `${lane(view, rd, i)}+${lane(view, rn, i)}*t` : `${lane(view, rd, i)}-${lane(view, rn, i)}*t`);
      return done(pre + lanes(rd, cnt, view, f, !!Q) + (scalar ? (dp ? zeroHi(rd) : zeroS(rd)) : ""));
    }
    if (scalar) return unimpl("scalar by element");
    if (size !== 1 && size !== 2) return unimpl("by element");
    const idx = size === 1 ? (H << 2) | (L << 1) | M : (H << 1) | L, m = size === 1 ? rmLow : (M << 4) | rmLow;
    const sv = iv(size, true), uv = iv(size, false);
    const el = `t=${lane(sv, m, idx)};`;
    const mul = (i: number) => (size === 2 ? `Math.imul(${lane(sv, rn, i)},t)` : `${lane(sv, rn, i)}*t`);
    switch (opcode) {
      case 8: return done(el + finI(rd, lanes(rd, count, sv, mul, !!Q)));                                               // MUL
      case 0: case 4: if (!U) return unimpl("by element");
        return done(el + finI(rd, lanes(rd, count, uv, (i) => `${lane(uv, rd, i)}${opcode === 0 ? "+" : "-"}${mul(i)}`, !!Q)));   // MLA / MLS
      case 10: case 2: case 6: {                                                         // SMULL/UMULL, SMLAL/UMLAL, SMLSL/UMLSL by element
        const wcount = 64 / bits, off = Q ? wcount : 0, V = iv(size, !U);
        const elv = `v=${lane(V, m, idx)};`;
        if (size === 2) {
          const acc = opcode === 10 ? "" : opcode === 2 ? "+" : "-";
          return done(elv + lanes64(rd, wcount, (i) => { const p = `c.${U ? "umull" : "smull"}(${lane(V, rn, off + i)},v)`; return acc ? [`(${p},a=c.lo,ah=c.hi,(${lo64(rd, i)}${acc}a)|0)`, `(${hi64(rd, i)}${acc}ah${acc === "+" ? `+(((${lo64(rd, i)}>>>0)+(a>>>0))>4294967295?1:0)` : `-((${lo64(rd, i)}>>>0)<(a>>>0)?1:0)`})|0`] : [`(${p},c.lo)`, "c.hi"]; }, true, false, [rn]));
        }
        const wv = iv(2, !U);
        return done(elv + lanes(rd, wcount, wv, (i) => (opcode === 10 ? `${lane(V, rn, off + i)}*v` : `${lane(wv, rd, i)}${opcode === 2 ? "+" : "-"}${lane(V, rn, off + i)}*v`), true, false, [rn]));
      }
      case 12: case 13: {                                                                // SQDMULH / SQRDMULH by element
        const round = opcode === 13 ? `+${2 ** (bits - 1)}` : "";
        return done(el + finI(rd, lanes(rd, count, sv, (i) => sat(`Math.floor((2*${lane(sv, rn, i)}*t${round})/${2 ** bits})`, bits, true), !!Q)));
      }
      case 14: {                                                                         // SDOT / UDOT by element
        if (size !== 2) return unimpl("dot");
        const bv = iv(0, !U);
        return done(finI(rd, lanes(rd, count, "I", (i) => `(I[${4 * rd + i}]+${[0, 1, 2, 3].map((k) => `${lane(bv, rn, 4 * i + k)}*${lane(bv, m, 4 * idx + k)}`).join("+")})|0`, !!Q)));
      }
    }
    return unimpl("by element");
  }

  // ── three-register extension: SDOT / UDOT (0Q U 01110 size 0 Rm 1001 01)
  if (is(w, 0x9f20fc00, 0x0e009400)) {
    if (size !== 2) return unimpl("dot");
    const bv = iv(0, !U);
    return done(finI(rd, lanes(rd, count, "I", (i) => `(I[${4 * rd + i}]+${[0, 1, 2, 3].map((k) => `${lane(bv, rn, 4 * i + k)}*${lane(bv, rm, 4 * i + k)}`).join("+")})|0`, !!Q)));
  }

  // ── three-different (0Q U 01110 size 1 Rm opcode 00): widening and narrowing
  if (is(w, 0x9f200c00, 0x0e200000) && !(w & 0x10000000)) {
    const opcode = (w >>> 12) & 15;
    if (size === 3) return unimpl("three-different .2d");
    const wide = size + 1, wcount = 64 / bits, off = q ? wcount : 0;
    const narrowing = opcode === 4 || opcode === 6;
    const V = iv(size, !U);
    const N = (i: number) => lane(V, rn, off + i), Mm = (i: number) => lane(V, rm, off + i);
    if (narrowing) {                                                                     // ADDHN / RADDHN / SUBHN / RSUBHN: the high half of the wide op
      const wv = iv(Math.min(wide, 2), false), nv = iv(size, false), half = bits;
      const rnd = U ? `+${2 ** (half - 1)}` : "";
      const sign = opcode === 4 ? "+" : "-";
      const f = (i: number) => (wide === 3
        ? `${hi64(rn, i)}${sign}${hi64(rm, i)}+Math.floor(((${lo64(rn, i)}>>>0)${sign}(${lo64(rm, i)}>>>0)${U ? "+2147483648" : ""})/4294967296)`
        : `Math.floor(((${lane(wv, rn, i)}${sign}${lane(wv, rm, i)}${rnd})&${2 ** (2 * half) - 1})/${2 ** half})`);
      let body = "";
      for (let i = 0; i < wcount; i++) body += `${lane(nv, SCRATCH, i)}=${wide === 3 ? `((${f(i)})|0)` : f(i)};`;
      const words2 = q ? [`I[${4 * rd + 2}]=I[${4 * SCRATCH}];`, `I[${4 * rd + 3}]=I[${4 * SCRATCH + 1}];`] : [`I[${4 * rd}]=I[${4 * SCRATCH}];`, `I[${4 * rd + 1}]=I[${4 * SCRATCH + 1}];`, zeroHi(rd)];
      return done(body + words2.join(""));
    }
    if (wide === 3) {                                                                    // results are .2d
      const each64 = (f: (i: number) => [string, string]) => lanes64(rd, wcount, f, true, false, [rn, rm]);
      switch (opcode) {
        case 0: return done(each64((i) => split64(`(${N(i)}+${Mm(i)})`)));                                          // SADDL / UADDL
        case 2: return done(each64((i) => split64(`(${N(i)}-${Mm(i)})`)));                                              // SSUBL / USUBL
        case 1: case 3: return done(each64((i) => { const [al, ah] = [lo64(rn, i), hi64(rn, i)]; const b = lane(V, rm, off + i); const sign = opcode === 1 ? "+" : "-"; return [`(${al}${sign}${b})|0`, `(${ah}${sign}${U ? "0" : `(${b}>>31)`}${sign === "+" ? `+(((${al}>>>0)+(${b}>>>0))>4294967295?1:0)` : `-((${al}>>>0)<(${b}>>>0)?1:0)`})|0`]; }));   // SADDW / UADDW / SSUBW / USUBW
        case 7: return done(each64((i) => split64(`Math.abs(${N(i)}-${Mm(i)})`)));                                     // SABDL / UABDL
        case 5: return done(each64((i) => { const d = `Math.abs(${N(i)}-${Mm(i)})`; return [`(${lo64(rd, i)}+${d})|0`, `(${hi64(rd, i)}+Math.floor(${d}/4294967296)+(((${lo64(rd, i)}>>>0)+(${d}%4294967296))>4294967295?1:0))|0`]; }));   // SABAL / UABAL
        case 12: return done(each64((i) => [`(c.${U ? "umull" : "smull"}(${N(i)},${Mm(i)}),c.lo)`, "c.hi"]));         // SMULL / UMULL
        case 8: case 10: return done(each64((i) => { const sign = opcode === 8 ? "+" : "-"; return [`(c.${U ? "umull" : "smull"}(${N(i)},${Mm(i)}),a=c.lo,ah=c.hi,(${lo64(rd, i)}${sign}a)|0)`, `(${hi64(rd, i)}${sign}ah${sign === "+" ? `+(((${lo64(rd, i)}>>>0)+(a>>>0))>4294967295?1:0)` : `-((${lo64(rd, i)}>>>0)<(a>>>0)?1:0)`})|0`]; }));   // SMLAL / UMLAL / SMLSL / UMLSL
      }
      return unimpl("three-different");
    }
    const wv = iv(wide, !U);
    const each = (f: (i: number) => string) => lanes(rd, wcount, wv, f, true, false, [rn, rm]);
    const Dd = (i: number) => lane(wv, rd, i);
    switch (opcode) {
      case 0: return done(each((i) => `${N(i)}+${Mm(i)}`));                                                             // SADDL / UADDL
      case 1: return done(each((i) => `${lane(wv, rn, i)}+${Mm(i)}`));                                                  // SADDW / UADDW
      case 2: return done(each((i) => `${N(i)}-${Mm(i)}`));                                                             // SSUBL / USUBL
      case 3: return done(each((i) => `${lane(wv, rn, i)}-${Mm(i)}`));                                                  // SSUBW / USUBW
      case 5: return done(each((i) => `${Dd(i)}+Math.abs(${N(i)}-${Mm(i)})`));                                          // SABAL / UABAL
      case 7: return done(each((i) => `Math.abs(${N(i)}-${Mm(i)})`));                                                   // SABDL / UABDL
      case 8: return done(each((i) => `${Dd(i)}+${N(i)}*${Mm(i)}`));                                                    // SMLAL / UMLAL
      case 10: return done(each((i) => `${Dd(i)}-${N(i)}*${Mm(i)}`));                                                   // SMLSL / UMLSL
      case 12: return done(each((i) => `${N(i)}*${Mm(i)}`));                                                            // SMULL / UMULL
      case 14: if (U || size !== 0) return unimpl("pmull");
        return done(each((i) => `c.pmul8(B[${16 * rn + off + i}],B[${16 * rm + off + i}])`));                             // PMULL .8h
    }
    return unimpl("three-different");
  }
  return null;
}
