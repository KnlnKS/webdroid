// The NDK's closed host libraries: libandroid (windows over the shell's surfaces, per-thread
// loopers, sensors, assets), libOpenSLES (no engine, so audio takes the AudioTrack path) and
// libmediandk (nothing). A name they lack is NULL from dlsym, as on a device without it — which
// is how libunity picks its frame pacing when AChoreographer_* is absent.

import { mem } from "./mem";
import { hostLib, hostData, cstr, stp, retF, type HostFn, type ArgReader } from "./host";
import { deref } from "./jni";
import { JSurface, type GlSurface } from "../android/glview";
import type { Cpu } from "./cpu";
import { onMain } from "../android/mainloop";
import { mainThread, reportUncaught } from "../jvm/natives/jlang";
import { nativePoll } from "./net";
import { BytesFile, readFully, type FileSource } from "../shell/lazyfile";

// ── ANativeWindow: a handle per surface (non-zero, as the pointer it stands for)
const windows: (GlSurface | null)[] = [null];
export function windowOf(h: number): GlSurface | null { return windows[h] ?? null; }
const W = (a: ArgReader) => windows[a.i()];

// ── ALooper: one per thread; pollOnce parks the thread until a wake or its timeout
interface LooperFd { ident: number; events: number; callback: number; data: bigint }
interface Looper { cpu: Cpu; pumping: boolean; woken: boolean; wake: AbortController | null; fds: Map<number, LooperFd>; allowNonCallbacks: boolean }
const loopers: (Looper | null)[] = [null];
const looperOf = new WeakMap<Cpu, number>();
const pollEvents = (events: number) => (events & 1) | ((events & 2) << 1);
const looperEvents = (events: number) => (events & 1) | ((events & (4 | 8 | 16 | 32)) >> 1);
async function pollLooper(cpu: Cpu, ms: number, fdOut: bigint, eventsOut: bigint, dataOut: bigint, main = false): Promise<number> {
  const l = loopers[looperOf.get(cpu) ?? 0];
  if (!l) return -4;
  const entries = [...l.fds].filter(([, entry]) => !main || entry.callback), pollfds = mem.malloc(Math.max(8, entries.length * 8));
  try {
    for (let i = 0; i < entries.length; i++) { mem.st32(pollfds + i * 8, entries[i][0]); mem.st16(pollfds + i * 8 + 4, pollEvents(entries[i][1].events)); }
    l.wake = new AbortController();
    await nativePoll(cpu, pollfds, entries.length, l.woken ? 0 : ms, l.wake.signal);
    l.wake = null;
    const woken = l.woken;
    l.woken = false;
    let callbacks = false;
    for (let i = 0; i < entries.length; i++) {
      const [fd, entry] = entries[i], events = looperEvents(mem.ld16u(pollfds + i * 8 + 6));
      if (!events || l.fds.get(fd) !== entry) continue;
      if (entry.callback) {
        callbacks = true;
        const call = async () => {
          if (l.fds.get(fd) !== entry) return;
          if (!await cpu.call(entry.callback, [fd, events, entry.data], "ALooper callback") && l.fds.get(fd) === entry) l.fds.delete(fd);
        };
        if (main) await onMain(call); else await call();
      }
    }
    if (callbacks) return -2;
    for (let i = 0; i < entries.length; i++) {
      const [fd, entry] = entries[i], events = looperEvents(mem.ld16u(pollfds + i * 8 + 6));
      if (!events || entry.callback || l.fds.get(fd) !== entry) continue;
      if (fdOut) mem.st32(mem.txVa(fdOut), fd);
      if (eventsOut) mem.st32(mem.txVa(eventsOut), events);
      if (dataOut) { const out = mem.txVa(dataOut); mem.st32(out, Number(entry.data & 0xffffffffn)); if (cpu.a64) mem.st32(out + 4, Number(entry.data >> 32n)); }
      return entry.ident;
    }
    return woken ? -1 : -3;
  } finally { l.wake = null; mem.free(pollfds); }
}
function pumpMainLooper(l: Looper): void {
  if (l.cpu.jthread !== mainThread || l.pumping) return;
  l.pumping = true;
  void (async () => {
    try {
      while (!l.cpu.finished && [...l.fds.values()].some((entry) => entry.callback)) await pollLooper(l.cpu, -1, 0n, 0n, 0n, true);
    } catch (error) { reportUncaught(error); }
    finally { l.pumping = false; }
  })();
}
const poll = (all: boolean): HostFn => async (cpu, a) => {
  const ms = a.i(), fd = a.va(), events = a.va(), data = a.va(), deadline = performance.now() + ms;
  let remaining = ms;
  for (;;) {
    const result = await pollLooper(cpu, remaining, fd, events, data);
    if (!all || result !== -2) return result;
    remaining = ms < 0 ? -1 : Math.max(0, deadline - performance.now());
  }
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

    ALooper_prepare: (cpu, a) => {
      const options = a.i();
      let h = looperOf.get(cpu);
      if (!h) { loopers.push({ cpu, pumping: false, woken: false, wake: null, fds: new Map(), allowNonCallbacks: !!(options & 1) }); looperOf.set(cpu, (h = loopers.length - 1)); }
      return h;
    },
    ALooper_forThread: (cpu) => looperOf.get(cpu) ?? 0,
    ALooper_acquire: () => {}, ALooper_release: () => {},
    ALooper_wake: (_c, a) => { const l = loopers[a.i()]; if (l) { l.woken = true; l.wake?.abort(); } },
    ALooper_addFd: (_c, a) => {
      const l = loopers[a.i()], fd = a.i(), ident = a.i(), events = a.i(), callback = a.p(), data = a.va();
      if (!l || fd < 0 || (!callback && (!l.allowNonCallbacks || ident < 0))) return -1;
      l.fds.set(fd, { ident, events, callback, data });
      l.wake?.abort();
      pumpMainLooper(l);
      return 1;
    },
    ALooper_removeFd: (_c, a) => { const l = loopers[a.i()], fd = a.i(); if (!l) return -1; const removed = l.fds.delete(fd); if (removed) l.wake?.abort(); return Number(removed); },
    ALooper_pollOnce: poll(false), ALooper_pollAll: poll(true),

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
