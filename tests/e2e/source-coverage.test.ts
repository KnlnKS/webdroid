import { expect, test } from "bun:test";
import { decodeMappings, executedSources } from "./lib/source-coverage";

test("maps executed generated ranges to their source files", () => {
  const points = decodeMappings({ mappings: "AAAA;ACAA", sources: ["src/a.ts", "src/b.ts"] }, "a\nb\n");
  const files = executedSources(points, [
    { functionName: "", ranges: [{ startOffset: 0, endOffset: 4, count: 1 }] },
    { functionName: "run", ranges: [{ startOffset: 2, endOffset: 3, count: 1 }] },
  ]);
  expect(files).toEqual(["src/b.ts"]);
});
