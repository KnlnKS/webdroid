import type { DocumentCookie } from "./protocol.ts";

/** document.cookie's cookies once the page sets `value` at `page`, as the jar will store it: a
 *  cookie it would refuse, or one this document cannot see, is left out */
export function setDocumentCookie(cookies: DocumentCookie[], value: string, page: string): DocumentCookie[] {
  const [pair, ...attributes] = value.split(";"), at = pair.indexOf("=");
  const name = at < 0 ? "" : pair.slice(0, at).trim(), text = at < 0 ? pair.trim() : name + "=" + pair.slice(at + 1).trim();
  const url = new URL(page), path = url.pathname || "/";
  let expires = 0, maxAge = false;
  for (const attribute of attributes) {
    const eq = attribute.indexOf("="), key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase(), v = eq < 0 ? "" : attribute.slice(eq + 1).trim();
    if (key === "max-age" && /^-?\d+$/.test(v)) { maxAge = true; expires = Number(v) <= 0 ? -1 : Date.now() + Number(v) * 1000; }
    else if (key === "expires" && !maxAge && !Number.isNaN(Date.parse(v))) expires = Date.parse(v) <= Date.now() ? -1 : Date.parse(v);
    else if (key === "domain" && v) {
      const domain = v.replace(/^\./, "").toLowerCase();
      if (url.hostname !== domain && !url.hostname.endsWith("." + domain)) return cookies;
    } else if (key === "path" && v.startsWith("/") && !(path === v || path.startsWith(v) && (v.endsWith("/") || path[v.length] === "/"))) return cookies;
    else if (key === "secure" && url.protocol !== "https:" || key === "httponly") return cookies;
  }
  const kept = cookies.filter((c) => (c.text.includes("=") ? c.text.slice(0, c.text.indexOf("=")) : "") !== name);
  return expires < 0 ? kept : [...kept, { text, expires }];
}
