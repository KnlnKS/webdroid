// android.app.job: scheduled work reaches the app's JobService through its binder.

import { rt, JObj, type NativeSpec, stubs, driven, type Gen } from "../jvm/runtime";
import { reportUncaught, vcall } from "../jvm/natives/jlang";
import { JList } from "../jvm/natives/jutil";
import { jarray } from "../jvm/abi";
import { JParcel, parcelCreator, readInt, writeInt } from "./parcel";
import { onMain } from "./mainloop";
import { bindLocalService, unbindLocalService, serviceTransport } from "./runningservices";
import { netUp } from "./net";
import { device } from "../shell/config";
import { JBinder } from "./binder";
import { JService } from "./app";
import { appHost } from "./apphost";
import { PROCESS_NAME } from "./os";
import { packages, qualifyComponent } from "./packages";
import type { JComponentName, JIntent } from "./intent";

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
      return t.length ? jarray(t.slice(), "Landroid/app/job/JobInfo$TriggerContentUri;") : null;
    },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JJobInfo, parcel: JParcel, flags: number): Gen {
      const p = this.p;
      writeInt(parcel, p.id);
      yield vcall(parcel, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", p.extras ?? null);
      yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", p.transient ?? null);
      writeInt(parcel, 0);
      yield vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", p.svc, flags);
      const constraints = (p.charging ? 1 : 0) | (p.idle ? 2 : 0) | (p.batteryNotLow ? 4 : 0) | (p.storageNotLow ? 8 : 0);
      writeInt(parcel, constraints);
      yield vcall(parcel, "writeTypedArray", "([Landroid/os/Parcelable;I)V", p.triggers.length ? p.triggers : null, flags);
      for (const value of [p.contentUpdateDelay ?? -1n, p.contentMaxDelay ?? -1n]) yield vcall(parcel, "writeLong", "(J)V", value);
      writeInt(parcel, p.netReq ? 1 : 0);
      if (p.netReq) yield vcall(p.netReq, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
      for (const value of [-1n, -1n, -1n, p.minLatency ?? 0n, p.deadline ?? 0n]) yield vcall(parcel, "writeLong", "(J)V", value);
      writeInt(parcel, p.interval !== undefined ? 1 : 0);
      writeInt(parcel, p.persisted ? 1 : 0);
      for (const value of [p.interval ?? 0n, p.flex ?? 0n, p.backoff ?? 30000n]) yield vcall(parcel, "writeLong", "(J)V", value);
      writeInt(parcel, p.backoffPolicy ?? 1);
      writeInt(parcel, p.minLatency !== undefined ? 1 : 0);
      writeInt(parcel, p.deadline !== undefined || p.interval !== undefined ? 1 : 0);
      writeInt(parcel, 0);
      writeInt(parcel, 300);
      writeInt(parcel, (p.important ? 1 : 0) | (p.expedited ? 16 : 0));
      writeInt(parcel, 0);
      yield vcall(parcel, "writeString", "(Ljava/lang/String;)V", null);
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
      yield vcall(this.uri, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
      writeInt(parcel, this.flags);
    }),
  },
});
// ── Running a job, as AOSP's JobServiceContext does: bind the job's service (in whichever process
// declares it), send its IJobService binder the parameters, and hear back through the IJobCallback
// binder they carry. JobService and any app JobServiceEngine (JobIntentService's) answer alike.
const START = 1, STOP = 2;
const ACK_START = 1, ACK_STOP = 2, DEQUEUE = 3, COMPLETE = 4, FINISHED = 5;
type JobRun = { callback: JJobCallback; binder: JObj | null; unbind: () => Promise<void>; executing: Set<number> };
type ScheduledJob = { info: JJobInfo; timer: ReturnType<typeof setTimeout> | null; run: JobRun | null; work: JJobWorkItem[]; nextWork: number };
const pendingJobs = new Map<number, ScheduledJob>();
let nextBinding = 1;
/** off the caller's stack, as AOSP's handler messages are: a service reporting from inside a
 *  callback is not unbound under itself */
const later = (job: () => Promise<void>) => { setTimeout(() => void job().catch(reportUncaught), 0); };
function armJob(job: ScheduledJob, delay: number): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => { job.timer = null; void startJob(job).catch(reportUncaught); }, Math.min(Math.max(0, delay), 0x7fffffff));
}
async function finishJob(job: ScheduledJob, run: JobRun, reschedule: boolean): Promise<void> {
  if (job.run !== run) return;
  job.run = null;
  await run.unbind();
  if (pendingJobs.get(job.info.p.id) !== job) return;
  if (job.info.p.interval !== undefined) armJob(job, Math.max(900000, Number(job.info.p.interval)));
  else if (reschedule || job.work.length) armJob(job, reschedule ? Math.max(30000, Number(job.info.p.backoff ?? 30000n)) : 0);
  else pendingJobs.delete(job.info.p.id);
}
async function bindJobService(component: JComponentName, key: string): Promise<{ binder: JObj; unbind: () => Promise<void> }> {
  const owner = packages.get(component.pkg), cls = qualifyComponent(component.cls, component.pkg);
  const node = owner?.components.service.get(cls), ctx = appHost?.application;
  if (!owner || !node || !ctx) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + component.pkg + "/" + cls + "}");
  const intent: JIntent = rt.make("android/content/Intent");
  intent.component = cls; intent.componentPkg = owner.pkg;
  const process = owner.process(node);
  if (owner.pkg === ctx.$host.pkg && process === (PROCESS_NAME || owner.pkg)) return { binder: await bindLocalService(ctx, intent, key) as JObj, unbind: () => unbindLocalService(key) };
  return { binder: await serviceTransport.bind(owner, process, intent, key) as JObj, unbind: () => serviceTransport.unbind(owner, process, key) };
}
async function sendJob(binder: JObj, code: number, params: JJobParameters): Promise<void> {
  const parcel = new JParcel();
  await vcall(params, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, parcel, null, 1);
}
function jobParameters(job: ScheduledJob, callback: JJobCallback | null, stopReason = 0): JJobParameters {
  const params: JJobParameters = rt.make("android/app/job/JobParameters");
  params.id = job.info.p.id; params.extras = job.info.p.extras ?? null; params.transientExtras = job.info.p.transient ?? null;
  params.callback = callback; params.stopReason = stopReason;
  return params;
}
async function startJob(job: ScheduledJob): Promise<void> {
  if (pendingJobs.get(job.info.p.id) !== job || job.run) return;
  const p = job.info.p;
  if (p.charging && device.battery.status !== 2 || p.idle || p.batteryNotLow && device.battery.level < 15 || p.netType && !(await netUp())) {
    armJob(job, 30000); return;
  }
  const callback: JJobCallback = rt.make("webdroid/JobCallback");
  const run: JobRun = { callback, binder: null, unbind: async () => {}, executing: new Set() };
  callback.job = job; callback.run = run; job.run = run;
  try {
    const { binder, unbind } = await bindJobService(p.svc, "job:" + p.id + ":" + nextBinding++);
    run.binder = binder; run.unbind = unbind;
    if (pendingJobs.get(p.id) !== job) { job.run = null; return unbind(); }
    await sendJob(binder, START, jobParameters(job, callback));
  } catch (error) { await finishJob(job, run, true); throw error; }
}
function cancelJob(id: number): void {
  const job = pendingJobs.get(id);
  if (!job) return;
  pendingJobs.delete(id);
  if (job.timer) clearTimeout(job.timer);
  const run = job.run;
  // STOP_REASON_CANCELLED_BY_APP; the service's acknowledgement unbinds it
  if (run?.binder) void sendJob(run.binder, STOP, jobParameters(job, run.callback, 1)).catch(reportUncaught);
}
function scheduleJob(info: JJobInfo, item?: JJobWorkItem): number {
  if (!info?.p.svc) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Job service required");
  const id = info.p.id, old = pendingJobs.get(id);
  // enqueue() onto a job that is still pending or running adds its work rather than replacing it
  if (item && old && !old.info.p.interval) { old.work.push(item); if (!old.run && !old.timer) armJob(old, 0); return 1; }
  if (old) cancelJob(id);
  const job: ScheduledJob = { info, timer: null, run: null, work: item ? [item] : [], nextWork: 1 };
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
// IJobCallback: the scheduler's end, one per run
class JJobCallback extends JBinder { job!: ScheduledJob; run!: JobRun; }
rt.register({
  name: "webdroid/JobCallback", ctor: JJobCallback, sup: "android/os/Binder",
  methods: {
    "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JJobCallback, code: number, data: JParcel, reply: JParcel | null): Gen {
      const { job, run } = this, live = job.run === run;
      switch (code) {
        case ACK_START: if (live && !readInt(data)) later(() => finishJob(job, run, false)); return 1;
        case ACK_STOP: case FINISHED: { const reschedule = !!readInt(data); if (live) later(() => finishJob(job, run, reschedule)); return 1; }
        case DEQUEUE: {
          const item = live ? job.work.shift() ?? null : null;
          if (item) { item.deliveryCount++; item.workId ||= job.nextWork++; run.executing.add(item.workId); }
          else if (live && !run.executing.size) later(() => finishJob(job, run, false));
          if (reply) yield vcall(reply, "writeTypedObject", "(Landroid/os/Parcelable;I)V", item, 0);
          return 1;
        }
        case COMPLETE: { const done = run.executing.delete(readInt(data)); if (reply) writeInt(reply, +done); return 1; }
      }
      return 0;
    }),
  },
});
/** a call from the service's end back to the scheduler, answered when `read` is given */
const jobCallback = driven(function* (params: JJobParameters, code: number, value: number, read?: (reply: JParcel) => unknown): Gen {
  if (!params?.callback) return null;
  const data = new JParcel(), reply = read ? new JParcel() : null;
  writeInt(data, value);
  yield vcall(params.callback, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, data, reply, read ? 0 : 1);
  return reply ? read!(reply) : null;
});
class JJobParameters extends JObj {
  id = 0; extras: unknown = null; transientExtras: unknown = null; callback: JObj | null = null; stopReason = 0;
}
rt.register({
  name: "android/app/job/JobParameters", ctor: JJobParameters, ifaces: ["android/os/Parcelable"],
  statics: {
    STOP_REASON_UNDEFINED: 0, STOP_REASON_CANCELLED_BY_APP: 1, STOP_REASON_PREEMPT: 2, STOP_REASON_TIMEOUT: 3, STOP_REASON_DEVICE_STATE: 4,
    STOP_REASON_CONSTRAINT_BATTERY_NOT_LOW: 5, STOP_REASON_CONSTRAINT_CHARGING: 6, STOP_REASON_CONSTRAINT_CONNECTIVITY: 7,
    STOP_REASON_CONSTRAINT_DEVICE_IDLE: 8, STOP_REASON_CONSTRAINT_STORAGE_NOT_LOW: 9, STOP_REASON_QUOTA: 10,
    STOP_REASON_BACKGROUND_RESTRICTION: 11, STOP_REASON_APP_STANDBY: 12, STOP_REASON_USER: 13, STOP_REASON_SYSTEM_PROCESSING: 14,
    get CREATOR() { return parcelCreator("android/app/job/JobParameters", async (parcel) => {
      const params = new JJobParameters();
      params.id = readInt(parcel);
      params.extras = await vcall(parcel, "readPersistableBundle", "()Landroid/os/PersistableBundle;");
      params.transientExtras = await vcall(parcel, "readBundle", "()Landroid/os/Bundle;");
      params.callback = await vcall(parcel, "readStrongBinder", "()Landroid/os/IBinder;");
      params.stopReason = readInt(parcel);
      return params;
    }); },
  },
  methods: {
    "getJobId()I": function (this: JJobParameters) { return this.id; },
    "getExtras()Landroid/os/PersistableBundle;": function (this: JJobParameters) { return this.extras; },
    "getTransientExtras()Landroid/os/Bundle;": function (this: JJobParameters) { return this.transientExtras; },
    "getStopReason()I": function (this: JJobParameters) { return this.stopReason; },
    ...stubs(null, "getNetwork()Landroid/net/Network;", "getTriggeredContentAuthorities()[Ljava/lang/String;",
      "getTriggeredContentUris()[Landroid/net/Uri;"),
    ...stubs(0, "isOverrideDeadlineExpired()Z", "isExpeditedJob()Z"),
    "dequeueWork()Landroid/app/job/JobWorkItem;": function (this: JJobParameters) {
      return jobCallback(this, DEQUEUE, 0, (reply) => vcall(reply, "readTypedObject", "(Landroid/os/Parcelable$Creator;)Ljava/lang/Object;", rt.link("android/app/job/JobWorkItem").ctor.s$CREATOR));
    },
    "completeWork(Landroid/app/job/JobWorkItem;)V": driven(function* (this: JJobParameters, item: JJobWorkItem): Gen {
      if (!(yield jobCallback(this, COMPLETE, item.workId, readInt))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Given work is not active: " + item);
    }),
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JJobParameters, parcel: JParcel): Gen {
      writeInt(parcel, this.id);
      yield vcall(parcel, "writePersistableBundle", "(Landroid/os/PersistableBundle;)V", this.extras);
      yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", this.transientExtras);
      yield vcall(parcel, "writeStrongBinder", "(Landroid/os/IBinder;)V", this.callback);
      writeInt(parcel, this.stopReason);
    }),
  },
});
class JJobWorkItem extends JObj { intent: JIntent | null = null; deliveryCount = 0; workId = 0; }
rt.register({
  name: "android/app/job/JobWorkItem", ctor: JJobWorkItem, ifaces: ["android/os/Parcelable"],
  statics: { get CREATOR() { return parcelCreator("android/app/job/JobWorkItem", async (parcel) => {
    const item = new JJobWorkItem();
    item.intent = readInt(parcel) ? await vcall(rt.link("android/content/Intent").ctor.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel) : null;
    item.deliveryCount = readInt(parcel); item.workId = readInt(parcel);
    return item;
  }); } },
  methods: {
    "<init>(Landroid/content/Intent;)V": function (this: JJobWorkItem, i: JIntent) { this.intent = i; },
    "getIntent()Landroid/content/Intent;": function (this: JJobWorkItem) { return this.intent; },
    "getDeliveryCount()I": function (this: JJobWorkItem) { return this.deliveryCount; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JJobWorkItem, parcel: JParcel, flags: number): Gen {
      yield vcall(parcel, "writeTypedObject", "(Landroid/os/Parcelable;I)V", this.intent, flags);
      writeInt(parcel, this.deliveryCount); writeInt(parcel, this.workId);
    }),
  },
});
// IJobService: the service's end. Its target is the JobService itself or the app's own engine;
// both answer onStartJob/onStopJob with the same descriptors.
class JJobServiceBinder extends JBinder { target: JObj | null = null; }
rt.register({
  name: "webdroid/JobServiceBinder", ctor: JJobServiceBinder, sup: "android/os/Binder",
  methods: {
    "onTransact(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z": driven(function* (this: JJobServiceBinder, code: number, data: JParcel): Gen {
      if (code !== START && code !== STOP) return 0;
      const params: JJobParameters = yield vcall(rt.link("android/app/job/JobParameters").ctor.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", data);
      const target = this.target;
      void onMain(async () => {
        const result = await vcall(target, code === START ? "onStartJob" : "onStopJob", "(Landroid/app/job/JobParameters;)Z", params);
        await jobCallback(params, code === START ? ACK_START : ACK_STOP, result);
      }).catch(reportUncaught);
      return 1;
    }),
  },
});
function jobBinder(target: JObj & { binder?: JJobServiceBinder }): JJobServiceBinder {
  return target.binder ??= Object.assign(rt.make("webdroid/JobServiceBinder") as JJobServiceBinder, { target });
}
const jobFinished = (params: JJobParameters, reschedule: number) => jobCallback(params, FINISHED, reschedule);
class JJobService extends JService { binder?: JJobServiceBinder; }
rt.register({
  name: "android/app/job/JobService", ctor: JJobService, sup: "android/app/Service",
  methods: {
    "<init>()V": function () {},
    "onBind(Landroid/content/Intent;)Landroid/os/IBinder;": function (this: JJobService) { return jobBinder(this); },
    "jobFinished(Landroid/app/job/JobParameters;Z)V": jobFinished,
  },
});
class JJobServiceEngine extends JObj { binder?: JJobServiceBinder; }
rt.register({
  name: "android/app/job/JobServiceEngine", ctor: JJobServiceEngine,
  methods: {
    "<init>(Landroid/app/Service;)V": function (this: JJobServiceEngine, service: unknown) { if (!service) throw rt.mkThrowable("java/lang/IllegalArgumentException", "service is null"); },
    "getBinder()Landroid/os/IBinder;": function (this: JJobServiceEngine) { return jobBinder(this); },
    "jobFinished(Landroid/app/job/JobParameters;Z)V": jobFinished,
  },
});
