import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("EGL10 and EGL14 retain each thread's binding, GL objects and errors across suspension and release", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/egl-thread-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "EGL fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "eglThreadProbe"));
    const result = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "eglThreadProbe")?.value);
    expect(result).toEqual({ callbacks: [true, true, true], bound10: 1, bound14: 1, emptySecond: true, isolated: true, restored: true,
      sameContext10: true, sameContext14: true, firstError: 0x3000, secondError: 0x3008,
      restoredAfterRelease: true, swapped: 1, pixel: [255, 0, 0, 255], mainEmpty: true, callbackRestored: true, mainStillEmpty: true, lifecycle: true,
      readback: { compiled: true, before: [1, 1], after: [2, 2], error: 0, es1: [2, 2], es1Error: 0, unaligned: 0x12345678, integerError: 0 },

      windowCopy: { before: { code: 0, pixel: [0, 255, 0, 255] }, after: { code: 0, pixel: [255, 0, 0, 255] } } });
  } finally { await browser.close(); }
}, 15000);
