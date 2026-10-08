export type Region = [number, number, number, number];
export type Selector = { text?: string; desc?: string; resId?: string; within?: Region };
export type Expectation = { nodes: Selector[]; absent?: Selector[]; pixels: { region: Region; changed?: boolean; nonUniform?: boolean; rgb?: [number, number, number][] }[] };

export function matchesState(nodes: { text: string; desc: string; resId: string; bounds: Region }[], expectation: Expectation) {
  const normal = (s: string) => s.replace(/\s+/g, " ").trim();
  const matches = (s: Selector) => nodes.some(n => (!s.text || normal(n.text) === normal(s.text)) && (!s.desc || normal(n.desc) === normal(s.desc)) &&
    (!s.resId || n.resId === s.resId) && (!s.within || n.bounds[0] >= s.within[0] && n.bounds[1] >= s.within[1] && n.bounds[2] <= s.within[2] && n.bounds[3] <= s.within[3]));
  return expectation.nodes.length > 0 && expectation.nodes.every(matches) && !(expectation.absent ?? []).some(matches);
}

export function compileDeltas(before: any[], after: any[]) {
  const byUrl = new Map(before.map(row => [row.url, row])), failures: string[] = [];
  const counters = ["compileMs", "classesCompiled", "wasmCompileMs", "wasmModuleMs", "wasmMethods", "wasmClassBuildMs"];
  const totals = Object.fromEntries(counters.map(k => [k, 0]));
  const rows = after.map(row => {
    const previous = byUrl.get(row.url); byUrl.delete(row.url);
    if (!row.available || !previous?.available || row.pkg !== previous.pkg || row.tier !== previous.tier) {
      failures.push(`${row.url}: process missing, new or identity changed`); return { before: previous ?? null, after: row, delta: null };
    }
    const delta = Object.fromEntries(counters.map(k => {
      const value = Number.isFinite(row.perf?.[k]) && Number.isFinite(previous.perf?.[k]) ? row.perf[k] - previous.perf[k] : null;
      if (value === null || !Number.isFinite(value) || value < 0) failures.push(`${row.url}: missing, invalid or reset ${k}`);
      else totals[k] += value;
      return [k, value];
    }));
    return { url: row.url, pkg: row.pkg, pid: row.pid, tier: row.tier, delta,
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
