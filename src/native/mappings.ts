import { guestAt, mem } from "./mem";

type SharedMapping = { va: bigint; n: number; off: number; writeBack: (off: number, bytes: Uint8Array) => void };
const sharedMaps: SharedMapping[] = [];

export function trackSharedMap(va: bigint, n: number, off: number, writeBack: SharedMapping["writeBack"]): void {
  sharedMaps.push({ va, n, off, writeBack });
}

export function syncShared(va: bigint, n: number, drop: boolean): void {
  const end = va + BigInt(n);
  for (let i = sharedMaps.length - 1; i >= 0; i--) {
    const m = sharedMaps[i], lo = m.va > va ? m.va : va, hi = m.va + BigInt(m.n) < end ? m.va + BigInt(m.n) : end;
    if (lo >= hi) continue;
    const count = Number(hi - lo);
    const start = guestAt(lo);
    m.writeBack(m.off + Number(lo - m.va), mem.u8.slice(start, start + count));
    if (!drop) continue;
    const left = Number(lo - m.va), right = Number(m.va + BigInt(m.n) - hi);
    if (left && right) {
      sharedMaps.push({ va: hi, n: right, off: m.off + left + count, writeBack: m.writeBack });
      m.n = left;
    } else if (left) m.n = left;
    else if (right) { m.va = hi; m.off += count; m.n = right; }
    else sharedMaps.splice(i, 1);
  }
}

/** whether any byte of [va, va+n) is a shared file mapping */
export function isShared(va: bigint, n: number): boolean {
  const end = va + BigInt(n);
  return sharedMaps.some((m) => m.va < end && va < m.va + BigInt(m.n));
}
