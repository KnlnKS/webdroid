// MethodHandle.invoke and invokeExact dispatch (art/runtime/mirror/method_handle_impl.cc and method_handles.cc). A handle made by MethodHandles.Lookup
// is a MethodHandleImpl whose handleKind and artFieldOrMethod say what it calls: a method (a cookie as Executable.artMethod, reflect.ts) or a field (the
// id of Field.get, fields.ts). The site (compiler/handles.ts) boxes its arguments into an Object[] and passes it with its own method type; mhInvoke checks
// the type against the handle's (invokeExact: equal, else WrongMethodTypeException; invoke: libcore's asType handles the conversions),
// calls the member through a generated thunk and answers the boxed result, which the site unboxes. Transformer handles run their unchanged
// libcore Java code over EmulatedStackFrame; invokeExactWithFrame re-enters the direct-handle dispatcher.
import { T } from "../compiler/wasmbin.ts";
import { descOf, javaName, type FieldInfo, type Kind, type MethodInfo, typeName } from "../compiler/program.ts";
import { parseMethodDesc } from "../../jvm/abi.ts";
import { hostReflect } from "./reflect.ts";
import { BOX, box, unbox } from "../compiler/primitives.ts";
import { CLASS, InvokeMode, MH, MT, OBJECTS, emitInvokeImport, emitMethodType, handleKinds } from "../compiler/handles.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import { prettyType } from "../compiler/linkage.ts";
import { type Strand } from "./sched.ts";
import { emitVarHandleAccess } from "../compiler/poly.ts";
import { invokeVarHandleView } from "./vhandleviews.ts";
import { invokeCustom } from "./callsites.ts";
import { RInfo } from "../compiler/info.ts";
import { MethodHandleType } from "../../jvm/dex.ts";

/** what a handle invocation answers: the boxed result, or the Promise of it when the call waited */
type Answer = object | null | Promise<object | null>;
const fail = (w: World, cls: string, message: string | null): never => { throw w.exception(w.makeThrowable(cls, message)); };

export interface SignatureType { owner: string; descriptor: string }

/** Metadata only: the executed-site resolver owns loading, ordering and suspension. */
export function methodTypeSignatureTypes(referrer: MethodInfo, index: number): SignatureType[] {
  const dex = referrer.dex, proto = dex.proto(index);
  return [proto.ret, ...proto.params].map(t => ({ owner: referrer.cls, descriptor: dex.rawType(t) }));
}

export function handleMemberOwner(referrer: MethodInfo, index: number): string {
  const dex = referrer.dex, handle = dex.methodHandle(index);
  const member = handle.type <= MethodHandleType.InstanceGet ? dex.field(handle.idx) : dex.method(handle.idx);
  return dex.rawTypeName(member.cls);
}

/** Invoke after member/access checks. Field type resolution belongs to its declaration's loader. */
export function handleSignatureTypes(referrer: MethodInfo, index: number, field?: FieldInfo): SignatureType[] {
  const dex = referrer.dex, handle = dex.methodHandle(index);
  if (handle.type <= MethodHandleType.InstanceGet) {
    if (!field) throw new Error("Resolved field required for method handle signature");
    return [{ owner: field.owner, descriptor: javaName(field.desc) }];
  }
  const proto = dex.proto(dex.method(handle.idx).proto);
  return [...proto.params, proto.ret].map(t => ({ owner: referrer.cls, descriptor: dex.rawType(t) }));
}
const FRAME = "dalvik/system/EmulatedStackFrame";
export const handleIntrinsics = new Map<string, Intrinsic>([
  [`${MH}.invokeExactWithFrame(L${FRAME};)V`, (cx, _m, c) => {
    c.lget(1).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
    emitInvokeImport(cx, c, () => c.lget(0), () => c.lget(1), "", InvokeMode.Frame); c.drop();
  }],
]);

// ---------- the host side
interface State {
  kinds: Record<string, number>;
  handleKind(mh: object): number; art(mh: object): bigint; typeOf(mh: object): object;
  ptypes(t: object): object; rtype(t: object): object; classId(c: object): number;
  alen(a: object): number; aget(a: object, i: number): object; aset(a: object, i: number, v: object | null): void; newArray(n: number): object;
}
const states = new WeakMap<World, State>();
function state(w: World): State {
  let s = states.get(w);
  if (s) return s;
  const kinds = handleKinds(w.prog);
  s = {
    kinds,
    handleKind: w.fieldReader<number>(MH, "handleKind", "I"), art: w.fieldReader<bigint>(MH, "artFieldOrMethod", "J"), typeOf: w.fieldReader<object>(MH, "type", `L${MT};`),
    ptypes: w.fieldReader<object>(MT, "ptypes", `[L${CLASS};`), rtype: w.fieldReader<object>(MT, "rtype", `L${CLASS};`), classId: w.fieldReader<number>(CLASS, "dexTypeIndex", "I"),
    alen: w.hostFn("mh:alen", ["L"], "I", (cx, c) => { c.lget(0); cx.arrayData(c).refAsNonNull().arrayLen(); }),
    aget: w.hostFn("mh:aget", ["L", "I"], "L", (cx, c) => { c.lget(0); cx.arrayData(c).lget(1).arrayGet(cx.tData.ref); }),
    aset: w.hostFn("mh:aset", ["L", "I", "L"], "V", (cx, c) => { c.lget(0); cx.arrayData(c).lget(1).lget(2).arraySet(cx.tData.ref); }),
    newArray: w.hostFn("mh:new", ["I"], "L", (cx, c) => cx.emitNewArray(c, OBJECTS, () => c.lget(0))),
  };
  states.set(w, s);
  return s;
}

const prettySig = (params: string[], ret: string) => `(${params.map(prettyType).join(",")})${prettyType(ret)}`;

/** Capture the parent before a wait: a Promise continuation may run while the scheduler is idle. Child strands share its thread and monitor ancestry. */
export function handleThunk(w: World, name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, parent = w.sched.current(), prepare?: (cx: Compiler) => void): (...args: unknown[]) => unknown {
  return (...args) => {
    if (parent.root || w.inSynchronousJava()) return w.unwound(() => w.synchronous(() => w.hostFn(name, params, ret, (cx, c) => body(cx, c, i => { c.lget(i); }), prepare)(...args)));
    const s = w.sched.strand(parent.thread, parent);
    let result: unknown;
    try { result = w.callFn(name, params, ret, body, prepare)(s, ...args); } catch (e) { s.end(); throw e; }
    if (result instanceof Promise) return result.finally(() => s.end());
    s.end(); return result;
  };
}

export function mhInvoke(w: World, mh: object | null, args: object, siteId: string, mode: InvokeMode, parent = w.sched.current()): Answer {
  // V8 retains completed helper stacks until their caller waits, as for the native binder's entry quota.
  if (!parent.root && !w.inSynchronousJava() && w.sched.current() === parent && w.sched.owes()) {
    return Promise.resolve().then(() => mhInvoke(w, mh, args, siteId, mode, parent));
  }
  if (mode === InvokeMode.Custom) return invokeCustom(w, siteId, args, parent);
  if (mode === InvokeMode.VarHandle) {
    const separator = siteId.indexOf("@"), mode = siteId.slice(0, separator), site = parseMethodDesc(siteId.slice(separator + 1));
    const s = state(w), list = s.newArray(site.params.length + 1), owner = "java/lang/invoke/VarHandle";
    s.aset(list, 0, mh);
    site.params.forEach((_, i) => s.aset(list, i + 1, s.aget(args, i)));
    const method = w.prog.require(owner).methods.find(m => m.name === mode)!;
    const art = BigInt(w.idOf(owner)) << 16n | BigInt(w.prog.require(owner).methods.indexOf(method));
    return invokeVarHandle(w, list, art, false, [`L${owner};`, ...site.params], site.ret, parent);
  }
  if (mode === InvokeMode.Frame) return invokeFrame(w, mh!, args, parent);
  const s = state(w);
  const { params: sp, ret: sr } = parseMethodDesc(siteId), { params: np, ret: nr } = signatureOf(w, s.typeOf(mh!));
  if (np.length !== sp.length || !np.every((d, i) => d === sp[i]) || nr !== sr) {
    if (mode === InvokeMode.Exact) fail(w, "java/lang/invoke/WrongMethodTypeException", `Expected ${prettySig(np, nr)} but was ${prettySig(sp, sr)}`);
    const adapted = handleThunk(w, `mh:asType:${w.classNameOf(mh!)}:${siteId}`, ["L"], "L", (cx, c, arg) => {
      arg(0); emitMethodType(cx, c, sr, sp);
      const m = cx.prog.implFor(w.classNameOf(mh!), "asType", `(L${MT};)L${MH};`)!; cx.callMethod(c, m);
    }, parent)(mh!) as object | Promise<object>;
    return chain(adapted, adapted => mhInvoke(w, adapted, args, siteId, InvokeMode.Exact, parent));
  }
  const kind = s.handleKind(mh!), K = s.kinds, art = s.art(mh!);
  if (kind === K.INVOKE_VAR_HANDLE || kind === K.INVOKE_VAR_HANDLE_EXACT) return invokeVarHandle(w, args, art, kind === K.INVOKE_VAR_HANDLE_EXACT, np, nr, parent);
  if (kind === K.INVOKE_TRANSFORM) return transform(w, mh!, args, sp, sr, parent);
  const given = Array.from({ length: sp.length }, (_, i) => s.aget(args, i));
  const call = (info: RInfo, cid: number, idx: number, recv: object | null, rest: (object | null)[]) => {
    const list = s.newArray(rest.length);
    rest.forEach((v, i) => s.aset(list, i, v));
    const m = w.prog.require(w.nameOf(cid)).methods[idx];
    if (m.isCtor && m.cls === "java/lang/String") {
      return handleThunk(w, `mh:string:${m.desc}`, ["L"], "L", (cx, c, arg) => cx.construct(c, m, () => m.params.forEach((p, i) => {
        arg(0); cx.arrayData(c).i32(i).arrayGet(cx.tData.ref);
        if (BOX[p]) unbox(cx, c, p);
      })), parent)(list);
    }
    if (m.isCtor && recv !== null) {
      return handleThunk(w, `mh:init:${cid}:${idx}`, ["L", "L"], "L", (cx, c, arg) => {
        arg(0);
        m.params.forEach((p, i) => {
          arg(1); cx.arrayData(c).i32(i).arrayGet(cx.tData.ref);
          if (BOX[p]) unbox(cx, c, p);
        });
        cx.callMethod(c, m); c.anyNull();
      }, parent)(recv, list);
    }
    const slot = hostReflect(w, info, cid, idx);
    return handleThunk(w, `mh:call:${info}:${cid}:${idx}`, ["L", "L"], "L", (cx, c, arg) => {
      arg(0); arg(1); c.i32(slot).callIndirect(cx.sig(["L", "L"], "L"));
    }, parent)(recv, list);
  };
  switch (kind) {
    case K.INVOKE_STATIC: return call(RInfo.MethodCall, Number(art >> 16n), Number(art & 0xffffn), null, given) as Answer;
    case K.INVOKE_VIRTUAL: case K.INVOKE_INTERFACE:
      return call(RInfo.MethodCall, Number(art >> 16n), Number(art & 0xffffn), given[0], given.slice(1)) as Answer;
    case K.INVOKE_DIRECT: case K.INVOKE_SUPER: {
      const cid = Number(art >> 16n), idx = Number(art & 0xffffn), m = w.prog.require(w.nameOf(cid)).methods[idx];
      return call(RInfo.MethodCallDirect, cid, idx, given[0], m.isCtor && m.cls === "java/lang/String" ? given : given.slice(1)) as Answer;
    }
    case K.IGET: case K.SGET: case K.IPUT: case K.SPUT: {
      const id = Number(art), put = kind === K.IPUT || kind === K.SPUT, stat = kind === K.SGET || kind === K.SPUT;
      const r = fieldAccess(w, id, put, stat, parent)(...(stat ? given : given.slice(0, put ? 2 : 1)));
      return (put ? r instanceof Promise ? r.then(() => null) : null : r) as Answer;
    }
  }
  w.onGap(`MethodHandle invocation kind ${kind}`);
  return fail(w, "java/lang/UnsatisfiedLinkError", `MethodHandle invocation kind ${kind}`);
}

/** ART DoVarHandleInvokeTranslation obtains the access-mode type, checks exact invokers, then dispatches the accessor. */
function invokeVarHandle(w: World, args: object, art: bigint, exact: boolean, params: string[], ret: string, parent: Strand): Answer {
  const s = state(w), VH = "java/lang/invoke/VarHandle", AM = `${VH}$AccessMode`;
  if (params[0] !== `L${VH};`) fail(w, "java/lang/invoke/WrongMethodTypeException", "Expected leading VarHandle parameter");
  const handle = s.aget(args, 0);
  if (!handle) fail(w, "java/lang/NullPointerException", "Expected argument 1 to be a non-null VarHandle");
  const method = w.prog.require(w.nameOf(Number(art >> 16n))).methods[Number(art & 0xffffn)], mode = method.name;
  const accessMode = (cx: Compiler, c: Code) => {
    cx.emitEnsure(c, AM); cx.str.literal(c, mode);
    cx.callMethod(c, cx.prog.resolve(AM, "valueFromMethodName", `(Ljava/lang/String;)L${AM};`)!);
  };
  const type = handleThunk(w, `mh:varHandleType:${mode}`, ["L"], "L", (cx, c, arg) => {
    arg(0); accessMode(cx, c); cx.callMethod(c, cx.prog.resolve(VH, "accessModeType", `(L${AM};)L${MT};`)!);
  }, parent)(handle) as object | Promise<object>;
  return chain(type, type => {
    const actual = signatureOf(w, type), match = ret === actual.ret && params.length === actual.params.length + 1 && actual.params.every((p, i) => p === params[i + 1]);
    if (exact && !match) fail(w, "java/lang/invoke/WrongMethodTypeException", `Expected ${prettySig(actual.params, actual.ret)} but was ${prettySig(params.slice(1), ret)}`);
    const supported = handleThunk(w, `mh:varHandleSupported:${mode}`, ["L"], "I", (cx, c, arg) => {
      arg(0); accessMode(cx, c); cx.callMethod(c, cx.prog.resolve(VH, "isAccessModeSupported", `(L${AM};)Z`)!);
    }, parent)(handle) as number | Promise<number>;
    return chain(supported, supported => {
      if (!supported) fail(w, "java/lang/UnsupportedOperationException", null);
      if (!match) {
        const normalized = handleThunk(w, `mh:varHandleInvoker:${art}:${actual.params.join("")}:${actual.ret}`, [], "L", (cx, c) => {
          const impl = "java/lang/invoke/MethodHandleImpl", local = c.newLocal(T.anyref);
          cx.emitEnsure(c, impl); cx.emitNew(c, impl); c.ltee(local).i64(art).i32(s.kinds.INVOKE_VAR_HANDLE_EXACT);
          emitMethodType(cx, c, actual.ret, [`L${VH};`, ...actual.params]);
          cx.callMethod(c, cx.prog.resolve(impl, "<init>", `(JIL${MT};)V`)!); c.lget(local);
        }, parent)() as object | Promise<object>;
        return chain(normalized, normalized => mhInvoke(w, normalized, args, `(${params.join("")})${ret}`, InvokeMode.Invoke, parent));
      }
      // View handles need byte addressing and alignment, not the element-array lowering.
      const storage = w.classNameOf(handle);
      if (storage === "java/lang/invoke/ByteArrayViewVarHandle" || storage === "java/lang/invoke/ByteBufferViewVarHandle") return invokeVarHandleView(w, handle, args, storage, mode, actual.params, actual.ret, parent);
      if (storage !== "java/lang/invoke/FieldVarHandle" && storage !== "java/lang/invoke/StaticFieldVarHandle" && storage !== "java/lang/invoke/ArrayElementVarHandle") {
        w.onGap(`VarHandle storage ${storage}`);
        fail(w, "java/lang/UnsatisfiedLinkError", `VarHandle storage ${storage}`);
      }
      return handleThunk(w, `mh:varHandleAccess:${mode}:(${actual.params.join("")})${actual.ret}`, ["L"], "L", (cx, c, arg) => {
        const value = (index: number) => { arg(0); cx.arrayData(c).i32(index).arrayGet(cx.tData.ref); };
        const result = emitVarHandleAccess(cx, c, mode, actual.params, actual.ret, () => value(0), (_kind, i) => {
          value(i + 1); if (BOX[actual.params[i]]) unbox(cx, c, actual.params[i]);
        });
        if (!result) c.anyNull(); else if (BOX[actual.ret]) box(cx, c, actual.ret);
      }, parent)(args) as Answer;
    });
  });
}

/** the generated accessor of field `id` (class id << 12 | index) on boxed values: get(obj?) answers the boxed value, put(obj?, value) stores it */
function fieldAccess(w: World, id: number, put: boolean, stat: boolean, parent: Strand): (...a: (object | null)[]) => unknown {
  const jc = w.prog.get(w.nameOf(id >>> 12))!, f = jc.fields[id & 0xfff];
  return handleThunk(w, `mh:${put ? "put" : "get"}:${id}`, [...stat ? [] : ["L" as const], ...put ? ["L" as const] : []], put ? "V" : "L", (cx, c, arg) => {
    const st = cx.structFor(jc.name), at = stat ? -1 : cx.fieldIndex(jc.name, f), value = stat ? 0 : 1;
    if (stat) cx.emitEnsure(c, jc.name);
    else { arg(0); c.refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); }
    const target = () => { arg(0); c.refCast(st); };
    if (!put) {
      if (stat) c.gget(cx.staticGlobal(jc.name, f.name, f.desc)); else { target(); c.structGet(st, at); }
      if (BOX[f.desc]) box(cx, c, f.desc);
      return;
    }
    if (!stat) target();
    arg(value);
    if (BOX[f.desc]) unbox(cx, c, f.desc);
    if (stat) c.gset(cx.staticGlobal(jc.name, f.name, f.desc)); else c.structSet(st, at);
  }, parent) as never;
}

const primitiveNames: Record<string, string> = { Z: "Boolean", B: "Byte", C: "Char", S: "Short", I: "Int", J: "Long", F: "Float", D: "Double" };
/** `next` applied to `value`, after it settles when it is a promise */
export function chain<A, B>(value: A | Promise<A>, next: (v: A) => B | Promise<B>): B | Promise<B> { return value instanceof Promise ? value.then(next) : next(value); }

/** Use libcore's frame accessors: they own reference slots, little-endian primitive storage and return offsets. */
function accessor(cx: Compiler, c: Code, frame: () => void, write: boolean, ret: boolean): number {
  const name = `${FRAME}$StackFrame${write ? "Writer" : "Reader"}`, base = `${FRAME}$StackFrameAccessor`, local = c.newLocal(T.anyref);
  cx.construct(c, cx.prog.resolve(name, "<init>", "()V")!); c.lset(local);
  c.lget(local); frame(); cx.callMethod(c, cx.prog.resolve(base, "attach", `(L${FRAME};)L${base};`)!); c.drop();
  if (ret) { c.lget(local); cx.callMethod(c, cx.prog.resolve(base, "makeReturnValueAccessor", "()V")!); }
  return local;
}
function readFrame(cx: Compiler, c: Code, reader: number, desc: string): void {
  const name = `${FRAME}$StackFrameReader`;
  c.lget(reader);
  if (BOX[desc]) { cx.callMethod(c, cx.prog.resolve(name, "next" + primitiveNames[desc], `()${desc}`)!); box(cx, c, desc); }
  else { cx.constClass(c, typeName(desc)); cx.callMethod(c, cx.prog.resolve(name, "nextReference", `(L${CLASS};)Ljava/lang/Object;`)!); }
}
function writeFrame(cx: Compiler, c: Code, writer: number, desc: string, value: () => void): void {
  const name = `${FRAME}$StackFrameWriter`;
  c.lget(writer); value();
  if (BOX[desc]) { unbox(cx, c, desc); cx.callMethod(c, cx.prog.resolve(name, "putNext" + primitiveNames[desc], `(${desc})V`)!); }
  else { cx.constClass(c, typeName(desc)); cx.callMethod(c, cx.prog.resolve(name, "putNextReference", `(Ljava/lang/Object;L${CLASS};)V`)!); }
}
function signatureOf(w: World, type: object): { params: string[]; ret: string } {
  const s = state(w), p = s.ptypes(type), desc = (cls: object) => descOf(w.nameOf(s.classId(cls)));
  return { params: Array.from({ length: s.alen(p) }, (_, i) => desc(s.aget(p, i))), ret: desc(s.rtype(type)) };
}
function frameArgs(w: World, frame: object, params: string[], parent: Strand): object | Promise<object> {
  return handleThunk(w, `mh:frameArgs:(${params.join("")})`, ["L"], "L", (cx, c, arg) => {
    const reader = accessor(cx, c, () => arg(0), false, false), arr = c.newLocal(T.anyref);
    cx.emitNewArray(c, OBJECTS, () => c.i32(params.length)); c.lset(arr);
    params.forEach((p, i) => {
      c.lget(arr); cx.arrayData(c).i32(i); readFrame(cx, c, reader, p); c.arraySet(cx.tData.ref);
    });
    c.lget(arr);
  }, parent)(frame) as object | Promise<object>;
}
function invokeFrame(w: World, mh: object, frame: object, parent: Strand): Answer {
  const type = w.fieldReader<object>(FRAME, "type", `L${MT};`)(frame), { params, ret } = signatureOf(w, type);
  return chain(frameArgs(w, frame, params, parent), args => chain(mhInvoke(w, mh, args, `(${params.join("")})${ret}`, InvokeMode.Exact, parent), value => {
    if (ret === "V") return null;
    return chain(handleThunk(w, `mh:frameReturn:${ret}`, ["L", "L"], "V", (cx, c, arg) => {
      const writer = accessor(cx, c, () => arg(0), true, true); writeFrame(cx, c, writer, ret, () => arg(1));
    }, parent)(frame, value), () => null);
  }));
}
function transform(w: World, mh: object, args: object, params: string[], ret: string, parent: Strand): Answer {
  const sig = `(${params.join("")})${ret}`;
  const frame = handleThunk(w, `mh:newFrame:${sig}`, ["L"], "L", (cx, c, arg) => {
    emitMethodType(cx, c, ret, params);
    cx.emitEnsure(c, FRAME); cx.callMethod(c, cx.prog.resolve(FRAME, "create", `(L${MT};)L${FRAME};`)!);
    const local = c.newLocal(T.anyref); c.lset(local);
    const writer = accessor(cx, c, () => c.lget(local), true, false);
    params.forEach((p, i) => writeFrame(cx, c, writer, p, () => { arg(0); cx.arrayData(c).i32(i).arrayGet(cx.tData.ref); }));
    c.lget(local);
  }, parent)(args) as object | Promise<object>;
  return chain(frame, frame => {
    const m = w.prog.implFor(w.classNameOf(mh), "transform", `(L${FRAME};)V`)!;
    return chain(handleThunk(w, `mh:transform:${m.cls}`, ["L", "L"], "V", (cx, c, arg) => { arg(0); arg(1); cx.callMethod(c, m); }, parent)(mh, frame), () => {
      if (ret === "V") return null;
      return handleThunk(w, `mh:readReturn:${ret}`, ["L"], "L", (cx, c, arg) => {
        const reader = accessor(cx, c, () => arg(0), false, true); readFrame(cx, c, reader, ret);
      }, parent)(frame) as object | Promise<object>;
    });
  });
}
