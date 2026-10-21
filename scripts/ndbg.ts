// Boot an apk headless with the native host-call trace on, wait, then dump wd.native state and logs.
//   pnpm ts scripts/ndbg.ts <apk> [waitMs] [traceRegex]
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { cli } from "./args.ts";
import { CONTEXT_OPTS, launchBrowser, openWebdroid, webdroidUrl } from "./page.ts";

const [apk, waitMs = "8000", re] = cli("pnpm ts scripts/ndbg.ts <apk> [waitMs] [traceRegex]", {}, { min: 1 }).positionals;
const browser = await launchBrowser(), page = await browser.newPage(CONTEXT_OPTS);
await page.addInitScript((r) => { (globalThis as any).__wdNativeTrace = r; }, re ?? ".");
if (process.env.STEP) await page.addInitScript(() => { (globalThis as any).__wdNativeStep = true; });
await openWebdroid(page, webdroidUrl({ apk }));
if (process.env.PROF_AFTER) {
  await sleep(Number(process.env.PROF_AFTER));
  await page.evaluate(() => { (globalThis as any).wd.native.profileReset(); (globalThis as any).wd.perfReset(); });
}
await sleep(Number(waitMs));
if (process.env.TAP) { await page.evaluate(() => (globalThis as any).wd.control(360, 640).tap(360, 640)); await sleep(3000); }
const out = await page.evaluate(() => {
  const n = (globalThis as any).wd.native;
  return {
    logs: (globalThis as any).wd.logs.slice(-80),
    trace: n.trace().ring.slice(-60),
    regs: n.regs(),
    calledMissing: [...n.calledMissing], jniMissing: [...n.jniMissing], missing: [...(globalThis as any).wd.rt.missing],
    perf: (globalThis as any).wd.perf, blocks: n.blocks,
  };
});
console.log("--- logs ---\n" + out.logs.join("\n"));
console.log("--- host trace ---\n" + out.trace.join("\n"));
console.log("--- regs ---", JSON.stringify(out.regs, null, 1));
console.log("calledMissing:", out.calledMissing, "jniMissing:", out.jniMissing, "\nmissing:", out.missing);
console.log("perf:", out.perf, "blocks:", out.blocks);
console.log("profile:\n" + (await page.evaluate(() => (globalThis as any).wd.native.profile(25))).join("\n"));
if (process.env.STEP) { const st = await page.evaluate(() => (globalThis as any).wd.native.stepRing.slice(-40000)); writeFileSync("/tmp/steps.txt", st.join("\n")); console.log("steps → /tmp/steps.txt", st.length); }
if (process.env.PEEK) { const [a, n] = process.env.PEEK.split(",").map(Number); const hex = await page.evaluate(([a, n]) => (globalThis as any).wd.native.peek(a, n), [a, n]); const bytes = hex.split(" ").map((h: string) => parseInt(h, 16)); for (let i = 0; i < bytes.length; i += 32) console.log((a + i).toString(16).padStart(8, "0"), bytes.slice(i, i + 32).map((b: number) => b.toString(16).padStart(2, "0")).join(" "), " ", bytes.slice(i, i + 32).map((b: number) => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("")); }
for (const spec of (process.env.DUMP ?? "").split(";").filter(Boolean)) {
  const [a, n] = spec.split(",").map(Number);
  const hex = await page.evaluate(([a, n]) => (globalThis as any).wd.native.peek(a, n), [a, n]);
  writeFileSync(`/tmp/dump_${a.toString(16)}.bin`, new Uint8Array(hex.split(" ").map((h: string) => parseInt(h, 16))));
}
await page.screenshot({ path: "webdroid-shots/ndbg.png" });
await browser.close();
process.exit(0);
