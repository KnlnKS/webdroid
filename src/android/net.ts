// android.net.Uri runs from AOSP bytecode; TS services reach one through its Java methods.

import { awaited, rt, type JObj, type Gen } from "../jvm/runtime.ts";
import { scall, vcall } from "../jvm/natives/jentry.ts";

export type JUri = JObj;
/** Uri.parse */
export const mkUri = (s: string): JUri | Promise<JUri> => scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", s);
/** Uri.toString; a null uri is a NullPointerException */
export const uriText = (u: JUri | null): string | Promise<string> => vcall(u ?? rt.npe(), "toString", "()Ljava/lang/String;");
/** a hierarchical uri string's authority and decoded path segments, as getAuthority and getPathSegments answer them */
export function uriParts(s: string): { authority: string; segments: string[] } {
  const i = s.indexOf("://");
  if (i < 0) return { authority: "", segments: [] };
  const rest = s.slice(i + 3).split(/[?#]/)[0]!, j = rest.indexOf("/");
  const segments = j < 0 ? [] : rest.slice(j + 1).split("/").filter(Boolean);
  return { authority: decode(j < 0 ? rest : rest.slice(0, j)), segments: segments.map(decode) };
}
/** a ClipData's item uris */
export function* clipUris(clip: JObj | null): Gen<string[]> {
  const uris: string[] = [];
  for (let i = 0, n: number = clip ? yield vcall(clip, "getItemCount", "()I") : 0; i < n; i++) {
    const uri: JUri | null = yield vcall(yield vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", i), "getUri", "()Landroid/net/Uri;");
    if (uri) uris.push(yield* awaited(uriText(uri)));
  }
  return uris;
}
// Uri.decode: a malformed escape stays literal, and '+' is not a space
const decode = (s: string) => s.includes("%") ? s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) =>
  new TextDecoder().decode(Uint8Array.from(m.slice(1).split("%"), (h) => parseInt(h, 16)))) : s;
