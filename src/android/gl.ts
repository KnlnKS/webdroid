// android.opengl.* → WebGL2. GL int handles ↔ WebGL objects via id tables.

import { rt, JObj } from "../jvm/runtime";
import { JBuffer, bufferView } from "../jvm/natives/jnio";
import { JBitmap } from "./graphics";

// ── The active GL context (one GLSurfaceView at a time is typical)
type GL = WebGL2RenderingContext | WebGLRenderingContext;
export let gl: GL | null = null;

// handle tables: index 1.. → object (0 = null/none, matching GL semantics). They belong to the
// context that minted the handles, as EGL objects do: setGL re-selecting a context must keep
// last frame's VBOs and textures, and a context seen for the first time starts empty — the
// "EGL context lost" case renderers already reload from in onSurfaceCreated.
type Tables = {
  programs: (WebGLProgram | null)[]; shaders: (WebGLShader | null)[]; buffers: (WebGLBuffer | null)[];
  textures: (WebGLTexture | null)[]; uniforms: (WebGLUniformLocation | null)[];
};
const freshTables = (): Tables => ({ programs: [null], shaders: [null], buffers: [null], textures: [null], uniforms: [null] });
const tablesOf = new WeakMap<GL, Tables>();
let T: Tables = freshTables();
export function setGL(ctx: GL) {
  if (ctx === gl) return;
  gl = ctx;
  let t = tablesOf.get(ctx);
  if (!t) tablesOf.set(ctx, t = freshTables());
  T = t;
}
function put<O>(tbl: (O | null)[], obj: O | null): number { tbl.push(obj); return tbl.length - 1; }

function bytesFrom(buf: JBuffer | null): Uint8Array | null {
  if (!buf) return null;
  const v = bufferView(buf);
  return new Uint8Array(v.ab, v.byteFromPos);
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

rt.register({
  name: "android/opengl/GLES20", ctor: class extends JObj {},
  statics: {
    GL_DEPTH_BUFFER_BIT: 0x0100, GL_COLOR_BUFFER_BIT: 0x4000, GL_STENCIL_BUFFER_BIT: 0x0400,
    GL_FALSE: 0, GL_TRUE: 1, GL_POINTS: 0, GL_LINES: 1, GL_LINE_LOOP: 2, GL_LINE_STRIP: 3,
    GL_TRIANGLES: 4, GL_TRIANGLE_STRIP: 5, GL_TRIANGLE_FAN: 6,
    GL_ZERO: 0, GL_ONE: 1, GL_SRC_COLOR: 0x0300, GL_ONE_MINUS_SRC_COLOR: 0x0301,
    GL_SRC_ALPHA: 0x0302, GL_ONE_MINUS_SRC_ALPHA: 0x0303, GL_DST_ALPHA: 0x0304, GL_ONE_MINUS_DST_ALPHA: 0x0305,
    GL_DST_COLOR: 0x0306, GL_ONE_MINUS_DST_COLOR: 0x0307, GL_SRC_ALPHA_SATURATE: 0x0308,
    GL_BLEND: 0x0be2, GL_DEPTH_TEST: 0x0b71, GL_CULL_FACE: 0x0b44, GL_DITHER: 0x0bd0, GL_SCISSOR_TEST: 0x0c11,
    GL_TEXTURE_2D: 0x0de1, GL_TEXTURE: 0x1702, GL_TEXTURE0: 0x84c0, GL_TEXTURE1: 0x84c1,
    GL_ARRAY_BUFFER: 0x8892, GL_ELEMENT_ARRAY_BUFFER: 0x8893,
    GL_STATIC_DRAW: 0x88e4, GL_DYNAMIC_DRAW: 0x88e8, GL_STREAM_DRAW: 0x88e0,
    GL_FRAGMENT_SHADER: 0x8b30, GL_VERTEX_SHADER: 0x8b31,
    GL_COMPILE_STATUS: 0x8b81, GL_LINK_STATUS: 0x8b82, GL_INFO_LOG_LENGTH: 0x8b84,
    GL_ACTIVE_UNIFORMS: 0x8b86, GL_ACTIVE_ATTRIBUTES: 0x8b89,
    GL_FLOAT: 0x1406, GL_UNSIGNED_BYTE: 0x1401, GL_UNSIGNED_SHORT: 0x1403, GL_BYTE: 0x1400, GL_SHORT: 0x1402,
    GL_INT: 0x1404, GL_UNSIGNED_INT: 0x1405, GL_FIXED: 0x140c,
    GL_RGBA: 0x1908, GL_RGB: 0x1907, GL_ALPHA: 0x1906, GL_LUMINANCE: 0x1909, GL_LUMINANCE_ALPHA: 0x190a,
    GL_UNSIGNED_SHORT_4_4_4_4: 0x8033, GL_UNSIGNED_SHORT_5_5_5_1: 0x8034, GL_UNSIGNED_SHORT_5_6_5: 0x8363,
    GL_NEAREST: 0x2600, GL_LINEAR: 0x2601, GL_NEAREST_MIPMAP_NEAREST: 0x2700, GL_LINEAR_MIPMAP_LINEAR: 0x2703,
    GL_TEXTURE_MAG_FILTER: 0x2800, GL_TEXTURE_MIN_FILTER: 0x2801, GL_TEXTURE_WRAP_S: 0x2802, GL_TEXTURE_WRAP_T: 0x2803,
    GL_REPEAT: 0x2901, GL_CLAMP_TO_EDGE: 0x812f, GL_MIRRORED_REPEAT: 0x8370,
    GL_UNPACK_ALIGNMENT: 0x0cf5, GL_PACK_ALIGNMENT: 0x0d05,
    GL_MAX_TEXTURE_SIZE: 0x0d33, GL_MAX_VERTEX_ATTRIBS: 0x8869, GL_VIEWPORT: 0x0ba2,
    GL_VENDOR: 0x1f00, GL_RENDERER: 0x1f01, GL_VERSION: 0x1f02, GL_EXTENSIONS: 0x1f03, GL_SHADING_LANGUAGE_VERSION: 0x8b8c,
    GL_NO_ERROR: 0, GL_FRAMEBUFFER: 0x8d40, GL_COLOR_ATTACHMENT0: 0x8ce0,
    GL_FRAMEBUFFER_COMPLETE: 0x8cd5, GL_FRAMEBUFFER_BINDING: 0x8ca6,
  },
  methods: {
    "static glViewport(IIII)V": (x: number, y: number, w: number, h: number) => gl?.viewport(x, y, w, h),
    "static glClearColor(FFFF)V": (r: number, g: number, b: number, a: number) => gl?.clearColor(r, g, b, a),
    "static glClear(I)V": (mask: number) => gl?.clear(mask),
    "static glEnable(I)V": (cap: number) => gl?.enable(cap),
    "static glDisable(I)V": (cap: number) => gl?.disable(cap),
    "static glBlendFunc(II)V": (s: number, d: number) => gl?.blendFunc(s, d),
    "static glActiveTexture(I)V": (t: number) => gl?.activeTexture(t),
    "static glPixelStorei(II)V": (name: number, p: number) => gl?.pixelStorei(name, p),
    "static glCreateProgram()I": () => put(T.programs, gl?.createProgram() ?? null),
    "static glCreateShader(I)I": (type: number) => put(T.shaders, gl?.createShader(type) ?? null),
    "static glShaderSource(ILjava/lang/String;)V": (sh: number, src: string) => gl?.shaderSource(T.shaders[sh]!, src),
    "static glCompileShader(I)V": (sh: number) => gl?.compileShader(T.shaders[sh]!),
    "static glAttachShader(II)V": (p: number, sh: number) => gl?.attachShader(T.programs[p]!, T.shaders[sh]!),
    "static glLinkProgram(I)V": (p: number) => gl?.linkProgram(T.programs[p]!),
    "static glUseProgram(I)V": (p: number) => gl?.useProgram(p ? T.programs[p]! : null),
    // A deleted slot is dropped: WebGL rejects a deleted object where GL would silently mint a
    // fresh one under the same name, so a stale slot would turn the next bind into an error.
    "static glDeleteShader(I)V": (sh: number) => { const o = T.shaders[sh]; if (o) { gl?.deleteShader(o); T.shaders[sh] = null; } },
    "static glDeleteProgram(I)V": (p: number) => { const o = T.programs[p]; if (o) { gl?.deleteProgram(o); T.programs[p] = null; } },
    "static glGetShaderiv(II[II)V": (sh: number, pname: number, out: Int32Array, off: number) => {
      out[off] = glParamToInt(gl?.getShaderParameter(T.shaders[sh]!, pname));
    },
    "static glGetProgramiv(II[II)V": (p: number, pname: number, out: Int32Array, off: number) => {
      out[off] = glParamToInt(gl?.getProgramParameter(T.programs[p]!, pname));
    },
    "static glGetShaderInfoLog(I)Ljava/lang/String;": (sh: number) => gl?.getShaderInfoLog(T.shaders[sh]!) ?? "",
    "static glGetProgramInfoLog(I)Ljava/lang/String;": (p: number) => gl?.getProgramInfoLog(T.programs[p]!) ?? "",
    "static glGetAttribLocation(ILjava/lang/String;)I": (p: number, name: string) => gl?.getAttribLocation(T.programs[p]!, name) ?? -1,
    "static glBindAttribLocation(IILjava/lang/String;)V": (p: number, idx: number, name: string) => gl?.bindAttribLocation(T.programs[p]!, idx, name),
    "static glGetUniformLocation(ILjava/lang/String;)I": (p: number, name: string) => {
      const loc = gl?.getUniformLocation(T.programs[p]!, name) ?? null;
      return loc ? put(T.uniforms, loc) : -1;
    },
    "static glUniform1i(II)V": (loc: number, v: number) => { if (loc >= 0) gl?.uniform1i(T.uniforms[loc]!, v); },
    "static glUniform1f(IF)V": (loc: number, v: number) => { if (loc >= 0) gl?.uniform1f(T.uniforms[loc]!, v); },
    "static glUniform4f(IFFFF)V": (loc: number, a: number, b: number, c: number, d: number) => { if (loc >= 0) gl?.uniform4f(T.uniforms[loc]!, a, b, c, d); },
    "static glUniformMatrix4fv(IIZ[FI)V": (loc: number, count: number, transpose: number, mat: Float32Array, off: number) => {
      if (loc >= 0) gl?.uniformMatrix4fv(T.uniforms[loc]!, !!transpose, mat.subarray(off, off + count * 16));
    },
    "static glUniformMatrix4fv(IIZLjava/nio/FloatBuffer;)V": (loc: number, count: number, transpose: number, buf: JBuffer) => {
      const b = bytesFrom(buf);
      if (loc < 0 || !b) return;
      const n = count * 16;
      // a Float32Array view needs a 4-aligned byteOffset; a sliced buffer position may not be
      const f32 = b.byteOffset & 3 ? new Float32Array(b.slice(0, n * 4).buffer) : new Float32Array(b.buffer, b.byteOffset, n);
      gl?.uniformMatrix4fv(T.uniforms[loc]!, !!transpose, f32);
    },
    "static glGenBuffers(I[II)V": (n: number, out: Int32Array, off: number) => {
      for (let i = 0; i < n; i++) out[off + i] = put(T.buffers, gl?.createBuffer() ?? null);
    },
    "static glGenBuffers(ILjava/nio/IntBuffer;)V": (n: number, buf: JBuffer) => {
      const b = bytesFrom(buf);
      if (b) for (let i = 0; i < n; i++) new Int32Array(b.buffer, b.byteOffset)[i] = put(T.buffers, gl?.createBuffer() ?? null);
    },
    "static glBindBuffer(II)V": (target: number, b: number) => gl?.bindBuffer(target, b ? T.buffers[b]! : null),
    "static glBufferData(IILjava/nio/Buffer;I)V": (target: number, size: number, data: JBuffer | null, usage: number) => {
      const b = bytesFrom(data);
      if (b) gl?.bufferData(target, b.subarray(0, size), usage);
      else gl?.bufferData(target, size, usage);
    },
    "static glBufferSubData(IIILjava/nio/Buffer;)V": (target: number, off: number, size: number, data: JBuffer) => {
      const b = bytesFrom(data);
      if (b) gl?.bufferSubData(target, off, b.subarray(0, size));
    },
    "static glDeleteBuffers(I[II)V": (n: number, arr: Int32Array, off: number) => {
      for (let i = 0; i < n; i++) { const h = arr[off + i], o = T.buffers[h]; if (o) { gl?.deleteBuffer(o); T.buffers[h] = null; } }
    },
    "static glGenTextures(I[II)V": (n: number, out: Int32Array, off: number) => {
      for (let i = 0; i < n; i++) out[off + i] = put(T.textures, gl?.createTexture() ?? null);
    },
    "static glGenTextures(ILjava/nio/IntBuffer;)V": (n: number, buf: JBuffer) => {
      const b = bytesFrom(buf);
      if (b) { const ia = new Int32Array(b.buffer, b.byteOffset); for (let i = 0; i < n; i++) ia[i] = put(T.textures, gl?.createTexture() ?? null); }
    },
    "static glBindTexture(II)V": (target: number, t: number) => gl?.bindTexture(target, t ? T.textures[t]! : null),
    "static glDeleteTextures(I[II)V": (n: number, arr: Int32Array, off: number) => {
      for (let i = 0; i < n; i++) { const h = arr[off + i], o = T.textures[h]; if (o) { gl?.deleteTexture(o); T.textures[h] = null; } }
    },
    "static glTexParameterf(IIF)V": (target: number, pname: number, v: number) => gl?.texParameterf(target, pname, v),
    "static glTexParameteri(III)V": (target: number, pname: number, v: number) => gl?.texParameteri(target, pname, v),
    "static glTexImage2D(IIIIIIIILjava/nio/Buffer;)V": (target: number, level: number, internalFormat: number, w: number, h: number, border: number, format: number, type: number, data: JBuffer | null) => {
      const b = bytesFrom(data);
      gl?.texImage2D(target, level, internalFormat, w, h, border, format, type, b);
    },
    "static glTexSubImage2D(IIIIIIIILjava/nio/Buffer;)V": (target: number, level: number, xo: number, yo: number, w: number, h: number, format: number, type: number, data: JBuffer | null) => {
      const b = bytesFrom(data);
      if (b) gl?.texSubImage2D(target, level, xo, yo, w, h, format, type, b);
    },
    "static glDrawArrays(III)V": (mode: number, first: number, count: number) => gl?.drawArrays(mode, first, count),
    "static glDrawElements(IIILjava/nio/Buffer;)V": (mode: number, count: number, type: number, indices: JBuffer | null) => {
      const b = bytesFrom(indices);
      if (b) {
        // WebGL requires element buffer bound; upload transient buffer
        const eb = gl!.createBuffer();
        gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, eb);
        gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, b.subarray(0, count * (type === 0x1403 ? 2 : 1)), gl!.STREAM_DRAW);
        gl!.drawElements(mode, count, type, 0);
        gl!.deleteBuffer(eb);
      } else gl?.drawElements(mode, count, type, 0);
    },
    "static glEnableVertexAttribArray(I)V": (idx: number) => gl?.enableVertexAttribArray(idx),
    "static glDisableVertexAttribArray(I)V": (idx: number) => gl?.disableVertexAttribArray(idx),
    "static glVertexAttribPointer(IIIZILjava/nio/Buffer;)V":
      (idx: number, size: number, type: number, normalized: number, stride: number, buf: JBuffer | null) => {
        // client-side arrays: upload to a transient buffer (AndEngine mostly uses VBOs → buf null)
        const b = bytesFrom(buf);
        if (b) {
          const vb = gl!.createBuffer();
          gl!.bindBuffer(gl!.ARRAY_BUFFER, vb);
          gl!.bufferData(gl!.ARRAY_BUFFER, b, gl!.STREAM_DRAW);
          gl!.vertexAttribPointer(idx, size, type, !!normalized, stride, 0);
        } else {
          gl?.vertexAttribPointer(idx, size, type, !!normalized, stride, 0);
        }
      },
    "static glVertexAttribPointer(IIIZII)V": (idx: number, size: number, type: number, normalized: number, stride: number, offset: number) => {
      gl?.vertexAttribPointer(idx, size, type, !!normalized, stride, offset);
    },
    "static glGetString(I)Ljava/lang/String;": (name: number) => {
      switch (name) {
        case 0x1f00: return "webdroid"; case 0x1f01: return "webdroid-webgl";
        case 0x1f02: return "OpenGL ES 2.0"; case 0x8b8c: return "OpenGL ES GLSL ES 1.00";
        case 0x1f03: return "";
        default: return "";
      }
    },
    "static glGetIntegerv(I[II)V": (name: number, out: Int32Array, off: number) => {
      const v = gl?.getParameter(name);
      if (typeof v === "number") out[off] = v;
      else if (v && "length" in v) for (let i = 0; i < (v as ArrayLike<number>).length; i++) out[off + i] = (v as ArrayLike<number>)[i];
      else out[off] = name === 0x0d33 ? 4096 : name === 0x8869 ? 16 : 0;
    },
    "static glGetIntegerv(ILjava/nio/IntBuffer;)V": (name: number, buf: JBuffer) => {
      const b = bytesFrom(buf);
      if (b) new Int32Array(b.buffer, b.byteOffset)[0] = name === 0x0d33 ? 4096 : 16;
    },
    "static glGetError()I": () => gl?.getError() ?? 0,
    "static glFinish()V": () => gl?.finish(),
    "static glFlush()V": () => gl?.flush(),
    "static glDepthMask(Z)V": (v: number) => gl?.depthMask(!!v),
    "static glDepthFunc(I)V": (v: number) => gl?.depthFunc(v),
    "static glColorMask(ZZZZ)V": (r: number, g: number, b: number, a: number) => gl?.colorMask(!!r, !!g, !!b, !!a),
    "static glClearDepthf(F)V": (d: number) => gl?.clearDepth(d),
    "static glScissor(IIII)V": (x: number, y: number, w: number, h: number) => gl?.scissor(x, y, w, h),
    "static glGetActiveAttrib(III[II[II[II[BI)V": getActive((p, i) => gl!.getActiveAttrib(p, i)),
    "static glGetActiveUniform(III[II[II[II[BI)V": getActive((p, i) => gl!.getActiveUniform(p, i)),
    "static glLineWidth(F)V": (w: number) => gl?.lineWidth(w),
    "static glCullFace(I)V": (m: number) => gl?.cullFace(m),
    "static glFrontFace(I)V": (m: number) => gl?.frontFace(m),
    "static glGenerateMipmap(I)V": (t: number) => gl?.generateMipmap(t),
  },
});
function glParamToInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return 0;
}

// Bitmap pixels are premultiplied on AOSP and GLUtils uploads them as-is (engines blend with
// ONE, ONE_MINUS_SRC_ALPHA); WebGL would un-premultiply a canvas source unless told otherwise.
const RGBA = 0x1908, UNSIGNED_BYTE = 0x1401;
function uploadBitmap(bmp: JBitmap | null, upload: (g: WebGLRenderingContext, src: TexImageSource) => void) {
  if (!bmp || !gl) return;
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  upload(gl, bmp.canvas as unknown as TexImageSource);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
}
rt.register({
  name: "android/opengl/GLUtils", ctor: class extends JObj {},
  methods: {
    "static texImage2D(IILandroid/graphics/Bitmap;I)V": (target: number, level: number, bmp: JBitmap) =>
      uploadBitmap(bmp, (g, src) => g.texImage2D(target, level, RGBA, RGBA, UNSIGNED_BYTE, src)),
    "static texImage2D(IIILandroid/graphics/Bitmap;I)V": (target: number, level: number, ifmt: number, bmp: JBitmap) =>
      uploadBitmap(bmp, (g, src) => g.texImage2D(target, level, ifmt, ifmt, UNSIGNED_BYTE, src)),
    "static texImage2D(IIILandroid/graphics/Bitmap;II)V": (target: number, level: number, ifmt: number, bmp: JBitmap, type: number) =>
      uploadBitmap(bmp, (g, src) => g.texImage2D(target, level, ifmt, ifmt, type, src)),
    "static texSubImage2D(IIIILandroid/graphics/Bitmap;)V": (target: number, level: number, xo: number, yo: number, bmp: JBitmap) =>
      uploadBitmap(bmp, (g, src) => g.texSubImage2D(target, level, xo, yo, RGBA, UNSIGNED_BYTE, src)),
    "static texSubImage2D(IIIILandroid/graphics/Bitmap;II)V": (target: number, level: number, xo: number, yo: number, bmp: JBitmap, fmt: number, type: number) =>
      uploadBitmap(bmp, (g, src) => g.texSubImage2D(target, level, xo, yo, fmt, type, src)),
    "static getInternalFormat(Landroid/graphics/Bitmap;)I": () => RGBA,
    "static getType(Landroid/graphics/Bitmap;)I": () => UNSIGNED_BYTE,
  },
});

// ── android.opengl.Matrix (column-major 4x4 float math)
rt.register({
  name: "android/opengl/Matrix", ctor: class extends JObj {},
  methods: {
    "static setIdentityM([FI)V": (m: Float32Array, o: number) => {
      for (let i = 0; i < 16; i++) m[o + i] = 0;
      m[o] = m[o + 5] = m[o + 10] = m[o + 15] = 1;
    },
    "static multiplyMM([FI[FI[FI)V": multMM,
    "static multiplyMV([FI[FI[FI)V": (r: Float32Array, ro: number, m: Float32Array, mo: number, v: Float32Array, vo: number) => {
      const t = new Float32Array(4);
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += m[mo + k * 4 + row] * v[vo + k];
        t[row] = s;
      }
      for (let i = 0; i < 4; i++) r[ro + i] = t[i];
    },
    "static orthoM([FIFFFFFF)V": (m: Float32Array, o: number, l: number, r: number, b: number, t: number, n: number, f: number) => {
      for (let i = 0; i < 16; i++) m[o + i] = 0;
      m[o] = 2 / (r - l); m[o + 5] = 2 / (t - b); m[o + 10] = -2 / (f - n);
      m[o + 12] = -(r + l) / (r - l); m[o + 13] = -(t + b) / (t - b); m[o + 14] = -(f + n) / (f - n); m[o + 15] = 1;
    },
    "static frustumM([FIFFFFFF)V": (m: Float32Array, o: number, l: number, r: number, b: number, t: number, n: number, f: number) => {
      for (let i = 0; i < 16; i++) m[o + i] = 0;
      m[o] = 2 * n / (r - l); m[o + 5] = 2 * n / (t - b);
      m[o + 8] = (r + l) / (r - l); m[o + 9] = (t + b) / (t - b); m[o + 10] = -(f + n) / (f - n); m[o + 11] = -1;
      m[o + 14] = -2 * f * n / (f - n);
    },
    "static translateM([FIFFF)V": (m: Float32Array, o: number, x: number, y: number, z: number) => {
      for (let i = 0; i < 4; i++) m[o + 12 + i] += m[o + i] * x + m[o + 4 + i] * y + m[o + 8 + i] * z;
    },
    "static translateM([FI[FIFFF)V": (r: Float32Array, ro: number, m: Float32Array, mo: number, x: number, y: number, z: number) => {
      for (let i = 0; i < 16; i++) r[ro + i] = m[mo + i];
      for (let i = 0; i < 4; i++) r[ro + 12 + i] += m[mo + i] * x + m[mo + 4 + i] * y + m[mo + 8 + i] * z;
    },
    "static scaleM([FIFFF)V": (m: Float32Array, o: number, x: number, y: number, z: number) => {
      for (let i = 0; i < 4; i++) { m[o + i] *= x; m[o + 4 + i] *= y; m[o + 8 + i] *= z; }
    },
    "static scaleM([FI[FIFFF)V": (r: Float32Array, ro: number, m: Float32Array, mo: number, x: number, y: number, z: number) => {
      for (let i = 0; i < 4; i++) { r[ro + i] = m[mo + i] * x; r[ro + 4 + i] = m[mo + 4 + i] * y; r[ro + 8 + i] = m[mo + 8 + i] * z; r[ro + 12 + i] = m[mo + 12 + i]; }
    },
    "static rotateM([FIFFFF)V": (m: Float32Array, o: number, a: number, x: number, y: number, z: number) => {
      const t = new Float32Array(16);
      setRotate(t, a, x, y, z);
      const src = m.slice(o, o + 16);
      multMM(m, o, src, 0, t, 0);
    },
    "static setRotateM([FIFFFF)V": (m: Float32Array, o: number, a: number, x: number, y: number, z: number) => setRotate(m, a, x, y, z, o),
    "static invertM([FI[FI)V": (inv: Float32Array, io: number, m: Float32Array, mo: number) => { invert(inv, io, m, mo); },
    "static transposeM([FI[FI)V": (r: Float32Array, ro: number, m: Float32Array, mo: number) => {
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) r[ro + c * 4 + row] = m[mo + row * 4 + c];
    },
    "static setLookAtM([FIFFFFFFFFF)V": (m: Float32Array, o: number) => {
      for (let i = 0; i < 16; i++) m[o + i] = 0;
      m[o] = m[o + 5] = m[o + 10] = m[o + 15] = 1;
    },
    "static length(FFF)F": (x: number, y: number, z: number) => Math.hypot(x, y, z),
  },
});
// scratch so r may alias a or b; per-entity per-frame path, so no allocation here
const tmp16 = new Float32Array(16);
function multMM(r: Float32Array, ro: number, a: Float32Array, ao: number, b: Float32Array, bo: number) {
  const t = tmp16;
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[ao + k * 4 + row] * b[bo + c * 4 + k];
    t[c * 4 + row] = s;
  }
  for (let i = 0; i < 16; i++) r[ro + i] = t[i];
}
function setRotate(m: Float32Array, deg: number, x: number, y: number, z: number, o = 0) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const len = Math.hypot(x, y, z) || 1;
  x /= len; y /= len; z /= len;
  const nc = 1 - c;
  m[o] = x * x * nc + c; m[o + 1] = y * x * nc + z * s; m[o + 2] = z * x * nc - y * s; m[o + 3] = 0;
  m[o + 4] = x * y * nc - z * s; m[o + 5] = y * y * nc + c; m[o + 6] = z * y * nc + x * s; m[o + 7] = 0;
  m[o + 8] = x * z * nc + y * s; m[o + 9] = y * z * nc - x * s; m[o + 10] = z * z * nc + c; m[o + 11] = 0;
  m[o + 12] = 0; m[o + 13] = 0; m[o + 14] = 0; m[o + 15] = 1;
}
function invert(inv: Float32Array, io: number, src: Float32Array, so: number) {
  const m = src.subarray(so, so + 16);
  const r = new Float32Array(16);
  r[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  r[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  r[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  r[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  let det = m[0] * r[0] + m[1] * r[4] + m[2] * r[8] + m[3] * r[12];
  if (!det) { for (let i = 0; i < 16; i++) inv[io + i] = i % 5 === 0 ? 1 : 0; return; }
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[io + i] = (r[i] || 0) * det; // partial; adequate for 2D ortho use
}

// ── GLSurfaceView + Renderer + EGL infra (see glview.ts)
