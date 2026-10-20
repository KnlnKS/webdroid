// IStorageManager, under AOSP's StorageManager, StorageVolume and Environment: the reference AVD's
// one volume, emulated;0, the primary shared storage on internal storage (no fsUuid, so its storage
// UUID is UUID_DEFAULT), mounted and writable. Shared storage is /sdcard here, the vfs's, where the
// AVD mounts /storage/emulated/0 over /data/media. Space answers follow the browser's estimate.
import { awaited, rt, JObj, declaredField, driven, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, scall, linkInit } from "../jvm/natives/jentry.ts";
import { systemResource } from "./resnative.ts";
import { newFile } from "../jvm/natives/jio.ts";
import { hostStub } from "./binder.ts";
import { vfs, storageEstimate } from "../shell/vfs.ts";
import { uuidDefault } from "./os.ts";
import { packages } from "./packages.ts";
import { logLine } from "../native/kernel.ts";

const SHARED = "/sdcard", USER = 0;
const VI = "android/os/storage/VolumeInfo";
const bytes = (n: number) => BigInt(Math.floor(n));

/** StorageManagerService validates the package/user path; vold repairs each existing
 * app-directory component and its immediate entries, without creating a missing target. */
function fixupAppDir(path: string): void {
  const match = /^\/storage\/([^/]+)\/(?:(\d+)\/)?Android\/(data|media|obb|sandbox)\/([^/]+)(\/.*)?$/i.exec(path);
  const failed = (message: string) => logLine(6,"StorageManagerService",message);
  if (!match || path.split("/").some(part => part === "." || part === "..")) { failed("Path " + path + " is not a valid application-specific directory");return; }
  if (match[2] === undefined) { failed("Asked to fixup an app dir without a userId: " + path);return; }
  const user = Number(match[2]), pkg = packages.get(match[4]);
  if (!Number.isSafeInteger(user) || !pkg || Math.floor(pkg.uid / 100000) !== user) { failed("Couldn't find package to fixup app dir " + path);return; }
  if (match[1] !== "emulated" || user !== USER || !["data","media","obb"].includes(match[3])) { failed("Failed to fixup app dir on an unavailable volume: " + path);return; }
  const dir = vfs.norm(path);
  if (!vfs.exists(dir)) return;
  if (!vfs.isDir(dir)) { failed("Failed to fixup app dir: " + path);return; }
  const root = `${SHARED}/Android/${match[3]}/${match[4]}`, gid = match[3] === "data" ? 1078 : match[3] === "obb" ? 1079 : 1023;
  const attributes = {uid:pkg.uid,gid,mode:0o2770};
  let at = root;
  const suffix = dir.slice(root.length).split("/").filter(Boolean);
  for (let i = 0; i <= suffix.length; i++) {
    if (i) at += "/" + suffix[i-1];
    vfs.setAttributes(at,attributes);
    for (const name of vfs.list(at)) vfs.setAttributes(at + "/" + name,attributes);
  }
}

const storageVolume = driven(function* storageVolume$(): Gen<JObj> {
  return newObj("android/os/storage/StorageVolume",
    "(Ljava/lang/String;Ljava/io/File;Ljava/io/File;Ljava/lang/String;ZZZZZJLandroid/os/UserHandle;Ljava/util/UUID;Ljava/lang/String;Ljava/lang/String;)V",
    "emulated;0", yield* awaited(newFile(SHARED)), yield* awaited(newFile(SHARED)), yield systemResource("string", "storage_internal", "getString", "(I)Ljava/lang/String;"),
    1, 0, 1, 0, 0, 0n, yield scall("android/os/UserHandle", "of", "(I)Landroid/os/UserHandle;", USER), yield uuidDefault(), null, "mounted");
});
const volumeInfo = driven(function* volumeInfo$(): Gen<JObj> {
  const volume = yield* awaited(linkInit(VI)), flag = (name: string) => volume.static(name) as number;
  const info: Record<string, unknown> = yield newObj(VI, "(Ljava/lang/String;ILandroid/os/storage/DiskInfo;Ljava/lang/String;)V",
    "emulated;0", flag("TYPE_EMULATED"), null, "");
  for (const [name, value] of Object.entries({ mountFlags: flag("MOUNT_FLAG_PRIMARY") | flag("MOUNT_FLAG_VISIBLE_FOR_WRITE"),
    mountUserId: USER, state: flag("STATE_MOUNTED"), path: SHARED, internalPath: SHARED })) info[declaredField(VI, name)] = value;
  return info;
});

rt.register({ name: "webdroid/StorageManagerService", ctor: class extends JObj {}, sup: "android/os/storage/IStorageManager$Stub", methods: {
  "getVolumeList(ILjava/lang/String;I)[Landroid/os/storage/StorageVolume;": driven(function* (): Gen {
    return jarray([yield* awaited(storageVolume())], "Landroid/os/storage/StorageVolume;");
  }),
  "getVolumes(I)[Landroid/os/storage/VolumeInfo;": driven(function* (): Gen { return jarray([yield* awaited(volumeInfo())], `L${VI};`); }),
  "getPrimaryStorageUuid()Ljava/lang/String;": () => null,
  "isCeStorageUnlocked(I)Z": (user: number) => +(user === USER),
  "getAllocatableBytes(Ljava/lang/String;ILjava/lang/String;)J": driven(function* (): Gen { return bytes((yield* awaited(storageEstimate())).free); }),
  // StorageManagerService frees cache when the request exceeds free space; the vfs holds none to free
  "allocateBytes(Ljava/lang/String;JILjava/lang/String;)V": driven(function* (_volume: string | null, want: bigint): Gen {
    const free = bytes((yield* awaited(storageEstimate())).free);
    if (want <= free) return;
    const failed = rt.mkThrowable("java/io/IOException", `Failed to allocate ${want} because only ${free} allocatable`);
    throw yield newObj("android/os/ParcelableException", "(Ljava/lang/Throwable;)V", failed);
  }),
  "getCacheQuotaBytes(Ljava/lang/String;I)J": driven(function* (): Gen { return bytes((yield* awaited(storageEstimate())).total / 20); }),
  "getCacheSizeBytes(Ljava/lang/String;I)J": () => 0n,
  "fixupAppDir(Ljava/lang/String;)V": fixupAppDir,
  // vold creates an app's own external data, obb and media directories for it, and nothing else
  "mkdirs(Ljava/lang/String;Ljava/lang/String;)V": (pkg: string, path: string) => {
    const dir = vfs.norm(path);
    if (!["data", "obb", "media"].some((kind) => `${dir}/`.startsWith(`${SHARED}/Android/${kind}/${pkg}/`)))
      throw rt.mkThrowable("java/lang/SecurityException", `Invalid mkdirs path: ${path}`);
    for (let i = SHARED.length; i >= 0; i = dir.indexOf("/", i + 1)) vfs.mkdir(dir.slice(0, i));
    vfs.mkdir(dir);
  },
} });
hostStub("mount", "webdroid/StorageManagerService");
// android_os_storage_StorageManager: the vfs keeps no project quotas, so FS_IOC_FSGETXATTR fails
rt.registerJni("android/os/storage/StorageManager", "setQuotaProjectId(Ljava/lang/String;J)Z", () => 0);
