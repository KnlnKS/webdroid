import { device } from "./config.ts";

let measured: Promise<void> | undefined;
/** The host display's rate, from rAF spacing: skipped frames only lengthen intervals, so the
 *  lower quartile is the frame period even while page startup keeps the thread busy. */
export const displayRate = (): Promise<void> => measured ??= new URLSearchParams(location.search).has("hz") || document.hidden ? Promise.resolve() : new Promise<void>((resolve) => {
  const stamps: number[] = [];
  const sample = (time: number) => {
    stamps.push(time);
    if (stamps.length <= 12 && !document.hidden) { requestAnimationFrame(sample); return; }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    const hz = gaps.length ? 1000 / gaps[gaps.length >> 2] : 60;
    device.refreshRate = [60, 90, 120].reduce((best, rate) => Math.abs(rate - hz) < Math.abs(best - hz) ? rate : best);
    resolve();
  };
  requestAnimationFrame(sample);
});
