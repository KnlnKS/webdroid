import { expect, test, beforeAll, afterAll, describe } from "vite-plus/test";
import "../src/natives.ts";
import { type JObj, declaredField } from "../src/jvm/runtime.ts";
import { classNameOf, newObj, vcall, vcallAsync } from "../src/jvm/natives/jentry.ts";
import { stringHash } from "../src/jvm/abi.ts";
import { packageUid } from "../src/android/packages.ts";
import { canonicalPermissionCommands, grantPermissions, permissionStore } from "../src/android/permissions.ts";
import { callProxy, serveCalls } from "../src/shell/rpc.ts";
import { ownedSystemService, parcelled, type BinderHandle } from "../src/android/binder.ts";
import { notificationStore, receiveForegroundNotification, startForegroundNotification, stopForegroundNotification, type ForegroundNotificationRequest } from "../src/android/notification.ts";
import { vfs } from "../src/shell/vfs.ts";
import { fdInt, mkFd } from "../src/jvm/natives/jio.ts";
import { localOpen } from "../src/native/fs.ts";
import { readFd, openFd } from "../src/native/fd.ts";
import { ProcessBroker } from "../src/shell/processes.ts";
import { brokerMethods, type BrokerCalls } from "../src/shell/broker-contract.ts";
import { descriptorTransport, processRights } from "../src/native/process-fd.ts";
import { NOT_CRASHED } from "../src/android/server/appexitinfo.ts";
import { bootApp, packageRecord, useTestBroker } from "./java.ts";
import { procIdentity } from "../src/shell/procfs.ts";

const pkg = "org.webdroid.test.notify";
const N = "Landroid/app/Notification;", B = "Landroid/app/Notification$Builder;";
let manager: JObj, app: JObj;
let closeService: () => void;
/** the grants the broker answers this Worker with: this realm's own, which system_server holds */
const permissions = canonicalPermissionCommands(permissionStore, () => {}) as BrokerCalls["permissions"];

// the app reaches the service and posts its foreground notification over a port, as a Worker does
beforeAll(async () => {
  app = await bootApp(await packageRecord(pkg, { permissions: ["android.permission.POST_NOTIFICATIONS"] }));
  const { port1, port2 } = new MessageChannel();
  type Calls = {
    systemService(name: string): Promise<BinderHandle | null>;
    foreground(request: ForegroundNotificationRequest): Promise<void>;
  };
  const stop = serveCalls(port1, { systemService: ownedSystemService,
    foreground: (request: ForegroundNotificationRequest) => receiveForegroundNotification(pkg, {pid:procIdentity.pid,uid:packageUid(pkg)}, request),
  });
  const client = callProxy<Calls>(port2, ["systemService", "foreground"]);
  const restore = useTestBroker({ systemService: client.endpoint.systemService, notificationForeground: client.endpoint.foreground, permissions }, true);
  closeService = () => { client.close(); stop(); restore(); };
  manager = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "notification");
});
afterAll(() => closeService?.());

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
    expect(classNameOf(rejected)).toBe("java/lang/IllegalArgumentException");
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


test("stored notification descriptors share offsets and release on replacement, cancel, data clear and foreground rewrite", async () => {
  grantPermissions(["android.permission.POST_NOTIFICATIONS"]);
  await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("fd", "FD", 3));
  const path = "/data/data/" + pkg + "/notification-fd.bin";
  vfs.write(path, Uint8Array.of(1, 2, 3, 4));
  const source = localOpen(path, 2), file = openFd(source)!;
  const pfd = await newObj("android/os/ParcelFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(source));
  const copies: JObj[] = [];
  const make = async () => {
    const n = await build("fd", "descriptor");
    await vcall((n as Record<string, JObj>)[declaredField("android/app/Notification", "extras")], "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "fd", pfd);
    return n;
  };
  const read = async (id: number) => {
    const sbns = await active();
    const sbn = (await Promise.all(sbns.map(async s => [await vcall(s, "getId", "()I"), s] as const))).find(([n]) => n === id)![1];
    expect(await vcall(sbn, "getInitialPid", "()I")).toBe(procIdentity.pid);
    const n = await vcall(sbn, "getNotification", `()${N}`);
    const extras = (n as Record<string, JObj>)[declaredField("android/app/Notification", "extras")];
    const copy = await vcall(extras, "getParcelable", "(Ljava/lang/String;)Landroid/os/Parcelable;", "fd");
    await vcall(extras, "clear", "()V");
    copies.push(copy);
    const one = new Uint8Array(1);
    expect(readFd(fdInt(await vcall(copy, "getFileDescriptor", "()Ljava/io/FileDescriptor;")), one, 1)).toBe(1);
    return one[0];
  };
  try {
    await vcall(manager, "notify", `(I${N})V`, 98, await make());
    expect(file.references).toBe(2);
    expect(await read(98)).toBe(1);
    expect(await read(98)).toBe(2);
    for (const copy of copies.splice(0)) await vcall(copy, "close", "()V");
    expect(file.references).toBe(2);
    await vcall(manager, "notify", `(I${N})V`, 98, await make());
    expect(file.references).toBe(2);
    await vcall(manager, "cancel", "(I)V", 98);
    expect(file.references).toBe(1);
    await vcall(manager, "notify", `(I${N})V`, 98, await make());
    await notificationStore.clear(pkg, packageUid(pkg), {fromApp: true, keepState: true});
    expect(file.references).toBe(2);
    await notificationStore.clear(pkg, packageUid(pkg), {fromApp: true, keepState: false});
    expect(file.references).toBe(1);
    const capture = notificationStore.capture;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve), blocked = new Promise<void>(resolve => release = resolve);
    notificationStore.capture = async function(n) { const data = await capture.call(this, n); entered(); await blocked; return data; };
    try {
      const pending = vcallAsync(manager, "notify", `(I${N})V`, 98, await make());
      await waiting;
      await notificationStore.clear(pkg, packageUid(pkg), {fromApp:true,keepState:false});
      release(); await pending;
      expect(notificationStore.posted).toHaveLength(0);
      expect(file.references).toBe(1);
    } finally { release(); notificationStore.capture = capture; }
    const restore = useTestBroker({});
    try {
      await startForegroundNotification(99, await make());
      expect(file.references).toBe(2);
      await stopForegroundNotification(99, false);
      expect(file.references).toBe(2);
      await vcall(pfd, "close", "()V");
      expect(file.references).toBe(1);
      expect(await read(99)).toBe(3);
      await stopForegroundNotification(99, true);
      expect(readFd(fdInt(await vcall(copies[0], "getFileDescriptor", "()Ljava/io/FileDescriptor;")), new Uint8Array(1), 1)).toBe(1);
    } finally { restore(); }
  } finally {
    for (const copy of copies) await vcall(copy, "close", "()V");
    await notificationStore.clear(pkg, packageUid(pkg), {fromApp: true, keepState: false});
    await vcall(pfd, "close", "()V"); vfs.delete(path);
  }
  expect(file.references).toBe(0);
});

test("foreground broker retains transferred rights after sender death and rejects partial replacement rights", async () => {
  const descriptors = {...descriptorTransport}, store = notificationStore;
  const broker = new ProcessBroker(); broker.register(pkg, pkg + ":fd", 7701);
  const client = callProxy<BrokerCalls>(broker.brokerPort(7701), brokerMethods);
  const path = "/data/data/" + pkg + "/foreground-fd.bin";
  vfs.write(path, Uint8Array.of(7, 8));
  const source = localOpen(path, 2), file = openFd(source)!;
  const pfd = await newObj("android/os/ParcelFileDescriptor", "(Ljava/io/FileDescriptor;)V", await mkFd(source));
  let recipient: JObj | undefined, restore = () => {};
  try {
    const { files, descriptors: calls, notificationForeground } = client.endpoint;
    restore = useTestBroker({ files, descriptors: calls, notificationForeground, permissions }, true);
    descriptorTransport.local = broker.descriptorRights(7701);
    grantPermissions(["android.permission.POST_NOTIFICATIONS"]);
    await vcall(manager, "createNotificationChannel", "(Landroid/app/NotificationChannel;)V", await channel("brokerfd", "Broker FD", 3));
    const n = await build("brokerfd", "foreground descriptor");
    await vcall((n as Record<string, JObj>)[declaredField("android/app/Notification", "extras")], "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "fd", pfd);
    await startForegroundNotification(100, n);
    expect(file.references).toBe(2);
    const previous = store.posted[0];
    expect(previous.pid).toBe(7701);
    const broken = await parcelled(n, processRights);
    broken.objects.push([999, {descriptor: -1}]);
    expect(await client.endpoint.notificationForeground({kind:"start",id:100,data:broken}).then(() => "", error => error.message)).toContain("Invalid Binder descriptor right");
    expect(store.posted[0]).toBe(previous);
    expect(file.references).toBe(2);
    await vcall(pfd, "close", "()V");
    broker.fail(7701, "sender exited", NOT_CRASHED);
    expect(file.references).toBe(1);
    const [sbn] = await active();
    expect(await vcall(sbn, "getInitialPid", "()I")).toBe(7701);
    const returned = await vcall(sbn, "getNotification", `()${N}`), extras = (returned as Record<string, JObj>)[declaredField("android/app/Notification", "extras")];
    recipient = await vcall(extras, "getParcelable", "(Ljava/lang/String;)Landroid/os/Parcelable;", "fd");
    await vcall(extras, "clear", "()V");
    await receiveForegroundNotification(pkg, {pid:7702,uid:packageUid(pkg)}, {kind:"stop",id:100,remove:true});
    const byte = new Uint8Array(1);
    expect(readFd(fdInt(await vcall(recipient, "getFileDescriptor", "()Ljava/io/FileDescriptor;")), byte, 1)).toBe(1);
    expect([...byte]).toEqual([7]);
  } finally {
    if (recipient) await vcall(recipient, "close", "()V");
    await store.clear(pkg, packageUid(pkg), {fromApp:true,keepState:false});
    await vcall(pfd, "close", "()V");
    for (const key of Object.keys(descriptorTransport)) Reflect.deleteProperty(descriptorTransport, key);
    Object.assign(descriptorTransport, descriptors); restore();
    client.close(); broker.fail(7701, "test cleanup", NOT_CRASHED); vfs.delete(path);
  }
  expect(file.references).toBe(0);
});
