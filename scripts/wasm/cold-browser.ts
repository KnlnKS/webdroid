// A bounded serial app probe. Separate fresh browser storage per invocation;
// records work and launch/tap diagnostics, not an idle-host acceptance result.
// bun scripts/wasm/cold-browser.ts --app fitnotes --cold 1 --url http://localhost:4198 --out <json>
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const { values } = parseArgs({ options: { app: { type: "string" }, cold: { type: "string" }, url: { type: "string" }, out: { type: "string" }, profile: { type: "boolean" }, "startup-ms": { type: "string" }, "deadline-ms": { type: "string" } } });
if (!values.app || !values.url || !values.out || !["0", "1"].includes(values.cold ?? "")) throw new Error("Required: --app --cold 0|1 --url --out");
const url = new URL(values.url); url.searchParams.set("tier", "wasm"); url.searchParams.set("cold", values.cold!);
process.env.WEBDROID_URL = url.href; process.env.WEBDROID_TIER = "wasm";
const [{ WebdroidDriver }, { FLOWS }, { actOf, loadManifest, prefsStorage }, { executionFlow, screenOf }, { readProcesses }] = await Promise.all([
  import("../../tests/e2e/drivers/webdroid"), import("../../tests/e2e/flows"), import("../../tests/e2e/capture-webdroid"),
  import("../../tests/e2e/types"), import("../../tests/e2e/lib/processes"),
]);
const source = FLOWS.find(f => f.app === values.app);
if (!source) throw new Error("Unknown app");
const flow = executionFlow(source, "full"), manifest = await loadManifest(flow.app), screen = screenOf(manifest, flow.screen);
const last = flow.steps.findIndex(s => s.id === (flow.app === "fitnotes" ? "categories" : "result"));
if (last < 0) throw new Error("Probe supports fitnotes and calculatorm");
const startupMs = values["startup-ms"] === undefined ? undefined : Number(values["startup-ms"]);
if (startupMs !== undefined && (!Number.isInteger(startupMs) || startupMs < 1 || startupMs > 60000)) throw new Error("startup-ms must be 1..60000 (diagnostic only)");
const deadlineMs = Number(values["deadline-ms"] ?? 180000);
if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("deadline-ms must be a positive integer (diagnostic only)");
const sourceCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
const aotResponse = await fetch(new URL("/aot/current.json", url));
const aot = aotResponse.ok ? await aotResponse.json() : { status: aotResponse.status };
const result = { sourceCommit, aot, app: flow.app, cold: values.cold, url: url.href, started: new Date().toISOString(), diagnosticOnly: true, startupMs, deadlineMs,
  steps: [] as unknown[], processes: [] as unknown[], failure: null as unknown, errors: [] as string[], console: [] as {type:string;text:string;details?:unknown[]}[] };
await mkdir(dirname(values.out), { recursive: true });
const save = () => Bun.write(values.out!, JSON.stringify(result, null, 2));
const drv = await WebdroidDriver.launch({ screen, controlled: false, storage: flow.seedPrefs ? [prefsStorage(flow.pkg, flow.seedPrefs)] : [] });
// Observe rejected probe operations in their original realm. Reading the facade's
// stored fields does not invoke Java or replace the rejected throwable.
await drv.page.evaluate(() => {
  const g = globalThis as any;
  const describe = (error: any, seen = new Set<object>()): unknown => {
    if (error == null || typeof error !== "object") return String(error);
    if (seen.has(error)) return { cycle: true };
    seen.add(error);
    const read = (key: string): unknown => { try { return error[key]; } catch (e) { return { readError: String(e) }; } };
    const cause = read("cause");
    return { message: read("msg"), frames: read("jframes"),
      cause: cause && !seen.has(cause as object) ? describe(cause, seen) : null };
  };
  for (const [owner, key] of [[g.wd, "uiTree"], [g.__wd, "act"], [g.__wd, "step"]] as const) {
    const original = owner[key];
    owner[key] = async function (...args: unknown[]) {
      try { return await original.apply(this, args); }
      catch (error) {
        (g.__wdColdFailures ??= []).push({ phase: key, ms: performance.now(), error: describe(error) });
        throw error;
      }
    };
  }
});
const profiler = values.profile ? await drv.page.context().newCDPSession(drv.page) : undefined;
if (profiler) {
  await profiler.send("HeapProfiler.startSampling", { samplingInterval: 65536 });
  await profiler.send("Profiler.enable");
  await profiler.send("Profiler.setSamplingInterval", { interval: 1000 });
  await profiler.send("Profiler.start");
}
const stopProfile = async () => {
  if (!profiler) return;
  const { profile } = await profiler.send("Profiler.stop");
  await Bun.write(values.out!.replace(/\.json$/, ".cpuprofile"), JSON.stringify(profile));
  const heap = await profiler.send("HeapProfiler.stopSampling");
  await Bun.write(values.out!.replace(/\.json$/, ".heapprofile"), JSON.stringify(heap.profile));
};
drv.page.on("console", async message => {
  const row: typeof result.console[number] = {type:message.type(),text:message.text()}; result.console.push(row);
  if(message.type()==="error") row.details=await Promise.all(message.args().map(a=>a.evaluate(v=>({name:v?.constructor?.$i?.name ?? v?.constructor?.name,message:v?.msg ?? v?.message,stack:v?.jsStack ?? v?.stack})).catch(e=>({error:String(e)}))));
});
let expired = false;
const deadline = setTimeout(() => {
  expired = true; result.errors.push(`outside-browser deadline ${deadlineMs}ms`);
  console.error(result.errors.at(-1));
  void save().finally(() => drv.close()).finally(() => process.exit(124));
}, deadlineMs);
let firstTicks: number | undefined, lastTicks = 0;
try {
  for (const step of flow.steps.slice(0, last + 1)) {
    const rec = manifest?.steps.find(s => s.id === step.id);
    const image = step === flow.steps[0] || step === flow.steps[last];
    const wait = step === flow.steps[0] && startupMs !== undefined
      ? step.wait.kind === "live" || step.wait.kind === "live-sample" ? { ...step.wait, timeoutMs: startupMs } : { ...step.wait, maxRealMs: startupMs }
      : step.wait;
    const capture = await drv.step(actOf(flow, step, rec), { wait, capture: image, timing: "real" });
    if (capture.png) {
      await Bun.write(values.out!.replace(/\.json$/, `.${step.id}.png`), Buffer.from(capture.png, "base64"));
      capture.png = null;
    } else if (image && !capture.error) throw new Error(`Step ${step.id} produced no rendered image`);
    const ticks = await drv.page.evaluate(() => Number(globalThis.wd?.ticks ?? 0));
    firstTicks ??= ticks; lastTicks = ticks;
    const cold = await Promise.all(drv.page.frames().filter(f => f.url().startsWith(url.origin)).map(async frame => ({ url: frame.url(),
      state: await frame.evaluate(() => ({ cold: window.__wdCold ?? null, ticks: globalThis.wd?.ticks,
        heap: (performance as any).memory && { used: (performance as any).memory.usedJSHeapSize,
          total: (performance as any).memory.totalJSHeapSize, limit: (performance as any).memory.jsHeapSizeLimit },
        marks: performance.getEntriesByType("mark").filter(m => m.name.startsWith("wd:")).map(m => ({ name: m.name, ms: m.startTime })) })).catch(e => ({ error: String(e) })) })));
    result.steps.push({ id: step.id, capture, cold }); await save();
    console.log(flow.app, values.cold, step.id, capture.ms, capture.settled.how, capture.wedged ? "wedged" : "live");
    if (capture.wedged || capture.error || capture.semanticHit === false || capture.newErrors.length > 0 || capture.newMissing.length > 0 || capture.nativeRequired.length > 0) throw new Error(`Step ${step.id} failed: ${capture.error ?? "unreached/wedged"}`);
    if (step === flow.steps[0] && values.cold === "1" && await drv.page.evaluate(() => window.__wdCold?.stats.coldCalls ?? 0) === 0)
      throw new Error("Cold-on launch executed no root cold calls");
    if (capture.presentation <= 0 || capture.uiTree.length === 0) throw new Error(`Step ${step.id} did not present live UI`);
  }
  if (lastTicks <= firstTicks!) throw new Error("Rendering ticks did not advance across the flow");
  result.processes = await readProcesses(drv.page); result.errors = drv.errors; await save();
} catch (e) {
  result.errors.push(String(e), ...drv.errors);
  result.failure = await Promise.all(drv.page.frames().filter(f => f.url().startsWith(url.origin)).map(async frame => ({ url: frame.url(),
    state: await frame.evaluate(() => ({ failures: (globalThis as any).__wdColdFailures, cold: window.__wdCold,
      ticks: globalThis.wd?.ticks, heap: (performance as any).memory && {
        used: (performance as any).memory.usedJSHeapSize, total: (performance as any).memory.totalJSHeapSize,
        limit: (performance as any).memory.jsHeapSizeLimit } })).catch(error => ({ error: String(error) })) })));
  await save(); if (!expired) throw e;
}
finally { clearTimeout(deadline); try { if (!expired) await stopProfile(); } finally { await drv.close(); } }
if (expired) process.exit(124);
