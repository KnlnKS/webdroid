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


test("Intent and ComponentName use the Android 13 Parcel layout", async () => {
  const { importParcel, exportParcel } = await import("./binder");
  // Device API 35 bytes with its extended-flags word removed per Android 13 Intent.java.
  for (const [hex, action, identifier] of [
    ["ffffffff00000000ffffffffffffffff00000000ffffffffffffffff00000000000000000000000000000000feffffffffffffff00000000", null, null],
    ["0b000000746573742e616374696f6e000100000024000000636f6e74656e743a2f2f666978747572652f61253230623f713d3123667261676d656e7400000000ffffffff0a000000666978747572652d69640000040000100a000000746573742e6f776e657200000a00000074006500730074002e006f0077006e0065007200000000001700000074006500730074002e006f0077006e00650072002e0041007500740068004100630074006900760069007400790000000100000001000000020000001e00000028000000010000000d000000746573742e63617465676f72790000000000000000000000feffffff40000000424e444c02000000040000007400650073007400000000000000000005000000760061006c007500650000000500000063006f0075006e0074000000010000000700000000000000", "test.action", "fixture-id"],
  ] as const) {
    const p = importParcel({ bytes: Uint8Array.from(Buffer.from(hex, "hex")), objects: [] }, await newObj("android/os/Parcel"));
    const intent = await newObj("android/content/Intent", "(Landroid/os/Parcel;)V", p);
    expect(intent.action).toBe(action); expect(intent.identifier).toBe(identifier); expect(p.pos).toBe(p.size);
    const written = await newObj("android/os/Parcel");
    await vcall(intent, "writeToParcel", "(Landroid/os/Parcel;I)V", written, 0);
    expect(Buffer.from(written.buf.subarray(0, written.size)).toString("hex")).toBe(hex);
    if (action) {
      expect(await vcall(intent, "getIntExtra", "(Ljava/lang/String;I)I", "count", -1)).toBe(7);
      const component = await vcall(intent, "getComponent", "()Landroid/content/ComponentName;");
      const cp = await newObj("android/os/Parcel");
      await vcall(cp, "writeParcelable", "(Landroid/os/Parcelable;I)V", component, 0);
      const copy = await vcall(importParcel(exportParcel(cp)), "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
      expect(await vcall(copy, "flattenToString", "()Ljava/lang/String;")).toBe("test.owner/test.owner.AuthActivity");
    }
  }
});

test("nested Intent replies preserve callback handles and metadata through both IPC codecs", async () => {
  const { importParcel, exportParcel } = await import("./binder");
  const { encodeIntent, decodeIntent } = await import("./intentipc");
  const intent = await newObj("android/content/Intent"), selector = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "test.SELECT");
  const receiver = await newObj("android/os/Binder"), bounds = await newObj("android/graphics/Rect", "(IIII)V", 1, 2, 30, 40);
  await vcall(intent, "setIdentifier", "(Ljava/lang/String;)Landroid/content/Intent;", "fixture");
  await vcall(intent, "setSourceBounds", "(Landroid/graphics/Rect;)V", bounds);
  await vcall(intent, "setSelector", "(Landroid/content/Intent;)V", selector);
  bounds.left = 99;
  const extras = await newObj("android/os/Bundle"); await vcall(extras, "putBinder", "(Ljava/lang/String;Landroid/os/IBinder;)V", "response", receiver);
  await vcall(intent, "putExtras", "(Landroid/os/Bundle;)Landroid/content/Intent;", extras);
  const reply = await newObj("android/os/Bundle"); await vcall(reply, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "intent", intent);
  const p = await newObj("android/os/Parcel"); await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", reply);
  const wire = exportParcel(p); expect(wire.objects.length).toBe(1);
  const bundle = await vcall(importParcel(wire), "readBundle", "()Landroid/os/Bundle;");
  for (const copy of [bundle.map.get("intent"), await decodeIntent(structuredClone(await encodeIntent(intent)))]) {
    expect(copy.identifier).toBe("fixture"); expect(copy.selector.action).toBe("test.SELECT");
    expect(copy.sourceBounds.left).toBe(1); expect(copy.sourceBounds).not.toBe(intent.sourceBounds);
    expect(copy.extras.map.get("response")).toBe(receiver);
  }
  await expect(vcall(intent, "setPackage", "(Ljava/lang/String;)Landroid/content/Intent;", "test.pkg")).rejects.toThrow();
  await expect(vcall(selector, "setSelector", "(Landroid/content/Intent;)V", selector)).rejects.toThrow();
});
