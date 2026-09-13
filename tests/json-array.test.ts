import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, boxInt } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";

const wrap = (value: unknown) =>
  (rt.link("org/json/JSONObject").ctor as unknown as Record<string, (value: unknown) => unknown>)[mangleMethod("wrap", "(Ljava/lang/Object;)Ljava/lang/Object;")](value);
rt.linkNatives();

test("JSONArray indexed primitive puts pad and replace", async () => {
  const array = await newObj("org/json/JSONArray");
  await vcall(array, "put", "(II)Lorg/json/JSONArray;", 2, 7);
  await vcall(array, "put", "(IZ)Lorg/json/JSONArray;", 0, 1);
  expect(await vcall(array, "toString", "()Ljava/lang/String;")).toBe("[true,null,7]");
  await expect(vcall(array, "put", "(II)Lorg/json/JSONArray;", -1, 0)).rejects.toMatchObject({
    constructor: rt.link("org/json/JSONException").ctor,
  });
});

test("JSONObject.wrap preserves JSON values and converts containers", async () => {
  const boxed = boxInt(7);
  expect(await wrap(boxed)).toBe(boxed);
  expect(await wrap("text")).toBe("text");

  const list = await newObj("java/util/ArrayList");
  await vcall(list, "add", "(Ljava/lang/Object;)Z", "first");
  await vcall(list, "add", "(Ljava/lang/Object;)Z", boxed);
  expect(await vcall(await wrap(list), "toString", "()Ljava/lang/String;")).toBe('["first",7]');
  expect(await vcall(await wrap(Int32Array.of(2, 3)), "toString", "()Ljava/lang/String;")).toBe("[2,3]");

  const map = await newObj("java/util/HashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "answer", boxed);
  expect(await vcall(await wrap(map), "toString", "()Ljava/lang/String;")).toBe('{"answer":7}');
  expect(await wrap(new JObj())).toBeNull();
});
