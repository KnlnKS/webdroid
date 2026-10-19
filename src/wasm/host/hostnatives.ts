// Natives the Wasm tier answers itself, under the AOSP bytecode of the classes that declare them (libcore's class loaders).
import { jarray } from "../../jvm/abi.ts";
import { BOOT_JAR_PATHS } from "../../jvm/bootclasspath.ts";
import { handle } from "../../android/handles.ts";
import { vcall } from "../../jvm/natives/jentry.ts";
import { awaited, driven, type Gen } from "../../jvm/runtime.ts";
import type { HostFn } from "../link/hostapi.ts";

/** archives the host adds to the boot class path after the platform's, for the resources of classes it runs on it (conformance suites) */
export const extraBootEntries: string[] = [];

/** Class.getPublicFieldRecursive, as ART searches: the public fields the class declares, then its interfaces', then its superclass's */
function* publicField(cls: object, name: string): Gen<object | null> {
  const fields = yield* awaited<object[]>(vcall(cls, "getDeclaredFields", "()[Ljava/lang/reflect/Field;"));
  for (const f of fields) {
    const modifiers = yield* awaited<number>(vcall(f, "getModifiers", "()I"));
    if (modifiers & 1 && (yield* awaited<string>(vcall(f, "getName", "()Ljava/lang/String;"))) === name) return f;
  }
  const interfaces = yield* awaited<object[]>(vcall(cls, "getInterfaces", "()[Ljava/lang/Class;"));
  for (const i of interfaces) { const f = yield* publicField(i, name); if (f) return f; }
  const sup = yield* awaited<object | null>(vcall(cls, "getSuperclass", "()Ljava/lang/Class;"));
  return sup && (yield* publicField(sup, name));
}

export const hostNatives = new Map<string, HostFn>([
  // no class loader context to report to the runtime, which BaseDexClassLoader.reportClassLoaderChain takes as nothing to do
  ["dalvik/system/BaseDexClassLoader.computeClassLoaderContextsNative()[Ljava/lang/String;", () => jarray([], "Ljava/lang/String;")],
  ["java/lang/Class.getPublicFieldRecursive(Ljava/lang/String;)Ljava/lang/reflect/Field;", driven(function* (this: object, name: string): Gen<object | null> { return yield* publicField(this, name); })],
  // the address of a Java array that is not a direct buffer's: the handle of the array itself, which `deref` gives natives as a view that is stored back (bridge.ts)
  ["dalvik/system/VMRuntime.addressOf(Ljava/lang/Object;)J", Object.assign((array: object) => handle(array), { javaValues: true })],
  // the archives of the boot class path, which BootClassLoader looks resources up in
  ["java/lang/VMClassLoader.getBootClassPathEntries()[Ljava/lang/String;", () => jarray([...BOOT_JAR_PATHS, ...extraBootEntries], "Ljava/lang/String;")],
]);
