import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("runtime shaders preserve recorded uniforms, premultiplied alpha and canvas coordinates", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/runtime-shader-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "Runtime shader fixture build failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "shaderProbe"));
    expect(await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "shaderProbe")?.value)).toEqual({
      recorded: [255, 0, 0, 128], outside: [0, 0, 0, 0], direct: [0, 0, 255, 255], invalid: true, text: [14, 39],
    });
  } finally { await browser.close(); }
}, 15000);
