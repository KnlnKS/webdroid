// Lazy-link stubs: what a slot holds until its code is compiled.
import { ModuleBuilder, T } from "../compiler/wasmbin.ts";
import { CALLEE, Code } from "../compiler/code.ts";
import { kindOf, methodKinds, type Kinds, type Kind } from "../compiler/program.ts";
import { declareBase, kindVT } from "../compiler/j2w.ts";
import { THROWERS } from "../compiler/exc.ts";
import type { DexFile } from "../../jvm/dex.ts";
import type { World } from "./world.ts";

/** a lazy-link stub's signature, its name where a class module imports it */
export const stubKey = (k: Kinds) => k.params.join("") + ":" + k.ret;
export const kindsType = (mb: ModuleBuilder, k: Kinds) => mb.addFuncType(k.params.map((p) => kindVT(p)), k.ret === "V" ? [] : [kindVT(k.ret)]);

export class Stubs {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  private importLink(mb: ModuleBuilder): number {
    return mb.importFunc("rt", "link", mb.addFuncType([T.i32], []));
  }
  /** Lazy-link stubs, one per signature for every slot of it: a call through the table names its slot in rt.callee (CALLEE), which the stub links and
   *  calls again. A module's cost to the engine is mostly fixed, so the module making the stubs a request lacks also makes those of every signature
   *  the dexes loaded since the last one declare. */
  private stubs = new Map<string, Function>();
  private stubbedDexes = new Set<DexFile>();
  stubsFor(kinds: Kinds[]): Function[] {
    const lacking = new Map<string, Kinds>(), want = (k: Kinds) => { const key = stubKey(k); if (!this.stubs.has(key)) lacking.set(key, k); };
    kinds.forEach(want);
    if (lacking.size) {
      for (const p of [this.w.prog.base, this.w.prog]) for (const [dex] of p?.loadedDexes() ?? []) {
        if (this.stubbedDexes.has(dex)) continue;
        this.stubbedDexes.add(dex);
        for (const s of dex.shorties()) {
          const params = [...s.slice(1)].map(kindOf), ret: Kind | "V" = s[0] === "V" ? "V" : kindOf(s[0]);
          want({ params, ret }); want({ params: ["L" as Kind, ...params], ret });
        }
      }
      const mb = new ModuleBuilder(); declareBase(mb);
      mb.importGlobal("rt", "callee", T.i32, true);
      mb.importTable("rt", "table", T.funcref, 0);
      const link = this.importLink(mb), made = [...lacking];
      made.forEach(([, k], i) => {
        const sig = kindsType(mb, k), c = new Code(k.params.length), slot = c.newLocal(T.i32);
        c.gget(CALLEE).ltee(slot).call(link);
        k.params.forEach((_, j) => c.lget(j));
        mb.export(String(i), "func", mb.addFunc(sig, c.lget(slot).callIndirect(sig).finish(), "stub"));
      });
      const x = this.w.instantiate(mb.build(), { rt: this.w.rtImports() }).exports;
      made.forEach(([k], i) => this.stubs.set(k, x[i] as Function));
    }
    return kinds.map((k) => this.stubs.get(stubKey(k))!);
  }
  /** the imports of a class module's shared stubs (classModule), named by signature */
  stubImports(mod: WebAssembly.Module): Record<string, Function> {
    const keys = WebAssembly.Module.imports(mod).filter((i) => i.module === "stub").map((i) => i.name);
    const fns = this.stubsFor(keys.map((key) => { const [params, ret] = key.split(":"); return { params: [...params] as Kind[], ret: ret as Kind | "V" }; }));
    return Object.fromEntries(keys.map((key, i) => [key, fns[i]]));
  }
  /** puts the lazy-link stub back in `slot`, unless it holds code nothing here can stand in for */
  restoreStub(slot: number, s = this.w.slots.at(slot)): boolean {
    const k = s?.k === "method" ? methodKinds(s.m) : s?.k === "synth" ? s.d : s?.k === "thrower" ? { params: THROWERS[s.name].params, ret: "V" as const } : undefined;
    if (k) this.w.table.set(slot, this.stubsFor([k])[0]);
    return !!k;
  }
}
