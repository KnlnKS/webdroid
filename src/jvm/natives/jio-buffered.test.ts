import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { newObj, vcall } from "./jlang";
import "./jio";

const bytes = (s: unknown) => vcall(s, "toByteArray", "()[B");

test("buffered output drains at capacity, bypasses large writes, and flushes the tail", async () => {
  const sink = await newObj("java/io/ByteArrayOutputStream");
  const stream = await newObj("java/io/BufferedOutputStream", "(Ljava/io/OutputStream;I)V", sink, 4);
  await vcall(stream, "write", "([B)V", new Int8Array([1, 2, 3]));
  expect(await bytes(sink)).toEqual(new Int8Array());
  await vcall(stream, "write", "([BII)V", new Int8Array([4, 5]), 0, 2);
  expect(await bytes(sink)).toEqual(new Int8Array([1, 2, 3]));
  await vcall(stream, "write", "([B)V", new Int8Array([6, 7, 8, 9, 10]));
  expect(await bytes(sink)).toEqual(new Int8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  await vcall(stream, "write", "(I)V", 255);
  await vcall(stream, "close", "()V");
  expect(await bytes(sink)).toEqual(new Int8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1]));
});

test("buffered output exposes protected storage for reusable Java subclasses", async () => {
  const first = await newObj("java/io/ByteArrayOutputStream"), second = await newObj("java/io/ByteArrayOutputStream");
  const stream = await newObj("java/io/BufferedOutputStream", "(Ljava/io/OutputStream;I)V", first, 4);
  expect(rt.link("java/io/BufferedOutputStream").superInfo?.name).toBe("java/io/FilterOutputStream");
  expect(rt.link("java/io/FilterOutputStream").fieldTable.has("out")).toBe(true);
  await vcall(stream, "write", "(I)V", 1);
  stream.out = second;
  stream.count = 0;
  await vcall(stream, "write", "(I)V", 2);
  await vcall(stream, "flush", "()V");
  expect(await bytes(first)).toEqual(new Int8Array());
  expect(await bytes(second)).toEqual(new Int8Array([2]));
  await expect(newObj("java/io/BufferedOutputStream", "(Ljava/io/OutputStream;I)V", first, 0)).rejects.toBeDefined();
});
