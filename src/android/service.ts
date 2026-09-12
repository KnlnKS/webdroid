// System services and binder-ish plumbing: UserManager/UserHandle, FileObserver,
// and the callback/marker interfaces apps implement (ServiceConnection, IInterface,
// Parcelable$ClassLoaderCreator).

import { rt, JObj, stubs, noops } from "../jvm/runtime";
import { newArrayList } from "../jvm/natives/jutil";
import { PARCELABLE } from "./os";

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
    ...PARCELABLE,
    "static getUserHandleForUid(I)Landroid/os/UserHandle;": () => theUser,
  },
});

// ── UserManager: one unlocked, running, non-managed system user.
rt.register({
  name: "android/os/UserManager", ctor: class extends JObj {},
  methods: {
    "getUserName()Ljava/lang/String;": () => "Owner",
    "getUserProfiles()Ljava/util/List;": async () => newArrayList([theUser]),
    ...stubs(1, "isUserUnlocked()Z", "isUserUnlocked(Landroid/os/UserHandle;)Z",
      "isUserRunning(Landroid/os/UserHandle;)Z", "isSystemUser()Z", "getUserCount()I"),
    ...stubs(0, "isUserAGoat()Z", "isDemoUser()Z", "isManagedProfile()Z", "isProfile()Z",
      "isQuietModeEnabled(Landroid/os/UserHandle;)Z", "hasUserRestriction(Ljava/lang/String;)Z"),
    ...stubs(0n, "getSerialNumberForUser(Landroid/os/UserHandle;)J"),
    "getUserForSerialNumber(J)Landroid/os/UserHandle;": () => theUser,
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
