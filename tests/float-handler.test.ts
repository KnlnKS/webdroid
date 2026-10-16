// A constant a catch handler reads is typed from the state before the instructions that can throw, not from every definition in the try range.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import "../src/natives.ts";
import { DexFile } from "../src/jvm/dex.ts";
import { loadDex } from "../src/jvm/tier.ts";
import { scall } from "./java.ts";

test("an int constant in a try range stays an int when the handler reads a float in the same register", async () => {
  loadDex(new DexFile(new Uint8Array(readFileSync(import.meta.dir + "/fixtures/FloatHandlerProbe.dex"))), true);
  // the JDK's results, over enough calls that the method runs as the hot tier compiles it
  const cases: [number, bigint, number, bigint][] = [
    [0, -2147483648n, -8388608, 9223372032559808512n],
    [1, 9223372036854775807n, -2147483648, 9223372034707292163n],
    [5, 123456789012345n, 1e10, 9223248580065763480n],
  ];
  for (let i = 0; i < 40; i++) for (const [a, b, c, want] of cases) expect(await scall("FloatHandlerProbe", "shifted", "(IJF)J", a, b, c)).toBe(want);
});
