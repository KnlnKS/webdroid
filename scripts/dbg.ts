// Interactive debug driver: walk a flow until it wedges, then dump state.
//   bun scripts/dbg.ts [flow] [stopAtStep] [outDir]     env: TREE=1 LOGS=1 NOMISS=1
// Frames land in <outDir>/NN.png (default webdroid-shots/dbg, gitignored).
import { mkdir } from "node:fs/promises";
import { WebdroidDriver } from "../tests/e2e/drivers/webdroid";
import { applyStep, loadManifest, settleStep } from "../tests/e2e/capture-webdroid";
import { FLOWS } from "../tests/e2e/flows";

const app = process.argv[2] ?? "fitnotes";
const stopAt = Number(process.argv[3] ?? 99);
const outDir = process.argv[4] ?? "webdroid-shots/dbg";
const flow = FLOWS.find((f) => f.app === app);
if (!flow) { console.error(`unknown flow "${app}" — known: ${FLOWS.map((f) => f.app).join(", ")}`); process.exit(2); }
const manifest = await loadManifest(app);
const byId = new Map((manifest?.steps ?? []).map((s) => [s.id, s]));
await mkdir(outDir, { recursive: true });

const drv = await WebdroidDriver.launch();
await drv.reset();
await drv.page.evaluate(() => { (globalThis as any).wd.mainDbg.trace = true; });
for (const [i, step] of flow.steps.entries()) {
  if (i > stopAt) break;
  const rec = byId.get(step.id);
  let hit: boolean | undefined;
  try { hit = await applyStep(drv, flow, step, rec); } catch (e) { console.log("  ERR", e); }
  const t0 = Date.now();
  const st = await settleStep(drv, step);
  const alive = !st.wedged;
  console.log(`${String(i).padStart(2, "0")} ${step.label}${hit === false ? " [coord-fallback]" : ""} settle=${Date.now() - t0}ms${st.timedOut ? " TIMEOUT" : ""}${alive ? "" : "  *** WEDGED ***"}`);
  await Bun.write(`${outDir}/${String(i).padStart(2, "0")}.png`, st.png);
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
if (process.env.TREE) console.log(await drv.page.evaluate(() => (globalThis as any).wd.tree()));
if (process.env.LOGS) console.log((await drv.page.evaluate(() => ((globalThis as any).wd.logs ?? []).slice(-80))).join("\n"));
const missing = await drv.page.evaluate(() => [...(globalThis as any).wd.rt.missing]);
if (process.env.NOMISS) process.exit(0);
if (missing.length) console.log("--- missing ---\n" + missing.join("\n"));
await drv.close();
