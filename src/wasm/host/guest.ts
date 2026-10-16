// The native core's memory as the Wasm tier's guest memory (hostapi.ts GuestMemory): direct buffers are blocks of its allocator, at the address the guest knows.
import { core, memory } from "../../native/core.ts";
import { mem, wrote } from "../../native/mem.ts";
import { PAGE_SHIFT } from "../../native/abi.ts";
import type { GuestMemory } from "../link/hostapi.ts";

export const guestMemory: GuestMemory = {
  memory,
  flags: core.flags_ptr(),
  pageShift: PAGE_SHIFT,
  wrote,
  alloc(n) {
    const block = mem.calloc(1, Math.max(n, 1));
    return block ? BigInt(mem.va(block)) : 0n;
  },
  free: (address) => mem.free(mem.txVa(address)),
};
