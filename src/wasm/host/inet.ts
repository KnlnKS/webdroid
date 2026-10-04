// Linux.android_getaddrinfo's resolution (link/inet.ts): the production one (the hosts file, numeric forms, the relay's answer), which answers
// synchronously for everything but a name the relay must look up.
import { resolveHost } from "../../native/net-address";
import type { HostNet } from "../link/hostapi";
import { ASYNC, NetOp } from "../link/inet";
import type { World } from "../link/world";

const resolved = new WeakMap<World, number[][]>();
/** host.net(op, node, a, b): Resolve answers the number of addresses of `node` (family a, flags b) or minus an EAI code; Byte answers byte b of address a, or the length for b = -1 */
export const hostNet: HostNet = (w: World, op: number, node: string, a: number, b: number): number => {
  if (op === NetOp.Byte) { const address = resolved.get(w)![a]; return b < 0 ? address.length : address[b]; }
  const found = resolveHost(node, a, b);
  if (found instanceof Promise) return ASYNC;
  if (typeof found === "number") return -found;
  resolved.set(w, found);
  return found.length;
};
