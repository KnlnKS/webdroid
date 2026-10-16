import { describe, expect, test } from "bun:test";
import { ControlledGuestClock } from "../src/guest-clock.ts";
import { connectClock, serveClock } from "../src/shell/clock-port.ts";

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

  test("remote callbacks acknowledge nested scheduling before the next deadline and cancel on death", async () => {
    const clock = new ControlledGuestClock(100), calls: string[] = [];
    const ports = new MessageChannel();
    let due = 0;
    const server = serveClock(ports.port1, clock, 2, () => {}, () => due++);
    const client = connectClock({ controlled: true, now: 100, bootTime: 0, wallAtStart: 1000, port: ports.port2 })!;
    try {
      client.schedule(() => {
        calls.push(`remote:${client.now}`);
        queueMicrotask(() => client.schedule(() => calls.push(`nested:${client.now}`), 0));
      }, 10);
      const cancelled = client.schedule(() => calls.push("cancelled"), 5);
      client.cancel(cancelled);
      clock.schedule(() => calls.push("local"), 10, 1);
      expect(await clock.advanceToAsync(110, server.synchronize)).toBe(3);
      expect(calls).toEqual(["local", "remote:110", "nested:110"]);
      expect(due).toBe(1);
      // posted before the realm hears of an advance past it, a timer is due on arrival
      await clock.advanceToAsync(115, async () => {});
      client.schedule(() => calls.push(`late:${client.now}`), 2);
      await server.synchronize(115);
      expect(due).toBe(2);
      expect(await clock.advanceToAsync(115, server.synchronize)).toBe(1);
      expect(calls.at(-1)).toBe("late:115");
      expect(clock.pending()).toBe(0);
      client.schedule(() => calls.push("dead"), 1);
      await server.synchronize(110);
      expect(client.close()).toBe(1);
      await server.synchronize(110);
      expect(await clock.advanceToAsync(120, server.synchronize)).toBe(0);
      expect(clock.pending()).toBe(0);
      clock.schedule(() => calls.push("after-death"), 10);
      expect(await Promise.all([clock.advanceToAsync(140, server.synchronize), clock.advanceToAsync(130, server.synchronize)])).toEqual([1, 0]);
      expect(clock.nowMs).toBe(140);
      expect(clock.advanceTo(145)).toBe(0);
    } finally { client.close(); server.close(); }
  });
});
