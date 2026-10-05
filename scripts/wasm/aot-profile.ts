// Records what real launches of apps use of the platform build, in two runs:
//  - `--classes` launches with the build's code modules withheld, so that every method a launch calls is compiled on demand, and writes hot.json beside the builds: the classes
//    the realms' Worlds linked and the ones with a method called, the most shared first. `bun run aot` puts them into modules of their own, so that a launch fetches little more than
//    what it runs.
//  - without it, every module file any realm of the tab asked for (FetchStore.wanted), in order, is the build's startup.json, which a page prefetches and compiles off the main
//    thread before the World runs. The probe of aot-startup.ts sees one process after ActivityThread.main; this sees the framework's processes and an app through its first frames.
//    The launches also leave the app builds of the apps and of the framework's processes (host/appcode.ts) in the browser's store: they are written beside the modules as
//    app.<key>.<file> (host/bundle.ts), so that a first launch of these apps finds their compiled code.
// Run `--classes` after a build, then `bun run aot` for the build that groups by hot.json, then this without it for that build's startup.json.
//   WEBDROID_URL=http://localhost:4090 bun run wasm aot-profile [--classes] [apk ...]      (the server's current build; default apks: FitNotes, Calculator M, Mihon)
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { COMPILED_CODE_DIR } from "../../src/shell/hostfs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { DEOPT_ABI, type AppIndex, type AotIndex } from "../../src/wasm/link/aot";
import { AOT_ROOT } from "./aot-key";

const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const classes = process.argv.includes("--classes");
const apks = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SETTLE_MS = 10_000;
/** the classes in the order of how many launches used them; Maps keep the order of first use among equals */
const byUse = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([name]) => name);

const { key } = await (await fetch(`${BASE}/aot/current.json`)).json() as { key: string };
const policy = (JSON.parse(readFileSync(join(AOT_ROOT, key, "index.json"), "utf8")) as AotIndex).deopt ?? 0;
if (![0, DEOPT_ABI].includes(policy)) throw new Error("unknown AOT activation policy");
const ordered = new Set<string>();
const uses = { linked: new Map<string, number>(), called: new Map<string, number>() };
for (const apk of apks.length ? apks : ["FitNotes.apk", "calculatorm.apk", "mihon-v0.20.4.apk"]) {
  const profile = mkdtempSync(join(tmpdir(), "wdprof-"));
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1500 }, args: ["--site-per-process", "--force-device-scale-factor=1", "--use-gl=angle", "--use-angle=swiftshader"] });
  // every module is there to be asked for, so that a miss does not change what the launch goes on to want
  await context.route(/\/aot\/\w+\/startup\.json$/, (route) => route.fulfill({ json: readdirSync(join(AOT_ROOT, key)).filter((f) => /^[cd]\d+\.wasm$/.test(f)) }));
  if (classes) await context.route(/\/aot\/\w+\/c\d+\.wasm$/, (route) => route.abort());
  try {
    // a launch with no saved app build, one with it, and one with the build the second made of what it compiled on demand: the modules an app build's code names differ from those of code compiled on demand
    for (const launch of classes ? ["cold"] : ["cold", "warm", "settled"]) {
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
      if (launch === "settled") await exportBundles(page);
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

/** the app builds in the page's store, written beside the platform build's modules */
async function exportBundles(page: import("playwright").Page): Promise<void> {
  const dir = join(AOT_ROOT, key);
  const listing = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory(), store = await root.getDirectoryHandle(name);
    const meta = JSON.parse(await (await (await store.getFileHandle("meta.json")).getFile()).text()) as { entries: Record<string, { files: Record<string, number> }> };
    return Object.fromEntries(Object.entries(meta.entries).map(([k, e]) => [k, Object.keys(e.files)]));
  }, COMPILED_CODE_DIR);
  for (const [entry, names] of Object.entries(listing)) {
    const app = await page.evaluate(async ([store, entry]) => {
      const root = await navigator.storage.getDirectory(), dir = await (await root.getDirectoryHandle(store)).getDirectoryHandle(entry);
      return JSON.parse(await (await (await dir.getFileHandle("index.json")).getFile()).text());
    }, [COMPILED_CODE_DIR, entry]) as AppIndex;
    if ((app.deopt ?? 0) !== policy) throw new Error(`app build ${entry}: activation policy differs from platform`);
    for (const old of readdirSync(dir).filter((f) => f.startsWith(`app.${entry}.`))) rmSync(join(dir, old));
    for (const name of names) {
      const base64 = await page.evaluate(async ([store, entry, name]) => {
        const root = await navigator.storage.getDirectory(), dir = await (await root.getDirectoryHandle(store)).getDirectoryHandle(entry);
        const bytes = new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      }, [COMPILED_CODE_DIR, entry, name]);
      writeFileSync(join(dir, `app.${entry}.${name}`), Buffer.from(base64, "base64"));
    }
    writeFileSync(join(dir, `app.${entry}.json`), JSON.stringify(names));
    console.log(`app build ${entry}: ${names.length} files`);
  }
  const entries = readdirSync(dir).flatMap((file) => /^app\.([a-f0-9]+)\.json$/.exec(file)?.[1] ?? []);
  writeFileSync(join(dir, "apps.json"), JSON.stringify(entries.sort()));
}
