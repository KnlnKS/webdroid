// Profiles an ordinary action without pausing targets or changing tiering budgets.
import type { Browser } from "playwright";
import type { Profiler } from "node:inspector";
import { createHash } from "node:crypto";
import type { ProcessSnapshot } from "../../tests/e2e/lib/processes";
import { wasmWireMap } from "./wire-map";

export async function startBoundaryProfiles(browser: Browser, readProcessDiagnostics?: () => Promise<ProcessSnapshot[]>, options: { window?: boolean; sources?: boolean } = {}) {
  const cdp = await browser.newBrowserCDPSession();
  type TargetInfo = Awaited<ReturnType<typeof cdp.send<"Target.getTargets">>>["targetInfos"][number];
  type Script = { scriptId: string; url: string; hash?: string; scriptLanguage?: string; codeOffset?: number; executionContextId?: number; executionContextAuxData?: unknown };
  type Source = { scriptId: string; source?: string; bytecode?: string; sha256: string; metadata?: Script; wire?: ReturnType<typeof wasmWireMap> };
  type Target = { target: TargetInfo; sessionId?: string; before?: unknown; started?: number; born: string; createdObservedMs: number; destroyedObservedMs?: number; destroyedPhase?: string; profile?: Profiler.Profile; stopped?: number; after?: unknown; sources: Source[]; scripts: Map<string, Script>; error?: string };
  const relevant = (type: string) => ["page", "iframe", "worker", "shared_worker", "service_worker"].includes(type);
  let phase = "starting", id = 0;
  const targets = new Map<string, Target>(), jobs = new Map<string, Promise<void>>();
  const errors: string[] = [], sourceErrors: string[] = [], diagnosticErrors: string[] = [];
  const pending = new Map<number, { sessionId: string; resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  cdp.on("Target.receivedMessageFromTarget", e => {
    const m = JSON.parse(e.message);
    if (m.method === "Debugger.scriptParsed") {
      const target = [...targets.values()].find(t => t.sessionId === e.sessionId);
      target?.scripts.set(m.params.scriptId, m.params);
    }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });
  const send = (sessionId: string, method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const request = ++id, timer = setTimeout(() => { pending.delete(request); reject(new Error(`target command timed out: ${method}`)); }, 5000);
    pending.set(request, { sessionId, resolve, reject, timer });
    cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: request, method, params }) }).catch(e => { clearTimeout(timer); pending.delete(request); reject(e); });
  });
  const read = (sessionId: string) => send(sessionId, "Runtime.evaluate", { expression: "JSON.stringify(globalThis.wd?.perf?{available:true,tier:globalThis.wd.tier,pkg:globalThis.wd.app()?.pkg??null,ticks:globalThis.wd.ticks,perf:{...globalThis.wd.perf}}:{available:false})", returnByValue: true })
    .then(r => r.result?.value ? JSON.parse(r.result.value) : null);
  const diagnostics = async (point: string) => {
    if (!readProcessDiagnostics) { diagnosticErrors.push(`${point}: all-process diagnostics reader missing`); return []; }
    try {
      const rows = await readProcessDiagnostics();
      if (!rows.length) diagnosticErrors.push(`${point}: no Java process diagnostics`);
      for (const row of rows) {
        const d = row.diagnostics;
        if (d.status !== "ok" && d.status !== "exited" || d.status === "ok" && (!d.perf || !d.queue || !Number.isFinite(d.ticks)))
          diagnosticErrors.push(`${point}: ${row.url}: ${JSON.stringify(d)}`);
      }
      return rows;
    } catch (e) { diagnosticErrors.push(`${point}: ${String(e)}`); return []; }
  };
  const processesBefore = await diagnostics("before");
  const attach = (info: TargetInfo, born: string) => {
    if (targets.has(info.targetId)) return jobs.get(info.targetId);
    const target: Target = { target: info, born, createdObservedMs: performance.now(), sources: [], scripts: new Map() };
    targets.set(info.targetId, target);
    const job = (async () => {
      try {
        target.sessionId = (await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: false })).sessionId;
        if (born === "starting") target.before = await read(target.sessionId);
        await send(target.sessionId, "Profiler.enable");
        await send(target.sessionId, "Profiler.setSamplingInterval", { interval: 1000 });
        await send(target.sessionId, "Profiler.start");
        target.started = performance.now();
        if (born !== "starting") target.before = await read(target.sessionId);
      } catch (e) { target.error = String(e); }
    })();
    jobs.set(info.targetId, job);
    return job;
  };
  cdp.on("Target.targetCreated", e => {
    if (!relevant(e.targetInfo.type) || phase === "closed") return;
    if (phase === "starting" || phase === "active") void attach(e.targetInfo, phase);
    else if (!targets.has(e.targetInfo.targetId)) targets.set(e.targetInfo.targetId, { target: e.targetInfo, born: phase, createdObservedMs: performance.now(), sources: [], scripts: new Map() });
  });
  cdp.on("Target.targetInfoChanged", e => { const t = targets.get(e.targetInfo.targetId); if (t) t.target = e.targetInfo; });
  cdp.on("Target.targetDestroyed", e => {
    const target = targets.get(e.targetId);
    if (!target) return;
    target.destroyedObservedMs = performance.now();
    target.destroyedPhase = phase;
    for (const [id, p] of pending) if (p.sessionId === target.sessionId) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error("target retired before command completed")); }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  for (const info of (await cdp.send("Target.getTargets")).targetInfos) if (relevant(info.type)) void attach(info, "starting");
  for (let count = -1, until = performance.now() + 15000; count !== jobs.size;) {
    if (performance.now() > until) { errors.push("target discovery did not stabilize within 15 seconds"); break; }
    count = jobs.size; await Promise.all(jobs.values());
  }
  const traceEvents: { name: string; ts: number; args?: { sync_id?: string } }[] = [];
  let traceDone: Promise<void> | undefined, traceStarted = false;
  if (options.window) {
    cdp.on("Tracing.dataCollected", e => traceEvents.push(...e.value as unknown as typeof traceEvents));
    traceDone = new Promise(resolve => cdp.once("Tracing.tracingComplete", () => resolve()));
    try {
      await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["__metadata"] }, transferMode: "ReportEvents" });
      traceStarted = true;
      await cdp.send("Tracing.recordClockSyncMarker", { syncId: "boundary:start" });
    } catch (e) { errors.push(`profile clock start: ${String(e)}`); }
  }
  phase = "active";
  return async () => {
    phase = "stopping";
    try {
      if (traceStarted) await cdp.send("Tracing.recordClockSyncMarker", { syncId: "boundary:end" }).catch(e => errors.push(`profile clock end: ${String(e)}`));
      await Promise.all(jobs.values());
      // Stop concurrently before enabling Debugger or retrieving any script bytes.
      await Promise.all([...targets.values()].map(async target => {
        if (!target.sessionId || !target.started) return;
        try { target.profile = (await send(target.sessionId, "Profiler.stop")).profile; target.stopped = performance.now(); }
        catch (e) { target.error = String(e); }
      }));
      phase = "reading";
      const sourceDeadline = performance.now() + 30000;
      for (const target of targets.values()) {
        if (!target.profile || !target.sessionId) continue;
        if (performance.now() > sourceDeadline) { sourceErrors.push("source retrieval exceeded 30-second budget"); break; }
        target.after = await read(target.sessionId).catch(e => ({ failure: String(e) }));
        if (!options.sources) continue;
        try {
          await send(target.sessionId, "Debugger.enable");
          const ids = new Set(target.profile.nodes.filter(n => /^[1-9][0-9]*$/.test(n.callFrame.scriptId)).map(n => n.callFrame.scriptId));
          for (const scriptId of ids) {
            try {
              if (performance.now() > sourceDeadline) throw new Error("source retrieval exceeded 30-second budget");
              const source = await send(target.sessionId, "Debugger.getScriptSource", { scriptId });
              const metadata = target.scripts.get(scriptId);
              if (!metadata) throw new Error("scriptParsed identity metadata unavailable");
              const wasm = target.profile.nodes.some(n => n.callFrame.scriptId === scriptId && n.callFrame.url.startsWith("wasm://"));
              if (wasm && !source.bytecode) throw new Error("sampled Wasm bytecode unavailable");
              const bytes = source.bytecode ? Buffer.from(source.bytecode, "base64") : Buffer.from(source.scriptSource);
              target.sources.push({ scriptId, metadata, sha256: createHash("sha256").update(bytes).digest("hex"),
                ...(source.bytecode ? { bytecode: source.bytecode, wire: wasmWireMap(bytes) } : { source: source.scriptSource }) });
            } catch (e) { sourceErrors.push(`${target.target.targetId} source ${scriptId}: ${String(e)}`); }
          }
        } catch (e) { sourceErrors.push(`${target.target.targetId} source collection: ${String(e)}`); }
        finally { await send(target.sessionId, "Debugger.disable").catch(() => {}); }
      }
      if (traceStarted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await cdp.send("Tracing.end");
          await Promise.race([traceDone, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("profile trace completion timeout")), 5000); })]);
        } catch (e) { errors.push(String(e)); }
        finally { clearTimeout(timer); }
      }
      const start = traceEvents.find(e => e.name === "clock_sync" && e.args?.sync_id === "boundary:start")?.ts;
      const end = traceEvents.find(e => e.name === "clock_sync" && e.args?.sync_id === "boundary:end")?.ts;
      const window = options.window ? { startUs: start, endUs: end, valid: start !== undefined && end !== undefined && end > start } : undefined;
      if (options.window && !window?.valid) errors.push("common profile clock markers missing or unordered");
      const processesAfter = await diagnostics("after");
      const processes = [...processesBefore, ...processesAfter];
      const matchProcesses = (url: string) => processes.filter(p => p.url === url || p.url.startsWith(`worker:${url}#pid=`));
      const owner = (target: TargetInfo) => {
        const direct = matchProcesses(target.url);
        const parents = [], seen = new Set<string>([target.targetId]);
        for (let id = target.parentId; id && !seen.has(id);) {
          seen.add(id); const parent = targets.get(id)?.target; if (!parent) break;
          parents.push(parent); id = parent.parentId;
        }
        const parentMatches = parents.map(t => matchProcesses(t.url));
        const parentProcesses = parentMatches.flat(), nearestParentProcesses = parentMatches.find(rows => rows.length) ?? [];
        const url = URL.canParse(target.url) ? new URL(target.url) : null;
        const compilerWorker = url?.pathname === "/wasm-compile-worker.js";
        const declaredOwner = compilerWorker ? url.searchParams.get("owner") : null;
        const declaredUrl = declaredOwner && URL.canParse(declaredOwner) ? new URL(declaredOwner) : null;
        const declaredProcesses = declaredUrl && url && declaredUrl.origin === url.origin ? matchProcesses(declaredUrl.href) : [];
        const ownerClaimError = !compilerWorker ? null : !declaredProcesses.length ? "canonical spawn owner URL missing, invalid or absent from process diagnostics"
          : nearestParentProcesses.length && !nearestParentProcesses.some(p => p.url === declaredUrl?.href || p.url.startsWith(`worker:${declaredUrl?.href}#pid=`))
            ? "canonical spawn owner conflicts with observed CDP parent processes" : null;
        return { directProcesses: direct, parentTargetId: target.parentId ?? null, parentFrameId: target.parentFrameId ?? null,
          parentTargets: parents, parentProcesses, compilerWorker, declaredOwner, declaredProcesses, ownerClaimError,
          evidence: direct.length ? "canonical process URL/diagnostics" : parentProcesses.length ? "CDP parent chain and canonical process URL/diagnostics"
            : declaredProcesses.length ? "canonical spawn owner URL and process diagnostics; metadata does not prove CDP parentage" : "no observed Java owner association" };
      };
      const profiles = [], lifetimes = [], uncovered = [];
      for (const target of targets.values()) {
        const lifetime = { target: target.target, born: target.born, createdObservedMs: target.createdObservedMs, profilerStartedMs: target.started,
          destroyedObservedMs: target.destroyedObservedMs, destroyedPhase: target.destroyedPhase, error: target.error ?? null, owner: owner(target.target) };
        lifetimes.push(lifetime);
        if (target.destroyedPhase === "starting") continue;
        if (target.born !== "starting") uncovered.push({ ...lifetime, reason: "target appeared after window start; birth/receipt lag and pre-profile work are unmeasured" });
        if (target.error || !target.profile) uncovered.push({ ...lifetime, reason: "target profile unavailable or retired; no samples are fabricated" });
        else if (window?.valid && (target.profile.startTime > start! || target.profile.endTime < end!)) uncovered.push({ ...lifetime, reason: "profile does not cover common window" });
        if (target.profile) profiles.push({ target: target.target, sessionId: target.sessionId, before: target.before, after: target.after,
          started: target.started, stopped: target.stopped, profile: target.profile, sources: target.sources, lifetime });
      }
      return { accepted: false, window, traceEvents, profiles, lifetimes, errors, sourceErrors, diagnosticErrors, uncovered,
        processesBefore, processesAfter, diagnosticsAvailable: !!readProcessDiagnostics, sourcesRequested: !!options.sources,
        completeCoverage: !!window?.valid && !!options.sources && !errors.length && !sourceErrors.length && !diagnosticErrors.length && !uncovered.length && profiles.length > 0,
        lifetimeLimit: "Target creation/destruction times are host receipt observations. Born/retired target gaps invalidate coverage; discovery never pauses or prestarts targets." };
    } finally {
      phase = "closed";
      for (const target of targets.values()) if (target.sessionId) await cdp.send("Target.detachFromTarget", { sessionId: target.sessionId }).catch(() => {});
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("profile capture closed")); }
      pending.clear(); await cdp.detach();
    }
  };
}
