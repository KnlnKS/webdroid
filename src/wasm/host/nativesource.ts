// The registered natives (rt.register specs and rt.registerJni functions) as the Wasm tier's NativeSource.
import { rt, JObj, type NativeSpec } from "../../jvm/runtime.ts";
import { JThrowable } from "../../jvm/natives/jthrowable.ts";
import { splitSig } from "../../jvm/abi.ts";
import { stringMethods } from "../../jvm/natives/jstring.ts";
import type { HostFn, HostSpec, NativeSource } from "../link/hostapi.ts";
import { waitsEnded } from "../link/module.ts";
import { Natives } from "./natives.ts";
import { refOf } from "./bridge.ts";

const lookup = (cls: string, key: string, isStatic: boolean): HostFn | undefined => {
  const own = rt.natives.get(cls)?.methods?.[(isStatic ? "static " : "") + key] as HostFn | undefined;
  // a registered JNI function is tracked already; a spec's placeholder is recorded here
  return own ? rt.trackPlaceholder(cls + "." + key, own) : rt.jniFn(cls, key) as HostFn | null ?? undefined;
};
/** a registered class, which the host implements */
export const hostSpec = (spec: NativeSpec): HostSpec => ({
  name: spec.name, sup: spec.sup ?? null, ifaces: spec.ifaces ?? [], methods: Object.keys(spec.methods ?? {}), platformClinit: spec.platformClinit, statics: spec.statics, ctor: spec.ctor,
  fields: Object.entries(spec.fields ?? {}),
});
export const nativeSource = {
  hostSpecs: () => [...rt.natives.values()].map(hostSpec),
  find: (cls, key, isStatic, hasBody) => {
    if (cls === "java/lang/String" && key.startsWith("<init>")) return rt.newStr[key.slice(6) as keyof typeof rt.newStr] as HostFn | undefined;
    if (cls === "java/lang/String") { const f = stringMethods.get(key) as HostFn | undefined; if (f || hasBody) return f; }
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
    // A suspension the engine refused is the harness's to see, the page's end (endWaits) unwinds Java unhandled, and a stack overflow the World
    // turns into a StackOverflowError at the boundary
    if (e instanceof Error && e.name !== "SuspendError" && !waitsEnded() && !(e instanceof RangeError && e.message.includes("call stack"))) e = rt.jx(e);
    return e instanceof JThrowable ? { cls: (e.constructor as unknown as { $i: { name: string } }).$i.name, msg: e.msg, obj: e } : undefined;
  },
} satisfies NativeSource;
export const natives = new Natives(nativeSource);
