import { expect, test } from "bun:test";
import "../natives.ts";
import { NativeLooper } from "../android/mainloop.ts";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { lookupHost } from "./host.ts";
import { ndkInit, nativeWindowFor } from "./libandroid.ts";
import { eglInit } from "./egl.ts";
import { mem } from "./mem.ts";
import type { GlSurface } from "../android/glsurface.ts";

test("Java and NDK code share one thread looper without preparing unrelated threads", async () => {
  setA64(true); ndkInit();
  const thread = new JThread(), cpu = new Cpu(thread, "looper-test");
  const other = new Cpu(new JThread(), "unprepared-test");
  const get = lookupHost("ALooper_forThread", "libandroid.so")!;
  try {
    expect(await cpu.call(get)).toBe(0);
    thread.looper = new NativeLooper(thread);
    const handle = await cpu.call(get);
    expect(handle).toBeGreaterThan(0);
    expect(await cpu.call(lookupHost("ALooper_prepare", "libandroid.so")!, [1])).toBe(handle);
    expect(await cpu.call(get)).toBe(handle);
    expect(await other.call(get)).toBe(0);
  } finally { cpu.dispose(); other.dispose(); setA64(false); }
});

test("buffer geometry sizes EGL buffers while the window keeps its default size", async () => {
  setA64(true); ndkInit(); eglInit();
  const cpu = new Cpu(new JThread(), "geometry-test"), surface: GlSurface = { width: 2160, height: 1080, present: null, frames: 0 };
  const window = nativeWindowFor(surface), out = mem.malloc(8);
  const call = (name: string, lib: string, args: number[]) => cpu.call(lookupHost(name, lib)!, args);
  try {
    expect(await call("ANativeWindow_setBuffersGeometry", "libandroid.so", [window, 900, 450, 1])).toBe(0);
    expect(await call("ANativeWindow_getWidth", "libandroid.so", [window])).toBe(2160);
    const egl = await call("eglCreateWindowSurface", "libEGL.so", [1, 1, window, 0]);
    await call("eglQuerySurface", "libEGL.so", [1, egl, 0x3057, out]);
    await call("eglQuerySurface", "libEGL.so", [1, egl, 0x3056, out + 4]);
    expect([mem.ld32(out), mem.ld32(out + 4)]).toEqual([900, 450]);
  } finally { mem.free(out); cpu.dispose(); setA64(false); }
});
