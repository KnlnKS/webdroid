// A realm's recent frame-path events, for attributing latency and pacing (pnpm lat reads a
// window of it after the window closes). Marks go into a fixed ring of numbers: no allocation,
// about the cost of a performance.now(), so it is always on.
export const Ev = {
  /** the host's display frame (arg: 1 when it was a virtual vsync), or an early vsync (arg 2, vsync.ts startEarly) */ Raf: 1,
  /** a pointer reached the realm (arg: action) */ InputIn: 2,
  /** InputDispatcher published an event to a window */ InputPublish: 3,
  /** the window's looper began dispatching it */ InputDispatch: 4,
  /** the window finished it (arg: 1 if handled) */ InputDone: 5,
  /** Choreographer.doFrame began on the main looper (arg: frame) */ FrameBegin: 6,
  /** and returned */ FrameEnd: 7,
  /** hwui began replaying a window's tree */ DrawBegin: 8,
  /** and had replayed it */ DrawEnd: 9,
  /** a buffer was queued to its layer */ Queue: 10,
  /** composition began */ CompositeBegin: 11,
  /** and ended */ CompositeEnd: 12,
  /** the composed frame went to the screen */ Present: 13,
  /** the main looper went idle (arg: its timeout) */ LoopIdle: 14,
  /** and woke */ LoopWake: 15,
  /** the yield channel began a turn */ Turn: 16,
  /** Java began running on another thread (arg: 0 none, 1 the main thread, else 2 + its strand) */ Thread: 17,
  /** a link began waiting for the build's code module (arg: its number) */ Prepare: 18,
  /** and the wait ended (arg: the module, negative when the bound ended it first) */ Prepared: 19,
  /** a call went to another realm (arg: the method's index in its contract) */ Call: 20,
  /** and its answer arrived (arg: the same) */ Answer: 21,
  /** the compile worker's answer is being taken, and the next job planned (arg: the job's slot) */ Upgrade: 22,
  /** and that is done */ Upgraded: 23,
  /** the process became visible (1) or not (0) */ Visible: 24,
  /** a call from another realm arrived (arg: the method's index in the endpoint) */ Serve: 25,
  /** and its answer was sent (arg: the same) */ Served: 26,
} as const;
type Ev = typeof Ev[keyof typeof Ev];
const SIZE = 1 << 15, ring = new Float64Array(SIZE * 3);
let next = 0;
export function note(ev: Ev, arg = 0): void {
  const i = (next++ & (SIZE - 1)) * 3;
  ring[i] = performance.now(); ring[i + 1] = ev; ring[i + 2] = arg;
}
/** the events since `from` (this realm's clock), oldest first, as [time on the page clock (ms since timeOrigin of the caller's choosing), event, arg] */
export function timelineSince(from: number): [number, number, number][] {
  const out: [number, number, number][] = [], n = Math.min(next, SIZE);
  for (let k = next - n; k < next; k++) {
    const i = (k & (SIZE - 1)) * 3;
    if (ring[i] >= from) out.push([ring[i] + performance.timeOrigin, ring[i + 1], ring[i + 2]]);
  }
  return out;
}
