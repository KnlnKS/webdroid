// The production JS tier as an oracle: DEX methods run on src/jvm with the AOSP boot jars (tests/platform) loaded.
import "../../../tests/platform";
import { inspect } from "node:util";
import { rt } from "../../../src/jvm/runtime";
import "../../../src/natives";
import { scall } from "../../../src/jvm/natives/jentry";
import type { DexFile } from "../../../src/jvm/dex";
import { JThrowable } from "../../../src/jvm/natives/jthrowable";
import { mangleMethod, splitSig } from "../../../src/jvm/abi";
import { Natives, type HostFn } from "./natives";

/** the String methods production overrides, as installed before linking compiles String's remaining bytecode onto the same prototype */
const stringOverrides = new Map(Object.getOwnPropertyNames(String.prototype).filter((k) => k.startsWith("m$")).map((k) => [k, (String.prototype as never)[k] as HostFn]));
/** the natives the production runtime registered, which the Wasm tier imports */
export const natives = new Natives({
  find: (cls, key, isStatic, hasBody) => {
    if (cls === "java/lang/String") { const f = stringOverrides.get(mangleMethod(...splitSig(key))); if (f || hasBody) return f; }
    const spec = rt.natives.get(cls)?.methods?.[(isStatic ? "static " : "") + key];
    return (typeof spec === "function" ? spec : rt.jniFn(cls, key)) as HostFn | undefined ?? undefined;
  },
  thrown: (e) => e instanceof JThrowable ? { cls: (e.constructor as unknown as { $i: { name: string } }).$i.name, msg: e.msg } : undefined,
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

export async function jsTier(dexes: DexFile[]) {
  for (const d of dexes) rt.loadDex(d);
  rt.linkNatives();
  // the process state ActivityThread.main leaves, as scripts/jbench/runner.ts sets it
  await scall("dalvik/system/CloseGuard", "setEnabled", "(Z)V", 0);
  await scall("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "java.io.tmpdir", "/data/local/tmp");
  /** a Java throwable surfaces as an Error whose message is its class and message */
  return async (cls: string, name: string, desc: string, args: unknown[]) => { try { return await scall(cls, name, desc, ...args); } catch (e) { throw new Error(inspect(e)); } };
}
