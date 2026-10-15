// The entry cases through the page's seam: the platform and the fixture loaded through tier.loadDex; its answers are java/E.expected.txt.
// It is the second half of `bun run wasm entry`, in a process of its own because entry.ts installs a World of its own as the current one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/natives";
import { loadPlatformJar } from "../../src/android/framework";
import { BOOT_JAR_PATHS } from "../../src/jvm/bootclasspath";
import { vfs } from "../../src/shell/vfs";
import { BytesFile } from "../../src/shell/lazyfile";
import { dexesIn } from "../../src/jvm/dex";
import { loadDex, loadTier } from "../../src/jvm/tier";
import { getDeclared } from "../../src/jvm/runtime";
import { mountPlatform } from "./harness";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths";
import { entryCases, entryDex } from "./entrycases";
import { recorded, unlike } from "./tools";
import { classNameOf, newObj, scall, staticField, vcall } from "../../src/jvm/natives/jentry";
import { FileDescriptors, type DescriptorCalls } from "../../src/shell/file-descriptors";
import { descriptorTransport } from "../../src/native/process-fd";
import { callProxy, serveCalls } from "../../src/shell/process-port";
import { writeBufferBytes } from "../../src/jvm/natives/jnio";

const expected = recorded(join(JAVA, "E.expected.txt"));
await mountPlatform(ROOT);
await loadTier();
// every jar of the boot class path is on the device; the classes of the four the fixture needs are loaded
PLATFORM_PATHS.forEach((path, i) => {
  const bytes = new Uint8Array(readFileSync(path));
  if ([0, 1, 5, 12].includes(i)) loadPlatformJar(bytes, i); else vfs.mount(BOOT_JAR_PATHS[i], new BytesFile(bytes));
});
const dexBytes = new Uint8Array(readFileSync(entryDex()));
for (const d of dexesIn(dexBytes, "E")) loadDex(d);
const got = await entryCases();
let failed = 0;
for (const failure of unlike(expected, got)) { failed++; console.log("FAIL " + failure); }
await inMemoryControl();
console.log(failed ? `${failed} failures` : `${got.length} entry calls answer as recorded through the page's seam`);
process.exit(failed ? 1 : 0);

async function inMemoryControl(): Promise<void> {
  const bytes = dexBytes, padded = new Int8Array(bytes.length + 16);
  padded.set(bytes, 8);
  const heap = await scall("java/nio/ByteBuffer", "wrap", "([BII)Ljava/nio/ByteBuffer;", padded, 8, bytes.length);
  const owner = new FileDescriptors(), ports = new MessageChannel(), previous = { ...descriptorTransport };
  const stop = serveCalls(ports.port1, owner.session(2001, () => 0)), proxy = callProxy<DescriptorCalls>(ports.port2, ["fileDescriptor"]);
  let shared, mapped;
  try {
    descriptorTransport.calls = () => proxy.endpoint;
    descriptorTransport.importCalls = descriptorTransport.calls;
    shared = await scall("android/os/SharedMemory", "create", "(Ljava/lang/String;I)Landroid/os/SharedMemory;", "dex", Math.ceil(padded.length / 4096) * 4096);
    mapped = await vcall(shared, "mapReadWrite", "()Ljava/nio/ByteBuffer;");
    await writeBufferBytes(mapped, bytes, 8);
    await vcall(mapped, "position", "(I)Ljava/nio/Buffer;", 4);
    const view = await vcall(mapped, "slice", "()Ljava/nio/ByteBuffer;");
    await vcall(view, "position", "(I)Ljava/nio/Buffer;", 4);
    await vcall(view, "limit", "(I)Ljava/nio/Buffer;", 4 + bytes.length);
    const load = () => newObj("dalvik/system/InMemoryDexClassLoader", "([Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V", [view, heap], null);
    const first = await load(), second = await load();
    await writeBufferBytes(mapped, new Uint8Array(bytes.length), 8);
    const cls = await vcall(first, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "E");
    if (await vcall(cls, "getClassLoader", "()Ljava/lang/ClassLoader;") !== first
      || await vcall(first, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "E") !== cls
      || await vcall(second, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "E") === cls)
      throw new Error("in-memory defining-loader identity changed");
    const sup = await vcall(cls, "getSuperclass", "()Ljava/lang/Class;");
    if (classNameOf(await vcall(sup, "getClassLoader", "()Ljava/lang/ClassLoader;")) !== "java/lang/BootClassLoader") throw new Error("platform superclass lost boot ownership");
    const int = await staticField("java/lang/Integer", "TYPE"), add = await vcall(cls, "getMethod", "(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;", "add", [int, int]);
    const sum = await vcall(add, "invoke", "(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;", null,
      [await scall("java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;", 41), await scall("java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;", 1)]);
    if (await vcall(sum, "intValue", "()I") !== 42) throw new Error("in-memory code aliased its source buffer");
    if (await vcall(view, "position", "()I") !== 4 || await vcall(view, "limit", "()I") !== 4 + bytes.length
      || await vcall(heap, "position", "()I") !== 8 || await vcall(heap, "limit", "()I") !== 8 + bytes.length)
      throw new Error("in-memory loading changed buffer windows");
    const path = getDeclared(first, "dalvik/system/BaseDexClassLoader", "pathList"), elements = getDeclared(path, "dalvik/system/DexPathList", "dexElements") as object[];
    const dex = getDeclared(elements[0], "dalvik/system/DexPathList$Element", "dexFile");
    await vcall(dex, "close", "()V");
    if (getDeclared(dex, "dalvik/system/DexFile", "mCookie") !== null
      || !(getDeclared(dex, "dalvik/system/DexFile", "mInternalCookie") instanceof BigInt64Array)
      || await vcall(first, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", "E") !== cls)
      throw new Error("closing registered DEX discarded its namespace");
  } finally {
    if (mapped) await scall("android/os/SharedMemory", "unmap", "(Ljava/nio/ByteBuffer;)V", mapped);
    if (shared) await vcall(shared, "close", "()V");
    delete descriptorTransport.calls; delete descriptorTransport.importCalls; Object.assign(descriptorTransport, previous);
    proxy.close(); stop(); owner.close(2001);
  }
  console.log("in-memory DEX: actual heap/RPC buffer slices, copied code, defining loaders and bootstrap superclass");
}
