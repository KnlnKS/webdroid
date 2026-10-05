// The registered natives of the production runtime as the Wasm tier's NativeSource.
import { rt, JObj } from "../../jvm/runtime";
import { JThrowable } from "../../jvm/natives/jthrowable";
import { mangleMethod, splitSig } from "../../jvm/abi";
import { TS_SPECS, tsSpecAllowance } from "../../jvm/provenance";
import type { HostFn, HostSpec, NativeSource } from "../link/hostapi";
import { Natives } from "./natives";
import { refOf } from "./bridge";
import { hostNatives } from "./hostnatives";
import { mayWait } from "./suspend";

/** the String methods production overrides, as installed before linking compiles String's remaining bytecode onto the same prototype */
const stringOverrides = new Map(Object.getOwnPropertyNames(String.prototype).filter((k) => k.startsWith("m$")).map((k) => [k, (String.prototype as never)[k] as HostFn]));
export const lookup = (cls: string, key: string, isStatic: boolean) => {
  const owner = rt.natives.get(cls), spec = owner?.methods?.[(isStatic ? "static " : "") + key];
  const production = (typeof spec === "function" ? spec : typeof spec === "string" ? owner!.ctor.prototype[spec] : rt.jniFn(cls, key)) as HostFn | undefined ?? undefined, id = cls + "." + key;
  return hostNatives.get(id) ?? production;
};
/** the values of natives that read the ICU data asynchronously, resolved once before they run (a native cannot suspend yet) */
export const settled = new Map<string, unknown>();
/** the registered classes the host implements: all but those the VM itself is (the Wasm tier runs those as Wasm) and those that stand in for bytecode for speed */
const hostSpecs = (): HostSpec[] => [...rt.natives].filter(([name]) => !/^(vm|intrinsic)/.test(TS_SPECS[tsSpecAllowance(name) ?? ""] ?? "")).map(([name, spec]) => ({
  name, sup: spec.sup ?? null, ifaces: spec.ifaces ?? [], methods: Object.keys(spec.methods ?? {}), ctor: spec.ctor,
  fields: Array.isArray(spec.fields) ? spec.fields.map((n) => [n, n]) : Object.entries(spec.fields ?? {}),
}));
export const nativeSource: NativeSource = {
  hostSpecs,
  find: (cls, key, isStatic, hasBody) => {
    if (cls === "java/lang/String" && key.startsWith("<init>")) return rt.newStr[key.slice(6) as keyof typeof rt.newStr] as HostFn | undefined;
    if (cls === "java/lang/String") { const f = stringOverrides.get(mangleMethod(...splitSig(key))); if (f || hasBody) return f; }
    return settled.has(cls + "." + key) ? () => settled.get(cls + "." + key) : lookup(cls, key, isStatic);
  },
  late: (cls, key) => Object.assign(function (this: unknown, ...args: unknown[]) {
    const bound = rt.jniFn(cls, key) as HostFn | null;
    if (!bound) throw rt.ulink(cls, ...splitSig(key));
    return bound.apply(this, args);
  }, { javaValues: true }),
  classOf: (v) => v instanceof JObj ? (v.constructor as unknown as { $i?: { name: string } }).$i?.name : undefined,
  // a Java exception the host caught from a call into Java and rethrows is thrown as it is, never copied
  thrown: (e) => {
    const java = refOf(e);
    if (java) return { cls: "", msg: null, java };
    // a JS error escaping a native is the Java throwable the JS tier makes of it (rt.jx): a TypeError on null is a NullPointerException, a typed array too long an OutOfMemoryError.
    // A suspension the engine refused is the harness's to see
    if (e instanceof Error && e.name !== "SuspendError") e = rt.jx(e);
    return e instanceof JThrowable ? { cls: (e.constructor as unknown as { $i: { name: string } }).$i.name, msg: e.msg, obj: e } : undefined;
  },
};
export const natives = new Natives(nativeSource);

/** the ids (class.name+descriptor) of the registered natives that can answer a Promise (suspend.ts `mayWait`), for the platform build to hand to pages */
export function waitingNatives(): string[] {
  const ids = new Set<string>();
  const add = (id: string, fn: unknown) => { if (typeof fn === "function" && mayWait(fn as HostFn)) ids.add(id); };
  for (const [key, fn] of rt.jni) add(key.replace("|", "."), fn);
  for (const [cls, spec] of rt.natives) for (const [key, impl] of Object.entries(spec.methods ?? {})) add(`${cls}.${key.replace(/^static /, "")}`, typeof impl === "string" ? spec.ctor.prototype[impl] : impl);
  for (const [id, fn] of hostNatives) add(id, fn);
  return [...ids].sort();
}
