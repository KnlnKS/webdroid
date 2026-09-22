import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
const wrap = (text: unknown) => vcall(rt.link("java/nio/CharBuffer").ctor, "wrap", "(Ljava/lang/CharSequence;)Ljava/nio/CharBuffer;", text);

test("CharBuffer keeps a live read-only CharSequence view", async () => {
  const text = await newObj("java/lang/StringBuilder", "(Ljava/lang/String;)V", "abc");
  const b = await wrap(text);
  await vcall(text, "setCharAt", "(IC)V", 1, 120);
  expect(await vcall(b, "get", "(I)C", 1)).toBe(120);
  expect(await vcall(b, "toString", "()Ljava/lang/String;")).toBe("axc");
  expect(await vcall(b, "get", "()C")).toBe(97);
  expect(await vcall(b, "toString", "()Ljava/lang/String;")).toBe("xc");
  const slice = await vcall(b, "slice", "()Ljava/nio/CharBuffer;");
  await vcall(text, "setCharAt", "(IC)V", 2, 121);
  expect(await vcall(slice, "toString", "()Ljava/lang/String;")).toBe("xy");
  expect(await vcall(slice, "position", "()I")).toBe(0);
  expect(await vcall(slice, "capacity", "()I")).toBe(2);
  await expect(vcall(slice, "put", "(C)Ljava/nio/CharBuffer;", 65)).rejects.toBeDefined();
  await expect(vcall(b, "put", "(C)Ljava/nio/CharBuffer;", 65)).rejects.toBeDefined();
});
test("one-shot charset encoding consumes UTF-16 input and reports malformed surrogates", async () => {
  const charset = rt.link("java/nio/charset/StandardCharsets").ctor.s$UTF_8;
  const encoder = await vcall(charset, "newEncoder", "()Ljava/nio/charset/CharsetEncoder;");
  const b = await wrap("café🗺");
  const out = await vcall(encoder, "encode", "(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;", b);
  expect(new Uint8Array((await vcall(out, "array", "()[B")).buffer)).toEqual(new TextEncoder().encode("café🗺"));
  expect(await vcall(b, "remaining", "()I")).toBe(0);
  const bad = await wrap("a\ud800b");
  await expect(vcall(encoder, "encode", "(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;", bad)).rejects.toMatchObject({ msg: "Input length = 1" });
  expect(await vcall(bad, "position", "()I")).toBe(1);
});

test("decoder replacement preserves valid replacement characters and unread overflow input", async () => {
  const decoder = await vcall(rt.link("java/nio/charset/StandardCharsets").ctor.s$UTF_8, "newDecoder", "()Ljava/nio/charset/CharsetDecoder;");
  await vcall(decoder, "replaceWith", "(Ljava/lang/String;)Ljava/nio/charset/CharsetDecoder;", "?");
  const input = await vcall(rt.link("java/nio/ByteBuffer").ctor, "wrap", "([B)Ljava/nio/ByteBuffer;", new Int8Array([0xef, 0xbf, 0xbd, 0xff, 0xf0, 0x9f, 0x90, 0x88]));
  const output = await vcall(rt.link("java/nio/CharBuffer").ctor, "allocate", "(I)Ljava/nio/CharBuffer;", 3);
  const decode = () => vcall(decoder, "decode", "(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;Z)Ljava/nio/charset/CoderResult;", input, output, 1);
  const error = await decode();
  expect(await vcall(error, "isMalformed", "()Z")).toBe(1);
  expect(input.pos).toBe(3);
  await rt.initClass(rt.link("java/nio/charset/CodingErrorAction"));
  await vcall(decoder, "onMalformedInput", "(Ljava/nio/charset/CodingErrorAction;)Ljava/nio/charset/CharsetDecoder;", rt.link("java/nio/charset/CodingErrorAction").ctor.s$REPLACE);
  expect(await vcall(await decode(), "isOverflow", "()Z")).toBe(1);
  expect(input.pos).toBe(4);
  await vcall(output, "flip", "()Ljava/nio/Buffer;");
  expect(await vcall(output, "toString", "()Ljava/lang/String;")).toBe("\ufffd?");
  await vcall(output, "clear", "()Ljava/nio/Buffer;");
  expect(await vcall(await decode(), "isUnderflow", "()Z")).toBe(1);
  await vcall(output, "flip", "()Ljava/nio/Buffer;");
  expect(await vcall(output, "toString", "()Ljava/lang/String;")).toBe("🐈");
});
