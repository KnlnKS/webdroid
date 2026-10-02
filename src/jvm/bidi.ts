import { bidiRanges } from "./bidi-data";

export function directionality(cp: number): number {
  if (cp < 0 || cp > 0x10ffff) return -1;
  let lo = 0, hi = bidiRanges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bidiRanges[mid] >>> 5) < cp) lo = mid + 1;
    else hi = mid;
  }
  return (bidiRanges[lo] & 31) - 1;
}

