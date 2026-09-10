import { expect, test } from "bun:test";
import { javaClassSets } from "./regex-sets";

test("Java class unions and intersections preserve single-code-point matching", () => {
  for (const [source, accepted, rejected] of [
    ["[a-c[m-o]]+", "abmn", "d"],
    ["[a-z&&[^aeiou]]+", "bcdf", "a"],
    ["[a-z[0-9&&[^5]]]", "6", "5"],
    ["[^a-z&&[^aeiou]]", "a", "b"],
    ["[𐀀-🿽&&[^💩]]", "😀", "💩"],
    ["[(){}|/\\_]+", "()/|_", "a"],
    ["[-a]", "-", "b"],
  ]) {
    const re = new RegExp(`^(?:${javaClassSets(source)})$`, "v");
    expect(re.test(accepted)).toBe(true);
    expect(re.test(rejected)).toBe(false);
  }
  expect(() => javaClassSets("[abc")).toThrow(SyntaxError);
  expect(() => javaClassSets("abc\\")).toThrow(SyntaxError);
});
