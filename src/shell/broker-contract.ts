// The broker's contract: what a process realm asks of the broker (system_server's part kept in the
// page) over its command port, by domain, what the broker asks of a process's endpoint, and the
// helpers both sides share. A process Worker imports this, never processes.ts, so it does not
// bundle the broker. Caller identity is bound to the port, never supplied in a request's arguments.
import type { PendingAccess } from "../android/pendingintent.ts";
import type { PermissionAccess } from "../android/permissions.ts";
import type { UriGrantCalls } from "../android/urigrants.ts";
import type { WebStorageCalls } from "../android/webstorage.ts";
import type { ForegroundNotificationRequest } from "../android/notification.ts";
import type { SQLiteRequest, SQLiteReply } from "../android/sqlite.ts";
import type { Sender } from "../android/server/broadcastqueue.ts";
import type { ExitRecord, KillNote } from "../android/server/appexitinfo.ts";
import type { ComponentRef } from "../android/intent.ts";
import type { Caller, ParcelData, Transaction, TransactionReply, BinderHandle } from "../android/binder.ts";
import type { CookieCalls } from "./cookie-access.ts";
import type { DescriptorCalls } from "./file-descriptors.ts";
import type { FilePathCalls } from "./file-path.ts";
import type { HostUi } from "./host-ui.ts";
import type { PackageDataChange } from "./packagedata.ts";
import type { ProcessLifeCalls } from "./process-life.ts";
import type { ServiceRequest, ServiceStarts } from "./servicerecords.ts";
import type { SettingsAccess } from "./settings.ts";
import { asSystem } from "../android/binder.ts";
import { checkPermission } from "../android/permissions.ts";
import { queryReceivers } from "../android/pm.ts";
import { awaited, rt, type Gen, type JObj } from "../jvm/runtime.ts";
import { hostUiMethods } from "./host-ui.ts";
import { callError, callProxy, methodsOf, qualified, type CallFailure, type MethodTree, type ProxyOptions } from "./rpc.ts";

/** an access interface's methods, called across a port */
export type Calls<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
/** what serves a contract: each method answers its result or a promise of it */
export type Answers<C> = { [K in keyof C]: C[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R | Promise<R> :
  C[K] extends (...args: never[]) => unknown ? C[K] : Answers<C[K]> };

export type Receiver = { pkg: string; cls: string; priority: number };
export type BroadcastData = { code: number; data: string | null; extras: ParcelData | null; aborted: boolean };
/** ActivityTaskManager's starts in other processes and their results */
export type ActivityCalls = {
  launch(pkg: string, process: string, component: string, intent: ParcelData, request: number, callingClass: string | null): Promise<void>;
  finish(id: number, code: number, data: ParcelData | null): Promise<void>;
  presentation(translucent: boolean): Promise<void>;
};
export type BrokerCalls = CookieCalls & {
  process: ProcessLifeCalls;
  webStorage: WebStorageCalls;
  /** the start state of the caller's services */
  starts: Calls<ServiceStarts>;
  pending: Calls<PendingAccess>;
  files: FilePathCalls;
  descriptors: DescriptorCalls;
  permissions: Calls<PermissionAccess>;
  settings: Calls<SettingsAccess>;
  activity: ActivityCalls;
  uriGrants: Calls<UriGrantCalls>;
  ui: HostUi;
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  systemService: (name: string) => Promise<BinderHandle | null>;
  systemProvider: (authority: string) => Promise<BinderHandle | null>;
  notificationForeground: (request: ForegroundNotificationRequest) => Promise<void>;
  exitRecords: (pkg: string) => Promise<ExitRecord[]>;
  processExited: (record: ExitRecord) => void;
  storageWrite: (key: string, value: string | null) => void;
  /** a package's own clear, one the caller holds the permission for, or one the user agrees to */
  packageDataChange: (pkg: string, change: PackageDataChange, broadcasts: { data: ParcelData; targets: Receiver[] }[], prompt?: string) => Promise<boolean>;
  displayOrientation: (landscape: boolean) => Promise<void>;
  sqlite: (request: SQLiteRequest) => Promise<SQLiteReply>;
  transact: (request: Transaction) => Promise<TransactionReply>;
  service: (pkg: string, process: string, request: ServiceRequest) => Promise<BinderHandle | null>;
  contentProvider: (pkg: string, process: string, authority: string) => Promise<BinderHandle | null>;
  broadcast: (data: ParcelData, manifest: Receiver[], permissions: string[], ordered: boolean, initial?: BroadcastData) => Promise<BroadcastData>;
};
type Own<C> = { [K in keyof C as C[K] extends (...args: never[]) => unknown ? K : never]: C[K] };
type Domains<C> = { [K in keyof C]: C[K] extends (...args: never[]) => unknown ? never : K }[keyof C] & string;
/** in a fixed order: census decodes a timeline's call indexes by brokerCallNames */
export const brokerMethods = {
  "": methodsOf<Own<BrokerCalls>>()(["serviceConnected", "systemService", "systemProvider", "notificationForeground", "exitRecords", "processExited",
    "displayOrientation", "transact", "service", "contentProvider", "broadcast", "sqlite", "cookieGet", "cookieSet", "cookieAccept", "cookieHas",
    "cookieRemove", "cookieFlush", "cookieNetwork", "cookieDocument", "cookieWatch", "storageWrite", "packageDataChange"]),
  process: methodsOf<ProcessLifeCalls>()(["processAlive", "processSignal", "processWatch", "processUnwatch"]),
  webStorage: methodsOf<WebStorageCalls>()(["webRenderer", "webStorage"]),
  starts: methodsOf<ServiceStarts>()(["created", "destroyed", "start", "deliver", "requested", "stop", "stopSelf", "done", "foreground"]),
  pending: methodsOf<PendingAccess>()(["create", "cancel", "send", "take", "peek"]),
  files: methodsOf<FilePathCalls>()(["filePrepare", "fileStat", "fileMkdir", "fileAccess", "fileList", "fileRename", "fileRemove", "fileCreate", "fileFifo", "fileSetAttributes"]),
  descriptors: methodsOf<DescriptorCalls>()(["fileDescriptor"]),
  permissions: methodsOf<PermissionAccess>()(["permissionCheck", "permissionGrant"]),
  settings: methodsOf<SettingsAccess>()(["get", "entries", "put", "ssaidKey"]),
  activity: methodsOf<ActivityCalls>()(["launch", "finish", "presentation"]),
  ui: hostUiMethods,
  uriGrants: methodsOf<UriGrantCalls>()(["check", "grant", "revoke"]),
} satisfies MethodTree & { [D in Domains<BrokerCalls>]: readonly (keyof BrokerCalls[D])[] };
export const brokerCallNames = qualified(brokerMethods);

export type ActivityRequest = { kind: "launch"; id: number; component: string; intent: ParcelData; caller: ComponentRef | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" | "visible" }
  | { kind: "result"; request: number; code: number; data: ParcelData | null } | { kind: "back" }
  | { kind: "rotate"; landscape: boolean };
/** what the broker asks of a process */
export type ProcessEndpoint = {
  processDied: (token: number) => Promise<void>;
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  /** IServiceConnection.connected for a binding this process holds by its key */
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  contentProvider: (authority: string) => Promise<BinderHandle | null>;
  broadcast: (intent: ParcelData, component: string | null, ordered: boolean, result: BroadcastData, sender: Sender | null) => Promise<BroadcastData>;
  cookiesChanged: () => Promise<void>;
  storageChanged: (key: string, value: string | null) => Promise<void>;
  /** a package was removed: this process's package manager forgets it */
  packageRemoved: (pkg: string) => Promise<void>;
  /** the kernel's SIGKILL: the process ends where it stands, with the reason the kill noted */
  kill: (signal: number, note?: KillNote) => void;
};
const processMethods = methodsOf<ProcessEndpoint>()(["processDied", "activity", "transact", "service", "serviceConnected", "contentProvider", "broadcast",
  "cookiesChanged", "storageChanged", "packageRemoved", "kill"]);
/** a failure as this realm's exception: a Java exception is rebuilt in this VM */
export const javaFailure = (error: CallFailure): unknown => error.javaClass ? rt.mkThrowable(error.javaClass, error.message) : callError(error);
export const processProxy = (port: MessagePort, options: Pick<ProxyOptions<ProcessEndpoint>, "makeError" | "onClose"> = {}) =>
  callProxy<ProcessEndpoint>(port, processMethods, { notifications: ["kill"], makeError: javaFailure, ...options });

export const permissionDenied = async (permission: string, pkg: string) =>
  await checkPermission(permission, pkg) !== 0;
/** a process's Java work on the broker's requests, or for the broker on its own behalf, as
 *  system_server does it. The broker runs none itself (a caller's realm rebuilds its errors), so
 *  it answers whichever process's JVM has ended, the page's included. */
export const asBroker = <T>(work: Gen<T>): Promise<T> => asSystem(() => rt.drive(work));
export const unawaited = (work: Promise<unknown>) => void work.catch((error) => console.error("[broker]", error));
/** the manifest receivers an intent reaches, as the sending process's package manager resolves them */
export function* receivers(intent: JObj): Gen<Receiver[]> {
  return (yield* awaited(queryReceivers(intent))).map((r) => ({ pkg: r.owner.pkg, cls: r.name, priority: r.priority }));
}
