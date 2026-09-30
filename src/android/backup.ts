import { JObj, rt, noops } from "../jvm/runtime";
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
