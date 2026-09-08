import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { ldp, lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

let cpu: Cpu;
beforeAll(() => { setA64(true); libcInit(); cpu = new Cpu(new JThread(), "environment test"); });
afterAll(() => setA64(false));
const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
const entries = () => {
  const result: string[] = [];
  for (let p = ldp(lookupHost("environ", "libc.so")!), entry; (entry = ldp(p)); p += 8) result.push(mem.cstr(entry));
  return result;
};

test("environ is a terminated array consistent with getenv and environment updates", async () => {
  expect(entries()).toContain("HOME=/data");
  expect(mem.cstr(await call("getenv", mem.hostStr("HOME")))).toBe("/data");
  const key = mem.hostStr("WEBDROID_ENV_TEST"), first = mem.hostStr("first=one"), second = mem.hostStr("second");
  expect(await call("setenv", key, first, 1)).toBe(0);
  expect(entries()).toContain("WEBDROID_ENV_TEST=first=one");
  expect(mem.cstr(await call("getenv", key))).toBe("first=one");
  expect(await call("setenv", key, second, 0)).toBe(0);
  expect(mem.cstr(await call("getenv", key))).toBe("first=one");
  expect(await call("setenv", key, second, 1)).toBe(0);
  expect(entries()).toContain("WEBDROID_ENV_TEST=second");
  expect(entries().filter((s) => s.startsWith("WEBDROID_ENV_TEST="))).toHaveLength(1);
  expect(await call("unsetenv", key)).toBe(0);
  expect(await call("getenv", key)).toBe(0);
  expect(entries().some((s) => s.startsWith("WEBDROID_ENV_TEST="))).toBe(false);
  expect(await call("setenv", mem.hostStr(""), first, 1)).toBe(-1);
  expect(await call("unsetenv", mem.hostStr("bad=name"))).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(22);
});

test("getenv observes a guest replacement of environ", async () => {
  const symbol = lookupHost("environ", "libc.so")!, previous = mem.ld64(symbol), array = mem.malloc(16);
  try {
    mem.st64(array, BigInt(mem.hostStr("GUEST_ENV=value"))); mem.st64(array + 8, 0n); mem.st64(symbol, BigInt(array));
    expect(mem.cstr(await call("getenv", mem.hostStr("GUEST_ENV")))).toBe("value");
    expect(await call("getenv", mem.hostStr("HOME"))).toBe(0);
  } finally { mem.st64(symbol, previous); mem.free(array); }
});
