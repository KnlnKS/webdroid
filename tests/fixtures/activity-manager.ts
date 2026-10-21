// pnpm ts tests/fixtures/activity-manager.ts: what the activity manager asks of a
// process's IApplicationThread as its services and receivers are driven, as one JSON object.
import "../../tests/platform.ts";
import "../../src/natives.ts";
import { rt, JObj, declaredField } from "../../src/jvm/runtime.ts";
import { classNameOf, newObj, vcall, scall } from "../../src/jvm/natives/jentry.ts";
import { setAppHost } from "../../src/android/apphost.ts";
import { testAppHost, fixtureDeadline } from "../../tests/java.ts";
import { packages, PackageRecord, packageUid } from "../../src/android/packages.ts";
import { emptyApk } from "../../src/android/res.ts";
import { TV } from "../../src/android/axml.ts";
import { setProcessIdentity, setProcessName } from "../../src/android/os.ts";
import { hostedService } from "../../src/android/binder.ts";
import { newIntent, mkComponentName } from "../../src/android/intent.ts";
import { deliverBroadcast } from "../../src/android/server/broadcastqueue.ts";
import { startMainLooper } from "../../src/android/mainloop.ts";
import { serviceTransport } from "../../src/android/server/activeservices.ts";
import { ServiceRecords } from "../../src/shell/servicerecords.ts";
import { serveCalls,callProxy } from "../../src/shell/rpc.ts";
console.warn = () => {};
fixtureDeadline();
// Exercise the real Java lifecycle with delayed owner replies, not a synchronous replica.
let creationGate: { entered: () => void; wait: Promise<void> } | undefined;
const starts = new ServiceRecords({ send: () => null, connected: () => {}, persistent: () => false }).starts("", ""), ports = new MessageChannel();
const stopStarts = serveCalls(ports.port1,Object.fromEntries(Object.entries(starts).map(([name,method]) =>
  [name,async (...args:unknown[]) => { await new Promise(resolve=>setTimeout(resolve,1)); if (name === "created" && creationGate) { creationGate.entered(); await creationGate.wait; } return (method as (...args:unknown[])=>unknown)(...args); }])));
const remoteStarts = callProxy<typeof starts>(ports.port2,Object.keys(starts) as (keyof typeof starts)[]);
serviceTransport.starts = () => remoteStarts.endpoint;


const PKG = "org.webdroid.test.am", SERVICE = PKG + ".Svc";
const attr = (name: string, str: string | null, data = 0) => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
const S = "Ljava/lang/String;", INTENT = "Landroid/content/Intent;", BINDER = "Landroid/os/IBinder;", APP = "Landroid/app/IApplicationThread;";
const BIND = `(${APP}${BINDER}${INTENT}${S}Landroid/app/IServiceConnection;J${S}${S}I)I`;

const calls: string[] = [], connected: string[] = [];
let token: JObj | null = null, delivered: JObj | null = null;
rt.register({ name: "webdroid/test/AppThread", ctor: class extends JObj {}, sup: "android/app/IApplicationThread$Stub", methods: {
  "bindApplication(Ljava/lang/String;Landroid/content/pm/ApplicationInfo;Ljava/lang/String;Ljava/lang/String;ZLandroid/content/pm/ProviderInfoList;Landroid/content/ComponentName;Landroid/app/ProfilerInfo;Landroid/os/Bundle;Landroid/app/IInstrumentationWatcher;Landroid/app/IUiAutomationConnection;IZZZZLandroid/content/res/Configuration;Landroid/content/res/CompatibilityInfo;Ljava/util/Map;Landroid/os/Bundle;Ljava/lang/String;Landroid/content/AutofillOptions;Landroid/content/ContentCaptureOptions;[J[JLandroid/os/SharedMemory;JJ)V": () => {},
  "scheduleCreateService(Landroid/os/IBinder;Landroid/content/pm/ServiceInfo;Landroid/content/res/CompatibilityInfo;I)V": (t: JObj, info: JObj) => {
    token = t; calls.push("create " + Reflect.get(info, declaredField("android/content/pm/ServiceInfo", "name")));
  },
  "scheduleServiceArgs(Landroid/os/IBinder;Landroid/content/pm/ParceledListSlice;)V": async (_t: JObj, slice: JObj) => {
    const args = await vcall(await vcall(slice, "getList", "()Ljava/util/List;"), "get", "(I)Ljava/lang/Object;", 0);
    delivered = Reflect.get(args, declaredField("android/app/ServiceStartArgs", "args")) as JObj;
    calls.push("args " + Reflect.get(args, declaredField("android/app/ServiceStartArgs", "startId")));
  },
  "scheduleBindService(Landroid/os/IBinder;Landroid/content/Intent;ZIJ)V": (_t: JObj, _i: JObj, rebind: number) => { calls.push("bind " + rebind); },
  "scheduleUnbindService(Landroid/os/IBinder;Landroid/content/Intent;)V": () => { calls.push("unbind"); },
  "scheduleStopService(Landroid/os/IBinder;)V": () => { calls.push("stop"); },
  // a registered receiver adds its tag to the result and finishes, as an ordered PendingResult does
  "scheduleRegisteredReceiver(Landroid/content/IIntentReceiver;Landroid/content/Intent;ILjava/lang/String;Landroid/os/Bundle;ZZZIIILjava/lang/String;)V":
    async (receiver: JObj, _intent: JObj, code: number, data: string | null, extras: JObj | null, ordered: number) => {
      const tag = Reflect.get(receiver, "tag") as string;
      calls.push("receive " + tag);
      if (ordered) await vcall(await hostedService("activity"), "finishReceiver", `(${BINDER}I${S}Landroid/os/Bundle;ZI)V`, receiver, code + 1, (data ?? "") + tag, extras, +(tag === "abort"), 0);
    },
} });
rt.register({ name: "webdroid/test/Connection", ctor: class extends JObj {}, sup: "android/app/IServiceConnection$Stub", methods: {
  "connected(Landroid/content/ComponentName;Landroid/os/IBinder;Z)V": (_name: JObj, binder: JObj | null, dead: number) => { connected.push(`${binder ? Reflect.get(binder, "tag") : null} ${dead}`); },
} });
// a binder of the host's, which carries the tag the test reads back
rt.register({ name: "webdroid/test/Binder", ctor: class extends JObj {}, sup: "android/os/Binder" });
rt.register({ name: "webdroid/test/Receiver", ctor: class extends JObj {}, sup: "android/content/IIntentReceiver$Stub", methods: {
  "performReceive(Landroid/content/Intent;ILjava/lang/String;Landroid/os/Bundle;ZZI)V": () => {},
} });
const tagged = async (cls: string, tag: string) => { const o = await newObj(cls); Reflect.set(o, "tag", tag); return o; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const serviceIntent = async () => {
  const intent = await newIntent();
  await vcall(intent, "setComponent", `(Landroid/content/ComponentName;)${INTENT}`, await mkComponentName(PKG, SERVICE));
  return intent;
};

await startMainLooper();
const manifest = { name: "manifest", attrs: [attr("package", PKG)], children: [
  { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, 35)], children: [] },
  { name: "application", attrs: [], children: [{ name: "service", attrs: [attr("name", SERVICE)], children: [] }] },
] };
const record = new PackageRecord(manifest, emptyApk(), `/${PKG}.apk`, packageUid(PKG), async () => [new Uint8Array([1])]);
packages.set(PKG, record);
setProcessIdentity(4322, record.uid); setProcessName(PKG);
setAppHost(testAppHost(record));
const am = await hostedService("activity") as JObj, app = await newObj("webdroid/test/AppThread");
await vcall(am, "attachApplication", `(${APP}J)V`, app, 0n);
const out: Record<string, unknown> = {};

// a started service is bound by two clients, published once, unbound, then stopped by its last start id
const name = await vcall(am, "startService", `(${APP}${INTENT}${S}Z${S}${S}I)Landroid/content/ComponentName;`, app, await serviceIntent(), null, 0, PKG, null, 0);
out.started = await vcall(name, "getClassName", `()${S}`);
const first = await newObj("webdroid/test/Connection"), second = await newObj("webdroid/test/Connection");
out.bound = await vcall(am, "bindServiceInstance", BIND, app, null, await serviceIntent(), null, first, 1n, null, PKG, 0);
await settle();
out.up = calls.splice(0);
await vcall(am, "publishService", `(${BINDER}${INTENT}${BINDER})V`, token, await serviceIntent(), await tagged("webdroid/test/Binder", "published"));
await vcall(am, "bindServiceInstance", BIND, app, null, await serviceIntent(), null, second, 1n, null, PKG, 0);
await settle();
out.connected = connected.splice(0);
for (const conn of [first, second]) await vcall(am, "unbindService", "(Landroid/app/IServiceConnection;)Z", conn);
await settle();
out.unbound = calls.splice(0);
out.staleStop = await vcall(am, "stopServiceToken", `(Landroid/content/ComponentName;${BINDER}I)Z`, name, token, 2);
out.stop = await vcall(am, "stopServiceToken", `(Landroid/content/ComponentName;${BINDER}I)Z`, name, token, 1);
await settle();
out.down = calls.splice(0);

// Two real Java bind chains wait for one delayed creation. The first caller then
// suspends independently; it must not keep the second bind waiting on its stack.
const creationEntered = Promise.withResolvers<void>(), allowCreation = Promise.withResolvers<void>();
const allowCaller = Promise.withResolvers<void>();
creationGate = { entered: creationEntered.resolve, wait: allowCreation.promise };
const concurrentIntent = await serviceIntent(), ca = await newObj("webdroid/test/Connection"), cb = await newObj("webdroid/test/Connection");
let firstFinished = false;
const firstBind = rt.drive(function* (): import("../../src/jvm/runtime.ts").Gen<void> {
  yield vcall(am, "bindServiceInstance", BIND, app, null, concurrentIntent, null, ca, 1n, null, PKG, 0);
  yield allowCaller.promise;
  firstFinished = true;
}());
await creationEntered.promise;
const secondBind = rt.drive(function* (): import("../../src/jvm/runtime.ts").Gen<number> {
  return yield vcall(am, "bindServiceInstance", BIND, app, null, concurrentIntent, null, cb, 1n, null, PKG, 0);
}());
// The existing owner channel delays requested/created acknowledgments by one task.
await new Promise(resolve => setTimeout(resolve, 25));
allowCreation.resolve();
let concurrentTimer: ReturnType<typeof setTimeout> | undefined;
try {
  const second = await Promise.race([secondBind, new Promise(resolve => { concurrentTimer = setTimeout(() => resolve("timeout"), 1000); })]);
  out.concurrent = { second, firstFinished, creates: calls.filter(call => call.startsWith("create ")).length };
} finally { clearTimeout(concurrentTimer); allowCaller.resolve(); }
await firstBind;
creationGate = undefined;
for (const conn of [ca, cb]) await vcall(am, "unbindService", "(Landroid/app/IServiceConnection;)Z", conn);
await settle(); calls.splice(0);

// an ordered broadcast reaches registered receivers by priority, each from the last one's result
for (const [tag, priority] of [["b", 1], ["a", 2], ["abort", 0], ["never", -1]] as const) {
  const filter = await newObj("android/content/IntentFilter", `(${S})V`, "org.webdroid.test.PING");
  await vcall(filter, "setPriority", "(I)V", priority);
  await vcall(am, "registerReceiverWithFeature", `(${APP}${S}${S}${S}Landroid/content/IIntentReceiver;Landroid/content/IntentFilter;${S}II)${INTENT}`,
    app, PKG, null, null, await tagged("webdroid/test/Receiver", tag), filter, null, 0, 4);
}
const result = await deliverBroadcast(await newIntent("org.webdroid.test.PING"), null, true, { code: 0, data: null, extras: null, aborted: false }, null);
out.ordered = { calls: calls.splice(0), code: result.code, data: result.data, aborted: result.aborted };
// another app's broadcast does not reach receivers registered RECEIVER_NOT_EXPORTED
await deliverBroadcast(await newIntent("org.webdroid.test.PING"), null, false, { code: 0, data: null, extras: null, aborted: false }, { uid: 10999, pkg: "other" });
await settle();
out.foreign = calls.splice(0);

// the app reaches the activity manager through a parcel, as it reaches system_server: the started
// service gets a copy of the extras, and a start too large for the binder buffer fails
const proxy = await scall("android/app/ActivityManager", "getService", "()Landroid/app/IActivityManager;") as JObj;
const START = `(${APP}${INTENT}${S}Z${S}${S}I)Landroid/content/ComponentName;`;
const list = await newObj("java/util/ArrayList"), withList = await serviceIntent();
await vcall(withList, "putStringArrayListExtra", `(${S}Ljava/util/ArrayList;)${INTENT}`, "list", list);
await vcall(proxy, "startService", START, app, withList, null, 0, PKG, null, 0);
await vcall(list, "add", "(Ljava/lang/Object;)Z", "late");
await settle();
const copy = await vcall(delivered!, "getStringArrayListExtra", `(${S})Ljava/util/ArrayList;`, "list") as JObj;
out.copied = { proxy: classNameOf(proxy), same: copy === list, size: await vcall(copy, "size", "()I") };
const big = await serviceIntent();
await vcall(big, "putExtra", `(${S}[B)${INTENT}`, "big", new Int8Array(2 << 20));
out.tooLarge = await Promise.resolve().then(() => vcall(proxy, "startService", START, app, big, null, 0, PKG, null, 0))
  .then(() => null, (e: { msg?: string }) => `${classNameOf(e)}: ${e.msg}`);
remoteStarts.close();stopStarts();
console.log(JSON.stringify(out));
process.exit(0);
