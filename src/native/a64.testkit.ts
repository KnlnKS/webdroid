// The harness the A64 tests share: a code page reserved through mem.reserve (never an address
// the stack allocator can march into), a fresh Cpu, and the slice loop run to the return
// sentinel. Encodings in the tests come from `clang -target aarch64-linux-gnu`, never hand-derived.
// Every program also runs past the heat threshold so its region compiles (synchronously under
// node), and the JIT's register file must agree with the interpreter's.
import { expect } from "vite-plus/test";
import { mem } from "./mem.ts";
import { Cpu } from "./cpu.ts";
import { core, jitStats, JIT_HEAT } from "./core.ts";
import { mainThread } from "../jvm/natives/jentry.ts";
import { RET_SENTINEL } from "./abi.ts";

export const RET = 0xd65f03c0;
/** run c's slices to the return sentinel; a fault's synchronous signal throws with its siginfo */
export function finish(c: Cpu, budget = 10000): void {
  for (let ex; (ex = c.runSlice(budget)) !== 2;) {
    if (ex !== 3) continue;
    const { sig, info } = c.raised!;
    c.raised = null;
    throw new Error(`signal ${sig} code ${info.code} addr 0x${info.addr.toString(16)}`);
  }
}

/** every image page the tests reserved (code, data), which sweep puts back */
const images: [number, number][] = [];
const reserve = mem.reserve;
mem.reserve = (size, align) => { const base = reserve(size, align); images.push([base, size]); return base; };

/** one Cpu for every run: a thread stack is address space that is never given back */
let shared: Cpu | null = null;
function execute(at: number, setup: (c: Cpu) => void): Cpu {
  const c = (shared ??= new Cpu(mainThread, "test"));
  c.w.fill(0); c.si.fill(0);
  c.cpsr = 0; c.excl = 0; c.fpcr = 0; c.fpsr = 0;
  c.ensureStack();
  c.w[62] = c.stackTop;
  setup(c);
  c.w[60] = RET_SENTINEL;
  c.setPc(at);
  finish(c);
  return c;
}
export function place(words: number[]): number {
  const at = mem.reserve((words.length * 4 + 0xfff) & ~0xfff, 0x1000);
  for (let i = 0; i < words.length; i++) mem.u32[(at >>> 2) + i] = words[i];
  return at;
}
/** the V file with every arithmetic NaN canonical: which payload an operation leaves, and from
 *  which operand, is the engine's business (it may commute a multiply) and differs between tiers.
 *  ARM32 names only D0-D31 (v0-v15); its interpreter borrows v16 and up as scratch. */
function vfile(c: Cpu): number[] {
  const si = Array.from(c.a64 ? c.si : c.si.subarray(0, 64)), f = new Float32Array(c.si.buffer, c.si.byteOffset, 128), d = new Float64Array(c.si.buffer, c.si.byteOffset, 64);
  for (let i = 0; i < si.length / 2; i++) {
    if (d[i] !== d[i]) { si[2 * i] = 0; si[2 * i + 1] = 0x7ff80000; continue; }
    for (const h of [2 * i, 2 * i + 1]) if (f[h] !== f[h]) si[h] = 0x7fc00000;
  }
  return si;
}
const state = (c: Cpu) => [Array.from(c.w), vfile(c), c.pc, c.cpsr, c.fpcr, c.fpsr, c.excl];
/** The program's first run, the one the test's expectations describe. A program whose second
 *  run reproduces the first (no time, no memory it rewrites) then runs to the JIT, which must
 *  agree; memory is put back so the test sees the first run's. */
export function sweep(run1: (at: number, setup: (c: Cpu) => void) => Cpu, at: number, setup: (c: Cpu) => void): Cpu {
  const image = images.map(([base, size]) => mem.u8.slice(base, base + size));
  const c0 = run1(at, setup), stack = mem.u8.slice(c0.stackBase, c0.stackTop);
  const s1 = state(c0);
  if (JSON.stringify(state(run1(at, setup))) === JSON.stringify(s1)) {
    const before = jitStats.regions;
    for (let i = 0; i < JIT_HEAT; i++) run1(at, setup);
    const c = run1(at, setup);
    expect(jitStats.regions).toBeGreaterThan(before);
    expect(state(c)).toEqual(s1);
  }
  images.forEach(([base], i) => mem.u8.set(image[i], base)); mem.u8.set(stack, c0.stackBase);
  core.invalidate_all(); // the image region holds the decode blocks too
  return run1(at, setup);
}
export function run(words: number[], setup: (c: Cpu) => void = () => {}): Cpu {
  return sweep(execute, place(words), setup);
}
/** Check one register-only program against many inputs in both tiers without recompiling it per input. */
export function runCases(words: number[], setups: ((c: Cpu) => void)[], check: (tier: string, c: Cpu, index: number) => void): void {
  const at = place(words);
  // past JIT_HEAT inputs the region would otherwise compile inside the interpreter pass
  jitStats.on = false;
  try { for (let i = 0; i < setups.length; i++) check("interp", execute(at, setups[i]), i); } finally { jitStats.on = true; }
  const before = jitStats.regions;
  for (let i = 0; i < JIT_HEAT; i++) execute(at, setups[0]);
  if (jitStats.regions === before) throw new Error("the program did not compile");
  for (let i = 0; i < setups.length; i++) check("jit", execute(at, setups[i]), i);
}

/** a page whose byte at offset i is i & 0xff, for load/store tests */
export function pattern(): number {
  const buf = mem.reserve(0x1000, 0x1000);
  for (let i = 0; i < 0x1000; i++) mem.u8[buf + i] = i & 0xff;
  return buf;
}
