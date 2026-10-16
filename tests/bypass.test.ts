import { expect, test } from "bun:test";
import { BASELINE, OVERRIDES, hasPlatformJars, overrideBypasses, selfCallsSkipped } from "../scripts/bypass.ts";

// A TS method that answers where AOSP's body calls an overridable method on `this` ignores an app's
// override of it. Known ones are the baseline, a backlog; `bun run bypass --write-baseline` rewrites it.
test.skipIf(!hasPlatformJars())("TS specs do not newly bypass methods corpus apps override", async () => {
  const accepted = new Set<string>(await Bun.file(BASELINE).json());
  const found = overrideBypasses(selfCallsSkipped(), await Bun.file(OVERRIDES).json());
  expect(found.filter((line) => !accepted.has(line))).toEqual([]);
});
