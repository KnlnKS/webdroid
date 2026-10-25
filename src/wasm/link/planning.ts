// What a unit is made of: the methods a first call compiles beside the one asked for (`batch`), and the callees and guarded implementations a hot
// method's second-tier unit takes in (`group`), chosen by how often the first tier saw them run.
import { ACC, mid, type MethodInfo } from "../compiler/program.ts";
import { staticallyBound, type CallPlan } from "../compiler/j2w.ts";
import { failed, invokeSite, symbolicOverride } from "../compiler/linkage.ts";
import { cyclic, decodeInstruction, decodeInstructions, prepareMethod, type PreparedInstruction } from "../../jvm/prepared.ts";
import { insnLen, invokeKind, isInvoke } from "../../jvm/opcodes.ts";
import { instructionClass } from "./resolution.ts";
import { PENDING } from "./slots.ts";
import type { World } from "./world.ts";
import { siteKey } from "../compiler/sites.ts";
import { siteProfile } from "../compiler/profile.ts";
import { HOT_BUDGET } from "../compiler/consts.ts";
import { PerWorld } from "./perworld.ts";

/** the most methods a first-tier unit holds (Planner.batch) */
const BATCH = 32;
/** a hot method is recompiled with up to MAX_GROUP methods in its module: the small callees (size in code units) that ran at least COPY_MIN times, and guards for at most MAX_GUARDS
 *  implementations per virtual call */
const MAX_GROUP = 24, SMALL_CALLEE = 100, MAX_GUARDS = 2, COPY_MIN = 64;
/** a virtual call with more implementations than this gets no guards: the busiest few of the whole app rarely are a given site's */
const MEGAMORPHIC = 32;

/** the implementations of virtual calls among the allocated classes (Planner.implementations), and the allocated classes by supertype, made again once classes are
 *  added or the namespace changes */
const implementations = new PerWorld((w) => ({
  implemented: new Map<string, Map<string, { seen: number; targets: Set<MethodInfo> | null }>>(),
  allocated: { seen: 0, cursor: w.allocated.values(), types: new Map<string, string | string[]>() },
}), "changed");

export class Planner {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  /** `m` and the methods without code that its first run will call: its static and direct calls before its first branch, and theirs. They are compiled beside
   *  it rather than in a module each, which costs the engine far more than the functions */
  batch(m: MethodInfo): MethodInfo[] {
    const out = [m];
    for (let i = 0; i < out.length && out.length < BATCH; i++) {
      const c = out[i];
      if (!c.codeOff || this.w.intrinsic(c)) continue;
      for (const ins of this.entryCalls(c)) {
        if (out.length >= BATCH) break;
        if (this.w.needsSymbolicSite(c, ins)) continue;
        const t = invokeSite(this.w.prog, c, ins.b, invokeKind(ins.op)).target;
        if (t === "clone" || failed(t) || out.includes(t) || !t.codeOff || t.flags & ACC.NATIVE || this.w.intrinsic(t)) continue;
        const at = this.w.slotOf(t);
        if (this.w.slots.compiled(at) || this.w.slots.any(at, PENDING) || this.w.aot?.provide(at)) continue;
        out.push(t);
      }
    }
    return out;
  }
  private leaves = new Map<MethodInfo, boolean>();
  leaf(m: MethodInfo): boolean {
    let r = this.leaves.get(m);
    if (r === undefined) {
      const code = m.codeOff ? m.dex.code(m.codeOff) : undefined;
      this.leaves.set(m, r = !!code && this.inlinable(m) && !cyclic(prepareMethod(code)));
    }
    return r;
  }
  /** `m` and the small methods it calls directly, up to MAX_GROUP: V8 can inline calls inside a module but not through the table. One that is
   *  compiled already is copied into the unit and used only by the unit's own calls (`copies`). */
  group(m: MethodInfo): { installed: MethodInfo[]; copies: MethodInfo[]; plan: CallPlan } {
    const out = [m], installed = [m], copies: MethodInfo[] = [], ids = new Set(out.map(mid)), plan = new Map<string, MethodInfo[]>();
    if (!m.codeOff || this.w.intrinsic(m)) return { installed, copies, plan };
    this.noteAllocations(m);
    for (let i = 0; i < out.length && out.length < MAX_GROUP; i++) {
      if (!out[i].codeOff || this.w.intrinsic(out[i])) continue;
      if (i) this.noteAllocations(out[i]);
      // the callees that have run often, busiest first: code the first tier saw run a few times is not worth compiling into the unit
      const callees: { t: MethodInfo; id: string; ran: number }[] = [];
      for (const t of this.callees(out[i], plan)) {
        const id = mid(t);
        if (ids.has(id)) continue;
        const ran = this.ran(t);
        if (ran >= COPY_MIN) callees.push({ t, id, ran });
      }
      callees.sort((a, b) => b.ran - a.ran);
      for (const { t, id } of callees) {
        if (out.length >= MAX_GROUP) break;
        if (ids.has(id)) continue;
        out.push(t); ids.add(id);
        (this.w.slots.compiled(this.w.slotOf(t)) ? copies : installed).push(t);
      }
    }
    return { installed, copies, plan };
  }
  /** calls and loop iterations counted for `t` so far: methods compiled by the second tier count as busy, the Wasm-written intrinsics always run */
  private ran(t: MethodInfo): number {
    const slot = this.w.slotOf(t);
    // a method that has asked for the second tier has used up a budget, whatever its count since
    if (this.w.upgrades.asked(slot) || this.w.opts.intrinsics.has(mid(t))) return HOT_BUDGET;
    return this.w.slots.compiled(slot) ? this.w.slots.count(slot) : 0;
  }
  /** a method's call sites (`invokes`) and its first call of each method reference (`calls`), and the classes it allocates and refers to */
  private planningSites = new Map<MethodInfo, { invokes: PreparedInstruction[]; calls: PreparedInstruction[]; allocations: string[]; references: string[] }>();
  planning(m: MethodInfo) {
    let sites = this.planningSites.get(m);
    if (!sites) {
      const seen = new Set<string>(), allocations = new Set<string>(), references = new Set<string>(), invokes: PreparedInstruction[] = [], calls: PreparedInstruction[] = [];
      const types = this.w.prog.typesOf(m.dex);
      for (const ins of decodeInstructions(m.dex.code(m.codeOff).insns)) {
        const name = ins.op !== 0xfa && ins.op !== 0xfb && instructionClass(m, ins);
        if (name) references.add(name);
        if (ins.op === 0x22) allocations.add(types.typeName(ins.b));
        if (!isInvoke(ins.op) || ins.op >= 0xfa) continue;
        invokes.push(ins);
        const key = `${ins.op}:${ins.b}`;
        if (!seen.has(key)) { seen.add(key); calls.push(ins); }
      }
      this.planningSites.set(m, sites = { invokes, calls, allocations: [...allocations], references: [...references] });
    }
    return sites;
  }
  /** a method's static and direct calls before its first branch (return, throw, goto, switch or if), which every run makes: only that much is decoded */
  private entryCalls(m: MethodInfo): PreparedInstruction[] {
    const insns = m.dex.code(m.codeOff).insns, entry: PreparedInstruction[] = [];
    for (let pc = 0; pc < insns.length;) {
      const op = insns[pc] & 0xff;
      if (!op && insns[pc] >> 8) { pc += insnLen(insns, pc); continue; }
      if (op >= 0x0e && op <= 0x11 || op >= 0x27 && op <= 0x2c || op >= 0x32 && op <= 0x3d) break;
      const ins = decodeInstruction(insns, pc);
      if (op === 0x70 || op === 0x71 || op === 0x76 || op === 0x77) entry.push(ins);
      pc += ins.len;
    }
    return entry;
  }
  /** `m`'s calls as the compiler binds them (MC.binding): the method each one reaches when that is known (a call bound statically, or a virtual call with one
   *  implementation) and a virtual call's implementations. A call that does not link, or copies an array, calls no method. */
  calls(m: MethodInfo) { return this.bind(m, this.planning(m).calls); }
  // Cache bytecode references, not eligibility or targets: loader initiation can change both.
  private *bind(m: MethodInfo, calls: PreparedInstruction[]): Generator<{ ins: PreparedInstruction; t?: MethodInfo; targets?: MethodInfo[]; decl: string; name: string; desc: string }> {
    for (const ins of calls) {
      if (this.w.needsSymbolicSite(m, ins)) continue;
      const kind = invokeKind(ins.op), { decl, name, desc, target } = invokeSite(this.w.prog, m, ins.b, kind);
      if (target === "clone" || failed(target)) continue;
      if (staticallyBound(this.w, kind, decl, target)) { yield { ins, t: target, decl, name, desc }; continue; }
      const targets = this.w.cha.targets(decl, name, desc);
      yield { ins, t: targets.length === 1 ? targets[0] : undefined, targets, decl, name, desc };
    }
  }
  /** Direct callees followed by guarded implementations, preserving their planning order; `plan` gets the implementations each virtual call tests for first. */
  private callees(m: MethodInfo, plan: Map<string, MethodInfo[]>): MethodInfo[] {
    const direct: MethodInfo[] = [], guarded: MethodInfo[] = [];
    for (const { ins, t, targets, decl, name, desc } of this.bind(m, this.planning(m).invokes)) {
      if (t && t !== m && this.inlinable(t) && !direct.includes(t)) direct.push(t);
      if (!targets) continue;
      const choices = this.siteGuards(m, ins, decl, name, desc, targets.length);
      plan.set(siteKey(m, ins), choices);
      for (const choice of choices) if (!guarded.includes(choice)) guarded.push(choice);
    }
    return direct.concat(guarded);
  }
  /** the small implementations a virtual call tests for: those its first-tier runs reached, else the busiest among the allocated classes' */
  private siteGuards(m: MethodInfo, ins: PreparedInstruction, decl: string, name: string, desc: string, implementations: number): MethodInfo[] {
    const profile = siteProfile(this.w.mem.buffer, m, ins);
    if (profile === "unseen") return implementations > 1 ? this.likely(decl, name, desc) : [];
    if (profile === "broad") return [];
    // a row another call collided into names that call's targets
    return profile.flatMap((slot) => {
      const t = this.w.slots.peekMethod(slot);
      return t && !t.isStatic && t.name === name && t.desc === desc && this.inlinable(t) ? [t] : [];
    });
  }
  /** the classes `m` allocates join the allocated set before its virtual calls are planned: it is about to run */
  private noteAllocations(m: MethodInfo): void {
    for (const name of this.planning(m).allocations) if (this.w.prog.get(name)) this.w.allocated.add(name);
  }
  /** the busiest small implementations, bounded by the number of guards emitted */
  private likely(decl: string, name: string, desc: string): MethodInfo[] {
    const chosen: MethodInfo[] = [], scores: number[] = [], targets = this.implementations(decl, name, desc);
    if (!targets) return chosen;
    for (const t of targets) {
      // Asking for a count would link a class that has not run.
      if (!this.w.classes.has(t.cls) && !this.w.aot?.hasLoaded(t.cls)) continue;
      const score = this.ran(t);
      if (score < COPY_MIN || !this.inlinable(t)) continue;
      let at = chosen.length;
      while (at > 0 && scores[at - 1] < score) at--;
      if (at >= MAX_GUARDS) continue;
      for (let i = Math.min(chosen.length, MAX_GUARDS - 1); i > at; i--) { chosen[i] = chosen[i - 1]; scores[i] = scores[i - 1]; }
      chosen[at] = t; scores[at] = score;
    }
    return chosen;
  }
  /** Index each allocation once across its supertypes, preserving allocation order. */
  private allocatedSubtypes(decl: string): readonly string[] {
    const index = implementations.get(this.w).allocated;
    // Never exhaust the iterator: later allocations must remain visible.
    while (index.seen < this.w.allocated.size) {
      const cls = index.cursor.next().value!;
      index.seen++;
      if (cls[0] === "[") continue;
      for (const parent of this.w.prog.supertypes(cls)) {
        const list = index.types.get(parent);
        if (list === undefined) index.types.set(parent, cls);
        else if (typeof list === "string") index.types.set(parent, [list, cls]);
        else list.push(cls);
      }
    }
    let classes = index.types.get(decl);
    if (typeof classes === "string") index.types.set(decl, classes = [classes]);
    return classes ?? [];
  }
  /** the implementations of a virtual call among the allocated classes, null once there are more than MEGAMORPHIC */
  private implementations(decl: string, name: string, desc: string): Set<MethodInfo> | null {
    const classes = this.allocatedSubtypes(decl);
    const implemented = implementations.get(this.w).implemented;
    let methods = implemented.get(decl);
    if (!methods) implemented.set(decl, methods = new Map());
    const key = name + desc;
    let memo = methods.get(key);
    if (!memo) methods.set(key, memo = { seen: 0, targets: new Set() });
    if (memo.seen === classes.length || !memo.targets) return memo.targets;
    const declared = this.w.prog.resolve(decl, name, desc);
    for (let i = memo.seen; i < classes.length; i++) {
      const cls = classes[i];
      const t = declared && !(declared.flags & (ACC.PUBLIC | ACC.PROTECTED)) ? symbolicOverride(this.w.prog, cls, declared) : this.w.prog.implFor(cls, name, desc);
      if (t && memo.targets.add(t).size > MEGAMORPHIC) { memo.targets = null; break; }
    }
    memo.seen = classes.length;
    return memo.targets;
  }
  /** whether `t` is worth compiling into its callers' units: a short method, or one the compiler writes itself (the String methods over the js-string builtins) */
  private inlinable(t: MethodInfo): boolean {
    if (this.w.opts.intrinsics.has(mid(t))) return true;
    return !!t.codeOff && !(t.flags & ACC.NATIVE) && !this.w.intrinsic(t) && t.dex.code(t.codeOff).insns.length <= SMALL_CALLEE;
  }
}
