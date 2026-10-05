// Records what real launches of apps use of the platform build, in two runs:
//  - `--classes` launches with the build's code modules withheld, so that every method a launch calls is compiled on demand, and writes hot.json beside the builds: the classes
//    the realms' Worlds linked and the ones with a method called, the most shared first. `bun run aot` puts them into modules of their own, so that a launch fetches little more than
//    what it runs.
//  - without it, every module file any realm of the tab asked for (FetchStore.wanted), in order, is the build's startup.json, which a page prefetches and compiles off the main
//    thread before the World runs. The probe of aot-startup.ts sees one process after ActivityThread.main; this sees the framework's processes and an app through its first frames.
// Run `--classes` after a build, then `bun run aot` for the build that groups by hot.json, then this without it for that build's startup.json.
//   WEBDROID_URL=http://localhost:4090 bun run wasm aot-profile [--classes] [apk ...]      (the server's current build; default apks: FitNotes, Calculator M, Mihon)
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { AOT_ROOT } from "./aot-key";

const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const classes = process.argv.includes("--classes");
const apks = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SETTLE_MS = 10_000;
/** the classes in the order of how many launches used them; Maps keep the order of first use among equals */
const byUse = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([name]) => name);

const { key } = await (await fetch(`${BASE}/aot/current.json`)).json() as { key: string };
const ordered = new Set<string>();
const uses = { linked: new Map<string, number>(), called: new Map<string, number>() };
for (const apk of apks.length ? apks : ["FitNotes.apk", "calculatorm.apk", "mihon-v0.20.4.apk"]) {
  const profile = mkdtempSync(join(tmpdir(), "wdprof-"));
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1500 }, args: ["--site-per-process", "--force-device-scale-factor=1", "--use-gl=angle", "--use-angle=swiftshader"] });
  // every module is there to be asked for, so that a miss does not change what the launch goes on to want
  await context.route(/\/aot\/\w+\/startup\.json$/, (route) => route.fulfill({ json: readdirSync(join(AOT_ROOT, key)).filter((f) => /^[cd]\d+\.wasm$/.test(f)) }));
  if (classes) await context.route(/\/aot\/\w+\/c\d+\.wasm$/, (route) => route.abort());
  try {
    // a launch with no saved app build and one with it: the modules an app build's code names differ from those of code compiled on demand
    for (const launch of classes ? ["cold"] : ["cold", "warm"]) {
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log("pageerror", e.message));
      await page.goto(`${BASE}/?apk=${encodeURIComponent(apk)}&screen=1080x2160@480&tier=wasm`);
      await page.waitForFunction(() => (window as any).wd?.perf.presentations > 0, undefined, { timeout: 90_000, polling: 200 });
      await page.waitForTimeout(SETTLE_MS);
      const wanted = await page.evaluate(async () => [...(await (window as any).__wdAot).wanted] as string[]);
      const used = await page.evaluate(async () => [...(await (window as any).__wdAot).worlds].map((u: any) => u()) as { linked: string[]; called: string[] }[]);
      for (const kind of ["linked", "called"] as const) for (const name of new Set(used.flatMap((u) => u[kind]))) uses[kind].set(name, (uses[kind].get(name) ?? 0) + 1);
      const before = ordered.size;
      for (const f of wanted) ordered.add(f);
      const mb = (kind: string) => (wanted.filter((f) => f[0] === kind).reduce((n, f) => n + statSync(join(AOT_ROOT, key, f)).size, 0) / 1e6).toFixed(1);
      console.log(`${apk} ${launch}: ${wanted.length} files wanted (C ${wanted.filter((f) => f[0] === "c").length}, ${mb("c")} MB; D ${wanted.filter((f) => f[0] === "d").length}, ${mb("d")} MB), ${ordered.size - before} new`);
      await page.close();
    }
  } catch (e) { console.log(`${apk}: ${(e as Error).message.split("\n")[0]}`); } finally { await context.close(); rmSync(profile, { recursive: true, force: true }); }
}
if (classes) {
  writeFileSync(join(AOT_ROOT, "hot.json"), JSON.stringify({ linked: [], called: byUse(uses.called) }));
  console.log(`${uses.called.size} classes called`);
} else {
  // the classes linked when the code modules are there are the ones whose class modules a launch loads
  const hot = JSON.parse(readFileSync(join(AOT_ROOT, "hot.json"), "utf8")) as { called: string[] };
  writeFileSync(join(AOT_ROOT, "hot.json"), JSON.stringify({ linked: byUse(uses.linked), called: hot.called }));
  const files = [...ordered].filter((f) => /^[cd]\d+\.wasm$/.test(f));
  writeFileSync(join(AOT_ROOT, key, "startup.json"), JSON.stringify(files));
  console.log(`${files.length} files in ${key}/startup.json`);
}
