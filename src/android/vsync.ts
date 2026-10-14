// The display's vsync: the host's frame loop paces a virtual vsync at the display's refresh rate,
// and DisplayEventReceiver's natives deliver it to every receiver that scheduled one (each
// Choreographer, per looper) as a callback on that receiver's looper, as SurfaceFlinger's event
// thread wakes its fd there.
import { rt, driven, type Gen, type JObj } from "../jvm/runtime";
import { mangleField } from "../jvm/abi";
import { vcall, newObj, after } from "../jvm/natives/jentry";
import { handle, deref, FINALIZER } from "./handles";
import { type NativeLooper, mainLooper, postMain } from "./mainloop";
import { perf } from "../perf";
import { device } from "../shell/config";
import { uptimeMillis } from "../guest-clock";
import { note, Ev } from "../timeline";

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

interface Receiver { looper: NativeLooper; receiver: JObj; data: JObj }
const scheduled = new Set<Receiver>();
let frame = 0;
const DATA = "android/view/DisplayEventReceiver$VsyncEventData", TIMELINE = DATA + "$FrameTimeline";
const F = {
  timelines: mangleField(DATA, "frameTimelines"), preferred: mangleField(DATA, "preferredFrameTimelineIndex"),
  length: mangleField(DATA, "frameTimelinesLength"), interval: mangleField(DATA, "frameInterval"),
  vsyncId: mangleField(TIMELINE, "vsyncId"), present: mangleField(TIMELINE, "expectedPresentationTime"),
  deadline: mangleField(TIMELINE, "deadline"),
};
let latest = { nanos: 0n, frame: 0 };
/** VsyncEventData as NativeDisplayEventReceiver fills it: the browser predicts one presentation, a
 *  frame interval out, which is also the deadline */
function fill(data: Record<string, unknown>): void {
  const interval = device.frameIntervalNanos, timeline = (data[F.timelines] as Record<string, unknown>[])[0];
  data[F.preferred] = 0; data[F.length] = 1; data[F.interval] = interval;
  timeline[F.vsyncId] = BigInt(latest.frame);
  timeline[F.present] = timeline[F.deadline] = latest.nanos + interval;
}
const ref = (weak: JObj): JObj | null | Promise<JObj | null> => vcall(weak, "get", "()Ljava/lang/Object;");

/** a host display frame: true when it is a virtual vsync, delivered now to every receiver that asked */
export function recordVsync(time: number): boolean {
  hostFrameAt = performance.now();
  const interval = vsyncIntervalMs();
  if (!nextVsync) nextVsync = time;
  // Re-anchor missed periods so host jitter cannot straddle a stale phase boundary.
  const elapsed = time + interval / 2 - nextVsync;
  if (elapsed < 0) { note(Ev.Raf, 0); return false; }
  note(Ev.Raf, 1);
  nextVsync = elapsed < interval ? nextVsync + interval : time + interval;
  deliverVsync();
  return true;
}
/** The host's frame loop: an animation frame while the realm has them (a process Worker's come with
 *  the canvas it presents to), a timer while the browser runs none, as in a hidden tab */
export function hostFrames(frame: (time: number) => void): void {
  let framed = -Infinity;
  const loop = (time: number) => { framed = performance.now(); frame(time); requestAnimationFrame(loop); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(loop);
  setInterval(() => { if (performance.now() - framed > 40) frame(performance.now()); }, 33);
}
export const vsyncScheduled = (): boolean => scheduled.size > 0 || vsyncHooks.length > 0;
let vsyncHooks: (() => void)[] = [];
/** run `fn` at the next vsync: a renderer drawing on its own cadence */
export function onNextVsync(fn: () => void): void { vsyncHooks.push(fn); }
let frameStart: number | null = null;
/** the renderer drew the main thread's frame */
export function frameDrawn(): void {
  if (frameStart === null) return;
  perf.completedFrames++; perf.frameMs += performance.now() - frameStart;
  frameStart = null;
}
/** a vsync now, outside the display's pacing: a test harness stepping frames on a controlled clock */
export function deliverVsync(): void {
  latest = { nanos: BigInt(Math.floor(uptimeMillis() * 1e6)), frame: ++frame };
  const { nanos, frame: count } = latest;
  const hooks = vsyncHooks;
  vsyncHooks = [];
  const dispatch = (r: Receiver) => { fill(r.data as never); return vcall(r.receiver, "dispatchVsync", "(JJI)V", nanos, 0n, count); };
  let mainFrame = false;
  for (const r of scheduled) {
    if (r.looper !== mainLooper) { r.looper.post(() => dispatch(r)); continue; }
    mainFrame = true;
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
        for (const fn of hooks.splice(0)) fn();
      }));
    });
  }
  scheduled.clear();
  if (!mainFrame) for (const fn of hooks) fn();
  flushVsyncWaiters();
}

const PTR = mangleField("android/os/MessageQueue", "mPtr");
rt.registerJnis("android/view/DisplayEventReceiver", {
  "nativeInit(Ljava/lang/ref/WeakReference;Ljava/lang/ref/WeakReference;Landroid/os/MessageQueue;IIJ)J":
    driven(function* (receiver: JObj, data: JObj, queue: Record<string, bigint>): Gen<bigint> {
      // Java weak-reference reads may wait; native state must hold their referents.
      const r = yield ref(receiver), d = yield ref(data);
      if (!r || !d) throw rt.mkThrowable("java/lang/RuntimeException", "Failed to initialize display event receiver.");
      return handle({ looper: deref<NativeLooper>(queue[PTR]), receiver: r, data: d } satisfies Receiver);
    }),
  "nativeGetDisplayEventReceiverFinalizer()J": () => FINALIZER,
  "nativeScheduleVsync(J)V": (ptr: bigint) => { scheduled.add(deref<Receiver>(ptr)); },
  "nativeGetLatestVsyncEventData(J)Landroid/view/DisplayEventReceiver$VsyncEventData;": async () => {
    const data = await newObj(DATA, "()V");
    fill(data);
    return data;
  },
});
