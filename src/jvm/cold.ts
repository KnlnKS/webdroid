import type { Runtime } from "./runtime";
import { perf } from "../perf";
import { descToName } from "./abi";
import { jvmProfiler } from "./profile";

export interface ColdFrame {
  R: Runtime; D: ReturnType<Runtime["dexLink"]>; S: unknown;
  v: unknown[]; next: number; done: boolean; value: unknown;
  $t: unknown; $u: unknown; $ex: unknown; $fu: unknown; $th: unknown; $s: number; $osrS: number;
}
type Handler = { kind: "sync"; run: (frame: ColdFrame, constants: unknown[]) => void } |
  { kind: "suspend"; run: (frame: ColdFrame, constants: unknown[]) => Generator<Promise<unknown>, void, unknown> };
type ColdOp = Handler & { constants: unknown[]; next: number; method?: number };
export interface OsrHandoff { kind: "osr"; value: unknown; }
export interface ColdMethod {
  /** "pkg/Class.method(desc)": the frame an exception unwinding through here is noted under */
  name: string;
  R: Runtime; D: ReturnType<Runtime["dexLink"]>; S: unknown;
  regs: number; first: number; instance: boolean; widths: number[];
  ops: Map<number, ColdOp>;
  catches: { start: number; end: number; handlers: [string, number][]; all: number }[];
  hotness: number;
  profiledInstructions: number;
  promote?: (frame: ColdFrame, receiver: unknown, args: unknown[]) => OsrHandoff | null;
}
const handlers = new Map<string, Handler>();

// Pool compiler-owned literals and register operands so cold DEX instructions share V8 code.
export function coldOp(body: string, constants: unknown[], next: number, suspends: boolean): ColdOp {
  let handler = handlers.get(body);
  if (!handler) {
    // An async helper would suspend even when every native returned synchronously.
    const run = new Function(`return function${suspends ? "*" : ""}(F,K){const R=F.R,D=F.D,S=F.S;${body}}`)();
    handler = suspends ? { kind: "suspend", run } : { kind: "sync", run };
    handlers.set(body, handler); perf.coldHandlers++;
  }
  return { ...handler, constants, next };
}

/** Cold bodies share one runner, so the JS stack names none of them: the throwable itself
 *  collects the Java frames it unwinds through (bounded), for [uncaught] reports. */
function noteFrame(e: unknown, name: string): void {
  if (typeof e !== "object" || e === null) return;
  const t = e as { jframes?: string[] };
  const frames = t.jframes ??= [];
  if (frames.length < 48) frames.push(name);
}
export async function runCold(method: ColdMethod, receiver: unknown, args: unknown[]): Promise<unknown> {
  perf.coldCalls++;
  const profiled = jvmProfiler.enabled;
  const started = profiled ? performance.now() : 0;
  const { R, D, S } = method;
  const f: ColdFrame = { R, D, S, v: new Array(method.regs), next: 0, done: false, value: undefined,
    $t: undefined, $u: undefined, $ex: undefined, $fu: undefined, $th: R.th(), $s: 0, $osrS: 0 };
  let reg = method.first;
  if (method.instance) f.v[reg++] = receiver;
  for (let i = 0; i < args.length; i++) { f.v[reg] = args[i]; reg += method.widths[i]; }
  try {
    while (!f.done) {
      const pc = f.next, op = method.ops.get(pc);
      if (!op) throw new Error("bad pc " + pc);
      f.next = op.next;
      let yielded = false;
      try {
        if (op.kind === "sync") op.run(f, op.constants);
        else {
          const iterator = op.run(f, op.constants);
          let step = iterator.next();
          while (!step.done) {
            yielded = true;
            R.su(f.$th); f.$s = 1;
            let value: unknown;
            const suspended = profiled ? performance.now() : 0;
            if (profiled) jvmProfiler.suspension(method.name);
            try { value = await step.value; }
            catch (e) { R.st(f.$th); step = iterator.throw(e); continue; }
            finally { if (profiled) jvmProfiler.add(method.name, "suspend", performance.now() - suspended); }
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
        if (handler < 0) { noteFrame(e, method.name); throw e; }
        f.$ex = e; f.next = handler;
      }
      method.hotness++;
      if (f.next <= pc) {
        if (profiled) {
          jvmProfiler.backedge(method.name, method.hotness - method.profiledInstructions);
          method.profiledInstructions = method.hotness;
        }
        if (yielded && method.hotness >= jvmProfiler.hotThreshold && method.promote) {
          f.$osrS = f.$s;
          const handoff = method.promote(f, receiver, args);
          if (handoff) { f.$s = 0; return await handoff.value; }
        }
      }
    }
    return f.value;
  } finally {
    if (f.$s) R.su(f.$th);
    if (profiled) jvmProfiler.add(method.name, "coldRun", performance.now() - started);
  }
}
