import { JObj, rt, type NativeSpec } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { newStringSet, toJsArray } from "../jvm/natives/jutil";

export class JSharedPrefs extends JObj {
  name = "";
  map = new Map<string, unknown>();
  listeners: unknown[] = [];
  persist() {
    try {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of this.map) obj[k] = typeof v === "bigint" ? { $l: v.toString() } : v instanceof Set ? { $s: [...v] } : v;
      globalThis.localStorage?.setItem("wd:prefs:" + this.name, JSON.stringify(obj));
    } catch { /* quota */ }
  }
  load() {
    try {
      const raw = globalThis.localStorage?.getItem("wd:prefs:" + this.name);
      if (raw) {
        for (const [k, v] of Object.entries(JSON.parse(raw))) {
          if (v && typeof v === "object") {
            if ("$l" in v && typeof v.$l === "string") this.map.set(k, BigInt(v.$l));
            else if ("$s" in v && Array.isArray(v.$s) && v.$s.every((x: unknown) => typeof x === "string")) this.map.set(k, new Set(v.$s));
            else if (Array.isArray(v) && v.every((x: unknown) => typeof x === "string")) this.map.set(k, new Set(v));
            // Older snapshots serialized Java Set internals and lost their members.
            else console.warn("[prefs] invalid saved value", k);
          } else this.map.set(k, v);
        }
      }
    } catch { /* corrupt */ }
  }
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
class JPrefsEditor extends JObj {
  prefs!: JSharedPrefs;
  changes = new Map<string, unknown>();
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
      "commit()Z": function (this: JPrefsEditor) { commitEditor(this); return 1; },
      "putStringSet(Ljava/lang/String;Ljava/util/Set;)Landroid/content/SharedPreferences$Editor;": async function (this: JPrefsEditor, k: string, value: unknown) {
        const values: unknown[] = value == null ? [] : await toJsArray(value);
        if (!values.every((v): v is string => typeof v === "string")) throw rt.mkThrowable("java/lang/ClassCastException", "StringSet contains a non-string");
        this.changes.set(k, value == null ? undefined : new Set(values));
        return this;
      },
    };
    for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Boolean", "Z"]]) {
      m[`put${t}(Ljava/lang/String;${d})Landroid/content/SharedPreferences$Editor;`] = function (this: JPrefsEditor, k: string, v: unknown) {
        this.changes.set(k, v ?? undefined);
        return this;
      };
    }
    return m;
  })(),
});
async function commitEditor(e: JPrefsEditor) {
  if (e.cleared) e.prefs.map.clear();
  const changed: string[] = [];
  for (const [k, v] of e.changes) {
    if (v === undefined) e.prefs.map.delete(k);
    else e.prefs.map.set(k, v);
    changed.push(k);
  }
  e.changes.clear();
  e.cleared = false;
  e.prefs.persist();
  for (const l of e.prefs.listeners) {
    for (const k of changed) {
      try {
        await vcall(l, "onSharedPreferenceChanged", "(Landroid/content/SharedPreferences;Ljava/lang/String;)V", e.prefs, k);
      } catch (err) { console.error("[prefs listener]", err); }
    }
  }
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
        for (const [k, v] of this.map) map.m.set(k, { k, v: v instanceof Set ? newStringSet(v) : v });
        return map;
      },
      "registerOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V":
        function (this: JSharedPrefs, l: unknown) { this.listeners.push(l); },
      "unregisterOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V":
        function (this: JSharedPrefs, l: unknown) {
          const i = this.listeners.indexOf(l);
          if (i >= 0) this.listeners.splice(i, 1);
        },
    };
    for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Boolean", "Z"], ["StringSet", "Ljava/util/Set;"]] as const) {
      m[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JSharedPrefs, k: string, dv: unknown) {
        const v = this.map.get(k);
        if (v === undefined) return dv;
        if (t === "StringSet") return v instanceof Set ? newStringSet(v) : dv;
        if (t === "Boolean") return v ? 1 : 0;
        if (t === "Long" && typeof v !== "bigint") return BigInt(Math.trunc(v as number));
        return v;
      };
    }
    return m;
  })(),
});
rt.register({ name: "android/content/SharedPreferences", ctor: class extends JObj {} });
rt.register({ name: "android/content/SharedPreferences$Editor", ctor: class extends JObj {} });
rt.register({ name: "android/content/SharedPreferences$OnSharedPreferenceChangeListener", ctor: class extends JObj {} });
