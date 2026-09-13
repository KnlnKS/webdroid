import { afterAll, beforeAll, expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleStaticField } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
beforeAll(() => {
  if (originalOffscreenCanvas) return;
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: class {
      constructor(readonly width: number, readonly height: number) {}
    },
  });
});
afterAll(() => {
  if (!originalOffscreenCanvas) Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

test("EGL14 queries the created context's client version", async () => {
  const egl = rt.link("android/opengl/EGL14").ctor;
  const display = await vcall(egl, "eglGetDisplay", "(I)Landroid/opengl/EGLDisplay;", 0);
  const configs: unknown[] = [null];
  const count = new Int32Array(1);
  expect(await vcall(egl, "eglChooseConfig", "(Landroid/opengl/EGLDisplay;[II[Landroid/opengl/EGLConfig;II[II)Z",
    display, new Int32Array([0x3038]), 0, configs, 0, 1, count, 0)).toBe(1);
  const noContext = Object.getOwnPropertyDescriptor(egl, mangleStaticField("EGL_NO_CONTEXT"))?.value;
  const context = await vcall(egl, "eglCreateContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Landroid/opengl/EGLContext;[II)Landroid/opengl/EGLContext;",
    display, configs[0], noContext, new Int32Array([0x3098, 3, 0x3038]), 0);
  const result = new Int32Array(2);
  expect(await vcall(egl, "eglQueryContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z",
    display, context, 0x3098, result, 1)).toBe(1);
  expect(result[1]).toBe(3);
  expect(await vcall(egl, "eglQueryContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z",
    display, context, -1, result, 0)).toBe(0);
  expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3004);
});
