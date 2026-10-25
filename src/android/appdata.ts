// An app's data lifecycle as system_server runs it: ActivityManagerService.clearApplicationUserData
// and the package manager's deletion. The caller's JVM builds the package broadcasts first, since
// the caller may be the package being stopped; the broker, which outlives every process, stops the
// package, has the data's owners clear or remove it (shell/packagedata.ts) and sends them.
import { awaited, driven, rt, JObj, type Gen } from "../jvm/runtime.ts";
import { scall, vcall, newObj, after } from "../jvm/natives/jentry.ts";
import { callingIdentity, type ParcelData, binderEscape } from "./binder.ts";
import { encodeIntent } from "./intentipc.ts";
import { putExtra, registerSystemActivity, type JIntent, type SystemResult } from "./intent.ts";
import { longVersionCode, queryReceivers } from "./pm.ts";
import { packages } from "./packages.ts";
import { checkUidPermission, notHeld } from "./permissions.ts";
import { sendIntent } from "./pendingintent.ts";
import type { Receiver } from "../shell/broker-contract.ts";
import { detached } from "../jvm/natives/jthrowable.ts";
import { broker } from "../shell/broker-access.ts";

const S = "Ljava/lang/String;";
type Broadcast = { data: ParcelData; targets: Receiver[] };
/** a package broadcast about `pkg`, with its uid and `flags` set, which the package's own receivers
 *  (stopped by then) do not get */
function* packageBroadcast$(action: string, pkg: string, uid: number, flags: string[] = []): Gen<Broadcast> {
  const uri = yield scall("android/net/Uri", "fromParts", `(${S}${S}${S})Landroid/net/Uri;`, "package", pkg, null);
  const intent: JIntent = yield newObj("android/content/Intent", `(${S}Landroid/net/Uri;)V`, action, uri);
  yield putExtra(intent, "android.intent.extra.UID", uid, "I");
  for (const flag of flags) yield putExtra(intent, flag, 1, "Z");
  const targets = (yield* awaited(queryReceivers(intent))).filter((r) => r.owner.pkg !== pkg).map((r) => ({ pkg: r.owner.pkg, cls: r.name, priority: r.priority }));
  return { data: yield* awaited(encodeIntent(intent)), targets };
}
/** clearApplicationUserData of an installed package, `fromApp` when it clears its own: its processes
 *  are killed and its data cleared, then ACTION_PACKAGE_DATA_CLEARED goes out and `observer` hears
 *  the result (when its process lives); `done` settles with it */
export const clearUserData = driven(function* (pkg: string, fromApp: boolean, keepState: boolean, observer: JObj | null): Gen<{ done: Promise<boolean> }> {
  const record = packages.get(pkg);
  const cleared = record && (yield* packageBroadcast$("android.intent.action.PACKAGE_DATA_CLEARED", pkg, record.uid));
  const done = !cleared ? Promise.resolve(false) : (async () => broker().packageDataChange(pkg, { kind: "clear", fromApp, keepState }, [cleared]))()
    .then(() => true, (error) => { console.error("[clear data]", pkg, error); return false; });
  void done.then((ok) => { if (observer) detached(() => vcall(observer, "onRemoveCompleted", `(${S}Z)V`, pkg, ok ? 1 : 0), binderEscape()); });
  return { done };
});

const RESULT_FIRST_USER = 1, DELETE_SUCCEEDED = 1, DELETE_FAILED_INTERNAL_ERROR = -1, DELETE_FAILED_ABORTED = -5;
/** deletePackageX for a package the user installed: its processes die, it goes with all its data,
 *  and ACTION_PACKAGE_REMOVED and ACTION_PACKAGE_FULLY_REMOVED go out. A system package answers
 *  DELETE_FAILED_INTERNAL_ERROR, as one without an update does. */
const deletePackage = driven(function* (pkg: string, prompt?: string): Gen<number> {
  const record = packages.get(pkg);
  if (!record || record.system) return DELETE_FAILED_INTERNAL_ERROR;
  const flags = ["android.intent.extra.DATA_REMOVED", "android.intent.extra.REMOVED_FOR_ALL_USERS"];
  const broadcasts = [yield* packageBroadcast$("android.intent.action.PACKAGE_REMOVED", pkg, record.uid, flags),
    yield* packageBroadcast$("android.intent.action.PACKAGE_FULLY_REMOVED", pkg, record.uid, flags)];
  return (yield* awaited(broker().packageDataChange(pkg, { kind: "remove" }, broadcasts, prompt))) ? DELETE_SUCCEEDED : DELETE_FAILED_ABORTED;
});

const DELETE_PACKAGES = "android.permission.DELETE_PACKAGES";
/** whether the caller may delete packages without asking the user */
export const mayDeletePackages = () => after(checkUidPermission(DELETE_PACKAGES, callingIdentity().uid), (result) => result === 0);
/** Context.enforcePermission's failure */
export function enforceDeletePackages(): unknown {
  const { uid } = callingIdentity();
  return after(mayDeletePackages(), (may) => { if (!may) throw notHeld(uid, DELETE_PACKAGES); });
}
/** deletePackageVersioned: the package at a version, any for VERSION_CODE_HIGHEST (-1) */
export const deleteVersioned = driven(function* (pkg: string, version: bigint): Gen<number> {
  const record = packages.get(pkg);
  if (record && version !== -1n && version !== longVersionCode(record.root)) return DELETE_FAILED_INTERNAL_ERROR;
  return yield* awaited(deletePackage(pkg));
});

// PackageInstallerService's PackageDeleteObserverAdapter: a deletion's result, or the user's
// confirmation it needs, as the status an IntentSender receives
const STATUS_PENDING_USER_ACTION = -1, EXTRA = "android.content.pm.extra.";
class JDeleteObserver extends JObj { pkg = ""; sender: JObj | null = null; }
export const deleteObserver = driven(function* (pkg: string, sender: JObj): Gen<JDeleteObserver> {
  const observer = (yield newObj("webdroid/PackageDeleteObserverAdapter", "()V")) as JDeleteObserver;
  observer.pkg = pkg; observer.sender = sender;
  return observer;
});
function* status$(observer: JDeleteObserver, status: number, extras: (intent: JIntent) => Gen<void>): Gen<void> {
  const fill: JIntent = yield newObj("android/content/Intent", "()V");
  yield putExtra(fill, EXTRA + "PACKAGE_NAME", observer.pkg, S);
  yield putExtra(fill, EXTRA + "STATUS", status, "I");
  yield* extras(fill);
  yield sendIntent(observer.sender!, fill);
}
rt.register({ name: "webdroid/PackageDeleteObserverAdapter", ctor: JDeleteObserver, sup: "android/content/pm/IPackageDeleteObserver2$Stub", methods: {
  "onUserActionRequired(Landroid/content/Intent;)V": driven(function* (this: JDeleteObserver, intent: JIntent): Gen<void> {
    yield* status$(this, STATUS_PENDING_USER_ACTION, function* (fill) { yield putExtra(fill, "android.intent.extra.INTENT", intent, "Landroid/os/Parcelable;"); });
  }),
  [`onPackageDeleted(${S}I${S})V`]: driven(function* (this: JDeleteObserver, _pkg: string, code: number, message: string | null): Gen<void> {
    const PM = "android/content/pm/PackageManager";
    yield* status$(this, yield scall(PM, "deleteStatusToPublicStatus", "(I)I", code), function* (fill) {
      yield putExtra(fill, EXTRA + "STATUS_MESSAGE", yield scall(PM, "deleteStatusToString", `(I${S})${S}`, code, message), S);
      yield putExtra(fill, EXTRA + "LEGACY_STATUS", code, "I");
    });
  }),
} });

/** UninstallerActivity, which an app's ACTION_DELETE or the installer's ACTION_UNINSTALL_PACKAGE
 *  starts: the shell asks the user, then the package is deleted and the installer's callback hears
 *  the result. A result the starter asked for is RESULT_OK on success, else RESULT_FIRST_USER. */
const uninstaller = driven(function* (intent: JIntent): Gen<SystemResult> {
  const uri: JObj | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  const pkg: string | null = uri && (yield vcall(uri, "getSchemeSpecificPart", `()${S}`));
  const callback: JObj | null = yield vcall(intent, "getParcelableExtra", `(${S})Landroid/os/Parcelable;`, EXTRA + "CALLBACK");
  const record = pkg ? packages.get(pkg) : undefined;
  let code = DELETE_FAILED_INTERNAL_ERROR;
  if (record && !record.system) {
    code = yield* awaited(deletePackage(record.pkg, `${record.label()}\n\nDo you want to uninstall this app?`));
  }
  if (callback) yield vcall(callback, "onUninstallComplete", `(${S}I${S})V`, pkg, code, code === DELETE_FAILED_ABORTED ? "Cancelled by user" : null);
  if (!(yield vcall(intent, "getBooleanExtra", `(${S}Z)Z`, "android.intent.extra.RETURN_RESULT", 0))) return null;
  const result: JIntent = yield newObj("android/content/Intent", "()V");
  yield putExtra(result, "android.intent.extra.INSTALL_RESULT", code, "I");
  return code === DELETE_SUCCEEDED ? result : { resultCode: RESULT_FIRST_USER, data: result };
});
registerSystemActivity("android.intent.action.UNINSTALL_PACKAGE", uninstaller, ["package"]);
registerSystemActivity("android.intent.action.DELETE", uninstaller, ["package"]);
