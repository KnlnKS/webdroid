// Java stack traces read from the engine's stacks: V8 names Wasm frames by function, and a function's trace maps its offsets back to dex pcs.
import type { Strand } from "./sched.ts";
import { javaFrames, deepStack, engineFrames, type EngineFrame, type JavaFrame } from "../compiler/exc.ts";
import type { FnTrace } from "../compiler/j2w.ts";
import { methodOf, type MethodInfo } from "../compiler/program.ts";
import type { World } from "./world.ts";

type BridgeStack = { stack?: Error; prior?: BridgeStack; done: boolean };
/** the depths a caller's frames are read at: most callers are near, and a deeper capture costs more to take and to read */
const DEPTHS = [16, 48, 128];

export class StackTraces {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  /** the traces of the functions compiled here, by name; a build's are read from its modules as stacks need them (AotRuntime.trace) */
  readonly traces = new Map<string, FnTrace>();
  private frameTraces = { get: (name: string) => this.traces.get(name) ?? this.w.aot?.trace(name) };
  /** the methods of the running stack's frames, innermost first: V8 names a Wasm function by its method's id, which a dispatch entry or an outlined loop extends */
  methodsOnStack(): MethodInfo[] {
    const out: MethodInfo[] = [];
    for (const { name } of engineFrames(deepStack())) {
      const m = name ? methodOf(this.w.prog, name.replace(/^\$dispatch:/, "").split("#")[0]) : undefined;
      if (m) out.push(m);
    }
    return out;
  }
  private captured = new WeakMap<object, Error | JavaFrame[]>();
  private bridgeStacks = new WeakMap<Strand, BridgeStack>();
  private javaStack(frames: EngineFrame[], count = Infinity, lines = true): JavaFrame[] {
    // Each callFn enters a fresh engine stack. Keep only that stack's frames,
    // then append its suspended callers. The marker's name is explicit, even in minified builds.
    // A caller that has not suspended is still on the physical stack, beyond its call's marker.
    const segments = (frames: EngineFrame[]) => {
      const out: EngineFrame[][] = [[]];
      for (const f of frames) if (f.name === "webdroid:callFn") out.push([]); else out[out.length - 1].push(f);
      return out;
    };
    const physical = segments(frames), parts = [physical[0]];
    let next = 1;
    for (let caller = this.bridgeStacks.get(this.w.sched.current()); caller; caller = caller.prior)
      parts.push(caller.stack ? segments(engineFrames(caller.stack))[0] : physical[next++] ?? []);
    return javaFrames(parts.flat(), this.frameTraces, count, lines);
  }
  /** records the stack throwable `exn` is made on: its Java frames now when callers suspended at a bridge are no longer on the engine's stack, else the
   *  engine's stack, read when the trace is asked for */
  capture(exn: object): void {
    const stack = deepStack();
    let suspended = false;
    for (let caller = this.bridgeStacks.get(this.w.sched.current()); caller && !suspended; caller = caller.prior) suspended = !!caller.stack;
    this.captured.set(exn, suspended ? this.javaStack(engineFrames(stack)) : stack);
  }
  /** a call from the host into Java on strand `s` begins (HostFunctions.callFn): its Java callers' frames are captured if it suspends, and dropped once it ends */
  bridge(s: Strand): { suspended(): void; leave(): void } {
    // Java callers stay on the physical stack until the call suspends; only then are their frames captured.
    const w = this.w, javaCaller = w.sched.inJava();
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
  /** the innermost `count` Java frames, including callers suspended at host bridges: the engine's stack is read only as deep as they take */
  callerFrames(count: number): JavaFrame[] { return this.scan(count, (frames) => frames.length >= count); }
  /** the innermost Java frame `accepts` takes, including callers suspended at host bridges, read as deep as that takes */
  callerFrame(accepts: (f: JavaFrame) => boolean): JavaFrame | undefined { return this.scan(Infinity, (frames) => frames.some(accepts)).find(accepts); }
  /** the first `count` Java frames of a capture at each of DEPTHS until `enough` takes them or the engine's stack ended inside it */
  private scan(count: number, enough: (frames: JavaFrame[]) => boolean): JavaFrame[] {
    let frames: JavaFrame[] = [];
    for (const limit of DEPTHS) {
      const engine = engineFrames(deepStack(limit));
      frames = this.javaStack(engine, count, false);
      if (enough(frames) || engine.length < limit) break;
    }
    return frames;
  }
  /** captured frames without the throwable's own construction */
  stackTrace(state: object): JavaFrame[] {
    const captured = this.captured.get(state);
    if (!captured) return [];
    const frames = Array.isArray(captured) ? captured : javaFrames(engineFrames(captured), this.frameTraces);
    let skip = 0;
    while (skip < frames.length && /^(fillInStackTrace|nativeFillInStackTrace)$|^<init>$/.test(frames[skip].method) && (frames[skip].method !== "<init>" || this.w.prog.isSubclass(frames[skip].cls, "java/lang/Throwable"))) skip++;
    return frames.slice(skip);
  }
}
