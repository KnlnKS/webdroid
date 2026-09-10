import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { newStringSet, toJsArray } from "../jvm/natives/jutil";
import { JSharedPrefs, preferenceStore, PreferenceStore, usePreferenceStore } from "./sharedprefs";

test("string-set preferences snapshot Java sets and survive storage reload", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), previousStore = preferenceStore;
  usePreferenceStore(new PreferenceStore());
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  } });
  try {
    rt.link("webdroid/SharedPrefs"); rt.link("webdroid/PrefsEditor");
    const prefs = new JSharedPrefs(); prefs.name = "test.sets";
    const editor = await vcall(prefs, "edit", "()Landroid/content/SharedPreferences$Editor;");
    const input = newStringSet(["en", "ja"]);
    await vcall(editor, "putStringSet", "(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;", "languages", input);
    await vcall(input, "add", "(Ljava/lang/Object;)Z", "fr");
    await vcall(editor, "commit", "()Z");
    usePreferenceStore(new PreferenceStore());
    const restored = new JSharedPrefs(); restored.name = prefs.name; restored.load();
    const set = await vcall(restored, "getStringSet", "(Ljava/lang/String;Ljava/util/Set;)Ljava/util/Set;", "languages", null);
    expect(await toJsArray(set)).toEqual(["en", "ja"]);
    expect(await vcall(rt.classFor("java/util/Set"), "isInstance", "(Ljava/lang/Object;)Z", set)).toBe(1);
    const all = await vcall(restored, "getAll", "()Ljava/util/Map;");
    expect(await toJsArray(await vcall(all, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "languages"))).toEqual(["en", "ja"]);
    await vcall(editor, "putStringSet", "(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;", "languages", null);
    await vcall(editor, "commit", "()Z");
    restored.map.clear(); restored.load();
    expect(await vcall(restored, "contains", "(Ljava/lang/String;)Z", "languages")).toBe(0);
  } finally {
    usePreferenceStore(previousStore);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});


test("preference handles share one store and interleaved commits preserve other writers", async () => {
  const previous = preferenceStore, store = new PreferenceStore();
  usePreferenceStore(store);
  try {
    const first = new JSharedPrefs(), second = new JSharedPrefs();
    first.name = second.name = "test.shared:" + Date.now(); first.load(); second.load();
    expect(first.map).toBe(second.map);
    const edit = async (prefs: JSharedPrefs, key: string, value: number) => {
      const editor = await vcall(prefs, "edit", "()Landroid/content/SharedPreferences$Editor;");
      await vcall(editor, "putInt", "(Ljava/lang/String;I)Landroid/content/SharedPreferences$Editor;", key, value);
      await vcall(editor, "commit", "()Z");
    };
    await edit(first, "first", 17); await edit(second, "second", 29);
    expect(await vcall(first, "getInt", "(Ljava/lang/String;I)I", "second", 0)).toBe(29);
    expect(await vcall(second, "getInt", "(Ljava/lang/String;I)I", "first", 0)).toBe(17);
    expect([...store.open(first.name)]).toEqual([["first", 17], ["second", 29]]);
    expect(store.open("other:" + first.name).size).toBe(0);
  } finally { usePreferenceStore(previous); }
});
