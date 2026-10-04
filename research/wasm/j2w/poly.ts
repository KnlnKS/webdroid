// invoke-polymorphic on VarHandle access modes (AtomicInteger, AtomicReference, ForkJoinPool, ConcurrentLinkedQueue, ...).
//
// The call site's proto fixes the coordinate and value types; the VarHandle object decides which field they reach. A field
// handle carries its field id (class id << 12 | index among the class's declared fields) in FieldVarHandle.artField, so a
// site is compiled to a test of that id against the fields it can reach (declared fields of classes that relate to the
// receiver type, i.e. its class and superclasses, and have the value type's family) and, per field, the access mode as plain struct operations. An array
// handle's coordinates are the array and the index, so it needs no dispatch. Java threads yield only at suspension points, so
// read-modify-write modes need no atomics. A MethodHandle call site, a static-field handle and a value type that would need
// boxing are recorded as gaps.
import { OP } from "./code";
import { T, refNull, type VT } from "./wasmbin";
import { kindOf, type Kind } from "./program";
import { elemKindOf } from "./consts";
import { descToName, isWide, varHandleValues } from "../../../src/jvm/abi";
import { emitStoreCheck } from "./classes";
import type { PreparedInstruction as Ins } from "../../../src/jvm/prepared";
import type { MC } from "./method";

const VH = "java/lang/invoke/VarHandle", FVH = "java/lang/invoke/FieldVarHandle", MAX_CANDIDATES = 64;
type Family = "I" | "F" | "J" | "D" | "L";
const family = (d: string): Family => d[0] === "L" || d[0] === "[" ? "L" : d[0] === "J" || d[0] === "D" || d[0] === "F" ? d[0] as Family : "I";
type Op = "get" | "set" | "cas" | "cae" | "getAndSet" | "getAndAdd" | "getAndBitwiseOr" | "getAndBitwiseAnd" | "getAndBitwiseXor";
const opOf = (mode: string): Op => mode.startsWith("getAnd") ? mode.replace(/(Acquire|Release)$/, "") as Op : mode.startsWith("compareAndExchange") ? "cae"
  : /^(weakC|c)ompareAndSet/.test(mode) ? "cas" : mode.startsWith("set") ? "set" : "get";
const ARITH = { Add: [OP.i32_add, OP.i64_add], BitwiseAnd: [OP.i32_and, OP.i64_and], BitwiseOr: [OP.i32_or, OP.i64_or], BitwiseXor: [OP.i32_xor, OP.i64_xor] } as Record<string, number[]>;

/** where a handle's variable lives, as struct or array operations on locals */
interface Place { load(): void; store(v: number): void }

export function emitPolymorphic(mc: MC, ins: Ins): void {
  const { cx, code: c, dex } = mc;
  const mr = dex.method(ins.b), cls = descToName(dex.type(mr.cls)), mode = mr.name, proto = dex.proto(ins.c);
  const params = proto.params.map((t) => dex.type(t)), ret = dex.type(proto.ret), nv = cls === VH ? varHandleValues(mode) : undefined;
  if (nv === undefined) return mc.invokeGap(ins, `${cls}.${mode}`);
  const coords = params.slice(0, params.length - nv), valueTypes = params.slice(params.length - nv), op = opOf(mode);
  const vf = family(nv ? valueTypes[0] : ret), K = kindOf(nv ? valueTypes[0] : ret);
  const gap = (why: string) => mc.invokeGap(ins, `${cls}.${mode}: ${why}`);
  if ((vf === "F" || vf === "D") && op.startsWith("getAnd") && op !== "getAndSet") return gap("arithmetic on a floating-point variable");
  if (valueTypes.some((t) => family(t) !== vf) || (op === "get" || op === "cae" || op.startsWith("getAnd")) && ret !== "V" && family(ret) !== vf) return gap("value type needs boxing");
  const instance = coords.length === 1 && coords[0][0] === "L", array = coords.length === 2 && coords[0][0] === "[" && family(coords[1]) === "I";
  if (!instance && !array) return gap("static or unrecognized coordinates");

  const regs: number[] = []; for (let ri = 1, i = 0; i < params.length; ri += isWide(params[i++]) ? 2 : 1) regs.push(ins.regs[ri]);
  const produces: Kind | null = op === "cas" ? "I" : op === "set" ? null : K;
  const bt: VT | null = produces && cx.vtOf(produces);
  const classCast = () => { c.i32(0).i32(0); cx.callThrower(c, "cce"); };

  /** the access mode on `p`; leaves the mode's result (if any) on the stack */
  const access = (p: Place, vals: number[]) => {
    const eq = () => K === "L" ? c.refEq() : c.raw(K === "I" ? OP.i32_eq : OP.i64_eq);
    const old = op === "get" || op === "set" || op === "cas" ? -1 : c.newLocal(cx.vtOf(K));
    switch (op) {
      case "get": p.load(); return;
      case "set": p.store(vals[0]); return;
      case "cas": p.load(); c.lget(vals[0]); eq(); c.if_(T.i32); p.store(vals[1]); c.i32(1).else_().i32(0).end(); return;
      case "cae": p.load(); c.lset(old).lget(old).lget(vals[0]); eq(); c.if_(); p.store(vals[1]); c.end(); c.lget(old); return;
      case "getAndSet": p.load(); c.lset(old); p.store(vals[0]); c.lget(old); return;
      default: { // getAndAdd, getAndBitwiseOr/And/Xor
        const next = c.newLocal(cx.vtOf(K));
        p.load(); c.lset(old).lget(old).lget(vals[0]).raw(ARITH[op.slice("getAnd".length)][K === "I" ? 0 : 1]).lset(next); p.store(next); c.lget(old);
      }
    }
  };
  const readValues = () => valueTypes.map((t, i) => { const k = kindOf(t), l = c.newLocal(cx.vtOf(k)); mc.get(k, regs[coords.length + i]); c.lset(l); return l; });

  if (array) {
    const ek = elemKindOf(coords[0]);
    if (family(coords[0].slice(1)) !== vf || (ek !== "i32" && ek !== "i64" && ek !== "ref")) return gap("element type");
    const t = cx.tArr[ek], d = cx.tData[ek], wrapper = c.newLocal(cx.vtOf("L")), data = c.newLocal(refNull(d)), idx = c.newLocal(T.i32);
    mc.nonNull(ins.regs[0]); c.drop();
    mc.nonNull(regs[0]); c.lset(wrapper).lget(wrapper).refCast(t).structGet(t, 2).lset(data);
    mc.get("I", regs[1]); c.lset(idx).lget(idx).lget(data).refAsNonNull().arrayLen().raw(OP.i32_ge_u).if_();
    c.lget(idx).lget(data).refAsNonNull().arrayLen(); cx.callThrower(c, "aioobe"); c.end();
    const vals = readValues();
    access({ load: () => c.lget(data).refAsNonNull().lget(idx).arrayGet(d), store: (v) => {
      if (ek === "ref") emitStoreCheck(cx, c, wrapper, () => c.lget(v));
      c.lget(data).refAsNonNull().lget(idx).lget(v).arraySet(d);
    } }, vals);
  } else {
    if (!cx.prog.get(FVH)?.dex) return gap("FieldVarHandle is not in the program");
    const R = descToName(coords[0]), fvh = cx.structFor(FVH);
    const cands: { cn: string; fid: number; fi: number }[] = [];
    for (const cn of cx.prog.chain(R)) {
      const jc = cx.prog.get(cn);
      if (!jc?.def || jc.isInterface) continue;
      jc.fields.forEach((f, i) => { if (!f.isStatic && family(f.desc) === vf && i < 1 << 12) cands.push({ cn, fid: cx.idOf(cn) << 12 | i, fi: cx.fieldIndex(cn, f) }); });
    }
    if (R === "java/lang/Void") cx.callThrower(c, "npe"), c.unreachable();        // the receiver is the literal null
    else {
      if (!cands.length || cands.length > MAX_CANDIDATES) return gap(`${cands.length} candidate fields`);
      const vh = c.newLocal(cx.vtOf("L")), recv = c.newLocal(cx.vtOf("L")), fid = c.newLocal(T.i32);
      mc.nonNull(ins.regs[0]); c.lset(vh); mc.nonNull(regs[0]); c.lset(recv);
      const vals = readValues();
      c.lget(vh).refTest(fvh).raw(OP.i32_eqz).if_(); classCast(); c.end();
      c.lget(vh).refCast(fvh).structGet(fvh, cx.fieldIndex(FVH, { owner: FVH, name: "artField", desc: "J" })).raw(OP.i32_wrap_i64).lset(fid);
      c.block(bt);
      for (const cand of cands) {
        const st = cx.structFor(cand.cn), r = c.newLocal(refNull(st));
        c.lget(fid).i32(cand.fid).raw(OP.i32_eq).if_().lget(recv).refCast(st).lset(r);
        access({ load: () => c.lget(r).structGet(st, cand.fi), store: (v) => c.lget(r).lget(v).structSet(st, cand.fi) }, vals);
        c.br(1).end();
      }
      classCast(); c.unreachable().end();
    }
  }
  if (produces && ret === "V") c.drop();
  else if (produces) mc.finishResult(ins, produces);
}
