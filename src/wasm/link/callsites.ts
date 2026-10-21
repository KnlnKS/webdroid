// ART interpreter_common.cc DoResolveCallSite: cache successes, allow bootstrap races, and use the first published candidate.
import { WIDEN, BOX, box } from "../compiler/primitives.ts";
import type { Program } from "../compiler/program.ts";
import { OP } from "../compiler/code.ts";
import { f32bits, f64bits } from "../compiler/consts.ts";
import { T } from "../compiler/wasmbin.ts";
import { methodOf } from "../compiler/ids.ts";
import { typeFailure } from "../compiler/linkage.ts";
import { handleThunk, methodTypeSignatureTypes, mhInvoke } from "./mhandles.ts";
import { caught, chain, each } from "./maybe.ts";
import { MethodHandleType, type DexFile, type EncVal } from "../../jvm/dex.ts";
import type { Compiler } from "../compiler/j2w.ts";
import type { Code } from "../compiler/code.ts";
import type { MethodInfo } from "../compiler/program.ts";
import type { World } from "./world.ts";
import { PerWorld } from "./perworld.ts";
import type { Strand } from "./sched.ts";
import { resolveHandleReference, resolveSignatureTypes } from "./resolution.ts";
import { typeName } from "../compiler/program.ts";
import { InvokeMode, emitHandleValue, emitTypeValue, emitInvokeImport, resolveHandleMember } from "../compiler/handles.ts";

const MH = "java/lang/invoke/MethodHandle", MT = "java/lang/invoke/MethodType", CS = "java/lang/invoke/CallSite", LOOKUP = "java/lang/invoke/MethodHandles$Lookup";
const linked = new PerWorld(() => new WeakMap<DexFile, Map<number, object>>());
const scalarType: Record<number, string> = { 0: "I", 2: "I", 3: "I", 4: "I", 6: "J", 0x10: "F", 0x11: "D", 0x15: `L${MT};`, 0x16: `L${MH};`, 0x17: "Ljava/lang/String;", 0x18: "Ljava/lang/Class;", 0x1f: "I" };
type BootstrapReference = { argument: number } & (
  { kind: "handle"; index: number } | { kind: "methodType"; index: number } | { kind: "class"; owner: string; descriptor: string }
);

/** Ordered metadata, consumed inside bootstrap validation's error boundary, never while compiling unused sites. */
export function bootstrapReferences(referrer: MethodInfo, index: number): BootstrapReference[] {
  return referrer.dex.callSiteValues(index).flatMap(({ type, value }, argument): BootstrapReference[] => {
    if (type !== 0x15 && type !== 0x16 && type !== 0x18) return [];
    const idx = (value as { idx: number }).idx;
    return [type === 0x18 ? { argument, kind: "class", owner: referrer.cls, descriptor: referrer.dex.rawType(idx) }
      : { argument, kind: type === 0x16 ? "handle" : "methodType", index: idx }];
  });
}
// ART method_handles.cc uses these conversions before invocation so incompatible BSM types throw CCE, not WMTE.
function convertible(prog: Program, from: string, to: string): boolean {
  if (from === to) return true;
  if (!BOX[from] && !BOX[to]) return true;
  if (BOX[from] && BOX[to]) return WIDEN[from].includes(to);
  if (BOX[from]) return prog.isSubclass(BOX[from][0], typeName(to));
  if (from === "Ljava/lang/Object;" || from === "Ljava/lang/Number;" && to !== "Z") return true;
  const unboxed = Object.keys(BOX).find(k => typeName(from) === BOX[k][0]);
  return !!unboxed && WIDEN[unboxed].includes(to);
}
function argument(cx: Compiler, c: Code, referrer: MethodInfo, type: number, value: EncVal): boolean {
  const dex = referrer.dex;
  switch (type) {
    case 0: case 2: case 3: case 4: case 0x1f: c.i32(Number(value)); box(cx, c, "I"); return true;
    case 6: c.i64(value as bigint); box(cx, c, "J"); return true;
    case 0x10: c.i32(f32bits(value as number)); box(cx, c, "F"); return true;
    case 0x11: c.i64(f64bits(value as number)); box(cx, c, "D"); return true;
    case 0x17: cx.str.literal(c, value as string); return true;
    case 0x18: {
      const desc = cx.prog.typesOf(dex).type((value as { idx: number }).idx), failure = typeFailure(cx.prog, desc);
      if (failure) { cx.linkError(c, failure); return false; } cx.constClass(c, typeName(desc)); return true;
    }
    case 0x15: return emitTypeValue(cx, c, dex, (value as { idx: number }).idx);
    case 0x16: return emitHandleValue(cx, c, referrer, (value as { idx: number }).idx);
    default: cx.throwNew(c, "java/lang/ClassCastException", "Unsupported bootstrap argument type"); return false;
  }
}
function bootstrapFailure(prog: Program, target: MethodInfo, values: ReturnType<DexFile["callSiteValues"]>): { cls: string; message: string } | undefined {
  const fail = (cls: string, message: string) => ({ cls, message });
  if (target.flags & 0x80) {
    const last = target.params.at(-1), start = target.params.length - 1;
    if (!last || last[0] !== "[") return fail("java/lang/BootstrapMethodError", "Variable arity BSM does not have array as final argument");
    if (values.length < start) return fail("java/lang/invoke/WrongMethodTypeException", "Insufficient bootstrap arguments");
    for (let i = start; i < values.length; i++) if (scalarType[values[i].type] !== last.slice(1)) return fail("java/lang/ClassCastException", "Bootstrap collector argument type does not match component type");
  }
  const supplied = [`L${LOOKUP};`, ...values.slice(1).map(v => scalarType[v.type])];
  if (target.flags & 0x80) supplied.splice(target.params.length - 1, Infinity, target.params.at(-1)!);
  if (supplied.length !== target.params.length) return fail("java/lang/invoke/WrongMethodTypeException", "Bootstrap argument count does not match method type");
  if (supplied.some((from, i) => from && !convertible(prog, from, target.params[i])) || target.ret !== "V" && !convertible(prog, `L${CS};`, target.ret)) return fail("java/lang/ClassCastException", "Bootstrap argument or return type is not convertible");
}
function resolveBootstrapArguments(w: World, referrer: MethodInfo, index: number, parent: Strand): void | Promise<void> {
  const invalid = referrer.dex.callSiteValues(index).findIndex(v => !scalarType[v.type]);
  const references = bootstrapReferences(referrer, index).filter(r => r.argument !== 0 && (invalid < 0 || r.argument < invalid));
  return each(references, (ref) => ref.kind === "handle" ? resolveHandleReference(w, referrer, ref.index, parent)
    : resolveSignatureTypes(w, ref.kind === "methodType" ? methodTypeSignatureTypes(referrer, ref.index) : [ref], parent));
}
function bootstrap(w: World, referrer: MethodInfo, index: number, parent: Strand): object | Promise<object> {
  const values = referrer.dex.callSiteValues(index), first = values[0]?.value as { kind?: string; idx: number };
  const fail = (message: string): never => w.raise("java/lang/BootstrapMethodError", message);
  if (values.length < 3) fail(`Truncated bootstrap arguments (${values.length} < 3)`);
  if (first.kind !== "mhandle") fail("First bootstrap argument is not a method handle");
  return chain(resolveHandleReference(w, referrer, first.idx, parent), () => {
    const dex = referrer.dex, h = dex.methodHandle(first.idx), member = resolveHandleMember(w.prog, referrer, first.idx);
    const target = "method" in member && h.type === MethodHandleType.InvokeStatic ? member.method : undefined;
    const invalid = target ? bootstrapFailure(w.prog, target, values) : undefined;
    const emit = () => handleThunk(w, `custom:bootstrap:${referrer.cls}:${dex.id}:${index}:${w.epoch}`, [], "L", (cx, c) => {
      const handle = c.newLocal(T.anyref), args = c.newLocal(T.anyref), lookup = c.newLocal(T.anyref);
      if (!emitHandleValue(cx, c, referrer, first.idx)) return; c.lset(handle);
      if (h.type !== MethodHandleType.InvokeStatic) { cx.throwNew(c, "java/lang/BootstrapMethodError", "Unsupported bootstrap method invocation kind"); return; }
      if (invalid) { cx.throwNew(c, invalid.cls, invalid.message); return; }
      if (target && target.flags & 0x80) {
        c.lget(handle); cx.constClass(c, target.params.at(-1)!); cx.callNamed(c, MH, "asVarargsCollector", `(Ljava/lang/Class;)L${MH};`); c.lset(handle);
      }
      cx.emitNewArray(c, "[Ljava/lang/Object;", () => c.i32(values.length)); c.lset(args);
      cx.emitEnsure(c, LOOKUP); cx.emitNew(c, LOOKUP); c.ltee(lookup); cx.constClass(c, referrer.cls); c.i32(15);
      cx.callNamed(c, LOOKUP, "<init>", "(Ljava/lang/Class;I)V");
      c.lget(args).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).i32(0).lget(lookup).arraySet(cx.tData.ref);
      const params = [`L${LOOKUP};`];
      for (let i = 1; i < values.length; i++) {
        const { type, value } = values[i];
        c.lget(args).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).i32(i);
        if (!argument(cx, c, referrer, type, value)) return; c.arraySet(cx.tData.ref); params.push(scalarType[type]);
      }
      emitInvokeImport(cx, c, () => c.lget(handle), () => c.lget(args), `(${params.join("")})L${CS};`, InvokeMode.Invoke);
    }, parent)() as object | Promise<object>;
    return !target || invalid ? emit() : chain(resolveBootstrapArguments(w, referrer, index, parent), emit);
  });
}
function wrap(w: World, e: unknown, index: number, parent: Strand): never | Promise<never> {
  const throwable = w.throwable(w.boundary(e));
  if (!throwable || w.prog.isSubclass(w.classNameOf(throwable), "java/lang/Error")) throw e;
  return chain(handleThunk(w, `custom:bootstrapError:${index}`, ["L"], "L", (cx, c, arg) => {
    const ctor = cx.prog.resolve("java/lang/BootstrapMethodError", "<init>", "(Ljava/lang/String;Ljava/lang/Throwable;)V")!;
    cx.construct(c, ctor, () => { cx.str.literal(c, `Exception from call site #${index} bootstrap method`); arg(0); });
  }, parent)(throwable) as object | Promise<object>, wrapped => { throw w.exception(wrapped); });
}
export function invokeCustom(w: World, site: string, args: object, parent: Strand): object | null | Promise<object | null> {
  const split = site.lastIndexOf("#"), index = Number(site.slice(split + 1)), referrer = methodOf(w.prog, site.slice(0, split))!;
  const dexes = linked.get(w);
  let sites = dexes.get(referrer.dex); if (!sites) dexes.set(referrer.dex, sites = new Map());
  const signature = () => w.prog.typesOf(referrer.dex).protoDesc(referrer.dex.callSiteProto(index));
  const targetOf = w.helpers.fieldReader<object | null>(CS, "target", `L${MH};`);
  const invoke = (callSite: object) => mhInvoke(w, targetOf(callSite), args, signature(), InvokeMode.Exact, parent);
  const cached = sites.get(index); if (cached) return invoke(cached);
  const validate = (candidate: object | null): object | Promise<object> => {
    const sig = signature();
    return handleThunk(w, `custom:validate:${sig}:${w.epoch}`, ["L"], "L", (cx, c, arg) => {
      arg(0); c.refIsNull().if_(); cx.throwNew(c, "java/lang/ClassCastException", "Bootstrap method returned null"); c.end();
      arg(0); cx.emitCast(c, CS); const local = c.newLocal(T.anyref); c.lset(local);
      const field = cx.prog.resolveField(CS, "target", `L${MH};`)!, st = cx.structFor(CS);
      c.lget(local).refCast(st).structGet(st, cx.fieldIndex(CS, field));
      const target = c.newLocal(T.anyref); c.lset(target).lget(target).refIsNull().if_(); cx.throwNew(c, "java/lang/ClassCastException", "Bootstrap method returned a CallSite with a null target"); c.end();
      c.lget(target); cx.callNamed(c, MH, "type", `()L${MT};`);
      if (!emitTypeValue(cx, c, referrer.dex, referrer.dex.callSiteProto(index))) return;
      cx.callNamed(c, MT, "equals", "(Ljava/lang/Object;)Z");
      c.raw(OP.i32_eqz).if_(); cx.throwNew(c, "java/lang/invoke/WrongMethodTypeException", "Bootstrap target is not of the requested type"); c.end().lget(local);
    }, parent)(candidate) as object | Promise<object>;
  };
  let resolved: object | Promise<object>;
  try { resolved = caught(chain(bootstrap(w, referrer, index, parent), validate), e => wrap(w, e, index, parent)); }
  catch (e) { return wrap(w, e, index, parent); }
  return chain(resolved, candidate => {
    const winner = sites!.get(index) ?? candidate; sites!.set(index, winner);
    return invoke(winner);
  });
}
