import { JObj, rt, noops, stubs } from "../jvm/runtime";
import { JContextWrapper } from "./context";

class JBackupAgent extends JContextWrapper {}
rt.register({
  name: "android/app/backup/BackupAgent", ctor: JBackupAgent, sup: "android/content/ContextWrapper",
  methods: noops("<init>()V", "onCreate()V", "onDestroy()V"),
});

class JBackupAgentHelper extends JBackupAgent { helpers = new Map<string, unknown>(); }
rt.register({
  name: "android/app/backup/BackupAgentHelper", ctor: JBackupAgentHelper, sup: "android/app/backup/BackupAgent",
  methods: {
    "<init>()V": function () {},
    "addHelper(Ljava/lang/String;Landroid/app/backup/BackupHelper;)V": function (this: JBackupAgentHelper, prefix: string, helper: unknown) {
      if (!prefix || !helper) throw rt.mkThrowable("java/lang/NullPointerException", "prefix and helper are required");
      this.helpers.set(prefix, helper);
    },
  },
});

rt.register({
  name: "android/app/backup/SharedPreferencesBackupHelper", ctor: class extends JObj {}, ifaces: ["android/app/backup/BackupHelper"],
  methods: { "<init>(Landroid/content/Context;[Ljava/lang/String;)V": function () {} },
});
class JFileBackupHelper extends JObj {
  context: JContextWrapper | null = null;
  files: string[] = [];
}
rt.register({
  name: "android/app/backup/FileBackupHelper", ctor: JFileBackupHelper, ifaces: ["android/app/backup/BackupHelper"],
  methods: {
    "<init>(Landroid/content/Context;[Ljava/lang/String;)V": function (this: JFileBackupHelper, context: JContextWrapper, files: string[]) {
      this.context = context;
      this.files = files.slice();
    },
  },
});
rt.register({
  name: "android/app/backup/BackupManager", ctor: class extends JObj {},
  methods: {
    ...noops("<init>(Landroid/content/Context;)V", "dataChanged()V", "static dataChanged(Ljava/lang/String;)V"),
    ...stubs(-1, "requestRestore(Landroid/app/backup/RestoreObserver;)I"),
    ...stubs(0, "isBackupEnabled()Z"),
  },
});
rt.markers("android/app/backup/BackupHelper", "android/app/backup/RestoreObserver");
