// The Wasm tier alone, run with WEBDROID_TIER=wasm after the entry suite: no bytecode in the JS runtime, the platform and the fixture loaded through
// tier.loadDex, the seam installed by the tier; its answers are the JS tier's that the entry suite recorded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/natives";
import { loadPlatformJar } from "../../src/android/framework";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { BOOT_JAR_PATHS } from "../../src/jvm/bootclasspath";
import { vfs } from "../../src/shell/vfs";
import { BytesFile } from "../../src/shell/lazyfile";
import { dexesIn } from "../../src/jvm/dex";
import { loadDex, loadTier, tier } from "../../src/jvm/tier";
import { getDeclared, rt } from "../../src/jvm/runtime";
import { settled } from "../../src/wasm/host/nativesource";
import { AOSP } from "./paths";
import { entryCases, entryDex } from "./entrycases";
import { classNameOf, newObj, scall, staticField, vcall } from "../../src/jvm/natives/jentry";
import { FileDescriptors, type DescriptorCalls } from "../../src/shell/file-descriptors";
import { descriptorTransport } from "../../src/native/process-fd";
import { callProxy, serveCalls } from "../../src/shell/process-port";
import { writeBufferBytes } from "../../src/jvm/natives/jnio";

if (tier !== "wasm") throw new Error("run with WEBDROID_TIER=wasm");
const recorded = JSON.parse(readFileSync(process.env.WASM_ENTRY_OUT!, "utf8")) as { js: string[]; settled: [string, unknown][] };
for (const [key, value] of recorded.settled) settled.set(key, value);
await loadTier();
// every jar of the boot class path is on the device; the classes of the three the fixture needs are loaded
PLATFORM_JARS.forEach((jar, i) => {
  const bytes = new Uint8Array(readFileSync(join(AOSP, jar)));
  if ([0, 1, 12].includes(i)) loadPlatformJar(bytes, i); else vfs.mount(BOOT_JAR_PATHS[i], new BytesFile(bytes));
});
for (const d of dexesIn(new Uint8Array(readFileSync(entryDex())), "E")) loadDex(rt, d);
const got = await entryCases();
let failed = 0;
recorded.js.forEach((want, i) => { if (got[i] !== want) { failed++; console.log(`FAIL ?tier=wasm: ${want.split(":")[0]}\n  js    ${want}\n  wasm  ${got[i]}`); } });
if (got.length !== recorded.js.length) { failed++; console.log(`FAIL ?tier=wasm: ${got.length} answers for ${recorded.js.length}`); }
await inMemoryControl();
console.log(failed ? `${failed} failures` : `${got.length} entry calls answer as on the JS tier through ?tier=wasm`);
process.exit(failed ? 1 : 0);

async function inMemoryControl(): Promise<void> {
  const framework = PLATFORM_JARS.indexOf("framework.jar");
  loadPlatformJar(new Uint8Array(readFileSync(join(AOSP, PLATFORM_JARS[framework]))), framework);
  const bytes = new Uint8Array(readFileSync(entryDex())), padded = new Int8Array(bytes.length + 16);
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
