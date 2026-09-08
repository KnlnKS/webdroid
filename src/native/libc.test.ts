import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

beforeAll(() => { setA64(true); libcInit(); });
afterAll(() => setA64(false));

test("mmap accepts an unmapped AArch64 address hint without dereferencing it", async () => {
  const cpu = new Cpu(new JThread(), "mmap test");
  const addr = await cpu.call(lookupHost("mmap", "libc.so")!, [0x200000000n, 4096, 3, 0x22, -1, 0]);
  expect(addr).not.toBe(-1);
  expect(addr).not.toBe(0);
  mem.st32(addr, 42);
  expect(mem.ld32(addr)).toBe(42);
  expect(await cpu.call(lookupHost("munmap", "libc.so")!, [addr, 4096])).toBe(0);
});
