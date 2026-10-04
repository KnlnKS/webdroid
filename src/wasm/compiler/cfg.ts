// Basic blocks, exception edges and a standard reducibility test for one method body.
import type { CodeItem } from "../../jvm/dex";
import { NO_THROW } from "./opinfo";
import { branchTargets, endsBlock, type PreparedInstruction } from "../../jvm/prepared";

interface Cfg {
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
