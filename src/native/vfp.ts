// VFPv3 coprocessor (CP10/CP11) → JS source, sharing arm.ts's block contract. The register file
// is one 256-byte buffer: `c.s` (32 singles + the upper d16–d31 halves), `c.d` (32 doubles,
// d0–d15 aliasing s0–s31 as the hardware does), `c.si` (the same bits as int32 for VMOV).

/** VFPExpandImm: the 8-bit modified-immediate of VMOV (immediate) as a number */
export function vfpImm(imm8: number, dp: boolean): number {
  const sign = imm8 >> 7, b6 = (imm8 >> 6) & 1, frac = imm8 & 15, e = (imm8 >> 4) & 3;
  const dv = new DataView(new ArrayBuffer(8));
  if (dp) {
    const exp = ((1 - b6) << 10) | (b6 ? 0x3fc : 0) | e;   // NOT(b6):Replicate(b6,8):imm8<5:4>
    dv.setUint32(0, (sign << 31) | (exp << 20) | (frac << 16), false);
    dv.setUint32(4, 0, false);
    return dv.getFloat64(0, false);
  }
  const exp = ((1 - b6) << 7) | (b6 ? 0x7c : 0) | e;       // NOT(b6):Replicate(b6,5):imm8<5:4>
  dv.setUint32(0, ((sign << 31) | (exp << 23) | (frac << 19)) >>> 0, false);
  return dv.getFloat32(0, false);
}

const reg = (n: number, pc: number) => (n === 15 ? String((pc + 8) | 0) : `r[${n}]`);

/** one VFP instruction (ARM encoding, cond already handled by the caller); null when not VFP */
export function emitVfp(pc: number, w: number): string | null {
  const cp = (w >>> 8) & 15;
  if (cp !== 10 && cp !== 11) return null;
  const dp = cp === 11;
  const top = (w >>> 24) & 15;
  const D = (w >>> 22) & 1, N = (w >>> 7) & 1, M = (w >>> 5) & 1;
  const vd = (w >>> 12) & 15, vn = (w >>> 16) & 15, vm = w & 15;
  const Sd = dp ? `c.d[${(D << 4) | vd}]` : `c.s[${(vd << 1) | D}]`;
  const Sn = dp ? `c.d[${(N << 4) | vn}]` : `c.s[${(vn << 1) | N}]`;
  const Sm = dp ? `c.d[${(M << 4) | vm}]` : `c.s[${(vm << 1) | M}]`;
  const f = (e: string) => (dp ? e : `Math.fround(${e})`);

  if (top === 12 || top === 13) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 15, imm8 = w & 255;
    if (top === 12 && !P && !W && ((w >>> 21) & 3) === 2) {
      // 64-bit transfers: VMOV Sm,Sm1 ↔ Rt,Rt2 / VMOV Dm ↔ Rt,Rt2
      const rt = (w >>> 12) & 15, rt2 = (w >>> 16) & 15;
      const m = dp ? ((M << 4) | vm) * 2 : (vm << 1) | M;
      return L ? `r[${rt}]=c.si[${m}];r[${rt2}]=c.si[${m + 1}];` : `c.si[${m}]=r[${rt}];c.si[${m + 1}]=r[${rt2}];`;
    }
    if (P && !W) {
      // VLDR / VSTR
      const base = rn === 15 ? String(((pc + 8) & ~3) | 0) : `r[${rn}]`;
      const a = `${base}${U ? "+" : "-"}${imm8 * 4}`;
      if (L) return dp ? `c.d[${(D << 4) | vd}]=M.ldf64(${a});` : `c.s[${(vd << 1) | D}]=M.ldf32(${a});`;
      return dp ? `M.stf64(${a},c.d[${(D << 4) | vd}]);` : `M.stf32(${a},c.s[${(vd << 1) | D}]);`;
    }
    // VLDM / VSTM / VPUSH / VPOP
    const count = dp ? imm8 >> 1 : imm8;
    const first = dp ? (D << 4) | vd : (vd << 1) | D;
    const bytes = imm8 * 4;
    let s = U ? `a=r[${rn}]${P ? "+0" : ""};` : `a=r[${rn}]-${bytes};`;
    for (let i = 0; i < count; i++) {
      const off = i * (dp ? 8 : 4);
      s += L ? (dp ? `c.d[${first + i}]=M.ldf64(a+${off});` : `c.s[${first + i}]=M.ldf32(a+${off});`)
             : (dp ? `M.stf64(a+${off},c.d[${first + i}]);` : `M.stf32(a+${off},c.s[${first + i}]);`);
    }
    if (W) s += `r[${rn}]=r[${rn}]${U ? "+" : "-"}${bytes};`;
    return s;
  }
  if (top !== 14) return null;
  if (w & 0x10) {
    // register transfers
    const rt = (w >>> 12) & 15, op = (w >>> 21) & 7, L = (w >>> 20) & 1;
    if (op === 0 && !dp) {
      const n = (vn << 1) | N;
      return L ? `r[${rt}]=c.si[${n}];` : `c.si[${n}]=${reg(rt, pc)};`;
    }
    if (op === 7 && !dp) {
      // VMRS / VMSR (FPSCR = reg 1; FPSID/MVFR read as constants)
      const sys = vn;
      if (L) {
        if (sys === 1) return rt === 15 ? `c.n=(c.fpscr>>>31)&1;c.z=(c.fpscr>>>30)&1;c.c=(c.fpscr>>>29)&1;c.v=(c.fpscr>>>28)&1;` : `r[${rt}]=c.fpscr;`;
        return `r[${rt}]=${sys === 0 ? 0x410330c0 : sys === 6 ? 0x11111111 : sys === 7 ? 0x00011100 : 0};`;
      }
      return sys === 1 ? `c.fpscr=r[${rt}];` : "";
    }
    if (dp && (op === 0 || op === 1)) {
      // VMOV scalar ↔ core (D[n][x] as 32-bit lane, opc1[0]:opc2 select) — only the 32-bit lane form is emitted by compilers here
      const idx = ((op & 1) << 1) | ((w >>> 5) & 3);
      if ((w & 0x60) === 0) { const lane = (((N << 4) | vn) * 2) + (idx >> 1 & 1); return L ? `r[${rt}]=c.si[${lane}];` : `c.si[${lane}]=${reg(rt, pc)};`; }
    }
    return null;
  }
  // data processing
  const opc1 = (w >>> 20) & 0xb;
  const o6 = (w >>> 6) & 1;
  switch (opc1) {
    case 0x0: return o6 ? `${Sd}=${f(`${Sd}-${f(`${Sn}*${Sm}`)}`)};` : `${Sd}=${f(`${Sd}+${f(`${Sn}*${Sm}`)}`)};`;   // VMLA/VMLS
    case 0x1: return o6 ? `${Sd}=${f(`-${Sd}-${f(`${Sn}*${Sm}`)}`)};` : `${Sd}=${f(`-${Sd}+${f(`${Sn}*${Sm}`)}`)};`; // VNMLA/VNMLS
    case 0x2: return o6 ? `${Sd}=${f(`-(${Sn}*${Sm})`)};` : `${Sd}=${f(`${Sn}*${Sm}`)};`;                              // VNMUL/VMUL
    case 0x3: return o6 ? `${Sd}=${f(`${Sn}-${Sm}`)};` : `${Sd}=${f(`${Sn}+${Sm}`)};`;                                  // VSUB/VADD
    case 0x8: return o6 ? null : `${Sd}=${f(`${Sn}/${Sm}`)};`;                                                           // VDIV
    case 0x9: return o6 ? `${Sd}=${f(`-${Sd}-${Sn}*${Sm}`)};` : `${Sd}=${f(`-${Sd}+${Sn}*${Sm}`)};`;                   // VFNMA/VFNMS (fused: exact product)
    case 0xa: return o6 ? `${Sd}=${f(`${Sd}-${Sn}*${Sm}`)};` : `${Sd}=${f(`${Sd}+${Sn}*${Sm}`)};`;                     // VFMS/VFMA
    case 0xb: {
      if (!o6) { const imm = vfpImm(((w >>> 12) & 0xf0) | (w & 15), dp); return `${Sd}=${imm};`; }                       // VMOV imm
      const opc2 = vn, o7 = (w >>> 7) & 1;
      switch (opc2) {
        case 0: return o7 ? `${Sd}=Math.abs(${Sm});` : `${Sd}=${Sm};`;                                                   // VABS / VMOV
        case 1: return o7 ? `${Sd}=Math.sqrt(${Sm});` : `${Sd}=-${Sm};`;                                                 // VSQRT / VNEG
        case 4: case 5: {                                                                                                // VCMP(E) / VCMP(E) #0
          const b = opc2 === 5 ? "0" : Sm;
          return `a=${Sd};t=${b};c.fpscr=(c.fpscr&0x0fffffff)|(a<t?0x80000000:a===t?0x60000000:a>t?0x20000000:0x30000000);`;
        }
        case 7: return o7 ? (dp ? `c.s[${(vd << 1) | D}]=c.d[${(M << 4) | vm}];` : `c.d[${(D << 4) | vd}]=c.s[${(vm << 1) | M}];`) : null; // VCVT d↔s
        case 8: {                                                                                                        // VCVT from int: o7 = signed
          const src = `c.si[${(vm << 1) | M}]`;
          return `${Sd}=${o7 ? src : `(${src}>>>0)`};`;
        }
        case 12: case 13: {                                                                                              // VCVT to int (12 unsigned, 13 signed); o7 = round toward zero
          const v = `${Sm}`;
          const rnd = o7 ? `Math.trunc(t)` : `c.rne(t)`;
          const dst = `c.si[${(vd << 1) | D}]`;
          return opc2 === 13
            ? `t=${v};t=t!==t?0:${rnd};${dst}=t>=2147483647?2147483647:t<=-2147483648?-2147483648:t;`
            : `t=${v};t=t!==t?0:${rnd};${dst}=(t>=4294967295?4294967295:t<=0?0:t)|0;`;
        }
        case 2: case 3: return null;                                                                                     // half-precision
        default: return null;                                                                                            // fixed-point conversions
      }
    }
    default: return null;
  }
}
