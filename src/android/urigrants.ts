// The URI grants a process's ActivityManager and ActivityStarter make and check, which system_server's
// UriGrantsManagerService (server/urigrants.ts) answers as the calling process.
import { awaited, type Gen, type JObj } from "../jvm/runtime.ts";
import { vcall } from "../jvm/natives/jentry.ts";
import { notConnected } from "../jvm/natives/jthrowable.ts";
import { clipUris, uriText, type JUri } from "./net.ts";

export type UriGrantCalls = {
  check(uri: string, uid: number, modes: number): number | Promise<number>;
  /** the caller grants `targetPkg` each of `uris` it needs, or is refused with a SecurityException */
  grant(targetPkg: string, uris: string[], modes: number): void | Promise<void>;
  revoke(targetPkg: string | null, uri: string, modes: number): void | Promise<void>;
};
/** UriGrantsManagerInternal */
export const uriGrantTransport: UriGrantCalls = { check: notConnected, grant: notConnected, revoke: notConnected };
/** checkGrantUriPermissionFromIntent: the caller grants `targetPkg` the intent's data and ClipData
 *  uris under its grant flags */
export function* grantIntentUris$(targetPkg: string, intent: JObj): Gen<void> {
  const flags: number = yield vcall(intent, "getFlags", "()I");
  if (!(flags & 3)) return;
  const uri: JUri | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  const uris: string[] = yield* clipUris(yield vcall(intent, "getClipData", "()Landroid/content/ClipData;"));
  if (uri) uris.push(yield* awaited(uriText(uri)));
  if (uris.length) yield* awaited(uriGrantTransport.grant(targetPkg, uris, flags));
}
