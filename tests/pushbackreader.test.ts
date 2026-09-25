import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("PushbackReader replays characters in order and enforces capacity", async () => {
  const source = await newObj("java/io/StringReader", "(Ljava/lang/String;)V", "abcd");
  const reader = await newObj("java/io/PushbackReader", "(Ljava/io/Reader;I)V", source, 2);
  expect(await vcall(reader, "read", "()I")).toBe(97);
  await vcall(reader, "unread", "([CII)V", Uint16Array.of(120, 121, 122), 1, 2);
  const out = new Uint16Array(4);
  expect(await vcall(reader, "read", "([CII)I", out, 0, 4)).toBe(4);
  expect(String.fromCharCode(...out)).toBe("yzbc");
  await vcall(reader, "unread", "(I)V", 81);
  await vcall(reader, "unread", "(I)V", 82);
  await expect(vcall(reader, "unread", "(I)V", 83)).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
  expect(await vcall(reader, "read", "()I")).toBe(82);
  await vcall(reader, "close", "()V");
  await expect(vcall(reader, "read", "()I")).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
});
