// android.opengl.* → WebGL2. GL int handles ↔ WebGL objects via id tables.

import { rt, isWaiting, waits } from "../jvm/runtime.ts";
import { curThread, threadSwitch } from "../jvm/natives/jentry.ts";
import { type JBuffer, readRemainingBytes, readBufferBytes, writeRemainingBytes, checkedRemainingOffset, position, limit, elementShift } from "../jvm/natives/jnio.ts";
import { bitmapOf, ALPHA_8, RGB_565, ARGB_4444, ARGB_8888, RGBA_F16 } from "./bitmap.ts";
import { gles1String } from "../native/gles1.ts";
import { gles3Extensions } from "../native/gles3.ts";
import { activeUniformInfo, externalSamplersAs2D, textureTarget } from "../native/gles3-state.ts";
import { pixelStore, pixelArray } from "../native/gles3-pixels.ts";
import { perf } from "../perf.ts";

// GL dispatch follows the cooperative Java/native thread without a lookup on every GL call.
type GL = WebGL2RenderingContext | WebGLRenderingContext;
export let gl: GL | null = null;

// handle tables: index 1.. → object (0 = null/none, matching GL semantics). They belong to the
// context that minted the handles, as EGL objects do: setGL re-selecting a context must keep
// last frame's VBOs and textures, and a context seen for the first time starts empty — the
// "EGL context lost" case renderers already reload from in onSurfaceCreated.
type Tables = {
  programs: (WebGLProgram | null)[]; shaders: (WebGLShader | null)[]; buffers: (WebGLBuffer | null)[];
  textures: (WebGLTexture | null)[]; uniforms: (WebGLUniformLocation | null)[];
  vaos: (WebGLVertexArrayObject | null)[]; fbos: (WebGLFramebuffer | null)[]; rbos: (WebGLRenderbuffer | null)[];
  samplers: (WebGLSampler | null)[]; queries: (WebGLQuery | null)[]; syncs: (WebGLSync | null)[]; tfs: (WebGLTransformFeedback | null)[];
  ids: WeakMap<object, number>; // object → handle, for the *_BINDING queries
  /** the context's error flags: one raised host-side, reported before WebGL's; `clean` while WebGL
   *  has latched none since it last answered NO_ERROR; `mixed` once a caller outside gles3 (whose
   *  state tracking proves calls error-free) has used it */
  err: number; clean: boolean; mixed: boolean;
};
const freshTables = (): Tables => ({ programs: [null], shaders: [null], buffers: [null], textures: [null], uniforms: [null],
  vaos: [null], fbos: [null], rbos: [null], samplers: [null], queries: [null], syncs: [null], tfs: [null], ids: new WeakMap(), err: 0, clean: false, mixed: false });
const tablesOf = new WeakMap<GL, Tables>();
let T: Tables = freshTables();
export const tables = (): Tables => T;
const threadGL = new WeakMap<object, GL>();
threadSwitch.hook = (thread) => selectGL(threadGL.get(thread) ?? null);
export function setGL(ctx: GL | null, thread: object = curThread) {
  if (ctx) threadGL.set(thread, ctx); else threadGL.delete(thread);
  selectGL(ctx);
}
export function selectGL(ctx: GL | null) {
  if (ctx === gl) return;
  gl = ctx;
  if (!ctx) return;
  let t = tablesOf.get(ctx);
  if (!t) tablesOf.set(ctx, t = freshTables());
  T = t;
}
/**
 * glGetError. WebGL's getError waits for every queued GPU command (after a present, the whole
 * frame), so while the context is clean NO_ERROR is answered here. GL lets OUT_OF_MEMORY surface
 * late, and WebGL keeps its flags latched until asked, so an allocation that gles3 validated as
 * WebGL does reports a real OOM at the next query that reaches WebGL; Chrome usually loses the
 * context instead, which is always asked.
 */
export function takeError(): number {
  const e = T.err;
  if (e) { T.err = 0; return e; }
  if (!gl || (T.clean && !gl.isContextLost())) return 0;
  const w = gl.getError();
  T.clean = w === 0 && !T.mixed;
  return w;
}
/** a call gles3 does not track reached the current context */
export function untracked(): void { T.clean = false; T.mixed = true; }
/** a tracked call WebGL may reject reached it: the next glGetError asks WebGL */
export function unsure(): void { T.clean = false; }
/** an error GL raises that WebGL would not: kept until glGetError, the first one winning as in GL */
export function raise(e: number): void { T.err ||= e; }
/** the Java bindings' natives, each marking the context untracked */
function bindings(table: Record<string, (...a: never[]) => unknown>): Record<string, (...a: never[]) => unknown> {
  return Object.fromEntries(Object.entries(table).map(([sig, fn]) => {
    if (sig === "glGetError()I" || sig === "_nativeClassInit()V") return [sig, fn];
    const bound = (...a: never[]) => { untracked(); return fn(...a); };
    return [sig, isWaiting(fn) ? waits(bound) : bound];
  }));
}
export function put<O extends object>(tbl: (O | null)[], obj: O | null): number {
  tbl.push(obj);
  if (obj) T.ids.set(obj, tbl.length - 1);
  return tbl.length - 1;
}

/** RPC continuations run before Wasm restores the strand's current GL context. */
function afterGL<A,R>(value: A | Promise<A>, use: (value: A) => R): R | Promise<R> {
  if (!(value instanceof Promise)) return use(value);
  const context = gl, table = T;
  return value.then(value => {
    const previous = gl, previousTable = T;
    gl = context; T = table;
    try { return use(value); }
    finally { gl = previous; T = previousTable; }
  });
}
function bytesFrom<R>(buf: JBuffer | null, use: (bytes: Uint8Array<ArrayBuffer> | null) => R, size?: number): R | Promise<R> {
  const remaining = buf ? (limit(buf) - position(buf)) * 2 ** elementShift(buf) : 0;
  const n = size === undefined ? remaining : Math.max(0,Math.min(remaining,size < 0 ? remaining + size : size));
  return afterGL(buf ? readRemainingBytes(buf,n) : null, bytes => use(bytes as Uint8Array<ArrayBuffer> | null));
}

/** glGenX into an int[] or an IntBuffer; glDeleteX drops each slot (see glDeleteShader) */
function genInto<O extends object>(tbl: (O | null)[], make: () => O | null | undefined, n: number, out: Int32Array, off = 0) {
  for (let i = 0; i < n; i++) out[off + i] = put(tbl, make() ?? null);
}
function genIntoBuffer<O extends object>(tbl: (O | null)[], make: () => O | null | undefined, n: number, buf: JBuffer) {
  if (n <= 0) return;
  checkedRemainingOffset(buf,n * 4);
  const out = new Int32Array(n);
  genInto(tbl,make,n,out);
  return writeRemainingBytes(buf,new Uint8Array(out.buffer));
}
function deleteAll<O extends object>(tbl: (O | null)[], del: (o: O) => void, n: number, arr: Int32Array, off: number) {
  for (let i = 0; i < n; i++) { const h = arr[off + i], o = tbl[h]; if (o) { del(o); tbl[h] = null; } }
}

function integerValues(name: number): number | ArrayLike<number> {
  const v = gl?.getParameter(name);
  if (v && typeof v === "object") {
    if ("length" in v) return v as ArrayLike<number>;
    return T.ids.get(v) ?? 0;
  }
  return Number(v ?? 0);
}
function getIntegers(name: number, out: Int32Array, off: number): void {
  const value = integerValues(name);
  if (typeof value === "number") out[off] = value; else out.set(value,off);
}

// glGetActiveAttrib/glGetActiveUniform share everything but the query; name is NUL-terminated
// into a byte[] of bufsize as GLES does.
function getActive(query: (p: WebGLProgram, i: number) => WebGLActiveInfo | null) {
  return (p: number, idx: number, bufsize: number, length: Int32Array, lengthOff: number, size: Int32Array, sizeOff: number,
    type: Int32Array, typeOff: number, name: Int8Array, nameOff: number) => {
    const info = gl && query(T.programs[p]!, idx);
    if (!info) return;
    const n = Math.min(info.name.length, bufsize - 1);
    for (let i = 0; i < n; i++) name[nameOff + i] = info.name.charCodeAt(i);
    name[nameOff + n] = 0;
    length[lengthOff] = n; size[sizeOff] = info.size; type[typeOff] = info.type;
  };
}

// GLES reads a client array when a draw runs: the pointer call keeps the Buffer and its position,
// and each draw streams those bytes into a buffer that attribute reuses. The view is rebuilt per
// draw because a direct buffer's guest memory may grow in between.
interface ClientArray { buf: JBuffer; from: number; length: number }
interface ClientArrays { attribs: Map<number, ClientArray>; buffers: (WebGLBuffer | null)[]; elements: WebGLBuffer | null }
const clientArrays = new WeakMap<GL, ClientArrays>();
function clientArraysOf(g: GL): ClientArrays {
  let client = clientArrays.get(g);
  if (!client) clientArrays.set(g, client = { attribs: new Map(), buffers: [], elements: null });
  return client;
}
function streamClientArrays(g: GL): void | Promise<void> {
  const client = clientArrays.get(g);
  if (!client?.attribs.size) return;
  const attributes = [...client.attribs], reads = attributes.map(([,a]) => readBufferBytes(a.buf,a.from,a.length));
  const upload = (bytes: Uint8Array[]) => {
    const prev = g.getParameter(g.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    try { for (let i = 0; i < attributes.length; i++) {
      g.bindBuffer(g.ARRAY_BUFFER,client.buffers[attributes[i][0]]!);
      g.bufferData(g.ARRAY_BUFFER,bytes[i] as Uint8Array<ArrayBuffer>,g.STREAM_DRAW);
    } } finally { g.bindBuffer(g.ARRAY_BUFFER,prev); }
  };
  // Local guest views may detach if another strand grows memory while an owner read waits.
  return reads.some(bytes => bytes instanceof Promise)
    ? Promise.all(reads.map(bytes => bytes instanceof Promise ? bytes : bytes.slice())).then(upload)
    : upload(reads as Uint8Array[]);
}

rt.registerJnis("android/opengl/GLES10", bindings({
  "_nativeClassInit()V": () => {},
  "glGetString(I)Ljava/lang/String;": (name: number) => gl ? gles1String(gl, name) : null,
}));
rt.registerJnis("android/opengl/GLES20", bindings({
  "_nativeClassInit()V": () => {},
  "glViewport(IIII)V": (x: number, y: number, w: number, h: number) => gl?.viewport(x, y, w, h),
  "glClearColor(FFFF)V": (r: number, g: number, b: number, a: number) => gl?.clearColor(r, g, b, a),
  "glClear(I)V": (mask: number) => gl?.clear(mask),
  "glEnable(I)V": (cap: number) => gl?.enable(cap),
  "glDisable(I)V": (cap: number) => gl?.disable(cap),
  "glBlendFunc(II)V": (s: number, d: number) => gl?.blendFunc(s, d),
  "glBlendFuncSeparate(IIII)V": (sr: number, dr: number, sa: number, da: number) => gl?.blendFuncSeparate(sr, dr, sa, da),
  "glPolygonOffset(FF)V": (factor: number, units: number) => gl?.polygonOffset(factor, units),
  "glActiveTexture(I)V": (t: number) => gl?.activeTexture(t),
  "glPixelStorei(II)V": (name: number, p: number) => { if (gl) pixelStore(gl, name, p); },
  "glCreateProgram()I": () => put(T.programs, gl?.createProgram() ?? null),
  "glCreateShader(I)I": (type: number) => put(T.shaders, gl?.createShader(type) ?? null),
  "glShaderSource(ILjava/lang/String;)V": (sh: number, src: string) => gl?.shaderSource(T.shaders[sh]!, externalSamplersAs2D(T.shaders[sh]!, src)),
  "glCompileShader(I)V": (sh: number) => gl?.compileShader(T.shaders[sh]!),
  "glAttachShader(II)V": (p: number, sh: number) => gl?.attachShader(T.programs[p]!, T.shaders[sh]!),
  "glLinkProgram(I)V": (p: number) => gl?.linkProgram(T.programs[p]!),
  "glUseProgram(I)V": (p: number) => gl?.useProgram(p ? T.programs[p]! : null),
  // A deleted slot is dropped: WebGL rejects a deleted object where GL would silently mint a
  // fresh one under the same name, so a stale slot would turn the next bind into an error.
  "glDeleteShader(I)V": (sh: number) => { const o = T.shaders[sh]; if (o) { gl?.deleteShader(o); T.shaders[sh] = null; } },
  "glDeleteProgram(I)V": (p: number) => { const o = T.programs[p]; if (o) { gl?.deleteProgram(o); T.programs[p] = null; } },
  "glGetShaderiv(II[II)V": (sh: number, pname: number, out: Int32Array, off: number) => {
    out[off] = glParamToInt(gl?.getShaderParameter(T.shaders[sh]!, pname));
  },
  "glGetProgramiv(II[II)V": (p: number, pname: number, out: Int32Array, off: number) => {
    out[off] = glParamToInt(gl?.getProgramParameter(T.programs[p]!, pname));
  },
  "glGetShaderInfoLog(I)Ljava/lang/String;": (sh: number) => gl?.getShaderInfoLog(T.shaders[sh]!) ?? "",
  "glGetProgramInfoLog(I)Ljava/lang/String;": (p: number) => gl?.getProgramInfoLog(T.programs[p]!) ?? "",
  "glGetAttribLocation(ILjava/lang/String;)I": (p: number, name: string) => gl?.getAttribLocation(T.programs[p]!, name) ?? -1,
  "glBindAttribLocation(IILjava/lang/String;)V": (p: number, idx: number, name: string) => gl?.bindAttribLocation(T.programs[p]!, idx, name),
  "glGetUniformLocation(ILjava/lang/String;)I": (p: number, name: string) => {
    const loc = gl?.getUniformLocation(T.programs[p]!, name) ?? null;
    return loc ? put(T.uniforms, loc) : -1;
  },
  "glUniform1i(II)V": (loc: number, v: number) => { if (loc >= 0) gl?.uniform1i(T.uniforms[loc]!, v); },
  "glUniform1f(IF)V": (loc: number, v: number) => { if (loc >= 0) gl?.uniform1f(T.uniforms[loc]!, v); },
  "glUniform2f(IFF)V": (loc: number, x: number, y: number) => { if (loc >= 0) gl?.uniform2f(T.uniforms[loc]!, x, y); },
  "glUniform3f(IFFF)V": (loc: number, x: number, y: number, z: number) => { if (loc >= 0) gl?.uniform3f(T.uniforms[loc]!, x, y, z); },
  "glUniform4f(IFFFF)V": (loc: number, a: number, b: number, c: number, d: number) => { if (loc >= 0) gl?.uniform4f(T.uniforms[loc]!, a, b, c, d); },
  "glUniform2fv(II[FI)V": (loc: number, n: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniform2fv(T.uniforms[loc]!, values.subarray(off, off + n * 2)); },
  "glUniform3fv(II[FI)V": (loc: number, n: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniform3fv(T.uniforms[loc]!, values.subarray(off, off + n * 3)); },
  "glUniform4fv(II[FI)V": (loc: number, n: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniform4fv(T.uniforms[loc]!, values.subarray(off, off + n * 4)); },
  "glUniform2iv(II[II)V": (loc: number, n: number, values: Int32Array, off: number) => { if (loc >= 0) gl?.uniform2iv(T.uniforms[loc]!, values.subarray(off, off + n * 2)); },
  "glUniform4iv(II[II)V": (loc: number, n: number, values: Int32Array, off: number) => { if (loc >= 0) gl?.uniform4iv(T.uniforms[loc]!, values.subarray(off, off + n * 4)); },
  "glUniformMatrix3fv(IIZ[FI)V": (loc: number, n: number, transpose: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniformMatrix3fv(T.uniforms[loc]!, !!transpose, values.subarray(off, off + n * 9)); },
  "glUniformMatrix4fv(IIZ[FI)V": (loc: number, count: number, transpose: number, mat: Float32Array, off: number) => {
    if (loc >= 0) gl?.uniformMatrix4fv(T.uniforms[loc]!, !!transpose, mat.subarray(off, off + count * 16));
  },
  "glUniformMatrix4fv(IIZLjava/nio/FloatBuffer;)V": waits((loc: number, count: number, transpose: number, buf: JBuffer) => bytesFrom(buf,b => {
    if (loc < 0 || !b) return;
    const n = count * 16;
    // a Float32Array view needs a 4-aligned byteOffset; a sliced buffer position may not be
    const f32 = b.byteOffset & 3 ? new Float32Array(b.slice(0, n * 4).buffer) : new Float32Array(b.buffer, b.byteOffset, n);
    gl?.uniformMatrix4fv(T.uniforms[loc]!, !!transpose, f32);
  })),
  "glGenBuffers(I[II)V": (n: number, out: Int32Array, off: number) => genInto(T.buffers, () => gl?.createBuffer(), n, out, off),
  "glGenBuffers(ILjava/nio/IntBuffer;)V": waits((n: number, buf: JBuffer) => genIntoBuffer(T.buffers, () => gl?.createBuffer(), n, buf)),
  "glBindBuffer(II)V": (target: number, b: number) => gl?.bindBuffer(target, b ? T.buffers[b]! : null),
  "glBufferData(IILjava/nio/Buffer;I)V": waits((target: number, size: number, data: JBuffer | null, usage: number) => bytesFrom(data,b => {
    if (b) gl?.bufferData(target, b, usage);
    else gl?.bufferData(target, size, usage);
  },size)),
  "glBufferSubData(IIILjava/nio/Buffer;)V": waits((target: number, off: number, size: number, data: JBuffer) => bytesFrom(data,b => {
    if (b) gl?.bufferSubData(target, off, b);
  },size)),
  "glDeleteBuffers(I[II)V": (n: number, arr: Int32Array, off: number) => deleteAll(T.buffers, (o) => gl?.deleteBuffer(o), n, arr, off),
  "glGenTextures(I[II)V": (n: number, out: Int32Array, off: number) => genInto(T.textures, () => gl?.createTexture(), n, out, off),
  "glGenTextures(ILjava/nio/IntBuffer;)V": waits((n: number, buf: JBuffer) => genIntoBuffer(T.textures, () => gl?.createTexture(), n, buf)),
  "glBindTexture(II)V": (target: number, t: number) => gl?.bindTexture(textureTarget(target), t ? T.textures[t]! : null),
  "glIsTexture(I)Z": (t: number) => (t && gl?.isTexture(T.textures[t] ?? null) ? 1 : 0),
  "glDeleteTextures(I[II)V": (n: number, arr: Int32Array, off: number) => deleteAll(T.textures, (o) => gl?.deleteTexture(o), n, arr, off),
  "glTexParameterf(IIF)V": (target: number, pname: number, v: number) => gl?.texParameterf(textureTarget(target), pname, v),
  "glTexParameteri(III)V": (target: number, pname: number, v: number) => gl?.texParameteri(textureTarget(target), pname, v),
  "glTexImage2D(IIIIIIIILjava/nio/Buffer;)V": waits((target: number, level: number, internalFormat: number, w: number, h: number, border: number, format: number, type: number, data: JBuffer | null) => bytesFrom(data,b => {
    gl?.texImage2D(target, level, internalFormat, w, h, border, format, type, b);
  })),
  "glTexSubImage2D(IIIIIIIILjava/nio/Buffer;)V": waits((target: number, level: number, xo: number, yo: number, w: number, h: number, format: number, type: number, data: JBuffer | null) => bytesFrom(data,b => {
    if (b) gl?.texSubImage2D(target, level, xo, yo, w, h, format, type, b);
  })),
  "glCopyTexSubImage2D(IIIIIIII)V": (target: number, level: number, xo: number, yo: number, x: number, y: number, w: number, h: number) => gl?.copyTexSubImage2D(target, level, xo, yo, x, y, w, h),
  "glGenFramebuffers(I[II)V": (n: number, out: Int32Array, off: number) => genInto(T.fbos, () => gl?.createFramebuffer(), n, out, off),
  "glBindFramebuffer(II)V": (target: number, handle: number) => gl?.bindFramebuffer(target, T.fbos[handle] ?? null),
  "glFramebufferTexture2D(IIIII)V": (target: number, attachment: number, texTarget: number, texture: number, level: number) => gl?.framebufferTexture2D(target, attachment, textureTarget(texTarget), T.textures[texture] ?? null, level),
  "glDeleteFramebuffers(I[II)V": (n: number, arr: Int32Array, off: number) => deleteAll(T.fbos, (o) => gl?.deleteFramebuffer(o), n, arr, off),
  "glReadPixels(IIIIIILjava/nio/Buffer;)V": waits((x: number, y: number, w: number, h: number, format: number, type: number, data: JBuffer) => {
    if (!gl) return;
    return afterGL(readRemainingBytes(data),b => {
      if (!gl) return;
      const C = pixelArray(type), aligned = b.byteOffset % C.BYTES_PER_ELEMENT === 0;
      const pixels = aligned ? new C(b.buffer as ArrayBuffer,b.byteOffset,Math.floor(b.byteLength / C.BYTES_PER_ELEMENT))
        : new C(b.slice().buffer,0,Math.floor(b.byteLength / C.BYTES_PER_ELEMENT));
      gl.readPixels(x,y,w,h,format,type,pixels);
      if (!aligned) b.set(new Uint8Array(pixels.buffer));
    });
  }),
  "glDrawArrays(III)V": waits((mode: number, first: number, count: number) => {
    if (gl) return afterGL(streamClientArrays(gl),() => { gl!.drawArrays(mode,first,count); perf.glDraws++; });
  }),
  "glDrawElements(IIII)V": waits((mode: number, count: number, type: number, offset: number) => {
    if (gl) return afterGL(streamClientArrays(gl),() => { gl!.drawElements(mode,count,type,offset); perf.glDraws++; });
  }),
  "glDrawElements(IIILjava/nio/Buffer;)V": waits((mode: number, count: number, type: number, indices: JBuffer | null) => {
    if (!gl) return;
    return bytesFrom(indices,b => {
      const g = gl!, streaming = streamClientArrays(g);
      if (streaming instanceof Promise) b = b?.slice() ?? null;
      return afterGL(streaming,() => {
        if (b) {
          // WebGL draws indices only from a bound element buffer.
          const prev = g.getParameter(g.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
          try {
            g.bindBuffer(g.ELEMENT_ARRAY_BUFFER,clientArraysOf(g).elements ??= g.createBuffer());
            g.bufferData(g.ELEMENT_ARRAY_BUFFER,b.subarray(0,count * (type === 0x1405 ? 4 : type === 0x1403 ? 2 : 1)),g.STREAM_DRAW);
            g.drawElements(mode,count,type,0);
          } finally { g.bindBuffer(g.ELEMENT_ARRAY_BUFFER,prev); }
        } else g.drawElements(mode,count,type,0);
        perf.glDraws++;
      });
    });
  }),
  "glEnableVertexAttribArray(I)V": (idx: number) => gl?.enableVertexAttribArray(idx),
  "glDisableVertexAttribArray(I)V": (idx: number) => gl?.disableVertexAttribArray(idx),
  "glVertexAttrib4fv(I[FI)V": (idx: number, values: Float32Array, off: number) => gl?.vertexAttrib4fv(idx, values.subarray(off, off + 4)),
  "glVertexAttribPointerBounds(IIIZILjava/nio/Buffer;I)V":
    (idx: number, size: number, type: number, normalized: number, stride: number, buf: JBuffer | null) => {
      if (!gl) return;
      const client = clientArraysOf(gl);
      if (!buf) { client.attribs.delete(idx); gl.vertexAttribPointer(idx, size, type, !!normalized, stride, 0); return; }
      const prev = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
      gl.bindBuffer(gl.ARRAY_BUFFER, client.buffers[idx] ??= gl.createBuffer());
      gl.vertexAttribPointer(idx, size, type, !!normalized, stride, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, prev);
      client.attribs.set(idx, { buf, from: position(buf) * 2 ** elementShift(buf), length: (limit(buf) - position(buf)) * 2 ** elementShift(buf) });
    },
  "glVertexAttribPointer(IIIZII)V": (idx: number, size: number, type: number, normalized: number, stride: number, offset: number) => {
    if (!gl) return;
    clientArrays.get(gl)?.attribs.delete(idx);
    gl.vertexAttribPointer(idx, size, type, !!normalized, stride, offset);
  },
  "glGetString(I)Ljava/lang/String;": (name: number) => {
    switch (name) {
      case 0x1f00: return "webdroid"; case 0x1f01: return "webdroid-webgl";
      case 0x1f02: return "OpenGL ES 2.0"; case 0x8b8c: return "OpenGL ES GLSL ES 1.00";
      case 0x1f03: return gl && "createVertexArray" in gl ? gles3Extensions(gl).join(" ") : "";
      default: return "";
    }
  },
  "glGetIntegerv(I[II)V": getIntegers,
  "glGetIntegerv(ILjava/nio/IntBuffer;)V": waits((name: number, buf: JBuffer) => {
    const value = integerValues(name), out = typeof value === "number" ? Int32Array.of(value) : Int32Array.from(value);
    return writeRemainingBytes(buf,new Uint8Array(out.buffer));
  }),
  "glGetError()I": takeError,
  "glFinish()V": () => gl?.finish(),
  "glFlush()V": () => gl?.flush(),
  "glStencilMask(I)V": (mask: number) => gl?.stencilMask(mask),
  "glStencilMaskSeparate(II)V": (face: number, mask: number) => gl?.stencilMaskSeparate(face, mask),
  "glStencilFunc(III)V": (func: number, ref: number, mask: number) => gl?.stencilFunc(func, ref, mask),
  "glStencilFuncSeparate(IIII)V": (face: number, func: number, ref: number, mask: number) => gl?.stencilFuncSeparate(face, func, ref, mask),
  "glStencilOp(III)V": (fail: number, zfail: number, zpass: number) => gl?.stencilOp(fail, zfail, zpass),
  "glStencilOpSeparate(IIII)V": (face: number, fail: number, zfail: number, zpass: number) => gl?.stencilOpSeparate(face, fail, zfail, zpass),
  "glClearStencil(I)V": (value: number) => gl?.clearStencil(value),
  "glDepthMask(Z)V": (v: number) => gl?.depthMask(!!v),
  "glDepthFunc(I)V": (v: number) => gl?.depthFunc(v),
  "glColorMask(ZZZZ)V": (r: number, g: number, b: number, a: number) => gl?.colorMask(!!r, !!g, !!b, !!a),
  "glClearDepthf(F)V": (d: number) => gl?.clearDepth(d),
  "glScissor(IIII)V": (x: number, y: number, w: number, h: number) => gl?.scissor(x, y, w, h),
  "glGetActiveAttrib(III[II[II[II[BI)V": getActive((p, i) => gl!.getActiveAttrib(p, i)),
  "glGetActiveUniform(III[II[II[II[BI)V": getActive((p, i) => activeUniformInfo(gl!, p, gl!.getActiveUniform(p, i))),
  "glLineWidth(F)V": (w: number) => gl?.lineWidth(w),
  "glCullFace(I)V": (m: number) => gl?.cullFace(m),
  "glFrontFace(I)V": (m: number) => gl?.frontFace(m),
  "glGenerateMipmap(I)V": (t: number) => gl?.generateMipmap(t),
}));
function glParamToInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return 0;
}

// android_opengl_GLUtils.cpp. Bitmap pixels are premultiplied on AOSP and uploaded as-is (engines
// blend with ONE, ONE_MINUS_SRC_ALPHA); WebGL would un-premultiply a canvas source unless told otherwise.
const ALPHA = 0x1906, RGB = 0x1907, RGBA = 0x1908, RGBA16F = 0x881a, UNSIGNED_BYTE = 0x1401, HALF_FLOAT = 0x140b;
/** per Bitmap.Config: the GL internal format and type its pixels upload as */
const FORMATS: Record<number, [number, number]> = { [ALPHA_8]: [ALPHA, UNSIGNED_BYTE], [RGB_565]: [RGB, 0x8363],
  [ARGB_4444]: [RGBA, 0x8033], [ARGB_8888]: [RGBA, UNSIGNED_BYTE], [RGBA_F16]: [RGBA16F, HALF_FLOAT] };
const formatOf = (bmp: object, i: 0 | 1) => FORMATS[bitmapOf(bmp).config]?.[i] ?? -1;
const pixelFormat = (internal: number) => internal === RGBA16F ? RGBA : internal;
function upload(bmp: object, internal: number, type: number, call: (g: WebGLRenderingContext, src: TexImageSource) => void): number {
  if (internal < 0 || type < 0) return -1;
  if (!gl) return 0;
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  call(gl, bitmapOf(bmp).image as TexImageSource);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  return 0;
}
rt.registerJnis("android/opengl/GLUtils", bindings({
  "native_getInternalFormat(Landroid/graphics/Bitmap;)I": (bmp: object) => formatOf(bmp, 0),
  "native_getType(Landroid/graphics/Bitmap;)I": (bmp: object) => formatOf(bmp, 1),
  "native_texImage2D(IIILandroid/graphics/Bitmap;II)I": (target: number, level: number, internal: number, bmp: object, type: number) => {
    if (internal < 0) internal = formatOf(bmp, 0);
    if (type < 0) type = formatOf(bmp, 1);
    return upload(bmp, internal, type, (g, src) => g.texImage2D(target, level, internal, pixelFormat(internal), type, src));
  },
  "native_texSubImage2D(IIIILandroid/graphics/Bitmap;II)I": (target: number, level: number, x: number, y: number, bmp: object, format: number, type: number) => {
    if (format < 0) format = pixelFormat(formatOf(bmp, 0));
    return upload(bmp, format, type, (g, src) => g.texSubImage2D(target, level, x, y, format, type, src));
  },
}));

/** a 4x4 column-major inverse into inv; 0 when singular */
export function invert(inv: Float32Array, io: number, src: Float32Array, so: number) {
  const a = src[so], b = src[so + 1], c = src[so + 2], d = src[so + 3],
    e = src[so + 4], f = src[so + 5], g = src[so + 6], h = src[so + 7],
    i = src[so + 8], j = src[so + 9], k = src[so + 10], l = src[so + 11],
    m = src[so + 12], n = src[so + 13], o = src[so + 14], p = src[so + 15];
  const ab = a * f - b * e, ac = a * g - c * e, ad = a * h - d * e,
    bc = b * g - c * f, bd = b * h - d * f, cd = c * h - d * g,
    ij = i * n - j * m, ik = i * o - k * m, il = i * p - l * m,
    jk = j * o - k * n, jl = j * p - l * n, kl = k * p - l * o;
  const det = ab * kl - ac * jl + ad * jk + bc * il - bd * ik + cd * ij;
  if (det === 0) return 0;
  const r = 1 / det;
  inv[io] = (f * kl - g * jl + h * jk) * r;
  inv[io + 1] = (-b * kl + c * jl - d * jk) * r;
  inv[io + 2] = (n * cd - o * bd + p * bc) * r;
  inv[io + 3] = (-j * cd + k * bd - l * bc) * r;
  inv[io + 4] = (-e * kl + g * il - h * ik) * r;
  inv[io + 5] = (a * kl - c * il + d * ik) * r;
  inv[io + 6] = (-m * cd + o * ad - p * ac) * r;
  inv[io + 7] = (i * cd - k * ad + l * ac) * r;
  inv[io + 8] = (e * jl - f * il + h * ij) * r;
  inv[io + 9] = (-a * jl + b * il - d * ij) * r;
  inv[io + 10] = (m * bd - n * ad + p * ab) * r;
  inv[io + 11] = (-i * bd + j * ad - l * ab) * r;
  inv[io + 12] = (-e * jk + f * ik - g * ij) * r;
  inv[io + 13] = (a * jk - b * ik + c * ij) * r;
  inv[io + 14] = (-m * bc + n * ac - o * ab) * r;
  inv[io + 15] = (i * bc - j * ac + k * ab) * r;
  return 1;
}

// GraphicsEnvironment's natives: the GL here is the browser's WebGL, with no updatable driver,
// ANGLE, or Vulkan/GLES layers to load, and a release build that is not debuggable
rt.registerJnis("android/os/GraphicsEnvironment", {
  "isDebuggable()Z": () => 0,
  "setInjectLayersPrSetDumpable()Z": () => 0,
  ...Object.fromEntries(["hintActivityLaunch()V", "nativeSetAngleInfo(Ljava/lang/String;ZLjava/lang/String;[Ljava/lang/String;)V",
    "nativeToggleAngleAsSystemDriver(Z)V", "setDebugLayers(Ljava/lang/String;)V", "setDebugLayersGLES(Ljava/lang/String;)V",
    "setDriverPathAndSphalLibraries(Ljava/lang/String;Ljava/lang/String;)V", "setGpuStats(Ljava/lang/String;Ljava/lang/String;JJLjava/lang/String;I)V",
    "setLayerPaths(Ljava/lang/ClassLoader;Ljava/lang/String;)V"].map((sig) => [sig, () => {}])),
});
