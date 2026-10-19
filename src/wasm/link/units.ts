// Unit modules: what a unit imports, instantiating it, and recording what its code relies on. A unit made elsewhere (a build's module, a worker's) says what it needs in
// its header (aot.ts UnitHeader); one compiled here, in its Compiler.
import type { FunctionType } from "../compiler/wasmbin.ts";
import { Compiler } from "../compiler/j2w.ts";
import { methodOf } from "../compiler/ids.ts";
import type { HostContext } from "./hostapi.ts";
import { VERSION, type UnitHeader } from "./aot.ts";
import type { Built, Clock, World } from "./world.ts";

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
  /** instantiates a built unit, has `place` put its functions where they are called, then records what their code relies on */
  instantiate<T>(cx: Pick<Compiler, "assumptions" | "absent">, imports: Record<string, any>, built: Built, slot: number | undefined, clock: Clock, place: (exports: Record<string, any>) => T): T {
    // Imports can compile nested units; charge that work once, to its own unit.
    this.account(clock);
    const exports = this.w.instantiate(built.bytes, imports).exports;
    if (cx instanceof Compiler) for (const [key, sig] of cx.sharedOut) if (!this.sharedHelpers.has(key)) { this.sharedHelpers.set(key, sig); this.sharedFns[key] = exports[key] as Function; }
    const placed = place(exports);
    for (const t of built.traces) if (t.m) this.w.stacks.traces.set(t.name, t);
    this.w.assumptions.record(cx, slot);
    return placed;
  }

  /** whether a unit made elsewhere can run here: made by this version, with every native it imports bound */
  admits(head: Pick<UnitHeader, "version" | "natives">): boolean { return head.version === VERSION && head.natives.every((id) => this.bound(id)); }
  /** the imports of a unit compiled here */
  of(cx: Compiler): Record<string, any> {
    const imports = this.imports([...cx.nativeImports.keys()], [...cx.symbolicImports.values()].map((v) => v.site));
    imports.h = this.sharedFns;
    for (const [mod, rt] of cx.deps) imports[mod] = rt.exports;
    return imports;
  }
  /** the imports of a unit made elsewhere, but for the class globals (`classImports`) */
  ofHeader(head: Pick<UnitHeader, "natives" | "symbols">): Record<string, any> { return this.imports(head.natives, head.symbols ?? []); }
  private imports(natives: Iterable<string>, symbols: NonNullable<UnitHeader["symbols"]>): Record<string, any> {
    return { rt: this.w.rtImports(), host: this.w.host, n: this.natives(natives), symbolic: this.w.symbolic.symbolicImports(symbols) };
  }
  /** the class globals compiled code imports from modules the caller has not named: each comes from the module of the class whose id starts its name (code made by another World,
   *  an app build's or a worker's, names classes only by id) */
  classImports(required: Iterable<readonly [string, string]>, imports: Record<string, Record<string, unknown>>): void {
    const w = this.w, given = new Set(Object.keys(imports));
    for (const [module, name] of required) {
      if (given.has(module)) continue;
      // module c<id> names one class linked on demand: its holder's exports serve all of it
      if (module[0] === "c") { imports[module] = w.link(w.nameOf(+module.slice(1))).exports; given.add(module); continue; }
      (imports[module] ??= {})[name] = w.link(w.nameOf(+name.slice(0, name.indexOf(":")))).exports[name];
    }
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
    return this.hostCtx ??= { mem: w.mem, sp: w.sp, bridge: w.bridge, gap: (what) => w.onGap(what), sched: w.sched, throwable: (cls, msg) => w.makeThrowable(cls, msg), raise: (e) => w.exception(e) };
  }
}
