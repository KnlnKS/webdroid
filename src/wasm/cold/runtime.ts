import type { ColdSnapshot } from "./state";
import { decodeInstructions } from "../../jvm/prepared";
import { OP } from "../compiler/code";
import { Compiler } from "../compiler/j2w";
import { kindOf, type Kind, type MethodInfo } from "../compiler/program";
import { mid } from "../compiler/ids";
import { T, type VT } from "../compiler/wasmbin";
import { FUEL, ROOT } from "../link/sched";
import type { World } from "../link/world";
import { ColdSlowOps } from "./slowops";
import { hasJspi } from "../link/module";
import { coldCode, type ColdInterpreter } from "./interpreter";

const programs = new WeakMap<MethodInfo, { dex: MethodInfo["dex"]; codeOff: number; item: ReturnType<MethodInfo["dex"]["code"]>; decoded: ReturnType<typeof coldCode> }>();
const eligibility = new WeakMap<MethodInfo, { dex: MethodInfo["dex"]; codeOff: number; supported: boolean }>();
function program(m: MethodInfo) {
  let p = programs.get(m);
  if (!p || p.dex !== m.dex || p.codeOff !== m.codeOff) {
    const item = m.dex.code(m.codeOff);
    programs.set(m, p = { dex: m.dex, codeOff: m.codeOff, item, decoded: coldCode(item) });
  }
  return p;
}
export function supportsColdBody(m: MethodInfo, cache = true): boolean {
  const prior = eligibility.get(m);
  if (prior?.dex === m.dex && prior.codeOff === m.codeOff) return prior.supported;
  // AOT preflight must not retain a decoded program for every platform method.
  // Slow adapter construction also asks about its enclosing body repeatedly.
  // DEX bodies are immutable; retain only eligibility and the body identity.
  const p = cache ? program(m) : undefined, item = p?.item ?? m.dex.code(m.codeOff);
  const decoded = p?.decoded ?? coldCode(item), slow = new Set(decoded.slowPcs);
  const supported = decodeInstructions(item.insns).every(ins => !slow.has(ins.pc) || ColdSlowOps.supports(ins));
  eligibility.set(m, { dex: m.dex, codeOff: m.codeOff, supported });
  return supported;
}

export function coldUnit(w: World, m: MethodInfo, cold: ColdInterpreter, resuming = false) {
  const { item, decoded } = program(m);
  const make = cold.prepare(item, true, decoded);
  const slot = w.slotOf(m), cx = new Compiler(w), kinds = [...(m.isStatic ? [] : ["L" as Kind]), ...m.params.map(kindOf)];
  const imp = (name: string, params: VT[], results: VT[]) => cx.mb.importFunc("cold", "ext:" + name, cx.mb.addFuncType(params, results));
  const slow = cx.mb.importFunc("activation", "slow", cx.mb.addFuncType([T.externref], []));
  const slowAsync = cx.mb.importFunc("activation", "slowAsync", cx.mb.addFuncType([T.externref], []));
  const synchronous = cx.mb.importFunc("activation", "synchronous", cx.mb.addFuncType([T.externref], [T.i32]));
  const peer = cx.mb.importFunc("activation", "peer", cx.mb.addFuncType([T.externref], [T.externref]));
  const target = cx.mb.importFunc("activation", "target", cx.mb.addFuncType([T.externref, T.i32], [T.funcref]));
  const snapshot = cx.mb.importFunc("activation", "snapshot", cx.mb.addFuncType([T.externref], [T.externref]));
  const finish = cx.mb.importFunc("activation", "finish", cx.mb.addFuncType([T.externref], []));
  const create = cx.mb.importFunc("activation", "make", cx.mb.addFuncType(resuming ? [T.externref] : [], [T.externref]));
  const bits = imp("bits", [T.externref, T.i32, T.i64], []), object = imp("object", [T.externref, T.i32, T.externref], []);
  const run = imp("run", [T.externref, T.i32], [T.i32]), result = imp("result", [T.externref], [T.i64]), reference = imp("reference", [T.externref], [T.externref]);
  const edges = imp("edges", [T.externref], [T.i32]);
  const ret = m.ret === "V" ? "V" : kindOf(m.ret);
  const resumeSig = cx.mb.addFuncType([T.externref], ret === "V" ? [] : [cx.vtOf(ret)]);
  const built = cx.buildSynthetic((resuming ? "cold-resume:" : "cold:") + mid(m), resuming ? ["L"] : kinds, c => {
    const frame = c.newLocal(T.externref), done = c.newLocal(T.i32), prior = c.newLocal(T.i32), iterations = c.newLocal(T.i32);
    const sid = cx.global("rt", "sid", T.i32, true), thr = cx.global("rt", "thr", T.anyref, true), depth = cx.global("rt", "depth", T.i32, true);
    const savedSid = c.newLocal(T.i32), savedThr = c.newLocal(T.anyref), savedDepth = c.newLocal(T.i32);
    c.gget(sid).lset(savedSid).gget(thr).lset(savedThr).gget(depth).lset(savedDepth);
    const restore = () => {
      c.lget(savedSid).gset(sid);
      // A first currentThread call binds a peer during the slow operation.
      // Retain a partially constructed peer when one was already present.
      c.lget(savedThr).refIsNull().if_(T.anyref).lget(frame).call(peer).anyConvertExtern().else_().lget(savedThr).end().gset(thr);
      c.lget(savedDepth).gset(depth);
    };
    if (resuming) c.lget(0);
    c.call(create).lset(frame);
    let reg = item.regs - item.ins;
    if (!resuming) kinds.forEach((kind, i) => {
      c.lget(frame).i32(reg).lget(i);
      if (kind === "L") c.externConvertAny().call(object);
      else { if (kind === "I") c.raw(OP.i64_extend_i32_s); c.call(bits); }
      reg += kind === "J" ? 2 : 1;
    });
    const entered = c.newLocal(T.i32), thrown = c.newLocal(T.anyref);
    c.block().block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
    const weights = cx.emitEnter(c, entered);
    // Plain cold calls retain the host adapters on the native stack as well as
    // their Wasm locals. Count those frames so SOE fires before the host stack
    // runs out of room to build the Java exception. JSPI calls use fresh stacks.
    c.lget(savedSid).i32(ROOT).raw(OP.i32_eq).lget(frame).call(synchronous).raw(OP.i32_or).if_();
    c.gget(depth).i32(128).raw(OP.i32_add).gset(depth); c.end();
    c.gget(depth).lset(savedDepth);
    cx.emitCount(c, m);
    c.block().loop().lget(frame).i32(FUEL).call(run).lset(done);
    c.lget(frame).call(edges).lget(prior).raw(OP.i32_sub).lset(iterations);
    c.lget(prior).lget(iterations).raw(OP.i32_add).lset(prior);
    cx.emitCount(c, m, iterations);
    c.lget(done).i32(1).raw(OP.i32_eq).brIf(1);
    c.lget(done).i32(2).raw(OP.i32_eq).if_();
    c.lget(savedSid).i32(ROOT).raw(OP.i32_eq).lget(frame).call(synchronous).raw(OP.i32_or).if_().lget(frame).call(slow).else_().lget(frame).call(slowAsync).end();
    c.else_(); cx.callRt(c, "yieldFuel"); c.end(); restore();
    const resume = c.newLocal(T.funcref);
    c.lget(frame).lget(prior).call(target).ltee(resume).refIsNull().raw(OP.i32_eqz).if_();
    c.lget(frame).call(snapshot).lget(resume).refAsNonNull().refCast(resumeSig).returnCallRef(resumeSig).end();
    c.br(0).end().end();
    c.lget(frame).call(finish); cx.emitLeave(c, entered, false); c.br(2);
    c.end().unreachable().end().lset(thrown); restore(); c.lget(frame).call(finish); cx.emitLeave(c, entered, false); c.lget(thrown).throw_(cx.tag); c.end();
    for (const at of weights) c.patch(at, 4 + (resuming ? 1 : kinds.length) + c.localTypes.length);
    if (ret === "L") c.lget(frame).call(reference).anyConvertExtern();
    else if (ret !== "V") { c.lget(frame).call(result); if (ret === "I") c.raw(OP.i32_wrap_i64); }
  }, ret, resuming ? "resume" : "m" + slot, resuming ? [T.externref] : undefined);
  const activation = activationImports(w, m, cold, make, item.regs, resuming);
  for (const trace of built.traces) { trace.m = m; trace.currentPcs = activation.currentPcs; }
  return { cx, built, imports: { cold: cold.imports, activation: activation.imports } };
}

// Long-lived activation callbacks must not share the emitter's lexical scope.
function activationImports(w: World, m: MethodInfo, cold: ColdInterpreter, make: () => object, registers: number, resuming: boolean) {
  const slowOps = new ColdSlowOps(w);
  const handed = new WeakMap<object, NonNullable<ReturnType<World["promoteCold"]>>>();
  const callers = new WeakMap<object, Error>();
  const step = (frame: object) => {
    let caller = callers.get(frame);
    if (!caller) { callers.set(frame, caller = new Error()); w.stats.coldCallerCaptures++; }
    const state = cold.snapshot(frame), owner = state.owner!; w.stats.coldSnapshotRegisters += registers;
    cold.inFlight(frame, true); cold.attempt(frame, state.pc);
    let busy = true;
    const unlock = () => { if (busy) { cold.inFlight(frame, false); busy = false; } };
    const commit = () => { unlock(); cold.commit(frame, state); };
    try {
      const result = slowOps.step(state, owner, Number(w.rtImports().depth.value), caller);
      if (result instanceof Promise) return result.then(commit, error => { unlock(); throw error; });
      commit();
    } catch (error) { unlock(); throw error; }
  };
  const imports = {
    target: (frame: object, edges: number) => { const next = w.promoteCold(m, cold, frame, edges); if (next) handed.set(frame, next); return next?.fn ?? null; },
    snapshot: (frame: object) => { const next = handed.get(frame)!; handed.delete(frame); return next.state; },
    peer: (frame: object) => cold.owner(frame)?.thread.obj ?? null,
    synchronous: (frame: object) => +cold.synchronous(frame),
    finish: (frame: object) => cold.finish(frame),
    slow: step, slowAsync: hasJspi() ? w.sched.suspending(step) : step,
    make: (state?: ColdSnapshot) => { if (resuming) return w.enterColdDeopt(state!, cold); w.stats.coldCalls++; const frame = make(); cold.context(frame, m, w.sched.current(), w.inSynchronousJava(), Number(w.rtImports().depth.value)); return frame; },
  };
  return { imports, currentPcs: () => cold.tracePcs(m, w.sched.current()) };
}
