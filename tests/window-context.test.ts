import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JContext, display } from "../src/android/context";

rt.linkNatives();

test("display and window contexts retain display identity and own their window service", async () => {
  const source = new JContext(), screen = await display();
  const displayContext = await vcall(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", screen);
  expect(await vcall(displayContext, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
  expect(await vcall(displayContext, "isUiContext", "()Z")).toBe(0);
  const window = await vcall(displayContext, "createWindowContext", "(ILandroid/os/Bundle;)Landroid/content/Context;", 2038, null);
  expect(rt.iof(window, "android/content/ContextWrapper")).toBeTruthy();
  expect(await vcall(window, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
  expect(await vcall(window, "isUiContext", "()Z")).toBe(1);
  const manager = await vcall(window, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window");
  expect(await vcall(window, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", rt.classFor("android/view/WindowManager"))).toBe(manager);
  const second = await vcall(source, "createWindowContext", "(Landroid/view/Display;ILandroid/os/Bundle;)Landroid/content/Context;", screen, 2038, null);
  expect(await vcall(second, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window")).not.toBe(manager);
  const error = await vcall(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", null).then(() => null, e => e);
  expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBeTruthy();
});
