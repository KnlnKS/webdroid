// android.app.job: scheduled work reaches the app's JobService through its binder.

import { rt, JObj, stubs, driven, type Gen } from "../jvm/runtime";
import { reportUncaught, vcall } from "../jvm/natives/jlang";
import { JList } from "../jvm/natives/jutil";
import { JParcel, parcelCreator, readInt, writeInt } from "./parcel";
import { onMain } from "./mainloop";
import { bindAsSystem } from "./runningservices";
import { netUp } from "./net";
import { device } from "../shell/config";
import { JBinder } from "./binder";
import { JService } from "./app";
import type { JComponentName, JIntent } from "./intent";

/** what the scheduler needs of a JobInfo (AOSP's own class), read once when the job is scheduled */
type JobSpec = {
  info: JObj; id: number; service: JComponentName; interval: bigint | null; minLatency: bigint; backoff: bigint;
  extras: unknown; transientExtras: unknown; charging: boolean; idle: boolean; batteryNotLow: boolean; network: boolean;
};
function jobSpec(info: JObj): JobSpec {
  const get = (name: string, desc: string) => vcall(info, name, desc);
  return {
    info, id: get("getId", "()I"), service: get("getService", "()Landroid/content/ComponentName;"),
    interval: get("isPeriodic", "()Z") ? get("getIntervalMillis", "()J") : null,
    minLatency: get("getMinLatencyMillis", "()J"), backoff: get("getInitialBackoffMillis", "()J"),
    extras: get("getExtras", "()Landroid/os/PersistableBundle;"), transientExtras: get("getTransientExtras", "()Landroid/os/Bundle;"),
    charging: !!get("isRequireCharging", "()Z"), idle: !!get("isRequireDeviceIdle", "()Z"),
    batteryNotLow: !!get("isRequireBatteryNotLow", "()Z"), network: !!get("getRequiredNetwork", "()Landroid/net/NetworkRequest;"),
  };
}

// ── Running a job, as AOSP's JobServiceContext does: bind the job's service (in whichever process
// declares it), send its IJobService binder the parameters, and hear back through the IJobCallback
// binder they carry. JobService and any app JobServiceEngine (JobIntentService's) answer alike.
const START = 1, STOP = 2;
const ACK_START = 1, ACK_STOP = 2, DEQUEUE = 3, COMPLETE = 4, FINISHED = 5;
type JobRun = { callback: JJobCallback; binder: JObj | null; unbind: () => Promise<void>; executing: Set<number> };
type ScheduledJob = { info: JobSpec; timer: ReturnType<typeof setTimeout> | null; run: JobRun | null; work: JJobWorkItem[]; nextWork: number };
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
  if (pendingJobs.get(job.info.id) !== job) return;
  if (job.info.interval !== null) armJob(job, Math.max(900000, Number(job.info.interval)));
  else if (reschedule || job.work.length) armJob(job, reschedule ? Math.max(30000, Number(job.info.backoff)) : 0);
  else pendingJobs.delete(job.info.id);
}
async function sendJob(binder: JObj, code: number, params: JJobParameters): Promise<void> {
  const parcel = new JParcel();
  await vcall(params, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(binder, "transact", "(ILandroid/os/Parcel;Landroid/os/Parcel;I)Z", code, parcel, null, 1);
}
function jobParameters(job: ScheduledJob, callback: JJobCallback | null, stopReason = 0): JJobParameters {
  const params: JJobParameters = rt.make("android/app/job/JobParameters");
  params.id = job.info.id; params.extras = job.info.extras; params.transientExtras = job.info.transientExtras;
  params.callback = callback; params.stopReason = stopReason;
  return params;
}
async function startJob(job: ScheduledJob): Promise<void> {
  if (pendingJobs.get(job.info.id) !== job || job.run) return;
  const p = job.info;
  if (p.charging && device.battery.status !== 2 || p.idle || p.batteryNotLow && device.battery.level < 15 || p.network && !(await netUp())) {
    armJob(job, 30000); return;
  }
  const callback: JJobCallback = rt.make("webdroid/JobCallback");
  const run: JobRun = { callback, binder: null, unbind: async () => {}, executing: new Set() };
  callback.job = job; callback.run = run; job.run = run;
  try {
    const { binder, unbind } = await bindAsSystem(p.service, "job:" + p.id + ":" + nextBinding++);
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
function scheduleJob(job: JObj, item?: JJobWorkItem): number {
  if (!job) rt.npe();
  const info = jobSpec(job), id = info.id, old = pendingJobs.get(id);
  // enqueue() onto a job that is still pending or running adds its work rather than replacing it
  if (item && old && old.info.interval === null) { old.work.push(item); if (!old.run && !old.timer) armJob(old, 0); return 1; }
  if (old) cancelJob(id);
  const scheduled: ScheduledJob = { info, timer: null, run: null, work: item ? [item] : [], nextWork: 1 };
  pendingJobs.set(id, scheduled);
  armJob(scheduled, info.interval === null ? Number(info.minLatency) : Math.max(900000, Number(info.interval)));
  return 1;
}
rt.register({
  name: "android/app/job/JobScheduler", ctor: class extends JObj {},
  statics: { RESULT_FAILURE: 0, RESULT_SUCCESS: 1 },
  methods: {
    "schedule(Landroid/app/job/JobInfo;)I": (j: JObj) => scheduleJob(j),
    "enqueue(Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I": (j: JObj, item: JJobWorkItem) => scheduleJob(j, item),
    "cancel(I)V": cancelJob,
    "cancelAll()V": () => { for (const id of [...pendingJobs.keys()]) cancelJob(id); },
    "getPendingJob(I)Landroid/app/job/JobInfo;": (id: number) => pendingJobs.get(id)?.info.info ?? null,
    "getAllPendingJobs()Ljava/util/List;": () => { const l = new JList(); l.a = [...pendingJobs.values()].map(job => job.info.info); return l; },
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
