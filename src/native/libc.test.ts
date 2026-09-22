import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

test("sort and search pass pointers in the guest ABI", async () => {
  for (const a64 of [false, true]) {
    setA64(a64); libcInit();
    const cpu = new Cpu(new JThread(), "comparator-test"), data = mem.malloc(20), cmp = mem.reserve(4096, 4096);
    mem.u32.set(a64 ? [0xb9400000, 0xb9400021, 0x4b010000, 0xd65f03c0] : [0xe5900000, 0xe5911000, 0xe0400001, 0xe12fff1e], cmp >>> 2);
    mem.i32.set([9, -2, 4, 1, 4], data >>> 2);
    try {
      await cpu.call(lookupHost("qsort", "libc.so")!, [data, 4, 4, cmp]);
      expect(Array.from(mem.i32.slice(data >>> 2, (data >>> 2) + 4))).toEqual([-2, 1, 4, 9]);
      expect((await cpu.call(lookupHost("bsearch", "libc.so")!, [data + 16, data, 4, 4, cmp])) >>> 0).toBe(data + 8);
      mem.st32(data + 16, 8);
      expect(await cpu.call(lookupHost("bsearch", "libc.so")!, [data + 16, data, 4, 4, cmp])).toBe(0);
    } finally { mem.free(data); cpu.dispose(); }
  }
  setA64(false);
});

test("memmem searches binary ranges without treating NUL as a terminator", async () => {
  for (const a64 of [false, true]) {
    setA64(a64); libcInit();
    const cpu = new Cpu(new JThread(), "memmem-test");
    const data = mem.malloc(8);
    mem.u8.set([1, 0, 2, 1, 0, 2, 0, 3], data);
    const search = lookupHost("memmem", "libc.so")!;
    try {
      expect(await cpu.call(search, [data, 8, data + 3, 3])).toBe(data);
      expect(await cpu.call(search, [data + 1, 7, data + 3, 3])).toBe(data + 3);
      expect(await cpu.call(search, [data, 2, data + 3, 3])).toBe(0);
      expect(await cpu.call(search, [data, 7, data + 7, 1])).toBe(0);
      expect(await cpu.call(search, [data, 8, data + 7, 1])).toBe(data + 7);
      expect(await cpu.call(search, [data, 0, 0, 0])).toBe(data);
    } finally { mem.free(data); cpu.dispose(); }
  }
  setA64(false);
});
