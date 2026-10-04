// Executable method tiers: installation, promotion and idle preparation belong to each linked
// method instance. The code cache independently deduplicates persisted source by DEX identity.
import type { Runtime, ClassInfo } from "./runtime";
import type { LazyMethod } from "./compiler";
import type { PreparedMethod } from "./prepared";
import { runCold, type ColdFrame, type ColdMethod } from "./cold";
import { bodyScript, codeKey, persistedBody, recordBody, recordUse, type Factory } from "./codecache";
import { claimOffered } from "./aot";
import { jvmProfiler } from "./profile";
import { jvmCoverage } from "./coverage";
import { perf } from "../perf";
import { setJava, setPublic, xname } from "./suspend";
import { parseMethodDesc } from "./abi";

export type CompiledCtor = { $i: ClassInfo; prototype: Record<string, unknown> } & Record<string, unknown>;
export type JvmFunction = (this: unknown, ...args: unknown[]) => unknown;
/** Re-enters a suspended frame (Runtime.dfr) or an on-stack-replaced cold frame. */
export type ResumeBody = (this: unknown, frame: object) => unknown;
/** Direct-call caches (`D.dp`, and hot sites in `$ic`) holding an interim entry, as flat
 *  [cache, index] pairs: null until a cache holds it, undefined for a final entry. A platform
 *  fallthrough that cannot run is marked `$unsafe`. */
export type Cells = { $c?: unknown[] | null; $unsafe?: boolean };
/** record that `cache[key]` holds `fn`, if `fn` is an interim entry a later body replaces */
export function addCell(fn: Cells, cache: unknown, key: unknown): void {
  if (fn.$c !== undefined) (fn.$c ??= []).push(cache, key);
}

/** Point the direct-call caches holding `from` at `to`, so they stop paying for the indirection. */
export function retarget(from: JvmFunction & Cells, to: JvmFunction & Cells): void {
  const cells = from.$c;
  if (cells === undefined) return;
  from.$c = undefined;
  if (!cells) return;
  for (let k = 0; k < cells.length; k += 2) (cells[k] as unknown[])[cells[k + 1] as number] = to;
  if (to.$c !== undefined) (to.$c ??= []).push(...cells);
}

interface MethodEmitter {
  prepare(): PreparedMethod;
  entry(prepared: PreparedMethod, count: boolean): string;
  resume(prepared: PreparedMethod): string;
  cold(prepared: PreparedMethod): ColdMethod;
}

const PROMOTE_BUDGET_MS = 4, PROMOTE_WINDOW_MS = 50;
const HOT_SOURCE_LIMIT = 32 * 1024 * 1024, IDLE_SOURCE_LIMIT = HOT_SOURCE_LIMIT - 8 * 1024 * 1024;
type IdleJob = (demand: boolean) => void;
const waiting = new Map<IdleJob, boolean>();
/** Jobs newest last: a method queues on its first call, so idle time prepares what the latest
 *  interaction reached before what launch reached. A stale entry's job is no longer waiting. */
const recent: IdleJob[] = [];
export const pendingCompilations = (): number => waiting.size;
let windowStart = -Infinity, windowSpent = 0, scheduled = false;
function schedule(): void {
  if (scheduled || !waiting.size) return;
  scheduled = true;
  requestIdleCallback(prepareWaiting);
}
function queue(job: IdleJob, demand = false): void {
  if (typeof requestIdleCallback === "undefined") return;
  const was = waiting.get(job);
  waiting.set(job, demand || was === true);
  // newest again only when it first waits and when it first becomes demanded: entries stay bounded
  if (was === undefined || demand && !was) recent.push(job);
  schedule();
}
function prepareWaiting(deadline: IdleDeadline): void {
  try {
    while (recent.length) {
      if (deadline.timeRemaining() < 2) return;
      const job = recent.pop()!, demand = waiting.get(job);
      if (demand === undefined) continue;
      waiting.delete(job);
      try { job(demand); } catch { /* a demand call retries failed idle preparation */ }
    }
  } finally { scheduled = false; schedule(); }
}
function promoteWithinBudget(promote: () => JvmFunction | undefined, job: IdleJob): JvmFunction | undefined {
  const now = performance.now();
  if (now - windowStart > PROMOTE_WINDOW_MS) { windowStart = now; windowSpent = 0; }
  if (windowSpent >= PROMOTE_BUDGET_MS && typeof requestIdleCallback !== "undefined") {
    queue(job, true);
    return undefined;
  }
  const compiled = promote();
  windowSpent += performance.now() - now;
  return compiled;
}

/** the body for `key` an earlier launch persisted or this launch's compile worker offered */
const stored = (key: string): Factory | undefined => persistedBody(key) ?? claimOffered(key);
/** a body's parameters: what compileTieredMethod binds a factory with (see Factory) */
const PARAMS = ["C", "D", "R", "S", "P"], ENTRY_PARAMS = [...PARAMS, "$R"];
export function compileTieredMethod(R: Runtime, C: CompiledCtor, rec: LazyMethod, emit: MethodEmitter): JvmFunction {
  const info = C.$i, dex = rec.dex, target = rec.isStatic ? C : C.prototype, arity = parseMethodDesc(rec.desc).params.length;
  const label = `${info.name}.${rec.name}`, profileName = label + rec.desc;
  const persist = !jvmProfiler.enabled && !jvmCoverage.enabled;
  const entryKey = codeKey(dex.id, rec.m.methodIdx, "e"), resumeKey = codeKey(dex.id, rec.m.methodIdx, "r");
  const bind = (factory: Factory, $R?: unknown) => factory(C, R.dexLink(dex), R, info.superInfo?.ctor ?? undefined, jvmProfiler, $R);
  let owner = R;
  while (owner.parent) owner = owner.parent;
  const entrySource = () => emit.entry(emit.prepare(), false), resumeSource = () => emit.resume(emit.prepare());
  let resumable: ResumeBody | undefined;
  function resume(make?: () => string): ResumeBody;
  function resume(make: () => string, limit: number): ResumeBody | undefined;
  function resume(make = resumeSource, limit = Infinity): ResumeBody | undefined {
    if (resumable) return resumable;
    const persisted = persist ? stored(resumeKey) : undefined;
    if (persisted) return resumable = bind(persisted) as ResumeBody;
    const body = make();
    if (persist) recordBody(resumeKey, body, "r");
    if (owner.hotSourceBytes + body.length > limit) return undefined;
    const fn = bodyScript(resumeKey, `${label}.resume`, PARAMS, "return " + body)(C, R.dexLink(dex), R, info.superInfo?.ctor ?? undefined, jvmProfiler) as ResumeBody;
    owner.hotSourceBytes += body.length;
    return resumable = fn;
  }
  const installed = (): JvmFunction => {
    const fn = target[xname(rec.mangled)];
    if (typeof fn !== "function") throw new Error("invalid compiled method");
    if (rec.intrinsic) setPublic(target, rec.mangled, rec.intrinsic, arity);
    return fn as JvmFunction;
  };
  const compile = (src: string): JvmFunction => {
    const started = jvmProfiler.enabled ? performance.now() : 0;
    bodyScript(entryKey, label, ENTRY_PARAMS, src)(C, R.dexLink(dex), R, info.superInfo?.ctor ?? undefined, jvmProfiler, resume);
    if (jvmProfiler.enabled) jvmProfiler.add(profileName, "jsCompile", performance.now() - started);
    if (persist) recordBody(entryKey, src, "e");
    return installed();
  };
  const install = (fn: JvmFunction): JvmFunction => { retarget(rec.stub, fn); return fn; };
  if (persist) recordUse(entryKey);
  const persisted = persist && jvmProfiler.tier !== "cold" ? stored(entryKey) : undefined;
  if (persisted) {
    bind(persisted, resume);
    perf.hotMethods++;
    return install(installed());
  }
  const prepared = emit.prepare();
  if (prepared.sync) return install(compile(emit.entry(prepared, true)));
  if (jvmProfiler.tier === "js") return install(compile(emit.entry(prepared, false)));
  let cold: ColdMethod | null = emit.cold(prepared);
  let calls = 0, hot: JvmFunction | undefined, entryPending = true, resumePending = false;
  const settle = (fn: JvmFunction): JvmFunction => {
    perf.hotMethods++;
    if (jvmProfiler.enabled) jvmProfiler.promoted(profileName);
    cold = null;
    retarget(invoke, fn);
    return hot = fn;
  };
  const promote = (make = entrySource, limit = HOT_SOURCE_LIMIT): JvmFunction | undefined => {
    if (hot) return hot;
    const offered = persist ? stored(entryKey) : undefined;
    if (offered) { bind(offered, resume); return settle(installed()); }
    const start = performance.now(), src = make();
    if (jvmProfiler.enabled) jvmProfiler.bytes(profileName, src.length);
    if (owner.hotSourceBytes + src.length > limit) {
      if (limit === HOT_SOURCE_LIMIT) { calls = -Infinity; cold!.promote = undefined; }
      if (persist) recordBody(entryKey, src, "e");
      perf.compileMs += performance.now() - start;
      return undefined;
    }
    const fn = compile(src);
    owner.hotSourceBytes += src.length;
    perf.compileMs += performance.now() - start;
    return settle(fn);
  };
  const idle: IdleJob = (demand) => {
    if (entryPending || demand) {
      entryPending = false;
      if (jvmProfiler.tier === "cold") { if (persist) recordBody(entryKey, entrySource(), "e"); }
      else promote(entrySource, demand ? HOT_SOURCE_LIMIT : IDLE_SOURCE_LIMIT);
    }
    if (resumePending) {
      resumePending = false;
      if (jvmProfiler.tier === "cold") { if (persist) recordBody(resumeKey, resumeSource(), "r"); }
      else resume(resumeSource, IDLE_SOURCE_LIMIT);
    }
  };
  if (persist) {
    queue(idle);
    cold.suspended = () => { resumePending = true; queue(idle); };
  }
  if (jvmProfiler.tier !== "cold") {
    cold.promote = (frame: ColdFrame, receiver: unknown) => {
      let prepared: PreparedMethod | undefined;
      const once = () => prepared ??= emit.prepare();
      if (!promote(() => emit.entry(once(), false))) return undefined;
      perf.osrMethods++;
      return { value: resume(() => emit.resume(once())).call(receiver, frame) };
    };
  }
  const invoke: JvmFunction & Cells = function(this: unknown, ...args: unknown[]) {
    if (hot) return hot.apply(this, args);
    if (++calls < 32 || jvmProfiler.tier === "cold") {
      if (jvmProfiler.enabled) jvmProfiler.entry(profileName);
      return runCold(cold!, this, args, true);
    }
    const compiled = promoteWithinBudget(promote, idle);
    if (compiled) return compiled.apply(this, args);
    if (jvmProfiler.enabled) jvmProfiler.entry(profileName);
    return runCold(cold!, this, args, true);
  };
  invoke.$c = null;
  if (rec.intrinsic) return install(invoke);
  const entry = jvmCoverage.enabled ? function(this: unknown, ...args: unknown[]) {
    jvmCoverage.hit(profileName);
    return invoke.apply(this, args);
  } : invoke;
  setJava(target, rec.mangled, entry, arity);
  return install(entry);
}
