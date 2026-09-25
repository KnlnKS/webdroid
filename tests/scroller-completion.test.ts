import { expect, spyOn, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("a delayed first scroll tick exposes the final offset once before reporting completion", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    for (const cls of ["Scroller", "OverScroller"]) {
      const scroller = rt.make("android/widget/" + cls);
      await vcall(scroller, "startScroll", "(IIIII)V", 10, 20, 30, 40, 150);
      now += 300;
      expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(1);
      expect(await vcall(scroller, "getCurrY", "()I")).toBe(60);
      expect(await vcall(scroller, "isFinished", "()Z")).toBe(1);
      expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(0);
      await vcall(scroller, "startScroll", "(IIII)V", 10, 20, 0, 0);
      expect(await vcall(scroller, "isFinished", "()Z")).toBe(0);
    }
  } finally { clock.mockRestore(); }
});

test("OverScroller overfling passes the bound and springs back", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const scroller = rt.make("android/widget/OverScroller");
    await vcall(scroller, "fling", "(IIIIIIIIII)V", 0, 90, 0, 1000, 0, 0, 0, 100, 0, 20);
    const duration = await vcall(scroller, "getDuration", "()I") as number;
    now += Math.round(duration * 0.7);
    expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(1);
    expect(await vcall(scroller, "getCurrY", "()I")).toBe(120);
    now += duration;
    expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(1);
    expect(await vcall(scroller, "getCurrY", "()I")).toBe(100);
    expect(await vcall(scroller, "isFinished", "()Z")).toBe(1);
  } finally { clock.mockRestore(); }
});
