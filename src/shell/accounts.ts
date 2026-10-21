// AccountManagerService's accounts database: the records, which system_server's service reads and
// changes in place, persisted whole after each change.
import { persisted } from "./device-storage.ts";

export type StoredAccount = {
  name: string; type: string; owner: string; password: string | null;
  data: Record<string, string>; tokens: Record<string, string>; visibility: Record<string, number>;
  previousName?: string; id?: number;
};
export type AccountKey = Pick<StoredAccount, "name" | "type" | "id">;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** `value`'s entries, each passing `valid`, in a map without a prototype: a key may be "__proto__" */
function entries<T>(value: unknown, valid: (entry: unknown) => entry is T): Record<string, T> | null {
  return record(value) && Object.values(value).every(valid) ? Object.assign(Object.create(null), value) : null;
}
const isString = (value: unknown): value is string => typeof value === "string";
/** AccountManager's VISIBILITY_VISIBLE through VISIBILITY_USER_MANAGED_NOT_VISIBLE */
const isVisibility = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 4;
/** a saved account, or null for one no version wrote */
export function decodeAccount(value: unknown): StoredAccount | null {
  if (!record(value)) return null;
  const { name, type, owner, password, previousName } = value;
  const data = entries(value.data, isString), tokens = entries(value.tokens, isString), visibility = entries(value.visibility, isVisibility);
  if (!isString(name) || !name || !isString(type) || !type || !isString(owner) || !owner || !(password === null || isString(password)) || !data || !tokens || !visibility) return null;
  return { name, type, owner, password, data, tokens, visibility, ...isString(previousName) ? { previousName } : {} };
}
const saved = persisted<StoredAccount[]>("wd:accounts", (value) => Array.isArray(value) ? value.flatMap((s) => decodeAccount(s) ?? []) : null,
  (records) => records.map(({ id, ...s }) => s));

export class AccountStore {
  private loaded: StoredAccount[] | null = null;
  private nextId = 1;
  private listeners = new Set<() => void>();
  /** each account with the id this store knows it by, which a rename keeps */
  get records(): StoredAccount[] { return this.loaded ??= (saved.get("") ?? []).map((s) => ({ ...s, id: this.nextId++ })); }
  find(key: AccountKey): StoredAccount | undefined {
    return this.records.find((s) => s.type === key.type && (key.id === undefined ? s.name === key.name : s.id === key.id));
  }
  add(s: StoredAccount): void { this.records.push({ ...s, id: this.nextId++ }); }
  drop(s: StoredAccount): void { const i = this.records.indexOf(s); if (i >= 0) this.records.splice(i, 1); }
  persist(): void {
    saved.set("", this.records);
    for (const listener of this.listeners) listener();
  }
  /** AccountManagerService on a package's removal: the accounts its authenticator kept, and their
   *  visibility to it */
  remove(pkg: string): void {
    const kept = this.records.filter((s) => s.owner !== pkg);
    for (const s of kept) delete s.visibility[pkg];
    this.loaded = kept;
    this.persist();
  }
  /** the packages whose authenticators keep accounts */
  packages(): string[] { return this.records.map((s) => s.owner); }
  watch(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
