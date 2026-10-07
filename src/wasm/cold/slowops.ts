// Canonical compiler adapters for the shared cold opcode loop.
import { descToName, parseMethodDesc } from "../../jvm/abi";
import { prepareMethod, registersOf, type PreparedInstruction } from "../../jvm/prepared";
import { OP } from "../compiler/code";
import { inferTyping, D, R, J, type Typing } from "../compiler/infer";
import { MC } from "../compiler/method";
import { mid } from "../compiler/ids";
import { declaredMethod, kindOf, type Kind, type MethodInfo } from "../compiler/program";
import type { Code } from "../compiler/code";
import { Compiler } from "../compiler/j2w";
import { siteOperands } from "../compiler/sites";
import { T } from "../compiler/wasmbin";
import { validateColdSnapshot, type ColdSnapshot } from "./state";
import type { Strand } from "../link/sched";
import type { World } from "../link/world";
import { definitionReady, instructionClass, resolveInstruction } from "../link/resolution";


export class UnsupportedSlowOperation extends Error {}
type Analysis = { prepared: ReturnType<typeof prepareMethod>; typing: Typing; instructions: Map<number, PreparedInstruction> };
type Adapter = { call: (strand: Strand, sync: boolean, depth: number, peer: unknown, ...args: unknown[]) => unknown; inputs: { reg: number; kind: Kind }[]; output: Kind | "V"; successor: number; producer: boolean };
type SlowBody = (cx: Compiler, c: Code, arg: (i: number) => void) => number[];
type Batch = { readonly sealed: boolean; entries: { body: SlowBody; ctor?: MethodInfo }[]; call: (strand: Strand, sync: boolean, selector: number, depth: number, peer: unknown, ...args: unknown[]) => unknown };
const BATCH_SIZE = 16;
const abi = (kind: number): Kind => kind === R ? "L" : kind === J || kind === D ? "J" : "I";

// Slow adapters contain no copied callees. Always resolve virtual calls through
// the receiver's current slot, including when a callback loads an override.
class SlowMC extends MC {
  override symbolic = false;
  override callee(ins: PreparedInstruction): MethodInfo | "dynamic" | null {
    return /^invoke-(virtual|interface)/.test(ins.name) ? "dynamic" : super.callee(ins);
  }
  outputLocal = -1;
  override set(_kind: Kind): void { this.code.lset(this.outputLocal); }
  override setF32(): void { this.code.raw(OP.i32_reinterpret_f32); this.set("I"); }
  override setF64(): void { this.code.raw(OP.i64_reinterpret_f64); this.set("J"); }
  override finishResult(_ins: PreparedInstruction, kind: Kind | "V"): void {
    if (kind !== "V") this.set(kind);
  }
}

/** Executes one supported slow opcode, committing its registers only on success. */
export class ColdSlowOps {
  private analyses = new WeakMap<MethodInfo, Analysis>();
  private adapters = new WeakMap<MethodInfo, Map<number, Adapter>>();
  private calls = new WeakMap<MethodInfo, Map<string, Adapter["call"]>>();
  private batches = new WeakMap<MethodInfo, Map<string, Batch[]>>();
  private busy = new WeakSet<ColdSnapshot>();
  constructor(private readonly w: World) {}

  static supports(ins: PreparedInstruction): boolean {
    if (ins.name.endsWith("-quick")) return false;
    return /^(move-result|move-exception|invoke-|iget|sget|iput|sput|aget|aput|monitor-|fill-array-data|throw|const-string|const-class|const-method-|new-instance|new-array|filled-new-array|check-cast|array-length|instance-of|(?:div|rem)-(?:int|long|float|double))/.test(ins.name);
  }

  private site(m: MethodInfo, pc: number, analysis: Analysis) {
    const ins = analysis.instructions.get(pc);
    if (!ins) throw new UnsupportedSlowOperation(`${mid(m)} at ${pc}`);
    return { ins, ...siteOperands(m, ins, analysis.typing) };
  }

  prepareSite(m: MethodInfo, pc: number) {
    const analysis = this.prepareAnalysis(m);
    this.w.stats.symbolicTypingMethods++;
    return { ...this.site(m, pc, analysis), analysis };
  }

  compileSite(m: MethodInfo, pc: number, site = this.prepareSite(m, pc)) {
    const { ins, inputs, output, analysis } = site, cx = new Compiler(this.w);
    const emit = this.operation(m, ins, inputs, output, analysis);
    const built = cx.buildSynthetic(`symbolic:${m.cls}:${m.index}:${pc}`, inputs.map(i => i.kind), c => {
      const weights = emit(cx, c, i => {
        if (i < 2) c.gget(cx.global("rt", i ? "thr" : "depth", i ? T.anyref : T.i32, true));
        else c.lget(i - 2);
      });
      for (const at of weights) c.patch(at, 4 + c.nparams + c.localTypes.length);
    }, output);
    return { cx, built };
  }

  private analysis(m: MethodInfo): Analysis {
    let found = this.analyses.get(m);
    if (!found) {
      this.analyses.set(m, found = this.prepareAnalysis(m));
      this.w.stats.coldTypingMethods++;
    }
    return found;
  }

  private prepareAnalysis(m: MethodInfo): Analysis {
    const start = performance.now(), item = m.dex.code(m.codeOff), prepared = prepareMethod(m.dex, item, m.desc, m.isStatic);
    this.w.stats.phase.prepare += performance.now() - start;
    const infer = performance.now(), typing = inferTyping(m.dex, item, m.desc, m.isStatic, prepared.instructions);
    this.w.stats.phase.infer += performance.now() - infer;
    return { prepared, typing, instructions: new Map(prepared.instructions.map(ins => [ins.pc, ins])) };
  }

  private output(m: MethodInfo, ins: PreparedInstruction): Kind | "V" {
    const n = ins.name;
    if (/^invoke-polymorphic/.test(n)) { const ret = m.dex.type(m.dex.proto(ins.c).ret); return ret === "V" ? "V" : kindOf(ret); }
    if (/^invoke-custom/.test(n)) { const ret = m.dex.type(m.dex.proto((m.dex.callSite(ins.b)[2] as { idx: number }).idx).ret); return ret === "V" ? "V" : kindOf(ret); }
    if (n.startsWith("invoke")) {
      const mr = m.dex.method(ins.b);
      if (/^invoke-direct/.test(n) && mr.name === "<init>" && descToName(m.dex.type(mr.cls)) === "java/lang/String")
        return "L";
      const ret = parseMethodDesc(m.dex.methodDesc(ins.b)).ret;
      return ret === "V" ? "V" : kindOf(ret);
    }
    if (/^(iget|sget)/.test(n)) return kindOf(m.dex.type(m.dex.field(n.startsWith("iget") ? ins.c : ins.b).type));
    if (n.startsWith("aget")) return n === "aget-object" ? "L" : n === "aget-wide" ? "J" : "I";
    if (/^(iput|sput|aput|monitor-|fill-array-data|throw)/.test(n)) return "V";
    if (/^(const-string|const-class|const-method-|new-instance|new-array|filled-new-array|check-cast)/.test(n)) {
      return "L";
    }
    if (n === "array-length" || n === "instance-of") return "I";

    if (/^(div|rem)-(int|long|float|double)(\/.*)?$/.test(n)) return /-(long|double)/.test(n) ? "J" : "I";
    throw new UnsupportedSlowOperation(`${mid(m)} at ${ins.pc}: ${n}`);
  }

  private batchReady(m: MethodInfo, ins: PreparedInstruction): boolean {
    const loader = this.w.prog.loaderOf(m.cls);
    if (loader === this.w.prog.boot) return true;
    if (/^invoke-(custom|polymorphic)|^const-method-/.test(ins.name)) return false;
    const name = instructionClass(m, ins);
    if (!name) return true;
    const component = name.replace(/^\[+/, ""), type = name[0] === "[" && component[0] === "L" ? component.slice(1, -1) : name;
    if (name[0] === "[" && /^[ZBCSIJFD]$/.test(component)) return true;
    const key = this.w.prog.initiatedBy(loader, type);
    return !!key && definitionReady(this.w, key);
  }

  private adapter(m: MethodInfo, ins: PreparedInstruction, seal = true): Adapter {
    const analysis = this.analysis(m);
    if (!analysis.typing.reached(ins.pc)) throw new UnsupportedSlowOperation(`unreachable cold opcode at ${ins.pc}`);
    let cache = this.adapters.get(m);
    if (!cache) {
      this.adapters.set(m, cache = new Map());
    }
    if (seal && !cache.has(ins.pc)) {
      // Preseal only already-resolved owners; inactive symbolic names stay lazy.
      for (const op of analysis.prepared.instructions) {
        if (!analysis.typing.reached(op.pc) || !ColdSlowOps.supports(op) || /^(move-result|move-exception)/.test(op.name)
          || op.name === "new-instance" && descToName(m.dex.type(op.b)) === "java/lang/String" || !this.batchReady(m, op)) continue;
        this.adapter(m, op, false);
      }
    }
    let found = cache.get(ins.pc);
    if (found) return found;
    const { typing } = this.analysis(m), output = this.output(m, ins), inputs: { reg: number; kind: Kind; web: number }[] = [];
    const seen = new Set<number>();
    for (const reg of registersOf(ins)) {
      const web = typing.use(ins.pc, reg);
      if (web >= 0 && !seen.has(web)) { seen.add(web); inputs.push({ reg, kind: abi(typing.kind[web]), web }); }
    }
    // Canonical emitters use conservative facts. Register numbers can differ
    // while operand roles, aliases, web kinds and declaration linkage stay equal.
    // PC-relative array payloads retain their absolute location in the key.
    const named = registersOf(ins), roles = new Map<number, number>();
    for (const reg of named) if (!roles.has(reg)) roles.set(reg, roles.size);
    const a = roles.get(ins.a), b = roles.get(ins.b), c = roles.get(ins.c);
    const operands = ins.fmt === "23x" ? [a, b, c]
      : ["12x", "22x", "32x", "22b", "22s", "22c"].includes(ins.fmt) ? [a, b, ins.c]
      : ["35c", "3rc", "45cc", "4rcc"].includes(ins.fmt) ? [ins.a, ins.b, ins.c, ins.regs.map(r => roles.get(r))]
      : [a, ins.b, ins.c];
    const def = typing.def(ins.pc);
    const key = JSON.stringify([ins.op, operands, String(ins.wideLit),
      ins.constKind, ins.nullRecv, ins.signOnly, output, def < 0 ? -1 : typing.kind[def],
      inputs.map(i => [roles.get(i.reg), typing.kind[i.web]]), ins.name === "fill-array-data" ? ins.pc : -1]);
    let calls = this.calls.get(m);
    if (!calls) this.calls.set(m, calls = new Map());
    const shared = calls.get(key);
    const finish = (call: Adapter["call"]) => {
      const adapter = { call, inputs, output, successor: ins.pc + ins.len,
        producer: ins.name.startsWith("invoke") || ins.name.startsWith("filled-new-array") };
      cache!.set(ins.pc, adapter); this.w.stats.coldSlowAdapters++;
      return adapter;
    };
    if (shared) return finish(shared);
    const body = this.operation(m, ins, inputs, output);
    // String factories embed native imports: an unexecuted constructor must
    // not reserve a native declaration when another case first runs.
    const constructor = this.stringConstructor(m, ins);
    const signature = inputs.map(i => i.kind).join("") + ":" + output + (constructor ? ":factory:" + ins.pc : "");
    let groups = this.batches.get(m);
    if (!groups) this.batches.set(m, groups = new Map());
    let list = groups.get(signature);
    if (!list) groups.set(signature, list = []);
    let batch = list.at(-1);
    if (!batch || batch.sealed || batch.entries.length === (this.batchReady(m, ins) ? BATCH_SIZE : 1)) {
      batch = this.batch(`cold:slow:${mid(m)}:${ins.pc}`, ["I", "L", "I", ...inputs.map(i => i.kind)], output);
      list.push(batch);
    }
    const selector = batch.entries.length;
    const ctor = constructor
      ? declaredMethod(this.w.prog.get("java/lang/String"), "<init>" + m.dex.methodDesc(ins.b)) : undefined;
    batch.entries.push({ body, ctor });
    const call: Adapter["call"] = (strand, sync, depth, peer, ...args) => batch!.call(strand, sync, selector, depth, peer, ...args);
    calls.set(key, call);
    return finish(call);
  }

  private operation(m: MethodInfo, ins: PreparedInstruction, inputs: { reg: number; kind: Kind; web: number }[], output: Kind | "V", analysis = this.analysis(m)): SlowBody {
    const { prepared, typing } = analysis;
    return (cx: Compiler, c: Code, arg: (i: number) => void) => {
      arg(0); c.gset(cx.global("rt", "depth", T.i32, true));
      arg(1); c.gset(cx.global("rt", "thr", T.anyref, true));
      const mc = new SlowMC(cx, m);
      mc.code = c; mc.prepared = prepared; mc.typing = typing; mc.cur = ins;
      mc.tmpL = c.newLocal(T.anyref);
      if (output !== "V") mc.outputLocal = c.newLocal(cx.vtOf(output));
      inputs.forEach((input, i) => {
        arg(i + 2);
        const storage = mc.storage(typing.kind[input.web]);
        if (storage === T.f32) c.raw(OP.f32_reinterpret_i32);
        else if (storage === T.f64) c.raw(OP.f64_reinterpret_i64);
        c.lset(mc.local(input.web));
      });
      // Account for the bridge frame and restore depth on both normal and tagged
      // exceptional exits, rather than mutating another strand's globals in JS.
      const entry = c.newLocal(T.i32), thrown = c.newLocal(T.anyref);
      const weights = cx.emitEnter(c, entry);
      c.block().block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
      mc.emit(ins);
      if (this.stringConstructor(m, ins)) c.lget(mc.local(mc.useWeb(ins.regs[0]))).lset(mc.outputLocal);
      if (ins.name === "check-cast" && descToName(m.dex.type(ins.b)) === "java/lang/Object") { mc.get("L", ins.a); c.lset(mc.outputLocal); }
      cx.emitLeave(c, entry, false); c.br(2);
      c.end().unreachable().end();
      c.lset(thrown); cx.emitLeave(c, entry, false); c.lget(thrown).throw_(cx.tag);
      c.end();
      if (output !== "V") c.lget(mc.outputLocal);
      return weights;
    };
  }

  private batch(name: string, params: Kind[], output: Kind | "V"): Batch {
    const entries: Batch["entries"] = [];
    let rootCall: ((...args: unknown[]) => unknown) | undefined;
    let strandCall: ((strand: Strand, ...args: unknown[]) => unknown) | undefined;
    const prepare = (cx: Compiler) => {
      this.w.stats.coldSlowModules++;
      // Only String factories embed native imports. Reserve those declarations
      // once per batch; ordinary invokes still use canonical method-table slots.
      const ctors = [...new Set(entries.flatMap(e => e.ctor ? [e.ctor] : []))];
      if (ctors.length) cx.natives.declare(cx, ctors);
    };
    const emit = (cx: Compiler, c: Code, arg: (i: number) => void) => {
      const weights: number[] = [];
      c.block(output === "V" ? undefined : cx.vtOf(output));
      entries.forEach((entry, selector) => {
        arg(2); c.i32(selector).raw(OP.i32_eq).if_();
        weights.push(...entry.body(cx, c, i => arg(i < 2 ? i : i + 1)));
        c.br(1).end();
      });
      c.unreachable().end();
      // All branches share the function's declared locals, including inactive
      // cases. Charge the actual frame rather than one opcode's old estimate.
      for (const at of weights) c.patch(at, 4 + c.nparams + c.localTypes.length);
    };
    const call: Batch["call"] = (strand, sync, selector, depth, peer, ...args) => strand.root || sync
      ? this.w.synchronous(() => (rootCall ??= this.w.hostFn(name, params, output, (cx, c) => emit(cx, c, i => { c.lget(i); }), prepare))(depth, peer, selector, ...args))
      : (strandCall ??= this.w.callFn(name, params, output, emit, prepare))(strand, depth, peer, selector, ...args);
    return { entries, call, get sealed() { return !!rootCall || !!strandCall; } };
  }

  private read(state: ColdSnapshot, reg: number, kind: Kind): unknown {
    if (kind === "L") {
      if (state.kinds[reg] === 1) return state.references[reg];
      if (state.bits[reg] === 0n) return null;
      throw new Error(`numeric v${reg} cannot be read as a reference`);
    }
    if (state.kinds[reg] !== 0) throw new Error(`reference v${reg} cannot be read as bits`);
    return kind === "J" ? state.bits[reg] : Number(BigInt.asIntN(32, state.bits[reg]));
  }

  private write(state: ColdSnapshot, reg: number, kind: Kind, value: unknown): void {
    if (kind === "L") { state.references[reg] = value; state.bits[reg] = 0n; state.kinds[reg] = 1; }
    else { state.bits[reg] = BigInt(value as number | bigint); state.references[reg] = null; state.kinds[reg] = 0; }
  }

  private handler(m: MethodInfo, pc: number, throwable: object): number | undefined {
    for (const range of m.dex.code(m.codeOff).tries) if (pc >= range.start && pc < range.end) {
      for (const [type, target] of range.handlers) {
        const name = descToName(m.dex.type(type));
        const matches = this.w.hostFn(`cold:catch:${name}`, ["L"], "I", (cx, c) => c.lget(0).call(cx.instanceOfFn(name)));
        if (matches(throwable)) return target;
      }
      if (range.catchAllAddr >= 0) return range.catchAllAddr;
    }
  }

  private stringConstructor(m: MethodInfo, ins: PreparedInstruction): boolean {
    return /^invoke-direct/.test(ins.name) && m.dex.method(ins.b).name === "<init>" && descToName(m.dex.type(m.dex.method(ins.b).cls)) === "java/lang/String";
  }

  validate(state: ColdSnapshot, strand: Strand): void {
    validateColdSnapshot(state);
    const m = state.method;
    if (!m || this.w.prog.resolve(m.cls, m.name, m.desc) !== m || this.w.sched.strands[strand.id] !== strand || state.owner !== strand)
      throw new Error("foreign cold method/strand ownership");
    for (const monitor of state.monitors) if (this.w.sched.monitors.depth(monitor.object, strand) < monitor.count)
      throw new Error("foreign cold monitor ownership");
    if (state.exception && this.handler(m, state.exception.pc, state.exception.value) !== state.pc)
      throw new Error("incompatible pending cold exception handler");
  }

  step(state: ColdSnapshot, strand: Strand, depth = state.depth, caller?: Error): "next" | "handler" | Promise<"next" | "handler"> {
    const m = state.method;
    if (!m) throw new Error("cold activation has no method identity");
    const item = m.dex.code(m.codeOff);
    if (this.w.prog.resolve(m.cls, m.name, m.desc) !== m || state.bits.length !== item.regs || state.references.length !== item.regs || state.kinds.length !== item.regs)
      throw new Error("incompatible cold slow activation");
    this.validate(state, strand);
    if (this.busy.has(state)) throw new Error("cold operation already in flight");
    const ins = this.analysis(m).instructions.get(state.pc);
    if (!ins) throw new Error(`not a DEX instruction boundary: ${state.pc}`);
    if (ins.name.startsWith("move-result")) {
      const result = state.result;
      const expected = ins.name === "move-result-object" ? "L" : ins.name === "move-result-wide" ? "J" : "I";
      if (!result || result.kind !== expected) throw new Error("missing or incompatible pending invoke result");
      this.write(state, ins.a, result.kind, result.value); state.result = undefined;
      state.executedPc = ins.pc; state.pc += ins.len; return "next";
    }
    if (ins.name === "move-exception") {
      if (!state.exception) throw new Error("missing pending Java exception");
      this.write(state, ins.a, "L", state.exception.value); state.exception = undefined;
      state.executedPc = ins.pc; state.pc += ins.len; return "next";
    }
    if (ins.name === "new-instance" && descToName(m.dex.type(ins.b)) === "java/lang/String") {
      // The canonical String constructor creates the actual reference. Keep a
      // unique allocation identity meanwhile so moves retain uninitialized aliases.
      const token = {};
      state.uninitialized.push({ reference: token, type: "java/lang/String", pc: ins.pc });
      this.write(state, ins.a, "L", token); state.result = undefined;
      state.executedPc = ins.pc; state.pc += ins.len; return "next";
    }
    let adapter: Adapter;
    const constructor = this.stringConstructor(m, ins), receiver = constructor ? state.references[ins.regs[0]] : undefined;
    if (constructor && !state.uninitialized.some(a => a.reference === receiver)) throw new Error("String constructor requires an uninitialized allocation");
    this.busy.add(state); state.result = undefined;
    const success = (result: unknown): "next" => {
      if (constructor) {
        for (let reg = 0; reg < state.kinds.length; reg++) if (state.kinds[reg] === 1 && state.references[reg] === receiver) this.write(state, reg, "L", result);
        state.uninitialized = state.uninitialized.filter(a => a.reference !== receiver);
      } else if (adapter.output !== "V") {
        if (adapter.producer) {
          const next = this.analysis(m).instructions.get(adapter.successor);
          if (next?.name.startsWith("move-result")) state.result = { pc: ins.pc, kind: adapter.output, value: result };
        } else this.write(state, ins.a, adapter.output, result);
      }
      if (ins.name === "monitor-enter" || ins.name === "monitor-exit") {
        const object = this.read(state, ins.a, "L") as object, held = state.monitors.find(m => m.object === object);
        if (ins.name === "monitor-enter") { if (held) held.count++; else state.monitors.push({ object, count: 1 }); }
        else if (held && --held.count === 0) state.monitors.splice(state.monitors.indexOf(held), 1);
      }
      state.executedPc = ins.pc; state.pc = adapter.successor;
      return "next";
    };
    const failure = (error: unknown): "handler" => {
      error = this.w.boundary(error);
      const throwable = this.w.throwable(error);
      if (!throwable) throw error;
      const target = this.handler(m, ins.pc, throwable);
      if (target === undefined) throw error;
      state.exception = this.analysis(m).instructions.get(target)?.name === "move-exception" ? { pc: ins.pc, value: throwable } : undefined; state.executedPc = ins.pc; state.pc = target;
      return "handler";
    };
    this.w.stats.coldSlowCalls++;
    // A peer can be allocated but not yet bound during Thread construction.
    // Capture it before yielding; callFn enters a fresh engine stack using the bound peer.
    const peer = this.w.rtImports().thr.value;
    const call = () => {
      const resolve = () => resolveInstruction(this.w, m, ins, strand);
      const found = state.sync ? this.w.synchronous(resolve) : resolve();
      const execute = () => {
        adapter = this.adapter(m, ins);
        const args = adapter.inputs.map(i => this.read(state, i.reg, i.kind));
        return adapter.call(strand, state.sync, depth, peer, ...args);
      };
      return found instanceof Promise ? found.then(execute) : execute();
    };
    const invoke = () => caller && !strand.root && !state.sync ? this.w.withBridgeCaller(caller, call) : call();
    try {
      // Ready async natives release engine stacks but only resume microtasks.
      // Slow operations also split numeric fuel slices, so honor the canonical
      // turn deadline here even when no stack quota or numeric slice expires.
      const pending = strand.canSuspend && !state.sync && this.w.sched.current() === strand && (this.w.sched.owes() || this.w.sched.turnDue())
        ? Promise.resolve(this.w.callFn("cold:slow:yield", [], "V", (cx, c) => cx.callRt(c, "yieldNow"))(strand)).then(invoke)
        : invoke();
      if (pending instanceof Promise) { this.w.stats.coldSlowWaits++; return pending.then(success, failure).finally(() => this.busy.delete(state)); }
      const answer = success(pending); this.busy.delete(state); return answer;
    } catch (error) {
      try { return failure(error); } finally { this.busy.delete(state); }
    }
  }
}
