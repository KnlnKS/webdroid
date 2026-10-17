import { COMPILE_COUNTERS } from "../../src/shell/perf-receipts.ts";

export type Region = [number, number, number, number];
export type Selector = { text?: string; desc?: string; resId?: string; within?: Region };
/** `ms`: how long after the action (a launch: after its first presentation) the state may take to appear, 8 s unless given */
export type Expectation = { nodes: Selector[]; absent?: Selector[]; pixels: { region: Region; changed?: boolean; nonUniform?: boolean; rgb?: [number, number, number][] }[]; ms?: number };

export function matchesState(nodes: { text: string; desc: string; resId: string; bounds: Region }[], expectation: Expectation) {
  const normal = (s: string) => s.replace(/\s+/g, " ").trim();
  const matches = (s: Selector) => nodes.some(n => (!s.text || normal(n.text) === normal(s.text)) && (!s.desc || normal(n.desc) === normal(s.desc)) &&
    (!s.resId || n.resId === s.resId) && (!s.within || n.bounds[0] >= s.within[0] && n.bounds[1] >= s.within[1] && n.bounds[2] <= s.within[2] && n.bounds[3] <= s.within[3]));
  return expectation.nodes.length > 0 && expectation.nodes.every(matches) && !(expectation.absent ?? []).some(matches);
}

function proofError(row: any, pending = false): string | null {
  const p = row.proof, r = p?.receipt;
  if (!p || p.schema !== 1 || p.error || p.dropped !== 0 || !Array.isArray(p.events) || p.events.length > 128 || p.events.length !== p.sequence ||
    p.events.some((e: any, i: number) => e.sequence !== i + 1 || !Number.isFinite(e.at) || !["created", "retired"].includes(e.kind) || i > 0 && e.at < p.events[i - 1].at)) return "missing, dropped or invalid broker lifecycle";
  const o = p.owner;
  if (!o || o.url !== row.url || o.pkg !== row.pkg || String(o.pid) !== String(row.pid) || !o.pkg || !o.process || !Number.isSafeInteger(o.pid) || o.pid <= 0 ||
    row.runtimePkg && row.runtimePkg !== o.pkg) return "conflicting broker/process ownership";
  const created = p.events.filter((e: any) => e.pid === o.pid && e.kind === "created"), retired = p.events.filter((e: any) => e.pid === o.pid && e.kind === "retired");
  if (created.length !== 1 || retired.length !== +p.processDead || [...created, ...retired].some(e => e.url !== o.url || e.pkg !== o.pkg || e.process !== o.process)) return "incomplete or conflicting process lifecycle";
  if (!r) return pending && !p.dead ? null : "counter birth or terminal receipt unavailable";
  try {
    const url = new URL(row.url);
    if (url.pathname !== "/" || new URL(p.source).origin !== url.origin || new URL(r.source).origin !== url.origin ||
      r.url !== row.url || r.pid !== null) return "counter source/realm association mismatch";
  } catch { return "invalid counter source URL"; }
  if (r.schema !== 1 || !Number.isSafeInteger(r.resets) || r.resets < 0 || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !Number.isFinite(r.bornAt) || !Number.isFinite(r.at) || r.at < r.bornAt ||
    COMPILE_COUNTERS.some(k => r.initial?.[k] !== 0 || !Number.isFinite(r.counters?.[k]) || r.counters[k] < 0 || r.counters[k] !== row.perf?.[k])) return "invalid counter initialization, sequence or snapshot";
  if (p.dead && (!p.processDead || retired[0].at < r.at)) return "terminal counters do not precede certified realm removal";
  return null;
}

export function compileDeltas(allBefore: any[], allAfter: any[], window?: { origin: number; up: number; end: number | null }) {
  // process Workers run off the page's thread: the main-realm accounting covers the page
  const onPage = (row: any) => { try { return new URL(row.url).pathname === "/"; } catch { return true; } };
  const before = allBefore.filter(onPage), after = allAfter.filter(onPage);
  const byUrl = new Map(before.map(row => [row.url, row])), failures: string[] = [];
  const counters = COMPILE_COUNTERS, probe = [...before, ...after].some(row => row.receiptProbe);
  const start = window ? window.origin + window.up : NaN, end = window?.end === null || !window ? NaN : window.origin + window.end;
  if (probe && (!Number.isFinite(start) || !Number.isFinite(end) || end < start)) failures.push("absolute counter window unavailable");
  if (new Set(after.map(row => row.url)).size !== after.length || byUrl.size !== before.length) failures.push("duplicate process realm snapshots");
  if (probe) {
    const root = after.filter(row => { try { return new URL(row.url).pathname === "/"; } catch { return false; } });
    if (root.length !== 1 || after.some(row => row.proof?.receipt && row.proof.receipt.clockUrl !== root[0]?.url)) failures.push("canonical root counter clock unavailable or changed");
    const missing = new Set<string>();
    for (const row of after) for (const event of row.proof?.events ?? []) {
      if (onPage(event) && !after.some(owner => owner.url === event.url && String(owner.pid) === String(event.pid) && owner.pkg === event.pkg)) missing.add(event.url);
    }
    for (const url of missing) failures.push(`${url}: lifecycle owner missing from end snapshot`);
  }
  const totals = Object.fromEntries(counters.map(k => [k, 0]));
  const rows = after.map(row => {
    let previous = byUrl.get(row.url); byUrl.delete(row.url);
    if (probe) {
      const error = proofError(row);
      if (error) { failures.push(`${row.url}: ${error}`); return { before: previous ?? null, after: row, delta: null }; }
      if (previous) {
        const beforeError = proofError(previous, true), old = previous.proof?.receipt, current = row.proof.receipt;
        if (beforeError || previous.pkg !== row.pkg || previous.pid !== row.pid || previous.proof.source !== row.proof.source ||
          previous.proof.sequence > row.proof.sequence || JSON.stringify(previous.proof.events) !== JSON.stringify(row.proof.events.slice(0, previous.proof.events.length)) ||
          old && (old.bornAt !== current.bornAt || old.source !== current.source || old.resets !== current.resets || old.sequence > current.sequence || old.at > start)) {
          failures.push(`${row.url}: ${beforeError ?? "counter ownership, epoch or lifecycle changed"}`); return { before: previous, after: row, delta: null };
        }
      }
      if (row.proof.receipt.at > end) failures.push(`${row.url}: counter receipt exceeds window end`);
      if (!previous?.available) {
        if (row.proof.receipt.resets !== 0 || row.proof.receipt.bornAt < start || row.proof.receipt.bornAt > end) {
          failures.push(`${row.url}: process began before window without a start snapshot`); return { before: previous ?? null, after: row, delta: null };
        }
        previous = { ...row, perf: row.proof.receipt.initial, available: true, compilerWorker: null, certifiedBirthBaseline: row.proof.receipt.bornAt };
      }
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
