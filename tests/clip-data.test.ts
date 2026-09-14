import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("ClipData.newIntent retains its description and intent item", async () => {
  const intent = await newObj("android/content/Intent");
  const clip = await (rt.link("android/content/ClipData").ctor as any)[mangleMethod("newIntent", "(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;")]("label", intent);
  expect(await vcall(clip, "getItemCount", "()I")).toBe(1);
  const item = await vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0);
  expect(await vcall(item, "getIntent", "()Landroid/content/Intent;")).toBe(intent);
  const description = await vcall(clip, "getDescription", "()Landroid/content/ClipDescription;");
  expect(await vcall(description, "getMimeType", "(I)Ljava/lang/String;", 0)).toBe("text/vnd.android.intent");
});

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
