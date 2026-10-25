// java.lang.Class objects, array classes, class-initialization failure and declared-field reflection.
//
// A class's identity is its id (World.idOf, vt[H.ID]). Its Class object is an ordinary instance of the program's own java.lang.Class,
// made on first use by the runtime function classOf and cached by id in the table `ctab`. mkClass fills the fields ART fills (accessFlags,
// primitiveType, superClass, componentType, ifTable as interface/null pairs, dexTypeIndex carrying the id) from what the host knows
// (hostInfo); Class's own bytecode (isAssignableFrom, isInstance, getComponentType, getClassLoader, ...) then runs unchanged.
// Reference arrays share one wrapper type, so their class and covariance live in the header vt and the Class objects.
// Anything that needs a struct type per class (allocation by Class.newInstance, Object.clone, arrays by component class) asks the
// host for the slot of a generated function for that class.
import { OP } from "../compiler/code.ts";
import { HT, T, refNull } from "../compiler/wasmbin.ts";
import { H, ELEM, ELEM_KIND, ELEM_IFACE, ELEM_KINDS } from "../compiler/consts.ts";
import { ACC, descOf, javaName as stripLoader, typeName, type JClass } from "../compiler/program.ts";
import { PRIMS } from "../../jvm/abi.ts";
import { canAccess } from "../compiler/linkage.ts";
import { rt } from "../compiler/rtfns.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import { synthFamily } from "./synths.ts";
import { PerWorld } from "./perworld.ts";
import { fieldCookie } from "./unsafe.ts";
import { Lookup, LOADER_OF_CLASS, emitClassAnswer } from "./loaders.ts";
import { emitRestored } from "../compiler/hostcalls.ts";
import { Info, TextKind } from "../compiler/info.ts";
import { FIELD_INDEX_MAX, emitFieldId, fieldClass, fieldIdOf, fieldIndex, splitFieldId } from "../compiler/fieldid.ts";

const CLASS = "java/lang/Class", OBJ_ARRAY = "[Ljava/lang/Object;", FIELD = "java/lang/reflect/Field", FIELD_ARRAY = "[Ljava/lang/reflect/Field;";
const CLONEABLE = ["java/lang/Cloneable", "java/io/Serializable"];
/** primitive classes are keyed "#I" and so on, apart from the classes named like a descriptor letter (a default-package class C): by key,
 *  [ART Primitive::Type, log2 size, Java name] */
export const PRIM = Object.fromEntries([...Object.entries(PRIMS).map(([d, p]) => [d, Math.log2(p.size), p.name] as const), ["V", 0, "void"] as const]
  .map(([d, log, name], i): [string, [number, number, string]] => ["#" + d, [i + 1, log, name]]));
const isPrim = (n: string) => n in PRIM;
/** Class.getName's answer for class key `n` */
export const className = (n: string) => isPrim(n) ? PRIM[n][2] : stripLoader(n).replace(/\//g, ".");
/** access flags in a class's dalvik.annotation.InnerClass annotation, -1 for a class without one */
const innerFlags = (jc: JClass | undefined): number => {
  const a = jc?.def && jc.dex!.classAnnotations(jc.def).cls.find((x) => x.type === "dalvik/annotation/InnerClass")?.elements.accessFlags;
  return typeof a === "number" ? a : -1;
};

// ---------- what the host answers (host.info(kind, a, b); a is a class id)
const ifaceCache = new PerWorld(() => new Map<string, string[]>(), true);
function interfaces(w: World, name: string): string[] {
  const m = ifaceCache.get(w);
  let l = m.get(name);
  if (!l) {
    const out = new Set<string>(), add = (i: string) => { if (!out.has(i)) { out.add(i); w.prog.get(i)?.ifaces.forEach(add); } };
    if (name[0] === "[") CLONEABLE.forEach(add); else for (let k = w.prog.get(name); k; k = k.sup ? w.prog.get(k.sup) : undefined) k.ifaces.forEach(add);
    m.set(name, l = [...out]);
  }
  return l;
}
export function hostInfo(w: World, kind: number, a: number, b: number): number {
  const name = w.nameOf(a), jc = w.prog.get(name), arr = name[0] === "[", fields = jc?.def ? jc.fields : [];
  switch (kind as Info) {
    case Info.Flags: return isPrim(name) || arr ? ACC.PUBLIC | ACC.FINAL | ACC.ABSTRACT : jc?.flags ?? ACC.PUBLIC;
    case Info.Primitive: return isPrim(name) ? PRIM[name][0] | PRIM[name][1] << 16 : 0;
    case Info.Super: return arr || jc?.isInterface ? w.idOf("java/lang/Object") : jc?.sup ? w.idOf(jc.sup) : 0;
    case Info.Component: return arr ? w.idOf(typeName(name.slice(1))) : 0;
    case Info.NIfaces: return interfaces(w, name).length;
    case Info.Iface: return w.idOf(interfaces(w, name)[b]);
    case Info.Inner: return innerFlags(jc);
    // ObjectStreamClass.hasStaticInitializer: a <clinit> of the class, or with b set of a superclass
    case Info.HasClinit: { for (let k = jc; k; k = b && k.sup ? w.prog.get(k.sup) : undefined) if (k.byKey.has("<clinit>()V")) return 1; return 0; }
    case Info.FieldOffset:
      if (b > FIELD_INDEX_MAX) throw w.exception(w.helpers.makeThrowable("java/lang/InternalError", `${className(name)} declares field ${b}, past the ${FIELD_INDEX_MAX + 1} a field id can name`));
      return fieldCookie(w, fieldIdOf(a, b));
    case Info.NFields: return fields.length;
    case Info.FieldType: return w.idOf(typeName(fields[b].desc));
    case Info.FieldFlags: return fields[b].flags;
    case Info.FieldDesc: return fields[b].desc.charCodeAt(0);
    case Info.CanAccess: { const decl = w.prog.get(w.nameOf(fieldClass(b)))!; return +canAccess(w.prog, w.nameOf(a), decl, decl.fields[fieldIndex(b)].flags); }
    case Info.AllocSlot: return !jc || jc.isInterface || jc.flags & ACC.ABSTRACT || !jc.byKey.has("<init>()V") ? 0 : w.synthSlot("new:" + name);
    case Info.CloneSlot: return !jc || jc.isInterface || jc.flags & ACC.ABSTRACT ? 0 : w.synthSlot("clone:" + name);
    case Info.EnsureSlot: return jc ? w.ensureSlot(name) : 0;           // an array class has nothing to initialize
    case Info.ArrayOf: return b ? w.idOf("[".repeat(b) + descOf(name)) : a;      // the class of the b-fold array of a
    case Info.ArraySlot: return w.synthSlot("newarray:[" + descOf(name));      // a = the component class: the array allocator for it
  }
}
/** what host.findMember looks for: a method, a constructor or a field */
export const Member = { Method: 0, Ctor: 1, Field: 2 } as const;
const ACC_BRIDGE = 0x40;
/** host.findMember(cid, name, kind, n, from): the index of the first declared member of class `cid` from `from` on that is field `name`, method `name` or a
 *  constructor (name null) with `n` parameters and not a bridge; -1 if none */
export function findMember(w: World, cid: number, name: string | null, kind: number, n: number, from: number): number {
  const jc = w.prog.get(w.nameOf(cid));
  if (kind === Member.Field) return jc?.def ? jc.fields.findIndex((f) => f.name === name) : -1;
  const want = kind === Member.Ctor ? "<init>" : name === "<init>" || name === "<clinit>" ? undefined : name, methods = jc?.methods ?? [];
  for (let k = from; k < methods.length; k++) { const m = methods[k]; if (m.name === want && m.params.length === n && !(m.flags & ACC_BRIDGE)) return k; }
  return -1;
}
synthFamily("new", (w, name) => {
  const ctor = w.prog.get(name)?.byKey.get("<init>()V");
  return ctor && { params: [], ret: "L", body: (cx, c) => cx.construct(c, ctor) };
}, true);
synthFamily("clone", (_w, name) => ({ params: ["L"], ret: "L", body: (cx, c) => {
  const st = cx.structFor(name), src = c.newLocal(refNull(st)), o = c.newLocal(refNull(st));
  c.lget(0).refCast(st).lset(src); cx.emitNew(c, name); c.lset(o);
  cx.prog.layout(name).forEach((_, i) => c.lget(o).lget(src).structGet(st, i + 2).structSet(st, i + 2));
  c.lget(o);
} }), true);
synthFamily("newarray", (_w, name) => ({ params: ["I"], ret: "L", body: (cx, c) => cx.emitNewArray(c, name, () => c.lget(0)) }), true);

// ---------- the pieces compiled code calls
/** in System.arraycopy's reference-array case (src, sp, dst, dp, n are locals 0..4, bounds checked): a copy with store checks unless dst takes src's elements anyway */
export function emitRefCopy(cx: Compiler, c: Code): void {
  const id = (l: number) => { c.lget(l); return cx.vtId(c); };
  id(0); id(2); c.raw(OP.i32_ne); id(2).i32(cx.idOf(OBJ_ARRAY)).raw(OP.i32_ne).raw(OP.i32_and);
  c.if_().lget(0).lget(1).lget(2).lget(3).lget(4); cx.callRt(c, "acopy"); c.ret().end();
}

const isAssignableFrom = (cx: Compiler, c: Code) => cx.callNamed(c, CLASS, "isAssignableFrom", "(Ljava/lang/Class;)Z");
const field = (cx: Compiler, name: string, d: string) => cx.fieldIndex(CLASS, { owner: CLASS, name, desc: d });

// classOf(id): the cached Class object; the table grows to hold the id
rt("classOf", ["I"], "L", (cx, c) => {
  const { tData } = cx, g = cx.ctab(), tab = c.newLocal(refNull(tData.ref)), o = c.newLocal(cx.vtOf("L")), n = c.newLocal(T.i32);
  c.gget(g).lset(tab).lget(tab).refAsNonNull().arrayLen().lset(n);
  c.lget(0).lget(n).raw(OP.i32_ge_s).if_();
  c.lget(0).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_shl).lget(0).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_shl).raw(OP.i32_gt_s).select().arrayNewDefault(tData.ref).lset(tab);
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
  set("classLoader", "Ljava/lang/ClassLoader;", () => { c.i32(LOADER_OF_CLASS); c.lget(0); c.i32(0); c.refNull(HT.extern); c.call(cx.imp.obj).anyConvertExtern(); });
  for (const [name, kind] of [["superClass", Info.Super], ["componentType", Info.Component]] as const) {
    info(kind).if_(); set(name, "Ljava/lang/Class;", () => { info(kind); cx.callRt(c, "classOf"); }); c.end();
  }
  info(Info.NIfaces).ltee(n).if_();
  c.lget(n).i32(1).raw(OP.i32_shl).arrayNewDefault(tData.ref).lset(data);
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(data).refAsNonNull().lget(i).i32(1).raw(OP.i32_shl); info(Info.Iface, () => c.lget(i)); cx.callRt(c, "classOf"); c.arraySet(tData.ref);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  set("ifTable", "[Ljava/lang/Object;", () => c.gget(cx.vtGlobal(OBJ_ARRAY)).refAsNonNull().i64(0n).lget(data).refAsNonNull().structNew(tArr.ref));
  c.end().lget(o);
});
// instArr(obj, id): obj is a reference array assignable to array class `id`; Object[] takes every reference array, the rest is
// Class.isAssignableFrom over the Class objects
rt("instArr", ["L", "I"], "I", (cx, c) => {
  const s = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_().i32(0).ret().end();
  c.lget(0).refTest(cx.tArr.ref).raw(OP.i32_eqz).if_().i32(0).ret().end();
  c.lget(0).refAsNonNull(); cx.vtId(c); c.lset(s);
  c.lget(s).lget(1).raw(OP.i32_eq).lget(1).i32(cx.idOf(OBJ_ARRAY)).raw(OP.i32_eq).raw(OP.i32_or).if_().i32(1).ret().end();
  c.lget(1); cx.callRt(c, "classOf"); c.lget(s); cx.callRt(c, "classOf"); isAssignableFrom(cx, c);
}, true);
// astore(array, value): ArrayStoreException unless value's class is assignable to the array's component class
rt("astore", ["L", "L"], "V", (cx, c) => {
  const { tVT, tArr } = cx, avt = c.newLocal(refNull(tVT)), vvt = c.newLocal(refNull(tVT)), e = c.newLocal(T.i32), k = c.newLocal(T.i32);
  const word = (vt: number, i: number) => c.lget(vt).refAsNonNull().i32(i).arrayGet(tVT);
  const fail = () => { word(vvt, H.ID); word(avt, H.ID); cx.callThrower(c, "asx"); };
  c.lget(1).refIsNull().if_().ret().end();
  c.lget(0).refCast(tArr.ref).structGet(tArr.ref, 0).lset(avt);
  c.lget(1).call(cx.helper("vtab")).lset(vvt);
  word(avt, ELEM).lset(e);
  word(vvt, H.ID).lget(e).raw(OP.i32_eq).if_().ret().end();
  word(avt, ELEM_KIND).lset(k);
  // a class within the display: the value's ancestor at the component's depth
  c.lget(k).i32(0).raw(OP.i32_gt_s).if_();
  word(vvt, H.DEPTH).lget(k).i32(1).raw(OP.i32_sub).raw(OP.i32_ge_s).if_();
  c.lget(vvt).refAsNonNull().lget(k).i32(H.DISPLAY - 1).raw(OP.i32_add).arrayGet(tVT).lget(e).raw(OP.i32_eq).if_().ret().end().end();
  fail(); c.end();
  c.lget(k).i32(ELEM_IFACE).raw(OP.i32_eq).if_().lget(1).lget(e).call(cx.helper("implements")).if_().ret().end(); fail(); c.end();
  // an array component: Class.isAssignableFrom decides
  c.lget(e); cx.callRt(c, "classOf"); word(vvt, H.ID); cx.callRt(c, "classOf"); isAssignableFrom(cx, c);
  c.raw(OP.i32_eqz).if_(); fail(); c.end();
}, true);
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
}, true);
// aclone(obj): a copy of an array with the same class, null for anything else
rt("aclone", ["L"], "L", (cx, c) => {
  for (const k of ELEM_KINDS) {
    const t = cx.tArr[k], d = cx.tData[k], a = c.newLocal(refNull(t)), src = c.newLocal(refNull(d)), dst = c.newLocal(refNull(d)), n = c.newLocal(T.i32);
    c.lget(0).refTest(t).if_();
    c.lget(0).refCast(t).lset(a).lget(a).structGet(t, 2).lset(src).lget(src).refAsNonNull().arrayLen().lset(n).lget(n).arrayNewDefault(d).lset(dst);
    c.lget(dst).refAsNonNull().i32(0).lget(src).refAsNonNull().i32(0).lget(n).arrayCopy(d, d);
    c.lget(a).structGet(t, 0).i64(0n).lget(dst).refAsNonNull().structNew(t).ret().end();
  }
  c.anyNull();
}, true);

// cnfe(name): ClassNotFoundException with the requested name as its message
rt("cnfe", ["L"], "V", (cx, c) => {
  const ctor = cx.prog.resolve("java/lang/ClassNotFoundException", "<init>", "(Ljava/lang/String;)V");
  if (!ctor) { cx.gap(c, "ClassNotFoundException.<init>(String)"); return; }
  cx.construct(c, ctor, () => c.lget(0)); c.throw_(cx.tag);
});

// ---------- class initialization (the state machine is World.ensureBody)
rt("initErroneous", ["I"], "V", (cx, c) => { c.lget(0); cx.callThrower(c, "ncdfe"); });
// initFail(e): <clinit> threw e. An Error propagates as it is; anything else is wrapped in ExceptionInInitializerError, which here only
// stores the cause (ART's constructor also fills in the stack trace)
rt("initFail", ["L"], "V", (cx, c) => {
  const err = "java/lang/Error", eiie = "java/lang/ExceptionInInitializerError", w = c.newLocal(cx.vtOf("L")), st = cx.structFor(eiie);
  c.lget(0).i32(cx.idOf(err)).i32(cx.prog.chain(err).length - 1).call(cx.helper("iof")).if_().lget(0).throw_(cx.tag).end();
  cx.emitNew(c, eiie); c.lset(w);
  if (cx.prog.get(eiie)?.dex) c.lget(w).refCast(st).lget(0).structSet(st, cx.fieldIndex(eiie, { owner: "java/lang/Throwable", name: "cause", desc: "Ljava/lang/Throwable;" }));
  c.lget(w).throw_(cx.tag);
});

// ---------- reflection on declared fields: Field objects carry the field id (compiler/fieldid.ts) in artFieldIndex and offset
rt("mkField", ["I", "I"], "L", (cx, c) => {
  const fs = cx.structFor(FIELD), f = c.newLocal(cx.vtOf("L")), o = c.newLocal(refNull(fs)), id = c.newLocal(T.i32);
  const fi = (name: string, d: string) => cx.fieldIndex(FIELD, { owner: FIELD, name, desc: d });
  const info = (kind: number) => cx.info(c, kind, () => c.lget(0), () => c.lget(1));
  cx.emitNew(c, FIELD); c.lset(f).lget(f).refCast(fs).lset(o);
  emitFieldId(c, 0, 1); c.lset(id);
  c.lget(o).lget(0); cx.callRt(c, "classOf"); c.structSet(fs, fi("declaringClass", "Ljava/lang/Class;"));
  c.lget(o); info(Info.FieldType); cx.callRt(c, "classOf"); c.structSet(fs, fi("type", "Ljava/lang/Class;"));
  c.lget(o); info(Info.FieldFlags); c.structSet(fs, fi("accessFlags", "I"));
  c.lget(o).lget(id).structSet(fs, fi("artFieldIndex", "I")).lget(o); info(Info.FieldOffset); c.structSet(fs, fi("offset", "I"));
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
  c.gget(cx.vtGlobal(FIELD_ARRAY)).refAsNonNull().i64(0n).lget(data).refAsNonNull().structNew(tArr.ref);
});
// ---------- intrinsics
/** the intrinsics of this file, added to the table by intrinsics.ts */
export const classIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => classIntrinsics.set(key, (cx, m, c) => f(cx, c));
export const idOfClass = (cx: Compiler, c: Code) => { const cs = cx.structFor(CLASS); c.refCast(cs).structGet(cs, field(cx, "dexTypeIndex", "I")); };
/** the String of the name host.text answers (TextKind), interned: ART interns the names of classes and members, which Method.equals compares by identity */
export function emitName(cx: Compiler, c: Code, kind: TextKind, a: () => void, b: () => void): void {
  c.i32(kind); a(); b(); c.call(cx.imp.text); cx.str.fromHost(c); c.call(cx.str.intern());
}

// ART allocates ClassExt lazily in the Class object's extData field, without
// invoking its private constructor. Allocation and publication cannot suspend
// in this process realm, so competing strands observe the same extension.
def("java/lang/Class.ensureExtDataPresent()Ldalvik/system/ClassExt;", (cx, c) => {
  const cs = cx.structFor(CLASS), ext = c.newLocal(cx.vtOf("L"));
  c.lget(0).refCast(cs).structGet(cs, field(cx, "extData", "Ldalvik/system/ClassExt;")).ltee(ext).refIsNull().if_();
  cx.emitNew(c, "dalvik/system/ClassExt"); c.lset(ext);
  c.lget(0).refCast(cs).lget(ext).structSet(cs, field(cx, "extData", "Ldalvik/system/ClassExt;"));
  c.end().lget(ext);
});

def("java/lang/Object.getClass()Ljava/lang/Class;", (cx, c) => { c.lget(0); cx.vtId(c); cx.callRt(c, "classOf"); });

def("java/io/ObjectStreamClass.hasStaticInitializer(Ljava/lang/Class;Z)Z", (cx, c) => { cx.info(c, Info.HasClinit, () => { c.lget(0); idOfClass(cx, c); }, () => c.lget(1)); });
def("java/lang/Class.getNameNative()Ljava/lang/String;", (cx, c) => emitName(cx, c, TextKind.ClassName, () => { c.lget(0); idOfClass(cx, c); }, () => c.i32(0)));

// Class.classForName(name, initialize, loader): the class `loader` sees under that name (loaders.ts)
def("java/lang/Class.classForName(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", (cx, c) => {
  const id = c.newLocal(T.i32);
  c.lget(0); cx.nullCheck(c);
  const wait = cx.global("rt", "wait", T.i32, true);
  emitRestored(cx, c, [], [], () => {
    c.lget(0); cx.str.toHost(c); c.lget(2).externConvertAny(); c.i32(Lookup.ForName); c.call(cx.imp.classByName).lset(id);
    c.gget(wait).if_();
    c.i32(0).gset(wait).call(cx.imp.annotationWait).anyConvertExtern(); idOfClass(cx, c); c.lset(id);
    c.end();
  });
  c.lget(id).raw(OP.i32_eqz).if_().lget(0); cx.callRt(c, "cnfe"); c.end();
  const init = c.newLocal(T.i32);
  c.lget(1).if_(); cx.info(c, Info.EnsureSlot, () => c.lget(id)); c.ltee(init).if_().lget(init).callIndirect(cx.sig([], "V")).end().end();
  c.lget(id); cx.callRt(c, "classOf");
});

// ART's findLoadedClass also searches recognized platform loader paths (loaders.ts).
def("java/lang/VMClassLoader.findLoadedClass(Ljava/lang/ClassLoader;Ljava/lang/String;)Ljava/lang/Class;", (cx, c) => {
  const id = c.newLocal(T.i32);
  c.lget(1); cx.nullCheck(c);
  emitRestored(cx, c, [], [T.anyref], () => {
    c.lget(1); cx.str.toHost(c); c.lget(0).externConvertAny(); c.i32(Lookup.Defined); c.call(cx.imp.classByName).lset(id);
    emitClassAnswer(cx, c, id);
  });
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
  c.lget(0); cx.nullCheck(c);
  c.lget(0); cx.callNamed(c, "java/lang/String", "length", "()I"); c.lset(len);
  c.lget(0).i32(0); cx.callNamed(c, "java/lang/String", "charAt", "(I)C"); c.lset(ch);
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

// Array.createObjectArray(componentType, length), and VMRuntime's array allocators, which take any component class
const newArrayOf = (cls: number, len: number) => (cx: Compiler, c: Code) => {
  const s = c.newLocal(T.i32);
  c.lget(cls); idOfClass(cx, c); c.lset(s);
  c.lget(len); cx.info(c, Info.ArraySlot, () => c.lget(s)); c.callIndirect(cx.sig(["I"], "L"));
};
def("java/lang/reflect/Array.createObjectArray(Ljava/lang/Class;I)Ljava/lang/Object;", newArrayOf(0, 1));
for (const n of ["newNonMovableArray", "newUnpaddedArray"]) def(`dalvik/system/VMRuntime.${n}(Ljava/lang/Class;I)Ljava/lang/Object;`, newArrayOf(1, 2));
// Array.createMultiArray(componentType, dimensions): nested arrays, the innermost of the component class
rt("newMulti", ["I", "L", "I"], "L", (cx, c) => {
  const n = c.newLocal(T.i32), len = c.newLocal(T.i32), w = c.newLocal(refNull(cx.tArr.ref)), data = c.newLocal(refNull(cx.tData.ref)), j = c.newLocal(T.i32), dims = c.newLocal(refNull(cx.tData.i32)), all = c.newLocal(T.anyref);
  c.lget(1).refCast(cx.tArr.i32).structGet(cx.tArr.i32, 2).lset(dims).lget(dims).refAsNonNull().arrayLen().lset(n);
  c.lget(dims).refAsNonNull().lget(2).arrayGet(cx.tData.i32).lset(len);
  // the array of this level: its component is the (remaining dimensions - 1)-fold array of the class
  c.lget(len); cx.info(c, Info.ArraySlot, () => cx.info(c, Info.ArrayOf, () => c.lget(0), () => c.lget(n).lget(2).raw(OP.i32_sub).i32(1).raw(OP.i32_sub))); c.callIndirect(cx.sig(["I"], "L"));
  c.lset(all);
  c.lget(2).i32(1).raw(OP.i32_add).lget(n).raw(OP.i32_eq).if_().lget(all).ret().end();
  c.lget(all).refCast(cx.tArr.ref).lset(w).lget(w).structGet(cx.tArr.ref, 2).lset(data);
  c.block().loop().lget(j).lget(len).raw(OP.i32_ge_s).brIf(1);
  c.lget(data).refAsNonNull().lget(j).lget(0).lget(1).lget(2).i32(1).raw(OP.i32_add); cx.callRt(c, "newMulti"); c.arraySet(cx.tData.ref);
  c.lget(j).i32(1).raw(OP.i32_add).lset(j).br(0).end().end().lget(w);
});
def("java/lang/reflect/Array.createMultiArray(Ljava/lang/Class;[I)Ljava/lang/Object;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.lget(1).i32(0); cx.callRt(c, "newMulti"); });

// Object.internalClone(): a shallow copy; Object.clone has checked Cloneable
def("java/lang/Object.internalClone()Ljava/lang/Object;", (cx, c) => {
  const s = c.newLocal(T.i32), copy = c.newLocal(cx.vtOf("L"));
  c.lget(0); cx.callRt(c, "aclone"); c.ltee(copy).refIsNull().raw(OP.i32_eqz).if_().lget(copy).ret().end();
  cx.info(c, Info.CloneSlot, () => { c.lget(0); cx.vtId(c); }); c.ltee(s).raw(OP.i32_eqz).if_(); cx.gap(c, "Object.internalClone: abstract class"); c.end();
  c.lget(0).lget(s).callIndirect(cx.sig(["L"], "L"));
});

def("java/lang/Class.getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;", (cx, c) => {
  const id = c.newLocal(T.i32), k = c.newLocal(T.i32);
  c.lget(1); cx.nullCheck(c);
  c.lget(0); idOfClass(cx, c); c.ltee(id).lget(1); cx.str.toHost(c); c.i32(Member.Field).i32(0).i32(0).call(cx.imp.findMember).ltee(k);
  c.i32(0).raw(OP.i32_lt_s).if_(); cx.callThrower(c, "nsfe"); c.end();
  c.lget(id).lget(k); cx.callRt(c, "mkField");
});
def("java/lang/Class.getDeclaredFields()[Ljava/lang/reflect/Field;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.i32(0); cx.callRt(c, "declFields"); });
def("java/lang/Class.getPublicDeclaredFields()[Ljava/lang/reflect/Field;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.i32(1); cx.callRt(c, "declFields"); });
def("java/lang/Class.getDeclaredFieldsUnchecked(Z)[Ljava/lang/reflect/Field;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.lget(1); cx.callRt(c, "declFields"); });
export const fieldId = (cx: Compiler, c: Code) => { const fs = cx.structFor(FIELD); c.refCast(fs).structGet(fs, cx.fieldIndex(FIELD, { owner: FIELD, name: "artFieldIndex", desc: "I" })); };
def("java/lang/reflect/Field.getArtField()J", (cx, c) => { c.lget(0); fieldId(cx, c); c.raw(OP.i64_extend_i32_u); });
def("java/lang/reflect/Field.getNameInternal()Ljava/lang/String;", (cx, c) => {
  const cid = c.newLocal(T.i32), k = c.newLocal(T.i32);
  c.lget(0); fieldId(cx, c); c.lset(k); splitFieldId(c, k, cid, k);
  emitName(cx, c, TextKind.FieldName, () => c.lget(cid), () => c.lget(k));
});

// VMStack.getStackClassN: the class n frames out from the native's caller (the frames come from the host's view of the Wasm stack)
for (const n of [1, 2]) def(`dalvik/system/VMStack.getStackClass${n}()Ljava/lang/Class;`, (cx, c) => {
  const id = c.newLocal(T.i32);
  c.i32(n).call(cx.imp.stackClass).ltee(id).if_(T.anyref).lget(id); cx.callRt(c, "classOf"); c.else_().anyNull().end();
});
