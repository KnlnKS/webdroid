import { failed, symbolicOverride } from "./linkage";
import type { DexFile } from "../../jvm/dex";
import { ACC, classDefIdx, declaredMethod, declaredMethods, mkey, type JClass, type MethodInfo, type Program } from "./program";

/** The direct subtypes of a set of classes, and which of them have a concrete method of a name and descriptor. Built from class headers and method declarations alone, so the
 *  classes' members are not built for it. */
class Index {
  readonly subs = new Map<string, string[]>();                 // direct subtypes (subclasses and implementors)
  private classes: JClass[] = [];
  /** the classes by dex and type id; classes no dex defines (stubs, host and proxy classes) under null */
  private byType?: Map<DexFile | null, Map<number, JClass>>;
  /** every method that can be an implementation (not static, not abstract), by name+descriptor: the classes that declare one */
  private implementors?: Map<string, string | string[]>;
  /** the full index decodes every method of every class (about 200 ms for the platform); until MAX_SCANS keys were asked for, a key is answered from the dexes' ids instead */
  private scans = 0;
  add(c: JClass): void {
    this.classes.push(c);
    if (this.byType) this.note(c);
    for (const s of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) { const l = this.subs.get(s); if (l) l.push(c.name); else this.subs.set(s, [c.name]); }
    if (this.implementors) this.declare(c);
  }
  declaring(key: string): Iterable<string> {
    if (!this.implementors && this.scans++ < MAX_SCANS) return this.scan(key);
    if (!this.implementors) { this.implementors = new Map(); for (const c of this.classes) this.declare(c); }
    const l = this.implementors.get(key);
    return l === undefined ? [] : typeof l === "string" ? [l] : l;
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
  private declare(c: JClass): void {
    for (const [key, flags] of declaredMethods(c)) if (!(flags & (ACC.STATIC | ACC.ABSTRACT))) {
      // most keys have one declaring class: no array for them
      const l = this.implementors!.get(key);
      if (l === undefined) this.implementors!.set(key, c.name); else if (typeof l === "string") this.implementors!.set(key, [l, c.name]); else l.push(c.name);
    }
  }
}

/** Class-hierarchy analysis over every class the Program knows, so a decision stays valid for classes that are linked later;
 *  a dex added afterwards can still falsify it, which `World.addDexes` checks against the recorded assumptions.
 *  The index of a base Program is built once and kept in the Program, which processes share. */
export class Cha {
  private base: Index[] = [];
  private own = new Index();
  private memo = new Map<string, MethodInfo[]>();
  constructor(private prog: Program) {
    for (let p = prog.base; p; p = p.base) this.base.unshift(sharedIndex(p));
    for (const c of prog.own()) this.own.add(c);
  }

  index(names: Iterable<string>): void {
    for (const n of names) this.own.add(this.prog.get(n)!);
    this.memo.clear();
  }
  private subsOf(n: string): string[] {
    const l = this.own.subs.get(n);
    let out = l;
    for (const b of this.base) { const x = b.subs.get(n); if (x) out = out ? [...x, ...out] : x; }
    return out ?? [];
  }
  private *declaring(key: string): Generator<string> {
    for (const b of this.base) yield* b.declaring(key);
    yield* this.own.declaring(key);
  }

  /** The distinct implementations a call of decl.name+desc can reach among the concrete subtypes of decl (decl included),
   *  cut off at two: callers only distinguish none, one and many. */
  targets(decl: string, name: string, desc: string): MethodInfo[] {
    const key = decl + "\0" + mkey(name, desc);
    let out = this.memo.get(key);
    if (out) return out;
    const declared = this.prog.resolve(decl, name, desc), packageMethod = declared && !(declared.flags & (ACC.PUBLIC | ACC.PROTECTED));
    const found = new Set<MethodInfo>(), seen = new Set<string>(), stack = [decl];
    // a small hierarchy is walked; a large one (decl = Object) is answered from the methods that can be implementations
    let budget = WALK;
    while (stack.length && found.size < 2 && budget > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n); budget--;
      const c = this.prog.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT)) {
        const m = packageMethod ? symbolicOverride(this.prog, n, declared!) : this.prog.dispatchFor(n, name, desc);
        if (m && failed(m)) { this.memo.set(key, out = []); return out; }
        if (m) found.add(m);
      }
      for (const sub of this.subsOf(n)) stack.push(sub);
    }
    if (budget <= 0 && stack.length && found.size < 2) {
      found.clear();
      if (packageMethod) return [];
      const methodKey = mkey(name, desc);
      for (const cls of this.declaring(methodKey)) {
        const m = declaredMethod(this.prog.get(cls), methodKey)!;
        const reaches = this.reaches(decl, m);
        if (reaches === "conflict") { this.memo.set(key, out = []); return out; }
        if (reaches && found.add(m).size >= 2) break;
      }
    }
    this.memo.set(key, out = [...found]);
    return out;
  }
  /** whether some concrete subtype of decl (decl included) runs `m` for its method of that name and descriptor */
  private reaches(decl: string, m: MethodInfo): boolean | "conflict" {
    const p = this.prog, key = m.key;
    // the subtypes that can run m are subtypes of its class; those of decl are the ones that count
    const [top, filter] = p.isSubclass(m.cls, decl) ? [m.cls, null] : p.isSubclass(decl, m.cls) ? [decl, null] : [m.cls, decl];
    const seen = new Set<string>(), stack = [top];
    let reachesAny = false;
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const c = p.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT) && (!filter || p.isSubclass(n, filter))) {
        const target = p.dispatchFor(n, m.name, m.desc);
        if (target && failed(target)) return "conflict";
        if (target === m) reachesAny = true;
      }
      // a class that implements the method itself decides it for every subclass: none of them runs m
      const own = c && !c.isInterface ? declaredMethod(c, key) : undefined;
      if (own && own !== m && !(own.flags & (ACC.STATIC | ACC.ABSTRACT))) continue;
      for (const sub of this.subsOf(n)) stack.push(sub);
    }
    return reachesAny;
  }
}
const WALK = 64, MAX_SCANS = 128;

const sharedIndex = (p: Program): Index => {
  let x = p.shared.get("cha") as Index | undefined;
  if (!x) { p.shared.set("cha", x = new Index()); for (const c of p.own()) x.add(c); }
  return x;
};
