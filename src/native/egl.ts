// libEGL: guest memory in and out of the EGL model (android/egl.ts), which the Java front ends share, and EGL_KHR_fence_sync's
// fences. Closed: an extension entry point we do not implement is NULL from eglGetProcAddress.

import { mem } from "./mem.ts";
import { hostLib, lookupHost, defineHost, probed, cstr, stp, PTR, type HostFn } from "./host.ts";
import * as egl from "../android/egl.ts";
import { windowOf } from "./libandroid.ts";
import { gles1Procs, gles1Init } from "./gles1.ts";
import { gles3Procs, gles3Init, clientWait } from "./gles3.ts";
import { activate } from "./gl-context.ts";
import { noteNativeFrame } from "./cpu.ts";

/** EGL_KHR_fence_sync's fences, each a GL fence in the context current where it was made */
const syncs = new Map<number, { gl: WebGL2RenderingContext; sync: WebGLSync }>();
let lastSync = 0;
const procs = new Map<string, number>();
const attrs = (p: number): egl.Attribs => (p ? egl.attribList((i) => mem.ld32(p + i * 4)) : new Map());
/** a query's answer through `out` */
const answer = (value: number | null, out: number): number => { if (value === null) return 0; mem.st32(out, value); return 1; };
/** eglGetConfigs' and eglChooseConfig's answer: up to `size` configs into `out`, or with none their count */
function configs(t: object, found: number[] | null, out: number, size: number, num: number): number {
  if (!found) return 0;
  if (!num) return egl.fail(t, egl.BAD_PARAMETER, 0);
  if (!out) return answer(found.length, num);
  const n = Math.min(Math.max(size, 0), found.length);
  for (let i = 0; i < n; i++) stp(out + i * PTR, found[i]);
  return answer(n, num);
}

const own = (procs: Record<string, HostFn>, name: string): HostFn | undefined => (Object.hasOwn(procs, name) ? procs[name] : undefined);
const dispatch = new Map<string, HostFn>();
/** libGLES's entry point `name`, as the calling thread's current context dispatches it: an ES 1.1
 *  context to the fixed-function pipeline, any other to ES 3.0 */
export function glProc(name: string): HostFn | undefined {
  let p = dispatch.get(name);
  if (p) return p;
  gles1Init(); gles3Init();
  const one = own(gles1Procs, name), two = own(gles3Procs, name);
  p = one && two ? (cpu, a) => (activate(cpu.jthread)?.major === 1 ? one : two)(cpu, a) : one ?? two;
  if (p) dispatch.set(name, p);
  return p;
}

export function eglInit(): void {
  const E: Record<string, HostFn> = {
    eglGetError: (cpu) => egl.getError(cpu.jthread),
    eglGetDisplay: (cpu, a) => egl.getDisplay(cpu.jthread, a.p()),
    // EGL_PLATFORM_ANDROID_KHR's default display
    eglGetPlatformDisplay: (cpu, a) => a.i() === 0x3141 ? egl.getDisplay(cpu.jthread, a.p()) : egl.fail(cpu.jthread, egl.BAD_PARAMETER, 0),
    eglInitialize: (cpu, a) => {
      if (!egl.initialize(cpu.jthread, a.i())) return 0;
      const major = a.p(), minor = a.p();
      if (major) mem.st32(major, 1);
      if (minor) mem.st32(minor, 5);
      return 1;
    },
    eglTerminate: (cpu, a) => +egl.terminate(cpu.jthread, a.i()),
    eglReleaseThread: (cpu) => +egl.releaseThread(cpu.jthread),
    eglBindAPI: (cpu, a) => +egl.bindAPI(cpu.jthread, a.i()),
    eglQueryAPI: (cpu) => egl.queryAPI(cpu.jthread),
    eglQueryString: (cpu, a) => { const s = egl.queryString(cpu.jthread, a.i(), a.i()); return s === null ? 0 : cstr(s); },
    eglGetConfigs: (cpu, a) => { const t = cpu.jthread, found = egl.getConfigs(t, a.i()); return configs(t, found, a.p(), a.i(), a.p()); },
    eglChooseConfig: (cpu, a) => { const t = cpu.jthread, found = egl.chooseConfig(t, a.i(), attrs(a.p())); return configs(t, found, a.p(), a.i(), a.p()); },
    eglGetConfigAttrib: (cpu, a) => answer(egl.getConfigAttrib(cpu.jthread, a.i(), a.i(), a.i()), a.p()),
    eglCreateContext: (cpu, a) => egl.createContext(cpu.jthread, a.i(), a.i(), a.i(), attrs(a.p())),
    eglDestroyContext: (cpu, a) => +egl.destroyContext(cpu.jthread, a.i(), a.i()),
    eglQueryContext: (cpu, a) => answer(egl.queryContext(cpu.jthread, a.i(), a.i(), a.i()), a.p()),
    eglMakeCurrent: (cpu, a) => +egl.makeCurrent(cpu.jthread, a.i(), a.i(), a.i(), a.i()),
    eglGetCurrentContext: (cpu) => egl.getCurrentContext(cpu.jthread),
    eglGetCurrentDisplay: (cpu) => egl.getCurrentDisplay(cpu.jthread),
    eglGetCurrentSurface: (cpu, a) => egl.getCurrentSurface(cpu.jthread, a.i()),
    eglCreateWindowSurface: (cpu, a) => egl.createWindowSurface(cpu.jthread, a.i(), a.i(), windowOf(a.p())),
    eglCreatePbufferSurface: (cpu, a) => egl.createPbufferSurface(cpu.jthread, a.i(), a.i(), attrs(a.p())),
    eglCreatePixmapSurface: (cpu, a) => +egl.unsupported(cpu.jthread, a.i(), egl.BAD_NATIVE_PIXMAP),
    eglCreatePbufferFromClientBuffer: (cpu, a) => +egl.unsupported(cpu.jthread, a.i(), egl.BAD_PARAMETER),
    eglDestroySurface: (cpu, a) => +egl.destroySurface(cpu.jthread, a.i(), a.i()),
    eglQuerySurface: (cpu, a) => answer(egl.querySurface(cpu.jthread, a.i(), a.i(), a.i()), a.p()),
    eglSurfaceAttrib: (cpu, a) => +egl.surfaceAttrib(cpu.jthread, a.i(), a.i(), a.i(), a.i()),
    eglCopyBuffers: (cpu, a) => +egl.unsupported(cpu.jthread, a.i(), egl.BAD_NATIVE_PIXMAP, a.i()),
    eglBindTexImage: (cpu, a) => +egl.unsupported(cpu.jthread, a.i(), egl.BAD_MATCH, a.i()),
    eglReleaseTexImage: (cpu, a) => +egl.unsupported(cpu.jthread, a.i(), egl.BAD_MATCH, a.i()),
    eglSwapInterval: (cpu, a) => +egl.swapInterval(cpu.jthread, a.i(), a.i()),
    eglSwapBuffers: (cpu, a) => {
      const r = egl.swapBuffers(cpu.jthread, a.i(), a.i());
      if (!(r instanceof Promise)) return +r;
      noteNativeFrame(cpu);
      return r.then(Number);
    },
    eglPresentationTimeANDROID: (cpu, a) => +egl.presentationTime(cpu.jthread, a.i(), a.i(), a.l()),
    eglWaitClient: (cpu) => +egl.waitClient(cpu.jthread),
    eglWaitGL: (cpu) => +egl.waitClient(cpu.jthread),
    eglWaitNative: (cpu, a) => +egl.waitNative(cpu.jthread, a.i()),
    // a fence (EGL_SYNC_FENCE_KHR) without attributes, as EGL_KHR_fence_sync and EGL 1.5 make it
    eglCreateSyncKHR: (cpu, a) => {
      const t = cpu.jthread, display = a.i(), type = a.i(), list = a.p();
      egl.begin(t);
      if (!egl.ready(t, display)) return 0;
      if (type !== 0x30f9 || list && mem.ld32(list) !== egl.NONE) return egl.fail(t, egl.BAD_ATTRIBUTE, 0);
      const gl = activate(t)?.gl, sync = gl?.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!gl || !sync) return egl.fail(t, egl.BAD_MATCH, 0);
      syncs.set(++lastSync, { gl, sync });
      return lastSync;
    },
    eglDestroySyncKHR: (cpu, a) => {
      const t = cpu.jthread;
      egl.begin(t);
      if (!egl.ready(t, a.i())) return 0;
      const h = a.i(), s = syncs.get(h);
      if (!s) return egl.fail(t, egl.BAD_PARAMETER, 0);
      s.gl.deleteSync(s.sync); syncs.delete(h);
      return 1;
    },
    // EGL_CONDITION_SATISFIED or EGL_TIMEOUT_EXPIRED; the flush bit is GL's
    eglClientWaitSyncKHR: (cpu, a) => {
      const t = cpu.jthread;
      egl.begin(t);
      if (!egl.ready(t, a.i())) return 0;
      const s = syncs.get(a.i()), flags = a.i(), timeout = a.ul();
      if (!s) return egl.fail(t, egl.BAD_PARAMETER, 0);
      return clientWait(s.gl, s.sync, flags & 1, timeout).then((r) => r === 0x911b ? 0x30f5 : r === 0x911d ? egl.fail(t, egl.BAD_PARAMETER, 0) : 0x30f6);
    },
    eglGetProcAddress: (cpu, a) => {
      egl.begin(cpu.jthread);
      const n = a.str();
      let p = procs.get(n);
      if (p !== undefined) return p;
      const one = own(gles1Procs, n), two = own(gles3Procs, n);
      // Proc addresses survive context switches; overlapping ES1/ES3 names dispatch at call time.
      if (one && two) p = defineHost(n, glProc(n)!);
      else p = lookupHost(n, one ? "libGLESv1_CM.so" : two ? "libGLESv2.so" : "libEGL.so");
      if (p !== undefined) { procs.set(n, p); return p; }
      probed.add("eglGetProcAddress!" + n); return 0;
    },
  };
  E.eglCreateSync = E.eglCreateSyncKHR; E.eglDestroySync = E.eglDestroySyncKHR; E.eglClientWaitSync = E.eglClientWaitSyncKHR;
  hostLib("libEGL.so", E, { closed: true });
}
