// hwui's WebViewFunctor: what RecordingCanvas.drawWebViewFunctor records. The WebView's content
// is a DOM frame over the display, so drawing a functor notes where it would draw — its view's
// bounds under the frame's transform, clipped — on the buffer being drawn. The display places each
// functor where the buffer it was drawn on composes, and hides the ones no composed buffer drew.
import { transformOf, type Ctx2D, type Mat2D } from "./recording.ts";
import { deviceBounds } from "./matrix.ts";

export type Rect = [number, number, number, number];
interface Functor {
  /** the view's size, in the coordinates the functor draws in */
  w: number; h: number;
  /** where the display shows the content this frame, or null when nothing composed it */
  place(rect: Rect | null): void;
}
const functors = new Map<number, Functor>();
let nextFunctor = 1;
export function createFunctor(f: Functor): number { functors.set(nextFunctor, f); return nextFunctor++; }
export function releaseFunctor(id: number): void { functors.get(id)?.place(null); functors.delete(id); }

/** per target canvas: each functor it drew this frame, in its pixels */
const drawn = new WeakMap<object, Map<number, Rect>>();
/** a target starts a frame: what it drew before is gone */
export function resetDrawn(target: object): void { drawn.get(target)?.clear(); }
export function drawnOn(target: object): Map<number, Rect> | undefined { return drawn.get(target); }

export const intersect = (a: Rect, b: Rect): Rect => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
/** the bounds of l..b under `m`, as a Rect the caller keeps */
export function deviceRect(m: Mat2D, l: number, t: number, r: number, b: number): Rect {
  const d = deviceBounds(m, l, t, r, b);
  return [d[0], d[1], d[2], d[3]];
}

/** the device clips of the render nodes being replayed, kept only while a functor exists */
const clips: Rect[] = [];
export const trackingClips = (): boolean => functors.size > 0;
export function pushClip(ctx: Ctx2D, l: number, t: number, r: number, b: number): void {
  const rect = deviceRect(transformOf(ctx), l, t, r, b);
  clips.push(clips.length ? intersect(clips[clips.length - 1], rect) : rect);
}
export function popClip(): void { clips.pop(); }

/** DrawFunctorOp: the functor's bounds on ctx's canvas, within `clip` (device pixels) and the clips
 *  of the nodes replaying it */
export function drawFunctor(ctx: Ctx2D, id: number, clip: Rect | null): void {
  const f = functors.get(id);
  if (!f) return;
  let rect = intersect(deviceRect(transformOf(ctx), 0, 0, f.w, f.h), [0, 0, ctx.canvas.width, ctx.canvas.height]);
  if (clip) rect = intersect(rect, clip);
  if (clips.length) rect = intersect(rect, clips[clips.length - 1]);
  if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
  let map = drawn.get(ctx.canvas);
  if (!map) drawn.set(ctx.canvas, map = new Map());
  map.set(id, rect);
}

/** the display composed: each functor at the rect it shows at, the rest hidden */
export function placeFunctors(placed: Map<number, Rect>): void {
  for (const [id, f] of functors) f.place(placed.get(id) ?? null);
}
