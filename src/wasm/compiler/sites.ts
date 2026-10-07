import { prepareMethod, registersOf, type PreparedInstruction } from "../../jvm/prepared";
import { kindOf, type Kind, type MethodInfo } from "./program";
import { inferTyping, R, J, D, type Typing } from "./infer";
import type { Compiler } from "./j2w";
import { T } from "./wasmbin";
import type { MC } from "./method";

export type SymbolicSite = [name: string, cls: string, method: number, pc: number, params: Kind[], ret: Kind | "V"];
export interface SiteOperands { inputs: { reg: number; kind: Kind; web: number }[]; output: Kind | "V"; producer: boolean }

export function symbolicInstruction(m: MethodInfo, ins: PreparedInstruction): boolean {
  const n = ins.name, dex = m.dex;
  if (n === "new-instance" && dex.rawType(ins.b) === "Ljava/lang/String;") return false;
  if (/^invoke-direct/.test(n) && dex.method(ins.b).name === "<init>" && dex.rawType(dex.method(ins.b).cls) === "Ljava/lang/String;") return false;
  return /^(const-class|check-cast|instance-of|new-instance|new-array|filled-new-array|iget|iput|sget|sput|invoke-(virtual|interface|static|direct|super))/.test(n);
}

export function siteOperands(m: MethodInfo, ins: PreparedInstruction, typing: Typing): SiteOperands {
  const n = ins.name, dex = m.dex, inputs: SiteOperands["inputs"] = [], seen = new Set<number>();
  for (const reg of registersOf(ins)) {
    const web = typing.use(ins.pc, reg);
    if (web < 0 || seen.has(web)) continue;
    seen.add(web);
    const k = typing.kind[web];
    inputs.push({ reg, web, kind: k === R ? "L" : k === J || k === D ? "J" : "I" });
  }
  const output = /^invoke-/.test(n) ? dex.rawType(dex.proto(dex.method(ins.b).proto).ret)
    : /^(iget|sget)/.test(n) ? dex.rawType(dex.field(n.startsWith("iget") ? ins.c : ins.b).type)
    : /^(iput|sput)/.test(n) ? "V" : n === "instance-of" ? "I" : "L";
  return { inputs, output: output === "V" ? "V" : kindOf(output), producer: /^invoke-|^filled-new-array/.test(n) };
}

export function emitSymbolicSite(mc: MC, ins: PreparedInstruction): boolean {
  const cx = mc.cx;
  if (!mc.symbolic || cx.prog.loaderOf(mc.m.cls) === cx.prog.boot || !symbolicInstruction(mc.m, ins)) return false;
  const operands = siteOperands(mc.m, ins, mc.typing), name = `${mc.m.cls}:${mc.m.index}:${ins.pc}`;
  const entry = cx.symbolicImports.get(name);
  if (!entry) return false;
  for (const input of operands.inputs) mc.get(input.kind, input.reg);
  mc.code.gget(entry.slot).callIndirect(cx.sig(operands.inputs.map(input => input.kind), operands.output), cx.symbolicTable!);
  if (operands.producer) mc.finishResult(ins, operands.output);
  else if (operands.output !== "V") mc.set(operands.output);
  return true;
}

export function declareSymbolicSites(cx: Compiler, methods: MethodInfo[]): void {
  if (cx.w.aot?.building) return;
  for (const m of methods) {
    if (!m.codeOff || cx.intrinsic(m) || cx.prog.loaderOf(m.cls) === cx.prog.boot) continue;
    const phase = cx.w.stats.phase, item = m.dex.code(m.codeOff);
    let t = performance.now();
    const prepared = prepareMethod(m.dex, item, m.desc, m.isStatic);
    phase.prepare += performance.now() - t; t = performance.now();
    const typing = inferTyping(m.dex, item, m.desc, m.isStatic, prepared.instructions);
    phase.infer += performance.now() - t;
    cx.methodAnalyses.set(m, { prepared, typing });
    for (const ins of prepared.instructions) {
      if (!typing.reached(ins.pc) || !symbolicInstruction(m, ins)) continue;
      const name = `${m.cls}:${m.index}:${ins.pc}`;
      if (cx.symbolicImports.has(name)) continue;
      cx.symbolicTable ??= cx.mb.importTable("symbolic", "table", T.funcref, 0);
      const slot = cx.mb.importGlobal("symbolic", name, T.i32, false);
      const operands = siteOperands(m, ins, typing);
      cx.symbolicImports.set(name, { slot, site: [name, m.cls, m.index, ins.pc, operands.inputs.map(input => input.kind), operands.output] });
    }
  }
}
