// What a gated tap compiled: the counter deltas of each realm between pointerup and the window's close.
import { COMPILE_COUNTERS } from "../../src/shell/perf-receipts.ts";

/** why a counter receipt (src/shell/perf-receipts.ts) does not certify its counters, or null */
function receiptError(r: any): string | null {
  if (!r) return "counter receipt unavailable";
  if (!Number.isSafeInteger(r.resets) || r.resets < 0 || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !Number.isFinite(r.at) ||
    COMPILE_COUNTERS.some(k => r.initial?.[k] !== 0 || !Number.isFinite(r.counters?.[k]) || r.counters[k] < 0)) return "invalid counter initialization, sequence or snapshot";
  return null;
}

export function compileDeltas(allBefore: any[], allAfter: any[], window?: { origin: number; up: number; end: number | null }) {
  // process Workers run off the page's thread: the main-realm accounting covers the page
  const onPage = (row: any) => { try { return new URL(row.url).pathname === "/"; } catch { return true; } };
  const before = allBefore.filter(onPage), after = allAfter.filter(onPage);
  const byUrl = new Map(before.map(row => [row.url, row])), failures: string[] = [];
  const counters = COMPILE_COUNTERS, probe = [...before, ...after].some(row => row.receipt !== undefined);
  const start = window ? window.origin + window.up : NaN, end = window?.end === null || !window ? NaN : window.origin + window.end;
  if (probe && (!Number.isFinite(start) || !Number.isFinite(end) || end < start)) failures.push("absolute counter window unavailable");
  if (new Set(after.map(row => row.url)).size !== after.length || byUrl.size !== before.length) failures.push("duplicate process realm snapshots");
  const totals = Object.fromEntries(counters.map(k => [k, 0]));
  const rows = after.map(row => {
    const previous = byUrl.get(row.url); byUrl.delete(row.url);
    if (probe) {
      const old = previous?.receipt, current = row.receipt;
      const error = receiptError(current) ?? (previous ? receiptError(old) : null) ?? (old && (old.resets !== current.resets || old.sequence > current.sequence ||
        old.at > start || current.at > end) ? "counters reset or read outside the window" : null);
      if (error) { failures.push(`${row.url}: ${error}`); return { before: previous ?? null, after: row, delta: null }; }
    }
    if (!row.available || !previous?.available || row.pkg !== previous.pkg) {
      failures.push(`${row.url}: process missing, new or identity changed`); return { before: previous ?? null, after: row, delta: null };
    }
    const delta = Object.fromEntries(counters.map(k => {
      const value = Number.isFinite(row.perf?.[k]) && Number.isFinite(previous.perf?.[k]) ? row.perf[k] - previous.perf[k] : null;
      if (value === null || !Number.isFinite(value) || value < 0) failures.push(`${row.url}: missing, invalid or reset ${k}`);
      else totals[k] += value;
      return [k, value];
    }));
    return { url: row.url, pkg: row.pkg, pid: row.pid, delta,
      compilerWorkerCompletedMs: row.compilerWorker && previous.compilerWorker ? row.compilerWorker.workerMs - previous.compilerWorker.workerMs : null };
  });
  for (const url of byUrl.keys()) failures.push(`${url}: process retired during window`);
  const partialCompilerWorkers = after.filter(row => row.compilerWorker || row.appBuilds?.length).map(row => ({ url: row.url,
    before: before.find(p => p.url === row.url)?.compilerWorker ?? null, after: row.compilerWorker, appBuilds: row.appBuilds,
    limitation: "completed job/build receipts only; queue, in-flight CPU and compiler clock coverage unavailable" }));
  return { rows, totals, failures, mainRealmCoverage: !failures.length && before.length > 0 && after.length > 0,
    compilerWorkerCoverage: partialCompilerWorkers.length === 0 ? "no compiler receipt observed; target absence not proved" : "partial",
    partialCompilerWorkers, completeCompileWindow: false,
    limitation: "main-realm counter deltas and completed-worker receipts are separate; no total compiler CPU or 30% reduction claim" };
}
