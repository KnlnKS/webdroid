// java.lang.invoke as VM built-ins: the handles invoke-polymorphic dispatches through and the
// call-site bootstraps invoke-custom links. The surface is what AOSP and app bytecode reach:
// VarHandles for java.util.concurrent, method handles for RemoteViews and proxy bridges, and
// ObjectMethods for records.

import { parseMethodDesc, mangleMethod, descToName, jarray, VARHANDLE_MODES } from "../abi";
import { JObj, rt, driven, type Gen, type Runtime } from "../runtime";
import type { DexFile } from "../dex";
import { vcall, type JClass } from "./jlang";
import { boxReturn, JMethod, unboxArg, classDesc, classForDesc, classFields, classMethods } from "./jreflect";

// ── MethodType

class JMethodType extends JObj {
  rtype!: JClass;
  ptypes!: JClass[];
  get desc(): string { return "(" + this.ptypes.map(classDesc).join("") + ")" + classDesc(this.rtype); }
}
function methodType(rtype: JClass, ptypes: JClass[]): JMethodType {
  if (!rtype || ptypes.some((p) => !p)) rt.npe();
  const t = new JMethodType();
  t.rtype = rtype; t.ptypes = ptypes;
  return t;
}
function typeOfDesc(desc: string, runtime: Runtime = rt): JMethodType {
  const { params, ret } = parseMethodDesc(desc);
  return methodType(classForDesc(ret, runtime) as JClass, params.map((p) => classForDesc(p, runtime) as JClass));
}
const types = (ts: JClass[]) => jarray(ts.slice(), "Ljava/lang/Class;");

rt.register({
  name: "java/lang/invoke/MethodType", ctor: JMethodType,
  methods: {
    "static methodType(Ljava/lang/Class;)Ljava/lang/invoke/MethodType;": (r: JClass) => methodType(r, []),
    "static methodType(Ljava/lang/Class;Ljava/lang/Class;)Ljava/lang/invoke/MethodType;": (r: JClass, p: JClass) => methodType(r, [p]),
    "static methodType(Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;": (r: JClass, ps: JClass[]) => methodType(r, [...ps]),
    "static methodType(Ljava/lang/Class;Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;":
      (r: JClass, p: JClass, ps: JClass[]) => methodType(r, [p, ...ps]),
    "returnType()Ljava/lang/Class;": function (this: JMethodType) { return this.rtype; },
    "rtype()Ljava/lang/Class;": function (this: JMethodType) { return this.rtype; },
    "parameterCount()I": function (this: JMethodType) { return this.ptypes.length; },
    "parameterArray()[Ljava/lang/Class;": function (this: JMethodType) { return types(this.ptypes); },
    "ptypes()[Ljava/lang/Class;": function (this: JMethodType) { return types(this.ptypes); },
    "changeReturnType(Ljava/lang/Class;)Ljava/lang/invoke/MethodType;": function (this: JMethodType, r: JClass) { return methodType(r, this.ptypes); },
    "dropParameterTypes(II)Ljava/lang/invoke/MethodType;": function (this: JMethodType, start: number, end: number) {
      if (start < 0 || start > end || end > this.ptypes.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", `${start}..${end}`);
      return methodType(this.rtype, [...this.ptypes.slice(0, start), ...this.ptypes.slice(end)]);
    },
    "equals(Ljava/lang/Object;)Z": function (this: JMethodType, o: unknown) { return o instanceof JMethodType && o.desc === this.desc ? 1 : 0; },
    "toString()Ljava/lang/String;": function (this: JMethodType) { return this.desc; },
  },
});

// ── MethodHandle

const enum Kind { Virtual, Special, Static }

class JMethodHandle extends JObj {
  method!: JMethod;
  kind = Kind.Virtual;
  receiver: unknown = null;
  bound = false;
  /** the handle's type: a non-static target takes its receiver first unless bound */
  get desc(): string {
    const m = this.method;
    return m.isStatic || this.bound ? m.desc : "(L" + m.owner.name + ";" + m.desc.slice(1);
  }
  /** invoke-polymorphic MethodHandle.invoke / invokeExact; `site` is the call's own type */
  $invoke(site: string, exact: boolean, ...args: unknown[]): unknown {
    const desc = this.desc;
    if (site === desc) return this.call(args);
    if (exact) throw rt.mkThrowable("java/lang/invoke/WrongMethodTypeException", `expected ${desc} but was ${site}`);
    const want = parseMethodDesc(desc), have = parseMethodDesc(site);
    if (want.params.length !== have.params.length)
      throw rt.mkThrowable("java/lang/invoke/WrongMethodTypeException", `cannot convert ${desc} to ${site}`);
    const r = this.call(args.map((a, i) => convert(a, have.params[i], want.params[i])));
    return r instanceof Promise ? r.then((v) => convert(v, want.ret, have.ret)) : convert(r, want.ret, have.ret);
  }
  call(args: unknown[]): unknown {
    const m = this.method;
    if (m.isStatic) {
      const p = rt.initClass(m.owner);
      return p ? p.then(() => m.fn!.apply(m.owner.ctor, args)) : m.fn!.apply(m.owner.ctor, args);
    }
    const recv = this.bound ? this.receiver : args.shift();
    if (recv == null) rt.npe();
    (m.owner.owner ?? rt).cc(recv, m.owner.name);
    const fn = this.kind === Kind.Virtual ? (recv as Record<string, unknown>)[mangleMethod(m.name, m.desc)] ?? m.fn : m.fn;
    if (typeof fn !== "function") throw rt.mkThrowable("java/lang/AbstractMethodError", `${m.owner.name}.${m.name}${m.desc}`);
    return fn.apply(recv, args);
  }
}

/** asType's boxing and unboxing between a call site's type and the handle's */
function convert(v: unknown, from: string, to: string): unknown {
  if (to === "V") return undefined;
  const primFrom = from.length === 1, primTo = to.length === 1;
  if (primFrom && !primTo) return boxReturn(from, v);
  if (!primFrom && primTo) {
    if (v == null) rt.npe();
    return unboxArg(v);
  }
  return v;
}

function handle(method: JMethod, kind: Kind, receiver: unknown = null, bound = false): JMethodHandle {
  const h = new JMethodHandle();
  h.method = method; h.kind = kind; h.receiver = receiver; h.bound = bound;
  return h;
}

rt.register({
  name: "java/lang/invoke/MethodHandle", ctor: JMethodHandle,
  methods: {
    "type()Ljava/lang/invoke/MethodType;": function (this: JMethodHandle) { return typeOfDesc(this.desc, this.method.owner.owner); },
    "bindTo(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;": function (this: JMethodHandle, receiver: unknown) {
      if (this.bound || this.method.isStatic) throw rt.mkThrowable("java/lang/IllegalArgumentException", "no leading reference parameter");
      (this.method.owner.owner ?? rt).cc(receiver, this.method.owner.name);
      return handle(this.method, this.kind, receiver, true);
    },
    "invokeWithArguments([Ljava/lang/Object;)Ljava/lang/Object;": driven(function* (this: JMethodHandle, args: unknown[] | null): Gen {
      const { params, ret } = parseMethodDesc(this.desc);
      const supplied = args ?? [];
      if (supplied.length !== params.length)
        throw rt.mkThrowable("java/lang/invoke/WrongMethodTypeException", `expected ${params.length} arguments`);
      const result = this.call(supplied.map((a, i) => params[i].length === 1 ? unboxArg(a) : a));
      return boxReturn(ret, result instanceof Promise ? yield result : result);
    }),
  },
});

// ── VarHandle: every access mode reads and writes through two coordinates (receiver; array and
// index; or none), which compiled call sites always pass. A realm is one thread, so the plain,
// opaque, acquire/release and volatile modes coincide. Each field, static and array element type
// gets a class whose modes name the variable literally, so a call site such as
// AtomicInteger.incrementAndGet stays monomorphic and V8 inlines it as a property update.

class JVarHandle extends JObj {
  /** the variable's descriptor */
  type = "";
}
/** CAS comparison: references by identity (a null reference may read as 0), NaN equal to NaN */
const same = (x: unknown, y: unknown) => x === y || (x !== x && y !== y) || (x == null || x === 0) && (y == null || y === 0);
const WRAP: Record<string, ((x: string) => string) | undefined> = {
  I: (x) => `(${x})|0`, J: (x) => `BigInt.asIntN(64,${x})`, S: (x) => `((${x})<<16)>>16`, B: (x) => `((${x})<<24)>>24`,
  C: (x) => `(${x})&65535`, Z: (x) => `(${x})&1`, F: (x) => `Math.fround(${x})`, D: (x) => `(${x})`,
};
const numeric = (type: string) => rt.mkThrowable("java/lang/UnsupportedOperationException", "numeric access mode on " + type);
/** the access modes over one variable of `type`, read by the expression `ld` and written by `st(v)`
 *  over coordinates a and b, after the statement `check`; `E` is the static holder */
function handleClass(base: typeof JVarHandle, type: string, ld: string, st: (v: string) => string, check: string, holder: unknown): new () => JVarHandle {
  const w = WRAP[type], eq = w && type !== "F" && type !== "D" ? "c===e" : "c===e||same(c,e)";
  const rmw = (op: string) => w ? `{${check}const c=${ld};${st(w(`c${op}v`))};return c}` : `{throw numeric(${JSON.stringify(type)})}`;
  const cls = new Function("Base", "same", "numeric", "R", "E", `return class extends Base{
$get(a,b){${check}return ${ld}}
$set(a,b,v){${check}${st("v")}}
$compareAndSet(a,b,e,v){${check}const c=${ld};if(!(${eq}))return 0;${st("v")};return 1}
$compareAndExchange(a,b,e,v){${check}const c=${ld};if(${eq})${st("v")};return c}
$getAndSet(a,b,v){${check}const c=${ld};${st("v")};return c}
$getAndAdd(a,b,v)${rmw("+")}
$getAndBitwiseOr(a,b,v)${rmw("|")}
$getAndBitwiseAnd(a,b,v)${rmw("&")}
$getAndBitwiseXor(a,b,v)${rmw("^")}
}`)(base, same, numeric, rt, holder);
  const modes = cls.prototype as Record<string, unknown>;
  for (const mode of VARHANDLE_MODES) {
    const plain = mode.replace(/^weakCompareAndSet\w*/, "compareAndSet").replace(/(Volatile|Opaque|Acquire|Release)$/, "");
    modes["$" + mode] ??= modes["$" + plain];
  }
  return cls;
}
class FieldVarHandle extends JVarHandle {}
class StaticVarHandle extends JVarHandle {}
class ArrayVarHandle extends JVarHandle {}
const handleClasses = new Map<unknown, Map<string, new () => JVarHandle>>();
/** one class per variable: a field's by its property, a static's by its holder too */
function varHandle(holder: unknown, key: string, make: () => new () => JVarHandle, type: string): JVarHandle {
  let byKey = handleClasses.get(holder);
  if (!byKey) handleClasses.set(holder, byKey = new Map());
  let cls = byKey.get(key);
  if (!cls) byKey.set(key, cls = make());
  const h = new cls();
  h.type = type;
  return h;
}
const fieldHandle = (prop: string, type: string) => {
  const at = `a[${JSON.stringify(prop)}]`;
  return varHandle(null, prop + ":" + type, () => handleClass(FieldVarHandle, type, at, (v) => `${at}=${v}`, "", null), type);
};
const staticHandle = (holder: object, prop: string, type: string) => {
  const at = `E[${JSON.stringify(prop)}]`;
  return varHandle(holder, prop + ":" + type, () => handleClass(StaticVarHandle, type, at, (v) => `${at}=${v}`, "", holder), type);
};
const arrayHandle = (type: string) => varHandle(null, "[" + type,
  () => handleClass(ArrayVarHandle, type, "a[b]", (v) => `a[b]=${v}`, "if((b>>>0)>=a.length)R.aio(b,a.length);", null), type);

const fence = () => {};
rt.register({
  name: "java/lang/invoke/VarHandle", ctor: JVarHandle as unknown as new () => object,
  methods: {
    "static fullFence()V": fence, "static acquireFence()V": fence, "static releaseFence()V": fence,
    "static loadLoadFence()V": fence, "static storeStoreFence()V": fence,
    "varType()Ljava/lang/Class;": function (this: JVarHandle) { return classForDesc(this.type); },
  },
});
for (const [name, ctor] of [["FieldVarHandle", FieldVarHandle], ["StaticFieldVarHandle", StaticVarHandle], ["ArrayElementVarHandle", ArrayVarHandle]] as const)
  rt.register({ name: "java/lang/invoke/" + name, sup: "java/lang/invoke/VarHandle", ctor });

// ── Lookup: access checks are not modelled; every lookup can see what the class can

class JLookup extends JObj {
  lookupClass: JClass | null = null;
  modes = 0;
}
function lookup(lookupClass: JClass | null, modes: number): JLookup {
  const l = new JLookup(); l.lookupClass = lookupClass; l.modes = modes; return l;
}
const TRUSTED = -1, PUBLIC = 1;

function findField(refc: JClass, name: string, type: JClass, isStatic: boolean) {
  if (!refc || !name || !type) rt.npe();
  const desc = classDesc(type);
  for (let ci = refc.ci; ci; ci = ci.superInfo) {
    const f = classFields(ci, name)[0];
    // a native class declares its fields untyped
    if (f && f.isStatic === isStatic && (f.desc === desc || ci.native)) return { f, desc };
  }
  throw rt.mkThrowable("java/lang/NoSuchFieldException", name);
}

function findMethod(refc: JClass, name: string, type: JMethodType, isStatic: boolean): JMethod {
  if (!refc || !name || !type) rt.npe();
  const desc = type.desc, ci = refc.ci;
  const m = ci && classMethods(ci, false).find((m) => m.name === name && m.desc === desc && m.isStatic === isStatic);
  if (!m) throw rt.mkThrowable("java/lang/NoSuchMethodException", `no such method: ${ci?.name}.${name}${desc}`);
  return m;
}

rt.register({
  name: "java/lang/invoke/MethodHandles", ctor: class extends JObj {},
  methods: {
    "static lookup()Ljava/lang/invoke/MethodHandles$Lookup;": () => lookup(null, TRUSTED),
    "static publicLookup()Ljava/lang/invoke/MethodHandles$Lookup;": () => lookup(rt.classFor("java/lang/Object"), PUBLIC),
    "static privateLookupIn(Ljava/lang/Class;Ljava/lang/invoke/MethodHandles$Lookup;)Ljava/lang/invoke/MethodHandles$Lookup;":
      (target: JClass, caller: JLookup) => { if (!target || !caller) rt.npe(); return lookup(target, caller.modes); },
    "static arrayElementVarHandle(Ljava/lang/Class;)Ljava/lang/invoke/VarHandle;": (arrayClass: JClass) => {
      if (!arrayClass) rt.npe();
      if (!arrayClass.arrDesc) throw rt.mkThrowable("java/lang/IllegalArgumentException", "not an array class");
      return arrayHandle(arrayClass.arrDesc.slice(1));
    },
  },
});

rt.register({
  name: "java/lang/invoke/MethodHandles$Lookup", ctor: JLookup,
  methods: {
    "<init>(Ljava/lang/Class;I)V": function (this: JLookup, lookupClass: JClass, modes: number) {
      if (!lookupClass) rt.npe();
      this.lookupClass = lookupClass; this.modes = modes;
    },
    "in(Ljava/lang/Class;)Ljava/lang/invoke/MethodHandles$Lookup;": function (this: JLookup, requested: JClass) {
      if (!requested) rt.npe();
      return lookup(requested, this.modes);
    },
    "findVarHandle(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/invoke/VarHandle;": (refc: JClass, name: string, type: JClass) => {
      const { f, desc } = findField(refc, name, type, false);
      return fieldHandle(f.prop, desc);
    },
    "findStaticVarHandle(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/invoke/VarHandle;": driven(function* (refc: JClass, name: string, type: JClass): Gen {
      const { f, desc } = findField(refc, name, type, true);
      const p = rt.initClass(f.owner); if (p) yield p;
      return staticHandle(f.owner.ctor, f.prop, desc);
    }),
    "findVirtual(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;":
      (refc: JClass, name: string, type: JMethodType) => handle(findMethod(refc, name, type, false), Kind.Virtual),
    "findStatic(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/MethodHandle;":
      (refc: JClass, name: string, type: JMethodType) => handle(findMethod(refc, name, type, true), Kind.Static),
    "unreflect(Ljava/lang/reflect/Method;)Ljava/lang/invoke/MethodHandle;": (method: JMethod) => {
      if (!method) rt.npe();
      return handle(method, method.isStatic ? Kind.Static : Kind.Virtual);
    },
    "unreflectSpecial(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;": (method: JMethod, caller: JClass) => {
      if (!method || !caller) rt.npe();
      if (method.isStatic) throw rt.mkThrowable("java/lang/IllegalArgumentException", "static method");
      return handle(method, Kind.Special);
    },
  },
});

// ── invoke-custom: a call site's bootstrap yields the function the site calls

/** ObjectMethods.bootstrap: a record's toString/equals/hashCode over its component getters */
function objectMethods(dex: DexFile, runtime: Runtime, name: string, recordType: number, names: string, getters: number[]) {
  const record = descToName(dex.type(recordType));
  const simple = record.slice(Math.max(record.lastIndexOf("/"), record.lastIndexOf("$")) + 1);
  const labels = names ? names.split(";") : [];
  const comps = getters.map((i) => {
    const ref = dex.methodHandle(i);
    if (ref.type !== 3) throw runtime.unimplemented(`ObjectMethods getter handle kind ${ref.type}`);
    return { prop: runtime.resolveInstanceField(dex, ref.idx), desc: dex.type(dex.field(ref.idx).type) };
  });
  const isNull = (v: unknown, desc: string) => desc.length > 1 && (v == null || v === 0);
  switch (name) {
    case "toString": return driven(function* (o: any): Gen {
      const parts: string[] = [];
      for (let i = 0; i < comps.length; i++) {
        const { prop, desc } = comps[i], v = o[prop];
        const s = isNull(v, desc) ? "null" : vcall(boxReturn(desc, v), "toString", "()Ljava/lang/String;");
        parts.push(labels[i] + "=" + (s instanceof Promise ? yield s : s));
      }
      return simple + "[" + parts.join(", ") + "]";
    });
    case "hashCode": return driven(function* (o: any): Gen {
      let h = 0;
      for (const { prop, desc } of comps) {
        const v = o[prop];
        const c = isNull(v, desc) ? 0 : vcall(boxReturn(desc, v), "hashCode", "()I");
        h = (Math.imul(h, 31) + (c instanceof Promise ? yield c : c)) | 0;
      }
      return h;
    });
    case "equals": return driven(function* (o: any, other: any): Gen {
      if (o === other) return 1;
      if (other == null || other === 0 || other.constructor !== o.constructor) return 0;
      for (const { prop, desc } of comps) {
        const a = o[prop], b = other[prop];
        if (desc.length === 1) { if (!Object.is(a, b)) return 0; continue; }
        if (a === b || isNull(a, desc) && isNull(b, desc)) continue;
        if (isNull(a, desc) || isNull(b, desc)) return 0;
        const eq = vcall(a, "equals", "(Ljava/lang/Object;)Z", b);
        if (!(eq instanceof Promise ? yield eq : eq)) return 0;
      }
      return 1;
    });
  }
  throw runtime.unimplemented(`ObjectMethods.bootstrap ${name}`);
}

rt.linkCallSite = (runtime, dex, idx) => {
  const [boot, name, , ...extra] = dex.callSite(idx) as any[];
  const bm = dex.method(dex.methodHandle(boot.idx).idx);
  const bootstrap = descToName(dex.type(bm.cls)) + "." + bm.name;
  if (bootstrap === "java/lang/runtime/ObjectMethods.bootstrap")
    return objectMethods(dex, runtime, name, extra[0].idx, extra[1], extra.slice(2).map((h: { idx: number }) => h.idx));
  throw runtime.unimplemented(`invoke-custom ${bootstrap}`);
};

// instances are constructed directly, so link their classes before the first one is made
for (const name of ["MethodHandle", "MethodType", "MethodHandles$Lookup", "FieldVarHandle", "StaticFieldVarHandle", "ArrayElementVarHandle"])
  rt.link("java/lang/invoke/" + name);
