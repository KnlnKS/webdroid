// Class-hierarchy analysis over a loaded class set (closed-world assumption, see REPORT).
import type { DexFile } from "../../../src/jvm/dex.ts";

export interface ClassInfo { desc: string; sup: string | null; ifaces: string[]; flags: number; methods: Map<string, number>; }
export const ACC_FINAL = 0x10, ACC_INTERFACE = 0x200, ACC_ABSTRACT = 0x400, ACC_STATIC = 0x8, ACC_PRIVATE = 0x2;

export class Universe {
  readonly base?: Universe;
  classes = new Map<string, ClassInfo>();
  kids = new Map<string, string[]>();
  constructor(base?: Universe) { this.base = base; }
  get(d: string): ClassInfo | undefined { return this.classes.get(d) ?? this.base?.get(d); }
  children(d: string): string[] {
    const a = this.kids.get(d), b = this.base?.children(d);
    return a && b ? [...b, ...a] : a ?? b ?? EMPTY;
  }
  add(dexes: DexFile[]): void {
    for (const dex of dexes) for (let i = 0; i < dex.classDefCount; i++) {
      const def = dex.classDef(i), desc = dex.type(def.typeIdx);
      if (this.classes.has(desc)) continue;
      const methods = new Map<string, number>();
      for (const m of [...def.directMethods, ...def.virtualMethods]) methods.set(dex.method(m.methodIdx).name + dex.methodDesc(m.methodIdx), m.flags);
      const sup = def.superIdx === 0xffffffff ? null : dex.type(def.superIdx);
      const ifaces = def.interfaces.map((t) => dex.type(t));
      this.classes.set(desc, { desc, sup, ifaces, flags: def.flags, methods });
      for (const p of sup ? [sup, ...ifaces] : ifaces) { const l = this.kids.get(p); if (l) l.push(desc); else this.kids.set(p, [desc]); }
    }
  }
  private memo = new Map<string, number>();
  /** distinct non-abstract implementations a virtual/interface call on static type `cls` can reach
   *  among loaded concrete subtypes, capped at 3; -1 when `cls` is not loaded */
  impls(cls: string, key: string): number {
    const mk = cls + "\0" + key;
    const hit = this.memo.get(mk);
    if (hit !== undefined) return hit;
    if (!this.get(cls)) { this.memo.set(mk, -1); return -1; }
    const found = new Set<string>(), seen = new Set<string>(), stack = [cls];
    while (stack.length && found.size < 3) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      const ci = this.get(d);
      if (ci && !(ci.flags & (ACC_ABSTRACT | ACC_INTERFACE))) { const decl = this.resolve(d, key); if (decl) found.add(decl); }
      for (const k of this.children(d)) stack.push(k);
    }
    this.memo.set(mk, found.size);
    return found.size;
  }
  /** the class declaring the implementation `key` that a receiver of concrete class `d` reaches */
  resolve(d: string, key: string): string | null {
    for (let c: string | null = d; c;) {
      const ci = this.get(c);
      if (!ci) return null;
      const f = ci.methods.get(key);
      if (f !== undefined && !(f & ACC_STATIC) && !(f & ACC_ABSTRACT)) return c;
      c = ci.sup;
    }
    // default methods
    const seen = new Set<string>(), q = [d];
    while (q.length) {
      const c = q.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const ci = this.get(c);
      if (!ci) continue;
      for (const i of [...ci.ifaces, ...(ci.sup ? [ci.sup] : [])]) {
        const ii = this.get(i);
        const f = ii?.methods.get(key);
        if (f !== undefined && !(f & ACC_ABSTRACT) && !(f & ACC_STATIC)) return i;
        q.push(i);
      }
    }
    return null;
  }
  /** does the class chain declare `key` as final? */
  isFinalMethod(cls: string, key: string): boolean {
    for (let c: string | null = cls; c;) {
      const ci = this.get(c);
      if (!ci) return false;
      const f = ci.methods.get(key);
      if (f !== undefined) return !!(f & ACC_FINAL);
      c = ci.sup;
    }
    return false;
  }
}
const EMPTY: string[] = [];
