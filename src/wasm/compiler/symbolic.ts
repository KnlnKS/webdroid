import type { PreparedInstruction } from "../../jvm/prepared.ts";
import type { Code } from "./code.ts";
import { Compiler, type LinkEnv } from "./j2w.ts";
import { MC } from "./method.ts";
import type { Kind, MethodInfo } from "./program.ts";
import type { SymbolicSite } from "./sites.ts";
import { T } from "./wasmbin.ts";

// A resolved symbolic site's operation: no method IR or copied callees, and its inputs are the caller's bits.
class SymbolicMC extends MC {
  private inputs: SymbolicSite[4];
  outputLocal = -1;
  constructor(cx: Compiler, m: MethodInfo, inputs: SymbolicSite[4]) { super(cx, m); this.inputs = inputs; }
  override consumeResult(): void {}
  protected override copyReference(reg: number): void { this.get("L", reg); this.set("L"); }
  override set(_kind: Kind): void { this.code.lset(this.outputLocal); }
  override finishResult(_ins: PreparedInstruction, kind: Kind | "V"): void { if (kind !== "V") this.set(kind); }
  override useWeb(reg: number): number { return reg; }
  override get(kind: Kind, reg: number): void {
    const i = this.inputs.findIndex(([r, k]) => r === reg && k === kind);
    if (i < 0) throw new Error(`invalid symbolic operand v${reg}:${kind} at ${this.cur.pc}`);
    this.code.lget(i);
  }
  override emit(ins: PreparedInstruction): void { this.cur = ins; this.code.pc = ins.pc; this.emitOperation(ins); }
}

/** the unit of one symbolic site's operation, once its references resolve; it restores the frame depth on normal and exceptional exits */
export function compileSymbolicSite(w: LinkEnv, m: MethodInfo, ins: PreparedInstruction, inputs: SymbolicSite[4], output: Kind | "V") {
  const cx = new Compiler(w);
  // These helpers have no Java frame; stable names let engines reuse identical module code.
  const built = cx.buildSynthetic("symbolic:operation", inputs.map(i => i[1]), (c: Code) => {
    const mc = new SymbolicMC(cx, m, inputs); mc.root = mc.code = c;
    mc.tmpL = c.newLocal(T.anyref);
    if (output !== "V") mc.outputLocal = c.newLocal(cx.vtOf(output));
    const entry = c.newLocal(T.i32), thrown = c.newLocal(T.anyref), weights = cx.emitEnter(c, entry);
    c.block().block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
    mc.emit(ins);
    cx.emitLeave(c, entry, false); c.br(2);
    c.end().unreachable().end();
    c.lset(thrown); cx.emitLeave(c, entry, false); c.lget(thrown).throw_(cx.tag);
    c.end();
    if (output !== "V") c.lget(mc.outputLocal);
    for (const at of weights) c.patch(at, 4 + c.nparams + c.localTypes.length);
  }, output);
  return { cx, built };
}
