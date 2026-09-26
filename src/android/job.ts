// android.app.job: scheduled work enters the app's own JobService on its main queue.

import { rt, JObj, type NativeSpec, stubs, noops, driven, type Gen } from "../jvm/runtime";
import { reportUncaught, vcall } from "../jvm/natives/jlang";
import { JList } from "../jvm/natives/jutil";
import { JContextWrapper } from "./context";
import { type JParcel, writeInt } from "./parcel";
import { onMain } from "./mainloop";
import { acquireJobService, releaseJobService } from "./runningservices";
import { netUp } from "./net";
import { device } from "../shell/config";

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
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JJobInfo, parcel: JParcel, flags: number): Gen {
      const p = this.p;
      writeInt(parcel, p.id);
      (yield vcall(parcel, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", p.extras ?? null));
      (yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", p.transient ?? null));
      writeInt(parcel, 0);
      (yield vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", p.svc, flags));
      const constraints = (p.charging ? 1 : 0) | (p.idle ? 2 : 0) | (p.batteryNotLow ? 4 : 0) | (p.storageNotLow ? 8 : 0);
      writeInt(parcel, constraints);
      (yield vcall(parcel, "writeTypedArray", "([Landroid/os/Parcelable;I)V", p.triggers.length ? p.triggers : null, flags));
      for (const value of [p.contentUpdateDelay ?? -1n, p.contentMaxDelay ?? -1n]) (yield vcall(parcel, "writeLong", "(J)V", value));
      writeInt(parcel, p.netReq ? 1 : 0);
      if (p.netReq) (yield vcall(p.netReq, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags));
      for (const value of [-1n, -1n, -1n, p.minLatency ?? 0n, p.deadline ?? 0n]) (yield vcall(parcel, "writeLong", "(J)V", value));
      writeInt(parcel, p.interval !== undefined ? 1 : 0);
      writeInt(parcel, p.persisted ? 1 : 0);
      for (const value of [p.interval ?? 0n, p.flex ?? 0n, p.backoff ?? 30000n]) (yield vcall(parcel, "writeLong", "(J)V", value));
      writeInt(parcel, p.backoffPolicy ?? 1);
      writeInt(parcel, p.minLatency !== undefined ? 1 : 0);
      writeInt(parcel, p.deadline !== undefined || p.interval !== undefined ? 1 : 0);
      writeInt(parcel, 0);
      writeInt(parcel, 300);
      writeInt(parcel, (p.important ? 1 : 0) | (p.expedited ? 16 : 0));
      writeInt(parcel, 0);
      (yield vcall(parcel, "writeString", "(Ljava/lang/String;)V", null));
    }),
  },
});
class JTriggerUri extends JObj { uri: unknown = null; flags = 0; }
rt.register({
  name: "android/app/job/JobInfo$TriggerContentUri", ctor: JTriggerUri,
  ifaces: ["android/os/Parcelable"],
  statics: { FLAG_NOTIFY_FOR_DESCENDANTS: 1 },
  methods: {
    "<init>(Landroid/net/Uri;I)V": function (this: JTriggerUri, u: unknown, f: number) { this.uri = u; this.flags = f; },
    "getUri()Landroid/net/Uri;": function (this: JTriggerUri) { return this.uri; },
    "getFlags()I": function (this: JTriggerUri) { return this.flags; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JTriggerUri, parcel: JParcel, flags: number): Gen {
      (yield vcall(this.uri, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags));
      writeInt(parcel, this.flags);
    }),
  },
});
type ScheduledJob = { info: JJobInfo; timer: ReturnType<typeof setTimeout> | null; service: JContextWrapper | null; params: JJobParameters | null; work: JJobWorkItem[] };
const pendingJobs = new Map<number, ScheduledJob>();
function armJob(job: ScheduledJob, delay: number): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => { job.timer = null; void startJob(job).catch(reportUncaught); }, Math.min(Math.max(0, delay), 0x7fffffff));
}
async function finishJob(job: ScheduledJob, reschedule: boolean): Promise<void> {
  const service = job.service;
  job.service = null; job.params = null;
  if (service) await releaseJobService(service);
  if (pendingJobs.get(job.info.p.id) !== job) return;
  if (job.info.p.interval !== undefined) armJob(job, Math.max(900000, Number(job.info.p.interval)));
  else if (reschedule) armJob(job, Math.max(30000, Number(job.info.p.backoff ?? 30000n)));
  else pendingJobs.delete(job.info.p.id);
}
async function startJob(job: ScheduledJob): Promise<void> {
  if (pendingJobs.get(job.info.p.id) !== job || job.service) return;
  const p = job.info.p;
  if (p.charging && device.battery.status !== 2 || p.idle || p.batteryNotLow && device.battery.level < 15 || p.netType && !(await netUp())) {
    armJob(job, 30000); return;
  }
  const service = await acquireJobService(p.svc);
  if (pendingJobs.get(p.id) !== job) { await releaseJobService(service); return; }
  const params = new JJobParameters();
  params.id = p.id; params.extras = p.extras ?? null; params.work = job.work;
  job.service = service; job.params = params;
  try {
    const running = await onMain(() => vcall(service, "onStartJob", "(Landroid/app/job/JobParameters;)Z", params));
    if (!running && job.params === params) await finishJob(job, false);
  } catch (error) { await finishJob(job, true); throw error; }
}
function cancelJob(id: number): void {
  const job = pendingJobs.get(id);
  if (!job) return;
  pendingJobs.delete(id);
  if (job.timer) clearTimeout(job.timer);
  const service = job.service, params = job.params;
  job.service = null; job.params = null;
  if (service && params) void onMain(async () => {
    try { await vcall(service, "onStopJob", "(Landroid/app/job/JobParameters;)Z", params); }
    finally { await releaseJobService(service); }
  }).catch(reportUncaught);
}
function scheduleJob(info: JJobInfo, item?: JJobWorkItem): number {
  if (!info?.p.svc) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Job service required");
  const id = info.p.id, old = pendingJobs.get(id);
  if (old) cancelJob(id);
  const job: ScheduledJob = { info, timer: null, service: null, params: null, work: item ? [item] : [] };
  pendingJobs.set(id, job);
  armJob(job, info.p.interval === undefined ? Number(info.p.minLatency ?? 0n) : Math.max(900000, Number(info.p.interval)));
  return 1;
}
rt.register({
  name: "android/app/job/JobScheduler", ctor: class extends JObj {},
  statics: { RESULT_FAILURE: 0, RESULT_SUCCESS: 1 },
  methods: {
    "schedule(Landroid/app/job/JobInfo;)I": (j: JJobInfo) => scheduleJob(j),
    "enqueue(Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I": (j: JJobInfo, item: JJobWorkItem) => scheduleJob(j, item),
    "cancel(I)V": cancelJob,
    "cancelAll()V": () => { for (const id of [...pendingJobs.keys()]) cancelJob(id); },
    "getPendingJob(I)Landroid/app/job/JobInfo;": (id: number) => pendingJobs.get(id)?.info ?? null,
    "getAllPendingJobs()Ljava/util/List;": () => { const l = new JList(); l.a = [...pendingJobs.values()].map(job => job.info); return l; },
    // API 34: WorkManager uses a namespaced view; job ids remain process unique here.
    "forNamespace(Ljava/lang/String;)Landroid/app/job/JobScheduler;": function (this: JObj) { return this; },
    "getNamespace()Ljava/lang/String;": () => null,
  },
});
class JJobParameters extends JObj { id = 0; extras: unknown = null; work: JJobWorkItem[] = []; }
rt.register({
  name: "android/app/job/JobParameters", ctor: JJobParameters,
  methods: {
    "getJobId()I": function (this: JJobParameters) { return this.id; },
    "getExtras()Landroid/os/PersistableBundle;": function (this: JJobParameters) { return this.extras; },
    ...stubs(null, "getNetwork()Landroid/net/Network;", "getTriggeredContentAuthorities()[Ljava/lang/String;",
      "getTriggeredContentUris()[Landroid/net/Uri;"),
    "dequeueWork()Landroid/app/job/JobWorkItem;": function (this: JJobParameters) { return this.work.shift() ?? null; },
    ...stubs(0, "isOverrideDeadlineExpired()Z"),
    ...noops("completeWork(Landroid/app/job/JobWorkItem;)V"),
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
    "onCreate()V": () => {}, "onDestroy()V": () => {},
    ...noops("<init>()V", "stopSelf()V", "startForeground(ILandroid/app/Notification;)V", "stopForeground(Z)V"),
    "jobFinished(Landroid/app/job/JobParameters;Z)V": function (this: JContextWrapper, params: JJobParameters, reschedule: number) {
      const job = pendingJobs.get(params?.id);
      if (job?.service === this && job.params === params) void finishJob(job, !!reschedule).catch(reportUncaught);
    },
    ...stubs(1, "onStartCommand(Landroid/content/Intent;II)I"),
    ...stubs(null, "onBind(Landroid/content/Intent;)Landroid/os/IBinder;"),
    ...stubs(0, "onStartJob(Landroid/app/job/JobParameters;)Z", "onStopJob(Landroid/app/job/JobParameters;)Z"),
  },
});
class JJobServiceEngine extends JObj { svc: unknown = null; }
rt.register({
  name: "android/app/job/JobServiceEngine", ctor: JJobServiceEngine,
  methods: {
    "<init>(Landroid/app/Service;)V": function (this: JJobServiceEngine, s: unknown) { this.svc = s; },
    "getBinder()Landroid/os/IBinder;": () => rt.make("android/os/Binder"),
    ...stubs(0, "onStartJob(Landroid/app/job/JobParameters;)Z", "onStopJob(Landroid/app/job/JobParameters;)Z"),
    ...noops("jobFinished(Landroid/app/job/JobParameters;Z)V"),
  },
});
