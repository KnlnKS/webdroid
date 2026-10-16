import { failed, symbolicOverride } from "./linkage.ts";
import type { DexFile } from "../../jvm/dex.ts";
import { ACC, classDefIdx, declaredMethod, mkey, type JClass, type MethodInfo, type Program } from "./program.ts";

/** The direct subtypes of a set of classes, and which of them have a concrete method of a name and descriptor. Built from class headers and method declarations alone, so the
 *  classes' members are not built for it. */
class Index {
  readonly subs = new Map<string, string[]>();                 // direct subtypes (subclasses and implementors)
  private classes: JClass[] = [];
  /** the classes by dex and type id; classes no dex defines (stubs, host and proxy classes) under null */
  private byType?: Map<DexFile | null, Map<number, JClass>>;
  /** each list with the number of classes it was scanned over: an app's classes keep arriving */
  private implementors = new Map<string, { names: string[]; of: number }>();
  add(c: JClass): void {
    this.classes.push(c);
    if (this.byType) this.note(c);
    for (const s of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) { const l = this.subs.get(s); if (l) l.push(c.name); else this.subs.set(s, [c.name]); }
  }
  declaring(key: string): Iterable<string> {
    let found = this.implementors.get(key);
    if (found?.of !== this.classes.length) this.implementors.set(key, found = { names: [...this.scan(key)], of: this.classes.length });
    return found.names;
  }
  private note(c: JClass): void {
    const i = classDefIdx(c), dex = i < 0 ? null : c.dex!;
    let m = this.byType!.get(dex);
    if (!m) this.byType!.set(dex, m = new Map());
    m.set(dex ? dex.classDef2Type(i) : m.size, c);
  }
  /** a class declares its methods with method_ids of its own dex and type: those of the key's name that a class here declares */
  private *scan(key: string): Generator<string> {
    if (!this.byType) { this.byType = new Map(); for (const c of this.classes) this.note(c); }
    const name = key.slice(0, key.indexOf("("));
    for (const [dex, classes] of this.byType) {
      if (!dex) {
        for (const c of classes.values()) { const m = declaredMethod(c, key); if (m && !(m.flags & (ACC.STATIC | ACC.ABSTRACT))) yield c.name; }
        continue;
      }
      const n = dex.findString(name);
      if (n < 0) continue;
      for (const i of dex.methodsNamed(n)) {
        const c = classes.get(dex.method(i).cls);
        if (!c || dex.methodKey(i) !== key) continue;
        const m = dex.declaredAt(classDefIdx(c), i);
        if (m && !(m.flags & (ACC.STATIC | ACC.ABSTRACT))) yield c.name;
      }
    }
  }
}

/** Class-hierarchy analysis over every class the Program knows, so a decision stays valid for classes that are linked later;
 *  a dex added afterwards can still falsify it, which `World.addDexes` checks against the recorded assumptions.
 *  The index of a base Program is built once and kept in the Program, which processes share. */
export class Cha {
  private prog: Program;
  private base: Index[] = [];
  private own = new Index();
  /** answers by decl, then name and descriptor */
  private memo = new Map<string, Map<string, MethodInfo[]>>();
  constructor(prog: Program) {
    this.prog = prog;
    for (let p = prog.base; p; p = p.base) this.base.unshift(sharedIndex(p));
    for (const c of prog.own()) this.own.add(c);
  }

  /** adds classes: the answers that change are those about their supertypes, and about those of classes already here below them (a class can arrive after its subclasses) */
  index(names: Iterable<string>): void {
    const stale = new Set<string>(), below = new Set<string>();
    const up = (n: string): void => {
      if (stale.has(n)) return;
      stale.add(n);
      const c = this.prog.get(n);
      if (c) for (const p of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) up(p);
    };
    const down = (n: string): void => { if (below.has(n)) return; below.add(n); up(n); for (const sub of this.subsOf(n)) down(sub); };
    for (const n of names) this.own.add(this.prog.get(n)!);
    for (const n of names) down(n);
    for (const n of stale) this.memo.delete(n);
  }
  /** the direct subtypes of n, read where they are listed: Object's run to hundreds of thousands in a large app, and a walk takes a few */
  private *subsOf(n: string): Generator<string> {
    for (const b of this.base) { const x = b.subs.get(n); if (x) yield* x; }
    const l = this.own.subs.get(n);
    if (l) yield* l;
  }
  private *declaring(key: string): Generator<string> {
    for (const b of this.base) yield* b.declaring(key);
    yield* this.own.declaring(key);
  }

  /** The distinct implementations a call of decl.name+desc can reach among the concrete subtypes of decl (decl included),
   *  cut off at two: callers only distinguish none, one and many. */
  targets(decl: string, name: string, desc: string): MethodInfo[] {
    const key = mkey(name, desc), memo = this.memo.get(decl) ?? this.memo.set(decl, new Map()).get(decl)!;
    let out = memo.get(key);
    if (out) return out;
    const declared = this.prog.resolve(decl, name, desc), packageMethod = declared && !(declared.flags & (ACC.PUBLIC | ACC.PROTECTED));
    const found = new Set<MethodInfo>(), seen = new Set<string>(), stack: Iterator<string>[] = [[decl].values()];
    // a small hierarchy is walked; a large one (decl = Object) is answered from the methods that can be implementations
    let budget = WALK;
    while (stack.length && found.size < 2 && budget > 0) {
      const next = stack[stack.length - 1].next();
      if (next.done) { stack.pop(); continue; }
      const n = next.value;
      if (seen.has(n)) continue;
      seen.add(n); budget--;
      const c = this.prog.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT)) {
        const m = packageMethod ? symbolicOverride(this.prog, n, declared!) : this.prog.dispatchFor(n, name, desc);
        if (m && failed(m)) { memo.set(key, out = []); return out; }
        if (m) found.add(m);
      }
      stack.push(this.subsOf(n));
    }
    if (budget <= 0 && stack.length && found.size < 2) {
      found.clear();
      if (packageMethod) return [];
      for (const cls of this.declaring(key)) {
        const m = declaredMethod(this.prog.get(cls), key)!;
        const reaches = this.reaches(decl, m);
        if (reaches === "conflict") { memo.set(key, out = []); return out; }
        if (reaches && found.add(m).size >= 2) break;
      }
    }
    memo.set(key, out = [...found]);
    return out;
  }
  /** whether some concrete subtype of decl (decl included) runs `m` for its method of that name and descriptor */
  private reaches(decl: string, m: MethodInfo): boolean | "conflict" {
    const p = this.prog, key = m.key;
    // the subtypes that can run m are subtypes of its class; those of decl are the ones that count
    const [top, filter] = p.isSubclass(m.cls, decl) ? [m.cls, null] : p.isSubclass(decl, m.cls) ? [decl, null] : [m.cls, decl];
    const seen = new Set<string>(), stack: Iterator<string>[] = [[top].values()];
    let reachesAny = false;
    while (stack.length) {
      const next = stack[stack.length - 1].next();
      if (next.done) { stack.pop(); continue; }
      const n = next.value;
      if (seen.has(n)) continue;
      seen.add(n);
      const c = p.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT) && (!filter || p.isSubclass(n, filter))) {
        const target = p.dispatchFor(n, m.name, m.desc);
        if (target && failed(target)) return "conflict";
        if (target === m) {
          if (p.get(m.cls)?.isInterface === false) return true;
          reachesAny = true;
        }
      }
      // a class that implements the method itself decides it for every subclass: none of them runs m
      const own = c && !c.isInterface ? declaredMethod(c, key) : undefined;
      if (own && own !== m && !(own.flags & (ACC.STATIC | ACC.ABSTRACT))) continue;
      stack.push(this.subsOf(n));
    }
    return reachesAny;
  }
}
const WALK = 64;

const sharedIndex = (p: Program): Index => {
  let x = p.shared.get("cha") as Index | undefined;
  if (!x) { p.shared.set("cha", x = new Index()); for (const c of p.own()) x.add(c); }
  return x;
};
