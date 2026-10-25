// android.os.* and android.util.* natives: the process's identity, signals and memory,
// SystemClock, Trace, Debug, SystemProperties, ParcelFileDescriptor, SharedMemory over ashmem
// and FileObserver over inotify.
import { procIdentity } from "../shell/procfs.ts";
import { mem } from "../native/mem.ts";
import { awaited, rt, type JObj, noops, noEffect, driven, setDeclared, waits, type Gen } from "../jvm/runtime.ts";
import { jarray, utf8 } from "../jvm/abi.ts";
import { once } from "../jvm/suspend.ts";
import { exitProcess, never } from "../process-exit.ts";
import { device } from "../shell/config.ts";
import { androidGroupId } from "./identity.ts";
import { appHost } from "./apphost.ts";
import { uuidFromString } from "../jvm/natives/jvalues.ts";
import { vcall, scall, curThread, newObj, after } from "../jvm/natives/jentry.ts";
import { handle, deref } from "./handles.ts";
import { hasProperty, propertyValue } from "../shell/properties.ts";
import { logUncaught } from "../jvm/natives/jthrowable.ts";
import { processLife } from "../shell/broker-access.ts";
import { E } from "../native/abi.ts";
import { fdInt, mkFd } from "../jvm/natives/jio.ts";
import { FD, sys, threadTid } from "../jvm/natives/linux.ts";
import { vfs } from "../shell/vfs.ts";
import { processAshmemCreate, processAshmemSize, processAshmemProtect } from "../native/process-fd.ts";
import { localOpen, bytesFd } from "../native/fs.ts";
import { openFd, whenLastClosed, fdSource, localFdStat, readFd } from "../native/fd.ts";
import { inotifyAddWatch, inotifyInit, inotifyRmWatch } from "../native/inotify.ts";
import { uptimeMillis, wallMillis } from "../guest-clock.ts";

// APerformanceHint as the reference AVD's power HAL answers it (dumpsys performance_hint: HAL
// support, a 1 ms preferred rate). A hint only advises the scheduler, so a session keeps its
// threads and nothing else. libandroid's APerformanceHint (native/libandroid.ts) shares the sessions.
export const HINT_RATE_NANOS = 1_000_000n;
export const hintSessions = new Map<number, Int32Array>();
let nextHintSession = 1;
export function openHintSession(tids: Int32Array): number { hintSessions.set(nextHintSession, tids.slice()); return nextHintSession++; }
rt.registerJnis("android/os/PerformanceHintManager", {
  "nativeAcquireManager()J": () => 1n,
  "nativeGetPreferredUpdateRateNanos(J)J": () => HINT_RATE_NANOS,
  "nativeCreateSession(J[IJ)J": (_manager: bigint, tids: Int32Array) => BigInt(openHintSession(tids)),
  "nativeGetThreadIds(J)[I": (session: bigint) => hintSessions.get(Number(session))?.slice() ?? new Int32Array(0),
  "nativeSetThreads(J[I)V": (session: bigint, tids: Int32Array) => { hintSessions.set(Number(session), tids.slice()); },
  "nativeCloseSession(J)V": (session: bigint) => { hintSessions.delete(Number(session)); },
  ...noops("nativeUpdateTargetWorkDuration(JJ)V", "nativeReportActualWorkDuration(JJ)V", "nativeReportActualWorkDuration(JJJJJ)V",
    "nativeSendHint(JI)V", "nativeSetPreferPowerEfficiency(JZ)V"),
});


const RUNTIME_STATS = ["art.gc.gc-count", "art.gc.gc-time", "art.gc.bytes-allocated", "art.gc.bytes-freed", "art.gc.blocking-gc-count", "art.gc.blocking-gc-time", "art.gc.gc-count-rate-histogram", "art.gc.blocking-gc-count-rate-histogram"];
// ── SystemClock / Process / Trace / Debug
const nanos = (ms: number) => BigInt(Math.floor(ms * 1e6));
rt.registerJnis("android/os/SystemClock", {
  "uptimeMillis()J": () => BigInt(Math.floor(uptimeMillis())),
  "elapsedRealtime()J": () => BigInt(Math.floor(uptimeMillis())),
  "elapsedRealtimeNanos()J": () => nanos(uptimeMillis()),
  "uptimeNanos()J": () => nanos(uptimeMillis()),
  "currentThreadTimeMillis()J": () => BigInt(Math.floor(performance.now())),
  "currentThreadTimeMicro()J": () => BigInt(Math.floor(performance.now() * 1e3)),
  "currentTimeMicro()J": () => BigInt(Math.floor(wallMillis() * 1e3)),
});
/** system_server's pid: the page realm's process, which outlives every other */
export const SYSTEM_SERVER_PID = 1000;
export function setProcessIdentity(pid: number, uid: number): void { procIdentity.pid = pid; procIdentity.uid = uid; }
export function setProcessName(name: string): void { procIdentity.name = procIdentity.argv0 = name; }
/** this process's name, its package's when it was given none (the application's default process) */
export const processName = (): string => procIdentity.name || appHost?.pkg || "";
// Runtime.exit runs the shutdown hooks from bytecode first; halt does not. Neither returns.
rt.registerJni("java/lang/Runtime", "nativeExit(I)V", (code: number) => { exitProcess({ code: code & 0xff }); return never(); });
const SIGNAL_KILL = 9;
/** Process.sendSignal: SIGKILL ends this process, as killProcess(myPid()) does; another
 *  process's pid goes to the broker */
function sendSignal(pid: number, signal: number): void | Promise<void> {
  if (pid !== procIdentity.pid) return processLife.signal(pid, signal);
  if (signal !== SIGNAL_KILL) return;
  exitProcess({ signal });
  return never();
}
const threadPriorities = new Map<number, number>();
/** the device profile's memory in bytes, half of it free as /proc/meminfo's MemFree has it */
export const totalMemory = (): bigint => BigInt(device.cpu.memKb) * 1024n;
export const freeMemory = (): bigint => totalMemory() / 2n;
const idForName = (name: string | null) => androidGroupId(name ?? rt.npe());
rt.registerJnis("android/os/Process", {
  "getElapsedCpuTime()J": () => BigInt(Math.round(performance.now())),
  "getGidForName(Ljava/lang/String;)I": idForName,
  "getUidForName(Ljava/lang/String;)I": idForName,
  // setpriority(PRIO_PROCESS, tid): recorded, since the JS engine schedules every thread itself
  "setThreadPriority(II)V": (tid: number, priority: number) => { threadPriorities.set(tid, priority); },
  "setThreadPriority(I)V": (priority: number) => { threadPriorities.set(threadTid(curThread), priority); },
  "getThreadPriority(I)I": (tid: number) => threadPriorities.get(tid) ?? 0,
  "getThreadScheduler(I)I": () => 0,
  "setThreadScheduler(III)V": () => {},
  "setCanSelfBackground(Z)V": () => {},
  "setThreadGroup(II)V": () => {}, "setThreadGroupAndCpuset(II)V": () => {},
  "setArgV0Native(Ljava/lang/String;)V": (argv0: string) => { procIdentity.argv0 = argv0; },
  "getTotalMemory()J": totalMemory,
  "getFreeMemory()J": freeMemory,
  "sendSignal(II)V": sendSignal,
  "sendSignalQuiet(II)V": sendSignal,
});
// android.os.Trace runs from bytecode over atrace's natives: nothing traces this page, so no tag is
// enabled and every event is dropped, as atrace drops them with no tracing session
rt.registerJnis("android/os/Trace", {
  "nativeIsTagEnabled(J)Z": () => 0,
  ...noEffect("nativeAsyncTraceBegin(JLjava/lang/String;I)V", "nativeAsyncTraceEnd(JLjava/lang/String;I)V",
    "nativeAsyncTraceForTrackBegin(JLjava/lang/String;Ljava/lang/String;I)V", "nativeAsyncTraceForTrackEnd(JLjava/lang/String;I)V",
    "nativeInstant(JLjava/lang/String;)V", "nativeInstantForTrack(JLjava/lang/String;Ljava/lang/String;)V", "nativeRegisterWithPerfetto()V",
    "nativeSetAppTracingAllowed(Z)V", "nativeSetTracingEnabled(Z)V", "nativeTraceBegin(JLjava/lang/String;)V",
    "nativeTraceCounter(JLjava/lang/String;J)V", "nativeTraceEnd(J)V"),
});
/** the JS heap in KiB, the nearest thing to this process's dalvik footprint */
const jsHeapKb = () => (((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024) | 0;
const MI = "android/os/Debug$MemoryInfo";
/** this process's memory, as debuggerd reads it from smaps: nothing here is shared */
function memoryInfo(info: JObj | null): void {
  const kb = jsHeapKb(), native = Math.round(mem.stats().used / 1024);
  setDeclared(info ?? rt.npe(), MI, { dalvikPss: kb, dalvikPrivateDirty: kb, nativePss: native, nativePrivateDirty: native });
}
rt.registerJnis("android/os/Debug", {
  // the native heap is the guest allocator's: bytes in use, the extent it has reached, and the gap
  "getNativeHeapAllocatedSize()J": () => BigInt(Math.round(mem.stats().used)),
  "getNativeHeapSize()J": () => BigInt(Math.round(mem.stats().peak)),
  "getNativeHeapFreeSize()J": () => BigInt(Math.max(0, Math.round(mem.stats().peak - mem.stats().used))),
  "getPss()J": () => BigInt(jsHeapKb()),
  "getMemoryInfo(Landroid/os/Debug$MemoryInfo;)V": memoryInfo,
  // another process's smaps are not this page's to read
  "getMemoryInfo(ILandroid/os/Debug$MemoryInfo;)Z": (pid: number, info: JObj | null) => pid === procIdentity.pid ? (memoryInfo(info), 1) : 0,
});
// ART's debugger and runtime counters: no debugger attaches, and nothing here collects, blocks or
// compacts, so every runtime stat is zero
rt.registerJnis("dalvik/system/VMDebug", {
  "isDebuggerConnected()Z": () => 0,
  "isDebuggingEnabled()Z": () => 0,
  "lastDebuggerActivity()J": () => -1n,
  "threadCpuTimeNanos()J": () => nanos(performance.now()),
  "getAllocCount(I)I": () => 0,
  "getRuntimeStatInternal(I)Ljava/lang/String;": () => "0",
  "getRuntimeStatsInternal()[Ljava/lang/String;": () => jarray(RUNTIME_STATS.map(() => "0"), "Ljava/lang/String;"),
});
// android.os.SystemProperties: an app process may not set properties, and a change report runs
// the registered callbacks, as the property service's own notification does
/** android_os_SystemProperties.cpp's readers: an absent or unparsable value is the default */
const propInt = (v: string | null, def: number) => v !== null && /^-?\d+$/.test(v.trim()) ? Number(BigInt.asIntN(32, BigInt(v.trim()))) : def;
const propLong = (v: string | null, def: bigint) => v !== null && /^-?\d+$/.test(v.trim()) ? BigInt.asIntN(64, BigInt(v.trim())) : def;
const propBool = (v: string | null, def: number) => v === null ? def : /^(1|y|yes|on|true)$/.test(v) ? 1 : /^(0|n|no|off|false)$/.test(v) ? 0 : def;
/** a property handle (SystemProperties.find) names a property the device has */
const propAt = (h: bigint) => propertyValue(deref<{ key: string }>(h).key);
rt.registerJnis("android/os/SystemProperties", {
  "native_get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (key: string, def: string | null) => propertyValue(key) ?? def ?? "",
  "native_get_boolean(Ljava/lang/String;Z)Z": (key: string, def: number) => propBool(propertyValue(key), def),
  "native_get_int(Ljava/lang/String;I)I": (key: string, def: number) => propInt(propertyValue(key), def),
  "native_get_long(Ljava/lang/String;J)J": (key: string, def: bigint) => propLong(propertyValue(key), def),
  "native_find(Ljava/lang/String;)J": (key: string) => hasProperty(key) ? handle({ key }) : 0n,
  "native_get(J)Ljava/lang/String;": (h: bigint) => propAt(h) ?? "",
  "native_get_boolean(JZ)Z": (h: bigint, def: number) => propBool(propAt(h), def),
  "native_get_int(JI)I": (h: bigint, def: number) => propInt(propAt(h), def),
  "native_get_long(JJ)J": (h: bigint, def: bigint) => propLong(propAt(h), def),
  "native_set(Ljava/lang/String;Ljava/lang/String;)V": () => {
    throw rt.mkThrowable("java/lang/RuntimeException", "failed to set system property (check logcat for reason)");
  },
  "native_add_change_callback()V": () => {},
  // reached only from SystemProperties itself, which is therefore initialized
  "native_report_sysprop_change()V": () => scall("android/os/SystemProperties", "callChangeCallbacks", "()V"),
});
// ParcelFileDescriptor runs from AOSP bytecode over libcore's descriptors. Bytes with no file of
// this process behind them (an asset, a picked document, another process's descriptor) get one here.
type PfdBacking = { path: string; refs: number; closing: Promise<void> | null };
let pfdBackingSeq = 0;
const pfdBackings = new Map<string, PfdBacking>();
/** the bytes of the backing file descriptors opened under `key` share, null when none is open */
export const pfdBackingBytes = driven(function* pfdBackingBytes(key: string): Gen<Uint8Array | null> {
  const backing = pfdBackings.get(key);
  if (backing?.closing) { yield backing.closing; return null; }
  return backing ? vfs.read(backing.path) : null;
});
/** A descriptor over `bytes`: read-only, or, given a `sink`, read-write over a file that hands its
 *  bytes to `sink` once the last descriptor on it closes. Descriptors opened under one `key` while
 *  one is open share its file. */
export function fdOverBytes(bytes: Uint8Array, sink: ((b: Uint8Array) => unknown) | null = null, key?: string): number {
  if (!sink) return bytesFd(bytes);
  let backing = key === undefined ? undefined : pfdBackings.get(key);
  if (!backing || backing.closing) {
    backing = { path: `/data/webdroid-pfd-${++pfdBackingSeq}`, refs: 0, closing: null };
    if (key !== undefined) pfdBackings.set(key, backing);
    vfs.write(backing.path, bytes, false);
    vfs.markVolatile(backing.path);
  }
  const shared = backing, fd = localOpen(shared.path, 2);
  shared.refs++;
  whenLastClosed(fd, () => {
    if (--shared.refs) return;
    shared.closing = (async () => {
      try { await sink(vfs.read(shared.path) ?? new Uint8Array(0)); }
      finally {
        if (key !== undefined && pfdBackings.get(key) === shared) pfdBackings.delete(key);
        vfs.delete(shared.path, false);
      }
    })().catch(logUncaught);
  });
  return fd;
}
// The region belongs to the open backing, including dup'd descriptors and retained mappings.
const regionOf = (fd: number) => openFd(fd)?.content.ashmem;
/** an ashmem region's protection, undefined for a descriptor on anything else */
export const ashmemProt = (fd: number): number | undefined => regionOf(fd)?.prot;
/** a descriptor on a new region holding `bytes`, which hands them to `sink` once the last descriptor closes */
export function ashmemFd(bytes: Uint8Array, prot = 7, sink: ((b: Uint8Array) => unknown) | null = null): number {
  const fd = fdOverBytes(bytes, sink ?? (() => {}));
  openFd(fd)!.content.ashmem = { prot };
  return fd;
}
// libcutils' ashmem calls, which SharedMemory's natives and libandroid's ASharedMemory both make
/** ashmem_create_region: a descriptor on a new region of zeros, or -errno */
export const ashmemCreate = (size: number): number | Promise<number> => processAshmemCreate(size) ?? ashmemFd(new Uint8Array(size));
/** ashmem_get_size_region: -1 for a descriptor on anything else */
export const ashmemSize = (fd: number): number | Promise<number> => processAshmemSize(fd) ?? (regionOf(fd) ? localFdStat(fd)!.size : -1);
/** ashmem_set_prot_region: 0 or -errno; a region's protection only narrows */
export function ashmemSetProt(fd: number, prot: number): number | Promise<number> {
  const pending = processAshmemProtect(fd, prot);
  if (pending) return pending;
  const region = regionOf(fd);
  if (!region) return -E.NOTTY;
  if (prot & ~region.prot) return -E.INVAL;
  region.prot = prot;
  return 0;
}
rt.registerJnis("android/os/SharedMemory", {
  "nCreate(Ljava/lang/String;I)Ljava/io/FileDescriptor;": waits((_name: string | null, size: number) => after(ashmemCreate(size), fd => { sys("ashmem_create_region", fd); return mkFd(fd); })),
  "nGetSize(Ljava/io/FileDescriptor;)I": waits((d: JObj | null) => ashmemSize(fdInt(d))),
  "nSetProt(Ljava/io/FileDescriptor;I)I": waits((d: JObj | null, prot: number) => after(ashmemSetProt(fdInt(d), prot), n => -n)),
});
// FileObserver's inotify instance, over the descriptor table's, which the VFS reports its changes to
rt.registerJnis("android/os/FileObserver$ObserverThread", {
  "init()I": () => inotifyInit(),
  // android_os_FileObserver.cpp's loop: each event to onEvent(wd, mask, name) until a read fails
  "observe(I)V": driven(function* (this: JObj, fd: number): Gen {
    const buf = new Uint8Array(512), view = new DataView(buf.buffer);
    for (let n: number; (n = yield* awaited(readFd(fd, buf, buf.length))) >= 16;) {
      for (let at = 0; at + 16 <= n;) {
        const len = view.getUint32(at + 12, true), name = buf.subarray(at + 16, at + 16 + len);
        const path = len ? utf8.dec.decode(name.subarray(0, name.indexOf(0) < 0 ? len : name.indexOf(0))) : null;
        try { yield vcall(this, "onEvent", "(IILjava/lang/String;)V", view.getInt32(at, true), view.getInt32(at + 4, true), path); }
        catch (error) { logUncaught(error); }
        at += 16 + len;
      }
    }
  }),
  "startWatching(I[Ljava/lang/String;I[I)V": (fd: number, paths: string[], mask: number, wfds: Int32Array) => {
    paths.forEach((path, i) => { wfds[i] = fd < 0 ? -1 : Math.max(-1, inotifyAddWatch(fd, path, mask)); });
  },
  "stopWatching(I[I)V": (fd: number, wfds: Int32Array) => { for (const wd of wfds) if (wd >= 0) inotifyRmWatch(fd, wd); },
});
/** a ParcelFileDescriptor over bytes, as fdOverBytes opens them */
export const mkPfd = (bytes: Uint8Array, sink: ((b: Uint8Array) => unknown) | null = null, key?: string): JObj | Promise<JObj> =>
  after(mkFd(fdOverBytes(bytes, sink, key)), (fd) => newObj("android/os/ParcelFileDescriptor", `(${FD})V`, fd));
/** what a descriptor's file holds, whatever its offset; null for one with no file (a pipe, a socket) */
export const fdContents = (fd: number): Uint8Array | null | Promise<Uint8Array | null> =>
  after(fdSource(fd), source => source && source.read(0, source.size));
/** the bytes a ParcelFileDescriptor's file holds */
export const pfdContents = driven(function* pfdContents(pfd: JObj): Gen<Uint8Array | null> {
  return yield* awaited(fdContents(fdInt(yield vcall(pfd, "getFileDescriptor", `()${FD}`))));
});

// the internal storage volume, identified by the platform's default UUID (StorageManager.UUID_DEFAULT)
export const uuidDefault = once(() => uuidFromString("41217664-9172-527a-b3d5-edabb50a7d69"));
