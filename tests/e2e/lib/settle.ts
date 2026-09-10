/**
 * The one settle contract both drivers apply to a sequence of frame hashes sampled at a fixed
 * interval: the newest hash once `stableFrames` consecutive samples repeated it, or — because a
 * focused EditText blinks its caret on a 530ms cycle and never produces N identical frames — the
 * more frequent of exactly two hashes alternating over a window of `2 * stableFrames` samples.
 * Alternating means at least three changes inside the window: a screen that changed once and
 * then held is a run in progress, not an oscillation, and must not settle on its stale frame.
 * Undefined while neither holds. Pure and closure-free: the webdroid driver serialises it into
 * the page, so it must not reference anything outside itself.
 */
export function stableFrame<H>(samples: H[], stableFrames = 4): H | undefined {
  const n = samples.length;
  const win = stableFrames * 2;
  if (n >= win) {
    const tally: [H, number][] = [];
    let changes = 0;
    for (let i = n - win; i < n; i++) {
      const h = samples[i];
      if (i > n - win && h !== samples[i - 1]) changes++;
      const e = tally.find((t) => t[0] === h);
      if (e) e[1]++; else tally.push([h, 1]);
    }
    if (tally.length === 2 && changes >= 3 && tally[0][1] >= 2 && tally[1][1] >= 2) return tally[0][1] >= tally[1][1] ? tally[0][0] : tally[1][0];
  }
  if (n <= stableFrames) return undefined;
  const last = samples[n - 1];
  for (let i = n - 1 - stableFrames; i < n - 1; i++) if (samples[i] !== last) return undefined;
  return last;
}
