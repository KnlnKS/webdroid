import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";

test("MediaFormat retains typed codec configuration and ByteBuffer identity", async () => {
  const format = await newObj("android/media/MediaFormat");
  const buffer = await newObj("java/nio/ByteBuffer", null);
  for (const [kind, desc, value] of [["Integer", "I", 1920], ["Long", "J", 9007199254740993n], ["Float", "F", 29.5], ["String", "Ljava/lang/String;", "video/avc"], ["ByteBuffer", "Ljava/nio/ByteBuffer;", buffer]] as const) {
    await vcall(format, `set${kind}`, `(Ljava/lang/String;${desc})V`, kind, value);
    expect(await vcall(format, `get${kind}`, `(Ljava/lang/String;)${desc}`, kind)).toBe(value);
  }
  await expect(vcall(format, "getInteger", "(Ljava/lang/String;)I", "Long")).rejects.toBeDefined();
  await expect(vcall(format, "getInteger", "(Ljava/lang/String;)I", "absent")).rejects.toBeDefined();
  expect(await vcall(format, "getInteger", "(Ljava/lang/String;I)I", "absent", 7)).toBe(7);
  expect(await vcall(format, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "absent")).toBeNull();
  const copy = await newObj("android/media/MediaFormat", "(Landroid/media/MediaFormat;)V", format);
  await vcall(format, "removeKey", "(Ljava/lang/String;)V", "Integer");
  expect(await vcall(copy, "getInteger", "(Ljava/lang/String;)I", "Integer")).toBe(1920);
});

test("MediaFormat factories and features preserve Android key semantics", async () => {
  const cls = rt.link("android/media/MediaFormat").ctor;
  const format = cls[mangleMethod("createVideoFormat", "(Ljava/lang/String;II)Landroid/media/MediaFormat;")]("video/avc", 640, 480);
  expect(await vcall(format, "getInteger", "(Ljava/lang/String;)I", "width")).toBe(640);
  await vcall(format, "setFeatureEnabled", "(Ljava/lang/String;Z)V", "adaptive-playback", 0);
  expect(await vcall(format, "containsFeature", "(Ljava/lang/String;)Z", "adaptive-playback")).toBe(1);
  await vcall(format, "removeKey", "(Ljava/lang/String;)V", "feature-adaptive-playback");
  expect(await vcall(format, "getFeatureEnabled", "(Ljava/lang/String;)Z", "adaptive-playback")).toBe(0);
  await vcall(format, "removeFeature", "(Ljava/lang/String;)V", "adaptive-playback");
  await expect(vcall(format, "getFeatureEnabled", "(Ljava/lang/String;)Z", "adaptive-playback")).rejects.toBeDefined();
});
