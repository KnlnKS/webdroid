// Java stack traces read from the engine's stacks: V8 names Wasm frames by function, and a function's trace maps its offsets back to dex pcs.
import type { Strand } from "./sched.ts";
import { javaFrames, deepStack, type JavaFrame } from "../compiler/exc.ts";
import type { FnTrace } from "../compiler/j2w.ts";
import type { World } from "./world.ts";

type BridgeStack = { stack?: Error; prior?: BridgeStack; done: boolean };

export class StackTraces {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  /** the traces of functions by name: those of precompiled modules are read when a stack needs them */
  /** the traces of the functions compiled here, by name; a build's are read from its modules as stacks need them (AotRuntime.trace) */
  readonly traces = new Map<string, FnTrace>();
  private frameTraces = { get: (name: string) => this.traces.get(name) ?? this.w.aot?.trace(name) };
  private captured = new WeakMap<object, Error | JavaFrame[]>();
  private bridgeStacks = new WeakMap<Strand, BridgeStack>();
  private javaStack(stack: string, count = Infinity, lines = true): JavaFrame[] {
    // Each callFn enters a fresh engine stack. Keep only that stack's frames,
    // then append its suspended callers. The marker's name is explicit, even in minified builds.
    // A caller that has not suspended is still on the physical stack, beyond its call's marker.
    const segments = (text: string) => {
      const out: string[][] = [[]];
      for (const row of text.split("\n")) {
        if (row.includes("at webdroid:callFn (")) out.push([]);
        else if (row.includes("wasm-function[")) out[out.length - 1].push(row);
      }
      return out;
    };
    const physical = segments(stack), parts = [physical[0]];
    let next = 1;
    for (let caller = this.bridgeStacks.get(this.w.sched.current()); caller; caller = caller.prior)
      parts.push(caller.stack ? segments(caller.stack.stack ?? "")[0] : physical[next++] ?? []);
    return javaFrames(parts.flat().join("\n"), this.frameTraces, count, lines);
  }
  /** records the stack throwable `exn` is made on: its Java frames now when callers suspended at a bridge are no longer on the engine's stack, else the
   *  engine's stack, read when the trace is asked for */
  capture(exn: object): void {
    const stack = deepStack();
    this.captured.set(exn, this.bridgeStacks.has(this.w.sched.current()) ? this.javaStack(stack.stack ?? "") : stack);
  }
  /** a call from the host into Java on strand `s` begins (HostFunctions.callFn): its Java callers' frames are captured if it suspends, and dropped once it ends */
  bridge(s: Strand): { suspended(): void; leave(): void } {
    // Java callers stay on the physical stack until the call suspends; only then are their frames captured.
    const w = this.w, javaCaller = !w.sched.current().root || w.inSynchronousJava();
    const caller: BridgeStack = { prior: this.bridgeStacks.get(s), done: false };
    this.bridgeStacks.set(s, caller);
    return {
      suspended: () => { if (javaCaller && !caller.stack) { caller.stack = deepStack(); w.stats.bridgeCallerCaptures++; } },
      leave: () => {
        caller.done = true;
        if (this.bridgeStacks.get(s) !== caller) return;
        let prior = caller.prior;
        while (prior?.done) prior = prior.prior;
        if (prior) this.bridgeStacks.set(s, prior); else this.bridgeStacks.delete(s);
      },
    };
  }
  /** the innermost `count` Java frames, including callers suspended at host bridges */
  callerFrames(count: number): JavaFrame[] {
    for (const limit of [16, 48]) {
      const frames = this.javaStack(deepStack(limit).stack ?? "", count, false);
      if (frames.length >= count) return frames;
    }
    return this.javaStack(deepStack().stack ?? "", count, false);
  }
  /** captured frames without the throwable's own construction */
  stackTrace(state: object): JavaFrame[] {
    const captured = this.captured.get(state);
    if (!captured) return [];
    const frames = Array.isArray(captured) ? captured : javaFrames(captured.stack ?? "", this.frameTraces);
    let skip = 0;
    while (skip < frames.length && /^(fillInStackTrace|nativeFillInStackTrace)$|^<init>$/.test(frames[skip].method) && (frames[skip].method !== "<init>" || this.w.prog.isSubclass(frames[skip].cls.replace(/\./g, "/"), "java/lang/Throwable"))) skip++;
    return frames.slice(skip);
  }
}
