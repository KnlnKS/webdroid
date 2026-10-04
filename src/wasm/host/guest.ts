// The native core's memory as the Wasm tier's guest memory (hostapi.ts GuestMemory): direct buffers are blocks of its allocator, at the address the guest knows.
import { memory } from "../../native/core";
import { mem } from "../../native/mem";
import type { GuestMemory } from "../link/hostapi";

export const guestMemory: GuestMemory = {
  memory,
  alloc(n) {
    const block = mem.calloc(1, Math.max(n, 1));
    return block ? BigInt(mem.va(block)) : 0n;
  },
  free: (address) => mem.free(mem.txVa(address)),
};
