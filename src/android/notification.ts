// INotificationManager: NotificationManagerService's app-facing half, under AOSP's NotificationManager
// and Notification classes, which run from bytecode. Channels, groups and the notification delegate
// persist per package as PreferencesHelper keeps them, each channel or group as its parcel, in the
// preference store every process shares. Posted notifications are the broker's (NotificationStore),
// each held as the Notification's parcel, as system_server holds a NotificationRecord: an app reads
// back copies, never its own object. Nothing presents them; there is no shade, sound or listener.
// Rules follow the reference AVD's services.jar (NotificationManagerService, PreferencesHelper,
// GroupHelper); its answers to an app were probed with a test app (targetSdk 25, 32 and 35).
import { JObj, rt, declaredField } from "../jvm/runtime";
import { mangleStaticField } from "../jvm/abi";
import { newObj, vcall, scall, linkInit } from "../jvm/natives/jlang";
import { newArrayList, toJsArray } from "../jvm/natives/jcoll";
import { csText } from "../jvm/natives/jchars";
import { hostStub, hostedService, callingIdentity, exportParcel, importParcel, type ParcelData } from "./binder";
import { setGuestTimeout, clearGuestTimeout, type GuestTimer } from "../guest-clock";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { JParcel } from "./parcel";
import { preferenceStore } from "./sharedprefs";
import { packages, usesSdk } from "./packages";
import { appHost } from "./apphost";
import { permissionGranted, grantPrompted } from "./context";

const N = "android/app/Notification", CHANNEL = "android/app/NotificationChannel", GROUP = "android/app/NotificationChannelGroup";
const LIST = "android/content/pm/ParceledListSlice";
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
export interface PostedNotification {
  key: string; pkg: string; opPkg: string; id: number; tag: string | null; uid: number; pid: number; userId: number;
  postTime: bigint; channel: string; flags: number; group: string | null; sortKey: string | null;
  /** the group key an adjustment overrides the app's with (GroupHelper's autogroup) */
  override: string | null;
  data: ParcelData;
}
/** GroupHelper's view of an ungrouped notification; `icon` identifies its small icon as Icon.sameAs compares */
interface Ungrouped { flags: number; icon: string; color: number; visibility: number }
/** NotificationManagerService's notification list and the state its posting rules keep, shared by
 *  every process through the broker */
export class NotificationStore {
  readonly posted: PostedNotification[] = [];
  readonly enqueueRates = new Map<string, { interarrival: number; last: number | null }>();
  /** userId|pkg → its autogroup summary's key (mAutobundledSummaries) */
  readonly autobundled = new Map<string, string>();
  /** userId|pkg → its ungrouped notifications by key (GroupHelper.mUngroupedNotifications) */
  readonly ungrouped = new Map<string, Map<string, Ungrouped>>();
  /** pkg|id of each foreground service's notification (ActiveServices' ServiceRecord.foregroundId) */
  readonly foreground = new Set<string>();
}
export let notificationStore = new NotificationStore();
export function useNotificationStore(store: NotificationStore): void { notificationStore = store; }

const fail = (cls: string, message: string | null): never => { throw rt.mkThrowable(cls, message); };
const field = (cls: string, name: string) => declaredField(cls, name);
const get = (o: JObj, cls: string, name: string): any => (o as unknown as Record<string, unknown>)[field(cls, name)];
const set = (o: JObj, cls: string, name: string, value: unknown) => { (o as unknown as Record<string, unknown>)[field(cls, name)] = value; };
/** String.hashCode, the order an ArrayMap keyed by strings iterates in */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h, 31) + s.charCodeAt(i) | 0;
  return h;
}
const hashOrder = <T>(items: T[], key: (item: T) => string): T[] =>
  items.map((item, i) => ({ item, hash: javaHash(key(item)), i })).sort((a, b) => a.hash - b.hash || a.i - b.i).map(({ item }) => item);

async function parcelOf(o: JObj): Promise<ParcelData> {
  const parcel = new JParcel();
  await vcall(o, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  return exportParcel(parcel);
}
async function fromParcel(cls: string, data: ParcelData): Promise<JObj> {
  const creator = (await linkInit(cls)).ctor[mangleStaticField("CREATOR")];
  return vcall(creator, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", importParcel(data));
}
/** what a binder call hands the service: a copy of the caller's object */
const copyOf = async (cls: string, o: JObj) => fromParcel(cls, await parcelOf(o));
const listSlice = (items: unknown[]) => newObj(LIST, "(Ljava/util/List;)V", newArrayList(items));
const sliceItems = async (slice: JObj | null): Promise<JObj[]> =>
  slice ? await toJsArray(await vcall(slice, "getList", "()Ljava/util/List;")) as JObj[] : fail("java/lang/NullPointerException", null);

// ── callers
const SYSTEM_UIDS = new Set([0, 1000, 1001]);
const ownsPackage = (pkg: string | null, uid: number) => pkg !== null && packages.get(pkg)?.uid === uid;
function checkCallerIsSameApp(pkg: string | null, uid = callingIdentity().uid): void {
  if (!(uid === 0 && pkg === "root") && !ownsPackage(pkg, uid)) fail("java/lang/SecurityException", `Package ${pkg} is not owned by uid ${uid}`);
}
function checkCallerIsSystemOrSameApp(pkg: string | null): void {
  if (!SYSTEM_UIDS.has(callingIdentity().uid)) checkCallerIsSameApp(pkg);
}
/** a permission no app holds here: Context.enforceCallingPermission's failure */
function denyPermission(permission: string, message: string): never {
  return fail("java/lang/SecurityException", `${message}: Neither user ${callingIdentity().uid} nor current process has ${permission}.`);
}
function enforceSystemOrSystemUIOrSamePackage(pkg: string | null, message: string): void {
  if (SYSTEM_UIDS.has(callingIdentity().uid) || ownsPackage(pkg, callingIdentity().uid)) return;
  denyPermission("android.permission.STATUS_BAR_SERVICE", message);
}
function enforceSystemOrSystemUI(message: string): void {
  if (!SYSTEM_UIDS.has(callingIdentity().uid)) denyPermission("android.permission.STATUS_BAR_SERVICE", message);
}
/** Do Not Disturb policy access: granted only in Settings, which no app here can reach */
function denyPolicyAccess(): never { return fail("java/lang/SecurityException", "Notification policy access denied"); }
const targetSdk = (pkg: string) => { const record = packages.get(pkg); return record ? usesSdk(record.root).target : 10000; };
const packageOf = (uid: number) => [...packages.values()].find((p) => p.uid === uid)?.pkg ?? null;
/** PermissionHelper.hasPermission: the uid holds POST_NOTIFICATIONS */
function hasPermission(uid: number): boolean {
  if (SYSTEM_UIDS.has(uid)) return true;
  const pkg = packageOf(uid);
  return pkg !== null && !!packages.get(pkg)?.permissions.has(POST_NOTIFICATIONS) && permissionGranted(pkg, POST_NOTIFICATIONS);
}
/** the system's view of packages: the application's PackageManager over the hosted service */
const getPM = async (): Promise<JObj> => vcall(appHost!.application, "getPackageManager", "()Landroid/content/pm/PackageManager;");
const appInfo = async (pkg: string): Promise<JObj> =>
  vcall(await getPM(), "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 0);

// ── PreferencesHelper: a package's channels, groups and delegate
const policyFile = (pkg: string) => "android:notification-policy:" + pkg;
const CHANNEL_KEY = "channel:", GROUP_KEY = "group:", DELEGATE_KEY = "delegate";
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const parcelData = (stored: string): ParcelData => ({ bytes: Uint8Array.from(atob(stored), (c) => c.charCodeAt(0)), objects: [] });
class Preferences {
  readonly values: Map<string, unknown>;
  constructor(readonly pkg: string) { this.values = preferenceStore.open(policyFile(pkg)); }
  ids(prefix: string): string[] {
    return hashOrder([...this.values.keys()].filter((k) => k.startsWith(prefix)), (k) => k.slice(prefix.length)).map((k) => k.slice(prefix.length));
  }
  has(prefix: string, id: string): boolean { return this.values.has(prefix + id); }
  async read(prefix: string, id: string): Promise<JObj | null> {
    const stored = this.values.get(prefix + id);
    return typeof stored === "string" ? fromParcel(prefix === CHANNEL_KEY ? CHANNEL : GROUP, parcelData(stored)) : null;
  }
  async write(prefix: string, id: string, o: JObj): Promise<void> {
    this.values.set(prefix + id, toBase64((await parcelOf(o)).bytes));
    this.save();
  }
  remove(key: string): void { this.values.delete(key); this.save(); }
  save(): void { preferenceStore.persist(policyFile(this.pkg), this.values as Map<string, string>); }
  async channels(includeDeleted: boolean): Promise<JObj[]> {
    const all: JObj[] = [];
    for (const id of this.ids(CHANNEL_KEY)) {
      const channel = (await this.read(CHANNEL_KEY, id))!;
      if (includeDeleted || !await vcall(channel, "isDeleted", "()Z")) all.push(channel);
    }
    return all;
  }
}
/** getOrCreatePackagePreferencesLocked: an app targeting below O has the default channel, which
 *  goes once it targets O */
async function preferences(pkg: string): Promise<Preferences> {
  const prefs = new Preferences(pkg), legacy = targetSdk(pkg) < 26;
  if (legacy && !prefs.has(CHANNEL_KEY, DEFAULT_CHANNEL)) {
    const system = await scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
    const label = await vcall(system, "getIdentifier", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "default_notification_channel_label", "string", "android");
    const channel = await newObj(CHANNEL, "(Ljava/lang/String;Ljava/lang/CharSequence;I)V", DEFAULT_CHANNEL,
      await vcall(system, "getString", "(I)Ljava/lang/String;", label), IMPORTANCE_UNSPECIFIED);
    await prefs.write(CHANNEL_KEY, DEFAULT_CHANNEL, channel);
  } else if (!legacy && prefs.has(CHANNEL_KEY, DEFAULT_CHANNEL)) prefs.remove(CHANNEL_KEY + DEFAULT_CHANNEL);
  return prefs;
}
const str = async (cs: unknown) => cs == null ? null : csText(cs);

/** PreferencesHelper.createNotificationChannel for the app itself (no Do Not Disturb access) */
async function createChannel(prefs: Preferences, channel: JObj): Promise<boolean> {
  const id: string | null = await vcall(channel, "getId", "()Ljava/lang/String;");
  if (id === null) fail("java/lang/NullPointerException", null);
  if (!await str(await vcall(channel, "getName", "()Ljava/lang/CharSequence;"))) fail("java/lang/IllegalArgumentException", null);
  const importance: number = await vcall(channel, "getImportance", "()I");
  if (importance < IMPORTANCE_NONE || importance > 5) fail("java/lang/IllegalArgumentException", "Invalid importance level");
  const group: string | null = await vcall(channel, "getGroup", "()Ljava/lang/String;");
  if (group !== null && !prefs.has(GROUP_KEY, group)) fail("java/lang/IllegalArgumentException", "NotificationChannelGroup doesn't exist");
  if (id === DEFAULT_CHANNEL) fail("java/lang/IllegalArgumentException", "Reserved id");
  const existing = await prefs.read(CHANNEL_KEY, id!);
  if (existing) {
    // the app may rename, describe and downgrade its channel; the user's settings stay
    let changed = false;
    if (await vcall(existing, "isDeleted", "()Z")) {
      await vcall(existing, "setDeleted", "(Z)V", 0); await vcall(existing, "setDeletedTimeMs", "(J)V", -1n); changed = true;
    }
    const name = await str(await vcall(channel, "getName", "()Ljava/lang/CharSequence;"));
    if (name !== await str(await vcall(existing, "getName", "()Ljava/lang/CharSequence;"))) { await vcall(existing, "setName", "(Ljava/lang/CharSequence;)V", name); changed = true; }
    const description: string | null = await vcall(channel, "getDescription", "()Ljava/lang/String;");
    if (description !== await vcall(existing, "getDescription", "()Ljava/lang/String;")) { await vcall(existing, "setDescription", "(Ljava/lang/String;)V", description); changed = true; }
    const blockable: number = await vcall(channel, "isBlockable", "()Z");
    if (blockable !== await vcall(existing, "isBlockable", "()Z")) { await vcall(existing, "setBlockable", "(Z)V", blockable); changed = true; }
    if (group !== null && await vcall(existing, "getGroup", "()Ljava/lang/String;") === null) { await vcall(existing, "setGroup", "(Ljava/lang/String;)V", group); changed = true; }
    if (await vcall(existing, "getUserLockedFields", "()I") === 0 && importance < await vcall(existing, "getImportance", "()I")) {
      await vcall(existing, "setImportance", "(I)V", importance); changed = true;
    }
    if (await vcall(existing, "getOriginalImportance", "()I") === IMPORTANCE_UNSPECIFIED) { await vcall(existing, "setOriginalImportance", "(I)V", importance); changed = true; }
    if (changed) await prefs.write(CHANNEL_KEY, id!, existing);
    return changed;
  }
  if (prefs.ids(CHANNEL_KEY).length >= 5000) fail("java/lang/IllegalStateException", "Limit exceed; cannot create more channels");
  // fields only the user sets start at the package's defaults
  await vcall(channel, "setBypassDnd", "(Z)V", 0);
  await vcall(channel, "setLockscreenVisibility", "(I)V", IMPORTANCE_UNSPECIFIED);
  await vcall(channel, "setAllowBubbles", "(I)V", -1);
  await vcall(channel, "setImportantConversation", "(Z)V", 0);
  await vcall(channel, "unlockFields", "(I)V", await vcall(channel, "getUserLockedFields", "()I"));
  await vcall(channel, "setImportanceLockedByCriticalDeviceFunction", "(Z)V", 0);
  await vcall(channel, "setOriginalImportance", "(I)V", importance);
  const parent: string | null = await vcall(channel, "getParentChannelId", "()Ljava/lang/String;");
  if (parent !== null && !prefs.has(CHANNEL_KEY, parent)) fail("java/lang/IllegalArgumentException", "Tried to create a conversation channel without a preexisting parent");
  await prefs.write(CHANNEL_KEY, id!, channel);
  return true;
}
async function createGroup(prefs: Preferences, group: JObj): Promise<void> {
  const id: string | null = await vcall(group, "getId", "()Ljava/lang/String;");
  if (id === null) fail("java/lang/NullPointerException", null);
  if (!await str(await vcall(group, "getName", "()Ljava/lang/CharSequence;"))) fail("java/lang/IllegalArgumentException", "group.getName() can't be empty");
  if (prefs.ids(GROUP_KEY).length >= 6000) fail("java/lang/IllegalStateException", "Limit exceed; cannot create more groups");
  await vcall(group, "setBlocked", "(Z)V", 0);
  const existing = await prefs.read(GROUP_KEY, id!);
  if (existing) {
    await vcall(group, "setChannels", "(Ljava/util/List;)V", await vcall(existing, "getChannels", "()Ljava/util/List;"));
    await vcall(group, "setBlocked", "(Z)V", await vcall(existing, "isBlocked", "()Z"));
    await vcall(group, "unlockFields", "(I)V", await vcall(group, "getUserLockedFields", "()I"));
    await vcall(group, "lockFields", "(I)V", await vcall(existing, "getUserLockedFields", "()I"));
  }
  await prefs.write(GROUP_KEY, id!, group);
}
/** getNotificationChannelGroupWithChannels */
async function groupWithChannels(prefs: Preferences, id: string | null, includeDeleted: boolean): Promise<JObj | null> {
  const group = id === null ? null : await prefs.read(GROUP_KEY, id);
  if (!group) return null;
  await vcall(group, "setChannels", "(Ljava/util/List;)V", newArrayList());
  for (const channel of await prefs.channels(includeDeleted)) {
    if (await vcall(channel, "getGroup", "()Ljava/lang/String;") === id) await vcall(group, "addChannel", "(Landroid/app/NotificationChannel;)V", channel);
  }
  return group;
}
/** getConversationNotificationChannel without a conversation: the channel a notification posts to */
async function channelFor(prefs: Preferences, id: string | null, includeDeleted = false): Promise<JObj | null> {
  const channel = await prefs.read(CHANNEL_KEY, id ?? DEFAULT_CHANNEL);
  return channel && (includeDeleted || !await vcall(channel, "isDeleted", "()Z")) ? channel : null;
}
async function deleteChannel(prefs: Preferences, channel: JObj): Promise<void> {
  if (await vcall(channel, "isDeleted", "()Z")) return;
  await vcall(channel, "setDeleted", "(Z)V", 1);
  await vcall(channel, "setDeletedTimeMs", "(J)V", BigInt(Date.now()));
  await prefs.write(CHANNEL_KEY, await vcall(channel, "getId", "()Ljava/lang/String;"), channel);
}
function enforceNoForegroundService(pkg: string, userId: number, channel: string): void {
  if (notificationStore.posted.some((r) => r.pkg === pkg && r.userId === userId && r.channel === channel && r.flags & FLAG_FOREGROUND_SERVICE))
    fail("java/lang/SecurityException", `Not allowed to delete channel ${channel} with a foreground service`);
}

/** PermissionPolicyService's notification prompt for an app targeting 6.0 to 12L, which cannot ask
 *  for POST_NOTIFICATIONS itself: once it has a channel, the system asks when a launcher task is in
 *  front. The dialog's answer follows the grant policy runtime permissions follow (context.ts). */
function promptNeeded(pkg: string): boolean {
  const record = packages.get(pkg), target = targetSdk(pkg);
  return !!record && target >= 23 && target < 33 && pkg === appHost?.pkg && record.permissions.has(POST_NOTIFICATIONS)
    && !permissionGranted(pkg, POST_NOTIFICATIONS) && new Preferences(pkg).ids(CHANNEL_KEY).length > 0;
}
async function showNotificationPrompt(pkg: string): Promise<void> {
  grantPrompted(pkg, POST_NOTIFICATIONS);
  const activity = appHost?.currentActivity();
  if (activity) await appHost!.roundTrip(activity);
}
/** an activity launched from the launcher (PermissionPolicyService's ActivityInterceptorCallback):
 *  decided by the channels the app has as it launches, shown once its activity is in front */
export function notificationPromptOnLaunch(pkg: string): () => Promise<void> {
  const needed = promptNeeded(pkg);
  return async () => { if (needed && promptNeeded(pkg)) await showNotificationPrompt(pkg); };
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
async function statusBarNotification(r: PostedNotification): Promise<JObj> {
  const notification = await fromParcel(N, r.data);
  const user = await scall("android/os/UserHandle", "of", "(I)Landroid/os/UserHandle;", r.userId);
  return newObj("android/service/notification/StatusBarNotification",
    "(Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;IILandroid/app/Notification;Landroid/os/UserHandle;Ljava/lang/String;J)V",
    r.pkg, r.opPkg, r.id, r.tag, r.uid, r.pid, notification, user, r.override, r.postTime);
}
/** cancelNotificationLocked: off the list, out of GroupHelper's view */
async function removeRecords(removed: PostedNotification[]): Promise<void> {
  if (!removed.length) return;
  const list = notificationStore.posted;
  for (const r of removed) {
    const i = list.indexOf(r);
    if (i >= 0) list.splice(i, 1);
    const pk = packageKey(r.userId, r.pkg);
    if (notificationStore.autobundled.get(pk) === r.key) notificationStore.autobundled.delete(pk);
  }
  for (const r of removed) await groupHelperUngroup(r, true);
}
/** cancelGroupChildrenLocked: a summary's children go with it, except those `keep` spares */
function groupChildren(summary: PostedNotification, keep: (flags: number) => boolean): PostedNotification[] {
  if (!isGroupSummary(summary)) return [];
  const key = groupKey(summary);
  return notificationStore.posted.filter((r) => r.pkg === summary.pkg && r.userId === summary.userId && r !== summary
    && isGroup(r) && !isGroupSummary(r) && groupKey(r) === key && !keep(r.flags));
}
/** CancelNotificationRunnable */
async function cancelNotification(pkg: string, tag: string | null, id: number, mustHave: number, mustNotHave: number, userId: number, reason: number): Promise<void> {
  const r = find(pkg, tag, id, userId);
  if (!r || (r.flags & mustHave) !== mustHave || r.flags & mustNotHave) return;
  const spared = (flags: number) => reason === REASON_APP_CANCEL && (flags & (FLAG_FOREGROUND_SERVICE | FLAG_USER_INITIATED_JOB)) !== 0 || (flags & mustNotHave) !== 0;
  await removeRecords([r, ...groupChildren(r, spared)]);
}
/** cancelAllNotificationsInt for a package, optionally one channel's */
async function cancelAll(pkg: string, channel: string | null, mustNotHave: number, userId: number): Promise<void> {
  await removeRecords(notificationStore.posted.filter((r) => r.pkg === pkg && r.userId === userId
    && (channel === null || r.channel === channel) && !(r.flags & mustNotHave)));
}

// ── GroupHelper: two or more ungrouped notifications are bundled under a summary the system posts
async function iconIdentity(icon: JObj | null): Promise<string> {
  if (!icon) return "none";
  const type: number = await vcall(icon, "getType", "()I");
  if (type === 2) return `res:${await vcall(icon, "getResPackage", "()Ljava/lang/String;")}:${await vcall(icon, "getResId", "()I")}`;
  if (type === 4 || type === 6) return `uri:${type}:${await vcall(icon, "getUriString", "()Ljava/lang/String;")}`;
  return `object:${nextIcon++}`;
}
let nextIcon = 0;
const summaryFlags = (members: Map<string, Ungrouped>) => {
  let all = members.size > 0, ongoing = 0;
  for (const m of members.values()) { if (!(m.flags & FLAG_AUTO_CANCEL)) all = false; ongoing |= m.flags & (FLAG_ONGOING_EVENT | FLAG_NO_CLEAR); }
  return (all ? FLAG_AUTO_CANCEL : 0) | FLAG_AUTOGROUP_SUMMARY | FLAG_GROUP_SUMMARY | FLAG_LOCAL_ONLY | ongoing;
};
/** getAutobundledSummaryAttributes: the members' shared icon and color, public if any member is */
async function summaryLook(pkg: string, members: Ungrouped[]): Promise<{ icon: JObj; color: number; visibility: number }> {
  const sameIcon = members.every((m) => m.icon === members[0].icon && !m.icon.startsWith("object:"));
  const color = members.every((m) => m.color === members[0].color) ? members[0].color : 0;
  const visibility = members.some((m) => m.visibility === 1) ? 1 : 0;
  let icon: JObj | null = null;
  if (sameIcon) {
    const holder = notificationStore.posted.find((r) => notificationStore.ungrouped.get(packageKey(r.userId, r.pkg))?.get(r.key)?.icon === members[0].icon);
    if (holder) icon = await vcall(await fromParcel(N, holder.data), "getSmallIcon", "()Landroid/graphics/drawable/Icon;");
  }
  return { icon: icon ?? await monochromeAppIcon(pkg), color, visibility };
}
async function monochromeAppIcon(pkg: string): Promise<JObj> {
  const drawable = await vcall(await getPM(), "getApplicationIcon", "(Ljava/lang/String;)Landroid/graphics/drawable/Drawable;", pkg);
  if (rt.iof(drawable, "android/graphics/drawable/AdaptiveIconDrawable") && await vcall(drawable, "getMonochrome", "()Landroid/graphics/drawable/Drawable;")) {
    const inset: number = await scall("android/graphics/drawable/AdaptiveIconDrawable", "getExtraInsetFraction", "()F");
    return scall("android/graphics/drawable/Icon", "createWithResourceAdaptiveDrawable", "(Ljava/lang/String;IZF)Landroid/graphics/drawable/Icon;",
      pkg, await vcall(drawable, "getSourceDrawableResId", "()I"), 1, inset * -2);
  }
  const system = await scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
  const id = await vcall(system, "getIdentifier", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", "ic_menu_cut_holo_light", "drawable", "android");
  return scall("android/graphics/drawable/Icon", "createWithResource", "(Ljava/lang/String;I)Landroid/graphics/drawable/Icon;", "android", id);
}
async function groupHelperPosted(r: PostedNotification, notification: JObj): Promise<void> {
  const pk = packageKey(r.userId, r.pkg), hasSummary = notificationStore.autobundled.has(pk);
  if (isAppGroup(r)) return groupHelperUngroup(r, false);
  let members = notificationStore.ungrouped.get(pk);
  if (!members) notificationStore.ungrouped.set(pk, members = new Map());
  const icon = await iconIdentity(await vcall(notification, "getSmallIcon", "()Landroid/graphics/drawable/Icon;"));
  members.set(r.key, { flags: r.flags, icon, color: get(notification, N, "color"), visibility: get(notification, N, "visibility") });
  if (members.size < AUTOGROUP_AT_COUNT && !hasSummary) return;
  const flags = summaryFlags(members), keys = [...members.keys()];
  if (hasSummary) await updateAutobundledSummary(r, flags, [...members.values()]);
  else await addAutoGroupSummary(r, flags, [...members.values()]);
  for (const key of keys) {
    const member = notificationStore.posted.find((m) => m.key === key);
    if (member && member.override === null) member.override = RANKER_GROUP;
  }
}
async function groupHelperUngroup(r: PostedNotification, removed: boolean): Promise<void> {
  const pk = packageKey(r.userId, r.pkg), members = notificationStore.ungrouped.get(pk), member = members?.get(r.key);
  if (!members?.size || !member) return;
  members.delete(r.key);
  if (!members.size) {
    const summary = notificationStore.autobundled.get(pk);
    notificationStore.autobundled.delete(pk);
    const record = summary && notificationStore.posted.find((s) => s.key === summary);
    if (record) await removeRecords([record]);
  } else if (member.flags & (FLAG_ONGOING_EVENT | FLAG_NO_CLEAR)) await updateAutobundledSummary(r, summaryFlags(members), [...members.values()]);
  if (!removed && r.override !== null) r.override = null;
}
/** createAutoGroupSummary, posted as the app's own notification */
async function addAutoGroupSummary(trigger: PostedNotification, flags: number, members: Ungrouped[]): Promise<void> {
  const pk = packageKey(trigger.userId, trigger.pkg);
  if (notificationStore.autobundled.has(pk)) return;
  const look = await summaryLook(trigger.pkg, members);
  const context = appHost?.application;
  const triggering = await fromParcel(N, trigger.data);
  let builder = await newObj(`${N}$Builder`, "(Landroid/content/Context;Ljava/lang/String;)V", context, trigger.channel);
  const B = `L${N}$Builder;`;
  builder = await vcall(builder, "setSmallIcon", `(Landroid/graphics/drawable/Icon;)${B}`, look.icon);
  builder = await vcall(builder, "setGroupSummary", `(Z)${B}`, 1);
  builder = await vcall(builder, "setGroupAlertBehavior", `(I)${B}`, 2);
  builder = await vcall(builder, "setGroup", `(Ljava/lang/String;)${B}`, RANKER_GROUP);
  builder = await vcall(builder, "setFlag", `(IZ)${B}`, flags, 1);
  builder = await vcall(builder, "setColor", `(I)${B}`, look.color);
  builder = await vcall(builder, "setVisibility", `(I)${B}`, look.visibility);
  const summary = await vcall(builder, "build", `()L${N};`);
  const extras = get(summary, N, "extras");
  await vcall(extras, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "android.appInfo",
    await vcall(get(triggering, N, "extras"), "getParcelable", "(Ljava/lang/String;)Landroid/os/Parcelable;", "android.appInfo"));
  const launch = await vcall(await getPM(), "getLaunchIntentForPackage", "(Ljava/lang/String;)Landroid/content/Intent;", trigger.pkg);
  if (launch && context) set(summary, N, "contentIntent", await scall("android/app/PendingIntent", "getActivity",
    "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 0, launch, 0x4000000));
  const record: PostedNotification = {
    ...trigger, key: `${keyOf(trigger.userId, trigger.pkg, 0x7fffffff, RANKER_GROUP, trigger.uid)}|${RANKER_GROUP}`, id: 0x7fffffff, tag: RANKER_GROUP,
    postTime: BigInt(Date.now()), flags: get(summary, N, "flags"), group: RANKER_GROUP, sortKey: null, override: RANKER_GROUP, data: await parcelOf(summary),
  };
  notificationStore.autobundled.set(pk, record.key);
  if (!hasPermission(record.uid) || await channelImportance(record) === IMPORTANCE_NONE) return;
  await insert(record);
}
/** updateAutobundledSummaryLocked: the summary follows its members' flags and look */
async function updateAutobundledSummary(trigger: PostedNotification, flags: number, members: Ungrouped[]): Promise<void> {
  const key = notificationStore.autobundled.get(packageKey(trigger.userId, trigger.pkg));
  const record = key && notificationStore.posted.find((r) => r.key === key);
  if (!record) return;
  const summary = await fromParcel(N, record.data), look = await summaryLook(trigger.pkg, members);
  const sameLook = await iconIdentity(await vcall(summary, "getSmallIcon", "()Landroid/graphics/drawable/Icon;")) === await iconIdentity(look.icon)
    && get(summary, N, "color") === look.color && get(summary, N, "visibility") === look.visibility;
  if (record.flags === flags && sameLook) return;
  set(summary, N, "flags", flags);
  await vcall(summary, "setSmallIcon", "(Landroid/graphics/drawable/Icon;)V", look.icon);
  set(summary, N, "color", look.color);
  set(summary, N, "visibility", look.visibility);
  record.flags = flags;
  record.data = await parcelOf(summary);
}
async function channelImportance(r: PostedNotification): Promise<number> {
  const channel = await channelFor(new Preferences(r.pkg), r.channel, true);
  return channel ? vcall(channel, "getImportance", "()I") : IMPORTANCE_NONE;
}
/** PostNotificationRunnable's list update: a new key is added, an existing one replaced in place */
async function insert(r: PostedNotification): Promise<PostedNotification | null> {
  const list = notificationStore.posted, i = list.findIndex((o) => o.key === r.key);
  if (i < 0) { list.push(r); return null; }
  const old = list[i];
  list[i] = r;
  return old;
}

// ── posting
/** NotificationManagerService.fixNotification: what the service corrects in what an app sends */
async function fixNotification(n: JObj, pkg: string, foreground: boolean): Promise<void> {
  const info = await appInfo(pkg);
  await scall(N, "addFieldsFromContext", "(Landroid/content/pm/ApplicationInfo;Landroid/app/Notification;)V", info, n);
  const target = targetSdk(pkg);
  let flags: number = get(n, N, "flags");
  // only ActivityManagerService's foreground services and JobScheduler's user-initiated jobs carry
  // these, and their notifications do not cancel on a tap
  flags &= ~FLAG_USER_INITIATED_JOB;
  flags = foreground ? flags & ~FLAG_AUTO_CANCEL | FLAG_FOREGROUND_SERVICE : flags & ~FLAG_FOREGROUND_SERVICE;
  const media: number = await vcall(n, "isMediaNotification", "()Z");
  const call: number = await vcall(n, "isStyle", "(Ljava/lang/Class;)Z", rt.classFor(`${N}$CallStyle`));
  flags = flags & FLAG_ONGOING_EVENT && (media || call) ? flags | FLAG_NO_DISMISS : flags & ~FLAG_NO_DISMISS;
  flags &= ~(FLAG_CAN_COLORIZE | FLAG_FSI_REQUESTED_BUT_DENIED);
  const extras: JObj = get(n, N, "extras");
  for (const key of ["android.allowDuringSetup", "android.substName"]) await vcall(extras, "remove", "(Ljava/lang/String;)V", key);
  if (get(n, N, "fullScreenIntent") && !canUseFullScreenIntent(pkg, target)) {
    // makeStickyHun: the full-screen intent becomes the content intent of a persistent heads-up
    if (packages.get(pkg)?.permissions.has("android.permission.USE_FULL_SCREEN_INTENT")) flags |= FLAG_FSI_REQUESTED_BUT_DENIED;
    if (!get(n, N, "contentIntent")) set(n, N, "contentIntent", get(n, N, "fullScreenIntent"));
    set(n, N, "fullScreenIntent", null);
  }
  const actions = get(n, N, "actions") as (JObj | null)[] | null;
  if (actions?.includes(null)) {
    const kept = actions.filter((a) => a !== null);
    set(n, N, "actions", kept.length ? Object.assign(kept, { $t: `L${N}$Action;` }) : null);
  }
  if (await vcall(n, "isStyle", "(Ljava/lang/Class;)Z", rt.classFor(`${N}$MediaStyle`)) || await vcall(n, "isStyle", "(Ljava/lang/Class;)Z", rt.classFor(`${N}$DecoratedMediaCustomViewStyle`))) {
    for (const key of ["android.mediaRemoteDevice", "android.mediaRemoteIcon", "android.mediaRemoteIntent"]) await vcall(extras, "remove", "(Ljava/lang/String;)V", key);
    // MEDIA_STYLE_NOTIFICATION_NOT_DISMISSABLE, from Android 14
    if (target >= 34) flags |= FLAG_NO_CLEAR;
  }
  set(n, N, "flags", flags);
}
/** checkUseFullScreenIntentPermission: free below Android 10, then USE_FULL_SCREEN_INTENT and its app op */
function canUseFullScreenIntent(pkg: string, target: number): boolean {
  return target < 29 || !!packages.get(pkg)?.permissions.has("android.permission.USE_FULL_SCREEN_INTENT");
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
async function enqueueNotification(pkg: string | null, opPkg: string | null, tag: string | null, id: number, notification: JObj | null, userId: number,
  fromService = false): Promise<void> {
  if (pkg === null || notification === null) fail("java/lang/IllegalArgumentException", `null not allowed: pkg=${pkg} id=${id} notification=${notification === null ? "null" : await vcall(notification, "toString", "()Ljava/lang/String;")}`);
  const { uid, pid } = callingIdentity();
  if (userId === -1) userId = 0;
  const notifyUid = resolveNotificationUid(opPkg, pkg!, uid, userId);
  const n = await copyOf(N, notification!);
  // applyForegroundServiceNotification: the app may update its foreground service's notification
  const foreground = fromService || tag === null && notificationStore.foreground.has(foregroundKey(pkg!, id)) && (get(n, N, "flags") & FLAG_FOREGROUND_SERVICE) !== 0;
  await fixNotification(n, pkg!, foreground);
  const prefs = await preferences(pkg!);
  const channelId: string | null = await vcall(n, "getChannelId", "()Ljava/lang/String;");
  const shortcut: string | null = await vcall(n, "getShortcutId", "()Ljava/lang/String;");
  const channel = await channelFor(prefs, channelId, shortcut !== null);
  if (!channel) {
    console.warn(`[notification] No Channel found for pkg=${pkg}, channelId=${channelId}, id=${id}, tag=${tag}, opPkg=${opPkg}, callingUid=${uid}, userId=${userId}`);
    return;
  }
  const key = keyOf(userId, pkg!, id, tag, notifyUid), old = notificationStore.posted.find((r) => r.key === key) ?? null;
  // checkDisqualifyingFeatures
  if (!SYSTEM_UIDS.has(notifyUid)) {
    if (old && !await vcall(n, "hasCompletedProgress", "()Z") && enqueueRate(pkg!, performance.now(), false) > MAX_PACKAGE_ENQUEUE_RATE) return;
    const count = notificationStore.posted.filter((r) => r.pkg === pkg && r.userId === userId && !(r.id === id && r.tag === tag)).length;
    if (!foreground && count >= MAX_PACKAGE_NOTIFICATIONS) {
      console.warn(`[notification] Package has already posted or enqueued ${count} notifications.  Not showing more.  package=${pkg}`);
      return;
    }
  }
  if (!foreground && await vcall(n, "isStyle", "(Ljava/lang/Class;)Z", rt.classFor(`${N}$CallStyle`)) && !get(n, N, "fullScreenIntent") && !(get(n, N, "flags") & FLAG_FSI_REQUESTED_BUT_DENIED))
    fail("java/lang/IllegalArgumentException", `${key} Not posted. CallStyle notifications must be for a foreground service or user initated job or use a fullScreenIntent.`);
  // a media notification is posted even when its app may not post others
  const media: number = await vcall(n, "isMediaNotification", "()Z");
  if (!media && (!hasPermission(notifyUid) || await vcall(channel, "getImportance", "()I") === IMPORTANCE_NONE)) return;
  enqueueRate(pkg!, performance.now(), true);
  // handleGroupedNotificationLocked: a summary flag without an app group is dropped
  let flags: number = get(n, N, "flags");
  const group: string | null = await vcall(n, "getGroup", "()Ljava/lang/String;"), sortKey: string | null = await vcall(n, "getSortKey", "()Ljava/lang/String;");
  if (flags & FLAG_GROUP_SUMMARY && group === null && sortKey === null) flags &= ~FLAG_GROUP_SUMMARY;
  if (old) flags |= old.flags & FLAG_FOREGROUND_SERVICE;
  if (flags & FLAG_FOREGROUND_SERVICE) flags |= FLAG_NO_CLEAR;
  set(n, N, "flags", flags);
  const record: PostedNotification = {
    key, pkg: pkg!, opPkg: opPkg ?? pkg!, id, tag, uid: notifyUid, pid, userId, postTime: BigInt(Date.now()),
    channel: await vcall(channel, "getId", "()Ljava/lang/String;"), flags, group, sortKey, override: old?.override ?? null, data: await parcelOf(n),
  };
  if (old && isGroupSummary(old) && (!isGroupSummary(record) || groupKey(old) !== groupKey(record)))
    await removeRecords(groupChildren(old, (f) => (f & (FLAG_FOREGROUND_SERVICE | FLAG_USER_INITIATED_JOB)) !== 0));
  await insert(record);
  // GroupHelper sees a post that is new or changed its group or flags
  if (await vcall(n, "getSmallIcon", "()Landroid/graphics/drawable/Icon;") && (!old || old.group !== record.group || old.flags !== record.flags))
    await groupHelperPosted(record, n);
}
/** resolveNotificationUid: an app posts as itself, or for a package that made it its delegate */
function resolveNotificationUid(opPkg: string | null, pkg: string, uid: number, userId: number): number {
  if (ownsPackage(pkg, uid) && (opPkg === pkg || ownsPackage(opPkg, uid))) return uid;
  const owner = packages.get(pkg);
  if (owner && (SYSTEM_UIDS.has(uid) && pkg === "android" || delegateOf(pkg) === opPkg && ownsPackage(opPkg, uid))) return owner.uid;
  return fail("java/lang/SecurityException", `Caller ${opPkg}:${uid} cannot post for pkg ${pkg} in user ${userId}`);
}
function delegateOf(pkg: string): string | null {
  const delegate = new Preferences(pkg).values.get(DELEGATE_KEY);
  return typeof delegate === "string" ? delegate : null;
}

// ── ActiveServices: a foreground service's notification
const foregroundKey = (pkg: string, id: number) => `${pkg}|${id}`;
/** Service.startForeground: the notification posts under the service's id, as the app's, with
 *  FLAG_FOREGROUND_SERVICE, which no app may set itself */
export async function startForegroundNotification(id: number, notification: JObj | null): Promise<void> {
  const pkg = appHost?.pkg;
  if (!pkg || !id) return;
  if (notification === null) fail("java/lang/IllegalArgumentException", "null notification");
  notificationStore.foreground.add(foregroundKey(pkg, id));
  await enqueueNotification(pkg, pkg, null, id, notification, 0, true);
}
/** stopForeground, and the service's end: removed, or left behind without FLAG_FOREGROUND_SERVICE */
export async function stopForegroundNotification(id: number, remove: boolean): Promise<void> {
  const pkg = appHost?.pkg;
  if (!pkg) return;
  notificationStore.foreground.delete(foregroundKey(pkg, id));
  const r = find(pkg, null, id, 0);
  if (!r) return;
  if (remove) return removeRecords([r]);
  const n = await fromParcel(N, r.data);
  set(n, N, "flags", r.flags &= ~FLAG_FOREGROUND_SERVICE);
  r.data = await parcelOf(n);
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
async function showToast(service: JObj, t: ToastRecord): Promise<void> {
  const windowToken = await newObj("android/os/Binder", "()V");
  if (t.custom) await vcall(t.custom, "show", "(Landroid/os/IBinder;)V", windowToken);
  else {
    const ctx = await scall("android/app/ActivityThread", "currentApplication", "()Landroid/app/Application;");
    const res = await scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
    const id = (name: string, type: string) => vcall(res, "getIdentifier", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I", name, type, "android");
    const gravity: number = await vcall(res, "getInteger", "(I)I", await id("config_toastDefaultGravity", "integer"));
    const y: number = await vcall(res, "getDimensionPixelSize", "(I)I", await id("toast_y_offset", "dimen"));
    t.presenter = await newObj("android/widget/ToastPresenter", "(Landroid/content/Context;Landroid/view/accessibility/IAccessibilityManager;Landroid/app/INotificationManager;Ljava/lang/String;)V",
      ctx, await hostedService("accessibility"), service, t.pkg);
    const view = await scall("android/widget/ToastPresenter", "getTextToastView", "(Landroid/content/Context;Ljava/lang/CharSequence;)Landroid/view/View;", ctx, t.text);
    await vcall(t.presenter, "show", `(Landroid/view/View;Landroid/os/IBinder;Landroid/os/IBinder;IIIIFF${T}Z)V`, view, t.token, windowToken, t.duration, gravity, 0, y, 0, 0, t.callback, 0);
  }
  t.timer = setGuestTimeout(() => void onMain(() => hideToast(t)).catch(reportUncaught), TOAST_DELAY[t.duration ? 1 : 0]);
}
async function hideToast(t: ToastRecord): Promise<void> {
  const i = toastQueue.indexOf(t);
  if (i < 0) return;
  if (i > 0) { toastQueue.splice(i, 1); return; }
  clearGuestTimeout(t.timer);
  if (t.custom) await vcall(t.custom, "hide", "()V");
  else if (t.presenter) await vcall(t.presenter, "hide", `(${T})V`, t.callback);
  toastQueue.shift();
  if (toastQueue[0]) await showToast(toastService!, toastQueue[0]);
}
let toastService: JObj | null = null;
function enqueueToast(this: JObj, t: ToastRecord): number {
  toastService = this;
  toastQueue.push(t);
  if (toastQueue.length === 1) void showToast(this, t).catch(reportUncaught);
  return 1;
}

rt.register({ name: "webdroid/NotificationManagerService", ctor: class extends JObj {}, sup: "android/app/INotificationManager$Stub", methods: {
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
    if (t) return hideToast(t);
  },
  // ToastPresenter reports the window gone; the record left the queue when it was hidden
  "finishToken(Ljava/lang/String;Landroid/os/IBinder;)V": () => {},
  "enqueueNotificationWithTag(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILandroid/app/Notification;I)V": enqueueNotification,
  "cancelNotificationWithTag(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;II)V":
    async (pkg: string, opPkg: string | null, tag: string | null, id: number, userId: number) => {
      const { uid } = callingIdentity();
      if (userId === -1) userId = 0;
      resolveNotificationUid(opPkg, pkg, uid, userId);
      if (pkg !== opPkg) {
        const r = find(pkg, tag, id, userId);
        if (r && r.opPkg !== opPkg) fail("java/lang/SecurityException", `${opPkg} does not have permission to cancel a notification they did not post ${tag} ${id}`);
      }
      await cancelNotification(pkg, tag, id, 0, SYSTEM_UIDS.has(uid) ? 0 : CANCEL_MUST_NOT_HAVE, userId, REASON_APP_CANCEL);
    },
  "cancelAllNotifications(Ljava/lang/String;I)V": async (pkg: string, userId: number) => {
    checkCallerIsSystemOrSameApp(pkg);
    await cancelAll(pkg, null, CANCEL_ALL_MUST_NOT_HAVE, userId === -1 ? 0 : userId);
  },
  "getAppActiveNotifications(Ljava/lang/String;I)Landroid/content/pm/ParceledListSlice;": async (pkg: string, userId: number) => {
    checkCallerIsSystemOrSameApp(pkg);
    if (userId === -1) userId = 0;
    const mine = notificationStore.posted.filter((r) => r.userId === userId && (r.pkg === pkg || r.opPkg === pkg));
    const sbns: JObj[] = [];
    for (const r of hashOrder(mine, (r) => r.key)) sbns.push(await statusBarNotification(r));
    return listSlice(sbns);
  },

  "createNotificationChannelGroups(Ljava/lang/String;Landroid/content/pm/ParceledListSlice;)V": async (pkg: string, slice: JObj | null) => {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = await preferences(pkg);
    for (const group of await sliceItems(slice)) await createGroup(prefs, group ? await copyOf(GROUP, group) : fail("java/lang/NullPointerException", null));
  },
  "createNotificationChannels(Ljava/lang/String;Landroid/content/pm/ParceledListSlice;)V": async (pkg: string, slice: JObj | null) => {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = await preferences(pkg), had = prefs.ids(CHANNEL_KEY).length > 0;
    let created = false;
    for (const channel of await sliceItems(slice)) {
      if (!channel) fail("java/lang/NullPointerException", "channel in list is null");
      created = await createChannel(prefs, await copyOf(CHANNEL, channel)) || created;
    }
    // the prompt shows over a launcher task the user can see; a task still starting gets it at its next launch
    if (created && !had && appHost?.currentActivity()?.resumed && promptNeeded(pkg)) await showNotificationPrompt(pkg);
  },
  "getNotificationChannel(Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;)Landroid/app/NotificationChannel;":
    async (callingPkg: string, userId: number, pkg: string, channelId: string | null) => {
      if (!canNotifyAsPackage(callingPkg, pkg, userId)) fail("java/lang/SecurityException", `Pkg ${callingPkg} cannot read channels for ${pkg} in ${userId}`);
      return channelFor(await preferences(pkg), channelId);
    },
  "getNotificationChannels(Ljava/lang/String;Ljava/lang/String;I)Landroid/content/pm/ParceledListSlice;": async (callingPkg: string, pkg: string, userId: number) => {
    if (!canNotifyAsPackage(callingPkg, pkg, userId)) fail("java/lang/SecurityException", `Pkg ${callingPkg} cannot read channels for ${pkg} in ${userId}`);
    return listSlice(await (await preferences(pkg)).channels(false));
  },
  "deleteNotificationChannel(Ljava/lang/String;Ljava/lang/String;)V": async (pkg: string, channelId: string) => {
    checkCallerIsSystemOrSameApp(pkg);
    if (channelId === DEFAULT_CHANNEL) fail("java/lang/IllegalArgumentException", "Cannot delete default channel");
    enforceNoForegroundService(pkg, 0, channelId);
    await cancelAll(pkg, channelId, 0, 0);
    const prefs = await preferences(pkg), channel = await prefs.read(CHANNEL_KEY, channelId);
    if (channel) await deleteChannel(prefs, channel);
  },
  "getNotificationChannelGroup(Ljava/lang/String;Ljava/lang/String;)Landroid/app/NotificationChannelGroup;": async (pkg: string, groupId: string | null) => {
    checkCallerIsSystemOrSameApp(pkg);
    return groupWithChannels(await preferences(pkg), groupId, false);
  },
  /** getNotificationChannelGroups: every group, holding its channels, in its id's ArrayMap order */
  "getNotificationChannelGroups(Ljava/lang/String;)Landroid/content/pm/ParceledListSlice;": async (pkg: string) => {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = await preferences(pkg), groups = new Map<string, JObj>();
    for (const channel of await prefs.channels(false)) {
      const id: string | null = await vcall(channel, "getGroup", "()Ljava/lang/String;");
      if (id === null || !prefs.has(GROUP_KEY, id)) continue;
      let group = groups.get(id);
      if (!group) { group = (await prefs.read(GROUP_KEY, id))!; await vcall(group, "setChannels", "(Ljava/util/List;)V", newArrayList()); groups.set(id, group); }
      await vcall(group, "addChannel", "(Landroid/app/NotificationChannel;)V", channel);
    }
    for (const id of prefs.ids(GROUP_KEY)) if (!groups.has(id)) groups.set(id, (await prefs.read(GROUP_KEY, id))!);
    return listSlice(hashOrder([...groups], ([id]) => id).map(([, group]) => group));
  },
  "deleteNotificationChannelGroup(Ljava/lang/String;Ljava/lang/String;)V": async (pkg: string, groupId: string | null) => {
    checkCallerIsSystemOrSameApp(pkg);
    const prefs = await preferences(pkg), group = await groupWithChannels(prefs, groupId, false);
    if (!group) return;
    for (const channel of await toJsArray(await vcall(group, "getChannels", "()Ljava/util/List;")) as JObj[])
      enforceNoForegroundService(pkg, 0, await vcall(channel, "getId", "()Ljava/lang/String;"));
    prefs.remove(GROUP_KEY + groupId);
    for (const channel of await prefs.channels(true)) {
      if (await vcall(channel, "getGroup", "()Ljava/lang/String;") !== groupId) continue;
      await deleteChannel(prefs, channel);
      await cancelAll(pkg, await vcall(channel, "getId", "()Ljava/lang/String;"), 0, 0);
    }
  },

  "areNotificationsEnabled(Ljava/lang/String;)Z": (pkg: string) => areNotificationsEnabledForPackage(pkg, callingIdentity().uid),
  "areNotificationsEnabledForPackage(Ljava/lang/String;I)Z": areNotificationsEnabledForPackage,
  "getPackageImportance(Ljava/lang/String;)I": (pkg: string) => {
    checkCallerIsSystemOrSameApp(pkg);
    return hasPermission(callingIdentity().uid) ? IMPORTANCE_DEFAULT : IMPORTANCE_NONE;
  },
  // bubbles are on for the device and allowed for no app until the user allows one
  "areBubblesAllowed(Ljava/lang/String;)Z": (pkg: string) => { enforceSystemOrSystemUIOrSamePackage(pkg, "Caller not system or systemui or same package"); return 0; },
  "areBubblesEnabled(Landroid/os/UserHandle;)Z": () => 1,
  "getBubblePreferenceForPackage(Ljava/lang/String;I)I": (pkg: string) => { enforceSystemOrSystemUIOrSamePackage(pkg, "Caller not system or systemui or same package"); return 0; },
  // no package is suspended or paused here
  "isPackagePaused(Ljava/lang/String;)Z": (pkg: string) => { checkCallerIsSameApp(pkg); return 0; },
  "canNotifyAsPackage(Ljava/lang/String;Ljava/lang/String;I)Z": (callingPkg: string, pkg: string, userId: number) => +canNotifyAsPackage(callingPkg, pkg, userId),
  "canUseFullScreenIntent(Landroid/content/AttributionSource;)Z": async (source: JObj) => {
    const pkg: string | null = await vcall(source, "getPackageName", "()Ljava/lang/String;"), uid: number = await vcall(source, "getUid", "()I");
    checkCallerIsSameApp(pkg, uid);
    return +canUseFullScreenIntent(pkg!, targetSdk(pkg!));
  },
  "setNotificationDelegate(Ljava/lang/String;Ljava/lang/String;)V": async (pkg: string, delegate: string | null) => {
    checkCallerIsSameApp(pkg);
    const prefs = new Preferences(pkg);
    if (delegate === null) prefs.remove(DELEGATE_KEY);
    else if (packages.has(delegate)) { prefs.values.set(DELEGATE_KEY, delegate); prefs.save(); }
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
  "isNotificationListenerAccessGranted(Landroid/content/ComponentName;)Z": async (component: JObj | null) => {
    if (!component) fail("java/lang/NullPointerException", null);
    checkCallerIsSystemOrSameApp(await vcall(component, "getPackageName", "()Ljava/lang/String;"));
    return 0;
  },
  "isNotificationAssistantAccessGranted(Landroid/content/ComponentName;)Z": async (component: JObj | null) => {
    if (!component) fail("java/lang/NullPointerException", null);
    checkCallerIsSystemOrSameApp(await vcall(component, "getPackageName", "()Ljava/lang/String;"));
    return 0;
  },
  "shouldHideSilentStatusIcons(Ljava/lang/String;)Z": (pkg: string) => {
    checkCallerIsSameApp(pkg);
    return SYSTEM_UIDS.has(callingIdentity().uid) ? 0 : fail("java/lang/SecurityException", "Only available for notification listeners");
  },
} });
hostStub("notification", "webdroid/NotificationManagerService");

function areNotificationsEnabledForPackage(pkg: string, uid: number): number {
  enforceSystemOrSystemUIOrSamePackage(pkg, "Caller not system or systemui or same package");
  return +hasPermission(uid);
}
/** canNotifyAsPackage: an app may act for itself, or for a package that made it its delegate */
function canNotifyAsPackage(callingPkg: string, pkg: string, userId: number): boolean {
  checkCallerIsSameApp(callingPkg);
  if (userId !== 0) denyPermission("android.permission.INTERACT_ACROSS_USERS", `canNotifyAsPackage for user ${userId}`);
  return callingPkg === pkg || delegateOf(pkg) === callingPkg;
}
