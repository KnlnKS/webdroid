import { expect, test } from "bun:test";
import "../natives";
import { rt, JObj } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { dispatchVsync } from "./os";
import { uiState } from "./view";

test("vsync callbacks share the frame clock and expire their timeline after returning", async () => {
  uiState.frameTimeNanos = 1000000000n;
  uiState.frameIntervalNanos = 16666667n;
  let captured: JObj, timeline: JObj;
  const cb = Object.assign(new JObj(), {
    [mangleMethod("onVsync", "(Landroid/view/Choreographer$FrameData;)V")]: async (data: JObj) => {
      captured = data;
      expect(await vcall(data, "getFrameTimeNanos", "()J")).toBe(1000000000n);
      const timelines = await vcall(data, "getFrameTimelines", "()[Landroid/view/Choreographer$FrameTimeline;");
      timeline = await vcall(data, "getPreferredFrameTimeline", "()Landroid/view/Choreographer$FrameTimeline;");
      expect(timelines).toHaveLength(1);
      expect(timelines[0]).toBe(timeline);
      expect(await vcall(timeline, "getExpectedPresentationTimeNanos", "()J")).toBe(1016666667n);
      expect(await vcall(timeline, "getDeadlineNanos", "()J")).toBe(1016666667n);
    },
  });
  await dispatchVsync(cb);
  await expect(vcall(captured!, "getFrameTimeNanos", "()J")).rejects.toThrow();
  await expect(vcall(timeline!, "getVsyncId", "()J")).rejects.toThrow();
});

test("removing a vsync callback preserves other queued frame work", async () => {
  const choreographer = rt.link("android/view/Choreographer").ctor[mangleMethod("getInstance", "()Landroid/view/Choreographer;")]();
  const cb = new JObj(), other = new JObj();
  const old = uiState.frameCallbacks;
  uiState.frameCallbacks = [{ frame: cb }];
  try {
    for (const value of [cb, other, cb]) await vcall(choreographer, "postVsyncCallback", "(Landroid/view/Choreographer$VsyncCallback;)V", value);
    await vcall(choreographer, "removeVsyncCallback", "(Landroid/view/Choreographer$VsyncCallback;)V", cb);
    expect(uiState.frameCallbacks).toEqual([{ frame: cb }, { vsync: other }]);
    await expect(vcall(choreographer, "postVsyncCallback", "(Landroid/view/Choreographer$VsyncCallback;)V", null)).rejects.toThrow();
  } finally { uiState.frameCallbacks = old; }
});
