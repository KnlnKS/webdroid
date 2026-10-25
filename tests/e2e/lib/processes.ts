// What the harnesses read of webdroid's realms, as functions that run in the page (self-contained, for page.evaluate and lat's bundle) or
// on either side; scripts/page.ts reads them from node.
import type { WorkerControl } from "../../../src/shell/worker-control.ts";
import type { WorkerTerminal } from "../../../src/shell/worker-diagnostics.ts";

export type ProcessDiagnostics = {
  status: "ok";
  pkg: string | null;
  ticks: number;
  missing: string[];
  /** the Java frames that first reached each missing entry */
  missingAt: Record<string, string[]>;
  /** placeholder methods reached, and the Java frames that first reached each */
  placeholders: string[];
  placeholderAt: Record<string, string[]>;
  native: string[];
  errors: string[] | null;
  perf: Record<string, number> | null;
  queue: { queued: number; depth: number } | null;
} | { status: "exited"; pid: number; pkg: string; process: string; terminal: WorkerTerminal }
  | { status: "starting"; phase: string } | { status: "unavailable" } | { status: "failure"; message: string; terminal?: WorkerTerminal };

export type ProcessSnapshot = { url: string; diagnostics: ProcessDiagnostics };
/** a row of wd.workerProcesses(): a process Worker's identity, and its snapshot or how it ended */
export type WorkerProcess = { pid: number; pkg: string; process: string; url: string; snapshot?: Awaited<ReturnType<WorkerControl["snapshot"]>>; error?: string; terminal?: WorkerTerminal };
/** the log lines that are errors: the page's console.error, uncaught errors and unhandled rejections (a Worker's
 *  console.error is its logcat, labelled so) */
export const ERROR_LINE = /^(error|window\.error|unhandledrejection):/;
/** the page realm's diagnostics, evaluated in the page: `errorLine` is ERROR_LINE's source */
export function pageDiagnostics(errorLine: string) {
  const wd = globalThis.wd, error = new RegExp(errorLine);
  return wd ? { status: "ok" as const, pkg: wd.app()?.pkg ?? null, ticks: wd.ticks, missing: [...wd.rt.missing],
    missingAt: Object.fromEntries(wd.rt.missingAt ?? []),
    placeholders: [...wd.rt.placeholders],
    placeholderAt: Object.fromEntries(wd.rt.placeholderAt),
    native: wd.nativeRequirements(),
    errors: wd.logs?.filter((line: string) => error.test(line)) ?? null,
    perf: wd.perf ? { ...wd.perf } : null,
    queue: wd.mainDbg ? { queued: wd.mainDbg.queued, depth: wd.mainDbg.depth } : null } : { status: "unavailable" as const };
}
/** whether a process's diagnostics were read, or it ended as the broker expected (an exit is no failure) */
export const diagnosed = (diagnostics: ProcessDiagnostics): boolean => diagnostics.status === "ok" || diagnostics.status === "exited";
/** each process's error lines, and for one whose diagnostics did not arrive, why; a process still starting has none yet */
export const diagnosticErrors = (processes: ProcessSnapshot[]): string[] => processes.flatMap(({ url, diagnostics: d }) =>
  d.status === "ok" ? d.errors ?? [] : d.status === "exited" || d.status === "starting" ? [] : [`${url}: diagnostics ${d.status === "failure" ? d.message : d.status}`]);

/** a process Worker's row of wd.workerProcesses() as its diagnostics: its snapshot when that is complete and names the process, or how it ended */
export function workerDiagnostics(worker: WorkerProcess): ProcessDiagnostics {
  const terminal = worker.terminal;
  if (terminal) {
    const record = terminal.record;
    if (worker.error || !terminal.expected || !record)
      return { status: "failure", message: worker.error ?? terminal.cause, terminal };
    if (worker.snapshot || record.pid !== worker.pid || record.pkg !== worker.pkg || record.process !== worker.process)
      return { status: "failure", message: `Worker ${worker.pid}: terminal identity mismatch`, terminal };
    return { status: "exited", pid: worker.pid, pkg: worker.pkg, process: worker.process, terminal };
  }
  const snapshot = worker.snapshot;
  if (worker.error || !snapshot) return { status: "failure", message: worker.error ?? "Worker snapshot unavailable" };
  if (snapshot.phase === "failed") return { status: "failure", message: `Worker ${worker.pid}: start failed` };
  if (snapshot.phase !== "ready") return { status: "starting", phase: snapshot.phase };
  if (!snapshot.missingAt || !snapshot.placeholders || !snapshot.placeholderAt)
    return { status: "failure", message: `Worker ${worker.pid}: incomplete diagnostics` };
  const identity = snapshot.identity;
  if (!identity || identity.pid !== worker.pid || identity.process !== worker.process || identity.pkg !== worker.pkg)
    return { status: "failure", message: `Worker ${worker.pid}: diagnostic identity mismatch` };
  return { status: "ok", pkg: worker.pkg, ticks: snapshot.ticks, missing: snapshot.missing, missingAt: snapshot.missingAt,
    placeholders: snapshot.placeholders, placeholderAt: snapshot.placeholderAt, native: snapshot.nativeRequired,
    errors: snapshot.logs.filter(line => ERROR_LINE.test(line)), perf: snapshot.perf,
    queue: { queued: snapshot.main.queued, depth: snapshot.main.depth } };
}
/** how long a final read waits for processes still starting */
export const STARTING_MS = 30_000;
/** in the page: wd.workerProcesses() once no process is starting, waiting up to `waitMs`. A step reads at once (a process still starting is read at a
 *  later one); a final read waits, since a process another one started (a service it binds) boots at its own pace and has no diagnostics before it
 *  is ready. The wait asks the broker, not the booting Worker. */
export async function workerRows(waitMs = 0): Promise<WorkerProcess[]> {
  const wd = globalThis.wd, read = wd?.workerProcesses;
  if (!read) throw new Error("Worker diagnostics unavailable");
  for (const deadline = performance.now() + waitMs; wd.processStarting() && performance.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
  return read();
}

/** In the page: waits until the foreground app process has drawn its first frame, or with `presented` put one on the screen, polling every
 *  `pollMs`; true then, or why not: `ms` passed, or the launched app (the first process started) ended first, that process or another of its
 *  package by a crash. */
export async function appUp({ until, ms, pollMs }: { until: "drawn" | "presented"; ms: number; pollMs: number }): Promise<true | string> {
  const end = performance.now() + ms;
  for (let n = 0; ; n++) {
    const wd = globalThis.wd, row: WorkerProcess | null = await wd?.foregroundWorkerSnapshot(), perf = row?.snapshot?.perf;
    if (perf && (until === "drawn" ? perf.draws : perf.presentations) > 0) return true;
    // the foreground process's end reaches its row; the other processes are looked at every second
    const rows: WorkerProcess[] = row?.terminal ? [row] : n % Math.ceil(1000 / pollMs) ? [] : await wd?.workerProcesses() ?? [];
    const first = rows.reduce<WorkerProcess | undefined>((a, b) => a && a.pid < b.pid ? a : b, undefined);
    const ended = rows.find((r) => r.pkg === first?.pkg && (r.terminal?.record?.crash || r === first && r.terminal));
    if (ended?.terminal) {
      const crash = ended.terminal.record?.crash;
      return `${ended.pkg} ended before its app ${until} a frame: ${crash ? `${crash.exceptionClassName}: ${crash.exceptionMessage}` : ended.terminal.cause}`;
    }
    if (performance.now() > end) return `no app ${until} a frame within ${ms} ms${row ? ` (${row.pkg}${row.error ? ": " + row.error : ""})` : ""}`;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** In the page: waits until no process is starting and every process's main queue has been empty for `stableMs`, polling every `pollMs`; true
 *  then, or what was still busy when `ms` passed. An app that animates keeps its queue busy until then. */
export async function appIdle({ ms, stableMs, pollMs }: { ms: number; stableMs: number; pollMs: number }): Promise<true | string> {
  const end = performance.now() + ms;
  for (let idleSince = performance.now(); ; await new Promise(resolve => setTimeout(resolve, pollMs))) {
    const wd = globalThis.wd, rows: WorkerProcess[] = await wd.workerProcesses(), now = performance.now();
    const busy = rows.filter(({ terminal, snapshot: s }) => !terminal && !(s?.phase === "ready" && !s.main.depth && !s.main.queued));
    if (busy.length || wd.processStarting()) idleSince = now;
    else if (now - idleSince >= stableMs) return true;
    if (now > end) return `busy after ${ms} ms: ${busy.map(r => `${r.process} ${r.snapshot?.phase === "ready" ? "main queue" : r.snapshot?.phase ?? r.error}`).join(", ") || "a process starting"}`;
  }
}
