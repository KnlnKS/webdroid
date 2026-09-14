import "../../src/natives";
import { rt } from "../../src/jvm/runtime";
import { mangleStaticField, mangleMethod } from "../../src/jvm/abi";
import { JThread, setCurThread, mainThread, curThread, vcallMaybe, vcallOn } from "../../src/jvm/natives/jlang";
import { gl, tables } from "../../src/android/gl";
import { glSurfaces } from "../../src/android/glview";

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
    firstError, secondError, restoredAfterRelease, swapped, pixel, mainEmpty, callbackRestored, mainStillEmpty: gl === null };
}
Object.defineProperty(window, "eglThreadProbe", { value: probe() });
