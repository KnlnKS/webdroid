// Attribute SELF samples; native descendants remain native work.
// --profile analyzes one target; --capture aggregates every target of an ordinary action.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
type Category = "boundary" | "nativeWork" | "java" | "runtime" | "harness" | "idle" | "unattributed";
interface Node { id: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } }
interface Profile { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
interface Owner { category: Category; evidence: string }
interface Window { startUs: number; endUs: number; valid: boolean }
const categories: Category[] = ["boundary", "nativeWork", "java", "runtime", "harness", "idle", "unattributed"];
const classify = (n: Node, owners: Record<string, Owner>): Category => {
  const explicit = owners[n.id];
  if (explicit) { if (!categories.includes(explicit.category) || !explicit.evidence.trim()) throw new Error(`unreviewed owner ${n.id}`); return explicit.category; }
  const { url, functionName: name } = n.callFrame;
  if (name === "(idle)") return "idle";
  if (/\/src\/wasm\/host\/(bridge|natives)\.ts$/.test(url)) return "boundary";
  if (/\bb:(get:|set:|alen|acopy|aget|aset|js)/.test(name)) return "boundary";
  if (url.startsWith("wasm://")) return "unattributed";
  if (/\/src\/(android|graphics)\//.test(url) || /\/src\/native\/(core\/|cpu\.ts$)/.test(url)) return "nativeWork";
  if (name === "(garbage collector)") return "runtime";
  return "unattributed";
};

export function attributeBoundaryProfile(profile: Profile, owners: Record<string, Owner> = {}, window?: Window) {
  if (!Number.isFinite(profile.startTime) || !Number.isFinite(profile.endTime) || profile.endTime <= profile.startTime) throw new Error("invalid profile clock");
  if (window && (!window.valid || !Number.isFinite(window.startUs) || !Number.isFinite(window.endUs) || window.endUs <= window.startUs)) throw new Error("valid capture clock window required");
  if (window && !(profile.startTime <= window.startUs && profile.endTime >= window.endUs)) throw new Error("target profile does not cover common window");
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), totals = Object.fromEntries(categories.map(c => [c, 0])) as Record<Category, number>;
  if (nodes.size !== profile.nodes.length) throw new Error("duplicate profile node IDs");
  const self = new Map<number, number>();
  let at = profile.startTime, maxSampleGapUs = 0, sampledUs = 0;
  if (profile.samples.length !== profile.timeDeltas.length) throw new Error("sample/time delta mismatch");
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], n = nodes.get(id); if (!n) throw new Error(`missing node ${id}`);
    const raw = profile.timeDeltas[i]; if (raw < 0 || !Number.isFinite(raw)) throw new Error("invalid sample interval");
    const next = at + raw, dt = window ? Math.max(0, Math.min(next, window.endUs) - Math.max(at, window.startUs)) : raw;
    at = next; if (!dt) continue;
    maxSampleGapUs = Math.max(maxSampleGapUs, raw); sampledUs += dt;
    totals[classify(n, owners)] += dt; self.set(id, (self.get(id) ?? 0) + dt);
  }
  const active = categories.filter(k => k !== "idle" && k !== "harness").reduce((n, k) => n + totals[k], 0);
  const tail = window ? Math.max(0, window.endUs - Math.max(window.startUs, at)) : 0;
  return { accepted: false, window: window ?? null, sampledUs, maxSampleGapUs,
    unsampledTailUs: window ? tail : null, upperBoundActiveUs: active + tail,
    activeSampleUs: active, rawActiveSampleUs: active + totals.harness, selfSampleUs: totals,
    boundaryLowerPercent: active ? 100 * totals.boundary / active : null,
    boundaryUpperPercent: active + tail ? 100 * (totals.boundary + totals.unattributed + tail) / (active + tail) : null,
    top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, us]) => ({ id, us, category: classify(nodes.get(id)!, owners), frame: nodes.get(id)!.callFrame, evidence: owners[id]?.evidence ?? null })) };
}

if (import.meta.main) {
  const flag = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const path = flag("--profile"), capturePath = flag("--capture");
  if (!!path === !!capturePath) throw new Error("provide --profile <cpuprofile> or --capture <capture.json>");
  let report;
  if (path) {
    const capture = flag("--window") ? read(flag("--window")!) : undefined, window = capture?.capture?.window ?? capture?.window;
    if (flag("--window") && !window) throw new Error("valid capture clock window required");
    report = { profile: path, ...attributeBoundaryProfile(read(path), flag("--owners") ? read(flag("--owners")!) : {}, window) };
  } else {
    const input = read(capturePath!), capture = input.capture, failures: string[] = [], targets = [];
    if (!capture?.completeCoverage || !capture?.diagnosticsAvailable || !capture?.window?.valid) failures.push("all-target clock/diagnostic/source coverage incomplete");
    if (input.failure || input.browserErrors?.length || input.sourceStable !== true) failures.push("action/browser/source failure");
    if (!input.result?.png && !input.result?.frameHash) failures.push("rendered action result absent");
    const totals = Object.fromEntries(categories.map(c => [c, 0])) as Record<Category, number>;
    let unknownTailUs = 0;
    for (let i = 0; i < (capture?.profiles.length ?? 0); i++) {
      const target = capture.profiles[i], ownerPath = flag("--owners-dir") && join(flag("--owners-dir")!, `target-${i}-owners.json`);
      try {
        const data = attributeBoundaryProfile(target.profile, ownerPath && existsSync(ownerPath) ? read(ownerPath) : {}, capture.window);
        unknownTailUs += data.unsampledTailUs ?? 0;
        for (const category of categories) totals[category] += data.selfSampleUs[category];
        targets.push({ index: i, target: target.target, lifetime: target.lifetime, ownerPath: ownerPath ?? null, ...data });
        if (target.lifetime?.owner.compilerWorker && !target.lifetime.owner.directProcesses.length && !target.lifetime.owner.parentProcesses.length) failures.push(`target-${i}: compiler-worker Java owner association unresolved`);
      } catch (e) { failures.push(`target-${i}: ${String(e)}`); targets.push({ index: i, target: target.target, error: String(e) }); }
    }
    const active = categories.filter(k => k !== "idle" && k !== "harness").reduce((n, k) => n + totals[k], 0);
    if (!active || !targets.length) failures.push("no active sampled work");
    const upper = active + unknownTailUs ? 100 * (totals.boundary + totals.unattributed + unknownTailUs) / (active + unknownTailUs) : null;
    report = { capture: capturePath, accepted: false, window: capture?.window, targets, protocolFailures: failures, selfSampleUs: totals,
      activeSampleUs: active, rawActiveSampleUs: active + totals.harness, unknownTailUs, upperBoundActiveUs: active + unknownTailUs,
      boundaryLowerPercent: active ? 100 * totals.boundary / active : null, boundaryUpperPercent: upper,
      numericCriteriaPass: !failures.length && upper !== null && upper < 5,
      remaining: "Reviewed module/source owners, intended rendered state, sampling limits and external exclusive CPU provenance require acceptance review; full-step window includes diagnostic work." };
    if (failures.length) process.exitCode = 1;
  }
  const output = flag("--out"); if (output) writeFileSync(output, JSON.stringify(report, null, 2)); else console.log(JSON.stringify(report, null, 2));
}
