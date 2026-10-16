import { expect, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { BASELINE, OVERRIDES, hasPlatformJars, overrideBypasses, selfCallsSkipped } from "../scripts/bypass.ts";

// A TS method that answers where AOSP's body calls an overridable method on `this` ignores an app's
// override of it. Known ones are the baseline, a backlog; `pnpm bypass --write-baseline` rewrites it.
test.skipIf(!hasPlatformJars())("TS specs do not newly bypass methods corpus apps override", () => {
  const accepted = new Set<string>(JSON.parse(readFileSync(BASELINE, "utf8")));
  const found = overrideBypasses(selfCallsSkipped(), JSON.parse(readFileSync(OVERRIDES, "utf8")));
  expect(found.filter((line) => !accepted.has(line))).toEqual([]);
});
