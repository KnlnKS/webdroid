// Vulkan's shared conventions: pNext chains and the two-call enumeration idiom.

import { mem } from "../mem.ts";
import { PTR, ldp } from "../host.ts";

/** the structs chained from `pNext`, by sType: each one's address */
export function chain(pNext: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let p = pNext; p; p = ldp(p + PTR)) out.set(mem.ld32(p) >>> 0, p);
  return out;
}
/** the two-call enumeration idiom: with no array, the count; else up to *pCount items written and
 *  VK_INCOMPLETE when some did not fit */
export function enumerate<T>(items: T[], pCount: number, pItems: number, size: number, put: (at: number, item: T) => void): number {
  if (!pItems) { mem.st32(pCount, items.length); return 0; }
  const n = Math.min(mem.ld32(pCount) >>> 0, items.length);
  for (let i = 0; i < n; i++) put(pItems + i * size, items[i]);
  mem.st32(pCount, n);
  return n < items.length ? 5 : 0;                                              // VK_INCOMPLETE
}
