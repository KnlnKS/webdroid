import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JMessage } from "./messenger";
import { JParcel } from "./parcel";
import { JBundle, JHandler } from "./os";
import { exportBinder, exportParcel, receiveTransaction, importParcel } from "./binder";
import { onMain } from "./mainloop";

test("Messenger Binder delivery copies message data and authenticates the sender", async () => {
  const received: JMessage[] = [];
  rt.register({ name: "test/MessengerHandler", ctor: class extends JHandler {}, sup: "android/os/Handler", methods: {
    "handleMessage(Landroid/os/Message;)V": (m: JMessage) => { received.push(m); },
  } });
  const handler = await newObj("test/MessengerHandler"), messenger = await newObj("android/os/Messenger", "(Landroid/os/Handler;)V", handler);
  const binder = await vcall(messenger, "getBinder", "()Landroid/os/IBinder;");
  const second = await newObj("android/os/Messenger", "(Landroid/os/Handler;)V", handler);
  expect(await vcall(second, "getBinder", "()Landroid/os/IBinder;")).toBe(binder);
  expect(await vcall(binder, "getInterfaceDescriptor", "()Ljava/lang/String;")).toBe("android.os.IMessenger");
  rt.link("android/os/Parcel"); rt.link("android/os/Message");
  const message = new JMessage(); message.what = 7; message.sendingUid = 12;
  message.data = new JBundle(); message.data.map.set("value", "payload"); message.replyTo = second;
  const parcel = new JParcel();
  await vcall(parcel, "writeInterfaceToken", "(Ljava/lang/String;)V", "android.os.IMessenger");
  await vcall(parcel, "writeInt", "(I)V", 1);
  await vcall(message, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await receiveTransaction({ handle: exportBinder(binder)!, code: 1, data: exportParcel(parcel), flags: 0 }, { pid: 222, uid: 10055 });
  await onMain(() => {});
  expect(received).toHaveLength(1);
  expect(received[0]).not.toBe(message);
  expect(received[0].data?.map.get("value")).toBe("payload");
  expect(received[0].sendingUid).toBe(10055);
  expect(await vcall(received[0].replyTo, "getBinder", "()Landroid/os/IBinder;")).toBe(binder);
  const bundleParcel = new JParcel();
  await vcall(message.data, "writeToParcel", "(Landroid/os/Parcel;I)V", bundleParcel, 0);
  const bundle = await vcall(importParcel(exportParcel(bundleParcel)), "readBundle", "()Landroid/os/Bundle;");
  expect(bundle.map.get("value")).toBe("payload");
});
