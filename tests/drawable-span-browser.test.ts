import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("drawable spans align suspended virtual drawing and text shadows preserve state", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/drawable-span-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "Drawable span fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "drawableSpanProbe"));
    const result = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "drawableSpanProbe")?.value);
    for (const span of result.results) expect(span).toEqual({ width: 14, fm: { ascent: -17, top: -17, descent: 0, bottom: 0 }, loads: 1, draws: 1, aligned: true, restored: true, hierarchy: 1 });
    expect(result.getters).toEqual([1, 10, 2, 0xffff0000]);
    expect(result.red).toBe(true);
    expect(result.shadowRestored).toBe(true);
  } finally { await browser.close(); }
}, 15000);
