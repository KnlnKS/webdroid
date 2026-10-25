// The registered natives (rt.register specs and rt.registerJni functions) as the Wasm tier's NativeSource.
import { rt, JObj, type NativeSpec } from "../../jvm/runtime.ts";
import { JThrowable } from "../../jvm/natives/jthrowable.ts";
import { splitSig, type NativeImpl } from "../../jvm/abi.ts";
import type { HostSpec, NativeSource } from "../link/hostapi.ts";
import type { World } from "../link/world.ts";
import { waitsEnded } from "../link/module.ts";
import { Natives } from "./natives.ts";
import { refOf } from "./bridge.ts";

const lookup = (cls: string, key: string, isStatic: boolean): NativeImpl | undefined => rt.specNative(cls, key, isStatic) ?? rt.jniNative(cls, key) ?? undefined;
const CLINIT: NativeImpl = { fn: () => {} };
/** a registered class, which the host implements */
const hostSpec = (spec: NativeSpec): HostSpec => ({
  name: spec.name, sup: spec.sup ?? null, ifaces: spec.ifaces ?? [], methods: Object.keys(spec.methods ?? {}), platformClinit: spec.platformClinit, statics: spec.statics, ctor: spec.ctor,
  fields: Object.entries(spec.fields ?? {}),
});
/** `w` with the classes the host implements: those registered, and each one registered later (a module that loads later) as it is */
export function attachHostClasses<W extends World>(w: W): W {
  for (const spec of nativeSource.hostSpecs()) w.addHostClass(spec);
  rt.registered = (spec) => w.addHostClass(hostSpec(spec));
  return w;
}
export const nativeSource = {
  hostSpecs: () => [...rt.natives.values()].map(hostSpec),
  find: (cls, key, isStatic, hasBody) => {
    if (key === "<clinit>()V" && !hasBody && rt.natives.get(cls)?.statics) return CLINIT;
    const own = lookup(cls, key, isStatic);
    if (own || hasBody) return own;
    // a method no code declares is the one the spec's superclass (or the interface-implementing class of a spec: its supertypes' specs) implements
    for (let sup = rt.natives.get(cls)?.sup; sup; sup = rt.natives.get(sup)?.sup) { const inherited = lookup(sup, key, isStatic); if (inherited) return inherited; }
    return undefined;
  },
  late: (cls, key) => ({
    fn(this: unknown, ...args: unknown[]) {
      const bound = rt.jniNative(cls, key);
      if (!bound) throw rt.ulink(cls, ...splitSig(key));
      return bound.fn.apply(this, args);
    },
    raw: true,
  }),
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
