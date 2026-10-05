import { decodeInstructions } from "../../jvm/prepared";
import { OP } from "../compiler/code";
import { Compiler } from "../compiler/j2w";
import { kindOf, type Kind, type MethodInfo } from "../compiler/program";
import { mid } from "../compiler/ids";
import { T, type VT } from "../compiler/wasmbin";
import { FUEL, ROOT } from "../link/sched";
import type { World } from "../link/world";
import { ColdSlowOps } from "./slowops";
import { hasJspi, suspending } from "../link/module";
import { coldCode, type ColdInterpreter } from "./interpreter";

const programs = new WeakMap<MethodInfo, { item: ReturnType<MethodInfo["dex"]["code"]>; decoded: ReturnType<typeof coldCode> }>();
function program(m: MethodInfo) {
  let p = programs.get(m);
  if (!p) { const item = m.dex.code(m.codeOff); programs.set(m, p = { item, decoded: coldCode(item) }); }
  return p;
}
export function supportsColdBody(m: MethodInfo): boolean {
  const { item, decoded } = program(m), slow = new Set(decoded.slowPcs);
  return decodeInstructions(item.insns).every(ins => !slow.has(ins.pc) || ColdSlowOps.supports(ins));
}

export function coldUnit(w: World, m: MethodInfo, cold: ColdInterpreter) {
  const { item, decoded } = program(m);
  const make = cold.prepare(item, true, decoded);
  const slowOps = new ColdSlowOps(w);
  const slot = w.slotOf(m), cx = new Compiler(w), kinds = [...(m.isStatic ? [] : ["L" as Kind]), ...m.params.map(kindOf)];
  const imp = (name: string, params: VT[], results: VT[]) => cx.mb.importFunc("cold", "ext:" + name, cx.mb.addFuncType(params, results));
  const slow = cx.mb.importFunc("activation", "slow", cx.mb.addFuncType([T.externref], []));
  const slowAsync = cx.mb.importFunc("activation", "slowAsync", cx.mb.addFuncType([T.externref], []));
  const synchronous = cx.mb.importFunc("activation", "synchronous", cx.mb.addFuncType([T.externref], [T.i32]));
  const peer = cx.mb.importFunc("activation", "peer", cx.mb.addFuncType([T.externref], [T.externref]));
  const finish = cx.mb.importFunc("activation", "finish", cx.mb.addFuncType([T.externref], []));
  const create = cx.mb.importFunc("activation", "make", cx.mb.addFuncType([], [T.externref]));
  const bits = imp("bits", [T.externref, T.i32, T.i64], []), object = imp("object", [T.externref, T.i32, T.externref], []);
  const run = imp("run", [T.externref, T.i32], [T.i32]), result = imp("result", [T.externref], [T.i64]), reference = imp("reference", [T.externref], [T.externref]);
  const edges = imp("edges", [T.externref], [T.i32]);
  const ret = m.ret === "V" ? "V" : kindOf(m.ret);
  const built = cx.buildSynthetic("cold:" + mid(m), kinds, c => {
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
    c.call(create).lset(frame);
    let reg = item.regs - item.ins;
    kinds.forEach((kind, i) => {
      c.lget(frame).i32(reg).lget(i);
      if (kind === "L") c.externConvertAny().call(object);
      else { if (kind === "I") c.raw(OP.i64_extend_i32_s); c.call(bits); }
      reg += kind === "J" ? 2 : 1;
    });
    const entered = c.newLocal(T.i32), thrown = c.newLocal(T.anyref);
    c.block().block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
    const weights = cx.emitEnter(c, entered); c.gget(depth).lset(savedDepth);
    cx.emitCount(c, m);
    c.block().loop().lget(frame).i32(FUEL).call(run).lset(done);
    c.lget(frame).call(edges).lget(prior).raw(OP.i32_sub).lset(iterations);
    c.lget(prior).lget(iterations).raw(OP.i32_add).lset(prior);
    cx.emitCount(c, m, iterations);
    c.lget(done).i32(1).raw(OP.i32_eq).brIf(1);
    c.lget(done).i32(2).raw(OP.i32_eq).if_();
    c.lget(savedSid).i32(ROOT).raw(OP.i32_eq).lget(frame).call(synchronous).raw(OP.i32_or).if_().lget(frame).call(slow).else_().lget(frame).call(slowAsync).end();
    c.else_(); cx.callRt(c, "yieldFuel"); c.end(); restore();
    c.br(0).end().end();
    c.lget(frame).call(finish); cx.emitLeave(c, entered, false); c.br(2);
    c.end().unreachable().end().lset(thrown); restore(); c.lget(frame).call(finish); cx.emitLeave(c, entered, false); c.lget(thrown).throw_(cx.tag); c.end();
    for (const at of weights) c.patch(at, 4 + kinds.length + c.localTypes.length);
    if (ret === "L") c.lget(frame).call(reference).anyConvertExtern();
    else if (ret !== "V") { c.lget(frame).call(result); if (ret === "I") c.raw(OP.i32_wrap_i64); }
  }, ret, "m" + slot);
  for (const trace of built.traces) { trace.m = m; trace.currentPcs = () => cold.tracePcs(m, w.sched.current()); }
  const step = (frame: object) => {
    const state = cold.snapshot(frame), owner = state.owner!; w.stats.coldSnapshotRegisters += item.regs;
    cold.inFlight(frame, true); cold.attempt(frame, state.pc);
    let busy = true;
    const unlock = () => { if (busy) { cold.inFlight(frame, false); busy = false; } };
    const commit = () => { unlock(); cold.commit(frame, state); };
    try {
      const result = slowOps.step(state, owner, Number(w.rtImports().depth.value));
      if (result instanceof Promise) return result.then(commit, error => { unlock(); throw error; });
      commit();
    } catch (error) { unlock(); throw error; }
  };
  const imports = { cold: cold.imports, activation: {
    peer: (frame: object) => cold.owner(frame)?.thread.obj ?? null,
    synchronous: (frame: object) => +cold.synchronous(frame),
    finish: (frame: object) => cold.finish(frame),
    slow: step, slowAsync: hasJspi() ? suspending(step) : step,
    make: () => { w.stats.coldCalls++; const frame = make(); cold.context(frame, m, w.sched.current(), w.inSynchronousJava(), Number(w.rtImports().depth.value)); return frame; },
  } };
  return { cx, built, imports };
}
