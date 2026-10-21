// invoke-polymorphic on VarHandle access modes (AtomicInteger, AtomicReference, ForkJoinPool, ConcurrentLinkedQueue, ...).
// Guarded accessor types and null reference operands use storage operations; other conversions and views use the Java bridge.
import { OP } from "./code.ts";
import { T, ref, refNull, type VT } from "./wasmbin.ts";
import { ACC, kindOf, type FieldInfo, type Kind, typeName } from "./program.ts";
import { elemKindOf } from "./consts.ts";
import { descToName, varHandleValues } from "../../jvm/abi.ts";
import { argRegisters, type PreparedInstruction as Ins } from "../../jvm/prepared.ts";
import type { Compiler } from "./j2w.ts";
import type { Code } from "./code.ts";
import type { MC } from "./method.ts";
import { emitHandleCall } from "./handles.ts";
import { Info, UInfo } from "./info.ts";
import { valueKind, I as KI, F as KF, D as KD, R as KR } from "./infer.ts";

const VH = "java/lang/invoke/VarHandle", FVH = "java/lang/invoke/FieldVarHandle", MAX_CANDIDATES = 64;
type Op = "get" | "set" | "cas" | "cae" | "getAndSet" | "getAndAdd" | "getAndBitwiseOr" | "getAndBitwiseAnd" | "getAndBitwiseXor";
const opOf = (mode: string): Op => mode.startsWith("getAnd") ? mode.replace(/(Acquire|Release)$/, "") as Op : mode.startsWith("compareAndExchange") ? "cae"
  : /^(weakC|c)ompareAndSet/.test(mode) ? "cas" : mode.startsWith("set") ? "set" : "get";
const ARITH = { Add: [OP.i32_add, OP.i64_add], BitwiseAnd: [OP.i32_and, OP.i64_and], BitwiseOr: [OP.i32_or, OP.i64_or], BitwiseXor: [OP.i32_xor, OP.i64_xor] } as Record<string, number[]>;

/** where a handle's variable lives, as struct or array operations on locals */
export interface Place { load(): void; store(v: number): void; /** brings the int on the stack into the range of a byte, short or char variable */ narrow?(): void }
const narrowTo = (c: Code, letter: string) => { if (letter === "B") c.raw(OP.i32_extend8_s); else if (letter === "S") c.raw(OP.i32_extend16_s); else if (letter === "C") c.i32(0xffff).raw(OP.i32_and); };

/** Read-modify-write operations stay synchronous between their load and store. */
export function emitVarHandleOperation(cx: Compiler, c: Code, mode: string, type: string, p: Place, vals: number[]): void {
  const op = opOf(mode), K = kindOf(type), vf = valueKind(type);
  const eq = () => K === "L" ? c.call(cx.helper("acmp")) : c.raw(K === "I" ? OP.i32_eq : OP.i64_eq);
  const old = op === "get" || op === "set" || op === "cas" ? -1 : c.newLocal(cx.vtOf(K));
  switch (op) {
    case "get": p.load(); return;
    case "set": p.store(vals[0]); return;
    case "cas": p.load(); c.lget(vals[0]); eq(); c.if_(T.i32); p.store(vals[1]); c.i32(1).else_().i32(0).end(); return;
    case "cae": p.load(); c.lset(old).lget(old).lget(vals[0]); eq(); c.if_(); p.store(vals[1]); c.end(); c.lget(old); return;
    case "getAndSet": p.load(); c.lset(old); p.store(vals[0]); c.lget(old); return;
    default: { // getAndAdd, getAndBitwiseOr/And/Xor
      const next = c.newLocal(cx.vtOf(K));
      p.load(); c.lset(old).lget(old);
      if (vf === KF) c.raw(OP.f32_reinterpret_i32).lget(vals[0]).raw(OP.f32_reinterpret_i32, OP.f32_add, OP.i32_reinterpret_f32);
      else if (vf === KD) c.raw(OP.f64_reinterpret_i64).lget(vals[0]).raw(OP.f64_reinterpret_i64, OP.f64_add, OP.i64_reinterpret_f64);
      else c.lget(vals[0]).raw(ARITH[op.slice("getAnd".length)][K === "I" ? 0 : 1]);
      if (K === "I") p.narrow?.();
      c.lset(next); p.store(next); c.lget(old);
    }
  }
}

export function emitPolymorphic(mc: MC, ins: Ins): void {
  const mr = mc.dex.method(ins.b), cls = mc.types.typeName(mr.cls), mode = mr.name;
  if (cls === "java/lang/invoke/MethodHandle" && (mode === "invoke" || mode === "invokeExact")) return emitHandleCall(mc, ins, mode === "invokeExact");
  if (cls !== VH || varHandleValues(mode) === undefined) return mc.invokeGap(ins, `${cls}.${mode}`);
  if (!emitExactAccess(mc, ins, mode)) return emitHandleCall(mc, ins, false, mode);
}

/** Compare the live libcore accessor classes, including defining loader identity, before using unboxed storage. */
function emitExactAccess(mc: MC, ins: Ins, mode: string): boolean {
  const { cx, code: c, dex, types } = mc, proto = dex.proto(ins.c), params = proto.params.map(t => types.type(t)), ret = types.type(proto.ret);
  const nv = varHandleValues(mode)!;
  if (params.length < nv) return false;
  const coords = params.slice(0, params.length - nv), values = params.slice(params.length - nv), op = opOf(mode);
  const variable = nv ? values[nv - 1] : ret;
  const nullValues = values.map((t, i) => t === variable ? -1 : i).filter(i => i >= 0);
  if (variable === "V" || nullValues.some(i => valueKind(values[i]) !== KR || valueKind(variable) !== KR)
    || ret !== (op === "set" ? "V" : op === "cas" ? "Z" : variable)) return false;
  // App sites resolve the whole prototype before compilation; boot sites have no symbolic resolver.
  if (cx.prog.loaderOf(mc.m.cls) === cx.prog.boot && nullValues.some(i => {
    const component = values[i].replace(/^\[+/, "");
    return component[0] === "L" && !cx.prog.lookup(cx.prog.boot, descToName(component));
  })) return false;
  const storage = coords.length === 0 ? "java/lang/invoke/StaticFieldVarHandle"
    : coords.length === 1 && coords[0][0] === "L" ? FVH
    : coords.length === 2 && coords[0][0] === "[" && coords[1] === "I" && coords[0].slice(1) === variable ? "java/lang/invoke/ArrayElementVarHandle" : undefined;
  if (coords.length === 1 && cx.structFor(descToName(coords[0])) === cx.tStr) return false;
  if (!storage || valueKind(variable) & (KF | KD) && op.startsWith("getAndBitwise")) return false;
  const regs = argRegisters(ins, params, 1);
  const handle = c.newLocal(T.anyref), match = c.newLocal(T.i32), vt = cx.structFor(VH), clsDesc = "Ljava/lang/Class;";
  const classes = c.newLocal(ref(cx.tData.ref)), expected = c.newLocal(T.anyref);
  mc.nonNull(ins.regs[0]); c.lset(handle);
  c.gget(cx.ctab()).refAsNonNull().lset(classes);
  c.lget(handle).refTest(cx.structFor(storage));
  const sameClass = (field: string, desc?: string) => {
    c.lget(handle).refCast(vt).structGet(vt, cx.fieldIndex(VH, { owner: VH, name: field, desc: clsDesc }));
    if (desc) {
      const id = cx.idOf(typeName(desc));
      // An uncached expected mirror cannot match a live handle.
      c.i32(id).lget(classes).arrayLen().raw(OP.i32_lt_u).if_(T.anyref).lget(classes).i32(id).arrayGet(cx.tData.ref).else_().anyNull().end();
      c.ltee(expected).call(cx.helper("acmp")).lget(expected).refIsNull().raw(OP.i32_eqz, OP.i32_and);
    } else c.refIsNull();
    c.raw(OP.i32_and);
  };
  sameClass("varType", variable); sameClass("coordinateType0", coords[0]); sameClass("coordinateType1", coords[1]);
  // Unequal reference descriptors can share storage only when the converted argument is actually null.
  for (const i of nullValues) { mc.get("L", regs[coords.length + i]); c.refIsNull().raw(OP.i32_and); }
  c.ltee(match).if_();
  const accessMode = `${VH}$AccessMode`;
  const owner = cx.prog.lookup(cx.prog.boot, accessMode);
  const name = mode.replace(/[A-Z]/g, letter => "_" + letter).toUpperCase();
  const field = owner && cx.prog.get(owner)?.fields.find(f => f.name === name && f.desc === `L${owner};`
    && f.isStatic && (f.flags & (ACC.PUBLIC | ACC.FINAL | ACC.ENUM)) === (ACC.PUBLIC | ACC.FINAL | ACC.ENUM));
  c.lget(handle);
  if (field) {
    cx.emitEnsure(c, field.owner); c.gget(cx.staticGlobal(field.owner, field.name, field.desc));
  } else {
    cx.emitEnsure(c, accessMode); cx.str.literal(c, mode);
    cx.callMethod(c, cx.prog.resolve(accessMode, "valueFromMethodName", `(Ljava/lang/String;)L${accessMode};`)!);
  }
  cx.callMethod(c, cx.prog.resolve(VH, "isAccessModeSupported", `(L${accessMode};)Z`)!);
  c.lset(match).end();
  c.lget(match).if_();
  const storageParams = coords.concat(values.map(() => variable));
  const result = emitVarHandleAccess(cx, c, mode, storageParams, ret, () => c.lget(handle), (kind, i) => mc.get(kind, regs[i]));
  if (result) mc.finishResult(ins, result);
  c.else_(); emitHandleCall(mc, ins, false, mode); c.end();
  return true;
}

/** Canonical storage operations shared by DEX polymorphic sites and MethodHandle VarHandle invokers. */
export function emitVarHandleAccess(cx: Compiler, c: Code, mode: string, params: string[], ret: string, handle: () => void, read: (kind: Kind, index: number) => void): Kind | null | undefined {
  const nv = varHandleValues(mode)!;
  const coords = params.slice(0, params.length - nv), valueTypes = params.slice(params.length - nv), op = opOf(mode);
  const vf = valueKind(nv ? valueTypes[0] : ret), K = kindOf(nv ? valueTypes[0] : ret);
  const gap = (why: string) => { cx.gap(c, `${VH}.${mode}: ${why}`); return undefined; };
  if (vf & (KF | KD) && op.startsWith("getAnd") && op !== "getAndSet" && op !== "getAndAdd") return gap("arithmetic on a floating-point variable");
  if (valueTypes.some((t) => valueKind(t) !== vf) || (op === "get" || op === "cae" || op.startsWith("getAnd")) && ret !== "V" && valueKind(ret) !== vf) return gap("value type needs boxing");
  const instance = coords.length === 1 && coords[0][0] === "L", array = coords.length === 2 && coords[0][0] === "[" && valueKind(coords[1]) === KI, stat = coords.length === 0;
  if (!instance && !array && !stat) return gap("unrecognized coordinates");

  const nonNull = (read: () => void) => { const local = c.newLocal(T.anyref); read(); c.ltee(local).refIsNull().if_(); cx.callThrower(c, "npe"); c.end().lget(local); };
  const produces: Kind | null = op === "cas" ? "I" : op === "set" ? null : K;
  const bt: VT | null = produces && cx.vtOf(produces);
  const classCast = () => { c.i32(0).i32(0); cx.callThrower(c, "cce"); };

  const access = (p: Place, vals: number[]) => emitVarHandleOperation(cx, c, mode, nv ? valueTypes[0] : ret, p, vals);
  const readValues = () => valueTypes.map((t, i) => { const k = kindOf(t), l = c.newLocal(cx.vtOf(k)); read(k, coords.length + i); c.lset(l); return l; });

  if (array) {
    const letter = coords[0][1], ek = elemKindOf(coords[0]);
    if (valueKind(coords[0].slice(1)) !== vf) return gap("element type");
    const t = cx.tArr[ek], d = cx.tData[ek], handleType = c.newLocal(T.anyref), wrapper = c.newLocal(cx.vtOf("L")), data = c.newLocal(refNull(d)), idx = c.newLocal(T.i32);
    const vhs = cx.structFor(VH);
    nonNull(handle); c.refCast(vhs).structGet(vhs, cx.fieldIndex(VH, { owner: VH, name: "coordinateType0", desc: "Ljava/lang/Class;" })).lset(handleType);
    nonNull(() => read("L", 0)); c.lset(wrapper);
    // the array must be of the handle's array class (a String[] handle does not take an Object[]), and of the storage the site's element type implies
    c.lget(handleType); c.lget(wrapper); cx.callNamed(c, "java/lang/Class", "isInstance", "(Ljava/lang/Object;)Z"); c.lget(wrapper).refTest(t).raw(OP.i32_and).raw(OP.i32_eqz).if_(); classCast(); c.end();
    c.lget(wrapper).refCast(t).structGet(t, 2).lset(data);
    read("I", 1); c.lset(idx).lget(idx).lget(data).refAsNonNull().arrayLen().raw(OP.i32_ge_u).if_();
    c.lget(idx).lget(data).refAsNonNull().arrayLen(); cx.callThrower(c, "aioobe"); c.end();
    const vals = readValues();
    access({ load: () => { c.lget(data).refAsNonNull().lget(idx); if (letter === "B" || letter === "S") c.arrayGetS(d); else if (letter === "Z" || letter === "C") c.arrayGetU(d); else c.arrayGet(d); },
      store: (v) => {
        if (ek === "ref") cx.emitStoreCheck(c, wrapper, () => c.lget(v));
        c.lget(data).refAsNonNull().lget(idx).lget(v).arraySet(d);
      }, narrow: () => narrowTo(c, letter) }, vals);
  } else {
    if (!cx.prog.get(FVH)?.dex) return gap("FieldVarHandle is not in the program");
    const R = stat ? "" : descToName(coords[0]), fvh = cx.structFor(FVH);
    /** the field id of the FieldVarHandle in local `vh`, into local `fid` */
    const fieldId = (vh: number, fid: number) => {
      c.lget(vh).refTest(fvh).raw(OP.i32_eqz).if_(); classCast(); c.end();
      c.lget(vh).refCast(fvh).structGet(fvh, cx.fieldIndex(FVH, { owner: FVH, name: "artField", desc: "J" })).raw(OP.i32_wrap_i64).lset(fid);
    };
    const cands: { cn: string; fid: number; f: FieldInfo; fi: number }[] = [];
    for (const cn of stat ? [] : cx.prog.chain(R)) {
      const jc = cx.prog.get(cn);
      if (!jc?.def || jc.isInterface) continue;
      jc.fields.forEach((f, i) => { if (!f.isStatic && valueKind(f.desc) === vf && i < 1 << 12) cands.push({ cn, fid: cx.idOf(cn) << 12 | i, f, fi: cx.fieldIndex(cn, f) }); });
    }
    if (R === "java/lang/Void") { cx.callThrower(c, "npe"); c.unreachable(); }        // the receiver is the literal null
    else if (cands.length && cands.length <= MAX_CANDIDATES) {
      const vh = c.newLocal(cx.vtOf("L")), recv = c.newLocal(cx.vtOf("L")), fid = c.newLocal(T.i32);
      nonNull(handle); c.lset(vh); nonNull(() => read("L", 0)); c.lset(recv);
      const vals = readValues();
      fieldId(vh, fid);
      c.block(bt);
      for (const cand of cands) {
        const st = cx.structFor(cand.cn), r = c.newLocal(refNull(st));
        c.lget(fid).i32(cand.fid).raw(OP.i32_eq).if_().lget(recv).refCast(st).lset(r);
        access({ load: () => c.lget(r).structGet(st, cand.fi), store: (v) => cx.emitFieldStore(c, cand.cn, cand.f, () => c.lget(r), () => c.lget(v)),
          narrow: () => narrowTo(c, cand.f.desc[0]) }, vals);
        c.br(1).end();
      }
      classCast(); c.unreachable().end();
    } else {
      // any receiver class, and static fields: the accessor of the handle's field, found at run time
      const vh = c.newLocal(cx.vtOf("L")), recv = c.newLocal(cx.vtOf("L")), fid = c.newLocal(T.i32), getter = c.newLocal(T.i32), setter = c.newLocal(T.i32), kind = { I: 0, J: 1, L: 2 }[K];
      nonNull(handle); c.lset(vh);
      if (!stat) { nonNull(() => read("L", 0)); c.lset(recv); }
      const vals = readValues();
      fieldId(vh, fid);
      const owner = () => c.lget(fid).i32(12).raw(OP.i32_shr_u), index = () => c.lget(fid).i32(0xfff).raw(OP.i32_and);
      if (stat) { cx.info(c, Info.EnsureSlot, owner); c.callIndirect(cx.sig([], "V")); }
      else {
        owner(); cx.callRt(c, "classOf"); c.lget(recv); cx.callNamed(c, "java/lang/Class", "isInstance", "(Ljava/lang/Object;)Z");
        c.raw(OP.i32_eqz).if_(); classCast(); c.end();
      }
      cx.info(c, stat ? UInfo.StaticGet : UInfo.FieldGet, () => c.lget(fid), () => c.i32(kind)); c.lset(getter);
      cx.info(c, stat ? UInfo.StaticPut : UInfo.FieldPut, () => c.lget(fid), () => c.i32(kind)); c.lset(setter);
      c.lget(getter).raw(OP.i32_eqz).lget(setter).raw(OP.i32_eqz).raw(OP.i32_or).if_(); classCast(); c.end();
      const receiver = () => { if (stat) c.anyNull(); else c.lget(recv); };
      const letter = c.newLocal(T.i32), tmp = c.newLocal(T.i32);
      if (K === "I") cx.info(c, Info.FieldDesc, owner, index), c.lset(letter);
      access({ load: () => { receiver(); c.lget(getter).callIndirect(cx.sig(["L"], K)); }, store: (v) => { receiver(); c.lget(v).lget(setter).callIndirect(cx.sig(["L", K], "V")); },
        narrow: () => {
          c.lset(tmp);
          for (const l of "BSC") { c.lget(letter).i32(l.charCodeAt(0)).raw(OP.i32_eq).if_().lget(tmp); narrowTo(c, l); c.lset(tmp).end(); }
          c.lget(tmp);
        } }, vals);
    }
  }
  if (produces && ret === "V") c.drop();
  return ret === "V" ? null : produces;
}
