// Call sites that link at run time (compiler/sites.ts): each calls through a slot of its own, which first holds a resolver and then the operation it resolved to.
import { symbolicOperationKey, type SymbolicSite } from "../compiler/sites.ts";
import { compileSymbolicSite } from "../compiler/symbolic.ts";
import { T } from "../compiler/wasmbin.ts";
import { Code } from "../compiler/code.ts";
import { methodAt, type MethodInfo } from "../compiler/program.ts";
import { Compiler } from "../compiler/j2w.ts";
import { initiatedInstruction, resolveInstruction } from "./resolution.ts";
import { decodeInstruction } from "../../jvm/prepared.ts";
import { emitRestored } from "../compiler/hostcalls.ts";
import type { World } from "./world.ts";

export class SymbolicSites {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  symbolicResolutions = 0;
  private symbolicOperations = new Map<string, Function>();
  private symbolicTable = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  symbolicSites = new Map<string, { slot: WebAssembly.Global; ready?: boolean }>();
  symbolicStubModules = 0;
  symbolicImports(sites: SymbolicSite[]): Record<string, unknown> {
    const out: Record<string, unknown> = { table: this.symbolicTable };
    const fresh = sites.filter(([name]) => !this.symbolicSites.has(name));
    if (fresh.length) {
      const clock = this.w.units.clock();
      const cx = new Compiler(this.w), table = cx.mb.importTable("symbolic", "table", T.funcref, 0);
      const sync = cx.mb.importFunc("symbolic", "sync", cx.sig([], "I"));
      const binding: Record<string, unknown> = { table: this.symbolicTable, sync: this.symbolicSync.bind(this) };
      const pending = fresh.map(([name, cls, index, pc, inputs, output]) => {
        const method = methodAt(this.w.prog.require(cls), index);
        if (!method) throw new Error(`Missing symbolic site method ${name}`);
        const slot = this.symbolicTable.grow(1);
        const plain = cx.mb.importFunc("symbolic", name, cx.sig([], "V")), wait = cx.mb.importFunc("symbolic", name + "#s", cx.sig([], "V"));
        const resolver = this.symbolicResolver(method, pc, slot, inputs, output), params = inputs.map(i => i[1]);
        binding[name] = resolver.plain; binding[name + "#s"] = resolver.wait;
        return { name, slot, params, output, plain, wait, method };
      });
      const built = cx.buildSyntheticGroup(pending.map(({ name, slot, params, output, plain, wait }) => ({
        name, params, ret: output, body: (c: Code) => {
          emitRestored(cx, c, [], [], () => { c.call(sync).if_().call(plain).else_().call(wait).end(); });
          params.forEach((_, i) => c.lget(i)); c.i32(slot).callIndirect(cx.sig(params, output), table);
        },
      })));
      const imports = this.w.units.of(cx); imports.symbolic = binding;
      this.w.stats.units++;
      this.w.units.instantiate(cx, imports, built, this.w.slotOf(pending[0].method), clock, (exports) => {
        for (const { name, slot } of pending) {
          this.symbolicSites.set(name, { slot: new WebAssembly.Global({ value: "i32" }, slot) });
          this.symbolicTable.set(slot, exports[name] as Function);
        }
      });
      this.symbolicStubModules++;
    }
    for (const [name] of sites) out[name] = this.symbolicSites.get(name)!.slot;
    return out;
  }
  symbolicSync(): number { return +(this.w.inSynchronousJava() || this.w.sched.current().root); }
  private symbolicResolver(method: MethodInfo, pc: number, slot: number, inputs: SymbolicSite[4], output: SymbolicSite[5]) {
    const run = () => {
      this.symbolicResolutions++;
      const owner = this.w.sched.current(), clock = this.w.units.clock(), ins = decodeInstruction(method.dex.code(method.codeOff).insns, pc);
      this.w.units.account(clock);
      const install = () => {
        const clock = this.w.units.clock();
        const initiated = initiatedInstruction(this.w, method, ins);
        let key = initiated ? symbolicOperationKey(method, ins, inputs, output) : undefined;
        let operation = key === undefined ? undefined : this.symbolicOperations.get(key);
        if (operation) {
          this.symbolicOperations.delete(key!);
          this.w.units.account(clock);
        }
        else {
          const { cx, built } = compileSymbolicSite(this.w, method, ins, inputs, output);
          this.w.stats.units++;
          operation = this.w.units.instantiate(cx, this.w.units.of(cx), built, this.w.slotOf(method), clock, (e) => e.m as Function);
          const mb = cx.mb;
          if (cx.assumptions.length || cx.absent.length || cx.gaps.length || cx.linkErrors.length || cx.nativeImports.size
            || built.traces.some(t => t.m) || mb.globals.length || mb.tables.length || mb.tags.length || mb.elems.length || mb.datas.length) {
            key = undefined;
          }
        }
        if (key !== undefined) {
          // an older initialization guard remains valid: class initialization never reverses, and calls still use the live method table
          this.symbolicOperations.set(key, operation);
          if (this.symbolicOperations.size > 2048) this.symbolicOperations.delete(this.symbolicOperations.keys().next().value!);
        }
        this.symbolicTable.set(slot, operation);
        if (initiated) {
          const binding = this.symbolicSites.get(`${method.cls}:${method.index}:${pc}`);
          if (binding) binding.ready = true;
          this.w.tiers.hotUnits.resolved(`${method.cls}:${method.index}:${pc}`);
        }
      };
      const ready = resolveInstruction(this.w, method, ins, owner);
      return ready instanceof Promise ? ready.then(install) : install();
    };
    return { plain: () => this.w.synchronous(run), wait: this.w.sched.suspending(run) };
  }
}
