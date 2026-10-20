// ActivityManagerService for AOSP's ActivityThread: a process attaches, the service binds its
// application (ApplicationInfo and the process's providers from the package manager, the device
// configuration) and, for the package's own process, starts its launcher activity, as the home
// screen's launch would.
import { awaited, rt, JObj, getDeclared, setDeclared, driven, type Gen } from "../../jvm/runtime.ts";
import { newObj, vcall, scall, linkInit, after, staticField, callOn, curThread } from "../../jvm/natives/jentry.ts";
import { newArrayList } from "../../jvm/natives/jcoll.ts";
import { hostedService } from "../binder.ts";
import { PROCESS_UID, processName } from "../os.ts";
import { appHost } from "../apphost.ts";
import { configurations } from "./wm.ts";
import { startMainActivity } from "./atm.ts";
import { uptimeMillis } from "../../guest-clock.ts";
import { systemProviderHolder } from "../systemproviders.ts";
import { checkUriPermission, grantUriPermission, revokeUriPermission } from "../urigrants.ts";
import { uriText, type JUri } from "../net.ts";
import { systemFontMap } from "../fonts.ts";
import { appCrashed, queryExitRecords, noteApplicationFlags, setProcessStateSummary, type ExitRecord } from "./appexitinfo.ts";
import { callingIdentity, newStub, parceledList } from "../binder.ts";
import { packages, GET_SHARED_LIBRARY_FILES, GET_URI_PERMISSION_PATTERNS, MATCH_DIRECT_BOOT_AUTO } from "../packages.ts";
import { checkUidPermission } from "../permissions.ts";
import { mkPfd } from "../os.ts";
import { clearUserData } from "../appdata.ts";
import { COMPAT_CHANGES } from "../compat-changes.ts";

/** ActivityManagerService.STOCK_PM_FLAGS, what its package queries ask for */
export const STOCK_PM_FLAGS = BigInt(GET_SHARED_LIBRARY_FILES);
/** ContentProviderHelper.generateApplicationProvidersLocked's query: STOCK_PM_FLAGS, GET_URI_PERMISSION_PATTERNS and
 *  MATCH_DIRECT_BOOT_AUTO, without meta-data (a provider asks for its own) */
const APP_PROVIDER_FLAGS = BigInt(GET_SHARED_LIBRARY_FILES | GET_URI_PERMISSION_PATTERNS | MATCH_DIRECT_BOOT_AUTO);
/** the package manager, as system_server's services reach it */
export const pms = () => hostedService("package") as Promise<JObj>;
/** a component of `pkg` in `process` runs in this process */
export const runsHere = (pkg: string, process: string): boolean => pkg === appHost?.pkg && process === processName();

let appThread: JObj | null = null, launcher = false;
/** whether this is the app the user launched, whose launcher activity starts with it */
export const userLaunched = (): boolean => launcher;
export const attached = (): boolean => appThread !== null;
/** this process's IApplicationThread, once it attached */
export function thisApp(): JObj {
  if (!appThread) throw rt.mkThrowable("java/lang/IllegalStateException", "Process has not attached");
  return appThread;
}
let lane: Promise<unknown> = Promise.resolve();
/** a call on this process's IApplicationThread after those made before it, as the system server's
 *  calls reach a process in order; arguments may be pending */
export function scheduleOnApp(name: string, desc: string, ...args: unknown[]): Promise<void> {
  const thread = curThread;
  const call = lane.then(() => Promise.all(args)).then((ready) => callOn(thread, () => vcall(thisApp(), name, desc, ...ready)));
  lane = call.catch(() => {});
  return call;
}
/** PlatformCompat.getDisabledChanges: the changes the device disables for an app targeting `target`,
 *  sorted, as AppCompatCallbacks binary-searches them */
const disabledChanges = (target: number) =>
  BigInt64Array.from(Object.entries(COMPAT_CHANGES).flatMap(([id, since]) => target < since ? [BigInt(id)] : [])).sort();
export const compatInfo = () => staticField<JObj>("android/content/res/CompatibilityInfo", "DEFAULT_COMPATIBILITY_INFO");

const bind = driven(function* (app: JObj): Gen<void> {
  const pkg = appHost!.pkg, process = processName();
  appThread = app;
  const pm = yield* awaited(pms());
  const info = yield vcall(pm, "getApplicationInfo", "(Ljava/lang/String;JI)Landroid/content/pm/ApplicationInfo;", pkg, STOCK_PM_FLAGS, 0);
  noteApplicationFlags(getDeclared(info, APP_INFO, "flags"));
  const slice = yield vcall(pm, "queryContentProviders", "(Ljava/lang/String;IJLjava/lang/String;)Landroid/content/pm/ParceledListSlice;", process, PROCESS_UID, APP_PROVIDER_FLAGS, null);
  const providers = yield scall("android/content/pm/ProviderInfoList", "fromList", "(Ljava/util/List;)Landroid/content/pm/ProviderInfoList;",
    slice ? yield vcall(slice, "getList", "()Ljava/util/List;") : yield newArrayList());
  const { global } = yield* awaited(configurations());
  const compat = yield* awaited(compatInfo());
  const now = BigInt(Math.floor(uptimeMillis()));
  yield vcall(app, "bindApplication",
    "(Ljava/lang/String;Landroid/content/pm/ApplicationInfo;Ljava/lang/String;Ljava/lang/String;ZLandroid/content/pm/ProviderInfoList;" +
    "Landroid/content/ComponentName;Landroid/app/ProfilerInfo;Landroid/os/Bundle;Landroid/app/IInstrumentationWatcher;Landroid/app/IUiAutomationConnection;" +
    "IZZZZLandroid/content/res/Configuration;Landroid/content/res/CompatibilityInfo;Ljava/util/Map;Landroid/os/Bundle;Ljava/lang/String;" +
    "Landroid/content/AutofillOptions;Landroid/content/ContentCaptureOptions;[J[JLandroid/os/SharedMemory;JJ)V",
    process, info, null, null, 0, providers, null, null, null, null, null, 0, 0, 0, 0, 0, global, compat, null,
    yield newObj("android/os/Bundle", "()V"), "unknown", null, null,
    disabledChanges(getDeclared(info, APP_INFO, "targetSdkVersion")), new BigInt64Array(0), yield* systemFontMap(), now, now);
  if (launcher) yield startMainActivity(app, pkg);
});

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
    const holder: JObj | null = yield vcall(holders, "get", "(I)Ljava/lang/Object;", i);
    if (!holder) continue;
    setDeclared(holder, HOLDER, { noReleaseNeeded: 1 });
    const authority = getDeclared<string | null>(getDeclared(holder, HOLDER, "info"), PROVIDER_INFO, "authority");
    for (const name of authority?.split(";") ?? []) {
      published.set(name, holder);
      publication(name).resolve(holder);
    }
  }
});
/** the IContentProvider binder this process publishes for an authority, for a caller in another
 *  process; null when it is not published in time */
export async function publishedProvider(authority: string): Promise<JObj | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const holder = await Promise.race([publication(authority).promise, new Promise<null>((resolve) => { timer = setTimeout(resolve, PROVIDER_WAIT_MS, null); })]);
  clearTimeout(timer);
  return holder && getDeclared<JObj>(holder, HOLDER, "provider");
}
/** the broker's: the binder another process publishes for an authority, starting that process */
export const providerProcesses: { get: (pkg: string, process: string, authority: string) => JObj | null | Promise<JObj | null> } = { get: () => null };

/** getContentProviderImpl: system_server's provider, this process's own, or a holder for the
 *  package manager's: a local one (newHolder(null, true)) when it may run here, multiprocess or
 *  this process's with its uid, which ActivityThread instantiates rather than waiting for a
 *  publication; otherwise the binder its own process published, which the broker waits for */
const contentProvider = driven(function* (name: string, userId: number): Gen<JObj | null> {
  const own = published.get(name) ?? (yield* awaited(systemProviderHolder(name)));
  if (own) return own;
  const info: JObj | null = yield vcall(yield* awaited(pms()), "resolveContentProvider", "(Ljava/lang/String;JI)Landroid/content/pm/ProviderInfo;", name, STOCK_PM_FLAGS, userId);
  if (!info) return null;
  const app = getDeclared<JObj>(info, COMPONENT_INFO, "applicationInfo"), process = getDeclared<string>(info, COMPONENT_INFO, "processName");
  const holder: JObj = yield newObj(HOLDER, "(Landroid/content/pm/ProviderInfo;)V", info);
  if (getDeclared(app, APP_INFO, "uid") === PROCESS_UID && (getDeclared(info, PROVIDER_INFO, "multiprocess") || process === processName()))
    return setDeclared(holder, HOLDER, { mLocal: 1 });
  const binder = yield* awaited(providerProcesses.get(getDeclared(app, APP_INFO, "packageName"), process, name));
  if (!binder) return null;
  return setDeclared(holder, HOLDER, { provider: yield scall("android/content/ContentProviderNative", "asInterface", "(Landroid/os/IBinder;)Landroid/content/IContentProvider;", binder) });
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
  "checkUriPermission(Landroid/net/Uri;IIIILandroid/os/IBinder;)I": (uri: JUri | null, _pid: number, uid: number, modes: number) =>
    after(uriText(uri), (u) => checkUriPermission(u, uid, modes)),
  "grantUriPermission(Landroid/app/IApplicationThread;Ljava/lang/String;Landroid/net/Uri;II)V": (_app: JObj, pkg: string, uri: JUri | null, modes: number) =>
    after(pkg ? uriText(uri) : rt.npe(), (u) => grantUriPermission(pkg, u, modes)),
  "revokeUriPermission(Landroid/app/IApplicationThread;Ljava/lang/String;Landroid/net/Uri;II)V": (_app: JObj, _pkg: string, uri: JUri | null, modes: number) =>
    after(uriText(uri), (u) => revokeUriPermission(u, modes)),
  // Log.wtf's report, which RuntimeInit sends after logging it: with Settings.Global wtf_is_fatal
  // unset, ActivityManagerService records it and the process lives
  "handleApplicationWtf(Landroid/os/IBinder;Ljava/lang/String;ZLandroid/app/ApplicationErrorReport$ParcelableCrashInfo;I)Z": () => 0,
  // KillApplicationHandler's report before the process kills itself
  "handleApplicationCrash(Landroid/os/IBinder;Landroid/app/ApplicationErrorReport$ParcelableCrashInfo;)V": (_app: JObj | null, info: JObj | null) => {
    const field = <T>(name: string) => (info ? getDeclared<T>(info, CRASH_INFO, name) : null);
    appCrashed({ exceptionClassName: field("exceptionClassName"), exceptionMessage: field("exceptionMessage"),
      throwFileName: field("throwFileName"), throwLineNumber: field<number>("throwLineNumber") ?? 0, stackTrace:field("stackTrace") }, false);
  },
  "setProcessStateSummary([B)V": (state: Int8Array | null) => {
    if (state && state.length > MAX_STATE_SUMMARY) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Data size is too large");
    setProcessStateSummary(state && new Uint8Array(state.buffer, state.byteOffset, state.length));
  },
  // the package's own uid clears its data; another's needs CLEAR_APP_USER_DATA
  "clearApplicationUserData(Ljava/lang/String;ZLandroid/content/pm/IPackageDataObserver;I)Z": driven(function* (pkg: string | null, keepState: number, observer: JObj | null): Gen<number> {
    const { pid, uid } = callingIdentity(), record = pkg === null ? undefined : packages.get(pkg);
    if (record?.uid !== uid && (yield* awaited(checkUidPermission(CLEAR_APP_USER_DATA, uid))) !== 0)
      throw rt.mkThrowable("java/lang/SecurityException", `PID ${pid} does not have permission ${CLEAR_APP_USER_DATA} to clear data of package ${pkg}`);
    if (!record) console.warn("[ActivityManager] Invalid packageName: " + pkg);
    yield clearUserData(pkg ?? "", record?.uid === uid, !!keepState, observer);
    return record ? 1 : 0;
  }),
  "getHistoricalProcessExitReasons(Ljava/lang/String;III)Landroid/content/pm/ParceledListSlice;": driven(function* (pkg: string | null, pid: number, maxNum: number): Gen<JObj> {
    const uid = callingIdentity().uid;
    const owner = pkg === null ? uid : packages.get(pkg)?.uid;
    if (owner === undefined) return yield parceledList();
    if (owner !== uid && (yield* awaited(checkUidPermission(DUMP, uid))) !== 0)
      throw rt.mkThrowable("java/lang/SecurityException", `Only package ${pkg} or a caller holding ${DUMP} may read its exit reasons`);
    const names = pkg !== null ? [pkg] : [...packages.values()].filter((p) => p.uid === uid).map((p) => p.pkg);
    const reads = names.map(queryExitRecords);
    const histories = reads.some(records => records instanceof Promise) ? yield* awaited(Promise.all(reads)) : reads as ExitRecord[][];
    let records = histories.flat().filter((r) => r.uid === owner && (pid <= 0 || r.pid === pid)).sort((a, b) => b.timestamp - a.timestamp);
    if (maxNum > 0) records = records.slice(0, maxNum);
    const infos: JObj[] = [];
    for (const r of records) infos.push(yield* awaited(exitInfo(r)));
    return yield parceledList(infos);
  }),
};
const CRASH_INFO = "android/app/ApplicationErrorReport$CrashInfo", EXIT_INFO = "android/app/ApplicationExitInfo";
const DUMP = "android.permission.DUMP", CLEAR_APP_USER_DATA = "android.permission.CLEAR_APP_USER_DATA";
/** ActivityManagerService's limit on a process state summary */
const MAX_STATE_SUMMARY = 128;
/** a record as ApplicationExitInfo, with a native crash's tombstone behind its retriever */
const exitInfo = driven(function* (r: ExitRecord): Gen<JObj> {
  const info: JObj = yield newObj(EXIT_INFO, "()V");
  setDeclared(info, EXIT_INFO, { mPid: r.pid, mRealUid: r.uid, mPackageUid: r.uid, mDefiningUid: r.uid, mProcessName: r.process, mPackageName: r.pkg,
    mReason: r.reason, mStatus: r.status, mImportance: r.importance, mTimestamp: BigInt(r.timestamp), mDescription: r.description,
    mState: r.state && new Int8Array(Uint8Array.fromBase64(r.state).buffer) });
  if (r.tombstone) {
    const retriever = (yield* awaited(newStub("webdroid/TombstoneRetriever"))) as JTombstoneRetriever;
    retriever.tombstone = Uint8Array.fromBase64(r.tombstone);
    setDeclared(info, EXIT_INFO, { mNativeTombstoneRetriever: retriever });
  }
  return info;
});
/** NativeTombstoneManager's retriever: a descriptor on the tombstone's protobuf */
class JTombstoneRetriever extends JObj { tombstone: Uint8Array = new Uint8Array(0); }
rt.register({ name: "webdroid/TombstoneRetriever", ctor: JTombstoneRetriever, sup: "android/app/IParcelFileDescriptorRetriever$Stub", methods: {
  "getPfd()Landroid/os/ParcelFileDescriptor;": function (this: JTombstoneRetriever) { return mkPfd(this.tombstone); },
} });

/** ActivityThread.main for this process: its thread attaches to the activity manager, which binds
 *  the application and, for the app the user launched, its launcher activity. A process started
 *  for another's component runs just that. The main looper is already running. */
export const startActivityThread = driven(function* (launched: boolean): Gen<void> {
  launcher = launched;
  const AT = "android/app/ActivityThread";
  yield scall(AT + "$AndroidOs", "install", "()V");
  yield scall("dalvik/system/CloseGuard", "setEnabled", "(Z)V", 0);
  yield scall("android/os/Environment", "initForCurrentUser", "()V");
  yield scall("com/android/org/conscrypt/TrustedCertificateStore", "setDefaultUserDirectory", "(Ljava/io/File;)V",
    yield scall("android/os/Environment", "getUserConfigDirectory", "(I)Ljava/io/File;", yield scall("android/os/UserHandle", "myUserId", "()I")));
  yield scall(AT, "initializeMainlineModules", "()V");
  yield scall("android/os/Process", "setArgV0", "(Ljava/lang/String;)V", "<pre-initialized>");
  const thread = yield newObj(AT, "()V");
  yield vcall(thread, "attach", "(ZJ)V", 0, 0n);
  const at = yield* awaited(linkInit(AT));
  if (at.static("sMainThreadHandler") == null) at.setStatic("sMainThreadHandler", yield vcall(thread, "getHandler", "()Landroid/os/Handler;"));
});

// ActivityThread's natives: heapprofd never profiles this process, and the renderer holds no
// resources a trim could purge
// Activity.getDlWarning: the linker records no warning for a library an app loads
rt.registerJni("android/app/Activity", "getDlWarning()Ljava/lang/String;", () => null);
rt.registerJnis("android/app/ActivityThread", {
  "nInitZygoteChildHeapProfiling()V": () => {},
  "nPurgePendingResources()V": () => {},
});
