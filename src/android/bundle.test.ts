import { expect, test } from "bun:test";
import { JBundle } from "./os";
import "./intent";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";

test("host bundles and Intent extras have Bundle identity and BaseBundle ancestry", async () => {
  rt.link("android/os/BaseBundle");
  const host = new JBundle();
  expect(rt.iof(host, "android/os/Bundle")).toBe(1);
  expect(rt.iof(host, "android/os/BaseBundle")).toBe(1);
  const intent = await newObj("android/content/Intent");
  await vcall(intent, "putExtra", "(Ljava/lang/String;I)Landroid/content/Intent;", "chapter", 1);
  const extras = await vcall(intent, "getExtras", "()Landroid/os/Bundle;");
  expect(rt.iof(extras, "android/os/Bundle")).toBe(1);
  expect(rt.cc(extras, "android/os/Bundle")).toBe(extras);
  const persistent = await newObj("android/os/PersistableBundle");
  expect(rt.iof(persistent, "android/os/BaseBundle")).toBe(1);
  expect(rt.iof(persistent, "android/os/Bundle")).toBe(0);
});

test("Bundle copy and clone retain nested values and loader but detach the map", async () => {
  const original = await newObj("android/os/Bundle") as JBundle;
  const nested = new JBundle(), loader = {};
  original.map.set("nested", nested); original.loader = loader;
  const copy = await newObj("android/os/Bundle", "(Landroid/os/Bundle;)V", original) as JBundle;
  const clone = await vcall(original, "clone", "()Ljava/lang/Object;") as JBundle;
  for (const value of [copy, clone]) {
    expect(rt.iof(value, "android/os/Bundle")).toBe(1);
    expect(value.map).not.toBe(original.map);
    expect(value.map.get("nested")).toBe(nested);
    expect(value.loader).toBe(loader);
    value.map.set("only copy", 1);
  }
  expect(original.map.has("only copy")).toBe(false);
});
