// The NDK's closed host libraries: libandroid (windows over the shell's surfaces, per-thread
// loopers, sensors, assets) and libOpenSLES (no engine, so audio takes the AudioTrack path).
// A name they lack is NULL from dlsym, as on a device without it.

import { mem, anchor } from "./mem.ts";
import { hostLib, hostData, defineHost, lookupHost, cstr, stp, retF, PTR, complete, type HostFn, type ArgReader } from "./host.ts";
import { deref, newLocal } from "./jni.ts";
import { surfaceTarget, surfaceTextureOf, bufferHeight, bufferWidth, presentSurface, type GlSurface, type NativeSurfaceTexture } from "../android/glsurface.ts";
import { producerSurface } from "../android/surfaceflinger.ts";
import type { Cpu } from "./cpu.ts";
import { onLooper } from "../android/mainloop.ts";
import { after, type JThread } from "../jvm/natives/jentry.ts";
import { dispatchUncaught } from "../jvm/natives/jthrowable.ts";
import { msLeft, pollEntries, type PollEntry } from "./poll.ts";
import { guestNow } from "../guest-clock.ts";
import { BytesFile, readFully, type FileSource } from "../shell/lazyfile.ts";
import { Resources, nativeAssets } from "../android/res.ts";
import { assetDir, assetEntry } from "../android/assetmanager.ts";
import { handle, deref as handleObject } from "../android/handles.ts";
import { HINT_RATE_NANOS, hintSessions, openHintSession, ashmemCreate, ashmemSize, ashmemSetProt } from "../android/os.ts";
import { kernelResult } from "./kernel.ts";
import { CODECS } from "./pixel-codecs.ts";
import { Handles } from "./handles.ts";
import { Choreographer, choreographerLib } from "./choreographer.ts";

// ── ANativeWindow: window.h's struct per surface, as a library built against <system/window.h> calls its function pointers
// (Filament's perform(NATIVE_WINDOW_GET_NEXT_FRAME_ID)). The window has no buffers to dequeue: its frames come from EGL or lock/unlockAndPost.
class NativeWindow {
  readonly surface: GlSurface; handle = 0;
  refs = 1;
  format = 1;
  bits = 0; size = 0;
  locked = false; lockedWidth = 0; lockedHeight = 0;
  /** the posted frame's RGBA, reused: createImageBitmap has copied it by the time a post finishes, and a window posts one frame at a time */
  pixels = new Uint8ClampedArray(0);
  constructor(surface: GlSurface) { this.surface = surface; }
}
const windows = new Handles<NativeWindow>("ANativeWindow");
const windowBySurface = new WeakMap<GlSurface, NativeWindow>();
const W = (a: ArgReader) => windows.find(a.p());
const BAD_VALUE = -22, NAME_NOT_FOUND = -2, INVALID_OPERATION = -38;
const QUERIES: Record<number, (w: NativeWindow) => number> = {
  0: (w) => bufferWidth(w.surface), 1: (w) => bufferHeight(w.surface), 2: (w) => w.format,
  4: () => 1, 5: () => 1 /* NATIVE_WINDOW_SURFACE */, 6: (w) => w.surface.width, 7: (w) => w.surface.height, 8: () => 0, 17: () => 1,
};
/** setSwapInterval, the deprecated buffer calls, query, perform, cancelBuffer_DEPRECATED, then dequeueBuffer, queueBuffer and cancelBuffer */
let windowFns: number[] | null = null;
const windowFunctions = () => windowFns ??= (() => {
  const noBuffers = defineHost("ANativeWindow:buffers", () => INVALID_OPERATION);
  return [
    defineHost("ANativeWindow:setSwapInterval", (_c, a) => { const w = W(a); if (!w) return BAD_VALUE; w.surface.swapInterval = Math.max(0, Math.min(1, a.i())); return 0; }),
    noBuffers, noBuffers, noBuffers,
    defineHost("ANativeWindow:query", (_c, a) => {
      const w = W(a), what = a.i(), out = a.p(), answer = w && QUERIES[what];
      if (!answer || !out) return BAD_VALUE;
      mem.st32(out, answer(w));
      return 0;
    }),
    defineHost("ANativeWindow:perform", (_c, a) => {
      const w = W(a), op = a.i();
      if (!w) return BAD_VALUE;
      // NATIVE_WINDOW_GET_NEXT_FRAME_ID: the frame number the next queued buffer takes, counting from 1
      if (op === 24) { mem.st64(a.p(), BigInt(w.surface.frames + 1)); return 0; }
      return NAME_NOT_FOUND;
    }),
    noBuffers, noBuffers, noBuffers, noBuffers,
  ];
})();
export function nativeWindowFor(surface: GlSurface): number {
  const existing = windowBySurface.get(surface);
  if (existing) { existing.refs++; return existing.handle; }
  // window.h: android_native_base_t (magic, version, reserved[4], incRef, decRef), then flags, min and maxSwapInterval,
  // xdpi and ydpi, oem[4] at pointer alignment, and the window's ten functions
  const common = 8 + 6 * PTR, oem = common + 20 + PTR - 1 & -PTR, size = oem + 14 * PTR;
  const window = new NativeWindow(surface), at = window.handle = windows.alloc(window, size);
  if (!at) return 0;
  mem.st32(at, 0x5f776e64); mem.st32(at + 4, size);   // ANDROID_NATIVE_WINDOW_MAGIC '_wnd', the struct's size
  stp(at + 8 + 4 * PTR, lookupHost("ANativeWindow_acquire", "libandroid.so")!); stp(at + 8 + 5 * PTR, lookupHost("ANativeWindow_release", "libandroid.so")!);
  mem.st32(at + common + 8, 1);   // maxSwapInterval
  windowFunctions().forEach((fn, i) => stp(at + oem + (4 + i) * PTR, fn));
  windowBySurface.set(surface, window);
  return at;
}
export function windowOf(h: number): GlSurface | null { return windows.find(h)?.surface ?? null; }
export function releaseWindow(h: number): void {
  const window = windows.find(h);
  if (!window || --window.refs > 0) return;
  if (window.bits) mem.free(window.bits);
  windowBySurface.delete(window.surface); windows.delete(h);
}
const YV12 = 0x32315659;

// ── ASurfaceTexture (surface_texture.cpp): a handle on a Java SurfaceTexture's consumer, whose release frees the handle only.
// GL calls act in the calling thread's context.
const surfaceTextures = new Handles<NativeSurfaceTexture>("ASurfaceTexture");
const ST = (a: ArgReader) => surfaceTextures.find(a.p());
const withSurfaceTexture = <T>(a: ArgReader, op: (st: NativeSurfaceTexture) => T): T | number => {
  const st = ST(a);
  return st ? op(st) : BAD_VALUE;
};

function lockWindow(_cpu: Cpu, args: ArgReader): number {
  const buffer = W(args), out = args.p(), dirty = args.p();
  if (!buffer || !out) return BAD_VALUE;
  if (buffer.locked) return -16;
  const width = bufferWidth(buffer.surface), height = bufferHeight(buffer.surface);
  const stride = buffer.format === YV12 ? Math.ceil(width / 16) * 16 : width;
  const size = buffer.format === YV12 ? (stride + Math.ceil(stride / 32) * 16) * height : width * height * (buffer.format === 4 ? 2 : 4);
  if (!size || !Number.isSafeInteger(size) || size > 0x7fffffff) return BAD_VALUE;
  if (size !== buffer.size) {
    if (buffer.bits) mem.free(buffer.bits);
    buffer.bits = mem.malloc(size); buffer.size = buffer.bits ? size : 0;
  }
  if (!buffer.bits) return -12;
  mem.st32(out, width); mem.st32(out + 4, height); mem.st32(out + 8, stride);
  mem.st32(out + 12, buffer.format); stp(out + 16, buffer.bits);
  if (dirty) {
    mem.st32(dirty, 0); mem.st32(dirty + 4, 0);
    mem.st32(dirty + 8, width); mem.st32(dirty + 12, height);
  }
  buffer.lockedWidth = width; buffer.lockedHeight = height; buffer.locked = true;
  return 0;
}
async function postWindow(_cpu: Cpu, args: ArgReader): Promise<number> {
  const buffer = W(args);
  if (!buffer?.locked) return BAD_VALUE;
  const width = buffer.lockedWidth, height = buffer.lockedHeight;
  if (buffer.format === YV12) {
    const stride = Math.ceil(width / 16) * 16, chromaStride = Math.ceil(stride / 32) * 16;
    // Android stores Y,V,U with both strides aligned to 16; I420's layout names Y,U,V.
    const ySize = stride * height, chromaSize = chromaStride * height / 2;
    let frame: VideoFrame | undefined;
    try {
      frame = new VideoFrame(mem.bytes(buffer.bits, buffer.size), {
        format: "I420", codedWidth: width, codedHeight: height, timestamp: 0,
        layout: [{ offset: 0, stride }, { offset: ySize + chromaSize, stride: chromaStride }, { offset: ySize, stride: chromaStride }],
        colorSpace: { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false },
      });
      presentSurface(buffer.surface, await createImageBitmap(frame));
    } finally { frame?.close(); buffer.locked = false; }
    return 0;
  }
  if (buffer.pixels.length !== width * height * 4) buffer.pixels = new Uint8ClampedArray(width * height * 4);
  CODECS.get(buffer.format)!.unpack(mem.bytes(buffer.bits, buffer.size), buffer.pixels, width * height);
  try { presentSurface(buffer.surface, await createImageBitmap(new ImageData(buffer.pixels, width, height))); }
  finally { buffer.locked = false; }
  return 0;
}

// ── ALooper: one per thread; pollOnce parks the thread until a wake or its timeout
interface LooperFd { ident: number; events: number; callback: number; data: bigint }
/** `jobs`: host work a native thread's looper runs at its next poll, as a looper's messages; `choreographer`: the
 *  thread's AChoreographer, whose handle is the looper's */
interface Looper { cpu: Cpu; pumping: boolean; woken: boolean; wake: AbortController | null; fds: Map<number, LooperFd>; jobs: (() => Promise<unknown>)[];
  allowNonCallbacks: boolean; choreographer: Choreographer | null }
const loopers = new Handles<Looper>("ALooper");
const looperOf = new WeakMap<Cpu, number>();
const L = (a: ArgReader) => loopers.find(a.p());
function prepareLooper(cpu: Cpu, allowNonCallbacks: boolean): number {
  const existing = looperOf.get(cpu);
  if (existing) return existing;
  const handle = loopers.add({ cpu, pumping: false, woken: false, wake: null, fds: new Map(), jobs: [], allowNonCallbacks, choreographer: null });
  looperOf.set(cpu, handle);
  return handle;
}
/** the thread's looper, prepared for a Java looper thread, as ALooper_forThread finds it */
const threadLooper = (cpu: Cpu): number => looperOf.get(cpu) ?? (cpu.jthread.looper ? prepareLooper(cpu, false) : 0);
const pollEvents = (events: number) => (events & 1) | ((events & 2) << 1);
const looperEvents = (events: number) => (events & 1) | ((events & (4 | 8 | 16 | 32)) >> 1);
/** one poll of `cpu`'s looper; a pumped Java looper's callbacks run on its `thread` */
async function pollLooper(cpu: Cpu, ms: number, fdOut: bigint, eventsOut: bigint, dataOut: bigint, thread: JThread | null = null): Promise<number> {
  const l = loopers.find(looperOf.get(cpu) ?? 0);
  if (!l) return -4;
  const entries = [...l.fds].filter(([, entry]) => !thread || entry.callback);
  const polled: PollEntry[] = entries.map(([fd, entry]) => ({ fd, events: pollEvents(entry.events), revents: 0 }));
  try {
    l.wake = new AbortController();
    await pollEntries(polled, l.woken || l.jobs.length ? 0 : ms, l.wake.signal);
    l.wake = null;
    const woken = l.woken;
    l.woken = false;
    let callbacks = false;
    for (const job of l.jobs.splice(0)) { callbacks = true; await job(); }
    for (let i = 0; i < entries.length; i++) {
      const [fd, entry] = entries[i], events = looperEvents(polled[i].revents);
      if (!events || l.fds.get(fd) !== entry) continue;
      if (entry.callback) {
        callbacks = true;
        const call = async () => {
          if (l.fds.get(fd) !== entry) return;
          if (!await cpu.call(entry.callback, [fd, events, entry.data], "ALooper callback") && l.fds.get(fd) === entry) l.fds.delete(fd);
        };
        if (thread) await onLooper(thread, call); else await call();
      }
    }
    if (callbacks) return -2;
    for (let i = 0; i < entries.length; i++) {
      const [fd, entry] = entries[i], events = looperEvents(polled[i].revents);
      if (!events || entry.callback || l.fds.get(fd) !== entry) continue;
      if (fdOut) mem.st32(mem.txVa(fdOut), fd);
      if (eventsOut) mem.st32(mem.txVa(eventsOut), events);
      if (dataOut) { const out = mem.txVa(dataOut); mem.st32(out, Number(entry.data & 0xffffffffn)); if (cpu.a64) mem.st32(out + 4, Number(entry.data >> 32n)); }
      return entry.ident;
    }
    return woken ? -1 : -3;
  } finally { l.wake = null; }
}
/** A Java looper thread's MessageQueue is its ALooper, as libutils' Looper is both: its fd callbacks
 *  run on it between messages, where nativePollOnce would run them. */
function pumpLooper(l: Looper): void {
  const thread = l.cpu.jthread;
  if (!thread.looper || l.pumping) return;
  l.pumping = true;
  void (async () => {
    try {
      while (!l.cpu.finished && thread.looper && [...l.fds.values()].some((entry) => entry.callback)) await pollLooper(l.cpu, -1, 0n, 0n, 0n, thread);
    } catch (error) { void dispatchUncaught(thread, error); }
    finally { l.pumping = false; }
  })();
}
/** run `job` on `cpu`'s thread between its looper's messages: a Java looper's, or a native one's at its next poll */
function onThreadLooper(cpu: Cpu, job: () => Promise<unknown>): void {
  const thread = cpu.jthread, l = loopers.find(looperOf.get(cpu) ?? 0);
  if (thread.looper) onLooper(thread, job).catch((error) => dispatchUncaught(thread, error));
  else if (l) { l.jobs.push(job); l.wake?.abort(); }
}
const poll = (all: boolean): HostFn => async (cpu, a) => {
  const ms = a.i(), fd = a.va(), events = a.va(), data = a.va(), deadline = guestNow() + ms;
  for (let remaining = ms; ; remaining = msLeft(ms, deadline)) {
    const result = await pollLooper(cpu, remaining, fd, events, data);
    if (!all || result !== -2) return result;
  }
};

// ── AAsset: assets/ entries as the AssetManager2 behind a Java AssetManager opens them. An
// AAssetManager* is that AssetManager2's handle, as AOSP's is its address.
interface Asset { source: FileSource; data?: Uint8Array; pos: number; buf: number }
const manager = (a: ArgReader): Resources | null => { const res = handleObject(BigInt(a.i())); return res instanceof Resources ? res : null; };
const assets = new Handles<Asset>("AAsset");
const A = (a: ArgReader) => assets.find(a.p());
/** an open AAssetDir: the file names directly under it, and the one getNextFileName last returned */
const assetDirs = new Handles<{ names: string[]; next: number; name: number }>("AAssetDir");
const seek = (s: Asset, off: number, whence: number): number => {
  const p = whence === 0 ? off : whence === 1 ? s.pos + off : s.source.size + off;
  return p < 0 || p > s.source.size ? -1 : (s.pos = p);
};

const readTids = (p: number, n: number) => Int32Array.from({ length: n }, (_, i) => mem.ld32(p + 4 * i));
const EINVAL = 22;

export function ndkInit(): void {
  hostLib("libandroid.so", {
    ATrace_isEnabled: () => 0,
    ATrace_beginSection: () => {},
    ATrace_endSection: () => {},
    ANativeWindow_fromSurface: (cpu, a) => {
      a.p(); const surf = surfaceTarget(deref(a.i(), cpu));
      if (!surf) return 0;
      return nativeWindowFor(surf);
    },
    // a Surface whose producer is the window's surface, as android_view_Surface_createFromSurface makes one
    ANativeWindow_toSurface: (cpu, a) => {
      a.p(); const window = W(a);
      return window ? newLocal(cpu, "android/view/Surface", "(J)V", [handle(producerSurface(window.surface))]) : 0;
    },
    ANativeWindow_acquire: (_c, a) => { const window = W(a); if (window) window.refs++; },
    ANativeWindow_release: (_c, a) => releaseWindow(a.p()),
    // the consumer's default size (NATIVE_WINDOW_WIDTH); setBuffersGeometry sizes only the buffers
    ANativeWindow_getWidth: (_c, a) => { const s = W(a); return s ? s.surface.width : BAD_VALUE; },
    ANativeWindow_getHeight: (_c, a) => { const s = W(a); return s ? s.surface.height : BAD_VALUE; },
    ANativeWindow_getFormat: (_c, a) => { const s = W(a); return s ? s.format : BAD_VALUE; },
    // no buffer has a dataspace set: ADATASPACE_UNKNOWN
    ANativeWindow_getBuffersDataSpace: (_c, a) => W(a) ? 0 : BAD_VALUE,
    ANativeWindow_lock: lockWindow, ANativeWindow_unlockAndPost: postWindow,
    ANativeWindow_setBuffersGeometry: (_c, a) => {
      const buffer = W(a), width = a.i(), height = a.i(), format = a.i();
      if (!buffer || width < 0 || height < 0 || (!width !== !height) || ![0, 1, 2, 4, YV12].includes(format)
        || format === YV12 && ((width | height) & 1)) return BAD_VALUE;
      if (buffer.locked) return -16;
      buffer.surface.userWidth = width; buffer.surface.userHeight = height; buffer.format = format || 1;
      return 0;
    },
    ANativeWindow_setFrameRate: () => 0, ANativeWindow_setFrameRateWithChangeStrategy: () => 0,

    ASurfaceTexture_fromSurfaceTexture: (cpu, a) => {
      a.p(); const st = surfaceTextureOf(deref(a.i(), cpu));
      return st ? surfaceTextures.add(st) : 0;
    },
    ASurfaceTexture_release: (_c, a) => { surfaceTextures.delete(a.p()); },
    ASurfaceTexture_acquireANativeWindow: (_c, a) => { const st = ST(a); return st && !st.abandoned ? nativeWindowFor(st.surface) : 0; },
    ASurfaceTexture_attachToGLContext: (cpu, a) => withSurfaceTexture(a, (st) => st.attach(a.u(), cpu.jthread)),
    ASurfaceTexture_detachFromGLContext: (cpu, a) => withSurfaceTexture(a, (st) => st.detach(cpu.jthread)),
    ASurfaceTexture_updateTexImage: (cpu, a) => withSurfaceTexture(a, (st) => st.update(cpu.jthread)),
    ASurfaceTexture_getTransformMatrix: (_c, a) => {
      const st = ST(a), out = a.p();
      if (st) st.matrix.forEach((v, i) => mem.stf32(out + 4 * i, v));
    },
    ASurfaceTexture_getTimestamp: (_c, a) => ST(a)?.timestamp ?? 0n,

    ALooper_prepare: (cpu, a) => prepareLooper(cpu, !!(a.i() & 1)),
    ALooper_forThread: threadLooper,
    ALooper_acquire: () => {}, ALooper_release: () => {},
    ALooper_wake: (_c, a) => { const l = L(a); if (l) { l.woken = true; l.wake?.abort(); } },
    ALooper_addFd: (_c, a) => {
      const l = L(a), fd = a.i(), ident = a.i(), events = a.i(), callback = a.p(), data = a.va();
      if (!l || fd < 0 || (!callback && (!l.allowNonCallbacks || ident < 0))) return -1;
      l.fds.set(fd, { ident, events, callback, data });
      l.wake?.abort();
      pumpLooper(l);
      return 1;
    },
    ALooper_removeFd: (_c, a) => { const l = L(a), fd = a.i(); if (!l) return -1; const removed = l.fds.delete(fd); if (removed) l.wake?.abort(); return Number(removed); },
    ALooper_pollOnce: poll(false), ALooper_pollAll: poll(true),

    // a thread's choreographer, none without a looper ("No looper prepared for thread")
    ...choreographerLib((cpu) => {
      const h = threadLooper(cpu), l = loopers.find(h);
      if (l) l.choreographer ??= new Choreographer(cpu, (job) => onThreadLooper(cpu, job));
      return h;
    }, (h) => loopers.find(h)?.choreographer ?? undefined),

    // the device has no sensors (the Java SensorManager says the same)
    ASensorManager_getInstance: () => 1, ASensorManager_getInstanceForPackage: () => 1,
    ASensorManager_getSensorList: (_c, a) => { a.p(); const out = a.p(); if (out) stp(out, 0); return 0; },
    ASensorManager_getDefaultSensor: () => 0, ASensorManager_getDefaultSensorEx: () => 0,
    ASensorManager_createEventQueue: () => 1, ASensorManager_destroyEventQueue: () => 0,
    ASensorEventQueue_enableSensor: () => -22, ASensorEventQueue_disableSensor: () => -22, ASensorEventQueue_setEventRate: () => -22, // EINVAL
    ASensorEventQueue_hasEvents: () => 0, ASensorEventQueue_getEvents: () => 0,
    ASensor_getType: () => 0, ASensor_getMinDelay: () => 0, ASensor_getResolution: (cpu) => retF(cpu, 0),
    ASensor_getName: () => cstr(""), ASensor_getVendor: () => cstr(""),

    AAssetManager_fromJava: (cpu, a) => {
      a.p(); const am = deref(a.i(), cpu), res = am && nativeAssets(am);
      return res ? Number(handle(res)) : 0;
    },
    AAssetManager_open: (_c, a) => {
      const res = manager(a), source = res && assetEntry(res, a.str());
      if (!source) return 0;
      return assets.add({ source, data: source instanceof BytesFile ? source.bytes : undefined, pos: 0, buf: 0 });
    },
    // AAssetDir_getNextFileName reports regular files only
    AAssetManager_openDir: (_c, a) => {
      const res = manager(a);
      if (!res) return 0;
      const names = assetDir(res, a.str()).flatMap(([name, regular]) => (regular ? [name] : []));
      return assetDirs.add({ names, next: 0, name: 0 });
    },
    AAssetDir_getNextFileName: (_c, a) => {
      const d = assetDirs.find(a.p());
      if (!d) return 0;
      mem.free(d.name);
      return (d.name = d.next < d.names.length ? mem.strdup(d.names[d.next++]) : 0);
    },
    AAssetDir_rewind: (_c, a) => { const d = assetDirs.find(a.p()); if (d) d.next = 0; },
    AAssetDir_close: (_c, a) => { const d = assetDirs.delete(a.p()); if (d) mem.free(d.name); },
    APerformanceHint_getManager: () => 1,
    APerformanceHint_getPreferredUpdateRateNanos: () => HINT_RATE_NANOS,
    // HintManagerService refuses a session without threads, which the NDK answers with NULL
    APerformanceHint_createSession: (_c, a) => { a.p(); const tids = a.p(), n = a.i(); return n ? openHintSession(readTids(tids, n)) : 0; },
    APerformanceHint_updateTargetWorkDuration: (_c, a) => { a.p(); return a.l() > 0n ? 0 : EINVAL; },
    APerformanceHint_reportActualWorkDuration: (_c, a) => { a.p(); return a.l() > 0n ? 0 : EINVAL; },
    APerformanceHint_setThreads: (_c, a) => { const session = a.i(), tids = a.p(), n = a.i(); if (!n) return EINVAL; hintSessions.set(session, readTids(tids, n)); return 0; },
    APerformanceHint_setPreferPowerEfficiency: () => 0,
    APerformanceHint_closeSession: (_c, a) => { hintSessions.delete(a.i()); },
    ASharedMemory_create: (cpu, a) => { a.p(); const size = a.i(); return size ? kernelResult(cpu, ashmemCreate(size)) : -EINVAL; },
    ASharedMemory_getSize: (_c, a) => after(ashmemSize(a.i()), (n) => Math.max(0, n)),
    ASharedMemory_setProt: (cpu, a) => kernelResult(cpu, ashmemSetProt(a.i(), a.i())),
    // there is no thermal service: no manager, and the headroom is the documented NaN
    AThermal_acquireManager: () => 0, AThermal_releaseManager: () => {},
    AThermal_getCurrentThermalStatus: () => -1,
    AThermal_getThermalHeadroom: (cpu) => retF(cpu, NaN),
    AAsset_read: (_c, a) => {
      const s = A(a); if (!s) return -1;
      const buf = a.p(), n = Math.min(a.i(), s.source.size - s.pos);
      if (!n) return 0;
      const dst = anchor(buf);
      const value = s.data ? s.data.subarray(s.pos, s.pos + n) : s.source.read(s.pos, n);
      return complete(value, bytes => { mem.write(dst(), bytes); s.pos += bytes.length; return bytes.length; });
    },
    AAsset_seek: (_c, a) => { const s = A(a); return s ? seek(s, a.i(), a.i()) : -1; },
    AAsset_seek64: (_c, a) => { const s = A(a); return BigInt(s ? seek(s, Number(a.l()), a.i()) : -1); },
    AAsset_getLength: (_c, a) => A(a)?.source.size ?? 0,
    AAsset_getLength64: (_c, a) => BigInt(A(a)?.source.size ?? 0),
    AAsset_getRemainingLength: (_c, a) => { const s = A(a); return s ? s.source.size - s.pos : 0; },
    AAsset_getRemainingLength64: (_c, a) => { const s = A(a); return BigInt(s ? s.source.size - s.pos : 0); },
    AAsset_getBuffer: (_c, a) => {
      const s = A(a); if (!s) return 0;
      const done = (bytes: Uint8Array) => {
        s.data = bytes;
        if (!s.buf) { s.buf = mem.malloc(bytes.length); mem.write(s.buf, bytes); }
        return s.buf;
      };
      return s.data ? done(s.data) : readFully(s.source).then(done);
    },
    AAsset_isAllocated: () => 0,
    AAsset_openFileDescriptor: () => -1, AAsset_openFileDescriptor64: () => -1,
    AAsset_close: (_c, a) => { const s = assets.delete(a.p()); if (s?.buf) mem.free(s.buf); },
  }, { closed: true });

  hostLib("libOpenSLES.so", {
    slCreateEngine: () => 0x0000000c,                                           // SL_RESULT_FEATURE_UNSUPPORTED: there is no engine here
    slQueryNumSupportedEngineInterfaces: (_c, a) => { const p = a.p(); if (p) mem.st32(p, 0); return 0; },
    slQuerySupportedEngineInterfaces: () => 0x00000007,                          // SL_RESULT_PARAMETER_INVALID
  }, { closed: true });
  for (const [i, n] of ["ENGINE", "PLAY", "RECORD", "BUFFERQUEUE", "VOLUME", "ANDROIDSIMPLEBUFFERQUEUE", "ANDROIDCONFIGURATION", "OUTPUTMIX", "OBJECT", "PLAYBACKRATE"].entries()) {
    const p = mem.hostAlloc(16, 4);                                             // an SLInterfaceID is a pointer to a 16-byte GUID; distinct is all that matters
    mem.st32(p, 0x1000 + i);
    hostData("libOpenSLES.so", "SL_IID_" + n, p);
  }
}
