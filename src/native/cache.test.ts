import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { RET_SENTINEL } from "./abi";
import { allBlocks, blockAt, blockStats, coldTier, Cpu, invalidateRange, setA64 } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { mem } from "./mem";

const RET = 0xd65f03c0;
const PAGE = 0x1000;
const defaultHeat = coldTier.heat;
const defaultMaxBlocks = coldTier.maxBlocks;
let allocated: number[] = [];

function page(): number {
  const at = mem.reserve(PAGE, PAGE);
  allocated.push(at);
  return at;
}

function write(at: number, words: number[]): void {
  for (let i = 0; i < words.length; i++) mem.u32[(at >>> 2) + i] = words[i];
}

function branch(from: number, to: number): number {
  const words = (to - from) / 4;
  return (0x14000000 | (words & 0x03ffffff)) >>> 0;
}

function runAt(cpu: Cpu, at: number): void {
  cpu.r.fill(0);
  cpu.h.fill(0);
  cpu.r[30] = RET_SENTINEL;
  cpu.setPc(at);
  while (cpu.runSlice(10_000) !== 2) { /* spin */ }
}

beforeAll(() => {
  setA64(true);
  coldTier.heat = 0;
});

afterEach(() => {
  for (const at of allocated) invalidateRange(at, PAGE, "cache test cleanup");
  allocated = [];
  coldTier.heat = 0;
  coldTier.maxBlocks = defaultMaxBlocks;
});

afterAll(() => {
  coldTier.heat = defaultHeat;
  coldTier.maxBlocks = defaultMaxBlocks;
  setA64(false);
});

describe("A64 compiled block cache", () => {
  test("evicts the least recently executed page down to the low watermark", () => {
    coldTier.maxBlocks = 3;
    const cpu = new Cpu(mainThread, "cache-lru");
    const [a, b, c, d] = [page(), page(), page(), page()];
    for (const at of [a, b, c, d]) write(at, [RET]);

    runAt(cpu, a);
    runAt(cpu, b);
    runAt(cpu, a); // A is newer than B despite having been compiled first.
    runAt(cpu, c);
    const aBlock = blockAt(a);
    const evictedBefore = blockStats.evicted;
    runAt(cpu, d);

    expect(blockAt(a)).toBe(aBlock);
    expect(blockAt(b)).toBeUndefined();
    expect(blockAt(c)).toBeDefined();
    expect(blockAt(d)).toBeDefined();
    expect(allBlocks.size).toBe(3);
    expect(blockStats.evicted - evictedBefore).toBe(1);
  });

  test("does not restore a hot link on a caller evicted while its target compiles", () => {
    coldTier.maxBlocks = 1;
    const cpu = new Cpu(mainThread, "cache-active-caller");
    const caller = page(), target = page();
    write(caller, [branch(caller, target)]);
    write(target, [RET]);
    const oldCaller = cpu.look(caller);

    runAt(cpu, caller);

    expect(blockAt(caller)).toBeUndefined();
    expect(blockAt(target)).toBeDefined();
    expect(allBlocks.has(oldCaller)).toBeFalse();
    expect(oldCaller.n.every((next) => next === undefined)).toBeTrue();
    expect(oldCaller.links).toHaveLength(0);
  });

  test("repeated cross-page code writes clear and rebuild one predecessor link", () => {
    coldTier.maxBlocks = 0;
    const cpu = new Cpu(mainThread, "cache-self-modifying");
    const caller = page(), target = page();
    write(caller, [branch(caller, target)]);
    write(target, [0x52800020, RET]); // mov w0, #1

    runAt(cpu, caller);
    const callerBlock = cpu.look(caller);
    expect(cpu.r[0]).toBe(1);
    expect(callerBlock.links).toHaveLength(1);

    for (let value = 2; value <= 6; value++) {
      mem.st32(target, 0x52800000 | (value << 5));
      expect(blockAt(target)).toBeUndefined();
      expect(callerBlock.n.every((next) => next === undefined)).toBeTrue();
      expect(callerBlock.links).toHaveLength(0);

      runAt(cpu, caller);
      expect(cpu.r[0]).toBe(value);
      expect(callerBlock.links).toHaveLength(1);
    }
  });
});
