// Records which module files real launches of apps want from the platform build (FetchStore.wanted: every file any realm of the tab asked for, in order) and makes that the
// build's startup.json, which a page prefetches and compiles off the main thread before the World runs. The probe of aot-startup.ts sees one process after ActivityThread.main;
// this sees the framework's processes and an app through its first frames.
//   WEBDROID_URL=http://localhost:4090 bun run wasm aot-profile [apk ...]      (the server's current build; default apks: FitNotes, Calculator M, Mihon)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { AOT_ROOT } from "./aot-key";

const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const apks = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SETTLE_MS = 10_000;

const { key } = await (await fetch(`${BASE}/aot/current.json`)).json() as { key: string };
const ordered = new Set<string>();
for (const apk of apks.length ? apks : ["FitNotes.apk", "calculatorm.apk", "mihon-v0.20.4.apk"]) {
  const profile = mkdtempSync(join(tmpdir(), "wdprof-"));
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1500 }, args: ["--site-per-process", "--force-device-scale-factor=1", "--use-gl=angle", "--use-angle=swiftshader"] });
  try {
    // a launch with no saved app build and one with it: the modules an app build's code names differ from those of code compiled on demand
    for (const launch of ["cold", "warm"]) {
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log("pageerror", e.message));
      await page.goto(`${BASE}/?apk=${encodeURIComponent(apk)}&screen=1080x2160@480&tier=wasm`);
      await page.waitForFunction(() => (window as any).wd?.perf.presentations > 0, undefined, { timeout: 90_000, polling: 200 });
      await page.waitForTimeout(SETTLE_MS);
      const wanted = await page.evaluate(async () => [...(await (window as any).__wdAot).wanted] as string[]);
      const before = ordered.size;
      for (const f of wanted) ordered.add(f);
      console.log(`${apk} ${launch}: ${wanted.length} files wanted, ${ordered.size - before} new`);
      await page.close();
    }
  } catch (e) { console.log(`${apk}: ${(e as Error).message.split("\n")[0]}`); } finally { await context.close(); rmSync(profile, { recursive: true, force: true }); }
}
// index.json, startup.json and waiting.json are fetched by name, not as modules
const files = [...ordered].filter((f) => /^[acd]\d+\.wasm$/.test(f) && !f.startsWith("a"));
writeFileSync(join(AOT_ROOT, key, "startup.json"), JSON.stringify(files));
console.log(`${files.length} files in ${key}/startup.json`);
