import { emitSymbolicSite } from "./sites.ts";
import { Code, OP } from "./code.ts";
import { T, ref, refNull, type VT } from "./wasmbin.ts";
import { kindOf, type Kind, type MethodInfo } from "./program.ts";
import type { Compiler } from "./j2w.ts";
import { H, elemKindOf, type ElemKind } from "./consts.ts";
import { isWide } from "../../jvm/abi.ts";
import { prepareMethod, endsBlock, ifTarget, branchTargets, switchCases, type PreparedInstruction as Ins, type PreparedMethod } from "../../jvm/prepared.ts";
import { type Flow, Go, structureAny } from "../../jvm/structure.ts";
import { mid } from "./ids.ts";
import { constClass, emitStoreCheck } from "../link/classes.ts";
import { emitPolymorphic } from "./poly.ts";
import { emitCustom, emitHandleConstant, emitTypeConstant } from "../link/mhandles.ts";
import { failed, resolveFieldRef, resolveInvoke, typeFailure, type LinkFailure } from "./linkage.ts";
import { analyze, cloneFacts, newFacts, step, type Facts } from "./facts.ts";
import { COUNT_SLOTS, MAX_UNCOUNTED, isStackOverflow } from "../link/exc.ts";
import { NO_THROW, isFieldAccess, isInvoke } from "./opinfo.ts";
import { emitRestored, FUEL } from "../link/sched.ts";
import { inferTyping, F as KF, R as KR, J as KJ, D as KD, type Typing } from "./infer.ts";

/** the calls of a method that may count its frame around themselves instead of in a prologue */
const MAX_SITES = 2;
const NONE: readonly string[] = [];
/** iterations of an outlined loop per call of its function; its dispatcher charges them to the activation's fuel */
const CHUNK = 1024;
/** the key of each invoke kind whose resolution is the same for every caller (MethodCompiler.invokeTarget) */
const INVOKE_USE: Record<string, number> = { "invoke-virtual": 0, "invoke-direct": 1, "invoke-static": 2, "invoke-interface": 3 };
/** the opcode of each binary operation that is one Wasm instruction, by operand type */
const INT_OPS: Record<string, number> = { add: OP.i32_add, sub: OP.i32_sub, mul: OP.i32_mul, and: OP.i32_and, or: OP.i32_or, xor: OP.i32_xor, shl: OP.i32_shl, shr: OP.i32_shr_s, ushr: OP.i32_shr_u };
const LONG_OPS: Record<string, number> = { add: OP.i64_add, sub: OP.i64_sub, mul: OP.i64_mul, and: OP.i64_and, or: OP.i64_or, xor: OP.i64_xor };
const FLOAT_OPS: Record<string, number> = { add: OP.f32_add, sub: OP.f32_sub, mul: OP.f32_mul, div: OP.f32_div };
const DOUBLE_OPS: Record<string, number> = { add: OP.f64_add, sub: OP.f64_sub, mul: OP.f64_mul, div: OP.f64_div };

export function compileMethod(cx: Compiler, m: MethodInfo): Code {
  const nparams = (m.isStatic ? 0 : 1) + m.params.length;
  const leaf = (c: Code) => { if (!cx.runsJava(c)) cx.bound.set(mid(m), 4 + nparams + c.localTypes.length); return c; };
  const intr = cx.intrinsic(m);
  if (intr) { const c = new Code(nparams); intr(cx, m, c); return leaf(c); }
  if (!m.codeOff) { const c = new Code(nparams); cx.gap(c, `${mid(m)}: ${cx.natives.reason(m)}`); return leaf(c); }
  try {
    const mc = new MC(cx, m);
    mc.run();
    return mc.weigh();
  } catch (e) {
    // Stack exhaustion is transient; keep the lazy stub available for a shallower retry.
    if (isStackOverflow(e)) throw e;
    const c = new Code(nparams); cx.gap(c, `${mid(m)}: ${(e as Error).message}`); return leaf(c);
  }
}

export class MC {
  cx: Compiler; m: MethodInfo;
  symbolic = true;
  code: Code; prepared!: PreparedMethod; flow!: Flow; typing!: Typing; item; dex;
  /** wasm local of each web */
  webLocal: number[] = [];
  /** the instruction being emitted: its operands resolve to webs through it */
  cur!: Ins;
  nest: string[] = [];
  block = 0;
  regionLocal = -1; pcLocal = -1; excLocal = -1; tmpL = -1;
  blockIns: Ins[][] = [];
  consumed = new Set<number>();            // move-result pcs folded into their invoke
  tries: boolean;
  regionOfPc = new Map<number, number>();
  /** what holds on every path to the start of each block, and at the instruction being emitted (facts.ts) */
  entryFacts: Facts[] = [];
  facts: Facts = newFacts();
  /** "web:struct" of the field accesses that share a cast, and the local holding it */
  shadowKeys = new Set<string>();
  shadows = new Map<string, number>();
  private root!: Code;
  /** the dispatch cycles (strong components of the regions): each runs in one chunk with a dispatch of its own */
  private cycleOf = new Map<number, number[]>();
  /** Loops and dispatch cycles run in functions of their own, re-entered every chunk of iterations, so a long activation reaches the engine's optimized code (G4).
   *  The second tier runs code that has already been hot: its loops stay in the method, unless the first tier saw one run 64 chunks in one entry (World.longLoops). */
  private outlining: boolean;
  /** The first tier starts a loop in the method and moves it to its chunks at a fuel tick (and the loops around it at their next iteration): a short loop then costs neither
   *  the state of an activation nor the engine's compiling of two more functions */
  private deferred: boolean;
  private armedLocal = -1;
  private chunk?: { code: Code; label: string; count: number; entry: number; exits: { pc: number; block: number; final: boolean }[]; locals: number[]; f: number; dispatch: number; cycle?: number[] };
  private cycleChunks = new Map<number[], NonNullable<MC["chunk"]>>();
  /** the state field in which the dispatchers count the iterations the activation's chunks ran, toward its fuel (the chunks themselves only count to CHUNK) */
  private chunkFuel = -1;
  private chunks: NonNullable<MC["chunk"]>[] = [];
  private resultLocal = -1;
  private controlLocal = -1;
  private stateType = -1;
  private stateLocal = -1;
  constructor(cx: Compiler, m: MethodInfo) {
    this.cx = cx; this.m = m;
    this.dex = m.dex; this.item = m.dex.code(m.codeOff);
    this.root = this.code = new Code((m.isStatic ? 0 : 1) + m.params.length);
    this.tries = this.item.tries.length > 0;
    this.outlining = cx.counting || cx.w.longLoops.has(mid(m));
    this.deferred = cx.counting;
  }

  // ---------- registers: webs with disjoint intervals share storage of the same Wasm type
  storage(k: number): VT { return k === KR ? T.anyref : k === KJ ? T.i64 : k === KD ? T.f64 : k === KF ? T.f32 : T.i32; }
  local(web: number): number {
    let l = this.webLocal[web];
    if (l === undefined) this.webLocal[web] = l = this.code.newLocal(this.storage(this.typing.kind[web]));
    return l;
  }
  private allocateWebs() {
    const { start, end } = this.typing.ranges(), reserved = new Set<number>();
    for (let r = this.item.regs - this.item.ins; r < this.item.regs; r++) { const w = this.typing.param(r); if (w >= 0) reserved.add(w); }
    const pools = new Map<VT, { local: number; end: number }[]>();
    const webs = start.map((_, w) => w).filter(w => start[w] !== undefined && !reserved.has(w)).sort((a, b) => start[a] - start[b] || a - b);
    for (const w of webs) {
      const type = this.storage(this.typing.kind[w]);
      let pool = pools.get(type); if (!pool) pools.set(type, pool = []);
      let slot = pool.find(slot => slot.end < start[w]);
      if (!slot) { slot = { local: this.root.newLocal(type), end: -1 }; pool.push(slot); }
      this.webLocal[w] = slot.local; slot.end = end[w];
    }
  }
  useWeb(reg: number, ins = this.cur): number {
    const w = this.typing.use(ins.pc, reg);
    if (w < 0) throw new Error(`no web for v${reg} at ${ins.pc}`);
    return w;
  }
  /** the kind (I, F, R, J, D) of the value in `reg` where the current instruction reads it */
  kindOf(reg: number): number { return this.typing.kind[this.useWeb(reg)]; }
  /** push `reg` in its web's storage; returns the web's kind */
  private load(reg: number): number {
    const w = this.useWeb(reg);
    this.code.lget(this.local(w));
    return this.typing.kind[w];
  }
  /** pop a value in the storage of the web `ins` defines; a value nothing reads is dropped */
  private store(ins: Ins): number {
    const w = this.typing.def(ins.pc);
    if (w < 0) { this.code.drop(); return 0; }
    this.code.lset(this.local(w));
    return this.typing.kind[w];
  }
  /** push `reg` in the bits ABI of `kind` (I: int and float bits, J: long and double bits, L: reference) */
  get(kind: Kind, reg: number): void {
    const k = this.load(reg), c = this.code;
    if (kind !== (k === KR ? "L" : k === KJ || k === KD ? "J" : "I")) throw new Error(`v${reg} holds a ${k} where ${kind} is read at ${this.cur.pc}`);
    if (k === KF) c.raw(OP.i32_reinterpret_f32); else if (k === KD) c.raw(OP.i64_reinterpret_f64);
  }
  /** pop a value in the bits ABI of `kind` into what `ins` (default: the current one) defines */
  set(kind: Kind, ins = this.cur): void {
    const w = this.typing.def(ins.pc), c = this.code;
    if (w >= 0) {
      const k = this.typing.kind[w];
      if (kind !== (k === KR ? "L" : k === KJ || k === KD ? "J" : "I")) throw new Error(`a ${kind} is defined as a ${k} at ${ins.pc}`);
      if (k === KF) c.raw(OP.f32_reinterpret_i32); else if (k === KD) c.raw(OP.f64_reinterpret_i64);
    }
    this.store(ins);
  }
  /** push a float or double operand as f32/f64 */
  f32(reg: number) { if (this.load(reg) !== KF) throw new Error(`v${reg} is not a float at ${this.cur.pc}`); }
  f64(reg: number) { if (this.load(reg) !== KD) throw new Error(`v${reg} is not a double at ${this.cur.pc}`); }
  /** pop an f32/f64 into what the current instruction defines */
  setF32() { this.store(this.cur); }
  setF64() { this.store(this.cur); }

  run(): void {
    const { m, item, cx } = this, phase = cx.w.stats.phase;
    let t = performance.now();
    const lap = (name: keyof typeof phase) => { const n = performance.now(); phase[name] += n - t; t = n; };
    const analysis = cx.methodAnalyses.get(m);
    const prepared = this.prepared = analysis?.prepared ?? prepareMethod(item);
    lap("prepare");
    let flow: Flow;
    try { flow = structureAny(prepared, item); } catch (e) { throw new Error(`unstructured: ${(e as Error).message}`); }
    this.flow = flow;
    lap("flow");
    this.typing = analysis?.typing ?? inferTyping(this.dex, item, m.desc, m.isStatic, prepared.instructions);
    lap("infer");
    // blocks
    let cur = -1;
    for (const ins of prepared.instructions) { if (prepared.leaders[ins.pc]) cur = flow.blockAt[ins.pc]; (this.blockIns[cur] ??= []).push(ins); }
    this.findShadows();
    this.entryFacts = analyze(this);
    lap("facts");
    const c = this.code;
    let reg = item.regs - item.ins, pi = 0;
    // Floating parameters arrive as bits and are copied into typed locals once.
    const param = (wide: boolean) => {
      const w = this.typing.param(reg);
      if (w >= 0) {
        const k = this.typing.kind[w], native = k === KF || k === KD;
        if (native) { c.lget(pi).raw(k === KF ? OP.f32_reinterpret_i32 : OP.f64_reinterpret_i64).lset(this.local(w)); }
        else this.webLocal[w] = pi;
      }
      pi++; reg += wide ? 2 : 1;
    };
    if (!m.isStatic) param(false);
    for (const p of m.params) param(isWide(p));
    this.allocateWebs();
    if (this.tries) { this.pcLocal = c.newLocal(T.i32); this.excLocal = c.newLocal(T.anyref); }
    this.tmpL = c.newLocal(T.anyref);
    if (this.outlining) this.findCyclicRegions();
    const hasLoops = this.outlining && (this.cycleOf.size > 0 || flow.regions.some((r) => r.scopes.some((s) => s.loop)));
    if (hasLoops) {
      c.nullableLocals = true;
      this.controlLocal = c.newLocal(T.i32);
      if (m.ret !== "V") this.resultLocal = c.newLocal(cx.vtOf(kindOf(m.ret)));
      if (!this.tries) this.excLocal = c.newLocal(T.anyref);
    }
    if (hasLoops || this.planDepth()) this.weights.push(...cx.emitEnter(c, this.entryDepth = c.newLocal(T.i32)));
    // a deferred loop's iterations count toward the method's budget when it returns
    if (hasLoops && this.deferred) this.fuelLocal = c.newLocal(T.i32);
    if (cx.counting) cx.emitCount(c, m);
    const regions = flow.regions;
    regions.forEach((r, i) => this.regionOfPc.set(flow.starts[r.entry], i));
    if (regions.length === 1 && !this.tries) {
      this.emitRegion(0);
      c.unreachable();
      return;
    }
    this.regionLocal = c.newLocal(T.i32);
    if (this.excLocal < 0) this.excLocal = c.newLocal(T.anyref);
    this.push("$disp"); c.loop();
    if (this.tries) {
      this.push("$caught"); c.block(T.anyref);
      c.tryTable(null, [[0, cx.tag, 0]]); this.push("$try");
    }
    // the method's own entry is region 0 and falls into it; only a jump from a handler or another region chooses by region (and gives other strands a turn)
    const n = regions.length;
    for (let k = n - 1; k >= 1; k--) { this.push("$R" + k); c.block(); }
    if (n > 1) {
      c.lget(this.regionLocal).if_(); this.push("if");
      this.fuel();
      c.lget(this.regionLocal).brTable(Array.from({ length: n }, (_, k) => Math.max(k, 1)), n - 1);
      this.pop(); c.end();
    }
    this.emitRegion(0); c.unreachable();
    for (let k = 1; k < n; k++) { this.pop(); c.end(); this.emitRegion(k); c.unreachable(); }
    if (this.tries) {
      this.pop(); c.end();                          // try_table
      c.unreachable();
      this.pop(); c.end();                          // $caught: exception on stack
      c.lset(this.excLocal);
      this.emitCatch();
      c.lget(this.excLocal).throw_(cx.tag);
    }
    this.pop(); c.end();                            // $disp loop
    c.unreachable();
  }
  /** the local holding the depth before this method's frame, if it counts one */
  private entryDepth = -1;
  private fuelLocal = -1;
  private fuel(tick?: () => void) { this.cx.emitFuel(this.code, this.fuelLocal >= 0 ? this.fuelLocal : (this.fuelLocal = this.code.newLocal(T.i32)), tick); }
  /** where the frame's weight (exc.ts MAX_DEPTH) goes in the code, known once the locals are */
  private weights: number[] = [];
  private leave() { if (this.entryDepth >= 0) this.cx.emitLeave(this.code, this.entryDepth, false); }
  /** gives the frame the weight of its parameters and locals */
  weigh(): Code {
    const types = [...(this.m.isStatic ? [] : [T.anyref]), ...this.m.params.map((p) => this.cx.vtOf(kindOf(p))), ...this.root.localTypes];
    if (this.chunks.length) {
      this.stateType = this.cx.mb.addType({ k: "struct", fields: types.map((t) => ({ t, mut: true })) });
      this.stateLocal = this.root.newLocal(refNull(this.stateType));
    }
    const own = (this.chunks.length ? 5 : 4) + types.length;
    for (const ch of this.chunks) {
      ch.locals = [...ch.code.locals].sort((a, b) => a - b);
      // State fields retain method indices; native chunks declare only their used locals.
      const locals = [...ch.locals, this.stateLocal];
      ch.code.localMap = new Map(locals.map((l, i) => [l, i + 1]));
      ch.code.nparams = 1;
      ch.code.localTypes = locals.map((l) => l === this.stateLocal ? refNull(this.stateType) : types[l]);
      const owner = this.cx.mb.funcNames[this.cx.fn.get(mid(this.m))! - this.cx.mb.nImportedFuncs];
      const name = `${owner}#loop${ch.label.slice(1)}`;
      ch.f = this.cx.mb.reserveFunc(this.cx.mb.addFuncType([ref(this.stateType)], [T.i32]), name);
      this.cx.outlines.push({ name, f: ch.f, code: ch.code, m: this.m });
      const d = new Code(1), count = d.newLocal(T.i32), status = d.newLocal(T.i32), fuel = d.newLocal(T.i32);
      d.loop().lget(0).i32(0).structSet(this.stateType, ch.count);
      d.lget(0).call(ch.f).lset(status);
      // the activation's fuel: the iterations of every chunk it ran
      d.lget(0).structGet(this.stateType, this.chunkFuel).lget(0).structGet(this.stateType, ch.count).raw(OP.i32_add).ltee(fuel).i32(FUEL).raw(OP.i32_ge_u).if_();
      this.cx.callRt(d, "yieldNow"); d.i32(0).lset(fuel).end();
      d.lget(0).lget(fuel).structSet(this.stateType, this.chunkFuel);
      d.lget(status).i32(1).raw(OP.i32_ne).if_().lget(status).ret().end();
      d.lget(count).i32(1).raw(OP.i32_add).ltee(count).i32(64).raw(OP.i32_lt_u).brIf(0).end();
      const slot = this.cx.counting ? this.cx.w.slotOf(this.m) : COUNT_SLOTS;
      if (slot < COUNT_SLOTS) d.i32(slot).call(this.cx.imp.long);
      d.i32(1).ret();
      ch.dispatch = this.cx.mb.addFunc(this.cx.mb.addFuncType([ref(this.stateType)], [T.i32]), d.finish(), "$dispatch:" + name);
    }
    for (const at of this.weights) this.code.patch(at, own);
    if (this.entryDepth < 0 && this.boundable) this.cx.bound.set(mid(this.m), own + this.calleeWeight);
    for (const ch of this.chunks) {
      ch.code.materialize();
      this.cx.mb.setBody(ch.f, ch.code.finish());
    }
    this.root.materialize();
    return this.root;
  }
  /** the weight of the heaviest method this one calls, once it counts no depth */
  private calleeWeight = 0;
  /** the calls that count the frame around themselves (planDepth) */
  private sites = new Set<string>();
  /** whether the calls that count their own frame are all on paths that throw, so a caller need not count its frame for the method */
  private boundable = true;
  private siteLocal = -1;
  private enterSite() { if (this.siteLocal < 0) this.siteLocal = this.code.newLocal(T.i32); this.weights.push(...this.cx.emitEnter(this.code, this.siteLocal)); }
  private leaveSite() { this.cx.emitLeave(this.code, this.siteLocal, false); }
  /** how the method counts its frame against the depth limit (exc.ts MAX_DEPTH): not at all when it calls only methods of its unit that count none and is small with
   *  them, since the engine's stack holds the limit twice over and these frames add at most MAX_UNCOUNTED to the counted ones; around the one or two calls that are
   *  not such methods (a slow path, a recursion); else for the whole frame. Answers whether it is for the whole frame, which a handler must restore */
  private planDepth(): boolean {
    if (this.prepared.instructions.some(ins => this.deferredSite(ins))) return true;
    const calls = this.prepared.instructions.filter((i) => isInvoke(i.op));
    if (!calls.length) return false;
    if (this.tries) return true;
    const open: string[] = [], cold: string[] = [], thrown = new Set<number>();
    for (const b of this.blockIns) if (b?.[b.length - 1].op === 0x27) for (const i of b) thrown.add(i.pc);
    const bounded = (m: MethodInfo | "dynamic") => { const w = m === "dynamic" ? undefined : this.cx.boundOf(m); if (w !== undefined) this.calleeWeight = Math.max(this.calleeWeight, w); return w !== undefined; };
    for (const ins of calls) {
      const t = this.callee(ins), key = String(ins.pc), virtual = this.virtuals.get(ins.pc);
      if (t === null) continue;
      if (ins.op >= 0xfa) return true; // invoke-polymorphic, invoke-custom
      // a virtual call tests for the likely implementations of its unit first (guards): the call of one that counts, and the dispatch behind them, count around themselves
      const guards = virtual ? this.callGuards(ins) : [];
      if (guards.length) {
        for (const g of guards) if (!bounded(g)) open.push(`${key}:${mid(g)}`);
        cold.push(key + ":f");
      } else if (!bounded(virtual ? "dynamic" : t)) {
        // the constructor of an exception thrown right after runs once and leaves the method: a caller's weight is no loss there, whatever the stack holds
        (thrown.has(ins.pc) ? cold : open).push(key);
      }
    }
    // a call in a loop counts once per iteration around itself, against once per call of the method in a prologue
    if (open.length) {
      const loops = this.prepared.instructions.flatMap((b) => branchTargets(this.item, b).filter((t) => t <= b.pc).map((t) => [t, b.pc]));
      if (open.some((k) => { const pc = parseInt(k); return loops.some(([from, to]) => pc >= from && pc <= to); })) return true;
    }
    if (this.calleeWeight + 4 + 3 * this.item.regs > MAX_UNCOUNTED || open.length > MAX_SITES) return true;
    this.sites = new Set([...open, ...cold]);
    this.boundable = open.length === 0;
    return false;
  }
  private callees = new Map<number, MethodInfo | null | "dynamic">();
  /** the declaration used for virtual dispatch and guards */
  private virtuals = new Map<number, [string, string, string]>();
  private callGuards(ins: Ins): MethodInfo[] {
    const target = this.callee(ins), virtual = this.virtuals.get(ins.pc);
    if (target && target !== "dynamic") return this.cx.directFunc(target) === undefined ? [] : [target];
    return virtual ? this.cx.guards(...virtual) : [];
  }
  /** whether `ins` is one of the module's symbolic sites (sites.ts), whose references resolve when it runs */
  private deferredSite(ins: Ins): boolean {
    return this.symbolic && this.cx.symbolicImports.size > 0 && this.cx.symbolicImports.has(`${this.m.cls}:${this.m.index}:${ins.pc}`);
  }
  /** the method an invoke calls directly; null if it calls no Java method, "dynamic" if the target is known only at run time */
  callee(ins: Ins): MethodInfo | null | "dynamic" {
    if (this.deferredSite(ins)) return "dynamic";
    let r = this.callees.get(ins.pc);
    if (r === undefined) this.callees.set(ins.pc, r = this.resolveCallee(ins));
    return r;
  }
  private resolveCallee(ins: Ins): MethodInfo | null | "dynamic" {
    const cx = this.cx, dex = this.dex, kind = ins.name.replace("/range", "");
    if (kind === "invoke-custom" || kind === "invoke-polymorphic") return "dynamic";
    const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), declared = dex.typeName(mr.cls), decl = declared[0] === "[" ? "java/lang/Object" : declared;
    if (declared !== decl && mr.name + desc === "clone()Ljava/lang/Object;") return null;
    const target = this.invokeTarget(ins.b, kind, declared, mr.name, desc);
    if (failed(target)) return null;
    if (kind === "invoke-static") return target;
    if (kind === "invoke-direct" && cx.str.isString(decl) && mr.name === "<init>") return "dynamic";
    if (kind === "invoke-direct" || kind === "invoke-super") return target;
    const only = cx.devirt(decl, mr.name, target.desc);
    this.virtuals.set(ins.pc, [decl, mr.name, target.desc]);
    return only === "many" ? "dynamic" : only;
  }
  push(l: string) { this.nest.push(l); }
  pop() { this.nest.pop(); }
  depth(label: string): number { const i = this.nest.lastIndexOf(label); if (i < 0) throw new Error("no label " + label); return this.nest.length - 1 - i; }
  blk(label: string, loop: boolean, bt: VT | null = null, deferred?: { nested: boolean }) {
    this.push(label);
    if (!loop) { this.code.block(bt); return; }
    this.code.loop(bt);
    if (deferred) {
      const c = this.code, armed = this.armedLocal >= 0 ? this.armedLocal : (this.armedLocal = this.root.newLocal(T.i32));
      if (deferred.nested) c.lget(armed).brIf(this.depth("$xfer" + label));
      this.push("if");
      this.fuel(() => c.i32(1).lset(armed).br(this.depth("$xfer" + label)));
      this.pop();
    } else if (label[0] === "L") {
      if (this.chunk?.label === label) {
        const ch = this.chunk, c = this.code;
        c.lget(ch.count).i32(CHUNK).raw(OP.i32_eq).if_(); this.push("if");
        this.chunkReturn(1); this.pop(); c.end();
        c.lget(ch.count).i32(1).raw(OP.i32_add).lset(ch.count);
      }
      if (this.cx.counting && !this.chunk) this.cx.emitCount(this.code, this.m);
      // every cycle passes a natural loop's head, which can hold the browser thread however finite the loop
      if (this.chunk?.label !== label) this.fuel();
    }
  }
  endBlk() { this.pop(); this.code.end(); }

  emitRegion(k: number) {
    const r = this.flow.regions[k], cycle = this.cycleOf.get(k);
    if (!cycle || this.chunk?.cycle === cycle) { this.emitSpan(r, 0, r.order.length, r.scopes); return; }
    let ch = this.cycleChunks.get(cycle);
    if (!ch) this.cycleChunks.set(cycle, ch = this.chunkBody("$cycle" + cycle[0], () => this.emitCycle(cycle), cycle));
    this.code.i32(k).lset(this.regionLocal);
    this.chunkCall(ch);
  }
  /** the regions of a dispatch cycle in its chunk: a jump between them dispatches here, each dispatch counting toward the chunk */
  private emitCycle(cycle: number[]): void {
    const c = this.code, ch = this.chunk!;
    this.push("$cycleDisp"); c.loop();
    c.lget(ch.count).i32(CHUNK).raw(OP.i32_eq).if_(); this.push("if"); this.chunkReturn(1); this.pop(); c.end();
    c.lget(ch.count).i32(1).raw(OP.i32_add).lset(ch.count);
    for (let i = cycle.length - 1; i >= 0; i--) { this.push("$C" + i); c.block(); }
    const at = new Map(cycle.map((k, i) => [k, i]));
    c.lget(this.regionLocal).brTable(Array.from({ length: this.flow.regions.length }, (_, k) => at.get(k) ?? 0), 0);
    for (let i = 0; i < cycle.length; i++) { this.pop(); c.end(); this.emitRegion(cycle[i]); c.unreachable(); }
    this.pop(); c.end().unreachable();
  }
  private findCyclicRegions(): void {
    const { regions, blockAt } = this.flow, n = regions.length;
    if (n < 2) return;
    const owner = new Int32Array(this.flow.starts.length).fill(-1);
    regions.forEach((r, k) => { for (const b of r.order) owner[b] = k; });
    const edges = Array.from({ length: n }, () => new Set<number>()), reverse = Array.from({ length: n }, () => new Set<number>());
    for (let k = 0; k < n; k++) for (const b of regions[k].order) {
      const ins = this.blockIns[b].at(-1)!;
      const targets = [...branchTargets(this.item, ins)];
      if (!endsBlock(ins.op)) targets.push(ins.pc + ins.len);
      for (const pc of targets) {
        const to = owner[blockAt[pc]];
        if (to !== k) { edges[k].add(to); reverse[to].add(k); }
      }
    }
    for (const t of this.item.tries) {
      const handlers = [...t.handlers.map(([, pc]) => pc), ...t.catchAllAddr >= 0 ? [t.catchAllAddr] : []];
      let from = -1;
      for (const ins of this.prepared.instructions) {
        if (this.prepared.leaders[ins.pc]) from = owner[blockAt[ins.pc]];
        if (from < 0 || ins.pc < t.start || ins.pc >= t.end || NO_THROW[ins.op]) continue;
        for (const pc of handlers) {
          const to = owner[blockAt[pc]];
          if (to >= 0 && to !== from) { edges[from].add(to); reverse[to].add(from); }
        }
      }
    }
    // Strong components identify dispatch cycles without outlining acyclic handler paths; each cycle re-enters its chunk.
    const seen = new Set<number>(), order: number[] = [];
    for (let start = 0; start < n; start++) {
      if (seen.has(start)) continue;
      const stack: [number, boolean][] = [[start, false]];
      while (stack.length) {
        const [v, done] = stack.pop()!;
        if (done) { order.push(v); continue; }
        if (seen.has(v)) continue;
        seen.add(v); stack.push([v, true]);
        for (const to of edges[v]) if (!seen.has(to)) stack.push([to, false]);
      }
    }
    seen.clear();
    for (const start of order.reverse()) {
      if (seen.has(start)) continue;
      const component: number[] = [], stack = [start]; seen.add(start);
      while (stack.length) {
        const v = stack.pop()!; component.push(v);
        for (const to of reverse[v]) if (!seen.has(to)) { seen.add(to); stack.push(to); }
      }
      if (component.length > 1) {
        component.sort((a, b) => a - b);
        for (const v of component) this.cycleOf.set(v, component);
      }
    }
  }
  private emitSpan(r: Flow["regions"][number], start: number, end: number, scopes: Flow["regions"][number]["scopes"]) {
    const open: { close: number }[] = []; let next = 0, p = start;
    while (p <= end) {
      while (open.length && open[open.length - 1].close === p) { open.pop(); this.endBlk(); }
      let outlined = false;
      for (; next < scopes.length && scopes[next].open === p; next++) {
        const s = scopes[next];
        if (s.loop && this.outlining) {
          let last = next + 1;
          while (last < scopes.length && scopes[last].open < s.close) last++;
          if (this.deferred && !this.chunk) this.deferLoop(r, s, scopes.slice(next + 1, last));
          else this.outline(r, s, scopes.slice(next + 1, last));
          next = last; p = s.close; outlined = true;
          break;
        }
        open.push(s); this.blk(s.label, s.loop);
      }
      if (outlined) continue;
      if (p < end) this.emitBlock(r.order[p]);
      p++;
    }
  }
  /** the loop in the method, left for its chunks at a fuel tick or once a loop inside it was */
  private deferLoop(r: Flow["regions"][number], scope: Flow["regions"][number]["scopes"][number], scopes: Flow["regions"][number]["scopes"]) {
    const c = this.code, after = "$after" + scope.label;
    this.push(after); c.block();
    this.push("$xfer" + scope.label); c.block();
    this.blk(scope.label, true, null, { nested: scopes.some((s) => s.loop) });
    this.emitSpan(r, scope.open, scope.close, scopes);
    this.endBlk(); c.br(this.depth(after));
    this.pop(); c.end();
    this.outline(r, scope, scopes);
    this.pop(); c.end();
  }
  private chunkReturn(status: number): void {
    this.code.i32(status).br(this.depth("$chunkReturn"));
  }
  private outline(r: Flow["regions"][number], scope: Flow["regions"][number]["scopes"][number], scopes: Flow["regions"][number]["scopes"]) {
    this.chunkCall(this.chunkBody(scope.label, () => {
      this.blk(scope.label, true);
      this.emitSpan(r, scope.open, scope.close, scopes);
      this.endBlk(); this.chunkReturn(0);
    }));
  }
  /** a function of its own for what `emit` emits, which returns a status (chunkCall) and takes and leaves the method's locals in the state struct */
  private chunkBody(label: string, emit: () => void, cycle?: number[]): NonNullable<MC["chunk"]> {
    const parent = this.code, nest = this.nest, outer = this.chunk;
    const body = new Code(this.root.nparams); body.localTypes = this.root.localTypes; body.nullableLocals = true; body.nonNullLocals = this.root.nonNullLocals; body.compactLocals = true;
    body.defer((c) => {
      c.raw(0x20, 0).lset(this.stateLocal);
      this.loadState(c, ch.locals);
    });
    if (this.chunkFuel < 0) this.chunkFuel = this.root.newLocal(T.i32);
    const ch = { code: body, label, count: parent.newLocal(T.i32), entry: parent.newLocal(T.i32), exits: [] as { pc: number; block: number; final: boolean }[], locals: [] as number[], f: -1, dispatch: -1, cycle };
    parent.locals.add(ch.entry);
    this.chunks.push(ch); this.code = body; this.nest = []; this.chunk = ch;
    this.push("$chunkReturn"); body.block(T.i32);
    this.push("$chunkCaught"); body.block(T.anyref);
    this.push("$chunkTry"); body.tryTable(null, [[0, this.cx.tag, 0]]);
    emit();
    this.pop(); body.end().unreachable();
    this.pop(); body.end().lset(this.excLocal); this.chunkReturn(3);
    this.pop(); body.end();
    if (this.cx.counting) this.cx.emitCount(body, this.m, ch.count);
    body.defer((c) => { this.saveState(c, ch.locals); c.ret(); });
    for (const l of body.locals) parent.locals.add(l);
    this.code = parent; this.nest = nest; this.chunk = outer;
    return ch;
  }
  /** calls the chunk until it is done, then goes where it says: the method returns or throws, or control continues at one of its exits (status 0 falls through) */
  private chunkCall(ch: NonNullable<MC["chunk"]>): void {
    const c = this.code;
    this.push("$chunkCall"); c.loop();
    c.i32(0).lset(ch.count);
    c.defer((c) => {
      c.lget(this.stateLocal).refIsNull().if_().gc(1, this.stateType).lset(this.stateLocal).end();
      this.saveState(c, ch.locals);
      // Charge the dispatcher and chunk only while their native frames are active.
      const weights = this.cx.emitEnter(c, ch.entry);
      const size = ch.code.localTypes.length;
      for (const at of weights) c.patch(at, 12 + size);
      c.lget(this.stateLocal).refAsNonNull().call(ch.dispatch).lset(this.controlLocal);
      this.cx.emitLeave(c, ch.entry, false);
      this.loadState(c, ch.locals);
    });
    c.lget(this.controlLocal).i32(1).raw(OP.i32_eq).brIf(0);
    c.lget(this.controlLocal).i32(2).raw(OP.i32_eq).if_(); this.push("if");
    if (this.resultLocal >= 0) c.lget(this.resultLocal);
    this.methodReturn(); this.pop(); c.end();
    c.lget(this.controlLocal).i32(3).raw(OP.i32_eq).if_().lget(this.excLocal).throw_(this.cx.tag).end();
    for (let i = 0; i < ch.exits.length; i++) {
      c.lget(this.controlLocal).i32(4 + i).raw(OP.i32_eq).if_(); this.push("if");
      const saved = this.block, exit = ch.exits[i]; this.block = exit.block;
      this.jump(exit.pc, exit.final); this.block = saved; this.pop(); c.end();
    }
    this.pop(); c.end();
  }
  private saveState(c: Code, locals: number[]): void {
    for (const i of locals) c.lget(this.stateLocal).refAsNonNull().lget(i, false).structSet(this.stateType, i);
  }
  private loadState(c: Code, locals: number[]): void {
    for (const i of locals) if (i !== this.controlLocal) c.lget(this.stateLocal).refAsNonNull().structGet(this.stateType, i).lset(i);
  }
  private methodReturn(): void {
    if (this.chunk) {
      if (this.resultLocal >= 0) this.code.lset(this.resultLocal);
      this.chunkReturn(2);
    } else {
      if (this.deferred && this.fuelLocal >= 0) this.cx.emitCount(this.code, this.m, this.fuelLocal);
      this.leave(); this.code.ret();
    }
  }
  emitBlock(b: number) {
    const flow = this.flow, c = this.code, inss = this.blockIns[b];
    this.block = b;
    if (this.tries) c.i32(inss[0].pc).lset(this.pcLocal);
    this.facts = cloneFacts(this.entryFacts[b]);
    for (const ins of inss) {
      this.emit(ins);
      step(this, ins, this.facts);
    }
    const last = inss[inss.length - 1];
    if (!endsBlock(last.op)) {
      const taken = last.op >= 0x32 && last.op <= 0x3d ? flow.blockAt[ifTarget(last)] : -1;
      const target = flow.fallTarget(b, taken);
      if (target >= 0) this.jump(flow.starts[target], true);
    }
  }
  jump(targetPc: number, final: boolean) {
    const flow = this.flow, c = this.code, v = flow.blockAt[targetPc];
    const go = flow.go(this.block, v, final);
    const label = go === Go.Continue ? "L" + targetPc : go === Go.Break ? "B" + targetPc : "$disp";
    if (go === Go.Dispatch && this.chunk?.cycle?.includes(this.regionOfPc.get(targetPc)!)) { c.i32(this.regionOfPc.get(targetPc)!).lset(this.regionLocal).br(this.depth("$cycleDisp")); return; }
    if (this.chunk && go !== Go.Next && !this.nest.includes(label)) {
      let i = this.chunk.exits.findIndex((e) => e.pc === targetPc && e.block === this.block && e.final === final);
      if (i < 0) { i = this.chunk.exits.length; this.chunk.exits.push({ pc: targetPc, block: this.block, final }); }
      this.chunkReturn(4 + i); return;
    }
    switch (go) {
      case Go.Next: return;
      case Go.Break: c.br(this.depth("B" + targetPc)); return;
      case Go.Continue: c.br(this.depth("L" + targetPc)); return;
      case Go.Dispatch: {
        const ri = this.regionOfPc.get(targetPc); if (ri === undefined) throw new Error("dispatch to non-entry " + targetPc);
        c.i32(ri).lset(this.regionLocal).br(this.depth("$disp")); return;
      }
    }
  }
  emitCatch() {
    const c = this.code;
    if (this.entryDepth >= 0) this.weights.push(...this.cx.emitLeave(c, this.entryDepth, true));
    const dispatchTo = (addr: number) => { const ri = this.regionOfPc.get(addr); if (ri === undefined) throw new Error("handler not region entry"); c.i32(ri).lset(this.regionLocal).br(this.depth("$disp")); };
    if (this.item.tries.some(t => t.handlers.length > 0)) {
      const target = c.newLocal(T.i32);
      const args = () => c.i32(this.cx.idOf(this.m.cls)).i32(this.m.index).lget(this.pcLocal).lget(this.excLocal).externConvertAny();
      emitRestored(this.cx, c, [], [T.i32], () => {
        c.call(this.cx.imp.catchSync).if_(T.i32); args(); c.call(this.cx.imp.catchBlock);
        c.else_(); args(); c.call(this.cx.imp.catchBlockWait); c.end();
      });
      c.lset(target);
      const targets = new Set(this.item.tries.flatMap(t => [...t.handlers.map(h => h[1]), ...t.catchAllAddr >= 0 ? [t.catchAllAddr] : []]));
      for (const addr of targets) {
        c.lget(target).i32(addr).raw(OP.i32_eq).if_(); this.push("if"); dispatchTo(addr); this.pop(); c.end();
      }
      return;
    }
    for (const t of this.item.tries) {
      c.lget(this.pcLocal).i32(t.start).raw(OP.i32_ge_s).lget(this.pcLocal).i32(t.end).raw(OP.i32_lt_s).raw(OP.i32_and).if_(); this.push("if");
      if (t.catchAllAddr >= 0) dispatchTo(t.catchAllAddr);
      this.pop(); c.end();
    }
  }
  /** whether the class of type `desc` is not loaded: the site then throws what ART throws, and nothing after it runs */
  unresolved(desc: string): boolean {
    const f = typeFailure(this.cx.prog, desc);
    if (f) this.linkFail(f);
    return !!f;
  }
  linkFail(f: LinkFailure) { this.cx.linkError(this.code, f); }
  /** push a non-null (ref null $Obj) of register `reg`, throwing NPE when null */
  nonNull(reg: number) {
    const c = this.code, cx = this.cx;
    if (this.facts.nonNull.has(this.useWeb(reg))) { this.get("L", reg); return; }
    this.get("L", reg); c.refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); this.get("L", reg);
  }
  /** emit "ensure class initialized", unless an earlier instruction on every path to here has */
  ensure(cls: string) { this.cx.emitEnsure(this.code, cls, this.facts.inited); }
  private initedAt = new Map<number, readonly string[]>();
  /** the classes whose initialization `ins` requests, as its translation does: its target and the target's superclasses */
  initedBy(ins: Ins): readonly string[] {
    const op = ins.op;
    if (op !== 0x22 && (op < 0x60 || op > 0x6d) && op !== 0x71 && op !== 0x77) return NONE; // new-instance, sget/sput, invoke-static
    let r = this.initedAt.get(ins.pc);
    if (!r) { const cls = this.ensureTarget(ins); this.initedAt.set(ins.pc, r = cls ? this.cx.prog.chain(cls) : []); }
    return r;
  }
  private ensureTarget(ins: Ins): string | undefined {
    if (this.deferredSite(ins)) return undefined;
    if (ins.op === 0x22) { const name = this.dex.typeName(ins.b); return this.cx.str.isString(name) ? undefined : name; }
    if (ins.op <= 0x6d) { const r = this.fieldOf(ins.b, true); return failed(r) ? undefined : r.f.owner; }
    const mr = this.dex.method(ins.b), decl = this.dex.typeName(mr.cls);
    return this.cx.prog.resolve(decl[0] === "[" ? "java/lang/Object" : decl, mr.name, this.dex.methodDesc(ins.b))?.cls;
  }
  isStringInit(ins: Ins): boolean {
    const mr = this.dex.method(ins.b);
    return mr.name === "<init>" && this.cx.str.isString(this.dex.typeName(mr.cls));
  }
  /** whether the register `ins` defines surely holds a reference: an allocation, a constant, the exception caught, or a copy of one */
  definesNonNull(ins: Ins, f: Facts): boolean {
    const op = ins.op;
    if (op === 0x22) return !this.cx.str.isString(this.dex.typeName(ins.b)); // new-instance
    // const-string, const-string/jumbo, const-class, new-array, move-exception
    if ((op >= 0x1a && op <= 0x1c) || op === 0x23 || op === 0x0d) return true;
    // move-object, move-object/from16, move-object/16, check-cast
    if ((op >= 0x07 && op <= 0x09) || op === 0x1f) { const w = this.typing.use(ins.pc, op === 0x1f ? ins.a : ins.b); return w >= 0 && f.nonNull.has(w); }
    return false;
  }
  /** the shadow key (see facts.ts) of the field access `ins` if its object is cast more than once in the method, else undefined */
  private shadowAt = new Map<number, string | undefined>();
  shadowKey(ins: Ins): string | undefined {
    if (!this.shadowKeys.size || !isFieldAccess(ins.op)) return undefined;
    if (this.shadowAt.has(ins.pc)) return this.shadowAt.get(ins.pc);
    const key = this.findShadowKey(ins);
    this.shadowAt.set(ins.pc, key);
    return key;
  }
  private findShadowKey(ins: Ins): string | undefined {
    if (this.deferredSite(ins)) return undefined;
    const w = this.typing.use(ins.pc, ins.b);
    if (w < 0) return undefined;
    const r = this.fieldOf(ins.c, false);
    if (failed(r)) return undefined;
    const key = `${w}:${this.cx.structFor(r.decl)}`;
    return this.shadowKeys.has(key) ? key : undefined;
  }
  private findShadows() {
    const seen = new Set<string>();
    for (const ins of this.prepared.instructions) {
      if (!isFieldAccess(ins.op) || this.deferredSite(ins)) continue;
      const w = this.typing.use(ins.pc, ins.b);
      if (w < 0) continue;
      const r = this.fieldOf(ins.c, false);
      if (failed(r)) continue;
      const key = `${w}:${this.cx.structFor(r.decl)}`;
      if (seen.has(key)) this.shadowKeys.add(key); else seen.add(key);
    }
  }
  refTo(reg: number, struct: number) {
    const c = this.code, key = `${this.useWeb(reg)}:${struct}`;
    let local = this.shadows.get(key);
    if (this.facts.typed.has(key) && local !== undefined) { c.lget(local); return; }
    this.nonNull(reg); c.refCast(struct);
    if (this.shadowKeys.has(key)) { if (local === undefined) this.shadows.set(key, local = c.newLocal(refNull(struct))); c.ltee(local); }
  }

  // ---------- instruction emission
  emit(ins: Ins) {
    const c = this.code;
    if (this.consumed.has(ins.pc)) return;
    this.cur = ins; c.pc = ins.pc;
    if (!this.typing.reached(ins.pc)) { c.unreachable(); return; }
    if (emitSymbolicSite(this, ins)) return;
    this.emitOperation(ins);
  }

  protected copyReference(reg: number): void {
    const def = this.typing.def(this.cur.pc);
    if (def >= 0 && def !== this.useWeb(reg)) { this.get("L", reg); this.set("L"); }
  }

  protected emitOperation(ins: Ins): void {
    const op = ins.op;
    if (op >= 0x44 && op <= 0x6d) {
      if (op <= 0x4a) return this.emitAget(ins);
      if (op <= 0x51) return this.emitAput(ins);
      if (op <= 0x58) return this.emitIget(ins);
      if (op <= 0x5f) return this.emitIput(ins);
      return this.emitStatic(ins);
    }
    if (isInvoke(op)) return this.emitInvoke(ins);
    if (op >= 0x7b && op <= 0xe2) return this.emitArith(ins);
    const n = ins.name, c = this.code, cx = this.cx, dex = this.dex, a = ins.a, b = ins.b;
    switch (n) {
      case "nop": return;
      case "move": case "move/from16": case "move/16": case "move-wide": case "move-wide/from16": case "move-wide/16":
      case "move-object": case "move-object/from16": case "move-object/16": {
        if (this.typing.def(ins.pc) < 0) return;
        if (this.load(b) !== this.typing.kind[this.typing.def(ins.pc)]) throw new Error(`move between kinds at ${ins.pc}`);
        this.store(ins); return;
      }
      case "move-result": case "move-result-wide": case "move-result-object": throw new Error("move-result without invoke at " + ins.pc);
      case "move-exception": c.lget(this.excLocal); this.set("L"); return;
      case "return-void": this.methodReturn(); return;
      case "return": this.get("I", a); this.methodReturn(); return;
      case "return-wide": this.get("J", a); this.methodReturn(); return;
      case "return-object": this.get("L", a); this.methodReturn(); return;
      case "const/4": case "const/16": case "const": this.constNarrow(b); return;
      case "const/high16": this.constNarrow(b << 16); return;
      case "const-wide/16": case "const-wide/32": this.constWide(BigInt(b)); return;
      case "const-wide": this.constWide(ins.wideLit); return;
      case "const-wide/high16": this.constWide(BigInt(b) << 48n); return;
      case "const-class": if (this.unresolved(dex.type(b))) return; constClass(cx, c, dex.typeName(b)); this.set("L"); return;
      case "const-string": case "const-string/jumbo": cx.str.literal(c, dex.string(b)); this.set("L"); return;
      case "const-method-handle": emitHandleConstant(this, b); return;
      case "const-method-type": emitTypeConstant(this, b); return;
      case "monitor-enter": case "monitor-exit": this.nonNull(a); this.monitor(ins.name === "monitor-enter"); return;
      case "check-cast": {
        if (this.unresolved(dex.type(b))) return;
        const name = dex.typeName(b);
        if (name === "java/lang/Object") { this.copyReference(a); return; }
        this.get("L", a); cx.emitCast(c, name); this.set("L"); return;
      }
      case "instance-of": if (this.unresolved(dex.type(ins.c))) return; this.get("L", ins.b); cx.emitInstanceOf(c, dex.typeName(ins.c)); this.set("I"); return;
      case "array-length": this.arrayLength(b); this.set("I"); return;
      case "new-instance": {
        if (this.unresolved(dex.type(b))) return;
        const name = dex.typeName(b);
        // a String is made by the constructor call, which assigns its register
        if (cx.str.isString(name)) c.anyNull(); else { this.ensure(name); cx.emitNew(c, name); }
        this.set("L"); return;
      }
      case "new-array": {
        if (this.unresolved(dex.type(ins.c))) return;
        cx.emitNewArray(c, dex.type(ins.c), () => this.get("I", ins.b)); this.set("L"); return;
      }
      case "filled-new-array": case "filled-new-array/range": {
        const desc = dex.type(b), ek = elemKindOf(desc);
        if (this.unresolved(desc)) { this.consumeResult(ins); return; }
        c.gget(cx.vtGlobal(desc)).refAsNonNull().i64(0n);
        for (const r of ins.regs) { ek === "ref" ? this.get("L", r) : this.get("I", r); }
        c.arrayNewFixed(cx.tData[ek], ins.regs.length).structNew(cx.tArr[ek]);
        this.finishResult(ins, "L"); return;
      }
      case "fill-array-data": {
        const payload = ins.pc + b, insns = this.item.insns, width = insns[payload + 1], count = insns[payload + 2] | (insns[payload + 3] << 16);
        const bytes = new Uint8Array(insns.buffer, insns.byteOffset + (payload + 4) * 2, width * count).slice();
        const seg = cx.mb.addDataPassive(bytes);
        const ek: ElemKind = width === 1 ? "i8" : width === 2 ? "i16" : width === 4 ? "i32" : "i64";
        this.nonNull(a); c.refCast(cx.tArr[ek]).structGet(cx.tArr[ek], 2).i32(0)
          .i32(0).i32(count).arrayNewData(cx.tData[ek], seg).i32(0).i32(count).arrayCopy(cx.tData[ek], cx.tData[ek]);
        return;
      }
      case "throw": this.nonNull(a); c.throw_(cx.tag); return;
      case "goto": case "goto/16": case "goto/32": this.jump(ins.pc + a, true); return;
      case "packed-switch": case "sparse-switch": this.emitSwitch(ins); return;
      case "cmpl-float": this.f32(b); this.f32(ins.c); c.call(cx.helper("cmplf")); this.set("I"); return;
      case "cmpg-float": this.f32(b); this.f32(ins.c); c.call(cx.helper("cmpgf")); this.set("I"); return;
      case "cmpl-double": this.f64(b); this.f64(ins.c); c.call(cx.helper("cmpld")); this.set("I"); return;
      case "cmpg-double": this.f64(b); this.f64(ins.c); c.call(cx.helper("cmpgd")); this.set("I"); return;
      case "cmp-long": this.get("J", b); this.get("J", ins.c); c.raw(0x55); this.get("J", b); this.get("J", ins.c); c.raw(OP.i64_lt_s).raw(OP.i32_sub); this.set("I"); return;
      case "if-eq": case "if-ne": case "if-eqz": case "if-nez": case "if-lt": case "if-ge": case "if-gt": case "if-le":
      case "if-ltz": case "if-gez": case "if-gtz": case "if-lez": this.emitIf(ins); return;
    }
    this.emitArith(ins);
  }
  private monObj = -1; private monHdr = -1;
  /** monitor-enter or -exit of the object on the stack: the uncontended lock of a free object, and the release of a lock held once, inline; the rest is the helper's (j2w.ts menter) */
  private monitor(enter: boolean) {
    const c = this.code, cx = this.cx, tObj = cx.tObj;
    if (this.monObj < 0) { this.monObj = c.newLocal(ref(tObj)); this.monHdr = c.newLocal(T.i64); }
    const o = this.monObj, w = this.monHdr, tok = () => c.gget(cx.global("rt", "sid", T.i32, true)).i32(8).raw(OP.i32_shl).i32(1).raw(OP.i32_or);
    c.lset(this.tmpL).lget(this.tmpL).refCast(tObj).lset(o).lget(o).structGet(tObj, 1).ltee(w).raw(OP.i32_wrap_i64);
    if (enter) c.raw(OP.i32_eqz); else { tok(); c.raw(OP.i32_eq); }
    c.if_();
    c.lget(o).lget(w);
    if (enter) tok().raw(OP.i64_extend_i32_u, OP.i64_add); else c.lget(w).raw(OP.i32_wrap_i64, OP.i64_extend_i32_u, OP.i64_sub);
    c.structSet(tObj, 1).else_().lget(this.tmpL).call(cx.helper(enter ? "menter" : "mexit")).end();
  }
  /** a 32-bit constant: an int, float bits, or (zero) null, as its web's kind says */
  constNarrow(v: number) {
    const w = this.typing.def(this.cur.pc), c = this.code;
    if (w < 0) return;
    const k = this.typing.kind[w];
    if (k === KR) { if (v) throw new Error(`reference constant ${v} at ${this.cur.pc}`); c.anyNull(); }
    else if (k === KF) c.f32const(v);
    else c.i32(v);
    this.store(this.cur);
  }
  constWide(v: bigint) {
    const w = this.typing.def(this.cur.pc);
    if (w < 0) return;
    this.typing.kind[w] === KD ? this.code.f64const(v) : this.code.i64(v);
    this.store(this.cur);
  }
  arrayLength(reg: number) {
    const cx = this.cx, c = this.code;
    // arrays of all kinds: dispatch on the wrapper type (the verifier gives no static element type here)
    this.nonNull(reg); c.lset(this.tmpL);
    const kinds: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      if (i < kinds.length - 1) c.lget(this.tmpL).refTest(cx.tArr[k]).if_(T.i32);
      c.lget(this.tmpL).refCast(cx.tArr[k]).structGet(cx.tArr[k], 2).arrayLen();
      if (i < kinds.length - 1) c.else_();
    }
    for (let i = 0; i < kinds.length - 1; i++) c.end();
  }
  elemOf(name: string): { k: ElemKind; sign: "s" | "u" | "" } {
    switch (name) {
      case "aget": case "aput": return { k: "i32", sign: "" };
      case "aget-wide": case "aput-wide": return { k: "i64", sign: "" };
      case "aget-object": case "aput-object": return { k: "ref", sign: "" };
      case "aget-boolean": case "aput-boolean": return { k: "i8", sign: "u" };
      case "aget-byte": case "aput-byte": return { k: "i8", sign: "s" };
      case "aget-char": case "aput-char": return { k: "i16", sign: "u" };
      default: return { k: "i16", sign: "s" };
    }
  }
  /** the local of each element kind that holds the data array of the array being accessed */
  dataLocal = new Map<ElemKind, number>();
  dloc(k: ElemKind): number { let l = this.dataLocal.get(k); if (l === undefined) { l = this.code.newLocal(ref(this.cx.tData[k])); this.dataLocal.set(k, l); } return l; }
  idxCheck(k: ElemKind, idxReg: number) {
    const c = this.code, d = this.dloc(k);
    this.get("I", idxReg); c.lget(d).arrayLen().raw(OP.i32_ge_u).if_();
    this.get("I", idxReg); c.lget(d).arrayLen(); this.cx.callThrower(c, "aioobe"); c.end();
  }
  emitAget(ins: Ins) {
    const c = this.code, cx = this.cx, { k, sign } = this.elemOf(ins.name), d = this.dloc(k);
    this.nonNull(ins.b); c.refCast(cx.tArr[k]).structGet(cx.tArr[k], 2).lset(d);
    this.idxCheck(k, ins.c);
    c.lget(d); this.get("I", ins.c);
    sign === "s" ? c.arrayGetS(cx.tData[k]) : sign === "u" ? c.arrayGetU(cx.tData[k]) : c.arrayGet(cx.tData[k]);
    this.set(k === "ref" ? "L" : k === "i64" ? "J" : "I");
  }
  emitAput(ins: Ins) {
    const c = this.code, cx = this.cx, { k } = this.elemOf(ins.name);
    // a static initializer runs once, and its long array literals take the engine longer to compile than to run: their stores are a call
    if (this.m.name === "<clinit>") {
      this.nonNull(ins.b); this.get("I", ins.c); this.get(k === "ref" ? "L" : k === "i64" ? "J" : "I", ins.a);
      c.call(cx.helper("aput:" + k));
      return;
    }
    const d = this.dloc(k);
    this.nonNull(ins.b); c.lset(this.tmpL);
    c.lget(this.tmpL).refCast(cx.tArr[k]).structGet(cx.tArr[k], 2).lset(d);
    this.idxCheck(k, ins.c);
    if (k === "ref") emitStoreCheck(cx, c, this.tmpL, () => this.get("L", ins.a));
    c.lget(d); this.get("I", ins.c);
    this.get(k === "ref" ? "L" : k === "i64" ? "J" : "I", ins.a);
    c.arraySet(cx.tData[k]);
  }
  fieldOf(idx: number, isStatic: boolean) { return this.resolved(8 * idx + 4 + +isStatic, () => resolveFieldRef(this.cx.prog, this.dex, idx, isStatic, this.m.cls)); }
  /** the method invoke `kind` of method reference `idx` names; invoke-super's depends on the caller */
  private invokeTarget(idx: number, kind: string, declared: string, name: string, desc: string): MethodInfo | LinkFailure {
    const resolve = () => resolveInvoke(this.cx.prog, kind, declared, name, desc, this.m.cls), use = INVOKE_USE[kind];
    return use === undefined ? resolve() : this.resolved(8 * idx + use, resolve);
  }
  /** a resolution of a reference of this method's dex: what succeeded is the same for every caller while the Program's classes hold (Program.refMemo), a failure names its caller */
  private resolved<T extends object>(key: number, resolve: () => T): T {
    const memo = this.cx.prog.refMemo;
    let refs = memo.get(this.dex);
    if (!refs) memo.set(this.dex, refs = new Map());
    let r = refs.get(key) as T | undefined;
    if (r === undefined) { r = resolve(); if (!failed(r)) refs.set(key, r); }
    return r;
  }
  emitIget(ins: Ins) {
    const cx = this.cx, c = this.code, r = this.fieldOf(ins.c, false);
    if (failed(r)) return this.linkFail(r);
    const { decl, f } = r, st = cx.structFor(decl);
    cx.str.noFields(decl, f.name);
    this.refTo(ins.b, st); c.structGet(st, cx.fieldIndex(decl, f)); this.set(f.kind);
  }
  emitIput(ins: Ins) {
    const cx = this.cx, c = this.code, r = this.fieldOf(ins.c, false);
    if (failed(r)) return this.linkFail(r);
    const { decl, f } = r, st = cx.structFor(decl);
    cx.str.noFields(decl, f.name);
    this.refTo(ins.b, st); this.get(f.kind, ins.a); c.structSet(st, cx.fieldIndex(decl, f));
    if (cx.w.claims(f)) { this.refTo(ins.b, st); c.externConvertAny(); this.get("J", ins.a); c.call(cx.imp.claim); }
  }
  emitStatic(ins: Ins) {
    const cx = this.cx, c = this.code, put = ins.name.startsWith("sput"), r = this.fieldOf(ins.b, true);
    if (failed(r)) return this.linkFail(r);
    const { f } = r;
    this.ensure(f.owner);
    const g = cx.staticGlobal(f.owner, f.name, f.desc);
    if (put) { this.get(f.kind, ins.a); c.gset(g); } else { c.gget(g); this.set(f.kind); }
  }
  emitIf(ins: Ins) {
    const c = this.code, flow = this.flow, target = ifTarget(ins), n = ins.name;
    const refA = (n === "if-eq" || n === "if-ne" || n === "if-eqz" || n === "if-nez") && this.kindOf(ins.a) === KR;
    const cond = () => {
      switch (n) {
        case "if-eq": case "if-ne":
          if (refA) { this.get("L", ins.a); this.get("L", ins.b); c.call(this.cx.helper("acmp")); } else { this.get("I", ins.a); this.get("I", ins.b); c.raw(OP.i32_eq); }
          if (n === "if-ne") c.raw(OP.i32_eqz); return;
        case "if-eqz": case "if-nez":
          if (refA) { this.get("L", ins.a); c.refIsNull(); } else { this.get("I", ins.a); c.raw(OP.i32_eqz); }
          if (n === "if-nez") c.raw(OP.i32_eqz); return;
        case "if-lt": this.get("I", ins.a); this.get("I", ins.b); c.raw(OP.i32_lt_s); return;
        case "if-ge": this.get("I", ins.a); this.get("I", ins.b); c.raw(OP.i32_ge_s); return;
        case "if-gt": this.get("I", ins.a); this.get("I", ins.b); c.raw(OP.i32_gt_s); return;
        case "if-le": this.get("I", ins.a); this.get("I", ins.b); c.raw(OP.i32_le_s); return;
        case "if-ltz": this.get("I", ins.a); c.i32(0).raw(OP.i32_lt_s); return;
        case "if-gez": this.get("I", ins.a); c.i32(0).raw(OP.i32_ge_s); return;
        case "if-gtz": this.get("I", ins.a); c.i32(0).raw(OP.i32_gt_s); return;
        case "if-lez": this.get("I", ins.a); c.i32(0).raw(OP.i32_le_s); return;
      }
    };
    const fall = ins.pc + ins.len;
    if (flow.blockAt[target] === flow.blockAt[fall]) return;
    cond();
    if (flow.inverted.has(this.block)) { c.raw(OP.i32_eqz).if_(); this.push("if"); this.jump(fall, false); }
    else { c.if_(); this.push("if"); this.jump(target, false); }
    this.pop(); c.end();
  }
  emitSwitch(ins: Ins) {
    const c = this.code, cases = switchCases(this.item, ins), flow = this.flow;
    const lo = Math.min(...cases.map(([k]) => k)), hi = Math.max(...cases.map(([k]) => k));
    // keys dense enough make a jump table, when every target is a label (a hole and the fall-through go to the end of the block)
    const labelled = cases.every(([, t]) => { const g = flow.go(this.block, flow.blockAt[t], false); return g === Go.Break ? this.nest.includes("B" + t) : g === Go.Continue && this.nest.includes("L" + t); });
    if (cases.length >= 4 && hi - lo < 4 * cases.length && labelled) {
      const target = new Map(cases);
      this.push("$sw"); c.block();
      this.get("I", ins.a); c.i32(lo).raw(OP.i32_sub);
      c.brTable(Array.from({ length: hi - lo + 1 }, (_, i) => {
        const t = target.get(lo + i);
        return t === undefined ? 0 : this.depth((flow.go(this.block, flow.blockAt[t], false) === Go.Break ? "B" : "L") + t);
      }), 0);
      this.pop(); c.end();
      return;
    }
    // sparse keys: a binary search down to runs of at most three compares
    const sorted = [...cases].sort((x, y) => x[0] - y[0]);
    const search = (from: number, to: number) => {
      if (to - from > 3) {
        const mid = (from + to + 1) >> 1;
        this.get("I", ins.a); c.i32(sorted[mid][0]).raw(OP.i32_lt_s).if_(); this.push("if"); search(from, mid - 1); this.pop(); c.else_(); this.push("if"); search(mid, to); this.pop(); c.end();
        return;
      }
      for (const [key, target] of sorted.slice(from, to + 1)) {
        this.get("I", ins.a); c.i32(key).raw(OP.i32_eq).if_(); this.push("if"); this.jump(target, false); this.pop(); c.end();
      }
    };
    search(0, sorted.length - 1);
  }
  finishResult(ins: Ins, kind: Kind | "V") {
    // fold a following move-result into the producer
    if (kind === "V") return;
    const c = this.code, nx = this.moveResult(ins);
    if (nx) { this.consumed.add(nx.pc); this.set(kind, nx); }
    else c.drop();
  }
  /** an invoke the compiler cannot translate: the code after it is dead, so a move-result stays unwritten */
  invokeGap(ins: Ins, why: string) {
    this.consumeResult(ins);
    this.cx.gap(this.code, `${mid(this.m)}: ${why}`);
  }
  consumeResult(ins: Ins) {
    const nx = this.moveResult(ins);
    if (nx) this.consumed.add(nx.pc);
  }
  /** the move-result that follows `ins`, if one does */
  private moveResult(ins: Ins): Ins | undefined {
    const insts = this.prepared.instructions, pc = ins.pc + ins.len;
    let lo = 0, hi = insts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (insts[mid].pc < pc) lo = mid + 1; else hi = mid; }
    const nx = insts[lo];
    return nx?.pc === pc && nx.op >= 0x0a && nx.op <= 0x0c ? nx : undefined;
  }
  emitInvoke(ins: Ins) {
    const cx = this.cx, c = this.code, dex = this.dex, prog = cx.prog;
    const kind = ins.name.replace("/range", "");
    if (kind === "invoke-custom") return emitCustom(this, ins);
    if (kind === "invoke-polymorphic") return emitPolymorphic(this, ins);
    const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), declared = dex.typeName(mr.cls), key = mr.name + desc;
    // an array's methods are Object's, except clone, which copies the array
    const decl = declared[0] === "[" ? "java/lang/Object" : declared;
    const p = dex.methodTypes(ins.b), retK: Kind | "V" = p.ret === "V" ? "V" : kindOf(p.ret);
    const isStatic = kind === "invoke-static";
    const sigIdx = () => cx.descSig(desc, isStatic);
    if (declared !== decl && key === "clone()Ljava/lang/Object;") { this.nonNull(ins.regs[0]); cx.callRt(c, "aclone"); this.finishResult(ins, "L"); return; }
    const target = this.invokeTarget(ins.b, kind, declared, mr.name, desc);
    if (failed(target)) { this.consumeResult(ins); this.linkFail(target); return; }
    const site = this.sites.has(String(ins.pc));
    if (site) this.enterSite();
    const wrap = (key: string, emit: () => void) => { const on = this.sites.has(`${ins.pc}:${key}`); if (on) this.enterSite(); emit(); if (on) this.leaveSite(); };
    if (isStatic) {
      this.ensure(target.cls); pushArgs(this, ins, p.params, 0); cx.callMethod(c, target);
    } else if (kind === "invoke-direct" && cx.str.isString(decl) && mr.name === "<init>") {
      const make = cx.str.factory(desc);
      if (make === undefined) { this.invokeGap(ins, `String.<init>${desc}`); return; }
      pushArgs(this, ins, p.params); c.call(make); if (site) this.leaveSite(); c.lset(this.local(this.useWeb(ins.regs[0]))); return;
    } else if (kind === "invoke-direct" || kind === "invoke-super") {
      this.nonNull(ins.regs[0]); pushArgs(this, ins, p.params); cx.callMethod(c, target);
    } else {
      // A native callback can load an override while this activation is still running.
      const declC = prog.get(decl);
      // the slot the receiver's class gives the method; a call that expects one of the likely implementations tests for it first, so the engine can inline it
      const guards = this.callGuards(ins);
      this.nonNull(ins.regs[0]); c.lset(this.tmpL);
      c.lget(this.tmpL); pushArgs(this, ins, p.params);
      c.lget(this.tmpL); cx.str.vtab(c, decl);
      if (declC && !declC.isInterface) {
        c.i32(cx.w.vslot(decl, target.key)).arrayGet(cx.tVT);
      } else if (prog.get("java/lang/Object")!.byKey.has(target.key)) {
        c.i32(cx.w.vslot("java/lang/Object", target.key)).arrayGet(cx.tVT);
      } else {
        const sel = cx.w.selectorId(target.key), s = sel % H.IMT_N;
        // fn = vt[IMT+2s] == sel ? vt[IMT+2s+1] : imtslow(vt, sel)
        const vtl = this.vtLocal();
        c.lset(vtl);
        c.lget(vtl).i32(H.IMT + 2 * s).arrayGet(cx.tVT).i32(sel).raw(OP.i32_eq).if_(T.i32)
          .lget(vtl).i32(H.IMT + 2 * s + 1).arrayGet(cx.tVT).else_()
          .lget(vtl).i32(sel).call(cx.helper("imtslow")).end();
      }
      // the receiver and arguments stay on the stack under the tests: a guard takes them as block parameters instead of repeating them
      if (guards.length) {
        const slot = this.slotLocal(), type = sigIdx();
        c.lset(slot);
        for (const g of guards) { c.lget(slot).i32(cx.w.slotOf(g)).raw(OP.i32_eq).ifType(type); wrap(mid(g), () => cx.callMethod(c, g)); c.else_(); }
        c.lget(slot); wrap("f", () => c.callIndirect(type));
        for (const _ of guards) c.end();
      } else c.callIndirect(sigIdx());
    }
    if (site) this.leaveSite();
    this.finishResult(ins, retK);
  }
  slotl = -1;
  slotLocal() { if (this.slotl < 0) this.slotl = this.code.newLocal(T.i32); return this.slotl; }
  vtl = -1;
  vtLocal() { if (this.vtl < 0) this.vtl = this.code.newLocal(ref(this.cx.tVT)); return this.vtl; }

  emitArith(ins: Ins) {
    const c = this.code, n = ins.name, a = ins.a, b = ins.b, cx = this.cx;
    type K = "I" | "J" | "F" | "D";
    const un = (from: K, to: K, f: () => void) => {
      from === "F" ? this.f32(b) : from === "D" ? this.f64(b) : this.get(from, b);
      f();
      to === "F" ? this.setF32() : to === "D" ? this.setF64() : this.set(to);
    };
    switch (n) {
      case "neg-int": c.i32(0); this.get("I", b); c.raw(OP.i32_sub); this.set("I"); return;
      case "not-int": this.get("I", b); c.i32(-1).raw(OP.i32_xor); this.set("I"); return;
      case "neg-long": c.i64(0n); this.get("J", b); c.raw(OP.i64_sub); this.set("J"); return;
      case "not-long": this.get("J", b); c.i64(-1n).raw(OP.i64_xor); this.set("J"); return;
      case "neg-float": un("F", "F", () => c.raw(OP.f32_neg)); return;
      case "neg-double": un("D", "D", () => c.raw(OP.f64_neg)); return;
      case "int-to-long": un("I", "J", () => c.raw(OP.i64_extend_i32_s)); return;
      case "int-to-float": un("I", "F", () => c.raw(OP.f32_convert_i32_s)); return;
      case "int-to-double": un("I", "D", () => c.raw(OP.f64_convert_i32_s)); return;
      case "long-to-int": un("J", "I", () => c.raw(OP.i32_wrap_i64)); return;
      case "long-to-float": un("J", "F", () => c.raw(OP.f32_convert_i64_s)); return;
      case "long-to-double": un("J", "D", () => c.raw(OP.f64_convert_i64_s)); return;
      case "float-to-int": un("F", "I", () => c.satTrunc(0)); return;
      case "float-to-long": un("F", "J", () => c.satTrunc(4)); return;
      case "float-to-double": un("F", "D", () => c.raw(OP.f64_promote_f32)); return;
      case "double-to-int": un("D", "I", () => c.satTrunc(2)); return;
      case "double-to-long": un("D", "J", () => c.satTrunc(6)); return;
      case "double-to-float": un("D", "F", () => c.raw(OP.f32_demote_f64)); return;
      case "int-to-byte": un("I", "I", () => c.raw(OP.i32_extend8_s)); return;
      case "int-to-char": un("I", "I", () => c.i32(0xffff).raw(OP.i32_and)); return;
      case "int-to-short": un("I", "I", () => c.raw(OP.i32_extend16_s)); return;
    }
    const two = n.endsWith("/2addr"), lit = n.includes("/lit") || n === "rsub-int";
    const base = n.replace("/2addr", "").replace("/lit16", "").replace("/lit8", "");
    const xr = two ? a : b, yr = two ? b : ins.c;
    const type = base.endsWith("-int") || base === "rsub-int" ? "int" : base.endsWith("-long") ? "long" : base.endsWith("-float") ? "float" : "double";
    const opn = base.replace(/-(int|long|float|double)$/, "");
    const X = () => type === "int" ? this.get("I", xr) : type === "long" ? this.get("J", xr) : type === "float" ? this.f32(xr) : this.f64(xr);
    const Y = () => {
      if (lit) { type === "int" ? c.i32(ins.c) : c.i64(BigInt(ins.c)); return; }
      type === "int" ? this.get("I", yr) : type === "long" ? this.get("J", yr) : type === "float" ? this.f32(yr) : this.f64(yr);
    };
    const fin = () => (type === "float" ? this.setF32() : this.setF64());
    if (type === "int") {
      if (n.startsWith("rsub-int")) { c.i32(ins.c); this.get("I", b); c.raw(OP.i32_sub); this.set("I"); return; }
      if (opn === "div" || opn === "rem") {
        const direct = lit && ins.c !== 0 && ins.c !== -1;
        X(); Y();
        if (direct) c.raw(opn === "div" ? OP.i32_div_s : OP.i32_rem_s); else c.call(cx.helper(opn === "div" ? "idiv" : "irem"));
        this.set("I"); return;
      }
      X(); Y(); c.raw(INT_OPS[opn]); this.set("I"); return;
    }
    if (type === "long") {
      if (opn === "shl" || opn === "shr" || opn === "ushr") {
        X(); this.get("I", yr); c.raw(OP.i64_extend_i32_u, opn === "shl" ? OP.i64_shl : opn === "shr" ? OP.i64_shr_s : OP.i64_shr_u); this.set("J"); return;
      }
      if (opn === "div" || opn === "rem") { X(); Y(); c.call(cx.helper(opn === "div" ? "ldiv" : "lrem")); this.set("J"); return; }
      X(); Y(); c.raw(LONG_OPS[opn]); this.set("J"); return;
    }
    // float/double
    if (opn === "rem") {
      if (type === "float") { X(); c.raw(OP.f64_promote_f32); Y(); c.raw(OP.f64_promote_f32).call(cx.imp.fmod).raw(OP.f32_demote_f64); }
      else { X(); Y(); c.call(cx.imp.fmod); }
      fin(); return;
    }
    X(); Y(); c.raw((type === "float" ? FLOAT_OPS : DOUBLE_OPS)[opn]); fin();
  }
}

/** pushes the arguments of `params` from the invoke's registers, the first at `ins.regs[ri]` (past the receiver unless it is 0) */
function pushArgs(mc: MC, ins: Ins, params: string[], ri = 1) {
  for (const pt of params) { mc.get(kindOf(pt), ins.regs[ri]); ri += isWide(pt) ? 2 : 1; }
}
