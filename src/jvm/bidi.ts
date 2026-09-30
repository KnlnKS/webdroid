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

/** TextDirectionHeuristics.FIRSTSTRONG_LTR: whether the first strong character, outside isolates, is RTL */
export function firstStrongRtl(text: string): boolean {
  let isolates = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!; i += cp > 0xffff ? 2 : 1;
    if (cp >= 0x2066 && cp <= 0x2068) { isolates++; continue; }
    if (cp === 0x2069) { isolates = Math.max(0, isolates - 1); continue; }
    if (isolates) continue;
    const dir = directionality(cp);
    if (dir === 1 || dir === 2) return true;
    if (dir === 0) return false;
  }
  return false;
}
