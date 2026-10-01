// The TS scrollers' drag velocity: an EWMA over one sample per frame.

/**
 * A finger that stops moving but stays down produces no samples at all, so the last move's speed
 * survives to the UP and flings a gesture the user had already brought to rest. Those frames did
 * have a velocity — zero — so feed it to them: n missing frames is the same weight applied n
 * times. One frame of silence is the normal cadence between a move and the up that follows it,
 * and costs nothing.
 */
export const restVelocity = (v: number, weight: number, idleMs: number) =>
  v * weight ** Math.max(0, idleMs / 16 - 1);

export const SCROLL_WEIGHT = 0.8;
/** arm a fling above this px/frame, decay it by DECAY each frame, stop below STOP */
export const FLING = { arm: 2, decay: 0.95, stop: 0.7 };
export const trackVelocity = (prev: number, d: number, dtMs: number) =>
  SCROLL_WEIGHT * prev + (1 - SCROLL_WEIGHT) * (d / dtMs * 16);
