import { ACC, mkey, type MethodInfo, type Program } from "./program";

/** Class-hierarchy analysis over every class the Program knows, so a decision stays valid for classes that are linked later;
 *  a dex added afterwards can still falsify it, which `World.addDexes` checks against the recorded assumptions. */
export class Cha {
  private subs = new Map<string, string[]>();                 // direct subtypes (subclasses and implementors)
  private memo = new Map<string, MethodInfo[]>();
  /** every method that can be an implementation (not static, not abstract), by name+descriptor */
  private impls = new Map<string, MethodInfo[]>();
  constructor(private prog: Program) { this.index(prog.classes.keys()); }

  index(names: Iterable<string>): void {
    for (const n of names) {
      const c = this.prog.get(n)!;
      for (const m of c.methods) if (!(m.flags & (ACC.STATIC | ACC.ABSTRACT))) { const l = this.impls.get(m.key); if (l) l.push(m); else this.impls.set(m.key, [m]); }
      for (const s of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) { const l = this.subs.get(s); if (l) l.push(n); else this.subs.set(s, [n]); }
    }
    this.memo.clear();
  }

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
      const l = this.subs.get(n); if (l) stack.push(...l);
    }
    if (budget <= 0 && stack.length && found.size < 2) {
      found.clear();
      for (const m of this.impls.get(mkey(name, desc)) ?? []) {
        if (found.size >= 2) break;
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
      const l = this.subs.get(n); if (l) stack.push(...l);
    }
    return false;
  }
}
const WALK = 64;
