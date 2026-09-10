import { expect, test } from "bun:test";
import { directionality } from "./bidi";

test("Java directionality distinguishes scripts, numbers, formatting controls and unassigned code points", () => {
  for (const [text, expected] of [["A", 0], ["א", 1], ["ع", 2], ["5", 3], ["+", 4], ["$", 5], ["٥", 6], [",", 7], ["\u0301", 8], ["\u00ad", 9], ["\n", 10], ["\t", 11], [" ", 12], ["😀", 13], ["\u202a", 14], ["\u202e", 17], ["\u2066", 19], ["\u2069", 22], ["𐤀", 1], ["\u0378", -1], ["\ud800", 0]] as const) {
    expect(directionality(text.codePointAt(0)!)).toBe(expected);
  }
  expect(directionality(-1)).toBe(-1);
  expect(directionality(0x110000)).toBe(-1);
});
