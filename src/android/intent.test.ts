import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";

test("Intent.getComponent synchronously reports only an explicit component", async () => {
  const intent = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "android.intent.action.VIEW");
  const get = () => intent[mangleMethod("getComponent", "()Landroid/content/ComponentName;")]();
  expect(get()).toBeNull();
  await vcall(intent, "setPackage", "(Ljava/lang/String;)Landroid/content/Intent;", "example.app");
  expect(get()).toBeNull();
  await vcall(intent, "setClassName", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;", "example.app", "example.app.Main");
  const component = get();
  expect(component).not.toBeInstanceOf(Promise);
  expect(await vcall(component, "getPackageName", "()Ljava/lang/String;")).toBe("example.app");
  expect(await vcall(component, "getClassName", "()Ljava/lang/String;")).toBe("example.app.Main");
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", null);
  expect(get()).toBeNull();
});
