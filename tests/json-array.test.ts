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
  const object = await newObj("org/json/JSONObject");
  await vcall(object, "put", "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;", "raw", map);
  expect(await vcall(object, "optJSONObject", "(Ljava/lang/String;)Lorg/json/JSONObject;", "raw")).toBeNull();
  await expect(vcall(object, "getJSONObject", "(Ljava/lang/String;)Lorg/json/JSONObject;", "raw")).rejects.toMatchObject({
    constructor: rt.link("org/json/JSONException").ctor,
  });
  await vcall(list, "add", "(Ljava/lang/Object;)Z", map);
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "nested", await wrap(list));
  const nested = await vcall(await wrap(map), "getJSONArray", "(Ljava/lang/String;)Lorg/json/JSONArray;", "nested");
  const child = await vcall(nested, "getJSONObject", "(I)Lorg/json/JSONObject;", 2);
  expect(await vcall(child, "getInt", "(Ljava/lang/String;)I", "answer")).toBe(7);
  await expect(vcall(nested, "getJSONObject", "(I)Lorg/json/JSONObject;", 0)).rejects.toMatchObject({
    constructor: rt.link("org/json/JSONException").ctor,
  });
  expect(await wrap(new JObj())).toBeNull();
});

test("JSONObject serializes Java values through toString", async () => {
  const uuid = await newObj("java/util/UUID", "(JJ)V", 1n, 2n);
  const object = await newObj("org/json/JSONObject");
  await vcall(object, "put", "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;", "uuid", uuid);
  expect(await vcall(object, "toString", "()Ljava/lang/String;")).toBe('{"uuid":"00000000-0000-0001-0000-000000000002"}');
  expect(await vcall(object, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "uuid")).toBe(uuid);
});
