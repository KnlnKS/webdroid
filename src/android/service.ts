// System services and binder-ish plumbing: UserManager/UserHandle, FileObserver,
// and the callback/marker interfaces apps implement (ServiceConnection, IInterface,
// Parcelable$ClassLoaderCreator).

import { rt, JObj } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jutil";

// ── UserHandle: single-user device, so one handle stands for the whole system.
class JUserHandle extends JObj { id = 0; }
const theUser = new JUserHandle();
rt.register({
  name: "android/os/UserHandle", ctor: JUserHandle, ifaces: ["android/os/Parcelable"],
  methods: {
    "getIdentifier()I": function (this: JUserHandle) { return this.id; },
    "hashCode()I": function (this: JUserHandle) { return this.id; },
    "equals(Ljava/lang/Object;)Z": function (this: JUserHandle, o: unknown) {
      return o instanceof JUserHandle && o.id === this.id ? 1 : 0;
    },
    "toString()Ljava/lang/String;": function (this: JUserHandle) { return "UserHandle{" + this.id + "}"; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": () => {},
    "static getUserHandleForUid(I)Landroid/os/UserHandle;": () => theUser,
  },
});

// ── UserManager: one unlocked, running, non-managed system user.
rt.register({
  name: "android/os/UserManager", ctor: class extends JObj {},
  methods: {
    "isUserUnlocked()Z": () => 1,
    "isUserUnlocked(Landroid/os/UserHandle;)Z": () => 1,
    "isUserRunning(Landroid/os/UserHandle;)Z": () => 1,
    "isUserAGoat()Z": () => 0,
    "isSystemUser()Z": () => 1,
    "isDemoUser()Z": () => 0,
    "isManagedProfile()Z": () => 0,
    "isProfile()Z": () => 0,
    "isQuietModeEnabled(Landroid/os/UserHandle;)Z": () => 0,
    "hasUserRestriction(Ljava/lang/String;)Z": () => 0,
    "getUserCount()I": () => 1,
    "getUserName()Ljava/lang/String;": () => "Owner",
    "getUserProfiles()Ljava/util/List;": async () => newArrayList([theUser]),
    "getSerialNumberForUser(Landroid/os/UserHandle;)J": () => 0n,
    "getUserForSerialNumber(J)Landroid/os/UserHandle;": () => theUser,
  },
});

// getSystemService("permission_controller"). Nothing calls through it; the class only has
// to exist so the lookup doesn't fall through to a Binder stub.
rt.register({ name: "android/permission/PermissionControllerManager", ctor: class extends JObj {} });

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
    "startWatching()V": () => {},
    "stopWatching()V": () => {},
    "onEvent(ILjava/lang/String;)V": () => {},
  },
});

// ── Marker interfaces. An app class that `implements` one of these cannot link until the
// interface is registered, and the static audit never lists them (dynamic dispatch).
rt.register({ name: "android/content/ServiceConnection", ctor: class extends JObj {} });
rt.register({ name: "android/os/IInterface", ctor: class extends JObj {} });
rt.register({ name: "android/os/Parcelable$ClassLoaderCreator", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable$Creator"] });
