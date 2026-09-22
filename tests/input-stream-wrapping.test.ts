import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallOn, JThread, curThread, setCurThread, mainThread } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { JInputStream, readStreamFully } from "../src/jvm/natives/jio";
class ForwardOnlyStream extends JInputStream { cursor = 0; bytes = new TextEncoder().encode("<svg/>"); }
rt.register({ name: "test/ForwardOnlyStream", ctor: ForwardOnlyStream, sup: "java/io/InputStream", methods: {
  "read()I": function (this: ForwardOnlyStream) { return this.cursor < this.bytes.length ? this.bytes[this.cursor++] : -1; },
  "read([BII)I": function (this: ForwardOnlyStream, out: Int8Array, offset: number, count: number) {
    if (!count) return 0;
    const bytes = this.bytes.subarray(this.cursor, this.cursor + count);
    out.set(bytes, offset); this.cursor += bytes.length; return bytes.length || -1;
  },
} });
rt.linkNatives();
const bytes = (values: number[]) => newObj("java/io/ByteArrayInputStream", "([B)V", Int8Array.from(values));
const data = (source: unknown) => newObj("java/io/DataInputStream", "(Ljava/io/InputStream;)V", source);

test("forward-only subclasses request buffering before probing and rewinding a stream", async () => {
  const source = new ForwardOnlyStream();
  expect(await vcall(source, "markSupported", "()Z")).toBe(0);
  await expect(vcall(source, "reset", "()V")).rejects.toMatchObject({ msg: "mark/reset not supported" });
  const buffer = await newObj("java/io/BufferedInputStream", "(Ljava/io/InputStream;)V", source);
  await vcall(buffer, "mark", "(I)V", 3);
  expect(await vcall(buffer, "read", "()I")).toBe(60);
  expect(await vcall(buffer, "read", "()I")).toBe(115);
  await vcall(buffer, "reset", "()V");
  expect(new TextDecoder().decode(await readStreamFully(buffer))).toBe("<svg/>");
});

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

test("DataInputStream.skipBytes handles short skips and EOF without consuming a following byte", async () => {
  const source = await bytes([1, 2, 3, 4, 5]), input = await data(source);
  expect(await vcall(input, "skipBytes", "(I)I", -1)).toBe(0);
  expect(await vcall(input, "skipBytes", "(I)I", 3)).toBe(3);
  expect(await vcall(source, "read", "()I")).toBe(4);
  expect(await vcall(input, "skipBytes", "(I)I", 99)).toBe(1);
  expect(await vcall(input, "skipBytes", "(I)I", 1)).toBe(0);
});

test("DataInputStream.skipBytes retains its thread across short suspended skips and propagates failure", async () => {
  const source = rt.make("java/io/InputStream"), thread = new JThread(), calls: unknown[] = [], chunks = [2n, 1n, 0n];
  Object.assign(source, { [mangleMethod("skip", "(J)J")]: async (n: bigint) => {
    calls.push([n, curThread === thread]);
    setCurThread(mainThread);
    await Promise.resolve();
    return chunks.shift();
  } });
  const input = await data(source);
  expect(await vcallOn(thread, input, "skipBytes", "(I)I", 5)).toBe(3);
  expect(calls).toEqual([[5n, true], [3n, true], [2n, true]]);
  const error = rt.mkThrowable("java/io/IOException", "skip failed");
  Object.assign(source, { [mangleMethod("skip", "(J)J")]: () => { throw error; } });
  expect(await vcall(input, "skipBytes", "(I)I", 0)).toBe(0);
  await expect(vcall(input, "skipBytes", "(I)I", 1)).rejects.toBe(error);
});
