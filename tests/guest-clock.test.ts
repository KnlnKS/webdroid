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
});
