import { expect, test } from "bun:test";
import "./jutil";
import { newObj, vcall } from "./jlang";

const bundle = async (text: string) => newObj("java/util/PropertyResourceBundle", "(Ljava/io/Reader;)V", await newObj("java/io/StringReader", "(Ljava/lang/String;)V", text));
const get = (value: unknown, key: string) => vcall(value, "getString", "(Ljava/lang/String;)Ljava/lang/String;", key);

test("property bundles parse Java escapes, continuations, empty values and Unicode readers", async () => {
  const value = await bundle("# ignored\r\n! ignored\n spaced\\ key : first\\nsecond  \ncontinued=one\\\n  two\nempty\nchar=\\u65e5本語\ncolon\\:key=value\n");
  expect(await get(value, "spaced key")).toBe("first\nsecond  ");
  expect(await get(value, "continued")).toBe("onetwo");
  expect(await get(value, "empty")).toBe("");
  expect(await get(value, "char")).toBe("日本語");
  expect(await get(value, "colon:key")).toBe("value");
  expect(await vcall(value, "containsKey", "(Ljava/lang/String;)Z", "absent")).toBe(0);
  await expect(get(value, "absent")).rejects.toBeDefined();
  await expect(bundle("invalid=\\uxy12")).rejects.toBeDefined();
});

test("Properties consumes the stream from its current position with Latin-1 decoding", async () => {
  const stream = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array([0, 107, 61, -23]));
  await vcall(stream, "read", "()I");
  const props = await newObj("java/util/Properties");
  await vcall(props, "load", "(Ljava/io/InputStream;)V", stream);
  expect(await vcall(props, "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", "k")).toBe("é");
  expect(await vcall(stream, "read", "()I")).toBe(-1);
});

test("resource bundle parent fallback keeps child values authoritative", async () => {
  const parent = await bundle("shared=parent\nother=inherited\n"), child = await bundle("shared=child\n");
  await vcall(child, "setParent", "(Ljava/util/ResourceBundle;)V", parent);
  expect(await get(child, "shared")).toBe("child");
  expect(await get(child, "other")).toBe("inherited");
  expect(await vcall(child, "containsKey", "(Ljava/lang/String;)Z", "other")).toBe(1);
  const keys = await vcall(child, "getKeys", "()Ljava/util/Enumeration;");
  expect(await vcall(keys, "nextElement", "()Ljava/lang/Object;")).toBe("shared");
  expect(await vcall(keys, "nextElement", "()Ljava/lang/Object;")).toBe("other");
  expect(await vcall(keys, "hasMoreElements", "()Z")).toBe(0);
});
