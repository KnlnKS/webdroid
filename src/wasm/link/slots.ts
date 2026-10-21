// The funcref table's slots and what each holds. A class owns a block (one slot per method, then its `ensure`); runtime functions take one slot each
// between blocks. Every reservation after the platform classes is numbered (numbers.ts) in the same order, so Worlds that replay it agree on every slot.
import type { MethodInfo } from "../compiler/program.ts";
import type { Synth } from "../compiler/rtfns.ts";
import type { Thrower } from "../compiler/exc.ts";
import type { Tail } from "./numbers.ts";
import type { World } from "./world.ts";

export type MethodSlot = { k: "method"; m: MethodInfo; done: boolean };
export type Slot = MethodSlot | { k: "thrower"; name: Thrower; done: boolean } | { k: "synth"; name: string; d?: Synth; done: boolean } | { k: "ensure"; done?: boolean };

export class SlotTable {
  private readonly w: World;
  private entries: (Slot | undefined)[] = [];
  /** the slots a class owns: [blockBase[i], blockBase[i] + blockSize[i]), in ascending order. A method's slot is the block's base plus its index, the last slot is the class's `ensure` */
  readonly blockBase: number[] = [];
  private readonly blockSize: number[] = [];
  readonly blockClass: string[] = [];
  /** the blocks of classes a replayed numbering (World.adopt) gave slots before their modules were made */
  readonly preassigned = new Map<string, number>();
  /** the platform classes, which have the first blocks in id order (World.seedPlatform) */
  seeded = 0;
  private readonly synth = new Map<string, number>();
  /** the runtime functions whose stub or code is in their slot */
  private readonly stubbed = new Set<number>();

  constructor(w: World, fixed: number) { this.w = w; this.reserve(fixed); }

  private reserve(n: number): number {
    const base = this.entries.length, table = this.w.table;
    this.entries.length += n;
    if (this.entries.length > table.length) table.grow(Math.max(this.entries.length - table.length, table.length));
    return base;
  }
  /** reserves the slots of a class: one per method and one for its `ensure` */
  addBlock(name: string, size: number): number {
    const base = this.reserve(size);
    this.blockBase.push(base); this.blockSize.push(size); this.blockClass.push(name);
    return base;
  }
  /** the slots of class `name` if they are numbered, though it may not be linked yet: a platform class's, or those a replayed numbering gave it */
  baseOf(name: string): number | undefined {
    const id = this.w.numbers.ids.get(name);
    return id !== undefined && id <= this.seeded ? this.blockBase[id - 1] : this.preassigned.get(name);
  }
  /** a class's block, numbered as the next reservation */
  numberBlock(name: string, size: number): number { this.w.numbers.reserve([name, size]); return this.addBlock(name, size); }
  /** replays the reservation of a runtime function's slot */
  reserveSynth(name: string): void { this.synth.set(name, this.reserve(1)); }
  /** replays reservations `tail` numbered elsewhere */
  replay(tail: Tail[]): void { for (const t of tail) if (typeof t === "string") this.reserveSynth(t); else this.preassigned.set(t[0], this.addBlock(t[0], t[1])); }
  /** forgets the reservations `tail`, the last ones made */
  rollback(tail: Tail[]): void {
    let top = this.entries.length;
    for (const t of tail.reverse()) {
      if (typeof t === "string") { top = this.synth.get(t)!; this.synth.delete(t); this.stubbed.delete(top); }
      else { top = this.blockBase.pop()!; this.blockSize.pop(); this.blockClass.pop(); this.preassigned.delete(t[0]); }
    }
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
  /** the slot's entry, if it has been made */
  peek(slot: number): Slot | undefined { return this.entries[slot]; }
  /** the slot's entry; the slots of classes are made when first asked for */
  at(slot: number): Slot | undefined {
    const s = this.entries[slot];
    if (s) return s;
    const b = this.blockOf(slot);
    if (b < 0) return undefined;
    const i = slot - this.blockBase[b];
    if (i === this.blockSize[b] - 1) return this.entries[slot] = { k: "ensure" };
    return this.entries[slot] = { k: "method", m: this.w.prog.get(this.blockClass[b])!.methodAt(i)!, done: !!this.w.aot?.installed(slot) };
  }
  /** the method entry of `slot`, made if need be */
  method(slot: number): MethodSlot | undefined { const s = this.at(slot); return s?.k === "method" ? s : undefined; }
  /** the method entry of `slot` if it has been made */
  peekMethod(slot: number): MethodSlot | undefined { const s = this.entries[slot]; return s?.k === "method" ? s : undefined; }
  set(slot: number, s: Slot): void { this.entries[slot] = s; }
  /** made entries, for a scan */
  made(): readonly (Slot | undefined)[] { return this.entries; }

  /** the slot of runtime function `name`, reserved and numbered the first time; whether it still lacks its stub or code */
  synthSlot(name: string): { slot: number; fresh: boolean } {
    let slot = this.synth.get(name);
    if (slot === undefined) { this.w.numbers.reserve(name); this.synth.set(name, slot = this.reserve(1)); }
    if (this.stubbed.has(slot)) return { slot, fresh: false };
    this.stubbed.add(slot);
    return { slot, fresh: true };
  }
  /** the slot of runtime function `name`, if it has one */
  synthSlotOf(name: string): number | undefined { return this.synth.get(name); }
  /** whether the runtime function in `slot` has its stub or code */
  isStubbed(slot: number): boolean { return this.stubbed.has(slot); }
  /** records that the code of runtime function `name` is in its slot */
  holdsSynth(name: string, slot: number): void { this.stubbed.add(slot); this.entries[slot] = { k: "synth", name, done: true }; }
  /** the runtime functions that have their descriptors, in numbering order: what a build makes code for */
  synths(): { name: string; slot: number; d: Synth }[] {
    const out: { name: string; slot: number; d: Synth }[] = [];
    for (const [name, slot] of this.synth) { const s = this.entries[slot]; if (s?.k === "synth" && s.d) out.push({ name, slot, d: s.d }); }
    return out.sort((a, b) => a.slot - b.slot);
  }
  /** the classes with a method that has been called (a method's slot is done once it has run or its precompiled code is installed) */
  calledClasses(): string[] {
    return this.blockClass.filter((name, b) => {
      const n = this.w.prog.get(name)?.methods.length ?? 0;
      for (let i = 0; i < n; i++) if (this.entries[this.blockBase[b] + i]?.done) return true;
      return false;
    });
  }
}
