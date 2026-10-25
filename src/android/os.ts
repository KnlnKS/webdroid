// android.os.* + android.util.* natives.
import { processEnv } from "../shell/environment.ts";
import { appUserName, procIdentity, processTid, sysconf, uname } from "../shell/procfs.ts";
import { mem } from "../native/mem.ts";
import { mmap, munmap } from "../native/vm.ts";
import { awaited, rt, type JObj, noops, noEffect, driven, getDeclared, setDeclared, waits, type Gen } from "../jvm/runtime.ts";
import { i8, jarray, utf8 } from "../jvm/abi.ts";
import { once } from "../jvm/suspend.ts";
import { exitProcess, never } from "../process-exit.ts";
import { device } from "../shell/config.ts";
import { androidGroupId } from "./identity.ts";
import { appHost } from "./apphost.ts";
import { uuidFromString } from "../jvm/natives/jvalues.ts";
import { vcall, scall, curThread, mainThread, type JThread, newObj, after, initClass, linkClass } from "../jvm/natives/jentry.ts";
import { handle, deref } from "./handles.ts";
import { hasProperty, propertyValue } from "../shell/properties.ts";
import { type JThrowable, logUncaught, notConnected } from "../jvm/natives/jthrowable.ts";
import { checkFromIndexSize } from "../jvm/natives/jlang.ts";
import { E, ERRSTR, strerror, S_IFMT, S_IFDIR } from "../native/abi.ts";
import { is64BitProcess } from "../jvm/natives/jvmruntime.ts";
import { OS_CONSTANTS } from "./os-constants.ts";
import { pathOf, fdInt, setFdInt, mkFd } from "../jvm/natives/jio.ts";
import { vfs } from "../shell/vfs.ts";
import { filePaths, type AttributeChange } from "../shell/file-path.ts";
import { processOpenFd, processAshmemCreate, processAshmemSize, processAshmemProtect } from "../native/process-fd.ts";
import { localOpen, bytesFd, readlinkAt, resolveAt, statAt, statFd, storageStat } from "../native/fs.ts";
import { openFd, whenLastClosed, closeFd, dupFd, fdSource, fdStat, localFdStat, readFd, preadFd, writeFd, pwriteFd,
  seekFd, truncateFd, syncFd, fcntlFd, ioctlIntFd, changeFdAttributes, fdsanClose, fdsanExchangeOwnerTag, fdsanOwnerTag,
  fdsanTagType, fdsanTagValue } from "../native/fd.ts";
import { pipeFds } from "../native/pipe.ts";
import { inotifyAddWatch, inotifyInit, inotifyRmWatch } from "../native/inotify.ts";
import type { Stat } from "../native/kernel.ts";
import { type JBuffer, isBuffer, readBufferBytes, writeBufferBytes, capacity, elementShift } from "../jvm/natives/jnio.ts";
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
/** set while the zygote initializes what every app inherits: it runs as root */
let zygoteRunning = false;
export async function asZygote(init: () => unknown): Promise<void> {
  zygoteRunning = true;
  try { await init(); } finally { zygoteRunning = false; }
}
export function setProcessIdentity(pid: number, uid: number): void { procIdentity.pid = pid; procIdentity.uid = uid; }
/** the kernel thread id of a Java thread: the main thread's is the pid, as on a device */
function threadTid(t: JThread): number {
  return processTid(t, t === mainThread);
}
export function setProcessName(name: string): void { procIdentity.name = procIdentity.argv0 = name; }
/** this process's name, its package's when it was given none (the application's default process) */
export const processName = (): string => procIdentity.name || appHost?.pkg || "";
/** the other processes of the page, through the broker: kill(2) for a pid this one may signal */
export const processTransport: { signal: (pid: number, signal: number) => void | Promise<void> } = { signal: notConnected };
// Runtime.exit runs the shutdown hooks from bytecode first; halt does not. Neither returns.
rt.registerJni("java/lang/Runtime", "nativeExit(I)V", (code: number) => { exitProcess({ code: code & 0xff }); return never(); });
const SIGNAL_KILL = 9;
/** Process.sendSignal: SIGKILL ends this process, as killProcess(myPid()) does; another
 *  process's pid goes to the broker */
function sendSignal(pid: number, signal: number): void | Promise<void> {
  if (pid !== procIdentity.pid) return processTransport.signal(pid, signal);
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
// android.system.Os: the libcore syscall surface over the same descriptor table native code uses
export const errno = (fn: string, e: number): JThrowable => setDeclared(rt.mkThrowable("android/system/ErrnoException", null), "android/system/ErrnoException", { functionName: fn, errno: e });
/** `then` once `path` exists in the realm that owns it (an app's private storage lives in the system realm), else `fn`'s ErrnoException */
const existing = <T>(fn: string, path: string, then: (st: Stat) => T) => after(statAt(path), (st) => { if (typeof st === "number") throw errno(fn, -st); return then(st); });
/** libcore's StructTimespec for a time in milliseconds */
const timespec = (ms: number): JObj => setDeclared(rt.make("android/system/StructTimespec"), "android/system/StructTimespec",
  { tv_sec: BigInt(Math.floor(ms / 1000)), tv_nsec: BigInt(Math.round((ms % 1000) * 1e6)) });
export const FD = "Ljava/io/FileDescriptor;";
/** a StructStat as libcore's JNI fills one from stat(2) */
function statOf(st: Stat): JObj {
  const seconds = BigInt(Math.floor(st.mtime / 1000)), time = timespec(st.mtime);
  return setDeclared(rt.make("android/system/StructStat"), "android/system/StructStat", {
    st_dev: BigInt(st.dev), st_ino: BigInt(st.ino), st_mode: st.mode, st_nlink: BigInt(st.nlink), st_uid: st.uid, st_gid: st.gid,
    st_size: BigInt(st.size), st_blksize: BigInt(st.blksize), st_blocks: BigInt(st.blocks), st_atime: seconds, st_mtime: seconds, st_ctime: seconds,
    st_atim: time, st_mtim: time, st_ctim: time,
  });
}
/** a StructStatVfs as statvfs(2) fills it */
const structStatVfs = () => after(storageStat(), (s) => newObj("android/system/StructStatVfs", "(JJJJJJJJJJJ)V",
  BigInt(s.bsize), BigInt(s.bsize), BigInt(s.blocks), BigInt(s.bfree), BigInt(s.bfree), BigInt(s.files), BigInt(s.ffree), BigInt(s.ffree), 0n, 0n, BigInt(s.namemax)));
// libcore.io.Linux: the syscalls behind android.system.Os and Libcore.os, over the descriptor
// table native code shares
const linux: Record<string, (...args: never[]) => unknown> = {
    "open(Ljava/lang/String;II)Ljava/io/FileDescriptor;": driven(function* (path: string, flags: number): Gen {
      if (path === null) rt.npe();
      const fd = yield* awaited(processOpenFd(path, flags));
      if (fd < 0) throw errno("open", -fd);
      return yield* awaited(mkFd(fd));
    }),
    [`fstat(${FD})Landroid/system/StructStat;`]: (d: JObj | null) => after(statFd(fdInt(d)), (st) => { if (typeof st === "number") throw errno("fstat", -st); return statOf(st); }),
    [`readBytes(${FD}Ljava/lang/Object;II)I`]: waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      readBytes("read", buffer, offset, count, (target) => readFd(fdInt(d), target, count))),
    [`preadBytes(${FD}Ljava/lang/Object;IIJ)I`]: waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      readBytes("pread", buffer, offset, count, (target) => preadFd(fdInt(d), target, count, Number(position)))),
    [`writeBytes(${FD}Ljava/lang/Object;II)I`]: waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      writeBytes(buffer, offset, count, (bytes) => after(writeFd(fdInt(d), bytes), n => ioResult("write", n)))),
    [`pwriteBytes(${FD}Ljava/lang/Object;IIJ)I`]: waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      writeBytes(buffer, offset, count, (bytes) => after(pwriteFd(fdInt(d), bytes, Number(position)), n => ioResult("pwrite", n)))),
    [`ftruncate(${FD}J)V`]: (d: JObj | null, length: bigint) => after(truncateFd(fdInt(d), Number(length)), n => sys("ftruncate", n)),
    [`fsync(${FD})V`]: (d: JObj | null) => after(syncFd(fdInt(d)), n => sys("fsync", n)),
    [`fdatasync(${FD})V`]: (d: JObj | null) => after(syncFd(fdInt(d)), n => sys("fdatasync", n)),
    [`ioctlInt(${FD}I)I`]: (d: JObj | null, request: number) => after(ioctlIntFd(fdInt(d), request), n => ioResult("ioctl", n)),
    [`fcntlInt(${FD}II)I`]: (d: JObj | null, cmd: number, arg: number) => after(fcntlFd(fdInt(d), cmd, arg), n => ioResult("fcntl", n)),
    [`fcntlVoid(${FD}I)I`]: (d: JObj | null, cmd: number) => after(fcntlFd(fdInt(d), cmd, 0), n => ioResult("fcntl", n)),
    [`android_fdsan_exchange_owner_tag(${FD}JJ)V`]: (d: JObj | null, expected: bigint, tag: bigint) =>
      fdsanExchangeOwnerTag(fdInt(d), expected, tag),
    [`android_fdsan_get_owner_tag(${FD})J`]: (d: JObj | null) => fdsanOwnerTag(fdInt(d)),
    "android_fdsan_get_tag_type(J)Ljava/lang/String;": (tag: bigint) => fdsanTagType(tag),
    "android_fdsan_get_tag_value(J)J": (tag: bigint) => fdsanTagValue(tag),
    // no descriptor here is a terminal
    [`isatty(${FD})Z`]: () => 0,
    "pipe2(I)[Ljava/io/FileDescriptor;": (flags: number) => {
      const [read, write] = pipeFds(flags);
      return after(mkFd(read), (r) => after(mkFd(write), (w) => jarray([r, w], FD)));
    },
    [`sendfile(${FD}${FD}Landroid/system/Int64Ref;J)J`]: (out: JObj | null, input: JObj | null, offset: JObj | null, count: bigint) => {
      const start = offset ? Number(getDeclared<bigint>(offset, "android/system/Int64Ref", "value")) : 0;
      const n = count < 0n ? -1 : Math.min(Number(count), SENDFILE_CHUNK);
      if (n < 0 || start < 0) throw errno("sendfile", E.INVAL);
      if (!openFd(fdInt(out))) throw errno("sendfile", E.BADF);
      const scratch = new Uint8Array(n), from = fdInt(input);
      return after(offset ? preadFd(from, scratch, n, start) : readFd(from, scratch, n), (read) => {
        sys("sendfile", read);
        return after(read ? writeFd(fdInt(out), scratch.subarray(0, read)) : 0, written => {
          sys("sendfile", written);
          if (offset) setDeclared(offset, "android/system/Int64Ref", { value: BigInt(start + written) });
          return BigInt(written);
        });
      });
    },
    [`lseek(${FD}JI)J`]: driven(function* (d: JObj | null, off: bigint, whence: number): Gen {
      const r = yield* awaited(seekFd(fdInt(d), Number(off), whence));
      if (r < 0) throw errno("lseek", -r);
      return BigInt(r);
    }),
    [`close(${FD})V`]: waits((d: JObj | null) => {
      if (d === null) return rt.npe();
      const fd = fdInt(d), owner = getDeclared<bigint | undefined>(d, "java/io/FileDescriptor", "ownerId");
      setFdInt(d, -1);
      let pending: number | Promise<number> | undefined;
      const immediate = fdsanClose(fd, owner ?? 0n, fd => {
        pending = closeFd(fd);
        return pending instanceof Promise ? 0 : pending;
      });
      return after(pending ?? immediate, n => sys("close", n));
    }),
    [`dup(${FD})${FD}`]: waits((d: JObj | null) => {
      const fd = dupFd(fdInt(d));
      if (fd < 0) throw errno("dup", -fd);
      return mkFd(fd);
    }),
    [`mmap(JJII${FD}J)J`]: waits((hint: bigint, count: bigint, prot: number, flags: number, d: JObj | null, offset: bigint) =>
      after(mmap(hint, Number(count), prot, flags, fdInt(d), Number(offset)), (r) => { if (typeof r === "number" && r < 0) throw errno("mmap", -r); return BigInt(r); })),
    "munmap(JJ)V": (address: bigint, count: bigint) => sys("munmap", munmap(address, Number(count))),
    "gettid()I": () => threadTid(curThread),
    "getenv(Ljava/lang/String;)Ljava/lang/String;": (key: string) => {
      if (key === null) rt.npe();
      return processEnv[key] ?? null;
    },
    "setenv(Ljava/lang/String;Ljava/lang/String;Z)V": (key: string, value: string, overwrite: number) => {
      if (key === null || value === null) rt.npe();
      if (!key || key.includes("=")) throw errno("setenv", 22);
      if (overwrite || !(key in processEnv)) processEnv[key] = value;
    },
    "unsetenv(Ljava/lang/String;)V": (key: string) => {
      if (key === null) rt.npe();
      if (!key || key.includes("=")) throw errno("unsetenv", 22);
      delete processEnv[key];
    },
    "getpid()I": () => procIdentity.pid,
    "getuid()I": () => zygoteRunning ? 0 : procIdentity.uid,
    // bionic's passwd entry: every id has one, named as appUserName names it
    "getpwuid(I)Landroid/system/StructPasswd;": waits((uid: number) =>
      newObj("android/system/StructPasswd", "(Ljava/lang/String;IILjava/lang/String;Ljava/lang/String;)V", appUserName(uid), uid, uid, "/data", "/system/bin/sh")),
    "uname()Landroid/system/StructUtsname;": () => setDeclared(rt.make("android/system/StructUtsname"), "android/system/StructUtsname",
      (({ domainname: _, ...fields }) => fields)(uname(is64BitProcess()))),
    "sysconf(I)J": (name: number) => BigInt(sysconf(name)),
    "strerror(I)Ljava/lang/String;": strerror,
    "stat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) =>
      existing("stat", path, (st) => statOf(st)),
    "chmod(Ljava/lang/String;I)V": (path: string, mode: number) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileSetAttributes(path,{mode}), result => { sys("chmod",result); });
    },
    "chown(Ljava/lang/String;II)V": (path: string, uid: number, gid: number) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileSetAttributes(path,{uid,gid}), result => { sys("chown",result); });
    },
    // the VFS keeps no extended attributes, as a filesystem without xattr support
    "setxattr(Ljava/lang/String;Ljava/lang/String;[BI)V": (path: string, name: string) => {
      if (path === null || name === null) rt.npe();
      return existing("setxattr", path, () => { throw errno("setxattr", E.NOTSUP); });
    },
    "statvfs(Ljava/lang/String;)Landroid/system/StructStatVfs;": (path: string) => existing("statvfs", path, () => structStatVfs()),
    [`fstatvfs(${FD})Landroid/system/StructStatVfs;`]: (d: JObj | null) => {
      if (fdInt(d) < 0) throw errno("fstatvfs", E.BADF);
      return structStatVfs();
    },
    "readlink(Ljava/lang/String;)Ljava/lang/String;": (path: string) => { if (path === null) rt.npe(); return after(readlinkAt(path), (n) => { throw errno("readlink", -n); }); },
    "access(Ljava/lang/String;I)Z": (path: string, mode: number) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileAccess(path, mode), result => { sys("access", result); return 1; });
    },
    "remove(Ljava/lang/String;)V": (path: string) => { if (path === null) rt.npe(); return after(filePaths(path).fileRemove(path), n => sys("remove", n)); },
    // a new directory takes the default mode, not `mode`
    "mkdir(Ljava/lang/String;I)V": (path: string) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileMkdir(path), result => { sys("mkdir", result); });
    },
    "rename(Ljava/lang/String;Ljava/lang/String;)V": (from: string, to: string) => {
      if (from === null || to === null) rt.npe();
      return after(filePaths(from, to).fileRename(from,to), n => sys("rename", n));
    },
};
/** a -errno result as the ErrnoException libcore's Os methods throw */
export function sys(fn: string, result: number): void { if (result < 0) throw errno(fn, -result); }
export const ioResult = (fn: string, result: number): number => { sys(fn, result); return result; };
/** sendfile moves at most this much a call, which its callers loop over as Linux allows */
const SENDFILE_CHUNK = 1 << 20;
/** the Object readBytes and its kin take: a byte[], or a direct ByteBuffer addressed from its start */
export type IoBuffer = Int8Array | JBuffer | null;
function ioRegion(buffer: Int8Array | null, offset: number, count: number): Uint8Array {
  if (buffer === null) return rt.npe();
  checkFromIndexSize(offset, count, buffer.byteLength, "java/lang/ArrayIndexOutOfBoundsException");
  return new Uint8Array(buffer.buffer, buffer.byteOffset + offset, count);
}
/** Read a buffer's bytes through its canonical owner before writing them. */
export function writeBytes<T>(buffer: IoBuffer, offset: number, count: number, write: (bytes: Uint8Array) => T): T | Promise<T> {
  if (!isBuffer(buffer)) return write(ioRegion(buffer, offset, count));
  checkFromIndexSize(offset,count,capacity(buffer) * 2 ** elementShift(buffer),"java/lang/ArrayIndexOutOfBoundsException");
  return after(readBufferBytes(buffer,offset,count),write);
}
/** A direct buffer may live in guest memory, which can move while a read waits: it takes the
 *  bytes once they have arrived. */
export function readBytes(fn: string, buffer: IoBuffer, offset: number, count: number, read: (target: Uint8Array) => number | Promise<number>) {
  if (!isBuffer(buffer)) return after(read(ioRegion(buffer, offset, count)), (n) => ioResult(fn, n));
  checkFromIndexSize(offset,count,capacity(buffer) * 2 ** elementShift(buffer),"java/lang/ArrayIndexOutOfBoundsException");
  const scratch = new Uint8Array(count);
  return after(read(scratch),n => n > 0 ? after(writeBufferBytes(buffer,scratch.subarray(0,n),offset),() => ioResult(fn,n)) : ioResult(fn,n));
}
rt.registerJnis("libcore/io/Linux", linux);
// System.getenv(): the environment as alternating name and value bytes
rt.registerJni("java/lang/ProcessEnvironment", "environ()[[B", () => jarray(Object.entries(processEnv).flat().map(bytesOf), "[B"));
// Android interrupts threads blocked on the descriptor; a reader parked on a pipe here stays parked
rt.registerJni("libcore/io/AsynchronousCloseMonitor", `signalBlockedThreads(${FD})V`, () => {});

// java.io.UnixFileSystem: java.io.File's natives over the path operations (file-path.ts). There are
// no hard links.
const BA_EXISTS = 1, BA_REGULAR = 2, BA_DIRECTORY = 4;
/** the stat of a File's path, or null */
const fileStat = (p: string) => after(statAt(p), (st) => typeof st === "number" ? null : st);
/** chmod of `p` to what `to` makes of its permission bits, as UnixFileSystem_md.c's statMode and chmod */
const remode = (p: string, to: (mode: number) => number) =>
  after(fileStat(p), stat => stat ? after(filePaths(p).fileSetAttributes(p, { mode: to(stat.mode & 0o7777) }), r => +(r === 0)) : 0);
const unixFileSystem: Record<string, (...args: never[]) => unknown> = {
  "initIDs()V": () => {},
  "canonicalize0(Ljava/lang/String;Z)Ljava/lang/String;": (path: string) => vfs.canonical(path),
  "getBooleanAttributes0(Ljava/lang/String;)I": (path: string) =>
    after(fileStat(vfs.norm(path)), stat => stat ? BA_EXISTS | ((stat.mode & S_IFMT) === S_IFDIR ? BA_DIRECTORY : BA_REGULAR) : 0),
  "list0(Ljava/io/File;)[Ljava/lang/String;": (file: JObj) => {
    const p = pathOf(file);
    return after(filePaths(p).fileList(p), reply => reply.value ? jarray(reply.value, "Ljava/lang/String;") : null);
  },
  "createFileExclusively0(Ljava/lang/String;)Z": driven(function* (path: string): Gen {
    const r = yield* awaited(filePaths(path).fileCreate(path));
    if (r === -E.EXIST) return 0;
    // JNU_ThrowIOExceptionWithLastError: an IOException carrying strerror
    if (r < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-r] ?? path);
    return 1;
  }),
  "createDirectory0(Ljava/io/File;)Z": (file: JObj) => {
    const p = pathOf(file);
    return after(filePaths(p).fileMkdir(p), result => +(result === 0));
  },
  "getLastModifiedTime0(Ljava/io/File;)J": (file: JObj) => after(fileStat(pathOf(file)), stat => BigInt(stat?.mtime ?? 0)),
  "setLastModifiedTime0(Ljava/io/File;J)Z": (file: JObj, ms: bigint) => {
    const p = pathOf(file);
    return after(filePaths(p).fileSetAttributes(p, { mtime: Number(ms) }), r => +(r === 0));
  },
  // ACCESS_READ, ACCESS_WRITE and ACCESS_EXECUTE are 4, 2 and 1: the owner's bit, or everyone's
  "setPermission0(Ljava/io/File;IZZ)Z": (file: JObj, access: number, enable: number, ownerOnly: number) => {
    const bits = access * (ownerOnly ? 0o100 : 0o111);
    return remode(pathOf(file), mode => enable ? mode | bits : mode & ~bits);
  },
  "setReadOnly0(Ljava/io/File;)Z": (file: JObj) => remode(pathOf(file), mode => mode & ~0o222),
  // FileSystem.SPACE_TOTAL, SPACE_FREE, SPACE_USABLE
  "getSpace0(Ljava/io/File;I)J": (_file: JObj, kind: number) => after(storageStat(), (s) => BigInt((kind === 0 ? s.blocks : s.bfree) * s.bsize)),
  "getNameMax0(Ljava/lang/String;)J": () => 255n,
};
rt.registerJnis("java/io/UnixFileSystem", unixFileSystem);

// sun.nio.fs.UnixNativeDispatcher (UnixNativeDispatcher.c): java.nio.file's syscalls over the VFS.
// Paths arrive as NUL-terminated strings in native memory; failures throw UnixException(errno).
// There are no symbolic or hard links.
// UnixException's fillInStackTrace records nothing, so none is captured
const unixError = (e: number) => setDeclared(rt.make("sun/nio/fs/UnixException"), "sun/nio/fs/UnixException", { errno: e });
const unixSys = (result: number): number => { if (result < 0) throw unixError(-result); return result; };
const cpath = (address: bigint) => mem.cstr(mem.txVa(BigInt.asUintN(64, address)));
const bytesOf = (s: string) => i8(utf8.enc.encode(s));
const AT_REMOVEDIR = 0x200;
/** a name relative to directory descriptor `dfd`, as the *at calls resolve it */
function atPath(dfd: number, address: bigint): string {
  const path = resolveAt(dfd, cpath(address));
  if (typeof path === "number") throw unixError(-path);
  return path;
}
function fillAttrs(attrs: JObj, st: Stat): void {
  const sec = BigInt(Math.floor(st.mtime / 1000)), nsec = BigInt((st.mtime % 1000) * 1e6);
  setDeclared(attrs, "sun/nio/fs/UnixFileAttributes", { st_mode: st.mode, st_ino: BigInt(st.ino), st_dev: BigInt(st.dev), st_nlink: st.nlink, st_uid: st.uid, st_gid: st.gid,
    st_size: BigInt(st.size), st_atime_sec: sec, st_atime_nsec: nsec, st_mtime_sec: sec, st_mtime_nsec: nsec, st_ctime_sec: sec, st_ctime_nsec: nsec });
}
/** stat(2) of a path in the realm that owns it: a directory, or a file (procfs included) */
function statPath(path: string, attrs: JObj | null): number | Promise<number> {
  return after(statAt(path), (st) => {
    if (typeof st === "number") throw unixError(-st);
    if (attrs) fillAttrs(attrs, st);
    return st.mode;
  });
}
/** unlink(2) with `directory` false, rmdir(2) with true */
function removeAt(path: string, directory: boolean) {
  const p = vfs.norm(path);
  return after(filePaths(p).fileRemove(p, directory), (n) => { unixSys(n); });
}
/** chmod, chown and utimes; the VFS keeps modification times only, which utimes gives in microseconds */
const changePath = (path: string, change: AttributeChange) => after(filePaths(path).fileSetAttributes(path, change), (n) => { unixSys(n); });
const changeFd = (fd: number, change: AttributeChange) => after(changeFdAttributes(fd, change), (n) => { unixSys(n); });
const fdPath = (fd: number) => after(fdStat(fd), st => { if (!st) throw unixError(E.BADF); return st.path ?? ""; });
/** open DIR streams: the entries as readdir(3) returns them, and the descriptor closedir closes */
const dirStreams = new Map<bigint, { names: string[]; i: number; fd: number }>();
let nextDir = 0n;
function openDirStream(path: string, fd: number) {
  const p = vfs.norm(path);
  return after(filePaths(p).fileList(p), ({ errno, value }) => {
    if (!value) throw unixError(errno);
    dirStreams.set(++nextDir, { names: [".", "..", ...value], i: 0, fd });
    return nextDir;
  });
}
const passwdName = (id: number) => bytesOf(appUserName(id));
const unixNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  // SUPPORTS_OPENAT | SUPPORTS_FUTIMES: bionic has openat64, fstatat64, unlinkat, renameat, futimesat
  // and fdopendir. UnixException is initialized first, since the natives throw it synchronously.
  "init()I": waits(() => after(initClass("sun/nio/fs/UnixException"), () => 6)),
  "getcwd()[B": () => bytesOf("/"),
  "strerror(I)[B": (e: number) => bytesOf(strerror(e)),
  "dup(I)I": (fd: number) => unixSys(dupFd(fd)),
  "open0(JII)I": (path: bigint, flags: number) => after(processOpenFd(cpath(path),flags),unixSys),
  "openat0(IJII)I": (dfd: number, path: bigint, flags: number) => after(processOpenFd(atPath(dfd,path),flags),unixSys),
  "close(I)V": (fd: number) => after(closeFd(fd),n => {unixSys(n);}),
  "link0(JJ)V": () => { throw unixError(E.PERM); },
  "symlink0(JJ)V": () => { throw unixError(E.PERM); },
  "unlink0(J)V": (path: bigint) => removeAt(cpath(path), false),
  "unlinkat0(IJI)V": (dfd: number, path: bigint, flags: number) => removeAt(atPath(dfd, path), !!(flags & AT_REMOVEDIR)),
  "rename0(JJ)V": (from: bigint, to: bigint) => { const a = cpath(from), b = cpath(to); return after(filePaths(a, b).fileRename(a, b), (n) => { unixSys(n); }); },
  "renameat0(IJIJ)V": (fromDir: number, from: bigint, toDir: number, to: bigint) => { const a = atPath(fromDir, from), b = atPath(toDir, to); return after(filePaths(a, b).fileRename(a, b), (n) => { unixSys(n); }); },
  "mkdir0(JI)V": (path: bigint) => { const p = cpath(path); return after(filePaths(p).fileMkdir(p), (n) => { unixSys(n); }); },
  "rmdir0(J)V": (path: bigint) => removeAt(cpath(path), true),
  "readlink0(J)[B": waits((path: bigint) => after(readlinkAt(cpath(path)), (n) => { throw unixError(-n); })),
  "realpath0(J)[B": waits((path: bigint) => { const p = vfs.norm(cpath(path)); return after(statPath(p, null), () => bytesOf(p)); }),
  "stat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), attrs), () => {}),
  "lstat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), attrs), () => {}),
  "stat1(J)I": (path: bigint) => after(statAt(cpath(path)), (st) => typeof st === "number" ? 0 : st.mode),
  "fstatat0(IJILsun/nio/fs/UnixFileAttributes;)V": (dfd: number, path: bigint, _flag: number, attrs: JObj) => after(statPath(atPath(dfd, path), attrs), () => {}),
  "fstat(ILsun/nio/fs/UnixFileAttributes;)V": (fd: number, attrs: JObj) => after(statFd(fd), st => {
    if (typeof st === "number") throw unixError(-st);
    fillAttrs(attrs, st);
  }),
  "chmod0(JI)V": (path: bigint, mode: number) => changePath(cpath(path), { mode }),
  "fchmod(II)V": (fd: number, mode: number) => changeFd(fd, { mode }),
  "chown0(JII)V": (path: bigint, uid: number, gid: number) => changePath(cpath(path), { uid, gid }),
  "lchown0(JII)V": (path: bigint, uid: number, gid: number) => changePath(cpath(path), { uid, gid }),
  "fchown(III)V": (fd: number, uid: number, gid: number) => changeFd(fd, { uid, gid }),
  "utimes0(JJJ)V": (path: bigint, _accessed: bigint, modified: bigint) => changePath(cpath(path), { mtime: Number(modified / 1000n) }),
  "futimes(IJJ)V": (fd: number, _accessed: bigint, modified: bigint) => changeFd(fd, { mtime: Number(modified / 1000n) }),
  "opendir0(J)J": (path: bigint) => openDirStream(cpath(path), -1),
  "fdopendir(I)J": (fd: number) => after(fdPath(fd), path => openDirStream(path, fd)),
  "closedir(J)V": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    dirStreams.delete(dir);
    if (stream.fd >= 0) return after(closeFd(stream.fd), n => { unixSys(n); });
  },
  "readdir(J)[B": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    return stream.i < stream.names.length ? bytesOf(stream.names[stream.i++]) : null;
  },
  "access0(JI)V": (path: bigint, mode: number) => { const p = cpath(path); return after(filePaths(p).fileAccess(p, mode), (n) => { unixSys(n); }); },
  "exists0(J)Z": (path: bigint) => { const p = cpath(path); return after(filePaths(p).fileAccess(p, 0), (n) => +(n === 0)); },
  "getpwuid(I)[B": passwdName,
  "getgrgid(I)[B": passwdName,
  "statvfs0(JLsun/nio/fs/UnixFileStoreAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), null), () => after(storageStat(), (s) => {
    setDeclared(attrs, "sun/nio/fs/UnixFileStoreAttributes", { f_frsize: BigInt(s.bsize), f_blocks: BigInt(s.blocks), f_bfree: BigInt(s.bfree), f_bavail: BigInt(s.bfree) });
  })),
};
rt.registerJnis("sun/nio/fs/UnixNativeDispatcher", unixNativeDispatcher);
// LinuxNativeDispatcher.c: the VFS stores no extended attributes, and its only mount table would be
// a file some app wrote (there is no /proc/mounts)
const mountTables = new Map<bigint, string[][]>();
let nextMountTable = 0n;
const linuxNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  "init()V": () => {},
  "flistxattr(IJI)I": (fd: number) => { fdPath(fd); return 0; },
  "fgetxattr0(IJJI)I": (fd: number) => { fdPath(fd); throw unixError(E.NODATA); },
  "fremovexattr0(IJ)V": (fd: number) => { fdPath(fd); throw unixError(E.NODATA); },
  "fsetxattr0(IJJI)V": (fd: number) => { fdPath(fd); throw unixError(E.NOTSUP); },
  "setmntent0(JJ)J": (path: bigint) => {
    const text = vfs.read(cpath(path));
    if (!text) throw unixError(E.NOENT);
    mountTables.set(++nextMountTable, utf8.dec.decode(text).split("\n").map((line) => line.trim().split(/\s+/)).filter((f) => f.length >= 4 && !f[0].startsWith("#")));
    return nextMountTable;
  },
  "getmntent(JLsun/nio/fs/UnixMountEntry;)I": (table: bigint, entry: JObj) => {
    const fields = mountTables.get(table)?.shift();
    if (!fields) return -1;
    setDeclared(entry, "sun/nio/fs/UnixMountEntry", { name: bytesOf(fields[0]), dir: bytesOf(fields[1]), fstype: bytesOf(fields[2]), opts: bytesOf(fields[3]) });
    return 0;
  },
  "endmntent(J)V": (table: bigint) => { mountTables.delete(table); },
};
rt.registerJnis("sun/nio/fs/LinuxNativeDispatcher", linuxNativeDispatcher);
// UnixCopyFile.c: read(2) and write(2) until the source's end, checking the cancel flag between reads
rt.registerJni("sun/nio/fs/UnixCopyFile", "transfer(IIJ)V", driven(function* (dst: number, src: number, cancel: bigint): Gen {
  const buffer = new Uint8Array(1 << 16);
  for (;;) {
    const n = unixSys(yield* awaited(readFd(src, buffer, buffer.length)));
    if (!n) return;
    if (cancel && mem.ld32(mem.txVa(cancel))) throw unixError(E.CANCELED);
    for (let at = 0; at < n;) at += unixSys(yield* awaited(writeFd(dst, buffer.subarray(at, n))));
  }
}));
// libcore's OsConstants fills its fields from native initConstants(); these are the reference
// device's values (pnpm gen-framework)
rt.registerJni("android/system/OsConstants", "initConstants()V", () => {
  const constants = linkClass("android/system/OsConstants");
  constants.setStatics(Object.entries(OS_CONSTANTS), "I");
});
