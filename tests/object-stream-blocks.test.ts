import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("ObjectInputStream consumes short block length headers before calculating the block end", async () => {
  const bytes = Int8Array.from([0xac, 0xed, 0, 5, 0x77, 4, 0, 0, 0, 123, 0x77, 2, 0, 0, 0x77, 2, 1, 200]);
  const source = await newObj("java/io/ByteArrayInputStream", "([B)V", bytes);
  const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
  expect(await vcall(input, "readInt", "()I")).toBe(123);
  expect(await vcall(input, "readInt", "()I")).toBe(456);
});
