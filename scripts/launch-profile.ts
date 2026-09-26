// Time and optionally profile an app launch: navigation until the app's first drawn frame and
// until the main looper has been idle for a while.
// bun scripts/launch-profile.ts <apk> [--out file.json] [--cpu-profile] [--cpu-throttle N]
import { parseArgs } from "node:util";
import { CONTEXT_OPTS, launchBrowser } from "../tests/e2e/drivers/webdroid";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: "string", default: process.env.WEBDROID_URL ?? "http://localhost:4080" },
  out: { type: "string" }, "cpu-profile": { type: "boolean", default: false },
  "cpu-throttle": { type: "string", default: "1" }, "idle-ms": { type: "string", default: "1500" }, "max-ms": { type: "string", default: "60000" },
} });
const apk = positionals[0];
if (!apk) throw new Error("usage: launch-profile.ts <apk>");
const browser = await launchBrowser("hardware");
try {
  const page = await (await browser.newContext(CONTEXT_OPTS)).newPage();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: Number(values["cpu-throttle"]) });
  if (values["cpu-profile"]) { await session.send("Profiler.enable"); await session.send("Profiler.start"); }
  const t0 = Date.now();
  await page.goto(`${values.url}/?apk=${encodeURIComponent(apk)}`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async ({ idleMs, maxMs }) => {
    const g = globalThis as unknown as { wd?: { perf: Record<string, number>; mainDbg: { queued: number; depth: number } } };
    const start = performance.timeOrigin;
    let firstDraw = 0, lastBusy = performance.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      const wd = g.wd;
      if (!wd) continue;
      if (!firstDraw && wd.perf.draws > 0) firstDraw = performance.now();
      if (wd.mainDbg.queued || wd.mainDbg.depth) lastBusy = performance.now();
      if (firstDraw && performance.now() - lastBusy > idleMs) break;
      if (performance.now() > maxMs) break;
    }
    return { navToFirstDrawMs: firstDraw, navToIdleMs: lastBusy, bootMs: g.wd!.perf.bootMs, compileMs: g.wd!.perf.compileMs,
      classes: g.wd!.perf.classesCompiled, hot: g.wd!.perf.hotMethods, start };
  }, { idleMs: Number(values["idle-ms"]), maxMs: Number(values["max-ms"]) });
  const profile = values["cpu-profile"] ? (await session.send("Profiler.stop")).profile : undefined;
  console.log(JSON.stringify({ apk, wallMs: Date.now() - t0, ...result }));
  if (values.out) {
    await Bun.write(values.out, JSON.stringify({ apk, ...result }, null, 2));
    if (profile) await Bun.write(values.out.replace(/\.json$/, "") + ".cpuprofile", JSON.stringify(profile));
  }
} finally { await browser.close(); }
