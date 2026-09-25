import { expect, test } from "bun:test";
import "../src/natives";
import { newObj, vcall } from "../src/jvm/natives/jlang";

test("StringReader marks and resets its character position", async () => {
  const reader = await newObj("java/io/StringReader", "(Ljava/lang/String;)V", "abc");
  expect(await vcall(reader, "markSupported", "()Z")).toBe(1);
  expect(await vcall(reader, "read", "()I")).toBe(97);
  await vcall(reader, "mark", "(I)V", 1);
  expect(await vcall(reader, "read", "()I")).toBe(98);
  await vcall(reader, "reset", "()V");
  expect(await vcall(reader, "read", "()I")).toBe(98);
});
