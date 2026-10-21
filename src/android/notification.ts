// INotificationManager: NotificationManagerService's app-facing half, under AOSP's NotificationManager
// and Notification classes, which run from bytecode. Channels, groups and the notification delegate
// persist per package as PreferencesHelper keeps them, each channel or group as its parcel, in the
// preference store every process shares. Posted notifications are the broker's (NotificationStore),
// each held as the Notification's parcel, as system_server holds a NotificationRecord: an app reads
// back copies, never its own object. Nothing presents them; there is no shade, sound or listener.
// Rules follow the reference AVD's services.jar (NotificationManagerService, PreferencesHelper,
// GroupHelper); its answers to an app were probed with a test app (targetSdk 25, 32 and 35).
import { awaited, JObj, rt, getDeclared, setDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { after, newObj, vcall, scall, iof } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { systemResource } from "./configuration.ts";
import { newArrayList, toJsArray } from "../jvm/natives/jcoll.ts";
import { csText } from "../jvm/natives/jchars.ts";
import { jarray, stringHash } from "../jvm/abi.ts";
import { hostService, hostedService, callingIdentity, withCallingIdentity, serviceContext, parcelled, unparcelled, parceledList, copyParcelable, releaseRights, parcelScope, withParcelScope, type ParcelData, type Caller } from "./binder.ts";
import { setGuestTimeout, clearGuestTimeout, type GuestTimer } from "../guest-clock.ts";
import { postMain } from "./mainloop.ts";
import { preferenceStore, Prefs } from "./sharedprefs.ts";
import type { DataClear } from "../shell/packagedata.ts";
import { packages, ownedBy } from "./packages.ts";
import { FileDescriptors } from "../shell/file-descriptors.ts";
import { StoredParcel } from "../shell/stored-parcel.ts";
import { processRights } from "../native/process-fd.ts";
import { PROCESS_PID } from "./os.ts";
import { appHost } from "./apphost.ts";
import { coverTop, foreground } from "./server/atm.ts";
import { permissionGranted, grantPrompted } from "./permissions.ts";

const N = "android/app/Notification", CHANNEL = "android/app/NotificationChannel", GROUP = "android/app/NotificationChannelGroup";
const DEFAULT_CHANNEL = "miscellaneous", RANKER_GROUP = "ranker_group";
const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";
const IMPORTANCE_NONE = 0, IMPORTANCE_DEFAULT = 3, IMPORTANCE_UNSPECIFIED = -1000;
const FLAG_ONGOING_EVENT = 2, FLAG_AUTO_CANCEL = 16, FLAG_NO_CLEAR = 32, FLAG_FOREGROUND_SERVICE = 64;
const FLAG_LOCAL_ONLY = 256, FLAG_GROUP_SUMMARY = 512, FLAG_AUTOGROUP_SUMMARY = 1024, FLAG_CAN_COLORIZE = 2048;
const FLAG_NO_DISMISS = 8192, FLAG_FSI_REQUESTED_BUT_DENIED = 16384, FLAG_USER_INITIATED_JOB = 32768;
/** cancel(): an app cannot remove a foreground service's, a user-initiated job's or an autogroup summary */
const CANCEL_MUST_NOT_HAVE = FLAG_FOREGROUND_SERVICE | FLAG_USER_INITIATED_JOB | FLAG_AUTOGROUP_SUMMARY;
const CANCEL_ALL_MUST_NOT_HAVE = FLAG_FOREGROUND_SERVICE | FLAG_USER_INITIATED_JOB;
const REASON_APP_CANCEL = 8;
/** config_autoGroupAtCount */
const AUTOGROUP_AT_COUNT = 2;
const MAX_PACKAGE_NOTIFICATIONS = 50, MAX_PACKAGE_ENQUEUE_RATE = 5;

/** a posted notification as its NotificationRecord: what the rules read, and the Notification's parcel */
interface PostedNotification {
  key: string; pkg: string; opPkg: string; id: number; tag: string | null; uid: number; pid: number; userId: number;
  postTime: bigint; channel: string; flags: number; group: string | null; sortKey: string | null;
  /** the group key an adjustment overrides the app's with (GroupHelper's autogroup) */
  override: string | null;
  data: StoredParcel;
}
/** GroupHelper's view of an ungrouped notification; `icon` identifies its small icon as Icon.sameAs compares */
interface Ungrouped { flags: number; icon: string; color: number; visibility: number }
/** the scope a broker's call holds the descriptors of the notifications it reads in */
function brokerScope() {
  const scope = parcelScope();
  if (!scope) throw new Error("Notification decode requires broker descriptor scope");
  return scope;
}
/** NotificationManagerService's notification list and the state its posting rules keep, shared by
 *  every process through the broker */
export class NotificationStore {
  private kernel = new FileDescriptors();
  private epochs = new Map<string, number>();
  bindDescriptors(kernel: FileDescriptors): void { this.kernel = kernel; }
  epoch(pkg: string): number { return this.epochs.get(pkg) ?? 0; }
  async capture(notification: JObj): Promise<StoredParcel> {
    this.kernel.ensureReceiver(PROCESS_PID);
    const kernel = this.kernel;
    const data = await parcelled(notification, kernel.rights(PROCESS_PID));
    return StoredParcel.retain(kernel, PROCESS_PID, data);
  }
  readStored(data: StoredParcel): Promise<JObj> {
    const scope = brokerScope();
    return data.readLocal(PROCESS_PID, (data, rights) => unparcelled(N, data, rights, scope));
  }
  decode(data: ParcelData): JObj | Promise<JObj> { return unparcelled(N, data, this.kernel.rights(PROCESS_PID), brokerScope()); }
  readonly posted: PostedNotification[] = [];
  readonly enqueueRates = new Map<string, { interarrival: number; last: number | null }>();
  /** userId|pkg → its autogroup summary's key (mAutobundledSummaries) */
  readonly autobundled = new Map<string, string>();
  /** userId|pkg → its ungrouped notifications by key (GroupHelper.mUngroupedNotifications) */
  readonly ungrouped = new Map<string, Map<string, Ungrouped>>();
  /** pkg|id of each foreground service's notification (ActiveServices' ServiceRecord.foregroundId) */
  readonly foreground = new Set<string>();
  /** INotificationManager.clearData, unless the clear keeps the package's state: the package's
   *  notifications go, with the grouping state they kept, and its channels unless it cleared its own
   *  data (PreferencesHelper.clearData) */
  async clear(pkg: string, _uid: number | undefined, { fromApp, keepState }: DataClear): Promise<void> {
    if (keepState) return;
    this.epochs.set(pkg, this.epoch(pkg) + 1);
    const removed = this.posted.filter(r => r.pkg === pkg);
    for (let i = this.posted.length; i--;) if (this.posted[i].pkg === pkg) this.posted.splice(i, 1);
    for (const key of [...this.autobundled.keys(), ...this.ungrouped.keys()]) if (key.endsWith("|" + pkg)) { this.autobundled.delete(key); this.ungrouped.delete(key); }
    for (const key of this.foreground) if (key.startsWith(pkg + "|")) this.foreground.delete(key);
    if (!fromApp) preferenceStore.delete(policyFile(pkg));
    await Promise.all(removed.map(r => r.data.close()));
  }
}
export let notificationStore = new NotificationStore();
export function useNotificationStore(store: NotificationStore): void { notificationStore = store; }

const fail = (cls: string, message: string | null): never => { throw rt.mkThrowable(cls, message); };
/** ArrayMap iterates string keys by their Java hash. */
const hashOrder = <T>(items: T[], key: (item: T) => string): T[] =>
  items.map((item, i) => ({ item, hash: stringHash(key(item)), i })).sort((a, b) => a.hash - b.hash || a.i - b.i).map(({ item }) => item);

/** what a binder call hands the service: a copy of the caller's object */
function* copyOf(cls: string, o: JObj): Gen<JObj> { return yield* awaited(copyParcelable(cls, o)); }
function* sliceItems(slice: JObj | null): Gen<JObj[]> {
  return slice ? (yield* awaited(toJsArray(yield vcall(slice, "getList", "()Ljava/util/List;")))) as JObj[] : rt.npe();
}

// ── callers
const SYSTEM_UIDS = new Set([0, 1000, 1001]);
function checkCallerIsSameApp(pkg: string | null, uid = callingIdentity().uid): void {
  if (!(uid === 0 && pkg === "root") && !ownedBy(pkg, uid)) fail("java/lang/SecurityException", `Package ${pkg} is not owned by uid ${uid}`);
}
function checkCallerIsSystemOrSameApp(pkg: string | null): void {
  if (!SYSTEM_UIDS.has(callingIdentity().uid)) checkCallerIsSameApp(pkg);
}
/** a permission no app holds here: Context.enforceCallingPermission's failure */
function denyPermission(permission: string, message: string): never {
  return fail("java/lang/SecurityException", `${message}: Neither user ${callingIdentity().uid} nor current process has ${permission}.`);
}
function enforceSystemOrSystemUIOrSamePackage(pkg: string | null, message: string): void {
  if (SYSTEM_UIDS.has(callingIdentity().uid) || ownedBy(pkg, callingIdentity().uid)) return;
  denyPermission("android.permission.STATUS_BAR_SERVICE", message);
}
function enforceSystemOrSystemUI(message: string): void {
  if (!SYSTEM_UIDS.has(callingIdentity().uid)) denyPermission("android.permission.STATUS_BAR_SERVICE", message);
}
/** Do Not Disturb policy access: granted only in Settings, which no app here can reach */
function denyPolicyAccess(): never { return fail("java/lang/SecurityException", "Notification policy access denied"); }
const targetSdk = (pkg: string) => packages.get(pkg)?.sdk.target ?? 10000;
const packageOf = (uid: number) => [...packages.values()].find((p) => p.uid === uid)?.pkg ?? null;
/** PermissionHelper.hasPermission: the uid holds POST_NOTIFICATIONS */
function hasPermission(uid: number): boolean | Promise<boolean> {
  if (SYSTEM_UIDS.has(uid)) return true;
  const pkg = packageOf(uid);
  return pkg !== null && !!packages.get(pkg)?.requested.has(POST_NOTIFICATIONS) && permissionGranted(pkg, POST_NOTIFICATIONS);
}
/** the system's view of packages: the application's PackageManager over the hosted service */
function* getPM(): Gen<JObj> { return yield vcall(yield* awaited(serviceContext()), "getPackageManager", "()Landroid/content/pm/PackageManager;"); }

// ── PreferencesHelper: a package's channels, groups and delegate
const policyFile = (pkg: string) => "android:notification-policy:" + pkg;
const CHANNEL_KEY = "channel:", GROUP_KEY = "group:", DELEGATE_KEY = "delegate";
const parcelData = (stored: string): ParcelData => ({ bytes: Uint8Array.fromBase64(stored), objects: [] });
class Preferences {
  readonly pkg: string;
  private readonly file: Prefs;
  constructor(pkg: string) { this.pkg = pkg; this.file = new Prefs(policyFile(pkg)); }
  ids(prefix: string): string[] | Promise<string[]> {
    return after(this.file.keys(), keys => hashOrder(keys.filter(k => k.startsWith(prefix)), k => k.slice(prefix.length)).map(k => k.slice(prefix.length)));
  }
  has(prefix: string, id: string): boolean | Promise<boolean> { return after(this.file.get(prefix + id), value => value !== undefined); }
  *read(prefix: string, id: string): Gen<JObj | null> {
    const stored = yield* awaited(this.file.get(prefix + id));
    return typeof stored === "string" ? yield* awaited(unparcelled(prefix === CHANNEL_KEY ? CHANNEL : GROUP, parcelData(stored))) : null;
  }
  *write(prefix: string, id: string, o: JObj): Gen<void> {
    yield* awaited(this.file.set(prefix + id, (yield* awaited(parcelled(o))).bytes.toBase64()));
  }
  remove(key: string): boolean | Promise<boolean> { return this.file.remove(key); }
  *channels(includeDeleted: boolean): Gen<JObj[]> {
    const all: JObj[] = [];
    for (const id of yield* awaited(this.ids(CHANNEL_KEY))) {
      const channel = yield* this.read(CHANNEL_KEY, id);
      if (channel && (includeDeleted || !(yield vcall(channel, "isDeleted", "()Z")))) all.push(channel);
    }
    return all;
  }
}
/** getOrCreatePackagePreferencesLocked: an app targeting below O has the default channel, which
 *  goes once it targets O */
function* preferences(pkg: string): Gen<Preferences> {
  const prefs = new Preferences(pkg), legacy = targetSdk(pkg) < 26;
  if (legacy && !(yield* awaited(prefs.has(CHANNEL_KEY, DEFAULT_CHANNEL)))) {
    const channel = yield newObj(CHANNEL, "(Ljava/lang/String;Ljava/lang/CharSequence;I)V", DEFAULT_CHANNEL,
      yield systemResource("string", "default_notification_channel_label", "getString", "(I)Ljava/lang/String;"), IMPORTANCE_UNSPECIFIED);
    yield* prefs.write(CHANNEL_KEY, DEFAULT_CHANNEL, channel);
  } else if (!legacy && (yield* awaited(prefs.has(CHANNEL_KEY, DEFAULT_CHANNEL)))) yield* awaited(prefs.remove(CHANNEL_KEY + DEFAULT_CHANNEL));
  return prefs;
}
const str = (cs: unknown) => cs == null ? null : csText(cs);

/** PreferencesHelper.createNotificationChannel for the app itself (no Do Not Disturb access) */
function* createChannel(prefs: Preferences, channel: JObj): Gen<boolean> {
  const id: string | null = yield vcall(channel, "getId", "()Ljava/lang/String;");
  if (id === null) rt.npe();
  if (!(yield* awaited(str(yield vcall(channel, "getName", "()Ljava/lang/CharSequence;"))))) fail("java/lang/IllegalArgumentException", null);
  const importance: number = yield vcall(channel, "getImportance", "()I");
  if (importance < IMPORTANCE_NONE || importance > 5) fail("java/lang/IllegalArgumentException", "Invalid importance level");
  const group: string | null = yield vcall(channel, "getGroup", "()Ljava/lang/String;");
  if (group !== null && !(yield* awaited(prefs.has(GROUP_KEY, group)))) fail("java/lang/IllegalArgumentException", "NotificationChannelGroup doesn't exist");
  if (id === DEFAULT_CHANNEL) fail("java/lang/IllegalArgumentException", "Reserved id");
  const existing = yield* prefs.read(CHANNEL_KEY, id!);
  if (existing) {
    // the app may rename, describe and downgrade its channel; the user's settings stay
    let changed = false;
    if (yield vcall(existing, "isDeleted", "()Z")) {
      yield vcall(existing, "setDeleted", "(Z)V", 0); yield vcall(existing, "setDeletedTimeMs", "(J)V", -1n); changed = true;
    }
    const name = yield* awaited(str(yield vcall(channel, "getName", "()Ljava/lang/CharSequence;")));
    if (name !== (yield* awaited(str(yield vcall(existing, "getName", "()Ljava/lang/CharSequence;"))))) { yield vcall(existing, "setName", "(Ljava/lang/CharSequence;)V", name); changed = true; }
    const description: string | null = yield vcall(channel, "getDescription", "()Ljava/lang/String;");
    if (description !== (yield vcall(existing, "getDescription", "()Ljava/lang/String;"))) { yield vcall(existing, "setDescription", "(Ljava/lang/String;)V", description); changed = true; }
    const blockable: number = yield vcall(channel, "isBlockable", "()Z");
    if (blockable !== (yield vcall(existing, "isBlockable", "()Z"))) { yield vcall(existing, "setBlockable", "(Z)V", blockable); changed = true; }
    if (group !== null && (yield vcall(existing, "getGroup", "()Ljava/lang/String;")) === null) { yield vcall(existing, "setGroup", "(Ljava/lang/String;)V", group); changed = true; }
    if ((yield vcall(existing, "getUserLockedFields", "()I")) === 0 && importance < (yield vcall(existing, "getImportance", "()I"))) {
      yield vcall(existing, "setImportance", "(I)V", importance); changed = true;
    }
    if ((yield vcall(existing, "getOriginalImportance", "()I")) === IMPORTANCE_UNSPECIFIED) { yield vcall(existing, "setOriginalImportance", "(I)V", importance); changed = true; }
    if (changed) yield* prefs.write(CHANNEL_KEY, id!, existing);
    return changed;
  }
  if ((yield* awaited(prefs.ids(CHANNEL_KEY))).length >= 5000) fail("java/lang/IllegalStateException", "Limit exceed; cannot create more channels");
  // fields only the user sets start at the package's defaults
  yield vcall(channel, "setBypassDnd", "(Z)V", 0);
  yield vcall(channel, "setLockscreenVisibility", "(I)V", IMPORTANCE_UNSPECIFIED);
  yield vcall(channel, "setAllowBubbles", "(I)V", -1);
  yield vcall(channel, "setImportantConversation", "(Z)V", 0);
  yield vcall(channel, "unlockFields", "(I)V", yield vcall(channel, "getUserLockedFields", "()I"));
  yield vcall(channel, "setImportanceLockedByCriticalDeviceFunction", "(Z)V", 0);
  yield vcall(channel, "setOriginalImportance", "(I)V", importance);
  const parent: string | null = yield vcall(channel, "getParentChannelId", "()Ljava/lang/String;");
  if (parent !== null && !(yield* awaited(prefs.has(CHANNEL_KEY, parent)))) fail("java/lang/IllegalArgumentException", "Tried to create a conversation channel without a preexisting parent");
  yield* prefs.write(CHANNEL_KEY, id!, channel);
  return true;
}
function* createGroup(prefs: Preferences, group: JObj): Gen<void> {
  const id: string | null = yield vcall(group, "getId", "()Ljava/lang/String;");
  if (id === null) rt.npe();
  if (!(yield* awaited(str(yield vcall(group, "getName", "()Ljava/lang/CharSequence;"))))) fail("java/lang/IllegalArgumentException", "group.getName() can't be empty");
  if ((yield* awaited(prefs.ids(GROUP_KEY))).length >= 6000) fail("java/lang/IllegalStateException", "Limit exceed; cannot create more groups");
  yield vcall(group, "setBlocked", "(Z)V", 0);
  const existing = yield* prefs.read(GROUP_KEY, id!);
  if (existing) {
    yield vcall(group, "setChannels", "(Ljava/util/List;)V", yield vcall(existing, "getChannels", "()Ljava/util/List;"));
    yield vcall(group, "setBlocked", "(Z)V", yield vcall(existing, "isBlocked", "()Z"));
    yield vcall(group, "unlockFields", "(I)V", yield vcall(group, "getUserLockedFields", "()I"));
    yield vcall(group, "lockFields", "(I)V", yield vcall(existing, "getUserLockedFields", "()I"));
  }
  yield* prefs.write(GROUP_KEY, id!, group);
}
/** getNotificationChannelGroupWithChannels */
function* groupWithChannels(prefs: Preferences, id: string | null, includeDeleted: boolean): Gen<JObj | null> {
  const group = id === null ? null : yield* prefs.read(GROUP_KEY, id);
  if (!group) return null;
  yield vcall(group, "setChannels", "(Ljava/util/List;)V", yield newArrayList());
  for (const channel of yield* prefs.channels(includeDeleted)) {
    if ((yield vcall(channel, "getGroup", "()Ljava/lang/String;")) === id) yield vcall(group, "addChannel", "(Landroid/app/NotificationChannel;)V", channel);
  }
  return group;
}
/** getConversationNotificationChannel without a conversation: the channel a notification posts to */
function* channelFor(prefs: Preferences, id: string | null, includeDeleted = false): Gen<JObj | null> {
  const channel = yield* prefs.read(CHANNEL_KEY, id ?? DEFAULT_CHANNEL);
  return channel && (includeDeleted || !(yield vcall(channel, "isDeleted", "()Z"))) ? channel : null;
}
function* deleteChannel(prefs: Preferences, channel: JObj): Gen<void> {
  if (yield vcall(channel, "isDeleted", "()Z")) return;
  yield vcall(channel, "setDeleted", "(Z)V", 1);
  yield vcall(channel, "setDeletedTimeMs", "(J)V", BigInt(Date.now()));
  yield* prefs.write(CHANNEL_KEY, yield vcall(channel, "getId", "()Ljava/lang/String;"), channel);
}
function enforceNoForegroundService(pkg: string, userId: number, channel: string): void {
  if (notificationStore.posted.some((r) => r.pkg === pkg && r.userId === userId && r.channel === channel && r.flags & FLAG_FOREGROUND_SERVICE))
    fail("java/lang/SecurityException", `Not allowed to delete channel ${channel} with a foreground service`);
}

/** PermissionPolicyService's notification prompt for an app targeting 6.0 to 12L, which cannot ask
 *  for POST_NOTIFICATIONS itself: once it has a channel, the system asks when a launcher task is in
 *  front. The dialog's answer follows the grant policy runtime permissions follow. */
function promptNeeded(pkg: string): boolean | Promise<boolean> {
  const record = packages.get(pkg), target = targetSdk(pkg);
  return !!record && target >= 23 && target < 33 && pkg === appHost?.pkg && record.requested.has(POST_NOTIFICATIONS)
    && after(new Preferences(pkg).ids(CHANNEL_KEY), ids => ids.length > 0 && after(permissionGranted(pkg, POST_NOTIFICATIONS), granted => !granted));
}
function showNotificationPrompt(pkg: string): unknown {
  return after(grantPrompted(pkg, POST_NOTIFICATIONS), () => coverTop());
}

// ── the notification list
const keyOf = (userId: number, pkg: string, id: number, tag: string | null, uid: number) => `${userId}|${pkg}|${id}|${tag}|${uid}`;
const packageKey = (userId: number, pkg: string) => `${userId}|${pkg}`;
const isAppGroup = (r: PostedNotification) => r.group !== null || r.sortKey !== null;
const isGroup = (r: PostedNotification) => r.override !== null || isAppGroup(r);
const isGroupSummary = (r: PostedNotification) => r.group !== null && (r.flags & FLAG_GROUP_SUMMARY) !== 0;
/** StatusBarNotification.groupKey */
function groupKey(r: PostedNotification): string {
  if (r.override !== null) return `${r.userId}|${r.pkg}|g:${r.override}`;
  if (!isAppGroup(r)) return r.key;
  return `${r.userId}|${r.pkg}|${r.group === null ? "c:" + r.channel : "g:" + r.group}`;
}
const find = (pkg: string, tag: string | null, id: number, userId: number) =>
  notificationStore.posted.find((r) => r.pkg === pkg && r.tag === tag && r.id === id && r.userId === userId) ?? null;
function* statusBarNotification(r: PostedNotification): Gen<JObj> {
  const notification = yield* awaited(notificationStore.readStored(r.data));
  const user = yield scall("android/os/UserHandle", "of", "(I)Landroid/os/UserHandle;", r.userId);
  return yield newObj("android/service/notification/StatusBarNotification",
    "(Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;IILandroid/app/Notification;Landroid/os/UserHandle;Ljava/lang/String;J)V",
    r.pkg, r.opPkg, r.id, r.tag, r.uid, r.pid, notification, user, r.override, r.postTime);
}
/** cancelNotificationLocked: off the list, out of GroupHelper's view */
function* removeRecords(removed: PostedNotification[]): Gen<void> {
  if (!removed.length) return;
  const list = notificationStore.posted;
  for (const r of removed) {
    const i = list.indexOf(r);
    if (i >= 0) list.splice(i, 1);
    const pk = packageKey(r.userId, r.pkg);
    if (notificationStore.autobundled.get(pk) === r.key) notificationStore.autobundled.delete(pk);
  }
  yield* awaited(Promise.all(removed.map(r => r.data.close())));
  for (const r of removed) yield* groupHelperUngroup(r, true);
}
/** cancelGroupChildrenLocked: a summary's children go with it, except those `keep` spares */
function groupChildren(summary: PostedNotification, keep: (flags: number) => boolean): PostedNotification[] {
  if (!isGroupSummary(summary)) return [];
  const key = groupKey(summary);
  return notificationStore.posted.filter((r) => r.pkg === summary.pkg && r.userId === summary.userId && r !== summary
    && isGroup(r) && !isGroupSummary(r) && groupKey(r) === key && !keep(r.flags));
}
/** CancelNotificationRunnable */
function* cancelNotification(pkg: string, tag: string | null, id: number, mustHave: number, mustNotHave: number, userId: number, reason: number): Gen<void> {
  const r = find(pkg, tag, id, userId);
  if (!r || (r.flags & mustHave) !== mustHave || r.flags & mustNotHave) return;
  const spared = (flags: number) => reason === REASON_APP_CANCEL && (flags & (FLAG_FOREGROUND_SERVICE | FLAG_USER_INITIATED_JOB)) !== 0 || (flags & mustNotHave) !== 0;
  yield* removeRecords([r, ...groupChildren(r, spared)]);
}
/** cancelAllNotificationsInt for a package, optionally one channel's */
function* cancelAll(pkg: string, channel: string | null, mustNotHave: number, userId: number): Gen<void> {
  yield* removeRecords(notificationStore.posted.filter((r) => r.pkg === pkg && r.userId === userId
    && (channel === null || r.channel === channel) && !(r.flags & mustNotHave)));
}

// ── GroupHelper: two or more ungrouped notifications are bundled under a summary the system posts
function* iconIdentity(icon: JObj | null): Gen<string> {
  if (!icon) return "none";
  const type: number = yield vcall(icon, "getType", "()I");
  if (type === 2) return `res:${yield vcall(icon, "getResPackage", "()Ljava/lang/String;")}:${yield vcall(icon, "getResId", "()I")}`;
  if (type === 4 || type === 6) return `uri:${type}:${yield vcall(icon, "getUriString", "()Ljava/lang/String;")}`;
  return `object:${nextIcon++}`;
}
let nextIcon = 0;
const summaryFlags = (members: Map<string, Ungrouped>) => {
  let all = members.size > 0, ongoing = 0;
  for (const m of members.values()) { if (!(m.flags & FLAG_AUTO_CANCEL)) all = false; ongoing |= m.flags & (FLAG_ONGOING_EVENT | FLAG_NO_CLEAR); }
  return (all ? FLAG_AUTO_CANCEL : 0) | FLAG_AUTOGROUP_SUMMARY | FLAG_GROUP_SUMMARY | FLAG_LOCAL_ONLY | ongoing;
};
/** getAutobundledSummaryAttributes: the members' shared icon and color, public if any member is */
function* summaryLook(pkg: string, members: Ungrouped[]): Gen<{ icon: JObj; color: number; visibility: number }> {
  const sameIcon = members.every((m) => m.icon === members[0].icon && !m.icon.startsWith("object:"));
  const color = members.every((m) => m.color === members[0].color) ? members[0].color : 0;
  const visibility = members.some((m) => m.visibility === 1) ? 1 : 0;
  let icon: JObj | null = null;
  if (sameIcon) {
    const holder = notificationStore.posted.find((r) => notificationStore.ungrouped.get(packageKey(r.userId, r.pkg))?.get(r.key)?.icon === members[0].icon);
    if (holder) icon = yield vcall(yield* awaited(notificationStore.readStored(holder.data)), "getSmallIcon", "()Landroid/graphics/drawable/Icon;");
  }
  return { icon: icon ?? (yield* monochromeAppIcon(pkg)), color, visibility };
}
function* monochromeAppIcon(pkg: string): Gen<JObj> {
  const drawable = yield vcall(yield* getPM(), "getApplicationIcon", "(Ljava/lang/String;)Landroid/graphics/drawable/Drawable;", pkg);
  if (iof(drawable, "android/graphics/drawable/AdaptiveIconDrawable") && (yield vcall(drawable, "getMonochrome", "()Landroid/graphics/drawable/Drawable;"))) {
    const inset: number = yield scall("android/graphics/drawable/AdaptiveIconDrawable", "getExtraInsetFraction", "()F");
    return yield scall("android/graphics/drawable/Icon", "createWithResourceAdaptiveDrawable", "(Ljava/lang/String;IZF)Landroid/graphics/drawable/Icon;",
      pkg, yield vcall(drawable, "getSourceDrawableResId", "()I"), 1, inset * -2);
  }
  return yield scall("android/graphics/drawable/Icon", "createWithResource", "(Ljava/lang/String;I)Landroid/graphics/drawable/Icon;", "android",
    yield systemResource("drawable", "ic_menu_cut_holo_light"));
}
function* groupHelperPosted(r: PostedNotification, notification: JObj): Gen<void> {
  const pk = packageKey(r.userId, r.pkg), hasSummary = notificationStore.autobundled.has(pk);
  if (isAppGroup(r)) return yield* groupHelperUngroup(r, false);
  let members = notificationStore.ungrouped.get(pk);
  if (!members) notificationStore.ungrouped.set(pk, members = new Map());
  const icon = yield* iconIdentity(yield vcall(notification, "getSmallIcon", "()Landroid/graphics/drawable/Icon;"));
  members.set(r.key, { flags: r.flags, icon, color: getDeclared<number>(notification, N, "color"), visibility: getDeclared<number>(notification, N, "visibility") });
  if (members.size < AUTOGROUP_AT_COUNT && !hasSummary) return;
  const flags = summaryFlags(members), keys = [...members.keys()];
  if (hasSummary) yield* updateAutobundledSummary(r, flags, [...members.values()]);
  else yield* addAutoGroupSummary(r, flags, [...members.values()]);
  for (const key of keys) {
    const member = notificationStore.posted.find((m) => m.key === key);
    if (member && member.override === null) member.override = RANKER_GROUP;
  }
}
function* groupHelperUngroup(r: PostedNotification, removed: boolean): Gen<void> {
  const pk = packageKey(r.userId, r.pkg), members = notificationStore.ungrouped.get(pk), member = members?.get(r.key);
  if (!members?.size || !member) return;
  members.delete(r.key);
  if (!members.size) {
    const summary = notificationStore.autobundled.get(pk);
    notificationStore.autobundled.delete(pk);
    const record = summary && notificationStore.posted.find((s) => s.key === summary);
    if (record) yield* removeRecords([record]);
  } else if (member.flags & (FLAG_ONGOING_EVENT | FLAG_NO_CLEAR)) yield* updateAutobundledSummary(r, summaryFlags(members), [...members.values()]);
  if (!removed && r.override !== null) r.override = null;
}
/** createAutoGroupSummary, posted as the app's own notification */
function* addAutoGroupSummary(trigger: PostedNotification, flags: number, members: Ungrouped[]): Gen<void> {
  const pk = packageKey(trigger.userId, trigger.pkg);
  const epoch = notificationStore.epoch(trigger.pkg);
  if (notificationStore.autobundled.has(pk)) return;
  const look = yield* summaryLook(trigger.pkg, members);
  const context = yield* awaited(serviceContext());
  const triggering = yield* awaited(notificationStore.readStored(trigger.data));
  let builder = yield newObj(`${N}$Builder`, "(Landroid/content/Context;Ljava/lang/String;)V", context, trigger.channel);
  const B = `L${N}$Builder;`;
  builder = yield vcall(builder, "setSmallIcon", `(Landroid/graphics/drawable/Icon;)${B}`, look.icon);
  builder = yield vcall(builder, "setGroupSummary", `(Z)${B}`, 1);
  builder = yield vcall(builder, "setGroupAlertBehavior", `(I)${B}`, 2);
  builder = yield vcall(builder, "setGroup", `(Ljava/lang/String;)${B}`, RANKER_GROUP);
  builder = yield vcall(builder, "setFlag", `(IZ)${B}`, flags, 1);
  builder = yield vcall(builder, "setColor", `(I)${B}`, look.color);
  builder = yield vcall(builder, "setVisibility", `(I)${B}`, look.visibility);
  const summary = yield vcall(builder, "build", `()L${N};`);
  const extras = getDeclared<JObj>(summary, N, "extras");
  yield vcall(extras, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "android.appInfo",
    yield vcall(getDeclared<JObj>(triggering, N, "extras"), "getParcelable", "(Ljava/lang/String;)Landroid/os/Parcelable;", "android.appInfo"));
  const launch = yield vcall(yield* getPM(), "getLaunchIntentForPackage", "(Ljava/lang/String;)Landroid/content/Intent;", trigger.pkg);
  if (launch && context) setDeclared(summary, N, { contentIntent: yield scall("android/app/PendingIntent", "getActivity",
    "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 0, launch, 0x4000000) });
  const record: PostedNotification = {
    ...trigger, key: `${keyOf(trigger.userId, trigger.pkg, 0x7fffffff, RANKER_GROUP, trigger.uid)}|${RANKER_GROUP}`, id: 0x7fffffff, tag: RANKER_GROUP,
    postTime: BigInt(Date.now()), flags: getDeclared<number>(summary, N, "flags"), group: RANKER_GROUP, sortKey: null, override: RANKER_GROUP, data: yield* awaited(notificationStore.capture(summary)),
  };
  try {
    if (epoch !== notificationStore.epoch(trigger.pkg) || !notificationStore.posted.includes(trigger)) return;
    notificationStore.autobundled.set(pk, record.key);
    if (!(yield* awaited(hasPermission(record.uid))) || (yield* channelImportance(record)) === IMPORTANCE_NONE) return;
    if (epoch !== notificationStore.epoch(trigger.pkg) || !notificationStore.posted.includes(trigger)) return;
    const old = insert(record);
    if (old) yield* awaited(old.data.close());
  } finally { if (!notificationStore.posted.includes(record)) yield* awaited(record.data.close()); }
}
/** updateAutobundledSummaryLocked: the summary follows its members' flags and look */
function* updateAutobundledSummary(trigger: PostedNotification, flags: number, members: Ungrouped[]): Gen<void> {
  const key = notificationStore.autobundled.get(packageKey(trigger.userId, trigger.pkg));
  const record = key && notificationStore.posted.find((r) => r.key === key);
  if (!record) return;
  const previous = record.data;
  const summary = yield* awaited(notificationStore.readStored(record.data)), look = yield* summaryLook(trigger.pkg, members);
  const sameLook = (yield* iconIdentity(yield vcall(summary, "getSmallIcon", "()Landroid/graphics/drawable/Icon;"))) === (yield* iconIdentity(look.icon))
    && getDeclared<number>(summary, N, "color") === look.color && getDeclared<number>(summary, N, "visibility") === look.visibility;
  if (record.flags === flags && sameLook) return;
  setDeclared(summary, N, { flags });
  yield vcall(summary, "setSmallIcon", "(Landroid/graphics/drawable/Icon;)V", look.icon);
  setDeclared(summary, N, { color: look.color, visibility: look.visibility });
  const data = yield* awaited(notificationStore.capture(summary));
  if (!notificationStore.posted.includes(record) || record.data !== previous) { yield* awaited(data.close()); return; }
  const old = record.data; record.flags = flags; record.data = data;
  yield* awaited(old.close());
}
function* channelImportance(r: PostedNotification): Gen<number> {
  const channel = yield* channelFor(new Preferences(r.pkg), r.channel, true);
  return channel ? yield vcall(channel, "getImportance", "()I") : IMPORTANCE_NONE;
}
/** PostNotificationRunnable's list update: a new key is added, an existing one replaced in place */
function insert(r: PostedNotification): PostedNotification | null {
  const list = notificationStore.posted, i = list.findIndex((o) => o.key === r.key);
  if (i < 0) { list.push(r); return null; }
  const old = list[i];
  list[i] = r;
  return old;
}

// ── posting
/** Notification.isStyle(Notification$<style>.class), the class named through Class.forName */
function* isStyle(n: JObj, style: string): Gen<number> {
  const cls = yield scall("java/lang/Class", "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", `${N}$${style}`.replace(/\//g, "."), 0, null);
  return yield vcall(n, "isStyle", "(Ljava/lang/Class;)Z", cls);
}
/** NotificationManagerService.fixNotification: what the service corrects in what an app sends */
function* fixNotification(n: JObj, pkg: string, foreground: boolean): Gen<void> {
  const info = yield vcall(yield* getPM(), "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 0);
  yield scall(N, "addFieldsFromContext", "(Landroid/content/pm/ApplicationInfo;Landroid/app/Notification;)V", info, n);
  const target = targetSdk(pkg);
  let flags: number = getDeclared<number>(n, N, "flags");
  // only ActivityManagerService's foreground services and JobScheduler's user-initiated jobs carry
  // these, and their notifications do not cancel on a tap
  flags &= ~FLAG_USER_INITIATED_JOB;
  flags = foreground ? flags & ~FLAG_AUTO_CANCEL | FLAG_FOREGROUND_SERVICE : flags & ~FLAG_FOREGROUND_SERVICE;
  const media: number = yield vcall(n, "isMediaNotification", "()Z");
  const call: number = yield* isStyle(n, "CallStyle");
  flags = flags & FLAG_ONGOING_EVENT && (media || call) ? flags | FLAG_NO_DISMISS : flags & ~FLAG_NO_DISMISS;
  flags &= ~(FLAG_CAN_COLORIZE | FLAG_FSI_REQUESTED_BUT_DENIED);
  const extras: JObj = getDeclared<JObj>(n, N, "extras");
  for (const key of ["android.allowDuringSetup", "android.substName"]) yield vcall(extras, "remove", "(Ljava/lang/String;)V", key);
  if (getDeclared<JObj | null>(n, N, "fullScreenIntent") && !canUseFullScreenIntent(pkg, target)) {
    // makeStickyHun: the full-screen intent becomes the content intent of a persistent heads-up
    if (packages.get(pkg)?.requested.has("android.permission.USE_FULL_SCREEN_INTENT")) flags |= FLAG_FSI_REQUESTED_BUT_DENIED;
    if (!getDeclared<JObj | null>(n, N, "contentIntent")) setDeclared(n, N, { contentIntent: getDeclared<JObj | null>(n, N, "fullScreenIntent") });
    setDeclared(n, N, { fullScreenIntent: null });
  }
  const actions = getDeclared<(JObj | null)[] | null>(n, N, "actions");
  if (actions?.includes(null)) {
    const kept = actions.filter((a) => a !== null);
    setDeclared(n, N, { actions: kept.length ? jarray(kept, `L${N}$Action;`) : null });
  }
  if ((yield* isStyle(n, "MediaStyle")) || (yield* isStyle(n, "DecoratedMediaCustomViewStyle"))) {
    for (const key of ["android.mediaRemoteDevice", "android.mediaRemoteIcon", "android.mediaRemoteIntent"]) yield vcall(extras, "remove", "(Ljava/lang/String;)V", key);
    // MEDIA_STYLE_NOTIFICATION_NOT_DISMISSABLE, from Android 14
    if (target >= 34) flags |= FLAG_NO_CLEAR;
  }
  setDeclared(n, N, { flags });
}
/** checkUseFullScreenIntentPermission: free below Android 10, then USE_FULL_SCREEN_INTENT and its app op */
function canUseFullScreenIntent(pkg: string, target: number): boolean {
  return target < 29 || !!packages.get(pkg)?.requested.has("android.permission.USE_FULL_SCREEN_INTENT");
}
/** a package's enqueue rate (NotificationUsageStats' RateEstimator), updated per accepted enqueue */
function enqueueRate(pkg: string, now: number, update: boolean): number {
  let rate = notificationStore.enqueueRates.get(pkg);
  if (!rate) notificationStore.enqueueRates.set(pkg, rate = { interarrival: 1000, last: null });
  const estimate = () => rate.interarrival * 0.7 + Math.max((now - rate.last!) / 1000, 0.0005) * 0.3;
  if (!update) return rate.last === null ? 0 : 1 / estimate();
  if (rate.last !== null) rate.interarrival = estimate();
  rate.last = now;
  return 0;
}
function* enqueueNotification(pkg: string | null, opPkg: string | null, tag: string | null, id: number, notification: JObj | null, userId: number,
  fromService = false): Gen<void> {
  if (pkg === null || notification === null) fail("java/lang/IllegalArgumentException", `null not allowed: pkg=${pkg} id=${id} notification=${notification === null ? "null" : yield vcall(notification, "toString", "()Ljava/lang/String;")}`);
  const epoch = notificationStore.epoch(pkg!);
  const { uid, pid } = callingIdentity();
  if (userId === -1) userId = 0;
  const notifyUid = yield* awaited(resolveNotificationUid(opPkg, pkg!, uid, userId));
  const n = yield* copyOf(N, notification!);
  // applyForegroundServiceNotification: the app may update its foreground service's notification
  const foreground = fromService || tag === null && notificationStore.foreground.has(foregroundKey(pkg!, id)) && (getDeclared<number>(n, N, "flags") & FLAG_FOREGROUND_SERVICE) !== 0;
  yield* fixNotification(n, pkg!, foreground);
  const prefs = yield* preferences(pkg!);
  const channelId: string | null = yield vcall(n, "getChannelId", "()Ljava/lang/String;");
  const shortcut: string | null = yield vcall(n, "getShortcutId", "()Ljava/lang/String;");
  const channel = yield* channelFor(prefs, channelId, shortcut !== null);
  if (!channel) {
    console.warn(`[notification] No Channel found for pkg=${pkg}, channelId=${channelId}, id=${id}, tag=${tag}, opPkg=${opPkg}, callingUid=${uid}, userId=${userId}`);
    return;
  }
  const key = keyOf(userId, pkg!, id, tag, notifyUid), old = notificationStore.posted.find((r) => r.key === key) ?? null;
  // checkDisqualifyingFeatures
  if (!SYSTEM_UIDS.has(notifyUid)) {
    if (old && !(yield vcall(n, "hasCompletedProgress", "()Z")) && enqueueRate(pkg!, performance.now(), false) > MAX_PACKAGE_ENQUEUE_RATE) return;
    const count = notificationStore.posted.filter((r) => r.pkg === pkg && r.userId === userId && !(r.id === id && r.tag === tag)).length;
    if (!foreground && count >= MAX_PACKAGE_NOTIFICATIONS) {
      console.warn(`[notification] Package has already posted or enqueued ${count} notifications.  Not showing more.  package=${pkg}`);
      return;
    }
  }
  if (!foreground && (yield* isStyle(n, "CallStyle")) && !getDeclared<JObj | null>(n, N, "fullScreenIntent") && !(getDeclared<number>(n, N, "flags") & FLAG_FSI_REQUESTED_BUT_DENIED))
    fail("java/lang/IllegalArgumentException", `${key} Not posted. CallStyle notifications must be for a foreground service or user initated job or use a fullScreenIntent.`);
  // a media notification is posted even when its app may not post others
  const media: number = yield vcall(n, "isMediaNotification", "()Z");
  if (!media && (!(yield* awaited(hasPermission(notifyUid))) || (yield vcall(channel, "getImportance", "()I")) === IMPORTANCE_NONE)) return;
  enqueueRate(pkg!, performance.now(), true);
  // handleGroupedNotificationLocked: a summary flag without an app group is dropped
  let flags: number = getDeclared<number>(n, N, "flags");
  const group: string | null = yield vcall(n, "getGroup", "()Ljava/lang/String;"), sortKey: string | null = yield vcall(n, "getSortKey", "()Ljava/lang/String;");
  if (flags & FLAG_GROUP_SUMMARY && group === null && sortKey === null) flags &= ~FLAG_GROUP_SUMMARY;
  if (old) flags |= old.flags & FLAG_FOREGROUND_SERVICE;
  if (flags & FLAG_FOREGROUND_SERVICE) flags |= FLAG_NO_CLEAR;
  setDeclared(n, N, { flags });
  const record: PostedNotification = {
    key, pkg: pkg!, opPkg: opPkg ?? pkg!, id, tag, uid: notifyUid, pid, userId, postTime: BigInt(Date.now()),
    channel: yield vcall(channel, "getId", "()Ljava/lang/String;"), flags, group, sortKey, override: old?.override ?? null, data: yield* awaited(notificationStore.capture(n)),
  };
  try {
    if (old && isGroupSummary(old) && (!isGroupSummary(record) || groupKey(old) !== groupKey(record)))
      yield* removeRecords(groupChildren(old, (f) => (f & (FLAG_FOREGROUND_SERVICE | FLAG_USER_INITIATED_JOB)) !== 0));
    if (epoch !== notificationStore.epoch(pkg!)) return;
    const replaced = insert(record);
    if (replaced) yield* awaited(replaced.data.close());
  } finally { if (!notificationStore.posted.includes(record)) yield* awaited(record.data.close()); }
  // GroupHelper sees a post that is new or changed its group or flags
  if ((yield vcall(n, "getSmallIcon", "()Landroid/graphics/drawable/Icon;")) && (!old || old.group !== record.group || old.flags !== record.flags))
    yield* groupHelperPosted(record, n);
}
/** resolveNotificationUid: an app posts as itself, or for a package that made it its delegate */
function resolveNotificationUid(opPkg: string | null, pkg: string, uid: number, userId: number): number | Promise<number> {
  if (ownedBy(pkg, uid) && (opPkg === pkg || ownedBy(opPkg, uid))) return uid;
  const owner = packages.get(pkg);
  if (owner && SYSTEM_UIDS.has(uid) && pkg === "android") return owner.uid;
  return after(delegateOf(pkg), delegate => {
    if (owner && delegate === opPkg && ownedBy(opPkg, uid)) return owner.uid;
    return fail("java/lang/SecurityException", `Caller ${opPkg}:${uid} cannot post for pkg ${pkg} in user ${userId}`);
  });
}
function delegateOf(pkg: string): string | null | Promise<string | null> {
  return after(new Prefs(policyFile(pkg)).get(DELEGATE_KEY), value => typeof value === "string" ? value : null);
}

// ── ActiveServices: a foreground service's notification
const foregroundKey = (pkg: string, id: number) => `${pkg}|${id}`;
/** Service.startForeground: the notification posts under the service's id, as the app's, with
 *  FLAG_FOREGROUND_SERVICE, which no app may set itself */
export type ForegroundNotificationRequest = { kind: "start"; id: number; data: ParcelData | null }
  | { kind: "stop"; id: number; remove: boolean };
export const notificationTransport = { foreground: null as ((request: ForegroundNotificationRequest) => Promise<void>) | null };
export function receiveForegroundNotification(pkg: string, caller: Caller, request: ForegroundNotificationRequest): Promise<void> {
  return withCallingIdentity(caller, () => withParcelScope(() => rt.drive(function* (): Gen<void> {
    if (request.kind === "stop") return yield* stopForeground(pkg, request.id, request.remove);
    if (request.data?.objects.some(([,o]) => o && "bytes" in o)) fail("android/os/BadParcelableException", "Notification descriptors require transferred rights");
    const notification = request.data ? yield* awaited(notificationStore.decode(request.data)) : null;
    yield* startForeground(pkg, request.id, notification);
  }())));
}
export const startForegroundNotification = driven(function* (id: number, notification: JObj | null): Gen<void> {
  if (notificationTransport.foreground) {
    const data = notification && (yield* awaited(parcelled(notification, processRights)));
    try { yield* awaited(notificationTransport.foreground({ kind: "start", id, data })); }
    finally { if (data) yield* awaited(releaseRights(data, processRights, true)); }
    return;
  }
  yield* awaited(withParcelScope(() => rt.drive(startForeground(appHost?.pkg, id, notification))));
});
function* startForeground(pkg: string | undefined, id: number, notification: JObj | null): Gen<void> {
  if (!pkg || !id) return;
  if (notification === null) fail("java/lang/IllegalArgumentException", "null notification");
  notificationStore.foreground.add(foregroundKey(pkg, id));
  yield* enqueueNotification(pkg, pkg, null, id, notification, 0, true);
}
/** stopForeground, and the service's end: removed, or left behind without FLAG_FOREGROUND_SERVICE */
export const stopForegroundNotification = driven(function* (id: number, remove: boolean): Gen<void> {
  if (notificationTransport.foreground) {
    yield* awaited(notificationTransport.foreground({ kind: "stop", id, remove }));
    return;
  }
  yield* awaited(withParcelScope(() => rt.drive(stopForeground(appHost?.pkg, id, remove))));
});
function* stopForeground(pkg: string | undefined, id: number, remove: boolean): Gen<void> {
  if (!pkg) return;
  notificationStore.foreground.delete(foregroundKey(pkg, id));
  const r = find(pkg, null, id, 0);
  if (!r) return;
  if (remove) return yield* removeRecords([r]);
  const previous = r.data;
  const n = yield* awaited(notificationStore.readStored(r.data));
  const flags = r.flags & ~FLAG_FOREGROUND_SERVICE;
  setDeclared(n, N, { flags });
  const data = yield* awaited(notificationStore.capture(n));
  if (!notificationStore.posted.includes(r) || r.data !== previous) { yield* awaited(data.close()); return; }
  const old = r.data; r.flags = flags; r.data = data;
  yield* awaited(old.close());
}

const POLICY = "android/app/NotificationManager$Policy";
/** the reference AVD's Do Not Disturb policy: alarms, media, messages, calls, repeat callers and
 *  conversations; starred senders and important conversations; effects suppressed but for the
 *  status bar, badges and notification list */
const policy = () => newObj(POLICY, "(IIIIII)V", 380, 2, 2, 157, 0, 2);
const ZEN_MODE_OFF = 0;

// NotificationManagerService's toasts: one shows at a time, for SHORT_DELAY or LONG_DELAY. A text
// toast draws as SystemUI's ToastUI draws it, through ToastPresenter at config_toastDefaultGravity
// and toast_y_offset; a custom one shows through its own ITransientNotification.
const TOAST_DELAY = [2000, 3500];
interface ToastRecord { pkg: string; token: JObj; text: unknown; duration: number; callback: JObj | null; custom: JObj | null; presenter?: JObj; timer?: GuestTimer }
const toastQueue: ToastRecord[] = [];
const T = "Landroid/app/ITransientNotificationCallback;";
function* showToast(service: JObj, t: ToastRecord): Gen<void> {
  const windowToken = yield newObj("android/os/Binder", "()V");
  if (t.custom) yield vcall(t.custom, "show", "(Landroid/os/IBinder;)V", windowToken);
  else {
    const ctx = yield* awaited(serviceContext());
    const gravity = yield systemResource("integer", "config_toastDefaultGravity", "getInteger", "(I)I");
    const y = yield systemResource("dimen", "toast_y_offset", "getDimensionPixelSize", "(I)I");
    t.presenter = yield newObj("android/widget/ToastPresenter", "(Landroid/content/Context;Landroid/view/accessibility/IAccessibilityManager;Landroid/app/INotificationManager;Ljava/lang/String;)V",
      ctx, yield* awaited(hostedService("accessibility")), service, t.pkg);
    const view = yield scall("android/widget/ToastPresenter", "getTextToastView", "(Landroid/content/Context;Ljava/lang/CharSequence;)Landroid/view/View;", ctx, t.text);
    yield vcall(t.presenter, "show", `(Landroid/view/View;Landroid/os/IBinder;Landroid/os/IBinder;IIIIFF${T}Z)V`, view, t.token, windowToken, t.duration, gravity, 0, y, 0, 0, t.callback, 0);
  }
  t.timer = setGuestTimeout(() => postMain(() => rt.drive(hideToast(t)), logUncaught), TOAST_DELAY[t.duration ? 1 : 0]);
}
function* hideToast(t: ToastRecord): Gen<void> {
  const i = toastQueue.indexOf(t);
  if (i < 0) return;
  if (i > 0) { toastQueue.splice(i, 1); return; }
  clearGuestTimeout(t.timer);
  if (t.custom) yield vcall(t.custom, "hide", "()V");
  else if (t.presenter) yield vcall(t.presenter, "hide", `(${T})V`, t.callback);
  toastQueue.shift();
  if (toastQueue[0]) yield* showToast(toastService!, toastQueue[0]);
}
let toastService: JObj | null = null;
const serviceAccessGranted = driven(function* (component: JObj | null) {
  if (!component) rt.npe();
  checkCallerIsSystemOrSameApp(yield vcall(component, "getPackageName", "()Ljava/lang/String;"));
  return 0;
});
function enqueueToast(this: JObj, t: ToastRecord): number {
  toastService = this;
  toastQueue.push(t);
  if (toastQueue.length === 1) postMain(() => rt.drive(showToast(this, t)), logUncaught);
  return 1;
}

hostService("notification", "webdroid/NotificationManagerService", "android/app/INotificationManager$Stub", {
  "enqueueTextToast(Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/CharSequence;IZILandroid/app/ITransientNotificationCallback;)Z":
    function (this: JObj, pkg: string, token: JObj, text: unknown, duration: number, _ui: number, _display: number, callback: JObj | null) {
      return enqueueToast.call(this, { pkg, token, text, duration, callback, custom: null });
    },
  "enqueueToast(Ljava/lang/String;Landroid/os/IBinder;Landroid/app/ITransientNotification;IZI)Z":
    function (this: JObj, pkg: string, token: JObj, custom: JObj, duration: number) {
      return enqueueToast.call(this, { pkg, token, text: null, duration, callback: null, custom });
    },
  "cancelToast(Ljava/lang/String;Landroid/os/IBinder;)V": (pkg: string, token: JObj) => {
    const t = toastQueue.find((r) => r.pkg === pkg && r.token === token);
    if (t) return rt.drive(hideToast(t));
  },
  // ToastPresenter reports the window gone; the record left the queue when it was hidden
  "finishToken(Ljava/lang/String;Landroid/os/IBinder;)V": () => {},
  "enqueueNotificationWithTag(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILandroid/app/Notification;I)V": driven(enqueueNotification),
  "cancelNotificationWithTag(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;II)V":
    driven(function* (pkg: string, opPkg: string | null, tag: string | null, id: number, userId: number) {
      const { uid } = callingIdentity();
      if (userId === -1) userId = 0;
      yield* awaited(resolveNotificationUid(opPkg, pkg, uid, userId));
      if (pkg !== opPkg) {
        const r = find(pkg, tag, id, userId);
        if (r && r.opPkg !== opPkg) fail("java/lang/SecurityException", `${opPkg} does not have permission to cancel a notification they did not post ${tag} ${id}`);
      }
      yield* cancelNotification(pkg, tag, id, 0, SYSTEM_UIDS.has(uid) ? 0 : CANCEL_MUST_NOT_HAVE, userId, REASON_APP_CANCEL);
    }),
  "cancelAllNotifications(Ljava/lang/String;I)V": driven(function* (pkg: string, userId: number) {
    checkCallerIsSystemOrSameApp(pkg);
    yield* cancelAll(pkg, null, CANCEL_ALL_MUST_NOT_HAVE, userId === -1 ? 0 : userId);
  }),
  "getAppActiveNotifications(Ljava/lang/String;I)Landroid/content/pm/ParceledListSlice;": driven(function* (pkg: string, userId: number) {
    checkCallerIsSystemOrSameApp(pkg);
    if (userId === -1) userId = 0;
    const mine = notificationStore.posted.filter((r) => r.userId === userId && (r.pkg === pkg || r.opPkg === pkg));
    const sbns: JObj[] = [];
    for (const r of hashOrder(mine, (r) => r.key)) sbns.push(yield* statusBarNotification(r));
    return yield* awaited(parceledList(sbns));
  }),

  "createNotificationChannelGroups(Ljava/lang/String;Landroid/content/pm/ParceledListSlice;)V": driven(function* (pkg: string, slice: JObj | null) {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = yield* preferences(pkg);
    for (const group of yield* sliceItems(slice)) yield* createGroup(prefs, group ? (yield* copyOf(GROUP, group)) : rt.npe());
  }),
  "createNotificationChannels(Ljava/lang/String;Landroid/content/pm/ParceledListSlice;)V": driven(function* (pkg: string, slice: JObj | null) {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = yield* preferences(pkg), had = (yield* awaited(prefs.ids(CHANNEL_KEY))).length > 0;
    let created = false;
    for (const channel of yield* sliceItems(slice)) {
      if (!channel) fail("java/lang/NullPointerException", "channel in list is null");
      created = (yield* createChannel(prefs, yield* copyOf(CHANNEL, channel))) || created;
    }
    // the prompt shows over the activity in front, after this call returns: covering it pauses that
    // activity, whose main thread may be the caller
    if (created && !had && foreground() && (yield* awaited(promptNeeded(pkg)))) detached(() => showNotificationPrompt(pkg), logUncaught);
  }),
  "getNotificationChannel(Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;)Landroid/app/NotificationChannel;":
    driven(function* (callingPkg: string, userId: number, pkg: string, channelId: string | null) {
      if (!(yield* awaited(canNotifyAsPackage(callingPkg, pkg, userId)))) fail("java/lang/SecurityException", `Pkg ${callingPkg} cannot read channels for ${pkg} in ${userId}`);
      return yield* channelFor(yield* preferences(pkg), channelId);
    }),
  "getNotificationChannels(Ljava/lang/String;Ljava/lang/String;I)Landroid/content/pm/ParceledListSlice;": driven(function* (callingPkg: string, pkg: string, userId: number) {
    if (!(yield* awaited(canNotifyAsPackage(callingPkg, pkg, userId)))) fail("java/lang/SecurityException", `Pkg ${callingPkg} cannot read channels for ${pkg} in ${userId}`);
    return yield* awaited(parceledList(yield* (yield* preferences(pkg)).channels(false)));
  }),
  "deleteNotificationChannel(Ljava/lang/String;Ljava/lang/String;)V": driven(function* (pkg: string, channelId: string) {
    checkCallerIsSystemOrSameApp(pkg);
    if (channelId === DEFAULT_CHANNEL) fail("java/lang/IllegalArgumentException", "Cannot delete default channel");
    enforceNoForegroundService(pkg, 0, channelId);
    yield* cancelAll(pkg, channelId, 0, 0);
    const prefs = yield* preferences(pkg), channel = yield* prefs.read(CHANNEL_KEY, channelId);
    if (channel) yield* deleteChannel(prefs, channel);
  }),
  "getNotificationChannelGroup(Ljava/lang/String;Ljava/lang/String;)Landroid/app/NotificationChannelGroup;": driven(function* (pkg: string, groupId: string | null) {
    checkCallerIsSystemOrSameApp(pkg);
    return yield* groupWithChannels(yield* preferences(pkg), groupId, false);
  }),
  /** getNotificationChannelGroups: every group, holding its channels, in its id's ArrayMap order */
  "getNotificationChannelGroups(Ljava/lang/String;)Landroid/content/pm/ParceledListSlice;": driven(function* (pkg: string) {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = yield* preferences(pkg), groups = new Map<string, JObj>();
    for (const channel of yield* prefs.channels(false)) {
      const id: string | null = yield vcall(channel, "getGroup", "()Ljava/lang/String;");
      if (id === null || !(yield* awaited(prefs.has(GROUP_KEY, id)))) continue;
      let group = groups.get(id);
      if (!group) { group = (yield* prefs.read(GROUP_KEY, id))!; yield vcall(group, "setChannels", "(Ljava/util/List;)V", yield newArrayList()); groups.set(id, group); }
      yield vcall(group, "addChannel", "(Landroid/app/NotificationChannel;)V", channel);
    }
    for (const id of yield* awaited(prefs.ids(GROUP_KEY))) if (!groups.has(id)) groups.set(id, (yield* prefs.read(GROUP_KEY, id))!);
    return yield* awaited(parceledList(hashOrder([...groups], ([id]) => id).map(([, group]) => group)));
  }),
  "deleteNotificationChannelGroup(Ljava/lang/String;Ljava/lang/String;)V": driven(function* (pkg: string, groupId: string | null) {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = yield* preferences(pkg), group = yield* groupWithChannels(prefs, groupId, false);
    if (!group) return;
    for (const channel of (yield* awaited(toJsArray(yield vcall(group, "getChannels", "()Ljava/util/List;")))) as JObj[])
      enforceNoForegroundService(pkg, 0, yield vcall(channel, "getId", "()Ljava/lang/String;"));
    yield* awaited(prefs.remove(GROUP_KEY + groupId));
    for (const channel of yield* prefs.channels(true)) {
      if ((yield vcall(channel, "getGroup", "()Ljava/lang/String;")) !== groupId) continue;
      yield* deleteChannel(prefs, channel);
      yield* cancelAll(pkg, yield vcall(channel, "getId", "()Ljava/lang/String;"), 0, 0);
    }
  }),

  "areNotificationsEnabled(Ljava/lang/String;)Z": (pkg: string) => areNotificationsEnabledForPackage(pkg, callingIdentity().uid),
  "areNotificationsEnabledForPackage(Ljava/lang/String;I)Z": areNotificationsEnabledForPackage,
  "getPackageImportance(Ljava/lang/String;)I": (pkg: string) => {
    checkCallerIsSystemOrSameApp(pkg);
    return after(hasPermission(callingIdentity().uid), granted => granted ? IMPORTANCE_DEFAULT : IMPORTANCE_NONE);
  },
  // bubbles are on for the device and allowed for no app until the user allows one
  "areBubblesAllowed(Ljava/lang/String;)Z": (pkg: string) => { enforceSystemOrSystemUIOrSamePackage(pkg, "Caller not system or systemui or same package"); return 0; },
  "areBubblesEnabled(Landroid/os/UserHandle;)Z": () => 1,
  "getBubblePreferenceForPackage(Ljava/lang/String;I)I": (pkg: string) => { enforceSystemOrSystemUIOrSamePackage(pkg, "Caller not system or systemui or same package"); return 0; },
  // no package is suspended or paused here
  "isPackagePaused(Ljava/lang/String;)Z": (pkg: string) => { checkCallerIsSameApp(pkg); return 0; },
  "canNotifyAsPackage(Ljava/lang/String;Ljava/lang/String;I)Z": (callingPkg: string, pkg: string, userId: number) => after(canNotifyAsPackage(callingPkg, pkg, userId), allowed => +allowed),
  "canUseFullScreenIntent(Landroid/content/AttributionSource;)Z": driven(function* (source: JObj) {
    const pkg: string | null = yield vcall(source, "getPackageName", "()Ljava/lang/String;"), uid: number = yield vcall(source, "getUid", "()I");
    checkCallerIsSameApp(pkg, uid);
    return +canUseFullScreenIntent(pkg!, targetSdk(pkg!));
  }),
  "setNotificationDelegate(Ljava/lang/String;Ljava/lang/String;)V": (pkg: string, delegate: string | null) => {
    checkCallerIsSameApp(pkg);
    const file = new Prefs(policyFile(pkg));
    if (delegate === null) return file.remove(DELEGATE_KEY);
    if (packages.has(delegate)) return file.set(DELEGATE_KEY, delegate);
  },
  "getNotificationDelegate(Ljava/lang/String;)Ljava/lang/String;": (pkg: string) => { checkCallerIsSystemOrSameApp(pkg); return delegateOf(pkg); },

  // Do Not Disturb is off, and no app has the access that changes it
  "getZenMode()I": () => ZEN_MODE_OFF,
  "getNotificationPolicy(Ljava/lang/String;)Landroid/app/NotificationManager$Policy;": policy,
  "getConsolidatedNotificationPolicy()Landroid/app/NotificationManager$Policy;": policy,
  "isNotificationPolicyAccessGranted(Ljava/lang/String;)Z": () => 0,
  "isNotificationPolicyAccessGrantedForPackage(Ljava/lang/String;)Z": (pkg: string) => {
    enforceSystemOrSystemUIOrSamePackage(pkg, "request policy access status for another package"); return 0;
  },
  "setInterruptionFilter(Ljava/lang/String;IZ)V": (pkg: string) => { checkCallerIsSameApp(pkg); denyPolicyAccess(); },
  "setNotificationPolicy(Ljava/lang/String;Landroid/app/NotificationManager$Policy;Z)V": (pkg: string) => { checkCallerIsSameApp(pkg); denyPolicyAccess(); },
  "getZenRules()Ljava/util/List;": denyPolicyAccess,
  "getAutomaticZenRules()Ljava/util/Map;": denyPolicyAccess,
  "getAutomaticZenRule(Ljava/lang/String;)Landroid/app/AutomaticZenRule;": (id: string | null) => id === null ? fail("java/lang/NullPointerException", "Id is null") : denyPolicyAccess(),
  "getAutomaticZenRuleState(Ljava/lang/String;)I": (id: string | null) => id === null ? fail("java/lang/NullPointerException", "id is null") : denyPolicyAccess(),
  "removeAutomaticZenRule(Ljava/lang/String;Z)Z": (id: string | null) => id === null ? fail("java/lang/NullPointerException", "Id is null") : denyPolicyAccess(),
  "addAutomaticZenRule(Landroid/app/AutomaticZenRule;Ljava/lang/String;Z)Ljava/lang/String;": (rule: JObj | null, pkg: string) => {
    if (rule === null) fail("java/lang/NullPointerException", "automaticZenRule is null");
    checkCallerIsSameApp(pkg); denyPolicyAccess();
  },
  "updateAutomaticZenRule(Ljava/lang/String;Landroid/app/AutomaticZenRule;Z)Z": (_id: string, rule: JObj | null) =>
    rule === null ? fail("java/lang/NullPointerException", "automaticZenRule is null") : denyPolicyAccess(),
  "setAutomaticZenRuleState(Ljava/lang/String;Landroid/service/notification/Condition;)V": (id: string | null, condition: JObj | null) =>
    id === null ? fail("java/lang/NullPointerException", "id is null") : condition === null ? fail("java/lang/NullPointerException", "Condition is null") : denyPolicyAccess(),
  "getEffectsSuppressor()Landroid/content/ComponentName;": () => null,
  "getRuleInstanceCount(Landroid/content/ComponentName;)I": () => enforceSystemOrSystemUI("getRuleInstanceCount"),

  // no listener or assistant is enabled: access to either is granted in Settings
  "isNotificationListenerAccessGranted(Landroid/content/ComponentName;)Z": serviceAccessGranted,
  "isNotificationAssistantAccessGranted(Landroid/content/ComponentName;)Z": serviceAccessGranted,
  "shouldHideSilentStatusIcons(Ljava/lang/String;)Z": (pkg: string) => {
    checkCallerIsSameApp(pkg);
    return SYSTEM_UIDS.has(callingIdentity().uid) ? 0 : fail("java/lang/SecurityException", "Only available for notification listeners");
  },
}, true);

function areNotificationsEnabledForPackage(pkg: string, uid: number): number | Promise<number> {
  enforceSystemOrSystemUIOrSamePackage(pkg, "Caller not system or systemui or same package");
  return after(hasPermission(uid), granted => +granted);
}
/** canNotifyAsPackage: an app may act for itself, or for a package that made it its delegate */
function canNotifyAsPackage(callingPkg: string, pkg: string, userId: number): boolean | Promise<boolean> {
  checkCallerIsSameApp(callingPkg);
  if (userId !== 0) denyPermission("android.permission.INTERACT_ACROSS_USERS", `canNotifyAsPackage for user ${userId}`);
  return callingPkg === pkg || after(delegateOf(pkg), delegate => delegate === callingPkg);
}
