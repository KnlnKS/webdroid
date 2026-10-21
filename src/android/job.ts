// system_server's JobSchedulerService, IJobScheduler and IJobCallback: JobSchedulerImpl,
// JobParameters, JobWorkItem, JobService and JobServiceEngine run from AOSP in the apps. Each uid's
// jobs wait on the guest clock, outliving its processes; a job runs as JobServiceContext runs it:
// bind the job's service (starting its process), start it through the service's IJobService, and
// hear back through the IJobCallback its parameters carry. Persisted jobs do not survive a reload.

import { awaited, rt, JObj, noops, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { bindAsSystem } from "./server/activeservices.ts";
import { asSystem, callingIdentity, hostService, parceledList } from "./binder.ts";
import { ownedBy } from "./packages.ts";
import { netUp } from "./connectivity.ts";
import { batteryLow } from "./power.ts";
import { device } from "../shell/config.ts";
import { clearGuestTimeout, setSystemTimeout, type GuestTimer } from "../guest-clock.ts";
import type { JComponentName } from "./intent.ts";
import type { PackageState } from "../shell/packagedata.ts";

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

type JobRun = { service: JObj | null; params: JObj | null; unbind: () => unknown; unlink: () => unknown; executing: Set<number> };
type ScheduledJob = { uid: number; spec: JobSpec; timer: GuestTimer | null; run: JobRun | null; work: JObj[]; nextWork: number };
type Namespaces = Map<string | null, Map<number, ScheduledJob>>;
/** each uid's jobs, by namespace and id */
const scheduled = new Map<number, Namespaces>();
const namespacesOf = (uid: number): Namespaces => {
  let namespaces = scheduled.get(uid);
  if (!namespaces) scheduled.set(uid, namespaces = new Map());
  return namespaces;
};
const jobsIn = (uid: number, namespace: string | null) => {
  const namespaces = namespacesOf(uid);
  let jobs = namespaces.get(namespace);
  if (!jobs) namespaces.set(namespace, jobs = new Map());
  return jobs;
};
const pending = (job: ScheduledJob) => scheduled.get(job.uid)?.get(job.spec.namespace)?.get(job.spec.id) === job;
let nextBinding = 1;
/** the scheduler's own work, as system_server's JobServiceContext does it: a job waits on its
 *  service's binding, which the app's main thread publishes */
const asScheduler = (job: () => Gen<void>) => detached(() => asSystem(() => rt.drive(job())), logUncaught);
/** off the caller's stack, as JobServiceContext's handler messages are: a service reporting from
 *  inside a callback is not unbound under itself */
const later = (job: () => Gen<void>) => { setTimeout(() => asScheduler(job), 0); };
function armJob(job: ScheduledJob, delay: number): void {
  clearGuestTimeout(job.timer);
  job.timer = setSystemTimeout(() => { job.timer = null; asScheduler(() => startJob(job)); }, Math.max(0, delay));
}
function* finishJob(job: ScheduledJob, run: JobRun, reschedule: boolean): Gen<void> {
  if (job.run !== run) return;
  job.run = null;
  yield run.unlink();
  yield run.unbind();
  if (!pending(job)) return;
  if (job.spec.interval !== null) armJob(job, Math.max(900000, Number(job.spec.interval)));
  else if (reschedule || job.work.length) armJob(job, reschedule ? Math.max(30000, Number(job.spec.backoff)) : 0);
  else scheduled.get(job.uid)!.get(job.spec.namespace)!.delete(job.spec.id);
}
const PARAMS = "(Landroid/os/IBinder;Ljava/lang/String;ILandroid/os/PersistableBundle;Landroid/os/Bundle;Landroid/content/ClipData;IZZZ[Landroid/net/Uri;[Ljava/lang/String;Landroid/net/Network;)V";
function* startJob(job: ScheduledJob): Gen<void> {
  if (!pending(job) || job.run) return;
  const p = job.spec;
  if (p.charging && device.battery.status !== 2 || p.idle || p.batteryNotLow && batteryLow() || p.network && !netUp()) {
    armJob(job, 30000); return;
  }
  const callback: JJobCallback = yield newObj("webdroid/JobCallback");
  const run: JobRun = { service: null, params: null, unbind: () => {}, unlink: () => {}, executing: new Set() };
  callback.job = job; callback.run = run; job.run = run;
  try {
    const { binder, unbind } = yield* awaited(bindAsSystem(p.service, "job:" + p.id + ":" + nextBinding++));
    run.unbind = unbind;
    if (!pending(job)) { job.run = null; yield unbind(); return; }
    // JobServiceContext.onServiceDisconnected: the run ends, to be retried
    yield vcall(binder, "linkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)V", callback, 0);
    run.unlink = () => vcall(binder, "unlinkToDeath", "(Landroid/os/IBinder$DeathRecipient;I)Z", callback, 0);
    run.service = yield scall("android/app/job/IJobService$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/app/job/IJobService;", binder);
    run.params = yield newObj("android/app/job/JobParameters", PARAMS, callback, p.namespace, p.id, p.extras, p.transientExtras,
      null, 0, 0, 0, 0, null, null, null);
    yield vcall(run.service, "startJob", "(Landroid/app/job/JobParameters;)V", run.params);
  } catch (error) { yield* finishJob(job, run, true); throw error; }
}
function* cancelJob(uid: number, namespace: string | null, id: number): Gen<void> {
  const jobs = scheduled.get(uid)?.get(namespace), job = jobs?.get(id);
  if (!job) return;
  jobs!.delete(id);
  clearGuestTimeout(job.timer);
  const run = job.run;
  if (!run?.service || !run.params) return;
  // STOP_REASON_CANCELLED_BY_APP; the service's acknowledgement unbinds it
  yield vcall(run.params, "setStopReason", "(IILjava/lang/String;)V", 1, 0, "cancel() called by app");
  yield vcall(run.service, "stopJob", "(Landroid/app/job/JobParameters;)V", run.params);
}
/** JobSchedulerService.scheduleAsPackage for the calling uid, whose own service the job must name */
function* scheduleJob(namespace: string | null, info: JObj, item?: JObj): Gen<number> {
  const { uid } = callingIdentity(), spec = yield* jobSpec(info, namespace), pkg: string = yield vcall(spec.service, "getPackageName", "()Ljava/lang/String;");
  if (!ownedBy(pkg, uid)) throw rt.mkThrowable("java/lang/IllegalArgumentException", `uid ${uid} cannot schedule job in ${pkg}`);
  const jobs = jobsIn(uid, namespace), old = jobs.get(spec.id);
  // enqueue() onto a job that is still pending or running adds its work rather than replacing it
  if (item && old && old.spec.interval === null) { old.work.push(item); if (!old.run && !old.timer) armJob(old, 0); return 1; }
  if (old) yield* cancelJob(uid, namespace, spec.id);
  const job: ScheduledJob = { uid, spec, timer: null, run: null, work: item ? [item] : [], nextWork: 1 };
  jobs.set(spec.id, job);
  armJob(job, spec.interval === null ? Number(spec.minLatency) : Math.max(900000, Number(spec.interval)));
  return 1;   // RESULT_SUCCESS
}
const slice = (jobs: Map<number, ScheduledJob> | undefined) =>
  parceledList([...jobs?.values() ?? []].map((job) => job.spec.info));
const callerJobs = () => scheduled.get(callingIdentity().uid);
/** clearApplicationUserData's cancelJobsForUid, once the uid's processes are stopped: no service hears it */
export const jobData: PackageState = {
  clear(_pkg, uid) {
    const namespaces = uid === undefined ? undefined : scheduled.get(uid);
    if (!namespaces) return;
    scheduled.delete(uid!);
    for (const jobs of namespaces.values()) for (const job of jobs.values()) {
      clearGuestTimeout(job.timer);
      const run = job.run;
      job.run = null;
      if (run) detached(run.unbind, logUncaught);
    }
  },
};
hostService("jobscheduler", "webdroid/JobSchedulerService", "android/app/job/IJobScheduler$Stub", {
  "schedule(Ljava/lang/String;Landroid/app/job/JobInfo;)I": driven(scheduleJob),
  "enqueue(Ljava/lang/String;Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I": driven(scheduleJob),
  "cancel(Ljava/lang/String;I)V": (namespace: string | null, id: number) => rt.drive(cancelJob(callingIdentity().uid, namespace, id)),
  "cancelAllInNamespace(Ljava/lang/String;)V": driven(function* (namespace: string | null) {
    const { uid } = callingIdentity();
    for (const id of [...scheduled.get(uid)?.get(namespace)?.keys() ?? []]) yield* cancelJob(uid, namespace, id);
  }),
  "cancelAll()V": driven(function* () {
    const { uid } = callingIdentity();
    for (const [namespace, jobs] of scheduled.get(uid) ?? []) for (const id of [...jobs.keys()]) yield* cancelJob(uid, namespace, id);
  }),
  "getPendingJob(Ljava/lang/String;I)Landroid/app/job/JobInfo;": (namespace: string | null, id: number) =>
    callerJobs()?.get(namespace)?.get(id)?.spec.info ?? null,
  "getAllPendingJobsInNamespace(Ljava/lang/String;)Landroid/content/pm/ParceledListSlice;": (namespace: string | null) => slice(callerJobs()?.get(namespace)),
  "getAllPendingJobs()Ljava/util/Map;": driven(function* () {
    const map = yield newObj("java/util/HashMap");
    for (const [namespace, jobs] of callerJobs() ?? []) {
      if (jobs.size) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", namespace, yield* awaited(slice(jobs)));
    }
    return map;
  }),
}, { system: true });

// IJobCallback: the scheduler's end of one run
class JJobCallback extends JObj { job!: ScheduledJob; run!: JobRun; }
const live = (callback: JJobCallback) => callback.job.run === callback.run;
function finishing(this: JJobCallback, _id: number, reschedule: number) {
  const { job, run } = this;
  if (live(this)) later(() => finishJob(job, run, !!reschedule));
}
rt.register({ name: "webdroid/JobCallback", ctor: JJobCallback, sup: "android/app/job/IJobCallback$Stub", ifaces: ["android/os/IBinder$DeathRecipient"], methods: {
  "acknowledgeStartMessage(IZ)V": function (this: JJobCallback, _id: number, ongoing: number) {
    const { job, run } = this;
    if (live(this) && !ongoing) later(() => finishJob(job, run, false));
  },
  "acknowledgeStopMessage(IZ)V": finishing,
  "jobFinished(IZ)V": finishing,
  "binderDied()V": function (this: JJobCallback) { finishing.call(this, 0, 1); },
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
