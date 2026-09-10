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


test("typed Bundle and Intent extras retain primitive values across Parcel", async () => {
  const original = new JBundle();
  const values = [["Int", "I", 8], ["Long", "J", 123456789012345n], ["Boolean", "Z", 1], ["Float", "F", 1.25], ["Double", "D", 7]] as const;
  for (const [name, descriptor, value] of values) await vcall(original, "put" + name, "(Ljava/lang/String;" + descriptor + ")V", name, value);
  const parcel = await newObj("android/os/Parcel");
  await vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", original);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const decoded = await vcall(parcel, "readBundle", "()Landroid/os/Bundle;");
  const intent = await newObj("android/content/Intent");
  await vcall(intent, "putExtras", "(Landroid/os/Bundle;)Landroid/content/Intent;", decoded);
  for (const [name, descriptor, value] of values) {
    const fallback = descriptor === "J" ? -1n : -1;
    expect(await vcall(decoded, "get" + name, "(Ljava/lang/String;)" + descriptor, name)).toBe(value);
    expect(await vcall(decoded, "get" + name, "(Ljava/lang/String;" + descriptor + ")" + descriptor, name, fallback)).toBe(value);
    expect(await vcall(intent, "get" + name + "Extra", "(Ljava/lang/String;" + descriptor + ")" + descriptor, name, fallback)).toBe(value);
    expect(await vcall(decoded, "get" + name, "(Ljava/lang/String;" + descriptor + ")" + descriptor, "missing", fallback)).toBe(fallback);
  }
  expect(await vcall(decoded, "getInt", "(Ljava/lang/String;I)I", "Boolean", -2)).toBe(-2);
});
