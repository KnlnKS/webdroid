import { expect, test } from "bun:test";
import "../natives";
import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { JContext, systemService } from "./context";

test("the text services manager reports no installed spelling service", async () => {
  const manager = systemService(new JContext(), "textservices");
  expect(rt.iof(manager, "android/view/textservice/TextServicesManager")).toBe(1);
  expect(await vcall(manager, "isSpellCheckerEnabled", "()Z")).toBe(0);
  const checkers = await vcall(manager, "getEnabledSpellCheckerInfos", "()Ljava/util/List;");
  rt.link("java/util/ArrayList");
  expect(await vcall(checkers, "size", "()I")).toBe(0);
  const signature = "(Landroid/os/Bundle;Ljava/util/Locale;Landroid/view/textservice/SpellCheckerSession$SpellCheckerSessionListener;Z)Landroid/view/textservice/SpellCheckerSession;";
  expect(await vcall(manager, "newSpellCheckerSession", signature, null, null, new JObj(), 1)).toBeNull();
  expect(await vcall(manager, "newSpellCheckerSession", signature, null, new JObj(), new JObj(), 0)).toBeNull();
  await expect(vcall(manager, "newSpellCheckerSession", signature, null, null, null, 1)).rejects.toMatchObject({ msg: "listener" });
  await expect(vcall(manager, "newSpellCheckerSession", signature, null, null, new JObj(), 0)).rejects.toMatchObject({ msg: "locale" });
});

test("View and EditText retain independent automatic handwriting preferences", async () => {
  const view = new (rt.link("android/view/View").ctor)();
  const editor = new (rt.link("android/widget/EditText").ctor)();
  expect(await vcall(view, "isAutoHandwritingEnabled", "()Z")).toBe(1);
  expect(await vcall(editor, "isAutoHandwritingEnabled", "()Z")).toBe(1);
  await vcall(editor, "setAutoHandwritingEnabled", "(Z)V", 0);
  expect(await vcall(editor, "isAutoHandwritingEnabled", "()Z")).toBe(0);
  expect(await vcall(view, "isAutoHandwritingEnabled", "()Z")).toBe(1);
  await vcall(editor, "setAutoHandwritingEnabled", "(Z)V", 1);
  expect(await vcall(editor, "isAutoHandwritingEnabled", "()Z")).toBe(1);
});
