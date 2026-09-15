import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";

rt.linkNatives();
const color = rt.link("android/graphics/Color").ctor as any;

test("HSVToColor applies its explicit alpha", () => {
  const hsv = Float32Array.from([120, 1, 1]);
  expect(color[mangleMethod("HSVToColor", "(I[F)I")](0x40, hsv) >>> 0).toBe(0x4000ff00);
  expect(color[mangleMethod("HSVToColor", "([F)I")](hsv) >>> 0).toBe(0xff00ff00);
});

test("parseColor uses Android's named and hex formats", () => {
  const parse = color[mangleMethod("parseColor", "(Ljava/lang/String;)I")];
  expect(parse("darkgrey") >>> 0).toBe(0xff444444);
  expect(parse("#80abcdef") >>> 0).toBe(0x80abcdef);
  expect(() => parse("transparent")).toThrow();
  expect(() => parse("#fff")).toThrow();
});
