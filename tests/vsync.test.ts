import { expect, test } from "vite-plus/test";
import { recordVsync } from "../src/android/vsync.ts";
import { device } from "../src/shell/config.ts";

test("virtual vsync tolerates host jitter, caps refresh rates and drops missed periods", () => {
  const saved = device.refreshRate;
  let start = 1000;
  try {
    device.refreshRate = 60;
    let accepted = 0;
    for (let i = 0; i < 600; i++) {
      accepted += +recordVsync(start + i * 1000 / 60 + (i % 2 ? -1.8 : 0));
    }
    expect(accepted).toBe(600);
    start += 20_000;
    expect(recordVsync(start)).toBe(true);
    accepted = 0;
    for (let i = 1; i <= 600; i++) {
      accepted += +recordVsync(start + i * 1000 / 60 + 9 - (i % 2 ? 0 : 1.8));
    }
    expect(accepted).toBe(600);
    for (const rate of [30, 60, 90, 120]) for (const host of [30, 60, 90, 120, 144, 240]) {
      device.refreshRate = rate;
      start += 20_000;
      let frames = 0;
      for (let i = 0; i < host * 10; i++) frames += +recordVsync(start + i * 1000 / host);
      expect(Math.abs(frames - 10 * Math.min(rate, host))).toBeLessThanOrEqual(1);
    }
    // a 120 Hz host with jitter paces a 60 Hz display evenly: every other host frame, never one between
    device.refreshRate = 60;
    let seed = 1;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (const jitter of [0, 1.5, 2.5]) {
      start += 20_000;
      let skipped = 0, last = -1;
      for (let i = 0; i < 1200; i++) {
        if (!recordVsync(start + i * 1000 / 120 + (2 * random() - 1) * jitter)) continue;
        if (last >= 0 && i - last !== 2) skipped++;
        last = i;
      }
      expect(skipped).toBe(0);
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
