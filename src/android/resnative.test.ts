import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { zipTree } from "../jvm/natives/jzip";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JLocale } from "../jvm/natives/jvalues";
import { Arsc } from "./arsc";
import { Resources, JTheme, JTypedArray, rvColor, setFramework } from "./res";
import { JContext } from "./context";
import type { AppHost } from "./apphost";
import { JResources, deviceConfiguration, scopedResources } from "./resnative";

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
  const qualifiers = { density: 0, sdk: 0, orientation: 0, night: 0, lang: "", region: "", swdp: 0, wdp: 0, hdp: 0, size: 0, dir: 0, uiType: 0, score: 0 };
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


function localizedTable(files: (path: string) => Uint8Array | null = () => null): Arsc {
  const pool = (strings: string[]) => {
    const encoded = strings.map(s => new TextEncoder().encode(s));
    const start = 28 + strings.length * 4, size = (start + encoded.reduce((n, b) => n + b.length + 3, 0) + 3) & ~3;
    const bytes = new Uint8Array(size), v = new DataView(bytes.buffer);
    v.setUint16(0, 1, true); v.setUint16(2, 28, true); v.setUint32(4, size, true);
    v.setUint32(8, strings.length, true); v.setUint32(16, 0x100, true); v.setUint32(20, start, true);
    let offset = start;
    for (let i = 0; i < strings.length; i++) {
      v.setUint32(28 + i * 4, offset - start, true);
      bytes[offset++] = strings[i].length; bytes[offset++] = encoded[i].length;
      bytes.set(encoded[i], offset); offset += encoded[i].length + 1;
    }
    return bytes;
  };
  const types = pool(["string", "drawable"]), keys = pool(["greeting"]), values = pool(["Hello", "Bonjour", "مرحبا"]);
  const chunks: Uint8Array[] = [];
  for (const [language, direction, value] of [["", 0, 0], ["fr", 0, 1], ["ar", 0x80, 2]] as const) {
    for (const id of [1, 2]) {
      const bytes = new Uint8Array(72), v = new DataView(bytes.buffer);
      v.setUint16(0, 0x201, true); v.setUint16(2, 52, true); v.setUint32(4, 72, true);
      bytes[8] = id; v.setUint32(12, 1, true); v.setUint32(16, 56, true); v.setUint32(20, 32, true);
      if (language) { bytes[28] = language.charCodeAt(0); bytes[29] = language.charCodeAt(1); }
      bytes[48] = direction; v.setUint16(56, 8, true); v.setUint16(64, 8, true);
      bytes[67] = id === 1 ? 3 : 0x1c; v.setUint32(68, id === 1 ? value : 0xff001100 + value, true);
      chunks.push(bytes);
    }
  }
  const packageSize = 288 + types.length + keys.length + chunks.reduce((n, b) => n + b.length, 0);
  const bytes = new Uint8Array(12 + values.length + packageSize), v = new DataView(bytes.buffer);
  v.setUint16(0, 2, true); v.setUint16(2, 12, true); v.setUint32(4, bytes.length, true); v.setUint32(8, 1, true);
  bytes.set(values, 12);
  const base = 12 + values.length;
  v.setUint16(base, 0x200, true); v.setUint16(base + 2, 288, true); v.setUint32(base + 4, packageSize, true);
  v.setUint32(base + 8, 0x7f, true); v.setUint32(base + 268, 288, true); v.setUint32(base + 276, 288 + types.length, true);
  let offset = base + 288;
  for (const chunk of [types, keys, ...chunks]) { bytes.set(chunk, offset); offset += chunk.length; }
  return new Arsc(bytes, files);
}

test("scoped contexts lazily share localized entries without changing other contexts or caches", async () => {
  const table = localizedTable(), resources = new JResources(), theme = new JTheme();
  rt.link("android/content/Context"); rt.link("android/content/res/Resources");
  resources.host = new Resources(table, {}); theme.res = resources.host;
  const unused = () => { throw new Error("unexpected app lifecycle call"); };
  const host: AppHost = { res: resources.host, jresources: resources, theme, pkg: "test", apkFile: "", appLabel: "", themeResId: 0,
    iconRes: 0, zip: {}, splits: [], application: null, statusBarColor: 0, navBarColor: 0, launch: unused,
    roundTrip: unused, finishActivity: unused, recreateActivity: unused, setRequestedOrientation: unused, currentActivity: () => null, invalidateOptionsMenu: unused };
  const context = new JContext(); context.$host = host;
  const french = newConfig();
  await vcall(french, "setLocale", "(Ljava/util/Locale;)V", locale("fr"));
  const scoped = await vcall(context, "createConfigurationContext", "(Landroid/content/res/Configuration;)Landroid/content/Context;", french);
  const scopedRes = await vcall(scoped, "getResources", "()Landroid/content/res/Resources;");
  const decoded = () => [...table.types.values()].flat().filter(c => c.entries.size).length;
  expect(decoded()).toBe(2);
  expect(await vcall(scoped, "getString", "(I)Ljava/lang/String;", 0x7f010000)).toBe("Bonjour");
  expect(decoded()).toBe(3);
  expect(await vcall(context, "getString", "(I)Ljava/lang/String;", 0x7f010000)).toBe("Hello");
  const second = await vcall(context, "createConfigurationContext", "(Landroid/content/res/Configuration;)Landroid/content/Context;", french);
  expect(await vcall(second, "getString", "(I)Ljava/lang/String;", 0x7f010000)).toBe("Bonjour");
  expect(decoded()).toBe(3);
  expect(rvColor(resources.host, { t: 1, d: 0x7f020000 })).toBe(0xff001100 | 0);
  expect(rvColor(scoped.$host.res, { t: 1, d: 0x7f020000 })).toBe(0xff001101 | 0);
  expect(rvColor(resources.host, { t: 1, d: 0x7f020000 })).toBe(0xff001100 | 0);
  await vcall(french, "setLocale", "(Ljava/util/Locale;)V", locale("ar"));
  expect(await vcall(scoped, "getString", "(I)Ljava/lang/String;", 0x7f010000)).toBe("Bonjour");
  await vcall(scopedRes, "updateConfiguration", "(Landroid/content/res/Configuration;Landroid/util/DisplayMetrics;)V", french, null);
  expect(await vcall(scoped, "getString", "(I)Ljava/lang/String;", 0x7f010000)).toBe("مرحبا");
  expect(rvColor(scoped.$host.res, { t: 1, d: 0x7f020000 })).toBe(0xff001102 | 0);
  expect(await vcall(second, "getString", "(I)Ljava/lang/String;", 0x7f010000)).toBe("Bonjour");
  expect(deviceConfiguration().locale?.lang).toBe("en");
  expect(await vcall(scoped, "getTheme", "()Landroid/content/res/Resources$Theme;")).not.toBe(theme);
});

test("scoped configuration inherits unspecified metrics and qualifier bit groups", async () => {
  const base = newConfig();
  await vcall(base, "setLocale", "(Ljava/util/Locale;)V", locale("ar"));
  base.fontScale = 1.25; base.densityDpi = 320; base.orientation = 2;
  base.uiMode = 0x23; base.screenLayout = 0x282;
  const source = scopedResources(new Resources(null, {}), base), override = newConfig();
  override.fontScale = 0; override.densityDpi = 0; override.orientation = 0;
  override.screenWidthDp = 0; override.screenHeightDp = 0; override.smallestScreenWidthDp = 0;
  override.uiMode = 0x10; override.screenLayout = 3; override.colorMode = 0;
  const child = scopedResources(source.host, override);
  expect(child.host.dm.scaledDensity).toBe(2.5);
  expect(child.host.dm.densityDpi).toBe(320);
  expect(child.config?.fontScale).toBe(1.25);
  expect(child.config?.orientation).toBe(2);
  expect(child.config?.uiMode).toBe(0x13);
  expect(child.config?.screenLayout).toBe(0x293);
  expect(child.config?.locale?.lang).toBe("ar");
  expect(override.fontScale).toBe(0);
  expect(source.config?.uiMode).toBe(0x23);
  override.fontScale = 1.5;
  await vcall(child, "updateConfiguration", "(Landroid/content/res/Configuration;Landroid/util/DisplayMetrics;)V", override, null);
  expect(child.host.dm.scaledDensity).toBe(3);
  expect(source.host.dm.scaledDensity).toBe(2.5);
});


test("TextUtils and Configuration share locale direction including explicit scripts", async () => {
  const text = rt.link("android/text/TextUtils").ctor;
  for (const [tag, expected] of [["en-US", 0], ["ar", 1], ["he", 1], ["fa", 1], ["ar-Latn", 0], ["az-Arab", 1], ["nqo", 1], ["und", 0]] as const) {
    expect(await vcall(text, "getLayoutDirectionFromLocale", "(Ljava/util/Locale;)I", locale(tag))).toBe(expected);
  }
  expect(await vcall(text, "getLayoutDirectionFromLocale", "(Ljava/util/Locale;)I", null)).toBe(0);
  const invalid = Object.assign(new JLocale(), { lang: "not a language" });
  expect(await vcall(text, "getLayoutDirectionFromLocale", "(Ljava/util/Locale;)I", invalid)).toBe(0);
});


test("TypedArray fractions use their base and reject non-fraction values", async () => {
  const array = new (rt.link("android/content/res/TypedArray").ctor)();
  array.vals = [{ t: 6, d: 0x40000030 }, { t: 6, d: 0xc0000031 }, null, { t: 16, d: 5 }, { t: 6, d: 0x40000032 }];
  const fraction = (i: number) => vcall(array, "getFraction", "(IIIF)F", i, 80, 120, 7);
  expect(await fraction(0)).toBe(40);
  expect(await fraction(1)).toBe(-60);
  expect(await fraction(2)).toBe(7);
  await expect(fraction(3)).rejects.toThrow();
  expect(await fraction(4)).toBe(0);
});


const frameworkApk = new URL("../../vendor/aosp/framework-res.apk", import.meta.url);
test.skipIf(!existsSync(frameworkApk))("TypedArray getColor resolves selector attributes in its own theme", async () => {
  const framework = zipTree(new Uint8Array(await Bun.file(frameworkApk).arrayBuffer()));
  setFramework(new Arsc(framework["resources.arsc"]));
  // <selector><item android:color="?android:attr/textColorPrimary"/></selector>
  const xml = Uint8Array.from(Buffer.from("AwAIAOwAAAABABwARAAAAAMAAAAAAAAAAAEAACgAAAAAAAAAAAAAAAsAAAASAAAACAhzZWxlY3RvcgAEBGl0ZW0ABQVjb2xvcgAAAIABCAAUAAAAAAAAAAAAAAClAQEBAgEQACQAAAABAAAA//////////8AAAAAFAAUAAAAAAAAAAAAAgEQADgAAAABAAAA//////////8BAAAAFAAUAAEAAAAAAAAA/////wIAAAD/////CAAAAjYAAQEDARAAGAAAAAEAAAD//////////wEAAAADARAAGAAAAAEAAAD//////////wAAAAA=", "base64"));
  const table = localizedTable(() => xml), res = new Resources(table, {});
  const entry = table.entry(0x7f020000)!;
  entry.value = { type: 3, data: 0 };
  table.values.strings[0] = "res/color/selector.xml";
  rt.link("android/content/res/TypedArray");
  for (const color of [-16776961, -65536]) {
    const theme = new JTheme(); theme.res = res;
    theme.cache.set(0x1010036, { t: 0x1c, d: color });
    const ta = new JTypedArray(); ta.res = res; ta.theme = theme;
    ta.vals = [{ t: 1, d: 0x7f020000 }, { t: 0x1c, d: color }, null];
    expect(await vcall(ta, "getColor", "(II)I", 0, 0)).toBe(color);
    expect(await vcall(ta, "getColor", "(II)I", 1, 0)).toBe(color);
    expect(await vcall(ta, "getColor", "(II)I", 2, 123)).toBe(123);
  }
});
