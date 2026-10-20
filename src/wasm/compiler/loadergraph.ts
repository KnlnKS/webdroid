// The loaders' namespaces of a Program (program.ts): which class each loader sees under a name, and how the dexes they define see the classes they name.
import { descToName } from "../../jvm/abi.ts";
import type { ClassAnnotations, ClassDef, DexFile, DexTypes } from "../../jvm/dex.ts";
import type { JClass } from "./program.ts";

export type LoaderId = number | "boot";
export type LoaderParent = LoaderId | null;
export interface LoaderSnapshot {
  parents: LoaderParent[];
  libraries: [LoaderId, LoaderId[], LoaderId[]][];
  initiated: [LoaderId, string, string][];
  ownFirst?: number[];
  dynamicRoot?: true;
}
/** A defining namespace. The root holds app classes, the boot view exposes its platform base, and other loaders own distinct `name@id` keys. Visibility follows parent, before libraries, own definitions, then after libraries. */
export interface Loader {
  readonly id: number;
  readonly parent: Loader | null;
  /** the java.lang.ClassLoader this namespace belongs to, once the host has one */
  object: object | null;
  /** class name -> key of the classes this loader defines */
  readonly defined: Map<string, string>;
  before?: Loader[];
  after?: Loader[];
  /** its own classes come before its parent's, after the boot classes, as a dalvik.system.DelegateLastClassLoader resolves (loaders.ts) */
  ownFirst?: boolean;
}
const SUFFIX = /@(\d+);?$/;
/** the id of the loader that defines the class (or the element class of the array class) with this key */
const loaderIdOf = (key: string): number => +(SUFFIX.exec(key)?.[1] ?? 0);

/** the descriptors of the `changed` names, or undefined when an array or key name leaves every reference suspect */
export const changedTypes = (changed: ReadonlySet<string>): Set<string> | undefined =>
  [...changed].some(name => name.startsWith("[") || name.includes("@")) ? undefined : new Set([...changed].map(name => `L${name};`));

/** a dex's descriptors as the loader that defines its classes sees them: each class they name by the key of the class the loader finds under that name */
export class LoaderTypes implements DexTypes {
  readonly dex: DexFile;
  readonly resolve: (desc: string) => string;
  private types: (string | undefined)[] = [];
  private names: (string | undefined)[] = [];
  private params: (string[] | undefined)[] = [];
  private protos: ({ params: string[]; ret: string } | undefined)[] = [];
  private descs: (string | undefined)[] = [];
  private annotations = new Map<number, ClassAnnotations>();
  constructor(dex: DexFile, resolve: (desc: string) => string) { this.dex = dex; this.resolve = resolve; }
  type(i: number): string { return this.types[i] ??= this.resolve(this.dex.rawType(i)); }
  typeName(i: number): string { return this.names[i] ??= descToName(this.type(i)); }
  protoParamTypes(pi: number): string[] { return this.params[pi] ??= this.dex.proto(pi).params.map((t) => this.type(t)); }
  protoTypes(pi: number): { params: string[]; ret: string } { return this.protos[pi] ??= { params: this.protoParamTypes(pi), ret: this.type(this.dex.proto(pi).ret) }; }
  protoDesc(pi: number): string { return this.descs[pi] ??= "(" + this.protoParamTypes(pi).join("") + ")" + this.type(this.dex.proto(pi).ret); }
  methodDesc(i: number): string { return this.protoDesc(this.dex.method(i).proto); }
  methodTypes(i: number): { params: string[]; ret: string } { return this.protoTypes(this.dex.method(i).proto); }
  methodKey(i: number): string { return this.dex.method(i).name + this.methodDesc(i); }
  classAnnotations(def: ClassDef): ClassAnnotations { return this.dex.classAnnotations(def, this, this.annotations); }
}

/** A Program's loaders and the namespaces they define, under the root's (the app's) and the boot loader's */
export abstract class LoaderGraph {
  abstract readonly base?: LoaderGraph;
  /** the classes this Program adds to its base's, by key */
  protected readonly classes = new Map<string, JClass>();
  protected readonly syntheticLoaders = new Map<string, Loader>();
  private initiated = new WeakMap<Loader, Map<string, string>>();
  readonly root: Loader = { id: 0, parent: null, object: null, defined: new Map() };
  readonly boot: Loader = { id: 0, parent: null, object: null, defined: new Map() };
  private loaders: Loader[] = [this.root];
  private dexLoader = new Map<DexFile, Loader>();
  /** how the dexes of loaders other than the root, and those whose loader's libraries or initiated classes changed, see the types they name */
  private views = new Map<DexFile, LoaderTypes>();
  protected bootPath = false;
  /** The default namespace resolves as `lookup` does, ART's native path for a PathClassLoader over the boot loader, until its loader is found to be another kind. */
  dynamicRoot = false;
  abstract has(name: string): boolean;
  protected abstract forget(): void;
  /** the classes of `dexes` read their types again, now that their loaders resolve the class descriptors `types` differently (any if undefined); answers their keys */
  protected abstract retyped(dexes: ReadonlyMap<DexFile, Loader>, types: ReadonlySet<string> | undefined): string[];
  /** `dex`'s classes are `loader`'s: answers how it sees the types they name */
  protected assign(dex: DexFile, loader: Loader): DexTypes {
    const owner = this.loaderOfDex(dex);
    if (owner && owner !== loader) throw new Error(`${dex.name} belongs to another loader`);
    this.dexLoader.set(dex, loader);
    if (loader !== this.root && !this.views.has(dex)) this.views.set(dex, new LoaderTypes(dex, (d) => this.rewrite(loader, d)));
    return this.typesOf(dex);
  }
  /** the types `dex` names as the loader of its classes sees them */
  typesOf(dex: DexFile): DexTypes { return this.views.get(dex) ?? this.base?.typesOf(dex) ?? dex; }
  /** the loader whose namespace holds `dex`'s classes */
  loaderOfDex(dex: DexFile): Loader | undefined { return this.dexLoader.get(dex) ?? this.base?.loaderOfDex(dex); }
  /** a namespace of its own under `parent`, which it consults first */
  newLoader(parent: Loader, object: object | null, ownFirst = false): Loader {
    const loader: Loader = { id: this.loaders.length, parent, object, defined: new Map(), ...ownFirst && { ownFirst } };
    this.loaders.push(loader);
    return loader;
  }
  loadedDexes(): IterableIterator<[DexFile, Loader]> { return this.dexLoader.entries(); }
  /** whether a reference from code this loader defines resolves at compile time to what it resolves to when it runs */
  linksStatically(loader: Loader): boolean { return loader === this.boot || loader === this.root && !this.dynamicRoot; }
  loaderId(loader: Loader): LoaderId { return loader === this.boot ? "boot" : loader.id; }
  loaderAt(id: LoaderId): Loader { const loader = id === "boot" ? this.boot : this.loaders[id]; if (!loader) throw new Error(`unknown loader ${id}`); return loader; }
  /** Compiler mirrors carry namespace identity, never the source's Java loader objects. */
  loaderSnapshot(): LoaderSnapshot {
    const id = (l: Loader) => this.loaderId(l);
    return { parents: this.loaders.map(l => l.parent ? id(l.parent) : null),
      libraries: [this.boot, ...this.loaders].map(l => [id(l), (l.before ?? []).map(id), (l.after ?? []).map(id)]),
      initiated: [this.boot, ...this.loaders].flatMap(l => [...this.initiated.get(l) ?? []].map(([name, key]): [LoaderId, string, string] => [id(l), name, key])),
      ownFirst: this.loaders.filter(l => l.ownFirst).map(l => l.id),
      ...this.dynamicRoot && { dynamicRoot: true } };
  }
  followLoaderParents(parents: LoaderParent[], ownFirst: readonly number[] = []): void {
    if (parents.length < this.loaders.length || parents[0] !== null) throw new Error("incompatible compiler loader graph");
    for (let i = 1; i < parents.length; i++) {
      const ref = parents[i];
      if (ref !== "boot" && (typeof ref !== "number" || !Number.isInteger(ref) || ref < 0 || ref >= i)) throw new Error(`invalid parent of loader ${i}`);
      const parent = ref === "boot" ? this.boot : this.loaderAt(ref), prior = this.loaders[i];
      if (prior && prior.parent !== parent) throw new Error(`changed parent of loader ${i}`);
      if (!prior) this.newLoader(parent, null, ownFirst.includes(i));
    }
  }
  /** the loader that defines the class with this key */
  loaderOf(key: string): Loader {
    const array = key[0] === "[" || key[0] === "#";
    if (array && /^(?:\[+[ZBCSIJFD]|#[ZBCSIJFDV])$/.test(key)) return this.boot;
    const component = array ? key.replace(/^\[+L(.*);$/, "$1") : key;
    for (let p: LoaderGraph | undefined = this; p; p = p.base) {
      const loader = p.syntheticLoaders.get(component);
      if (loader) return loader === p.boot ? this.boot : loader;
      const cls = p.classes.get(component);
      if (cls) {
        const owner = cls.dex ? p.dexLoader.get(cls.dex) : undefined;
        // The immutable base's root DEX is this realm's bootstrap class path.
        // Its numbered custom namespaces retain their explicit owners.
        return owner === p.root && p !== this ? this.boot : owner ?? p.loaders[loaderIdOf(key)];
      }
    }
    return this.loaders[loaderIdOf(key)];
  }
  /** An initiated identity wins; otherwise search the loader's parent-first namespace. */
  lookup(loader: Loader, name: string, seen = new Set<Loader>()): string | undefined {
    if (seen.has(loader)) return undefined;
    seen.add(loader);
    const loaded = this.initiatedBy(loader, name);
    if (loaded) return loaded;
    if (loader === this.boot) return this.definedBy(loader, name);
    // as DelegateLastClassLoader.loadClass: the boot loader, then findClass, then the parent
    const first = loader.ownFirst ? this.base ? this.lookup(this.boot, name, seen) : this.boot.defined.get(name)
      : loader.parent ? this.lookup(loader.parent, name, seen) : this.base ? this.lookup(this.boot, name, seen) : this.boot.defined.get(name);
    if (first) return first;
    for (const library of loader.before ?? []) { const key = this.lookup(library, name, seen); if (key) return key; }
    const own = this.definedBy(loader, name);
    if (own) return own;
    for (const library of loader.after ?? []) { const key = this.lookup(library, name, seen); if (key) return key; }
    return loader.ownFirst && loader.parent ? this.lookup(loader.parent, name, seen) : undefined;
  }
  /** whether `loader` searches these libraries already */
  hasLibraries(loader: Loader, before: Loader[], after: Loader[]): boolean {
    const same = (a: Loader[] | undefined, b: Loader[]) => (a?.length ?? 0) === b.length && b.every((l, i) => l === a![i]);
    return same(loader.before, before) && same(loader.after, after);
  }
  libraries(loader: Loader, before: Loader[], after: Loader[], changed: ReadonlySet<string> = this.libraryChanges(loader, before, after)): string[] {
    if (this.hasLibraries(loader, before, after)) return [];
    loader.before = before; loader.after = after;
    return changed.size ? this.refreshResolution(loader, changed) : [];
  }
  /** the names that a loader seeing `loader` resolves differently once `loader` searches these libraries: only names the old or new libraries can supply */
  libraryChanges(loader: Loader, before: Loader[], after: Loader[]): Set<string> {
    const names = new Set<string>(), seen = new Set<Loader>();
    const supply = (l: Loader | null) => {
      if (!l || l === this.boot || seen.has(l)) return;
      seen.add(l);
      for (const name of l === this.root ? this.classes.keys() : l.defined.keys()) names.add(name);
      for (const name of this.initiated.get(l)?.keys() ?? []) names.add(name);
      supply(l.parent);
      for (const library of [...l.before ?? [], ...l.after ?? []]) supply(library);
    };
    for (const library of [...loader.before ?? [], ...loader.after ?? [], ...before, ...after]) supply(library);
    const views = [...this.dependentLoaders(loader)], prior = [loader.before, loader.after];
    const resolve = () => views.flatMap(view => [...names].map(name => this.lookup(view, name)));
    const old = resolve();
    loader.before = before; loader.after = after;
    const now = resolve();
    [loader.before, loader.after] = prior;
    const changed = new Set<string>();
    let i = 0;
    for (let v = 0; v < views.length; v++) for (const name of names) if (old[i] !== now[i++]) changed.add(name);
    return changed;
  }
  initiatedBy(loader: Loader, name: string): string | undefined { return this.initiated.get(loader)?.get(name); }
  /** A successful native definition fixes the initiating loader's identity before its bytecode is resolved. */
  initiate(loader: Loader, name: string, key: string): string[] {
    const visible = this.lookup(loader, name);
    let loaded = this.initiated.get(loader);
    if (!loaded) this.initiated.set(loader, loaded = new Map());
    loaded.set(name, key);
    return visible === key ? [] : this.refreshResolution(loader, new Set([name]));
  }
  forgetInitiated(loader: Loader, name: string): string[] {
    this.initiated.get(loader)?.delete(name);
    return this.refreshResolution(loader, new Set([name]));
  }
  private dependentLoaders(loader: Loader): Set<Loader> {
    const depends = (view: Loader, seen = new Set<Loader>()): boolean => {
      if (view === loader) return true;
      if (view === this.boot || seen.has(view)) return false;
      seen.add(view);
      return [view.parent, ...view.before ?? [], ...view.after ?? []].some(l => !!l && depends(l, seen));
    };
    return new Set(this.loaders.filter(l => depends(l)));
  }
  /** the dex files whose references can resolve differently when `changed` names do: those of loaders that see `loader` naming one of them, as an element type or not */
  private resolutionDexes(loader: Loader, changed: ReadonlySet<string>): Map<DexFile, Loader> {
    const affected = this.dependentLoaders(loader), dexes = new Map<DexFile, Loader>(), types = changedTypes(changed);
    for (const [dex, owner] of this.dexLoader) if (affected.has(owner) && (!types || dex.typesNaming(types).size)) dexes.set(dex, owner);
    return dexes;
  }
  resolutionClasses(loader: Loader, changed: ReadonlySet<string>): Set<string> {
    const dexes = this.resolutionDexes(loader, changed);
    return new Set(dexes.size ? [...this.classes.values()].filter(c => c.defIdx >= 0 && dexes.has(c.dex!)).map(c => c.name) : []);
  }
  private refreshResolution(loader: Loader, changed: ReadonlySet<string>): string[] {
    const dexes = this.resolutionDexes(loader, changed);
    for (const [dex, owner] of dexes) this.views.set(dex, new LoaderTypes(dex, d => this.rewrite(owner, d)));
    const names = this.retyped(dexes, changedTypes(changed));
    this.forget();
    return names;
  }
  /** a type or method descriptor in binary names (JNI's) as the loader of class `cls` sees it: each class it names by the key that loader sees under that name */
  viewOf(cls: string, desc: string): string {
    const loader = this.loaderOf(cls);
    return desc.replace(/L([^;]+);/g, (whole, name: string) => { const key = this.lookup(loader, name); return key === undefined ? whole : `L${key};`; });
  }
  /** a descriptor of a dex file of `loader`, with the class names it names replaced by the keys of the classes the loader sees under them */
  private rewrite(loader: Loader, desc: string): string {
    const m = /^(\[*)L(.+);$/.exec(desc);
    if (!m) return desc;
    const key = this.lookup(loader, m[2]);
    return key === undefined || key === m[2] ? desc : `${m[1]}L${key};`;
  }
  /** the key of the class `name` that `loader` itself defines (not its ancestors) */
  definedBy(loader: Loader, name: string): string | undefined {
    if (loader === this.boot) return this.boot.defined.get(name) ?? (this.base ? this.base.lookup(this.base.boot, name) : this.inBoot(name) ? name : undefined);
    return loader === this.root ? this.classes.has(name) ? name : undefined : loader.defined.get(name);
  }
  /** Synthetic classes have an explicit defining loader; lacking a dex does not imply bootstrap ownership. */
  private inBoot(name: string): boolean {
    const loader = this.syntheticLoaders.get(name);
    return loader ? loader === this.boot : this.base ? this.base.inBoot(name) : !this.bootPath && this.has(name);
  }
}
