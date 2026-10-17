// What the harnesses run Java with: the registered natives, over the World lib.world makes, and the platform's jars and data mounted as a page mounts them.
// It is bundled for pages too (g1run.ts, boot-probe-page.ts), where node:fs is the files the page preloaded.
import { existsSync, openSync, readFileSync, readSync } from "node:fs";
import "../../src/natives.ts";
import { jarDexes, mountPlatformJar } from "../../src/android/framework.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { externs } from "../../src/wasm/link/intrinsics.ts";
import { mountPlatformData } from "../../src/shell/apex.ts";
import { PLATFORM_DATA } from "../../src/jvm/bootclasspath.ts";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";
import { isResident, mapExternal, pagesIn, unmapExternal } from "../../src/jvm/natives/jmemory.ts";
import { lookup, natives, settled } from "../../src/wasm/host/nativesource.ts";
import type { World } from "../../src/wasm/link/world.ts";
import { world } from "./lib.ts";
import { vfs } from "../../src/shell/vfs.ts";
export { natives };

/** the ICU metadata natives, which read Java and the ICU data and so wait: answered once for harnesses that use synchronous entries */
const ICU_VERSIONS = ["libcore/icu/ICU", "com/android/icu/util/Icu4cMetadata"].flatMap((cls) =>
  ["getUnicodeVersion", "getCldrVersion", "getIcuVersion", "getTzdbVersion"].map((name) => [cls, `${name}()Ljava/lang/String;`] as const));
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

/** the platform's jars at their device paths and its /apex data, once per process before Java runs: read from the checkout at `from`, or the jars given */
export async function mountPlatform(from: string | Uint8Array[]): Promise<void> {
  const page = !!(globalThis as { document?: unknown }).document, aosp = `${from}/vendor/aosp`;
  const jars = PLATFORM_JARS.map((jar, i) => {
    const bytes = typeof from !== "string" ? from[i] : page || existsSync(`${aosp}/${jar}`) ? new Uint8Array(readFileSync(`${aosp}/${jar}`)) : undefined;
    if (bytes) mountPlatformJar(bytes, i);
    return bytes;
  });
  // a page reads the data by range requests to its server
  if (page) mountPlatformData();
  else mountPlatformData((path, size) => {
    const fd = openSync(aosp + path, "r");
    return { size, read: async (at, length) => { const b = new Uint8Array(length); readSync(fd, b, 0, length, at); return b; } };
  });
  // A mapped file faults its pages in asynchronously, which a synchronous entry cannot wait for: the ICU data files are read first into
  // the pages every mapping of them shares, as a warm page cache would hold them
  for (const path of Object.keys(PLATFORM_DATA).filter((p) => /\.(dat|res)$/.test(p))) {
    const file = vfs.source(path)!, at = mapExternal(file, 0, file.size);
    await pagesIn(at, file.size);
    if (!isResident(at, file.size)) throw new Error(`${path} is not resident`);
    unmapExternal(at);
  }
  const icu = new Program(["boot/core-oj.jar", "boot/core-libart.jar", "boot/core-icu4j.jar"].flatMap((jar) => jarDexes(jars[PLATFORM_JARS.indexOf(jar)]!, jar)));
  icu.addExterns(externs);
  // the natives are called as host code, on a World of the ICU jars: none of a harness's Worlds sees them run
  world(icu, { natives, aot: undefined });
  for (const [cls, key] of ICU_VERSIONS) { const f = lookup(cls, key, true); if (f) settled.set(cls + "." + key, await f.call(null)); }
}

/** `w` with the classes the host implements, added after the constructor as host/boot.ts adds them */
export function addHostClasses<W extends World>(w: W): W {
  for (const spec of natives.source!.hostSpecs!()) w.addHostClass(spec);
  return w;
}

/** the process state ActivityThread.main leaves, entered asynchronously as a process starts: System's initialization reads files and the user database, which wait */
export async function startProcess(w: World): Promise<void> {
  // Zygote preloads VMClassLoader before FileSystems. Its lazy resource jars otherwise
  // re-enter FileSystems while the default provider is still being constructed.
  await w.entryAsync("java/lang/VMClassLoader", "getBootClassPathEntries", "()[Ljava/lang/String;")();
  await w.entryAsync("dalvik/system/CloseGuard", "setEnabled", "(Z)V")(0);
  await w.entryAsync("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")("java.io.tmpdir", "/data/local/tmp");
}
