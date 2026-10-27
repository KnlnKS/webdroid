// java.lang's natives: System's clocks and properties, Runtime's library loading and memory, and the process a fork would make.
// Java booleans are 0/1 numbers, longs are BigInt.

import { awaited, driven, rt, type Gen } from "../runtime.ts";
import { java } from "../javahost.ts";
import { HEAP_LIMIT } from "../abi.ts";
import { jarray } from "../abi.ts";
import { uptimeMillis, wallMillis } from "../../guest-clock.ts";
import { archiveEntry, centralDirOfSource, entryBytesOf } from "../../zip.ts";
import { processFileBytes, withProcessSource } from "../../native/process-fd.ts";
import { processEnv } from "../../shell/environment.ts";
import { curThread, iof, vcall, type JThread } from "./jentry.ts";
import type { JThrowable } from "./jthrowable.ts";

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
const elfAbi = (bytes: Uint8Array): string => E_MACHINE[bytes[18] | (bytes[19] << 8)] ?? "unknown";
/** a library file, or an archive's entry ("base.apk!/lib/arm64-v8a/libx.so") the linker maps from the archive */
function* libraryFile(path: string): Gen<Uint8Array | null> {
  const at = archiveEntry(path);
  if (!at) return yield processFileBytes(path);
  const { archive, entry } = at;
  const { packedArchives } = yield* awaited(import("../../shell/packedarchive.ts"));
  const packed = packedArchives.get(archive);
  if (packed) return yield packed.entry(entry);
  return yield withProcessSource(archive, async source => { const found = (await centralDirOfSource(source)).get(entry); return found ? entryBytesOf(source, found) : null; });
}
/** a library in the native library path of a dex class loader (BaseDexClassLoader.getLdLibraryPath), which the linker namespace ART makes for the
 *  loader searches: directories, and archive directories ("base.apk!/lib/arm64-v8a") */
function* fromLibraryPath(loader: unknown, lib: string): Gen<{ path: string; bytes: Uint8Array } | null> {
  let dirs: string | null;
  try { dirs = yield vcall(loader, "getLdLibraryPath", "()Ljava/lang/String;"); } catch { return null; }
  for (const dir of dirs?.split(":") ?? []) {
    const path = `${dir}/${lib}`, bytes = yield* libraryFile(path);
    if (bytes) return { path, bytes };
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
  const pending = Promise.resolve(rt.drive(function* (): Gen<string | null> {
    // the path the linker names the library by: where it was found, else (from the class path) its name
    let abi: string | null, bytes: Uint8Array | null, path = file;
    if (file.startsWith("/")) {
      bytes = yield* libraryFile(file);
      abi = bytes && elfAbi(bytes);
    } else {
      abi = pickAbi((a) => rt.hasClasspath(`lib/${a}/${lib}`));
      bytes = abi ? yield rt.readClasspath(`lib/${abi}/${lib}`) : null;
      const found = !bytes && loader ? yield* fromLibraryPath(loader, lib) : null;
      if (found) { ({ path, bytes } = found); abi = elfAbi(bytes); }
    }
    if (abi && bytes && rt.loadNativeLib) {
      try { yield rt.loadNativeLib(path, bytes, abi, caller); return null; }
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
  // The engine owns the heap and grows it on demand, and Java's share of it is not measurable here, so the footprint
  // and its free part are fixed fractions of the limit: half the limit, a quarter of it free
  "totalMemory()J": () => BigInt(HEAP_LIMIT / 2),
  "freeMemory()J": () => BigInt(HEAP_LIMIT / 4),
});
rt.registerJni("dalvik/system/VMStack", "getClosestUserClassLoader()Ljava/lang/ClassLoader;", () => java.userClassLoader());
// libcore's AtomicLong asks whether the VM compares-and-sets 8 bytes without a lock
rt.registerJni("java/util/concurrent/atomic/AtomicLong", "VMSupportsCS8()Z", () => 1);

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
rt.registerJni("java/lang/Class", "getPublicFieldRecursive(Ljava/lang/String;)Ljava/lang/reflect/Field;",
  driven(function* (this: object, name: string): Gen<object | null> { return yield* publicField(this, name); }));
