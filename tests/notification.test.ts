import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import "../src/natives";
import { rt, JObj, declaredField } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jentry";
import { stringHash } from "../src/jvm/abi";
import { packageUid } from "../src/android/packages";
import { grantPermissions } from "../src/android/permissions";
import { preferenceStore, canonicalPreferenceCommands, usePreferenceAccess, usePreferenceStore, type PreferenceCalls } from "../src/android/sharedprefs";
import { callProxy, serveCalls } from "../src/shell/process-port";
import { ownedSystemService, useSystemServiceAccess, type BinderHandle } from "../src/android/binder";
import { notificationTransport, receiveForegroundNotification, startForegroundNotification, stopForegroundNotification, type ForegroundNotificationRequest } from "../src/android/notification";
import { PROCESS_PID } from "../src/android/os";
import { bootApp, packageRecord } from "./java";

const pkg = "org.webdroid.test.notify";
const N = "Landroid/app/Notification;", B = "Landroid/app/Notification$Builder;";
let manager: JObj, app: JObj;
let closePreferences: () => void;
rt.linkNatives();

beforeAll(async () => {
  app = await bootApp(await packageRecord(pkg, { permissions: ["android.permission.POST_NOTIFICATIONS"] }));
  const owner = preferenceStore, { port1, port2 } = new MessageChannel();
  const foreground = notificationTransport.foreground;
  type Calls = PreferenceCalls & {
    systemService(name: string): Promise<BinderHandle | null>;
    foreground(request: ForegroundNotificationRequest): Promise<void>;
  };
  const stop = serveCalls(port1, { ...canonicalPreferenceCommands(owner, name => {
    if (name !== "android:notification-policy:" + pkg) throw new Error("foreign preference file");
  }), systemService: ownedSystemService,
    foreground: (request: ForegroundNotificationRequest) => receiveForegroundNotification(pkg, {pid:PROCESS_PID,uid:packageUid(pkg)}, request),
  });
  const client = callProxy<Calls>(port2, ["preferenceRead", "preferenceKeys", "preferenceChange", "preferenceFiles", "systemService", "foreground"]);
  usePreferenceAccess(client.endpoint);
  useSystemServiceAccess(["notification"], client.endpoint.systemService);
  notificationTransport.foreground = client.endpoint.foreground;
  closePreferences = () => { client.close(); stop(); usePreferenceStore(owner); useSystemServiceAccess([]); notificationTransport.foreground = foreground; };
  manager = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "notification");
});
afterAll(() => closePreferences?.());

const channel = async (id: string, name: string, importance: number) =>
  newObj("android/app/NotificationChannel", "(Ljava/lang/String;Ljava/lang/CharSequence;I)V", id, name, importance);
async function build(channelId: string, title: string): Promise<JObj> {
  let b = await newObj("android/app/Notification$Builder", "(Landroid/content/Context;Ljava/lang/String;)V", app, channelId);
  b = await vcall(b, "setSmallIcon", `(I)${B}`, 0x0108009b);
  b = await vcall(b, "setContentTitle", `(Ljava/lang/CharSequence;)${B}`, title);
  return vcall(b, "build", `()${N}`);
}
const active = async (): Promise<JObj[]> => [...await vcall(manager, "getActiveNotifications", "()[Landroid/service/notification/StatusBarNotification;")];
const keys = async () => Promise.all((await active()).map((s) => vcall(s, "getKey", "()Ljava/lang/String;")));

describe("notification-manager", () => {
  test("channels keep the user's settings when an app recreates them", async () => {
    const a = await channel("a", "Alpha", 4);
    await vcall(a, "setBypassDnd", "(Z)V", 1);
    await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", a);
    let stored = await vcall(manager, "getNotificationChannel", "(Ljava/lang/String;)Landroid/app/NotificationChannel;", "a");
    expect(stored).not.toBe(a);
    expect(await vcall(stored, "canBypassDnd", "()Z")).toBe(0);
    await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("a", "Alpha2", 2));
    await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("a", "Alpha3", 4));
    stored = await vcall(manager, "getNotificationChannel", "(Ljava/lang/String;)Landroid/app/NotificationChannel;", "a");
    expect(await vcall(stored, "getName", "()Ljava/lang/CharSequence;")).toBe("Alpha3");
    expect(await vcall(stored, "getImportance", "()I")).toBe(2);
    const rejected = await vcallAsync(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("miscellaneous", "M", 3))
      .then(() => null, error => error);
    expect(rejected).toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
    await vcall(manager, "deleteNotificationChannel", "(Ljava/lang/String;)V", "a");
    expect(await vcall(manager, "getNotificationChannel", "(Ljava/lang/String;)Landroid/app/NotificationChannel;", "a")).toBeNull();
  });

  test("notifications post only with POST_NOTIFICATIONS, as copies, and cancel by tag and id", async () => {
    await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("p", "Post", 3));
    expect(await vcall(manager, "areNotificationsEnabled", "()Z")).toBe(0);
    await vcall(manager, "notify", `(I${N})V`, 1, await build("p", "one"));
    expect(await active()).toEqual([]);
    grantPermissions(["android.permission.POST_NOTIFICATIONS"]);
    expect(await vcall(manager, "areNotificationsEnabled", "()Z")).toBe(1);
    const n = await build("p", "one");
    await vcall(manager, "notify", `(I${N})V`, 1, n);
    await vcall(manager, "notify", `(Ljava/lang/String;I${N})V`, "t", 1, await build("p", "tagged"));
    await vcall(manager, "notify", `(I${N})V`, 2, await build("ghost", "dropped"));
    const uid = packageUid(pkg);
    // two ungrouped notifications are bundled under the system's autogroup summary, listed in their
    // keys' Java hash order (ArrayMap's), which the package's uid decides
    const tag = `0|${pkg}|1|t|${uid}`;
    expect(await keys()).toEqual([tag, `0|${pkg}|1|null|${uid}`, `0|${pkg}|2147483647|ranker_group|${uid}|ranker_group`].sort((a, b) => stringHash(a) - stringHash(b)));
    const tagged = (await active())[(await keys()).indexOf(tag)];
    expect(await vcall(tagged, "getNotification", `()${N}`)).not.toBe(n);
    expect(await vcall(tagged, "getGroupKey", "()Ljava/lang/String;")).toBe(`0|${pkg}|g:ranker_group`);
    // a custom view travels with the notification as AOSP's RemoteViews
    const views = await newObj("android/widget/RemoteViews", "(Ljava/lang/String;I)V", pkg, 0x7f0b0001);
    await vcall(views, "setTextViewText", "(ILjava/lang/CharSequence;)V", 0x7f080001, "custom");
    let b = await newObj("android/app/Notification$Builder", "(Landroid/content/Context;Ljava/lang/String;)V", app, "p");
    b = await vcall(b, "setSmallIcon", `(I)${B}`, 0x0108009b);
    b = await vcall(b, "setCustomContentView", `(Landroid/widget/RemoteViews;)${B}`, views);
    await vcall(manager, "notify", `(Ljava/lang/String;I${N})V`, "c", 3, await vcall(b, "build", `()${N}`));
    const posted = (await Promise.all((await active()).map(async (s) => [await vcall(s, "getTag", "()Ljava/lang/String;"), s] as const))).find(([tag]) => tag === "c")![1];
    const copy = (await vcall(posted, "getNotification", `()${N}`) as Record<string, JObj>)[declaredField("android/app/Notification", "contentView")];
    expect(copy).not.toBe(views);
    expect(await vcall(copy, "getLayoutId", "()I")).toBe(0x7f0b0001);
    await vcall(manager, "cancel", "(Ljava/lang/String;I)V", "t", 1);
    await vcall(manager, "deleteNotificationChannel", "(Ljava/lang/String;)V", "p");
    expect(await active()).toEqual([]);
    await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("fg", "Service", 3));
    await startForegroundNotification(7, await build("fg", "service"));
    const foreground = await active();
    expect(foreground.length).toBe(1);
    const serviceNotification = await vcall(foreground[0], "getNotification", `()${N}`);
    expect((serviceNotification as Record<string, number>)[declaredField("android/app/Notification", "flags")] & 64).toBe(64);
    await stopForegroundNotification(7, true);
    expect(await active()).toEqual([]);
  });
});
