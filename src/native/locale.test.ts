import { afterAll, beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { localeInit } from "./locale";

beforeAll(() => { setA64(true); localeInit(); });
afterAll(() => setA64(false));

test("uselocale restores the opaque AArch64 global locale token", async () => {
  const cpu = new Cpu(mainThread, "locale test");
  const create = lookupHost("newlocale", "libc.so")!;
  const use = lookupHost("uselocale", "libc.so")!;
  const local = await cpu.call(create);
  expect(await cpu.call(use, [local])).toBe(-1);
  expect(cpu.ret1).toBe(-1);
  expect(await cpu.call(use, [-1n])).toBe(local);
  expect(await cpu.call(use, [0])).toBe(-1);
  expect(cpu.ret1).toBe(-1);
});
