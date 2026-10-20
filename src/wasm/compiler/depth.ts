// How a method counts its frame against the depth limit (exc.ts MAX_DEPTH): not at all when it calls only methods of its unit that count none and is small with
// them, since the engine's stack holds the limit twice over and these frames add at most MAX_UNCOUNTED to the counted ones; around the one or two calls that
// are not such methods (a slow path, a recursion); else for the whole frame, which a handler must restore.
import { isInvoke } from "../../jvm/opcodes.ts";
import { MAX_UNCOUNTED } from "./exc.ts";
import { mid } from "./ids.ts";
import type { MethodInfo } from "./program.ts";
import type { MC } from "./method.ts";

/** the calls of a method that may count its frame around themselves instead of in a prologue */
const MAX_SITES = 2;

export interface DepthPlan {
  /** whether the method counts its whole frame, in a prologue */
  whole: boolean;
  /** the calls that count the frame around themselves: an invoke's pc, and a guarded one's ":" and callee or "f" for its dispatch */
  sites: ReadonlySet<string>;
  /** whether the calls that count their own frame are all on paths that throw, so a caller need not count its frame for the method */
  boundable: boolean;
  /** the weight of the heaviest method this one calls, once it counts no depth */
  calleeWeight: number;
}
export const WHOLE_FRAME: DepthPlan = { whole: true, sites: new Set(), boundable: true, calleeWeight: 0 };

export function planDepth(mc: MC): DepthPlan {
  const { instructions, first, last } = mc.prepared;
  if (instructions.some(ins => mc.deferredSite(ins))) return WHOLE_FRAME;
  if (!instructions.some((i) => isInvoke(i.op))) return { whole: false, sites: WHOLE_FRAME.sites, boundable: true, calleeWeight: 0 };
  if (mc.tries) return WHOLE_FRAME;
  const open: string[] = [], cold: string[] = [];
  // a call in a loop counts once per iteration around itself, against once per call of the method in a prologue; an irreducible cycle crosses regions
  let looped = false, calleeWeight = 0;
  const bounded = (m: MethodInfo) => { const w = mc.cx.boundOf(m); if (w !== undefined) calleeWeight = Math.max(calleeWeight, w); return w !== undefined; };
  for (let blk = 0; blk < first.length; blk++) {
    const thrown = instructions[last[blk]].op === 0x27, opened = open.length;
    for (let i = first[blk]; i <= last[blk]; i++) {
      const ins = instructions[i];
      if (!isInvoke(ins.op)) continue;
      if (ins.op >= 0xfa) return WHOLE_FRAME; // invoke-polymorphic, invoke-custom
      const b = mc.binding(ins), key = String(ins.pc);
      if (!b) continue;
      if (b.k === "virtual") {
        // a virtual call tests for the likely implementations of its unit first (guards): the call of one that counts, and the dispatch behind them, count around themselves
        const guards = mc.guards(ins, b);
        for (const g of guards) if (!bounded(g)) open.push(`${key}:${mid(g)}`);
        if (guards.length) { cold.push(key + ":f"); continue; }
      }
      // a check calls its method for a null argument, which the method rejects
      const body = b.k === "fixed" ? b.body : undefined;
      if (body?.k === "check") { cold.push(key); continue; }
      const callee = b.k !== "fixed" ? undefined : body ? mc.innerCall(body) : b.m;
      if (callee === null) continue;
      // the constructor of an exception thrown right after runs once and leaves the method: a caller's weight is no loss there, whatever the stack holds
      if (!callee || !bounded(callee)) (thrown ? cold : open).push(key);
    }
    if (open.length > opened && (mc.flow.loopOf[blk] >= 0 || mc.flow.regions.length > 1)) looped = true;
  }
  if (looped || calleeWeight + 4 + 3 * mc.item.regs > MAX_UNCOUNTED || open.length > MAX_SITES) return WHOLE_FRAME;
  return { whole: false, sites: new Set([...open, ...cold]), boundable: open.length === 0, calleeWeight };
}
