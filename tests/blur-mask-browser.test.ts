import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("blur mask styles combine geometry before paint alpha and preserve canvas state", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/blur-mask-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "Blur mask fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "blurMaskProbe"));
    const results = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "blurMaskProbe")?.value);
    for (const result of results) {
      expect(result.restored).toBe(true);
      expect(result.clipped).toBe(0);
      expect(result.maximum).toBeLessThanOrEqual(128);
      if (result.style === "OUTER") expect(result.inside).toBe(0);
      else expect(result.inside).toBeGreaterThan(90);
      if (result.style === "INNER") expect(result.outside).toBe(0);
      else expect(result.outside).toBeGreaterThan(0);
      if (result.style === "SOLID") expect(result.inside).toBe(128);
      expect(result.repeated).toBe(true);
    }
  } finally { await browser.close(); }
}, 15000);
