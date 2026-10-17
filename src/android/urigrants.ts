import { hostStub } from "./binder.ts";
import { awaited, rt, JObj, driven, type Gen } from "../jvm/runtime.ts";
import { appHost } from "./apphost.ts";
import { type JUri, mkUri, uriText, clipUris } from "./net.ts";
import { PROCESS_UID } from "./os.ts";
import { newObj, vcall, after } from "../jvm/natives/jentry.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { packages } from "./packages.ts";
import type { PackageState } from "../shell/packagedata.ts";
type PersistedUriGrant = { uri: string; flags: number; time: number };
const PREFIX_GRANT = 0x80, PERSISTABLE_GRANT = 0x40;
/** A persistable grant is app state that survives a reboot, so it lives with the install. */
const grantsKey = (pkg: string) => "wd:install:" + pkg + ":uriperms";
/** removeUriPermissionsForPackage's persisted share: the grants the package holds, which a clear
 *  that keeps the package's state keeps */
export const uriGrantData: PackageState = {
  clear(pkg, _uid, how) {
    if (!how.keepState) try { globalThis.localStorage?.removeItem(grantsKey(pkg)); } catch { /* storage can be unavailable */ }
  },
};
const uriGrants = {
  key: () => grantsKey(appHost?.pkg ?? ""),
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
function transientFlags(pkg: string, uri: string): number {
  let flags = 0;
  for (const [granted, mode] of transientUriGrants.get(pkg) ?? []) {
    if (grantedUri(uri, granted, mode)) flags |= mode;
  }
  return flags;
}
export function grantUriPermission(pkg: string, uri: string, modes: number): void {
  if (!(modes & 3)) return;
  let grants = transientUriGrants.get(pkg);
  if (!grants) transientUriGrants.set(pkg, grants = new Map());
  grants.set(uri, (grants.get(uri) ?? 0) | (modes & (3 | PREFIX_GRANT | PERSISTABLE_GRANT)));
}
/** ActivityManager's grant of a result's URIs to the activity receiving it: its data and every
 *  ClipData item, under the result's grant flags */
export const grantResultUris = driven(function* (pkg: string, data: JObj): Gen<void> {
  const flags: number = yield vcall(data, "getFlags", "()I");
  if (!(flags & 3)) return;
  const uri: JUri | null = yield vcall(data, "getData", "()Landroid/net/Uri;");
  const uris: string[] = yield* clipUris(yield vcall(data, "getClipData", "()Landroid/content/ClipData;"));
  if (uri) uris.push(yield* awaited(uriText(uri)));
  for (const u of uris) grantUriPermission(pkg, u, flags);
});
export function revokeUriPermission(uri: string, modes: number): void {
  for (const grants of transientUriGrants.values()) {
    const remaining = (grants.get(uri) ?? 0) & ~(modes & 3);
    if (remaining & 3) grants.set(uri, remaining);
    else grants.delete(uri);
  }
}
export function checkUriPermission(u: string, uid: number, modes: number): number {
  if (uid === 0) return 0;
  const requested = modes & 3;
  if (!requested) return -1;
  if (uid === PROCESS_UID && uriGrants.all().some((grant) =>
    grantedUri(u, grant.uri, grant.flags) && (grant.flags & requested) === requested)) return 0;
  for (const pkg of transientUriGrants.keys()) {
    if (packages.get(pkg)?.uid !== uid) continue;
    if ((transientFlags(pkg, u) & requested) === requested) return 0;
  }
  return -1;
}
/** UriGrantsManagerService.takePersistableUriPermission for this app: a grant it was offered as
 *  persistable, or one it already persisted */
function takePersistable(u: string, modes: number): void {
  const requested = modes & 3;
  if (!requested) return;
  const all = uriGrants.all(), old = all.find((grant) => grant.uri === u);
  const offered = transientFlags(appHost?.pkg ?? "", u);
  if ((offered & (requested | PERSISTABLE_GRANT)) !== (requested | PERSISTABLE_GRANT) &&
    (!old || (old.flags & requested) !== requested))
    throw rt.mkThrowable("java/lang/SecurityException", "No persistable URI permission for " + u);
  const flags = (old?.flags ?? 0) | requested | (offered & PREFIX_GRANT);
  uriGrants.set([...all.filter((grant) => grant.uri !== u), { uri: u, flags, time: Date.now() }]);
}
function releasePersistable(u: string, modes: number): void {
  uriGrants.set(uriGrants.all().flatMap((grant) => {
    if (grant.uri !== u) return [grant];
    const flags = grant.flags & ~(modes & 3);
    return flags & 3 ? [{ ...grant, flags }] : [];
  }));
}
function* persistedPermissions(): Gen<JObj> {
  const permissions: JObj[] = [];
  for (const grant of uriGrants.all())
    permissions.push(yield newObj("android/content/UriPermission", "(Landroid/net/Uri;IJ)V", yield* awaited(mkUri(grant.uri)), grant.flags, BigInt(grant.time)));
  return newArrayList(permissions);
}

// IUriGrantsManager, under AOSP's ContentResolver: this app's persisted grants. Grants it made to
// others are not recorded, so it has no outgoing ones.
rt.register({ name: "webdroid/UriGrantsManagerService", ctor: class extends JObj {}, sup: "android/app/IUriGrantsManager$Stub", methods: {
  "takePersistableUriPermission(Landroid/net/Uri;ILjava/lang/String;I)V": (u: JUri | null, modes: number) => after(uriText(u), (uri) => takePersistable(uri, modes)),
  "releasePersistableUriPermission(Landroid/net/Uri;ILjava/lang/String;I)V": (u: JUri | null, modes: number) => after(uriText(u), (uri) => releasePersistable(uri, modes)),
  "getUriPermissions(Ljava/lang/String;ZZ)Landroid/content/pm/ParceledListSlice;": driven(function* (_pkg: string, incoming: number) {
    return yield newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", incoming ? yield* persistedPermissions() : yield newArrayList());
  }),
} });
hostStub("uri_grants", "webdroid/UriGrantsManagerService");
