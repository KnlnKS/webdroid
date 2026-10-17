// The preference store behind AOSP's SharedPreferencesImpl files and the platform's own settings.

import { vfs } from "../shell/vfs.ts";
import { after } from "../jvm/natives/jentry.ts";
import { storedPackages } from "./packages.ts";

/** the platform's preference files of a package that a data clear keeps: DeviceIdleController's
 *  allowlist (ActivityTaskManager's per-app night mode and locales go, onPackageDataCleared) */
const KEPT_ON_CLEAR = new Set(["__system_power"]);

export type PreferenceValue = string | number | bigint | boolean | null | readonly string[];
export class PreferenceStore {
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
  /** a package's files, held or persisted */
  named(pkg: string): string[] {
    const prefix = pkg + ":", names = new Set([...this.files.keys()].filter((name) => name.startsWith(prefix)));
    const storage = globalThis.localStorage;
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i)!;
      if (key.startsWith("wd:prefs:" + prefix)) names.add(key.slice("wd:prefs:".length));
    }
    return [...names];
  }
  /** the packages with files persisted */
  packages(): string[] { return storedPackages("wd:prefs:"); }
  /** a package's data clear takes its files but the platform's that a clear keeps */
  clear(pkg: string): void {
    for (const name of this.named(pkg)) if (!KEPT_ON_CLEAR.has(name.slice(pkg.length + 1))) this.delete(name);
  }
  remove(pkg: string): void { for (const name of this.named(pkg)) this.delete(name); }
  delete(name: string): void {
    this.files.delete(name);
    try { globalThis.localStorage?.removeItem("wd:prefs:" + name); } catch { /* storage can be unavailable */ }
  }
  persist(name: string, values: Map<string, PreferenceValue>): boolean {
    this.files.set(name, values);
    try {
      const saved: Record<string, unknown> = Object.create(null);
      for (const [key, value] of values) saved[key] = typeof value === "bigint" ? { $l: value.toString() } : value;
      globalThis.localStorage?.setItem("wd:prefs:" + name, JSON.stringify(saved));
      return true;
    } catch { return false; }
  }
}
export type PreferenceChange = { kind: "put"; key: string; value: PreferenceValue } | { kind: "remove"; key: string };
export interface PreferenceAccess {
  preferenceRead(name: string, key: string): PreferenceValue | undefined | Promise<PreferenceValue | undefined>;
  preferenceKeys(name: string): string[] | Promise<string[]>;
  preferenceChange(name: string, changes: PreferenceChange[]): boolean | Promise<boolean>;
  preferenceFiles(pkg: string): [string, [string, PreferenceValue][]][] | Promise<[string, [string, PreferenceValue][]][]>;
}
export type PreferenceCalls = {
  [K in keyof PreferenceAccess]: (...args: Parameters<PreferenceAccess[K]>) => Promise<Awaited<ReturnType<PreferenceAccess[K]>>>;
};
const copyValue = (value: PreferenceValue | undefined) => Array.isArray(value) ? [...value] : value;
export function canonicalPreferenceCommands(store: PreferenceStore, authorize: (name: string, write: boolean) => void): PreferenceAccess {
  return {
    preferenceRead: (name, key) => { authorize(name, false); return copyValue(store.open(name).get(key)); },
    preferenceKeys: name => { authorize(name, false); return [...store.open(name).keys()]; },
    preferenceChange: (name, changes) => {
      authorize(name, true);
      const values = store.open(name);
      for (const change of changes) {
        if (change.kind === "remove") values.delete(change.key);
        else values.set(change.key, copyValue(change.value)!);
      }
      return store.persist(name, values);
    },
    preferenceFiles: pkg => store.named(pkg).map(name => {
      authorize(name, false);
      return [name.slice(pkg.length + 1), [...store.open(name)].map(([key, value]) => [key, copyValue(value)!])];
    }),
  };
}
export let preferenceStore = new PreferenceStore();
let preferenceAccess = canonicalPreferenceCommands(preferenceStore, () => {});
export function usePreferenceStore(store: PreferenceStore): void {
  preferenceStore = store;
  preferenceAccess = canonicalPreferenceCommands(store, () => {});
}
export function usePreferenceAccess(access: PreferenceCalls): void { preferenceAccess = access; }
const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot" } as Record<string, string>)[c]};`);
/** AOSP's SharedPreferencesImpl reads shared_prefs XML: a package's preferences this store holds
 *  (an earlier run, a harness seed) become the files it has not written yet, in
 *  XmlUtils.writeMapXml's form. A whole number becomes an int: the store does not keep the type. */
function writePrefsFiles(pkg: string): void | Promise<void> {
  return after(preferenceAccess.preferenceFiles(pkg), files => {
    for (const [file, values] of files) {
      const path = `/data/data/${pkg}/shared_prefs/${file}.xml`;
      if (vfs.stat(path)) continue;
      const entries = values.map(([k, v]) => {
        const name = escapeXml(k);
        if (v === null) return `<null name="${name}" />`;
        if (typeof v === "string") return `<string name="${name}">${escapeXml(v)}</string>`;
        if (typeof v === "boolean") return `<boolean name="${name}" value="${v}" />`;
        if (typeof v === "bigint") return `<long name="${name}" value="${v}" />`;
        if (typeof v === "number") return `<${Number.isInteger(v) ? "int" : "float"} name="${name}" value="${v}" />`;
        return `<set name="${name}">${v.map(x => `<string>${escapeXml(x)}</string>`).join("")}</set>`;
      });
      vfs.write(path, new TextEncoder().encode(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${entries.join("\n")}\n</map>\n`));
    }
  });
}
/** installd's createAppData: the data directory and its cache directories, which apps stat before
 *  ContextImpl ever creates them, holding the preference files the store keeps for the package */
export function createAppData(pkg: string): void | Promise<void> {
  for (const root of ["/data/data/", "/data/user_de/0/"]) for (const dir of ["", "/cache", "/code_cache"]) vfs.mkdir(`${root}${pkg}${dir}`);
  return writePrefsFiles(pkg);
}
/** a preference file the platform keeps for itself, outside the app's shared_prefs */
export class Prefs {
  readonly name: string;
  constructor(name: string) { this.name = name; }
  get(key: string): ReturnType<PreferenceAccess["preferenceRead"]> { return preferenceAccess.preferenceRead(this.name, key); }
  keys(): ReturnType<PreferenceAccess["preferenceKeys"]> { return preferenceAccess.preferenceKeys(this.name); }
  set(key: string, value: PreferenceValue): boolean | Promise<boolean> {
    return preferenceAccess.preferenceChange(this.name, [{ kind: "put", key, value }]);
  }
  remove(key: string): boolean | Promise<boolean> { return preferenceAccess.preferenceChange(this.name, [{ kind: "remove", key }]); }
}
export const getPrefs = (pkg: string, name: string): Prefs => new Prefs(pkg + ":" + name);
