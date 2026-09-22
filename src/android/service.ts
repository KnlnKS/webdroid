// System services and binder-ish plumbing: UserManager/UserHandle, FileObserver,
// and the callback/marker interfaces apps implement (ServiceConnection, IInterface,
// Parcelable$ClassLoaderCreator).

import { rt, JObj, stubs, noops } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jutil";
import { vcall } from "../jvm/natives/jlang";
import { JBundle, JUserHandle, PARCELABLE, PROCESS_UID, reportUncaught, userHandleForUid } from "./os";
import { onMain } from "./mainloop";

// ── UserHandle: handles are canonical per Android user id.
rt.register({
  name: "android/os/UserHandle", ctor: JUserHandle, ifaces: ["android/os/Parcelable"],
  methods: {
    "getIdentifier()I": function (this: JUserHandle) { return this.id; },
    "hashCode()I": function (this: JUserHandle) { return this.id; },
    "equals(Ljava/lang/Object;)Z": function (this: JUserHandle, o: unknown) {
      return o instanceof JUserHandle && o.id === this.id ? 1 : 0;
    },
    "toString()Ljava/lang/String;": function (this: JUserHandle) { return "UserHandle{" + this.id + "}"; },
    ...PARCELABLE,
    "static getUserHandleForUid(I)Landroid/os/UserHandle;": userHandleForUid,
  },
});

// ── UserManager: one unlocked, running, non-managed system user.
rt.register({
  name: "android/os/UserManager", ctor: class extends JObj {},
  methods: {
    "getUserName()Ljava/lang/String;": () => "Owner",
    "getUserProfiles()Ljava/util/List;": async () => newArrayList([userHandleForUid(PROCESS_UID)]),
    ...stubs(1, "isUserUnlocked()Z", "isUserUnlocked(Landroid/os/UserHandle;)Z",
      "isUserRunning(Landroid/os/UserHandle;)Z", "isSystemUser()Z", "getUserCount()I"),
    ...stubs(0, "isUserAGoat()Z", "isDemoUser()Z", "isManagedProfile()Z", "isProfile()Z",
      "isQuietModeEnabled(Landroid/os/UserHandle;)Z", "hasUserRestriction(Ljava/lang/String;)Z"),
    ...stubs(0n, "getSerialNumberForUser(Landroid/os/UserHandle;)J"),
    "getUserForSerialNumber(J)Landroid/os/UserHandle;": () => userHandleForUid(PROCESS_UID),
  },
});

rt.register({ name: "android/content/RestrictionsManager", ctor: class extends JObj {}, methods: {
  "getApplicationRestrictions()Landroid/os/Bundle;": () => new JBundle(),
  "hasRestrictionsProvider()Z": () => 0,
} });

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

// DropBox: there is no system log sink here, so every tag is disabled and entries are dropped.
rt.register({
  name: "android/os/DropBoxManager", ctor: class extends JObj {},
  methods: {
    ...noops("addText(Ljava/lang/String;Ljava/lang/String;)V", "addData(Ljava/lang/String;[BI)V", "addFile(Ljava/lang/String;Ljava/io/File;I)V"),
    ...stubs(0, "isTagEnabled(Ljava/lang/String;)Z"),
    "getNextEntry(Ljava/lang/String;J)Landroid/os/DropBoxManager$Entry;": () => null,
  },
});

// getSystemService("permission_controller"). Nothing calls through it; the class only has
// to exist so the lookup doesn't fall through to a Binder stub.
rt.markers("android/permission/PermissionControllerManager");

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
rt.register({ name: "android/os/Parcelable$ClassLoaderCreator", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable$Creator"] });
