import { prepareMethod, registersOf, type PreparedInstruction } from "../../jvm/prepared";
import { kindOf, type Kind, type MethodInfo } from "./program";
import { inferTyping, R, J, D, type Typing } from "./infer";
import type { Compiler } from "./j2w";
import { T } from "./wasmbin";
import type { MC } from "./method";
import { initiatedInstruction } from "../link/resolution";
import type { World } from "../link/world";

export type SymbolicSite = [name: string, cls: string, method: number, pc: number, inputs: [reg: number, kind: Kind][], ret: Kind | "V"];
export interface SiteOperands { inputs: { reg: number; kind: Kind }[]; output: Kind | "V"; producer: boolean }

export function symbolicOperationKey(m: MethodInfo, ins: PreparedInstruction, inputs: SymbolicSite[4], output: SymbolicSite[5]): string {
  const roles = new Map<number, number>();
  for (const reg of registersOf(ins)) if (!roles.has(reg)) roles.set(reg, roles.size);
  const a = roles.get(ins.a), b = roles.get(ins.b);
  const operands = ins.fmt === "22c" ? [a, b, ins.c]
    : ins.fmt === "35c" || ins.fmt === "3rc" ? [ins.a, ins.b, ins.regs.map(r => roles.get(r))]
    : [a, ins.b, ins.c];
  // The defining caller fixes the DEX references, loader and access context;
  // normalized register roles preserve aliases and the caller's input order.
  return JSON.stringify([m.cls, ins.op, operands, output, inputs.map(([reg, kind]) => [roles.get(reg), kind])]);
}

function symbolicInstruction(m: MethodInfo, ins: PreparedInstruction): boolean {
  const n = ins.name, dex = m.dex;
  if (n === "new-instance" && dex.rawType(ins.b) === "Ljava/lang/String;") return false;
  if (/^invoke-direct/.test(n) && dex.method(ins.b).name === "<init>" && dex.rawType(dex.method(ins.b).cls) === "Ljava/lang/String;") return false;
  return /^(const-class|const-method-|check-cast|instance-of|new-instance|new-array|filled-new-array|iget|iput|sget|sput|invoke-(virtual|interface|static|direct|super|polymorphic))/.test(n);
}

export function needsSymbolicSite(w: World, m: MethodInfo, ins: PreparedInstruction): boolean {
  return !w.prog.linksStatically(w.prog.loaderOf(m.cls)) && symbolicInstruction(m, ins) && !initiatedInstruction(w, m, ins);
}

function siteOperands(m: MethodInfo, ins: PreparedInstruction, typing: Typing): SiteOperands {
  const n = ins.name, dex = m.dex, inputs: SiteOperands["inputs"] = [], seen = new Set<number>();
  for (const reg of registersOf(ins)) {
    const web = typing.use(ins.pc, reg);
    if (web < 0 || seen.has(web)) continue;
    seen.add(web);
    const k = typing.kind[web];
    inputs.push({ reg, kind: k === R ? "L" : k === J || k === D ? "J" : "I" });
  }
  const output = /^invoke-/.test(n) ? dex.rawType(dex.proto(n.startsWith("invoke-polymorphic") ? ins.c : dex.method(ins.b).proto).ret)
    : /^(iget|sget)/.test(n) ? dex.rawType(dex.field(n.startsWith("iget") ? ins.c : ins.b).type)
    : /^(iput|sput)/.test(n) ? "V" : n === "instance-of" ? "I" : "L";
  return { inputs, output: output === "V" ? "V" : kindOf(output), producer: /^invoke-|^filled-new-array/.test(n) };
}

export function emitSymbolicSite(mc: MC, ins: PreparedInstruction): boolean {
  const cx = mc.cx;
  if (!mc.symbolic || cx.prog.linksStatically(cx.prog.loaderOf(mc.m.cls)) || !symbolicInstruction(mc.m, ins)) return false;
  const entry = cx.symbolicImports.get(`${mc.m.cls}:${mc.m.index}:${ins.pc}`);
  if (!entry) return false;
  const operands = siteOperands(mc.m, ins, mc.typing);
  if (ins.name.startsWith("invoke-polymorphic") && mc.dex.rawType(mc.dex.method(ins.b).cls) === "Ljava/lang/invoke/MethodHandle;") { mc.nonNull(ins.regs[0]); mc.code.drop(); }
  for (const input of operands.inputs) mc.get(input.kind, input.reg);
  mc.code.gget(entry.slot).callIndirect(cx.sig(operands.inputs.map(input => input.kind), operands.output), cx.symbolicTable!);
  if (operands.producer) mc.finishResult(ins, operands.output);
  else if (operands.output !== "V") mc.set(operands.output);
  return true;
}

export function declareSymbolicSites(cx: Compiler, methods: MethodInfo[]): void {
  for (const m of methods) {
    if (cx.w.aot?.building && !cx.w.opts.build?.appDexes?.has(m.dex)) continue;
    if (!m.codeOff || cx.intrinsic(m) || cx.prog.linksStatically(cx.prog.loaderOf(m.cls))) continue;
    const phase = cx.w.stats.phase, item = m.dex.code(m.codeOff);
    let t = performance.now();
    const prepared = prepareMethod(item);
    phase.prepare += performance.now() - t; t = performance.now();
    const typing = inferTyping(m.dex, item, m.desc, m.isStatic, prepared.instructions);
    phase.infer += performance.now() - t;
    cx.methodAnalyses.set(m, { prepared, typing });
    for (const ins of prepared.instructions) {
      if (!typing.reached(ins.pc) || !needsSymbolicSite(cx.w, m, ins)) continue;
      const name = `${m.cls}:${m.index}:${ins.pc}`;
      if (cx.symbolicImports.has(name)) continue;
      cx.symbolicTable ??= cx.mb.importTable("symbolic", "table", T.funcref, 0);
      const slot = cx.mb.importGlobal("symbolic", name, T.i32, false);
      const operands = siteOperands(m, ins, typing);
      cx.symbolicImports.set(name, { slot, site: [name, m.cls, m.index, ins.pc, operands.inputs.map(input => [input.reg, input.kind]), operands.output] });
    }
  }
}
