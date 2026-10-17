// EGL 1.5 over the shell's surfaces: one display, one config (glsurface.ts eglConfigAttrib), contexts
// that own the WebGL2 context (glsurface.ts EglContext), window surfaces from libandroid's
// ANativeWindow handles and pbuffers of their own. Closed: an extension entry point we do not
// implement is NULL from eglGetProcAddress.

import { mem } from "./mem.ts";
import { hostLib, lookupHost, defineHost, probed, cstr, stp, type HostFn } from "./host.ts";
import { EglContext, bufferHeight, bufferWidth, eglConfigAttrib, eglFailure, setEglSwapInterval, takeEglError, type GlSurface } from "../android/glsurface.ts";
import { windowOf } from "./libandroid.ts";
import { gles1Procs } from "./gles1.ts";
import { gles3Procs, clientWait } from "./gles3.ts";
import { activateEglCurrent, bindEglCurrent, boundEglCurrent } from "./egl-current.ts";
import { noteNativeFrame } from "./cpu.ts";

const EGL_BAD_ALLOC = 0x3003, EGL_BAD_ATTRIBUTE = 0x3004, EGL_BAD_CONTEXT = 0x3006, EGL_BAD_DISPLAY = 0x3008, EGL_BAD_MATCH = 0x3009, EGL_BAD_NATIVE_WINDOW = 0x300b,
  EGL_BAD_PARAMETER = 0x300c, EGL_BAD_SURFACE = 0x300d;
const surfaces: (GlSurface | null)[] = [null], contexts: (EglContext | null)[] = [null];
/** the surfaces EGL owns: a window surface's frames are its consumer's, which keeps showing the last after the producer disconnects */
const pbuffers = new WeakSet<GlSurface>();
/** EGL_KHR_fence_sync's fences, each a GL fence in the context current where it was made */
const syncs = new Map<number, { gl: WebGL2RenderingContext; sync: WebGLSync }>();
let lastSync = 0;
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
    eglTerminate: () => 1, eglReleaseThread: (cpu) => { bindEglCurrent(cpu.jthread, null); takeEglError(cpu.jthread); return 1; },
    eglGetError: (cpu) => takeEglError(cpu.jthread),
    eglBindAPI: () => 1, eglQueryAPI: () => 0x30a0,
    eglQueryString: (_c, a) => {
      a.i(); const n = a.i();
      return cstr(n === 0x3053 ? "webdroid" : n === 0x3054 ? "1.5" : n === 0x3055 ? "EGL_ANDROID_presentation_time EGL_KHR_create_context EGL_KHR_fence_sync EGL_KHR_surfaceless_context" : n === 0x308d ? "OpenGL_ES" : "");
    },
    eglGetConfigs: (_c, a) => { a.i(); const cfgs = a.p(), size = a.i(), num = a.p(); if (cfgs && size > 0) stp(cfgs, 1); if (num) mem.st32(num, 1); return 1; },
    eglChooseConfig: (_c, a) => {
      a.i(); const want = attrs(a.p()), cfgs = a.p(), size = a.i(), num = a.p();
      // the one config matches unless the caller needs what it lacks (multisampling)
      const n = (want.get(0x3031) ?? 0) > 0 || (want.get(0x3032) ?? 0) > 0 ? 0 : 1;
      if (cfgs && size > 0 && n) stp(cfgs, 1);
      if (num) mem.st32(num, n);
      return 1;
    },
    eglGetConfigAttrib: (_c, a) => { a.i(); a.i(); const attr = a.i(), out = a.p(); mem.st32(out, eglConfigAttrib(attr)); return 1; },
    eglCreateContext: (cpu, a) => {
      a.i(); a.i(); const share = contexts[a.i()], at = attrs(a.p());
      const major = at.get(0x3098) ?? 1, minor = at.get(0x30fb) ?? 0;
      if (major > 3 || (major === 3 && minor > 0)) { return eglFailure(EGL_BAD_MATCH, 0, cpu.jthread); }
      const c = new EglContext(share); c.major = major;
      return handle(contexts, c);
    },
    eglDestroyContext: (cpu, a) => {
      a.i(); const h = a.i(), context = contexts[h];
      if (!context) { return eglFailure(EGL_BAD_CONTEXT, 0, cpu.jthread); }
      if (boundEglCurrent(cpu.jthread) === context) bindEglCurrent(cpu.jthread, null);
      contexts[h] = null;
      return 1;
    },
    eglCreateWindowSurface: (cpu, a) => { a.i(); a.i(); const s = windowOf(a.p()); if (!s) { return eglFailure(EGL_BAD_NATIVE_WINDOW, 0, cpu.jthread); } return handle(surfaces, s); },
    eglCreatePbufferSurface: (_c, a) => {
      a.i(); a.i(); const at = attrs(a.p());
      const s: GlSurface = { width: at.get(0x3057) || 1, height: at.get(0x3056) || 1, present: null, frames: 0 };
      pbuffers.add(s);
      return handle(surfaces, s);
    },
    eglCreatePixmapSurface: (cpu) => eglFailure(EGL_BAD_ALLOC, 0, cpu.jthread),
    eglDestroySurface: (cpu, a) => {
      a.i(); const h = a.i(), s = surfaces[h];
      if (!s) { return eglFailure(EGL_BAD_SURFACE, 0, cpu.jthread); }
      if (pbuffers.has(s)) s.present?.close();
      surfaces[h] = null;
      return 1;
    },
    eglSurfaceAttrib: () => 1, eglSwapInterval: (cpu, a) => {
      const display = a.i(), interval = a.i();
      return display === 1 ? setEglSwapInterval(interval, cpu.jthread) : eglFailure(0x3008, 0, cpu.jthread);
    },
    eglQuerySurface: (cpu, a) => {
      a.i(); const s = surfaces[a.i()], attr = a.i(), out = a.p();
      if (!s) { return eglFailure(EGL_BAD_SURFACE, 0, cpu.jthread); }
      mem.st32(out, attr === 0x3057 ? bufferWidth(s) : attr === 0x3056 ? bufferHeight(s) : attr === 0x3093 ? 0x3095 : attr === 0x3028 ? 1 : 0); // SWAP_BEHAVIOR: BUFFER_DESTROYED
      return 1;
    },
    eglQueryContext: (cpu, a) => {
      a.i(); const c = contexts[a.i()], attr = a.i(), out = a.p();
      if (!c) { return eglFailure(EGL_BAD_CONTEXT, 0, cpu.jthread); }
      mem.st32(out, attr === 0x3028 ? 1 : attr === 0x3098 ? c.major : attr === 0x3097 ? 0x30a0 : attr === 0x3086 ? 0x3038 : 0);
      return 1;
    },
    eglMakeCurrent: (cpu, a) => {
      a.i(); const draw = surfaces[a.i()]; a.i(); const contextHandle = a.i();
      if (!contextHandle) { bindEglCurrent(cpu.jthread, null); return 1; }
      const c = contexts[contextHandle];
      if (!c) { return eglFailure(EGL_BAD_CONTEXT, 0, cpu.jthread); }
      if (!c.makeCurrent(draw ?? null, cpu.jthread)) { return eglFailure(EGL_BAD_ALLOC, 0, cpu.jthread); }
      return 1;
    },
    eglSwapBuffers: (cpu, a) => {
      a.i(); const s = surfaces[a.i()], c = activateEglCurrent(cpu.jthread);
      if (!s || !c || c.target !== s) { return eglFailure(EGL_BAD_SURFACE, 0, cpu.jthread); }
      noteNativeFrame(cpu);
      return c.swap().then(ok => ok ? 1 : eglFailure(0x300e, 0, cpu.jthread));
    },
    eglPresentationTimeANDROID: (cpu, a) => {
      a.i(); const s = surfaces[a.i()], time = a.l();
      if (!s) { return eglFailure(EGL_BAD_SURFACE, 0, cpu.jthread); }
      s.presentationTimeNanos = time;
      return 1;
    },
    // a context or surface Java EGL made current gets its native handle here
    eglGetCurrentContext: (cpu) => { const c = boundEglCurrent(cpu.jthread); return c ? handle(contexts, c) : 0; },
    eglGetCurrentDisplay: () => 1,
    eglGetCurrentSurface: (cpu) => { const s = boundEglCurrent(cpu.jthread)?.target; return s ? handle(surfaces, s) : 0; },
    eglWaitGL: () => 1, eglWaitNative: () => 1, eglWaitClient: () => 1,
    eglCopyBuffers: (cpu) => eglFailure(EGL_BAD_ALLOC, 0, cpu.jthread),
    eglBindTexImage: () => 0, eglReleaseTexImage: () => 0,
    // a fence (EGL_SYNC_FENCE_KHR) without attributes, as EGL_KHR_fence_sync and EGL 1.5 make it
    eglCreateSyncKHR: (cpu, a) => {
      const display = a.i(), type = a.i(), list = a.p();
      if (display !== 1) return eglFailure(EGL_BAD_DISPLAY, 0, cpu.jthread);
      if (type !== 0x30f9 || list && mem.ld32(list) !== 0x3038) return eglFailure(EGL_BAD_ATTRIBUTE, 0, cpu.jthread);
      const gl = activateEglCurrent(cpu.jthread)?.gl, sync = gl?.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!gl || !sync) return eglFailure(EGL_BAD_MATCH, 0, cpu.jthread);
      syncs.set(++lastSync, { gl, sync });
      return lastSync;
    },
    eglDestroySyncKHR: (cpu, a) => {
      a.i(); const h = a.i(), s = syncs.get(h);
      if (!s) return eglFailure(EGL_BAD_PARAMETER, 0, cpu.jthread);
      s.gl.deleteSync(s.sync); syncs.delete(h);
      return 1;
    },
    // EGL_CONDITION_SATISFIED or EGL_TIMEOUT_EXPIRED; the flush bit is GL's
    eglClientWaitSyncKHR: (cpu, a) => {
      a.i(); const s = syncs.get(a.i()), flags = a.i(), timeout = a.ul();
      if (!s) return eglFailure(EGL_BAD_PARAMETER, 0, cpu.jthread);
      return clientWait(s.gl, s.sync, flags & 1, timeout).then((r) => r === 0x911b ? 0x30f5 : r === 0x911d ? eglFailure(EGL_BAD_PARAMETER, 0, cpu.jthread) : 0x30f6);
    },
    eglGetProcAddress: (_c, a) => {
      const n = a.str();
      let p = procs.get(n);
      if (p !== undefined) return p;
      const one = Object.hasOwn(gles1Procs, n) ? gles1Procs[n] : undefined;
      const two = Object.hasOwn(gles3Procs, n) ? gles3Procs[n] : undefined;
      // Proc addresses survive context switches; overlapping ES1/ES3 names dispatch at call time.
      if (one && two) p = defineHost(n, (cpu, args) => (activateEglCurrent(cpu.jthread)?.major === 1 ? one : two)(cpu, args));
      else p = lookupHost(n, one ? "libGLESv1_CM.so" : two ? "libGLESv2.so" : "libEGL.so");
      if (p !== undefined) { procs.set(n, p); return p; }
      probed.add("eglGetProcAddress!" + n); return 0;
    },
  };
  E.eglCreateSync = E.eglCreateSyncKHR; E.eglDestroySync = E.eglDestroySyncKHR; E.eglClientWaitSync = E.eglClientWaitSyncKHR;
  // a call that does not fail leaves EGL_SUCCESS, so an earlier failure is not reported against it
  for (const [name, fn] of Object.entries(E)) if (name !== "eglGetError") E[name] = (cpu, a) => { takeEglError(cpu.jthread); return fn(cpu, a); };
  hostLib("libEGL.so", E, { closed: true });
}
