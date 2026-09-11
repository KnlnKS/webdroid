// DEX bytecode → shared cold handlers and specialized hot methods.
// Control flow: `for(;;) switch(pc)` over basic blocks; DEX try
// ranges → JS catch with pc-range dispatch. All methods async except provably-sync
// leaves (no invokes / static ops / allocations); call sites guard dynamically:
// `$t instanceof Promise ? await $t : $t`.

import type { DexFile, CodeItem, EncodedMethod } from "./dex";
import { OPS, FMT_LEN, insnLen, type Fmt } from "./opcodes";
import { mangleMethod, parseMethodDesc, isWide, descToName, intBitsToFloat, longBitsToDouble, PRIM_ARRAYS, type PrimElem } from "./abi";
import { ACC, type Runtime, type ClassInfo } from "./runtime";
import { perf } from "../perf";
import { coldOp, runCold, type ColdMethod } from "./cold";

const s4 = (v: number) => (v << 28) >> 28;
const s8 = (v: number) => (v << 24) >> 24;
const s16 = (v: number) => (v << 16) >> 16;

interface Ins {
  pc: number; op: number; name: string; fmt: Fmt; len: number;
  a: number; b: number; c: number;
  regs: number[];       // 35c/3rc arg regs
  wideLit: bigint;      // 51l
  constKind?: "F" | "D"; // const reinterpreted as float/double (set by typeConsts)
}

const NO_REGS: number[] = [];
const ENDS_RE = /^(goto|return|throw)/;
const NO_WRITE_RE = /^(if|goto|return|throw|nop|monitor|aput|iput|sput|invoke|packed|sparse|fill-array|check-cast)/;
const OPERAND_KIND_RE = /^(?:(?:add|sub|mul|div|rem|neg|cmpl|cmpg)-(float|double)|(float|double)-to-)/;
const REL: Record<string, string> = { lt: "<", ge: ">=", gt: ">", le: "<=" };
const holder = (isStatic: boolean) => (isStatic ? "C" : "C.prototype");
const paramList = (desc: string) => parseMethodDesc(desc).params.map((_, j) => "p" + j).join(",");
const isRef = (desc: string) => desc[0] === "L" || desc[0] === "[";
const ref = (r: string) => `(${r}===0?null:${r})`;
function nibbleRegs(r: number, u: number, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = i === 4 ? (u >> 8) & 0xf : (r >> (i * 4)) & 0xf;
  return out;
}
function rangeRegs(first: number, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = first + i;
  return out;
}
function decode(insns: Uint16Array, pc: number): Ins {
  const u = insns[pc];
  const op = u & 0xff;
  const entry = OPS[op];
  if (!entry) throw new Error(`bad opcode 0x${op.toString(16)}`);
  const [name, fmt] = entry;
  const ins: Ins = { pc, op, name, fmt, len: FMT_LEN[fmt], a: 0, b: 0, c: 0, regs: NO_REGS, wideLit: 0n };
  switch (fmt) {
    case "10x": break;
    case "12x": ins.a = (u >> 8) & 0xf; ins.b = u >> 12; break;
    case "11n": ins.a = (u >> 8) & 0xf; ins.b = s4(u >> 12); break;
    case "11x": ins.a = u >> 8; break;
    case "10t": ins.a = s8(u >> 8); break;
    case "20t": ins.a = s16(insns[pc + 1]); break;
    case "22x": ins.a = u >> 8; ins.b = insns[pc + 1]; break;
    case "21t": case "21s": case "21h": ins.a = u >> 8; ins.b = s16(insns[pc + 1]); break;
    case "21c": ins.a = u >> 8; ins.b = insns[pc + 1]; break;
    case "23x": ins.a = u >> 8; ins.b = insns[pc + 1] & 0xff; ins.c = insns[pc + 1] >> 8; break;
    case "22b": ins.a = u >> 8; ins.b = insns[pc + 1] & 0xff; ins.c = s8(insns[pc + 1] >> 8); break;
    case "22t": case "22s": ins.a = (u >> 8) & 0xf; ins.b = u >> 12; ins.c = s16(insns[pc + 1]); break;
    case "22c": ins.a = (u >> 8) & 0xf; ins.b = u >> 12; ins.c = insns[pc + 1]; break;
    case "30t": ins.a = insns[pc + 1] | (insns[pc + 2] << 16); break;
    case "32x": ins.a = insns[pc + 1]; ins.b = insns[pc + 2]; break;
    case "31i": case "31t": ins.a = u >> 8; ins.b = insns[pc + 1] | (insns[pc + 2] << 16); break;
    case "31c": ins.a = u >> 8; ins.b = (insns[pc + 1] | (insns[pc + 2] << 16)) >>> 0; break;
    case "35c": {
      ins.a = u >> 12; ins.b = insns[pc + 1];
      ins.regs = nibbleRegs(insns[pc + 2], u, ins.a);
      break;
    }
    case "3rc": {
      ins.a = u >> 8; ins.b = insns[pc + 1];
      ins.regs = rangeRegs(insns[pc + 2], ins.a);
      break;
    }
    case "45cc": {
      ins.a = u >> 12; ins.b = insns[pc + 1]; ins.c = insns[pc + 3];  // c = proto idx
      ins.regs = nibbleRegs(insns[pc + 2], u, ins.a);
      break;
    }
    case "4rcc": {
      ins.a = u >> 8; ins.b = insns[pc + 1]; ins.c = insns[pc + 3];
      ins.regs = rangeRegs(insns[pc + 2], ins.a);
      break;
    }
    case "51l": {
      ins.a = u >> 8;
      ins.wideLit = BigInt.asIntN(64,
        BigInt(insns[pc + 1]) | (BigInt(insns[pc + 2]) << 16n) |
        (BigInt(insns[pc + 3]) << 32n) | (BigInt(insns[pc + 4]) << 48n));
      break;
    }
  }
  return ins;
}

/** Generating a method's JS source costs ~4x what handing it to `new Function` does, and on
 *  a large app's boot only 31% of the methods of the classes we load are ever called. So a body is
 *  emitted as a thunk that compiles itself on first call. Set false to compile everything up
 *  front (scripts/smoke.ts, which exists to surface compile failures). */
let lazyMethods = true;
export function setLazyMethods(v: boolean) { lazyMethods = v; }

export function compileClassSource(R: Runtime, dex: DexFile, info: ClassInfo): string {
  const def = info.def!;
  const out: string[] = [];
  info.lazy = lazyMethods ? [] : undefined;
  for (const list of [def.directMethods, def.virtualMethods]) {
    for (const m of list) {
      if (m.codeOff) out.push(info.lazy ? emitLazy(dex, info, m) : emitMethod(R, dex, info, m));
      else if (m.flags & ACC.NATIVE) out.push(emitNativeStub(dex, info, m));
    }
  }
  return out.join("\n");
}

/** the bootstrap a call_site links through, for the missing-API report. Best effort:
 *  a dex we cannot read the call site out of still has to compile the rest of its class. */
function bootstrapName(dex: DexFile, callSiteIdx: number): string {
  try {
    const h = dex.callSite(callSiteIdx)[0];
    if (!h || typeof h !== "object" || !("kind" in h) || h.kind !== "mhandle") return `#${callSiteIdx}`;
    const ref = dex.methodHandle(h.idx);
    const m = dex.method(ref.idx);
    return descToName(dex.type(m.cls)) + "." + m.name;
  } catch {
    return `#${callSiteIdx}`;
  }
}

/** `C.prototype.m$x = function(p0){ return (cell || (cell = R.lz(C, i))).call(this, p0) }`
 *  — the cell keeps already-captured references (D.dp direct-dispatch slots, interface
 *  default methods copied down) one call away, while fresh virtual dispatch finds the real
 *  function R.lz installed on the prototype. */
function emitLazy(dex: DexFile, info: ClassInfo, m: EncodedMethod): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const isStatic = (m.flags & ACC.STATIC) !== 0;
  const i = info.lazy!.length;
  info.lazy!.push({ m, mangled, isStatic, name, desc });
  const ps = paramList(desc);
  return `let $z${i};${holder(isStatic)}.${mangled}=function(${ps}){` +
    `return ($z${i}||($z${i}=R.lz(C,${i}))).call(this${ps ? "," + ps : ""})};`;
}

/** Compile one lazily-emitted method and install it. */
export type CompiledCtor = { $i: ClassInfo; prototype: Record<string, unknown> } & Record<string, unknown>;
export function compileLazyMethod(R: Runtime, C: CompiledCtor, i: number): unknown {
  const info = C.$i, rec = info.lazy![i], dex = info.dex!;
  const target = rec.isStatic ? C : C.prototype;
  const source = () => emitMethod(R, dex, info, rec.m, !cold) + `\n//# sourceURL=wd/${info.name}/${rec.name}.js`;
  const compile = (src = source()) => {
    new Function("C", "D", "R", "S", src)(C, R.dexLink(dex), R, info.superInfo?.ctor ?? undefined);
    return target[rec.mangled];
  };
  const compiler = new MethodCompiler(R, dex, info, dex.code(rec.m.codeOff), rec.isStatic, rec.desc, rec.name);
  let cold = compiler.compileCold();
  if (!cold) return compile();
  // Captured direct/interface entries keep this cell; new virtual calls find the hot body.
  let calls = 0, hot: Function | undefined;
  let owner = R;
  while (owner.parent) owner = owner.parent;
  return target[rec.mangled] = function(this: unknown, ...args: unknown[]) {
    if (hot) return hot.apply(this, args);
    if (++calls < 32) return runCold(cold!, this, args);
    const start = performance.now(), src = source();
    if (owner.hotSourceBytes + src.length > 32 * 1024 * 1024) {
      calls = -Infinity;
      perf.compileMs += performance.now() - start;
      return runCold(cold!, this, args);
    }
    const compiled = compile(src);
    owner.hotSourceBytes += src.length;
    perf.compileMs += performance.now() - start;
    if (typeof compiled !== "function") throw new Error("invalid compiled method");
    hot = compiled; cold = null; perf.hotMethods++;
    return hot.apply(this, args);
  };
}

export function methodKey(dex: DexFile, methodIdx: number): { name: string; desc: string; mangled: string } {
  const name = dex.method(methodIdx).name, desc = dex.methodDesc(methodIdx);
  return { name, desc, mangled: mangleMethod(name, desc) };
}

/** Resolved on first call, not when the class body is generated: a JNI_OnLoad run later may
 *  register the native. The cell mirrors emitLazy's so a captured thunk stays one call away. */
function emitNativeStub(dex: DexFile, info: ClassInfo, m: EncodedMethod): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const target = holder((m.flags & ACC.STATIC) !== 0);
  const cls = JSON.stringify(info.name), v = `$n${m.methodIdx}`;
  const ps = paramList(desc);
  return `let ${v};${target}.${mangled}=function(${ps}){` +
    `if(!${v}&&!(${v}=${target}.${mangled}=R.jniFn(${cls},${JSON.stringify(name + desc)})))` +
    `throw R.ulink(${cls},${JSON.stringify(name)},${JSON.stringify(desc)});` +
    `return ${v}.call(this${ps ? "," + ps : ""})};`;
}

function emitMethod(R: Runtime, dex: DexFile, info: ClassInfo, m: EncodedMethod, count = true): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const code = dex.code(m.codeOff);
  const isStatic = (m.flags & ACC.STATIC) !== 0;
  try {
    const body = new MethodCompiler(R, dex, info, code, isStatic, desc, name).compile(count);
    return `${holder(isStatic)}.${mangled} = ${body};`;
  } catch (e) {
    const msg = `compile error ${info.name}.${name}${desc}: ${e}`;
    console.warn(msg);
    return `${holder(isStatic)}.${mangled} = function(){ throw R.unimplemented(${JSON.stringify(msg)}); };`;
  }
}

class MethodCompiler {
  ins: Map<number, Ins> = new Map();
  order: number[] = [];
  leaders = new Set<number>();
  hasTries: boolean;
  hasBackEdge = false;
  sync = true;
  src: string[] = [];

  constructor(
    private R: Runtime, private dex: DexFile, private info: ClassInfo,
    private code: CodeItem, private isStatic: boolean, private desc: string,
    private mname = "?",
  ) {
    this.hasTries = code.tries.length > 0;
  }

  private resumes = 0;
  private cold = false;

  private prepare(): void {
    const { code } = this;
    const insns = code.insns;
    let pc = 0;
    while (pc < insns.length) {
      const u = insns[pc];
      if ((u & 0xff) === 0 && (u >> 8) !== 0) { pc += insnLen(insns, pc); continue; } // payload
      const ins = decode(insns, pc);
      this.ins.set(pc, ins);
      this.order.push(pc);
      pc += ins.len;
    }
    this.leaders.add(0);
    for (const pc2 of this.order) {
      const i = this.ins.get(pc2)!;
      const t = this.branchTargets(i);
      for (const x of t) this.leaders.add(x);
      if (t.length || ENDS_RE.test(i.name)) this.leaders.add(pc2 + i.len);
    }
    for (const t of code.tries) {
      this.leaders.add(t.start); this.leaders.add(t.end);
      for (const [, addr] of t.handlers) this.leaders.add(addr);
      if (t.catchAllAddr >= 0) this.leaders.add(t.catchAllAddr);
    }

    this.typeConsts();
    // Sync eligibility. The whole-program answer (src/jvm/suspend.ts) is authoritative where
    // it has one; a method it never saw — reflection, a class loaded later — falls back to
    // the syntactic rule, which is sound because none of those instructions can suspend.
    if (this.R.syncMethods?.has(this.info.name + "." + this.mname + this.desc)) this.sync = true;
    else {
      for (const pc2 of this.order) {
        const i = this.ins.get(pc2)!;
        if (i.name.startsWith("invoke") || i.name.startsWith("sget") || i.name.startsWith("sput") ||
            i.name === "monitor-enter" || i.name === "new-instance" || i.name === "filled-new-array" || i.name === "filled-new-array/range") {
          this.sync = false;
          break;
        }
      }
    }
  }

  compileCold(): ColdMethod | null {
    this.prepare();
    if (this.sync) return null;
    perf.asyncMethods++;
    this.cold = true;
    const ops = new Map<number, ReturnType<typeof coldOp>>();
    for (const pc of this.order) {
      const ins = this.ins.get(pc)!, out: string[] = [];
      this.emitIns(ins, out);
      let source = out.join("\n");
      if (ins.name.startsWith("return")) source = source === "return;" ? "F.done=true;" : source.replace("return ", "F.done=true;F.value=");
      const op = coldOp(source, pc + ins.len);
      if (ins.name.startsWith("invoke") && !ins.name.startsWith("invoke-custom")) op.method = ins.b;
      ops.set(pc, op);
    }
    return { R: this.R, D: this.R.dexLink(this.dex), S: this.info.superInfo?.ctor,
      regs: this.code.regs, first: this.code.regs - this.code.ins, instance: !this.isStatic,
      widths: parseMethodDesc(this.desc).params.map((p) => isWide(p) ? 2 : 1), ops,
      catches: this.code.tries.map((t) => ({ start: t.start, end: t.end, all: t.catchAllAddr,
        handlers: t.handlers.map(([type, pc]) => [descToName(this.dex.type(type)), pc]) })) };
  }

  compile(count = true): string {
    this.prepare();
    if (count) { if (this.sync) perf.syncMethods++; else perf.asyncMethods++; }
    const blocks: string[] = [];
    let cur: string[] | null = null;
    for (const pc2 of this.order) {
      if (this.leaders.has(pc2)) {
        if (cur) blocks.push(cur.join("\n"));
        cur = [`case ${pc2}:${this.hasTries ? `pc=${pc2};` : ""}`];
      }
      this.emitIns(this.ins.get(pc2)!, cur!);
    }
    if (cur) blocks.push(cur.join("\n"));

    const { params } = parseMethodDesc(this.desc);
    const regs = this.code.regs, ins = this.code.ins;
    let reg = regs - ins;
    const jsParams: string[] = [];
    const paramInit: string[] = [];
    const paramRegs = new Set<number>();
    if (!this.isStatic) { paramInit.push(`let v${reg}=this;`); paramRegs.add(reg); reg++; }
    for (let i = 0; i < params.length; i++) {
      jsParams.push(`p${i}`);
      paramInit.push(`let v${reg}=p${i};`);
      paramRegs.add(reg);
      reg += isWide(params[i]) ? 2 : 1;
    }
    const decls: string[] = [];
    for (let i = 0; i < regs; i++) if (!paramRegs.has(i)) decls.push(`v${i}`);
    const declStr = decls.length ? `let ${decls.join(",")};` : "";

    const catchBody = this.hasTries ? this.emitCatch() : this.leave() + "throw $e;";
    return `${this.sync ? "function" : "async function"}(${jsParams.join(",")}){
${paramInit.join("")}${declStr}let $t,$u,$ex,$fu,pc=0;${this.sync ? "" : "const $th=R.th();let $s=0,$resume=0,$p;"}
for(;;){
try{${this.sync ? "switch(pc)" : "$dispatch:switch($resume>0?-$resume:pc)"}{
${blocks.join("\n")}
default: throw new Error("bad pc "+pc);
}
${this.sync ? "" : "R.su($th);$s=1;$p=await $p;R.st($th);if($resume<0){pc=-$resume-1;$resume=0;}"}
}catch($e){
${this.sync ? "" : "R.st($th);$resume=0;"}$e=R.jx($e);
${catchBody}
}
}
}`;
  }

  /** A method that suspended can only return or throw into an asynchronous resumption of its
   *  caller: a compiled caller re-pins its own thread, and shell code on the main looper expects
   *  the main thread. Leaving curThread on this method's thread would hand the caller's next
   *  synchronous work (a Thread.currentThread check, a fresh vcall) the wrong identity. */
  private leave(): string { return this.sync || this.cold ? "" : "if($s)R.su($th);"; }

  /**
   * Reaching definitions over the block CFG: type the const instructions whose value is
   * consumed as float/double (Dalvik registers are untyped, and `const/high16 0x4100` is the
   * BITS of 8.0f, not the integer 1090519040).
   *
   * This has to be a real dataflow, not a linear pc-order scan. R8 merges dozens of lambda
   * bodies into one method behind a packed-switch with a shared const preamble; in pc order a
   * write to the register inside a mutually exclusive arm looks like it kills the preamble's
   * const, even though on every real path from the switch to the use nothing writes it. That
   * miss is what left Compose holding `Dp(1090519040)` and blew a padding up to 2^26.
   *
   * Def sets only grow and array kinds only shrink, so the fixpoint terminates.
   */
  private typeConsts() {
    const { dex } = this;
    type Defs = Map<number, Set<Ins>>;
    type Arrs = Map<number, "F" | "D">;

    // ── block CFG (leaders are already computed by compile())
    const leaders = this.order.filter((pc) => this.leaders.has(pc));
    const body = new Map<number, number[]>();   // leader → its instruction pcs
    let cur = -1;
    for (const pc of this.order) {
      if (this.leaders.has(pc)) body.set((cur = pc), []);
      body.get(cur)!.push(pc);
    }
    const succ = new Map<number, number[]>();
    for (const [lead, pcs] of body) {
      const last = this.ins.get(pcs[pcs.length - 1])!;
      const out = new Set(this.branchTargets(last).filter((t) => body.has(t)));
      // fall-through, unless the block ends in an unconditional transfer
      if (!ENDS_RE.test(last.name)) {
        const next = last.pc + last.len;
        if (body.has(next)) out.add(next);
      }
      succ.set(lead, [...out]);
    }
    // an exception can leave any instruction in a try range, so every block that overlaps the
    // range reaches the handlers.
    for (const t of this.code.tries) {
      const hs = t.handlers.map(([, a]) => a).concat(t.catchAllAddr >= 0 ? [t.catchAllAddr] : []);
      for (const [lead, pcs] of body) {
        if (pcs[pcs.length - 1] < t.start || lead >= t.end) continue;
        const out = succ.get(lead)!;
        for (const h of hs) if (body.has(h) && !out.includes(h)) out.push(h);
      }
    }

    // ── transfer: apply one block to a state, optionally marking consumers
    const retType = parseMethodDesc(this.desc).ret;
    let liveDefs: Defs | null = null;
    const mark = (reg: number, kind: "F" | "D") => {
      const ds = liveDefs?.get(reg);
      if (ds) for (const w of ds) if (!w.constKind) w.constKind = kind;
    };
    const run = (lead: number, defs: Defs, arr: Arrs, doMark: boolean) => {
      let lastRet = "";
      liveDefs = doMark ? defs : null;
      for (const pc of body.get(lead)!) {
        const i = this.ins.get(pc)!;
        const n = i.name;
        const operand = OPERAND_KIND_RE.exec(n);
        if (operand) {
          const k = (operand[1] ?? operand[2]) === "float" ? "F" : "D";
          if (n.endsWith("/2addr")) { mark(i.a, k); mark(i.b, k); }
          else if (n.startsWith("neg") || operand[2]) mark(i.b, k);
          else { mark(i.b, k); mark(i.c, k); }
        } else if (n === "aput" || n === "aput-wide") {
          const k = arr.get(i.b);
          if (k) mark(i.a, k);
        } else if (n.startsWith("iput") || n.startsWith("sput")) {
          const ft = dex.type(dex.field(n.startsWith("iput") ? i.c : i.b).type);
          if (ft === "F") mark(i.a, "F");
          else if (ft === "D") mark(i.a, "D");
        } else if (n.startsWith("invoke") && !n.startsWith("invoke-custom")) {
          const isInstance = !n.startsWith("invoke-static");
          let ri = isInstance ? 1 : 0;
          for (const pt of dex.protoParamTypes(dex.method(i.b).proto)) {
            if (pt === "F") mark(i.regs[ri], "F");
            else if (pt === "D") mark(i.regs[ri], "D");
            ri += isWide(pt) ? 2 : 1;
          }
        } else if (n === "return" && retType === "F") mark(i.a, "F");
        else if (n === "return-wide" && retType === "D") mark(i.a, "D");

        // float/double array registers so aput types its value const: from new-array, a field or
        // a call's declared type, a check-cast, or a copy of one. `aput` alone cannot tell [F from
        // [I, and 1.0f stored raw into a Float32Array is 1065353216 (Compose's 4x4 matrix
        // m[3][3], which then inverted every hit-test position into nonsense).
        const setArr = (reg: number, t: string) => {
          if (t === "[F") arr.set(reg, "F");
          else if (t === "[D") arr.set(reg, "D");
          else arr.delete(reg);
        };
        if (n === "new-array") setArr(i.a, dex.type(i.c));
        else if (n === "check-cast") setArr(i.a, dex.type(i.b));
        else if (n === "iget-object") setArr(i.a, dex.type(dex.field(i.c).type));
        else if (n === "sget-object") setArr(i.a, dex.type(dex.field(i.b).type));
        else if (n === "move-result-object") setArr(i.a, lastRet);
        else if (n === "move-object" || n === "move-object/from16" || n === "move-object/16") {
          const k = arr.get(i.b);
          if (k) arr.set(i.a, k); else arr.delete(i.a);
        } else { const w = this.writtenReg(i); if (w >= 0) arr.delete(w); }
        if (n.startsWith("invoke") && !n.startsWith("invoke-custom")) lastRet = dex.type(dex.proto(dex.method(i.b).proto).ret);
        else if (n !== "move-result-object") lastRet = "";

        // defs: a const kills whatever reached this register; a move copies the source's set
        if (n.startsWith("const/") || n === "const" || n.startsWith("const-wide")) {
          defs.set(i.a, new Set([i]));
        } else if (n === "move" || n === "move/from16" || n === "move/16" || n === "move-wide" || n === "move-wide/from16" || n === "move-wide/16") {
          const src = defs.get(i.b);
          if (src) defs.set(i.a, new Set(src)); else defs.delete(i.a);
        } else {
          const w = this.writtenReg(i);
          if (w >= 0) defs.delete(w);
        }
      }
      return { defs, arr };
    };

    // parameters of type [F/[D arrive typed
    const paramArrs: Arrs = new Map();
    {
      const params = parseMethodDesc(this.desc).params;
      let reg = this.code.regs - this.code.ins + (this.isStatic ? 0 : 1);
      for (const pt of params) {
        if (pt === "[F" || pt === "[D") paramArrs.set(reg, pt[1] as "F" | "D");
        reg += isWide(pt) ? 2 : 1;
      }
    }

    // A single-block method has no merges: one pass IS the fixpoint.
    if (leaders.length === 1) { run(leaders[0], new Map(), new Map(paramArrs), true); return; }

    // ── fixpoint on block entry states. `null` array-kinds = no predecessor seen yet, which
    // is what lets the meet be an intersection without swallowing the first contribution.
    const inDefs = new Map<number, Defs>(leaders.map((l) => [l, new Map()] as const));
    const inArrs = new Map<number, Arrs | null>(leaders.map((l) => [l, null] as const));
    inArrs.set(leaders[0], new Map(paramArrs));
    const work = [...leaders];
    const queued = new Set(leaders);
    for (let wi = 0; wi < work.length; wi++) {
      const lead = work[wi];
      queued.delete(lead);
      const st = run(lead, clone(inDefs.get(lead)!), new Map(inArrs.get(lead) ?? []), false);
      for (const t of succ.get(lead)!) {
        let changed = false;
        const dst = inDefs.get(t)!;
        for (const [reg, set] of st.defs) {
          const d = dst.get(reg);
          if (!d) { dst.set(reg, new Set(set)); changed = true; continue; }
          for (const x of set) if (!d.has(x)) { d.add(x); changed = true; }
        }
        const da = inArrs.get(t);
        if (da === null || da === undefined) { inArrs.set(t, new Map(st.arr)); changed = true; }
        else for (const [k, v] of [...da]) if (st.arr.get(k) !== v) { da.delete(k); changed = true; }
        if (changed && !queued.has(t)) { queued.add(t); work.push(t); }
      }
    }

    // ── one marking pass per block, from its settled entry state
    for (const l of leaders) run(l, clone(inDefs.get(l)!), new Map(inArrs.get(l) ?? []), true);

    function clone(d: Defs): Defs {
      const o: Defs = new Map();
      for (const [k, v] of d) o.set(k, new Set(v));
      return o;
    }
  }
  private writtenReg(i: Ins): number {
    const n = i.name;
    if (NO_WRITE_RE.test(n)) return -1;
    return i.a;
  }

  private emitCatch(): string {
    const parts: string[] = ["$ex=$e;"];
    for (const t of this.code.tries) {
      const checks: string[] = [];
      for (const [typeIdx, addr] of t.handlers) {
        const tname = descToName(this.dex.type(typeIdx));
        if (tname === "java/lang/Throwable") checks.push(`{pc=${addr};continue;}`);
        else checks.push(`if(R.iof($e,${JSON.stringify(tname)})){pc=${addr};continue;}`);
      }
      if (t.catchAllAddr >= 0) checks.push(`{pc=${t.catchAllAddr};continue;}`);
      parts.push(`if(pc>=${t.start}&&pc<${t.end}){${checks.join("")}}`);
    }
    parts.push(this.leave() + "throw $e;");
    return parts.join("\n");
  }

  private branchTargets(i: Ins): number[] {
    switch (i.name) {
      case "goto": case "goto/16": case "goto/32": return [i.pc + i.a];
      case "packed-switch": case "sparse-switch": return this.switchCases(i).map(([, t]) => t);
      default: return i.name.startsWith("if-") ? [this.ifTarget(i)] : [];
    }
  }
  private ifTarget(i: Ins): number { return i.pc + (i.fmt === "22t" ? i.c : i.b); }
  /** a switch's [key, target] pairs out of its packed or sparse payload */
  private switchCases(i: Ins): [number, number][] {
    const insns = this.code.insns, payload = i.pc + i.b, size = insns[payload + 1], out: [number, number][] = [];
    const word = (at: number) => insns[at] | (insns[at + 1] << 16);
    for (let j = 0; j < size; j++) {
      if (i.name === "packed-switch") out.push([word(payload + 2) + j, i.pc + word(payload + 4 + j * 2)]);
      else out.push([word(payload + 2 + j * 2), i.pc + word(payload + 2 + size * 2 + j * 2)]);
    }
    return out;
  }

  // inside <clinit>: pass own type idx so the runtime can detect clinit cycles
  private get fromArg(): string {
    return this.mname === "<clinit>" && this.info.def ? `,${this.info.def.typeIdx}` : "";
  }

  /** A site the whole-program analysis proved cannot suspend gets the same loud check a sync
   *  frame does instead of an await: the check is a fraction of the bytecode, and it is the
   *  await machinery, not the call, that sets the size of a body. */
  private guard(expr: string, out: string[], assignTo = "$t", siteSync = false, site = "") {
    // A sync frame cannot await. If the analysis was wrong the value arrives as a promise,
    // and saying so is the only honest thing left — proceeding would hand a promise on as
    // if it were the result. Naming the site is what makes the wrong answer findable.
    if (this.sync || siteSync) { out.push(`${assignTo}=${expr};if(${assignTo} instanceof Promise)throw R.nosusp(${JSON.stringify(this.info.name + "." + this.mname + this.desc)},${JSON.stringify(site)});`); return; }
    out.push(`${assignTo}=${expr};${this.suspend(assignTo)}`);
  }

  // One await per hot method avoids repeating V8's register spills at every call site.
  private suspend(value: string): string {
    if (this.cold) return `if(${value} instanceof Promise){R.su($th);$s=1;${value}=await ${value};R.st($th);}`;
    const resume = ++this.resumes;
    return `if(${value} instanceof Promise){$p=${value};$resume=${resume};break $dispatch;}case -${resume}:if($resume){${value}=$p;$resume=0;}`;
  }

  private siteSync(key: string): boolean { return this.R.syncSites?.has(key) ?? false; }
  private initSync(cls: string): boolean { return this.R.syncInits?.has(cls) ?? false; }

  private fieldProp(fieldIdx: number): string {
    return this.R.resolveInstanceField(this.dex, fieldIdx);
  }

  private emitIns(i: Ins, out: string[]) {
    const { dex } = this;
    const A = `v${i.a}`, B = `v${i.b}`, C = `v${i.c}`;
    switch (i.name) {
      case "nop": break;
      case "move": case "move/from16": case "move/16":
      case "move-wide": case "move-wide/from16": case "move-wide/16":
      case "move-object": case "move-object/from16": case "move-object/16":
        out.push(`${A}=${B};`); break;
      case "move-result": case "move-result-wide": case "move-result-object":
        out.push(`${A}=$t;`); break;
      case "move-exception": out.push(`${A}=$ex;`); break;
      case "return-void": out.push(this.leave() + "return;"); break;
      case "return": case "return-wide": out.push(`${this.leave()}return ${A};`); break;
      case "return-object": out.push(`${this.leave()}return ${ref(A)};`); break;
      case "const/4": case "const/16": case "const":
        out.push(`${A}=${i.constKind === "F" ? f32bits(i.b) : i.b};`);
        break;
      case "const/high16":
        out.push(`${A}=${i.constKind === "F" ? f32bits(i.b << 16) : i.b << 16};`);
        break;
      case "const-wide/16": case "const-wide/32":
        out.push(`${A}=${i.constKind === "D" ? f64bits(BigInt(i.b)) : `${i.b}n`};`);
        break;
      case "const-wide":
        out.push(`${A}=${i.constKind === "D" ? f64bits(i.wideLit) : `${i.wideLit}n`};`);
        break;
      case "const-wide/high16":
        out.push(`${A}=${i.constKind === "D" ? f64bits(BigInt(i.b) << 48n) : `${BigInt(i.b) << 48n}n`};`);
        break;
      case "const-string": case "const-string/jumbo":
        out.push(`${A}=D.s[${i.b}]??D.gs(${i.b});`); break;
      case "const-class":
        out.push(`${A}=R.classForIdx(D,${i.b});`); break;
      case "monitor-enter": this.guard(`R.me(v${i.a})`, out); break;
      case "monitor-exit": out.push(`R.mx(v${i.a});`); break;
      case "check-cast":
        out.push(`R.cc(${A},${JSON.stringify(descToName(dex.type(i.b)))});`); break;
      case "instance-of":
        out.push(`${A}=R.iof(${B},${JSON.stringify(descToName(dex.type(i.c)))});`); break;
      case "array-length": out.push(`${A}=${B}.length;`); break;
      case "new-instance": {
        const tname = descToName(dex.type(i.b));
        if (tname === "java/lang/String") { out.push(`${A}="";`); break; }
        if (tname === this.info.name) out.push(`$u=D.cl[${i.b}]??D.link(${i.b});`);
        else this.guard(`D.ic[${i.b}]??D.init(${i.b}${this.fromArg})`, out, "$u", this.initSync(tname), "init " + tname);
        out.push(`${A}=new $u();`);
        break;
      }
      case "new-array": {
        const elem = descToName(dex.type(i.c)).slice(1); // strip one [
        out.push(`${A}=${newArrayExpr(elem, B)};`);
        break;
      }
      case "filled-new-array": case "filled-new-array/range": {
        const elem = dex.type(i.b).slice(1);
        const vals = i.regs.map((r) => `v${r}`).join(",");
        if (isRef(elem)) {
          out.push(`$t=R.oa(${i.regs.length},${JSON.stringify(elem)});${i.regs.map((r, j) => `$t[${j}]=${ref("v" + r)};`).join("")}`);
        } else {
          out.push(`$t=${typedArrayCtor(elem)}.of(${vals});`);
        }
        break;
      }
      case "fill-array-data": {
        const payload = i.pc + i.b;
        const insns = this.code.insns;
        const width = insns[payload + 1];
        const count = insns[payload + 2] | (insns[payload + 3] << 16);
        const bytes: number[] = [];
        for (let j = 0; j < Math.ceil(count * width / 2); j++) {
          bytes.push(insns[payload + 4 + j] & 0xff, insns[payload + 4 + j] >> 8);
        }
        const lits: string[] = [];
        for (let j = 0; j < count; j++) {
          let v = 0n;
          for (let k = 0; k < width; k++) v |= BigInt(bytes[j * width + k]) << BigInt(k * 8);
          if (width === 8) lits.push(BigInt.asIntN(64, v).toString() + "n");
          else lits.push(String(v)); // stored raw; typed array coerces on set
        }
        out.push(`R.fad(${A},[${lits.join(",")}]);`);
        break;
      }
      case "throw": out.push(`throw ${A};`); break;
      case "goto": case "goto/16": case "goto/32": out.push(this.jumpStr(i.pc + i.a, i.pc)); break;
      case "packed-switch": case "sparse-switch":
        out.push(`switch(${A}){${this.switchCases(i).map(([k, t]) => `case ${k}:${this.jumpStr(t, i.pc)}`).join("")}}`);
        break;
      case "cmpl-float": case "cmpl-double":
        out.push(`${A}=${B}<${C}?-1:${B}>${C}?1:${B}===${C}?0:-1;`); break;
      case "cmpg-float": case "cmpg-double":
        out.push(`${A}=${B}<${C}?-1:${B}>${C}?1:${B}===${C}?0:1;`); break;
      case "cmp-long":
        out.push(`${A}=${B}<${C}?-1:${B}>${C}?1:0;`); break;
      case "if-eq": this.emitIf(`(${A}===${B}||(${nz(A)}&&${nz(B)}))`, i, out); break;
      case "if-ne": this.emitIf(`!(${A}===${B}||(${nz(A)}&&${nz(B)}))`, i, out); break;
      case "if-eqz": this.emitIf(nz(A), i, out); break;
      case "if-nez": this.emitIf(`!${nz(A)}`, i, out); break;
      case "if-lt": case "if-ge": case "if-gt": case "if-le": this.emitIf(`${A}${REL[i.name.slice(3)]}${B}`, i, out); break;
      case "if-ltz": case "if-gez": case "if-gtz": case "if-lez": this.emitIf(`${A}${REL[i.name.slice(3, 5)]}0`, i, out); break;
      case "const-method-handle": case "const-method-type":
        out.push(this.unsupported(`${i.name} #${i.b}`));
        break;
      default:
        // before the prefix matching below, which would read a quickened offset as a field index
        if (i.name.endsWith("-quick")) { out.push(this.unsupported(`${i.name}: this dex is odexed`)); break; }
        if (i.name.startsWith("aget")) {
          out.push(`if((${C}>>>0)>=${B}.length)R.aio(${C},${B}.length);${A}=${B}[${C}];`);
        } else if (i.name.startsWith("aput")) {
          const val = i.name === "aput-object" ? ref(A) : A;
          out.push(`if((${C}>>>0)>=${B}.length)R.aio(${C},${B}.length);${B}[${C}]=${val};`);
        } else if (i.name.startsWith("iget")) {
          out.push(`${A}=${B}.${this.fieldProp(i.c)};`);
        } else if (i.name.startsWith("iput")) {
          out.push(`${B}.${this.fieldProp(i.c)}=${isRef(this.dex.type(this.dex.field(i.c).type)) ? ref(A) : A};`);
        } else if (i.name.startsWith("sget")) {
          this.emitStaticField(i, out, true);
        } else if (i.name.startsWith("sput")) {
          this.emitStaticField(i, out, false);
        } else if (i.name.startsWith("invoke")) {
          this.emitInvoke(i, out);
        } else {
          this.emitArith(i, out);
        }
    }
  }

  private jumpStr(target: number, from: number): string {
    if (target <= from) this.hasBackEdge = true;
    const suspend = this.cold ? "R.su($th);$s=1;await $fu;R.st($th);" : `$p=$fu;$resume=${-target-1};break $dispatch;`;
    const fuel = !this.sync && target <= from ? `if(--R.fuel<0){$fu=R.refuel();if($fu){${suspend}}}` : "";
    return `${fuel}pc=${target};${this.cold ? "return" : "continue"};`;
  }

  private emitIf(cond: string, i: Ins, out: string[]) {
    out.push(`if(${cond}){${this.jumpStr(this.ifTarget(i), i.pc)}}`);
  }

  private emitStaticField(i: Ins, out: string[], isGet: boolean) {
    const { prop, typeIdx } = this.R.resolveStaticField(this.dex, i.b);
    if (typeIdx >= 0 && descToName(this.dex.type(typeIdx)) === this.info.name) {
      out.push(`$u=D.cl[${typeIdx}]??D.link(${typeIdx});`);
    } else if (typeIdx >= 0) {
      const owner = descToName(this.dex.type(typeIdx));
      this.guard(`D.ic[${typeIdx}]??D.init(${typeIdx}${this.fromArg})`, out, "$u", this.initSync(owner), "init " + owner);
    } else {
      this.guard(`D.fs[${i.b}]??D.rsf(${i.b}${this.fromArg})`, out, "$u");
    }
    const A = `v${i.a}`;
    out.push(isGet ? `${A}=$u.${prop};` : `$u.${prop}=${isRef(this.dex.type(this.dex.field(i.b).type)) ? ref(A) : A};`);
  }

  /** an instruction we cannot compile: throw here, so the rest of the method still runs */
  private unsupported(what: string): string {
    return `throw R.unimplemented(${JSON.stringify(`${this.info.name} ${what}`)});`;
  }

  private emitInvoke(i: Ins, out: string[]) {
    const { dex } = this;
    // invoke-custom's B operand is a call_site_idx: never a method ref. Name the
    // bootstrap so the report says which linkage is missing, not just "invoke-custom".
    if (i.name.startsWith("invoke-custom")) {
      out.push(this.unsupported(`invoke-custom ${bootstrapName(dex, i.b)}`));
      return;
    }
    const mref = dex.method(i.b);
    const desc = dex.methodDesc(i.b);
    const mangled = mangleMethod(mref.name, desc);
    const clsName = descToName(dex.type(mref.cls));
    const kind = i.name.replace("/range", "");

    // collapse wide args: regs list per param shorty; 0→null for ref params
    const isInstance = kind !== "invoke-static";
    const args: string[] = [];
    let ri = isInstance ? 1 : 0;
    for (const p of dex.protoParamTypes(mref.proto)) {
      const r = `v${i.regs[ri]}`;
      args.push(isRef(p) ? ref(r) : r);
      ri += isWide(p) ? 2 : 1;
    }
    const recv = isInstance ? `v${i.regs[0]}` : "";
    const argStr = args.join(",");

    if (clsName[0] === "[") {
      // methods on array types (clone/getClass/…)
      out.push(`$t=R.arrCall(${recv},${JSON.stringify(mref.name)});`);
      return;
    }
    switch (kind) {
      case "invoke-virtual": case "invoke-interface":
        this.guard(`${recv}.${mangled}(${argStr})`, out, "$t", this.siteSync("@" + clsName + "." + mref.name + desc), clsName + "." + mref.name + desc);
        break;
      case "invoke-super": {
        // resolve against the superclass prototype; an interface-default super call
        // (Iface.super.m()) instead resolves on the declared interface's prototype
        out.push(`$t=(S.prototype.${mangled}??(D.cl[${mref.cls}]??D.link(${mref.cls})).prototype.${mangled}??R.nsm(${JSON.stringify(clsName + "." + mref.name + desc + " (super)")})).call(${recv}${argStr ? "," + argStr : ""});`);
        if (!this.sync) out.push(this.siteSync(clsName + "." + mref.name + desc) ? `if($t instanceof Promise)throw R.nosusp(${JSON.stringify(this.info.name + "." + this.mname + this.desc)},${JSON.stringify(clsName + "." + mref.name + desc)});`
          : this.suspend("$t"));
        break;
      }
      case "invoke-direct": {
        if (clsName === "java/lang/String" && mref.name === "<init>") {
          out.push(`${recv}=R.newStr(${JSON.stringify(desc)},[${argStr}]);`);
          break;
        }
        // same-class: entry into this class's code implies inited (or initing in
        // this chain — JVM reentrancy); skip init to avoid clinit self-deadlock
        if (clsName === this.info.name) out.push(`$u=D.dp[${i.b}]??D.rdp0(${i.b});`);
        else this.guard(`D.dp[${i.b}]??D.rdp(${i.b}${this.fromArg})`, out, "$u", this.initSync(clsName), "init " + clsName);
        this.guard(`$u.call(${recv}${argStr ? "," + argStr : ""})`, out, "$t", this.siteSync(clsName + "." + mref.name + desc), clsName + "." + mref.name + desc);
        break;
      }
      case "invoke-static": {
        if (clsName === this.info.name) out.push(`$u=D.cl[${mref.cls}]??D.link(${mref.cls});`);
        else this.guard(`D.ic[${mref.cls}]??D.init(${mref.cls}${this.fromArg})`, out, "$u", this.initSync(clsName), "init " + clsName);
        const args = this.R.natives.get(clsName)?.callerSensitive?.includes(mref.name + desc) ? argStr + (argStr ? ",R" : "R") : argStr;
        this.guard(`$u.${mangled}(${args})`, out, "$t", this.siteSync(clsName + "." + mref.name + desc), clsName + "." + mref.name + desc);
        break;
      }
      // invoke-polymorphic (MethodHandle.invoke/invokeExact) lands here
      default: out.push(this.unsupported(`${kind} ${clsName}.${mref.name}${desc}`));
    }
  }

  private emitArith(i: Ins, out: string[]) {
    const A = `v${i.a}`, B = `v${i.b}`, C = `v${i.c}`;
    const n = i.name;
    switch (n) {
      case "neg-int": out.push(`${A}=(-${B})|0;`); return;
      case "not-int": out.push(`${A}=~${B};`); return;
      case "neg-long": out.push(`${A}=BigInt.asIntN(64,-${B});`); return;
      case "not-long": out.push(`${A}=BigInt.asIntN(64,~${B});`); return;
      case "neg-float": case "neg-double": out.push(`${A}=-${B};`); return;
      case "int-to-long": out.push(`${A}=BigInt(${B});`); return;
      case "int-to-float": out.push(`${A}=Math.fround(${B});`); return;
      case "int-to-double": out.push(`${A}=${B};`); return;
      case "long-to-int": out.push(`${A}=Number(BigInt.asIntN(32,${B}));`); return;
      case "long-to-float": out.push(`${A}=Math.fround(Number(${B}));`); return;
      case "long-to-double": out.push(`${A}=Number(${B});`); return;
      case "float-to-int": case "double-to-int": out.push(`${A}=R.f2i(${B});`); return;
      case "float-to-long": case "double-to-long": out.push(`${A}=R.f2l(${B});`); return;
      case "float-to-double": out.push(`${A}=${B};`); return;
      case "double-to-float": out.push(`${A}=Math.fround(${B});`); return;
      case "int-to-byte": out.push(`${A}=(${B}<<24)>>24;`); return;
      case "int-to-char": out.push(`${A}=${B}&0xffff;`); return;
      case "int-to-short": out.push(`${A}=(${B}<<16)>>16;`); return;
    }
    const two = n.endsWith("/2addr");
    const lit = n.includes("/lit") || n === "rsub-int"; // 0xd1 is 22s (literal) despite the bare name
    const base = n.replace("/2addr", "").replace("/lit16", "").replace("/lit8", "");
    const [x, y] = two ? [A, B] : lit ? [B, String(i.c)] : [B, C];
    const litVal = i.c;
    let expr: string;
    switch (base) {
      case "add-int": expr = `(${x}+${y})|0`; break;
      case "sub-int": expr = `(${x}-${y})|0`; break;
      case "rsub-int": case "rsub-int/lit8": expr = `(${y}-${x})|0`; break;
      case "mul-int": expr = `Math.imul(${x},${y})`; break;
      case "div-int":
        if (lit && litVal !== 0) expr = `(${x}/${y})|0`;
        else expr = `(${y}===0?R.dz():0,(${x}/${y})|0)`;
        break;
      case "rem-int":
        if (lit && litVal !== 0) expr = `(${x}%${y})|0`;
        else expr = `(${y}===0?R.dz():0,(${x}%${y})|0)`;
        break;
      case "and-int": expr = `${x}&${y}`; break;
      case "or-int": expr = `${x}|${y}`; break;
      case "xor-int": expr = `${x}^${y}`; break;
      case "shl-int": expr = `${x}<<${y}`; break;
      case "shr-int": expr = `${x}>>${y}`; break;
      case "ushr-int": expr = `(${x}>>>${y})|0`; break;
      case "add-long": expr = `BigInt.asIntN(64,${x}+${y})`; break;
      case "sub-long": expr = `BigInt.asIntN(64,${x}-${y})`; break;
      case "mul-long": expr = `BigInt.asIntN(64,${x}*${y})`; break;
      case "div-long": expr = `(${y}===0n?R.dz():0,BigInt.asIntN(64,${x}/${y}))`; break;
      case "rem-long": expr = `(${y}===0n?R.dz():0,${x}%${y})`; break;
      case "and-long": expr = `${x}&${y}`; break;
      case "or-long": expr = `${x}|${y}`; break;
      case "xor-long": expr = `${x}^${y}`; break;
      case "shl-long": expr = `BigInt.asIntN(64,${x}<<BigInt(${y}&63))`; break;
      case "shr-long": expr = `${x}>>BigInt(${y}&63)`; break;
      case "ushr-long": expr = `BigInt.asIntN(64,BigInt.asUintN(64,${x})>>BigInt(${y}&63))`; break;
      case "add-float": expr = `Math.fround(${x}+${y})`; break;
      case "sub-float": expr = `Math.fround(${x}-${y})`; break;
      case "mul-float": expr = `Math.fround(${x}*${y})`; break;
      case "div-float": expr = `Math.fround(${x}/${y})`; break;
      case "rem-float": expr = `Math.fround(${x}%${y})`; break;
      case "add-double": expr = `${x}+${y}`; break;
      case "sub-double": expr = `${x}-${y}`; break;
      case "mul-double": expr = `${x}*${y}`; break;
      case "div-double": expr = `${x}/${y}`; break;
      case "rem-double": expr = `${x}%${y}`; break;
      default: throw new Error("arith? " + n);
    }
    out.push(`${A}=${expr};`);
  }
}

function nz(v: string): string { return `(${v}===null||${v}===0)`; }

const litOf = (v: number) => Number.isFinite(v) ? String(v) : v !== v ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
const f32bits = (bits: number) => litOf(intBitsToFloat(bits));
const f64bits = (bits: bigint) => litOf(longBitsToDouble(BigInt.asIntN(64, bits)));

function typedArrayCtor(elem: string): string {
  const c = PRIM_ARRAYS[elem as PrimElem];
  if (!c) throw new Error("elem " + elem);
  return c.name;
}

function newArrayExpr(elem: string, lenExpr: string): string {
  if (isRef(elem)) return `R.oa(${lenExpr},${JSON.stringify(elem)})`;
  return `new ${typedArrayCtor(elem)}(${lenExpr})`;
}
