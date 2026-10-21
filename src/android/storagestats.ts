// IStorageStatsManager, under AOSP's StorageStatsManager: the one internal volume, measured off the
// VFS the way installd walks it, with StorageStatsService's checks (decoded from the reference
// AVD's services.jar): another uid's or the user's stats need PACKAGE_USAGE_STATS, which an app
// has only through its GET_USAGE_STATS app op; an unknown package is NameNotFoundException.
import { awaited, JObj, rt, setDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { after, newObj, vcall } from "../jvm/natives/jentry.ts";
import { vfs, contentSize, storageEstimate } from "../shell/vfs.ts";
import { packages } from "./packages.ts";
import { mimeOf } from "../mime.ts";
import { callingIdentity, hostService, serviceContext } from "./binder.ts";

/** bytes of every file under one of `dirs` that `keep` accepts */
function bytesUnder(dirs: string[], keep: (path: string) => boolean = () => true): bigint {
  let total = 0;
  const count = (path: string, size: number) => { if (dirs.some((dir) => path.startsWith(dir)) && keep(path)) total += size; };
  for (const [path, { content }] of vfs.entries()) if (content) count(path, contentSize(content));
  return BigInt(total);
}
const apkBytes = (pkgs: string[]) => pkgs.reduce((sum, pkg) => {
  const path = packages.get(pkg)?.path ?? "";
  return sum + BigInt(vfs.stat(path)?.size ?? 0);
}, 0n);
function storageStats(pkgs: string[]): JObj | Promise<JObj> {
  const own = (sub: string) => pkgs.flatMap((pkg) => [`/data/data/${pkg}/${sub}`, `/sdcard/Android/data/${pkg}/${sub}`]);
  return after(newObj("android/app/usage/StorageStats"), (stats) => setDeclared(stats, "android/app/usage/StorageStats", {
    codeBytes: apkBytes(pkgs), dataBytes: bytesUnder(own("")),
    cacheBytes: bytesUnder([...own("cache/"), ...pkgs.map((pkg) => `/data/data/${pkg}/code_cache/`)]),
    externalCacheBytes: bytesUnder(pkgs.map((pkg) => `/sdcard/Android/data/${pkg}/cache/`)),
  }));
}
const media = (kind: string) => (path: string) => mimeOf(path)?.startsWith(kind) ?? false;
function externalStats(): JObj | Promise<JObj> {
  return after(newObj("android/app/usage/ExternalStorageStats"), (stats) => setDeclared(stats, "android/app/usage/ExternalStorageStats", {
    totalBytes: bytesUnder(["/sdcard/"]), audioBytes: bytesUnder(["/sdcard/"], media("audio/")), videoBytes: bytesUnder(["/sdcard/"], media("video/")),
    imageBytes: bytesUnder(["/sdcard/"], media("image/")), appBytes: bytesUnder(["/sdcard/Android/data/"]), obbBytes: bytesUnder(["/sdcard/Android/obb/"]),
  }));
}

const OP_GET_USAGE_STATS = 43, MODE_ALLOWED = 0, MODE_DEFAULT = 3;
/** StorageStatsService.checkStatsPermission: null when the caller may read others' stats */
function* statsDenial(uid: number, pkg: string): Gen<string | null> {
  const context = yield* awaited(serviceContext());
  const appOps = yield vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "appops");
  const mode: number = yield vcall(appOps, "noteOp", "(IILjava/lang/String;)I", OP_GET_USAGE_STATS, uid, pkg);
  if (mode === MODE_ALLOWED) return null;
  if (mode !== MODE_DEFAULT) return `Package ${pkg} from UID ${uid} blocked by mode ${mode}`;
  return (yield vcall(context, "checkCallingOrSelfPermission", "(Ljava/lang/String;)I", "android.permission.PACKAGE_USAGE_STATS")) === 0 ? null
    : `Caller does not have android.permission.PACKAGE_USAGE_STATS; callingPackage=${pkg}, callingUid=${uid}`;
}
function* enforceStats(pkg: string): Gen<void> {
  const denial = yield* statsDenial(callingIdentity().uid, pkg);
  if (denial) throw rt.mkThrowable("java/lang/SecurityException", denial);
}
const uidPackages = (uid: number) => [...packages.values()].filter((record) => record.uid === uid).map((record) => record.pkg);
const S = "Ljava/lang/String;";
hostService("storagestats", "webdroid/StorageStatsService", "android/app/usage/IStorageStatsManager$Stub", {
  [`getTotalBytes(${S}${S})J`]: () => after(storageEstimate(), (e) => BigInt(Math.floor(e.total))),
  [`getFreeBytes(${S}${S})J`]: () => after(storageEstimate(), (e) => BigInt(Math.floor(e.free))),
  // the VFS keeps no per-uid quota, and vold reserves nothing
  [`isQuotaSupported(${S}${S})Z`]: () => 0,
  [`isReservedSupported(${S}${S})Z`]: () => 0,
  [`queryStatsForPackage(${S}${S}I${S})Landroid/app/usage/StorageStats;`]: driven(function* (_volume: string | null, pkg: string, _user: number, caller: string) {
    const record = packages.get(pkg);
    if (!record) {
      const missing = rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      throw yield newObj("android/os/ParcelableException", "(Ljava/lang/Throwable;)V", missing);
    }
    if (record.uid !== callingIdentity().uid) yield* enforceStats(caller);
    return storageStats([pkg]);
  }),
  [`queryStatsForUid(${S}I${S})Landroid/app/usage/StorageStats;`]: driven(function* (_volume: string | null, uid: number, caller: string) {
    if (uid !== callingIdentity().uid) yield* enforceStats(caller);
    return storageStats(uidPackages(uid));
  }),
  [`queryStatsForUser(${S}I${S})Landroid/app/usage/StorageStats;`]: driven(function* (_volume: string | null, _user: number, caller: string) {
    yield* enforceStats(caller);
    return storageStats([...packages.keys()]);
  }),
  [`queryExternalStatsForUser(${S}I${S})Landroid/app/usage/ExternalStorageStats;`]: driven(function* (_volume: string | null, _user: number, caller: string) {
    yield* enforceStats(caller);
    return externalStats();
  }),
});
