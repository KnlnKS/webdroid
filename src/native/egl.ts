// libEGL: guest memory in and out of the EGL model (android/egl.ts), which the Java front ends share, and EGL_KHR_fence_sync's
// and EGL_ANDROID_native_fence_sync's fences. Closed: an extension entry point we do not implement is NULL from eglGetProcAddress.

import { mem } from "./mem.ts";
import { hostLib, lookupHost, defineHost, probed, cstr, stp, PTR, type HostFn } from "./host.ts";
import * as egl from "../android/egl.ts";
import { windowOf } from "./libandroid.ts";
import { gles1Procs, gles1Init } from "./gles1.ts";
import { gles3Procs, gles3Init, clientWait } from "./gles3.ts";
import { activate } from "./gl-context.ts";
import { noteNativeFrame } from "./cpu.ts";
import { acquire, clientBuffer, nativeClientBuffer, bufferAt, release, type HardwareBuffer } from "./hardwarebuffer.ts";
import { Handles } from "./handles.ts";
import { closeFd } from "./fd.ts";
import { after } from "../jvm/natives/jentry.ts";
import { fence, fenceOf, syncFileFd, type Fence } from "./syncfile.ts";

const NATIVE = 0x3144, NATIVE_FD = 0x3145, FOREVER = 0xffffffffffffffffn;
const SATISFIED = 0x30f6, TIMEOUT = 0x30f5;
/** an EGLSync: its EGL_SYNC_TYPE and EGL_SYNC_CONDITION, and its waits; a client wait's result is SATISFIED, TIMEOUT or null for a failure */
interface Sync {
  readonly type: number; readonly condition: number;
  signaled(): boolean;
  clientWait(flush: number, timeout: bigint): PromiseOrVal<number | null>;
  /** the current context's later commands wait for it */
  serverWait(gl: WebGL2RenderingContext): PromiseOrVal<number>;
  destroy(): void;
  /** the native fence a sync_file can carry */
  readonly fence: Fence | null;
}
/** EGL_SYNC_FENCE_KHR: a GL fence in the context current where it was made */
class GlSync implements Sync {
  readonly type = 0x30f9; readonly condition = 0x30f0; readonly fence = null;
  private readonly gl: WebGL2RenderingContext; private readonly sync: WebGLSync;
  constructor(gl: WebGL2RenderingContext, sync: WebGLSync) { this.gl = gl; this.sync = sync; }
  signaled(): boolean { return this.gl.getSyncParameter(this.sync, this.gl.SYNC_STATUS) === this.gl.SIGNALED; }
  clientWait(flush: number, timeout: bigint): Promise<number | null> {
    return clientWait(this.gl, this.sync, flush, timeout).then((r) => r === 0x911b ? TIMEOUT : r === 0x911d ? null : SATISFIED);
  }
  // WebGL waits for no other context's fence, so the calling thread does
  serverWait(gl: WebGL2RenderingContext): PromiseOrVal<number> {
    if (this.gl !== gl) return clientWait(this.gl, this.sync, this.gl.SYNC_FLUSH_COMMANDS_BIT, FOREVER).then(() => 1);
    gl.waitSync(this.sync, 0, gl.TIMEOUT_IGNORED);
    return 1;
  }
  destroy(): void { this.gl.deleteSync(this.sync); }
}
/** EGL_SYNC_NATIVE_FENCE_ANDROID: a sync_file's fence, which the calling thread waits for */
class NativeSync implements Sync {
  readonly type = NATIVE; readonly condition = 0x3146;
  readonly fence: Fence;
  constructor(fence: Fence) { this.fence = fence; }
  signaled(): boolean { return this.fence.signaled; }
  clientWait(_flush: number, timeout: bigint): PromiseOrVal<number> {
    if (this.fence.signaled) return SATISFIED;
    return timeout ? this.fence.wake.wait(timeout >= FOREVER ? -1 : Number(timeout / 1000000n)).then((done) => done ? SATISFIED : TIMEOUT) : TIMEOUT;
  }
  serverWait(): PromiseOrVal<number> { return this.fence.signaled ? 1 : this.fence.done.then(() => 1); }
  destroy(): void {}
}
const syncs = new Handles<Sync>("EGLSync");
const procs = new Map<string, number>();
const attrs = (p: number): egl.Attribs => (p ? egl.attribList((i) => mem.ld32(p + i * 4)) : new Map());
/** an EGL 1.5 list of EGLAttribs */
const attribs = (p: number): egl.Attribs => (p ? egl.attribList((i) => Number(PTR === 8 ? mem.ld64(p + i * 8) : mem.ld32(p + i * 4))) : new Map());
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

/** eglGetSyncAttribKHR's (EGLint) or EGL 1.5's eglGetSyncAttrib's (EGLAttrib) answer about a fence */
function syncAttrib(t: object, display: number, h: number, attribute: number, out: number, store: (p: number, v: number) => void): number {
  if (!egl.enter(t, display)) return 0;
  const s = syncs.find(h);
  if (!s) return egl.fail(t, egl.BAD_PARAMETER, 0);
  // EGL_SYNC_TYPE_KHR, EGL_SYNC_CONDITION_KHR, EGL_SYNC_STATUS_KHR: EGL_SIGNALED_KHR or EGL_UNSIGNALED_KHR
  const value = attribute === 0x30f7 ? s.type : attribute === 0x30f8 ? s.condition : attribute === 0x30f1 ? s.signaled() ? 0x30f2 : 0x30f3 : null;
  if (value === null) return egl.fail(t, egl.BAD_ATTRIBUTE, 0);
  if (!out) return egl.fail(t, egl.BAD_PARAMETER, 0);
  store(out, value);
  return 1;
}

/** a fence (EGL_SYNC_FENCE_KHR) without attributes, as EGL_KHR_fence_sync and EGL 1.5 make it, or a native fence of the GL
 *  commands before it or of the sync_file EGL_SYNC_NATIVE_FENCE_FD_ANDROID passes, which EGL then owns */
function createSync(t: object, display: number, type: number, want: egl.Attribs): number {
  if (!egl.enter(t, display)) return 0;
  const allowed = type === NATIVE ? [NATIVE_FD] : type === 0x30f9 ? [] : null, fd = want.get(NATIVE_FD) ?? -1;
  if (!allowed || [...want.keys()].some((k) => !allowed.includes(k))) return egl.fail(t, egl.BAD_ATTRIBUTE, 0);
  if (fd !== -1) {
    const passed = fenceOf(fd);
    if (!passed) return egl.fail(t, egl.BAD_ATTRIBUTE, 0);
    void closeFd(fd);
    return syncs.add(new NativeSync(passed));
  }
  const gl = activate(t)?.gl, sync = gl?.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!gl || !sync) return egl.fail(t, egl.BAD_MATCH, 0);
  // a native fence's GL fence lives until it signals, past eglDestroySync
  return syncs.add(type === NATIVE ? new NativeSync(fence(clientWait(gl, sync, gl.SYNC_FLUSH_COMMANDS_BIT, FOREVER).finally(() => gl.deleteSync(sync))))
    : new GlSync(gl, sync));
}
/** EGL_KHR_wait_sync's and EGL 1.5's wait: the current context's later commands wait for the fence */
function waitSync(t: object, display: number, h: number, flags: number): PromiseOrVal<number> {
  if (!egl.enter(t, display)) return 0;
  const s = syncs.find(h), gl = activate(t)?.gl;
  if (!s || flags) return egl.fail(t, egl.BAD_PARAMETER, 0);
  if (!gl) return egl.fail(t, egl.BAD_MATCH, 0);
  return s.serverWait(gl);
}
/** EGL_KHR_image_base's images of buffers (EGL_ANDROID_image_native_buffer), each holding a reference to its buffer */
const images = new Handles<HardwareBuffer>("EGLImage");
export const imageBuffer = (h: number): HardwareBuffer | undefined => images.find(h);
/** EGL_KHR_image_base's image of EGL_ANDROID_image_native_buffer's client buffer, an ANativeWindowBuffer, taken without a context;
 *  EGL_IMAGE_PRESERVED_KHR is the one attribute, and a buffer's pixels are always preserved */
function createImageOf(t: object, display: number, context: number, target: number, buffer: number, want: egl.Attribs): number {
  if (!egl.enter(t, display)) return 0;
  if (target !== 0x3140) return egl.fail(t, egl.BAD_PARAMETER, 0);
  if (context) return egl.fail(t, egl.BAD_CONTEXT, 0);
  const b = clientBuffer(buffer);
  if (!b || [...want.keys()].some((k) => k !== 0x30d2)) return egl.fail(t, egl.BAD_PARAMETER, 0);
  acquire(b);
  return images.add(b);
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
    eglCreateSyncKHR: (cpu, a) => createSync(cpu.jthread, a.i(), a.i(), attrs(a.p())),
    eglCreateSync: (cpu, a) => createSync(cpu.jthread, a.i(), a.i(), attribs(a.p())),
    eglDestroySyncKHR: (cpu, a) => {
      const t = cpu.jthread;
      if (!egl.enter(t, a.i())) return 0;
      const s = syncs.delete(a.i());
      if (!s) return egl.fail(t, egl.BAD_PARAMETER, 0);
      s.destroy();
      return 1;
    },
    // EGL_CONDITION_SATISFIED or EGL_TIMEOUT_EXPIRED; the flush bit is GL's
    eglClientWaitSyncKHR: (cpu, a) => {
      const t = cpu.jthread;
      if (!egl.enter(t, a.i())) return 0;
      const s = syncs.find(a.i()), flags = a.i(), timeout = a.ul();
      if (!s) return egl.fail(t, egl.BAD_PARAMETER, 0);
      return after(s.clientWait(flags & 1, timeout), (r) => r ?? egl.fail(t, egl.BAD_PARAMETER, 0));
    },
    eglCreateImageKHR: (cpu, a) => createImageOf(cpu.jthread, a.i(), a.i(), a.i(), a.p(), attrs(a.p())),
    eglCreateImage: (cpu, a) => {
      const t = cpu.jthread, display = a.i(), context = a.i(), target = a.i(), buffer = a.p(), list = a.p();
      return createImageOf(t, display, context, target, buffer, attribs(list));
    },
    eglDestroyImageKHR: (cpu, a) => {
      const t = cpu.jthread;
      if (!egl.enter(t, a.i())) return 0;
      const b = images.delete(a.i());
      if (!b) return egl.fail(t, egl.BAD_PARAMETER, 0);
      release(b);
      return 1;
    },
    eglGetNativeClientBufferANDROID: (cpu, a) => {
      egl.begin(cpu.jthread);
      const b = bufferAt(a.p());
      return b ? nativeClientBuffer(b) : egl.fail(cpu.jthread, egl.BAD_PARAMETER, 0);
    },
    eglWaitSyncKHR: (cpu, a) => waitSync(cpu.jthread, a.i(), a.i(), a.i()),
    eglWaitSync: (cpu, a) => waitSync(cpu.jthread, a.i(), a.i(), a.i()),
    // a sync_file of a native fence, EGL_NO_NATIVE_FENCE_FD_ANDROID for any other sync
    eglDupNativeFenceFDANDROID: (cpu, a) => {
      const t = cpu.jthread;
      if (!egl.enter(t, a.i())) return -1;
      const fence = syncs.find(a.i())?.fence;
      return fence ? syncFileFd(fence) : egl.fail(t, egl.BAD_PARAMETER, -1);
    },
    eglGetSyncAttribKHR: (cpu, a) => syncAttrib(cpu.jthread, a.i(), a.i(), a.i(), a.p(), (p, v) => mem.st32(p, v)),
    eglGetSyncAttrib: (cpu, a) => syncAttrib(cpu.jthread, a.i(), a.i(), a.i(), a.p(), stp),
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
  E.eglDestroySync = E.eglDestroySyncKHR; E.eglClientWaitSync = E.eglClientWaitSyncKHR; E.eglDestroyImage = E.eglDestroyImageKHR;
  hostLib("libEGL.so", E, { closed: true });
}
