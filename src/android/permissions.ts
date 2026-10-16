// The permission controller: which permissions a package or uid holds, as PermissionManagerService
// checks them, the runtime grants an app's request (GrantPermissionsActivity) records, and
// IPermissionManager over them.
import { awaited, JObj, rt, noops, driven, type Gen } from "../jvm/runtime";
import { jarray, sameBytes } from "../jvm/abi";
import { after, vcall, newObj } from "../jvm/natives/jentry";
import { newArrayList } from "../jvm/natives/jcoll";
import { type XmlNode, attrStr, attr } from "./axml";
import { appHost } from "./apphost";
import { registerSystemActivity, newIntent, putExtra, type JIntent } from "./intent";
import { PackageRecord, packages, signaturePermissions, storedPackages, usesSdk } from "./packages";
import { hostStub } from "./binder";
import { permissionInfo$ } from "./pm";

/**
 * A runtime permission is DENIED until the app asks for it, which is the state a freshly
 * installed app is in — reporting a blanket grant sends an app straight past the fallback it
 * was written to take. Install-time permissions stay granted, as the platform grants them.
 * AOSP's dangerous groups, by their permission names.
 */
const RUNTIME_PERMISSIONS = new Set(["READ_CALENDAR", "WRITE_CALENDAR", "READ_CALL_LOG", "WRITE_CALL_LOG",
  "PROCESS_OUTGOING_CALLS", "CAMERA", "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS",
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "RECORD_AUDIO",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "ADD_VOICEMAIL",
  "USE_SIP", "ACCEPT_HANDOVER", "BODY_SENSORS", "ACTIVITY_RECOGNITION", "SEND_SMS", "RECEIVE_SMS",
  "READ_SMS", "RECEIVE_WAP_PUSH", "RECEIVE_MMS", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE",
  "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "POST_NOTIFICATIONS",
  "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "BLUETOOTH_ADVERTISE", "NEARBY_WIFI_DEVICES"]
  .map((n) => "android.permission." + n));
export class PermissionStore {
  private grants = new Map<string, Set<string>>();
  get(pkg: string): Set<string> {
    let grants = this.grants.get(pkg);
    if (!grants) {
      grants = new Set(); this.grants.set(pkg, grants);
      try {
        const saved: unknown = JSON.parse(globalThis.localStorage?.getItem("wd:permissions:" + pkg) ?? "[]");
        if (Array.isArray(saved)) for (const value of saved) if (typeof value === "string") grants.add(value);
      } catch { /* corrupt permission state remains denied */ }
    }
    return grants;
  }
  /** the packages with grants persisted */
  packages(): string[] { return storedPackages("wd:permissions:"); }
  /** a package's data clear: resetRuntimePermissions, every runtime grant the package's requests made */
  clear(pkg: string) {
    this.grants.delete(pkg);
    try { globalThis.localStorage?.removeItem("wd:permissions:" + pkg); } catch { /* storage can be unavailable */ }
  }
  grant(pkg: string, names: string[]) {
    const grants = this.get(pkg); for (const name of names) grants.add(name);
    globalThis.localStorage?.setItem("wd:permissions:" + pkg, JSON.stringify([...grants]));
  }
}
let permissionStore = new PermissionStore();
export interface PermissionAccess {
  permissionCheck(pkg: string, names: string[]): boolean[] | Promise<boolean[]>;
  permissionGrant(pkg: string, names: string[]): void | Promise<void>;
}
export type PermissionCalls = {
  [K in keyof PermissionAccess]: (...args: Parameters<PermissionAccess[K]>) => Promise<Awaited<ReturnType<PermissionAccess[K]>>>;
};
export function canonicalPermissionCommands(store: PermissionStore, authorize: (pkg: string) => void): PermissionAccess {
  return {
    permissionCheck: (pkg, names) => names.map(name => permissionHeld(store, pkg, name)),
    permissionGrant: (pkg, names) => { authorize(pkg); store.grant(pkg, names); },
  };
}
let permissionAccess = canonicalPermissionCommands(permissionStore, () => {});
export function usePermissionStore(store: PermissionStore) {
  permissionStore = store;
  permissionAccess = canonicalPermissionCommands(store, () => {});
}
export function usePermissionAccess(access: PermissionCalls): void { permissionAccess = access; }
/** signature|appop|pre23 permissions, the special access a user grants in Settings: held at install
 *  by a requesting app targeting below 23 or a system one, otherwise once granted on its screen */
const SPECIAL_ACCESS = new Set(["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.WRITE_SETTINGS"]);
// granted by the app's own request, or to a system package by the default grant policy
export const isRuntimePermission = (name: string): boolean => RUNTIME_PERMISSIONS.has(name);
function permissionHeld(store: PermissionStore, pkg: string, name: string): boolean {
  const record = packages.get(pkg);
  if (SPECIAL_ACCESS.has(name)) return !!record && (record.grants.has(name) || record.permissions.has(name) && (record.system || record.sdk.target < 23 || store.get(pkg).has(name)));
  return !RUNTIME_PERMISSIONS.has(name) || store.get(pkg).has(name) || !!record?.grants.has(name);
}
export const permissionsGranted = (pkg: string, names: string[]): boolean[] | Promise<boolean[]> => permissionAccess.permissionCheck(pkg, names);
export const permissionGranted = (pkg: string, name: string): boolean | Promise<boolean> =>
  RUNTIME_PERMISSIONS.has(name) || SPECIAL_ACCESS.has(name) ? after(permissionsGranted(pkg, [name]), values => values[0]) : permissionHeld(permissionStore, pkg, name);
/** whether a package holds a platform permission no third-party app is granted at install: it is a
 *  system package that requests it (privileged or preinstalled), or the special access above */
export const holdsPlatformPermission = (pkg: string, name: string): boolean => {
  const record = packages.get(pkg);
  if (SPECIAL_ACCESS.has(name)) return permissionHeld(permissionStore, pkg, name);
  return !!record && (record.grants.has(name) || record.system && record.permissions.has(name));
};
export function grantPermissions(names: string[]): Int32Array | Promise<Int32Array> {
  const pkg = appHost?.pkg ?? "", record = packages.get(pkg);
  // an app targeting below Android 13 cannot ask for POST_NOTIFICATIONS: the system prompts for it (notification.ts)
  const asked = record && usesSdk(record.root).target < 33 ? names.filter((name) => name !== "android.permission.POST_NOTIFICATIONS") : names;
  return after(permissionAccess.permissionGrant(pkg, asked), () =>
    after(permissionsGranted(pkg, names), values => Int32Array.from(values, value => value ? 0 : -1)));
}
/** a permission the system's own prompt asked for, answered by the same policy */
export const grantPrompted = (pkg: string, name: string): void | Promise<void> => permissionAccess.permissionGrant(pkg, [name]);
// GrantPermissionsActivity, which Activity.requestPermissions starts: asking grants, and the
// answer is the names with their results
const PERMISSIONS = "android.content.pm.extra.REQUEST_PERMISSIONS_";
registerSystemActivity("android.content.pm.action.REQUEST_PERMISSIONS", driven(function* (intent: JIntent): Gen<JIntent> {
  const names: string[] = (yield vcall(intent, "getStringArrayExtra", "(Ljava/lang/String;)[Ljava/lang/String;", PERMISSIONS + "NAMES")) ?? jarray([], "Ljava/lang/String;");
  const result = yield* awaited(newIntent());
  yield putExtra(result, PERMISSIONS + "NAMES", names, "[Ljava/lang/String;");
  yield putExtra(result, PERMISSIONS + "RESULTS", yield* awaited(grantPermissions([...names])), "[I");
  return result;
}));
// Settings' "Display over other apps" list, which the app asking for it opens (the package an
// intent names is not preselected since Android 11), answered by the same policy for that app
registerSystemActivity("android.settings.action.MANAGE_OVERLAY_PERMISSION", driven(function* (): Gen<null> {
  const pkg = appHost?.pkg ?? "", name = "android.permission.SYSTEM_ALERT_WINDOW";
  if (packages.get(pkg)?.permissions.has(name)) yield* awaited(grantPrompted(pkg, name));
  return null;
}));
const declaration = (owner: PackageRecord, name: string) => owner.root.children.find((n) => n.name === "permission" && attrStr(n, "name") === name);
const declaredPermission = (name: string): [PackageRecord, XmlNode] | null => {
  for (const owner of packages.values()) {
    const node = declaration(owner, name);
    if (node) return [owner, node];
  }
  return null;
};
/** PERMISSION_GRANTED (0) or PERMISSION_DENIED (-1) for a package */
export function checkPermission(permission: string, pkg: string): number | Promise<number> {
  const record = packages.get(pkg);
  if (record?.grants.has(permission)) return 0;
  if (!record?.permissions.has(permission)) return -1;
  if (signaturePermissions.has(permission)) return signerHolds(record, permission);
  return after(permissionGranted(pkg, permission), granted => granted ? 0 : -1);
}
/** a signature permission: held when the package is signed as the one declaring it */
async function signerHolds(record: PackageRecord, permission: string): Promise<number> {
  const certificates = await record.certificates();
  for (const owner of packages.values()) {
    if (!declaration(owner, permission)) continue;
    const signers = await owner.certificates();
    if (certificates.length && certificates.length === signers.length && certificates.every((c, i) => sameBytes(c, signers[i]))) return 0;
  }
  return -1;
}
/** a declared permission's protectionLevel, or null when no package declares it */
export const protectionLevel = (name: string): number | null => {
  const declared = declaredPermission(name);
  return declared ? attr(declared[1], "protectionLevel")?.data ?? 0 : null;
};

/** PermissionManagerService.checkUidPermission: root and system hold every permission; an app's uid
 *  holds one a package with that uid holds */
export function checkUidPermission(name: string, uid: number): number | Promise<number> {
  if (uid === 0 || uid === 1000) return 0;
  const pending: Promise<number>[] = [];
  for (const record of packages.values()) if (record.uid === uid) {
    const result = checkPermission(name, record.pkg);
    if (result === 0) return 0;
    if (result instanceof Promise) pending.push(result);
  }
  return pending.length ? Promise.all(pending).then((results) => results.includes(0) ? 0 : -1) : -1;
}

/** SystemConfig's split permissions (a permission requested below a target SDK implies the newer
 *  one), as the reference AVD lists them through IPermissionManager.getSplitPermissions */
const S = "Ljava/lang/String;";
const permissionName = (name: string) => name.includes(".") ? name : "android.permission." + name;
const SPLIT_PERMISSIONS: [string, number, string][] = [
  ["ACCESS_FINE_LOCATION", 10001, "ACCESS_COARSE_LOCATION"], ["WRITE_EXTERNAL_STORAGE", 10001, "READ_EXTERNAL_STORAGE"],
  ["READ_CONTACTS", 16, "READ_CALL_LOG"], ["WRITE_CONTACTS", 16, "WRITE_CALL_LOG"],
  ["ACCESS_FINE_LOCATION", 29, "ACCESS_BACKGROUND_LOCATION"], ["ACCESS_COARSE_LOCATION", 29, "ACCESS_BACKGROUND_LOCATION"],
  ["READ_EXTERNAL_STORAGE", 29, "ACCESS_MEDIA_LOCATION"], ["WRITE_EXTERNAL_STORAGE", 29, "ACCESS_MEDIA_LOCATION"],
  ...["BLUETOOTH", "BLUETOOTH_ADMIN"].flatMap((name) => ["SCAN", "CONNECT", "ADVERTISE"].map((added): [string, number, string] => [name, 31, "BLUETOOTH_" + added])),
  ["BODY_SENSORS", 33, "BODY_SENSORS_BACKGROUND"],
  ...["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"].flatMap((name) => ["AUDIO", "VIDEO", "IMAGES"].map((added): [string, number, string] => [name, 33, "READ_MEDIA_" + added])),
  ["READ_MEDIA_IMAGES", 10001, "READ_MEDIA_VISUAL_USER_SELECTED"], ["READ_MEDIA_VIDEO", 10001, "READ_MEDIA_VISUAL_USER_SELECTED"],
  ["ACCESS_MEDIA_LOCATION", 10001, "READ_MEDIA_VISUAL_USER_SELECTED"], ["com.google.android.gms.permission.ACTIVITY_RECOGNITION", 29, "ACTIVITY_RECOGNITION"],
];
rt.register({ name: "webdroid/PermissionManagerService", ctor: class extends JObj {}, sup: "android/permission/IPermissionManager$Stub", methods: {
  [`checkPermission(${S}${S}${S}I)I`]: (pkg: string, permission: string) => checkPermission(permission, pkg),
  [`checkUidPermission(I${S}I)I`]: (uid: number, permission: string) => checkUidPermission(permission, uid),
  [`getPermissionInfo(${S}${S}I)Landroid/content/pm/PermissionInfo;`]: driven(function* getPermissionInfo$(name: string, _caller: string, flags: number): Gen {
    const declared = declaredPermission(name);
    return declared ? yield* permissionInfo$(declared[0], declared[1], flags) : null;
  }),
  // no device policy is installed to revoke anything
  [`isPermissionRevokedByPolicy(${S}${S}II)Z`]: () => 0,
  // PermissionManagerServiceImpl answers FLAG_PERMISSION_USER_SET for a permission not held; a
  // request is never denied here, so no permission carries it
  [`shouldShowRequestPermissionRationale(${S}${S}II)Z`]: () => 0,
  "getSplitPermissions()Ljava/util/List;": driven(function* getSplitPermissions$(): Gen {
    const splits: JObj[] = [];
    for (const [name, target, added] of SPLIT_PERMISSIONS) splits.push(yield newObj("android/content/pm/permission/SplitPermissionInfoParcelable",
      `(${S}Ljava/util/List;I)V`, permissionName(name), yield newArrayList([permissionName(added)]), target));
    return newArrayList(splits);
  }),
  ...noops("addOnPermissionsChangeListener(Landroid/permission/IOnPermissionsChangeListener;)V",
    "removeOnPermissionsChangeListener(Landroid/permission/IOnPermissionsChangeListener;)V"),
} });
hostStub("permissionmgr", "webdroid/PermissionManagerService");
// PermissionManager holds a LegacyPermissionManager from construction; none of its identifier
// checks is answered yet, so each reports itself missing when reached
rt.register({ name: "webdroid/LegacyPermissionManagerService", ctor: class extends JObj {}, sup: "android/permission/ILegacyPermissionManager$Stub" });
hostStub("legacy_permission", "webdroid/LegacyPermissionManagerService");
