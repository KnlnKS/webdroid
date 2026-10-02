// ActivityManagerService for AOSP's ActivityThread: a process attaches, the service binds its
// application (ApplicationInfo and the process's providers from the package manager, the device
// configuration) and, for the package's own process, starts its launcher activity, as the home
// screen's launch would.
import { rt, JObj, declaredField, driven, type Gen } from "../../jvm/runtime";
import { newObj, vcall, scall, linkInit } from "../../jvm/natives/jlang";
import { mangleStaticField } from "../../jvm/abi";
import { newArrayList } from "../../jvm/natives/jcoll";
import { hostedService } from "../binder";
import { PROCESS_NAME, PROCESS_UID } from "../os";
import { appHost } from "../apphost";
import { configurations } from "./wm";
import { startMainActivity } from "./atm";
import { uptimeMillis } from "../../guest-clock";
import { systemProviderHolder } from "../systemproviders";
import { checkUriPermission, grantUriPermission, revokeUriPermission } from "../urigrants";
import type { JUri } from "../net";

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

// ContentProviders this process published, by authority. ActivityThread finds its own before it
// asks; system_server's come from their hosts, and another process's from that process through the
// broker, which starts it and waits for the publication as a ContentProviderRecord does.
type Publication = ReturnType<typeof Promise.withResolvers<JObj>>;
const published = new Map<string, JObj>(), publications = new Map<string, Publication>();
const HOLDER = "android/app/ContentProviderHolder", PROVIDER_INFO = "android/content/pm/ProviderInfo";
const APP_INFO = "android/content/pm/ApplicationInfo", COMPONENT_INFO = "android/content/pm/ComponentInfo";
/** ContentResolver.CONTENT_PROVIDER_READY_TIMEOUT_MILLIS: how long a publication is waited for */
const PROVIDER_WAIT_MS = 20_000;
function publication(authority: string): Publication {
  let pending = publications.get(authority);
  if (!pending) publications.set(authority, pending = Promise.withResolvers());
  return pending;
}
const publishProviders = driven(function* (holders: JObj): Gen<void> {
  const count: number = yield vcall(holders, "size", "()I");
  for (let i = 0; i < count; i++) {
    const holder: Record<string, unknown> = yield vcall(holders, "get", "(I)Ljava/lang/Object;", i);
    if (!holder) continue;
    holder[declaredField(HOLDER, "noReleaseNeeded")] = 1;
    const authority = (holder[declaredField(HOLDER, "info")] as Record<string, string | null>)[declaredField(PROVIDER_INFO, "authority")];
    for (const name of authority?.split(";") ?? []) {
      published.set(name, holder as unknown as JObj);
      publication(name).resolve(holder as unknown as JObj);
    }
  }
});
/** the IContentProvider binder this process publishes for an authority, for a caller in another
 *  process; null when it is not published in time */
export async function publishedProvider(authority: string): Promise<JObj | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const holder = await Promise.race([publication(authority).promise, new Promise<null>((resolve) => { timer = setTimeout(resolve, PROVIDER_WAIT_MS, null); })]);
  clearTimeout(timer);
  return holder && (holder as Record<string, JObj>)[declaredField(HOLDER, "provider")];
}
/** the broker's: the binder another process publishes for an authority, starting that process */
export const providerProcesses: { get: (pkg: string, process: string, authority: string) => Promise<JObj | null> } = { get: async () => null };

/** getContentProviderImpl: system_server's provider, this process's own, or a holder for the
 *  package manager's: a local one (newHolder(null, true)) when it may run here, multiprocess or
 *  this process's with its uid, which ActivityThread instantiates rather than waiting for a
 *  publication; otherwise the binder its own process published, which the broker waits for */
const contentProvider = driven(function* (name: string, userId: number): Gen<JObj | null> {
  const own = published.get(name) ?? (yield systemProviderHolder(name));
  if (own) return own;
  const info: Record<string, unknown> | null = yield vcall(yield pms(), "resolveContentProvider", "(Ljava/lang/String;JI)Landroid/content/pm/ProviderInfo;", name, GET_SHARED_LIBRARY_FILES, userId);
  if (!info) return null;
  const app = info[declaredField(COMPONENT_INFO, "applicationInfo")] as Record<string, unknown>;
  const process = info[declaredField(COMPONENT_INFO, "processName")] as string;
  const holder: Record<string, unknown> = yield newObj(HOLDER, "(Landroid/content/pm/ProviderInfo;)V", info);
  if (app[declaredField(APP_INFO, "uid")] === PROCESS_UID && (info[declaredField(PROVIDER_INFO, "multiprocess")] || process === (PROCESS_NAME || appHost!.pkg))) {
    holder[declaredField(HOLDER, "mLocal")] = 1;
    return holder as unknown as JObj;
  }
  const binder = yield providerProcesses.get(app[declaredField(APP_INFO, "packageName")] as string, process, name);
  if (!binder) return null;
  holder[declaredField(HOLDER, "provider")] = yield scall("android/content/ContentProviderNative", "asInterface", "(Landroid/os/IBinder;)Landroid/content/IContentProvider;", binder);
  return holder as unknown as JObj;
});

/** the methods IActivityManager adds for ActivityThread */
export const activityManagerMethods = {
  "attachApplication(Landroid/app/IApplicationThread;J)V": (app: JObj) => bind(app),
  "finishAttachApplication(JJ)V": () => {},
  "publishContentProviders(Landroid/app/IApplicationThread;Ljava/util/List;)V": (_app: JObj, holders: JObj) => publishProviders(holders),
  "getContentProvider(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;IZ)Landroid/app/ContentProviderHolder;":
    (_app: JObj, _pkg: string, name: string, userId: number) => contentProvider(name, userId),
  // a provider's process lives until it dies, which its binder's holders learn from the broker
  "refContentProvider(Landroid/os/IBinder;II)Z": () => 1,
  "removeContentProvider(Landroid/os/IBinder;Z)V": () => {},
  "unstableProviderDied(Landroid/os/IBinder;)V": () => {},
  // ContextImpl's URI permissions, held by UriGrantsManagerService
  "checkUriPermission(Landroid/net/Uri;IIIILandroid/os/IBinder;)I": (uri: JUri, pid: number, uid: number, modes: number) => checkUriPermission(uri, pid, uid, modes),
  "grantUriPermission(Landroid/app/IApplicationThread;Ljava/lang/String;Landroid/net/Uri;II)V": (_app: JObj, pkg: string, uri: JUri, modes: number) => grantUriPermission(pkg, uri, modes),
  "revokeUriPermission(Landroid/app/IApplicationThread;Ljava/lang/String;Landroid/net/Uri;II)V": (_app: JObj, _pkg: string, uri: JUri, modes: number) => revokeUriPermission(uri, modes),
};

/** ActivityThread.main for this process: its thread attaches to the activity manager, which binds
 *  the application and, for the app the user launched, its launcher activity. A process started
 *  for another's component runs just that. The main looper is already running. */
export async function startActivityThread(launched: boolean): Promise<void> {
  launcher = launched;
  const AT = "android/app/ActivityThread";
  await scall(AT + "$AndroidOs", "install", "()V");
  await scall("dalvik/system/CloseGuard", "setEnabled", "(Z)V", 0);
  await scall("android/os/Environment", "initForCurrentUser", "()V");
  await scall("com/android/org/conscrypt/TrustedCertificateStore", "setDefaultUserDirectory", "(Ljava/io/File;)V",
    await scall("android/os/Environment", "getUserConfigDirectory", "(I)Ljava/io/File;", await scall("android/os/UserHandle", "myUserId", "()I")));
  await scall(AT, "initializeMainlineModules", "()V");
  await scall("android/os/Process", "setArgV0", "(Ljava/lang/String;)V", "<pre-initialized>");
  const thread = await newObj(AT, "()V");
  await vcall(thread, "attach", "(ZJ)V", 0, 0n);
  const statics = (await linkInit(AT)).ctor as Record<string, unknown>;
  statics[mangleStaticField("sMainThreadHandler")] ??= await vcall(thread, "getHandler", "()Landroid/os/Handler;");
}

// ActivityThread's natives: heapprofd never profiles this process, and the renderer holds no
// resources a trim could purge
// Activity.getDlWarning: the linker records no warning for a library an app loads
rt.registerJni("android/app/Activity", "getDlWarning()Ljava/lang/String;", () => null);
rt.registerJnis("android/app/ActivityThread", {
  "nInitZygoteChildHeapProfiling()V": () => {},
  "nPurgePendingResources()V": () => {},
});
