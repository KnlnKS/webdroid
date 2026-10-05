// A bounded serial app probe. Separate fresh browser storage per invocation;
// records work and launch/tap diagnostics, not an idle-host acceptance result.
// bun scripts/wasm/cold-browser.ts --app fitnotes --cold 1 --url http://localhost:4198 --out <json>
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const { values } = parseArgs({ options: { app: { type: "string" }, cold: { type: "string" }, url: { type: "string" }, out: { type: "string" } } });
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
const result = { app: flow.app, cold: values.cold, url: url.href, started: new Date().toISOString(), diagnosticOnly: true,
  steps: [] as unknown[], processes: [] as unknown[], errors: [] as string[] };
await mkdir(dirname(values.out), { recursive: true });
const save = () => Bun.write(values.out!, JSON.stringify(result, null, 2));
const drv = await WebdroidDriver.launch({ screen, controlled: flow.clock === "controlled", storage: flow.seedPrefs ? [prefsStorage(flow.pkg, flow.seedPrefs)] : [] });
const deadline = setTimeout(() => { console.error("outside-browser deadline"); void save().finally(() => process.exit(124)); }, 180000);
try {
  for (const step of flow.steps.slice(0, last + 1)) {
    const rec = manifest?.steps.find(s => s.id === step.id);
    const capture = await drv.step(actOf(flow, step, rec), { wait: step.wait, capture: false, timing: flow.clock === "controlled" ? "controlled" : "real" });
    const cold = await Promise.all(drv.page.frames().filter(f => f.url().startsWith(url.origin)).map(async frame => ({ url: frame.url(),
      state: await frame.evaluate(() => ({ cold: window.__wdCold ?? null, ticks: globalThis.wd?.ticks,
        marks: performance.getEntriesByType("mark").filter(m => m.name.startsWith("wd:")).map(m => ({ name: m.name, ms: m.startTime })) })).catch(e => ({ error: String(e) })) })));
    result.steps.push({ id: step.id, capture, cold }); await save();
    console.log(flow.app, values.cold, step.id, capture.ms, capture.settled.how, capture.wedged ? "wedged" : "live");
    if (capture.wedged || capture.error || capture.semanticHit === false) throw new Error(`Step ${step.id} failed: ${capture.error ?? "unreached/wedged"}`);
  }
  result.processes = await readProcesses(drv.page); result.errors = drv.errors; await save();
} catch (e) { result.errors.push(String(e), ...drv.errors); await save(); throw e; }
finally { clearTimeout(deadline); await drv.close(); }
