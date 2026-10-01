// System services and binder-ish plumbing: UserHandle, FileObserver,
// and the callback/marker interfaces apps implement (ServiceConnection, IInterface).

import { rt, JObj, noops } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jcoll";
import { hostStub } from "./binder";
import { JUserHandle, PARCELABLE, reportUncaught, userHandleForUid } from "./os";
import { onMain } from "./mainloop";

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

// The browser cannot join the local multicast groups required by DNS-SD. Keep the Android
// service present, but report that discovery could not start instead of inventing devices.
rt.markers("android/net/nsd/NsdManager$DiscoveryListener");
rt.register({
  name: "android/net/nsd/NsdManager", ctor: class extends JObj {},
  statics: { PROTOCOL_DNS_SD: 1, FAILURE_INTERNAL_ERROR: 0, FAILURE_ALREADY_ACTIVE: 3, FAILURE_MAX_LIMIT: 4 },
  methods: {
    "discoverServices(Ljava/lang/String;ILandroid/net/nsd/NsdManager$DiscoveryListener;)V":
      (serviceType: string, _protocol: number, listener: unknown) => {
        if (!listener) return rt.npe();
        void onMain(() => vcall(listener, "onStartDiscoveryFailed", "(Ljava/lang/String;I)V", serviceType, 0)).catch(reportUncaught);
      },
    "stopServiceDiscovery(Landroid/net/nsd/NsdManager$DiscoveryListener;)V":
      (listener: unknown) => {
        if (!listener) return rt.npe();
        throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener not registered");
      },
  },
});

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
rt.register({ name: "android/content/ServiceConnection", ctor: class extends JObj {}, methods: {
  "onNullBinding(Landroid/content/ComponentName;)V": () => {},
  "onBindingDied(Landroid/content/ComponentName;)V": () => {},
} });
rt.markers("android/os/IInterface");
