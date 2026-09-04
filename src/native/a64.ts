// AArch64 (A64) decoder → JS source for one basic block, on the same contract as arm.ts: each
// instruction becomes straight-line JS over the Cpu (`c`), the low halves of its register file
// (`r`), the high halves (`H` = c.h) and guest memory (`M`); the block ends at the first
// instruction that can write pc and returns the next block.
//
// The register file is split hi/lo rather than BigInt, measured: on a data-dependent chain of
// 50M emulated adds, a split Int32Array pair costs 53ms against the 32-bit tier's 52ms, while
// BigInt64Array costs 1,686ms. A W-form write zero-extends into its X register architecturally,
// so `H[d]=0` is the whole cost of the 32-bit half of the ISA.
//
// x31 is SP or the zero register depending on the instruction, which is why every operand goes
// through one of two accessors rather than being spelled directly. Guest addresses are under
// 4 GiB by construction, so an address is the low half alone.

import { mem } from "./mem";
import { PAGE_SIZE, PAGE_SHIFT } from "./abi";
import { type Ins, type Fl, C, ALL, COND, COND_READS, NZ, ADDF, SUBF, hex, assemble, hoistRegs, inlineMem, selfLoop, retK } from "./flags";

let MAX_BLOCK = 256;
/** 1 = single-instruction blocks (the step tracer) */
export function setMaxBlockA64(n: number): void { MAX_BLOCK = n; }

interface BlockSrc { src: string; len: number; end: number; slots: number }

// ── operands. x31 reads as SP in one family of instructions and as zero in the other.
const SP = 31;
const sp = (n: number) => `r[${n}]`;
const sph = (n: number) => `H[${n}]`;
const zr = (n: number) => (n === SP ? "0" : `r[${n}]`);
const zrh = (n: number) => (n === SP ? "0" : `H[${n}]`);
/** write a 64-bit result to a zero-register-encoded destination */
const setX = (d: number, lo: string, hi: string) => (d === SP ? "" : `r[${d}]=${lo};H[${d}]=${hi};`);
/** write a 32-bit result: A64 zero-extends every W write into its X register */
const setW = (d: number, lo: string) => (d === SP ? "" : `r[${d}]=${lo};H[${d}]=0;`);
/** write to a stack-pointer-encoded destination (ADD/SUB immediate with S=0) */
const setSP = (d: number, lo: string, hi: string) => `r[${d}]=${lo};H[${d}]=${hi};`;

// ── flags. NZCV is ARM's, so COND/COND_READS carry over unchanged; only the 64-bit forms are new.
// the 32-bit forms are ARM's own, bit for bit: NZ/ADDF/SUBF from flags.ts. Only the 64-bit ones
// and the logical form (which clears C and V rather than leaving them) are new here.
const LOG32: Fl = { ...NZ, c: "c.c=0;", v: "c.v=0;" };
const NZ64: Fl = { n: "c.n=vh>>>31;", z: "c.z=(v|vh)===0?1:0;" };
const ADD64: Fl = {
  ...NZ64,
  c: "c.c=((ah>>>0)+(th>>>0)+(((a>>>0)+(t>>>0))>4294967295?1:0))>4294967295?1:0;",
  v: "c.v=((ah^vh)&(th^vh))>>>31;",
};
const SUB64: Fl = {
  ...NZ64,
  c: "c.c=((ah>>>0)>(th>>>0)||((ah>>>0)===(th>>>0)&&(a>>>0)>=(t>>>0)))?1:0;",
  v: "c.v=((ah^th)&(ah^vh))>>>31;",
};
const LOG64: Fl = { ...NZ64, c: "c.c=0;", v: "c.v=0;" };

/** the add/sub cores. `a`/`ah` and `t`/`th` hold the operands; `v`/`vh` the result. */
const ADD_CORE64 = "v=(a+t)|0;vh=(ah+th+(((a>>>0)+(t>>>0))>4294967295?1:0))|0;";
const SUB_CORE64 = "v=(a-t)|0;vh=(ah-th-((a>>>0)<(t>>>0)?1:0))|0;";

// ── constant shifts of a 64-bit value held as two expressions. Every A64 shift whose amount is
// in the encoding is constant, so the split is resolved here and costs nothing at run time.
function shl64(lo: string, hi: string, s: number): [string, string] {
  if (s === 0) return [lo, hi];
  if (s === 32) return ["0", lo];
  if (s > 32) return ["0", `(${lo}<<${s - 32})`];
  return [`(${lo}<<${s})`, `((${hi}<<${s})|(${lo}>>>${32 - s}))`];
}
function shr64(lo: string, hi: string, s: number): [string, string] {
  if (s === 0) return [lo, hi];
  if (s === 32) return [hi, "0"];
  if (s > 32) return [`(${hi}>>>${s - 32})`, "0"];
  return [`((${lo}>>>${s})|(${hi}<<${32 - s}))`, `(${hi}>>>${s})`];
}
function sar64(lo: string, hi: string, s: number): [string, string] {
  if (s === 0) return [lo, hi];
  if (s === 32) return [hi, `(${hi}>>31)`];
  if (s > 32) return [`(${hi}>>${s - 32})`, `(${hi}>>31)`];
  return [`((${lo}>>>${s})|(${hi}<<${32 - s}))`, `(${hi}>>${s})`];
}
function ror64(lo: string, hi: string, s: number): [string, string] {
  s &= 63;
  if (s === 0) return [lo, hi];
  const [al, ah] = shr64(lo, hi, s);
  const [bl, bh] = shl64(lo, hi, 64 - s);
  return [`(${al}|${bl})`, `(${ah}|${bh})`];
}
/** LSL/LSR/ASR/ROR of a 64- or 32-bit operand by a constant */
function shiftOf(lo: string, hi: string, type: number, s: number, sf: boolean): [string, string] {
  if (sf) return type === 0 ? shl64(lo, hi, s) : type === 1 ? shr64(lo, hi, s) : type === 2 ? sar64(lo, hi, s) : ror64(lo, hi, s);
  if (s === 0) return [lo, "0"];
  if (type === 0) return [`(${lo}<<${s})`, "0"];
  if (type === 1) return [`(${lo}>>>${s})`, "0"];
  if (type === 2) return [`(${lo}>>${s})`, "0"];
  return [`((${lo}>>>${s})|(${lo}<<${32 - s}))`, "0"];
}

/** ARM's DecodeBitMasks, evaluated here because N/imms/immr are always encoding constants.
 *  Returns null for the encodings the architecture leaves undefined. */
function bitMasks(n: number, imms: number, immr: number, sf: boolean, immediate: boolean): { wmask: bigint; tmask: bigint } | null {
  const width = sf ? 64 : 32;
  const combined = (n << 6) | (~imms & 0x3f);
  const len = 31 - Math.clz32(combined);
  if (len < 1 || (1 << len) > width) return null;
  const levels = (1 << len) - 1;
  const s = imms & levels, r = immr & levels;
  if (immediate && s === levels) return null;   // bitfield allows it; a logical immediate does not
  const d = (s - r) & levels;
  const esize = 1 << len;
  const ones = (k: number) => (k >= 64 ? -1n : (1n << BigInt(k)) - 1n);
  const rot = (v: bigint, k: number, size: number) => {
    const m = ones(size);
    const kk = k % size;
    return ((v >> BigInt(kk)) | (v << BigInt(size - kk))) & m;
  };
  const rep = (v: bigint, size: number) => {
    let out = 0n;
    for (let i = 0; i < width / size; i++) out |= v << BigInt(i * size);
    return out & ones(width);
  };
  return { wmask: rep(rot(ones(s + 1), r, esize), esize), tmask: rep(ones(d + 1), esize) };
}
const lo32 = (v: bigint) => Number(BigInt.asIntN(32, v));
const hi32 = (v: bigint) => Number(BigInt.asIntN(32, v >> 32n));

const sx = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);
/** a constant bound for a register: spelled as the int32 the register file would hold, because a
 *  hoisted local keeps the literal as written and `0xffffffff` is not -1 to `>` or `===` */
const int32 = (n: number) => String(n | 0);

// System registers, keyed on the encoding's op0:op1:CRn:CRm:op2. A read the table cannot answer
// faults by name; the ID registers read as "no optional features" so a runtime keeps to its
// generic paths, and DCZID says DC ZVA is prohibited so memset never issues one.
function sysRead(key: number, rd: number): string | null {
  switch (key) {
    case 0x5a10: return setX(rd, "((c.n<<31)|(c.z<<30)|(c.c<<29)|(c.v<<28))", "0");    // NZCV
    case 0x5a20: return setX(rd, "c.fpcr", "0");                                        // FPCR
    case 0x5a21: return setX(rd, "(c.fpsr|(c.q<<27))", "0");                            // FPSR
    case 0x5e82: return setX(rd, "c.tlsBase", "0");                                     // TPIDR_EL0
    case 0x5e83: return setX(rd, "0", "0");                                             // TPIDRRO_EL0
    case 0x5807: return setX(rd, "0x10", "0");                                          // DCZID_EL0: DZP
    case 0x5801: return setX(rd, int32(0x8444c004), "0");                                 // CTR_EL0: 64-byte lines
    case 0x5f00: return setX(rd, "19200000", "0");                                      // CNTFRQ_EL0
    case 0x5f01: case 0x5f02: return "c.cnt();" + setX(rd, "c.lo", "c.hi");             // CNTPCT_EL0 / CNTVCT_EL0
  }
  if ((key & 0x7f80) === 0x4000) return setX(rd, "0", "0");                             // MIDR, MPIDR, ID_AA64*
  return null;
}
function sysWrite(key: number, rt: number): string | null {
  switch (key) {
    case 0x5a10: return `t=${zr(rt)};c.n=(t>>>31)&1;c.z=(t>>>30)&1;c.c=(t>>>29)&1;c.v=(t>>>28)&1;`;
    case 0x5a20: return `c.fpcr=${zr(rt)};`;
    case 0x5a21: return `t=${zr(rt)};c.fpsr=t&0x7ffffff;c.q=(t>>>27)&1;`;
    case 0x5e82: return `c.tlsBase=${zr(rt)};`;
  }
  return null;
}

let redirect = -1, slot = 0;

/** emit one instruction; returns true when it ends the block */
function emit(pc: number, w: number, out: Ins[], k: number): boolean {
  const ret = (target: string) => retK(slot++, k, target);
  const fault = (what: string) => `r[32]=${pc};c.fault(${JSON.stringify(what + " " + hex(w))});`;
  const push = (code: string, fl: Fl | null = null, reads = 0, writes = 0) => out.push({ code, fl, reads, writes });

  // `w & mask` is a signed int32 in JS, so a mask that keeps bit 31 yields a negative number and
  // would never equal its positive literal. One helper, applied to every encoding test.
  const is = (mask: number, val: number) => ((w & mask) >>> 0) === val;
  const sf = (w >>> 31) & 1, rd = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31;
  const w64 = sf === 1;

  // ── data processing, immediate
  if (is(0x1c000000, 0x10000000)) {
    const op = (w >>> 23) & 7;
    if (op <= 1) {                                                                   // ADR / ADRP
      const imm = (((w >>> 5) & 0x7ffff) << 2) | ((w >>> 29) & 3);
      const off = sx(imm, 21);
      const v = (w & 0x80000000) ? ((pc & ~0xfff) + off * 4096) | 0 : (pc + off) | 0;
      push(setX(rd, int32(v), "0"));
      return false;
    }
    if (op === 2 || op === 3) {                                                      // ADD/SUB immediate
      const sub = (w >>> 30) & 1, S = (w >>> 29) & 1;
      const imm = ((w >>> 10) & 0xfff) << (((w >>> 22) & 1) ? 12 : 0);
      if (w64) {
        const core = `a=${sp(rn)};ah=${sph(rn)};t=${hex(imm)};th=0;` + (sub ? SUB_CORE64 : ADD_CORE64);
        push(core + (S ? setX(rd, "v", "vh") : setSP(rd, "v", "vh")) + "\0F", S ? (sub ? SUB64 : ADD64) : null, 0, S ? ALL : 0);
      } else {
        const core = `a=${sp(rn)};t=${hex(imm)};v=(a${sub ? "-" : "+"}t)|0;`;
        push(core + (S ? setW(rd, "v") : setSP(rd, "v", "0")) + "\0F", S ? (sub ? SUBF : ADDF) : null, 0, S ? ALL : 0);
      }
      return false;
    }
    if (op === 4) {                                                                  // logical immediate
      const opc = (w >>> 29) & 3, nbit = (w >>> 22) & 1, imms = (w >>> 10) & 0x3f, immr = (w >>> 16) & 0x3f;
      const m = bitMasks(nbit, imms, immr, w64, true);
      if (!m) { push(fault("undefined logical immediate")); return true; }
      const il = hex(lo32(m.wmask)), ih = hex(hi32(m.wmask));
      const opn = ["&", "|", "^", "&"][opc];
      if (w64) {
        push(`a=${zr(rn)};ah=${zrh(rn)};t=${il};th=${ih};v=a${opn}t;vh=ah${opn}th;`
          + (opc === 3 ? setX(rd, "v", "vh") : setSP(rd, "v", "vh")) + "\0F", opc === 3 ? LOG64 : null, 0, opc === 3 ? ALL : 0);
      } else {
        push(`a=${zr(rn)};t=${il};v=a${opn}t;`
          + (opc === 3 ? setW(rd, "v") : setSP(rd, "v", "0")) + "\0F", opc === 3 ? LOG32 : null, 0, opc === 3 ? ALL : 0);
      }
      return false;
    }
    if (op === 5) {                                                                  // MOVN / MOVZ / MOVK
      const opc = (w >>> 29) & 3, hw = (w >>> 21) & 3, imm16 = (w >>> 5) & 0xffff;
      if (opc === 1) { push(fault("undefined move wide")); return true; }
      const shift = hw * 16;
      const val = shift >= 32 ? { lo: 0n, hi: BigInt(imm16) << BigInt(shift - 32) } : { lo: BigInt(imm16) << BigInt(shift), hi: 0n };
      if (opc === 0) {                                                               // MOVN: the inverse
        const l = int32(lo32(~val.lo & 0xffffffffn)), h = int32(w64 ? lo32(~val.hi & 0xffffffffn) : 0);
        push(w64 ? setX(rd, l, h) : setW(rd, l));
      } else if (opc === 2) {                                                        // MOVZ
        push(w64 ? setX(rd, int32(lo32(val.lo)), int32(lo32(val.hi))) : setW(rd, int32(lo32(val.lo))));
      } else {                                                                       // MOVK: keep the rest
        const keep = hex(lo32(~(0xffffn << BigInt(shift % 32)) & 0xffffffffn));
        if (shift >= 32) push(w64 ? `H[${rd}]=(H[${rd}]&${keep})|${hex(lo32(val.hi))};` : fault("MOVK hw>1 in 32-bit"));
        else push(`r[${rd}]=(r[${rd}]&${keep})|${hex(lo32(val.lo))};` + (w64 ? "" : `H[${rd}]=0;`));
      }
      return false;
    }
    if (op === 6) {                                                                  // bitfield: SBFM/BFM/UBFM
      const opc = (w >>> 29) & 3, nbit = (w >>> 22) & 1, imms = (w >>> 10) & 0x3f, immr = (w >>> 16) & 0x3f;
      if (opc === 3 || nbit !== sf) { push(fault("undefined bitfield")); return true; }
      const m = bitMasks(nbit, imms, immr, w64, false);
      if (!m) { push(fault("undefined bitfield mask")); return true; }
      const [srcL, srcH] = w64 ? [zr(rn), zrh(rn)] : [zr(rn), "0"];
      const [rotL, rotH] = w64 ? ror64(srcL, srcH, immr) : [immr === 0 ? srcL : `((${srcL}>>>${immr})|(${srcL}<<${32 - immr}))`, "0"];
      const wl = hex(lo32(m.wmask)), wh = hex(hi32(m.wmask)), tl = hex(lo32(m.tmask)), th = hex(hi32(m.tmask));
      // top: SBFM replicates the source's sign bit S, UBFM zeroes, BFM keeps the destination
      const topL = opc === 0 ? "s" : opc === 1 ? (rd === SP ? "0" : `r[${rd}]`) : "0";
      const topH = opc === 0 ? "s" : opc === 1 ? (rd === SP ? "0" : `H[${rd}]`) : "0";
      const sBit = imms;
      const signSrc = w64 && sBit >= 32 ? `((${srcH}>>>${sBit - 32})&1)` : `((${srcL}>>>${sBit})&1)`;
      const pre = opc === 0 ? `s=${signSrc}?-1:0;` : "";
      // bot = (ROR(src,R) & wmask) | (dst & ~wmask)   — BFM keeps the destination outside wmask
      const dstL = opc === 1 && rd !== SP ? `r[${rd}]` : "0", dstH = opc === 1 && rd !== SP ? `H[${rd}]` : "0";
      const botL = opc === 1 ? `((${rotL}&${wl})|(${dstL}&~${wl}))` : `(${rotL}&${wl})`;
      const botH = opc === 1 ? `((${rotH}&${wh})|(${dstH}&~${wh}))` : `(${rotH}&${wh})`;
      const resL = `((${topL}&~${tl})|(${botL}&${tl}))`;
      const resH = `((${topH}&~${th})|(${botH}&${th}))`;
      push(pre + (w64 ? `v=${resL};vh=${resH};` + setX(rd, "v", "vh") : `v=${resL};` + setW(rd, "v")));
      return false;
    }
    if (op === 7) {                                                                  // EXTR
      const imms = (w >>> 10) & 0x3f;
      // Xd = the low half of (Xn:Xm) >> lsb
      if (w64) {
        if (imms === 0) { push(setX(rd, zr(rm), zrh(rm))); return false; }
        const [al, ah2] = shl64(zr(rn), zrh(rn), 64 - imms);
        const [bl, bh] = shr64(zr(rm), zrh(rm), imms);
        push(setX(rd, `(${al}|${bl})`, `(${ah2}|${bh})`));
      } else {
        push(imms === 0 ? setW(rd, zr(rm)) : setW(rd, `((${zr(rm)}>>>${imms})|(${zr(rn)}<<${32 - imms}))`));
      }
      return false;
    }
  }

  // ── branches, exception generating, system
  if (is(0x1c000000, 0x14000000)) {
    if (is(0x7c000000, 0x14000000)) {                                           // B / BL
      const target = (pc + sx(w & 0x3ffffff, 26) * 4) | 0;
      if (w & 0x80000000) { push(`r[30]=${hex((pc + 4) | 0)};H[30]=0;` + ret(hex(target))); return true; }
      redirect = target;
      push(`c.ic+=${k};`);
      return true;
    }
    if (is(0xff000010, 0x54000000)) {                                           // B.cond
      const cond = w & 15, target = (pc + sx((w >>> 5) & 0x7ffff, 19) * 4) | 0;
      if (cond >= 14) { redirect = target; push(`c.ic+=${k};`); return true; }
      push(`if(${COND[cond]})${ret(hex(target))}` + ret(hex((pc + 4) | 0)), null, COND_READS[cond], 0);
      return true;
    }
    if (is(0x7e000000, 0x34000000)) {                                           // CBZ / CBNZ
      const nz = (w >>> 24) & 1, target = (pc + sx((w >>> 5) & 0x7ffff, 19) * 4) | 0;
      const test = w64 ? `(${zr(rd)}|${zrh(rd)})` : `${zr(rd)}`;
      push(`if(${test}${nz ? "!==0" : "===0"})${ret(hex(target))}` + ret(hex((pc + 4) | 0)));
      return true;
    }
    if (is(0x7e000000, 0x36000000)) {                                           // TBZ / TBNZ
      const nz = (w >>> 24) & 1, bit = ((w >>> 26) & 0x20) | ((w >>> 19) & 0x1f);
      const target = (pc + sx((w >>> 5) & 0x3fff, 14) * 4) | 0;
      const test = bit >= 32 ? `((${zrh(rd)}>>>${bit - 32})&1)` : `((${zr(rd)}>>>${bit})&1)`;
      push(`if(${test}${nz ? "!==0" : "===0"})${ret(hex(target))}` + ret(hex((pc + 4) | 0)));
      return true;
    }
    if (is(0xfffffc1f, 0xd65f0000)) { push(`c.ic+=${k};return c.look(r[${rn}]);`); return true; }   // RET
    if (is(0xfffffc1f, 0xd63f0000)) {                                           // BLR
      push(`t=${zr(rn)};r[30]=${hex((pc + 4) | 0)};H[30]=0;c.ic+=${k};return c.look(t);`);
      return true;
    }
    if (is(0xfffffc1f, 0xd61f0000)) { push(`c.ic+=${k};return c.look(${zr(rn)});`); return true; }  // BR
    if (is(0xffe0001f, 0xd4000001)) { push(`r[32]=${hex((pc + 4) | 0)};c.ic+=${k};c.svc();return c.look(r[32]);`); return true; } // SVC
    if (is(0xfffff01f, 0xd503201f)) { push(""); return false; }                 // HINT (NOP/YIELD/BTI/PAC…)
    if (is(0xfffff01f, 0xd503301f)) { push(((w >>> 5) & 7) === 2 ? "c.excl=0;" : ""); return false; }   // CLREX / DSB / DMB / ISB
    if (is(0xfff8f01f, 0xd500401f)) { push(""); return false; }                 // MSR (immediate): SSBS/DIT/PAN
    if (is(0xfff80000, 0xd5080000)) {                                           // SYS: dc / ic / tlbi
      // DCZID_EL0 says DC ZVA is prohibited, so reaching one means a guest ignored it
      if (((w >>> 5) & 0x7ff) === 0x3a1) { push(fault("dc zva")); return true; }
      push(""); return false;
    }
    if (is(0xfff00000, 0xd5300000)) {                                           // MRS
      const code = sysRead((w >>> 5) & 0x7fff, rd);
      if (code === null) { push(fault("MRS")); return true; }
      push(code, null, ALL, 0);
      return false;
    }
    if (is(0xfff00000, 0xd5100000)) {                                           // MSR
      const code = sysWrite((w >>> 5) & 0x7fff, rd);
      if (code === null) { push(fault("MSR")); return true; }
      push(code, null, 0, ALL);
      return false;
    }
    if (is(0xffe0001f, 0xd4200000)) { push(fault("brk")); return true; }
    push(fault("branch/system"));
    return true;
  }

  // ── loads and stores
  if (is(0x0a000000, 0x08000000)) {
    // LDR (literal)
    if (is(0x3b000000, 0x18000000)) {
      const opc = (w >>> 30) & 3, addr = (pc + sx((w >>> 5) & 0x7ffff, 19) * 4) | 0;
      if (opc === 0) push(setW(rd, `M.ld32(${hex(addr)})`));
      else if (opc === 1) push(`v=M.ld32(${hex(addr)});vh=M.ld32(${hex(addr)}+4);` + setX(rd, "v", "vh"));
      else if (opc === 2) push(`v=M.ld32(${hex(addr)});` + setX(rd, "v", "v>>31"));
      else { push(fault("LDR literal (SIMD)")); return true; }
      return false;
    }
    // LDP / STP
    if (is(0x3a000000, 0x28000000)) {
      const opc = (w >>> 30) & 3, L = (w >>> 22) & 1, imm7 = sx((w >>> 15) & 0x7f, 7);
      const rt2 = (w >>> 10) & 31, kind = (w >>> 23) & 3;                            // 1 post, 2 offset, 3 pre
      if (opc === 3 || (w & 0x04000000)) { push(fault("LDP/STP (SIMD)")); return true; }
      const wide = opc === 2, scale = wide ? 8 : 4, off = imm7 * scale;
      const wb = kind === 1 || kind === 3;
      const addr = kind === 1 ? sp(rn) : off === 0 ? sp(rn) : `${sp(rn)}+${off}`;
      let body = `a=${addr}|0;`;
      if (wb) body += `${sp(rn)}=(${sp(rn)}+${off})|0;${sph(rn)}=0;`;
      if (L) {
        if (wide) body += `v=M.ld32(a);vh=M.ld32(a+4);t=M.ld32(a+8);th=M.ld32(a+12);` + setX(rd, "v", "vh") + setX(rt2, "t", "th");
        else if (opc === 1) body += `v=M.ld32(a);t=M.ld32(a+4);` + setX(rd, "v", "v>>31") + setX(rt2, "t", "t>>31"); // LDPSW
        else body += `v=M.ld32(a);t=M.ld32(a+4);` + setW(rd, "v") + setW(rt2, "t");
      } else {
        if (wide) body += `M.st32(a,${zr(rd)});M.st32(a+4,${zrh(rd)});M.st32(a+8,${zr(rt2)});M.st32(a+12,${zrh(rt2)});`;
        else body += `M.st32(a,${zr(rd)});M.st32(a+4,${zr(rt2)});`;
      }
      push(body);
      return false;
    }
    // load/store exclusive and ordered: one thread, so an exclusive pair is a plain pair and a
    // store-exclusive always succeeds
    if (is(0x3f000000, 0x08000000)) {
      const size = (w >>> 30) & 3, L = (w >>> 22) & 1, o2 = (w >>> 15) & 1, rs = (w >>> 16) & 31;
      const pair = ((w >>> 21) & 1) === 1;
      if (pair) { push(fault("load/store exclusive pair")); return true; }
      const a = sp(rn);
      if (L) {
        push(size === 3 ? `a=${a}|0;v=M.ld32(a);vh=M.ld32(a+4);` + setX(rd, "v", "vh")
          : setW(rd, size === 0 ? `M.ld8u(${a})` : size === 1 ? `M.ld16u(${a})` : `M.ld32(${a})`));
      } else {
        const st = size === 3 ? `a=${a}|0;M.st32(a,${zr(rd)});M.st32(a+4,${zrh(rd)});`
          : size === 0 ? `M.st8(${a},${zr(rd)});` : size === 1 ? `M.st16(${a},${zr(rd)});` : `M.st32(${a},${zr(rd)});`;
        // o2 distinguishes the ordered stores (STLR), which have no status register
        push(st + (o2 ? "" : setW(rs, "0")));
      }
      return false;
    }
    // LDR/STR immediate: unsigned offset, or unscaled / pre / post index
    const size = (w >>> 30) & 3, opc = (w >>> 22) & 3;
    if (w & 0x04000000) { push(fault("load/store (SIMD)")); return true; }
    const unsignedOff = is(0x3b000000, 0x39000000);
    const reg9 = is(0x3b200c00, 0x38200800);
    let addr: string, wb = "";
    if (unsignedOff) {
      const off = ((w >>> 10) & 0xfff) << size;
      addr = off === 0 ? `${sp(rn)}|0` : `${sp(rn)}+${off}|0`;
    } else if (reg9) {                                                               // register offset
      const option = (w >>> 13) & 7, S = (w >>> 12) & 1;
      const idx = option === 3 || option === 7 ? zr(rm) : option === 2 ? `(${zr(rm)}>>>0)` : `(${zr(rm)}|0)`;
      const shifted = S ? `(${idx}<<${size})` : idx;
      addr = `${sp(rn)}+${shifted}|0`;
    } else {
      const imm9 = sx((w >>> 12) & 0x1ff, 9), kind = (w >>> 10) & 3;                 // 0 unscaled, 1 post, 3 pre
      if (kind === 2) { push(fault("unprivileged load/store")); return true; }
      addr = kind === 1 ? `${sp(rn)}|0` : imm9 === 0 ? `${sp(rn)}|0` : `${sp(rn)}+${imm9}|0`;
      if (kind === 1 || kind === 3) wb = `${sp(rn)}=(${sp(rn)}+${imm9})|0;${sph(rn)}=0;`;
    }
    const load = opc !== 0 && !(size === 3 && opc === 2);
    let body = `a=${addr};` + wb;
    if (!load) {
      body += size === 0 ? `M.st8(a,${zr(rd)});` : size === 1 ? `M.st16(a,${zr(rd)});`
        : size === 2 ? `M.st32(a,${zr(rd)});` : `M.st32(a,${zr(rd)});M.st32(a+4,${zrh(rd)});`;
    } else if (size === 3) {
      if (opc === 2) { push(""); return false; }                                     // PRFM
      body += `v=M.ld32(a);vh=M.ld32(a+4);` + setX(rd, "v", "vh");
    } else if (opc === 1) {                                                          // zero-extend
      body += size === 0 ? setW(rd, "M.ld8u(a)") : size === 1 ? setW(rd, "M.ld16u(a)") : setW(rd, "M.ld32(a)");
    } else {                                                                         // sign-extend, to 64 (opc 2) or 32 (opc 3)
      const v = size === 0 ? "M.ld8s(a)" : size === 1 ? "M.ld16s(a)" : "M.ld32(a)";
      body += opc === 2 ? `v=${v};` + setX(rd, "v", "v>>31") : `v=${v};` + setW(rd, "v");
    }
    push(body);
    return false;
  }

  // ── data processing, register
  if (is(0x0e000000, 0x0a000000)) {
    // logical, shifted register
    if (is(0x1f000000, 0x0a000000)) {
      const opc = (w >>> 29) & 3, nbit = (w >>> 21) & 1, type = (w >>> 22) & 3, amt = (w >>> 10) & 0x3f;
      if (!w64 && amt > 31) { push(fault("shift amount")); return true; }
      let [ml, mh] = shiftOf(zr(rm), zrh(rm), type, amt, w64);
      if (nbit) { ml = `~${ml}`; mh = `~${mh}`; }
      const o = ["&", "|", "^", "&"][opc];
      if (w64) {
        push(`a=${zr(rn)};ah=${zrh(rn)};t=${ml};th=${mh};v=a${o}t;vh=ah${o}th;` + setX(rd, "v", "vh") + "\0F",
          opc === 3 ? LOG64 : null, 0, opc === 3 ? ALL : 0);
      } else {
        push(`a=${zr(rn)};t=${ml};v=a${o}t;` + setW(rd, "v") + "\0F", opc === 3 ? LOG32 : null, 0, opc === 3 ? ALL : 0);
      }
      return false;
    }
    // add/sub, shifted or extended register
    if (is(0x1f000000, 0x0b000000)) {
      const sub = (w >>> 30) & 1, S = (w >>> 29) & 1, ext = (w >>> 21) & 1;
      let ml: string, mh: string, base = zr(rn), baseH = zrh(rn);
      if (ext) {                                                                     // extended register
        const option = (w >>> 13) & 7, amt = (w >>> 10) & 7;
        base = sp(rn); baseH = sph(rn);
        const m = zr(rm);
        const e = option === 0 ? `(${m}&255)` : option === 1 ? `(${m}&65535)` : option === 2 || option === 3 ? m
          : option === 4 ? `((${m}<<24)>>24)` : option === 5 ? `((${m}<<16)>>16)` : m;
        const signed = option >= 4;
        const full = option === 3 || option === 7;
        [ml, mh] = shl64(e, full && w64 ? zrh(rm) : signed ? `(${e}>>31)` : "0", amt);
      } else {
        const type = (w >>> 22) & 3, amt = (w >>> 10) & 0x3f;
        if (type === 3 || (!w64 && amt > 31)) { push(fault("add/sub shift")); return true; }
        [ml, mh] = shiftOf(zr(rm), zrh(rm), type, amt, w64);
      }
      if (w64) {
        push(`a=${base};ah=${baseH};t=${ml};th=${mh};` + (sub ? SUB_CORE64 : ADD_CORE64)
          + (S ? setX(rd, "v", "vh") : setSP(rd, "v", "vh")) + "\0F", S ? (sub ? SUB64 : ADD64) : null, 0, S ? ALL : 0);
      } else {
        push(`a=${base};t=${ml};v=(a${sub ? "-" : "+"}t)|0;` + (S ? setW(rd, "v") : setSP(rd, "v", "0")) + "\0F",
          S ? (sub ? SUBF : ADDF) : null, 0, S ? ALL : 0);
      }
      return false;
    }
    // add/sub with carry
    if (is(0x1fe00000, 0x1a000000)) {
      const sub = (w >>> 30) & 1, S = (w >>> 29) & 1;
      if (w64) {
        const core = sub
          ? `t=~${zr(rm)};th=~${zrh(rm)};a=${zr(rn)};ah=${zrh(rn)};v=(a+t+c.c)|0;vh=(ah+th+(((a>>>0)+(t>>>0)+c.c)>4294967295?1:0))|0;`
          : `t=${zr(rm)};th=${zrh(rm)};a=${zr(rn)};ah=${zrh(rn)};v=(a+t+c.c)|0;vh=(ah+th+(((a>>>0)+(t>>>0)+c.c)>4294967295?1:0))|0;`;
        push(core + setX(rd, "v", "vh") + "\0F", S ? ADD64 : null, C, S ? ALL : 0);
      } else {
        const core = `a=${zr(rn)};t=${sub ? `~${zr(rm)}` : zr(rm)};v=(a+t+c.c)|0;`;
        push(core + setW(rd, "v") + "\0F", S ? ADDF : null, C, S ? ALL : 0);
      }
      return false;
    }
    // conditional compare (immediate and register)
    if (is(0x1fe00000, 0x1a400000) && ((w >>> 10) & 3) <= 2) {
      const sub = (w >>> 30) & 1, cond = (w >>> 12) & 15, imm = (w >>> 11) & 1;
      const nzcv = w & 15;
      const rhs = imm ? String((w >>> 16) & 31) : zr(rm);
      const rhsH = imm ? "0" : zrh(rm);
      const setNzcv = `c.n=${(nzcv >> 3) & 1};c.z=${(nzcv >> 2) & 1};c.c=${(nzcv >> 1) & 1};c.v=${nzcv & 1};`;
      const cmp = w64
        ? `a=${zr(rn)};ah=${zrh(rn)};t=${rhs};th=${rhsH};` + (sub ? SUB_CORE64 : ADD_CORE64)
        : `a=${zr(rn)};t=${rhs};v=(a${sub ? "-" : "+"}t)|0;`;
      const fl = w64 ? (sub ? SUB64 : ADD64) : (sub ? SUBF : ADDF);
      const upd = (fl.n ?? "") + (fl.z ?? "") + (fl.c ?? "") + (fl.v ?? "");
      push(`if(${COND[cond]}){${cmp}${upd}}else{${setNzcv}}`, null, COND_READS[cond], ALL);
      return false;
    }
    // conditional select
    if (is(0x1fe00000, 0x1a800000)) {
      const cond = (w >>> 12) & 15, op2 = (w >>> 10) & 3, opc = (w >>> 30) & 1;
      const els = opc === 0
        ? (op2 === 0 ? [zr(rm), zrh(rm)] : [`(${zr(rm)}+1)|0`, "0"])                 // CSEL / CSINC
        : (op2 === 0 ? [`~${zr(rm)}`, `~${zrh(rm)}`] : [`-${zr(rm)}|0`, "0"]);       // CSINV / CSNEG
      if (w64 && ((opc === 0 && op2 === 1) || (opc === 1 && op2 === 1))) {
        // the +1 and the negate carry across the halves; keep them exact
        els[0] = opc === 0 ? `(${zr(rm)}+1)|0` : `(-${zr(rm)})|0`;
        els[1] = opc === 0
          ? `(${zrh(rm)}+((${zr(rm)}>>>0)===4294967295?1:0))|0`
          : `(~${zrh(rm)}+((${zr(rm)}>>>0)===0?1:0))|0`;
      }
      if (w64) push(`if(${COND[cond]}){v=${zr(rn)};vh=${zrh(rn)};}else{v=${els[0]};vh=${els[1]};}` + setX(rd, "v", "vh"), null, COND_READS[cond], 0);
      else push(`if(${COND[cond]}){v=${zr(rn)};}else{v=${els[0]};}` + setW(rd, "v"), null, COND_READS[cond], 0);
      return false;
    }
    // data processing (1 source): CLZ and friends. Checked before the 2-source group, whose
    // encoding differs from it only in bit 30.
    if (is(0x5fff0000, 0x5ac00000)) {
      const opc = (w >>> 10) & 0x3f, lo = zr(rn), hi = zrh(rn);
      const bs = (e: string) => `((${e}>>>24)|((${e}>>>8)&0xff00)|((${e}<<8)&0xff0000)|(${e}<<24))`;
      const h16 = (e: string) => `(((${e}>>>8)&0xff00ff)|((${e}<<8)&0xff00ff00))`;
      // the 64-bit forms read both halves before writing either: rd may be rn
      if (opc === 0) push(w64 ? `v=c.rbit32(${hi});vh=c.rbit32(${lo});` + setX(rd, "v", "vh") : setW(rd, `c.rbit32(${lo})`));        // RBIT
      else if (opc === 1) push(w64 ? `v=${h16(lo)};vh=${h16(hi)};` + setX(rd, "v", "vh") : setW(rd, h16(lo)));                 // REV16
      else if (opc === 2) push(w64 ? `v=${bs(lo)};vh=${bs(hi)};` + setX(rd, "v", "vh") : setW(rd, bs(lo)));                    // REV32 / REV (w)
      else if (opc === 3 && w64) push(`v=${bs(hi)};vh=${bs(lo)};` + setX(rd, "v", "vh"));                                       // REV (x)
      else if (opc === 4) push(w64 ? setX(rd, `(${hi}===0?32+Math.clz32(${lo}):Math.clz32(${hi}))`, "0") : setW(rd, `Math.clz32(${lo})`));   // CLZ
      else if (opc === 5) push(w64 ? setX(rd, `c.cls64(${lo},${hi})`, "0") : setW(rd, `(Math.clz32(${lo}^(${lo}>>31))-1)`));   // CLS
      else { push(fault("data processing (1 source)")); return true; }
      return false;
    }
    // data processing (2 source): UDIV/SDIV/LSLV/LSRV/ASRV/RORV
    if (is(0x5fe00000, 0x1ac00000)) {
      const opc = (w >>> 10) & 0x3f;
      if (opc === 2 || opc === 3) {                                                  // UDIV / SDIV
        const signed = opc === 3;
        if (w64) push(`c.div64(${zr(rn)},${zrh(rn)},${zr(rm)},${zrh(rm)},${signed ? 1 : 0});` + setX(rd, "c.lo", "c.hi"));
        else push(setW(rd, signed ? `(${zr(rm)}===0?0:(${zr(rn)}/${zr(rm)})|0)` : `(${zr(rm)}===0?0:((${zr(rn)}>>>0)/(${zr(rm)}>>>0))|0)`));
        return false;
      }
      if (opc >= 8 && opc <= 11) {                                                   // LSLV/LSRV/ASRV/RORV
        const kind = opc - 8;
        if (w64) { push(`c.shift64(${zr(rn)},${zrh(rn)},${zr(rm)}&63,${kind});` + setX(rd, "c.lo", "c.hi")); return false; }
        const sh = `(${zr(rm)}&31)`;
        push(setW(rd, kind === 0 ? `${zr(rn)}<<${sh}` : kind === 1 ? `${zr(rn)}>>>${sh}` : kind === 2 ? `${zr(rn)}>>${sh}`
          : `((${zr(rn)}>>>${sh})|(${zr(rn)}<<(32-${sh})))`));
        return false;
      }
      push(fault("data processing (2 source)"));
      return true;
    }
    // 3-source: MADD/MSUB, and the widening multiplies
    if (is(0x1f000000, 0x1b000000)) {
      const ra = (w >>> 10) & 31, o0 = (w >>> 15) & 1, op31 = (w >>> 21) & 7;
      if (op31 === 0) {                                                              // MADD / MSUB
        if (w64) {
          push(`c.mul64(${zr(rn)},${zrh(rn)},${zr(rm)},${zrh(rm)});a=${zr(ra)};ah=${zrh(ra)};t=${o0 ? "-c.lo|0" : "c.lo"};th=${o0 ? "(~c.hi+((c.lo>>>0)===0?1:0))|0" : "c.hi"};`
            + ADD_CORE64 + setX(rd, "v", "vh"));
        } else {
          push(setW(rd, `(${zr(ra)}${o0 ? "-" : "+"}Math.imul(${zr(rn)},${zr(rm)}))|0`));
        }
        return false;
      }
      if (op31 === 1 || op31 === 5) {                                                // SMADDL / UMADDL
        const signed = op31 === 1;
        push(`c.${signed ? "smull" : "umull"}(${zr(rn)},${zr(rm)});a=c.lo;ah=c.hi;t=${zr(ra)};th=${zrh(ra)};`
          + (o0 ? SUB_CORE64.replace("v=(a-t)", "v=(a-t)") : ADD_CORE64) + setX(rd, "v", "vh"));
        return false;
      }
      if (op31 === 2 || op31 === 6) {                                                // SMULH / UMULH
        push(`c.mulh64(${zr(rn)},${zrh(rn)},${zr(rm)},${zrh(rm)},${op31 === 2 ? 1 : 0});` + setX(rd, "c.lo", "c.hi"));
        return false;
      }
      push(fault("3-source"));
      return true;
    }
    push(fault("data processing (register)"));
    return true;
  }

  push(fault(w === 0 ? "udf" : "unimplemented"));
  return true;
}

/** compile the basic block at `pc` to JS source */
export function emitA64Block(pc: number): BlockSrc {
  slot = 0;
  const out: Ins[] = [{ code: `c.bpc=${pc};`, fl: null, reads: 0, writes: 0 }];
  const pageStart = pc & -PAGE_SIZE, pageEnd = pageStart + PAGE_SIZE;
  const seen = new Set<number>();
  let p = pc, k = 0, end = pc;
  for (;;) {
    const w = mem.u32[p >>> 2];
    k++;
    seen.add(p);
    redirect = -1;
    const ends = emit(p, w, out, k);
    p += 4;
    if (p > end) end = p;
    if (redirect >= 0) {
      // follow an unconditional branch within the page once: fewer, longer blocks
      if (redirect >= pageStart && redirect < pageEnd && !seen.has(redirect) && k < MAX_BLOCK) { p = redirect; k = 0; continue; }
      out.push({ code: retK(slot++, 0, hex(redirect)), fl: null, reads: 0, writes: 0 });
      break;
    }
    if (ends || k >= MAX_BLOCK || p >= pageEnd) break;
  }
  if (redirect < 0) out.push({ code: retK(slot++, k, hex(p)), fl: null, reads: 0, writes: 0 });
  return {
    src: "let t,a,ah,th,v,vh,s,m1,H=c.h;"
      + hoistRegs(selfLoop(inlineMem(assemble(out)), pc, pc >>> PAGE_SHIFT), { pc: 32, hi: true, sync: "c.svc();" }),
    len: (end - pc) >> 2, end, slots: slot,
  };
}
