// Thumb-1 (T16, ARMv5T/v6) decoder → JS source for one basic block (bl/blx pairs fused). Same
// contract as arm.ts: the generated function returns the next pc; interworking goes through c.bx.
// Flag updates go through flags.ts so only the observable ones survive.

import { mem } from "./mem";
import { PAGE_SIZE, PAGE_SHIFT } from "./abi";
import { type Ins, type Fl, C, COND, COND_READS, hex, maskOf, NZ, ADDF, SUBF, ADCF, SBCF, assemble, hoistRegs, inlineMem, selfLoop, retK } from "./flags";

let MAX_BLOCK = 256;
/** 1 = single-instruction blocks (the step tracer) */
export function setMaxBlock(n: number): void { MAX_BLOCK = n; }
const NZC: Fl = { ...NZ, c: "c.c=c.sc;" };
const RSB0: Fl = { ...NZ, c: "c.c=(0>>>0)>=(t>>>0)?1:0;", v: "c.v=((0^t)&(0^v))>>>31;" };

let redirect = -1, slot = 0;
const ret1 = (k: number, target: string) => retK(slot++, k, target);
/** emit one 16-bit (or fused 32-bit bl/blx) instruction; returns the byte length, negative when it ends the block */
function emit(pc: number, h: number, out: Ins[], k: number): number {
  const ret = (target: string) => ret1(k, target);
  const fault = (what: string) => `r[15]=${pc};c.fault(${JSON.stringify(what + " " + hex(h))});`;
  const push = (code: string, fl: Fl | null = null, reads = 0, writes = maskOf(fl)) => out.push({ code, fl, reads, writes });
  const top = h >>> 12;
  const rd = h & 7, rn = (h >>> 3) & 7, rm = (h >>> 6) & 7;
  switch (top) {
    case 0: case 1: {
      const op = (h >>> 11) & 3;
      if (op === 3) {
        const sub = h & (1 << 9), imm = h & (1 << 10);
        const t = imm ? String(rm) : `r[${rm}]`;
        push(`a=r[${rn}];t=${t};v=(a${sub ? "-" : "+"}t)|0;r[${rd}]=v;`, sub ? SUBF : ADDF);
      } else {
        const n = (h >>> 6) & 31;
        if (op === 0) { if (n === 0) push(`v=r[${rn}];r[${rd}]=v;`, NZ); else push(`t=r[${rn}];v=t<<${n};r[${rd}]=v;`, { ...NZ, c: `c.c=(t>>>${32 - n})&1;` }); }
        else if (op === 1) { if (n === 0) push(`t=r[${rn}];v=0;r[${rd}]=0;`, { n: "c.n=0;", z: "c.z=1;", c: "c.c=t>>>31;" }); else push(`t=r[${rn}];v=t>>>${n};r[${rd}]=v;`, { ...NZ, c: `c.c=(t>>>${n - 1})&1;` }); }
        else { if (n === 0) push(`t=r[${rn}];v=t>>31;r[${rd}]=v;`, { ...NZ, c: "c.c=t>>>31;" }); else push(`t=r[${rn}];v=t>>${n};r[${rd}]=v;`, { ...NZ, c: `c.c=(t>>>${n - 1})&1;` }); }
      }
      return 2;
    }
    case 2: case 3: {
      const op = (h >>> 11) & 3, r8 = (h >>> 8) & 7, imm = h & 255;
      if (op === 0) push(`v=${imm};r[${r8}]=v;`, { n: "c.n=0;", z: `c.z=${imm === 0 ? 1 : 0};` });
      else if (op === 1) push(`a=r[${r8}];t=${imm};v=(a-t)|0;`, SUBF);
      else if (op === 2) push(`a=r[${r8}];t=${imm};v=(a+t)|0;r[${r8}]=v;`, ADDF);
      else push(`a=r[${r8}];t=${imm};v=(a-t)|0;r[${r8}]=v;`, SUBF);
      return 2;
    }
    case 4: {
      if ((h & 0xfc00) === 0x4000) {
        const op = (h >>> 6) & 15;
        const R = `r[${rd}]`, M = `r[${rn}]`;
        switch (op) {
          case 0: push(`v=${R}&${M};${R}=v;`, NZ); break;
          case 1: push(`v=${R}^${M};${R}=v;`, NZ); break;
          case 2: push(`v=c.shc(0,${R},${M}&255);${R}=v;`, NZC, C); break;
          case 3: push(`v=c.shc(1,${R},${M}&255);${R}=v;`, NZC, C); break;
          case 4: push(`v=c.shc(2,${R},${M}&255);${R}=v;`, NZC, C); break;
          case 5: push(`a=${R};t=${M};v=(a+t+c.c)|0;${R}=v;`, ADCF, C); break;
          case 6: push(`a=${R};t=${M};v=(a-t-1+c.c)|0;${R}=v;`, SBCF, C); break;
          case 7: push(`v=c.shc(3,${R},${M}&255);${R}=v;`, NZC, C); break;
          case 8: push(`v=${R}&${M};`, NZ); break;
          case 9: push(`t=${M};v=(-t)|0;${R}=v;`, RSB0); break;
          case 10: push(`a=${R};t=${M};v=(a-t)|0;`, SUBF); break;
          case 11: push(`a=${R};t=${M};v=(a+t)|0;`, ADDF); break;
          case 12: push(`v=${R}|${M};${R}=v;`, NZ); break;
          case 13: push(`v=Math.imul(${R},${M});${R}=v;`, NZ); break;
          case 14: push(`v=${R}&~${M};${R}=v;`, NZ); break;
          default: push(`v=~${M};${R}=v;`, NZ); break;
        }
        return 2;
      }
      if ((h & 0xfc00) === 0x4400) {
        const op = (h >>> 8) & 3;
        const d = rd | ((h >>> 4) & 8), m = (h >>> 3) & 15;
        const RM = m === 15 ? String((pc + 4) | 0) : `r[${m}]`;
        if (op === 3) { push((h & 0x80 ? `r[14]=${(pc + 3) | 0};` : "") + `{t=${RM};c.t=t&1;c.ic+=${k};return c.look(t&~1);}`); return -2; }
        if (op === 0) {
          if (d === 15) { push(`{c.ic+=${k};return c.look((${(pc + 4) | 0}+${RM})&~1);}`); return -2; }
          push(`r[${d}]=(r[${d}]+${RM})|0;`);
        } else if (op === 1) push(`a=r[${d}];t=${RM};v=(a-t)|0;`, SUBF);
        else {
          if (d === 15) { push(`{c.ic+=${k};return c.look(${RM}&~1);}`); return -2; }
          push(`r[${d}]=${RM};`);
        }
        return 2;
      }
      push(`r[${(h >>> 8) & 7}]=M.ld32(${(((pc + 4) & ~3) + (h & 255) * 4) | 0});`);
      return 2;
    }
    case 5: {
      const op = (h >>> 9) & 7;
      const a = `r[${rn}]+r[${rm}]`;
      const T = [`M.st32(${a},r[${rd}]);`, `M.st16(${a},r[${rd}]);`, `M.st8(${a},r[${rd}]);`, `r[${rd}]=M.ld8s(${a});`,
        `r[${rd}]=M.ld32(${a});`, `r[${rd}]=M.ld16u(${a});`, `r[${rd}]=M.ld8u(${a});`, `r[${rd}]=M.ld16s(${a});`];
      push(T[op]);
      return 2;
    }
    case 6: case 7: {
      const B = h & (1 << 12), L = h & (1 << 11), imm = (h >>> 6) & 31;
      const a = `r[${rn}]+${B ? imm : imm * 4}`;
      push(L ? (B ? `r[${rd}]=M.ld8u(${a});` : `r[${rd}]=M.ld32(${a});`) : (B ? `M.st8(${a},r[${rd}]);` : `M.st32(${a},r[${rd}]);`));
      return 2;
    }
    case 8: {
      const L = h & (1 << 11), imm = ((h >>> 6) & 31) * 2;
      push(L ? `r[${rd}]=M.ld16u(r[${rn}]+${imm});` : `M.st16(r[${rn}]+${imm},r[${rd}]);`);
      return 2;
    }
    case 9: {
      const L = h & (1 << 11), rt = (h >>> 8) & 7, imm = (h & 255) * 4;
      push(L ? `r[${rt}]=M.ld32(r[13]+${imm});` : `M.st32(r[13]+${imm},r[${rt}]);`);
      return 2;
    }
    case 10: {
      const rt = (h >>> 8) & 7, imm = (h & 255) * 4;
      push(h & (1 << 11) ? `r[${rt}]=(r[13]+${imm})|0;` : `r[${rt}]=${(((pc + 4) & ~3) + imm) | 0};`);
      return 2;
    }
    case 11: {
      if ((h & 0xff00) === 0xb000) { const imm = (h & 127) * 4; push(h & 0x80 ? `r[13]=(r[13]-${imm})|0;` : `r[13]=(r[13]+${imm})|0;`); return 2; }
      if ((h & 0xfe00) === 0xb400) {
        const list = (h & 255) | ((h & 0x100) << 6);
        let n = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
        let body = `a=r[13]-${n * 4};r[13]=a;`;
        let i0 = 0;
        for (let i = 0; i < 16; i++) if (list & (1 << i)) { body += `M.st32(a+${i0 * 4},r[${i}]);`; i0++; }
        push(body);
        return 2;
      }
      if ((h & 0xfe00) === 0xbc00) {
        const list = (h & 255) | ((h & 0x100) << 7);
        let n = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
        let body = `a=r[13];r[13]=a+${n * 4};`;
        let i0 = 0;
        for (let i = 0; i < 15; i++) if (list & (1 << i)) { body += `r[${i}]=M.ld32(a+${i0 * 4});`; i0++; }
        if (list & 0x8000) { push(body + `{t=M.ld32(a+${i0 * 4});c.t=t&1;c.ic+=${k};return c.look(t&~1);}`); return -2; }
        push(body);
        return 2;
      }
      if ((h & 0xff00) === 0xbe00) { push(fault("bkpt")); return -2; }
      if ((h & 0xff00) === 0xbf00) { push(""); return 2; }                                                      // NOP/hints
      if ((h & 0xffc0) === 0xb200) { push(`r[${rd}]=(r[${rn}]<<16)>>16;`); return 2; }                          // SXTH
      if ((h & 0xffc0) === 0xb240) { push(`r[${rd}]=(r[${rn}]<<24)>>24;`); return 2; }                          // SXTB
      if ((h & 0xffc0) === 0xb280) { push(`r[${rd}]=r[${rn}]&0xffff;`); return 2; }                             // UXTH
      if ((h & 0xffc0) === 0xb2c0) { push(`r[${rd}]=r[${rn}]&255;`); return 2; }                                // UXTB
      if ((h & 0xffc0) === 0xba00) { push(`t=r[${rn}];r[${rd}]=((t&255)<<24)|((t&0xff00)<<8)|((t>>>8)&0xff00)|(t>>>24);`); return 2; }
      if ((h & 0xffc0) === 0xba40) { push(`t=r[${rn}];r[${rd}]=((t&0xff00ff)<<8)|((t>>>8)&0xff00ff);`); return 2; }
      if ((h & 0xffc0) === 0xbac0) { push(`t=r[${rn}];r[${rd}]=(((t&255)<<24)>>16)|((t>>>8)&255);`); return 2; }
      if ((h & 0xffe8) === 0xb660) { push(""); return 2; }                                                      // CPS
      if ((h & 0xf500) === 0xb100) {
        const nz = h & 0x800, imm = ((h >>> 3) & 31) * 2 + ((h & 0x200) >> 3);
        push(`if(${nz ? "" : "!"}r[${rd}]){${ret(hex(pc + 4 + imm))}}`);
        return 2;
      }
      push(fault("thumb misc"));
      return -2;
    }
    case 12: {
      const L = h & (1 << 11), n8 = (h >>> 8) & 7, list = h & 255;
      let n = 0; for (let i = 0; i < 8; i++) if (list & (1 << i)) n++;
      let body = `a=r[${n8}];`;
      let i0 = 0;
      if (L) {
        for (let i = 0; i < 8; i++) if (list & (1 << i)) { body += `r[${i}]=M.ld32(a+${i0 * 4});`; i0++; }
        if (!(list & (1 << n8))) body += `r[${n8}]=a+${n * 4};`;
      } else {
        for (let i = 0; i < 8; i++) if (list & (1 << i)) { body += `M.st32(a+${i0 * 4},r[${i}]);`; i0++; }
        body += `r[${n8}]=a+${n * 4};`;
      }
      push(body);
      return 2;
    }
    case 13: {
      const cond = (h >>> 8) & 15;
      if (cond === 15) { push(`r[15]=${pc};c.swi();`); return 2; }
      if (cond === 14) { push(fault("udf")); return -2; }
      const off = ((h & 255) << 24) >> 23;
      push(`if(${COND[cond]})${ret(hex(pc + 4 + off))}`, null, COND_READS[cond]);
      return 2;
    }
    case 14: {
      if (h & (1 << 11)) { push(fault("thumb-2 (11101)")); return -2; }
      const off = ((h & 0x7ff) << 21) >> 20;
      redirect = pc + 4 + off;
      push(`c.ic+=${k};`);
      return -2;
    }
    default: {
      if ((h & 0xf800) !== 0xf000) { push(fault("thumb-2 (11111)")); return -2; }
      const h2 = mem.u16[(pc + 2) >>> 1];
      if ((h2 & 0xc000) !== 0xc000) { push(fault(`thumb-2 32-bit ${hex(h2)}`)); return -2; }
      const S = (h >>> 10) & 1, imm10 = h & 0x3ff, J1 = (h2 >>> 13) & 1, J2 = (h2 >>> 11) & 1, imm11 = h2 & 0x7ff;
      const I1 = 1 - (J1 ^ S), I2 = 1 - (J2 ^ S);
      let off = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
      off = (off << 7) >> 7;
      const link = `r[14]=${(pc + 5) | 0};`;
      if (h2 & 0x1000) push(link + ret(hex(pc + 4 + off)));                                 // BL
      else push(link + `c.t=0;` + ret(hex(((pc + 4) & ~3) + (off & ~3))));                  // BLX (to ARM)
      return -4;
    }
  }
}

export function emitThumbBlock(pc: number): { src: string; len: number; end: number; slots: number } {
  slot = 0;
  const out: Ins[] = [{ code: `c.bpc=${pc | 1};`, fl: null, reads: 0, writes: 0 }];
  const pageStart = pc & -PAGE_SIZE, pageEnd = pageStart + PAGE_SIZE;
  const seen = new Set<number>();
  let p = pc, k = 0, end = pc;
  for (;;) {
    const h = mem.u16[p >>> 1];
    k++;
    seen.add(p);
    redirect = -1;
    const n = emit(p, h, out, k);
    p += Math.abs(n);
    if (p > end) end = p;
    if (redirect >= 0) {
      if (redirect >= pageStart && redirect < pageEnd && !seen.has(redirect) && k < MAX_BLOCK) { p = redirect; k = 0; continue; }
      out.push({ code: ret1(0, hex(redirect)), fl: null, reads: 0, writes: 0 });
      break;
    }
    if (n < 0 || k >= MAX_BLOCK || p >= pageEnd) break;
  }
  if (redirect < 0) out.push({ code: ret1(k, hex(p)), fl: null, reads: 0, writes: 0 });
  return { src: "let t,a,v,m1;" + hoistRegs(selfLoop(inlineMem(assemble(out)), pc, pc >>> PAGE_SHIFT)), len: (end - pc + 3) >> 2, end, slots: slot };
}
