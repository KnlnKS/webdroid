// Annotations as objects (art/runtime/dex/dex_file_annotations.cc): the run-time visible annotations of a class, method, field or parameter, each made by
// libcore's own AnnotationFactory.createAnnotation(type, AnnotationMember[]) (an InvocationHandler over a Proxy, see proxy.ts), whose members carry the
// values the dex encodes, typed by the return type of the annotation's method: boxed primitives, Strings, Class objects, enum constants, nested
// annotations and arrays of these. Method.getDefaultValue and the Signature annotation (generic types) come from the same section.
import { javaName, kindOf, type JClass, type Kind, typeName } from "../compiler/program.ts";
import { idOfClass, fieldId } from "./classes.ts";

import { executableSlot, methodAt } from "./reflect.ts";
import { PRIMS } from "../../jvm/abi.ts";
import type { EncAnnotation, EncVal } from "../../jvm/dex.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import { PerWorld } from "./perworld.ts";
import { type Strand } from "./sched.ts";
import { HT, T } from "../compiler/wasmbin.ts";
import { emitRestored, emitSettled } from "../compiler/hostcalls.ts";

const FACTORY = "libcore/reflect/AnnotationFactory", MEMBER = "libcore/reflect/AnnotationMember";
const ANNOTATION_DEFAULT = "dalvik/annotation/AnnotationDefault", SIGNATURE = "dalvik/annotation/Signature", PERMITTED = "dalvik/annotation/PermittedSubclasses";
const METHOD_PARAMETERS = "dalvik/annotation/MethodParameters";
const RUNTIME = 1, SYSTEM = 2;

const Ann = { Class: 0, Executable: 1, Field: 2, ExecutableParams: 3, DefaultValue: 4, SignatureOfClass: 5, SignatureOfExecutable: 6, SignatureOfField: 7, PermittedSubclasses: 8, Parameters: 9 } as const;
type Ann = (typeof Ann)[keyof typeof Ann];
/** the system annotation whose `value` each kind answers, and that value's type */
const SYSTEM_VALUES = new Map<number, [string, string]>([[Ann.SignatureOfClass, [SIGNATURE, "[Ljava/lang/String;"]], [Ann.SignatureOfExecutable, [SIGNATURE, "[Ljava/lang/String;"]],
  [Ann.SignatureOfField, [SIGNATURE, "[Ljava/lang/String;"]], [Ann.PermittedSubclasses, [PERMITTED, "[Ljava/lang/Class;"]]]);
const Element = { Class: 0, Field: 1, Method: 2 } as const;
type Element = (typeof Element)[keyof typeof Element];
/** the element each kind asks about */
const ELEMENT: Record<Ann, Element> = {
  [Ann.Class]: Element.Class, [Ann.SignatureOfClass]: Element.Class, [Ann.PermittedSubclasses]: Element.Class,
  [Ann.Field]: Element.Field, [Ann.SignatureOfField]: Element.Field,
  [Ann.Executable]: Element.Method, [Ann.ExecutableParams]: Element.Method, [Ann.DefaultValue]: Element.Method, [Ann.SignatureOfExecutable]: Element.Method, [Ann.Parameters]: Element.Method,
};

/** the annotations of the element whose object the host was given */
function elementOf(w: World, kind: number, a: number): { set: EncAnnotation[]; params?: EncAnnotation[][] } {
  const classOf = (id: number): JClass | undefined => w.prog.get(w.nameOf(id));
  // an array or primitive class has no definition, so no annotations
  const element = ELEMENT[kind as Ann];
  if (element === Element.Class) { const jc = classOf(a); return { set: jc?.dex && jc.def ? w.prog.typesOf(jc.dex).classAnnotations(jc.def).cls : [] }; }
  if (element === Element.Field) {
    const jc = classOf(a >>> 12)!, ids = jc.def ? [...jc.def.staticFields, ...jc.def.instanceFields] : [];
    return { set: jc.def ? w.prog.typesOf(jc.dex!).classAnnotations(jc.def).fields.get(ids[a & 0xfff].fieldIdx) ?? [] : [] };
  }
  const m = methodAt(w, a), jc = w.prog.get(m.cls)!, all = jc.def ? w.prog.typesOf(jc.dex!).classAnnotations(jc.def) : undefined;
  return { set: all?.methods.get(m.methodIdx) ?? [], params: all?.params.get(m.methodIdx) };
}
const ofKind = (set: EncAnnotation[], visibility: number) => set.filter((x) => x.visibility === visibility);

const states = new PerWorld(make);
function make(w: World) {
  const fn = w.helpers.hostFn.bind(w.helpers);
  const java = (name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void) =>
    (strand: Strand, ...args: unknown[]) => w.helpers.mayWait(strand, name, params, ret, body, args);
  const classOf = fn("an:classOf", ["I"], "L", (cx, c) => { c.lget(0); cx.callRt(c, "classOf"); });
  const mkExec = fn("an:mkExec", ["I", "I", "I"], "L", (cx, c) => { c.lget(0).lget(1).lget(2); cx.callRt(c, "mkExec"); });
  const newArray = (desc: string) => fn("an:new:" + desc, ["I"], "L", (cx, c) => cx.emitNewArray(c, desc, () => c.lget(0)));
  const box = (letter: string) => {
    const cls = PRIMS[letter].box;
    return java("an:box:" + letter, [kindOf(letter)], "L", (cx, c, arg) => { cx.emitEnsure(c, cls); arg(0); cx.callMethod(c, cx.prog.resolve(cls, "valueOf", `(${letter})L${cls};`)!); });
  };
  const call = (cls: string, name: string, desc: string, params: Kind[], ret: "I" | "L" | "V") =>
    java(`an:call:${cls}.${name}${desc}`, params, ret, (cx, c, arg) => { cx.emitEnsure(c, cls); params.forEach((_, i) => arg(i)); cx.callMethod(c, cx.prog.resolve(cls, name, desc)!); });
  const enumConstant = (cls: string, name: string, desc: string) => java(`an:enum:${cls}.${name}`, [], "L", (cx, c) => { cx.emitEnsure(c, cls); c.gget(cx.staticGlobal(cls, name, desc)); });
  const construct = (cls: string, desc: string, params: Kind[]) =>
    java(`an:new:${cls}${desc}`, params, "L", (cx, c, arg) => cx.construct(c, cx.prog.resolve(cls, "<init>", desc)!, () => params.forEach((_, i) => arg(i))));
  return {
    classOf, mkExec, newArray, box,
    create: call(FACTORY, "createAnnotation", `(Ljava/lang/Class;[L${MEMBER};)Ljava/lang/annotation/Annotation;`, ["L", "L"], "L"),
    member: construct(MEMBER, `(Ljava/lang/String;Ljava/lang/Object;Ljava/lang/Class;Ljava/lang/reflect/Method;)V`, ["L", "L", "L", "L"]),
    typeNotPresent: construct("java/lang/TypeNotPresentException", "(Ljava/lang/String;Ljava/lang/Throwable;)V", ["L", "L"]),
    enumNotPresent: construct("java/lang/EnumConstantNotPresentException", "(Ljava/lang/Class;Ljava/lang/String;)V", ["L", "L"]),
    enumConstant,
    parameter: construct("java/lang/reflect/Parameter", "(Ljava/lang/String;ILjava/lang/reflect/Executable;I)V", ["L", "I", "L", "I"]),
  };
}

/** the Java array of `items` with element descriptor `elem` */
function arrayOf(w: World, s: ReturnType<typeof make>, elem: string, items: unknown[]): object {
  const j = s.newArray("[" + elem)(items.length);
  items.forEach((x, i) => w.bridge.setElement(j, i, x));
  return j;
}

/** a Java value for the encoded `v` of an annotation element whose method returns `desc` */
function* valueOf(w: World, s: ReturnType<typeof make>, strand: Strand, dex: EncAnnotation["dex"], v: EncVal, desc: string): Generator<unknown, unknown, any> {
  const bits = (letter: string, x: number | bigint | boolean) => {
    if (letter === "F") { const f = new Float32Array(1); f[0] = Number(x); return new Int32Array(f.buffer)[0]; }
    if (letter === "D") { const f = new Float64Array(1); f[0] = Number(x); return new BigInt64Array(f.buffer)[0]; }
    return letter === "J" ? BigInt(x as bigint | number) : Number(x);
  };
  if (desc.length === 1) return yield s.box(desc)(strand, bits(desc, v as number));
  if (desc[0] === "[") {
    const elem = desc.slice(1), items = v as EncVal[];
    // a primitive array is filled on the host and copied in
    if (elem.length === 1) return w.bridge.toJava(PRIMS[elem].array.from(items.map((x) => (elem === "J" ? BigInt(x as bigint | number) : Number(x))) as never), desc);
    const values: unknown[] = [];
    for (const x of items) values.push(yield* valueOf(w, s, strand, dex, x, elem));
    return arrayOf(w, s, elem, values);
  }
  if (v === null) return v;
  if (typeof v === "string") return w.javaString(v);
  const ref = v as { kind: string; idx: number; anno?: EncAnnotation };
  if (ref.kind === "type") {
    const name = typeName(w.prog.typesOf(dex).type(ref.idx));
    return name[0] === "#" || name[0] === "[" || w.prog.get(name) ? s.classOf(w.idOf(name)) : yield s.typeNotPresent(strand, w.javaString(javaName(name).replace(/\//g, ".")), null);
  }
  if (ref.kind === "enum") {
    const fr = dex.field(ref.idx), cls = w.prog.typesOf(dex).typeName(fr.cls), jc = w.prog.get(cls), f = jc?.fields.find((x) => x.isStatic && x.name === fr.name);
    return yield (f ? s.enumConstant(cls, f.name, f.desc)(strand) : s.enumNotPresent(strand, s.classOf(w.idOf(cls)), w.javaString(fr.name)));
  }
  if (ref.kind === "annotation") return yield* annotation(w, s, strand, ref.anno!);
  throw new Error(`annotation value of kind ${ref.kind}`);
}

/** the annotation object for `a`: its members are the elements it sets, those its type defaults come from AnnotationFactory itself */
function* annotation(w: World, s: ReturnType<typeof make>, strand: Strand, a: EncAnnotation): Generator<unknown, object, any> {
  const type = w.prog.get(a.type)!, members: object[] = [];
  for (const [name, value] of Object.entries(a.elements)) {
    const index = type.methods.findIndex((m) => m.name === name && !m.params.length), m = type.methods[index];
    if (!m) continue; // an element the annotation class no longer declares
    const v = yield* valueOf(w, s, strand, a.dex, value, m.ret);
    members.push(yield s.member(strand, w.javaString(name), v, s.classOf(w.idOf(typeName(m.ret))), s.mkExec(w.idOf(type.name), index, 0)));
  }
  return yield s.create(strand, s.classOf(w.idOf(a.type)), arrayOf(w, s, `L${MEMBER};`, members));
}

/** host.annotation(kind, a, b, arg): the objects ART's annotation natives answer; `arg` is the call's object argument, if it has one: the
 *  annotation Class asked for, or the Executable whose Parameters are asked for */
export function hostObject(w: World, kind: number, a: number, b: number, arg: object | null): object | null | Promise<object | null> {
  const strand = w.sched.current(), materialize = objects(w, strand, kind, a, b, arg);
  // Keep immediate reflection immediate; only an actual Java wait switches stacks.
  const advance = (value?: unknown, failed = false): object | null | Promise<object | null> => {
    let step = failed ? materialize.throw(value) : materialize.next(value);
    while (!step.done) {
      if (step.value instanceof Promise) return step.value.then(v => advance(v), e => advance(e, true));
      step = materialize.next(step.value);
    }
    return step.value;
  };
  return advance();
}
function* objects(w: World, strand: Strand, kind: number, a: number, b: number, arg: object | null): Generator<unknown, object | null, any> {
  const s = states.get(w);
  const system = SYSTEM_VALUES.get(kind);
  if (system) {
    const hit = ofKind(elementOf(w, kind, a).set, SYSTEM).find((x) => x.type === system[0]), v = hit?.elements.value;
    return Array.isArray(v) ? (yield* valueOf(w, s, strand, hit!.dex, v, system[1])) as object : null;
  }
  if (kind === Ann.DefaultValue) {
    // the AnnotationDefault of the method's annotation class holds a nested annotation whose elements are the defaults
    const m = methodAt(w, a), jc = w.prog.get(m.cls)!;
    const holder = jc.def ? w.prog.typesOf(jc.dex!).classAnnotations(jc.def).cls : [], def = ofKind(holder, SYSTEM).find((x) => x.type === ANNOTATION_DEFAULT)?.elements.value as { anno?: EncAnnotation } | undefined;
    const v = def?.anno?.elements[m.name];
    return v === undefined ? null : (yield* valueOf(w, s, strand, jc.dex!, v, m.ret)) as object;
  }
  const { set, params } = elementOf(w, kind, a);
  if (kind === Ann.Parameters) {
    // Executable.getParameters0: the MethodParameters names and flags; Java checks their count
    const hit = ofKind(set, SYSTEM).find((x) => x.type === METHOD_PARAMETERS), names = hit?.elements.names, flags = hit?.elements.accessFlags;
    if (!Array.isArray(names) || !Array.isArray(flags)) return null;
    const parameters: object[] = [];
    for (const [i, name] of names.entries()) parameters.push(yield s.parameter(strand, typeof name === "string" ? w.javaString(name) : null, Number(flags[i] ?? 0), arg, i));
    return arrayOf(w, s, "Ljava/lang/reflect/Parameter;", parameters);
  }
  if (kind === Ann.ExecutableParams) {
    if (!params) return null;
    const groups: object[] = [];
    for (const p of params) {
      const annotations: object[] = [];
      for (const x of ofKind(p, RUNTIME)) annotations.push(yield* annotation(w, s, strand, x));
      groups.push(arrayOf(w, s, "Ljava/lang/annotation/Annotation;", annotations));
    }
    return arrayOf(w, s, "[Ljava/lang/annotation/Annotation;", groups);
  }
  const runtime = ofKind(set, RUNTIME);
  if (arg) {
    const want = w.nameOf(w.helpers.fieldReader<number>("java/lang/Class", "dexTypeIndex", "I")(arg)), hit = runtime.find((x) => x.type === want);
    return hit ? yield* annotation(w, s, strand, hit) : null;
  }
  const annotations: object[] = [];
  for (const x of runtime) annotations.push(yield* annotation(w, s, strand, x));
  return arrayOf(w, s, "Ljava/lang/annotation/Annotation;", annotations);
}

export const annotationIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => annotationIntrinsics.set(key, (cx, m, c) => f(cx, c));
const elementId: Record<Element, (cx: Compiler, c: Code) => void> = {
  [Element.Class]: (cx, c) => { c.lget(0); idOfClass(cx, c); },
  [Element.Field]: (cx, c) => { c.lget(0); fieldId(cx, c); },
  [Element.Method]: executableSlot,
};
/** host.annotation over the element in local 0 (kind `kind`), with the object argument in local `arg` */
function ask(cx: Compiler, c: Code, kind: Ann, arg: number | null): void {
  emitRestored(cx, c, [], [T.anyref], () => {
    c.i32(kind); elementId[ELEMENT[kind]](cx, c); c.i32(0);
    if (arg !== null) c.lget(arg).externConvertAny(); else c.refNull(HT.extern);
    c.call(cx.imp.annotation);
    emitSettled(cx, c);
  });
}
def("java/lang/Class.getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Class, null));
def("java/lang/Class.getDeclaredAnnotation(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Class, 1));
def("java/lang/reflect/Executable.getDeclaredAnnotationsNative()[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Executable, null));
def("java/lang/reflect/Executable.getAnnotationNative(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Executable, 1));
def("java/lang/reflect/Executable.getParameterAnnotationsNative()[[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.ExecutableParams, null));
def("java/lang/reflect/Field.getDeclaredAnnotations()[Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Field, null));
def("java/lang/reflect/Field.getAnnotationNative(Ljava/lang/Class;)Ljava/lang/annotation/Annotation;", (cx, c) => ask(cx, c, Ann.Field, 1));
def("java/lang/reflect/Method.getDefaultValue()Ljava/lang/Object;", (cx, c) => ask(cx, c, Ann.DefaultValue, null));
def("java/lang/Class.getSignatureAnnotation()[Ljava/lang/String;", (cx, c) => ask(cx, c, Ann.SignatureOfClass, null));
def("java/lang/reflect/Executable.getSignatureAnnotation()[Ljava/lang/String;", (cx, c) => ask(cx, c, Ann.SignatureOfExecutable, null));
def("java/lang/reflect/Field.getSignatureAnnotation()[Ljava/lang/String;", (cx, c) => ask(cx, c, Ann.SignatureOfField, null));
def("java/lang/Class.getPermittedSubclassesFromAnnotation()[Ljava/lang/Class;", (cx, c) => ask(cx, c, Ann.PermittedSubclasses, null));
def("java/lang/reflect/Executable.getParameters0()[Ljava/lang/reflect/Parameter;", (cx, c) => ask(cx, c, Ann.Parameters, 0));
