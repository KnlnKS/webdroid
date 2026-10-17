import { CookieJar, Cookie, getPublicSuffix } from "tough-cookie";
import { storedPackages } from "../android/packages.ts";
import type { DocumentCookie } from "./webpage/protocol.ts";

const KEY = "wd:web-cookies:";

export class WebCookies {
  accept = true;
  private jar = new CookieJar();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private key: string;
  private watchers = new Set<() => void>();
  constructor(pkg: string) {
    this.key = KEY + pkg;
    try { const saved = localStorage.getItem(this.key); if (saved) this.jar = CookieJar.deserializeSync(saved); } catch {}
  }
  get(url: string): string {
    try { return this.jar.getCookieStringSync(url, { http: true }); } catch { return ""; }
  }
  set(url: string, value: string, http = true): boolean {
    if (!this.accept) return false;
    try {
      const cookie = Cookie.parse(value);
      if (!cookie || cookie.sameSite === "none" && !cookie.secure || !this.jar.setCookieSync(cookie, url, { http, ignoreError: true })) return false;
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 0);
      this.changed();
      return true;
    } catch { return false; }
  }
  /** whether `url` is of the site of the page at `site`: its cookies are first-party there */
  sameSite(url: string, site: string): boolean {
    const target = URL.parse(url), source = URL.parse(site);
    const domain = (u: URL) => getPublicSuffix(u.hostname, { ignoreError: true }) ?? u.hostname;
    return !!target && !!source && target.protocol === source.protocol && domain(target) === domain(source);
  }
  network(url: string, site: string, values: string[], thirdParty: boolean): string {
    try {
      const same = this.sameSite(url, site);
      if (!same && !thirdParty) return "";
      for (const value of values) this.set(url, value);
      return this.jar.getCookieStringSync(url, { sameSiteContext: same ? "strict" : "none" });
    } catch { return ""; }
  }
  /** what document.cookie reads at `url` */
  document(url: string): DocumentCookie[] {
    try {
      return this.jar.getCookiesSync(url, { http: false, sort: true }).map((c) => {
        const expires = c.expiryTime() ?? Infinity;
        return { text: c.cookieString(), expires: Number.isFinite(expires) ? expires : 0 };
      });
    } catch { return []; }
  }
  /** `f` after each change, until the returned function is called */
  watch(f: () => void): () => void { this.watchers.add(f); return () => this.watchers.delete(f); }
  private changed() { for (const f of this.watchers) f(); }
  has(): boolean { return this.active().length > 0; }
  remove(sessionOnly = false): boolean {
    const saved = this.jar.serializeSync()!, before = this.active();
    saved.cookies = sessionOnly ? before.filter(c => c.maxAge !== undefined || c.expires !== undefined) : [];
    this.jar = CookieJar.deserializeSync(saved);
    this.flush();
    this.changed();
    return before.length !== saved.cookies.length;
  }
  /** the packages with jars persisted */
  static packages(): string[] { return storedPackages(KEY); }
  /** the emptied jar's removal with its app */
  forget() {
    try { localStorage.removeItem(this.key); } catch {}
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const saved = this.jar.serializeSync()!;
    saved.cookies = this.active().filter(c => c.maxAge !== undefined || c.expires !== undefined);
    try { localStorage.setItem(this.key, JSON.stringify(saved)); } catch {}
  }
  private active() { return (this.jar.serializeSync()?.cookies ?? []).filter(c => (Cookie.fromJSON(c)?.expiryTime() ?? 0) > Date.now()); }
}
