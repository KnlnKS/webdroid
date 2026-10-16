// IJobScheduler and IJobCallback, the scheduler's half of android.app.job: JobSchedulerImpl,
// JobParameters, JobWorkItem, JobService and JobServiceEngine run from AOSP. A job runs as
// JobServiceContext runs it: bind the job's service (in whichever process declares it), start it
// through the service's IJobService, and hear back through the IJobCallback its parameters carry.

import { awaited, rt, JObj, noops, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { bindAsSystem } from "./server/activeservices.ts";
import { asSystem, hostStub, parceledList } from "./binder.ts";
import { batteryLow, netUp } from "./services.ts";
import { device } from "../shell/config.ts";
import type { JComponentName } from "./intent.ts";

/** what the scheduler needs of a JobInfo, read once when the job is scheduled */
type JobSpec = {
  info: JObj; namespace: string | null; id: number; service: JComponentName; interval: bigint | null; minLatency: bigint;
  backoff: bigint; extras: unknown; transientExtras: unknown; charging: boolean; idle: boolean; batteryNotLow: boolean; network: boolean;
};
function* jobSpec(info: JObj, namespace: string | null): Gen<JobSpec> {
  const get = (name: string, desc: string) => vcall(info, name, desc);
  return {
    info, namespace, id: yield get("getId", "()I"), service: yield get("getService", "()Landroid/content/ComponentName;"),
    interval: (yield get("isPeriodic", "()Z")) ? (yield get("getIntervalMillis", "()J")) : null,
    minLatency: yield get("getMinLatencyMillis", "()J"), backoff: yield get("getInitialBackoffMillis", "()J"),
    extras: yield get("getExtras", "()Landroid/os/PersistableBundle;"), transientExtras: yield get("getTransientExtras", "()Landroid/os/Bundle;"),
    charging: !!(yield get("isRequireCharging", "()Z")), idle: !!(yield get("isRequireDeviceIdle", "()Z")),
    batteryNotLow: !!(yield get("isRequireBatteryNotLow", "()Z")), network: !!(yield get("getRequiredNetwork", "()Landroid/net/NetworkRequest;")),
  };
}

type JobRun = { service: JObj | null; params: JObj | null; unbind: () => unknown; executing: Set<number> };
type ScheduledJob = { spec: JobSpec; timer: ReturnType<typeof setTimeout> | null; run: JobRun | null; work: JObj[]; nextWork: number };
const namespaces = new Map<string | null, Map<number, ScheduledJob>>();
const jobsIn = (namespace: string | null) => {
  let jobs = namespaces.get(namespace);
  if (!jobs) namespaces.set(namespace, jobs = new Map());
  return jobs;
};
const pending = (job: ScheduledJob) => namespaces.get(job.spec.namespace)?.get(job.spec.id) === job;
let nextBinding = 1;
/** the scheduler's own work, as system_server's JobServiceContext does it: a job waits on its
 *  service's binding, which the app's main thread publishes */
const asScheduler = (job: () => Gen<void>) => detached(() => asSystem(() => rt.drive(job())), logUncaught);
/** off the caller's stack, as JobServiceContext's handler messages are: a service reporting from
 *  inside a callback is not unbound under itself */
const later = (job: () => Gen<void>) => { setTimeout(() => asScheduler(job), 0); };
function armJob(job: ScheduledJob, delay: number): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => { job.timer = null; asScheduler(() => startJob(job)); }, Math.min(Math.max(0, delay), 0x7fffffff));
}
function* finishJob(job: ScheduledJob, run: JobRun, reschedule: boolean): Gen<void> {
  if (job.run !== run) return;
  job.run = null;
  yield run.unbind();
  if (!pending(job)) return;
  if (job.spec.interval !== null) armJob(job, Math.max(900000, Number(job.spec.interval)));
  else if (reschedule || job.work.length) armJob(job, reschedule ? Math.max(30000, Number(job.spec.backoff)) : 0);
  else namespaces.get(job.spec.namespace)!.delete(job.spec.id);
}
const PARAMS = "(Landroid/os/IBinder;Ljava/lang/String;ILandroid/os/PersistableBundle;Landroid/os/Bundle;Landroid/content/ClipData;IZZZ[Landroid/net/Uri;[Ljava/lang/String;Landroid/net/Network;)V";
function* startJob(job: ScheduledJob): Gen<void> {
  if (!pending(job) || job.run) return;
  const p = job.spec;
  if (p.charging && device.battery.status !== 2 || p.idle || p.batteryNotLow && batteryLow() || p.network && !netUp()) {
    armJob(job, 30000); return;
  }
  const callback: JJobCallback = yield newObj("webdroid/JobCallback");
  const run: JobRun = { service: null, params: null, unbind: () => {}, executing: new Set() };
  callback.job = job; callback.run = run; job.run = run;
  try {
    const { binder, unbind } = yield* awaited(bindAsSystem(p.service, "job:" + p.id + ":" + nextBinding++));
    run.unbind = unbind;
    if (!pending(job)) { job.run = null; yield unbind(); return; }
    run.service = yield scall("android/app/job/IJobService$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/app/job/IJobService;", binder);
    run.params = yield newObj("android/app/job/JobParameters", PARAMS, callback, p.namespace, p.id, p.extras, p.transientExtras,
      null, 0, 0, 0, 0, null, null, null);
    yield vcall(run.service, "startJob", "(Landroid/app/job/JobParameters;)V", run.params);
  } catch (error) { yield* finishJob(job, run, true); throw error; }
}
function* cancelJob(namespace: string | null, id: number): Gen<void> {
  const job = namespaces.get(namespace)?.get(id);
  if (!job) return;
  namespaces.get(namespace)!.delete(id);
  if (job.timer) clearTimeout(job.timer);
  const run = job.run;
  if (!run?.service || !run.params) return;
  // STOP_REASON_CANCELLED_BY_APP; the service's acknowledgement unbinds it
  yield vcall(run.params, "setStopReason", "(IILjava/lang/String;)V", 1, 0, "cancel() called by app");
  yield vcall(run.service, "stopJob", "(Landroid/app/job/JobParameters;)V", run.params);
}
function* scheduleJob(namespace: string | null, info: JObj, item?: JObj): Gen<number> {
  const spec = yield* jobSpec(info, namespace), jobs = jobsIn(namespace), old = jobs.get(spec.id);
  // enqueue() onto a job that is still pending or running adds its work rather than replacing it
  if (item && old && old.spec.interval === null) { old.work.push(item); if (!old.run && !old.timer) armJob(old, 0); return 1; }
  if (old) yield* cancelJob(namespace, spec.id);
  const scheduled: ScheduledJob = { spec, timer: null, run: null, work: item ? [item] : [], nextWork: 1 };
  jobs.set(spec.id, scheduled);
  armJob(scheduled, spec.interval === null ? Number(spec.minLatency) : Math.max(900000, Number(spec.interval)));
  return 1;   // RESULT_SUCCESS
}
const slice = (jobs: Map<number, ScheduledJob> | undefined) =>
  parceledList([...jobs?.values() ?? []].map((job) => job.spec.info));
rt.register({ name: "webdroid/JobSchedulerService", ctor: class extends JObj {}, sup: "android/app/job/IJobScheduler$Stub", methods: {
  "schedule(Ljava/lang/String;Landroid/app/job/JobInfo;)I": driven(scheduleJob),
  "enqueue(Ljava/lang/String;Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I": driven(scheduleJob),
  "cancel(Ljava/lang/String;I)V": driven(cancelJob),
  "cancelAllInNamespace(Ljava/lang/String;)V": driven(function* (namespace: string | null) {
    for (const id of [...namespaces.get(namespace)?.keys() ?? []]) yield* cancelJob(namespace, id);
  }),
  "cancelAll()V": driven(function* () {
    for (const [namespace, jobs] of namespaces) for (const id of [...jobs.keys()]) yield* cancelJob(namespace, id);
  }),
  "getPendingJob(Ljava/lang/String;I)Landroid/app/job/JobInfo;": (namespace: string | null, id: number) =>
    namespaces.get(namespace)?.get(id)?.spec.info ?? null,
  "getAllPendingJobsInNamespace(Ljava/lang/String;)Landroid/content/pm/ParceledListSlice;": (namespace: string | null) => slice(namespaces.get(namespace)),
  "getAllPendingJobs()Ljava/util/Map;": driven(function* () {
    const map = yield newObj("java/util/HashMap");
    for (const [namespace, jobs] of namespaces) {
      if (jobs.size) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", namespace, yield* awaited(slice(jobs)));
    }
    return map;
  }),
} });
hostStub("jobscheduler", "webdroid/JobSchedulerService");

// IJobCallback: the scheduler's end of one run
class JJobCallback extends JObj { job!: ScheduledJob; run!: JobRun; }
const live = (callback: JJobCallback) => callback.job.run === callback.run;
function finishing(this: JJobCallback, _id: number, reschedule: number) {
  const { job, run } = this;
  if (live(this)) later(() => finishJob(job, run, !!reschedule));
}
rt.register({ name: "webdroid/JobCallback", ctor: JJobCallback, sup: "android/app/job/IJobCallback$Stub", methods: {
  "acknowledgeStartMessage(IZ)V": function (this: JJobCallback, _id: number, ongoing: number) {
    const { job, run } = this;
    if (live(this) && !ongoing) later(() => finishJob(job, run, false));
  },
  "acknowledgeStopMessage(IZ)V": finishing,
  "jobFinished(IZ)V": finishing,
  "dequeueWork(I)Landroid/app/job/JobWorkItem;": driven(function* (this: JJobCallback) {
    const { job, run } = this, item = live(this) ? job.work.shift() ?? null : null;
    if (item) {
      yield vcall(item, "bumpDeliveryCount", "()V");
      let workId: number = yield vcall(item, "getWorkId", "()I");
      if (!workId) yield vcall(item, "setWorkId", "(I)V", workId = job.nextWork++);
      run.executing.add(workId);
    } else if (live(this) && !run.executing.size) later(() => finishJob(job, run, false));
    return item;
  }),
  "completeWork(II)Z": function (this: JJobCallback, _id: number, workId: number) { return +this.run.executing.delete(workId); },
  // transfer estimates only inform JobScheduler's quota, which is not modelled
  ...noops("updateEstimatedNetworkBytes(ILandroid/app/job/JobWorkItem;JJ)V", "updateTransferredNetworkBytes(ILandroid/app/job/JobWorkItem;JJ)V"),
} });
