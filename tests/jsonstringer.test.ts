import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();
const open = (writer: unknown, method: string) => vcall(writer, method, "()Lorg/json/JSONStringer;");
const key = (writer: unknown, name: string) => vcall(writer, "key", "(Ljava/lang/String;)Lorg/json/JSONStringer;", name);
const text = (writer: unknown) => vcall(writer, "toString", "()Ljava/lang/String;");

test("JSONStringer preserves nesting, escaping, duplicate keys and long precision", async () => {
  const writer = await newObj("org/json/JSONStringer");
  expect(await text(writer)).toBeNull();
  await open(writer, "object"); await key(writer, "x"); await open(writer, "array");
  await vcall(writer, "value", "(J)Lorg/json/JSONStringer;", 9223372036854775807n);
  await vcall(writer, "value", "(Ljava/lang/Object;)Lorg/json/JSONStringer;", "a/\n\"");
  await open(writer, "endArray"); await key(writer, "x");
  await vcall(writer, "value", "(Z)Lorg/json/JSONStringer;", 1);
  await open(writer, "endObject");
  expect(await text(writer)).toBe('{"x":[9223372036854775807,"a\\/\\n\\\""],"x":true}');
});

test("JSONStringer rejects invalid nesting and nonfinite numeric values", async () => {
  const writer = await newObj("org/json/JSONStringer");
  for (const action of [() => key(writer, "x"), () => open(writer, "endArray")]) {
    const error = await Promise.resolve().then(action).then(() => null, e => e);
    expect(rt.iof(error, "org/json/JSONException")).toBeTruthy();
  }
  await open(writer, "object"); await key(writer, "x");
  const error = await vcallAsync(writer, "value", "(D)Lorg/json/JSONStringer;", NaN).then(() => null, e => e);
  expect(rt.iof(error, "org/json/JSONException")).toBeTruthy();
});

test("JSONStringer writes nested JSONObject and JSONArray values", async () => {
  const object = await newObj("org/json/JSONObject", "(Ljava/lang/String;)V", '{"items":[null,true,"a/b"]}');
  const writer = await newObj("org/json/JSONStringer");
  await open(writer, "array");
  await vcall(writer, "value", "(Ljava/lang/Object;)Lorg/json/JSONStringer;", object);
  await open(writer, "endArray");
  expect(await text(writer)).toBe('[{"items":[null,true,"a\\/b"]}]');
});

test("Long unsigned formatting handles the sign bit and invalid radices", async () => {
  const long = rt.link("java/lang/Long").ctor;
  expect(await vcall(long, "toUnsignedString", "(J)Ljava/lang/String;", -1n)).toBe("18446744073709551615");
  expect(await vcall(long, "toUnsignedString", "(JI)Ljava/lang/String;", -1n, 16)).toBe("ffffffffffffffff");
  expect(await vcall(long, "toUnsignedString", "(JI)Ljava/lang/String;", -9223372036854775808n, 1)).toBe("9223372036854775808");
});
