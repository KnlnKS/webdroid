import { prepareMethod, registersOf, type PreparedInstruction } from "../../jvm/prepared.ts";
import { Invoke, Pool, invokeKind, isInvoke, referenceIndex, referenceOf } from "../../jvm/opcodes.ts";
import { kindOf, type Kind, type MethodInfo } from "./program.ts";
import { inferTyping, KINDS, type Typing } from "./infer.ts";
import type { Compiler } from "./j2w.ts";
import { T } from "./wasmbin.ts";
import type { MC } from "./method.ts";

export type SymbolicSite = [name: string, cls: string, method: number, pc: number, inputs: [reg: number, kind: Kind][], ret: Kind | "V"];

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

export function symbolicInstruction(m: MethodInfo, ins: PreparedInstruction): boolean {
  const op = ins.op, pool = referenceOf(op), dex = m.dex;
  if (pool < Pool.Type || pool === Pool.CallSite) return false;
  if (op === 0x22) return dex.rawType(ins.b) !== "Ljava/lang/String;";
  return !(pool === Pool.Method && invokeKind(op) === Invoke.Direct && dex.method(ins.b).name === "<init>" && dex.rawType(dex.method(ins.b).cls) === "Ljava/lang/String;");
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
  const cx = mc.cx;
  if (cx.prog.linksStatically(cx.prog.loaderOf(mc.m.cls)) || !symbolicInstruction(mc.m, ins)) return false;
  const entry = cx.symbolicImports.get(`${mc.m.cls}:${mc.m.index}:${ins.pc}`);
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
    if (cx.w.aot?.building && !cx.w.opts.build?.appDexes?.has(m.dex)) continue;
    if (!m.codeOff || cx.intrinsic(m) || cx.prog.linksStatically(cx.prog.loaderOf(m.cls))) continue;
    const phase = cx.w.stats.phase, item = m.dex.code(m.codeOff);
    let t = performance.now();
    const prepared = prepareMethod(item);
    phase.prepare += performance.now() - t; t = performance.now();
    const typing = inferTyping(m.dex, item, m.desc, m.isStatic, prepared);
    phase.infer += performance.now() - t;
    cx.methodAnalyses.set(m, { prepared, typing });
    for (const ins of prepared.instructions) {
      if (!typing.reached(ins.pc) || !cx.w.needsSymbolicSite(m, ins)) continue;
      const name = `${m.cls}:${m.index}:${ins.pc}`;
      if (cx.symbolicImports.has(name)) continue;
      cx.symbolicTable ??= cx.mb.importTable("symbolic", "table", T.funcref, 0);
      const slot = cx.mb.importGlobal("symbolic", name, T.i32, false);
      const { inputs, output } = siteOperands(m, ins, typing);
      cx.symbolicImports.set(name, { slot, site: [name, m.cls, m.index, ins.pc, inputs, output] });
    }
  }
}
