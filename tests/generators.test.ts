import { expect, test } from "vite-plus/test";
import { discardedEntries, loadTimeAbiReads, undelegatedGenerators } from "../scripts/generators.ts";

test("every driven generator a native calls is run", () => {
  expect(undelegatedGenerators()).toEqual([]);
});

test("no module reads the process ABI's pointer width or layouts as it loads", () => {
  expect(loadTimeAbiReads()).toEqual([]);
});

test("no Java entry's result is dropped, which would share the caller's chain", () => {
  expect(discardedEntries()).toEqual([]);
});
