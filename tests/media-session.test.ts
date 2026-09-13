import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("MediaSession retains its token and active state", async () => {
  const session = await newObj("android/media/session/MediaSession", "(Landroid/content/Context;Ljava/lang/String;Landroid/os/Bundle;)V", new JObj(), "test", null);
  const token = await vcall(session, "getSessionToken", "()Landroid/media/session/MediaSession$Token;");
  expect(token).toBe(await vcall(session, "getSessionToken", "()Landroid/media/session/MediaSession$Token;"));
  await vcall(session, "setActive", "(Z)V", 1);
  expect(await vcall(session, "isActive", "()Z")).toBe(1);
  await vcall(session, "release", "()V");
  expect(await vcall(session, "isActive", "()Z")).toBe(0);
});
