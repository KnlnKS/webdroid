// Basic blocks and exception edges for one method body.
import type { CodeItem } from "../../jvm/dex.ts";
import { branchTargets, endsBlock, type PreparedMethod } from "../../jvm/prepared.ts";

interface Cfg {
  n: number;
  /** instruction index of each block's first instruction */
  firstIdx: Int32Array;
  lastIdx: Int32Array;
  blockOfIdx: Int32Array;
  succ: number[][];
  /** handler blocks reachable from any throwing instruction in the block */
  hsucc: (readonly number[])[];
  /** by instruction index, the blocks of PreparedMethod.handlers */
  handlers: (readonly number[] | undefined)[];
  pcToIdx: Int32Array;
}

const NO_HANDLERS: readonly number[] = [];

export function buildCfg(code: CodeItem, { instructions: ins, leaders, handlers }: PreparedMethod): Cfg {
  const pcToIdx = new Int32Array(code.insns.length + 1).fill(-1);
  ins.forEach((x, i) => { pcToIdx[x.pc] = i; });
  const first: number[] = [], last: number[] = [];
  const blockOfIdx = new Int32Array(ins.length);
  for (let i = 0; i < ins.length; i++) {
    if (leaders[ins[i].pc]) { first.push(i); last.push(i); }
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
  // a try's handler pcs are one array, so its blocks are looked up once
  const blocks = new Map<readonly number[], number[]>(), handlerBlocks: (readonly number[] | undefined)[] = new Array(ins.length);
  handlers.forEach((pcs, i) => {
    if (!pcs) return;
    let hs = blocks.get(pcs);
    if (!hs) blocks.set(pcs, hs = pcs.map((pc) => blockOfIdx[pcToIdx[pc]]));
    handlerBlocks[i] = hs;
    const b = blockOfIdx[i], at = hsucc[b] === NO_HANDLERS ? (hsucc[b] = []) : hsucc[b] as number[];
    for (const h of hs) if (!at.includes(h)) at.push(h);
  });
  return { n, firstIdx: new Int32Array(first), lastIdx: new Int32Array(last), blockOfIdx, succ, hsucc, handlers: handlerBlocks, pcToIdx };
}
