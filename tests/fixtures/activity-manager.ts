// bun tests/fixtures/activity-manager.ts, with WEBDROID_BYTECODE=stage-d: what the activity manager asks of a
// process's IApplicationThread as its services and receivers are driven, as one JSON object.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
await import(W + "/tests/platform");
const { rt, JObj, declaredField } = await import(W + "/src/jvm/runtime");
await import(W + "/src/natives");
const { newObj, vcall } = await import(W + "/src/jvm/natives/jlang");
const { setAppHost } = await import(W + "/src/android/apphost");
const { packages, PackageRecord, packageUid } = await import(W + "/src/android/packages");
const { Resources } = await import(W + "/src/android/res");
const { TV } = await import(W + "/src/android/axml");
const { setProcessIdentity, setProcessName } = await import(W + "/src/android/os");
const { hostedService } = await import(W + "/src/android/binder");
const { newIntent, mkComponentName } = await import(W + "/src/android/intent");
const { deliverBroadcast } = await import(W + "/src/android/server/broadcastqueue");
const { startMainLooper } = await import(W + "/src/android/mainloop");
type JObj = InstanceType<typeof JObj>;
console.warn = () => {};

const PKG = "org.webdroid.test.am", SERVICE = PKG + ".Svc";
const attr = (name: string, str: string | null, data = 0) => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
const S = "Ljava/lang/String;", INTENT = "Landroid/content/Intent;", BINDER = "Landroid/os/IBinder;", APP = "Landroid/app/IApplicationThread;";
const BIND = `(${APP}${BINDER}${INTENT}${S}Landroid/app/IServiceConnection;J${S}${S}I)I`;

const calls: string[] = [], connected: string[] = [];
let token: JObj | null = null;
rt.register({ name: "webdroid/test/AppThread", ctor: class extends JObj {}, sup: "android/app/IApplicationThread$Stub", methods: {
  "bindApplication(Ljava/lang/String;Landroid/content/pm/ApplicationInfo;Ljava/lang/String;Ljava/lang/String;ZLandroid/content/pm/ProviderInfoList;Landroid/content/ComponentName;Landroid/app/ProfilerInfo;Landroid/os/Bundle;Landroid/app/IInstrumentationWatcher;Landroid/app/IUiAutomationConnection;IZZZZLandroid/content/res/Configuration;Landroid/content/res/CompatibilityInfo;Ljava/util/Map;Landroid/os/Bundle;Ljava/lang/String;Landroid/content/AutofillOptions;Landroid/content/ContentCaptureOptions;[J[JLandroid/os/SharedMemory;JJ)V": () => {},
  "scheduleCreateService(Landroid/os/IBinder;Landroid/content/pm/ServiceInfo;Landroid/content/res/CompatibilityInfo;I)V": (t: JObj, info: JObj) => {
    token = t; calls.push("create " + Reflect.get(info, declaredField("android/content/pm/ServiceInfo", "name")));
  },
  "scheduleServiceArgs(Landroid/os/IBinder;Landroid/content/pm/ParceledListSlice;)V": async (_t: JObj, slice: JObj) => {
    const args = await vcall(await vcall(slice, "getList", "()Ljava/util/List;"), "get", "(I)Ljava/lang/Object;", 0);
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

rt.linkNatives();
await startMainLooper();
const manifest = { name: "manifest", attrs: [attr("package", PKG)], children: [
  { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, 35)], children: [] },
  { name: "application", attrs: [], children: [{ name: "service", attrs: [attr("name", SERVICE)], children: [] }] },
] };
const record = new PackageRecord(manifest, new Resources(null, {}), `/${PKG}.apk`, packageUid(PKG), async () => [new Uint8Array([1])]);
packages.set(PKG, record);
setProcessIdentity(4322, record.uid); setProcessName(PKG);
setAppHost({ pkg: PKG, application: null, res: record.res, splits: [], currentActivity: () => null, activities: () => [] } as never);
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
await vcall(am, "publishService", `(${BINDER}${INTENT}${BINDER})V`, token, await serviceIntent(), await tagged("android/os/Binder", "published"));
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
console.log(JSON.stringify(out));
process.exit(0);
