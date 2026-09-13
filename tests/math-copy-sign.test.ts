import { expect, test } from "bun:test";
import "../src/natives";
import { mangleMethod } from "../src/jvm/abi";
import { rt } from "../src/jvm/runtime";

rt.linkNatives();

const math = rt.link("java/lang/Math").ctor as any;
const call = (desc: "(DD)D" | "(FF)F", magnitude: number, sign: number): number =>
  math[mangleMethod("copySign", desc)](magnitude, sign);

test("Math.copySign copies negative and positive zero signs", () => {
  expect(call("(DD)D", 3.5, -0)).toBe(-3.5);
  expect(call("(DD)D", -3.5, 0)).toBe(3.5);
  expect(call("(FF)F", 2.25, -1)).toBe(-2.25);
});
