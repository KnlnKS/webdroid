// ART's array allocation and process configuration boundaries.
import { rt, JObj } from "../runtime";
import { jarray, PRIM_ARRAYS, type PrimElem } from "../abi";
import { classDesc, libraryAbi, type JClass } from "./jlang";
import { ABIS_32 } from "../../shell/properties";
import { device } from "../../shell/config";
import { mem } from "../../native/mem";
import { handle } from "../../android/handles";
import { nonMovableBytes } from "./jnio";
import { hostAddress } from "./jmemory";
import { BOOT_JAR_PATHS } from "../bootclasspath";

function newArrayOf(cls: JClass | null, len: number): unknown {
  if (len < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", String(len));
  const elem = classDesc(cls);
  if (elem === "V") throw rt.mkThrowable("java/lang/IllegalArgumentException", "Can't allocate an array of void");
  return elem in PRIM_ARRAYS ? new PRIM_ARRAYS[elem as PrimElem](len) : rt.oa(len, elem);
}

function newMultiArray(cls: JClass | null, dims: Int32Array, i: number): unknown {
  if (i === dims.length - 1) return newArrayOf(cls, dims[i]);
  const a = rt.oa(dims[i], "[".repeat(dims.length - 1 - i) + classDesc(cls));
  for (let k = 0; k < a.length; k++) a[k] = newMultiArray(cls, dims, i + 1);
  return a;
}
// libcore's Array boxes, unboxes and checks in Java; ART allocates its arrays
rt.registerJnis("java/lang/reflect/Array", {
  "createObjectArray(Ljava/lang/Class;I)Ljava/lang/Object;": newArrayOf,
  "createMultiArray(Ljava/lang/Class;[I)Ljava/lang/Object;": (cls: JClass | null, dims: Int32Array) => newMultiArray(cls, dims, 0),
});

// "Unpadded" allows using heap alignment slack; these arrays have exactly the requested length.
class JVMRuntime extends JObj {}
const theVmRuntime = new JVMRuntime();
const is32Bit = (names: Iterable<string>) => ABIS_32.includes(libraryAbi(names) ?? "");
let wide: boolean | null = null, bitnessFixed!: () => void;
/** resolves once the process's bitness is fixed: until then no zygote of either bitness is chosen */
export const processBitness = new Promise<void>((resolve) => { bitnessFixed = resolve; });
/** Fix the bitness of the process that runs the app with these entries. PackageManager's ABI
 *  selection gives the app a 32-bit primary ABI only when 32-bit libraries are the ones that match,
 *  and that ABI picks the zygote (zygote64 or zygote) that forks it. */
export function fixProcessBitness(names: Iterable<string>): void {
  wide ??= !is32Bit(names);
  bitnessFixed();
}
/** whether the process runs arm64 code */
export const is64BitProcess = (): boolean => wide ?? !is32Bit(rt.classpathNames());
/** Unsafe.addressSize: a native pointer's width in this process, which IOVecWrapper lays its iovecs out by */
export const addressSize = (): number => is64BitProcess() ? 8 : 4;
/** the app's targetSdkVersion as ActivityThread binds it; ART's default is the development SDK */
let targetSdk = 10000;
export const setTargetSdkVersion = (version: number) => { targetSdk = version; };
export const targetSdkVersion = (): number => targetSdk;
rt.register({
  name: "dalvik/system/VMRuntime", ctor: JVMRuntime,
  methods: {
    "static getRuntime()Ldalvik/system/VMRuntime;": () => theVmRuntime,
    "newUnpaddedArray(Ljava/lang/Class;I)Ljava/lang/Object;": newArrayOf,
    "newNonMovableArray(Ljava/lang/Class;I)Ljava/lang/Object;": (cls: JClass | null, len: number) =>
      len >= 0 && classDesc(cls) === "B" ? nonMovableBytes(len) : newArrayOf(cls, len),
    // a byte[] in guest memory is at its address there, a host one where jmemory resolves it;
    // another non-movable array's address is the handle JNI implementations dereference it by
    "addressOf(Ljava/lang/Object;)J": (array: object) =>
      array instanceof Int8Array && mem.isGuest(array) ? BigInt(mem.va(array.byteOffset)) : hostAddress(array) ?? handle(array),
    "getTargetSdkVersion()I": () => targetSdk,
    "is64Bit()Z": () => +is64BitProcess(),
    "setTargetSdkVersion(I)V": setTargetSdkVersion,
    // ro.build.version.sdk
    "static getSdkVersionNative(I)I": () => device.sdk,
    // the UI thread is marked sensitive to JIT and GC pauses: the JS engine schedules both itself
    "static registerSensitiveThread()V": () => {},
    // ART counts native bytes to pace its collections; the JS engine paces its own
    "registerNativeAllocation(J)V": () => {},
    "registerNativeFree(J)V": () => {},
    // no hidden-API policy is enforced here, so every exemption already holds and no access is reported
    "setHiddenApiExemptions([Ljava/lang/String;)V": () => {},
    "static setNonSdkApiUsageConsumer(Ljava/util/function/Consumer;)V": () => {},
    "static setDedupeHiddenApiWarnings(Z)V": () => {},
    "static setHiddenApiUsageLogger(Ldalvik/system/VMRuntime$HiddenApiUsageLogger;)V": () => {},
    "setHiddenApiAccessLogSamplingRate(I)V": () => {},
    // what System.<clinit> reads of the runtime: the zygote's class paths, ART's version, and the
    // -D options AndroidRuntime starts it with (the locale from persist.sys.locale)
    "bootClassPath()Ljava/lang/String;": () => BOOT_JAR_PATHS.join(":"),
    "classPath()Ljava/lang/String;": () => ".",
    "vmVersion()Ljava/lang/String;": () => "2.1.0",
    "properties()[Ljava/lang/String;": () => jarray([`user.locale=${device.locale}`], "Ljava/lang/String;"),
  },
});

// what ActivityThread tells ART about the process, and the heap and JIT controls it uses: the JS
// engine owns the heap, the JIT and the scheduling, so these only record or answer ART's defaults
let heapUtilization = 0.75;
rt.registerJnis("dalvik/system/VMRuntime", {
  "registerAppInfo(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;I)V": () => {},
  "setDisabledCompatChangesNative([J)V": () => {},
  "setTargetSdkVersionNative(I)V": () => {},
  "getCurrentInstructionSet()Ljava/lang/String;": () => is64BitProcess() ? "arm64" : "arm",
  "vmInstructionSet()Ljava/lang/String;": () => is64BitProcess() ? "arm64" : "arm",
  "vmLibrary()Ljava/lang/String;": () => "libart.so",
  "isJavaDebuggable()Z": () => 0, "isNativeDebuggable()Z": () => 0, "isCheckJniEnabled()Z": () => 0,
  "getTargetHeapUtilization()F": () => heapUtilization,
  "nativeSetTargetHeapUtilization(F)V": (value: number) => { heapUtilization = value; },
  "getFinalizerTimeoutMs()J": () => 10000n,
  "getNotifyNativeInterval()I": () => 384,
  ...Object.fromEntries(["setProcessPackageName(Ljava/lang/String;)V", "setProcessDataDirectory(Ljava/lang/String;)V", "clampGrowthLimit()V", "clearGrowthLimit()V", "trimHeap()V", "requestHeapTrim()V", "requestConcurrentGC()V",
    "updateProcessState(I)V", "notifyStartupCompleted()V", "bootCompleted()V", "resetJitCounters()V", "setSystemDaemonThreadPriority()V",
    "notifyNativeAllocationsInternal()V", "preloadDexCaches()V", "runHeapTasks()V", "startHeapTaskProcessor()V", "stopHeapTaskProcessor()V"]
    .map((sig) => [sig, () => {}])),
});

// DDMS chunks go to an attached debugger, and ART drops them when none is (there never is here)
rt.registerJni("org/apache/harmony/dalvik/ddmc/DdmServer", "nativeSendChunk(I[BII)V", () => {});
