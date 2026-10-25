// What a class's dex says about its members: java.lang.Class's simple name and nesting, the declared methods and constructors as Method and Constructor
// arrays, and which annotations a class, method or field carries (art/runtime/native/java_lang_Class.cc, dex_file_annotations.cc). The members of a
// class are named as reflect.ts names them: Executable.artMethod = class id << 16 | index in the class's methods, Field.artFieldIndex = its id (compiler/fieldid.ts).
import { OP } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import { ACC, javaName, type JClass, typeName } from "../compiler/program.ts";
import { idOfClass, fieldId, PRIM, className } from "./classes.ts";

import { rt } from "../compiler/rtfns.ts";
import { executableSlot, methodAt } from "./reflect.ts";
import type { EncAnnotation } from "../../jvm/dex.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import { MInfo, TextKind } from "../compiler/info.ts";
import { PerWorld } from "./perworld.ts";
import { fieldClass, fieldIndex } from "../compiler/fieldid.ts";

const METHOD_ARRAY = "[Ljava/lang/reflect/Method;", CTOR_ARRAY = "[Ljava/lang/reflect/Constructor;";
const INNER = "dalvik/annotation/InnerClass", ENCLOSING_CLASS = "dalvik/annotation/EnclosingClass", ENCLOSING_METHOD = "dalvik/annotation/EnclosingMethod";
const THROWS = "dalvik/annotation/Throws", RUNTIME = 1;

const annotationsOf = (w: World, jc: JClass | undefined) => jc?.def && w.prog.typesOf(jc.dex!).classAnnotations(jc.def);
/** the annotations of an element that are visible at run time, as ART's lookups see them (build and system visibility are not) */
const visible = (set: EncAnnotation[] | undefined) => (set ?? []).filter((a) => a.visibility === RUNTIME);
const present = (set: EncAnnotation[] | undefined, type: string) => visible(set).some((a) => a.type === type);

/** the declared executables of each class an array of them was made for (execArray), by class id * 4 + which (1: constructors, 2: public only): making the
 *  array's elements may list another class's */
const executables = new PerWorld(() => new Map<number, number[]>());
function listed(w: World, cid: number, which: number): number[] {
  const byClass = executables.get(w), key = cid * 4 + which;
  let list = byClass.get(key);
  if (!list) {
    const ctor = which & 1, publicOnly = which & 2, out: number[] = [];
    w.prog.get(w.nameOf(cid))?.methods.forEach((m, i) => { if ((m.name === "<init>") === !!ctor && m.name !== "<clinit>" && (!publicOnly || m.flags & ACC.PUBLIC)) out.push(i); });
    byClass.set(key, list = out);
  }
  return list;
}

export function hostMembers(w: World, kind: number, a: number, b: number): number {
  const cls = (id: number) => w.prog.get(w.nameOf(id));
  switch (kind as MInfo) {
    case MInfo.ExecCount: return listed(w, a, b).length;
    // b: the index << 2 | which
    case MInfo.ExecAt: return listed(w, a, b & 3)[b >>> 2];
    case MInfo.ClassAnn: return +present(annotationsOf(w, cls(a))?.cls, w.nameOf(b));
    case MInfo.ExecAnn: { const m = methodAt(w, b); return +present(annotationsOf(w, w.prog.get(m.cls))?.methods.get(m.methodIdx), w.nameOf(a)); }
    case MInfo.FieldAnn: {
      const jc = cls(fieldClass(b))!, ids = [...jc.def!.staticFields, ...jc.def!.instanceFields];
      return +present(annotationsOf(w, jc)?.fields.get(ids[fieldIndex(b)].fieldIdx), w.nameOf(a));
    }
    case MInfo.CompareParams: {
      // the parameter lists of two methods (cookies a and b) by length, then by the class ids of their types: 0 when they agree
      const [x, y] = [a, b].map((k) => methodAt(w, k).params.map((p) => w.idOf(typeName(p))));
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      const i = x.findIndex((t, k) => t !== y[k]);
      return i < 0 ? 0 : x[i] < y[i] ? -1 : 1;
    }
    case MInfo.ThrowsCount: case MInfo.ThrowsAt: {
      // the classes in the method's dalvik.annotation.Throws (system visibility), by class id
      const m = methodAt(w, a), jc = w.prog.get(m.cls)!, v = annotationsOf(w, jc)?.methods.get(m.methodIdx)?.find((x) => x.type === THROWS)?.elements.value;
      const types = Array.isArray(v) ? v.map((e) => w.idOf(w.prog.typesOf(jc.dex!).typeName((e as { idx: number }).idx))) : [];
      return kind === MInfo.ThrowsCount ? types.length : types[b];
    }
    case MInfo.EnclosingOwner: {
      // the class a member class is declared in, else the class of the method a local or anonymous class is declared in
      const jc = cls(a)!, set = annotationsOf(w, jc)?.cls, v = (set?.find((x) => x.type === ENCLOSING_CLASS) ?? set?.find((x) => x.type === ENCLOSING_METHOD))?.elements.value as { idx: number } | undefined;
      if (!v) return 0;
      return w.idOf(w.prog.typesOf(jc.dex!).typeName(set!.some((x) => x.type === ENCLOSING_CLASS) ? v.idx : jc.dex!.method(v.idx).cls));
    }
    case MInfo.IsAnonymous: return +!!annotationsOf(w, cls(a))?.cls.find((x) => x.type === INNER && x.elements.name === null);
    case MInfo.IsRecord: return +(cls(a)?.sup === "java/lang/Record");
    case MInfo.DeclaringClass: {
      const jc = cls(a), v = annotationsOf(w, jc)?.cls.find((x) => x.type === ENCLOSING_CLASS)?.elements.value as { idx: number } | undefined;
      return v ? w.idOf(w.prog.typesOf(jc!.dex!).typeName(v.idx)) : 0;
    }
    case MInfo.EnclosingClass: case MInfo.EnclosingIndex: {
      // the method a local or anonymous class is declared in (b: asking for a constructor); -1 when it has none of that kind
      const jc = cls(a)!, v = annotationsOf(w, jc)?.cls.find((x) => x.type === ENCLOSING_METHOD)?.elements.value as { idx: number } | undefined;
      if (!v) return -1;
      const owner = w.prog.get(w.prog.typesOf(jc.dex!).typeName(jc.dex!.method(v.idx).cls)), index = owner?.methods.findIndex((m) => m.dex === jc.dex && m.methodIdx === v.idx) ?? -1;
      if (index < 0 || (owner!.methods[index].name === "<init>") !== !!b) return -1;
      return kind === MInfo.EnclosingClass ? w.idOf(owner!.name) : index;
    }
  }
}

/** the strings the host answers (host.text, TextKind) */
export function hostText(w: World, kind: number, a: number, b: number): string {
  const name = w.nameOf(a);
  switch (kind) {
    case TextKind.ClassName: return className(name);
    case TextKind.MethodName: return w.prog.get(name)!.methods[b].name;
    case TextKind.FieldName: return w.prog.get(name)!.fields[b].name;
  }
  if (name in PRIM) return PRIM[name][2];
  const jc = w.prog.get(name), inner = annotationsOf(w, jc)?.cls.find((x) => x.type === INNER);
  // a member class has its name in InnerClass; a local or anonymous class has none ("" for an anonymous one); a top-level class is named after its package
  return inner ? (inner.elements.name as string | null) ?? "" : javaName(name.slice(name.lastIndexOf("/") + 1));
}

// execArray(cid, ctor?, publicOnly?): the Method[] or Constructor[] of the declared methods or constructors of class cid
for (const [name, array, ctor] of [["methodArray", METHOD_ARRAY, 0], ["ctorArray", CTOR_ARRAY, 1]] as const) {
  rt(name, ["I", "I"], "L", (cx, c) => {
    const n = c.newLocal(T.i32), i = c.newLocal(T.i32), arr = c.newLocal(T.anyref), which = c.newLocal(T.i32);
    c.lget(1).i32(1).raw(OP.i32_shl).i32(ctor).raw(OP.i32_or).lset(which);
    cx.info(c, MInfo.ExecCount, () => c.lget(0), () => c.lget(which)); c.lset(n);
    cx.emitNewArray(c, array, () => c.lget(n)); c.lset(arr);
    c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
    c.lget(arr).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(i);
    c.lget(0); cx.info(c, MInfo.ExecAt, () => c.lget(0), () => c.lget(i).i32(2).raw(OP.i32_shl).lget(which).raw(OP.i32_or)); c.i32(ctor); cx.callRt(c, "mkExec");
    c.arraySet(cx.tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
    c.lget(arr);
  });
}

// throwsArray(method slot): the Class[] of an executable's declared exceptions
rt("throwsArray", ["I"], "L", (cx, c) => {
  const n = c.newLocal(T.i32), i = c.newLocal(T.i32), arr = c.newLocal(T.anyref);
  cx.info(c, MInfo.ThrowsCount, () => c.lget(0)); c.lset(n);
  cx.emitNewArray(c, "[Ljava/lang/Class;", () => c.lget(n)); c.lset(arr);
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(arr).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(i);
  cx.info(c, MInfo.ThrowsAt, () => c.lget(0), () => c.lget(i)); cx.callRt(c, "classOf");
  c.arraySet(cx.tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  c.lget(arr);
});

export const memberIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => memberIntrinsics.set(key, (cx, m, c) => f(cx, c));
const classId = (cx: Compiler, c: Code, local: number) => { c.lget(local); idOfClass(cx, c); };
/** the Class (or null) of the id the host answered, 0 or -1 for none */
const classOrNull = (cx: Compiler, c: Code, id: number) => { c.lget(id).i32(0).raw(OP.i32_gt_s).if_(T.anyref).lget(id); cx.callRt(c, "classOf"); c.else_().anyNull().end(); };

def("java/lang/Class.getSimpleNameNative()Ljava/lang/String;", (cx, c) => { c.i32(TextKind.SimpleName); classId(cx, c, 0); c.i32(0).call(cx.imp.text); cx.str.fromHost(c); });
def("java/lang/Class.isRecord0()Z", (cx, c) => { cx.info(c, MInfo.IsRecord, () => classId(cx, c, 0)); });
def("java/lang/Class.getDeclaredMethodsUnchecked(Z)[Ljava/lang/reflect/Method;", (cx, c) => { classId(cx, c, 0); c.lget(1); cx.callRt(c, "methodArray"); });
def("java/lang/Class.getDeclaredConstructorsInternal(Z)[Ljava/lang/reflect/Constructor;", (cx, c) => { classId(cx, c, 0); c.lget(1); cx.callRt(c, "ctorArray"); });
for (const cls of ["Method", "Constructor"]) {
  def(`java/lang/reflect/${cls}.getExceptionTypes()[Ljava/lang/Class;`, (cx, c) => {
    executableSlot(cx, c); cx.callRt(c, "throwsArray");
  });
}
def("java/lang/Class.getDeclaringClass()Ljava/lang/Class;", (cx, c) => { const id = c.newLocal(T.i32); cx.info(c, MInfo.DeclaringClass, () => classId(cx, c, 0)); c.lset(id); classOrNull(cx, c, id); });
def("java/lang/Class.getEnclosingClass()Ljava/lang/Class;", (cx, c) => { const id = c.newLocal(T.i32); cx.info(c, MInfo.EnclosingOwner, () => classId(cx, c, 0)); c.lset(id); classOrNull(cx, c, id); });
def("java/lang/Class.isAnonymousClass()Z", (cx, c) => { cx.info(c, MInfo.IsAnonymous, () => classId(cx, c, 0)); });
def("java/lang/Class.isDeclaredAnnotationPresent(Ljava/lang/Class;)Z", (cx, c) => { cx.info(c, MInfo.ClassAnn, () => classId(cx, c, 0), () => classId(cx, c, 1)); });
def("java/lang/reflect/Executable.isAnnotationPresentNative(Ljava/lang/Class;)Z", (cx, c) => {
  cx.info(c, MInfo.ExecAnn, () => classId(cx, c, 1), () => executableSlot(cx, c));
});
def("java/lang/reflect/Executable.compareMethodParametersInternal(Ljava/lang/reflect/Method;)I", (cx, c) => {
  cx.info(c, MInfo.CompareParams, () => executableSlot(cx, c, 0), () => executableSlot(cx, c, 1));
});
def("java/lang/reflect/Field.isAnnotationPresentNative(Ljava/lang/Class;)Z", (cx, c) => { cx.info(c, MInfo.FieldAnn, () => classId(cx, c, 1), () => { c.lget(0); fieldId(cx, c); }); });
// the Method or Constructor a local or anonymous class is declared in
for (const [key, ctor] of [["getEnclosingMethodNative()Ljava/lang/reflect/Method;", 0], ["getEnclosingConstructorNative()Ljava/lang/reflect/Constructor;", 1]] as const) {
  def(`java/lang/Class.${key}`, (cx, c) => {
    const cid = c.newLocal(T.i32), idx = c.newLocal(T.i32);
    cx.info(c, MInfo.EnclosingClass, () => classId(cx, c, 0), () => c.i32(ctor)); c.lset(cid);
    cx.info(c, MInfo.EnclosingIndex, () => classId(cx, c, 0), () => c.i32(ctor)); c.lset(idx);
    c.lget(cid).i32(0).raw(OP.i32_lt_s).if_(T.anyref).anyNull().else_().lget(cid).lget(idx).i32(ctor); cx.callRt(c, "mkExec"); c.end();
  });
}
