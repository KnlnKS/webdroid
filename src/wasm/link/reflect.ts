// java.lang.reflect.Method and Constructor over the program's own classes: lookup by name and parameter classes, the signature accessors,
// and invocation. A member is identified by a cookie, Executable.artMethod = class id << 16 | index in the class's methods, and
// Executable's other fields (declaringClass, accessFlags, dexMethodIndex) are filled as ART does. Invoking is a generated thunk per
// method (host.info hands out its table slot): it unboxes the Object[] into the method's parameters, dispatches as the invoke
// instruction would, boxes the result and wraps what the method throws in InvocationTargetException.
import { OP } from "../compiler/code.ts";
import { T, refNull } from "../compiler/wasmbin.ts";
import { ACC, kindOf, type JClass, type MethodInfo, typeName } from "../compiler/program.ts";
import { descToName } from "../../jvm/abi.ts";
import { idOfClass, emitName, Member } from "./classes.ts";
import { UInfo, RInfo, TextKind } from "../compiler/info.ts";
import { WIDEN, BOX, box } from "../compiler/primitives.ts";
import { rt, type Synth } from "../compiler/rtfns.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import { memberArg, synthFamily } from "./synths.ts";
import { PerWorld } from "./perworld.ts";

const EXEC = "java/lang/reflect/Executable", METHOD = "java/lang/reflect/Method", CTOR = "java/lang/reflect/Constructor";
const CLASS_ARRAY = "[Ljava/lang/Class;";
const ITE = "java/lang/reflect/InvocationTargetException";


/** the member classes a class lists in its dalvik.annotation.MemberClasses system annotation */
function members(w: World, jc: JClass | undefined): string[] {
  if (!jc?.def) return [];
  const types = w.prog.typesOf(jc.dex!), v = types.classAnnotations(jc.def).cls.find((x) => x.type === "dalvik/annotation/MemberClasses")?.elements.value;
  return Array.isArray(v) ? v.flatMap((e) => e && typeof e === "object" && "idx" in e ? [types.typeName(e.idx)] : []) : [];
}

/** the class ids of a method's parameter and return types in a World, which a lookup compares for every method of a class */
const sigs = new PerWorld(() => new WeakMap<MethodInfo, { params: number[]; ret: number }>(), "rebound");
function sigOf(w: World, m: MethodInfo) {
  const byMethod = sigs.get(w);
  let s = byMethod.get(m); if (!s) byMethod.set(m, s = { params: m.params.map((p) => w.idOf(typeName(p))), ret: w.idOf(typeName(m.ret)) });
  return s;
}

export function hostReflect(w: World, kind: number, a: number, b: number): number {
  const jc = w.prog.get(w.nameOf(a));
  if (kind === RInfo.MethodCount) return jc?.def ? jc.methods.length : 0;
  if (kind === RInfo.IfaceCount) return jc?.ifaces.length ?? 0;
  if (kind === RInfo.Iface) return w.idOf(jc!.ifaces[b]);
  if (kind === RInfo.SerialInit) return jc?.byKey.has("<init>()V") ? w.synthSlot("sinit:" + jc.name) : 0;
  if (kind === RInfo.MemberCount) return members(w, jc).length;
  if (kind === RInfo.Member) return w.idOf(members(w, jc)[b]);
  const m = jc!.methods[kind === RInfo.MethodParamType ? b >> 8 : b];
  switch (kind) {
    case RInfo.MethodParams: return m.params.length;
    case RInfo.MethodParamType: return sigOf(w, m).params[b & 0xff];
    case RInfo.MethodRet: return sigOf(w, m).ret;
    case RInfo.MethodFlags: return m.flags;
    case RInfo.MethodSlot: return w.slotOf(m);
    case RInfo.MethodInvoke: return w.synthSlot(`invoke:${jc!.name}:${b}`);
    case RInfo.MethodCall: return w.synthSlot(`call:${jc!.name}:${b}`);
    case RInfo.MethodCallDirect: return w.synthSlot(`callDirect:${jc!.name}:${b}`);
  }
  return 0;
}
synthFamily("sinit", (w, name) => {
  const init = w.prog.get(name)?.byKey.get("<init>()V");
  return init && { params: ["L"], ret: "V", body: (cx, c) => { cx.emitEnsure(c, init.cls); c.lget(0); cx.callMethod(c, init); } };
}, true);
/** a reflective call of method `index` of a class: Method.invoke's, which checks its arguments and wraps what the method throws (`wrap`), or a plain one that
 *  dispatches or not (`direct`) */
const reflectiveCall = (wrap: boolean, direct: boolean) => (w: World, arg: string): Synth | undefined => {
  const [name, index] = memberArg(arg), m = w.prog.get(name)?.methods[index];
  return m && { params: ["L", "L"], ret: "L", body: (cx, c) => invokeBody(cx, c, m, wrap, direct) };
};
synthFamily("invoke", reflectiveCall(true, false), true);
synthFamily("call", reflectiveCall(false, false), true);
synthFamily("callDirect", reflectiveCall(false, true), true);

export function methodAt(w: World, slot: number): MethodInfo {
  const m = w.slots.methodAt(slot);
  if (!m) throw new Error(`invalid executable slot ${slot}`);
  return m;
}

/** the thunk body: params (receiver, Object[]) -> Object. Method.invoke wraps what the method throws in InvocationTargetException (`wrap`); a method handle
 *  lets it through, and calls the method itself rather than the receiver's override when it invokes a super or direct method. */
function invokeBody(cx: Compiler, c: Code, m: MethodInfo, wrap: boolean, direct: boolean): void {
  const ctor = m.isCtor, args = c.newLocal(refNull(cx.tData.ref)), e = c.newLocal(T.anyref), w = c.newLocal(T.anyref);
  if (wrap) {
    // ART checks the number of arguments, the receiver and each argument's type before anything runs
    const given = c.newLocal(T.i32);
    c.lget(1).refIsNull().if_(T.i32).i32(0).else_().lget(1).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).arrayLen().end().lset(given);
    c.lget(given).i32(m.params.length).raw(OP.i32_ne).if_().i32(m.params.length).lget(given); cx.callThrower(c, "iarity"); c.end();
  }
  if (m.params.length) c.lget(1).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lset(args);
  // the receiver and the arguments are checked, and converted, before the call and outside what InvocationTargetException wraps
  if (!ctor && !m.isStatic) {
    c.lget(0); cx.nullCheck(c);
    if (wrap) { c.lget(0); cx.emitInstanceOf(c, m.cls); c.raw(OP.i32_eqz).if_().i32(cx.idOf(m.cls)).lget(0); cx.vtId(c); cx.callThrower(c, "recv"); c.end(); }
  }
  const values = m.params.map((p, i) => {
    const v = c.newLocal(cx.vtOf(kindOf(p))), ty = cx.idOf(typeName(p));
    c.lget(args).refAsNonNull().i32(i).arrayGet(cx.tData.ref);
    if (BOX[p]) { c.i32(p.charCodeAt(0)).i32(i).i32(ty); cx.callRt(c, "argp"); if (kindOf(p) === "I") c.raw(OP.i32_wrap_i64); }
    else if (wrap && p !== "Ljava/lang/Object;") {
      const a = c.newLocal(T.anyref);
      c.lset(a).lget(a).refIsNull().raw(OP.i32_eqz).if_().lget(a); cx.emitInstanceOf(c, descToName(p)); c.raw(OP.i32_eqz).if_();
      c.i32(i).i32(ty).lget(a); cx.vtId(c); cx.callThrower(c, "iarg"); c.end().end();
      c.lget(a);
    }
    return c.lset(v), v;
  });
  if (wrap) c.block(T.anyref).block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
  if (ctor) cx.construct(c, m, () => { for (const v of values) c.lget(v); });
  else callBoxed(cx, c, m, direct, values);
  if (!wrap) return;
  c.br(2).end().unreachable().end();
  // what the method threw, wrapped
  const ite = cx.prog.resolve(ITE, "<init>", "(Ljava/lang/Throwable;)V");
  c.lset(e); cx.emitNew(c, ITE); c.lset(w);
  if (ite) { c.lget(w).lget(e); cx.callMethod(c, ite); }
  c.lget(w).throw_(cx.tag).end();
}

/** calls method `m` as the invoke instruction would, on the receiver in local 0, and boxes what it answers */
function callBoxed(cx: Compiler, c: Code, m: MethodInfo, direct: boolean, values: number[]): void {
  if (m.isStatic) cx.emitEnsure(c, m.cls); else c.lget(0);
  for (const v of values) c.lget(v);
  const decl = cx.prog.get(m.cls)!;
  if (m.isStatic || direct || m.flags & (ACC.PRIVATE | ACC.FINAL) || decl.flags & ACC.FINAL) cx.callMethod(c, m);
  else {
    const ps: ("I" | "J" | "L")[] = ["L", ...m.params.map(kindOf)], sig = cx.sig(ps, m.ret === "V" ? "V" : kindOf(m.ret));
    c.lget(0).call(cx.helper("vtab"));
    cx.emitDispatchSlot(c, m.cls, m.key);
    c.callIndirect(sig);
  }
  if (m.ret === "V") c.anyNull();
  else if (BOX[m.ret]) box(cx, c, m.ret);
}

const execField = (cx: Compiler, cls: string, name: string, d: string) => cx.fieldIndex(cls, { owner: EXEC, name, desc: d });
const info = (cx: Compiler, c: Code, kind: RInfo, cid: number, b: () => void = () => c.i32(0)) => cx.info(c, kind, () => c.lget(cid), b);

// mkExec(cid, idx, ctor): the Method or Constructor object of a method of class cid
rt("mkExec", ["I", "I", "I"], "L", (cx, c) => {
  for (const [cls, flag] of [[CTOR, 1], [METHOD, 0]] as const) {
    const st = cx.structFor(cls), o = c.newLocal(refNull(st));
    c.lget(2).i32(flag).raw(OP.i32_eq).if_();
    cx.emitNew(c, cls); c.refCast(st).lset(o);
    const set = (name: string, d: string, v: () => void) => { c.lget(o); v(); c.structSet(st, execField(cx, cls, name, d)); };
    set("artMethod", "J", () => c.lget(0).raw(OP.i64_extend_i32_u).i64(16n).raw(OP.i64_shl).lget(1).raw(OP.i64_extend_i32_u, OP.i64_or));
    set("declaringClass", "Ljava/lang/Class;", () => { c.lget(0); cx.callRt(c, "classOf"); });
    set("accessFlags", "I", () => info(cx, c, RInfo.MethodFlags, 0, () => c.lget(1)));
    set("dexMethodIndex", "I", () => c.lget(1));
    c.lget(o).ret().end();
  }
  c.anyNull();
});
// findMethod(cid, name, params, ctor): the index of the declared method (constructor: name null) with those parameter classes, or -1. The host names the
// candidates (findMember); their parameter classes are compared here
rt("findMethod", ["I", "L", "L", "I"], "I", (cx, c) => {
  const name = c.newLocal(T.externref), k = c.newLocal(T.i32), plen = c.newLocal(T.i32), i = c.newLocal(T.i32), pdata = c.newLocal(refNull(cx.tData.ref));
  c.lget(1); cx.str.toHost(c); c.lset(name);
  c.lget(2).refIsNull().raw(OP.i32_eqz).if_().lget(2).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lset(pdata).lget(pdata).refAsNonNull().arrayLen().lset(plen).end();
  const next = (from: () => void) => { c.lget(0).lget(name).lget(3).lget(plen); from(); c.call(cx.imp.findMember).lset(k); };
  next(() => c.i32(0));
  c.block().loop().lget(k).i32(0).raw(OP.i32_lt_s).brIf(1);
  c.i32(0).lset(i);
  c.block().loop().lget(i).lget(plen).raw(OP.i32_ge_s).if_().lget(k).ret().end();
  c.lget(pdata).refAsNonNull().lget(i).arrayGet(cx.tData.ref); idOfClass(cx, c);
  info(cx, c, RInfo.MethodParamType, 0, () => c.lget(k).i32(8).raw(OP.i32_shl).lget(i).raw(OP.i32_or)); c.raw(OP.i32_ne).brIf(1);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  next(() => c.lget(k).i32(1).raw(OP.i32_add)); c.br(0).end().end().i32(-1);
});
// classArray(cid, k, what): the Class[] of the parameter classes (what 0) of method k, of the direct interfaces (what 1), or of the member classes (what 2)
rt("classArray", ["I", "I", "I"], "L", (cx, c) => {
  const n = c.newLocal(T.i32), i = c.newLocal(T.i32), w = c.newLocal(refNull(cx.tArr.ref)), data = c.newLocal(refNull(cx.tData.ref));
  const pick = (members: () => void, ifaces: () => void, params: () => void) => {
    c.lget(2).i32(2).raw(OP.i32_eq).if_(T.i32); members(); c.else_().lget(2).if_(T.i32); ifaces(); c.else_(); params(); c.end().end();
  };
  pick(() => info(cx, c, RInfo.MemberCount, 0), () => info(cx, c, RInfo.IfaceCount, 0), () => info(cx, c, RInfo.MethodParams, 0, () => c.lget(1))); c.lset(n);
  cx.emitNewArray(c, CLASS_ARRAY, () => c.lget(n)); c.refCast(cx.tArr.ref).lset(w).lget(w).structGet(cx.tArr.ref, 2).lset(data);
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(data).refAsNonNull().lget(i);
  pick(() => info(cx, c, RInfo.Member, 0, () => c.lget(i)), () => info(cx, c, RInfo.Iface, 0, () => c.lget(i)),
    () => info(cx, c, RInfo.MethodParamType, 0, () => c.lget(1).i32(8).raw(OP.i32_shl).lget(i).raw(OP.i32_or)));
  cx.callRt(c, "classOf"); c.arraySet(cx.tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  c.lget(w);
});

// ---------- intrinsics
export const reflectIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => reflectIntrinsics.set(key, (cx, m, c) => f(cx, c));
/** the full-width class id and method index of an Executable */
function cookie(cx: Compiler, c: Code, local = 0): [number, number] {
  const cid = c.newLocal(T.i32), idx = c.newLocal(T.i32), art = c.newLocal(T.i64), st = cx.structFor(EXEC);
  c.lget(local).refCast(st).structGet(st, cx.fieldIndex(EXEC, { owner: EXEC, name: "artMethod", desc: "J" })).lset(art);
  c.lget(art).i64(16n).raw(OP.i64_shr_u, OP.i32_wrap_i64).lset(cid).lget(art).raw(OP.i32_wrap_i64).i32(0xffff).raw(OP.i32_and).lset(idx);
  return [cid, idx];
}
export function executableSlot(cx: Compiler, c: Code, local = 0): void {
  const [cid, idx] = cookie(cx, c, local);
  cx.info(c, RInfo.MethodSlot, () => c.lget(cid), () => c.lget(idx));
}
const exec = (cx: Compiler, c: Code, nameLocal: number | null, paramsLocal: number, ctor: 0 | 1) => {
  const cid = c.newLocal(T.i32), idx = c.newLocal(T.i32);
  c.lget(0); idOfClass(cx, c); c.lset(cid);
  c.lget(cid); nameLocal === null ? c.anyNull() : c.lget(nameLocal); c.lget(paramsLocal).i32(ctor ? Member.Ctor : Member.Method); cx.callRt(c, "findMethod"); c.ltee(idx).i32(0).raw(OP.i32_lt_s);
  c.if_(T.anyref).anyNull().else_().lget(cid).lget(idx).i32(ctor); cx.callRt(c, "mkExec"); c.end();
};
def("java/lang/Class.getDeclaredMethodInternal(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;", (cx, c) => exec(cx, c, 1, 2, 0));
def("java/lang/Class.getDeclaredConstructorInternal([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;", (cx, c) => exec(cx, c, null, 1, 1));
def("java/lang/Class.getDeclaredClasses()[Ljava/lang/Class;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.i32(0).i32(2); cx.callRt(c, "classArray"); });
def("java/lang/Class.getInterfacesInternal()[Ljava/lang/Class;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.i32(0).i32(1); cx.callRt(c, "classArray"); });
def("java/lang/reflect/Executable.getMethodNameInternal()Ljava/lang/String;", (cx, c) => {
  const [cid, idx] = cookie(cx, c);
  emitName(cx, c, TextKind.MethodName, () => c.lget(cid), () => c.lget(idx));
});
def("java/lang/reflect/Executable.getMethodReturnTypeInternal()Ljava/lang/Class;", (cx, c) => { const [cid, idx] = cookie(cx, c); info(cx, c, RInfo.MethodRet, cid, () => c.lget(idx)); cx.callRt(c, "classOf"); });
def("java/lang/reflect/Executable.getParameterCountInternal()I", (cx, c) => { const [cid, idx] = cookie(cx, c); info(cx, c, RInfo.MethodParams, cid, () => c.lget(idx)); });
def("java/lang/reflect/Executable.getParameterTypesInternal()[Ljava/lang/Class;", (cx, c) => { const [cid, idx] = cookie(cx, c); c.lget(cid).lget(idx).i32(0); cx.callRt(c, "classArray"); });
const invoke = (cx: Compiler, c: Code, recv: () => void, args: number) => {
  const [cid, idx] = cookie(cx, c);
  recv(); c.lget(args); info(cx, c, RInfo.MethodInvoke, cid, () => c.lget(idx)); c.callIndirect(cx.sig(["L", "L"], "L"));
};
def("java/lang/reflect/Method.invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;", (cx, c) => invoke(cx, c, () => c.lget(1), 2));
// Constructor.newInstanceFromSerialization(ctorClass, allocClass): an instance of allocClass whose fields ctorClass's no-argument constructor initializes (java.io's
// deserialization makes objects this way, with the first non-serializable superclass's constructor)
def("java/lang/reflect/Constructor.newInstanceFromSerialization(Ljava/lang/Class;Ljava/lang/Class;)Ljava/lang/Object;", (cx, c) => {
  const alloc = c.newLocal(T.i32), obj = c.newLocal(T.anyref), init = c.newLocal(T.i32);
  c.lget(1); idOfClass(cx, c); c.lset(alloc);
  cx.info(c, UInfo.AllocInstance, () => c.lget(alloc)); c.ltee(alloc).raw(OP.i32_eqz).if_(); cx.callThrower(c, "inste"); c.end();
  c.lget(alloc).callIndirect(cx.sig([], "L")).lset(obj);
  c.lget(0); idOfClass(cx, c); c.lset(init);
  info(cx, c, RInfo.SerialInit, init); c.ltee(init).raw(OP.i32_eqz).if_(); cx.callThrower(c, "inste"); c.end();
  c.lget(obj).lget(init).callIndirect(cx.sig(["L"], "V")).lget(obj);
});
def("java/lang/reflect/Constructor.newInstance0([Ljava/lang/Object;)Ljava/lang/Object;", (cx, c) => invoke(cx, c, () => c.anyNull(), 1));

// argp(value, letter, index, type id): a Method.invoke argument for a primitive parameter of type `letter`, as bits: the wrapper of that type or of one that
// widens to it, and anything else (null included) is an IllegalArgumentException
rt("argp", ["L", "I", "I", "I"], "J", (cx, c) => {
  c.lget(0).refIsNull().if_().lget(2).lget(3).i32(-1); cx.callThrower(c, "iarg"); c.end();
  for (const target of Object.keys(WIDEN)) {
    c.lget(1).i32(target.charCodeAt(0)).raw(OP.i32_eq).if_();
    for (const from of Object.keys(WIDEN).filter((x) => WIDEN[x].includes(target))) {
      const [cls, name, desc] = BOX[from], get = cx.prog.resolve(cls, name, desc), wide = from === "J" || from === "D";
      c.lget(0).i32(cx.idOf(cls)).i32(cx.prog.chain(cls).length - 1).call(cx.helper("iof")).if_();
      if (!get) cx.gap(c, `${cls}.${name}`); else {
        c.lget(0); cx.callMethod(c, get);
        // float and double values are their bits here: compute in f32 and f64
        if (target === "J") { if (!wide) c.raw(OP.i64_extend_i32_s); }
        else if (target === "F") { if (from !== "F") c.raw(wide ? OP.f32_convert_i64_s : OP.f32_convert_i32_s, OP.i32_reinterpret_f32); c.raw(OP.i64_extend_i32_u); }
        else if (target === "D") {
          if (from === "F") c.raw(OP.f32_reinterpret_i32, OP.f64_promote_f32, OP.i64_reinterpret_f64);
          else if (from !== "D") c.raw(wide ? OP.f64_convert_i64_s : OP.f64_convert_i32_s, OP.i64_reinterpret_f64);
        } else c.raw(OP.i64_extend_i32_s);
        c.ret();
      }
      c.end();
    }
    c.end();
  }
  c.lget(2).lget(3).lget(0); cx.vtId(c); cx.callThrower(c, "iarg");
  c.i64(0n);
});
