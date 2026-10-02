import { expect, test } from "bun:test";
import { BASELINE, asyncNativeHazards, undelegatedGenerators } from "../scripts/async-natives";

// Java an async native calls after an await runs as the main thread, not its caller; a driven
// generator keeps the caller. Known sites are the baseline, a backlog; `bun run async-natives
// --write-baseline` rewrites it.
test("natives do not newly call Java from an async function after an await", async () => {
  const accepted = new Set<string>(await Bun.file(BASELINE).json());
  expect(asyncNativeHazards().map((line) => line.slice(0, line.indexOf(" → "))).filter((site) => !accepted.has(site))).toEqual([]);
});

test("every driven generator a native calls is run", () => {
  expect(undelegatedGenerators()).toEqual([]);
});
