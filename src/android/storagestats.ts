// android.app.usage.StorageStatsManager: the one internal volume, measured off the VFS the way
// installd walks it.

import { JObj, rt, fieldGetters, stubs, driven, type Gen } from "../jvm/runtime";
import { vfs } from "../shell/vfs";
import { packages } from "./packages";
import { mimeOf } from "./mediastore";
import { storageEstimate } from "./os";

/** bytes of every file under one of `dirs` that `keep` accepts */
function bytesUnder(dirs: string[], keep: (path: string) => boolean = () => true): bigint {
  let total = 0;
  const count = (path: string, size: number) => { if (dirs.some((dir) => path.startsWith(dir)) && keep(path)) total += size; };
  for (const [path, bytes] of vfs.files) count(path, bytes.length);
  for (const [path, source] of vfs.lazyFiles) count(path, source.size);
  return BigInt(total);
}
const apkBytes = (pkgs: string[]) => pkgs.reduce((sum, pkg) => {
  const path = packages.get(pkg)?.path ?? "";
  return sum + BigInt(vfs.files.get(path)?.length ?? vfs.lazyFiles.get(path)?.size ?? 0);
}, 0n);
class JStorageStats extends JObj { app = 0n; data = 0n; cache = 0n; externalCache = 0n; }
function storageStats(pkgs: string[]): JStorageStats {
  const stats: JStorageStats = rt.make("android/app/usage/StorageStats");
  const own = (sub: string) => pkgs.flatMap((pkg) => [`/data/data/${pkg}/${sub}`, `/sdcard/Android/data/${pkg}/${sub}`]);
  stats.app = apkBytes(pkgs); stats.data = bytesUnder(own(""));
  stats.cache = bytesUnder([...own("cache/"), ...pkgs.map((pkg) => `/data/data/${pkg}/code_cache/`)]);
  stats.externalCache = bytesUnder(pkgs.map((pkg) => `/sdcard/Android/data/${pkg}/cache/`));
  return stats;
}
rt.register({
  name: "android/app/usage/StorageStats", ctor: JStorageStats, ifaces: ["android/os/Parcelable"],
  methods: fieldGetters({ "getAppBytes()J": "app", "getDataBytes()J": "data", "getCacheBytes()J": "cache", "getExternalCacheBytes()J": "externalCache" }),
});
class JExternalStorageStats extends JObj { total = 0n; audio = 0n; video = 0n; image = 0n; app = 0n; obb = 0n; }
rt.register({
  name: "android/app/usage/ExternalStorageStats", ctor: JExternalStorageStats, ifaces: ["android/os/Parcelable"],
  methods: fieldGetters({ "getTotalBytes()J": "total", "getAudioBytes()J": "audio", "getVideoBytes()J": "video",
    "getImageBytes()J": "image", "getAppBytes()J": "app", "getObbBytes()J": "obb" }),
});
const media = (kind: string) => (path: string) => mimeOf(path)?.startsWith(kind) ?? false;
rt.register({
  name: "android/app/usage/StorageStatsManager", ctor: class extends JObj {},
  methods: {
    "getTotalBytes(Ljava/util/UUID;)J": driven(function* (): Gen { return BigInt(Math.floor((yield storageEstimate()).total)); }),
    "getFreeBytes(Ljava/util/UUID;)J": driven(function* (): Gen { return BigInt(Math.floor((yield storageEstimate()).free)); }),
    ...stubs(0, "isQuotaSupported(Ljava/util/UUID;)Z", "isReservedSupported(Ljava/util/UUID;)Z"),
    "queryStatsForPackage(Ljava/util/UUID;Ljava/lang/String;Landroid/os/UserHandle;)Landroid/app/usage/StorageStats;": (_uuid: unknown, pkg: string) => {
      if (!packages.has(pkg)) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      return storageStats([pkg]);
    },
    "queryStatsForUid(Ljava/util/UUID;I)Landroid/app/usage/StorageStats;": (_uuid: unknown, uid: number) =>
      storageStats([...packages.values()].filter((record) => record.uid === uid).map((record) => record.pkg)),
    "queryStatsForUser(Ljava/util/UUID;Landroid/os/UserHandle;)Landroid/app/usage/StorageStats;": () => storageStats([...packages.keys()]),
    "queryExternalStatsForUser(Ljava/util/UUID;Landroid/os/UserHandle;)Landroid/app/usage/ExternalStorageStats;": () => {
      const stats: JExternalStorageStats = rt.make("android/app/usage/ExternalStorageStats");
      stats.total = bytesUnder(["/sdcard/"]);
      stats.audio = bytesUnder(["/sdcard/"], media("audio/")); stats.video = bytesUnder(["/sdcard/"], media("video/"));
      stats.image = bytesUnder(["/sdcard/"], media("image/"));
      stats.app = bytesUnder(["/sdcard/Android/data/"]); stats.obb = bytesUnder(["/sdcard/Android/obb/"]);
      return stats;
    },
  },
});
