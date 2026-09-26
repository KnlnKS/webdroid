import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall, vcallOn, JThread, curThread, vcallAsync } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";

rt.linkNatives();
const instance = async (language: string) => vcall(rt.link("android/icu/text/ListFormatter").ctor, "getInstance",
  "(Ljava/util/Locale;)Landroid/icu/text/ListFormatter;", await newObj("java/util/Locale", "(Ljava/lang/String;)V", language));
test("ICU list formatting handles empty, single and locale-sensitive conjunctions", async () => {
  const en = await instance("en");
  for (const [items, text] of [[[], ""], [["one"], "one"], [["one", "two"], "one and two"], [["one", "two", "three"], "one, two, and three"]] as const) {
    expect(await vcall(en, "format", "(Ljava/util/Collection;)Ljava/lang/String;", newArrayList([...items]))).toBe(text);
  }
  expect(await vcall(await instance("es"), "format", "([Ljava/lang/Object;)Ljava/lang/String;", ["España", "Italia"])).toBe("España e Italia");
  expect(await vcall(await instance("de"), "format", "([Ljava/lang/Object;)Ljava/lang/String;", ["A", "B", "C"])).toBe("A, B und C");
});
test("ICU list formatting invokes object strings on the caller thread and rejects nulls", async () => {
  const formatter = await instance("en"), thread = new JThread(), observed: JThread[] = [];
  const objects = ["first", "second"].map(text => ({
    [mangleMethod("toString", "()Ljava/lang/String;")]: async () => { observed.push(curThread); await Promise.resolve(); return text; },
  }));
  expect(await vcallOn(thread, formatter, "format", "([Ljava/lang/Object;)Ljava/lang/String;", objects)).toBe("first and second");
  expect(observed).toEqual([thread, thread]);
  for (const items of [null, [null]]) await expect(vcallAsync(formatter, "format", "([Ljava/lang/Object;)Ljava/lang/String;", items)).rejects.toBeInstanceOf(rt.link("java/lang/NullPointerException").ctor);
});
