// The production JS tier as an oracle: DEX methods run on src/jvm with the AOSP boot jars (tests/platform) loaded.
import "../../../tests/platform";
import { inspect } from "node:util";
import { rt, JObj } from "../../../src/jvm/runtime";
import "../../../src/natives";
import { scall, vcall } from "../../../src/jvm/natives/jentry";
import type { DexFile } from "../../../src/jvm/dex";
import { JThrowable } from "../../../src/jvm/natives/jthrowable";
import { mangleMethod, splitSig } from "../../../src/jvm/abi";
import { Natives, type HostFn } from "./natives";
import type { World } from "./lazy";
import { hostNatives } from "./hostnatives";
import { PLATFORM_DATA } from "../../../src/jvm/bootclasspath";
import { isResident, mapExternal, pagesIn, unmapExternal } from "../../../src/jvm/natives/jmemory";
import { vfs } from "../../../src/shell/vfs";

/** the String methods production overrides, as installed before linking compiles String's remaining bytecode onto the same prototype */
const stringOverrides = new Map(Object.getOwnPropertyNames(String.prototype).filter((k) => k.startsWith("m$")).map((k) => [k, (String.prototype as never)[k] as HostFn]));
const lookup = (cls: string, key: string, isStatic: boolean) => {
  const spec = rt.natives.get(cls)?.methods?.[(isStatic ? "static " : "") + key];
  return hostNatives.get(cls + "." + key) ?? (typeof spec === "function" ? spec : rt.jniFn(cls, key)) as HostFn | undefined ?? undefined;
};
/** natives that read the ICU data asynchronously and take no arguments: a native cannot suspend in the Wasm tier, so their value is
 *  resolved once, from the same production implementation, before it runs */
const ICU_VERSIONS = ["libcore/icu/ICU", "com/android/icu/util/Icu4cMetadata"].flatMap((cls) =>
  ["getUnicodeVersion", "getCldrVersion", "getIcuVersion", "getTzdbVersion"].map((name) => [cls, `${name}()Ljava/lang/String;`] as const));
const settled = new Map<string, unknown>();
/** the natives the production runtime registered, which the Wasm tier imports */
export const natives = new Natives({
  find: (cls, key, isStatic, hasBody) => {
    if (cls === "java/lang/String" && key.startsWith("<init>")) return rt.newStr[key.slice(6) as keyof typeof rt.newStr] as HostFn | undefined;
    if (cls === "java/lang/String") { const f = stringOverrides.get(mangleMethod(...splitSig(key))); if (f || hasBody) return f; }
    return settled.has(cls + "." + key) ? () => settled.get(cls + "." + key) : lookup(cls, key, isStatic);
  },
  classOf: (v) => v instanceof JObj ? (v.constructor as unknown as { $i?: { name: string } }).$i?.name : undefined,
  // every static is unset while the native runs, so what it stores is what it wrote
  stores: (cls, run) => {
    const info = rt.link(cls), unset = Symbol(), saved = [...info.staticFieldTable].map(([key, prop]) => [key, prop, info.ctor[prop]] as const);
    for (const [, prop] of saved) info.ctor[prop] = unset;
    try { run(); return Object.fromEntries(saved.filter(([, prop]) => info.ctor[prop] !== unset).map(([key, prop]) => [key, info.ctor[prop]])); }
    finally { for (const [, prop, v] of saved) info.ctor[prop] = v; }
  },
  thrown: (e) => e instanceof JThrowable ? { cls: (e.constructor as unknown as { $i: { name: string } }).$i.name, msg: e.msg, obj: e } : undefined,
});

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
