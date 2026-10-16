// Basic blocks and exception edges for one method body.
import type { CodeItem } from "../../jvm/dex.ts";
import { NO_THROW } from "./opinfo.ts";
import { branchTargets, endsBlock, type PreparedInstruction } from "../../jvm/prepared.ts";

interface Cfg {
  n: number;
  /** instruction index of each block's first instruction */
  firstIdx: Int32Array;
  lastIdx: Int32Array;
  blockOfIdx: Int32Array;
  succ: number[][];
  /** handler blocks reachable from any throwing instruction in the block */
  hsucc: (readonly number[])[];
  pcToIdx: Int32Array;
}

const NO_HANDLERS: readonly number[] = [];

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
  const succ: number[][] = new Array(n), hsucc: (readonly number[])[] = new Array(n).fill(NO_HANDLERS);
  for (let b = 0; b < n; b++) {
    const x = ins[last[b]], out: number[] = [];
    for (const pc of branchTargets(code, x)) { const i = pcToIdx[pc]; if (i >= 0) out.push(blockOfIdx[i]); }
    if (!endsBlock(x.op) && last[b] + 1 < ins.length) out.push(b + 1);
    succ[b] = out.length < 2 ? out : out.filter((s, k) => out.indexOf(s) === k);
  }
  for (const r of code.tries) {
    const hs: number[] = [];
    for (const [, h] of r.handlers) hs.push(blockOfIdx[pcToIdx[h]]);
    if (r.catchAllAddr >= 0) hs.push(blockOfIdx[pcToIdx[r.catchAllAddr]]);
    // blocks overlapping [start,end)
    for (let i = Math.max(0, pcToIdx[r.start]); i < ins.length; i++) {
      const pc = ins[i].pc;
      if (pc < r.start) continue;
      if (pc >= r.end) break;
      if (NO_THROW[ins[i].op]) continue;
      const b = blockOfIdx[i], at = hsucc[b] === NO_HANDLERS ? (hsucc[b] = []) : hsucc[b] as number[];
      for (const h of hs) if (!at.includes(h)) at.push(h);
    }
  }
  return { n, firstIdx: new Int32Array(first), lastIdx: new Int32Array(last), blockOfIdx, succ, hsucc, pcToIdx };
}
