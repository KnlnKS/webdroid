import { expect, test } from "bun:test";
import { onNextVsync, recordVsync } from "../src/android/vsync";
import { device } from "../src/shell/config";

test("virtual vsync tolerates host jitter, caps refresh rates and drops missed periods", () => {
  const saved = device.refreshRate;
  let start = 1000;
  try {
    device.refreshRate = 60;
    let delivered = 0, accepted = 0;
    for (let i = 0; i < 600; i++) {
      onNextVsync(() => delivered++);
      accepted += +recordVsync(start + i * 1000 / 60 + (i % 2 ? -1.8 : 0));
    }
    expect(accepted).toBe(600);
    expect(delivered).toBe(600);
    for (const rate of [30, 60, 90, 120]) for (const host of [30, 60, 90, 120, 144, 240]) {
      device.refreshRate = rate;
      start += 20_000;
      let frames = 0;
      for (let i = 0; i < host * 10; i++) frames += +recordVsync(start + i * 1000 / host);
      expect(Math.abs(frames - 10 * Math.min(rate, host))).toBeLessThanOrEqual(1);
    }
    device.refreshRate = 60;
    start += 20_000;
    expect(recordVsync(start)).toBe(true);
    expect(recordVsync(start + 30)).toBe(true);
    expect(recordVsync(start + 30)).toBe(false);
    expect(recordVsync(start + 30.1)).toBe(false);
    expect(recordVsync(start + 800)).toBe(true);
    expect(recordVsync(start + 800)).toBe(false);
    expect(recordVsync(start + 816.7)).toBe(true);
  } finally {
    device.refreshRate = saved;
  }
});
