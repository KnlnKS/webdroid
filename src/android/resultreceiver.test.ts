import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JBundle } from "./os";
import { JParcel } from "./parcel";
import { exportParcel, importParcel } from "./binder";
import { JResultReceiver } from "./resultreceiver";

test("ResultReceiver inherits its parcel creator and delivers results through the original Binder", async () => {
  const received: [number, string][] = [];
  rt.register({ name: "test/ResultReceiver", ctor: class extends JResultReceiver {}, sup: "android/os/ResultReceiver", methods: {
    "<init>()V": () => {},
    "onReceiveResult(ILandroid/os/Bundle;)V": (code: number, bundle: JBundle) => { received.push([code, String(bundle.map.get("value"))]); },
  } });
  const receiver = await newObj("test/ResultReceiver"), parcel = await newObj("android/os/Parcel");
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", receiver, 0);
  if (!(parcel instanceof JParcel)) throw new Error("Parcel unavailable");
  const copy = await vcall(importParcel(exportParcel(parcel)), "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(copy).not.toBe(receiver);
  const bundle = new JBundle(); bundle.map.set("value", "delivered");
  await vcall(copy, "send", "(ILandroid/os/Bundle;)V", 23, bundle);
  expect(received).toEqual([[23, "delivered"]]);
});
