// java.lang.reflect.Method + annotation instances backed by DEX annotation parsing.

import { rt, JObj, type ClassInfo, type NativeSpec, type Runtime } from "../runtime";
import { mangleMethod, mangleStaticField, mangleField, descToName, parseMethodDesc, jarray, newPrimArray, PRIM_NAME, PRIM_DESC, lateMethod } from "../abi";
import { vcall, boxInt, box, stringHash, JClass, JLong, JFloat, JDouble, JChar, JBool, mkEnumSet, classpathStream, linkInit } from "./jlang";
import type { DexFile, EncAnnotation, EncVal } from "../dex";

// ── annotation cache per class: methodIdx (within its dex) → EncAnnotation[]
interface ClassAnno {
  cls: EncAnnotation[];
  methodsByRef: Map<string, EncAnnotation[]>; // "name+desc" → annotations
  fieldsByName: Map<string, EncAnnotation[]>;
  paramsByRef: Map<string, EncAnnotation[][]>;
}
const annoCache = new WeakMap<ClassInfo, ClassAnno>();
function classAnno(info: ClassInfo): ClassAnno {
  let a = annoCache.get(info);
  if (a) return a;
  a = { cls: [], methodsByRef: new Map(), fieldsByName: new Map(), paramsByRef: new Map() };
  if (info.dex && info.def) {
    const raw = info.dex.classAnnotations(info.def);
    a.cls = raw.cls;
    for (const [methodIdx, annos] of raw.methods) {
      const m = info.dex.method(methodIdx);
      const desc = info.dex.methodDesc(methodIdx);
      a.methodsByRef.set(m.name + desc, annos);
    }
    for (const [fieldIdx, annos] of raw.fields) {
      a.fieldsByName.set(info.dex.field(fieldIdx).name, annos);
    }
    for (const [methodIdx, per] of raw.params) {
      const m = info.dex.method(methodIdx);
      a.paramsByRef.set(m.name + info.dex.methodDesc(methodIdx), per);
    }
  }
  annoCache.set(info, a);
  return a;
}

/** a descriptor as Java spells the type: int, java.lang.String, byte[] */
function javaTypeName(d: string): string {
  let dims = 0;
  while (d[dims] === "[") dims++;
  const base = d[dims] === "L" ? d.slice(dims + 1, -1).replace(/\//g, ".") : PRIM_NAME[d[dims]];
  return base + "[]".repeat(dims);
}
export class JMethod extends JObj {
  owner!: ClassInfo;
  name = "";
  desc = "";
  isStatic = false;
  mods = 0;   // access flags when the declaration is known (a dex method); else public [static]
  fn: ((...a: unknown[]) => unknown) | null = null;
}
export function mkMethod(owner: ClassInfo, name: string, desc: string, isStatic: boolean, fn: (...a: unknown[]) => unknown, mods = 0): JMethod {
  const m = new JMethod();
  m.owner = owner; m.name = name; m.desc = desc; m.isStatic = isStatic; m.fn = fn; m.mods = mods;
  return m;
}

/** the dex's per-parameter annotation sets, padded to the descriptor's parameter count: a dex
 *  records a list only up to the last annotated parameter, and callers index by position */
function paramAnnotations(owner: ClassInfo, name: string, desc: string) {
  const per = classAnno(owner).paramsByRef.get(name + desc) ?? [];
  const n = parseMethodDesc(desc).params.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(jarray((per[i] ?? []).map(mkAnnotation), "Ljava/lang/annotation/Annotation;"));
  return jarray(out, "[Ljava/lang/annotation/Annotation;");
}

/** getAnnotation/isAnnotationPresent/getAnnotations/getDeclaredAnnotations over the receiver's own annotation list */
function annotatedElement<T>(annosOf: (this: T) => EncAnnotation[]): NonNullable<NativeSpec["methods"]> {
  const all = function (this: T) { return jarray(annosOf.call(this).map(mkAnnotation), "Ljava/lang/annotation/Annotation;"); };
  return {
    "getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;": function (this: T, cls: JClass) {
      const found = annosOf.call(this).find((an) => an.type === cls?.ci?.name);
      return found ? mkAnnotation(found) : null;
    },
    "isAnnotationPresent(Ljava/lang/Class;)Z": function (this: T, cls: JClass) {
      return annosOf.call(this).some((an) => an.type === cls?.ci?.name) ? 1 : 0;
    },
    "getAnnotations()[Ljava/lang/annotation/Annotation;": all,
    "getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;": all,
  };
}

class JField extends JObj {
  owner!: ClassInfo;
  fname = "";
  desc = "";
  prop = "";        // mangled property (on instance or ctor)
  isStatic = false;
}
function classFields(info: ClassInfo, name?: string): JField[] {
  const out: JField[] = [];
  const push = (fname: string, desc: string, isStatic: boolean, prop: string) => {
    const f = new JField();
    f.owner = info; f.fname = fname; f.desc = desc; f.isStatic = isStatic; f.prop = prop;
    out.push(f);
  };
  if (info.def && info.dex) {
    for (const [list, isStatic] of [[info.def.instanceFields, false], [info.def.staticFields, true]] as const) {
      for (const ef of list) {
        const fr = info.dex.field(ef.fieldIdx);
        if (name !== undefined && fr.name !== name) continue;
        push(fr.name, info.dex.type(fr.type), isStatic,
          isStatic ? info.staticFieldTable.get(fr.name + ":" + info.dex.type(fr.type))!
            : (info.fieldTable.get(fr.name) ?? mangleField(info.name, fr.name)));
        if (name !== undefined) return out;
      }
    }
  } else if (info.native) {
    for (const [jname, prop] of info.fieldTable) {
      if (name !== undefined && jname !== name) continue;
      push(jname, "Ljava/lang/Object;", false, prop);
      if (name !== undefined) return out;
    }
    for (const k of Object.getOwnPropertyNames(info.ctor)) {
      if (!k.startsWith("s$")) continue;
      const jname = k.slice(2);
      if (name !== undefined && jname !== name) continue;
      push(jname, "Ljava/lang/Object;", true, k);
      if (name !== undefined) return out;
    }
  }
  return out;
}
rt.register({
  name: "java/lang/reflect/Field", ctor: JField,
  ifaces: ["java/lang/reflect/AnnotatedElement", "java/lang/reflect/Member"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JField) { return this.fname; },
    "getType()Ljava/lang/Class;": function (this: JField) { return classForDesc(this.desc, this.owner.owner); },
    "getModifiers()I": function (this: JField) { return (this.isStatic ? 0x8 : 0) | 0x1; },
    "setAccessible(Z)V": () => {},
    "isAccessible()Z": () => 1,
    "getDeclaringClass()Ljava/lang/Class;": function (this: JField) { return (this.owner.owner ?? rt).classFor(this.owner.name); },
    "get(Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JField, o: unknown) {
      const p = rt.initClass(this.owner); if (p) await p;
      const v = this.isStatic ? this.owner.ctor[this.prop] : (o as Record<string, unknown>)[this.prop];
      return boxReturn(this.desc, v);
    },
    "set(Ljava/lang/Object;Ljava/lang/Object;)V": async function (this: JField, o: unknown, v: unknown) {
      const p = rt.initClass(this.owner); if (p) await p;
      const raw = "IJFDZBCS".includes(this.desc[0]) ? unboxArg(v) : v;
      if (this.isStatic) this.owner.ctor[this.prop] = raw;
      else (o as Record<string, unknown>)[this.prop] = raw;
    },
    "getLong(Ljava/lang/Object;)J": function (this: JField, o: unknown) {
      return this.isStatic ? this.owner.ctor[this.prop] : (o as Record<string, unknown>)[this.prop];
    },
    "getInt(Ljava/lang/Object;)I": function (this: JField, o: unknown) {
      return this.isStatic ? this.owner.ctor[this.prop] : (o as Record<string, unknown>)[this.prop];
    },
    "toString()Ljava/lang/String;": function (this: JField) { return this.owner.name + "." + this.fname; },
    ...annotatedElement(function (this: JField) { return classAnno(this.owner).fieldsByName.get(this.fname) ?? []; }),
  },
});

// ── generic type model (ParameterizedType from dalvik.annotation.Signature)
class JPType extends JObj {
  raw: unknown = null;       // JClass
  args: unknown[] = [];      // Type[]
  key = "";                  // canonical string for equals/hashCode
}
rt.register({ name: "java/lang/reflect/ParameterizedType", ctor: class extends JObj {} });
rt.register({
  name: "webdroid/PType", ctor: JPType, ifaces: ["java/lang/reflect/ParameterizedType", "java/lang/reflect/Type"],
  methods: {
    "getRawType()Ljava/lang/reflect/Type;": function (this: JPType) { return this.raw; },
    "getOwnerType()Ljava/lang/reflect/Type;": () => null,
    "getActualTypeArguments()[Ljava/lang/reflect/Type;": function (this: JPType) { return jarray(this.args.slice(), "Ljava/lang/reflect/Type;"); },
    "toString()Ljava/lang/String;": function (this: JPType) { return this.key; },
    "hashCode()I": function (this: JPType) { return stringHash(this.key); },
    "equals(Ljava/lang/Object;)Z": function (this: JPType, o: unknown) { return o instanceof JPType && o.key === this.key ? 1 : 0; },
  },
});
/** parse one type signature at ref.pos; returns JClass or JPType */
function parseTypeSig(s: string, ref: { pos: number }): unknown {
  const c = s[ref.pos];
  if (c === "L") {
    let name = "";
    ref.pos++;
    while (ref.pos < s.length && s[ref.pos] !== ";" && s[ref.pos] !== "<") name += s[ref.pos++];
    const args: unknown[] = [];
    if (s[ref.pos] === "<") {
      ref.pos++;
      while (s[ref.pos] !== ">") args.push(parseTypeSig(s, ref));
      ref.pos++; // '>'
      // inner-class suffix ".Name" possible; skip to ';'
      while (ref.pos < s.length && s[ref.pos] !== ";") ref.pos++;
    }
    ref.pos++; // ';'
    if (!args.length) return rt.classFor(name);
    const t = new JPType();
    t.raw = rt.classFor(name);
    t.args = args;
    t.key = name.replace(/\//g, ".") + "<" + args.map((a: any) => a?.key ?? (a?.ci?.name ?? a?.primName ?? a?.arrDesc ?? "?")).join(", ") + ">";
    return t;
  }
  if (c === "[") { ref.pos++; const el: any = parseTypeSig(s, ref); const d = el?.ci ? "[L" + el.ci.name + ";" : "[Ljava/lang/Object;"; return rt.classFor(d); }
  if (c === "T") { while (ref.pos < s.length && s[ref.pos] !== ";") ref.pos++; ref.pos++; return rt.classFor("java/lang/Object"); }
  if (c === "+" || c === "-") { ref.pos++; return parseTypeSig(s, ref); }
  if (c === "*") { ref.pos++; return rt.classFor("java/lang/Object"); }
  ref.pos++; // primitive
  return rt.classFor(PRIM_NAME[c] ?? "int");
}

/** an array of `len` elements whose component type is `cls` — what both
 *  java.lang.reflect.Array.newInstance and VMRuntime.newUnpaddedArray hand back */
function newArrayOf(cls: JClass | null, len: number): unknown {
  if (len < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", String(len));
  const prim = cls?.primName;
  if (prim && PRIM_DESC[prim]) return newPrimArray[PRIM_DESC[prim]](len);
  const elem = cls?.arrDesc ? "[" + cls.arrDesc : cls?.ci ? "L" + cls.ci.name + ";" : "Ljava/lang/Object;";
  return rt.oa(len, elem);
}

rt.register({
  name: "java/lang/reflect/Array", ctor: class extends JObj {},
  methods: {
    "static newInstance(Ljava/lang/Class;I)Ljava/lang/Object;": (cls: JClass | null, len: number) => newArrayOf(cls, len),
    "static getLength(Ljava/lang/Object;)I": (a: ArrayLike<unknown> | null) => a?.length ?? 0,
    "static get(Ljava/lang/Object;I)Ljava/lang/Object;": (a: ArrayLike<unknown>, i: number) => a[i],
    "static set(Ljava/lang/Object;ILjava/lang/Object;)V": (a: unknown[], i: number, v: unknown) => { a[i] = v; },
  },
});

// libcore's shared empty arrays. Framework code returns these instead of allocating, so an
// absent class is a NoClassDefFoundError on a path that was trying to allocate nothing.
rt.register({
  name: "libcore/util/EmptyArray", ctor: class extends JObj {},
  statics: {
    BOOLEAN: new Uint8Array(0), BYTE: new Int8Array(0), CHAR: new Uint16Array(0),
    DOUBLE: new Float64Array(0), FLOAT: new Float32Array(0), INT: new Int32Array(0),
    LONG: new BigInt64Array(0), SHORT: new Int16Array(0),
    OBJECT: jarray([], "Ljava/lang/Object;"), STRING: jarray([], "Ljava/lang/String;"),
    CLASS: jarray([], "Ljava/lang/Class;"),
  },
});

// ── dalvik.system.VMRuntime: the allocator libcore and the framework grow arrays through.
// ArrayUtils.newUnpaddedObjectArray and every growable collection in android.util reach it, so
// it is the first thing framework bytecode wants that has nothing to do with the framework.
// "Unpadded" is a request for the slack a real heap has at the end of a block; there is no such
// slack here, so the array is exactly the length asked for — which the contract allows.
class JVMRuntime extends JObj {}
const theVmRuntime = new JVMRuntime();
rt.register({
  name: "dalvik/system/VMRuntime", ctor: JVMRuntime,
  methods: {
    "static getRuntime()Ldalvik/system/VMRuntime;": () => theVmRuntime,
    "newUnpaddedArray(Ljava/lang/Class;I)Ljava/lang/Object;": (cls: JClass | null, len: number) => newArrayOf(cls, len),
    "newNonMovableArray(Ljava/lang/Class;I)Ljava/lang/Object;": (cls: JClass | null, len: number) => newArrayOf(cls, len),
  },
});

// ── sun.misc.Unsafe: enough for kotlinx-coroutines' artificial stack frames
class JUnsafe extends JObj {}
rt.register({
  name: "sun/misc/Unsafe", ctor: JUnsafe,
  statics: { theUnsafe: new JUnsafe() },
  methods: {
    "allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;": async (cls: JClass) => {
      const info = cls.ci!;
      const p = rt.initClass(info); if (p) await p;
      return new info.ctor();
    },
    "objectFieldOffset(Ljava/lang/reflect/Field;)J": fieldOffset,
    "arrayBaseOffset(Ljava/lang/Class;)I": () => 0,
    "arrayIndexScale(Ljava/lang/Class;)I": (cls: JClass) => arrayIndexScale(cls),
    "getObject(Ljava/lang/Object;J)Ljava/lang/Object;": uGet,
    "getObjectVolatile(Ljava/lang/Object;J)Ljava/lang/Object;": uGet,
    "putObject(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
    "putObjectVolatile(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
    "putOrderedObject(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
    "compareAndSwapObject(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z":
      (o: any, off: bigint, exp: unknown, val: unknown) => {
        const k = uKey(o, off);
        if (o[k] !== exp && !(o[k] === undefined && exp === null)) return 0;
        o[k] = val; return 1;
      },
    "compareAndSwapLong(Ljava/lang/Object;JJJ)Z": (o: any, off: bigint, exp: bigint, val: bigint) => {
      if (uGetLong(o, off) !== exp) return 0;
      uPutLong(o, off, val); return 1;
    },
    "compareAndSwapInt(Ljava/lang/Object;JII)Z": (o: any, off: bigint, exp: number, val: number) => {
      if (uGetInt(o, off) !== exp) return 0;
      uPutInt(o, off, val); return 1;
    },
    "getInt(Ljava/lang/Object;J)I": uGetInt,
    "putInt(Ljava/lang/Object;JI)V": uPutInt,
    "getLong(Ljava/lang/Object;J)J": uGetLong,
    "putLong(Ljava/lang/Object;JJ)V": uPutLong,
    "getBoolean(Ljava/lang/Object;J)Z": (o: any, off: bigint) => {
      const view = uView(o); return view ? (view.getUint8(Number(off)) ? 1 : 0) : (o[uKey(o, off)] ? 1 : 0);
    },
    "putBoolean(Ljava/lang/Object;JZ)V": (o: any, off: bigint, v: number) => {
      const view = uView(o); if (view) view.setUint8(Number(off), v ? 1 : 0); else o[uKey(o, off)] = v;
    },
    "getByte(Ljava/lang/Object;J)B": (o: any, off: bigint) => uView(o)?.getInt8(Number(off)) ?? o[uKey(o, off)] ?? 0,
    "putByte(Ljava/lang/Object;JB)V": (o: any, off: bigint, v: number) => {
      const view = uView(o); if (view) view.setInt8(Number(off), v); else o[uKey(o, off)] = v;
    },
    "getFloat(Ljava/lang/Object;J)F": (o: any, off: bigint) => uView(o)?.getFloat32(Number(off), true) ?? o[uKey(o, off)] ?? 0,
    "putFloat(Ljava/lang/Object;JF)V": (o: any, off: bigint, v: number) => {
      const view = uView(o); if (view) view.setFloat32(Number(off), v, true); else o[uKey(o, off)] = v;
    },
    "getDouble(Ljava/lang/Object;J)D": (o: any, off: bigint) => uView(o)?.getFloat64(Number(off), true) ?? o[uKey(o, off)] ?? 0,
    "putDouble(Ljava/lang/Object;JD)V": (o: any, off: bigint, v: number) => {
      const view = uView(o); if (view) view.setFloat64(Number(off), v, true); else o[uKey(o, off)] = v;
    },
    "staticFieldOffset(Ljava/lang/reflect/Field;)J": fieldOffset,
    "staticFieldBase(Ljava/lang/reflect/Field;)Ljava/lang/Object;": (f: JField) => f.owner.ctor,
    "getLongVolatile(Ljava/lang/Object;J)J": uGetLong,
    "getIntVolatile(Ljava/lang/Object;J)I": uGetInt,
    "putIntVolatile(Ljava/lang/Object;JI)V": uPutInt,
    "getAndAddInt(Ljava/lang/Object;JI)I": (o: any, off: bigint, d: number) => { const old = uGetInt(o, off); uPutInt(o, off, (old + d) | 0); return old; },
    "getAndAddLong(Ljava/lang/Object;JJ)J": (o: any, off: bigint, d: bigint) => { const old = uGetLong(o, off); uPutLong(o, off, BigInt.asIntN(64, old + d)); return old; },
    "getAndSetInt(Ljava/lang/Object;JI)I": (o: any, off: bigint, v: number) => { const old = uGetInt(o, off); uPutInt(o, off, v); return old; },
    "putLongVolatile(Ljava/lang/Object;JJ)V": uPutLong,
    "putOrderedLong(Ljava/lang/Object;JJ)V": uPutLong,
    "getAndSetObject(Ljava/lang/Object;JLjava/lang/Object;)Ljava/lang/Object;": (o: any, off: bigint, v: unknown) => {
      const k = uKey(o, off); const old = o[k] ?? null; o[k] = v; return old;
    },
  },
});
// Unsafe "offsets" are indices into this table of mangled property names.
const unsafeProps: string[] = [];
const unsafeIndex = new Map<string, number>();
function fieldOffset(f: JField): bigint {
  let i = unsafeIndex.get(f.prop);
  if (i === undefined) { i = unsafeProps.length; unsafeProps.push(f.prop); unsafeIndex.set(f.prop, i); }
  return BigInt(i);
}
function uKey(o: unknown, off: bigint): string | number {
  return Array.isArray(o) || ArrayBuffer.isView(o) ? Number(off) : unsafeProps[Number(off)];
}
function uGet(o: any, off: bigint) { return o[uKey(o, off)] ?? null; }
function uPut(o: any, off: bigint, v: unknown) { o[uKey(o, off)] = v; }
const unsafeViews = new WeakMap<object, DataView>();
function uView(o: unknown): DataView | null {
  if (!ArrayBuffer.isView(o)) return null;
  let view = unsafeViews.get(o);
  if (!view) { view = new DataView(o.buffer, o.byteOffset, o.byteLength); unsafeViews.set(o, view); }
  return view;
}
function uGetInt(o: any, off: bigint): number {
  const view = uView(o);
  if (!view) return o[uKey(o, off)] ?? 0;
  const offset = Number(off);
  if (offset + 4 <= view.byteLength) return view.getInt32(offset, true);
  if (offset < 0 || offset >= view.byteLength) return view.getInt32(offset, true);
  let value = 0;
  for (let i = 0; offset + i < view.byteLength; i++) value |= view.getUint8(offset + i) << (i * 8);
  return value | 0;
}
function uPutInt(o: any, off: bigint, value: number): void {
  const view = uView(o);
  if (!view) { o[uKey(o, off)] = value; return; }
  const offset = Number(off);
  if (offset + 4 <= view.byteLength) { view.setInt32(offset, value, true); return; }
  if (offset < 0 || offset >= view.byteLength) { view.setInt32(offset, value, true); return; }
  for (let i = 0; offset + i < view.byteLength; i++) view.setUint8(offset + i, value >>> (i * 8));
}
function uGetLong(o: any, off: bigint): bigint {
  return uView(o)?.getBigInt64(Number(off), true) ?? o[uKey(o, off)] ?? 0n;
}
function uPutLong(o: any, off: bigint, value: bigint): void {
  const view = uView(o); if (view) view.setBigInt64(Number(off), value, true); else o[uKey(o, off)] = value;
}
function arrayIndexScale(cls: JClass): number {
  switch (cls.arrDesc?.[1]) {
    case "C": case "S": return 2;
    case "F": case "I": return 4;
    case "D": case "J": return 8;
    default: return 1;
  }
}

/** all public methods of a class (self + inherited), like Class.getMethods */
function classMethods(info: ClassInfo, declaredOnly: boolean): JMethod[] {
  rt.ensureCompiled(info);
  const out: JMethod[] = [];
  const seen = new Set<string>();
  const collectNative = (ci: ClassInfo) => {
    const spec = rt.natives.get(ci.name);
    for (const key of Object.keys(spec?.methods ?? {})) {
      let k = key, isStatic = false;
      if (k.startsWith("static ")) { isStatic = true; k = k.slice(7); }
      const paren = k.indexOf("(");
      const name = k.slice(0, paren), desc = k.slice(paren);
      if (name === "<init>" || seen.has(name + desc)) continue;
      seen.add(name + desc);
      const mangled = mangleMethod(name, desc);
      const fn = isStatic ? ci.ctor[mangled] : ci.ctor.prototype[mangled];
      if (typeof fn === "function") out.push(mkMethod(ci, name, desc, isStatic, fn));
    }
  };
  const collect = (ci: ClassInfo) => {
    if (!ci.def || !ci.dex) { if (ci.native) collectNative(ci); return; }
    for (const m of [...ci.def.directMethods, ...ci.def.virtualMethods]) {
      const mr = ci.dex.method(m.methodIdx);
      if (mr.name === "<init>" || mr.name === "<clinit>") continue;
      const desc = ci.dex.methodDesc(m.methodIdx);
      const isStatic = (m.flags & 0x8) !== 0;
      const key = mr.name + desc;
      if (seen.has(key)) continue;
      seen.add(key);
      const mangled = mangleMethod(mr.name, desc);
      const fn = isStatic ? ci.ctor[mangled] : ci.ctor.prototype[mangled];
      if (typeof fn === "function") out.push(mkMethod(ci, mr.name, desc, isStatic, fn, m.flags));
    }
  };
  collect(info);
  if (!declaredOnly) {
    let sup = info.superInfo;
    while (sup) { rt.ensureCompiled(sup); collect(sup); sup = sup.superInfo; }
  }
  return out;
}

rt.register({
  name: "java/lang/reflect/Method", ctor: JMethod,
  ifaces: ["java/lang/reflect/AnnotatedElement", "java/lang/reflect/Member", "java/lang/reflect/GenericDeclaration"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JMethod) { return this.name; },
    "getTypeParameters()[Ljava/lang/reflect/TypeVariable;": noTypeVars,
    "getModifiers()I": function (this: JMethod) { return this.mods || (this.isStatic ? 0x8 : 0) | 0x1; },
    "isDefault()Z": function (this: JMethod) { return this.owner.isInterface && this.mods && !(this.mods & 0x400) ? 1 : 0; },
    "getReturnType()Ljava/lang/Class;": function (this: JMethod) {
      return classForDesc(parseMethodDesc(this.desc).ret, this.owner.owner);
    },
    "getParameterTypes()[Ljava/lang/Class;": function (this: JMethod) { return paramClasses(this.desc, "Ljava/lang/Class;", this.owner.owner); },
    "getDeclaringClass()Ljava/lang/Class;": function (this: JMethod) { return (this.owner.owner ?? rt).classFor(this.owner.name); },
    "setAccessible(Z)V": () => {},
    "isAccessible()Z": () => 1,
    "isSynthetic()Z": () => 0,
    "isBridge()Z": () => 0,
    "invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JMethod, recv: unknown, args: unknown[] | null) {
      const a = (args ?? []).map(unboxArg);
      const target = this.isStatic ? this.fn : (recv as Record<string, unknown>)?.[mangleMethod(this.name, this.desc)] ?? rt.proxyMethod?.(recv, this.name, this.desc) ?? this.fn;
      if (typeof target !== "function") throw rt.mkThrowable("java/lang/NoSuchMethodError", `${this.owner.name}.${this.name}${this.desc}`);
      const r = (target as (...x: unknown[]) => unknown).apply(this.isStatic ? this.owner.ctor : recv, a);
      const val = r instanceof Promise ? await r : r;
      return boxReturn(parseMethodDesc(this.desc).ret, val);
    },
    ...annotatedElement(function (this: JMethod) { return classAnno(this.owner).methodsByRef.get(this.name + this.desc) ?? []; }),
    "getParameterAnnotations()[[Ljava/lang/annotation/Annotation;": function (this: JMethod) { return paramAnnotations(this.owner, this.name, this.desc); },
    "getGenericReturnType()Ljava/lang/reflect/Type;": function (this: JMethod) {
      return classForDesc(parseMethodDesc(this.desc).ret, this.owner.owner);
    },
    // Java's own spelling, which a JNI caller parses for the name and parameter types
    "toString()Ljava/lang/String;": function (this: JMethod) {
      const { params, ret } = parseMethodDesc(this.desc);
      const mods = this.mods || (this.isStatic ? 0x9 : 0x1);
      const words = [[1, "public"], [4, "protected"], [2, "private"], [0x400, "abstract"], [8, "static"], [0x10, "final"], [0x20, "synchronized"], [0x100, "native"]] as const;
      return words.filter(([f]) => mods & f).map(([, w]) => w + " ").join("") + `${javaTypeName(ret)} ${this.owner.name.replace(/\//g, ".")}.${this.name}(${params.map(javaTypeName).join(",")})`;
    },
    "equals(Ljava/lang/Object;)Z": function (this: JMethod, o: unknown) {
      return o instanceof JMethod && o.owner === this.owner && o.name === this.name && o.desc === this.desc ? 1 : 0;
    },
    "hashCode()I": function (this: JMethod) { return stringHash(this.name + this.desc); },
  },
});
// ── reflect Constructor. <init> mangles to i$<hash(desc)> with NO class component, so a
// ctor must always be invoked through the prototype of the class that DECLARES it.
export class JCtor extends JObj {
  owner!: ClassInfo;
  desc = "()V";
  flags = 1;
}
const ctorCache = new WeakMap<ClassInfo, JCtor[]>();
/** constructors declared by this class (dex direct <init>s / native <init>(...) keys), memoized */
export function classCtors(info: ClassInfo): JCtor[] {
  const hit = ctorCache.get(info);
  if (hit) return hit;
  rt.ensureCompiled(info);
  const out: JCtor[] = [];
  const add = (desc: string, flags: number) => {
    const c = new JCtor(); c.owner = info; c.desc = desc; c.flags = flags; out.push(c);
  };
  if (info.def && info.dex) {
    for (const m of info.def.directMethods) {
      if (info.dex.method(m.methodIdx).name === "<init>") add(info.dex.methodDesc(m.methodIdx), m.flags);
    }
  } else if (info.native) {
    for (const key of Object.keys(rt.natives.get(info.name)?.methods ?? {})) {
      if (key.startsWith("<init>(")) add(key.slice(6), 1);
    }
  }
  ctorCache.set(info, out);
  return out;
}
rt.register({
  name: "java/lang/reflect/Constructor", ctor: JCtor,
  ifaces: ["java/lang/reflect/AnnotatedElement", "java/lang/reflect/Member", "java/lang/reflect/GenericDeclaration"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JCtor) { return this.owner.name.replace(/\//g, "."); },
    "getTypeParameters()[Ljava/lang/reflect/TypeVariable;": noTypeVars,
    "getModifiers()I": function (this: JCtor) { return this.flags; },
    "getDeclaringClass()Ljava/lang/Class;": function (this: JCtor) { return (this.owner.owner ?? rt).classFor(this.owner.name); },
    "setAccessible(Z)V": () => {},
    "isAccessible()Z": () => 1,
    "isSynthetic()Z": () => 0,
    "isVarArgs()Z": function (this: JCtor) { return (this.flags & 0x80) ? 1 : 0; },
    "getParameterTypes()[Ljava/lang/Class;": function (this: JCtor) { return paramClasses(this.desc, "Ljava/lang/Class;", this.owner.owner); },
    "getGenericParameterTypes()[Ljava/lang/reflect/Type;": function (this: JCtor) { return paramClasses(this.desc, "Ljava/lang/reflect/Type;", this.owner.owner); },
    "getParameterAnnotations()[[Ljava/lang/annotation/Annotation;": function (this: JCtor) { return paramAnnotations(this.owner, "<init>", this.desc); },
    "newInstance([Ljava/lang/Object;)Ljava/lang/Object;": async function (this: JCtor, args: unknown[] | null) {
      const info = this.owner;
      const p = rt.initClass(info); if (p) await p;
      const fn = info.ctor?.prototype?.[mangleMethod("<init>", this.desc)];
      if (typeof fn !== "function") throw rt.mkThrowable("java/lang/InstantiationException", info.name.replace(/\//g, ".") + ".<init>" + this.desc);
      const ps = parseMethodDesc(this.desc).params;
      const a = (args ?? []).map((v, i) => ("IJFDZBCS".includes(ps[i] ?? "L") ? unboxArg(v) : v));
      const o = new info.ctor();
      const r = fn.apply(o, a);
      if (r instanceof Promise) await r;
      return o;
    },
    "toString()Ljava/lang/String;": function (this: JCtor) { return this.owner.name + ".<init>" + this.desc; },
    "equals(Ljava/lang/Object;)Z": function (this: JCtor, o: unknown) {
      return o instanceof JCtor && o.owner === this.owner && o.desc === this.desc ? 1 : 0;
    },
    "hashCode()I": function (this: JCtor) { return stringHash(this.desc); },
  },
});

function classForDesc(desc: string, runtime: Runtime = rt): unknown {
  if (desc[0] === "L") return runtime.classFor(descToName(desc));
  if (desc[0] === "[") return runtime.classFor(desc);
  return runtime.classFor(PRIM_NAME[desc] ?? "int");
}
function paramClasses(desc: string, elem: string, runtime: Runtime = rt) { return jarray(parseMethodDesc(desc).params.map((d) => classForDesc(d, runtime)), elem); }
function noTypeVars() { return jarray([], "Ljava/lang/reflect/TypeVariable;"); }
export function unboxArg(v: unknown): unknown {
  // reflection passes boxed primitives; unwrap to raw for native/compiled calls
  if (v !== null && typeof v === "object" && "v" in (v as object)) return (v as { v: unknown }).v;
  return v;
}
export function boxReturn(retDesc: string, v: unknown): unknown {
  switch (retDesc[0]) {
    case "V": return null;
    case "I": case "B": case "S": return boxInt(v as number);
    case "J": return box(JLong, v as bigint);
    case "F": return box(JFloat, v as number);
    case "D": return box(JDouble, v as number);
    case "Z": return (JBool as any)[mangleStaticField(v ? "TRUE" : "FALSE")];
    case "C": return box(JChar, v as number);
    default:
      // native (TS) classes declare their fields as Object, so a primitive read through them must
      // still come back boxed — a bare JS number has no toString()/hashCode() for the caller
      if (typeof v === "number") return Number.isInteger(v) ? boxInt(v) : box(JDouble, v);
      if (typeof v === "bigint") return box(JLong, v);
      return v;
  }
}

// ── annotation instances: a JS object exposing element accessors as mangled methods
class JAnnotation extends JObj {
  anno!: EncAnnotation;
}
const annoProtoCache = new Map<string, object>();
function mkAnnotation(anno: EncAnnotation): JAnnotation {
  let info: ClassInfo;
  try { info = rt.link(anno.type); } catch { info = rt.link("java/lang/Object"); }
  const proto = buildAnnoProto(anno.type, info);
  const inst: JAnnotation = Object.create(proto);
  inst.anno = anno;
  installElements(inst, info, anno);
  return inst;
}
function installElements(target: object, info: ClassInfo, anno: EncAnnotation) {
  for (const [name, val] of Object.entries(anno.elements)) {
    const key = mangleMethod(name, elementDesc(info, name));
    const resolved = resolveEncVal(val, anno.dex);
    (target as any)[key] = () => resolved;
  }
}
function buildAnnoProto(type: string, info: ClassInfo): object {
  const cached = annoProtoCache.get(type);
  if (cached) return cached;
  // proto whose constructor.$i is the annotation interface, so R.iof / casts resolve
  const p: object = Object.create(JAnnotation.prototype);
  (p as any).constructor = { $i: info };
  (p as any)[mangleMethod("annotationType", "()Ljava/lang/Class;")] = () => rt.classFor(type);
  (p as any)[mangleMethod("toString", "()Ljava/lang/String;")] = () => "@" + type.replace(/\//g, ".");
  // elements a use site omits answer the type's declared defaults: dalvik/annotation/AnnotationDefault
  // on the annotation interface carries, as `value`, an annotation with one element per default.
  // On the shared proto so instances only override what they name.
  const d = classAnno(info).cls.find((a) => a.type === "dalvik/annotation/AnnotationDefault")?.elements.value;
  if (d && typeof d === "object" && !Array.isArray(d) && d.kind === "annotation") installElements(p, info, d.anno);
  annoProtoCache.set(type, p);
  return p;
}
/** find the return descriptor of annotation element `name` from the interface's abstract method */
function elementDesc(info: ClassInfo, name: string): string {
  if (info.def && info.dex) {
    for (const m of [...info.def.directMethods, ...info.def.virtualMethods]) {
      const mr = info.dex.method(m.methodIdx);
      if (mr.name === name) return info.dex.methodDesc(m.methodIdx);
    }
  } else {
    // native annotation type (Target, Retention, dalvik/annotation/Signature, ...): its
    // element methods aren't in any dex, but its NativeSpec still names the real descriptor.
    const spec = rt.natives.get(info.name);
    for (const key of Object.keys(spec?.methods ?? {})) {
      const paren = key.indexOf("(");
      if (key.slice(0, paren) === name) return key.slice(paren);
    }
  }
  return "()Ljava/lang/String;"; // common default
}
function resolveEncVal(v: EncVal, dex: DexFile): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveEncVal(x, dex));
  if (v !== null && typeof v === "object") {
    if (v.kind === "annotation") return mkAnnotation(v.anno);
    // an enum constant is a static of its class, which exists only once <clinit> has run;
    // compiled callers await a promise-valued element like any other call result
    if (v.kind === "enum") {
      const p = rt.initClass(rt.link(descToName(dex.type(dex.field(v.idx).cls))));
      if (p) return p.then(() => rt.encToJs(dex, v));
    }
  }
  return rt.encToJs(dex, v);
}

// ── core reflection marker interfaces: real classes (Method/Field/Class here, and any
// app-declared annotation type via its dex-listed `implements`) so `instanceof`/isInstance
// against them succeeds. Markers only — each concrete class supplies its own method bodies;
// these must be REGISTERED (not probed with rt.link first) because rt.link() on an unknown
// name auto-stubs it and files it as missing — there is nothing to "find" here, only to define.
for (const i of ["java/lang/annotation/Annotation", "java/lang/reflect/AnnotatedElement",
  "java/lang/reflect/Member", "java/lang/reflect/Type", "java/lang/reflect/GenericDeclaration"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
}

// ── ElementType / RetentionPolicy: real enums — app code references RetentionPolicy.RUNTIME
// etc directly, and a switch/compareTo needs real ordinals.
mkEnumSet("java/lang/annotation/ElementType", ["TYPE", "FIELD", "METHOD", "PARAMETER", "CONSTRUCTOR", "LOCAL_VARIABLE",
  "ANNOTATION_TYPE", "PACKAGE", "TYPE_PARAMETER", "TYPE_USE"]);
const retentionVals = mkEnumSet("java/lang/annotation/RetentionPolicy", ["SOURCE", "CLASS", "RUNTIME"]);

// ── meta-annotations (Target/Retention/Documented) and marker annotations (Deprecated/
// Override). Annotation INSTANCES are always built generically by mkAnnotation() from
// parsed DEX annotation data (never `new`-ed here) — these registrations exist so:
// (1) the type itself links instead of auto-stubbing, (2) it implements Annotation for
// instanceof, and (3) elementDesc's native fallback can find each element's real return
// descriptor when mkAnnotation installs the accessor.
rt.register({
  name: "java/lang/annotation/Target", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"],
  methods: {
    "value()[Ljava/lang/annotation/ElementType;": () => jarray([], "Ljava/lang/annotation/ElementType;"),
  },
});
rt.register({
  name: "java/lang/annotation/Retention", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"],
  methods: { "value()Ljava/lang/annotation/RetentionPolicy;": () => retentionVals[2] },
});
rt.register({ name: "java/lang/annotation/Documented", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"] });
rt.register({
  name: "java/lang/Deprecated", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"],
  methods: { "since()Ljava/lang/String;": () => "", "forRemoval()Z": () => 0 },
});
rt.register({ name: "java/lang/Override", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"] });

// ── dalvik.annotation.Signature: the compiler-generated generic-signature carrier.
// Pure data holder — value() is String[] fragments, which resolveEncVal already handles
// generically (array of strings), so no special-casing is needed beyond registering the type.
rt.register({
  name: "dalvik/annotation/Signature", ctor: class extends JObj {}, ifaces: ["java/lang/annotation/Annotation"],
  methods: {
    "value()[Ljava/lang/String;": () => jarray([], "Ljava/lang/String;"),
  },
});

// ── java.lang.Void: the boxed-void reference class. TYPE mirrors the Integer.TYPE /
// Boolean.TYPE pattern (jlang.ts) — a Class object for the primitive, not this class itself.
rt.register({ name: "java/lang/Void", ctor: class extends JObj {}, statics: { get TYPE() { return rt.classFor("void"); } } });

// Class.forName (and ClassLoader.loadClass, which delegates to it) is a by-NAME lookup,
// not a fixed dependency: the JVM contract is that the class may legitimately be absent
// and the caller must handle ClassNotFoundException. Probing for an optional component
// that way is a standard pattern, and the probe failing is the *correct* outcome — the
// caller then takes its own fallback path.
// Answering the lookup through rt.link() would auto-stub the name and file it in the
// missing-API queue as a framework API we owe an implementation for, which it is not:
// a name that is in no loaded dex and has no native is simply not a loadable class here,
// exactly as it would not be on a device that didn't ship it. So resolve the lookup
// against what is actually loadable and fail it ourselves, without linking.
function installForName(classCtor: unknown) {
  const loadable = (n: string) => {
    if (n[0] === "[") return true;            // array classes are synthesised by link()
    const linked = rt.classes.get(n);
    if (linked) return !linked.stub;
    return rt.natives.has(n) || rt.dexIndex.has(n);
  };
  const forName = async function (jn: string, initialize = 1, loader: unknown = null) {
    if (loader) {
      const c: JClass = await vcall(loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", jn);
      if (initialize && c.ci) await rt.initClass(c.ci);
      return c;
    }
    const name = jn.replace(/\./g, "/");
    if (!loadable(name)) {
      console.debug("[webdroid] Class.forName: no such class", jn);
      // link it first: an unlinked exception class has no own ClassInfo, so it inherits
      // its superclass's $i and `catch (ClassNotFoundException)` in compiled code — which
      // matches on ClassInfo.types — would not match the throwable we are about to make.
      rt.link("java/lang/ClassNotFoundException");
      throw rt.mkThrowable("java/lang/ClassNotFoundException", jn);
    }
    if (initialize) await linkInit(name);
    return rt.classFor(name);
  };
  const c = classCtor as Record<string, unknown>;
  c[mangleMethod("forName", "(Ljava/lang/String;)Ljava/lang/Class;")] = forName;
  c[mangleMethod("forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;")] = forName;
}

// wire Class.getMethods / getDeclaredMethods to real Method objects
export function installClassReflection() {
  const info = rt.link("java/lang/Class");
  const proto = info.ctor.prototype as Record<string, unknown>;
  installForName(info.ctor);
  const M: Record<string, unknown> = {};
  M["getMethods()[Ljava/lang/reflect/Method;"] = function (this: JClass) {
    return jarray(this.ci ? classMethods(this.ci, false) : [], "Ljava/lang/reflect/Method;");
  };
  M["getGenericSuperclass()Ljava/lang/reflect/Type;"] = function (this: JClass) {
    const ci = this.ci;
    const sup = ci?.superInfo;
    if (!sup) return null;
    // dalvik.annotation.Signature carries the generic class signature
    const sig = ci!.def ? classAnno(ci!).cls.find((a) => a.type === "dalvik/annotation/Signature") : undefined;
    if (sig) {
      const parts = sig.elements["value"];
      const s = Array.isArray(parts) ? parts.join("") : String(parts ?? "");
      let pos = 0;
      if (s[0] === "<") { let d = 0; while (pos < s.length) { if (s[pos] === "<") d++; else if (s[pos] === ">") d--; pos++; if (!d) break; } }
      const t = parseTypeSig(s, { pos });
      if (t instanceof JPType) return t;
    }
    return (sup.owner ?? rt).classFor(sup.name);
  };
  M["getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;"] = function (this: JClass, path: string) {
    // a relative name resolves against the class's own package
    const pkg = (this.ci?.name ?? "").split("/").slice(0, -1).join("/");
    return classpathStream(path.startsWith("/") ? path.slice(1) : (pkg ? pkg + "/" : "") + path, this.ci?.owner);
  };
  M["getEnclosingMethod()Ljava/lang/reflect/Method;"] = () => null;
  M["getPackage()Ljava/lang/Package;"] = function (this: JClass) {
    const info = rt.link("java/lang/Package");
    const p = new info.ctor() as any;
    const n = this.ci?.name ?? "";
    p.pname = n.includes("/") ? n.slice(0, n.lastIndexOf("/")).replace(/\//g, ".") : "";
    return p;
  };
  M["getTypeParameters()[Ljava/lang/reflect/TypeVariable;"] = noTypeVars;
  M["getEnumConstants()[Ljava/lang/Object;"] = async function (this: JClass) {
    const info = this.ci;
    if (!info) return null;
    const p = rt.initClass(info); if (p) await p;
    try { return await vcall(info.ctor, "values", `()[L${info.name};`); } catch { return null; }
  };
  M["getDeclaringClass()Ljava/lang/Class;"] = function (this: JClass) {
    const i = this.ci?.name?.lastIndexOf("$") ?? -1;
    return i > 0 ? rt.classFor(this.ci!.name.slice(0, i)) : null;
  };
  M["getEnclosingConstructor()Ljava/lang/reflect/Constructor;"] = () => null;
  M["getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;"] = function (this: JClass, name: string) {
    const f = this.ci ? classFields(this.ci, name) : [];
    if (!f.length) throw rt.mkThrowable("java/lang/NoSuchFieldException", name);
    return f[0];
  };
  M["getField(Ljava/lang/String;)Ljava/lang/reflect/Field;"] = function (this: JClass, name: string) {
    for (let ci = this.ci; ci; ci = ci.superInfo) {
      const f = classFields(ci, name);
      if (f.length) return f[0];
    }
    throw rt.mkThrowable("java/lang/NoSuchFieldException", name);
  };
  M["getDeclaredFields()[Ljava/lang/reflect/Field;"] = function (this: JClass) {
    return jarray(this.ci ? classFields(this.ci) : [], "Ljava/lang/reflect/Field;");
  };
  M["getFields()[Ljava/lang/reflect/Field;"] = function (this: JClass) {
    const a: JField[] = [];
    for (let ci = this.ci; ci; ci = ci.superInfo) a.push(...classFields(ci));
    return jarray(a, "Ljava/lang/reflect/Field;");
  };
  const ctorsOf = (c: JClass) => jarray(c.ci ? classCtors(c.ci).slice() : [], "Ljava/lang/reflect/Constructor;");
  M["getConstructors()[Ljava/lang/reflect/Constructor;"] = function (this: JClass) { return ctorsOf(this); };
  M["getDeclaredConstructors()[Ljava/lang/reflect/Constructor;"] = function (this: JClass) { return ctorsOf(this); };
  M["getConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;"] = function (this: JClass, params: JClass[]) {
    const want = (params ?? []).map(classDesc).join("");
    const c = (this.ci ? classCtors(this.ci) : []).find((x) => parseMethodDesc(x.desc).params.join("") === want);
    if (!c) throw rt.mkThrowable("java/lang/NoSuchMethodException", (this.ci?.name ?? "?").replace(/\//g, ".") + ".<init>(" + want + ")");
    return c;
  };
  M["getDeclaredConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;"] =
    M["getConstructor([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;"];
  // real inner-class metadata lives in the dalvik.annotation.InnerClass system
  // annotation (accessFlags there carries STATIC, unlike class_def flags)
  const innerAnno = (ci: ClassInfo | null | undefined) =>
    ci?.def ? classAnno(ci).cls.find((x) => x.type === "dalvik/annotation/InnerClass") : undefined;
  M["getModifiers()I"] = function (this: JClass) {
    const ic = innerAnno(this.ci);
    const f = ic?.elements["accessFlags"];
    if (typeof f === "number") return f;
    return this.ci?.def?.flags ?? 1;
  };
  M["isMemberClass()Z"] = function (this: JClass) {
    const ic = innerAnno(this.ci);
    return ic && ic.elements["name"] != null ? 1 : 0;
  };
  M["getDeclaredMethods()[Ljava/lang/reflect/Method;"] = function (this: JClass) {
    return jarray(this.ci ? classMethods(this.ci, true) : [], "Ljava/lang/reflect/Method;");
  };
  M["getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;"] = function (this: JClass, name: string, params: JClass[]) {
    const wantParams = (params ?? []).map((c) => classDesc(c));
    const all = this.ci ? classMethods(this.ci, false) : [];
    const m = all.find((mm) => mm.name === name && parseMethodDesc(mm.desc).params.join("") === wantParams.join(""));
    if (!m) throw rt.mkThrowable("java/lang/NoSuchMethodException", name);
    return m;
  };
  M["getDeclaredMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;"] =
    M["getMethod(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;"];
  M["getAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;"] = function (this: JClass, cls: JClass) {
    if (!this.ci) return null;
    const found = classAnno(this.ci).cls.find((an) => an.type === cls?.ci?.name);
    return found ? mkAnnotation(found) : null;
  };
  M["isAnnotationPresent(Ljava/lang/Class;)Z"] = function (this: JClass, cls: JClass) {
    if (!this.ci) return 0;
    return classAnno(this.ci).cls.some((an) => an.type === cls?.ci?.name) ? 1 : 0;
  };
  M["getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;"] = function (this: JClass) {
    return jarray(this.ci ? classAnno(this.ci).cls.map(mkAnnotation) : [], "Ljava/lang/annotation/Annotation;");
  };
  // attach with proper mangled keys onto the live prototype
  for (const [sig, fn] of Object.entries(M)) {
    const paren = sig.indexOf("(");
    proto[mangleMethod(sig.slice(0, paren), sig.slice(paren))] = fn;
  }
}
function classDesc(c: JClass): string {
  if (c?.primName) return PRIM_DESC[c.primName] ?? "I";
  if (c?.arrDesc) return c.arrDesc;
  return c?.ci ? "L" + c.ci.name + ";" : "Ljava/lang/Object;";
}
// ensure Method + annotation marker interfaces are linked so prototypes carry native methods
rt.link("java/lang/reflect/Method");
rt.link("java/lang/reflect/Constructor");
installClassReflection();

rt.register({
  name: "java/lang/Package", ctor: class extends JObj { pname = ""; },
  methods: { "getName()Ljava/lang/String;": function (this: any) { return this.pname; } },
});

// ── java.lang.reflect.Proxy: one synthetic class per interface set. Every interface method, and
// Object's equals/hashCode/toString which Java routes the same way, boxes its arguments into the
// InvocationHandler and unboxes what comes back.
rt.register({ name: "java/lang/reflect/InvocationHandler", ctor: class extends JObj {} });
class JProxy extends JObj { h: unknown = null; }
const proxyClasses = new Map<string, ClassInfo>();
const D_INVOKE = "(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;";
type Decl = [ClassInfo, string, string, number];
/** framework.jar's class defs by name, fetched once a proxy needs a marker interface's declaration */
let declIndex: Map<string, [DexFile, number]> | null = null;
async function ensureDecls(): Promise<void> {
  if (declIndex) return;
  const { frameworkDecls } = await import("../../android/framework");
  const idx = new Map<string, [DexFile, number]>();
  for (const dex of await frameworkDecls()) for (let i = 0; i < dex.classDefCount; i++) idx.set(descToName(dex.type(dex.classDef2Type(i))), [dex, i]);
  declIndex = idx;
}
/** what an interface declares, as the proxy sees it: bytecode when there is any, else the
 *  hand-written spec plus the app's own references plus AOSP's declaration of the same name */
function interfaceMethods(ci: ClassInfo, out: Map<string, Decl>): void {
  if (ci.def && ci.dex) {
    for (const m of ci.def.virtualMethods) { const n = ci.dex.method(m.methodIdx).name, d = ci.dex.methodDesc(m.methodIdx); out.set(n + d, [ci, n, d, m.flags]); }
    for (const i of ci.interfaces) interfaceMethods(i, out);
    return;
  }
  for (const k of Object.keys(rt.natives.get(ci.name)?.methods ?? {})) if (!k.startsWith("static ")) { const p = k.indexOf("("); out.set(k, [ci, k.slice(0, p), k.slice(p), 0x401]); }
  for (const [k, d] of rt.methodRefs(ci.name)) out.set(k, [ci, k.slice(0, k.length - d.length), d, 0x401]);
  const loc = declIndex?.get(ci.name);
  if (loc) {
    const [dex, i] = loc, def = dex.classDef(i);
    for (const m of def.virtualMethods) { const n = dex.method(m.methodIdx).name, d = dex.methodDesc(m.methodIdx); out.set(n + d, [ci, n, d, m.flags]); }
    for (const t of def.interfaces) interfaceMethods(rt.link(descToName(dex.type(t))), out);
  }
  for (const i of ci.interfaces) interfaceMethods(i, out);
}
function proxyMethod(info: ClassInfo, owner: ClassInfo, n: string, desc: string, mods: number): (...a: unknown[]) => unknown {
  const { params, ret } = parseMethodDesc(desc), method = mkMethod(owner, n, desc, false, () => null, mods);
  const fn = async function (this: JProxy, ...args: unknown[]) {
    const r = await vcall(this.h, "invoke", D_INVOKE, this, method, jarray(args.map((a, i) => boxReturn(params[i], a)), "Ljava/lang/Object;"));
    return ret === "V" ? undefined : ret[0] === "L" || ret[0] === "[" ? r : unboxArg(r);
  };
  info.ctor.prototype[mangleMethod(n, desc)] = fn;
  return fn;
}
const proxyIfaces = new WeakMap<ClassInfo, ClassInfo[]>();
async function proxyClass(ifaces: ClassInfo[]): Promise<ClassInfo> {
  const key = ifaces.map((i) => i.name).join(";");
  let info = proxyClasses.get(key);
  if (info) return info;
  if (ifaces.some((i) => !i.dex)) await ensureDecls();
  const name = "java/lang/reflect/$Proxy" + proxyClasses.size;
  rt.register({ name, ctor: class extends JProxy {}, ifaces: ifaces.map((i) => i.name) });
  info = rt.link(name);
  proxyIfaces.set(info, ifaces);
  const methods = new Map<string, Decl>();
  const object = rt.link("java/lang/Object");
  for (const [n, d] of [["equals", "(Ljava/lang/Object;)Z"], ["hashCode", "()I"], ["toString", "()Ljava/lang/String;"]]) methods.set(n + d, [object, n, d, 0x1]);
  for (const i of ifaces) interfaceMethods(i, methods);
  for (const [owner, n, desc, mods] of methods.values()) proxyMethod(info, owner, n, desc, mods);
  proxyClasses.set(key, info);
  return info;
}
// a method no declaration named: the first call names it, and the proxy materialises it then,
// owned by the interface that declares it if any of them does, else the first
rt.proxyMethod = (obj, n, desc) => {
  if (!(obj instanceof JProxy)) return null;
  const info = (obj.constructor as { $i?: ClassInfo }).$i ?? rt.link(clsNameOf(obj));
  const ifaces = proxyIfaces.get(info) ?? [];
  if (!ifaces.length) return null;
  const owner = ifaces.find((i) => { const m = new Map<string, Decl>(); interfaceMethods(i, m); return m.has(n + desc); }) ?? ifaces[0];
  return proxyMethod(info, owner, n, desc, 0x401);
};
const clsNameOf = (o: object): string => (o.constructor as { $i?: ClassInfo }).$i?.name ?? "java/lang/Object";
lateMethod.find = (o, n, d) => (rt.proxyMethod!(o, n, d) ?? undefined) as ((...a: unknown[]) => unknown) | undefined;
rt.register({
  name: "java/lang/reflect/Proxy", ctor: JProxy,
  methods: {
    "static newProxyInstance(Ljava/lang/ClassLoader;[Ljava/lang/Class;Ljava/lang/reflect/InvocationHandler;)Ljava/lang/Object;": async (_l: unknown, ifaces: JClass[], h: unknown) => {
      const p = new ((await proxyClass(ifaces.map((c) => c.ci!))).ctor)() as JProxy;
      p.h = h;
      return p;
    },
    "static getProxyClass(Ljava/lang/ClassLoader;[Ljava/lang/Class;)Ljava/lang/Class;": async (_l: unknown, ifaces: JClass[]) => rt.classFor((await proxyClass(ifaces.map((c) => c.ci!))).name),
    "static isProxyClass(Ljava/lang/Class;)Z": (c: JClass) => (c.ci?.ctor.prototype instanceof JProxy ? 1 : 0),
    "static getInvocationHandler(Ljava/lang/Object;)Ljava/lang/reflect/InvocationHandler;": (o: unknown) => (o instanceof JProxy ? o.h : null),
  },
});
