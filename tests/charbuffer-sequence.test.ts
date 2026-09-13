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
