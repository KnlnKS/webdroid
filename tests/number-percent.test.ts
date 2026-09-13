import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
for (const cls of ["java/text/NumberFormat", "android/icu/text/NumberFormat"]) {
  test(`${cls} scales percentages, rounds ties evenly and updates cached options`, async () => {
    const locale = await newObj("java/util/Locale", "(Ljava/lang/String;Ljava/lang/String;)V", "en", "US");
    const f = await vcall(rt.link(cls).ctor, "getPercentInstance", `(Ljava/util/Locale;)L${cls};`, locale);
    expect(rt.iof(f, cls)).toBe(1);
    for (const [value, text] of [[0.14, "14%"], [0.025, "2%"], [0.035, "4%"], [-0.025, "-2%"]]) {
      expect(await vcall(f, "format", "(D)Ljava/lang/String;", value)).toBe(text);
    }
    await vcall(f, "setMinimumFractionDigits", "(I)V", 2);
    expect(await vcall(f, "format", "(D)Ljava/lang/String;", 0.125)).toBe("12.50%");
    await vcall(f, "setMaximumFractionDigits", "(I)V", 0);
    expect(await vcall(f, "getMinimumFractionDigits", "()I")).toBe(0);
    expect(await vcall(f, "format", "(D)Ljava/lang/String;", 0.125)).toBe("12%");
    const german = await newObj("java/util/Locale", "(Ljava/lang/String;Ljava/lang/String;)V", "de", "DE");
    const de = await vcall(rt.link(cls).ctor, "getPercentInstance", `(Ljava/util/Locale;)L${cls};`, german);
    expect(await vcall(de, "format", "(D)Ljava/lang/String;", 0.25)).toBe("25\u00a0%");
  });
}
test("NumberFormat preserves all long integer digits", async () => {
  const f = await vcall(rt.link("java/text/NumberFormat").ctor, "getInstance", "()Ljava/text/NumberFormat;");
  expect(await vcall(f, "format", "(J)Ljava/lang/String;", 9007199254740993n)).toBe("9,007,199,254,740,993");
});
