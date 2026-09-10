import { CookieJar, Cookie, getPublicSuffix } from "tough-cookie";

export class WebCookies {
  accept = true;
  private jar = new CookieJar();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private key: string;
  constructor(pkg: string) {
    this.key = "wd:web-cookies:" + pkg;
    try { const saved = localStorage.getItem(this.key); if (saved) this.jar = CookieJar.deserializeSync(saved); } catch {}
  }
  get(url: string, http = true): string {
    try { return this.jar.getCookieStringSync(url, { http }); } catch { return ""; }
  }
  set(url: string, value: string, http = true): boolean {
    if (!this.accept) return false;
    try {
      const cookie = Cookie.parse(value);
      if (!cookie || cookie.sameSite === "none" && !cookie.secure || !this.jar.setCookieSync(cookie, url, { http, ignoreError: true })) return false;
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 0);
      return true;
    } catch { return false; }
  }
  network(url: string, site: string, values: string[], thirdParty: boolean): string {
    try {
      const target = new URL(url), source = new URL(site);
      const domain = (u: URL) => getPublicSuffix(u.hostname, { ignoreError: true }) ?? u.hostname;
      const same = target.protocol === source.protocol && domain(target) === domain(source);
      if (!same && !thirdParty) return "";
      for (const value of values) this.set(url, value);
      return this.jar.getCookieStringSync(url, { sameSiteContext: same ? "strict" : "none" });
    } catch { return ""; }
  }
  has(): boolean { return this.active().length > 0; }
  remove(sessionOnly = false): boolean {
    const saved = this.jar.serializeSync()!, before = this.active();
    saved.cookies = sessionOnly ? before.filter(c => c.maxAge !== undefined || c.expires !== undefined) : [];
    this.jar = CookieJar.deserializeSync(saved);
    this.flush();
    return before.length !== saved.cookies.length;
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
