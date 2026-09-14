import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { JThread, curThread, mainThread, setCurThread, vcall } from "../src/jvm/natives/jlang";
import { newStringSet, toJsArray } from "../src/jvm/natives/jutil";
import { getPrefs, movePrefs } from "../src/android/sharedprefs";

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

test("preference files move between context packages and leave no source file", async () => {
  const source = getPrefs("test.preferences.source", "account");
  const editor = await vcall(source, "edit", "()Landroid/content/SharedPreferences$Editor;");
  await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "token", "value");
  expect(await vcall(editor, "commit", "()Z")).toBe(1);

  expect(movePrefs("test.preferences.source", "test.preferences.target", "account")).toBe(true);
  expect(await vcall(getPrefs("test.preferences.target", "account"), "getString", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "token", null)).toBe("value");
  expect(await vcall(getPrefs("test.preferences.source", "account"), "contains", "(Ljava/lang/String;)Z", "token")).toBe(0);
  expect(movePrefs("test.preferences.missing", "test.preferences.target", "missing")).toBe(true);
});

test("preference notifications retain the main thread after a suspending listener", async () => {
  const { mangleMethod } = await import("../src/jvm/abi");
  const { onMain } = await import("../src/android/mainloop");
  const prefs = getPrefs("test.preferences", "listener-thread"), worker = new JThread();
  const observed: boolean[] = [];
  const listener = {
    [mangleMethod("onSharedPreferenceChanged", "(Landroid/content/SharedPreferences;Ljava/lang/String;)V")]: async () => {
      observed.push(curThread === mainThread);
      await Promise.resolve();
      setCurThread(worker);
    },
  };
  await vcall(prefs, "registerOnSharedPreferenceChangeListener", "(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V", listener);
  const editor = await vcall(prefs, "edit", "()Landroid/content/SharedPreferences$Editor;");
  await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "first", "1");
  await vcall(editor, "putString", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;", "second", "2");
  try {
    await vcall(editor, "commit", "()Z");
    await onMain(() => {});
    expect(observed).toEqual([true, true]);
  } finally {
    setCurThread(mainThread);
    await vcall(prefs, "unregisterOnSharedPreferenceChangeListener", "(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V", listener);
  }
});
