import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost, PTR } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";
import { E } from "./abi";

beforeAll(() => { setA64(true); libcInit(); });
afterAll(() => setA64(false));

test("posix_memalign preserves the output and errno on invalid alignment or allocation failure", async () => {
  const fn = lookupHost("posix_memalign", "libc.so")!, sentinel = 0x123456789abcdef0n;
  for (const a64 of [false, true]) {
    setA64(a64);
    const cpu = new Cpu(new JThread(), "posix_memalign test"), out = mem.malloc(8);
    try {
      mem.st64(out, sentinel);
      mem.st32(cpu.errnoAddr, E.IO);
      for (const alignment of [0, PTR / 2, 24]) {
        expect(await cpu.call(fn, [out, alignment, 128])).toBe(E.INVAL);
        expect(mem.ld64(out)).toBe(sentinel);
        expect(mem.ld32(cpu.errnoAddr)).toBe(E.IO);
      }
      for (const size of a64 ? [0xfffff000, 0x100000001n] : [0xfffff000]) {
        expect(await cpu.call(fn, [out, 4096, size])).toBe(E.NOMEM);
        expect(mem.ld64(out)).toBe(sentinel);
        expect(mem.ld32(cpu.errnoAddr)).toBe(E.IO);
      }
      expect(await cpu.call(fn, [out, 2 << 20, 1 << 20])).toBe(0);
      const p = ldp(out);
      expect(p).not.toBe(0);
      expect(p % (2 << 20)).toBe(0);
      mem.free(p);
    } finally {
      mem.free(out);
      cpu.dispose();
      setA64(true);
    }
  }
});

test("Android memalign rounds arbitrary alignment upward and reports allocation failure", async () => {
  const cpu = new Cpu(new JThread(), "memalign test"), fn = lookupHost("memalign", "libc.so")!;
  try {
    for (const alignment of [0, 3, 17, 4097]) {
      const p = await cpu.call(fn, [alignment, 128]);
      expect(p).not.toBe(0);
      expect(p % 2 ** Math.ceil(Math.log2(alignment || 1))).toBe(0);
      mem.free(p);
    }
    expect(await cpu.call(fn, [4096, 0x100000001n])).toBe(0);
    expect(mem.ld32(cpu.errnoAddr)).toBe(E.NOMEM);
  } finally {
    cpu.dispose();
  }
});

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
