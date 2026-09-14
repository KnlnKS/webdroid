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
    const probe = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "blurMaskProbe")?.value);
    for (const result of probe.results) {
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
    const borders = new Map([[0, 0], [1, 3], [2, 4], [3, 5], [5, 8], [10, 17]]);
    for (const result of probe.extracted) {
      const border = result.style === "INNER" ? 0 : borders.get(result.radius)!;
      expect(result).toMatchObject({ width: 20 + 2 * border, height: 20 + 2 * border, offsets: [0 - border, 0 - border],
        config: 1, density: 480, rowBytes: 20 + 2 * border, distinct: true, rgb: 0 });
      if (result.radius === 0) expect(result.alpha).toBe(128);
    }
    expect(probe.shaded).toEqual([0, 255, 0, 64]);
    expect(probe.position).toBe(400);
    expect(probe.copiedAlpha).toBe(127);
    expect(probe.originalAlpha).toBe(0);
    expect(probe.plane).toEqual({ inside: [0, 255, 0, 128], outside: [0, 0, 0, 0], restored: true });
  } finally { await browser.close(); }
}, 15000);
