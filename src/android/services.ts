// System services hosted behind binder, each the TS half of AOSP's generated AIDL Stub: AOSP's
// managers run from bytecode over them (ActivityManager, AppTask, LoudnessCodecController,
// ScreenRecordingCallbacks), and a raw transaction reaches the Stub's own onTransact, so an unknown
// code (Shizuku's Sui probe) gets the Stub's answer. A method not implemented here is reported as
// missing by its AIDL name.
import { JObj, rt, noops, declaredField, type NativeSpec } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jutil";
import { appHost, jclsNameOf } from "./apphost";
import { type JComponentName, mkComponentName } from "./intent";
import type { JActivity } from "./app";
import { PROCESS_NAME, PROCESS_PID, PROCESS_UID } from "./os";
import { runningServices } from "./runningservices";
import { JConfigurationInfo } from "./pm";
import { deviceConfiguration } from "./resnative";
import { hostService } from "./binder";

class JRunningAppProcessInfo extends JObj {
  processName = ""; pid = PROCESS_PID; uid = PROCESS_UID; pkgList: string[] = [];
  importance = 100; lru = 0; lastTrimLevel = 0;
  importanceReasonCode = 0; importanceReasonPid = 0;
  importanceReasonComponent: JComponentName | null = null;
}
rt.register({
  name: "android/app/ActivityManager$RunningAppProcessInfo", ctor: JRunningAppProcessInfo, ifaces: ["android/os/Parcelable"],
  statics: {
    IMPORTANCE_FOREGROUND: 100, IMPORTANCE_FOREGROUND_SERVICE: 125, IMPORTANCE_VISIBLE: 200,
    IMPORTANCE_PERCEPTIBLE: 230, IMPORTANCE_SERVICE: 300, IMPORTANCE_TOP_SLEEPING: 325,
    IMPORTANCE_CANT_SAVE_STATE: 350, IMPORTANCE_CACHED: 400, IMPORTANCE_BACKGROUND: 400,
    IMPORTANCE_EMPTY: 500, IMPORTANCE_GONE: 1000,
    REASON_UNKNOWN: 0, REASON_PROVIDER_IN_USE: 1, REASON_SERVICE_IN_USE: 2,
  },
  fields: ["processName", "pid", "uid", "pkgList", "importance", "lru", "lastTrimLevel", "importanceReasonCode",
    "importanceReasonPid", "importanceReasonComponent"],
  methods: { "<init>()V": function () {} },
});
function fillProc<T extends JRunningAppProcessInfo>(p: T): T {
  const pkg = appHost?.pkg ?? "";
  p.processName = PROCESS_NAME || pkg; p.pkgList = [pkg];
  p.importance = appHost?.currentActivity() ? 100 : runningServices.size ? 300 : 400;
  return p;
}

class JRecentTaskInfo extends JObj {
  id = -1; persistentId = -1; taskId = -1; numActivities = 0; isRunning = 0;
  baseIntent: unknown = null;
  baseActivity: JComponentName | null = null; topActivity: JComponentName | null = null;
  origActivity: JComponentName | null = null; description: string | null = null;
}
rt.register({
  name: "android/app/ActivityManager$RecentTaskInfo", ctor: JRecentTaskInfo, ifaces: ["android/os/Parcelable"],
  fields: ["id", "persistentId", "taskId", "numActivities", "isRunning", "baseIntent", "baseActivity", "topActivity",
    "origActivity", "description"],
  methods: { "<init>()V": function () {} },
});

// IActivityManager: this process's view of the activity manager
const activityManager: NativeSpec["methods"] = {
  "getRunningAppProcesses()Ljava/util/List;": () => newArrayList([fillProc(new JRunningAppProcessInfo())]),
  "getMyMemoryState(Landroid/app/ActivityManager$RunningAppProcessInfo;)V": (info: JRunningAppProcessInfo) => { fillProc(info); },
  // the device profile's memory: the page cannot read the host's
  "getMemoryInfo(Landroid/app/ActivityManager$MemoryInfo;)V": (mi: { totalMem: bigint; availMem: bigint; lowMemory: number; threshold: bigint }) => {
    mi.totalMem = 4n << 30n; mi.availMem = 2n << 30n; mi.lowMemory = 0; mi.threshold = 128n << 20n;
  },
  "getProcessMemoryInfo([I)[Landroid/os/Debug$MemoryInfo;": (pids: Int32Array) =>
    jarray(Array.from(pids, () => rt.make("android/os/Debug$MemoryInfo")), "Landroid/os/Debug$MemoryInfo;"),
  "getServices(II)Ljava/util/List;": (max: number) => newArrayList([...runningServices.values()].slice(0, max)),
  // no exits or starts are recorded, and nothing restricts this app or drives it as a monkey
  "getHistoricalProcessExitReasons(Ljava/lang/String;III)Landroid/content/pm/ParceledListSlice;": () =>
    newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList()),
  "getHistoricalProcessStartReasons(Ljava/lang/String;II)Landroid/content/pm/ParceledListSlice;": () =>
    newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList()),
  "isBackgroundRestricted(Ljava/lang/String;)Z": () => 0,
  "isUserAMonkey()Z": () => 0,
};
rt.register({ name: "webdroid/ActivityManagerService", ctor: class extends JObj {}, sup: "android/app/IActivityManager$Stub", methods: activityManager });

// IAppTask: one of the caller's tasks, the activities the shell stacks under a task id
class JAppTask extends JObj { taskId = 0; }
rt.register({ name: "webdroid/AppTask", ctor: JAppTask, sup: "android/app/IAppTask$Stub", methods: {
  "getTaskInfo()Landroid/app/ActivityManager$RecentTaskInfo;": function (this: JAppTask) {
    const activities = (appHost?.activities() ?? []).filter((a) => a.taskId === this.taskId);
    const info = new JRecentTaskInfo(), component = (a: JActivity | undefined) => a ? mkComponentName(appHost?.pkg ?? "", jclsNameOf(a)) : null;
    info.id = info.persistentId = info.taskId = this.taskId;
    info.numActivities = activities.length;
    info.isRunning = activities.length ? 1 : 0;
    info.baseIntent = activities[0]?.intent ?? null;
    info.baseActivity = component(activities[0]);
    info.topActivity = component(activities.at(-1));
    return info;
  },
  "finishAndRemoveTask()V": function (this: JAppTask) { appHost?.finishTask(this.taskId); },
  // one task is shown at a time, and there are no recents to exclude it from
  "moveToFront(Landroid/app/IApplicationThread;Ljava/lang/String;)V": () => {},
  "setExcludeFromRecents(Z)V": () => {},
} });
const appTasks = new Map<number, Promise<JAppTask>>();

// IActivityTaskManager
rt.register({ name: "webdroid/ActivityTaskManagerService", ctor: class extends JObj {}, sup: "android/app/IActivityTaskManager$Stub", methods: {
  "getAppTasks(Ljava/lang/String;)Ljava/util/List;": async () => {
    const ids = [...new Set((appHost?.activities() ?? []).map((a) => a.taskId))];
    for (const id of appTasks.keys()) if (!ids.includes(id)) appTasks.delete(id);
    return newArrayList(await Promise.all(ids.map((taskId) => {
      let task = appTasks.get(taskId);
      if (!task) appTasks.set(taskId, task = newObj("webdroid/AppTask").then((t: JAppTask) => Object.assign(t, { taskId })));
      return task;
    })));
  },
  "getDeviceConfigurationInfo()Landroid/content/pm/ConfigurationInfo;": () => {
    rt.link("android/content/pm/ConfigurationInfo");
    const info = new JConfigurationInfo(), config = deviceConfiguration();
    info.reqTouchScreen = config.touchscreen; info.reqKeyboardType = config.keyboard; info.reqNavigation = config.navigation;
    info.reqGlEsVersion = 0x30000; return info;
  },
} });

hostService("activity", () => newObj("webdroid/ActivityManagerService"));
hostService("activity_task", () => newObj("webdroid/ActivityTaskManagerService"));

// IAudioService: codec loudness only. A codec's loudness parameters are the reference AVD's for its
// output (the speaker): the target reference level, and the DRC setting for the metadata type.
rt.register({ name: "webdroid/AudioService", ctor: class extends JObj {}, sup: "android/media/IAudioService$Stub", methods: {
  "getLoudnessParams(Landroid/media/LoudnessCodecInfo;)Landroid/os/PersistableBundle;": async (info: Record<string, number>) => {
    const bundle = await newObj("android/os/PersistableBundle"), type = info[declaredField("android/media/LoudnessCodecInfo", "metadataType")];
    await vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-target-ref-level", 64);
    if (type === 1) await vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-drc-heavy-compression", 1);
    if (type === 2) await vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-drc-effect-type", 3);
    return bundle;
  },
  // the output never changes, so no updated parameters are ever dispatched
  ...noops("registerLoudnessCodecUpdatesDispatcher(Landroid/media/ILoudnessCodecUpdatesDispatcher;)V",
    "unregisterLoudnessCodecUpdatesDispatcher(Landroid/media/ILoudnessCodecUpdatesDispatcher;)V", "startLoudnessCodecUpdates(I)V",
    "stopLoudnessCodecUpdates(I)V", "addLoudnessCodecInfo(IILandroid/media/LoudnessCodecInfo;)V",
    "removeLoudnessCodecInfo(ILandroid/media/LoudnessCodecInfo;)V"),
} });

// IWindowManager: what WindowManagerGlobal and screen recording callbacks ask of it. Animations run
// at the default duration scale, and nothing records the page, so a registration reports "not
// recorded" and that never changes.
rt.register({ name: "webdroid/WindowManagerService", ctor: class extends JObj {}, sup: "android/view/IWindowManager$Stub", methods: {
  "getCurrentAnimatorScale()F": () => 1,
  "registerScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)Z": () => 0,
  "unregisterScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)V": () => {},
} });

/** a Stub whose methods declare @EnforcePermission takes its enforcer at construction; these
 *  services never call it, as no method here is one that checks a permission */
const withEnforcer = async (cls: string) => newObj(cls, "(Landroid/os/PermissionEnforcer;)V", await newObj("android/os/PermissionEnforcer"));
hostService("audio", () => withEnforcer("webdroid/AudioService"));
hostService("window", () => withEnforcer("webdroid/WindowManagerService"));
