// Dead-flag elimination shared by the ARM and Thumb emitters. Each instruction contributes its
// core code with a `\0F` slot where the flag updates go, the per-flag update snippets, and the
// flags it reads/writes; a backward liveness pass over the block keeps only updates some later
// instruction (or the block's successor) can observe. Thumb-1 sets flags on nearly every ALU op
// and reads them almost never, so this removes most of the flag traffic.

export const N = 8, Z = 4, C = 2, V = 1, ALL = 15;
export interface Fl { n?: string; z?: string; c?: string; v?: string }
export interface Ins { code: string; fl: Fl | null; reads: number; writes: number }

/** flags a condition code tests (index = cond field) */
export const hex = (n: number) => "0x" + (n >>> 0).toString(16);
export const COND_READS = [Z, Z, C, C, N, N, V, V, C | Z, C | Z, N | V, N | V, Z | N | V, Z | N | V, 0, 0];
export const COND = ["c.z", "!c.z", "c.c", "!c.c", "c.n", "!c.n", "c.v", "!c.v",
  "(c.c&&!c.z)", "(!c.c||c.z)", "c.n===c.v", "c.n!==c.v", "(!c.z&&c.n===c.v)", "(c.z||c.n!==c.v)", "", ""];

export const NZ: Fl = { n: "c.n=v>>>31;", z: "c.z=v===0?1:0;" };
export const ADDF: Fl = { ...NZ, c: "c.c=((a>>>0)+(t>>>0))>4294967295?1:0;", v: "c.v=((a^v)&(t^v))>>>31;" };
export const SUBF: Fl = { ...NZ, c: "c.c=(a>>>0)>=(t>>>0)?1:0;", v: "c.v=((a^t)&(a^v))>>>31;" };
export const ADCF: Fl = { ...NZ, c: "c.c=((a>>>0)+(t>>>0)+c.c)>4294967295?1:0;", v: "c.v=((a^v)&(t^v))>>>31;" };
export const SBCF: Fl = { ...NZ, c: "c.c=((a>>>0)-(t>>>0)-1+c.c)>=0?1:0;", v: "c.v=((a^t)&(a^v))>>>31;" };
export const RSBF: Fl = { ...NZ, c: "c.c=(t>>>0)>=(a>>>0)?1:0;", v: "c.v=((t^a)&(t^v))>>>31;" };
export const RSCF: Fl = { ...NZ, c: "c.c=((t>>>0)-(a>>>0)-1+c.c)>=0?1:0;", v: "c.v=((t^a)&(t^v))>>>31;" };
export const maskOf = (f: Fl | null): number => (f ? (f.n ? N : 0) | (f.z ? Z : 0) | (f.c ? C : 0) | (f.v ? V : 0) : 0);

/** the block's JS: flag updates kept only where live (live-out of the block = all) */
export function assemble(ins: Ins[]): string {
  let live = ALL;
  const keep = new Array<number>(ins.length);
  for (let i = ins.length - 1; i >= 0; i--) {
    const x = ins[i];
    keep[i] = live & maskOf(x.fl);
    live = (live & ~x.writes) | x.reads;
  }
  let s = "";
  for (let i = 0; i < ins.length; i++) {
    const x = ins[i], k = keep[i], f = x.fl;
    const fc = f && k ? (k & N ? f.n ?? "" : "") + (k & Z ? f.z ?? "" : "") + (k & C ? f.c ?? "" : "") + (k & V ? f.v ?? "" : "") : "";
    s += x.code.includes("\0F") ? x.code.replace("\0F", fc) : x.code + fc;
    s += "\n";
  }
  return s;
}

// Register hoisting: the block works on locals (`r4`) and writes the dirty ones back to the
// Int32Array before every exit and before anything that reads the file behind our back
// (c.swi, c.fault). Typed-array reads/writes were the bulk of a block's cost.
const R15 = /r\[15\]/g;
export function hoistRegs(src: string): string {
  const used = new Set<number>();
  src.replace(/r\[(\d+)\]/g, (_, n: string) => { if (+n !== 15) used.add(+n); return _; });
  if (!used.size) return src;
  let s = src.replace(R15, "r\0").replace(/r\[(\d+)\]/g, "r$1").replace(/r\0/g, "r[15]");
  const written = new Set<number>();
  s.replace(/\br(\d+)=(?!=)/g, (_, n: string) => { written.add(+n); return _; });
  const wb = [...written].sort((a, b) => a - b).map((n) => `r[${n}]=r${n};`).join("");
  const load = [...used].sort((a, b) => a - b).map((n) => `r${n}=r[${n}]`).join(",");
  s = s.replace(/\breturn\b/g, wb + "return");
  s = s.replace(/c\.fault\(/g, wb + "c.fault(");
  s = s.replace(/c\.swi\(\);/g, wb + "c.swi();" + [...used].map((n) => `r${n}=r[${n}];`).join(""));
  return `let ${load};` + s;
}

// Memory access inlining: the mid-tier JIT does not inline the mem helpers, so the common case
// (in range, aligned, not a code page) is spelled out; the helper stays as the slow/fault path.
const A = "(m1=($1)>>>0)-65536>>>0<268369920";
export function inlineMem(src: string): string {
  return src
    .replace(/M\.ld8u\(([^()]*)\)/g, `(${A}?M.u8[m1]:M.ld8u(m1))`)
    .replace(/M\.ld8s\(([^()]*)\)/g, `(${A}?M.i8[m1]:M.ld8s(m1))`)
    .replace(/M\.ld16u\(([^()]*)\)/g, `(${A}&&!(m1&1)?M.u16[m1>>>1]:M.ld16u(m1))`)
    .replace(/M\.ld16s\(([^()]*)\)/g, `(${A}&&!(m1&1)?M.i16[m1>>>1]:M.ld16s(m1))`)
    .replace(/M\.ld32\(([^()]*)\)/g, `(${A}&&!(m1&3)?M.i32[m1>>>2]:M.ld32(m1))`)
    .replace(/M\.st8\(([^(),]*),([^()]*)\);/g, `if(${A}&&!M.codePages[m1>>>12])M.u8[m1]=$2;else M.st8(m1,$2);`)
    .replace(/M\.st16\(([^(),]*),([^()]*)\);/g, `if(${A}&&!(m1&1)&&!M.codePages[m1>>>12])M.u16[m1>>>1]=$2;else M.st16(m1,$2);`)
    .replace(/M\.st32\(([^(),]*),([^()]*)\);/g, `if(${A}&&!(m1&3)&&!M.codePages[m1>>>12])M.i32[m1>>>2]=$2;else M.st32(m1,$2);`);
}

// A block that branches back to its own start runs that loop inside the block: the register
// locals stay live across iterations instead of round-tripping through the register file, and
// the run loop's indirect dispatch leaves the loop entirely. The iteration cap hands control
// back often enough for the slice budget, and the page check drops out of a loop whose own
// code was overwritten (the store took mem's slow path and invalidated the page).
const LOOP_ITERS = 4096;
export function selfLoop(src: string, pc: number, page: number): string {
  const self = "0x" + (pc >>> 0).toString(16);
  const back = new RegExp(String.raw`\{c\.ic\+=([1-9]\d*);return F\.n\[(\d+)\]\|\|\(F\.n\[\2\]=c\.look\(${self}\)\);\}`, "g");
  if (!back.test(src)) return src;
  back.lastIndex = 0;
  return `let z=${LOOP_ITERS};for(;;){\n` +
    src.replace(back, (_m, k: string) => `{c.ic+=${k};if(--z&&M.codePages[${page}])continue;return F;}`) + "}\n";
}
