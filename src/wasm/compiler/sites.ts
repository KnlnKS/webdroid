import { registersOf, type PreparedInstruction } from "../../jvm/prepared.ts";
import { Pool, isInvoke, referenceIndex, referenceOf } from "../../jvm/opcodes.ts";
import { kindOf, type Kind, type MethodInfo } from "./program.ts";
import { KINDS, type Typing } from "./infer.ts";
import type { Compiler } from "./j2w.ts";
import { T } from "./wasmbin.ts";
import type { MC } from "./method.ts";
import { stringSite } from "./strings.ts";

export type SymbolicSite = [name: string, cls: string, method: number, pc: number, inputs: [reg: number, kind: Kind][], ret: Kind | "V"];
/** the name of the symbolic site of `ins` in `m` */
export const siteKey = (m: MethodInfo, ins: PreparedInstruction): string => `${m.cls}:${m.index}:${ins.pc}`;

export function symbolicInstruction(m: MethodInfo, ins: PreparedInstruction): boolean {
  const pool = referenceOf(ins.op);
  return pool >= Pool.Type && pool !== Pool.CallSite && !stringSite(m.dex, ins);
}

function siteOperands(m: MethodInfo, ins: PreparedInstruction, typing: Typing): { inputs: SymbolicSite[4]; output: SymbolicSite[5] } {
  const op = ins.op, pool = referenceOf(op), dex = m.dex, inputs: SymbolicSite[4] = [], seen = new Set<number>();
  for (const reg of registersOf(ins)) {
    const web = typing.use(ins.pc, reg);
    if (web < 0 || seen.has(web)) continue;
    seen.add(web);
    inputs.push([reg, KINDS[typing.kind[web]].abi]);
  }
  // iput and sput answer nothing
  const output = pool === Pool.Method ? dex.rawType(dex.proto(op >= 0xfa ? ins.c : dex.method(ins.b).proto).ret)
    : pool === Pool.Field ? op >= 0x67 || op >= 0x59 && op <= 0x5f ? "V" : dex.rawType(dex.field(referenceIndex(ins)).type)
    : op === 0x20 ? "I" : "L";
  return { inputs, output: output === "V" ? "V" : kindOf(output) };
}

export function emitSymbolicSite(mc: MC, ins: PreparedInstruction): boolean {
  const cx = mc.cx, entry = cx.symbolicImports.size ? cx.symbolicImports.get(siteKey(mc.m, ins)) : undefined;
  if (!entry) return false;
  // the operands declareSymbolicSites gave the site, which its linked operation takes
  const [, , , , inputs, output] = entry.site;
  if ((ins.op === 0xfa || ins.op === 0xfb) && mc.dex.rawType(mc.dex.method(ins.b).cls) === "Ljava/lang/invoke/MethodHandle;") { mc.nonNull(ins.regs[0]); mc.code.drop(); }
  for (const [reg, kind] of inputs) mc.get(kind, reg);
  mc.code.gget(entry.slot).callIndirect(cx.sig(inputs.map(input => input[1]), output), cx.symbolicTable!);
  if (isInvoke(ins.op) || ins.op === 0x24 || ins.op === 0x25) mc.finishResult(ins, output);
  else if (output !== "V") mc.set(output);
  return true;
}

export function declareSymbolicSites(cx: Compiler, methods: MethodInfo[]): void {
  for (const m of methods) {
    if (!m.codeOff || cx.w.intrinsic(m) || cx.prog.linksStatically(cx.prog.loaderOf(m.cls))) continue;
    const { prepared, typing } = cx.analysis(m);
    for (const ins of prepared.instructions) {
      if (!typing.reached(ins.pc) || !cx.w.needsSymbolicSite(m, ins)) continue;
      const name = siteKey(m, ins);
      if (cx.symbolicImports.has(name)) continue;
      cx.symbolicTable ??= cx.mb.importTable("symbolic", "table", T.funcref, 0);
      const slot = cx.mb.importGlobal("symbolic", name, T.i32, false);
      const { inputs, output } = siteOperands(m, ins, typing);
      cx.symbolicImports.set(name, { slot, site: [name, m.cls, m.index, ins.pc, inputs, output] });
    }
  }
}
