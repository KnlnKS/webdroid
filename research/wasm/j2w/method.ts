import { Code, OP } from "./code";
import { T, refNull, type VT } from "./wasmbin";
import { ACC, kindOf, type Kind, type MethodInfo } from "./program";
import type { Compiler } from "./j2w";
import { H, elemKindOf, type ElemKind } from "./consts";
import { descToName, parseMethodDesc, isWide } from "../../../src/jvm/abi";
import { prepareMethod, branchTargets, endsBlock, ifTarget, switchCases, type PreparedInstruction as Ins, type PreparedMethod } from "../../../src/jvm/prepared";
import { structure, Go, type Flow } from "../../../src/jvm/structure";
import { mid } from "./reach";

export function compileMethod(cx: Compiler, m: MethodInfo): number[] {
  const nparams = (m.isStatic ? 0 : 1) + m.params.length;
  const intr = cx.intrinsic(m);
  if (intr) { const c = new Code(nparams); intr(cx, m, c); return c.finish(); }
  if (!m.codeOff) { const c = new Code(nparams); cx.gap(c, `${mid(m)}: ${cx.natives.reason(m)}`); return c.finish(); }
  try {
    // locals of a kind are only written when some instruction reads them: iterate the read set down to a fixpoint
    let rk: Set<string> | null = null;
    for (;;) {
      const mc = new MC(cx, m, rk); const body = mc.run();
      if (rk?.size === mc.reads.size) { cx.stats.methods++; cx.stats.bodyBytes += body.length; return body; }
      rk = mc.reads;
    }
  } catch (e) {
    if ((e as Error).message === "unstructured") cx.stats.unstructured++;
    const c = new Code(nparams); cx.gap(c, `${mid(m)}: ${(e as Error).message}`); return c.finish();
  }
}

const KS = { Z: 1, I: 2, L: 3, W: 4, X: 5 };
class MC {
  code: Code; prepared!: PreparedMethod; flow!: Flow; item; dex;
  reads = new Set<string>();
  locals = new Map<string, number>();
  nest: string[] = [];
  block = 0;
  regionLocal = -1; pcLocal = -1; excLocal = -1; tmpL = -1;
  blockIns: Ins[][] = [];
  consumed = new Set<number>();            // move-result pcs folded into their invoke
  kinds = new Map<number, Uint8Array>();   // pc -> pre-state of operand kinds (for if/move)
  tries: boolean;
  regionOfPc = new Map<number, number>();
  constructor(public cx: Compiler, public m: MethodInfo, public readKinds: Set<string> | null) {
    this.dex = m.dex; this.item = m.dex.code(m.codeOff);
    this.code = new Code((m.isStatic ? 0 : 1) + m.params.length);
    this.tries = this.item.tries.length > 0;
  }
  rk(kind: Kind, reg: number): boolean { return !this.readKinds || this.readKinds.has(kind + reg); }
  loc(kind: Kind, reg: number): number {
    const k = kind + reg; let l = this.locals.get(k);
    if (l === undefined) { l = this.code.newLocal(this.cx.vtOf(kind)); this.locals.set(k, l); }
    return l;
  }
  get(kind: Kind, reg: number): void { this.reads.add(kind + reg); this.code.lget(this.loc(kind, reg)); }
  set(kind: Kind, reg: number): void { this.code.lset(this.loc(kind, reg)); }

  run(): number[] {
    const { m, item, cx } = this;
    const prepared = this.prepared = prepareMethod(this.dex, item, m.desc, m.isStatic);
    const flow = structure(prepared, item);
    if (!flow) throw new Error("unstructured");
    this.flow = flow;
    this.analyzeKinds();
    // blocks
    let cur = -1;
    for (const ins of prepared.instructions) { if (prepared.leaders[ins.pc]) cur = flow.blockAt[ins.pc]; (this.blockIns[cur] ??= []).push(ins); }
    const c = this.code;
    let reg = item.regs - item.ins, pi = 0;
    if (!m.isStatic) this.locals.set("L" + reg++, pi++);
    for (const p of m.params) { this.locals.set(kindOf(p) + reg, pi++); reg += isWide(p) ? 2 : 1; }
    if (this.tries) { this.pcLocal = c.newLocal(T.i32); this.excLocal = c.newLocal(T.anyref); }
    this.tmpL = c.newLocal(T.anyref);
    const regions = flow.regions;
    regions.forEach((r, i) => this.regionOfPc.set(flow.starts[r.entry], i));
    if (regions.length === 1 && !this.tries) {
      this.emitRegion(0);
      c.unreachable();
      return c.finish();
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
    return c.finish();
  }
  push(l: string) { this.nest.push(l); }
  pop() { this.nest.pop(); }
  depth(label: string): number { const i = this.nest.lastIndexOf(label); if (i < 0) throw new Error("no label " + label); return this.nest.length - 1 - i; }
  blk(label: string, loop: boolean, bt: VT | null = null) { this.push(label); loop ? this.code.loop(bt) : this.code.block(bt); }
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
    for (const ins of inss) this.emit(ins);
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
    const c = this.code, cx = this.cx, dex = this.dex;
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
  /** pushes i32: obj (pushed by `obj`) is an instance of class/interface/array `name` (null -> 0) */
  emitInstanceOfTest(name: string, obj: () => void) {
    const cx = this.cx, c = this.code, id = cx.classId.get(name);
    if (name === "java/lang/Object") { obj(); c.refIsNull().raw(OP.i32_eqz); return; }
    if (name[0] === "[") {
      const ek = elemKindOf(name);
      if (ek === "ref") { obj(); c.refTest(cx.tArr.ref); }
      else { obj(); c.i32(id!).i32(1).call(cx.helpers.iof); }
      return;
    }
    const jc = cx.prog.get(name);
    if (id === undefined) { c.i32(0); return; }
    obj();
    if (jc?.isInterface) c.i32(id).call(cx.helpers.implements);
    else c.i32(id).i32(cx.prog.chain(name).length - 1).call(cx.helpers.iof);
  }
  /** push a non-null (ref null $Obj) of register `reg`, throwing NPE when null */
  nonNull(reg: number) {
    const c = this.code, cx = this.cx;
    this.get("L", reg); c.refIsNull().if_().call(cx.helpers.npe).end(); this.get("L", reg);
  }
  refTo(reg: number, struct: number) { this.nonNull(reg); this.code.refCast(struct); }

  // ---------- kind analysis for if-eq/ne and moves
  analyzeKinds() {
    const { prepared, item, dex, m } = this, nregs = item.regs;
    const blocks = new Map<number, Ins[]>(); let cur: Ins[] = [];
    for (const ins of prepared.instructions) { if (prepared.leaders[ins.pc]) { cur = []; blocks.set(ins.pc, cur); } cur.push(ins); }
    const entry = new Map<number, Uint8Array>();
    const init = new Uint8Array(nregs);
    let reg = nregs - item.ins;
    if (!m.isStatic) init[reg++] = KS.L;
    for (const p of m.params) { init[reg] = kindOf(p) === "L" ? KS.L : kindOf(p) === "J" ? KS.W : KS.I; reg += isWide(p) ? 2 : 1; }
    const join = (a: number, b: number) => a === b ? a : a === 0 ? b : b === 0 ? a : a === KS.Z ? b : b === KS.Z ? a : KS.X;
    const merge = (pc: number, st: Uint8Array): boolean => {
      const old = entry.get(pc);
      if (!old) { entry.set(pc, st.slice()); return true; }
      let ch = false; for (let i = 0; i < nregs; i++) { const j = join(old[i], st[i]); if (j !== old[i]) { old[i] = j; ch = true; } }
      return ch;
    };
    merge(0, init);
    const work = [0];
    const handlers = (pc: number) => { const out: number[] = []; for (const t of item.tries) if (pc >= t.start && pc < t.end) { for (const [, a] of t.handlers) out.push(a); if (t.catchAllAddr >= 0) out.push(t.catchAllAddr); } return out; };
    let guard = 0;
    while (work.length && guard++ < 100000) {
      const pc0 = work.pop()!, st = entry.get(pc0)!.slice();
      let ret = 0;
      for (const ins of blocks.get(pc0)!) {
        if ((ins.name === "if-eq" || ins.name === "if-ne" || ins.name === "if-eqz" || ins.name === "if-nez" || ins.name.startsWith("move") && !ins.name.startsWith("move-result") && !ins.name.startsWith("move-exception"))) this.kinds.set(ins.pc, st.slice());
        for (const h of handlers(ins.pc)) if (merge(h, st)) work.push(h);
        this.transfer(ins, st, (r) => { ret = r; }, () => ret);
      }
      const last = blocks.get(pc0)!.at(-1)!;
      const succ = [...branchTargets(item, last)]; if (!endsBlock(last.op)) succ.push(last.pc + last.len);
      for (const s of succ) if (blocks.has(s) && merge(s, st)) work.push(s);
    }
  }
  transfer(ins: Ins, st: Uint8Array, setRet: (r: number) => void, getRet: () => number) {
    const n = ins.name, dex = this.dex, a = ins.a;
    const w = (r: number, k: number) => { st[r] = k; };
    const ww = (r: number) => { st[r] = KS.W; if (r + 1 < st.length) st[r + 1] = KS.W; };
    if (n.startsWith("move-result")) { const k = n === "move-result-object" ? KS.L : n === "move-result" ? KS.I : KS.W; if (k === KS.W) ww(a); else w(a, getRet() === KS.Z ? KS.I : k); return; }
    if (n === "move-exception") return w(a, KS.L);
    if (n.startsWith("move-object")) return w(a, KS.L);
    if (n.startsWith("move-wide")) return ww(a);
    if (n.startsWith("move")) return w(a, st[ins.b]);
    if (n === "const/4" || n === "const/16" || n === "const") return w(a, ins.b === 0 ? KS.Z : KS.I);
    if (n === "const/high16") return w(a, ins.b === 0 ? KS.Z : KS.I);
    if (n.startsWith("const-wide")) return ww(a);
    if (n.startsWith("const-string") || n === "const-class") return w(a, KS.L);
    if (n === "instance-of" || n === "array-length" || n.startsWith("cmp")) return w(a, KS.I);
    if (n === "new-instance" || n === "new-array" || n === "check-cast") return w(a, KS.L);
    if (n.startsWith("aget")) return n === "aget-object" ? w(a, KS.L) : n === "aget-wide" ? ww(a) : w(a, KS.I);
    if (n.startsWith("iget") || n.startsWith("sget")) {
      const fr = dex.field(n.startsWith("iget") ? ins.c : ins.b); const t = dex.type(fr.type); const k = kindOf(t);
      return k === "L" ? w(a, KS.L) : k === "J" ? ww(a) : w(a, KS.I);
    }
    if (n.startsWith("invoke")) {
      let ret = "V";
      if (n.startsWith("invoke-polymorphic")) ret = dex.type(dex.proto(ins.c).ret); else if (n.startsWith("invoke-custom")) ret = "V";
      else ret = dex.type(dex.proto(dex.method(ins.b).proto).ret);
      setRet(ret === "V" ? 0 : kindOf(ret) === "L" ? KS.L : kindOf(ret) === "J" ? KS.W : KS.I); return;
    }
    if (n === "filled-new-array" || n === "filled-new-array/range") { setRet(KS.L); return; }
    const op = ins.op;
    if (op >= 0x7b && op <= 0xe2) {
      // arithmetic/conversions: result kind by name suffix
      if (n.endsWith("long") || n.includes("-long") && !n.startsWith("long-to-int") && !n.startsWith("long-to-float")) { }
      const wide = /(^neg-long|^not-long|^neg-double|-to-long|-to-double|-long(\/2addr)?$|-double(\/2addr)?$)/.test(n);
      return wide ? ww(a) : w(a, KS.I);
    }
  }

  // ---------- instruction emission
  isRef(ins: Ins, reg: number): boolean | undefined {
    const st = this.kinds.get(ins.pc); if (!st) return undefined; const k = st[reg]; return k === KS.L ? true : k === KS.Z || k === KS.I ? false : undefined;
  }
  f32(reg: number) { this.get("I", reg); this.code.raw(OP.f32_reinterpret_i32); }
  f64(reg: number) { this.get("J", reg); this.code.raw(OP.f64_reinterpret_i64); }
  emit(ins: Ins) {
    const n = ins.name, c = this.code, cx = this.cx, dex = this.dex, a = ins.a, b = ins.b;
    if (this.consumed.has(ins.pc)) return;
    switch (n) {
      case "nop": return;
      case "move": case "move/from16": case "move/16": {
        const ref = this.isRef(ins, b);
        if (ref !== true && this.rk("I", a)) { this.get("I", b); this.set("I", a); }
        if (ref !== false && this.rk("L", a)) { this.get("L", b); this.set("L", a); }
        return;
      }
      case "move-wide": case "move-wide/from16": case "move-wide/16": this.get("J", b); this.set("J", a); return;
      case "move-object": case "move-object/from16": case "move-object/16": this.get("L", b); this.set("L", a); return;
      case "move-result": case "move-result-wide": case "move-result-object": throw new Error("move-result without invoke at " + ins.pc);
      case "move-exception": c.lget(this.excLocal); this.set("L", a); return;
      case "return-void": c.ret(); return;
      case "return": this.get("I", a); c.ret(); return;
      case "return-wide": this.get("J", a); c.ret(); return;
      case "return-object": this.get("L", a); c.ret(); return;
      case "const/4": case "const/16": case "const": this.constI(a, b); return;
      case "const/high16": this.constI(a, b << 16); return;
      case "const-wide/16": case "const-wide/32": c.i64(BigInt(b)); this.set("J", a); return;
      case "const-wide": c.i64(ins.wideLit); this.set("J", a); return;
      case "const-wide/high16": c.i64(BigInt(b) << 48n); this.set("J", a); return;
      case "const-string": case "const-string/jumbo": cx.str.literal(c, dex.string(b)); this.set("L", a); return;
      case "const-class": case "const-method-handle": case "const-method-type":
        cx.gap(c, `${mid(this.m)}: ${ins.name}`); return;
      case "monitor-enter": case "monitor-exit": this.nonNull(a); c.drop(); return;
      case "check-cast": {
        const name = descToName(dex.type(b));
        if (name === "java/lang/Object") return;
        this.get("L", a); c.refIsNull().raw(OP.i32_eqz).if_();
        this.emitInstanceOfTest(name, () => this.get("L", a)); c.raw(OP.i32_eqz).if_().call(cx.helpers.cce).end().end();
        return;
      }
      case "instance-of": {
        this.get("L", ins.b); c.refIsNull().if_(T.i32).i32(0).else_();
        this.emitInstanceOfTest(descToName(dex.type(ins.c)), () => this.get("L", ins.b)); c.end(); this.set("I", a); return;
      }
      case "array-length": {
        // any array wrapper has the data array in field 2; use the ref wrapper type check-free via per-kind unknown -> test kinds
        this.arrayLength(b); this.set("I", a); return;
      }
      case "new-instance": {
        const name = descToName(dex.type(b));
        // a String is made by the constructor call (below), which assigns its register
        if (cx.str.isString(name)) c.anyNull(); else { cx.emitEnsure(c, name); cx.emitNew(c, name); }
        this.set("L", a); return;
      }
      case "new-array": {
        const desc = dex.type(ins.c), ek = elemKindOf(desc), vtg = cx.vtGlobal.get(desc);
        if (vtg === undefined) throw new Error("array class missing " + desc);
        this.get("I", ins.b); c.i32(0).raw(OP.i32_lt_s).if_().call(cx.helpers.nase).end();
        c.gget(vtg).refAsNonNull().i32(0); this.get("I", ins.b); c.arrayNewDefault(cx.tData[ek]).structNew(cx.tArr[ek]); this.set("L", a); return;
      }
      case "filled-new-array": case "filled-new-array/range": {
        const desc = dex.type(b), ek = elemKindOf(desc), vtg = cx.vtGlobal.get(desc)!;
        c.gget(vtg).refAsNonNull().i32(0);
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
      case "cmpl-float": this.f32(b); this.f32(ins.c); c.call(cx.helpers.cmplf); this.set("I", a); return;
      case "cmpg-float": this.f32(b); this.f32(ins.c); c.call(cx.helpers.cmpgf); this.set("I", a); return;
      case "cmpl-double": this.f64(b); this.f64(ins.c); c.call(cx.helpers.cmpld); this.set("I", a); return;
      case "cmpg-double": this.f64(b); this.f64(ins.c); c.call(cx.helpers.cmpgd); this.set("I", a); return;
      case "cmp-long": this.get("J", b); this.get("J", ins.c); c.raw(0x55); this.get("J", b); this.get("J", ins.c); c.raw(OP.i64_lt_s).raw(OP.i32_sub); this.set("I", a); return;
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
  constI(a: number, v: number) {
    const c = this.code;
    if (this.rk("I", a)) { c.i32(v); this.set("I", a); }
    if (v === 0 && this.rk("L", a)) { c.anyNull(); this.set("L", a); }
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
  dloc(k: ElemKind): number { let l = this.dataLocal.get(k); if (l === undefined) { l = this.code.newLocal(refNull(this.cx.tData[k])); this.dataLocal.set(k, l); } return l; }
  idxCheck(k: ElemKind, idxReg: number) {
    const c = this.code, d = this.dloc(k);
    this.get("I", idxReg); c.lget(d).refAsNonNull().arrayLen().raw(OP.i32_ge_u).if_().call(this.cx.helpers.aioobe).end();
  }
  emitAget(ins: Ins) {
    const c = this.code, cx = this.cx, { k, sign } = this.elemOf(ins.name), d = this.dloc(k);
    this.nonNull(ins.b); c.refCast(cx.tArr[k]).structGet(cx.tArr[k], 2).lset(d);
    this.idxCheck(k, ins.c);
    c.lget(d).refAsNonNull(); this.get("I", ins.c);
    sign === "s" ? c.arrayGetS(cx.tData[k]) : sign === "u" ? c.arrayGetU(cx.tData[k]) : c.arrayGet(cx.tData[k]);
    this.set(k === "ref" ? "L" : k === "i64" ? "J" : "I", ins.a);
  }
  emitAput(ins: Ins) {
    const c = this.code, cx = this.cx, { k } = this.elemOf(ins.name), d = this.dloc(k);
    this.nonNull(ins.b); c.refCast(cx.tArr[k]).structGet(cx.tArr[k], 2).lset(d);
    this.idxCheck(k, ins.c);
    c.lget(d).refAsNonNull(); this.get("I", ins.c);
    this.get(k === "ref" ? "L" : k === "i64" ? "J" : "I", ins.a);
    c.arraySet(cx.tData[k]);
  }
  fieldOf(idx: number) {
    const fr = this.dex.field(idx), decl = descToName(this.dex.type(fr.cls)), desc = this.dex.type(fr.type);
    const f = this.cx.prog.resolveField(decl, fr.name, desc);
    if (!f) throw new Error(`field not found ${decl}.${fr.name}`);
    return { decl, f };
  }
  emitIget(ins: Ins) {
    const cx = this.cx, c = this.code, { decl, f } = this.fieldOf(ins.c), st = cx.structFor(decl);
    cx.str.noFields(decl, f.name);
    this.refTo(ins.b, st); c.structGet(st, cx.fieldIndex(decl, f)); this.set(f.kind, ins.a);
  }
  emitIput(ins: Ins) {
    const cx = this.cx, c = this.code, { decl, f } = this.fieldOf(ins.c), st = cx.structFor(decl);
    cx.str.noFields(decl, f.name);
    this.refTo(ins.b, st); this.get(f.kind, ins.a); c.structSet(st, cx.fieldIndex(decl, f));
  }
  emitStatic(ins: Ins) {
    const cx = this.cx, c = this.code, put = ins.name.startsWith("sput"), { f } = this.fieldOf(ins.b);
    cx.emitEnsure(c, f.owner);
    cx.declareStatic(f.owner, f.name);
    const g = cx.staticGlobal.get(f.owner + "." + f.name)!;
    if (put) { this.get(f.kind, ins.a); c.gset(g); } else { c.gget(g); this.set(f.kind, ins.a); }
  }
  emitIf(ins: Ins) {
    const c = this.code, flow = this.flow, target = ifTarget(ins), n = ins.name;
    const refA = n === "if-eq" || n === "if-ne" ? (this.isRef(ins, ins.a) || this.isRef(ins, ins.b)) : (n === "if-eqz" || n === "if-nez") ? this.isRef(ins, ins.a) : false;
    const cond = () => {
      switch (n) {
        case "if-eq": case "if-ne":
          if (refA) { this.get("L", ins.a); this.get("L", ins.b); c.call(this.cx.helpers.acmp); } else { this.get("I", ins.a); this.get("I", ins.b); c.raw(OP.i32_eq); }
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
    const c = this.code, cases = switchCases(this.item, ins);
    // compare chain (br_table is a later optimisation)
    for (const [key, target] of cases) {
      this.get("I", ins.a); c.i32(key).raw(OP.i32_eq).if_(); this.push("if"); this.jump(target, false); this.pop(); c.end();
    }
  }
  finishResult(ins: Ins, kind: Kind | "V") {
    // fold a following move-result into the producer
    const c = this.code, insts = this.prepared.instructions;
    const idx = insts.indexOf(ins); const nx = insts[idx + 1];
    if (kind === "V") return;
    if (nx && nx.name.startsWith("move-result") && !this.prepared.leaders[nx.pc]) { this.consumed.add(nx.pc); this.set(kind, nx.a); }
    else c.drop();
  }
  /** an invoke the compiler cannot translate: the code after it is dead, so a move-result stays unwritten */
  invokeGap(ins: Ins, why: string) {
    const insts = this.prepared.instructions, nx = insts[insts.indexOf(ins) + 1];
    if (nx?.name.startsWith("move-result") && !this.prepared.leaders[nx.pc]) this.consumed.add(nx.pc);
    this.cx.gap(this.code, `${mid(this.m)}: ${why}`);
  }
  emitInvoke(ins: Ins) {
    const cx = this.cx, c = this.code, dex = this.dex, prog = cx.prog;
    const kind = ins.name.replace("/range", "");
    if (kind === "invoke-polymorphic" || kind === "invoke-custom") { this.invokeGap(ins, kind); return; }
    const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), decl = descToName(dex.type(mr.cls)), key = mr.name + desc;
    const p = parseMethodDesc(desc), retK: Kind | "V" = p.ret === "V" ? "V" : kindOf(p.ret);
    const isStatic = kind === "invoke-static";
    const pushArgs = () => {
      let ri = isStatic ? 0 : 1;
      for (const pt of p.params) { this.get(kindOf(pt), ins.regs[ri]); ri += isWide(pt) ? 2 : 1; }
    };
    const sigIdx = () => { const ps: Kind[] = isStatic ? [] : ["L"]; for (const pt of p.params) ps.push(kindOf(pt)); return cx.sig(ps, retK); };
    if (decl[0] === "[") { this.invokeGap(ins, `array method ${key}`); return; }
    const callDirect = (mi: MethodInfo) => { cx.declareMethod(mi); c.call(cx.fnOf(mi)); };
    if (isStatic) {
      const t = prog.resolve(decl, mr.name, desc); if (!t) throw new Error("unresolved static " + decl + "." + key);
      cx.emitEnsure(c, t.cls); pushArgs(); c.call(cx.fnOf(t));
    } else if (kind === "invoke-direct" && cx.str.isString(decl) && mr.name === "<init>") {
      const make = cx.str.factory(desc);
      if (make === undefined) { this.invokeGap(ins, `String.<init>${desc}`); return; }
      pushArgsFrom(this, ins, p.params); c.call(make); this.set("L", ins.regs[0]); return;
    } else if (kind === "invoke-direct" || kind === "invoke-super") {
      const t = kind === "invoke-super" ? prog.resolve(prog.get(this.m.cls)?.isInterface ? decl : prog.get(this.m.cls)!.sup ?? decl, mr.name, desc) : prog.resolve(decl, mr.name, desc);
      if (!t) throw new Error("unresolved direct " + decl + "." + key);
      this.nonNull(ins.regs[0]); pushArgsFrom(this, ins, p.params); callDirect(t);
    } else {
      // virtual / interface: devirtualise when class-hierarchy analysis finds one implementation
      const impls = new Set<MethodInfo>();
      for (const cn of cx.r.instantiated) if (prog.isSubclass(cn, decl)) { const im = prog.implFor(cn, mr.name, desc); if (im) impls.add(im); }
      const declC = prog.get(decl);
      if (impls.size === 1) {
        const t = [...impls][0]; this.nonNull(ins.regs[0]); pushArgsFrom(this, ins, p.params); c.call(cx.fnOf(t));
      } else if (impls.size === 0) { this.invokeGap(ins, `no instantiated implementor of ${decl}.${key}`); return; }
      else {
        this.nonNull(ins.regs[0]); c.lset(this.tmpL);
        c.lget(this.tmpL); pushArgsFrom(this, ins, p.params);
        c.lget(this.tmpL); cx.str.vtab(c, decl);
        if (declC && !declC.isInterface) {
          c.i32(cx.slotOf(decl, key)).arrayGet(cx.tVT);
        } else if (prog.get("java/lang/Object")!.byKey.has(key)) {
          c.i32(cx.slotOf("java/lang/Object", key)).arrayGet(cx.tVT);
        } else {
          const sel = cx.selectorId(key), s = sel % H.IMT_N;
          // fn = vt[IMT+2s] == sel ? vt[IMT+2s+1] : imtslow(vt, sel)
          const vtl = this.vtLocal();
          c.lset(vtl);
          c.lget(vtl).refAsNonNull().i32(H.IMT + 2 * s).arrayGet(cx.tVT).i32(sel).raw(OP.i32_eq).if_(T.i32)
            .lget(vtl).refAsNonNull().i32(H.IMT + 2 * s + 1).arrayGet(cx.tVT).else_()
            .lget(vtl).refAsNonNull().i32(sel).call(cx.helpers.imtslow).end();
        }
        c.callIndirect(sigIdx());
      }
    }
    this.finishResult(ins, retK);
  }
  vtl = -1;
  vtLocal() { if (this.vtl < 0) this.vtl = this.code.newLocal(refNull(this.cx.tVT)); return this.vtl; }

  emitArith(ins: Ins) {
    const c = this.code, n = ins.name, a = ins.a, b = ins.b, cx = this.cx;
    const un = (from: Kind, to: Kind, f: () => void) => { this.get(from, b); f(); this.set(to, a); };
    switch (n) {
      case "neg-int": c.i32(0); this.get("I", b); c.raw(OP.i32_sub); this.set("I", a); return;
      case "not-int": this.get("I", b); c.i32(-1).raw(OP.i32_xor); this.set("I", a); return;
      case "neg-long": c.i64(0n); this.get("J", b); c.raw(OP.i64_sub); this.set("J", a); return;
      case "not-long": this.get("J", b); c.i64(-1n).raw(OP.i64_xor); this.set("J", a); return;
      case "neg-float": un("I", "I", () => c.i32(0x80000000 | 0).raw(OP.i32_xor)); return;
      case "neg-double": un("J", "J", () => c.i64(0x8000000000000000n).raw(OP.i64_xor)); return;
      case "int-to-long": un("I", "J", () => c.raw(OP.i64_extend_i32_s)); return;
      case "int-to-float": un("I", "I", () => c.raw(OP.f32_convert_i32_s, OP.i32_reinterpret_f32)); return;
      case "int-to-double": un("I", "J", () => c.raw(OP.f64_convert_i32_s, OP.i64_reinterpret_f64)); return;
      case "long-to-int": un("J", "I", () => c.raw(OP.i32_wrap_i64)); return;
      case "long-to-float": un("J", "I", () => c.raw(OP.f32_convert_i64_s, OP.i32_reinterpret_f32)); return;
      case "long-to-double": un("J", "J", () => c.raw(OP.f64_convert_i64_s, OP.i64_reinterpret_f64)); return;
      case "float-to-int": un("I", "I", () => c.raw(OP.f32_reinterpret_i32).satTrunc(0)); return;
      case "float-to-long": un("I", "J", () => c.raw(OP.f32_reinterpret_i32).satTrunc(4)); return;
      case "float-to-double": un("I", "J", () => c.raw(OP.f32_reinterpret_i32, OP.f64_promote_f32, OP.i64_reinterpret_f64)); return;
      case "double-to-int": un("J", "I", () => c.raw(OP.f64_reinterpret_i64).satTrunc(2)); return;
      case "double-to-long": un("J", "J", () => c.raw(OP.f64_reinterpret_i64).satTrunc(6)); return;
      case "double-to-float": un("J", "I", () => c.raw(OP.f64_reinterpret_i64, OP.f32_demote_f64, OP.i32_reinterpret_f32)); return;
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
    const dst: Kind = type === "int" || type === "float" ? "I" : "J";
    const fin = () => { if (type === "float") c.raw(OP.i32_reinterpret_f32); else if (type === "double") c.raw(OP.i64_reinterpret_f64); this.set(dst, a); };
    if (type === "int") {
      const map: Record<string, number> = { add: OP.i32_add, sub: OP.i32_sub, mul: OP.i32_mul, and: OP.i32_and, or: OP.i32_or, xor: OP.i32_xor, shl: OP.i32_shl, shr: OP.i32_shr_s, ushr: OP.i32_shr_u };
      if (n === "rsub-int" || n.startsWith("rsub-int")) { c.i32(ins.c); this.get("I", b); c.raw(OP.i32_sub); this.set("I", a); return; }
      if (opn === "div" || opn === "rem") {
        const direct = lit && ins.c !== 0 && ins.c !== -1;
        X(); Y();
        if (direct) c.raw(opn === "div" ? OP.i32_div_s : OP.i32_rem_s); else c.call(opn === "div" ? cx.helpers.idiv : cx.helpers.irem);
        this.set("I", a); return;
      }
      X(); Y(); c.raw(map[opn]); this.set("I", a); return;
    }
    if (type === "long") {
      const map: Record<string, number> = { add: OP.i64_add, sub: OP.i64_sub, mul: OP.i64_mul, and: OP.i64_and, or: OP.i64_or, xor: OP.i64_xor };
      if (opn === "shl" || opn === "shr" || opn === "ushr") {
        X(); this.get("I", yr); c.raw(OP.i64_extend_i32_u, opn === "shl" ? OP.i64_shl : opn === "shr" ? OP.i64_shr_s : OP.i64_shr_u); this.set("J", a); return;
      }
      if (opn === "div" || opn === "rem") { X(); Y(); c.call(opn === "div" ? cx.helpers.ldiv : cx.helpers.lrem); this.set("J", a); return; }
      X(); Y(); c.raw(map[opn]); this.set("J", a); return;
    }
    // float/double
    if (opn === "rem") {
      if (type === "float") { X(); c.raw(OP.f64_promote_f32); Y(); c.raw(OP.f64_promote_f32).call(cx.hostImports.fmod).raw(OP.f32_demote_f64); }
      else { X(); Y(); c.call(cx.hostImports.fmod); }
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
