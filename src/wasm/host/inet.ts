// Linux.android_getaddrinfo's resolution (link/inet.ts): the production one (the hosts file, numeric forms, the relay's answer), which answers
// synchronously for everything but a name the relay must look up.
import { resolveHost } from "../../native/net-address.ts";
import type { HostNet } from "../link/hostapi.ts";
import { ASYNC } from "../link/inet.ts";
import type { World } from "../link/world.ts";

/** per World, the lookups the relay answered and the one in flight */
const answers = new WeakMap<World, { done: Map<string, number[][] | number>; pending?: Promise<void> }>();
export const hostNet: HostNet = (w: World, node: string, family: number, flags: number) => {
  let state = answers.get(w);
  if (!state) answers.set(w, state = { done: new Map() });
  const key = `${node}|${family}|${flags}`;
  const found = state.done.get(key) ?? resolveHost(node, family, flags);
  if (found instanceof Promise) { const s = state; s.pending = found.then((r) => { s.done.set(key, r); }); return ASYNC; }
  return typeof found === "number" ? -found : found;
};
hostNet.wait = async (w: World) => { await answers.get(w)?.pending; };
