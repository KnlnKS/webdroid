import type { DexFile, ClassDef, EncodedMethod } from "../../../src/jvm/dex";
import { descToName, parseMethodDesc } from "../../../src/jvm/abi";

export const ACC = { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 0x10, NATIVE: 0x100, INTERFACE: 0x200, ABSTRACT: 0x400, CONSTRUCTOR: 0x10000 };
export type Kind = "I" | "J" | "L";               // wasm-level kinds: i32 (int,float bits,small ints), i64 (long,double bits), ref
export const kindOf = (desc: string): Kind => desc[0] === "J" || desc[0] === "D" ? "J" : desc[0] === "L" || desc[0] === "[" ? "L" : "I";

export interface FieldInfo { owner: string; name: string; desc: string; kind: Kind; isStatic: boolean; flags: number }
export interface MethodInfo {
  cls: string; name: string; desc: string; flags: number; dex: DexFile; methodIdx: number; codeOff: number;
  key: string; isStatic: boolean; isCtor: boolean; params: string[]; ret: string;
}
export interface JClass {
  name: string; dex: DexFile | null; def: ClassDef | null; sup: string | null; ifaces: string[]; flags: number;
  isInterface: boolean; fields: FieldInfo[]; methods: MethodInfo[]; byKey: Map<string, MethodInfo>;
}
export const mkey = (name: string, desc: string) => name + desc;

export class Program {
  classes = new Map<string, JClass>();
  constructor(dexes: DexFile[]) {
    this.add(dexes);
    this.addRuntimeClasses();
  }
  /** load more dexes (open world); returns the names of the classes they define. The first definition of a name wins (classpath order). */
  add(dexes: DexFile[]): string[] {
    const added: string[] = [];
    for (const dex of dexes) {
      for (let i = 0; i < dex.classDefCount; i++) {
        const def = dex.classDef(i);
        const name = descToName(dex.type(def.typeIdx));
        if (this.classes.has(name)) continue;
        this.classes.set(name, this.build(dex, def, name));
        added.push(name);
      }
    }
    return added;
  }
  private stub(name: string, sup: string | null): JClass {
    const c: JClass = { name, dex: null, def: null, sup, ifaces: [], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map() };
    this.classes.set(name, c); return c;
  }
  /** Classes the compiler's own helpers instantiate; stubbed when the loaded dexes (no framework) lack them. */
  private addRuntimeClasses() {
    const E = "java/lang/", chain: [string, string | null][] = [["Object", null], ["String", "Object"], ["Throwable", "Object"], ["Exception", "Throwable"], ["RuntimeException", "Exception"],
      ["NullPointerException", "RuntimeException"], ["ArithmeticException", "RuntimeException"], ["ClassCastException", "RuntimeException"],
      ["NegativeArraySizeException", "RuntimeException"], ["IndexOutOfBoundsException", "RuntimeException"], ["ArrayIndexOutOfBoundsException", "IndexOutOfBoundsException"],
      ["Error", "Throwable"], ["LinkageError", "Error"], ["UnsatisfiedLinkError", "LinkageError"],
      ["VirtualMachineError", "Error"], ["OutOfMemoryError", "VirtualMachineError"], ["StackOverflowError", "VirtualMachineError"]];
    for (const [n, sup] of chain) if (!this.classes.has(E + n)) this.stub(E + n, sup && E + sup);
  }
  /** statics of library classes without bytecode here: resolvable stubs the compiler replaces with intrinsics */
  addExterns(keys: string[]) {
    for (const key of keys) {
      const [, cls, name, desc] = /^(.*)\.(\w+)(\(.*)$/.exec(key)!;
      if (this.classes.get(cls)?.dex) continue;
      const p = parseMethodDesc(desc);
      const m: MethodInfo = { cls, name, desc, flags: ACC.PUBLIC | ACC.STATIC, dex: null!, methodIdx: -1, codeOff: 0, key: mkey(name, desc), isStatic: true, isCtor: false, params: p.params, ret: p.ret };
      const c = this.classes.get(cls) ?? this.stub(cls, "java/lang/Object");
      c.methods.push(m); c.byKey.set(m.key, m);
    }
  }
  private build(dex: DexFile, def: ClassDef, name: string): JClass {
    const fields: FieldInfo[] = [];
    // ART's Object declares its class and monitor words as fields; here they are the object header
    for (const [list, isStatic] of [[def.staticFields, true], [def.instanceFields, false]] as const) {
      for (const f of name === "java/lang/Object" && !isStatic ? [] : list) {
        const fr = dex.field(f.fieldIdx), desc = dex.type(fr.type);
        fields.push({ owner: name, name: fr.name, desc, kind: kindOf(desc), isStatic, flags: f.flags });
      }
    }
    const methods: MethodInfo[] = [];
    for (const list of [def.directMethods, def.virtualMethods]) for (const m of list) methods.push(this.method(dex, name, m));
    const byKey = new Map(methods.map((m) => [m.key, m]));
    return {
      name, dex, def, sup: def.superIdx === 0xffffffff ? null : descToName(dex.type(def.superIdx)),
      ifaces: def.interfaces.map((t) => descToName(dex.type(t))), flags: def.flags, isInterface: (def.flags & ACC.INTERFACE) !== 0,
      fields, methods, byKey,
    };
  }
  private method(dex: DexFile, cls: string, m: EncodedMethod): MethodInfo {
    const mr = dex.method(m.methodIdx), desc = dex.methodDesc(m.methodIdx), p = parseMethodDesc(desc);
    return { cls, name: mr.name, desc, flags: m.flags, dex, methodIdx: m.methodIdx, codeOff: m.codeOff, key: mkey(mr.name, desc),
      isStatic: (m.flags & ACC.STATIC) !== 0, isCtor: mr.name === "<init>", params: p.params, ret: p.ret };
  }
  get(name: string): JClass | undefined { return this.classes.get(name); }
  require(name: string): JClass { const c = this.classes.get(name); if (!c) throw new Error("class not found: " + name); return c; }
  isSubclass(a: string, b: string): boolean {
    if (a === b) return true;
    const c = this.classes.get(a); if (!c) return false;
    if (c.sup && this.isSubclass(c.sup, b)) return true;
    return c.ifaces.some((i) => this.isSubclass(i, b));
  }
  /** resolve a method declared in `cls` or inherited (superclasses, then interfaces) */
  resolve(cls: string, name: string, desc: string): MethodInfo | undefined {
    const key = mkey(name, desc);
    for (let c: JClass | undefined = this.classes.get(cls); c; c = c.sup ? this.classes.get(c.sup) : undefined) {
      const m = c.byKey.get(key); if (m) return m;
    }
    const seen = new Set<string>();
    const visit = (n: string): MethodInfo | undefined => {
      if (seen.has(n)) return undefined; seen.add(n);
      const c = this.classes.get(n); if (!c) return undefined;
      const m = c.byKey.get(key); if (m && !(m.flags & ACC.STATIC)) return m;
      for (const i of c.ifaces) { const r = visit(i); if (r) return r; }
      return undefined;
    };
    for (let c: JClass | undefined = this.classes.get(cls); c; c = c.sup ? this.classes.get(c.sup) : undefined) {
      for (const i of c.ifaces) { const r = visit(i); if (r) return r; }
    }
    return undefined;
  }
  /** a concrete (non-abstract) implementation of name+desc for runtime class `cls` */
  implFor(cls: string, name: string, desc: string): MethodInfo | undefined {
    const key = mkey(name, desc);
    for (let c: JClass | undefined = this.classes.get(cls); c; c = c.sup ? this.classes.get(c.sup) : undefined) {
      const m = c.byKey.get(key); if (m && !(m.flags & ACC.STATIC) && !(m.flags & ACC.ABSTRACT)) return m;
    }
    // default methods: the most specific one, i.e. none whose interface is a superinterface of another candidate's
    const seen = new Set<string>(), found: MethodInfo[] = [];
    const visit = (n: string) => {
      if (seen.has(n)) return; seen.add(n);
      const c = this.classes.get(n); if (!c) return;
      const m = c.byKey.get(key); if (m && !(m.flags & ACC.STATIC)) { if (!(m.flags & ACC.ABSTRACT)) found.push(m); return; }
      for (const i of c.ifaces) visit(i);
    };
    for (let c: JClass | undefined = this.classes.get(cls); c; c = c.sup ? this.classes.get(c.sup) : undefined) for (const i of c.ifaces) visit(i);
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
      const c = this.classes.get(i); if (!c || out.has(i)) return;
      if (c.methods.some((m) => !m.isStatic && !(m.flags & ACC.ABSTRACT))) out.add(i);
      c.ifaces.forEach(visit);
    };
    for (let c = this.classes.get(cls); c; c = c.sup ? this.classes.get(c.sup) : undefined) c.ifaces.forEach(visit);
    return [...out];
  }
  resolveField(cls: string, name: string, desc: string): FieldInfo | undefined {
    const seen = new Set<string>();
    const visit = (n: string): FieldInfo | undefined => {
      if (seen.has(n)) return undefined; seen.add(n);
      const c = this.classes.get(n); if (!c) return undefined;
      const f = c.fields.find((x) => x.name === name && x.desc === desc); if (f) return f;
      for (const i of c.ifaces) { const r = visit(i); if (r) return r; }
      return c.sup ? visit(c.sup) : undefined;
    };
    return visit(cls);
  }
  /** instance fields in layout order: superclass fields first */
  layout(cls: string): FieldInfo[] {
    const c = this.classes.get(cls); if (!c) return [];
    return [...(c.sup ? this.layout(c.sup) : []), ...c.fields.filter((f) => !f.isStatic)];
  }
  chain(cls: string): string[] { const out: string[] = []; for (let c = this.classes.get(cls); c; c = c.sup ? this.classes.get(c.sup) : undefined) out.push(c.name); return out; }
}
