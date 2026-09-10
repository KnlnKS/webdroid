import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JContext, JContextWrapper } from "./context";
import { JIntent } from "./intent";
import { inMainJob, onMain } from "./mainloop";
import { runningServices, svcStart, svcStop, bindLocalService, unbindLocalService } from "./runningservices";

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

test("bindings share a binder and preserve started services for rebind", async () => {
  const events: string[] = [], ctx = new JContext(), cls = "webdroid.BoundServiceTest";
  const binder = new (rt.link("android/os/Binder").ctor)();
  rt.register({ name: cls.replace(/\./g, "/"), ctor: class extends rt.link("android/app/Service").ctor {}, sup: "android/app/Service", methods: {
    "onCreate()V": () => { expect(inMainJob()).toBe(true); events.push("create"); },
    "onBind(Landroid/content/Intent;)Landroid/os/IBinder;": () => { events.push("bind"); return binder; },
    "onUnbind(Landroid/content/Intent;)Z": () => { events.push("unbind"); return 1; },
    "onRebind(Landroid/content/Intent;)V": () => { events.push("rebind"); },
    "onDestroy()V": () => { events.push("destroy"); },
  } });
  const intent = new JIntent(); intent.component = cls;
  svcStart(ctx, intent, false);
  expect(await bindLocalService(ctx, intent, "first")).toBe(binder);
  expect(await bindLocalService(ctx, intent, "second")).toBe(binder);
  await unbindLocalService("first");
  expect(events).toEqual(["create", "bind"]);
  await unbindLocalService("second");
  expect(events).toEqual(["create", "bind", "unbind"]);
  expect(await bindLocalService(ctx, intent, "third")).toBe(binder);
  expect(events.at(-1)).toBe("rebind");
  expect(svcStop(cls)).toBe(1);
  await onMain(() => {});
  expect(runningServices.has(cls)).toBe(true);
  await unbindLocalService("third");
  expect(events.slice(-2)).toEqual(["unbind", "destroy"]);
  expect(runningServices.has(cls)).toBe(false);
});
