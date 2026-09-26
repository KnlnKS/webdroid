import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("LocaleSpan retains locale order through paint copies and parcel round trips", async () => {
  const locales = await vcall(rt.link("android/os/LocaleList").ctor, "forLanguageTags", "(Ljava/lang/String;)Landroid/os/LocaleList;", "ja-JP,en-US");
  const span = await newObj("android/text/style/LocaleSpan", "(Landroid/os/LocaleList;)V", locales);
  expect(rt.iof(span, "android/text/style/MetricAffectingSpan")).toBe(1);
  const paint = await newObj("android/text/TextPaint");
  await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
  expect(await vcall(copy, "getTextLocales", "()Landroid/os/LocaleList;")).toBe(locales);
  expect(copy.language).toBe("ja-JP");
  const parcel = await newObj("android/os/Parcel");
  await vcall(span, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await newObj("android/text/style/LocaleSpan", "(Landroid/os/Parcel;)V", parcel);
  const list = await vcall(restored, "getLocales", "()Landroid/os/LocaleList;");
  expect(await vcall(list, "toLanguageTags", "()Ljava/lang/String;")).toBe("ja-JP,en-US");
  expect(await vcall(restored, "getSpanTypeId", "()I")).toBe(23);
  const empty = await newObj("android/text/style/LocaleSpan", "(Ljava/util/Locale;)V", null);
  expect(await vcall(empty, "getLocale", "()Ljava/util/Locale;")).toBeNull();
  await expect(vcallAsync(empty, "updateDrawState", "(Landroid/text/TextPaint;)V", paint)).rejects.toMatchObject({ msg: "locales cannot be null or empty" });
});
