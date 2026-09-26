import type { Act } from "./probe";
import type { Screen } from "../types";

export type EnvironmentConfig = { fixedMs: number | null; storage: [string, string][] };

function installEnvironment(cfg: EnvironmentConfig): void {
  if (self !== top) return;
  const g = globalThis as any;
  if (cfg.fixedMs !== null) {
    const RealDate = g.Date, fixed = cfg.fixedMs;
    const Pinned = function (this: unknown, ...a: unknown[]) {
      if (!new.target) return new RealDate(fixed).toString();
      return a.length ? new (RealDate as any)(...a) : new RealDate(fixed);
    } as any;
    Object.setPrototypeOf(Pinned, RealDate);
    Pinned.prototype = RealDate.prototype;
    Pinned.now = () => fixed;
    g.Date = Pinned;
    // java.util.Random seeds from Date.now() ^ Math.random(): pin both and games replay the same draws
    let seed = fixed >>> 0;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (const [k, v] of cfg.storage) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
}

export const environmentScript = (cfg: EnvironmentConfig): string => `(${installEnvironment.toString()})(${JSON.stringify(cfg)})`;

// Self-contained because Playwright and the probe serialize this function into the page.
export async function performAction(input: { a: Act; screen: Screen; deadlineMs: number; controlled?: boolean }): Promise<boolean | undefined> {
  const withDeadline = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms`)), ms); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  const { a, screen: s, deadlineMs } = input;
  const wd = globalThis.wd;
  const sleep = input.controlled && wd.guestClock?.controlled
    ? (ms: number) => wd.guestClock.advanceBy(ms)
    : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const run = (operation: Promise<unknown>) => withDeadline(
    input.controlled && wd.guestClock?.controlled ? wd.guestClock.drive(operation, deadlineMs) : operation,
    deadlineMs,
    a.type,
  );
  switch (a.type) {
    case "boot": await run(wd.boot(a.apk)); return;
    case "tapText": {
      const hit = wd.locateText(a.text) as { x: number; y: number } | null;
      if (hit) await run(wd.tap(hit.x, hit.y));
      else if (a.fallback) await run(wd.tap(a.fallback.x * s.width, a.fallback.y * s.height));
      return !!hit;
    }
    case "tap":
      if (a.unlessResource && (await wd.uiTree()).some((node: { resId: string; bounds: [number, number, number, number] }) =>
        node.resId === a.unlessResource && node.bounds[2] > 0 && node.bounds[3] > 0 &&
        node.bounds[0] < s.width && node.bounds[1] < s.height)) return;
      if (a.whileText) {
        const maxTaps = a.repeat ?? 1;
        const interval = a.everyMs ?? 500;
        const end = performance.now() + Math.max(1500, maxTaps * interval + 800);
        let taps = 0, absentAt = 0;
        while (performance.now() < end) {
          if (!wd.locateText(a.whileText)) {
            absentAt ||= performance.now();
            if (performance.now() - absentAt >= 400) break;
            await sleep(50);
          } else {
            absentAt = 0;
            if (taps >= maxTaps) break;
            await run(wd.tap(a.x * s.width, a.y * s.height));
            taps++;
            await sleep(interval);
          }
        }
      } else for (let i = 0; i < (a.repeat ?? 1); i++) {
        if (i) await sleep(a.everyMs ?? 500);
        await run(wd.tap(a.x * s.width, a.y * s.height));
      }
      return;
    case "type":
      if (a.x !== undefined && a.y !== undefined) { await run(wd.tap(a.x * s.width, a.y * s.height)); await sleep(250); }
      await run(wd.type(a.text));
      return;
    case "back": await run(wd.back()); return;
    case "enter": await run(wd.enter()); return;
    case "background": await run(wd.background(a.ms)); return;
    case "swipe": {
      const count = a.maxSwipes ?? 1;
      for (let i = 0; i < count; i++) {
        if (a.untilText && await Promise.resolve(wd.locateText(a.untilText))) return;
        await run(wd.swipe(a.from[0] * s.width, a.from[1] * s.height, a.to[0] * s.width, a.to[1] * s.height, a.ms));
        if (a.untilText) await sleep(500);
      }
      return;
    }
    case "none": return;
  }

}
