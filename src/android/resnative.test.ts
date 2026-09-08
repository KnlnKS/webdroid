import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JLocale } from "../jvm/natives/jvalues";
import { Arsc } from "./arsc";
import { Resources } from "./res";
import { JResources, deviceConfiguration } from "./resnative";

function locale(tag: string): JLocale {
  return rt.link("java/util/Locale").ctor[mangleMethod("forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;")](tag);
}
const newConfig = () => new (rt.link("android/content/res/Configuration").ctor)();

test("LocaleList copies, deduplicates and returns the supplied locale order", async () => {
  const list = new (rt.link("android/os/LocaleList").ctor)();
  const input = [locale("ar-EG"), locale("fr-FR"), locale("ar-EG")];
  await vcall(list, "<init>", "([Ljava/util/Locale;)V", input);
  input[0] = locale("de-DE");
  expect(await vcall(list, "toLanguageTags", "()Ljava/lang/String;")).toBe("ar-EG,fr-FR");
  expect(await vcall(list, "size", "()I")).toBe(2);
  expect(await vcall(list, "isEmpty", "()Z")).toBe(0);
  expect(await vcall(list, "get", "(I)Ljava/util/Locale;", 2)).toBeNull();
  expect(await vcall(list, "get", "(I)Ljava/util/Locale;", -1)).toBeNull();
  const error = rt.link("java/lang/NullPointerException").ctor;
  await expect(vcall(list, "<init>", "([Ljava/util/Locale;)V", [null])).rejects.toBeInstanceOf(error);
});

test("Configuration stores local locale lists and honors explicit script direction", async () => {
  const config = newConfig(), device = deviceConfiguration();
  const original = device.locale;
  for (const [tag, direction] of [["ar", 1], ["ar-Latn", 0], ["az-Arab", 1], ["nqo", 1], ["en-US", 0]] as const) {
    await vcall(config, "setLocale", "(Ljava/util/Locale;)V", locale(tag));
    expect(await vcall(config, "getLayoutDirection", "()I")).toBe(direction);
    const list = await vcall(config, "getLocales", "()Landroid/os/LocaleList;");
    expect(await vcall(list, "toLanguageTags", "()Ljava/lang/String;")).toBe(tag);
  }
  expect(device.locale).toBe(original);
  await vcall(config, "setLocale", "(Ljava/util/Locale;)V", null);
  expect(await vcall(await vcall(config, "getLocales", "()Landroid/os/LocaleList;"), "isEmpty", "()Z")).toBe(1);
  expect(await vcall(config, "getLayoutDirection", "()I")).toBe(0);
});

test("Configuration copies preserve lists and repair direct legacy locale writes", async () => {
  const list = new (rt.link("android/os/LocaleList").ctor)();
  await vcall(list, "<init>", "([Ljava/util/Locale;)V", [locale("fr-FR"), locale("en-GB")]);
  const original = newConfig(), copy = newConfig();
  await vcall(original, "setLocales", "(Landroid/os/LocaleList;)V", list);
  await vcall(copy, "<init>", "(Landroid/content/res/Configuration;)V", original);
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", original)).toBe(1);
  const config = deviceConfiguration();
  const saved = config.locale;
  try {
    config.locale = locale("de-DE");
    const corrected = await vcall(config, "getLocales", "()Landroid/os/LocaleList;");
    expect(await vcall(corrected, "toLanguageTags", "()Ljava/lang/String;")).toBe("de-DE");
  } finally {
    config.locale = saved;
    await vcall(config, "getLocales", "()Landroid/os/LocaleList;");
  }
  await vcall(copy, "setLocale", "(Ljava/util/Locale;)V", locale("es-ES"));
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", original)).toBe(0);
  expect(await vcall(await vcall(original, "getLocales", "()Landroid/os/LocaleList;"), "toLanguageTags", "()Ljava/lang/String;")).toBe("fr-FR,en-GB");
});


test("Resources applies language qualifiers only when accepting a configuration", async () => {
  const table = new Arsc(new Uint8Array([2, 0, 8, 0, 8, 0, 0, 0]));
  const qualifiers = { density: 0, sdk: 0, orientation: 0, night: 0, lang: "", swdp: 0, wdp: 0, hdp: 0, size: 0, dir: 0, uiType: 0, score: 0 };
  table.types.set(1, [
    { id: 1, name: "integer", config: qualifiers, entries: new Map([[0, { key: "value", value: { type: 0x10, data: 1 } }]]) },
    { id: 1, name: "integer", config: { ...qualifiers, lang: "ar", dir: 0x80 }, entries: new Map([[0, { key: "value", value: { type: 0x10, data: 2 } }]]) },
  ]);
  rt.link("android/content/res/Resources");
  const resources = new JResources();
  resources.host = new Resources(table, {});
  const config = newConfig(), saved = newConfig();
  await vcall(saved, "<init>", "(Landroid/content/res/Configuration;)V", deviceConfiguration());
  await vcall(config, "setLocale", "(Ljava/util/Locale;)V", locale("ar"));
  expect(resources.host.ref(0x7f010000).d).toBe(1);
  try {
    await vcall(resources, "updateConfiguration", "(Landroid/content/res/Configuration;Landroid/util/DisplayMetrics;)V", config, null);
    expect(resources.host.ref(0x7f010000).d).toBe(2);
  } finally {
    await vcall(resources, "updateConfiguration", "(Landroid/content/res/Configuration;Landroid/util/DisplayMetrics;)V", saved, null);
  }
  expect(resources.host.ref(0x7f010000).d).toBe(1);
});
