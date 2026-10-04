import { expect, test } from "bun:test";
import { rt } from "../src/jvm/runtime";
import { jsClass, parseTier } from "../src/jvm/tier";

test("the tier flag is js unless wasm is asked for", () => {
  expect(parseTier(null)).toBe("js");
  expect(parseTier("js")).toBe("js");
  expect(parseTier("wasm")).toBe("wasm");
  expect(() => parseTier("native")).toThrow("invalid tier");
});

test("a JS-tier JavaClass allocates, calls statics and reads static fields", async () => {
  const info = rt.link("java/lang/Integer");
  await rt.initClass(info);
  const integer = jsClass(info);
  expect(integer.name).toBe("java/lang/Integer");
  expect(integer.call("toString", "(I)Ljava/lang/String;")(42)).toBe("42");
  expect(integer.static("MAX_VALUE")).toBe(2147483647);
  expect((integer.new().constructor as unknown as { $i: unknown }).$i).toBe(info);
  expect(jsClass(info)).toBe(integer);
});

test("a JS-tier JavaClass writes declared statics only and runs a method without dispatch", async () => {
  const info = rt.link("java/lang/Integer");
  await rt.initClass(info);
  const integer = jsClass(info);
  expect(integer.setStatic("MAX_VALUE", 7, "I")).toBe(true);
  expect(integer.static("MAX_VALUE")).toBe(7);
  expect(integer.setStatic("MAX_VALUE", 2147483647, "I")).toBe(true);
  expect(integer.setStatic("NO_SUCH_FIELD", 1, "I")).toBe(false);
  expect(integer.has("intValue", "()I")).toBe(true);
  expect(integer.has("intValue", "()J")).toBe(false);
  const one = integer.new();
  integer.special("<init>", "(I)V")(one, 1);
  expect(integer.special("intValue", "()I")(one)).toBe(1);
  expect(() => integer.call("nope", "()V")).toThrow("is not defined");
});
