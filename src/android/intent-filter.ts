import { attr, attrStr, TV, type XmlNode } from "./axml";
import type { JIntent } from "./intent";
import { mkUri, uriDecode, uriParts } from "./net";
import { appHost } from "./apphost";
import { resString } from "./res";

function value(node: XmlNode, name: string): string | null {
  const a = attr(node, name);
  return a?.type === TV.REFERENCE && appHost ? resString(appHost.res, a.data) : attrStr(node, name);
}

// Android's simple glob consumes greedily without regular-expression backtracking.
function simpleGlob(pattern: string, text: string): boolean {
  let p = 0, t = 0;
  while (p < pattern.length && t < text.length) {
    let c = pattern[p++]!, escaped = c === "\\";
    if (escaped) c = pattern[p++]!;
    if (pattern[p] === "*") {
      p++;
      if (!escaped && c === ".") {
        if (p === pattern.length) return true;
        let next = pattern[p++]!;
        if (next === "\\") next = pattern[p++]!;
        while (t < text.length && text[t] !== next) t++;
        if (t === text.length) return false;
        t++;
      } else while (text[t] === c && t < text.length) t++;
    } else if ((c !== "." || escaped) && c !== text[t++]) return false;
    else if (c === "." && !escaped) t++;
  }
  return p === pattern.length && t === text.length || pattern.slice(p) === ".*";
}

function patterns(data: XmlNode[], name: string, text: string): boolean | null {
  let present = false;
  for (const node of data) {
    for (const suffix of ["", "Prefix", "Suffix", "Pattern", "AdvancedPattern"]) {
      const pattern = value(node, name + suffix);
      if (pattern === null) continue;
      present = true;
      if (suffix === "" ? text === pattern : suffix === "Prefix" ? text.startsWith(pattern) :
        suffix === "Suffix" ? text.endsWith(pattern) : suffix === "Pattern" && simpleGlob(pattern, text)) return true;
    }
  }
  return present ? false : null;
}

export function matchesIntentFilter(filter: XmlNode, intent: JIntent, defaultOnly: boolean): boolean {
  const has = (kind: string, name: string) => filter.children.some((n) => n.name === kind && value(n, "name") === name);
  if (intent.action && !has("action", intent.action)) return false;
  if (defaultOnly && !has("category", "android.intent.category.DEFAULT")) return false;
  for (const category of intent.categories) if (!has("category", category)) return false;
  if (filter.children.some((n) => n.name === "uri-relative-filter-group")) return false;
  const data = filter.children.filter((n) => n.name === "data");
  const schemes = data.map((n) => value(n, "scheme")).filter((s) => s !== null);
  const types = data.map((n) => value(n, "mimeType")).filter((s) => s !== null);
  if (!schemes.length && !types.length) return intent.dataUri === null && intent.typeStr === null;
  const uri = intent.dataUri === null ? null : uriParts(mkUri(intent.dataUri));
  if (schemes.length) {
    if (!schemes.includes(uri?.scheme ?? "")) return false;
    const ssp = patterns(data, "ssp", uriDecode(uri?.ssp ?? "")!);
    if (ssp !== true) {
      const authorities = data.filter((n) => value(n, "host") !== null);
      if (authorities.length) {
        if (uri?.authority === null || !uri) return false;
        const authority = uri?.authority?.slice((uri.authority.lastIndexOf("@") ?? -1) + 1) ?? "";
        const colon = authority.indexOf(":", authority.startsWith("[") ? authority.indexOf("]") : 0);
        const host = uriDecode(colon < 0 ? authority : authority.slice(0, colon))!.toLowerCase();
        const port = colon < 0 ? -1 : Number(authority.slice(colon + 1));
        if (!authorities.some((n) => {
          const wanted = value(n, "host")!.toLowerCase(), wantedPort = value(n, "port");
          return (wanted.startsWith("*") ? host.endsWith(wanted.slice(1)) : host === wanted) &&
            (wantedPort === null || Number(wantedPort) === port);
        })) return false;
        if (patterns(data, "path", uriDecode(uri?.path ?? "")!) === false) return false;
      } else if (ssp === false) return false;
    }
  } else if (uri?.scheme && uri.scheme !== "content" && uri.scheme !== "file") return false;
  if (!types.length) return intent.typeStr === null;
  if (!intent.typeStr) return false;
  const [major, minor] = intent.typeStr.split("/");
  return types.some((type) => {
    const [a, b] = type.split("/");
    return !!minor && !!b && (a === major || a === "*" || major === "*") && (b === minor || b === "*" || minor === "*");
  });
}
