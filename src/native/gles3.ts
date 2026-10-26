// OpenGL ES 3.0 over WebGL2, registered as libGLESv2.so and libGLESv3.so. Closed: a name outside
// ES 3.0 core (KHR_debug, the ES 3.1 entry points) is NULL from dlsym and eglGetProcAddress, so
// an engine feature-gates as on a device. Handles are gl-context.ts's per-context tables, shared with the
// Java GLES20 bindings. Pointer arguments are guest memory, or offsets while a pixel or element
// buffer is bound, as in GL. The state kept beside WebGL is gles3-state.ts's, with its buffers,
// pixels, client arrays and validation in the gles3-* modules beside it.

import { mem } from "./mem.ts";
import { hostLib, cstr, PTR, ldp, stp, calledMissing, type HostFn, type ArgReader } from "./host.ts";
import { gl as current, tables as T, put, takeError, raise, unsure, entry } from "./gl-context.ts";
import { yieldToLoop } from "../jvm/yield.ts";
import { perf } from "../perf.ts";
import { utf8 } from "../jvm/abi.ts";
import { rewriteTextureSwizzles } from "./swizzle.ts";
import {
  g, H, TEXTURE0, UNBOUND, contextState, textureRec, texRecs, textureTarget, externalSamplersAs2D, activeUniformInfo, boundTexture, linkProgram,
  prepareDraw, setSamplerUnits, glForTextureFormat, shaderRecs, programRecs, samplerSlots, uniformHandles, pbo, type GL, type ContextState,
} from "./gles3-state.ts";
import { i32, u32, f32, u8, pixelStore, readGuestPixels, texData, PACK, UNPACK } from "./gles3-pixels.ts";
import { bufferTexture, imageBuffer, ownsTexture } from "./hardwarebuffer.ts";
import { frameSize } from "../android/glsurface.ts";
import { recOf, rec, recAt, bindRec, shadowed, withTarget, writeBuffers, writeBack, contents, realize, syncVertexBuffer, syncFeedback, COPY_READ, COPY_WRITE } from "./gles3-buffers.ts";
import { vertexAttribPointer, clientArray, drawClientArrays, drawClientElements } from "./gles3-client-arrays.ts";
import {
  keepsClean, keptClean, forgetImages, untrust, texParamAccepted, storageAccepted, imageAccepted, recordImage, subImageAccepted, pixelStoreAccepted,
  textureOf, TEXTURE_TARGETS, BUFFER_TARGETS, USAGES, RENDERBUFFER_FORMATS,
} from "./gles3-validate.ts";
export let gles3Procs: Record<string, HostFn> = {};
export const glProbe = !!(globalThis as { __wdGlProbe?: boolean }).__wdGlProbe;
const mapped = new WeakMap<object, { ptr: number; off: number; len: number; access: number }>();   // a mapping belongs to the buffer, not the target
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
const U = (h: number) => (h < 0 ? null : T().uniforms[h] ?? null);
function gen(tbl: (object | null)[], n: number, p: number, make: () => object | null): void { if (n < 0) raise(0x501); for (let i = 0; i < n; i++) mem.st32(p + 4 * i, put(tbl, make())); }
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
// and external textures (SurfaceTexture's, EGLImages'), which shaders' samplerExternalOES read as 2D storage (gles3-state.ts)
const CORE = "GL_OES_element_index_uint GL_OES_depth24 GL_OES_packed_depth_stencil GL_OES_standard_derivatives GL_OES_texture_float GL_OES_texture_half_float GL_OES_texture_half_float_linear GL_OES_rgb8_rgba8 GL_OES_depth_texture GL_OES_texture_npot GL_OES_fbo_render_mipmap GL_EXT_texture_rg GL_EXT_sRGB GL_EXT_blend_minmax GL_OES_EGL_image GL_OES_EGL_image_external GL_OES_EGL_image_external_essl3";
const extsOf = new WeakMap<GL, string[]>();
/** glClientWaitSync's wait, which EGL's fences share: a wait longer than the fence takes is spent yielding, one macrotask per look */
export async function clientWait(gl: GL, sync: WebGLSync, flags: number, timeoutNs: bigint): Promise<number> {
  const until = performance.now() + Number(timeoutNs) / 1e6;
  let r = gl.clientWaitSync(sync, flags, 0);
  while (r === 0x911b && performance.now() < until) { await yieldToLoop(); r = gl.clientWaitSync(sync, 0, 0); }
  return r;
}
function gles3Extensions(gl: GL): string[] {
  let e = extsOf.get(gl);
  if (!e) {
    e = CORE.split(" ");
    for (const [w, n] of EXT) if (gl.getExtension(w) && n && (n !== "GL_EXT_color_buffer_half_float" || rendersRgb16f(gl))) e.push(n);
    extsOf.set(gl, e);
  }
  return e;
}
/** GL_EXT_color_buffer_half_float makes RGB16F color-renderable, which WebGL 2's EXT_color_buffer_half_float need not: an engine that renders
 *  to RGB16F where it is advertised (Filament's HDR targets) draws nothing into an incomplete framebuffer */
function rendersRgb16f(gl: GL): boolean {
  if (!("texStorage2D" in gl)) return false;
  const texture = gl.getParameter(gl.TEXTURE_BINDING_2D), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const t = gl.createTexture(), f = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB16F, 1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.deleteFramebuffer(f); gl.deleteTexture(t);
  return complete;
}
function str(name: number): string {
  switch (name) {
    case 0x1f00: return "webdroid";
    case 0x1f01: return (g().getExtension("WEBGL_debug_renderer_info") && (g().getParameter(0x9246) as string)) || "WebGL2";
    case 0x1f02: return "OpenGL ES 3.0 webdroid";
    case 0x8b8c: return "OpenGL ES GLSL ES 3.00";
    case 0x1f03: return gles3Extensions(g()).join(" ");
    default: return "";
  }
}
function param(pname: number): unknown {
  switch (pname) {
    case 0x821b: return 3; case 0x821c: return 0;                                   // MAJOR/MINOR_VERSION
    case 0x821d: return gles3Extensions(g()).length;                               // NUM_EXTENSIONS
    case 0x87fe: case 0x8df9: return 0;                                             // NUM_PROGRAM/SHADER_BINARY_FORMATS
    case 0x86a2: return (g().getParameter(0x86a3) as Uint32Array).length;           // NUM_COMPRESSED_TEXTURE_FORMATS
    case 0x8d67: return g().getParameter(0x8069);                                   // TEXTURE_BINDING_EXTERNAL_OES
    default: return g().getParameter(pname);
  }
}
const maxName = (p: WebGLProgram, n: number, q: (p: WebGLProgram, i: number) => { name: string } | null) => {
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, (q(p, i)?.name.length ?? 0) + 1); return m;
};
function progParam(p: WebGLProgram, pname: number): unknown {
  const gl = g();
  const rec = programRecs.get(p);
  switch (pname) {
    case 0x8b84: return (gl.getProgramInfoLog(p)?.length ?? 0) + 1;                // INFO_LOG_LENGTH
    case 0x8b86: return rec?.uniforms.infos.length ?? gl.getProgramParameter(p, pname); // ACTIVE_UNIFORMS
    case 0x8b87: return rec ? Math.max(0, ...rec.uniforms.infos.map((info) => info.name.length + 1))
      : maxName(p, gl.getProgramParameter(p, 0x8b86), (q, i) => gl.getActiveUniform(q, i)); // ACTIVE_UNIFORM_MAX_LENGTH
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
  if (pname === 0x8b88) return (shaderRecs.get(s)?.original.length ?? gl.getShaderSource(s)?.length ?? 0) + 1; // SHADER_SOURCE_LENGTH
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
function uniformLocation(p: WebGLProgram, name: string): number {
  const [, base, index] = /^(.*?)(?:\[(\d+)\])?$/.exec(name)!, rec = programRecs.get(p);
  if (rec && rec.hidden.has(base)) return -1;
  const u = g().getUniformLocation(p, name);
  if (!u) return -1;
  const binding = rec && rec.samplers.get(base);
  if (rec && binding) samplerSlots.set(u, { rec, binding, index: Number(index ?? 0) });
  return put(T().uniforms, u);
}
const names = (pp: number, n: number): string[] => { const r: string[] = []; for (let i = 0; i < n; i++) r.push(mem.cstr(ldp(pp + i * PTR))); return r; };

/** the state entry points ES 1.1 and ES 3.0 share */
export const glCommon: Record<string, HostFn> = {
  glViewport: (_c, a) => g().viewport(a.i(), a.i(), a.i(), a.i()), glScissor: (_c, a) => g().scissor(a.i(), a.i(), a.i(), a.i()),
  glClear: (_c, a) => g().clear(a.i()), glClearColor: (_c, a) => g().clearColor(a.f(), a.f(), a.f(), a.f()),
  glClearDepthf: (_c, a) => g().clearDepth(a.f()), glClearStencil: (_c, a) => g().clearStencil(a.i()),
  glFlush: keepsClean(() => g().flush()), glFinish: () => g().finish(),
  glBlendFunc: (_c, a) => g().blendFunc(a.i(), a.i()), glBlendFuncSeparate: (_c, a) => g().blendFuncSeparate(a.i(), a.i(), a.i(), a.i()),
  glBlendEquation: (_c, a) => g().blendEquation(a.i()), glBlendEquationSeparate: (_c, a) => g().blendEquationSeparate(a.i(), a.i()),
  glBlendColor: (_c, a) => g().blendColor(a.f(), a.f(), a.f(), a.f()),
  glColorMask: (_c, a) => g().colorMask(!!(a.i() & 255), !!(a.i() & 255), !!(a.i() & 255), !!(a.i() & 255)),
  glDepthFunc: (_c, a) => g().depthFunc(a.i()), glDepthMask: (_c, a) => g().depthMask(!!(a.i() & 255)), glDepthRangef: (_c, a) => g().depthRange(a.f(), a.f()),
  glStencilFunc: (_c, a) => g().stencilFunc(a.i(), a.i(), a.i()), glStencilOp: (_c, a) => g().stencilOp(a.i(), a.i(), a.i()), glStencilMask: (_c, a) => g().stencilMask(a.i()),
  glCullFace: (_c, a) => g().cullFace(a.i()), glFrontFace: (_c, a) => g().frontFace(a.i()),
  glPolygonOffset: (_c, a) => g().polygonOffset(a.f(), a.f()), glLineWidth: (_c, a) => g().lineWidth(a.f()),
  glSampleCoverage: (_c, a) => g().sampleCoverage(a.f(), !!(a.i() & 255)),
  glCopyTexImage2D: (_c, a) => { const t = a.i(), l = a.i(); forgetImages(t, (level) => level === l); g().copyTexImage2D(t, l, a.i(), a.i(), a.i(), a.i(), a.i(), a.i()); },
  glCopyTexSubImage2D: (_c, a) => g().copyTexSubImage2D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
};
const draw = (): ContextState => { perf.glDraws++; return prepareDraw(); };

export function gles3Init(): void {
  if (gles3Procs.glClear) return;
  const G: Record<string, HostFn> = {
    ...glCommon,
    // ── strings, state queries, errors
    glGetString: keepsClean((_c, a) => cstr(str(a.i()))),
    glGetStringi: keepsClean((_c, a) => { const n = a.i(), i = a.i(); return cstr(n === 0x1f03 ? gles3Extensions(g())[i] ?? "" : ""); }),
    glGetIntegeri_v: (_c, a) => { const t = a.i(), i = a.i(); out(g().getIndexedParameter(t, i), a.p(), st32, 4); },
    glGetInteger64i_v: (_c, a) => { const t = a.i(), i = a.i(); out(g().getIndexedParameter(t, i), a.p(), st64, 8); },
    glGetInternalformativ: (_c, a) => {
      const t = a.i(), f = a.i(), pn = a.i(), size = a.i(), p = a.p();
      if (size < 0) { raise(0x501); return; }
      const values: unknown = g().getInternalformatParameter(t, f, pn === 0x9380 ? 0x80a9 : pn);
      if (!(values instanceof Int32Array) || !size) return;
      if (pn === 0x9380) mem.st32(p, values.length);
      else for (let i = 0; i < Math.min(size, values.length); i++) mem.st32(p + i * 4, values[i]);
    },
    glGetShaderPrecisionFormat: (_c, a) => {
      const f = g().getShaderPrecisionFormat(a.i(), a.i()), range = a.p(), prec = a.p();
      if (f) { mem.st32(range, f.rangeMin); mem.st32(range + 4, f.rangeMax); mem.st32(prec, f.precision); }
    },
    glGetError: keepsClean(() => takeError()),
    glIsEnabled: (_c, a) => (g().isEnabled(a.i()) ? 1 : 0),
    glEnable: (_c, a) => g().enable(a.i()), glDisable: (_c, a) => g().disable(a.i()),
    glHint: (_c, a) => g().hint(a.i(), a.i()),
    glClearBufferfv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferfv(b, d, f32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferiv(b, d, i32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferuiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferuiv(b, d, u32(a.p(), 4)); },
    glClearBufferfi: (_c, a) => g().clearBufferfi(a.i(), a.i(), a.f(), a.i()),
    glStencilFuncSeparate: (_c, a) => g().stencilFuncSeparate(a.i(), a.i(), a.i(), a.i()), glStencilOpSeparate: (_c, a) => g().stencilOpSeparate(a.i(), a.i(), a.i(), a.i()),
    glStencilMaskSeparate: (_c, a) => g().stencilMaskSeparate(a.i(), a.i()),
    glPixelStorei: keepsClean((_c, a) => { const pn = a.i(), v = a.i(); if (!pixelStoreAccepted(pn, v)) unsure(); pixelStore(g(), pn, v); }),

    // ── shaders and programs
    glCreateShader: (_c, a) => { const s = g().createShader(a.i()); return s ? put(T().shaders, s) : 0; },
    glDeleteShader: keepsClean((_c, a) => { const h = a.i(), s = T().shaders[h]; if (s) { g().deleteShader(s); T().shaders[h] = null; } }),
    glIsShader: keepsClean((_c, a) => (H(T().shaders, a.i()) ? 1 : 0)),
    glShaderSource: (_c, a) => {
      const handle = a.i(), s = H(T().shaders, handle); const n = a.i(), pp = a.p(), lp = a.p();
      let src = "";
      for (let i = 0; i < n; i++) {
        const p = ldp(pp + i * PTR), len = lp ? mem.ld32(lp + 4 * i) : -1;
        src += len < 0 ? mem.cstr(p) : utf8.dec.decode(mem.bytes(p, len));
      }
      if (s) {
        const rewrite = rewriteTextureSwizzles(externalSamplersAs2D(s, src), handle);
        shaderRecs.set(s, { original: src, rewrite });
        if (rewrite.unsupported.length) calledMissing.add("gles3:texture swizzle shader transform");
        g().shaderSource(s, rewrite.source);
      }
    },
    glCompileShader: (_c, a) => { const s = H(T().shaders, a.i()); if (s) g().compileShader(s); },
    glGetShaderiv: (_c, a) => { const s = H(T().shaders, a.i()), pn = a.i(); out(s ? shaderParam(s, pn) : 0, a.p(), st32, 4); },
    glGetShaderInfoLog: (_c, a) => { const s = H(T().shaders, a.i()); outStr((s && g().getShaderInfoLog(s)) ?? "", a.i(), a.p(), a.p()); },
    glGetShaderSource: (_c, a) => { const s = H(T().shaders, a.i()); outStr((s && (shaderRecs.get(s)?.original ?? g().getShaderSource(s))) ?? "", a.i(), a.p(), a.p()); },
    glReleaseShaderCompiler: () => {},
    glShaderBinary: () => { raise(0x500); },                                       // INVALID_ENUM: no binary formats
    glCreateProgram: () => { const p = g().createProgram(); return p ? put(T().programs, p) : 0; },
    glDeleteProgram: keepsClean((_c, a) => { const h = a.i(), p = T().programs[h]; if (p) { g().deleteProgram(p); T().programs[h] = null; } }),
    glIsProgram: keepsClean((_c, a) => (H(T().programs, a.i()) ? 1 : 0)),
    glAttachShader: (_c, a) => { const p = H(T().programs, a.i()), s = H(T().shaders, a.i()); if (p && s) g().attachShader(p, s); },
    glDetachShader: (_c, a) => { const p = H(T().programs, a.i()), s = H(T().shaders, a.i()); if (p && s) g().detachShader(p, s); },
    glLinkProgram: (_c, a) => { const p = H(T().programs, a.i()); if (p) linkProgram(p); },
    glUseProgram: (_c, a) => { const p = H(T().programs, a.i()); g().useProgram(p); contextState().program = p; },
    glValidateProgram: (_c, a) => { const p = H(T().programs, a.i()); if (p) g().validateProgram(p); },
    glGetProgramiv: (_c, a) => { const p = H(T().programs, a.i()), pn = a.i(); out(p ? progParam(p, pn) : 0, a.p(), st32, 4); },
    glGetProgramInfoLog: (_c, a) => { const p = H(T().programs, a.i()); outStr((p && g().getProgramInfoLog(p)) ?? "", a.i(), a.p(), a.p()); },
    glProgramParameteri: () => {},
    glGetProgramBinary: (_c, a) => { a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 0); raise(0x502); },  // INVALID_OPERATION
    glProgramBinary: () => { raise(0x500); },
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
    glGetUniformLocation: (_c, a) => {
      const p = H(T().programs, a.i()), name = a.str();
      if (!p) return -1;
      let handles = uniformHandles.get(p), h = handles?.get(name);
      if (h !== undefined) return h;
      if (!handles) uniformHandles.set(p, handles = new Map());
      handles.set(name, h = uniformLocation(p, name));
      return h;
    },
    glGetActiveAttrib: active((p, i) => g().getActiveAttrib(p, i)),
    glGetActiveUniform: active((p, i) => { const rec = programRecs.get(p); return activeUniformInfo(g(), p, rec ? rec.uniforms.infos[i] ?? null : g().getActiveUniform(p, i)); }),
    glGetTransformFeedbackVarying: active((p, i) => g().getTransformFeedbackVarying(p, i)),
    glGetUniformBlockIndex: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getUniformBlockIndex(p, a.str()) : 0xffffffff; },
    glUniformBlockBinding: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(), b = a.i(); if (p) g().uniformBlockBinding(p, i, b); },
    glGetActiveUniformBlockiv: (_c, a) => {
      const p = H(T().programs, a.i()); const i = a.i(), pn = a.i(), rec = p && programRecs.get(p);
      let value = p && (pn === 0x8a41 ? (g().getActiveUniformBlockName(p, i)?.length ?? 0) + 1 : g().getActiveUniformBlockParameter(p, i, pn));
      if (pn === 0x8a43 && rec && value && typeof value === "object" && "length" in value) {
        value = Uint32Array.from(value as ArrayLike<number>, (web) => rec.uniforms.webToGuest[web] >= 0 ? rec.uniforms.webToGuest[web] : 0xffffffff);
      }
      out(value, a.p(), st32, 4);
    },
    glGetActiveUniformBlockName: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(); outStr((p && g().getActiveUniformBlockName(p, i)) ?? "", a.i(), a.p(), a.p()); },
    glGetUniformIndices: (_c, a) => {
      const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(), rec = p && programRecs.get(p);
      let value = p && g().getUniformIndices(p, names(pp, n));
      if (rec && value) value = Array.from(value, (web) => web === 0xffffffff || rec.uniforms.webToGuest[web] < 0 ? 0xffffffff : rec.uniforms.webToGuest[web]);
      out(value, a.p(), st32, 4);
    },
    glGetActiveUniformsiv: (_c, a) => {
      const p = H(T().programs, a.i()); const n = a.i(), ip = a.p(), pn = a.i(), rec = p && programRecs.get(p);
      const indices = Array.from(u32(ip, n), (guest) => rec ? rec.uniforms.guestToWeb[guest] ?? 0xffffffff : guest);
      let value = p && g().getActiveUniforms(p, indices, pn);
      if (p && value && pn === 0x8a37) value = Array.from(value as number[], (type, i) => type === 0x8b5e ? activeUniformInfo(g(), p, g().getActiveUniform(p, indices[i]))!.type : type); // UNIFORM_TYPE
      out(value, a.p(), st32, 4);
    },
    glTransformFeedbackVaryings: (_c, a) => { const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(), mode = a.i(); if (p) g().transformFeedbackVaryings(p, names(pp, n), mode); },

    // ── buffers
    glGenBuffers: keepsClean((_c, a) => { const n = a.i(); gen(T().buffers, n, a.p(), () => { const o = {} as WebGLBuffer; recOf.set(o, { gl: null, other: null, elem: null, shadow: null, mirror: null, usage: 0x88e4, size: 0 }); return o; }); }),
    glDeleteBuffers: keepsClean((_c, a) => {
      const n = a.i(), state = contextState();
      del(T().buffers, n, a.p(), (o) => {
        const r = recOf.get(o);
        if (!r) return;
        if (r.gl) g().deleteBuffer(r.gl);
        if (r.other) g().deleteBuffer(r.other);
        // as in GL, only this context's bindings and its current vertex array's element binding reset
        for (const [t, b] of state.buffers) if (b === r) state.buffers.set(t, null);
        if (state.elements.get(state.vao) === r) state.elements.set(state.vao, null);
      });
    }),
    glIsBuffer: keepsClean((_c, a) => (H(T().buffers, a.i()) ? 1 : 0)),
    glBindBuffer: keepsClean((_c, a) => {
      const t = a.i(), h = a.i();
      const r = rec(h);
      if (!BUFFER_TARGETS.has(t) || contextState().feedback) unsure();
      bindRec(t, r);
      if (t === COPY_READ || t === COPY_WRITE) return;
      g().bindBuffer(t, realize(t, r, h));
    }),
    glBindBufferBase: (_c, a) => { const t = a.i(), i = a.i(), h = a.i(), r = rec(h); bindRec(t, r); g().bindBufferBase(t, i, realize(t, r, h)); },
    glBindBufferRange: (_c, a) => { const t = a.i(), i = a.i(), h = a.i(), r = rec(h); bindRec(t, r); const gl = realize(t, r, h); g().bindBufferRange(t, i, gl, a.i(), a.i()); },
    glBufferData: keepsClean((_c, a) => {
      const t = a.i(), n = a.i(), p = a.p(), usage = a.i(), r = shadowed(t), bound = recAt(t), data = p ? u8(p, n) : null;
      const accepted = BUFFER_TARGETS.has(t) && !!bound && n >= 0 && USAGES.has(usage) && !contextState().feedback;
      if (!accepted) unsure();
      if (bound) { bound.size = accepted ? data?.length ?? n : -1; if (bound.mirror) bound.mirror = data ? data.slice() : new Uint8Array(n); }
      if (r) { r.shadow = new Uint8Array(n); if (data) r.shadow.set(data); r.usage = usage; }
      else { if (bound) bound.usage = usage; writeBuffers(t, (tt) => { if (data) g().bufferData(tt, data, usage); else g().bufferData(tt, n, usage); }); }
    }),
    glBufferSubData: keepsClean((_c, a) => {
      const t = a.i(), off = a.i(), n = a.i(), p = a.p(), r = recAt(t), data = u8(p, n);
      if (!BUFFER_TARGETS.has(t) || !r || r.size < 0 || off < 0 || n < 0 || off + data.length > r.size || contextState().feedback) unsure();
      writeBack(t, off, data);
    }),
    glCopyBufferSubData: (_c, a) => {
      const rt = a.i(), wt = a.i(), roff = a.i(), woff = a.i(), n = a.i(), rs = shadowed(rt);
      const src = rs ? rs.shadow!.subarray(roff, roff + n) : withTarget(rt, (tt) => { const d = new Uint8Array(n); g().getBufferSubData(tt, roff, d); return d; });
      writeBack(wt, woff, src);
    },
    // a mapping is a guest copy of the range: read in on map, written back on unmap or flush
    glMapBufferRange: (_c, a) => {
      const t = a.i(), off = a.i(), len = a.i(), access = a.i(), b = recAt(t);
      if (!b) { raise(0x502); return 0; }
      const ptr = mem.malloc(len);
      // a range read, or written without MAP_INVALIDATE_{RANGE,BUFFER}_BIT, holds the contents the guest leaves unwritten
      if (access & 1 || !(access & 0xc)) u8(ptr, len).set(contents(t, b).subarray(off, off + len));
      mapped.set(b, { ptr, off, len, access });
      return ptr;
    },
    glFlushMappedBufferRange: (_c, a) => { const t = a.i(), b = recAt(t), m = b && mapped.get(b), off = a.i(), len = a.i(); if (m) writeBack(t, m.off + off, u8(m.ptr + off, len)); },
    glUnmapBuffer: (_c, a) => {
      const t = a.i(), b = recAt(t), m = b && mapped.get(b);
      if (!b || !m) return 0;
      mapped.delete(b);
      if ((m.access & 2) && !(m.access & 0x10)) writeBack(t, m.off, u8(m.ptr, m.len));   // MAP_WRITE_BIT without MAP_FLUSH_EXPLICIT_BIT
      mem.free(m.ptr);
      return 1;
    },
    glGetBufferPointerv: (_c, a) => { const t = a.i(); a.i(); const b = recAt(t); stp(a.p(), (b && mapped.get(b)?.ptr) || 0); },

    // ── vertex arrays and attributes
    glBindVertexArray: (_c, a) => { const vao = H(T().vaos, a.i()); g().bindVertexArray(vao); contextState().vao = vao; },
    glEnableVertexAttribArray: (_c, a) => { const i = a.i(), state = contextState(); g().enableVertexAttribArray(i); if (!state.vao && i < state.enabled.length) state.enabled[i] = 1; },
    glDisableVertexAttribArray: (_c, a) => { const i = a.i(), state = contextState(); g().disableVertexAttribArray(i); if (!state.vao && i < state.enabled.length) state.enabled[i] = 0; },
    glVertexAttribPointer: (_c, a) => vertexAttribPointer(false, a.i(), a.i(), a.i(), !!(a.i() & 255), a.i(), a.p()),
    glVertexAttribIPointer: (_c, a) => vertexAttribPointer(true, a.i(), a.i(), a.i(), false, a.i(), a.p()),
    glVertexAttribDivisor: (_c, a) => { const i = a.i(), d = a.u(), state = contextState(); g().vertexAttribDivisor(i, d); if (!state.vao && i < state.divisors.length) state.divisors[i] = d; },
    glVertexAttrib1f: (_c, a) => g().vertexAttrib1f(a.i(), a.f()), glVertexAttrib2f: (_c, a) => g().vertexAttrib2f(a.i(), a.f(), a.f()),
    glVertexAttrib3f: (_c, a) => g().vertexAttrib3f(a.i(), a.f(), a.f(), a.f()), glVertexAttrib4f: (_c, a) => g().vertexAttrib4f(a.i(), a.f(), a.f(), a.f(), a.f()),
    glVertexAttrib1fv: (_c, a) => g().vertexAttrib1fv(a.i(), f32(a.p(), 1)), glVertexAttrib2fv: (_c, a) => g().vertexAttrib2fv(a.i(), f32(a.p(), 2)),
    glVertexAttrib3fv: (_c, a) => g().vertexAttrib3fv(a.i(), f32(a.p(), 3)), glVertexAttrib4fv: (_c, a) => g().vertexAttrib4fv(a.i(), f32(a.p(), 4)),
    glVertexAttribI4i: (_c, a) => g().vertexAttribI4i(a.i(), a.i(), a.i(), a.i(), a.i()), glVertexAttribI4ui: (_c, a) => g().vertexAttribI4ui(a.i(), a.u(), a.u(), a.u(), a.u()),
    glVertexAttribI4iv: (_c, a) => g().vertexAttribI4iv(a.i(), i32(a.p(), 4)), glVertexAttribI4uiv: (_c, a) => g().vertexAttribI4uiv(a.i(), u32(a.p(), 4)),
    glGetVertexAttribPointerv: (_c, a) => {
      const i = a.i(), pn = a.i(), client = pn === 0x8645 && clientArray(contextState(), i);
      stp(a.p(), client ? client.ptr : g().getVertexAttribOffset(i, pn));
    },

    // ── draws
    // the default vertex array's client arrays are all that needs more than the WebGL call
    glDrawArrays: (_c, a) => {
      const mode = a.i(), first = a.i(), count = a.i(), state = draw();
      if (!state.vao && state.clients.size) drawClientArrays(state, first, count, 1);
      g().drawArrays(mode, first, count);
    },
    glDrawArraysInstanced: (_c, a) => {
      const mode = a.i(), first = a.i(), count = a.i(), n = a.i(), state = draw();
      if (!state.vao && state.clients.size) drawClientArrays(state, first, count, n);
      g().drawArraysInstanced(mode, first, count, n);
    },
    glDrawElements: (_c, a) => {
      const mode = a.i(), count = a.i(), type = a.i(), p = a.p(), state = draw();
      if (state.vao || (state.elements.get(null) && !state.clients.size)) g().drawElements(mode, count, type, p);
      else drawClientElements(state, count, type, p, 1, null, (at) => g().drawElements(mode, count, type, at));
    },
    glDrawElementsInstanced: (_c, a) => {
      const mode = a.i(), count = a.i(), type = a.i(), p = a.p(), n = a.i(), state = draw();
      if (state.vao || (state.elements.get(null) && !state.clients.size)) g().drawElementsInstanced(mode, count, type, p, n);
      else drawClientElements(state, count, type, p, n, null, (at) => g().drawElementsInstanced(mode, count, type, at, n));
    },
    glDrawRangeElements: (_c, a) => {
      const mode = a.i(), start = a.i(), end = a.i(), count = a.i(), type = a.i(), p = a.p(), state = draw();
      if (state.vao || (state.elements.get(null) && !state.clients.size)) g().drawRangeElements(mode, start, end, count, type, p);
      else drawClientElements(state, count, type, p, 1, [start, end], (at) => g().drawRangeElements(mode, start, end, count, type, at));
    },

    // ── textures and samplers
    glActiveTexture: keepsClean((_c, a) => {
      const texture = a.i(), state = contextState();
      g().activeTexture(texture);
      if (texture >= TEXTURE0 && texture < TEXTURE0 + state.limits[0]) state.activeUnit = texture - TEXTURE0; else unsure();
    }),
    glGenTextures: keepsClean((_c, a) => { const n = a.i(); gen(T().textures, n, a.p(), () => { const texture = g().createTexture(); if (texture) textureRec(texture).tracking = UNBOUND; return texture; }); }),
    glDeleteTextures: keepsClean((_c, a) => {
      const n = a.i(), p = a.p(), state = contextState();
      del(T().textures, n, p, (texture) => dropTexture(state, texture));
      state.revision++;
    }),
    glIsTexture: keepsClean((_c, a) => (H(T().textures, a.i()) ? 1 : 0)),
    glBindTexture: keepsClean((_c, a) => bindTexture(a.i(), a.i())),
    glTexImage2D: keepsClean((_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), b = a.i(), fmt = a.i(), ty = a.i(), p = a.p();
      const images = imageAccepted(t, l, f, w, h, b, fmt, ty, p);
      if (images) recordImage(images, t, l, { width: w, height: h, internal: f, format: fmt, type: ty }); else untrust(textureOf(t));
      (g().texImage2D as Function)(t, l, f, w, h, b, fmt, ty, texData(ty, p, fmt, [w, h]));
    }),
    glTexSubImage2D: keepsClean((_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), fmt = a.i(), ty = a.i(), p = a.p();
      if (!subImageAccepted(t, l, x, y, w, h, fmt, ty, p)) unsure();
      (g().texSubImage2D as Function)(t, l, x, y, w, h, fmt, ty, texData(ty, p, fmt, [w, h]));
    }),
    glTexImage3D: (_c, a) => { const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(), b = a.i(), fmt = a.i(), ty = a.i(); (g().texImage3D as Function)(t, l, f, w, h, d, b, fmt, ty, texData(ty, a.p(), fmt, [w, h, d])); },
    glTexSubImage3D: (_c, a) => { const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), fmt = a.i(), ty = a.i(); (g().texSubImage3D as Function)(t, l, x, y, z, w, h, d, fmt, ty, texData(ty, a.p(), fmt, [w, h, d])); },
    glCompressedTexImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(); a.i(); const n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      forgetImages(t, (level) => level === l);
      if (pbo(UNPACK)) gl.compressedTexImage2D(t, l, f, w, h, 0, n, p); else gl.compressedTexImage2D(t, l, f, w, h, 0, u8(p, n));
    },
    glCompressedTexSubImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), f = a.i(), n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexSubImage2D(t, l, x, y, w, h, f, n, p); else gl.compressedTexSubImage2D(t, l, x, y, w, h, f, u8(p, n));
    },
    glCompressedTexImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(); a.i(); const n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexImage3D(t, l, f, w, h, d, 0, n, p); else gl.compressedTexImage3D(t, l, f, w, h, d, 0, u8(p, n));
    },
    glCompressedTexSubImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), f = a.i(), n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, n, p); else gl.compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, u8(p, n));
    },
    glTexStorage2D: keepsClean((_c, a) => {
      const target = a.i(), levels = a.i(), format = a.i(), width = a.i(), height = a.i(), gl = glForTextureFormat(format);
      const bound = storageAccepted(target, levels, format, width, height);
      if (bound) bound.storage = { immutable: true, format, width, height, levels }; else untrust(target);
      gl.texStorage2D(target, levels, format, width, height);
    }),
    glTexStorage3D: (_c, a) => {
      const target = a.i(), levels = a.i(), format = a.i(), width = a.i(), height = a.i(), depth = a.i(), gl = glForTextureFormat(format);
      gl.texStorage3D(target, levels, format, width, height, depth);
    },
    // GL_OES_EGL_image: the bound texture takes the image's buffer as its storage. WebGL textures share no storage, so
    // the name comes to stand for the buffer's own texture, with the parameters the name had
    glEGLImageTargetTexture2DOES: (_c, a) => {
      const target = a.i(), buffer = imageBuffer(a.p()), gl = g(), state = contextState();
      if (target !== 0x0de1 && target !== 0x8d65) { raise(0x500); return; }
      if (!buffer) { raise(0x501); return; }
      const old = boundTexture(state, state.activeUnit, 0x0de1), name = old ? T().ids.get(old) : undefined;
      if (!old || !name) { raise(0x502); return; }
      const ints = TEXTURE_INTS.map((pn) => gl.getTexParameter(0x0de1, pn) as number), floats = TEXTURE_FLOATS.map((pn) => gl.getTexParameter(0x0de1, pn) as number);
      const texture = bufferTexture(buffer, gl);
      if (!texture) { gl.bindTexture(0x0de1, old); raise(0x505); return; }
      if (texture === old) return;
      TEXTURE_INTS.forEach((pn, i) => gl.texParameteri(0x0de1, pn, ints[i]));
      TEXTURE_FLOATS.forEach((pn, i) => gl.texParameterf(0x0de1, pn, floats[i]));
      const was = textureRec(old), rec = textureRec(texture);
      rec.channels = [...was.channels]; rec.code = was.code;
      rec.tracking = { kind: "bound", target: 0x0de1, storage: { immutable: true, format: buffer.internalFormat, width: buffer.width, height: buffer.height, levels: buffer.levels } };
      T().textures[name] = texture; T().ids.set(texture, name);
      dropTexture(state, old);
      gl.bindTexture(0x0de1, texture);
      let unit = state.bindings.get(state.activeUnit);
      if (!unit) state.bindings.set(state.activeUnit, unit = new Map());
      unit.set(0x0de1, texture);
      state.revision++;
    },
    glCopyTexSubImage3D: (_c, a) => g().copyTexSubImage3D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glGenerateMipmap: (_c, a) => { const t = a.i(); for (const face of t === 0x8513 ? [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a] : [t]) forgetImages(face, (level) => level > 0); g().generateMipmap(t); },
    glBindSampler: (_c, a) => g().bindSampler(a.i(), H(T().samplers, a.i())),

    // ── framebuffers and renderbuffers
    glBindFramebuffer: (_c, a) => g().bindFramebuffer(a.i(), H(T().fbos, a.i())),
    glFramebufferTexture2D: (_c, a) => g().framebufferTexture2D(a.i(), a.i(), textureTarget(a.i()), H(T().textures, a.i()), a.i()),
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
      if (pbo(PACK)) { g().readPixels(x, y, w, h, f, ty, p); syncVertexBuffer(recAt(PACK)); } else readGuestPixels(g(), x, y, w, h, f, ty, p);
    },
    glBindRenderbuffer: keepsClean((_c, a) => {
      const t = a.i(), rbo = H(T().rbos, a.i());
      if (t === 0x8d41) contextState().renderbuffer = rbo; else unsure();
      g().bindRenderbuffer(t, rbo);
    }),
    glRenderbufferStorage: keepsClean((_c, a) => {
      const t = a.i(), f = a.i(), w = a.i(), h = a.i(), state = contextState(), max = state.limits[3];
      if (t !== 0x8d41 || !state.renderbuffer || !RENDERBUFFER_FORMATS.has(f) || w < 0 || h < 0 || w > max || h > max) unsure();
      g().renderbufferStorage(t, f, w, h);
    }),
    glRenderbufferStorageMultisample: (_c, a) => g().renderbufferStorageMultisample(a.i(), a.i(), a.i(), a.i(), a.i()),
    glGetRenderbufferParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getRenderbufferParameter(t, pn), a.p(), st32, 4); },

    // ── queries, sync, transform feedback
    glBeginQuery: (_c, a) => { const t = a.i(), q = H(T().queries, a.i()); if (q) g().beginQuery(t, q); },
    glEndQuery: (_c, a) => g().endQuery(a.i()),
    glGetQueryiv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getQuery(t, pn), a.p(), st32, 4); },
    glGetQueryObjectuiv: (_c, a) => { const q = H(T().queries, a.i()); const pn = a.i(); out(q && g().getQueryParameter(q, pn), a.p(), st32, 4); },
    glFenceSync: keepsClean((_c, a) => { const condition = a.i(), flags = a.i(); if (condition !== 0x9117 || flags) unsure(); return put(T().syncs, g().fenceSync(condition, flags)); }),
    glIsSync: keepsClean((_c, a) => (H(T().syncs, a.i()) ? 1 : 0)),
    glDeleteSync: keepsClean((_c, a) => { const h = a.i(), s = T().syncs[h]; if (s) { g().deleteSync(s); T().syncs[h] = null; } }),
    glWaitSync: keepsClean((_c, a) => { const s = H(T().syncs, a.i()); if (s) g().waitSync(s, 0, -1); }),
    glClientWaitSync: (_c, a) => { const s = H(T().syncs, a.i()), flags = a.i(), timeout = a.ul(); return s ? clientWait(g(), s, flags, timeout) : 0x911d; },   // WAIT_FAILED
    glGetSynciv: (_c, a) => { const s = H(T().syncs, a.i()); const pn = a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 1); out(s && g().getSyncParameter(s, pn), a.p(), st32, 4); },
    glBindTransformFeedback: (_c, a) => g().bindTransformFeedback(a.i(), H(T().tfs, a.i())),
    glBeginTransformFeedback: (_c, a) => { contextState().feedback = true; g().beginTransformFeedback(a.i()); }, glEndTransformFeedback: () => { g().endTransformFeedback(); syncFeedback(); },
    glPauseTransformFeedback: () => { g().pauseTransformFeedback(); syncFeedback(); }, glResumeTransformFeedback: () => g().resumeTransformFeedback(),
  };
  const objects = [["VertexArray", "VertexArrays", "vaos", "createVertexArray", "deleteVertexArray"], ["Sampler", "Samplers", "samplers", "createSampler", "deleteSampler"],
    ["Framebuffer", "Framebuffers", "fbos", "createFramebuffer", "deleteFramebuffer"], ["Renderbuffer", "Renderbuffers", "rbos", "createRenderbuffer", "deleteRenderbuffer"],
    ["Query", "Queries", "queries", "createQuery", "deleteQuery"], ["TransformFeedback", "TransformFeedbacks", "tfs", "createTransformFeedback", "deleteTransformFeedback"]] as const;
  for (const [one, many, key, create, remove] of objects) {
    // glGen and glDelete pass only this context's objects; deleting an active transform feedback
    // is an error, which is left to WebGL
    const remover: HostFn = (_c, a) => { const n = a.i(); del(T()[key], n, a.p(), (o) => g()[remove](o)); };
    G[`glGen${many}`] = keepsClean((_c, a) => { const n = a.i(); gen(T()[key], n, a.p(), () => g()[create]()); });
    G[`glDelete${many}`] = one === "TransformFeedback" ? remover : keepsClean(remover);
    G[`glIs${one}`] = keepsClean((_c, a) => (H(T()[key], a.i()) ? 1 : 0));
  }
  G.glDeleteRenderbuffers = keepsClean((_c, a) => { const n = a.i(); del(T().rbos, n, a.p(), (o: WebGLRenderbuffer) => g().deleteRenderbuffer(o)); contextState().renderbuffer = undefined; });
  G.glDeleteVertexArrays = keepsClean((_c, a) => {
    const n = a.i(), state = contextState();
    // deleting the bound vertex array rebinds the default one, with its element binding
    del(T().vaos, n, a.p(), (vao: WebGLVertexArrayObject) => { g().deleteVertexArray(vao); state.elements.delete(vao); if (state.vao === vao) state.vao = null; });
  });
  for (const [s, st, bpe] of [["Integer", st32, 4], ["Integer64", st64, 8], ["Float", stf, 4], ["Boolean", st8, 1]] as const) G[`glGet${s}v`] = (_c, a) => { const n = a.i(); out(param(n), a.p(), st, bpe); };
  for (const [s, st, bpe] of [["iv", st32, 4], ["i64v", st64, 8]] as const) {
    G[`glGetBufferParameter${s}`] = (_c, a) => { const t = a.i(), pn = a.i(), r = shadowed(t); out(r ? (pn === 0x8765 ? r.usage : r.shadow!.length) : withTarget(t, (tt) => g().getBufferParameter(tt, pn)), a.p(), st, bpe); };
  }
  for (const [s, st] of [["iv", st32], ["fv", stf]] as const) {
    G[`glGetTexParameter${s}`] = (_c, a) => { const t = textureTarget(a.i()), pn = a.i(); out(texParameter(t, pn), a.p(), st, 4); };
    G[`glGetSamplerParameter${s}`] = (_c, a) => { const smp = H(T().samplers, a.i()); const pn = a.i(); out(smp && g().getSamplerParameter(smp, pn), a.p(), st, 4); };
  }
  for (const [s, st] of [["f", stf], ["i", st32], ["ui", st32]] as const) G[`glGetUniform${s}v`] = (_c, a) => { const p = H(T().programs, a.i()), u = U(a.i()); out(p && u && g().getUniform(p, u), a.p(), st, 4); };
  for (const [s, st] of [["fv", stf], ["iv", st32], ["Iiv", st32], ["Iuiv", st32]] as const) G[`glGetVertexAttrib${s}`] = (_c, a) => {
    const i = a.i(), pn = a.i();
    // a client array's attribute reads a stream buffer in WebGL, and none in GL
    out(pn === 0x889f && clientArray(contextState(), i) ? 0 : g().getVertexAttrib(i, pn), a.p(), st, 4);
  };
  const I = (a: ArgReader) => a.i(), LD = (a: ArgReader) => mem.ld32(a.p()), F = (a: ArgReader) => a.f(), LDF = (a: ArgReader) => mem.ldf32(a.p());
  for (const [s, read, int] of [["i", I, true], ["f", F, false], ["iv", LD, true], ["fv", LDF, false]] as const) {
    G[`glTexParameter${s}`] = keepsClean((_c, a) => { const t = textureTarget(a.i()), pn = a.i(); (int ? texParam : texParamf)(t, pn, read(a)); });
    G[`glSamplerParameter${s}`] = (_c, a) => { const smp = H(T().samplers, a.i()); const pn = a.i(), v = read(a); if (smp) { if (int) g().samplerParameteri(smp, pn, v); else g().samplerParameterf(smp, pn, v); } };
  }
  // ── uniforms: glUniform{1..4}{f,i,ui}[v] and the nine matrix shapes, each a function of its own that calls its WebGL method itself:
  // draws call them often, and one closure for all would leave the engine a call it cannot inline
  const named = (name: string, scope: Record<string, unknown>, body: string): HostFn =>
    new Function(...Object.keys(scope), `"use strict";return function ${name}(_c,a){${body}}`)(...Object.values(scope)) as HostFn;
  const reads = { f: "f", i: "i", ui: "u" }, views = { f: f32, i: i32, ui: u32 };
  for (let n = 1; n <= 4; n++) for (const k of ["f", "i", "ui"] as const) {
    const xs = ["x", "y", "z", "w"].slice(0, n), sampler = n === 1 && k === "i", scope = { U, g, samplerSlots, setSamplerUnits, view: views[k] };
    G[`glUniform${n}${k}`] = named(`glUniform${n}${k}`, scope, `const u=U(a.i())${xs.map((x) => `,${x}=a.${reads[k]}()`).join("")};if(u===null)return;
      g().uniform${n}${k}(u,${xs});${sampler ? "if(samplerSlots.has(u))setSamplerUnits(u,[x]);" : ""}`);
    G[`glUniform${n}${k}v`] = named(`glUniform${n}${k}v`, scope, `const u=U(a.i()),cnt=a.i(),p=a.p();if(u===null)return;
      const values=view(p,cnt*${n});g().uniform${n}${k}v(u,values);${sampler ? "setSamplerUnits(u,values);" : ""}`);
  }
  for (const [m, e] of [["2", 4], ["3", 9], ["4", 16], ["2x3", 6], ["3x2", 6], ["2x4", 8], ["4x2", 8], ["3x4", 12], ["4x3", 12]] as const)
    G[`glUniformMatrix${m}fv`] = named(`glUniformMatrix${m}fv`, { U, g, f32 },
      `const u=U(a.i()),cnt=a.i(),t=!!(a.i()&255),p=a.p();if(u!==null)g().uniformMatrix${m}fv(u,t,f32(p,cnt*${e}))`);
  for (const [name, fn] of Object.entries(G)) G[name] = entry(name, fn, keptClean(fn) ? undefined : unsure);
  // the probe: after each entry point, count and name a GL error
  if (glProbe) for (const [k, f] of Object.entries(G)) {
    if (k === "glGetError") continue;
    G[k] = (c, a) => {
      const args = `(${c.w[0] >>> 0},${c.w[2] >>> 0},${c.w[4] >>> 0})`;   // read before f consumes them
      const r = f(c, a), e = current?.getError();
      if (e) { perf.glErrors++; console.warn("[gl] 0x" + e.toString(16), "after", k + args); }
      return r;
    };
  }
  gles3Procs = G;
  hostLib("libGLESv2.so", G, { closed: true });
  hostLib("libGLESv3.so", G, { closed: true });
}
// MIN/MAG_FILTER, WRAP_S/T/R, COMPARE_MODE/FUNC, BASE/MAX_LEVEL; MIN/MAX_LOD
const TEXTURE_INTS = [0x2801, 0x2800, 0x2802, 0x2803, 0x8072, 0x884c, 0x884d, 0x813c, 0x813d], TEXTURE_FLOATS = [0x813a, 0x813b];
/** a texture no name stands for any more: deleted, or, a buffer's, which lives on with the buffer, unbound from the context's units */
function dropTexture(state: ContextState, texture: WebGLTexture): void {
  const gl = g(), active = TEXTURE0 + state.activeUnit, owned = ownsTexture(texture);
  for (const [unit, targets] of state.bindings) for (const [target, bound] of targets) {
    if (bound !== texture) continue;
    if (owned) { gl.activeTexture(TEXTURE0 + unit); gl.bindTexture(target, null); }
    targets.set(target, null);
  }
  if (owned) gl.activeTexture(active);
  else { textureRec(texture).deleted = true; gl.deleteTexture(texture); }
}
/** glBindTexture in the current context */
export function bindTexture(name: number, handle: number): void {
  const target = textureTarget(name), texture = H(T().textures, handle), state = contextState();
  g().bindTexture(target, texture);
  const rec = texture && texRecs.get(texture), tracking = rec && rec.tracking;
  let unit = state.bindings.get(state.activeUnit);
  if (!unit) { unit = new Map(); state.bindings.set(state.activeUnit, unit); }
  // a texture takes its target at its first bind; WebGL refuses another one
  if (!TEXTURE_TARGETS.has(target) || texture && (!rec || rec.deleted || tracking!.kind === "unknown" || tracking!.kind === "bound" && tracking!.target !== target)) {
    unsure();
    if (unit.delete(target)) state.revision++;
    return;
  }
  if (rec && tracking!.kind === "unbound") rec.tracking = { kind: "bound", target, storage: { immutable: false, images: new Map() } };
  if (unit.get(target) !== texture) { unit.set(target, texture); state.revision++; }
}
/** glTexImage2D from a host image (a SurfaceTexture's frame, a Bitmap's pixels), recorded as one from guest memory is */
export function texImageSource(t: number, l: number, internal: number, format: number, type: number, src: TexImageSource): void {
  const [w, h] = frameSize(src), images = imageAccepted(t, l, internal, w, h, 0, format, type, 0);
  if (images) recordImage(images, t, l, { width: w, height: h, internal, format, type }); else untrust(textureOf(t));
  g().texImage2D(t, l, internal, format, type, src);
}
export function texSubImageSource(t: number, l: number, x: number, y: number, format: number, type: number, src: TexImageSource): void {
  const [w, h] = frameSize(src);
  if (!subImageAccepted(t, l, x, y, w, h, format, type, 0)) unsure();
  g().texSubImage2D(t, l, x, y, format, type, src);
}

function texParam(t: number, pn: number, v: number): void {
  if (pn >= 0x8e42 && pn <= 0x8e45) { setSwizzle(t, pn, v); return; }
  if (!texParamAccepted(t, pn, v)) unsure();
  g().texParameteri(t, pn, v);
}

function texParamf(t: number, pn: number, v: number): void {
  if (pn >= 0x8e42 && pn <= 0x8e45) { setSwizzle(t, pn, Math.trunc(v)); return; }
  unsure();
  g().texParameterf(t, pn, v);
}

function setSwizzle(target: number, pname: number, value: number): void {
  const selector = value === 0 ? 4 : value === 1 ? 5 : value >= 0x1903 && value <= 0x1906 ? value - 0x1903 : -1;
  if (selector < 0) { raise(0x500); return; }                                     // INVALID_ENUM
  const state = contextState(), texture = boundTexture(state, state.activeUnit, target);
  if (!texture) { raise(0x502); return; }                                         // INVALID_OPERATION
  const rec = textureRec(texture), channel = pname - 0x8e42;
  if (rec.channels[channel] === selector) return;
  rec.channels[channel] = selector;
  rec.code = rec.channels[0] | (rec.channels[1] << 3) | (rec.channels[2] << 6) | (rec.channels[3] << 9);
  state.revision++;
}

function texParameter(target: number, pname: number): unknown {
  if (pname < 0x8e42 || pname > 0x8e45) return g().getTexParameter(target, pname);
  const state = contextState(), texture = boundTexture(state, state.activeUnit, target);
  if (!texture) { raise(0x502); return 0; }
  const selector = textureRec(texture).channels[pname - 0x8e42];
  return selector < 4 ? 0x1903 + selector : selector === 4 ? 0 : 1;
}
