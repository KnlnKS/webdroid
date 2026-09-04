// The NDK's closed host libraries: libandroid (windows over the shell's surfaces, per-thread
// loopers, sensors, assets), libOpenSLES (no engine, so audio takes the AudioTrack path) and
// libmediandk (nothing). A name they lack is NULL from dlsym, as on a device without it — which
// is how libunity picks its frame pacing when AChoreographer_* is absent.

import { mem } from "./mem";
import { hostLib, hostData, cstr, stp, retF, type HostFn, type ArgReader } from "./host";
import { deref } from "./jni";
import { JSurface, type GlSurface } from "../android/glview";
import type { Cpu } from "./cpu";
import { BytesFile, readFully, type FileSource } from "../shell/lazyfile";

// ── ANativeWindow: a handle per surface (non-zero, as the pointer it stands for)
const windows: (GlSurface | null)[] = [null];
export function windowOf(h: number): GlSurface | null { return windows[h] ?? null; }
const W = (a: ArgReader) => windows[a.i()];

// ── ALooper: one per thread; pollOnce parks the thread until a wake or its timeout
interface Looper { woken: boolean; wake: (() => void) | null }
const loopers: (Looper | null)[] = [null];
const looperOf = new WeakMap<Cpu, number>();
const poll: HostFn = async (cpu, a) => {
  const ms = a.i(), l = loopers[looperOf.get(cpu) ?? 0];
  if (!l) return -4;                                                           // ALOOPER_POLL_ERROR: not a looper thread
  if (!l.woken && ms !== 0) await new Promise<void>((r) => { l.wake = r; if (ms > 0) setTimeout(r, ms); });
  l.wake = null;
  const r = l.woken ? -1 : -3;                                                 // ALOOPER_POLL_WAKE / POLL_TIMEOUT
  l.woken = false;
  return r;
};

// ── AAsset: the apk's assets/ entries
interface Asset { source: FileSource; data?: Uint8Array; pos: number; buf: number }
interface AssetSet { zip: Record<string, Uint8Array>; lazyEntries: Map<string, FileSource> }
const zips: AssetSet[] = [{ zip: {}, lazyEntries: new Map() }];
const assets: (Asset | null)[] = [null];
const A = (a: ArgReader) => assets[a.i()];
const seek = (s: Asset, off: number, whence: number): number => {
  const p = whence === 0 ? off : whence === 1 ? s.pos + off : s.source.size + off;
  return p < 0 || p > s.source.size ? -1 : (s.pos = p);
};

export function ndkInit(): void {
  hostLib("libandroid.so", {
    ANativeWindow_fromSurface: (cpu, a) => {
      a.p(); const s = deref(a.i(), cpu), surf = s instanceof JSurface ? s.surf : null;
      if (!surf) return 0;
      const i = windows.indexOf(surf);
      if (i > 0) return i;
      windows.push(surf);
      return windows.length - 1;
    },
    ANativeWindow_acquire: () => {}, ANativeWindow_release: () => {},
    ANativeWindow_getWidth: (_c, a) => W(a)?.width ?? -1,
    ANativeWindow_getHeight: (_c, a) => W(a)?.height ?? -1,
    ANativeWindow_getFormat: () => 1,                                           // WINDOW_FORMAT_RGBA_8888
    ANativeWindow_setBuffersGeometry: () => 0, ANativeWindow_setFrameRate: () => 0, ANativeWindow_setFrameRateWithChangeStrategy: () => 0,

    ALooper_prepare: (cpu) => {
      let h = looperOf.get(cpu);
      if (!h) { loopers.push({ woken: false, wake: null }); looperOf.set(cpu, (h = loopers.length - 1)); }
      return h;
    },
    ALooper_forThread: (cpu) => looperOf.get(cpu) ?? 0,
    ALooper_acquire: () => {}, ALooper_release: () => {},
    ALooper_wake: (_c, a) => { const l = loopers[a.i()]; if (l) { l.woken = true; l.wake?.(); } },
    ALooper_pollOnce: poll, ALooper_pollAll: poll,

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
      a.p(); const am = deref(a.i(), cpu) as { host?: AssetSet } | null;
      if (!am?.host) return 0;
      zips.push(am.host);
      return zips.length - 1;
    },
    AAssetManager_open: (_c, a) => {
      const set = zips[a.i()], path = "assets/" + a.str(), data = set?.zip[path];
      const source = data ? new BytesFile(data) : set?.lazyEntries.get(path);
      if (!source) return 0;
      assets.push({ source, data, pos: 0, buf: 0 });
      return assets.length - 1;
    },
    AAsset_read: (_c, a) => {
      const s = A(a); if (!s) return -1;
      const buf = a.p(), n = Math.min(a.i(), s.source.size - s.pos);
      if (!n) return 0;
      const dst = mem.va(buf);
      const value = s.data ? s.data.subarray(s.pos, s.pos + n) : s.source.read(s.pos, n);
      const done = (bytes: Uint8Array) => { mem.write(typeof dst === "bigint" ? mem.txVa(dst) : dst, bytes); s.pos += bytes.length; return bytes.length; };
      return value instanceof Promise ? value.then(done) : done(value);
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
    AAsset_close: (_c, a) => { const h = a.i(), s = assets[h]; if (s) { if (s.buf) mem.free(s.buf); assets[h] = null; } },
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
  hostLib("libmediandk.so", {}, { closed: true });
}
