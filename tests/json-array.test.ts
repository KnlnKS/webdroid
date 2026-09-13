import { expect, test } from "bun:test";
import "../src/natives";
import { newObj, vcall } from "../src/jvm/natives/jlang";

test("JSONArray indexed primitive puts pad and replace", async () => {
  const array = await newObj("org/json/JSONArray");
  await vcall(array, "put", "(II)Lorg/json/JSONArray;", 2, 7);
  await vcall(array, "put", "(IZ)Lorg/json/JSONArray;", 0, 1);
  expect(await vcall(array, "toString", "()Ljava/lang/String;")).toBe("[true,null,7]");
});
