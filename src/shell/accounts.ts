export type StoredAccount = {
  name: string; type: string; owner: string; password: string | null;
  data: Record<string, string>; tokens: Record<string, string>; visibility: Record<string, number>;
  previousName?: string;
};
const strings = (value: unknown): value is Record<string, string> => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string");
export class AccountStore {
  private loaded: StoredAccount[] | null = null;
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
        this.loaded.push({ ...value, data: Object.assign(Object.create(null), value.data), tokens: Object.assign(Object.create(null), value.tokens), visibility: Object.assign(Object.create(null), value.visibility) });
      }
    } catch { /* Invalid persisted accounts remain unavailable. */ }
    return this.loaded;
  }
  persist(): void {
    globalThis.localStorage?.setItem("wd:accounts", JSON.stringify(this.records));
    for (const listener of this.listeners) listener();
  }
  /** AccountManagerService on a package's removal: the accounts its authenticator kept, and their
   *  visibility to it */
  removePackage(pkg: string): void {
    const kept = this.records.filter((s) => s.owner !== pkg);
    for (const s of kept) delete s.visibility[pkg];
    this.loaded = kept;
    this.persist();
  }
  watch(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
