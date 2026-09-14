import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("Locale categories retain independent defaults", async () => {
  const locale = rt.link("java/util/Locale").ctor, category = rt.link("java/util/Locale$Category").ctor;
  const previous = await vcall(locale, "getDefault", "()Ljava/util/Locale;");
  try {
    await vcall(locale, "setDefault", "(Ljava/util/Locale$Category;Ljava/util/Locale;)V", category.s$FORMAT, locale.s$FRANCE);
    expect(await vcall(locale, "getDefault", "(Ljava/util/Locale$Category;)Ljava/util/Locale;", category.s$FORMAT)).toBe(locale.s$FRANCE);
    expect(await vcall(locale, "getDefault", "(Ljava/util/Locale$Category;)Ljava/util/Locale;", category.s$DISPLAY)).toBe(previous);
  } finally { await vcall(locale, "setDefault", "(Ljava/util/Locale;)V", previous); }
});
