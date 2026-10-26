import { expect, test } from "vite-plus/test";
import "../natives.ts";
import { NativeLooper } from "../android/mainloop.ts";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { defineHost, lookupHost } from "./host.ts";
import { pipeFds } from "./pipe.ts";
import { closeFd, writeFd } from "./fd.ts";
import { ndkInit, nativeWindowFor } from "./libandroid.ts";
import { eglInit } from "./egl.ts";
import { mem } from "./mem.ts";
import type { GlSurface } from "../android/glsurface.ts";
import { Resources } from "../android/res.ts";
import { handle } from "../android/handles.ts";
import { deviceQualifiers } from "../android/configuration.ts";
import { BytesFile } from "../shell/lazyfile.ts";

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

test("a Java looper thread runs its ALooper's fd callbacks between its messages", async () => {
  setA64(true); ndkInit();
  const thread = new JThread(), cpu = new Cpu(thread, "handler-test"), looper = new NativeLooper(thread);
  thread.looper = looper;
  const [read, write] = pipeFds(0), seen: number[] = [];
  const callback = defineHost("looper_fd_test", (_c, a) => { seen.push(a.i()); return 0; });
  try {
    const handle = await cpu.call(lookupHost("ALooper_forThread", "libandroid.so")!);
    expect(await cpu.call(lookupHost("ALooper_addFd", "libandroid.so")!, [handle, read, 0, 1, callback, 0n])).toBe(1);
    await writeFd(write, new Uint8Array([1]));
    await looper.pollOnce(-1);
    expect(seen).toEqual([read]);
  } finally { await closeFd(read); await closeFd(write); cpu.dispose(); setA64(false); }
});

test("buffer geometry sizes EGL buffers while the window keeps its default size", async () => {
  setA64(true); ndkInit(); eglInit();
  const cpu = new Cpu(new JThread(), "geometry-test"), surface: GlSurface = { width: 2160, height: 1080, present: null, frames: 0 };
  const window = nativeWindowFor(surface), out = mem.malloc(8);
  const call = (name: string, lib: string, args: number[]) => cpu.call(lookupHost(name, lib)!, args);
  try {
    expect(await call("ANativeWindow_setBuffersGeometry", "libandroid.so", [window, 900, 450, 1])).toBe(0);
    expect(await call("ANativeWindow_getWidth", "libandroid.so", [window])).toBe(2160);
    await call("eglInitialize", "libEGL.so", [1, 0, 0]);
    const egl = await call("eglCreateWindowSurface", "libEGL.so", [1, 1, window, 0]);
    await call("eglQuerySurface", "libEGL.so", [1, egl, 0x3057, out]);
    await call("eglQuerySurface", "libEGL.so", [1, egl, 0x3056, out + 4]);
    expect([mem.ld32(out), mem.ld32(out + 4)]).toEqual([900, 450]);
  } finally { mem.free(out); cpu.dispose(); setA64(false); }
});

test("NDK assets open as AssetManager2 opens them: from the last apk holding the path, a directory listing its regular files", async () => {
  setA64(true); ndkInit();
  const cpu = new Cpu(new JThread(), "asset-test"), text = (s: string) => new TextEncoder().encode(s);
  const res = new Resources([
    { table: null, zip: { "assets/b.txt": text("base"), "assets/fonts/x.ttf": text("") }, lazyEntries: new Map() },
    { table: null, zip: {}, lazyEntries: new Map([["assets/b.txt", new BytesFile(text("split"))], ["assets/a.txt", new BytesFile(text("a"))]]) },
  ], deviceQualifiers());
  const call = (name: string, args: number[]) => cpu.call(lookupHost(name, "libandroid.so")!, args);
  const am = Number(handle(res)), path = mem.strdup("b.txt"), root = mem.strdup(""), out = mem.malloc(8);
  try {
    const asset = await call("AAssetManager_open", [am, path, 0]);
    expect(await call("AAsset_read", [asset, out, 8])).toBe(5);
    expect(new TextDecoder().decode(mem.bytes(out, 5))).toBe("split");
    const dir = await call("AAssetManager_openDir", [am, root]), names: string[] = [];    for (let name; (name = await call("AAssetDir_getNextFileName", [dir])); ) names.push(mem.cstr(name));
    expect(names).toEqual(["a.txt", "b.txt"]);
    await call("AAssetDir_close", [dir]); await call("AAsset_close", [asset]);
  } finally { mem.free(path); mem.free(root); mem.free(out); cpu.dispose(); setA64(false); }
});
