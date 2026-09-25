import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("createChooser retains the send intent behind ACTION_CHOOSER", async () => {
  const send = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "android.intent.action.SEND_MULTIPLE");
  await vcall(send, "addFlags", "(I)Landroid/content/Intent;", 1);
  const chooser = await vcall(rt.link("android/content/Intent").ctor, "createChooser",
    "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;", send, "Share track");
  expect(await vcall(chooser, "getAction", "()Ljava/lang/String;")).toBe("android.intent.action.CHOOSER");
  expect(await vcall(chooser, "getParcelableExtra", "(Ljava/lang/String;)Landroid/os/Parcelable;", "android.intent.extra.INTENT")).toBe(send);
  expect(await vcall(chooser, "getFlags", "()I")).toBe(1);
});
