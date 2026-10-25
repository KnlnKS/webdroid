// UriGrantsManagerService: the device's URI grants, held in system_server's realm. A grant is made to
// a package and kept by its uid; one the package takes as persistable is install state, kept under
// the package's own key. A Worker's ActivityManager and ActivityStarter grant and check through the
// broker, which answers here as the calling process.
import { callingIdentity, hostService } from "../binder.ts";
import { awaited, rt, JObj, driven, type Gen } from "../../jvm/runtime.ts";
import { type JUri, clipUris, mkUri, uriParts, uriText } from "../net.ts";
import { procIdentity } from "../../shell/procfs.ts";
import { newObj, after, vcall } from "../../jvm/natives/jentry.ts";
import { newArrayList } from "../../jvm/natives/jcoll.ts";
import { attrStr, type XmlNode } from "../axml.ts";
import { ownedBy, packages, uidPackages } from "../packages.ts";
import { checkUidPermission } from "../permissions.ts";
import { exported, resolveProvider } from "../pm.ts";
import { systemProviders } from "../systemproviders.ts";
import { broker, remoteSystem } from "../../shell/broker-access.ts";
import type { PackageState } from "../../shell/packagedata.ts";
import { persisted } from "../../shell/device-storage.ts";
export type UriGrantCalls = {
  check(uri: string, uid: number, modes: number): number | Promise<number>;
  /** the caller grants `targetPkg` each of `uris` it needs, or is refused with a SecurityException */
  grant(targetPkg: string, uris: string[], modes: number): void | Promise<void>;
  revoke(targetPkg: string | null, uri: string, modes: number): void | Promise<void>;
};
type PersistedUriGrant = { uri: string; flags: number; time: number };
const READ_WRITE = 3, PERSISTABLE_GRANT = 0x40, PREFIX_GRANT = 0x80;
/** the grants each package took as persistable, which survive a reboot */
const savedGrants = persisted("wd:uri-grants:", (saved) => Array.isArray(saved) ? saved.flatMap((entry): PersistedUriGrant[] => {
  if (typeof entry === "string") return [{ uri: entry, flags: 3 | (entry.includes("/tree/") ? PREFIX_GRANT : 0), time: 0 }];
  if (entry && typeof entry === "object" && "uri" in entry && typeof entry.uri === "string" &&
    "flags" in entry && typeof entry.flags === "number")
    return [{ uri: entry.uri, flags: entry.flags, time: "time" in entry && typeof entry.time === "number" ? entry.time : 0 }];
  return [];
}) : null);
/** removeUriPermissionsForPackage's persisted share: the grants the package holds, which a clear
 *  that keeps the package's state keeps */
export const uriGrantData: PackageState = {
  clear(pkg, _uid, how) { if (!how.keepState) savedGrants.remove(pkg); },
  packages: () => savedGrants.packages(),
};
const persistedGrants = (pkg: string): PersistedUriGrant[] => savedGrants.get(pkg) ?? [];

/** the grants made to each uid: by uri, the package each was made to and its modes */
const granted = new Map<number, Map<string, { pkg: string; modes: number }>>();
const covers = (target: string, uri: string, modes: number) =>
  target === uri || ((modes & PREFIX_GRANT) !== 0 && target.startsWith(uri + "/"));
/** the grants to `uid` covering `uri` */
const covering = (uri: string, uid: number) => [...granted.get(uid) ?? []].flatMap(([g, grant]) => covers(uri, g, grant.modes) ? [grant] : []);
/** grantUriPermissionUnchecked: `pkg`'s uid may use `uri` under `modes` */
export function grantUriPermission(pkg: string, uri: string, modes: number): void {
  const uid = packages.get(pkg)?.uid;
  if (uid === undefined || !(modes & READ_WRITE)) return;
  let grants = granted.get(uid);
  if (!grants) granted.set(uid, grants = new Map());
  grants.set(uri, { pkg, modes: (grants.get(uri)?.modes ?? 0) | (modes & (READ_WRITE | PREFIX_GRANT | PERSISTABLE_GRANT)) });
}
/** the grants of `uri` and the uris under it lose `modes`: every uid's, or `uid`'s alone; to `pkg` alone when named */
export function revokeUriPermission(uri: string, modes: number, pkg: string | null = null, uid?: number): void {
  for (const [holder, grants] of granted) {
    if (uid !== undefined && holder !== uid) continue;
    for (const [g, grant] of grants) {
      if (!covers(g, uri, PREFIX_GRANT) || pkg !== null && grant.pkg !== pkg) continue;
      const remaining = grant.modes & ~(modes & READ_WRITE);
      if (remaining & READ_WRITE) grant.modes = remaining;
      else grants.delete(g);
    }
  }
}
/** UriGrantsManagerService.checkUriPermission: root, or grants (or a persisted one) covering every mode asked for */
export function checkUriPermission(uri: string, uid: number, modes: number): number {
  if (uid === 0) return 0;
  const requested = modes & READ_WRITE;
  if (!requested) return -1;
  if ((covering(uri, uid).reduce((m, grant) => m | grant.modes, 0) & requested) === requested) return 0;
  return uidPackages(uid).some((p) => persistedGrants(p.pkg).some((grant) =>
    covers(uri, grant.uri, grant.flags) && (grant.flags & requested) === requested)) ? 0 : -1;
}

/** what a grant reads of the provider of an authority: its owner and export, its permissions, and the
 *  paths it lets be granted (grantUriPermissions, or its grant-uri-permission patterns) */
type GrantProvider = { name: string; uid: number; exported: boolean; read: string | null; write: string | null; grants: (path: string) => boolean };
function grantProvider(authority: string): GrantProvider | null {
  const system = systemProviders.get(authority);
  if (system) return { name: `${system.pkg}/${system.cls}`, uid: 1000, exported: true, read: null, write: null, grants: () => !!system.grantUriPermissions };
  const c = resolveProvider(authority);
  if (!c) return null;
  const permission = attrStr(c.node, "permission"), allowed = c.owner.flag(c.node, "grantUriPermissions", false);
  const patterns = c.node.children.filter((n) => n.name === "grant-uri-permission").map(pathMatcher);
  return { name: `${c.owner.pkg}/${c.name}`, uid: c.owner.uid, exported: exported(c), read: attrStr(c.node, "readPermission") ?? permission,
    write: attrStr(c.node, "writePermission") ?? permission, grants: (path) => patterns.length ? patterns.some((match) => match(path)) : allowed };
}
/** a grant-uri-permission's PatternMatcher: its path, pathPrefix or pathPattern */
function pathMatcher(n: XmlNode): (path: string) => boolean {
  const path = attrStr(n, "path"), prefix = attrStr(n, "pathPrefix"), glob = attrStr(n, "pathPattern");
  if (path !== null) return (p) => p === path;
  if (prefix !== null) return (p) => p.startsWith(prefix);
  if (glob === null) return () => false;
  // PATTERN_SIMPLE_GLOB: '.' is any character, '*' repeats the one before it, '\' escapes the next
  const re = new RegExp(`^${glob.replace(/\\(.)|([.*])|(.)/gs, (_, escaped?: string, op?: string, c?: string) =>
    op ?? (escaped ?? c)!.replace(/[\\^$.*+?()[\]{}|/]/, "\\$&"))}$`, "s");
  return (p) => re.test(p);
}
/** checkHoldingPermissions: `uid` reaches the provider's uris itself, owning it or, exported, holding the permissions `modes` need */
function* holds(p: GrantProvider, uid: number, modes: number): Gen<boolean> {
  if (p.uid === uid) return true;
  if (!p.exported) return false;
  for (const [mode, permission] of [[1, p.read], [2, p.write]] as const)
    if (modes & mode && permission !== null && (yield* awaited(checkUidPermission(permission, uid))) !== 0) return false;
  return true;
}
/** checkGrantUriPermission for each uri, then grantUriPermissionUnchecked: `source` grants `targetPkg`
 *  each uri it does not reach itself, which the provider must let be granted and `source` must reach */
function* grantFrom(source: number, targetPkg: string, uris: string[], modes: number): Gen<void> {
  const target = packages.get(targetPkg)?.uid;
  if (target === undefined || !(modes & READ_WRITE)) return;
  const needed: string[] = [];
  for (const uri of uris) {
    const { authority, segments } = uriParts(uri), p = uri.startsWith("content://") ? grantProvider(authority) : null;
    if (!p || !(modes & (PERSISTABLE_GRANT | PREFIX_GRANT)) && (yield* holds(p, target, modes))) continue;
    if (!p.grants("/" + segments.join("/")))
      throw rt.mkThrowable("java/lang/SecurityException", `Provider ${p.name} does not allow granting of Uri permissions (uri ${uri})`);
    if (!(yield* holds(p, source, modes)) && checkUriPermission(uri, source, modes) !== 0)
      throw rt.mkThrowable("java/lang/SecurityException", `Uid ${source} does not have permission to uri ${uri}`);
    needed.push(uri);
  }
  for (const uri of needed) grantUriPermission(targetPkg, uri, modes);
}
/** UriGrantsManagerService.revokeUriPermission: a caller reaching the uri through its provider revokes
 *  every grant of it (to `targetPkg` alone when named); another, only those made to it */
function* revokeFrom(caller: number, targetPkg: string | null, uri: string, modes: number): Gen<void> {
  const p = grantProvider(uriParts(uri).authority);
  if (p && (yield* holds(p, caller, modes))) revokeUriPermission(uri, modes, targetPkg);
  else if (p) revokeUriPermission(uri, modes, null, caller);
}
/** UriGrantsManagerInternal's calls, made as the uid `source` answers */
export const uriGrantCommands = (source: () => number): UriGrantCalls => ({
  check: checkUriPermission,
  grant: (targetPkg, uris, modes) => rt.drive(grantFrom(source(), targetPkg, uris, modes)),
  revoke: (targetPkg, uri, modes) => rt.drive(revokeFrom(source(), targetPkg, uri, modes)),
});
const ownGrants = uriGrantCommands(() => procIdentity.uid);
/** UriGrantsManagerInternal: this realm's, or system_server's from a Worker */
export const uriGrants = (): UriGrantCalls => remoteSystem() ? broker().uriGrants : ownGrants;
/** checkGrantUriPermissionFromIntent: the caller grants `targetPkg` the intent's data and ClipData
 *  uris under its grant flags */
export function* grantIntentUris$(targetPkg: string, intent: JObj): Gen<void> {
  const flags: number = yield vcall(intent, "getFlags", "()I");
  if (!(flags & 3)) return;
  const uri: JUri | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  const uris: string[] = yield* clipUris(yield vcall(intent, "getClipData", "()Landroid/content/ClipData;"));
  if (uri) uris.push(yield* awaited(uriText(uri)));
  if (uris.length) yield* awaited(uriGrants().grant(targetPkg, uris, flags));
}

/** takePersistableUriPermission for `uid`: a grant it was offered as persistable, or one it already persisted */
function takePersistable(u: string, modes: number, uid: number): void {
  const requested = modes & READ_WRITE;
  if (!requested) return;
  const offers = covering(u, uid), offered = offers.reduce((m, grant) => m | grant.modes, 0);
  const pkg = (offered & (requested | PERSISTABLE_GRANT)) === (requested | PERSISTABLE_GRANT) ? offers[0].pkg
    : uidPackages(uid).find((p) => persistedGrants(p.pkg).some((grant) => grant.uri === u && (grant.flags & requested) === requested))?.pkg;
  if (!pkg) throw rt.mkThrowable("java/lang/SecurityException", "No persistable URI permission for " + u);
  const all = persistedGrants(pkg), old = all.find((grant) => grant.uri === u);
  const flags = (old?.flags ?? 0) | requested | (offered & PREFIX_GRANT);
  savedGrants.set(pkg, [...all.filter((grant) => grant.uri !== u), { uri: u, flags, time: Date.now() }]);
}
function releasePersistable(u: string, modes: number, uid: number): void {
  for (const { pkg } of uidPackages(uid)) savedGrants.set(pkg, persistedGrants(pkg).flatMap((grant) => {
    if (grant.uri !== u) return [grant];
    const flags = grant.flags & ~(modes & READ_WRITE);
    return flags & READ_WRITE ? [{ ...grant, flags }] : [];
  }));
}
function* persistedPermissions(pkg: string): Gen<JObj> {
  const permissions: JObj[] = [];
  for (const grant of persistedGrants(pkg))
    permissions.push(yield newObj("android/content/UriPermission", "(Landroid/net/Uri;IJ)V", yield* awaited(mkUri(grant.uri)), grant.flags, BigInt(grant.time)));
  return newArrayList(permissions);
}

// IUriGrantsManager, under AOSP's ContentResolver: the persisted grants of the caller's packages.
// Grants they made to others are not listed, so none has outgoing ones.
hostService("uri_grants", "webdroid/UriGrantsManagerService", "android/app/IUriGrantsManager$Stub", {
  "takePersistableUriPermission(Landroid/net/Uri;ILjava/lang/String;I)V": (u: JUri | null, modes: number) => {
    const { uid } = callingIdentity();
    return after(uriText(u), (uri) => takePersistable(uri, modes, uid));
  },
  "releasePersistableUriPermission(Landroid/net/Uri;ILjava/lang/String;I)V": (u: JUri | null, modes: number) => {
    const { uid } = callingIdentity();
    return after(uriText(u), (uri) => releasePersistable(uri, modes, uid));
  },
  "getUriPermissions(Ljava/lang/String;ZZ)Landroid/content/pm/ParceledListSlice;": driven(function* (pkg: string, incoming: number) {
    const { uid } = callingIdentity();
    if (!ownedBy(pkg, uid)) throw rt.mkThrowable("java/lang/SecurityException", `Package ${pkg} does not belong to calling UID ${uid}`);
    return yield newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", incoming ? yield* persistedPermissions(pkg) : yield newArrayList());
  }),
}, { system: true });
