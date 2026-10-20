import { JObj, rt, noops, stubs } from "../jvm/runtime.ts";
import { hostService } from "./binder.ts";
import { ownedHandle, release } from "./handles.ts";

// the native RestoreHelperBase a file helper allocates at construction; only a backup transport
// drives its backup and restore natives, and none is hosted
rt.registerJnis("android/app/backup/FileBackupHelperBase", {
  "ctor()J": () => ownedHandle(new JObj()),
  "dtor(J)V": release,
});

// IBackupManager, under AOSP's BackupManager: the service runs, as on the reference AVD, with
// backup disabled and no transport, so a data change is noted and nothing is scheduled
hostService("backup", "webdroid/BackupManagerService", "android/app/backup/IBackupManager$Stub", {
  ...noops("dataChanged(Ljava/lang/String;)V", "dataChangedForUser(ILjava/lang/String;)V"),
  ...stubs(0, "isBackupEnabled()Z", "isBackupEnabledForUser(I)Z"),
  "isBackupServiceActive(I)Z": () => 1,
});
