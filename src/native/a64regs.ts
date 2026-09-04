// Operand spellings shared by the A64 integer emitter (a64.ts) and the SIMD&FP emitter
// (a64simd.ts): the core registers as split hi/lo pairs, and the V register file by lane.
//
// x31 reads as SP in one family of instructions and as zero in the other, which is why every
// core operand goes through one of two accessors rather than being spelled directly.

export const SP = 31;
export const sp = (n: number) => `r[${n}]`;
export const sph = (n: number) => `H[${n}]`;
export const zr = (n: number) => (n === SP ? "0" : `r[${n}]`);
export const zrh = (n: number) => (n === SP ? "0" : `H[${n}]`);
/** write a 64-bit result to a zero-register-encoded destination */
/** a high half computed from the destination's own low half goes through the temporaries */
export const setX = (d: number, lo: string, hi: string) =>
  d === SP ? "" : hi.includes(`r[${d}]`) ? `v=${lo};vh=${hi};r[${d}]=v;H[${d}]=vh;` : `r[${d}]=${lo};H[${d}]=${hi};`;
/** write a 32-bit result: A64 zero-extends every W write into its X register */
export const setW = (d: number, lo: string) => (d === SP ? "" : `r[${d}]=${lo};H[${d}]=0;`);
/** write to a stack-pointer-encoded destination (ADD/SUB immediate with S=0) */
export const setSP = (d: number, lo: string, hi: string) => `r[${d}]=${lo};H[${d}]=${hi};`;

/** a constant bound for a register: spelled as the int32 the register file would hold, because a
 *  hoisted local keeps the literal as written and `0xffffffff` is not -1 to `>` or `===` */
export const int32 = (n: number) => String(n | 0);
export const sx = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);

// ── constant shifts of a 64-bit value held as two expressions. Every A64 shift whose amount is
// in the encoding is constant, so the split is resolved here and costs nothing at run time.
export function shl64(lo: string, hi: string, s: number): [string, string] {
  if (s === 0) return [lo, hi];
  if (s === 32) return ["0", lo];
  if (s > 32) return ["0", `(${lo}<<${s - 32})`];
  return [`(${lo}<<${s})`, `((${hi}<<${s})|(${lo}>>>${32 - s}))`];
}
export function shr64(lo: string, hi: string, s: number): [string, string] {
  if (s === 0) return [lo, hi];
  if (s === 32) return [hi, "0"];
  if (s > 32) return [`(${hi}>>>${s - 32})`, "0"];
  return [`((${lo}>>>${s})|(${hi}<<${32 - s}))`, `(${hi}>>>${s})`];
}
export function sar64(lo: string, hi: string, s: number): [string, string] {
  if (s === 0) return [lo, hi];
  if (s === 32) return [hi, `(${hi}>>31)`];
  if (s > 32) return [`(${hi}>>${s - 32})`, `(${hi}>>31)`];
  return [`((${lo}>>>${s})|(${hi}<<${32 - s}))`, `(${hi}>>${s})`];
}
export function ror64(lo: string, hi: string, s: number): [string, string] {
  s &= 63;
  if (s === 0) return [lo, hi];
  const [al, ah] = shr64(lo, hi, s);
  const [bl, bh] = shl64(lo, hi, 64 - s);
  return [`(${al}|${bl})`, `(${ah}|${bh})`];
}
/** LSL/LSR/ASR/ROR of a 64- or 32-bit operand by a constant */
export function shiftOf(lo: string, hi: string, type: number, s: number, sf: boolean): [string, string] {
  if (sf) return type === 0 ? shl64(lo, hi, s) : type === 1 ? shr64(lo, hi, s) : type === 2 ? sar64(lo, hi, s) : ror64(lo, hi, s);
  if (s === 0) return [lo, "0"];
  if (type === 0) return [`(${lo}<<${s})`, "0"];
  if (type === 1) return [`(${lo}>>>${s})`, "0"];
  if (type === 2) return [`(${lo}>>${s})`, "0"];
  return [`((${lo}>>>${s})|(${lo}<<${32 - s}))`, "0"];
}

// ── the V register file, by lane. The block prologue binds the views (`S` singles, `D` doubles,
// `I`/`U` words, `W`/`SW` halfwords, `B`/`SB` bytes) only when a block uses them. Vn starts at
// lane n*PER[view]; V32/V33 are the emitter's scratch.
export type View = "S" | "D" | "I" | "U" | "W" | "SW" | "B" | "SB";
export const PER: Record<View, number> = { S: 4, D: 2, I: 4, U: 4, W: 8, SW: 8, B: 16, SB: 16 };
export const VIEWS: Record<View, string> = { S: "c.s", D: "c.d", I: "c.si", U: "c.vu", W: "c.vw", SW: "c.vsw", B: "c.vb", SB: "c.vsb" };
export const SCRATCH = 32;
export const lane = (v: View, n: number, i: number) => `${v}[${n * PER[v] + i}]`;
/** a 64-bit vector write leaves the upper half zero */
export const zeroHi = (d: number) => `D[${2 * d + 1}]=0;`;
/** a scalar S/H/B write leaves everything above it zero */
export const zeroS = (d: number) => `I[${4 * d + 1}]=0;D[${2 * d + 1}]=0;`;
/** the four words of Vn */
export const words = (n: number) => [0, 1, 2, 3].map((i) => `I[${4 * n + i}]`);

/** a 64-bit register += (lo, hi) with the carry into the high half: post/pre-index writeback */
export const wb64 = (rn: number, lo: string | number, hi: string | number = typeof lo === "number" && lo < 0 ? -1 : 0): string =>
  rn === SP ? `r[31]=(r[31]+${lo})|0;`
    : `v=(${sp(rn)}+${lo})|0;${sph(rn)}=(${sph(rn)}+${hi}+(((${sp(rn)}>>>0)+(${lo}>>>0))>4294967295?1:0))|0;${sp(rn)}=v;`;
/** an address in plane h ≠ 0 (a high half the base register carries) is translated before the access */
export const txA = (rn: number): string => (rn === SP ? "" : `if(${sph(rn)})a=M.tx(${sph(rn)},a);`);
/** the register-offset form: either register may carry the plane, so the sum's high half decides.
 *  `lo` is the shifted, extended index's low word as the emitter computed it. */
export function txAx(rn: number, rm: number, option: number, s: number, lo: string): string {
  const x = option === 3 || option === 7;                                  // an X index; else a W one, zero- (2) or sign-extended (6)
  const ih = !s ? (x ? zrh(rm) : option === 2 ? "0" : `(${zr(rm)}>>31)`)
    : `(${x ? `${zrh(rm)}<<${s}` : option === 2 ? "0" : `(${zr(rm)}>>31)<<${s}`}|(${zr(rm)}>>>${32 - s}))`;
  const carry = `(((${sp(rn)}>>>0)+(${lo}>>>0))>4294967295?1:0)`;
  return `t=${rn === SP ? "0" : sph(rn)}+${ih}+${carry};if(t)a=M.tx(t,a);`;                    // a negative index and the carry cancel: plane 0
}
