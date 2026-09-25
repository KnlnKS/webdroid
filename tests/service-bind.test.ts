import { expect, test } from "bun:test";
import "../src/natives";
import { JContext } from "../src/android/context";
import { JIntent } from "../src/android/intent";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("a failed service binding still requires one unbind", async () => {
  const context = rt.make("android/content/Context") as JContext;
  context.$host = { pkg: "service-bind-test" } as JContext["$host"];
  const intent = new JIntent();
  intent.componentPkg = "service-bind-test";
  intent.component = "service-bind-test.MissingService";
  const connection = new JObj();
  expect(await vcall(context, "bindService", "(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z", intent, connection, 0)).toBe(0);
  await vcall(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection);
  await expect(vcall(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection)).rejects.toMatchObject({ msg: "Service not registered" });
});
