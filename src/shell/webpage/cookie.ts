import type { DocumentCookie } from "./protocol.ts";

/** document.cookie's cookies once the page sets `value` at `page`, as the jar will store it: a
 *  cookie it would refuse, or one this document cannot see, is left out. The jar (webcookies.ts) also
 *  refuses a public suffix's Domain, which takes its list to know. */
export function setDocumentCookie(cookies: DocumentCookie[], value: string, page: string): DocumentCookie[] {
  const [pair, ...attributes] = value.split(";"), at = pair.indexOf("=");
  const name = at < 0 ? "" : pair.slice(0, at).trim(), text = at < 0 ? pair.trim() : name + "=" + pair.slice(at + 1).trim();
  const url = new URL(page), path = url.pathname || "/";
  let expires = 0, maxAge = false, secure = false, hostOnly = true, none = false;
  // RFC 6265's default path: the page's directory
  let cookiePath = path.lastIndexOf("/") > 0 ? path.slice(0, path.lastIndexOf("/")) : "/";
  for (const attribute of attributes) {
    const eq = attribute.indexOf("="), key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase(), v = eq < 0 ? "" : attribute.slice(eq + 1).trim();
    if (key === "max-age" && /^-?\d+$/.test(v)) { maxAge = true; expires = Number(v) <= 0 ? -1 : Date.now() + Number(v) * 1000; }
    else if (key === "expires" && !maxAge && !Number.isNaN(Date.parse(v))) expires = Date.parse(v) <= Date.now() ? -1 : Date.parse(v);
    else if (key === "domain" && v.replace(/^\./, "")) {
      const domain = v.replace(/^\./, "").toLowerCase();
      if (url.hostname !== domain && !url.hostname.endsWith("." + domain)) return cookies;
      hostOnly = false;
    } else if (key === "path" && v.startsWith("/")) {
      if (!(path === v || path.startsWith(v) && (v.endsWith("/") || path[v.length] === "/"))) return cookies;
      cookiePath = v;
    } else if (key === "secure") {
      if (url.protocol !== "https:") return cookies;
      secure = true;
    } else if (key === "httponly") return cookies;
    else if (key === "samesite") none = v.toLowerCase() === "none";
  }
  // the jar's prefixes, and a cross-site cookie that is not Secure
  if (name.startsWith("__Secure-") && !secure || name.startsWith("__Host-") && !(secure && hostOnly && cookiePath === "/") || none && !secure) return cookies;
  const kept = cookies.filter((c) => (c.text.includes("=") ? c.text.slice(0, c.text.indexOf("=")) : "") !== name);
  return expires < 0 ? kept : [...kept, { text, expires }];
}
