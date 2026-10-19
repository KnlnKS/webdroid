// Whole-program reachability over one or more dex files: what an apk can actually call,
// rather than what its constant pool happens to mention.
//
// Rapid type analysis (Bacon & Sweeney). It is what makes the answer at a virtual or
// interface call site real rather than "not decidable statically": a site (D, sig) reaches
// the implementations of sig on the types some reachable `new-instance` actually creates.
// Interface dispatch — the thing a constant-pool walk cannot speak to at all — falls out of
// the same rule, with no special case.

import { ACC, type DexFile, NO_INDEX, type ClassDef, type EncodedMethod } from "./dex.ts";
import { walkRefs } from "./opcodes.ts";
import { descToName } from "./abi.ts";

/** "cls.name(desc)ret" — the identity a call site and a definition agree on */
type MemberKey = string;

interface ReachResult {
  methods: Set<MemberKey>;            // bodies the analysis walked
  methodCalls: Map<MemberKey, number>; // every reachable invoke site, resolved or not
  instantiated: Set<string>;          // classes a reachable new-instance creates
  classes: Set<string>;               // classes touched at all
  unresolvedMethods: Map<MemberKey, number>;  // call sites that resolved to nothing
  unresolvedFields: Map<MemberKey, number>;
  fieldAccesses: Map<MemberKey, number>; // every reachable field site, resolved or not
  nativeMethods: Map<MemberKey, number>;      // reachable and `native`: the JNI line
  absentClasses: Map<string, number>;         // named by a reachable instruction, defined nowhere
}

interface ClassRec {
  loc: { dex: DexFile; defIdx: number };
  def?: ClassDef;
  own?: Map<string, EncodedMethod>;   // name+desc → declaration, this class only
  fields?: Set<string>;
  supers?: string[];                  // transitive, self excluded
}

/** name+desc of a method ref, memoised per dex: the walk asks for these once per call site */
const sigCaches = new WeakMap<DexFile, (string | undefined)[]>();
function sigOf(dex: DexFile, mIdx: number): string {
  let c = sigCaches.get(dex);
  if (!c) sigCaches.set(dex, (c = []));
  return (c[mIdx] ??= dex.method(mIdx).name + dex.methodDesc(mIdx));
}

/** a type descriptor's class name; arrays reduce to their element, primitives to "" */
function typeName(desc: string): string {
  let i = 0;
  while (desc[i] === "[") i++;
  const e = desc.slice(i);
  return e[0] === "L" ? descToName(e) : "";
}

export class Program {
  private byName = new Map<string, ClassRec>();

  add(dex: DexFile) {
    for (let i = 0; i < dex.classDefCount; i++) {
      const name = dex.typeName(dex.classDef2Type(i));
      if (!this.byName.has(name)) this.byName.set(name, { loc: { dex, defIdx: i } });
    }
  }

  has(name: string): boolean { return this.byName.has(name); }
  get size(): number { return this.byName.size; }
  dexOf(name: string): DexFile | null { return this.byName.get(name)?.loc.dex ?? null; }

  def(name: string): ClassDef | null {
    const rec = this.byName.get(name);
    if (!rec) return null;
    return (rec.def ??= rec.loc.dex.classDef(rec.loc.defIdx));
  }

  private own(name: string): Map<string, EncodedMethod> | null {
    const rec = this.byName.get(name);
    if (!rec) return null;
    if (rec.own) return rec.own;
    const def = this.def(name)!, dex = rec.loc.dex;
    const m = (rec.own = new Map());
    for (const em of def.directMethods) m.set(sigOf(dex, em.methodIdx), em);
    for (const em of def.virtualMethods) m.set(sigOf(dex, em.methodIdx), em);
    return m;
  }

  private superOf(name: string): string | null {
    const rec = this.byName.get(name);
    const def = rec && this.def(name);
    if (!rec || !def || def.superIdx === NO_INDEX) return null;
    return descToName(rec.loc.dex.type(def.superIdx));
  }

  /** every supertype, classes and interfaces, transitively */
  supers(name: string): string[] {
    const rec = this.byName.get(name);
    if (!rec) return [];
    if (rec.supers) return rec.supers;
    rec.supers = [];   // stands in while we recurse, so a malformed cycle terminates
    const def = this.def(name)!, dex = rec.loc.dex;
    const out = new Set<string>();
    const parents = def.interfaces.map((i) => dex.typeName(i));
    const sup = this.superOf(name);
    if (sup) parents.unshift(sup);
    for (const p of parents) {
      out.add(p);
      for (const s of this.supers(p)) out.add(s);
    }
    return (rec.supers = [...out]);
  }

  /** the declaration a call on `start` reaches, walking up as the JVM does */
  resolve(start: string, sig: string): { cls: string; m: EncodedMethod } | null {
    for (let c: string | null = start; c; c = this.superOf(c)) {
      const m = this.own(c)?.get(sig);
      if (m) return { cls: c, m };
    }
    for (const s of this.supers(start)) {          // interface defaults, after the class chain
      const m = this.own(s)?.get(sig);
      if (m?.codeOff) return { cls: s, m };
    }
    return null;
  }

  hasField(start: string, name: string): boolean {
    if (this.declaresField(start, name)) return true;
    for (const c of this.supers(start)) if (this.declaresField(c, name)) return true;
    return false;
  }
  private declaresField(c: string, name: string): boolean {
    const rec = this.byName.get(c);
    const def = rec && this.def(c);
    if (!rec || !def) return false;
    if (!rec.fields) {
      rec.fields = new Set();
      for (const f of def.instanceFields) rec.fields.add(rec.loc.dex.field(f.fieldIdx).name);
      for (const f of def.staticFields) rec.fields.add(rec.loc.dex.field(f.fieldIdx).name);
    }
    return rec.fields.has(name);
  }
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** invoke-virtual and invoke-interface (and their /range forms) dispatch; the other invokes call their target exactly */
const dispatched = (op: number) => op === 0x6e || op === 0x72 || op === 0x74 || op === 0x78;
const splitKey = (k: MemberKey): [string, string] => { const i = k.indexOf("."); return [k.slice(0, i), k.slice(i + 1)]; };

export function reach(p: Program, roots: MemberKey[], rootClasses: string[] = []): ReachResult {
  const r: ReachResult = {
    methods: new Set(), instantiated: new Set(), classes: new Set(),
    methodCalls: new Map(), fieldAccesses: new Map(),
    unresolvedMethods: new Map(), unresolvedFields: new Map(),
    nativeMethods: new Map(), absentClasses: new Map(),
  };
  const work: MemberKey[] = [];
  // the two halves of a virtual site arrive in either order, so each remembers what the
  // other has already seen rather than rescanning
  const sitesBySuper = new Map<string, Set<string>>();    // declared type → sigs called on it
  const instancesBySuper = new Map<string, string[]>();   // declared type → created subtypes

  const addMethod = (cls: string, sig: string) => {
    const k = cls + "." + sig;
    if (!r.methods.has(k)) { r.methods.add(k); work.push(k); }
  };

  function touchClass(name: string) {
    if (!name) return;
    // absent classes count every reference, so the report ranks by how much depends on one
    if (!p.has(name)) { bump(r.absentClasses, name); return; }
    if (r.classes.has(name)) return;
    r.classes.add(name);
    if (p.resolve(name, "<clinit>()V")) addMethod(name, "<clinit>()V");   // first static touch
  }

  function instantiate(name: string) {
    if (r.instantiated.has(name)) return;
    r.instantiated.add(name);
    touchClass(name);
    if (!p.has(name)) return;
    instanceOf(name, name);
    for (const s of p.supers(name)) instanceOf(name, s);
  }
  function instanceOf(name: string, s: string) {
    let list = instancesBySuper.get(s);
    if (!list) instancesBySuper.set(s, (list = []));
    list.push(name);
    const sigs = sitesBySuper.get(s);
    if (sigs) for (const sig of sigs) {
      const hit = p.resolve(name, sig);
      if (hit?.m.codeOff) addMethod(hit.cls, sig);
    }
  }

  function noteDecl(cls: string, sig: string) {
    bump(r.methodCalls, cls + "." + sig);
    const hit = p.resolve(cls, sig);
    if (!hit) { bump(r.unresolvedMethods, cls + "." + sig); return null; }
    if (!hit.m.codeOff && hit.m.flags & ACC.NATIVE) bump(r.nativeMethods, hit.cls + "." + sig);
    return hit;
  }

  function virtualSite(declared: string, sig: string) {
    touchClass(declared);
    let sigs = sitesBySuper.get(declared);
    if (!sigs) sitesBySuper.set(declared, (sigs = new Set()));
    if (sigs.has(sig)) return;
    sigs.add(sig);
    for (const t of instancesBySuper.get(declared) ?? []) {
      const hit = p.resolve(t, sig);
      if (hit?.m.codeOff) addMethod(hit.cls, sig);
    }
    noteDecl(declared, sig);   // the declared type may hold the only body, or a native
  }

  function exactSite(cls: string, sig: string) {
    touchClass(cls);
    const hit = noteDecl(cls, sig);
    if (hit?.m.codeOff) addMethod(hit.cls, sig);
  }

  for (const c of rootClasses) instantiate(c);
  for (const k of roots) addMethod(...splitKey(k));

  while (work.length) {
    const hit = p.resolve(...splitKey(work.pop()!));
    if (!hit?.m.codeOff) continue;
    const dex = p.dexOf(hit.cls)!;
    walkRefs(dex.code(hit.m.codeOff), {
      invoke(op, mIdx) {
        const owner = typeName(dex.type(dex.method(mIdx).cls));
        if (owner) (dispatched(op) ? virtualSite : exactSite)(owner, sigOf(dex, mIdx));
      },
      type(op, idx) {
        const t = typeName(dex.type(idx));
        if (op === 0x22 && p.has(t)) instantiate(t); else touchClass(t);
      },
      field(_, idx) {
        const f = dex.field(idx), owner = typeName(dex.type(f.cls));
        touchClass(owner);
        if (owner) bump(r.fieldAccesses, owner + "." + f.name);
        if (owner && (!p.has(owner) || !p.hasField(owner, f.name))) bump(r.unresolvedFields, owner + "." + f.name);
      },
    });
  }

  return r;
}

/** The methods `roots` call when they run, breadth first and at most `limit`: each call's target
 *  as its site declares it (a virtual call's declared class, without dispatch to subclasses) and
 *  the static initializers of the classes they touch. A compile worker emits them in this order
 *  after an APK's profile (docs/architecture.md, code delivery). */
/** a method a closure starts from: its class and name+descriptor */
export type MethodRoot = { cls: string; sig: string };
export function callClosure(p: Program, roots: MethodRoot[], limit: number): { cls: string; dex: DexFile; methodIdx: number }[] {
  const seen = new Set<string>(), touched = new Set<string>(), out: { cls: string; dex: DexFile; methodIdx: number }[] = [];
  let next: { cls: string; m: EncodedMethod }[] = [];
  const add = (cls: string, sig: string, root = false) => {
    const hit = p.resolve(cls, sig);
    if (!hit?.m.codeOff || seen.has(hit.cls + "." + sig)) return;
    seen.add(hit.cls + "." + sig);
    if (!root) out.push({ cls: hit.cls, dex: p.dexOf(hit.cls)!, methodIdx: hit.m.methodIdx });
    next.push(hit);
  };
  const touch = (cls: string) => {
    if (cls && !touched.has(cls)) { touched.add(cls); add(cls, "<clinit>()V"); }
  };
  for (const { cls, sig } of roots) add(cls, sig, true);
  while (next.length && out.length < limit) {
    const level = next;
    next = [];
    for (const { cls, m } of level) {
      const dex = p.dexOf(cls)!;
      touch(cls);
      walkRefs(dex.code(m.codeOff), {
        invoke(op, idx) {
          const owner = typeName(dex.type(dex.method(idx).cls));
          if (op === 0x71 || op === 0x77) touch(owner);
          add(owner, sigOf(dex, idx));
        },
        type(op, idx) { if (op === 0x22) touch(typeName(dex.type(idx))); },
        // sget/sput
        field(op, idx) { if (op >= 0x60) touch(typeName(dex.type(dex.field(idx).cls))); },
      });
    }
  }
  return out.slice(0, limit);
}
