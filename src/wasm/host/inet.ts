// Linux.android_getaddrinfo's resolution (link/inet.ts): the production one (the hosts file, numeric forms, the relay's answer), which answers
// synchronously for everything but a name the relay must look up.
import { resolveHost } from "../../native/net-address.ts";
import type { HostNet } from "../link/hostapi.ts";
import { ASYNC, NetOp } from "../link/inet.ts";
import type { World } from "../link/world.ts";

const resolved = new WeakMap<World, number[][]>();
/** per World, the lookups the relay answered and the one in flight */
const answers = new WeakMap<World, { done: Map<string, number[][] | number>; pending?: Promise<void> }>();
/** host.net(op, node, a, b): Resolve answers the number of addresses of `node` (family a, flags b) or minus an EAI code; Byte answers byte b of address a, or the length for b = -1 */
export const hostNet: HostNet = (w: World, op: number, node: string, a: number, b: number): number => {
  if (op === NetOp.Byte) { const address = resolved.get(w)![a]; return b < 0 ? address.length : address[b]; }
  let state = answers.get(w);
  if (!state) answers.set(w, state = { done: new Map() });
  const key = `${node}|${a}|${b}`;
  const found = state.done.get(key) ?? resolveHost(node, a, b);
  if (found instanceof Promise) { const s = state; s.pending = found.then((r) => { s.done.set(key, r); }); return ASYNC; }
  if (typeof found === "number") return -found;
  resolved.set(w, found);
  return found.length;
};
hostNet.wait = async (w: World) => { await answers.get(w)?.pending; };
