import { expect, test } from "bun:test";
import { gl } from "../src/android/gl";
import { EglContext } from "../src/android/glview";
import { bindEglCurrent, boundEglCurrent, glSurfaces } from "../src/native/egl-current";
import { eglInit } from "../src/native/egl";
import { gles3Init } from "../src/native/gles3";
import { hostFn, type ArgReader } from "../src/native/host";
import type { Cpu } from "../src/native/cpu";
import { rt } from "../src/jvm/runtime";
import { curThread, JThread, setCurThread, vcall } from "../src/jvm/natives/jlang";

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
  const cpuA = { jthread: {} }, cpuB = { jthread: {} };

  gles3Init();
  eglInit();
  bindEglCurrent(cpuA.jthread, contextA);
  bindEglCurrent(cpuB.jthread, contextB);
  const makeCurrent = hostFn("libEGL.so", "eglMakeCurrent");
  if (!makeCurrent) throw new Error("EGL host is not registered");
  makeCurrent(cpuA as Cpu, args([1, 0, 0, 0]));
  expect(glSurfaces.current).toBeNull();

  const activeTexture = hostFn("libGLESv2.so", "glActiveTexture");
  if (!activeTexture) throw new Error("GLES host is not registered");
  activeTexture(cpuB as Cpu, args([0x84c1]));

  expect(glSurfaces.current).toBe(contextB);
  expect(gl).toBe(contextB.gl);
  expect(calls).toEqual([0x84c1]);
});

test("Java EGL current state is visible to native GLES on the same thread", async () => {
  gles3Init();
  const original = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  const calls: number[] = [];
  const context = { activeTexture: (texture: number) => calls.push(texture), getParameter: () => 0x84c0 };
  Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: class {
    width: number; height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() { return context; }
  } });
  const previous = curThread, thread = new JThread(), cpu = { jthread: thread } as Cpu;
  setCurThread(thread);
  try {
    const egl = rt.make("javax/microedition/khronos/egl/EGL10");
    const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
    const eglContext = await vcall(egl, "eglCreateContext", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;Ljavax/microedition/khronos/egl/EGLContext;[I)Ljavax/microedition/khronos/egl/EGLContext;", display, null, null, null);
    const surface = await vcall(egl, "eglCreatePbufferSurface", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLConfig;[I)Ljavax/microedition/khronos/egl/EGLSurface;", display, null, null);
    expect(await vcall(egl, "eglMakeCurrent", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z", display, surface, surface, eglContext)).toBe(1);
    expect(boundEglCurrent(thread)).toBe((eglContext as { egl: EglContext }).egl);

    const activeTexture = hostFn("libGLESv2.so", "glActiveTexture");
    if (!activeTexture) throw new Error("GLES host is not registered");
    activeTexture(cpu, args([0x84c2]));
    expect(calls).toEqual([0x84c2]);
  } finally {
    bindEglCurrent(thread, null);
    setCurThread(previous);
    if (original) Object.defineProperty(globalThis, "OffscreenCanvas", original);
    else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  }
});
