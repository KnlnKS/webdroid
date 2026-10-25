// Unit modules: what a unit imports, instantiating it, and recording what its code relies on. Every unit is described by its header (aot.ts UnitHeader): a unit made
// elsewhere (a build's module, a worker's) carries it, and one compiled here has it made from its Compiler, whose imports are made from what its compile linked.
import type { FunctionType } from "../compiler/wasmbin.ts";
import type { Compiler, FnTrace } from "../compiler/j2w.ts";
import { methodOf } from "../compiler/program.ts";
import type { HostContext } from "./hostapi.ts";
import type { Owner } from "./assumptions.ts";
import { VERSION, type UnitHeader } from "./aot.ts";
import { compiledHeader } from "./aotbuild.ts";
import type { Built, Clock, World } from "./world.ts";

/** a unit to install (Units.link): what its code needs and relies on, and its module */
export interface LinkedUnit {
  head: UnitHeader<Owner>;
  module: Uint8Array | WebAssembly.Module;
  /** the stack traces of its functions, where its module does not hold them (AotRuntime.trace) */
  traces?: readonly FnTrace[];
  /** a unit compiled here: its imports (Units.of) and the helpers it defines for first-tier units to share */
  local?: { imports: Record<string, any>; shared: readonly (readonly [string, FunctionType])[] };
  /** the modules a unit made elsewhere imports whole that are loaded already (a code module's data modules) */
  modules?: Record<string, WebAssembly.Exports>;
  /** the runtime functions whose code it holds, which its slots are not linked for */
  defines?: (synth: string) => boolean;
}

export class Units {
  private readonly w: World;
  /** the helpers first-tier units share (Compiler.shareHelpers): their signatures, and the functions the unit that defined them exports */
  readonly sharedHelpers = new Map<string, FunctionType>();
  private sharedFns: Record<string, Function> = {};
  private nativeFns = new Map<string, Function>();
  private hostCtx?: HostContext;
  constructor(w: World) { this.w = w; }

  clock(): Clock { return { start: performance.now(), accounted: this.w.stats.compileMs }; }
  /** charges the time since `clock` started, less what nested units charged meanwhile, to compiling */
  account(clock: Clock): void {
    const stats = this.w.stats;
    stats.compileMs += performance.now() - clock.start - (stats.compileMs - clock.accounted);
  }
  /** whether a module made elsewhere can run here: made by this version, with every native it imports bound, and, for a unit compiled against this World's Program
   *  (a worker's), with nothing added to the Program since `epoch` */
  admits(head: { version?: number; natives?: readonly string[] }, epoch?: number): boolean {
    return head.version === VERSION && (epoch === undefined || epoch === this.w.epoch) && (!head.natives || head.natives.every((id) => this.bound(id)));
  }
  /** installs unit `u`, which `admits` lets in where it was made elsewhere: links what its code names, makes its imports and its instance, has `place` put its
   *  functions where they are called, and records what its code relies on. Undefined, with nothing instantiated, while a class global it imports is not made yet
   *  (a class whose module is being built names it); `clock` charges the work to compiling */
  link<T>(u: LinkedUnit, place: (exports: WebAssembly.Exports) => T, clock?: Clock): T | undefined {
    const head = u.head, w = this.w;
    let imports = u.local?.imports;
    if (!imports) {
      this.linkHeader(head, u.defines);
      imports = Object.assign(this.imports(head.natives, head.symbols ?? []), u.modules);
      if (!this.classImports(head.classImports, imports)) return undefined;
    }
    // Imports can compile nested units; charge that work once, to its own unit.
    if (clock) this.account(clock);
    const exports = w.instantiate(u.module, imports).exports;
    if (u.local) for (const [key, sig] of u.local.shared) if (!this.sharedHelpers.has(key)) { this.sharedHelpers.set(key, sig); this.sharedFns[key] = exports[key] as Function; }
    const placed = place(exports);
    if (u.traces) for (const t of u.traces) if (t.m) w.stacks.traces.set(t.name, t);
    for (const cls of head.allocs) w.allocated.add(cls);
    w.assumptions.record(head);
    return placed;
  }
  /** unit `built`, compiled here by `cx` with `imports` (Units.of): `owner` owns what its code relies on that no method of it does */
  compiled(cx: Compiler, imports: Record<string, any>, built: Built, owner?: Owner): LinkedUnit {
    return { head: compiledHeader(this.w, cx, owner), module: built.bytes, traces: built.traces, local: { imports, shared: cx.sharedOut } };
  }
  /** links what the code of a module made elsewhere names, before it runs: the classes it touches (their modules), and its synthetic functions but those it `defines` */
  linkHeader(head: Pick<UnitHeader, "touch" | "synth">, defines?: (name: string) => boolean): void {
    const w = this.w;
    for (const id of head.touch) if (!w.aot?.touch(id)) w.link(w.nameOf(id));
    for (const s of head.synth) if (!defines?.(s)) w.synthSlot(s);
  }
  /** the imports of a unit compiled here */
  of(cx: Compiler): Record<string, any> {
    const imports = this.imports([...cx.nativeImports.keys()], [...cx.symbolicImports.values()].map((v) => v.site));
    imports.h = this.sharedFns;
    for (const [mod, rt] of cx.deps) imports[mod] = rt.exports;
    return imports;
  }
  private imports(natives: Iterable<string>, symbols: NonNullable<UnitHeader["symbols"]>): Record<string, any> {
    return { rt: this.w.rtImports(), host: this.w.host, n: this.natives(natives), symbolic: this.w.symbolic.symbolicImports(symbols) };
  }
  /** the class globals compiled code imports from modules the caller has not given: each comes from the module of the class whose id starts its name (code made
   *  by another World, an app build's or a worker's, names classes only by id); whether every one is made */
  private classImports(required: Iterable<readonly [string, string]>, imports: Record<string, Record<string, unknown>>): boolean {
    const w = this.w, given = new Set(Object.keys(imports));
    let made = true;
    for (const [module, name] of required) {
      if (given.has(module)) continue;
      let into = imports[module];
      // module c<id> names one class linked on demand: its holder's exports serve all of it
      if (module[0] === "c") into ??= imports[module] = w.link(w.nameOf(+module.slice(1))).exports;
      else (into ??= imports[module] = {})[name] = w.link(w.nameOf(+name.slice(0, name.indexOf(":")))).exports[name];
      if (into[name] === undefined) made = false;
    }
    return made;
  }
  /** whether native method `id` ("class.name+descriptor") has a host binding here, making its import available */
  private bound(id: string): boolean {
    if (id.startsWith("settle:") || id === "land" || id.startsWith("land:")) return true;
    const m = methodOf(this.w.prog, /#(?:s|p)$/.test(id) ? id.slice(0, -2) : id);
    return !!m && this.w.natives.prepare(m);
  }
  /** the natives `ids` as the "n" import module; one closure per native serves every module */
  private natives(ids: Iterable<string>): Record<string, Function> {
    const out: Record<string, Function> = {}, miss: string[] = [];
    for (const id of ids) { const f = this.nativeFns.get(id); if (f) out[id] = f; else miss.push(id); }
    if (miss.length) for (const [id, f] of Object.entries(this.w.natives.imports(this.hostContext(), miss))) this.nativeFns.set(id, out[id] = f);
    return out;
  }
  private hostContext(): HostContext {
    const w = this.w;
    return this.hostCtx ??= { mem: w.mem, sp: w.sp, bridge: w.bridge, gap: (what) => w.onGap(what), sched: w.sched, throwable: (cls, msg) => w.helpers.makeThrowable(cls, msg), raise: (e) => w.exception(e) };
  }
}
