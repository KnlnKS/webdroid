import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
const bytes = (values: number[]) => newObj("java/io/ByteArrayInputStream", "([B)V", Int8Array.from(values));
const data = (source: unknown) => newObj("java/io/DataInputStream", "(Ljava/io/InputStream;)V", source);

test("DataInputStream advances the original stream's cursor", async () => {
  const source = await bytes([0, 0, 1, 2, 3]), input = await data(source);
  expect(await vcall(input, "readInt", "()I")).toBe(258);
  expect(await vcall(source, "read", "()I")).toBe(3);
});

test("buffered data reads preserve sequence-stream overrides and marks across refills", async () => {
  const source = await newObj("java/io/SequenceInputStream", "(Ljava/io/InputStream;Ljava/io/InputStream;)V", await bytes([0, 0]), await bytes([1, 2, 3, 4, 5]));
  const buffer = await newObj("java/io/BufferedInputStream", "(Ljava/io/InputStream;I)V", source, 2);
  const input = await data(buffer);
  await vcall(input, "mark", "(I)V", 6);
  expect(await vcall(input, "readInt", "()I")).toBe(258);
  await vcall(input, "reset", "()V");
  expect(await vcall(input, "readInt", "()I")).toBe(258);
  expect(await vcall(input, "readUnsignedShort", "()I")).toBe(772);
  expect(await vcall(input, "readUnsignedByte", "()I")).toBe(5);
  await expect(vcall(input, "reset", "()V")).rejects.toMatchObject({ msg: "Resetting to invalid mark" });
  expect(await vcall(input, "read", "()I")).toBe(-1);
  await vcall(input, "close", "()V");
  await expect(vcall(input, "read", "()I")).rejects.toMatchObject({ msg: "Stream closed" });
});
