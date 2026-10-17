import "../../../src/natives.ts";
import { rt } from "../../../src/jvm/runtime.ts";
import { JThread, setCurThread, mainThread, vcall, vcallOn, newObj, linkInit, scall, classNameOf } from "../../../src/jvm/natives/jentry.ts";
import { gl, tables, put } from "../../../src/android/gl.ts";
import { glSurfaces } from "../../../src/native/egl-current.ts";
import { EglContext, presentSurface, surfaceTextureOf, type GlSurface } from "../../../src/android/glsurface.ts";
import { mem } from "../../../src/native/mem.ts";
import { Cpu, setA64 } from "../../../src/native/cpu.ts";
import { jitStats, JIT_HEAT } from "../../../src/native/core.ts";
import { RET_SENTINEL } from "../../../src/native/abi.ts";
import { gles1Init } from "../../../src/native/gles1.ts";
import { gles3Init } from "../../../src/native/gles3.ts";
import { pixelStore } from "../../../src/native/gles3-pixels.ts";
import { nativeWindowFor, ndkInit } from "../../../src/native/libandroid.ts";
import { hostFn, type ArgReader } from "../../../src/native/host.ts";
import { allocateDirectNow, bufferBytes, directReady, nativeOrder } from "../../../src/jvm/natives/jnio.ts";
import { bootPlatform, listener } from "./boot.ts";
import { startMainLooper } from "../../../src/android/mainloop.ts";

function callGl(cpu: Cpu, lib: string, name: string, values: number[]) {
  let i = 0;
  const next = () => values[i++] ?? 0;
  const args: ArgReader = { i: next, p: next, u: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
    f: next, d: next, str: () => "", strAt: () => "" };
  const fn = hostFn(lib, name);
  if (!fn) throw new Error(`Missing native ${name}`);
  return fn(cpu, args);
}

function readback() {
  setA64(false); gles1Init(); gles3Init();
  const context = new EglContext();
  context.makeCurrent({ width: 4, height: 4, present: null, frames: 0 });
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
  pixelStore(g, g.PACK_ROW_LENGTH, 4); pixelStore(g, g.PACK_SKIP_ROWS, 1); pixelStore(g, g.PACK_SKIP_PIXELS, 1);
  callGl(cpu, "libGLESv2.so", "glReadPixels", [0, 0, 1, 2, g.RGBA, g.UNSIGNED_BYTE, at - 20]);
  const after = [execute(at), execute(at + 16)], error = g.getError();
  pixelStore(g, g.PACK_ROW_LENGTH, 0); pixelStore(g, g.PACK_SKIP_ROWS, 0); pixelStore(g, g.PACK_SKIP_PIXELS, 0);
  pixelStore(g, g.PACK_ALIGNMENT, 8);
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
  context.makeCurrent({ width: 4, height: 4, present: null, frames: 0 });
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
  pixelStore(g, g.UNPACK_ROW_LENGTH, 3); pixelStore(g, g.UNPACK_IMAGE_HEIGHT, 4);
  pixelStore(g, g.UNPACK_SKIP_IMAGES, 1); pixelStore(g, g.UNPACK_SKIP_ROWS, 1); pixelStore(g, g.UNPACK_SKIP_PIXELS, 1);
  callGl(cpu, "libGLESv2.so", "glTexSubImage3D", [g.TEXTURE_3D, 0, 0, 0, 0, 2, 2, 2, g.RGBA, g.UNSIGNED_BYTE, p]);
  const error3D = g.getError();
  g.deleteTexture(two); g.deleteTexture(three); context.makeCurrent(null);
  return { lengths, error2D, error3D };
}

/** Java GLES20 client arrays: read at the draw, one reused buffer per attribute and for indices, bindings kept */
async function clientArrays() {
  const context = new EglContext();
  context.makeCurrent({ width: 1, height: 1, present: null, frames: 0 });
  const g = context.gl!, program = g.createProgram()!;
  for (const [type, src] of [[g.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}"], [g.FRAGMENT_SHADER, "void main(){gl_FragColor=vec4(1,0,0,1);}"]] as const) {
    const shader = g.createShader(type)!; g.shaderSource(shader, src); g.compileShader(shader); g.attachShader(program, shader);
  }
  g.bindAttribLocation(program, 0, "p"); g.linkProgram(program); g.useProgram(program);
  let created = 0;
  const create = g.createBuffer.bind(g);
  g.createBuffer = () => { created++; return create(); };
  const call = (name: string, desc: string, ...args: unknown[]) => scall("android/opengl/GLES20", name, desc, ...args);
  const vertices = nativeOrder(allocateDirectNow(24)), indices = nativeOrder(allocateDirectNow(12));
  const f32 = (b: typeof vertices) => { const bytes = bufferBytes(b); return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2); };
  new Uint32Array(f32(indices).buffer, f32(indices).byteOffset, 3).set([0, 1, 2]);
  await call("glEnableVertexAttribArray", "(I)V", 0);
  const pixels: number[][] = [];
  for (let i = 0; i < 2; i++) {
    await call("glVertexAttribPointer", "(IIIZILjava/nio/Buffer;)V", 0, 2, g.FLOAT, 0, 0, vertices);
    f32(vertices).set([-1, -1, 3, -1, -1, 3]);
    g.clear(g.COLOR_BUFFER_BIT);
    await call("glDrawElements", "(IIILjava/nio/Buffer;)V", g.TRIANGLES, 3, g.UNSIGNED_INT, indices);
    const pixel = new Uint8Array(4); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, pixel); pixels.push([...pixel]);
  }
  const result = { pixels, created, error: g.getError(), unbound: g.getParameter(g.ARRAY_BUFFER_BINDING) === null && g.getParameter(g.ELEMENT_ARRAY_BUFFER_BINDING) === null };
  context.makeCurrent(null);
  return result;
}

/** native GLES 3: a copy-target write restores the element binding of the vertex array bound now */
function bufferBindings() {
  gles3Init();
  const context = new EglContext();
  context.makeCurrent({ width: 1, height: 1, present: null, frames: 0 });
  const g = context.gl!, cpu = new Cpu(mainThread, "buffer-bindings"), p = mem.malloc(16);
  const gl = (name: string, ...values: number[]) => callGl(cpu, "libGLESv2.so", name, values);
  gl("glGenVertexArrays", 1, p); gl("glGenBuffers", 2, p + 4);
  const [vao, inVao, outside] = [mem.ld32(p), mem.ld32(p + 4), mem.ld32(p + 8)];
  gl("glBindVertexArray", vao); gl("glBindBuffer", g.ELEMENT_ARRAY_BUFFER, inVao); gl("glBufferData", g.ELEMENT_ARRAY_BUFFER, 4, 0, g.STATIC_DRAW);
  gl("glBindVertexArray", 0); gl("glBindBuffer", g.ELEMENT_ARRAY_BUFFER, outside); gl("glBufferData", g.ELEMENT_ARRAY_BUFFER, 4, 0, g.STATIC_DRAW);
  gl("glBindBuffer", 0x8f37, inVao); gl("glBufferSubData", 0x8f37, 0, 4, p);
  const bound = () => tables().ids.get(g.getParameter(g.ELEMENT_ARRAY_BUFFER_BINDING)) ?? 0;
  const outsideKept = bound() === outside;
  gl("glBindVertexArray", vao);
  const result = { outsideKept, inVaoKept: bound() === inVao, error: g.getError() };
  mem.free(p); context.makeCurrent(null);
  return result;
}

/** native GLES 3 client arrays: interleaved vertices drawn from `first`, client and buffer indices, the app's view kept */
function nativeClientArrays() {
  gles3Init();
  const context = new EglContext();
  context.makeCurrent({ width: 1, height: 1, present: null, frames: 0 });
  const g = context.gl!, cpu = new Cpu(mainThread, "client-arrays"), p = mem.malloc(256);
  const gl = (name: string, ...values: number[]) => callGl(cpu, "libGLESv2.so", name, values);
  const program = g.createProgram()!;
  for (const [type, src] of [[g.VERTEX_SHADER, "attribute vec2 p;attribute vec4 c;varying vec4 v;void main(){v=c;gl_Position=vec4(p,0,1);}"], [g.FRAGMENT_SHADER, "precision mediump float;varying vec4 v;void main(){gl_FragColor=v;}"]] as const) {
    const shader = g.createShader(type)!; g.shaderSource(shader, src); g.compileShader(shader); g.attachShader(program, shader);
  }
  g.bindAttribLocation(program, 0, "p"); g.bindAttribLocation(program, 1, "c"); g.linkProgram(program); g.useProgram(program);
  // three covering triangles of { float x, y; u8 r, g, b, a }: red, green, blue
  const vertices = p + 4, stride = 12;
  [[255, 0, 0], [0, 255, 0], [0, 0, 255]].forEach((rgb, t) => [[-1, -1], [3, -1], [-1, 3]].forEach(([x, y], v) => {
    const at = vertices + (t * 3 + v) * stride;
    mem.stf32(at, x); mem.stf32(at + 4, y); mem.write(at + 8, Uint8Array.of(...rgb, 255));
  }));
  const indices = p + 128, out = p + 160;
  mem.write(indices, new Uint8Array(Uint16Array.of(3, 4, 5, 0, 1, 2).buffer));
  gl("glGenBuffers", 2, out);
  const [vbo, ebo] = [mem.ld32(out), mem.ld32(out + 4)];
  gl("glEnableVertexAttribArray", 0); gl("glEnableVertexAttribArray", 1);
  gl("glVertexAttribPointer", 0, 2, g.FLOAT, 0, stride, vertices);
  gl("glVertexAttribPointer", 1, 4, g.UNSIGNED_BYTE, 1, stride, vertices + 8);
  gl("glBindBuffer", g.ARRAY_BUFFER, vbo);
  const pixel = () => { const px = new Uint8Array(4); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); return [...px]; };
  const pixels: number[][] = [];
  gl("glDrawArrays", g.TRIANGLES, 6, 3); pixels.push(pixel());
  gl("glDrawElements", g.TRIANGLES, 3, g.UNSIGNED_SHORT, indices); pixels.push(pixel());
  gl("glBindBuffer", g.ELEMENT_ARRAY_BUFFER, ebo); gl("glBufferData", g.ELEMENT_ARRAY_BUFFER, 6, indices + 6, g.STATIC_DRAW);
  gl("glDrawElements", g.TRIANGLES, 3, g.UNSIGNED_SHORT, 0); pixels.push(pixel());
  const drawError = gl("glGetError");
  gl("glGetIntegerv", g.ARRAY_BUFFER_BINDING, out); gl("glGetIntegerv", g.ELEMENT_ARRAY_BUFFER_BINDING, out + 4);
  gl("glGetVertexAttribiv", 1, g.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, out + 8); gl("glGetVertexAttribPointerv", 1, g.VERTEX_ATTRIB_ARRAY_POINTER, out + 12);
  const kept = mem.ld32(out) === vbo && mem.ld32(out + 4) === ebo && mem.ld32(out + 8) === 0 && mem.ld32(out + 12) === vertices + 8;
  gl("glGenVertexArrays", 1, out); gl("glBindVertexArray", mem.ld32(out));
  gl("glBindBuffer", g.ARRAY_BUFFER, 0); gl("glVertexAttribPointer", 0, 2, g.FLOAT, 0, stride, vertices);
  const result = { pixels, drawError, kept, vaoError: gl("glGetError") };
  mem.free(p); context.makeCurrent(null);
  return result;
}

/** native GLES 3: a SurfaceTexture's GL_TEXTURE_EXTERNAL_OES target reaches the TEXTURE_2D storage it fills */
function externalTexture() {
  gles3Init();
  const context = new EglContext();
  context.makeCurrent({ width: 1, height: 1, present: null, frames: 0 });
  const g = context.gl!, cpu = new Cpu(mainThread, "external-texture"), p = mem.malloc(16);
  const gl = (name: string, ...values: number[]) => callGl(cpu, "libGLESv2.so", name, values);
  const EXTERNAL = 0x8d65;
  gl("glGenTextures", 1, p); gl("glGenFramebuffers", 1, p + 4);
  const texture = mem.ld32(p);
  gl("glBindTexture", EXTERNAL, texture); gl("glTexParameteri", EXTERNAL, g.TEXTURE_MIN_FILTER, g.LINEAR);
  gl("glBindFramebuffer", g.READ_FRAMEBUFFER, mem.ld32(p + 4));
  gl("glFramebufferTexture2D", g.READ_FRAMEBUFFER, g.COLOR_ATTACHMENT0, EXTERNAL, texture, 0);
  gl("glGetIntegerv", 0x8d67, p + 8);
  const result = { bound: mem.ld32(p + 8) === texture, error: gl("glGetError") };
  mem.free(p); context.makeCurrent(null);
  return result;
}

async function probe() {
  await bootPlatform();
  await startMainLooper();
  await directReady();
  const e10 = rt.make("javax/microedition/khronos/egl/EGL10");
  const c14 = await linkInit("android/opengl/EGL14");
  const call14 = (name: string, desc: string, ...args: unknown[]) => scall("android/opengl/EGL14", name, desc, ...args);
  const E10 = "Ljavax/microedition/khronos/egl/", E14 = "Landroid/opengl/";
  const display10 = await vcall(e10, "eglGetDisplay", "(Ljava/lang/Object;)" + E10 + "EGLDisplay;", null);
  const context10 = await vcall(e10, "eglCreateContext", `(${E10}EGLDisplay;${E10}EGLConfig;${E10}EGLContext;[I)${E10}EGLContext;`, display10, null, null, Int32Array.of(0x3098, 2, 0x3038));
  const surface10 = await vcall(e10, "eglCreatePbufferSurface", `(${E10}EGLDisplay;${E10}EGLConfig;[I)${E10}EGLSurface;`, display10, null, Int32Array.of(0x3057, 4, 0x3056, 4, 0x3038));
  const first = new JThread(), second = new JThread();
  setCurThread(first);
  const bound10 = await vcall(e10, "eglMakeCurrent", `(${E10}EGLDisplay;${E10}EGLSurface;${E10}EGLSurface;${E10}EGLContext;)Z`, display10, surface10, surface10, context10);
  const interval10 = await vcall(rt.make("javax/microedition/khronos/egl/EGL11"), "eglSwapInterval", `(${E10}EGLDisplay;I)Z`, display10, 1);
  const firstGL = gl, firstTables = tables();
  gl?.clearColor(1, 0, 0, 1);
  const suspended = vcall(e10, "eglSwapBuffers", `(${E10}EGLDisplay;${E10}EGLSurface;)Z`, display10, surface10);
  rt.st(second.root);
  const emptySecond = gl === null && glSurfaces.current === null;
  const display14 = await call14("eglGetDisplay", "(I)" + E14 + "EGLDisplay;", 0);
  const configs: unknown[] = [null];
  await call14("eglChooseConfig", `(${E14}EGLDisplay;[II[${E14}EGLConfig;II[II)Z`, display14, null, 0, configs, 0, 1, new Int32Array(1), 0);
  const no14 = c14.static("EGL_NO_CONTEXT");
  if (!no14) throw new Error("EGL14 has no EGL_NO_CONTEXT handle");
  const context14 = await call14("eglCreateContext", `(${E14}EGLDisplay;${E14}EGLConfig;${E14}EGLContext;[II)${E14}EGLContext;`, display14, configs[0], no14, Int32Array.of(0x3098, 2, 0x3038), 0);
  const surface14 = await call14("eglCreatePbufferSurface", `(${E14}EGLDisplay;${E14}EGLConfig;[II)${E14}EGLSurface;`, display14, configs[0], Int32Array.of(0x3057, 2, 0x3056, 2, 0x3038), 0);
  const bound14 = await call14("eglMakeCurrent", `(${E14}EGLDisplay;${E14}EGLSurface;${E14}EGLSurface;${E14}EGLContext;)Z`, display14, surface14, surface14, context14);
  const isolated = gl !== firstGL && tables() !== firstTables;
  await call14("eglGetDisplay", "(I)" + E14 + "EGLDisplay;", 99);
  rt.st(first.root);
  const firstError = await vcall(e10, "eglGetError", "()I");
  const restored = gl === firstGL && tables() === firstTables;
  const sameContext10 = await vcall(e10, "eglGetCurrentContext", "()" + E10 + "EGLContext;") === context10;
  rt.st(second.root);
  const secondError = await call14("eglGetError", "()I");
  // a Java EGLContext names its native context by handle, a new object per call as JNI makes them
  const sameContext14 = await vcall(await call14("eglGetCurrentContext", "()" + E14 + "EGLContext;"), "equals", "(Ljava/lang/Object;)Z", context14) === 1;
  await call14("eglReleaseThread", "()Z");
  await suspended;
  rt.st(first.root);
  const restoredAfterRelease = gl === firstGL;
  gl?.clear(gl.COLOR_BUFFER_BIT);
  const swapped = await vcall(e10, "eglSwapBuffers", `(${E10}EGLDisplay;${E10}EGLSurface;)Z`, display10, surface10);
  rt.st(first.root);
  const canvas = new OffscreenCanvas(4, 4), ctx = canvas.getContext("2d")!;
  ctx.drawImage(glSurfaces.current!.target!.present!, 0, 0);
  const pixel = [...ctx.getImageData(1, 1, 1, 1).data];
  rt.su();
  const mainEmpty = gl === null;
  let callbackRestored = false;
  await vcallOn(first, listener("java/lang/Runnable", "run", "()V", () => { callbackRestored = gl === firstGL; }), "run", "()V");
  setCurThread(mainThread);
  return { bound10, interval10, bound14, emptySecond, isolated, restored, sameContext10, sameContext14,
    firstError, secondError, restoredAfterRelease, swapped, pixel, mainEmpty, callbackRestored, mainStillEmpty: gl === null,
    nativeWindow: await nativeWindow(), readback: readback(), uploads: uploadExtents(),
    clientArrays: await clientArrays(), bufferBindings: bufferBindings(), nativeClientArrays: nativeClientArrays(), externalTexture: externalTexture(), surfaceTexture: await surfaceTexture() };
}
async function nativeWindow() {
  ndkInit();
  const surface: GlSurface = { width: 2, height: 1, present: null, frames: 0 };
  const handle = nativeWindowFor(surface), out = mem.malloc(64);
  const cpu = new Cpu(mainThread, "window-buffer");
  const invoke = (name: string, values: number[]) => {
    let i = 0; const next = () => values[i++] ?? 0;
    const args: ArgReader = { i: next, u: next, p: next, va: () => BigInt(next()), l: () => BigInt(next()), ul: () => BigInt(next()),
      f: next, d: next, str: () => "", strAt: () => "" };
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
  const reset = await invoke("ANativeWindow_getFormat", [fresh]) === 1;
  await invoke("ANativeWindow_release", [fresh]);
  surface.present?.close(); mem.free(out);
  return { locked, dimensions, duplicate, posted, pixels, yv12, released, sameHandle, reset, frames: surface.frames };
}
/** SurfaceTexture in GL contexts, against StProbe on the reference AVD: a latch fills the texture and
 *  takes GLConsumer's flipped matrix, another context cannot update it, a detach deletes the texture
 *  and an attach binds the current image to a new one */
async function surfaceTexture() {
  const a = new EglContext(), b = new EglContext(), pbuffer = (): GlSurface => ({ width: 1, height: 1, present: null, frames: 0 });
  const texel = (name: number) => {
    const g = gl!, fbo = g.createFramebuffer(), px = new Uint8Array(4);
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tables().textures[name], 0);
    g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    g.bindFramebuffer(g.FRAMEBUFFER, null); g.deleteFramebuffer(fbo);
    return [...px];
  };
  const thrown = async (f: () => unknown) => { try { await f(); return "ok"; } catch (e) { return classNameOf(e); } };
  a.makeCurrent(pbuffer());
  const name = put(tables().textures, gl!.createTexture());
  const st = await newObj("android/graphics/SurfaceTexture", "(I)V", name), matrix = new Float32Array(16);
  const red = new OffscreenCanvas(1, 1), g2 = red.getContext("2d")!;
  g2.fillStyle = "red"; g2.fillRect(0, 0, 1, 1);
  presentSurface(surfaceTextureOf(st)!.surface, red.transferToImageBitmap());
  await vcall(st, "updateTexImage", "()V");
  await vcall(st, "getTransformMatrix", "([F)V", matrix);
  const latched = { matrix: [...matrix], stamped: await vcall(st, "getTimestamp", "()J") > 0n, texel: texel(name) };
  b.makeCurrent(pbuffer());
  const otherContext = await thrown(() => vcall(st, "updateTexImage", "()V"));
  a.makeCurrent(pbuffer());
  await vcall(st, "detachFromGLContext", "()V");
  const deleted = tables().textures[name] === null;
  b.makeCurrent(pbuffer());
  const moved = put(tables().textures, gl!.createTexture());
  await vcall(st, "attachToGLContext", "(I)V", moved);
  const attached = texel(moved);
  await vcall(st, "release", "()V");
  const released = [await vcall(st, "isReleased", "()Z"), await thrown(() => vcall(st, "updateTexImage", "()V"))];
  b.makeCurrent(null);
  return { latched, otherContext, deleted, attached, released };
}
export default probe;
