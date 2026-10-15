import type { LinkFailure } from "./linkage";
import { ACC, type DexFile, type ClassDef } from "../../jvm/dex";
import { parseMethodDesc } from "../../jvm/abi";

export { ACC };
export type Kind = "I" | "J" | "L";               // wasm-level kinds: i32 (int,float bits,small ints), i64 (long,double bits), ref
export const kindOf = (desc: string): Kind => desc[0] === "J" || desc[0] === "D" ? "J" : desc[0] === "L" || desc[0] === "[" ? "L" : "I";
export type Kinds = { params: Kind[]; ret: Kind | "V" };
/** the kinds of the parameters (the receiver first) and result of `m` */
export const methodKinds = (m: MethodInfo): Kinds =>
  ({ params: (m.isStatic ? [] : ["L" as Kind]).concat(m.params.map(kindOf)), ret: m.ret === "V" ? "V" : kindOf(m.ret) });

export interface FieldInfo { owner: string; name: string; desc: string; kind: Kind; isStatic: boolean; flags: number }
export interface MethodInfo {
  cls: string; name: string; desc: string; flags: number; dex: DexFile; methodIdx: number; codeOff: number;
  key: string; isStatic: boolean; isCtor: boolean; params: string[]; ret: string;
  /** position in its class's `methods`, which is also the offset of its table slot from the class's block */
  index: number;
}
export interface DefaultConflict extends LinkFailure {
  thrower: "icce";
  candidates: readonly MethodInfo[];
}
export type DispatchTarget = MethodInfo | DefaultConflict | undefined;

/** Conflict is an invocation error, not an abstract or missing declaration. */
export function selectDefault(maximal: readonly MethodInfo[], includeAbstract = false): DispatchTarget {
  const defaults = maximal.filter(m => !(m.flags & ACC.ABSTRACT));
  if (defaults.length > 1) return { thrower: "icce", message: "Conflicting default methods: " + defaults.map(m => javaName(m.cls) + "." + javaName(m.key)).join(", "), candidates: defaults };
  return defaults[0] ?? (includeAbstract ? maximal[0] : undefined);
}

export interface JClass {
  name: string; dex: DexFile | null; def: ClassDef | null; sup: string | null; ifaces: string[]; flags: number;
  isInterface: boolean; fields: FieldInfo[]; methods: MethodInfo[]; byKey: Map<string, MethodInfo>;
}
export const mkey = (name: string, desc: string) => name + desc;

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
/** the name Java code sees for a class key (and for the key of an array class) */
export const javaName = (key: string): string => (key.includes("@") ? key.replace(/@\d+(?=;|$)/g, "") : key);
/** Runtime packages include the defining loader, not just the binary package name. */
export function sameRuntimePackage(prog: Program, a: string, b: string): boolean {
  const pkg = (name: string) => { name = javaName(name); return name.slice(0, name.lastIndexOf("/") + 1); };
  return pkg(a) === pkg(b) && prog.loaderOf(a) === prog.loaderOf(b);
}
/** the id of the loader that defines the class (or the element class of the array class) with this key */
const loaderIdOf = (key: string): number => +(SUFFIX.exec(key)?.[1] ?? 0);

/** the descriptors of the `changed` names, or undefined when an array or key name leaves every reference suspect */
const changedTypes = (changed: ReadonlySet<string>): Set<string> | undefined =>
  [...changed].some(name => name.startsWith("[") || name.includes("@")) ? undefined : new Set([...changed].map(name => `L${name};`));

/** a class of a dex file. Its header (supertypes, flags) is read when asked for and its members are built when the first of them is, so a Program holds
 *  little for the thousands of platform classes a process never uses. */
class DexClass implements JClass {
  private header_?: { flags: number; sup: string | null; ifaces: string[] };
  private def_?: ClassDef;
  private members_?: { methods: MethodInfo[]; byKey: Map<string, MethodInfo> };
  private fields_?: FieldInfo[];
  private methodInfos?: Map<number, MethodInfo>;
  constructor(readonly name: string, readonly dex: DexFile, readonly idx: number) {}
  refreshTypes(resolve: (desc: string) => string, changedTypes?: ReadonlySet<string>): void {
    if (!changedTypes) this.header_ = undefined;
    else if (this.header_) {
      const h = this.dex.classHeader(this.idx);
      if (h.superIdx !== 0xffffffff && changedTypes.has(this.dex.rawType(h.superIdx)) || h.interfaces.some(i => changedTypes.has(this.dex.rawType(i)))) this.header_ = undefined;
    }
    const aliases = this.members_ ? [...this.members_.byKey].filter(([key, m]) => key !== m.key) : [];
    for (const m of this.members_?.methods ?? this.methodInfos?.values() ?? []) {
      if (m.dex !== this.dex || m.methodIdx < 0) continue;
      const desc = this.dex.methodDesc(m.methodIdx);
      if (desc === m.desc) continue;
      const old = m.key, parsed = parseMethodDesc(desc);
      m.desc = desc; m.params = parsed.params; m.ret = parsed.ret; m.key = mkey(m.name, desc);
      this.members_?.byKey.delete(old); this.members_?.byKey.set(m.key, m);
    }
    for (const [key, method] of aliases) {
      const at = key.indexOf("("), resolved = key.slice(0, at) + key.slice(at).replace(/L[^;]+;/g, descriptor => resolve(javaName(descriptor)));
      if (key !== resolved) this.members_!.byKey.delete(key);
      this.members_!.byKey.set(resolved, method);
    }
    if (this.fields_) {
      let i = 0;
      for (const list of [this.def.staticFields, this.def.instanceFields]) for (const f of list) {
        if (this.name === "java/lang/Object" && list === this.def.instanceFields) continue;
        this.fields_[i++].desc = this.dex.type(this.dex.field(f.fieldIdx).type);
      }
    }
  }
  private get header() {
    if (!this.header_) {
      const h = this.dex.classHeader(this.idx), dex = this.dex;
      this.header_ = { flags: h.flags, sup: h.superIdx === 0xffffffff ? null : dex.typeName(h.superIdx), ifaces: h.interfaces.map((t) => dex.typeName(t)) };
    }
    return this.header_;
  }
  get flags() { return this.header.flags; }
  get sup() { return this.header.sup; }
  get ifaces() { return this.header.ifaces; }
  get isInterface() { return (this.header.flags & ACC.INTERFACE) !== 0; }
  get def(): ClassDef { return this.def_ ??= this.dex.classDef(this.idx); }
  /** how many methods it declares, which the members need not be built to tell */
  get nMethods() { return this.members_ ? this.members_.methods.length : this.dex.declaredMethodCount(this.idx); }
  private get members() { return this.members_ ??= this.build(); }
  get fields() { return this.fields_ ??= this.buildFields(); }
  get methods() { return this.members.methods; }
  get byKey() { return this.members.byKey; }
  /** the keys and access flags of its methods, for the class-hierarchy index (no record of the methods is kept) */
  declared(): [key: string, flags: number][] {
    if (this.members_) return this.members_.methods.map((m) => [m.key, m.flags]);
    const def = this.dex.classDef(this.idx);
    return [...def.directMethods, ...def.virtualMethods].map((m) => [this.dex.methodKey(m.methodIdx), m.flags]);
  }
  /** what `method` found in the dex's ids, by key (a raw key after a NUL), null for none: the same questions come back for a class */
  private looked?: Map<string, ReturnType<DexFile["declaredAt"]> | null>;
  /** Implementation checks often miss: they look the method up in the dex's ids rather than build the class's members. */
  method(key: string, raw = false): MethodInfo | undefined {
    if (this.members_ && !raw) return this.members_.byKey.get(key);
    const memo = raw ? "\0" + key : key;
    let m = this.looked?.get(memo);
    if (m === undefined) {
      const at = key.indexOf("("), i = this.dex.findMethod(this.dex.classDef2Type(this.idx), key.slice(0, at), key.slice(at), raw);
      (this.looked ??= new Map()).set(memo, m = (i < 0 ? undefined : this.dex.declaredAt(this.idx, i)) ?? null);
    }
    return m ? this.members_?.methods[m.index] ?? this.methodInfo(m, m.index) : undefined;
  }
  /** the method at `index` (direct methods first, then virtual), without building the others */
  methodAt(index: number): MethodInfo | undefined {
    if (this.members_) return this.members_.methods[index];
    const def = this.def, m = index < def.directMethods.length ? def.directMethods[index] : def.virtualMethods[index - def.directMethods.length];
    return m && this.methodInfo(m, index);
  }
  private methodInfo(m: ClassDef["directMethods"][number], index: number): MethodInfo {
    const cached = this.methodInfos?.get(index);
    if (cached) return cached;
    const { dex, name } = this, mr = dex.method(m.methodIdx), desc = dex.methodDesc(m.methodIdx), p = dex.methodTypes(m.methodIdx);
    const info: MethodInfo = { cls: name, name: mr.name, desc, flags: m.flags, dex, methodIdx: m.methodIdx, codeOff: m.codeOff, key: mkey(mr.name, desc),
      isStatic: (m.flags & ACC.STATIC) !== 0, isCtor: mr.name === "<init>", params: p.params, ret: p.ret, index };
    (this.methodInfos ??= new Map()).set(index, info);
    return info;
  }
  private buildFields(): FieldInfo[] {
    const { dex, name, def } = this, fields: FieldInfo[] = [];
    // ART's Object declares its class and monitor words as fields; here they are the object header
    for (const [list, isStatic] of [[def.staticFields, true], [def.instanceFields, false]] as const) {
      for (const f of name === "java/lang/Object" && !isStatic ? [] : list) {
        const fr = dex.field(f.fieldIdx), desc = dex.type(fr.type);
        fields.push({ owner: name, name: fr.name, desc, kind: kindOf(desc), isStatic, flags: f.flags });
      }
    }
    return fields;
  }
  private build() {
    const def = this.def, methods: MethodInfo[] = [];
    for (const list of [def.directMethods, def.virtualMethods]) for (const m of list) {
      methods.push(this.methodInfo(m, methods.length));
    }
    this.methodInfos = undefined;
    return { methods, byKey: new Map(methods.map((m) => [m.key, m])) };
  }
}
/** how many methods (and so table slots) a class has */
export const methodCount = (c: JClass): number => (c instanceof DexClass ? c.nMethods : c.methods.length);
/** the method a class declares at `index` (its table slot's offset), without materializing the others */
export const methodAt = (c: JClass, index: number): MethodInfo | undefined => (c instanceof DexClass ? c.methodAt(index) : c.methods[index]);
/** One declared method without materializing unrelated members. */
export function declaredMethod(c: JClass | undefined, key: string, raw = false): MethodInfo | undefined {
  if (c instanceof DexClass) return c.method(key, raw);
  return raw ? c?.methods.find(m => javaName(m.key) === key) : c?.byKey.get(key);
}
/** the class_def of a class in its dex, or -1 for a class no dex defines */
export const classDefIdx = (c: JClass): number => (c instanceof DexClass ? c.idx : -1);
/** the keys and access flags of the methods a class declares */
export const declaredMethods = (c: JClass): [string, number][] => (c instanceof DexClass ? c.declared() : c.methods.map((m) => [m.key, m.flags]));

export class Program {
  /** the classes this Program adds to its base's, by key */
  private classes = new Map<string, JClass>();
  private syntheticLoaders = new Map<string, Loader>();
  private initiated = new WeakMap<Loader, Map<string, string>>();
  readonly root: Loader = { id: 0, parent: null, object: null, defined: new Map() };
  readonly boot: Loader = { id: 0, parent: null, object: null, defined: new Map() };
  private loaders: Loader[] = [this.root];
  private dexLoader = new Map<DexFile, Loader>();
  private sealed = false;
  private bootPath = false;
  /** The default namespace resolves as `lookup` does, ART's native path for a PathClassLoader over the boot loader, until its loader is found to be another kind. */
  dynamicRoot = false;
  /** analyses of the classes that outlive a World (cha.ts keeps the platform's class hierarchy here, so the frames of a page build it once) */
  readonly shared = new Map<string, unknown>();
  /** `base` is the platform's Program, which is immutable from now on and may be shared by the Programs of several processes: this one adds the app's dexes and the classes
   *  its loaders define, and the default loader's namespace is the base's first, then this one's */
  constructor(dexes: DexFile[], readonly base?: Program) {
    if (base) base.sealed = true;
    this.add(dexes);
    if (!base) this.addRuntimeClasses();
  }
  /** load more dexes (open world) into `loader`'s namespace; returns the keys of the classes they define. A name the loader or its ancestors define already keeps its first definition. */
  add(dexes: DexFile[], loader: Loader = this.root): string[] {
    if (this.sealed) throw new Error("this Program is the base of another and cannot change");
    if (loader === this.boot) this.bootPath = true;
    const added: string[] = [];
    this.forget();
    for (const dex of dexes) {
      const owner = this.loaderOfDex(dex);
      if (owner && owner !== loader) throw new Error(`${dex.name} belongs to another loader`);
      this.dexLoader.set(dex, loader);
      if (loader !== this.root) dex.resolveType ??= (d) => this.rewrite(loader, d);
      for (let i = 0; i < dex.classDefCount; i++) {
        const name = dex.rawTypeName(dex.classDef2Type(i));
        if (loader === this.root ? this.has(name) : loader.defined.has(name)) continue;
        const key = loader.id ? `${name}@${loader.id}` : name;
        loader.defined.set(name, key);
        this.classes.set(key, new DexClass(key, dex, i));
        added.push(key);
      }
    }
    return added;
  }
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
    for (let p: Program | undefined = this; p; p = p.base) {
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
  libraries(loader: Loader, before: Loader[], after: Loader[], changed: ReadonlySet<string> = this.libraryChanges(loader, before, after)): string[] {
    const same = (a: Loader[] | undefined, b: Loader[]) => (a?.length ?? 0) === b.length && b.every((l, i) => l === a![i]);
    if (same(loader.before, before) && same(loader.after, after)) return [];
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
    const names = (dex: DexFile) => {
      for (let i = 0; i < dex.typeCount; i++) if (types!.has(dex.rawType(i).replace(/^\[+/, ""))) return true;
      return false;
    };
    for (const [dex, owner] of this.dexLoader) if (affected.has(owner) && (!types || names(dex))) dexes.set(dex, owner);
    return dexes;
  }
  resolutionClasses(loader: Loader, changed: ReadonlySet<string>): Set<string> {
    const dexes = this.resolutionDexes(loader, changed);
    return new Set([...this.classes.values()].filter(c => c instanceof DexClass && dexes.has(c.dex)).map(c => c.name));
  }
  private refreshResolution(loader: Loader, changed: ReadonlySet<string>): string[] {
    const dexes = this.resolutionDexes(loader, changed), names: string[] = [], types = changedTypes(changed);
    for (const [dex, owner] of dexes) dex.resolveType = d => this.rewrite(owner, d);
    for (const c of this.classes.values()) if (c instanceof DexClass) {
      const owner = dexes.get(c.dex);
      if (owner) { c.refreshTypes(d => this.rewrite(owner, d), types); names.push(c.name); }
    }
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
  has(name: string): boolean { return this.classes.has(name) || !!this.base?.has(name); }
  /** every class, the base's first */
  *all(): Generator<JClass> {
    if (this.base) yield* this.base.all();
    yield* this.classes.values();
  }
  /** the classes this Program adds to its base's */
  own(): IterableIterator<JClass> { return this.classes.values(); }
  private stub(name: string, sup: string | null): JClass {
    const c: JClass = { name, dex: null, def: null, sup, ifaces: [], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map() };
    this.classes.set(name, c); this.syntheticLoaders.set(name, this.boot); return c;
  }
  /** Classes the compiler's own helpers instantiate; stubbed when the loaded dexes (no framework) lack them. */
  private addRuntimeClasses() {
    const E = "java/lang/", chain: [string, string | null][] = [["Object", null], ["String", "Object"], ["Throwable", "Object"], ["Exception", "Throwable"], ["RuntimeException", "Exception"],
      ["NullPointerException", "RuntimeException"], ["ArithmeticException", "RuntimeException"], ["ClassCastException", "RuntimeException"],
      ["NegativeArraySizeException", "RuntimeException"], ["IndexOutOfBoundsException", "RuntimeException"], ["ArrayIndexOutOfBoundsException", "IndexOutOfBoundsException"],
      ["Error", "Throwable"], ["LinkageError", "Error"], ["UnsatisfiedLinkError", "LinkageError"], ["NoClassDefFoundError", "LinkageError"],
      ["IncompatibleClassChangeError", "LinkageError"], ["NoSuchMethodError", "IncompatibleClassChangeError"], ["NoSuchFieldError", "IncompatibleClassChangeError"],
      ["VirtualMachineError", "Error"], ["OutOfMemoryError", "VirtualMachineError"], ["StackOverflowError", "VirtualMachineError"]];
    for (const [n, sup] of chain) if (!this.has(E + n)) this.stub(E + n, sup && E + sup);
  }
  /** statics of library classes without bytecode here: resolvable stubs the compiler replaces with intrinsics */
  addExterns(keys: string[]) {
    if (this.sealed) throw new Error("this Program is the base of another and cannot change");
    for (const key of keys) {
      const [, cls, name, desc] = /^(.*)\.(\w+)(\(.*)$/.exec(key)!;
      if (this.get(cls)?.dex) continue;
      const p = parseMethodDesc(desc);
      const c = this.get(cls) ?? this.stub(cls, "java/lang/Object");
      const m: MethodInfo = { cls, name, desc, flags: ACC.PUBLIC | ACC.STATIC, dex: null!, methodIdx: -1, codeOff: 0, key: mkey(name, desc), isStatic: true, isCtor: false, params: p.params, ret: p.ret, index: c.methods.length };
      c.methods.push(m); c.byKey.set(m.key, m);
    }
    this.forget();
  }
  /** a class made at run time (a proxy class): the open-world counterpart of `add` for a class no dex defines */
  addClass(jc: JClass, loader: Loader = this.root): void {
    if (this.base?.has(jc.name)) this.shadowing = true;
    jc.methods.forEach((m, i) => { m.index = i; jc.byKey.set(m.key, m); });
    this.classes.set(jc.name, jc);
    if (!jc.dex) { this.syntheticLoaders.set(jc.name, loader); loader.defined.set(javaName(jc.name), jc.name); }
    this.forget();
  }
  get(name: string): JClass | undefined { return this.classes.get(name) ?? this.base?.get(name); }
  require(name: string): JClass { const c = this.get(name); if (!c) throw new Error("class not found: " + name); return c; }
  /** a class of this Program stands in for one of the base's (a host class over a platform class): the base's answers about implementations are no longer this Program's */
  private shadowing = false;
  private ancestorMemo = new Map<string, Set<string>>();
  private implMemo = new Map<string, Map<string, DispatchTarget>>();
  private layouts = new Map<string, readonly FieldInfo[]>();
  private chains = new Map<string, readonly string[]>();
  /** what the compiler resolved per reference of a dex (MethodCompiler.resolved), by reference index and use */
  readonly refMemo = new Map<DexFile, Map<number, unknown>>();
  /** drops what a change to the classes or their types can falsify */
  private forget(): void { this.ancestorMemo.clear(); this.implMemo.clear(); this.layouts.clear(); this.chains.clear(); this.refMemo.clear(); }
  /** the supertypes of `a` (superclasses and interfaces, itself included), made once per class: a class-hierarchy query asks this of the same classes again and again */
  private ancestors(a: string): Set<string> {
    let s = this.ancestorMemo.get(a);
    if (!s) {
      s = new Set([a]);
      const c = this.get(a);
      if (c) for (const p of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) for (const x of this.ancestors(p)) s.add(x);
      this.ancestorMemo.set(a, s);
    }
    return s;
  }
  supertypes(a: string): ReadonlySet<string> {
    return this.base?.has(a) ? this.base.supertypes(a) : this.ancestors(a);
  }
  isSubclass(a: string, b: string): boolean { return a === b || this.supertypes(a).has(b); }
  /** resolve a method declared in `cls` or inherited (superclasses, then interfaces) */
  resolve(cls: string, name: string, desc: string): MethodInfo | undefined {
    const key = mkey(name, desc);
    for (let c: JClass | undefined = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) {
      const m = declaredMethod(c, key); if (m) return m;
    }
    const seen = new Set<string>();
    const visit = (n: string): MethodInfo | undefined => {
      if (seen.has(n)) return undefined; seen.add(n);
      const c = this.get(n); if (!c) return undefined;
      const m = declaredMethod(c, key); if (m && !(m.flags & ACC.STATIC)) return m;
      for (const i of c.ifaces) { const r = visit(i); if (r) return r; }
      return undefined;
    };
    for (let c: JClass | undefined = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) {
      for (const i of c.ifaces) { const r = visit(i); if (r) return r; }
    }
    return undefined;
  }
  /** a concrete (non-abstract) implementation of name+desc for runtime class `cls` */
  implFor(cls: string, name: string, desc: string): MethodInfo | undefined {
    const target = this.dispatchFor(cls, name, desc);
    return target && !("thrower" in target) ? target : undefined;
  }
  /** The receiver's executable target, retaining invocation-time default conflicts. */
  dispatchFor(cls: string, name: string, desc: string): DispatchTarget {
    if (!this.shadowing && this.base?.has(cls)) return this.base.dispatchFor(cls, name, desc);
    const key = mkey(name, desc);
    let memo = this.implMemo.get(cls);
    if (!memo) this.implMemo.set(cls, memo = new Map());
    if (memo.has(key)) return memo.get(key);
    const found = this.findImpl(cls, key);
    memo.set(key, found);
    return found;
  }
  private findImpl(cls: string, key: string): DispatchTarget {
    for (let c: JClass | undefined = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) {
      const m = declaredMethod(c, key); if (m && !(m.flags & ACC.STATIC)) return m.flags & ACC.ABSTRACT ? undefined : m;
    }
    return selectDefault(this.maximalInterfaceMethods(this.chain(cls).flatMap(n => this.require(n).ifaces), c => declaredMethod(c, key)));
  }
  /** Abstract declarations participate in dominance even when only a concrete body is requested. */
  maximalInterfaceMethods(roots: readonly string[], lookup: (c: JClass) => MethodInfo | undefined): MethodInfo[] {
    const seen = new Set<string>(), found: MethodInfo[] = [];
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const c = this.get(name); if (!c) return;
      const m = lookup(c);
      if (m && !(m.flags & (ACC.STATIC | ACC.PRIVATE))) found.push(m);
      c.ifaces.forEach(visit);
    };
    roots.forEach(visit);
    return found.filter(m => !found.some(other => other !== m && this.isSubclass(other.cls, m.cls)));
  }
  /** the superinterfaces of class `cls` that declare a default method: initialized with it (JLS 12.4.1) */
  defaultIfaces(cls: string): string[] {
    const out = new Set<string>();
    const visit = (i: string) => {
      const c = this.get(i); if (!c || out.has(i)) return;
      if (c.methods.some((m) => !m.isStatic && !(m.flags & ACC.ABSTRACT))) out.add(i);
      c.ifaces.forEach(visit);
    };
    for (let c = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) c.ifaces.forEach(visit);
    return [...out];
  }
  resolveField(cls: string, name: string, desc: string): FieldInfo | undefined {
    const seen = new Set<string>();
    const visit = (n: string): FieldInfo | undefined => {
      if (seen.has(n)) return undefined; seen.add(n);
      const c = this.get(n); if (!c) return undefined;
      const f = c.fields.find((x) => x.name === name && x.desc === desc); if (f) return f;
      for (const i of c.ifaces) { const r = visit(i); if (r) return r; }
      return c.sup ? visit(c.sup) : undefined;
    };
    return visit(cls);
  }
  /** instance fields in layout order: superclass fields first */
  layout(cls: string): readonly FieldInfo[] {
    let l = this.layouts.get(cls);
    if (l) return l;
    const c = this.get(cls); if (!c) return [];
    l = [...(c.sup ? this.layout(c.sup) : []), ...c.fields.filter((f) => !f.isStatic)];
    this.layouts.set(cls, l);
    return l;
  }
  /** the class and its superclasses, the class first */
  chain(cls: string): readonly string[] {
    let out = this.chains.get(cls);
    if (!out) {
      const names: string[] = [];
      for (let c = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) names.push(c.name);
      this.chains.set(cls, out = names);
    }
    return out;
  }
}
