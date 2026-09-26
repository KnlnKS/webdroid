import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("AppOpsManager accepts and removes active-operation watchers", async () => {
  const manager = await newObj("android/app/AppOpsManager");
  const executor = new JObj();
  const listener = await newObj("android/app/AppOpsManager$OnOpActiveChangedListener");
  await vcall(manager, "startWatchingActive", "([Ljava/lang/String;Ljava/util/concurrent/Executor;Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V", ["android:camera"], executor, listener);
  await vcall(manager, "stopWatchingActive", "(Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V", listener);
  expect(vcallAsync(manager, "startWatchingActive", "([Ljava/lang/String;Ljava/util/concurrent/Executor;Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V", null, executor, listener)).rejects.toBeDefined();
});
