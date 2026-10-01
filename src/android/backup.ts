import { JObj, rt, noops, stubs } from "../jvm/runtime";
import { hostStub } from "./binder";
import { JContextWrapper } from "./context";
import { ownedHandle, release } from "./handles";

class JBackupAgent extends JContextWrapper {}
rt.register({
  name: "android/app/backup/BackupAgent", ctor: JBackupAgent, sup: "android/content/ContextWrapper",
  methods: noops("<init>()V"),
});

// the native RestoreHelperBase a file helper allocates at construction; only a backup transport
// drives its backup and restore natives, and none is hosted
rt.registerJnis("android/app/backup/FileBackupHelperBase", {
  "ctor()J": () => ownedHandle(new JObj()),
  "dtor(J)V": release,
});
rt.markers("android/app/backup/BackupHelper", "android/app/backup/RestoreObserver");

// IBackupManager, under AOSP's BackupManager: the service runs, as on the reference AVD, with
// backup disabled and no transport, so a data change is noted and nothing is scheduled
rt.register({ name: "webdroid/BackupManagerService", ctor: class extends JObj {}, sup: "android/app/backup/IBackupManager$Stub", methods: {
  ...noops("dataChanged(Ljava/lang/String;)V", "dataChangedForUser(ILjava/lang/String;)V"),
  ...stubs(0, "isBackupEnabled()Z", "isBackupEnabledForUser(I)Z"),
  "isBackupServiceActive(I)Z": () => 1,
} });
hostStub("backup", "webdroid/BackupManagerService");
