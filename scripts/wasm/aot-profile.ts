// Profiles every process World through first frames.
// --classes records called classes with platform code withheld; rebuild AOT to group those classes.
// Then run without --classes to record startup modules and export saved app builds.
// WEBDROID_URL=http://localhost:4090 bun run wasm aot-profile [--classes] [apk ...]
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { COMPILED_CODE_DIR } from "../../src/shell/hostfs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { DEOPT_ABI, type AppIndex, type AotIndex } from "../../src/wasm/link/aot";
import { AOT_ROOT } from "./aot-key";
import { readProcesses } from "../../tests/e2e/lib/processes";
import type { AotProfile } from "../../src/shell/aot-profile";

const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const classes = process.argv.includes("--classes");
const apks = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SETTLE_MS = 10_000;
/** the classes in the order of how many launches used them; Maps keep the order of first use among equals */
const byUse = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([name]) => name);

const { key } = await (await fetch(new URL("/aot/current.json", BASE))).json() as { key: string };
const policy = (JSON.parse(readFileSync(join(AOT_ROOT, key, "index.json"), "utf8")) as AotIndex).deopt ?? 0;
if (![0, DEOPT_ABI].includes(policy)) throw new Error("unknown AOT activation policy");
const ordered = new Set<string>();
const uses = { linked: new Map<string, number>(), called: new Map<string, number>() };
const failures: string[] = [];
for (const apk of apks.length ? apks : ["FitNotes.apk", "calculatorm.apk", "mihon-v0.20.4.apk"]) {
  const profile = mkdtempSync(join(tmpdir(), "wdprof-"));
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1400, height: 1500 }, args: ["--site-per-process", "--force-device-scale-factor=1", "--use-gl=angle", "--use-angle=swiftshader"] });
  // every module is there to be asked for, so that a miss does not change what the launch goes on to want
  await context.route(/\/aot\/\w+\/startup\.json$/, (route) => route.fulfill({ json: readdirSync(join(AOT_ROOT, key)).filter((f) => /^[cd]\d+\.wasm$/.test(f)) }));
  if (classes) await context.route(/\/aot\/\w+\/c\d+\.wasm$/, (route) => route.abort());
  let lastPage: import("playwright").Page | undefined;
  try {
    // a launch with no saved app build, one with it, and one with the build the second made of what it compiled on demand: the modules an app build's code names differ from those of code compiled on demand
    for (const launch of classes ? ["cold"] : ["cold", "warm", "settled"]) {
      const page = lastPage = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const url = new URL(BASE);
      url.pathname = "/";
      url.searchParams.set("apk", apk);
      url.searchParams.set("tier", "wasm");
      if (!url.searchParams.has("screen")) url.searchParams.set("screen", "1080x2160@480");
      const deadline = Date.now() + 90_000;
      await page.goto(url.href);
      await page.waitForFunction(async () => {
        const wd = globalThis.wd;
        if (!wd) return false;
        const foreground = await wd.foregroundWorkerSnapshot?.();
        return (foreground?.snapshot.perf ?? wd.perf).presentations > 0;
      }, undefined, { timeout: 90_000, polling: 200 });
      await page.waitForTimeout(SETTLE_MS);
      const {processes,profiles} = await collectLaunch(page, deadline, errors);
      console.log(`${apk} ${launch}: ${processes.length} healthy process diagnostics, ${url.href}`);
      const wanted = [...new Set(profiles.flatMap(profile => profile.wanted))];
      const used = profiles.flatMap(profile => profile.worlds);
      for (const kind of ["linked", "called"] as const) for (const name of new Set(used.flatMap((u) => u[kind]))) uses[kind].set(name, (uses[kind].get(name) ?? 0) + 1);
      const before = ordered.size;
      for (const f of wanted) ordered.add(f);
      const mb = (kind: string) => (wanted.filter((f) => f[0] === kind).reduce((n, f) => n + statSync(join(AOT_ROOT, key, f)).size, 0) / 1e6).toFixed(1);
      console.log(`${apk} ${launch}: ${wanted.length} files wanted (C ${wanted.filter((f) => f[0] === "c").length}, ${mb("c")} MB; D ${wanted.filter((f) => f[0] === "d").length}, ${mb("d")} MB), ${ordered.size - before} new`);
      if (launch === "settled") await exportBundles(page);
      await page.close();
    }
  } catch (e) {
    const message = `${apk}: ${(e as Error).message.split("\n")[0]}`;
    failures.push(message); console.error(message);
    if (lastPage && !lastPage.isClosed()) console.error(JSON.stringify((await readProcesses(lastPage)).map(({url,diagnostics:d}) =>
      ({url,status:d.status,...(d.status === "failure" ? {message:d.message,terminal:d.terminal} :
        d.status === "exited" ? {terminal:d.terminal} : d.status === "ok" ? {missing:d.missing,native:d.native,errors:d.errors} : {})}))));
  } finally { await context.close(); rmSync(profile, { recursive: true, force: true }); }
}
if (failures.length) throw new Error(`${failures.length} failed launches; profile was not published`);
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

type WorkerProfile = {pid:number;error?:string;result?:{phase:string;profile:AotProfile|null}};

async function readProfiles(page: import("playwright").Page): Promise<AotProfile[]> {
  const origin = new URL(page.url()).origin;
  const frames = page.frames().filter(frame => {
    const url = new URL(frame.url());
    return url.origin === origin && ["/", "/process"].includes(url.pathname);
  });
  const profiles = (await Promise.all(frames.map(frame => frame.evaluate(async () => {
    // a same-origin process frame shares the page's store (pageShared), which the page reads
    if (!window.__wdAot && window.parent !== window && window.parent.__wdAot) return null;
    const store = await window.__wdAot;
    if (!store) throw new Error("AOT profile unavailable");
    return {key:store.key,wanted:[...store.wanted],worlds:[...store.worlds].map(read => read())};
  })))).filter((profile): profile is AotProfile => profile !== null);
  const workers = await page.evaluate(async () => {
    const read = globalThis.wd && Reflect.get(globalThis.wd,"workerAotProfiles") as (() => Promise<WorkerProfile[]>) | undefined;
    if (read) return read();
    if (new URLSearchParams(location.search).get("processMode") === "worker") throw new Error("Worker AOT profiling unavailable");
    return [];
  });
  for (const worker of workers) {
    if (worker.error || worker.result?.phase !== "ready" || !worker.result.profile)
      throw new Error(`Worker ${worker.pid}: ${worker.error ?? "AOT profile unavailable"}`);
    const profile = worker.result.profile;
    profiles.push(profile);
  }
  if (!profiles.length || profiles.some(profile => profile.key !== key)) throw new Error("AOT profile build mismatch");
  for (const worker of workers) {
    const profile = worker.result!.profile!;
    console.log(`Worker ${worker.pid}: build ${profile.key}, ${profile.wanted.length} wanted, ${profile.worlds.length} Worlds`);
  }
  return profiles;
}

async function collectLaunch(page: import("playwright").Page, deadline: number, errors: string[]) {
  for (;;) {
    const processes = await readProcesses(page);
    const pending = processes.some(({diagnostics:d}) => d.status === "failure" && d.message.startsWith("Worker is not ready:"));
    const failed = processes.filter(({diagnostics:d}) => d.status === "unavailable"
      || d.status === "failure" && !d.message.startsWith("Worker is not ready:")
      || d.status === "ok" && (d.errors === null || d.errors.length || d.missing.length || d.native.length));
    if (!processes.length || failed.length || errors.length) throw new Error(`incomplete launch diagnostics: ${JSON.stringify({processes:failed,errors})}`);
    if (!pending) {
      try { return {processes,profiles:await readProfiles(page)}; }
      catch (error) { if (!(error instanceof Error) || !error.message.includes("Worker is not ready:")) throw error; }
    }
    if (Date.now() >= deadline) throw new Error("Worker startup did not finish within the profile deadline");
    await page.waitForTimeout(200);
  }
}
