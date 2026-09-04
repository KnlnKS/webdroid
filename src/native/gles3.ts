// OpenGL ES 3.0 over WebGL2, registered as libGLESv2.so and libGLESv3.so. Closed: a name outside
// ES 3.0 core (KHR_debug, the ES 3.1 entry points) is NULL from dlsym and eglGetProcAddress, so
// an engine feature-gates as on a device. Handles are gl.ts's per-context tables, shared with the
// Java GLES20 bindings. Pointer arguments are guest memory, or offsets while a pixel or element
// buffer is bound, as in GL.

import { mem } from "./mem";
import { hostLib, cstr, PTR, ldp, stp, calledMissing, type HostFn, type ArgReader } from "./host";
import { gl as current, tables, put } from "../android/gl";
import { yieldToLoop } from "./cpu";
import { perf } from "../perf";
import { glProbe } from "./gles1";

type GL = WebGL2RenderingContext;
const g = (): GL => { if (!current) throw new Error("GL call without a current context"); return current as GL; };
const T = tables;
let err = 0;                                  // an error we raised ourselves; glGetError reports it before WebGL's
let unpackPbo = false, packPbo = false;
const mapped = new Map<number, { ptr: number; off: number; len: number; access: number }>();

// ── guest memory views (a misaligned pointer is copied, which GL data rarely is)
type Ctor<A> = { new (b: ArrayBuffer, off: number, n: number): A; new (b: ArrayBuffer): A; BYTES_PER_ELEMENT: number };
function view<A extends ArrayBufferView>(K: Ctor<A>, p: number, n: number): A {
  const bpe = K.BYTES_PER_ELEMENT;
  return p % bpe ? new K(mem.u8.slice(p, p + n * bpe).buffer) : new K(mem.buf, p, n);
}
const i32 = (p: number, n: number) => view(Int32Array, p, n);
const u32 = (p: number, n: number) => view(Uint32Array, p, n);
const f32 = (p: number, n: number) => view(Float32Array, p, n);
const u8 = (p: number, n: number) => mem.u8.subarray(p, p + n);
/** the typed view GL's pixel `type` implies, from p to the end of guest memory: WebGL reads what
 *  the size, format and unpack state need and only checks that the view is at least that long */
function pixels(type: number, p: number): ArrayBufferView {
  const K: Ctor<ArrayBufferView> = type === 0x1406 ? Float32Array : type === 0x1404 ? Int32Array : type === 0x1402 ? Int16Array : type === 0x1400 ? Int8Array
    : type === 0x1401 ? Uint8Array : (type === 0x1403 || type === 0x140b || type === 0x8d61 || type === 0x8033 || type === 0x8034 || type === 0x8363) ? Uint16Array : Uint32Array;
  const n = Math.floor((mem.u8.length - p) / K.BYTES_PER_ELEMENT);
  return p % K.BYTES_PER_ELEMENT ? new K(mem.u8.slice(p, p + Math.min(n, 1 << 26) * K.BYTES_PER_ELEMENT).buffer) : new K(mem.buf, p, n);
}
const texData = (type: number, p: number): unknown => (unpackPbo ? p : p ? pixels(type, p) : null);
/** GL's (bufsize, *length, char *buf) out-string */
function outStr(s: string, bufsize: number, lenp: number, buf: number): void {
  const n = Math.max(0, Math.min(s.length, bufsize - 1));
  if (buf && bufsize > 0) { for (let i = 0; i < n; i++) mem.st8(buf + i, s.charCodeAt(i)); mem.st8(buf + n, 0); }
  if (lenp) mem.st32(lenp, n);
}
/** a getParameter-style answer into guest memory: numbers, booleans, arrays, or a GL object (its handle) */
function out(v: unknown, p: number, st: (a: number, v: number) => void, bpe: number): void {
  if (typeof v === "number") st(p, v);
  else if (typeof v === "boolean") st(p, v ? 1 : 0);
  else if (v && typeof v === "object" && "length" in v) { const arr = v as ArrayLike<number>; for (let i = 0; i < arr.length; i++) st(p + i * bpe, arr[i]); }
  else if (v && typeof v === "object") st(p, T().ids.get(v) ?? 0);
  else st(p, 0);
}
const st32 = (a: number, v: number) => mem.st32(a, v), stf = (a: number, v: number) => mem.stf32(a, v), st8 = (a: number, v: number) => mem.st8(a, v);
const st64 = (a: number, v: number) => mem.st64(a, BigInt(Math.trunc(v)));
const H = <O extends object>(tbl: (O | null)[], h: number): O | null => (h ? tbl[h] ?? null : null);
const U = (h: number) => (h < 0 ? null : T().uniforms[h] ?? null);
function gen(tbl: (object | null)[], n: number, p: number, make: () => object | null): void { for (let i = 0; i < n; i++) mem.st32(p + 4 * i, put(tbl, make())); }
function del(tbl: (object | null)[], n: number, p: number, kill: (o: never) => void): void {
  for (let i = 0; i < n; i++) { const h = mem.ld32(p + 4 * i), o = tbl[h]; if (o) { kill(o as never); tbl[h] = null; } }
}

// ── what this context can do: a WebGL extension is advertised under its ES name only when
// getExtension answers, which is also what turns its formats on
const EXT: [string, string][] = [
  ["WEBGL_compressed_texture_etc1", "GL_OES_compressed_ETC1_RGB8_texture"], ["WEBGL_compressed_texture_etc", ""],
  ["WEBGL_compressed_texture_astc", "GL_KHR_texture_compression_astc_ldr"], ["WEBGL_compressed_texture_s3tc", "GL_EXT_texture_compression_s3tc"],
  ["WEBGL_compressed_texture_s3tc_srgb", "GL_EXT_texture_compression_s3tc_srgb"], ["WEBGL_compressed_texture_pvrtc", "GL_IMG_texture_compression_pvrtc"],
  ["EXT_texture_compression_rgtc", "GL_EXT_texture_compression_rgtc"], ["EXT_color_buffer_float", "GL_EXT_color_buffer_float"],
  ["EXT_color_buffer_half_float", "GL_EXT_color_buffer_half_float"], ["OES_texture_float_linear", "GL_OES_texture_float_linear"],
  ["EXT_texture_filter_anisotropic", "GL_EXT_texture_filter_anisotropic"], ["EXT_texture_norm16", "GL_EXT_texture_norm16"], ["EXT_float_blend", "GL_EXT_float_blend"],
];
// ES2 extensions that ES 3.0 core subsumes without a new entry point; an engine gating on the name sees them
const CORE = "GL_OES_element_index_uint GL_OES_depth24 GL_OES_packed_depth_stencil GL_OES_standard_derivatives GL_OES_texture_float GL_OES_texture_half_float GL_OES_texture_half_float_linear GL_OES_rgb8_rgba8 GL_OES_depth_texture GL_OES_texture_npot GL_OES_fbo_render_mipmap GL_EXT_texture_rg GL_EXT_sRGB GL_EXT_blend_minmax";
const extsOf = new WeakMap<GL, string[]>();
function exts(): string[] {
  const gl = g();
  let e = extsOf.get(gl);
  if (!e) { e = CORE.split(" "); for (const [w, n] of EXT) if (gl.getExtension(w) && n) e.push(n); extsOf.set(gl, e); }
  return e;
}
function str(name: number): string {
  switch (name) {
    case 0x1f00: return "webdroid";
    case 0x1f01: return (g().getExtension("WEBGL_debug_renderer_info") && (g().getParameter(0x9246) as string)) || "WebGL2";
    case 0x1f02: return "OpenGL ES 3.0 webdroid";
    case 0x8b8c: return "OpenGL ES GLSL ES 3.00";
    case 0x1f03: return exts().join(" ");
    default: return "";
  }
}
function param(pname: number): unknown {
  switch (pname) {
    case 0x821b: return 3; case 0x821c: return 0;                                   // MAJOR/MINOR_VERSION
    case 0x821d: return exts().length;                                              // NUM_EXTENSIONS
    case 0x87fe: case 0x8df9: return 0;                                             // NUM_PROGRAM/SHADER_BINARY_FORMATS
    case 0x86a2: return (g().getParameter(0x86a3) as Uint32Array).length;           // NUM_COMPRESSED_TEXTURE_FORMATS
    default: return g().getParameter(pname);
  }
}
const maxName = (p: WebGLProgram, n: number, q: (p: WebGLProgram, i: number) => { name: string } | null) => {
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, (q(p, i)?.name.length ?? 0) + 1); return m;
};
function progParam(p: WebGLProgram, pname: number): unknown {
  const gl = g();
  switch (pname) {
    case 0x8b84: return (gl.getProgramInfoLog(p)?.length ?? 0) + 1;                // INFO_LOG_LENGTH
    case 0x8b87: return maxName(p, gl.getProgramParameter(p, 0x8b86), (q, i) => gl.getActiveUniform(q, i));      // ACTIVE_UNIFORM_MAX_LENGTH
    case 0x8b8a: return maxName(p, gl.getProgramParameter(p, 0x8b89), (q, i) => gl.getActiveAttrib(q, i));       // ACTIVE_ATTRIBUTE_MAX_LENGTH
    case 0x8a35: return maxName(p, gl.getProgramParameter(p, 0x8a36), (q, i) => ({ name: gl.getActiveUniformBlockName(q, i) ?? "" })); // ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH
    case 0x8c76: return maxName(p, gl.getProgramParameter(p, 0x8c83), (q, i) => gl.getTransformFeedbackVarying(q, i)); // TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH
    case 0x8741: return 0;                                                         // PROGRAM_BINARY_LENGTH
    default: return gl.getProgramParameter(p, pname);
  }
}
function shaderParam(s: WebGLShader, pname: number): unknown {
  const gl = g();
  if (pname === 0x8b84) return (gl.getShaderInfoLog(s)?.length ?? 0) + 1;
  if (pname === 0x8b88) return (gl.getShaderSource(s)?.length ?? 0) + 1;            // SHADER_SOURCE_LENGTH
  return gl.getShaderParameter(s, pname);
}
/** glGetActive{Attrib,Uniform,TransformFeedbackVarying}: (prog, index, bufsize, *length, *size, *type, *name) */
const active = (q: (p: WebGLProgram, i: number) => WebGLActiveInfo | null): HostFn => (_c, a) => {
  const p = H(T().programs, a.i()); const i = a.i(), bufsize = a.i(), lenp = a.p(), sizep = a.p(), typep = a.p(), name = a.p();
  const info = p && q(p, i);
  if (!info) return;
  if (sizep) mem.st32(sizep, info.size);
  if (typep) mem.st32(typep, info.type);
  outStr(info.name, bufsize, lenp, name);
};
const names = (pp: number, n: number): string[] => { const r: string[] = []; for (let i = 0; i < n; i++) r.push(mem.cstr(ldp(pp + i * PTR))); return r; };

export function gles3Init(): void {
  const G: Record<string, HostFn> = {
    // ── strings, state queries, errors
    glGetString: (_c, a) => cstr(str(a.i())),
    glGetStringi: (_c, a) => { const n = a.i(), i = a.i(); return cstr(n === 0x1f03 ? exts()[i] ?? "" : ""); },
    glGetIntegerv: (_c, a) => { const n = a.i(); out(param(n), a.p(), st32, 4); },
    glGetInteger64v: (_c, a) => { const n = a.i(); out(param(n), a.p(), st64, 8); },
    glGetFloatv: (_c, a) => { const n = a.i(); out(param(n), a.p(), stf, 4); },
    glGetBooleanv: (_c, a) => { const n = a.i(); out(param(n), a.p(), st8, 1); },
    glGetIntegeri_v: (_c, a) => { const t = a.i(), i = a.i(); out(g().getIndexedParameter(t, i), a.p(), st32, 4); },
    glGetInteger64i_v: (_c, a) => { const t = a.i(), i = a.i(); out(g().getIndexedParameter(t, i), a.p(), st64, 8); },
    glGetInternalformativ: (_c, a) => { const t = a.i(), f = a.i(), pn = a.i(); a.i(); const v = g().getInternalformatParameter(t, f, pn); out(pn === 0x9380 ? (v as Int32Array).length : v, a.p(), st32, 4); },
    glGetShaderPrecisionFormat: (_c, a) => {
      const f = g().getShaderPrecisionFormat(a.i(), a.i()), range = a.p(), prec = a.p();
      if (f) { mem.st32(range, f.rangeMin); mem.st32(range + 4, f.rangeMax); mem.st32(prec, f.precision); }
    },
    glGetError: () => { const e = err; err = 0; return e || (current ? current.getError() : 0); },
    glIsEnabled: (_c, a) => (g().isEnabled(a.i()) ? 1 : 0),
    glEnable: (_c, a) => g().enable(a.i()), glDisable: (_c, a) => g().disable(a.i()),
    glHint: (_c, a) => g().hint(a.i(), a.i()),
    glViewport: (_c, a) => g().viewport(a.i(), a.i(), a.i(), a.i()), glScissor: (_c, a) => g().scissor(a.i(), a.i(), a.i(), a.i()),
    glClear: (_c, a) => g().clear(a.i()), glClearColor: (_c, a) => g().clearColor(a.f(), a.f(), a.f(), a.f()),
    glClearDepthf: (_c, a) => g().clearDepth(a.f()), glClearStencil: (_c, a) => g().clearStencil(a.i()),
    glClearBufferfv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferfv(b, d, f32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferiv(b, d, i32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferuiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferuiv(b, d, u32(a.p(), 4)); },
    glClearBufferfi: (_c, a) => g().clearBufferfi(a.i(), a.i(), a.f(), a.i()),
    glFlush: () => g().flush(), glFinish: () => g().finish(),
    glBlendFunc: (_c, a) => g().blendFunc(a.i(), a.i()), glBlendFuncSeparate: (_c, a) => g().blendFuncSeparate(a.i(), a.i(), a.i(), a.i()),
    glBlendEquation: (_c, a) => g().blendEquation(a.i()), glBlendEquationSeparate: (_c, a) => g().blendEquationSeparate(a.i(), a.i()),
    glBlendColor: (_c, a) => g().blendColor(a.f(), a.f(), a.f(), a.f()),
    glColorMask: (_c, a) => g().colorMask(!!a.i(), !!a.i(), !!a.i(), !!a.i()),
    glDepthFunc: (_c, a) => g().depthFunc(a.i()), glDepthMask: (_c, a) => g().depthMask(!!a.i()), glDepthRangef: (_c, a) => g().depthRange(a.f(), a.f()),
    glStencilFunc: (_c, a) => g().stencilFunc(a.i(), a.i(), a.i()), glStencilFuncSeparate: (_c, a) => g().stencilFuncSeparate(a.i(), a.i(), a.i(), a.i()),
    glStencilOp: (_c, a) => g().stencilOp(a.i(), a.i(), a.i()), glStencilOpSeparate: (_c, a) => g().stencilOpSeparate(a.i(), a.i(), a.i(), a.i()),
    glStencilMask: (_c, a) => g().stencilMask(a.i()), glStencilMaskSeparate: (_c, a) => g().stencilMaskSeparate(a.i(), a.i()),
    glCullFace: (_c, a) => g().cullFace(a.i()), glFrontFace: (_c, a) => g().frontFace(a.i()),
    glPolygonOffset: (_c, a) => g().polygonOffset(a.f(), a.f()), glLineWidth: (_c, a) => g().lineWidth(a.f()),
    glSampleCoverage: (_c, a) => g().sampleCoverage(a.f(), !!a.i()),
    glPixelStorei: (_c, a) => g().pixelStorei(a.i(), a.i()),

    // ── shaders and programs
    glCreateShader: (_c, a) => put(T().shaders, g().createShader(a.i())),
    glDeleteShader: (_c, a) => { const h = a.i(), s = T().shaders[h]; if (s) { g().deleteShader(s); T().shaders[h] = null; } },
    glIsShader: (_c, a) => (H(T().shaders, a.i()) ? 1 : 0),
    glShaderSource: (_c, a) => {
      const s = H(T().shaders, a.i()); const n = a.i(), pp = a.p(), lp = a.p();
      let src = "";
      for (let i = 0; i < n; i++) {
        const p = ldp(pp + i * PTR), len = lp ? mem.ld32(lp + 4 * i) : -1;
        src += len < 0 ? mem.cstr(p) : new TextDecoder().decode(mem.bytes(p, len));
      }
      if (s) g().shaderSource(s, src);
    },
    glCompileShader: (_c, a) => { const s = H(T().shaders, a.i()); if (s) g().compileShader(s); },
    glGetShaderiv: (_c, a) => { const s = H(T().shaders, a.i()), pn = a.i(); out(s ? shaderParam(s, pn) : 0, a.p(), st32, 4); },
    glGetShaderInfoLog: (_c, a) => { const s = H(T().shaders, a.i()); outStr((s && g().getShaderInfoLog(s)) ?? "", a.i(), a.p(), a.p()); },
    glGetShaderSource: (_c, a) => { const s = H(T().shaders, a.i()); outStr((s && g().getShaderSource(s)) ?? "", a.i(), a.p(), a.p()); },
    glReleaseShaderCompiler: () => {},
    glShaderBinary: () => { err = 0x500; },                                       // INVALID_ENUM: no binary formats
    glCreateProgram: () => put(T().programs, g().createProgram()),
    glDeleteProgram: (_c, a) => { const h = a.i(), p = T().programs[h]; if (p) { g().deleteProgram(p); T().programs[h] = null; } },
    glIsProgram: (_c, a) => (H(T().programs, a.i()) ? 1 : 0),
    glAttachShader: (_c, a) => { const p = H(T().programs, a.i()), s = H(T().shaders, a.i()); if (p && s) g().attachShader(p, s); },
    glDetachShader: (_c, a) => { const p = H(T().programs, a.i()), s = H(T().shaders, a.i()); if (p && s) g().detachShader(p, s); },
    glLinkProgram: (_c, a) => { const p = H(T().programs, a.i()); if (p) g().linkProgram(p); },
    glUseProgram: (_c, a) => g().useProgram(H(T().programs, a.i())),
    glValidateProgram: (_c, a) => { const p = H(T().programs, a.i()); if (p) g().validateProgram(p); },
    glGetProgramiv: (_c, a) => { const p = H(T().programs, a.i()), pn = a.i(); out(p ? progParam(p, pn) : 0, a.p(), st32, 4); },
    glGetProgramInfoLog: (_c, a) => { const p = H(T().programs, a.i()); outStr((p && g().getProgramInfoLog(p)) ?? "", a.i(), a.p(), a.p()); },
    glProgramParameteri: () => {},
    glGetProgramBinary: (_c, a) => { a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 0); err = 0x502; },  // INVALID_OPERATION
    glProgramBinary: () => { err = 0x500; },
    glGetAttachedShaders: (_c, a) => {
      const p = H(T().programs, a.i()); const max = a.i(), countp = a.p(), outp = a.p();
      const sh = (p && g().getAttachedShaders(p)) ?? [];
      const n = Math.min(max, sh.length);
      for (let i = 0; i < n; i++) mem.st32(outp + 4 * i, T().ids.get(sh[i]) ?? 0);
      if (countp) mem.st32(countp, n);
    },
    glBindAttribLocation: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(), n = a.str(); if (p) g().bindAttribLocation(p, i, n); },
    glGetAttribLocation: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getAttribLocation(p, a.str()) : -1; },
    glGetFragDataLocation: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getFragDataLocation(p, a.str()) : -1; },
    glGetUniformLocation: (_c, a) => { const p = H(T().programs, a.i()); const u = p && g().getUniformLocation(p, a.str()); return u ? put(T().uniforms, u) : -1; },
    glGetActiveAttrib: active((p, i) => g().getActiveAttrib(p, i)),
    glGetActiveUniform: active((p, i) => g().getActiveUniform(p, i)),
    glGetTransformFeedbackVarying: active((p, i) => g().getTransformFeedbackVarying(p, i)),
    glGetUniformBlockIndex: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getUniformBlockIndex(p, a.str()) : 0xffffffff; },
    glUniformBlockBinding: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(), b = a.i(); if (p) g().uniformBlockBinding(p, i, b); },
    glGetActiveUniformBlockiv: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(), pn = a.i(); out(p && g().getActiveUniformBlockParameter(p, i, pn), a.p(), st32, 4); },
    glGetActiveUniformBlockName: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(); outStr((p && g().getActiveUniformBlockName(p, i)) ?? "", a.i(), a.p(), a.p()); },
    glGetUniformIndices: (_c, a) => { const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(); out(p && g().getUniformIndices(p, names(pp, n)), a.p(), st32, 4); },
    glGetActiveUniformsiv: (_c, a) => { const p = H(T().programs, a.i()); const n = a.i(), ip = a.p(), pn = a.i(); out(p && g().getActiveUniforms(p, Array.from(u32(ip, n)), pn), a.p(), st32, 4); },
    glTransformFeedbackVaryings: (_c, a) => { const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(), mode = a.i(); if (p) g().transformFeedbackVaryings(p, names(pp, n), mode); },
    glGetUniformfv: (_c, a) => { const p = H(T().programs, a.i()), u = U(a.i()); out(p && u && g().getUniform(p, u), a.p(), stf, 4); },
    glGetUniformiv: (_c, a) => { const p = H(T().programs, a.i()), u = U(a.i()); out(p && u && g().getUniform(p, u), a.p(), st32, 4); },
    glGetUniformuiv: (_c, a) => { const p = H(T().programs, a.i()), u = U(a.i()); out(p && u && g().getUniform(p, u), a.p(), st32, 4); },

    // ── buffers
    glGenBuffers: (_c, a) => { const n = a.i(); gen(T().buffers, n, a.p(), () => g().createBuffer()); },
    glDeleteBuffers: (_c, a) => { const n = a.i(); del(T().buffers, n, a.p(), (o) => g().deleteBuffer(o)); },
    glIsBuffer: (_c, a) => (H(T().buffers, a.i()) ? 1 : 0),
    glBindBuffer: (_c, a) => {
      const t = a.i(), h = a.i();
      if (t === 0x88ec) unpackPbo = !!h; else if (t === 0x88eb) packPbo = !!h;      // PIXEL_UNPACK/PACK_BUFFER
      g().bindBuffer(t, H(T().buffers, h));
    },
    glBindBufferBase: (_c, a) => g().bindBufferBase(a.i(), a.i(), H(T().buffers, a.i())),
    glBindBufferRange: (_c, a) => g().bindBufferRange(a.i(), a.i(), H(T().buffers, a.i()), a.i(), a.i()),
    glBufferData: (_c, a) => { const t = a.i(), n = a.i(), p = a.p(), usage = a.i(); if (p) g().bufferData(t, u8(p, n), usage); else g().bufferData(t, n, usage); },
    glBufferSubData: (_c, a) => { const t = a.i(), off = a.i(), n = a.i(); g().bufferSubData(t, off, u8(a.p(), n)); },
    glCopyBufferSubData: (_c, a) => g().copyBufferSubData(a.i(), a.i(), a.i(), a.i(), a.i()),
    glGetBufferParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getBufferParameter(t, pn), a.p(), st32, 4); },
    glGetBufferParameteri64v: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getBufferParameter(t, pn), a.p(), st64, 8); },
    // a mapping is a guest shadow of the range: read in on map, written back on unmap or flush
    glMapBufferRange: (_c, a) => {
      const t = a.i(), off = a.i(), len = a.i(), access = a.i(), ptr = mem.malloc(len);
      if (access & 1) g().getBufferSubData(t, off, u8(ptr, len));
      mapped.set(t, { ptr, off, len, access });
      return ptr;
    },
    glFlushMappedBufferRange: (_c, a) => { const t = a.i(), m = mapped.get(t), off = a.i(), len = a.i(); if (m) g().bufferSubData(t, m.off + off, u8(m.ptr + off, len)); },
    glUnmapBuffer: (_c, a) => {
      const t = a.i(), m = mapped.get(t);
      if (!m) return 0;
      mapped.delete(t);
      if ((m.access & 2) && !(m.access & 0x10)) g().bufferSubData(t, m.off, u8(m.ptr, m.len));   // MAP_WRITE_BIT without MAP_FLUSH_EXPLICIT_BIT
      mem.free(m.ptr);
      return 1;
    },
    glGetBufferPointerv: (_c, a) => { const t = a.i(); a.i(); stp(a.p(), mapped.get(t)?.ptr ?? 0); },

    // ── vertex arrays and attributes
    glGenVertexArrays: (_c, a) => { const n = a.i(); gen(T().vaos, n, a.p(), () => g().createVertexArray()); },
    glDeleteVertexArrays: (_c, a) => { const n = a.i(); del(T().vaos, n, a.p(), (o) => g().deleteVertexArray(o)); },
    glBindVertexArray: (_c, a) => g().bindVertexArray(H(T().vaos, a.i())),
    glIsVertexArray: (_c, a) => (H(T().vaos, a.i()) ? 1 : 0),
    glEnableVertexAttribArray: (_c, a) => g().enableVertexAttribArray(a.i()), glDisableVertexAttribArray: (_c, a) => g().disableVertexAttribArray(a.i()),
    glVertexAttribPointer: (_c, a) => g().vertexAttribPointer(a.i(), a.i(), a.i(), !!a.i(), a.i(), a.p()),
    glVertexAttribIPointer: (_c, a) => g().vertexAttribIPointer(a.i(), a.i(), a.i(), a.i(), a.p()),
    glVertexAttribDivisor: (_c, a) => g().vertexAttribDivisor(a.i(), a.i()),
    glVertexAttrib1f: (_c, a) => g().vertexAttrib1f(a.i(), a.f()), glVertexAttrib2f: (_c, a) => g().vertexAttrib2f(a.i(), a.f(), a.f()),
    glVertexAttrib3f: (_c, a) => g().vertexAttrib3f(a.i(), a.f(), a.f(), a.f()), glVertexAttrib4f: (_c, a) => g().vertexAttrib4f(a.i(), a.f(), a.f(), a.f(), a.f()),
    glVertexAttrib1fv: (_c, a) => g().vertexAttrib1fv(a.i(), f32(a.p(), 1)), glVertexAttrib2fv: (_c, a) => g().vertexAttrib2fv(a.i(), f32(a.p(), 2)),
    glVertexAttrib3fv: (_c, a) => g().vertexAttrib3fv(a.i(), f32(a.p(), 3)), glVertexAttrib4fv: (_c, a) => g().vertexAttrib4fv(a.i(), f32(a.p(), 4)),
    glVertexAttribI4i: (_c, a) => g().vertexAttribI4i(a.i(), a.i(), a.i(), a.i(), a.i()), glVertexAttribI4ui: (_c, a) => g().vertexAttribI4ui(a.i(), a.u(), a.u(), a.u(), a.u()),
    glVertexAttribI4iv: (_c, a) => g().vertexAttribI4iv(a.i(), i32(a.p(), 4)), glVertexAttribI4uiv: (_c, a) => g().vertexAttribI4uiv(a.i(), u32(a.p(), 4)),
    glGetVertexAttribfv: (_c, a) => { const i = a.i(), pn = a.i(); out(g().getVertexAttrib(i, pn), a.p(), stf, 4); },
    glGetVertexAttribiv: (_c, a) => { const i = a.i(), pn = a.i(); out(g().getVertexAttrib(i, pn), a.p(), st32, 4); },
    glGetVertexAttribIiv: (_c, a) => { const i = a.i(), pn = a.i(); out(g().getVertexAttrib(i, pn), a.p(), st32, 4); },
    glGetVertexAttribIuiv: (_c, a) => { const i = a.i(), pn = a.i(); out(g().getVertexAttrib(i, pn), a.p(), st32, 4); },
    glGetVertexAttribPointerv: (_c, a) => { const i = a.i(), pn = a.i(); stp(a.p(), g().getVertexAttribOffset(i, pn)); },

    // ── draws
    glDrawArrays: (_c, a) => { perf.glDraws++; g().drawArrays(a.i(), a.i(), a.i()); },
    glDrawElements: (_c, a) => { perf.glDraws++; g().drawElements(a.i(), a.i(), a.i(), a.p()); },
    glDrawArraysInstanced: (_c, a) => { perf.glDraws++; g().drawArraysInstanced(a.i(), a.i(), a.i(), a.i()); },
    glDrawElementsInstanced: (_c, a) => { perf.glDraws++; g().drawElementsInstanced(a.i(), a.i(), a.i(), a.p(), a.i()); },
    glDrawRangeElements: (_c, a) => { perf.glDraws++; g().drawRangeElements(a.i(), a.i(), a.i(), a.i(), a.i(), a.p()); },

    // ── textures and samplers
    glActiveTexture: (_c, a) => g().activeTexture(a.i()),
    glGenTextures: (_c, a) => { const n = a.i(); gen(T().textures, n, a.p(), () => g().createTexture()); },
    glDeleteTextures: (_c, a) => { const n = a.i(); del(T().textures, n, a.p(), (o) => g().deleteTexture(o)); },
    glIsTexture: (_c, a) => (H(T().textures, a.i()) ? 1 : 0),
    glBindTexture: (_c, a) => g().bindTexture(a.i(), H(T().textures, a.i())),
    glTexImage2D: (_c, a) => { const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), b = a.i(), fmt = a.i(), ty = a.i(); (g().texImage2D as Function)(t, l, f, w, h, b, fmt, ty, texData(ty, a.p())); },
    glTexSubImage2D: (_c, a) => { const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), fmt = a.i(), ty = a.i(); (g().texSubImage2D as Function)(t, l, x, y, w, h, fmt, ty, texData(ty, a.p())); },
    glTexImage3D: (_c, a) => { const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(), b = a.i(), fmt = a.i(), ty = a.i(); (g().texImage3D as Function)(t, l, f, w, h, d, b, fmt, ty, texData(ty, a.p())); },
    glTexSubImage3D: (_c, a) => { const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), fmt = a.i(), ty = a.i(); (g().texSubImage3D as Function)(t, l, x, y, z, w, h, d, fmt, ty, texData(ty, a.p())); },
    glCompressedTexImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(); a.i(); const n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexImage2D(t, l, f, w, h, 0, n, p); else g().compressedTexImage2D(t, l, f, w, h, 0, u8(p, n));
    },
    glCompressedTexSubImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), f = a.i(), n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexSubImage2D(t, l, x, y, w, h, f, n, p); else g().compressedTexSubImage2D(t, l, x, y, w, h, f, u8(p, n));
    },
    glCompressedTexImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(); a.i(); const n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexImage3D(t, l, f, w, h, d, 0, n, p); else g().compressedTexImage3D(t, l, f, w, h, d, 0, u8(p, n));
    },
    glCompressedTexSubImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), f = a.i(), n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, n, p); else g().compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, u8(p, n));
    },
    glTexStorage2D: (_c, a) => g().texStorage2D(a.i(), a.i(), a.i(), a.i(), a.i()),
    glTexStorage3D: (_c, a) => g().texStorage3D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glCopyTexImage2D: (_c, a) => g().copyTexImage2D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glCopyTexSubImage2D: (_c, a) => g().copyTexSubImage2D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glCopyTexSubImage3D: (_c, a) => g().copyTexSubImage3D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glGenerateMipmap: (_c, a) => g().generateMipmap(a.i()),
    glTexParameteri: (_c, a) => texParam(a.i(), a.i(), a.i()),
    glTexParameterf: (_c, a) => { const t = a.i(), pn = a.i(); g().texParameterf(t, pn, a.f()); },
    glTexParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); texParam(t, pn, mem.ld32(a.p())); },
    glTexParameterfv: (_c, a) => { const t = a.i(), pn = a.i(); g().texParameterf(t, pn, mem.ldf32(a.p())); },
    glGetTexParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getTexParameter(t, pn), a.p(), st32, 4); },
    glGetTexParameterfv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getTexParameter(t, pn), a.p(), stf, 4); },
    glGenSamplers: (_c, a) => { const n = a.i(); gen(T().samplers, n, a.p(), () => g().createSampler()); },
    glDeleteSamplers: (_c, a) => { const n = a.i(); del(T().samplers, n, a.p(), (o) => g().deleteSampler(o)); },
    glIsSampler: (_c, a) => (H(T().samplers, a.i()) ? 1 : 0),
    glBindSampler: (_c, a) => g().bindSampler(a.i(), H(T().samplers, a.i())),
    glSamplerParameteri: (_c, a) => { const s = H(T().samplers, a.i()); const pn = a.i(), v = a.i(); if (s) g().samplerParameteri(s, pn, v); },
    glSamplerParameterf: (_c, a) => { const s = H(T().samplers, a.i()); const pn = a.i(), v = a.f(); if (s) g().samplerParameterf(s, pn, v); },
    glSamplerParameteriv: (_c, a) => { const s = H(T().samplers, a.i()); const pn = a.i(), v = mem.ld32(a.p()); if (s) g().samplerParameteri(s, pn, v); },
    glSamplerParameterfv: (_c, a) => { const s = H(T().samplers, a.i()); const pn = a.i(), v = mem.ldf32(a.p()); if (s) g().samplerParameterf(s, pn, v); },
    glGetSamplerParameteriv: (_c, a) => { const s = H(T().samplers, a.i()); const pn = a.i(); out(s && g().getSamplerParameter(s, pn), a.p(), st32, 4); },
    glGetSamplerParameterfv: (_c, a) => { const s = H(T().samplers, a.i()); const pn = a.i(); out(s && g().getSamplerParameter(s, pn), a.p(), stf, 4); },

    // ── framebuffers and renderbuffers
    glGenFramebuffers: (_c, a) => { const n = a.i(); gen(T().fbos, n, a.p(), () => g().createFramebuffer()); },
    glDeleteFramebuffers: (_c, a) => { const n = a.i(); del(T().fbos, n, a.p(), (o) => g().deleteFramebuffer(o)); },
    glIsFramebuffer: (_c, a) => (H(T().fbos, a.i()) ? 1 : 0),
    glBindFramebuffer: (_c, a) => g().bindFramebuffer(a.i(), H(T().fbos, a.i())),
    glFramebufferTexture2D: (_c, a) => g().framebufferTexture2D(a.i(), a.i(), a.i(), H(T().textures, a.i()), a.i()),
    glFramebufferTextureLayer: (_c, a) => g().framebufferTextureLayer(a.i(), a.i(), H(T().textures, a.i()), a.i(), a.i()),
    glFramebufferRenderbuffer: (_c, a) => g().framebufferRenderbuffer(a.i(), a.i(), a.i(), H(T().rbos, a.i())),
    glCheckFramebufferStatus: (_c, a) => g().checkFramebufferStatus(a.i()),
    glGetFramebufferAttachmentParameteriv: (_c, a) => { const t = a.i(), at = a.i(), pn = a.i(); out(g().getFramebufferAttachmentParameter(t, at, pn), a.p(), st32, 4); },
    glBlitFramebuffer: (_c, a) => g().blitFramebuffer(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glInvalidateFramebuffer: (_c, a) => { const t = a.i(), n = a.i(); g().invalidateFramebuffer(t, Array.from(i32(a.p(), n))); },
    glInvalidateSubFramebuffer: (_c, a) => { const t = a.i(), n = a.i(), at = Array.from(i32(a.p(), n)); g().invalidateSubFramebuffer(t, at, a.i(), a.i(), a.i(), a.i()); },
    glDrawBuffers: (_c, a) => { const n = a.i(); g().drawBuffers(Array.from(i32(a.p(), n))); },
    glReadBuffer: (_c, a) => g().readBuffer(a.i()),
    glReadPixels: (_c, a) => {
      const x = a.i(), y = a.i(), w = a.i(), h = a.i(), f = a.i(), ty = a.i(), p = a.p();
      if (packPbo) g().readPixels(x, y, w, h, f, ty, p); else g().readPixels(x, y, w, h, f, ty, pixels(ty, p));
    },
    glGenRenderbuffers: (_c, a) => { const n = a.i(); gen(T().rbos, n, a.p(), () => g().createRenderbuffer()); },
    glDeleteRenderbuffers: (_c, a) => { const n = a.i(); del(T().rbos, n, a.p(), (o) => g().deleteRenderbuffer(o)); },
    glIsRenderbuffer: (_c, a) => (H(T().rbos, a.i()) ? 1 : 0),
    glBindRenderbuffer: (_c, a) => g().bindRenderbuffer(a.i(), H(T().rbos, a.i())),
    glRenderbufferStorage: (_c, a) => g().renderbufferStorage(a.i(), a.i(), a.i(), a.i()),
    glRenderbufferStorageMultisample: (_c, a) => g().renderbufferStorageMultisample(a.i(), a.i(), a.i(), a.i(), a.i()),
    glGetRenderbufferParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getRenderbufferParameter(t, pn), a.p(), st32, 4); },

    // ── queries, sync, transform feedback
    glGenQueries: (_c, a) => { const n = a.i(); gen(T().queries, n, a.p(), () => g().createQuery()); },
    glDeleteQueries: (_c, a) => { const n = a.i(); del(T().queries, n, a.p(), (o) => g().deleteQuery(o)); },
    glIsQuery: (_c, a) => (H(T().queries, a.i()) ? 1 : 0),
    glBeginQuery: (_c, a) => { const t = a.i(), q = H(T().queries, a.i()); if (q) g().beginQuery(t, q); },
    glEndQuery: (_c, a) => g().endQuery(a.i()),
    glGetQueryiv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getQuery(t, pn), a.p(), st32, 4); },
    glGetQueryObjectuiv: (_c, a) => { const q = H(T().queries, a.i()); const pn = a.i(); out(q && g().getQueryParameter(q, pn), a.p(), st32, 4); },
    glFenceSync: (_c, a) => put(T().syncs, g().fenceSync(a.i(), a.i())),
    glIsSync: (_c, a) => (H(T().syncs, a.i()) ? 1 : 0),
    glDeleteSync: (_c, a) => { const h = a.i(), s = T().syncs[h]; if (s) { g().deleteSync(s); T().syncs[h] = null; } },
    glWaitSync: (_c, a) => { const s = H(T().syncs, a.i()); if (s) g().waitSync(s, 0, -1); },
    // a wait longer than the fence takes is spent yielding, one macrotask per look
    glClientWaitSync: async (_c, a) => {
      const s = H(T().syncs, a.i()); const flags = a.i(), until = performance.now() + Number(a.ul()) / 1e6;
      if (!s) return 0x911d;                                                    // WAIT_FAILED
      let r = g().clientWaitSync(s, flags, 0);
      while (r === 0x911b && performance.now() < until) { await yieldToLoop(); r = g().clientWaitSync(s, 0, 0); }
      return r;
    },
    glGetSynciv: (_c, a) => { const s = H(T().syncs, a.i()); const pn = a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 1); out(s && g().getSyncParameter(s, pn), a.p(), st32, 4); },
    glGenTransformFeedbacks: (_c, a) => { const n = a.i(); gen(T().tfs, n, a.p(), () => g().createTransformFeedback()); },
    glDeleteTransformFeedbacks: (_c, a) => { const n = a.i(); del(T().tfs, n, a.p(), (o) => g().deleteTransformFeedback(o)); },
    glIsTransformFeedback: (_c, a) => (H(T().tfs, a.i()) ? 1 : 0),
    glBindTransformFeedback: (_c, a) => g().bindTransformFeedback(a.i(), H(T().tfs, a.i())),
    glBeginTransformFeedback: (_c, a) => g().beginTransformFeedback(a.i()), glEndTransformFeedback: () => g().endTransformFeedback(),
    glPauseTransformFeedback: () => g().pauseTransformFeedback(), glResumeTransformFeedback: () => g().resumeTransformFeedback(),
  };
  // ── uniforms: glUniform{1..4}{f,i,ui}[v] and the nine matrix shapes
  const kinds = [["f", (a: ArgReader) => a.f(), f32], ["i", (a: ArgReader) => a.i(), i32], ["ui", (a: ArgReader) => a.u(), u32]] as const;
  for (let n = 1; n <= 4; n++) for (const [k, rd, vw] of kinds) {
    const fn = `uniform${n}${k}`, fnv = fn + "v";
    G[`glUniform${n}${k}`] = (_c, a) => {
      const u = U(a.i()), x = rd(a), y = n > 1 ? rd(a) : 0, z = n > 2 ? rd(a) : 0, w = n > 3 ? rd(a) : 0;
      if (u) (g() as unknown as Record<string, (...v: unknown[]) => void>)[fn](u, x, y, z, w);
    };
    G[`glUniform${n}${k}v`] = (_c, a) => { const u = U(a.i()), cnt = a.i(), p = a.p(); if (u) (g() as unknown as Record<string, (...v: unknown[]) => void>)[fnv](u, vw(p, cnt * n)); };
  }
  for (const [m, e] of [["2", 4], ["3", 9], ["4", 16], ["2x3", 6], ["3x2", 6], ["2x4", 8], ["4x2", 8], ["3x4", 12], ["4x3", 12]] as const) {
    const fn = `uniformMatrix${m}fv`;
    G[`glUniformMatrix${m}fv`] = (_c, a) => { const u = U(a.i()), cnt = a.i(), t = !!a.i(), p = a.p(); if (u) (g() as unknown as Record<string, (...v: unknown[]) => void>)[fn](u, t, f32(p, cnt * e)); };
  }
  // the probe: after each entry point, count and name a GL error (wd.native.glProbe)
  for (const [k, f] of Object.entries(G)) {
    if (k === "glGetError") continue;
    G[k] = (c, a) => { const r = f(c, a); if (glProbe.on && current) { const e = current.getError(); if (e) { perf.glErrors++; console.warn("[gl] 0x" + e.toString(16), "after", k); } } return r; };
  }
  hostLib("libGLESv2.so", G, { closed: true });
  hostLib("libGLESv3.so", G, { closed: true });
}
function texParam(t: number, pn: number, v: number): void {
  // WebGL2 has no texture swizzle; an engine that reads back glGetError sees INVALID_ENUM, as on a GL without it
  if (pn >= 0x8e42 && pn <= 0x8e45) { err = 0x500; if (!calledMissing.has("gles3:texture swizzle")) calledMissing.add("gles3:texture swizzle"); return; }
  g().texParameteri(t, pn, v);
}
