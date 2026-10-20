// What the harness reads of the process Workers (main.ts's wd): each one's copied snapshot or how it
// ended, its AOT profile, and whether its main queue still dispatches.
import { copyExitRecord, type ExitRecord } from "../android/server/appexitinfo.ts";
import type { ProcessHost } from "./process-host.ts";
import type { Entry, ProcessBroker } from "./processes.ts";
import type { WorkerControl } from "./worker-control.ts";

export type WorkerTerminal = { expected: boolean; cause: string; record: ExitRecord | null };
type WorkerIdentity = { pid: number; pkg: string; process: string; url: string };
type Snapshot = Awaited<ReturnType<WorkerControl["snapshot"]>>;
export type WorkerDiagnosticRow = WorkerIdentity & (
  { snapshot: Snapshot; terminal?: never; error?: never } |
  { error: string; terminal?: WorkerTerminal } | { terminal: WorkerTerminal; error?: never });

/** p, or late()'s result once `ms` pass first */
export function within<T>(p: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }).then(late)]).finally(() => clearTimeout(timer));
}
/** one in-flight read per Worker, shared by concurrent callers */
function shared<T>(reads: WeakMap<ProcessHost, Promise<T>>, host: ProcessHost, start: () => Promise<T>): Promise<T> {
  let read = reads.get(host);
  if (!read) {
    const pending = read = Promise.resolve().then(start);
    reads.set(host, pending);
    const clear = () => { if (reads.get(host) === pending) reads.delete(host); };
    void pending.then(clear, clear);
  }
  return read;
}
const snapshots = new WeakMap<ProcessHost, Promise<Snapshot>>(), liveness = new WeakMap<ProcessHost, Promise<boolean>>();
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
/** the processes of `entries` that run in Workers, with each one's identity */
const hosted = (entries: Iterable<Entry>) => [...entries].flatMap(entry => {
  const host = entry.host;
  return host ? [{ entry, host, identity: { pid: entry.pid, pkg: entry.pkg, process: entry.process, url: host.url } }] : [];
});

export function workerAotProfiles(entries: Iterable<Entry>) {
  return Promise.all(hosted(entries).map(async ({ entry, host, identity }) => {
    try {
      if (entry.dead) throw new Error("Worker has exited");
      const result = await within(host.control.aotProfile(), 5000, () => { throw new Error("Worker AOT profile timeout"); });
      if (entry.dead || result.dead) throw new Error("Worker has exited");
      if (result.phase !== "ready") throw new Error("Worker is not ready: " + result.phase);
      if (result.identity.pid !== entry.pid || result.identity.pkg !== entry.pkg || result.identity.process !== entry.process)
        throw new Error("Worker AOT profile identity mismatch");
      return { ...identity, result };
    } catch (error) { return { ...identity, error: failure(error) }; }
  }));
}
export function workerSnapshots(entries: Iterable<Entry>): Promise<WorkerDiagnosticRow[]> {
  return Promise.all(hosted(entries).map(async ({ entry, host, identity }): Promise<WorkerDiagnosticRow> => {
    if (entry.dead) return ended(host, identity);
    const read = shared(snapshots, host, () => host.control.snapshot());
    try {
      const snapshot = await within(read, 5000, () => { throw new Error("Worker diagnostic timeout"); });
      if (entry.dead) return ended(host, identity);
      if (snapshot.dead || snapshot.phase !== "ready") throw new Error(`Worker is ${snapshot.dead ? "dead" : "not ready: " + snapshot.phase}`);
      return { ...identity, snapshot };
    } catch (error) { return entry.dead ? ended(host, identity) : { ...identity, error: failure(error) }; }
  }));
}
function ended(host: ProcessHost, identity: WorkerIdentity): WorkerDiagnosticRow {
  const owned = host.ended?.terminal, terminal = owned && { ...owned, record: owned.record && copyExitRecord(owned.record) };
  return terminal?.expected ? { ...identity, terminal } : { ...identity, terminal, error: host.ended?.error ?? "Worker owner unavailable" };
}
export async function foregroundWorkerSnapshot(broker: ProcessBroker): Promise<WorkerDiagnosticRow | null> {
  const pid = broker.activities.foreground;
  for (const entry of broker.processes()) if (entry.pid === pid) return (await workerSnapshots([entry]))[0] ?? null;
  return null;
}

/** A control reply is not evidence that the Java main queue can dispatch a job: alive() answers from it. */
async function alive(entry: Entry, ms: number): Promise<boolean> {
  const host = entry.host;
  if (!host || entry.dead) return false;
  try { return await within(shared(liveness, host, () => host.control.alive()), ms, () => false) && !entry.dead; }
  catch { return false; }
}
const shownWorkers = (broker: ProcessBroker) => broker.activities.shownEntries().filter(entry => entry.host && !entry.dead);
/** whether every shown process Worker's main queue dispatched within `ms`; null with none shown */
export async function visibleWorkersAlive(broker: ProcessBroker, ms: number): Promise<boolean | null> {
  const entries = shownWorkers(broker);
  return entries.length ? (await Promise.all(entries.map(entry => alive(entry, ms)))).every(Boolean) : null;
}
export async function visibleWorkerProcesses(broker: ProcessBroker, ms: number) {
  const entries = shownWorkers(broker);
  const [rows, live] = await Promise.all([workerSnapshots(entries), Promise.all(entries.map(entry => alive(entry, ms)))]);
  return rows.map((row, i) => ({ ...row, alive: live[i] }));
}
