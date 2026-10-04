// Basic blocks, exception edges and a standard reducibility test for one method body.
import type { CodeItem } from "../../../src/jvm/dex";
import { NO_THROW } from "./opinfo";
import { branchTargets, endsBlock, type PreparedInstruction } from "../../../src/jvm/prepared";

export interface Cfg {
  n: number;
  /** instruction index of each block's first instruction */
  firstIdx: Int32Array;
  lastIdx: Int32Array;
  blockOfIdx: Int32Array;
  succ: number[][];
  /** handler blocks reachable from any throwing instruction in the block */
  hsucc: number[][];
  /** every handler entry block */
  handlers: number[];
  pcToIdx: Int32Array;
}

export function buildCfg(code: CodeItem, ins: readonly PreparedInstruction[]): Cfg {
  const pcToIdx = new Int32Array(code.insns.length + 1).fill(-1);
  ins.forEach((x, i) => { pcToIdx[x.pc] = i; });
  const leader = new Uint8Array(ins.length + 1);
  leader[0] = 1;
  const mark = (pc: number) => { const i = pcToIdx[pc]; if (i >= 0) leader[i] = 1; };
  ins.forEach((x, i) => {
    const t = branchTargets(code, x);
    for (const pc of t) mark(pc);
    if (t.length || endsBlock(x.op)) leader[i + 1] = 1;
  });
  for (const r of code.tries) {
    mark(r.start); mark(r.end);
    for (const [, h] of r.handlers) mark(h);
    if (r.catchAllAddr >= 0) mark(r.catchAllAddr);
  }
  const first: number[] = [], last: number[] = [];
  const blockOfIdx = new Int32Array(ins.length);
  for (let i = 0; i < ins.length; i++) {
    if (leader[i]) { first.push(i); last.push(i); }
    else last[last.length - 1] = i;
    blockOfIdx[i] = first.length - 1;
  }
  const n = first.length;
  const succ: number[][] = [], hsucc: number[][] = Array.from({ length: n }, () => []);
  for (let b = 0; b < n; b++) {
    const x = ins[last[b]], out: number[] = [];
    for (const pc of branchTargets(code, x)) { const i = pcToIdx[pc]; if (i >= 0) out.push(blockOfIdx[i]); }
    if (!endsBlock(x.op) && last[b] + 1 < ins.length) out.push(b + 1);
    succ.push([...new Set(out)]);
  }
  const hset = new Set<number>();
  for (const r of code.tries) {
    const hs: number[] = [];
    for (const [, h] of r.handlers) hs.push(blockOfIdx[pcToIdx[h]]);
    if (r.catchAllAddr >= 0) hs.push(blockOfIdx[pcToIdx[r.catchAllAddr]]);
    for (const h of hs) hset.add(h);
    // blocks overlapping [start,end)
    for (let i = Math.max(0, pcToIdx[r.start]); i < ins.length; i++) {
      const pc = ins[i].pc;
      if (pc < r.start) continue;
      if (pc >= r.end) break;
      if (NO_THROW[ins[i].op]) continue;
      const b = blockOfIdx[i];
      for (const h of hs) if (!hsucc[b].includes(h)) hsucc[b].push(h);
    }
  }
  return { n, firstIdx: Int32Array.from(first), lastIdx: Int32Array.from(last), blockOfIdx, succ, hsucc, handlers: [...hset], pcToIdx };
}

/** Reducible iff every retreating edge of a depth-first search runs to a dominator (Hecht-Ullman),
 *  from a synthetic root over `roots`. */
export function isReducible(n: number, succs: (b: number) => readonly number[], roots: readonly number[]): boolean {
  const root = n, order: number[] = [], seen = new Uint8Array(n + 1);
  const sx = (b: number) => (b === root ? roots : succs(b));
  const stack: [number, number][] = [[root, 0]];
  seen[root] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1], s = sx(top[0])[top[1]++];
    if (s === undefined) { order.push(top[0]); stack.pop(); } else if (!seen[s]) { seen[s] = 1; stack.push([s, 0]); }
  }
  order.reverse();
  const rpo = new Int32Array(n + 1).fill(-1);
  order.forEach((b, i) => { rpo[b] = i; });
  const preds: number[][] = Array.from({ length: n + 1 }, () => []);
  for (const u of order) for (const v of sx(u)) preds[v].push(u);
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
  for (const u of order) for (const v of sx(u)) {
    if (rpo[v] > rpo[u]) continue;           // forward edge
    let x = u; while (x !== root && x !== v) x = idom[x];
    if (x !== v) return false;               // retreating edge whose head does not dominate its tail
  }
  return true;
}
