// android.opengl.* → WebGL2. GL int handles ↔ WebGL objects via id tables.

import { rt, isWaiting, noEffect, waits } from "../jvm/runtime.ts";
import { curThread } from "../jvm/natives/jentry.ts";
import { gl, tables, put, takeError, untracked, activate, type GL } from "../native/gl-context.ts";
import { type JBuffer, readRemainingBytes, readBufferBytes, writeRemainingBytes, checkedRemainingOffset, position, limit, elementShift } from "../jvm/natives/jnio.ts";
import { bitmapOf, ALPHA_8, RGB_565, ARGB_4444, ARGB_8888, RGBA_F16 } from "./bitmap.ts";
import { gles1String } from "../native/gles1.ts";
import { gles3Extensions } from "../native/gles3.ts";
import { activeUniformInfo, externalSamplersAs2D, textureTarget } from "../native/gles3-state.ts";
import { pixelStore, pixelArray } from "../native/gles3-pixels.ts";
import { perf } from "../perf.ts";

/** the Java bindings' natives, each acting in its caller's context and marking it untracked */
function bindings(table: Record<string, (...a: never[]) => unknown>): Record<string, (...a: never[]) => unknown> {
  return Object.fromEntries(Object.entries(table).map(([sig, fn]) => {
    if (sig === "_nativeClassInit()V") return [sig, fn];
    const bound = sig === "glGetError()I" ? (...a: never[]) => { activate(curThread); return fn(...a); }
      : (...a: never[]) => { activate(curThread); untracked(); return fn(...a); };
    return [sig, isWaiting(fn) ? waits(bound) : bound];
  }));
}

/** an RPC continuation acts in the context of the thread that waited for it */
function afterGL<A,R>(value: A | Promise<A>, use: (value: A) => R): R | Promise<R> {
  if (!(value instanceof Promise)) return use(value);
  const thread = curThread;
  return value.then(value => { activate(thread); return use(value); });
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
    return tables().ids.get(v) ?? 0;
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
    const info = gl && query(tables().programs[p]!, idx);
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
  "glCreateProgram()I": () => put(tables().programs, gl?.createProgram() ?? null),
  "glCreateShader(I)I": (type: number) => put(tables().shaders, gl?.createShader(type) ?? null),
  "glShaderSource(ILjava/lang/String;)V": (sh: number, src: string) => gl?.shaderSource(tables().shaders[sh]!, externalSamplersAs2D(tables().shaders[sh]!, src)),
  "glCompileShader(I)V": (sh: number) => gl?.compileShader(tables().shaders[sh]!),
  "glAttachShader(II)V": (p: number, sh: number) => gl?.attachShader(tables().programs[p]!, tables().shaders[sh]!),
  "glLinkProgram(I)V": (p: number) => gl?.linkProgram(tables().programs[p]!),
  "glUseProgram(I)V": (p: number) => gl?.useProgram(p ? tables().programs[p]! : null),
  // A deleted slot is dropped: WebGL rejects a deleted object where GL would silently mint a
  // fresh one under the same name, so a stale slot would turn the next bind into an error.
  "glDeleteShader(I)V": (sh: number) => { const o = tables().shaders[sh]; if (o) { gl?.deleteShader(o); tables().shaders[sh] = null; } },
  "glDeleteProgram(I)V": (p: number) => { const o = tables().programs[p]; if (o) { gl?.deleteProgram(o); tables().programs[p] = null; } },
  "glGetShaderiv(II[II)V": (sh: number, pname: number, out: Int32Array, off: number) => {
    out[off] = glParamToInt(gl?.getShaderParameter(tables().shaders[sh]!, pname));
  },
  "glGetProgramiv(II[II)V": (p: number, pname: number, out: Int32Array, off: number) => {
    out[off] = glParamToInt(gl?.getProgramParameter(tables().programs[p]!, pname));
  },
  "glGetShaderInfoLog(I)Ljava/lang/String;": (sh: number) => gl?.getShaderInfoLog(tables().shaders[sh]!) ?? "",
  "glGetProgramInfoLog(I)Ljava/lang/String;": (p: number) => gl?.getProgramInfoLog(tables().programs[p]!) ?? "",
  "glGetAttribLocation(ILjava/lang/String;)I": (p: number, name: string) => gl?.getAttribLocation(tables().programs[p]!, name) ?? -1,
  "glBindAttribLocation(IILjava/lang/String;)V": (p: number, idx: number, name: string) => gl?.bindAttribLocation(tables().programs[p]!, idx, name),
  "glGetUniformLocation(ILjava/lang/String;)I": (p: number, name: string) => {
    const loc = gl?.getUniformLocation(tables().programs[p]!, name) ?? null;
    return loc ? put(tables().uniforms, loc) : -1;
  },
  "glUniform1i(II)V": (loc: number, v: number) => { if (loc >= 0) gl?.uniform1i(tables().uniforms[loc]!, v); },
  "glUniform1f(IF)V": (loc: number, v: number) => { if (loc >= 0) gl?.uniform1f(tables().uniforms[loc]!, v); },
  "glUniform2f(IFF)V": (loc: number, x: number, y: number) => { if (loc >= 0) gl?.uniform2f(tables().uniforms[loc]!, x, y); },
  "glUniform3f(IFFF)V": (loc: number, x: number, y: number, z: number) => { if (loc >= 0) gl?.uniform3f(tables().uniforms[loc]!, x, y, z); },
  "glUniform4f(IFFFF)V": (loc: number, a: number, b: number, c: number, d: number) => { if (loc >= 0) gl?.uniform4f(tables().uniforms[loc]!, a, b, c, d); },
  "glUniform2fv(II[FI)V": (loc: number, n: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniform2fv(tables().uniforms[loc]!, values.subarray(off, off + n * 2)); },
  "glUniform3fv(II[FI)V": (loc: number, n: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniform3fv(tables().uniforms[loc]!, values.subarray(off, off + n * 3)); },
  "glUniform4fv(II[FI)V": (loc: number, n: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniform4fv(tables().uniforms[loc]!, values.subarray(off, off + n * 4)); },
  "glUniform2iv(II[II)V": (loc: number, n: number, values: Int32Array, off: number) => { if (loc >= 0) gl?.uniform2iv(tables().uniforms[loc]!, values.subarray(off, off + n * 2)); },
  "glUniform4iv(II[II)V": (loc: number, n: number, values: Int32Array, off: number) => { if (loc >= 0) gl?.uniform4iv(tables().uniforms[loc]!, values.subarray(off, off + n * 4)); },
  "glUniformMatrix3fv(IIZ[FI)V": (loc: number, n: number, transpose: number, values: Float32Array, off: number) => { if (loc >= 0) gl?.uniformMatrix3fv(tables().uniforms[loc]!, !!transpose, values.subarray(off, off + n * 9)); },
  "glUniformMatrix4fv(IIZ[FI)V": (loc: number, count: number, transpose: number, mat: Float32Array, off: number) => {
    if (loc >= 0) gl?.uniformMatrix4fv(tables().uniforms[loc]!, !!transpose, mat.subarray(off, off + count * 16));
  },
  "glUniformMatrix4fv(IIZLjava/nio/FloatBuffer;)V": waits((loc: number, count: number, transpose: number, buf: JBuffer) => bytesFrom(buf,b => {
    if (loc < 0 || !b) return;
    const n = count * 16;
    // a Float32Array view needs a 4-aligned byteOffset; a sliced buffer position may not be
    const f32 = b.byteOffset & 3 ? new Float32Array(b.slice(0, n * 4).buffer) : new Float32Array(b.buffer, b.byteOffset, n);
    gl?.uniformMatrix4fv(tables().uniforms[loc]!, !!transpose, f32);
  })),
  "glGenBuffers(I[II)V": (n: number, out: Int32Array, off: number) => genInto(tables().buffers, () => gl?.createBuffer(), n, out, off),
  "glGenBuffers(ILjava/nio/IntBuffer;)V": waits((n: number, buf: JBuffer) => genIntoBuffer(tables().buffers, () => gl?.createBuffer(), n, buf)),
  "glBindBuffer(II)V": (target: number, b: number) => gl?.bindBuffer(target, b ? tables().buffers[b]! : null),
  "glBufferData(IILjava/nio/Buffer;I)V": waits((target: number, size: number, data: JBuffer | null, usage: number) => bytesFrom(data,b => {
    if (b) gl?.bufferData(target, b, usage);
    else gl?.bufferData(target, size, usage);
  },size)),
  "glBufferSubData(IIILjava/nio/Buffer;)V": waits((target: number, off: number, size: number, data: JBuffer) => bytesFrom(data,b => {
    if (b) gl?.bufferSubData(target, off, b);
  },size)),
  "glDeleteBuffers(I[II)V": (n: number, arr: Int32Array, off: number) => deleteAll(tables().buffers, (o) => gl?.deleteBuffer(o), n, arr, off),
  "glGenTextures(I[II)V": (n: number, out: Int32Array, off: number) => genInto(tables().textures, () => gl?.createTexture(), n, out, off),
  "glGenTextures(ILjava/nio/IntBuffer;)V": waits((n: number, buf: JBuffer) => genIntoBuffer(tables().textures, () => gl?.createTexture(), n, buf)),
  "glBindTexture(II)V": (target: number, t: number) => gl?.bindTexture(textureTarget(target), t ? tables().textures[t]! : null),
  "glIsTexture(I)Z": (t: number) => (t && gl?.isTexture(tables().textures[t] ?? null) ? 1 : 0),
  "glDeleteTextures(I[II)V": (n: number, arr: Int32Array, off: number) => deleteAll(tables().textures, (o) => gl?.deleteTexture(o), n, arr, off),
  "glTexParameterf(IIF)V": (target: number, pname: number, v: number) => gl?.texParameterf(textureTarget(target), pname, v),
  "glTexParameteri(III)V": (target: number, pname: number, v: number) => gl?.texParameteri(textureTarget(target), pname, v),
  "glTexImage2D(IIIIIIIILjava/nio/Buffer;)V": waits((target: number, level: number, internalFormat: number, w: number, h: number, border: number, format: number, type: number, data: JBuffer | null) => bytesFrom(data,b => {
    gl?.texImage2D(target, level, internalFormat, w, h, border, format, type, b);
  })),
  "glTexSubImage2D(IIIIIIIILjava/nio/Buffer;)V": waits((target: number, level: number, xo: number, yo: number, w: number, h: number, format: number, type: number, data: JBuffer | null) => bytesFrom(data,b => {
    if (b) gl?.texSubImage2D(target, level, xo, yo, w, h, format, type, b);
  })),
  "glCopyTexSubImage2D(IIIIIIII)V": (target: number, level: number, xo: number, yo: number, x: number, y: number, w: number, h: number) => gl?.copyTexSubImage2D(target, level, xo, yo, x, y, w, h),
  "glGenFramebuffers(I[II)V": (n: number, out: Int32Array, off: number) => genInto(tables().fbos, () => gl?.createFramebuffer(), n, out, off),
  "glBindFramebuffer(II)V": (target: number, handle: number) => gl?.bindFramebuffer(target, tables().fbos[handle] ?? null),
  "glFramebufferTexture2D(IIIII)V": (target: number, attachment: number, texTarget: number, texture: number, level: number) => gl?.framebufferTexture2D(target, attachment, textureTarget(texTarget), tables().textures[texture] ?? null, level),
  "glDeleteFramebuffers(I[II)V": (n: number, arr: Int32Array, off: number) => deleteAll(tables().fbos, (o) => gl?.deleteFramebuffer(o), n, arr, off),
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
