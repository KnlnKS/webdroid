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

test("LP64 reservations span address planes and MAP_FIXED commits their aligned interior", async () => {
  const cpu = new Cpu(new JThread(), "large mmap test"), mmap = lookupHost("mmap", "libc.so")!;
  const low = await cpu.call(mmap, [0, 0x1fffff000n, 0, 0x4022, -1, 0]);
  const base = BigInt(cpu.ret1 >>> 0) << 32n | BigInt(low >>> 0);
  expect(base).not.toBe(0xffffffffffffffffn);
  const aligned = (base + 0xffffffffn) & ~0xffffffffn;
  const munmap = lookupHost("munmap", "libc.so")!;
  if (aligned !== base) expect(await cpu.call(munmap, [base, aligned - base])).toBe(0);
  expect(await cpu.call(munmap, [aligned + 0x100000000n, base + 0x1fffff000n - aligned - 0x100000000n])).toBe(0);
  const chunks = mem.stats().chunks;
  expect(await cpu.call(mmap, [aligned, 0x100000000n, 0, 0x32, -1, 0])).toBe(Number(aligned & 0xffffffffn));
  expect(mem.stats().chunks).toBe(chunks);
  expect(await cpu.call(mmap, [aligned, 0x80000, 3, 0x32, -1, 0])).toBe(Number(aligned & 0xffffffffn));
  expect(cpu.ret1 >>> 0).toBe(Number(aligned >> 32n));
  let mapped = mem.txVa(aligned);
  mem.st32(mapped, 42); mem.st32(mapped + 4096, 99);
  await cpu.call(mmap, [aligned, 4096, 3, 0x32, -1, 0]);
  mapped = mem.txVa(aligned);
  expect(mem.ld32(mapped)).toBe(0);
  expect(mem.ld32(mapped + 4096)).toBe(99);
  expect(await cpu.call(munmap, [aligned, 0x100000000n])).toBe(0);
  expect(() => mem.txVa(aligned)).toThrow(/unmapped/);
});
