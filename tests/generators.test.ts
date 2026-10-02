import { expect, test } from "bun:test";
import { sharedSuspensions, undelegatedGenerators } from "../scripts/generators";

test("every driven generator a native calls is run", () => {
  expect(undelegatedGenerators()).toEqual([]);
});

test("no pending Java result is memoised with ??=, which shares its suspension", () => {
  expect(sharedSuspensions()).toEqual([]);
});
