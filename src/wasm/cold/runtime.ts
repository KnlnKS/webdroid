import { OP } from "../compiler/code";
import { Compiler } from "../compiler/j2w";
import { kindOf, type Kind, type MethodInfo } from "../compiler/program";
import { mid } from "../compiler/ids";
import { T, type VT } from "../compiler/wasmbin";
import { FUEL } from "../link/sched";
import type { World } from "../link/world";
import { UnsupportedColdBody, type ColdInterpreter } from "./interpreter";

export function coldUnit(w: World, m: MethodInfo, cold: ColdInterpreter) {
  const item = m.dex.code(m.codeOff);
  if (item.tries.length) return undefined;
  let make: () => object;
  try { make = cold.prepare(item); }
  catch (error) { if (error instanceof UnsupportedColdBody) return undefined; throw error; }
  const slot = w.slotOf(m), cx = new Compiler(w), kinds = [...(m.isStatic ? [] : ["L" as Kind]), ...m.params.map(kindOf)];
  const imp = (name: string, params: VT[], results: VT[]) => cx.mb.importFunc("cold", "ext:" + name, cx.mb.addFuncType(params, results));
  const create = cx.mb.importFunc("activation", "make", cx.mb.addFuncType([], [T.externref]));
  const bits = imp("bits", [T.externref, T.i32, T.i64], []), object = imp("object", [T.externref, T.i32, T.externref], []);
  const run = imp("run", [T.externref, T.i32], [T.i32]), result = imp("result", [T.externref], [T.i64]), reference = imp("reference", [T.externref], [T.externref]);
  const edges = imp("edges", [T.externref], [T.i32]);
  const ret = m.ret === "V" ? "V" : kindOf(m.ret);
  const built = cx.buildSynthetic("cold:" + mid(m), kinds, c => {
    const frame = c.newLocal(T.externref), done = c.newLocal(T.i32), prior = c.newLocal(T.i32), iterations = c.newLocal(T.i32);
    c.call(create).lset(frame);
    let reg = item.regs - item.ins;
    kinds.forEach((kind, i) => {
      c.lget(frame).i32(reg).lget(i);
      if (kind === "L") c.externConvertAny().call(object);
      else { if (kind === "I") c.raw(OP.i64_extend_i32_s); c.call(bits); }
      reg += kind === "J" ? 2 : 1;
    });
    cx.emitCount(c, m);
    c.block().loop().lget(frame).i32(FUEL).call(run).lset(done);
    c.lget(frame).call(edges).lget(prior).raw(OP.i32_sub).lset(iterations);
    c.lget(prior).lget(iterations).raw(OP.i32_add).lset(prior);
    cx.emitCount(c, m, iterations);
    c.lget(done).brIf(1);
    cx.callRt(c, "yieldFuel"); c.br(0).end().end();
    if (ret === "L") c.lget(frame).call(reference).anyConvertExtern();
    else if (ret !== "V") { c.lget(frame).call(result); if (ret === "I") c.raw(OP.i32_wrap_i64); }
  }, ret, "m" + slot);
  const imports = { cold: cold.imports, activation: { make: () => { w.stats.coldCalls++; return make(); } } };
  return { cx, built, imports };
}
