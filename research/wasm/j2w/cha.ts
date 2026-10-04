import { ACC, mkey, type MethodInfo, type Program } from "./program";

/** Class-hierarchy analysis over every class the Program knows, so a decision stays valid for classes that are linked later;
 *  a dex added afterwards can still falsify it, which `World.addDexes` checks against the recorded assumptions. */
export class Cha {
  private subs = new Map<string, string[]>();                 // direct subtypes (subclasses and implementors)
  private memo = new Map<string, MethodInfo[]>();
  constructor(private prog: Program) { this.index(prog.classes.keys()); }

  index(names: Iterable<string>): void {
    for (const n of names) {
      const c = this.prog.get(n)!;
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
    while (stack.length && found.size < 2) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const c = this.prog.get(n);
      if (c && !c.isInterface && !(c.flags & ACC.ABSTRACT)) { const m = this.prog.implFor(n, name, desc); if (m) found.add(m); }
      const l = this.subs.get(n); if (l) stack.push(...l);
    }
    this.memo.set(key, out = [...found]);
    return out;
  }
}
