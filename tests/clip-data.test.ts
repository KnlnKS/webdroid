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
