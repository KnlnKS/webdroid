// EGL 1.5 over the shell's surfaces: one display, one config (glview.ts eglConfigAttrib), contexts
// that own the WebGL2 context (glview.ts EglContext), window surfaces from libandroid's
// ANativeWindow handles and pbuffers of their own. Closed: an extension entry point we do not
// implement is NULL from eglGetProcAddress.

import { mem } from "./mem";
import { hostLib, lookupHost, defineHost, probed, cstr, type HostFn } from "./host";
import { EglContext, eglConfigAttrib, type GlSurface } from "../android/glview";
import { windowOf } from "./libandroid";
import { gles1Procs } from "./gles1";
import { gles3Procs } from "./gles3";
import { activateEglCurrent, bindEglCurrent, boundEglCurrent } from "./egl-current";

const EGL_SUCCESS = 0x3000, EGL_BAD_ALLOC = 0x3003, EGL_BAD_CONTEXT = 0x3006, EGL_BAD_MATCH = 0x3009, EGL_BAD_NATIVE_WINDOW = 0x300b, EGL_BAD_SURFACE = 0x300d;
let err = EGL_SUCCESS;
const surfaces: (GlSurface | null)[] = [null], contexts: (EglContext | null)[] = [null];
const procs = new Map<string, number>();
const handle = <T>(tbl: (T | null)[], o: T): number => { const i = tbl.indexOf(o); if (i > 0) return i; tbl.push(o); return tbl.length - 1; };
/** an EGL_NONE-terminated list of EGLint pairs */
function attrs(p: number): Map<number, number> {
  const m = new Map<number, number>();
  if (p) for (let q = p; mem.ld32(q) !== 0x3038; q += 8) m.set(mem.ld32(q), mem.ld32(q + 4));
  return m;
}

export function eglInit(): void {
  const E: Record<string, HostFn> = {
    eglGetDisplay: () => 1, eglGetPlatformDisplay: () => 1,
    eglInitialize: (_c, a) => { a.i(); const ma = a.p(), mi = a.p(); if (ma) mem.st32(ma, 1); if (mi) mem.st32(mi, 5); return 1; },
    eglTerminate: () => 1, eglReleaseThread: (cpu) => { bindEglCurrent(cpu, null); return 1; },
    eglGetError: () => { const e = err; err = EGL_SUCCESS; return e; },
    eglBindAPI: () => 1, eglQueryAPI: () => 0x30a0,
    eglQueryString: (_c, a) => {
      a.i(); const n = a.i();
      return cstr(n === 0x3053 ? "webdroid" : n === 0x3054 ? "1.5" : n === 0x3055 ? "EGL_ANDROID_presentation_time EGL_KHR_create_context EGL_KHR_surfaceless_context" : n === 0x308d ? "OpenGL_ES" : "");
    },
    eglGetConfigs: (_c, a) => { a.i(); const cfgs = a.p(), size = a.i(), num = a.p(); if (cfgs && size > 0) mem.st32(cfgs, 1); if (num) mem.st32(num, 1); return 1; },
    eglChooseConfig: (_c, a) => {
      a.i(); const want = attrs(a.p()), cfgs = a.p(), size = a.i(), num = a.p();
      // the one config matches unless the caller needs what it lacks (multisampling)
      const n = (want.get(0x3031) ?? 0) > 0 || (want.get(0x3032) ?? 0) > 0 ? 0 : 1;
      if (cfgs && size > 0 && n) mem.st32(cfgs, 1);
      if (num) mem.st32(num, n);
      return 1;
    },
    eglGetConfigAttrib: (_c, a) => { a.i(); a.i(); const attr = a.i(), out = a.p(); mem.st32(out, eglConfigAttrib(attr)); return 1; },
    eglCreateContext: (_c, a) => {
      a.i(); a.i(); const share = contexts[a.i()], at = attrs(a.p());
      const major = at.get(0x3098) ?? 1, minor = at.get(0x30fb) ?? 0;
      if (major > 3 || (major === 3 && minor > 0)) { err = EGL_BAD_MATCH; return 0; }
      const c = new EglContext(share); c.major = major;
      return handle(contexts, c);
    },
    eglDestroyContext: (cpu, a) => {
      a.i(); const h = a.i(), context = contexts[h];
      if (!context) { err = EGL_BAD_CONTEXT; return 0; }
      if (boundEglCurrent(cpu) === context) bindEglCurrent(cpu, null);
      contexts[h] = null;
      return 1;
    },
    eglCreateWindowSurface: (_c, a) => { a.i(); a.i(); const s = windowOf(a.p()); if (!s) { err = EGL_BAD_NATIVE_WINDOW; return 0; } return handle(surfaces, s); },
    eglCreatePbufferSurface: (_c, a) => {
      a.i(); a.i(); const at = attrs(a.p());
      return handle(surfaces, { view: null, width: at.get(0x3057) || 1, height: at.get(0x3056) || 1, present: null, frames: 0 });
    },
    eglCreatePixmapSurface: () => { err = EGL_BAD_ALLOC; return 0; },
    eglDestroySurface: (_c, a) => {
      a.i(); const h = a.i(), s = surfaces[h];
      if (!s) { err = EGL_BAD_SURFACE; return 0; }
      if (!s.view) s.present?.close();
      surfaces[h] = null;
      return 1;
    },
    eglSurfaceAttrib: () => 1, eglSwapInterval: () => 1,
    eglQuerySurface: (_c, a) => {
      a.i(); const s = surfaces[a.i()], attr = a.i(), out = a.p();
      if (!s) { err = EGL_BAD_SURFACE; return 0; }
      mem.st32(out, attr === 0x3057 ? s.width : attr === 0x3056 ? s.height : attr === 0x3093 ? 0x3095 : attr === 0x3028 ? 1 : 0); // SWAP_BEHAVIOR: BUFFER_DESTROYED
      return 1;
    },
    eglQueryContext: (_c, a) => {
      a.i(); const c = contexts[a.i()], attr = a.i(), out = a.p();
      if (!c) { err = EGL_BAD_CONTEXT; return 0; }
      mem.st32(out, attr === 0x3028 ? 1 : attr === 0x3098 ? c.major : attr === 0x3097 ? 0x30a0 : attr === 0x3086 ? 0x3038 : 0);
      return 1;
    },
    eglMakeCurrent: (cpu, a) => {
      a.i(); const draw = surfaces[a.i()]; a.i(); const contextHandle = a.i();
      if (!contextHandle) { bindEglCurrent(cpu, null); return 1; }
      const c = contexts[contextHandle];
      if (!c) { err = EGL_BAD_CONTEXT; return 0; }
      if (!c.makeCurrent(draw ?? null)) { err = EGL_BAD_ALLOC; return 0; }
      bindEglCurrent(cpu, c);
      return 1;
    },
    eglSwapBuffers: (cpu, a) => {
      a.i(); const s = surfaces[a.i()], c = activateEglCurrent(cpu);
      if (!s || !c || c.target !== s) { err = EGL_BAD_SURFACE; return 0; }
      return c.swap().then(() => 1);
    },
    eglPresentationTimeANDROID: (_c, a) => {
      a.i(); const s = surfaces[a.i()], time = a.l();
      if (!s) { err = EGL_BAD_SURFACE; return 0; }
      s.presentationTimeNanos = time;
      return 1;
    },
    eglGetCurrentContext: (cpu) => { const c = boundEglCurrent(cpu); return c ? Math.max(0, contexts.indexOf(c)) : 0; },
    eglGetCurrentDisplay: () => 1,
    eglGetCurrentSurface: (cpu) => { const s = boundEglCurrent(cpu)?.target; return s ? Math.max(0, surfaces.indexOf(s)) : 0; },
    eglWaitGL: () => 1, eglWaitNative: () => 1, eglWaitClient: () => 1,
    eglCopyBuffers: () => { err = EGL_BAD_ALLOC; return 0; },
    eglBindTexImage: () => 0, eglReleaseTexImage: () => 0,
    eglGetProcAddress: (_c, a) => {
      const n = a.str();
      let p = procs.get(n);
      if (p !== undefined) return p;
      const one = Object.hasOwn(gles1Procs, n) ? gles1Procs[n] : undefined;
      const two = Object.hasOwn(gles3Procs, n) ? gles3Procs[n] : undefined;
      // Proc addresses survive context switches; overlapping ES1/ES3 names dispatch at call time.
      if (one && two) p = defineHost(n, (cpu, args) => (activateEglCurrent(cpu)?.major === 1 ? one : two)(cpu, args));
      else p = lookupHost(n, one ? "libGLESv1_CM.so" : two ? "libGLESv2.so" : "libEGL.so");
      if (p !== undefined) { procs.set(n, p); return p; }
      probed.add("eglGetProcAddress!" + n); return 0;
    },
  };
  // eglGetError reports the last call: every entry point starts with a clean slate, as EGL does
  for (const [k, f] of Object.entries(E)) if (k !== "eglGetError") E[k] = (c, a) => { err = EGL_SUCCESS; return f(c, a); };
  hostLib("libEGL.so", E, { closed: true });
}
