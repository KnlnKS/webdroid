// What the harnesses run Java with: the registered natives, over the World lib.world makes, and the platform's jars and data mounted as a page mounts them.
// It is bundled for pages too (g1run.ts, boot-probe-page.ts), where node:fs is the files the page preloaded.
import "../../src/natives.ts";
import { mountPlatformJar } from "../../src/android/framework.ts";
import { mountPlatformData } from "../../src/shell/apex.ts";
import { PLATFORM_DATA } from "../../src/jvm/bootclasspath.ts";
import { isResident, mapExternal, pagesIn, unmapExternal } from "../../src/jvm/natives/jmemory.ts";
import { attachHostClasses, natives, nativeSource } from "../../src/wasm/host/nativesource.ts";
import type { World } from "../../src/wasm/link/world.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { localPlatformData, platformJarBytes } from "../aosp.ts";
export { attachHostClasses, natives, nativeSource };

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
/** float/double results and arguments cross harnesses as raw bits */
export const fb = (x: number) => (f32[0] = x, BigInt(u32[0] | 0)), db = (x: number) => (f64[0] = x, BigInt.asIntN(64, u64[0]));
export const bitsOf = (k: string, v: any): bigint => k === "F" ? fb(v) : k === "D" ? db(v) : k === "Z" ? BigInt(+v) : BigInt(v);
/** NaN payloads differ between engines without being observable, so all NaNs compare equal */
export const fmt = (k: string, v: bigint) => {
  if (k === "F") { u32[0] = Number(BigInt.asUintN(32, v)); return isNaN(f32[0]) ? "NaN" : String(v); }
  if (k === "D") { u64[0] = BigInt.asUintN(64, v); return isNaN(f64[0]) ? "NaN" : String(v); }
  return String(v);
};

/** the platform's jars at their device paths and its /apex data, once per process before Java runs: read from the checkout at `from`, or the jars given.
 *  Answers the jars' bytes. */
export async function mountPlatform(from: string | Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
  const page = !!(globalThis as { document?: unknown }).document, aosp = `${from}/vendor/aosp`;
  const jars = typeof from === "string" ? platformJarBytes(aosp) : from;
  jars.forEach((bytes, i) => { if (bytes) mountPlatformJar(bytes, i); });
  // a page reads the data by range requests to its server
  mountPlatformData(page ? undefined : localPlatformData(aosp));
  // A mapped file faults its pages in asynchronously, which a synchronous entry cannot wait for: the ICU data files are read first into
  // the pages every mapping of them shares, as a warm page cache would hold them
  for (const path of Object.keys(PLATFORM_DATA).filter((p) => /\.(dat|res)$/.test(p))) {
    const file = vfs.source(path)!, at = mapExternal(file, 0, file.size);
    await pagesIn(at, file.size);
    if (!isResident(at, file.size)) throw new Error(`${path} is not resident`);
    unmapExternal(at);
  }
  return jars;
}

/** the process state ActivityThread.main leaves, entered asynchronously as a process starts: System's initialization reads files and the user database, which wait */
export async function startProcess(w: World): Promise<void> {
  // Zygote preloads VMClassLoader before FileSystems. Its lazy resource jars otherwise
  // re-enter FileSystems while the default provider is still being constructed.
  await w.entryAsync("java/lang/VMClassLoader", "getBootClassPathEntries", "()[Ljava/lang/String;")();
  await w.entryAsync("dalvik/system/CloseGuard", "setEnabled", "(Z)V")(0);
  await w.entryAsync("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")("java.io.tmpdir", "/data/local/tmp");
}
