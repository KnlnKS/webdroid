// android.os.* + android.util.* natives.
import { readFully } from "../shell/lazyfile";
import { processEnv } from "../shell/environment";
import { appUserName, procIdentity, processTid, sysconf, uname } from "../shell/procfs";
import { guestAt, mem } from "../native/mem";
import { syncShared, trackSharedMap, trackPrivateMap } from "../native/mappings";
import { awaited, rt, JObj, noops, driven, declaredField, setDeclared, type Gen } from "../jvm/runtime";
import { i8, jarray, utf8 } from "../jvm/abi";
import { once } from "../jvm/suspend";
import { exitProcess, never } from "../process-exit";
import { device } from "../shell/config";
import { androidGroupId } from "./identity";
import { uuidFromString } from "../jvm/natives/jvalues";
import { vcall, curThread, mainThread, JThread, newObj, after, initClass, linkClass } from "../jvm/natives/jentry";
import { JThrowable, logUncaught } from "../jvm/natives/jthrowable";
import { checkFromIndexSize } from "../jvm/natives/jlang";
import { E, ERRSTR, strerror } from "../native/abi";
import { is64BitProcess } from "../jvm/natives/jvmruntime";
import { OS_CONSTANTS } from "./os-constants";
import { pathOf, fdInt, setFdInt, mkFd } from "../jvm/natives/jio";
import { vfs, storageEstimate, type FileAttributes } from "../shell/vfs";
import { remoteFilePath, changeFileAttributes, pathStat, type PathStat } from "../shell/file-path";
import { processOpenFd, processCloseFd, processReadFd, processPreadFd, processWriteFd, processPwriteFd, processSeekFd, processTruncateFd, processSyncFd, processFcntlFd, processFdStat, processIoctlIntFd, processAshmemCreate, processAshmemSize, processAshmemProtect, processMapping, isRemoteFd, descriptorTransport } from "../native/process-fd";
import { openFd, javaOnLastClose, javaOpenFd, javaCloseFd, javaDupFd, javaBytesFd, javaFdSource, javaFdStat, javaPipeFds, javaReadFd, javaPreadFd, javaWriteFd, fdFile, inoOf, accessPath, createPath, mkdirPath, removePath, renamePath } from "../native/fs";
import { fdsanClose, fdsanExchangeOwnerTag, fdsanOwnerTag, fdsanTagType, fdsanTagValue } from "../native/fd";
import { type JBuffer, isBuffer, readBufferBytes, writeBufferBytes, capacity, elementShift } from "../jvm/natives/jnio";
import { isExternal, mapRemote, unmapExternal } from "../jvm/natives/jmemory";
import { uptimeMillis, wallMillis } from "../guest-clock";

// APerformanceHint as the reference AVD's power HAL answers it (dumpsys performance_hint: HAL
// support, a 1 ms preferred rate). A hint only advises the scheduler, so a session keeps its
// threads and nothing else.
const hintSessions = new Map<bigint, Int32Array>();
let nextHintSession = 1n;
rt.registerJnis("android/os/PerformanceHintManager", {
  "nativeAcquireManager()J": () => 1n,
  "nativeGetPreferredUpdateRateNanos(J)J": () => 1_000_000n,
  "nativeCreateSession(J[IJ)J": (_manager: bigint, tids: Int32Array) => { hintSessions.set(nextHintSession, tids.slice()); return nextHintSession++; },
  "nativeGetThreadIds(J)[I": (session: bigint) => hintSessions.get(session)?.slice() ?? new Int32Array(0),
  "nativeSetThreads(J[I)V": (session: bigint, tids: Int32Array) => { hintSessions.set(session, tids.slice()); },
  "nativeCloseSession(J)V": (session: bigint) => { hintSessions.delete(session); },
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
export let PROCESS_PID = 1000, PROCESS_UID = 10001;
export let PROCESS_NAME = "";
/** set while the zygote initializes what every app inherits: it runs as root */
let zygoteRunning = false;
export async function asZygote(init: () => unknown): Promise<void> {
  zygoteRunning = true;
  try { await init(); } finally { zygoteRunning = false; }
}
export function setProcessIdentity(pid: number, uid: number): void { PROCESS_PID = pid; PROCESS_UID = uid; procIdentity.pid = pid; procIdentity.uid = uid; }
/** the kernel thread id of a Java thread: the main thread's is the pid, as on a device */
function threadTid(t: JThread): number {
  return processTid(t, t === mainThread);
}
export function setProcessName(name: string): void { PROCESS_NAME = name; procIdentity.name = name; }
/** the other processes of the page, through the broker: kill(2) for a pid this one may signal */
export const processTransport = { signal: (_pid: number, _signal: number): void | Promise<void> => {} };
// Runtime.exit runs the shutdown hooks from bytecode first; halt does not. Neither returns.
rt.registerJni("java/lang/Runtime", "nativeExit(I)V", (code: number) => { exitProcess({ code: code & 0xff }); return never(); });
const SIGNAL_KILL = 9;
/** Process.sendSignal: SIGKILL ends this process, as killProcess(myPid()) does; another
 *  process's pid goes to the broker */
function sendSignal(pid: number, signal: number): void | Promise<void> {
  if (pid !== PROCESS_PID) return processTransport.signal(pid, signal);
  if (signal !== SIGNAL_KILL) return;
  exitProcess({ signal });
  return never();
}
const threadPriorities = new Map<number, number>();
const totalMemory = () => BigInt(device.cpu.memKb) * 1024n;
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
  "setArgV0Native(Ljava/lang/String;)V": (name: string) => { procIdentity.name = name; },
  "getTotalMemory()J": totalMemory,
  "getFreeMemory()J": () => totalMemory() / 2n,
  "sendSignal(II)V": sendSignal,
  "sendSignalQuiet(II)V": sendSignal,
});
// android.os.Trace runs from bytecode over atrace's natives: nothing traces this page, so no tag is
// enabled and every event is dropped, as atrace drops them with no tracing session
rt.registerJnis("android/os/Trace", {
  "nativeIsTagEnabled(J)Z": () => 0,
  ...Object.fromEntries(["nativeAsyncTraceBegin(JLjava/lang/String;I)V", "nativeAsyncTraceEnd(JLjava/lang/String;I)V",
    "nativeAsyncTraceForTrackBegin(JLjava/lang/String;Ljava/lang/String;I)V", "nativeAsyncTraceForTrackEnd(JLjava/lang/String;I)V",
    "nativeInstant(JLjava/lang/String;)V", "nativeInstantForTrack(JLjava/lang/String;Ljava/lang/String;)V", "nativeRegisterWithPerfetto()V",
    "nativeSetAppTracingAllowed(Z)V", "nativeSetTracingEnabled(Z)V", "nativeTraceBegin(JLjava/lang/String;)V",
    "nativeTraceCounter(JLjava/lang/String;J)V", "nativeTraceEnd(J)V"].map((sig) => [sig, () => {}])),
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
  "getMemoryInfo(ILandroid/os/Debug$MemoryInfo;)Z": (pid: number, info: JObj | null) => pid === PROCESS_PID ? (memoryInfo(info), 1) : 0,
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
  if (!sink) return javaBytesFd(bytes);
  let backing = key === undefined ? undefined : pfdBackings.get(key);
  if (!backing || backing.closing) {
    backing = { path: `/data/webdroid-pfd-${++pfdBackingSeq}`, refs: 0, closing: null };
    if (key !== undefined) pfdBackings.set(key, backing);
    vfs.markVolatile(backing.path);
    vfs.write(backing.path, bytes, false);
  }
  const shared = backing, fd = javaOpenFd(shared.path, 2);
  shared.refs++;
  javaOnLastClose(fd, () => {
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
rt.registerJnis("android/os/SharedMemory", {
  "nCreate(Ljava/lang/String;I)Ljava/io/FileDescriptor;": (_name: string | null, size: number) => after(processAshmemCreate(size) ?? ashmemFd(new Uint8Array(size)),fd => { sys("ashmem_create_region",fd); return mkFd(fd); }),
  "nGetSize(Ljava/io/FileDescriptor;)I": (d: JObj | null) => { const fd = fdInt(d); return processAshmemSize(fd) ?? (regionOf(fd) ? javaFdStat(fd)!.size : -1); },
  "nSetProt(Ljava/io/FileDescriptor;I)I": (d: JObj | null, prot: number) => {
    const fd = fdInt(d), pending = processAshmemProtect(fd,prot);
    if (pending) return pending.then(n => -n);
    const region = regionOf(fd);
    if (!region) return E.NOTTY;
    if (prot & ~region.prot) return E.INVAL;
    region.prot = prot;
    return 0;
  },
});
/** a ParcelFileDescriptor over bytes, as fdOverBytes opens them */
export const mkPfd = (bytes: Uint8Array, sink: ((b: Uint8Array) => unknown) | null = null, key?: string): JObj | Promise<JObj> =>
  after(mkFd(fdOverBytes(bytes, sink, key)), (fd) => newObj("android/os/ParcelFileDescriptor", `(${FD})V`, fd));
/** what a descriptor's file holds, whatever its offset; null for one with no file (a pipe, a socket) */
export function fdContents(fd: number): Uint8Array | null | Promise<Uint8Array> {
  const source = javaFdSource(fd);
  return source && source.read(0, source.size);
}
/** the bytes a ParcelFileDescriptor's file holds */
export const pfdContents = driven(function* pfdContents(pfd: JObj): Gen<Uint8Array | null> {
  return yield* awaited(fdContents(fdInt(yield vcall(pfd, "getFileDescriptor", `()${FD}`))));
});

// statvfs answers the storage estimate in 4K blocks
const BLK = 4096n;
// the internal storage volume, identified by the platform's default UUID (StorageManager.UUID_DEFAULT)
export const uuidDefault = once(() => uuidFromString("41217664-9172-527a-b3d5-edabb50a7d69"));
// android.system.Os: the libcore syscall surface over the same descriptor table native code uses
export const errno = (fn: string, e: number): JThrowable => setDeclared(rt.mkThrowable("android/system/ErrnoException", null), "android/system/ErrnoException", { functionName: fn, errno: e });
/** `then` once `path` exists in the realm that owns it (an app's private storage lives in the system realm), else `fn`'s ErrnoException */
const existing = <T>(fn: string, path: string, then: (st: PathStat) => T) => after(pathReply(path), ({ errno: e, value }) => { if (!value) throw errno(fn, e); return then(value); });
/** libcore's StructTimespec for a time in milliseconds */
function timespec(ms: number): JObj {
  const t = rt.make("android/system/StructTimespec") as Record<string, bigint>;
  t[declaredField("android/system/StructTimespec", "tv_sec")] = BigInt(Math.floor(ms / 1000));
  t[declaredField("android/system/StructTimespec", "tv_nsec")] = BigInt(Math.round((ms % 1000) * 1e6));
  return t as unknown as JObj;
}
export const FD = "Ljava/io/FileDescriptor;";
/** a StructStat as libcore's JNI fills one: a file's stat in 4K blocks of 512-byte units, one link */
function statOf(path: string | null, size: number, mode: number, mtimeMs: number, attributes?: FileAttributes): JObj {
  const a = attributes ?? (path !== null ? vfs.metadata.get(vfs.norm(path)) : undefined) ?? {...vfs.attributes(path),mode:mode & 0o7777};
  const seconds = BigInt(Math.floor(mtimeMs / 1000)), time = timespec(mtimeMs);
  return setDeclared(rt.make("android/system/StructStat"), "android/system/StructStat", {
    st_dev: 0n, st_ino: 0n, st_mode: (mode & ~0o7777) | a.mode, st_nlink: 1n, st_uid: a.uid, st_gid: a.gid, st_size: BigInt(size), st_blksize: 4096n,
    st_blocks: (BigInt(size) + 511n) / 512n, st_atime: seconds, st_mtime: seconds, st_ctime: seconds, st_atim: time, st_mtim: time, st_ctim: time,
  });
}
type StatVfs = { f_frsize: bigint; f_blocks: bigint; f_bfree: bigint; f_bavail: bigint };
const storageStatVfs = driven(function* storageStatVfs(): Gen<StatVfs> {
  const { total, free } = yield* awaited(storageEstimate()), f_bfree = BigInt(Math.floor(free / Number(BLK)));
  return { f_frsize: BLK, f_blocks: BigInt(Math.floor(total / Number(BLK))), f_bfree, f_bavail: f_bfree };
});
/** a StructStatVfs as statvfs(2) fills it: 4K blocks, no inode counts, 255-byte names */
const structStatVfs = driven(function* structStatVfs(): Gen<JObj> {
  const s = yield* awaited(storageStatVfs());
  return newObj("android/system/StructStatVfs", "(JJJJJJJJJJJ)V", BLK, s.f_frsize, s.f_blocks, s.f_bfree, s.f_bavail, 0n, 0n, 0n, 0n, 0n, 255n);
});
// libcore.io.Linux: the syscalls behind android.system.Os and Libcore.os, over the descriptor
// table native code shares
const linux: Record<string, (...args: never[]) => unknown> = {
    "open(Ljava/lang/String;II)Ljava/io/FileDescriptor;": driven(function* (path: string, flags: number): Gen {
      if (path === null) rt.npe();
      const fd = yield* awaited(processOpenFd(path, flags));
      if (fd < 0) throw errno("open", -fd);
      return yield* awaited(mkFd(fd));
    }),
    [`fstat(${FD})Landroid/system/StructStat;`]: driven(function* (d: JObj | null): Gen {
      const st = yield* awaited(processFdStat(fdInt(d)));
      if (!st) throw errno("fstat", E.BADF);
      return yield* awaited(statOf(st.path, st.size, st.mode, st.mtime,{...st,mode:st.mode & 0o7777}));
    }),
    [`readBytes(${FD}Ljava/lang/Object;II)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      readBytes("read", buffer, offset, count, (target) => processReadFd(fdInt(d), target)),
    [`preadBytes(${FD}Ljava/lang/Object;IIJ)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      readBytes("pread", buffer, offset, count, (target) => processPreadFd(fdInt(d), target, Number(position))),
    [`writeBytes(${FD}Ljava/lang/Object;II)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      writeBytes(buffer, offset, count, (bytes) => after(processWriteFd(fdInt(d), bytes), n => ioResult("write", n))),
    [`pwriteBytes(${FD}Ljava/lang/Object;IIJ)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      writeBytes(buffer, offset, count, (bytes) => after(processPwriteFd(fdInt(d), bytes, Number(position)), n => ioResult("pwrite", n))),
    [`ftruncate(${FD}J)V`]: (d: JObj | null, length: bigint) => after(processTruncateFd(fdInt(d), Number(length)), n => sys("ftruncate", n)),
    [`fsync(${FD})V`]: (d: JObj | null) => after(processSyncFd(fdInt(d)), n => sys("fsync", n)),
    [`fdatasync(${FD})V`]: (d: JObj | null) => after(processSyncFd(fdInt(d)), n => sys("fdatasync", n)),
    [`ioctlInt(${FD}I)I`]: (d: JObj | null, request: number) => after(processIoctlIntFd(fdInt(d), request), n => ioResult("ioctl", n)),
    [`fcntlInt(${FD}II)I`]: (d: JObj | null, cmd: number, arg: number) => after(processFcntlFd(fdInt(d), cmd, arg), n => ioResult("fcntl", n)),
    [`fcntlVoid(${FD}I)I`]: (d: JObj | null, cmd: number) => after(processFcntlFd(fdInt(d), cmd, 0), n => ioResult("fcntl", n)),
    [`android_fdsan_exchange_owner_tag(${FD}JJ)V`]: (d: JObj | null, expected: bigint, tag: bigint) =>
      fdsanExchangeOwnerTag(fdInt(d), expected, tag),
    [`android_fdsan_get_owner_tag(${FD})J`]: (d: JObj | null) => fdsanOwnerTag(fdInt(d)),
    "android_fdsan_get_tag_type(J)Ljava/lang/String;": (tag: bigint) => fdsanTagType(tag),
    "android_fdsan_get_tag_value(J)J": (tag: bigint) => fdsanTagValue(tag),
    // no descriptor here is a terminal
    [`isatty(${FD})Z`]: () => 0,
    "pipe2(I)[Ljava/io/FileDescriptor;": (flags: number) => {
      const [read, write] = javaPipeFds(flags);
      return after(mkFd(read), (r) => after(mkFd(write), (w) => jarray([r, w], FD)));
    },
    [`sendfile(${FD}${FD}Landroid/system/Int64Ref;J)J`]: (out: JObj | null, input: JObj | null, offset: JObj | null, count: bigint) => {
      const value = offset && declaredField("android/system/Int64Ref", "value");
      const start = value ? Number((offset as unknown as Record<string, bigint>)[value]) : 0;
      const n = count < 0n ? -1 : Math.min(Number(count), SENDFILE_CHUNK);
      if (n < 0 || start < 0) throw errno("sendfile", E.INVAL);
      if (!javaFdStat(fdInt(out))) throw errno("sendfile", E.BADF);
      const scratch = new Uint8Array(n), from = fdInt(input);
      return after(value ? javaPreadFd(from, scratch, start) : javaReadFd(from, scratch), (read) => {
        sys("sendfile", read);
        const written = read ? javaWriteFd(fdInt(out), scratch.subarray(0, read)) : 0;
        sys("sendfile", written);
        if (value) (offset as unknown as Record<string, bigint>)[value] = BigInt(start + written);
        return BigInt(written);
      });
    },
    [`lseek(${FD}JI)J`]: driven(function* (d: JObj | null, off: bigint, whence: number): Gen {
      const r = yield* awaited(processSeekFd(fdInt(d), Number(off), whence));
      if (r < 0) throw errno("lseek", -r);
      return BigInt(r);
    }),
    [`close(${FD})V`]: (d: JObj | null) => {
      if (d === null) return rt.npe();
      const fd = fdInt(d), owner = (d as unknown as Record<string, bigint | undefined>)[declaredField("java/io/FileDescriptor", "ownerId")];
      setFdInt(d, -1);
      let pending: number | Promise<number> | undefined;
      const immediate = fdsanClose(fd, owner ?? 0n, fd => {
        pending = processCloseFd(fd);
        return pending instanceof Promise ? 0 : pending;
      });
      return after(pending ?? immediate, n => sys("close", n));
    },
    [`dup(${FD})${FD}`]: (d: JObj | null) => {
      const fd = javaDupFd(fdInt(d));
      if (fd < 0) throw errno("dup", -fd);
      return mkFd(fd);
    },
    [`mmap(JJII${FD}J)J`]: driven(function* (hint: bigint, count: bigint, prot: number, flags: number, d: JObj | null, offset: bigint): Gen {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER) || (offset & 4095n) !== 0n ||
          (prot & ~7) !== 0 || ((flags & 3) !== 1 && (flags & 3) !== 2) || (flags & 0x10) !== 0 && (hint & 4095n) !== 0n)
        throw errno("mmap", E.INVAL);
      if (flags & 0x10) throw errno("mmap", E.NOTSUP);
      const anonymous = !!(flags & 0x20), fd = anonymous ? -1 : fdInt(d);
      if (!anonymous && (isRemoteFd(fd) || ashmemProt(fd) !== undefined && descriptorTransport.importCalls && descriptorTransport.stageLocal)) {
        if (!(flags & 1)) throw errno("mmap",E.NOTSUP);
        const mapping = yield* awaited(processMapping(fd,Number(offset),size,prot));
        if (typeof mapping === "number") throw errno("mmap",-mapping);
        return mapRemote(mapping);
      }
      const source = anonymous ? null : javaFdSource(fd);
      if (!anonymous && !source) throw errno("mmap", E.BADF);
      if (source && prot === 0) throw errno("mmap", E.NOTSUP);
      // ashmem refuses a mapping beyond its region's protection
      if (prot & ~(ashmemProt(fd) ?? 7)) throw errno("mmap", E.PERM);
      const file = anonymous ? null : fdFile(fd);
      if (flags & 1 && prot & 2 && !file) throw errno("mmap", E.NOTSUP);
      const address = mem.mapVa(size, prot === 0);
      if (!address) throw errno("mmap", E.NOMEM);
      try {
        if (source && prot) { const bytes = yield* awaited(readFully(source, Number(offset), size)); mem.write(guestAt(address), bytes); }
      } catch {
        mem.unmapVa(BigInt(address), size);
        throw errno("mmap", E.IO);
      }
      if (file && flags & 1) trackSharedMap(BigInt(address), size, Number(offset), file, (prot & 2) !== 0);
      else if (file) trackPrivateMap(BigInt(address), size, Number(offset), file);
      return BigInt(address);
    }),
    "munmap(JJ)V": (address: bigint, count: bigint) => {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || address & 4095n) throw errno("munmap", E.INVAL);
      if (isExternal(address)) return unmapExternal(address,size);
      syncShared(address, size, true);
      if (!mem.unmapVa(address, size)) throw errno("munmap", E.INVAL);
    },
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
    "getpid()I": () => PROCESS_PID,
    "getuid()I": () => zygoteRunning ? 0 : PROCESS_UID,
    // bionic's passwd entry: every id has one, named as appUserName names it
    "getpwuid(I)Landroid/system/StructPasswd;": (uid: number) =>
      newObj("android/system/StructPasswd", "(Ljava/lang/String;IILjava/lang/String;Ljava/lang/String;)V", appUserName(uid), uid, uid, "/data", "/system/bin/sh"),
    "uname()Landroid/system/StructUtsname;": () => setDeclared(rt.make("android/system/StructUtsname"), "android/system/StructUtsname",
      (({ domainname: _, ...fields }) => fields)(uname(is64BitProcess()))),
    "sysconf(I)J": (name: number) => BigInt(sysconf(name)),
    "strerror(I)Ljava/lang/String;": strerror,
    "stat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) =>
      existing("stat", path, (st) => statOf(path, st.size, st.directory ? 0o40000 : 0o100000, st.mtime, st)),
    "chmod(Ljava/lang/String;I)V": (path: string, mode: number) => {
      if (path === null) rt.npe();
      return after(remoteFilePath(path)?.fileSetAttributes(path,{mode}) ?? changeFileAttributes(path,{mode}), result => { sys("chmod",result); });
    },
    "chown(Ljava/lang/String;II)V": (path: string, uid: number, gid: number) => {
      if (path === null) rt.npe();
      return after(remoteFilePath(path)?.fileSetAttributes(path,{uid,gid}) ?? changeFileAttributes(path,{uid,gid}), result => { sys("chown",result); });
    },
    // the VFS keeps no extended attributes, as a filesystem without xattr support
    "setxattr(Ljava/lang/String;Ljava/lang/String;[BI)V": (path: string, name: string) => {
      if (path === null || name === null) rt.npe();
      return existing("setxattr", path, () => { throw errno("setxattr", OS_CONSTANTS.EOPNOTSUPP); });
    },
    "statvfs(Ljava/lang/String;)Landroid/system/StructStatVfs;": (path: string) => existing("statvfs", path, () => structStatVfs()),
    [`fstatvfs(${FD})Landroid/system/StructStatVfs;`]: (d: JObj | null) => {
      if (fdInt(d) < 0) throw errno("fstatvfs", E.BADF);
      return structStatVfs();
    },
    "readlink(Ljava/lang/String;)Ljava/lang/String;": () => { throw errno("readlink", 22); },
    "access(Ljava/lang/String;I)Z": (path: string, mode: number) => {
      if (path === null) rt.npe();
      return after(remoteFilePath(path)?.fileAccess(path, mode) ?? accessPath(null, path, mode), result => { sys("access", result); return 1; });
    },
    "remove(Ljava/lang/String;)V": (path: string) => { if (path === null) rt.npe(); return after(remoteFilePath(path)?.fileRemove(path) ?? removePath(null, path), n => sys("remove", n)); },
    // the VFS keeps no permission bits: the mode is not recorded
    "mkdir(Ljava/lang/String;I)V": (path: string) => {
      if (path === null) rt.npe();
      return after(remoteFilePath(path)?.fileMkdir(path) ?? mkdirPath(null, path), result => { sys("mkdir", result); });
    },
    "rename(Ljava/lang/String;Ljava/lang/String;)V": (from: string, to: string) => {
      if (from === null || to === null) rt.npe();
      return after((remoteFilePath(from) ?? remoteFilePath(to))?.fileRename(from,to) ?? renamePath(null, from, to), n => sys("rename", n));
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

// java.io.UnixFileSystem: java.io.File's natives over the VFS. It keeps no permission bits and
// no hard links, so a mode change on an existing path succeeds, as chmod does above.
const BA_EXISTS = 1, BA_REGULAR = 2, BA_DIRECTORY = 4;
const fileExists = (p: string) => { const remote = remoteFilePath(p); return remote ? after(remote.fileStat(p), ({ value }) => +!!value) : +vfs.exists(p); };
const unixFileSystem: Record<string, (...args: never[]) => unknown> = {
  "initIDs()V": () => {},
  "canonicalize0(Ljava/lang/String;Z)Ljava/lang/String;": (path: string) => vfs.canonical(path),
  "getBooleanAttributes0(Ljava/lang/String;)I": (path: string) => {
    const p = vfs.norm(path), remote = remoteFilePath(p);
    if (remote) return after(remote.fileStat(p), reply => reply.value ? BA_EXISTS | (reply.value.directory ? BA_DIRECTORY : BA_REGULAR) : 0);
    return vfs.isDir(p) ? BA_EXISTS | BA_DIRECTORY : vfs.exists(p) ? BA_EXISTS | BA_REGULAR : 0;
  },
  "list0(Ljava/io/File;)[Ljava/lang/String;": (file: JObj) => {
    const p = pathOf(file);
    const remote = remoteFilePath(p);
    if (remote) return after(remote.fileList(p), reply => reply.value ? jarray(reply.value, "Ljava/lang/String;") : null);
    return vfs.isDir(p) ? jarray(vfs.list(p), "Ljava/lang/String;") : null;
  },
  "createFileExclusively0(Ljava/lang/String;)Z": driven(function* (path: string): Gen {
    const r = yield* awaited(remoteFilePath(path)?.fileCreate(path) ?? createPath(null, path));
    if (r === -E.EXIST) return 0;
    // JNU_ThrowIOExceptionWithLastError: an IOException carrying strerror
    if (r < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-r] ?? path);
    return 1;
  }),
  "createDirectory0(Ljava/io/File;)Z": (file: JObj) => {
    const p = pathOf(file);
    return after(remoteFilePath(p)?.fileMkdir(p) ?? mkdirPath(null, p), result => +(result === 0));
  },
  "getLastModifiedTime0(Ljava/io/File;)J": (file: JObj) => {
    const p = pathOf(file), remote = remoteFilePath(p);
    return remote ? after(remote.fileStat(p), ({ value }) => BigInt(value?.mtime ?? 0)) : BigInt(vfs.mtime(p));
  },
  "setLastModifiedTime0(Ljava/io/File;J)Z": (file: JObj, ms: bigint) => {
    const p = pathOf(file);
    if (!vfs.exists(p)) return 0;
    vfs.mtimes.set(p, Number(ms)); return 1;
  },
  "setPermission0(Ljava/io/File;IZZ)Z": (file: JObj) => fileExists(pathOf(file)),
  "setReadOnly0(Ljava/io/File;)Z": (file: JObj) => fileExists(pathOf(file)),
  // FileSystem.SPACE_TOTAL, SPACE_FREE, SPACE_USABLE
  "getSpace0(Ljava/io/File;I)J": driven(function* (_file: JObj, kind: number): Gen {
    const s = yield* awaited(storageStatVfs());
    return kind === 0 ? s.f_blocks * s.f_frsize : kind === 1 ? s.f_bfree * s.f_frsize : s.f_bavail * s.f_frsize;
  }),
  "getNameMax0(Ljava/lang/String;)J": () => 255n,
};
rt.registerJnis("java/io/UnixFileSystem", unixFileSystem);

// sun.nio.fs.UnixNativeDispatcher (UnixNativeDispatcher.c): java.nio.file's syscalls over the VFS.
// Paths arrive as NUL-terminated strings in native memory; failures throw UnixException(errno).
// The VFS has no symbolic or hard links and keeps no permission bits, as the libc above.
// UnixException's fillInStackTrace records nothing, so none is captured
const unixError = (e: number) => {
  const x = rt.make("sun/nio/fs/UnixException");
  x[declaredField("sun/nio/fs/UnixException", "errno")] = e;
  return x;
};
const unixSys = (result: number): number => { if (result < 0) throw unixError(-result); return result; };
const cpath = (address: bigint) => mem.cstr(mem.txVa(BigInt.asUintN(64, address)));
const bytesOf = (s: string) => i8(utf8.enc.encode(s));
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFIFO = 0o010000, AT_FDCWD = -100, AT_REMOVEDIR = 0x200;
/** a name relative to directory descriptor `dfd`, as the *at calls resolve it */
function atPath(dfd: number, address: bigint): string {
  const name = cpath(address);
  if (name.startsWith("/") || dfd === AT_FDCWD) return name;
  const st = javaFdStat(dfd);
  if (!st) throw unixError(E.BADF);
  if ((st.mode & S_IFMT) !== S_IFDIR || st.path === null) throw unixError(E.NOTDIR);
  return st.path + "/" + name;
}
const ATTR_FIELDS = ["st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size",
  "st_atime_sec", "st_atime_nsec", "st_mtime_sec", "st_mtime_nsec", "st_ctime_sec", "st_ctime_nsec"] as const;
let attrProps: string[] | undefined;
function fillAttrs(attrs: JObj, path: string, st: PathStat): void {
  const a = attrs as unknown as Record<string, number | bigint>;
  const p = attrProps ??= ATTR_FIELDS.map((name) => declaredField("sun/nio/fs/UnixFileAttributes", name));
  const sec = BigInt(Math.floor(st.mtime / 1000)), nsec = BigInt((st.mtime % 1000) * 1e6);
  a[p[0]] = modeOf(st); a[p[1]] = BigInt(inoOf(path)); a[p[2]] = 1n; a[p[3]] = 1; a[p[4]] = st.uid; a[p[5]] = st.gid; a[p[6]] = BigInt(st.directory ? 4096 : st.size);
  for (let i = 7; i < 13; i += 2) { a[p[i]] = sec; a[p[i + 1]] = nsec; }
}
const modeOf = (st: PathStat) => (st.directory ? S_IFDIR : st.fifo ? S_IFIFO : S_IFREG) | st.mode;
/** stat(2) of a path in the realm that owns it: a directory, or a file (procfs included) */
function pathReply(path: string) { const p = vfs.norm(path); return remoteFilePath(p)?.fileStat(p) ?? pathStat(p); }
function statPath(path: string, attrs: JObj | null): number | Promise<number> {
  return after(pathReply(path), ({ errno, value }) => {
    if (!value) throw unixError(errno);
    if (attrs) fillAttrs(attrs, vfs.norm(path), value);
    return modeOf(value);
  });
}
/** unlink(2) with `directory` false, rmdir(2) with true */
function removeAt(path: string, directory: boolean) {
  const p = vfs.norm(path);
  return after(remoteFilePath(p)?.fileRemove(p, directory) ?? removePath(null, p, directory), (n) => { unixSys(n); });
}
/** utimes(2): times in microseconds; the VFS keeps modification times only */
function setTimes(path: string, modified: bigint): void {
  const p = vfs.norm(path);
  if (!vfs.exists(p)) throw unixError(E.NOENT);
  vfs.mtimes.set(p, Number(modified / 1000n));
}
/** chown(2) as an app's uid may: its own uid, a group it is in (its own, or the cache and shared
 *  application gids ProcessList gives every app process), or -1 to keep one */
function mayChown(uid: number, gid: number): boolean {
  const own = procIdentity.uid, user = own - own % 100000, offset = own % 100000 - 10000;
  return (uid === -1 || uid === own) && (gid === -1 || gid === own || offset >= 0 && (gid === user + 20000 + offset || gid === 50000 + offset));
}
function chownPath(path: string, uid: number, gid: number) {
  return after(statPath(path, null), () => { if (!mayChown(uid, gid)) throw unixError(E.PERM); });
}
const fdPath = (fd: number): string => { const st = javaFdStat(fd); if (!st) throw unixError(E.BADF); return st.path ?? ""; };
/** open DIR streams: the entries as readdir(3) returns them, and the descriptor closedir closes */
const dirStreams = new Map<bigint, { names: string[]; i: number; fd: number }>();
let nextDir = 0n;
function openDirStream(path: string, fd: number) {
  const p = vfs.norm(path);
  return after(remoteFilePath(p)?.fileList(p) ?? (vfs.isDir(p) ? {errno: 0, value: vfs.list(p)} : {errno: vfs.exists(p) ? E.NOTDIR : E.NOENT, value: null}), ({ errno, value }) => {
    if (!value) throw unixError(errno);
    dirStreams.set(++nextDir, { names: [".", "..", ...value], i: 0, fd });
    return nextDir;
  });
}
const passwdName = (id: number) => bytesOf(appUserName(id));
const unixNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  // SUPPORTS_OPENAT | SUPPORTS_FUTIMES: bionic has openat64, fstatat64, unlinkat, renameat, futimesat
  // and fdopendir. UnixException is initialized first, since the natives throw it synchronously.
  "init()I": () => after(initClass("sun/nio/fs/UnixException"), () => 6),
  "getcwd()[B": () => bytesOf("/"),
  "strerror(I)[B": (e: number) => bytesOf(strerror(e)),
  "dup(I)I": (fd: number) => unixSys(javaDupFd(fd)),
  "open0(JII)I": (path: bigint, flags: number) => after(processOpenFd(cpath(path),flags),unixSys),
  "openat0(IJII)I": (dfd: number, path: bigint, flags: number) => after(processOpenFd(atPath(dfd,path),flags),unixSys),
  "close(I)V": (fd: number) => after(processCloseFd(fd),n => {unixSys(n);}),
  "link0(JJ)V": () => { throw unixError(E.PERM); },
  "symlink0(JJ)V": () => { throw unixError(E.PERM); },
  "unlink0(J)V": (path: bigint) => removeAt(cpath(path), false),
  "unlinkat0(IJI)V": (dfd: number, path: bigint, flags: number) => removeAt(atPath(dfd, path), !!(flags & AT_REMOVEDIR)),
  "rename0(JJ)V": (from: bigint, to: bigint) => { const a=cpath(from),b=cpath(to);return after((remoteFilePath(a)??remoteFilePath(b))?.fileRename(a,b)??renamePath(null,a,b),n => {unixSys(n);}); },
  "renameat0(IJIJ)V": (fromDir: number, from: bigint, toDir: number, to: bigint) => { const a=atPath(fromDir,from),b=atPath(toDir,to);return after((remoteFilePath(a)??remoteFilePath(b))?.fileRename(a,b)??renamePath(null,a,b),n => {unixSys(n);}); },
  "mkdir0(JI)V": (path: bigint) => { const p = cpath(path); return after(remoteFilePath(p)?.fileMkdir(p) ?? mkdirPath(null, p), (n) => { unixSys(n); }); },
  "rmdir0(J)V": (path: bigint) => removeAt(cpath(path), true),
  // an existing path is never a link
  "readlink0(J)[B": (path: bigint) => after(statPath(cpath(path), null), () => { throw unixError(E.INVAL); }),
  "realpath0(J)[B": (path: bigint) => { const p = vfs.norm(cpath(path)); return after(statPath(p, null), () => bytesOf(p)); },
  "stat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), attrs), () => {}),
  "lstat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), attrs), () => {}),
  "stat1(J)I": (path: bigint) => after(pathReply(cpath(path)), ({ value }) => value ? modeOf(value) : 0),
  "fstatat0(IJILsun/nio/fs/UnixFileAttributes;)V": (dfd: number, path: bigint, _flag: number, attrs: JObj) => after(statPath(atPath(dfd, path), attrs), () => {}),
  "fstat(ILsun/nio/fs/UnixFileAttributes;)V": (fd: number, attrs: JObj) => {
    const st = javaFdStat(fd);
    if (!st) throw unixError(E.BADF);
    const path = st.path ?? "", directory = (st.mode & S_IFMT) === S_IFDIR;
    fillAttrs(attrs, path, { directory, fifo: (st.mode & S_IFMT) === S_IFIFO, size: st.size, mtime: vfs.mtime(path), ...vfs.attributes(path, directory) });
  },
  "chmod0(JI)V": (path: bigint) => after(statPath(cpath(path), null), () => {}),
  "fchmod(II)V": (fd: number) => { fdPath(fd); },
  "chown0(JII)V": (path: bigint, uid: number, gid: number) => chownPath(cpath(path), uid, gid),
  "lchown0(JII)V": (path: bigint, uid: number, gid: number) => chownPath(cpath(path), uid, gid),
  "fchown(III)V": (fd: number, uid: number, gid: number) => chownPath(fdPath(fd), uid, gid),
  "utimes0(JJJ)V": (path: bigint, _accessed: bigint, modified: bigint) => setTimes(cpath(path), modified),
  "futimes(IJJ)V": (fd: number, _accessed: bigint, modified: bigint) => setTimes(fdPath(fd), modified),
  "opendir0(J)J": (path: bigint) => openDirStream(cpath(path), -1),
  "fdopendir(I)J": (fd: number) => openDirStream(fdPath(fd), fd),
  "closedir(J)V": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    dirStreams.delete(dir);
    if (stream.fd >= 0) unixSys(javaCloseFd(stream.fd));
  },
  "readdir(J)[B": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    return stream.i < stream.names.length ? bytesOf(stream.names[stream.i++]) : null;
  },
  "access0(JI)V": (path: bigint, mode: number) => { const p = cpath(path); return after(remoteFilePath(p)?.fileAccess(p, mode) ?? accessPath(null, p, mode), (n) => { unixSys(n); }); },
  "exists0(J)Z": (path: bigint) => { const p = cpath(path); return after(remoteFilePath(p)?.fileAccess(p, 0) ?? accessPath(null, p, 0), (n) => +(n === 0)); },
  "getpwuid(I)[B": passwdName,
  "getgrgid(I)[B": passwdName,
  "statvfs0(JLsun/nio/fs/UnixFileStoreAttributes;)V": driven(function* (path: bigint, attrs: JObj): Gen {
    yield* awaited(statPath(cpath(path), null));
    const s = yield* awaited(storageStatVfs()), a = attrs as unknown as Record<string, bigint>;
    const f = (name: string) => declaredField("sun/nio/fs/UnixFileStoreAttributes", name);
    a[f("f_frsize")] = s.f_frsize; a[f("f_blocks")] = s.f_blocks; a[f("f_bfree")] = s.f_bfree; a[f("f_bavail")] = s.f_bavail;
  }),
};
rt.registerJnis("sun/nio/fs/UnixNativeDispatcher", unixNativeDispatcher);
// LinuxNativeDispatcher.c: the VFS stores no extended attributes, and its only mount table would be
// a file some app wrote (there is no /proc/mounts)
const mountTables = new Map<bigint, string[][]>();
let nextMountTable = 0n;
const linuxNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  "init()V": () => {},
  "flistxattr(IJI)I": (fd: number) => { fdPath(fd); return 0; },
  "fgetxattr0(IJJI)I": (fd: number) => { fdPath(fd); throw unixError(OS_CONSTANTS.ENODATA); },
  "fremovexattr0(IJ)V": (fd: number) => { fdPath(fd); throw unixError(OS_CONSTANTS.ENODATA); },
  "fsetxattr0(IJJI)V": (fd: number) => { fdPath(fd); throw unixError(OS_CONSTANTS.EOPNOTSUPP); },
  "setmntent0(JJ)J": (path: bigint) => {
    const text = vfs.read(cpath(path));
    if (!text) throw unixError(E.NOENT);
    mountTables.set(++nextMountTable, utf8.dec.decode(text).split("\n").map((line) => line.trim().split(/\s+/)).filter((f) => f.length >= 4 && !f[0].startsWith("#")));
    return nextMountTable;
  },
  "getmntent(JLsun/nio/fs/UnixMountEntry;)I": (table: bigint, entry: JObj) => {
    const fields = mountTables.get(table)?.shift();
    if (!fields) return -1;
    const e = entry as unknown as Record<string, Int8Array>;
    ["name", "dir", "fstype", "opts"].forEach((name, i) => { e[declaredField("sun/nio/fs/UnixMountEntry", name)] = bytesOf(fields[i]); });
    return 0;
  },
  "endmntent(J)V": (table: bigint) => { mountTables.delete(table); },
};
rt.registerJnis("sun/nio/fs/LinuxNativeDispatcher", linuxNativeDispatcher);
// UnixCopyFile.c: read(2) and write(2) until the source's end, checking the cancel flag between reads
rt.registerJni("sun/nio/fs/UnixCopyFile", "transfer(IIJ)V", driven(function* (dst: number, src: number, cancel: bigint): Gen {
  const buffer = new Uint8Array(1 << 16);
  for (;;) {
    const n = unixSys(yield* awaited(javaReadFd(src, buffer)));
    if (!n) return;
    if (cancel && mem.ld32(mem.txVa(cancel))) throw unixError(OS_CONSTANTS.ECANCELED);
    for (let at = 0; at < n;) at += unixSys(javaWriteFd(dst, buffer.subarray(at, n)));
  }
}));
// libcore's OsConstants fills its fields from native initConstants(); these are the reference
// device's values (bun run gen-framework)
rt.registerJni("android/system/OsConstants", "initConstants()V", () => {
  const constants = linkClass("android/system/OsConstants");
  constants.setStatics(Object.entries(OS_CONSTANTS), "I");
});
