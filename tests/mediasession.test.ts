import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { onMain } from "../src/android/mainloop";
import { JContext } from "../src/android/context";

const commands: string[] = [];
rt.register({ name: "test/SessionContext", ctor: class extends JContext {}, sup: "android/content/Context", methods: {
  "getPackageName()Ljava/lang/String;": () => "test.session",
} });
rt.register({ name: "test/SessionCallback", ctor: class extends JObj {}, sup: "android/media/session/MediaSession$Callback", methods: {
  "onCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V": (command: string) => { commands.push(command); },
} });
rt.linkNatives();

test("MediaSession keeps controller identity and dispatches commands through the callback looper", async () => {
  const context = rt.make("test/SessionContext");
  const session = await newObj("android/media/session/MediaSession", "(Landroid/content/Context;Ljava/lang/String;)V", context, "test");
  const token = await vcall(session, "getSessionToken", "()Landroid/media/session/MediaSession$Token;");
  const controller = await newObj("android/media/session/MediaController", "(Landroid/content/Context;Landroid/media/session/MediaSession$Token;)V", context, token);
  const callback = rt.make("test/SessionCallback");
  const setCallback = () => vcall(session, "setCallback", "(Landroid/media/session/MediaSession$Callback;)V", callback);
  const command = (name: string) => vcall(controller, "sendCommand", "(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V", name, null, null);
  await onMain(async () => {
    await setCallback();
    await command("discarded");
    await setCallback();
    await command("delivered");
    expect(commands).toEqual([]);
  });
  await onMain(() => {});
  expect(commands).toEqual(["delivered"]);
  expect(await vcall(controller, "getSessionToken", "()Landroid/media/session/MediaSession$Token;")).toBe(token);
  await vcall(session, "setActive", "(Z)V", 1);
  expect(await vcall(session, "isActive", "()Z")).toBe(1);
  await vcall(session, "release", "()V");
  await command("released");
  await onMain(() => {});
  expect(commands).toEqual(["delivered"]);
});

test("PlaybackState builders preserve immutable snapshots and 64-bit positions", async () => {
  const builder = await newObj("android/media/session/PlaybackState$Builder"), position = 9007199254740993n;
  await vcall(builder, "setState", "(IJFJ)Landroid/media/session/PlaybackState$Builder;", 3, position, 1.25, 45n);
  const first = await vcall(builder, "build", "()Landroid/media/session/PlaybackState;");
  await vcall(builder, "setState", "(IJFJ)Landroid/media/session/PlaybackState$Builder;", 2, 0n, 0, 80n);
  expect(await vcall(first, "getPosition", "()J")).toBe(position);
  expect(await vcall(first, "getState", "()I")).toBe(3);
  expect(await vcall(first, "getPlaybackSpeed", "()F")).toBe(1.25);
  expect(await vcall(first, "getLastPositionUpdateTime", "()J")).toBe(45n);
});
