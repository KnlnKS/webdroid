import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("Back waits for a suspended main job before dispatching to the top window", async () => {
  const build = Bun.spawn([process.execPath, "build", import.meta.dir + "/fixtures/back-browser.ts", "--target", "browser"], { stdout: "pipe", stderr: "inherit" });
  const script = await new Response(build.stdout).text();
  expect(await build.exited).toBe(0);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ type: "module", content: script });
    await page.waitForFunction(() => Object.hasOwn(window, "backProbe"), null, { timeout: 5000 });
    expect(await page.evaluate(() => Object.getOwnPropertyDescriptor(window, "backProbe")?.value))
      .toEqual({ pending: ["start"], events: ["start", "end", "back"] });
  } finally { await browser.close(); }
}, 15000);
