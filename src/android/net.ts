// android.net.Uri runs from AOSP bytecode; TS services reach one through its Java methods.

import type { JObj } from "../jvm/runtime";
import { scall, vcall } from "../jvm/natives/jlang";

export type JUri = JObj;
/** Uri.parse */
export const mkUri = (s: string): JUri | Promise<JUri> => scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", s);
/** Uri.toString */
export const uriText = (u: JUri): string | Promise<string> => vcall(u, "toString", "()Ljava/lang/String;");
/** a hierarchical uri string's authority and decoded path segments, as getAuthority and getPathSegments answer them */
export function uriParts(s: string): [string, string[]] {
  const i = s.indexOf("://");
  if (i < 0) return ["", []];
  const rest = s.slice(i + 3).split(/[?#]/)[0]!, j = rest.indexOf("/");
  const segments = j < 0 ? [] : rest.slice(j + 1).split("/").filter(Boolean);
  return [decode(j < 0 ? rest : rest.slice(0, j)), segments.map(decode)];
}
// Uri.decode: a malformed escape stays literal, and '+' is not a space
const decode = (s: string) => s.includes("%") ? s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) =>
  new TextDecoder().decode(Uint8Array.from(m.slice(1).split("%"), (h) => parseInt(h, 16)))) : s;
