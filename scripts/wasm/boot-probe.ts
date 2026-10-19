// The platform build in a page: a headless Chrome tab opens the build (host/boot.ts), starts the process the way ActivityThread.main leaves it
// (startProcess) and reports which modules were loaded and which missed, how many synchronous requests the page made (none are allowed) and where the time went;
// then an iframe of the same page does it again.
// The page also runs an app (the Pst fixture) in the World: the first load has no saved build, so a Worker compiles the app's likely methods and the page keeps them in OPFS, and runs a
// hot loop whose second-tier compile the Worker makes; the iframe, a second load of the same dex, finds the saved build, attaches it and loads its modules.
//   pnpm wasm boot-probe          (after pnpm aot)
import { join } from "node:path";
import { fileResponse, serve } from "../serve.ts";
import { aotFile, aotManifest } from "./aot-serve.ts";
import type { ProbeResult } from "./boot-probe-page.ts";
import { JAVA, ROOT } from "./paths.ts";
import { bundleFor, checker, fixture } from "./tools.ts";

// the page has no files of its own (harness.ts is given the jars it fetched)
const bundle = await bundleFor("browser", join(import.meta.dirname, "boot-probe-page.ts"));
const worker = await bundleFor("browser", join(ROOT, "src/wasm/host/compile-worker.ts"));
const appDir = fixture({ sources: [join(JAVA, "Pst.java")] });

const server = await serve({ fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/") return new Response('<!doctype html><script type="module" src="/probe.js"></script>', { headers: { "content-type": "text/html" } });
  if (p === "/probe.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  if (p === "/wasm-compile-worker.js") return new Response(worker, { headers: { "content-type": "text/javascript" } });
  if (p === "/app.dex") return fileResponse(join(appDir, "classes.dex"), req);
  if (p === "/aot/current.json") return aotManifest();
  const aot = /^\/aot\/(\w+)\/([\w.]+)$/.exec(p);
  if (aot) return aotFile(req, aot[1], aot[2]);
  return p.startsWith("/vendor/aosp/") && !p.includes("..") ? fileResponse(join(ROOT, p), req) : new Response("", { status: 404 });
} });

const { chromium } = await import("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 500)));
await page.goto(server.url.href);
const run = async (name: string) => { await page.waitForFunction(`window.${name} !== undefined`, null, { timeout: 120000 }); return page.evaluate(`window.${name}`) as Promise<ProbeResult>; };
const tab = await run("probe");
await page.evaluate(() => { const f = document.createElement("iframe"); f.src = "/?frame"; document.body.append(f); });
const frame = await run("probeFrame");
await browser.close(); server.stop();

const suite = checker("boot-probe"), check = (what: string, ok: boolean) => suite.check(what, ok, true);
for (const [name, r] of [["tab", tab], ["frame", frame]] as const) {
  console.log(`${name}: ${r.error ? "ERROR " + r.error.slice(0, 600) : `attached ${r.attached}; ${r.loaded.length} modules loaded, ${r.missed.length} missed, ${r.failed.length} failed to fetch; ${r.syncRequests} synchronous requests`}`);
  if (!r.error) console.log(`  ahead (fetch + compile, off the main thread) ${r.aheadMs.toFixed(0)} ms; boot ${r.bootMs.toFixed(0)} ms = our compiler ${r.compileMs.toFixed(0)} (${r.methods} methods), Module ${r.moduleMs.toFixed(0)}, Instance ${r.instantiateMs.toFixed(0)}, build ${r.aotMs.toFixed(0)}`);
  check(`${name}: ${r.error}`, !r.error);
  check(`${name}: the build is attached`, r.attached);
  check(`${name}: no synchronous request`, r.syncRequests === 0);
  check(`${name}: nothing missed or failed (${[...r.missed, ...r.failed].slice(0, 5)})`, !r.missed.length && !r.failed.length);
}
for (const [name, r] of [["tab", tab], ["frame", frame]] as const) {
  const a = r.app;
  if (r.error) continue;
  console.log(`${name} app (${a.store}): ${a.hit ? `saved build found (${a.prepareMs.toFixed(0)} ms to read and compile it)` : `no saved build; a worker made one: ${a.made?.methods} methods in ${a.made?.modules} module(s), ${a.made?.ms.toFixed(0)} ms, kept ${a.made?.kept}`}; attached ${a.attached}, ${a.modules} app module(s) loaded, ${a.compiledOnDemand} methods compiled on demand; second tier: ${a.jobs} jobs to the worker, ${a.adopted} adopted, ${a.stale} stale, ${a.inlineUpgrades} inline, worker ${a.workerMs.toFixed(1)} ms`);
  check(`${name}: the app answers as the JDK does (${a.answers})`, a.answers === "6,610,65529,125374");
  check(`${name}: a hot method's second tier came from the worker`, a.adopted > 0 && a.inlineUpgrades === 0);
}
check("the first load has no saved build and makes one", !tab.error && !tab.app.hit && !tab.app.attached && tab.app.made?.kept === true);
check("the second load finds it, attaches it and uses its modules", !frame.error && frame.app.hit && frame.app.attached && frame.app.modules > 0);
check("and compiles fewer methods on demand", !frame.error && !tab.error && frame.app.compiledOnDemand < tab.app.compiledOnDemand);
suite.done();
