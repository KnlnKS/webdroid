// system_server's ContentService, whose observer tree holds every process's observers: a change
// notifies the observers registered at its uri, those above it that asked for descendants, and
// every one below it unless the sender skips descendants (ObserverNode.collectObserversLocked).
// An observer's process death drops it. AOSP's ContentResolver reaches it as IContentService.
// Sync is answered as a device with no sync adapters.
import { awaited, rt, JObj, driven, noops, stubs, type Gen } from "../../jvm/runtime.ts";
import { newArrayList } from "../../jvm/natives/jcoll.ts";
import { vcall } from "../../jvm/natives/jentry.ts";
import { jarray } from "../../jvm/abi.ts";
import { callingIdentity, hostStub, onCallerDeath, oneway } from "../binder.ts";
import { mkUri, uriParts, uriText, type JUri } from "../net.ts";

const NOTIFY_SKIP_NOTIFY_FOR_DESCENDANTS = 2;
type Observer = { observer: JObj; key: unknown; segments: string[]; descendants: boolean; userId: number; unwatch: () => void };
const observers: Observer[] = [];
/** countUriSegments/getUriSegment: the authority, then the path's segments */
function segmentsOf(uri: string): string[] {
  const { authority, segments } = uriParts(uri);
  return [authority, ...segments];
}
function stopObserving(key: unknown): void {
  for (let i = observers.length - 1; i >= 0; i--) if (observers[i].key === key) { observers[i].unwatch(); observers.splice(i, 1); }
}
function notified(o: Observer, changed: string[], flags: number): boolean {
  const n = Math.min(o.segments.length, changed.length);
  for (let i = 0; i < n; i++) if (o.segments[i] !== changed[i]) return false;
  if (o.segments.length < changed.length) return o.descendants;
  return !(flags & NOTIFY_SKIP_NOTIFY_FOR_DESCENDANTS && o.descendants);
}
/** ContentService.notifyChange for one uri; `origin` is the observer the change came from */
export const notifyContent = driven(function* notifyContent$(uri: string, origin: unknown, selfNotify: boolean, flags: number): Gen<void> {
  const changed = segmentsOf(uri), targets = observers.filter((o) => notified(o, changed, flags) && (selfNotify || origin === null || o.key !== origin));
  if (!targets.length) return;
  const javaUri = yield* awaited(mkUri(uri));
  // IContentObserver is oneway: no observer waits on another
  for (const o of targets) oneway(o.observer, "onChangeEtc", "(Z[Landroid/net/Uri;II)V", +(origin !== null && o.key === origin), jarray([javaUri], "Landroid/net/Uri;"), flags, o.userId);
});

const IObserver = "Landroid/database/IContentObserver;";
const ACCOUNT = "Landroid/accounts/Account;", S = "Ljava/lang/String;", CN = "Landroid/content/ComponentName;";
const binderOf = (observer: JObj) => vcall(observer, "asBinder", "()Landroid/os/IBinder;");
rt.register({ name: "webdroid/ContentService", ctor: class extends JObj {}, sup: "android/content/IContentService$Stub", methods: {
  [`registerContentObserver(Landroid/net/Uri;Z${IObserver}II)V`]: driven(function* (uri: JUri | null, descendants: number, observer: JObj | null, userId: number): Gen<void> {
    if (!uri || !observer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "You must pass a valid uri and observer");
    const { pid } = callingIdentity(), key = yield binderOf(observer), segments = segmentsOf(yield* awaited(uriText(uri)));
    observers.push({ observer, key, segments, descendants: !!descendants, userId, unwatch: onCallerDeath(pid, () => stopObserving(key)) });
  }),
  [`unregisterContentObserver(${IObserver})V`]: driven(function* (observer: JObj | null): Gen<void> {
    if (!observer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "You must pass a valid observer");
    stopObserving(yield binderOf(observer));
  }),
  [`notifyChange([Landroid/net/Uri;${IObserver}ZIIILjava/lang/String;)V`]: driven(function* (uris: JUri[] | null, observer: JObj | null, selfNotify: number, flags: number): Gen<void> {
    if (!uris) throw rt.mkThrowable("java/lang/NullPointerException", "uris");
    const origin = observer ? yield binderOf(observer) : null;
    for (const uri of uris) yield notifyContent(yield* awaited(uriText(uri)), origin, !!selfNotify, flags);
  }),
  "getSyncAdapterTypes()[Landroid/content/SyncAdapterType;": () => jarray([], "Landroid/content/SyncAdapterType;"),
  "getSyncAdapterTypesAsUser(I)[Landroid/content/SyncAdapterType;": () => jarray([], "Landroid/content/SyncAdapterType;"),
  "getSyncAdapterPackagesForAuthorityAsUser(Ljava/lang/String;I)[Ljava/lang/String;": () => jarray([], S),
  "getCurrentSyncs()Ljava/util/List;": () => newArrayList(), "getCurrentSyncsAsUser(I)Ljava/util/List;": () => newArrayList(),
  [`getPeriodicSyncs(${ACCOUNT}${S}${CN})Ljava/util/List;`]: () => newArrayList(),
  ...stubs(1, "getMasterSyncAutomatically()Z", "getMasterSyncAutomaticallyAsUser(I)Z"),
  ...stubs(0, `getSyncAutomatically(${ACCOUNT}${S})Z`, `getSyncAutomaticallyAsUser(${ACCOUNT}${S}I)Z`, `getIsSyncable(${ACCOUNT}${S})I`,
    `getIsSyncableAsUser(${ACCOUNT}${S}I)I`, `isSyncActive(${ACCOUNT}${S}${CN})Z`, `isSyncPending(${ACCOUNT}${S}${CN})Z`, `isSyncPendingAsUser(${ACCOUNT}${S}${CN}I)Z`),
  ...stubs(null, `getSyncStatus(${ACCOUNT}${S}${CN})Landroid/content/SyncStatusInfo;`, `getSyncStatusAsUser(${ACCOUNT}${S}${CN}I)Landroid/content/SyncStatusInfo;`,
    `getSyncAdapterPackageAsUser(${S}${S}I)${S}`, `getCache(${S}Landroid/net/Uri;I)Landroid/os/Bundle;`),
  ...noops("addStatusChangeListener(ILandroid/content/ISyncStatusObserver;)V", "removeStatusChangeListener(Landroid/content/ISyncStatusObserver;)V",
    `putCache(${S}Landroid/net/Uri;Landroid/os/Bundle;I)V`, `onDbCorruption(${S}${S}${S})V`),
} });
hostStub("content", "webdroid/ContentService");
