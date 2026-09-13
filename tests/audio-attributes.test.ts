import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("AudioAttributes maps legacy music streams", async () => {
  const builder = await newObj("android/media/AudioAttributes$Builder");
  expect(await vcall(builder, "setLegacyStreamType", "(I)Landroid/media/AudioAttributes$Builder;", 3)).toBe(builder);
  const attrs = await vcall(builder, "build", "()Landroid/media/AudioAttributes;");
  expect(await vcall(attrs, "getUsage", "()I")).toBe(1);
  expect(await vcall(attrs, "getContentType", "()I")).toBe(2);
});

test("AudioAttributes rejects the accessibility legacy stream", async () => {
  const builder = await newObj("android/media/AudioAttributes$Builder");
  await expect(vcall(builder, "setLegacyStreamType", "(I)Landroid/media/AudioAttributes$Builder;", 10)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
});
