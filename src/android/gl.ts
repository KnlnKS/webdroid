// android.opengl's GLES10…GLES32 and their Ext classes, and GLImpl, as AOSP's glgen JNI makes them:
// each native hands its Java arguments to the libGLES entry point of its name, which the calling
// thread's current context dispatches (egl.ts glProc). An array is its elements from the offset, a
// Buffer its memory from the position (a heap buffer's remaining bytes, copied into guest memory and
// back after a query), a String[] a char*[] of its elements.

import { rt, noEffect, javaValues } from "../jvm/runtime.ts";
import { curThread, newObj } from "../jvm/natives/jentry.ts";
import { parseMethodDesc, utf8 } from "../jvm/abi.ts";
import { addressOf, bufferBytes, elementShift, isExternal, limit, position, type JBuffer } from "../jvm/natives/jnio.ts";
import { guestAddress, physical } from "../jvm/natives/jmemory.ts";
import { mem } from "../native/mem.ts";
import { PTR, stp, type ArgReader, type HostFn } from "../native/host.ts";
import type { Cpu } from "../native/cpu.ts";
import { glProc } from "../native/egl.ts";
import { gl, activate } from "../native/gl-context.ts";
import { texImageSource, texSubImageSource } from "../native/gles3.ts";
import { bitmapOf, ALPHA_8, RGB_565, ARGB_4444, ARGB_8888, RGBA_F16 } from "./bitmap.ts";

/** the entry point's arguments, read as a guest argument cursor reads them */
class Args implements ArgReader {
  v: unknown[] = [];
  k = 0;
  i(): number { const v = this.v[this.k++]; return typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : (v as number) | 0; }
  u(): number { return this.i() >>> 0; }
  p(): number { return this.i() >>> 0; }
  l(): bigint { const v = this.v[this.k++]; return typeof v === "bigint" ? v : BigInt(v as number); }
  ul(): bigint { return BigInt.asUintN(64, this.l()); }
  f(): number { return this.v[this.k++] as number; }
  d(): number { return this.v[this.k++] as number; }
  str(): string { return this.v[this.k++] as string; }
  va(): bigint { return BigInt(this.p()); }
  strAt(p: number): string { return mem.cstr(p); }
}
const R = new Args();
let pinned: object | null = null;
/** what an entry point reads of its CPU: the thread whose current context it acts in, set at each call (a getter would cost more than
 *  most entry points take) */
const CPU = { jthread: null as object | null, w: new Int32Array(8) } as unknown as Cpu;
const TH = (): object => pinned ?? curThread;
function call(P: HostFn, ...a: unknown[]): unknown {
  const v = R.v;
  for (let i = 0; i < a.length; i++) v[i] = a[i];
  R.k = 0;
  CPU.jthread = TH() as Cpu["jthread"];
  return P(CPU, R);
}

// Arguments in guest memory: a reused arena, and an allocation of its own for a larger one.
const ARENA = 1 << 16;
let arena = 0, top = 0;
const large: number[] = [], heaps: [bytes: Uint8Array, at: number, n: number, p: number][] = [];
function reset(): void {
  top = 0;
  if (large.length) { for (const p of large) mem.free(p); large.length = 0; }
  if (heaps.length) heaps.length = 0;
}
function alloc(n: number): number {
  arena ||= mem.malloc(ARENA);
  const at = (top + 7) & ~7;
  if (at + n <= ARENA) { top = at + n; return arena + at; }
  const p = mem.malloc(n);
  large.push(p);
  return p;
}
const iae = (msg: string) => rt.mkThrowable("java/lang/IllegalArgumentException", msg);
type Prim = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;
function arrayIn(a: Prim | null, off: number): number {
  if (a === null) throw iae("array == null");
  if (off < 0) throw iae("offset < 0");
  const n = Math.max(0, a.length - off), size = a.BYTES_PER_ELEMENT, p = alloc(n * size);
  if (size === 4 && n <= 64) {
    const to = a instanceof Float32Array ? mem.f32 : mem.i32, at = p >>> 2;
    for (let i = 0; i < n; i++) to[at + i] = a[off + i] as number;
  } else mem.u8.set(new Uint8Array(a.buffer, a.byteOffset + off * size, n * size), p);
  return p;
}
function arrayBack(a: Prim, off: number, p: number): void {
  const n = a.length - off, size = a.BYTES_PER_ELEMENT;
  if (n <= 0) return;
  if (size === 4 && n <= 64) {
    const from = a instanceof Float32Array ? mem.f32 : mem.i32, at = p >>> 2;
    for (let i = 0; i < n; i++) a[off + i] = from[at + i];
  } else new Uint8Array(a.buffer, a.byteOffset + off * size, n * size).set(mem.u8.subarray(p, p + n * size));
}
function strings(a: (string | null)[] | null): number {
  if (a === null) throw iae("array == null");
  const pp = alloc(a.length * PTR);
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    if (s === null) throw iae("null element");
    const bytes = utf8.enc.encode(s), p = alloc(bytes.length + 1);
    mem.u8.set(bytes, p); mem.u8[p + bytes.length] = 0;
    stp(pp + i * PTR, p);
  }
  return pp;
}
/** a direct buffer's memory from byte `at`; an external mapping's once it is in guest memory */
function direct(address: bigint, at: number): number | Promise<unknown> {
  if (address <= 0xffffffffn) return Number(address) + at;
  if (!isExternal(address)) return physical(address) + at;
  const g = guestAddress(address);
  return g instanceof Promise ? g : (typeof g === "number" ? g : mem.txVa(g)) + at;
}
function bufferIn(b: JBuffer | null, back: boolean, nullable: boolean): number | Promise<unknown> {
  if (b === null) { if (nullable) return 0; throw iae("Buffer == null"); }
  const shift = elementShift(b), at = position(b) << shift, address = addressOf(b);
  if (address) return direct(address, at);
  const bytes = bufferBytes(b), n = (limit(b) << shift) - at, p = alloc(n);
  mem.u8.set(bytes.subarray(at, at + n), p);
  if (back) heaps.push([bytes, at, n, p]);
  return p;
}
/** getDirectBufferPointer: what a Bounds native takes */
function directIn(b: JBuffer | null): number | Promise<unknown> {
  if (b === null) return 0;
  const address = addressOf(b);
  if (!address) throw iae("Must use a native order direct Buffer");
  return direct(address, position(b) << elementShift(b));
}
function heapBack(): void { for (const [bytes, at, n, p] of heaps) bytes.set(mem.u8.subarray(p, p + n), at); }
/** the call again once an external mapping is in guest memory, as the thread that made it */
function later(wait: Promise<unknown>, again: () => unknown): Promise<unknown> {
  const thread = TH();
  return wait.then(() => { const before = pinned; pinned = thread; try { return again(); } finally { pinned = before; } });
}
const notResident = () => rt.mkThrowable("java/lang/UnsupportedOperationException", "a file mapping beside arrays, not yet in memory");
const cstr = (p: unknown): string | null => (p ? mem.cstr(p as number) : null);

// ── natives whose entry point takes what Java does not pass
type Special = (P: HostFn, ...a: never[]) => unknown;
/** an integer an entry point answers through its last argument */
function ask(entry: string, ...a: number[]): number {
  const out = alloc(4);
  mem.st32(out, 0);
  call(glProc(entry)!, ...a, out);
  return mem.ld32(out);
}
/** a string an entry point writes as (bufsize, *length, ..., *buf), `size` bytes long with its NUL */
function text(P: HostFn, size: number, lead: number[], rest: number[] = []): string {
  if (size <= 0) return "";
  const buf = alloc(size);
  mem.st8(buf, 0);
  call(P, ...lead, size, 0, ...rest, buf);
  return mem.cstr(buf);
}
const S = "Ljava/lang/String;";
const SPECIAL: Record<string, Special> = {
  [`glGetShaderInfoLog:${S}`]: (P, h: number) => text(P, ask("glGetShaderiv", h, 0x8b84), [h]),
  [`glGetProgramInfoLog:${S}`]: (P, h: number) => text(P, ask("glGetProgramiv", h, 0x8b84), [h]),
  [`glGetShaderSource:${S}`]: (P, h: number) => text(P, ask("glGetShaderiv", h, 0x8b88), [h]),
  [`glGetActiveAttrib:${S}`]: (P, p: number, i: number, size: number, type: number) => text(P, ask("glGetProgramiv", p, 0x8b8a), [p, i], [size, type]),
  [`glGetActiveUniform:${S}`]: (P, p: number, i: number, size: number, type: number) => text(P, ask("glGetProgramiv", p, 0x8b87), [p, i], [size, type]),
  [`glGetTransformFeedbackVarying:${S}`]: (P, p: number, i: number, size: number, type: number) => text(P, ask("glGetProgramiv", p, 0x8c76), [p, i], [size, type]),
  [`glGetActiveUniformBlockName:${S}`]: (P, p: number, i: number) => text(P, ask("glGetActiveUniformBlockiv", p, i, 0x8a41), [p, i]),
  "glShaderSource:V": (P, h: number, src: string) => {
    const bytes = utf8.enc.encode(src), p = alloc(bytes.length + 1), pp = alloc(PTR);
    mem.u8.set(bytes, p); mem.u8[p + bytes.length] = 0;
    stp(pp, p);
    return call(P, h, 1, pp, 0);
  },
  "glMapBufferRange:Ljava/nio/Buffer;": (P, t: number, off: number, n: number, access: number) => {
    const p = call(P, t, off, n, access) as number;
    return p ? newObj("java/nio/DirectByteBuffer", "(JI)V", BigInt(mem.va(p)), n) : null;
  },
};
// the bufsize this overload passes is its Buffer's remaining(), which the adapter does not keep
const SKIP = new Set(["glGetActiveUniformBlockName(IILjava/nio/Buffer;Ljava/nio/Buffer;)V"]);

const BUFFER = /^Ljava\/nio\/[A-Za-z]*Buffer;$/, SCALARS = "ZBCSIJFD";
/** glgen's nullAllowed Buffers */
const NULLABLE = /^gl(BufferData|TexImage[23]D)$/;
const HELPERS = { R, CPU, TH, reset, arrayIn, arrayBack, strings, bufferIn, directIn, heapBack, later, notResident, iae, cstr };
type Native = (...a: never[]) => unknown;
const makers = new Map<string, (...h: unknown[]) => Native>();
/** one function per shape, as the Wasm tier's native wrappers are: the Java arguments in, the entry point called, queried memory back */
function adapter(P: HostFn, name: string, params: string[], ret: string, special: Special | undefined): Native | null {
  const bounds = name.endsWith("Bounds"), back = /^gl(Gen|Get|Read|Query)/.test(name);
  const names: string[] = [], pre: string[] = [], args: string[] = [], buffers: string[] = [], post: string[] = [];
  let arena = !!special, arrays = false;
  for (let i = 0; i < params.length; i++) {
    const d = params[i], a = "a" + i;
    names.push(a);
    if (bounds && i === params.length - 1) continue;                            // Java's remaining(), which the entry point does not take
    if (d.length === 2 && d[0] === "[" && SCALARS.includes(d[1]) && params[i + 1] === "I") {
      const o = "a" + ++i;
      names.push(o);
      arena = arrays = true;
      pre.push(`const p${i}=arrayIn(${a},${o});`);
      if (back) post.push(`arrayBack(${a},${o},p${i});`);
      args.push(`p${i}`);
    } else if (d === "[Ljava/lang/String;") {
      arena = true;
      pre.push(`const p${i}=strings(${a});`);
      args.push(`${a}.length`, `p${i}`);
    } else if (BUFFER.test(d)) {
      arena ||= !bounds;
      pre.push(`const p${i}=${bounds ? `directIn(${a})` : `bufferIn(${a},${back},${NULLABLE.test(name)})`};`);
      buffers.push(`p${i}`);
      args.push(`p${i}`);
    } else if (d === S) {
      pre.push(`if(${a}===null)throw iae("String == null");`);
      args.push(a);
    } else if (d.length === 1 && SCALARS.includes(d)) args.push(a);
    else return null;
  }
  for (const b of buffers) pre.push(`if(typeof ${b}!=="number")${arrays ? "throw notResident()" : `return later(${b},()=>f(${names.join(",")}))`};`);
  const invoke = special ? `S(P,${args.join(",")})` : `(${args.map((x, j) => `v[${j}]=${x},`).join("")}R.k=0,CPU.jthread=TH(),P(CPU,R))`;
  if (back && buffers.length && !bounds) post.push("heapBack();");
  const result = ret === "J" ? `typeof r==="bigint"?r:BigInt(r??0)` : ret === S && !special ? "cstr(r)" : "r";
  const body = `"use strict";return function f(${names.join(",")}){${arena ? "reset();" : ""}${pre.join("")}const v=R.v;const r=${invoke};${post.join("")}return ${result}}`;
  let make = makers.get(body);
  if (!make) makers.set(body, make = new Function(...Object.keys(HELPERS), "P", "S", body) as (...h: unknown[]) => Native);
  const fn = make(...Object.values(HELPERS), P, special);
  // primitives in and out: the Wasm tier passes them as they are, with no bridge scope
  return params.every((d) => d.length === 1) && ret.length === 1 ? javaValues(fn) : fn;
}
function resolve(sig: string): Native | null {
  const open = sig.indexOf("("), name = sig.slice(0, open);
  if (name === "_nativeClassInit") return javaValues(() => {});
  const P = glProc(name.replace(/^_/, "").replace(/Bounds$/, ""));
  const { params, ret } = parseMethodDesc(sig.slice(open));
  // glgen's Buffer overloads that take the name buffer as a byte cannot pass it, on a device either
  if (!P || SKIP.has(sig) || params.at(-1) === "B" && params.some((d) => BUFFER.test(d))) return null;
  const special = SPECIAL[`${name}:${ret}`];
  if (!special && ret.length !== 1 && ret !== S) return null;
  return adapter(P, name, params, ret, special);
}
for (const cls of ["GLES10", "GLES10Ext", "GLES11", "GLES11Ext", "GLES20", "GLES30", "GLES31", "GLES31Ext", "GLES32"]) rt.registerJniFamily("android/opengl/" + cls, resolve);
rt.registerJniFamily("com/google/android/gles_jni/GLImpl", resolve);

// android_opengl_GLUtils.cpp. Bitmap pixels are premultiplied on AOSP and uploaded as-is (engines
// blend with ONE, ONE_MINUS_SRC_ALPHA); WebGL would un-premultiply a canvas source unless told otherwise.
const ALPHA = 0x1906, RGB = 0x1907, RGBA = 0x1908, RGBA16F = 0x881a, UNSIGNED_BYTE = 0x1401, HALF_FLOAT = 0x140b;
/** per Bitmap.Config: the GL internal format and type its pixels upload as */
const FORMATS: Record<number, [number, number]> = { [ALPHA_8]: [ALPHA, UNSIGNED_BYTE], [RGB_565]: [RGB, 0x8363],
  [ARGB_4444]: [RGBA, 0x8033], [ARGB_8888]: [RGBA, UNSIGNED_BYTE], [RGBA_F16]: [RGBA16F, HALF_FLOAT] };
const formatOf = (bmp: object, i: 0 | 1) => FORMATS[bitmapOf(bmp).config]?.[i] ?? -1;
const pixelFormat = (internal: number) => internal === RGBA16F ? RGBA : internal;
function upload(bmp: object, internal: number, type: number, put: (src: TexImageSource) => void): number {
  if (internal < 0 || type < 0) return -1;
  activate(curThread);
  if (!gl) return 0;
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  put(bitmapOf(bmp).image as TexImageSource);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  return 0;
}
rt.registerJnis("android/opengl/GLUtils", {
  "native_getInternalFormat(Landroid/graphics/Bitmap;)I": (bmp: object) => formatOf(bmp, 0),
  "native_getType(Landroid/graphics/Bitmap;)I": (bmp: object) => formatOf(bmp, 1),
  "native_texImage2D(IIILandroid/graphics/Bitmap;II)I": (target: number, level: number, internal: number, bmp: object, type: number) => {
    if (internal < 0) internal = formatOf(bmp, 0);
    if (type < 0) type = formatOf(bmp, 1);
    return upload(bmp, internal, type, (src) => texImageSource(target, level, internal, pixelFormat(internal), type, src));
  },
  "native_texSubImage2D(IIIILandroid/graphics/Bitmap;II)I": (target: number, level: number, x: number, y: number, bmp: object, format: number, type: number) => {
    if (format < 0) format = pixelFormat(formatOf(bmp, 0));
    return upload(bmp, format, type, (src) => texSubImageSource(target, level, x, y, format, type, src));
  },
});

// GraphicsEnvironment's natives: the GL here is the browser's WebGL, with no updatable driver,
// ANGLE, or Vulkan/GLES layers to load, and a release build that is not debuggable
rt.registerJnis("android/os/GraphicsEnvironment", {
  "isDebuggable()Z": () => 0,
  "setInjectLayersPrSetDumpable()Z": () => 0,
  ...noEffect("hintActivityLaunch()V", "nativeSetAngleInfo(Ljava/lang/String;ZLjava/lang/String;[Ljava/lang/String;)V",
    "nativeToggleAngleAsSystemDriver(Z)V", "setDebugLayers(Ljava/lang/String;)V", "setDebugLayersGLES(Ljava/lang/String;)V",
    "setDriverPathAndSphalLibraries(Ljava/lang/String;Ljava/lang/String;)V", "setGpuStats(Ljava/lang/String;Ljava/lang/String;JJLjava/lang/String;I)V",
    "setLayerPaths(Ljava/lang/ClassLoader;Ljava/lang/String;)V"),
});
