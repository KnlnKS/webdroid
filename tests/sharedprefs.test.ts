import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { newStringSet, toJsArray } from "../src/jvm/natives/jutil";
import { getPrefs } from "../src/android/sharedprefs";

rt.linkNatives();

test("string preference getters throw on a stored value of the wrong type", async () => {
  const prefs = getPrefs("test.preferences", "strings");
  const editor = await vcall(prefs, "edit", "()Landroid/content/SharedPreferences$Editor;");
  await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "string", "one");
  await vcall(editor, "putStringSet", "(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;", "set", newStringSet(["one", "two"]));
  await vcall(editor, "commit", "()Z");
  for (const [method, type, key] of [["getString", "Ljava/lang/String;", "set"], ["getStringSet", "Ljava/util/Set;", "string"]]) {
    const error = await vcall(prefs, method, `(Ljava/lang/String;${type})${type}`, key, null).catch(error => error);
    expect(rt.iof(error, "java/lang/ClassCastException")).toBe(1);
  }
  expect(await vcall(prefs, "getString", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "string", null)).toBe("one");
  expect(await toJsArray(await vcall(prefs, "getStringSet", "(Ljava/lang/String;Ljava/util/Set;)Ljava/util/Set;", "set", null))).toEqual(["one", "two"]);
  expect(await vcall(prefs, "getString", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "missing", "default")).toBe("default");
  const fallback = newStringSet(["fallback"]);
  expect(await vcall(prefs, "getStringSet", "(Ljava/lang/String;Ljava/util/Set;)Ljava/util/Set;", "missing", fallback)).toBe(fallback);
});
