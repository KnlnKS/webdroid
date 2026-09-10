import { expect, test } from "bun:test";
import { JObj, rt } from "../jvm/runtime";
import { JThread, mainThread, setCurThread, vcall } from "../jvm/natives/jlang";
import { cpuFor, setA64 } from "./cpu";
import { defineHost, retD } from "./host";
import { jniInit, resolveByExport } from "./jni";
import { mem } from "./mem";

for (const a64 of [false, true]) test(`JNI ${a64 ? "A64" : "ARM32"} floating results survive caller restoration and nested calls`, async () => {
  setA64(a64); jniInit();
  const thread = new JThread(), cpu = cpuFor(thread);
  const oldResolver = rt.jniResolver;
  const name = "test/NativeFp" + (a64 ? "64" : "32");
  rt.register({ name, ctor: class extends JObj {}, methods: { "floatValue(F)F": () => 0, "doubleValue(D)D": () => 0 } });
  const object = new (rt.link(name).ctor)();
  const code = mem.malloc(32);
  if (a64) { mem.st32(code, 0xd65f03c0); mem.st32(code + 16, 0xd65f03c0); }
  else {
    mem.st32(code, 0xe1a00002); mem.st32(code + 4, 0xe12fff1e);
    mem.st32(code + 16, 0xe1a00002); mem.st32(code + 20, 0xe1a01003); mem.st32(code + 24, 0xe12fff1e);
  }
  resolveByExport((symbol) => symbol.endsWith("_floatValue") ? code : symbol.endsWith("_doubleValue") ? code + 16 : undefined);
  rt.jniResolver!(name, "floatValue(F)F"); rt.jniResolver!(name, "doubleValue(D)D");
  setCurThread(thread);
  try {
    cpu.w[0] = 0x12345678; cpu.w[2] = 0x23456789; cpu.d[0] = 987.5;
    expect(await vcall(object, "floatValue", "(F)F", -1.25)).toBe(-1.25);
    expect(cpu.w[0]).toBe(0x12345678); expect(cpu.w[2]).toBe(0x23456789);
    expect(cpu.d[0]).toBe(987.5);
    expect(await vcall(object, "doubleValue", "(D)D", Math.PI)).toBe(Math.PI);
    expect(await vcall(object, "floatValue", "(F)F", -0)).toBe(-0);
    expect(await vcall(object, "doubleValue", "(D)D", -0)).toBe(-0);
    const nested = defineHost("test:nested-fp", async (c) => {
      c.w[0] = 37; c.w[2] = 41; c.d[0] = 73.5;
      expect(await vcall(object, "doubleValue", "(D)D", 1.125)).toBe(1.125);
      expect(await vcall(object, "floatValue", "(F)F", -2.5)).toBe(-2.5);
      expect(c.w[0]).toBe(37); expect(c.w[2]).toBe(41); expect(c.d[0]).toBe(73.5);
      return retD(c, 9.75);
    });
    await cpu.call(nested);
    expect(cpu.retD()).toBe(9.75);
    expect(cpu.w[0]).toBe(0x12345678); if (a64) expect(cpu.d[0]).toBe(987.5);
  } finally {
    rt.jniResolver = oldResolver; setCurThread(mainThread); mem.free(code); setA64(false);
  }
});
