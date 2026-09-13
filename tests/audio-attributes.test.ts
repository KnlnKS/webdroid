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

test("AudioFocusRequest retains builder state and AudioManager grants focus", async () => {
  const listener = rt.make("java/lang/Object");
  const builder = await newObj("android/media/AudioFocusRequest$Builder", "(I)V", 1);
  expect(await vcall(builder, "setAcceptsDelayedFocusGain", "(Z)Landroid/media/AudioFocusRequest$Builder;", 1)).toBe(builder);
  expect(await vcall(builder, "setWillPauseWhenDucked", "(Z)Landroid/media/AudioFocusRequest$Builder;", 1)).toBe(builder);
  await vcall(builder, "setOnAudioFocusChangeListener", "(Landroid/media/AudioManager$OnAudioFocusChangeListener;)Landroid/media/AudioFocusRequest$Builder;", listener);
  const request = await vcall(builder, "build", "()Landroid/media/AudioFocusRequest;");
  expect(await vcall(request, "getFocusGain", "()I")).toBe(1);
  expect(await vcall(request, "acceptsDelayedFocusGain", "()Z")).toBe(1);
  expect(await vcall(request, "willPauseWhenDucked", "()Z")).toBe(1);
  expect(await vcall(request, "getOnAudioFocusChangeListener", "()Landroid/media/AudioManager$OnAudioFocusChangeListener;")).toBe(listener);
  expect(await vcall(rt.make("android/media/AudioManager"), "requestAudioFocus", "(Landroid/media/AudioFocusRequest;)I", request)).toBe(1);
});

test("AudioFocusRequest rejects invalid gains and null listeners", async () => {
  await expect(newObj("android/media/AudioFocusRequest$Builder", "(I)V", 0)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  const builder = await newObj("android/media/AudioFocusRequest$Builder", "(I)V", 1);
  await expect(vcall(builder, "setOnAudioFocusChangeListener", "(Landroid/media/AudioManager$OnAudioFocusChangeListener;)Landroid/media/AudioFocusRequest$Builder;", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});
