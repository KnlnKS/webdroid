import { beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { Cpu } from "./cpu";
import { mem } from "./mem";
import { capget } from "./proc";

let cpu: Cpu;
beforeAll(() => { cpu = new Cpu(mainThread, "capget test"); });

test("capget reports empty sets for an unprivileged app", () => {
  const header = mem.hostAlloc(8), data = mem.hostAlloc(24);
  mem.st32(header, 0x20080522); mem.st32(header + 4, 0);
  mem.memset(data, 0xff, 24);
  expect(capget(cpu, header, data)).toBe(0);
  expect([...mem.u8.subarray(data, data + 24)]).toEqual(new Array(24).fill(0));
});

test("capget negotiates the kernel capability version", () => {
  const header = mem.hostAlloc(8), data = mem.hostAlloc(24);
  mem.st32(header, 0); mem.st32(header + 4, 0);
  expect(capget(cpu, header, data)).toBe(-1);
  expect(mem.ld32(header)).toBe(0x20080522);
  expect(mem.ld32(cpu.errnoAddr)).toBe(22);
});

test("capget accepts a header-only version probe", () => {
  const header = mem.hostAlloc(8);
  mem.st32(header, 0); mem.st32(header + 4, -1);
  expect(capget(cpu, header, 0)).toBe(0);
  expect(mem.ld32(header)).toBe(0x20080522);
  expect(capget(cpu, header, 0)).toBe(0);
});

test("capget rejects a negative pid when data is requested", () => {
  const header = mem.hostAlloc(8), data = mem.hostAlloc(24);
  mem.st32(header, 0x20080522); mem.st32(header + 4, -1);
  expect(capget(cpu, header, data)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(22);
});

test("capget rejects a pid outside the emulated process", () => {
  const header = mem.hostAlloc(8), data = mem.hostAlloc(24);
  mem.st32(header, 0x20080522); mem.st32(header + 4, 999999);
  expect(capget(cpu, header, data)).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(3);
});
