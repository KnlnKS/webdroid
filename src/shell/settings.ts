// The settings tables SettingsProvider keeps (SettingsState per table): the reference device's values
// (device-settings.ts) under what has been written since, which persists with the device rather than
// with an app's install. One store serves every process through the broker; system_server watches
// it and notifies every process's content observers of a write.
import { DEVICE_SETTINGS } from "../android/device-settings.ts";

export type SettingsTable = "system" | "secure" | "global" | "config";
export type SettingsAccess = {
  get(table: SettingsTable, name: string): string | null | Promise<string | null>;
  entries(table: SettingsTable): [string, string][] | Promise<[string, string][]>;
  put(table: SettingsTable, name: string, value: string | null): boolean | Promise<boolean>;
  ssaidKey(): string | Promise<string>;
};
type Written = Partial<Record<SettingsTable, Record<string, string | null>>>;
const KEY = "wd:settings";

export class SettingsStore {
  private written: Written | null = null;
  private listeners = new Set<(table: SettingsTable, name: string) => void>();
  private load(): Written {
    if (this.written) return this.written;
    this.written = {};
    try {
      const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}");
      if (saved && typeof saved === "object") for (const [table, values] of Object.entries(saved)) {
        if (!(table in DEVICE_SETTINGS) || !values || typeof values !== "object") continue;
        const kept: Record<string, string | null> = Object.create(null);
        for (const [name, value] of Object.entries(values)) if (value === null || typeof value === "string") kept[name] = value;
        this.written[table as SettingsTable] = kept;
      }
    } catch { /* unreadable writes leave the device's values */ }
    return this.written;
  }
  get(table: SettingsTable, name: string): string | null {
    const written = this.load()[table];
    if (written && name in written) return written[name];
    return Object.hasOwn(DEVICE_SETTINGS[table], name) ? DEVICE_SETTINGS[table][name] : null;
  }
  /** the table's non-null settings, in the order SettingsState lists them (by insertion) */
  entries(table: SettingsTable): [string, string][] {
    const values = new Map(Object.entries(DEVICE_SETTINGS[table]) as [string, string | null][]);
    for (const [name, value] of Object.entries(this.load()[table] ?? {})) values.set(name, value);
    return [...values].filter((entry): entry is [string, string] => entry[1] !== null);
  }
  /** a write; null deletes. Whether the value changed, which is when watchers hear of it. */
  put(table: SettingsTable, name: string, value: string | null): boolean {
    if (this.get(table, name) === value) return false;
    const written = this.load();
    (written[table] ??= Object.create(null) as Record<string, string | null>)[name] = value;
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(written)); } catch { /* private mode keeps the write in memory */ }
    this.changed(table, name);
    return true;
  }
  /** a setting whose value another owner derives changed (the location switch) */
  changed(table: SettingsTable, name: string): void {
    for (const listener of this.listeners) listener(table, name);
  }
  private userKey: string | null = null;
  /** the user's SSAID key (the ssaid table's userkey): 32 random bytes, minted on first use */
  ssaidKey(): string {
    try { this.userKey ??= globalThis.localStorage?.getItem(KEY + ":ssaid") ?? null; } catch { /* storage unavailable */ }
    if (!this.userKey) {
      this.userKey = crypto.getRandomValues(new Uint8Array(32)).toHex().toUpperCase();
      try { globalThis.localStorage?.setItem(KEY + ":ssaid", this.userKey); } catch { /* private mode keeps it for the session */ }
    }
    return this.userKey;
  }
  watch(listener: (table: SettingsTable, name: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
