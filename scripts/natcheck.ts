// Which of our natives return a promise without declaring suspension.
//
// The suspension analysis recognizes async functions and maySuspend declarations. An unmarked
// native that returns a promise makes its callers compile sync and then hands them a promise.
//
//   bun scripts/natcheck.ts [apk ...]          # needs `bun run dev` on :4080
import { BASE_URL } from "../tests/e2e/lib/util";
import { launchBrowser, CONTEXT_OPTS } from "../tests/e2e/drivers/webdroid";

const apks = process.argv.slice(2).length ? process.argv.slice(2) : ["harmonic.apk", "FitNotes.apk", "mihon-v0.20.4.apk"];
const browser = await launchBrowser();
const liars = new Set<string>();
for (const apk of apks) {
  const page = await browser.newPage(CONTEXT_OPTS);
  await page.goto(`${BASE_URL}/?apk=${encodeURIComponent(apk)}&natcheck=1`, { waitUntil: "load" });
  await page.waitForFunction("window.wd && window.wd.ticks > 30", null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const found = await page.evaluate("window.wd.nativeLiars()") as string[];
  console.log(`${apk}: ${found.length}`);
  for (const f of found) liars.add(f);
  await page.close();
}
await browser.close();
console.log(`\n${liars.size} natives return a promise without declaring suspension:`);
for (const l of [...liars].sort()) console.log("  " + l);
