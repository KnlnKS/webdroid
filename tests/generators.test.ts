import { expect, test } from "bun:test";
import { loadTimeAbiReads, sharedSuspensions, undelegatedGenerators } from "../scripts/generators";

test("every driven generator a native calls is run", () => {
  expect(undelegatedGenerators()).toEqual([]);
});

test("no pending Java result is memoised with ??=, which shares its suspension", () => {
  expect(sharedSuspensions()).toEqual([]);
});

test("no module reads the process ABI's pointer width or layouts as it loads", () => {
  expect(loadTimeAbiReads()).toEqual([]);
});
