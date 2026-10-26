// AChoreographer (choreographer.h): one per looper thread, whose frame callbacks run there at the first vsync after they
// fall due, as DisplayEventDispatcher's fd wakes that looper, never twice at one vsync time. The display's period never
// changes, so a refresh rate callback hears it once, as handleRefreshRateUpdates calls a new callback.

import { ptr, type ArgReader, type HostFn } from "./host.ts";
import { Handles } from "./handles.ts";
import type { Cpu } from "./cpu.ts";
import { setGuestTimeout, uptimeMillis } from "../guest-clock.ts";
import { presentedAt, requestVsync, type Vsync } from "../android/vsync.ts";
import { device } from "../shell/config.ts";

interface FrameCallback { fn: number; kind: "long" | "int64" | "vsync"; data: number | bigint; due: number }
/** the AChoreographerFrameCallbackData of the vsync callbacks running */
const frameData = new Handles<Vsync>("AChoreographerFrameCallbackData");
const FD = (a: ArgReader) => frameData.get(a.p());

export class Choreographer {
  readonly cpu: Cpu;
  /** runs a job on the thread between its looper's messages */
  private readonly onLooper: (job: () => Promise<unknown>) => void;
  private callbacks: FrameCallback[] = [];
  private requested = false; private lastAt = -Infinity;
  rates: { fn: number; data: number | bigint }[] = [];
  constructor(cpu: Cpu, onLooper: (job: () => Promise<unknown>) => void) { this.cpu = cpu; this.onLooper = onLooper; }
  post(cb: FrameCallback, delay: number): void {
    this.callbacks.push(cb);
    if (delay) setGuestTimeout(() => this.request(), delay); else this.request();
  }
  addRate(fn: number, data: number | bigint): void {
    if (this.rates.some((r) => r.fn === fn && r.data === data)) return;
    const rate = { fn, data };
    this.rates.push(rate);
    this.onLooper(async () => { if (this.rates.includes(rate)) await this.cpu.call(fn, [device.frameIntervalNanos, data], "AChoreographer refresh rate callback"); });
  }
  private request(): void {
    if (this.requested) return;
    this.requested = true;
    requestVsync(this.lastAt, (v) => this.onLooper(() => this.dispatch(v)));
  }
  private async dispatch(v: Vsync): Promise<void> {
    this.requested = false; this.lastAt = v.at;
    const now = uptimeMillis(), due = this.callbacks.filter((cb) => cb.due <= now);
    this.callbacks = this.callbacks.filter((cb) => cb.due > now);
    for (const cb of due) {
      if (cb.kind !== "vsync") {
        // a long is 32 bits on ARM32
        await this.cpu.call(cb.fn, [cb.kind === "long" && !this.cpu.a64 ? Number(BigInt.asIntN(32, v.nanos)) : v.nanos, cb.data], "AChoreographer frame callback");
        continue;
      }
      const id = frameData.add(v);
      try { await this.cpu.call(cb.fn, [id, cb.data], "AChoreographer vsync callback"); } finally { frameData.delete(id); }
    }
  }
}

/** libandroid's AChoreographer calls: `instance` is the calling thread's handle, `at` the choreographer a handle names */
export function choreographerLib(instance: (cpu: Cpu) => number, at: (h: number) => Choreographer | undefined): Record<string, HostFn> {
  const postFrame = (kind: FrameCallback["kind"], delayed = false): HostFn => (_c, a) => {
    const c = at(a.p()), fn = a.p(), data = ptr(a.p()), delay = delayed ? Math.max(0, a.i()) : 0;
    if (c && fn) c.post({ fn, kind, data, due: uptimeMillis() + delay }, delay);
  };
  const rate = (a: ArgReader) => ({ c: at(a.p()), fn: a.p(), data: ptr(a.p()) });
  return {
    AChoreographer_getInstance: instance,
    AChoreographer_postFrameCallback: postFrame("long"), AChoreographer_postFrameCallbackDelayed: postFrame("long", true),
    AChoreographer_postFrameCallback64: postFrame("int64"), AChoreographer_postFrameCallbackDelayed64: postFrame("int64", true),
    AChoreographer_postVsyncCallback: postFrame("vsync"),
    AChoreographer_registerRefreshRateCallback: (_c, a) => { const { c, fn, data } = rate(a); if (c && fn) c.addRate(fn, data); },
    AChoreographer_unregisterRefreshRateCallback: (_c, a) => {
      const { c, fn, data } = rate(a);
      if (c) c.rates = c.rates.filter((r) => r.fn !== fn || r.data !== data);
    },
    // one frame timeline, as DisplayEventReceiver's VsyncEventData has it
    AChoreographerFrameCallbackData_getFrameTimeNanos: (_c, a) => FD(a).nanos,
    AChoreographerFrameCallbackData_getFrameTimelinesLength: () => 1,
    AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex: () => 0,
    AChoreographerFrameCallbackData_getFrameTimelineVsyncId: (_c, a) => BigInt(FD(a).frame),
    AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos: (_c, a) => presentedAt(FD(a)),
    AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos: (_c, a) => presentedAt(FD(a)),
  };
}
