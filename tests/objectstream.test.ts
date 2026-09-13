import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("ObjectInputStream consumes complete short blocks and crosses block boundaries", async () => {
  const source = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array([
    0xac, 0xed, 0, 5, 0x77, 4, 0x12, 0x34, 0x56, 0x78,
    0x77, 1, 0x11, 0x77, 3, 0x22, 0x33, 0x44,
  ]));
  const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
  expect(await vcall(input, "readInt", "()I")).toBe(0x12345678);
  expect(await vcall(input, "readInt", "()I")).toBe(0x11223344);
});
