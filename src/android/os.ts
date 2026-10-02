// android.os.* + android.util.* natives.
import { readFully } from "../shell/lazyfile";
import { processEnv } from "../shell/environment";
import { appUserName, procIdentity, processTid, sysconf } from "../shell/procfs";
import { parcelCreator, readObject, writeObject, unparcelBundle, type JParcel } from "./parcel";
import { guestAt, mem } from "../native/mem";
import { syncShared, trackSharedMap } from "../native/mappings";
import { rt, JObj, type NativeSpec, stubs, noops, driven, without, declaredField, type Gen } from "../jvm/runtime";
import { i8, jarray, utf8 } from "../jvm/abi";
import { markProcessExited } from "../native/cpu";
import { device } from "../shell/config";
import { androidGroupId } from "./identity";
import { uuidFromString } from "../jvm/natives/jvalues";
import { vcall, curThread, mainThread, JThread, JThrowable, reportUncaught, newObj, defineException, after, checkFromIndexSize, scall, stringHash } from "../jvm/natives/jlang";
import { box, boxObject, unboxAs, type BoxDesc } from "../jvm/natives/jbox";
import { E, ERRSTR } from "../native/abi";
import { is64BitProcess } from "../jvm/natives/jreflect";
import { OS_CONSTANTS } from "./os-constants";
export { reportUncaught };
import { pathOf, fdInt, setFdInt, mkFd, heldByteReads, heldByteWrites } from "../jvm/natives/jio";
import { vfs } from "../shell/vfs";
import { javaOpenFd, javaCloseFd, javaSeekFd, javaDupFd, javaBytesFd, javaFdSource, javaFdStat, javaPipeFds, javaReadFd, javaPreadFd, javaWriteFd, javaPwriteFd, javaTruncateFd, javaSyncFd, javaFcntlFd, javaIoctlIntFd, fdFile, inoOf, accessPath, createPath, mkdirPath, removePath, renamePath } from "../native/fs";
import { fdsanClose, fdsanExchangeOwnerTag, fdsanOwnerTag, fdsanTagType, fdsanTagValue } from "../native/fd";
import { newLinkedHashSet, toJsArray } from "../jvm/natives/jcoll";
import { type JBuffer, bufferBytes, directView, isBuffer, nonMovableBytes, resident } from "../jvm/natives/jnio";
import { guestSleep, uptimeMillis } from "../guest-clock";

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

defineException("android/os/RemoteException", "java/lang/Exception");
defineException("android/os/DeadObjectException", "android/os/RemoteException");
defineException("android/os/OperationCanceledException", "java/lang/RuntimeException");

const RUNTIME_STATS = ["art.gc.gc-count", "art.gc.gc-time", "art.gc.bytes-allocated", "art.gc.bytes-freed", "art.gc.blocking-gc-count", "art.gc.blocking-gc-time", "art.gc.gc-count-rate-histogram", "art.gc.blocking-gc-count-rate-histogram"];
// ── SystemClock / Build / Process / Trace / Debug
class JSystemClock extends JObj {}
rt.register({
  name: "android/os/SystemClock", ctor: JSystemClock,
  methods: {
    "static uptimeMillis()J": () => BigInt(Math.floor(uptimeMillis())),
    "static elapsedRealtime()J": () => BigInt(Math.floor(uptimeMillis())),
    "static elapsedRealtimeNanos()J": () => BigInt(Math.floor(uptimeMillis() * 1e6)),
    "static uptimeNanos()J": () => BigInt(Math.floor(uptimeMillis() * 1e6)),
    "static currentThreadTimeMillis()J": () => BigInt(Math.floor(performance.now())),
    // the host's wall clock is network-synchronized
    "static currentNetworkTimeClock()Ljava/time/Clock;": () => {
      const clock = rt.link("java/time/Clock");
      return after(rt.initClass(clock), () => vcall(clock.ctor, "systemUTC", "()Ljava/time/Clock;"));
    },
    "static sleep(J)V": (ms: bigint) => guestSleep(Number(ms)),
  },
});
class JBuild extends JObj {}
const abi32 = jarray(["armeabi-v7a"], "Ljava/lang/String;"), abi64 = jarray(["arm64-v8a"], "Ljava/lang/String;");
rt.register({
  name: "android/os/Build", ctor: JBuild,
  statics: {
    MODEL: "webdroid", MANUFACTURER: "webdroid", BRAND: "google", DEVICE: "webdroid",
    PRODUCT: "webdroid", HARDWARE: "browser", FINGERPRINT: "google/webdroid/1.0", SOC_MANUFACTURER: "unknown", SOC_MODEL: "unknown", SKU: "unknown", ODM_SKU: "unknown",
    SERIAL: "unknown", RADIO: "unknown", ID: "WD1A", DISPLAY: "webdroid 1.0", TAGS: "release-keys", TYPE: "user",
    BOARD: "web", BOOTLOADER: "unknown", HOST: "localhost", USER: "web", TIME: 0n, UNKNOWN: "unknown",
    SUPPORTED_ABIS: jarray([...abi64, ...abi32], "Ljava/lang/String;"),
    SUPPORTED_32_BIT_ABIS: abi32,
    SUPPORTED_64_BIT_ABIS: abi64,
    get CPU_ABI() { return (is64BitProcess() ? abi64 : abi32)[0]; },
    get CPU_ABI2() { return (is64BitProcess() ? abi64 : abi32)[1] ?? ""; },
  },
  methods: { "static getSerial()Ljava/lang/String;": () => "unknown", "static getRadioVersion()Ljava/lang/String;": () => null },
});
class JBuildVersion extends JObj {}
rt.register({
  name: "android/os/Build$VERSION", ctor: JBuildVersion,
  // a release build: the codename is REL, so every RELEASE_OR_* name reads the release
  statics: { SDK_INT: device.sdk, RELEASE: device.release, RELEASE_OR_CODENAME: device.release, RELEASE_OR_PREVIEW_DISPLAY: device.release,
    CODENAME: "REL", INCREMENTAL: "1", SECURITY_PATCH: "2023-01-01", SDK: String(device.sdk), BASE_OS: "", PREVIEW_SDK_INT: 0,
    PREVIEW_SDK_FINGERPRINT: "REL", DEVICE_INITIAL_SDK_INT: device.sdk, MEDIA_PERFORMANCE_CLASS: 0,
    // SDK_INT, plus one for a pre-release codename, which a release build has none of
    RESOURCES_SDK_INT: device.sdk, ACTIVE_CODENAMES: jarray([], "Ljava/lang/String;") },
});
// API 33's codes, in the name order ART's getFields() reports for a dex class; apps index
// the array by SDK_INT to read the release codename
rt.register({ name: "android/os/Build$VERSION_CODES", ctor: class extends JObj {},
  statics: Object.fromEntries([
    ["BASE", 1], ["BASE_1_1", 2], ["CUPCAKE", 3], ["CUR_DEVELOPMENT", 10000], ["DONUT", 4], ["ECLAIR", 5],
    ["ECLAIR_0_1", 6], ["ECLAIR_MR1", 7], ["FROYO", 8], ["GINGERBREAD", 9], ["GINGERBREAD_MR1", 10],
    ["HONEYCOMB", 11], ["HONEYCOMB_MR1", 12], ["HONEYCOMB_MR2", 13], ["ICE_CREAM_SANDWICH", 14],
    ["ICE_CREAM_SANDWICH_MR1", 15], ["JELLY_BEAN", 16], ["JELLY_BEAN_MR1", 17], ["JELLY_BEAN_MR2", 18],
    ["KITKAT", 19], ["KITKAT_WATCH", 20], ["LOLLIPOP", 21], ["LOLLIPOP_MR1", 22], ["M", 23], ["N", 24],
    ["N_MR1", 25], ["O", 26], ["O_MR1", 27], ["P", 28], ["Q", 29], ["R", 30], ["S", 31], ["S_V2", 32],
    ["TIRAMISU", 33],
  ]),
});
export let PROCESS_PID = 1000, PROCESS_UID = 10001;
export let PROCESS_NAME = "";
/** set while the zygote initializes what every app inherits: it runs as root */
let zygoteRunning = false;
export async function asZygote(init: () => Promise<void>): Promise<void> {
  zygoteRunning = true;
  try { await init(); } finally { zygoteRunning = false; }
}
export function setProcessIdentity(pid: number, uid: number): void { PROCESS_PID = pid; PROCESS_UID = uid; procIdentity.pid = pid; procIdentity.uid = uid; }
export class JUserHandle extends JObj { constructor(readonly id = 0) { super(); } }
const userHandles = new Map<number, JUserHandle>();
export function userHandleForUid(uid: number): JUserHandle {
  const userId = Math.trunc(uid / 100000);
  let handle = userHandles.get(userId);
  if (!handle) { handle = new JUserHandle(userId); userHandles.set(userId, handle); }
  return handle;
}
/** the kernel thread id of a Java thread: the main thread's is the pid, as on a device */
function threadTid(t: JThread): number {
  return processTid(t, t === mainThread);
}
export function setProcessName(name: string): void { PROCESS_NAME = name; procIdentity.name = name; }
const killProcess = (pid: number) => { console.warn("Process.killProcess", pid); markProcessExited(); };
// System.exit and Runtime.halt end the process as killProcess does
rt.registerJni("java/lang/Runtime", "nativeExit(I)V", () => killProcess(PROCESS_PID));
// android.os.Process runs from bytecode; its natives answer for this one process
const SIGNAL_KILL = 9;
const threadPriorities = new Map<number, number>();
const totalMemory = () => BigInt(device.cpu.memKb) * 1024n;
rt.registerJnis("android/os/Process", {
  "getElapsedCpuTime()J": () => BigInt(Math.round(performance.now())),
  "getGidForName(Ljava/lang/String;)I": (name: string | null) => {
    if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    return androidGroupId(name);
  },
  "getUidForName(Ljava/lang/String;)I": (name: string | null) => {
    if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    return androidGroupId(name);
  },
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
  "sendSignal(II)V": (pid: number, signal: number) => { if (pid === PROCESS_PID && signal === SIGNAL_KILL) killProcess(pid); },
  "sendSignalQuiet(II)V": (pid: number, signal: number) => { if (pid === PROCESS_PID && signal === SIGNAL_KILL) killProcess(pid); },
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
class JMemoryInfo extends JObj {
  dalvikSharedClean = 0; nativeSharedClean = 0; otherSharedClean = 0;
  dalvikPrivateClean = 0; nativePrivateClean = 0; otherPrivateClean = 0;
  dalvikPss = 0; nativePss = 0; otherPss = 0;
  dalvikSwappablePss = 0; nativeSwappablePss = 0; otherSwappablePss = 0;
  dalvikSharedDirty = 0; dalvikPrivateDirty = 0; nativeSharedDirty = 0; nativePrivateDirty = 0; otherSharedDirty = 0; otherPrivateDirty = 0;
  get totalPss() { return this.dalvikPss + this.nativePss + this.otherPss; }
  get privateDirty() { return this.dalvikPrivateDirty + this.nativePrivateDirty + this.otherPrivateDirty; }
  stats(): Record<string, number> {
    return {
      "summary.java-heap": this.dalvikPrivateDirty, "summary.native-heap": this.nativePrivateDirty,
      "summary.code": 0, "summary.stack": 0, "summary.graphics": 0,
      "summary.private-other": this.otherPrivateDirty, "summary.system": this.totalPss - this.privateDirty,
      "summary.total-pss": this.totalPss, "summary.total-swap": 0,
    };
  }
}
rt.register({
  name: "android/os/Debug$MemoryInfo", ctor: JMemoryInfo,
  fields: ["dalvikPss", "nativePss", "otherPss", "dalvikSharedDirty", "dalvikPrivateDirty",
    "nativeSharedDirty", "nativePrivateDirty", "otherSharedDirty", "otherPrivateDirty",
    "dalvikSwappablePss", "nativeSwappablePss", "otherSwappablePss",
    "dalvikSharedClean", "nativeSharedClean", "otherSharedClean", "dalvikPrivateClean", "nativePrivateClean", "otherPrivateClean"],
  methods: {
    "getTotalPss()I": function (this: JMemoryInfo) { return this.totalPss; },
    "getTotalSwappablePss()I": function (this: JMemoryInfo) { return this.dalvikSwappablePss + this.nativeSwappablePss + this.otherSwappablePss; },
    ...noops("<init>()V"),
    "getTotalPrivateDirty()I": function (this: JMemoryInfo) { return this.privateDirty; },
    "getTotalSharedDirty()I": function (this: JMemoryInfo) { return this.dalvikSharedDirty + this.nativeSharedDirty + this.otherSharedDirty; },
    "getTotalSharedClean()I": function (this: JMemoryInfo) { return this.dalvikSharedClean + this.nativeSharedClean + this.otherSharedClean; },
    "getTotalPrivateClean()I": function (this: JMemoryInfo) { return this.dalvikPrivateClean + this.nativePrivateClean + this.otherPrivateClean; },
    "getMemoryStat(Ljava/lang/String;)Ljava/lang/String;": function (this: JMemoryInfo, key: string) {
      const stats = this.stats(); return Object.hasOwn(stats, key) ? String(stats[key]) : null;
    },
    "getMemoryStats()Ljava/util/Map;": driven(function* (this: JMemoryInfo): Gen {
      const map = yield newObj("java/util/HashMap");
      for (const [key, value] of Object.entries(this.stats())) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, String(value));
      return map;
    }),
  },
});
/** the JS heap in KiB, the nearest thing to this process's dalvik footprint */
const jsHeapKb = () => (((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024) | 0;
rt.register({
  name: "android/os/Debug", ctor: class extends JObj {},
  methods: {
    // the native heap is the guest allocator's: bytes in use, the extent it has reached, and the gap
    "static getNativeHeapAllocatedSize()J": () => BigInt(Math.round(mem.stats().used)),
    "static getNativeHeapSize()J": () => BigInt(Math.round(mem.stats().peak)),
    "static getNativeHeapFreeSize()J": () => BigInt(Math.max(0, Math.round(mem.stats().peak - mem.stats().used))),
    ...stubs(0, "static isDebuggerConnected()Z", "static waitingForDebugger()Z"),
    "static threadCpuTimeNanos()J": () => BigInt(Math.round(performance.now() * 1e6)),
    "static getThreadAllocCount()I": () => 0,
    "static getThreadAllocSize()I": () => 0,
    "static getPss()J": () => BigInt(jsHeapKb()),
    // ART's runtime counters: nothing here collects, blocks or compacts, so every stat is zero
    "static getRuntimeStat(Ljava/lang/String;)Ljava/lang/String;": (name: string) => RUNTIME_STATS.includes(name) ? "0" : null,
    "static getRuntimeStats()Ljava/util/Map;": driven(function* (): Gen {
      const m = yield newObj("java/util/HashMap");
      for (const k of RUNTIME_STATS) yield vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", k, "0");
      return m;
    }),
    // nothing here is shared
    "static getMemoryInfo(Landroid/os/Debug$MemoryInfo;)V": (info: { dalvikPss: number; dalvikPrivateDirty: number; nativePss: number; nativePrivateDirty: number } | null) => {
      if (!info) throw rt.mkThrowable("java/lang/NullPointerException", "memoryInfo");
      const kb = jsHeapKb();
      info.dalvikPss = kb; info.dalvikPrivateDirty = kb;
      const native = Math.round(mem.stats().used / 1024);
      info.nativePss = native; info.nativePrivateDirty = native;
    },
  },
});
/** a Bundle's wire form while it is unread: the bytes after BUNDLE_MAGIC and their binders */
export type ParcelledBundle = { bytes: Uint8Array<ArrayBuffer>; objects: [number, unknown][] };
export class JBaseBundle extends JObj {
  private values = new Map<string, unknown>();
  loader: unknown = null;
  /** mParcelledData: a bundle read from a parcel stays in wire form until something reads it */
  parcelled: ParcelledBundle | null = null;
  unparcelling: Promise<void> | null = null;
  /** FLAG_DEFUSABLE */
  defusable = false;
  allowFds = true;
  /** the values; a parcelled bundle has to be unparcelled (`unparcel`) first */
  get map(): Map<string, unknown> {
    if (this.parcelled) throw new Error("Bundle read while parcelled");
    return this.values;
  }
  set map(values: Map<string, unknown>) { this.values = values; this.parcelled = null; }
}
export class JPersistableBundle extends JBaseBundle {}
export class JBundle extends JBaseBundle {
  constructor() { super(); rt.link("android/os/Bundle"); }
}
function bundlePrimitive(value: unknown, descriptor: string, fallback: unknown): unknown {
  if (typeof value === (descriptor === "J" ? "bigint" : "number")) return value;
  return unboxAs(value, descriptor as BoxDesc, fallback);
}
/** What put<Type> stores: I and J stay bare (their JS type names them); the other primitives
 *  keep their declared width in a box, as a Parcel round trip will too. */
function bundleBox(value: unknown, descriptor: string): unknown {
  return typeof value === "number" && descriptor !== "I" && descriptor.length === 1 ? box(descriptor as BoxDesc, value) : value;
}
function bundleGet(b: JBaseBundle, k: string, descriptor: string, fallback: unknown): unknown {
  const v = b.map.get(k);
  return descriptor.length === 1 ? bundlePrimitive(v, descriptor, fallback) : v ?? fallback;
}
/** The typed values a Bundle carries, by accessor stem: get/put<stem> */
const BUNDLE_TYPES = [
  ...["Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double"].flatMap((t, i) => [[t, "ZBCSIJFD"[i]], [t + "Array", "[" + "ZBCSIJFD"[i]]] as const),
  ["String", "Ljava/lang/String;"], ["CharSequence", "Ljava/lang/CharSequence;"], ["Parcelable", "Landroid/os/Parcelable;"],
  ["Serializable", "Ljava/io/Serializable;"], ["Bundle", "Landroid/os/Bundle;"], ["IBinder", "Landroid/os/IBinder;"],
  ["StringArray", "[Ljava/lang/String;"], ["CharSequenceArray", "[Ljava/lang/CharSequence;"], ["ParcelableArray", "[Landroid/os/Parcelable;"],
  ...["Integer", "String", "CharSequence", "Parcelable"].map((t) => [t + "ArrayList", "Ljava/util/ArrayList;"] as const),
  ["Binder", "Landroid/os/IBinder;"], ["PersistableBundle", "Landroid/os/PersistableBundle;"],
  ["Size", "Landroid/util/Size;"], ["SizeF", "Landroid/util/SizeF;"], ["SparseParcelableArray", "Landroid/util/SparseArray;"]] as const;
/** API 33's class-checked getters, [stem, return] */
const BUNDLE_TYPED = [["Parcelable", "Ljava/lang/Object;"], ["Serializable", "Ljava/io/Serializable;"],
  ["ParcelableArray", "[Ljava/lang/Object;"], ["ParcelableArrayList", "Ljava/util/ArrayList;"], ["SparseParcelableArray", "Landroid/util/SparseArray;"]] as const;
/** A class-checked getter's value. The class narrows a single value, which a mismatch reads as
 *  null; arrays and lists hold what was put. */
function bundleTyped(b: JBaseBundle, k: string, cls: unknown, ret: string): unknown {
  const v = boxObject(b.map.get(k) ?? null), single = ret === "Ljava/lang/Object;" || ret === "Ljava/io/Serializable;";
  return single && v !== null && !vcall(cls, "isInstance", "(Ljava/lang/Object;)Z", v) ? null : v;
}
/** BaseBundle.unparcel: read a parcelled bundle's values, once */
export function unparcel(b: JBaseBundle): void | Promise<void> {
  if (!b.parcelled) return;
  return b.unparcelling ??= unparcelBundle(b).finally(() => { b.unparcelling = null; });
}
/** a Bundle method that reads values: it unparcels first, as BaseBundle's accessors do */
const unparcelled = (f: (this: JBaseBundle, ...a: unknown[]) => unknown) =>
  function (this: JBaseBundle, ...a: unknown[]): unknown { return this.parcelled ? rt.drive(unparcelThen(this, f, a)) : f.apply(this, a); };
function* unparcelThen(b: JBaseBundle, f: (this: JBaseBundle, ...a: unknown[]) => unknown, a: unknown[]): Gen {
  yield unparcel(b);
  return f.apply(b, a);
}
function copyBundle(this: JBaseBundle, b: JBaseBundle | null) {
  if (!b) return;
  this.loader = b.loader;
  if (b.parcelled) this.parcelled = b.parcelled;
  else this.map = new Map(b.map);
}
const putAll = driven(function* (this: JBaseBundle, b: JBaseBundle): Gen {
  yield unparcel(b);
  for (const [k, v] of b.map) this.map.set(k, v);
});
/** BaseBundle's deep copy: nested bundles and arrays are copied too, other values are shared; a
 *  parcelled bundle copies its wire form */
function deepCopy(this: JBaseBundle): JBaseBundle {
  const copy = new (this.constructor as new () => JBaseBundle)();
  copy.loader = this.loader;
  if (this.parcelled) { copy.parcelled = this.parcelled; return copy; }
  for (const [k, v] of this.map) copy.map.set(k, v instanceof JBaseBundle ? deepCopy.call(v)
    : Array.isArray(v) ? Object.assign(v.slice(), { $t: (v as { $t?: string }).$t }) : ArrayBuffer.isView(v) ? (v as Uint8Array).slice() : v);
  return copy;
}
const bundleMethods: NativeSpec["methods"] = {
  "<init>(Landroid/os/Bundle;)V": copyBundle,
  "<init>(Landroid/os/PersistableBundle;)V": copyBundle,
  "<init>(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "clone()Ljava/lang/Object;": function (this: JBundle) {
    const copy = new (this.constructor as typeof JBundle)();
    copyBundle.call(copy, this);
    return copy;
  },
  ...noops("<init>()V", "<init>(I)V"),
  ...stubs(0, "describeContents()I"),
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JBundle, parcel: JParcel): Gen { yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this); }),
  "readFromParcel(Landroid/os/Parcel;)V": driven(function* (this: JBundle, parcel: JParcel): Gen {
    const read: JBundle | null = yield vcall(parcel, "readBundle", "(Ljava/lang/ClassLoader;)Landroid/os/Bundle;", this.loader);
    this.map = new Map();
    if (read) copyBundle.call(this, read);
  }),
  "isParcelled()Z": function (this: JBundle) { return +!!this.parcelled; },
  // an empty bundle is never kept parcelled
  "isDefinitelyEmpty()Z": function (this: JBundle) { return +(!this.parcelled && !this.map.size); },
  "getSize()I": function (this: JBundle) { return this.parcelled ? this.parcelled.bytes.length : 0; },
  "setAllowFds(Z)Z": function (this: JBundle, allow: number) { const previous = this.allowFds; this.allowFds = !!allow; return +previous; },
  "size()I": function (this: JBundle) { return this.map.size; },
  // A Bundle holds boxed values: `get` is the only reader that lost the declared width, and a
  // caller that reaches for Object then calls toString()/instanceof Number needs the box.
  "get(Ljava/lang/String;)Ljava/lang/Object;": function (this: JBundle, k: string) { return boxObject(this.map.get(k) ?? null); },
  "isEmpty()Z": function (this: JBundle) { return this.map.size ? 0 : 1; },
  "containsKey(Ljava/lang/String;)Z": function (this: JBundle, k: string) { return this.map.has(k) ? 1 : 0; },
  "remove(Ljava/lang/String;)V": function (this: JBundle, k: string) { this.map.delete(k); },
  "clear()V": function (this: JBundle) { this.map.clear(); },
  // ArrayMap's order: by key hash, insertion order among equal hashes (androidx.startup runs a
  // provider's initializers in its meta-data's key order)
  "keySet()Ljava/util/Set;": function (this: JBundle) {
    return newLinkedHashSet([...this.map.keys()].sort((a, b) => (a === null ? 0 : stringHash(a)) - (b === null ? 0 : stringHash(b))));
  },
  "putAll(Landroid/os/Bundle;)V": putAll,
  "putAll(Landroid/os/PersistableBundle;)V": putAll,
  "setClassLoader(Ljava/lang/ClassLoader;)V": function (this: JBundle, cl: unknown) { this.loader = cl; },
  "getClassLoader()Ljava/lang/ClassLoader;": function (this: JBundle) { return this.loader; },
  "getSerializable(Ljava/lang/String;)Ljava/io/Serializable;": function (this: JBundle, k: string) { return boxObject(this.map.get(k) ?? null); },
};
for (const [t, d] of BUNDLE_TYPES) {
  const zero = d.length > 1 ? null : d === "J" ? 0n : 0;
  bundleMethods[`put${t}(Ljava/lang/String;${d})V`] = function (this: JBundle, k: string, v: unknown) { this.map.set(k, bundleBox(v, d)); };
  bundleMethods[`get${t}(Ljava/lang/String;)${d}`] ??= function (this: JBundle, k: string) { return bundleGet(this, k, d, zero); };
  // AOSP boxes getByte's default; the reference types with a default overload are the two strings
  if (d === "B") bundleMethods["getByte(Ljava/lang/String;B)Ljava/lang/Byte;"] = function (this: JBundle, k: string, dv: number) { return box("B", bundleGet(this, k, d, dv) as number); };
  else if (zero !== null || t === "String" || t === "CharSequence") {
    bundleMethods[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JBundle, k: string, dv: unknown) { return bundleGet(this, k, d, dv); };
  }
}
for (const [t, d] of BUNDLE_TYPED) {
  bundleMethods[`get${t}(Ljava/lang/String;Ljava/lang/Class;)${d}`] = function (this: JBundle, k: string, cls: unknown) { return bundleTyped(this, k, cls, d); };
}
bundleMethods["hasFileDescriptors()Z"] = driven(function* (this: JBundle): Gen {
  // nothing here marshals a file descriptor, so a parcelled bundle carries none
  if (this.parcelled) return 0;
  for (const v of this.map.values()) if (yield* hasFds(v)) return 1;
  return 0;
});
/** Bundle.hasFileDescriptors' walk: a Parcelable reporting CONTENTS_FILE_DESCRIPTOR, in a list, array or bundle */
function* hasFds(v: unknown): Gen<boolean> {
  if (v instanceof JBundle) return !!(yield vcall(v, "hasFileDescriptors", "()Z"));
  if (Array.isArray(v)) { for (const x of v) if (yield* hasFds(x)) return true; return false; }
  if (rt.iof(v, "android/os/Parcelable")) return !!((yield vcall(v, "describeContents", "()I")) as number & 1);
  if (rt.iof(v, "java/util/List")) for (const x of (yield toJsArray(v)) as unknown[]) if (yield* hasFds(x)) return true;
  return false;
}
const PARCELLED_OK = new Set(["<init>(Landroid/os/Bundle;)V", "<init>(Landroid/os/PersistableBundle;)V", "<init>(Ljava/lang/ClassLoader;)V",
  "<init>()V", "<init>(I)V", "clone()Ljava/lang/Object;", "describeContents()I", "writeToParcel(Landroid/os/Parcel;I)V",
  "readFromParcel(Landroid/os/Parcel;)V", "setClassLoader(Ljava/lang/ClassLoader;)V", "getClassLoader()Ljava/lang/ClassLoader;",
  "isParcelled()Z", "isDefinitelyEmpty()Z", "getSize()I", "setAllowFds(Z)Z", "hasFileDescriptors()Z"]);
for (const [k, f] of Object.entries(bundleMethods)) if (typeof f === "function" && !PARCELLED_OK.has(k)) bundleMethods[k] = unparcelled(f as never);
/** what only Bundle holds (PersistableBundle keeps to strings, numbers and nested PersistableBundles) */
const PARCEL_STEMS = new Set(["Binder", "Bundle", "IBinder", "Parcelable", "ParcelableArray", "ParcelableArrayList", "Size", "SizeF", "SparseParcelableArray"]);
const bundleOnly = [
  ...BUNDLE_TYPES.filter(([t]) => PARCEL_STEMS.has(t)).flatMap(([t, d]) => [`put${t}(Ljava/lang/String;${d})V`, `get${t}(Ljava/lang/String;)${d}`]),
  ...BUNDLE_TYPED.filter(([t]) => PARCEL_STEMS.has(t)).map(([t, d]) => `get${t}(Ljava/lang/String;Ljava/lang/Class;)${d}`),
  "putAll(Landroid/os/Bundle;)V", "readFromParcel(Landroid/os/Parcel;)V", "getSize()I", "setAllowFds(Z)Z", "hasFileDescriptors()Z",
];
const persistableOnly = ["putPersistableBundle(Ljava/lang/String;Landroid/os/PersistableBundle;)V", "getPersistableBundle(Ljava/lang/String;)Landroid/os/PersistableBundle;"];
rt.register({ name: "android/os/BaseBundle", ctor: JBaseBundle, methods: without(bundleMethods, bundleOnly, persistableOnly,
  ["<init>(Landroid/os/Bundle;)V", "<init>(Landroid/os/PersistableBundle;)V", "describeContents()I", "writeToParcel(Landroid/os/Parcel;I)V"]) });
rt.register({ name: "android/os/Bundle", ctor: JBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], statics: { get EMPTY() { return new JBundle(); }, get CREATOR() { return parcelCreator("android/os/Bundle", (p) => vcall(p, "readBundle", "()Landroid/os/Bundle;")); } },
  methods: { ...without(bundleMethods, persistableOnly), "deepCopy()Landroid/os/Bundle;": deepCopy,
    "setDefusable(Z)V": function (this: JBundle, defusable: number) { this.defusable = !!defusable; } } });
rt.register({ name: "android/os/PersistableBundle", ctor: JPersistableBundle, sup: "android/os/BaseBundle",
  ifaces: ["android/os/Parcelable", "java/lang/Cloneable"], statics: { get EMPTY() { return new JPersistableBundle(); } },
  methods: { ...without(bundleMethods, bundleOnly, ["<init>(Ljava/lang/ClassLoader;)V"]), "deepCopy()Landroid/os/PersistableBundle;": deepCopy } });

export const PARCELABLE = {
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} as const;
rt.markers("android/os/Parcelable");
rt.markers("android/os/OutcomeReceiver");
const sharedMappings = new WeakSet<JBuffer>();
/** the ashmem region: guest memory, which each mapping's direct buffer addresses */
class JSharedMemory extends JObj {
  bytes: Int8Array = new Int8Array(0);
  protection = 7;
  closed = false;
  map(prot: number, offset: number, length: number): JBuffer | Promise<JBuffer> {
    if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
    if (offset < 0 || length <= 0 || offset > this.bytes.length - length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid shared memory range");
    if (prot < 0 || prot & ~7 || (prot & this.protection) !== prot) throw errno("mmap", E.ACCES);
    return after(directView(this.bytes, offset, length, !(prot & 2)), (buffer) => { sharedMappings.add(buffer); return buffer; });
  }
}
rt.register({
  name: "android/os/SharedMemory", ctor: JSharedMemory, ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: { get CREATOR() { return parcelCreator("android/os/SharedMemory", async (p) => {
    const protection = await vcall(p, "readInt", "()I") as number;
    const bytes = await vcall(p, "createByteArray", "()[B") as Int8Array;
    const shared = new JSharedMemory(); shared.protection = protection; shared.bytes = nonMovableBytes(bytes.length); shared.bytes.set(bytes);
    return shared;
  }); } },
  methods: {
    "static create(Ljava/lang/String;I)Landroid/os/SharedMemory;": (_name: string | null, size: number) => {
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Size must be positive");
      const shared = new JSharedMemory(); shared.bytes = nonMovableBytes(size); return shared;
    },
    "getSize()I": function (this: JSharedMemory) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      return this.bytes.length;
    },
    "map(III)Ljava/nio/ByteBuffer;": function (this: JSharedMemory, prot: number, offset: number, length: number) { return this.map(prot, offset, length); },
    "mapReadOnly()Ljava/nio/ByteBuffer;": function (this: JSharedMemory) { return this.map(1, 0, this.bytes.length); },
    "mapReadWrite()Ljava/nio/ByteBuffer;": function (this: JSharedMemory) { return this.map(3, 0, this.bytes.length); },
    "setProtect(I)Z": function (this: JSharedMemory, prot: number) {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      if (prot < 0 || prot & ~7) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid protection");
      if ((prot & this.protection) !== prot) return 0;
      this.protection = prot; return 1;
    },
    "static unmap(Ljava/nio/ByteBuffer;)V": (buffer: JBuffer | null) => {
      if (!buffer) return rt.npe();
      if (!sharedMappings.delete(buffer)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer is not mapped shared memory");
      return scall("java/nio/NioUtils", "freeDirectBuffer", "(Ljava/nio/ByteBuffer;)V", buffer);
    },
    "close()V": function (this: JSharedMemory) { this.closed = true; },
    "describeContents()I": () => 1,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JSharedMemory, parcel: JParcel): Gen {
      if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "SharedMemory is closed");
      yield vcall(parcel, "writeInt", "(I)V", this.protection);
      yield vcall(parcel, "writeByteArray", "([B)V", this.bytes.slice());
    }),
  },
});
class JCancellationSignal extends JObj {
  cancelled = 0;
  listener: unknown = null;
}
rt.markers("android/os/CancellationSignal$OnCancelListener");
rt.register({
  name: "android/os/CancellationSignal", ctor: JCancellationSignal,
  methods: {
    "<init>()V": function () {},
    "isCanceled()Z": function (this: JCancellationSignal) { return this.cancelled; },
    "cancel()V": driven(function* (this: JCancellationSignal): Gen {
      if (this.cancelled) return;
      this.cancelled = 1;
      if (this.listener) yield vcall(this.listener, "onCancel", "()V");
    }),
    "throwIfCanceled()V": function (this: JCancellationSignal) {
      if (this.cancelled) throw rt.mkThrowable("android/os/OperationCanceledException", null);
    },
    "setOnCancelListener(Landroid/os/CancellationSignal$OnCancelListener;)V": driven(function* (this: JCancellationSignal, listener: unknown): Gen {
      if (this.listener === listener) return;
      this.listener = listener;
      if (this.cancelled && listener) yield vcall(listener, "onCancel", "()V");
    }),
  },
});

class JParcelFileDescriptor extends JObj {
  bytes: Uint8Array = new Uint8Array(0);
  sink: ((b: Uint8Array, closed?: boolean) => unknown) | null = null;
  path = "";
  flags = 0;
  fd = -1;
  closed = false;
  backing: PfdBacking | null = null;
  descriptor: JObj | null = null;
  /** the descriptor a wrapper (ContentResolver's ParcelFileDescriptorInner) acts for */
  wrapped: JParcelFileDescriptor | null = null;
}
type PfdBacking = { path: string; refs: number; key: string; closing: Promise<void> | null; sink: ((b: Uint8Array, closed?: boolean) => unknown) | null };
/** the native descriptor, opened on first request: only a fd that crosses JNI needs one. A
 *  read-only descriptor over bytes with no file behind them reads those bytes. */
function pfdFd(p: JParcelFileDescriptor): number {
  if (p.wrapped && !p.closed) return pfdFd(p.wrapped);
  if (p.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "Already closed");
  if (p.fd < 0 && p.path) p.fd = javaOpenFd(p.path, p.flags);
  else if (p.fd < 0 && !p.sink) p.fd = javaBytesFd(p.bytes);
  return p.fd;
}
let pfdBackingSeq = 0;
const pfdBackings = new Map<string, PfdBacking>();
export const pfdBackingBytes = driven(function* pfdBackingBytes(key: string): Gen<Uint8Array | null> {
  const backing = pfdBackings.get(key);
  if (backing?.closing) { yield backing.closing; return null; }
  return backing ? vfs.read(backing.path) : null;
});
export function mkPfd(bytes: Uint8Array, sink: ((b: Uint8Array, closed?: boolean) => unknown) | null, backingKey?: string): JParcelFileDescriptor {
  const p = new JParcelFileDescriptor();
  p.bytes = bytes;
  p.sink = sink;
  if (backingKey) {
    let backing = pfdBackings.get(backingKey);
    if (!backing) {
      backing = { path: `/data/webdroid-pfd-${++pfdBackingSeq}`, refs: 0, key: backingKey, closing: null, sink };
      pfdBackings.set(backingKey, backing);
      vfs.markVolatile(backing.path);
      vfs.write(backing.path, bytes, false);
    }
    if (sink) backing.sink = sink;
    backing.refs++;
    p.path = backing.path;
    p.flags = sink ? 2 : 0;
    p.backing = backing;
  }
  return p;
}
export function parcelFileDescriptorData(value: unknown): { bytes: Uint8Array; writable: boolean } | null {
  return value instanceof JParcelFileDescriptor
    ? { bytes: (value.backing ? vfs.read(value.backing.path) : value.bytes)?.slice() ?? new Uint8Array(0), writable: value.sink !== null }
    : null;
}
export const writeParcelFileDescriptor = driven(function* writeParcelFileDescriptor(value: unknown, bytes: Uint8Array, closed: boolean = false): Gen<void> {
  if (!(value instanceof JParcelFileDescriptor)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a ParcelFileDescriptor");
  value.bytes = bytes.slice();
  if (value.backing) vfs.write(value.backing.path, value.bytes, false);
  yield value.sink?.(value.bytes, closed);
});
rt.register({
  name: "android/os/ParcelFileDescriptor", ctor: JParcelFileDescriptor,
  ifaces: ["android/os/Parcelable", "java/io/Closeable"],
  statics: {
    MODE_READ_ONLY: 0x10000000, MODE_WRITE_ONLY: 0x20000000, MODE_READ_WRITE: 0x30000000,
    MODE_CREATE: 0x08000000, MODE_TRUNCATE: 0x04000000, MODE_APPEND: 0x02000000,
    get CREATOR() { return parcelCreator("android/os/ParcelFileDescriptor", async (parcel) => readObject(parcel)); },
  },
  methods: {
    // a wrapper over another descriptor: its file, released when the wrapper closes
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JParcelFileDescriptor, wrapped: JParcelFileDescriptor | null) {
      if (!wrapped) rt.npe();
      const { bytes, sink, path, flags, backing } = wrapped!;
      Object.assign(this, { bytes, sink, path, flags, backing, wrapped });
    },
    "static open(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;": driven(function* (f: JObj | null, mode: number): Gen {
      if (!f) rt.npe();
      const path = pathOf(f!);
      if (!vfs.exists(path) && !(mode & 0x08000000)) throw rt.mkThrowable("java/io/FileNotFoundException", path);
      if (mode & 0x04000000) vfs.write(path, new Uint8Array(0));
      const source = vfs.source(path);
      const p = mkPfd(source ? yield readFully(source) : new Uint8Array(0), mode & 0x20000000 ? (b) => vfs.write(path, b) : null);
      p.path = path;
      // MODE_* bits → O_* flags: the access mode, then create/truncate/append
      p.flags = ((mode >>> 28) & 3) - 1 + (mode & 0x08000000 ? 0x40 : 0) + (mode & 0x04000000 ? 0x200 : 0) + (mode & 0x02000000 ? 0x400 : 0);
      return p;
    }),
    "static parseMode(Ljava/lang/String;)I": (m: string) => {
      switch (m) {
        case "r": return 0x10000000;
        case "w": case "wt": return 0x2c000000;
        case "wa": return 0x2a000000;
        case "rw": return 0x38000000;
        case "rwt": return 0x3c000000;
        default: throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bad mode: " + m);
      }
    },
    // AOSP keeps one FileDescriptor per ParcelFileDescriptor, invalidated when it closes
    "getFileDescriptor()Ljava/io/FileDescriptor;": function (this: JParcelFileDescriptor) {
      if (this.descriptor) return this.descriptor;
      return after(mkFd(pfdFd(this)), (d) => this.descriptor ??= d);
    },
    "getFd()I": function (this: JParcelFileDescriptor) { return pfdFd(this); },
    "seekTo(J)J": function (this: JParcelFileDescriptor, pos: bigint) {
      const r = javaSeekFd(pfdFd(this), Number(pos), 0);
      if (r < 0) throw errno("lseek", -r);
      return BigInt(r);
    },
    "static adoptFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd }),
    "static fromFd(I)Landroid/os/ParcelFileDescriptor;": (fd: number) => Object.assign(new JParcelFileDescriptor(), { fd: javaDupFd(fd) }),
    // AOSP dup(FileDescriptor): a new descriptor on the same open file description
    "static dup(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;": (d: JObj | null) => {
      if (fdInt(d) < 0) throw rt.mkThrowable("java/io/IOException", "Invalid file descriptor");
      const fd = javaDupFd(fdInt(d));
      if (fd < 0) throw rt.mkThrowable("java/io/IOException", "dup failed: EBADF (Bad file descriptor)");
      return Object.assign(new JParcelFileDescriptor(), { fd });
    },
    "detachFd()I": function (this: JParcelFileDescriptor) {
      const fd = pfdFd(this);
      this.fd = -1; this.closed = true;
      if (this.descriptor) setFdInt(this.descriptor, -1);
      return fd;
    },
    "dup()Landroid/os/ParcelFileDescriptor;": function (this: JParcelFileDescriptor) {
      const p = Object.assign(mkPfd(this.bytes, this.sink), { path: this.path, flags: this.flags, fd: javaDupFd(pfdFd(this)), backing: this.backing });
      if (p.backing) p.backing.refs++;
      return p;
    },
    "getStatSize()J": function (this: JParcelFileDescriptor) { return BigInt(this.backing ? vfs.stat(this.backing.path)?.size ?? 0 : this.bytes.length); },
    // A parcel carries a duplicate of the descriptor, as the kernel does; another process gets
    // its bytes and a binder back to it (exportParcel), since binder IPC here moves no descriptors.
    "describeContents()I": () => 1, // CONTENTS_FILE_DESCRIPTOR
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JParcelFileDescriptor, parcel: JParcel, flags: number): Gen {
      writeObject(parcel, yield vcall(this, "dup", "()Landroid/os/ParcelFileDescriptor;"));
      if (flags & 1) yield vcall(this, "close", "()V"); // PARCELABLE_WRITE_RETURN_VALUE
    }),
    "close()V": driven(function* (this: JParcelFileDescriptor): Gen {
      if (this.closed) return;
      if (this.wrapped) {
        this.closed = true;
        if (this.descriptor) setFdInt(this.descriptor, -1);
        return yield vcall(this.wrapped, "close", "()V");
      }
      if (this.fd >= 0) javaCloseFd(this.fd);
      this.fd = -1; this.closed = true;
      if (this.descriptor) setFdInt(this.descriptor, -1);
      if (this.backing && --this.backing.refs === 0) {
        const backing = this.backing, bytes = vfs.read(backing.path) ?? new Uint8Array(0);
        backing.closing = (async () => {
          try { await backing.sink?.(bytes, true); }
          finally {
            pfdBackings.delete(backing.key);
            vfs.delete(backing.path, false);
          }
        })();
        yield backing.closing;
      }
    }),
    "checkError()V": () => {},
  },
});
class JPfdIn extends JObj { buf: Uint8Array = new Uint8Array(0); pos = 0; pfd: JParcelFileDescriptor | null = null; channel: JObj | null = null; }
const pfdDescriptor = (s: JPfdIn) => {
  if (!s.pfd) throw rt.mkThrowable("java/io/IOException", "Stream Closed");
  return vcall(s.pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
};
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseInputStream", ctor: JPfdIn, sup: "java/io/InputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdIn, p: JParcelFileDescriptor) { this.buf = p.bytes; this.pfd = p; },
    ...heldByteReads,
    // FileInputStream's, which AOSP's subclasses (AssetFileDescriptor's streams) reach
    "getFD()Ljava/io/FileDescriptor;": function (this: JPfdIn) { return pfdDescriptor(this); },
    "getChannel()Ljava/nio/channels/FileChannel;": driven(function* (this: JPfdIn): Gen {
      return this.channel ??= yield scall("sun/nio/ch/FileChannelImpl", "open", "(Ljava/io/FileDescriptor;Ljava/lang/String;ZZLjava/lang/Object;)Ljava/nio/channels/FileChannel;",
        yield pfdDescriptor(this), null, 1, 0, this);
    }),
    "close()V": function (this: JPfdIn) { const pfd = this.pfd; this.pfd = null; if (pfd) return vcall(pfd, "close", "()V"); },
  },
});
class JPfdOut extends JObj { chunks: number[] = []; pfd: JParcelFileDescriptor | null = null; }
const pfdFlush = async function (this: JPfdOut, closed = false) {
  const pfd = this.pfd, bytes = Uint8Array.from(this.chunks);
  // a backed descriptor's sink takes its file when the last holder closes
  if (pfd?.backing) vfs.write(pfd.backing.path, bytes, false);
  else await pfd?.sink?.(bytes, closed);
};
rt.register({
  name: "android/os/ParcelFileDescriptor$AutoCloseOutputStream", ctor: JPfdOut, sup: "java/io/OutputStream",
  methods: {
    "<init>(Landroid/os/ParcelFileDescriptor;)V": function (this: JPfdOut, p: JParcelFileDescriptor) { this.pfd = p; },
    ...heldByteWrites,
    "flush()V": pfdFlush,
    // FileOutputStream's, which PackageInstaller.Session.fsync reaches: the written bytes, then the descriptor
    "getFD()Ljava/io/FileDescriptor;": driven(function* (this: JPfdOut): Gen {
      if (!this.pfd) throw rt.mkThrowable("java/io/IOException", "Stream Closed");
      yield pfdFlush.call(this);
      return vcall(this.pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
    }),
    "close()V": driven(function* (this: JPfdOut): Gen { yield pfdFlush.call(this, true); const pfd = this.pfd; this.pfd = null; if (pfd) yield vcall(pfd, "close", "()V"); }),
  },
});

// statvfs answers the browser's storage estimate for whichever path is asked about (one
// filesystem backs everything here), in 4K blocks.
const BLK = 4096n;
const statVfsFields = ["f_bsize", "f_frsize", "f_blocks", "f_bfree", "f_bavail", "f_files", "f_ffree", "f_favail", "f_fsid", "f_flag", "f_namemax"] as const;
class JStructStatVfs extends JObj {
  f_bsize = 0n; f_frsize = 0n; f_blocks = 0n; f_bfree = 0n; f_bavail = 0n;
  f_files = 0n; f_ffree = 0n; f_favail = 0n; f_fsid = 0n; f_flag = 0n; f_namemax = 0n;
}
rt.register({ name: "android/system/StructStatVfs", ctor: JStructStatVfs, fields: [...statVfsFields], methods: {
  "<init>(JJJJJJJJJJJ)V": function (this: JStructStatVfs, ...values: bigint[]) {
    for (let i = 0; i < statVfsFields.length; i++) Reflect.set(this, statVfsFields[i], values[i]);
  },
} });
// the internal storage volume, identified by the platform's default UUID (StorageManager.UUID_DEFAULT)
let storageUuid: ReturnType<typeof uuidFromString> | null = null;
export const uuidDefault = () => storageUuid ??= uuidFromString("41217664-9172-527a-b3d5-edabb50a7d69");
export const storageEstimate = driven(function* storageEstimate(): Gen<{ total: number; free: number }> {
  try {
    const e = yield navigator.storage?.estimate?.();
    return { total: e?.quota ?? 0, free: Math.max(0, (e?.quota ?? 0) - (e?.usage ?? 0)) };
  } catch { return { total: 0, free: 0 }; /* no estimate available: report an empty filesystem */ }
});
// android.system.Os: the libcore syscall surface over the same descriptor table native code uses
class JErrnoException extends JThrowable { errno = 0; functionName = ""; }
function errnoMessage(this: JErrnoException): string {
  const name = Object.entries(E).find(([, value]) => value === this.errno)?.[0];
  return `${this.functionName} failed: ${name ? "E" + name : "errno " + this.errno} (${ERRSTR[this.errno] ?? "Unknown error " + this.errno})`;
}
function initErrno(this: JErrnoException, fn: string, value: number, cause: JThrowable | null = null) {
  this.functionName = fn; this.errno = value; this.cause = cause;
}
const rethrowAs = (cls: string) => function (this: JErrnoException) {
  const error = rt.mkThrowable(cls, errnoMessage.call(this)); error.cause = this; throw error;
};
rt.register({
  name: "android/system/ErrnoException", ctor: JErrnoException, sup: "java/lang/Exception",
  fields: ["errno", "functionName"],
  methods: {
    "<init>(Ljava/lang/String;I)V": initErrno,
    "<init>(Ljava/lang/String;ILjava/lang/Throwable;)V": initErrno,
    "getMessage()Ljava/lang/String;": errnoMessage,
    "rethrowAsIOException()Ljava/io/IOException;": rethrowAs("java/io/IOException"),
    "rethrowAsSocketException()Ljava/net/SocketException;": rethrowAs("java/net/SocketException"),
  },
});
export const errno = (fn: string, e: number) => { const x = rt.mkThrowable("android/system/ErrnoException", fn) as JErrnoException; initErrno.call(x, fn, e); return x; };
/** a path's file stat, null for a directory; ENOENT for neither */
const existing = (fn: string, path: string) => { const st = vfs.stat(path); if (!st && !vfs.isDir(path)) throw errno(fn, 2); return st; };
class JStructStat extends JObj {
  st_dev = 0n; st_ino = 0n; st_mode = 0; st_nlink = 1n; st_uid = 0; st_gid = 0; st_size = 0n; st_atime = 0n; st_mtime = 0n; st_ctime = 0n;
  st_blksize = 4096n; st_blocks = 0n; st_atim: JObj | null = null; st_mtim: JObj | null = null; st_ctim: JObj | null = null;
}
rt.register({
  name: "android/system/StructStat", ctor: JStructStat,
  fields: ["st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_atime", "st_mtime",
    "st_ctime", "st_blksize", "st_blocks", "st_atim", "st_mtim", "st_ctim"],
});
/** libcore's StructTimespec for a time in milliseconds */
function timespec(ms: number): JObj {
  const t = rt.make("android/system/StructTimespec") as Record<string, bigint>;
  t[declaredField("android/system/StructTimespec", "tv_sec")] = BigInt(Math.floor(ms / 1000));
  t[declaredField("android/system/StructTimespec", "tv_nsec")] = BigInt(Math.round((ms % 1000) * 1e6));
  return t as unknown as JObj;
}
class JStructUtsname extends JObj {
  sysname = "Linux";
  nodename = "localhost";
  release = "5.10.0-webdroid";
  version = "#1 SMP PREEMPT";
  machine = "aarch64";
}
rt.register({
  name: "android/system/StructUtsname", ctor: JStructUtsname,
  fields: ["sysname", "nodename", "release", "version", "machine"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: JStructUtsname, sysname: string, nodename: string, release: string, version: string, machine: string) {
        this.sysname = sysname; this.nodename = nodename; this.release = release; this.version = version; this.machine = machine;
      },
  },
});
export const FD = "Ljava/io/FileDescriptor;";
function statOf(path: string | null, size: number, mode: number, mtimeMs: number): JStructStat {
  const s = new JStructStat();
  s.st_mode = mode;
  s.st_uid = s.st_gid = vfs.owner(path);
  s.st_size = BigInt(size);
  s.st_mtime = s.st_atime = s.st_ctime = BigInt(Math.floor(mtimeMs / 1000));
  s.st_mtim = s.st_atim = s.st_ctim = timespec(mtimeMs);
  s.st_blocks = (s.st_size + 511n) / 512n;
  return s;
}
const storageStatVfs = driven(function* storageStatVfs(): Gen<JStructStatVfs> {
  const { total, free } = yield storageEstimate();
  const s = new JStructStatVfs();
  s.f_bsize = s.f_frsize = BLK;
  s.f_blocks = BigInt(Math.floor(total / Number(BLK)));
  s.f_bfree = s.f_bavail = BigInt(Math.floor(free / Number(BLK)));
  s.f_namemax = 255n;
  return s;
});
// libcore.io.Linux: the syscalls behind android.system.Os and Libcore.os, over the descriptor
// table native code shares
const linux: Record<string, (...args: never[]) => unknown> = {
    "open(Ljava/lang/String;II)Ljava/io/FileDescriptor;": (path: string, flags: number) => {
      if (path === null) rt.npe();
      const fd = javaOpenFd(path, flags);
      if (fd < 0) throw errno("open", -fd);
      return mkFd(fd);
    },
    [`fstat(${FD})Landroid/system/StructStat;`]: (d: JObj | null) => {
      const st = javaFdStat(fdInt(d));
      if (!st) throw errno("fstat", E.BADF);
      return statOf(st.path, st.size, st.mode, st.path ? vfs.mtime(st.path) : 0);
    },
    [`readBytes(${FD}Ljava/lang/Object;II)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      readBytes("read", buffer, offset, count, (target) => javaReadFd(fdInt(d), target)),
    [`preadBytes(${FD}Ljava/lang/Object;IIJ)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      readBytes("pread", buffer, offset, count, (target) => javaPreadFd(fdInt(d), target, Number(position))),
    [`writeBytes(${FD}Ljava/lang/Object;II)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      writeBytes(buffer, offset, count, (bytes) => ioResult("write", javaWriteFd(fdInt(d), bytes))),
    [`pwriteBytes(${FD}Ljava/lang/Object;IIJ)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      writeBytes(buffer, offset, count, (bytes) => ioResult("pwrite", javaPwriteFd(fdInt(d), bytes, Number(position)))),
    [`ftruncate(${FD}J)V`]: (d: JObj | null, length: bigint) => sys("ftruncate", javaTruncateFd(fdInt(d), Number(length))),
    [`fsync(${FD})V`]: (d: JObj | null) => sys("fsync", javaSyncFd(fdInt(d))),
    [`fdatasync(${FD})V`]: (d: JObj | null) => sys("fdatasync", javaSyncFd(fdInt(d))),
    [`ioctlInt(${FD}I)I`]: (d: JObj | null, request: number) => ioResult("ioctl", javaIoctlIntFd(fdInt(d), request)),
    [`fcntlInt(${FD}II)I`]: (d: JObj | null, cmd: number, arg: number) => ioResult("fcntl", javaFcntlFd(fdInt(d), cmd, arg)),
    [`fcntlVoid(${FD}I)I`]: (d: JObj | null, cmd: number) => ioResult("fcntl", javaFcntlFd(fdInt(d), cmd, 0)),
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
    [`lseek(${FD}JI)J`]: (d: JObj | null, off: bigint, whence: number) => {
      const r = javaSeekFd(fdInt(d), Number(off), whence);
      if (r < 0) throw errno("lseek", -r);
      return BigInt(r);
    },
    [`close(${FD})V`]: (d: JObj | null) => {
      if (d === null) return rt.npe();
      const fd = fdInt(d), owner = (d as unknown as Record<string, bigint | undefined>)[declaredField("java/io/FileDescriptor", "ownerId")];
      setFdInt(d, -1);
      sys("close", fdsanClose(fd, owner ?? 0n, javaCloseFd));
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
      const source = anonymous ? null : javaFdSource(fd);
      if (!anonymous && !source) throw errno("mmap", E.BADF);
      if (source && prot === 0) throw errno("mmap", E.NOTSUP);
      const file = flags & 1 ? fdFile(fd) : null;
      if (flags & 1 && prot & 2 && !file) throw errno("mmap", E.NOTSUP);
      const address = mem.mapVa(size, prot === 0);
      if (!address) throw errno("mmap", E.NOMEM);
      try {
        if (source && prot) mem.write(guestAt(address), yield readFully(source, Number(offset), size));
      } catch {
        mem.unmapVa(BigInt(address), size);
        throw errno("mmap", E.IO);
      }
      if (file) trackSharedMap(BigInt(address), size, Number(offset), file, (prot & 2) !== 0);
      return BigInt(address);
    }),
    "munmap(JJ)V": (address: bigint, count: bigint) => {
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size <= 0 || address & 4095n) throw errno("munmap", E.INVAL);
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
    "uname()Landroid/system/StructUtsname;": () => {
      const info = new JStructUtsname();
      info.machine = is64BitProcess() ? "aarch64" : "armv7l";
      return info;
    },
    "sysconf(I)J": (name: number) => BigInt(sysconf(name)),
    "stat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) => {
      const st = existing("stat", path);
      return statOf(path, st?.size ?? 0, st ? 0o100644 : 0o40755, vfs.mtime(path));
    },
    // the VFS keeps no permission bits or owners: an existing file takes any mode, and the groups an app may own
    "chmod(Ljava/lang/String;I)V": (path: string) => {
      if (path === null) rt.npe();
      existing("chmod", path);
    },
    "chown(Ljava/lang/String;II)V": (path: string, uid: number, gid: number) => {
      if (path === null) rt.npe();
      existing("chown", path);
      if (!mayChown(uid, gid)) throw errno("chown", E.PERM);
    },
    // the VFS keeps no extended attributes, as a filesystem without xattr support
    "setxattr(Ljava/lang/String;Ljava/lang/String;[BI)V": (path: string, name: string) => {
      if (path === null || name === null) rt.npe();
      existing("setxattr", path);
      throw errno("setxattr", OS_CONSTANTS.EOPNOTSUPP);
    },
    "statvfs(Ljava/lang/String;)Landroid/system/StructStatVfs;": (path: string) => {
      existing("statvfs", path);
      return storageStatVfs();
    },
    [`fstatvfs(${FD})Landroid/system/StructStatVfs;`]: (d: JObj | null) => {
      if (fdInt(d) < 0) throw errno("fstatvfs", E.BADF);
      return storageStatVfs();
    },
    "readlink(Ljava/lang/String;)Ljava/lang/String;": () => { throw errno("readlink", 22); },
    "access(Ljava/lang/String;I)Z": (path: string, mode: number) => { if (path === null) rt.npe(); sys("access", accessPath(null, path, mode)); return 1; },
    "remove(Ljava/lang/String;)V": (path: string) => { if (path === null) rt.npe(); sys("remove", removePath(null, path)); },
    // the VFS keeps no permission bits: the mode is not recorded
    "mkdir(Ljava/lang/String;I)V": (path: string) => { if (path === null) rt.npe(); sys("mkdir", mkdirPath(null, path)); },
    "rename(Ljava/lang/String;Ljava/lang/String;)V": (from: string, to: string) => {
      if (from === null || to === null) rt.npe();
      sys("rename", renamePath(null, from, to));
    },
};
/** a -errno result as the ErrnoException libcore's Os methods throw */
export function sys(fn: string, result: number): void { if (result < 0) throw errno(fn, -result); }
export const ioResult = (fn: string, result: number): number => { sys(fn, result); return result; };
/** sendfile moves at most this much a call, which its callers loop over as Linux allows */
const SENDFILE_CHUNK = 1 << 20;
/** the Object readBytes and its kin take: a byte[], or a direct ByteBuffer addressed from its start */
export type IoBuffer = Int8Array | JBuffer | null;
export function ioRegion(buffer: IoBuffer, offset: number, count: number): Uint8Array {
  if (buffer === null) return rt.npe();
  const view = isBuffer(buffer) ? bufferBytes(buffer) : buffer;
  checkFromIndexSize(offset, count, view.byteLength, "java/lang/ArrayIndexOutOfBoundsException");
  return new Uint8Array(view.buffer, view.byteOffset + offset, count);
}
/** the bytes to write, once a mapped direct buffer's pages are in */
export function writeBytes<T>(buffer: IoBuffer, offset: number, count: number, write: (bytes: Uint8Array) => T): T | Promise<T> {
  return after(isBuffer(buffer) ? resident(buffer) : null, () => write(ioRegion(buffer, offset, count)));
}
/** A direct buffer may live in guest memory, which can move while a read waits: it takes the
 *  bytes once they have arrived. */
export function readBytes(fn: string, buffer: IoBuffer, offset: number, count: number, read: (target: Uint8Array) => number | Promise<number>) {
  const target = ioRegion(buffer, offset, count);
  if (!isBuffer(buffer)) return after(read(target), (n) => ioResult(fn, n));
  const scratch = new Uint8Array(count);
  return after(read(scratch), (n) => {
    if (n > 0) ioRegion(buffer, offset, n).set(scratch.subarray(0, n));
    return ioResult(fn, n);
  });
}
rt.registerJnis("libcore/io/Linux", linux);
// System.getenv(): the environment as alternating name and value bytes
rt.registerJni("java/lang/ProcessEnvironment", "environ()[[B", () => jarray(Object.entries(processEnv).flat().map(bytesOf), "[B"));
// Android interrupts threads blocked on the descriptor; a reader parked on a pipe here stays parked
rt.registerJni("libcore/io/AsynchronousCloseMonitor", `signalBlockedThreads(${FD})V`, () => {});

// java.io.UnixFileSystem: java.io.File's natives over the VFS. It keeps no permission bits and
// no hard links, so a mode change on an existing path succeeds, as chmod does above.
const BA_EXISTS = 1, BA_REGULAR = 2, BA_DIRECTORY = 4;
const unixFileSystem: Record<string, (...args: never[]) => unknown> = {
  "initIDs()V": () => {},
  "canonicalize0(Ljava/lang/String;Z)Ljava/lang/String;": (path: string) => vfs.norm(path),
  "getBooleanAttributes0(Ljava/lang/String;)I": (path: string) => {
    const p = vfs.norm(path);
    return vfs.isDir(p) ? BA_EXISTS | BA_DIRECTORY : vfs.exists(p) ? BA_EXISTS | BA_REGULAR : 0;
  },
  "list0(Ljava/io/File;)[Ljava/lang/String;": (file: JObj) => {
    const p = pathOf(file);
    return vfs.isDir(p) ? jarray(vfs.list(p), "Ljava/lang/String;") : null;
  },
  "createFileExclusively0(Ljava/lang/String;)Z": (path: string) => {
    const r = createPath(null, path);
    if (r === -E.EXIST) return 0;
    // JNU_ThrowIOExceptionWithLastError: an IOException carrying strerror
    if (r < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-r] ?? path);
    return 1;
  },
  "createDirectory0(Ljava/io/File;)Z": (file: JObj) => +(mkdirPath(null, pathOf(file)) === 0),
  "getLastModifiedTime0(Ljava/io/File;)J": (file: JObj) => BigInt(vfs.mtime(pathOf(file))),
  "setLastModifiedTime0(Ljava/io/File;J)Z": (file: JObj, ms: bigint) => {
    const p = pathOf(file);
    if (!vfs.exists(p)) return 0;
    vfs.mtimes.set(p, Number(ms)); return 1;
  },
  "setPermission0(Ljava/io/File;IZZ)Z": (file: JObj) => +vfs.exists(pathOf(file)),
  "setReadOnly0(Ljava/io/File;)Z": (file: JObj) => +vfs.exists(pathOf(file)),
  // FileSystem.SPACE_TOTAL, SPACE_FREE, SPACE_USABLE
  "getSpace0(Ljava/io/File;I)J": driven(function* (_file: JObj, kind: number): Gen {
    const s: JStructStatVfs = yield storageStatVfs();
    return kind === 0 ? s.f_blocks * s.f_frsize : kind === 1 ? s.f_bfree * s.f_frsize : s.f_bavail * s.f_bsize;
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
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, AT_FDCWD = -100, AT_REMOVEDIR = 0x200;
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
function fillAttrs(attrs: JObj, path: string, mode: number, size: number): void {
  const a = attrs as unknown as Record<string, number | bigint>;
  const p = attrProps ??= ATTR_FIELDS.map((name) => declaredField("sun/nio/fs/UnixFileAttributes", name));
  const ms = vfs.mtime(path), sec = BigInt(Math.floor(ms / 1000)), nsec = BigInt((ms % 1000) * 1e6);
  a[p[0]] = mode; a[p[1]] = BigInt(inoOf(path)); a[p[2]] = 1n; a[p[3]] = 1; a[p[4]] = a[p[5]] = procIdentity.uid; a[p[6]] = BigInt(size);
  for (let i = 7; i < 13; i += 2) { a[p[i]] = sec; a[p[i + 1]] = nsec; }
}
/** stat(2) of a path: a directory, or a file (procfs included) */
function statPath(path: string, attrs: JObj | null): number {
  const p = vfs.norm(path), dir = vfs.isDir(p), st = dir ? null : vfs.stat(p);
  if (!dir && !st) throw unixError(E.NOENT);
  const mode = dir ? S_IFDIR | 0o755 : S_IFREG | 0o644;
  if (attrs) fillAttrs(attrs, p, mode, dir ? 4096 : st!.size);
  return mode;
}
function unlinkPath(path: string): void {
  const p = vfs.norm(path);
  if (vfs.isDir(p)) throw unixError(E.ISDIR);
  if (!vfs.delete(p)) throw unixError(E.NOENT);
}
function rmdirPath(path: string): void {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) throw unixError(vfs.exists(p) ? E.NOTDIR : E.NOENT);
  if (vfs.list(p).length) throw unixError(E.NOTEMPTY);
  vfs.rmdir(p);
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
function chownPath(path: string, uid: number, gid: number): void {
  statPath(path, null);
  if (!mayChown(uid, gid)) throw unixError(E.PERM);
}
const fdPath = (fd: number): string => { const st = javaFdStat(fd); if (!st) throw unixError(E.BADF); return st.path ?? ""; };
/** open DIR streams: the entries as readdir(3) returns them, and the descriptor closedir closes */
const dirStreams = new Map<bigint, { names: string[]; i: number; fd: number }>();
let nextDir = 0n;
function openDirStream(path: string, fd: number): bigint {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) throw unixError(vfs.exists(p) ? E.NOTDIR : E.NOENT);
  dirStreams.set(++nextDir, { names: [".", "..", ...vfs.list(p)], i: 0, fd });
  return nextDir;
}
const passwdName = (id: number) => bytesOf(appUserName(id));
const unixNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  // SUPPORTS_OPENAT | SUPPORTS_FUTIMES: bionic has openat64, fstatat64, unlinkat, renameat, futimesat
  // and fdopendir. UnixException is initialized first, since the natives throw it synchronously.
  "init()I": () => after(rt.initClass(rt.link("sun/nio/fs/UnixException")), () => 6),
  "getcwd()[B": () => bytesOf("/"),
  "strerror(I)[B": (e: number) => bytesOf(ERRSTR[e] ?? `Unknown error ${e}`),
  "dup(I)I": (fd: number) => unixSys(javaDupFd(fd)),
  "open0(JII)I": (path: bigint, flags: number) => unixSys(javaOpenFd(cpath(path), flags)),
  "openat0(IJII)I": (dfd: number, path: bigint, flags: number) => unixSys(javaOpenFd(atPath(dfd, path), flags)),
  "close(I)V": (fd: number) => { unixSys(javaCloseFd(fd)); },
  "link0(JJ)V": () => { throw unixError(E.PERM); },
  "symlink0(JJ)V": () => { throw unixError(E.PERM); },
  "unlink0(J)V": (path: bigint) => unlinkPath(cpath(path)),
  "unlinkat0(IJI)V": (dfd: number, path: bigint, flags: number) => (flags & AT_REMOVEDIR ? rmdirPath : unlinkPath)(atPath(dfd, path)),
  "rename0(JJ)V": (from: bigint, to: bigint) => { unixSys(renamePath(null, cpath(from), cpath(to))); },
  "renameat0(IJIJ)V": (fromDir: number, from: bigint, toDir: number, to: bigint) => { unixSys(renamePath(null, atPath(fromDir, from), atPath(toDir, to))); },
  "mkdir0(JI)V": (path: bigint) => { unixSys(mkdirPath(null, cpath(path))); },
  "rmdir0(J)V": (path: bigint) => rmdirPath(cpath(path)),
  // an existing path is never a link
  "readlink0(J)[B": (path: bigint) => { statPath(cpath(path), null); throw unixError(E.INVAL); },
  "realpath0(J)[B": (path: bigint) => { const p = vfs.norm(cpath(path)); statPath(p, null); return bytesOf(p); },
  "stat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => { statPath(cpath(path), attrs); },
  "lstat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => { statPath(cpath(path), attrs); },
  "stat1(J)I": (path: bigint) => { try { return statPath(cpath(path), null); } catch { return 0; } },
  "fstatat0(IJILsun/nio/fs/UnixFileAttributes;)V": (dfd: number, path: bigint, _flag: number, attrs: JObj) => { statPath(atPath(dfd, path), attrs); },
  "fstat(ILsun/nio/fs/UnixFileAttributes;)V": (fd: number, attrs: JObj) => {
    const st = javaFdStat(fd);
    if (!st) throw unixError(E.BADF);
    fillAttrs(attrs, st.path ?? "", st.mode, (st.mode & S_IFMT) === S_IFDIR ? 4096 : st.size);
  },
  "chmod0(JI)V": (path: bigint) => { statPath(cpath(path), null); },
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
  "access0(JI)V": (path: bigint, mode: number) => { unixSys(accessPath(null, cpath(path), mode)); },
  "exists0(J)Z": (path: bigint) => +(accessPath(null, cpath(path), 0) === 0),
  "getpwuid(I)[B": passwdName,
  "getgrgid(I)[B": passwdName,
  "statvfs0(JLsun/nio/fs/UnixFileStoreAttributes;)V": driven(function* (path: bigint, attrs: JObj): Gen {
    statPath(cpath(path), null);
    const s: JStructStatVfs = yield storageStatVfs(), a = attrs as unknown as Record<string, bigint>;
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
    const n = unixSys(yield javaReadFd(src, buffer));
    if (!n) return;
    if (cancel && mem.ld32(mem.txVa(cancel))) throw unixError(OS_CONSTANTS.ECANCELED);
    for (let at = 0; at < n;) at += unixSys(javaWriteFd(dst, buffer.subarray(at, n)));
  }
}));
// libcore's OsConstants fills its fields from native initConstants(); these are the reference
// device's values (bun run gen-framework)
rt.registerJni("android/system/OsConstants", "initConstants()V", () => {
  const info = rt.link("android/system/OsConstants");
  for (const [name, value] of Object.entries(OS_CONSTANTS)) {
    const prop = info.staticFieldTable.get(name + ":I");
    if (prop) info.ctor[prop] = value;
  }
});
rt.register({ name: "android/os/ext/SdkExtensions", ctor: class extends JObj {}, methods: { "static getExtensionVersion(I)I": () => 0 } });
