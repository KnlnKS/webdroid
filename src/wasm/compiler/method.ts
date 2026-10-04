import { Code, OP } from "./code";
import { T, ref, refNull, type VT } from "./wasmbin";
import { kindOf, type Kind, type MethodInfo } from "./program";
import type { Compiler } from "./j2w";
import { H, elemKindOf, type ElemKind } from "./consts";
import { descToName, parseMethodDesc, isWide } from "../../jvm/abi";
import { prepareMethod, endsBlock, ifTarget, switchCases, type PreparedInstruction as Ins, type PreparedMethod } from "../../jvm/prepared";
import { Flow, Go, structureAny } from "../../jvm/structure";
import { mid } from "./ids";
import { constClass, emitStoreCheck } from "../link/classes";
import { emitPolymorphic } from "./poly";
import { emitCustom } from "./custom";
import { failed, resolveFieldRef, resolveInvoke, typeFailure, type LinkFailure } from "./linkage";
import { analyze, cloneFacts, newFacts, step, type Facts } from "./facts";
import { inferTyping, F as KF, R as KR, J as KJ, D as KD, type Typing } from "./infer";

/** G1: floats and doubles live in f32/f64 locals, 30% faster than bits behind a reinterpret in TurboFan's steady state and equal in
 *  Liftoff (floatbench.ts); fields, arrays, calls and results keep the bits ABI. false puts them back in i32/i64 locals. */
const FLOAT_LOCALS = true;

export function compileMethod(cx: Compiler, m: MethodInfo): Code {
  const nparams = (m.isStatic ? 0 : 1) + m.params.length;
  const intr = cx.intrinsic(m);
  if (intr) { const c = new Code(nparams); intr(cx, m, c); return c; }
  if (!m.codeOff) { const c = new Code(nparams); cx.gap(c, `${mid(m)}: ${cx.natives.reason(m)}`); return c; }
  try {
    return new MC(cx, m).run();
  } catch (e) {
    const c = new Code(nparams); cx.gap(c, `${mid(m)}: ${(e as Error).message}`); return c;
  }
}

export class MC {
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
  constructor(public cx: Compiler, public m: MethodInfo) {
    this.dex = m.dex; this.item = m.dex.code(m.codeOff);
    this.code = new Code((m.isStatic ? 0 : 1) + m.params.length);
    this.tries = this.item.tries.length > 0;
  }

  // ---------- registers: each live range (web) has a local of its own kind
  storage(k: number): VT { return k === KR ? T.anyref : k === KJ || (k === KD && !FLOAT_LOCALS) ? T.i64 : k === KD ? T.f64 : k === KF && FLOAT_LOCALS ? T.f32 : T.i32; }
  local(web: number): number {
    let l = this.webLocal[web];
    if (l === undefined) this.webLocal[web] = l = this.code.newLocal(this.storage(this.typing.kind[web]));
    return l;
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
    if (FLOAT_LOCALS) { if (k === KF) c.raw(OP.i32_reinterpret_f32); else if (k === KD) c.raw(OP.i64_reinterpret_f64); }
  }
  /** pop a value in the bits ABI of `kind` into what `ins` (default: the current one) defines */
  set(kind: Kind, ins = this.cur): void {
    const w = this.typing.def(ins.pc), c = this.code;
    if (w >= 0) {
      const k = this.typing.kind[w];
      if (kind !== (k === KR ? "L" : k === KJ || k === KD ? "J" : "I")) throw new Error(`a ${kind} is defined as a ${k} at ${ins.pc}`);
      if (FLOAT_LOCALS) { if (k === KF) c.raw(OP.f32_reinterpret_i32); else if (k === KD) c.raw(OP.f64_reinterpret_i64); }
    }
    this.store(ins);
  }
  /** push a float or double operand as f32/f64 */
  f32(reg: number) { if (this.load(reg) !== KF) throw new Error(`v${reg} is not a float at ${this.cur.pc}`); if (!FLOAT_LOCALS) this.code.raw(OP.f32_reinterpret_i32); }
  f64(reg: number) { if (this.load(reg) !== KD) throw new Error(`v${reg} is not a double at ${this.cur.pc}`); if (!FLOAT_LOCALS) this.code.raw(OP.f64_reinterpret_i64); }
  /** pop an f32/f64 into what the current instruction defines */
  setF32() { if (!FLOAT_LOCALS && this.typing.def(this.cur.pc) >= 0) this.code.raw(OP.i32_reinterpret_f32); this.store(this.cur); }
  setF64() { if (!FLOAT_LOCALS && this.typing.def(this.cur.pc) >= 0) this.code.raw(OP.i64_reinterpret_f64); this.store(this.cur); }

  run(): Code {
    const { m, item, cx } = this, phase = cx.w.stats.phase;
    let t = performance.now();
    const lap = (name: keyof typeof phase) => { const n = performance.now(); phase[name] += n - t; t = n; };
    const prepared = this.prepared = prepareMethod(this.dex, item, m.desc, m.isStatic);
    lap("prepare");
    let flow: Flow;
    try { flow = structureAny(prepared, item, Infinity); } catch (e) { throw new Error(`unstructured: ${(e as Error).message}`); }
    this.flow = flow;
    lap("flow");
    this.typing = inferTyping(this.dex, item, m.desc, m.isStatic, prepared.instructions);
    lap("infer");
    // blocks
    let cur = -1;
    for (const ins of prepared.instructions) { if (prepared.leaders[ins.pc]) cur = flow.blockAt[ins.pc]; (this.blockIns[cur] ??= []).push(ins); }
    this.findShadows();
    this.entryFacts = analyze(this);
    lap("facts");
    const c = this.code;
    let reg = item.regs - item.ins, pi = 0;
    // a parameter's web uses the parameter's local, unless floats live in float locals: then it is copied in once
    const param = (wide: boolean) => {
      const w = this.typing.param(reg);
      if (w >= 0) {
        const k = this.typing.kind[w], native = FLOAT_LOCALS && (k === KF || k === KD);
        if (native) c.lget(pi).raw(k === KF ? OP.f32_reinterpret_i32 : OP.f64_reinterpret_i64).lset(this.local(w)); else this.webLocal[w] = pi;
      }
      pi++; reg += wide ? 2 : 1;
    };
    if (!m.isStatic) param(false);
    for (const p of m.params) param(isWide(p));
    if (this.tries) { this.pcLocal = c.newLocal(T.i32); this.excLocal = c.newLocal(T.anyref); }
    this.tmpL = c.newLocal(T.anyref);
    if (cx.counting) cx.emitCount(c, m);
    const regions = flow.regions;
    regions.forEach((r, i) => this.regionOfPc.set(flow.starts[r.entry], i));
    if (regions.length === 1 && !this.tries) {
      this.emitRegion(0);
      c.unreachable();
      return c;
    }
    this.regionLocal = c.newLocal(T.i32);
    if (!this.tries) this.excLocal = c.newLocal(T.anyref);
    this.push("$disp"); c.loop();
    if (this.tries) {
      this.push("$caught"); c.block(T.anyref);
      c.tryTable(null, [[0, cx.tag, 0]]); this.push("$try");
    }
    const n = regions.length;
    for (let k = n - 1; k >= 0; k--) { this.push("$R" + k); c.block(); }
    c.lget(this.regionLocal).brTable(Array.from({ length: n }, (_, k) => k), n - 1);
    for (let k = 0; k < n; k++) { this.pop(); c.end(); this.emitRegion(k); c.unreachable(); }
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
    return c;
  }
  push(l: string) { this.nest.push(l); }
  pop() { this.nest.pop(); }
  depth(label: string): number { const i = this.nest.lastIndexOf(label); if (i < 0) throw new Error("no label " + label); return this.nest.length - 1 - i; }
  blk(label: string, loop: boolean, bt: VT | null = null) {
    this.push(label);
    if (!loop) { this.code.block(bt); return; }
    this.code.loop(bt);
    if (this.cx.counting && label[0] === "L") this.cx.emitCount(this.code, this.m);
  }
  endBlk() { this.pop(); this.code.end(); }

  emitRegion(k: number) {
    const r = this.flow.regions[k];
    const open: { close: number }[] = []; let next = 0;
    for (let p = 0; p <= r.order.length; p++) {
      while (open.length && open[open.length - 1].close === p) { open.pop(); this.endBlk(); }
      for (; next < r.scopes.length && r.scopes[next].open === p; next++) { const s = r.scopes[next]; open.push(s); this.blk(s.label, s.loop); }
      if (p < r.order.length) this.emitBlock(r.order[p]);
    }
  }
  emitBlock(b: number) {
    const flow = this.flow, c = this.code, inss = this.blockIns[b];
    this.block = b;
    if (this.tries) c.i32(inss[0].pc).lset(this.pcLocal);
    this.facts = cloneFacts(this.entryFacts[b]);
    for (const ins of inss) { this.emit(ins); step(this, ins, this.facts); }
    const last = inss[inss.length - 1];
    if (!endsBlock(last.op)) {
      const taken = last.op >= 0x32 && last.op <= 0x3d ? flow.blockAt[ifTarget(last)] : -1;
      const target = flow.fallTarget(b, taken);
      if (target >= 0) this.jump(flow.starts[target], true);
    }
  }
  jump(targetPc: number, final: boolean) {
    const flow = this.flow, c = this.code, v = flow.blockAt[targetPc];
    switch (flow.go(this.block, v, final)) {
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
    const c = this.code, dex = this.dex;
    const dispatchTo = (addr: number) => { const ri = this.regionOfPc.get(addr); if (ri === undefined) throw new Error("handler not region entry"); c.i32(ri).lset(this.regionLocal).br(this.depth("$disp")); };
    for (const t of this.item.tries) {
      c.lget(this.pcLocal).i32(t.start).raw(OP.i32_ge_s).lget(this.pcLocal).i32(t.end).raw(OP.i32_lt_s).raw(OP.i32_and).if_(); this.push("if");
      for (const [ty, addr] of t.handlers) {
        const name = descToName(dex.type(ty));
        if (name === "java/lang/Throwable") { dispatchTo(addr); continue; }
        this.emitInstanceOfTest(name, () => c.lget(this.excLocal));
        c.if_(); this.push("if"); dispatchTo(addr); this.pop(); c.end();
      }
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
  /** pushes i32: obj (pushed by `obj`) is an instance of class/interface/array `name` (null -> 0) */
  emitInstanceOfTest(name: string, obj: () => void) { obj(); this.code.call(this.cx.instanceOfFn(name)); }
  /** push a non-null (ref null $Obj) of register `reg`, throwing NPE when null */
  nonNull(reg: number) {
    const c = this.code, cx = this.cx;
    if (this.facts.nonNull.has(this.useWeb(reg))) { this.get("L", reg); return; }
    this.get("L", reg); c.refIsNull().if_(); cx.callThrower(c, "npe"); c.end(); this.get("L", reg);
  }
  /** emit "ensure class initialized", unless an earlier instruction on every path to here has */
  ensure(cls: string) { this.cx.emitEnsure(this.code, cls, this.facts.inited); }
  /** the class whose initialization `ins` requests, as its translation does */
  ensureTarget(ins: Ins): string | undefined {
    const n = ins.name;
    if (n === "new-instance") { const name = descToName(this.dex.type(ins.b)); return this.cx.str.isString(name) ? undefined : name; }
    if (n.startsWith("sget") || n.startsWith("sput")) { const r = this.fieldOf(ins.b, true); return failed(r) ? undefined : r.f.owner; }
    if (n === "invoke-static" || n === "invoke-static/range") {
      const mr = this.dex.method(ins.b), decl = descToName(this.dex.type(mr.cls));
      return this.cx.prog.resolve(decl[0] === "[" ? "java/lang/Object" : decl, mr.name, this.dex.methodDesc(ins.b))?.cls;
    }
    return undefined;
  }
  isStringInit(ins: Ins): boolean {
    const mr = this.dex.method(ins.b);
    return mr.name === "<init>" && this.cx.str.isString(descToName(this.dex.type(mr.cls)));
  }
  /** whether the register `ins` defines surely holds a reference: an allocation, a constant, the exception caught, or a copy of one */
  definesNonNull(ins: Ins, f: Facts): boolean {
    const n = ins.name;
    if (n === "new-instance") return !this.cx.str.isString(descToName(this.dex.type(ins.b)));
    if (n === "const-string" || n === "const-string/jumbo" || n === "const-class" || n === "new-array" || n === "move-exception") return true;
    if (n.startsWith("move-object") || n === "check-cast") { const w = this.typing.use(ins.pc, n === "check-cast" ? ins.a : ins.b); return w >= 0 && f.nonNull.has(w); }
    return false;
  }
  /** the shadow key (see facts.ts) of the field access `ins` if its object is cast more than once in the method, else undefined */
  shadowKey(ins: Ins): string | undefined {
    if (!ins.name.startsWith("iget") && !ins.name.startsWith("iput")) return undefined;
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
      if (!ins.name.startsWith("iget") && !ins.name.startsWith("iput")) continue;
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
    const n = ins.name, c = this.code, cx = this.cx, dex = this.dex, a = ins.a, b = ins.b;
    if (this.consumed.has(ins.pc)) return;
    this.cur = ins; c.pc = ins.pc;
    if (!this.typing.reached(ins.pc)) { c.unreachable(); return; }
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
      case "return-void": c.ret(); return;
      case "return": this.get("I", a); c.ret(); return;
      case "return-wide": this.get("J", a); c.ret(); return;
      case "return-object": this.get("L", a); c.ret(); return;
      case "const/4": case "const/16": case "const": this.constNarrow(b); return;
      case "const/high16": this.constNarrow(b << 16); return;
      case "const-wide/16": case "const-wide/32": this.constWide(BigInt(b)); return;
      case "const-wide": this.constWide(ins.wideLit); return;
      case "const-wide/high16": this.constWide(BigInt(b) << 48n); return;
      case "const-class": if (this.unresolved(dex.type(b))) return; constClass(cx, c, descToName(dex.type(b))); this.set("L"); return;
      case "const-string": case "const-string/jumbo": cx.str.literal(c, dex.string(b)); this.set("L"); return;
      case "const-method-handle": case "const-method-type":
        cx.gap(c, `${mid(this.m)}: ${ins.name}`); return;
      case "monitor-enter": case "monitor-exit": this.nonNull(a); c.drop(); return;
      case "check-cast": {
        if (this.unresolved(dex.type(b))) return;
        const name = descToName(dex.type(b));
        // the cast value is a definition of its own: a web other than the operand's needs the reference copied in
        if (name === "java/lang/Object") { if (this.typing.def(ins.pc) >= 0 && this.typing.def(ins.pc) !== this.useWeb(a)) { this.get("L", a); this.set("L"); } return; }
        this.get("L", a); c.call(cx.castFn(name)); this.set("L"); return;
      }
      case "instance-of": if (this.unresolved(dex.type(ins.c))) return; this.get("L", ins.b); c.call(cx.instanceOfFn(descToName(dex.type(ins.c)))); this.set("I"); return;
      case "array-length": {
        // any array wrapper has the data array in field 2; use the ref wrapper type check-free via per-kind unknown -> test kinds
        this.arrayLength(b); this.set("I"); return;
      }
      case "new-instance": {
        if (this.unresolved(dex.type(b))) return;
        const name = descToName(dex.type(b));
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
        c.gget(cx.vtGlobal(desc)).refAsNonNull().i32(0);
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
    if (n.startsWith("aget")) return this.emitAget(ins);
    if (n.startsWith("aput")) return this.emitAput(ins);
    if (n.startsWith("iget")) return this.emitIget(ins);
    if (n.startsWith("iput")) return this.emitIput(ins);
    if (n.startsWith("sget") || n.startsWith("sput")) return this.emitStatic(ins);
    if (n.startsWith("invoke")) return this.emitInvoke(ins);
    this.emitArith(ins);
  }
  /** a 32-bit constant: an int, float bits, or (zero) null, as its web's kind says */
  constNarrow(v: number) {
    const w = this.typing.def(this.cur.pc), c = this.code;
    if (w < 0) return;
    const k = this.typing.kind[w];
    if (k === KR) { if (v) throw new Error(`reference constant ${v} at ${this.cur.pc}`); c.anyNull(); }
    else if (k === KF && FLOAT_LOCALS) c.f32const(v);
    else c.i32(v);
    this.store(this.cur);
  }
  constWide(v: bigint) {
    const w = this.typing.def(this.cur.pc);
    if (w < 0) return;
    this.typing.kind[w] === KD && FLOAT_LOCALS ? this.code.f64const(v) : this.code.i64(v);
    this.store(this.cur);
  }
  arrayLength(reg: number) {
    const cx = this.cx, c = this.code;
    // arrays of all kinds: dispatch on the wrapper type (the verifier gives no static element type here)
    this.nonNull(reg); c.lset(this.tmpL);
    const kinds: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      if (i < kinds.length - 1) { c.lget(this.tmpL).refTest(cx.tArr[k]).if_(T.i32); } 
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
  /** leaves the data array of array register `reg` in tmp local ... returns local holding (ref $Data) */
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
    const c = this.code, cx = this.cx, { k } = this.elemOf(ins.name), d = this.dloc(k);
    this.nonNull(ins.b); c.lset(this.tmpL);
    c.lget(this.tmpL).refCast(cx.tArr[k]).structGet(cx.tArr[k], 2).lset(d);
    this.idxCheck(k, ins.c);
    if (k === "ref") emitStoreCheck(cx, c, this.tmpL, () => this.get("L", ins.a));
    c.lget(d); this.get("I", ins.c);
    this.get(k === "ref" ? "L" : k === "i64" ? "J" : "I", ins.a);
    c.arraySet(cx.tData[k]);
  }
  fieldOf(idx: number, isStatic: boolean) { return resolveFieldRef(this.cx.prog, this.dex, idx, isStatic, this.m.cls); }
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
    const labelled = cases.every(([, t]) => { const g = flow.go(this.block, flow.blockAt[t], false); return g === Go.Break || g === Go.Continue; });
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
    const c = this.code, insts = this.prepared.instructions;
    const idx = insts.indexOf(ins); const nx = insts[idx + 1];
    if (kind === "V") return;
    if (nx && nx.name.startsWith("move-result") && !this.prepared.leaders[nx.pc]) { this.consumed.add(nx.pc); this.set(kind, nx); }
    else c.drop();
  }
  /** an invoke the compiler cannot translate: the code after it is dead, so a move-result stays unwritten */
  invokeGap(ins: Ins, why: string) {
    this.consumeResult(ins);
    this.cx.gap(this.code, `${mid(this.m)}: ${why}`);
  }
  consumeResult(ins: Ins) {
    const insts = this.prepared.instructions, nx = insts[insts.indexOf(ins) + 1];
    if (nx?.name.startsWith("move-result") && !this.prepared.leaders[nx.pc]) this.consumed.add(nx.pc);
  }
  emitInvoke(ins: Ins) {
    const cx = this.cx, c = this.code, dex = this.dex, prog = cx.prog;
    const kind = ins.name.replace("/range", "");
    if (kind === "invoke-custom") return emitCustom(this, ins);
    if (kind === "invoke-polymorphic") return emitPolymorphic(this, ins);
    const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), declared = descToName(dex.type(mr.cls)), key = mr.name + desc;
    // an array's methods are Object's, except clone, which copies the array
    const decl = declared[0] === "[" ? "java/lang/Object" : declared;
    const p = parseMethodDesc(desc), retK: Kind | "V" = p.ret === "V" ? "V" : kindOf(p.ret);
    const isStatic = kind === "invoke-static";
    const pushArgs = () => {
      let ri = isStatic ? 0 : 1;
      for (const pt of p.params) { this.get(kindOf(pt), ins.regs[ri]); ri += isWide(pt) ? 2 : 1; }
    };
    const sigIdx = () => { const ps: Kind[] = isStatic ? [] : ["L"]; for (const pt of p.params) ps.push(kindOf(pt)); return cx.sig(ps, retK); };
    if (declared !== decl && key === "clone()Ljava/lang/Object;") { this.nonNull(ins.regs[0]); cx.callRt(c, "aclone"); this.finishResult(ins, "L"); return; }
    const target = resolveInvoke(prog, kind, declared, mr.name, desc, this.m.cls);
    if (failed(target)) { this.consumeResult(ins); this.linkFail(target); return; }
    if (isStatic) {
      const t = target;
      this.ensure(t.cls); pushArgs(); cx.callMethod(c, t);
    } else if (kind === "invoke-direct" && cx.str.isString(decl) && mr.name === "<init>") {
      const make = cx.str.factory(desc);
      if (make === undefined) { this.invokeGap(ins, `String.<init>${desc}`); return; }
      pushArgsFrom(this, ins, p.params); c.call(make); c.lset(this.local(this.useWeb(ins.regs[0]))); return;
    } else if (kind === "invoke-direct" || kind === "invoke-super") {
      const t = target;
      this.nonNull(ins.regs[0]); pushArgsFrom(this, ins, p.params); cx.callMethod(c, t);
    } else {
      // virtual / interface: devirtualise when class-hierarchy analysis finds one implementation
      const only = cx.devirt(decl, mr.name, desc), declC = prog.get(decl);
      if (only !== "many") { this.nonNull(ins.regs[0]); pushArgsFrom(this, ins, p.params); cx.callMethod(c, only); }
      else {
        // the slot the receiver's class gives the method; a call that expects one of the likely implementations tests for it first, so the engine can inline it
        const guards = cx.guards(decl, mr.name, desc), recv = () => { c.lget(this.tmpL); pushArgsFrom(this, ins, p.params); };
        this.nonNull(ins.regs[0]); c.lset(this.tmpL);
        recv();
        c.lget(this.tmpL); cx.str.vtab(c, decl);
        if (declC && !declC.isInterface) {
          c.i32(cx.w.vslot(decl, key)).arrayGet(cx.tVT);
        } else if (prog.get("java/lang/Object")!.byKey.has(key)) {
          c.i32(cx.w.vslot("java/lang/Object", key)).arrayGet(cx.tVT);
        } else {
          const sel = cx.w.selectorId(key), s = sel % H.IMT_N;
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
          for (const g of guards) { c.lget(slot).i32(cx.w.slotOf(g)).raw(OP.i32_eq).ifType(type).call(cx.fn.get(mid(g))!).else_(); }
          c.lget(slot).callIndirect(type);
          for (const _ of guards) c.end();
        } else c.callIndirect(sigIdx());
      }
    }
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
      const map: Record<string, number> = { add: OP.i32_add, sub: OP.i32_sub, mul: OP.i32_mul, and: OP.i32_and, or: OP.i32_or, xor: OP.i32_xor, shl: OP.i32_shl, shr: OP.i32_shr_s, ushr: OP.i32_shr_u };
      if (n === "rsub-int" || n.startsWith("rsub-int")) { c.i32(ins.c); this.get("I", b); c.raw(OP.i32_sub); this.set("I"); return; }
      if (opn === "div" || opn === "rem") {
        const direct = lit && ins.c !== 0 && ins.c !== -1;
        X(); Y();
        if (direct) c.raw(opn === "div" ? OP.i32_div_s : OP.i32_rem_s); else c.call(cx.helper(opn === "div" ? "idiv" : "irem"));
        this.set("I"); return;
      }
      X(); Y(); c.raw(map[opn]); this.set("I"); return;
    }
    if (type === "long") {
      const map: Record<string, number> = { add: OP.i64_add, sub: OP.i64_sub, mul: OP.i64_mul, and: OP.i64_and, or: OP.i64_or, xor: OP.i64_xor };
      if (opn === "shl" || opn === "shr" || opn === "ushr") {
        X(); this.get("I", yr); c.raw(OP.i64_extend_i32_u, opn === "shl" ? OP.i64_shl : opn === "shr" ? OP.i64_shr_s : OP.i64_shr_u); this.set("J"); return;
      }
      if (opn === "div" || opn === "rem") { X(); Y(); c.call(cx.helper(opn === "div" ? "ldiv" : "lrem")); this.set("J"); return; }
      X(); Y(); c.raw(map[opn]); this.set("J"); return;
    }
    // float/double
    if (opn === "rem") {
      if (type === "float") { X(); c.raw(OP.f64_promote_f32); Y(); c.raw(OP.f64_promote_f32).call(cx.imp.fmod).raw(OP.f32_demote_f64); }
      else { X(); Y(); c.call(cx.imp.fmod); }
      fin(); return;
    }
    const f32 = { add: OP.f32_add, sub: OP.f32_sub, mul: OP.f32_mul, div: OP.f32_div } as Record<string, number>;
    const f64 = { add: OP.f64_add, sub: OP.f64_sub, mul: OP.f64_mul, div: OP.f64_div } as Record<string, number>;
    X(); Y(); c.raw((type === "float" ? f32 : f64)[opn]); fin();
  }
}

function pushArgsFrom(mc: MC, ins: Ins, params: string[]) {
  let ri = 1;
  for (const pt of params) { mc.get(kindOf(pt), ins.regs[ri]); ri += isWide(pt) ? 2 : 1; }
}
