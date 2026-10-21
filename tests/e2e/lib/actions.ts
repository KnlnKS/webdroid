import type { Act } from "./probe.ts";
import type { Screen, UiNode } from "../types.ts";

export type EnvironmentConfig = { fixedMs: number | null; storage: [string, string][] };

function installEnvironment(cfg: EnvironmentConfig): void {
  if (self !== top) return;
  const g = globalThis as any;
  if (cfg.fixedMs !== null) {
    // the wall clock starts at the fixed instant and advances as a device's does: an app timing
    // itself by currentTimeMillis (a splash's minimum duration) must see time pass
    const RealDate = g.Date, fixed = cfg.fixedMs - Math.floor(performance.now());
    const now = () => fixed + Math.floor(performance.now());
    const Pinned = function (this: unknown, ...a: unknown[]) {
      if (!new.target) return new RealDate(now()).toString();
      return a.length ? new (RealDate as any)(...a) : new RealDate(now());
    } as any;
    Object.setPrototypeOf(Pinned, RealDate);
    Pinned.prototype = RealDate.prototype;
    Pinned.now = now;
    g.Date = Pinned;
    // a seeded Math.random: games replay the same draws
    let seed = cfg.fixedMs >>> 0;
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
  // the realm whose window takes a point, or the focused field's keys
  const tap = (x: number, y: number): Promise<void> => wd.control(x, y).tap(x, y);
  const sleep: (ms: number) => Promise<unknown> = input.controlled && wd.guestClock?.controlled
    ? (ms: number) => wd.guestClock.advanceBy(ms)
    : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const run = (operation: Promise<unknown>) => withDeadline(
    input.controlled && wd.guestClock?.controlled ? wd.guestClock.drive(operation, deadlineMs) : operation,
    deadlineMs,
    a.type,
  );
  // queries need the main loop too: a wedged loop must fail the step, not hold the run
  const query = <T>(p: T | Promise<T>, what: string) => withDeadline(Promise.resolve(p), deadlineMs, what);
  const ready = async <T>(read: () => T | Promise<T>, what: string): Promise<NonNullable<T>> => {
    const end = performance.now() + deadlineMs;
    for (;;) {
      const remaining = end - performance.now();
      if (remaining <= 0) throw new Error(`${what} did not become ready within ${deadlineMs}ms`);
      const value = await withDeadline(Promise.resolve().then(read), remaining, what);
      if (value) return value as NonNullable<T>;
      await withDeadline(sleep(16), Math.max(1, end - performance.now()), what);
      if (input.controlled && wd.guestClock?.controlled)
        await withDeadline(wd.testFrame(), Math.max(1, end - performance.now()), what);
    }
  };
  // act while `text` shows, first waiting up to appearMs for it, at most `times` times, until it
  // has stayed away quietMs
  const whileShown = async (text: string, appearMs = 0, times: number, interval: number, act: () => Promise<unknown>, quietMs = 400) => {
    const start = performance.now(), end = start + appearMs + Math.max(1500, times * interval + 400 + quietMs);
    let acted = 0, absentAt = 0;
    while (performance.now() < end) {
      if (!await query(wd.locateText(text), "locateText")) {
        absentAt ||= performance.now();
        if (performance.now() - absentAt >= quietMs && (acted || performance.now() - start >= appearMs)) break;
        await sleep(50);
      } else {
        absentAt = 0;
        if (acted >= times) break;
        await run(act());
        acted++;
        await sleep(interval);
      }
    }
  };
  switch (a.type) {
    case "boot": await run(wd.boot(a.apk)); return;
    case "tapText": {
      const hit = a.required
        ? await ready(() => wd.locateText(a.text), `text ${JSON.stringify(a.text)}`)
        : await query(wd.locateText(a.text), "locateText") as { x: number; y: number } | null;
      if (hit) await run(tap(hit.x, hit.y));
      return !!hit;
    }
    case "tap":
      if (a.unlessResource && (await query(wd.uiTree(), "uiTree")).some((node: { resId: string; bounds: [number, number, number, number] }) =>
        node.resId === a.unlessResource && node.bounds[2] > 0 && node.bounds[3] > 0 &&
        node.bounds[0] < s.width && node.bounds[1] < s.height)) return;
      if (a.whileText) await whileShown(a.whileText, a.appearMs, a.repeat ?? 1, a.everyMs ?? 500, () => tap(a.x * s.width, a.y * s.height), a.quietMs);
      else for (let i = 0; i < (a.repeat ?? 1); i++) {
        if (i) await sleep(a.everyMs ?? 500);
        await run(tap(a.x * s.width, a.y * s.height));
      }
      return;
    case "type":
      if (a.x !== undefined && a.y !== undefined) {
        const x = a.x * s.width, y = a.y * s.height;
        if (input.controlled) await ready(async () => (await wd.uiTree()).some((node: UiNode) =>
          node.editable && node.enabled && node.bounds[0] <= x && x < node.bounds[2] && node.bounds[1] <= y && y < node.bounds[3]), "editable target");
        await run(tap(x, y)); await sleep(250);
      }
      await run(wd.control().type(a.text));
      return;
    case "back":
      if (a.whileText) await whileShown(a.whileText, a.appearMs, 1, 500, () => wd.back());
      else await run(wd.back());
      return;
    case "enter": await run(wd.control().enter()); return;
    case "background": await run(wd.background(a.ms)); return;
    case "swipe": {
      const [x1, y1, x2, y2] = [a.from[0] * s.width, a.from[1] * s.height, a.to[0] * s.width, a.to[1] * s.height];
      const swipe = () => wd.control(x1, y1).swipe(x1, y1, x2, y2, a.ms);
      if (a.whileText) { await whileShown(a.whileText, a.appearMs, a.maxSwipes ?? 1, a.ms + 500, swipe); return; }
      const count = a.maxSwipes ?? 1;
      for (let i = 0; i < count; i++) {
        if (a.untilText && await query(wd.locateText(a.untilText), "locateText")) return;
        await run(swipe());
        if (a.untilText) await sleep(500);
      }
      return;
    }
    case "none": return;
  }

}
