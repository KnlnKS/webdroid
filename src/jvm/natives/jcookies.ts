// java.net cookies as libcore implements them: HttpCookie parsing and domain matching, the
// in-memory CookieStore, and a CookieManager that consults whichever store and policy it holds.

import { rt, JObj, driven, type Gen } from "../runtime";
import { stringHash, vcall } from "./jlang";
import { newArrayList, toJsArray } from "./jutil";
import { type JURI, mkURI, headerMap } from "./jnet";

class JHttpCookie extends JObj {
  name = ""; value: string | null = null; domain: string | null = null; path: string | null = null;
  comment: string | null = null; commentURL: string | null = null; portlist: string | null = null;
  maxAge = -1n; secure = false; httpOnly = false; discard = false; version = 1;
  whenCreated = Date.now();
  expired(): boolean {
    return this.maxAge === 0n || (this.maxAge > 0n && (Date.now() - this.whenCreated) / 1000 > Number(this.maxAge));
  }
  header(): string {
    if (this.version === 0) return `${this.name}=${this.value ?? ""}`;
    const attr = (k: string, v: string | null) => v === null ? "" : `;$${k}="${v}"`;
    return `${this.name}="${this.value ?? ""}"` + attr("Path", this.path) + attr("Domain", this.domain) + attr("Port", this.portlist);
  }
}
const illegal = (why: string) => rt.mkThrowable("java/lang/IllegalArgumentException", why);
const nullArg = (what: string) => rt.mkThrowable("java/lang/NullPointerException", what + " is null");
const RESERVED = /^(comment|commenturl|discard|domain|expires|httponly|max-age|path|port|secure|version)$/i;
const TOKEN = /^[!#-'*+.0-9A-Z^-z|~-]+$/;

function initCookie(c: JHttpCookie, name: string, value: string | null): JHttpCookie {
  name = name.trim();
  if (!name || !TOKEN.test(name) || RESERVED.test(name) || name.startsWith("$")) throw illegal("Illegal cookie name");
  c.name = name; c.value = value;
  return c;
}
const newCookie = (name: string, value: string | null) => initCookie(new (rt.link("java/net/HttpCookie").ctor as typeof JHttpCookie)(), name, value);

/** HttpCookie.parse: a Set-Cookie header holds one Netscape cookie; Set-Cookie2 a comma list */
function parseHeader(header: string): JHttpCookie[] {
  let text = header, version = 0;
  const prefix = /^\s*set-cookie(2)?:/i.exec(text);
  if (prefix) { text = text.slice(prefix[0].length); if (prefix[1]) version = 1; }
  const specs = version ? text.split(/,(?=\s*[^;,=\s]+=)/) : [text];
  return specs.map((spec) => {
    const [pair, ...attrs] = spec.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) throw illegal("Invalid cookie name-value pair");
    const cookie = newCookie(pair.slice(0, eq), unquote(pair.slice(eq + 1)));
    cookie.version = version;
    for (const attr of attrs) {
      const i = attr.indexOf("="), key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? null : unquote(attr.slice(i + 1));
      switch (key) {
        case "comment": cookie.comment = v; break;
        case "commenturl": cookie.commentURL = v; break;
        case "discard": cookie.discard = true; break;
        case "domain": cookie.domain = v; break;
        case "path": cookie.path = v; break;
        case "port": cookie.portlist = v ?? ""; break;
        case "secure": cookie.secure = true; break;
        case "httponly": cookie.httpOnly = true; break;
        case "version": cookie.version = Number(v) || 0; break;
        case "max-age": if (v && /^-?\d+$/.test(v)) cookie.maxAge = BigInt(v); break;
        case "expires": {
          // Max-Age wins over Expires; an unparseable date is ignored, as libcore does
          const t = v ? Date.parse(v) : NaN;
          if (cookie.maxAge === -1n && !Number.isNaN(t)) cookie.maxAge = t <= Date.now() ? 0n : BigInt(Math.floor((t - Date.now()) / 1000));
          break;
        }
      }
    }
    return cookie;
  });
}
const unquote = (s: string) => { const t = s.trim(); return t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t; };

/** HttpCookie.domainMatches: RFC 2965 host-domain matching as Android applies it */
function domainMatches(domain: string | null, host: string | null): boolean {
  if (domain === null || host === null) return false;
  domain = domain.toLowerCase(); host = host.toLowerCase();
  const local = domain === ".local";
  let dot = domain.indexOf(".");
  if (dot === 0) dot = domain.indexOf(".", 1);
  if (!local && (dot === -1 || dot === domain.length - 1)) return false;
  if (!host.includes(".") && (local || domain === host + ".local")) return true;
  const diff = host.length - domain.length;
  if (diff === 0) return host === domain;
  if (diff > 0) return host.endsWith(domain) && (domain.startsWith(".") || host[diff - 1] === ".");
  return diff === -1 && domain[0] === "." && host === domain.slice(1);
}

const hostOf = (uri: JURI) => uri.parts().host;
rt.register({
  name: "java/net/HttpCookie", ctor: JHttpCookie, ifaces: ["java/lang/Cloneable"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JHttpCookie, name: string | null, value: string | null) {
      initCookie(this, name ?? rt.npe(), value);
    },
    "static parse(Ljava/lang/String;)Ljava/util/List;": (header: string | null) => newArrayList(parseHeader(header ?? rt.npe())),
    "static domainMatches(Ljava/lang/String;Ljava/lang/String;)Z": (domain: string | null, host: string | null) => +domainMatches(domain, host),
    "hasExpired()Z": function (this: JHttpCookie) { return +this.expired(); },
    "getName()Ljava/lang/String;": function (this: JHttpCookie) { return this.name; },
    "getValue()Ljava/lang/String;": function (this: JHttpCookie) { return this.value; },
    "setValue(Ljava/lang/String;)V": function (this: JHttpCookie, v: string | null) { this.value = v; },
    "getDomain()Ljava/lang/String;": function (this: JHttpCookie) { return this.domain; },
    "setDomain(Ljava/lang/String;)V": function (this: JHttpCookie, v: string | null) { this.domain = v === null ? null : v.toLowerCase(); },
    "getPath()Ljava/lang/String;": function (this: JHttpCookie) { return this.path; },
    "setPath(Ljava/lang/String;)V": function (this: JHttpCookie, v: string | null) { this.path = v; },
    "getComment()Ljava/lang/String;": function (this: JHttpCookie) { return this.comment; },
    "setComment(Ljava/lang/String;)V": function (this: JHttpCookie, v: string | null) { this.comment = v; },
    "getCommentURL()Ljava/lang/String;": function (this: JHttpCookie) { return this.commentURL; },
    "getPortlist()Ljava/lang/String;": function (this: JHttpCookie) { return this.portlist; },
    "setPortlist(Ljava/lang/String;)V": function (this: JHttpCookie, v: string | null) { this.portlist = v; },
    "getMaxAge()J": function (this: JHttpCookie) { return this.maxAge; },
    "setMaxAge(J)V": function (this: JHttpCookie, v: bigint) { this.maxAge = v; },
    "getSecure()Z": function (this: JHttpCookie) { return +this.secure; },
    "setSecure(Z)V": function (this: JHttpCookie, v: number) { this.secure = !!v; },
    "isHttpOnly()Z": function (this: JHttpCookie) { return +this.httpOnly; },
    "setHttpOnly(Z)V": function (this: JHttpCookie, v: number) { this.httpOnly = !!v; },
    "getDiscard()Z": function (this: JHttpCookie) { return +this.discard; },
    "setDiscard(Z)V": function (this: JHttpCookie, v: number) { this.discard = !!v; },
    "getVersion()I": function (this: JHttpCookie) { return this.version; },
    "setVersion(I)V": function (this: JHttpCookie, v: number) {
      if (v !== 0 && v !== 1) throw illegal("cookie version should be 0 or 1");
      this.version = v;
    },
    "toString()Ljava/lang/String;": function (this: JHttpCookie) { return this.header(); },
    "equals(Ljava/lang/Object;)Z": function (this: JHttpCookie, o: unknown) { return +(o instanceof JHttpCookie && sameCookie(o, this)); },
    // OpenJDK's: the hashes of the lower-cased name and domain and of the path, summed
    "hashCode()I": function (this: JHttpCookie) {
      return (stringHash(this.name.toLowerCase()) + stringHash((this.domain ?? "").toLowerCase()) + stringHash(this.path ?? "")) | 0;
    },
    "clone()Ljava/lang/Object;": function (this: JHttpCookie) { return Object.assign(new (this.constructor as typeof JHttpCookie)(), this); },
  },
});

class JCookiePolicy extends JObj { kind: "all" | "none" | "original" = "original"; }
const policy = (kind: JCookiePolicy["kind"]) => Object.assign(new JCookiePolicy(), { kind });
const ACCEPT_ORIGINAL = policy("original");
rt.register({
  name: "java/net/CookiePolicy", ctor: class extends JObj {},
  statics: { ACCEPT_ALL: policy("all"), ACCEPT_NONE: policy("none"), ACCEPT_ORIGINAL_SERVER: ACCEPT_ORIGINAL },
});
rt.register({
  name: "webdroid/CookiePolicy", ctor: JCookiePolicy, ifaces: ["java/net/CookiePolicy"],
  methods: {
    "shouldAccept(Ljava/net/URI;Ljava/net/HttpCookie;)Z": function (this: JCookiePolicy, uri: JURI | null, cookie: JHttpCookie | null) {
      if (this.kind !== "original") return +(this.kind === "all");
      return +(uri !== null && cookie !== null && domainMatches(cookie.domain, hostOf(uri)));
    },
  },
});

/** libcore's InMemoryCookieStore: cookies indexed by the effective URI (http + host) they came from */
class JCookieStore extends JObj {
  index = new Map<string | null, JHttpCookie[]>();
  live(): JHttpCookie[] {
    const out: JHttpCookie[] = [];
    for (const [key, list] of this.index) {
      const kept = list.filter((c) => !c.expired());
      this.index.set(key, kept);
      for (const c of kept) if (!out.some((o) => sameCookie(o, c))) out.push(c);
    }
    return out;
  }
}
/** HttpCookie.equals: name and domain compare without case, the path exactly */
const sameCookie = (a: JHttpCookie, b: JHttpCookie) =>
  a.name.toLowerCase() === b.name.toLowerCase() && (a.domain ?? "").toLowerCase() === (b.domain ?? "").toLowerCase() && a.path === b.path;
const effective = (uri: JURI | null) => uri === null ? null : "http://" + (hostOf(uri) ?? "");
rt.markers("java/net/CookieStore");
rt.register({
  name: "webdroid/CookieStore", ctor: JCookieStore, ifaces: ["java/net/CookieStore"],
  methods: {
    "add(Ljava/net/URI;Ljava/net/HttpCookie;)V": function (this: JCookieStore, uri: JURI | null, cookie: JHttpCookie | null) {
      if (cookie === null) throw nullArg("cookie");
      const key = effective(uri), list = (this.index.get(key) ?? []).filter((c) => !sameCookie(c, cookie));
      if (cookie.maxAge !== 0n) list.push(cookie);
      this.index.set(key, list);
    },
    "get(Ljava/net/URI;)Ljava/util/List;": function (this: JCookieStore, uri: JURI | null) {
      if (uri === null) throw nullArg("uri");
      const key = effective(uri), host = hostOf(uri);
      const out = (this.index.get(key) ?? []).filter((c) => !c.expired());
      for (const [k, list] of this.index) {
        if (k === key) continue;
        for (const c of list) if (domainMatches(c.domain, host) && !c.expired() && !out.some((o) => sameCookie(o, c))) out.push(c);
      }
      return newArrayList(out);
    },
    "getCookies()Ljava/util/List;": function (this: JCookieStore) { return newArrayList(this.live()); },
    "getURIs()Ljava/util/List;": function (this: JCookieStore) {
      return newArrayList([...this.index.keys()].filter((k): k is string => k !== null).map(mkURI));
    },
    "remove(Ljava/net/URI;Ljava/net/HttpCookie;)Z": function (this: JCookieStore, uri: JURI | null, cookie: JHttpCookie | null) {
      if (cookie === null) throw nullArg("cookie");
      const key = effective(uri), list = this.index.get(key) ?? [];
      const kept = list.filter((c) => !sameCookie(c, cookie));
      this.index.set(key, kept);
      return +(kept.length !== list.length);
    },
    "removeAll()Z": function (this: JCookieStore) { const had = this.index.size > 0; this.index.clear(); return +had; },
  },
});

class JCookieManager extends JObj { store: unknown = null; policy: unknown = ACCEPT_ORIGINAL; }
const newStore = () => new (rt.link("webdroid/CookieStore").ctor as typeof JCookieStore)();
/** OpenJDK's default cookie path: the request path up to its last slash */
function defaultPath(path: string | null): string {
  if (!path) return "/";
  if (path.endsWith("/")) return path;
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "/";
}
const pathMatches = (path: string, cookiePath: string | null) => cookiePath === null || path.startsWith(cookiePath);
rt.register({
  name: "java/net/CookieManager", ctor: JCookieManager, sup: "java/net/CookieHandler",
  methods: {
    "<init>()V": function (this: JCookieManager) { this.store = newStore(); },
    "<init>(Ljava/net/CookieStore;Ljava/net/CookiePolicy;)V": function (this: JCookieManager, store: unknown, p: unknown) {
      this.store = store ?? newStore();
      this.policy = p ?? ACCEPT_ORIGINAL;
    },
    "setCookiePolicy(Ljava/net/CookiePolicy;)V": function (this: JCookieManager, p: unknown) { if (p !== null) this.policy = p; },
    "getCookieStore()Ljava/net/CookieStore;": function (this: JCookieManager) { return this.store; },
    "get(Ljava/net/URI;Ljava/util/Map;)Ljava/util/Map;": driven(function* (this: JCookieManager, uri: JURI | null, headers: unknown): Gen {
      if (uri === null || headers === null) throw illegal("Argument is null");
      const { scheme, path } = uri.parts(), secure = scheme?.toLowerCase() === "https";
      const http = /^https?$/i.test(scheme ?? "");
      const found = (yield toJsArray(yield vcall(this.store, "get", "(Ljava/net/URI;)Ljava/util/List;", uri))) as JHttpCookie[];
      const cookies = found.filter((c) => pathMatches(path || "/", c.path) && (secure || !c.secure) && (http || !c.httpOnly));
      // more specific paths first, as OpenJDK's sortByPath orders them
      cookies.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
      const values: string[] = cookies.map((c) => c.header());
      if (cookies.some((c) => c.version > 0)) values.unshift('$Version="1"');
      return headerMap([["Cookie", values]]);
    }),
    "put(Ljava/net/URI;Ljava/util/Map;)V": driven(function* (this: JCookieManager, uri: JURI | null, headers: unknown): Gen {
      if (uri === null || headers === null) throw illegal("Argument is null");
      if (this.store === null) return;
      const { path, host } = uri.parts();
      for (const e of (yield toJsArray(yield vcall(headers, "entrySet", "()Ljava/util/Set;"))) as unknown[]) {
        const key = (yield vcall(e, "getKey", "()Ljava/lang/Object;")) as string | null;
        if (!key || !/^set-cookie2?$/i.test(key)) continue;
        for (const header of (yield toJsArray(yield vcall(e, "getValue", "()Ljava/lang/Object;"))) as string[]) {
          let cookies: JHttpCookie[];
          try { cookies = parseHeader(header); } catch { continue; }
          for (const cookie of cookies) {
            cookie.path ??= defaultPath(path);
            cookie.domain ??= host && !host.includes(".") ? host + ".local" : host;
            let accept = false;
            try { accept = !!(yield vcall(this.policy, "shouldAccept", "(Ljava/net/URI;Ljava/net/HttpCookie;)Z", uri, cookie)); } catch { /* rejected */ }
            if (accept) yield vcall(this.store, "add", "(Ljava/net/URI;Ljava/net/HttpCookie;)V", uri, cookie);
          }
        }
      }
    }),
  },
});
