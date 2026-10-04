// java.lang.Class objects and array classes.
//
// A class's identity is its id (vt[H.ID]). Its Class object is an ordinary instance of the program's own java.lang.Class,
// built on first use from the class tables (gDesc) and cached by id (gTab). Its fields are the ones ART fills:
// accessFlags, primitiveType, superClass, componentType, ifTable (interface, null pairs) and dexTypeIndex, which carries
// the id. Class's own bytecode (isAssignableFrom, isInstance, getComponentType, getClassLoader, ...) then runs unchanged.
// Reference arrays share one wrapper type, so their class (and covariance) lives in the header vt and the tables.
import { Code, OP } from "./code";
import { T, refNull } from "./wasmbin";
import { H, type ElemKind } from "./consts";
import { ACC, type JClass, type MethodInfo, type Program } from "./program";
import { intrinsics } from "./intrinsics";
import { mid, type Reach } from "./reach";
import type { Compiler } from "./j2w";

const CLASS = "java/lang/Class", OBJ_ARRAY = "[Ljava/lang/Object;";
const CLONEABLE = ["java/lang/Cloneable", "java/io/Serializable"];
/** primitive descriptor -> [ART Primitive::Type, log2 size, Java name] */
const PRIM: Record<string, [number, number, string]> = { Z: [1, 0, "boolean"], B: [2, 0, "byte"], C: [3, 1, "char"], S: [4, 1, "short"], I: [5, 2, "int"],
  J: [6, 3, "long"], F: [7, 2, "float"], D: [8, 3, "double"], V: [9, 0, "void"] };
/** per-id record in gDesc: access flags, primitive type, super id, component id, interface list offset and count, name offset and length,
 *  id of the array class of this class, the InnerClass annotation's access flags (-1: none), offset and count of its field records */
const REC = 12, ACC_FLAGS = 0, PRIMITIVE = 1, SUPER = 2, COMPONENT = 3, IFACES = 4, NIFACES = 5, NAME = 6, NAMELEN = 7, ARRAY_OF = 8, INNER = 9, FIELDS = 10, NFIELDS = 11;
/** a field record: name offset and length (into the name characters), type id, access flags; the field's id is class id << 12 | its index in the class */
const FREC = 4, F_NAME = 0, F_NAMELEN = 1, F_TYPE = 2, F_FLAGS = 3;
const FIELD = "java/lang/reflect/Field", FIELD_ARRAY = "[Ljava/lang/reflect/Field;";
const KINDS: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
const isPrim = (n: string) => n in PRIM;
/** the class name (or primitive descriptor, or array descriptor) of a type descriptor */
const typeName = (d: string) => d[0] === "L" ? d.slice(1, -1) : d;
const componentName = (arr: string) => typeName(arr.slice(1));
/** access flags in a class's dalvik.annotation.InnerClass annotation, -1 for a class without one */
const innerFlags = (jc: JClass | undefined): number => {
  const a = jc?.def && jc.dex!.classAnnotations(jc.def).cls.find((x) => x.type === "Ldalvik/annotation/InnerClass;")?.elements.accessFlags;
  return typeof a === "number" ? a : -1;
};
const javaName = (n: string) => isPrim(n) ? PRIM[n][2] : n.replace(/\//g, ".");

const NEW_OBJECT_ARRAY = "java/lang/reflect/Array.createObjectArray(Ljava/lang/Class;I)Ljava/lang/Object;";
const NEW_INSTANCE = "java/lang/Class.newInstance()Ljava/lang/Object;";
const GET_DECLARED_FIELD = "java/lang/Class.getDeclaredField(Ljava/lang/String;)Ljava/lang/reflect/Field;";
const GET_DECLARED_FIELDS = "java/lang/Class.getDeclaredFields()[Ljava/lang/reflect/Field;";
const GET_DECLARED_FIELDS_UNCHECKED = "java/lang/Class.getDeclaredFieldsUnchecked(Z)[Ljava/lang/reflect/Field;";
const FIELD_NAME = "java/lang/reflect/Field.getNameInternal()Ljava/lang/String;";
const FIELD_ART = "java/lang/reflect/Field.getArtField()J";
const FIELD_NATIVES = [GET_DECLARED_FIELD, GET_DECLARED_FIELDS, GET_DECLARED_FIELDS_UNCHECKED, FIELD_NAME, FIELD_ART];
type Triple = [string, string, string];
const STRING_CHARS: Triple[] = [["java/lang/String", "length", "()I"], ["java/lang/String", "charAt", "(I)C"]];
const FROM_CHARS: Triple = ["java/lang/StringFactory", "newStringFromChars", "([C)Ljava/lang/String;"];

/** methods a method of the program needs without naming them: the Java entry points its intrinsic calls */
export function implied(m: MethodInfo, r: Reach, prog: Program): Triple[] {
  switch (mid(m)) {
    case "java/lang/Class.getPrimitiveClass(Ljava/lang/String;)Ljava/lang/Class;": return STRING_CHARS;
    case "java/lang/Class.getNameNative()Ljava/lang/String;": case FIELD_NAME: return [FROM_CHARS];
    case GET_DECLARED_FIELD: return [...STRING_CHARS, [FIELD, "<init>", "()V"]];
    case GET_DECLARED_FIELDS: case GET_DECLARED_FIELDS_UNCHECKED: return [[FIELD, "<init>", "()V"]];
    case NEW_INSTANCE: return [...r.classLiterals].filter((c) => { const jc = prog.get(c); return jc && !jc.isInterface && !(jc.flags & ACC.ABSTRACT) && jc.byKey.has("<init>()V"); }).map((c) => [c, "<init>", "()V"]);
    default: return [];
  }
}

export class ClassModel {
  /** java.lang.Class is part of the program */
  on = false;
  fn = {} as Record<"classOf" | "mkClass" | "instArr" | "astore" | "acopy" | "aclone" | "mkField" | "declFields" | "nameEq", number>;
  private gDesc = -1; private gTab = -1; private gVts = -1; private tVts = -1; private descSeg = -1; private nameSeg = -1; private nWords = 0;
  private dynamicArrays = false; private fieldTables = false; private fieldByName = false; private gChars = -1; private nChars = 0;
  constructor(private cx: Compiler) {}

  /** the classes the tables need ids for: primitives, array components, Cloneable/Serializable and, where reflection can make
   *  an array of any class, the array class of every class */
  extendReach(r: Reach): void {
    const { prog } = this.cx;
    if (!(this.on = !!prog.get(CLASS)?.dex)) return;
    for (const p in PRIM) r.referenced.add(p);
    for (const n of CLONEABLE) if (prog.get(n)) r.referenced.add(n);
    const arrays = r.arrayTypes;
    arrays.add(OBJ_ARRAY); arrays.add("[C");
    this.fieldByName = r.methods.has(GET_DECLARED_FIELD);
    if (this.fieldTables = FIELD_NATIVES.some((m) => r.methods.has(m))) {
      arrays.add(FIELD_ARRAY); r.referenced.add(FIELD);
      for (const cn of [...r.referenced]) for (const f of prog.get(cn)?.fields ?? []) if (f.desc[0] === "[") arrays.add(f.desc); else r.referenced.add(typeName(f.desc));
    }
    if (this.dynamicArrays = r.methods.has(NEW_OBJECT_ARRAY)) {
      for (const n of [...r.referenced]) if (!isPrim(n)) arrays.add("[" + (n[0] === "[" ? n : `L${n};`));
    }
    for (const a of arrays) { const t = a.slice(1); if (t[0] === "[") arrays.add(t); else r.referenced.add(componentName(a)); }
  }

  /** ids of the interfaces `n` implements (arrays: Cloneable and Serializable) */
  ifaceIds(n: string): Set<number> {
    const { prog, classId } = this.cx, out = new Set<number>();
    const add = (i: string) => { const id = classId.get(i); if (id) out.add(id); prog.get(i)?.ifaces.forEach(add); };
    if (n[0] === "[") CLONEABLE.forEach(add);
    else for (let k = prog.get(n); k; k = k.sup ? prog.get(k.sup) : undefined) k.ifaces.forEach(add);
    return out;
  }

  declare(): void {
    if (!this.on) return;
    const { cx } = this, { mb } = cx;
    const nullGlobal = (t: number) => mb.addGlobal(refNull(t), true, [0xd0, ...cx.nullHt(t)]);
    this.gDesc = nullGlobal(cx.tVT); this.gTab = nullGlobal(cx.tData.ref);
    this.tables();
    if (this.dynamicArrays) { this.tVts = mb.addType({ k: "array", elem: { t: refNull(cx.tVT), mut: true } }); this.gVts = nullGlobal(this.tVts); }
    const f = (name: string, ps: ("I" | "L")[], r: "I" | "L" | "V") => mb.reserveFunc(cx.sig(ps, r), "$" + name);
    this.fn = { classOf: f("classOf", ["I"], "L"), mkClass: f("mkClass", ["I"], "L"), instArr: f("instArr", ["L", "I"], "I"), astore: f("astore", ["L", "L"], "V"), acopy: f("acopy", ["L", "I", "L", "I", "I"], "V"), aclone: f("aclone", ["L"], "L"),
      mkField: -1, declFields: -1, nameEq: -1 };
    if (this.fieldTables) {
      this.gChars = nullGlobal(cx.tData.i16);
      this.fn.mkField = f("mkField", ["I", "I"], "L"); this.fn.declFields = f("declFields", ["I", "I"], "L");
      if (this.fieldByName) this.fn.nameEq = f("nameEq", ["I", "L", "I"], "I");
    }
  }

  private get objArray() { return this.cx.classId.get(OBJ_ARRAY)!; }
  private field(name: string, desc: string) { return this.cx.fieldIndex(CLASS, { owner: CLASS, name, desc }); }
  private isAssignableFrom() {
    const m = this.cx.prog.resolve(CLASS, "isAssignableFrom", "(Ljava/lang/Class;)Z");
    if (!m || !this.cx.fn.has(mid(m))) throw new Error("Class.isAssignableFrom not linked");
    return this.cx.fn.get(mid(m))!;
  }
  /** pushes record word `k` of the record at word offset `base` (a local) */
  desc(c: Code, base: number, k: number): Code { return c.gget(this.gDesc).refAsNonNull().lget(base).i32(k).raw(OP.i32_add).arrayGet(this.cx.tVT); }

  emit(): void {
    if (!this.on) return;
    const { cx } = this, { mb, tObj, tVT, tArr, tData, helpers: h } = cx, L = cx.vtOf("L");
    const cs = cx.structFor(CLASS);
    const vtId = (c: Code) => c.structGet(tObj, 0).i32(H.ID).arrayGet(tVT);
    // classOf(id): the cached Class object, made on first use
    {
      const c = new Code(1), o = c.newLocal(L);
      c.gget(this.gTab).refAsNonNull().lget(0).arrayGet(tData.ref).ltee(o).refIsNull().if_().lget(0).call(this.fn.mkClass).ret().end().lget(o);
      mb.setBody(this.fn.classOf, c.finish());
    }
    // mkClass(id): allocate, cache before linking (supers and interfaces may refer back), then fill from the tables
    {
      const c = new Code(1), o = c.newLocal(L), k = c.newLocal(refNull(cs)), base = c.newLocal(T.i32), n = c.newLocal(T.i32), off = c.newLocal(T.i32),
        i = c.newLocal(T.i32), data = c.newLocal(refNull(tData.ref));
      cx.emitNew(c, CLASS); c.lset(o);
      c.gget(this.gTab).refAsNonNull().lget(0).lget(o).arraySet(tData.ref);
      c.lget(o).refCast(cs).lset(k).lget(0).i32(REC).raw(OP.i32_mul).lset(base);
      const set = (name: string, d: string, v: () => void) => { c.lget(k); v(); c.structSet(cs, this.field(name, d)); };
      set("accessFlags", "I", () => this.desc(c, base, ACC_FLAGS)); set("primitiveType", "I", () => this.desc(c, base, PRIMITIVE)); set("dexTypeIndex", "I", () => c.lget(0));
      for (const [name, slot] of [["superClass", SUPER], ["componentType", COMPONENT]] as const) {
        this.desc(c, base, slot).if_(); set(name, "Ljava/lang/Class;", () => this.desc(c, base, slot).call(this.fn.classOf)); c.end();
      }
      this.desc(c, base, NIFACES).ltee(n).if_();
      this.desc(c, base, IFACES).lset(off);
      c.lget(n).i32(1).raw(OP.i32_shl).arrayNewDefault(tData.ref).lset(data);
      c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
      c.lget(data).refAsNonNull().lget(i).i32(1).raw(OP.i32_shl).gget(this.gDesc).refAsNonNull().lget(off).lget(i).raw(OP.i32_add).arrayGet(tVT).call(this.fn.classOf).arraySet(tData.ref);
      c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
      set("ifTable", "[Ljava/lang/Object;", () => c.gget(cx.vtGlobal.get(OBJ_ARRAY)!).refAsNonNull().i32(0).lget(data).refAsNonNull().structNew(tArr.ref));
      c.end().lget(o);
      mb.setBody(this.fn.mkClass, c.finish());
    }
    // instArr(obj, id): obj is a reference array assignable to the array class `id`; Object[] takes every reference array,
    // the rest is Class.isAssignableFrom over the Class objects
    {
      const c = new Code(2), s = c.newLocal(T.i32);
      c.lget(0).refIsNull().if_().i32(0).ret().end();
      c.lget(0).refTest(tArr.ref).raw(OP.i32_eqz).if_().i32(0).ret().end();
      c.lget(0).refAsNonNull(); vtId(c); c.lset(s);
      c.lget(s).lget(1).raw(OP.i32_eq).lget(1).i32(this.objArray).raw(OP.i32_eq).raw(OP.i32_or).if_().i32(1).ret().end();
      c.lget(1).call(this.fn.classOf).lget(s).call(this.fn.classOf).call(this.isAssignableFrom());
      mb.setBody(this.fn.instArr, c.finish());
    }
    // astore(array, value): ArrayStoreException unless value's class is assignable to the array's component class
    {
      const c = new Code(2), w = c.newLocal(T.i32), e = c.newLocal(T.i32), v = c.newLocal(T.i32);
      c.lget(1).refIsNull().if_().ret().end();
      c.lget(0).refAsNonNull(); vtId(c); c.i32(REC).raw(OP.i32_mul).lset(w);
      this.desc(c, w, COMPONENT).lset(e);
      c.lget(1).refAsNonNull(); vtId(c); c.lset(v);
      c.lget(v).lget(e).raw(OP.i32_eq).if_().ret().end();
      c.lget(e).call(this.fn.classOf).lget(v).call(this.fn.classOf).call(this.isAssignableFrom()).raw(OP.i32_eqz).if_().call(h.ase).end();
      mb.setBody(this.fn.astore, c.finish());
    }
    // acopy(src, sp, dst, dp, n): element-wise copy between reference arrays of different classes; an element dst cannot hold
    // throws ArrayStoreException after the elements before it have been copied (System.arraycopy)
    {
      const c = new Code(5), i = c.newLocal(T.i32), v = c.newLocal(L), sd = c.newLocal(refNull(tData.ref)), dd = c.newLocal(refNull(tData.ref));
      c.lget(0).refCast(tArr.ref).structGet(tArr.ref, 2).lset(sd).lget(2).refCast(tArr.ref).structGet(tArr.ref, 2).lset(dd);
      c.block().loop().lget(i).lget(4).raw(OP.i32_ge_s).brIf(1);
      c.lget(sd).refAsNonNull().lget(1).lget(i).raw(OP.i32_add).arrayGet(tData.ref).lset(v);
      c.lget(2).lget(v).call(this.fn.astore);
      c.lget(dd).refAsNonNull().lget(3).lget(i).raw(OP.i32_add).lget(v).arraySet(tData.ref);
      c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
      mb.setBody(this.fn.acopy, c.finish());
    }
    // aclone(obj): a copy of an array with the same class, null for anything else
    {
      const c = new Code(1);
      for (const k of KINDS) {
        const t = tArr[k], d = tData[k], a = c.newLocal(refNull(t)), src = c.newLocal(refNull(d)), dst = c.newLocal(refNull(d)), n = c.newLocal(T.i32);
        c.lget(0).refTest(t).if_();
        c.lget(0).refCast(t).lset(a).lget(a).structGet(t, 2).lset(src).lget(src).refAsNonNull().arrayLen().lset(n).lget(n).arrayNewDefault(d).lset(dst);
        c.lget(dst).refAsNonNull().i32(0).lget(src).refAsNonNull().i32(0).lget(n).arrayCopy(d, d);
        c.lget(a).structGet(t, 0).i32(0).lget(dst).refAsNonNull().structNew(t).ret().end();
      }
      c.refNull(tObj);
      mb.setBody(this.fn.aclone, c.finish());
    }
    if (this.fieldTables) this.emitFields();
  }

  /** the class tables, as passive data segments (ids are final by now) */
  private tables(): void {
    const { cx } = this, { prog, classId, mb } = cx, n = classId.size + 1;
    const words = new Array<number>(n * REC).fill(0), tail: number[] = [], chars: number[] = [], fields: number[] = [];
    const putName = (text: string) => { const at = chars.length; for (let i = 0; i < text.length; i++) chars.push(text.charCodeAt(i)); return at; };
    const objId = classId.get("java/lang/Object")!;
    for (const [name, id] of classId) {
      const r = id * REC, jc = prog.get(name), arr = name[0] === "[";
      words[r + ACC_FLAGS] = isPrim(name) || arr ? ACC.PUBLIC | ACC.FINAL | ACC.ABSTRACT : jc?.flags ?? ACC.PUBLIC;
      if (isPrim(name)) words[r + PRIMITIVE] = PRIM[name][0] | PRIM[name][1] << 16;
      if (arr) { words[r + SUPER] = objId; words[r + COMPONENT] = classId.get(componentName(name))!; }
      else if (jc) words[r + SUPER] = jc.sup ? classId.get(jc.sup) ?? 0 : jc.isInterface ? objId : 0;
      words[r + INNER] = innerFlags(jc);
      words[r + ARRAY_OF] = classId.get("[" + (name[0] === "[" || isPrim(name) ? name : `L${name};`)) ?? 0;
      const ifs = [...this.ifaceIds(name)];
      words[r + IFACES] = n * REC + tail.length; words[r + NIFACES] = ifs.length; tail.push(...ifs);
      words[r + NAME] = putName(javaName(name)); words[r + NAMELEN] = javaName(name).length;
      if (this.fieldTables && jc?.def) {
        words[r + FIELDS] = fields.length; words[r + NFIELDS] = jc.fields.length;
        for (const f of jc.fields) fields.push(putName(f.name), f.name.length, classId.get(typeName(f.desc)) ?? 0, f.flags);
      }
    }
    for (const id of classId.values()) if (words[id * REC + NFIELDS]) words[id * REC + FIELDS] += n * REC + tail.length;
    words.push(...tail, ...fields);
    this.nChars = chars.length;
    this.nWords = words.length;
    this.descSeg = mb.addDataPassive(new Uint8Array(new Int32Array(words).buffer));
    this.nameSeg = mb.addDataPassive(new Uint8Array(new Uint16Array(chars).buffer));
  }

  /** initialize the globals from the tables (called while the start function is built) */
  emitStart(c: Code): void {
    if (!this.on) return;
    const { cx } = this, n = cx.classId.size + 1;
    c.i32(0).i32(this.nWords).arrayNewData(cx.tVT, this.descSeg).gset(this.gDesc);
    c.i32(n).arrayNewDefault(cx.tData.ref).gset(this.gTab);
    if (this.fieldTables) c.i32(0).i32(this.nChars).arrayNewData(cx.tData.i16, this.nameSeg).gset(this.gChars);
    if (this.dynamicArrays) {
      c.i32(n).arrayNewDefault(this.tVts).gset(this.gVts);
      for (const [name, id] of cx.classId) if (name[0] === "[") c.gget(this.gVts).refAsNonNull().i32(id).gget(cx.vtGlobal.get(name)!).arraySet(this.tVts);
    }
  }

  /** the Class object of class/array `name`, as a (ref null Obj) */
  constClass(c: Code, name: string): void {
    const id = this.cx.classId.get(name);
    if (!this.on) throw new Error("java/lang/Class is not in the program");
    if (id === undefined) throw new Error("no class id for " + name);
    c.i32(id).call(this.fn.classOf);
  }
  /** the id of the Class object on the stack */
  idOf(c: Code): void { const cs = this.cx.structFor(CLASS); c.refCast(cs).structGet(cs, this.field("dexTypeIndex", "I")); }
  /** after the array wrapper in local `arr`, before storing the value pushed by `value`: throws ArrayStoreException when it does not fit */
  emitStoreCheck(c: Code, arr: number, value: () => void): void {
    if (!this.on) return;
    const { cx } = this;
    c.lget(arr).structGet(cx.tObj, 0).i32(H.ID).arrayGet(cx.tVT).i32(this.objArray).raw(OP.i32_ne).if_().lget(arr); value(); c.call(this.fn.astore).end();
  }
  /** a char[] copy of the name whose offset and length are words `off` and `len` of the record at `base` */
  /** in System.arraycopy's reference-array case (src, sp, dst, dp, n are locals 0..4, bounds already checked): copy with store checks unless dst takes src's elements anyway */
  emitRefCopy(c: Code): void {
    if (!this.on) return;
    const { cx } = this, id = (l: number) => c.lget(l).structGet(cx.tObj, 0).i32(H.ID).arrayGet(cx.tVT);
    id(0); id(2); c.raw(OP.i32_ne); id(2).i32(this.objArray).raw(OP.i32_ne).raw(OP.i32_and);
    c.if_().lget(0).lget(1).lget(2).lget(3).lget(4).call(this.fn.acopy).ret().end();
  }
  emitNameChars(c: Code, base: number, off: number, len: number): void {
    const { cx } = this;
    c.gget(cx.vtGlobal.get("[C")!).refAsNonNull().i32(0);
    this.desc(c, base, off).i32(1).raw(OP.i32_shl); this.desc(c, base, len); c.arrayNewData(cx.tData.i16, this.nameSeg).structNew(cx.tArr.i16);
  }
  /** the Field class's `artFieldIndex` of the Field on the stack */
  fieldId(c: Code): void { const fs = this.cx.structFor(FIELD); c.refCast(fs).structGet(fs, this.cx.fieldIndex(FIELD, { owner: FIELD, name: "artFieldIndex", desc: "I" })); }

  private emitFields(): void {
    const { cx } = this, { mb, tArr, tData } = cx, L = cx.vtOf("L"), fs = cx.structFor(FIELD);
    const fi = (name: string, d: string) => cx.fieldIndex(FIELD, { owner: FIELD, name, desc: d });
    // mkField(cid, k): the Field object of class cid's k-th declared field
    {
      const c = new Code(2), f = c.newLocal(L), o = c.newLocal(refNull(fs)), base = c.newLocal(T.i32), rec = c.newLocal(T.i32), ty = c.newLocal(T.i32), id = c.newLocal(T.i32);
      cx.emitNew(c, FIELD); c.lset(f).lget(f).refCast(fs).lset(o);
      c.lget(0).i32(REC).raw(OP.i32_mul).lset(base);
      this.desc(c, base, FIELDS).lget(1).i32(2).raw(OP.i32_shl).raw(OP.i32_add).lset(rec);
      this.desc(c, rec, F_TYPE).lset(ty);
      c.lget(ty).raw(OP.i32_eqz).if_(); cx.gap(c, "reflection: the type of a field has no class id"); c.end();
      c.lget(0).i32(12).raw(OP.i32_shl).lget(1).raw(OP.i32_or).lset(id);
      c.lget(o).lget(0).call(this.fn.classOf).structSet(fs, fi("declaringClass", "Ljava/lang/Class;"));
      c.lget(o).lget(ty).call(this.fn.classOf).structSet(fs, fi("type", "Ljava/lang/Class;"));
      c.lget(o); this.desc(c, rec, F_FLAGS); c.structSet(fs, fi("accessFlags", "I"));
      c.lget(o).lget(id).structSet(fs, fi("artFieldIndex", "I")).lget(o).lget(id).structSet(fs, fi("offset", "I"));
      c.lget(f);
      mb.setBody(this.fn.mkField, c.finish());
    }
    // declFields(cid, publicOnly): Field[] of the class's declared fields
    {
      const c = new Code(2), base = c.newLocal(T.i32), n = c.newLocal(T.i32), first = c.newLocal(T.i32), k = c.newLocal(T.i32), count = c.newLocal(T.i32), i = c.newLocal(T.i32);
      const data = c.newLocal(refNull(tData.ref)), rec = c.newLocal(T.i32);
      const keep = () => { c.lget(1).raw(OP.i32_eqz); this.desc(c, rec, F_FLAGS).i32(ACC.PUBLIC).raw(OP.i32_and).raw(OP.i32_or); };
      const each = (body: () => void) => {
        c.i32(0).lset(k).block().loop().lget(k).lget(n).raw(OP.i32_ge_s).brIf(1);
        c.lget(first).lget(k).i32(2).raw(OP.i32_shl).raw(OP.i32_add).lset(rec); body();
        c.lget(k).i32(1).raw(OP.i32_add).lset(k).br(0).end().end();
      };
      c.lget(0).i32(REC).raw(OP.i32_mul).lset(base);
      this.desc(c, base, NFIELDS).lset(n); this.desc(c, base, FIELDS).lset(first);
      each(() => { keep(); c.if_().lget(count).i32(1).raw(OP.i32_add).lset(count).end(); });
      c.lget(count).arrayNewDefault(tData.ref).lset(data);
      each(() => { keep(); c.if_().lget(data).refAsNonNull().lget(i).lget(0).lget(k).call(this.fn.mkField).arraySet(tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).end(); });
      c.gget(cx.vtGlobal.get(FIELD_ARRAY)!).refAsNonNull().i32(0).lget(data).refAsNonNull().structNew(tArr.ref);
      mb.setBody(this.fn.declFields, c.finish());
    }
    // nameEq(rec, name, len): the String `name` of length `len` spells the field name of record `rec`
    if (this.fieldByName) {
      const c = new Code(3), j = c.newLocal(T.i32);
      c.block().loop().lget(j).lget(2).raw(OP.i32_ge_s).brIf(1);
      c.lget(1).lget(j).call(cx.fnOf(cx.prog.resolve(...STRING_CHARS[1])!));
      c.gget(this.gChars).refAsNonNull(); this.desc(c, 0, F_NAME).lget(j).raw(OP.i32_add).arrayGetU(tData.i16);
      c.raw(OP.i32_ne).if_().i32(0).ret().end();
      c.lget(j).i32(1).raw(OP.i32_add).lset(j).br(0).end().end().i32(1);
      mb.setBody(this.fn.nameEq, c.finish());
    }
  }
  emitNewObjectArray(c: Code): void {
    const { cx } = this, base = c.newLocal(T.i32), a = c.newLocal(T.i32);
    c.lget(1).i32(0).raw(OP.i32_lt_s).if_().call(cx.helpers.nase).end();
    c.lget(0); this.idOf(c); c.i32(REC).raw(OP.i32_mul).lset(base);
    this.desc(c, base, ARRAY_OF).ltee(a).raw(OP.i32_eqz).if_(); cx.gap(c, "createObjectArray: array class not linked"); c.end();
    c.gget(this.gVts).refAsNonNull().lget(a).arrayGet(this.tVts).refAsNonNull().i32(0).lget(1).arrayNewDefault(cx.tData.ref).structNew(cx.tArr.ref);
  }
}

const def = (key: string, f: (cx: Compiler, c: Code) => void) => intrinsics.set(key, (cx, m, c) => f(cx, c));
const call = (cx: Compiler, c: Code, [cls, name, desc]: Triple) => c.call(cx.fnOf(cx.prog.resolve(cls, name, desc)!));

def("java/lang/Object.getClass()Ljava/lang/Class;", (cx, c) => { c.lget(0).structGet(cx.tObj, 0).i32(H.ID).arrayGet(cx.tVT).call(cx.cm.fn.classOf); });

def("java/lang/Class.getNameNative()Ljava/lang/String;", (cx, c) => {
  const base = c.newLocal(T.i32);
  c.lget(0); cx.cm.idOf(c); c.i32(REC).raw(OP.i32_mul).lset(base);
  cx.cm.emitNameChars(c, base, NAME, NAMELEN); call(cx, c, FROM_CHARS);
});

// Class.getInnerClassFlags(default): the InnerClass annotation's flags, else `default`
def("java/lang/Class.getInnerClassFlags(I)I", (cx, c) => {
  const base = c.newLocal(T.i32), f = c.newLocal(T.i32);
  c.lget(0); cx.cm.idOf(c); c.i32(REC).raw(OP.i32_mul).lset(base);
  cx.cm.desc(c, base, INNER).ltee(f).i32(0).raw(OP.i32_lt_s).if_(T.i32).lget(1).else_().lget(f).end();
});

// Class.getPrimitiveClass(name): the class whose Java name is `name`, matched on length and first character (unique among the nine)
def("java/lang/Class.getPrimitiveClass(Ljava/lang/String;)Ljava/lang/Class;", (cx, c) => {
  const len = c.newLocal(T.i32), ch = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_().call(cx.helpers.npe).end();
  c.lget(0); call(cx, c, STRING_CHARS[0]); c.lset(len);
  c.lget(0).i32(0); call(cx, c, STRING_CHARS[1]); c.lset(ch);
  for (const [desc, [, , name]] of Object.entries(PRIM)) {
    c.lget(len).i32(name.length).raw(OP.i32_eq).lget(ch).i32(name.charCodeAt(0)).raw(OP.i32_eq).raw(OP.i32_and).if_().i32(cx.classId.get(desc)!).call(cx.cm.fn.classOf).ret().end();
  }
  c.refNull(cx.tObj);
});

// Class.newInstance(): the no-argument constructor of an instantiated class, after initializing it
def(NEW_INSTANCE, (cx, c) => {
  const id = c.newLocal(T.i32), o = c.newLocal(cx.vtOf("L"));
  c.lget(0); cx.cm.idOf(c); c.lset(id);
  for (const cn of cx.r.instantiated) {
    const jc = cx.prog.get(cn), ctor = jc?.byKey.get("<init>()V"), cid = cx.classId.get(cn);
    if (!jc || jc.isInterface || jc.flags & ACC.ABSTRACT || !ctor || !cx.fn.has(mid(ctor)) || cid === undefined) continue;
    c.lget(id).i32(cid).raw(OP.i32_eq).if_();
    cx.emitEnsure(c, cn); cx.emitNew(c, cn); c.lset(o).lget(o).call(cx.fnOf(ctor)).lget(o).ret().end();
  }
  c.call(cx.helpers.inste).unreachable();
});

def(NEW_OBJECT_ARRAY, (cx, c) => cx.cm.emitNewObjectArray(c));

// reflection on declared fields: Field objects carry the field id in artFieldIndex (and offset, the cookie Unsafe takes)
def(GET_DECLARED_FIELD, (cx, c) => {
  const id = c.newLocal(T.i32), base = c.newLocal(T.i32), n = c.newLocal(T.i32), first = c.newLocal(T.i32), len = c.newLocal(T.i32), k = c.newLocal(T.i32), rec = c.newLocal(T.i32);
  c.lget(1).refIsNull().if_().call(cx.helpers.npe).end();
  c.lget(0); cx.cm.idOf(c); c.lset(id).lget(id).i32(REC).raw(OP.i32_mul).lset(base);
  cx.cm.desc(c, base, NFIELDS).lset(n); cx.cm.desc(c, base, FIELDS).lset(first);
  c.lget(1); call(cx, c, STRING_CHARS[0]); c.lset(len);
  c.block().loop().lget(k).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(first).lget(k).i32(2).raw(OP.i32_shl).raw(OP.i32_add).lset(rec);
  cx.cm.desc(c, rec, F_NAMELEN).lget(len).raw(OP.i32_eq).if_();
  c.lget(rec).lget(1).lget(len).call(cx.cm.fn.nameEq).if_().lget(id).lget(k).call(cx.cm.fn.mkField).ret().end().end();
  c.lget(k).i32(1).raw(OP.i32_add).lset(k).br(0).end().end();
  c.call(cx.helpers.nsfe).unreachable();
});
def(GET_DECLARED_FIELDS, (cx, c) => { c.lget(0); cx.cm.idOf(c); c.i32(0).call(cx.cm.fn.declFields); });
def(GET_DECLARED_FIELDS_UNCHECKED, (cx, c) => { c.lget(0); cx.cm.idOf(c); c.lget(1).call(cx.cm.fn.declFields); });
def(FIELD_ART, (cx, c) => { c.lget(0); cx.cm.fieldId(c); c.raw(OP.i64_extend_i32_u); });
def(FIELD_NAME, (cx, c) => {
  const id = c.newLocal(T.i32), base = c.newLocal(T.i32), rec = c.newLocal(T.i32);
  c.lget(0); cx.cm.fieldId(c); c.lset(id).lget(id).i32(12).raw(OP.i32_shr_u).i32(REC).raw(OP.i32_mul).lset(base);
  cx.cm.desc(c, base, FIELDS).lget(id).i32(0xfff).raw(OP.i32_and).i32(2).raw(OP.i32_shl).raw(OP.i32_add).lset(rec);
  cx.cm.emitNameChars(c, rec, F_NAME, F_NAMELEN); call(cx, c, FROM_CHARS);
});

// Object.internalClone(): a shallow copy; Object.clone has checked Cloneable, so only Cloneable classes get here
def("java/lang/Object.internalClone()Ljava/lang/Object;", (cx, c) => {
  const vid = c.newLocal(T.i32), copy = c.newLocal(cx.vtOf("L"));
  c.lget(0).call(cx.cm.fn.aclone).ltee(copy).refIsNull().raw(OP.i32_eqz).if_().lget(copy).ret().end();
  c.lget(0).structGet(cx.tObj, 0).i32(H.ID).arrayGet(cx.tVT).lset(vid);
  for (const cn of cx.r.instantiated) {
    const jc = cx.prog.get(cn), cid = cx.classId.get(cn);
    if (!jc || jc.isInterface || jc.flags & ACC.ABSTRACT || cid === undefined || !cx.prog.isSubclass(cn, CLONEABLE[0])) continue;
    const st = cx.structFor(cn), src = c.newLocal(refNull(st));
    c.lget(vid).i32(cid).raw(OP.i32_eq).if_().lget(0).refCast(st).lset(src);
    c.gget(cx.vtGlobal.get(cn)!).refAsNonNull().i32(0);
    cx.prog.layout(cn).forEach((_, i) => c.lget(src).structGet(st, i + 2));
    c.structNew(st).ret().end();
  }
  cx.gap(c, "Object.internalClone: class not Cloneable-instantiated");
});
