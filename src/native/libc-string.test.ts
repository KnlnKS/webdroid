import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

beforeAll(() => { setA64(true); libcInit(); });
afterAll(() => setA64(false));

test("memchr limits its search and returns the first matching byte's address", async () => {
  const cpu = new Cpu(new JThread(), "memchr test");
  const fn = lookupHost("memchr", "libc.so")!, p = mem.malloc(16);
  try {
    mem.u8.set([1, 255, 3, 255, 5, 0], p);
    expect(await cpu.call(fn, [p, -1, 0])).toBe(0);
    expect(await cpu.call(fn, [p, -1, 1])).toBe(0);
    expect(await cpu.call(fn, [p, -1, 2])).toBe(p + 1);
    expect(await cpu.call(fn, [p + 2, 255, 2])).toBe(p + 3);
    expect(await cpu.call(fn, [p, 0, 5])).toBe(0);
    expect(await cpu.call(fn, [p, 0, 6])).toBe(p + 5);
  } finally { mem.free(p); }
});

// A copy wide enough to hold whole pages can overwrite executed code without touching either end
// of its range, so the pages in the middle have to be consulted too.
test("memcpy drops the decoded code on every page it covers", async () => {
  const cpu = new Cpu(new JThread(), "memcpy invalidation test");
  const movW0 = (v: number) => 0x52800000 | (v << 5), ret = 0xd65f03c0;
  const dst = mem.reserve(0x3000, 0x1000), src = mem.malloc(0x3000);
  try {
    // only the middle page is ever executed: the ends stay unflagged
    mem.u32[(dst + 0x1000) >>> 2] = movW0(1); mem.u32[(dst + 0x1004) >>> 2] = ret;
    expect(await cpu.call(dst + 0x1000, [])).toBe(1);

    mem.u8.fill(0, src, src + 0x3000);
    mem.u32[(src + 0x1000) >>> 2] = movW0(2); mem.u32[(src + 0x1004) >>> 2] = ret;
    await cpu.call(lookupHost("memcpy", "libc.so")!, [dst, src, 0x3000]);
    expect(mem.u32[(dst + 0x1000) >>> 2]).toBe(movW0(2));
    expect(await cpu.call(dst + 0x1000, [])).toBe(2);
  } finally { mem.free(src); }
});
