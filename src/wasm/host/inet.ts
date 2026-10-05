// Linux.android_getaddrinfo's resolution (link/inet.ts): the production one (the hosts file, numeric forms, the relay's answer), which answers
// synchronously for everything but a name the relay must look up.
import { resolveHost } from "../../native/net-address";
import type { HostNet } from "../link/hostapi";
import { ASYNC, NetOp } from "../link/inet";
import type { World } from "../link/world";

/** the addresses each strand last resolved: another strand may resolve while this one waits for the relay */
const resolved = new WeakMap<World, Map<number, number[][]>>();
/** host.net(op, node, a, b): Resolve answers the number of addresses of `node` (family a, flags b) or minus an EAI code; Byte answers byte b of address a, or the length for b = -1 */
export const hostNet: HostNet = (w: World, op: number, node: string, a: number, b: number): number | Promise<number> => {
  const strand = w.sched.current().id;
  if (op === NetOp.Byte) { const address = resolved.get(w)!.get(strand)![a]; return b < 0 ? address.length : address[b]; }
  const found = resolveHost(node, a, b), answer = (r: number | number[][]) => {
    if (typeof r === "number") return -r;
    let mine = resolved.get(w); if (!mine) resolved.set(w, mine = new Map());
    mine.set(strand, r);
    return r.length;
  };
  if (found instanceof Promise) return op === NetOp.Wait ? found.then(answer) : ASYNC;
  return answer(found);
};
