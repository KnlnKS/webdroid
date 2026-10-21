// Classes the host implements: the registered specs (rt.register) outside the VM's own classes, which stay TS. A Java object of such a class, or of a
// bytecode subclass of it, has a host object (an instance of the spec's TS class) beside it, and the two are one object to both sides: the natives of
// the spec take the host object as `this`, a host object that crosses to Java is the Java object it was made with, and each keeps the other alive
// exactly as long as it lives itself (two ephemeron tables, no strong edge between them).
//
//  - A spec whose class no dex defines becomes a Java class of natives (World.addClass) once its superclass and interfaces exist.
//  - A spec whose class a dex defines (the TLS and HTTP boundary) replaces the bodies of the methods that class declares, and puts the methods it
//    inherits from a superclass in a class of their own that the class resolves them in. The class keeps its members, so ids and slots stay put.
//  - The host object is made when a native first needs it (host/bridge.ts): a Java object that Java code allocated, as a bytecode subclass does,
//    gets its host object at its first host call, which is its constructor.
import { ACC, PlainClass, codelessMethod, type JClass, type Loader, type MethodInfo, type Program } from "../compiler/program.ts";
import type { Intrinsic } from "../compiler/j2w.ts";
import { HOSTED, type HostSpec } from "./hostapi.ts";
import type { World } from "./world.ts";

const OBJECT = "java/lang/Object", STATIC = "static ", SHELL = "$$shell", CLINIT = "<clinit>()V";

/** the method `key` ("name(desc)ret", with "static " for a static one) as a native of class `cls` */
function native(cls: string, key: string, index: number): MethodInfo {
  const isStatic = key.startsWith(STATIC), k = isStatic ? key.slice(STATIC.length) : key, at = k.indexOf("(");
  return codelessMethod(cls, k.slice(0, at), k.slice(at), ACC.PUBLIC | ACC.NATIVE | (isStatic ? ACC.STATIC : 0), index);
}
/** whether `spec` takes the place of methods of its dex class `jc` (overlay), rather than standing for an interface with a class of natives (javaClass) */
const overlays = (jc: JClass, spec: HostSpec): boolean => !jc.isInterface || !!spec.statics;
/** the methods of dex class `jc` whose code the natives of `spec` replace */
function hostTakes(jc: JClass, spec: HostSpec): MethodInfo[] {
  if (!overlays(jc, spec)) return [];
  const clinit = jc.byKey.get(CLINIT), out = clinit && !spec.platformClinit ? [clinit] : [];
  if (!jc.isInterface) for (const key of spec.methods) { const m = native(spec.name, key, 0), own = jc.byKey.get(m.key); if (own && own.isStatic === m.isStatic) out.push(own); }
  return out;
}
/** what defining `specs` takes from the code of `prog`'s classes: the methods whose code the host replaces, and the instance methods (name+descriptor) each spec's
 *  class implements, which its objects run even where the class inherits them, since overlay gives it their natives (HostClasses.mayReach) */
export function hostTakeover(prog: Program, specs: readonly HostSpec[]): { taken: MethodInfo[]; implemented: [string, string[]][] } {
  const taken: MethodInfo[] = [], implemented: [string, string[]][] = [];
  for (const spec of specs) {
    const jc = prog.get(spec.name), keys = spec.methods.filter((k) => !k.startsWith(STATIC) && k[0] !== "<");
    if (jc?.dex) taken.push(...hostTakes(jc, spec));
    if (keys.length) implemented.push([spec.name, keys]);
  }
  return { taken, implemented };
}
/** the keys of each value of `entries`, by value */
function invert(entries: Iterable<[string, string[]]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, vs] of entries) for (const v of vs) (out.get(v) ?? out.set(v, []).get(v)!).push(k);
  return out;
}
export class HostClasses {
  private w: World;
  private pending = new Map<string, HostSpec>();
  private defined = new Map<string, HostSpec>();
  private byCtor = new Map<Function, HostSpec>();
  private specs = new Map<string, HostSpec>();
  private chain = new Map<string, HostSpec | null>();
  private hosts = new WeakMap<object, object>();
  private shells = new WeakMap<object, object>();
  private settling = false;
  /** what the host takes from compiled code, which only a build knows whole (a split bundle registers some specs late): the spec classes that implement each
   *  instance method (hostTakeover), and the slots of the methods whose code the host replaces */
  private takeover?: { keys: Map<string, string[]>; slots: Set<number> };
  constructor(w: World) { this.w = w; }

  /** takes what a build says the host takes: the instance methods of each spec class (hostTakeover's `implemented`) and the slots of the methods it replaces */
  adoptTakeover(implemented: Iterable<[string, string[]]>, slots: Iterable<number>): void { this.takeover = { keys: invert(implemented), slots: new Set(slots) }; }
  /** the takeover as a build's index records it */
  takeoverRecord(): { hostKeys: [string, string[]][]; overridden: number[] } {
    return { hostKeys: [...invert(this.takeover?.keys ?? [])], overridden: [...this.takeover?.slots ?? []].sort((x, y) => x - y) };
  }
  /** the host implements `m`: a build's code for it is not to be used */
  take(m: MethodInfo): void { const base = this.w.slots.baseOf(m.cls); if (base !== undefined) this.takeover?.slots.add(base + m.index); }
  /** the slots whose build code the host took over */
  taken(): ReadonlySet<number> { return this.takeover?.slots ?? new Set(); }
  /** whether the host may take the code of `m`, as it may any without a build */
  takes(m: MethodInfo): boolean { return !this.takeover || this.takeover.slots.has(this.w.slotOf(m)); }
  /** whether a call of `t` through `decl` may reach a host spec's native: a spec of a class related to `decl` below `t`'s implements it, or one of a class this
   *  World does not have, which may be any; without a build, any call may */
  mayReach(decl: string, t: MethodInfo): boolean {
    if (!this.takeover) return true;
    const prog = this.w.prog;
    return !!this.takeover.keys.get(t.key)?.some((s) => !prog.get(s) || prog.isSubclass(s, t.cls) && (prog.isSubclass(s, decl) || prog.isSubclass(decl, s)));
  }

  add(spec: HostSpec): void {
    this.byCtor.set(spec.ctor, spec); this.pending.set(spec.name, spec); this.specs.set(spec.name, spec);
    this.settle();
  }
  /** classes arrived: a spec waiting for its superclass may be defined now */
  loaded(): void { if (this.pending.size) this.settle(); }
  private settle(): void {
    if (this.settling) return;
    this.settling = true;
    try {
      for (let progress = true; progress;) {
        progress = false;
        for (const spec of [...this.pending.values()]) if (this.define(spec)) { this.pending.delete(spec.name); this.defined.set(spec.name, spec); this.chain.clear(); progress = true; }
      }
    } finally { this.settling = false; }
  }
  private define(spec: HostSpec): boolean {
    const prog = this.w.prog, have = prog.get(spec.name);
    if (have?.dex) {
      if (!overlays(have, spec)) { this.javaClass(spec); return true; }
      // the methods a superclass declares are found through the whole chain
      for (let c: JClass | undefined = have; c?.sup; c = prog.get(c.sup)) if (!prog.get(c.sup)) return false;
      this.overlay(have, spec);
      // made now, not at the first object: code that runs while one is made has already decided what the abstract class's concrete subclasses implement
      if (have.flags & ACC.ABSTRACT) this.javaClass(spec);
      return true;
    }
    if (have) return true;
    const known = (n: string) => !!prog.get(n);
    if (!known(spec.sup ?? OBJECT) || !spec.ifaces.every(known)) return false;
    this.synthesize(spec);
    return true;
  }

  /** the Java class a host object of `spec` is an instance of: the class itself, or where the spec stands for an interface (EGL10) a class of natives that implements it, with the
   *  methods of the specs up its chain, or where it stands for an abstract class (EGLContext) a concrete subclass, which class-hierarchy analysis sees as the class the host
   *  instantiates instead of taking the bytecode subclasses for the only implementations */
  javaClass(spec: HostSpec): string {
    const jc = this.w.prog.get(spec.name), iface = !!jc?.isInterface;
    if (!iface && !(jc && jc.flags & ACC.ABSTRACT)) return spec.name;
    const name = spec.name + (iface ? HOSTED : SHELL);
    if (!this.w.prog.get(name)) {
      const methods = new Set<string>();
      if (iface) for (let s: HostSpec | undefined = spec; s; s = s.sup ? this.specs.get(s.sup) : undefined) for (const key of s.methods) if (!key.startsWith(STATIC)) methods.add(key);
      this.synthesize({ ...spec, name, sup: iface ? null : spec.name, ifaces: iface ? [spec.name] : [], methods: [...methods] }, this.w.prog.base?.get(spec.name)?.dex ? this.w.prog.boot : this.w.prog.loaderOf(spec.name));
      if (iface) this.defined.set(name, spec);
    }
    return name;
  }
  private changed: { cls: string; keys: string[] }[] = [];
  /** the vtable entries of class `name` that a vtable made before the host classes (a class module of the platform build) has wrong: the virtual methods the specs took over or moved
   *  to another class, as [index in the vtable, slot] */
  vtableRepairs(name: string): [number, number][] {
    const prog = this.w.prog, out: [number, number][] = [];
    for (const { cls, keys } of this.changed) {
      if (name === cls || !prog.get(name)?.isInterface && prog.isSubclass(name, cls)) for (const key of keys) {
        const at = key.indexOf("("), m = prog.implFor(name, key.slice(0, at), key.slice(at));
        if (m) out.push([this.w.dispatch.vslot(name, key), this.w.slotOf(m)]);
      }
    }
    return out;
  }
  /** a class of natives */
  private synthesize(spec: HostSpec, loader?: Loader): void {
    const sup = spec.sup ?? OBJECT, jc = new PlainClass(spec.name, sup, spec.ifaces, ACC.PUBLIC), bodies = new Map<MethodInfo, Intrinsic>();
    for (const key of spec.methods) jc.add(native(spec.name, key, jc.methods.length));
    // the constructor Java finds when the spec declares none is the superclass's
    if (!jc.byKey.has("<init>()V")) {
      const m = native(spec.name, "<init>()V", jc.methods.length);
      m.flags = ACC.PUBLIC;
      jc.add(m);
      bodies.set(m, (cx, _m, c) => { const init = cx.prog.resolve(sup, "<init>", "()V"); if (init) { c.lget(0); cx.callMethod(c, init); } });
    }
    const owner = loader ?? (this.w.prog.loaderOf(spec.name).id ? this.w.prog.loaderOf(spec.name) : this.w.prog.boot);
    this.addClass(jc, bodies, owner);
  }
  /** adds class `jc` of natives: a compile worker settling on the same dexes makes it from the same specs, but not one made later (for a host object, javaClass) */
  private addClass(jc: JClass, bodies: Map<MethodInfo, Intrinsic>, loader?: Loader): void {
    this.w.defineClass(jc, bodies, loader, this.settling ? undefined : (s) => s.retire(`class ${jc.name} was added without a dex`));
  }

  /** the natives of `spec` take the place of the methods of the dex class `jc` they name, in a class of this World's Program that stands for it: the platform's own classes, which
   *  Worlds share, are not changed. Methods keep their positions, so ids, slots and the AOT build's numbering are the platform's. */
  private overlay(jc: JClass, spec: HostSpec): void {
    const prog = this.w.prog, hosted = new PlainClass(spec.name + HOSTED, OBJECT, [], ACC.PUBLIC | ACC.ABSTRACT);
    const over = new PlainClass(jc.name, jc.sup, jc.ifaces, jc.flags, jc.methods.map((m) => ({ ...m })), jc.fields, jc.dex, jc.def);
    const taken = hostTakes(jc, spec).map((m) => over.byKey.get(m.key)!), virtual: string[] = [], bodies = new Map<MethodInfo, Intrinsic>();
    for (const own of taken) {
      if (own.key !== CLINIT) { own.flags &= ~ACC.ABSTRACT; own.codeOff = 0; if (!own.isStatic && !own.isCtor) virtual.push(own.key); continue; }
      // a class a spec implements is initialized without its `<clinit>`: with the values the spec names, if any. The platform build's class module runs the `<clinit>`
      // slot in its `ensure`: the slot is the host's, and does nothing unless the spec names values
      if (!spec.platformClinit) { own.flags |= ACC.NATIVE; own.codeOff = 0; }
      if (!spec.statics || spec.platformClinit) bodies.set(own, () => {});
    }
    // an interface keeps its abstract methods: the objects that implement them are of a class of natives (javaClass)
    for (const key of jc.isInterface ? [] : spec.methods) {
      const m = native(spec.name, key, 0), own = over.byKey.get(m.key);
      if (own && own.isStatic === m.isStatic) continue;
      // a method a superclass declares: the class resolves it in `hosted`, where the spec's native is
      const up = !m.isCtor && prog.resolve(spec.name, m.name, m.desc);
      if (!up || up.isStatic !== m.isStatic) continue;
      m.cls = hosted.name; m.index = hosted.methods.length;
      hosted.methods.push(m); over.byKey.set(m.key, m);
      if (!m.isStatic) virtual.push(m.key);
    }
    this.addClass(over, bodies);
    if (virtual.length) { this.changed.push({ cls: jc.name, keys: virtual }); this.w.classModules.repairLinked(); }
    for (const m of taken) this.take(m);
    if (hosted.methods.length) this.addClass(hosted, new Map(), prog.base?.get(jc.name)?.dex ? prog.boot : prog.loaderOf(jc.name));
  }

  /** the spec that implements class `cls` or its nearest superclass */
  specOf(cls: string): HostSpec | undefined {
    let spec = this.chain.get(cls);
    if (spec === undefined) {
      const c = this.w.prog.get(cls);
      this.chain.set(cls, spec = this.defined.get(cls) ?? (c?.sup && cls[0] !== "[" ? this.specOf(c.sup) ?? null : null));
    }
    return spec ?? undefined;
  }
  /** the fields that the specs of class `cls` and its superclasses share with Java, nearest first, as (Java name, host property) */
  fieldsOf(cls: string): [string, string][] {
    const out: [string, string][] = [];
    for (let c = this.w.prog.get(cls); c; c = c.sup ? this.w.prog.get(c.sup) : undefined) out.push(...this.defined.get(c.name)?.fields ?? []);
    return out;
  }
  /** the spec whose class a host object is an instance of (the nearest registered class up its prototype chain) */
  specOfHost(host: object): HostSpec | undefined {
    for (let c = host.constructor as Function | null; c && c !== Object; c = Object.getPrototypeOf(c)) { const s = this.byCtor.get(c); if (s) return s; }
    return undefined;
  }

  hostOf(java: object): object | undefined { return this.hosts.get(java); }
  shellOf(host: object): object | undefined { return this.shells.get(host); }
  bind(java: object, host: object): void { this.hosts.set(java, host); this.shells.set(host, java); }
}
