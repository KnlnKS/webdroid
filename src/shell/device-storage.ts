// The device's persistent key-value state lives in the page's localStorage, which a process Worker
// lacks. A Worker reads a replica of the entries its package may see, taken at bootstrap and kept
// current by the page, and the page keeps only the writes to entries the package owns.

export type StorageOwner = { pkg: string; uid: number };
/** An install's state, WebView cookies and per-app configuration belong to their package and a
 *  keystore to its uid; any package reads the installs (component states, install times, persisted
 *  URI grants, the doze allowlist) and the uids, and writes the device's MediaStore flags, as its
 *  in-process MediaProvider does. */
export function storageAccess(key: string, { pkg, uid }: StorageOwner): "read" | "write" | null {
  if (key === `wd:install:${pkg}` || key.startsWith(`wd:install:${pkg}:`) || key === `wd:web-cookies:${pkg}` || key === `wd:keystore2:${uid}`
    || key === `wd:package-config:${pkg}`
    || key.startsWith(`wd:keystore2:${uid}:`)
    || key === "wd:media:flags") return "write";
  return key.startsWith("wd:install:") || key === "wd:package-uids" ? "read" : null;
}

/** the page's entries `owner` may read */
export function storageEntries(owner: StorageOwner): [string, string][] {
  const out: [string, string][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (storageAccess(key, owner)) out.push([key, localStorage.getItem(key)!]);
    }
  } catch { /* storage can be unavailable */ }
  return out;
}
/** `owner`'s write on the page, when the entry is its own */
export function storageWrite(owner: StorageOwner, key: string, value: string | null): boolean {
  if (storageAccess(key, owner) !== "write") return false;
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* quota: the replica keeps it */ }
  return true;
}

let replica: Replica | undefined;
class Replica {
  readonly write: (key: string, value: string | null) => void;
  #entries: Map<string, string>;
  constructor(entries: [string, string][], write: (key: string, value: string | null) => void) { this.write = write; this.#entries = new Map(entries); }
  get length() { return this.#entries.size; }
  key(index: number) { return [...this.#entries.keys()][index] ?? null; }
  getItem(key: string) { return this.#entries.get(key) ?? null; }
  setItem(key: string, value: string) { value = String(value); this.#entries.set(key, value); this.write(key, value); }
  removeItem(key: string) { if (this.#entries.delete(key)) this.write(key, null); }
  changed(key: string, value: string | null) { if (value === null) this.#entries.delete(key); else this.#entries.set(key, value); }
}
/** a Worker's localStorage: the replica, writing through to the page */
export function useStorageReplica(entries: [string, string][], write: (key: string, value: string | null) => void): void {
  replica = new Replica(entries, write);
  Object.defineProperty(globalThis, "localStorage", { value: replica, configurable: true });
}
/** another process changed an entry this one reads */
export const storageChanged = (key: string, value: string | null): void => replica?.changed(key, value);

// localStorage throws outright in some privacy modes and on quota: a read that fails finds the
// storage unavailable (undefined), and a write that fails answers false
/** the stored keys that begin with `start` */
export function storedKeys(start: string): string[] {
  const keys: string[] = [];
  try {
    const storage = globalThis.localStorage;
    for (let i = 0; storage && i < storage.length; i++) { const key = storage.key(i)!; if (key.startsWith(start)) keys.push(key); }
  } catch { /* unavailable */ }
  return keys;
}
/** the packages named by the stored keys `prefix` + pkg (+ ":" + more) */
export const storedPackages = (prefix: string): string[] =>
  [...new Set(storedKeys(prefix).map((key) => key.slice(prefix.length).split(":", 1)[0]).filter((pkg) => pkg))];
export function storedText(key: string): string | null | undefined {
  try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : undefined; } catch { return undefined; }
}
/** stores `text`, or with null removes the entry */
export function storeText(key: string, text: string | null): boolean {
  try {
    if (text === null) globalThis.localStorage?.removeItem(key); else globalThis.localStorage?.setItem(key, text);
    return true;
  } catch { return false; }
}
/** the entries `prefix` + key, each the JSON of what `encode` makes of a value and `decode` reads back
 *  (null when absent or malformed). `get` answers the value it last read or wrote while the entry
 *  is unchanged, so its callers share that value and leave it as it is. */
export function persisted<T>(prefix: string, decode: (saved: unknown) => T | null, encode: (value: T) => unknown = (value) => value) {
  let lastKey: string | null = null, lastText: string | null = null, last: T | null = null;
  return {
    get(key: string): T | null | undefined {
      const text = storedText(prefix + key);
      if (text == null) return text;
      if (key !== lastKey || text !== lastText) {
        let value: T | null = null;
        try { value = decode(JSON.parse(text)); } catch { /* malformed */ }
        lastKey = key; lastText = text; last = value;
      }
      return last;
    },
    set(key: string, value: T): boolean {
      const text = JSON.stringify(encode(value));
      lastKey = key; lastText = text; last = value;
      return storeText(prefix + key, text);
    },
    remove: (key: string): boolean => storeText(prefix + key, null),
    /** the stored keys that begin with `start`, without the prefix */
    keys: (start = ""): string[] => storedKeys(prefix + start).map((key) => key.slice(prefix.length)),
    packages: (): string[] => storedPackages(prefix),
  };
}
