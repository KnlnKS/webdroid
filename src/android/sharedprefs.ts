// The preference store behind AOSP's SharedPreferencesImpl files and the platform's own settings.

import { vfs } from "../shell/vfs";

type PreferenceValue =string | number | bigint | boolean | null | readonly string[];
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
  /** the files named `prefix`..., held or persisted */
  names(prefix: string): string[] {
    const names = new Set([...this.files.keys()].filter((name) => name.startsWith(prefix)));
    const storage = globalThis.localStorage;
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i)!;
      if (key.startsWith("wd:prefs:" + prefix)) names.add(key.slice("wd:prefs:".length));
    }
    return [...names];
  }
  remove(name: string): void {
    this.files.delete(name);
    try { globalThis.localStorage?.removeItem("wd:prefs:" + name); } catch { /* storage can be unavailable */ }
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
}
export let preferenceStore = new PreferenceStore();
export function usePreferenceStore(store: PreferenceStore): void {
  preferenceStore = store;
  for (const prefs of prefsCache.values()) prefs.load();
}
const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot" } as Record<string, string>)[c]};`);
/** AOSP's SharedPreferencesImpl reads shared_prefs XML: a package's preferences this store holds
 *  (an earlier run, a harness seed) become the files it has not written yet, in
 *  XmlUtils.writeMapXml's form. A whole number becomes an int: the store does not keep the type. */
export function writePrefsFiles(pkg: string): void {
  const prefix = `wd:prefs:${pkg}:`, storage = globalThis.localStorage;
  for (let i = 0; storage && i < storage.length; i++) {
    const key = storage.key(i)!;
    const path = `/data/data/${pkg}/shared_prefs/${key.slice(prefix.length)}.xml`;
    if (!key.startsWith(prefix) || vfs.stat(path)) continue;
    const entries = [...new PreferenceStore().open(key.slice("wd:prefs:".length))].map(([k, v]) => {
      const name = escapeXml(k);
      if (v === null) return `<null name="${name}" />`;
      if (typeof v === "string") return `<string name="${name}">${escapeXml(v)}</string>`;
      if (typeof v === "boolean") return `<boolean name="${name}" value="${v}" />`;
      if (typeof v === "bigint") return `<long name="${name}" value="${v}" />`;
      if (typeof v === "number") return `<${Number.isInteger(v) ? "int" : "float"} name="${name}" value="${v}" />`;
      return `<set name="${name}">${v.map((x) => `<string>${escapeXml(x)}</string>`).join("")}</set>`;
    });
    vfs.write(path, new TextEncoder().encode(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${entries.join("\n")}\n</map>\n`));
  }
}
/** a preference file the platform keeps for itself, outside the app's shared_prefs */
class Prefs {
  map!: Map<string, PreferenceValue>;
  constructor(readonly name: string) { this.load(); }
  persist(): boolean { return preferenceStore.persist(this.name, this.map); }
  load(): void { this.map = preferenceStore.open(this.name); }
}
const prefsCache = new Map<string, Prefs>();
export function getPrefs(pkg: string, name: string): Prefs {
  const key = pkg + ":" + name;
  let p = prefsCache.get(key);
  if (!p) prefsCache.set(key, p = new Prefs(key));
  return p;
}
