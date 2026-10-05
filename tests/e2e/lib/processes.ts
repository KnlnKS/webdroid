import type { Page } from "playwright";
import type { WorkerControl } from "../../../src/shell/worker-control";

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
  compositor: unknown;
  coverage: { enabled: boolean; methods: string[] } | null;
} | { status: "unavailable" } | { status: "failure"; message: string };

export type ProcessSnapshot = { url: string; diagnostics: ProcessDiagnostics };
type WorkerSnapshot = Awaited<ReturnType<WorkerControl["snapshot"]>> & Partial<Pick<Extract<ProcessDiagnostics, { status: "ok" }>,
  "missingAt" | "placeholders" | "placeholderAt" | "coverage">>;
type WorkerProcess = { pid: number; pkg: string; process: string; url?: string; snapshot?: WorkerSnapshot; error?: string };

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
  const snapshot = worker.snapshot;
  if (worker.error || !snapshot) return { status: "failure", message: worker.error ?? "Worker snapshot unavailable" };
  if (snapshot.dead || snapshot.phase !== "ready") return { status: "failure", message: `Worker ${worker.pid}: ${snapshot.dead ? "dead" : snapshot.phase}` };
  if (!snapshot.missingAt || !snapshot.placeholders || !snapshot.placeholderAt || snapshot.coverage === undefined)
    return { status: "failure", message: `Worker ${worker.pid}: incomplete diagnostics` };
  return { status: "ok", pkg: worker.pkg, ticks: snapshot.ticks, missing: snapshot.missing, missingAt: snapshot.missingAt,
    placeholders: snapshot.placeholders, placeholderAt: snapshot.placeholderAt, native: snapshot.nativeRequired,
    errors: snapshot.logs.filter(line => /^(error:|window.error:|unhandledrejection:)/.test(line)), perf: snapshot.perf,
    queue: { queued: snapshot.main.queued, depth: snapshot.main.depth }, compositor: null, coverage: snapshot.coverage };
}

function isWebdroidProcessFrame(url: string, origin: string): boolean {
  if (!URL.canParse(url)) return false;
  const frame = new URL(url), root = new URL(origin);
  return frame.origin === root.origin && (frame.pathname === "/" || frame.pathname === "/process");
}

/** Diagnostics from every webdroid realm, including process Workers. */
export async function readProcesses(page: Page): Promise<ProcessSnapshot[]> {
  const origin = new URL(page.url()).origin;
  const frames = Promise.all(page.frames().filter((frame) => isWebdroidProcessFrame(frame.url(), origin)).map(async (frame) => {
    const read = () => frame.evaluate(() => {
      const wd = globalThis.wd;
      return wd ? { status: "ok" as const, pkg: wd.app()?.pkg ?? null, ticks: wd.ticks, missing: [...wd.rt.missing],
        missingAt: Object.fromEntries(wd.rt.missingAt ?? []),
        placeholders: [...wd.rt.placeholders],
        placeholderAt: Object.fromEntries(wd.rt.placeholderAt),
        native: wd.nativeRequirements(),
        errors: wd.logs?.filter((line: string) => /^(error:|window.error:|unhandledrejection:)/.test(line)) ?? null,
        perf: wd.perf ? { ...wd.perf } : null,
        queue: wd.mainDbg ? { queued: wd.mainDbg.queued, depth: wd.mainDbg.depth } : null,
        compositor: Reflect.get(wd, "compositorStatus") ?? null,
        coverage: wd.jvmCoverage?.snapshot?.() ?? null } : { status: "unavailable" as const };
    });
    const diagnostics = await bounded((async () => {
      let result = await read();
      if (result.status === "unavailable") {
        await frame.waitForFunction(() => !!globalThis.wd, null, { timeout: 2_000 });
        result = await read();
      }
      return result;
    })());
    return { url: frame.url(), diagnostics };
  }));
  const workers = bounded(page.evaluate(async () => {
    const read = globalThis.wd?.workerProcesses;
    if (read) return read();
    if (new URLSearchParams(location.search).get("processMode") === "worker") throw new Error("Worker diagnostics unavailable");
    return [];
  }) as Promise<WorkerProcess[]>).then(result => Array.isArray(result)
    ? result.map(worker => ({ url: `worker:${worker.url ?? origin + "/process-worker.js"}#pid=${worker.pid}`, diagnostics: workerDiagnostics(worker) }))
    : [{ url: "worker:" + origin, diagnostics: result }]);
  const results = await Promise.all([frames, workers]);
  return results.flat();
}
