export type StoredAccount = {
  name: string; type: string; owner: string; password: string | null;
  data: Record<string, string>; tokens: Record<string, string>; visibility: Record<string, number>;
  previousName?: string; id?: number;
};
export type AccountKey = Pick<StoredAccount, "name" | "type" | "id">;
export type AccountSummary = Pick<StoredAccount, "name" | "type" | "owner" | "visibility" | "id">;
export type AccountChange =
  | { kind: "add"; account: StoredAccount }
  | { kind: "drop"; key: AccountKey }
  | { kind: "password"; key: AccountKey; value: string | null }
  | { kind: "entry"; key: AccountKey; field: "data" | "tokens"; name: string; value: string | null }
  | { kind: "visibility"; key: AccountKey; pkg: string; value: number }
  | { kind: "rename"; key: AccountKey; name: string }
  | { kind: "invalidate"; type: string; token: string | null }
  | { kind: "cache"; key: AccountKey; authenticatorType: string; tokenType: string; token: string };
export type AccountQuery = { type: string | null; pkg: string; managed?: boolean };
export type CachedAccount = { account: AccountSummary; token?: string };
export interface AccountAccess {
  accountList(query: AccountQuery): AccountSummary[];
  accountRead(key: AccountKey): StoredAccount | null;
  accountExists(key: AccountKey): boolean;
  accountCached(key: AccountKey, tokenType: string): CachedAccount | null;
  accountChange(change: AccountChange): number;
}
export type AccountAuthority = { caller: string; authenticator(type: string): string | undefined; sameUid(a: string, b: string): boolean; known(pkg: string): boolean; denied(type: string): never };
const summary = (s: StoredAccount): AccountSummary => ({ name: s.name, type: s.type, owner: s.owner, id: s.id, visibility: { ...s.visibility } });
const copy = (s: StoredAccount): StoredAccount => ({ ...s, data: Object.assign(Object.create(null), s.data), tokens: Object.assign(Object.create(null), s.tokens), visibility: Object.assign(Object.create(null), s.visibility) });
export function canonicalAccountCommands(store: AccountStore, authority: () => AccountAuthority): AccountAccess {
  const find = (key: AccountKey) => store.records.find(s => s.type === key.type && (key.id === undefined ? s.name === key.name : s.id === key.id));
  const managed = (type: string, a: AccountAuthority) => {
    const owner = a.authenticator(type);
    return !!owner && a.sameUid(owner, a.caller);
  };
  const owned = (key: AccountKey, a: AccountAuthority) => {
    if (!managed(key.type, a)) a.denied(key.type);
    return find(key);
  };
  const visible = (s: StoredAccount, pkg: string, a: AccountAuthority) => a.sameUid(s.owner, pkg) || s.visibility[pkg] === 1 || s.visibility[pkg] === 2;
  return {
    accountList: q => {
      const a = authority();
      return store.records.filter(s => (q.type === null || s.type === q.type) &&
        (q.managed ? managed(s.type, a) : visible(s, q.pkg, a))).map(summary);
    },
    accountRead: key => { const s = owned(key, authority()); return s ? copy(s) : null; },
    accountExists: key => { authority(); return !!find(key); },
    accountCached: (key, tokenType) => {
      const a = authority(), s = find(key);
      return s && visible(s, a.caller, a) ? { account: summary(s), token: s.tokens[tokenType] } : null;
    },
    accountChange: change => {
      const a = authority();
      if (change.kind === "invalidate") {
        for (const s of store.records) if (s.type === change.type)
          for (const key of Object.keys(s.tokens)) if (s.tokens[key] === change.token) delete s.tokens[key];
      } else if (change.kind === "add") {
        const s = change.account;
        if (!managed(s.type, a) || s.owner !== a.authenticator(s.type)) a.denied(s.type);
        if (find(s)) return 0;
        store.add(copy(s));
      } else if (change.kind === "cache") {
        const s = find(change.key), owner = a.authenticator(change.authenticatorType);
        if (!owner || owner !== a.authenticator(change.key.type)) a.denied(change.key.type);
        if (!s || !visible(s, a.caller, a)) return 0;
        s.tokens[change.tokenType] = change.token;
      } else {
        const s = owned(change.key, a);
        if (!s) return 0;
        switch (change.kind) {
          case "drop": store.records.splice(store.records.indexOf(s), 1); break;
          case "password": s.password = change.value; s.tokens = Object.create(null); break;
          case "entry": if (change.value === null) delete s[change.field][change.name]; else s[change.field][change.name] = change.value; break;
          case "visibility":
            if (!a.known(change.pkg) || !Number.isInteger(change.value) || change.value < 0 || change.value > 4) return 0;
            if (change.value) s.visibility[change.pkg] = change.value; else delete s.visibility[change.pkg];
            break;
          case "rename": s.previousName = s.name; s.name = change.name; break;
        }
      }
      store.persist(); return 1;
    },
  };
}
const strings = (value: unknown): value is Record<string, string> => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string");
export class AccountStore {
  private loaded: StoredAccount[] | null = null;
  private nextId = 1;
  add(s: StoredAccount): void { this.records.push({ ...s, id: this.nextId++ }); }
  private listeners = new Set<() => void>();
  get records(): StoredAccount[] {
    if (this.loaded) return this.loaded;
    this.loaded = [];
    try {
      const saved: unknown = JSON.parse(globalThis.localStorage?.getItem("wd:accounts") ?? "[]");
      if (Array.isArray(saved)) for (const value of saved) {
        if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.type !== "string" || typeof value.owner !== "string" || !value.name || !value.type || !value.owner ||
          !(value.password === null || typeof value.password === "string") || !strings(value.data) || !strings(value.tokens) ||
          !value.visibility || typeof value.visibility !== "object" || Array.isArray(value.visibility) ||
          !Object.values(value.visibility).every(v => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4)) continue;
        this.loaded.push({ ...value, id: this.nextId++, data: Object.assign(Object.create(null), value.data), tokens: Object.assign(Object.create(null), value.tokens), visibility: Object.assign(Object.create(null), value.visibility) });
      }
    } catch { /* Invalid persisted accounts remain unavailable. */ }
    return this.loaded;
  }
  persist(): void {
    globalThis.localStorage?.setItem("wd:accounts", JSON.stringify(this.records.map(({ id, ...record }) => record)));
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
