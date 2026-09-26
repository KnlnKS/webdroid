import { expect, test } from "bun:test";
import { driven, type Gen } from "../src/jvm/runtime";

test("generator natives receive arguments past their defaulted parameters", () => {
  // caller-sensitive natives (System.load) take the caller's Runtime this way
  const native = driven(function* (path: string, owner = "root"): Gen { return `${path}@${owner}`; }) as (...a: unknown[]) => unknown;
  expect(native("lib.so", "child")).toBe("lib.so@child");
  expect(native("lib.so")).toBe("lib.so@root");
});
