import { beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { eglInit } from "./egl";
import { gles1Init } from "./gles1";
import { gles3Init } from "./gles3";
import { hostLib, lookupHost } from "./host";
import { mem } from "./mem";

let cpu: Cpu;
beforeAll(() => {
  setA64(true);
  gles1Init(); gles3Init(); eglInit();
  cpu = new Cpu(mainThread, "EGL proc test");
});

test("EGL resolves programmable GL queries despite ES1 registration order", async () => {
  const query = lookupHost("eglGetProcAddress", "libEGL.so")!;
  const name = mem.hostStr("glGetString");
  const getString = await cpu.call(query, [name]);
  expect(getString).not.toBe(0);
  expect(await cpu.call(query, [name])).toBe(getString);
  expect(mem.cstr(await cpu.call(getString, [0x8b8c]))).toBe("OpenGL ES GLSL ES 3.00");
  expect(mem.cstr(await cpu.call(getString, [0x1f02]))).toBe("OpenGL ES 3.0 webdroid");
});

test("EGL proc lookup stays closed to unsupported and unrelated symbols", async () => {
  hostLib("libegl-test.so", { unrelatedGraphicsSymbol: () => 123 });
  const query = lookupHost("eglGetProcAddress", "libEGL.so")!;
  for (const name of ["glDispatchCompute", "unrelatedGraphicsSymbol", "toString"]) {
    expect(await cpu.call(query, [mem.hostStr(name)])).toBe(0);
  }
  expect(await cpu.call(query, [mem.hostStr("eglGetError")])).toBe(lookupHost("eglGetError", "libEGL.so")!);
});
