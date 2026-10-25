// The funcref table's slots, what each stands for and the state of its code. A class owns a block (one slot per method, then its `ensure`); runtime functions take
// one slot each between blocks. Every reservation after the platform classes is numbered (numbers.ts) in the same order, so Worlds that replay it agree on every slot.
//
// A slot holds its lazy-link stub until code is put in it: first-tier code compiled here (with the other methods of its unit, its group) or a build's, then
// second-tier code (HOT). Undoing it (unlink) puts the stub back. Every change of a slot's code goes through install, built and unlink.
import type { MethodInfo } from "../compiler/program.ts";
import type { Synth } from "../compiler/rtfns.ts";
import type { Thrower } from "../compiler/exc.ts";
import { COUNT_BASE, COUNT_SLOTS } from "../compiler/consts.ts";
import type { Tail } from "./numbers.ts";
import type { World } from "./world.ts";

/** what a slot stands for: a method of its class's block, the class's ensure(), a runtime function or a thrower */
type Slot = { k: "method"; m: MethodInfo } | { k: "ensure" } | { k: "synth"; name: string; d: Synth } | { k: "thrower"; name: Thrower };
/** a slot's state, by bit: first-tier or second-tier (HOT) code is in it, the first-tier code is a build's (BUILT); the build whose loaded module holds code
 *  for it, whatever is in it now (PLATFORM or APP); a compile worker has the second-tier compile of its method (PENDING) */
export const FIRST = 1, HOT = 2, BUILT = 4, PLATFORM = 8, APP = 16, PENDING = 32;
const CODE = FIRST | HOT | BUILT;

export class SlotTable {
  private readonly w: World;
  private entries: (Slot | undefined)[] = [];
  private state = new Uint8Array(1 << 16);
  /** the slots of the methods compiled in one unit, by slot: they call each other directly, so they are undone together */
  private readonly groups = new Map<number, number[]>();
  /** the slots a class owns: [blockBase[i], blockBase[i] + blockSize[i]), in ascending order. A method's slot is the block's base plus its index, the last slot is the class's `ensure` */
  readonly blockBase: number[] = [];
  private readonly blockSize: number[] = [];
  readonly blockClass: string[] = [];
  /** the blocks of classes a replayed numbering (World.adopt) gave slots before their modules were made */
  readonly preassigned = new Map<string, number>();
  private nSeeded = 0;
  private readonly synth = new Map<string, number>();
  private countView?: Int32Array;

  constructor(w: World, fixed: number) { this.w = w; this.reserve(fixed); }

  private reserve(n: number): number {
    const base = this.entries.length, table = this.w.table;
    this.entries.length += n;
    if (this.entries.length > table.length) table.grow(Math.max(this.entries.length - table.length, table.length));
    if (this.entries.length > this.state.length) { const grown = new Uint8Array(Math.max(this.entries.length, 2 * this.state.length)); grown.set(this.state); this.state = grown; }
    return base;
  }
  /** how many slots are reserved */
  get size(): number { return this.entries.length; }
  /** the slots of class `name` if they are numbered, though it may not be linked yet: a platform class's, or those a replayed numbering gave it */
  baseOf(name: string): number | undefined {
    const id = this.w.numbers.ids.get(name);
    return id !== undefined && id <= this.seeded ? this.blockBase[id - 1] : this.preassigned.get(name);
  }
  /** the platform classes, which have the first blocks in id order (World.seedPlatform) */
  get seeded(): number { return this.nSeeded; }
  /** a class's block (one slot per method and one for its `ensure`) at `base` */
  private addBlock(name: string, size: number, base: number): void { this.blockBase.push(base); this.blockSize.push(size); this.blockClass.push(name); }
  /** a class's block, numbered as the next reservation */
  numberBlock(name: string, size: number): number {
    this.w.numbers.reserve([name, size]);
    const base = this.reserve(size);
    this.addBlock(name, size, base);
    return base;
  }
  /** makes reservations `tail` at once, as many as the platform's classes or an app build's (tens of thousands); `block` sees each class's base */
  private reserveAll(tail: readonly Tail[], block?: (name: string, base: number) => void): void {
    let top = this.reserve(tail.reduce((n, t) => n + (typeof t === "string" ? 1 : t[1]), 0));
    for (const t of tail) {
      if (typeof t === "string") { this.synth.set(t, top++); continue; }
      this.addBlock(t[0], t[1], top); block?.(t[0], top);
      top += t[1];
    }
  }
  /** reserves the blocks of the platform classes, the first, in id order (World.seedPlatform) */
  seed(blocks: [string, number][]): void { this.reserveAll(blocks); this.nSeeded = blocks.length; }
  /** replays reservations `tail` numbered elsewhere */
  replay(tail: Tail[]): void { this.reserveAll(tail, (name, base) => this.preassigned.set(name, base)); }
  /** forgets the reservations `tail`, the last ones made */
  rollback(tail: Tail[]): void {
    let top = this.entries.length;
    for (const t of tail.reverse()) {
      if (typeof t === "string") { top = this.synth.get(t)!; this.synth.delete(t); }
      else { top = this.blockBase.pop()!; this.blockSize.pop(); this.blockClass.pop(); this.preassigned.delete(t[0]); }
    }
    this.state.fill(0, top, this.entries.length);
    this.entries.length = top;
  }
  /** the index of the class block that owns `slot` (platform classes come first, in id order), or -1 */
  blockOf(slot: number): number {
    const base = this.blockBase;
    let lo = 0, hi = base.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (base[m] <= slot) lo = m; else hi = m - 1; }
    return lo < base.length && slot >= base[lo] && slot < base[lo] + this.blockSize[lo] ? lo : -1;
  }
  /** how many methods the class of block `b` has (its `ensure` slot is the last of the block) */
  methodsIn(b: number): number { return this.blockSize[b] - 1; }
  /** what the slot stands for, if that has been asked */
  peek(slot: number): Slot | undefined { return this.entries[slot]; }
  /** what the slot stands for; the slots of classes are described when first asked */
  at(slot: number): Slot | undefined {
    const s = this.entries[slot];
    if (s) return s;
    const b = this.blockOf(slot);
    if (b < 0) return undefined;
    const i = slot - this.blockBase[b];
    return this.entries[slot] = i === this.blockSize[b] - 1 ? { k: "ensure" } : { k: "method", m: this.w.prog.get(this.blockClass[b])!.methodAt(i)! };
  }
  /** the method of `slot`, if it is a method's */
  methodAt(slot: number): MethodInfo | undefined { const s = this.at(slot); return s?.k === "method" ? s.m : undefined; }
  /** the method of `slot` if it is a method's that has been asked about */
  peekMethod(slot: number): MethodInfo | undefined { const s = this.entries[slot]; return s?.k === "method" ? s.m : undefined; }
  set(slot: number, s: Slot): void { this.entries[slot] = s; }

  // ---------- the code
  /** whether code is in `slot`, rather than its lazy-link stub */
  compiled(slot: number): boolean { return (this.state[slot] & (FIRST | HOT)) !== 0; }
  /** whether `slot` has all of state `bits` */
  is(slot: number, bits: number): boolean { return (this.state[slot] & bits) === bits; }
  /** whether `slot` has any of state `bits` */
  any(slot: number, bits: number): boolean { return (this.state[slot] & bits) !== 0; }
  /** a compile worker has, or no longer has, the second-tier compile of the method in `slot` */
  pending(slot: number, on: boolean): void { if (on) this.state[slot] |= PENDING; else this.state[slot] &= ~PENDING; }
  /** the slots compiled with `slot` in one unit, it included */
  group(slot: number): number[] | undefined { return this.groups.get(slot); }
  /** puts `f`, code made here, in `slot`: second-tier code (`hot`) or first-tier code, compiled with the slots of `group` */
  install(slot: number, f: unknown, hot: boolean, group?: number[]): void {
    this.w.table.set(slot, f as never);
    this.state[slot] = this.state[slot] & ~CODE | (hot ? HOT : FIRST);
    if (group) this.groups.set(slot, group); else this.groups.delete(slot);
  }
  /** a build's module (`from`: PLATFORM or APP) put its code in `slot` */
  built(slot: number, from: number): void { this.state[slot] = this.state[slot] & ~(CODE | PLATFORM | APP) | FIRST | BUILT | from; this.groups.delete(slot); }
  /** puts the lazy-link stub back in `slot`, which holds code; false if nothing here can stand in for that code (a class's ensure()) */
  unlink(slot: number): boolean {
    if (!this.w.stubs.restoreStub(slot, this.at(slot))) return false;
    this.state[slot] &= ~CODE; this.groups.delete(slot);
    return true;
  }
  /** calls and loop iterations counted so far for the method in `slot` */
  count(slot: number): number { return slot < COUNT_SLOTS ? this.counts()[slot] : 0; }
  /** the call and loop counters, a view kept until the memory grows */
  counts(): Int32Array {
    if (this.countView?.buffer !== this.w.mem.buffer) this.countView = new Int32Array(this.w.mem.buffer, COUNT_BASE, COUNT_SLOTS);
    return this.countView;
  }

  // ---------- runtime functions
  /** the slot of runtime function `name`, reserved and numbered the first time */
  synthSlot(name: string): number {
    let slot = this.synth.get(name);
    if (slot === undefined) { this.w.numbers.reserve(name); this.synth.set(name, slot = this.reserve(1)); }
    return slot;
  }
  /** the slot of runtime function `name`, if it has one */
  synthSlotOf(name: string): number | undefined { return this.synth.get(name); }
  /** the runtime functions that have their descriptors, in numbering order: what a build makes code for */
  synths(): { name: string; slot: number; d: Synth }[] {
    const out: { name: string; slot: number; d: Synth }[] = [];
    for (const [name, slot] of this.synth) { const s = this.entries[slot]; if (s?.k === "synth") out.push({ name, slot, d: s.d }); }
    return out.sort((a, b) => a.slot - b.slot);
  }
  /** the classes with a method that has been called: one whose code was made here, or a build's that has run */
  calledClasses(): string[] {
    const counts = this.counts();
    return this.blockClass.filter((_, b) => {
      for (let slot = this.blockBase[b], end = slot + this.methodsIn(b); slot < end; slot++) {
        const s = this.state[slot];
        if (s & HOT || s & FIRST && (!(s & BUILT) || slot < COUNT_SLOTS && counts[slot])) return true;
      }
      return false;
    });
  }
}
