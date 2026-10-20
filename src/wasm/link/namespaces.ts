// Namespaces that change after code linked against them: a class loader binding its libraries, one initiating a class, the app's loader resolving through Java.
// Code linked under the old resolution is undone; a change that would alter the dispatch or hierarchy of linked classes is refused with a LinkageError.
import { javaName, type Loader } from "../compiler/program.ts";
import { changedTypes } from "../compiler/loadergraph.ts";
import { failed, symbolicDispatchFor } from "../compiler/linkage.ts";
import type { World } from "./world.ts";

export class Namespaces {
  private readonly w: World;
  constructor(w: World) { this.w = w; }

  /** A BaseDexClassLoader supplies its immutable library graph before opening its own DEX path. Metadata and ahead-of-time code may already exist. */
  bindLibraries(loader: Loader, before: Loader[], after: Loader[]): void {
    const prog = this.w.prog, priorBefore = loader.before ?? [], priorAfter = loader.after ?? [];
    if (prog.hasLibraries(loader, before, after)) return;
    const changed = prog.libraryChanges(loader, before, after);
    // An app build attached before Java bound the libraries it was compiled under stays valid once they are.
    this.rebind(loader, changed, () => prog.libraries(loader, before, after, changed), () => prog.libraries(loader, priorBefore, priorAfter, changed), "Class loader libraries",
      () => loader === prog.root && !!this.w.aot?.boundAsBuilt());
  }
  /** The app's loader resolves through Java (loaders.ts standardPath): code of the default namespace linked as the Program resolves is undone, and its references resolve as they run. */
  dynamicRoot(): void {
    const w = this.w, prog = w.prog, slots = w.slots;
    if (prog.dynamicRoot) return;
    prog.dynamicRoot = true;
    w.aot?.unbindApp();
    for (let b = 0; b < slots.blockClass.length; b++) {
      const dex = prog.get(slots.blockClass[b])?.dex;
      if (dex && prog.loaderOfDex(dex) === prog.root) for (let i = 0; i < slots.methodsIn(b); i++) w.assumptions.undoCode(slots.blockBase[b] + i);
    }
    w.epoch++;
    w.opts.compiler?.namespaces();
  }
  initiateClass(loader: Loader, name: string, key: string): void {
    const w = this.w, prog = w.prog, prior = prog.initiatedBy(loader, name);
    if (prior === key) return;
    if (prior) throw w.exception(w.makeThrowable("java/lang/LinkageError", `Class loader already initiated ${name}`));
    if (prog.lookup(loader, name) === key) { prog.initiate(loader, name, key); return; }
    this.rebind(loader, new Set([name]), () => prog.initiate(loader, name, key), () => prog.forgetInitiated(loader, name), "Class initiation");
  }
  /** applies `change`, which resolves the `changed` names differently, unless that would change linked dispatch or hierarchy */
  private rebind(loader: Loader, changed: ReadonlySet<string>, change: () => string[], undo: () => string[], reason: string, keepApp = () => false): void {
    const w = this.w, prog = w.prog, slots = w.slots;
    // Inherited dispatch also depends on interfaces that have not themselves been linked.
    const changing = changed.size ? prog.resolutionClasses(loader, changed) : undefined;
    // With no class resolving through the loader yet (one binding its libraries before it opens its dexes), the graph still changes what later definitions
    // resolve to, in the compile worker too.
    if (!changing?.size) { change(); w.opts.compiler?.namespaces(); return; }
    const resolved = w.assumptions.resolved();
    const dependentOn = (changed: Set<string>) => {
      const affected = new Map<string, boolean>();
      const depends = (name: string): boolean => {
        if (changed.has(name)) return true;
        const hit = affected.get(name); if (hit !== undefined) return hit;
        affected.set(name, true);
        const c = prog.get(name), result = !!c && c.supertypes().some(depends);
        affected.set(name, result); return result;
      };
      return depends;
    };
    const types = changedTypes(changed), exact = !!types;
    const mentions = (descriptor: string) => !exact || [...javaName(descriptor).matchAll(/L([^;]+);/g)].some(m => changed.has(m[1]));
    const depends = dependentOn(changing);
    // Changed identities affect dispatch through matching signatures or inherited types, including unlinked interfaces.
    const hierarchy = exact ? dependentOn(new Set([...changing].filter(name => {
      const c = prog.get(name)!;
      return c.supertypes().some(parent => changed.has(javaName(parent)));
    }))) : depends;
    // A class's slots come from the methods its superclass chain declares; testing their keys spares building its slots and members.
    const chainMentions = new Map<string, boolean>();
    const mentioned = (name: string): boolean => {
      let hit = chainMentions.get(name); if (hit !== undefined) return hit;
      const c = prog.get(name);
      hit = !!c && (!!c.sup && mentioned(c.sup) || !c.isInterface && c.declaresNaming(types));
      chainMentions.set(name, hit); return hit;
    };
    const dispatchOf = (name: string) => w.dispatch.vslots(name).map(key => symbolicDispatchFor(prog, name, key));
    const dispatch = [...w.classes.keys()].filter(name => depends(name) && (hierarchy(name) || mentioned(name))).map(name => ({ name, methods: dispatchOf(name) }));
    // Only the classes of the dexes that resolve through the changed loader have their types rewritten.
    const existing = [...w.classes].filter(([name]) => changing.has(name)).map(([name, rt]) => {
      const c = prog.get(name)!, statics = !types || c.declaresStaticOf(types) ? c.fields.filter(f => f.isStatic) : [];
      return { name, rt, sup: c.sup, ifaces: [...c.ifaces], statics: statics.map(field => ({ field, desc: field.desc })) };
    });
    const names = change();
    if (!names.length) return;
    w.dispatch.forget();
    const refuse = (what: string, name: string) => {
      undo(); w.dispatch.forget();
      return w.exception(w.makeThrowable("java/lang/LinkageError", `${reason} changed linked ${what} of ${name}`));
    };
    // A kept app build was made under the new graph: the classes laid out by its data modules already have the new hierarchy and dispatch.
    const kept = keepApp(), builtUnderNew = (name: string) => kept && w.classes.get(name)?.from === "app";
    for (const old of dispatch) {
      if (builtUnderNew(old.name)) continue;
      const methods = dispatchOf(old.name);
      if (methods.length !== old.methods.length || methods.some((m, i) => {
        const prior = old.methods[i];
        return m !== prior && !(m && prior && failed(m) && failed(prior) && m.candidates.length === prior.candidates.length && m.candidates.every((candidate, index) => candidate === prior.candidates[index]));
      })) throw refuse("dispatch", old.name);
    }
    // A changed superclass would change the physical GC layout of already linked instances. Constructor-time library binding must precede that resolution.
    for (const old of existing) {
      const cls = prog.get(old.name)!;
      if (!builtUnderNew(old.name) && (cls.sup !== old.sup || cls.ifaces.join("\0") !== old.ifaces.join("\0"))) throw refuse("hierarchy", old.name);
    }
    // A class's globals keep the names its module gave them: an app build made under the new graph has them already.
    for (const old of existing) {
      for (const { field, desc } of old.statics) if (desc !== field.desc) {
        const oldKey = `${old.rt.id}:s:${field.name}:${desc}`, newKey = `${old.rt.id}:s:${field.name}:${field.desc}`;
        if (oldKey in old.rt.exports && !(newKey in old.rt.exports)) old.rt.exports = { ...old.rt.exports, [newKey]: old.rt.exports[oldKey] };
      }
    }
    w.epoch++;
    w.opts.compiler?.namespaces();
    w.cha.reindex(); w.planner.forgetImplementations();
    w.helpers.forgetFieldReaders();
    w.dispatch.forget();
    // Existing code and app builds used the previous namespace, except a kept build, which was made under this one. Platform code retains its defining boot namespace.
    const refreshed = new Set(names);
    // a slot without state has never been compiled here
    const builtUnder = (slot: number) => { const s = slots.peek(slot); return (!s || s.k === "method" && !s.hot && !w.demand.methods.has(s.m)) && !!w.aot?.fromAppBuild(slot); };
    for (let b = 0; b < slots.blockClass.length; b++) if (refreshed.has(slots.blockClass[b])) {
      for (let i = 0; i < slots.methodsIn(b); i++) if (!kept || !builtUnder(slots.blockBase[b] + i)) w.assumptions.undoCode(slots.blockBase[b] + i);
    }
    if (names.some(name => prog.loaderOfDex(prog.get(name)!.dex!) === prog.root) && !kept) w.aot?.unbindApp();
    w.assumptions.rebound(resolved, (desc) => mentions(desc) ? depends : hierarchy);
  }
}
