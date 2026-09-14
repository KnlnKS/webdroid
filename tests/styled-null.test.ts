import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JTheme, Resources, T_STR } from "../src/android/res";
import { TV } from "../src/android/axml";

rt.linkNatives();
test("explicit style arrays mask null font values before reporting present attributes", async () => {
  const res = new Resources(null, {}), theme = new JTheme();
  theme.res = res; theme.styles = [100];
  res.bagCache.set(100, { parent: 0, map: new Map([
    [1, { t: T_STR, d: 0, s: "fallback" }],
    [4, { t: TV.REFERENCE, d: 0 }],
  ]) });
  res.bagCache.set(101, { parent: 0, map: new Map([
    [1, { t: TV.REFERENCE, d: 0 }],
    [2, { t: T_STR, d: 0, s: "custom-family" }],
    [3, { t: TV.ATTRIBUTE, d: 4 }],
  ]) });
  const context = Object.assign(rt.make("android/content/Context"), { $host: { res, theme } });
  for (const receiver of [theme, context]) {
    const values = await vcall(receiver, "obtainStyledAttributes", "(I[I)Landroid/content/res/TypedArray;", 101, new Int32Array([1, 2, 3]));
    expect(await vcall(values, "hasValue", "(I)Z", 0)).toBe(0);
    expect(await vcall(values, "hasValue", "(I)Z", 2)).toBe(0);
    expect(await vcall(values, "getIndexCount", "()I")).toBe(1);
    expect(await vcall(values, "getIndex", "(I)I", 0)).toBe(1);
    expect(await vcall(values, "getString", "(I)Ljava/lang/String;", 1)).toBe("custom-family");
    expect(await vcall(values, "peekValue", "(I)Landroid/util/TypedValue;", 0)).toBeNull();
  }
});
