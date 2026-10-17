// The device's persistent key-value state lives in the page's localStorage, which a process Worker
// lacks. A Worker reads a replica of the entries its package may see, taken at bootstrap and kept
// current by the page, and the page keeps only the writes to entries the package owns.

export type StorageOwner = { pkg: string; uid: number };
/** An install's state and WebView cookies belong to their package and a keystore to its uid; any
 *  package reads the installs (component states, install times, persisted URI grants) and the uids,
 *  and writes the device's MediaStore flags, as its in-process MediaProvider does. */
export function storageAccess(key: string, { pkg, uid }: StorageOwner): "read" | "write" | null {
  if (key === `wd:install:${pkg}` || key.startsWith(`wd:install:${pkg}:`) || key === `wd:web-cookies:${pkg}` || key === `wd:keystore2:${uid}`
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
