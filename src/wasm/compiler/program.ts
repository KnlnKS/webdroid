import type { DexFile, ClassDef } from "../../jvm/dex";
import { descToName, parseMethodDesc } from "../../jvm/abi";

export const ACC = { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 0x10, SYNCHRONIZED: 0x20, DECLARED_SYNCHRONIZED: 0x20000, NATIVE: 0x100, INTERFACE: 0x200, ABSTRACT: 0x400, CONSTRUCTOR: 0x10000 };
export type Kind = "I" | "J" | "L";               // wasm-level kinds: i32 (int,float bits,small ints), i64 (long,double bits), ref
export const kindOf = (desc: string): Kind => desc[0] === "J" || desc[0] === "D" ? "J" : desc[0] === "L" || desc[0] === "[" ? "L" : "I";

export interface FieldInfo { owner: string; name: string; desc: string; kind: Kind; isStatic: boolean; flags: number }
export interface MethodInfo {
  cls: string; name: string; desc: string; flags: number; dex: DexFile; methodIdx: number; codeOff: number;
  key: string; isStatic: boolean; isCtor: boolean; params: string[]; ret: string;
  /** position in its class's `methods`, which is also the offset of its table slot from the class's block */
  index: number;
}
export interface JClass {
  name: string; dex: DexFile | null; def: ClassDef | null; sup: string | null; ifaces: string[]; flags: number;
  isInterface: boolean; fields: FieldInfo[]; methods: MethodInfo[]; byKey: Map<string, MethodInfo>;
}
export const mkey = (name: string, desc: string) => name + desc;

/** A defining namespace. The root holds app classes, the boot view exposes its platform base, and other loaders own distinct `name@id` keys. Visibility follows parent, before libraries, own definitions, after libraries, then the fallback. */
export interface Loader {
  readonly id: number;
  readonly parent: Loader | null;
  /** the ancestor namespace behind a ClassLoader of another kind (loaders.ts), consulted only for names nothing before it defines */
  readonly fallback?: Loader;
  /** the java.lang.ClassLoader this namespace belongs to, once the host has one */
  object: object | null;
  /** class name -> key of the classes this loader defines */
  readonly defined: Map<string, string>;
  before?: Loader[];
  after?: Loader[];
}
const SUFFIX = /@(\d+);?$/;
/** the name Java code sees for a class key (and for the key of an array class) */
export const javaName = (key: string): string => (key.includes("@") ? key.replace(/@\d+(?=;|$)/g, "") : key);
/** the id of the loader that defines the class (or the element class of the array class) with this key */
export const loaderIdOf = (key: string): number => +(SUFFIX.exec(key)?.[1] ?? 0);

/** a class of a dex file. Its header (supertypes, flags) is read when asked for and its members are built when the first of them is, so a Program holds
 *  little for the thousands of platform classes a process never uses. */
class DexClass implements JClass {
  private header_?: { flags: number; sup: string | null; ifaces: string[] };
  private def_?: ClassDef;
  private members_?: { fields: FieldInfo[]; methods: MethodInfo[]; byKey: Map<string, MethodInfo> };
  private methodInfos?: Map<number, MethodInfo>;
  constructor(readonly name: string, readonly dex: DexFile, readonly idx: number) {}
  refreshTypes(resolve: (desc: string) => string): void {
    this.header_ = undefined;
    const aliases = this.members_ ? [...this.members_.byKey].filter(([key, m]) => key !== m.key) : [];
    for (const m of this.members_?.methods ?? this.methodInfos?.values() ?? []) {
      if (m.dex !== this.dex || m.methodIdx < 0) continue;
      const old = m.key, desc = this.dex.methodDesc(m.methodIdx), parsed = parseMethodDesc(desc);
      m.desc = desc; m.params = parsed.params; m.ret = parsed.ret; m.key = mkey(m.name, desc);
      this.members_?.byKey.delete(old); this.members_?.byKey.set(m.key, m);
    }
    for (const [key, method] of aliases) {
      const at = key.indexOf("("), resolved = key.slice(0, at) + key.slice(at).replace(/L[^;]+;/g, descriptor => resolve(javaName(descriptor)));
      if (key !== resolved) this.members_!.byKey.delete(key);
      this.members_!.byKey.set(resolved, method);
    }
    if (this.members_) {
      let i = 0;
      for (const list of [this.def.staticFields, this.def.instanceFields]) for (const f of list) {
        if (this.name === "java/lang/Object" && list === this.def.instanceFields) continue;
        this.members_.fields[i++].desc = this.dex.type(this.dex.field(f.fieldIdx).type);
      }
    }
  }
  private get header() {
    if (!this.header_) {
      const h = this.dex.classHeader(this.idx), dex = this.dex;
      this.header_ = { flags: h.flags, sup: h.superIdx === 0xffffffff ? null : descToName(dex.type(h.superIdx)), ifaces: h.interfaces.map((t) => descToName(dex.type(t))) };
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
  get fields() { return this.members.fields; }
  get methods() { return this.members.methods; }
  get byKey() { return this.members.byKey; }
  /** the keys and access flags of its methods, for the class-hierarchy index (no record of the methods is kept) */
  declared(): [key: string, flags: number][] {
    if (this.members_) return this.members_.methods.map((m) => [m.key, m.flags]);
    const def = this.dex.classDef(this.idx);
    return [...def.directMethods, ...def.virtualMethods].map((m) => [this.dex.methodKey(m.methodIdx), m.flags]);
  }
  /** Implementation checks often miss: they look the method up in the dex's ids rather than build the class's members. */
  method(key: string): MethodInfo | undefined {
    if (this.members_) return this.members_.byKey.get(key);
    const at = key.indexOf("("), i = this.dex.findMethod(this.dex.classDef2Type(this.idx), key.slice(0, at), key.slice(at));
    const m = i < 0 ? undefined : this.dex.declaredAt(this.idx, i);
    return m && this.methodInfo(m, m.index);
  }
  private methodInfo(m: ClassDef["directMethods"][number], index: number): MethodInfo {
    const cached = this.methodInfos?.get(index);
    if (cached) return cached;
    const { dex, name } = this, mr = dex.method(m.methodIdx), desc = dex.methodDesc(m.methodIdx), p = parseMethodDesc(desc);
    const info: MethodInfo = { cls: name, name: mr.name, desc, flags: m.flags, dex, methodIdx: m.methodIdx, codeOff: m.codeOff, key: mkey(mr.name, desc),
      isStatic: (m.flags & ACC.STATIC) !== 0, isCtor: mr.name === "<init>", params: p.params, ret: p.ret, index };
    (this.methodInfos ??= new Map()).set(index, info);
    return info;
  }
  private build() {
    const { dex, name, def } = this;
    const fields: FieldInfo[] = [];
    // ART's Object declares its class and monitor words as fields; here they are the object header
    for (const [list, isStatic] of [[def.staticFields, true], [def.instanceFields, false]] as const) {
      for (const f of name === "java/lang/Object" && !isStatic ? [] : list) {
        const fr = dex.field(f.fieldIdx), desc = dex.type(fr.type);
        fields.push({ owner: name, name: fr.name, desc, kind: kindOf(desc), isStatic, flags: f.flags });
      }
    }
    const methods: MethodInfo[] = [];
    for (const list of [def.directMethods, def.virtualMethods]) for (const m of list) {
      methods.push(this.methodInfo(m, methods.length));
    }
    this.methodInfos = undefined;
    return { fields, methods, byKey: new Map(methods.map((m) => [m.key, m])) };
  }
}
/** how many methods (and so table slots) a class has */
export const methodCount = (c: JClass): number => (c instanceof DexClass ? c.nMethods : c.methods.length);
/** One declared method without materializing unrelated members. */
export const declaredMethod = (c: JClass | undefined, key: string): MethodInfo | undefined => (c instanceof DexClass ? c.method(key) : c?.byKey.get(key));
/** the class_def of a class in its dex, or -1 for a class no dex defines */
export const classDefIdx = (c: JClass): number => (c instanceof DexClass ? c.idx : -1);
/** the keys and access flags of the methods a class declares */
export const declaredMethods = (c: JClass): [string, number][] => (c instanceof DexClass ? c.declared() : c.methods.map((m) => [m.key, m.flags]));

export class Program {
  /** the classes this Program adds to its base's, by key */
  private classes = new Map<string, JClass>();
  readonly root: Loader = { id: 0, parent: null, object: null, defined: new Map() };
  readonly boot: Loader = { id: 0, parent: null, object: null, defined: new Map() };
  private loaders: Loader[] = [this.root];
  private dexLoader = new Map<DexFile, Loader>();
  private sealed = false;
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
    const added: string[] = [];
    this.ancestorMemo.clear(); this.implMemo.clear();
    for (const dex of dexes) {
      const owner = this.loaderOfDex(dex);
      if (owner && owner !== loader) throw new Error(`${dex.name} belongs to another loader`);
      this.dexLoader.set(dex, loader);
      if (loader !== this.root) dex.resolveType ??= (d) => this.rewrite(loader, d);
      for (let i = 0; i < dex.classDefCount; i++) {
        const name = descToName(dex.rawType(dex.classDef2Type(i)));
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
  newLoader(parent: Loader, object: object | null, fallback?: Loader): Loader {
    const loader: Loader = { id: this.loaders.length, parent, fallback, object, defined: new Map() };
    this.loaders.push(loader);
    return loader;
  }
  /** the loader that defines the class with this key */
  loaderOf(key: string): Loader { return this.loaders[loaderIdOf(key)]; }
  /** the key of the class `name` as `loader` sees it: the first of its ancestors (parent first) and itself that defines it */
  lookup(loader: Loader, name: string, seen = new Set<Loader>()): string | undefined {
    if (seen.has(loader)) return undefined;
    seen.add(loader);
    if (loader === this.boot) return this.inBoot(name) ? name : undefined;
    const parent = loader.parent ? this.lookup(loader.parent, name, seen) : this.base?.has(name) ? name : undefined;
    if (parent) return parent;
    for (const library of loader.before ?? []) { const key = this.lookup(library, name, seen); if (key) return key; }
    const own = loader === this.root ? this.classes.has(name) ? name : undefined : loader.defined.get(name);
    if (own) return own;
    for (const library of loader.after ?? []) { const key = this.lookup(library, name, seen); if (key) return key; }
    return loader.fallback ? this.lookup(loader.fallback, name, seen) : undefined;
  }
  libraries(loader: Loader, before: Loader[], after: Loader[]): string[] {
    const same = (a: Loader[] | undefined, b: Loader[]) => (a?.length ?? 0) === b.length && b.every((l, i) => l === a![i]);
    if (same(loader.before, before) && same(loader.after, after)) return [];
    loader.before = before; loader.after = after;
    const depends = (view: Loader, seen = new Set<Loader>()): boolean => {
      if (view === loader) return true;
      if (view === this.boot || seen.has(view)) return false;
      seen.add(view);
      return [view.parent, view.fallback, ...view.before ?? [], ...view.after ?? []].some(l => !!l && depends(l, seen));
    };
    const affected = new Set(this.loaders.filter(l => depends(l))), names: string[] = [];
    for (const [dex, owner] of this.dexLoader) if (affected.has(owner)) dex.resolveType = d => this.rewrite(owner, d);
    for (const c of this.classes.values()) if (c instanceof DexClass) {
      const owner = this.loaderOfDex(c.dex)!;
      if (affected.has(owner)) { c.refreshTypes(d => this.rewrite(owner, d)); names.push(c.name); }
    }
    this.ancestorMemo.clear(); this.implMemo.clear();
    return names;
  }
  /** a type or method descriptor in binary names (JNI's) as the loader of class `cls` sees it: each class it names by the key that loader sees under that name */
  viewOf(cls: string, desc: string): string {
    const loader = this.loaderOf(cls);
    return loader.id ? desc.replace(/L([^;]+);/g, (whole, name: string) => { const key = this.lookup(loader, name); return key === undefined ? whole : `L${key};`; }) : desc;
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
    if (loader === this.boot) return this.inBoot(name) ? name : undefined;
    return loader === this.root ? this.classes.has(name) ? name : undefined : loader.defined.get(name);
  }
  /** the boot namespace: the platform base and the classes the host makes without a dex */
  private inBoot(name: string): boolean { return this.base ? this.base.has(name) || this.classes.get(name)?.dex === null : this.has(name); }
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
    this.classes.set(name, c); return c;
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
    this.ancestorMemo.clear(); this.implMemo.clear();
  }
  /** a class made at run time (a proxy class): the open-world counterpart of `add` for a class no dex defines */
  addClass(jc: JClass): void {
    if (this.base?.has(jc.name)) this.shadowing = true;
    jc.methods.forEach((m, i) => { m.index = i; jc.byKey.set(m.key, m); });
    this.classes.set(jc.name, jc);
    this.ancestorMemo.clear(); this.implMemo.clear();
  }
  get(name: string): JClass | undefined { return this.classes.get(name) ?? this.base?.get(name); }
  require(name: string): JClass { const c = this.get(name); if (!c) throw new Error("class not found: " + name); return c; }
  /** a class of this Program stands in for one of the base's (a host class over a platform class): the base's answers about implementations are no longer this Program's */
  private shadowing = false;
  private ancestorMemo = new Map<string, Set<string>>();
  private implMemo = new Map<string, Map<string, MethodInfo | undefined>>();
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
  isSubclass(a: string, b: string): boolean {
    if (a === b) return true;
    if (this.base?.has(a)) return this.base.isSubclass(a, b);
    return this.ancestors(a).has(b);
  }
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
    if (!this.shadowing && this.base?.has(cls)) return this.base.implFor(cls, name, desc);
    const key = mkey(name, desc);
    let memo = this.implMemo.get(cls);
    if (!memo) this.implMemo.set(cls, memo = new Map());
    if (memo.has(key)) return memo.get(key);
    const found = this.findImpl(cls, key);
    memo.set(key, found);
    return found;
  }
  private findImpl(cls: string, key: string): MethodInfo | undefined {
    for (let c: JClass | undefined = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) {
      const m = declaredMethod(c, key); if (m && !(m.flags & ACC.STATIC) && !(m.flags & ACC.ABSTRACT)) return m;
    }
    // default methods: the most specific one, i.e. none whose interface is a superinterface of another candidate's
    const seen = new Set<string>(), found: MethodInfo[] = [];
    const visit = (n: string) => {
      if (seen.has(n)) return; seen.add(n);
      const c = this.get(n); if (!c) return;
      const m = declaredMethod(c, key); if (m && !(m.flags & ACC.STATIC)) { if (!(m.flags & ACC.ABSTRACT)) found.push(m); return; }
      for (const i of c.ifaces) visit(i);
    };
    for (let c: JClass | undefined = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) for (const i of c.ifaces) visit(i);
    return found.find((m) => found.every((o) => o === m || !this.isSubclass(o.cls, m.cls)));
  }
  /** the method an invoke-super in class `cur` of a reference to `decl.name+desc` runs: found from the interface when `decl` is one, else from the superclass */
  superTarget(cur: string, decl: string, name: string, desc: string): MethodInfo | undefined {
    return this.resolve(this.get(decl)?.isInterface ? decl : this.get(cur)?.sup ?? decl, name, desc);
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
  layout(cls: string): FieldInfo[] {
    const c = this.get(cls); if (!c) return [];
    return [...(c.sup ? this.layout(c.sup) : []), ...c.fields.filter((f) => !f.isStatic)];
  }
  chain(cls: string): string[] { const out: string[] = []; for (let c = this.get(cls); c; c = c.sup ? this.get(c.sup) : undefined) out.push(c.name); return out; }
}
