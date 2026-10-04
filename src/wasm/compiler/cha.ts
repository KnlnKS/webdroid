import { ACC, declaredMethods, mkey, type JClass, type MethodInfo, type Program } from "./program";

/** The direct subtypes of a set of classes, and which of them have a concrete method of a name and descriptor. Built from class headers and method declarations alone, so the
 *  classes' members are not built for it. */
class Index {
  readonly subs = new Map<string, string[]>();                 // direct subtypes (subclasses and implementors)
  private classes: JClass[] = [];
  /** every method that can be an implementation (not static, not abstract), by name+descriptor: the classes that declare one. Built on first use. */
  private implementors?: Map<string, string | string[]>;
  add(c: JClass): void {
    this.classes.push(c);
    for (const s of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) { const l = this.subs.get(s); if (l) l.push(c.name); else this.subs.set(s, [c.name]); }
    if (this.implementors) this.declare(c);
  }
  declaring(key: string): string[] {
    if (!this.implementors) { this.implementors = new Map(); for (const c of this.classes) this.declare(c); }
    const l = this.implementors.get(key);
    return l === undefined ? [] : typeof l === "string" ? [l] : l;
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
  private declaring(key: string): string[] { return [...this.base.flatMap((b) => b.declaring(key)), ...this.own.declaring(key)]; }

  /** The distinct implementations a call of decl.name+desc can reach among the concrete subtypes of decl (decl included),
   *  cut off at two: callers only distinguish none, one and many. */
  targets(decl: string, name: string, desc: string): MethodInfo[] {
    const key = decl + "\0" + mkey(name, desc);
    let out = this.memo.get(key);
    if (out) return out;
    const found = new Set<MethodInfo>(), seen = new Set<string>(), stack = [decl];
    // a small hierarchy is walked; a large one (decl = Object) is answered from the methods that can be implementations
    let budget = WALK;
    while (stack.length && found.size < 2 && budget > 0) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n); budget--;
      const c = this.prog.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT)) { const m = this.prog.implFor(n, name, desc); if (m) found.add(m); }
      stack.push(...this.subsOf(n));
    }
    if (budget <= 0 && stack.length && found.size < 2) {
      found.clear();
      const key = mkey(name, desc);
      for (const cls of this.declaring(key)) {
        if (found.size >= 2) break;
        const m = this.prog.get(cls)!.byKey.get(key)!;
        if (this.reaches(decl, m)) found.add(m);
      }
    }
    this.memo.set(key, out = [...found]);
    return out;
  }
  /** whether some concrete subtype of decl (decl included) runs `m` for its method of that name and descriptor */
  private reaches(decl: string, m: MethodInfo): boolean {
    const p = this.prog, key = m.key;
    // the subtypes that can run m are subtypes of its class; those of decl are the ones that count
    const [top, filter] = p.isSubclass(m.cls, decl) ? [m.cls, null] : p.isSubclass(decl, m.cls) ? [decl, null] : [decl, m.cls];
    const seen = new Set<string>(), stack = [top];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const c = p.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT) && (!filter || p.isSubclass(n, filter)) && p.implFor(n, key.slice(0, key.indexOf("(")), key.slice(key.indexOf("("))) === m) return true;
      stack.push(...this.subsOf(n));
    }
    return false;
  }
}
const WALK = 64;

const sharedIndex = (p: Program): Index => {
  let x = p.shared.get("cha") as Index | undefined;
  if (!x) { p.shared.set("cha", x = new Index()); for (const c of p.own()) x.add(c); }
  return x;
};
