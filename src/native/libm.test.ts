import { afterAll, beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { RET_SENTINEL } from "./abi";
import { bitsf, fbits, lookupHost } from "./host";
import { libmInit } from "./libm";

beforeAll(() => { setA64(true); libmInit(); });
afterAll(() => setA64(false));

test("nextafterf steps one float32 ULP, including signed zero and infinities", async () => {
  const cpu = new Cpu(mainThread, "nextafterf test"), fn = lookupHost("nextafterf", "libm.so")!;
  const run = async (x: number, y: number) => {
    cpu.ensureStack(); cpu.r[30] = RET_SENTINEL; cpu.s[0] = x; cpu.s[4] = y; cpu.setPc(fn);
    await cpu.run();
  };
  const cases = [
    [1, 2, 0x3f800001], [1, 0, 0x3f7fffff], [-1, 0, 0xbf7fffff], [-1, -2, 0xbf800001],
    [0, 1, 1], [-0, -1, 0x80000001], [0, -0, 0x80000000], [-0, 0, 0],
    [bitsf(1), 0, 0], [bitsf(0x80000001), 0, 0x80000000],
    [Infinity, 0, 0x7f7fffff], [-Infinity, 0, 0xff7fffff],
    [bitsf(0x7f7fffff), Infinity, 0x7f800000], [bitsf(0xff7fffff), -Infinity, 0xff800000],
  ];
  for (const [x, y, bits] of cases) {
    await run(x, y);
    expect(fbits(cpu.s[0]) >>> 0).toBe(bits);
  }
  for (const [x, y] of [[NaN, 1], [1, NaN]]) {
    await run(x, y);
    expect(cpu.s[0]).toBeNaN();
  }
});
