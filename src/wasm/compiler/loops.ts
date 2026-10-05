// Which loops end by their own counter. A loop that can wait for another strand has to give it a turn (the fuel check, sched.ts); a loop whose exit
// test compares an int that every iteration steps toward the bound cannot wait, since it ends after at most 2^32 iterations whatever others do.
import type { CodeItem } from "../../jvm/dex";
import { branchTargets, ifTarget, type PreparedInstruction as Ins, type PreparedMethod } from "../../jvm/prepared";
import type { Typing } from "./infer";

const EQ = 0x32, NE = 0x33, LT = 0x34, GE = 0x35, GT = 0x36, LE = 0x37;
const swap = (op: number) => (op === LT ? GT : op === GT ? LT : op === LE ? GE : op === GE ? LE : op);
const negate = (op: number) => (op === LT ? GE : op === GE ? LT : op === GT ? LE : op === LE ? GT : op === EQ ? NE : EQ);

/** the head pcs of the loops of the method that count */
export function countedLoops(prepared: PreparedMethod, item: CodeItem, typing: Typing): Set<number> {
  const ins = prepared.instructions, index = new Map(ins.map((x, i) => [x.pc, i])), back = new Map<number, Ins[]>(), counted = new Set<number>();
  for (const b of ins) for (const t of branchTargets(item, b)) if (t <= b.pc) { const e = back.get(t); if (e) e.push(b); else back.set(t, [b]); }
  const steps = (x: Ins, web: number) => (x.name === "add-int/lit8" || x.name === "add-int/lit16") && x.c !== 0 && typing.def(x.pc) === web && typing.use(x.pc, x.b) === web;
  for (const [t, edges] of back) {
    const first = index.get(t);
    if (first === undefined) continue;
    const end = Math.max(...edges.map((b) => b.pc)), body = ins.slice(first, index.get(end)! + 1), inside = (pc: number) => pc >= t && pc <= end;
    // the webs the loop steps by constants of one sign and defines in no other way (0: not one)
    const ivs = new Map<number, number>();
    for (const x of body) {
      const w = typing.def(x.pc);
      if (w < 0) continue;
      const step = steps(x, w) ? Math.sign(x.c) : 0, prev = ivs.get(w);
      ivs.set(w, prev === undefined || prev === step ? step : 0);
    }
    const stepsIn = (w: number, from: number, to: number) => { for (let i = to; i >= from; i--) { if (steps(body[i], w)) return true; if (i > 0 && prepared.leaders[body[i].pc]) return false; } return false; };
    const headEnd = body.findIndex((x, i) => i > 0 && prepared.leaders[x.pc]) - 1, last = headEnd < 0 ? body.length - 1 : headEnd;
    for (const [i, x] of body.entries()) {
      if (counted.has(t) || x.op < 0x32 || x.op > 0x3d) continue;
      const leaves = !inside(ifTarget(x));
      if (leaves === !inside(x.pc + x.len)) continue;
      // every iteration reaches the test: it ends the head's block, or it is the only back edge
      if (!(i === last) && !(edges.length === 1 && edges[0] === x)) continue;
      const zero = x.op >= 0x38, a = typing.use(x.pc, x.a), b = zero ? -1 : typing.use(x.pc, x.b);
      for (const [w, sign] of ivs) {
        if (!sign || a === b || (w !== a && w !== b)) continue;
        let op = zero ? x.op - 6 : x.op;
        if (w === b) op = swap(op);
        if (!leaves) op = negate(op);
        const unit = body.every((y) => !steps(y, w) || Math.abs(y.c) === 1);
        if (!(sign > 0 ? op === GE || op === GT : op === LE || op === LT) && !(op === EQ && unit)) continue;
        // and every iteration steps it: in the head's block, or in the block of each back edge, before the test or the edge
        if (stepsIn(w, 0, i) && i === last || edges.every((e) => stepsIn(w, 0, index.get(e.pc)! - first))) counted.add(t);
      }
    }
  }
  return counted;
}
