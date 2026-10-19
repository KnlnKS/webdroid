// Virtual and interface dispatch: the vtable slots of a class's virtual methods, the words of its vtable (its type display, interface hash table and ids), and the
// slots of what fills an entry with no method (AbstractMethodError, a default-method conflict, an inaccessible interface implementation).
import { ACC, kindOf, javaName, type Kinds, type JClass, type MethodInfo, typeName } from "../compiler/program.ts";
import { H, ELEM, ELEM_KIND, ELEM_IFACE, ELEM_OTHER } from "../compiler/consts.ts";
import { parseMethodDesc } from "../../jvm/abi.ts";
import { dispatchMethodKey, dispatchSlotKey, overridesMethod, failed, symbolicDispatchFor, symbolicImplFor, symbolicMethod, resolveSymbolicMethod } from "../compiler/linkage.ts";
import type { World } from "./world.ts";

/** the kinds of a vtable entry's parameters (the receiver first) and result, from its method key */
function entryKinds(key: string): Kinds {
  const p = parseMethodDesc(key.slice(key.indexOf("(")));
  return { params: ["L", ...p.params.map(kindOf)], ret: p.ret === "V" ? "V" : kindOf(p.ret) };
}

export class Dispatch {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  /** forgets the vtable layouts and interface lookups: the namespace they were worked out in changed */
  forget(): void { this.vslotCache.clear(); this.imtCache.clear(); }
  private vslotCache = new Map<string, string[]>();
  private imtCache = new Map<number, Map<number, number>>();
  /** Binary DEX method keys in slot order. Resolving signature Class identities must not renumber published dispatch slots. */
  vslots(n: string): string[] {
    let s = this.vslotCache.get(n); if (s) return s;
    const c = this.w.prog.get(n);
    s = n === "java/lang/Object" || !c ? [] : [...this.vslots(c.sup ?? "java/lang/Object")];
    if (c && !c.isInterface) {
      const byMethod = new Map<string, string[]>();
      const index = (key: string) => {
        const raw = dispatchMethodKey(key), slots = byMethod.get(raw);
        if (slots) slots.push(key); else byMethod.set(raw, [key]);
      };
      for (const key of s) index(key);
      for (const m of c.methods) if (!m.isStatic && !m.isCtor && !(m.flags & ACC.PRIVATE)) {
        const overrides = byMethod.get(javaName(m.key))?.some(key => {
          const inherited = c.sup ? symbolicImplFor(this.w.prog, c.sup, key, true) : undefined;
          return inherited && overridesMethod(this.w.prog, n, inherited);
        });
        if (!overrides) { const key = dispatchSlotKey(m); s.push(key); index(key); }
      }
      const addIface = (i: string) => {
        const ic = this.w.prog.get(i);
        if (!ic) return;
        for (const m of ic.methods) if (!(m.flags & (ACC.STATIC | ACC.PRIVATE))) {
          const key = javaName(m.key);
          if (!byMethod.get(key)?.some(slot => !!((symbolicImplFor(this.w.prog, n, slot, true)?.flags ?? 0) & ACC.PUBLIC))) { s!.push(key); index(key); }
        }
        ic.ifaces.forEach(addIface);
      };
      for (let k: JClass | undefined = c; k; k = k.sup ? this.w.prog.get(k.sup) : undefined) k.ifaces.forEach(addIface);
    }
    this.vslotCache.set(n, s); return s;
  }
  /** vtable index of virtual method `key` as seen from class `decl` */
  vslot(decl: string, key: string): number {
    const slots = this.vslots(decl), raw = javaName(key);
    let i = slots.indexOf(raw);
    if (i < 0) {
      const at = key.indexOf("("), target = resolveSymbolicMethod(this.w.prog, decl, key.slice(0, at), key.slice(at));
      // Several inaccessible declarations may share a binary prototype and distinct slots.
      i = slots.findIndex(slot => dispatchMethodKey(slot) === raw && !!target && symbolicImplFor(this.w.prog, decl, slot, true) === target);
    }
    if (i < 0) throw new Error(`no vtable slot for ${decl}.${key}`);
    return H.VTAB + i;
  }
  vtWords(name: string, id: number): Int32Array {
    const prog = this.w.prog, arr = name[0] === "[", c = prog.get(name);
    const chain = arr ? ["java/lang/Object", name] : [...prog.chain(name)].reverse();   // Object first
    const depth = chain.length - 1;
    const keys = this.vslots(arr ? "java/lang/Object" : name), impl = (key: string) => symbolicDispatchFor(prog, arr ? "java/lang/Object" : name, key);
    const body: number[] = new Array(H.VTAB + keys.length).fill(0);
    body[H.ID] = id; body[H.DEPTH] = depth;
    // ancestors beyond the fixed display are tested like interfaces, from the id list at the end
    const ifs = new Set<number>();
    chain.forEach((cn, i) => { const cid = cn === name ? id : this.w.idOf(cn); if (i < H.MAXD) body[H.DISPLAY + i] = cid; else ifs.add(cid); });
    if (arr) {
      const comp = typeName(name.slice(1)), cc = prog.get(comp), d = cc && !cc.isInterface ? prog.chain(comp).length - 1 : -1;
      body[ELEM] = this.w.idOf(comp);
      body[ELEM_KIND] = !cc ? ELEM_OTHER : cc.isInterface || d >= H.MAXD ? ELEM_IFACE : d + 1;
    }
    const targets = keys.map(impl);
    keys.forEach((key, i) => { body[H.VTAB + i] = this.dispatchSlot(key, targets[i]); });
    // interface dispatch: a small hash table of the selectors known now, the rest learned from imtMiss
    const slow: number[] = [];
    if (!arr) keys.forEach((key, i) => {
      const sel = this.w.numbers.selectors.get(dispatchMethodKey(key)), target = sel ? targets[i] : undefined;
      if (!sel || !target || !failed(target) && !(target.flags & ACC.PUBLIC)) return;
      const s = sel % H.IMT_N, f = this.dispatchSlot(key, target);
      if (body[H.IMT + 2 * s] === 0) { body[H.IMT + 2 * s] = sel; body[H.IMT + 2 * s + 1] = f; } else slow.push(sel, f);
    });
    const addI = (i: string) => { const ic = prog.get(i); if (ic) { ifs.add(this.w.idOf(i)); ic.ifaces.forEach(addI); } };
    if (arr) ["java/lang/Cloneable", "java/io/Serializable"].forEach(addI);
    else for (let k: JClass | undefined = c; k; k = k.sup ? prog.get(k.sup) : undefined) k.ifaces.forEach(addI);
    // extra region: [capacity, count, (selector, slot) x capacity, interface count, interface ids]
    const cap = slow.length / 2 + 16;
    body[H.EXTRA] = body.length;
    body.push(cap, slow.length / 2, ...slow, ...new Array(2 * cap - slow.length).fill(0), ifs.size, ...ifs);
    return Int32Array.from(body);
  }
  imtMiss(cls: number, sel: number): number {
    let cache = this.imtCache.get(cls);
    if (!cache) this.imtCache.set(cls, cache = new Map());
    let slot = cache.get(sel);
    if (slot === undefined) {
      const key = this.w.numbers.selKeys[sel], name = this.w.nameOf(cls);
      const receiver = name[0] === "[" ? "java/lang/Object" : name, at = key.indexOf("(");
      let m: MethodInfo | undefined;
      for (const owner of this.w.prog.chain(receiver)) {
        const candidate = symbolicMethod(this.w.prog.require(owner), key.slice(0, at), key.slice(at));
        if (candidate && !candidate.isStatic) { m = candidate; break; }
      }
      const target = m ?? symbolicDispatchFor(this.w.prog, receiver, key);
      cache.set(sel, slot = target && !failed(target) && !(target.flags & ACC.PUBLIC) ? this.interfaceAccessSlot(entryKinds(key)) : this.dispatchSlot(key, target));
    }
    return slot;
  }
  private dispatchSlot(key: string, target: ReturnType<typeof symbolicDispatchFor>): number {
    return target ? failed(target) ? this.conflictSlot(key, target.message) : this.w.slotOf(target) : this.abstractSlot(entryKinds(key));
  }
  /** a stub for a method the class does not implement: AbstractMethodError, with the signature of the vtable entry it fills */
  abstractSlot({ params, ret }: Kinds): number {
    return this.w.synthSlot(`abstract:${params.join("")}>${ret}`, { params, ret, body: (cx, c) => { cx.callThrower(c, "ame"); } });
  }
  /** A default conflict keeps the physical dispatch signature and throws only when invoked. */
  conflictSlot(key: string, message: string): number {
    return this.w.synthSlot("conflict:" + JSON.stringify([key, message]), { ...entryKinds(key), body: (cx, c) => {
      cx.linkError(c, { thrower: "icce", message });
    } });
  }
  interfaceAccessSlot({ params, ret }: Kinds): number {
    return this.w.synthSlot(`interfaceAccess:${params.join("")}>${ret}`, { params, ret, body: (cx, c) => {
      cx.construct(c, cx.prog.resolve("java/lang/IllegalAccessError", "<init>", "()V")!); c.throw_(cx.tag);
    } });
  }
}
