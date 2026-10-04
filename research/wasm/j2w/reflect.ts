// java.lang.reflect.Method and Constructor over the program's own classes: lookup by name and parameter classes, the signature accessors,
// and invocation. A member is identified by a cookie, Executable.artMethod = class id << 16 | index in the class's methods, and
// Executable's other fields (declaringClass, accessFlags, dexMethodIndex) are filled as ART does. Invoking is a generated thunk per
// method (host.info hands out its table slot): it unboxes the Object[] into the method's parameters, dispatches as the invoke
// instruction would, boxes the result and wraps what the method throws in InvocationTargetException.
import { OP } from "./code";
import { T, refNull } from "./wasmbin";
import { ACC, kindOf, type MethodInfo } from "./program";
import { H } from "./consts";
import { emitString, idOfClass, classMethod, typeName } from "./classes";
import { rt } from "./rtfns";
import type { Code } from "./code";
import type { Compiler, Intrinsic } from "./j2w";
import type { World } from "./lazy";

const EXEC = "java/lang/reflect/Executable", METHOD = "java/lang/reflect/Method", CTOR = "java/lang/reflect/Constructor";
const CLASS_ARRAY = "[Ljava/lang/Class;";
const ITE = "java/lang/reflect/InvocationTargetException";

export const enum RInfo { MethodCount = 200, MethodNameLen, MethodNameChar, MethodKind, MethodParams, MethodParamType, MethodRet, MethodFlags, MethodInvoke, IfaceCount, Iface }
/** a member's (class id, index) packed into the cookie */
const BOX: Record<string, [string, string, string]> = {
  Z: ["java/lang/Boolean", "booleanValue", "()Z"], B: ["java/lang/Byte", "byteValue", "()B"], C: ["java/lang/Character", "charValue", "()C"],
  S: ["java/lang/Short", "shortValue", "()S"], I: ["java/lang/Integer", "intValue", "()I"], J: ["java/lang/Long", "longValue", "()J"],
  F: ["java/lang/Float", "floatValue", "()F"], D: ["java/lang/Double", "doubleValue", "()D"],
};

export function hostReflect(w: World, kind: RInfo, a: number, b: number): number {
  const jc = w.prog.get(w.nameOf(a));
  if (kind === RInfo.MethodCount) return jc?.def ? jc.methods.length : 0;
  if (kind === RInfo.IfaceCount) return jc?.ifaces.length ?? 0;
  if (kind === RInfo.Iface) return w.idOf(jc!.ifaces[b]);
  const idx = kind === RInfo.MethodParamType ? b >> 8 : b, m = jc!.methods[kind === RInfo.MethodNameChar ? b >>> 16 : idx];
  switch (kind) {
    case RInfo.MethodNameLen: return m.name.length;
    case RInfo.MethodNameChar: return m.name.charCodeAt(b & 0xffff);
    case RInfo.MethodKind: return m.name === "<init>" ? 1 : m.name === "<clinit>" ? 2 : 0;
    case RInfo.MethodParams: return m.params.length;
    case RInfo.MethodParamType: return w.idOf(typeName(m.params[b & 0xff]));
    case RInfo.MethodRet: return w.idOf(typeName(m.ret));
    case RInfo.MethodFlags: return m.flags;
    case RInfo.MethodInvoke: return w.synthSlot(`invoke:${a}:${b}`, { params: ["L", "L"], ret: "L", body: (cx, c) => invokeBody(cx, c, m) });
  }
  return 0;
}

/** the thunk body: params (receiver, Object[]) -> Object */
function invokeBody(cx: Compiler, c: Code, m: MethodInfo): void {
  const ctor = m.isCtor, args = c.newLocal(refNull(cx.tData.ref)), e = c.newLocal(T.anyref), w = c.newLocal(T.anyref), recv = c.newLocal(T.anyref);
  if (m.params.length) c.lget(1).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lset(args);
  c.block(T.anyref).block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
  if (ctor) { cx.emitEnsure(c, m.cls); cx.emitNew(c, m.cls); c.lset(recv); c.lget(recv); }
  else if (!m.isStatic) { c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); c.lget(0).lset(recv); c.lget(recv); }
  else cx.emitEnsure(c, m.cls);
  let i = 0;
  for (const p of m.params) {
    c.lget(args).refAsNonNull().i32(i++).arrayGet(cx.tData.ref);
    const box = BOX[p];
    if (box) { c.refAsNonNull(); classMethod(cx, c, ...box); }
  }
  const prog = cx.prog, decl = prog.get(m.cls)!;
  if (m.isStatic || ctor || m.flags & (ACC.PRIVATE | ACC.FINAL) || decl.flags & ACC.FINAL) cx.callMethod(c, m);
  else {
    const ps: ("I" | "J" | "L")[] = ["L", ...m.params.map(kindOf)], sig = cx.sig(ps, m.ret === "V" ? "V" : kindOf(m.ret));
    c.lget(recv).call(cx.helper("vtab"));
    if (!decl.isInterface) c.i32(cx.w.vslot(m.cls, m.key)).arrayGet(cx.tVT);
    else {
      const sel = cx.w.selectorId(m.key), s = sel % H.IMT_N, vt = c.newLocal(refNull(cx.tVT));
      c.lset(vt).lget(vt).refAsNonNull().i32(H.IMT + 2 * s).arrayGet(cx.tVT).i32(sel).raw(OP.i32_eq).if_(T.i32)
        .lget(vt).refAsNonNull().i32(H.IMT + 2 * s + 1).arrayGet(cx.tVT).else_().lget(vt).refAsNonNull().i32(sel).call(cx.helper("imtslow")).end();
    }
    c.callIndirect(sig);
  }
  if (ctor) c.lget(recv);
  else if (m.ret === "V") c.anyNull();
  else if (BOX[m.ret]) {
    const [boxCls] = BOX[m.ret]; classMethod(cx, c, boxCls, "valueOf", `(${m.ret})L${boxCls};`);
  }
  c.br(2).end().unreachable().end();
  // what the method threw, wrapped
  const ite = prog.resolve(ITE, "<init>", "(Ljava/lang/Throwable;)V");
  c.lset(e); cx.emitNew(c, ITE); c.lset(w);
  if (ite) { c.lget(w).lget(e); cx.callMethod(c, ite); }
  c.lget(w).throw_(cx.tag).end();
}

const execField = (cx: Compiler, cls: string, name: string, d: string) => cx.fieldIndex(cls, { owner: EXEC, name, desc: d });
const info = (cx: Compiler, c: Code, kind: RInfo, cid: number, b: () => void = () => c.i32(0)) => cx.info(c, kind, () => c.lget(cid), b);
const ACC_BRIDGE = 0x40;

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
// mnameEq(cid, k, name, len): the String `name` of length `len` spells the name of method k of class cid
rt("mnameEq", ["I", "I", "L", "I"], "I", (cx, c) => {
  const j = c.newLocal(T.i32);
  c.block().loop().lget(j).lget(3).raw(OP.i32_ge_s).brIf(1);
  c.lget(2).lget(j); classMethod(cx, c, "java/lang/String", "charAt", "(I)C");
  info(cx, c, RInfo.MethodNameChar, 0, () => c.lget(1).i32(16).raw(OP.i32_shl).lget(j).raw(OP.i32_or));
  c.raw(OP.i32_ne).if_().i32(0).ret().end();
  c.lget(j).i32(1).raw(OP.i32_add).lset(j).br(0).end().end().i32(1);
});
// findMethod(cid, name, params, ctor): the index of the declared method (constructor: name null) with those parameter classes, or -1
rt("findMethod", ["I", "L", "L", "I"], "I", (cx, c) => {
  const n = c.newLocal(T.i32), k = c.newLocal(T.i32), plen = c.newLocal(T.i32), len = c.newLocal(T.i32), i = c.newLocal(T.i32);
  const pdata = c.newLocal(refNull(cx.tData.ref));
  info(cx, c, RInfo.MethodCount, 0); c.lset(n);
  c.lget(1).refIsNull().raw(OP.i32_eqz).if_().lget(1); classMethod(cx, c, "java/lang/String", "length", "()I"); c.lset(len).end();
  c.lget(2).refIsNull().raw(OP.i32_eqz).if_().lget(2).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lset(pdata).lget(pdata).refAsNonNull().arrayLen().lset(plen).end();
  c.block().loop().lget(k).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.block();                                                   // next
  info(cx, c, RInfo.MethodKind, 0, () => c.lget(k)); c.lget(3).raw(OP.i32_ne).brIf(0);
  info(cx, c, RInfo.MethodFlags, 0, () => c.lget(k)); c.i32(ACC_BRIDGE).raw(OP.i32_and).brIf(0);
  info(cx, c, RInfo.MethodParams, 0, () => c.lget(k)); c.lget(plen).raw(OP.i32_ne).brIf(0);
  c.lget(3).raw(OP.i32_eqz).if_();
  info(cx, c, RInfo.MethodNameLen, 0, () => c.lget(k)); c.lget(len).raw(OP.i32_ne).brIf(1);
  c.lget(0).lget(k).lget(1).lget(len); cx.callRt(c, "mnameEq"); c.raw(OP.i32_eqz).brIf(1).end();
  c.i32(0).lset(i);
  c.block().loop().lget(i).lget(plen).raw(OP.i32_ge_s).brIf(1);
  c.lget(pdata).refAsNonNull().lget(i).arrayGet(cx.tData.ref); idOfClass(cx, c);
  info(cx, c, RInfo.MethodParamType, 0, () => c.lget(k).i32(8).raw(OP.i32_shl).lget(i).raw(OP.i32_or)); c.raw(OP.i32_ne).brIf(3);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  c.lget(k).ret().end();                                       // end of `next`
  c.lget(k).i32(1).raw(OP.i32_add).lset(k).br(0).end().end().i32(-1);
});
// classArray(cid, k, what): the Class[] of the parameter classes (what 0) of method k, or of the direct interfaces (what 1)
rt("classArray", ["I", "I", "I"], "L", (cx, c) => {
  const n = c.newLocal(T.i32), i = c.newLocal(T.i32), w = c.newLocal(refNull(cx.tArr.ref)), data = c.newLocal(refNull(cx.tData.ref));
  c.lget(2).if_(T.i32); info(cx, c, RInfo.IfaceCount, 0); c.else_(); info(cx, c, RInfo.MethodParams, 0, () => c.lget(1)); c.end().lset(n);
  cx.emitNewArray(c, CLASS_ARRAY, () => c.lget(n)); c.refCast(cx.tArr.ref).lset(w).lget(w).structGet(cx.tArr.ref, 2).lset(data);
  c.block().loop().lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(data).refAsNonNull().lget(i);
  c.lget(2).if_(T.i32); info(cx, c, RInfo.Iface, 0, () => c.lget(i)); c.else_(); info(cx, c, RInfo.MethodParamType, 0, () => c.lget(1).i32(8).raw(OP.i32_shl).lget(i).raw(OP.i32_or)); c.end();
  cx.callRt(c, "classOf"); c.arraySet(cx.tData.ref).lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  c.lget(w);
});

// ---------- intrinsics
export const reflectIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => reflectIntrinsics.set(key, (cx, m, c) => f(cx, c));
/** the class id and method index of the Executable in local 0 */
function cookie(cx: Compiler, c: Code): [number, number] {
  const cid = c.newLocal(T.i32), idx = c.newLocal(T.i32), art = c.newLocal(T.i64), st = cx.structFor(EXEC);
  c.lget(0).refCast(st).structGet(st, cx.fieldIndex(EXEC, { owner: EXEC, name: "artMethod", desc: "J" })).lset(art);
  c.lget(art).i64(16n).raw(OP.i64_shr_u, OP.i32_wrap_i64).lset(cid).lget(art).raw(OP.i32_wrap_i64).i32(0xffff).raw(OP.i32_and).lset(idx);
  return [cid, idx];
}
const exec = (cx: Compiler, c: Code, nameLocal: number | null, paramsLocal: number, ctor: 0 | 1) => {
  const cid = c.newLocal(T.i32), idx = c.newLocal(T.i32);
  c.lget(0); idOfClass(cx, c); c.lset(cid);
  c.lget(cid); nameLocal === null ? c.anyNull() : c.lget(nameLocal); c.lget(paramsLocal).i32(ctor); cx.callRt(c, "findMethod"); c.ltee(idx).i32(0).raw(OP.i32_lt_s);
  c.if_(T.anyref).anyNull().else_().lget(cid).lget(idx).i32(ctor); cx.callRt(c, "mkExec"); c.end();
};
def("java/lang/Class.getDeclaredMethodInternal(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;", (cx, c) => exec(cx, c, 1, 2, 0));
def("java/lang/Class.getDeclaredConstructorInternal([Ljava/lang/Class;)Ljava/lang/reflect/Constructor;", (cx, c) => exec(cx, c, null, 1, 1));
def("java/lang/Class.getInterfacesInternal()[Ljava/lang/Class;", (cx, c) => { c.lget(0); idOfClass(cx, c); c.i32(0).i32(1); cx.callRt(c, "classArray"); });
def("java/lang/reflect/Executable.getMethodNameInternal()Ljava/lang/String;", (cx, c) => {
  const [cid, idx] = cookie(cx, c);
  emitString(cx, c, () => info(cx, c, RInfo.MethodNameLen, cid, () => c.lget(idx)), (j) => info(cx, c, RInfo.MethodNameChar, cid, () => c.lget(idx).i32(16).raw(OP.i32_shl).lget(j).raw(OP.i32_or)));
});
def("java/lang/reflect/Executable.getMethodReturnTypeInternal()Ljava/lang/Class;", (cx, c) => { const [cid, idx] = cookie(cx, c); info(cx, c, RInfo.MethodRet, cid, () => c.lget(idx)); cx.callRt(c, "classOf"); });
def("java/lang/reflect/Executable.getParameterCountInternal()I", (cx, c) => { const [cid, idx] = cookie(cx, c); info(cx, c, RInfo.MethodParams, cid, () => c.lget(idx)); });
def("java/lang/reflect/Executable.getParameterTypesInternal()[Ljava/lang/Class;", (cx, c) => { const [cid, idx] = cookie(cx, c); c.lget(cid).lget(idx).i32(0); cx.callRt(c, "classArray"); });
const invoke = (cx: Compiler, c: Code, recv: () => void, args: number) => {
  const [cid, idx] = cookie(cx, c);
  recv(); c.lget(args); info(cx, c, RInfo.MethodInvoke, cid, () => c.lget(idx)); c.callIndirect(cx.sig(["L", "L"], "L"));
};
def("java/lang/reflect/Method.invoke(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;", (cx, c) => invoke(cx, c, () => c.lget(1), 2));
def("java/lang/reflect/Constructor.newInstance0([Ljava/lang/Object;)Ljava/lang/Object;", (cx, c) => invoke(cx, c, () => c.anyNull(), 1));
