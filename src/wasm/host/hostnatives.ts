// Natives the Wasm tier answers itself: those of classes the production runtime replaces whole (libcore's class loaders are JS there), which run
// here as the AOSP bytecode over the native underneath.
import { jarray } from "../../jvm/abi";
import { BOOT_JAR_PATHS } from "../../jvm/bootclasspath";
import { readBytes, FD, type IoBuffer } from "../../android/os";
import { fdInt } from "../../jvm/natives/jio";
import { fdFile, javaPreadFd, javaReadFd, javaSeekFd } from "../../native/fs";
import { handle } from "../../android/handles";
import { BytesFile } from "../../shell/lazyfile";
import { deref } from "../../android/handles";
import type { NativeLooper } from "../../android/mainloop";
import { vcall } from "../../jvm/natives/jentry";
import type { HostFn } from "../link/hostapi";

/** a read of a file held in memory: production queues every read of a file that has a source behind a Promise, so here it is a positional
 *  read at the file's position, which such a source answers at once */
function readResident(fd: number, target: Uint8Array): number | Promise<number> {
  if (!(fdFile(fd)?.source instanceof BytesFile)) return javaReadFd(fd, target);
  const at = javaSeekFd(fd, 0, 1), n = javaPreadFd(fd, target, at);
  if (typeof n === "number" && n > 0) javaSeekFd(fd, at + n, 0);
  return n;
}

/** Class.getPublicFieldRecursive, as ART searches: the public fields the class declares, then its interfaces', then its superclass's */
function publicField(cls: object, name: string): object | null {
  for (const f of vcall(cls, "getDeclaredFields", "()[Ljava/lang/reflect/Field;") as object[]) {
    if ((vcall(f, "getModifiers", "()I") as number) & 1 && vcall(f, "getName", "()Ljava/lang/String;") === name) return f;
  }
  for (const i of vcall(cls, "getInterfaces", "()[Ljava/lang/Class;") as object[]) { const f = publicField(i, name); if (f) return f; }
  const sup = vcall(cls, "getSuperclass", "()Ljava/lang/Class;") as object | null;
  return sup && publicField(sup, name);
}

export const hostNatives = new Map<string, HostFn>([
  // no class loader context to report to the runtime, which BaseDexClassLoader.reportClassLoaderChain takes as nothing to do
  ["dalvik/system/BaseDexClassLoader.computeClassLoaderContextsNative()[Ljava/lang/String;", () => jarray([], "Ljava/lang/String;")],
  ["java/lang/Class.getPublicFieldRecursive(Ljava/lang/String;)Ljava/lang/reflect/Field;", function (this: object, name: string) { return publicField(this, name); }],
  // Looper.loop waits here: the main thread's strand is suspended until a message, a callback or the timeout, which is a Suspending import
  ["android/os/MessageQueue.nativePollOnce(JI)V", async (ptr: bigint, timeout: number) => { await deref<NativeLooper>(ptr).pollOnce(timeout); }],
  // the address of a Java array that is not a direct buffer's: the handle of the array itself, which `deref` gives natives as a view that is stored back (bridge.ts)
  ["dalvik/system/VMRuntime.addressOf(Ljava/lang/Object;)J", Object.assign((_runtime: unknown, array: object) => handle(array), { javaValues: true })],
  // the archives of the boot class path, which BootClassLoader looks resources up in
  ["java/lang/VMClassLoader.getBootClassPathEntries()[Ljava/lang/String;", () => jarray([...BOOT_JAR_PATHS], "Ljava/lang/String;")],
  [`libcore/io/Linux.readBytes(${FD}Ljava/lang/Object;II)I`, (d: object | null, buffer: IoBuffer, offset: number, count: number) =>
    readBytes("read", buffer, offset, count, (target) => readResident(fdInt(d as never), target))],
]);
