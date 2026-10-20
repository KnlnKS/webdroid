import type { LinkFailure } from "./linkage.ts";
import type { Trivial } from "./inline.ts";
import type { Index } from "./cha.ts";
import { ACC, type DexFile, type DexTypes, type ClassDef } from "../../jvm/dex.ts";
import { parseMethodDesc } from "../../jvm/abi.ts";
import { LoaderGraph, type Loader, type LoaderTypes } from "./loadergraph.ts";
export type { Loader, LoaderId, LoaderParent, LoaderSnapshot } from "./loadergraph.ts";

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
/** what resolved of a dex's references, while the Program's classes hold: invokes by 8 * method_id + Invoke, fields by 2 * field_id + whether static */
export interface ResolvedRefs { invokes: Map<number, MethodInfo>; fields: Map<number, { decl: string; f: FieldInfo }> }

/** Conflict is an invocation error, not an abstract or missing declaration. */
export function selectDefault(maximal: readonly MethodInfo[], includeAbstract = false): DispatchTarget {
  const defaults = maximal.filter(m => !(m.flags & ACC.ABSTRACT));
  if (defaults.length > 1) return { thrower: "icce", message: "Conflicting default methods: " + defaults.map(m => javaName(m.cls) + "." + javaName(m.key)).join(", "), candidates: defaults };
  return defaults[0] ?? (includeAbstract ? maximal[0] : undefined);
}

/** a class: a DexClass, whose members its dex holds and which are read when asked for, or a PlainClass, whose members are records made for it */
export interface JClass {
  readonly name: string; readonly dex: DexFile | null; readonly def: ClassDef | null; readonly sup: string | null; readonly ifaces: string[]; readonly flags: number;
  readonly isInterface: boolean; readonly fields: FieldInfo[]; readonly methods: MethodInfo[]; readonly byKey: Map<string, MethodInfo>;
  /** how many methods (and so table slots) it has */
  readonly methodCount: number;
  /** its class_def in its dex, or -1 where its members are not read from one */
  readonly defIdx: number;
  /** its superclass, if any, then its interfaces */
  supertypes(): string[];
  /** the method it declares at `index` (its table slot's offset), without materializing the others */
  methodAt(index: number): MethodInfo | undefined;
  /** the method it declares under `key` (the key as its dex spells it if `raw`), without materializing the others */
  method(key: string, raw?: boolean): MethodInfo | undefined;
  /** the keys and access flags of the methods it declares */
  declared(): [key: string, flags: number][];
  /** whether it declares a method that can be overridden (not static, private or a constructor) whose descriptor names one of the class descriptors `types`, or an
   *  array of one; any such method without `types` */
  declaresNaming(types?: ReadonlySet<string>): boolean;
  /** whether it may declare a static field whose type is one of the class descriptors `types` or an array of one */
  declaresStaticOf(types: ReadonlySet<string>): boolean;
}
/** a class whose members are records made for it: a stub, a class of natives or a proxy class, or a class of the host standing for a dex's (hostclass.ts), whose
 *  methods are no longer the dex's */
export class PlainClass implements JClass {
  readonly name: string; sup: string | null; ifaces: string[]; flags: number;
  readonly methods: MethodInfo[]; readonly fields: FieldInfo[]; readonly dex: DexFile | null; readonly def: ClassDef | null;
  readonly byKey = new Map<string, MethodInfo>();
  constructor(name: string, sup: string | null, ifaces: string[], flags: number, methods: MethodInfo[] = [], fields: FieldInfo[] = [], dex: DexFile | null = null, def: ClassDef | null = null) {
    this.name = name; this.sup = sup; this.ifaces = ifaces; this.flags = flags; this.methods = methods; this.fields = fields; this.dex = dex; this.def = def;
    for (const m of methods) this.byKey.set(m.key, m);
  }
  get isInterface() { return (this.flags & ACC.INTERFACE) !== 0; }
  get methodCount() { return this.methods.length; }
  get defIdx() { return -1; }
  add(m: MethodInfo): void { this.methods.push(m); this.byKey.set(m.key, m); }
  supertypes(): string[] { return this.sup ? [this.sup, ...this.ifaces] : this.ifaces; }
  methodAt(index: number): MethodInfo | undefined { return this.methods[index]; }
  method(key: string, raw = false): MethodInfo | undefined { return raw ? this.methods.find(m => javaName(m.key) === key) : this.byKey.get(key); }
  declared(): [string, number][] { return this.methods.map((m) => [m.key, m.flags]); }
  declaresNaming(types?: ReadonlySet<string>): boolean {
    return this.methods.some(m => !(m.flags & (ACC.STATIC | ACC.PRIVATE)) && m.name !== "<init>" && (!types || [...javaName(m.desc).matchAll(/L[^;]+;/g)].some(t => types.has(t[0]))));
  }
  declaresStaticOf(): boolean { return true; }
}
export const mkey = (name: string, desc: string) => name + desc;

/** the name Java code sees for a class key (and for the key of an array class) */
export const javaName = (key: string): string => (key.includes("@") ? key.replace(/@\d+(?=;|$)/g, "") : key);
/** the class name of a type descriptor: primitive classes are keyed "#I" and so on, apart from the classes named like a descriptor letter (a default-package class C) */
export const typeName = (d: string) => d[0] === "L" ? d.slice(1, -1) : d.length === 1 ? "#" + d : d;
/** the descriptor of a class name, typeName's inverse */
export const descOf = (name: string) => name[0] === "#" ? name[1] : name[0] === "[" ? name : `L${name};`;
/** Runtime packages include the defining loader, not just the binary package name. */
export function sameRuntimePackage(prog: Program, a: string, b: string): boolean {
  const pkg = (name: string) => { name = javaName(name); return name.slice(0, name.lastIndexOf("/") + 1); };
  return pkg(a) === pkg(b) && prog.loaderOf(a) === prog.loaderOf(b);
}

/** a class of a dex file. Its header (supertypes, flags) is read when asked for and its members are built when the first of them is, so a Program holds
 *  little for the thousands of platform classes a process never uses. */
class DexClass implements JClass {
  readonly name: string; readonly dex: DexFile; readonly defIdx: number;
  // declared, not defined: an object of a class nothing asks about holds only its name, dex and index
  private declare header_?: { flags: number; sup: string | null; ifaces: string[] };
  private declare def_?: ClassDef;
  private declare members_?: { methods: MethodInfo[]; byKey: Map<string, MethodInfo> };
  private declare fields_?: FieldInfo[];
  private declare methodInfos?: Map<number, MethodInfo>;
  /** how its loader sees the types its dex names, where that is not as the dex spells them */
  private declare view?: LoaderTypes;
  constructor(name: string, dex: DexFile, defIdx: number, types: DexTypes) {
    this.name = name; this.dex = dex; this.defIdx = defIdx;
    if (types !== dex) this.view = types as LoaderTypes;
  }
  private get types(): DexTypes { return this.view ?? this.dex; }
  /** its loader came to resolve the class descriptors `changedTypes` differently (any if undefined), as `view` does */
  retype(view: LoaderTypes, changedTypes?: ReadonlySet<string>): void {
    this.view = view;
    if (!changedTypes) this.header_ = undefined;
    else if (this.header_) {
      const h = this.dex.classHeader(this.defIdx);
      if (h.superIdx !== 0xffffffff && changedTypes.has(this.dex.rawType(h.superIdx)) || h.interfaces.some(i => changedTypes.has(this.dex.rawType(i)))) this.header_ = undefined;
    }
    const aliases = this.members_ ? [...this.members_.byKey].filter(([key, m]) => key !== m.key) : [];
    for (const m of this.members_?.methods ?? this.methodInfos?.values() ?? []) {
      if (m.dex !== this.dex || m.methodIdx < 0) continue;
      const desc = view.methodDesc(m.methodIdx);
      if (desc === m.desc) continue;
      const old = m.key, parsed = parseMethodDesc(desc);
      m.desc = desc; m.params = parsed.params; m.ret = parsed.ret; m.key = mkey(m.name, desc);
      this.members_?.byKey.delete(old); this.members_?.byKey.set(m.key, m);
    }
    for (const [key, method] of aliases) {
      const at = key.indexOf("("), resolved = key.slice(0, at) + key.slice(at).replace(/L[^;]+;/g, descriptor => view.resolve(javaName(descriptor)));
      if (key !== resolved) this.members_!.byKey.delete(key);
      this.members_!.byKey.set(resolved, method);
    }
    if (this.fields_) {
      let i = 0;
      for (const list of [this.def.staticFields, this.def.instanceFields]) for (const f of list) {
        if (this.name === "java/lang/Object" && list === this.def.instanceFields) continue;
        this.fields_[i++].desc = view.type(this.dex.field(f.fieldIdx).type);
      }
    }
  }
  private get header() { return this.header_ ??= this.readHeader(); }
  private readHeader() {
    const h = this.dex.classHeader(this.defIdx), types = this.types;
    return { flags: h.flags, sup: h.superIdx === 0xffffffff ? null : types.typeName(h.superIdx), ifaces: h.interfaces.map((t) => types.typeName(t)) };
  }
  /** without keeping a header for a class nothing else asks about */
  supertypes(): string[] { const { sup, ifaces } = this.header_ ?? this.readHeader(); return sup ? [sup, ...ifaces] : ifaces; }
  get flags() { return this.header.flags; }
  get sup() { return this.header.sup; }
  get ifaces() { return this.header.ifaces; }
  get isInterface() { return (this.header.flags & ACC.INTERFACE) !== 0; }
  get def(): ClassDef { return this.def_ ??= this.dex.classDef(this.defIdx); }
  /** which the members need not be built to tell */
  get methodCount() { return this.members_ ? this.members_.methods.length : this.dex.declaredMethodCount(this.defIdx); }
  private get members() { return this.members_ ??= this.build(); }
  get fields() { return this.fields_ ??= this.buildFields(); }
  get methods() { return this.members.methods; }
  get byKey() { return this.members.byKey; }
  /** for the class-hierarchy index: no record of the methods is kept */
  declared(): [key: string, flags: number][] {
    if (this.members_) return this.members_.methods.map((m) => [m.key, m.flags]);
    const def = this.dex.classDef(this.defIdx);
    const types = this.types;
    return [...def.directMethods, ...def.virtualMethods].map((m) => [types.methodKey(m.methodIdx), m.flags]);
  }
  /** what `method` found in the dex's ids, by key (a raw key after a NUL), null for none: the same questions come back for a class */
  private declare looked?: Map<string, ReturnType<DexFile["declaredAt"]> | null>;
  /** Implementation checks often miss: they look the method up in the dex's ids rather than build the class's members. */
  method(key: string, raw = false): MethodInfo | undefined {
    // a dex its loader sees as it is spelled keys its methods so
    raw &&= !!this.view;
    if (this.members_ && !raw) return this.members_.byKey.get(key);
    const memo = raw ? "\0" + key : key;
    let m = this.looked?.get(memo);
    if (m === undefined) {
      const at = key.indexOf("("), i = this.dex.findMethod(this.dex.classDef2Type(this.defIdx), key.slice(0, at), key.slice(at), raw ? this.dex : this.types);
      (this.looked ??= new Map()).set(memo, m = (i < 0 ? undefined : this.dex.declaredAt(this.defIdx, i)) ?? null);
    }
    return m ? this.members_?.methods[m.index] ?? this.methodInfo(m, m.index) : undefined;
  }
  /** direct methods first, then virtual */
  methodAt(index: number): MethodInfo | undefined {
    if (this.members_) return this.members_.methods[index];
    const def = this.def, m = index < def.directMethods.length ? def.directMethods[index] : def.virtualMethods[index - def.directMethods.length];
    return m && this.methodInfo(m, index);
  }
  declaresNaming(types?: ReadonlySet<string>): boolean { return this.dex.declaresVirtual(this.defIdx, types && this.dex.typesNaming(types)); }
  declaresStaticOf(types: ReadonlySet<string>): boolean { return this.dex.declaresStaticOf(this.defIdx, this.dex.typesNaming(types)); }
  private methodInfo(m: ClassDef["directMethods"][number], index: number): MethodInfo {
    const cached = this.methodInfos?.get(index);
    if (cached) return cached;
    const { dex, name, types } = this, mr = dex.method(m.methodIdx), desc = types.methodDesc(m.methodIdx), p = types.methodTypes(m.methodIdx);
    const info: MethodInfo = { cls: name, name: mr.name, desc, flags: m.flags, dex, methodIdx: m.methodIdx, codeOff: m.codeOff, key: mkey(mr.name, desc),
      isStatic: (m.flags & ACC.STATIC) !== 0, isCtor: mr.name === "<init>", params: p.params, ret: p.ret, index };
    (this.methodInfos ??= new Map()).set(index, info);
    return info;
  }
  private buildFields(): FieldInfo[] {
    const { dex, name, def, types } = this, fields: FieldInfo[] = [];
    // ART's Object declares its class and monitor words as fields; here they are the object header
    for (const [list, isStatic] of [[def.staticFields, true], [def.instanceFields, false]] as const) {
      for (const f of name === "java/lang/Object" && !isStatic ? [] : list) {
        const fr = dex.field(f.fieldIdx), desc = types.type(fr.type);
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

export class Program extends LoaderGraph {
  readonly base?: Program;
  private sealed = false;
  /** the class-hierarchy index of its classes (cha.ts), which outlives a World: the frames of a page build the platform's once */
  cha?: Index;
  /** `base` is the platform's Program, which is immutable from now on and may be shared by the Programs of several processes: this one adds the app's dexes and the classes
   *  its loaders define, and the default loader's namespace is the base's first, then this one's */
  constructor(dexes: DexFile[], base?: Program) {
    super();
    this.base = base;
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
      const types = this.assign(dex, loader);
      for (let i = 0; i < dex.classDefCount; i++) {
        const name = dex.rawTypeName(dex.classDef2Type(i));
        if (loader === this.root ? this.has(name) : loader.defined.has(name)) continue;
        const key = loader.id ? `${name}@${loader.id}` : name;
        // the root's namespace is this Program's classes
        if (loader !== this.root) loader.defined.set(name, key);
        this.classes.set(key, new DexClass(key, dex, i, types));
        added.push(key);
      }
    }
    return added;
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
    const c = new PlainClass(name, sup, [], ACC.PUBLIC);
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
  /** a class this Program adds to its base's */
  ownClass(name: string): JClass | undefined { return this.classes.get(name); }
  require(name: string): JClass { const c = this.get(name); if (!c) throw new Error("class not found: " + name); return c; }
  /** a class of this Program stands in for one of the base's (a host class over a platform class): the base's answers about implementations are no longer this Program's */
  private shadowing = false;
  private ancestorMemo = new Map<string, Set<string>>();
  private implMemo = new Map<string, Map<string, DispatchTarget>>();
  private layouts = new Map<string, readonly FieldInfo[]>();
  private chains = new Map<string, readonly string[]>();
  /** what the compiler resolved of each dex's references (MC.resolved) */
  private refs = new Map<DexFile, ResolvedRefs>();
  refsOf(dex: DexFile): ResolvedRefs { let r = this.refs.get(dex); if (!r) this.refs.set(dex, r = { invokes: new Map(), fields: new Map() }); return r; }
  /** what a call of each method runs in place, or null (inline.ts trivialOf) */
  readonly trivials = new Map<MethodInfo, Trivial | null>();
  /** drops what a change to the classes or their types can falsify */
  protected forget(): void { this.ancestorMemo.clear(); this.implMemo.clear(); this.layouts.clear(); this.chains.clear(); this.refs.clear(); this.trivials.clear(); }
  protected retyped(dexes: ReadonlyMap<DexFile, Loader>, types: ReadonlySet<string> | undefined): string[] {
    const names: string[] = [];
    for (const c of this.classes.values()) if (c instanceof DexClass && dexes.has(c.dex)) { c.retype(this.typesOf(c.dex) as LoaderTypes, types); names.push(c.name); }
    return names;
  }
  /** the supertypes of `a` (superclasses and interfaces, itself included), made once per class: a class-hierarchy query asks this of the same classes again and again */
  private ancestors(a: string): Set<string> {
    let s = this.ancestorMemo.get(a);
    if (!s) {
      s = new Set([a]);
      const c = this.get(a);
      if (c) for (const p of c.supertypes()) for (const x of this.ancestors(p)) s.add(x);
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
      const m = c.method(key); if (m) return m;
    }
    const seen = new Set<string>();
    const visit = (n: string): MethodInfo | undefined => {
      if (seen.has(n)) return undefined; seen.add(n);
      const c = this.get(n); if (!c) return undefined;
      const m = c.method(key); if (m && !(m.flags & ACC.STATIC)) return m;
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
      const m = c.method(key); if (m && !(m.flags & ACC.STATIC)) return m.flags & ACC.ABSTRACT ? undefined : m;
    }
    return selectDefault(this.maximalInterfaceMethods(this.chain(cls).flatMap(n => this.require(n).ifaces), c => c.method(key)));
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
