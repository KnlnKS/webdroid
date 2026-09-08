import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { mkFile, vfs } from "../jvm/natives/jio";

test("ImageDecoder sources preserve buffer bounds and reopen file data for repeated decoding", async () => {
  const decoder = rt.link("android/graphics/ImageDecoder").ctor;
  const buffer = await vcall(rt.link("java/nio/ByteBuffer").ctor, "wrap", "([BII)Ljava/nio/ByteBuffer;", Int8Array.of(0, 1, 2, 3, 4), 1, 3);
  const source = await vcall(decoder, "createSource", "(Ljava/nio/ByteBuffer;)Landroid/graphics/ImageDecoder$Source;", buffer);
  expect(await source.read()).toEqual(Uint8Array.of(1, 2, 3));
  expect(buffer.pos).toBe(1);
  vfs.write("/data/image-decoder-test", Uint8Array.of(4, 5, 6));
  const file = await vcall(decoder, "createSource", "(Ljava/io/File;)Landroid/graphics/ImageDecoder$Source;", mkFile("/data/image-decoder-test"));
  expect(await file.read()).toEqual(Uint8Array.of(4, 5, 6));
  expect(await file.read()).toEqual(Uint8Array.of(4, 5, 6));
});
