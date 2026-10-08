// DEX bytecode → shared cold handlers and specialized hot methods.
// Control flow: `for(;;) switch(pc)` over basic blocks; DEX try ranges → JS catch with
// pc-range dispatch. Every method runs synchronously: a call returns its value, or its callee
// throws SUSPENDED (suspend.ts), and only then does the caller save its frame (Runtime.dfr).

import type { DexFile, CodeItem, EncodedMethod } from "./dex";
import { mangleMethod, directName, frameName, parseMethodDesc, isWide, descToName, intBitsToFloat, longBitsToDouble, PRIM_ARRAYS, varHandleValues, type PrimElem } from "./abi";
import { ACC, JObj, TYPE_MARK, type Runtime, type ClassInfo } from "./runtime";
import { perf } from "../perf";
import { coldOp, type ColdMethod } from "./cold";
import { frameCode } from "./frames";
import { jvmProfiler } from "./profile";
import { coverageProbeSource } from "./coverage";
import { codeKey, type Form } from "./codecache";
import { addCell, retarget, compileTieredMethod, type Cells, type CompiledCtor, type JvmFunction } from "./tiering";
import { javaFace, publicFace, setJava, setPublic, xname } from "./suspend";
import { type Flow, Go, structure } from "./structure";
import { discardedTypes, holdsNoThrowable, transparentCall } from "./discard";
import {
  coldInstructions,
  endsBlock,
  ifTarget,
  prepareMethod,
  switchCases,
  type PreparationPhase,
  type PreparedInstruction as Ins,
  type PreparedMethod,
  writesRegister,
} from "./prepared";

const REL: Record<string, string> = { lt: "<", ge: ">=", gt: ">", le: "<=" };
const holder = (isStatic: boolean) => (isStatic ? "C" : "C.prototype");
const paramList = (desc: string) => parseMethodDesc(desc).params.map((_, j) => "p" + j).join(",");
const isRef = (desc: string) => desc[0] === "L" || desc[0] === "[";

// Compile on first call; smoke compilation disables laziness to surface every method failure.
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
  return prepareMethod(dex, code, desc, isStatic, observe);
}

export function compileClassSource(R: Runtime, dex: DexFile, info: ClassInfo): string {
  return classSource(R, dex, info, false);
}

export function compileClass(R: Runtime, dex: DexFile, info: ClassInfo): void {
  const src = classSource(R, dex, info, lazyMethods, true);
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

function classSource(R: Runtime, dex: DexFile, info: ClassInfo, lazy: boolean, bind = false): string {
  const def = info.def!;
  const out: string[] = [];
  info.lazy = lazy ? [] : undefined;
  for (const list of [def.directMethods, def.virtualMethods]) {
    for (const m of list) {
      if (m.codeOff) {
        if (info.lazy) installLazy(R, dex, info, m);
        else out.push(emitEagerMethod(R, dex, info, m, bind));
      }
      else if (m.flags & ACC.NATIVE) {
        const source = emitNativeStub(dex, info, m);
        out.push(bind ? frameCode(R, source, frameName(info.name, methodKey(dex, m.methodIdx).name, m.methodIdx)) : source);
      }
    }
  }
  return out.join("\n");
}

/** a method installed as a stub that compiles it on first call; name and descriptor are decoded
 *  then, not for every stub a boot installs */
export class LazyMethod {
  constructor(readonly dex: DexFile, readonly m: EncodedMethod, readonly mangled: string, readonly isStatic: boolean,
    readonly stub: JvmFunction & Cells, readonly fallthrough: boolean, readonly intrinsic?: JvmFunction) {}
  get name(): string { return methodKey(this.dex, this.m.methodIdx).name; }
  get desc(): string { return methodKey(this.dex, this.m.methodIdx).desc; }
}

/** Captured direct/interface entries retain the cell; fresh virtual calls find the installed body.
 *  `fallthrough` marks a platform body installed on a native class, compiled only if safe. */
export function installLazy(R: Runtime, dex: DexFile, info: ClassInfo, m: EncodedMethod, fallthrough = false,
  mangled = methodKey(dex, m.methodIdx).mangled): void {
  const isStatic = (m.flags & ACC.STATIC) !== 0;
  const i = (info.lazy ??= []).length;
  const C: CompiledCtor = info.ctor, arity = parseMethodDesc(methodKey(dex, m.methodIdx).desc).params.length;
  let entry: JvmFunction | undefined;
  const stub: JvmFunction & Cells = function (this: unknown, ...args: unknown[]) {
    entry ??= R.lz(C, i);
    return entry.apply(this, args);
  };
  stub.$c = null;
  // an intrinsic stands in for the body wherever it is reached; the stub stays its AOSP fallback,
  // which it calls as host code does
  const intrinsic = fallthrough ? undefined : R.intrinsics.get(info.name)?.get(mangled)?.(publicFace(stub, arity), C);
  info.lazy.push(new LazyMethod(dex, m, mangled, isStatic, stub, fallthrough, intrinsic));
  if (intrinsic) setPublic(isStatic ? C : C.prototype, mangled, intrinsic, arity);
  else setJava(isStatic ? C : C.prototype, mangled, stub, arity);
  // a constructor or private method also goes under its direct name now: added once a class has
  // instances, it would change their prototype's shape under code already running. Only compiled
  // code calls a direct name, so it holds the Java-ABI function.
  if (!isStatic && (mangled.startsWith("i$") || m.flags & ACC.PRIVATE)) {
    const direct = directName(info.name, mangled);
    C.prototype[direct] = intrinsic ? javaFace(intrinsic, arity) : stub;
    if (!intrinsic) addCell(stub, C.prototype, direct);
  }
}

/** Does `fn` (a Java-ABI function), as `info` reaches it, stand for a platform body that reads
 *  fields its native class lacks? Such a body is not a method the class has. */
export function unsafeFallthrough(R: Runtime, info: ClassInfo, fn: unknown): boolean {
  if ((fn as Cells).$unsafe) return true;
  for (let i: ClassInfo | null = info; i; i = i.superInfo) {
    const rec = i.lazy?.find((r) => r.stub === fn);
    if (rec) return rec.fallthrough && R.absentFields(rec.dex, rec.m).length > 0;
  }
  return false;
}

export function compileLazyMethod(R: Runtime, C: CompiledCtor, i: number): JvmFunction {
  const info = C.$i, rec = info.lazy![i], dex = rec.dex;
  const profileName = `${info.name}.${rec.name}${rec.desc}`;
  const target = rec.isStatic ? C : C.prototype, arity = parseMethodDesc(rec.desc).params.length;
  if (rec.fallthrough) {
    const absent = R.absentFields(dex, rec.m);
    // a body that cannot run on this object yields to an interface default, or to Object's
    const fallback = absent.length && !rec.isStatic
      ? (R.interfaceDefault(info, rec.mangled) ?? JObj.prototype[xname(rec.mangled) as never]) as JvmFunction | undefined : undefined;
    if (fallback) {
      retarget(rec.stub, fallback);
      setJava(target, rec.mangled, fallback, arity);
      return fallback;
    }
    if (absent.length) {
      const what = `unsafe-fallthrough ${profileName} ${absent.join(",")}`;
      const fail: JvmFunction & Cells = () => {
        R.noteMissing(what);
        throw R.mkThrowable("java/lang/NoSuchMethodError", what);
      };
      fail.$unsafe = true;
      retarget(rec.stub, fail);
      setJava(target, rec.mangled, fail, arity);
      return fail;
    }
  }
  const code = dex.code(rec.m.codeOff);
  return compileTieredMethod(R, C, rec, {
    prepare: () => prepareDexMethod(dex, code, rec.desc, rec.isStatic, profileName),
    entry: (prepared, count) => emitMethod(R, dex, info, rec.m, prepared, count),
    resume: (prepared) => resumableSource(R, dex, info, rec.m, prepared),
    cold: (prepared) => Object.assign(new MethodEmitter(R, dex, info, code, rec.isStatic, rec.desc, rec.name, "cold", rec.m.methodIdx)
      .compileCold(prepared, coldInstructions(code, prepared)), { codeOff: rec.m.codeOff }),
  });
}

/** a lazy method's body as `form` emits it, each instruction's first line marked with its pc */
export function markedBody(R: Runtime, info: ClassInfo, rec: LazyMethod, form: Form): string {
  const prepared = prepareDexMethod(rec.dex, rec.dex.code(rec.m.codeOff), rec.desc, rec.isStatic, "");
  return form === "e" ? emitMethod(R, rec.dex, info, rec.m, prepared, false, true) : resumableSource(R, rec.dex, info, rec.m, prepared, true);
}

type MethodKey = { name: string; desc: string; mangled: string };
const methodKeys = new WeakMap<DexFile, MethodKey[]>();
/** A method's hot entry as the code cache keys and stores it, emitted without compiling: a compile
 *  worker's output (§4.4). Platform fallthrough bodies depend on the page's native classes. */
export function entryBody(R: Runtime, info: ClassInfo, methodIdx: number): [key: string, body: string] | undefined {
  const rec = info.lazy?.find((r) => r.m.methodIdx === methodIdx);
  if (!rec || rec.fallthrough) return undefined;
  const prepared = prepareDexMethod(rec.dex, rec.dex.code(rec.m.codeOff), rec.desc, rec.isStatic, "");
  return [codeKey(rec.dex.id, methodIdx, "e"), emitMethod(R, rec.dex, info, rec.m, prepared, false)];
}

/** a method ref's name, descriptor and mangled property: every class compile needs them */
export function methodKey(dex: DexFile, methodIdx: number): MethodKey {
  let keys = methodKeys.get(dex);
  if (!keys) methodKeys.set(dex, keys = []);
  let key = keys[methodIdx];
  if (!key) {
    const name = dex.method(methodIdx).name, desc = dex.methodDesc(methodIdx);
    key = keys[methodIdx] = { name, desc, mangled: mangleMethod(name, desc) };
  }
  return key;
}

/** Resolved on first call, not when the class body is generated: a JNI_OnLoad run later may
 *  register the native. Keep its defining frame after caching the JNI target. */
function emitNativeStub(dex: DexFile, info: ClassInfo, m: EncodedMethod): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const target = holder((m.flags & ACC.STATIC) !== 0);
  const cls = JSON.stringify(info.name), v = `$n${m.methodIdx}`;
  const ps = paramList(desc), arity = parseMethodDesc(desc).params.length;
  return `let ${v};${target}.${mangled}=R.frameMethod(function ${frameName(info.name, name, m.methodIdx)}(${ps}){` +
    `if(!${v}&&!(${v}=R.jniFn(${cls},${JSON.stringify(name + desc)})))` +
    `throw R.ulink(${cls},${JSON.stringify(name)},${JSON.stringify(desc)});` +
    `return ${v}.call(this${ps ? "," + ps : ""})},${JSON.stringify(frameName(info.name, name, m.methodIdx))});${target}.${xname(mangled)}=R.jf(${target}.${mangled},${arity});`;
}

/** A hot entry. A frame that suspends hands itself to `$R()`, the method's resumable body.
 *  Bodies are parenthesized because each runs as soon as it compiles: V8 then compiles it eagerly
 *  rather than preparsing it and parsing it again on the first call. */
function emitMethod(R: Runtime, dex: DexFile, info: ClassInfo, m: EncodedMethod, prepared: PreparedMethod, count = true, marked = false): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const isStatic = (m.flags & ACC.STATIC) !== 0;
  try {
    const body = new MethodEmitter(R, dex, info, dex.code(m.codeOff), isStatic, desc, name, "hot", m.methodIdx, marked).compile(prepared, count, "entry");
    const h = holder(isStatic), x = `${h}.${xname(mangled)}`;
    // a leaf never suspends, so host code may call its entry as it is
    return `{const $ic=[];${x}=(${body});${h}.${mangled}=${prepared.sync ? x : `R.pub(${x},${parseMethodDesc(desc).params.length})`};}`;
  } catch (error) { return unimplementedMethod(info, m, dex, error); }
}

/** A method that cannot compile throws when called, so the rest of its class still runs. */
function unimplementedMethod(info: ClassInfo, m: EncodedMethod, dex: DexFile, error: unknown): string {
  const { name, desc, mangled } = methodKey(dex, m.methodIdx);
  const message = `compile error ${info.name}.${name}${desc}: ${error}`;
  console.warn(message);
  const h = holder((m.flags & ACC.STATIC) !== 0);
  return `${h}.${xname(mangled)}=${h}.${mangled}=function(){ throw R.unimplemented(${JSON.stringify(message)}); };`;
}

/** An expression evaluating to the method's resumable body. */
function resumableSource(R: Runtime, dex: DexFile, info: ClassInfo, m: EncodedMethod, prepared: PreparedMethod, marked = false): string {
  const { name, desc } = methodKey(dex, m.methodIdx);
  const body = new MethodEmitter(R, dex, info, dex.code(m.codeOff), (m.flags & ACC.STATIC) !== 0, desc, name, "hot", m.methodIdx, marked).compile(prepared, false, "resumable");
  return `(()=>{const $ic=[];const $m=(${body}),$R=()=>$m;return $m;})()`;
}

function emitEagerMethod(R: Runtime, dex: DexFile, info: ClassInfo, method: EncodedMethod, bind: boolean): string {
  const { name, desc } = methodKey(dex, method.methodIdx);
  try {
    const prepared = prepareDexMethod(dex, dex.code(method.codeOff), desc, (method.flags & ACC.STATIC) !== 0, `${info.name}.${name}${desc}`);
    const bindBody = (source: string) => bind ? frameCode(R, source, frameName(info.name, name, method.methodIdx)) : source;
    const entry = bindBody(emitMethod(R, dex, info, method, prepared));
    return prepared.sync ? entry : `{let $rb;const $R=()=>$rb??=${bindBody(resumableSource(R, dex, info, method, prepared))};${entry}}`;
  } catch (error) { return unimplementedMethod(info, method, dex, error); }
}

type EmitBackend = "cold" | "hot";
/** A hot method's entry runs calls to completion and hands a suspended frame to its resumable
 *  body, which re-enters that frame at the suspended call. */
type HotForm = "entry" | "resumable";

class MethodEmitter {
  private readonly hasTries: boolean;

  constructor(
    private R: Runtime, private dex: DexFile, private info: ClassInfo,
    private code: CodeItem, private isStatic: boolean, private desc: string,
    private mname: string, private backend: EmitBackend,
    /** the method's index, which its function name carries for a stack to name it exactly */
    private methodIdx: number,
    /** each instruction's first line starts with a comment naming its pc (stackLines.ts) */
    private marked = false,
  ) {
    this.hasTries = code.tries.length > 0;
  }

  private resumes = 0;
  private resuming = false;
  private prepared: PreparedMethod | null = null;
  /** per try item, the classes its handlers discard unread (discard.ts), computed on first use */
  private discarded: (string | null)[] | null = null;
  private quietCalls = 0;
  private ics = 0;
  /** Four slots in the method's type-check cache: two receiver classes (and their results). */
  private icSlot(): number { const k = this.ics; this.ics += 4; return k; }
  private constants: unknown[] = [];
  /** int constants the current block has loaded and not yet overwritten, by register: a long
   *  shift by one compiles to a BigInt literal shift V8 lowers to int64 */
  private known = new Map<number, number>();

  private get cold(): boolean { return this.backend === "cold"; }
  /** the hot body being compiled is a leaf: it has no suspension points */
  private sync = false;
  /** the hot entry's structured control flow, and the block being emitted */
  private flow: Flow | null = null;
  private block = 0;

  private reg(index: number): string { return this.cold ? `F.v[${this.literal(index)}]` : `v${index}`; }
  /** registers a constant may reach, the only ones a reference read normalizes from 0 to null */
  private nullable: ReadonlySet<number> = new Set();
  private ref(index: number): string { const r = this.reg(index); return this.nullable.has(index) ? `(${r}===0?null:${r})` : r; }
  private literal(value: string | number | bigint): string {
    if (!this.cold) return typeof value === "string" ? JSON.stringify(value) : typeof value === "bigint" ? `${value}n` : litOf(value);
    const index = this.constants.length;
    this.constants.push(value);
    return `K[${index}]`;
  }
  /** a test of the prototype's type mark (runtime.ts markTypes), ahead of the site cache's; a
   *  forked runtime's sites resolve names to its own classes, which the marks do not tell apart */
  private typeMark(v: string, tname: string, rest: string): string {
    return this.R.parent ? "" : `${v}[${JSON.stringify(TYPE_MARK + tname)}]${rest}`;
  }
  private prop(name: string): string { return this.cold ? `[${this.literal(name)}]` : `.${name}`; }
  private temp(name: string): string { return this.cold ? `F.$${name}` : `$${name}`; }
  private get t(): string { return this.temp("t"); }
  private get u(): string { return this.temp("u"); }
  private get ex(): string { return this.temp("ex"); }

  /** Handlers are built per instruction when it first runs. */
  compileCold(prepared: PreparedMethod, instructionAt: (pc: number) => Ins): ColdMethod {
    const widths = prepared.widths;
    this.nullable = prepared.nullable;
    perf.asyncMethods++;
    const name = `${this.info.name}.${this.mname}${this.desc}`;
    const ops: ColdMethod["ops"] = new Array(this.code.insns.length);
    const build = (pc: number) => {
      const started = jvmProfiler.enabled ? performance.now() : 0;
      const ins = instructionAt(pc), out: string[] = [];
      this.constants = [];
      this.emitIns(ins, out);
      const op = ops[pc] = coldOp(out.join("\n"), this.constants, ins.pc + ins.len);
      if (ins.name.startsWith("invoke") && !ins.name.startsWith("invoke-custom")) op.method = ins.b;
      if (jvmProfiler.enabled) jvmProfiler.add(name, "coldBuild", performance.now() - started);
      return op;
    };
    return { name, R: this.R, D: this.R.dexLink(this.dex), S: this.info.superInfo?.ctor,
      regs: this.code.regs, first: this.code.regs - this.code.ins, instance: !this.isStatic,
      hotness: 0, profiledInstructions: 0,
      widths, ops, build,
      catches: this.code.tries.map((t) => ({ start: t.start, end: t.end, all: t.catchAllAddr,
        handlers: t.handlers.map(([type, pc]) => [descToName(this.dex.type(type)), pc]) })) };
  }

  /**
   * A hot method is a plain function: calls return values directly, and a callee that suspends
   * returns a Promise. Only then does this frame capture its registers and return a Promise of
   * its own (R.dfr), which calls the resumable body with that frame (`$F`) to continue at the
   * suspended call. Frames therefore pay for asynchrony only when something actually waits.
   */
  compile(prepared: PreparedMethod, count: boolean, form: HotForm): string {
    this.resuming = form === "resumable";
    this.prepared = prepared;
    this.sync = prepared.sync;
    this.nullable = prepared.nullable;
    const started = jvmProfiler.enabled ? performance.now() : 0;
    if (count) { if (this.sync) perf.syncMethods++; else perf.asyncMethods++; }
    // A resumable body re-enters mid-block by pc, so only the entry is structured.
    const flow = this.flow = this.resuming ? null : structure(prepared, this.code);
    const blocks: string[] = [];
    let cur: string[] | null = null, last: Ins | null = null;
    const end = () => {
      if (!cur) return;
      if (flow && last && !endsBlock(last.op)) {
        const taken = last.op >= 0x32 && last.op <= 0x3d ? flow.blockAt[ifTarget(last)] : -1;
        const target = flow.fallTarget(this.block, taken);
        if (target >= 0) cur.push(this.jumpStr(flow.starts[target], last.pc, true));
      }
      blocks.push(cur.join("\n"));
    };
    for (const ins of prepared.instructions) {
      if (prepared.leaders[ins.pc]) {
        this.known.clear();
        end();
        if (flow) this.block = flow.blockAt[ins.pc];
        const at = this.hasTries ? `pc=${ins.pc};` : "";
        cur = [flow ? at : `case ${ins.pc}:${at}`];
      }
      if (!cur) throw new Error(`instruction ${ins.pc} has no emitted block`);
      const at = cur.length;
      this.emitIns(ins, cur);
      if (writesRegister(ins.op)) {
        // a wide write takes a+1 too; any write but a 32-bit int constant forgets both
        this.known.delete(ins.a); this.known.delete(ins.a + 1);
        if (ins.op >= 0x12 && ins.op <= 0x14 && ins.constKind === undefined) this.known.set(ins.a, ins.b);
      }
      if (this.marked && cur.length > at) cur[at] = `/*@${ins.pc}*/` + cur[at];
      last = ins;
    }
    end();

    const params = prepared.params;
    const regs = this.code.regs, ins = this.code.ins;
    let reg = regs - ins;
    const jsParams: string[] = [];
    const paramInit: string[] = [];
    const paramRegs = new Set<number>();
    if (!this.isStatic) { paramInit.push(`v${reg}=this`); paramRegs.add(reg); reg++; }
    for (let i = 0; i < params.length; i++) {
      jsParams.push(`p${i}`);
      paramInit.push(`v${reg}=p${i}`);
      paramRegs.add(reg);
      reg += prepared.widths[i];
    }
    const allRegs = Array.from({ length: regs }, (_, i) => `v${i}`);
    const locals = [...paramInit, ...allRegs.filter((_, i) => !paramRegs.has(i))];
    // var, not let: a let without an initializer costs bytecode to set it, which counts against
    // V8's inlining budget
    const init = this.sync ? `var ${[...locals, "$t", "$u", "$ex", "pc=0"].join(",")};`
      : !this.resuming ? `var ${[...locals, "$t", "$u", "$ex", "$fu", "$q", "$r=0", "pc=0"].join(",")};const $th=R.cur;`
      : `var ${[...allRegs.map((r, i) => `${r}=$F.v[${i}]`), "$t=$F.$t", "$u=$F.$u", "$ex=$F.$ex", "$fu", "$q", "pc=$F.next", "$r=$F.r"].join(",")};` +
        `const $th=$F.$th,$s=$F.$s;R.st($th);`;

    const catchBody = this.hasTries ? (this.quietCalls ? "R.quiet.types=null;" : "") + "$e=R.jx($e);\n" + this.emitCatch() : this.leave() + "throw R.jx($e);";
    const profileName = `${this.info.name}.${this.mname}${this.desc}`;
    const profileStart = jvmProfiler.enabled
      ? `const $pn=${JSON.stringify(profileName)},$pt=performance.now();${this.resuming ? "" : "P.entry($pn);"}try{`
      : "";
    const profileEnd = jvmProfiler.enabled ? `}finally{P.add($pn,"hotRun",performance.now()-$pt);}` : "";
    const regions = flow?.assemble((b) => blocks[b]);
    const dispatch = regions?.length === 1 ? `{${regions[0]}}`
      : `switch(${this.resuming ? "$r?-$r:pc" : "pc"}){\n${regions ? regions.map((r, i) => `case ${flow!.starts[flow!.regions[i].entry]}:{${r}}`).join("\n") : blocks.join("\n")}\ndefault:R.badPc(pc);\n}`;
    // a callee's suspension (SUSPENDED) leaves the catch for the save point with the site it
    // recorded, as a helper's Promise does by breaking out of $d
    const suspended = `if($e===R.S){$r=$q;$t=R.S.p;${this.quietCalls ? "R.quiet.types=null;" : ""}}else{`;
    const body = this.sync ? `try{${dispatch}
}catch($e){
${catchBody}
}` : `try{$d:${dispatch}
}catch($e){${suspended}
${this.resuming ? "R.st($th);$r=0;" : ""}${catchBody}
}}
${this.saveFrame()}`;
    const source = `function ${frameName(this.info.name, this.mname, this.methodIdx)}(${this.resuming ? "$F" : jsParams.join(",")}){
${this.resuming ? "" : coverageProbeSource(profileName)}
${profileStart}
${init}
${regions?.length === 1 && !this.hasTries ? body : `$l:for(;;){\n${body}\n}`}
${profileEnd}
}`;
    if (jvmProfiler.enabled) jvmProfiler.add(profileName, "hotEmit", performance.now() - started);
    return `R.frameMethod(${source})`;
  }

  /** One save point per method: a helper's suspension sets `$r` (0 for a back-edge yield) and `pc`
   *  and breaks to it, a callee's comes from the catch. R.dfr takes the Promise: a suspended value
   *  is replaced by its result on resume, so `$t` and `$u` never hold a stale one. An entry throws
   *  its own suspension to its caller; a resumable body, which only continuations call, returns it.
   *  It is kept short because its bytecode counts against inlining the method into its callers. */
  private saveFrame(): string {
    const profiled = jvmProfiler.enabled ? `P.suspension($pn);` : "";
    const save = `R.dfr($R,this,$r,pc,$th,$t,$u,$ex,$fu,${Array.from({ length: this.code.regs }, (_, i) => `v${i}`).join(",")})`;
    return `${profiled}${this.resuming ? `if($s)R.su();return ${save};` : `R.S.p=${save};throw R.S;`}`;
  }

  /** A resumed frame finishing hands the main looper back its thread: its caller re-pins its own
   *  thread when it resumes, and shell code expects the main thread. */
  private leave(): string { return this.resuming ? "if($s)R.su();" : ""; }

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

  /** A call or class initialization: its value, or a suspension when it is a Promise. A body
   *  holding any of these instructions never compiles as a leaf. */
  /** a runtime helper that returns a Promise when it must wait (class initialization, resolution,
   *  a contended monitor, a host call site) */
  private guard(expr: string, out: string[], assignTo = this.t, quiet?: string) {
    out.push(quiet ? `R.quiet.types=${JSON.stringify(quiet)};${assignTo}=${expr};R.quiet.types=null;${this.suspend(assignTo)}` : `${assignTo}=${expr};${this.suspend(assignTo)}`);
  }

  /** Whether a call to `cls.mangled` most likely reaches a host function (a native spec's method, an
   *  intrinsic): it then goes through the public name and tests for a Promise, cheaper than the
   *  Java-ABI adapter around a host function (suspend.ts). Either name is correct for any target.
   *  Object's methods are mostly overridden in bytecode. */
  private hostCall(cls: string, mangled: string): boolean {
    return cls !== "java/lang/Object" && (this.R.natives.has(cls) || !!this.R.intrinsics.get(cls)?.has(mangled));
  }
  /** A call through a Java-ABI name: a callee that suspends throws SUSPENDED, so the site only
   *  records itself in `$q` for the catch that saves the frame, and a cold handler's runner takes
   *  the suspension as the call's (cold.ts). */
  private call(expr: string, out: string[], quiet?: string) {
    if (this.cold) { out.push(`${this.t}=${expr};`); return; }
    const site = ++this.resumes;
    out.push(quiet ? `$q=${site};R.quiet.types=${JSON.stringify(quiet)};$t=${expr};R.quiet.types=null;` : `$q=${site};$t=${expr};`);
    if (this.resuming) out.push(this.resumeCase(site, "$t"));
  }

  /** a cache read whose miss resolves through `slow`: a hit is a constructor or function, so only a
   *  miss tests for a Promise (instanceof walks a hit's whole prototype chain) */
  private guardMiss(fast: string, slow: string, out: string[], assignTo = this.u) {
    if (this.cold) { this.guard(`${fast}??${slow}`, out, assignTo); return; }
    out.push(`${assignTo}=${fast};${this.suspend(assignTo, `${assignTo}===undefined&&(${assignTo}=${slow}) instanceof Promise`)}`);
  }

  /** The classes a hot call's throwables skip their stack capture for (discard.ts): its try item's
   *  handlers discard them, and the call returns nothing that could be one. */
  private quietTypes(i: Ins): string | undefined {
    if (this.cold || !this.hasTries || !this.prepared) return undefined;
    const k = this.code.tries.findIndex((t) => i.pc >= t.start && i.pc < t.end);
    if (k < 0) return undefined;
    const types = (this.discarded ??= discardedTypes(this.R, this.dex, this.code, this.prepared.instructions))[k];
    const ret = this.dex.type(this.dex.proto(this.dex.method(i.b).proto).ret);
    if (!types || !transparentCall(this.R, this.dex, i.b, i.op) || !holdsNoThrowable(this.R, ret)) return undefined;
    this.quietCalls++;
    return types;
  }

  private suspend(value: string, pending = `${value} instanceof Promise`): string {
    if (this.cold) {
      // A cold handler returns the Promise it waits on. Only a call result resumes past the
      // handler (F.$w); a class-init or resolution wait reruns it once its cache is filled.
      return `if(${value} instanceof Promise){F.$w=${value === this.t ? 1 : 0};return ${value};}`;
    }
    const resume = ++this.resumes, save = `if(${pending}){$r=${resume};break $d}`;
    return this.resuming ? save + this.resumeCase(resume, value) : save;
  }
  /** where a resumed frame re-enters at `site`, taking the result into `value` */
  private resumeCase(site: number, value: string): string { return `case -${site}:if($r){$r=0;if($F.e)throw $F.x;${value}=$F.val;}`; }

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
      case "return-object": out.push(`${this.cold ? "F.done=true;F.value=" : this.leave() + "return "}${this.ref(i.a)};`); break;
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
      case "const-class": {
        const load = `R.classForIdx(D,${this.literal(i.b)})`;
        if (this.cold) { out.push(`${this.reg(i.a)}=${load};`); break; }
        const k = this.ics++;
        out.push(`${this.reg(i.a)}=$ic[${k}]??($ic[${k}]=${load});`);
        break;
      }
      case "monitor-enter": this.guard(`R.me(${this.reg(i.a)},${this.reg(i.a)}.$mon)`, out); break;
      case "monitor-exit": out.push(`R.mx(${this.reg(i.a)},${this.reg(i.a)}.$mon);`); break;
      case "check-cast": {
        const v = this.reg(i.a), tname = descToName(dex.type(i.b)), name = this.literal(tname);
        if (this.cold) { out.push(`R.cc(${v},${name});`); break; }
        const k = this.icSlot();
        out.push(`if(${v}!=null&&${v}!==0&&${this.typeMark(v, tname, "!==1&&")}${v}.constructor!==$ic[${k}]&&${v}.constructor!==$ic[${k + 2}])R.ccc(${v},${name},$ic,${k});`);
        break;
      }
      case "instance-of": {
        const v = this.reg(i.b), tname = descToName(dex.type(i.c)), name = this.literal(tname);
        if (this.cold) { out.push(`${this.reg(i.a)}=R.iof(${v},${name});`); break; }
        const k = this.icSlot();
        out.push(`${this.reg(i.a)}=${v}==null?0:${this.typeMark(v, tname, "===1?1:")}${v}.constructor===$ic[${k}]?$ic[${k + 1}]:${v}.constructor===$ic[${k + 2}]?$ic[${k + 3}]:R.iofc(${v},${name},$ic,${k});`);
        break;
      }
      case "array-length": out.push(`${this.reg(i.a)}=${this.reg(i.b)}.length;`); break;
      case "new-instance": {
        const tname = descToName(dex.type(i.b));
        if (tname === "java/lang/String") { out.push(`${this.reg(i.a)}="";`); break; }
        if (tname === this.info.name) out.push(`${this.u}=D.cl[${this.literal(i.b)}]??D.link(${this.literal(i.b)});`);
        else this.guardMiss(`D.ic[${this.literal(i.b)}]`, `D.init(${this.literal(i.b)}${this.fromArg})`, out, this.u);
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
          out.push(`${this.t}=R.oa(${this.literal(i.regs.length)},${this.literal(elem)});${i.regs.map((r, j) => `${this.t}[${this.literal(j)}]=${this.ref(r)};`).join("")}`);
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
      case "goto": case "goto/16": case "goto/32": out.push(this.jumpStr(i.pc + i.a, i.pc, true)); break;
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
          const val = i.name === "aput-object" ? this.ref(i.a) : this.reg(i.a);
          out.push(`if((${this.reg(i.c)}>>>0)>=${this.reg(i.b)}.length)R.aio(${this.reg(i.c)},${this.reg(i.b)}.length);${this.reg(i.b)}[${this.reg(i.c)}]=${val};`);
        } else if (i.name.startsWith("iget")) {
          out.push(`${this.reg(i.a)}=${this.reg(i.b)}${this.prop(this.fieldProp(i.c))};`);
        } else if (i.name.startsWith("iput")) {
          out.push(`${this.reg(i.b)}${this.prop(this.fieldProp(i.c))}=${isRef(this.dex.type(this.dex.field(i.c).type)) ? this.ref(i.a) : this.reg(i.a)};`);
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

  /** `final` ends the block; any other jump sits inside a test. */
  private jumpStr(target: number, from: number, final = false): string {
    if (this.cold) {
      const fuel = target <= from ? `if(--R.fuel<0){F.$fu=R.refuel();if(F.$fu){F.$w=0;return F.$fu;}}` : "";
      return `${fuel}F.next=${this.literal(target)};return;`;
    }
    // every cycle takes a backward edge, which yields to the scheduler when fuel runs out
    const fuel = (back: boolean) => !this.sync && back ? `if(--R.fuel<0){$fu=R.refuel();if($fu){pc=${target};break $d}}` : "";
    const flow = this.flow;
    if (!flow) return `${fuel(target <= from)}pc=${target};continue;`;
    const v = flow.blockAt[target];
    switch (flow.go(this.block, v, final)) {
      case Go.Next: return "";
      case Go.Break: return `break B${target};`;
      case Go.Continue: return `${fuel(true)}continue L${target};`;
      case Go.Dispatch: return `${fuel(flow.back(this.block, v))}pc=${target};continue $l;`;
    }
  }

  private emitIf(cond: string, i: Ins, out: string[]) {
    const flow = this.flow, target = ifTarget(i);
    if (!flow) { out.push(`if(${cond}){${this.jumpStr(target, i.pc)}}`); return; }
    const fall = i.pc + i.len;
    // both edges reaching the same block leave nothing to test; the block's end takes them
    if (flow.blockAt[target] === flow.blockAt[fall]) return;
    if (flow.inverted.has(this.block)) out.push(`if(!(${cond})){${this.jumpStr(fall, i.pc)}}`);
    else out.push(`if(${cond}){${this.jumpStr(target, i.pc)}}`);
  }

  private emitStaticField(i: Ins, out: string[], isGet: boolean) {
    const { prop, typeIdx } = this.R.resolveStaticField(this.dex, i.b);
    if (typeIdx >= 0 && descToName(this.dex.type(typeIdx)) === this.info.name && !this.info.isInterface) {
      out.push(`${this.u}=D.cl[${this.literal(typeIdx)}]??D.link(${this.literal(typeIdx)});`);
    } else if (typeIdx >= 0) {
      this.guardMiss(`D.ic[${this.literal(typeIdx)}]`, `D.init(${this.literal(typeIdx)}${this.fromArg})`, out, this.u);
    } else {
      this.guardMiss(`D.fs[${this.literal(i.b)}]`, `D.rsf(${this.literal(i.b)}${this.fromArg})`, out, this.u);
    }
    out.push(isGet ? `${this.reg(i.a)}=${this.u}${this.prop(prop)};` : `${this.u}${this.prop(prop)}=${isRef(this.dex.type(this.dex.field(i.b).type)) ? this.ref(i.a) : this.reg(i.a)};`);
  }

  /** an instruction we cannot compile: throw here, so the rest of the method still runs */
  private unsupported(what: string): string {
    return `throw R.unimplemented(${this.literal(`${this.info.name} ${what}`)});`;
  }

  /** argument expressions for registers `regs[first..]` typed by `params`: wide values take
   *  two registers and a reference 0 is null */
  private args(i: Ins, params: readonly string[], first: number): string[] {
    const args: string[] = [];
    let ri = first;
    for (const p of params) {
      args.push(isRef(p) ? this.ref(i.regs[ri]) : this.reg(i.regs[ri]));
      ri += isWide(p) ? 2 : 1;
    }
    return args;
  }

  private emitInvoke(i: Ins, out: string[]) {
    const { dex } = this;
    if (i.name.startsWith("invoke-custom")) {
      const params = dex.protoParamTypes((dex.callSite(i.b)[2] as { idx: number }).idx);
      const k = this.literal(i.b);
      this.guard(`(D.cs[${k}]??D.ics(${k}))(${this.args(i, params, 0).join(",")})`, out);
      return;
    }
    const mref = dex.method(i.b);
    const desc = dex.methodDesc(i.b);
    const mangled = mangleMethod(mref.name, desc);
    const clsName = descToName(dex.type(mref.cls));
    const kind = i.name.replace("/range", "");
    const isInstance = kind !== "invoke-static";
    const recv = isInstance ? (i.nullRecv ? this.ref(i.regs[0]) : this.reg(i.regs[0])) : "";
    if (kind === "invoke-polymorphic") return this.emitPolymorphic(i, clsName, mref.name, recv, out);
    const argStr = this.args(i, dex.protoParamTypes(mref.proto), isInstance ? 1 : 0).join(",");
    const quiet = kind === "invoke-super" ? undefined : this.quietTypes(i);

    if (clsName[0] === "[") {
      // methods on array types (clone/getClass/…)
      out.push(`${this.t}=R.arrCall(${recv},${this.literal(mref.name)}${argStr && "," + argStr});`);
      return;
    }
    switch (kind) {
      case "invoke-virtual": case "invoke-interface": {
        const host = this.hostCall(clsName, mangled), call = `${recv}${this.prop(host ? mangled : xname(mangled))}(${argStr})`;
        // a String's order is its UTF-16 units', as JS compares strings
        const [r, o] = i.regs.map((x) => this.reg(x));
        const expr = i.signOnly ? `typeof ${r}==="string"&&typeof ${o}==="string"?${r}===${o}?0:${r}<${o}?-1:1:${call}` : call;
        if (host) this.guard(expr, out, this.t, quiet); else this.call(expr, out, quiet);
        break;
      }
      case "invoke-super": {
        const k = this.ics++;
        const fn = this.cold ? `D.rsp(${this.literal(i.b)},S)` : `($ic[${k}]??D.rsc($ic,${k},${i.b},S))`;
        this.call(`${fn}.call(${recv}${argStr ? "," + argStr : ""})`, out);
        break;
      }
      case "invoke-direct": {
        if (clsName === "java/lang/String" && mref.name === "<init>") {
          if (!(desc in this.R.newStr)) { out.push(this.unsupported("String.<init>" + desc)); break; }
          out.push(`${this.reg(i.regs[0])}=${desc === "([CII)V" ? "R.strChars" : `R.newStr[${this.literal(desc)}]`}(${argStr});`);
          break;
        }
        // same-class: entry into this class's code implies inited (or initing in
        // this chain — JVM reentrancy); skip init to avoid clinit self-deadlock
        const own = clsName === this.info.name;
        // A platform body on a native class keeps the resolved function: a native spec's JS class
        // need not extend its declared superclass. Strings are JS primitives, and an interface's
        // private method is on no implementor's prototype chain.
        if (this.cold || this.info.native || clsName === "java/lang/String" || (this.R.classDefOf(clsName)?.def.flags ?? 0) & ACC.INTERFACE) {
          if (own) out.push(`${this.u}=D.dp[${this.literal(i.b)}]??D.rdp0(${this.literal(i.b)});`);
          else this.guardMiss(`D.dp[${this.literal(i.b)}]`, `D.rdp(${this.literal(i.b)}${this.fromArg})`, out, this.u);
          this.call(`${this.u}.call(${recv}${argStr ? "," + argStr : ""})`, out, quiet);
          break;
        }
        // resolution installs the target under its direct name, reached as a method call (a call
        // through Function.prototype.call records no target, so V8 never inlined one)
        const k = this.ics++;
        if (own) out.push(`$ic[${k}]??D.rdc0($ic,${k},${i.b});`);
        else this.guardMiss(`$ic[${k}]`, `D.rdc($ic,${k},${i.b}${this.fromArg})`, out, this.u);
        this.call(`${recv}.${directName(clsName, mangled)}(${argStr})`, out, quiet);
        break;
      }
      case "invoke-static": {
        const own = clsName === this.info.name;
        if (own && this.cold) out.push(`${this.u}=D.cl[${this.literal(mref.cls)}]??D.link(${this.literal(mref.cls)});`);
        else if (!own) this.guardMiss(`D.ic[${this.literal(mref.cls)}]`, `D.init(${this.literal(mref.cls)}${this.fromArg})`, out, this.u);
        const args = this.R.natives.get(clsName)?.callerSensitive?.includes(mref.name + desc) ? argStr + (argStr ? ",R" : "R") : argStr;
        const target = `${own && !this.cold ? "C" : this.u}`;
        if (this.hostCall(clsName, mangled)) this.guard(`${target}${this.prop(mangled)}(${args})`, out, this.t, quiet);
        else this.call(`${target}${this.prop(xname(mangled))}(${args})`, out, quiet);
        break;
      }
      default: out.push(this.unsupported(`${kind} ${clsName}.${mref.name}${desc}`));
    }
  }

  /** A signature-polymorphic call takes its argument types from the call site's proto (H). A
   *  VarHandle access mode always receives two coordinates, padded, before its values. */
  private emitPolymorphic(i: Ins, cls: string, name: string, recv: string, out: string[]) {
    const params = this.dex.protoParamTypes(i.c);
    const args = this.args(i, params, 1);
    const values = cls === "java/lang/invoke/VarHandle" ? varHandleValues(name) : undefined;
    if (values !== undefined && params.length >= values && params.length - values <= 2) {
      const coords = args.slice(0, args.length - values);
      while (coords.length < 2) coords.push("0");
      out.push(`${this.t}=${recv}.$${name}(${[...coords, ...args.slice(args.length - values)].join(",")});`);
    } else if (cls === "java/lang/invoke/MethodHandle" && (name === "invoke" || name === "invokeExact")) {
      const proto = this.dex.proto(i.c);
      const site = "(" + params.join("") + ")" + this.dex.type(proto.ret);
      this.guard(`${recv}.$invoke(${this.literal(site)},${name === "invokeExact"}${args.map((a) => "," + a).join("")})`, out);
    } else out.push(this.unsupported(`invoke-polymorphic ${cls}.${name}`));
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
      case "shl-long": case "shr-long": case "ushr-long": {
        const k = this.cold ? undefined : this.known.get(two ? i.b : i.c), n = k === undefined ? `R.shifts[${y}&63]` : `${k & 63}n`;
        expr = base === "shr-long" ? `${x}>>${n}`
          : base === "ushr-long" ? `BigInt.asIntN(64,BigInt.asUintN(64,${x})>>${n})`
          : k === undefined ? `(${x}===1n?R.bits[${y}&63]:BigInt.asIntN(64,${x}<<${n}))` : `BigInt.asIntN(64,${x}<<${n})`;
        break;
      }
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
