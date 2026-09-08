import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JContext, JContextWrapper } from "./context";
import { JIntent } from "./intent";
import { inMainJob, onMain } from "./mainloop";
import { runningServices, svcStart, svcStop } from "./runningservices";

test("started services create once, receive ordered starts and destroy after the latest stop", async () => {
  const events: string[] = [], instances: JContextWrapper[] = [];
  const ctx = new JContext(), cls = "webdroid.StartedServiceTest";
  rt.register({ name: cls.replace(/\./g, "/"), ctor: class extends rt.link("android/app/Service").ctor {}, sup: "android/app/Service", methods: {
    "onCreate()V": function (this: JContextWrapper) {
      expect(inMainJob()).toBe(true); expect(this.base).toBe(ctx);
      events.push("create"); instances.push(this);
    },
    "onStartCommand(Landroid/content/Intent;II)I": function (intent: JIntent, flags: number, id: number) {
      expect(inMainJob()).toBe(true); expect(flags).toBe(0);
      events.push(`${intent.action}:${id}`); return 2;
    },
    "onDestroy()V": () => { expect(inMainJob()).toBe(true); events.push("destroy"); },
  } });
  const first = new JIntent(); first.component = cls; first.action = "first";
  const second = new JIntent(); second.component = cls; second.action = "second";
  await onMain(() => {
    expect(svcStart(ctx, first, true)).not.toBeNull();
    svcStart(ctx, second, false);
    expect(events).toEqual([]);
  });
  await onMain(() => {});
  expect(events).toEqual(["create", "first:1", "second:2"]);
  expect(runningServices.get(cls)?.foreground).toBe(0);
  expect(await vcall(instances[0], "stopSelfResult", "(I)Z", 1)).toBe(0);
  expect(runningServices.has(cls)).toBe(true);
  await onMain(async () => {
    expect(await vcall(instances[0], "stopSelfResult", "(I)Z", 2)).toBe(1);
    expect(events.at(-1)).toBe("second:2");
  });
  await onMain(() => {});
  expect(events.at(-1)).toBe("destroy");
  expect(runningServices.has(cls)).toBe(false);
  svcStart(ctx, first, false);
  await onMain(() => {});
  expect(instances).toHaveLength(2);
  expect(instances[1]).not.toBe(instances[0]);
  expect(events.slice(-2)).toEqual(["create", "first:1"]);
  svcStop(cls);
  await onMain(() => {});
});
