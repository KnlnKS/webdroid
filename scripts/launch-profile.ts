// Time and optionally profile app launches: navigation until the app's first drawn frame and
// until the main looper has been idle for a while. Later launches reuse the browser profile, so
// they see what the first one persisted.
// bun scripts/launch-profile.ts <apk> [--launches N] [--out file.json] [--cpu-profile] [--cpu-throttle N]
import { parseArgs } from "node:util";
import { CONTEXT_OPTS, launchBrowser } from "../tests/e2e/drivers/webdroid";
import { BASE_URL } from "../tests/e2e/lib/util";
import { readProcesses } from "../tests/e2e/lib/processes";
import { sourceKey } from "./wasm/aot-key";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: "string", default: BASE_URL },
  out: { type: "string" }, "cpu-profile": { type: "boolean", default: false }, launches: { type: "string", default: "1" },
  "cpu-throttle": { type: "string", default: "1" }, "idle-ms": { type: "string", default: "1500" }, "max-ms": { type: "string", default: "60000" },
} });
const apk = positionals[0];
if (!apk) throw new Error("usage: launch-profile.ts <apk>");
const launches = Number(values.launches), idleMs = Number(values["idle-ms"]), maxMs = Number(values["max-ms"]), throttle = Number(values["cpu-throttle"]);
if (!Number.isInteger(launches) || launches < 1 || !Number.isFinite(idleMs) || idleMs < 0 || !Number.isFinite(maxMs) || maxMs <= 0 || !Number.isFinite(throttle) || throttle < 1)
  throw new Error("Expected positive launches/max-ms, nonnegative idle-ms and cpu-throttle >= 1");
const url = new URL(values.url);
url.searchParams.set("apk", apk);
const browser = await launchBrowser("hardware");
try {
  const page = await (await browser.newContext(CONTEXT_OPTS)).newPage();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const results: unknown[] = [];
  for (let launch = 1; launch <= launches; launch++) {
    const last = launch === launches;
    if (values["cpu-profile"] && last) { await session.send("Profiler.enable"); await session.send("Profiler.start"); }
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async ({ idleMs, maxMs }) => {
      let firstDraw = 0, lastBusy = performance.now(), idleReached = false;
      let firstFramePerf: Record<string, number> | undefined, idlePerf: Record<string, number> | undefined;
      let firstTicks: number | undefined, lastTicks: number | undefined, pid: number | undefined;
      for (;;) {
        if (performance.now() > maxMs) break;
        await new Promise((r) => setTimeout(r, 50));
        const wd = globalThis.wd;
        if (!wd) continue;
        const worker = await wd.foregroundWorkerSnapshot();
        if (worker?.terminal || worker?.snapshot?.dead) throw new Error("Foreground process died during launch");
        if (worker?.error && !worker.error.startsWith("Worker is not ready:")) throw new Error(worker.error);
        if (!worker?.snapshot || worker.snapshot.phase !== "ready") continue;
        const { perf, main, ticks } = worker.snapshot;
        idlePerf = { ...perf }; lastTicks = ticks;
        if (!firstDraw && perf.presentations > 0) {
          firstDraw = performance.now(); firstFramePerf = { ...perf }; firstTicks = ticks; pid = worker.pid;
          lastBusy = firstDraw;
        }
        if (main.queued || main.depth) lastBusy = performance.now();
        if (firstDraw && performance.now() - lastBusy >= idleMs) { idleReached = true; break; }
      }
      return { navToFirstDrawMs: firstDraw || null, navToIdleMs: idleReached ? performance.now() : null,
        idleReached, timedOut: !idleReached, firstFramePerf, idlePerf, pid, firstTicks, lastTicks,
        visible: document.visibilityState === "visible" };
    }, { idleMs, maxMs });
    const record = { apk, launch, url: url.href, ...result, processes: await readProcesses(page) };
    results.push(record);
    console.log(JSON.stringify(record));
    if (result.timedOut) process.exitCode = 1;
    if (!last) continue;
    const profile = values["cpu-profile"] ? (await session.send("Profiler.stop")).profile : undefined;
    if (values.out) {
      await Bun.write(values.out, JSON.stringify({ accepted: false, apk, url: url.href, chrome: browser.version(), cpuThrottle: throttle,
        git: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(), sourceKey: sourceKey(),
        statePolicy: "Repeated navigation reuses the browser profile, including persisted app data and compiled code",
        sampling: "50 ms polling of first observed presentation; counters belong to the foreground realm, process diagnostics are collected at idle",
        profileCoverage: profile ? "page target only; process Workers and other targets are not profiled" : null, launches: results }, null, 2));
      if (profile) await Bun.write(values.out.replace(/\.json$/, "") + ".cpuprofile", JSON.stringify(profile));
    }
  }
} finally { await browser.close(); }
