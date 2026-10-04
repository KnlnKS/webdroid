// Structured control flow for a hot entry body. Blocks are split into single-entry regions: the
// method entry, each exception handler, and any block reached from more than one of them. Each
// region is ordered so every loop is contiguous and every other edge goes forward, so a branch is
// a `continue` of the loop it closes or a `break` out of a labelled block ending at its target.
// Only edges between regions, which exceptions and handler exits take, go through the `pc` switch.
import type { CodeItem } from "./dex";
import { branchTargets, endsBlock, ifTarget, type PreparedMethod } from "./prepared";

/** How a branch reaches its target block. */
export const enum Go { Next, Break, Continue, Dispatch }

/** labelled scopes nest this deep at most in JavaScript, bounding the parser's recursion; a Wasm body has no such bound (see `maxDepth`) */
const MAX_DEPTH = 256;

interface Scope { open: number; close: number; label: string; loop: boolean }
export interface Region { entry: number; order: number[]; scopes: Scope[] }

export class Flow {
  readonly starts: number[] = [];
  readonly blockAt: Int32Array;
  readonly regions: Region[] = [];
  /** blocks whose conditional branch targets the next block: the test is inverted */
  readonly inverted: Set<number> = new Set();
  private readonly fall: number[] = [];
  private readonly region: Int32Array;
  private readonly pos: Int32Array;
  private readonly rpo: Int32Array;
  private readonly loopCloses: Set<number>[] = [];

  constructor(prepared: PreparedMethod, code: CodeItem, maxDepth = MAX_DEPTH) {
    const { instructions, leaders } = prepared, last: PreparedMethod["instructions"][number][] = [];
    this.blockAt = new Int32Array(code.insns.length + 1).fill(-1);
    for (const ins of instructions) {
      if (leaders[ins.pc]) { this.blockAt[ins.pc] = this.starts.length; this.starts.push(ins.pc); last.push(ins); }
      else last[last.length - 1] = ins;
    }
    const n = this.starts.length, root = n;
    const succs: number[][] = [], preds: number[][] = Array.from({ length: n + 1 }, () => []);
    for (let b = 0; b < n; b++) {
      const ins = last[b], out = branchTargets(code, ins).map((t) => this.blockAt[t]);
      this.fall[b] = endsBlock(ins.op) ? -1 : this.blockAt[ins.pc + ins.len];
      if (this.fall[b] >= 0) out.push(this.fall[b]);
      succs.push(out);
      for (const s of out) preds[s].push(b);
    }
    const entries = [0];
    for (const t of code.tries) for (const pc of [...t.handlers.map(([, h]) => h), ...t.catchAllAddr >= 0 ? [t.catchAllAddr] : []]) entries.push(this.blockAt[pc]);
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
    const region = this.region = new Int32Array(n).fill(-1);
    for (let i = 1; i < order.length; i++) { const b = order[i]; region[b] = idom[b] === root ? b : region[idom[b]]; }
    const dominates = (a: number, b: number) => { for (; b !== root; b = idom[b]) if (b === a) return true; return false; };

    // natural loops: a retreating edge must reach a dominator, or the flow is irreducible
    const backs = new Map<number, number[]>();
    for (const u of order) if (u !== root) for (const v of succs[u]) {
      if (region[v] !== region[u] || rpo[v] > rpo[u]) continue;
      if (!dominates(v, u)) throw new Error("irreducible");
      backs.get(v)?.push(u) ?? backs.set(v, [u]);
    }
    const loops = [...backs].map(([head, sources]) => {
      const body = new Set([head]), work = sources.filter((s) => !body.has(s));
      for (const s of work) body.add(s);
      while (work.length) for (const p of preds[work.pop()!]) if (p !== root && !body.has(p)) { body.add(p); work.push(p); }
      return { head, body, parent: -1 };
    }).sort((a, b) => b.body.size - a.body.size);
    const loopOf = new Int32Array(n).fill(-1);
    loops.forEach((l, i) => { l.parent = loopOf[l.head]; for (const b of l.body) loopOf[b] = i; });

    // each scope's blocks in topological order with its inner loops collapsed to their headers
    const inScope = (b: number, scope: number) => { for (let l = loopOf[b]; l >= 0; l = loops[l].parent) if (l === scope) return true; return scope < 0; };
    const rep = (b: number, scope: number) => {
      let l = loopOf[b];
      if (l === scope) return b;
      while (loops[l].parent !== scope) l = loops[l].parent;
      return loops[l].head;
    };
    const sort = (members: Iterable<number>, scope: number, head: number, out: number[]) => {
      const indeg = new Map<number, number>(), edges = new Map<number, number[]>();
      for (const b of members) {
        const rb = rep(b, scope);
        if (!indeg.has(rb)) indeg.set(rb, 0);
        for (const v of succs[b]) {
          if (region[v] !== region[b] || rpo[v] <= rpo[b] || !inScope(v, scope)) continue;
          const rv = rep(v, scope);
          if (rv === rb) continue;
          indeg.set(rv, (indeg.get(rv) ?? 0) + 1);
          edges.get(rb)?.push(rv) ?? edges.set(rb, [rv]);
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
        const l = loopOf[b];
        if (l !== scope && loops[l].head === b) sort(loops[l].body, l, b, out);
        else out.push(b);
        for (const v of edges.get(b) ?? []) { const d = indeg.get(v)! - 1; indeg.set(v, d); if (!d) ready.push(v); }
      }
      if (placed !== indeg.size) throw new Error("unordered blocks");
    };

    this.pos = new Int32Array(n).fill(-1);
    const regionOf = new Map<number, Region>();
    for (const e of entries.concat(order.filter((b) => b !== root && idom[b] === root))) {
      if (regionOf.has(e)) continue;
      const r: Region = { entry: e, order: [], scopes: [] };
      sort(order.filter((b) => b !== root && region[b] === e), -1, e, r.order);
      r.order.forEach((b, i) => this.pos[b] = i);
      this.loopCloses[e] = new Set();
      regionOf.set(e, r);
      this.regions.push(r);
    }
    for (const l of loops) {
      const r = regionOf.get(region[l.head])!, open = this.pos[l.head], close = open + l.body.size;
      for (const b of l.body) if (this.pos[b] < open || this.pos[b] >= close) throw new Error("split loop");
      r.scopes.push({ open, close, label: `L${this.starts[l.head]}`, loop: true });
      this.loopCloses[region[l.head]].add(close);
    }

    // forward scopes open at their first breaking block, widened until every scope nests
    const opens = new Map<number, number>();
    const note = (u: number, v: number, final: boolean) => {
      if (this.go(u, v, final) === Go.Break) opens.set(v, Math.min(opens.get(v) ?? Infinity, this.pos[u]));
    };
    for (const r of this.regions) for (const u of r.order) {
      const ins = last[u], op = ins.op;
      if (op >= 0x28 && op <= 0x2a) { note(u, this.blockAt[ins.pc + ins.a], true); continue; }
      if (endsBlock(op)) continue;
      if (op >= 0x32 && op <= 0x3d) {
        const t = this.blockAt[ifTarget(ins)], f = this.fall[u];
        if (t === f) { note(u, f, true); continue; }
        if (this.go(u, t, true) === Go.Next) { this.inverted.add(u); note(u, f, false); continue; }
        note(u, t, false);
      } else if (op === 0x2b || op === 0x2c) for (const t of branchTargets(code, ins)) note(u, this.blockAt[t], false);
      if (this.fall[u] >= 0) note(u, this.fall[u], true);
    }
    for (const [t, open] of opens) regionOf.get(region[t])!.scopes.push({ open, close: this.pos[t], label: `B${this.starts[t]}`, loop: false });
    for (const r of this.regions) {
      for (let changed = true; changed;) {
        changed = false;
        for (const s of r.scopes) for (const o of r.scopes) {
          if (s.loop || o === s || !(o.open < s.open && s.open < o.close && o.close <= s.close)) continue;
          if (o.close === s.close && !o.loop) continue;
          s.open = o.open; changed = true;
        }
      }
      // outer scopes first: the later close, and a block before a loop closing with it
      r.scopes.sort((a, b) => a.open - b.open || b.close - a.close || +a.loop - +b.loop);
      const nest: Scope[] = [];
      for (const s of r.scopes) {
        while (nest.length && nest[nest.length - 1].close <= s.open) nest.pop();
        if (nest.length && nest[nest.length - 1].close < s.close) throw new Error("crossing scopes");
        if (nest.push(s) > maxDepth) throw new Error("too deep");
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

  /** the edge retreats in the method's depth-first order: every cycle takes one */
  back(u: number, v: number): boolean { return this.rpo[v] <= this.rpo[u]; }

  /** the block a block that can fall through ends by reaching */
  fallTarget(u: number, taken: number): number { return this.inverted.has(u) ? taken : this.fall[u]; }

  /** Each region's blocks, in order, inside their labelled scopes. */
  assemble(code: (block: number) => string): string[] {
    return this.regions.map((r) => {
      const out: string[] = [], nest: Scope[] = [];
      let next = 0;
      for (let p = 0; p <= r.order.length; p++) {
        while (nest.length && nest[nest.length - 1].close === p) { nest.pop(); out.push("}"); }
        for (; next < r.scopes.length && r.scopes[next].open === p; next++) {
          const s = r.scopes[next];
          nest.push(s);
          out.push(s.loop ? `${s.label}:for(;;){` : `${s.label}:{`);
        }
        if (p < r.order.length) out.push(code(r.order[p]));
      }
      return out.join("\n");
    });
  }
}

/** The structure of a hot entry body, or null when its flow must keep the dispatch loop. */
export function structure(prepared: PreparedMethod, code: CodeItem): Flow | null {
  try { return new Flow(prepared, code); } catch { return null; }
}
