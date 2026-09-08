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
