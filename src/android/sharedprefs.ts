import { JObj, rt, type NativeSpec } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { newStringSet, toJsArray } from "../jvm/natives/jutil";
import { removeFrom } from "./view";
import { onMain } from "./mainloop";

type PreferenceValue = string | number | bigint | boolean | null | readonly string[];
class PreferenceStore {
  private files = new Map<string, Map<string, PreferenceValue>>();
  open(name: string): Map<string, PreferenceValue> {
    let values = this.files.get(name);
    if (values) return values;
    values = new Map(); this.files.set(name, values);
    try {
      const saved: unknown = JSON.parse(globalThis.localStorage?.getItem("wd:prefs:" + name) ?? "{}");
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return values;
      for (const [key, value] of Object.entries(saved)) {
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") values.set(key, value);
        else if (value && typeof value === "object") {
          if ("$l" in value && typeof value.$l === "string") values.set(key, BigInt(value.$l));
          else {
            const strings = "$s" in value ? value.$s : value;
            if (Array.isArray(strings) && strings.every((v): v is string => typeof v === "string")) values.set(key, strings);
          }
        }
      }
    } catch { /* corrupt */ }
    return values;
  }
  persist(name: string, values: Map<string, PreferenceValue>): boolean {
    this.files.set(name, values);
    try {
      const saved: Record<string, unknown> = {};
      for (const [key, value] of values) saved[key] = typeof value === "bigint" ? { $l: value.toString() } : value;
      globalThis.localStorage?.setItem("wd:prefs:" + name, JSON.stringify(saved));
      return true;
    } catch { return false; }
  }
  move(source: string, target: string): boolean {
    if (source === target) return true;
    const persisted = globalThis.localStorage?.getItem("wd:prefs:" + source);
    if (!this.files.has(source) && persisted == null) return true;
    const values = new Map(this.open(source));
    if (!this.persist(target, values)) return false;
    try { globalThis.localStorage?.removeItem("wd:prefs:" + source); }
    catch { return false; }
    this.files.delete(source);
    return true;
  }
}
export let preferenceStore = new PreferenceStore();
export function usePreferenceStore(store: PreferenceStore): void {
  preferenceStore = store;
  for (const prefs of prefsCache.values()) prefs.load();
}
class JSharedPrefs extends JObj {
  name = "";
  map = new Map<string, PreferenceValue>();
  listeners: unknown[] = [];
  persist(): boolean { return preferenceStore.persist(this.name, this.map); }
  load(): void { this.map = preferenceStore.open(this.name); }
}
const prefsCache = new Map<string, JSharedPrefs>();
export function getPrefs(pkg: string, name: string): JSharedPrefs {
  const key = pkg + ":" + name;
  let p = prefsCache.get(key);
  if (!p) {
    p = new JSharedPrefs();
    p.name = key;
    p.load();
    prefsCache.set(key, p);
  }
  return p;
}
export function movePrefs(sourcePkg: string, targetPkg: string, name: string): boolean {
  const source = sourcePkg + ":" + name;
  const target = targetPkg + ":" + name;
  const moved = preferenceStore.move(source, target);
  if (moved && source !== target) {
    prefsCache.delete(source);
    prefsCache.delete(target);
  }
  return moved;
}
class JPrefsEditor extends JObj {
  prefs!: JSharedPrefs;
  changes = new Map<string, PreferenceValue | undefined>();
  cleared = false;
}
rt.register({
  name: "webdroid/PrefsEditor", ctor: JPrefsEditor, ifaces: ["android/content/SharedPreferences$Editor"],
  methods: (() => {
    const m: NativeSpec["methods"] = {
      "remove(Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;": function (this: JPrefsEditor, k: string) {
        this.changes.set(k, undefined);
        return this;
      },
      "clear()Landroid/content/SharedPreferences$Editor;": function (this: JPrefsEditor) { this.cleared = true; return this; },
      "apply()V": function (this: JPrefsEditor) { commitEditor(this); },
      "commit()Z": function (this: JPrefsEditor) { return commitEditor(this) ? 1 : 0; },
      "putStringSet(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;": async function (this: JPrefsEditor, k: string, value: unknown) {
        const values: unknown[] = value == null ? [] : await toJsArray(value);
        if (!values.every((v): v is string => typeof v === "string")) throw rt.mkThrowable("java/lang/ClassCastException", "StringSet contains a non-string");
        this.changes.set(k, value == null ? undefined : values);
        return this;
      },
    };
    for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Boolean", "Z"]]) {
      m[`put${t}(Ljava/lang/String;${d})Landroid/content/SharedPreferences$Editor;`] = function (this: JPrefsEditor, k: string, v: string | number | bigint | null) {
        this.changes.set(k, v ?? undefined);
        return this;
      };
    }
    return m;
  })(),
});
function commitEditor(e: JPrefsEditor): boolean {
  if (e.cleared) e.prefs.map.clear();
  const changed: string[] = [];
  for (const [k, v] of e.changes) {
    if (v === undefined) e.prefs.map.delete(k);
    else e.prefs.map.set(k, v);
    changed.push(k);
  }
  e.changes.clear();
  e.cleared = false;
  const persisted = e.prefs.persist();
  if (e.prefs.listeners.length) void onMain(async () => {
    for (const l of e.prefs.listeners) {
      for (const k of changed) {
        try {
          await vcall(l, "onSharedPreferenceChanged", "(Landroid/content/SharedPreferences;Ljava/lang/String;)V", e.prefs, k);
        } catch (err) { console.error("[prefs listener]", err); }
      }
    }
  });
  return persisted;
}
rt.register({
  name: "webdroid/SharedPrefs", ctor: JSharedPrefs, ifaces: ["android/content/SharedPreferences"],
  methods: (() => {
    const m: NativeSpec["methods"] = {
      "edit()Landroid/content/SharedPreferences$Editor;": function (this: JSharedPrefs) {
        const e = new JPrefsEditor();
        e.prefs = this;
        return e;
      },
      "contains(Ljava/lang/String;)Z": function (this: JSharedPrefs, k: string) { return this.map.has(k) ? 1 : 0; },
      "getAll()Ljava/util/Map;": function (this: JSharedPrefs) {
        const info = rt.link("java/util/HashMap");
        const map = new info.ctor();
        for (const [k, v] of this.map) map.m.set(k, { k, v: Array.isArray(v) ? newStringSet(v) : v });
        return map;
      },
      "registerOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V":
        function (this: JSharedPrefs, l: unknown) { this.listeners.push(l); },
      "unregisterOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V":
        function (this: JSharedPrefs, l: unknown) {
          removeFrom(this.listeners, l);
        },
    };
    for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Boolean", "Z"], ["StringSet", "Ljava/util/Set;"]] as const) {
      m[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JSharedPrefs, k: string, dv: unknown) {
        const v = this.map.get(k);
        if (v == null) return dv;
        if (t === "StringSet") {
          if (!Array.isArray(v)) throw rt.mkThrowable("java/lang/ClassCastException", "Preference is not a string set");
          return newStringSet(v);
        }
        if (t === "String" && typeof v !== "string") throw rt.mkThrowable("java/lang/ClassCastException", "Preference is not a string");
        if (t === "Boolean") return v ? 1 : 0;
        if (t === "Long" && typeof v !== "bigint") return BigInt(Math.trunc(v as number));
        return v;
      };
    }
    return m;
  })(),
});
rt.markers("android/content/SharedPreferences", "android/content/SharedPreferences$Editor",
  "android/content/SharedPreferences$OnSharedPreferenceChangeListener");
