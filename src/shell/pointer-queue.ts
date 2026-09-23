export type PointerSample = { action: 0 | 1 | 2 | 3; x: number; y: number; at: number };

export function queuePointer(pending: PointerSample[], sample: PointerSample): void {
  const last = pending[pending.length - 1];
  if (sample.action === 2 && last?.action === 2) pending[pending.length - 1] = sample;
  else pending.push(sample);
}
