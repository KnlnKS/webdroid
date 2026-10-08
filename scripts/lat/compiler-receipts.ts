import type { CompileReceipt } from "../../src/jvm/compiler-observer";

type Interval = { start: number; end: number };
function delta(before: CompileReceipt | null, after: CompileReceipt | null, born: boolean) {
  if (!after || !before && !born || after.schema !== 1 || after.open.length || after.errors.length || after.dropped ||
    before && (before.schema !== 1 || before.open.length || before.errors.length || before.dropped || before.source !== after.source ||
      before.url !== after.url || before.bornAt !== after.bornAt || before.sequence > after.sequence || before.spans > after.spans || before.at > after.at)) return null;
  const phases = Object.fromEntries(Object.entries(after.phases).map(([key, value]) => [key, value! - (before?.phases[key as keyof typeof before.phases] ?? 0)]));
  const elapsedMs = after.elapsedMs - (before?.elapsedMs ?? 0);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || Object.values(phases).some(value => !Number.isFinite(value) || value < 0) ||
    Math.abs(Object.values(phases).reduce((sum, value) => sum + value, 0) - elapsedMs) > 1e-6) return null;
  return { elapsedMs, phases, spans: after.spans - (before?.spans ?? 0) };
}
function jobsError(row: any): string | null {
  const receipt = row.latest, jobs = receipt?.jobs, requests = row.requests;
  if (row.error || !receipt || receipt.dropped || !Array.isArray(jobs) || jobs.length !== receipt.sequence ||
    jobs.some((job: any, i: number) => job.sequence !== i + 1 || !Number.isFinite(job.at)) || !Array.isArray(requests) ||
    requests.some((request: any, i: number) => request.sequence !== i + 1 || !Number.isFinite(request.at))) return "missing, failed or dropped compiler journal";
  const begin = jobs.filter((job: any) => job.state === "begin");
  if (begin.length !== requests.length) return "compiler request is queued or unobserved";
  for (let i = 0; i < begin.length; i++) {
    const first = begin[i], request = requests[i], owned = jobs.filter((job: any) => job.ordinal === first.ordinal);
    if (first.ordinal !== i + 1 || request.type !== first.type || request.id !== first.id || owned[0] !== first ||
      owned.some((job: any) => job.type !== first.type || job.id !== first.id || !["begin", "inputs", "end"].includes(job.state)) ||
      owned.filter((job: any) => job.state === "end").length !== 1 || owned.at(-1).state !== "end") return "compiler job is in flight, failed or unmatched";
    if (["init", "add", "compileAhead"].includes(first.type) && !owned.some((job: any) => job.state === "inputs")) return "compiler input receipt missing";
    if (owned.some((job: any) => job.state === "inputs" && (!Array.isArray(job.inputs) || job.inputs.some((input: any) =>
      typeof input.name !== "string" || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || !/^[a-f0-9]{64}$/.test(input.sha256))))) return "compiler input receipt invalid";
  }
  if (jobs.some((job: any) => !begin.some((first: any) => first.ordinal === job.ordinal))) return "compiler job has no begin receipt";
  const owner = row.owner;
  if (!owner || receipt.instance !== owner.instance || receipt.role !== owner.role || receipt.owner !== owner.owner || receipt.url !== owner.url ||
    !Number.isFinite(row.receivedAt) || row.retiredAt !== null && (!receipt.terminal || row.receivedAt > row.retiredAt)) return "compiler ownership or retirement receipt invalid";
  return null;
}
/** Bounded receipts measure synchronous elapsed work; async script compilation remains separate. */
export function compilerElapsedWindow(before: any[], after: any[], interval: Interval) {
  const failures: string[] = [], rows: any[] = [];
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end < interval.start) failures.push("compiler window unavailable");
  const old = new Map(before.map(row => [row.url, row]));
  for (const realm of after) {
    const initial = old.get(realm.url)?.proof?.receipt, end = realm.proof?.receipt; old.delete(realm.url);
    if (!end?.compiler && !end?.compilerWorkers) continue;
    const birth = !initial && end.bornAt >= interval.start && end.bornAt <= interval.end;
    const main = delta(initial?.compiler ?? null, end.compiler, birth);
    if (!main) failures.push(`${realm.url}: main compiler spans unavailable or open`);
    rows.push({ owner: realm.url, role: "main", delta: main });
    const registry = end.compilerWorkers, prior = initial?.compilerWorkers;
    if (!registry || registry.schema !== 1 || registry.dropped || registry.clockUrl !== end.clockUrl || registry.at > interval.end ||
      prior && (prior.source !== registry.source || prior.clockUrl !== registry.clockUrl || prior.at > interval.start)) {
      failures.push(`${realm.url}: compiler registry unavailable or outside window`); continue;
    }
    const workers = new Map((prior?.rows ?? []).map((row: any) => [row.owner.instance, row]));
    if (new Set(registry.rows.map((row: any) => row.owner.instance)).size !== registry.rows.length) failures.push(`${realm.url}: duplicate compiler instance`);
    for (const worker of registry.rows) {
      const start = workers.get(worker.owner.instance) as any; workers.delete(worker.owner.instance);
      const newborn = !start && worker.owner.bornAt >= interval.start && worker.owner.bornAt <= interval.end;
      const error = jobsError(worker) ?? (start && jobsError(start)) ?? (realm.proof.dead && worker.retiredAt === null ? "owning realm retired without terminal worker receipt" : null);
      const unchanged = !start || !!start.latest && !!worker.latest && JSON.stringify(start.owner) === JSON.stringify(worker.owner) &&
        JSON.stringify(start.requests) === JSON.stringify(worker.requests.slice(0, start.requests.length)) &&
        JSON.stringify(start.latest.jobs) === JSON.stringify(worker.latest.jobs.slice(0, start.latest.jobs.length));
      const spans = error || !unchanged || worker.owner.owner !== realm.url || worker.receivedAt > registry.at ? null
        : delta(start?.latest?.compiler ?? null, worker.latest.compiler, newborn);
      if (!spans) failures.push(`${worker.owner.instance}: ${error ?? "compiler birth, source, window or sequence proof unavailable"}`);
      rows.push({ owner: realm.url, instance: worker.owner.instance, role: worker.owner.role, delta: spans, requests: worker.requests, receipt: worker.latest });
    }
    for (const instance of workers.keys()) failures.push(`${instance}: compiler retired without retained receipt`);
  }
  for (const realm of old.values()) if (realm.proof?.receipt?.compiler || realm.proof?.receipt?.compilerWorkers) failures.push(`${realm.url}: compiler realm missing from end snapshot`);
  const enabled = rows.length > 0;
  return { enabled, rows, failures, observedSpansCovered: enabled && !failures.length,
    elapsedMs: rows.reduce((sum, row) => sum + (row.delta?.elapsedMs ?? 0), 0), completeCompileWindow: false,
    limitation: "synchronous elapsed spans only; uninstrumented main linker/planning and async cached/chunk script compilation prevent total compile-time certification; no thread CPU measurement" };
}
