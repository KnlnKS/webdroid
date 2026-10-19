// The numbers compiled code holds for what it names: class ids, interface selectors, gaps, link errors and the slot reservations after the platform classes. Worlds
// that number the same things in the same order agree on every number, which code compiled in another World relies on (aot.ts, apps.ts, a compile worker).
import { NeedsNumber } from "../compiler/j2w.ts";
import { javaName } from "../compiler/program.ts";

/** the sizes of everything numbered so far */
export interface Marks { names: number; tail: number; selectors: number; gaps: number; links: number }
/** a slot reservation after the platform classes: a block for a class (name, size) or a runtime function's slot (its name) */
export type Tail = string | [string, number];
/** what was numbered after `from`, in order: replaying it in a World at `from` numbers everything the same way */
export interface Numbering { from: Marks; names: string[]; tail: Tail[]; selectors: string[]; gaps: string[]; links: string[] }
export const sameMarks = (a: Marks, b: Marks): boolean => a.names === b.names && a.tail === b.tail && a.selectors === b.selectors && a.gaps === b.gaps && a.links === b.links;

/** a link error's id: its message's hash (FNV-1a), the same wherever code is compiled */
const linkHash = (message: string): number => { let h = 0x811c9dc5; for (let i = 0; i < message.length; i++) h = Math.imul(h ^ message.charCodeAt(i), 0x01000193); return h >>> 1; };

/** the messages of the link errors (linkage.ts) compiled code throws, by id: a message's hash, or the next free id after it when another message has that one */
export class LinkIds {
  /** the messages in numbering order */
  readonly messages: string[] = [];
  private readonly ids: number[] = [];
  private readonly at = new Map<number, string>();
  message(id: number): string | undefined { return this.at.get(id); }
  /** the id of `message`, numbered if it is new; undefined if its hash is another message's, unless it may `probe` past */
  id(message: string, probe: boolean): number | undefined {
    for (let id = linkHash(message); ; id = (id + 1) & 0x7fffffff) {
      if (this.put(message, id)) return id;
      if (!probe) return undefined;
    }
  }
  /** numbers `message` as `id` unless it has that id already; false if another message has it */
  put(message: string, id: number): boolean {
    const at = this.at.get(id);
    if (at === undefined) { this.at.set(id, message); this.messages.push(message); this.ids.push(id); }
    return at === undefined || at === message;
  }
  /** the messages numbered after the first `n`, with their ids */
  since(n: number): [string, number][] { return this.messages.slice(n).map((m, i) => [m, this.ids[n + i]]); }
  truncate(n: number): void { this.messages.length = n; for (const id of this.ids.splice(n)) this.at.delete(id); }
}

export class Numbers {
  /** class names by id; 0 is none */
  readonly names = [""];
  readonly ids = new Map<string, number>();
  /** interface method keys by selector; 0 is none */
  readonly selKeys = [""];
  readonly selectors = new Map<string, number>();
  /** constructs the compiler has no translation for, by id: each compiles to host.gap(id) and a throw, never to a guess */
  readonly gapList: string[] = [];
  private readonly gaps = new Map<string, number>();
  readonly links = new LinkIds();
  /** the slot reservations after the platform classes, in order */
  readonly tail: Tail[] = [];
  private freeze = false;

  idOf(name: string): number { return this.ids.get(name) ?? this.add(this.ids, this.names, name); }
  selectorId(key: string): number { key = javaName(key); return this.selectors.get(key) ?? this.add(this.selectors, this.selKeys, key); }
  gapId(what: string): number { return this.gaps.get(what) ?? this.add(this.gaps, this.gapList, what); }
  linkId(message: string): number {
    // the free id after a collision depends on the order of numbering, which a shard does not share
    const id = this.links.id(message, !this.freeze);
    if (id === undefined) throw new NeedsNumber(message);
    return id;
  }
  /** records a reservation of table slots */
  reserve(t: Tail): void { this.grant("slots"); this.tail.push(t); }
  private add(map: Map<string, number>, list: string[], key: string): number {
    this.grant(key);
    map.set(key, list.length);
    return list.push(key) - 1;
  }
  private grant(what: string): void { if (this.freeze) throw new NeedsNumber(what); }
  /** runs `fn` numbering nothing new: what would need a number throws NeedsNumber, but for a link error whose hash is free (a shard of an app build, apps.ts,
   *  compiles against the numbering every shard shares) */
  frozen<T>(fn: () => T): T {
    const was = this.freeze;
    this.freeze = true;
    try { return fn(); } finally { this.freeze = was; }
  }

  marks(): Marks { return { names: this.names.length, tail: this.tail.length, selectors: this.selKeys.length, gaps: this.gapList.length, links: this.links.messages.length }; }
  /** what was numbered after `m` */
  since(m: Marks): Numbering {
    return { from: m, names: this.names.slice(m.names), tail: this.tail.slice(m.tail), selectors: this.selKeys.slice(m.selectors), gaps: this.gapList.slice(m.gaps), links: this.links.messages.slice(m.links) };
  }
  /** numbers what `n` numbered, in its order; false, and nothing changed, unless exactly what `n` started from is numbered */
  adopt(n: Numbering): boolean {
    if (!sameMarks(this.marks(), n.from)) return false;
    for (const name of n.names) this.idOf(name);
    for (const t of n.tail) this.tail.push(t);
    for (const k of n.selectors) this.selectorId(k);
    for (const g of n.gaps) this.gapId(g);
    for (const m of n.links) this.linkId(m);
    return true;
  }
  /** forgets what was numbered after `m`, answering the names and reservations it forgets */
  rollback(m: Marks): { names: string[]; tail: Tail[] } {
    const names = this.names.splice(m.names);
    for (const n of names) this.ids.delete(n);
    for (const k of this.selKeys.splice(m.selectors)) this.selectors.delete(k);
    for (const g of this.gapList.splice(m.gaps)) this.gaps.delete(g);
    this.links.truncate(m.links);
    return { names, tail: this.tail.splice(m.tail) };
  }
}
