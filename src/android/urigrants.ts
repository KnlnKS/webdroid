import { hostStub } from "./binder";
import { rt, JObj } from "../jvm/runtime";
import { appHost } from "./apphost";
import { type JUri, mkUri } from "./net";
import { PROCESS_UID } from "./os";
import { newObj, vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jcoll";
import { packages } from "./packages";
type PersistedUriGrant = { uri: string; flags: number; time: number };
const PREFIX_GRANT = 0x80, PERSISTABLE_GRANT = 0x40;
/** A persistable grant is app state that survives a reboot, so it lives with the install. */
const uriGrants = {
  key: () => "wd:install:" + (appHost?.pkg ?? "") + ":uriperms",
  all(): PersistedUriGrant[] {
    try {
      const saved: unknown = JSON.parse(globalThis.localStorage?.getItem(this.key()) ?? "[]");
      if (!Array.isArray(saved)) return [];
      return saved.flatMap((entry) => {
        if (typeof entry === "string") return [{ uri: entry, flags: 3 | (entry.includes("/tree/") ? PREFIX_GRANT : 0), time: 0 }];
        if (entry && typeof entry === "object" && "uri" in entry && typeof entry.uri === "string" &&
          "flags" in entry && typeof entry.flags === "number")
          return [{ uri: entry.uri, flags: entry.flags, time: "time" in entry && typeof entry.time === "number" ? entry.time : 0 }];
        return [];
      });
    } catch { return []; }
  },
  set(v: PersistedUriGrant[]) { try { globalThis.localStorage?.setItem(this.key(), JSON.stringify(v)); } catch { /* private mode */ } },
};
const transientUriGrants = new Map<string, Map<string, number>>();
const grantedUri = (target: string, granted: string, flags: number) =>
  target === granted || ((flags & PREFIX_GRANT) !== 0 && target.startsWith(granted + "/"));
function transientFlags(pkg: string, uri: JUri): number {
  let flags = 0;
  for (const [granted, mode] of transientUriGrants.get(pkg) ?? []) {
    if (grantedUri(uri.uri, granted, mode)) flags |= mode;
  }
  return flags;
}
export function grantUriPermission(pkg: string, uri: JUri, modes: number): void {
  if (!pkg || !uri) rt.npe();
  if (!(modes & 3)) return;
  let grants = transientUriGrants.get(pkg);
  if (!grants) transientUriGrants.set(pkg, grants = new Map());
  grants.set(uri.uri, (grants.get(uri.uri) ?? 0) | (modes & (3 | PREFIX_GRANT | PERSISTABLE_GRANT)));
}
/** ActivityManager's grant of a result's URIs to the activity receiving it: its data and every
 *  ClipData item, under the result's grant flags */
export async function grantResultUris(pkg: string, data: JObj): Promise<void> {
  const flags: number = await vcall(data, "getFlags", "()I");
  if (!(flags & 3)) return;
  const clip: JObj | null = await vcall(data, "getClipData", "()Landroid/content/ClipData;");
  const uris: (JUri | null)[] = [await vcall(data, "getData", "()Landroid/net/Uri;")];
  for (let i = 0, n = clip ? await vcall(clip, "getItemCount", "()I") : 0; i < n; i++)
    uris.push(await vcall(await vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", i), "getUri", "()Landroid/net/Uri;"));
  for (const uri of uris) if (uri) grantUriPermission(pkg, uri, flags);
}
export function revokeUriPermission(uri: JUri, modes: number): void {
  if (!uri) rt.npe();
  for (const grants of transientUriGrants.values()) {
    const remaining = (grants.get(uri.uri) ?? 0) & ~(modes & 3);
    if (remaining & 3) grants.set(uri.uri, remaining);
    else grants.delete(uri.uri);
  }
}
export function checkUriPermission(u: JUri, _pid: number, uid: number, modes: number): number {
  if (!u) rt.npe();
  if (uid === 0) return 0;
  const requested = modes & 3;
  if (!requested) return -1;
  if (uid === PROCESS_UID && uriGrants.all().some((grant) =>
    grantedUri(u.uri, grant.uri, grant.flags) && (grant.flags & requested) === requested)) return 0;
  for (const pkg of transientUriGrants.keys()) {
    if (packages.get(pkg)?.uid !== uid) continue;
    if ((transientFlags(pkg, u) & requested) === requested) return 0;
  }
  return -1;
}
/** UriGrantsManagerService.takePersistableUriPermission for this app: a grant it was offered as
 *  persistable, or one it already persisted */
function takePersistable(u: JUri, modes: number): void {
  if (!u) rt.npe();
  const requested = modes & 3;
  if (!requested) return;
  const all = uriGrants.all();
  const old = all.find((grant) => grant.uri === u.uri);
  const offered = transientFlags(appHost?.pkg ?? "", u);
  if ((offered & (requested | PERSISTABLE_GRANT)) !== (requested | PERSISTABLE_GRANT) &&
    (!old || (old.flags & requested) !== requested))
    throw rt.mkThrowable("java/lang/SecurityException", "No persistable URI permission for " + u.uri);
  const flags = (old?.flags ?? 0) | requested | (offered & PREFIX_GRANT);
  uriGrants.set([...all.filter((grant) => grant.uri !== u.uri), { uri: u.uri, flags, time: Date.now() }]);
}
function releasePersistable(u: JUri, modes: number): void {
  if (!u) rt.npe();
  uriGrants.set(uriGrants.all().flatMap((grant) => {
    if (grant.uri !== u.uri) return [grant];
    const flags = grant.flags & ~(modes & 3);
    return flags & 3 ? [{ ...grant, flags }] : [];
  }));
}
const persistedPermissions = async (): Promise<JObj> => newArrayList(await Promise.all(uriGrants.all().map((grant) =>
  newObj("android/content/UriPermission", "(Landroid/net/Uri;IJ)V", mkUri(grant.uri), grant.flags, BigInt(grant.time)))));

// IUriGrantsManager, under AOSP's ContentResolver: this app's persisted grants. Grants it made to
// others are not recorded, so it has no outgoing ones.
rt.register({ name: "webdroid/UriGrantsManagerService", ctor: class extends JObj {}, sup: "android/app/IUriGrantsManager$Stub", methods: {
  "takePersistableUriPermission(Landroid/net/Uri;ILjava/lang/String;I)V": (u: JUri, modes: number) => takePersistable(u, modes),
  "releasePersistableUriPermission(Landroid/net/Uri;ILjava/lang/String;I)V": (u: JUri, modes: number) => releasePersistable(u, modes),
  "getUriPermissions(Ljava/lang/String;ZZ)Landroid/content/pm/ParceledListSlice;": async (_pkg: string, incoming: number) =>
    newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", incoming ? await persistedPermissions() : newArrayList()),
} });
hostStub("uri_grants", "webdroid/UriGrantsManagerService");
