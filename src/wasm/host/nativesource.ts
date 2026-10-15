// The registered natives (rt.register specs and rt.registerJni functions) as the Wasm tier's NativeSource.
import { rt, JObj, type NativeSpec } from "../../jvm/runtime";
import { JThrowable } from "../../jvm/natives/jthrowable";
import { splitSig } from "../../jvm/abi";
import { stringMethods } from "../../jvm/natives/jstring";
import type { HostFn, HostSpec, NativeSource } from "../link/hostapi";
import { Natives } from "./natives";
import { refOf } from "./bridge";
import { hostNatives } from "./hostnatives";
import { mayWait } from "./suspend";

export const lookup = (cls: string, key: string, isStatic: boolean) => {
  const owner = rt.natives.get(cls), spec = owner?.methods?.[(isStatic ? "static " : "") + key], id = cls + "." + key;
  const own = (typeof spec === "function" ? spec : typeof spec === "string" ? owner!.ctor.prototype[spec] : undefined) as HostFn | undefined;
  // a registered JNI function is tracked already; a spec's placeholder is recorded here
  return hostNatives.get(id) ?? (own ? rt.trackPlaceholder(id, own) : rt.jniFn(cls, key) as HostFn | null ?? undefined);
};
/** the values of natives that read the ICU data asynchronously, resolved once before they run (a native cannot suspend yet) */
export const settled = new Map<string, unknown>();
/** a registered class, which the host implements */
export const hostSpec = (spec: NativeSpec): HostSpec => ({
  name: spec.name, sup: spec.sup ?? null, ifaces: spec.ifaces ?? [], methods: Object.keys(spec.methods ?? {}), platformClinit: spec.platformClinit, statics: spec.statics, ctor: spec.ctor,
  fields: Array.isArray(spec.fields) ? spec.fields.map((n) => [n, n]) : Object.entries(spec.fields ?? {}),
});
export const nativeSource: NativeSource = {
  hostSpecs: () => [...rt.natives.values()].map(hostSpec),
  find: (cls, key, isStatic, hasBody) => {
    if (cls === "java/lang/String" && key.startsWith("<init>")) return rt.newStr[key.slice(6) as keyof typeof rt.newStr] as HostFn | undefined;
    if (cls === "java/lang/String") { const f = stringMethods.get(key) as HostFn | undefined; if (f || hasBody) return f; }
    if (settled.has(cls + "." + key)) return () => settled.get(cls + "." + key);
    if (key === "<clinit>()V" && !hasBody && rt.natives.get(cls)?.statics) return () => {};
    const own = lookup(cls, key, isStatic);
    if (own || hasBody) return own;
    // a method no code declares is the one the spec's superclass (or the interface-implementing class of a spec: its supertypes' specs) implements
    for (let sup = rt.natives.get(cls)?.sup; sup; sup = rt.natives.get(sup)?.sup) { const inherited = lookup(sup, key, isStatic); if (inherited) return inherited; }
    return undefined;
  },
  late: (cls, key) => Object.assign(function (this: unknown, ...args: unknown[]) {
    const bound = rt.jniFn(cls, key) as HostFn | null;
    if (!bound) throw rt.ulink(cls, ...splitSig(key));
    return bound.apply(this, args);
  }, { javaValues: true }),
  stores: (cls, run) => { run(); return { ...rt.natives.get(cls)?.statics }; },
  classOf: (v) => v instanceof JObj ? (v.constructor as unknown as { $i?: { name: string } }).$i?.name : undefined,
  // a Java exception the host caught from a call into Java and rethrows is thrown as it is, never copied
  thrown: (e) => {
    const java = refOf(e);
    if (java) return { cls: "", msg: null, java };
    // a JS error escaping a native is the Java throwable rt.jx makes of it: a TypeError on null is a NullPointerException, a typed array too long an OutOfMemoryError.
    // A suspension the engine refused is the harness's to see, and a stack overflow the World turns into a StackOverflowError at the boundary
    if (e instanceof Error && e.name !== "SuspendError" && !(e instanceof RangeError && e.message.includes("call stack"))) e = rt.jx(e);
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
