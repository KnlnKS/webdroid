import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { setA64, type Cpu } from "./cpu.ts";
import { run, runCases, RET } from "./a64.testkit.ts";

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

const edges = [0n, 1n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xfffffffffffffffen, 0xffffffffffffffffn];
let seed = 0x6d2b79f5;
const word = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const random = Array.from({ length: 64 }, () => (BigInt(word()) << 32n) | BigInt(word()));

function setX(cpu: Cpu, register: number, value: bigint): void {
  cpu.w[2 * register] = Number(value & 0xffffffffn) | 0;
  cpu.w[2 * register + 1] = Number((value >> 32n) & 0xffffffffn) | 0;
}

function result(cpu: Cpu, width: number): bigint {
  return width === 64 ? (BigInt(cpu.w[5] >>> 0) << 32n) | BigInt(cpu.w[4] >>> 0) : BigInt(cpu.w[4] >>> 0);
}

function oracle(width: number, a0: bigint, b0: bigint, carryIn: number, subtract: boolean): { value: bigint; flags: number[] } {
  const a = BigInt.asUintN(width, a0), b = BigInt.asUintN(width, b0), carry = BigInt(carryIn), borrow = 1n - carry;
  const wide = subtract ? a - b - borrow : a + b + carry;
  const value = BigInt.asUintN(width, wide), top = (1n << BigInt(width)) - 1n;
  const signed = subtract ? BigInt.asIntN(width, a) - BigInt.asIntN(width, b) - borrow : BigInt.asIntN(width, a) + BigInt.asIntN(width, b) + carry;
  const min = -(1n << BigInt(width - 1)), max = (1n << BigInt(width - 1)) - 1n;
  return { value, flags: [Number(value >> BigInt(width - 1)), value === 0n ? 1 : 0,
    subtract ? +(a >= b + borrow) : +(wide > top), +(signed < min || signed > max)] };
}

// each program runs every input on the interpreter and again compiled
describe("A64 add/subtract with carry", () => {
  for (const width of [32, 64]) test(`${width}-bit ADCS and SBCS match limb arithmetic`, () => {
    const instructions = width === 64 ? { ADCS: 0xba010002, SBCS: 0xfa010002 } : { ADCS: 0x3a010002, SBCS: 0x7a010002 };
    const cases: [bigint, bigint, number][] = [];
    for (const a of edges) for (const b of edges) cases.push([a, b, 0], [a, b, 1]);
    for (let i = 0; i < random.length - 1; i++) cases.push([random[i], random[i + 1], 0], [random[i], random[i + 1], 1]);
    for (const [name, instruction] of Object.entries(instructions)) {
      const setups = cases.map(([a, b, carry]) => (c: Cpu) => { setX(c, 0, a); setX(c, 1, b); c.w[5] = -1; c.c = carry; });
      runCases([instruction, RET], setups, (tier, cpu, index) => {
        const [a, b, carry] = cases[index];
        const want = oracle(width, a, b, carry, name === "SBCS");
        const gotFlags = [cpu.n, cpu.z, cpu.c, cpu.v];
        if (result(cpu, width) !== want.value || gotFlags.some((flag, i) => flag !== want.flags[i]) || (width === 32 && cpu.w[5] !== 0)) {
          throw new Error(`${tier} ${name}/${width} a=${a.toString(16)} b=${b.toString(16)} carry=${carry}: value=${result(cpu, width).toString(16)} flags=${gotFlags}; expected=${want.value.toString(16)} flags=${want.flags}`);
        }
      });
    }
  });
});

// A region's block budget can run out after a branch has registered its targets, which leaves
// those blocks empty: entering one leaves the region. Flags still pending at that branch must be
// settled on the way in as on any other exit. bn_mul_mont's `cmp x6, #1` fed an `adc` in such a
// block when the region was entered at the function's dispatcher and the sibling variants on the
// same page had spent the budget (clang: cbz x9,far; mov x0,#1; cmp x0,#1; cbz x1,taken;
// fall: adc x2,x2,xzr; ret; taken: adc x3,x3,xzr; ret; far: 635 nops; ret). The far block is
// sized so the cbz at the end of the fall block is jit.zig's MAX_INSTR-th instruction scanned.
describe("A64 carry into a budget-starved block", () => {
  const program = [0xb4000109, 0xd2800020, 0xf100041f, 0xb4000061, 0x9a1f0042, RET, 0x9a1f0063, RET, ...Array<number>(635).fill(0xd503201f), RET];
  for (const [edge, x1] of [["taken", 0], ["fall-through", 1]] as const) test(`the cmp carry reaches the adc across the ${edge} edge`, () => {
    const cpu = run(program, (c) => { c.w[18] = 1; c.w[2] = x1; c.w[4] = 5; c.w[6] = 5; });
    expect(cpu.c).toBe(1);
    expect(cpu.w[x1 ? 4 : 6]).toBe(6);
  });
});
