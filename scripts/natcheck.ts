// Which of our natives return a promise without being declared async.
//
// The suspension analysis takes `fn.constructor.name === "AsyncFunction"` as the truth about
// a native, because that is the only statement a function makes about itself. One that
// returns a promise anyway makes its callers compile sync and then hands them a promise.
//
//   bun scripts/natcheck.ts [apk ...]          # needs `bun run dev` on :4080
import { chromium } from "playwright";

const apks = process.argv.slice(2).length ? process.argv.slice(2) : ["harmonic.apk", "FitNotes.apk", "mihon-v0.20.4.apk"];
const browser = await chromium.launch();
const liars = new Set<string>();
for (const apk of apks) {
  const page = await browser.newPage({ viewport: { width: 760, height: 1400 } });
  await page.goto(`http://localhost:4080/?apk=${encodeURIComponent(apk)}&natcheck=1`, { waitUntil: "load" });
  await page.waitForFunction("window.wd && window.wd.ticks > 30", null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const found = await page.evaluate("window.wd.nativeLiars()") as string[];
  console.log(`${apk}: ${found.length}`);
  for (const f of found) liars.add(f);
  await page.close();
}
await browser.close();
console.log(`\n${liars.size} natives return a promise without saying async:`);
for (const l of [...liars].sort()) console.log("  " + l);
