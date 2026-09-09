import { afterAll, beforeAll, describe, test } from "bun:test";
import { setA64, type Cpu } from "./cpu";
import { run, runCold, RET } from "./a64.testkit";

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

const tiers = [["compiled", run], ["cold", runCold]] as const;
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

describe("A64 add/subtract with carry", () => {
  for (const width of [32, 64]) test(`${width}-bit ADCS and SBCS match limb arithmetic`, () => {
    const instructions = width === 64 ? { ADCS: 0xba010002, SBCS: 0xfa010002 } : { ADCS: 0x3a010002, SBCS: 0x7a010002 };
    const pairs: [bigint, bigint][] = [];
    for (const a of edges) for (const b of edges) pairs.push([a, b]);
    for (let i = 0; i < random.length - 1; i++) pairs.push([random[i], random[i + 1]]);
    for (const [name, instruction] of Object.entries(instructions)) for (const [a, b] of pairs) for (const carry of [0, 1]) {
      const want = oracle(width, a, b, carry, name === "SBCS");
      for (const [tier, execute] of tiers) {
        const cpu = execute([instruction, RET], (c) => { setX(c, 0, a); setX(c, 1, b); c.w[5] = -1; c.c = carry; });
        const gotFlags = [cpu.n, cpu.z, cpu.c, cpu.v];
        if (result(cpu, width) !== want.value || gotFlags.some((flag, i) => flag !== want.flags[i]) || (width === 32 && cpu.w[5] !== 0)) {
          throw new Error(`${name}/${width}/${tier} a=${a.toString(16)} b=${b.toString(16)} carry=${carry}: value=${result(cpu, width).toString(16)} flags=${gotFlags}; expected=${want.value.toString(16)} flags=${want.flags}`);
        }
      }
    }
  });
});
