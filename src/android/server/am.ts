// ActivityManagerService for AOSP's ActivityThread: a process attaches, the service binds its
// application (ApplicationInfo and the process's providers from the package manager, the device
// configuration) and, for the package's own process, starts its launcher activity, as the home
// screen's launch would.
import { rt, JObj, declaredField } from "../../jvm/runtime";
import { newObj, vcall, scall, linkInit } from "../../jvm/natives/jlang";
import { mangleStaticField } from "../../jvm/abi";
import { newArrayList } from "../../jvm/natives/jcoll";
import { hostedService } from "../binder";
import { PROCESS_NAME, PROCESS_UID } from "../os";
import { appHost } from "../apphost";
import { configurations } from "./wm";
import { startMainActivity } from "./atm";
import { uptimeMillis } from "../../guest-clock";
import { systemProviderHolder } from "../settings";

const GET_SHARED_LIBRARY_FILES = 0x400n, GET_META_DATA = 0x80n;
const pms = () => hostedService("package") as Promise<JObj>;

let appThread: JObj | null = null, launcher = false;
/** whether this is the app the user launched, whose launcher activity starts with it */
export const userLaunched = (): boolean => launcher;
/** this process's IApplicationThread, once it attached */
export function thisApp(): JObj {
  if (!appThread) throw rt.mkThrowable("java/lang/IllegalStateException", "Process has not attached");
  return appThread;
}
let lane: Promise<unknown> = Promise.resolve();
/** a call on this process's IApplicationThread after those made before it, as the system server's
 *  calls reach a process in order; arguments may be pending */
export function scheduleOnApp(name: string, desc: string, ...args: unknown[]): Promise<void> {
  const call = lane.then(async () => { await vcall(thisApp(), name, desc, ...await Promise.all(args)); });
  lane = call.catch(() => {});
  return call;
}
export const compatInfo = async (): Promise<JObj> =>
  ((await linkInit("android/content/res/CompatibilityInfo")).ctor as Record<string, JObj>)[mangleStaticField("DEFAULT_COMPATIBILITY_INFO")];

async function bind(app: JObj): Promise<void> {
  const pkg = appHost!.pkg, process = PROCESS_NAME || pkg;
  appThread = app;
  const pm = await pms();
  const info = await vcall(pm, "getApplicationInfo", "(Ljava/lang/String;JI)Landroid/content/pm/ApplicationInfo;", pkg, GET_SHARED_LIBRARY_FILES, 0);
  const slice = await vcall(pm, "queryContentProviders", "(Ljava/lang/String;IJLjava/lang/String;)Landroid/content/pm/ParceledListSlice;", process, PROCESS_UID, GET_META_DATA, null);
  const providers = await scall("android/content/pm/ProviderInfoList", "fromList", "(Ljava/util/List;)Landroid/content/pm/ProviderInfoList;",
    slice ? await vcall(slice, "getList", "()Ljava/util/List;") : newArrayList());
  const { global } = await configurations();
  const compat = await compatInfo();
  const now = BigInt(Math.floor(uptimeMillis()));
  await vcall(app, "bindApplication",
    "(Ljava/lang/String;Landroid/content/pm/ApplicationInfo;Ljava/lang/String;Ljava/lang/String;ZLandroid/content/pm/ProviderInfoList;" +
    "Landroid/content/ComponentName;Landroid/app/ProfilerInfo;Landroid/os/Bundle;Landroid/app/IInstrumentationWatcher;Landroid/app/IUiAutomationConnection;" +
    "IZZZZLandroid/content/res/Configuration;Landroid/content/res/CompatibilityInfo;Ljava/util/Map;Landroid/os/Bundle;Ljava/lang/String;" +
    "Landroid/content/AutofillOptions;Landroid/content/ContentCaptureOptions;[J[JLandroid/os/SharedMemory;JJ)V",
    process, info, null, null, 0, providers, null, null, null, null, null, 0, 0, 0, 0, 0, global, compat, null,
    await newObj("android/os/Bundle", "()V"), "unknown", null, null, new BigInt64Array(0), new BigInt64Array(0), null, now, now);
  if (launcher) await startMainActivity(app, pkg);
}

// ContentProviders this process published, by authority, and system_server's. ActivityThread finds
// its own before it asks; a provider in another app process is not reachable yet, so it answers null
// as for an unknown one.
const published = new Map<string, JObj>();
const HOLDER = "android/app/ContentProviderHolder";
async function publishProviders(holders: JObj): Promise<void> {
  const count: number = await vcall(holders, "size", "()I");
  for (let i = 0; i < count; i++) {
    const holder: Record<string, unknown> = await vcall(holders, "get", "(I)Ljava/lang/Object;", i);
    if (!holder) continue;
    holder[declaredField(HOLDER, "noReleaseNeeded")] = 1;
    const authority = (holder[declaredField(HOLDER, "info")] as Record<string, string | null>)[declaredField("android/content/pm/ProviderInfo", "authority")];
    for (const name of authority?.split(";") ?? []) published.set(name, holder as unknown as JObj);
  }
}

/** the methods IActivityManager adds for ActivityThread */
export const activityManagerMethods = {
  "attachApplication(Landroid/app/IApplicationThread;J)V": (app: JObj) => bind(app),
  "finishAttachApplication(JJ)V": () => {},
  "publishContentProviders(Landroid/app/IApplicationThread;Ljava/util/List;)V": (_app: JObj, holders: JObj) => publishProviders(holders),
  "getContentProvider(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;IZ)Landroid/app/ContentProviderHolder;":
    (_app: JObj, _pkg: string, name: string) => published.get(name) ?? systemProviderHolder(name),
  "refContentProvider(Landroid/os/IBinder;II)Z": () => 1,
  "removeContentProvider(Landroid/os/IBinder;Z)V": () => {},
};

/** ActivityThread.main for this process: its thread attaches to the activity manager, which binds
 *  the application and, for the app the user launched, its launcher activity. A process started
 *  for another's component runs just that. The main looper is already running. */
export async function startActivityThread(launched: boolean): Promise<void> {
  launcher = launched;
  const thread = await newObj("android/app/ActivityThread", "()V");
  await vcall(thread, "attach", "(ZJ)V", 0, 0n);
}

// ActivityThread's natives: heapprofd never profiles this process, and the renderer holds no
// resources a trim could purge
rt.registerJnis("android/app/ActivityThread", {
  "nInitZygoteChildHeapProfiling()V": () => {},
  "nPurgePendingResources()V": () => {},
});
