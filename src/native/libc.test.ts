import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

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
