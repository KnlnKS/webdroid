import "../../src/natives";
import { frame, present, setScreenCanvas } from "../../src/shell/device";
import { JBitmap, JRect } from "../../src/android/graphics";
import { dispatchAttached, dispatchDetached, uiState } from "../../src/android/view";
import { rt } from "../../src/jvm/runtime";
import { mangleStaticField, mangleMethod } from "../../src/jvm/abi";
import { JThread, setCurThread, mainThread, curThread, vcallMaybe, vcallOn } from "../../src/jvm/natives/jlang";
import { gl, tables } from "../../src/android/gl";
import { glSurfaces } from "../../src/native/egl-current";
import { EglContext, type GlSurface } from "../../src/android/glview";
import { mem } from "../../src/native/mem";
import { Cpu, setA64 } from "../../src/native/cpu";
import { jitStats, JIT_HEAT } from "../../src/native/core";
import { RET_SENTINEL } from "../../src/native/abi";
import { gles1Init } from "../../src/native/gles1";
import { gles3Init } from "../../src/native/gles3";
import { nativeWindowFor, ndkInit } from "../../src/native/libandroid";
import { hostFn, type ArgReader } from "../../src/native/host";

function callGl(cpu: Cpu, lib: string, name: string, values: number[]) {
  let i = 0;
  const next = () => values[i++] ?? 0;
  const args: ArgReader = { i: next, p: next, u: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
    f: next, d: next, vd: next, str: () => "", strAt: () => "" };
  const fn = hostFn(lib, name);
  if (!fn) throw new Error(`Missing native ${name}`);
  return fn(cpu, args);
}

function readback() {
  setA64(false); gles1Init(); gles3Init();
  const context = new EglContext();
  context.makeCurrent({ view: null, width: 4, height: 4, present: null, frames: 0 });
  const g = context.gl!, cpu = new Cpu(mainThread, "readback");
  const base = mem.reserve(0x3000, 0x1000);
  const execute = (at: number) => {
    cpu.w.fill(0); cpu.cpsr = 0; cpu.w[28] = RET_SENTINEL; cpu.setPc(at);
    for (let i = 0; i < 8; i++) if (cpu.runSlice(100) === 2) return cpu.w[0];
    throw new Error("Readback code did not return");
  };
  const init = (at: number) => { mem.st32(at, 0xe3a00001); mem.st32(at + 4, 0xe12fff1e); };
  const fbo = g.createFramebuffer(), rgba = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, rgba); g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, 1, 2);
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, rgba, 0);
  g.clearColor(2 / 255, 0, 160 / 255, 227 / 255); g.clear(g.COLOR_BUFFER_BIT);
  const at = base + 4092;
  init(at); init(at + 16);
  const regions = jitStats.regions;
  for (let i = 0; i <= JIT_HEAT; i++) { execute(at); execute(at + 16); }
  const compiled = jitStats.regions >= regions + 2;
  const before = [execute(at), execute(at + 16)];
  g.pixelStorei(g.PACK_ROW_LENGTH, 4); g.pixelStorei(g.PACK_SKIP_ROWS, 1); g.pixelStorei(g.PACK_SKIP_PIXELS, 1);
  callGl(cpu, "libGLESv2.so", "glReadPixels", [0, 0, 1, 2, g.RGBA, g.UNSIGNED_BYTE, at - 20]);
  const after = [execute(at), execute(at + 16)], error = g.getError();
  g.pixelStorei(g.PACK_ROW_LENGTH, 0); g.pixelStorei(g.PACK_SKIP_ROWS, 0); g.pixelStorei(g.PACK_SKIP_PIXELS, 0);
  g.pixelStorei(g.PACK_ALIGNMENT, 8);
  init(base); init(base + 8);
  for (let i = 0; i <= JIT_HEAT; i++) { execute(base); execute(base + 8); }
  callGl(cpu, "libGLESv1_CM.so", "glReadPixels", [0, 0, 1, 2, g.RGBA, g.UNSIGNED_BYTE, base]);
  const es1 = [execute(base), execute(base + 8)], es1Error = g.getError();
  const texture = g.createTexture(); g.bindTexture(g.TEXTURE_2D, texture);
  g.texStorage2D(g.TEXTURE_2D, 1, g.R32UI, 1, 1);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
  g.clearBufferuiv(g.COLOR, 0, Uint32Array.of(0x12345678, 0, 0, 0));
  callGl(cpu, "libGLESv2.so", "glReadPixels", [0, 0, 1, 1, g.RED_INTEGER, g.UNSIGNED_INT, base + 33]);
  const unaligned = mem.ld32(base + 33), integerError = g.getError();
  g.deleteFramebuffer(fbo); g.deleteTexture(texture); g.deleteTexture(rgba); context.makeCurrent(null);
  return { compiled, before, after, error, es1, es1Error, unaligned, integerError };
}

function uploadExtents() {
  gles3Init();
  const context = new EglContext();
  context.makeCurrent({ view: null, width: 4, height: 4, present: null, frames: 0 });
  const g = context.gl!, cpu = new Cpu(mainThread, "texture-upload"), p = mem.reserve(0x1000, 0x1000);
  const lengths: number[] = [];
  for (const name of ["texSubImage2D", "texSubImage3D"] as const) {
    const original = g[name];
    Object.defineProperty(g, name, { configurable: true, value: (...args: unknown[]) => {
      const pixels = args.at(-1);
      if (ArrayBuffer.isView(pixels)) lengths.push(pixels.byteLength);
      return Reflect.apply(original, g, args);
    } });
  }
  const two = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, two);
  g.texStorage2D(g.TEXTURE_2D, 1, g.RGB8, 3, 2);
  callGl(cpu, "libGLESv2.so", "glTexSubImage2D", [g.TEXTURE_2D, 0, 0, 0, 3, 2, g.RGB, g.UNSIGNED_BYTE, p]);
  const error2D = g.getError();
  const three = g.createTexture();
  g.bindTexture(g.TEXTURE_3D, three);
  g.texStorage3D(g.TEXTURE_3D, 1, g.RGBA8, 2, 2, 2);
  g.pixelStorei(g.UNPACK_ROW_LENGTH, 3); g.pixelStorei(g.UNPACK_IMAGE_HEIGHT, 4);
  g.pixelStorei(g.UNPACK_SKIP_IMAGES, 1); g.pixelStorei(g.UNPACK_SKIP_ROWS, 1); g.pixelStorei(g.UNPACK_SKIP_PIXELS, 1);
  callGl(cpu, "libGLESv2.so", "glTexSubImage3D", [g.TEXTURE_3D, 0, 0, 0, 0, 2, 2, 2, g.RGBA, g.UNSIGNED_BYTE, p]);
  const error3D = g.getError();
  g.deleteTexture(two); g.deleteTexture(three); context.makeCurrent(null);
  return { lengths, error2D, error3D };
}

async function probe() {
  rt.linkNatives();
  const e10 = rt.make("javax/microedition/khronos/egl/EGL10");
  const c14 = rt.link("android/opengl/EGL14").ctor;
  const call14 = (name: string, desc: string, ...args: unknown[]) => Reflect.apply(Reflect.get(c14, mangleMethod(name, desc)), c14, args);
  const E10 = "Ljavax/microedition/khronos/egl/", E14 = "Landroid/opengl/";
  const display10 = vcallMaybe(e10, "eglGetDisplay", "(Ljava/lang/Object;)" + E10 + "EGLDisplay;", null);
  const context10 = vcallMaybe(e10, "eglCreateContext", `(${E10}EGLDisplay;${E10}EGLConfig;${E10}EGLContext;[I)${E10}EGLContext;`, display10, null, null, Int32Array.of(0x3098, 2, 0x3038));
  const surface10 = vcallMaybe(e10, "eglCreatePbufferSurface", `(${E10}EGLDisplay;${E10}EGLConfig;[I)${E10}EGLSurface;`, display10, null, Int32Array.of(0x3057, 4, 0x3056, 4, 0x3038));
  const first = new JThread(), second = new JThread();
  setCurThread(first);
  const bound10 = vcallMaybe(e10, "eglMakeCurrent", `(${E10}EGLDisplay;${E10}EGLSurface;${E10}EGLSurface;${E10}EGLContext;)Z`, display10, surface10, surface10, context10);
  const firstGL = gl, firstTables = tables();
  gl?.clearColor(1, 0, 0, 1);
  const suspended = vcallMaybe(e10, "eglSwapBuffers", `(${E10}EGLDisplay;${E10}EGLSurface;)Z`, display10, surface10);
  rt.st(second);
  const emptySecond = gl === null && glSurfaces.current === null;
  const display14 = call14("eglGetDisplay", "(I)" + E14 + "EGLDisplay;", 0);
  const configs: unknown[] = [null];
  call14("eglChooseConfig", `(${E14}EGLDisplay;[II[${E14}EGLConfig;II[II)Z`, display14, null, 0, configs, 0, 1, new Int32Array(1), 0);
  const no14 = Reflect.get(c14, mangleStaticField("EGL_NO_CONTEXT"));
  if (!no14) throw new Error("EGL14 has no EGL_NO_CONTEXT handle");
  const context14 = call14("eglCreateContext", `(${E14}EGLDisplay;${E14}EGLConfig;${E14}EGLContext;[II)${E14}EGLContext;`, display14, configs[0], no14, Int32Array.of(0x3098, 2, 0x3038), 0);
  const surface14 = call14("eglCreatePbufferSurface", `(${E14}EGLDisplay;${E14}EGLConfig;[II)${E14}EGLSurface;`, display14, configs[0], Int32Array.of(0x3057, 2, 0x3056, 2, 0x3038), 0);
  const bound14 = call14("eglMakeCurrent", `(${E14}EGLDisplay;${E14}EGLSurface;${E14}EGLSurface;${E14}EGLContext;)Z`, display14, surface14, surface14, context14);
  const isolated = gl !== firstGL && tables() !== firstTables;
  call14("eglGetDisplay", "(I)" + E14 + "EGLDisplay;", 99);
  rt.st(first);
  const firstError = vcallMaybe(e10, "eglGetError", "()I");
  const restored = gl === firstGL && tables() === firstTables;
  const sameContext10 = vcallMaybe(e10, "eglGetCurrentContext", "()" + E10 + "EGLContext;") === context10;
  rt.st(second);
  const secondError = call14("eglGetError", "()I");
  const sameContext14 = call14("eglGetCurrentContext", "()" + E14 + "EGLContext;") === context14;
  call14("eglReleaseThread", "()Z");
  await suspended;
  rt.st(first);
  const restoredAfterRelease = gl === firstGL;
  gl?.clear(gl.COLOR_BUFFER_BIT);
  const swapped = await vcallMaybe(e10, "eglSwapBuffers", `(${E10}EGLDisplay;${E10}EGLSurface;)Z`, display10, surface10);
  rt.st(first);
  const canvas = new OffscreenCanvas(4, 4), ctx = canvas.getContext("2d")!;
  ctx.drawImage(glSurfaces.current!.target!.present!, 0, 0);
  const pixel = [...ctx.getImageData(1, 1, 1, 1).data];
  rt.su(first);
  const mainEmpty = gl === null;
  const callback = rt.make("java/lang/Object");
  Object.assign(callback, { [mangleMethod("run", "()V")]: () => gl === firstGL });
  const callbackRestored = vcallOn(first, callback, "run", "()V");
  setCurThread(mainThread);
  const view = rt.make("android/opengl/GLSurfaceView"), renderer = rt.make("java/lang/Object");
  const rendererGL = new OffscreenCanvas(4, 4).getContext("webgl2")!;
  const rendererThread = Reflect.get(view, "glThread"), callbacks: boolean[] = [];
  Object.assign(view, { ctx: rendererGL, renderer });
  const suspend = async () => { callbacks.push(gl === rendererGL && curThread === rendererThread); rt.su(rendererThread); await Promise.resolve(); };
  Object.assign(renderer, {
    [mangleMethod("onSurfaceCreated", "(Ljavax/microedition/khronos/opengles/GL10;Ljavax/microedition/khronos/egl/EGLConfig;)V")]: suspend,
    [mangleMethod("onSurfaceChanged", "(Ljavax/microedition/khronos/opengles/GL10;II)V")]: suspend,
    [mangleMethod("onDrawFrame", "(Ljavax/microedition/khronos/opengles/GL10;)V")]: suspend,
  });
  await Reflect.apply(Reflect.get(view, "runFrame"), view, []);
  return { callbacks, bound10, bound14, emptySecond, isolated, restored, sameContext10, sameContext14,
    firstError, secondError, restoredAfterRelease, swapped, pixel, mainEmpty, callbackRestored, mainStillEmpty: gl === null,
    lifecycle: await lifecycle(), nativeWindow: await nativeWindow(), windowCopy: await windowCopy(), readback: readback(), uploads: uploadExtents() };
}
async function nativeWindow() {
  ndkInit();
  const surface: GlSurface = { view: null, width: 2, height: 1, present: null, frames: 0 };
  const handle = nativeWindowFor(surface), out = mem.malloc(64);
  const cpu = new Cpu(mainThread, "window-buffer");
  const invoke = (name: string, values: number[]) => {
    let i = 0; const next = () => values[i++] ?? 0;
    const args: ArgReader = { i: next, u: next, p: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
      f: next, d: next, vd: next, str: () => "", strAt: () => "" };
    return hostFn("libandroid.so", name)!(cpu, args);
  };
  const sameHandle = nativeWindowFor(surface) === handle;
  await invoke("ANativeWindow_release", [handle]);
  const locked = await invoke("ANativeWindow_lock", [handle, out, 0]);
  const dimensions = [mem.ld32(out), mem.ld32(out + 4), mem.ld32(out + 8), mem.ld32(out + 12)];
  const duplicate = await invoke("ANativeWindow_lock", [handle, out, 0]);
  mem.write(mem.ld32(out + 16), Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255));
  const posted = await invoke("ANativeWindow_unlockAndPost", [handle]);
  const canvas = new OffscreenCanvas(2, 1), ctx = canvas.getContext("2d")!;
  ctx.drawImage(surface.present!, 0, 0);
  const pixels = [...ctx.getImageData(0, 0, 2, 1).data];
  await invoke("ANativeWindow_setBuffersGeometry", [handle, 2, 2, 0x32315659]);
  await invoke("ANativeWindow_lock", [handle, out, 0]);
  const stride = mem.ld32(out + 8), bits = mem.ld32(out + 16);
  mem.bytes(bits, 32).fill(81); mem.bytes(bits + 32, 16).fill(240); mem.bytes(bits + 48, 16).fill(90);
  await invoke("ANativeWindow_unlockAndPost", [handle]);
  ctx.drawImage(surface.present!, 0, 0);
  const red = ctx.getImageData(0, 0, 1, 1).data;
  const yv12 = stride === 16 && red[0] > 240 && red[1] < 10 && red[2] < 10 && red[3] === 255;
  await invoke("ANativeWindow_release", [handle]);
  const released = await invoke("ANativeWindow_lock", [handle, out, 0]);
  const fresh = nativeWindowFor(surface);
  const reset = fresh !== handle && await invoke("ANativeWindow_getFormat", [fresh]) === 1;
  await invoke("ANativeWindow_release", [fresh]);
  surface.present?.close(); mem.free(out);
  return { locked, dimensions, duplicate, posted, pixels, yv12, released, sameHandle, reset, frames: surface.frames };
}
async function windowCopy() {
  const screen = document.createElement("canvas"); screen.width = screen.height = 4;
  setScreenCanvas(screen);
  const copy = async () => {
    const bitmap = new JBitmap(); bitmap.w = bitmap.h = 4;
    const rect = new JRect(); rect.right = rect.bottom = 4;
    const listener = rt.make("java/lang/Object");
    let finish = (_code: number) => {};
    const done = new Promise<number>(resolve => { finish = resolve; });
    Object.assign(listener, { [mangleMethod("onPixelCopyFinished", "(I)V")]: finish });
    const cls = rt.link("android/view/PixelCopy").ctor;
    Reflect.apply(Reflect.get(cls, mangleMethod("request", "(Landroid/view/Window;Landroid/graphics/Rect;Landroid/graphics/Bitmap;Landroid/view/PixelCopy$OnPixelCopyFinishedListener;Landroid/os/Handler;)V")), cls, [null, rect, bitmap, listener, null]);
    return { code: await done, pixel: [...bitmap.ctx.getImageData(0, 0, 1, 1).data] };
  };
  frame.fillStyle = "lime"; frame.fillRect(0, 0, 4, 4); present();
  frame.fillStyle = "red"; frame.fillRect(0, 0, 4, 4);
  const before = await copy();
  present();
  return { before, after: await copy() };
}
async function lifecycle() {
  const view = rt.make("android/opengl/GLSurfaceView"), renderer = rt.make("java/lang/Object");
  Object.assign(view, { right: 4, bottom: 4 });
  let drawn = 0;
  Object.assign(renderer, {
    [mangleMethod("onSurfaceCreated", "(Ljavax/microedition/khronos/opengles/GL10;Ljavax/microedition/khronos/egl/EGLConfig;)V")]: () => {},
    [mangleMethod("onSurfaceChanged", "(Ljavax/microedition/khronos/opengles/GL10;II)V")]: () => {},
    [mangleMethod("onDrawFrame", "(Ljavax/microedition/khronos/opengles/GL10;)V")]: () => { drawn++; },
  });
  await vcallMaybe(view, "setRenderer", "(Landroid/opengl/GLSurfaceView$Renderer;)V", renderer);
  await vcallMaybe(view, "setRenderMode", "(I)V", 0);
  const hook = Reflect.get(view, "hook") as () => boolean;
  const unregistered = !uiState.animHooks.has(hook);
  await dispatchAttached(view);
  const registered = uiState.animHooks.has(hook);
  await vcallMaybe(view, "onPause", "()V"); await dispatchDetached(view);
  const released = !uiState.animHooks.has(hook);
  await dispatchAttached(view); hook();
  const paused = drawn === 0 && Reflect.get(view, "paused");
  await vcallMaybe(view, "onResume", "()V"); hook();
  while (Reflect.get(view, "inFlight")) await new Promise(resolve => setTimeout(resolve, 0));
  hook();
  const reattached = uiState.animHooks.has(hook) && drawn === 1 && Reflect.get(view, "renderMode") === 0;
  await dispatchDetached(view);
  return unregistered && registered && released && paused && reattached && !uiState.animHooks.has(hook);
}
Object.defineProperty(window, "eglThreadProbe", { value: probe() });
