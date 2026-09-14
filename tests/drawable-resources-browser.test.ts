import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("framework seek resources resolve dimensions, tint, enabled states and vector group transforms", async () => {
  const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/drawable-resources-browser.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "Drawable fixture build failed");
  const server = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/framework.apk"
    ? new Response(Bun.file(import.meta.dir + "/../vendor/framework-res.apk")) : new Response("<html></html>", { headers: { "Content-Type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}`);
    await page.addScriptTag({ type: "module", content: await build.outputs[0].text() });
    await page.waitForFunction(() => Object.hasOwn(window, "drawableResourcesProbe"));
    const result = await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "drawableResourcesProbe")?.value);
    expect(result.heights).toEqual([6, 6, 6]);
    expect(result.above).toEqual([0, 0, 0, 0]);
    expect(result.before[3]).toBe(255);
    expect(result.after[3]).toBeGreaterThan(0);
    expect(result.after[3]).toBeLessThan(255);
    expect(result.center[3]).toBe(128);
    expect(result.outside).toEqual([0, 0, 0, 0]);
    expect(result.rotated).toEqual([[255, 0, 0, 255], [0, 0, 0, 0]]);
    expect(result.absolute).toEqual([[255, 0, 0, 255], [0, 0, 0, 0]]);
    expect(result.restored).toBe(true);
    expect(result.dialogCenter).toEqual([255, 0, 0, 255]);
  } finally { await browser.close(); server.stop(true); }
}, 20000);
