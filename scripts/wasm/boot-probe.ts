// The platform build in a page: a headless Chrome tab under ?tier=wasm opens the build (host/boot.ts), starts the process the way ActivityThread.main leaves it
// (processState) and reports which modules were loaded and which missed, how many synchronous requests the page made (none are allowed) and where the time went;
// then an iframe of the same page does it again, which must find the modules the tab compiled and fetch nothing.
//   bun run wasm boot-probe          (after bun run aot)
import { join } from "node:path";
import { existsSync } from "node:fs";
import { aotFile, aotManifest } from "./aot-serve";
import type { ProbeResult } from "./boot-probe-page";
import { ROOT } from "./paths";

const here = import.meta.dir;
const built = await Bun.build({ entrypoints: [join(here, "boot-probe-page.ts")], target: "browser", define: { "import.meta.main": "false" }, plugins: [{ name: "probe", setup(b) {
  b.onResolve({ filter: /tests\/platform$/ }, () => ({ path: join(here, "boot-probe-platform.ts") }));
} }] });
if (!built.success) throw new Error(built.logs.join("\n"));
const bundle = built.outputs[0];

const fetched = new Map<string, number>();
const server = Bun.serve({ port: 0, async fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/") return new Response('<!doctype html><script type="module" src="/probe.js"></script>', { headers: { "content-type": "text/html" } });
  if (p === "/probe.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  if (p === "/aot/current.json") return aotManifest();
  const aot = /^\/aot\/(\w+)\/([\w.]+)$/.exec(p);
  if (aot) { fetched.set(aot[2], (fetched.get(aot[2]) ?? 0) + 1); return aotFile(aot[1], aot[2]); }
  const file = join(ROOT, p);
  return p.startsWith("/vendor/aosp/") && !p.includes("..") && existsSync(file) ? new Response(Bun.file(file)) : new Response("", { status: 404 });
} });

const { chromium } = await import("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 500)));
await page.goto(`http://localhost:${server.port}/?tier=wasm`);
const run = async (name: string) => { await page.waitForFunction(`window.${name} !== undefined`, null, { timeout: 120000 }); return page.evaluate(`window.${name}`) as Promise<ProbeResult>; };
const tab = await run("probe"), fetchedByTab = new Map(fetched);
await page.evaluate(() => { const f = document.createElement("iframe"); f.src = "/?tier=wasm&frame"; document.body.append(f); });
const frame = await run("probeFrame");
await browser.close(); server.stop();

let failed = false;
const check = (what: string, ok: boolean) => { if (!ok) { failed = true; console.log("FAIL", what); } };
for (const [name, r] of [["tab", tab], ["frame", frame]] as const) {
  console.log(`${name}: ${r.error ? "ERROR " + r.error.slice(0, 600) : `attached ${r.attached}; ${r.loaded.length} modules loaded, ${r.missed.length} missed, ${r.failed.length} failed to fetch; ${r.syncRequests} synchronous requests`}`);
  if (!r.error) console.log(`  ahead (fetch + compile, off the main thread) ${r.aheadMs.toFixed(0)} ms; boot ${r.bootMs.toFixed(0)} ms = our compiler ${r.compileMs.toFixed(0)} (${r.methods} methods), Module ${r.moduleMs.toFixed(0)}, Instance ${r.instantiateMs.toFixed(0)}, build ${r.aotMs.toFixed(0)}`);
  check(`${name}: ${r.error}`, !r.error);
  check(`${name}: runs under tier=wasm`, r.tier === "wasm");
  check(`${name}: the build is attached`, r.attached);
  check(`${name}: no synchronous request`, r.syncRequests === 0);
  check(`${name}: the platform Program is the tab's`, r.sharedPlatform);
  check(`${name}: nothing missed or failed (${[...r.missed, ...r.failed].slice(0, 5)})`, !r.missed.length && !r.failed.length);
}
const dup = [...fetched].filter(([f, n]) => n > 1);
console.log(`${fetched.size} files fetched by the tab and its frame, ${dup.length} more than once`);
check("the frame fetched nothing the tab had not", [...fetched].every(([f, n]) => n === fetchedByTab.get(f)));
console.log(failed ? "boot-probe: FAILED" : "boot-probe: all pass");
process.exit(failed ? 1 : 0);
