// Walk a flow until it wedges, then dump state. env: TREE=1 LOGS=1 NOMISS=1
import { mkdirSync, writeFileSync } from "node:fs";
import { launchFor, loadManifest, runStep } from "../tests/e2e/capture-webdroid.ts";
import { FLOWS } from "../tests/e2e/flows/index.ts";
import { executionFlow } from "../tests/e2e/types.ts";
import { cli } from "./args.ts";

const [app, stopAtArg = "99", outDir = "webdroid-shots/dbg"] = cli("pnpm dbg <flow> [stopAtStep] [outDir]", {}, { min: 1 }).positionals;
const stopAt = Number(stopAtArg);
const source = FLOWS.find((f) => f.app === app);
if (!source) { console.error(`unknown flow "${app}" — known: ${FLOWS.map((f) => f.app).join(", ")}`); process.exit(2); }
const flow = executionFlow(source, "webdroid");
const manifest = await loadManifest(app);
mkdirSync(outDir, { recursive: true });

const drv = await launchFor(flow, manifest);
await drv.page.evaluate(() => { (globalThis as any).wd.mainDbg.trace = true; });
for (const [i, step] of flow.steps.entries()) {
  if (i > stopAt) break;
  const r = await runStep(drv, flow, step);
  if (r.error) console.log("  ERR", r.error);
  const alive = !r.wedged;
  console.log(`${String(i).padStart(2, "0")} ${step.label}${r.semanticHit === false ? " [skipped]" : ""} settle=${Math.round(r.settled.ms)}ms ${r.settled.how}${alive ? "" : "  *** WEDGED ***"}`);
  if (r.png) writeFileSync(`${outDir}/${String(i).padStart(2, "0")}.png`, Buffer.from(r.png, "base64"));
  if (!alive) {
    const a0 = Date.now();
    const ok2 = await drv.alive(30000);
    console.log(`  alive retry: ${ok2} after ${Date.now() - a0}ms`);
    console.log("  stuck job site:\n" + await drv.page.evaluate(() => (globalThis as any).wd.mainDbg.running));
    const logs = await drv.page.evaluate(() => ((globalThis as any).wd.logs ?? []).slice(-60));
    console.log("--- logs ---\n" + logs.join("\n"));
    const missing = await drv.page.evaluate(() => [...(globalThis as any).wd.rt.missing]);
    console.log("--- missing ---\n" + missing.join("\n"));
    break;
  }
}
if (process.env.TREE) console.log(JSON.stringify(await drv.page.evaluate(() => (globalThis as any).wd.uiTree()), null, 1));
if (process.env.LOGS) console.log((await drv.page.evaluate(() => ((globalThis as any).wd.logs ?? []).slice(-80))).join("\n"));
const missing = await drv.page.evaluate(() => [...(globalThis as any).wd.rt.missing]);
if (process.env.NOMISS) process.exit(0);
if (missing.length) console.log("--- missing ---\n" + missing.join("\n"));
await drv.close();
