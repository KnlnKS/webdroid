// IPackageInstaller and IPackageInstallerSession, under AOSP's PackageInstaller and its Session:
// a session stages each written file under /data/app/vmdl<id>.tmp, as PackageInstallerSession
// does, and its commit has system_server install the base APK and its splits.
import { awaited, JObj, rt, noops, setDeclared, getDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { scall, vcall, after, newObj } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { jarray } from "../jvm/abi.ts";
import { newFile } from "../jvm/natives/jio.ts";
import { vfs } from "../shell/vfs.ts";
import { broker } from "../shell/broker-access.ts";
import { broadcastIntent } from "./server/broadcastqueue.ts";
import { sendIntent } from "./pendingintent.ts";
import { callingIdentity, newStub, binderEscape, parceledList } from "./binder.ts";
import { ownedBy, packages } from "./packages.ts";
import { checkUidPermission } from "./permissions.ts";
import { deleteObserver, deleteVersioned, mayDeletePackages } from "./appdata.ts";
import { notHeld } from "./permissions.ts";
import { putExtra, type JIntent } from "./intent.ts";
import { installFailed, INSTALL_SUCCEEDED, type InstallResult } from "./installpackage.ts";

const PI = "android/content/pm/PackageInstaller", S = "Ljava/lang/String;";
const INSTALL_FAILED_PRE_APPROVAL_NOT_AVAILABLE = -129, MODE_FULL_INSTALL = 1;
const MODE_WRITE_ONLY = 0x20000000, MODE_CREATE = 0x08000000, MODE_TRUNCATE = 0x04000000;
interface Session {
  id: number; mode: number; installFlags: number; packageName: string | null; installer: string | null; installerUid: number;
  names: string[]; sealed: boolean; binder: JObj | null;
}
const sessions = new Map<number, Session>();
const callbacks = new Set<JObj>();
let nextSession = 1;
const stageDir = (id: number) => `/data/app/vmdl${id}.tmp`;
const ROOT_UID = 0, SYSTEM_UID = 1000, SHELL_UID = 2000;
/** a session the caller may open or abandon: its installer's, or any for root (isCallingUidOwner) */
function session(id: number): Session {
  const value = sessions.get(id), { uid } = callingIdentity();
  if (!value || uid !== ROOT_UID && uid !== value.installerUid) throw rt.mkThrowable("java/lang/SecurityException", `Caller has no access to session ${id}`);
  return value;
}
function notify(name: string, desc: string, ...args: unknown[]): void {
  for (const callback of callbacks) detached(() => vcall(callback, name, desc, ...args), binderEscape());
}
function finish(s: Session, success: boolean): void {
  sessions.delete(s.id);
  for (const name of s.names) vfs.delete(stageDir(s.id) + "/" + name);
  notify("onSessionFinished", "(IZ)V", s.id, success ? 1 : 0);
}

/** PackageInstallerSession.sendOnPackageInstalled: the outcome of the session, or of its preapproval request, to `sender` */
function* report$(s: Session, sender: JObj, { code, message, pkg, preapproval = false }: InstallResult & { preapproval?: boolean }): Gen<void> {
  const PM = "android/content/pm/PackageManager", result: JIntent = yield newObj("android/content/Intent", "()V");
  const extra = (name: string, value: unknown, desc: string) => putExtra(result, "android.content.pm.extra." + name, value, desc);
  yield extra("PACKAGE_NAME", pkg, S);
  yield extra("SESSION_ID", s.id, "I");
  yield extra("STATUS", yield scall(PM, "installStatusToPublicStatus", "(I)I", code), "I");
  yield extra("STATUS_MESSAGE", yield scall(PM, "installStatusToString", `(I${S})${S}`, code, message), S);
  yield extra("LEGACY_STATUS", code, "I");
  yield extra("PRE_APPROVAL", +preapproval, "Z");
  yield sendIntent(sender, result);
}

/** system_server's install of the session's files, which leave its stage with the commit */
async function install(s: Session): Promise<InstallResult> {
  if (s.mode !== MODE_FULL_INSTALL) throw new Error("Inherited-split installs are unsupported");
  const files = s.names.map((name) => stageDir(s.id) + "/" + name);
  const apks = await Promise.all(files.map((file) => vfs.readFile(file) ?? Promise.reject(new Error("Session file was not written"))));
  for (const file of files) vfs.delete(file);
  // a staged file's spare capacity stays behind
  return broker().installPackage(apks.map((bytes) => bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()), s.packageName);
}
/** PackageInstallerSession.commit: install the staged APKs, then report to the status receiver */
function* commit$(s: Session, sender: JObj): Gen<void> {
  const result = yield* awaited(install(s).catch(installFailed));
  if (result.code === INSTALL_SUCCEEDED) {
    const uri = yield scall("android/net/Uri", "fromParts", `(${S}${S}${S})Landroid/net/Uri;`, "package", result.pkg, null);
    const added: JIntent = yield newObj("android/content/Intent", `(${S}Landroid/net/Uri;)V`, "android.intent.action.PACKAGE_ADDED", uri);
    detached(() => broadcastIntent(added, [], false), logUncaught);
  }
  finish(s, result.code === INSTALL_SUCCEEDED);
  yield* report$(s, sender, result);
}

class JSessionService extends JObj { session: Session | null = null; }
const own = (o: JSessionService) => {
  const s = o.session, { uid } = callingIdentity();
  if (!s || !sessions.has(s.id)) throw rt.mkThrowable("java/lang/SecurityException", "Session was abandoned or committed");
  if (uid !== ROOT_UID && uid !== s.installerUid) throw rt.mkThrowable("java/lang/SecurityException", `Session does not belong to uid ${uid}`);
  return s;
};
const unsealed = (o: JSessionService) => {
  const s = own(o);
  if (s.sealed) throw rt.mkThrowable("java/lang/SecurityException", "Session is sealed");
  return s;
};
rt.register({ name: "webdroid/PackageInstallerSession", ctor: JSessionService, sup: "android/content/pm/IPackageInstallerSession$Stub", methods: {
  "openWrite(Ljava/lang/String;JJ)Landroid/os/ParcelFileDescriptor;": driven(function* openWrite$(this: JSessionService, name: string | null, offset: bigint): Gen {
    const s = unsealed(this);
    if (!name || name.includes("/") || name === "." || name === "..") throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid name: " + name);
    if (offset !== 0n) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Resuming a session write is not supported");
    vfs.mkdir(stageDir(s.id));
    if (!s.names.includes(name)) s.names.push(name);
    return scall("android/os/ParcelFileDescriptor", "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;",
      yield* awaited(newFile(stageDir(s.id) + "/" + name)), MODE_WRITE_ONLY | MODE_CREATE | MODE_TRUNCATE);
  }),
  "getNames()[Ljava/lang/String;": function (this: JSessionService) { return jarray(own(this).names.slice(), S); },
  "seal()V": function (this: JSessionService) { own(this).sealed = true; },
  "commit(Landroid/content/IntentSender;Z)V": function (this: JSessionService, sender: JObj | null) {
    const s = unsealed(this);
    if (!sender) throw rt.mkThrowable("java/lang/NullPointerException", "statusReceiver can't be null");
    s.sealed = true;
    detached(() => rt.drive(commit$(s, sender)), logUncaught);
  },
  // this device offers no install preapproval (config_isPreApprovalRequestAvailable false): the request fails, and the install asks at commit
  [`requestUserPreapproval(L${PI}$PreapprovalDetails;Landroid/content/IntentSender;)V`]: function (this: JSessionService, details: JObj | null, sender: JObj | null) {
    const s = unsealed(this);
    if (!details || !sender) throw rt.mkThrowable("java/lang/IllegalArgumentException", "preapprovalDetails and statusReceiver cannot be null");
    detached(() => rt.drive(report$(s, sender, { code: INSTALL_FAILED_PRE_APPROVAL_NOT_AVAILABLE, message: "Request user pre-approval is currently not available.",
      pkg: s.packageName, preapproval: true })), logUncaught);
  },
  "abandon()V": function (this: JSessionService) { const s = this.session; if (s && sessions.has(s.id)) finish(own(this), false); },
  "getInstallFlags()I": function (this: JSessionService) { return own(this).installFlags; },
  "getParentSessionId()I": () => -1,
  "isMultiPackage()Z": () => 0,
  "isStaged()Z": () => 0,
  ...noops("close()V", "setClientProgress(F)V", "addClientProgress(F)V"),
} });

function* sessionInfo$(s: Session): Gen<JObj> {
  const info: JObj = yield newObj(PI + "$SessionInfo", "()V");
  return setDeclared(info, PI + "$SessionInfo", { sessionId: s.id, userId: 0, installerPackageName: s.installer, installerUid: s.installerUid, mode: s.mode,
    appPackageName: s.packageName, sealed: s.sealed ? 1 : 0, active: 1, parentSessionId: -1 });
}
function* sessionList$(installer: string | null | undefined): Gen {
  const infos: JObj[] = [];
  for (const s of sessions.values()) if (installer === undefined || s.installer === installer) infos.push(yield* sessionInfo$(s));
  return parceledList(infos);
}
rt.register({ name: "webdroid/PackageInstallerService", ctor: class extends JObj {}, sup: "android/content/pm/IPackageInstaller$Stub", methods: {
  // an app names itself as the installer; adb (shell, root) and the system may name another
  [`createSession(L${PI}$SessionParams;${S}${S}I)I`]: (params: JObj, installer: string | null) => {
    const { uid } = callingIdentity(), read = (name: string) => getDeclared(params, PI + "$SessionParams", name);
    if (uid !== ROOT_UID && uid !== SHELL_UID && uid !== SYSTEM_UID && !ownedBy(installer, uid))
      throw rt.mkThrowable("java/lang/SecurityException", `Package ${installer} does not belong to ${uid}`);
    const s: Session = { id: nextSession++, mode: read("mode") as number, installFlags: read("installFlags") as number,
      packageName: read("appPackageName") as string | null, installer, installerUid: uid, names: [], sealed: false, binder: null };
    sessions.set(s.id, s);
    notify("onSessionCreated", "(I)V", s.id);
    return s.id;
  },
  "openSession(I)Landroid/content/pm/IPackageInstallerSession;": (id: number) => {
    const s = session(id);
    return s.binder ?? after(newStub("webdroid/PackageInstallerSession"), (binder) => {
      (binder as JSessionService).session = s;
      return s.binder = binder;
    });
  },
  "abandonSession(I)V": (id: number) => finish(session(id), false),
  [`getSessionInfo(I)L${PI}$SessionInfo;`]: (id: number) => { const s = sessions.get(id); return s ? rt.drive(sessionInfo$(s)) : null; },
  [`getMySessions(${S}I)Landroid/content/pm/ParceledListSlice;`]: driven(function* getMySessions$(installer: string | null): Gen { return yield* sessionList$(installer); }),
  "getAllSessions(I)Landroid/content/pm/ParceledListSlice;": driven(function* getAllSessions$(): Gen { return yield* sessionList$(undefined); }),
  // with DELETE_PACKAGES the package goes at once; otherwise (REQUEST_DELETE_PACKAGES from P) the
  // status asks the caller to start the uninstaller, which asks the user
  [`uninstall(Landroid/content/pm/VersionedPackage;${S}ILandroid/content/IntentSender;I)V`]: driven(function* uninstall$(versioned: JObj, caller: string | null, flags: number, sender: JObj | null): Gen {
    const { uid } = callingIdentity(), record = caller === null ? undefined : packages.get(caller);
    if (record?.uid !== uid) throw rt.mkThrowable("java/lang/SecurityException", `Specified package ${caller} under uid ${uid} but it is not`);
    if (!sender) throw rt.mkThrowable("java/lang/NullPointerException", "statusReceiver can't be null");
    const pkg: string = yield vcall(versioned, "getPackageName", `()${S}`), version: bigint = yield vcall(versioned, "getLongVersionCode", "()J");
    const observer: JObj = yield deleteObserver(pkg, sender);
    if (yield mayDeletePackages()) {
      detached(() => after(deleteVersioned(pkg, version), (code) => vcall(observer, "onPackageDeleted", `(${S}I${S})V`, pkg, code, null)), logUncaught);
      return;
    }
    if (record.sdk.target >= 28 && (yield checkUidPermission("android.permission.REQUEST_DELETE_PACKAGES", uid)) !== 0)
      throw notHeld(uid, "android.permission.REQUEST_DELETE_PACKAGES");
    const intent: JIntent = yield newObj("android/content/Intent", `(${S})V`, "android.intent.action.UNINSTALL_PACKAGE");
    yield vcall(intent, "setData", "(Landroid/net/Uri;)Landroid/content/Intent;", yield scall("android/net/Uri", "fromParts", `(${S}${S}${S})Landroid/net/Uri;`, "package", pkg, null));
    yield putExtra(intent, "android.content.pm.extra.CALLBACK", yield newObj("android/content/pm/PackageManager$UninstallCompleteCallback", "(Landroid/os/IBinder;)V", observer), "Landroid/os/Parcelable;");
    yield putExtra(intent, "android.content.pm.extra.DELETE_FLAGS", flags, "I");
    yield vcall(observer, "onUserActionRequired", "(Landroid/content/Intent;)V", intent);
  }),
  "registerCallback(Landroid/content/pm/IPackageInstallerCallback;I)V": (callback: JObj) => { callbacks.add(callback); },
  "unregisterCallback(Landroid/content/pm/IPackageInstallerCallback;)V": (callback: JObj) => { callbacks.delete(callback); },
} });
let installer: PromiseOrVal<JObj> | null = null;
/** IPackageManager.getPackageInstaller's answer, which servicemanager does not list */
export const installerService = () => installer ??= newStub("webdroid/PackageInstallerService");
