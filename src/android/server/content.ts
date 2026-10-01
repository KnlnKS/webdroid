// IContentService, under AOSP's ContentResolver: content observers by URI with ContentService's
// ObserverNode rules (a change reaches observers at the URI, at its ancestors registered for
// descendants, and at every descendant), and sync answered as a device with no sync adapters.
import { rt, JObj, noops, stubs } from "../../jvm/runtime";
import { vcall } from "../../jvm/natives/jlang";
import { jarray } from "../../jvm/abi";
import { newArrayList } from "../../jvm/natives/jcoll";
import { hostStub } from "../binder";
import { reportUncaught } from "../os";

interface Entry { key: string; descendants: boolean; observer: JObj; userId: number }
const entries: Entry[] = [];
/** authority and path segments, as ObserverNode walks a URI */
async function uriKey(uri: JObj): Promise<string> {
  const segments = await vcall(await vcall(uri, "getPathSegments", "()Ljava/util/List;"), "toArray", "()[Ljava/lang/Object;");
  return [await vcall(uri, "getAuthority", "()Ljava/lang/String;") ?? "", ...segments].join("/");
}
const binderOf = (observer: JObj): JObj => vcall(observer, "asBinder", "()Landroid/os/IBinder;");

async function notifyChange(uris: JObj[], from: JObj | null, selfNotify: number, flags: number, userId: number): Promise<void> {
  const fromBinder = from ? binderOf(from) : null, deliveries = new Map<Entry, JObj[]>();
  for (const uri of uris) {
    const key = await uriKey(uri);
    for (const e of entries) {
      if (e.userId !== -1 && userId !== -1 && e.userId !== userId) continue;
      const hit = e.key === key || key.startsWith(e.key + "/") && e.descendants || e.key.startsWith(key + "/");
      if (!hit || binderOf(e.observer) === fromBinder && !selfNotify) continue;
      (deliveries.get(e) ?? deliveries.set(e, []).get(e)!).push(uri);
    }
  }
  for (const [e, hits] of deliveries) {
    const self = +(binderOf(e.observer) === fromBinder);
    void Promise.resolve(vcall(e.observer, "onChangeEtc", "(Z[Landroid/net/Uri;II)V", self, jarray(hits, "Landroid/net/Uri;"), flags, userId)).catch(reportUncaught);
  }
}

const ACCOUNT = "Landroid/accounts/Account;", S = "Ljava/lang/String;", CN = "Landroid/content/ComponentName;";
rt.register({ name: "webdroid/ContentService", ctor: class extends JObj {}, sup: "android/content/IContentService$Stub", methods: {
  "registerContentObserver(Landroid/net/Uri;ZLandroid/database/IContentObserver;II)V": async (uri: JObj, descendants: number, observer: JObj, userId: number) => {
    if (!uri || !observer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "You must pass a valid uri and observer");
    entries.push({ key: await uriKey(uri), descendants: !!descendants, observer, userId });
  },
  "unregisterContentObserver(Landroid/database/IContentObserver;)V": (observer: JObj) => {
    if (!observer) throw rt.mkThrowable("java/lang/IllegalArgumentException", "You must pass a valid observer");
    const binder = binderOf(observer);
    for (let i = entries.length; i-- > 0;) if (binderOf(entries[i].observer) === binder) entries.splice(i, 1);
  },
  "notifyChange([Landroid/net/Uri;Landroid/database/IContentObserver;ZIIILjava/lang/String;)V":
    (uris: JObj[], observer: JObj | null, selfNotify: number, flags: number, userId: number) => notifyChange([...uris], observer, selfNotify, flags, userId),
  // no sync adapter is installed: nothing syncs, and master sync keeps its default
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
