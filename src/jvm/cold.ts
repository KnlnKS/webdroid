import type { Runtime } from "./runtime";
import { perf } from "../perf";
import { descToName } from "./abi";

interface Frame {
  R: Runtime; D: ReturnType<Runtime["dexLink"]>; S: unknown;
  v: unknown[]; next: number; done: boolean; value: unknown;
  $t: unknown; $u: unknown; $ex: unknown; $fu: unknown; $th: unknown; $s: number;
}
type Handler = { kind: "sync"; run: (frame: Frame, constants: unknown[]) => void } |
  { kind: "suspend"; run: (frame: Frame, constants: unknown[]) => Generator<Promise<unknown>, void, unknown> };
type ColdOp = Handler & { constants: unknown[]; next: number; method?: number };
export interface ColdMethod {
  R: Runtime; D: ReturnType<Runtime["dexLink"]>; S: unknown;
  regs: number; first: number; instance: boolean; widths: number[];
  ops: Map<number, ColdOp>;
  catches: { start: number; end: number; handlers: [string, number][]; all: number }[];
}
const handlers = new Map<string, Handler>();

// Pool compiler-owned literals and register operands so cold DEX instructions share V8 code.
export function coldOp(source: string, next: number): ColdOp {
  const constants: unknown[] = [];
  const body = source.replace(/"(?:\\.|[^"\\])*"|\bv\d+\b|\$(?:t|u|ex|fu|th|s)\b|\bpc\b|\.((?:m|i|f|s)\$[\w$]+)|(?<![\w$])\d+(?:\.\d+)?(?:e[+-]?\d+)?n?(?![\w$])/gi, (literal, prop: string | undefined) => {
    if (literal === "pc") return "F.next";
    if (literal[0] === "$") return "F." + literal;
    const reg = /^v\d+$/.test(literal), i = constants.length;
    constants.push(prop ?? (reg ? Number(literal.slice(1)) : literal[0] === '"' ? JSON.parse(literal) : literal.endsWith("n") ? BigInt(literal.slice(0, -1)) : Number(literal)));
    return reg ? `F.v[K[${i}]]` : prop ? `[K[${i}]]` : `K[${i}]`;
  });
  let handler = handlers.get(body);
  if (!handler) {
    // An async helper would suspend even when every native returned synchronously.
    const suspends = body.includes("await ");
    const run = new Function(`return function${suspends ? "*" : ""}(F,K){const R=F.R,D=F.D,S=F.S;${body.replaceAll("await ", "yield ")}}`)();
    handler = suspends ? { kind: "suspend", run } : { kind: "sync", run };
    handlers.set(body, handler); perf.coldHandlers++;
  }
  return { ...handler, constants, next };
}

export async function runCold(method: ColdMethod, receiver: unknown, args: unknown[]): Promise<unknown> {
  perf.coldCalls++;
  const { R, D, S } = method;
  const f: Frame = { R, D, S, v: new Array(method.regs), next: 0, done: false, value: undefined,
    $t: undefined, $u: undefined, $ex: undefined, $fu: undefined, $th: R.th(), $s: 0 };
  let reg = method.first;
  if (method.instance) f.v[reg++] = receiver;
  for (let i = 0; i < args.length; i++) { f.v[reg] = args[i]; reg += method.widths[i]; }
  try {
    while (!f.done) {
      const pc = f.next, op = method.ops.get(pc);
      if (!op) throw new Error("bad pc " + pc);
      f.next = op.next;
      try {
        if (op.kind === "sync") op.run(f, op.constants);
        else {
          const iterator = op.run(f, op.constants);
          let step = iterator.next();
          while (!step.done) {
            R.su(f.$th); f.$s = 1;
            let value: unknown;
            try { value = await step.value; }
            catch (e) { R.st(f.$th); step = iterator.throw(e); continue; }
            R.st(f.$th); step = iterator.next(value);
          }
        }
      } catch (error) {
        R.st(f.$th);
        if (error instanceof TypeError) {
          const key = /\[K\[(\d+)\]\] is not a function/.exec(error.message)?.[1];
          if (key !== undefined && typeof op.constants[Number(key)] === "string") {
            const ref = op.method === undefined ? null : D.dex.method(op.method);
            const name = ref ? `${descToName(D.dex.type(ref.cls))}.${ref.name}${D.dex.methodDesc(op.method!)}` : `cold.${op.constants[Number(key)]}`;
            error.message = `${name} is not a function`;
          }
        }
        const e = R.jx(error);
        let handler = -1;
        for (const t of method.catches) {
          if (pc < t.start || pc >= t.end) continue;
          handler = t.handlers.find(([name]) => name === "java/lang/Throwable" || R.iof(e, name))?.[1] ?? t.all;
          if (handler >= 0) break;
        }
        if (handler < 0) throw e;
        f.$ex = e; f.next = handler;
      }
    }
    return f.value;
  } finally {
    if (f.$s) R.su(f.$th);
  }
}
