import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("SeekBar draws its level track and thumb, and touch callbacks retain their dispatch thread", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/seekbar-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "SeekBar fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "seekBarProbe"));
    const result = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "seekBarProbe")?.value);
    expect(result).toEqual({ before: [0, 0, 255, 255], thumb: [0, 255, 0, 255], after: [51, 51, 51, 255], above: [0, 0, 0, 0],
      restored: true, events: [["start", true], [75, 1, true], [90, 1, true], ["stop", true]], progress: 90, pressed: false });
  } finally { await browser.close(); }
}, 15000);
