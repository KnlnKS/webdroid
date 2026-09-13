import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("measurement callback interface is available", () => {
  const receiver = rt.link("android/os/OutcomeReceiver");
  expect(receiver.native).toBe(true);
  expect(receiver.stub).toBe(false);
});

test("disabled measurement service reports its unavailable state", async () => {
  const context = await newObj("android/content/Context");
  const cls = rt.classFor("android/adservices/measurement/MeasurementManager");
  expect(await vcall(context, "getSystemServiceName", "(Ljava/lang/Class;)Ljava/lang/String;", cls)).toBe("measurement_service");
  const manager = await vcall(context, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", cls);
  expect(rt.iof(manager, "android/adservices/measurement/MeasurementManager")).toBe(1);
  await expect(vcall(manager, "registerTrigger", "(Landroid/net/Uri;Ljava/util/concurrent/Executor;Landroid/os/OutcomeReceiver;)V", null, null, null))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
});
