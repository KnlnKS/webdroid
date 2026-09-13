import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("AccessibilityServiceInfo starts with Android's disabled defaults", async () => {
  const info = await newObj("android/accessibilityservice/AccessibilityServiceInfo", "()V");
  expect(await vcall(info, "getCapabilities", "()I")).toBe(0);
  expect(await vcall(info, "getId", "()Ljava/lang/String;")).toBeNull();
  expect(info).toMatchObject({ eventTypes: 0, feedbackType: 0, flags: 0, notificationTimeout: 0n, packageNames: null });
});
