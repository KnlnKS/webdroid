import type { Runtime } from "./runtime";
import { perf } from "../perf";
import { descToName } from "./abi";
import { jvmProfiler } from "./profile";

/** Field names match a hot frame's (see Runtime.dfr), so a hot body can resume one (OSR). */
export interface ColdFrame {
  R: Runtime; D: ReturnType<Runtime["dexLink"]>; S: unknown;
  v: unknown[]; next: number; r: 0; done: boolean; value: unknown;
  $t: unknown; $u: unknown; $ex: unknown; $fu: unknown; $th: unknown; $s: number;
  /** what the Promise a handler returned resolves: 1 its call result, 0 a wait before rerunning it */
  $w: number;
}
/** Returns the Promise the instruction waits on, if any. */
type Handler = (frame: ColdFrame, constants: unknown[]) => Promise<unknown> | undefined;
type ColdOp = { run: Handler; constants: unknown[]; next: number; method?: number };
export interface ColdMethod {
  /** "pkg/Class.method(desc)": the frame an exception unwinding through here is noted under */
  name: string;
  R: Runtime; D: ReturnType<Runtime["dexLink"]>; S: unknown;
  regs: number; first: number; instance: boolean; widths: number[];
  ops: Map<number, ColdOp>;
  catches: { start: number; end: number; handlers: [string, number][]; all: number }[];
  hotness: number;
  profiledInstructions: number;
  promote?: (frame: ColdFrame, receiver: unknown) => { value: unknown } | undefined;
}
const handlers = new Map<string, Handler>();

// Pool compiler-owned literals and register operands so cold DEX instructions share V8 code.
export function coldOp(body: string, constants: unknown[], next: number): ColdOp {
  let run = handlers.get(body);
  if (!run) {
    run = new Function(`return function(F,K){const R=F.R,D=F.D,S=F.S;${body}}`)() as Handler;
    handlers.set(body, run); perf.coldHandlers++;
  }
  return { run, constants, next };
}

/** Cold bodies share one runner, so the JS stack names none of them: the throwable itself
 *  collects the Java frames it unwinds through (bounded), for [uncaught] reports. */
function noteFrame(e: unknown, name: string): void {
  if (typeof e !== "object" || e === null) return;
  const t = e as { jframes?: string[] };
  const frames = t.jframes ??= [];
  if (frames.length < 48) frames.push(name);
}
/** Runs synchronously until an instruction suspends; only then does the call return a Promise. */
export function runCold(method: ColdMethod, receiver: unknown, args: unknown[]): unknown {
  perf.coldCalls++;
  const { R, D, S } = method;
  const f: ColdFrame = { R, D, S, v: new Array(method.regs), next: 0, r: 0, done: false, value: undefined,
    $t: undefined, $u: undefined, $ex: undefined, $fu: undefined, $th: R.th(), $s: 0, $w: 0 };
  let reg = method.first;
  if (method.instance) f.v[reg++] = receiver;
  for (let i = 0; i < args.length; i++) { f.v[reg] = args[i]; reg += method.widths[i]; }
  return step(method, f, receiver, -1, undefined);
}

/** Run from f.next; `thrownAt` >= 0 first raises `thrown` from the instruction there. */
function step(method: ColdMethod, f: ColdFrame, receiver: unknown, thrownAt: number, thrown: unknown): unknown {
  const { R, D } = method;
  const profiled = jvmProfiler.enabled;
  const started = profiled ? performance.now() : 0;
  let suspended = false;
  try {
    while (!f.done) {
      const pc = thrownAt >= 0 ? thrownAt : f.next, op = method.ops.get(pc);
      if (!op) throw new Error("bad pc " + pc);
      try {
        if (thrownAt >= 0) { thrownAt = -1; throw thrown; }
        f.next = op.next;
        const pending = op.run(f, op.constants);
        if (pending !== undefined) { suspended = true; return suspend(method, f, receiver, pc, pending); }
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
        if (method.hotness >= jvmProfiler.hotThreshold && method.promote) {
          const handoff = method.promote(f, receiver);
          if (handoff) { suspended = true; return handoff.value; }
        }
      }
    }
    return f.value;
  } finally {
    // A frame that has suspended hands the thread back on completion; one still suspended
    // released it already, and a hot handoff inherits the obligation.
    if (f.$s && !suspended) R.su(f.$th);
    if (profiled) jvmProfiler.add(method.name, "coldRun", performance.now() - started);
  }
}

function suspend(method: ColdMethod, f: ColdFrame, receiver: unknown, pc: number, pending: Promise<unknown>): Promise<unknown> {
  const delivers = f.$w === 1;
  f.R.su(f.$th); f.$s = 1;
  if (jvmProfiler.enabled) jvmProfiler.suspension(method.name);
  return pending.then((value) => {
    f.R.st(f.$th);
    if (delivers) f.$t = value; else f.next = pc;
    return step(method, f, receiver, -1, undefined);
  }, (error) => {
    f.R.st(f.$th);
    return step(method, f, receiver, pc, error);
  });
}
