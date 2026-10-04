// The registered natives of the production runtime as the Wasm tier's NativeSource.
import { rt, JObj } from "../../jvm/runtime";
import { JThrowable } from "../../jvm/natives/jthrowable";
import { mangleMethod, splitSig } from "../../jvm/abi";
import type { HostFn, NativeSource } from "../link/hostapi";
import { Natives } from "./natives";
import { refOf } from "./bridge";
import { hostNatives, syncVariants } from "./hostnatives";

/** the String methods production overrides, as installed before linking compiles String's remaining bytecode onto the same prototype */
const stringOverrides = new Map(Object.getOwnPropertyNames(String.prototype).filter((k) => k.startsWith("m$")).map((k) => [k, (String.prototype as never)[k] as HostFn]));
export const lookup = (cls: string, key: string, isStatic: boolean) => {
  const spec = rt.natives.get(cls)?.methods?.[(isStatic ? "static " : "") + key];
  const production = (typeof spec === "function" ? spec : rt.jniFn(cls, key)) as HostFn | undefined ?? undefined, id = cls + "." + key;
  return hostNatives.get(id) ?? (production && syncVariants.get(id)?.(production)) ?? production;
};
/** the values of natives that read the ICU data asynchronously, resolved once before they run (a native cannot suspend yet) */
export const settled = new Map<string, unknown>();
export const nativeSource: NativeSource = {
  find: (cls, key, isStatic, hasBody) => {
    if (cls === "java/lang/String" && key.startsWith("<init>")) return rt.newStr[key.slice(6) as keyof typeof rt.newStr] as HostFn | undefined;
    if (cls === "java/lang/String") { const f = stringOverrides.get(mangleMethod(...splitSig(key))); if (f || hasBody) return f; }
    return settled.has(cls + "." + key) ? () => settled.get(cls + "." + key) : lookup(cls, key, isStatic);
  },
  classOf: (v) => v instanceof JObj ? (v.constructor as unknown as { $i?: { name: string } }).$i?.name : undefined,
  // a Java exception the host caught from a call into Java and rethrows is thrown as it is, never copied
  thrown: (e) => {
    const java = refOf(e);
    if (java) return { cls: "", msg: null, java };
    return e instanceof JThrowable ? { cls: (e.constructor as unknown as { $i: { name: string } }).$i.name, msg: e.msg, obj: e } : undefined;
  },
};
export const natives = new Natives(nativeSource);
