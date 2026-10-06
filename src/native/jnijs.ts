// JNI over the JS tier: a Java object is a JS value, a class is its ClassInfo, and fields and methods are properties of the class's constructor and prototype.
import { mem } from "./mem";
import { rt, JObj, type ClassInfo, type Runtime } from "../jvm/runtime";
import { mangleMethod, mangleStaticField, jarray, PRIM_ARRAYS, primElem, u8, lateMethod, type PrimElem } from "../jvm/abi";
import { setPublic } from "../jvm/suspend";
import { stackTraceText } from "../jvm/natives/jthrowable";
import { JClass } from "../jvm/natives/jlang";
import { JCtor, JField, JMethod, classCtors, mkMethod, methodAnnotations } from "../jvm/natives/jreflect";
import { addressOf, capacity, isBuffer, newDirectBuffer } from "../jvm/natives/jnio";
import type { JniClass, JniField, JniMethod, JniVm } from "./jnivm";

interface JsField extends JniField { prop: string; /** the constructor a static field is a property of */ holder: unknown }
const elemSize: Record<string, number> = { Z: 1, B: 1, C: 2, S: 2, I: 4, J: 8, F: 4, D: 8 };
const info = (c: JniClass) => c as ClassInfo;
const noSuchMethod = (name: string, sig: string) => rt.mkThrowable("java/lang/NoSuchMethodError", name + sig);

/** abstract methods are not properties of a class: the class, or one it extends or implements, declares one */
function hasAbstractMethod(c: ClassInfo, name: string, desc: string): boolean {
  const { dex, def } = c;
  if (dex && def?.virtualMethods.some((m) => (m.flags & 0x400) !== 0 && dex.method(m.methodIdx).name === name && dex.methodDesc(m.methodIdx) === desc)) return true;
  return !!c.superInfo && hasAbstractMethod(c.superInfo, name, desc) || c.interfaces.some((i) => hasAbstractMethod(i, name, desc));
}
const key = (isStatic: boolean, prop: string, type: string) => (isStatic ? "static " : "") + prop + type;

export const jsVm: JniVm = {
  find(name: string, owner: Runtime | null) {
    const c = (owner ?? rt).link(name);
    return c.stub ? null : c;
  },
  owner: (c) => info(c).owner ?? null,
  binaryName: (name) => name,
  mirror: (c, owner) => (owner ?? info(c).owner ?? rt).classFor(c.name),
  classOf(mirror) {
    if (!(mirror instanceof JClass)) return null;
    return mirror.ci ?? (mirror.arrDesc ? rt.link(mirror.arrDesc) : null);
  },
  objectClass(o) {
    const c = o instanceof JObj ? (o.constructor as typeof JObj).$i : null;
    const name = typeof o === "string" ? "java/lang/String" : o instanceof JClass ? "java/lang/Class" : Array.isArray(o) ? "[" + ((o as { $t?: string }).$t ?? "Ljava/lang/Object;")
      : primElem(o) ? "[" + primElem(o) : c?.name ?? "java/lang/Object";
    return (c?.owner ?? rt).classFor(name);
  },
  superClass(c) { const s = info(c).superInfo; return s ? (s.owner ?? rt).classFor(s.name) : null; },
  assignable: (from, to) => info(from).assignableTo(info(to)),
  isInstance: (o, c) => !!(info(c).owner ?? rt).iof(o, c.name),
  init: (c) => (info(c).owner ?? rt).initClass(info(c)),

  hasMethod(c, name, sig, isStatic) {
    const i = info(c), mangled = mangleMethod(name, sig);
    // an interface the framework only marks (its methods live on the implementations) answers for what the app's own bytecode calls on it; the receiver
    // dispatches at call time as always; an array class has no ctor: its instances carry Object's methods on the JS array prototypes
    const proto = i.ctor ? i.ctor.prototype : Array.prototype; // js-tier
    return isStatic ? typeof i.ctor?.[mangled] === "function" : typeof proto?.[mangled] === "function" || (i.name === "java/lang/String" && typeof (String.prototype as any)[mangled] === "function")
      || hasAbstractMethod(i, name, sig)
      || (!i.dex && !isStatic && (rt.methodRefs(i.name).has(name + sig) || !Object.keys(rt.natives.get(i.name)?.methods ?? {}).length));
  },
  field(c, name, sig, isStatic): JsField | null {
    if (isStatic) {
      const prop = mangleStaticField(name);
      let owner: ClassInfo | null = info(c);
      while (owner && !Object.prototype.hasOwnProperty.call(owner.ctor, prop)) owner = owner.superInfo;
      return owner ? { cls: owner, key: key(true, prop, sig), type: sig, isStatic, prop, holder: owner.ctor } : null;
    }
    let owner: ClassInfo | null = info(c), prop: string | undefined;
    while (owner && !(prop = owner.fieldTable.get(name))) owner = owner.superInfo;
    return owner && prop ? { cls: owner, key: key(false, prop, sig), type: sig, isStatic, prop, holder: null } : null;
  },
  get: (f, o) => ((f as JsField).isStatic ? (f as JsField).holder as Record<string, unknown> : o as Record<string, unknown>)[(f as JsField).prop],
  set(f, o, v) { (((f as JsField).isStatic ? (f as JsField).holder : o) as Record<string, unknown>)[(f as JsField).prop] = v; },
  invoke(c, name, sig, isStatic, self, args, nonvirtual) {
    const i = info(c), mangled = mangleMethod(name, sig);
    let fn: unknown;
    if (isStatic) {
      self = i.ctor;
      fn = i.ctor[mangled];
    } else {
      if (self === null || self === undefined) throw rt.mkThrowable("java/lang/NullPointerException", "JNI call on null " + name);
      fn = nonvirtual ? i.ctor.prototype[mangled] : (self as Record<string, unknown>)[mangled] ?? lateMethod.find?.(self, name, sig); // js-tier
    }
    if (typeof fn !== "function") throw noSuchMethod(name, sig);
    return fn.apply(self, args);
  },
  construct(c, sig, args) {
    const i = info(c);
    // a Java string is a JS string, built by the runtime's own constructor table
    if (i.name === "java/lang/String") {
      const make = (rt.newStr as Record<string, (...a: unknown[]) => string>)[sig];
      if (!make) throw noSuchMethod("<init>", sig);
      return make(...args);
    }
    const o = new i.ctor(), fn = o[mangleMethod("<init>", sig)];
    if (typeof fn !== "function") throw noSuchMethod("<init>", sig);
    const done = fn.apply(o, args);
    return done instanceof Promise ? done.then(() => o) : o;
  },
  allocate: (c) => new (info(c).ctor)(),
  reflect(c, name, desc, isStatic) {
    const i = info(c);
    if (name === "<init>") return classCtors(i).find((ctor) => ctor.desc === desc) ?? null;
    return mkMethod(i, name, desc, isStatic, isStatic ? i.ctor[mangleMethod(name, desc)] : i.ctor.prototype[mangleMethod(name, desc)]); // js-tier
  },
  unreflectMethod(o): JniMethod | null {
    if (o instanceof JMethod) return { cls: o.owner, name: o.name, desc: o.desc, isStatic: o.isStatic };
    return o instanceof JCtor ? { cls: o.owner, name: "<init>", desc: o.desc, isStatic: false } : null;
  },
  unreflectField: (o): JsField | null => o instanceof JField ? { cls: o.owner, key: key(o.isStatic, o.prop, o.desc), type: o.desc, isStatic: o.isStatic, prop: o.prop, holder: o.isStatic ? o.owner.ctor : null } : null,
  nativeKind(c, name, sig) {
    // static or instance is not in the JNINativeMethod record: the dex knows
    const i = info(c);
    let isStatic = false;
    if (i.def && i.dex) {
      for (const m of i.def.directMethods) { const mr = i.dex.method(m.methodIdx); if (mr.name === name && i.dex.methodDesc(m.methodIdx) === sig) { isStatic = (m.flags & 0x8) !== 0; break; } }
    }
    return { isStatic, critical: isStatic && methodAnnotations(i, name, sig).some((a) => a.type === "dalvik/annotation/optimization/CriticalNative") };
  },
  bind(c, name, sig, isStatic, entry, params) {
    const i = info(c), mangled = mangleMethod(name, sig), target = isStatic ? i.ctor : i.ctor.prototype; // js-tier
    (i.owner ?? rt).registerJni(i.name, name + sig, entry);
    // the compiled stub memoised a miss before JNI_OnLoad ran: re-point it (see compiler emitNativeStub)
    if (target && Object.prototype.hasOwnProperty.call(target, mangled)) setPublic(target, mangled, entry, params);
  },

  string: (js) => js,
  chars: (s) => s as string,
  length: (a) => (a as { length: number }).length,
  elementType: (a) => primElem(a)!,
  newPrimitiveArray: (type, n) => new PRIM_ARRAYS[type as PrimElem](n),
  newObjectArray: (n, c, init) => jarray(new Array(n).fill(init), c ? (c.name[0] === "[" ? c.name : "L" + c.name + ";") : "Ljava/lang/Object;"),
  element: (a, i) => (a as unknown[])[i],
  setElement(a, i, v) { (a as unknown[])[i] = v; },
  toGuest(array, type, start, n, p) { mem.u8.set(u8(array as never, start * elemSize[type], n * elemSize[type]), p); },
  fromGuest(array, type, start, n, p) { u8(array as never, start * elemSize[type], n * elemSize[type]).set(mem.u8.subarray(p, p + n * elemSize[type])); },

  throwable: (cls, msg) => rt.mkThrowable(cls, msg),
  noClass: (name) => rt.ncdfe(name),
  caught: (e) => rt.jx(e),
  raise: (t) => t,
  describe: (t) => t instanceof JObj ? stackTraceText(t as never) : String(t),
  monitor: (o, enter) => (enter ? rt.monitors.enter(o as object, rt.cur) : rt.monitors.exit(o as object, rt.cur)),
  newBuffer: newDirectBuffer,
  bufferAddress: (o) => (isBuffer(o) ? addressOf(o) : null),
  bufferCapacity: (o) => capacity(o as never),
  host: (o) => o,
};
