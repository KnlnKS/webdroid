import { describe, expect, test } from "bun:test";
import { stableFrame } from "./settle";

describe("stableFrame", () => {
  test("needs stableFrames repeats after the first sample", () => {
    expect(stableFrame(["a", "a", "a", "a"])).toBeUndefined();
    expect(stableFrame(["a", "a", "a", "a", "a"])).toBe("a");
    expect(stableFrame(["b", "a", "a", "a", "a", "a"])).toBe("a");
  });

  test("a change resets the run", () => {
    expect(stableFrame(["a", "a", "a", "a", "b"])).toBeUndefined();
    expect(stableFrame(["a", "a", "a", "a", "b", "b", "b", "b"])).toBeUndefined();
  });

  test("a two-frame oscillation over the window settles on the more frequent frame", () => {
    expect(stableFrame(["a", "b", "a", "b", "a", "b", "a", "b"])).toBe("a");
    expect(stableFrame(["b", "a", "a", "b", "a", "a", "b", "a"])).toBe("a");
    expect(stableFrame(["a", "b", "a", "b", "a", "b", "a"])).toBeUndefined();
  });

  test("three distinct frames, one seen once, or a single change is not an oscillation", () => {
    expect(stableFrame(["a", "b", "c", "a", "b", "c", "a", "b"])).toBeUndefined();
    expect(stableFrame(["a", "a", "a", "a", "b", "a", "a", "a"])).toBeUndefined();
    expect(stableFrame(["a", "a", "b", "b", "b", "b", "b", "b"])).toBe("b");
    expect(stableFrame(["a", "a", "a", "b", "b", "b", "a", "a"])).toBeUndefined();
  });

  test("works on numeric hashes with a custom width", () => {
    expect(stableFrame([1, 2, 2, 2], 2)).toBe(2);
    expect(stableFrame([1, 2, 1, 2], 2)).toBe(1);
  });
});
