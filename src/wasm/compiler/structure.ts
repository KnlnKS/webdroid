// Structured control flow for a method body. Blocks are split into single-entry regions: the
// method entry, each exception handler, and any block reached from more than one of them. Each
// region is ordered so every loop is contiguous and every other edge goes forward, so a branch is
// a `continue` of the loop it closes or a `break` out of a labelled block ending at its target.
// Only edges between regions, which exceptions and handler exits take, go through the `pc` switch.
import type { CodeItem } from "../../jvm/dex.ts";
import { branchTargets, endsBlock, ifTarget, type PreparedMethod } from "../../jvm/prepared.ts";

/** How a branch reaches its target block. */
export const Go = { Next: 0, Break: 1, Continue: 2, Dispatch: 3 } as const;
export type Go = (typeof Go)[keyof typeof Go];

/** The flow has a cycle with more than one entry; `heads` are the start pcs of the targets of its retreating edges. */
export class Irreducible extends Error {
  readonly heads: number[];
  constructor(heads: number[]) { super("irreducible"); this.heads = heads; }
}

interface Scope { open: number; close: number; label: string; loop: boolean }
export interface Region { entry: number; order: number[]; scopes: Scope[] }

export class Flow {
  readonly regions: Region[] = [];
  /** blocks whose conditional branch targets the next block: the test is inverted */
  readonly inverted: Set<number> = new Set();
  /** by block, the innermost natural loop it is in, -1 for none */
  readonly loopOf: Int32Array;
  private readonly fall: Int32Array;
  private readonly region: Int32Array;
  private readonly pos: Int32Array;
  private readonly rpo: Int32Array;
  private readonly loopCloses: Set<number>[] = [];

  /** `extraEntries` are blocks (by start pc) that also begin a region: an irreducible cycle is cut by making its extra heads (`Irreducible.heads`) entries, so every edge into them takes the dispatch. */
  constructor(prepared: PreparedMethod, code: CodeItem, extraEntries: readonly number[] = []) {
    const { instructions, blockAt, start, last: lastIdx } = prepared, n = start.length, root = n;
    const succs: (readonly number[])[] = prepared.succ.slice(), preds: number[][] = new Array(n + 1), last = (b: number) => instructions[lastIdx[b]];
    this.fall = new Int32Array(n);
    for (let b = 0; b <= n; b++) preds[b] = [];
    for (let b = 0; b < n; b++) {
      const ins = last(b);
      this.fall[b] = endsBlock(ins.op) ? -1 : blockAt[ins.pc + ins.len];
      for (const s of succs[b]) preds[s].push(b);
    }
    const entries = [0];
    for (const pc of extraEntries) entries.push(blockAt[pc]);
    for (const pc of prepared.handlerPcs) entries.push(blockAt[pc]);
    succs.push(entries);
    for (const e of entries) preds[e].push(root);

    // reverse postorder from the root, then dominators (Cooper, Harvey and Kennedy)
    const order: number[] = [], seen = new Uint8Array(n + 1), stack: [number, number][] = [[root, 0]];
    seen[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1], s = succs[top[0]][top[1]++];
      if (s === undefined) { order.push(top[0]); stack.pop(); }
      else if (!seen[s]) { seen[s] = 1; stack.push([s, 0]); }
    }
    order.reverse();
    const rpo = this.rpo = new Int32Array(n + 1).fill(-1);
    order.forEach((b, i) => rpo[b] = i);
    const idom = new Int32Array(n + 1).fill(-1);
    idom[root] = root;
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 1; i < order.length; i++) {
        const b = order[i];
        let d = -1;
        for (const p of preds[b]) {
          if (idom[p] < 0) continue;
          if (d < 0) { d = p; continue; }
          let x = p;
          while (x !== d) { while (rpo[x] > rpo[d]) x = idom[x]; while (rpo[d] > rpo[x]) d = idom[d]; }
        }
        if (idom[b] !== d) { idom[b] = d; changed = true; }
      }
    }
    // each region's blocks in reverse postorder, keyed by its entry
    const region = this.region = new Int32Array(n).fill(-1), members = new Map<number, number[]>();
    for (let i = 1; i < order.length; i++) {
      const b = order[i], e = region[b] = idom[b] === root ? b : region[idom[b]];
      members.get(e)?.push(b) ?? members.set(e, [b]);
    }
    const dominates = (a: number, b: number) => { for (; b !== root; b = idom[b]) if (b === a) return true; return false; };

    // natural loops: a retreating edge must reach a dominator, or the flow is irreducible
    const backs = new Map<number, number[]>(), heads = new Set<number>();
    for (const u of order) if (u !== root) for (const v of succs[u]) {
      if (region[v] !== region[u] || rpo[v] > rpo[u]) continue;
      if (!dominates(v, u)) { heads.add(start[v]); continue; }
      backs.get(v)?.push(u) ?? backs.set(v, [u]);
    }
    if (heads.size) throw new Irreducible([...heads]);
    const loops = [...backs].map(([head, sources]) => {
      const body = new Set([head]), work = sources.filter((s) => !body.has(s));
      for (const s of work) body.add(s);
      while (work.length) for (const p of preds[work.pop()!]) if (p !== root && !body.has(p)) { body.add(p); work.push(p); }
      return { head, body, parent: -1 };
    }).sort((a, b) => b.body.size - a.body.size);
    const loopOf = this.loopOf = new Int32Array(n).fill(-1);
    loops.forEach((l, i) => { l.parent = loopOf[l.head]; for (const b of l.body) loopOf[b] = i; });

    // each scope's blocks in topological order with its inner loops collapsed to their headers
    const inScope = (b: number, scope: number) => { for (let l = loopOf[b]; l >= 0; l = loops[l].parent) if (l === scope) return true; return scope < 0; };
    const rep = (b: number, scope: number) => {
      let l = loopOf[b];
      if (l === scope) return b;
      while (loops[l].parent !== scope) l = loops[l].parent;
      return loops[l].head;
    };
    // a call's blocks are those stamped with its number; a block's edges are taken before its loop's own call reuses them
    const indeg = new Int32Array(n), stamp = new Int32Array(n), edges: number[][] = [];
    let calls = 0;
    const sort = (members: Iterable<number>, scope: number, head: number, out: number[]) => {
      const call = ++calls;
      let keys = 0;
      const key = (b: number) => { if (stamp[b] !== call) { stamp[b] = call; indeg[b] = 0; (edges[b] ??= []).length = 0; keys++; } };
      for (const b of members) {
        const rb = rep(b, scope);
        key(rb);
        for (const v of succs[b]) {
          if (region[v] !== region[b] || rpo[v] <= rpo[b] || !inScope(v, scope)) continue;
          const rv = rep(v, scope);
          if (rv === rb) continue;
          key(rv); indeg[rv]++; edges[rb].push(rv);
        }
      }
      // the lowest pc goes first, keeping the dex layout where the order allows
      const ready = [head];
      let placed = 0;
      while (ready.length) {
        let k = 0;
        for (let j = 1; j < ready.length; j++) if (ready[j] < ready[k]) k = j;
        const b = ready[k];
        ready[k] = ready[ready.length - 1]; ready.pop();
        placed++;
        for (const v of edges[b]) if (!--indeg[v]) ready.push(v);
        const l = loopOf[b];
        if (l !== scope && loops[l].head === b) sort(loops[l].body, l, b, out);
        else out.push(b);
      }
      if (placed !== keys) throw new Error("unordered blocks");
    };

    this.pos = new Int32Array(n).fill(-1);
    const regionOf = new Map<number, Region>();
    for (const e of [...entries, ...members.keys()]) {
      if (regionOf.has(e)) continue;
      const r: Region = { entry: e, order: [], scopes: [] };
      sort(members.get(e)!, -1, e, r.order);
      r.order.forEach((b, i) => this.pos[b] = i);
      this.loopCloses[e] = new Set();
      regionOf.set(e, r);
      this.regions.push(r);
    }
    for (const l of loops) {
      const r = regionOf.get(region[l.head])!, open = this.pos[l.head], close = open + l.body.size;
      for (const b of l.body) if (this.pos[b] < open || this.pos[b] >= close) throw new Error("split loop");
      r.scopes.push({ open, close, label: `L${start[l.head]}`, loop: true });
      this.loopCloses[region[l.head]].add(close);
    }

    // forward scopes open at their first breaking block, widened until every scope nests
    const opens = new Map<number, number>();
    const note = (u: number, v: number, final: boolean) => {
      if (this.go(u, v, final) === Go.Break) opens.set(v, Math.min(opens.get(v) ?? Infinity, this.pos[u]));
    };
    for (const r of this.regions) for (const u of r.order) {
      const ins = last(u), op = ins.op;
      if (op >= 0x28 && op <= 0x2a) { note(u, blockAt[ins.pc + ins.a], true); continue; }
      if (endsBlock(op)) continue;
      if (op >= 0x32 && op <= 0x3d) {
        const t = blockAt[ifTarget(ins)], f = this.fall[u];
        if (t === f) { note(u, f, true); continue; }
        if (this.go(u, t, true) === Go.Next) { this.inverted.add(u); note(u, f, false); continue; }
        note(u, t, false);
      } else if (op === 0x2b || op === 0x2c) for (const t of branchTargets(code, ins)) note(u, blockAt[t], false);
      if (this.fall[u] >= 0) note(u, this.fall[u], true);
    }
    for (const [t, open] of opens) regionOf.get(region[t])!.scopes.push({ open, close: this.pos[t], label: `B${start[t]}`, loop: false });
    for (const r of this.regions) {
      const scopes = r.scopes;
      for (let changed = scopes.length > 1; changed;) {
        changed = false;
        for (const s of scopes) {
          if (s.loop) continue;
          for (let j = 0; j < scopes.length; j++) {
            const o = scopes[j];
            if (!(o.open < s.open && s.open < o.close && o.close <= s.close) || o.close === s.close && !o.loop) continue;
            s.open = o.open; changed = true;
          }
        }
      }
      // outer scopes first: the later close, and a block before a loop closing with it
      r.scopes.sort((a, b) => a.open - b.open || b.close - a.close || +a.loop - +b.loop);
      const nest: Scope[] = [];
      for (const s of r.scopes) {
        while (nest.length && nest[nest.length - 1].close <= s.open) nest.pop();
        if (nest.length && nest[nest.length - 1].close < s.close) throw new Error("crossing scopes");
        nest.push(s);
      }
    }
  }

  /** How block `u` reaches block `v`; `final` is a transfer that ends `u` rather than one inside a test. */
  go(u: number, v: number, final: boolean): Go {
    if (this.region[u] < 0) return Go.Next;
    if (this.region[v] !== this.region[u]) return Go.Dispatch;
    if (this.rpo[v] <= this.rpo[u]) return Go.Continue;
    return final && this.pos[v] === this.pos[u] + 1 && !this.loopCloses[this.region[u]].has(this.pos[v]) ? Go.Next : Go.Break;
  }

  /** the block a block that can fall through ends by reaching */
  fallTarget(u: number, taken: number): number { return this.inverted.has(u) ? taken : this.fall[u]; }
}

/** The structure of any body: an irreducible cycle gets its heads as extra region entries until the flow reduces, so only the edges that close it take the dispatch. */
export function structureAny(prepared: PreparedMethod, code: CodeItem): Flow {
  const extra = new Set<number>();
  for (;;) {
    try { return new Flow(prepared, code, [...extra]); } catch (e) {
      if (!(e instanceof Irreducible)) throw e;
      const before = extra.size;
      for (const h of e.heads) extra.add(h);
      if (extra.size === before) throw e;
    }
  }
}
