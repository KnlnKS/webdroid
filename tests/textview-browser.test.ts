import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("TextView measures and paints replacement spans with cached geometry and retains plain-text ellipsis", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/textview-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "TextView fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "textViewProbe"), null, { timeout: 5000 });
    const result = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "textViewProbe")?.value);
    expect(result).toMatchObject({ measures: 1, draws: 1, width: 24, center: [0, 255, 0, 255], outside: [0, 0, 0, 0], layout: true,
      ellipsis: ["A long title…"], cached: true, fitting: ["A long title with a location"], cleared: true });
    expect(result.height).toBeGreaterThanOrEqual(32);
    expect(result.heightLimits).toEqual([20, 25, result.height]);
    expect(result.styles).toEqual([true, true, true]);
    expect(result.compound).toEqual({ drawsAt: [[2, 30], [51, 31], [24, 3], [23, 60]],
      retained: [[2, 3, 8, 11], [1, 2, 11, 8], [0, 0, 5, 7], [2, 1, 14, 6]], restored: true });
    expect(result.alignment.centers[0]).toBeLessThan(20);
    expect(result.alignment.centers[1]).toBeGreaterThan(45);
    expect(result.alignment.centers[1]).toBeLessThan(55);
    expect(result.alignment.centers[2]).toBeGreaterThan(80);
    expect(result.alignment).toMatchObject({ own: 4, relative: [5, 3, 5, 3] });
    expect(result.combined).toMatchObject({ span: [5, 16], original: "a ß replacement trailing words", same: true, pixels: true });
    expect(result.combined.line).toStartWith("A SS REPLACEMENT");
    expect(result.combined.line).toEndWith("…");
    expect(result.combined.width).toBeLessThanOrEqual(80);
    expect(result.combined.ellipsis).toBeGreaterThan(0);
    expect(result.selection).toHaveLength(2);
    expect(result.selection[0][0]).toBeGreaterThan(0);
    expect(result.selection[0][1]).toBe(100);
    expect(result.selection[1][0]).toBe(0);
    expect(result.selection[1][1]).toBeGreaterThan(0);
    expect(result.emptySelection).toBe(0);
    expect(result.independentCanvas).toBe(true);
    expect(result.checkBoxHeight).toBe(48);
    expect(result.caretAtStart).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 15000);
