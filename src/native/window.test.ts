import { beforeAll, expect, test } from "vite-plus/test";
import { mem } from "./mem.ts";
import { setA64 } from "./cpu.ts";
import { jitStats, JIT_HEAT, BadAddress } from "./core.ts";
import { execute, place } from "./a64.testkit.ts";
import { ashmemContent } from "./shm.ts";
import { mapWindow, unmapWindow } from "./window.ts";

beforeAll(() => setA64(false));

test("stores, exclusives and host accesses reach a pooled region in both tiers, as mprotect allows, until it is unmapped", () => {
  const { content, region } = ashmemContent(0x1000), va = mapWindow(region.pool!, 0, 0x1000, 3, () => {})!;
  const word = () => new DataView(content.data.buffer, content.data.byteOffset, 4).getInt32(0, true);
  // ldr r1, [r0]; add r1, #1; str r1, [r0]; ldrex r2, [r0]; add r2, #1; strex r3, r2, [r0]; bx lr
  const at = place([0xe5901000, 0xe2811001, 0xe5801000, 0xe1902f9f, 0xe2822001, 0xe1803f92, 0xe12fff1e]);
  const compiled = jitStats.regions, run = () => execute(at, (cpu) => { cpu.w[0] = va; });
  for (let i = 1; i <= JIT_HEAT + 2; i++) {
    const c = run();
    expect([word(), c.w[6]]).toEqual([2 * i, 0]);
  }
  expect(jitStats.regions).toBeGreaterThan(compiled);
  mem.st32(va + 4, 7);
  expect([mem.ld32(va), mem.cstr(va + 4)]).toEqual([word(), "\x07"]);
  mem.protectVa(BigInt(va), 0x1000, 1);
  expect(() => mem.st32(va, 1)).toThrow(BadAddress);
  expect(run).toThrow();
  mem.protectVa(BigInt(va), 0x1000, 3);
  // a second mapping of the region has an address of its own onto the same bytes
  const again = mapWindow(region.pool!, 0, 0x1000, 3, () => {})!;
  expect(again).not.toBe(va);
  unmapWindow(va, 0x1000);
  mem.st32(again, 9);
  expect(word()).toBe(9);
  expect(() => mem.ld32(va)).toThrow();
  expect(run).toThrow();
});
