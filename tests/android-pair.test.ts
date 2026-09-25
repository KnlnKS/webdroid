import { expect, test } from "bun:test";
import "../src/natives";
import { newObj, vcall } from "../src/jvm/natives/jlang";

test("Android Pair compares nested values and hashes equal pairs equally", async () => {
  const pair = (a: unknown, b: unknown) => newObj("android/util/Pair", "(Ljava/lang/Object;Ljava/lang/Object;)V", a, b);
  const first = await pair("outer", await pair("left", "right"));
  const same = await pair("outer", await pair("left", "right"));
  const different = await pair("outer", await pair("left", "other"));

  expect(await vcall(first, "equals", "(Ljava/lang/Object;)Z", same)).toBe(1);
  expect(await vcall(first, "equals", "(Ljava/lang/Object;)Z", different)).toBe(0);
  expect(await vcall(first, "hashCode", "()I")).toBe(await vcall(same, "hashCode", "()I"));
  expect(await vcall(first, "toString", "()Ljava/lang/String;")).toBe("Pair{outer Pair{left right}}");
});
