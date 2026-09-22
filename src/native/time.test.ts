import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { libcInit, LAYOUT, readTs, writeTs } from "./libc";
import { mem } from "./mem";

test("native time fields preserve signed longs and the process ABI width", async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    for (const a64 of [false, true]) {
      setA64(a64); libcInit();
      const cpu = new Cpu(mainThread, "time-test"), value = mem.hostAlloc(16), tm = mem.hostAlloc(LAYOUT.TM_SIZE);
      const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
      try {
        const ms = Date.UTC(2025, 5, 16, 16);
        if (a64) mem.st64(value, BigInt(ms / 1000)); else mem.st32(value, ms / 1000);
        await call("localtime_r", value, tm);
        const offset = a64 ? Number(mem.ld64(tm + LAYOUT.TM_GMTOFF)) : mem.ld32(tm + LAYOUT.TM_GMTOFF) | 0;
        expect(offset).toBe(-25200);
        expect(mem.ld32(tm + 20)).toBe(125);
        for (const time of [-1, ...(a64 ? [Date.UTC(2140, 0, 1)] : [])]) {
          writeTs(value, time);
          expect(readTs(value)).toBe(time);
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
