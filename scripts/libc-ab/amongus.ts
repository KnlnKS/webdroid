// Stage E1's Among Us comparison: headless from launch, the time to its first GL frame, then GL frame
// rate, native cost and faults over a window of its animated menu.
//   PORT=4090 bun scripts/libc-ab/amongus.ts <hle|bionic> [seconds]
import { chromium } from "playwright";
const mode = process.argv[2] ?? "hle", seconds = Number(process.argv[3] ?? 40);
const url = `http://localhost:${process.env.PORT ?? 4090}/?apk=${encodeURIComponent("Among Us.xapk")}&screen=1080x2160%40480${mode === "bionic" ? "&libc=bionic" : ""}`;
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1500 } });
const t0 = Date.now();
await page.goto(url);
const read = () => page.evaluate(() => { const w = (globalThis as { wd?: any }).wd; return w ? { gl: w.perf.glFrames, pres: w.perf.presentations, nms: w.perf.nativeMs, ninstr: w.perf.nativeInstr, host: w.perf.nativeHostCalls, fault: w.native.lastFault.msg, missing: [...w.native.calledMissing], exited: w.native.exited(), fatal: (w.logs ?? []).filter((l: string) => /F\/|FORTIFY|abort/.test(l)).slice(-5) } : null; });
let firstGl = 0, s: Awaited<ReturnType<typeof read>> = null;
while (Date.now() - t0 < 240_000) { await page.waitForTimeout(1000); s = await read(); if (s && s.gl > 0) { firstGl = Date.now() - t0; break; } if (s?.fault || s?.exited) break; }
const a = (await read())!; const ta = Date.now();
await page.waitForTimeout(seconds * 1000);
const b = (await read())!; const dt = (Date.now() - ta) / 1000;
console.log(JSON.stringify({ mode, firstGlMs: firstGl, glFps: +((b.gl - a.gl) / dt).toFixed(1), presentFps: +((b.pres - a.pres) / dt).toFixed(1),
  nativeMsPerS: +((b.nms - a.nms) / dt).toFixed(0), mInstrPerS: +((b.ninstr - a.ninstr) / dt / 1e6).toFixed(1), hostCallsPerS: Math.round((b.host - a.host) / dt),
  fault: b.fault, missing: b.missing, exited: b.exited, fatal: b.fatal }));
await browser.close();
