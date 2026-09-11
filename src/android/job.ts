// android.app.job: JobScheduler surface. Jobs are remembered so schedule/cancel/query stay consistent; nothing here ever runs one.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { JList } from "../jvm/natives/jutil";
import { JContextWrapper } from "./context";

class JJobInfo extends JObj { p: Record<string, any> = { id: 0, svc: null, triggers: [] as unknown[] }; }
class JJobInfoBuilder extends JObj { j = new JJobInfo(); }

const jobSetters: NonNullable<NativeSpec["methods"]> = {};
const jobGetters: NonNullable<NativeSpec["methods"]> = {};
for (const [setter, prop, getter] of [
  ["setRequiredNetworkType(I)", "netType", "getNetworkType()I"],
  ["setRequiredNetwork(Landroid/net/NetworkRequest;)", "netReq", "getRequiredNetwork()Landroid/net/NetworkRequest;"],
  ["setRequiresCharging(Z)", "charging", "isRequireCharging()Z"],
  ["setRequiresDeviceIdle(Z)", "idle", "isRequireDeviceIdle()Z"],
  ["setRequiresBatteryNotLow(Z)", "batteryNotLow", "isRequireBatteryNotLow()Z"],
  ["setRequiresStorageNotLow(Z)", "storageNotLow", "isRequireStorageNotLow()Z"],
  ["setPersisted(Z)", "persisted", "isPersisted()Z"],
  ["setExpedited(Z)", "expedited", "isExpedited()Z"],
  ["setImportantWhileForeground(Z)", "important", "isImportantWhileForeground()Z"],
  ["setMinimumLatency(J)", "minLatency", "getMinLatencyMillis()J"],
  ["setOverrideDeadline(J)", "deadline", "getMaxExecutionDelayMillis()J"],
  ["setPeriodic(J)", "interval", "getIntervalMillis()J"],
  ["setExtras(Landroid/os/PersistableBundle;)", "extras", "getExtras()Landroid/os/PersistableBundle;"],
  ["setTransientExtras(Landroid/os/Bundle;)", "transient", "getTransientExtras()Landroid/os/Bundle;"],
  ["setTriggerContentUpdateDelay(J)", "contentUpdateDelay", "getTriggerContentUpdateDelay()J"],
  ["setTriggerContentMaxDelay(J)", "contentMaxDelay", "getTriggerContentMaxDelay()J"],
]) {
  const arg = setter.slice(setter.indexOf("(") + 1, -1);
  const dflt = arg === "J" ? 0n : arg === "I" || arg === "Z" ? 0 : null;
  jobSetters[setter + "Landroid/app/job/JobInfo$Builder;"] =
    function (this: JJobInfoBuilder, v: unknown) { this.j.p[prop] = v; return this; };
  jobGetters[getter] = function (this: JJobInfo) { return this.p[prop] ?? dflt; };
}
rt.register({
  name: "android/app/job/JobInfo$Builder", ctor: JJobInfoBuilder,
  methods: {
    ...jobSetters,
    "<init>(ILandroid/content/ComponentName;)V": function (this: JJobInfoBuilder, id: number, svc: unknown) {
      this.j.p.id = id; this.j.p.svc = svc;
    },
    "setBackoffCriteria(JI)Landroid/app/job/JobInfo$Builder;": function (this: JJobInfoBuilder, ms: bigint, policy: number) {
      this.j.p.backoff = ms; this.j.p.backoffPolicy = policy; return this;
    },
    "addTriggerContentUri(Landroid/app/job/JobInfo$TriggerContentUri;)Landroid/app/job/JobInfo$Builder;":
      function (this: JJobInfoBuilder, u: unknown) { this.j.p.triggers.push(u); return this; },
    "build()Landroid/app/job/JobInfo;": function (this: JJobInfoBuilder) {
      const j = new JJobInfo();
      j.p = { ...this.j.p, triggers: this.j.p.triggers.slice() };
      return j;
    },
  },
});
rt.register({
  name: "android/app/job/JobInfo", ctor: JJobInfo,
  statics: {
    NETWORK_TYPE_NONE: 0, NETWORK_TYPE_ANY: 1, NETWORK_TYPE_UNMETERED: 2, NETWORK_TYPE_NOT_ROAMING: 3,
    NETWORK_TYPE_CELLULAR: 4, NETWORK_TYPE_METERED: 4,
    BACKOFF_POLICY_LINEAR: 0, BACKOFF_POLICY_EXPONENTIAL: 1,
    DEFAULT_INITIAL_BACKOFF_MILLIS: 30000n, MAX_BACKOFF_DELAY_MILLIS: 18000000n,
  },
  methods: {
    ...jobGetters,
    "getId()I": function (this: JJobInfo) { return this.p.id; },
    "getService()Landroid/content/ComponentName;": function (this: JJobInfo) { return this.p.svc; },
    "getInitialBackoffMillis()J": function (this: JJobInfo) { return this.p.backoff ?? 30000n; },
    "getBackoffPolicy()I": function (this: JJobInfo) { return this.p.backoffPolicy ?? 1; },
    "getTriggerContentUris()[Landroid/app/job/JobInfo$TriggerContentUri;": function (this: JJobInfo) {
      const t: unknown[] = this.p.triggers;
      if (!t.length) return null;
      const a = t.slice(); (a as any).$t = "Landroid/app/job/JobInfo$TriggerContentUri;"; return a;
    },
  },
});
class JTriggerUri extends JObj { uri: unknown = null; flags = 0; }
rt.register({
  name: "android/app/job/JobInfo$TriggerContentUri", ctor: JTriggerUri,
  statics: { FLAG_NOTIFY_FOR_DESCENDANTS: 1 },
  methods: {
    "<init>(Landroid/net/Uri;I)V": function (this: JTriggerUri, u: unknown, f: number) { this.uri = u; this.flags = f; },
    "getUri()Landroid/net/Uri;": function (this: JTriggerUri) { return this.uri; },
    "getFlags()I": function (this: JTriggerUri) { return this.flags; },
  },
});
const pendingJobs = new Map<number, JJobInfo>();
rt.register({
  name: "android/app/job/JobScheduler", ctor: class extends JObj {},
  statics: { RESULT_FAILURE: 0, RESULT_SUCCESS: 1 },
  methods: {
    "schedule(Landroid/app/job/JobInfo;)I": (j: JJobInfo) => { if (j) pendingJobs.set(j.p.id, j); return 1; },
    "enqueue(Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I": (j: JJobInfo) => { if (j) pendingJobs.set(j.p.id, j); return 1; },
    "cancel(I)V": (id: number) => { pendingJobs.delete(id); },
    "cancelAll()V": () => { pendingJobs.clear(); },
    "getPendingJob(I)Landroid/app/job/JobInfo;": (id: number) => pendingJobs.get(id) ?? null,
    "getAllPendingJobs()Ljava/util/List;": () => { const l = new JList(); l.a = [...pendingJobs.values()]; return l; },
    // API 34: a namespaced view of the same scheduler. Nothing here runs a job, and ids are
    // already unique per caller, so the namespace only has to exist. WorkManager needs it.
    "forNamespace(Ljava/lang/String;)Landroid/app/job/JobScheduler;": function (this: JObj) { return this; },
    "getNamespace()Ljava/lang/String;": () => null,
  },
});
class JJobParameters extends JObj { id = 0; extras: unknown = null; }
rt.register({
  name: "android/app/job/JobParameters", ctor: JJobParameters,
  methods: {
    "getJobId()I": function (this: JJobParameters) { return this.id; },
    "getExtras()Landroid/os/PersistableBundle;": function (this: JJobParameters) { return this.extras; },
    "getNetwork()Landroid/net/Network;": () => null,
    "getTriggeredContentAuthorities()[Ljava/lang/String;": () => null,
    "getTriggeredContentUris()[Landroid/net/Uri;": () => null,
    "isOverrideDeadlineExpired()Z": () => 0,
    "dequeueWork()Landroid/app/job/JobWorkItem;": () => null,
    "completeWork(Landroid/app/job/JobWorkItem;)V": () => {},
  },
});
class JJobWorkItem extends JObj { intent: unknown = null; }
rt.register({
  name: "android/app/job/JobWorkItem", ctor: JJobWorkItem,
  methods: {
    "<init>(Landroid/content/Intent;)V": function (this: JJobWorkItem, i: unknown) { this.intent = i; },
    "getIntent()Landroid/content/Intent;": function (this: JJobWorkItem) { return this.intent; },
    "getDeliveryCount()I": () => 1,
  },
});
rt.register({
  name: "android/app/job/JobService", ctor: class extends JContextWrapper {}, sup: "android/app/Service",
  methods: {
    "<init>()V": function () {},
    "onCreate()V": () => {}, "onDestroy()V": () => {},
    "onStartCommand(Landroid/content/Intent;II)I": () => 1,
    "stopSelf()V": () => {},
    "startForeground(ILandroid/app/Notification;)V": () => {},
    "stopForeground(Z)V": () => {},
    "onBind(Landroid/content/Intent;)Landroid/os/IBinder;": () => null,
    "onStartJob(Landroid/app/job/JobParameters;)Z": () => 0,
    "onStopJob(Landroid/app/job/JobParameters;)Z": () => 0,
    "jobFinished(Landroid/app/job/JobParameters;Z)V": () => {},
  },
});
class JJobServiceEngine extends JObj { svc: unknown = null; }
rt.register({
  name: "android/app/job/JobServiceEngine", ctor: JJobServiceEngine,
  methods: {
    "<init>(Landroid/app/Service;)V": function (this: JJobServiceEngine, s: unknown) { this.svc = s; },
    "getBinder()Landroid/os/IBinder;": () => rt.make("android/os/Binder"),
    "onStartJob(Landroid/app/job/JobParameters;)Z": () => 0,
    "onStopJob(Landroid/app/job/JobParameters;)Z": () => 0,
    "jobFinished(Landroid/app/job/JobParameters;Z)V": () => {},
  },
});
