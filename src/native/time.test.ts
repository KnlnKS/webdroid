import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jentry";
import { Cpu, setA64 } from "./cpu";
import { defineHost, ldp, stp } from "./host";
import { libCalls } from "./calls.testkit";
import { libcInit, TM, readTs, writeTs } from "./libc";
import { KLAYOUT, kernelInit } from "./syscall";
import { mem } from "./mem";

test("native time fields preserve signed longs and the process ABI width", async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    for (const a64 of [false, true]) {
      setA64(a64); kernelInit();
      if (!a64) libcInit();
      const cpu = new Cpu(mainThread, "time-test"), value = mem.hostAlloc(16), tm = mem.hostAlloc(TM.size);
      const call = libCalls(cpu, "libc.so");
      try {
        // the tm functions are an ARM32 process's alone; the kernel layer's timespecs are both ABIs'
        if (!a64) {
          mem.st32(value, Date.UTC(2025, 5, 16, 16) / 1000);
          await call("localtime_r", value, tm);
          expect(mem.ld32(tm + TM.gmtoff) | 0).toBe(-25200);
          expect(mem.ld32(tm + 20)).toBe(125);
        }
        for (const time of [-1, ...(a64 ? [Date.UTC(2140, 0, 1)] : [])]) {
          writeTs(value, time);
          expect(readTs(value)).toBe(time);
          if (a64) continue;
          await call("gmtime_r", value, tm);
          expect(mem.ld32(tm + 20)).toBe(new Date(time).getUTCFullYear() - 1900);
        }
      } finally { cpu.dispose(); }
    }
  } finally {
    if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    setA64(false);
  }
});

test("POSIX thread timers pass sigval and disarm after a one-shot expiry", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "timer-test"), event = mem.hostAlloc(64), out = mem.hostAlloc(4), value = mem.hostAlloc(2 * KLAYOUT.TS_SIZE);
  const call = libCalls(cpu, "libc.so");
  const delivered = Promise.withResolvers<number>();
  let callback: Cpu | undefined, timer = 0;
  try {
    mem.bytes(event, 64).fill(0);
    stp(event, 1234); mem.st32(event + 8, 2);
    stp(event + 12, defineHost("test:timer", (thread, args) => { callback = thread; delivered.resolve(args.i()); return 0; }));
    expect(await call("timer_create", 1, event, out)).toBe(0);
    timer = ldp(out);
    writeTs(value, 0); writeTs(value + KLAYOUT.TS_SIZE, -1);
    expect(await call("timer_settime", timer, 0, value, 0)).toBe(-1);
    writeTs(value + KLAYOUT.TS_SIZE, 10);
    expect(await call("timer_settime", timer, 0, value, 0)).toBe(0);
    expect(await delivered.promise).toBe(1234);
    while (!callback?.finished) await new Promise(resolve => setTimeout(resolve, 0));
    expect(await call("timer_gettime", timer, value)).toBe(0);
    expect(readTs(value + KLAYOUT.TS_SIZE)).toBe(0);
    expect(await call("timer_getoverrun", timer)).toBe(0);
  } finally { if (timer) await call("timer_delete", timer); cpu.dispose(); }
});
