import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();

test("ClipData carries nested intents across a Parcel boundary", async () => {
  const inner = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "test.action");
  const clip = await vcall(rt.link("android/content/ClipData").ctor, "newIntent", "(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;", "label", inner);
  const outer = await newObj("android/content/Intent");
  await vcall(outer, "setClipData", "(Landroid/content/ClipData;)V", clip);
  const parcel = await newObj("android/os/Parcel");
  await vcall(outer, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await newObj("android/content/Intent", "(Landroid/os/Parcel;)V", parcel);
  const result = await vcall(restored, "getClipData", "()Landroid/content/ClipData;");
  expect(result).not.toBe(clip);
  const desc = await vcall(result, "getDescription", "()Landroid/content/ClipDescription;");
  expect(await vcall(desc, "getLabel", "()Ljava/lang/CharSequence;")).toBe("label");
  expect(await vcall(desc, "hasMimeType", "(Ljava/lang/String;)Z", "text/*")).toBe(1);
  const item = await vcall(result, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0);
  const intent = await vcall(item, "getIntent", "()Landroid/content/Intent;");
  expect(await vcall(intent, "getAction", "()Ljava/lang/String;")).toBe("test.action");
  expect(await vcall(parcel, "dataAvail", "()I")).toBe(0);
});
