import { expect, test } from "bun:test";
import { sampleError } from "../scripts/wasm/g1report.ts";

test("G1 rejects partial, errored, mismatched and unusable samples", () => {
  const full = { result: "42", completedCalls: 101, first: 2, steady: 1 };
  expect(sampleError(full, "42", 101)).toBeUndefined();
  expect(sampleError({ ...full, completedCalls: 4 }, "42", 101)).toBe("incomplete call count");
  expect(sampleError({ ...full, error: "late Java exception" }, "42", 101)).toBe("late Java exception");
  expect(sampleError(full, "7", 101)).toBe("result differs");
  expect(sampleError({ ...full, first: NaN }, "42", 101)).toBe("invalid timing sample");
  expect(sampleError({ ...full, steady: 0 }, "42", 101)).toBe("invalid timing sample");
});
