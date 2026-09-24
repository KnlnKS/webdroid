import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64 } from "./cpu";
import { Args64, hostFn, lookupHost, VRET } from "./host";
import { libmInit } from "./libm";

test("nextafter crosses zero, signed zero and infinity at double precision", async () => {
  for (const wide of [false, true]) {
    setA64(wide); libmInit();
    const cpu = new Cpu(new JThread(), "nextafter-test"), fn = lookupHost("nextafter", "libm.so")!;
    const next = async (x: number, y: number) => { await cpu.call(fn, [{ d: x }, { d: y }]); return cpu.retD(); };
    try {
      expect(await next(0, -1)).toBe(-Number.MIN_VALUE);
      expect(await next(-Number.MIN_VALUE, 1)).toBe(-0);
      expect(await next(1, 2)).toBe(1 + Number.EPSILON);
      expect(await next(Infinity, 0)).toBe(Number.MAX_VALUE);
      expect(Number.isNaN(await next(NaN, 1))).toBe(true);
    } finally { cpu.dispose(); setA64(false); }
  }
});

test("powl reads and returns ARM64 quad arguments", () => {
  setA64(true); libmInit();
  const cpu = new Cpu(new JThread(), "powl-test");
  try {
    cpu.vu.set([0, 0, 0, 0x40000000, 0, 0, 0, 0x40008000]);
    expect(hostFn("libm.so", "powl")!(cpu, new Args64(cpu))).toBe(VRET);
    expect([...cpu.vu.slice(0, 4)]).toEqual([0, 0, 0, 0x40020000]);
    cpu.vu.set([0, 0, 0, 0x3fff8000, 0, 0, 0, 0x40000000]);
    hostFn("libm.so", "powl")!(cpu, new Args64(cpu));
    expect([...cpu.vu.slice(0, 4)]).toEqual([0, 0, 0, 0x40002000]);
  } finally { cpu.dispose(); setA64(false); }
});
