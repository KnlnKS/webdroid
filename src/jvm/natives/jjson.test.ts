import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { mangleMethod } from "../abi";
import { JDouble, JLong, TRUE, FALSE, vcall } from "./jlang";
import "./jjson";

async function tokener(source: string) {
  const t = new (rt.link("org/json/JSONTokener").ctor)();
  await vcall(t, "<init>", "(Ljava/lang/String;)V", source);
  return t;
}

test("JSONTokener decodes method envelopes through Java JSON wrappers", async () => {
  const t = await tokener('{"method":"configure","args":[true,null,{"name":"héllo","n":2147483648,"f":1.25}]}');
  const obj = await vcall(t, "nextValue", "()Ljava/lang/Object;");
  expect(rt.iof(obj, "org/json/JSONObject")).toBe(1);
  expect(await vcall(obj, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "method")).toBe("configure");
  const args = await vcall(obj, "getJSONArray", "(Ljava/lang/String;)Lorg/json/JSONArray;", "args");
  expect(rt.iof(args, "org/json/JSONArray")).toBe(1);
  expect(await vcall(args, "getBoolean", "(I)Z", 0)).toBe(1);
  expect(await vcall(args, "isNull", "(I)Z", 1)).toBe(1);
  const nested = await vcall(args, "getJSONObject", "(I)Lorg/json/JSONObject;", 2);
  expect(await vcall(nested, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "n")).toBeInstanceOf(JLong);
  expect(await vcall(nested, "get", "(Ljava/lang/String;)Ljava/lang/Object;", "f")).toBeInstanceOf(JDouble);
  expect(await vcall(t, "more", "()Z")).toBe(0);
});

test("JSONTokener preserves trailing input and Android's lenient syntax", async () => {
  const t = await tokener('\ufeff/* header */{bare=>\'\\u263a\'; list:[0x10;010,,]} true');
  const obj = await vcall(t, "nextValue", "()Ljava/lang/Object;");
  expect(await vcall(obj, "toString", "()Ljava/lang/String;")).toBe('{"bare":"☺","list":[16,8,null,null]}');
  expect(await vcall(t, "more", "()Z")).toBe(1);
  expect(await vcall(await vcall(t, "nextValue", "()Ljava/lang/Object;"), "booleanValue", "()Z")).toBe(1);
  expect(await vcall(t, "more", "()Z")).toBe(0);
  const trailing = await tokener("{} ");
  await vcall(trailing, "nextValue", "()Ljava/lang/Object;");
  expect(await vcall(trailing, "more", "()Z")).toBe(1);
});

test("JSON parsing rejects incomplete values and mismatched roots, and quotes channel strings", async () => {
  const error = rt.link("org/json/JSONException").ctor;
  for (const input of ["", "{", "[", '"unterminated', '"\\uXYZW"', "{key}", "[1 2]", "/* unterminated"]) {
    const t = await tokener(input);
    await expect(vcall(t, "nextValue", "()Ljava/lang/Object;")).rejects.toBeInstanceOf(error);
  }
  const obj = new (rt.link("org/json/JSONObject").ctor)();
  await expect(vcall(obj, "<init>", "(Ljava/lang/String;)V", "[]")).rejects.toBeInstanceOf(error);
  await vcall(obj, "<init>", "(Ljava/lang/String;)V", '{"__proto__":42}');
  expect(await vcall(obj, "getInt", "(Ljava/lang/String;)I", "__proto__")).toBe(42);
  expect(await vcall(obj, "has", "(Ljava/lang/String;)Z", "constructor")).toBe(0);
  const quote = rt.link("org/json/JSONObject").ctor[mangleMethod("quote", "(Ljava/lang/String;)Ljava/lang/String;")];
  expect(quote('a/"\n')).toBe('"a\\/\\"\\n"');
  expect(quote(null)).toBe('""');
});

test("object-typed boxed booleans serialize as JSON booleans", async () => {
  const obj = new (rt.link("org/json/JSONObject").ctor)();
  await vcall(obj, "put", "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;", "enabled", TRUE);
  await vcall(obj, "put", "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;", "disabled", FALSE);
  expect(await vcall(obj, "toString", "()Ljava/lang/String;")).toBe('{"enabled":true,"disabled":false}');
  const arr = new (rt.link("org/json/JSONArray").ctor)();
  await vcall(arr, "put", "(Ljava/lang/Object;)Lorg/json/JSONArray;", TRUE);
  expect(await vcall(arr, "toString", "()Ljava/lang/String;")).toBe("[true]");
});
