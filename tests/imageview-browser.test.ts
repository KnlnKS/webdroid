import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("ImageView reports and draws scale-type matrices and copies custom transforms", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/imageview-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "ImageView fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "imageViewProbe"));
    const { results, reset } = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "imageViewProbe")?.value);
    const expected = [[2, 0, 0, 3, 5, 7], [1, 0, 0, 1, 0, 0], [4.7, 0, 0, 4.7, 0, 0],
      [4.7, 0, 0, 4.7, 0, 12.5], [4.7, 0, 0, 4.7, 0, 25], [1, 0, 0, 1, 37, 31],
      [7.2, 0, 0, 7.2, -25, 0], [1, 0, 0, 1, 37, 31]];
    for (let i = 0; i < expected.length; i++) {
      expect(results[i].type).toBe(i);
      expect(results[i].matrix).toEqual(expected[i]);
      for (let j = 0; j < 6; j++) expect(results[i].transform[j]).toBeCloseTo(expected[i][j] + (j === 4 ? 2 : j === 5 ? 3 : 0), 5);
      expect(results[i].bounds).toEqual([0, 0, i === 1 ? 94 : 20, i === 1 ? 72 : 10]);
      expect(results[i].restored).toBe(true);
    }
    expect(results[0].pixel).toEqual([0, 255, 0, 255]);
    expect(reset).toEqual([1, 0, 0, 1, 0, 0]);
  } finally { await browser.close(); }
}, 15000);
