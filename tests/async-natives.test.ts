import { expect, test } from "bun:test";
import { BASELINE, asyncNativeHazards, undelegatedGenerators } from "../scripts/async-natives";

// Java an async native calls after an await runs as the main thread, not its caller; a driven
// generator keeps the caller. Known sites are the baseline, a backlog; `bun run async-natives
// --write-baseline` rewrites it. A site fixed leaves the baseline too, so it cannot come back.
test("natives call Java from an async function after an await only at the baseline's sites", async () => {
  const accepted = new Set<string>(await Bun.file(BASELINE).json());
  const sites = new Set(asyncNativeHazards().map((line) => line.slice(0, line.indexOf(" → "))));
  expect([...sites].filter((site) => !accepted.has(site))).toEqual([]);
  expect([...accepted].filter((site) => !sites.has(site))).toEqual([]);
});

test("every driven generator a native calls is run", () => {
  expect(undelegatedGenerators()).toEqual([]);
});
