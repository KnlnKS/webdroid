import { expect, test } from "vite-plus/test";
import { JThread } from "../../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "../cpu.ts";
import { lookupHost } from "../host.ts";
import { libcInit } from "./libc.ts";

test("nextafter crosses zero, signed zero and infinity at double precision", async () => {
  setA64(false); libcInit();
  const cpu = new Cpu(new JThread(), "nextafter-test"), fn = lookupHost("nextafter", "libm.so")!;
  const next = async (x: number, y: number) => { await cpu.call(fn, [{ d: x }, { d: y }]); return cpu.retD(); };
  try {
    expect(await next(0, -1)).toBe(-Number.MIN_VALUE);
    expect(await next(-Number.MIN_VALUE, 1)).toBe(-0);
    expect(await next(1, 2)).toBe(1 + Number.EPSILON);
    expect(await next(Infinity, 0)).toBe(Number.MAX_VALUE);
    expect(Number.isNaN(await next(NaN, 1))).toBe(true);
  } finally { cpu.dispose(); }
});
