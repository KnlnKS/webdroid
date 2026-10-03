// IStorageManager, under AOSP's StorageManager, StorageVolume and Environment: the reference AVD's
// one volume, emulated;0, the primary shared storage on internal storage (no fsUuid, so its storage
// UUID is UUID_DEFAULT), mounted and writable. Shared storage is /sdcard here, the vfs's, where the
// AVD mounts /storage/emulated/0 over /data/media. Space answers follow the browser's estimate.
import { awaited, rt, JObj, declaredField, driven, type Gen } from "../jvm/runtime";
import { jarray, mangleStaticField } from "../jvm/abi";
import { newObj, scall, linkInit } from "../jvm/natives/jlang";
import { systemResource } from "./resnative";
import { newFile } from "../jvm/natives/jio";
import { hostStub } from "./binder";
import { vfs } from "../shell/vfs";
import { storageEstimate, uuidDefault } from "./os";

const SHARED = "/sdcard", USER = 0;
const VI = "android/os/storage/VolumeInfo";
const bytes = (n: number) => BigInt(Math.floor(n));

const storageVolume = driven(function* storageVolume$(): Gen<JObj> {
  return newObj("android/os/storage/StorageVolume",
    "(Ljava/lang/String;Ljava/io/File;Ljava/io/File;Ljava/lang/String;ZZZZZJLandroid/os/UserHandle;Ljava/util/UUID;Ljava/lang/String;Ljava/lang/String;)V",
    "emulated;0", yield* awaited(newFile(SHARED)), yield* awaited(newFile(SHARED)), yield systemResource("string", "storage_internal", "getString", "(I)Ljava/lang/String;"),
    1, 0, 1, 0, 0, 0n, yield scall("android/os/UserHandle", "of", "(I)Landroid/os/UserHandle;", USER), uuidDefault(), null, "mounted");
});
const volumeInfo = driven(function* volumeInfo$(): Gen<JObj> {
  const statics = (yield* awaited(linkInit(VI))).ctor as Record<string, number>, flag = (name: string) => statics[mangleStaticField(name)];
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
  "getCacheQuotaBytes(Ljava/lang/String;I)J": driven(function* (): Gen { return bytes((yield* awaited(storageEstimate())).total / 20); }),
  "getCacheSizeBytes(Ljava/lang/String;I)J": () => 0n,
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
