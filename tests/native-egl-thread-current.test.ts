import { expect, test } from "bun:test";
import { gl } from "../src/android/gl";
import { EglContext, glSurfaces } from "../src/android/glview";
import { bindEglCurrent } from "../src/native/egl-current";
import { eglInit } from "../src/native/egl";
import { gles3Init } from "../src/native/gles3";
import { hostFn, type ArgReader } from "../src/native/host";
import type { Cpu } from "../src/native/cpu";

function args(values: number[]): ArgReader {
  let index = 0;
  const next = () => values[index++] ?? 0;
  return { i: next, u: next, p: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
    f: next, d: next, vd: next, str: () => "", strAt: () => "" };
}

test("unbinding one EGL thread does not clear another thread's GLES context", () => {
  const calls: number[] = [];
  const glA = { activeTexture: () => {}, getParameter: () => 0x84c0 };
  const glB = { activeTexture: (texture: number) => calls.push(texture), getParameter: () => 0x84c0 };
  const contextA = Object.assign(Object.create(EglContext.prototype), { gl: glA, target: null, major: 2 });
  const contextB = Object.assign(Object.create(EglContext.prototype), { gl: glB, target: null, major: 2 });
  const cpuA = {} as Cpu, cpuB = {} as Cpu;

  gles3Init();
  eglInit();
  bindEglCurrent(cpuA, contextA);
  bindEglCurrent(cpuB, contextB);
  const makeCurrent = hostFn("libEGL.so", "eglMakeCurrent");
  if (!makeCurrent) throw new Error("EGL host is not registered");
  makeCurrent(cpuA, args([1, 0, 0, 0]));
  expect(glSurfaces.current).toBeNull();

  const activeTexture = hostFn("libGLESv2.so", "glActiveTexture");
  if (!activeTexture) throw new Error("GLES host is not registered");
  activeTexture(cpuB, args([0x84c1]));

  expect(glSurfaces.current).toBe(contextB);
  expect(gl).toBe(contextB.gl);
  expect(calls).toEqual([0x84c1]);
});
