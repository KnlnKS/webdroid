// The A64 SIMD&FP emitter, on a64.ts's contract: each instruction becomes straight-line JS over
// the V register file's lane views (see a64regs.ts), unrolled per lane, with no helper call on
// the common path and no BigInt anywhere. Moves, loads, stores, inserts and permutes go through
// the integer views so a NaN keeps its payload; arithmetic goes through the float views.
//
// An op that is not element-wise (ext, zip, tbl, a pairwise or narrowing op) reads lanes its
// own destination is about to overwrite when Vd is also a source, so `lanes` targets the scratch
// register V32 and copies back in that case — decided at emit time, free when registers differ.

import { type Fl, hex } from "./flags";
import { sp, sph, zr, zrh, setX, setW, lane, zeroHi, zeroS, words, SCRATCH, type View } from "./a64regs";
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

  push(fault("unimplemented"));
  return true;
}
