// DEX bytecode → shared cold handlers and specialized hot methods.
// Control flow: `for(;;) switch(pc)` over basic blocks; DEX try
// ranges → JS catch with pc-range dispatch. All methods async except provably-sync
// leaves (no invokes / static ops / allocations); call sites guard dynamically:
// `$t instanceof Promise ? await $t : $t`.

import type { DexFile, CodeItem, EncodedMethod } from "./dex";
import { mangleMethod, parseMethodDesc, isWide, descToName, intBitsToFloat, longBitsToDouble, PRIM_ARRAYS, type PrimElem } from "./abi";
import { ACC, JObj, type Runtime, type ClassInfo } from "./runtime";
import { perf } from "../perf";
import { coldOp, runCold, type ColdFrame, type ColdMethod } from "./cold";
import { jvmProfiler } from "./profile";
import { coverageProbeSource, jvmCoverage } from "./coverage";
import {
  ifTarget,
  prepareMethod,
  switchCases,
  type PreparationPhase,
  type PreparedInstruction as Ins,
  type PreparedMethod,
} from "./prepared";

const REL: Record<string, string> = { lt: "<", ge: ">=", gt: ">", le: "<=" };
const holder = (isStatic: boolean) => (isStatic ? "C" : "C.prototype");
const paramList = (desc: string) => parseMethodDesc(desc).params.map((_, j) => "p" + j).join(",");
const isRef = (desc: string) => desc[0] === "L" || desc[0] === "[";
const ref = (r: string) => `(${r}===0?null:${r})`;

/** Generating a method's JS source costs ~4x what handing it to `new Function` does, and on
 *  a large app's boot only 31% of the methods of the classes we load are ever called. So a body is
 *  reached through a shared thunk that compiles it on first call. Set false to compile everything up
 *  front (scripts/smoke.ts, which exists to surface compile failures). */
let lazyMethods = true;
export function setLazyMethods(v: boolean) { lazyMethods = v; }

function prepareDexMethod(
  dex: DexFile,
  code: CodeItem,
  desc: string,
  isStatic: boolean,
  profileName: string,
): PreparedMethod {
  const observe = jvmProfiler.enabled
    ? (phase: PreparationPhase, ms: number) => jvmProfiler.add(profileName, phase, ms)
    : undefined;
  const prepared = prepareMethod(dex, code, desc, isStatic, observe);
  if (jvmProfiler.enabled) {
    jvmProfiler.eligibility(profileName, prepared.instructions.length, prepared.wasmEligible);
  }
  return prepared;
}

export function compileClassSource(R: Runtime, dex: DexFile, info: ClassInfo): string {
  return classSource(R, dex, info, false);
}

export function compileClass(R: Runtime, dex: DexFile, info: ClassInfo): void {
  const src = classSource(R, dex, info, lazyMethods);
  if (!src) return;
  try {
    const started = jvmProfiler.enabled ? performance.now() : 0;
    new Function("C", "D", "R", "S", "P", src + `\n//# sourceURL=wd/${info.name}.js`)(
      info.ctor, R.dexLink(dex), R, info.superInfo?.ctor ?? JObj, jvmProfiler);
    if (jvmProfiler.enabled) jvmProfiler.addAggregate("classLink", performance.now() - started);
  } catch (e) {
    console.error("compile failed for", info.name, e, src.slice(0, 2000));
    throw e;
  }
}

function classSource(R: Runtime, dex: DexFile, info: ClassInfo, lazy: boolean): string {
  const def = info.def!;
  const out: string[] = [];
  info.lazy = lazy ? [] : undefined;
  for (const list of [def.directMethods, def.virtualMethods]) {
    for (const m of list) {
      if (m.codeOff) {
        if (info.lazy) installLazy(R, dex, info, m);
        else out.push(emitEagerMethod(R, dex, info, m));
      }
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

/** Captured direct/interface entries retain the cell; fresh virtual calls find the installed body. */
function installLazy(R: Runtime, dex: DexFile, info: ClassInfo, m: EncodedMethod): void {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const isStatic = (m.flags & ACC.STATIC) !== 0;
  const i = info.lazy!.length;
  info.lazy!.push({ m, mangled, isStatic, name, desc });
  const C: CompiledCtor = info.ctor;
  let entry: JvmFunction | undefined;
  (isStatic ? C : C.prototype)[mangled] = function(this: unknown, ...args: unknown[]) {
    entry ??= R.lz(C, i);
    return entry.apply(this, args);
  };
}

/** Compile one lazily-emitted method and install it. */
export type CompiledCtor = { $i: ClassInfo; prototype: Record<string, unknown> } & Record<string, unknown>;
type JvmFunction = (this: unknown, ...args: unknown[]) => unknown;
interface CompiledMethod {
  invoke: JvmFunction;
  resume?: (frame: ColdFrame, receiver: unknown) => Promise<unknown>;
}

export function compileLazyMethod(R: Runtime, C: CompiledCtor, i: number): JvmFunction {
  const info = C.$i, rec = info.lazy![i], dex = info.dex!;
  const profileName = `${info.name}.${rec.name}${rec.desc}`;
  const target = rec.isStatic ? C : C.prototype;
  const code = dex.code(rec.m.codeOff);
  const prepare = () => prepareDexMethod(dex, code, rec.desc, rec.isStatic, profileName);
  const source = (prepared: PreparedMethod, resumable: boolean, count: boolean) =>
    emitMethod(R, dex, info, rec.m, prepared, count, resumable) + `\n//# sourceURL=wd/${info.name}/${rec.name}.js`;
  const compile = (src: string, resumable: boolean, paramCount = 0): CompiledMethod => {
    const started = jvmProfiler.enabled ? performance.now() : 0;
    new Function("C", "D", "R", "S", "P", src)(C, R.dexLink(dex), R, info.superInfo?.ctor ?? undefined, jvmProfiler);
    if (jvmProfiler.enabled) jvmProfiler.add(profileName, "jsCompile", performance.now() - started);
    const installed = target[rec.mangled];
    if (typeof installed !== "function") throw new Error("invalid compiled method");
    const invoke = installed as JvmFunction;
    if (!resumable) return { invoke };
    return { invoke, resume: (frame, receiver) => {
      const args = new Array<unknown>(paramCount + 1);
      args[paramCount] = frame;
      return Promise.resolve(invoke.apply(receiver, args));
    } };
  };
  const prepared = prepare();
  const paramCount = prepared.params.length;
  let cold = emitColdMethod(R, dex, info, code, rec.isStatic, rec.desc, rec.name, prepared);
  if (!cold) return compile(source(prepared, false, true), false).invoke;
  if (jvmProfiler.tier === "js") return compile(source(prepared, false, false), false).invoke;
  // Captured direct/interface entries keep this cell; new virtual calls find the hot body.
  let calls = 0, hot: CompiledMethod | undefined;
  let owner = R;
  while (owner.parent) owner = owner.parent;
  const promote = (resumable: boolean): CompiledMethod | undefined => {
    if (hot) return !resumable || hot.resume ? hot : undefined;
    // Rebuild preparation only for methods that actually promote. Retaining decoded CFGs for
    // every cold async method costs substantially more heap than the saved promotion work.
    const start = performance.now(), src = source(prepare(), resumable, false);
    if (jvmProfiler.enabled) jvmProfiler.bytes(profileName, src.length);
    if (owner.hotSourceBytes + src.length > 32 * 1024 * 1024) {
      calls = -Infinity;
      cold!.promote = undefined;
      perf.compileMs += performance.now() - start;
      return undefined;
    }
    const compiled = compile(src, resumable, paramCount);
    owner.hotSourceBytes += src.length;
    perf.compileMs += performance.now() - start;
    hot = compiled; perf.hotMethods++;
    if (jvmProfiler.enabled) jvmProfiler.promoted(profileName);
    cold = null;
    return compiled;
  };
  if (jvmProfiler.tier !== "cold") {
    cold.promote = (frame: ColdFrame, receiver: unknown) => {
      const compiled = promote(true);
      if (!compiled?.resume) return null;
      perf.osrMethods++;
      return compiled.resume(frame, receiver);
    };
  }
  const invoke = function(this: unknown, ...args: unknown[]) {
    if (hot) return hot.invoke.apply(this, args);
    if (++calls < 32 || jvmProfiler.tier === "cold") {
      if (jvmProfiler.enabled) jvmProfiler.entry(profileName);
      return runCold(cold!, this, args);
    }
    const compiled = promote(false);
    if (compiled) return compiled.invoke.apply(this, args);
    if (jvmProfiler.enabled) jvmProfiler.entry(profileName);
    return runCold(cold!, this, args);
  };
  if (!jvmCoverage.enabled) return target[rec.mangled] = invoke;
  return target[rec.mangled] = function(this: unknown, ...args: unknown[]) {
    jvmCoverage.hit(profileName);
    return invoke.apply(this, args);
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

function emitMethod(
  R: Runtime,
  dex: DexFile,
  info: ClassInfo,
  m: EncodedMethod,
  prepared: PreparedMethod,
  count = true,
  resumable = false,
): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const code = dex.code(m.codeOff);
  const isStatic = (m.flags & ACC.STATIC) !== 0;
  try {
    const body = new MethodEmitter(R, dex, info, code, isStatic, desc, name, prepared, "hot").compile(count, resumable);
    return `${holder(isStatic)}.${mangled} = ${body};`;
  } catch (e) {
    const msg = `compile error ${info.name}.${name}${desc}: ${e}`;
    console.warn(msg);
    return `${holder(isStatic)}.${mangled} = function(){ throw R.unimplemented(${JSON.stringify(msg)}); };`;
  }
}

function emitEagerMethod(R: Runtime, dex: DexFile, info: ClassInfo, method: EncodedMethod): string {
  const { name, desc, mangled } = methodKey(dex, method.methodIdx);
  const isStatic = (method.flags & ACC.STATIC) !== 0;
  try {
    const prepared = prepareDexMethod(dex, dex.code(method.codeOff), desc, isStatic, `${info.name}.${name}${desc}`);
    return emitMethod(R, dex, info, method, prepared);
  } catch (error) {
    const message = `compile error ${info.name}.${name}${desc}: ${error}`;
    console.warn(message);
    return `${holder(isStatic)}.${mangled} = function(){ throw R.unimplemented(${JSON.stringify(message)}); };`;
  }
}

function emitColdMethod(
  R: Runtime,
  dex: DexFile,
  info: ClassInfo,
  code: CodeItem,
  isStatic: boolean,
  desc: string,
  name: string,
  prepared: PreparedMethod,
): ColdMethod | null {
  if (prepared.sync) return null;
  return new MethodEmitter(R, dex, info, code, isStatic, desc, name, prepared, "cold").compileCold();
}

type EmitBackend = "cold" | "hot";

class MethodEmitter {
  private readonly hasTries: boolean;

  constructor(
    private R: Runtime, private dex: DexFile, private info: ClassInfo,
    private code: CodeItem, private isStatic: boolean, private desc: string,
    private mname: string, private prepared: PreparedMethod, private backend: EmitBackend,
  ) {
    this.hasTries = code.tries.length > 0;
  }

  private resumes = 0;
  private constants: unknown[] = [];
  private suspends = false;

  private get cold(): boolean { return this.backend === "cold"; }
  private get sync(): boolean { return this.prepared.sync; }

  private reg(index: number): string { return this.cold ? `F.v[${this.literal(index)}]` : `v${index}`; }
  private literal(value: string | number | bigint): string {
    if (!this.cold) return typeof value === "string" ? JSON.stringify(value) : typeof value === "bigint" ? `${value}n` : litOf(value);
    const index = this.constants.length;
    this.constants.push(value);
    return `K[${index}]`;
  }
  private prop(name: string): string { return this.cold ? `[${this.literal(name)}]` : `.${name}`; }
  private temp(name: string): string { return this.cold ? `F.$${name}` : `$${name}`; }
  private get t(): string { return this.temp("t"); }
  private get u(): string { return this.temp("u"); }
  private get ex(): string { return this.temp("ex"); }

  compileCold(): ColdMethod {
    perf.asyncMethods++;
    const profileName = `${this.info.name}.${this.mname}${this.desc}`;
    const started = jvmProfiler.enabled ? performance.now() : 0;
    const ops = new Map<number, ReturnType<typeof coldOp>>();
    for (const ins of this.prepared.instructions) {
      const out: string[] = [];
      this.constants = []; this.suspends = false;
      this.emitIns(ins, out);
      const op = coldOp(out.join("\n"), this.constants, ins.pc + ins.len, this.suspends);
      if (ins.name.startsWith("invoke") && !ins.name.startsWith("invoke-custom")) op.method = ins.b;
      ops.set(ins.pc, op);
    }
    if (jvmProfiler.enabled) jvmProfiler.add(profileName, "coldBuild", performance.now() - started);
    return { name: profileName, R: this.R, D: this.R.dexLink(this.dex), S: this.info.superInfo?.ctor,
      regs: this.code.regs, first: this.code.regs - this.code.ins, instance: !this.isStatic,
      hotness: 0, profiledInstructions: 0,
      widths: [...this.prepared.widths], ops,
      catches: this.code.tries.map((t) => ({ start: t.start, end: t.end, all: t.catchAllAddr,
        handlers: t.handlers.map(([type, pc]) => [descToName(this.dex.type(type)), pc]) })) };
  }

  compile(count = true, resumable = false): string {
    const started = jvmProfiler.enabled ? performance.now() : 0;
    if (count) { if (this.sync) perf.syncMethods++; else perf.asyncMethods++; }
    const blocks: string[] = [];
    let cur: string[] | null = null;
    for (const ins of this.prepared.instructions) {
      if (this.prepared.leaders[ins.pc]) {
        if (cur) blocks.push(cur.join("\n"));
        cur = [`case ${ins.pc}:${this.hasTries ? `pc=${ins.pc};` : ""}`];
      }
      if (!cur) throw new Error(`instruction ${ins.pc} has no emitted block`);
      this.emitIns(ins, cur);
    }
    if (cur) blocks.push(cur.join("\n"));

    const params = this.prepared.params;
    const regs = this.code.regs, ins = this.code.ins;
    let reg = regs - ins;
    const jsParams: string[] = [];
    const paramInit: string[] = [];
    const paramAssign: string[] = [];
    const paramRegs = new Set<number>();
    if (!this.isStatic) { paramInit.push(`let v${reg}=this;`); paramAssign.push(`v${reg}=this;`); paramRegs.add(reg); reg++; }
    for (let i = 0; i < params.length; i++) {
      jsParams.push(`p${i}`);
      paramInit.push(`let v${reg}=p${i};`);
      paramAssign.push(`v${reg}=p${i};`);
      paramRegs.add(reg);
      reg += this.prepared.widths[i];
    }
    const decls: string[] = [];
    for (let i = 0; i < regs; i++) if (!paramRegs.has(i)) decls.push(`v${i}`);
    const declStr = decls.length ? `let ${decls.join(",")};` : "";
    const resumeDecls = [...Array.from({ length: regs }, (_, i) => `v${i}`), "$t", "$u", "$ex", "$fu", "pc", "$th", "$s=0", "$resume=0", "$p"].join(",");
    const resumeRegs = Array.from({ length: regs }, (_, i) => `v${i}=$F.v[${i}];`).join("");
    const init = resumable ? `let ${resumeDecls};` +
      `if($F!==undefined){${resumeRegs}` +
      `$t=$F.$t;$u=$F.$u;$ex=$F.$ex;$fu=$F.$fu;pc=$F.next;$th=$F.$th;$s=$F.$s;}` +
      `else{${paramAssign.join("")}pc=0;$th=R.th();}` :
      `${paramInit.join("")}${declStr}let $t,$u,$ex,$fu,pc=0;${this.sync ? "" : "const $th=R.th();let $s=0,$resume=0,$p;"}`;

    const catchBody = this.hasTries ? this.emitCatch() : this.leave() + "throw $e;";
    const profileName = `${this.info.name}.${this.mname}${this.desc}`;
    const coverageEntry = coverageProbeSource(profileName);
    const profiled = jvmProfiler.enabled;
    const profileStart = profiled
      ? `const $pn=${JSON.stringify(profileName)},$pt=performance.now();${resumable ? "if($F===undefined)" : ""}P.entry($pn);try{`
      : "";
    const profileEnd = profiled ? `}finally{P.add($pn,"hotRun",performance.now()-$pt);}` : "";
    const awaitPending = this.sync ? "" : profiled
      ? `R.su($th);$s=1;P.suspension($pn);const $ps=performance.now();try{$p=await $p;}finally{P.add($pn,"suspend",performance.now()-$ps);}R.st($th);if($resume<0){pc=-$resume-1;$resume=0;}`
      : `R.su($th);$s=1;$p=await $p;R.st($th);if($resume<0){pc=-$resume-1;$resume=0;}`;
    const formalParams = resumable ? [...jsParams, "$F"] : jsParams;
    const source = `${this.sync ? "function" : "async function"}(${formalParams.join(",")}){
${coverageEntry}
${profileStart}
${init}
for(;;){
try{${this.sync ? "switch(pc)" : "$dispatch:switch($resume>0?-$resume:pc)"}{
${blocks.join("\n")}
default: throw new Error("bad pc "+pc);
}
${awaitPending}
}catch($e){
${this.sync ? "" : "R.st($th);$resume=0;"}$e=R.jx($e);
${catchBody}
}
}
${profileEnd}
}`;
    if (jvmProfiler.enabled) jvmProfiler.add(`${this.info.name}.${this.mname}${this.desc}`, "hotEmit", performance.now() - started);
    return source;
  }

  /** A method that suspended can only return or throw into an asynchronous resumption of its
   *  caller: a compiled caller re-pins its own thread, and shell code on the main looper expects
   *  the main thread. Leaving curThread on this method's thread would hand the caller's next
   *  synchronous work (a Thread.currentThread check, a fresh vcall) the wrong identity. */
  private leave(): string { return this.sync || this.cold ? "" : "if($s)R.su($th);"; }

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

  // inside <clinit>: pass own type idx so the runtime can detect clinit cycles
  private get fromArg(): string {
    return this.mname === "<clinit>" && this.info.def ? `,${this.literal(this.info.def.typeIdx)}` : "";
  }

  /** A call or class initialization: its value, awaited when it is a promise. Only async bodies
   *  reach here: a body holding any of these instructions never compiles sync. */
  private guard(expr: string, out: string[], assignTo = this.t) {
    out.push(`${assignTo}=${expr};${this.suspend(assignTo)}`);
  }

  // One await per hot method avoids repeating V8's register spills at every call site.
  private suspend(value: string): string {
    if (this.cold) {
      this.suspends = true;
      return `if(${value} instanceof Promise){${value}=yield ${value};}`;
    }
    const resume = ++this.resumes;
    return `if(${value} instanceof Promise){$p=${value};$resume=${resume};break $dispatch;}case -${resume}:if($resume){${value}=$p;$resume=0;}`;
  }

  private fieldProp(fieldIdx: number): string {
    return this.R.resolveInstanceField(this.dex, fieldIdx);
  }

  private emitIns(i: Ins, out: string[]) {
    const { dex } = this;
    switch (i.name) {
      case "nop": break;
      case "move": case "move/from16": case "move/16":
      case "move-wide": case "move-wide/from16": case "move-wide/16":
      case "move-object": case "move-object/from16": case "move-object/16":
        out.push(`${this.reg(i.a)}=${this.reg(i.b)};`); break;
      case "move-result": case "move-result-wide": case "move-result-object":
        out.push(`${this.reg(i.a)}=${this.t};`); break;
      case "move-exception": out.push(`${this.reg(i.a)}=${this.ex};`); break;
      case "return-void": out.push(this.cold ? "F.done=true;" : this.leave() + "return;"); break;
      case "return": case "return-wide": out.push(`${this.cold ? "F.done=true;F.value=" : this.leave() + "return "}${this.reg(i.a)};`); break;
      case "return-object": out.push(`${this.cold ? "F.done=true;F.value=" : this.leave() + "return "}${ref(this.reg(i.a))};`); break;
      case "const/4": case "const/16": case "const":
        out.push(`${this.reg(i.a)}=${this.literal(i.constKind === "F" ? intBitsToFloat(i.b) : i.b)};`);
        break;
      case "const/high16":
        out.push(`${this.reg(i.a)}=${this.literal(i.constKind === "F" ? intBitsToFloat(i.b << 16) : i.b << 16)};`);
        break;
      case "const-wide/16": case "const-wide/32":
        out.push(`${this.reg(i.a)}=${this.literal(i.constKind === "D" ? longBitsToDouble(BigInt.asIntN(64, BigInt(i.b))) : BigInt(i.b))};`);
        break;
      case "const-wide":
        out.push(`${this.reg(i.a)}=${this.literal(i.constKind === "D" ? longBitsToDouble(BigInt.asIntN(64, i.wideLit)) : i.wideLit)};`);
        break;
      case "const-wide/high16":
        out.push(`${this.reg(i.a)}=${this.literal(i.constKind === "D" ? longBitsToDouble(BigInt.asIntN(64, BigInt(i.b) << 48n)) : BigInt(i.b) << 48n)};`);
        break;
      case "const-string": case "const-string/jumbo":
        out.push(`${this.reg(i.a)}=D.s[${this.literal(i.b)}]??D.gs(${this.literal(i.b)});`); break;
      case "const-class":
        out.push(`${this.reg(i.a)}=R.classForIdx(D,${this.literal(i.b)});`); break;
      case "monitor-enter": this.guard(`R.me(${this.reg(i.a)})`, out); break;
      case "monitor-exit": out.push(`R.mx(${this.reg(i.a)});`); break;
      case "check-cast":
        out.push(`R.cc(${this.reg(i.a)},${this.literal(descToName(dex.type(i.b)))});`); break;
      case "instance-of":
        out.push(`${this.reg(i.a)}=R.iof(${this.reg(i.b)},${this.literal(descToName(dex.type(i.c)))});`); break;
      case "array-length": out.push(`${this.reg(i.a)}=${this.reg(i.b)}.length;`); break;
      case "new-instance": {
        const tname = descToName(dex.type(i.b));
        if (tname === "java/lang/String") { out.push(`${this.reg(i.a)}="";`); break; }
        if (tname === this.info.name) out.push(`${this.u}=D.cl[${this.literal(i.b)}]??D.link(${this.literal(i.b)});`);
        else this.guard(`D.ic[${this.literal(i.b)}]??D.init(${this.literal(i.b)}${this.fromArg})`, out, this.u);
        out.push(`${this.reg(i.a)}=new ${this.u}();`);
        break;
      }
      case "new-array": {
        const elem = descToName(dex.type(i.c)).slice(1); // strip one [
        out.push(`${this.reg(i.a)}=${isRef(elem) ? `R.oa(${this.reg(i.b)},${this.literal(elem)})` : `new ${typedArrayCtor(elem)}(${this.reg(i.b)})`};`);
        break;
      }
      case "filled-new-array": case "filled-new-array/range": {
        const elem = dex.type(i.b).slice(1);
        const vals = i.regs.map((r) => this.reg(r)).join(",");
        if (isRef(elem)) {
          out.push(`${this.t}=R.oa(${this.literal(i.regs.length)},${this.literal(elem)});${i.regs.map((r, j) => `${this.t}[${this.literal(j)}]=${ref(this.reg(r))};`).join("")}`);
        } else {
          out.push(`${this.t}=${typedArrayCtor(elem)}.of(${vals});`);
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
          if (width === 8) lits.push(this.literal(BigInt.asIntN(64, v)));
          else lits.push(this.literal(Number(v))); // stored raw; typed array coerces on set
        }
        out.push(`R.fad(${this.reg(i.a)},[${lits.join(",")}]);`);
        break;
      }
      case "throw": out.push(`throw ${this.reg(i.a)};`); break;
      case "goto": case "goto/16": case "goto/32": out.push(this.jumpStr(i.pc + i.a, i.pc)); break;
      case "packed-switch": case "sparse-switch":
        out.push(`switch(${this.reg(i.a)}){${switchCases(this.code, i).map(([k, t]) => `case ${this.literal(k)}:${this.jumpStr(t, i.pc)}`).join("")}}`);
        break;
      case "cmpl-float": case "cmpl-double":
        out.push(`${this.reg(i.a)}=${this.reg(i.b)}<${this.reg(i.c)}?-1:${this.reg(i.b)}>${this.reg(i.c)}?1:${this.reg(i.b)}===${this.reg(i.c)}?0:-1;`); break;
      case "cmpg-float": case "cmpg-double":
        out.push(`${this.reg(i.a)}=${this.reg(i.b)}<${this.reg(i.c)}?-1:${this.reg(i.b)}>${this.reg(i.c)}?1:${this.reg(i.b)}===${this.reg(i.c)}?0:1;`); break;
      case "cmp-long":
        out.push(`${this.reg(i.a)}=${this.reg(i.b)}<${this.reg(i.c)}?-1:${this.reg(i.b)}>${this.reg(i.c)}?1:0;`); break;
      case "if-eq": this.emitIf(`(${this.reg(i.a)}===${this.reg(i.b)}||(${nz(this.reg(i.a))}&&${nz(this.reg(i.b))}))`, i, out); break;
      case "if-ne": this.emitIf(`!(${this.reg(i.a)}===${this.reg(i.b)}||(${nz(this.reg(i.a))}&&${nz(this.reg(i.b))}))`, i, out); break;
      case "if-eqz": this.emitIf(nz(this.reg(i.a)), i, out); break;
      case "if-nez": this.emitIf(`!${nz(this.reg(i.a))}`, i, out); break;
      case "if-lt": case "if-ge": case "if-gt": case "if-le": this.emitIf(`${this.reg(i.a)}${REL[i.name.slice(3)]}${this.reg(i.b)}`, i, out); break;
      case "if-ltz": case "if-gez": case "if-gtz": case "if-lez": this.emitIf(`${this.reg(i.a)}${REL[i.name.slice(3, 5)]}0`, i, out); break;
      case "const-method-handle": case "const-method-type":
        out.push(this.unsupported(`${i.name} #${i.b}`));
        break;
      default:
        // before the prefix matching below, which would read a quickened offset as a field index
        if (i.name.endsWith("-quick")) { out.push(this.unsupported(`${i.name}: this dex is odexed`)); break; }
        if (i.name.startsWith("aget")) {
          out.push(`if((${this.reg(i.c)}>>>0)>=${this.reg(i.b)}.length)R.aio(${this.reg(i.c)},${this.reg(i.b)}.length);${this.reg(i.a)}=${this.reg(i.b)}[${this.reg(i.c)}];`);
        } else if (i.name.startsWith("aput")) {
          const val = i.name === "aput-object" ? ref(this.reg(i.a)) : this.reg(i.a);
          out.push(`if((${this.reg(i.c)}>>>0)>=${this.reg(i.b)}.length)R.aio(${this.reg(i.c)},${this.reg(i.b)}.length);${this.reg(i.b)}[${this.reg(i.c)}]=${val};`);
        } else if (i.name.startsWith("iget")) {
          out.push(`${this.reg(i.a)}=${this.reg(i.b)}${this.prop(this.fieldProp(i.c))};`);
        } else if (i.name.startsWith("iput")) {
          out.push(`${this.reg(i.b)}${this.prop(this.fieldProp(i.c))}=${isRef(this.dex.type(this.dex.field(i.c).type)) ? ref(this.reg(i.a)) : this.reg(i.a)};`);
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
    if (this.cold) {
      const fuel = target <= from ? `if(--R.fuel<0){F.$fu=R.refuel();if(F.$fu)yield F.$fu;}` : "";
      if (fuel) this.suspends = true;
      return `${fuel}F.next=${this.literal(target)};return;`;
    }
    const fuel = !this.sync && target <= from ? `if(--R.fuel<0){$fu=R.refuel();if($fu){$p=$fu;$resume=${-target-1};break $dispatch;}}` : "";
    return `${fuel}pc=${target};continue;`;
  }

  private emitIf(cond: string, i: Ins, out: string[]) {
    out.push(`if(${cond}){${this.jumpStr(ifTarget(i), i.pc)}}`);
  }

  private emitStaticField(i: Ins, out: string[], isGet: boolean) {
    const { prop, typeIdx } = this.R.resolveStaticField(this.dex, i.b);
    if (typeIdx >= 0 && descToName(this.dex.type(typeIdx)) === this.info.name) {
      out.push(`${this.u}=D.cl[${this.literal(typeIdx)}]??D.link(${this.literal(typeIdx)});`);
    } else if (typeIdx >= 0) {
      this.guard(`D.ic[${this.literal(typeIdx)}]??D.init(${this.literal(typeIdx)}${this.fromArg})`, out, this.u);
    } else {
      this.guard(`D.fs[${this.literal(i.b)}]??D.rsf(${this.literal(i.b)}${this.fromArg})`, out, this.u);
    }
    out.push(isGet ? `${this.reg(i.a)}=${this.u}${this.prop(prop)};` : `${this.u}${this.prop(prop)}=${isRef(this.dex.type(this.dex.field(i.b).type)) ? ref(this.reg(i.a)) : this.reg(i.a)};`);
  }

  /** an instruction we cannot compile: throw here, so the rest of the method still runs */
  private unsupported(what: string): string {
    return `throw R.unimplemented(${this.literal(`${this.info.name} ${what}`)});`;
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
      const r = this.reg(i.regs[ri]);
      args.push(isRef(p) ? ref(r) : r);
      ri += isWide(p) ? 2 : 1;
    }
    const recv = isInstance ? (i.nullRecv ? ref(this.reg(i.regs[0])) : this.reg(i.regs[0])) : "";
    const argStr = args.join(",");

    if (clsName[0] === "[") {
      // methods on array types (clone/getClass/…)
      out.push(`${this.t}=R.arrCall(${recv},${this.literal(mref.name)});`);
      return;
    }
    switch (kind) {
      case "invoke-virtual": case "invoke-interface":
        this.guard(`${recv}${this.prop(mangled)}(${argStr})`, out);
        break;
      case "invoke-super": {
        // resolve against the superclass prototype; an interface-default super call
        // (Iface.super.m()) instead resolves on the declared interface's prototype
        out.push(`${this.t}=(S.prototype${this.prop(mangled)}??(D.cl[${this.literal(mref.cls)}]??D.link(${this.literal(mref.cls)})).prototype${this.prop(mangled)}??R.nsm(${this.literal(clsName + "." + mref.name + desc + " (super)")})).call(${recv}${argStr ? "," + argStr : ""});`);
        out.push(this.suspend(this.t));
        break;
      }
      case "invoke-direct": {
        if (clsName === "java/lang/String" && mref.name === "<init>") {
          out.push(`${recv}=R.newStr(${this.literal(desc)},[${argStr}]);`);
          break;
        }
        // same-class: entry into this class's code implies inited (or initing in
        // this chain — JVM reentrancy); skip init to avoid clinit self-deadlock
        if (clsName === this.info.name) out.push(`${this.u}=D.dp[${this.literal(i.b)}]??D.rdp0(${this.literal(i.b)});`);
        else this.guard(`D.dp[${this.literal(i.b)}]??D.rdp(${this.literal(i.b)}${this.fromArg})`, out, this.u);
        this.guard(`${this.u}.call(${recv}${argStr ? "," + argStr : ""})`, out);
        break;
      }
      case "invoke-static": {
        if (clsName === this.info.name) out.push(`${this.u}=D.cl[${this.literal(mref.cls)}]??D.link(${this.literal(mref.cls)});`);
        else this.guard(`D.ic[${this.literal(mref.cls)}]??D.init(${this.literal(mref.cls)}${this.fromArg})`, out, this.u);
        const args = this.R.natives.get(clsName)?.callerSensitive?.includes(mref.name + desc) ? argStr + (argStr ? ",R" : "R") : argStr;
        this.guard(`${this.u}${this.prop(mangled)}(${args})`, out);
        break;
      }
      // invoke-polymorphic (MethodHandle.invoke/invokeExact) lands here
      default: out.push(this.unsupported(`${kind} ${clsName}.${mref.name}${desc}`));
    }
  }

  private emitArith(i: Ins, out: string[]) {
    const n = i.name;
    switch (n) {
      case "neg-int": out.push(`${this.reg(i.a)}=(-${this.reg(i.b)})|0;`); return;
      case "not-int": out.push(`${this.reg(i.a)}=~${this.reg(i.b)};`); return;
      case "neg-long": out.push(`${this.reg(i.a)}=BigInt.asIntN(64,-${this.reg(i.b)});`); return;
      case "not-long": out.push(`${this.reg(i.a)}=BigInt.asIntN(64,~${this.reg(i.b)});`); return;
      case "neg-float": case "neg-double": out.push(`${this.reg(i.a)}=-${this.reg(i.b)};`); return;
      case "int-to-long": out.push(`${this.reg(i.a)}=BigInt(${this.reg(i.b)});`); return;
      case "int-to-float": out.push(`${this.reg(i.a)}=Math.fround(${this.reg(i.b)});`); return;
      case "int-to-double": out.push(`${this.reg(i.a)}=${this.reg(i.b)};`); return;
      case "long-to-int": out.push(`${this.reg(i.a)}=Number(BigInt.asIntN(32,${this.reg(i.b)}));`); return;
      case "long-to-float": out.push(`${this.reg(i.a)}=Math.fround(Number(${this.reg(i.b)}));`); return;
      case "long-to-double": out.push(`${this.reg(i.a)}=Number(${this.reg(i.b)});`); return;
      case "float-to-int": case "double-to-int": out.push(`${this.reg(i.a)}=R.f2i(${this.reg(i.b)});`); return;
      case "float-to-long": case "double-to-long": out.push(`${this.reg(i.a)}=R.f2l(${this.reg(i.b)});`); return;
      case "float-to-double": out.push(`${this.reg(i.a)}=${this.reg(i.b)};`); return;
      case "double-to-float": out.push(`${this.reg(i.a)}=Math.fround(${this.reg(i.b)});`); return;
      case "int-to-byte": out.push(`${this.reg(i.a)}=(${this.reg(i.b)}<<24)>>24;`); return;
      case "int-to-char": out.push(`${this.reg(i.a)}=${this.reg(i.b)}&0xffff;`); return;
      case "int-to-short": out.push(`${this.reg(i.a)}=(${this.reg(i.b)}<<16)>>16;`); return;
    }
    const two = n.endsWith("/2addr");
    const lit = n.includes("/lit") || n === "rsub-int"; // 0xd1 is 22s (literal) despite the bare name
    const base = n.replace("/2addr", "").replace("/lit16", "").replace("/lit8", "");
    const [x, y] = two ? [this.reg(i.a), this.reg(i.b)] : lit ? [this.reg(i.b), this.literal(i.c)] : [this.reg(i.b), this.reg(i.c)];
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
    out.push(`${this.reg(i.a)}=${expr};`);
  }
}

function nz(v: string): string { return `(${v}===null||${v}===0)`; }

const litOf = (v: number) => Object.is(v, -0) ? "-0" : Number.isFinite(v) ? String(v) : v !== v ? "NaN" : v > 0 ? "Infinity" : "-Infinity";

function typedArrayCtor(elem: string): string {
  const c = PRIM_ARRAYS[elem as PrimElem];
  if (!c) throw new Error("elem " + elem);
  return c.name;
}
