import type { Page } from "playwright";
import type { WorkerControl } from "../../../src/shell/worker-control.ts";
import type { WorkerTerminal } from "../../../src/shell/processes.ts";

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
  | { status: "unavailable" } | { status: "failure"; message: string; terminal?: WorkerTerminal };

export type ProcessSnapshot = { url: string; diagnostics: ProcessDiagnostics };
/** the log lines that are errors: the page's console.error, uncaught errors and unhandled rejections (a Worker's
 *  console.error, its logcat, carries no prefix) */
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
type WorkerSnapshot = Awaited<ReturnType<WorkerControl["snapshot"]>>;
type WorkerProcess = { pid: number; pkg: string; process: string; url?: string; snapshot?: WorkerSnapshot; error?: string; terminal?: WorkerTerminal };

async function bounded<T>(read: Promise<T>): Promise<T | { status: "failure"; message: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read.catch(error => ({ status: "failure" as const, message: String(error) })),
      new Promise<{ status: "failure"; message: string }>(resolve => {
        timer = setTimeout(() => resolve({ status: "failure", message: "diagnostic timeout" }), 6000);
      })]);
  } finally { clearTimeout(timer); }
}

function workerDiagnostics(worker: WorkerProcess): ProcessDiagnostics {
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
  if (snapshot.dead || snapshot.phase !== "ready") return { status: "failure", message: `Worker ${worker.pid}: ${snapshot.dead ? "dead" : snapshot.phase}` };
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

/** Diagnostics from the page's realm and every process Worker. */
export async function readProcesses(page: Page): Promise<ProcessSnapshot[]> {
  const origin = new URL(page.url()).origin, frame = page.mainFrame();
  const root = (async () => {
    const read = () => frame.evaluate(pageDiagnostics, ERROR_LINE.source);
    const diagnostics = await bounded((async () => {
      let result = await read();
      if (result.status === "unavailable") {
        await frame.waitForFunction(() => !!globalThis.wd, null, { timeout: 2_000 });
        result = await read();
      }
      return result;
    })());
    return { url: frame.url(), diagnostics };
  })();
  const workers = bounded(page.evaluate(async () => {
    const read = globalThis.wd?.workerProcesses;
    if (!read) throw new Error("Worker diagnostics unavailable");
    const deadline = performance.now() + 2000;
    let rows = await read();
    while (rows.some((row: WorkerProcess) => row.error?.startsWith("Worker is not ready:")) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      rows = await read();
    }
    return rows;
  }) as Promise<WorkerProcess[]>).then(result => Array.isArray(result)
    ? result.map(worker => ({ url: `worker:${worker.url ?? origin + "/process-worker.js"}#pid=${worker.pid}`, diagnostics: workerDiagnostics(worker) }))
    : [{ url: "worker:" + origin, diagnostics: result }]);
  const [page_, rows] = await Promise.all([root, workers]);
  return [page_, ...rows];
}
