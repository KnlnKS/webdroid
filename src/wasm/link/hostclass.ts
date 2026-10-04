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
import { ACC, type JClass, type MethodInfo } from "../compiler/program";
import type { Intrinsic } from "../compiler/j2w";
import { parseMethodDesc } from "../../jvm/abi";
import { HOSTED, type HostSpec } from "./hostapi";
import type { World } from "./world";

const OBJECT = "java/lang/Object", STATIC = "static ";

/** the method `key` ("name(desc)ret", with "static " for a static one) as a native of class `cls` */
function native(cls: string, key: string, index: number): MethodInfo {
  const isStatic = key.startsWith(STATIC), k = isStatic ? key.slice(STATIC.length) : key, at = k.indexOf("("), name = k.slice(0, at), desc = k.slice(at), p = parseMethodDesc(desc);
  return { cls, name, desc, flags: ACC.PUBLIC | ACC.NATIVE | (isStatic ? ACC.STATIC : 0), dex: null!, methodIdx: -1, codeOff: 0, key: k, isStatic, isCtor: name === "<init>", params: p.params, ret: p.ret, index };
}
const classOf = (name: string, sup: string, ifaces: string[], flags: number): JClass =>
  ({ name, dex: null, def: null, sup, ifaces, flags, isInterface: false, fields: [], methods: [], byKey: new Map() });

export class HostClasses {
  private pending = new Map<string, HostSpec>();
  private defined = new Map<string, HostSpec>();
  private byCtor = new Map<Function, HostSpec>();
  private chain = new Map<string, HostSpec | null>();
  private hosts = new WeakMap<object, object>();
  private shells = new WeakMap<object, object>();
  private settling = false;
  constructor(private w: World) {}

  add(spec: HostSpec): void {
    this.byCtor.set(spec.ctor, spec); this.pending.set(spec.name, spec);
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
      if (have.isInterface) return true;
      // the methods a superclass declares are found through the whole chain
      for (let c: JClass | undefined = have; c?.sup; c = prog.get(c.sup)) if (!prog.get(c.sup)) return false;
      this.overlay(have, spec);
      return true;
    }
    if (have) return true;
    const known = (n: string) => !!prog.get(n);
    if (!known(spec.sup ?? OBJECT) || !spec.ifaces.every(known)) return false;
    this.synthesize(spec);
    return true;
  }

  /** a class of natives */
  private synthesize(spec: HostSpec): void {
    const sup = spec.sup ?? OBJECT, jc = classOf(spec.name, sup, spec.ifaces, ACC.PUBLIC), bodies = new Map<MethodInfo, Intrinsic>();
    for (const key of spec.methods) { const m = native(spec.name, key, jc.methods.length); jc.methods.push(m); jc.byKey.set(m.key, m); }
    // the constructor Java finds when the spec declares none is the superclass's, as it is for the object the JS tier makes
    if (!jc.byKey.has("<init>()V")) {
      const m = native(spec.name, "<init>()V", jc.methods.length);
      m.flags = ACC.PUBLIC;
      jc.methods.push(m); jc.byKey.set(m.key, m);
      bodies.set(m, (cx, _m, c) => { const init = cx.prog.resolve(sup, "<init>", "()V"); if (init) { c.lget(0); cx.callMethod(c, init); } });
    }
    this.w.addClass(jc, bodies);
  }

  /** the natives of `spec` take the place of the methods of the dex class `jc` they name, in a class of this World's Program that stands for it: the platform's own classes, which
   *  Worlds share, are not changed. Methods keep their positions, so ids, slots and the AOT build's numbering are the platform's. */
  private overlay(jc: JClass, spec: HostSpec): void {
    const prog = this.w.prog, hosted = classOf(spec.name + HOSTED, OBJECT, [], ACC.PUBLIC | ACC.ABSTRACT);
    const over: JClass = { name: jc.name, dex: jc.dex, def: jc.def, sup: jc.sup, ifaces: jc.ifaces, flags: jc.flags, isInterface: false, fields: jc.fields, methods: jc.methods.map((m) => ({ ...m })), byKey: new Map() };
    for (const m of over.methods) over.byKey.set(m.key, m);
    const taken: MethodInfo[] = [];
    for (const key of spec.methods) {
      const m = native(spec.name, key, 0), own = over.byKey.get(m.key);
      if (own && own.isStatic === m.isStatic) { own.flags &= ~ACC.ABSTRACT; own.codeOff = 0; taken.push(own); continue; }
      // a method a superclass declares: the class resolves it in `hosted`, where the spec's native is
      const up = !m.isCtor && prog.resolve(spec.name, m.name, m.desc);
      if (!up || up.isStatic !== m.isStatic) continue;
      m.cls = hosted.name; m.index = hosted.methods.length;
      hosted.methods.push(m); over.byKey.set(m.key, m);
    }
    this.w.addClass(over, new Map());
    for (const m of taken) this.w.aot?.override(m);
    if (hosted.methods.length) this.w.addClass(hosted, new Map());
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
