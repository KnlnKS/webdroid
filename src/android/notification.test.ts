import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("notification null extras preserve setters and user metadata is copied at build", async () => {
  const builder = await newObj("android/app/Notification$Builder", "(Landroid/content/Context;)V", null);
  const extras = await newObj("android/os/Bundle");
  extras.map.set("custom", "before");
  const result = "Landroid/app/Notification$Builder;";
  await vcall(builder, "setExtras", "(Landroid/os/Bundle;)" + result, extras);
  await vcall(builder, "setExtras", "(Landroid/os/Bundle;)" + result, null);
  await vcall(builder, "setRemoteInputHistory", "([Ljava/lang/CharSequence;)" + result, null);
  await vcall(builder, "setContentTitle", "(Ljava/lang/CharSequence;)" + result, "Installing");
  expect(await vcall(builder, "getExtras", "()Landroid/os/Bundle;")).toBe(extras);
  const notification = await vcall(builder, "build", "()Landroid/app/Notification;");
  expect(notification.extras.map.get("android.title")).toBe("Installing");
  expect(notification.extras.map.get("custom")).toBe("before");
  extras.map.set("custom", "after");
  expect(notification.extras.map.get("custom")).toBe("before");
  await vcall(builder, "build", "()Landroid/app/Notification;");
  expect(notification.extras.map.get("custom")).toBe("after");
});
