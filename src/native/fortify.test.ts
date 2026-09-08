import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

beforeAll(() => { setA64(true); libcInit(); });
afterAll(() => setA64(false));

test("fortified writes deliver pipe messages and check full-width buffer bounds", async () => {
  const cpu = new Cpu(new JThread(), "fortified write test");
  const host = (name: string) => lookupHost(name, "libc.so")!;
  const pair = mem.hostAlloc(8), data = mem.hostAlloc(24), out = mem.hostAlloc(24);
  expect(await cpu.call(host("pipe2"), [pair, 0x800])).toBe(0);
  const reader = mem.ld32(pair), writer = mem.ld32(pair + 4);
  mem.u8.fill(42, data, data + 24);
  expect(await cpu.call(host("__write_chk"), [writer, data, 24, 0x100000000n])).toBe(24);
  expect(await cpu.call(host("read"), [reader, out, 24])).toBe(24);
  expect(mem.u8.slice(out, out + 24)).toEqual(mem.u8.slice(data, data + 24));
  await expect(cpu.call(host("__write_chk"), [writer, data, 0x100000001n, 24])).rejects.toThrow("fortify");
  expect(await cpu.call(host("read"), [reader, out, 24])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(11);
  for (const fd of [reader, writer]) await cpu.call(host("close"), [fd]);
});
