// ARM (A32) decoder → JS source for one basic block. Each instruction becomes straight-line JS
// over the Cpu (`c`), its register file (`r`), guest memory (`M`) and flag fields; a block ends
// at the first instruction that can write pc (or at a page boundary). The generated function
// returns the next pc. Registers are int32; flags are 0/1 numbers on `c`.

import { mem } from "./mem";
import { PAGE_SIZE } from "./abi";

const COND = ["c.z", "!c.z", "c.c", "!c.c", "c.n", "!c.n", "c.v", "!c.v",
  "(c.c&&!c.z)", "(!c.c||c.z)", "c.n===c.v", "c.n!==c.v", "(!c.z&&c.n===c.v)", "(c.z||c.n!==c.v)", "", ""];
const MAX_BLOCK = 256;

export interface BlockSrc { src: string; len: number; end: number }

/** operand2 as a JS expression plus its shifter-carry expression (null = carry unchanged) */
function op2(w: number, pc: number): { v: string; c: string | null; pre?: string } {
  if (w & (1 << 25)) {
    const rot = ((w >>> 8) & 15) * 2, imm8 = w & 255;
    const imm = rot ? ((imm8 >>> rot) | (imm8 << (32 - rot))) | 0 : imm8;
    return { v: String(imm), c: rot ? String(imm >>> 31) : null };
  }
  const m = w & 15, type = (w >>> 5) & 3;
  const rm = m === 15 ? String((pc + 8) | 0) : `r[${m}]`;
  if (w & (1 << 4)) {
    // register-specified shift: amount is the low byte of rs
    const s = (w >>> 8) & 15;
    const rs = `(r[${s}]&255)`;
    return { v: `c.shc(${type},${rm},${rs})`, c: "c.sc" };
  }
  const n = (w >>> 7) & 31;
  switch (type) {
    case 0: return n === 0 ? { v: rm, c: null } : { v: `(${rm}<<${n})`, c: `((${rm}>>>${32 - n})&1)` };
    case 1: return n === 0 ? { v: "0", c: `(${rm}>>>31)` } : { v: `(${rm}>>>${n})`, c: `((${rm}>>>${n - 1})&1)` };
    case 2: return n === 0 ? { v: `(${rm}>>31)`, c: `(${rm}>>>31)` } : { v: `(${rm}>>${n})`, c: `((${rm}>>>${n - 1})&1)` };
    default: return n === 0 ? { v: `((${rm}>>>1)|(c.c<<31))`, c: `(${rm}&1)` } : { v: `((${rm}>>>${n})|(${rm}<<${32 - n}))`, c: `((${rm}>>>${n - 1})&1)` };
  }
}

const reg = (n: number, pc: number) => (n === 15 ? String((pc + 8) | 0) : `r[${n}]`);
const hex = (n: number) => "0x" + (n >>> 0).toString(16);
const fault = (pc: number, w: number, what: string) => `r[15]=${pc};c.fault(${JSON.stringify(what + " " + hex(w))});`;

/** emit one instruction; returns true when it ends the block */
function emit(pc: number, w: number, out: string[], k: number): boolean {
  const cond = w >>> 28;
  const ret = (target: string) => `{c.ic+=${k};return ${target};}`;
  let body = "", ends = false;
  const bx = (v: string) => ret(`c.bx(${v})`);

  if (cond === 15) {
    // unconditional space: BLX imm, PLD, barriers, CPS, SETEND, RFE/SRS
    if ((w & 0x0e000000) === 0x0a000000) {
      const off = ((w << 8) >> 6) | ((w >>> 23) & 2);
      out.push(`r[14]=${(pc + 4) | 0};${ret(`c.bx(${hex((pc + 8 + off) | 1)})`)}`);
      return true;
    }
    if ((w & 0x0d70f000) === 0x0550f000) { out.push(""); return false; } // PLD
    if ((w & 0x0ff000f0) === 0x05700040 || (w & 0x0ff000f0) === 0x05700050 || (w & 0x0ff000f0) === 0x05700060) { out.push(""); return false; } // DSB/DMB/ISB
    if ((w & 0x0fff00ff) === 0x057ff01f) { out.push(""); return false; } // CLREX
    out.push(fault(pc, w, "undefined (NV space)"));
    return true;
  }

  const rn = (w >>> 16) & 15, rd = (w >>> 12) & 15, rs = (w >>> 8) & 15, rm = w & 15;
  const top = (w >>> 25) & 7;

  if (top === 5) {
    // B / BL
    const off = (w << 8) >> 6;
    const target = (pc + 8 + off) | 0;
    if (w & (1 << 24)) body += `r[14]=${(pc + 4) | 0};`;
    body += ret(hex(target));
    ends = true;
  } else if (top === 0 || top === 1) {
    if (top === 0 && (w & 0x0ff000f0) === 0x01200010) { body = bx(reg(rm, pc)); ends = true; }                     // BX
    else if (top === 0 && (w & 0x0ff000f0) === 0x01200030) { body = `r[14]=${(pc + 4) | 0};` + bx(reg(rm, pc)); ends = true; } // BLX reg
    else if (top === 0 && (w & 0x0ff000f0) === 0x01200070) { body = fault(pc, w, "bkpt"); ends = true; }
    else if (top === 0 && (w & 0x0fff0ff0) === 0x016f0f10) body = `r[${rd}]=Math.clz32(${reg(rm, pc)});`;          // CLZ
    else if (top === 0 && (w & 0x0fbf0fff) === 0x010f0000) body = `r[${rd}]=c.cpsr();`;                              // MRS
    else if ((w & 0x0db0f000) === 0x0120f000 && (top === 1 || (w & 0xf0) === 0)) {                                    // MSR
      const src = top === 1 ? op2(w, pc).v : reg(rm, pc);
      if (w & (1 << 19)) body = `c.setFlags(${src});`; else body = "";
    }
    else if (top === 0 && (w & 0x0fc000f0) === 0x00000090) {                                                         // MUL/MLA
      const acc = w & (1 << 21), s = w & (1 << 20);
      body = `v=Math.imul(${reg(rm, pc)},${reg(rs, pc)})${acc ? `+r[${rd}]|0` : ""};r[${rn}]=v;`;
      if (s) body += "c.n=v>>>31;c.z=v===0?1:0;";
    }
    else if (top === 0 && (w & 0x0f8000f0) === 0x00800090) {                                                         // UMULL/UMLAL/SMULL/SMLAL
      const signed = w & (1 << 22), acc = w & (1 << 21), s = w & (1 << 20);
      body = `c.${signed ? "smull" : "umull"}(${reg(rm, pc)},${reg(rs, pc)});`;
      if (acc) body += `c.add64(r[${rd}],r[${rn}]);`;
      body += `r[${rd}]=c.lo;r[${rn}]=c.hi;`;
      if (s) body += `c.n=c.hi>>>31;c.z=(c.hi|c.lo)===0?1:0;`;
    }
    else if (top === 0 && (w & 0x0f0000f0) === 0x00000090 && (w & 0x0fb000f0) === 0x01000090) {                       // SWP/SWPB
      const b = w & (1 << 22);
      body = `a=${reg(rn, pc)};t=${b ? "M.ld8u(a)" : "M.ld32(a)"};${b ? `M.st8(a,${reg(rm, pc)})` : `M.st32(a,${reg(rm, pc)})`};r[${rd}]=t;`;
    }
    else if (top === 0 && (w & 0x0f9000f0) === 0x01800090) {                                                         // LDREX/STREX family
      const ld = w & (1 << 20), sz = (w >>> 21) & 3; // 0 word 1 dword 2 byte 3 half
      const a = reg(rn, pc);
      if (ld) body = sz === 0 ? `r[${rd}]=M.ld32(${a});` : sz === 2 ? `r[${rd}]=M.ld8u(${a});` : sz === 3 ? `r[${rd}]=M.ld16u(${a});` : `r[${rd}]=M.ld32(${a});r[${rd + 1}]=M.ld32(${a}+4);`;
      else body = (sz === 0 ? `M.st32(${a},r[${rm}]);` : sz === 2 ? `M.st8(${a},r[${rm}]);` : sz === 3 ? `M.st16(${a},r[${rm}]);` : `M.st32(${a},r[${rm}]);M.st32(${a}+4,r[${rm + 1}]);`) + `r[${rd}]=0;`;
    }
    else if (top === 0 && (w & 0x0f900090) === 0x01000080) {                                                         // DSP: SMLAxy SMULxy SMLAWy SMULWy SMLALxy
      const op = (w >>> 21) & 3, x = (w >>> 5) & 1, y = (w >>> 6) & 1;
      const lo16 = (r: string, h: number) => (h ? `(${r}>>16)` : `((${r}<<16)>>16)`);
      if (op === 0) body = `v=Math.imul(${lo16(reg(rm, pc), x)},${lo16(reg(rs, pc), y)})+r[${rd}]|0;r[${rn}]=v;`; // SMLAxy (Q ignored)
      else if (op === 3) body = `r[${rn}]=Math.imul(${lo16(reg(rm, pc), x)},${lo16(reg(rs, pc), y)});`;
      else if (op === 1) {
        // SMULWy / SMLAWy: (rm * rs_half) >> 16
        body = `c.smull(${reg(rm, pc)},${lo16(reg(rs, pc), y)});v=(c.lo>>>16)|(c.hi<<16);${x ? "" : `v=v+r[${rd}]|0;`}r[${rn}]=v;`;
      } else { body = `c.smull(${lo16(reg(rm, pc), x)},${lo16(reg(rs, pc), y)});c.add64(r[${rd}],r[${rn}]);r[${rd}]=c.lo;r[${rn}]=c.hi;`; }
    }
    else if (top === 0 && (w & 0x0f9000f0) === 0x01000050) {                                                         // QADD/QSUB/QDADD/QDSUB
      const op = (w >>> 21) & 3;
      const dbl = op & 2 ? `c.sat(${reg(rn, pc)}*2)` : reg(rn, pc);
      body = op & 1 ? `r[${rd}]=c.sat(${reg(rm, pc)}-${dbl});` : `r[${rd}]=c.sat(${reg(rm, pc)}+${dbl});`;
    }
    else if (top === 0 && (w & 0x0e000090) === 0x00000090) {                                                         // misc load/store: LDRH/STRH/LDRSB/LDRSH/LDRD/STRD
      const P = w & (1 << 24), U = w & (1 << 23), I = w & (1 << 22), W = w & (1 << 21), L = w & (1 << 20);
      const sh = (w >>> 5) & 3;
      const off = I ? String(((w >>> 4) & 0xf0) | (w & 15)) : reg(rm, pc);
      const base = reg(rn, pc);
      const ea = `${base}${U ? "+" : "-"}${off}`;
      let acc: string;
      if (P) { body = `a=${ea};`; acc = "a"; if (W) body += `r[${rn}]=a;`; }
      else { body = `a=${base};`; acc = "a"; }
      let x: string;
      if (L) {
        if (sh === 1) x = `r[${rd}]=M.ld16u(${acc});`;
        else if (sh === 2) x = `r[${rd}]=M.ld8s(${acc});`;
        else if (sh === 3) x = `r[${rd}]=M.ld16s(${acc});`;
        else x = fault(pc, w, "misc ls");
      } else {
        if (sh === 1) x = `M.st16(${acc},r[${rd}]);`;
        else if (sh === 2) x = `r[${rd}]=M.ld32(${acc});r[${rd + 1}]=M.ld32(${acc}+4);`;                               // LDRD (L=0, sh=2)
        else if (sh === 3) x = `M.st32(${acc},r[${rd}]);M.st32(${acc}+4,r[${rd + 1}]);`;                                // STRD
        else x = fault(pc, w, "misc ls");
      }
      body += x;
      if (!P) body += `r[${rn}]=${ea};`;
      if (L && rd === 15) { body += bx(`r[15]`); ends = true; }
    }
    else if (top === 1 && (w & 0x0fb00000) === 0x03000000) {                                                         // MOVW / MOVT
      const imm16 = ((w >>> 4) & 0xf000) | (w & 0xfff);
      body = w & (1 << 22) ? `r[${rd}]=(r[${rd}]&0xffff)|${imm16 << 16};` : `r[${rd}]=${imm16};`;
    }
    else {
      // data processing
      const op = (w >>> 21) & 15, S = w & (1 << 20);
      const o = op2(w, pc);
      const isLogical = op === 0 || op === 1 || op === 8 || op === 9 || op === 12 || op === 13 || op === 14 || op === 15;
      const noWrite = op >= 8 && op <= 11;
      // arithmetic flag computation needs rn's value after the write, so it goes through local `a`
      const a = S && !isLogical ? "a" : reg(rn, pc);
      let expr: string, flags = "";
      body = `t=${o.v};` + (S && !isLogical ? `a=${reg(rn, pc)};` : "");
      switch (op) {
        case 0: case 8: expr = `${a}&t`; break;
        case 1: case 9: expr = `${a}^t`; break;
        case 12: expr = `${a}|t`; break;
        case 14: expr = `${a}&~t`; break;
        case 13: expr = `t`; break;
        case 15: expr = `~t`; break;
        case 2: case 10: expr = `(${a}-t)|0`; flags = `c.c=(a>>>0)>=(t>>>0)?1:0;c.v=((a^t)&(a^v))>>>31;`; break;
        case 3: expr = `(t-${a})|0`; flags = `c.c=(t>>>0)>=(a>>>0)?1:0;c.v=((t^a)&(t^v))>>>31;`; break;
        case 4: case 11: expr = `(${a}+t)|0`; flags = `c.c=((a>>>0)+(t>>>0))>4294967295?1:0;c.v=((a^v)&(t^v))>>>31;`; break;
        case 5: expr = `(${a}+t+c.c)|0`; flags = `c.c=((a>>>0)+(t>>>0)+c.c)>4294967295?1:0;c.v=((a^v)&(t^v))>>>31;`; break;
        case 6: expr = `(${a}-t-1+c.c)|0`; flags = `c.c=((a>>>0)-(t>>>0)-1+c.c)>=0?1:0;c.v=((a^t)&(a^v))>>>31;`; break;
        default: expr = `(t-${a}-1+c.c)|0`; flags = `c.c=((t>>>0)-(a>>>0)-1+c.c)>=0?1:0;c.v=((t^a)&(t^v))>>>31;`; break;
      }
      body += `v=${expr};`;
      if (S) {
        body += `c.n=v>>>31;c.z=v===0?1:0;`;
        if (isLogical) { if (o.c) body += `c.c=${o.c};`; }
        else body += flags;
      }
      if (!noWrite) {
        if (rd === 15) { body += bx("v"); ends = true; }
        else body += `r[${rd}]=v;`;
      }
    }
  } else if (top === 2 || top === 3) {
    // single data transfer (word/byte), and the ARMv6 media space at top=3 bit4=1
    if (top === 3 && (w & 0x10)) {
      body = media(pc, w, rd, rn, rm, rs);
      if (body === "") { out.push(fault(pc, w, "media/undefined")); return true; }
    } else {
      const P = w & (1 << 24), U = w & (1 << 23), B = w & (1 << 22), W = w & (1 << 21), L = w & (1 << 20);
      const off = top === 2 ? String(w & 0xfff) : op2(w & ~(1 << 25), pc).v;
      const base = reg(rn, pc);
      const ea = `${base}${U ? "+" : "-"}${off}`;
      if (P) { body = `a=${ea};`; if (W) body += `r[${rn}]=a;`; }
      else body = `a=${base};`;
      if (L) body += B ? `t=M.ld8u(a);` : `t=M.ld32(a);`;
      else body += B ? `M.st8(a,${reg(rd, pc)});` : `M.st32(a,${reg(rd, pc)});`;
      if (!P) body += `r[${rn}]=${ea};`;
      if (L) {
        if (rd === 15) { body += bx("t"); ends = true; }
        else body += `r[${rd}]=t;`;
      }
    }
  } else if (top === 4) {
    // LDM/STM
    const P = w & (1 << 24), U = w & (1 << 23), W = w & (1 << 21), L = w & (1 << 20);
    const list = w & 0xffff;
    let n = 0;
    for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
    const base = reg(rn, pc);
    const start = U ? (P ? `${base}+4` : base) : (P ? `${base}-${4 * n}` : `${base}-${4 * n - 4}`);
    body = `a=${start};`;
    const wb = W ? `r[${rn}]=${base}${U ? "+" : "-"}${4 * n};` : "";
    if (L) {
      if (wb) body += wb;
      let i0 = 0;
      for (let i = 0; i < 16; i++) if (list & (1 << i)) {
        if (i === 15) { body += `t=M.ld32(a+${i0 * 4});`; }
        else body += `r[${i}]=M.ld32(a+${i0 * 4});`;
        i0++;
      }
      if (list & 0x8000) { body += bx("t"); ends = true; }
    } else {
      let i0 = 0;
      for (let i = 0; i < 16; i++) if (list & (1 << i)) { body += `M.st32(a+${i0 * 4},${reg(i, pc)});`; i0++; }
      body += wb;
    }
  } else if (top === 6) {
    // LDC/STC (VFP vldr/vstr, or other coprocessors)
    out.push(fault(pc, w, `coprocessor ${(w >>> 8) & 15} load/store (VFP?)`));
    return true;
  } else if (top === 7) {
    if (w & (1 << 24)) { out.push(fault(pc, w, "swi")); return true; }
    const cp = (w >>> 8) & 15;
    if ((w & 0x0ff00fff) === 0x0e1d0f70 && cp === 15) body = `r[${rd}]=c.tlsBase;`;                                   // mrc p15,0,rd,c13,c0,3
    else { out.push(fault(pc, w, `coprocessor ${cp} op (VFP?)`)); return true; }
  } else {
    out.push(fault(pc, w, "undefined"));
    return true;
  }

  if (cond === 14) out.push(body);
  else if (ends) { out.push(`if(${COND[cond]}){${body}}`); ends = false; }
  else out.push(`if(${COND[cond]}){${body}}`);
  return ends;
}

/** ARMv6 media instructions (top=3, bit4=1): extends, reverses, bitfields, saturates, pack */
function media(pc: number, w: number, rd: number, rn: number, rm: number, rs: number): string {
  const op1 = (w >>> 20) & 31, op2b = (w >>> 5) & 7;
  const RM = reg(rm, pc), RN = reg(rn, pc);
  if ((w & 0x0fe00070) === 0x07c00010) {                       // BFI / BFC
    const lsb = (w >>> 7) & 31, msb = (w >>> 16) & 31, width = msb - lsb + 1;
    const mask = width >= 32 ? 0xffffffff : ((1 << width) - 1) << lsb;
    if (rn === 15) return `r[${rd}]=r[${rd}]&${~mask | 0};`;
    return `r[${rd}]=(r[${rd}]&${~mask | 0})|((${RN}<<${lsb})&${mask | 0});`;
  }
  if ((w & 0x0fa00070) === 0x07a00050) {                       // SBFX / UBFX
    const lsb = (w >>> 7) & 31, width = ((w >>> 16) & 31) + 1;
    const u = w & (1 << 22);
    if (u) return `r[${rd}]=${width === 32 ? `${RM}>>>${lsb}` : `(${RM}>>>${lsb})&${((1 << width) - 1) | 0}`};`;
    return `r[${rd}]=(${RM}<<${32 - lsb - width})>>${32 - width};`;
  }
  if (op1 >= 8 && op1 <= 15 && (op2b & 3) === 3) {             // SXTB16/SXTB/SXTH/UXTB16/UXTB/UXTH (+A variants)
    const rot = ((w >>> 10) & 3) * 8;
    const rot_ = rot ? `((${RM}>>>${rot})|(${RM}<<${32 - rot}))` : RM;
    const add = rn === 15 ? "" : `${RN}+`;
    switch (op1) {
      case 10: return `r[${rd}]=${add}((${rot_}<<24)>>24)|0;`;   // SXTB / SXTAB
      case 11: return `r[${rd}]=${add}((${rot_}<<16)>>16)|0;`;   // SXTH / SXTAH
      case 14: return `r[${rd}]=${add}(${rot_}&255)|0;`;         // UXTB / UXTAB
      case 15: return `r[${rd}]=${add}(${rot_}&65535)|0;`;       // UXTH / UXTAH
      case 8: return `t=${rot_};r[${rd}]=(((t<<24)>>24)&0xffff)|(((t<<8)>>24)<<16);`; // SXTB16
      case 12: return `r[${rd}]=${rot_}&0xff00ff;`;              // UXTB16
    }
  }
  if ((w & 0x0fff0ff0) === 0x06bf0f30) return `t=${RM};r[${rd}]=((t&255)<<24)|((t&0xff00)<<8)|((t>>>8)&0xff00)|(t>>>24);`; // REV
  if ((w & 0x0fff0ff0) === 0x06bf0fb0) return `t=${RM};r[${rd}]=((t&0xff00ff)<<8)|((t>>>8)&0xff00ff);`;             // REV16
  if ((w & 0x0fff0ff0) === 0x06ff0fb0) return `t=${RM};r[${rd}]=(((t&255)<<24)>>16)|((t>>>8)&255);`;                 // REVSH
  if ((w & 0x0ff00ff0) === 0x06800fb0) return `r[${rd}]=(c.ge&1?${RN}:${RM})&255|(c.ge&2?${RN}:${RM})&0xff00|(c.ge&4?${RN}:${RM})&0xff0000|(c.ge&8?${RN}:${RM})&0xff000000;`; // SEL
  if ((w & 0x0fe00030) === 0x06a00010 || (w & 0x0fe00030) === 0x06e00010) {                                           // SSAT / USAT
    const sh = (w >>> 7) & 31, asr = w & (1 << 6), sat = (w >>> 16) & 31, u = w & (1 << 22);
    const shifted = asr ? `(${RN}>>${sh || 32})` : `(${RN}<<${sh})`;
    if (u) return `t=${shifted};r[${rd}]=t<0?0:t>${(2 ** sat) - 1}?${(2 ** sat) - 1}:t;`;
    const hi = 2 ** sat - 1, lo = -(2 ** sat);
    return `t=${shifted};r[${rd}]=t<${lo}?${lo}:t>${hi}?${hi}:t;`;
  }
  if ((w & 0x0ff00030) === 0x06800010) {                                                                           // PKHBT / PKHTB
    const sh = (w >>> 7) & 31, tb = w & (1 << 6);
    if (tb) return `r[${rd}]=(${RN}&0xffff0000)|((${RM}>>${sh || 32})&0xffff);`;
    return `r[${rd}]=(${RN}&0xffff)|((${RM}<<${sh})&0xffff0000);`;
  }
  if ((w & 0x0ff000f0) === 0x07800010) {                                                                           // USAD8 / USADA8
    const acc = rd === 15 ? "" : `+r[${rd}]`;
    return `a=${RM};t=${reg(rs, pc)};r[${rn}]=Math.abs((a&255)-(t&255))+Math.abs(((a>>8)&255)-((t>>8)&255))+Math.abs(((a>>16)&255)-((t>>16)&255))+Math.abs((a>>>24)-(t>>>24))${acc}|0;`;
  }
  if ((w & 0x0ff000f0) === 0x0700f010) return `r[${rn}]=Math.imul(${RM},${reg(rs, pc)});`;                          // SMUAD-ish fallbacks not attempted
  if ((w & 0x0ff0f0f0) === 0x0750f010) return `c.smull(${RM},${reg(rs, pc)});r[${rn}]=c.hi;`;                        // SMMUL
  if ((w & 0x0ff000f0) === 0x07500010) return `c.smull(${RM},${reg(rs, pc)});r[${rn}]=c.hi+r[${rd}]|0;`;             // SMMLA
  return "";
}

/** compile the basic block at `pc` to JS source */
export function emitBlock(pc: number): BlockSrc {
  const out: string[] = [`c.bpc=${pc};c.ring[c.rp=(c.rp+1)&63]=${pc};`];
  const pageEnd = (pc & -PAGE_SIZE) + PAGE_SIZE;
  let p = pc, k = 0;
  for (;;) {
    const w = mem.u32[p >>> 2];
    k++;
    const ends = emit(p, w, out, k);
    p += 4;
    if (ends || k >= MAX_BLOCK || p >= pageEnd) break;
  }
  out.push(`c.ic+=${k};return ${hex(p)};`);
  return { src: "let t,a,v;" + out.join("\n"), len: k, end: p };
}
