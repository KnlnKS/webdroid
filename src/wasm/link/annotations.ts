// Annotations as objects (art/runtime/dex/dex_file_annotations.cc): the run-time visible annotations of a class, method, field or parameter, each made by
// libcore's own AnnotationFactory.createAnnotation(type, AnnotationMember[]) (an InvocationHandler over a Proxy, see proxy.ts), whose members carry the
// values the dex encodes, typed by the return type of the annotation's method: boxed primitives, Strings, Class objects, enum constants, nested
// annotations and arrays of these. Method.getDefaultValue and the Signature annotation (generic types) come from the same section.
import { javaName, type JClass } from "../compiler/program";
import { descToName } from "../../jvm/abi";
import { idOfClass, fieldId, typeName } from "./classes";
import { BOX, executableSlot, methodAt } from "./reflect";
import { VIEWS } from "../compiler/copy";
import type { EncAnnotation, EncVal } from "../../jvm/dex";
import type { Code } from "../compiler/code";
import type { Compiler, Intrinsic } from "../compiler/j2w";
import type { World } from "./world";

const FACTORY = "libcore/reflect/AnnotationFactory", MEMBER = "libcore/reflect/AnnotationMember";
const ANNOTATION_DEFAULT = "dalvik/annotation/AnnotationDefault", SIGNATURE = "dalvik/annotation/Signature";
const RUNTIME = 1, SYSTEM = 2;

const enum Ann { Class, Executable, Field, ExecutableParams, DefaultValue, SignatureOfClass, SignatureOfExecutable, SignatureOfField }

/** the annotations of the element whose object the host was given, and the dex that holds them */
function elementOf(w: World, kind: Ann, a: number): { jc: JClass; set: EncAnnotation[]; params?: EncAnnotation[][] } {
  const classOf = (id: number) => w.prog.get(w.nameOf(id))!;
  if (kind === Ann.Class || kind === Ann.SignatureOfClass) { const jc = classOf(a); return { jc, set: jc.dex && jc.def ? jc.dex.classAnnotations(jc.def).cls : [] }; }
  if (kind === Ann.Field || kind === Ann.SignatureOfField) {
    const jc = classOf(a >>> 12), ids = jc.def ? [...jc.def.staticFields, ...jc.def.instanceFields] : [];
    return { jc, set: jc.def ? jc.dex!.classAnnotations(jc.def).fields.get(ids[a & 0xfff].fieldIdx) ?? [] : [] };
  }
  const m = methodAt(w, a), jc = w.prog.get(m.cls)!, all = jc.def ? jc.dex!.classAnnotations(jc.def) : undefined;
  return { jc, set: all?.methods.get(m.methodIdx) ?? [], params: all?.params.get(m.methodIdx) };
}
const ofKind = (set: EncAnnotation[], visibility: number) => set.filter((x) => x.visibility === visibility);

const states = new WeakMap<World, ReturnType<typeof make>>();
function make(w: World) {
  const fn = w.hostFn.bind(w);
  const classOf = fn("an:classOf", ["I"], "L", (cx, c) => { c.lget(0); cx.callRt(c, "classOf"); });
  const mkExec = fn("an:mkExec", ["I", "I", "I"], "L", (cx, c) => { c.lget(0).lget(1).lget(2); cx.callRt(c, "mkExec"); });
  const newArray = (desc: string) => fn("an:new:" + desc, ["I"], "L", (cx, c) => cx.emitNewArray(c, desc, () => c.lget(0)));
  const aset = fn("an:aset", ["L", "I", "L"], "V", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).lget(2).arraySet(cx.tData.ref); });
  const box = (letter: string) => {
    const [cls] = BOX[letter], bits = letter === "J" || letter === "D" ? "J" : "I";
    return fn("an:box:" + letter, [bits], "L", (cx, c) => { cx.emitEnsure(c, cls); c.lget(0); cx.callMethod(c, cx.prog.resolve(cls, "valueOf", `(${letter})L${cls};`)!); });
  };
  const call = (cls: string, name: string, desc: string, params: ("I" | "J" | "L")[], ret: "I" | "L" | "V") =>
    fn(`an:call:${cls}.${name}${desc}`, params, ret, (cx, c) => { cx.emitEnsure(c, cls); params.forEach((_, i) => c.lget(i)); cx.callMethod(c, cx.prog.resolve(cls, name, desc)!); });
  const enumConstant = (cls: string, name: string, desc: string) => fn(`an:enum:${cls}.${name}`, [], "L", (cx, c) => { cx.emitEnsure(c, cls); c.gget(cx.staticGlobal(cls, name, desc)); });
  const construct = (cls: string, desc: string, params: ("I" | "J" | "L")[]) =>
    fn(`an:new:${cls}${desc}`, params, "L", (cx, c) => {
      const o = c.newLocal(cx.vtOf("L"));
      cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(o).lget(o); params.forEach((_, i) => c.lget(i)); cx.callMethod(c, cx.prog.resolve(cls, "<init>", desc)!); c.lget(o);
    });
  return {
    classOf, mkExec, newArray, aset, box,
    create: call(FACTORY, "createAnnotation", `(Ljava/lang/Class;[L${MEMBER};)Ljava/lang/annotation/Annotation;`, ["L", "L"], "L"),
    member: construct(MEMBER, `(Ljava/lang/String;Ljava/lang/Object;Ljava/lang/Class;Ljava/lang/reflect/Method;)V`, ["L", "L", "L", "L"]),
    typeNotPresent: construct("java/lang/TypeNotPresentException", "(Ljava/lang/String;Ljava/lang/Throwable;)V", ["L", "L"]),
    enumNotPresent: construct("java/lang/EnumConstantNotPresentException", "(Ljava/lang/Class;Ljava/lang/String;)V", ["L", "L"]),
    enumConstant,
  };
}

/** the Java array of `items` with element descriptor `elem` */
function arrayOf(w: World, s: ReturnType<typeof make>, elem: string, items: unknown[]): object {
  const j = s.newArray("[" + elem)(items.length);
  items.forEach((x, i) => s.aset(j, i, x));
  return j;
}

/** a Java value for the encoded `v` of an annotation element whose method returns `desc` */
function valueOf(w: World, s: ReturnType<typeof make>, dex: EncAnnotation["dex"], v: EncVal, desc: string): unknown {
  const bits = (letter: string, x: number | bigint | boolean) => {
    if (letter === "F") { const f = new Float32Array(1); f[0] = Number(x); return new Int32Array(f.buffer)[0]; }
    if (letter === "D") { const f = new Float64Array(1); f[0] = Number(x); return new BigInt64Array(f.buffer)[0]; }
    return letter === "J" ? BigInt(x as bigint | number) : Number(x);
  };
  if (desc.length === 1) return s.box(desc)(bits(desc, v as number));
  if (desc[0] === "[") {
    const elem = desc.slice(1), items = v as EncVal[];
    // a primitive array is filled on the host and copied in
    if (elem.length === 1) return w.bridge.toJava(VIEWS[elem].from(items.map((x) => (elem === "J" ? BigInt(x as bigint | number) : Number(x))) as never), desc);
    return arrayOf(w, s, elem, items.map((x) => valueOf(w, s, dex, x, elem)));
  }
  if (v === null) return v;
  if (typeof v === "string") return w.javaString(v);
  const ref = v as { kind: string; idx: number; anno?: EncAnnotation };
  if (ref.kind === "type") {
    const name = typeName(dex.type(ref.idx));
    return name[0] === "#" || name[0] === "[" || w.prog.get(name) ? s.classOf(w.idOf(name)) : s.typeNotPresent(w.javaString(javaName(name).replace(/\//g, ".")), null);
  }
  if (ref.kind === "enum") {
    const fr = dex.field(ref.idx), cls = descToName(dex.type(fr.cls)), jc = w.prog.get(cls), f = jc?.fields.find((x) => x.isStatic && x.name === fr.name);
    return f ? s.enumConstant(cls, f.name, f.desc)() : s.enumNotPresent(s.classOf(w.idOf(cls)), w.javaString(fr.name));
  }
  if (ref.kind === "annotation") return annotation(w, s, ref.anno!);
  throw new Error(`annotation value of kind ${ref.kind}`);
}

/** the annotation object for `a`: its members are the elements it sets, those its type defaults come from AnnotationFactory itself */
function annotation(w: World, s: ReturnType<typeof make>, a: EncAnnotation): object {
  const type = w.prog.get(a.type)!, members = Object.entries(a.elements).flatMap(([name, value]) => {
    const index = type.methods.findIndex((m) => m.name === name && !m.params.length), m = type.methods[index];
    if (!m) return [];                                       // an element the annotation class no longer declares
    return [s.member(w.javaString(name), valueOf(w, s, a.dex, value, m.ret), s.classOf(w.idOf(typeName(m.ret))), s.mkExec(w.idOf(type.name), index, 0))];
  });
  return s.create(s.classOf(w.idOf(a.type)), arrayOf(w, s, `L${MEMBER};`, members));
}

/** host.obj(kind, a, b, filter): the objects ART's annotation natives answer; `filter` is the annotation Class asked for, if one is */
export function hostObject(w: World, kind: Ann, a: number, b: number, filter: object | null): object | null {
  const s = (states.get(w) ?? (states.set(w, make(w)), states.get(w)!));
  const classId = w.fieldReader("java/lang/Class", "dexTypeIndex", "I") as (c: object) => number;
  if (kind === Ann.SignatureOfClass || kind === Ann.SignatureOfExecutable || kind === Ann.SignatureOfField) {
    const { set } = elementOf(w, kind, a), sig = ofKind(set, SYSTEM).find((x) => x.type === SIGNATURE)?.elements.value;
    return Array.isArray(sig) ? arrayOf(w, s, "Ljava/lang/String;", (sig as string[]).map((x) => w.javaString(x))) : null;
  }
  if (kind === Ann.DefaultValue) {
    // the AnnotationDefault of the method's annotation class holds a nested annotation whose elements are the defaults
    const m = methodAt(w, a), jc = w.prog.get(m.cls)!;
    const holder = jc.def ? jc.dex!.classAnnotations(jc.def).cls : [], def = ofKind(holder, SYSTEM).find((x) => x.type === ANNOTATION_DEFAULT)?.elements.value as { anno?: EncAnnotation } | undefined;
    const v = def?.anno?.elements[m.name];
    return v === undefined ? null : valueOf(w, s, jc.dex!, v, m.ret) as object;
  }
  const { set, params } = elementOf(w, kind, a);
  if (kind === Ann.ExecutableParams) {
    if (!params) return null;
    return arrayOf(w, s, "[Ljava/lang/annotation/Annotation;", params.map((p) => arrayOf(w, s, "Ljava/lang/annotation/Annotation;", ofKind(p, RUNTIME).map((x) => annotation(w, s, x)))));
  }
  const runtime = ofKind(set, RUNTIME);
  if (filter) {
    const want = w.nameOf(classId(filter)), hit = runtime.find((x) => x.type === want);
    return hit ? annotation(w, s, hit) : null;
  }
  return arrayOf(w, s, "Ljava/lang/annotation/Annotation;", runtime.map((x) => annotation(w, s, x)));
}

export const annotationIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => annotationIntrinsics.set(key, (cx, m, c) => f(cx, c));
/** host.obj over the element in local 0 (kind `kind`), with the annotation Class in local 1 when `filtered` */
function ask(cx: Compiler, c: Code, kind: Ann, element: () => void, filtered: boolean): void {
  c.i32(kind); element(); c.i32(0);
  if (filtered) c.lget(1).externConvertAny(); else c.refNull(-17);        // an extern null
  c.call(cx.imp.obj).anyConvertExtern();
}
const classId = (cx: Compiler, c: Code) => { c.lget(0); idOfClass(cx, c); };
const field = (cx: Compiler, c: Code) => { c.lget(0); fieldId(cx, c); };
def("java/lang/Class.getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Class, () => classId(cx, c), false));
def("java/lang/Class.getDeclaredAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Class, () => classId(cx, c), true));
def("java/lang/reflect/Executable.getDeclaredAnnotationsNative()[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Executable, () => executableSlot(cx, c), false));
def("java/lang/reflect/Executable.getAnnotationNative(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Executable, () => executableSlot(cx, c), true));
def("java/lang/reflect/Executable.getParameterAnnotationsNative()[[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.ExecutableParams, () => executableSlot(cx, c), false));
def("java/lang/reflect/Field.getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Field, () => field(cx, c), false));
def("java/lang/reflect/Field.getAnnotationNative(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Field, () => field(cx, c), true));
def("java/lang/reflect/Method.getDefaultValue()Ljava/lang/Object;", (cx, c) => ask(cx, c, Ann.DefaultValue, () => executableSlot(cx, c), false));
def("java/lang/Class.getSignatureAnnotation()[Ljava/lang/String;", (cx, c) => ask(cx, c, Ann.SignatureOfClass, () => classId(cx, c), false));
def("java/lang/reflect/Executable.getSignatureAnnotation()[Ljava/lang/String;", (cx, c) => ask(cx, c, Ann.SignatureOfExecutable, () => executableSlot(cx, c), false));
def("java/lang/reflect/Field.getSignatureAnnotation()[Ljava/lang/String;", (cx, c) => ask(cx, c, Ann.SignatureOfField, () => field(cx, c), false));
