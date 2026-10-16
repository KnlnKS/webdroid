// java.lang's natives: System's clocks and properties, Runtime's library loading and memory, and the process a fork would make.
// Java booleans are 0/1 numbers, longs are BigInt.

import { awaited, rt, type Gen } from "../runtime.ts";
import { HEAP_LIMIT } from "../abi.ts";
import { jarray } from "../abi.ts";
import { uptimeMillis, wallMillis } from "../../guest-clock.ts";
import { vfs } from "../../shell/vfs.ts";
import { processEnv } from "../../shell/environment.ts";
import { curThread, iof, vcall, type JThread } from "./jentry.ts";
import { shareable } from "../suspend.ts";
import type { JThrowable } from "./jthrowable.ts";
// String and its builders, java.lang's natives with these
import "./jstring.ts";

/** Objects.checkFromIndexSize: [off, off + len) must lie within [0, length) */
export function checkFromIndexSize(off: number, len: number, length: number, cls = "java/lang/IndexOutOfBoundsException"): void {
  if (off < 0 || len < 0 || off > length - len) throw rt.mkThrowable(cls, null);
}

const loadedLibs = new Map<string, { thread: JThread; pending: Promise<string | null> }>();
/** what a device this shape carries, most-preferred first. Which of them we can EXECUTE is the
 *  native tier's answer (rt.nativeAbis), and a library we can run beats one we cannot. */
const ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86_64", "x86"];
/** the ABI an apk's lib/ would be loaded from: the first the tier runs, else the first present
 *  — so the UnsatisfiedLinkError names the machine code the device would actually have used */
function pickAbi(has: (abi: string) => boolean): string | null {
  return rt.nativeAbis.find(has) ?? ABIS.find(has) ?? null;
}
/** the ABI an app's libraries load from, given its entry names, when it ships any */
export function libraryAbi(names: Iterable<string>): string | null {
  const dirs = new Set([...names].flatMap((name) => /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)?.[1] ?? []));
  return dirs.size ? pickAbi((a) => dirs.has(a)) : null;
}
const E_MACHINE: Record<number, string> = { 0xb7: "arm64-v8a", 0x28: "armeabi-v7a", 0x3e: "x86_64", 0x03: "x86" };
/** a library file, or an archive's entry ("base.apk!/lib/arm64-v8a/libx.so") the linker maps from the archive */
function* libraryFile(path: string): Gen<Uint8Array | null> {
  const bang = path.indexOf("!/");
  if (bang < 0) return yield vfs.readFile(path);
  const archive = path.slice(0, bang), entry = path.slice(bang + 2);
  const [{ packedArchives }, { zipTree }] = yield* awaited(Promise.all([import("../../shell/packedarchive.ts"), import("./jzip.ts")]));
  const packed = packedArchives.get(archive);
  return packed ? yield packed.entry(entry) : vfs.exists(archive) ? zipTree(yield vfs.readFile(archive))[entry] ?? null : null;
}
/** a library in the native library path of a dex class loader (BaseDexClassLoader.getLdLibraryPath), which the linker namespace ART makes for the
 *  loader searches: directories, and archive directories ("base.apk!/lib/arm64-v8a") */
function* fromLibraryPath(loader: unknown, lib: string): Gen<Uint8Array | null> {
  let path: string | null;
  try { path = yield vcall(loader, "getLdLibraryPath", "()Ljava/lang/String;"); } catch { return null; }
  for (const dir of path?.split(":") ?? []) {
    const bytes = yield* libraryFile(`${dir}/${lib}`);
    if (bytes) return bytes;
  }
  return null;
}
/** Runtime.nativeLoad: `file` is a path (ClassLoader.findLibrary's, System.load's) or a bare name
 *  from the class path or the loader's native library path; null once the library is loaded, else the linker's error. `caller` is the class loading it. */
function nativeLoad(file: string, loader: unknown, caller: unknown = null): string | null | Promise<string | null> {
  const lib = file.slice(file.lastIndexOf("/") + 1);
  if (rt.nativeLibs.has(lib.replace(/^lib|\.so$/g, ""))) return null;
  const have = loadedLibs.get(lib);
  if (have) return have.thread === curThread ? null : have.pending;
  const thread = curThread;
  // driven: each step continues on the asking thread and chain (a <clinit>'s, when it loads its library)
  const pending = shareable(rt.drive(function* (): Gen<string | null> {
    let abi: string | null, bytes: Uint8Array | null;
    if (file.startsWith("/")) {
      bytes = yield* libraryFile(file);
      abi = bytes && (E_MACHINE[bytes[18] | (bytes[19] << 8)] ?? "unknown");
    } else {
      abi = pickAbi((a) => rt.hasClasspath(`lib/${a}/${lib}`));
      bytes = abi ? yield rt.readClasspath(`lib/${abi}/${lib}`) : null;
      if (!bytes && loader) {
        bytes = yield* fromLibraryPath(loader, lib);
        abi = bytes && (E_MACHINE[bytes[18] | (bytes[19] << 8)] ?? "unknown");
      }
    }
    if (abi && bytes && rt.loadNativeLib) {
      try { yield rt.loadNativeLib(lib, bytes, abi, caller); return null; }
      catch (e) {
        rt.noteNativeRequired(lib, abi);
        if (iof(e, "java/lang/UnsatisfiedLinkError")) return (e as JThrowable).msg;
        throw e;
      }
    }
    if (abi) rt.noteNativeRequired(lib, abi);
    return `dlopen failed: library "${lib}" ${abi ? "is " + abi + " machine code" : "not found"}`;
  }()));
  loadedLibs.set(lib, { thread, pending });
  const forget = () => { loadedLibs.delete(lib); };
  pending.then((error) => { if (error !== null) forget(); }, forget);
  return pending;
}
rt.registerJnis("java/lang/System", {
  "currentTimeMillis()J": () => BigInt(Math.floor(wallMillis())),
  "nanoTime()J": () => BigInt(Math.floor(uptimeMillis() * 1e6)),
  // System.c: the zygote's working directory, and the linker's default search path
  "specialProperties()[Ljava/lang/String;": () =>
    jarray(["user.dir=/", `java.library.path=${processEnv.LD_LIBRARY_PATH ?? "/system/lib64:/system_ext/lib64"}`], "Ljava/lang/String;"),
  "mapLibraryName(Ljava/lang/String;)Ljava/lang/String;": (name: string) => { if (name === null) rt.npe(); return `lib${name}.so`; },
});
// Clock.systemUTC's wall time: nanoseconds past `offset` seconds, or -1 beyond ±2^32 s as libcore expects
rt.registerJni("jdk/internal/misc/VM", "getNanoTimeAdjustment(J)J", (offset: bigint) => {
  const adjustment = BigInt(Math.round(wallMillis() * 1e6)) - offset * 1_000_000_000n;
  return adjustment > MAX_NANO_ADJUSTMENT || adjustment < -MAX_NANO_ADJUSTMENT ? -1n : adjustment;
});
const MAX_NANO_ADJUSTMENT = (1n << 32n) * 1_000_000_000n;

// there is no second process: the fork fails as native code's does (EAGAIN), in UNIXProcess_md.c's
// words, and ProcessBuilder names the program
rt.registerJnis("java/lang/UNIXProcess", {
  "initIDs()V": () => {},
  "forkAndExec([B[BI[BI[B[IZ)I": () => { throw rt.mkThrowable("java/io/IOException", "error=11, Try again"); },
});
rt.registerJnis("java/lang/Runtime", {
  "nativeLoad(Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/Class;)Ljava/lang/String;": nativeLoad,
  "nativeGc()V": () => {},
  "maxMemory()J": () => BigInt(HEAP_LIMIT),
  "totalMemory()J": () => 268435456n,
  "freeMemory()J": () => 134217728n,
});
rt.registerJni("dalvik/system/VMStack", "getClosestUserClassLoader()Ljava/lang/ClassLoader;", () => rt.userClassLoader());
// libcore's AtomicLong asks whether the VM compares-and-sets 8 bytes without a lock
rt.registerJni("java/util/concurrent/atomic/AtomicLong", "VMSupportsCS8()Z", () => 1);
