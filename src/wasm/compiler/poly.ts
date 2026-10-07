// invoke-polymorphic on VarHandle access modes (AtomicInteger, AtomicReference, ForkJoinPool, ConcurrentLinkedQueue, ...).
//
// The call site's proto fixes the coordinate and value types; the VarHandle object decides which field they reach. A field
// handle carries its field id (class id << 12 | index among the class's declared fields) in FieldVarHandle.artField, so a
// site is compiled to a test of that id against the fields it can reach (declared fields of classes that relate to the
// receiver type, i.e. its class and superclasses, and have the value type's family) and, per field, the access mode as plain struct operations. An array
// handle's coordinates are the array and the index, so it needs no dispatch. Java threads yield only at suspension points, so
// read-modify-write modes need no atomics. A receiver of a class with no field of the value type to try, or any static field, is reached
// through the accessor slot the host hands out for the handle's field id (hostUnsafe). A value type that would need boxing is a gap.
import { OP } from "./code";
import { T, refNull, type VT } from "./wasmbin";
import { kindOf, type Kind } from "./program";
import { elemKindOf } from "./consts";
import { descToName, isWide, varHandleValues } from "../../jvm/abi";
import { emitStoreCheck, classMethod, Info } from "../link/classes";
import { UInfo } from "../link/unsafe";
import type { PreparedInstruction as Ins } from "../../jvm/prepared";
import type { Compiler } from "./j2w";
import type { Code } from "./code";
import type { MC } from "./method";
import { emitHandleCall } from "../link/mhandles";

const VH = "java/lang/invoke/VarHandle", FVH = "java/lang/invoke/FieldVarHandle", MAX_CANDIDATES = 64;
type Family = "I" | "F" | "J" | "D" | "L";
const family = (d: string): Family => d[0] === "L" || d[0] === "[" ? "L" : d[0] === "J" || d[0] === "D" || d[0] === "F" ? d[0] as Family : "I";
type Op = "get" | "set" | "cas" | "cae" | "getAndSet" | "getAndAdd" | "getAndBitwiseOr" | "getAndBitwiseAnd" | "getAndBitwiseXor";
const opOf = (mode: string): Op => mode.startsWith("getAnd") ? mode.replace(/(Acquire|Release)$/, "") as Op : mode.startsWith("compareAndExchange") ? "cae"
  : /^(weakC|c)ompareAndSet/.test(mode) ? "cas" : mode.startsWith("set") ? "set" : "get";
const ARITH = { Add: [OP.i32_add, OP.i64_add], BitwiseAnd: [OP.i32_and, OP.i64_and], BitwiseOr: [OP.i32_or, OP.i64_or], BitwiseXor: [OP.i32_xor, OP.i64_xor] } as Record<string, number[]>;

/** where a handle's variable lives, as struct or array operations on locals */
export interface Place { load(): void; store(v: number): void; /** brings the int on the stack into the range of a byte, short or char variable */ narrow?(): void }
const narrowTo = (c: import("./code").Code, letter: string) => { if (letter === "B") c.raw(OP.i32_extend8_s); else if (letter === "S") c.raw(OP.i32_extend16_s); else if (letter === "C") c.i32(0xffff).raw(OP.i32_and); };

/** Read-modify-write operations stay synchronous between their load and store. */
export function emitVarHandleOperation(cx: Compiler, c: Code, mode: string, type: string, p: Place, vals: number[]): void {
  const op = opOf(mode), K = kindOf(type), vf = family(type);
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
      if (vf === "F") c.raw(OP.f32_reinterpret_i32).lget(vals[0]).raw(OP.f32_reinterpret_i32, OP.f32_add, OP.i32_reinterpret_f32);
      else if (vf === "D") c.raw(OP.f64_reinterpret_i64).lget(vals[0]).raw(OP.f64_reinterpret_i64, OP.f64_add, OP.i64_reinterpret_f64);
      else c.lget(vals[0]).raw(ARITH[op.slice("getAnd".length)][K === "I" ? 0 : 1]);
      if (K === "I") p.narrow?.();
      c.lset(next); p.store(next); c.lget(old);
    }
  }
}

export function emitPolymorphic(mc: MC, ins: Ins): void {
  const { cx, code: c, dex } = mc;
  const mr = dex.method(ins.b), cls = descToName(dex.type(mr.cls)), mode = mr.name, proto = dex.proto(ins.c);
  if (cls === "java/lang/invoke/MethodHandle" && (mode === "invoke" || mode === "invokeExact")) return emitHandleCall(mc, ins, mode === "invokeExact");
  const params = proto.params.map((t) => dex.type(t)), ret = dex.type(proto.ret), nv = cls === VH ? varHandleValues(mode) : undefined;
  if (nv === undefined) return mc.invokeGap(ins, `${cls}.${mode}`);
  const regs: number[] = [];
  for (let ri = 1, i = 0; i < params.length; ri += isWide(params[i++]) ? 2 : 1) regs.push(ins.regs[ri]);
  const result = emitVarHandleAccess(cx, c, mode, params, ret, () => mc.get("L", ins.regs[0]), (kind, i) => mc.get(kind, regs[i]), why => mc.invokeGap(ins, `${cls}.${mode}: ${why}`));
  if (result) mc.finishResult(ins, result);
}

/** Canonical storage operations shared by DEX polymorphic sites and MethodHandle VarHandle invokers. */
export function emitVarHandleAccess(cx: Compiler, c: Code, mode: string, params: string[], ret: string, handle: () => void, read: (kind: Kind, index: number) => void, onGap = (why: string) => cx.gap(c, `${VH}.${mode}: ${why}`)): Kind | null | undefined {
  const nv = varHandleValues(mode)!;
  const coords = params.slice(0, params.length - nv), valueTypes = params.slice(params.length - nv), op = opOf(mode);
  const vf = family(nv ? valueTypes[0] : ret), K = kindOf(nv ? valueTypes[0] : ret);
  const gap = (why: string) => { onGap(why); return undefined; };
  if ((vf === "F" || vf === "D") && op.startsWith("getAnd") && op !== "getAndSet" && op !== "getAndAdd") return gap("arithmetic on a floating-point variable");
  if (valueTypes.some((t) => family(t) !== vf) || (op === "get" || op === "cae" || op.startsWith("getAnd")) && ret !== "V" && family(ret) !== vf) return gap("value type needs boxing");
  const instance = coords.length === 1 && coords[0][0] === "L", array = coords.length === 2 && coords[0][0] === "[" && family(coords[1]) === "I", stat = coords.length === 0;
  if (!instance && !array && !stat) return gap("unrecognized coordinates");

  const nonNull = (read: () => void) => { const local = c.newLocal(T.anyref); read(); c.ltee(local).refIsNull().if_(); cx.callThrower(c, "npe"); c.end().lget(local); };
  const produces: Kind | null = op === "cas" ? "I" : op === "set" ? null : K;
  const bt: VT | null = produces && cx.vtOf(produces);
  const classCast = () => { c.i32(0).i32(0); cx.callThrower(c, "cce"); };

  const access = (p: Place, vals: number[]) => emitVarHandleOperation(cx, c, mode, nv ? valueTypes[0] : ret, p, vals);
  const readValues = () => valueTypes.map((t, i) => { const k = kindOf(t), l = c.newLocal(cx.vtOf(k)); read(k, coords.length + i); c.lset(l); return l; });

  if (array) {
    const letter = coords[0][1], ek = elemKindOf(coords[0]);
    if (family(coords[0].slice(1)) !== vf) return gap("element type");
    const t = cx.tArr[ek], d = cx.tData[ek], handleType = c.newLocal(T.anyref), wrapper = c.newLocal(cx.vtOf("L")), data = c.newLocal(refNull(d)), idx = c.newLocal(T.i32);
    const vhs = cx.structFor(VH);
    nonNull(handle); c.refCast(vhs).structGet(vhs, cx.fieldIndex(VH, { owner: VH, name: "coordinateType0", desc: "Ljava/lang/Class;" })).lset(handleType);
    nonNull(() => read("L", 0)); c.lset(wrapper);
    // the array must be of the handle's array class (a String[] handle does not take an Object[]), and of the storage the site's element type implies
    c.lget(handleType); c.lget(wrapper); classMethod(cx, c, "java/lang/Class", "isInstance", "(Ljava/lang/Object;)Z"); c.lget(wrapper).refTest(t).raw(OP.i32_and).raw(OP.i32_eqz).if_(); classCast(); c.end();
    c.lget(wrapper).refCast(t).structGet(t, 2).lset(data);
    read("I", 1); c.lset(idx).lget(idx).lget(data).refAsNonNull().arrayLen().raw(OP.i32_ge_u).if_();
    c.lget(idx).lget(data).refAsNonNull().arrayLen(); cx.callThrower(c, "aioobe"); c.end();
    const vals = readValues();
    access({ load: () => { c.lget(data).refAsNonNull().lget(idx); if (letter === "B" || letter === "S") c.arrayGetS(d); else if (letter === "Z" || letter === "C") c.arrayGetU(d); else c.arrayGet(d); },
      store: (v) => {
        if (ek === "ref") emitStoreCheck(cx, c, wrapper, () => c.lget(v));
        c.lget(data).refAsNonNull().lget(idx).lget(v).arraySet(d);
      }, narrow: () => narrowTo(c, letter) }, vals);
  } else {
    if (!cx.prog.get(FVH)?.dex) return gap("FieldVarHandle is not in the program");
    const R = stat ? "" : descToName(coords[0]), fvh = cx.structFor(FVH);
    const cands: { cn: string; fid: number; fi: number; letter: string }[] = [];
    for (const cn of stat ? [] : cx.prog.chain(R)) {
      const jc = cx.prog.get(cn);
      if (!jc?.def || jc.isInterface) continue;
      jc.fields.forEach((f, i) => { if (!f.isStatic && family(f.desc) === vf && i < 1 << 12) cands.push({ cn, fid: cx.idOf(cn) << 12 | i, fi: cx.fieldIndex(cn, f), letter: f.desc[0] }); });
    }
    if (R === "java/lang/Void") cx.callThrower(c, "npe");        // the receiver is the literal null
    else if (cands.length && cands.length <= MAX_CANDIDATES) {
      const vh = c.newLocal(cx.vtOf("L")), recv = c.newLocal(cx.vtOf("L")), fid = c.newLocal(T.i32);
      nonNull(handle); c.lset(vh); nonNull(() => read("L", 0)); c.lset(recv);
      const vals = readValues();
      c.lget(vh).refTest(fvh).raw(OP.i32_eqz).if_(); classCast(); c.end();
      c.lget(vh).refCast(fvh).structGet(fvh, cx.fieldIndex(FVH, { owner: FVH, name: "artField", desc: "J" })).raw(OP.i32_wrap_i64).lset(fid);
      c.block(bt);
      for (const cand of cands) {
        const st = cx.structFor(cand.cn), r = c.newLocal(refNull(st));
        c.lget(fid).i32(cand.fid).raw(OP.i32_eq).if_().lget(recv).refCast(st).lset(r);
        access({ load: () => c.lget(r).structGet(st, cand.fi), store: (v) => c.lget(r).lget(v).structSet(st, cand.fi), narrow: () => narrowTo(c, cand.letter) }, vals);
        c.br(1).end();
      }
      classCast(); c.unreachable().end();
    } else {
      // any receiver class, and static fields: the accessor of the handle's field, found at run time
      const vh = c.newLocal(cx.vtOf("L")), recv = c.newLocal(cx.vtOf("L")), fid = c.newLocal(T.i32), getter = c.newLocal(T.i32), setter = c.newLocal(T.i32), kind = { I: 0, J: 1, L: 2 }[K];
      nonNull(handle); c.lset(vh);
      if (!stat) { nonNull(() => read("L", 0)); c.lset(recv); }
      const vals = readValues();
      c.lget(vh).refTest(fvh).raw(OP.i32_eqz).if_(); classCast(); c.end();
      c.lget(vh).refCast(fvh).structGet(fvh, cx.fieldIndex(FVH, { owner: FVH, name: "artField", desc: "J" })).raw(OP.i32_wrap_i64).lset(fid);
      const owner = () => c.lget(fid).i32(12).raw(OP.i32_shr_u), index = () => c.lget(fid).i32(0xfff).raw(OP.i32_and);
      if (stat) { cx.info(c, Info.EnsureSlot, owner); c.callIndirect(cx.sig([], "V")); }
      else {
        owner(); cx.callRt(c, "classOf"); c.lget(recv); classMethod(cx, c, "java/lang/Class", "isInstance", "(Ljava/lang/Object;)Z");
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
