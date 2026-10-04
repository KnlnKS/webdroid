// The production JS tier as an oracle: DEX methods run on src/jvm with the AOSP boot jars (tests/platform) loaded.
import "../../tests/platform";
import { inspect } from "node:util";
import { rt } from "../../src/jvm/runtime";
import "../../src/natives";
import { scall, vcall } from "../../src/jvm/natives/jentry";
import type { DexFile } from "../../src/jvm/dex";
import { lookup, nativeSource, settled } from "../../src/wasm/host/nativesource";
import { Natives } from "../../src/wasm/host/natives";
import type { World } from "../../src/wasm/link/world";
import { PLATFORM_DATA } from "../../src/jvm/bootclasspath";
import { isResident, mapExternal, pagesIn, unmapExternal } from "../../src/jvm/natives/jmemory";
import { vfs } from "../../src/shell/vfs";

/** the natives of the production runtime, over the JS tier that has the same dexes: a `static ()V` native that fills in static fields (initConstants)
 *  runs there, every static unset, and what it stored is what it wrote */
export const natives = new Natives({
  ...nativeSource,
  stores: (cls, run) => {
    const info = rt.link(cls), unset = Symbol(), saved = [...info.staticFieldTable].map(([key, prop]) => [key, prop, info.ctor[prop]] as const);
    for (const [, prop] of saved) info.ctor[prop] = unset;
    try { run(); return Object.fromEntries(saved.filter(([, prop]) => info.ctor[prop] !== unset).map(([key, prop]) => [key, info.ctor[prop]])); }
    finally { for (const [, prop, v] of saved) info.ctor[prop] = v; }
  },
});

/** natives that read the ICU data asynchronously and take no arguments: a native cannot suspend in the Wasm tier, so their value is
 *  resolved once, from the same production implementation, before it runs */
const ICU_VERSIONS = ["libcore/icu/ICU", "com/android/icu/util/Icu4cMetadata"].flatMap((cls) =>
  ["getUnicodeVersion", "getCldrVersion", "getIcuVersion", "getTzdbVersion"].map((name) => [cls, `${name}()Ljava/lang/String;`] as const));
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
/** float/double results and arguments cross harnesses as raw bits */
export const fb = (x: number) => (f32[0] = x, BigInt(u32[0] | 0)), db = (x: number) => (f64[0] = x, BigInt.asIntN(64, u64[0]));
export const unbits = (k: string, v: bigint) => k === "F" ? (u32[0] = Number(BigInt.asUintN(32, v)), f32[0]) : k === "D" ? (u64[0] = BigInt.asUintN(64, v), f64[0]) : k === "J" ? v : Number(v);
export const bitsOf = (k: string, v: any): bigint => k === "F" ? fb(v) : k === "D" ? db(v) : k === "Z" ? BigInt(+v) : BigInt(v);
/** NaN payloads differ between tiers without being observable, so all NaNs compare equal */
export const fmt = (k: string, v: bigint) => {
  if (k === "F") { u32[0] = Number(BigInt.asUintN(32, v)); return isNaN(f32[0]) ? "NaN" : String(v); }
  if (k === "D") { u64[0] = BigInt.asUintN(64, v); return isNaN(f64[0]) ? "NaN" : String(v); }
  return String(v);
};

/** the process state ActivityThread.main leaves, on the Wasm tier's World as jsTier leaves it on the production runtime */
export function processState(w: World): void {
  w.entry("dalvik/system/CloseGuard", "setEnabled", "(Z)V")(0);
  w.entry("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")("java.io.tmpdir", "/data/local/tmp");
}

export async function jsTier(dexes: DexFile[]) {
  for (const d of dexes) rt.loadDex(d);
  rt.linkNatives();
  // A mapped file faults its pages in asynchronously, which a native in the Wasm tier cannot wait for: the ICU data files are read first into
  // the pages every mapping of them shares, as a warm page cache would hold them. Outside a page each mapping keeps its own pages (pageShared),
  // so the harness gives the realm the page it lacks.
  (globalThis as { window?: object }).window ??= {};
  for (const path of Object.keys(PLATFORM_DATA).filter((p) => /\.(dat|res)$/.test(p))) {
    const file = vfs.source(path)!, at = mapExternal(file, 0, file.size);
    await pagesIn(at, file.size);
    if (!isResident(at, file.size)) throw new Error(`${path} is not resident`);
    unmapExternal(at);
  }
  for (const [cls, key] of ICU_VERSIONS) { const f = lookup(cls, key, true) ?? lookup(cls, key, false); if (f) settled.set(cls + "." + key, await f.call(null)); }
  // the process state ActivityThread.main leaves, as scripts/jbench/runner.ts sets it
  await scall("dalvik/system/CloseGuard", "setEnabled", "(Z)V", 0);
  await scall("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "java.io.tmpdir", "/data/local/tmp");
  /** a Java throwable surfaces as an Error whose message is its class and message */
  return async (cls: string, name: string, desc: string, args: unknown[], instance = false) => {
    try { return await (instance ? vcall(args[0], name, desc, ...args.slice(1)) : scall(cls, name, desc, ...args)); } catch (e) { throw new Error(inspect(e)); }
  };
}
