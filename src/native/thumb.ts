// Thumb-1 (T16, ARMv5T/v6) decoder → JS source for one basic block (bl/blx pairs fused). Same
// contract as arm.ts: the generated function returns the next pc; interworking goes through c.bx.

import { mem } from "./mem";
import { PAGE_SIZE } from "./abi";

const COND = ["c.z", "!c.z", "c.c", "!c.c", "c.n", "!c.n", "c.v", "!c.v",
  "(c.c&&!c.z)", "(!c.c||c.z)", "c.n===c.v", "c.n!==c.v", "(!c.z&&c.n===c.v)", "(c.z||c.n!==c.v)"];
let MAX_BLOCK = 256;
/** 1 = single-instruction blocks (the step tracer) */
export function setMaxBlock(n: number): void { MAX_BLOCK = n; }
const hex = (n: number) => "0x" + (n >>> 0).toString(16);
const NZ = "c.n=v>>>31;c.z=v===0?1:0;";
const ADDF = "c.c=((a>>>0)+(t>>>0))>4294967295?1:0;c.v=((a^v)&(t^v))>>>31;";
const SUBF = "c.c=(a>>>0)>=(t>>>0)?1:0;c.v=((a^t)&(a^v))>>>31;";

/** emit one 16-bit (or fused 32-bit bl/blx) instruction; returns the byte length, negative when it ends the block */
function emit(pc: number, h: number, out: string[], k: number): number {
  const ret = (target: string) => `{c.ic+=${k};return ${target};}`;
  const fault = (what: string) => `r[15]=${pc};c.fault(${JSON.stringify(what + " " + hex(h))});`;
  const top = h >>> 12;
  const rd = h & 7, rn = (h >>> 3) & 7, rm = (h >>> 6) & 7;
  let body: string;
  switch (top) {
    case 0: case 1: {
      const op = (h >>> 11) & 3;
      if (op === 3) {
        // add/sub register or imm3
        const sub = h & (1 << 9), imm = h & (1 << 10);
        const t = imm ? String(rm) : `r[${rm}]`;
        body = `a=r[${rn}];t=${t};v=(a${sub ? "-" : "+"}t)|0;r[${rd}]=v;${NZ}${sub ? SUBF : ADDF}`;
      } else {
        const n = (h >>> 6) & 31;
        if (op === 0) body = n === 0 ? `v=r[${rn}];r[${rd}]=v;${NZ}` : `t=r[${rn}];v=t<<${n};r[${rd}]=v;${NZ}c.c=(t>>>${32 - n})&1;`;
        else if (op === 1) body = n === 0 ? `t=r[${rn}];v=0;r[${rd}]=0;c.n=0;c.z=1;c.c=t>>>31;` : `t=r[${rn}];v=t>>>${n};r[${rd}]=v;${NZ}c.c=(t>>>${n - 1})&1;`;
        else body = n === 0 ? `t=r[${rn}];v=t>>31;r[${rd}]=v;${NZ}c.c=t>>>31;` : `t=r[${rn}];v=t>>${n};r[${rd}]=v;${NZ}c.c=(t>>>${n - 1})&1;`;
      }
      break;
    }
    case 2: case 3: {
      const op = (h >>> 11) & 3, r8 = (h >>> 8) & 7, imm = h & 255;
      if (op === 0) body = `v=${imm};r[${r8}]=v;c.n=0;c.z=${imm === 0 ? 1 : 0};`;
      else if (op === 1) body = `a=r[${r8}];t=${imm};v=(a-t)|0;${NZ}${SUBF}`;
      else if (op === 2) body = `a=r[${r8}];t=${imm};v=(a+t)|0;r[${r8}]=v;${NZ}${ADDF}`;
      else body = `a=r[${r8}];t=${imm};v=(a-t)|0;r[${r8}]=v;${NZ}${SUBF}`;
      break;
    }
    case 4: {
      if ((h & 0xfc00) === 0x4000) {
        // data processing register
        const op = (h >>> 6) & 15;
        const R = `r[${rd}]`, M = `r[${rn}]`;
        switch (op) {
          case 0: body = `v=${R}&${M};${R}=v;${NZ}`; break;
          case 1: body = `v=${R}^${M};${R}=v;${NZ}`; break;
          case 2: body = `v=c.shc(0,${R},${M}&255);${R}=v;${NZ}c.c=c.sc;`; break;
          case 3: body = `v=c.shc(1,${R},${M}&255);${R}=v;${NZ}c.c=c.sc;`; break;
          case 4: body = `v=c.shc(2,${R},${M}&255);${R}=v;${NZ}c.c=c.sc;`; break;
          case 5: body = `a=${R};t=${M};v=(a+t+c.c)|0;${R}=v;${NZ}c.c=((a>>>0)+(t>>>0)+c.c)>4294967295?1:0;c.v=((a^v)&(t^v))>>>31;`; break;
          case 6: body = `a=${R};t=${M};v=(a-t-1+c.c)|0;${R}=v;${NZ}c.c=((a>>>0)-(t>>>0)-1+c.c)>=0?1:0;c.v=((a^t)&(a^v))>>>31;`; break;
          case 7: body = `v=c.shc(3,${R},${M}&255);${R}=v;${NZ}c.c=c.sc;`; break;
          case 8: body = `v=${R}&${M};${NZ}`; break;
          case 9: body = `a=0;t=${M};v=(-t)|0;${R}=v;${NZ}${SUBF}`; break;
          case 10: body = `a=${R};t=${M};v=(a-t)|0;${NZ}${SUBF}`; break;
          case 11: body = `a=${R};t=${M};v=(a+t)|0;${NZ}${ADDF}`; break;
          case 12: body = `v=${R}|${M};${R}=v;${NZ}`; break;
          case 13: body = `v=Math.imul(${R},${M});${R}=v;${NZ}`; break;
          case 14: body = `v=${R}&~${M};${R}=v;${NZ}`; break;
          default: body = `v=~${M};${R}=v;${NZ}`; break;
        }
      } else if ((h & 0xfc00) === 0x4400) {
        // special data / BX / BLX
        const op = (h >>> 8) & 3;
        const d = rd | ((h >>> 4) & 8), m = (h >>> 3) & 15;
        const RM = m === 15 ? String((pc + 4) | 0) : `r[${m}]`;
        if (op === 3) {
          body = (h & 0x80 ? `r[14]=${(pc + 3) | 0};` : "") + ret(`c.bx(${RM})`);
          out.push(body);
          return -2;
        }
        if (op === 0) {
          if (d === 15) { out.push(ret(`((${(pc + 4) | 0}+${RM})&~1)`)); return -2; }
          body = `r[${d}]=(r[${d}]+${RM})|0;`;
          if (d === 13) body = `r[13]=(r[13]+${RM})&~3;`;
        } else if (op === 1) body = `a=r[${d}];t=${RM};v=(a-t)|0;${NZ}${SUBF}`;
        else {
          if (d === 15) { out.push(ret(`(${RM}&~1)`)); return -2; }
          body = `r[${d}]=${RM};`;
        }
      } else {
        // LDR rt, [pc, #imm8*4]
        const rt = (h >>> 8) & 7;
        body = `r[${rt}]=M.ld32(${(((pc + 4) & ~3) + (h & 255) * 4) | 0});`;
      }
      break;
    }
    case 5: {
      const op = (h >>> 9) & 7;
      const a = `r[${rn}]+r[${rm}]`;
      switch (op) {
        case 0: body = `M.st32(${a},r[${rd}]);`; break;
        case 1: body = `M.st16(${a},r[${rd}]);`; break;
        case 2: body = `M.st8(${a},r[${rd}]);`; break;
        case 3: body = `r[${rd}]=M.ld8s(${a});`; break;
        case 4: body = `r[${rd}]=M.ld32(${a});`; break;
        case 5: body = `r[${rd}]=M.ld16u(${a});`; break;
        case 6: body = `r[${rd}]=M.ld8u(${a});`; break;
        default: body = `r[${rd}]=M.ld16s(${a});`; break;
      }
      break;
    }
    case 6: case 7: {
      const B = h & (1 << 12), L = h & (1 << 11), imm = (h >>> 6) & 31;
      const a = `r[${rn}]+${B ? imm : imm * 4}`;
      body = L ? (B ? `r[${rd}]=M.ld8u(${a});` : `r[${rd}]=M.ld32(${a});`) : (B ? `M.st8(${a},r[${rd}]);` : `M.st32(${a},r[${rd}]);`);
      break;
    }
    case 8: {
      const L = h & (1 << 11), imm = ((h >>> 6) & 31) * 2;
      body = L ? `r[${rd}]=M.ld16u(r[${rn}]+${imm});` : `M.st16(r[${rn}]+${imm},r[${rd}]);`;
      break;
    }
    case 9: {
      const L = h & (1 << 11), rt = (h >>> 8) & 7, imm = (h & 255) * 4;
      body = L ? `r[${rt}]=M.ld32(r[13]+${imm});` : `M.st32(r[13]+${imm},r[${rt}]);`;
      break;
    }
    case 10: {
      const rt = (h >>> 8) & 7, imm = (h & 255) * 4;
      body = h & (1 << 11) ? `r[${rt}]=(r[13]+${imm})|0;` : `r[${rt}]=${(((pc + 4) & ~3) + imm) | 0};`;
      break;
    }
    case 11: {
      if ((h & 0xff00) === 0xb000) { const imm = (h & 127) * 4; body = h & 0x80 ? `r[13]=(r[13]-${imm})|0;` : `r[13]=(r[13]+${imm})|0;`; }
      else if ((h & 0xfe00) === 0xb400) {
        // PUSH
        const list = (h & 255) | ((h & 0x100) << 6);
        let n = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
        body = `a=r[13]-${n * 4};r[13]=a;`;
        let i0 = 0;
        for (let i = 0; i < 16; i++) if (list & (1 << i)) { body += `M.st32(a+${i0 * 4},r[${i}]);`; i0++; }
      } else if ((h & 0xfe00) === 0xbc00) {
        // POP
        const list = (h & 255) | ((h & 0x100) << 7);
        let n = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
        body = `a=r[13];r[13]=a+${n * 4};`;
        let i0 = 0;
        for (let i = 0; i < 15; i++) if (list & (1 << i)) { body += `r[${i}]=M.ld32(a+${i0 * 4});`; i0++; }
        if (list & 0x8000) { out.push(body + ret(`c.bx(M.ld32(a+${i0 * 4}))`)); return -2; }
      } else if ((h & 0xff00) === 0xbe00) { out.push(fault("bkpt")); return -2; }
      else if ((h & 0xff00) === 0xbf00) body = "";                                                         // NOP/hints (IT unsupported: v5 has none)
      else if ((h & 0xffc0) === 0xb200) body = `r[${rd}]=(r[${rn}]<<16)>>16;`;                              // SXTH
      else if ((h & 0xffc0) === 0xb240) body = `r[${rd}]=(r[${rn}]<<24)>>24;`;                              // SXTB
      else if ((h & 0xffc0) === 0xb280) body = `r[${rd}]=r[${rn}]&0xffff;`;                                 // UXTH
      else if ((h & 0xffc0) === 0xb2c0) body = `r[${rd}]=r[${rn}]&255;`;                                    // UXTB
      else if ((h & 0xffc0) === 0xba00) body = `t=r[${rn}];r[${rd}]=((t&255)<<24)|((t&0xff00)<<8)|((t>>>8)&0xff00)|(t>>>24);`; // REV
      else if ((h & 0xffc0) === 0xba40) body = `t=r[${rn}];r[${rd}]=((t&0xff00ff)<<8)|((t>>>8)&0xff00ff);`;  // REV16
      else if ((h & 0xffc0) === 0xbac0) body = `t=r[${rn}];r[${rd}]=(((t&255)<<24)>>16)|((t>>>8)&255);`;    // REVSH
      else if ((h & 0xffe8) === 0xb660) body = "";                                                          // CPS
      else if ((h & 0xf500) === 0xb100) {
        // CBZ/CBNZ (v7; harmless to support)
        const nz = h & 0x800, imm = ((h >>> 3) & 31) * 2 + ((h & 0x200) >> 3);
        out.push(`if(${nz ? "" : "!"}r[${rd}]){${ret(hex(pc + 4 + imm))}}`);
        return 2;
      }
      else { out.push(fault("thumb misc")); return -2; }
      break;
    }
    case 12: {
      const L = h & (1 << 11), n8 = (h >>> 8) & 7, list = h & 255;
      let n = 0; for (let i = 0; i < 8; i++) if (list & (1 << i)) n++;
      body = `a=r[${n8}];`;
      let i0 = 0;
      if (L) {
        for (let i = 0; i < 8; i++) if (list & (1 << i)) { body += `r[${i}]=M.ld32(a+${i0 * 4});`; i0++; }
        if (!(list & (1 << n8))) body += `r[${n8}]=a+${n * 4};`;
      } else {
        for (let i = 0; i < 8; i++) if (list & (1 << i)) { body += `M.st32(a+${i0 * 4},r[${i}]);`; i0++; }
        body += `r[${n8}]=a+${n * 4};`;
      }
      break;
    }
    case 13: {
      const cond = (h >>> 8) & 15;
      if (cond === 15) { out.push(fault("swi")); return -2; }
      if (cond === 14) { out.push(fault("udf")); return -2; }
      const off = ((h & 255) << 24) >> 23;
      out.push(`if(${COND[cond]})${ret(hex(pc + 4 + off))}`);
      return 2;
    }
    case 14: {
      if (h & (1 << 11)) {
        // BLX suffix without prefix
        out.push(fault("thumb-2 (11101)"));
        return -2;
      }
      const off = ((h & 0x7ff) << 21) >> 20;
      out.push(ret(hex(pc + 4 + off)));
      return -2;
    }
    default: {
      // 11110: BL/BLX prefix; the second half decides
      if ((h & 0xf800) !== 0xf000) { out.push(fault("thumb-2 (11111)")); return -2; }
      const h2 = mem.u16[(pc + 2) >>> 1];
      if ((h2 & 0xc000) !== 0xc000) { out.push(fault(`thumb-2 32-bit ${hex(h2)}`)); return -2; }
      const S = (h >>> 10) & 1, imm10 = h & 0x3ff, J1 = (h2 >>> 13) & 1, J2 = (h2 >>> 11) & 1, imm11 = h2 & 0x7ff;
      const I1 = 1 - (J1 ^ S), I2 = 1 - (J2 ^ S);
      let off = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
      off = (off << 7) >> 7;
      const link = `r[14]=${(pc + 5) | 0};`;
      if (h2 & 0x1000) out.push(link + ret(hex(pc + 4 + off)));                               // BL
      else out.push(link + ret(`c.bx(${hex(((pc + 4) & ~3) + (off & ~3))})`));                 // BLX (to ARM)
      return -4;
    }
  }
  out.push(body);
  return 2;
}

export function emitThumbBlock(pc: number): { src: string; len: number; end: number } {
  const out: string[] = [`c.bpc=${pc};c.ring[c.rp=(c.rp+1)&63]=${pc | 1};`];
  const pageEnd = (pc & -PAGE_SIZE) + PAGE_SIZE;
  let p = pc, k = 0;
  for (;;) {
    const h = mem.u16[p >>> 1];
    k++;
    const n = emit(p, h, out, k);
    p += Math.abs(n);
    if (n < 0 || k >= MAX_BLOCK || p >= pageEnd) break;
  }
  out.push(`c.ic+=${k};return ${hex(p)};`);
  return { src: "let t,a,v;" + out.join("\n"), len: k, end: p };
}
