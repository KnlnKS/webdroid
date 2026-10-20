// ART's process configuration boundaries.
import { rt, noEffect } from "../runtime.ts";
import { jarray } from "../abi.ts";
import { libraryAbi } from "./jlang.ts";
import { ABIS_32 } from "../../shell/properties.ts";
import { device } from "../../shell/config.ts";
import { BOOT_JAR_PATHS } from "../bootclasspath.ts";
import { handle } from "../../android/handles.ts";

const is32Bit = (names: Iterable<string>) => ABIS_32.includes(libraryAbi(names) ?? "");
let wide: boolean | null = null, bitnessFixed!: () => void;
/** resolves once the process's bitness is fixed: until then no zygote of either bitness is chosen */
export const processBitness = new Promise<void>((resolve) => { bitnessFixed = resolve; });
/** whether a package with these entries runs in a 64-bit process. PackageManager's ABI selection gives
 *  the app a 32-bit primary ABI only when 32-bit libraries are the ones that match, and that ABI picks
 *  the zygote (zygote64 or zygote) that forks it. */
export const is64BitPackage = (names: Iterable<string>): boolean => !is32Bit(names);
/** the bitness of the zygote a process Worker runs before its package is known: its launcher chose it by the package */
export function setZygoteBitness(is64: boolean): void {
  wide = is64;
  bitnessFixed();
}
/** Fix the bitness of the process that runs the app with these entries. */
export function fixProcessBitness(names: Iterable<string>): void {
  const is64 = is64BitPackage(names);
  if (wide !== null && wide !== is64) throw new Error(`a ${is64 ? 64 : 32}-bit package in a process forked from the ${wide ? 64 : 32}-bit zygote`);
  wide = is64;
  bitnessFixed();
}
/** whether the process runs arm64 code */
export const is64BitProcess = (): boolean => wide ?? !is32Bit(rt.classpathNames());
/** a native pointer's width in this process, which IOVecWrapper lays its iovecs out by */
export const addressSize = (): number => is64BitProcess() ? 8 : 4;
/** the app's targetSdkVersion as ActivityThread binds it; ART's default is the development SDK */
let targetSdk = 10000;
export const setTargetSdkVersion = (version: number) => { targetSdk = version; };
export const targetSdkVersion = (): number => targetSdk;
rt.registerJnis("dalvik/system/VMRuntime", {
  "is64Bit()Z": () => +is64BitProcess(),
  // ro.build.version.sdk
  "getSdkVersionNative(I)I": () => device.sdk,
  // the UI thread is marked sensitive to JIT and GC pauses: the JS engine schedules both itself
  "registerSensitiveThread()V": () => {},
  // ART counts native bytes to pace its collections; the JS engine paces its own
  "registerNativeAllocation(J)V": () => {},
  "registerNativeFree(J)V": () => {},
  // no hidden-API policy is enforced here, so every exemption already holds and no access is reported
  "setHiddenApiExemptions([Ljava/lang/String;)V": () => {},
  "setDedupeHiddenApiWarnings(Z)V": () => {},
  "setHiddenApiAccessLogSamplingRate(I)V": () => {},
  // what System.<clinit> reads of the runtime: the zygote's class paths, ART's version, and the
  // -D options AndroidRuntime starts it with (the locale from persist.sys.locale)
  "bootClassPath()Ljava/lang/String;": () => BOOT_JAR_PATHS.join(":"),
  "classPath()Ljava/lang/String;": () => ".",
  "vmVersion()Ljava/lang/String;": () => "2.1.0",
  "properties()[Ljava/lang/String;": () => jarray([`user.locale=${device.locale}`], "Ljava/lang/String;"),
  // the address of a Java array that is not a direct buffer's: the handle of the array itself, which `deref` gives natives as a view that is stored back (wasm/host/bridge.ts)
  "addressOf(Ljava/lang/Object;)J": Object.assign((array: object) => handle(array), { javaValues: true }),
});
/** archives the host adds to the boot class path after the platform's, for the resources of classes it runs on it (conformance suites) */
export const extraBootEntries: string[] = [];
// the archives of the boot class path, which BootClassLoader looks resources up in
rt.registerJni("java/lang/VMClassLoader", "getBootClassPathEntries()[Ljava/lang/String;", () => jarray([...BOOT_JAR_PATHS, ...extraBootEntries], "Ljava/lang/String;"));

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
  ...noEffect("setProcessPackageName(Ljava/lang/String;)V", "setProcessDataDirectory(Ljava/lang/String;)V", "clampGrowthLimit()V", "clearGrowthLimit()V", "trimHeap()V", "requestHeapTrim()V", "requestConcurrentGC()V",
    "updateProcessState(I)V", "notifyStartupCompleted()V", "bootCompleted()V", "resetJitCounters()V", "setSystemDaemonThreadPriority()V",
    "notifyNativeAllocationsInternal()V", "preloadDexCaches()V", "runHeapTasks()V", "startHeapTaskProcessor()V", "stopHeapTaskProcessor()V"),
});

// DDMS chunks go to an attached debugger, and ART drops them when none is (there never is here)
rt.registerJni("org/apache/harmony/dalvik/ddmc/DdmServer", "nativeSendChunk(I[BII)V", () => {});
