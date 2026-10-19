// JNI over the Wasm tier (native/jnivm.ts): a Java object in a JNI table is the Wasm reference itself, a class is its key in the Program, and fields, methods
// and arrays are reached through generated Wasm functions (Bridge.call, read, write, and the runtime functions of link/guest.ts), never through a facade.
import { rt } from "../../jvm/runtime.ts";
import { newInstance, refOf, type Bridge } from "./bridge.ts";
import { idOfClass } from "../link/classes.ts";

import { ACC, javaName, type FieldInfo, type MethodInfo, typeName } from "../compiler/program.ts";
import { failed, symbolicImplFor } from "../compiler/linkage.ts";
import type { World } from "../link/world.ts";
import type { Strand } from "../link/sched.ts";
import { ARRAY_SUPERS, classRef, onNestedStrand, runningThread } from "./entry.ts";
import type { JniClass, JniField, JniMethod, JniVm } from "../../native/jnivm.ts";

interface WasmField extends JniField { info: FieldInfo }
/** the storage kind of a primitive array's elements */
const ELEMENT = { Z: "i8", B: "i8", C: "i16", S: "i16", I: "i32", F: "i32", J: "i64", D: "i64" } as Record<string, string>;
const PRIMITIVE = new Set(Object.keys(ELEMENT));
const CLASS = "java/lang/Class", OBJECT = "java/lang/Object", STRING = "java/lang/String";

export function wasmJni(w: World): JniVm {
  const { prog } = w, bridge = w.bridge as Bridge;
  const classes = new Map<string, JniClass>();
  const cls = (name: string): JniClass => { let c = classes.get(name); if (!c) classes.set(name, c = { name }); return c; };
  /** a Java exception raised from the host's side of a call */
  const fail = (name: string, msg: string): never => { throw w.exception(w.makeThrowable(name, msg)); };
  const noSuchMethod = (name: string, sig: string) => fail("java/lang/NoSuchMethodError", name + sig);
  /** JNI names classes by binary name; a class of a loader's own namespace names them as that loader sees them */
  const view = (c: JniClass, sig: string): string => prog.viewOf(c.name, sig);

  /** whether the class named `name`, a class or an array class, exists */
  const exists = (name: string): boolean => {
    const element = name.replace(/^\[+/, "");
    if (name[0] === "[") return element.length === 1 ? PRIMITIVE.has(element) : element[0] === "L" && !!prog.get(element.slice(1, -1));
    return !!prog.get(name);
  };
  const isSub = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (a[0] !== "[") return b[0] !== "[" && prog.isSubclass(a, b);
    if (b[0] !== "[") return ARRAY_SUPERS.has(b);
    const x = a.slice(1), y = b.slice(1);
    return x[0] === "L" && y[0] === "L" ? isSub(x.slice(1, -1), y.slice(1, -1)) : x[0] === "[" && y[0] === "[" ? isSub(x, y) : x === y;
  };
  const mirror = (c: JniClass): unknown => classRef(w, c.name);
  const classId = w.hostFn("j:cid", ["L"], "I", (cx, c) => { c.lget(0); idOfClass(cx, c); });
  /** a Class as JNI holds it, or as a native's argument holds it (the host form of the object) */
  const classOf = (mirror: unknown): JniClass | null => {
    const m = refOf(mirror) ?? mirror;
    return m === null || m === undefined || w.classNameOf(m as object) !== CLASS ? null : cls(w.nameOf(classId(m)));
  };
  /** the descriptor of the type a Class stands for */
  const descriptor = (m: unknown): string => {
    const name = javaName(classOf(m)!.name);
    return name.length === 1 || name[0] === "#" ? name.slice(-1) : name[0] === "[" ? name : `L${name};`;
  };
  const virtual = (o: object, name: string, desc: string): MethodInfo => {
    const m = prog.dispatchFor(w.classNameOf(o), name, desc);
    if (m && failed(m)) return fail("java/lang/IncompatibleClassChangeError", m.message);
    return m ?? noSuchMethod(name, desc);
  };
  const call = (o: object, name: string, desc: string, ...args: unknown[]): unknown => bridge.call(virtual(o, name, desc), o, args);
  const copy = (to: boolean, type: string) => {
    const kind = ELEMENT[type];
    return w.hostFn(`j:g${to ? "put" : "get"}_${kind}`, ["L", "I", "I", "I", "I"], "V", (cx, c) => { c.lget(0).lget(1).lget(2).lget(3).lget(4); cx.callRt(c, `g${to ? "put" : "get"}_${kind}`); });
  };
  const bufferField = (name: string, desc: string) => prog.resolveField("java/nio/Buffer", name, desc)!;
  /** `f` as a call into Java from guest code, on a strand of its own so that Java that waits can: the result, or a Promise of it */
  const nest = <T>(f: (s: Strand) => T): T => onNestedStrand(w, f);

  const vm: JniVm = {
    find(name, from) {
      // the loader of the class whose native method asks, as ART's FindClass has it; a thread that attached by itself asks the default namespace
      if (!from) return exists(name) ? cls(name) : null;
      if (name[0] === "[") { const key = view(from, name); return exists(key) ? cls(key) : null; }
      const key = prog.lookup(prog.loaderOf(from.name), name);
      return key === undefined ? null : cls(key);
    },
    resolve(name, from) {
      return nest(s => {
        const result = w.resolveClass(from ? prog.loaderOf(from.name) : prog.root, name, s);
        return result instanceof Promise ? result.then(cls) : cls(result);
      });
    },
    // a class key carries the namespace of its loader (program.ts), which is no part of its name
    binaryName: javaName,
    mirror,
    classOf,
    objectClass: (o) => mirror(cls(w.classNameOf(o as object))),
    superClass(c) {
      const jc = prog.get(c.name), sup = c.name[0] === "[" ? OBJECT : jc && !jc.isInterface ? jc.sup : null;
      return sup ? mirror(cls(sup)) : null;
    },
    assignable: (from, to) => isSub(from.name, to.name),
    isInstance: (o, c) => isSub(w.classNameOf(o as object), c.name),
    init(c) {
      if (!prog.get(c.name) || !w.needsInit(c.name)) return null;
      const done = nest((s) => w.helpers.invoker([], "V", true)(s, w.ensureSlot(c.name), -1));
      return done instanceof Promise ? done.then(() => {}) : null;
    },

    hasMethod(c, name, sig, isStatic) {
      const m = prog.resolve(c.name, name, view(c, sig));
      return !!m && m.isStatic === isStatic;
    },
    field(c, name, sig, isStatic): WasmField | null {
      const info = prog.resolveField(c.name, name, view(c, sig));
      return info && info.isStatic === isStatic ? { cls: cls(info.owner), key: (isStatic ? "static " : "") + name + ":" + sig, type: sig, isStatic, info } : null;
    },
    get(f, o) { const info = (f as WasmField).info; return bridge.read(info, info.isStatic ? null : o as object); },
    set(f, o, v) { const info = (f as WasmField).info; bridge.write(info, info.isStatic ? null : o as object, v); },
    invoke(c, name, sig, isStatic, self, args, nonvirtual) {
      if (!isStatic && (self === null || self === undefined)) return fail("java/lang/NullPointerException", "JNI call on null " + name);
      const desc = view(c, sig), m = isStatic || nonvirtual ? prog.resolve(c.name, name, desc) : prog.dispatchFor(w.classNameOf(self as object), name, desc);
      if (m && failed(m)) return fail("java/lang/IncompatibleClassChangeError", m.message);
      if (nonvirtual && !isStatic && m && !m.isStatic && !prog.get(c.name)?.isInterface) {
        const selected = prog.dispatchFor(c.name, name, desc);
        if (selected && failed(selected)) return fail("java/lang/IncompatibleClassChangeError", selected.message);
      }
      if (!m && !isStatic && !nonvirtual) {
        const declared = prog.resolve(c.name, name, desc), target = symbolicImplFor(prog, w.classNameOf(self as object), name + javaName(desc), true);
        if (declared && !declared.isStatic && target && target.flags & ACC.ABSTRACT) return fail("java/lang/AbstractMethodError", target.cls + "." + target.key);
      }
      if (!m || m.isStatic !== isStatic) return noSuchMethod(name, sig);
      if (!isStatic && m.flags & ACC.ABSTRACT) return fail("java/lang/AbstractMethodError", m.cls + "." + m.key);
      return nest((s) => bridge.callOn(s, m, isStatic ? null : self as object, args));
    },
    construct(c, sig, args) {
      if (c.name === STRING) {
        // a String is built by the production constructor table out of host values, then made a Java String
        const make = (rt.newStr as Record<string, (...a: unknown[]) => string>)[sig];
        if (!make) return noSuchMethod("<init>", sig);
        const mark = bridge.begin();
        try { return w.javaString(make(...args.map((a) => bridge.toHost(a)))); } finally { bridge.end(mark); }
      }
      // GetMethodID finds a superclass's constructor too (ART's FindClassMethod); NewObject runs it on a new `c`
      const ctor = prog.resolve(c.name, "<init>", view(c, sig));
      if (!ctor) return noSuchMethod("<init>", sig);
      const o = newInstance(w, c.name), done = nest((s) => bridge.callOn(s, ctor, o, args));
      return done instanceof Promise ? done.then(() => o) : o;
    },
    allocate: (c) => newInstance(w, c.name),
    reflect(c, name, desc) {
      const own = view(c, desc), params = own.slice(1, own.indexOf(")")).match(/\[*(?:L[^;]+;|.)/g) ?? [], types = bridge.newArray("[Ljava/lang/Class;", params.length);
      params.forEach((p, i) => bridge.setElement(types, i, mirror(cls(typeName(p)))));
      const owner = mirror(c) as object;
      return name === "<init>" ? call(owner, "getDeclaredConstructorInternal", "([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;", types)
        : call(owner, "getDeclaredMethodInternal", "(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;", w.javaString(name), types);
    },
    unreflectMethod(o): JniMethod | null {
      const kind = w.classNameOf(o as object), ctor = prog.isSubclass(kind, "java/lang/reflect/Constructor");
      if (!ctor && !prog.isSubclass(kind, "java/lang/reflect/Method")) return null;
      const object = o as object, owner = classOf(call(object, "getDeclaringClass", "()Ljava/lang/Class;"))!, params = (call(object, "getParameterTypes", "()[Ljava/lang/Class;") as object);
      let desc = "(";
      for (let i = 0, n = bridge.arrayLength(params); i < n; i++) desc += descriptor(bridge.element(params, i));
      desc += ")" + (ctor ? "V" : descriptor(call(object, "getReturnType", "()Ljava/lang/Class;")));
      return { cls: owner, name: ctor ? "<init>" : bridge.toHost(call(object, "getName", "()Ljava/lang/String;")) as string, desc, isStatic: !ctor && ((call(object, "getModifiers", "()I") as number) & ACC.STATIC) !== 0 };
    },
    unreflectField(o): WasmField | null {
      if (!prog.isSubclass(w.classNameOf(o as object), "java/lang/reflect/Field")) return null;
      const object = o as object, owner = classOf(call(object, "getDeclaringClass", "()Ljava/lang/Class;"))!, name = bridge.toHost(call(object, "getName", "()Ljava/lang/String;")) as string;
      return vm.field(owner, name, descriptor(call(object, "getType", "()Ljava/lang/Class;")), ((call(object, "getModifiers", "()I") as number) & ACC.STATIC) !== 0) as WasmField | null;
    },
    nativeKind(c, name, sig) {
      const jc = prog.get(c.name), m = jc?.byKey.get(name + view(c, sig));
      if (!jc || !m) return { isStatic: false, critical: false };
      const critical = m.isStatic && !!jc.dex?.classAnnotations(jc.def!).methods.get(m.methodIdx)?.some((a) => a.type === "dalvik/annotation/optimization/CriticalNative");
      return { isStatic: m.isStatic, critical };
    },
    bind(c, name, sig, _isStatic, entry) { rt.registerJni(c.name, name + view(c, sig), entry); },

    string: (js) => w.javaString(js),
    chars: (s) => bridge.toHost(s) as string,
    length: (a) => bridge.arrayLength(a as object),
    elementType: (a) => w.classNameOf(a as object)[1],
    newPrimitiveArray: (type, n) => bridge.newArray("[" + type, n),
    newObjectArray(n, c, init) {
      const a = bridge.newArray("[" + (c ? (c.name[0] === "[" ? c.name : `L${c.name};`) : "L" + OBJECT + ";"), n);
      if (init !== null && init !== undefined) for (let i = 0; i < n; i++) bridge.setElement(a, i, init);
      return a;
    },
    element: (a, i) => bridge.element(a as object, i),
    setElement: (a, i, v) => bridge.setElement(a as object, i, v),
    toGuest: (array, type, start, n, p) => copy(true, type)(array, start, n, p, 0),
    fromGuest: (array, type, start, n, p) => copy(false, type)(array, start, n, p, 0),

    throwable: (name, msg) => w.makeThrowable(name, msg),
    noClass: (name) => { rt.noteMissing("class " + name); return w.makeThrowable("java/lang/NoClassDefFoundError", `Failed resolution of: L${name};`); },
    caught: (e) => w.throwable(w.boundary(e)) ?? w.makeThrowable("java/lang/InternalError", e instanceof Error ? e.message : String(e)),
    raise: (t) => bridge.toHost(t),
    describe: (t) => bridge.toHost(call(t as object, "toString", "()Ljava/lang/String;")) as string,
    monitor(o, enter) {
      const done = w.sched.nativeMonitor(runningThread(w), o as object, enter);
      if (done instanceof Promise) return done;
      if (done !== 0) fail("java/lang/IllegalMonitorStateException", "object not locked by thread before unlock");
    },
    newBuffer(address, capacity) {
      const b = newInstance(w, "java/nio/DirectByteBuffer");
      bridge.call(prog.get("java/nio/DirectByteBuffer")!.byKey.get("<init>(JI)V")!, b, [BigInt(address), capacity]);
      return b;
    },
    bufferAddress: (o) => (prog.isSubclass(w.classNameOf(o as object), "java/nio/Buffer") ? bridge.read(bufferField("address", "J"), o as object) as bigint : null),
    bufferCapacity: (o) => bridge.read(bufferField("capacity", "I"), o as object) as number,
    host: (o) => bridge.toHost(o),
  };
  return vm;
}
