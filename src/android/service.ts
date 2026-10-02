// System services and binder-ish plumbing: UserHandle, FileObserver,
// and the callback/marker interfaces apps implement (ServiceConnection, IInterface).

import { rt, JObj, noops } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jcoll";
import { hostStub, newStub } from "./binder";
import { JUserHandle, PARCELABLE, userHandleForUid } from "./os";

// ── UserHandle: handles are canonical per Android user id.
rt.register({
  name: "android/os/UserHandle", ctor: JUserHandle, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(I)V": function (this: JUserHandle, id: number) { (this as { id: number }).id = id; },
    "getIdentifier()I": function (this: JUserHandle) { return this.id; },
    "hashCode()I": function (this: JUserHandle) { return this.id; },
    "equals(Ljava/lang/Object;)Z": function (this: JUserHandle, o: unknown) {
      return o instanceof JUserHandle && o.id === this.id ? 1 : 0;
    },
    "toString()Ljava/lang/String;": function (this: JUserHandle) { return "UserHandle{" + this.id + "}"; },
    ...PARCELABLE,
    "static getUserHandleForUid(I)Landroid/os/UserHandle;": userHandleForUid,
    "static of(I)Landroid/os/UserHandle;": (userId: number) => userHandleForUid(userId * 100000),
  },
});

// IRestrictionsManager, under AOSP's RestrictionsManager: no device or profile owner manages this
// device, so there are no restrictions and no provider to ask
rt.register({ name: "webdroid/RestrictionsManagerService", ctor: class extends JObj {}, sup: "android/content/IRestrictionsManager$Stub", methods: {
  "getApplicationRestrictions(Ljava/lang/String;)Landroid/os/Bundle;": () => newObj("android/os/Bundle"),
  "getApplicationRestrictionsPerAdminForUser(ILjava/lang/String;)Ljava/util/List;": () => newArrayList(),
  "hasRestrictionsProvider()Z": () => 0,
  "createLocalApprovalIntent()Landroid/content/Intent;": () => null,
  "requestPermission(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/os/PersistableBundle;)V": () => {
    throw rt.mkThrowable("java/lang/IllegalStateException", "Cannot request permission without a restrictions provider registered");
  },
} });
hostStub("restrictions", "webdroid/RestrictionsManagerService");

// INsdManager, under AOSP's NsdManager: the browser cannot join the multicast groups DNS-SD needs,
// so NsdService is present but every discovery, registration and resolution fails with
// FAILURE_INTERNAL_ERROR on the client's callback instead of inventing services.
const NSD = "android/net/connectivity/android/net/nsd/", NSD_INFO = "Landroid/net/nsd/NsdServiceInfo;", FAILURE_INTERNAL_ERROR = 0;
class JNsdConnector extends JObj { callback: JObj | null = null; }
const nsdFailure = (callback: string) => function (this: JNsdConnector, key: number) {
  return vcall(this.callback, callback, "(II)V", key, FAILURE_INTERNAL_ERROR);
};
rt.register({ name: "webdroid/NsdServiceConnector", ctor: JNsdConnector, sup: NSD + "INsdServiceConnector$Stub", methods: {
  "discoverServices(ILandroid/net/nsd/DiscoveryRequest;)V": nsdFailure("onDiscoverServicesFailed"),
  [`registerService(IL${NSD}AdvertisingRequest;)V`]: nsdFailure("onRegisterServiceFailed"),
  [`resolveService(I${NSD_INFO})V`]: nsdFailure("onResolveServiceFailed"),
  [`registerServiceInfoCallback(I${NSD_INFO})V`]: nsdFailure("onServiceInfoCallbackRegistrationFailed"),
  ...noops("startDaemon()V"),
} });
rt.register({ name: "webdroid/NsdService", ctor: class extends JObj {}, sup: "android/net/nsd/INsdManager$Stub", methods: {
  [`connect(L${NSD}INsdManagerCallback;Z)L${NSD}INsdServiceConnector;`]: async (callback: JObj) => {
    const connector = await newStub("webdroid/NsdServiceConnector") as JNsdConnector;
    connector.callback = callback;
    return connector;
  },
} });
hostStub("servicediscovery", "webdroid/NsdService");

// IDropBoxManagerService, under AOSP's DropBoxManager: tags are enabled, as by default on a device,
// and entries are accepted; reading them back needs READ_LOGS, which no app holds, so there are none
rt.register({ name: "webdroid/DropBoxManagerService", ctor: class extends JObj {}, sup: "com/android/internal/os/IDropBoxManagerService$Stub", methods: {
  "isTagEnabled(Ljava/lang/String;)Z": () => 1,
  ...noops("addData(Ljava/lang/String;[BI)V", "addFile(Ljava/lang/String;Landroid/os/ParcelFileDescriptor;I)V"),
  "getNextEntryWithAttribution(Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;)Landroid/os/DropBoxManager$Entry;": () => null,
} });
hostStub("dropbox", "webdroid/DropBoxManagerService");

// ── FileObserver: real shape, no eventing (there is no filesystem to watch here).
class JFileObserver extends JObj { paths: unknown = null; mask = 0xfff; }
const fileObserverInit = function (this: JFileObserver, paths: unknown, mask?: number) {
  this.paths = paths;
  if (mask !== undefined) this.mask = mask;
};
rt.register({
  name: "android/os/FileObserver", ctor: JFileObserver,
  statics: {
    ACCESS: 0x001, MODIFY: 0x002, ATTRIB: 0x004, CLOSE_WRITE: 0x008, CLOSE_NOWRITE: 0x010,
    OPEN: 0x020, MOVED_FROM: 0x040, MOVED_TO: 0x080, CREATE: 0x100, DELETE: 0x200,
    DELETE_SELF: 0x400, MOVE_SELF: 0x800, ALL_EVENTS: 0xfff,
  },
  methods: {
    "<init>(Ljava/lang/String;)V": fileObserverInit,
    "<init>(Ljava/lang/String;I)V": fileObserverInit,
    "<init>(Ljava/io/File;)V": fileObserverInit,
    "<init>(Ljava/io/File;I)V": fileObserverInit,
    "<init>(Ljava/util/List;)V": fileObserverInit,
    "<init>(Ljava/util/List;I)V": fileObserverInit,
    ...noops("startWatching()V", "stopWatching()V", "onEvent(ILjava/lang/String;)V"),
  },
});

// ── Marker interfaces. An app class that `implements` one of these cannot link until the
// interface is registered, and the static audit never lists them (dynamic dispatch).
rt.markers("android/os/IInterface");
