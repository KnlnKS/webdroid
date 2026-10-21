// Loop outlining (G4): loops and dispatch cycles (strong components of the regions) run in functions of their own, chunks, re-entered every
// CHUNK iterations, so a long activation reaches the engine's optimized code. A chunk takes and leaves the method's locals in a state struct
// and answers a ChunkStatus; each chunk has a dispatcher that calls it until it is done and charges its iterations to the activation's fuel.
// The first tier starts a loop in the method and moves it to its chunks at a fuel tick (and the loops around it at their next iteration), so
// a short loop costs neither the state of an activation nor the engine's compiling of two more functions. The second tier runs code that has
// already been hot: its loops stay in the method, unless the first tier saw one run LONG_ROUNDS chunks in one entry (World.longLoops).
import { Code, OP } from "./code.ts";
import { T, ref, refNull, uleb, type VT } from "./wasmbin.ts";
import { kindOf, mid } from "./program.ts";
import { type Flow, Go } from "./structure.ts";
import { CHUNK_MARK, COUNT_SLOTS } from "./exc.ts";
import { FUEL } from "./hostcalls.ts";
import type { MC } from "./method.ts";

/** iterations of an outlined loop per call of its function; its dispatcher charges them to the activation's fuel */
const CHUNK = 1024;
/** the chunks a dispatcher runs before it reports the loop as long (World.longLoops) and returns to the method, which calls it again */
const LONG_ROUNDS = 64;
/** what a chunk answers its dispatcher, and the dispatcher the method: the loop ended, it ran CHUNK iterations, the method returns or throws,
 *  or control leaves by the chunk's exit i (Exit + i) */
const ChunkStatus = { Done: 0, Again: 1, Return: 2, Throw: 3, Exit: 4 } as const;

type Region = Flow["regions"][number];
type Scope = Region["scopes"][number];
/** the body of a method whose loops run in chunks: its locals may live in their state struct, so one of a non-null type is declared nullable and made
 *  non-null where it is read, and the locals the body uses are kept */
export class OutlinedCode extends Code {
  readonly locals = new Set<number>();
  readonly nonNullLocals: Set<number>;
  constructor(nparams: number, nonNullLocals = new Set<number>()) { super(nparams); this.nonNullLocals = nonNullLocals; }
  override newLocal(t: VT): number {
    const i = this.nparams + this.localTypes.length;
    if (typeof t !== "number" && !t.nullable) { this.nonNullLocals.add(i); t = { ...t, nullable: true }; }
    this.localTypes.push(t); return i;
  }
  override lget(i: number, nonNull = true): this { return this.access(0x20, i, nonNull); }
  override lset(i: number): this { return this.access(0x21, i, false); }
  override ltee(i: number): this { return this.access(0x22, i, true); }
  protected access(op: number, i: number, nonNull: boolean, index = i): this {
    this.locals.add(i);
    this.b.push(op); uleb(index, this.b);
    if (nonNull && this.nonNullLocals.has(i)) this.refAsNonNull();
    return this;
  }
}
/** a chunk's body, sharing the method's locals: they are numbered once its state is laid out (Outliner.build), so each access waits for materialize */
class ChunkCode extends OutlinedCode {
  localMap = new Map<number, number>();
  private materializing = false;
  constructor(root: OutlinedCode) { super(root.nparams, root.nonNullLocals); this.localTypes = root.localTypes; }
  protected override access(op: number, i: number, nonNull: boolean): this {
    if (!this.materializing) { this.locals.add(i); this.defer(() => { this.access(op, i, nonNull); }); return this; }
    const index = this.localMap.get(i);
    if (index === undefined) throw new Error(`Unmapped outlined local ${i}`);
    return super.access(op, i, nonNull, index);
  }
  override materialize(): void { this.materializing = true; super.materialize(); this.materializing = false; }
}

interface Chunk { code: ChunkCode; label: string; count: number; entry: number; exits: { pc: number; block: number; final: boolean }[]; locals: number[]; f: number; dispatch: number; cycle?: number[] }

export class Outliner {
  /** the dispatch cycle of each region in one: each runs in one chunk with a dispatch of its own */
  private cycleOf: Map<number, number[]>;
  private armedLocal = -1;
  /** the chunk being emitted */
  private chunk?: Chunk;
  private cycleChunks = new Map<number[], Chunk>();
  /** the state field in which the dispatchers count the iterations the activation's chunks ran, toward its fuel (the chunks themselves only count to CHUNK) */
  private chunkFuel = -1;
  private chunks: Chunk[] = [];
  private resultLocal = -1;
  private controlLocal = -1;
  private stateType = -1;
  private stateLocal = -1;
  private mc: MC;
  constructor(mc: MC) { this.mc = mc; this.cycleOf = dispatchCycles(mc); }
  /** whether loops start in the method (the first tier) */
  get deferred(): boolean { return this.mc.cx.counting; }
  /** whether the method has a loop or a dispatch cycle to outline */
  get any(): boolean { return this.cycleOf.size > 0 || this.mc.flow.regions.some((r) => r.scopes.some((s) => s.loop)); }
  /** the locals with which the method's own code calls its chunks */
  declare(): void {
    const mc = this.mc, c = mc.code;
    this.controlLocal = c.newLocal(T.i32);
    if (mc.m.ret !== "V") this.resultLocal = c.newLocal(mc.cx.vtOf(kindOf(mc.m.ret)));
    if (!mc.tries) mc.excLocal = c.newLocal(T.anyref);
  }

  /** region `k` as a call of its cycle's chunk, unless it is in no cycle or in the one being emitted; answers whether it was */
  region(k: number): boolean {
    const cycle = this.cycleOf.get(k);
    if (!cycle || this.chunk?.cycle === cycle) return false;
    let ch = this.cycleChunks.get(cycle);
    if (!ch) this.cycleChunks.set(cycle, ch = this.body("$cycle" + cycle[0], () => this.emitCycle(cycle), cycle));
    this.mc.code.i32(k).lset(this.mc.regionLocal);
    this.call(ch);
    return true;
  }
  /** the loop `scope` of region `r`, with the scopes inside it: in the method for the first tier's method itself, else in a chunk */
  loop(r: Region, scope: Scope, scopes: Scope[]): void {
    if (this.deferred && !this.chunk) this.deferLoop(r, scope, scopes); else this.outline(r, scope, scopes);
  }
  /** a return inside a chunk: its result to the result local, and the Return status; answers whether it was in one */
  ret(): boolean {
    if (!this.chunk) return false;
    if (this.resultLocal >= 0) this.mc.code.lset(this.resultLocal);
    this.status(ChunkStatus.Return);
    return true;
  }
  /** a jump of block `from` out of the chunk being emitted: a dispatch within its cycle, or one of its exits, which the code calling it takes; answers whether it was one */
  exit(from: number, targetPc: number, final: boolean, go: Go, label: string): boolean {
    const mc = this.mc, c = mc.code, ch = this.chunk;
    if (!ch) return false;
    if (go === Go.Dispatch && ch.cycle?.includes(mc.regionOfPc.get(targetPc)!)) { c.i32(mc.regionOfPc.get(targetPc)!).lset(mc.regionLocal).br(mc.depth("$cycleDisp")); return true; }
    if (go === Go.Next || mc.nest.includes(label)) return false;
    let i = ch.exits.findIndex((e) => e.pc === targetPc && e.block === from && e.final === final);
    if (i < 0) { i = ch.exits.length; ch.exits.push({ pc: targetPc, block: from, final }); }
    this.status(ChunkStatus.Exit + i);
    return true;
  }
  /** the chunks' functions and dispatchers, the method's parameters and locals (`types`) living in a state struct; answers whether there are any */
  build(types: VT[]): boolean {
    if (!this.chunks.length) return false;
    const mc = this.mc, cx = mc.cx, mb = cx.mb;
    this.stateType = mb.addType({ k: "struct", fields: types.map((t) => ({ t, mut: true })) });
    this.stateLocal = mc.root.newLocal(refNull(this.stateType));
    for (const ch of this.chunks) {
      ch.locals = [...ch.code.locals].sort((a, b) => a - b);
      // State fields retain method indices; native chunks declare only their used locals.
      const locals = [...ch.locals, this.stateLocal];
      ch.code.localMap = new Map(locals.map((l, i) => [l, i + 1]));
      ch.code.nparams = 1;
      ch.code.localTypes = locals.map((l) => l === this.stateLocal ? refNull(this.stateType) : types[l]);
      const owner = mb.funcNames[cx.fn.get(mid(mc.m))! - mb.nImportedFuncs];
      const name = owner + CHUNK_MARK + ch.label.slice(1);
      ch.f = mb.reserveFunc(mb.addFuncType([ref(this.stateType)], [T.i32]), name);
      cx.outlines.push({ name, f: ch.f, code: ch.code, m: mc.m, owner });
      const d = new Code(1), count = d.newLocal(T.i32), status = d.newLocal(T.i32), fuel = d.newLocal(T.i32);
      d.loop().lget(0).i32(0).structSet(this.stateType, ch.count);
      d.lget(0).call(ch.f).lset(status);
      // the activation's fuel: the iterations of every chunk it ran
      d.lget(0).structGet(this.stateType, this.chunkFuel).lget(0).structGet(this.stateType, ch.count).raw(OP.i32_add).ltee(fuel).i32(FUEL).raw(OP.i32_ge_u).if_();
      cx.callRt(d, "yieldNow"); d.i32(0).lset(fuel).end();
      d.lget(0).lget(fuel).structSet(this.stateType, this.chunkFuel);
      d.lget(status).i32(ChunkStatus.Again).raw(OP.i32_ne).if_().lget(status).ret().end();
      d.lget(count).i32(1).raw(OP.i32_add).ltee(count).i32(LONG_ROUNDS).raw(OP.i32_lt_u).brIf(0).end();
      const slot = cx.counting ? cx.w.slotOf(mc.m) : COUNT_SLOTS;
      if (slot < COUNT_SLOTS) d.i32(slot).call(cx.imp.long);
      d.i32(ChunkStatus.Again).ret();
      ch.dispatch = mb.addFunc(mb.addFuncType([ref(this.stateType)], [T.i32]), d.finish(), "$dispatch:" + name);
    }
    return true;
  }
  /** the chunks' bodies, once their frame weights are known */
  finish(): void {
    for (const ch of this.chunks) {
      ch.code.materialize();
      this.mc.cx.mb.setBody(ch.f, ch.code.finish());
    }
  }

  /** the regions of a dispatch cycle in its chunk: a jump between them dispatches here, each dispatch counting toward the chunk */
  private emitCycle(cycle: number[]): void {
    const mc = this.mc, c = mc.code;
    mc.push("$cycleDisp"); c.loop();
    this.iterate(this.chunk!);
    for (let i = cycle.length - 1; i >= 0; i--) { mc.push("$C" + i); c.block(); }
    const at = new Map(cycle.map((k, i) => [k, i]));
    c.lget(mc.regionLocal).brTable(Array.from({ length: mc.flow.regions.length }, (_, k) => at.get(k) ?? 0), 0);
    for (let i = 0; i < cycle.length; i++) { mc.pop(); c.end(); mc.emitRegion(cycle[i]); c.unreachable(); }
    mc.pop(); c.end().unreachable();
  }
  /** the loop in the method, left for its chunks at a fuel tick or once a loop inside it was */
  private deferLoop(r: Region, scope: Scope, scopes: Scope[]): void {
    const mc = this.mc, c = mc.code, label = scope.label, after = "$after" + label, xfer = "$xfer" + label;
    mc.push(after); c.block();
    mc.push(xfer); c.block();
    mc.push(label); c.loop();
    const armed = this.armedLocal >= 0 ? this.armedLocal : (this.armedLocal = mc.root.newLocal(T.i32));
    if (scopes.some((s) => s.loop)) c.lget(armed).brIf(mc.depth(xfer));
    mc.push("if");
    mc.fuel(() => c.i32(1).lset(armed).br(mc.depth(xfer)));
    mc.pop();
    mc.emitSpan(r, scope.open, scope.close, scopes);
    mc.endBlk(); c.br(mc.depth(after));
    mc.pop(); c.end();
    this.outline(r, scope, scopes);
    mc.pop(); c.end();
  }
  private outline(r: Region, scope: Scope, scopes: Scope[]): void {
    const mc = this.mc;
    this.call(this.body(scope.label, () => {
      mc.push(scope.label); mc.code.loop();
      this.iterate(this.chunk!);
      mc.emitSpan(r, scope.open, scope.close, scopes);
      mc.endBlk(); this.status(ChunkStatus.Done);
    }));
  }
  /** at the head of a chunk's loop: back to the dispatcher after CHUNK iterations, else count one */
  private iterate(ch: Chunk): void {
    const mc = this.mc, c = mc.code;
    c.lget(ch.count).i32(CHUNK).raw(OP.i32_eq).if_(); mc.push("if"); this.status(ChunkStatus.Again); mc.pop(); c.end();
    c.lget(ch.count).i32(1).raw(OP.i32_add).lset(ch.count);
  }
  private status(status: number): void {
    this.mc.code.i32(status).br(this.mc.depth("$chunkReturn"));
  }
  /** a function of its own for what `emit` emits, which answers a status (call) and takes and leaves the method's locals in the state struct */
  private body(label: string, emit: () => void, cycle?: number[]): Chunk {
    const mc = this.mc, root = mc.root as OutlinedCode, parent = mc.code as OutlinedCode, nest = mc.nest, outer = this.chunk;
    const body = new ChunkCode(root);
    body.defer((c) => {
      // the chunk's own parameter, the state struct, which no local of the method maps to
      c.raw(0x20, 0).lset(this.stateLocal);
      this.loadState(c, ch.locals);
    });
    if (this.chunkFuel < 0) this.chunkFuel = root.newLocal(T.i32);
    const ch: Chunk = { code: body, label, count: parent.newLocal(T.i32), entry: parent.newLocal(T.i32), exits: [], locals: [], f: -1, dispatch: -1, cycle };
    parent.locals.add(ch.entry);
    this.chunks.push(ch); mc.code = body; mc.nest = []; this.chunk = ch;
    mc.push("$chunkReturn"); body.block(T.i32);
    mc.push("$chunkCaught"); body.block(T.anyref);
    mc.push("$chunkTry"); body.tryTable(null, [[0, mc.cx.tag, 0]]);
    emit();
    mc.pop(); body.end().unreachable();
    mc.pop(); body.end().lset(mc.excLocal); this.status(ChunkStatus.Throw);
    mc.pop(); body.end();
    if (mc.cx.counting) mc.cx.emitCount(body, mc.m, ch.count);
    body.defer((c) => { this.saveState(c, ch.locals); c.ret(); });
    for (const l of body.locals) parent.locals.add(l);
    mc.code = parent; mc.nest = nest; this.chunk = outer;
    return ch;
  }
  /** calls the chunk until it is done, then goes where it says: the method returns or throws, or control continues at one of its exits (Done falls through) */
  private call(ch: Chunk): void {
    const mc = this.mc, c = mc.code, cx = mc.cx;
    mc.push("$chunkCall"); c.loop();
    c.i32(0).lset(ch.count);
    c.defer((c) => {
      c.lget(this.stateLocal).refIsNull().if_().gc(1, this.stateType).lset(this.stateLocal).end();
      this.saveState(c, ch.locals);
      // Charge the dispatcher and chunk only while their native frames are active.
      const weights = cx.emitEnter(c, ch.entry);
      const size = ch.code.localTypes.length;
      for (const at of weights) c.patch(at, 12 + size);
      c.lget(this.stateLocal).refAsNonNull().call(ch.dispatch).lset(this.controlLocal);
      cx.emitLeave(c, ch.entry, false);
      this.loadState(c, ch.locals);
    });
    c.lget(this.controlLocal).i32(ChunkStatus.Again).raw(OP.i32_eq).brIf(0);
    c.lget(this.controlLocal).i32(ChunkStatus.Return).raw(OP.i32_eq).if_(); mc.push("if");
    if (this.resultLocal >= 0) c.lget(this.resultLocal);
    mc.methodReturn(); mc.pop(); c.end();
    c.lget(this.controlLocal).i32(ChunkStatus.Throw).raw(OP.i32_eq).if_().lget(mc.excLocal).throw_(cx.tag).end();
    for (let i = 0; i < ch.exits.length; i++) {
      c.lget(this.controlLocal).i32(ChunkStatus.Exit + i).raw(OP.i32_eq).if_(); mc.push("if");
      const exit = ch.exits[i];
      mc.jump(exit.block, exit.pc, exit.final); mc.pop(); c.end();
    }
    mc.pop(); c.end();
  }
  private saveState(c: Code, locals: number[]): void {
    for (const i of locals) c.lget(this.stateLocal).refAsNonNull().lget(i, false).structSet(this.stateType, i);
  }
  private loadState(c: Code, locals: number[]): void {
    for (const i of locals) if (i !== this.controlLocal) c.lget(this.stateLocal).refAsNonNull().structGet(this.stateType, i).lset(i);
  }
}

/** the dispatch cycles of the method's regions: the strong components of their jumps and handler edges, so acyclic handler paths stay in the method */
function dispatchCycles(mc: MC): Map<number, number[]> {
  const regions = mc.flow.regions, n = regions.length, cycleOf = new Map<number, number[]>();
  if (n < 2) return cycleOf;
  const { succ, hsucc } = mc.prepared, owner = new Int32Array(succ.length).fill(-1);
  regions.forEach((r, k) => { for (const b of r.order) owner[b] = k; });
  const edges = Array.from({ length: n }, () => new Set<number>()), reverse = Array.from({ length: n }, () => new Set<number>());
  const link = (from: number, to: number) => { if (to >= 0 && to !== from) { edges[from].add(to); reverse[to].add(from); } };
  for (let k = 0; k < n; k++) for (const b of regions[k].order) for (const s of succ[b]) link(k, owner[s]);
  for (let b = 0; b < succ.length; b++) if (owner[b] >= 0) for (const h of hsucc[b]) link(owner[b], owner[h]);
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
      for (const v of component) cycleOf.set(v, component);
    }
  }
  return cycleOf;
}
