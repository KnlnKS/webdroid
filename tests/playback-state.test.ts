import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("PlaybackState builder preserves playback timing and actions", async () => {
  const builder = await newObj("android/media/session/PlaybackState$Builder");
  await vcall(builder, "setState", "(IJFJ)Landroid/media/session/PlaybackState$Builder;", 3, 1200n, 1.25, 9000n);
  await vcall(builder, "setBufferedPosition", "(J)Landroid/media/session/PlaybackState$Builder;", 2400n);
  await vcall(builder, "setActions", "(J)Landroid/media/session/PlaybackState$Builder;", 6n);
  const state = await vcall(builder, "build", "()Landroid/media/session/PlaybackState;");
  expect(await vcall(state, "getState", "()I")).toBe(3);
  expect(await vcall(state, "getPosition", "()J")).toBe(1200n);
  expect(await vcall(state, "getBufferedPosition", "()J")).toBe(2400n);
  expect(await vcall(state, "getPlaybackSpeed", "()F")).toBe(1.25);
  expect(await vcall(state, "getActions", "()J")).toBe(6n);
});
