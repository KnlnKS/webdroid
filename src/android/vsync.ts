// The display's vsync: the host's frame loop paces a virtual vsync at the display's refresh rate,
// and DisplayEventReceiver's natives deliver it to every receiver that scheduled one (each
// Choreographer, per looper) as a callback on that receiver's looper, as SurfaceFlinger's event
// thread wakes its fd there.
import { rt, type JObj } from "../jvm/runtime";
import { mangleField } from "../jvm/abi";
import { vcall, newObj, scall, callOn, after, mainThread } from "../jvm/natives/jlang";
import { handle, deref, FINALIZER } from "./handles";
import { type NativeLooper } from "./mainloop";
import { device } from "../shell/config";
import { uptimeMillis } from "../guest-clock";

let nextVsync = 0, vsyncWaiters: (() => void)[] = [], vsyncWatchdog: ReturnType<typeof setTimeout> | undefined;
const vsyncIntervalMs = (): number => 1000 / device.refreshRate;
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
    vsyncWatchdog ??= setTimeout(flushVsyncWaiters, 2 * vsyncIntervalMs());
  });
}

interface Receiver { looper: NativeLooper; receiver: JObj; data: JObj; scheduled: boolean }
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
const ref = (weak: JObj): JObj | null => vcall(weak, "get", "()Ljava/lang/Object;");

/** a host display frame: true when it is a virtual vsync, delivered now to every receiver that asked */
export function recordVsync(time: number): boolean {
  // Allow sub-millisecond rAF jitter without skipping a virtual display frame.
  if (nextVsync && time + 0.75 < nextVsync) return false;
  const interval = vsyncIntervalMs();
  nextVsync = !nextVsync || time > nextVsync + interval ? time + interval : nextVsync + interval;
  deliverVsync();
  return true;
}
export const vsyncScheduled = (): boolean => scheduled.size > 0;
/** a vsync now, outside the display's pacing: a test harness stepping frames on a controlled clock */
export function deliverVsync(): void {
  latest = { nanos: BigInt(Math.floor(uptimeMillis() * 1e6)), frame: ++frame };
  const { nanos, frame: count } = latest;
  for (const r of scheduled) {
    r.scheduled = false;
    r.looper.post(() => {
      fill(r.data as never);
      return vcall(r.receiver, "dispatchVsync", "(JJI)V", nanos, 0n, count);
    });
  }
  scheduled.clear();
  flushVsyncWaiters();
}

const PTR = mangleField("android/os/MessageQueue", "mPtr");
rt.registerJnis("android/view/DisplayEventReceiver", {
  "nativeInit(Ljava/lang/ref/WeakReference;Ljava/lang/ref/WeakReference;Landroid/os/MessageQueue;IIJ)J":
    (receiver: JObj, data: JObj, queue: Record<string, bigint>) => {
      const r = ref(receiver), d = ref(data);
      if (!r || !d) throw rt.mkThrowable("java/lang/RuntimeException", "Failed to initialize display event receiver.");
      return handle({ looper: deref<NativeLooper>(queue[PTR]), receiver: r, data: d, scheduled: false } satisfies Receiver);
    },
  "nativeGetDisplayEventReceiverFinalizer()J": () => FINALIZER,
  "nativeScheduleVsync(J)V": (ptr: bigint) => {
    const r = deref<Receiver>(ptr);
    if (!r.scheduled) { r.scheduled = true; scheduled.add(r); }
  },
  "nativeGetLatestVsyncEventData(J)Landroid/view/DisplayEventReceiver$VsyncEventData;": async () => {
    const data = await newObj(DATA, "()V");
    fill(data);
    return data;
  },
});

export const CALLBACK_ANIMATION = 1, CALLBACK_TRAVERSAL = 3;
let choreographer: unknown = null;
/** the main thread's Choreographer (getInstance is per thread) */
export function mainChoreographer(): unknown {
  return choreographer ??= after(callOn(mainThread, () => scall("android/view/Choreographer", "getInstance", "()Landroid/view/Choreographer;")),
    (c: unknown) => choreographer = c);
}
