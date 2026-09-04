import { afterAll, beforeAll, expect, test } from "bun:test";
import { setPtrWidth, stp, VaList64 } from "./host";
import { mem } from "./mem";

beforeAll(() => setPtrWidth(8));
afterAll(() => setPtrWidth(4));

test("AAPCS64 va_list keeps independent register cursors and shares spilled stack arguments", () => {
  const list = mem.hostAlloc(40), gp = mem.hostAlloc(16), fp = mem.hostAlloc(32, 16), stack = mem.hostAlloc(24);
  stp(list, stack);
  stp(list + 8, gp + 16);
  stp(list + 16, fp + 32);
  mem.st32(list + 24, -16);
  mem.st32(list + 28, -32);
  mem.st32(list + 32, 0);
  mem.st32(gp, -7);
  mem.st64(gp + 8, 0x123456789abcdef0n);
  mem.stf64(fp, 1.25);
  mem.stf64(fp + 16, -3.5);
  mem.stf64(stack, 9.75);
  mem.st32(stack + 8, 42);
  mem.stf64(stack + 16, 0.125);

  const args = new VaList64(list);
  expect(args.i()).toBe(-7);
  expect(args.d()).toBe(1.25);
  expect(args.l()).toBe(0x123456789abcdef0n);
  expect(args.f()).toBe(-3.5);
  expect(args.vd()).toBe(9.75);
  expect(args.i()).toBe(42);
  expect(args.d()).toBe(0.125);
});
