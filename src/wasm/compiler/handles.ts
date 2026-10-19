// The compiled side of method handles (art/runtime/method_handles.cc): const-method-type and const-method-handle values, and the
// invoke-polymorphic and invoke-custom sites, which box their arguments into an Object[] for the host dispatcher (link/mhandles.ts)
// and unbox or cast its answer.
import { T } from "./wasmbin.ts";
import { ACC, javaName, kindOf, type FieldInfo, type MethodInfo, type Program, descOf, typeName } from "./program.ts";
import { isWide, descToName, parseMethodDesc } from "../../jvm/abi.ts";
import { BOX, box, unbox } from "./primitives.ts";
import type { Code } from "./code.ts";
import type { Compiler } from "./j2w.ts";
import type { MC } from "./method.ts";
import type { PreparedInstruction as Ins } from "../../jvm/prepared.ts";
import { failed, resolveFieldRef, resolveInvoke, typeFailure, type LinkFailure, canAccess } from "./linkage.ts";
import type { DexFile } from "../../jvm/dex.ts";
import { mid } from "./ids.ts";
import { emitRestored, emitSettled } from "./hostcalls.ts";

export const MH = "java/lang/invoke/MethodHandle", MT = "java/lang/invoke/MethodType", CLASS = "java/lang/Class", OBJECTS = "[Ljava/lang/Object;";
/** what host.mhInvoke dispatches: a handle with the site's type, an EmulatedStackFrame, an invoke-custom site, a VarHandle accessor */
export const InvokeMode = { Invoke: 0, Exact: 1, Frame: 2, Custom: 3, VarHandle: 4 } as const;
export type InvokeMode = (typeof InvokeMode)[keyof typeof InvokeMode];

export function handleKinds(prog: Program): Record<string, number> {
  const jc = prog.require(MH), fields = jc.fields.filter(f => f.isStatic), kinds: Record<string, number> = {};
  jc.dex!.encodedArray(jc.def!.staticValuesOff).forEach((v, i) => { if (fields[i]) kinds[fields[i].name] = v as number; });
  return kinds;
}

/** ART resolves the signature without initializing its classes; libcore interns MethodType. */
function emitType(cx: Compiler, c: Code, ret: string, params: string[], returnFirst = true): boolean {
  const resolutionOrder = returnFirst ? [ret, ...params] : [...params, ret];
  for (const d of resolutionOrder) { const failure = typeFailure(cx.prog, d); if (failure) { cx.linkError(c, failure); return false; } }
  emitMethodType(cx, c, ret, params);
  return true;
}
export function emitMethodType(cx: Compiler, c: Code, ret: string, params: string[]): void {
  const arr = c.newLocal(T.anyref);
  cx.emitEnsure(c, MT);
  cx.emitNewArray(c, `[L${CLASS};`, () => c.i32(params.length)); c.lset(arr);
  params.forEach((d, i) => {
    c.lget(arr); cx.arrayData(c).i32(i);
    cx.constClass(c, typeName(d)); c.arraySet(cx.tData.ref);
  });
  cx.constClass(c, typeName(ret)); c.lget(arr);
  cx.callMethod(c, cx.prog.resolve(MT, "methodType", `(L${CLASS};[L${CLASS};)L${MT};`)!);
}

export function emitTypeConstant(mc: MC, index: number): void {
  if (emitTypeValue(mc.cx, mc.code, mc.dex, index)) mc.set("L");
}
export function emitTypeValue(cx: Compiler, c: Code, dex: DexFile, index: number): boolean {
  const p = dex.proto(index);
  return emitType(cx, c, dex.type(p.ret), p.params.map(t => dex.type(t)));
}

/** const-method-handle uses the referring loader, member access checks and ART's direct handle kinds. */
export function emitHandleConstant(mc: MC, index: number): void {
  if (emitHandleValue(mc.cx, mc.code, mc.m, index)) mc.set("L");
}
type HandleMember = { field: FieldInfo } | { method: MethodInfo; cls: string; invoke: string };
type HandleFailure = LinkFailure | { errorClass: string; message: string };

/** Shared by executed resolution and emission so member failures precede signature loading. */
export function resolveHandleMember(prog: Program, referrer: MethodInfo, index: number): HandleMember | HandleFailure {
  const dex = referrer.dex, h = dex.methodHandle(index);
  const access = (owner: string, flags: number, member: string): HandleFailure | undefined =>
    canAccess(prog, referrer.cls, prog.require(owner), flags) ? undefined : { errorClass: "java/lang/IllegalAccessError", message: `${javaName(referrer.cls)} cannot access ${javaName(owner)}.${member}` };
  if (h.type <= 3) {
    const r = resolveFieldRef(prog, dex, h.idx, h.type <= 1, referrer.cls);
    if (failed(r)) return r;
    const f = r.f, denied = access(f.owner, f.flags, f.name);
    if (denied) return denied;
    if ((h.type === 0 || h.type === 2) && f.flags & ACC.FINAL) return { errorClass: "java/lang/IllegalAccessError", message: `Cannot write final field ${javaName(f.owner)}.${f.name}` };
    return { field: f };
  }
  const mr = dex.method(h.idx), cls = dex.typeName(mr.cls), desc = dex.methodDesc(h.idx);
  let invoke = h.type === 4 ? "invoke-static" : h.type === 8 ? "invoke-interface" : h.type === 6 ? "invoke-direct" : "invoke-virtual";
  if (h.type === 7) {
    const target = resolveInvoke(prog, "invoke-direct", cls, mr.name, desc, referrer.cls);
    if (failed(target)) return target;
    invoke = target.flags & ACC.PRIVATE ? "invoke-direct" : "invoke-super";
  }
  const m = resolveInvoke(prog, invoke, cls, mr.name, desc, referrer.cls);
  if (failed(m)) return m;
  if (h.type === 6 && (m.cls !== cls || !m.isCtor)) return { thrower: "nsme", message: `No constructor ${mr.name}${desc} in class ${javaName(cls)}` };
  const denied = access(m.cls, m.flags, m.name);
  if (denied) return denied;
  if (m.name === "<clinit>") return { errorClass: "java/lang/ClassFormatError", message: "Method handles can't target class initializer method" };
  return { method: m, cls, invoke };
}

export function emitHandleValue(cx: Compiler, c: Code, referrer: MethodInfo, index: number): boolean {
  const dex = referrer.dex, prog = cx.prog, h = dex.methodHandle(index), K = handleKinds(prog);
  const member = resolveHandleMember(prog, referrer, index);
  if ("thrower" in member) { cx.linkError(c, member); return false; }
  if ("errorClass" in member) { cx.throwNew(c, member.errorClass, member.message); return false; }
  let kind: number, art: bigint, ret: string, params: string[];
  if ("field" in member) {
    const stat = h.type <= 1, put = h.type === 0 || h.type === 2, f = member.field;
    kind = stat ? put ? K.SPUT : K.SGET : put ? K.IPUT : K.IGET;
    art = BigInt(cx.idOf(f.owner) * 4096 + prog.require(f.owner).fields.indexOf(f));
    ret = put ? "V" : f.desc; params = [...stat ? [] : [`L${f.owner};`], ...put ? [f.desc] : []];
  } else {
    const { method: m, cls, invoke } = member, desc = dex.methodDesc(h.idx);
    const sig = parseMethodDesc(desc);
    if (h.type === 6) {
      if (!emitType(cx, c, sig.ret, sig.params, false)) return false;
      const type = c.newLocal(T.anyref), lookup = c.newLocal(T.anyref), L = "java/lang/invoke/MethodHandles$Lookup";
      c.lset(type); cx.emitEnsure(c, "java/lang/invoke/MethodHandles");
      cx.callMethod(c, prog.resolve("java/lang/invoke/MethodHandles", "lookup", `()L${L};`)!); c.lset(lookup);
      c.lget(lookup); cx.constClass(c, cls); c.lget(type);
      cx.callMethod(c, prog.resolve(L, "findConstructor", `(L${CLASS};L${MT};)L${MH};`)!); return true;
    }
    kind = invoke === "invoke-static" ? K.INVOKE_STATIC : invoke === "invoke-interface" ? K.INVOKE_INTERFACE
      : invoke === "invoke-direct" ? K.INVOKE_DIRECT : invoke === "invoke-super" ? K.INVOKE_SUPER : K.INVOKE_VIRTUAL;
    art = BigInt(cx.idOf(m.cls)) << 16n | BigInt(prog.require(m.cls).methods.indexOf(m));
    ret = sig.ret; params = [...m.isStatic ? [] : [descOf(cls)], ...sig.params];
  }
  if (!emitType(cx, c, ret, params, false)) return false;
  const type = c.newLocal(T.anyref), handle = c.newLocal(T.anyref), impl = MH + "Impl";
  c.lset(type); cx.emitEnsure(c, impl); cx.emitNew(c, impl); c.ltee(handle).i64(art).i32(kind).lget(type);
  cx.callMethod(c, prog.resolve(impl, "<init>", `(JIL${MT};)V`)!); c.lget(handle); return true;
}

/** Box a DEX polymorphic site for the canonical MethodHandle or VarHandle dispatcher. */
export function emitHandleCall(mc: MC, ins: Ins, exact: boolean, accessMode?: string): void {
  const c = mc.code, handle = c.newLocal(T.anyref);
  mc.nonNull(ins.regs[0]); c.lset(handle);
  emitBoxedInvoke(mc, ins, ins.c, 1, () => c.lget(handle), (accessMode ? accessMode + "@" : "") + mc.dex.protoDesc(ins.c), accessMode ? InvokeMode.VarHandle : exact ? InvokeMode.Exact : InvokeMode.Invoke);
}
/** invoke-custom: the site's arguments, boxed, for the target of the CallSite its own bootstrap links (callsites.ts) */
export function emitCustom(mc: MC, ins: Ins): void {
  emitBoxedInvoke(mc, ins, mc.dex.callSiteProto(ins.b), 0, () => mc.code.anyNull(), `${mid(mc.m)}#${ins.b}`, InvokeMode.Custom);
}
/** a dispatcher import invoked with the arguments of `proto` from register `firstReg` boxed into an
 *  Object[], its Object result dropped, unboxed or cast to the proto's return type */
function emitBoxedInvoke(mc: MC, ins: Ins, proto: number, firstReg: number, handle: () => void, site: string, mode: InvokeMode): void {
  const { cx, code: c } = mc, { params, ret } = mc.dex.protoTypes(proto), arr = c.newLocal(T.anyref);
  cx.emitNewArray(c, OBJECTS, () => c.i32(params.length)); c.lset(arr);
  for (let i = 0, ri = firstReg; i < params.length; ri += isWide(params[i++]) ? 2 : 1) {
    const p = params[i];
    c.lget(arr); cx.arrayData(c).i32(i);
    mc.get(kindOf(p), ins.regs[ri]); if (BOX[p]) box(cx, c, p); c.arraySet(cx.tData.ref);
  }
  emitInvokeImport(cx, c, handle, () => c.lget(arr), site, mode);
  if (ret === "V") c.drop();
  else if (BOX[ret]) { unbox(cx, c, ret); mc.finishResult(ins, kindOf(ret)); }
  else { cx.emitCast(c, descToName(ret)); mc.finishResult(ins, "L"); }
}

export function emitInvokeImport(cx: Compiler, c: Code, handle: () => void, args: () => void, site: string, mode: InvokeMode): void {
  emitRestored(cx, c, [], [T.anyref], () => {
    handle(); c.externConvertAny(); args(); c.externConvertAny().gget(cx.stringConst(site)).i32(mode).call(cx.imp.mhInvoke);
    emitSettled(cx, c);
  });
}
