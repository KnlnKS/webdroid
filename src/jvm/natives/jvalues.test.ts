import { expect, test } from "bun:test";
import { linkInit, newObj, vcall } from "./jlang";
import "./jvalues";

test("locales preserve script, region and variants independently", async () => {
  const cls = (await linkInit("java/util/Locale")).ctor;
  for (const [tag, language, script, region, variant] of [
    ["zh-Hant-TW", "zh", "Hant", "TW", ""],
    ["sl-Latn-SI-rozaj-biske", "sl", "Latn", "SI", "rozaj_biske"],
    ["und", "", "", "", ""],
  ]) {
    const locale = await vcall(cls, "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", tag);
    const parts = await Promise.all(["Language", "Script", "Country", "Variant"].map((part) => vcall(locale, "get" + part, "()Ljava/lang/String;")));
    expect(parts).toEqual([language, script, region, variant]);
    expect(await vcall(locale, "toLanguageTag", "()Ljava/lang/String;")).toBe(tag);
  }
  const languageOnly = await newObj("java/util/Locale", "(Ljava/lang/String;)V", "FR");
  expect(await vcall(languageOnly, "toString", "()Ljava/lang/String;")).toBe("fr");
});

test("locale display names use the requested display language and preserve empty locales", async () => {
  const cls = (await linkInit("java/util/Locale")).ctor;
  const locale = (tag: string) => vcall(cls, "forLanguageTag", "(Ljava/lang/String;)Ljava/util/Locale;", tag);
  const english = await locale("en"), french = await locale("fr"), german = await locale("de");
  expect(await vcall(french, "getDisplayName", "()Ljava/lang/String;")).toBe("French");
  expect(await vcall(english, "getDisplayName", "(Ljava/util/Locale;)Ljava/lang/String;", french)).toBe("anglais");
  expect(await vcall(french, "getDisplayName", "(Ljava/util/Locale;)Ljava/lang/String;", german)).toBe("Französisch");
  expect(await vcall(await locale("und"), "getDisplayName", "()Ljava/lang/String;")).toBe("");
  const region = await newObj("java/util/Locale", "(Ljava/lang/String;Ljava/lang/String;)V", "", "US");
  expect(await vcall(region, "getDisplayName", "()Ljava/lang/String;")).toBe("United States");
  expect(await vcall(await locale("zh-Hant-TW"), "getDisplayName", "()Ljava/lang/String;")).toContain("Taiwan");
  expect(await vcall(await locale("und-Hant-US"), "getDisplayName", "()Ljava/lang/String;")).toContain("United States");
  const invalid = await newObj("java/util/Locale", "(Ljava/lang/String;)V", "not a language");
  expect(await vcall(invalid, "getDisplayName", "()Ljava/lang/String;")).toBe("not a language");
  await expect(vcall(french, "getDisplayName", "(Ljava/util/Locale;)Ljava/lang/String;", null)).rejects.toBeDefined();
});
