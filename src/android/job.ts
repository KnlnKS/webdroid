// IJobScheduler and IJobCallback, the scheduler's half of android.app.job: JobSchedulerImpl,
// JobParameters, JobWorkItem, JobService and JobServiceEngine run from AOSP. A job runs as
// JobServiceContext runs it: bind the job's service (in whichever process declares it), start it
// through the service's IJobService, and hear back through the IJobCallback its parameters carry.

import { rt, JObj, noops } from "../jvm/runtime";
import { newObj, reportUncaught, scall, vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jcoll";
import { bindAsSystem } from "./runningservices";
import { hostStub } from "./binder";
import { batteryLow, netUp } from "./services";
import { device } from "../shell/config";
import type { JComponentName } from "./intent";

/** what the scheduler needs of a JobInfo, read once when the job is scheduled */
type JobSpec = {
  info: JObj; namespace: string | null; id: number; service: JComponentName; interval: bigint | null; minLatency: bigint;
  backoff: bigint; extras: unknown; transientExtras: unknown; charging: boolean; idle: boolean; batteryNotLow: boolean; network: boolean;
};
async function jobSpec(info: JObj, namespace: string | null): Promise<JobSpec> {
  const get = (name: string, desc: string) => vcall(info, name, desc);
  return {
    info, namespace, id: await get("getId", "()I"), service: await get("getService", "()Landroid/content/ComponentName;"),
    interval: await get("isPeriodic", "()Z") ? await get("getIntervalMillis", "()J") : null,
    minLatency: await get("getMinLatencyMillis", "()J"), backoff: await get("getInitialBackoffMillis", "()J"),
    extras: await get("getExtras", "()Landroid/os/PersistableBundle;"), transientExtras: await get("getTransientExtras", "()Landroid/os/Bundle;"),
    charging: !!await get("isRequireCharging", "()Z"), idle: !!await get("isRequireDeviceIdle", "()Z"),
    batteryNotLow: !!await get("isRequireBatteryNotLow", "()Z"), network: !!await get("getRequiredNetwork", "()Landroid/net/NetworkRequest;"),
  };
}

type JobRun = { callback: JJobCallback; service: JObj | null; params: JObj | null; unbind: () => Promise<void>; executing: Set<number> };
type ScheduledJob = { spec: JobSpec; timer: ReturnType<typeof setTimeout> | null; run: JobRun | null; work: JObj[]; nextWork: number };
const namespaces = new Map<string | null, Map<number, ScheduledJob>>();
const jobsIn = (namespace: string | null) => {
  let jobs = namespaces.get(namespace);
  if (!jobs) namespaces.set(namespace, jobs = new Map());
  return jobs;
};
const pending = (job: ScheduledJob) => namespaces.get(job.spec.namespace)?.get(job.spec.id) === job;
let nextBinding = 1;
/** off the caller's stack, as JobServiceContext's handler messages are: a service reporting from
 *  inside a callback is not unbound under itself */
const later = (job: () => Promise<void>) => { setTimeout(() => void job().catch(reportUncaught), 0); };
function armJob(job: ScheduledJob, delay: number): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => { job.timer = null; void startJob(job).catch(reportUncaught); }, Math.min(Math.max(0, delay), 0x7fffffff));
}
async function finishJob(job: ScheduledJob, run: JobRun, reschedule: boolean): Promise<void> {
  if (job.run !== run) return;
  job.run = null;
  await run.unbind();
  if (!pending(job)) return;
  if (job.spec.interval !== null) armJob(job, Math.max(900000, Number(job.spec.interval)));
  else if (reschedule || job.work.length) armJob(job, reschedule ? Math.max(30000, Number(job.spec.backoff)) : 0);
  else namespaces.get(job.spec.namespace)!.delete(job.spec.id);
}
const PARAMS = "(Landroid/os/IBinder;Ljava/lang/String;ILandroid/os/PersistableBundle;Landroid/os/Bundle;Landroid/content/ClipData;IZZZ[Landroid/net/Uri;[Ljava/lang/String;Landroid/net/Network;)V";
async function startJob(job: ScheduledJob): Promise<void> {
  if (!pending(job) || job.run) return;
  const p = job.spec;
  if (p.charging && device.battery.status !== 2 || p.idle || p.batteryNotLow && batteryLow() || p.network && !netUp()) {
    armJob(job, 30000); return;
  }
  const callback: JJobCallback = await newObj("webdroid/JobCallback");
  const run: JobRun = { callback, service: null, params: null, unbind: async () => {}, executing: new Set() };
  callback.job = job; callback.run = run; job.run = run;
  try {
    const { binder, unbind } = await bindAsSystem(p.service, "job:" + p.id + ":" + nextBinding++);
    run.unbind = unbind;
    if (!pending(job)) { job.run = null; return unbind(); }
    run.service = await scall("android/app/job/IJobService$Stub", "asInterface", "(Landroid/os/IBinder;)Landroid/app/job/IJobService;", binder);
    run.params = await newObj("android/app/job/JobParameters", PARAMS, callback, p.namespace, p.id, p.extras, p.transientExtras,
      null, 0, 0, 0, 0, null, null, null);
    await vcall(run.service, "startJob", "(Landroid/app/job/JobParameters;)V", run.params);
  } catch (error) { await finishJob(job, run, true); throw error; }
}
async function cancelJob(namespace: string | null, id: number): Promise<void> {
  const job = namespaces.get(namespace)?.get(id);
  if (!job) return;
  namespaces.get(namespace)!.delete(id);
  if (job.timer) clearTimeout(job.timer);
  const run = job.run;
  if (!run?.service || !run.params) return;
  // STOP_REASON_CANCELLED_BY_APP; the service's acknowledgement unbinds it
  await vcall(run.params, "setStopReason", "(IILjava/lang/String;)V", 1, 0, "cancel() called by app");
  await vcall(run.service, "stopJob", "(Landroid/app/job/JobParameters;)V", run.params);
}
async function scheduleJob(namespace: string | null, info: JObj, item?: JObj): Promise<number> {
  const spec = await jobSpec(info, namespace), jobs = jobsIn(namespace), old = jobs.get(spec.id);
  // enqueue() onto a job that is still pending or running adds its work rather than replacing it
  if (item && old && old.spec.interval === null) { old.work.push(item); if (!old.run && !old.timer) armJob(old, 0); return 1; }
  if (old) await cancelJob(namespace, spec.id);
  const scheduled: ScheduledJob = { spec, timer: null, run: null, work: item ? [item] : [], nextWork: 1 };
  jobs.set(spec.id, scheduled);
  armJob(scheduled, spec.interval === null ? Number(spec.minLatency) : Math.max(900000, Number(spec.interval)));
  return 1;   // RESULT_SUCCESS
}
const slice = (jobs: Map<number, ScheduledJob> | undefined) =>
  newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList([...jobs?.values() ?? []].map((job) => job.spec.info)));
rt.register({ name: "webdroid/JobSchedulerService", ctor: class extends JObj {}, sup: "android/app/job/IJobScheduler$Stub", methods: {
  "schedule(Ljava/lang/String;Landroid/app/job/JobInfo;)I": scheduleJob,
  "enqueue(Ljava/lang/String;Landroid/app/job/JobInfo;Landroid/app/job/JobWorkItem;)I": scheduleJob,
  "cancel(Ljava/lang/String;I)V": cancelJob,
  "cancelAllInNamespace(Ljava/lang/String;)V": async (namespace: string | null) => {
    for (const id of [...namespaces.get(namespace)?.keys() ?? []]) await cancelJob(namespace, id);
  },
  "cancelAll()V": async () => {
    for (const [namespace, jobs] of namespaces) for (const id of [...jobs.keys()]) await cancelJob(namespace, id);
  },
  "getPendingJob(Ljava/lang/String;I)Landroid/app/job/JobInfo;": (namespace: string | null, id: number) =>
    namespaces.get(namespace)?.get(id)?.spec.info ?? null,
  "getAllPendingJobsInNamespace(Ljava/lang/String;)Landroid/content/pm/ParceledListSlice;": (namespace: string | null) => slice(namespaces.get(namespace)),
  "getAllPendingJobs()Ljava/util/Map;": async () => {
    const map = await newObj("java/util/HashMap");
    for (const [namespace, jobs] of namespaces) {
      if (jobs.size) await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", namespace, await slice(jobs));
    }
    return map;
  },
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
  "dequeueWork(I)Landroid/app/job/JobWorkItem;": async function (this: JJobCallback) {
    const { job, run } = this, item = live(this) ? job.work.shift() ?? null : null;
    if (item) {
      await vcall(item, "bumpDeliveryCount", "()V");
      let workId: number = await vcall(item, "getWorkId", "()I");
      if (!workId) await vcall(item, "setWorkId", "(I)V", workId = job.nextWork++);
      run.executing.add(workId);
    } else if (live(this) && !run.executing.size) later(() => finishJob(job, run, false));
    return item;
  },
  "completeWork(II)Z": function (this: JJobCallback, _id: number, workId: number) { return +this.run.executing.delete(workId); },
  // transfer estimates only inform JobScheduler's quota, which is not modelled
  ...noops("updateEstimatedNetworkBytes(ILandroid/app/job/JobWorkItem;JJ)V", "updateTransferredNetworkBytes(ILandroid/app/job/JobWorkItem;JJ)V"),
} });
