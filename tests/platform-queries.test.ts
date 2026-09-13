import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mkUri } from "../src/android/net";
rt.linkNatives();
test("ContentUris preserves full-width IDs", async () => {
  const cls = rt.link("android/content/ContentUris").ctor;
  const uri = await vcall(cls, "withAppendedId", "(Landroid/net/Uri;J)Landroid/net/Uri;", mkUri("content://test/items"), 9223372036854775807n);
  expect(await vcall(cls, "parseId", "(Landroid/net/Uri;)J", uri)).toBe(9223372036854775807n);
});
test("NetworkRequest snapshots sorted unique transport and capability sets", async () => {
  const builder = await newObj("android/net/NetworkRequest$Builder");
  for (const value of [3, 1, 3]) await vcall(builder, "addTransportType", "(I)Landroid/net/NetworkRequest$Builder;", value);
  const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
  await vcall(builder, "addTransportType", "(I)Landroid/net/NetworkRequest$Builder;", 4);
  expect(await vcall(request, "getTransportTypes", "()[I")).toEqual(Int32Array.of(1, 3));
});
test("NotificationChannelGroup persists empty descriptions and supports deletion", async () => {
  const manager = rt.make("android/app/NotificationManager");
  const group = await newObj("android/app/NotificationChannelGroup", "(Ljava/lang/String;Ljava/lang/CharSequence;)V", "query-test", "Test");
  await vcall(group, "setDescription", "(Ljava/lang/String;)V", "");
  await vcall(manager, "createNotificationChannelGroup", "(Landroid/app/NotificationChannelGroup;)V", group);
  try {
    const copy = await vcall(manager, "getNotificationChannelGroup", "(Ljava/lang/String;)Landroid/app/NotificationChannelGroup;", "query-test");
    expect(await vcall(copy, "getName", "()Ljava/lang/CharSequence;")).toBe("Test");
    expect(await vcall(copy, "getDescription", "()Ljava/lang/String;")).toBe("");
  } finally { await vcall(manager, "deleteNotificationChannelGroup", "(Ljava/lang/String;)V", "query-test"); }
  expect(await vcall(manager, "getNotificationChannelGroup", "(Ljava/lang/String;)Landroid/app/NotificationChannelGroup;", "query-test")).toBeNull();
});
