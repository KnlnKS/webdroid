import { dispatchAttached, dispatchDetached, uiState } from "../../src/android/view";
import "../../src/natives";
import { rt } from "../../src/jvm/runtime";
import { mangleStaticField, mangleMethod } from "../../src/jvm/abi";
import { JThread, setCurThread, mainThread, curThread, vcallMaybe, vcallOn } from "../../src/jvm/natives/jlang";
import { gl, tables } from "../../src/android/gl";
import { glSurfaces } from "../../src/native/egl-current";
import { EglContext } from "../../src/android/glview";
import { mem } from "../../src/native/mem";
import { Cpu, setA64 } from "../../src/native/cpu";
import { jitStats, JIT_HEAT } from "../../src/native/core";
import { RET_SENTINEL } from "../../src/native/abi";
import { gles1Init } from "../../src/native/gles1";
import { gles3Init } from "../../src/native/gles3";
import { hostFn, type ArgReader } from "../../src/native/host";

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
  const read = (lib: string, values: number[]) => {
    let i = 0;
    const next = () => values[i++] ?? 0;
    const args: ArgReader = { i: next, p: next, u: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
      f: next, d: next, vd: next, str: () => "", strAt: () => "" };
    const fn = hostFn(lib, "glReadPixels");
    if (!fn) throw new Error("Missing native glReadPixels");
    fn(cpu, args);
  };
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
  read("libGLESv2.so", [0, 0, 1, 2, g.RGBA, g.UNSIGNED_BYTE, at - 20]);
  const after = [execute(at), execute(at + 16)], error = g.getError();
  g.pixelStorei(g.PACK_ROW_LENGTH, 0); g.pixelStorei(g.PACK_SKIP_ROWS, 0); g.pixelStorei(g.PACK_SKIP_PIXELS, 0);
  g.pixelStorei(g.PACK_ALIGNMENT, 8);
  init(base); init(base + 8);
  for (let i = 0; i <= JIT_HEAT; i++) { execute(base); execute(base + 8); }
  read("libGLESv1_CM.so", [0, 0, 1, 2, g.RGBA, g.UNSIGNED_BYTE, base]);
  const es1 = [execute(base), execute(base + 8)], es1Error = g.getError();
  const texture = g.createTexture(); g.bindTexture(g.TEXTURE_2D, texture);
  g.texStorage2D(g.TEXTURE_2D, 1, g.R32UI, 1, 1);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
  g.clearBufferuiv(g.COLOR, 0, Uint32Array.of(0x12345678, 0, 0, 0));
  read("libGLESv2.so", [0, 0, 1, 1, g.RED_INTEGER, g.UNSIGNED_INT, base + 33]);
  const unaligned = mem.ld32(base + 33), integerError = g.getError();
  g.deleteFramebuffer(fbo); g.deleteTexture(texture); g.deleteTexture(rgba); context.makeCurrent(null);
  return { compiled, before, after, error, es1, es1Error, unaligned, integerError };
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
    lifecycle: await lifecycle(), readback: readback() };
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
