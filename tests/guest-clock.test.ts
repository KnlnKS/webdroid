import { describe, expect, test } from "bun:test";
import { ControlledGuestClock } from "../src/guest-clock";

describe("ControlledGuestClock", () => {
  test("orders equal deadlines by realm then insertion and honours cancellation", () => {
    const clock = new ControlledGuestClock(100);
    const calls: string[] = [];
    clock.schedule(() => calls.push("realm-2"), 10, 2);
    const cancelled = clock.schedule(() => calls.push("cancelled"), 5, 0);
    clock.schedule(() => calls.push("realm-1-a"), 10, 1);
    clock.schedule(() => calls.push("realm-1-b"), 10, 1);
    clock.cancel(cancelled);

    expect(clock.advanceTo(110)).toBe(3);
    expect(calls).toEqual(["realm-1-a", "realm-1-b", "realm-2"]);
    expect(clock.pending()).toBe(0);
    expect(clock.nowMs).toBe(110);
  });

  test("cancels every callback owned by a disposed realm", () => {
    const clock = new ControlledGuestClock(0);
    const calls: number[] = [];
    clock.schedule(() => calls.push(1), 10, 1);
    clock.schedule(() => calls.push(2), 20, 2);

    expect(clock.cancelRealm(1)).toBe(1);
    expect(clock.advanceTo(30)).toBe(1);
    expect(calls).toEqual([2]);
    expect(clock.pending()).toBe(0);
  });
});
