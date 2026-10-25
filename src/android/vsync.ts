// The display's vsync: the host's frame loop paces a virtual vsync at the display's refresh rate,
// and DisplayEventReceiver's natives deliver it to every receiver that scheduled one (each
// Choreographer, per looper) as a callback on that receiver's looper, as SurfaceFlinger's event
// thread wakes its fd there.
import { rt, driven, type Gen, type JObj } from "../jvm/runtime.ts";
import { mangleField } from "../jvm/abi.ts";
import { vcall, newObj, after } from "../jvm/natives/jentry.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { type NativeLooper, mainLooper, postMain } from "./mainloop.ts";
import { perf } from "../perf.ts";
import { device } from "../shell/config.ts";
import { guestClockControl, uptimeMillis } from "../guest-clock.ts";
import { note, Ev } from "../timeline.ts";
import { processExited } from "../process-exit.ts";

let nextVsync = 0, vsyncWaiters: (() => void)[] = [], vsyncWatchdog: ReturnType<typeof setTimeout> | undefined;
const vsyncIntervalMs = (): number => 1000 / device.refreshRate;
/** Host frames this far apart have stopped (a hidden tab or canvas) rather than come slowly. A swap waits
 *  for a display that falls behind its rate, as a software rasterizer's does, rather than outrun it and
 *  starve the GPU process's other contexts. */
const STALLED_MS = 250;
let hostFrameAt = -Infinity;
function flushVsyncWaiters(): void {
  clearTimeout(vsyncWatchdog); vsyncWatchdog = undefined;
  const waiters = vsyncWaiters;
  vsyncWaiters = [];
  for (const resolve of waiters) resolve();
}
/** The next virtual vsync: what a blocking eglSwapBuffers waits for. A realm whose frame loop is
 *  not running (hidden page, background process) still advances, at the display's rate. */
export function vsync(): Promise<void> {
  return new Promise((resolve) => {
    vsyncWaiters.push(resolve);
    vsyncWatchdog ??= setTimeout(flushVsyncWaiters, performance.now() - hostFrameAt < STALLED_MS ? STALLED_MS : 2 * vsyncIntervalMs());
  });
}

/** `after`: a vsync answers it only once the time has passed this */
interface Receiver { looper: NativeLooper; receiver: JObj; data: JObj; after: number }
const scheduled = new Set<Receiver>();
let frame = 0;
const DATA = "android/view/DisplayEventReceiver$VsyncEventData", TIMELINE = DATA + "$FrameTimeline";
const F = {
  timelines: mangleField(DATA, "frameTimelines"), preferred: mangleField(DATA, "preferredFrameTimelineIndex"),
  length: mangleField(DATA, "frameTimelinesLength"), interval: mangleField(DATA, "frameInterval"),
  vsyncId: mangleField(TIMELINE, "vsyncId"), present: mangleField(TIMELINE, "expectedPresentationTime"),
  deadline: mangleField(TIMELINE, "deadline"),
};
let latest = { at: -Infinity, nanos: 0n, frame: 0 };
/** VsyncEventData as NativeDisplayEventReceiver fills it: the browser predicts one presentation, a
 *  frame interval out, which is also the deadline */
function fill(data: Record<string, unknown>): void {
  const interval = device.frameIntervalNanos, timeline = (data[F.timelines] as Record<string, unknown>[])[0];
  data[F.preferred] = 0; data[F.length] = 1; data[F.interval] = interval;
  timeline[F.vsyncId] = BigInt(latest.frame);
  timeline[F.present] = timeline[F.deadline] = latest.nanos + interval;
}
const ref = (weak: JObj): JObj | null | Promise<JObj | null> => vcall(weak, "get", "()Ljava/lang/Object;");

/** The host's frame period: the mean of its recent frame spacings, which cancels jitter (an early frame shortens one
 *  gap by what it lengthens the next), leaving out the spacings of skipped frames, longer than 1.5 times the median. */
const hostGaps = new Float64Array(16), sortedGaps = new Float64Array(16);
let hostGapCount = 0, lastHostFrame = -Infinity, hostPeriodMs = Infinity;
function noteHostGap(gap: number): void {
  hostGaps[hostGapCount++ % hostGaps.length] = gap;
  const n = Math.min(hostGapCount, hostGaps.length);
  // the period changes only with the display, so a fresh estimate every 8 frames is enough
  if (n < 4 || hostGapCount % 8 && hostPeriodMs !== Infinity) return;
  sortedGaps.set(hostGaps);
  const sorted = sortedGaps.subarray(0, n).sort(), limit = sorted[n >> 1] * 1.5;
  let sum = 0, count = 0;
  for (const g of sorted) if (g <= limit) { sum += g; count++; }
  hostPeriodMs = sum / count;
}
/** a host display frame: true when it is a virtual vsync, delivered now to every receiver that asked */
export function recordVsync(time: number): boolean {
  hostFrameAt = performance.now();
  const interval = vsyncIntervalMs(), gap = time - lastHostFrame;
  lastHostFrame = time;
  if (gap > 1 && gap < STALLED_MS) noteHostGap(gap);
  if (!nextVsync) nextVsync = time;
  // A frame up to half a period early is the vsync it is nearest, but no more than half a host frame early: a host frame
  // that divides the period puts the frame between two vsyncs right on the half-period boundary, where jitter would take
  // it one time and its successor the next (8 and 25 ms frames from a 120 Hz host at 60 Hz). Re-anchor missed periods so
  // host jitter cannot straddle a stale phase boundary.
  const elapsed = time + Math.min(interval, hostPeriodMs) / 2 - nextVsync;
  if (elapsed < 0) { note(Ev.Raf, 0); return false; }
  note(Ev.Raf, 1);
  // An anchor taken from one jittered frame drifts toward the frames' mean phase, so the tolerance stays centred on it.
  nextVsync = elapsed < interval ? nextVsync + interval + (time - nextVsync) / 8 : time + interval;
  deliver(false);
  return true;
}
/** The animation frame whose task is running, if one is: a picture handed over in that task is shown with that frame, one handed over later with the next */
let displayFrameAt = -Infinity, inDisplayFrame = false;
const frameOver = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
if (frameOver) {
  frameOver.port1.onmessage = () => { inDisplayFrame = false; };
  (frameOver.port1 as unknown as { unref?: () => void }).unref?.();
}
function displayFrame(time: number): void { displayFrameAt = time; inDisplayFrame = true; frameOver?.port2.postMessage(0); }
/** when the host display frame that shows a picture handed over now began: presentation intervals as the display has them, free of when in its frame the app finished */
export function shownFrameAt(now = performance.now()): number {
  if (inDisplayFrame || displayFrameAt === -Infinity) return inDisplayFrame ? displayFrameAt : now;
  const period = Math.min(vsyncIntervalMs(), hostPeriodMs);
  return displayFrameAt + period * Math.ceil((now - displayFrameAt) / period);
}
/** The host's frame loop: an animation frame while the realm has them (a process Worker's come with
 *  the canvas it presents to), a timer while the browser runs none, as in a hidden tab */
function hostFrames(frame: (time: number) => void): void {
  let framed = -Infinity;
  const loop = (time: number) => { framed = performance.now(); displayFrame(time); frame(time); requestAnimationFrame(loop); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(loop);
  setInterval(() => { if (performance.now() - framed > 40) frame(performance.now()); }, 33);
}
/** whether this process's windows are on screen, which its display's vsyncs follow */
let shown = true;
export const displayShown = (): boolean => shown;
export function setDisplayShown(visible: boolean): void { note(Ev.Visible, +visible); shown = visible; }
/** This realm's display: the host's frame loop drives its vsyncs while its windows show and its process lives, after
 *  `frame` (the page's pointer drain) on every host frame. Answers the vsyncs it has had. */
export function startDisplayLoop(visible: boolean, frame?: () => void): () => number {
  let ticks = 0;
  shown = visible;
  hostFrames(time => {
    frame?.();
    if (shown && !processExited() && recordVsync(time)) ticks++;
  });
  return () => ticks;
}
export const vsyncScheduled = (): boolean => scheduled.size > 0 || vsyncHooks.length > 0;
let vsyncHooks: { fn: () => void; after: number }[] = [];
/** run `fn` at a vsync later than the latest: a renderer drawing on its own cadence only steps its
 *  animators, a draw hwui declines twice at one vsync (CanvasContext::canDrawThisFrame) */
export function onNextVsync(fn: () => void): void { vsyncHooks.push({ fn, after: latest.at }); }
let frameStart: number | null = null;
/** the renderer drew the main thread's frame */
export function frameDrawn(): void {
  if (frameStart === null) return;
  perf.completedFrames++; perf.frameMs += performance.now() - frameStart;
  frameStart = null;
}
/** a vsync now, outside the display's pacing: a test harness stepping frames on a controlled clock */
export function deliverVsync(): void { deliver(true); }
/** A frame's request for the next vsync is answered by a later display vsync, as a display's are a
 *  refresh period apart; under a controlled clock time can stand still, and a time-driven animation
 *  (a ValueAnimator's every update invalidates) then waits for time to pass rather than redraw the
 *  same frame at every host refresh. A `stepped` vsync answers every receiver. */
function deliver(stepped: boolean): void {
  const at = uptimeMillis();
  latest = { at, nanos: BigInt(Math.floor(at * 1e6)), frame: ++frame };
  const { nanos, frame: count } = latest;
  const later = (r: { after: number }) => at > r.after;
  const hooks = vsyncHooks.filter(later).map(h => h.fn);
  vsyncHooks = vsyncHooks.filter(h => !later(h));
  const dispatch = (r: Receiver) => {
    fill(r.data as never);
    r.looper.frameAt = at;
    return vcall(r.receiver, "dispatchVsync", "(JJI)V", nanos, 0n, count);
  };
  let mainFrame = false;
  for (const r of scheduled) {
    if (!stepped && !later(r)) continue;
    scheduled.delete(r);
    if (r.looper !== mainLooper) { r.looper.post(() => dispatch(r)); continue; }
    mainFrame = true;
    framesOpen++;
    // the main thread's frame is the Choreographer.doFrame this vsync starts, as a message the
    // receiver queues; it completes when the renderer draws it. Behind that message the frame
    // closes even when it drew nothing, and the renderer's own draws yield to the one it made.
    r.looper.post(() => {
      perf.frames++;
      const opened = frameStart = performance.now();
      note(Ev.FrameBegin, count);
      return after(dispatch(r), () => postMain(() => {
        note(Ev.FrameEnd, count);
        if (frameStart === opened) frameStart = null;
        framesOpen--;
        for (const fn of hooks.splice(0)) fn();
        startEarly();
      }));
    });
  }
  if (!mainFrame) for (const fn of hooks) fn();
  flushVsyncWaiters();
}

/** main-thread frames dispatched and not yet closed; an early frame is pending; until when an input's dispatch lets the next frame begin early */
let framesOpen = 0, early = false, promptUntil = -Infinity;
/** An input event (a touch down or up, a key) is being dispatched: the frame the main thread asks for next, if it asks within a refresh period, begins as soon as
 *  no other frame is being made (startEarly), and so does one it already asked for, as a running animation (a press ripple) has: either is queued behind the input */
export function inputFrame(): void {
  promptUntil = performance.now() + vsyncIntervalMs();
  startEarly();
}
/** whether the main thread's frame may begin now: it asked for one, none is being made, the frame loop is live (a shown display), and an input prompts it or
 *  the latest vsync is a period old */
function earlyDue(): boolean {
  if (framesOpen || guestClockControl.controlled) return false;
  const now = performance.now();
  if (now - hostFrameAt >= STALLED_MS || now >= promptUntil && uptimeMillis() - latest.at < vsyncIntervalMs()) return false;
  for (const r of scheduled) if (r.looper === mainLooper) return true;
  return false;
}
/** A frame the main thread asks for begins at once, rather than at the display's next refresh (on average half a period later), when it answers an input
 *  or the latest vsync is a period old (an idle display, or a frame that overran its period), as a compositor that begins frames on demand does: a frame
 *  that takes longer than a period, as one that answers a tap does, is then shown a period sooner whenever it would have finished just after a refresh. A frame being made defers it to that frame's
 *  end, so frames never overlap, and an input allows one. It is the display's vsync: its phase re-anchors on it, and what waits for a vsync goes on, so the
 *  frames that follow keep to the display's refreshes. Under a controlled clock frames come only when time passes. */
function startEarly(): void {
  if (early || !earlyDue()) return;
  early = true;
  queueMicrotask(() => {
    early = false;
    if (!earlyDue()) return;
    promptUntil = -Infinity;
    perf.earlyFrames++;
    note(Ev.EarlyVsync);
    nextVsync = performance.now() + vsyncIntervalMs();
    deliver(false);
  });
}

const PTR = mangleField("android/os/MessageQueue", "mPtr");
rt.registerJnis("android/view/DisplayEventReceiver", {
  "nativeInit(Ljava/lang/ref/WeakReference;Ljava/lang/ref/WeakReference;Landroid/os/MessageQueue;IIJ)J":
    driven(function* (receiver: JObj, data: JObj, queue: Record<string, bigint>): Gen<bigint> {
      // Java weak-reference reads may wait; native state must hold their referents.
      const r = yield ref(receiver), d = yield ref(data);
      if (!r || !d) throw rt.mkThrowable("java/lang/RuntimeException", "Failed to initialize display event receiver.");
      return handle({ looper: deref<NativeLooper>(queue[PTR]), receiver: r, data: d, after: -Infinity } satisfies Receiver);
    }),
  "nativeGetDisplayEventReceiverFinalizer()J": () => FINALIZER,
  "nativeScheduleVsync(J)V": (ptr: bigint) => {
    const r = deref<Receiver>(ptr);
    r.after = r.looper.frameAt;
    scheduled.add(r);
    if (r.looper === mainLooper) startEarly();
  },
  "nativeGetLatestVsyncEventData(J)Landroid/view/DisplayEventReceiver$VsyncEventData;": async () => {
    const data = await newObj(DATA, "()V");
    fill(data);
    return data;
  },
});
