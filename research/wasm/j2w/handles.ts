// MethodHandle.invoke and invokeExact call sites (art/runtime/mirror/method_handle_impl.cc and method_handles.cc). A handle made by MethodHandles.Lookup
// is a MethodHandleImpl whose handleKind and artFieldOrMethod say what it calls: a method (a cookie as Executable.artMethod, reflect.ts) or a field (the
// id of Field.get, fields.ts). The site boxes its arguments into an Object[] and passes it with its own method type; the host (mhInvoke) checks the
// type against the handle's (invokeExact: equal, else WrongMethodTypeException; invoke: asType's conversions of boxing, unboxing, widening and casts),
// calls the member through a generated thunk and answers the boxed result, which the site unboxes. A handle that is a transformer (a combinator:
// bindTo, filterArguments, asType of a different shape) runs Java code over ART's EmulatedStackFrame, which this does not model: that is a gap.
import { OP } from "./code";
import { T } from "./wasmbin";
import { kindOf } from "./program";
import { isWide, descToName } from "../../../src/jvm/abi";
import { hostReflect, RInfo, BOX } from "./reflect";
import { prettyType } from "./linkage";
import { WIDEN } from "./fields";
import type { Code } from "./code";
import type { Compiler } from "./j2w";
import type { World } from "./lazy";
import type { MC } from "./method";
import type { PreparedInstruction as Ins } from "../../../src/jvm/prepared";

const MH = "java/lang/invoke/MethodHandle", MT = "java/lang/invoke/MethodType", CLASS = "java/lang/Class", OBJECTS = "[Ljava/lang/Object;";

/** pushes the wrapper of the primitive `desc` on the stack (valueOf) */
function box(cx: Compiler, c: Code, desc: string): void {
  const [cls] = BOX[desc];
  cx.emitEnsure(c, cls);
  cx.callMethod(c, cx.prog.resolve(cls, "valueOf", `(${desc})L${cls};`)!);
}
/** replaces the (non-null) wrapper on the stack by its primitive value */
function unbox(cx: Compiler, c: Code, desc: string): void {
  const [cls, name, d] = BOX[desc];
  cx.callMethod(c, cx.prog.resolve(cls, name, d)!);
}

/** the call site `ins`: invoke-polymorphic on MethodHandle.invoke or invokeExact */
export function emitHandleCall(mc: MC, ins: Ins, exact: boolean): void {
  const { cx, code: c, dex } = mc, proto = dex.proto(ins.c), params = proto.params.map((t) => dex.type(t)), ret = dex.type(proto.ret);
  const handle = c.newLocal(T.anyref), arr = c.newLocal(T.anyref);
  mc.nonNull(ins.regs[0]); c.lset(handle);
  const regs: number[] = []; for (let ri = 1, i = 0; i < params.length; ri += isWide(params[i++]) ? 2 : 1) regs.push(ins.regs[ri]);
  cx.emitNewArray(c, OBJECTS, () => c.i32(params.length)); c.lset(arr);
  const data = cx.tData.ref, wrapper = cx.tArr.ref;
  params.forEach((p, i) => {
    c.lget(arr).refCast(wrapper).structGet(wrapper, 2).i32(i);
    mc.get(kindOf(p), regs[i]);
    if (BOX[p]) box(cx, c, p);
    c.arraySet(data);
  });
  c.lget(handle).externConvertAny().lget(arr).externConvertAny().i32(cx.w.stringId(`(${params.join("")})${ret}`)).i32(exact ? 1 : 0).call(cx.imp.mhInvoke).anyConvertExtern();
  if (ret === "V") c.drop();
  else if (BOX[ret]) { unbox(cx, c, ret); mc.finishResult(ins, kindOf(ret)); }
  else { if (ret !== "Ljava/lang/Object;") c.call(cx.castFn(ret[0] === "L" ? descToName(ret) : ret)); mc.finishResult(ins, "L"); }
}

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
  const jc = w.prog.get(MH)!, sf = jc.fields.filter((f) => f.isStatic), kinds: Record<string, number> = {};
  jc.dex!.encodedArray(jc.def!.staticValuesOff).forEach((v, i) => { if (sf[i]) kinds[sf[i].name] = v as number; });
  s = {
    kinds,
    handleKind: w.fieldReader(MH, "handleKind", "I") as never, art: w.fieldReader(MH, "artFieldOrMethod", "J") as never, typeOf: w.fieldReader(MH, "type", `L${MT};`),
    ptypes: w.fieldReader(MT, "ptypes", `[L${CLASS};`), rtype: w.fieldReader(MT, "rtype", `L${CLASS};`), classId: w.fieldReader(CLASS, "dexTypeIndex", "I") as never,
    alen: w.hostFn("mh:alen", ["L"], "I", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).refAsNonNull().arrayLen(); }),
    aget: w.hostFn("mh:aget", ["L", "I"], "L", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).arrayGet(cx.tData.ref); }),
    aset: w.hostFn("mh:aset", ["L", "I", "L"], "V", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).lget(2).arraySet(cx.tData.ref); }),
    newArray: w.hostFn("mh:new", ["I"], "L", (cx, c) => cx.emitNewArray(c, OBJECTS, () => c.lget(0))),
  };
  states.set(w, s);
  return s;
}

const nameOfObj = (w: World, v: object) => (typeof v === "string" ? "java/lang/String" : w.classNameOf(v));
const WRAPPER = new Map(Object.entries(BOX).map(([d, [cls]]) => [cls, d]));
const descOfName = (n: string) => n[0] === "#" ? n[1] : n[0] === "[" ? n : `L${n};`;
const wrapperOf = (d: string) => BOX[d][0];
const prettySig = (params: string[], ret: string) => `(${params.map(prettyType).join(",")})${prettyType(ret)}`;

export function mhInvoke(w: World, mh: object | null, args: object, siteId: number, exact: number): object | null {
  const s = state(w);
  const fail = (cls: string, msg: string | null): never => { throw new (WebAssembly as any).Exception(w.rt.tag, [w.makeThrowable(cls, msg)]); };
  const site = /^\((.*)\)(.*)$/.exec(w.hostString(w.strs.get(siteId)) as string)!, sp = parseDescs(site[1]), sr = site[2];
  const nominal = s.typeOf(mh!), pt = s.ptypes(nominal), np = Array.from({ length: s.alen(pt) }, (_, i) => descOfName(w.nameOf(s.classId(s.aget(pt, i))))), nr = descOfName(w.nameOf(s.classId(s.rtype(nominal))));
  const wrong = () => fail("java/lang/invoke/WrongMethodTypeException", `Expected ${prettySig(np, nr)} but was ${prettySig(sp, sr)}`);
  const same = np.length === sp.length && np.every((d, i) => d === sp[i]) && nr === sr;
  if (!same && (exact || np.length !== sp.length)) wrong();
  const kind = s.handleKind(mh!), K = s.kinds, art = s.art(mh!);
  const convert = (v: object | null, from: string, to: string): object | null => {
    if (from === to) return v;
    if (to === "V") return null;
    if (from === "V") return to.length === 1 ? zero(w, to) : null;
    if (to.length === 1 && from.length === 1) return WIDEN[from]?.includes(to) ? primConv(w, from, to)(v) : wrong();
    if (from.length === 1) return w.prog.isSubclass(wrapperOf(from), descToName(to)) || to === "Ljava/lang/Object;" ? v : wrong();
    if (to.length === 1) {
      if (v === null) return fail("java/lang/NullPointerException", `Expected to unbox a '${prettyType(from)}' primitive type but was returned null`);
      const have = WRAPPER.get(nameOfObj(w, v));
      return have === undefined || !WIDEN[have].includes(to) ? fail("java/lang/ClassCastException", `Cannot convert ${nameOfObj(w, v).replace(/\//g, ".")} to ${prettyType(to)}`) : primConv(w, have, to)(v);
    }
    return v === null || isInstance(w, to, v) ? v : fail("java/lang/ClassCastException", `Cannot cast ${nameOfObj(w, v).replace(/\//g, ".")} to ${prettyType(to)}`);
  };
  const given = Array.from({ length: sp.length }, (_, i) => convert(s.aget(args, i), sp[i], np[i]));
  const out = (v: object | null) => convert(v, nr, sr);
  const call = (info: RInfo, cid: number, idx: number, recv: object | null, rest: (object | null)[]) => {
    const list = s.newArray(rest.length);
    rest.forEach((v, i) => s.aset(list, i, v));
    return (w.table.get(hostReflect(w, info, cid, idx)) as Function)(recv, list) as object | null;
  };
  switch (kind) {
    case K.INVOKE_STATIC: return out(call(RInfo.MethodCall, Number(art >> 16n), Number(art & 0xffffn), null, given));
    case K.INVOKE_VIRTUAL: case K.INVOKE_INTERFACE:
      return out(call(RInfo.MethodCall, Number(art >> 16n), Number(art & 0xffffn), given[0], given.slice(1)));
    case K.INVOKE_DIRECT: case K.INVOKE_SUPER:
      return out(call(RInfo.MethodCallDirect, Number(art >> 16n), Number(art & 0xffffn), given[0], given.slice(1)));
    case K.IGET: case K.SGET: case K.IPUT: case K.SPUT: {
      const id = Number(art), put = kind === K.IPUT || kind === K.SPUT, stat = kind === K.SGET || kind === K.SPUT;
      const r = fieldAccess(w, id, put, stat)(...(stat ? given : given.slice(0, put ? 2 : 1)));
      return out(put ? null : r);
    }
  }
  w.onGap(w.gapId(`MethodHandle.${exact ? "invokeExact" : "invoke"} of a transformer handle (kind ${kind}): needs EmulatedStackFrame`));
  return fail("java/lang/UnsatisfiedLinkError", `MethodHandle transformer (kind ${kind})`);
}

function parseDescs(s: string): string[] { return s.match(/\[*(L[^;]*;|[ZBCSIJFD])/g) ?? []; }
const zero = (w: World, d: string): object => w.hostFn(`mh:zero:${d}`, [], "L", (cx, c) => { kindOf(d) === "J" ? c.i64(0n) : c.i32(0); box(cx, c, d); })() as object;
const isInstance = (w: World, desc: string, v: object): boolean => !!w.hostFn(`mh:inst:${desc}`, ["L"], "I", (cx, c) => { c.lget(0).call(cx.instanceOfFn(desc[0] === "L" ? descToName(desc) : desc)); })(v);

/** a boxed `from` as a boxed `to`, widening as the language does */
function primConv(w: World, from: string, to: string): (v: object | null) => object | null {
  return w.hostFn(`mh:conv:${from}${to}`, ["L"], "L", (cx, c) => {
    c.lget(0);
    unbox(cx, c, from);
    // float and double values are their bits here; compute in f32/f64
    const fk = from === "J" || from === "D" ? "J" : "I";
    if (from === "F") c.raw(OP.f32_reinterpret_i32); else if (from === "D") c.raw(OP.f64_reinterpret_i64);
    const asLong = (f: string) => f === "J";
    if (to === "J") { if (fk === "I") c.raw(OP.i64_extend_i32_s); }
    else if (to === "F") { if (from !== "F") c.raw(asLong(from) ? OP.f32_convert_i64_s : OP.f32_convert_i32_s); c.raw(OP.i32_reinterpret_f32); }
    else if (to === "D") { if (from === "F") c.raw(OP.f64_promote_f32); else if (from !== "D") c.raw(asLong(from) ? OP.f64_convert_i64_s : OP.f64_convert_i32_s); c.raw(OP.i64_reinterpret_f64); }
    box(cx, c, to);
  }) as never;
}

/** the generated accessor of field `id` (class id << 12 | index) on boxed values: get(obj?) answers the boxed value, put(obj?, value) stores it */
function fieldAccess(w: World, id: number, put: boolean, stat: boolean): (...a: (object | null)[]) => object | null {
  const jc = w.prog.get(w.nameOf(id >>> 12))!, f = jc.fields[id & 0xfff];
  return w.hostFn(`mh:${put ? "put" : "get"}:${id}`, [...stat ? [] : ["L" as const], ...put ? ["L" as const] : []], put ? "V" : "L", (cx, c) => {
    const st = cx.structFor(jc.name), at = stat ? -1 : cx.fieldIndex(jc.name, f), value = stat ? 0 : 1;
    if (stat) cx.emitEnsure(c, jc.name);
    else { c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); }
    const target = () => { c.lget(0).refCast(st); };
    if (!put) {
      if (stat) c.gget(cx.staticGlobal(jc.name, f.name, f.desc)); else { target(); c.structGet(st, at); }
      if (BOX[f.desc]) box(cx, c, f.desc);
      return;
    }
    if (!stat) target();
    c.lget(value);
    if (BOX[f.desc]) unbox(cx, c, f.desc);
    if (stat) c.gset(cx.staticGlobal(jc.name, f.name, f.desc)); else c.structSet(st, at);
  }) as never;
}
