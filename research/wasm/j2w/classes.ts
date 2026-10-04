// java.lang.Class objects, array classes, class-initialization failure and declared-field reflection.
//
// A class's identity is its id (World.idOf, vt[H.ID]). Its Class object is an ordinary instance of the program's own java.lang.Class,
// made on first use by the runtime function classOf and cached by id in the table `ctab`. mkClass fills the fields ART fills (accessFlags,
// primitiveType, superClass, componentType, ifTable as interface/null pairs, dexTypeIndex carrying the id) from what the host knows
// (hostInfo); Class's own bytecode (isAssignableFrom, isInstance, getComponentType, getClassLoader, ...) then runs unchanged.
// Reference arrays share one wrapper type, so their class and covariance live in the header vt and the Class objects.
// Anything that needs a struct type per class (allocation by Class.newInstance, Object.clone, arrays by component class) asks the
// host for the slot of a generated function for that class.
import { OP } from "./code";
import { T, refNull } from "./wasmbin";
import { H, type ElemKind } from "./consts";
import { ACC, type JClass } from "./program";
import { rt } from "./rtfns";
import type { Code } from "./code";
import type { Compiler, Intrinsic } from "./j2w";
import type { World } from "./lazy";
import { hostUnsafe, UInfo } from "./unsafe";
import { hostReflect, RInfo } from "./reflect";

const CLASS = "java/lang/Class", OBJ_ARRAY = "[Ljava/lang/Object;", FIELD = "java/lang/reflect/Field", FIELD_ARRAY = "[Ljava/lang/reflect/Field;";
const CLONEABLE = ["java/lang/Cloneable", "java/io/Serializable"];
/** primitive descriptor -> [ART Primitive::Type, log2 size, Java name] */
const PRIM: Record<string, [number, number, string]> = { Z: [1, 0, "boolean"], B: [2, 0, "byte"], C: [3, 1, "char"], S: [4, 1, "short"], I: [5, 2, "int"],
  J: [6, 3, "long"], F: [7, 2, "float"], D: [8, 3, "double"], V: [9, 0, "void"] };
const KINDS: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
const isPrim = (n: string) => n in PRIM;
const typeName = (d: string) => d[0] === "L" ? d.slice(1, -1) : d;
const descOf = (name: string) => isPrim(name) || name[0] === "[" ? name : `L${name};`;
const javaName = (n: string) => isPrim(n) ? PRIM[n][2] : n.replace(/\//g, ".");
/** access flags in a class's dalvik.annotation.InnerClass annotation, -1 for a class without one */
const innerFlags = (jc: JClass | undefined): number => {
  const a = jc?.def && jc.dex!.classAnnotations(jc.def).cls.find((x) => x.type === "Ldalvik/annotation/InnerClass;")?.elements.accessFlags;
  return typeof a === "number" ? a : -1;
};

// ---------- what the host answers (host.info(kind, a, b); a is a class id)
const enum Info { Flags, Primitive, Super, Component, NIfaces, Iface, Inner, NameLen, NameChar, NFields, FieldNameLen, FieldNameChar, FieldType, FieldFlags, AllocSlot, CloneSlot, ArraySlot }
const ifaceCache = new WeakMap<World, Map<string, string[]>>();
function interfaces(w: World, name: string): string[] {
  let m = ifaceCache.get(w); if (!m) ifaceCache.set(w, m = new Map());
  let l = m.get(name);
  if (!l) {
    const out = new Set<string>(), add = (i: string) => { if (!out.has(i)) { out.add(i); w.prog.get(i)?.ifaces.forEach(add); } };
    if (name[0] === "[") CLONEABLE.forEach(add); else for (let k = w.prog.get(name); k; k = k.sup ? w.prog.get(k.sup) : undefined) k.ifaces.forEach(add);
    m.set(name, l = [...out]);
  }
  return l;
}
export function hostInfo(w: World, kind: number, a: number, b: number): number {
  if (kind >= RInfo.MethodCount) return hostReflect(w, kind, a, b);
  if (kind >= UInfo.FieldGet) return hostUnsafe(w, kind, a, b);
  const name = w.nameOf(a), jc = w.prog.get(name), arr = name[0] === "[", fields = jc?.def ? jc.fields : [];
  switch (kind as Info) {
    case Info.Flags: return isPrim(name) || arr ? ACC.PUBLIC | ACC.FINAL | ACC.ABSTRACT : jc?.flags ?? ACC.PUBLIC;
    case Info.Primitive: return isPrim(name) ? PRIM[name][0] | PRIM[name][1] << 16 : 0;
    case Info.Super: return arr || jc?.isInterface ? w.idOf("java/lang/Object") : jc?.sup ? w.idOf(jc.sup) : 0;
    case Info.Component: return arr ? w.idOf(typeName(name.slice(1))) : 0;
    case Info.NIfaces: return interfaces(w, name).length;
    case Info.Iface: return w.idOf(interfaces(w, name)[b]);
    case Info.Inner: return innerFlags(jc);
    case Info.NameLen: return javaName(name).length;
    case Info.NameChar: return javaName(name).charCodeAt(b);
    case Info.NFields: return fields.length;
    case Info.FieldNameLen: return fields[b].name.length;
    case Info.FieldNameChar: return fields[b >> 16].name.charCodeAt(b & 0xffff);
    case Info.FieldType: return w.idOf(typeName(fields[b].desc));
    case Info.FieldFlags: return fields[b].flags;
    case Info.AllocSlot: {
      const ctor = jc?.byKey.get("<init>()V");
      if (!jc || jc.isInterface || jc.flags & ACC.ABSTRACT || !ctor) return 0;
      return w.synthSlot("new:" + name, { params: [], ret: "L", body: (cx, c) => {
        const o = c.newLocal(cx.vtOf("L"));
        cx.emitEnsure(c, name); cx.emitNew(c, name); c.lset(o).lget(o); cx.callMethod(c, ctor); c.lget(o);
      } });
    }
    case Info.CloneSlot: {
      if (!jc || jc.isInterface || jc.flags & ACC.ABSTRACT) return 0;
      return w.synthSlot("clone:" + name, { params: ["L"], ret: "L", body: (cx, c) => {
        const st = cx.structFor(name), src = c.newLocal(refNull(st)), o = c.newLocal(refNull(st));
        c.lget(0).refCast(st).lset(src); cx.emitNew(c, name); c.lset(o);
        cx.prog.layout(name).forEach((_, i) => c.lget(o).lget(src).structGet(st, i + 2).structSet(st, i + 2));
        c.lget(o);
      } });
    }
    case Info.ArraySlot: {           // a = the component class: the array allocator for it
      const arrName = "[" + descOf(name);
      return w.synthSlot("newarray:" + arrName, { params: ["I"], ret: "L", body: (cx, c) => cx.emitNewArray(c, arrName, () => c.lget(0)) });
    }
  }
}

// ---------- the pieces compiled code calls
export const constClass = (cx: Compiler, c: Code, name: string): void => { c.i32(cx.idOf(name)); cx.callRt(c, "classOf"); };
/** before storing the value pushed by `value` into the reference array wrapper in local `arr`: ArrayStoreException when it does not fit */
export function emitStoreCheck(cx: Compiler, c: Code, arr: number, value: () => void): void {
  c.lget(arr); vtId(cx, c); c.i32(cx.idOf(OBJ_ARRAY)).raw(OP.i32_ne).if_().lget(arr); value(); cx.callRt(c, "astore"); c.end();
}
/** in System.arraycopy's reference-array case (src, sp, dst, dp, n are locals 0..4, bounds checked): a copy with store checks unless dst takes src's elements anyway */
export function emitRefCopy(cx: Compiler, c: Code): void {
  const id = (l: number) => { c.lget(l); return vtId(cx, c); };
  id(0); id(2); c.raw(OP.i32_ne); id(2).i32(cx.idOf(OBJ_ARRAY)).raw(OP.i32_ne).raw(OP.i32_and);
  c.if_().lget(0).lget(1).lget(2).lget(3).lget(4); cx.callRt(c, "acopy"); c.ret().end();
}

const isAssignableFrom = (cx: Compiler, c: Code) => cx.callMethod(c, cx.prog.resolve(CLASS, "isAssignableFrom", "(Ljava/lang/Class;)Z")!);
export const classMethod = (cx: Compiler, c: Code, cls: string, name: string, desc: string) => cx.callMethod(c, cx.prog.resolve(cls, name, desc)!);
/** the class id of the (anyref) object on the stack: a String has no header, the helper answers for it */
const vtId = (cx: Compiler, c: Code) => c.call(cx.helper("vtab")).i32(H.ID).arrayGet(cx.tVT);
const field = (cx: Compiler, name: string, d: string) => cx.fieldIndex(CLASS, { owner: CLASS, name, desc: d });

// classOf(id): the cached Class object; the table grows to hold the id
rt("classOf", ["I"], "L", (cx, c) => {
  const { tData } = cx, g = cx.ctab(), tab = c.newLocal(refNull(tData.ref)), o = c.newLocal(cx.vtOf("L")), n = c.newLocal(T.i32);
  c.gget(g).lset(tab).lget(tab).refAsNonNull().arrayLen().lset(n);
  c.lget(0).lget(n).raw(OP.i32_ge_s).if_();
  c.lget(0).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_shl).lget(0).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_shl).raw(OP.i32_gt_s).raw(0x1b).arrayNewDefault(tData.ref).lset(tab);
  c.lget(tab).refAsNonNull().i32(0).gget(g).refAsNonNull().i32(0).lget(n).arrayCopy(tData.ref, tData.ref).lget(tab).gset(g).end();
  c.gget(g).refAsNonNull().lget(0).arrayGet(tData.ref).ltee(o).refIsNull().if_().lget(0); cx.callRt(c, "mkClass"); c.ret().end().lget(o);
});
// mkClass(id): allocate, cache before linking (supers and interfaces may refer back), then fill from the host's answers
rt("mkClass", ["I"], "L", (cx, c) => {
  const { tData, tArr } = cx, cs = cx.structFor(CLASS), g = cx.ctab();
  const o = c.newLocal(cx.vtOf("L")), k = c.newLocal(refNull(cs)), n = c.newLocal(T.i32), i = c.newLocal(T.i32), data = c.newLocal(refNull(tData.ref));
  cx.emitNew(c, CLASS); c.lset(o);
  c.gget(g).refAsNonNull().lget(0).lget(o).arraySet(tData.ref);
  c.lget(o).refCast(cs).lset(k);
  const info = (kind: number, b?: () => void) => cx.info(c, kind, () => c.lget(0), b);
  const set = (name: string, d: string, v: () => void) => { c.lget(k); v(); c.structSet(cs, field(cx, name, d)); };
  set("accessFlags", "I", () => info(Info.Flags)); set("primitiveType", "I", () => info(Info.Primitive)); set("dexTypeIndex", "I", () => c.lget(0));
  for (const [name, kind] of [["superClass", Info.Super], ["componentType", Info.Component]] as const) {
    info(kind).if_(); set(name, "Ljava/lang/Class;", () => { info(kind); cx.callRt(c, "classOf"); }); c.end();
  }
  info(Info.NIfaces).ltee(n).if_();
  c.lget(n).i32(1).raw(OP.i32_shl).arrayNewDefault(tData.ref).lset(data);
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(data).refAsNonNull().lget(i).i32(1).raw(OP.i32_shl); info(Info.Iface, () => c.lget(i)); cx.callRt(c, "classOf"); c.arraySet(tData.ref);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  set("ifTable", "[Ljava/lang/Object;", () => c.gget(cx.vtGlobal(OBJ_ARRAY)).refAsNonNull().i32(0).lget(data).refAsNonNull().structNew(tArr.ref));
  c.end().lget(o);
});
// instArr(obj, id): obj is a reference array assignable to array class `id`; Object[] takes every reference array, the rest is
// Class.isAssignableFrom over the Class objects
rt("instArr", ["L", "I"], "I", (cx, c) => {
  const s = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_().i32(0).ret().end();
  c.lget(0).refTest(cx.tArr.ref).raw(OP.i32_eqz).if_().i32(0).ret().end();
  c.lget(0).refAsNonNull(); vtId(cx, c); c.lset(s);
  c.lget(s).lget(1).raw(OP.i32_eq).lget(1).i32(cx.idOf(OBJ_ARRAY)).raw(OP.i32_eq).raw(OP.i32_or).if_().i32(1).ret().end();
  c.lget(1); cx.callRt(c, "classOf"); c.lget(s); cx.callRt(c, "classOf"); isAssignableFrom(cx, c);
});
// astore(array, value): ArrayStoreException unless value's class is assignable to the array's component class
rt("astore", ["L", "L"], "V", (cx, c) => {
  const w = c.newLocal(T.i32), e = c.newLocal(T.i32), v = c.newLocal(T.i32);
  c.lget(1).refIsNull().if_().ret().end();
  c.lget(0).refAsNonNull(); vtId(cx, c); c.lset(w);
  cx.info(c, Info.Component, () => c.lget(w)); c.lset(e);
  c.lget(1).refAsNonNull(); vtId(cx, c); c.lset(v);
  c.lget(v).lget(e).raw(OP.i32_eq).if_().ret().end();
  c.lget(e); cx.callRt(c, "classOf"); c.lget(v); cx.callRt(c, "classOf"); isAssignableFrom(cx, c);
  c.raw(OP.i32_eqz).if_().lget(v).lget(w); cx.callThrower(c, "asx"); c.end();
});
// acopy(src, sp, dst, dp, n): element-wise copy between reference arrays of different classes; an element dst cannot hold throws
// ArrayStoreException after the elements before it have been copied (System.arraycopy)
rt("acopy", ["L", "I", "L", "I", "I"], "V", (cx, c) => {
  const { tArr, tData } = cx, i = c.newLocal(T.i32), v = c.newLocal(cx.vtOf("L")), sd = c.newLocal(refNull(tData.ref)), dd = c.newLocal(refNull(tData.ref));
  c.lget(0).refCast(tArr.ref).structGet(tArr.ref, 2).lset(sd).lget(2).refCast(tArr.ref).structGet(tArr.ref, 2).lset(dd);
  c.block().loop().lget(i).lget(4).raw(OP.i32_ge_s).brIf(1);
  c.lget(sd).refAsNonNull().lget(1).lget(i).raw(OP.i32_add).arrayGet(tData.ref).lset(v);
  c.lget(2).lget(v); cx.callRt(c, "astore");
  c.lget(dd).refAsNonNull().lget(3).lget(i).raw(OP.i32_add).lget(v).arraySet(tData.ref);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
});
// aclone(obj): a copy of an array with the same class, null for anything else
rt("aclone", ["L"], "L", (cx, c) => {
  for (const k of KINDS) {
    const t = cx.tArr[k], d = cx.tData[k], a = c.newLocal(refNull(t)), src = c.newLocal(refNull(d)), dst = c.newLocal(refNull(d)), n = c.newLocal(T.i32);
    c.lget(0).refTest(t).if_();
    c.lget(0).refCast(t).lset(a).lget(a).structGet(t, 2).lset(src).lget(src).refAsNonNull().arrayLen().lset(n).lget(n).arrayNewDefault(d).lset(dst);
    c.lget(dst).refAsNonNull().i32(0).lget(src).refAsNonNull().i32(0).lget(n).arrayCopy(d, d);
    c.lget(a).structGet(t, 0).i32(0).lget(dst).refAsNonNull().structNew(t).ret().end();
  }
  c.anyNull();
});

// ---------- class initialization (the state machine is World.ensureBody)
rt("initErroneous", ["I"], "V", (cx, c) => { c.lget(0); cx.callThrower(c, "ncdfe"); });
rt("initWait", ["I"], "V", (cx, c) => cx.gap(c, "class initialization owned by another thread: needs the thread scheduler"));
// initFail(e): <clinit> threw e. An Error propagates as it is; anything else is wrapped in ExceptionInInitializerError, which here only
// stores the cause (ART's constructor also fills in the stack trace)
rt("initFail", ["L"], "V", (cx, c) => {
  const err = "java/lang/Error", eiie = "java/lang/ExceptionInInitializerError", w = c.newLocal(cx.vtOf("L")), st = cx.structFor(eiie);
  c.lget(0).i32(cx.idOf(err)).i32(cx.prog.chain(err).length - 1).call(cx.helper("iof")).if_().lget(0).throw_(cx.tag).end();
  cx.emitNew(c, eiie); c.lset(w);
  if (cx.prog.get(eiie)?.dex) c.lget(w).refCast(st).lget(0).structSet(st, cx.fieldIndex(eiie, { owner: "java/lang/Throwable", name: "cause", desc: "Ljava/lang/Throwable;" }));
  c.lget(w).throw_(cx.tag);
});

// ---------- reflection on declared fields: Field objects carry the field id (class id << 12 | index) in artFieldIndex and offset
rt("mkField", ["I", "I"], "L", (cx, c) => {
  const fs = cx.structFor(FIELD), f = c.newLocal(cx.vtOf("L")), o = c.newLocal(refNull(fs)), id = c.newLocal(T.i32);
  const fi = (name: string, d: string) => cx.fieldIndex(FIELD, { owner: FIELD, name, desc: d });
  const info = (kind: number) => cx.info(c, kind, () => c.lget(0), () => c.lget(1));
  cx.emitNew(c, FIELD); c.lset(f).lget(f).refCast(fs).lset(o);
  c.lget(0).i32(12).raw(OP.i32_shl).lget(1).raw(OP.i32_or).lset(id);
  c.lget(o).lget(0); cx.callRt(c, "classOf"); c.structSet(fs, fi("declaringClass", "Ljava/lang/Class;"));
  c.lget(o); info(Info.FieldType); cx.callRt(c, "classOf"); c.structSet(fs, fi("type", "Ljava/lang/Class;"));
  c.lget(o); info(Info.FieldFlags); c.structSet(fs, fi("accessFlags", "I"));
  c.lget(o).lget(id).structSet(fs, fi("artFieldIndex", "I")).lget(o).lget(id).structSet(fs, fi("offset", "I"));
  c.lget(f);
});
// declFields(cid, publicOnly): Field[] of the class's declared fields
rt("declFields", ["I", "I"], "L", (cx, c) => {
  const { tArr, tData } = cx, n = c.newLocal(T.i32), k = c.newLocal(T.i32), count = c.newLocal(T.i32), i = c.newLocal(T.i32), data = c.newLocal(refNull(tData.ref));
  const keep = () => { c.lget(1).raw(OP.i32_eqz); cx.info(c, Info.FieldFlags, () => c.lget(0), () => c.lget(k)); c.i32(ACC.PUBLIC).raw(OP.i32_and).raw(OP.i32_or); };
  const each = (body: () => void) => {
    c.i32(0).lset(k).block().loop().lget(k).lget(n).raw(OP.i32_ge_s).brIf(1); body();
    c.lget(k).i32(1).raw(OP.i32_add).lset(k).br(0).end().end();
  };
  cx.info(c, Info.NFields, () => c.lget(0)); c.lset(n);
  each(() => { keep(); c.if_().lget(count).i32(1).raw(OP.i32_add).lset(count).end(); });
  c.lget(count).arrayNewDefault(tData.ref).lset(data);
  each(() => { keep(); c.if_().lget(data).refAsNonNull().lget(i).lget(0).lget(k); cx.callRt(c, "mkField"); c.arraySet(tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).end(); });
  c.gget(cx.vtGlobal(FIELD_ARRAY)).refAsNonNull().i32(0).lget(data).refAsNonNull().structNew(tArr.ref);
});
// nameEq(cid, k, name, len): the String `name` of length `len` spells the name of the k-th declared field of class cid
rt("nameEq", ["I", "I", "L", "I"], "I", (cx, c) => {
  const j = c.newLocal(T.i32);
  c.block().loop().lget(j).lget(3).raw(OP.i32_ge_s).brIf(1);
  c.lget(2).lget(j); classMethod(cx, c, "java/lang/String", "charAt", "(I)C");
  cx.info(c, Info.FieldNameChar, () => c.lget(0), () => c.lget(1).i32(16).raw(OP.i32_shl).lget(j).raw(OP.i32_or));
  c.raw(OP.i32_ne).if_().i32(0).ret().end();
  c.lget(j).i32(1).raw(OP.i32_add).lset(j).br(0).end().end().i32(1);
});

// ---------- intrinsics
/** the intrinsics of this file, added to the table by intrinsics.ts */
export const classIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => classIntrinsics.set(key, (cx, m, c) => f(cx, c));
export const idOfClass = (cx: Compiler, c: Code) => { const cs = cx.structFor(CLASS); c.refCast(cs).structGet(cs, field(cx, "dexTypeIndex", "I")); };
/** a char[] of `len` characters, `char(j)` pushing character j, handed to StringFactory.newStringFromChars */
export function emitString(cx: Compiler, c: Code, len: () => void, char: (j: number) => void): void {
  const w = c.newLocal(refNull(cx.tArr.i16)), data = c.newLocal(refNull(cx.tData.i16)), n = c.newLocal(T.i32), j = c.newLocal(T.i32);
  len(); c.lset(n);
  cx.emitNewArray(c, "[C", () => c.lget(n)); c.lset(w).lget(w).structGet(cx.tArr.i16, 2).lset(data);
  c.block().loop().lget(j).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(data).refAsNonNull().lget(j); char(j); c.arraySet(cx.tData.i16).lget(j).i32(1).raw(OP.i32_add).lset(j).br(0).end().end();
  c.lget(w); classMethod(cx, c, "java/lang/StringFactory", "newStringFromChars", "([C)Ljava/lang/String;");
}

def("java/lang/Object.getClass()Ljava/lang/Class;", (cx, c) => { c.lget(0); vtId(cx, c); cx.callRt(c, "classOf"); });

def("java/lang/Class.getNameNative()Ljava/lang/String;", (cx, c) => {
  const id = c.newLocal(T.i32);
  c.lget(0); idOfClass(cx, c); c.lset(id);
  emitString(cx, c, () => cx.info(c, Info.NameLen, () => c.lget(id)), (j) => cx.info(c, Info.NameChar, () => c.lget(id), () => c.lget(j)));
});

// Class.getInnerClassFlags(default): the InnerClass annotation's flags, else `default`
def("java/lang/Class.getInnerClassFlags(I)I", (cx, c) => {
  const f = c.newLocal(T.i32);
  c.lget(0); idOfClass(cx, c); c.lset(f);
  cx.info(c, Info.Inner, () => c.lget(f)); c.ltee(f).i32(0).raw(OP.i32_lt_s).if_(T.i32).lget(1).else_().lget(f).end();
});

// Class.getPrimitiveClass(name): the class whose Java name is `name`, matched on length and first character (unique among the nine)
def("java/lang/Class.getPrimitiveClass(Ljava/lang/String;)Ljava/lang/Class;", (cx, c) => {
  const len = c.newLocal(T.i32), ch = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  c.lget(0); classMethod(cx, c, "java/lang/String", "length", "()I"); c.lset(len);
  c.lget(0).i32(0); classMethod(cx, c, "java/lang/String", "charAt", "(I)C"); c.lset(ch);
  for (const [desc, [, , name]] of Object.entries(PRIM)) {
    c.lget(len).i32(name.length).raw(OP.i32_eq).lget(ch).i32(name.charCodeAt(0)).raw(OP.i32_eq).raw(OP.i32_and).if_().i32(cx.idOf(desc)); cx.callRt(c, "classOf"); c.ret().end();
  }
  c.anyNull();
});

// Class.newInstance(): the no-argument constructor of the class, after initializing it
def("java/lang/Class.newInstance()Ljava/lang/Object;", (cx, c) => {
  const s = c.newLocal(T.i32);
  c.lget(0); idOfClass(cx, c); c.lset(s);
  cx.info(c, Info.AllocSlot, () => c.lget(s)); c.ltee(s).raw(OP.i32_eqz).if_(); cx.callThrower(c, "inste"); c.end();
  c.lget(s).callIndirect(cx.sig([], "L"));
});

// Array.createObjectArray(componentType, length)
def("java/lang/reflect/Array.createObjectArray(Ljava/lang/Class;I)Ljava/lang/Object;", (cx, c) => {
  const s = c.newLocal(T.i32);
  c.lget(0); idOfClass(cx, c); c.lset(s);
  c.lget(1); cx.info(c, Info.ArraySlot, () => c.lget(s)); c.callIndirect(cx.sig(["I"], "L"));
});

// Object.internalClone(): a shallow copy; Object.clone has checked Cloneable
def("java/lang/Object.internalClone()Ljava/lang/Object;", (cx, c) => {
  const s = c.newLocal(T.i32), copy = c.newLocal(cx.vtOf("L"));
  c.lget(0); cx.callRt(c, "aclone"); c.ltee(copy).refIsNull().raw(OP.i32_eqz).if_().lget(copy).ret().end();
  cx.info(c, Info.CloneSlot, () => { c.lget(0); vtId(cx, c); }); c.ltee(s).raw(OP.i32_eqz).if_(); cx.gap(c, "Object.internalClone: abstract class"); c.end();
  c.lget(0).lget(s).callIndirect(cx.sig(["L"], "L"));
});

def("java/lang/Class.getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;", (cx, c) => {
  const id = c.newLocal(T.i32), n = c.newLocal(T.i32), len = c.newLocal(T.i32), k = c.newLocal(T.i32);
  c.lget(1).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  c.lget(0); idOfClass(cx, c); c.lset(id);
  cx.info(c, Info.NFields, () => c.lget(id)); c.lset(n);
  c.lget(1); classMethod(cx, c, "java/lang/String", "length", "()I"); c.lset(len);
  c.block().loop().lget(k).lget(n).raw(OP.i32_ge_s).brIf(1);
  cx.info(c, Info.FieldNameLen, () => c.lget(id), () => c.lget(k)); c.lget(len).raw(OP.i32_eq).if_();
  c.lget(id).lget(k).lget(1).lget(len); cx.callRt(c, "nameEq"); c.if_().lget(id).lget(k); cx.callRt(c, "mkField"); c.ret().end().end();
  c.lget(k).i32(1).raw(OP.i32_add).lset(k).br(0).end().end();
  cx.callThrower(c, "nsfe"); c.unreachable();
});
def("java/lang/Class.getDeclaredFields()[Ljava/lang/reflect/Field;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.i32(0); cx.callRt(c, "declFields"); });
def("java/lang/Class.getDeclaredFieldsUnchecked(Z)[Ljava/lang/reflect/Field;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.lget(1); cx.callRt(c, "declFields"); });
const fieldId = (cx: Compiler, c: Code) => { const fs = cx.structFor(FIELD); c.refCast(fs).structGet(fs, cx.fieldIndex(FIELD, { owner: FIELD, name: "artFieldIndex", desc: "I" })); };
def("java/lang/reflect/Field.getArtField()J", (cx, c) => { c.lget(0); fieldId(cx, c); c.raw(OP.i64_extend_i32_u); });
def("java/lang/reflect/Field.getNameInternal()Ljava/lang/String;", (cx, c) => {
  const cid = c.newLocal(T.i32), k = c.newLocal(T.i32);
  c.lget(0); fieldId(cx, c); c.ltee(k).i32(12).raw(OP.i32_shr_u).lset(cid).lget(k).i32(0xfff).raw(OP.i32_and).lset(k);
  emitString(cx, c, () => cx.info(c, Info.FieldNameLen, () => c.lget(cid), () => c.lget(k)),
    (j) => cx.info(c, Info.FieldNameChar, () => c.lget(cid), () => c.lget(k).i32(16).raw(OP.i32_shl).lget(j).raw(OP.i32_or)));
});

// VMStack.getStackClassN: the class n frames out from the native's caller (the frames come from the host's view of the Wasm stack)
for (const n of [1, 2]) def(`dalvik/system/VMStack.getStackClass${n}()Ljava/lang/Class;`, (cx, c) => {
  const id = c.newLocal(T.i32);
  c.i32(n).call(cx.imp.stackClass).ltee(id).if_(T.anyref).lget(id); cx.callRt(c, "classOf"); c.else_().anyNull().end();
});
