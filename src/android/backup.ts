import { JObj, rt } from "../jvm/runtime";
import { JContextWrapper } from "./context";

class JBackupAgent extends JContextWrapper {}
rt.register({
  name: "android/app/backup/BackupAgent", ctor: JBackupAgent, sup: "android/content/ContextWrapper",
  methods: { "<init>()V": function () {}, "onCreate()V": function () {}, "onDestroy()V": function () {} },
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
rt.register({
  name: "android/app/backup/BackupManager", ctor: class extends JObj {},
  methods: {
    "<init>(Landroid/content/Context;)V": function () {},
    "dataChanged()V": function () {},
    "static dataChanged(Ljava/lang/String;)V": function () {},
    "requestRestore(Landroid/app/backup/RestoreObserver;)I": () => -1,
    "isBackupEnabled()Z": () => 0,
  },
});
rt.markers("android/app/backup/BackupHelper", "android/app/backup/RestoreObserver");
