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
