import { emitSymbolicSite, siteKey } from "./sites.ts";
import { STRING } from "./strings.ts";
import { Code, OP, inlineMark } from "./code.ts";
import { T, ref, refNull, type VT } from "./wasmbin.ts";
import { kindOf, type FieldInfo, type Kind, type MethodInfo } from "./program.ts";
import type { Compiler } from "./j2w.ts";
import { H, ELEM_KINDS, elemKindOf, type ElemKind } from "./consts.ts";
import { isWide } from "../../jvm/abi.ts";
import { argRegisters, endsBlock, ifTarget, switchCases, type PreparedInstruction as Ins, type PreparedMethod } from "../../jvm/prepared.ts";
import { type Flow, Go, structureAny } from "./structure.ts";
import { mid } from "./ids.ts";
import { emitPolymorphic } from "./poly.ts";
import { emitCustom, emitHandleConstant, emitTypeConstant } from "./handles.ts";
import { failed, resolveFieldRef, resolveInvoke, typeFailure, type LinkFailure } from "./linkage.ts";
import { MethodFacts, cloneFacts, newFacts, type Facts } from "./facts.ts";
import { MAX_UNCOUNTED, isStackOverflow } from "./exc.ts";
import { Invoke, invokeKind, isInvoke, narrowBits, wideBits } from "../../jvm/opcodes.ts";
import { emitRestored } from "./hostcalls.ts";
import { Outliner } from "./outline.ts";
import { isEmpty, trivialOf, type Seq, type Trivial, type Val } from "./inline.ts";
import { KINDS, BINOPS, UNARY, binopKind, binopName, I as KI, F as KF, R as KR, J as KJ, D as KD, type Binop, type Typing } from "./infer.ts";

/** what an invoke names: the method's name and descriptor, the class whose methods it searches, and the resolved target */
type InvokeSite = { name: string; desc: string; decl: string; target: MethodInfo | LinkFailure | "clone" };
/** how an invoke reaches the Java method it calls: a fixed one, whose body may run in place; a dispatch, through the only implementation the class hierarchy has if
 *  it has one (Compiler.devirt); String's constructor, which makes the string */
type Binding = { k: "fixed"; m: MethodInfo; body?: Trivial } | { k: "virtual"; only?: MethodInfo } | { k: "string" };
/** the calls of a method that may count its frame around themselves instead of in a prologue */
const MAX_SITES = 2;
/** the Wasm instruction of each binary operation that is one, by operand kind */
const WASM_BINOP: Record<number, Partial<Record<Binop, number>>> = {
  [KI]: { add: OP.i32_add, sub: OP.i32_sub, mul: OP.i32_mul, div: OP.i32_div_s, rem: OP.i32_rem_s, and: OP.i32_and, or: OP.i32_or, xor: OP.i32_xor, shl: OP.i32_shl, shr: OP.i32_shr_s, ushr: OP.i32_shr_u },
  [KJ]: { add: OP.i64_add, sub: OP.i64_sub, mul: OP.i64_mul, and: OP.i64_and, or: OP.i64_or, xor: OP.i64_xor, shl: OP.i64_shl, shr: OP.i64_shr_s, ushr: OP.i64_shr_u },
  [KF]: { add: OP.f32_add, sub: OP.f32_sub, mul: OP.f32_mul, div: OP.f32_div },
  [KD]: { add: OP.f64_add, sub: OP.f64_sub, mul: OP.f64_mul, div: OP.f64_div },
};
type Around = (c: Code, operand: () => void) => void;
const after = (...ops: number[]): Around => (c, x) => { x(); c.raw(...ops); };
const trunc = (n: number): Around => (c, x) => { x(); c.satTrunc(n); };
/** the Wasm of each unary op around its operand, in the order of infer.ts UNARY */
const UNARY_CODE: Around[] = [
  (c, x) => { c.i32(0); x(); c.raw(OP.i32_sub); }, (c, x) => { x(); c.i32(-1).raw(OP.i32_xor); },
  (c, x) => { c.i64(0n); x(); c.raw(OP.i64_sub); }, (c, x) => { x(); c.i64(-1n).raw(OP.i64_xor); },
  after(OP.f32_neg), after(OP.f64_neg),
  after(OP.i64_extend_i32_s), after(OP.f32_convert_i32_s), after(OP.f64_convert_i32_s),
  after(OP.i32_wrap_i64), after(OP.f32_convert_i64_s), after(OP.f64_convert_i64_s),
  trunc(0), trunc(4), after(OP.f64_promote_f32),
  trunc(2), trunc(6), after(OP.f32_demote_f64),
  after(OP.i32_extend8_s), (c, x) => { x(); c.i32(0xffff).raw(OP.i32_and); }, after(OP.i32_extend16_s),
];
/** the element storage, sign and value kind of each array access, aget (0x44) to aget-short (0x4a), and of the aput (0x4b-0x51) of the same type */
const ELEMS: { k: ElemKind; sign: "s" | "u" | ""; kind: Kind }[] = [
  { k: "i32", sign: "", kind: "I" }, { k: "i64", sign: "", kind: "J" }, { k: "ref", sign: "", kind: "L" }, { k: "i8", sign: "u", kind: "I" },
  { k: "i8", sign: "s", kind: "I" }, { k: "i16", sign: "u", kind: "I" }, { k: "i16", sign: "s", kind: "I" },
];
/** the comparison of if-lt, if-ge, if-gt and if-le, and of their -z forms */
const COMPARE = [OP.i32_lt_s, OP.i32_ge_s, OP.i32_gt_s, OP.i32_le_s];

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
  code: Code; prepared!: PreparedMethod; flow!: Flow; typing!: Typing; item; dex;
  /** wasm local of each web */
  webLocal: number[] = [];
  /** the instruction being emitted: its operands resolve to webs through it */
  cur!: Ins;
  nest: string[] = [];
  block = 0;
  regionLocal = -1; pcLocal = -1; excLocal = -1; tmpL = -1;
  consumed = new Set<number>();            // move-result pcs folded into their invoke
  tries: boolean;
  regionOfPc = new Map<number, number>();
  /** what holds on every path to the start of each block (facts.ts), and at the instruction being emitted */
  private known?: MethodFacts;
  facts: Facts = newFacts();
  /** the local holding each shared cast of a field access's object (facts.ts shadowKeys) */
  private shadows = new Map<string, number>();
  /** the method's own function, which `code` is while no chunk is being emitted */
  root!: Code;
  /** the loops and dispatch cycles that run in functions of their own (outline.ts), if the method has any to outline */
  private loops?: Outliner;
  constructor(cx: Compiler, m: MethodInfo) {
    this.cx = cx; this.m = m;
    this.dex = m.dex; this.item = m.dex.code(m.codeOff);
    this.root = this.code = new Code((m.isStatic ? 0 : 1) + m.params.length);
    this.tries = this.item.tries.length > 0;
  }

  // ---------- registers: webs with disjoint intervals share storage of the same Wasm type
  local(web: number): number {
    let l = this.webLocal[web];
    if (l === undefined) this.webLocal[web] = l = this.code.newLocal(KINDS[this.typing.kind[web]].vt);
    return l;
  }
  private allocateWebs() {
    const { start, end } = this.typing.ranges(), reserved = new Set<number>();
    for (let r = this.item.regs - this.item.ins; r < this.item.regs; r++) { const w = this.typing.param(r); if (w >= 0) reserved.add(w); }
    const pools = new Map<VT, { local: number; end: number }[]>();
    const webs = start.map((_, w) => w).filter(w => start[w] !== undefined && !reserved.has(w)).sort((a, b) => start[a] - start[b] || a - b);
    for (const w of webs) {
      const type = KINDS[this.typing.kind[w]].vt;
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
    const k = this.load(reg), { abi, toBits } = KINDS[k];
    if (kind !== abi) throw new Error(`v${reg} holds a ${k} where ${kind} is read at ${this.cur.pc}`);
    if (toBits) this.code.raw(toBits);
  }
  /** pop a value in the bits ABI of `kind` into what `ins` (default: the current one) defines */
  set(kind: Kind, ins = this.cur): void {
    const w = this.typing.def(ins.pc);
    if (w >= 0) {
      const k = this.typing.kind[w], { abi, fromBits } = KINDS[k];
      if (kind !== abi) throw new Error(`a ${kind} is defined as a ${k} at ${ins.pc}`);
      if (fromBits) this.code.raw(fromBits);
    }
    this.store(ins);
  }
  /** push `reg` as a number of kind `k` (infer.ts I, J, F or D): an int or long in the bits ABI, a float or double as itself */
  num(k: number, reg: number): void {
    if (!KINDS[k].toBits) { this.get(KINDS[k].abi, reg); return; }
    if (this.load(reg) !== k) throw new Error(`v${reg} is not a ${k === KF ? "float" : "double"} at ${this.cur.pc}`);
  }
  /** pop a number of kind `k` into what the current instruction defines */
  setNum(k: number): void { if (KINDS[k].toBits) this.store(this.cur); else this.set(KINDS[k].abi); }

  run(): void {
    const { m, item, cx } = this, phase = cx.w.stats.phase, { prepared, typing } = cx.analysis(m, true);
    this.prepared = prepared; this.typing = typing;
    let t = performance.now();
    const lap = (name: keyof typeof phase) => { const n = performance.now(); phase[name] += n - t; t = n; };
    let flow: Flow;
    try { flow = structureAny(prepared, item); } catch (e) { throw new Error(`unstructured: ${(e as Error).message}`); }
    this.flow = flow;
    lap("flow");
    this.known = new MethodFacts(this);
    lap("facts");
    const c = this.code;
    let reg = item.regs - item.ins, pi = 0;
    // Floating parameters arrive as bits and are copied into typed locals once.
    const param = (wide: boolean) => {
      const w = this.typing.param(reg);
      if (w >= 0) {
        const { fromBits } = KINDS[this.typing.kind[w]];
        if (fromBits) c.lget(pi).raw(fromBits).lset(this.local(w)); else this.webLocal[w] = pi;
      }
      pi++; reg += wide ? 2 : 1;
    };
    if (!m.isStatic) param(false);
    for (const p of m.params) param(isWide(p));
    this.allocateWebs();
    if (this.tries) { this.pcLocal = c.newLocal(T.i32); this.excLocal = c.newLocal(T.anyref); }
    this.tmpL = c.newLocal(T.anyref);
    if (cx.counting || cx.w.longLoops.has(mid(m))) { const loops = new Outliner(this); if (loops.any) (this.loops = loops).declare(); }
    if (this.loops || this.planDepth()) this.weights.push(...cx.emitEnter(c, this.entryDepth = c.newLocal(T.i32)));
    // a deferred loop's iterations count toward the method's budget when it returns
    if (this.loops?.deferred) this.fuelLocal = c.newLocal(T.i32);
    if (cx.counting) cx.emitCount(c, m);
    const regions = flow.regions;
    regions.forEach((r, i) => this.regionOfPc.set(prepared.start[r.entry], i));
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
  fuel(tick?: () => void) { this.cx.emitFuel(this.code, this.fuelLocal >= 0 ? this.fuelLocal : (this.fuelLocal = this.code.newLocal(T.i32)), tick); }
  /** where the frame's weight (exc.ts MAX_DEPTH) goes in the code, known once the locals are */
  private weights: number[] = [];
  private leave() { if (this.entryDepth >= 0) this.cx.emitLeave(this.code, this.entryDepth, false); }
  /** gives the frame the weight of its parameters and locals */
  weigh(): Code {
    const types = [...(this.m.isStatic ? [] : [T.anyref]), ...this.m.params.map((p) => this.cx.vtOf(kindOf(p))), ...this.root.localTypes];
    const own = (this.loops?.build(types) ? 5 : 4) + types.length;
    for (const at of this.weights) this.code.patch(at, own);
    if (this.entryDepth < 0 && this.boundable) this.cx.bound.set(mid(this.m), own + this.calleeWeight);
    this.loops?.finish();
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
    const { instructions, first, last } = this.prepared;
    if (instructions.some(ins => this.deferredSite(ins))) return true;
    if (!instructions.some((i) => isInvoke(i.op))) return false;
    if (this.tries) return true;
    const open: string[] = [], cold: string[] = [];
    // a call in a loop counts once per iteration around itself, against once per call of the method in a prologue; an irreducible cycle crosses regions
    let looped = false;
    const bounded = (m: MethodInfo) => { const w = this.cx.boundOf(m); if (w !== undefined) this.calleeWeight = Math.max(this.calleeWeight, w); return w !== undefined; };
    for (let blk = 0; blk < first.length; blk++) {
      const thrown = instructions[last[blk]].op === 0x27, opened = open.length;
      for (let i = first[blk]; i <= last[blk]; i++) {
        const ins = instructions[i];
        if (!isInvoke(ins.op)) continue;
        if (ins.op >= 0xfa) return true; // invoke-polymorphic, invoke-custom
        const b = this.binding(ins), key = String(ins.pc);
        if (!b) continue;
        if (b.k === "virtual") {
          // a virtual call tests for the likely implementations of its unit first (guards): the call of one that counts, and the dispatch behind them, count around themselves
          const guards = this.guards(ins, b);
          for (const g of guards) if (!bounded(g)) open.push(`${key}:${mid(g)}`);
          if (guards.length) { cold.push(key + ":f"); continue; }
        }
        // a check calls its method for a null argument, which the method rejects
        const body = b.k === "fixed" ? b.body : undefined;
        if (body?.k === "check") { cold.push(key); continue; }
        const callee = b.k !== "fixed" ? undefined : body ? this.innerCall(body) : b.m;
        if (callee === null) continue;
        // the constructor of an exception thrown right after runs once and leaves the method: a caller's weight is no loss there, whatever the stack holds
        if (!callee || !bounded(callee)) (thrown ? cold : open).push(key);
      }
      if (open.length > opened && (this.flow.loopOf[blk] >= 0 || this.flow.regions.length > 1)) looped = true;
    }
    if (looped || this.calleeWeight + 4 + 3 * this.item.regs > MAX_UNCOUNTED || open.length > MAX_SITES) return true;
    this.sites = new Set([...open, ...cold]);
    this.boundable = open.length === 0;
    return false;
  }
  /** whether `ins` is one of the module's symbolic sites (sites.ts), whose references resolve when it runs */
  deferredSite(ins: Ins): boolean {
    return this.cx.symbolicImports.size > 0 && this.cx.symbolicImports.has(siteKey(this.m, ins));
  }
  private bindings = new Map<number, Binding | null>();
  /** how an invoke other than invoke-polymorphic, invoke-custom and a symbolic site reaches its target; null if it calls no Java method */
  binding(ins: Ins): Binding | null {
    let b = this.bindings.get(ins.pc);
    if (b === undefined) this.bindings.set(ins.pc, b = this.bind(ins));
    return b;
  }
  private bind(ins: Ins): Binding | null {
    const { decl, name, target } = this.invoke(ins), kind = invokeKind(ins.op);
    if (target === "clone" || failed(target)) return null;
    if (kind === Invoke.Direct && decl === STRING && name === "<init>") return { k: "string" };
    if (kind !== Invoke.Virtual && kind !== Invoke.Interface || this.cx.staticallyBound(decl, target)) return { k: "fixed", m: target, body: this.bodyOf(target) };
    const only = this.cx.devirt(decl, name, target.desc);
    return { k: "virtual", only: only === "many" ? undefined : only };
  }
  /** what a call of `m`, bound statically, runs in place (inline.ts) */
  private bodyOf(m: MethodInfo): Trivial | undefined { return this.cx.inlines(m) ? trivialOf(this.cx.prog, m) : undefined; }
  /** the call a body run in place makes, if it makes one: a call of a method whose body is empty only initializes a static one's class */
  private innerCall(t: Seq): MethodInfo | null {
    const s = t.steps.find((s) => "call" in s);
    return s && "call" in s && !isEmpty(this.bodyOf(s.call)) ? s.call : null;
  }
  /** the implementations a virtual call tests for before it dispatches: the only one, else the unit's likely ones (Compiler.guards), if the unit has them */
  private guards(ins: Ins, b: Extract<Binding, { k: "virtual" }>): MethodInfo[] {
    if (b.only) return this.cx.directFunc(b.only) === undefined ? [] : [b.only];
    const { decl, name, desc } = this.invoke(ins);
    return this.cx.guards(decl, name, desc);
  }
  private invokes = new Map<number, InvokeSite>();
  /** the reference of an invoke other than invoke-polymorphic and invoke-custom, and what it resolves to, read once per site */
  invoke(ins: Ins): InvokeSite {
    let s = this.invokes.get(ins.pc);
    if (s) return s;
    const dex = this.dex, mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), declared = dex.typeName(mr.cls);
    // an array's methods are Object's, except clone, which copies the array
    const decl = declared[0] === "[" ? "java/lang/Object" : declared;
    const target = declared !== decl && mr.name + desc === "clone()Ljava/lang/Object;" ? "clone" : this.invokeTarget(ins.b, invokeKind(ins.op), declared, mr.name, desc);
    this.invokes.set(ins.pc, s = { name: mr.name, desc, decl, target });
    return s;
  }
  push(l: string) { this.nest.push(l); }
  pop() { this.nest.pop(); }
  depth(label: string): number { const i = this.nest.lastIndexOf(label); if (i < 0) throw new Error("no label " + label); return this.nest.length - 1 - i; }
  /** a scope of the structured flow: a block (B), or a loop (L) that stays in the method */
  blk(label: string, loop: boolean) {
    this.push(label);
    if (!loop) { this.code.block(); return; }
    this.code.loop();
    // every cycle passes a natural loop's head, which can hold the browser thread however finite the loop
    this.fuel();
  }
  endBlk() { this.pop(); this.code.end(); }

  emitRegion(k: number) {
    const r = this.flow.regions[k];
    if (!this.loops?.region(k)) this.emitSpan(r, 0, r.order.length, r.scopes);
  }
  emitSpan(r: Flow["regions"][number], start: number, end: number, scopes: Flow["regions"][number]["scopes"]) {
    const open: { close: number }[] = []; let next = 0, p = start;
    while (p <= end) {
      while (open.length && open[open.length - 1].close === p) { open.pop(); this.endBlk(); }
      let outlined = false;
      for (; next < scopes.length && scopes[next].open === p; next++) {
        const s = scopes[next];
        if (s.loop && this.loops) {
          let last = next + 1;
          while (last < scopes.length && scopes[last].open < s.close) last++;
          this.loops.loop(r, s, scopes.slice(next + 1, last));
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
  methodReturn(): void {
    if (this.loops?.ret()) return;
    if (this.cx.counting && this.fuelLocal >= 0) this.cx.emitCount(this.code, this.m, this.fuelLocal);
    this.leave(); this.code.ret();
  }
  emitBlock(b: number) {
    const { instructions, blockAt, start, first } = this.prepared, c = this.code, end = this.prepared.last[b];
    this.block = b;
    if (this.tries) c.i32(start[b]).lset(this.pcLocal);
    this.facts = cloneFacts(this.known!.entry[b]);
    for (let i = first[b]; i <= end; i++) {
      this.emit(instructions[i]);
      this.known!.step(instructions[i], this.facts);
    }
    const last = instructions[end];
    if (!endsBlock(last.op)) {
      const target = this.flow.fallTarget(b, last.op >= 0x32 && last.op <= 0x3d ? blockAt[ifTarget(last)] : -1);
      if (target >= 0) this.jump(start[target], true);
    }
  }
  jump(targetPc: number, final: boolean) {
    const go = this.flow.go(this.block, this.prepared.blockAt[targetPc], final), c = this.code;
    const label = go === Go.Continue ? "L" + targetPc : go === Go.Break ? "B" + targetPc : "$disp";
    if (this.loops?.exit(targetPc, final, go, label)) return;
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
      for (const addr of this.prepared.handlerPcs) {
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
  refTo(reg: number, struct: number) {
    const c = this.code, key = `${this.useWeb(reg)}:${struct}`;
    let local = this.shadows.get(key);
    if (this.facts.typed.has(key) && local !== undefined) { c.lget(local); return; }
    this.nonNull(reg); c.refCast(struct);
    if (this.known?.shadowKeys.has(key)) { if (local === undefined) this.shadows.set(key, local = c.newLocal(refNull(struct))); c.ltee(local); }
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
    if (op >= 0x32 && op <= 0x3d) return this.emitIf(ins);
    const c = this.code, cx = this.cx, dex = this.dex, a = ins.a, b = ins.b;
    switch (op) {
      case 0x00: return; // nop
      case 0x01: case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: case 0x09: { // move, move-wide, move-object
        if (this.typing.def(ins.pc) < 0) return;
        if (this.load(b) !== this.typing.kind[this.typing.def(ins.pc)]) throw new Error(`move between kinds at ${ins.pc}`);
        this.store(ins); return;
      }
      case 0x0a: case 0x0b: case 0x0c: throw new Error("move-result without invoke at " + ins.pc);
      case 0x0d: c.lget(this.excLocal); this.set("L"); return; // move-exception
      case 0x0e: this.methodReturn(); return; // return-void
      case 0x0f: this.get("I", a); this.methodReturn(); return;
      case 0x10: this.get("J", a); this.methodReturn(); return;
      case 0x11: this.get("L", a); this.methodReturn(); return;
      case 0x12: case 0x13: case 0x14: case 0x15: this.constNarrow(narrowBits(op, b)); return;
      case 0x16: case 0x17: case 0x18: case 0x19: this.constWide(wideBits(op, b, ins.wideLit)); return;
      case 0x1a: case 0x1b: cx.str.literal(c, dex.string(b)); this.set("L"); return; // const-string
      case 0x1c: if (this.unresolved(dex.type(b))) return; cx.constClass(c, dex.typeName(b)); this.set("L"); return;
      case 0x1d: case 0x1e: this.nonNull(a); this.monitor(op === 0x1d); return;
      case 0x1f: { // check-cast
        if (this.unresolved(dex.type(b))) return;
        const name = dex.typeName(b);
        if (name === "java/lang/Object") { this.copyReference(a); return; }
        this.get("L", a); cx.emitCast(c, name); this.set("L"); return;
      }
      case 0x20: if (this.unresolved(dex.type(ins.c))) return; this.get("L", ins.b); cx.emitInstanceOf(c, dex.typeName(ins.c)); this.set("I"); return;
      case 0x21: this.arrayLength(b); this.set("I"); return;
      case 0x22: { // new-instance
        if (this.unresolved(dex.type(b))) return;
        const name = dex.typeName(b);
        // a String is made by the constructor call, which assigns its register
        if (name === STRING) c.anyNull(); else { this.ensure(name); cx.emitNew(c, name); }
        this.set("L"); return;
      }
      case 0x23: if (this.unresolved(dex.type(ins.c))) return; cx.emitNewArray(c, dex.type(ins.c), () => this.get("I", ins.b)); this.set("L"); return;
      case 0x24: case 0x25: { // filled-new-array
        const desc = dex.type(b), ek = elemKindOf(desc);
        if (this.unresolved(desc)) { this.consumeResult(ins); return; }
        c.gget(cx.vtGlobal(desc)).refAsNonNull().i64(0n);
        for (const r of ins.regs) { ek === "ref" ? this.get("L", r) : this.get("I", r); }
        c.arrayNewFixed(cx.tData[ek], ins.regs.length).structNew(cx.tArr[ek]);
        this.finishResult(ins, "L"); return;
      }
      case 0x26: { // fill-array-data
        const payload = ins.pc + b, insns = this.item.insns, width = insns[payload + 1], count = insns[payload + 2] | (insns[payload + 3] << 16);
        const bytes = new Uint8Array(insns.buffer, insns.byteOffset + (payload + 4) * 2, width * count).slice();
        const seg = cx.mb.addDataPassive(bytes);
        const ek: ElemKind = width === 1 ? "i8" : width === 2 ? "i16" : width === 4 ? "i32" : "i64";
        this.nonNull(a); cx.arrayData(c, ek).i32(0)
          .i32(0).i32(count).arrayNewData(cx.tData[ek], seg).i32(0).i32(count).arrayCopy(cx.tData[ek], cx.tData[ek]);
        return;
      }
      case 0x27: this.nonNull(a); c.throw_(cx.tag); return;
      case 0x28: case 0x29: case 0x2a: this.jump(ins.pc + a, true); return; // goto
      case 0x2b: case 0x2c: this.emitSwitch(ins); return;
      case 0x2d: case 0x2e: this.num(KF, b); this.num(KF, ins.c); c.call(cx.helper(op === 0x2d ? "cmplf" : "cmpgf")); this.set("I"); return;
      case 0x2f: case 0x30: this.num(KD, b); this.num(KD, ins.c); c.call(cx.helper(op === 0x2f ? "cmpld" : "cmpgd")); this.set("I"); return;
      case 0x31: this.get("J", b); this.get("J", ins.c); c.raw(OP.i64_gt_s); this.get("J", b); this.get("J", ins.c); c.raw(OP.i64_lt_s).raw(OP.i32_sub); this.set("I"); return; // cmp-long
      case 0xfe: emitHandleConstant(this, b); return;
      case 0xff: emitTypeConstant(this, b); return;
    }
    throw new Error(`no translation of ${ins.name} at ${ins.pc}`);
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
    for (let i = 0; i < ELEM_KINDS.length; i++) {
      const k = ELEM_KINDS[i];
      if (i < ELEM_KINDS.length - 1) c.lget(this.tmpL).refTest(cx.tArr[k]).if_(T.i32);
      c.lget(this.tmpL); cx.arrayData(c, k).arrayLen();
      if (i < ELEM_KINDS.length - 1) c.else_();
    }
    for (let i = 0; i < ELEM_KINDS.length - 1; i++) c.end();
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
    const c = this.code, cx = this.cx, { k, sign, kind } = ELEMS[ins.op - 0x44], d = this.dloc(k);
    this.nonNull(ins.b); cx.arrayData(c, k).lset(d);
    this.idxCheck(k, ins.c);
    c.lget(d); this.get("I", ins.c);
    sign === "s" ? c.arrayGetS(cx.tData[k]) : sign === "u" ? c.arrayGetU(cx.tData[k]) : c.arrayGet(cx.tData[k]);
    this.set(kind);
  }
  emitAput(ins: Ins) {
    const c = this.code, cx = this.cx, { k, kind } = ELEMS[ins.op - 0x4b];
    // a static initializer runs once, and its long array literals take the engine longer to compile than to run: their stores are a call
    if (this.m.name === "<clinit>") {
      this.nonNull(ins.b); this.get("I", ins.c); this.get(kind, ins.a);
      c.call(cx.helper("aput:" + k));
      return;
    }
    const d = this.dloc(k);
    this.nonNull(ins.b); c.lset(this.tmpL);
    c.lget(this.tmpL); cx.arrayData(c, k).lset(d);
    this.idxCheck(k, ins.c);
    if (k === "ref") cx.emitStoreCheck(c, this.tmpL, () => this.get("L", ins.a));
    c.lget(d); this.get("I", ins.c); this.get(kind, ins.a);
    c.arraySet(cx.tData[k]);
  }
  fieldOf(idx: number, isStatic: boolean) { return this.resolved(8 * idx + 5 + +isStatic, () => resolveFieldRef(this.cx.prog, this.dex, idx, isStatic, this.m.cls)); }
  /** the method invoke `kind` of method reference `idx` names; invoke-super's depends on the caller */
  private invokeTarget(idx: number, kind: Invoke, declared: string, name: string, desc: string): MethodInfo | LinkFailure {
    const resolve = () => resolveInvoke(this.cx.prog, kind, declared, name, desc, this.m.cls);
    return kind === Invoke.Super ? resolve() : this.resolved(8 * idx + kind, resolve);
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
  /** the field an iget or iput names; String's representation has no fields to translate an access of */
  private instanceField(ins: Ins) {
    const r = this.fieldOf(ins.c, false);
    if (!failed(r) && r.decl === STRING) throw new Error(`String.${r.f.name}: a field of the representation`);
    return r;
  }
  emitIget(ins: Ins) {
    const r = this.instanceField(ins);
    if (failed(r)) return this.linkFail(r);
    this.fieldGet(r, ins.b); this.set(r.f.kind);
  }
  emitIput(ins: Ins) {
    const r = this.instanceField(ins);
    if (failed(r)) return this.linkFail(r);
    this.fieldPut(r, ins.b, () => this.get(r.f.kind, ins.a));
  }
  private fieldGet({ decl, f }: { decl: string; f: FieldInfo }, obj: number) {
    const cx = this.cx, st = cx.structFor(decl);
    this.refTo(obj, st); this.code.structGet(st, cx.fieldIndex(decl, f));
  }
  /** stores what `value` pushes (in the field's kind) into `obj`'s field */
  private fieldPut({ decl, f }: { decl: string; f: FieldInfo }, obj: number, value: () => void) {
    const cx = this.cx, c = this.code, st = cx.structFor(decl);
    this.refTo(obj, st); value(); c.structSet(st, cx.fieldIndex(decl, f));
    if (cx.w.claims(f)) { this.refTo(obj, st); c.externConvertAny(); value(); c.call(cx.imp.claim); }
  }
  emitStatic(ins: Ins) {
    const cx = this.cx, c = this.code, put = ins.op >= 0x67, r = this.fieldOf(ins.b, true);
    if (failed(r)) return this.linkFail(r);
    const { f } = r;
    this.ensure(f.owner);
    const g = cx.staticGlobal(f.owner, f.name, f.desc);
    if (put) { this.get(f.kind, ins.a); c.gset(g); } else { c.gget(g); this.set(f.kind); }
  }
  emitIf(ins: Ins) {
    const c = this.code, flow = this.flow, target = ifTarget(ins), op = ins.op, zero = op >= 0x38;
    const ref = (op <= 0x33 || op === 0x38 || op === 0x39) && this.kindOf(ins.a) === KR;
    const cond = () => {
      if (op <= 0x33 || op === 0x38 || op === 0x39) { // if-eq, if-ne, if-eqz, if-nez
        this.get(ref ? "L" : "I", ins.a);
        if (zero) { if (ref) c.refIsNull(); else c.raw(OP.i32_eqz); }
        else { this.get(ref ? "L" : "I", ins.b); if (ref) c.call(this.cx.helper("acmp")); else c.raw(OP.i32_eq); }
        if (op === 0x33 || op === 0x39) c.raw(OP.i32_eqz);
        return;
      }
      this.get("I", ins.a);
      if (zero) c.i32(0); else this.get("I", ins.b);
      c.raw(COMPARE[op - (zero ? 0x3a : 0x34)]);
    };
    const fall = ins.pc + ins.len;
    if (this.prepared.blockAt[target] === this.prepared.blockAt[fall]) return;
    cond();
    if (flow.inverted.has(this.block)) { c.raw(OP.i32_eqz).if_(); this.push("if"); this.jump(fall, false); }
    else { c.if_(); this.push("if"); this.jump(target, false); }
    this.pop(); c.end();
  }
  emitSwitch(ins: Ins) {
    const c = this.code, cases = switchCases(this.item, ins), flow = this.flow, blockAt = this.prepared.blockAt;
    const lo = Math.min(...cases.map(([k]) => k)), hi = Math.max(...cases.map(([k]) => k));
    // keys dense enough make a jump table, when every target is a label (a hole and the fall-through go to the end of the block)
    const labelled = cases.every(([, t]) => { const g = flow.go(this.block, blockAt[t], false); return g === Go.Break ? this.nest.includes("B" + t) : g === Go.Continue && this.nest.includes("L" + t); });
    if (cases.length >= 4 && hi - lo < 4 * cases.length && labelled) {
      const target = new Map(cases);
      this.push("$sw"); c.block();
      this.get("I", ins.a); c.i32(lo).raw(OP.i32_sub);
      c.brTable(Array.from({ length: hi - lo + 1 }, (_, i) => {
        const t = target.get(lo + i);
        return t === undefined ? 0 : this.depth((flow.go(this.block, blockAt[t], false) === Go.Break ? "B" : "L") + t);
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
    const i = this.prepared.indexAt[ins.pc + ins.len], nx = i >= 0 ? this.prepared.instructions[i] : undefined;
    return nx && nx.op >= 0x0a && nx.op <= 0x0c ? nx : undefined;
  }
  emitInvoke(ins: Ins) {
    const cx = this.cx, c = this.code, prog = cx.prog;
    if (ins.op >= 0xfc) return emitCustom(this, ins);
    if (ins.op >= 0xfa) return emitPolymorphic(this, ins);
    const { desc, decl, target } = this.invoke(ins);
    const p = this.dex.methodTypes(ins.b), retK: Kind | "V" = p.ret === "V" ? "V" : kindOf(p.ret);
    if (target === "clone") { this.nonNull(ins.regs[0]); cx.callRt(c, "aclone"); this.finishResult(ins, "L"); return; }
    if (failed(target)) { this.consumeResult(ins); this.linkFail(target); return; }
    const b = this.binding(ins)!, site = this.sites.has(String(ins.pc));
    if (b.k === "fixed" && b.body) { this.emitBody(ins, b.m, b.body, retK, site); return; }
    if (site) this.enterSite();
    const wrap = (key: string, emit: () => void) => { const on = this.sites.has(`${ins.pc}:${key}`); if (on) this.enterSite(); emit(); if (on) this.leaveSite(); };
    if (b.k === "string") {
      const make = cx.str.factory(desc);
      if (make === undefined) { this.invokeGap(ins, `String.<init>${desc}`); return; }
      pushArgs(this, ins, p.params); c.call(make); if (site) this.leaveSite(); c.lset(this.local(this.useWeb(ins.regs[0]))); return;
    } else if (b.k === "fixed") {
      if (target.isStatic) { this.ensure(target.cls); pushArgs(this, ins, p.params, 0); } else { this.nonNull(ins.regs[0]); pushArgs(this, ins, p.params); }
      cx.callMethod(c, target);
    } else {
      // A native callback can load an override while this activation is still running.
      const declC = prog.get(decl);
      // the slot the receiver's class gives the method; a call that expects one of the likely implementations tests for it first, so the engine can inline it
      const guards = this.guards(ins, b);
      this.nonNull(ins.regs[0]); c.lset(this.tmpL);
      c.lget(this.tmpL); pushArgs(this, ins, p.params);
      c.lget(this.tmpL).refCast(cx.tObj).structGet(cx.tObj, 0);
      if (declC && !declC.isInterface) {
        c.i32(cx.w.dispatch.vslot(decl, target.key)).arrayGet(cx.tVT);
      } else if (prog.get("java/lang/Object")!.byKey.has(target.key)) {
        c.i32(cx.w.dispatch.vslot("java/lang/Object", target.key)).arrayGet(cx.tVT);
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
      const type = cx.descSig(desc, false);
      if (guards.length) {
        const slot = this.slotLocal();
        c.lset(slot);
        for (const g of guards) { c.lget(slot).i32(cx.w.slotOf(g)).raw(OP.i32_eq).ifType(type); wrap(mid(g), () => cx.callMethod(c, g)); c.else_(); }
        c.lget(slot); wrap("f", () => c.callIndirect(type));
        for (const _ of guards) c.end();
      } else c.callIndirect(type);
    }
    if (site) this.leaveSite();
    this.finishResult(ins, retK);
  }
  /** the body of `m` (inline.ts) in place of the call `ins`: the checks the invoke makes in its own frame, then the body's steps */
  private emitBody(ins: Ins, m: MethodInfo, t: Trivial, retK: Kind | "V", site: boolean) {
    const cx = this.cx, c = this.code, regs = argRegisters(ins, m.params, m.isStatic ? 0 : 1);
    if (!m.isStatic) regs.unshift(ins.regs[0]);
    cx.dependsOn(m);
    if (m.isStatic) this.ensure(m.cls);
    else {
      const w = this.useWeb(regs[0]);
      if (!this.facts.nonNull.has(w)) { this.nonNull(regs[0]); c.drop(); this.facts.nonNull.add(w); }
    }
    const call = (u: MethodInfo, args: () => void) => { if (site) this.enterSite(); args(); cx.callMethod(c, u); if (site) this.leaveSite(); };
    if (t.k === "check") {
      // a null first argument takes the call, which does more than return
      this.get("L", regs[0]); c.refIsNull().if_();
      call(m, () => pushArgs(this, ins, m.params, 0));
      c.end();
      return;
    }
    this.emitSteps(m, t, regs, call);
    this.finishResult(ins, retK);
  }
  /** the locals that values of bodies run in place are kept in, by type: a body's values die with it, so the next body reuses them */
  private bodyLocals = new Map<VT, number[]>();
  /** the steps of body `t` of `m`, each in a frame of `m`, leaving the value it returns; `regs` holds its parameters */
  private emitSteps(m: MethodInfo, t: Seq, regs: number[], call: (u: MethodInfo, args: () => void) => void) {
    const cx = this.cx, c = this.code, locals: number[] = [], used = new Set<number>(), taken = new Map<VT, number>(), { steps, ret } = t;
    // the value returned stays on the stack when the last step leaves it there
    const onStack = !!ret && "t" in ret && ret.t === steps.length - 1;
    for (const v of steps.flatMap((s) => "put" in s ? [s.v] : "call" in s ? s.args : []).concat(ret && !onStack ? [ret] : [])) if ("t" in v) used.add(v.t);
    const local = (vt: VT) => {
      const k = taken.get(vt) ?? 0, pool = this.bodyLocals.get(vt) ?? this.bodyLocals.set(vt, []).get(vt)!;
      taken.set(vt, k + 1);
      return pool[k] ??= this.root.newLocal(vt);
    };
    const push = (v: Val, kind: Kind) => {
      if ("p" in v) this.get(kind, regs[v.p]);
      else if ("t" in v) c.lget(locals[v.t]);
      else if (kind === "L") c.anyNull(); else if (kind === "J") c.i64(BigInt(v.bits)); else c.i32(Number(v.bits));
    };
    steps.forEach((s, i) => {
      const kind = this.inFrame(m, s.pc, (): Kind | "V" => {
        if ("sget" in s) { const { owner, name, desc, kind } = s.sget.f; this.ensure(owner); c.gget(cx.staticGlobal(owner, name, desc)); return kind; }
        if ("get" in s) { this.fieldGet(s.get, regs[s.obj]); return s.get.f.kind; }
        if ("put" in s) { this.fieldPut(s.put, regs[s.obj], () => push(s.v, s.put.f.kind)); return "V"; }
        const u = s.call;
        if (u.isStatic) this.ensure(u.cls);
        if (isEmpty(this.bodyOf(u))) { cx.dependsOn(u); return "V"; }
        call(u, () => s.args.forEach((v, j) => push(v, j === 0 && !u.isStatic ? "L" : kindOf(u.params[j - (u.isStatic ? 0 : 1)]))));
        return u.ret === "V" ? "V" : kindOf(u.ret);
      });
      if (kind === "V" || onStack && i === steps.length - 1) return;
      if (used.has(i)) c.lset(locals[i] = local(cx.vtOf(kind))); else c.drop();
    });
    if (ret && !onStack) push(ret, kindOf(m.ret));
  }
  /** emits `emit` as code of `m`, run in place, at its `pc`: what it throws or calls carries a frame of `m` inside this method's (FnTrace.inline) */
  private inFrame<R>(m: MethodInfo, pc: number, emit: () => R): R {
    const c = this.code, at = c.pc, marks = c.marks.length;
    c.pc = inlineMark(this.root.inline?.length ?? 0);
    const r = emit();
    c.pc = at;
    if (c.marks.length !== marks) (this.root.inline ??= []).push([m, pc, at]);
    return r;
  }
  slotl = -1;
  slotLocal() { if (this.slotl < 0) this.slotl = this.code.newLocal(T.i32); return this.slotl; }
  vtl = -1;
  vtLocal() { if (this.vtl < 0) this.vtl = this.code.newLocal(ref(this.cx.tVT)); return this.vtl; }

  /** unary (0x7b-0x8f) and binary (0x90-0xe2) arithmetic, in the operand kinds infer.ts gives them */
  emitArith(ins: Ins) {
    const c = this.code, op = ins.op;
    if (op <= 0x8f) { const [from, to] = UNARY[op - 0x7b]; UNARY_CODE[op - 0x7b](c, () => this.num(from, ins.b)); this.setNum(to); return; }
    const lit = op >= 0xd0, li = op - (op >= 0xd8 ? 0xd8 : 0xd0), k = lit ? KI : binopKind(op), name = lit ? BINOPS[li] : binopName(op);
    const [x, y] = op >= 0xb0 && !lit ? [ins.a, ins.b] : [ins.b, ins.c];
    if (lit && li === 1) { c.i32(ins.c); this.num(KI, x); c.raw(OP.i32_sub); this.set("I"); return; } // rsub-int
    const fmod = name === "rem" && (k === KF || k === KD), wideShift = k === KJ && (name === "shl" || name === "shr" || name === "ushr");
    this.num(k, x);
    if (fmod && k === KF) c.raw(OP.f64_promote_f32);
    if (lit) c.i32(ins.c); else this.num(wideShift ? KI : k, y);
    if (fmod) { if (k === KF) c.raw(OP.f64_promote_f32); c.call(this.cx.imp.fmod); if (k === KF) c.raw(OP.f32_demote_f64); }
    // Wasm traps on a zero divisor and on MIN / -1, where Java throws or wraps: the helpers do as Java does, unless a literal rules both out
    else if ((name === "div" || name === "rem") && (k === KI || k === KJ) && !(lit && ins.c !== 0 && ins.c !== -1)) c.call(this.cx.helper((k === KI ? "i" : "l") + name));
    else { if (wideShift) c.raw(OP.i64_extend_i32_u); c.raw(WASM_BINOP[k][name]!); }
    this.setNum(k);
  }
}

/** pushes the arguments of `params` from the invoke's registers, the first at `ins.regs[from]` (past the receiver unless it is 0) */
function pushArgs(mc: MC, ins: Ins, params: string[], from = 1) {
  const regs = argRegisters(ins, params, from);
  for (let i = 0; i < regs.length; i++) mc.get(kindOf(params[i]), regs[i]);
}
